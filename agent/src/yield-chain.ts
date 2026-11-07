// Vault-side plumbing for the yield router: balances / NAV and guarded rebalance transactions.
import { AnchorProvider, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Direct mode (no vault program on mainnet, to keep total cost under $10): the agent wallet holds the USDC and the
 *  same guardrails run in the agent before every send: program whitelist, simulated balance deltas vs max_in/min_out,
 *  rate limits (enforced by the agent loop). The on-chain version of these checks is the Sentinel Vault. */
export const DIRECT_ALLOWED_PROGRAMS = [JLEND_PROGRAM, KLEND_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM, ComputeBudgetProgram.programId];

export interface Nav { usdc: bigint; shares: bigint[]; value: number[]; idleUsd: number; navUsd: number; current: number; perShare: number[]; agentLamports: number }

export class YieldChain {
  prog: Program;
  vault: PublicKey; yieldCfg: PublicKey; usdcAta: PublicKey; receiptAtas: PublicKey[];
  constructor(public conn: Connection, public agent: Keypair, public owner: PublicKey, public priority = 10_000, public direct = false) {
    this.prog = new Program(vaultIdl as any, new AnchorProvider(conn, new Wallet(agent) as any, { commitment: "confirmed" }));
    this.vault = direct ? agent.publicKey : vaultPda(owner); // "vault" = whoever holds the funds
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
    // Value = what a full exit would actually return now (simulated against the live lending programs);
    // falls back to the stored exchange rate if simulation is unavailable.
    const value = await Promise.all(shares.map(async (s, i) => {
      try { return Number(await this.simulateExitUsdc(i, s)) / 1e6; } catch { return Number(s) * perShare[i] / 1e6; }
    }));
    const idleUsd = Number(usdc) / 1e6, navUsd = idleUsd + value.reduce((a, b) => a + b, 0);
    const maxV = Math.max(...value);
    const current = maxV > idleUsd ? value.indexOf(maxV) : IDLE;
    return { usdc, shares, value, idleUsd, navUsd, current, perShare, agentLamports: await this.conn.getBalance(this.agent.publicKey) };
  }

  async send(ixs: TransactionInstruction[], guard?: { venue: number; dir: "deposit" | "withdraw"; maxIn: bigint; minOut: bigint }) {
    if (this.direct && guard) await this.preflightGuard(ixs, guard);
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

  /** Exact USDC the vault would get by exiting `venue` right now: simulates the real lending program's redeem
   *  (interest accrued up to the current slot/time included, rounding included). Nothing is sent. */
  async simulateExitUsdc(venue: number, shares: bigint): Promise<bigint> {
    if (shares === 0n) return 0n;
    const ix = venue === 0 ? await jlendRedeemIx(this.conn, this.vault, shares) : kaminoIx(this.vault, "withdraw", shares);
    const ixs = venue === 1 ? [kaminoRefreshIx(), ix] : [ix];
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: this.agent.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs] }).compileToV0Message();
    const pre = (await this.conn.getTokenAccountBalance(this.usdcAta)).value.amount;
    const r = await this.conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [this.usdcAta.toBase58()] } });
    if (r.value.err || !r.value.accounts?.[0]) throw new Error(`exit simulation failed: ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).slice(-3).join(" | ")}`);
    const post = Buffer.from(r.value.accounts[0]!.data[0], "base64").readBigUInt64LE(64);
    return post - BigInt(pre);
  }

  /** Direct-mode guard: same rules the vault enforces on-chain, checked by simulating the exact transaction. */
  private async preflightGuard(ixs: TransactionInstruction[], g: { venue: number; dir: "deposit" | "withdraw"; maxIn: bigint; minOut: bigint }) {
    for (const ix of ixs) if (!DIRECT_ALLOWED_PROGRAMS.some(p => p.equals(ix.programId))) throw new Error(`guard: program ${ix.programId.toBase58()} not whitelisted`);
    const receipt = this.receiptAtas[g.venue];
    const [inAcc, outAcc] = g.dir === "deposit" ? [this.usdcAta, receipt] : [receipt, this.usdcAta];
    const bal = async (a: PublicKey) => { const i = await this.conn.getAccountInfo(a); return i ? i.data.readBigUInt64LE(64) : 0n; };
    const [preIn, preOut] = [await bal(inAcc), await bal(outAcc)];
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: this.agent.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs] }).compileToV0Message();
    const r = await this.conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [inAcc.toBase58(), outAcc.toBase58()] } });
    if (r.value.err) throw new Error(`guard: simulation failed ${JSON.stringify(r.value.err)}`);
    const post = r.value.accounts!.map(a => Buffer.from(a!.data[0], "base64").readBigUInt64LE(64));
    const spent = preIn - post[0], received = post[1] - preOut;
    if (spent > g.maxIn) throw new Error(`guard: OverSpent ${spent} > ${g.maxIn}`);
    if (received < g.minOut) throw new Error(`guard: Slippage ${received} < ${g.minOut}`);
  }

  /** Lamports per transaction with our compute budget: base fee + priority fee on the CU limit. */
  txCostLamports() { return 5000 + Math.ceil(400_000 * this.priority / 1e6); }

  private async rebalanceIx(venue: number, dir: "deposit" | "withdraw", amount: bigint, minOut: bigint) {
    const ix = venue === 0
      ? (dir === "deposit" ? await jlendIx(this.conn, this.vault, "deposit", amount) : await jlendRedeemIx(this.conn, this.vault, amount))
      : kaminoIx(this.vault, dir, amount);
    if (this.direct) {
      const pre = venue === 1 ? [kaminoRefreshIx()] : [];
      const ata = dir === "deposit" ? [createAssociatedTokenAccountIdempotentInstruction(this.agent.publicKey, this.receiptAtas[venue], this.agent.publicKey, VENUES[venue].receipt)] : [];
      return [...ata, ...pre, ix];
    }
    const main = await this.prog.methods.rebalance(venue, dir === "deposit" ? { deposit: {} } : { withdraw: {} }, new BN(amount.toString()), new BN(minOut.toString()), Buffer.from(ix.data))
      .accountsStrict({ agent: this.agent.publicKey, vault: this.vault, yieldConfig: this.yieldCfg, vaultQuote: this.usdcAta, vaultReceipt: this.receiptAtas[venue], lendingProgram: VENUES[venue].program })
      .remainingAccounts(ix.keys.map(k => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: false })))
      .instruction();
    return venue === 1 ? [kaminoRefreshIx(), main] : [main];
  }

  logIx(target: number, action: number, nav: number, reasonJson: string) {
    if (this.direct) return Promise.resolve(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`solsentinel:${target}:${action}:${sha256(reasonJson).toString("hex")}`) }));
    return this.prog.methods.logDecision(target < 0 ? 255 : target, action, new BN(Math.round(nav * 1e6)), [...sha256(reasonJson)])
      .accountsStrict({ agent: this.agent.publicKey, vault: this.vault }).instruction();
  }

  /** Exit `venue` completely: redeem all receipt tokens. min_out = 99.9% of the on-chain value (rounding slack). */
  async exitIxs(venue: number, n: Nav) {
    const shares = n.shares[venue];
    const minOut = BigInt(Math.floor(Number(shares) * n.perShare[venue] * 0.999));
    return { ixs: await this.rebalanceIx(venue, "withdraw", shares, minOut), guard: { venue, dir: "withdraw" as const, maxIn: shares, minOut } };
  }

  /** Deposit `amount` USDC; min_out = 99.9% of the shares the current exchange rate implies. */
  async enterIxs(venue: number, amount: bigint, n: Nav) {
    const minOut = BigInt(Math.floor(Number(amount) / n.perShare[venue] * 0.999));
    return { ixs: await this.rebalanceIx(venue, "deposit", amount, minOut), guard: { venue, dir: "deposit" as const, maxIn: amount, minOut } };
  }
}
