"""Walk-forward test on 6 years of hourly data (SOL/USDT, BTC/USDT from Binance).

Procedure (fixed BEFORE looking at results):
  every 90 days: pick the single config with the best Sharpe over the previous 365 days
  (min 10 trades), trade it for the next 90 days. Only those next-90-day returns are reported.
All signals are causal (decided at bar close, held from the next bar). Costs on every switch.
"""
import itertools, json, sys
import numpy as np
from lab import ema, roll_max, roll_min, rsi, FEE_BPS, FIXED_USD, TRADE_USD

sol = np.load("SOLUSDT_1h.npy"); btc = np.load("BTCUSDT_1h.npy")
common = np.intersect1d(sol[:, 0], btc[:, 0])
sol = sol[np.isin(sol[:, 0], common)]; btc = btc[np.isin(btc[:, 0], common)]
T = sol[:, 0]; C = sol[:, 4]; N = len(C)
COST = FEE_BPS / 1e4 + FIXED_USD / TRADE_USD
if len(sys.argv) > 1: COST *= float(sys.argv[1])   # cost multiplier for sensitivity

def agg(a, k):
    # blocks aligned to UTC k-hour boundaries (same as the live agent); leading partial block dropped
    off = int(((k - (a[0, 0] // 3_600_000) % k) % k))
    a = a[off:]
    n = len(a) // k * k; b = a[:n].reshape(-1, k, a.shape[1])
    return dict(c=b[:, -1, 4], h=b[:, :, 2].max(1), l=b[:, :, 3].min(1))

def expand(pos_k, k):
    off = int(((k - (T[0] // 3_600_000) % k) % k))
    return np.concatenate([np.zeros(off), _expand(pos_k, k)])[:N]

def _expand(pos_k, k):
    """decision at close of k-bar j applies to hourly bars of k-bar j+1 -> encode as hourly decisions."""
    out = np.zeros(N)
    out[: len(pos_k) * k] = np.repeat(pos_k, k)  # decision known at close of block j, held for hours of block j+1
    # shift so that hourly 'decision at i' equals the block decision only from the block's last hour on
    res = np.zeros(N)
    for j in range(len(pos_k)):
        s = j * k + k - 1
        res[s: s + k] = pos_k[j]
    return res[:N]

def stateful(entry, exit_):
    pos = np.zeros(len(entry)); p = 0
    for i in range(len(entry)):
        if p == 0 and entry[i]: p = 1
        elif p == 1 and exit_[i]: p = 0
        pos[i] = p
    return pos

configs = {}
for tf, k in [("1h", 1), ("4h", 4), ("1d", 24)]:
    s = agg(sol, k); b = agg(btc, k); c, h, l = s["c"], s["h"], s["l"]
    def add(name, cfg, pos): configs[json.dumps(dict(f=name, tf=tf, **cfg))] = expand(pos, k)
    for ne, nx in itertools.product([10, 20, 55], [5, 10, 20]):
        if nx > ne: continue
        hi = np.concatenate([[np.inf], roll_max(h, ne)[:-1]]); lo = np.concatenate([[-np.inf], roll_min(l, nx)[:-1]])
        add("donchian", dict(entry=ne, exit=nx), stateful(c > np.nan_to_num(hi, nan=np.inf), c < np.nan_to_num(lo, nan=-np.inf)))
    for f, sl in itertools.product([10, 20, 50], [50, 100, 200]):
        if f >= sl: continue
        add("ema_cross", dict(fast=f, slow=sl), (ema(c, f) > ema(c, sl)).astype(float))
    for lb in [12, 24, 48, 96]:
        r = np.zeros(len(c)); r[lb:] = c[lb:] / c[:-lb] - 1
        add("tsmom", dict(lb=lb), (r > 0).astype(float))
        for be in [50, 200]:
            add("btc_trend_mom", dict(lb=lb, btc_ema=be), ((b["c"] > ema(b["c"], be)) & (r > 0)).astype(float))
    if tf != "1d":
        for rn, buy, te in itertools.product([2, 5], [10, 20], [0, 200]):
            rr = rsi(c, rn); tr = (c > ema(c, te)) if te else np.ones(len(c), bool)
            add("rsi_mr", dict(rsi=rn, buy=buy, trend=te), stateful((rr < buy) & tr, rr > 60))

names = list(configs); P = np.array([configs[n] for n in names])        # [cfg, hour]
R = np.concatenate([[0.0], np.diff(C) / C[:-1]])
held = np.concatenate([np.zeros((len(P), 1)), P[:, :-1]], axis=1)
sw = np.abs(np.diff(np.concatenate([np.zeros((len(P), 1)), held], axis=1), axis=1))
NET = held * R - sw * COST                                                  # hourly net returns per config

def sharpe(x):
    d = x[: len(x) // 24 * 24].reshape(-1, 24).sum(1)
    return d.mean() / (d.std() + 1e-12) * np.sqrt(365)

H_TRAIN = int(float(sys.argv[2]) if len(sys.argv) > 2 else 365) * 24
H_STEP = int(float(sys.argv[3]) if len(sys.argv) > 3 else 90) * 24
oos = np.zeros(N); chosen = []
start = 365 * 24 + 200 * 24  # same OOS start for every train window, after warm-up  # leave 200 days of indicator warm-up
for s in range(start, N, H_STEP):
    tr = slice(s - H_TRAIN, s); te = slice(s, min(N, s + H_STEP))
    trades = sw[:, tr].sum(1) / 2
    sh = np.array([sharpe(NET[i, tr]) if trades[i] >= 10 else -99 for i in range(len(P))])
    i = int(sh.argmax())
    seg = NET[i, te].copy()
    # switching between configs at the boundary costs a trade if the holding changes
    if chosen and held[chosen[-1][0], s] != held[i, s]: seg[0] -= COST
    oos[te] = seg
    chosen.append((i, s))

o = oos[start:]; eq = np.exp(np.cumsum(np.log1p(o)))
bh = C[-1] / C[start] - 1
yrs = (T[-1] - T[start]) / 3.15576e10
print(f"cost per side {COST*1e4:.1f} bps | OOS period {np.datetime64(int(T[start]),'ms')} -> {np.datetime64(int(T[-1]),'ms')} ({yrs:.1f}y)")
print(f"walk-forward OOS: total {(eq[-1]-1)*100:+.1f}%  CAGR {(eq[-1]**(1/yrs)-1)*100:+.1f}%  sharpe {sharpe(o):.2f}  maxDD {(1-eq/np.maximum.accumulate(eq)).max()*100:.1f}%")
bhr = R[start:]; beq = np.cumprod(1 + bhr)
print(f"buy & hold SOL:   total {bh*100:+.1f}%  sharpe {sharpe(bhr):.2f}  maxDD {(1-beq/np.maximum.accumulate(beq)).max()*100:.1f}%")
print("\nper-window picks (OOS 90d return):")
for (i, s) in chosen:
    te = slice(s, min(N, s + H_STEP))
    print(f"  {np.datetime64(int(T[s]),'ms').astype('datetime64[D]')}  {(np.prod(1+oos[te])-1)*100:+6.1f}%   SOL {(C[min(N-1,s+H_STEP-1)]/C[s]-1)*100:+6.1f}%   {names[i]}")
json.dump(dict(names=names, chosen=[(names[i], int(T[s])) for i, s in chosen]), open("wf_chosen.json", "w"))
