import sys, glob
from PIL import Image, ImageDraw
files = sys.argv[2:]
out = sys.argv[1]
cell_w, cell_h = 420, 240
cols = 3
rows = (len(files)+cols-1)//cols
sheet = Image.new("RGB", (cols*cell_w, rows*cell_h), (200,200,200))
d = ImageDraw.Draw(sheet)
for i,f in enumerate(files):
    x, y = (i%cols)*cell_w, (i//cols)*cell_h
    # checker
    for cx in range(0, cell_w-10, 20):
        for cy in range(0, cell_h-40, 20):
            if (cx//20+cy//20)%2==0: d.rectangle([x+5+cx,y+5+cy,x+5+cx+19,y+5+cy+19], fill=(235,235,235))
    im = Image.open(f).convert("RGBA")
    im.thumbnail((cell_w-20, cell_h-50))
    sheet.paste(im, (x+10, y+10), im)
    d.text((x+8, y+cell_h-30), f"{f} {Image.open(f).size}", fill=(0,0,0))
sheet.save(out)
