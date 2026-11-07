import json, time, urllib.request, sys
end = int(time.time()*1000); start = end - 7*24*3600*1000
out=[]; t=start
while t < end:
    u=f"https://data-api.binance.vision/api/v3/klines?symbol=SOLUSDT&interval=1m&startTime={t}&limit=1000"
    rows=json.load(urllib.request.urlopen(u, timeout=20))
    if not rows: break
    out += rows; t = rows[-1][0] + 60000
json.dump([[r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])] for r in out], open("data/sol_1m_7d.json","w"))
print(len(out), out[0][0], out[-1][0], out[-1][4])
