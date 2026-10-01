"""Fetch Dollarcity Peru stores from the official store locator API (dollarcity.com/ubicaciones).

The locator's GetDataByCoordinates endpoint caps the search radius at ~160 km, so we query a grid
of points covering Peru (1.8 deg spacing => every point within ~145 km of a grid node) and also the
GetDataByState endpoint for every Peruvian region code, then de-duplicate by LocationId.
Raw responses go to tools/seed/web/raw/dollarcity/.
"""
import json, time, urllib.request, os, sys

UA = "mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)"
BASE = "https://dollarcity.com/ubicaciones/locations"
RAW = os.path.join(os.path.dirname(__file__), "..", "raw", "dollarcity")
os.makedirs(RAW, exist_ok=True)

def post(url):
    req = urllib.request.Request(url, data=b"", method="POST", headers={"User-Agent": UA, "X-Requested-With": "XMLHttpRequest"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))

stores = {}
log = []

def add(resp, tag):
    n = 0
    for s in resp.get("StoreLocations", []):
        if (s.get("ExtraData", {}).get("Address", {}) or {}).get("CountryCode") != "PE":
            continue
        n += 1
        stores[s["LocationId"]] = s
    log.append({"query": tag, "total": resp.get("TotalResults"), "pages": resp.get("TotalPages"), "pe": n})
    if (resp.get("TotalPages") or 1) > 1:
        print("WARNING: multiple pages for", tag, file=sys.stderr)

# 1) grid of coordinate queries
lat = -18.4
while lat <= 0.5:
    lng = -81.4
    while lng <= -68.0:
        url = f"{BASE}/GetDataByCoordinates?longitude={lng:.2f}&latitude={lat:.2f}&distance=160&units=kilometers&amenities=&paymentMethods=&filter=PE"
        try:
            add(post(url), f"coord {lat:.2f},{lng:.2f}")
        except Exception as e:
            log.append({"query": f"coord {lat:.2f},{lng:.2f}", "error": str(e)})
        time.sleep(1.0)
        lng += 1.8
    lat += 1.8
print("after grid:", len(stores))

# 2) state queries (ISO 3166-2:PE style region codes)
for code in ["AMA","ANC","APU","ARE","AYA","CAJ","CAL","CUS","HUV","HUC","ICA","JUN","LAL","LAM","LIM","LMA","LOR","MDD","MOQ","PAS","PIU","PUN","SAM","TAC","TUM","UCA"]:
    url = f"{BASE}/GetDataByState?region={code}&Ocp-Apim-Subscription-Key=9a7df5499d8d496c8ad6cd800d54b00a"
    try:
        before = len(stores)
        add(post(url), f"state {code}")
        print(code, log[-1]["pe"], "new:", len(stores) - before)
    except Exception as e:
        log.append({"query": f"state {code}", "error": str(e)})
        print(code, "ERR", e)
    time.sleep(1.0)

print("total PE stores:", len(stores))
with open(os.path.join(RAW, "locator_stores.json"), "w", encoding="utf-8") as f:
    json.dump(sorted(stores.values(), key=lambda s: s["LocationId"]), f, ensure_ascii=False, indent=1)
with open(os.path.join(RAW, "query_log.json"), "w", encoding="utf-8") as f:
    json.dump(log, f, ensure_ascii=False, indent=1)
