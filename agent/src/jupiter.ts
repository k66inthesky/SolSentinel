// Jupiter (mainnet) integration.
//  - quote(): used in paper mode so simulated fills use the real route's price, fees and impact.
//  - vaultSwapTx(): mainnet execution through the Sentinel Vault. Jupiter builds a swap instruction
//    for the vault PDA as the user; we wrap it in sentinel_vault::swap so the vault's policy checks
//    and balance-delta accounting apply. NOTE: implemented to Jupiter's documented swap-instructions
//    API but not yet exercised with real funds; run `npm run agent -- --mode mainnet` only with a
//    small balance and watch the first trade.
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import type { SentinelChain } from "./chain.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const API = process.env.JUP_API ?? "https://lite-api.jup.ag/swap/v1";

export interface Quote { inAmount: string; outAmount: string; otherAmountThreshold: string; priceImpactPct: string; routePlan: any[]; [k: string]: any }

export async function quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps = 30): Promise<Quote> {
  const u = `${API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${await r.text()}`);
  return r.json() as Promise<Quote>;
}

function toIx(i: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, "base64"),
  });
}

export async function vaultSwapTx(chain: SentinelChain, side: "buy" | "sell", q: Quote, priorityMicroLamports: number) {
  const res = await fetch(`${API}/swap-instructions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: chain.vault.toBase58(), wrapAndUnwrapSol: false, useSharedAccounts: true, dynamicComputeUnitLimit: false }),
  });
  if (!res.ok) throw new Error(`jupiter swap-instructions ${res.status}: ${await res.text()}`);
  const j = await res.json() as any;
  const jupIx = toIx(j.swapInstruction);
  const remaining = jupIx.keys.map(k => ({ ...k, isSigner: false })); // vault PDA signs inside the CPI
  const swapIx = await chain.vaultProgram.methods
    .swap(side === "buy" ? { buy: {} } : { sell: {} }, new BN(q.inAmount), new BN(q.otherAmountThreshold), jupIx.data)
    .accountsStrict({ agent: chain.agent.publicKey, vault: chain.vault, vaultQuote: chain.vaultQuote, vaultBase: chain.vaultBase, swapProgram: JUPITER_PROGRAM_ID })
    .remainingAccounts(remaining)
    .instruction();
  const alts: AddressLookupTableAccount[] = [];
  for (const a of j.addressLookupTableAddresses ?? []) {
    const r = await chain.conn.getAddressLookupTable(new PublicKey(a));
    if (r.value) alts.push(r.value);
  }
  const { blockhash, lastValidBlockHeight } = await chain.conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: chain.agent.publicKey, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
      swapIx,
    ],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([chain.agent]);
  return { tx, blockhash, lastValidBlockHeight };
}

export async function sendVersioned(conn: Connection, tx: VersionedTransaction, blockhash: string, lastValidBlockHeight: number) {
  const t0 = performance.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const t1 = performance.now();
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(r.value.err)}`);
  return { sig, buildSendMs: 0, sendMs: t1 - t0, confirmMs: performance.now() - t1 };
}
