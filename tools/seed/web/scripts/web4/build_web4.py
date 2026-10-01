"""Build tools/seed/web/{florayfauna,holi,tambo,oxxo}.json from the raw responses retrieved in this session."""
import json, re, html, unicodedata
from pip import locate

OUT = 'Z:/mapa-tiendas/tools/seed/web/'
RETRIEVED = '2026-10-01'
UBI = json.load(open('ubigeo_names.json', encoding='utf-8'))


def in_peru(lat, lng):
    return lat is not None and lng is not None and -18.4 <= lat <= -0.03 and -81.4 <= lng <= -68.6


def store(name, address, district, province, department, lat, lng, url, secondary=False, notes=''):
    if lat is not None:
        lat, lng = round(float(lat), 6), round(float(lng), 6)
        assert in_peru(lat, lng), (name, lat, lng)
    return {
        'name': name, 'address': address, 'district': district or '', 'province': province or '',
        'department': department or '', 'lat': lat, 'lng': lng,
        'coordsSource': 'official' if lat is not None else 'none', 'url': url,
        'secondary': secondary, 'notes': notes,
    }


def write(chain, doc):
    stores = doc['stores']
    for s in stores:
        if s['lat'] is not None:
            assert in_peru(s['lat'], s['lng'])
    path = OUT + chain + '.json'
    json.dump(doc, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(chain, len(stores), 'with coords:', sum(1 for s in stores if s['lat'] is not None),
          'secondary:', sum(1 for s in stores if s['secondary']), '->', path)


# ---------------------------------------------------------------- Flora y Fauna
FF_URL = 'https://www.florayfauna.pe/institucional/nuestras-tiendas'
FF_API = 'https://www.florayfauna.pe/api/dataentities/TI/search?_fields=id,city,lng,lat,content,name,image,horario,address'
DIST_FIX = {'Surco': 'Santiago de Surco'}
ff = json.load(open('ff_TI.json', encoding='utf-8'))
ff_stores = []
for x in sorted(ff, key=lambda r: int(r['id'])):
    addr = x['address'].strip()
    m = re.search(r'\s[-–]\s*([^-–]+)$', addr)
    stated = m.group(1).strip() if m else ''
    street = addr[:m.start()].strip() if m else addr
    lat, lng = float(x['lat']), float(x['lng'])
    p = locate(lat, lng)
    district = DIST_FIX.get(stated, stated) or (p['district'] if p else '')
    notes = ['VTEX masterdata TI id=%s' % x['id'], 'Horario: ' + re.sub(r'\s*</br>\s*', '; ', x['horario'] or '')]
    if not stated:
        notes.append('district not stated by source; derived by point-in-polygon of official coordinates')
    elif p and p['district'] != district:
        notes.append('official coordinates fall in %s (district boundary)' % p['district'])
    ff_stores.append(store(x['city'].replace('F&F ', 'Flora & Fauna ', 1), street, district, 'Lima', 'Lima', lat, lng,
                           FF_URL, notes='; '.join(notes)))
write('florayfauna', {
    'chain': 'florayfauna', 'retrieved': RETRIEVED,
    'sources': [FF_URL, FF_API,
                'https://www.peru-retail.com/flora-fauna-abre-su-tienda-numero-14-donde-se-ubica-y-que-planes-tiene-para-seguir-creciendo/'],
    'reportedCount': {'value': 14,
                      'source': 'https://www.peru-retail.com/flora-fauna-abre-su-tienda-numero-14-donde-se-ubica-y-que-planes-tiene-para-seguir-creciendo/',
                      'date': '2026-09-09'},
    'complete': True,
    'method': ('Official store locator (VTEX IO page /institucional/nuestras-tiendas, component '
               'florayfauna.address-with-google-maps AddressFormMap) loads its stores from the public VTEX Master Data '
               'entity TI; fetched that endpoint directly (14 records with name, address, hours, lat/lng). '
               'District taken from the address suffix (normalized Surco -> Santiago de Surco); where missing, '
               'derived by point-in-polygon of the official coordinates. 14 stores = 14 reported by trade press on 2026-09-09 '
               '(Gestion reported 13 on 2026-04-24, before the Magdalena opening).'),
    'stores': ff_stores,
})

# ---------------------------------------------------------------- Holi
HOLI_URL = 'https://holisupermercado.com/libro-de-reclamaciones/'
hh = open('holi_libro-de-reclamaciones.html', encoding='utf-8').read()
opts = [html.unescape(o).strip() for o in re.findall(r'<option value="([^"]*)"', hh)]
holi_opts = [o for o in opts if ' - ' in o]
# district per label: from the label itself when it is a district, or from news articles (cited in notes)
HOLI_DIST = {
    'Magdalena': ('Magdalena del Mar', 'district from store label'),
    'Cercado': ('Lima', 'label "Cercado" = Cercado de Lima (district Lima)'),
    'Barranco': ('Barranco', 'district from store label; 2nd store opened 2023 at Av. El Sol Oeste 135 per Peru Retail'),
    'Surquillo': ('Surquillo', 'district from store label; first Holi store (2023)'),
    'Chacarilla': ('San Borja', 'district per Gestion 2025-02-10 ("San Borja - Avenida Primavera, Chacarilla"); label says Chacarilla'),
    'La mar': ('Miraflores', 'district per Gestion 2025-02-10 ("Miraflores - Calle La Mar")'),
    'Jesus Maria': ('Jesús María', 'district from store label'),
    'Petit Thouars': ('', 'district not stated by source'),
    '28 de Julio': ('', 'district not stated by source'),
    'Pardo': ('', 'district not stated by source'),
    'La Marina 1': ('San Miguel', 'district per Peru Retail 2026-06-13/2026-07-27 (two San Miguel stores on Av. La Marina)'),
    'La Marina 2': ('San Miguel', 'district per Peru Retail 2026-07-27 (12th store, second in San Miguel)'),
}
holi_stores = []
for o in holi_opts:
    label, addr = [t.strip() for t in o.split(' - ', 1)]
    d, why = HOLI_DIST[label]
    nm = 'Holi ' + (label[0].upper() + label[1:])
    holi_stores.append(store(nm, addr, d, 'Lima', 'Lima', None, None, HOLI_URL,
                             notes='Listed as establishment in official Libro de Reclamaciones form; ' + why))
assert len(holi_stores) == 12, len(holi_stores)
write('holi', {
    'chain': 'holi', 'retrieved': RETRIEVED,
    'sources': [HOLI_URL, 'https://holisupermercado.com/',
                'https://www.peru-retail.com/supermercados-holi-suma-su-segunda-tienda-en-importante-distrito-de-lima-donde-se-ubica/',
                'https://www.peru-retail.com/supermercados-holi-llega-por-primera-vez-a-un-distrito-tradicional-de-lima-y-suma-11-locales/',
                'https://gestion.pe/economia/empresas/a-que-zonas-llegara-supermercados-holi-con-sus-aperturas-la-ruta-de-expansion-para-2025-retail-miraflores-jesus-maria-barranco-mass-noticia/'],
    'reportedCount': {'value': 12,
                      'source': 'https://www.peru-retail.com/supermercados-holi-suma-su-segunda-tienda-en-importante-distrito-de-lima-donde-se-ubica/',
                      'date': '2026-07-27'},
    'complete': True,
    'method': ('Official site holisupermercado.com (WordPress) has no store list: its "find your store" map is a plain '
               'Google Maps search embed (not scraped). The official Libro de Reclamaciones form lists every establishment '
               '(label + street address) in a <select>; parsed those 12 options. No coordinates published -> lat/lng null '
               '(to be geocoded). 12 = company-reported count (12th store opened July 2026). Openings announced for '
               'Aug-Nov 2026 (Av. Derby Surco 7-Aug, Jesus Maria near Campo de Marte 14-Aug, Av. Schell 25-Sep, '
               'Pedro Venturo and Primavera in Nov) were NOT confirmed as open and are not included.'),
    'stores': holi_stores,
})

# ---------------------------------------------------------------- Tambo
TAMBO_URL = 'https://www.tambo.pe/tiendas'
TAMBO_API = 'https://websites-remix-main.service.getjusto.com/graphql (query getStoresForStoreSelector, websiteId EjKfjv3RYEXX9Puqa)'
items = json.load(open('tambo_stores_gql2.json', encoding='utf-8'))['data']['stores']['items']
EXCLUDE = {'TAMBO EJEMPLO - SURCO'}
BAD_COORDS = {'TAMBO MUNICIPALIDAD-C2 - ICA': ('', 'Ica', 'Ica',
              'official coordinates (and plus-code address) point to La Victoria, Lima, identical to TAMBO SANEUGENIO-C8 - LA VICTORIA, while the name says Ica; coordinates discarded, location needs manual verification')}
tambo = []
excluded = []
for s in sorted(items, key=lambda r: r['name']):
    if s['name'] in EXCLUDE:
        excluded.append(s['name']); continue
    a = s['address']; loc = a.get('location') or {}
    lat, lng = loc.get('lat'), loc.get('lng')
    street = (a.get('streetAddress') or '').strip()
    notes = ['Justo store id %s' % s['_id']]
    if a.get('locality'):
        notes.append('source locality: %s' % a['locality'])
    if a.get('subLocality'):
        notes.append('sublocality: %s' % a['subLocality'])
    if not s['acceptGo'] and not s['acceptDelivery']:
        notes.append('online pickup/delivery not enabled in the official system (typical of stores opened Apr-May 2026; could also be closed)')
    if s['name'] in BAD_COORDS:
        d, pr, dep, why = BAD_COORDS[s['name']]
        notes.append(why)
        tambo.append(store(s['name'], street, d, pr, dep, None, None, TAMBO_URL, notes='; '.join(notes)))
        continue
    p = locate(lat, lng)
    tambo.append(store(s['name'], street, p['district'] if p else '', p['province'] if p else '',
                       p['department'] if p else '', lat, lng, TAMBO_URL, notes='; '.join(notes)))
n_official = len(tambo)

# secondary: openings reported by Peru Retail (May-Aug 2026) that are not in the official Justo list
exec(open('tambo_news.py', encoding='utf-8').read())
SKIP = {1, 3, 6, 7, 9, 10, 12, 14}   # manually matched to Justo entries (see match.py / match2.py output)
POSSIBLE_DUP = {
    8: 'TAMBO-JARDINES-SJL (no street address in source)',
    22: 'TAMBO FAUCETT-C5 - SAN MIGUEL (Av. Elmer Faucett 500)',
    31: 'TAMBO MARISCALCACERES - SJL',
    34: 'TAMBO TANTAMAYO - SMP',
    49: 'TAMBO LIBERTAD - SAN MIGUEL (Av. Rafael Escardo 115)',
    55: 'TAMBO TALLANES-PIURA',
}
MONTHS = {'2026-05': 'May 2026', '2026-06': 'June 2026', '2026-07': 'July 2026', '2026-08': 'August 2026'}
for i, (m, u, d, pr, dep, addr, keys) in enumerate(N):
    if i in SKIP:
        continue
    first = addr.split(',')[0]
    nm = 'Tambo %s - %s' % (d or pr, first)
    notes = ['opening reported for %s by Peru Retail (trade press); not yet in the official Justo store list' % MONTHS[m]]
    if i in POSSIBLE_DUP:
        notes.append('possible duplicate of official entry ' + POSSIBLE_DUP[i])
    if d == 'Lurigancho':
        notes.append('article says Chosica (capital of Lurigancho district)')
    if d == 'Santa María':
        notes.append('article says Huacho')
    tambo.append(store(nm, addr, d, pr, dep, None, None, u, secondary=True, notes='; '.join(notes)))
print('tambo official', n_official, 'excluded', excluded, 'secondary', len(tambo) - n_official)
write('tambo', {
    'chain': 'tambo', 'retrieved': RETRIEVED,
    'sources': [TAMBO_URL, 'https://www.tambo.pe/pedir', TAMBO_API,
                'https://www.peru-retail.com/tambo-inaugura-20-nuevas-tiendas-y-supera-las-900-a-nivel-nacional-donde-estan-sus-nuevos-locales/',
                'https://www.peru-retail.com/tambo-inaugura-16-nuevas-tiendas-y-queda-cerca-de-alcanzar-los-900-locales-a-nivel-nacional/',
                'https://www.peru-retail.com/tambo-suma-23-nuevos-locales-en-junio-y-queda-cerca-de-alcanzar-900-tiendas-a-nivel-nacional/',
                'https://www.peru-retail.com/tambo-amplia-su-presencia-con-18-nuevos-locales-donde-estan-ubicados-y-cuantos-acumula/'],
    'reportedCount': {'value': 902,
                      'source': 'https://www.peru-retail.com/tambo-inaugura-20-nuevas-tiendas-y-supera-las-900-a-nivel-nacional-donde-estan-sus-nuevos-locales/',
                      'date': '2026-09-09'},
    'complete': False,
    'method': ('tambo.pe runs on the Justo ordering platform. Its public GraphQL API (the same query the site\'s store selector '
               'uses, getStoresForStoreSelector) returned all %d store records with name, street address, locality and '
               'lat/lng (the same set is embedded as schema.org JSON-LD on www.tambo.pe/pedir). Excluded 1 test record '
               '(TAMBO EJEMPLO - SURCO). District/province/department derived by point-in-polygon of the official coordinates '
               'against tools/seed/districts.geojson (the source "locality" is often just "Lima"). The Justo list lags '
               'recent openings (~mid-May 2026), so %d openings from May-Aug 2026 listed by Peru Retail and not found in '
               'the Justo list were added as secondary records without coordinates (manual address matching; 6 flagged '
               'as possible duplicates). September 2026 openings are not covered.') % (len(items), len(tambo) - n_official),
    'stores': tambo,
})

# ---------------------------------------------------------------- Oxxo
OX_WB = 'https://web.archive.org/web/20260124063904/https://oxxo.pe/nuestras-tiendas'
ox = json.load(open('oxxo_parsed.json', encoding='utf-8'))
ox_stores = []
for r in ox:
    lat, lng = float(r['lat']), float(r['lng'])
    n = UBI[r['ubigeo']]
    p = locate(lat, lng)
    notes = ['official ubigeo %s' % r['ubigeo'], 'Horario: %s' % r['hours'], '24h: %s' % ('yes' if r['open24'] == 'true' else 'no')]
    if p and p['ubigeo'] != r['ubigeo']:
        notes.append('official coordinates fall in %s (%s)' % (p['district'], p['ubigeo']))
    notes.append('from official oxxo.pe store list as archived 2026-01-24 (live page now redirects to /en-construccion)')
    ox_stores.append(store(r['name'], r['address'], n['district'], n['province'], n['department'], lat, lng, OX_WB,
                           notes='; '.join(notes)))
OX_METRO1 = 'https://www.peru-retail.com/oxxo-inaugura-su-primer-local-dentro-de-la-linea-1-del-metro-de-lima-en-que-estacion-se-encuentra/'
OX_METRO2 = 'https://www.peru-retail.com/oxxo-abre-una-nueva-tienda-dentro-de-la-linea-1-del-metro-de-lima-en-que-estacion-se-ubica/'
ox_stores.append(store('Oxxo Estación Gamarra (Línea 1)', 'Estación Gamarra, Línea 1 del Metro de Lima (Av. Aviación con Jr. Hipólito Unanue)',
                       'La Victoria', 'Lima', 'Lima', None, None, OX_METRO1, secondary=True,
                       notes='opened January 2026 per Peru Retail (2026-01-07); not in the archived official list of 2026-01-24'))
ox_stores.append(store('Oxxo Estación Villa El Salvador (Línea 1)', 'Estación Villa El Salvador, Línea 1 del Metro de Lima',
                       '', 'Lima', 'Lima', None, None, OX_METRO2, secondary=True,
                       notes='opening reported by Peru Retail on 2026-08-12; district not stated in article'))
write('oxxo', {
    'chain': 'oxxo', 'retrieved': RETRIEVED,
    'sources': ['https://oxxo.pe/ (live site redirects to /en-construccion)', OX_WB,
                'https://prodapimobisoft.oxxodomicilios.com/api/v1/stores/available-stores?countryId=PE (delivery app; only a test store)',
                'https://www.sec.gov/Archives/edgar/data/0001061736/000110465926087338/tm2621462d1_ex99-1.htm',
                OX_METRO1, OX_METRO2],
    'reportedCount': {'value': 215,
                      'source': 'https://www.sec.gov/Archives/edgar/data/0001061736/000110465926087338/tm2621462d1_ex99-1.htm',
                      'date': '2026-06-30'},
    'complete': False,
    'method': ('The live official site oxxo.pe is "en construccion" (all paths redirect) and the delivery app '
               '(peru.oxxodomicilios.com, public store-location API) only returns a test store. The official store page '
               'oxxo.pe/nuestras-tiendas was retrieved from the Internet Archive (only snapshot: 2026-01-24): 203 stores '
               'with name, address, lat/lng, official ubigeo, hours and 24h flag; district/province/department mapped from '
               'the official ubigeo. FEMSA 2Q26 results (6-K, 2026-07-28) report 215 OXXO stores in Peru at 2026-06-30, so '
               '~10-12 recent stores are missing; 2 later openings found in trade press (Metro Line 1 Gamarra, Jan 2026; '
               'Villa El Salvador station, Aug 2026) were added as secondary. Closures after 2026-01-24 are unknown.'),
    'stores': ox_stores,
})
