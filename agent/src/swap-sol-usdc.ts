// One-time conversion of the agent wallet's SOL into USDC via Jupiter, keeping a SOL reserve for fees and rent.
// Records the swap's real cost (SOL value at the Jupiter reference price minus USDC received) so PnL counts it.
//   npx tsx agent/src/swap-sol-usdc.ts [--keep 0.01] [--dry]
import { Connection, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadKeypair } from "./chain.js";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const KEEP = +arg("keep", "0.01"), DRY = process.argv.includes("--dry");
const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? `${homedir()}/.config/solana/agent.json`);
const lamports = await conn.getBalance(agent.publicKey);
const amount = DRY && lamports === 0 ? 100_000_000 : lamports - Math.round(KEEP * LAMPORTS_PER_SOL);
console.log(`balance ${lamports / 1e9} SOL, swapping ${amount / 1e9} SOL, keeping ${KEEP}`);
if (amount <= 0) throw new Error("nothing to swap");
const ref = +((await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`)).json()) as any)[SOL].usdPrice;
const q: any = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${amount}&slippageBps=30&restrictIntermediateTokens=true`)).json();
console.log(`quote: ${q.outAmount / 1e6} USDC (ref price $${ref}, value $${(amount / 1e9 * ref).toFixed(4)}), impact ${q.priceImpactPct}`);
if (DRY) process.exit(0);
const s: any = await (await fetch("https://lite-api.jup.ag/swap/v1/swap", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ quoteResponse: q, userPublicKey: agent.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 1000 }) })).json();
const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
tx.sign([agent]);
const ata = getAssociatedTokenAddressSync(new PublicKey(USDC), agent.publicKey);
const pre = await conn.getTokenAccountBalance(ata).then(r => +r.value.amount).catch(() => 0);
const bh = await conn.getLatestBlockhash("confirmed");
const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
const res = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
if (res.value.err) throw new Error(`swap failed ${sig} ${JSON.stringify(res.value.err)}`);
const post = +(await conn.getTokenAccountBalance(ata)).value.amount;
const got = (post - pre) / 1e6, lamportsAfter = await conn.getBalance(agent.publicKey);
const out = { sig, swappedSol: amount / 1e9, gotUsdc: got, refPrice: ref, swapCostUsd: +(amount / 1e9 * ref - got).toFixed(6),
  solSpentInclFeesAndRent: (lamports - lamportsAfter) / 1e9, at: new Date().toISOString() };
writeFileSync("deployments/mainnet-swap.json", JSON.stringify(out, null, 2));
console.log(out);
