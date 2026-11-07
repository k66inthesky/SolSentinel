"""Stablecoin yield router backtest: each day hold the stable-lending pool with the best trailing
7-day APY (decided with data up to yesterday). Switching costs SWITCH_BPS (two txs + small slippage
for non-USDC stables) and we only switch if the APY edge pays it back within 14 days."""
import json, numpy as np, datetime as dt
H=json.load(open('hist.json')); SWITCH_BPS=5
series={}
for pid,v in H.items():
    if v['cat']!='A_stable_lend': continue
    s={dt.date.fromisoformat(x['timestamp'][:10]):x['apy'] for x in v['hist'] if x.get('apy') is not None}
    if len(s)>=150 and np.mean(list(s.values()))>0.5: series[f"{v['info']['project']} {v['info']['symbol']} {v['info'].get('meta')}"]=s
days=sorted(set.intersection(*[set(s) for s in series.values()]))
names=list(series); A=np.array([[series[n][d] for d in days] for n in names])  # [pool, day] APY %
print(f"{len(names)} pools, {len(days)} common days {days[0]} -> {days[-1]}")
cur=None; val=1.0; sw=0
for i in range(7,len(days)):
    trail=A[:, i-7:i].mean(1)
    best=int(trail.argmax())
    if cur is None: cur=best; val*=1-SWITCH_BPS/1e4; sw+=1
    elif best!=cur and (trail[best]-trail[cur])/100/365*14 > SWITCH_BPS/1e4: cur=best; val*=1-SWITCH_BPS/1e4; sw+=1
    val*=1+A[cur,i]/100/365
n=len(days)-7
print(f"router: {((val)**(365/n)-1)*100:.2f}% annualised over {n} days, {sw} switches")
for j,nm in enumerate(names): print(f"  static {nm[:50]:50s} {(np.prod(1+A[j,7:]/100/365)**(365/n)-1)*100:5.2f}%")
