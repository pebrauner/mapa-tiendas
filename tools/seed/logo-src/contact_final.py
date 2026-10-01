"""Final logo contact sheet: every chain's badge drawn the way js/markers.js drawBadge() draws it, at 32, 40 and 64 px
(ring = 3.5/46 of the diameter in the chain's ring colour, white hairline, logo square clipped to the inner disc,
chain badgeZoom honoured), next to the card style (white rounded card, wide wordmark or square mark, hairline border in
the ring colour) at 30 and 40 px tall, on a map-like background. Ring colours and badgeZoom come from data/chains.js.

usage (from the repo root):  python tools/seed/logo-src/contact_final.py [--out=file.png] [--only-extra] [extra.png=chainId ...]
default out: tools/seed/logos-contact-final.png. Extra badge PNGs are drawn on
extra rows with the ring colour of the named chain, for side-by-side comparisons (e.g. logos/plazavea-alt.png=plazavea).
"""
import json, os, re, sys, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
LOGOS = os.path.join(ROOT, "logos")
SS = 4  # supersampling factor

# js/theme.js marker.badge / marker.card (reference units)
B_DIAM, B_RING = 46.0, 3.5
C_H, C_PAD, C_RAD, C_BORDER, C_MAXW = 30.0, 5.0, 6.0, 1.5, 104.0


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def chains():
    src = open(os.path.join(ROOT, "data", "chains.js"), encoding="utf8").read()
    m = re.search(r"window\.MT_CHAINS = (\[.*?\n\]);", src, re.S)
    return json.loads(m.group(1))


def shadow_under(im, blur, dy, alpha=0.28):
    """Soft drop shadow like the app (rgba(17,24,39,.28), blur, offsetY)."""
    a = im.getchannel("A").point(lambda v: int(v * alpha))
    sh = Image.new("RGBA", im.size, (17, 24, 39, 0))
    sh.putalpha(a)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    out = Image.new("RGBA", (im.width, im.height + dy), (0, 0, 0, 0))
    out.alpha_composite(sh, (0, dy))
    out.alpha_composite(im, (0, 0))
    return out


def badge_marker(badge, d, ring_hex, zoom=1.0):
    """js/markers.js drawBadge at diameter d px (supersampled)."""
    D = d * SS
    k = D / B_DIAM
    ring = B_RING * k
    inset = max(0.6 * k, ring * 0.26)  # max(0.6, ring·0.26) reference units, at size 1
    lr = D / 2 - ring - inset
    out = Image.new("RGBA", (D, D), (0, 0, 0, 0))
    dr = ImageDraw.Draw(out)
    dr.ellipse((0, 0, D - 1, D - 1), fill=hexrgb(ring_hex) + (255,))
    dr.ellipse((ring, ring, D - 1 - ring, D - 1 - ring), fill=(255, 255, 255, 255))
    lz = lr * zoom
    size = max(1, round(2 * lz))
    b = badge.resize((size, size), Image.LANCZOS)
    layer = Image.new("RGBA", (D, D), (0, 0, 0, 0))
    layer.alpha_composite(b, (round(D / 2 - lz), round(D / 2 - lz)))
    mask = Image.new("L", (D, D), 0)
    ImageDraw.Draw(mask).ellipse((D / 2 - lr, D / 2 - lr, D / 2 + lr, D / 2 + lr), fill=255)
    clipped = Image.new("RGBA", (D, D), (0, 0, 0, 0))
    clipped.paste(layer, (0, 0), mask)
    out.alpha_composite(clipped)
    return out.resize((d, d), Image.LANCZOS)


def card_marker(wide, badge, h, ring_hex, zoom=1.0):
    """js/markers.js drawCard at height h px: wide wordmark, else the square mark inside a square card."""
    H = h * SS
    k = H / C_H
    p = C_PAD * k
    inner = H - 2 * p
    if wide is not None:
        w_px = min(max(inner * wide.width / wide.height + 2 * p, H), C_MAXW * k)
    else:
        w_px = H
    W = round(w_px)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dr = ImageDraw.Draw(out)
    rad = C_RAD * k
    dr.rounded_rectangle((0, 0, W - 1, H - 1), radius=rad, fill=(255, 255, 255, 255))
    if wide is not None:
        bw, bh = W - 2 * p, H - 2 * p
        s = min(bw / wide.width, bh / wide.height)
        im = wide.resize((max(1, round(wide.width * s)), max(1, round(wide.height * s))), Image.LANCZOS)
        out.alpha_composite(im, (round((W - im.width) / 2), round((H - im.height) / 2)))
    else:
        ins = max(p * 0.6, (C_BORDER + 1) * k)
        s = min(W, H) - 2 * ins
        sz = round(s * zoom)
        im = badge.resize((sz, sz), Image.LANCZOS)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        layer.alpha_composite(im, (round((W - sz) / 2), round((H - sz) / 2)))
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rounded_rectangle(((W - s) / 2, (H - s) / 2, (W + s) / 2, (H + s) / 2), radius=max(0, rad - ins / 2), fill=255)
        clipped = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        clipped.paste(layer, (0, 0), mask)
        out.alpha_composite(clipped)
    bwid = C_BORDER * k
    dr = ImageDraw.Draw(out)
    dr.rounded_rectangle((bwid / 2, bwid / 2, W - 1 - bwid / 2, H - 1 - bwid / 2), radius=max(0, rad - bwid / 2), outline=hexrgb(ring_hex) + (255,), width=max(1, round(bwid)))
    return out.resize((max(1, round(W / SS)), h), Image.LANCZOS)


def map_bg(w, h, seed=7):
    rnd = random.Random(seed)
    im = Image.new("RGB", (w, h), (242, 243, 245))
    dr = ImageDraw.Draw(im)
    for _ in range(int(w * h / 9000)):
        x, y = rnd.randrange(w), rnd.randrange(h)
        dr.rectangle((x, y, x + rnd.randrange(30, 120), y + rnd.randrange(20, 70)), fill=(222, 238, 218))
    for _ in range(int(w * h / 6000)):
        if rnd.random() < 0.5:
            y = rnd.randrange(h); dr.line((0, y, w, y + rnd.randrange(-40, 40)), fill=(255, 255, 255), width=rnd.choice([2, 3, 5]))
        else:
            x = rnd.randrange(w); dr.line((x, 0, x + rnd.randrange(-40, 40), h), fill=(255, 255, 255), width=rnd.choice([2, 3, 5]))
    for _ in range(max(2, int(h / 120))):
        y = rnd.randrange(h); dr.line((0, y, w, y + rnd.randrange(-80, 80)), fill=(250, 214, 160), width=6)
    return im


def font(sz, bold=False):
    for f in (["arialbd.ttf", "Arial Bold.ttf"] if bold else ["arial.ttf", "Arial.ttf"]):
        try:
            return ImageFont.truetype(f, sz)
        except Exception:
            pass
    return ImageFont.load_default()


def main():
    args = sys.argv[1:]
    out = os.path.join(ROOT, "tools", "seed", "logos-contact-final.png")
    only_extra = "--only-extra" in args
    if only_extra:
        args.remove("--only-extra")
    for a in list(args):
        if a.startswith("--out="):
            out = a[6:]
            args.remove(a)
    cs = chains()
    by = {c["id"]: c for c in cs}
    rows = [] if only_extra else [(c["id"], os.path.join(LOGOS, c["id"] + ".png"), c["id"]) for c in cs]
    for a in args:
        path, cid = a.rsplit("=", 1)
        rows.append((os.path.basename(path), path if os.path.isabs(path) else os.path.join(ROOT, path), cid))
    row_h, W = 84, 980
    H = 70 + len(rows) * row_h + 20
    sheet = map_bg(W, H).convert("RGBA")
    dr = ImageDraw.Draw(sheet)
    f, fb = font(13), font(14, True)
    dr.rectangle((0, 0, W, 52), fill=(255, 255, 255))
    dr.text((12, 8), "Badges as js/markers.js draws them (ring 3.5/46 · white hairline · clipped disc · badgeZoom) at 32 / 40 / 64 px, "
            "and cards at 30 / 40 px tall", fill=(30, 30, 30), font=fb)
    dr.text((12, 30), "source: logos/<id>.png (badge) and logos/<id>-wide.png (card); ring colours from data/chains.js", fill=(90, 90, 90), font=f)
    cols = {"name": 12, "b32": 170, "b40": 225, "b64": 290, "c30": 390, "c40": 560}
    for i, (label, path, cid) in enumerate(rows):
        c = by[cid]
        ring = c.get("ringColor") or c["color"]
        zoom = float(c.get("badgeZoom") or 1)
        y0 = 62 + i * row_h
        dr.rectangle((0, y0 - 4, 160, y0 + row_h - 12), fill=(255, 255, 255))
        name = label if label != cid else c["name"]
        dr.text((cols["name"], y0 + 18), name if len(name) <= 17 else name[:16] + "…", fill=(20, 20, 20), font=fb)
        dr.text((cols["name"], y0 + 38), f"ring {ring}" + (f" · zoom {zoom:g}" if zoom != 1 else ""), fill=(110, 110, 110), font=f)
        badge = Image.open(path).convert("RGBA")
        wide_p = os.path.join(LOGOS, cid + "-wide.png")
        wide = Image.open(wide_p).convert("RGBA") if label == cid and os.path.exists(wide_p) else None
        for key, d in (("b32", 32), ("b40", 40), ("b64", 64)):
            m = shadow_under(badge_marker(badge, d, ring, zoom), 1.5, 1)
            sheet.alpha_composite(m, (cols[key], y0 + (64 - d) // 2))
        for key, h in (("c30", 30), ("c40", 40)):
            m = shadow_under(card_marker(wide, badge, h, ring, zoom), 1.5, 1)
            sheet.alpha_composite(m, (cols[key], y0 + (64 - h) // 2))
        if label == cid:
            dr.text((cols["c30"], y0 + 58), "card: " + ("wide wordmark" if wide is not None else "square mark (no -wide.png)"), fill=(90, 90, 90), font=f)
    sheet.convert("RGB").save(out, optimize=True)
    print("wrote", out, sheet.size)


if __name__ == "__main__":
    main()
