// Integration tests against a local solana-test-validator with both programs loaded.
//   npm run validator   (separate shell)   then   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@anchor-lang/core";
import { KeypairWallet as Wallet } from "../src/wallet.js";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import vaultIdl from "../idl/sentinel_vault.json" with { type: "json" };
import { SentinelChain, deployDemo, sha256 } from "../src/chain.js";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PRICE = 90;

async function fund(kp: Keypair) {
  const sig = await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function expectErr(p: Promise<unknown>, needle: string) {
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `expected "${needle}" in:\n${text.slice(0, 600)}`);
    return;
  }
  assert.fail(`expected failure containing "${needle}"`);
}

test("sentinel vault enforces policy on-chain", async (t) => {
  const owner = Keypair.generate(), agent = Keypair.generate(), stranger = Keypair.generate();
  await Promise.all([fund(owner), fund(agent), fund(stranger)]);
  const dep = await deployDemo(conn, owner, agent.publicKey, PRICE,
    { maxTradeQuote: 5, maxTradesPerDay: 3, dailyLossLimitQuote: 0.05, cooldownSecs: 2 }, 10, "localnet");
  const chain = new SentinelChain(conn, agent, dep, 0);
  const ownerProg = new Program(vaultIdl as any, new AnchorProvider(conn, new Wallet(owner) as any, { commitment: "confirmed" }));
  const vault = new PublicKey(dep.vault);

  await t.test("vault starts with the 10 USDC deposit", async () => {
    const b = await chain.balances();
    assert.equal(b.quote, 10);
    assert.equal(b.base, 0);
  });

  await t.test("agent can buy within the cap; fill measured from real balances", async () => {
    const r = await chain.sendTimed(await chain.mockSwapIxs("buy", 5_000_000n, 1n, PRICE));
    assert.ok(r.sig);
    const b = await chain.balances();
    assert.equal(b.quote, 5);
    assert.ok(Math.abs(b.base - 5 / PRICE * 0.999) < 1e-6, `base ${b.base}`);
    const s = await chain.vaultState();
    assert.equal(s.openCost.toNumber(), 5_000_000);
    assert.equal(s.tradesToday, 1);
  });

  await t.test("second buy inside cooldown is rejected", async () => {
    await expectErr(chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 1n, PRICE)), "Cooldown");
  });

  await t.test("buy above the per-trade cap is rejected", async () => {
    await sleep(2500);
    await expectErr(chain.sendTimed(await chain.mockSwapIxs("buy", 5_000_001n, 1n, PRICE)), "TradeTooLarge");
  });

  await t.test("slippage guard: min_out above what the pool pays is rejected", async () => {
    await expectErr(chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 1_000_000_000n, PRICE)), "Slippage");
  });

  await t.test("a non-agent key cannot trade", async () => {
    const rogue = new SentinelChain(conn, stranger, dep, 0);
    // skip the pool price update (agent-only) so the vault itself is what rejects the stranger
    const [, swapIx] = await rogue.mockSwapIxs("buy", 1_000_000n, 1n, PRICE);
    await expectErr(rogue.sendTimed([swapIx]), "caused by account: vault. Error Code: ConstraintHasOne");
  });

  await t.test("agent key cannot withdraw funds", async () => {
    const agentProg = chain.vaultProgram;
    const dest = await getOrCreateAssociatedTokenAccount(conn, agent, new PublicKey(dep.quoteMint), agent.publicKey);
    await expectErr(agentProg.methods.withdraw(new BN(1_000_000)).accountsStrict({
      owner: agent.publicKey, vault, from: getAssociatedTokenAddressSync(new PublicKey(dep.quoteMint), vault, true), to: dest.address, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc(), "ConstraintSeeds");
  });

  await t.test("log_decision stores the reasoning hash", async () => {
    const reason = JSON.stringify({ regime: "trend", why: "test" });
    await chain.sendTimed([await chain.logDecisionIx("trend", "hold", PRICE, reason)]);
    const s = await chain.vaultState();
    assert.equal(s.decisions.toNumber(), 1);
    assert.deepEqual(Buffer.from(s.lastDecisionHash), sha256(reason));
  });

  await t.test("owner pause blocks buys but still allows selling to flatten", async () => {
    await ownerProg.methods.setPaused(true).accountsStrict({ owner: owner.publicKey, vault }).rpc();
    await expectErr(chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 1n, PRICE)), "Paused");
    const { baseRaw } = await chain.balances();
    // sell everything 2% lower -> realized loss ~0.1 USDC > 0.05 limit
    await chain.sendTimed(await chain.mockSwapIxs("sell", baseRaw, 1n, PRICE * 0.98));
    const s = await chain.vaultState();
    assert.ok(s.realizedPnlToday.toNumber() < -50_000, `pnl ${s.realizedPnlToday}`);
    assert.equal(s.haltedDay.toNumber(), s.day.toNumber(), "daily loss halt should trigger");
    assert.equal(s.openCost.toNumber(), 0);
  });

  await t.test("after unpausing, the daily-loss halt still blocks new buys", async () => {
    await ownerProg.methods.setPaused(false).accountsStrict({ owner: owner.publicKey, vault }).rpc();
    await sleep(2500);
    await expectErr(chain.sendTimed(await chain.mockSwapIxs("buy", 1_000_000n, 1n, PRICE)), "DailyLossHalt");
  });

  await t.test("owner can withdraw", async () => {
    const dest = await getOrCreateAssociatedTokenAccount(conn, owner, new PublicKey(dep.quoteMint), owner.publicKey);
    const before = (await chain.balances()).quoteRaw;
    await ownerProg.methods.withdraw(new BN(1_000_000)).accountsStrict({
      owner: owner.publicKey, vault, from: chain.vaultQuote, to: dest.address, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    assert.equal((await chain.balances()).quoteRaw, before - 1_000_000n);
  });
});
