import re, json, html
from collections import Counter

h = open('ox_wb_tiendas.html', encoding='utf-8').read()
names = json.load(open('ubigeo_names.json', encoding='utf-8'))
items = re.findall(r'<li class="stores__list__item fnStoresItem[^"]*"(.*?)</li>\s*</ul>\s*<aside', h, re.S)
# robust approach: split on the item opening tag
parts = re.split(r'<li class="stores__list__item fnStoresItem', h)[1:]
out = []
for p in parts:
    attrs = p[:p.find('>')]
    def a(n):
        m = re.search(n + r'="([^"]*)"', attrs)
        return html.unescape(m.group(1)).strip() if m else None
    title = re.search(r'<h2 class="stores__list__title">.*?</span>(.*?)</h2>', p, re.S)
    loc = re.search(r'<p class="stores__list__location">(.*?)</p>', p, re.S)
    hours = re.search(r'Horario de atenci[^<]*</strong>\s*<p class="stores__list__list__item__text">(.*?)</p>', p, re.S)
    rec = {
        'name': a('data-name'),
        'title': html.unescape(re.sub(r'\s+', ' ', title.group(1))).strip() if title else None,
        'address': html.unescape(re.sub(r'\s+', ' ', loc.group(1))).strip() if loc else None,
        'lat': a('data-coords-lat'), 'lng': a('data-coords-lng'),
        'dep': a('data-departamento'), 'prov': a('data-provincia'), 'ubigeo': a('data-distrito'),
        'open24': a('data-allways-open'),
        'hours': html.unescape(re.sub(r'\s+', ' ', hours.group(1))).strip() if hours else None,
    }
    out.append(rec)
print(len(out))
print(Counter(r['dep'] for r in out), Counter(r['open24'] for r in out))
bad = [r for r in out if not r['lat'] or not r['lng']]
print('nocoords', len(bad))
def f(x):
    try: return float(x)
    except: return None
outside = [r for r in out if not (f(r['lat']) and -18.4 <= f(r['lat']) <= -0.03 and -81.4 <= f(r['lng']) <= -68.6)]
print('outside', len(outside), outside[:5])
nn = Counter(r['name'] for r in out); print('dupnames', [x for x in nn.items() if x[1] > 1])
cc = Counter((r['lat'], r['lng']) for r in out); print('dupcoords', [x for x in cc.items() if x[1] > 1])
unk = [r['ubigeo'] for r in out if r['ubigeo'] not in names]; print('unknown ubigeo', unk)
for r in out[:5]: print(r)
json.dump(out, open('oxxo_parsed.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
