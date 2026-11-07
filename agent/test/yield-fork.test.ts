// Yield-router integration test on a MAINNET FORK: the real Jupiter Lend Earn + Liquidity programs and
// their USDC accounts are cloned into solana-test-validator (scripts/fork-validator.sh), so the vault's
// rebalance CPI runs the production lending code. Run:  npm run validator:fork  then  npm run test:fork
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program } from "@anchor-lang/core";
import BN from "bn.js";
import { createMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { KeypairWallet as Wallet } from "../src/wallet.js";
import { loadKeypair, vaultPda } from "../src/chain.js";
import { jlendIx, JLEND_PROGRAM, JL_USDC, USDC_MINT } from "../src/jlend.js";
import { kaminoIx, kaminoRefreshIx, KLEND_PROGRAM, K_USDC_CMINT } from "../src/kamino.js";
import vaultIdl from "../idl/sentinel_vault.json" with { type: "json" };
import os from "node:os";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const bal = async (a: PublicKey) => BigInt((await conn.getTokenAccountBalance(a)).value.amount);

async function expectErr(p: Promise<unknown>, needle: string) {
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.logs ?? e.transactionLogs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `expected "${needle}" in:\n${text.slice(0, 900)}`);
    return;
  }
  assert.fail(`expected failure containing "${needle}"`);
}

test("vault routes USDC into real Jupiter Lend (mainnet fork) under on-chain guardrails", async (t) => {
  const owner = loadKeypair(`${os.homedir()}/.config/solana/id.json`);
  const agent = Keypair.generate();
  for (const k of [owner.publicKey, agent.publicKey]) await conn.confirmTransaction(await conn.requestAirdrop(k, 5 * LAMPORTS_PER_SOL), "confirmed");
  const ownerP = new AnchorProvider(conn, new Wallet(owner) as any, { commitment: "confirmed" });
  const agentP = new AnchorProvider(conn, new Wallet(agent) as any, { commitment: "confirmed" });
  const ownerProg = new Program(vaultIdl as any, ownerP), agentProg = new Program(vaultIdl as any, agentP);
  const vault = vaultPda(owner.publicKey);
  const [yieldCfg] = PublicKey.findProgramAddressSync([Buffer.from("yield"), vault.toBuffer()], ownerProg.programId);
  const baseMint = await createMint(conn, owner, owner.publicKey, null, 9); // unused SOL leg for this vault
  const vaultUsdc = getAssociatedTokenAddressSync(USDC_MINT, vault, true);
  const vaultJl = getAssociatedTokenAddressSync(JL_USDC, vault, true);
  const vaultBase = getAssociatedTokenAddressSync(baseMint, vault, true);

  await ownerProg.methods.initializeVault(agent.publicKey, PublicKey.default,
    { maxTradeQuote: new BN(1), maxTradesPerDay: 1, dailyLossLimitQuote: new BN(1), cooldownSecs: 0 })
    .accounts({ owner: owner.publicKey, quoteMint: USDC_MINT, baseMint } as any).rpc();
  await ownerProg.methods.initYield([{ program: JLEND_PROGRAM, receiptMint: JL_USDC }], 4, 2)
    .accounts({ owner: owner.publicKey, vault } as any).rpc();
  const ownerUsdc = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
  await ownerP.sendAndConfirm(new Transaction().add(
    createTransferInstruction(ownerUsdc, vaultUsdc, owner.publicKey, 10_000_000),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, vaultJl, vault, JL_USDC)));

  const move = (dir: "deposit" | "withdraw", amount: bigint, minOut: bigint, opts: { program?: PublicKey; receipt?: PublicKey; venue?: number } = {}) =>
    (async () => {
      const ix = await jlendIx(conn, vault, dir, amount);
      const maxIn = dir === "deposit" ? amount : await bal(vaultJl); // withdraw spends receipt tokens; cap = whole position
      return agentProg.methods.rebalance(opts.venue ?? 0, dir === "deposit" ? { deposit: {} } : { withdraw: {} }, new BN(maxIn.toString()), new BN(minOut.toString()), Buffer.from(ix.data))
        .accountsStrict({ agent: agent.publicKey, vault, yieldConfig: yieldCfg, vaultQuote: vaultUsdc, vaultReceipt: opts.receipt ?? vaultJl, lendingProgram: opts.program ?? JLEND_PROGRAM })
        .remainingAccounts(ix.keys.map(k => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: false })))
        .rpc();
    })();

  let jlAfterDeposit = 0n;
  await t.test("agent deposits 10 USDC into Jupiter Lend; vault receives jlUSDC", async () => {
    await move("deposit", 10_000_000n, 9_000_000n);
    assert.equal(await bal(vaultUsdc), 0n);
    jlAfterDeposit = await bal(vaultJl);
    assert.ok(jlAfterDeposit > 9_000_000n && jlAfterDeposit < 10_000_000n, `jlUSDC ${jlAfterDeposit}`);
  });

  await t.test("min_out above what the lending program gives is rejected (Slippage)", async () => {
    await sleep(2100);
    await expectErr(move("withdraw", 1_000_000n, 2_000_000n), "Slippage");
  });

  await t.test("lending program not on the whitelist is rejected", async () => {
    await expectErr(move("withdraw", 1_000_000n, 0n, { program: TOKEN_PROGRAM_ID }), "SwapProgramNotAllowed");
  });

  await t.test("receipt account of the wrong mint is rejected", async () => {
    await ownerP.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, vaultBase, vault, baseMint)));
    await expectErr(move("withdraw", 1_000_000n, 0n, { receipt: vaultBase }), "MintNotAllowed");
  });

  await t.test("unknown venue index is rejected", async () => {
    await expectErr(move("withdraw", 1_000_000n, 0n, { venue: 3 }), "SwapProgramNotAllowed");
  });

  await t.test("deposits blocked while paused; withdrawals back to USDC still allowed", async () => {
    await ownerProg.methods.setPaused(true).accounts({ owner: owner.publicKey, vault } as any).rpc();
    const w = 9_990_000n;
    await move("withdraw", w, w);
    assert.equal(await bal(vaultUsdc), w);
    await sleep(2100);
    await expectErr(move("deposit", 1_000_000n, 0n), "Paused");
    await ownerProg.methods.setPaused(false).accounts({ owner: owner.publicKey, vault } as any).rpc();
  });

  await t.test("rate limit: interval between moves is enforced", async () => {
    await sleep(2100);
    await move("deposit", 1_000_000n, 900_000n);
    await expectErr(move("deposit", 1_000_000n, 0n), "Cooldown");
  });

  await t.test("rate limit: moves per day capped (4)", async () => {
    await sleep(2100);
    await move("withdraw", 500_000n, 500_000n);
    await sleep(2100);
    await expectErr(move("deposit", 1_000_000n, 0n), "TooManyTrades");
  });

  await t.test("agent cannot withdraw receipt tokens out of the vault; owner can", async () => {
    const ownerJl = getAssociatedTokenAddressSync(JL_USDC, owner.publicKey);
    await ownerP.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerJl, owner.publicKey, JL_USDC)));
    await expectErr(agentProg.methods.withdraw(new BN(1)).accounts({ owner: agent.publicKey, vault, from: vaultJl, to: ownerJl } as any).rpc(), "");
    const amt = await bal(vaultJl);
    await ownerProg.methods.withdraw(new BN(amt.toString())).accounts({ owner: owner.publicKey, vault, from: vaultJl, to: ownerJl } as any).rpc();
    assert.equal(await bal(ownerJl), amt);
  });

  await t.test("second venue: Kamino Lend USDC reserve, deposit then redeem through the vault", async () => {
    await ownerProg.methods.setYield([{ program: JLEND_PROGRAM, receiptMint: JL_USDC }, { program: KLEND_PROGRAM, receiptMint: K_USDC_CMINT }], 20, 2)
      .accounts({ owner: owner.publicKey, vault } as any).rpc();
    const vaultK = getAssociatedTokenAddressSync(K_USDC_CMINT, vault, true);
    await ownerP.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, vaultK, vault, K_USDC_CMINT)));
    const kmove = async (dir: "deposit" | "withdraw", amount: bigint, minOut: bigint) => {
      const ix = kaminoIx(vault, dir, amount);
      return agentProg.methods.rebalance(1, dir === "deposit" ? { deposit: {} } : { withdraw: {} }, new BN(amount.toString()), new BN(minOut.toString()), Buffer.from(ix.data))
        .accountsStrict({ agent: agent.publicKey, vault, yieldConfig: yieldCfg, vaultQuote: vaultUsdc, vaultReceipt: vaultK, lendingProgram: KLEND_PROGRAM })
        .remainingAccounts(ix.keys.map(k => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: false })))
        .preInstructions([kaminoRefreshIx()]).rpc();
    };
    await sleep(2100);
    const usdc0 = await bal(vaultUsdc);
    await kmove("deposit", 5_000_000n, 3_000_000n);
    const k = await bal(vaultK);
    const spent = usdc0 - await bal(vaultUsdc);
    assert.ok(spent <= 5_000_000n && spent >= 4_999_990n, `spent ${spent}`); // Kamino rounds to whole collateral units
    assert.ok(k > 3_000_000n && k < 5_000_000n, `kUSDC ${k}`);
    await sleep(2100);
    await kmove("withdraw", k, 4_990_000n);   // redeem all collateral back to USDC (rounding <= 1 base unit)
    assert.equal(await bal(vaultK), 0n);
    assert.ok(await bal(vaultUsdc) >= usdc0 - 2n);
  });

  await t.test("owner unwinds everything and gets all rent back (setup is a refundable deposit)", async () => {
    const vaultK = getAssociatedTokenAddressSync(K_USDC_CMINT, vault, true);
    const usdc = await bal(vaultUsdc);
    await ownerProg.methods.withdraw(new BN(usdc.toString())).accounts({ owner: owner.publicKey, vault, from: vaultUsdc, to: ownerUsdc } as any).rpc();
    const before = await conn.getBalance(owner.publicKey);
    const rent = (await Promise.all([vaultUsdc, vaultBase, vaultJl, vaultK, vault, yieldCfg].map(a => conn.getBalance(a)))).reduce((a, b) => a + b, 0);
    for (const a of [vaultUsdc, vaultBase, vaultJl, vaultK])
      await ownerProg.methods.closeToken().accounts({ owner: owner.publicKey, vault, account: a } as any).rpc();
    await ownerProg.methods.closeYield().accounts({ owner: owner.publicKey, vault } as any).rpc();
    await ownerProg.methods.closeVault().accounts({ owner: owner.publicKey } as any).rpc();
    const after = await conn.getBalance(owner.publicKey);
    const diff = after - before - (rent - 6 * 5000);
    assert.ok(Math.abs(diff) < 1000, `all rent returned minus 6 tx fees (off by ${diff} lamports)`);
    assert.equal(await conn.getAccountInfo(vault), null);
  });
});
