// Claude as the risk reviewer of the yield router. The deterministic router (router.ts) proposes; Claude may
// APPROVE the proposal or VETO it (hold where we are / move to idle USDC) when it sees risk the numbers miss,
// e.g. a rate spike that looks like a one-day anomaly or utilization near 100% (withdrawals could get stuck).
// Claude can never pick a venue the router did not propose, and the on-chain vault enforces the rest.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { RouterDecision, VenueRates } from "./router.js";

export const Review = z.object({
  verdict: z.enum(["approve", "hold", "exit_to_idle"]),
  confidence: z.number(),
  reasoning: z.string(),
});
export type ReviewT = z.infer<typeof Review> & { source: "llm" | "rules"; model?: string; latencyMs: number };

export interface YieldSnapshot {
  ts: string; navUsd: number; current: string; proposal: RouterDecision; venues: (VenueRates & { utilizationPct?: number })[];
  switchCostUsd: number; recentDecisions: { ts: string; action: string; reason: string }[];
}

const SYSTEM = `You review the decisions of an autonomous stablecoin yield router on Solana.
The vault holds USDC and may only park it in two whitelisted lending venues (Jupiter Lend Earn USDC, Kamino Lend main-market USDC) or keep it idle.
A deterministic rule proposes a move: switch to the venue with the best trailing-7-day realized yield only when the 14-day expected gain exceeds the transaction cost.
You answer with one verdict:
- "approve": carry out the proposal (also use this when the proposal is to stay put and that is fine),
- "hold": do not move this time (e.g. the edge rests on a one-day spike, or data looks broken),
- "exit_to_idle": withdraw everything to idle USDC because a venue looks unsafe (utilization ~100%, rate collapse, broken data).
Moving costs money and idle USDC earns nothing, so approve unless you see a concrete risk. Cite the numbers in 2-4 sentences.`;

export class YieldBrain {
  client: Anthropic | null;
  constructor(public model = process.env.LLM_MODEL ?? "claude-opus-5-5") {
    this.client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;
  }
  async review(snap: YieldSnapshot): Promise<ReviewT> {
    const t0 = performance.now();
    const rules = (note: string): ReviewT => ({ verdict: "approve", confidence: 0.5, reasoning: `${note} Rule proposal stands: ${snap.proposal.reason}.`, source: "rules", latencyMs: performance.now() - t0 });
    if (!this.client) return rules("No LLM key configured.");
    try {
      const res = await this.client.messages.parse({
        model: this.model, max_tokens: 3000, system: SYSTEM,
        output_config: { effort: "low", format: zodOutputFormat(Review) },
        messages: [{ role: "user", content: `Router state:\n${JSON.stringify(snap, null, 2)}` }],
      }, { timeout: 60_000 });
      if (res.stop_reason === "refusal" || !res.parsed_output) return rules(`LLM returned no decision (${res.stop_reason}).`);
      return { ...res.parsed_output, source: "llm", model: this.model, latencyMs: performance.now() - t0 };
    } catch (e) {
      if (e instanceof Anthropic.APIError) return rules(`LLM API error ${e.status}.`);
      return rules(`LLM unreachable: ${(e as Error).message}.`);
    }
  }
}
