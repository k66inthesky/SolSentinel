import json
d=[p for p in json.load(open('pools.json'))['data'] if p['chain']=='Solana']
LST={'JITOSOL','MSOL','JUPSOL','BNSOL','INF','DSOL','BSOL','HSOL','JSOL','PSOL','BBSOL','DFDVSOL','SSOL','VSOL','LAINESOL','STSOL','CGNTSOL','HUBSOL','PICOSOL','BONKSOL','STRONGSOL','EDGESOL','ADRASOL'}
def toks(s): return [x.strip().upper() for x in s.replace('/', '-').split('-')]
cats={}
for p in d:
    tv=p['tvlUsd'] or 0; t=toks(p['symbol']); apy=p['apy'] or 0
    if p.get('outlier'): continue
    if p['exposure']=='single' and p['stablecoin'] and tv>3e6: c='A_stable_lend'
    elif p['exposure']=='multi' and p['stablecoin'] and tv>1e6: c='C_stable_LP'
    elif p['exposure']=='multi' and all(x in LST or x in ('SOL','WSOL') for x in t) and tv>1e6: c='D_lst_sol_LP'
    elif p['exposure']=='multi' and set(t)>= {'SOL'} and any(x in ('USDC','USDT') for x in t) and tv>3e6: c='E_sol_usd_LP'
    elif p['exposure']=='single' and t[0] in LST and tv>20e6 and (p['apyBase'] or 0)>0: c='B_LST'
    else: continue
    cats.setdefault(c,[]).append(dict(pool=p['pool'],project=p['project'],symbol=p['symbol'],meta=p.get('poolMeta'),tvl=tv,apy=apy,apyBase=p['apyBase'],apyReward=p['apyReward'],rewards=p['rewardTokens'],mean30=p['apyMean30d'],il7d=p.get('il7d'),vol1d=p.get('volumeUsd1d')))
for c in sorted(cats):
    cats[c].sort(key=lambda x:-x['tvl'])
    print(c,len(cats[c]))
    for x in cats[c][:14]: print(f"   {x['project'][:18]:18s} {x['symbol'][:22]:22s} {str(x['meta'])[:18]:18s} tvl ${x['tvl']/1e6:7.1f}M apy {x['apy']:7.2f} base {x['apyBase']} rew {x['apyReward']} m30 {x['mean30']}")
json.dump(cats,open('cands.json','w'))
