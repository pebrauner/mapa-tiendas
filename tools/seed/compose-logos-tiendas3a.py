"""Compose badge / wide logos for: tiendas3a, maxiahorro, dollarcity, vega, florayfauna, holi, tambo, oxxo.

Inputs : tools/seed/logo-src/<id>/...  (official artwork, see tools/seed/chains/<id>.json -> logoSources)
Outputs: logos/<id>.png       512x512 square badge (brand/white background, content kept circle-safe)
         logos/<id>-wide.png  horizontal logo, trimmed, max 512 px wide
         tools/seed/logos-contact-tiendas3a.png  contact sheet (badges clipped to a circle + 3 px ring
                                                  at 40 px and 128 px on a light-grey map-like background)

Run:  python tools/seed/compose-logos-tiendas3a.py [id ...]   (Python 3 + Pillow; no network), then
      node tools/build-logos.mjs; check with python tools/seed/logo-src/contact_final.py (tools/seed/logos-contact-final.png,
      which draws the badges exactly as the app does; the sheet written here is the older 40/128 px one).
Deterministic: same inputs -> same outputs.
2026-10-01 polish: content fitted to 86-90% of the square (js/markers.js draws the square into the badge's inner disc,
so that is ~70% of the badge diameter); Dollarcity re-stacked "Dollar" / "city" (one line was illegible at 32 px);
no holi-wide.png (Holi's logo is not a horizontal wordmark: cards use the square mark).
"""
import json
import math
import os
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'tools' / 'seed' / 'logo-src'
OUT = ROOT / 'logos'
CHAINS = ROOT / 'tools' / 'seed' / 'chains'
SHEET = ROOT / 'tools' / 'seed' / 'logos-contact-tiendas3a.png'
SIZE = 512
IDS = ['tiendas3a', 'maxiahorro', 'dollarcity', 'vega', 'florayfauna', 'holi', 'tambo', 'oxxo']


def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load(name):
    return Image.open(SRC / name).convert('RGBA')


def border_bg(im):
    """Median colour of the image border (used as background colour of JPEG avatars)."""
    rgb = im.convert('RGB')
    w, h = rgb.size
    px = [rgb.getpixel((x, 0)) for x in range(0, w, 5)] + [rgb.getpixel((x, h - 1)) for x in range(0, w, 5)]
    px += [rgb.getpixel((0, y)) for y in range(0, h, 5)] + [rgb.getpixel((w - 1, y)) for y in range(0, h, 5)]
    return tuple(sorted(p[i] for p in px)[len(px) // 2] for i in range(3))


def content_mask(im, bg=None, thr=48):
    """Binary mask of 'content' pixels: opaque and (if bg given) clearly different from bg."""
    a = im.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    if bg is None:
        return a
    diff = ImageChops.difference(im.convert('RGB'), Image.new('RGB', im.size, bg)).convert('L')
    diff = diff.point(lambda v: 255 if v > thr else 0)
    return ImageChops.multiply(a, diff)


def content_geometry(mask):
    """Centre of the content bbox and the max distance of any content pixel from that centre."""
    bb = mask.getbbox()
    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
    # sample on a grid (fast enough at these sizes)
    step = max(1, min(mask.size) // 400)
    px = mask.load()
    r = 0.0
    for y in range(bb[1], bb[3], step):
        for x in range(bb[0], bb[2], step):
            if px[x, y]:
                d = (x - cx) ** 2 + (y - cy) ** 2
                if d > r:
                    r = d
    return cx, cy, math.sqrt(r) + step


def fit_badge(src, bg_rgb, radius_frac, bg_key=None, thr=48):
    """Scale `src` so its content fits inside a centred circle of radius radius_frac*256 and paste it
    centred on a 512x512 square filled with bg_rgb.  bg_key: colour treated as background when measuring
    content (for opaque JPEG avatars)."""
    mask = content_mask(src, bg_key, thr)
    cx, cy, r = content_geometry(mask)
    s = radius_frac * (SIZE / 2) / r
    w, h = round(src.width * s), round(src.height * s)
    scaled = src.resize((w, h), Image.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE), bg_rgb + (255,))
    ox, oy = round(SIZE / 2 - cx * s), round(SIZE / 2 - cy * s)
    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    layer.paste(scaled, (ox, oy))  # plain copy, clipped to the canvas
    return Image.alpha_composite(canvas, layer), s


def trim(im, bg=None, thr=24, pad=0):
    mask = content_mask(im, bg, thr)
    bb = mask.getbbox()
    bb = (max(0, bb[0] - pad), max(0, bb[1] - pad), min(im.width, bb[2] + pad), min(im.height, bb[3] + pad))
    return im.crop(bb)


def max_width(im, w=512):
    """Limit to 512 px wide (and 512 px tall for non-horizontal logos such as Holi)."""
    f = min(1.0, w / im.width, w / im.height)
    if f >= 1.0:
        return im
    return im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)


def stack(parts, gap):
    """Stack images vertically, centred (gap in px)."""
    w = max(p.width for p in parts)
    h = sum(p.height for p in parts) + gap * (len(parts) - 1)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    y = 0
    for p in parts:
        out.alpha_composite(p, ((w - p.width) // 2, y))
        y += p.height + gap
    return out


def save(im, name):
    OUT.mkdir(exist_ok=True)
    im.save(OUT / name, optimize=True)
    return OUT / name


# ---------------------------------------------------------------------------------------------- badges
def build(only=None):
    made = {}
    want = lambda cid: not only or cid in only

    # Tiendas 3A: official favicon (orange square, blue "3A" with white outline) -> shrink to circle-safe.
    if want('tiendas3a'):
        fav = load('tiendas3a/tiendas3a-favicon.jpg')
        bg = border_bg(fav)
        badge, _ = fit_badge(fav, bg, 0.86, bg_key=bg)
        wide = max_width(trim(load('tiendas3a/01_Logo_3A_Nav.png')))
        made['tiendas3a'] = (save(badge, 'tiendas3a.png'), save(wide, 'tiendas3a-wide.png'))

    # Maxiahorro: official Facebook avatar (red square, white "maxi" + yellow "ahorro").
    if want('maxiahorro'):
        av = load('maxiahorro/facebook-avatar-MaxiahorroPE.jpg')
        bg = border_bg(av)
        badge, _ = fit_badge(av, bg, 0.90, bg_key=bg)
        # wide: the wordmark is white/yellow (made for red), so keep it on its red box with some padding
        m = content_mask(av, bg)
        bb = m.getbbox()
        pad = round((bb[3] - bb[1]) * 0.22)
        wide = max_width(av.crop((bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad)))
        made['maxiahorro'] = (save(badge, 'maxiahorro.png'), save(wide, 'maxiahorro-wide.png'))

    # Dollarcity: official wordmark (yellow with dark-green outline, extracted from LOGO_Dollarcity.svg)
    # on the brand green -> same look as the official Dollarcity Peru avatar.
    # Badge: re-stacked as "Dollar" over "city" (cut where no yellow letter pixel is, between "r" and "c"; the dark
    # outlines touch there): one line of 10 letters was ~3 px tall at 32 px.
    if want('dollarcity'):
        wm = trim(load('dollarcity/LOGO_Dollarcity-embedded.png'))
        px = wm.load()
        def yellow_px(x):
            return sum(1 for y in range(0, wm.height, 2) if px[x, y][3] > 128 and px[x, y][0] > 150 and px[x, y][1] > 150 and px[x, y][2] < 120)
        cut = min(range(round(wm.width * 0.57), round(wm.width * 0.62)), key=lambda x: (yellow_px(x), x))
        if yellow_px(cut):
            raise SystemExit('dollarcity: no gap between "Dollar" and "city"')
        two = stack([trim(wm.crop((0, 0, cut, wm.height))), trim(wm.crop((cut, 0, wm.width, wm.height)))], round(wm.height * 0.02))
        # measure only the yellow letters (the dark-green outline disappears into the green background)
        badge, _ = fit_badge(two, hex2rgb('#00552E'), 0.88, bg_key=hex2rgb('#00552E'))
        made['dollarcity'] = (save(badge, 'dollarcity.png'), save(max_width(wm), 'dollarcity-wide.png'))

    # Vega: official white logo (heart symbol + "vega") re-stacked as heart over wordmark (the stacked
    # lockup visible on the Vega logo in the user's Lima Cono Sur slide), on Vega red. No recolouring.
    if want('vega'):
        white = trim(load('vega/vega-logo-white.png'))
        a = white.getchannel('A')
        cols = [any(a.getpixel((x, y)) > 40 for y in range(0, white.height, 2)) for x in range(white.width)]
        # first empty column run after the heart = gap between symbol and wordmark
        x = 0
        while cols[x]:
            x += 1
        heart = trim(white.crop((0, 0, x, white.height)))
        word = trim(white.crop((x, 0, white.width, white.height)))
        word_w = round(heart.width * 2.1)
        word = word.resize((word_w, round(word.height * word_w / word.width)), Image.LANCZOS)
        gap = round(heart.height * 0.16)
        block = Image.new('RGBA', (max(heart.width, word.width), heart.height + gap + word.height), (0, 0, 0, 0))
        block.alpha_composite(heart, ((block.width - heart.width) // 2, 0))
        block.alpha_composite(word, ((block.width - word.width) // 2, heart.height + gap))
        badge, _ = fit_badge(block, hex2rgb('#C12A21'), 0.88)
        wide = max_width(trim(load('vega/vega-logo-red.png')))
        made['vega'] = (save(badge, 'vega.png'), save(wide, 'vega-wide.png'))

    # Flora & Fauna: official Facebook avatar ("F&F" monogram, cream on near-black).
    if want('florayfauna'):
        av = load('florayfauna/facebook-avatar-florayfauna.pe.jpg')
        bg = border_bg(av)
        badge, _ = fit_badge(av, bg, 0.86, bg_key=bg)
        wide = max_width(trim(load('florayfauna/florayfauna-logo-dark-render.png')))
        made['florayfauna'] = (save(badge, 'florayfauna.png'), save(wide, 'florayfauna-wide.png'))

    # Holi: official logo (green/orange "HoLi" with arcs) on white. No -wide file: the logo is not a horizontal
    # wordmark, so the card style shows this square mark (the stacked variant is logo-src/holi/holi-wide-stacked-unused.png).
    if want('holi'):
        logo = trim(load('holi/logo-holi.png'))
        badge, _ = fit_badge(logo, (255, 255, 255), 0.90)
        made['holi'] = (save(badge, 'holi.png'), None)

    # Tambo: official Facebook avatar (yellow "TAMBO+" on magenta).
    if want('tambo'):
        av = load('tambo/facebook-avatar-PractitiendasTambo.jpg')
        bg = border_bg(av)
        badge, _ = fit_badge(av, bg, 0.96, bg_key=bg)  # the circled + sets the far corner
        wide = max_width(trim(load('tambo/tambo-web-logo.png')))
        made['tambo'] = (save(badge, 'tambo.png'), save(wide, 'tambo-wide.png'))

    # Oxxo: Wikimedia Commons "Oxxo Logo.svg" rasterised with headless Chrome, on white.
    if want('oxxo'):
        logo = trim(load('oxxo/Oxxo_Logo-render.png'))
        badge, _ = fit_badge(logo, (255, 255, 255), 0.90)
        made['oxxo'] = (save(badge, 'oxxo.png'), save(max_width(logo), 'oxxo-wide.png'))
    return made


# ---------------------------------------------------------------------------------------- contact sheet
def circle_badge(badge, px, ring_px, ring_rgb, ss=4):
    """Render badge clipped to a circle of diameter px with a ring, anti-aliased by supersampling."""
    D = px * ss
    im = badge.resize((D, D), Image.LANCZOS)
    mask = Image.new('L', (D, D), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, D - 1, D - 1), fill=255)
    out = Image.new('RGBA', (D, D), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    d = ImageDraw.Draw(out)
    r = ring_px * ss
    d.ellipse((r / 2, r / 2, D - 1 - r / 2, D - 1 - r / 2), outline=ring_rgb + (255,), width=r)
    return out.resize((px, px), Image.LANCZOS)


def map_bg(w, h):
    """Light-grey, positron-like map background (deterministic)."""
    im = Image.new('RGBA', (w, h), (240, 241, 243, 255))
    d = ImageDraw.Draw(im)
    for i in range(0, w + h, 46):
        d.line((i, 0, i - h, h), fill=(255, 255, 255, 255), width=3)
    for j in range(0, h, 38):
        d.line((0, j, w, j + 12), fill=(255, 255, 255, 255), width=2)
    d.line((0, h * 0.55, w, h * 0.35), fill=(252, 214, 164, 255), width=6)  # arterial road
    d.rectangle((w * 0.62, h * 0.08, w * 0.74, h * 0.22), fill=(214, 236, 215, 255))  # park
    return im


def font(sz, bold=True):
    for f in (['C:/Windows/Fonts/calibrib.ttf', 'C:/Windows/Fonts/arialbd.ttf'] if bold else
              ['C:/Windows/Fonts/calibri.ttf', 'C:/Windows/Fonts/arial.ttf']):
        if os.path.exists(f):
            return ImageFont.truetype(f, sz)
    return ImageFont.load_default()


def contact_sheet(made):
    rows = []
    for cid in IDS:
        meta = json.loads((CHAINS / f'{cid}.json').read_text(encoding='utf-8')) if (CHAINS / f'{cid}.json').exists() else {}
        rows.append((cid, meta.get('legendName', cid.upper()), hex2rgb(meta.get('ringColor') or meta.get('color') or '#888888')))
    col_w, row_h = 470, 150
    cols = 2
    W = 24 + cols * col_w
    H = 70 + math.ceil(len(rows) / cols) * row_h + 150
    sheet = map_bg(W, H)
    d = ImageDraw.Draw(sheet)
    d.rectangle((0, 0, W, 52), fill=(255, 255, 255, 235))
    d.text((16, 10), 'mapa-tiendas · badges tiendas3a batch — 40 px and 128 px, 3 px brand ring; wide logos on white cards',
           fill=(30, 30, 30, 255), font=font(18))
    for i, (cid, legend, ring) in enumerate(rows):
        badge = Image.open(OUT / f'{cid}.png').convert('RGBA')
        x0 = 16 + (i % cols) * col_w
        y0 = 66 + (i // cols) * row_h
        d.text((x0, y0), f'{legend}  ({cid})', fill=(20, 20, 20, 255), font=font(16))
        b128 = circle_badge(badge, 128, 3, ring)
        sheet.alpha_composite(b128, (x0, y0 + 20))
        b40 = circle_badge(badge, 40, 3, ring)
        # 40 px badge with a short stem + dot, like on the map
        bx, by = x0 + 150, y0 + 40
        d.line((bx + 20, by + 40, bx + 20, by + 52), fill=(60, 60, 60, 255), width=2)
        d.ellipse((bx + 16, by + 50, bx + 24, by + 58), fill=ring + (255,), outline=(255, 255, 255, 255), width=2)
        sheet.alpha_composite(b40, (bx, by))
        # a second 40 px copy next to the 3A badge to judge differentiation in a cluster
        wide_p = OUT / f'{cid}-wide.png'
        if wide_p.exists():
            wide = Image.open(wide_p).convert('RGBA')
            wh = 44
            ww = round(wide.width * wh / wide.height)
            if ww > 250:
                ww = 250
                wh = round(wide.height * ww / wide.width)
            wide = wide.resize((ww, wh), Image.LANCZOS)
            cx, cy = x0 + 205, y0 + 40
            d.rounded_rectangle((cx - 6, cy - 6, cx + ww + 6, cy + wh + 6), radius=8, fill=(255, 255, 255, 255),
                                outline=(210, 210, 210, 255))
            sheet.alpha_composite(wide, (cx, cy))
    # cluster test: all eight 40 px badges side by side, like a crowded map
    y = H - 140
    d.text((16, y), 'cluster @ 40 px:', fill=(20, 20, 20, 255), font=font(16))
    for i, (cid, legend, ring) in enumerate(rows):
        b = circle_badge(Image.open(OUT / f'{cid}.png').convert('RGBA'), 40, 3, ring)
        sheet.alpha_composite(b, (16 + i * 46, y + 26))
    d.text((16, y + 80), 'cluster @ 32 px:', fill=(20, 20, 20, 255), font=font(16))
    for i, (cid, legend, ring) in enumerate(rows):
        b = circle_badge(Image.open(OUT / f'{cid}.png').convert('RGBA'), 32, 3, ring)
        sheet.alpha_composite(b, (16 + i * 38, y + 104))
    sheet.convert('RGB').save(SHEET, optimize=True)
    return SHEET


if __name__ == '__main__':
    import sys
    only = [a for a in sys.argv[1:] if a in IDS]
    made = build(only)
    for k, v in made.items():
        b = Image.open(v[0])
        wd = Image.open(v[1]).size if v[1] else '-'
        print(f'{k:12s} badge {b.size} wide {wd}')
    if not only:
        print('contact sheet:', contact_sheet(made))
