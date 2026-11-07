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
const payout0 = arg("payout") ? new PublicKey(arg("payout")!) : null;
// Fast path: ONE transaction does everything (redeem the single position, close its receipt account, send all USDC,
// close the USDC account, send all SOL). It is atomic, so if the exact USDC amount moved by a unit we just retry.
const held = VENUES.filter(v => n.shares[v.idx] > 0n);
if (payout0 && held.length === 1 && !process.argv.includes("--slow")) {
  const v = held[0];
  const dst = getAssociatedTokenAddressSync(USDC_MINT, payout0);
  const dstExists = !!(await conn.getAccountInfo(dst));
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      n = await yc.nav();
      const out = await yc.simulateExitUsdc(v.idx, n.shares[v.idx]);
      const ex = await yc.exitIxs(v.idx, n);
      const usdcTotal = n.usdc + out;
      const [rentR, rentU, lam] = await Promise.all([conn.getBalance(yc.receiptAtas[v.idx]), conn.getBalance(yc.usdcAta), conn.getBalance(agent.publicKey)]);
      const ataRent = dstExists ? 0 : await conn.getMinimumBalanceForRentExemption(165);
      const solOut = lam + rentR + rentU - ataRent - yc.txCostLamports();
      const ixs = [...ex.ixs, createCloseAccountInstruction(yc.receiptAtas[v.idx], agent.publicKey, agent.publicKey),
        createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, dst, payout0, USDC_MINT),
        createTransferInstruction(yc.usdcAta, dst, agent.publicKey, usdcTotal),
        createCloseAccountInstruction(yc.usdcAta, agent.publicKey, agent.publicKey),
        SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: payout0, lamports: solOut })];
      const r = await yc.send(ixs);
      console.log(JSON.stringify({ exited: v.name, sig: r.sig, feeLamports: r.feeLamports, paidUsdc: Number(usdcTotal) / 1e6, paidSol: solOut / 1e9, payoutUsdcAtaCreated: !dstExists }));
      process.exit(0);
    } catch (e) { console.log(`attempt ${attempt} failed: ${(e as Error).message.slice(0, 200)}`); }
  }
  console.log("falling back to the multi-transaction exit");
}
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
  const r = await yc.send([SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: payout, lamports: lam - yc.txCostLamports() })]);
  console.log(`returned SOL: ${r.sig}`);
}
console.log({ usdc: Number((await yc.nav()).usdc) / 1e6, lamports: await conn.getBalance(agent.publicKey) });
