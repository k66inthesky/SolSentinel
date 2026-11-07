"""Same no-fit ensemble but long/short (needs a perps venue): each config is +1 when its trend
signal is on, -1 when off. Extra cost: funding charged on |position| at FUND_APR (conservative:
charged on both longs and shorts, although shorts usually receive funding)."""
import sys, json, numpy as np
fund_apr = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
sys.argv = [sys.argv[0], sys.argv[1] if len(sys.argv) > 1 else "1"]
exec(open("wf.py").read().split("names = list(configs)")[0])
trend = [n for n in configs if json.loads(n)["f"] != "rsi_mr"]
P = np.mean([2 * configs[n] - 1 for n in trend], axis=0)
R = np.concatenate([[0.0], np.diff(C) / C[:-1]])
held = np.concatenate([[0.0], P[:-1]])
net = held * R - np.abs(np.diff(np.concatenate([[0.0], held]))) * COST - np.abs(held) * fund_apr / 8766
def stats(sl, label):
    o = net[sl]; r = R[sl]; eq = np.cumprod(1 + o); be = np.cumprod(1 + r)
    d = o[: len(o)//24*24].reshape(-1, 24).sum(1); sh = d.mean()/(d.std()+1e-12)*np.sqrt(365)
    print(f"{label:16s} L/S {(eq[-1]-1)*100:+8.1f}%  sharpe {sh:5.2f}  maxDD {(1-eq/np.maximum.accumulate(eq)).max()*100:5.1f}%  | SOL {(be[-1]-1)*100:+8.1f}%")
print(f"cost/side {COST*1e4:.1f} bps, funding {fund_apr*100:.0f}% APR on |pos|")
start = 200 * 24
stats(slice(start, N), "full")
yrs = np.array([np.datetime64(int(t), 'ms').astype('datetime64[Y]').astype(int) + 1970 for t in T])
for y in range(2021, 2027): stats(np.where((yrs == y) & (np.arange(N) >= start))[0], str(y))
stats(slice(N - 73*24, N), "last 73 days")
stats(slice(N - 30*24, N), "last 30 days")
