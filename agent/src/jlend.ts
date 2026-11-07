// Jupiter Lend Earn (jup3YeL8…) instruction builder for the vault PDA, via the official SDK.
import { getDepositIxs, getWithdrawIxs } from "@jup-ag/lend/earn";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

export const JLEND_PROGRAM = new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const JL_USDC = new PublicKey("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D");

/** Returns the single lending-program instruction (ATA setup is done separately by the agent). */
export async function jlendIx(conn: Connection, vault: PublicKey, dir: "deposit" | "withdraw", amount: bigint): Promise<TransactionInstruction> {
  const args = { amount: new BN(amount.toString()), asset: USDC_MINT, signer: vault, connection: conn, includeATASetup: false } as any;
  const r: any = dir === "deposit" ? await getDepositIxs(args) : await getWithdrawIxs(args);
  const ixs: TransactionInstruction[] = r.ixs.filter((i: TransactionInstruction) => i.programId.equals(JLEND_PROGRAM));
  if (ixs.length !== 1) throw new Error(`expected one jlend ix, got ${ixs.length}`);
  return ixs[0];
}
