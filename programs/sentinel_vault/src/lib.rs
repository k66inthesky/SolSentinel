//! Sentinel Vault: an on-chain risk guard for an autonomous trading agent.
//!
//! The owner deposits USDC into a PDA-owned vault and hands an *agent key* the right to trade.
//! The agent key can never withdraw. Every swap goes through `swap`, which:
//!   1. checks the policy (pause flag, per-trade cap, cooldown, daily trade count, daily loss halt),
//!   2. CPIs into ONE whitelisted swap program (Jupiter on mainnet, a mock AMM on localnet/devnet),
//!      signing as the vault PDA,
//!   3. measures the vault's real token balance deltas around the CPI, so the agent cannot
//!      lie about what it spent or received,
//!   4. books realized PnL on sells and auto-halts new buys once the daily loss limit is hit.
//! Sells are allowed even while paused/halted: a kill switch should flatten risk, not trap it.
//!
//! The agent also writes every AI decision (regime, action, sha256 of the LLM's reasoning)
//! with `log_decision`, giving a tamper-evident audit trail of *why* each trade happened.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("6TL13uSNzjJhG48LheLAZJei4M62rEe4peaj9GASECKu");

pub const VAULT_SEED: &[u8] = b"vault";
const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod sentinel_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        agent: Pubkey,
        swap_program: Pubkey,
        policy: Policy,
    ) -> Result<()> {
        policy.validate()?;
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.agent = agent;
        v.quote_mint = ctx.accounts.quote_mint.key();
        v.base_mint = ctx.accounts.base_mint.key();
        v.swap_program = swap_program;
        v.policy = policy;
        v.paused = false;
        v.bump = ctx.bumps.vault;
        v.day = Clock::get()?.unix_timestamp / SECONDS_PER_DAY;
        v.last_trade_ts = 0;
        emit!(VaultInitialized { vault: v.key(), owner: v.owner, agent, swap_program });
        Ok(())
    }

    pub fn set_policy(ctx: Context<OwnerOnly>, policy: Policy) -> Result<()> {
        policy.validate()?;
        ctx.accounts.vault.policy = policy;
        emit!(PolicyUpdated { vault: ctx.accounts.vault.key(), policy });
        Ok(())
    }

    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PauseChanged { vault: ctx.accounts.vault.key(), paused });
        Ok(())
    }

    pub fn set_agent(ctx: Context<OwnerOnly>, agent: Pubkey) -> Result<()> {
        ctx.accounts.vault.agent = agent;
        Ok(())
    }

    /// Owner-only withdrawal. The agent key has no path to move funds out of the vault.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let v = &ctx.accounts.vault;
        // The owner may pull ANY token the vault owns (USDC, SOL leg, or lending receipt tokens).
        let mint = ctx.accounts.from.mint;
        let owner = v.owner;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[v.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        if mint == ctx.accounts.vault.base_mint {
            // Withdrawing base removes its cost basis proportionally (no PnL booked).
            let pre = ctx.accounts.from.amount;
            let v = &mut ctx.accounts.vault;
            if pre > 0 {
                let removed = (v.open_cost as u128 * amount as u128 / pre as u128) as u64;
                v.open_cost = v.open_cost.saturating_sub(removed);
            }
        }
        Ok(())
    }

    /// Append an AI decision to the on-chain audit log. `reason_hash` = sha256 of the full
    /// LLM/strategy reasoning JSON that the agent stores off-chain; anyone can re-hash and verify.
    pub fn log_decision(
        ctx: Context<AgentOnly>,
        regime: u8,
        action: u8,
        price_e6: u64,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.decisions = v.decisions.checked_add(1).unwrap();
        v.last_decision_hash = reason_hash;
        emit!(DecisionLogged {
            vault: v.key(),
            seq: v.decisions,
            regime,
            action,
            price_e6,
            reason_hash,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Guarded swap. `cpi_data` and `remaining_accounts` are passed verbatim to the whitelisted
    /// swap program; the vault PDA signs. The program trusts nothing the agent claims about
    /// amounts: it reads token balances before and after the CPI.
    pub fn swap<'info>(
        ctx: Context<'info, Swap<'info>>,
        side: Side,
        max_in: u64,
        min_out: u64,
        cpi_data: Vec<u8>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault_key = ctx.accounts.vault.key();

        // --- policy checks (before) ---
        {
            let v = &mut ctx.accounts.vault;
            v.roll_day(now);
            if side == Side::Buy {
                require!(!v.paused, SentinelError::Paused);
                require!(v.halted_day != v.day, SentinelError::DailyLossHalt);
                require!(max_in <= v.policy.max_trade_quote, SentinelError::TradeTooLarge);
                require!(v.trades_today < v.policy.max_trades_per_day, SentinelError::TooManyTrades);
                require!(
                    now - v.last_trade_ts >= v.policy.cooldown_secs as i64,
                    SentinelError::Cooldown
                );
            }
        }
        require_keys_eq!(ctx.accounts.swap_program.key(), ctx.accounts.vault.swap_program, SentinelError::SwapProgramNotAllowed);

        let (in_acc, out_acc) = match side {
            Side::Buy => (&ctx.accounts.vault_quote, &ctx.accounts.vault_base),
            Side::Sell => (&ctx.accounts.vault_base, &ctx.accounts.vault_quote),
        };
        let pre_in = in_acc.amount;
        let pre_out = out_acc.amount;
        let pre_base = ctx.accounts.vault_base.amount;
        require!(pre_in >= max_in, SentinelError::InsufficientFunds);

        // --- CPI into the whitelisted swap program, vault PDA signs ---
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.key() == vault_key || a.is_signer,
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction { program_id: ctx.accounts.swap_program.key(), accounts: metas, data: cpi_data };
        let owner = ctx.accounts.vault.owner;
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.swap_program.to_account_info());
        invoke_signed(&ix, &infos, &[seeds])?;

        // --- measure what really happened ---
        ctx.accounts.vault_quote.reload()?;
        ctx.accounts.vault_base.reload()?;
        let (post_in, post_out) = match side {
            Side::Buy => (ctx.accounts.vault_quote.amount, ctx.accounts.vault_base.amount),
            Side::Sell => (ctx.accounts.vault_base.amount, ctx.accounts.vault_quote.amount),
        };
        let spent = pre_in.checked_sub(post_in).ok_or(SentinelError::BalanceMismatch)?;
        let received = post_out.checked_sub(pre_out).ok_or(SentinelError::BalanceMismatch)?;
        require!(spent <= max_in, SentinelError::OverSpent);
        require!(received >= min_out, SentinelError::Slippage);

        // --- accounting ---
        let v = &mut ctx.accounts.vault;
        let mut pnl: i64 = 0;
        match side {
            Side::Buy => {
                v.open_cost = v.open_cost.checked_add(spent).unwrap();
                v.trades_today += 1;
            }
            Side::Sell => {
                let cost_part = if pre_base == 0 { 0 } else {
                    (v.open_cost as u128 * spent as u128 / pre_base as u128) as u64
                };
                v.open_cost = v.open_cost.saturating_sub(cost_part);
                pnl = received as i64 - cost_part as i64;
                v.realized_pnl_today += pnl;
                v.total_realized_pnl += pnl;
                if v.realized_pnl_today <= -(v.policy.daily_loss_limit_quote as i64) {
                    v.halted_day = v.day;
                    emit!(DailyLossHaltTriggered { vault: v.key(), day: v.day, realized_pnl_today: v.realized_pnl_today });
                }
            }
        }
        v.last_trade_ts = now;
        v.total_trades += 1;
        emit!(TradeExecuted {
            vault: v.key(),
            side,
            spent,
            received,
            realized_pnl: pnl,
            realized_pnl_today: v.realized_pnl_today,
            decision_seq: v.decisions,
            ts: now,
        });
        Ok(())
    }
    /// Owner closes an EMPTY vault-owned token account (e.g. a receipt-token ATA of a retired venue);
    /// the rent comes back to the owner, so opening venue accounts is a refundable deposit, not a cost.
    pub fn close_token(ctx: Context<CloseToken>) -> Result<()> {
        let owner = ctx.accounts.vault.owner;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[ctx.accounts.vault.bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token::CloseAccount {
                account: ctx.accounts.account.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ))
    }

    /// Owner closes the yield config and then the vault itself (all vault token accounts must be closed first),
    /// returning every lamport of rent: the whole setup is refundable.
    pub fn close_yield(_ctx: Context<CloseYield>) -> Result<()> { Ok(()) }
    pub fn close_vault(_ctx: Context<CloseVault>) -> Result<()> { Ok(()) }

    // ======================= yield router =======================

    /// Owner whitelists up to 4 lending venues: (lending program, receipt-token mint).
    pub fn init_yield(ctx: Context<InitYield>, venues: Vec<Venue>, max_moves_per_day: u16, min_move_interval_secs: u32) -> Result<()> {
        require!(venues.len() <= MAX_VENUES && max_moves_per_day > 0, SentinelError::BadPolicy);
        let y = &mut ctx.accounts.yield_config;
        y.vault = ctx.accounts.vault.key();
        y.venues = venues;
        y.max_moves_per_day = max_moves_per_day;
        y.min_move_interval_secs = min_move_interval_secs;
        y.bump = ctx.bumps.yield_config;
        Ok(())
    }

    pub fn set_yield(ctx: Context<SetYield>, venues: Vec<Venue>, max_moves_per_day: u16, min_move_interval_secs: u32) -> Result<()> {
        require!(venues.len() <= MAX_VENUES && max_moves_per_day > 0, SentinelError::BadPolicy);
        let y = &mut ctx.accounts.yield_config;
        y.venues = venues;
        y.max_moves_per_day = max_moves_per_day;
        y.min_move_interval_secs = min_move_interval_secs;
        Ok(())
    }

    /// Guarded move of USDC into (Deposit) or out of (Withdraw) a whitelisted lending venue.
    /// The agent supplies the CPI bytes, but the program enforces:
    ///  - the target program is the venue's whitelisted lending program,
    ///  - tokens can only move between the vault's USDC account and the vault's receipt-token
    ///    account for that venue (both PDA-owned ATAs, so nothing can leave the vault),
    ///  - measured balance deltas respect max_in / min_out (agent cannot lie about amounts),
    ///  - a rate limit (moves per day + minimum interval) so a compromised agent cannot churn fees,
    ///  - deposits are blocked while paused; withdrawals back to USDC are always allowed.
    pub fn rebalance<'info>(
        ctx: Context<'info, Rebalance<'info>>,
        venue: u8,
        direction: Direction,
        max_in: u64,
        min_out: u64,
        cpi_data: Vec<u8>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault_key = ctx.accounts.vault.key();
        let v = ctx.accounts.venue_of(venue)?;
        require_keys_eq!(ctx.accounts.lending_program.key(), v.program, SentinelError::SwapProgramNotAllowed);
        require_keys_eq!(ctx.accounts.vault_receipt.mint, v.receipt_mint, SentinelError::MintNotAllowed);
        {
            let y = &mut ctx.accounts.yield_config;
            let d = now / SECONDS_PER_DAY;
            if d != y.day { y.day = d; y.moves_today = 0; }
            require!(y.moves_today < y.max_moves_per_day, SentinelError::TooManyTrades);
            require!(now - y.last_move_ts >= y.min_move_interval_secs as i64, SentinelError::Cooldown);
            if direction == Direction::Deposit {
                require!(!ctx.accounts.vault.paused, SentinelError::Paused);
            }
        }
        let (pre_in, pre_out) = match direction {
            Direction::Deposit => (ctx.accounts.vault_quote.amount, ctx.accounts.vault_receipt.amount),
            Direction::Withdraw => (ctx.accounts.vault_receipt.amount, ctx.accounts.vault_quote.amount),
        };
        require!(pre_in >= max_in, SentinelError::InsufficientFunds);

        let metas: Vec<AccountMeta> = ctx.remaining_accounts.iter().map(|a| AccountMeta {
            pubkey: a.key(),
            is_signer: a.key() == vault_key || a.is_signer,
            is_writable: a.is_writable,
        }).collect();
        let ix = Instruction { program_id: v.program, accounts: metas, data: cpi_data };
        let owner = ctx.accounts.vault.owner;
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.lending_program.to_account_info());
        infos.push(ctx.accounts.vault.to_account_info());
        invoke_signed(&ix, &infos, &[seeds])?;

        ctx.accounts.vault_quote.reload()?;
        ctx.accounts.vault_receipt.reload()?;
        let (post_in, post_out) = match direction {
            Direction::Deposit => (ctx.accounts.vault_quote.amount, ctx.accounts.vault_receipt.amount),
            Direction::Withdraw => (ctx.accounts.vault_receipt.amount, ctx.accounts.vault_quote.amount),
        };
        let spent = pre_in.checked_sub(post_in).ok_or(SentinelError::BalanceMismatch)?;
        let received = post_out.checked_sub(pre_out).ok_or(SentinelError::BalanceMismatch)?;
        require!(spent <= max_in, SentinelError::OverSpent);
        require!(received >= min_out, SentinelError::Slippage);

        let y = &mut ctx.accounts.yield_config;
        y.moves_today += 1;
        y.last_move_ts = now;
        y.total_moves += 1;
        emit!(Rebalanced { vault: vault_key, venue, direction, spent, received, decision_seq: ctx.accounts.vault.decisions, ts: now });
        Ok(())
    }
}

// ---------------- state ----------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq)]
pub struct Policy {
    /// Max quote (USDC base units) per buy.
    pub max_trade_quote: u64,
    pub max_trades_per_day: u16,
    /// Realized loss (USDC base units) per UTC day that halts new buys.
    pub daily_loss_limit_quote: u64,
    pub cooldown_secs: u32,
}

impl Policy {
    fn validate(&self) -> Result<()> {
        require!(self.max_trade_quote > 0, SentinelError::BadPolicy);
        require!(self.max_trades_per_day > 0, SentinelError::BadPolicy);
        require!(self.daily_loss_limit_quote > 0, SentinelError::BadPolicy);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side { Buy, Sell }

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub quote_mint: Pubkey,
    pub base_mint: Pubkey,
    pub swap_program: Pubkey,
    pub policy: Policy,
    pub paused: bool,
    pub bump: u8,
    pub day: i64,
    pub halted_day: i64,
    pub trades_today: u16,
    pub realized_pnl_today: i64,
    pub last_trade_ts: i64,
    pub open_cost: u64,
    pub total_trades: u64,
    pub total_realized_pnl: i64,
    pub decisions: u64,
    pub last_decision_hash: [u8; 32],
}

impl Vault {
    fn roll_day(&mut self, now: i64) {
        let d = now / SECONDS_PER_DAY;
        if d != self.day {
            self.day = d;
            self.trades_today = 0;
            self.realized_pnl_today = 0;
        }
    }
}

// ---------------- accounts ----------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub quote_mint: Account<'info, Mint>,
    pub base_mint: Account<'info, Mint>,
    #[account(init, payer = owner, associated_token::mint = quote_mint, associated_token::authority = vault)]
    pub vault_quote: Account<'info, TokenAccount>,
    #[account(init, payer = owner, associated_token::mint = base_mint, associated_token::authority = vault)]
    pub vault_base: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, token::authority = vault)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AgentOnly<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = agent)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = agent)]
    pub vault: Account<'info, Vault>,
    #[account(mut, associated_token::mint = vault.quote_mint, associated_token::authority = vault)]
    pub vault_quote: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = vault.base_mint, associated_token::authority = vault)]
    pub vault_base: Account<'info, TokenAccount>,
    /// CHECK: compared against vault.swap_program in the handler.
    pub swap_program: UncheckedAccount<'info>,
}


pub const MAX_VENUES: usize = 4;
pub const YIELD_SEED: &[u8] = b"yield";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Direction { Deposit, Withdraw }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Venue {
    /// Lending program the vault may CPI into (e.g. Jupiter Lend Earn, Kamino Lend).
    pub program: Pubkey,
    /// Receipt token that program mints for USDC deposits (e.g. jlUSDC, Kamino USDC cToken).
    pub receipt_mint: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct YieldConfig {
    pub vault: Pubkey,
    #[max_len(4)]
    pub venues: Vec<Venue>,
    pub max_moves_per_day: u16,
    pub min_move_interval_secs: u32,
    pub day: i64,
    pub moves_today: u16,
    pub last_move_ts: i64,
    pub total_moves: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CloseToken<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, token::authority = vault)]
    pub account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseYield<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, close = owner, seeds = [YIELD_SEED, vault.key().as_ref()], bump = yield_config.bump, has_one = vault)]
    pub yield_config: Account<'info, YieldConfig>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct InitYield<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = owner, space = 8 + YieldConfig::INIT_SPACE, seeds = [YIELD_SEED, vault.key().as_ref()], bump)]
    pub yield_config: Account<'info, YieldConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetYield<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [YIELD_SEED, vault.key().as_ref()], bump = yield_config.bump, has_one = vault)]
    pub yield_config: Account<'info, YieldConfig>,
}

#[derive(Accounts)]
pub struct Rebalance<'info> {
    pub agent: Signer<'info>,
    #[account(has_one = agent)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [YIELD_SEED, vault.key().as_ref()], bump = yield_config.bump, has_one = vault)]
    pub yield_config: Account<'info, YieldConfig>,
    #[account(mut, associated_token::mint = vault.quote_mint, associated_token::authority = vault)]
    pub vault_quote: Account<'info, TokenAccount>,
    /// Receipt-token account; must be owned by the vault, mint checked against the venue.
    #[account(mut, token::authority = vault)]
    pub vault_receipt: Account<'info, TokenAccount>,
    /// CHECK: compared against the venue's whitelisted program in the handler.
    pub lending_program: UncheckedAccount<'info>,
}

impl<'info> Rebalance<'info> {
    fn venue_of(&self, i: u8) -> Result<Venue> {
        self.yield_config.venues.get(i as usize).copied().ok_or(error!(SentinelError::SwapProgramNotAllowed))
    }
}

#[event]
pub struct Rebalanced { pub vault: Pubkey, pub venue: u8, pub direction: Direction, pub spent: u64, pub received: u64, pub decision_seq: u64, pub ts: i64 }

// ---------------- events & errors ----------------

#[event]
pub struct VaultInitialized { pub vault: Pubkey, pub owner: Pubkey, pub agent: Pubkey, pub swap_program: Pubkey }
#[event]
pub struct PolicyUpdated { pub vault: Pubkey, pub policy: Policy }
#[event]
pub struct PauseChanged { pub vault: Pubkey, pub paused: bool }
#[event]
pub struct DecisionLogged { pub vault: Pubkey, pub seq: u64, pub regime: u8, pub action: u8, pub price_e6: u64, pub reason_hash: [u8; 32], pub ts: i64 }
#[event]
pub struct TradeExecuted { pub vault: Pubkey, pub side: Side, pub spent: u64, pub received: u64, pub realized_pnl: i64, pub realized_pnl_today: i64, pub decision_seq: u64, pub ts: i64 }
#[event]
pub struct DailyLossHaltTriggered { pub vault: Pubkey, pub day: i64, pub realized_pnl_today: i64 }

#[error_code]
pub enum SentinelError {
    #[msg("Vault is paused by its owner")] Paused,
    #[msg("Daily loss limit hit; new buys halted until next UTC day")] DailyLossHalt,
    #[msg("Trade exceeds per-trade cap")] TradeTooLarge,
    #[msg("Daily trade count reached")] TooManyTrades,
    #[msg("Cooldown between trades not elapsed")] Cooldown,
    #[msg("Swap program is not the whitelisted one")] SwapProgramNotAllowed,
    #[msg("Vault balance too low")] InsufficientFunds,
    #[msg("Token balance moved the wrong way")] BalanceMismatch,
    #[msg("Swap spent more than max_in")] OverSpent,
    #[msg("Received less than min_out")] Slippage,
    #[msg("Mint not allowed")] MintNotAllowed,
    #[msg("Invalid policy")] BadPolicy,
}
