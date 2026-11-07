"""No-fit ensemble: equal-weight average of every trend-family config (no parameter is chosen by
performance). Position = fraction of the vault in SOL, rebalanced when it changes; cost on |change|."""
import sys, json, numpy as np
sys.argv = [sys.argv[0], sys.argv[1] if len(sys.argv) > 1 else "1"]
exec(open("wf.py").read().split("names = list(configs)")[0])   # reuse the config builder
mult = float(sys.argv[1])
fam = lambda n: json.loads(n)["f"]
trend = [n for n in configs if fam(n) != "rsi_mr"]
P = np.mean([configs[n] for n in trend], axis=0)
R = np.concatenate([[0.0], np.diff(C) / C[:-1]])
held = np.concatenate([[0.0], P[:-1]])
cost = np.abs(np.diff(np.concatenate([[0.0], held]))) * COST
net = held * R - cost
def stats(sl, label):
    o = net[sl]; r = R[sl]; eq = np.cumprod(1 + o); be = np.cumprod(1 + r)
    d = o[: len(o)//24*24].reshape(-1, 24).sum(1); sh = d.mean()/(d.std()+1e-12)*np.sqrt(365)
    print(f"{label:28s} ens {(eq[-1]-1)*100:+8.1f}%  sharpe {sh:5.2f}  maxDD {(1-eq/np.maximum.accumulate(eq)).max()*100:5.1f}%  | SOL {(be[-1]-1)*100:+8.1f}%  maxDD {(1-be/np.maximum.accumulate(be)).max()*100:5.1f}%  | avg exposure {held[sl].mean():.2f}  turnover/yr {np.abs(np.diff(held[sl])).sum()/(len(o)/8766):.0f}")
print(f"{len(trend)} trend configs averaged; cost/side {COST*1e4:.1f} bps")
start = 200 * 24
stats(slice(start, N), "full (2021-03 ->)")
yrs = np.array([np.datetime64(int(t), 'ms').astype('datetime64[Y]').astype(int) + 1970 for t in T])
for y in range(2021, 2027): stats(np.where((yrs == y) & (np.arange(N) >= start))[0], str(y))
stats(slice(N - 73*24, N), "last 73 days")
stats(slice(N - 7*24, N), "last 7 days")
np.save("ensemble_pos.npy", np.stack([T, P]))
