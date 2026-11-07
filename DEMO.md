# Demo video script (about 2.5 minutes)

**Setup before recording** (three terminals plus a browser):
1. `npm run validator`
2. `npm run deploy:local`, then `npm run agent -- --mode local --profile demo`
3. Leave a third terminal free for `npm run demo:guard -- local`
4. Open http://localhost:8787. For a guaranteed trade on camera, use `--profile smoke` instead of `demo`.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Dashboard | "Autonomous trading agents are great until the AI gets tricked. SolSentinel is an AI trader whose risk limits are enforced by a Solana program, not by the AI's good behavior." |
| 0:15 | Price card, feed pill | "Prices come straight from chain: the Orca SOL/USDC pool every slot, cross-checked against Pyth, in one RPC call." |
| 0:30 | Brain decisions panel | "Claude is the slow brain. Every 10 minutes it picks the regime and can adjust parameters within hard bounds. It never places orders, and every decision is hashed and logged on-chain." |
| 0:50 | Levels panel, chart lines | "The fast brain precomputes trigger levels each minute and compares every tick against them, so no AI call sits in the order path." |
| 1:05 | Trades table, latency card | "Here's a trade: about 20 ms from tick to signed transaction, a few hundred ms to confirmation. The decision log, price and guarded swap are one atomic transaction." Click the tx link. |
| 1:25 | Vault panel | "The money sits in the Sentinel Vault, an Anchor program. Per-trade cap, cooldown, trades per day, slippage floor, daily-loss circuit breaker. The vault measures its own balances around the swap, so the agent can't misreport fills." |
| 1:45 | Terminal: `npm run demo:guard -- local` | "Now pretend the LLM was prompt-injected and told to drain the vault. Withdraw: blocked. All-in buy: blocked. Swap through another program: blocked. Bad fill: blocked. Rapid fire: blocked. One small trade inside the policy is all it gets." |
| 2:10 | README backtest table | "We're honest about the strategy: over the last week it lost 1% while SOL fell 5 to 6%. The point isn't a magic strategy. It's a system you can safely hand an autonomous strategy." |
| 2:25 | Repo | "Anchor program, 11 passing tests, TypeScript agent, open source. Thanks!" |
