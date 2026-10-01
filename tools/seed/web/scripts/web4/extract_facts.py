"""Write minimal factual extracts (URL, date, store address list lines, store-count phrase) of news articles.
Only the address lists and counts are kept, not the article prose."""
import re, sys, html, subprocess

def facts(path):
    h = open(path, encoding='utf-8').read()
    url = re.search(r'og:url" content="([^"]*)"', h).group(1)
    date = re.search(r'"datePublished":"([^"]*)"', h)
    title = re.search(r'<title>(.*?)</title>', h, re.S)
    text = subprocess.run([sys.executable, 'prtext.py', path], capture_output=True, encoding='utf-8').stdout
    body = text.split('ADVERTISEMENT')[0]
    keep = []
    for l in body.split('\n'):
        l = l.strip()
        if re.match(r'^[A-ZÁÉÍÓÚÑ][^:]{1,60}\(\d+\):', l) or re.match(r'^(Lima Metropolitana|Callao|Provincia Constitucional del Callao|Provincias)$', l) \
           or re.match(r'^(Arequipa|Ica \(Pisco\)|Trujillo):', l) or re.match(r'^Calle\. ', l):
            keep.append(l)
        for m in re.finditer(r'[^.]*\b(\d{3}) (tiendas|establecimientos|locales)[^.]*', l):
            if re.search(r'alcanz|elev|suma|red|opera|cuenta', m.group(0)):
                keep.append('COUNT: ' + m.group(0).strip()[:200])
        for m in re.finditer(r'[^.]*estaci[oó]n (Gamarra|Villa El Salvador)[^.]*', l):
            keep.append('LOCATION: ' + m.group(0).strip()[:250])
    out = ['url: ' + url, 'datePublished: ' + (date.group(1) if date else ''),
           'title: ' + (html.unescape(title.group(1)).strip() if title else ''), '---'] + list(dict.fromkeys(keep))
    return '\n'.join(out) + '\n'

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    open(dst, 'w', encoding='utf-8').write(facts(src))
