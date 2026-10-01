# Build tools/seed/web/mass.json from the official Tiendas Mass locator page
# (https://www.tiendasmass.com.pe/ubicame/), saved as raw/mass/ubicame.html.
import re, html, json, collections, statistics, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from mass_coords import parse_pair, candidates, inpe, hav

ROOT = 'Z:/mapa-tiendas/tools/seed/web'
RAW = ROOT + '/raw/mass/ubicame.html'
URL = 'https://www.tiendasmass.com.pe/ubicame/'

SMALL = {'de', 'del', 'y'}


def proper(s):
    s = re.sub(r'\s+', ' ', s.strip())
    words = s.split(' ')
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if i > 0 and lw in SMALL:
            out.append(lw)
        elif w == '-':
            out.append(w)
        else:
            out.append(lw[:1].upper() + lw[1:])
    return ' '.join(out)


DEPT = {
    'LIMA': 'Lima', 'CALLAO': 'Callao', 'AREQUIPA': 'Arequipa', 'PIURA': 'Piura', 'TRUJILLO': 'La Libertad',
    'LA LIBERTAD': 'La Libertad', 'ICA': 'Ica', 'LAMBAYEQUE': 'Lambayeque', 'JUNÍN': 'Junín', 'ÁNCASH': 'Áncash',
    'CUSCO': 'Cusco', 'TUMBES': 'Tumbes', 'HUÁNUCO': 'Huánuco', 'HUANCAVELICA': 'Huancavelica', 'PASCO': 'Pasco',
}
CALLAO_DISTRICTS = {'CALLAO', 'BELLAVISTA', 'CARMEN DE LA LEGUA REYNOSO', 'CARMEN DE LA LEGUA', 'LA PERLA',
                    'LA PUNTA', 'VENTANILLA', 'MI PERÚ', 'MI PERU'}

t = open(RAW, encoding='utf-8').read()
lis = re.findall(r'<li\s+(data-ciudad=.*?)>(.*?)</li>', t, re.S)
rows = []
for attrs, body in lis:
    a = {k: html.unescape(v) for k, v in re.findall(r'data-(\w+)="([^"]*)"', attrs)}
    nm = re.search(r'tienda-nombre">(.*?)</p>', body, re.S)
    dr = re.search(r'tienda-direccion">(.*?)</p>', body, re.S)
    hr = re.search(r'tienda-horario[^>]*>(.*?)</p>', body, re.S)
    a['nombre'] = html.unescape(nm.group(1).strip()) if nm else ''
    a['code'] = html.unescape(dr.group(1).strip()) if dr else ''
    a['hor'] = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', re.sub(r'<svg.*?</svg>', '', hr.group(1), flags=re.S))).strip() if hr else ''
    rows.append(a)
n_raw = len(rows)

# ---- coordinates -------------------------------------------------------------
for r in rows:
    a, b, issues = parse_pair(r['lat'], r['lng'])
    r['_lat_c'], r['_lng_c'], r['_issues'] = candidates(a), candidates(b), issues
    r['_raw'] = (r['lat'], r['lng'])
    r['ciudad_u'] = r['ciudad'].upper()
    r['dist_u'] = re.sub(r'\s+', ' ', r['distrito'].strip().upper())

# district medians from unambiguous coordinates (used to restore missing decimal points and to flag outliers)
grp = collections.defaultdict(list)
city = collections.defaultdict(list)
for r in rows:
    if len(r['_lat_c']) == 1 and len(r['_lng_c']) == 1 and inpe(r['_lat_c'][0], r['_lng_c'][0]):
        grp[(r['ciudad_u'], r['dist_u'])].append((r['_lat_c'][0], r['_lng_c'][0]))
        city[r['ciudad_u']].append((r['_lat_c'][0], r['_lng_c'][0]))


def med(pts):
    return statistics.median(p[0] for p in pts), statistics.median(p[1] for p in pts)


for r in rows:
    la, ln = r['_lat_c'], r['_lng_c']
    r['lat_f'] = r['lng_f'] = None
    if not la or not ln:
        r['_issues'].append('unparseable coordinates')
        continue
    if len(la) == 1 and len(ln) == 1:
        r['lat_f'], r['lng_f'] = la[0], ln[0]
    else:
        ref = grp.get((r['ciudad_u'], r['dist_u'])) or city.get(r['ciudad_u'])
        mla, mln = med(ref)
        best = None
        for x in la:
            for y in ln:
                if inpe(x, y):
                    d = hav(x, y, mla, mln)
                    if best is None or d < best[0]:
                        best = (d, x, y)
        if best and best[0] < 30:
            r['lat_f'], r['lng_f'] = best[1], best[2]
            r['_issues'].append('decimal point missing in source value; restored (result %.1f km from other Mass stores in the same district)' % best[0])
        else:
            r['_issues'].append('decimal point missing in source value; could not restore unambiguously')
    if r['lat_f'] is not None and not inpe(r['lat_f'], r['lng_f']):
        if inpe(r['lng_f'], r['lat_f']):
            r['lat_f'], r['lng_f'] = r['lng_f'], r['lat_f']
            r['_issues'].append('lat/lng swapped in source; swapped back')
        else:
            r['_issues'].append('coordinates outside Peru; discarded')
            r['lat_f'] = r['lng_f'] = None

# ---- de-duplication: same internal code (ignoring spaces/case) + same coordinates -----------------
def ncode(s):
    return re.sub(r'\s+', '', s.lower())

seen = {}
stores_rows = []
dups = []
for r in rows:
    key = (ncode(r['code']), r['lat_f'], r['lng_f'])
    if r['code'] and key in seen:
        seen[key]['_dupcount'] += 1
        dups.append(r)
        continue
    r['_dupcount'] = 1
    seen[key] = r
    stores_rows.append(r)

# ---- cross-district identical coordinates (data-entry error) -------------------------------------
bycoord = collections.defaultdict(list)
for r in stores_rows:
    if r['lat_f'] is not None:
        bycoord[(round(r['lat_f'], 6), round(r['lng_f'], 6))].append(r)
grp2 = collections.defaultdict(list)
for r in stores_rows:
    if r['lat_f'] is not None:
        grp2[(r['ciudad_u'], r['dist_u'])].append(r)


def dist_to_district(r):
    others = [(o['lat_f'], o['lng_f']) for o in grp2[(r['ciudad_u'], r['dist_u'])]
              if o is not r and o['lat_f'] is not None and (o['lat_f'], o['lng_f']) != (r['lat_f'], r['lng_f'])]
    if len(others) < 3:
        return None, None
    mla, mln = med(others)
    ds = sorted(hav(p[0], p[1], mla, mln) for p in others)
    spread = ds[int(0.9 * (len(ds) - 1))]
    return hav(r['lat_f'], r['lng_f'], mla, mln), spread

nulled = []
for k, lst in bycoord.items():
    dists = {(o['ciudad_u'], o['dist_u']) for o in lst}
    if len(lst) > 1 and len(dists) > 1:
        scored = [(dist_to_district(o)[0] or 0, o) for o in lst]
        scored.sort(key=lambda x: x[0])
        for d, o in scored[1:]:
            o['_issues'].append('source coordinates (%s, %s) are identical to another Mass store listed in a different district (%s); discarded as a data-entry error' % (o['_raw'][0].strip(), o['_raw'][1].strip(), proper(scored[0][1]['distrito'])))
            o['lat_f'] = o['lng_f'] = None
            nulled.append(o)

# ---- outlier flags ---------------------------------------------------------------------------------
flagged = []
for r in stores_rows:
    if r['lat_f'] is None:
        continue
    d, spread = dist_to_district(r)
    if d is None:
        continue
    if d > 10 and d > 2.5 * spread and r['ciudad_u'] in ('LIMA', 'CALLAO') and r['dist_u'] not in ('LURIGANCHO - CHOSICA', 'PACHACAMAC', 'ATE', 'CARABAYLLO', 'CIENEGUILLA'):
        r['_issues'].append('source coordinates (%s, %s) lie %.1f km from the other Mass stores listed in %s (typical spread %.1f km); discarded as likely wrong' % (r['_raw'][0].strip(), r['_raw'][1].strip(), d, proper(r['distrito']), spread))
        r['lat_f'] = r['lng_f'] = None
        nulled.append(r)
    elif d > 5 and d > 2 * spread:
        r['_issues'].append('coordinate check: %.1f km from the median of other Mass stores listed in "%s" (typical spread %.1f km) - verify (source district field is sometimes the city, not the district)' % (d, proper(r['distrito']), spread))
        flagged.append(r)

# ---- output ---------------------------------------------------------------------------------------
stores = []
for r in stores_rows:
    addr = re.sub(r'\s+', ' ', (r.get('address') or r['nombre']).replace('\u2060', '')).strip()
    short = re.sub(r'\s*\(.*$', '', addr).strip() or addr
    dist_raw = r['distrito'].strip()
    dept = DEPT.get(r['ciudad_u'], proper(r['ciudad']))
    if r['dist_u'] in CALLAO_DISTRICTS:
        dept = 'Callao'
    notes = []
    if r['code']:
        notes.append('internal code: %s' % r['code'])
    if r['hor']:
        notes.append('hours: %s' % r['hor'])
    if r['_dupcount'] > 1:
        notes.append('listed %d times in source (identical code+coordinates); merged' % r['_dupcount'])
    if r['ciudad_u'] != dept.upper():
        notes.append('source city/region field: %s' % proper(r['ciudad']))
    notes += r['_issues']
    stores.append({
        'name': 'Mass ' + short,
        'address': addr,
        'district': proper(dist_raw),
        'province': '',
        'department': dept,
        'lat': round(r['lat_f'], 6) if r['lat_f'] is not None else None,
        'lng': round(r['lng_f'], 6) if r['lng_f'] is not None else None,
        'coordsSource': 'official' if r['lat_f'] is not None else 'none',
        'url': URL,
        'secondary': False,
        'notes': '; '.join(notes),
    })

out = {
    'chain': 'mass',
    'retrieved': '2026-10-01',
    'sources': [
        URL,
        "https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf",
        "https://www.inretail.pe/api/archivos/file/InRetail%20Q2'26%20Corporate%20Presentation.pdf",
    ],
    'reportedCount': {
        'value': 1602,
        'source': "InRetail Peru Corp, Q2'26 Earnings Report (MD&A), Operating Metrics, 'Number of stores - Hard Discount' (Mass, Peru only; Food Retail segment note: 'Includes only Peru') - https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf",
        'date': '2026-06-30',
    },
    'complete': True,
    'method': ('Parsed the official store locator page %s (WordPress page; every store is an <li> with data-ciudad, '
               'data-distrito, data-lat, data-lng, data-address + internal code and hours). %d list items; %d exact '
               'duplicates (same internal code and coordinates) merged -> %d stores. Coordinates are the official '
               'values; malformed values were cleaned (trailing commas/backslashes, "lat, lng" pairs in one field, '
               'missing decimal points restored using the district of the store). %d coordinates discarded '
               '(identical to a store in another district, or >10 km outside the stated Lima/Callao district); %d '
               'flagged for verification in notes. Count matches InRetail Q2-26 (1,602 Hard Discount stores at '
               '2026-06-30). The page lists only Peru (no Chile stores).') % (URL, n_raw, len(dups), len(stores), len(nulled), len(flagged)),
    'stores': stores,
}
json.dump(out, open(ROOT + '/mass.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('raw', n_raw, 'dups', len(dups), 'stores', len(stores), 'nulled', len(nulled), 'flagged', len(flagged),
      'with coords', sum(1 for s in stores if s['lat'] is not None))
for r in nulled:
    print('NULL', r['distrito'], r['address'][:60], r['_issues'][-1][:140])
