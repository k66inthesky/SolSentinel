// Jupiter Lend Earn (jup3YeL8…) instruction builder for the vault PDA, via the official SDK.
import { getDepositIxs, getWithdrawIxs, getRedeemIxs, getLendingTokenDetails } from "@jup-ag/lend/earn";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

export const JLEND_PROGRAM = new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const JL_USDC = new PublicKey("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D");

function only(r: any, what: string): TransactionInstruction {
  const ixs: TransactionInstruction[] = r.ixs.filter((i: TransactionInstruction) => i.programId.equals(JLEND_PROGRAM));
  if (ixs.length !== 1) throw new Error(`expected one jlend ${what} ix, got ${ixs.length}`);
  return ixs[0];
}

/** Returns the single lending-program instruction (ATA setup is done separately by the agent). */
export async function jlendIx(conn: Connection, vault: PublicKey, dir: "deposit" | "withdraw", amount: bigint): Promise<TransactionInstruction> {
  const args = { amount: new BN(amount.toString()), asset: USDC_MINT, signer: vault, connection: conn, includeATASetup: false } as any;
  return only(dir === "deposit" ? await getDepositIxs(args) : await getWithdrawIxs(args), dir);
}

/** Redeem `shares` jlUSDC back to USDC (used to exit the whole position). */
export async function jlendRedeemIx(conn: Connection, vault: PublicKey, shares: bigint): Promise<TransactionInstruction> {
  return only(await getRedeemIxs({ shares: new BN(shares.toString()), asset: USDC_MINT, signer: vault, connection: conn, includeATASetup: false } as any), "redeem");
}

/** On-chain state: USDC per share, and the supply / rewards rate (APY %). */
export async function jlendState(conn: Connection) {
  const d: any = await getLendingTokenDetails({ lendingToken: JL_USDC, connection: conn, market: "main" } as any);
  return { assetsPerShare: Number(d.convertToAssets.toString()) / 1e6, supplyApyPct: Number(d.supplyRate.toString()) / 100, rewardsApyPct: Number(d.rewardsRate.toString()) / 100 };
}
