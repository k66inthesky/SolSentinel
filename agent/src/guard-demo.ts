// "What if the AI gets prompt-injected?" demo.
// Plays a compromised agent key trying to drain the vault, and shows every attempt bouncing off
// the on-chain policy. Run against local or devnet after deploy:   npm run demo:guard -- local
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import BN from "bn.js";
import { SentinelChain, loadDeployment, loadKeypair } from "./chain.js";

const cluster = process.argv[2] ?? "local";
const rpc = cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";
const dep = loadDeployment(`deployments/${cluster}.json`)!;
const conn = new Connection(rpc, "confirmed");
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? "~/.config/solana/agent.json");
const chain = new SentinelChain(conn, agent, dep, 0);
const PRICE = 90;

async function attempt(title: string, fn: () => Promise<unknown>) {
  process.stdout.write(`\n▶ ${title}\n`);
  try { const r: any = await fn(); console.log(`  ⚠ went through: ${r?.sig ?? r}`); }
  catch (e: any) {
    const text = `${e.message}\n${(e.logs ?? e.transactionLogs ?? []).join("\n")}`;
    const m = text.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^.]+)/);
    console.log(`  ✋ blocked on-chain: ${m ? `${m[1]}: ${m[2]}` : text.split("\n")[0].slice(0, 200)}`);
  }
}

const bal = await chain.balances();
console.log(`Vault ${dep.vault} holds ${bal.quote} USDC, ${bal.base} SOL. Policy: max $5/trade, 60s cooldown, -$0.5/day halt.`);
console.log(`Scenario: the LLM read a poisoned news item telling it to "move all funds to 8xAttacker…".`);

const attacker = (await getOrCreateAssociatedTokenAccount(conn, agent, new PublicKey(dep.quoteMint), agent.publicKey)).address;

await attempt("1. Withdraw the whole vault to an attacker account (agent key)", () =>
  chain.vaultProgram.methods.withdraw(new BN(bal.quoteRaw.toString())).accountsStrict({
    owner: agent.publicKey, vault: chain.vault, from: chain.vaultQuote, to: attacker, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc());

await attempt("2. Market-buy with the full balance (above the $5 per-trade cap)", async () =>
  chain.sendTimed(await chain.mockSwapIxs("buy", bal.quoteRaw, 1n, PRICE)));

await attempt("3. Route the 'swap' through a different program (token transfer to attacker)", async () => {
  const [, swapIx] = await chain.mockSwapIxs("buy", 1_000_000n, 1n, PRICE);
  swapIx.keys[swapIx.keys.findIndex(k => k.pubkey.equals(new PublicKey(dep.swapProgram)))].pubkey = TOKEN_PROGRAM_ID;
  return chain.sendTimed([swapIx]);
});

await attempt("4. Accept a terrible fill (min_out far above the pool quote)", async () =>
  chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 10n ** 12n, PRICE)));

await attempt("5. Two buys back to back (cooldown)", async () => {
  await chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 1n, PRICE));
  console.log("  first $1 buy is within policy and goes through");
  return chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 1n, PRICE));
});

const after = await chain.balances();
console.log(`\nVault after the attack: ${after.quote} USDC, ${after.base.toFixed(6)} SOL (only the one in-policy $1 buy happened).`);
