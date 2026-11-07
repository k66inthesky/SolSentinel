// SolSentinel Yield: autonomous stablecoin yield router. USDC sits in the Sentinel Vault (a PDA); the agent key can
// only move it between the vault's own USDC account and whitelisted lending venues (Jupiter Lend, Kamino Lend).
//
//   npm run yield -- --mode fork      # local mainnet fork (npm run validator:fork + npm run yield:deploy -- --mode fork)
//   npm run yield -- --mode mainnet   # real USDC (owner funds the vault with npm run yield:deploy -- --mode mainnet)
//
// Loop: every TICK it values the vault on-chain; every DECIDE interval it fetches trailing realized yields, runs the
// deterministic router, asks Claude to review, and (if a move is approved) sends guarded rebalance transactions.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadKeypair, sha256 } from "./chain.js";
import { decide, fetchRates, RouterDecision, VenueRates } from "./router.js";
import { YieldBrain, ReviewT } from "./yield-brain.js";
import { IDLE, Nav, VENUES, YieldChain } from "./yield-chain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : (process.env[k.toUpperCase().replace(/-/g, "_")] ?? d); };
const MODE = arg("mode", "fork") as "fork" | "mainnet";
const RPC = process.env.RPC_URL ?? (MODE === "fork" ? "http://127.0.0.1:8899" : "https://api.mainnet-beta.solana.com");
const PORT = +arg("port", "8788");
const TICK_MS = +arg("tick-seconds", "30") * 1000;
const DECIDE_MS = +arg("decide-minutes", MODE === "fork" ? "2" : "360") * 60_000;
const PRIORITY = +arg("priority", "1000");
const SOL_USD_FALLBACK = 160;

const DIRECT = arg("direct", "0") === "1" || process.argv.includes("--direct");
const MAX_MOVES_PER_DAY = 6, MIN_MOVE_INTERVAL_MS = +arg("min-interval-seconds", "3600") * 1000; // direct-mode copies of the vault's limits
const dep = JSON.parse(readFileSync(join(ROOT, "deployments", `yield-${MODE}${DIRECT ? "-direct" : ""}.json`), "utf8"));
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? `${homedir()}/.config/solana/agent.json`);
const conn = new Connection(RPC, "confirmed");
const yc = new YieldChain(conn, agent, new PublicKey(dep.owner), PRIORITY, DIRECT);
const brain = new YieldBrain();
mkdirSync(join(ROOT, "data"), { recursive: true });
const JOURNAL = join(ROOT, "data", `yield-${MODE}${DIRECT ? "-direct" : ""}.jsonl`);
const journal = (o: object) => appendFileSync(JOURNAL, JSON.stringify(o) + "\n");

interface Decision { ts: number; navUsd: number; current: number; proposal: RouterDecision; review: ReviewT; action: string; hash: string; sigs: string[]; feesLamports: number; error?: string }
const S = {
  mode: MODE, direct: DIRECT, startedAt: Date.now(), vault: yc.vault.toBase58(), owner: dep.owner, agent: agent.publicKey.toBase58(),
  deposited: dep.depositedUsd as number, startAgentLamports: 0, solUsd: SOL_USD_FALLBACK,
  nav: null as (Omit<Nav, "usdc" | "shares"> & { usdc: string; shares: string[] }) | null,
  navHistory: [] as { ts: number; navUsd: number }[], rates: [] as VenueRates[], ratesAt: 0,
  decisions: [] as Decision[], lastDecideAt: 0, busy: false,
  pnl: { grossUsd: 0, feesUsd: 0, netUsd: 0 },
};

async function solPrice() {
  try { const j: any = await (await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112")).json(); return +j.So11111111111111111111111111111111111111112.usdPrice || SOL_USD_FALLBACK; }
  catch { return SOL_USD_FALLBACK; }
}

async function value() {
  const n = await yc.nav();
  S.nav = { ...n, usdc: n.usdc.toString(), shares: n.shares.map(String) };
  S.navHistory.push({ ts: Date.now(), navUsd: n.navUsd }); if (S.navHistory.length > 5000) S.navHistory.shift();
  // Fees are the agent wallet's SOL spend since deployment (setup txs by the owner are listed in the deployment file).
  // In direct mode the agent wallet also pays rent for receipt-token accounts: that is refundable (closed on exit), so it is added back.
  const rentHeld = DIRECT ? (await conn.getMultipleAccountsInfo(yc.receiptAtas)).reduce((a, x) => a + (x?.lamports ?? 0), 0) : 0;
  const feesUsd = (S.startAgentLamports - n.agentLamports - rentHeld) / LAMPORTS_PER_SOL * S.solUsd + (dep.setupFeesUsd ?? 0);
  S.pnl = { grossUsd: n.navUsd - S.deposited, feesUsd, netUsd: n.navUsd - S.deposited - feesUsd };
  return n;
}

async function decideAndAct() {
  if (S.busy) return; S.busy = true;
  try {
    if (Date.now() - S.ratesAt > 3_600_000 || !S.rates.length) { S.rates = await fetchRates(); S.ratesAt = Date.now(); S.solUsd = await solPrice(); }
    const n = await value();
    const txUsd = yc.txCostLamports() / LAMPORTS_PER_SOL * S.solUsd;
    const switchCostUsd = 2 * txUsd + 2e-6; // exit tx + enter tx (+ Kamino rounding)
    const proposal = decide({ venues: S.rates, current: n.current === IDLE ? null : n.current, navUsd: n.navUsd, switchCostUsd });
    const review = await brain.review({
      ts: new Date().toISOString(), navUsd: +n.navUsd.toFixed(6), current: n.current === IDLE ? "idle USDC" : VENUES[n.current].name,
      proposal, venues: S.rates, switchCostUsd,
      recentDecisions: S.decisions.slice(-5).map(d => ({ ts: new Date(d.ts).toISOString(), action: d.action, reason: d.proposal.reason })),
    });
    let target = proposal.switch ? proposal.target : n.current;
    if (review.verdict === "hold") target = n.current;
    if (review.verdict === "exit_to_idle") target = IDLE;
    // Dust guard: when idle USDC is tiny relative to fees, depositing it is not worth a transaction.
    const idleWorthMoving = n.idleUsd > 0.01 && n.idleUsd * (S.rates.find(r => r.idx === target)?.trailDailyRet ?? 0) * 14 > txUsd;
    const action = target === n.current ? (target !== IDLE && idleWorthMoving ? "top-up" : "hold") : target === IDLE ? "exit" : n.current === IDLE ? "enter" : "switch";
    const rec = { ts: Date.now(), navUsd: n.navUsd, current: n.current, proposal, review, action };
    const reasonJson = JSON.stringify(rec);
    const d: Decision = { ...rec, hash: sha256(reasonJson).toString("hex"), sigs: [], feesLamports: 0 };
    try {
      if (DIRECT && action !== "hold") {
        const moves = S.decisions.filter(x => x.sigs.length && Date.now() - x.ts < 86_400_000);
        if (moves.length >= MAX_MOVES_PER_DAY) throw new Error("guard: TooManyTrades (moves per day)");
        if (moves.length && Date.now() - moves[moves.length - 1].ts < MIN_MOVE_INTERVAL_MS) throw new Error("guard: Cooldown");
      }
      const actCode = { hold: 0, enter: 1, "top-up": 1, switch: 2, exit: 3 }[action]!;
      if (action !== "hold") {
        if (n.current !== IDLE && target !== n.current && n.shares[n.current] > 0n) {
          const ex = await yc.exitIxs(n.current, n);
          const r = await yc.send([...ex.ixs, await yc.logIx(target, actCode, n.navUsd, reasonJson)], ex.guard);
          d.sigs.push(r.sig); d.feesLamports += r.feeLamports;
        }
        if (target !== IDLE) {
          const n2 = await yc.nav();
          if (n2.usdc > 0n) {
            const en = await yc.enterIxs(target, n2.usdc, n2);
            if (!d.sigs.length) en.ixs.push(await yc.logIx(target, actCode, n.navUsd, reasonJson));
            const r = await yc.send(en.ixs, en.guard); d.sigs.push(r.sig); d.feesLamports += r.feeLamports;
          }
        }
      }
      // A "hold" is journaled off-chain only (hash kept). Logging every hold on-chain would cost more than $10 earns.
    } catch (e) { d.error = (e as Error).message.slice(0, 400); }
    S.decisions.push(d); if (S.decisions.length > 200) S.decisions.shift();
    journal({ type: "decision", ...d, reasonJson });
    console.log(`[${new Date().toISOString()}] ${action.toUpperCase()} nav $${n.navUsd.toFixed(6)} | ${proposal.reason} | review ${review.source}:${review.verdict}${d.error ? " | ERROR " + d.error : ""}${d.sigs.length ? " | " + d.sigs.join(",") : ""}`);
    await value();
  } catch (e) { console.error("decide failed:", (e as Error).message); }
  finally { S.lastDecideAt = Date.now(); S.busy = false; }
}

const DASH = join(ROOT, "dashboard", "yield.html");
createServer((req, res) => {
  if (req.url?.startsWith("/api/state")) {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ...S, nextDecideInMs: Math.max(0, S.lastDecideAt + DECIDE_MS - Date.now()), venues: VENUES.map(v => ({ idx: v.idx, name: v.name, program: v.program.toBase58(), receipt: v.receipt.toBase58() })), cluster: MODE === "fork" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC)}` : "" }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }); res.end(existsSync(DASH) ? readFileSync(DASH) : "dashboard missing");
}).listen(process.argv.includes("--once") ? 0 : PORT, () => console.log(`dashboard http://localhost:${PORT}  mode=${MODE} vault=${S.vault}`));

// restore decision history (rate limits and the dashboard survive restarts)
if (existsSync(JOURNAL)) for (const l of readFileSync(JOURNAL, "utf8").split("\n")) { if (!l) continue; try { const o = JSON.parse(l); if (o.type === "decision") { delete o.reasonJson; S.decisions.push(o); } } catch {} }
S.startAgentLamports = dep.agentLamportsAtDeploy ?? (await conn.getBalance(agent.publicKey));
S.solUsd = await solPrice();
await value();
await decideAndAct();
// --once: one decision then exit. The money keeps earning inside the lending program while no process runs, so a
// scheduler (cron / scheduled task) can call this every few hours instead of keeping a server up.
if (process.argv.includes("--once")) {
  journal({ type: "mark", ts: Date.now(), navUsd: S.nav?.navUsd, pnl: S.pnl });
  console.log(JSON.stringify({ navUsd: S.nav?.navUsd, pnl: S.pnl }));
  process.exit(0);
}
setInterval(() => value().catch(e => console.error("value:", e.message)), TICK_MS);
setInterval(decideAndAct, DECIDE_MS);
