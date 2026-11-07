// On-chain client for the Sentinel Vault + mock AMM (localnet/devnet) and Jupiter (mainnet).
import { AnchorProvider, Program } from "@anchor-lang/core";
import { KeypairWallet as Wallet } from "./wallet.js";
import BN from "bn.js";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, mintTo, transfer, getAccount,
} from "@solana/spl-token";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import vaultIdl from "../idl/sentinel_vault.json" with { type: "json" };
import mockIdl from "../idl/mock_swap.json" with { type: "json" };
import type { SentinelVault } from "../idl/sentinel_vault.js";
import type { MockSwap } from "../idl/mock_swap.js";

export const VAULT_PROGRAM_ID = new PublicKey((vaultIdl as any).address);
export const MOCK_SWAP_PROGRAM_ID = new PublicKey((mockIdl as any).address);

export const REGIME_CODE = { trend: 0, range: 1, halt: 2 } as const;
export const ACTION_CODE = { hold: 0, buy: 1, sell: 2, pause: 3, retune: 4 } as const;

export interface PolicyCfg { maxTradeQuote: number; maxTradesPerDay: number; dailyLossLimitQuote: number; cooldownSecs: number }

export interface Deployment {
  cluster: string;
  owner: string;
  agent: string;
  vault: string;
  quoteMint: string;
  baseMint: string;
  pool?: string;
  swapProgram: string;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, process.env.HOME!), "utf8"))));
}

export function vaultPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], VAULT_PROGRAM_ID)[0];
}

export function sha256(s: string): Buffer { return createHash("sha256").update(s).digest(); }

function provider(conn: Connection, kp: Keypair) {
  return new AnchorProvider(conn, new Wallet(kp) as any, { commitment: "confirmed" });
}

export class SentinelChain {
  vaultProgram: Program<SentinelVault>;
  mockProgram: Program<MockSwap>;
  constructor(public conn: Connection, public agent: Keypair, public dep: Deployment, public priorityMicroLamports = 50_000) {
    const p = provider(conn, agent);
    this.vaultProgram = new Program<SentinelVault>(vaultIdl as any, p);
    this.mockProgram = new Program<MockSwap>(mockIdl as any, p);
  }

  get vault() { return new PublicKey(this.dep.vault); }
  get quoteMint() { return new PublicKey(this.dep.quoteMint); }
  get baseMint() { return new PublicKey(this.dep.baseMint); }
  get vaultQuote() { return getAssociatedTokenAddressSync(this.quoteMint, this.vault, true); }
  get vaultBase() { return getAssociatedTokenAddressSync(this.baseMint, this.vault, true); }

  async balances() {
    const [q, b] = await Promise.all([getAccount(this.conn, this.vaultQuote), getAccount(this.conn, this.vaultBase)]);
    return { quote: Number(q.amount) / 1e6, base: Number(b.amount) / 1e9, quoteRaw: q.amount, baseRaw: b.amount };
  }

  async vaultState() { return this.vaultProgram.account.vault.fetch(this.vault); }

  private computeIxs(units = 200_000) {
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityMicroLamports }),
    ];
  }

  /** Send with timing: returns ms from call -> sent, and sent -> confirmed. */
  async sendTimed(ixs: TransactionInstruction[]) {
    const t0 = performance.now();
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: this.agent.publicKey, blockhash, lastValidBlockHeight }).add(...this.computeIxs(), ...ixs);
    tx.sign(this.agent);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const t1 = performance.now();
    const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const t2 = performance.now();
    if (res.value.err) {
      const logs = (await this.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
      const msg = logs.find(l => l.includes("Error Message")) ?? JSON.stringify(res.value.err);
      throw Object.assign(new Error(`tx ${sig} failed: ${msg}`), { sig, logs });
    }
    return { sig, buildSendMs: t1 - t0, confirmMs: t2 - t1 };
  }

  async logDecisionIx(regime: keyof typeof REGIME_CODE, action: keyof typeof ACTION_CODE, price: number, reasonJson: string) {
    return this.vaultProgram.methods
      .logDecision(REGIME_CODE[regime], ACTION_CODE[action], new BN(Math.round(price * 1e6)), [...sha256(reasonJson)])
      .accountsStrict({ agent: this.agent.publicKey, vault: this.vault })
      .instruction();
  }

  /** Guarded swap through the mock AMM. The pool price is first set to the live oracle price. */
  async mockSwapIxs(side: "buy" | "sell", amountInRaw: bigint, minOutRaw: bigint, oraclePrice: number) {
    const pool = new PublicKey(this.dep.pool!);
    const poolBase = getAssociatedTokenAddressSync(this.baseMint, pool, true);
    const poolQuote = getAssociatedTokenAddressSync(this.quoteMint, pool, true);
    const setPrice = await this.mockProgram.methods.setPrice(new BN(Math.round(oraclePrice * 1e6)))
      .accountsStrict({ admin: this.agent.publicKey, pool }).instruction();
    const buy = side === "buy";
    const inner = this.mockProgram.coder.instruction.encode("swap", { amountIn: new BN(amountInRaw.toString()), buy });
    const remaining = [
      { pubkey: this.vault, isSigner: false, isWritable: false },           // user (vault PDA signs via CPI)
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: this.baseMint, isSigner: false, isWritable: false },
      { pubkey: this.quoteMint, isSigner: false, isWritable: false },
      { pubkey: buy ? this.vaultQuote : this.vaultBase, isSigner: false, isWritable: true },
      { pubkey: buy ? this.vaultBase : this.vaultQuote, isSigner: false, isWritable: true },
      { pubkey: buy ? poolQuote : poolBase, isSigner: false, isWritable: true },
      { pubkey: buy ? poolBase : poolQuote, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const swap = await this.vaultProgram.methods
      .swap(buy ? { buy: {} } : { sell: {} }, new BN(amountInRaw.toString()), new BN(minOutRaw.toString()), inner)
      .accountsStrict({ agent: this.agent.publicKey, vault: this.vault, vaultQuote: this.vaultQuote, vaultBase: this.vaultBase, swapProgram: MOCK_SWAP_PROGRAM_ID })
      .remainingAccounts(remaining)
      .instruction();
    return [setPrice, swap];
  }
}

// ---------- owner-side setup (localnet / devnet) ----------

export async function deployDemo(conn: Connection, owner: Keypair, agent: PublicKey, price: number, policy: PolicyCfg, depositUsdc: number, cluster: string): Promise<Deployment> {
  const quoteMint = await createMint(conn, owner, owner.publicKey, null, 6);   // demo USDC
  const baseMint = await createMint(conn, owner, owner.publicKey, null, 9);    // demo SOL
  const p = provider(conn, owner);
  const mock = new Program<MockSwap>(mockIdl as any, p);
  const vaultProg = new Program<SentinelVault>(vaultIdl as any, p);

  // Pool admin = agent key, so the agent can post the oracle price in the same tx as its swap.
  const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()], MOCK_SWAP_PROGRAM_ID)[0];
  const poolBase = getAssociatedTokenAddressSync(baseMint, pool, true);
  const poolQuote = getAssociatedTokenAddressSync(quoteMint, pool, true);
  const initPool = await mock.methods.initPool(new BN(Math.round(price * 1e6)), 10, agent)
    .accountsStrict({ payer: owner.publicKey, baseMint, quoteMint, pool, poolBase, poolQuote, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .instruction();
  await sendAndConfirmTransaction(conn, new Transaction().add(initPool), [owner]);
  await mintTo(conn, owner, baseMint, poolBase, owner, 1_000n * 10n ** 9n);
  await mintTo(conn, owner, quoteMint, poolQuote, owner, 100_000n * 10n ** 6n);

  const vault = vaultPda(owner.publicKey);
  const vaultQuote = getAssociatedTokenAddressSync(quoteMint, vault, true);
  const vaultBase = getAssociatedTokenAddressSync(baseMint, vault, true);
  await vaultProg.methods.initializeVault(agent, MOCK_SWAP_PROGRAM_ID, {
    maxTradeQuote: new BN(policy.maxTradeQuote * 1e6),
    maxTradesPerDay: policy.maxTradesPerDay,
    dailyLossLimitQuote: new BN(policy.dailyLossLimitQuote * 1e6),
    cooldownSecs: policy.cooldownSecs,
  }).accountsStrict({ owner: owner.publicKey, vault, quoteMint, baseMint, vaultQuote, vaultBase, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();

  const ownerQuote = await getOrCreateAssociatedTokenAccount(conn, owner, quoteMint, owner.publicKey);
  await mintTo(conn, owner, quoteMint, ownerQuote.address, owner, BigInt(Math.round(depositUsdc * 1e6)));
  await transfer(conn, owner, ownerQuote.address, vaultQuote, owner, BigInt(Math.round(depositUsdc * 1e6)));

  return { cluster, owner: owner.publicKey.toBase58(), agent: agent.toBase58(), vault: vault.toBase58(), quoteMint: quoteMint.toBase58(), baseMint: baseMint.toBase58(), pool: pool.toBase58(), swapProgram: MOCK_SWAP_PROGRAM_ID.toBase58() };
}

export function saveDeployment(path: string, d: Deployment) { writeFileSync(path, JSON.stringify(d, null, 2)); }
export function loadDeployment(path: string): Deployment | null { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; }
