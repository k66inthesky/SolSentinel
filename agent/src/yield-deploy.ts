// Sets up a yield vault: vault PDA (USDC quote), yield config with the two whitelisted venues, receipt-token ATAs,
// and moves the owner's USDC in.   npm run yield:deploy -- --mode fork|mainnet [--usdc 10] [--interval 3600]
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, Program } from "@anchor-lang/core";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { KeypairWallet as Wallet } from "./wallet.js";
import { loadKeypair, vaultPda } from "./chain.js";
import { USDC_MINT } from "./jlend.js";
import { VENUES } from "./yield-chain.js";
import vaultIdl from "../idl/sentinel_vault.json" with { type: "json" };

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MODE = arg("mode", "fork");
const USDC = +arg("usdc", "10");
const INTERVAL = +arg("interval", MODE === "fork" ? "10" : "3600");
const conn = new Connection(process.env.RPC_URL ?? (MODE === "fork" ? "http://127.0.0.1:8899" : "https://api.mainnet-beta.solana.com"), "confirmed");
const owner = loadKeypair(`${homedir()}/.config/solana/id.json`);
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? `${homedir()}/.config/solana/agent.json`);
if (MODE === "fork") for (const k of [owner.publicKey, agent.publicKey])
  await conn.confirmTransaction(await conn.requestAirdrop(k, 2 * LAMPORTS_PER_SOL), "confirmed");

const p = new AnchorProvider(conn, new Wallet(owner) as any, { commitment: "confirmed" });
const prog = new Program(vaultIdl as any, p);
const vault = vaultPda(owner.publicKey);
const ownerLamports0 = await conn.getBalance(owner.publicKey);
const sigs: string[] = [];
if (!(await conn.getAccountInfo(vault))) {
  sigs.push(await prog.methods.initializeVault(agent.publicKey, PublicKey.default,
    { maxTradeQuote: new BN(1), maxTradesPerDay: 1, dailyLossLimitQuote: new BN(1), cooldownSecs: 0 })
    .accounts({ owner: owner.publicKey, quoteMint: USDC_MINT, baseMint: NATIVE_MINT } as any).rpc());
}
const [yieldCfg] = PublicKey.findProgramAddressSync([Buffer.from("yield"), vault.toBuffer()], prog.programId);
const venues = VENUES.map(v => ({ program: v.program, receiptMint: v.receipt }));
if (!(await conn.getAccountInfo(yieldCfg))) sigs.push(await prog.methods.initYield(venues, 6, INTERVAL).accounts({ owner: owner.publicKey, vault } as any).rpc());
else sigs.push(await prog.methods.setYield(venues, 6, INTERVAL).accounts({ owner: owner.publicKey, vault } as any).rpc());
const tx = new Transaction();
for (const v of VENUES) tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, getAssociatedTokenAddressSync(v.receipt, vault, true), vault, v.receipt));
if (USDC > 0) tx.add(createTransferInstruction(getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey), getAssociatedTokenAddressSync(USDC_MINT, vault, true), owner.publicKey, BigInt(Math.round(USDC * 1e6))));
sigs.push(await p.sendAndConfirm(tx));

// Setup cost accounting: tx fees are a cost; account rent is a refundable deposit (close_token / closing returns it).
let feeLamports = 0;
for (const s of sigs) feeLamports += (await conn.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.fee ?? 0;
const rentLamports = ownerLamports0 - (await conn.getBalance(owner.publicKey)) - feeLamports;
const solUsd = 160;
mkdirSync("deployments", { recursive: true });
const dep = { mode: MODE, owner: owner.publicKey.toBase58(), agent: agent.publicKey.toBase58(), vault: vault.toBase58(), yieldConfig: yieldCfg.toBase58(),
  depositedUsd: USDC, setupFeeLamports: feeLamports, setupFeesUsd: feeLamports / LAMPORTS_PER_SOL * solUsd, refundableRentLamports: rentLamports,
  agentLamportsAtDeploy: await conn.getBalance(agent.publicKey), sigs, at: new Date().toISOString() };
writeFileSync(`deployments/yield-${MODE}.json`, JSON.stringify(dep, null, 2));
console.log(dep);
