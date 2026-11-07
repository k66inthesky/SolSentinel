import json, time, urllib.request, sys
import numpy as np
sym=sys.argv[1]; days=int(sys.argv[2])
end=int(time.time()//60*60*1000); start=end-days*86400*1000
out=[]; t=start
while t<end:
    u=f"https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1m&startTime={t}&limit=1000"
    for k in range(5):
        try: rows=json.load(urllib.request.urlopen(u,timeout=30)); break
        except Exception as e: time.sleep(2)
    if not rows: break
    out+=rows; t=rows[-1][0]+60000
a=np.array([[r[0],float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),float(r[7]),int(r[8]),float(r[9])] for r in out])
np.save(f"{sym}_1m.npy",a); print(sym,len(a),a[0,0],a[-1,0])
