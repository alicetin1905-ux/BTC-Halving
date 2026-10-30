// Wekelijks rapport: herberekend 200-weeks gemiddelde van BTC na de weeksluiting, verstuurd naar ntfy.
// Draait via .github/workflows/weekly-200wma.yml. Instellingen (repo → Settings → Secrets and variables → Actions):
//   secret   NTFY_TOPIC   je ntfy-onderwerp (verplicht)
//   variable NTFY_SERVER  eigen ntfy-server (optioneel, standaard https://ntfy.sh)
//   variable PAGE_URL     link in de melding (optioneel)
// DRY_RUN=1 toont het bericht zonder te versturen.

const DAY = 864e5;
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

// Dagkoersen: CryptoCompare → Bitstamp → Coinbase (allemaal bereikbaar vanaf GitHub-servers)
const sources = {
  async cryptocompare() {
    const key = process.env.CRYPTOCOMPARE_KEY ? `&api_key=${process.env.CRYPTOCOMPARE_KEY}` : '';
    const j = await getJson(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000${key}`);
    if (j.Response !== 'Success') throw new Error('CryptoCompare: ' + (j.Message || 'fout'));
    return j.Data.Data.filter((d) => d.close > 0).map((d) => ({ t: d.time * 1000, close: d.close }));
  },
  async bitstamp() {
    let out = [], end = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 2; i++) {
      const j = await getJson(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&end=${end}`);
      const rows = j.data.ohlc.map((k) => ({ t: +k.timestamp * 1000, close: +k.close }));
      out = rows.concat(out);
      end = +j.data.ohlc[0].timestamp - 86400;
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
  for (const [name, fn] of Object.entries(sources)) {
    try {
      const rows = await fn();
      const byDay = new Map(rows.map((r) => [Math.floor(r.t / DAY), r.close]));
      const clean = [...byDay.entries()].map(([d, close]) => ({ t: d * DAY, close })).sort((a, b) => a.t - b.t);
      if (clean.length >= 1420) return { name, rows: clean };
      console.warn(`${name}: te weinig dagen (${clean.length})`);
    } catch (e) { console.warn(`${name}: ${e.message}`); }
  }
  throw new Error('Geen koersbron bereikbaar');
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

const main = async () => {
  const { name, rows } = await loadDaily();
  const c = compute(rows);
  const { title, body } = message(c, name);
  console.log(title + '\n' + body);
  if (process.env.DRY_RUN) return;
  const topic = (process.env.NTFY_TOPIC || '').trim();
  if (!topic) { console.error('Geen NTFY_TOPIC-secret ingesteld: bericht niet verstuurd.'); process.exitCode = 1; return; }
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  const payload = {
    topic, title, message: body, priority: c.ratio < 1.1 ? 4 : 3,
    tags: [c.ratio < 1 ? 'rotating_light' : 'chart_with_upwards_trend', 'bitcoin'],
  };
  if (process.env.PAGE_URL) payload.click = process.env.PAGE_URL;
  const r = await fetch(server, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`ntfy → HTTP ${r.status}: ${await r.text()}`);
  console.log('Verstuurd naar ntfy.');
};

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
