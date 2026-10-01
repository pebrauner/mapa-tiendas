# Build tools/seed/web/vivanda.json from Vivanda's legacy VTEX account ("vivanda"): pickup points + PD entity.
import json, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from mass_coords import inpe

ROOT = 'Z:/mapa-tiendas/tools/seed/web'
RAWD = ROOT + '/raw/vivanda'
PP_URL = 'https://vivanda.vtexcommercestable.com.br/api/checkout/pub/pickup-points'
PD_URL = 'https://vivanda.vtexcommercestable.com.br/api/dataentities/PD/search'
pp = json.load(open(RAWD + '/vtex-legacy-pickup-points.json', encoding='utf-8'))
pd = json.load(open(RAWD + '/vtex-legacy-masterdata-PD.json', encoding='utf-8'))

UBI = {'150131': ('San Isidro', 'Lima', 'Lima'), '150120': ('Magdalena del Mar', 'Lima', 'Lima'),
       '150122': ('Miraflores', 'Lima', 'Lima'), '150140': ('Santiago de Surco', 'Lima', 'Lima'),
       '150502': ('Asia', 'Cañete', 'Lima')}

stores = []
for row in sorted(pd, key=lambda r: int(r['sc'])):
    nm = row['name'].strip()
    key = nm.lower().replace('vivanda', '').strip()
    pts = [p for p in pp.values() if p['friendlyName'].lower().endswith('vivanda ' + key)]
    tienda = [p for p in pts if 'recojo en tienda' in p['friendlyName'].lower()] or pts
    lat = lng = None
    notes = ['legacy VTEX store sc=%s' % row['sc']]
    if tienda:
        g = tienda[0]['address']['geoCoordinates']
        if inpe(g[1], g[0]):
            lat, lng = g[1], g[0]
            notes.append('coords from legacy pickup point %s' % tienda[0]['id'])
        notes.append('pickup configs: ' + ', '.join('%s (active=%s)' % (p['id'], p['isActive']) for p in pts))
    notes.append('legacy PD state=%s' % row['state'])
    if key == 'asia':
        notes.append('current vivanda.com.pe FAQ still mentions pickup "en la tienda de Asia" (no address/hours given; opening may be seasonal - verify)')
    if key == 'libertadores':
        notes.append('current vivanda.com.pe FAQ confirms "nuestra tienda Libertadores: Av. Libertadores 594-596, San Isidro"')
    d, pr, de = UBI.get(row['district'], ('', '', ''))
    stores.append({
        'name': nm, 'address': re.sub(r'\s+', ' ', row['address']).strip().rstrip('.'),
        'district': d, 'province': pr, 'department': de,
        'lat': round(lat, 6) if lat is not None else None, 'lng': round(lng, 6) if lng is not None else None,
        'coordsSource': 'official' if lat is not None else 'none', 'url': PP_URL, 'secondary': False,
        'notes': '; '.join(notes),
    })

out = {
    'chain': 'vivanda', 'retrieved': '2026-10-01',
    'sources': [PP_URL + '?geoCoordinates={lng};{lat}', PD_URL + '?_fields=name,address,sc,warehouse_id,district,lat,lon,state',
                'https://www.vivanda.com.pe/institucional/preguntas-frecuentes',
                "https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf"],
    'reportedCount': {'value': None,
                      'source': "No official Vivanda-only count found. InRetail Peru Corp Q2'26 Earnings Report (MD&A) reports 113 'Supermarkets' at 2026-06-30 = Plaza Vea + Vivanda combined, and says 1 Vivanda store was reopened during Q2'26 (https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf).",
                      'date': '2026-06-30'},
    'complete': False,
    'method': ('vivanda.com.pe was rebuilt on a new platform (Next.js + Cord API, store/warehouse endpoints require a session token) '
               'and has no public store list. Vivanda\'s previous VTEX account ("vivanda") is still reachable: its public '
               'pickup-points API (queried around Lima and Asia; 10 pickup configs = 8 stores, store + drive-through variants) and its '
               'master-data entity PD (8 store rows, no coordinates) give 8 stores with official addresses and coordinates. All these '
               'legacy configs are inactive (the online shop moved), so the list is official but possibly stale: it cannot confirm '
               'stores opened/closed after the migration. Only Libertadores and Asia are mentioned on the current site.'),
    'stores': stores,
}
json.dump(out, open(ROOT + '/vivanda.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for s in stores:
    print(s['name'], '|', s['address'], '|', s['district'], '|', s['lat'], s['lng'])
