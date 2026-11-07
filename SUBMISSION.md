# MLH Solana Hackathon submission: SolSentinel

## Project name
SolSentinel

## Tagline (one line)
An autonomous AI trading agent whose risk limits are enforced by a Solana program, so a prompt-injected AI can't drain your wallet.

## What it does
SolSentinel trades SOL/USDC on its own. A fast rule engine reads prices straight from the Orca SOL/USDC Whirlpool and the Pyth oracle on-chain, and turns a signal into a signed transaction in about 20 ms. Claude supervises it every 10 minutes: it picks the market regime (trend, range or halt) and can nudge parameters within hard bounds, but it never places orders itself.

The funds live in the **Sentinel Vault**, an Anchor program. The agent key can trade through it but cannot withdraw. Every swap is a CPI to one whitelisted swap program (Jupiter on mainnet), signed by the vault PDA. The vault enforces a per-trade cap, a cooldown, trades per day, a slippage floor and a daily-loss circuit breaker. It works out the real fill from its own token balances before and after the CPI, so the agent can't misreport it. Every AI decision is hashed (sha256 of the full reasoning) and written on-chain with `log_decision` in the same transaction as the trade. The owner can pause the vault at any time, and selling stays allowed while paused, so the kill switch flattens risk instead of trapping it.

The demo plays a compromised agent trying to drain the vault: withdraw to an attacker, all-in buy, route through a different program, accept a terrible fill, rapid-fire trades. Every attempt is rejected on-chain.

## How we built it
- **On-chain:** Anchor 1.2 (Rust). `sentinel_vault` (policy, CPI guard, balance-delta accounting, decision log) and `mock_swap` (devnet/localnet stand-in for Jupiter, priced from live mainnet data). 11 integration tests run against `solana-test-validator`.
- **Agent:** TypeScript, `@solana/web3.js`, `@anchor-lang/core`.
  - Price feed: one `getMultipleAccounts` call reads the Orca Whirlpool `sqrt_price` and the Pyth `PriceUpdateV2`.
  - Strategy: a pure dual-mode function (breakout / mean reversion) with ATR exits, shared byte-for-byte by the backtester and the live loop.
  - Execution: priority fees, `skipPreflight`, and the decision log, price post and guarded swap packed into a single transaction.
- **AI:** Claude via the Anthropic SDK with structured outputs (Zod schema → `messages.parse`). Parameter patches are clamped to declared bounds. It falls back to the rule-based regime on any error.
- **Data and evaluation:** a 7-day 1-minute replay backtester with pessimistic intra-bar ordering, plus a walk-forward split (tune on 5 days, test on 2).
- **Dashboard:** a single HTML page showing live candles, trigger levels, fills, vault state, latency and the AI decision log with explorer links.

## Measured results
- Tick → signed transaction sent: **18–22 ms**. Sent → confirmed: **196–335 ms** (local validator).
- Backtest, last 7 days: **−0.97%** vs. **−5.4%** buy-and-hold. Out-of-sample last 2 days: **−0.09%** vs. **−6.1%**. We report the losing numbers on purpose. The grid-tuned parameters did worse out of sample, so we ship the defaults.

## Challenges
- An LLM is far too slow for the order path. We split the agent into a slow brain (regime and bounds) and a fast brain (precomputed levels, compare-only per tick).
- We wanted the agent unable to lie about fills. The vault ignores the agent's numbers and measures its own token balances around the CPI.
- Jupiter has no devnet liquidity. We built a small mock AMM that the vault treats exactly like Jupiter (same CPI path), priced from the live mainnet pool.
- The Pyth sponsored feed only updates every few seconds. We switched the tick source to the Orca pool account, which changes every slot it trades, and kept Pyth as an oracle deviation guard.

## What's next
Mainnet run with 10 USDC through Jupiter, Jito bundles, an unrealized-loss check using an on-chain Pyth read inside `swap`, a perps venue for shorts, and a Blink so the owner can pause or withdraw from any wallet.

## Tracks
Top 3 Overall, AI Track, DeFi Track, Best Beginner Hack (first Solana hackathon).

## Built with
solana, anchor, rust, typescript, jupiter, pyth, orca, claude, anthropic-sdk, zod
