// Off-chain mirror of the on-chain vault policy. The vault program is the source of truth;
// this lets the agent skip trades the vault would reject anyway (saves fees and latency).

export interface Policy {
  maxTradeUsd: number;      // per-trade notional cap
  maxTradesPerDay: number;
  dailyLossLimitUsd: number;
  cooldownMs: number;
}

export const DEFAULT_POLICY: Policy = {
  maxTradeUsd: 5,
  maxTradesPerDay: 20,
  dailyLossLimitUsd: 0.5,
  cooldownMs: 60_000,
};

export class RiskGate {
  day = -1;
  tradesToday = 0;
  pnlToday = 0;
  lastTradeTs = -Infinity;
  constructor(public policy: Policy) {}

  private roll(ts: number) {
    const d = Math.floor(ts / 86_400_000);
    if (d !== this.day) { this.day = d; this.tradesToday = 0; this.pnlToday = 0; }
  }

  canEnter(ts: number, notionalUsd: number): { ok: boolean; why?: string } {
    this.roll(ts);
    if (notionalUsd > this.policy.maxTradeUsd + 1e-9) return { ok: false, why: "max-trade-size" };
    if (this.tradesToday >= this.policy.maxTradesPerDay) return { ok: false, why: "daily-trade-count" };
    if (-this.pnlToday >= this.policy.dailyLossLimitUsd) return { ok: false, why: "daily-loss-limit" };
    if (ts - this.lastTradeTs < this.policy.cooldownMs) return { ok: false, why: "cooldown" };
    return { ok: true };
  }

  recordEntry(ts: number) { this.roll(ts); this.tradesToday++; this.lastTradeTs = ts; }
  recordExit(ts: number, pnlUsd: number) { this.roll(ts); this.pnlToday += pnlUsd; this.lastTradeTs = ts; }
}
