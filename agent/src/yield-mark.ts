// Marks the fork position to MAINNET. The position (receipt-token shares) was opened by the real lending programs on
// the mainnet fork; this values those exact shares with the live mainnet exchange rate, i.e. what the same shares are
// worth on mainnet now. Fees are the real fees the fork transactions paid. No validator needs to be running.
//   npx tsx agent/src/yield-mark.ts
import { Connection } from "@solana/web3.js";
import { readFileSync, appendFileSync } from "node:fs";
import { jlendState } from "./jlend.js";
import { kaminoState } from "./kamino.js";

const pos = JSON.parse(readFileSync("data/fork-position.json", "utf8"));
const main = new Connection(process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const per = pos.venue === 0 ? (await jlendState(main)).assetsPerShare : (await kaminoState(main)).assetsPerShare;
const valueUsd = pos.shares / 1e6 * per - pos.exitRoundingUsd;
const feesUsd = pos.feeLamports / 1e9 * pos.solUsd;
const hours = (Date.now() - Date.parse(pos.entryAt)) / 3.6e6;
const out = { at: new Date().toISOString(), hours: +hours.toFixed(2), perShare: per, valueUsd: +valueUsd.toFixed(7),
  interestUsd: +(valueUsd - pos.depositedUsd).toFixed(7), feesUsd: +feesUsd.toFixed(7), netUsd: +(valueUsd - pos.depositedUsd - feesUsd).toFixed(7),
  netIfClosedNowUsd: +(valueUsd - pos.depositedUsd - feesUsd - (pos.exitFeeLamports ?? 0) / 1e9 * pos.solUsd).toFixed(7),
  annualizedGrossPct: +(((valueUsd / pos.depositedUsd) ** (8760 / hours) - 1) * 100).toFixed(2) };
appendFileSync("data/fork-mark.jsonl", JSON.stringify(out) + "\n");
console.log(out);
