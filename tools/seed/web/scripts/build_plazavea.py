# Build tools/seed/web/plazavea.json from Plaza Vea's own VTEX configuration:
#  - public pickup-points API (www.plazavea.com.pe/api/checkout/pub/pickup-points?geoCoordinates=...)
#    queried around ~70 city centres covering Peru -> every pickup point configured for plazaVea stores
#  - master-data entity PD (store list used by the site's address/store picker) with lat/lon
import re, json, sys, os, unicodedata, collections, statistics
sys.path.insert(0, os.path.dirname(__file__))
from mass_coords import inpe, hav

ROOT = 'Z:/mapa-tiendas/tools/seed/web'
RAWD = ROOT + '/raw/plazavea'
PP_URL = 'https://www.plazavea.com.pe/api/checkout/pub/pickup-points'
PD_URL = 'https://www.plazavea.com.pe/api/dataentities/PD/search'

pp = json.load(open(RAWD + '/pickup-points-plazavea.json', encoding='utf-8'))
pd = json.load(open(RAWD + '/masterdata-PD-all.json', encoding='utf-8'))


def strip_acc(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def norm_name(n):
    n = strip_acc(n.lower())
    n = re.sub(r'plaza\s*vea', '', n)
    n = re.sub(r'\b(cd)\b', '', n)
    n = re.sub(r'[^a-z0-9 ]', ' ', n)
    return re.sub(r'\s+', ' ', n).strip()


SMALL = {'de', 'del', 'y'}


def proper(s):
    words = re.sub(r'\s+', ' ', s.strip()).split(' ')
    return ' '.join(w.lower() if i and w.lower() in SMALL else (w[:1].upper() + w[1:].lower()) for i, w in enumerate(words))


# ---- entries ------------------------------------------------------------------------------------
entries = []
for pid, p in pp.items():
    fn = p['friendlyName']
    if 'plaza' not in fn.lower() or fn.strip().upper().startswith('OLVA') or pid.startswith('1_OLVA'):
        continue
    a = p['address']
    g = a['geoCoordinates']
    m = re.match(r'^(?:1_|plazaveaswl)(?:PUP)?(\d+)(?:[-_].*)?$', pid)
    code = int(m.group(1)) if m else None
    if pid.startswith('plazaveaswl'):
        kind, prio = 'swl', 2
        code = int(re.match(r'plazaveaswl(\d+)', pid).group(1))
    elif re.match(r'^1_[0-9a-f]{7}$', pid) and re.search(r'[a-f]', pid[2:]):
        kind, prio, code = 'hex', 1, None
    elif re.match(r'^1_[0-9a-f]{7}$', pid):  # all-digit 7 char id e.g. 1_1685387 / 1_1966554 / 1_1486430 -> VTEX generated
        kind, prio, code = 'hex', 1, None
    elif pid.startswith('1_PUP'):
        kind, prio = 'pup', 1
    elif re.match(r'^1_\d+(-RT|-CD)?$', pid):
        kind, prio = 'legacy', 3
    else:
        kind, prio, code = 'other', 2, None
    entries.append({'src': 'pickup', 'id': pid, 'name': fn, 'nname': norm_name(fn), 'code': code, 'kind': kind, 'prio': prio,
                    'lat': g[1], 'lng': g[0], 'street': (a.get('street') or '').strip(), 'number': (a.get('number') or '').strip(),
                    'district': a.get('neighborhood') or '', 'province': a.get('city') or '', 'department': a.get('state') or '',
                    'postal': a.get('postalCode') or '', 'active': p.get('isActive')})
for x in pd:
    if 'plazavea' not in x['name'].lower().replace(' ', ''):
        continue
    wid = x.get('warehouse_id') or ''
    m = re.match(r'^STK(\d+)F$', wid)
    code = int(m.group(1)) if m else (int(wid) if wid.isdigit() else None)
    entries.append({'src': 'pd', 'id': 'PD:' + wid, 'name': x['name'], 'nname': norm_name(x['name']), 'code': code, 'kind': 'pd', 'prio': 0,
                    'lat': float(x['lat']), 'lng': float(x['lon']), 'street': x.get('address') or '', 'number': '',
                    'district': '', 'province': '', 'department': '', 'postal': x.get('district') or '', 'active': x.get('state')})

# known aliases (same store, different labels in the configs) - verified by identical code/address
ALIAS = {'arequipa real plaza': 'el ejercito', 'el ejercito real plaza': 'el ejercito', 'sjl mall': 'san juan de lurigancho mall',
         'tarapoto 2': 'tarapoto 2', 'ayacucho': 'ayacucho'}
for e in entries:
    e['nname'] = ALIAS.get(e['nname'], e['nname'])

# ---- union-find clustering by code / name ---------------------------------------------------------
par = list(range(len(entries)))


def f(i):
    while par[i] != i:
        par[i] = par[par[i]]
        i = par[i]
    return i


def u(i, j):
    par[f(i)] = f(j)


by_code = collections.defaultdict(list)
by_name = collections.defaultdict(list)
pickup_names = {e['nname'] for e in entries if e['src'] == 'pickup'}
for i, e in enumerate(entries):
    # PD warehouse ids are not unique (e.g. Alfonso Ugarte and Breña both STK118F): PD rows join by name,
    # and only fall back to the code when no pickup config has the same name.
    if e['code'] is not None and not (e['src'] == 'pd' and e['nname'] in pickup_names):
        by_code[e['code']].append(i)
    by_name[e['nname']].append(i)
for lst in list(by_code.values()) + list(by_name.values()):
    for j in lst[1:]:
        u(lst[0], j)
clusters = collections.defaultdict(list)
for i in range(len(entries)):
    clusters[f(i)].append(entries[i])

# sanity: a cluster must not mix far-apart departments/names wrongly -> print for review
stores = []
review = []
for cl in clusters.values():
    names = sorted({e['name'] for e in cl})
    # candidate coordinates
    cands = [e for e in cl if inpe(e['lat'], e['lng'])]
    best = None
    for e in cands:
        support = sum(1 for o in cands if o is not e and hav(e['lat'], e['lng'], o['lat'], o['lng']) < 1.0)
        key = (support, -e['prio'])
        if best is None or key > best[0]:
            best = (key, e)
    notes = []
    lat = lng = None
    if best:
        e = best[1]
        lat, lng = e['lat'], e['lng']
        far = [o for o in cands if hav(lat, lng, o['lat'], o['lng']) >= 1.0]
        if far:
            notes.append('other configs give different coordinates (ignored): ' + ', '.join(
                '%s %.5f,%.5f (%.1f km off)' % (o['id'], o['lat'], o['lng'], hav(lat, lng, o['lat'], o['lng'])) for o in far))
        near_conflict = [o for o in far if hav(lat, lng, o['lat'], o['lng']) < 50]
        if best[0][0] == 0 and near_conflict:
            notes.append('the two configs disagree by %.1f km and neither is corroborated; used %s (newer config id) - verify position' % (
                hav(lat, lng, near_conflict[0]['lat'], near_conflict[0]['lng']), e['id']))
            review.append(names)
        notes.insert(0, 'coords from %s' % ('master-data PD' if e['src'] == 'pd' else 'pickup point %s' % e['id']))
    # descriptive fields: prefer pickup entries with district info
    pk = [e for e in cl if e['src'] == 'pickup']
    pdx = [e for e in cl if e['src'] == 'pd']
    # name: most common normalised label, written nicely
    lab = collections.Counter(re.sub(r'^\s*plaza\s*vea\s*-?\s*', '', e['name'], flags=re.I).strip() for e in cl)
    label = sorted(lab.items(), key=lambda kv: (-kv[1], -len(kv[0])))[0][0]
    label = label[:1].upper() + label[1:]
    name = 'Plaza Vea ' + re.sub(r'\s+CD$', '', label)
    # address
    def clean_addr(e):
        s = (e['street'] + ' ' + (e['number'] if e['number'] and e['number'] not in e['street'] and e['number'] != 'None' else '')).strip()
        s = re.sub(r'[,.]?\s*Zona Electro dentro de la tienda.*$', '', s, flags=re.I)
        s = re.sub(r'\s+None$', '', s)
        return re.sub(r'\s+', ' ', s).strip()
    addrs = [clean_addr(e) for e in pdx] + [clean_addr(e) for e in sorted(pk, key=lambda e: e['prio'])]
    addrs = [a for a in addrs if a]
    address = addrs[0] if addrs else ''
    dist = next((e['district'] for e in pk if e['district']), '')
    prov = next((e['province'] for e in pk if e['province']), '')
    dept = next((e['department'] for e in pk if e['department']), '')
    if prov == 'Callao' or dist in ('Callao', 'Bellavista', 'Ventanilla'):
        dept, prov = 'Callao', 'Callao'
    if dist == 'Lima':
        dist = 'Lima'  # Cercado de Lima
    codes = sorted({e['code'] for e in cl if e['code'] is not None})
    ids = sorted(e['id'] for e in cl)
    act = [e['active'] for e in cl]
    notes.append('store code(s): %s' % (', '.join(map(str, codes)) if codes else 'n/a'))
    notes.append('config ids: ' + ', '.join(ids))
    if not any(act):
        notes.append('ALL pickup/master-data configs are inactive - store may be closed or only pickup disabled; verify')
    elif not all(act):
        notes.append('some configs inactive')
    if any(e['id'].endswith('-CD') for e in cl):
        notes.append('also has a "CD" pickup config at the same address')
    if 'dasso' in label.lower():
        notes.append('label "plaza vea Dasso" (Av. Camino Real 1335, San Isidro) only appears as an inactive pickup config; existence as a store unverified')
    if 'wanchaq' in label.lower():
        notes.append('newer pickup config (UUID id) - not in the legacy code list')
    stores.append({
        'name': name, 'address': address, 'district': proper(dist) if dist else '', 'province': prov, 'department': dept,
        'lat': round(lat, 6) if lat is not None else None, 'lng': round(lng, 6) if lng is not None else None,
        'coordsSource': 'official' if lat is not None else 'none',
        'url': PP_URL if pk else PD_URL, 'secondary': False, 'notes': '; '.join(notes),
    })

stores.sort(key=lambda s: (s['department'] != 'Lima', s['department'], s['name']))
excluded = [x['name'] for x in pd if 'plazavea' not in x['name'].lower().replace(' ', '')]
out = {
    'chain': 'plazavea', 'retrieved': '2026-10-01',
    'sources': [PP_URL + '?geoCoordinates={lng};{lat}&page=N&pageSize=100',
                PD_URL + '?_fields=name,address,sc,warehouse_id,district,lat,lon,state',
                'https://plazaveahf.myvtex.com/files/pvea_pickup_stores.json',
                "https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf"],
    'reportedCount': {'value': None,
                      'source': "No official Plaza Vea-only store count found. InRetail Peru Corp Q2'26 Earnings Report (MD&A), Operating Metrics, reports 113 'Supermarkets' at 2026-06-30 = Plaza Vea + Vivanda combined (https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf). Vivanda legacy config lists 8 stores, which would imply ~105 Plaza Vea.",
                      'date': '2026-06-30'},
    'complete': False,
    'method': ('plazavea.com.pe has no public store-locator page any more (/tiendas, /nuestras-tiendas etc. resolve to product search). '
               'Stores were reconstructed from Plaza Vea\'s own VTEX configuration: (1) the public checkout pickup-points API queried '
               'around ~70 city centres covering all of Peru (paged, pageSize 100; result set stopped growing at 277 points incl. '
               'Olva couriers and Makro); %d plazaVea pickup configs kept; (2) the VTEX master-data entity PD used by the site\'s store '
               'picker (39 rows incl. inactive; %d plazaVea rows; excluded non-Plaza Vea rows: %s). Configs were clustered into stores by '
               'store code (1_<code>, plazaveaswl<code>, STK<code>F) and by normalised name. Coordinates: chosen per store from the '
               'config that agrees with another config within 1 km, preferring PD > VTEX-generated pickup ids > whitelabel > legacy '
               'numeric ids (legacy ids have several copy-paste errors, e.g. Tacna/Ilo/Moquegua/Puente Piedra/Acho pointing to other cities; '
               'those were ignored and are listed in notes). Stores without any pickup configuration are NOT covered, so the list may be '
               'incomplete; stores whose configs are all inactive are kept and flagged (may be closed).') % (
        sum(1 for e in entries if e['src'] == 'pickup'), sum(1 for e in entries if e['src'] == 'pd'), excluded),
    'stores': stores,
}
json.dump(out, open(ROOT + '/plazavea.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('stores', len(stores), 'with coords', sum(1 for s in stores if s['lat'] is not None), 'review', review)
