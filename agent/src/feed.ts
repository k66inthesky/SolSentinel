// Market data.
//  - Live ticks: the Orca SOL/USDC Whirlpool account on mainnet (moves every slot it trades) plus the
//    Pyth SOL/USD price-update account as an oracle cross-check. Both read straight from chain in one
//    RPC call, polled every 400ms (~one slot).
//  - Warm-up history: last few hours of 1m klines from Binance's public data mirror.
import { Connection, PublicKey } from "@solana/web3.js";
import { Bar } from "./strategy.js";

export const PYTH_SOL_USD_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// Orca Whirlpool SOL/USDC (0.01% fee tier): the most liquid on-chain SOL/USDC pool. Its sqrt_price
// changes every slot it trades, so it is the fast tick source; Pyth is the oracle sanity check.
export const ORCA_SOL_USDC_WHIRLPOOL = new PublicKey("83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d");

export interface Tick { px: number; oraclePx: number; oracleDevPct: number; conf: number; publishTime: number; slot: number; recvTs: number }

export function whirlpoolPrice(d: Buffer): number {
  const sq = Number((d.readBigUInt64LE(73) << 64n) | d.readBigUInt64LE(65)) / 2 ** 64; // Q64.64 sqrt price
  return sq * sq * 1e3; // token A = SOL (9 dp), token B = USDC (6 dp)
}

export function parsePriceUpdateV2(d: Buffer): { px: number; conf: number; publishTime: number; postedSlot: number } {
  let o = 8 + 32;                         // discriminator + write_authority
  o += d[o] === 0 ? 2 : 1;                // VerificationLevel: Partial{u8} | Full
  o += 32;                                // feed_id
  const price = d.readBigInt64LE(o); o += 8;
  const conf = d.readBigUInt64LE(o); o += 8;
  const expo = d.readInt32LE(o); o += 4;
  const publishTime = Number(d.readBigInt64LE(o)); o += 8;
  o += 8 + 8 + 8;                         // prev_publish_time, ema_price, ema_conf
  const postedSlot = Number(d.readBigUInt64LE(o));
  const scale = 10 ** expo;
  return { px: Number(price) * scale, conf: Number(conf) * scale, publishTime, postedSlot };
}

export class PythFeed {
  private timer?: NodeJS.Timeout;
  private lastSlot = 0;
  constructor(private conn: Connection, private onTick: (t: Tick) => void, private pollMs = 400) {}

  /** One RPC round trip reads both the Pyth oracle and the Orca pool. */
  async readOnce(): Promise<Tick> {
    const r = await this.conn.getMultipleAccountsInfoAndContext([PYTH_SOL_USD_ACCOUNT, ORCA_SOL_USDC_WHIRLPOOL], "processed");
    const [pyth, orca] = r.value;
    if (!pyth || !orca) throw new Error("price accounts not found");
    const p = parsePriceUpdateV2(pyth.data as Buffer);
    const px = whirlpoolPrice(orca.data as Buffer);
    return { px, oraclePx: p.px, oracleDevPct: (px / p.px - 1) * 100, conf: p.conf, publishTime: p.publishTime, slot: r.context.slot, recvTs: Date.now() };
  }

  start() {
    const loop = async () => {
      try {
        const t = await this.readOnce();
        if (t.slot > this.lastSlot) { this.lastSlot = t.slot; this.onTick(t); }
      } catch (e) { console.error("[feed]", (e as Error).message); }
      this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }
  stop() { clearTimeout(this.timer); }
}

export async function fetchHistory(minutes = 240): Promise<Bar[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=${Math.min(1000, minutes)}`;
  const rows = await (await fetch(url)).json() as any[];
  // drop the still-forming last candle
  return rows.slice(0, -1).map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}

/** Aggregates ticks into 1-minute bars; calls onClose when a minute rolls over. */
export class BarBuilder {
  cur: Bar | null = null;
  constructor(public bars: Bar[], private onClose: (b: Bar) => void) {}
  push(px: number, ts: number) {
    const minute = Math.floor(ts / 60_000) * 60_000;
    const lastClosed = this.bars[this.bars.length - 1];
    if (lastClosed && minute <= lastClosed.t) return; // still inside a minute history already covers
    if (!this.cur || minute > this.cur.t) {
      if (this.cur) { this.bars.push(this.cur); if (this.bars.length > 1000) this.bars.shift(); this.onClose(this.cur); }
      this.cur = { t: minute, o: px, h: px, l: px, c: px, v: 0 };
    } else {
      this.cur.h = Math.max(this.cur.h, px); this.cur.l = Math.min(this.cur.l, px); this.cur.c = px;
    }
  }
}
