// Direct mode setup (mainnet budget < $10: no vault program deploy). Records the agent wallet's starting USDC and SOL
// so PnL can be computed honestly. On the fork, also moves the owner's injected test USDC to the agent wallet.
//   npx tsx agent/src/yield-direct-setup.ts --mode fork|mainnet
import { Connection, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadKeypair } from "./chain.js";
import { USDC_MINT } from "./jlend.js";

const MODE = process.argv.includes("mainnet") ? "mainnet" : "fork";
const conn = new Connection(process.env.RPC_URL ?? (MODE === "fork" ? "http://127.0.0.1:8899" : "https://api.mainnet-beta.solana.com"), "confirmed");
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? `${homedir()}/.config/solana/agent.json`);
const ata = getAssociatedTokenAddressSync(USDC_MINT, agent.publicKey);
if (MODE === "fork") {
  // fork only: the agent gets just 0.01 SOL, as it would on mainnet, so fee accounting is realistic
  const owner = loadKeypair(`${homedir()}/.config/solana/id.json`);
  await conn.confirmTransaction(await conn.requestAirdrop(owner.publicKey, LAMPORTS_PER_SOL), "confirmed");
  const { SystemProgram } = await import("@solana/web3.js");
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, agent.publicKey, USDC_MINT),
    createTransferInstruction(getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey), ata, owner.publicKey, 10_000_000)), [owner]);
}
const usdc = Number((await conn.getTokenAccountBalance(ata)).value.amount) / 1e6;
// mainnet: the SOL->USDC swap's cost (price/fee loss + its tx fee) is a setup cost; USDC-account rent is refundable at exit
const swap = MODE === "mainnet" && existsSync("deployments/mainnet-swap.json") ? JSON.parse(readFileSync("deployments/mainnet-swap.json", "utf8")) : null;
const swapFeeUsd = swap ? (swap.txFeeSol ?? 0) * swap.refPrice : 0;
const dep = { mode: MODE, direct: true, swap, swapFeeUsd, owner: agent.publicKey.toBase58(), agent: agent.publicKey.toBase58(), depositedUsd: usdc,
  agentLamportsAtDeploy: await conn.getBalance(agent.publicKey), setupFeesUsd: swap ? swap.swapCostUsd + swapFeeUsd : 0, at: new Date().toISOString() };
writeFileSync(`deployments/yield-${MODE}-direct.json`, JSON.stringify(dep, null, 2));
console.log(dep);
