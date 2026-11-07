// Vault-side plumbing for the yield router: balances / NAV and guarded rebalance transactions.
import { AnchorProvider, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { KeypairWallet as Wallet } from "./wallet.js";
import { sha256, vaultPda } from "./chain.js";
import { jlendIx, jlendRedeemIx, jlendState, JLEND_PROGRAM, JL_USDC, USDC_MINT } from "./jlend.js";
import { kaminoIx, kaminoRefreshIx, kaminoState, KLEND_PROGRAM, K_USDC_CMINT } from "./kamino.js";
import vaultIdl from "../idl/sentinel_vault.json" with { type: "json" };

export const VENUES = [
  { idx: 0, name: "Jupiter Lend USDC", program: JLEND_PROGRAM, receipt: JL_USDC },
  { idx: 1, name: "Kamino Lend USDC", program: KLEND_PROGRAM, receipt: K_USDC_CMINT },
] as const;
export const IDLE = -1;

export interface Nav { usdc: bigint; shares: bigint[]; value: number[]; idleUsd: number; navUsd: number; current: number; perShare: number[]; agentLamports: number }

export class YieldChain {
  prog: Program;
  vault: PublicKey; yieldCfg: PublicKey; usdcAta: PublicKey; receiptAtas: PublicKey[];
  constructor(public conn: Connection, public agent: Keypair, public owner: PublicKey, public priority = 10_000) {
    this.prog = new Program(vaultIdl as any, new AnchorProvider(conn, new Wallet(agent) as any, { commitment: "confirmed" }));
    this.vault = vaultPda(owner);
    this.yieldCfg = PublicKey.findProgramAddressSync([Buffer.from("yield"), this.vault.toBuffer()], this.prog.programId)[0];
    this.usdcAta = getAssociatedTokenAddressSync(USDC_MINT, this.vault, true);
    this.receiptAtas = VENUES.map(v => getAssociatedTokenAddressSync(v.receipt, this.vault, true));
  }

  async nav(): Promise<Nav> {
    const accs = await this.conn.getMultipleAccountsInfo([this.usdcAta, ...this.receiptAtas]);
    const amt = (a: any) => (a ? a.data.readBigUInt64LE(64) : 0n);
    const [usdc, ...shares] = accs.map(amt);
    const [j, k] = await Promise.all([jlendState(this.conn), kaminoState(this.conn)]);
    const perShare = [j.assetsPerShare, k.assetsPerShare];
    const value = shares.map((s, i) => Number(s) * perShare[i] / 1e6);
    const idleUsd = Number(usdc) / 1e6, navUsd = idleUsd + value.reduce((a, b) => a + b, 0);
    const maxV = Math.max(...value);
    const current = maxV > idleUsd ? value.indexOf(maxV) : IDLE;
    return { usdc, shares, value, idleUsd, navUsd, current, perShare, agentLamports: await this.conn.getBalance(this.agent.publicKey) };
  }

  async send(ixs: TransactionInstruction[]) {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: this.agent.publicKey, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priority }), ...ixs);
    tx.sign(this.agent);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
    const fee = (await this.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.fee ?? 0;
    return { sig, feeLamports: fee };
  }

  /** Lamports per transaction with our compute budget: base fee + priority fee on the CU limit. */
  txCostLamports() { return 5000 + Math.ceil(400_000 * this.priority / 1e6); }

  private async rebalanceIx(venue: number, dir: "deposit" | "withdraw", amount: bigint, minOut: bigint) {
    const ix = venue === 0
      ? (dir === "deposit" ? await jlendIx(this.conn, this.vault, "deposit", amount) : await jlendRedeemIx(this.conn, this.vault, amount))
      : kaminoIx(this.vault, dir, amount);
    const main = await this.prog.methods.rebalance(venue, dir === "deposit" ? { deposit: {} } : { withdraw: {} }, new BN(amount.toString()), new BN(minOut.toString()), Buffer.from(ix.data))
      .accountsStrict({ agent: this.agent.publicKey, vault: this.vault, yieldConfig: this.yieldCfg, vaultQuote: this.usdcAta, vaultReceipt: this.receiptAtas[venue], lendingProgram: VENUES[venue].program })
      .remainingAccounts(ix.keys.map(k => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: false })))
      .instruction();
    return venue === 1 ? [kaminoRefreshIx(), main] : [main];
  }

  logIx(target: number, action: number, nav: number, reasonJson: string) {
    return this.prog.methods.logDecision(target < 0 ? 255 : target, action, new BN(Math.round(nav * 1e6)), [...sha256(reasonJson)])
      .accountsStrict({ agent: this.agent.publicKey, vault: this.vault }).instruction();
  }

  /** Exit `venue` completely: redeem all receipt tokens. min_out = 99.9% of the on-chain value (rounding slack). */
  async exitIxs(venue: number, n: Nav) {
    const shares = n.shares[venue];
    const minOut = BigInt(Math.floor(Number(shares) * n.perShare[venue] * 0.999));
    return this.rebalanceIx(venue, "withdraw", shares, minOut);
  }

  /** Deposit `amount` USDC; min_out = 99.9% of the shares the current exchange rate implies. */
  async enterIxs(venue: number, amount: bigint, n: Nav) {
    const minOut = BigInt(Math.floor(Number(amount) / n.perShare[venue] * 0.999));
    return this.rebalanceIx(venue, "deposit", amount, minOut);
  }
}
