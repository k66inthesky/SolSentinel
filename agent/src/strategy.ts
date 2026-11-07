// Dual-speed strategy core. Pure logic, shared by the backtester and the live agent.
//
// Slow path (once per closed 1m bar): compute regime + trigger levels.
// Fast path (every price tick): compare price against precomputed levels, no heavy math.

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export type Regime = "trend" | "range" | "halt";

export interface Params {
  breakoutLookback: number; // bars used for the breakout high
  atrPeriod: number;
  breakoutAtrK: number;     // breakout buffer above the high, in ATRs
  emaFast: number;
  emaSlow: number;
  tpAtr: number;            // trend take-profit distance, in ATRs
  trailAtr: number;         // trend trailing stop distance, in ATRs
  bbPeriod: number;
  bbEntry: number;          // range entry at mean - bbEntry * sigma
  bbStop: number;           // range stop at mean - bbStop * sigma
  maxHoldMs: number;
  erPeriod: number;         // efficiency-ratio window for regime detection
  erTrend: number;          // ER above this = trend
  erRange: number;          // ER below this = range
  maxAtrPct: number;        // ATR/price above this = too wild, halt
  feeBps: number;           // assumed cost per side (pool fee + slippage)
  minEdgeMult: number;      // target move must be >= this * round-trip cost
}

export const DEFAULT_PARAMS: Params = {
  breakoutLookback: 15,
  atrPeriod: 14,
  breakoutAtrK: 0.5,
  emaFast: 9,
  emaSlow: 21,
  tpAtr: 2,
  trailAtr: 1,
  bbPeriod: 20,
  bbEntry: 2,
  bbStop: 3,
  maxHoldMs: 30 * 60_000,
  erPeriod: 30,
  erTrend: 0.3,
  erRange: 0.2,
  maxAtrPct: 0.006,
  feeBps: 10,
  minEdgeMult: 3,
};

// Bounds the LLM is allowed to move parameters within. Anything outside is clamped.
export const PARAM_BOUNDS: Partial<Record<keyof Params, [number, number]>> = {
  breakoutLookback: [5, 60],
  breakoutAtrK: [0, 2],
  tpAtr: [0.5, 5],
  trailAtr: [0.5, 3],
  bbEntry: [1.5, 3],
  bbStop: [2, 4],
  erTrend: [0.15, 0.6],
  erRange: [0.05, 0.4],
};

export function clampParams(p: Params, patch: Partial<Params>): Params {
  const out = { ...p };
  for (const [k, v] of Object.entries(patch) as [keyof Params, number][]) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const b = PARAM_BOUNDS[k];
    if (!b) continue; // only bounded params are tunable
    out[k] = Math.min(b[1], Math.max(b[0], v));
  }
  return out;
}

// ---------- indicators ----------
export function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function atr(bars: Bar[], period: number): number {
  const n = Math.min(period, bars.length - 1);
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    s += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return s / n;
}

export function meanStd(values: number[]): [number, number] {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return [m, Math.sqrt(v)];
}

export function efficiencyRatio(closes: number[]): number {
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  return path === 0 ? 0 : Math.abs(closes[closes.length - 1] - closes[0]) / path;
}

// ---------- slow path ----------
export interface Levels {
  regime: Regime;
  ruleRegime: Regime;     // what the rules alone said (for logging when LLM overrides)
  price: number;
  atr: number;
  er: number;
  entryAbove?: number;    // trend: buy when price >= this
  entryBelow?: number;    // range: buy when price <= this
  rangeMean?: number;
  rangeStop?: number;
  reason: string;
}

export function minBars(p: Params): number {
  return Math.max(p.emaSlow * 3, p.bbPeriod, p.erPeriod, p.breakoutLookback, p.atrPeriod) + 2;
}

export function ruleRegime(bars: Bar[], p: Params): { regime: Regime; er: number; atr: number } {
  const closes = bars.slice(-p.erPeriod - 1).map(b => b.c);
  const er = efficiencyRatio(closes);
  const a = atr(bars, p.atrPeriod);
  const price = bars[bars.length - 1].c;
  if (a / price > p.maxAtrPct) return { regime: "halt", er, atr: a };
  if (er >= p.erTrend) return { regime: "trend", er, atr: a };
  if (er <= p.erRange) return { regime: "range", er, atr: a };
  return { regime: "halt", er, atr: a }; // ambiguous: stay out
}

export function computeLevels(bars: Bar[], p: Params, regimeOverride?: Regime): Levels {
  const last = bars[bars.length - 1];
  const rr = ruleRegime(bars, p);
  const regime = regimeOverride ?? rr.regime;
  const cost = 2 * p.feeBps / 10_000;
  const base: Levels = { regime, ruleRegime: rr.regime, price: last.c, atr: rr.atr, er: rr.er, reason: "" };

  if (regime === "trend") {
    const closes = bars.slice(-p.emaSlow * 3).map(b => b.c);
    const fast = ema(closes, p.emaFast), slow = ema(closes, p.emaSlow);
    if (fast <= slow) return { ...base, reason: `trend but EMA${p.emaFast} <= EMA${p.emaSlow}, waiting` };
    const hi = Math.max(...bars.slice(-p.breakoutLookback).map(b => b.h));
    const entry = hi + p.breakoutAtrK * rr.atr;
    const edge = (p.tpAtr * rr.atr) / entry;
    if (edge < p.minEdgeMult * cost) return { ...base, reason: `trend edge ${(edge * 100).toFixed(2)}% < min ${(p.minEdgeMult * cost * 100).toFixed(2)}%` };
    return { ...base, entryAbove: entry, reason: `breakout above ${entry.toFixed(3)}` };
  }
  if (regime === "range") {
    const [m, s] = meanStd(bars.slice(-p.bbPeriod).map(b => b.c));
    const entry = m - p.bbEntry * s;
    const edge = (m - entry) / entry;
    if (edge < p.minEdgeMult * cost) return { ...base, rangeMean: m, reason: `range edge ${(edge * 100).toFixed(2)}% too small` };
    return { ...base, entryBelow: entry, rangeMean: m, rangeStop: m - p.bbStop * s, reason: `mean-revert buy below ${entry.toFixed(3)}` };
  }
  return { ...base, reason: "halt: no trading in this regime" };
}

// ---------- fast path ----------
export interface Position {
  mode: "trend" | "range";
  entryPx: number;
  entryTs: number;
  qty: number;          // SOL
  costUsd: number;      // USDC spent incl. fee
  tp: number;
  stop: number;
  peak: number;
}

export type Signal =
  | { kind: "enter"; mode: "trend" | "range"; px: number; tp: number; stop: number; why: string }
  | { kind: "exit"; px: number; why: string }
  | null;

export function onTick(px: number, ts: number, lv: Levels | null, pos: Position | null, p: Params): Signal {
  if (pos) {
    if (pos.mode === "trend") {
      pos.peak = Math.max(pos.peak, px);
      pos.stop = Math.max(pos.stop, pos.peak - p.trailAtr * (lv?.atr ?? 0));
    } else if (lv?.rangeMean) {
      pos.tp = lv.rangeMean; // mean moves with the market
    }
    if (px >= pos.tp) return { kind: "exit", px, why: "take-profit" };
    if (px <= pos.stop) return { kind: "exit", px, why: pos.mode === "trend" ? "trailing-stop" : "stop" };
    if (ts - pos.entryTs >= p.maxHoldMs) return { kind: "exit", px, why: "time-stop" };
    if (lv?.regime === "halt" && lv.ruleRegime === "halt" && lv.atr / px > p.maxAtrPct) return { kind: "exit", px, why: "volatility-halt" };
    return null;
  }
  if (!lv) return null;
  if (lv.entryAbove !== undefined && px >= lv.entryAbove) {
    return { kind: "enter", mode: "trend", px, tp: px + p.tpAtr * lv.atr, stop: px - p.trailAtr * lv.atr, why: lv.reason };
  }
  if (lv.entryBelow !== undefined && px <= lv.entryBelow && lv.rangeMean && lv.rangeStop) {
    return { kind: "enter", mode: "range", px, tp: lv.rangeMean, stop: lv.rangeStop, why: lv.reason };
  }
  return null;
}
