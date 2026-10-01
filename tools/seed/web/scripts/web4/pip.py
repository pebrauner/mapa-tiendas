import json

_feats = None

def _load():
    global _feats
    if _feats is not None:
        return _feats
    d = json.load(open('Z:/mapa-tiendas/tools/seed/districts.geojson', encoding='utf-8'))
    feats = []
    for f in d['features']:
        g = f['geometry']
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        xs = [p[0] for poly in polys for p in poly[0]]
        ys = [p[1] for poly in polys for p in poly[0]]
        feats.append((min(xs), min(ys), max(xs), max(ys), polys, f['properties']))
    _feats = feats
    return feats

def _in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def locate(lat, lng):
    for x0, y0, x1, y1, polys, props in _load():
        if not (x0 <= lng <= x1 and y0 <= lat <= y1):
            continue
        for poly in polys:
            if _in_ring(lng, lat, poly[0]) and not any(_in_ring(lng, lat, h) for h in poly[1:]):
                return props
    return None
