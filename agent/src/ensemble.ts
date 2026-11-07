// No-fit trend ensemble (see research/ and strategy-research.md).
// Target SOL fraction = equal-weight average of 84 long-only trend signals on 1h / 4h / 1d bars:
// Donchian breakouts, EMA crosses, time-series momentum, and momentum gated by BTC's trend.
// No parameter is chosen by performance; every config in the grid gets the same weight.
// Must stay in sync with research/wf.py (checked by agent/test/ensemble.test.ts).

export interface HBar { t: number; o: number; h: number; l: number; c: number }

function agg(b: HBar[], k: number) {
  const n = Math.floor(b.length / k) * k, c: number[] = [], h: number[] = [], l: number[] = [];
  for (let i = 0; i < n; i += k) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i; j < i + k; j++) { hi = Math.max(hi, b[j].h); lo = Math.min(lo, b[j].l); }
    c.push(b[i + k - 1].c); h.push(hi); l.push(lo);
  }
  return { c, h, l };
}

function emaArr(x: number[], n: number) {
  const k = 2 / (n + 1), out = new Array(x.length); let e = x[0];
  for (let i = 0; i < x.length; i++) { e = x[i] * k + e * (1 - k); out[i] = e; }
  return out as number[];
}

/** Last-bar signal of every config at one timeframe (1 = long, 0 = flat). */
function signals(sol: HBar[], btc: HBar[], k: number): { name: string; on: number }[] {
  const s = agg(sol, k), b = agg(btc, k), c = s.c, n = c.length, out: { name: string; on: number }[] = [];
  const pairs = (a: number[], bb: number[]) => a.flatMap(x => bb.map(y => [x, y]));
  // Donchian: stateful, so replay the whole series
  for (const [ne, nx] of pairs([10, 20, 55], [5, 10, 20])) {
    if (nx > ne) continue;
    let p = 0;
    for (let i = 0; i < n; i++) {
      const hi = i >= ne ? Math.max(...s.h.slice(i - ne, i)) : Infinity;
      const lo = i >= nx ? Math.min(...s.l.slice(i - nx, i)) : -Infinity;
      if (p === 0 && c[i] > hi) p = 1; else if (p === 1 && c[i] < lo) p = 0;
    }
    out.push({ name: `donchian ${k}h ${ne}/${nx}`, on: p });
  }
  for (const [f, sl] of pairs([10, 20, 50], [50, 100, 200])) {
    if (f >= sl) continue;
    out.push({ name: `ema ${k}h ${f}/${sl}`, on: emaArr(c, f)[n - 1] > emaArr(c, sl)[n - 1] ? 1 : 0 });
  }
  const bema = (p: number) => emaArr(b.c, p)[b.c.length - 1];
  for (const lb of [12, 24, 48, 96]) {
    const mom = n > lb && c[n - 1] / c[n - 1 - lb] - 1 > 0;
    out.push({ name: `tsmom ${k}h ${lb}`, on: mom ? 1 : 0 });
    for (const be of [50, 200]) out.push({ name: `btc-gated ${k}h ${lb}/${be}`, on: mom && b.c[b.c.length - 1] > bema(be) ? 1 : 0 });
  }
  return out;
}

/** bars must be closed hourly bars aligned so that 4h/1d blocks start at index 0 (UTC 00:00 boundary). */
export function ensembleTarget(sol: HBar[], btc: HBar[]) {
  const all = [1, 4, 24].flatMap(k => {
    // align: drop leading bars so that the series ends exactly on a k-hour block boundary
    const end = sol.length - (((sol[sol.length - 1].t / 3_600_000 + 1) % k) + k) % k;
    const start = ((k - (sol[0].t / 3_600_000) % k) % k);
    return signals(sol.slice(start, end), btc.slice(start, end), k);
  });
  const target = all.reduce((a, x) => a + x.on, 0) / all.length;
  return { target, n: all.length, on: all.filter(x => x.on).map(x => x.name) };
}

export async function fetchHourly(symbol: string, hours = 6000): Promise<HBar[]> {
  const out: HBar[] = []; let start = Date.now() - hours * 3_600_000;
  while (true) {
    const rows = await (await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&limit=1000`)).json() as any[];
    if (!rows.length) break;
    out.push(...rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })));
    start = rows[rows.length - 1][0] + 1;
    if (rows.length < 1000) break;
  }
  return out.filter(b => b.t + 3_600_000 <= Date.now()); // closed bars only
}
