// Slow brain: every N minutes Claude reads a compact market snapshot and decides the regime,
// optional parameter tweaks (clamped to PARAM_BOUNDS), and whether to pause. It never places
// orders itself: the fast rule engine does, inside limits the on-chain vault enforces.
// Without ANTHROPIC_API_KEY (or on any error/refusal) it falls back to the pure rule regime.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Bar, Params, Regime, PARAM_BOUNDS, atr, efficiencyRatio, ema, meanStd, ruleRegime } from "./strategy.js";

export const BrainDecision = z.object({
  regime: z.enum(["trend", "range", "halt"]),
  pause_trading: z.boolean(),
  param_patch: z.object({
    breakoutLookback: z.number().nullable(),
    breakoutAtrK: z.number().nullable(),
    tpAtr: z.number().nullable(),
    trailAtr: z.number().nullable(),
    bbEntry: z.number().nullable(),
    bbStop: z.number().nullable(),
  }),
  confidence: z.number(),
  reasoning: z.string(),
});
export type BrainDecisionT = z.infer<typeof BrainDecision> & { source: "llm" | "rules"; model?: string; latencyMs: number; snapshot: Snapshot };

export interface Snapshot {
  ts: string; price: number; ret15mPct: number; ret60mPct: number; atrPct: number;
  er30: number; emaFastAboveSlow: boolean; bbZ: number; ruleRegime: Regime;
  recentTrades: { mode: string; pnlPct: number; why: string }[]; pnlTodayUsd: number;
}

export function snapshot(bars: Bar[], p: Params, recentTrades: Snapshot["recentTrades"], pnlTodayUsd: number): Snapshot {
  const c = bars.map(b => b.c), px = c[c.length - 1];
  const [m, s] = meanStd(c.slice(-p.bbPeriod));
  const closes = c.slice(-p.emaSlow * 3);
  return {
    ts: new Date(bars[bars.length - 1].t).toISOString(),
    price: px,
    ret15mPct: +((px / c[c.length - 16] - 1) * 100).toFixed(3),
    ret60mPct: +((px / c[Math.max(0, c.length - 61)] - 1) * 100).toFixed(3),
    atrPct: +(atr(bars, p.atrPeriod) / px * 100).toFixed(4),
    er30: +efficiencyRatio(c.slice(-p.erPeriod - 1)).toFixed(3),
    emaFastAboveSlow: ema(closes, p.emaFast) > ema(closes, p.emaSlow),
    bbZ: +(s === 0 ? 0 : (px - m) / s).toFixed(2),
    ruleRegime: ruleRegime(bars, p).regime,
    recentTrades: recentTrades.slice(-5),
    pnlTodayUsd: +pnlTodayUsd.toFixed(4),
  };
}

const SYSTEM = `You are the regime supervisor of a small autonomous SOL/USDC spot trading agent on Solana.
A fast rule engine trades on its own every tick; you run every ~10 minutes and set its mode:
- "trend": breakout long entries (price > recent high + k*ATR while EMA fast > slow), ATR take-profit and trailing stop.
- "range": mean-reversion long entries below the Bollinger lower band, exit at the mean.
- "halt": no new entries (open positions keep their exits).
It is long-only spot with ~10 USDC and ~0.2% round-trip cost, so small edges are not worth taking; when unsure, prefer "halt".
Set pause_trading=true only for clearly abnormal conditions (extreme volatility, broken data, a losing streak).
param_patch: return null for every field you do not want to change. Allowed ranges: ${JSON.stringify(PARAM_BOUNDS)}.
Keep reasoning to 2-4 sentences, citing the numbers you used.`;

export class Brain {
  client: Anthropic | null;
  constructor(public model = process.env.LLM_MODEL ?? "claude-opus-5-5") {
    this.client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;
  }

  rules(snap: Snapshot, t0: number, note: string): BrainDecisionT {
    return {
      regime: snap.ruleRegime, pause_trading: false,
      param_patch: { breakoutLookback: null, breakoutAtrK: null, tpAtr: null, trailAtr: null, bbEntry: null, bbStop: null },
      confidence: 0.5, reasoning: `${note} Rule regime: ER30=${snap.er30}, ATR=${snap.atrPct}% -> ${snap.ruleRegime}.`,
      source: "rules", latencyMs: performance.now() - t0, snapshot: snap,
    };
  }

  async decide(snap: Snapshot): Promise<BrainDecisionT> {
    const t0 = performance.now();
    if (!this.client) return this.rules(snap, t0, "No LLM key configured.");
    try {
      const res = await this.client.messages.parse({
        model: this.model,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: "low", format: zodOutputFormat(BrainDecision) },
        messages: [{ role: "user", content: `Market snapshot (1-minute bars, SOL/USD):\n${JSON.stringify(snap, null, 2)}` }],
      }, { timeout: 60_000 });
      if (res.stop_reason === "refusal" || !res.parsed_output) {
        return this.rules(snap, t0, `LLM returned no decision (${res.stop_reason}).`);
      }
      return { ...res.parsed_output, source: "llm", model: this.model, latencyMs: performance.now() - t0, snapshot: snap };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return this.rules(snap, t0, "LLM rate-limited.");
      if (e instanceof Anthropic.APIError) return this.rules(snap, t0, `LLM API error ${e.status}.`);
      return this.rules(snap, t0, `LLM unreachable: ${(e as Error).message}.`);
    }
  }
}
