"""Contact sheet: each badge clipped to a circle with a 3 px brand-colour ring, at 40 px and 128 px,
on a light-grey map-like background; plus the -wide wordmarks on white cards.
usage: python contact_sheet.py out.png id:ring id:ring ...
"""
import os, sys, random
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
LOGOS = os.path.normpath(os.path.join(HERE, "..", "..", "..", "logos"))
SS = 4  # supersampling


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def marker(badge, d, ring_hex, ring_px=3):
    D = d * SS
    out = Image.new("RGBA", (D, D), (0, 0, 0, 0))
    dr = ImageDraw.Draw(out)
    dr.ellipse((0, 0, D - 1, D - 1), fill=hexrgb(ring_hex) + (255,))
    inner = D - 2 * ring_px * SS
    b = badge.resize((inner, inner), Image.LANCZOS)
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, inner - 1, inner - 1), fill=255)
    # badge may have transparent corners: put white under it
    under = Image.new("RGBA", (inner, inner), (255, 255, 255, 255))
    under.alpha_composite(b)
    out.paste(under, (ring_px * SS, ring_px * SS), mask)
    return out.resize((d, d), Image.LANCZOS)


def map_bg(w, h, seed=3):
    rnd = random.Random(seed)
    im = Image.new("RGB", (w, h), (242, 243, 245))
    dr = ImageDraw.Draw(im)
    for _ in range(18):
        x, y = rnd.randrange(w), rnd.randrange(h)
        dr.rectangle((x, y, x + rnd.randrange(30, 120), y + rnd.randrange(20, 70)), fill=(222, 238, 218))
    for _ in range(40):
        if rnd.random() < 0.5:
            y = rnd.randrange(h); dr.line((0, y, w, y + rnd.randrange(-40, 40)), fill=(255, 255, 255), width=rnd.choice([2, 3, 5]))
        else:
            x = rnd.randrange(w); dr.line((x, 0, x + rnd.randrange(-40, 40), h), fill=(255, 255, 255), width=rnd.choice([2, 3, 5]))
    for _ in range(4):
        y = rnd.randrange(h); dr.line((0, y, w, y + rnd.randrange(-80, 80)), fill=(250, 214, 160), width=6)
    return im


def main():
    out = sys.argv[1]
    items = [a.split(":") for a in sys.argv[2:]]
    col_w, row_h = 300, 210
    cols = 4
    rows = (len(items) + cols - 1) // cols
    W, H = cols * col_w + 30, rows * row_h + 40
    sheet = map_bg(W, H).convert("RGBA")
    dr = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 13)
    except Exception:
        font = ImageFont.load_default()
    dr.text((10, 10), "badge @40px and @128px (3px ring) on map-like background  |  -wide on white card", fill=(60, 60, 60), font=font)
    for i, it in enumerate(items):
        cid, ring = it[0], it[1]
        fname = it[2] if len(it) > 2 else cid + ".png"
        x0, y0 = (i % cols) * col_w, 40 + (i // cols) * row_h
        b = Image.open(os.path.join(LOGOS, fname) if os.path.exists(os.path.join(LOGOS, fname)) else os.path.join(HERE, fname)).convert("RGBA")
        m40 = marker(b, 40, ring)
        m128 = marker(b, 128, ring)
        # small anchor dot + stem like the app
        dr.line((x0 + 30, y0 + 70, x0 + 30, y0 + 82), fill=(90, 90, 90), width=1)
        dr.ellipse((x0 + 27, y0 + 80, x0 + 33, y0 + 86), fill=hexrgb(ring))
        sheet.alpha_composite(m40, (x0 + 10, y0 + 30))
        sheet.alpha_composite(m128, (x0 + 70, y0 + 10))
        wide = os.path.join(LOGOS, cid + "-wide.png")
        if len(it) <= 2 and os.path.exists(wide):
            w = Image.open(wide).convert("RGBA")
            w.thumbnail((92, 34), Image.LANCZOS)
            cw, ch = w.width + 12, w.height + 10
            card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
            ImageDraw.Draw(card).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=5, fill=(255, 255, 255, 255), outline=(200, 200, 200, 255))
            card.alpha_composite(w, (6, 5))
            sheet.alpha_composite(card, (x0 + 205, y0 + 60))
        dr.text((x0 + 10, y0 + 150), f"{cid}  ring {ring}" + ("" if len(it) <= 2 else f"  [{fname}]"), fill=(30, 30, 30), font=font)
    sheet.convert("RGB").save(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
