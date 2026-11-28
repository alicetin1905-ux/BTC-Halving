// Bodemsignalen: elke paar uur de kapitulatie- en dipsignalen van het dashboard (sectie "Bodem 2026")
// berekenen, vergelijken met de vorige run en bij een verandering een ntfy-melding sturen.
// Draait via .github/workflows/bodem-signalen.yml. Instellingen (repo → Settings → Secrets and variables → Actions):
//   secret   NTFY_TOPIC   je ntfy-onderwerp (verplicht, hetzelfde als voor het weekrapport)
//   variable NTFY_SERVER  eigen ntfy-server (optioneel, standaard https://ntfy.sh)
//   variable MINER_JTH    gemiddelde efficiëntie van het netwerk in J/TH (optioneel, standaard 22)
//   variable MINER_KWH    stroomprijs in $/kWh (optioneel, standaard 0.05)
// Extra signalen (tellen niet mee in de score): dip van 20%, 10+ dagen extreme angst en de weeksignalen
// (divergentie op RSI en MACD, Stoch RSI-kruising, TD 9, onder het 2-jaars gemiddelde, boven de Bull Market Support Band).
// Daarnaast: een melding bij een nieuwe cyclus-low (koers onder de laagste koers sinds de top, in stappen van 2%).
// MODE=status stuurt altijd een overzicht (om te testen). DRY_RUN=1 toont het bericht zonder te versturen.
// De vorige toestand staat in STATE_FILE (de workflow bewaart die tussen runs in de Actions-cache).

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY = 864e5;
const STATE_FILE = process.env.STATE_FILE || '.state/bodem-signalen.json';
const gh = (level, msg) => console.log(`::${level}::${String(msg).replace(/\r?\n/g, '%0A')}`);
const summary = (md) => { if (process.env.GITHUB_STEP_SUMMARY) try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch (e) { /* */ } };
const fmt = (v) => '$' + Math.round(v).toLocaleString('en-US');
const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1).replace('.', ',') + '%';
const num = (v, d = 2) => v.toFixed(d).replace('.', ',');
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

const getJson = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { 'User-Agent': 'btc-halving-bodemsignalen', ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
};
const hl = (body) => getJson('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const tryLoad = async (name, fn) => { try { return await fn(); } catch (e) { gh('warning', `${name} niet bereikbaar: ${e.message}`); return null; } };

// ---- data ----
const loadDaily = async () => {   // Bitstamp, ±2000 dagen: genoeg voor het 200-weeks gemiddelde
  let out = [], end = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 2; i++) {
    const j = await getJson(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&end=${end}`);
    const ohlc = j.data.ohlc.filter((k) => +k.close > 0);
    if (!ohlc.length) break;
    out = ohlc.map((k) => ({ t: +k.timestamp * 1000, close: +k.close, low: +k.low })).concat(out);
    end = +ohlc[0].timestamp - 86400;
  }
  const byDay = new Map(out.map((r) => [Math.floor(r.t / DAY), r]));
  const rows = [...byDay.entries()].map(([d, r]) => ({ t: d * DAY, close: r.close, low: r.low > 0 ? r.low : r.close })).sort((a, b) => a.t - b.t);
  if (rows.length < 1420) throw new Error(`te weinig dagen (${rows.length})`);
  return rows;
};
const loadAll = async () => {
  const now = Date.now();
  const [daily, ticker, cm, hr, fees, diff, funding, fng, hlCtx] = await Promise.all([
    tryLoad('Bitstamp dagkoersen', loadDaily),
    tryLoad('Bitstamp koers', async () => +(await getJson('https://www.bitstamp.net/api/v2/ticker/btcusd/')).last),
    tryLoad('Coin Metrics (MVRV, uitgifte)', async () => (await getJson('https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD,CapMVRVCur,IssTotUSD&frequency=1d&page_size=400&paging_from=end')).data.map((d) => ({ p: +d.PriceUSD, mvrv: +d.CapMVRVCur, iss: +d.IssTotUSD })).filter((d) => d.p > 0 && d.mvrv > 0)),
    tryLoad('mempool.space hashrate', async () => (await getJson('https://mempool.space/api/v1/mining/hashrate/1y')).hashrates.map((h) => h.avgHashrate / 1e18).filter((v) => v > 0)),
    tryLoad('mempool.space fees', async () => +(await getJson('https://mempool.space/api/v1/mining/reward-stats/144')).totalFee / 1e8),
    tryLoad('mempool.space moeilijkheid', () => getJson('https://mempool.space/api/v1/difficulty-adjustment')),
    tryLoad('Hyperliquid funding', async () => (await hl({ type: 'fundingHistory', coin: 'BTC', startTime: now - 7 * DAY })).map((f) => +f.fundingRate)),
    tryLoad('Fear & Greed', async () => (await getJson('https://api.alternative.me/fng/?limit=40&format=json')).data.map((d) => ({ t: +d.timestamp * 1000, v: +d.value, cls: d.value_classification })).sort((a, b) => a.t - b.t)),
    tryLoad('Hyperliquid koers', async () => { const m = await hl({ type: 'metaAndAssetCtxs' }); return +m[1][m[0].universe.findIndex((u) => u.name === 'BTC')].markPx; }),
  ]);
  const price = ticker || hlCtx || (daily ? daily[daily.length - 1].close : null);
  return { daily, price, cm, hr, fees, diff, funding, fng };
};

// ---- signalen (zelfde definities als het dashboard) ----
// Elk signaal: value + on(v) + off(v). Een kleine marge tussen aan en uit voorkomt een melding bij elke schommeling.
// Weeksignalen op de zondagsluitingen (zelfde regels als de dashboardkaart "Weekgrafiek: RSI, MACD en trend"):
// - RSI- en MACD-bodem = laagste waarde binnen ±6 weken (RSI onder 40, MACD onder 0); de laatste mag voorlopig zijn
// - bullish divergentie = twee opeenvolgende bodems binnen 60 weken, prijs (laagste dagslot ±7 d) lager of gelijk (max +2%),
//   indicator minstens 2 punten hoger (MACD in % van de prijs), met de laatste bodem in het laatste jaar
// - Stoch RSI-kruising: K kruist omhoog door D vanuit onder 20, bij RSI onder 45, in de laatste 4 weken
// - TD-koopsetup 9: 9 weken op rij een slot onder dat van 4 weken eerder, voltooid in de laatste 4 weken
export const weekly = (daily, now = Date.now()) => {
  const wk = daily.filter((r) => new Date(r.t).getUTCDay() === 0 && r.t + DAY <= now).map((r) => ({ t: r.t, c: r.close }));
  const C = wk.map((w) => w.c), n = C.length;
  const ema = (a, k) => { let m = null; return a.map((v) => (m = m == null ? v : v * 2 / (k + 1) + m * (1 - 2 / (k + 1)))); };
  const sma = (a, k) => a.map((v, i) => (i < k - 1 || a.slice(i - k + 1, i + 1).some((q) => q == null) ? null : mean(a.slice(i - k + 1, i + 1))));
  const N = 14; let g = 0, l = 0;
  const rsi = C.map((c, i) => { if (!i) return null; const ch = c - C[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0); if (i <= N) { g += up / N; l += dn / N; } else { g = (g * (N - 1) + up) / N; l = (l * (N - 1) + dn) / N; } return i >= N ? (l === 0 ? 100 : 100 - 100 / (1 + g / l)) : null; });
  const e12 = ema(C, 12), e26 = ema(C, 26), macd = C.map((c, i) => e12[i] - e26[i]);
  const srsi = rsi.map((v, i) => { const w = rsi.slice(Math.max(0, i - 13), i + 1).filter((q) => q != null); return v == null || w.length < 14 ? null : (Math.max(...w) === Math.min(...w) ? 0 : (v - Math.min(...w)) / (Math.max(...w) - Math.min(...w)) * 100); });
  const K = sma(srsi, 3), Dl = sma(K, 3), s20 = sma(C, 20), e21 = ema(C, 21), ma104 = sma(C, 104);
  let td = 0; const tdc = C.map((c, i) => (td = i >= 4 && c < C[i - 4] ? td + 1 : 0));
  const rows = wk.map((w, i) => ({ ...w, rsi: rsi[i], mp: macd[i] / C[i] * 100, K: K[i], D: Dl[i], s20: s20[i], e21: e21[i], ma104: ma104[i], td: tdc[i] }));
  const dlow = (t) => Math.min(...daily.filter((d) => Math.abs(d.t - t) <= 7 * DAY).map((d) => d.close));
  const swing = (key, lim) => { const out = []; rows.forEach((r, i) => { if (r[key] == null || r[key] >= lim) return; if (rows.slice(Math.max(0, i - 6), i + 7).every((q) => q[key] == null || q[key] >= r[key])) out.push({ ...r, p: dlow(r.t), prov: i > n - 7 }); }); return out; };
  const divs = (lows, key) => { const out = []; for (let k = 1; k < lows.length; k++) { const a = lows[k - 1], b = lows[k]; if (b.t - a.t <= 60 * 7 * DAY && b.p <= a.p * 1.02 && b[key] >= a[key] + 2) out.push([a, b]); } return out.filter(([, b]) => b.t >= now - 52 * 7 * DAY); };
  const last4 = now - 4 * 7 * DAY - DAY;
  const cross = rows.filter((r, i) => i && r.t >= last4 && r.K != null && r.D != null && rows[i - 1].K != null && rows[i - 1].K <= rows[i - 1].D && r.K > r.D && Math.min(r.K, rows[i - 1].K) < 20 && Math.min(r.rsi, rows[i - 1].rsi) < 45).pop() || null;
  const td9 = rows.filter((r) => r.td === 9 && r.t >= last4).pop() || null;
  return { last: rows[rows.length - 1], rdiv: divs(swing('rsi', 40), 'rsi'), mdiv: divs(swing('mp', 0), 'mp'), cross, td9 };
};

const NL = { 'Extreme Fear': 'extreme angst', Fear: 'angst', Neutral: 'neutraal', Greed: 'hebzucht', 'Extreme Greed': 'extreme hebzucht' };
export const signals = (d, cfg = {}) => {
  const jth = +cfg.jth || 22, kwh = +cfg.kwh || 0.05;
  const P = d.price, out = [];
  if (d.daily && P) {
    const now = Date.now();
    const weeks = d.daily.filter((r) => new Date(r.t).getUTCDay() === 0 && r.t + DAY <= now).map((r) => r.close);
    if (weeks.length >= 200) {
      const w = mean(weeks.slice(-200)), v = P / w;
      out.push({ id: 'wma', name: 'Prijs onder 200WMA', v, on: v < 1, off: v > 1.01, txt: `${pct(v - 1)} t.o.v. 200WMA ${fmt(w)}` });
    }
    const hi = Math.max(...d.daily.slice(-120).map((r) => r.close), P), v = P / hi - 1;
    out.push({ id: 'dip', name: 'Dip: 20% onder top van 120 dagen', v, on: v < -0.2, off: v > -0.18, txt: `${pct(v)} onder ${fmt(hi)}` });
    const w = weekly(d.daily), L = w.last;
    if (L && L.rsi != null) {
      const k = (v) => '$' + (v / 1000).toFixed(1).replace('.', ',') + 'k';
      const chain = (dv, key, f) => { const ch = [dv[0][0], ...dv.map(([, b]) => b)]; return `${ch.map((q) => f(q[key])).join(' → ')} bij prijs ${ch.map((q) => k(q.p)).join(' → ')}${ch[ch.length - 1].prov ? ' (laatste bodem voorlopig)' : ''}`; };
      const dS = (t) => { const x = new Date(t); return `${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
      out.push({ id: 'rsidiv', name: 'Bullish divergentie (weekly RSI)', v: w.rdiv.length ? 1 : 0, on: w.rdiv.length > 0, off: !w.rdiv.length,
        txt: (w.rdiv.length ? `RSI ${chain(w.rdiv, 'rsi', (v) => Math.round(v))}` : 'geen hogere RSI-bodem bij een lagere prijs') + ` · RSI nu ${num(L.rsi, 1)}` });
      out.push({ id: 'macddiv', name: 'Bullish divergentie (weekly MACD)', v: w.mdiv.length ? 1 : 0, on: w.mdiv.length > 0, off: !w.mdiv.length,
        txt: (w.mdiv.length ? `MACD ${chain(w.mdiv, 'mp', (v) => num(v, 1) + '%')}` : 'geen hogere MACD-bodem bij een lagere prijs') + ` · MACD nu ${num(L.mp, 1)}% van de prijs` });
      out.push({ id: 'stochx', name: 'Stoch RSI kruist omhoog vanuit <20 (week)', v: w.cross ? 1 : 0, on: !!w.cross, off: !w.cross,
        txt: w.cross ? `kruising in de week van ${dS(w.cross.t)} · K ${Math.round(L.K)} / D ${Math.round(L.D)}` : `K ${Math.round(L.K)} / D ${Math.round(L.D)}${L.K < 20 ? ' · oververkocht, wacht op kruising' : ''}` });
      out.push({ id: 'td9', name: 'TD-koopsetup 9 (week)', v: w.td9 ? 1 : 0, on: !!w.td9, off: !w.td9,
        txt: w.td9 ? `voltooid in de week van ${dS(w.td9.t)}` : `telling ${L.td} van 9` });
      if (L.ma104) { const v = L.c / L.ma104; out.push({ id: 'ma2y', name: 'Weekslot onder 2-jaars gemiddelde', v, on: v < 1, off: v > 1.02, txt: `${num(v)}× van ${fmt(L.ma104)} (bodems 0,43–0,74×)` }); }
      if (L.s20 && L.e21) { const hi = Math.max(L.s20, L.e21), lo = Math.min(L.s20, L.e21); out.push({ id: 'bmsb', name: 'Weekslot boven Bull Market Support Band', v: L.c / hi, on: L.c > hi, off: L.c < lo, txt: `weekslot ${fmt(L.c)} · band ${fmt(lo)}–${fmt(hi)} (heroveren = trendomslag bevestigd)` }); }
    }
  }
  if (d.cm && d.cm.length && P) {
    const l = d.cm[d.cm.length - 1], rp = l.p / l.mvrv, v = P / rp;
    out.push({ id: 'mvrv', name: 'MVRV onder 1', v, on: v < 1, off: v > 1.02, txt: `MVRV ${num(v)} · realized price ${fmt(rp)}` });
    // Puell Multiple: uitgifte in USD ÷ 365-daags gemiddelde, als 7-daags gemiddelde (zelfde als het dashboard)
    const iss = d.cm.map((q) => q.iss).filter((q) => q > 0);
    if (iss.length >= 371) {
      const pu = (i) => iss[i] / mean(iss.slice(i - 364, i + 1));
      const pv = mean([0, 1, 2, 3, 4, 5, 6].map((k) => pu(iss.length - 1 - k)));
      out.push({ id: 'puell', name: 'Puell Multiple onder 0,6', v: pv, on: pv < 0.6, off: pv > 0.62, txt: `Puell ${num(pv)} (bodems 0,34–0,57)` });
    }
  }
  if (d.hr && d.hr.length >= 60) {
    const a30 = mean(d.hr.slice(-30)), a60 = mean(d.hr.slice(-60)), v = a30 / a60 - 1;
    out.push({ id: 'ribbon', name: 'Hash ribbons: miner-kapitulatie', v, on: v < 0, off: v > 0.005, txt: `30D ${pct(v)} t.o.v. 60D` });
    if (P) {
      const eh = mean(d.hr.slice(-7)), btcDay = 144 * 3.125 + (d.fees ?? 3);
      const cost = eh * 1e6 * jth * 24 / 1000 * kwh / btcDay, v2 = P / cost;
      out.push({ id: 'miner', name: 'Prijs onder miner-kostprijs', v: v2, on: v2 < 1, off: v2 > 1.02, txt: `${pct(v2 - 1)} t.o.v. ${fmt(cost)} (${jth} J/TH, $${kwh}/kWh)` });
    }
  }
  if (d.funding && d.funding.length) {
    const v = mean(d.funding) * 24 * 365;
    out.push({ id: 'funding', name: 'Funding negatief (7 dagen)', v, on: v < 0, off: v > 0.01, txt: `${pct(v)} per jaar (Hyperliquid)` });
  }
  if (d.fng && d.fng.length) {
    const f = d.fng[d.fng.length - 1];
    out.push({ id: 'fng', name: 'Extreme angst (F&G onder 25)', v: f.v, on: f.v < 25, off: f.v >= 25, txt: `F&G ${f.v} (${NL[f.cls] || f.cls})` });
    const last30 = d.fng.slice(-30), xf = last30.filter((q) => q.v < 25).length;
    out.push({ id: 'fngstreak', name: '10+ dagen extreme angst in 30 dagen', v: xf, on: xf >= 10, off: xf < 8, txt: `${xf} dagen onder 25 (bodems: mediaan 8, vaak 10+)` });
  }
  if (d.diff) {
    const x = d.diff, est = x.progressPercent > 50 ? x.difficultyChange : null;
    out.push({ id: 'diff', name: 'Moeilijkheid daalt', v: est ?? x.previousRetarget,
      on: x.previousRetarget < 0 || (est != null && est < -1), off: x.previousRetarget >= 0 && (est == null || est > 0),
      txt: `vorige ${pct(x.previousRetarget / 100)}, volgende verwacht ${pct(x.difficultyChange / 100)}` });
  }
  return out;
};
// De acht kapitulatiesignalen van het dashboard tellen mee in de score (de twee dip-signalen niet)
const SCORE_IDS = ['wma', 'mvrv', 'ribbon', 'miner', 'puell', 'funding', 'fng', 'diff'];

// Nieuwe toestand met hysterese; onbekende signalen (bron plat) behouden hun vorige stand
export const step = (prev, sigs) => {
  const state = { ...prev }, changes = [];
  for (const s of sigs) {
    const was = prev[s.id];
    const now = was === true ? !s.off : was === false ? s.on : s.on;
    state[s.id] = now;
    if (was !== undefined && was !== now) changes.push({ ...s, now });
  }
  return { state, changes };
};

const send = async (title, body, priority, tags) => {
  console.log(`${title}\n${body}`);
  summary(`### ${title}\n\n` + body.split('\n').map((l) => `- ${l}`).join('\n'));
  if (process.env.DRY_RUN) return;
  const raw = (process.env.NTFY_TOPIC || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
  const topic = raw.split(/[/?#]/).filter(Boolean).pop() || '';
  if (!topic) { gh('error', 'Geen NTFY_TOPIC-secret gevonden. Zet hem in Settings → Secrets and variables → Actions (naam NTFY_TOPIC, waarde je ntfy-onderwerp).'); process.exitCode = 1; return; }
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) { gh('error', `NTFY_TOPIC is geen geldige ntfy-naam (alleen letters, cijfers, - en _). Lengte nu: ${raw.length} tekens.`); process.exitCode = 1; return; }
  const fromUrl = /^https?:\/\//.test(raw) ? new URL(raw).origin : '';
  const server = (process.env.NTFY_SERVER || fromUrl || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  const payload = { topic, title, message: body, priority, tags };
  if (process.env.PAGE_URL) payload.click = process.env.PAGE_URL;
  const r = await fetch(server, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`ntfy weigerde het bericht (HTTP ${r.status}): ${await r.text()}`);
  gh('notice', `Verstuurd naar ntfy: ${title}`);
};

// Laagste koers (dag-low) sinds de cyclustop van 6 oktober 2025, inclusief de live koers
const CYCLE_TOP = Date.UTC(2025, 9, 6);
export const cycleLow = (daily, price) => {
  if (!daily) return null;
  const since = daily.filter((r) => r.t >= CYCLE_TOP);
  if (!since.length) return null;
  let m = since.reduce((a, b) => (b.low < a.low ? b : a));
  m = { price: m.low, t: m.t };
  if (price && price < m.price) m = { price, t: Math.floor(Date.now() / DAY) * DAY };
  return m;
};
const NEW_LOW_STEP = 0.98;   // nieuwe melding pas als de low minstens 2% onder de vorige gemelde low ligt
const dayS = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

const main = async () => {
  let saved = { signals: {}, score: null };
  try { saved = { ...saved, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { gh('notice', 'Geen vorige toestand gevonden: dit is de eerste run.'); }
  const first = !Object.keys(saved.signals).length;

  const d = await loadAll();
  if (!d.price) throw new Error('Geen BTC-koers bereikbaar (Bitstamp en Hyperliquid).');
  const sigs = signals(d, { jth: process.env.MINER_JTH, kwh: process.env.MINER_KWH });
  const { state, changes } = step(saved.signals, sigs);
  const known = SCORE_IDS.filter((id) => state[id] !== undefined), score = known.filter((id) => state[id]).length;
  const prevScore = saved.score;

  const byId = new Map(sigs.map((s) => [s.id, s]));
  const overview = [...SCORE_IDS, 'dip', 'fngstreak', 'rsidiv', 'macddiv', 'stochx', 'td9', 'ma2y', 'bmsb'].filter((id) => byId.has(id)).map((id) => { const s = byId.get(id); return `${state[id] ? '🟢' : '⚪'} ${s.name}: ${s.txt}`; });
  const head = `BTC ${fmt(d.price)} · kapitulatiescore ${score}/${known.length}`;
  // nieuwe cyclus-low: de prijs zakt onder de laagste koers sinds de top
  const cl = cycleLow(d.daily, d.price);
  let cycle = saved.cycleLow || null, newLow = null;
  if (cl) {
    if (!cycle) cycle = { price: cl.price, t: cl.t };                       // eerste keer: alleen onthouden
    else if (cl.price < cycle.price * NEW_LOW_STEP) { newLow = { prev: cycle, now: cl }; cycle = { price: cl.price, t: cl.t }; }
    overview.push(`📉 Cyclusbodem: ${fmt(cl.price)} (${dayS(cl.t)}) · prijs ${pct(d.price / cl.price - 1)} erboven`);
  }
  const lowLine = newLow ? `📉 NIEUWE CYCLUS-LOW: ${fmt(newLow.now.price)}, onder de vorige low van ${fmt(newLow.prev.price)} (${dayS(newLow.prev.t)}). De bodem is nog niet gezet; het dashboard schuift de cyclusbodem mee.` : null;

  const scoreUp = prevScore != null && ((prevScore < 3 && score >= 3) || (prevScore < 5 && score >= 5));
  if (first || process.env.MODE === 'status') {
    await send(first ? 'Bodemsignalen staan aan' : 'Bodemsignalen: overzicht', [head, '', ...overview, '', 'Je krijgt een melding zodra een van deze signalen aan of uit gaat.'].join('\n'), 2, ['bar_chart']);
  } else if (changes.length || newLow) {
    const ons = changes.filter((c) => c.now);
    const lines = changes.map((c) => `${c.now ? '🟢 AAN' : '⚪ UIT'} · ${c.name}: ${c.txt}`);
    const title = newLow ? `📉 Nieuwe cyclus-low: ${fmt(newLow.now.price)}` + (changes.length ? ` · ${changes.length} signaal${changes.length > 1 ? 'en' : ''} veranderd` : '')
      : changes.length === 1
      ? `${changes[0].now ? '🟢' : '⚪'} ${changes[0].name}${changes[0].now ? '' : ' (uit)'}`
      : `${changes.length} bodemsignalen veranderd (${ons.length} aan)`;
    let note = '';
    if (score >= 5) note = '🚨 5 of meer signalen tegelijk: lijkt op een echte capitulatie, zoals bij eerdere cyclusbodems.';
    else if (scoreUp && score >= 3) note = '⚠️ 3 of meer signalen aan: stress in de markt, nog geen volle capitulatie.';
    await send(scoreUp && score >= 5 ? `🚨 Kapitulatiescore ${score}/${known.length}` : title,
      [head, ...(lowLine ? [lowLine] : []), ...(note ? [note] : []), ...(lines.length ? ['', ...lines] : []), '', 'Alle signalen:', ...overview].join('\n'),
      score >= 5 ? 5 : ons.length || newLow ? 4 : 3, [newLow ? 'chart_with_downwards_trend' : ons.length ? 'rotating_light' : 'white_circle']);
  } else {
    console.log(`Geen veranderingen. ${head}\n${overview.join('\n')}`);
    summary(`### Geen veranderingen\n\n- ${head}\n` + overview.map((l) => `- ${l}`).join('\n'));
  }

  if (process.exitCode) return;   // melding niet verstuurd: toestand niet opslaan, dan probeert de volgende run opnieuw
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ signals: state, score, cycleLow: cycle, t: new Date().toISOString() }, null, 2));
};

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { gh('error', e.message || e); process.exit(1); });
