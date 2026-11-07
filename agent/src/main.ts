// SolSentinel agent: dual-speed autonomous SOL/USDC trader guarded by an on-chain vault.
//
//   npm run agent -- --mode paper            # mainnet prices, Jupiter quotes, no funds
//   npm run agent -- --mode local            # trades through the vault on a local validator
//   npm run agent -- --mode devnet           # same, on devnet (needs deploy: npm run deploy:devnet)
//   npm run agent -- --mode mainnet          # real funds via Jupiter CPI (small balance only!)
//   add  --profile demo   for looser entry filters so a short demo shows trades.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bar, DEFAULT_PARAMS, Levels, Params, Position, clampParams, computeLevels, minBars, onTick, Regime } from "./strategy.js";
import { DEFAULT_POLICY, Policy, RiskGate } from "./risk.js";
import { Brain, BrainDecisionT, snapshot } from "./brain.js";
import { BarBuilder, PythFeed, Tick, fetchHistory } from "./feed.js";
import { quote, USDC_MINT, WSOL_MINT, vaultSwapTx, sendVersioned } from "./jupiter.js";
import { SentinelChain, loadDeployment, loadKeypair, sha256 } from "./chain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : (process.env[k.toUpperCase()] ?? d); };
const MODE = arg("mode", "paper") as "paper" | "local" | "devnet" | "mainnet";
const PROFILE = arg("profile", "prod");
const PORT = +arg("port", "8787");
const BRAIN_EVERY_MS = +arg("brain-minutes", PROFILE === "demo" ? "3" : "10") * 60_000;
const PRICE_RPC = process.env.PRICE_RPC ?? "https://api.mainnet-beta.solana.com";
const EXEC_RPC = process.env.RPC_URL ?? { paper: "", local: "http://127.0.0.1:8899", devnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" }[MODE];
const PRIORITY = +(process.env.PRIORITY_MICROLAMPORTS ?? (MODE === "mainnet" ? 200_000 : 10_000));
const CLUSTER_PARAM = MODE === "devnet" ? "?cluster=devnet" : MODE === "local" ? `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}` : "";

// prod: the backtested parameters. demo: looser filters so a 10-minute demo shows trades.
// smoke: enters on almost any uptick and exits within minutes; for checking the pipeline end to end.
let params: Params = PROFILE === "smoke"
  ? { ...DEFAULT_PARAMS, breakoutLookback: 1, breakoutAtrK: 0, minEdgeMult: 0, erTrend: 0, tpAtr: 0.5, trailAtr: 0.5, maxHoldMs: 2 * 60_000 }
  : PROFILE === "demo"
  ? { ...DEFAULT_PARAMS, minEdgeMult: 0.1, breakoutLookback: 5, breakoutAtrK: 0, erTrend: 0.2, erRange: 0.2, bbEntry: 1.0, tpAtr: 1.5, maxHoldMs: 10 * 60_000 }
  : { ...DEFAULT_PARAMS };
const policy: Policy = { ...DEFAULT_POLICY };

// ---------- state ----------
interface TradeRec { id: number; side: "buy" | "sell"; mode: string; px: number; fillPx: number; qty: number; usd: number; pnlUsd?: number; why: string; ts: number; sig?: string; latency: { signalToSentMs: number; confirmMs: number; quoteMs?: number }; decisionHash: string }
const S = {
  mode: MODE, profile: PROFILE, startedAt: Date.now(),
  tick: null as Tick | null, tickAgeMs: 0, ticks: 0,
  levels: null as Levels | null, regimeOverride: undefined as Regime | undefined, paused: false,
  pos: null as Position | null, cash: 10, startEquity: 10,
  trades: [] as TradeRec[], decisions: [] as (BrainDecisionT & { hash: string; ts: number; onchainSig?: string })[],
  rejections: [] as { ts: number; why: string }[], vault: null as any, explorer: { vault: "", cluster: CLUSTER_PARAM },
  busy: false,
};
const gate = new RiskGate(policy);
const brain = new Brain();
mkdirSync(join(ROOT, "data"), { recursive: true });
const JOURNAL = join(ROOT, "data", `journal-${MODE}.jsonl`);
const journal = (o: object) => appendFileSync(JOURNAL, JSON.stringify(o) + "\n");

// ---------- chain wiring ----------
let chain: SentinelChain | null = null;
async function initChain() {
  if (MODE === "paper") return;
  const dep = loadDeployment(join(ROOT, `deployments/${MODE}.json`));
  if (!dep) throw new Error(`no deployments/${MODE}.json; run: npm run deploy:${MODE}`);
  const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? "~/.config/solana/agent.json");
  chain = new SentinelChain(new Connection(EXEC_RPC, "confirmed"), agent, dep, PRIORITY);
  S.explorer.vault = dep.vault;
  await refreshVault();
}
async function refreshVault() {
  if (!chain) return;
  const [st, bal] = await Promise.all([chain.vaultState(), chain.balances()]);
  S.vault = {
    address: chain.vault.toBase58(), quote: bal.quote, base: bal.base, paused: st.paused,
    tradesToday: st.tradesToday, realizedPnlToday: st.realizedPnlToday.toNumber() / 1e6, totalTrades: st.totalTrades.toNumber(),
    totalRealizedPnl: st.totalRealizedPnl.toNumber() / 1e6, decisions: st.decisions.toNumber(), halted: st.haltedDay.toNumber() === st.day.toNumber(),
    policy: { maxTradeUsd: st.policy.maxTradeQuote.toNumber() / 1e6, maxTradesPerDay: st.policy.maxTradesPerDay, dailyLossLimitUsd: st.policy.dailyLossLimitQuote.toNumber() / 1e6, cooldownSecs: st.policy.cooldownSecs },
    lastDecisionHash: Buffer.from(st.lastDecisionHash).toString("hex"),
  };
  S.paused = st.paused;
  if (MODE !== "paper") S.cash = bal.quote;
  // the vault is the source of truth for the cooldown, even across agent restarts
  gate.lastTradeTs = Math.max(gate.lastTradeTs, st.lastTradeTs.toNumber() * 1000);
}

// ---------- slow brain ----------
async function think(bars: Bar[]) {
  const recent = S.trades.filter(t => t.side === "sell").slice(-5).map(t => ({ mode: t.mode, pnlPct: +((t.pnlUsd ?? 0) / Math.max(t.usd, 1e-9) * 100).toFixed(3), why: t.why }));
  const d = await brain.decide(snapshot(bars, params, recent, gate.pnlToday));
  const patch = Object.fromEntries(Object.entries(d.param_patch).filter(([, v]) => v !== null)) as Partial<Params>;
  params = clampParams(params, patch);
  S.regimeOverride = d.source === "llm" ? d.regime : undefined;
  S.paused = d.pause_trading || (S.vault?.paused ?? false);
  const reasonJson = JSON.stringify({ regime: d.regime, pause: d.pause_trading, patch, reasoning: d.reasoning, source: d.source, model: d.model, snapshot: d.snapshot });
  const hash = sha256(reasonJson).toString("hex");
  const rec = { ...d, hash, ts: Date.now() } as (typeof S.decisions)[number];
  if (chain) {
    try { rec.onchainSig = (await chain.sendTimed([await chain.logDecisionIx(d.regime, d.pause_trading ? "pause" : Object.keys(patch).length ? "retune" : "hold", d.snapshot.price, reasonJson)])).sig; }
    catch (e) { console.error("[brain] log_decision failed", (e as Error).message); }
  }
  S.decisions.push(rec); if (S.decisions.length > 50) S.decisions.shift();
  journal({ type: "decision", ts: rec.ts, hash, reasonJson, onchainSig: rec.onchainSig });
  console.log(`[brain] ${d.source} regime=${d.regime} pause=${d.pause_trading} (${d.latencyMs.toFixed(0)}ms) ${d.reasoning}`);
}

// ---------- execution ----------
async function execute(kind: "enter" | "exit", px: number, why: string, signalTs: number, mode?: "trend" | "range", tp?: number, stop?: number) {
  const reasonJson = JSON.stringify({ kind, px, why, mode, tp, stop, regime: S.levels?.regime, params, ts: signalTs });
  const decisionHash = sha256(reasonJson).toString("hex");
  const side = kind === "enter" ? "buy" : "sell";
  let fillPx = px, qty = 0, usd = 0, sig: string | undefined, quoteMs: number | undefined, confirmMs = 0;

  if (MODE === "paper") {
    const tq = performance.now();
    if (side === "buy") {
      usd = Math.min(policy.maxTradeUsd, S.cash);
      const q = await quote(USDC_MINT, WSOL_MINT, BigInt(Math.round(usd * 1e6)));
      qty = Number(q.outAmount) / 1e9; fillPx = usd / qty;
    } else {
      qty = S.pos!.qty;
      const q = await quote(WSOL_MINT, USDC_MINT, BigInt(Math.floor(qty * 1e9)));
      usd = Number(q.outAmount) / 1e6; fillPx = usd / qty;
    }
    quoteMs = performance.now() - tq;
  } else if (MODE === "mainnet") {
    const tq = performance.now();
    const bal = await chain!.balances();
    const q = side === "buy"
      ? await quote(USDC_MINT, WSOL_MINT, BigInt(Math.round(Math.min(policy.maxTradeUsd, bal.quote) * 1e6)))
      : await quote(WSOL_MINT, USDC_MINT, (() => { const r = BigInt(Math.floor(S.pos!.qty * 1e9)); return r < bal.baseRaw ? r : bal.baseRaw; })());
    quoteMs = performance.now() - tq;
    const { tx, blockhash, lastValidBlockHeight } = await vaultSwapTx(chain!, side, q, PRIORITY);
    const r = await sendVersioned(chain!.conn, tx, blockhash, lastValidBlockHeight);
    sig = r.sig; confirmMs = r.confirmMs;
  } else {
    const bal = await chain!.balances();
    const posRaw = S.pos ? BigInt(Math.floor(S.pos.qty * 1e9)) : 0n;
    const amountIn = side === "buy" ? BigInt(Math.round(Math.min(policy.maxTradeUsd, bal.quote) * 1e6)) : (posRaw < bal.baseRaw ? posRaw : bal.baseRaw);
    const expectedOut = side === "buy" ? Number(amountIn) / 1e6 / px * 1e9 : Number(amountIn) / 1e9 * px * 1e6;
    const minOut = BigInt(Math.floor(expectedOut * 0.995));
    const ixs = [await chain!.logDecisionIx(S.levels?.regime ?? "halt", side, px, reasonJson), ...await chain!.mockSwapIxs(side, amountIn, minOut, px)];
    const before = bal;
    const r = await chain!.sendTimed(ixs);
    sig = r.sig; confirmMs = r.confirmMs;
    const after = await chain!.balances();
    if (side === "buy") { usd = before.quote - after.quote; qty = after.base - before.base; }
    else { qty = before.base - after.base; usd = after.quote - before.quote; }
    fillPx = usd / qty;
  }
  const signalToSentMs = performance.now() - signalTs - confirmMs;
  const rec: TradeRec = { id: S.trades.length + 1, side, mode: mode ?? S.pos?.mode ?? "?", px, fillPx, qty, usd, why, ts: Date.now(), sig, latency: { signalToSentMs, confirmMs, quoteMs }, decisionHash };
  if (side === "buy") {
    S.pos = { mode: mode!, entryPx: fillPx, entryTs: Date.now(), qty, costUsd: usd, tp: tp!, stop: stop!, peak: px };
    S.cash -= MODE === "paper" ? usd : 0;
    gate.recordEntry(Date.now());
  } else {
    rec.pnlUsd = usd - S.pos!.costUsd;
    if (MODE === "paper") S.cash += usd;
    gate.recordExit(Date.now(), rec.pnlUsd);
    S.pos = null;
  }
  S.trades.push(rec);
  journal({ type: "trade", ...rec, reasonJson });
  console.log(`[trade] ${side} ${qty.toFixed(5)} SOL @ ${fillPx.toFixed(3)} (${why}) sent in ${signalToSentMs.toFixed(0)}ms, confirmed +${confirmMs.toFixed(0)}ms ${sig ?? ""}`);
  await refreshVault().catch(() => {});
}

// ---------- fast path ----------
function onPrice(t: Tick, builder: BarBuilder) {
  S.tick = t; S.ticks++; S.tickAgeMs = t.recvTs - t.publishTime * 1000; // oracle staleness
  builder.push(t.px, t.recvTs);
  if (S.busy) return;
  const sig = onTick(t.px, t.recvTs, S.paused && !S.pos ? null : S.levels, S.pos, params);
  if (!sig) return;
  if (sig.kind === "enter") {
    if (Math.abs(t.oracleDevPct) > 0.5) { S.rejections.push({ ts: Date.now(), why: `oracle deviation ${t.oracleDevPct.toFixed(2)}%` }); return; }
    const ok = gate.canEnter(Date.now(), Math.min(policy.maxTradeUsd, S.cash));
    if (!ok.ok) { if (S.rejections.at(-1)?.why !== ok.why) S.rejections.push({ ts: Date.now(), why: ok.why! }); return; }
    if (S.vault?.halted) return;
  }
  const t0 = performance.now();
  S.busy = true;
  execute(sig.kind, t.px, sig.why, t0, sig.kind === "enter" ? sig.mode : undefined, sig.kind === "enter" ? sig.tp : undefined, sig.kind === "enter" ? sig.stop : undefined)
    .catch(e => {
      console.error("[exec]", e.message);
      const m = /Error Code: (\w+)/.exec(e.message);
      S.rejections.push({ ts: Date.now(), why: m ? `vault rejected: ${m[1]}` : `exec: ${e.message.slice(0, 160)}` });
      gate.lastTradeTs = Date.now(); // back off for one cooldown instead of retrying every tick
    })
    .finally(() => { S.busy = false; });
}

// ---------- server ----------
function serve() {
  const html = () => readFileSync(join(ROOT, "dashboard/index.html"));
  createServer((req, res) => {
    if (req.url?.startsWith("/api/state")) {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      const eq = S.cash + (S.pos ? S.pos.qty * (S.tick?.px ?? S.pos.entryPx) : 0) + (MODE !== "paper" && S.vault ? 0 : 0);
      const equity = MODE === "paper" ? eq : (S.vault ? S.vault.quote + S.vault.base * (S.tick?.px ?? 0) : eq);
      res.end(JSON.stringify({ ...S, bars: builder.bars.slice(-120), curBar: builder.cur, params, policy, equity, now: Date.now() }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html());
  }).listen(PORT, () => console.log(`[ui] http://localhost:${PORT}`));
}

let builder: BarBuilder;
async function main() {
  console.log(`SolSentinel mode=${MODE} profile=${PROFILE} brain=${brain.client ? brain.model : "rules-only"}`);
  await initChain();
  const hist = await fetchHistory(240);
  builder = new BarBuilder(hist, (b) => {
    const bars = builder.bars;
    if (bars.length >= minBars(params)) S.levels = computeLevels(bars.slice(-200), params, S.regimeOverride);
  });
  S.levels = computeLevels(hist.slice(-200), params);
  serve();
  await think(builder.bars);
  setInterval(() => think(builder.bars).catch(e => console.error("[brain]", e)), BRAIN_EVERY_MS);
  setInterval(() => refreshVault().catch(() => {}), 10_000);
  new PythFeed(new Connection(PRICE_RPC, "processed"), t => onPrice(t, builder), +(process.env.POLL_MS ?? 500)).start();
}
main().catch(e => { console.error(e); process.exit(1); });
