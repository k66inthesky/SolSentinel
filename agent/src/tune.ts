// Walk-forward tuning: grid-search on the first 5 days, report on the last 2 days (unseen).
// Reporting only the in-sample number would be curve-fitting; the out-of-sample number is the honest one.
import { writeFileSync } from "node:fs";
import { DEFAULT_PARAMS, Params } from "./strategy.js";
import { backtest, loadBars, summarize } from "./backtest.js";

const bars = loadBars(process.argv[2] ?? "backtest/data/sol_1m_7d.json");
const split = Math.floor(bars.length * 5 / 7);
const train = bars.slice(0, split), test = bars.slice(split - 200); // 200 bars warm-up overlap

const grid: Partial<Params>[] = [];
for (const breakoutLookback of [10, 15, 30])
  for (const breakoutAtrK of [0, 0.5])
    for (const tpAtr of [1.5, 3])
      for (const trailAtr of [1, 2])
        for (const bbEntry of [2, 2.5])
          for (const erTrend of [0.25, 0.35])
            for (const minEdgeMult of [2, 3])
              grid.push({ breakoutLookback, breakoutAtrK, tpAtr, trailAtr, bbEntry, erTrend, minEdgeMult });

let best: { p: Params; score: number; s: ReturnType<typeof summarize> } | null = null;
for (const g of grid) {
  const p = { ...DEFAULT_PARAMS, ...g };
  const r = backtest(train, p);
  const s = summarize(r);
  if (s.trades < 5) continue; // too few trades to mean anything
  const score = s.returnPct - 0.5 * s.maxDrawdownPct; // penalise drawdown
  if (!best || score > best.score) best = { p, score, s };
}
if (!best) throw new Error("no config produced enough trades");

const oosDefault = summarize(backtest(test, DEFAULT_PARAMS), "default params, out-of-sample (last 2d)");
const oosBest = summarize(backtest(test, best.p), "tuned params, out-of-sample (last 2d)");
const out = { tunedOn: "first 5 days", configsTried: grid.length, inSample: { ...best.s, label: "tuned params, in-sample (first 5d)" }, outOfSample: [oosDefault, oosBest], tunedParams: best.p };
console.log(JSON.stringify(out, null, 2));
writeFileSync("backtest/walkforward.json", JSON.stringify(out, null, 2));
