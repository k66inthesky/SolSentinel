import json, urllib.request, time
cands=json.load(open('cands.json'))
pick=[]
for c in ['A_stable_lend','B_LST','C_stable_LP','D_lst_sol_LP']:
    pick+= [(c,x) for x in cands[c][:12]]
pick+=[('E_sol_usd_LP',dict(pool=p,project=n,symbol=s,meta=m,tvl=0)) for p,n,s,m in [
 ('a5c85bc8-eb41-45c0-a520-d18d7529c0d8','orca-dex','SOL-USDC','whirlpool'),
 ('709f121d-d3b4-44da-b3d0-47bc16f5400b','raydium-amm','WSOL-USDC','CLMM 0.04%'),
 ('12edc6f3-4926-4b4f-b97c-38ef6a458574','raydium-amm','WSOL-USDC','Standard 0.25%')]]
out={}
for c,x in pick:
    for k in range(3):
        try: h=json.load(urllib.request.urlopen(f"https://yields.llama.fi/chart/{x['pool']}",timeout=30))['data']; break
        except Exception as e: time.sleep(2); h=[]
    out[x['pool']]=dict(cat=c,info=x,hist=h); time.sleep(0.3)
json.dump(out,open('hist.json','w')); print(len(out))
