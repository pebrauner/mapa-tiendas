import sys,re,html
h=open(sys.argv[1],encoding='utf-8').read()
a=h.find('class="entry-content')
b=len(h)
for endmark in ['class="post-tags','class="jeg_share_bottom','id="comments','class="jeg_post_tags','class="related']:
    j=h.find(endmark,a)
    if j>0: b=min(b,j)
body=h[a:b] if a>0 else h
body=re.sub(r'<script.*?</script>|<style.*?</style>|<figure.*?</figure>','',body,flags=re.S)
body=re.sub(r'</(p|li|h[1-6]|div|tr)>|<br\s*/?>','\n',body)
t=html.unescape(re.sub(r'<[^>]+>','',body))
lines=[re.sub(r'\s+',' ',l).strip() for l in t.split('\n')]
lines=[l for l in lines if l]
print('\n'.join(lines))
