# MLH Solana Hackathon submission: SolSentinel

## Project name
SolSentinel

## Tagline (one line)
An AI agent that earns stablecoin yield on its own, inside a Solana vault that won't let the AI do anything but move your USDC between whitelisted lending pools.

## What it does
You put USDC in the **Sentinel Vault**, an Anchor program. An autonomous agent parks it in the best Solana lending pool and moves it when another pool pays enough more to cover the switch. Today the pools are **Jupiter Lend Earn** and **Kamino Lend**.

- **Router:** a deterministic rule. Hold the venue with the best trailing 7-day realized yield. Switch only if the extra yield over 14 days pays for both transactions.
- **Claude:** reviews each proposal and can approve, hold, or pull everything back to idle USDC if a venue looks unsafe (for example, utilization near 100% or broken data). It can never pick a venue the router didn't propose.

The agent key can only call `rebalance`. The vault program enforces the rest on-chain:
- The CPI target must be a whitelisted lending program, signed by the vault PDA.
- Tokens can only move between the vault's own USDC account and its receipt-token account for that venue (jlUSDC or Kamino's cToken). Nothing can leave the vault.
- `max_in` and `min_out` are checked against measured balance deltas, so the agent can't misreport amounts.
- Moves per day and the minimum interval between moves are rate-limited, so a hijacked agent can't burn fees by churning.
- Deposits are blocked while the owner has paused the vault. Withdrawals back to USDC always work.
- Only the owner can withdraw. Every account can be closed and its rent refunded.

Every decision is hashed (sha256 of router input, proposal and Claude's review). The hash goes on-chain in the same transaction as the move.

## Is it actually profitable? (all costs counted)
We backtested the two exact venues the vault integrates, from 2026-02-27 to 2026-11-07 (230 days):
- Kamino's return is **realized** from its on-chain collateral exchange rate. Jupiter Lend's comes from its daily base APY; rewards are not counted.
- Decisions use only data up to the day before.
- Every cost is charged: 3 setup transactions, the first deposit, 2 transactions per switch, 6 closing transactions, and Kamino's rounding. Account rent is refunded on close, and we test that it comes back.

| Vault size | Router net APY | Static Jupiter Lend | Static Kamino | Worst 30-day window (router) |
|---|---|---|---|---|
| $10 | **4.10%** (+$0.26) | 3.72% | 4.20% | +2.28% annualized |
| $100 | **4.47%** | 3.86% | 4.35% | |
| $1000 | **4.51%** | 3.87% | 4.36% | |

All 200 rolling 30-day windows were positive. At $10, fixed fees eat most of the routing edge: the router beats Jupiter Lend but trails static Kamino by 0.1 percentage points. From $100 up, it beats both.

Before this, we tested short-horizon SOL trading strategies the same way: 303 configurations with costs, plus walk-forward and an ensemble. None was reliably profitable after costs, so we didn't ship one as a "money maker". The research is in the repo.

## How we built it
- **On-chain:** Anchor 1.2 (Rust).
  - `sentinel_vault` provides `rebalance` with a venue whitelist, measured deltas, rate limits, owner pause/withdraw and close instructions. It still has the earlier guarded `swap` for the trading agent.
  - **11 tests run on a local mainnet fork**: `solana-test-validator` clones the production Jupiter Lend Earn, Jupiter Liquidity and Kamino Lend programs and their USDC reserve accounts. The vault CPIs into the real lending code.
  - 11 more tests cover the swap guard.
- **Agent:** TypeScript, `@solana/web3.js`, `@anchor-lang/core`.
  - Jupiter Lend instructions are built with `@jup-ag/lend`. Kamino instructions are built by hand from the klend IDL: `refresh_reserve`, `deposit_reserve_liquidity`, `redeem_reserve_collateral`.
  - The vault is valued on-chain: Jupiter `convertToAssets`, and Kamino reserve supply ÷ collateral mint supply.
- **AI:** Claude through the Anthropic SDK with structured outputs (Zod schema → `messages.parse`). Without a key, or on any error, it falls back to the rule's proposal.
- **Data:** the Kamino API (exchange-rate history) and DefiLlama (Jupiter Lend APY) for the trailing rates.
- **Dashboard:** vault value, net PnL after every fee, allocation, venue yields, and the decision log with tx links.

## Challenges
- **Making "profitable" honest.** At $10, one transaction fee is about a day of interest. The router therefore prices every move. It never writes "hold" decisions on-chain, because that alone would cost more than the vault earns; their hashes stay in the journal. Setup rent is made refundable with close instructions.
- **Testing against real protocols without real money.** We forked mainnet locally: cloned programs, reserves and oracle accounts, with the owner's USDC balance injected into the fork's ledger. The same code then runs against mainnet unchanged.
- **Kamino's SDK uses `@solana/kit`; the agent uses web3.js v1.** We built Kamino instructions from the IDL and used the SDK only to decode the reserve.
- **A generic "CPI anything" vault is dangerous.** We pinned it down to program + receipt mint pairs and the vault's own accounts.

## What's next
Mainnet with real USDC: deploy the program and fund the vault. More venues (Drift, marginfi, Jupiter Lend JupUSD with a peg check). Utilization and withdrawal-liquidity checks on-chain. A Blink so the owner can pause or withdraw from any wallet.

## Tracks
Top 3 Overall, AI Track, DeFi Track, Best Beginner Hack (first Solana hackathon).

## Built with
solana, anchor, rust, typescript, jupiter-lend, kamino, claude, anthropic-sdk, zod, defillama
