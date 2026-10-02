/* js/export-pptx.js — MT.export.pptx: editable PowerPoint, one 16:9 slide per map. Module M4.
 *
 * Everything sits exactly where the live preview shows it: positions come from the same
 * MT.layout result (reference units → inches with MT.theme.ref2in, offset by MT.theme.mapFrame)
 * and the same MT.slide.layout text geometry (slide px → inches, px → pt).
 *
 * Per map (z-order bottom → top), every piece a separate, named PowerPoint object:
 *   left-area rectangle · title (real text) · subtitle runs "(districts)  Peso: 15.8%" (value bold,
 *   underlined, navy) · basemap picture (MT.render.mapCanvas with markers:false — district borders
 *   are baked in) · radius circles as ellipses (brand fill at low opacity + dashed outline) with a
 *   "1 km" pill — a circle that does not fit inside the frame is baked into the basemap instead
 *   (an ellipse would spill over the slide) · leader halos + leader lines (connectors glued to the
 *   store dot and the marker) · store dots (small ellipses, white outline) · EVERY marker as its own
 *   picture (badge / card / number pin, rendered at high resolution, a grouped logo with its count
 *   pip; the `dot` style uses ellipse shapes) · attribution text box · crimson legend
 *   panel (gradient + faint circles rendered to one background picture) · "Tiendas" heading and one
 *   picture + text box per legend row. Speaker notes list the counts and radius results.
 *   Analysis slides (SPEC §6.3): rings as dashed ellipses without fill ("Anillo 1 km"; baked into the
 *   basemap when not wholly inside the frame) + their pills as text, lines to the nearest store of
 *   each chain as connectors glued to the store dot and the reference, the reference pin as its own
 *   picture ("Referencia — …"; a reference store's marker picture carries its halo), and the
 *   "Distancias a …" list as real text (heading, chain icon picture, name, distance); notes add the
 *   ring counts and the nearest stores.
 *   markerStyle 'number' adds store-table slide(s) (# / chain / store / address / district).
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.4): MT.export.pptx(mapIds, opts) → Promise<{file, files}>
 *   opts: the common export options of export-png.js ({download, ui, signal, onProgress}) +
 *   mapScale (basemap picture resolution, default 3 = 3000 px across the 7.75 in frame) and
 *   basemapFormat ('jpeg' default, 92 % — or 'png', lossless and ≈ 3.5× larger).
 * Extras: MT.export.pptx.plan(mapCfg, opts) → Promise<{elements, notes, table, ...}> — the slide as
 *   plain data in inches (used by the writer and by tools/test/export.test.mjs).
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;
  const X = (MT.export = MT.export || {});

  // Deck content is Spanish, like 'Tiendas' / 'Peso:' in MT.theme (ARCHITECTURE §1.9).
  const DECK = {
    tableTitle: '{title} — listado de tiendas',
    tableHead: ['N°', 'Cadena', 'Tienda', 'Dirección', 'Distrito'],
    notesStores: 'Tiendas en el mapa: {n}',
    notesGroups: 'Tiendas cercanas de una misma cadena agrupadas en un logo con su número (×n): {g} logos por {n} tiendas.',
    groupAlt: '{n} tiendas de {chain}: {names}',
    notesRadius: 'Radio de {r} alrededor de {store} ({chain}): {same} de la misma cadena y {comp} de la competencia.',
    notesGenerated: 'Generado con Mapa de Tiendas el {date}.',
    // Analysis slides (SPEC §6.3).
    notesAnalysis: 'Distancias en línea recta a {ref} (anillos: {rings}; tiendas hasta {max}).',
    notesAnalysisDistricts: 'Distancias en línea recta a {ref} (anillos: {rings}; tiendas de los distritos seleccionados).',
    notesRing: { one: 'Hasta {r}: {n} tienda{rel}.', other: 'Hasta {r}: {n} tiendas{rel}.' },
    notesRingRel: ' ({same} de la misma cadena, {comp} de la competencia)',
    notesNearest: 'Más cercanas:',
    notesFlags: ' ({flags})',
    notesApprox: 'ubicación aproximada',
    notesToVerify: 'por verificar',
    refName: 'Referencia — {name}',
    lang: 'es-PE',
  };
  const MAP_SCALE = 3;      // basemap picture: 3000 px across 7.75 in ≈ 387 dpi
  const MARKER_SCALE = 4;   // marker pictures: px per reference unit (a badge is ≈ 0.36 in → ≈ 515 dpi)
  const ICON_DPI = 600;     // legend icons
  const PANEL_DPI = 144;    // smooth gradient: resolution hardly matters
  const TEXT_W = 1920;      // slide width (px) at which MT.slide.layout measures the text

  /* ---- Units & colours ---------------------------------------------------------------------------- */
  const T = () => MT.theme;
  const rin = (u) => T().ref2in(u);                   // reference units → inches
  const rpt = (u) => T().ref2in(u) * 72;              // reference units → points
  const r4 = (v) => Math.round(v * 10000) / 10000;
  function fmt(s, vars) { return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)); }
  /** '#RRGGBB' | 'rgba(r,g,b,a)' | 'rgb()' → {hex:'RRGGBB', alpha}. */
  function color(c) {
    const s = String(c || '').trim();
    let m = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m) return { hex: m[1].toUpperCase(), alpha: 1 };
    m = /^#?([0-9a-f]{3})$/i.exec(s);
    if (m) return { hex: m[1].split('').map((x) => x + x).join('').toUpperCase(), alpha: 1 };
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) {
      const hex = [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase();
      return { hex: hex, alpha: m[4] === undefined ? 1 : +m[4] };
    }
    return { hex: '000000', alpha: 1 };
  }
  const transp = (alpha) => Math.round((1 - U.clamp(alpha, 0, 1)) * 100);

  /* ---- Pictures --------------------------------------------------------------------------------------- */
  function gradient(ctx, x, y, w, hh, g) {
    const th = g.angleDeg * Math.PI / 180;
    const dx = Math.sin(th), dy = -Math.cos(th);                 // CSS angle: 0deg = to top, clockwise
    const len = Math.abs(w * dx) + Math.abs(hh * dy);
    const cx = x + w / 2, cy = y + hh / 2;
    const lg = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
    lg.addColorStop(0, g.from); lg.addColorStop(1, g.to);
    return lg;
  }
  /** The legend panel background (gradient + faint circles) as one JPEG data URI. */
  function panelImage() {
    const p = T().panel;
    const cv = document.createElement('canvas');
    cv.width = Math.round(p.w * PANEL_DPI); cv.height = Math.round(p.h * PANEL_DPI);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = gradient(ctx, 0, 0, cv.width, cv.height, p.gradient);
    ctx.fillRect(0, 0, cv.width, cv.height);
    p.circles.forEach((c) => {
      ctx.beginPath(); ctx.arc(c.cx * PANEL_DPI, c.cy * PANEL_DPI, c.r * PANEL_DPI, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + c.alpha + ')'; ctx.fill();
    });
    return cv.toDataURL('image/jpeg', 0.92);
  }

  /** Width (px) of a radius label pill — same maths as MT.radius.drawLabels. */
  let mctx = null;
  function labelBox(l) {
    const fs = T().pt2ref(T().radius.label.sizePt);
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = MT.radius.labelFont(fs);
    const F = MT.layout.frame();
    const w = mctx.measureText(l.text).width + fs * 0.9, hh = fs * 1.45;
    const x = U.clamp(l.x, w / 2 + 2, F.width - w / 2 - 2), y = U.clamp(l.y, hh / 2 + 2, F.height - hh / 2 - 2);
    return { x: x - w / 2, y: y - hh / 2, w: w, h: hh };
  }

  /* ---- The slide as data (inches) ------------------------------------------------------------------- */
  /**
   * Plan one map's slide. o: {mapScale, basemap=true, cache: Map (marker pictures), onStep(key)}.
   * Elements: {kind:'rect'|'text'|'image'|'line'|'ellipse'|'pill', name, x, y, w, h, …} in inches.
   */
  async function plan(cfg, o) {
    const p = await planOnce(cfg, o);
    // Rendering the basemap can teach MT.layout where the district names are, which may widen an
    // automatic view (a selected district's name must not be cut by the frame): plan once more with
    // that view, so markers, circles and basemap always share one view.
    const v = MT.layout.viewFor(cfg);
    if (Math.abs(v.zoomRef - p.view.zoomRef) > 1e-9 || Math.abs(v.center[0] - p.view.center[0]) > 1e-9 || Math.abs(v.center[1] - p.view.center[1]) > 1e-9) return planOnce(cfg, o);
    return p;
  }
  async function planOnce(cfg, o) {
    o = o || {};
    const th = T(), F = MT.layout.frame();
    const fx = th.mapFrame.x, fy = th.mapFrame.y;
    const style = MT.layout.styleOf(cfg);
    const view = MT.layout.viewFor(cfg);
    const project = MT.layout.projector(view);
    const cache = o.cache || new Map();
    const els = [];
    const at = (u) => ({ x: fx + rin(u.x), y: fy + rin(u.y) });     // reference point → slide inches

    // Radius circles: an ellipse when the whole circle is inside the frame, else baked in the basemap.
    const results = MT.radius.compute(cfg);
    const shapes = [], baked = [];
    results.forEach((r) => {
      const ring = r.circle.geometry.coordinates[0].map(project);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      ring.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
      const inside = x0 >= 0 && y0 >= 0 && x1 <= F.width && y1 <= F.height;
      (inside ? shapes : baked).push({ r: r, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    });
    const bakedKeys = new Set(baked.map((b) => b.r.storeId + '|' + b.r.meters));
    const baseCfg = Object.assign({}, cfg, { radius: (cfg.radius || []).filter((x) => bakedKeys.has(x.storeId + '|' + (+x.meters))) });
    // An analysis slide's rings: ellipses when wholly inside the frame, else baked like the radius
    // circles (their pills too).
    const ana = cfg.analysis ? MT.layout.analysis(cfg) : null;
    const aRings = ana ? ana.rings.filter((r) => r.visible) : [];
    const aShapes = aRings.filter((r) => r.inside), aBaked = aRings.filter((r) => !r.inside).map((r) => r.meters);

    if (o.onStep) o.onStep('basemap');
    let base = null;
    if (o.basemap !== false) {
      // Basemap labels keep off the slide's markers, dots and leaders (blockers from cfg's layout).
      base = await MT.render.mapCanvas(baseCfg, { scale: o.mapScale || MAP_SCALE, markers: false, attribution: false, blockersFor: cfg, rings: ana ? aBaked : undefined });
    }
    if (o.onStep) o.onStep('markers');
    // The slide's own layout (the basemap picture was rendered with only the baked radius circles,
    // whose labels are layout obstacles too — its `layout` could differ from the preview's).
    const layout = MT.layout.compute(cfg);
    const rows = MT.legend.items(cfg, layout);
    await MT.markers.ready(layout.map((i) => i.chainId).concat(rows.map((r) => r.chainId), rows.distances ? rows.distances.items.map((d) => d.chainId) : []), style);
    const g = MT.slide.layout(cfg, TEXT_W, rows);
    const k = g.k;                              // slide px per inch
    const px2in = (v) => v / k, px2pt = (v) => v / k * 72;

    // 1) Left area, title, subtitle.
    const la = color(th.slide.leftArea.color);
    els.push({ kind: 'rect', name: 'Fondo', x: px2in(g.leftArea.x), y: px2in(g.leftArea.y), w: px2in(g.leftArea.w), h: px2in(g.leftArea.h), fill: la.hex });
    // Template decoration (theme slide.decoration), behind the title and the map.
    if (g.decoration) {
      const ext = (/^data:image\/(png|jpe?g|svg\+xml|gif)/i.exec(g.decoration.src) || [, 'png'])[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      els.push({ kind: 'image', name: 'Decoración', alt: '', x: px2in(g.decoration.x), y: px2in(g.decoration.y), w: px2in(g.decoration.w), h: px2in(g.decoration.h),
        data: g.decoration.src, key: 'mt-decoracion.' + ext });
    }
    if (g.title.text) {
      // The slide's real title placeholder: PowerPoint's outline, slide sorter, Zoom and the
      // accessibility checker see it as the slide title, and it survives "Reuse slides".
      els.push({ kind: 'text', name: 'Título', placeholder: 'title', x: px2in(g.title.x), y: px2in(g.title.y), w: px2in(g.title.w), h: px2in(g.title.h),
        runs: [{ text: g.title.text, bold: !!th.title.bold, color: color(g.title.color).hex }],
        fontSize: px2pt(g.title.fontPx), align: th.title.align || 'center', valign: 'middle' });
    }
    const s = g.subtitle;
    if (s.lines.length) {
      const runs = [];
      s.lines.forEach((ln, li) => ln.runs.forEach((r, ri) => {
        runs.push({ text: r.text, bold: r.weight === 'bold', color: color(r.color).hex,
          underline: r.kind === 'peso' && th.subtitle.peso.underline ? color(th.subtitle.peso.color).hex : null,
          breakLine: ri === ln.runs.length - 1 && li < s.lines.length - 1, kind: r.kind });
      }));
      els.push({ kind: 'text', name: 'Subtítulo', x: px2in(s.x), y: px2in(s.lines[0].y), w: px2in(s.w), h: px2in(s.lines.length * s.lineH),
        runs: runs, fontSize: px2pt(s.fontPx), align: 'center', valign: 'middle', lineSpacingMultiple: 1.2 / 1.2207 });
    }

    // 2) Basemap picture in the map frame (+ optional frame border). Everything from here to the
    //    attribution is the map: the writer groups it as "Mapa" (moves/scales as one object).
    const mapFrom = els.length;
    if (base) {
      // JPEG 92 %: indistinguishable from PNG even at 1:1 and ≈ 3.5× smaller (a 5-map deck: ≈ 5 MB
      // instead of 17 MB). opts.basemapFormat 'png' keeps it lossless.
      const lossless = o.basemapFormat === 'png';
      els.push({ kind: 'image', name: 'Mapa base', alt: 'Mapa base: ' + (g.title.full || ''), x: fx, y: fy, w: th.mapFrame.w, h: th.mapFrame.h,
        data: base.canvas.toDataURL(lossless ? 'image/png' : 'image/jpeg', 0.92), key: null, px: { w: base.canvas.width, h: base.canvas.height } });
      base.canvas.width = base.canvas.height = 0;
    }

    // 3) Radius circles (ellipses) + "1 km" pills.
    const lab = MT.radius.labels(shapes.map((x) => x.r), project);
    shapes.forEach((x, i) => {
      const c = MT.radius.colorsFor(x.r.chainId);
      const p = at(x.box);
      els.push({ kind: 'ellipse', name: 'Radio ' + MT.radius.formatMeters(x.r.meters) + ' — ' + x.r.center.name,
        x: p.x, y: p.y, w: rin(x.box.w), h: rin(x.box.h),
        fill: color(c.fill).hex, fillTransparency: transp(c.fillOpacity),
        line: color(c.stroke).hex, lineWidth: rpt(th.radius.width), dash: th.radius.dash ? 'dash' : null });
      const b = labelBox(lab[i]), q = at(b);
      els.push({ kind: 'pill', name: 'Etiqueta radio ' + lab[i].text, x: q.x, y: q.y, w: rin(b.w), h: rin(b.h),
        text: lab[i].text, color: color(lab[i].color).hex, fill: 'FFFFFF', fillTransparency: 6,
        line: color(lab[i].color).hex, lineWidth: rpt(Math.max(0.8, th.radius.width * 0.6)), fontSize: th.radius.label.sizePt });
    });

    // 3b) Analysis slide: rings (dashed outlines, no fill, largest first), the faint lines
    //     reference → nearest store of each chain (connectors glued to the store dot — or to a
    //     collapsed logo's ring-colour dot — and to the reference: the pin's tip, or the reference
    //     store's dot), then the rings' pills on top (the order of MT.render.drawOverlay).
    if (ana) {
      const R = th.analysis.ring || {}, rc = color(R.color), lab = R.label || {};
      aShapes.slice().sort((a, b) => b.meters - a.meters).forEach((r) => {
        const p = at(r.bbox);
        els.push({ kind: 'ellipse', name: 'Anillo ' + r.text, x: p.x, y: p.y, w: rin(r.bbox.w), h: rin(r.bbox.h), fill: null,
          line: rc.hex, lineWidth: rpt(R.width || 1.6), lineTransparency: transp((R.alpha === undefined ? 1 : R.alpha) * rc.alpha), dash: R.dash ? 'dash' : null, role: 'ring' });
      });
      const AL = th.analysis.line || {};
      if (AL.width > 0) {
        const byId = {};
        layout.forEach((it) => { byId[it.storeId] = it; });
        const refIt = ana.ref.storeId ? byId[ana.ref.storeId] : null;
        const from = refIt ? MT.markers.dotOf(refIt) : (ana.pin ? { x: ana.pin.x, y: ana.pin.y } : null);
        const lc = color(AL.color);
        if (from) {
          ana.lines.forEach((l) => {
            const it = byId[l.storeId];
            if (!it) return;
            const d = it.collapsed ? it.pos : MT.markers.dotOf(it);
            const a = at(d), b = at(from);
            els.push({ kind: 'line', name: 'Distancia — ' + it.name + ' (' + MT.legend.distance(l.meters) + ')', x1: a.x, y1: a.y, x2: b.x, y2: b.y,
              color: lc.hex, lineWidth: rpt(AL.width), transparency: transp((AL.alpha === undefined ? 0.5 : AL.alpha) * lc.alpha),
              storeId: it.storeId, dotId: it.storeId, startRole: it.collapsed ? 'marker' : 'dot',
              markerId: refIt ? refIt.storeId : 'ref', endRole: refIt ? 'dot' : 'ref', endSite: refIt ? 0 : 2, role: 'aline' });
          });
        }
      }
      // The pills over the lines (as MT.render.drawOverlay: lines, then pills).
      aShapes.forEach((r) => {
        if (!r.label) return;
        const l = r.label, q = at({ x: l.x - l.w / 2, y: l.y - l.h / 2 });
        els.push({ kind: 'pill', name: 'Etiqueta anillo ' + l.text, x: q.x, y: q.y, w: rin(l.w), h: rin(l.h), text: l.text,
          color: color(lab.color || R.color).hex, fill: 'FFFFFF', fillTransparency: 6, line: rc.hex, lineWidth: rpt(Math.max(0.8, (R.width || 1.6) * 0.6)), fontSize: lab.sizePt || 9 });
      });
    }

    // 4) Group spokes → leader halos → leaders → store dots → markers (top to bottom), as
    //    MT.markers.drawAll. A leader starts at the dot of `leaderFrom` (a group's nearest store) and
    //    ends at the marker; its white halo is a second connector glued to the same two shapes (it
    //    follows the leader when a logo is dragged in PowerPoint). A grouped logo's spokes are faint
    //    connectors in the ring colour, glued to a store dot and to the logo (or to another store
    //    dot of the group).
    const spk = th.marker.spoke || { width: 0.75, alpha: 0.5 };
    if (spk.width > 0) {
      layout.forEach((it) => (it.spokes || []).forEach((s) => {
        const a = at({ x: s.x1, y: s.y1 }), b = at({ x: s.x2, y: s.y2 }), rc = color(MT.markers.ringColor(it.chainId));
        els.push({ kind: 'line', name: 'Agrupación — ' + ((MT.data.store(s.storeId) || {}).name || s.storeId), x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: rc.hex,
          lineWidth: rpt(spk.width), transparency: transp((spk.alpha === undefined ? 0.5 : spk.alpha) * rc.alpha),
          storeId: s.storeId, dotId: s.storeId, markerId: s.to || it.storeId, endRole: s.to ? 'dot' : 'marker', role: 'spoke' });
      }));
    }
    const ld = th.marker.leader, ldc = color(ld.color), hl = ld.halo && ld.halo.width > 0 ? ld.halo : null;
    const leaderEl = (it, halo) => {
      const a = at({ x: it.leader.x1, y: it.leader.y1 }), b = at({ x: it.leader.x2, y: it.leader.y2 });
      const c = halo ? color(hl.color) : ldc;
      return { kind: 'line', name: (halo ? 'Guía (borde) — ' : 'Guía — ') + it.name, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: c.hex,
        lineWidth: rpt(halo ? hl.width : ld.width), transparency: transp((halo ? (hl.alpha === undefined ? 1 : hl.alpha) : ld.alpha) * c.alpha),
        storeId: it.storeId, dotId: it.leaderFrom || it.storeId, markerId: it.storeId, role: halo ? 'halo' : 'leader' };
    };
    if (hl) layout.forEach((it) => { if (it.leader) els.push(leaderEl(it, true)); });
    layout.forEach((it) => { if (it.leader) els.push(leaderEl(it, false)); });
    const ad = th.marker.anchorDot, ar = MT.markers.anchorRadius(style), asw = ad.strokeWidth * Math.sqrt(style.size);
    // The dots a leader starts at last (MT.markers.dotOrder): a leader always ends on its own dot.
    MT.markers.dotOrder(layout).forEach((it) => {
      if (it.collapsed || (style.kind === 'dot' && !it.displaced)) return;
      const d = MT.markers.dotOf(it);
      const p = at({ x: d.x - ar, y: d.y - ar });
      els.push({ kind: 'ellipse', name: 'Ubicación — ' + it.name, x: p.x, y: p.y, w: rin(2 * ar), h: rin(2 * ar),
        fill: color(MT.markers.dotColor(it.chainId, style)).hex, line: color(ad.stroke).hex, lineWidth: rpt(asw), storeId: it.storeId, role: 'dot' });
    });
    const order = MT.markers.paintOrder(layout.filter(MT.markers.isMarker), style);
    order.forEach((it) => {
      const chain = MT.data.chain(it.chainId).name;
      if (style.kind === 'dot') {
        const sw = th.marker.dot.strokeWidth * (it.w / (2 * th.marker.dot.radius));
        const r = it.w / 2 - sw / 2;
        const p = at({ x: it.pos.x - r, y: it.pos.y - r });
        // The analysis' reference store: its halo ring (as MT.markers draws it) under the dot.
        if (it.isRef) {
          const H = th.analysis.halo, k2 = Math.sqrt(style.size), rr = it.w / 2 + (H.gap + H.width / 2) * k2;
          const q = at({ x: it.pos.x - rr, y: it.pos.y - rr });
          els.push({ kind: 'ellipse', name: fmt(DECK.refName, { name: it.name }) + ' (halo)', x: q.x, y: q.y, w: rin(2 * rr), h: rin(2 * rr), fill: null,
            line: color(H.color).hex, lineWidth: rpt(H.width * k2) });
        }
        els.push({ kind: 'ellipse', name: it.name, alt: it.name + ' — ' + chain, x: p.x, y: p.y, w: rin(2 * r), h: rin(2 * r),
          fill: color(MT.markers.markerColor(it.chainId)).hex, line: color(th.marker.dot.stroke).hex, lineWidth: rpt(sw), storeId: it.storeId, role: 'marker' });
        return;
      }
      const key = [style.kind, it.chainId, it.w.toFixed(3), it.h.toFixed(3), it.number || '', it.count > 1 ? 'x' + it.count : '', it.isRef ? 'ref' : ''].join('|');
      let pic = cache.get(key);
      if (!pic) {
        const img = MT.markers.image(it, style, MARKER_SCALE);
        pic = { data: img.canvas.toDataURL('image/png'), dx: img.x - it.pos.x, dy: img.y - it.pos.y, w: img.w, h: img.h, path: 'mt-' + U.slug(key) + '.png' };
        cache.set(key, pic);
      }
      const p = at({ x: it.pos.x + pic.dx, y: it.pos.y + pic.dy });
      // A grouped logo says how many stores it stands for (name, alt text): "Tiendas 3A ×5".
      // The analysis' reference store (its picture has the halo): "Referencia — Plaza Vea Miraflores".
      const name = it.count > 1 ? chain + ' ×' + it.count : it.isRef ? fmt(DECK.refName, { name: it.name }) : it.name;
      const alt = it.count > 1 ? fmt(DECK.groupAlt, { n: it.count, chain: chain, names: (it.members || []).map((id) => (MT.data.store(id) || {}).name || id).join(', ') }) : it.name + ' — ' + chain;
      els.push({ kind: 'image', name: name, alt: alt, x: p.x, y: p.y, w: rin(pic.w), h: rin(pic.h),
        data: pic.data, key: pic.path, storeId: it.storeId, role: 'marker' });
    });
    // Logos that found no room near their store (MT.layout `collapsed`): dots in the ring colour.
    const cd = th.marker.collapsed || { stroke: '#FFFFFF', strokeWidth: 1.75 };
    MT.markers.paintOrder(layout.filter((it) => it.collapsed), { kind: 'dot', size: style.size }).forEach((it) => {
      const sw = cd.strokeWidth * Math.sqrt(style.size), r = it.w / 2 - sw / 2;
      const p = at({ x: it.pos.x - r, y: it.pos.y - r });
      els.push({ kind: 'ellipse', name: it.name, alt: it.name + ' — ' + MT.data.chain(it.chainId).name, x: p.x, y: p.y, w: rin(2 * r), h: rin(2 * r),
        fill: color(MT.markers.ringColor(it.chainId)).hex, line: color(cd.stroke).hex, lineWidth: rpt(sw), storeId: it.storeId, role: 'marker' });
    });
    // The analysis' reference point (or a reference store not drawn on the slide): the pin, on top.
    if (ana && ana.pin) {
      const pkey = 'mt-ref-pin.png';
      let pic = cache.get(pkey);
      // Cut at the tip: the lines' glue site (bottom centre, endSite 2) is the tip itself.
      if (!pic) { const img = MT.markers.pinImage(MARKER_SCALE, { tipAtBottom: true }); pic = { data: img.canvas.toDataURL('image/png'), dx: img.dx, dy: img.dy, w: img.w, h: img.h }; cache.set(pkey, pic); }
      const p = at({ x: ana.pin.x + pic.dx, y: ana.pin.y + pic.dy });
      els.push({ kind: 'image', name: fmt(DECK.refName, { name: ana.label }), alt: fmt(DECK.refName, { name: ana.label }), x: p.x, y: p.y, w: rin(pic.w), h: rin(pic.h),
        data: pic.data, key: pkey, storeId: 'ref', role: 'ref' });
    }

    // 5) Attribution (real text on a translucent white box), at a real point size (theme
    //    attribution.pptx) in a box as wide as that text needs, in the frame's corner.
    const ab = MT.layout.attributionBox(), apx = th.attribution.pptx || {};
    const aPt = Math.max(rpt(ab.fontPx), apx.sizePt || 0), abg = color(apx.background || th.attribution.background);
    const aw = Math.max(rin(ab.w), MT.slide.textWidth(ab.text, 'normal', aPt / 72 * k) / k + 2 * rin(th.attribution.padding) + 0.04);
    const ah = Math.max(rin(ab.h), aPt / 72 * 1.3);
    const ax = th.attribution.position === 'bottom-left' ? fx : fx + th.mapFrame.w - aw, ay = fy + th.mapFrame.h - ah;
    els.push({ kind: 'text', name: 'Atribución', x: ax, y: ay, w: aw, h: ah,
      runs: [{ text: ab.text, color: color(th.attribution.color).hex }], fontSize: aPt, align: 'center', valign: 'middle', wrap: false,
      fill: abg.hex, fillTransparency: transp(abg.alpha), font: th.fonts.slide });
    const mapGroup = { from: mapFrom, to: els.length - 1, x: fx, y: fy, w: th.mapFrame.w, h: th.mapFrame.h };

    // 6) Legend panel: background picture, heading, rows (icon picture + text).
    els.push({ kind: 'image', name: 'Panel de leyenda', x: px2in(g.panel.x), y: px2in(g.panel.y), w: px2in(g.panel.w), h: px2in(g.panel.h),
      data: o.panelData || panelImage(), key: 'mt-panel.jpg' });
    const lg = g.legend;
    // (An analysis slide short of space shows only its distance list: no "Tiendas" heading.)
    if (lg.heading.text) {
      els.push({ kind: 'text', name: 'Leyenda — título', x: px2in(lg.heading.x), y: px2in(lg.heading.y), w: px2in(lg.heading.w), h: px2in(lg.heading.h),
        runs: [{ text: lg.heading.text, bold: true, color: color(lg.heading.color).hex }], fontSize: px2pt(lg.heading.fontPx), align: 'center', valign: 'middle' });
    }
    lg.rows.forEach((r) => {
      const iconPx = Math.max(24, Math.round(px2in(r.icon.h) * ICON_DPI));
      const ikey = 'icon|' + style.kind + '|' + r.chainId + '|' + iconPx;
      let idata = cache.get(ikey);
      if (!idata) { idata = MT.markers.icon(r.chainId, iconPx, style).toDataURL('image/png'); cache.set(ikey, idata); }
      els.push({ kind: 'image', name: 'Leyenda — ' + r.text, x: px2in(r.icon.x), y: px2in(r.icon.y), w: px2in(r.icon.w), h: px2in(r.icon.h),
        data: idata, key: 'mt-' + U.slug(ikey) + '.png', chainId: r.chainId, role: 'legend-icon' });
      const tw = MT.slide.textWidth(r.text, 'bold', r.fontPx);
      els.push({ kind: 'text', name: 'Leyenda — ' + r.text, x: px2in(r.textX), y: px2in(r.y), w: px2in(tw) + 0.25, h: px2in(r.h),
        runs: [{ text: r.text, bold: true, color: color(lg.color).hex }], fontSize: px2pt(r.fontPx), align: 'left', valign: 'middle', wrap: false,
        chainId: r.chainId, role: 'legend-text' });
    });
    // Key for grouped logos ("×N = N tiendas cercanas · • = ubicación exacta").
    if (lg.note) {
      els.push({ kind: 'text', name: 'Nota de la leyenda', x: px2in(lg.note.x), y: px2in(lg.note.y), w: px2in(lg.note.w) + 0.25, h: px2in(lg.note.h),
        runs: [{ text: lg.note.text, color: color(lg.note.color).hex }], fontSize: px2pt(lg.note.fontPx), align: 'left', valign: 'middle', wrap: false, role: 'legend-note' });
    }
    // Analysis slide: "Distancias a <referencia>" — real text: the heading, then per store its chain
    // icon (picture), its short name and its distance (right-aligned).
    if (lg.dist) {
      const D = lg.dist, hl = D.heading.lines;
      if (hl.length) {
        const top = hl[0].y, hh = hl.length * hl[0].h;
        const wmax = Math.max.apply(null, hl.map((ln) => ln.w));
        els.push({ kind: 'text', name: 'Distancias — título', x: px2in(hl[0].x), y: px2in(top), w: px2in(Math.max(wmax, D.w)) + 0.05, h: px2in(hh),
          runs: hl.map((ln, i) => ({ text: ln.text, bold: true, color: color(D.heading.color).hex, breakLine: i < hl.length - 1 })), fontSize: px2pt(D.heading.fontPx),
          align: 'left', valign: 'middle', wrap: false, lineSpacingMultiple: 1.22 / 1.2207, role: 'dist-heading' });
      }
      D.rows.forEach((r) => {
        const iconPx = Math.max(24, Math.round(px2in(r.icon.h) * ICON_DPI));
        const ikey = 'icon|' + style.kind + '|' + r.chainId + '|' + iconPx;
        let idata = cache.get(ikey);
        if (!idata) { idata = MT.markers.icon(r.chainId, iconPx, style).toDataURL('image/png'); cache.set(ikey, idata); }
        const who = r.full || r.text;
        els.push({ kind: 'image', name: 'Distancia — ' + who + ' (logo)', x: px2in(r.icon.x), y: px2in(r.icon.y), w: px2in(r.icon.w), h: px2in(r.icon.h),
          data: idata, key: 'mt-' + U.slug(ikey) + '.png', chainId: r.chainId, role: 'dist-icon' });
        els.push({ kind: 'text', name: 'Distancia — ' + who, x: px2in(r.textX), y: px2in(r.y), w: px2in(r.textW) + 0.05, h: px2in(r.h),
          runs: [{ text: r.text, color: color(D.color).hex }], fontSize: px2pt(r.fontPx), align: 'left', valign: 'middle', wrap: false, role: 'dist-name' });
        const dw = px2in(r.distW) + 0.25;
        els.push({ kind: 'text', name: 'Distancia — ' + who + ' (valor)', x: px2in(r.distX) - dw, y: px2in(r.y), w: dw, h: px2in(r.h),
          runs: [{ text: r.dist, bold: true, color: color(D.distColor).hex }], fontSize: px2pt(r.fontPx), align: 'right', valign: 'middle', wrap: false, role: 'dist-value' });
      });
    }

    // Speaker notes (Spanish deck content).
    const notes = [];
    notes.push((g.title.full || '') + (s.lines.length ? '  ' + s.lines.map((ln) => ln.runs.map((r) => r.text).join('')).join(' ') : ''));
    notes.push(fmt(DECK.notesStores, { n: layout.length }) + (rows.length ? ' — ' + rows.map((r) => r.text).join(', ') : ''));
    const grouped = layout.filter((it) => it.count > 1);
    if (grouped.length) notes.push(fmt(DECK.notesGroups, { g: grouped.length, n: grouped.reduce((a, it) => a + it.count, 0) }));
    results.forEach((r) => {
      notes.push(fmt(DECK.notesRadius, { r: MT.radius.formatMeters(r.meters), store: r.center.name, chain: MT.data.chain(r.chainId).name, same: r.sameChain, comp: r.competitors }));
      r.inside.slice(0, 15).forEach((x) => notes.push('   • ' + x.store.name + ' (' + MT.data.chain(x.store.chain).name + ') — ' + MT.radius.formatMeters(x.distance)));
    });
    // Analysis slide: rings with their counts, and the nearest stores.
    if (ana) {
      const fa = MT.analysis.forMap(cfg);
      if (fa) {
        // A slide with districts takes its stores from them, not from a distance.
        const byDistance = !!MT.data.analysisRegion(cfg);
        notes.push(fmt(byDistance ? DECK.notesAnalysis : DECK.notesAnalysisDistricts,
          { ref: fa.label, rings: fa.rings.map((m) => MT.legend.ringLabel(m)).join(' / '), max: MT.legend.ringLabel(fa.maxMeters) }));
        fa.summary.cumulative.forEach((c) => notes.push('   • ' + fmt(c.total === 1 ? DECK.notesRing.one : DECK.notesRing.other, { r: MT.legend.ringLabel(c.to), n: c.total,
          rel: fa.summary.relation ? fmt(DECK.notesRingRel, { same: c.sameChain, comp: c.competitors }) : '' })));
        if (fa.top.length) {
          notes.push(DECK.notesNearest);
          fa.top.forEach((r) => {
            const flags = [r.flags.approx ? DECK.notesApprox : null, r.flags.toVerify ? DECK.notesToVerify : null].filter(Boolean);
            notes.push('   ' + r.rank + '. ' + r.store.name + ' (' + MT.data.chain(r.store.chain).name + ') — ' + (flags.length ? '≈ ' : '') + MT.legend.distance(r.meters)
              + (flags.length ? fmt(DECK.notesFlags, { flags: flags.join(', ') }) : ''));
          });
        }
      }
    }
    notes.push(fmt(DECK.notesGenerated, { date: U.todayISO() }) + ' ' + th.attribution.text);

    // Store table for the numbered style.
    let table = null;
    if (style.kind === 'number' && layout.length) {
      table = layout.slice().sort((a, b) => a.number - b.number).map((it) => {
        const st = MT.data.store(it.storeId) || {};
        return { number: it.number, chainId: it.chainId, chain: MT.data.chain(it.chainId).name, name: it.name || st.name || '', address: st.address || '', district: st.district || '' };
      });
    }
    return { id: cfg.id, title: g.title.full || '', elements: els, notes: notes.join('\n'), table: table, layout: layout, view: view, style: style, mapGroup: mapGroup,
      radius: { shapes: shapes.length, baked: baked.length }, analysis: ana ? { shapes: aShapes.length, baked: aBaked.length, pin: !!ana.pin } : null };
  }

  /* ---- Writer (PptxGenJS) ------------------------------------------------------------------------------- */
  function runOpts(r, el) {
    const o = { color: r.color, bold: !!r.bold, lang: DECK.lang, fontFace: el.font || T().fonts.slide, fontSize: el.fontSize };
    if (r.underline) o.underline = { style: 'sng', color: r.underline };
    if (r.breakLine) o.breakLine = true;
    if (el.align) o.align = el.align;
    return o;
  }
  function addElement(deck, slide, el) {
    const S = deck.ShapeType || deck.shapes || {};
    const box = { x: r4(el.x), y: r4(el.y), w: r4(el.w), h: r4(el.h), objectName: el.name };
    switch (el.kind) {
      case 'rect':
        slide.addShape(S.rect || 'rect', Object.assign(box, { fill: { color: el.fill } }));
        break;
      case 'image': {
        const o = Object.assign(box, { data: el.data, altText: el.alt || el.name });
        if (el.key) o.path = el.key;          // same key ⇒ PptxGenJS stores the picture once per slide
        slide.addImage(o);
        break;
      }
      case 'line': {
        const x = Math.min(el.x1, el.x2), y = Math.min(el.y1, el.y2);
        slide.addShape(S.line || 'line', { x: r4(x), y: r4(y), w: r4(Math.abs(el.x2 - el.x1)), h: r4(Math.abs(el.y2 - el.y1)),
          flipH: el.x2 < el.x1, flipV: el.y2 < el.y1, objectName: el.name,
          line: { color: el.color, width: r4(el.lineWidth), transparency: el.transparency || 0 } });
        break;
      }
      case 'ellipse': {
        // (No fill: an analysis ring's outline only.)
        const o = Object.assign(box, el.fill ? { fill: { color: el.fill, transparency: el.fillTransparency || 0 } } : {});
        if (el.line) o.line = Object.assign({ color: el.line, width: r4(el.lineWidth) }, el.dash ? { dashType: el.dash } : {}, el.lineTransparency ? { transparency: el.lineTransparency } : {});
        slide.addShape(S.ellipse || 'ellipse', o);
        break;
      }
      case 'pill':
        slide.addText(el.text, Object.assign(box, {
          shape: S.roundRect || 'roundRect', rectRadius: r4(el.h / 2), fill: { color: el.fill, transparency: el.fillTransparency || 0 },
          line: { color: el.line, width: r4(el.lineWidth) }, color: el.color, bold: true, fontFace: T().fonts.slide, fontSize: el.fontSize,
          align: 'center', valign: 'middle', margin: 0, wrap: false, lang: DECK.lang }));
        break;
      case 'text': {
        const o = Object.assign(box, { fontFace: el.font || T().fonts.slide, fontSize: el.fontSize, align: el.align || 'left', valign: el.valign || 'top',
          margin: 0, wrap: el.wrap !== false, lang: DECK.lang });
        if (el.placeholder) o.placeholder = el.placeholder;
        if (el.lineSpacingMultiple) o.lineSpacingMultiple = el.lineSpacingMultiple;
        if (el.charSpacing) o.charSpacing = r4(el.charSpacing);
        if (el.glow) o.glow = el.glow;
        if (el.fill) o.fill = { color: el.fill, transparency: el.fillTransparency || 0 };
        slide.addText(el.runs.map((r) => ({ text: r.text, options: runOpts(r, el) })), o);
        break;
      }
      default: break;
    }
  }

  /** Lines a text needs in a column (greedy word wrap, Calibri metrics = Carlito on the canvas). */
  function lineCount(text, maxIn, bold, pt) {
    const px = pt / 72 * TEXT_W / T().slide.width, maxPx = maxIn * TEXT_W / T().slide.width;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    let lines = 1, cur = '';
    words.forEach((w) => {
      const trial = cur ? cur + ' ' + w : w;
      if (!cur || MT.slide.textWidth(trial, bold ? 'bold' : 'normal', px) <= maxPx) cur = trial;
      else { lines++; cur = w; }
    });
    return lines;
  }

  /**
   * Store-table slide(s) for the numbered style: rows measured (wrapped addresses make taller
   * rows) and paginated here, so no row ever runs off the slide; every page repeats title + header.
   */
  function addTableSlides(deck, p, sectionTitle) {
    const th = T();
    const FS = 10.5, LINE = FS * 1.2207 / 72, PADV = 0.035, PADH = 0.08, ROW_MIN = 0.27, HEAD_H = 0.32;
    const X0 = 0.5, Y0 = 0.9, W = th.slide.width - 2 * X0, BOTTOM = 0.35;
    const colW = [0.6, 1.9, 3.4, W - 0.6 - 1.9 - 3.4 - 1.95, 1.95];
    const head = color(th.colors.crimsonDark).hex;
    const hair = { type: 'solid', pt: 0.5, color: 'E5E7EB' }, none = { type: 'none' };
    const hdr = DECK.tableHead.map((t, i) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: head }, align: i === 0 ? 'center' : 'left', border: [none, none, none, none] } }));
    const rows = p.table.map((r) => {
      const c = MT.markers.markerColor(r.chainId), cc = color(c).hex;
      const num = U.luminance(c) > 0.55 ? '111827' : 'FFFFFF';
      const cell = (text, extra) => ({ text: String(text || ''), options: Object.assign({ color: '1F2937', border: [none, none, hair, none] }, extra || {}) });
      const lines = Math.max(lineCount(r.chain, colW[1] - 2 * PADH, true, FS), lineCount(r.name, colW[2] - 2 * PADH, false, FS),
        lineCount(r.address, colW[3] - 2 * PADH, false, FS), lineCount(r.district, colW[4] - 2 * PADH, false, FS));
      return { h: Math.max(ROW_MIN, lines * LINE + 2 * PADV + 0.02),
        cells: [cell(r.number, { bold: true, color: num, fill: { color: cc }, align: 'center' }), cell(r.chain, { bold: true }), cell(r.name), cell(r.address, { color: '4B5563' }), cell(r.district, { color: '4B5563' })] };
    });
    const avail = th.slide.height - Y0 - BOTTOM - HEAD_H;
    const pages = [];
    let cur = [], used = 0;
    rows.forEach((r) => {
      if (cur.length && used + r.h > avail) { pages.push(cur); cur = []; used = 0; }
      cur.push(r); used += r.h;
    });
    if (cur.length) pages.push(cur);
    const base = fmt(DECK.tableTitle, { title: p.title || '' }).replace(/^ — /, '');
    pages.forEach((page, i) => {
      const slide = deck.addSlide(Object.assign({ masterName: MASTER_TABLE }, sectionTitle ? { sectionTitle: sectionTitle } : {}));
      p.slideCount = (p.slideCount || 1) + 1;
      slide.background = { color: color(th.slide.background).hex };
      const title = base + (pages.length > 1 ? ' (' + (i + 1) + '/' + pages.length + ')' : '');
      slide.addText([{ text: title, options: { bold: true, color: color(th.title.color).hex, lang: DECK.lang } }],
        { placeholder: 'title', x: X0, y: 0.22, w: W, h: 0.5, fontFace: th.fonts.slide, fontSize: 22, align: 'left', valign: 'middle', margin: 0, objectName: 'Título tabla' });
      slide.addTable([hdr].concat(page.map((r) => r.cells)), {
        x: X0, y: Y0, w: W, colW: colW, rowH: [HEAD_H].concat(page.map((r) => r4(r.h))), fontFace: th.fonts.slide, fontSize: FS, valign: 'middle',
        margin: [PADV, PADH, PADV, PADH], autoPage: false, objectName: 'Tabla de tiendas', lang: DECK.lang,
      });
    });
  }

  /* ---- Public: MT.export.pptx --------------------------------------------------------------------------- */
  async function pptx(mapIds, opts) {
    const XU = X.util;
    opts = XU.optsWithDefaults(opts);
    let maps;
    try { maps = XU.resolveMaps(mapIds); } catch (e) { return XU.fail(XU.job({}), opts, e); }
    const j = XU.job({ ui: opts.ui, signal: opts.signal, onProgress: opts.onProgress, titleKey: 'export.busy.pptx' });
    try {
      await XU.breathe();
      j.progress(0.01, MT.t('export.step.library'));
      let Pptx = null;
      try { Pptx = await MT.vendor.pptx(); } catch (e) { Pptx = null; }
      if (!Pptx) throw XU.exportError('lib-unavailable');
      await MT.data.ready;
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const th = T();
      const deck = new Pptx();
      deck.layout = 'LAYOUT_WIDE';
      deck.author = 'Mapa de Tiendas';
      deck.company = 'Mapa de Tiendas';
      deck.title = maps.length === 1 ? XU.mapTitle(maps[0]) : XU.projectName();
      deck.subject = th.attribution.text;
      deck.theme = { headFontFace: th.fonts.slide, bodyFontFace: th.fonts.slide };
      const cache = new Map();
      const panelData = panelImage();
      defineMasters(deck);
      const n = maps.length;
      const groups = [];          // per slide file (1-based order of addSlide): map group or null
      for (let i = 0; i < n; i++) {
        const cfg = maps[i], title = XU.mapTitle(cfg);
        j.check();
        const p = await plan(cfg, { cache: cache, panelData: panelData, mapScale: opts.mapScale, basemapFormat: opts.basemapFormat, onStep: (key) => j.step(i, n, key === 'basemap' ? 0.05 : 0.7, key, { title: title }) });
        j.check();
        const section = n > 1 ? title : null;
        if (section) deck.addSection({ title: section });
        const slide = deck.addSlide(Object.assign({ masterName: MASTER_MAP }, section ? { sectionTitle: section } : {}));
        slide.background = { color: color(th.slide.background).hex };
        p.elements.forEach((el) => addElement(deck, slide, el));
        slide.addNotes(p.notes);
        groups.push(p.mapGroup ? Object.assign({ elements: p.elements }, p.mapGroup) : null);
        if (p.table) { addTableSlides(deck, p, section); for (let k = 1; k < p.slideCount; k++) groups.push(null); }
        j.step(i, n, 0.95, 'markers', { title: title });
        await XU.breathe();
      }
      j.progress(0.96, MT.t('export.step.packing'));
      let blob = await deck.write({ outputType: 'blob', compression: true });
      try { blob = await groupMaps(blob, groups); } catch (e) { console.warn('[export] map grouping skipped', e); }
      const res = await XU.deliver([{ name: XU.names.pptx(maps), blob: blob }], { download: opts.download, ui: opts.ui });
      res.file = res.files[0];
      j.progress(1);
      return XU.finish(j, opts, 'pptx', res);
    } catch (err) { return XU.fail(j, opts, err); }
  }
  /* ---- Slide masters with a real title placeholder ---------------------------------------------------- */
  const MASTER_MAP = 'MT_MAPA', MASTER_TABLE = 'MT_TABLA';
  function defineMasters(deck) {
    const th = T();
    const bg = { color: color(th.slide.background).hex };
    const ph = (x, y, w, h, size, align) => ({ placeholder: { options: { name: 'title', type: 'title', x: x, y: y, w: w, h: h,
      fontFace: th.fonts.slide, fontSize: size, bold: true, color: color(th.title.color).hex, align: align, valign: 'middle', margin: 0 }, text: '' } });
    deck.defineSlideMaster({ title: MASTER_MAP, background: bg, objects: [ph(th.title.x, th.title.y, th.title.w, th.title.h, th.title.sizePt, th.title.align || 'center')] });
    deck.defineSlideMaster({ title: MASTER_TABLE, background: bg, objects: [ph(0.5, 0.22, th.slide.width - 1, 0.5, 22, 'left')] });
  }

  /* ---- Post-processing: the map as one group, leaders as connectors ------------------------------------
   * PptxGenJS writes every object at the top level: moving the map onto a corporate template meant
   * selecting hundreds of objects. Each map slide's frame objects (basemap … attribution) are wrapped
   * in one group "Mapa" (child coordinates unchanged), and every leader becomes a connector glued to
   * its store dot and its marker, so PowerPoint re-routes it when a logo is dragged. */
  const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const EMU = 914400;
  async function groupMaps(blob, groups) {
    if (typeof DOMParser === 'undefined') return blob;
    const JSZip = await X.util.zipLib();
    if (!JSZip) return blob;
    const zip = await JSZip.loadAsync(blob);
    let changed = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i], name = 'ppt/slides/slide' + (i + 1) + '.xml';
      if (!zip.file(name)) continue;
      const xml = await zip.file(name).async('string');
      let out = g ? groupSlideXml(xml, g) || xml : xml;
      out = nameTitle(out, g ? 'Título' : 'Título tabla');
      if (out !== xml) { zip.file(name, out); changed = true; }
    }
    if (!changed) return blob;
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  }
  /** PptxGenJS names placeholder text "Text N": give the title its name in the selection pane. */
  function nameTitle(xml, name) {
    return xml.replace(/(<p:cNvPr id="\d+" name=")Text \d+("\/><p:cNvSpPr\/><p:nvPr><p:ph [^>]*type="title")/, (m, a, b) => a + name + b);
  }
  function groupSlideXml(xml, g) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const tree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0];
    if (!tree) return null;
    const shapes = Array.from(tree.children).filter((c) => /^(sp|pic|cxnSp|grpSp|graphicFrame)$/.test(c.localName));
    // One XML shape per plan element, in order — otherwise leave the slide alone.
    if (shapes.length !== g.elements.length) return null;
    const cNv = (el) => el.getElementsByTagNameNS(NS_P, 'cNvPr')[0];
    let maxId = 0;
    Array.from(doc.getElementsByTagNameNS(NS_P, 'cNvPr')).forEach((c) => { maxId = Math.max(maxId, +c.getAttribute('id') || 0); });
    // Leaders → connectors (start: the store dot, end: the marker picture; rect sites 0 top,
    // 1 left, 2 bottom, 3 right — the side facing the dot).
    const idOf = {};
    g.elements.forEach((el, k) => {
      if (k < g.from || k > g.to || !el.storeId || !el.role) return;
      idOf[el.role + '|' + el.storeId] = cNv(shapes[k]).getAttribute('id');
    });
    g.elements.forEach((el, k) => {
      if (k < g.from || k > g.to || el.kind !== 'line' || !el.storeId) return;
      const dotId = el.dotId || el.storeId, markerId = el.markerId || el.storeId, endRole = el.endRole || 'marker';
      // Start: the store dot — or, for a logo collapsed to a ring-colour dot (no 'dot' shape), that dot.
      const dot = idOf[(el.startRole || 'dot') + '|' + dotId], mk = idOf[endRole + '|' + markerId];
      const sp = shapes[k];
      if (!dot || !mk || sp.localName !== 'sp') return;
      const marker = g.elements.find((e) => e.role === endRole && e.storeId === markerId);
      const mx = marker.x + marker.w / 2, my = marker.y + marker.h / 2;
      const dx = el.x1 - mx, dy = el.y1 - my;
      // Rect sites 0 top, 1 left, 2 bottom, 3 right — the side facing the dot (a store dot: its first site).
      const site = el.endSite !== undefined ? el.endSite : endRole !== 'marker' ? 0 : Math.abs(dy) * marker.w >= Math.abs(dx) * marker.h ? (dy < 0 ? 0 : 2) : (dx < 0 ? 1 : 3);
      const cxn = doc.createElementNS(NS_P, 'p:cxnSp');
      const nv = doc.createElementNS(NS_P, 'p:nvCxnSpPr');
      const old = cNv(sp);
      const pr = doc.createElementNS(NS_P, 'p:cNvPr');
      pr.setAttribute('id', old.getAttribute('id')); pr.setAttribute('name', old.getAttribute('name'));
      const cpr = doc.createElementNS(NS_P, 'p:cNvCxnSpPr');
      const st = doc.createElementNS(NS_A, 'a:stCxn'); st.setAttribute('id', dot); st.setAttribute('idx', '0');
      const en = doc.createElementNS(NS_A, 'a:endCxn'); en.setAttribute('id', mk); en.setAttribute('idx', String(site));
      cpr.appendChild(st); cpr.appendChild(en);
      nv.appendChild(pr); nv.appendChild(cpr); nv.appendChild(doc.createElementNS(NS_P, 'p:nvPr'));
      cxn.appendChild(nv);
      const spPr = sp.getElementsByTagNameNS(NS_P, 'spPr')[0];
      const geom = spPr && spPr.getElementsByTagNameNS(NS_A, 'prstGeom')[0];
      if (geom) geom.setAttribute('prst', 'straightConnector1');
      if (spPr) cxn.appendChild(spPr);
      const style = sp.getElementsByTagNameNS(NS_P, 'style')[0];
      if (style) cxn.appendChild(style);
      tree.replaceChild(cxn, sp);
      shapes[k] = cxn;
    });
    // The group: child coordinates = slide coordinates (chOff/chExt = off/ext).
    const grp = doc.createElementNS(NS_P, 'p:grpSp');
    const nvg = doc.createElementNS(NS_P, 'p:nvGrpSpPr');
    const gpr = doc.createElementNS(NS_P, 'p:cNvPr');
    gpr.setAttribute('id', String(maxId + 1)); gpr.setAttribute('name', 'Mapa');
    nvg.appendChild(gpr); nvg.appendChild(doc.createElementNS(NS_P, 'p:cNvGrpSpPr')); nvg.appendChild(doc.createElementNS(NS_P, 'p:nvPr'));
    const gsp = doc.createElementNS(NS_P, 'p:grpSpPr');
    const xf = doc.createElementNS(NS_A, 'a:xfrm');
    const e = (v) => String(Math.round(v * EMU));
    [['a:off', { x: e(g.x), y: e(g.y) }], ['a:ext', { cx: e(g.w), cy: e(g.h) }], ['a:chOff', { x: e(g.x), y: e(g.y) }], ['a:chExt', { cx: e(g.w), cy: e(g.h) }]].forEach((x) => {
      const n = doc.createElementNS(NS_A, x[0]);
      Object.keys(x[1]).forEach((k) => n.setAttribute(k, x[1][k]));
      xf.appendChild(n);
    });
    gsp.appendChild(xf);
    grp.appendChild(nvg); grp.appendChild(gsp);
    tree.insertBefore(grp, shapes[g.from]);
    for (let k = g.from; k <= g.to; k++) grp.appendChild(shapes[k]);
    return new XMLSerializer().serializeToString(doc);
  }

  pptx.plan = plan;
  pptx.groupSlideXml = groupSlideXml;
  pptx.DECK = DECK;
  X.pptx = pptx;
})();
