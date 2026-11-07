// Replays 1m bars through the exact same onTick() fast path the live agent uses.
// Each bar is expanded into 4 synthetic ticks: open -> (low|high) -> (high|low) -> close.
// When a bar touches both the stop and the target, the stop-first path is the pessimistic one.

import { readFileSync, writeFileSync } from "node:fs";
import { Bar, DEFAULT_PARAMS, Params, Position, computeLevels, minBars, onTick } from "./strategy.js";
import { DEFAULT_POLICY, Policy, RiskGate } from "./risk.js";

export interface Trade { mode: string; entryTs: number; exitTs: number; entryPx: number; exitPx: number; pnlUsd: number; pnlPct: number; why: string }
export interface Result { trades: Trade[]; equity: number; startEquity: number; maxDrawdownPct: number; winRate: number; buyHoldPct: number; params: Params }

export function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf8")) as number[][]).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

function ticks(b: Bar): number[] {
  return b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
}

export function backtest(bars: Bar[], p: Params = DEFAULT_PARAMS, policy: Policy = DEFAULT_POLICY, startEquity = 10): Result {
  const gate = new RiskGate(policy);
  const fee = p.feeBps / 10_000;
  let cash = startEquity, pos: Position | null = null, peakEq = startEquity, maxDd = 0;
  const trades: Trade[] = [];
  const warm = minBars(p);

  for (let i = warm; i < bars.length; i++) {
    const lv = computeLevels(bars.slice(Math.max(0, i - 200), i), p); // levels from CLOSED bars only
    const b = bars[i];
    const tk = ticks(b);
    for (let j = 0; j < tk.length; j++) {
      const px = tk[j], ts = b.t + j * 15_000;
      const sig = onTick(px, ts, lv, pos, p);
      if (!sig) continue;
      if (sig.kind === "enter" && !pos) {
        const notional = Math.min(policy.maxTradeUsd, cash);
        if (!gate.canEnter(ts, notional).ok || notional < 0.5) continue;
        const fillPx = px * (1 + fee);
        pos = { mode: sig.mode, entryPx: fillPx, entryTs: ts, qty: notional / fillPx, costUsd: notional, tp: sig.tp, stop: sig.stop, peak: px };
        cash -= notional;
        gate.recordEntry(ts);
      } else if (sig.kind === "exit" && pos) {
        const fillPx = px * (1 - fee);
        const proceeds = pos.qty * fillPx;
        const pnl = proceeds - pos.costUsd;
        cash += proceeds;
        trades.push({ mode: pos.mode, entryTs: pos.entryTs, exitTs: ts, entryPx: pos.entryPx, exitPx: fillPx, pnlUsd: pnl, pnlPct: pnl / pos.costUsd * 100, why: sig.why });
        gate.recordExit(ts, pnl);
        pos = null;
      }
    }
    const eq = cash + (pos ? pos.qty * b.c : 0);
    peakEq = Math.max(peakEq, eq);
    maxDd = Math.max(maxDd, (peakEq - eq) / peakEq);
  }
  if (pos) { // mark-to-market close at the end
    const px = bars[bars.length - 1].c * (1 - fee);
    const pnl = pos.qty * px - pos.costUsd;
    cash += pos.qty * px;
    trades.push({ mode: pos.mode, entryTs: pos.entryTs, exitTs: bars[bars.length - 1].t, entryPx: pos.entryPx, exitPx: px, pnlUsd: pnl, pnlPct: pnl / pos.costUsd * 100, why: "end-of-data" });
  }
  const wins = trades.filter(t => t.pnlUsd > 0).length;
  return {
    trades, equity: cash, startEquity, maxDrawdownPct: maxDd * 100,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    buyHoldPct: (bars[bars.length - 1].c / bars[warm].c - 1) * 100,
    params: p,
  };
}

export function summarize(r: Result, label = "") {
  const byMode = (m: string) => r.trades.filter(t => t.mode === m);
  const sum = (ts: Trade[]) => ts.reduce((a, t) => a + t.pnlUsd, 0);
  return {
    label,
    trades: r.trades.length,
    trend: { n: byMode("trend").length, pnlUsd: +sum(byMode("trend")).toFixed(4) },
    range: { n: byMode("range").length, pnlUsd: +sum(byMode("range")).toFixed(4) },
    returnPct: +((r.equity / r.startEquity - 1) * 100).toFixed(3),
    winRatePct: +r.winRate.toFixed(1),
    maxDrawdownPct: +r.maxDrawdownPct.toFixed(3),
    buyHoldPct: +r.buyHoldPct.toFixed(3),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? "backtest/data/sol_1m_7d.json";
  const bars = loadBars(path);
  const r = backtest(bars);
  console.log(JSON.stringify(summarize(r, "default params, full 7d"), null, 2));
  writeFileSync("backtest/result.json", JSON.stringify({ summary: summarize(r), trades: r.trades }, null, 2));
}
