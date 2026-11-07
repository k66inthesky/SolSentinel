"""Ensemble with realistic execution for a $10 vault: rebalance to the target fraction only when it
drifts >= BAND from the current holding; every rebalance pays FEE_BPS on the traded notional PLUS a
full fixed tx fee (not pro-rated)."""
import sys, json, numpy as np
band = float(sys.argv[2]) if len(sys.argv) > 2 else 0.2
equity0 = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0
sys.argv = [sys.argv[0], sys.argv[1] if len(sys.argv) > 1 else "1"]
exec(open("wf.py").read().split("names = list(configs)")[0])
mult = float(sys.argv[1]); fee = FEE_BPS / 1e4 * mult; fixed = FIXED_USD * mult
trend = [n for n in configs if json.loads(n)["f"] != "rsi_mr"]
TGT = np.mean([configs[n] for n in trend], axis=0)
def sim(sl):
    idx = np.arange(N)[sl]; usd, sol = equity0, 0.0; eqs = []; trades = 0; fees = 0.0
    cur = 0.0
    for i in idx:
        px = C[i]; eq = usd + sol * px
        if abs(TGT[i] - cur) >= band or (TGT[i] == 0 and cur > 0) or (TGT[i] == 1 and cur < 1):
            if abs(TGT[i] - cur) > 1e-9:
                want = TGT[i] * eq; have = sol * px; d = want - have
                c = abs(d) * fee + fixed; fees += c; trades += 1
                usd -= d + c; sol += d / px; cur = TGT[i]
        eqs.append(usd + sol * px)
    return np.array(eqs), trades, fees
def stats(sl, label):
    eq, n, f = sim(sl); r = C[sl]; d = np.diff(np.log(eq[::24])); sh = d.mean()/(d.std()+1e-12)*np.sqrt(365)
    print(f"{label:14s} {(eq[-1]/equity0-1)*100:+8.1f}%  sharpe {sh:5.2f}  maxDD {(1-eq/np.maximum.accumulate(eq)).max()*100:5.1f}%  trades {n:4d}  fees ${f:.3f} | SOL {(r[-1]/r[0]-1)*100:+7.1f}%")
print(f"band {band}, equity ${equity0}, fee {fee*1e4:.0f} bps + ${fixed:.4f}/tx")
start = 200 * 24
stats(slice(start, N), "full")
yrs = np.array([np.datetime64(int(t), 'ms').astype('datetime64[Y]').astype(int) + 1970 for t in T])
for y in range(2021, 2027):
    w = np.where((yrs == y) & (np.arange(N) >= start))[0]; stats(slice(w[0], w[-1] + 1), str(y))
stats(slice(N - 73*24, N), "last 73d")
