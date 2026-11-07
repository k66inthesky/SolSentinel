//! Mock constant-price AMM for localnet/devnet ONLY.
//!
//! Jupiter has no liquidity on devnet, so the Sentinel Vault's guarded-swap path is exercised
//! against this pool instead. The pool admin (the demo keeper) posts the live mainnet Pyth
//! SOL/USD price before each fill, and the pool charges a fee, so fills approximate real ones.
//! On mainnet the vault whitelists Jupiter instead and this program is not used.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HGsqvWLXJHuQnVdhvd2aXYRYhziHVEJsi8bacLg6bomo");

#[program]
pub mod mock_swap {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>, price_e6: u64, fee_bps: u16, keeper: Pubkey) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        p.admin = keeper; // the price keeper allowed to call set_price
        p.base_mint = ctx.accounts.base_mint.key();
        p.quote_mint = ctx.accounts.quote_mint.key();
        p.price_e6 = price_e6;
        p.fee_bps = fee_bps;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price_e6: u64) -> Result<()> {
        ctx.accounts.pool.price_e6 = price_e6;
        Ok(())
    }

    /// buy = quote -> base. `amount_in` in the input token's base units.
    pub fn swap(ctx: Context<SwapCtx>, amount_in: u64, buy: bool) -> Result<()> {
        let p = &ctx.accounts.pool;
        let base_dec = ctx.accounts.base_mint.decimals as u32;
        let quote_dec = ctx.accounts.quote_mint.decimals as u32;
        let fee = 10_000u128 - p.fee_bps as u128;
        // price_e6 = quote units (1e6 scale, USD) per 1 whole base token
        let out: u64 = if buy {
            let num = amount_in as u128 * 10u128.pow(base_dec) * 1_000_000 * fee;
            (num / (p.price_e6 as u128 * 10u128.pow(quote_dec) * 10_000)) as u64
        } else {
            let num = amount_in as u128 * p.price_e6 as u128 * 10u128.pow(quote_dec) * fee;
            (num / (10u128.pow(base_dec) * 1_000_000 * 10_000)) as u64
        };
        require!(out > 0, MockError::ZeroOut);

        token::transfer(
            CpiContext::new(ctx.accounts.token_program.key(), Transfer {
                from: ctx.accounts.user_in.to_account_info(),
                to: ctx.accounts.pool_in.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            amount_in,
        )?;
        let (bm, qm, bump) = (p.base_mint, p.quote_mint, p.bump);
        let seeds: &[&[u8]] = &[b"pool", bm.as_ref(), qm.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), Transfer {
                from: ctx.accounts.pool_out.to_account_info(),
                to: ctx.accounts.user_out.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            }, &[seeds]),
            out,
        )?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub price_e6: u64,
    pub fee_bps: u16,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(init, payer = payer, associated_token::mint = base_mint, associated_token::authority = pool)]
    pub pool_base: Account<'info, TokenAccount>,
    #[account(init, payer = payer, associated_token::mint = quote_mint, associated_token::authority = pool)]
    pub pool_quote: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SwapCtx<'info> {
    pub user: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(address = pool.base_mint)]
    pub base_mint: Account<'info, Mint>,
    #[account(address = pool.quote_mint)]
    pub quote_mint: Account<'info, Mint>,
    #[account(mut, token::authority = user)]
    pub user_in: Account<'info, TokenAccount>,
    #[account(mut, token::authority = user)]
    pub user_out: Account<'info, TokenAccount>,
    #[account(mut, token::authority = pool)]
    pub pool_in: Account<'info, TokenAccount>,
    #[account(mut, token::authority = pool)]
    pub pool_out: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum MockError {
    #[msg("Output rounds to zero")] ZeroOut,
}
