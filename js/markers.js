/* js/markers.js — MT.markers: how a store marker looks, drawn on a 2D canvas. Module M1.
 *
 * ONE drawing routine serves the live preview (MT.mapview paints its overlay canvas with it), the
 * PNG/slide exports (MT.render) and the PPTX pictures (MT.markers.image), so they always match.
 * Everything is in reference units (frame width = 1000) × a pixel scale. Looks come from
 * MT.theme.marker:
 *   badge  — uniform white disc, 3.5-unit ring in the chain colour (ringColor if set), logo inside,
 *            soft shadow; small anchor dot with white stroke at the exact location; a short stem /
 *            thin grey leader from the dot to the badge edge.
 *   card   — natural-aspect wide logo on a rounded white card (chain-colour hairline border); a
 *            chain without a wide logo gets a square card of the same height with its badge mark
 *            inside.
 *   dot    — brand-colour dot right on the location (logos only in the legend).
 *   number — numbered pin in the chain colour (numbers from MT.layout, store table in PPTX).
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.1):
 *   style = {kind, size} (MT.layout.styleOf(mapCfg) builds it from markerStyle / markerSize)
 *   ready(chainIds, style) → Promise          decode the logos the synchronous calls will draw
 *   draw(ctx, item, style, scale, opts?)      leader/stem + anchor dot + marker of ONE layout item
 *   element(item, style, opts?) → HTMLElement absolutely positioned (reference units) canvas marker
 *   icon(chainId, px, style) → canvas         legend icon = the marker as on the map (px tall; a
 *                                             card icon is wider than tall, a dot is a brand dot)
 * Extras: drawAll(ctx, items, style, scale, opts) (layered: group spokes → leader halos → leaders →
 *   store dots (the ones a leader starts at last: dotOrder) → markers (top to bottom, the hovered
 *   one last) → collapsed logos), dotOf(item) (where its dot is drawn), drawMarker(ctx, chainId, x, y,
 *   style, opts) (opts.count > 1 adds the count pip of a same-chain group: "×4" in a pill of the ring
 *   colour at the top-right), dims(chainId, style), image(item, style, scale) → {canvas, x, y, w, h}
 *   (marker picture incl. shadow margin and count pip, for PPTX), pipGeometry(chainId, w, h, style,
 *   count), isMarker(item), ringColor(id), anchorRadius(style), shadowMargin(style).
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;
  const TM = () => MT.theme.marker;
  const TAU = Math.PI * 2;

  /* ---- Logos: sources, aspect, decoded images ----------------------------------------------- */
  const infoCache = {};
  const decoded = {};   // data URI → HTMLImageElement (decoded)
  MT.bus.on('logos:changed', () => { for (const k in infoCache) delete infoCache[k]; });
  MT.bus.on('chains:changed', () => { for (const k in infoCache) delete infoCache[k]; });
  // Warm the logo info after boot, in idle time: a chain without a logo gets a generated badge
  // (a canvas encode that can take a few hundred ms the first time) — keep that off the first layout.
  MT.bus.on('app:ready', () => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    const ids = (MT.data.chains() || []).map((c) => c.id);
    const step = () => { const t0 = performance.now(); while (ids.length && performance.now() - t0 < 30) logoInfo(ids.shift()); if (ids.length) idle(step); };
    idle(step);
  });

  /** Width/height from a PNG data URI header (synchronous → deterministic layout). */
  function pngSize(uri) {
    try {
      const comma = uri.indexOf(',');
      if (comma < 0 || uri.slice(0, comma).indexOf('image/png') < 0) return null;
      const bin = atob(uri.slice(comma + 1, comma + 1 + 44));
      if (bin.charCodeAt(1) !== 0x50 || bin.charCodeAt(2) !== 0x4E) return null; // "PN"
      const at = (i) => ((bin.charCodeAt(i) << 24) | (bin.charCodeAt(i + 1) << 16) | (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3)) >>> 0;
      const w = at(16), h = at(20);
      return w > 0 && h > 0 ? { w: w, h: h } : null;
    } catch (e) { return null; }
  }

  function logoInfo(chainId) {
    if (infoCache[chainId]) return infoCache[chainId];
    const l = MT.logos.get(chainId);
    let aspect = null;
    if (l.wide) {
      const s = pngSize(l.wide) || (decoded[l.wide] ? { w: decoded[l.wide].naturalWidth, h: decoded[l.wide].naturalHeight } : null);
      aspect = s ? s.w / s.h : 3;
    }
    return (infoCache[chainId] = { badge: l.badge, wide: l.wide || null, generated: !!l.generated, wideAspect: aspect });
  }

  function decode(src) {
    if (!src) return Promise.resolve(null);
    if (decoded[src]) return Promise.resolve(decoded[src]);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const done = () => { decoded[src] = img; resolve(img); };
        if (img.decode) img.decode().then(done, done); else done();
      };
      img.onerror = () => resolve(null);      // a broken logo must not break the map
      img.src = src;
    });
  }

  /** Decode the logos needed to draw these chains in this style (and their legend icons). */
  function ready(chainIds, style) {
    const st = MT.layout.styleOf(style);
    const jobs = [];
    U.sortBy(Array.from(new Set(chainIds || [])), (x) => x).forEach((id) => {
      const li = logoInfo(id);
      jobs.push(decode(li.badge));
      if (st.kind === 'card' && li.wide) jobs.push(decode(li.wide));
    });
    return Promise.all(jobs).then(() => undefined);
  }

  /* ---- Colours ------------------------------------------------------------------------------------ */
  function rawChain(id) {
    const list = Array.isArray(window.MT_CHAINS) ? window.MT_CHAINS : [];
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  /**
   * Ring/brand colour of a chain (ringColor when defined, never invisible on white).
   * MT.data.normalizeChain keeps ringColor ('' = same as the brand colour); a chain edited in an
   * older version of the app has no ringColor key at all → fall back to the shipped MT_CHAINS entry.
   */
  function ringColor(chainId) {
    const c = MT.data.chain(chainId);
    const raw = c.ringColor === undefined ? rawChain(chainId) : null;
    const rc = U.isHexColor(c.ringColor) ? c.ringColor : (raw && U.isHexColor(raw.ringColor) ? raw.ringColor : c.color);
    return U.luminance(rc) > 0.82 ? '#9CA3AF' : rc;
  }
  function chainColor(chainId) {
    const c = MT.data.chain(chainId).color;
    return U.luminance(c) > 0.82 ? '#9CA3AF' : c;
  }

  /*
   * Colours for the dot and number styles (and their legend icons): with logos gone, colour is the
   * only clue, and many brands share one (Plaza Vea, Wong, Vega, Precio Uno... are all red).
   * Every chain starts from its ring colour (Mass: blue ring, not its yellow), in the chains'
   * own order (supermarkets first); a chain whose colour is too close (CIEDE2000 < 20) to one
   * already kept gets the first free colour of a fixed categorical palette instead. The assignment
   * covers ALL chains, so a chain has the same colour on every slide of every deck.
   */
  const PALETTE = ['#1F77B4', '#FF7F0E', '#2CA02C', '#9467BD', '#8C564B', '#E377C2', '#17BECF', '#BCBD22', '#393B79',
    '#F0027F', '#66A61E', '#E6AB02', '#A6761D', '#1B9E77', '#D95F02', '#7570B3', '#00429D', '#73A2C6', '#F4777F', '#93003A'];
  const MIN_DE = 20;
  let markerColors = null;
  MT.bus.on('chains:changed', () => { markerColors = null; });
  MT.bus.on('data:ready', () => { markerColors = null; });
  function markerColor(chainId) {
    if (!markerColors) markerColors = assignColors();
    return markerColors[chainId] || ringColor(chainId);
  }
  function assignColors() {
    const out = {}, kept = [], later = [];
    (MT.data.chains() || []).forEach((c) => {
      const base = ringColor(c.id);
      if (kept.every((k) => deltaE(k, base) >= MIN_DE)) { out[c.id] = base; kept.push(base); } else later.push(c.id);
    });
    later.forEach((id) => {
      let best = null, bestD = -1;
      for (const p of PALETTE) {
        if (kept.indexOf(p) >= 0) continue;
        const d = Math.min.apply(null, kept.map((k) => deltaE(k, p)));
        if (d >= MIN_DE) { best = p; break; }
        if (d > bestD) { bestD = d; best = p; }
      }
      out[id] = best || ringColor(id);
      kept.push(out[id]);
    });
    return out;
  }
  function hexToLab(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  /** CIEDE2000 colour difference of two #rrggbb colours (~2 = barely visible, 20+ = clearly different). */
  function deltaE(h1, h2) {
    const p = hexToLab(h1), q = hexToLab(h2), rad = Math.PI / 180;
    const C1 = Math.hypot(p[1], p[2]), C2 = Math.hypot(q[1], q[2]), Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    const a1 = (1 + G) * p[1], a2 = (1 + G) * q[1], c1 = Math.hypot(a1, p[2]), c2 = Math.hypot(a2, q[2]);
    const hue = (a, b) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1p = hue(a1, p[2]), h2p = hue(a2, q[2]);
    let dh = 0;
    if (c1 * c2) { dh = h2p - h1p; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
    const dL = q[0] - p[0], dC = c2 - c1, dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh * rad / 2);
    const Lb = (p[0] + q[0]) / 2, Cbp = (c1 + c2) / 2;
    let hb = h1p + h2p;
    if (c1 * c2) hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
    const dTh = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
    const Sl = 1 + 0.015 * Math.pow(Lb - 50, 2) / Math.sqrt(20 + Math.pow(Lb - 50, 2)), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTh * rad) * Rc;
    return Math.sqrt(Math.pow(dL / Sl, 2) + Math.pow(dC / Sc, 2) + Math.pow(dH / Sh, 2) + Rt * (dC / Sc) * (dH / Sh));
  }
  /** Colour of a store's dot (anchor or collapsed marker) in a style. */
  function dotColor(chainId, st) { return st.kind === 'dot' || st.kind === 'number' ? markerColor(chainId) : chainColor(chainId); }
  function badgeZoom(chainId) {
    const c = MT.data.chain(chainId);
    let z = +c.badgeZoom;
    if (!(z > 0)) { const raw = rawChain(chainId); z = raw && +raw.badgeZoom > 0 ? +raw.badgeZoom : 1; }
    return U.clamp(z, 0.5, 2.5);
  }
  /** #rrggbb darkened by f (0..1) — readable strokes for light brand colours. */
  function darken(hex, f) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - f)));
    return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /* ---- Dimensions --------------------------------------------------------------------------------- */
  let mctx = null;
  function measure(text, font) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = font;
    return mctx.measureText(text).width;
  }
  function cardFont(px) { return '700 ' + px + 'px ' + MT.theme.fonts.ui; }

  /** Marker box {w, h} in reference units for a chain in a style. */
  function dims(chainId, style) {
    const st = MT.layout.styleOf(style);
    const base = MT.theme.markerDims(st.kind, st.size);
    if (st.kind !== 'card') return { w: base.w, h: base.h };
    const c = TM().card, k = base.k;
    const h = c.height * k, p = c.padding * k, inner = h - 2 * p;
    const li = logoInfo(chainId);
    let w;
    if (li.wideAspect) w = inner * li.wideAspect + 2 * p;
    else if (!li.generated) w = h;                                       // square badge card
    else w = measure(MT.data.chain(chainId).name, cardFont(inner * 0.78)) + 2 * p + 2 * k;  // wordmark fallback
    return { w: U.clamp(w, h, c.maxWidth * k), h: h };
  }
  function anchorRadius(style) {
    const st = MT.layout.styleOf(style);
    return MT.theme.marker.anchorDot.radius * Math.sqrt(st.size);
  }
  /** Extra room a marker picture needs around its box for the shadow (reference units). */
  function shadowMargin(style) {
    const st = MT.layout.styleOf(style);
    const sh = st.kind === 'card' ? TM().card.shadow : TM().badge.shadow;
    return Math.ceil((sh.blur + Math.abs(sh.offsetY)) * st.size + 2);
  }

  /* ---- Primitive drawing (ctx is in reference units; dev = device px per unit, for shadows) ----- */
  function devScale(ctx) {
    const t = ctx.getTransform();
    return Math.hypot(t.a, t.b) || 1;
  }
  function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }
  function setShadow(ctx, sh, k, on) {
    if (!on || !sh) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; return; }
    const d = devScale(ctx);
    ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur * k * d; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = sh.offsetY * k * d;
  }

  function drawBadge(ctx, chainId, x, y, D, opt) {
    const b = TM().badge, k = D / b.diameter, r = D / 2;
    const ring = b.ring * k;
    ctx.save();
    setShadow(ctx, b.shadow, k, opt.shadow !== false);
    circle(ctx, x, y, r); ctx.fillStyle = ringColor(chainId); ctx.fill();
    ctx.restore();
    circle(ctx, x, y, r - ring); ctx.fillStyle = b.background; ctx.fill();
    // Logo clipped to the inner disc, leaving a hairline of white between ring and logo.
    const inset = (b.logoInset || 0) * k + Math.max(0.6, ring * 0.26);
    const lr = r - ring - inset;
    const img = decoded[logoInfo(chainId).badge];
    if (img) {
      // chain.badgeZoom (data/chains.js) enlarges a logo whose mark is small inside its square.
      const z = badgeZoom(chainId), lz = lr * z;
      ctx.save();
      circle(ctx, x, y, lr); ctx.clip();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x - lz, y - lz, lz * 2, lz * 2);
      ctx.restore();
    } else {
      circle(ctx, x, y, lr); ctx.fillStyle = chainColor(chainId); ctx.fill();
    }
  }

  function drawCard(ctx, chainId, x, y, w, h, opt) {
    const c = TM().card, k = h / c.height, p = c.padding * k;
    const x0 = x - w / 2, y0 = y - h / 2, rad = c.radius * k;
    ctx.save();
    setShadow(ctx, c.shadow, k, opt.shadow !== false);
    roundRect(ctx, x0, y0, w, h, rad); ctx.fillStyle = c.background; ctx.fill();
    ctx.restore();
    const li = logoInfo(chainId);
    const color = ringColor(chainId);
    if (li.wide && decoded[li.wide]) {
      const img = decoded[li.wide];
      const bw = w - 2 * p, bh = h - 2 * p;
      const s = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
    } else if (!li.generated && decoded[li.badge]) {
      // No wordmark: the square badge mark sits INSIDE a white card exactly as tall as every other
      // card (dims(): w = h), inset like a wordmark and rounded like an app icon — so a slide or a
      // legend that mixes wordmarks and square marks shows one even row of white cards instead of
      // bare colour tiles. chain.badgeZoom enlarges a small mark as it does in the badge.
      const inset = Math.max(p * 0.6, (c.borderWidth + 1) * k);
      const s = Math.min(w, h) - 2 * inset;
      const z = badgeZoom(chainId), sz = s * z;
      ctx.save();
      roundRect(ctx, x - s / 2, y - s / 2, s, s, Math.max(0, rad - inset / 2));
      ctx.clip();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded[li.badge], x - sz / 2, y - sz / 2, sz, sz);
      ctx.restore();
    } else {
      // Wordmark fallback: the chain name in its colour.
      const inner = h - 2 * p;
      let fs = inner * 0.78;
      const name = MT.data.chain(chainId).name;
      ctx.font = cardFont(fs);
      const maxW = w - 2 * p;
      const tw = ctx.measureText(name).width;
      if (tw > maxW) { fs *= maxW / tw; ctx.font = cardFont(fs); }
      ctx.fillStyle = U.luminance(color) > 0.6 ? darken(color, 0.35) : color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, x, y + fs * 0.04);
    }
    // Hairline border in the chain colour ties the card to the legend.
    roundRect(ctx, x0 + c.borderWidth * k / 2, y0 + c.borderWidth * k / 2, w - c.borderWidth * k, h - c.borderWidth * k, Math.max(0, rad - c.borderWidth * k / 2));
    ctx.lineWidth = c.borderWidth * k; ctx.strokeStyle = color; ctx.stroke();
  }

  function drawDot(ctx, chainId, x, y, D, opt) {
    const d = TM().dot, k = D / (2 * d.radius), r = D / 2;
    ctx.save();
    setShadow(ctx, { color: 'rgba(17,24,39,0.25)', blur: 2.5, offsetY: 0.6 }, k, opt.shadow !== false);
    circle(ctx, x, y, r); ctx.fillStyle = opt.color || markerColor(chainId); ctx.fill();
    ctx.restore();
    circle(ctx, x, y, r - d.strokeWidth * k / 2); ctx.lineWidth = d.strokeWidth * k; ctx.strokeStyle = d.stroke; ctx.stroke();
  }

  function drawNumber(ctx, chainId, x, y, D, num, opt) {
    const nb = TM().number, k = D / nb.diameter, r = D / 2;
    const color = markerColor(chainId);
    ctx.save();
    setShadow(ctx, TM().badge.shadow, k, opt.shadow !== false);
    circle(ctx, x, y, r); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
    circle(ctx, x, y, r - nb.strokeWidth * k / 2); ctx.lineWidth = nb.strokeWidth * k; ctx.strokeStyle = nb.stroke; ctx.stroke();
    if (num === undefined || num === null || num === '') return;
    const text = String(num);
    let fs = nb.fontSize * k * (text.length >= 3 ? 0.78 : 1);
    ctx.font = '700 ' + fs + 'px ' + MT.theme.fonts.ui;
    const maxW = D - 2 * nb.strokeWidth * k - 2 * k;
    const tw = ctx.measureText(text).width;
    if (tw > maxW) { fs *= maxW / tw; ctx.font = '700 ' + fs + 'px ' + MT.theme.fonts.ui; }
    ctx.fillStyle = U.luminance(color) > 0.55 ? '#111827' : nb.color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + fs * 0.05);
  }

  /**
   * Count pip of a grouped logo ("×4"): geometry relative to the marker centre, reference units.
   * Badge: centred on the 45° line at theme countPip.at × radius; card: on the top-right corner,
   * pulled in so it never sticks out of the marker picture's shadow margin (PPTX / HTML pictures).
   * → {dx, dy, w, h, fs, text, fill, color, stroke, sw}
   */
  function pipGeometry(chainId, w, h, style, count) {
    const st = MT.layout.styleOf(style);
    const cp = TM().countPip || { diameter: 19, fontSize: 11.5, prefix: '×', stroke: '#FFFFFF', strokeWidth: 1.6, at: 0.68 };
    const k = st.kind === 'card' ? h / TM().card.height : w / TM().badge.diameter;
    const text = (cp.prefix || '') + count;
    const fs = cp.fontSize * k, ph = cp.diameter * k;
    const pw = Math.max(ph, measure(text, pipFont(fs)) + ph * 0.55);
    const room = shadowMargin(st) - 1;                     // how far it may stick out of the box
    let dx, dy;
    if (st.kind === 'card') { dx = w / 2 - pw / 2 + Math.min(room, pw * 0.3); dy = -h / 2 - ph / 2 + Math.max(ph / 2 - room, ph * 0.35); }
    else {
      const r = w / 2, a = (cp.at || 0.68) * r * Math.SQRT1_2;
      dx = Math.min(a, r + room - pw / 2); dy = -Math.min(a, r + room - ph / 2);
    }
    const fill = ringColor(chainId);
    return { dx: dx, dy: dy, w: pw, h: ph, fs: fs, text: text, fill: fill, color: U.luminance(fill) > 0.55 ? '#111827' : '#FFFFFF', stroke: cp.stroke || '#FFFFFF', sw: (cp.strokeWidth || 1.6) * k };
  }
  function pipFont(fs) { return '700 ' + fs + 'px ' + MT.theme.fonts.slideCss; }
  function drawPip(ctx, chainId, x, y, w, h, st, count) {
    const g = pipGeometry(chainId, w, h, st, count);
    const cx = x + g.dx, cy = y + g.dy;
    ctx.save();
    setShadow(ctx, { color: 'rgba(17,24,39,0.3)', blur: 2, offsetY: 0.5 }, g.h / 19, true);
    roundRect(ctx, cx - g.w / 2, cy - g.h / 2, g.w, g.h, g.h / 2); ctx.fillStyle = g.fill; ctx.fill();
    ctx.restore();
    roundRect(ctx, cx - g.w / 2 + g.sw / 2, cy - g.h / 2 + g.sw / 2, g.w - g.sw, g.h - g.sw, (g.h - g.sw) / 2);
    ctx.lineWidth = g.sw; ctx.strokeStyle = g.stroke; ctx.stroke();
    ctx.font = pipFont(g.fs); ctx.fillStyle = g.color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(g.text, cx, cy + g.fs * 0.04);
  }

  /**
   * Draw only the marker body centred at (x, y) reference units on a ctx already scaled to
   * reference units. opts: {w, h, number, count, shadow} — count > 1: a grouped logo's count pip.
   */
  function drawMarker(ctx, chainId, x, y, style, opts) {
    const st = MT.layout.styleOf(style);
    opts = opts || {};
    const d = opts.w ? { w: opts.w, h: opts.h || opts.w } : dims(chainId, st);
    if (st.kind === 'card') drawCard(ctx, chainId, x, y, d.w, d.h, opts);
    else if (st.kind === 'dot') drawDot(ctx, chainId, x, y, d.w, opts);
    else if (st.kind === 'number') drawNumber(ctx, chainId, x, y, d.w, opts.number, opts);
    else drawBadge(ctx, chainId, x, y, d.w, opts);
    if (opts.count > 1 && (st.kind === 'badge' || st.kind === 'card')) drawPip(ctx, chainId, x, y, d.w, d.h, st, opts.count);
  }

  /** Leader line (halo: its white casing, drawn first under every leader). */
  function drawLeader(ctx, item, halo) {
    const L = item.leader;
    if (!L) return;
    const ld = TM().leader, hl = ld.halo;
    if (halo && !(hl && hl.width > 0)) return;
    ctx.save();
    ctx.globalAlpha = halo ? (hl.alpha === undefined ? 1 : hl.alpha) : ld.alpha;
    ctx.strokeStyle = halo ? hl.color : ld.color;
    ctx.lineWidth = halo ? hl.width : ld.width;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(L.x1, L.y1); ctx.lineTo(L.x2, L.y2); ctx.stroke();
    ctx.restore();
  }
  /**
   * Spokes of a grouped logo (item.spokes, MT.layout): faint lines in the chain's ring colour from
   * each of its stores' dots to the logo, under everything else.
   */
  function drawSpokes(ctx, item) {
    if (!item.spokes || !item.spokes.length) return;
    const sp = TM().spoke || { width: 0.75, alpha: 0.5 };
    if (!(sp.width > 0)) return;
    ctx.save();
    ctx.globalAlpha = sp.alpha === undefined ? 0.5 : sp.alpha;
    ctx.strokeStyle = ringColor(item.chainId);
    ctx.lineWidth = sp.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    item.spokes.forEach((s) => { ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); });
    ctx.stroke();
    ctx.restore();
  }
  /** Where a store's dot is drawn: its own spot, spread a little from a neighbour's (MT.layout). */
  function dotOf(item) { return item.dot || item.anchor; }
  function drawAnchor(ctx, item, st) {
    const a = TM().anchorDot, r = anchorRadius(st);
    const k = Math.sqrt(st.size), d = dotOf(item);
    circle(ctx, d.x, d.y, r);
    ctx.fillStyle = dotColor(item.chainId, st); ctx.fill();
    ctx.lineWidth = a.strokeWidth * k; ctx.strokeStyle = a.stroke; ctx.stroke();
  }
  /**
   * Paint order of the store dots: the dots a leader starts at come last, so a leader always ends
   * on a dot of its own chain (a neighbour's dot never covers it).
   */
  function dotOrder(items) {
    const starts = new Set();
    items.forEach((it) => { if (it.leader) starts.add(it.leaderFrom || it.storeId); });
    const a = [], b = [];
    items.forEach((it) => { (starts.has(it.storeId) ? b : a).push(it); });
    return a.concat(b);
  }
  /**
   * A badge/card that found no room near its store (MT.layout: item.collapsed): a dot in the
   * badge's RING colour on the location, so it still reads as that chain (Mass → blue).
   */
  function drawCollapsed(ctx, item, st) {
    const c = MT.theme.marker.collapsed || { radius: 6, stroke: '#FFFFFF', strokeWidth: 1.75 };
    const r = item.w / 2, k = Math.sqrt(st.size);
    ctx.save();
    setShadow(ctx, { color: 'rgba(17,24,39,0.3)', blur: 2.5, offsetY: 0.6 }, k, true);
    circle(ctx, item.pos.x, item.pos.y, r); ctx.fillStyle = ringColor(item.chainId); ctx.fill();
    ctx.restore();
    circle(ctx, item.pos.x, item.pos.y, r - c.strokeWidth * k / 2);
    ctx.lineWidth = c.strokeWidth * k; ctx.strokeStyle = c.stroke; ctx.stroke();
  }
  function needsAnchor(item, st) { return !item.collapsed && (st.kind !== 'dot' || item.displaced); }

  /**
   * Paint order of markers: top to bottom (lower ones overlap upper ones). Dots (the dot style and
   * collapsed logos) go by chain instead — the chains with the most dots first, so a chain with
   * one or two stores is drawn last and never disappears under a big chain's dots.
   */
  function paintOrder(items, style) {
    const st = MT.layout.styleOf(style);
    const count = {};
    items.forEach((it) => { count[it.chainId] = (count[it.chainId] || 0) + 1; });
    const byId = (a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0);
    if (st.kind === 'dot') return items.slice().sort((a, b) => count[b.chainId] - count[a.chainId] || (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0) || a.pos.y - b.pos.y || byId(a, b));
    return items.slice().sort((a, b) => a.pos.y - b.pos.y || byId(a, b));
  }

  function withScale(ctx, scale, opts, fn) {
    ctx.save();
    if (opts && (opts.offsetX || opts.offsetY)) ctx.translate(opts.offsetX || 0, opts.offsetY || 0);
    ctx.scale(scale, scale);
    try { fn(); } finally { ctx.restore(); }
  }

  /** Is this item drawn as a marker (not a store dot only: collapsed logo, grouped store)? */
  function isMarker(item) { return !item.collapsed && !item.grouped; }

  /** One item: leader/stem (with its halo), marker, anchor dot. Coordinates = reference units × scale. */
  function draw(ctx, item, style, scale, opts) {
    const st = MT.layout.styleOf(style);
    const parts = (opts && opts.parts) || ['leader', 'dot', 'marker'];
    withScale(ctx, scale, opts, () => {
      if (parts.indexOf('leader') >= 0) { drawSpokes(ctx, item); drawLeader(ctx, item, true); drawLeader(ctx, item, false); }
      if (item.collapsed) { if (parts.indexOf('marker') >= 0 || parts.indexOf('dot') >= 0) drawCollapsed(ctx, item, st); return; }
      if (parts.indexOf('dot') >= 0 && needsAnchor(item, st)) drawAnchor(ctx, item, st);
      if (parts.indexOf('marker') >= 0 && !item.grouped) drawMarker(ctx, item.chainId, item.pos.x, item.pos.y, st, { w: item.w, h: item.h, number: item.number, count: item.count, shadow: !(opts && opts.shadow === false) });
    });
  }

  /**
   * All items in layers: group spokes → leader halos → leaders → store dots (the ones a leader
   * starts at last) → markers (top-to-bottom so lower ones overlap upper ones; opts.highlight =
   * storeId drawn last and slightly lifted) → collapsed logos.
   * Store dots go UNDER the markers: the declutter keeps markers off them, and where a very dense
   * spot forces a cover anyway, a dot on another chain's logo would read as part of that logo.
   */
  function drawAll(ctx, items, style, scale, opts) {
    const st = MT.layout.styleOf(style);
    opts = opts || {};
    withScale(ctx, scale, opts, () => {
      for (let i = 0; i < items.length; i++) drawSpokes(ctx, items[i]);
      for (let i = 0; i < items.length; i++) drawLeader(ctx, items[i], true);
      for (let i = 0; i < items.length; i++) drawLeader(ctx, items[i], false);
      dotOrder(items).forEach((it) => { if (needsAnchor(it, st)) drawAnchor(ctx, it, st); });
      const order = paintOrder(items.filter(isMarker), st);
      let hi = null;
      for (let i = 0; i < order.length; i++) {
        const it = order[i];
        if (opts.highlight && it.storeId === opts.highlight) { hi = it; continue; }
        drawMarker(ctx, it.chainId, it.pos.x, it.pos.y, st, { w: it.w, h: it.h, number: it.number, count: it.count });
      }
      if (hi) {
        const f = 1.08;
        drawMarker(ctx, hi.chainId, hi.pos.x, hi.pos.y, st, { w: hi.w * f, h: hi.h * f, number: hi.number, count: hi.count });
      }
      // Collapsed logos are dots in the ring colour (big chains first, so rare ones stay on top).
      paintOrder(items.filter((it) => it.collapsed), { kind: 'dot', size: st.size }).forEach((it) => drawCollapsed(ctx, it, st));
    });
  }

  /** The marker body as its own picture (PPTX): {canvas, x, y, w, h} — box in reference units incl. shadow margin (and count pip). */
  function image(item, style, scale) {
    const st = MT.layout.styleOf(style);
    const m = shadowMargin(st);
    const w = item.w + 2 * m, h = item.h + 2 * m;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale)); cv.height = Math.max(1, Math.round(h * scale));
    const ctx = cv.getContext('2d');
    ctx.scale(cv.width / w, cv.height / h);
    drawMarker(ctx, item.chainId, w / 2, h / 2, st, { w: item.w, h: item.h, number: item.number, count: item.count });
    return { canvas: cv, x: item.pos.x - w / 2, y: item.pos.y - h / 2, w: w, h: h };
  }

  /** Stand-alone preview element (absolutely positioned in reference units, CSS px). */
  function element(item, style, opts) {
    const st = MT.layout.styleOf(style);
    const ppu = (opts && opts.pxPerUnit) || 2 * (window.devicePixelRatio || 1);
    const pic = image(item, st, ppu);
    pic.canvas.style.width = pic.w + 'px';
    pic.canvas.style.height = pic.h + 'px';
    return U.h('div', {
      class: 'mt-marker mt-marker--' + st.kind,
      style: { position: 'absolute', left: pic.x + 'px', top: pic.y + 'px', width: pic.w + 'px', height: pic.h + 'px' },
      dataset: { storeId: item.storeId, chainId: item.chainId },
    }, pic.canvas);
  }

  /**
   * Legend icon: the marker as on the map, `px` device pixels tall (a card icon is wider; check
   * canvas.width). dot → brand dot, number → chain pin without a number.
   */
  function icon(chainId, px, style) {
    const st = MT.layout.styleOf(style);
    px = Math.max(8, Math.round(px || 24));
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    if (st.kind === 'card') {
      const d = dims(chainId, { kind: 'card', size: 1 });
      const s = px / (d.h + 2);
      cv.width = Math.round((d.w + 2) * s); cv.height = px;
      ctx.scale(s, s);
      drawCard(ctx, chainId, (d.w + 2) / 2, (d.h + 2) / 2, d.w, d.h, { shadow: false });
      return cv;
    }
    cv.width = cv.height = px;
    const unit = 100;                     // draw in a 100-unit box
    ctx.scale(px / unit, px / unit);
    if (st.kind === 'dot') drawDot(ctx, chainId, 50, 50, 70, { shadow: false });
    else if (st.kind === 'number') drawNumber(ctx, chainId, 50, 50, 92, null, { shadow: false });
    else drawBadge(ctx, chainId, 50, 50, 96, { shadow: false });
    return cv;
  }

  MT.markers = {
    ready: ready,
    draw: draw,
    drawAll: drawAll,
    drawMarker: drawMarker,
    element: element,
    icon: icon,
    image: image,
    dims: dims,
    ringColor: ringColor,
    chainColor: chainColor,
    markerColor: markerColor,
    dotColor: function (chainId, style) { return dotColor(chainId, MT.layout.styleOf(style)); },
    deltaE: deltaE,
    paintOrder: paintOrder,
    dotOrder: dotOrder,
    dotOf: dotOf,
    darken: darken,
    anchorRadius: anchorRadius,
    shadowMargin: shadowMargin,
    pipGeometry: pipGeometry,
    isMarker: isMarker,
    pngSize: pngSize,
    /** True when the logos for these chains are decoded (sync drawing will show them). */
    isReady: function (chainIds, style) {
      const st = MT.layout.styleOf(style);
      return (chainIds || []).every((id) => {
        const li = logoInfo(id);
        return decoded[li.badge] && (st.kind !== 'card' || !li.wide || decoded[li.wide]);
      });
    },
  };
})();
