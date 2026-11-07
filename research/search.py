"""Grid search on TRAIN only; report validation for the top configs. Never touches the test split."""
import itertools, json, sys
import numpy as np
from lab import *

sol = load("SOLUSDT"); btc = load("BTCUSDT")
n = min(len(sol), len(btc)); sol = sol[-n:]; btc = btc[-n:]
assert (sol[:, 0] == btc[:, 0]).all()

TF = {"15m": 15, "1h": 60, "4h": 240}
results = []

def run(name, cfg, c, t, pos):
    tr, va, te = splits(len(c))
    a = evaluate(c, pos, t, tr); b = evaluate(c, pos, t, va)
    results.append(dict(name=name, cfg=cfg, train=a, val=b))

for tfn, k in TF.items():
    d = resample(sol, k); c, h, l, t = d["c"], d["h"], d["l"], d["t"]
    # 1. Donchian breakout: long on close > prior N-bar high, flat on close < prior M-bar low
    for ne, nx in itertools.product([10, 20, 40, 80], [5, 10, 20, 40]):
        if nx > ne: continue
        hi = np.concatenate([[np.nan], roll_max(h, ne)[:-1]]); lo = np.concatenate([[np.nan], roll_min(l, nx)[:-1]])
        pos = np.zeros(len(c)); p = 0
        for i in range(len(c)):
            if p == 0 and c[i] > hi[i]: p = 1
            elif p == 1 and c[i] < lo[i]: p = 0
            pos[i] = p
        run("donchian", dict(tf=tfn, entry=ne, exit=nx), c, t, pos)
    # 2. EMA crossover
    for f, s in itertools.product([5, 10, 20, 50], [20, 50, 100, 200]):
        if f >= s: continue
        run("ema_cross", dict(tf=tfn, fast=f, slow=s), c, t, (ema(c, f) > ema(c, s)).astype(float))
    # 3. time-series momentum
    for lb, thr in itertools.product([6, 12, 24, 48, 96], [0, 0.01, 0.02]):
        r = np.full(len(c), np.nan); r[lb:] = c[lb:] / c[:-lb] - 1
        run("tsmom", dict(tf=tfn, lookback=lb, thr=thr), c, t, (r > thr).astype(float))
    # 4. RSI mean reversion with trend filter
    for rn, buy, ex, tf_ema in itertools.product([2, 3, 5], [5, 10, 20], [50, 70], [0, 50, 200]):
        rr = rsi(c, rn); trend = (c > ema(c, tf_ema)) if tf_ema else np.ones(len(c), bool)
        pos = np.zeros(len(c)); p = 0
        for i in range(len(c)):
            if p == 0 and rr[i] < buy and trend[i]: p = 1
            elif p == 1 and rr[i] > ex: p = 0
            pos[i] = p
        run("rsi_mr", dict(tf=tfn, rsi=rn, buy=buy, exit=ex, trend_ema=tf_ema), c, t, pos)
    # 5. BTC-led trend: hold SOL when BTC is above its EMA and SOL momentum positive
    db = resample(btc, k)
    for be, lb in itertools.product([20, 50, 100], [6, 24]):
        r = np.full(len(c), np.nan); r[lb:] = c[lb:] / c[:-lb] - 1
        run("btc_filter_mom", dict(tf=tfn, btc_ema=be, lookback=lb), c, t, ((db["c"] > ema(db["c"], be)) & (r > 0)).astype(float))

def key(r):  # require activity, rank by train Sharpe
    return r["train"]["sharpe"] if r["train"]["trades"] >= 20 else -9
results.sort(key=key, reverse=True)
json.dump(results, open("search_results.json", "w"), default=float)
fmt = lambda s: f"ret {s['ret']*100:+6.1f}% sh {s['sharpe']:+5.2f} dd {s['mdd']*100:4.1f}% n {s['trades']:4d} exp {s['exposure']:.2f} bh {s['bh']*100:+6.1f}%"
print(f"{len(results)} configs. Top 25 by TRAIN sharpe:")
for r in results[:25]:
    print(f"{r['name']:15s} {json.dumps(r['cfg']):60s} TRAIN {fmt(r['train'])} | VAL {fmt(r['val'])}")
pos_both = [r for r in results if r["train"]["ret"] > 0 and r["val"]["ret"] > 0 and r["train"]["trades"] >= 20]
print(f"\nconfigs profitable in BOTH train and val: {len(pos_both)} / {len(results)}")
