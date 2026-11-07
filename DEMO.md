# Demo video script (about 2.5 minutes)

**Setup before recording** (two terminals plus a browser):
1. `npm run validator:fork` (a local mainnet fork with the real Jupiter Lend and Kamino programs)
2. `npm run yield:deploy -- --mode fork`, then `npm run yield -- --mode fork --decide-minutes 1 --tick-seconds 5`
3. Open http://localhost:8788
4. Keep `npm run test:fork` ready in a second terminal. Run it on a fresh fork (`scripts/restart-fork.sh`), because it uses the same owner key.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Dashboard | "Idle USDC earns nothing, and handing an AI your wallet is scary. SolSentinel is an AI yield agent that can only do one thing: move your USDC between whitelisted Solana lending pools, enforced by a Solana program." |
| 0:15 | Venue yields card | "It watches Jupiter Lend and Kamino. Kamino's yield is measured from its on-chain exchange rate. The router holds the best 7-day realized yield and only switches when 14 days of extra yield pays for the transactions." |
| 0:35 | Decision table | "Claude reviews every proposal and can approve, hold, or pull back to idle USDC if a pool looks unsafe. It can't invent a destination. Each decision is hashed, and the hash goes on-chain with the move." Click the tx link. |
| 0:55 | Allocation + value cards | "This is a mainnet fork: the real Jupiter Lend program took our 10 USDC and gave the vault jlUSDC. Net PnL counts every fee, including setup." |
| 1:15 | Terminal: `npm run test:fork` | "Now a compromised agent. A non-whitelisted program: rejected. Sending the receipt to the wrong account: rejected. Lying about min-out: rejected. Churning to burn fees: rate-limited. Depositing while paused: blocked, but withdrawing to safety still works. And it can never withdraw. Then the owner unwinds everything and gets every lamport of rent back." |
| 1:50 | SUBMISSION.md results table | "Is it profitable after all costs? Over 230 days on these exact two venues: 4.1% net at $10 and 4.5% at $1000. Every 30-day window was positive. We also tried short-term SOL trading strategies, and none survived costs, so we didn't ship one." |
| 2:15 | Repo | "Anchor program, mainnet-fork tests against real protocols, TypeScript agent with Claude. Thanks!" |
