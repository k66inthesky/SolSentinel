"""Backtest of the exact two venues the vault integrates: Jupiter Lend Earn USDC and Kamino Lend main-market USDC.
Kamino daily return is REALIZED from the on-chain collateral exchange rate (net of protocol take rate);
Jupiter Lend uses DefiLlama's daily base APY (no reward APY counted).
Decision each day uses data up to yesterday only. Every cost is charged in USD at the vault size:
  - every on-chain tx: 5000 lamports base fee + 50k CU * 10k micro-lamports priority = 5500 lamports
  - a switch = 2 tx (exit tx with log_decision, enter tx) ; Kamino rounding 2 base units per move
  - initial deposit 1 tx; final withdrawal 1 tx; two receipt-token ATAs opened and later closed (2 tx to close;
    rent is refunded on close, so it is a deposit, not a cost)
SOL price for fees: $160 (conservative; higher SOL makes fees costlier)."""
import json, datetime as dt, sys
SOL_USD = 160.0; LAMPORTS_TX = 5000 + 400_000 * 1_000 // 1_000_000   # agent: 400k CU limit at 1000 micro-lamports
TX_USD = LAMPORTS_TX / 1e9 * SOL_USD
k = json.load(open("kamino_usdc.json"))["history"]
er = {dt.date.fromisoformat(x["timestamp"][:10]): float(x["metrics"]["exchangeRate"]) for x in k}
kd = sorted(er); kret = {kd[i]: er[kd[i-1]] / er[kd[i]] - 1 for i in range(1, len(kd))}
j = json.load(open("jlend_usdc.json"))["data"]
jret = {}
for x in j: jret[dt.date.fromisoformat(x["timestamp"][:10])] = (1 + x["apyBase"] / 100) ** (1 / 365) - 1
days = sorted(set(kret) & set(jret)); R = {"jlend": [jret[d] for d in days], "kamino": [kret[d] for d in days]}
print(f"{len(days)} common days {days[0]} -> {days[-1]};  tx cost ${TX_USD:.5f}")
def run(size, mode, LOOKBACK=7, PAYBACK=14):
    val = size; cur = None; sw = 0
    val -= 3 * TX_USD + TX_USD + 6 * TX_USD   # 3 setup txs + first deposit tx + 6 closing txs (rent itself is refunded)
    for i in range(LOOKBACK, len(days)):
        if mode in R: want = mode
        else:
            trail = {v: sum(R[v][i-LOOKBACK:i]) / LOOKBACK for v in R}
            best = max(trail, key=trail.get)
            want = cur or best
            if best != want and (trail[best] - trail[want]) * PAYBACK * val > 2 * TX_USD + 2e-6: want = best
        if cur is not None and want != cur: val -= 2 * TX_USD + 2e-6; sw += 1
        cur = want
        val *= 1 + R[cur][i]
    val -= TX_USD  # final withdrawal
    n = len(days) - LOOKBACK
    return (val / size) ** (365 / n) - 1, val - size, sw, n
for size in [10, 100, 1000]:
    print(f"\nvault ${size}:")
    for mode in ["jlend", "kamino", "router"]:
        a, pnl, sw, n = run(size, mode)
        print(f"  {mode:7s} net APY {a*100:5.2f}%   net PnL ${pnl:+.4f} over {n} days   switches {sw}")
# monthly breakdown for the router at $10

def daily_path(size, mode):
    # re-run router and record value per day to check worst rolling-30d window
    vals=[]; val=size; cur=None
    for i in range(7, len(days)):
        if mode in R: want=mode
        else:
            trail={v: sum(R[v][i-7:i])/7 for v in R}; best=max(trail,key=trail.get); want=cur or best
            if best!=want and (trail[best]-trail[want])*14*val > 2*TX_USD+2e-6: want=best
        if cur is not None and want!=cur: val-=2*TX_USD+2e-6
        cur=want; val*=1+R[cur][i]; vals.append(val)
    return vals
for mode in ["jlend","kamino","router"]:
    v=daily_path(10,mode); w=[v[i+30]/v[i]-1 for i in range(len(v)-30)]
    print(f"{mode:7s} worst 30d window {min(w)*100*365/30:+.2f}% ann.  best {max(w)*100*365/30:+.2f}%  negative windows {sum(x<0 for x in w)}/{len(w)}")
