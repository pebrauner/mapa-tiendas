"""Build logos/<id>.png (512x512 circle-safe badge) and logos/<id>-wide.png for the
plazavea / tottus / wong / metro / vivanda / mass / preciouno / makro chains.

All inputs are official artwork downloaded into tools/seed/logo-src/<id>/ (see downloads.json)
and high-res renders of the official SVGs in tools/seed/logo-src/hi/ (made with svg2png.mjs).

Run from tools/seed/logo-src:  python build_badges.py [id ...]     then: node tools/build-logos.mjs
Check:                         python contact_final.py  (-> tools/seed/logos-contact-final.png)

Size rule (2026-10-01 polish): js/markers.js draws the whole 512 square into the badge's inner disc (0.81 of the
badge diameter, inside the ring), so content is fitted to a circle of 86-90% of the square (~70% of the badge
diameter), and marks too small at 32 px were re-composed (Plaza Vea stacked, Tottus green, Mass letters only).
"""
import math, os, sys
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
LOGOS = os.path.normpath(os.path.join(HERE, "..", "..", "..", "logos"))
S = 512
R_SAFE = 0.43 * S        # farthest content pixel from centre (content inside the central 86% circle)
W_SAFE = 0.86 * S        # max content width


def P(*a):
    return os.path.join(HERE, *a)


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load(path):
    return Image.open(P(path)).convert("RGBA")


def trim_alpha(im, thr=8):
    a = im.getchannel("A").point(lambda v: 255 if v > thr else 0)
    bb = a.getbbox()
    return im.crop(bb) if bb else im


def key_out(im, bg_hex, fg_hex=None, lo=40, hi=140):
    """Turn pixels close to bg colour transparent (soft edge between lo..hi colour distance).
    If fg_hex is given the remaining pixels are painted with that exact colour (clean text)."""
    bg = hexrgb(bg_hex)
    fg = hexrgb(fg_hex) if fg_hex else None
    src = im.convert("RGBA")
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    sp, op = src.load(), out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = sp[x, y]
            if a < 10:
                continue
            d = math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
            al = 0 if d <= lo else (255 if d >= hi else int(255 * (d - lo) / (hi - lo)))
            al = al * a // 255
            if al:
                op[x, y] = (fg + (al,)) if fg else (r, g, b, al)
    return out


def recolor(im, hex_):
    """Keep alpha, paint every pixel with one colour (used to recolour a monochrome vector)."""
    c = hexrgb(hex_)
    out = Image.new("RGBA", im.size, c + (0,))
    out.putalpha(im.getchannel("A"))
    return out


def far_extent(mark):
    """Max distance (px) from the mark's centre to any opaque pixel."""
    a = mark.getchannel("A")
    small = mark
    k = 1
    if max(mark.size) > 600:  # speed: measure on a downscaled copy
        k = max(mark.size) / 600
        small = mark.resize((max(1, int(mark.width / k)), max(1, int(mark.height / k))), Image.LANCZOS)
        a = small.getchannel("A")
    cx, cy = small.width / 2, small.height / 2
    px = a.load()
    d = 0
    for y in range(small.height):
        for x in range(small.width):
            if px[x, y] > 64:
                dd = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if dd > d:
                    d = dd
    return d * k


def badge(mark, bg_hex=None, r_safe=R_SAFE, w_safe=W_SAFE, dy=0.0):
    """Place the trimmed mark centred on a 512 square (bg colour or transparent)."""
    mark = trim_alpha(mark)
    scale = min(r_safe / far_extent(mark), w_safe / mark.width)
    m = mark.resize((max(1, round(mark.width * scale)), max(1, round(mark.height * scale))), Image.LANCZOS)
    base = Image.new("RGBA", (S, S), hexrgb(bg_hex) + (255,) if bg_hex else (0, 0, 0, 0))
    x = (S - m.width) // 2
    y = (S - m.height) // 2 + int(dy * S)
    base.alpha_composite(m, (x, y))
    return base, scale


def stack(parts, gap, align="center"):
    """Stack trimmed images vertically (gap in px, may be negative to interlock ascenders/descenders)."""
    w = max(p.width for p in parts)
    h = sum(p.height for p in parts) + gap * (len(parts) - 1)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    y = 0
    for p in parts:
        x = (w - p.width) // 2 if align == "center" else 0
        out.alpha_composite(p, (x, y))
        y += p.height + gap
    return out


def split_x(im, lo, hi):
    """Column in [lo, hi) with no ink (alpha) - where a wordmark can be cut between two letters."""
    a = im.getchannel("A").load()
    best = None
    for x in range(lo, hi):
        ink = sum(1 for y in range(0, im.height, 2) if a[x, y] > 40)
        if best is None or ink < best[0]:
            best = (ink, x)
    if best[0]:
        raise SystemExit(f"no empty column between {lo} and {hi} (min ink {best[0]} at {best[1]})")
    return best[1]


def scaled(im, f):
    return im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.LANCZOS)


def wide(mark, max_w=512):
    mark = trim_alpha(mark)
    if mark.width > max_w:
        mark = mark.resize((max_w, round(mark.height * max_w / mark.width)), Image.LANCZOS)
    return mark


def save(im, name):
    os.makedirs(LOGOS, exist_ok=True)
    path = os.path.join(LOGOS, name)
    im.save(path, optimize=True)
    print("wrote", path, im.size)


def build(which=None):
    jobs = {}

    # ---- Plaza Vea: the official white "plazavea" wordmark (LogoPlazaVea.svg, white letters + yellow "V"
    #      swoosh) on the red of the official PWA icon (#EE3037), re-stacked as "plaza" over "vea" so the
    #      letters stay readable at 32-40 px (one line of 8 letters is a ~3 px squiggle there). The user's
    #      slides use the wordmark. Alternative (logos/plazavea-alt.png, not used by the app): the official
    #      app-icon symbol (yellow swoosh of IconLogov2.svg) on the same red - clean, but only a tick at 40 px.
    def plazavea():
        wm = load("hi/plazavea-wordmark-white.png")
        # "plaza" = white pixels left of x=1440 (the last "a" ends at 1439); "vea" = the yellow swoosh (its tip
        # overhangs that "a") + everything from x=1440 on
        plaza, vea = Image.new("RGBA", wm.size, (0, 0, 0, 0)), Image.new("RGBA", wm.size, (0, 0, 0, 0))
        src, pl, ve = wm.load(), plaza.load(), vea.load()
        for y in range(wm.height):
            for x in range(wm.width):
                c = src[x, y]
                if c[3]:
                    yellow = c[2] < 140 and c[0] > 180
                    (ve if (x >= 1440 or yellow) else pl)[x, y] = c
        plaza, vea = trim_alpha(plaza), trim_alpha(vea)
        # "vea" tucks under "plaza": the p descender (left) and the swoosh top (right) interlock
        b, _ = badge(stack([plaza, vea], round(-0.10 * wm.height)), "#EE3037", r_safe=0.44 * S, w_safe=0.86 * S)
        save(b, "plazavea.png")
        ic = load("hi/plazavea-icon.png")
        v = key_out(ic, "#CC292E", "#FFC700", 60, 160)  # keep only the yellow swoosh (#FFC700 per the SVG)
        b2, _ = badge(v, "#EE3037", r_safe=0.40 * S, w_safe=0.80 * S)
        save(b2, "plazavea-alt.png")
        save(wide(load("hi/plazavea-wordmark-red.png")), "plazavea-wide.png")
    jobs["plazavea"] = plazavea

    # ---- Tottus: official dot-grid symbol over the "TOTTUS" wordmark (vector, tottus.com.pe header logo), both
    #      in white on Tottus green #08813C - the store-sign version the user's slides use. The multicolour grid
    #      on white read as a few specks at 32 px.
    def tottus():
        full = load("hi/tottus-standalone.png")
        dots = trim_alpha(full.crop((0, 0, int(full.width * 33 / 160), full.height)))
        word = trim_alpha(full.crop((int(full.width * 33 / 160), 0, full.width, full.height)))
        word = scaled(word, 1.42 * dots.width / word.width)       # wordmark ~1.4x as wide as the grid
        block = stack([recolor(dots, "#FFFFFF"), recolor(word, "#FFFFFF")], round(0.09 * dots.height))
        b, _ = badge(block, "#08813C", r_safe=0.44 * S, w_safe=0.86 * S)
        save(b, "tottus.png")
        save(wide(full), "tottus-wide.png")
    jobs["tottus"] = tottus

    # ---- Wong: white "Wong" wordmark lifted from the official Google Play icon, on Wong red. The same lifted
    #      wordmark in Wong red is logos/wong-wide.png (cards): wong.pe shows only the Cencosud logo, and the
    #      Commons "Logo Wong (2005).svg" has older letterforms (dot, O and spacing differ from the app icon).
    def wong():
        ic = load("wong/googleplay-icon-512.png")
        # inner red disc: centre (255,256) r=225; paint everything outside r=212 red so the
        # white outer ring / dot do not leak into the crop, then lift the white wordmark
        from PIL import ImageDraw
        disc = Image.new("L", ic.size, 0)
        ImageDraw.Draw(disc).ellipse((255 - 212, 256 - 212, 255 + 212, 256 + 212), fill=255)
        redbg = Image.new("RGBA", ic.size, hexrgb("#F20E00") + (255,))
        redbg.paste(ic, (0, 0), disc)
        crop = redbg.crop((40, 150, 472, 330))
        wm = key_out(crop, "#F20E00", "#FFFFFF", 60, 200)
        b, _ = badge(wm, "#F20E00", r_safe=0.45 * S, w_safe=0.88 * S)
        save(b, "wong.png")
        save(wide(recolor(wm, "#F20E00")), "wong-wide.png")
    jobs["wong"] = wong

    # ---- Metro: red "Metro" wordmark lifted from the official Google Play icon, on Metro yellow. Wide
    #      (cards): the same "Metro" lifted at ~1000 px from the official metro.pe logo SVG (render in
    #      metro/logo-metro.render.png: pure #FFFF00 / #FF0000), painted in the app-icon red #E22113.
    def metro():
        ic = load("metro/googleplay-icon-512.png")
        crop = ic.crop((40, 185, 472, 305))      # rows 195-293 = "Metro" (excludes dot and "cencosud")
        wm = key_out(crop, "#F9E014", "#E22113", 60, 200)
        b, _ = badge(wm, "#F9E014", r_safe=0.45 * S, w_safe=0.88 * S)
        save(b, "metro.png")
        hi = load("metro/logo-metro.render.png").crop((70, 380, 1130, 740))  # "Metro" only (no dot, no cencosud)
        # alpha = red-ness: yellow (255,255,0) and the white ring (255,255,255) -> 0, red (255,0,0) -> 255
        alpha = Image.eval(ImageChops.subtract(ImageChops.invert(hi.getchannel("G")), hi.getchannel("B")), lambda v: v)
        word = Image.new("RGBA", hi.size, hexrgb("#E22113") + (0,))
        word.putalpha(ImageChops.multiply(alpha, hi.getchannel("A")))
        save(wide(trim_alpha(word, 24)), "metro-wide.png")
    jobs["metro"] = metro

    # ---- Vivanda: official radish symbol (vector from vivanda.com.pe) on white
    def vivanda():
        rad = load("hi/vivanda-radish.png")
        b, _ = badge(rad, "#FFFFFF", r_safe=0.42 * S)
        save(b, "vivanda.png")
        save(wide(load("hi/vivanda-wordmark.png")), "vivanda-wide.png")
    jobs["vivanda"] = vivanda

    # ---- Mass: "Mass" + check wordmark (Commons vector geometry, recoloured to the blue of the
    #      current tiendasmass.com.pe logo) on the yellow of the official favicon. The badge keeps only the
    #      letters "Mass" (with the check they were ~4 px tall at 32 px); the wide logo keeps the check.
    def mass():
        wm = recolor(load("hi/mass-wordmark.png"), "#0A2DB7")
        cut = split_x(wm, 1600, 1720)                    # between "Mass" and the check
        b, _ = badge(trim_alpha(wm.crop((0, 0, cut, wm.height))), "#FDC616", r_safe=0.44 * S, w_safe=0.88 * S)
        save(b, "mass.png")
        save(wide(wm), "mass-wide.png")
    jobs["mass"] = mass

    # ---- Precio Uno: white "PRECIO uno" from the official site logo, on Precio Uno red
    def preciouno():
        lg = load("preciouno/logo-hbpu.png")
        wm = key_out(lg, "#D31F2F", "#FFFFFF", 60, 200)
        b, _ = badge(wm, "#D31F2F", r_safe=0.44 * S, w_safe=0.80 * S)
        save(b, "preciouno.png")
        save(trim_alpha(lg), "preciouno-wide.png")
    jobs["preciouno"] = preciouno

    # ---- Makro: yellow "makro" wordmark (official SVG served by plazavea.com.pe) on makro.pe icon blue
    def makro():
        wm = load("hi/makro-wordmark-yellow.png")
        b, _ = badge(wm, "#26469D")
        save(b, "makro.png")
        save(wide(load("hi/makro-wordmark-blue.png")), "makro-wide.png")
    jobs["makro"] = makro

    for k, fn in jobs.items():
        if which and k not in which:
            continue
        fn()


if __name__ == "__main__":
    build(sys.argv[1:] or None)
