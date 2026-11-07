// Creates demo mints, the mock AMM pool and a Sentinel Vault funded with 10 demo-USDC.
//   npm run deploy:local   |   npm run deploy:devnet   (programs must already be deployed)
import { Connection, PublicKey } from "@solana/web3.js";
import { deployDemo, loadKeypair, saveDeployment } from "./chain.js";
import { PythFeed } from "./feed.js";
import { DEFAULT_POLICY } from "./risk.js";

const cluster = process.argv[2] ?? "local";
const rpc = cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";
const conn = new Connection(rpc, "confirmed");
const owner = loadKeypair(process.env.OWNER_KEYPAIR ?? "~/.config/solana/id.json");
const agent = loadKeypair(process.env.AGENT_KEYPAIR ?? "~/.config/solana/agent.json");
const price = (await new PythFeed(new Connection("https://api.mainnet-beta.solana.com"), () => {}).readOnce()).px;
console.log(`owner ${owner.publicKey.toBase58()} agent ${agent.publicKey.toBase58()} SOL/USD ${price}`);
const dep = await deployDemo(conn, owner, agent.publicKey, price, {
  maxTradeQuote: DEFAULT_POLICY.maxTradeUsd, maxTradesPerDay: DEFAULT_POLICY.maxTradesPerDay,
  dailyLossLimitQuote: DEFAULT_POLICY.dailyLossLimitUsd, cooldownSecs: DEFAULT_POLICY.cooldownMs / 1000,
}, 10, cluster);
saveDeployment(`deployments/${cluster}.json`, dep);
console.log(JSON.stringify(dep, null, 2));
