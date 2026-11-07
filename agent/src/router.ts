// Yield router decision logic. Mirrors research/yield/router2.py (the backtest that was run before any live use):
// hold the venue with the best trailing-7-day realized yield; switch only when the expected extra yield over
// PAYBACK_DAYS on the current balance pays for the switch transaction.
export interface VenueRates { name: string; idx: number; trailDailyRet: number; trailApyPct: number; spotApyPct: number; days: number }
export interface RouterInput { venues: VenueRates[]; current: number | null; navUsd: number; switchCostUsd: number }
export interface RouterDecision { target: number; switch: boolean; edgeUsd: number; reason: string }

export const LOOKBACK_DAYS = 7, PAYBACK_DAYS = 14;

export function decide(inp: RouterInput): RouterDecision {
  const ok = inp.venues.filter(v => v.days >= LOOKBACK_DAYS);
  if (!ok.length) return { target: inp.current ?? -1, switch: false, edgeUsd: 0, reason: "not enough rate history" };
  const best = ok.reduce((a, b) => (b.trailDailyRet > a.trailDailyRet ? b : a));
  if (inp.current === null || inp.current < 0)
    return { target: best.idx, switch: true, edgeUsd: best.trailDailyRet * PAYBACK_DAYS * inp.navUsd, reason: `initial allocation to ${best.name} (trailing 7d ${best.trailApyPct.toFixed(2)}% APY)` };
  const cur = inp.venues.find(v => v.idx === inp.current)!;
  const edgeUsd = (best.trailDailyRet - cur.trailDailyRet) * PAYBACK_DAYS * inp.navUsd;
  if (best.idx !== cur.idx && edgeUsd > inp.switchCostUsd)
    return { target: best.idx, switch: true, edgeUsd, reason: `${best.name} ${best.trailApyPct.toFixed(2)}% vs ${cur.name} ${cur.trailApyPct.toFixed(2)}% (7d): +$${edgeUsd.toFixed(5)} over ${PAYBACK_DAYS}d > switch cost $${inp.switchCostUsd.toFixed(5)}` };
  return { target: cur.idx, switch: false, edgeUsd, reason: best.idx === cur.idx ? `${cur.name} is already the best (7d ${cur.trailApyPct.toFixed(2)}%)` : `edge $${edgeUsd.toFixed(5)} over ${PAYBACK_DAYS}d does not cover switch cost $${inp.switchCostUsd.toFixed(5)}` };
}

const dayOf = (s: string) => s.slice(0, 10);

/** Trailing realized daily returns. Kamino: on-chain collateral exchange-rate history (Kamino API).
 *  Jupiter Lend: DefiLlama daily base APY (rewards excluded). Only finished UTC days are used. */
export async function fetchRates(now = new Date()): Promise<VenueRates[]> {
  const today = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 20 * 86_400_000).toISOString().slice(0, 10);
  const kj: any = await (await fetch(`https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59/metrics/history?env=mainnet-beta&start=${start}&end=${today}&frequency=day`)).json();
  const kh = (kj.history as any[]).map(x => ({ d: dayOf(x.timestamp), er: +x.metrics.exchangeRate, spot: +x.metrics.supplyInterestAPY * 100 })).filter(x => x.d <= today);
  const kr = kh.slice(1).map((x, i) => kh[i].er / x.er - 1);
  const jj: any = await (await fetch("https://yields.llama.fi/chart/d783c8df-e2ed-44b4-8317-161ccc1b5f06")).json();
  const byDay = new Map<string, number>();
  for (const x of jj.data as any[]) if (dayOf(x.timestamp) < today) byDay.set(dayOf(x.timestamp), x.apyBase);
  const jr = [...byDay.values()].map(a => (1 + a / 100) ** (1 / 365) - 1);
  const mk = (name: string, idx: number, r: number[], spot: number): VenueRates => {
    const t = r.slice(-LOOKBACK_DAYS), m = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
    return { name, idx, trailDailyRet: m, trailApyPct: ((1 + m) ** 365 - 1) * 100, spotApyPct: spot, days: t.length };
  };
  return [mk("Jupiter Lend USDC", 0, jr, [...byDay.values()].at(-1) ?? 0), mk("Kamino Lend USDC", 1, kr, kh.at(-1)?.spot ?? 0)];
}
