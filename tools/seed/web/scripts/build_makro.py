# Build tools/seed/web/makro.json from makro.pe/tiendas (__NEXT_DATA__ store list) + the official
# "Makro Tiendas" Google My Maps embedded on that page (KML export) + Makro pickup points (VTEX).
import re, json, sys, os, html
sys.path.insert(0, os.path.dirname(__file__))
from mass_coords import inpe, hav

ROOT = 'Z:/mapa-tiendas/tools/seed/web'
RAWD = ROOT + '/raw/makro'
PAGE = 'https://www.makro.pe/tiendas'
KML_URL = 'https://www.google.com/maps/d/kml?mid=1yaw2-hOdKMgzZ870qyfy4dvSw5Lx56Aj&forcekml=1'

nd = json.load(open(RAWD + '/makro-pe-tiendas-next-data.json', encoding='utf-8'))
pd = nd['props']['pageProps']['pageData']
stores_src = pd['stores']
kml = open(RAWD + '/makro-tiendas-mymaps.kml', encoding='utf-8').read()
pms = []
for p in re.findall(r'<Placemark>(.*?)</Placemark>', kml, re.S):
    n = re.search(r'<name>(.*?)</name>', p, re.S).group(1).strip()
    d = re.search(r'<description><!\[CDATA\[(.*?)\]\]>', p, re.S)
    d = d.group(1) if d else ''
    lng, lat, _ = [float(x) for x in re.search(r'<coordinates>\s*(.*?)\s*</coordinates>', p, re.S).group(1).split(',')]
    pms.append({'name': n, 'addr': html.unescape(d.split('<br>')[0]).strip(), 'lat': lat, 'lng': lng})
pp = json.load(open(RAWD + '/makro-pickup-points.json', encoding='utf-8'))

# JSON store name -> KML placemark name (matched by name/address; see raw files)
KMAP = {
    'Makro Cercado de Lima': 'Makro Cercado', 'Makro Chimbote': 'Makro Chimbote',
    'Makro San Martin de Porres': 'Makro San Martin de Porres', 'Makro Cañete': 'Makro Cañete',
    'Makro Huacho': 'Makro Huacho', 'Makro Ica': 'Makro Ica', 'Makro Chincha': 'Makro Chincha',
    'Makro Huancayo': 'Makro Huancayo', 'Makro Sullana': 'Makro Sullana', 'Makro Textil - Piura': 'Makro Piura 2',
    'Makro Sánchez Cerro - Piura': 'Makro Piura', 'Makro El Bosque - Trujillo': 'Makro Trujillo 2',
    'Makro La Esperanza - Trujillo': 'Makro Trujillo', 'Makro Chiclayo': 'Makro Chiclayo', 'Makro Cusco': 'Makro Cusco',
    'Makro Yanahuara - Arequipa': 'Makro Arequipa 2', 'Makro El Avelino - Arequipa': 'Makro Arequipa',
    'Makro Comas': 'Makro Comas', 'Makro San Juan de Lurigancho': 'Makro San Juan de Lurigancho',
    'Makro Zárate': 'Makro Zárate', 'Makro Chorrillos': 'Makro Chorrillos', 'Makro Villa el Salvador': 'Makro Villa Salvador',
    'Makro Independencia': 'Makro Independencia', 'Makro Santa Anita': 'Makro Santa Anita', 'Makro Surco': 'Makro Surco',
    'Makro Callao': 'Makro Callao',
}
# location fields: only what the official texts state (district left empty when not stated)
LOC = {
    'Makro San Juan de Miraflores': ('San Juan de Miraflores', 'Lima', 'Lima'),
    'Makro Cercado de Lima': ('Lima', 'Lima', 'Lima'),
    'Makro Chimbote': ('', 'Santa', 'Áncash'),
    'Makro San Martin de Porres': ('San Martín de Porres', 'Lima', 'Lima'),
    'Makro Cañete': ('', 'Cañete', 'Lima'),
    'Makro Huacho': ('Santa María', 'Huaura', 'Lima'),
    'Makro Ica': ('', 'Ica', 'Ica'),
    'Makro Chincha': ('', 'Chincha', 'Ica'),
    'Makro Huancayo': ('', 'Huancayo', 'Junín'),
    'Makro Sullana': ('', 'Sullana', 'Piura'),
    'Makro Textil - Piura': ('Veintiséis de Octubre', 'Piura', 'Piura'),
    'Makro Sánchez Cerro - Piura': ('', 'Piura', 'Piura'),
    'Makro El Bosque - Trujillo': ('', 'Trujillo', 'La Libertad'),
    'Makro La Esperanza - Trujillo': ('', 'Trujillo', 'La Libertad'),
    'Makro Chiclayo': ('', 'Chiclayo', 'Lambayeque'),
    'Makro Cusco': ('', 'Cusco', 'Cusco'),
    'Makro Yanahuara - Arequipa': ('Yanahuara', 'Arequipa', 'Arequipa'),
    'Makro El Avelino - Arequipa': ('José Luis Bustamante y Rivero', 'Arequipa', 'Arequipa'),
    'Makro Comas': ('Comas', 'Lima', 'Lima'),
    'Makro San Juan de Lurigancho': ('San Juan de Lurigancho', 'Lima', 'Lima'),
    'Makro Zárate': ('San Juan de Lurigancho', 'Lima', 'Lima'),
    'Makro Chorrillos': ('Chorrillos', 'Lima', 'Lima'),
    'Makro Villa el Salvador': ('', 'Lima', 'Lima'),
    'Makro Independencia': ('Independencia', 'Lima', 'Lima'),
    'Makro Santa Anita': ('', 'Lima', 'Lima'),
    'Makro Surco': ('Santiago de Surco', 'Lima', 'Lima'),
    'Makro Callao': ('', 'Callao', 'Callao'),
}

kml_by = {p['name'].strip(): p for p in pms}
out_stores = []
used = set()
for s in sorted(stores_src, key=lambda s: int(s['id'])):
    name = s['name'].strip()
    notes = ['makro.pe store id %s, code %s' % (s['id'], s['code'])]
    if s.get('attention'):
        notes.append('hours: ' + ' / '.join(a.strip() for a in s['attention']))
    lat = lng = None
    src = None
    # 1) coordinates in the makro.pe store JSON
    if s.get('latitud') and s.get('longitud'):
        a, b = float(s['latitud']), float(s['longitud'])
        if inpe(a, b):
            lat, lng, src = a, b, 'makro.pe store JSON'
        elif inpe(b, a):
            lat, lng, src = b, a, 'makro.pe store JSON'
            notes.append('makro.pe JSON has latitud/longitud swapped (%s, %s); swapped back' % (s['latitud'], s['longitud']))
    k = kml_by.get(KMAP.get(name, '#none'))
    if k:
        used.add(k['name'])
        if lat is None:
            lat, lng, src = k['lat'], k['lng'], 'official Makro Google My Maps (embedded on makro.pe/tiendas), placemark "%s"' % k['name']
        else:
            d = hav(lat, lng, k['lat'], k['lng'])
            notes.append('agrees with official My Maps placemark "%s" (%.2f km)' % (k['name'], d))
        if k['addr'] and k['addr'].upper() != s['address'].strip().upper():
            notes.append('My Maps address: %s' % k['addr'])
    # cross-check with VTEX pickup point coordinates when available
    for p in pp.values():
        fn = p['friendlyName']
        g = p['address']['geoCoordinates']
        if lat is not None and hav(lat, lng, g[1], g[0]) < 0.6:
            notes.append('pickup point "%s" (VTEX id %s) %.2f km away' % (fn, p['id'], hav(lat, lng, g[1], g[0])))
    if src:
        notes.append('coords: ' + src)
    dist, prov, dept = LOC.get(name, ('', '', ''))
    out_stores.append({
        'name': name, 'address': re.sub(r'\s+', ' ', s['address']).strip().rstrip(','),
        'district': dist, 'province': prov, 'department': dept,
        'lat': round(lat, 6) if lat is not None else None, 'lng': round(lng, 6) if lng is not None else None,
        'coordsSource': 'official' if lat is not None else 'none', 'url': PAGE, 'secondary': False,
        'notes': '; '.join(notes),
    })

unused = [p['name'] for p in pms if p['name'].strip() not in used]
out = {
    'chain': 'makro', 'retrieved': '2026-10-01',
    'sources': [PAGE, KML_URL, 'https://www.plazavea.com.pe/api/checkout/pub/pickup-points',
                "https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf"],
    'reportedCount': {'value': 27,
                      'source': "InRetail Peru Corp, Q2'26 Earnings Report (MD&A), Operating Metrics, 'Number of stores - Cash & Carry' (Makro) - https://www.inretail.pe/api/archivos/file/MDA%20InRetail%20Q2'26_ENG.pdf",
                      'date': '2026-06-30'},
    'complete': True,
    'method': ('Official store list = __NEXT_DATA__ JSON of %s (27 stores, CMS fields name/code/address/latitud/longitud/'
               'hours). That JSON has coordinates for only 5 stores (4 of them with lat/lng swapped - fixed). The same page '
               'embeds Makro\'s own Google My Maps "Makro Tiendas" (mid=1yaw2-hOdKMgzZ870qyfy4dvSw5Lx56Aj); its KML export '
               '(26 placemarks, one per store except the newest, San Juan de Miraflores) supplied the remaining coordinates. '
               'Coordinates cross-checked against the Makro pickup points in the VTEX pickup-points API (11 matches, all <0.6 km). '
               'Count = 27 = InRetail Cash & Carry stores at 2026-06-30. Unmatched KML placemarks: %s.') % (PAGE, unused or 'none'),
    'stores': out_stores,
}
json.dump(out, open(ROOT + '/makro.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(out_stores), 'with coords', sum(1 for s in out_stores if s['lat'] is not None), 'unused kml', unused)
