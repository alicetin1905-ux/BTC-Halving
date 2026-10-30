// Wekelijks rapport: herberekend 200-weeks gemiddelde van BTC na de weeksluiting, verstuurd naar ntfy.
// Draait via .github/workflows/weekly-200wma.yml. Instellingen (repo → Settings → Secrets and variables → Actions):
//   secret   NTFY_TOPIC   je ntfy-onderwerp (verplicht)
//   variable NTFY_SERVER  eigen ntfy-server (optioneel, standaard https://ntfy.sh)
//   variable PAGE_URL     link in de melding (optioneel)
// DRY_RUN=1 toont het bericht zonder te versturen.

const DAY = 864e5;
import { appendFileSync } from 'node:fs';
const gh = (level, msg) => console.log(`::${level}::${String(msg).replace(/\r?\n/g, '%0A')}`);
const summary = (md) => { if (process.env.GITHUB_STEP_SUMMARY) try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch (e) { /* */ } };
const fmt = (v) => '$' + Math.round(v).toLocaleString('en-US');
const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1).replace('.', ',') + '%';
const sign = (v) => (v >= 0 ? '+' : '−') + fmt(Math.abs(v));
const M = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const day = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

const getJson = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'btc-halving-weekly' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
};

// Dagkoersen: Bitstamp → Coinbase → Binance (→ CryptoCompare met sleutel)
const sources = {
  async cryptocompare() {
    const key = process.env.CRYPTOCOMPARE_KEY ? `&api_key=${process.env.CRYPTOCOMPARE_KEY}` : '';
    const j = await getJson(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000${key}`);
    if (j.Response !== 'Success') throw new Error('CryptoCompare: ' + (j.Message || 'fout'));
    return j.Data.Data.filter((d) => d.close > 0).map((d) => ({ t: d.time * 1000, close: d.close }));
  },
  async bitstamp(pages = 2) {
    let out = [], end = Math.floor(Date.now() / 1000);
    for (let i = 0; i < pages; i++) {
      const j = await getJson(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&end=${end}`);
      const ohlc = j.data.ohlc.filter((k) => +k.close > 0);
      if (!ohlc.length) break;
      out = ohlc.map((k) => ({ t: +k.timestamp * 1000, close: +k.close })).concat(out);
      end = +ohlc[0].timestamp - 86400;
      if (ohlc.length < 1000) break;
    }
    return out;
  },
  async binance() {
    let out = [], start = Date.now() - 1500 * DAY;
    for (let i = 0; i < 2; i++) {
      const j = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${start}&limit=1000`);
      out = out.concat(j.map((k) => ({ t: +k[0], close: +k[4] })));
      if (j.length < 1000) break;
      start = +j[j.length - 1][0] + DAY;
    }
    return out;
  },
  async coinbase() {
    let out = [], end = Date.now();
    for (let i = 0; i < 6; i++) {
      const start = end - 299 * DAY;
      const j = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
      out = j.map((k) => ({ t: k[0] * 1000, close: k[4] })).concat(out);
      end = start - DAY;
    }
    return out;
  },
};

const loadDaily = async () => {
  // CryptoCompare vraagt sinds kort een sleutel: alleen gebruiken als CRYPTOCOMPARE_KEY bestaat
  const order = ['bitstamp', 'coinbase', 'binance', ...(process.env.CRYPTOCOMPARE_KEY ? ['cryptocompare'] : [])];
  for (const [name, fn] of order.map((n) => [n, sources[n]])) {
    try {
      const rows = await fn();
      const byDay = new Map(rows.map((r) => [Math.floor(r.t / DAY), r.close]));
      const clean = [...byDay.entries()].map(([d, close]) => ({ t: d * DAY, close })).sort((a, b) => a.t - b.t);
      if (clean.length >= 1420) return { name, rows: clean };
      gh('warning', `${name}: te weinig dagen (${clean.length})`);
    } catch (e) { gh('warning', `Koersbron ${name} mislukt: ${e.message}`); }
  }
  throw new Error('Geen enkele koersbron bereikbaar (Bitstamp, Coinbase, Binance). Zie de waarschuwingen hierboven.');
};

// Laatste zondag vóór het einde van een kwartaal (de weeksluiting die daar het dichtst bij ligt)
const quarterEnds = (now) => {
  const d = new Date(now), q = Math.floor(d.getUTCMonth() / 3);
  return [0, 1].map((k) => {
    const y = d.getUTCFullYear() + Math.floor((q + k) / 4), qq = (q + k) % 4;
    let t = Date.UTC(y, qq * 3 + 3, 0); // laatste dag van het kwartaal
    while (new Date(t).getUTCDay() !== 0) t -= DAY;
    return { t, label: `eind Q${qq + 1} ${y}` };
  });
};

export const compute = (rows, now = Date.now()) => {
  // Weeksluiting = slot van de zondag (UTC); alleen afgeronde weken
  const weeks = rows.filter((r) => new Date(r.t).getUTCDay() === 0 && r.t + DAY <= now);
  if (weeks.length < 201) throw new Error(`Te weinig weken: ${weeks.length}`);
  const closes = weeks.map((w) => w.close);
  const avg = (arr) => arr.slice(-200).reduce((s, v) => s + v, 0) / 200;
  const wma = avg(closes), prev = avg(closes.slice(0, -1));
  const last = weeks[weeks.length - 1];
  const project = (nWeeks, price) => { const a = closes.slice(); for (let i = 0; i < nWeeks; i++) a.push(price); return avg(a); };
  const next = project(1, last.close);
  const qs = quarterEnds(now).map((q) => ({ ...q, value: project(Math.max(0, Math.round((q.t - last.t) / (7 * DAY))), last.close) }));
  return { wma, prev, last, next, qs, ratio: last.close / wma };
};

export const message = (c, src) => {
  const lines = [
    `Weekslot (${day(c.last.t)}): ${fmt(c.last.close)}`,
    `200-weeks gemiddelde: ${fmt(c.wma)} (${sign(c.wma - c.prev)} t.o.v. vorige week)`,
    `Prijs: ${pct(c.ratio - 1)} ${c.ratio >= 1 ? 'boven' : 'onder'} het 200WMA`,
    `Volgende week verwacht: ±${fmt(c.next)} (bij gelijke prijs)`,
    c.qs.map((q) => `${q.label}: ±${fmt(q.value)}`).join(' · '),
  ];
  if (c.ratio < 1) lines.push('⚠️ Weekslot onder het 200WMA: historisch bodemgebied.');
  else if (c.ratio < 1.1) lines.push('Binnen 10% van het 200WMA: dicht bij historisch bodemgebied.');
  lines.push(`Bron: ${src}`);
  return { title: `BTC weekslot · 200WMA ${fmt(c.wma)}`, body: lines.join('\n') };
};

// ---- Analyse: 200-weeks EMA vs MA over de volledige historie (sinds 2011) ----
export const analyse = (rows, now = Date.now()) => {
  const weeks = rows.filter((r) => new Date(r.t).getUTCDay() === 0 && r.t + DAY <= now);
  const N = 200, k = 2 / (N + 1);
  let ema = null, sum = 0;
  const out = weeks.map((w, i) => {
    sum += w.close; if (i >= N) sum -= weeks[i - N].close;
    const sma = i >= N - 1 ? sum / N : null;
    if (i === N - 1) ema = sma;                       // start met de SMA van de eerste 200 weken (zoals TradingView)
    else if (i >= N) ema = w.close * k + ema * (1 - k);
    return { t: w.t, close: w.close, sma, ema: i >= N - 1 ? ema : null };
  });
  return out;
};

// Volledige dagkoers per munt via Coinbase (ETH sinds 2016, SOL sinds 2021); BTC via Bitstamp (sinds 2011)
const coinbaseAll = async (product) => {
  let out = [], end = Date.now();
  for (let i = 0; i < 40; i++) {
    const start = end - 299 * DAY;
    const r = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { 'User-Agent': 'btc-halving-weekly' } });
    if (!r.ok) throw new Error(`Coinbase ${product} → HTTP ${r.status}`);
    const j = await r.json();
    if (!j.length) break;
    out = j.map((k) => ({ t: k[0] * 1000, close: k[4] })).concat(out);
    end = start - DAY;
    await new Promise((res) => setTimeout(res, 150));
  }
  return out;
};
const COINS = {
  BTC: { load: () => sources.bitstamp(8), src: 'Bitstamp', lows: [['2018-12-15', 'Bodem 2018'], ['2020-03-15', 'COVID 2020'], ['2022-11-21', 'Bodem 2022']] },
  ETH: { load: () => coinbaseAll('ETH-USD'), src: 'Coinbase', lows: [['2018-12-15', 'Bodem 2018'], ['2020-03-15', 'COVID 2020'], ['2022-06-18', 'Bodem jun 2022'], ['2022-11-21', 'Bodem nov 2022']] },
  SOL: { load: () => coinbaseAll('SOL-USD'), src: 'Coinbase', lows: [['2022-12-29', 'Bodem 2022']] },
};
const fmtP = (v) => v >= 1000 ? fmt(v) : '$' + v.toFixed(v < 10 ? 2 : 1).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const analyseCoin = async (sym) => {
  const c = COINS[sym];
  const rows = await c.load();
  const byDay = new Map(rows.map((r) => [Math.floor(r.t / DAY), r.close]));
  const clean = [...byDay.entries()].map(([d, close]) => ({ t: d * DAY, close })).sort((a, b) => a.t - b.t);
  const a = analyse(clean);
  const last = a[a.length - 1], prev4 = a[a.length - 5];
  // 100-weeks MA als extra lijn (bruikbaar als de 200W-historie kort is)
  const wk = a.map((x) => x.close), ma100 = wk.length >= 100 ? wk.slice(-100).reduce((s, v) => s + v, 0) / 100 : null;
  const L = [`[${sym}] Data: ${c.src}, ${a.length} weken (${day(a[0].t)} – ${day(last.t)}) · weekslot ${fmtP(last.close)}`];
  if (last.sma) {
    L.push(`[${sym}] 200W MA ${fmtP(last.sma)} (prijs ${pct(last.close / last.sma - 1)}, 4 wk ${last.sma - prev4.sma >= 0 ? '+' : '−'}${fmtP(Math.abs(last.sma - prev4.sma))}) · 200W EMA ${fmtP(last.ema)} (prijs ${pct(last.close / last.ema - 1)})`);
  } else L.push(`[${sym}] Nog geen 200 weken data: 200W MA/EMA niet te berekenen`);
  if (ma100) L.push(`[${sym}] 100W MA ${fmtP(ma100)} (prijs ${pct(last.close / ma100 - 1)})`);
  // cyclus: hoogste slot sinds 2024 en laagste slot sinds de BTC-top (6 okt 2025)
  const since = (iso) => clean.filter((r) => r.t >= Date.parse(iso));
  const top = since('2024-01-01').reduce((m, r) => r.close > m.close ? r : m);
  const low = since(new Date(top.t).toISOString().slice(0, 10)).reduce((m, r) => r.close < m.close ? r : m);
  const wAt = (t) => a.reduce((b, x) => Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b);
  const wl = wAt(low.t);
  L.push(`[${sym}] Cyclustop ${fmtP(top.close)} (${day(top.t)}) → laagste slot daarna ${fmtP(low.close)} (${day(low.t)}, ${pct(low.close / top.close - 1)})` + (wl.sma ? ` · toen MA ${fmtP(wl.sma)} (${pct(low.close / wl.sma - 1)}), EMA ${fmtP(wl.ema)} (${pct(low.close / wl.ema - 1)})` : ''));
  c.lows.forEach(([iso, lbl]) => {
    const t = Date.parse(iso);
    const near = clean.filter((r) => Math.abs(r.t - t) <= 12 * DAY);
    if (!near.length) return;
    const lo = near.reduce((m, r) => r.close < m.close ? r : m), w = wAt(lo.t);
    L.push(`[${sym}] ${lbl}: low ${fmtP(lo.close)} · MA ${w.sma ? fmtP(w.sma) + ' (' + pct(lo.close / w.sma - 1) + ')' : '— (te weinig data)'} · EMA ${w.ema ? fmtP(w.ema) + ' (' + pct(lo.close / w.ema - 1) + ')' : '—'}`);
  });
  return L;
};

const runAnalyse = async () => {
  const want = (process.env.COIN || 'BTC').toUpperCase();
  const list = want === 'ALL' ? Object.keys(COINS) : [want];
  for (const sym of list) {
    try {
      const L = await analyseCoin(sym);
      gh('notice', L.join('\n'));   // één melding per munt (GitHub toont max. 10 per stap)
      summary(`### ${sym}: 200W EMA vs MA\n\n` + L.map((l) => `- ${l}`).join('\n'));
      console.log(L.join('\n'));
    } catch (e) { gh('error', `[${sym}] ${e.message}`); }
  }
};

const main = async () => {
  if (process.env.MODE === 'analyse') return runAnalyse();
  const { name, rows } = await loadDaily();
  const c = compute(rows);
  const { title, body } = message(c, name);
  console.log(title + '\n' + body);
  summary(`### ${title}\n\n` + body.split('\n').map((l) => `- ${l}`).join('\n'));
  if (process.env.DRY_RUN) return;
  // Accepteert ook een volledige link (https://ntfy.sh/naam, ntfy.sh/naam) en haalt er de naam uit
  const raw = (process.env.NTFY_TOPIC || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
  const topic = raw.split(/[/?#]/).filter(Boolean).pop() || '';
  if (raw && !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
    gh('error', `NTFY_TOPIC is geen geldige ntfy-naam (alleen letters, cijfers, - en _, max. 64 tekens). Lengte nu: ${raw.length} tekens. Vul alleen de naam in, bv. btc-halving-abc123.`);
    process.exitCode = 1; return;
  }
  if (!topic) {
    gh('error', 'Geen NTFY_TOPIC-secret gevonden. Zet hem in Settings → Secrets and variables → Actions → New repository secret (naam NTFY_TOPIC, waarde je ntfy-onderwerp). De berekening zelf werkte: zie de samenvatting.');
    process.exitCode = 1; return;
  }
  const fromUrl = /^https?:\/\//.test(raw) ? new URL(raw).origin : '';
  const server = (process.env.NTFY_SERVER || fromUrl || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  const payload = {
    topic, title, message: body, priority: c.ratio < 1.1 ? 4 : 3,
    tags: [c.ratio < 1 ? 'rotating_light' : 'chart_with_upwards_trend', 'bitcoin'],
  };
  if (process.env.PAGE_URL) payload.click = process.env.PAGE_URL;
  const r = await fetch(server, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`ntfy weigerde het bericht (HTTP ${r.status}): ${await r.text()}`);
  const sent = await r.json().catch(() => ({}));
  const masked = topic.length > 8 ? `${topic.slice(0, 12)}…${topic.slice(-3)}` : '***';
  gh('notice', `Verstuurd naar ${server} · onderwerp "${masked}" (${topic.length} tekens) · id ${sent.id || '?'} · ${title}`);
};

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { gh('error', e.message || e); process.exit(1); });
