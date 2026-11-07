// Direct mode exit: redeem every lending position back to USDC (guarded), close the receipt-token accounts so their
// rent comes back, and optionally send everything to a payout address.
//   npx tsx agent/src/yield-direct-exit.ts --mode fork|mainnet [--payout <address>]
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { createCloseAccountInstruction, createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { homedir } from "node:os";
import { loadKeypair } from "./chain.js";
import { USDC_MINT } from "./jlend.js";
import { VENUES, YieldChain } from "./yield-chain.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const MODE = arg("mode") ?? "fork";
const conn = new Connection(process.env.RPC_URL ?? (MODE === "fork" ? "http://127.0.0.1:8899" : "https://api.mainnet-beta.solana.com"), "confirmed");
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? `${homedir()}/.config/solana/agent.json`);
const yc = new YieldChain(conn, agent, agent.publicKey, 1000, true);
let n = await yc.nav();
for (const v of VENUES) if (n.shares[v.idx] > 0n) {
  const ex = await yc.exitIxs(v.idx, n);
  const r = await yc.send(ex.ixs, ex.guard); console.log(`exited ${v.name}: ${r.sig} fee ${r.feeLamports}`);
  n = await yc.nav();
}
const close = [];
for (const v of VENUES) if (await conn.getAccountInfo(yc.receiptAtas[v.idx])) close.push(createCloseAccountInstruction(yc.receiptAtas[v.idx], agent.publicKey, agent.publicKey));
const payout = arg("payout") ? new PublicKey(arg("payout")!) : null;
const ixs: any[] = [...close];
if (payout) {
  const dst = getAssociatedTokenAddressSync(USDC_MINT, payout);
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, dst, payout, USDC_MINT), createTransferInstruction(yc.usdcAta, dst, agent.publicKey, n.usdc),
    createCloseAccountInstruction(yc.usdcAta, agent.publicKey, agent.publicKey));
}
if (ixs.length) { const r = await yc.send(ixs); console.log(`closed receipt accounts${payout ? " + paid out USDC" : ""}: ${r.sig} fee ${r.feeLamports}`); }
if (payout) { // send the remaining SOL (fee reserve + refunded rent) back too, minus one fee
  const lam = await conn.getBalance(agent.publicKey);
  const r = await yc.send([SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: payout, lamports: lam - 15_000 })]);
  console.log(`returned SOL: ${r.sig}`);
}
console.log({ usdc: Number((await yc.nav()).usdc) / 1e6, lamports: await conn.getBalance(agent.publicKey) });
