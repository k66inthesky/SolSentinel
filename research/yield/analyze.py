import json, numpy as np, datetime as dt
H=json.load(open('hist.json'))
sol=np.load('../SOLUSDT_1h.npy'); px={}
for r in sol: px.setdefault(dt.datetime.utcfromtimestamp(r[0]/1000).date(), r[4])  # first hour close of day ~ daily price
rows=[]
cut=dt.date(2026,11,7)-dt.timedelta(days=365)
for pid,v in H.items():
    h=[x for x in v['hist'] if x.get('apy') is not None]
    if not h: continue
    days=[(dt.date.fromisoformat(x['timestamp'][:10]), x['apy'], x.get('apyBase') or 0, x.get('apyReward') or 0, x['tvlUsd']) for x in h]
    d365=[x for x in days if x[0]>=cut]
    if len(d365)<60: continue
    apy=np.array([x[1] for x in d365]); base=np.array([x[2] for x in d365])
    growth=np.prod(1+apy/100/365)**(365/len(apy))-1          # annualised realised (with rewards at DefiLlama's valuation)
    growth_base=np.prod(1+base/100/365)**(365/len(base))-1
    roll=np.convolve(apy,np.ones(30)/30,'valid')
    r=dict(cat=v['cat'],proj=v['info']['project'],sym=v['info']['symbol'],meta=str(v['info'].get('meta'))[:22],days=len(apy),
           realised=growth*100,realised_base=growth_base*100,worst30=roll.min(),best30=roll.max(),now=apy[-1],tvl=d365[-1][4]/1e6)
    if v['cat']=='E_sol_usd_LP':
        # pool-average LP: constant-product-like value sqrt(P/P0) + fees accrued at the pool's daily APY (USD terms)
        p=np.array([px.get(x[0],np.nan) for x in d365]); ok=~np.isnan(p); p=p[ok]; a=apy[ok]
        val=1.0; prev=p[0]
        for i in range(1,len(p)):
            val*= np.sqrt(p[i]/prev) * (1+a[i]/100/365); prev=p[i]
        r['usd_total']=(val-1)*100; r['sol_move']=(p[-1]/p[0]-1)*100; r['hodl_5050']=((1+p[-1]/p[0])/2-1)*100
    if v['cat']=='B_LST':
        p=np.array([px.get(x[0],np.nan) for x in d365]); p=p[~np.isnan(p)]
        r['usd_total']=((1+growth)**(len(apy)/365)*p[-1]/p[0]-1)*100; r['sol_move']=(p[-1]/p[0]-1)*100
    rows.append(r)
for c in sorted(set(r['cat'] for r in rows)):
    print('\n',c)
    for r in sorted([r for r in rows if r['cat']==c],key=lambda r:-r['realised']):
        extra=f"  USD total {r['usd_total']:+6.1f}% (SOL {r['sol_move']:+.0f}%{', hodl50/50 %+.0f%%'%r['hodl_5050'] if 'hodl_5050' in r else ''})" if 'usd_total' in r else ''
        print(f"  {r['proj'][:16]:16s} {r['sym'][:16]:16s} {r['meta'][:20]:20s} {r['days']:3d}d realised {r['realised']:5.2f}% (base {r['realised_base']:5.2f}) worst30 {r['worst30']:5.2f} now {r['now']:5.2f} tvl {r['tvl']:6.1f}M{extra}")
json.dump(rows,open("analysis.json","w"),default=float)
