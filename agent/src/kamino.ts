// Kamino Lend (KLend) USDC reserve, main market. Instructions are built by hand from the klend IDL so the agent
// stays on web3.js v1. Deposit = deposit_reserve_liquidity (USDC -> kUSDC collateral token, no obligation/borrowing),
// withdraw = redeem_reserve_collateral (kUSDC -> USDC). Both need refresh_reserve earlier in the same transaction.
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { USDC_MINT } from "./jlend.js";

export const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const K_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
export const K_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
export const K_USDC_SUPPLY = new PublicKey("Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6");
export const K_USDC_CMINT = new PublicKey("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");
export const K_SCOPE_PRICES = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
export const K_MARKET_AUTH = PublicKey.findProgramAddressSync([Buffer.from("lma"), K_MARKET.toBuffer()], KLEND_PROGRAM)[0];

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

export function kaminoRefreshIx(): TransactionInstruction {
  return new TransactionInstruction({ programId: KLEND_PROGRAM, data: disc("refresh_reserve"), keys: [
    m(K_USDC_RESERVE, true), m(K_MARKET), m(KLEND_PROGRAM), m(KLEND_PROGRAM), m(KLEND_PROGRAM), m(K_SCOPE_PRICES)] });
}

/** The lending instruction the vault CPIs into (vault PDA = owner/signer). */
export function kaminoIx(vault: PublicKey, dir: "deposit" | "withdraw", amount: bigint): TransactionInstruction {
  const usdc = getAssociatedTokenAddressSync(USDC_MINT, vault, true), k = getAssociatedTokenAddressSync(K_USDC_CMINT, vault, true);
  const tail = [m(TOKEN_PROGRAM_ID), m(TOKEN_PROGRAM_ID), m(SYSVAR_INSTRUCTIONS_PUBKEY)];
  if (dir === "deposit") return new TransactionInstruction({ programId: KLEND_PROGRAM, data: Buffer.concat([disc("deposit_reserve_liquidity"), u64(amount)]), keys: [
    m(vault, false, true), m(K_USDC_RESERVE, true), m(K_MARKET), m(K_MARKET_AUTH), m(USDC_MINT), m(K_USDC_SUPPLY, true), m(K_USDC_CMINT, true), m(usdc, true), m(k, true), ...tail] });
  return new TransactionInstruction({ programId: KLEND_PROGRAM, data: Buffer.concat([disc("redeem_reserve_collateral"), u64(amount)]), keys: [
    m(vault, false, true), m(K_MARKET), m(K_USDC_RESERVE, true), m(K_MARKET_AUTH), m(USDC_MINT), m(K_USDC_CMINT, true), m(K_USDC_SUPPLY, true), m(k, true), m(usdc, true), ...tail] });
}
