import json, time, urllib.request, sys
import numpy as np
sym=sys.argv[1]; itv=sys.argv[2]
t=int(time.mktime(time.strptime("2020-08-01","%Y-%m-%d"))*1000); out=[]
end=int(time.time()*1000)
while t<end:
    rows=json.load(urllib.request.urlopen(f"https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={itv}&startTime={t}&limit=1000",timeout=30))
    if not rows: break
    out+=rows; t=rows[-1][0]+1
out=out[:-1]
a=np.array([[r[0],float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5])] for r in out]); np.save(f"{sym}_{itv}.npy",a); print(sym,itv,len(a),time.strftime('%Y-%m-%d',time.gmtime(a[0,0]/1000)),time.strftime('%Y-%m-%d',time.gmtime(a[-1,0]/1000)), a[0,4], a[-1,4])
