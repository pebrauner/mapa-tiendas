import json, re
from match import N, it, norm

# loose: any Justo store whose name or street contains the first key token (no number filter)
for i, (m, u, d, p, dep, addr, keys) in enumerate(N):
    toks = [k for k, _ in keys]
    loose = []
    for s in it:
        nm = norm(s['name']); sa = norm(s['address'].get('streetAddress'))
        if any(t in nm or t in sa for t in toks):
            loose.append('%s [%s] go=%s' % (s['name'], s['address'].get('streetAddress'), s['acceptGo']))
    print(i, m, '|', d, '|', addr)
    for l in loose[:6]:
        print('      ~', l)
