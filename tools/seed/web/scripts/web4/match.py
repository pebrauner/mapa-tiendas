import json, re, unicodedata
from collections import Counter
exec(open('tambo_news.py', encoding='utf-8').read())
it = json.load(open('tambo_stores_gql2.json', encoding='utf-8'))['data']['stores']['items']

def norm(s):
    return ''.join(c for c in unicodedata.normalize('NFD', (s or '').upper()) if unicodedata.category(c) != 'Mn')

def find(keys):
    hits = []
    for s in it:
        nm = norm(s['name']); sa = norm(s['address'].get('streetAddress'))
        for tok, num in keys:
            if tok in nm or tok in sa:
                if num is None:
                    hits.append(s); break
                blk = 'C%d' % (num // 100)
                if re.search(r'\b%d\b' % num, sa) or re.search(r'-%s\b' % blk, nm):
                    hits.append(s); break
    return hits

if __name__ == '__main__':
    cnt = Counter()
    for m, u, d, p, dep, addr, keys in N:
        hits = find(keys)
        st = 'MATCH' if hits else 'NONE'
        cnt[(m, st)] += 1
        print(m, st, '|', d, '|', addr, '||', ' ;; '.join(h['name'] + ' [' + (h['address'].get('streetAddress') or '') + '] go=' + str(h['acceptGo']) + ' del=' + str(h['acceptDelivery']) for h in hits[:3]))
    print(sorted(cnt.items()))
