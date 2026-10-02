/* js/export-html.js — MT.export.html: one standalone, interactive .html file. Module M4.
 *
 * The file opens with a double click (file://) in any modern browser and needs only internet for
 * MapLibre GL (pinned CDN + SRI, unpkg then jsDelivr — the only runtime CDN use allowed) and the
 * OpenFreeMap tiles. Everything else is inline: data, logos, styles and the page script.
 *
 * Page: header with title + "(districts)  Peso: x" (value bold, underlined, navy) and map tabs when
 * several maps are exported · full-height map (Spanish labels, district borders, radius circles with
 * "1 km" pills) · the SAME markers as the slide (DOM buttons showing the marker picture drawn by
 * MT.markers, store dots, leader lines) · the crimson legend panel with per-chain toggles and counts
 * · popups with store details (address, district, status, radius results, Google Maps link) ·
 * attribution. Responsive: on phones the legend becomes a bottom sheet.
 * Analysis maps (SPEC §6.3): dashed rings (MapLibre layer) with their pills, the reference pin (or the
 * reference store's marker with its halo), lines to the nearest store of each chain, the distance to
 * the reference in every popup, and the "Distancias a …" list in the legend panel (click → popup).
 *
 * Markers follow the zoom: the declutter (MT.layout.compute, deterministic) is pre-computed at the
 * export for a ladder of zoom levels around the slide's zoom; at the slide's own zoom the in-frame
 * markers sit exactly where the slide has them. The page uses, for the current zoom, the closest
 * level computed at that zoom or below (markers keep their pixel size, so a level stays overlap-free
 * when zooming in). When even that is too crowded (far zoomed out) it shows brand dots instead.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.4): MT.export.html(mapIds, opts) → Promise<{file, files}>
 *   opts: the common export options of export-png.js ({download, ui, signal, onProgress}).
 * Extras: MT.export.html.data(maps, opts) → the JSON embedded in the page; MT.export.html.page(data)
 *   → the HTML text; MT.export.html.CDN (pinned URLs + SRI).
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;
  const X = (MT.export = MT.export || {});

  // MapLibre GL JS 5.24.0 = the vendored copy (vendor/maplibre, identical sha256), pinned with SRI.
  const CDN = {
    version: '5.24.0',
    js: ['https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js', 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js'],
    css: ['https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css', 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css'],
    jsSri: 'sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp',
    cssSri: 'sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK',
  };
  // Zoom ladder (relative to the slide's zoomRef) at which the declutter is pre-computed. The page
  // snaps the zoom to these steps when a zoom gesture ends (a layout is overlap-free at its own zoom).
  const LEVELS = [-3, -2.5, -2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4];
  const LEVELS_MEDIUM = [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 4];
  const LEVELS_COARSE = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
  const MAX_LEVEL_STORES = 1500;     // above this the page shows dots only (keeps the export fast)
  const MAX_FRAME = 32000;           // largest enlarged layout frame (reference units)
  const MARKER_SCALE = 3;            // marker pictures: device px per CSS px (sharp on retina screens)

  const rnd = (v, d) => { const f = Math.pow(10, d || 0); return Math.round(v * f) / f; };

  /* ---- Data ---------------------------------------------------------------------------------------- */
  /** Page texts in the current UI language (plural templates kept as {one, other}). */
  function pageStrings() {
    const out = {};
    MT.i18n.keys(MT.i18n.lang).concat(MT.i18n.keys('es')).forEach((k) => {
      if (k.indexOf('export.page.') !== 0) return;
      const key = k.slice(12);
      if (key in out) return;
      const one = MT.t(k, { count: 1 }), other = MT.t(k, { count: 5 });
      out[key] = one === other ? one : { one: one, other: other };
    });
    return out;
  }

  /** Round GeoJSON coordinates (≈1 m) to keep the file small. */
  function roundGeo(geo, d) {
    const r = (c) => (typeof c[0] === 'number' ? [rnd(c[0], d), rnd(c[1], d)] : c.map(r));
    return JSON.parse(JSON.stringify(geo), (key, v) => (key === 'coordinates' ? r(v) : v));
  }

  /**
   * Declutter ladder: for each zoom level, marker offsets relative to the store dot (CSS px at that
   * zoom) and leader segments. The frame is enlarged to hold every exported store; at level 0 the
   * slide's in-frame markers are fixed at their slide positions.
   */
  async function levelsFor(cfg, stores, slideItems, view, o) {
    o = o || {};
    const style = MT.layout.styleOf(cfg);
    // Every level at the slide's logo size (smaller than the map's size on a crowded slide).
    const logoScale = slideItems.stats && slideItems.stats.size ? slideItems.stats.size / style.size : 1;
    if (style.kind === 'dot' || !stores.length || stores.length > MAX_LEVEL_STORES) return [];
    const z0 = view.zoomRef, F = MT.layout.frame(), M = 220;
    const slideById = {};
    slideItems.forEach((it) => { slideById[it.storeId] = it; });
    // Fewer levels for big maps: each one is a full declutter of every exported store.
    const ladder = stores.length > 600 ? LEVELS_COARSE : stores.length > 300 ? LEVELS_MEDIUM : LEVELS;
    const out = [];
    for (let li = 0; li < ladder.length; li++) {
      const d = ladder[li];
      // One level at a time with a pause in between: the progress bar moves, Cancel answers at
      // once and the page never freezes ("page unresponsive") on a big map.
      if (o.check) o.check();
      if (o.onLevel) o.onLevel(li / ladder.length);
      if (li) await X.util.breathe();
      const z = z0 + d;
      const c0 = MT.geo.project(view.center, z);
      let x0 = c0[0] - F.width / 2 * Math.pow(2, d), x1 = c0[0] + F.width / 2 * Math.pow(2, d);
      let y0 = c0[1] - F.height / 2 * Math.pow(2, d), y1 = c0[1] + F.height / 2 * Math.pow(2, d);
      stores.forEach((s) => {
        const p = MT.geo.project([s.lng, s.lat], z);
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      });
      const W = x1 - x0 + 2 * M, H = y1 - y0 + 2 * M;
      if (W > MAX_FRAME || H > MAX_FRAME) { if (d > 0) break; else continue; }
      const center = MT.geo.unproject([(x0 + x1) / 2, (y0 + y1) / 2], z);
      // Fixed markers: the slide's own positions at level 0 (with the slide's same-chain groups),
      // the user's drags (same px offset) elsewhere.
      const offsets = {};
      let groups;
      if (d === 0) {
        slideItems.forEach((it) => {
          if (it.grouped) return;
          offsets[it.storeId] = { dx: (it.pos.x - it.anchor.x) / W, dy: (it.pos.y - it.anchor.y) / W };
          if (it.count > 1) offsets[it.storeId].g = 1;
        });
        groups = slideItems.filter((it) => it.count > 1).map((it) => it.members.slice());
      } else {
        const mo = cfg.markerOffsets || {};
        Object.keys(mo).forEach((id) => { offsets[id] = Object.assign({ dx: mo[id].dx * F.width / W, dy: mo[id].dy * F.width / W }, mo[id].g ? { g: 1 } : {}); });
      }
      const items = MT.layout.compute(Object.assign({}, cfg, { markerOffsets: offsets }), { view: { center: center, zoomRef: z }, width: W, height: H, stores: stores, groups: groups,
        logoScale: logoScale, autoSize: false });
      const byId = {}, idx = {};
      items.forEach((it) => { byId[it.storeId] = it; });
      stores.forEach((s, i) => { idx[s.id] = i; });
      // Store dots spread off a neighbour's (MT.layout `dot`): offset from the store, CSS px.
      const fan = {};
      items.forEach((it) => {
        const d = it.dot || it.anchor, dx = d.x - it.anchor.x, dy = d.y - it.anchor.y;
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) fan[idx[it.storeId]] = [rnd(dx, 1), rnd(dy, 1)];
      });
      // A grouped logo's spokes: [from store index, to store index | -1, x, y] — from that store's dot
      // to the other store's dot, or (-1) to the logo's edge at (x, y) from the logo store's location.
      const spk = {};
      items.forEach((it) => {
        if (!(it.count > 1) || !it.spokes || !it.spokes.length || idx[it.storeId] === undefined) return;
        const a = it.anchor;
        spk[idx[it.storeId]] = it.spokes.filter((s) => idx[s.storeId] !== undefined && (!s.to || idx[s.to] !== undefined))
          .map((s) => [idx[s.storeId], s.to ? idx[s.to] : -1, rnd(s.x2 - a.x, 1), rnd(s.y2 - a.y, 1)]);
      });
      const pos = stores.map((s) => {
        const it = byId[s.id];
        if (!it) return null;
        if (it.collapsed) return 0;            // no room for its logo here: the page shows its dot
        if (it.grouped) return -1;             // drawn by its group's logo: the page shows its dot only
        const a = it.anchor, q = [rnd(it.pos.x - a.x, 1), rnd(it.pos.y - a.y, 1)];
        if (it.leader) q.push(rnd(it.leader.x1 - a.x, 1), rnd(it.leader.y1 - a.y, 1), rnd(it.leader.x2 - a.x, 1), rnd(it.leader.y2 - a.y, 1));
        return q;
      });
      // Same-chain groups at this zoom: store index of the logo → indexes of its stores.
      const grp = {};
      items.forEach((it) => { if (it.count > 1) grp[idx[it.storeId]] = it.members.map((id) => idx[id]).filter((i) => i !== undefined); });
      // Too crowded for logos → the page shows brand dots at this zoom: markers overlap, (away
      // from the slide's own zoom) most markers had to move far from their store, or most logos
      // found no room at all near their store.
      const overlaps = items.stats ? items.stats.overlaps : 0;
      let far = 0, collapsed = 0, logos = 0;
      items.forEach((it) => {
        if (it.grouped) return;
        logos++;
        if (it.collapsed) collapsed++;
        else if (Math.hypot(it.pos.x - it.anchor.x, it.pos.y - it.anchor.y) > 2.6 * Math.max(it.w, it.h)) far++;
      });
      far = logos ? far / logos : 0;
      const share = logos ? collapsed / logos : 0;
      const dense = overlaps > Math.max(2, stores.length * 0.03) || (d !== 0 && far > 0.5) || share > 0.5;
      const lv = { d: d, z: rnd(z, 4), ov: overlaps, far: rnd(far, 2), dense: dense, p: pos };
      if (Object.keys(grp).length) lv.g = grp;
      if (Object.keys(fan).length) lv.f = fan;
      if (Object.keys(spk).length) lv.s = spk;
      out.push(lv);
    }
    return out;
  }

  /**
   * An analysis map's data for the page: reference (point, label, the index of the reference store
   * among the exported stores or -1, whether a pin marks it), rings (GeoJSON), the slide's ring
   * pills (lng/lat, size in CSS px = reference units at the slide's zoom), lines (store indexes),
   * every store's distance / direction / relation, the legend list, and the pictures (pin; the
   * reference store's marker with its halo — the layout gave it that larger box at every level) —
   * or, for the dot and number styles, `halo` (ring widths in CSS px) that the page draws around
   * the reference store's marker.
   */
  function analysisData(cfg, stores, style, mstyle, addImg) {
    const g = MT.layout.analysis(cfg), fa = g ? MT.analysis.forMap(cfg) : null;
    if (!g || !fa) return null;
    const th = MT.theme, idx = {};
    stores.forEach((s, i) => { idx[s.id] = i; });
    // The reference store keeps its logo (with a halo) when the slide draws it; otherwise a pin.
    const refIdx = g.ref.onSlide && idx[g.ref.storeId] !== undefined ? idx[g.ref.storeId] : -1;
    const pin = MT.markers.pinImage(MARKER_SCALE);
    let refMk = null;
    if (refIdx >= 0 && (style.kind === 'badge' || style.kind === 'card')) {
      const s = stores[refIdx], d = MT.markers.dims(s.chain, mstyle), pad = MT.layout.refHaloPad(mstyle.size);
      const it = { chainId: s.chain, w: d.w + 2 * pad, h: d.h + 2 * pad, pos: { x: 0, y: 0 }, isRef: true, refPad: pad, shape: style.kind === 'card' ? 'rect' : 'circle' };
      const pic = MT.markers.image(it, style, MARKER_SCALE);
      refMk = { i: addImg(pic.canvas.toDataURL('image/png')), w: rnd(it.w, 2), h: rnd(it.h, 2), ix: rnd(pic.x + it.w / 2, 2), iy: rnd(pic.y + it.h / 2, 2), iw: rnd(pic.w, 2), ih: rnd(pic.h, 2) };
    }
    // Dot / number styles: the reference store's marker gets the same halo rings (white gap, dark
    // ring, white casing — theme analysis.halo) as on the slide, drawn by the page as CSS rings.
    let halo = null;
    if (refIdx >= 0 && !refMk) {
      const H = th.analysis.halo || {}, k = Math.sqrt(mstyle.size || 1);
      halo = { g: rnd((H.gap || 0) * k, 2), w: rnd((H.width || 0) * k, 2), c: rnd((H.casingWidth || 0) * k, 2), color: H.color || '#1F2937', casing: H.casing || '#FFFFFF' };
    }
    const dist = {};
    fa.rows.forEach((r) => {
      const i = idx[r.store.id];
      if (i !== undefined) dist[i] = [MT.i18n.formatDistance(r.meters), r.sameChain === null ? null : r.sameChain ? 1 : 0];
    });
    const list = MT.legend.distances(cfg, stores.map((s) => ({ storeId: s.id, chainId: s.chain })));
    const R = th.analysis.ring || {}, AL = th.analysis.line || {};
    return {
      ref: { ll: [rnd(g.ref.ll[0], 6), rnd(g.ref.ll[1], 6)], label: fa.label, i: refIdx, pin: refIdx < 0 },
      pin: { i: addImg(pin.canvas.toDataURL('image/png')), dx: rnd(pin.dx, 2), dy: rnd(pin.dy, 2), w: rnd(pin.w, 2), h: rnd(pin.h, 2) },
      refMk: refMk,
      halo: halo,
      rings: roundGeo(MT.analysis.ringFeatures({ lat: g.ref.ll[1], lng: g.ref.ll[0] }, fa.rings, { steps: 128 }), 6),
      labels: g.rings.filter((r) => r.label).map((r) => ({ ll: [rnd(r.label.ll[0], 6), rnd(r.label.ll[1], 6)], text: r.label.text, w: rnd(r.label.w, 2), h: rnd(r.label.h, 2), fs: rnd(r.label.fs, 2) })),
      lines: g.lines.map((l) => idx[l.storeId]).filter((i) => i !== undefined),
      dist: dist,
      heading: list ? list.heading : '',
      top: list ? list.items.filter((x) => idx[x.storeId] !== undefined).map((x) => ({ i: idx[x.storeId], name: x.short, d: x.text })) : [],
      style: { ring: R.color, ringWidth: R.width, ringAlpha: R.alpha === undefined ? 1 : R.alpha, ringDash: R.dash || null, pill: (R.label && R.label.color) || R.color,
        line: AL.color, lineWidth: AL.width, lineAlpha: AL.alpha === undefined ? 0.5 : AL.alpha },
    };
  }

  /** The road-name lines (window.MT_ROAD_NAMES) near a map's stores and view (FeatureCollection). */
  function roadNamesNear(stores, view) {
    const rn = window.MT_ROAD_NAMES;
    if (!rn || !Array.isArray(rn.features)) return null;
    const pts = stores.map((s) => [s.lng, s.lat]).concat([view.center]);
    const b = MT.geo.bboxOfPoints(pts), m = 0.12;            // ≈ 13 km around: the ladder's zoomed-out views
    const box = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    const features = rn.features.filter((f) => f.geometry.coordinates.some((l) => l.some((q) => q[0] >= box[0] && q[0] <= box[2] && q[1] >= box[1] && q[1] <= box[3])))
      // "Av. Javier Prado Este", as on the slides (MT.layout.roadLabels).
      .map((f) => Object.assign({}, f, { properties: { name: String(f.properties.name || '').replace(/^Avenida\s+/i, 'Av. ') } }));
    return features.length ? { type: 'FeatureCollection', features: features, maxzoom: rn.maxzoom || 14 } : null;
  }

  /**
   * Everything the page needs, as plain JSON. o: {onStep(i, n, key, title), check()}.
   */
  async function buildData(maps, o) {
    o = o || {};
    const th = MT.theme, F = MT.layout.frame();
    await MT.data.ready;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const imgs = [], imgIdx = new Map();
    const addImg = (uri) => { if (!imgIdx.has(uri)) { imgIdx.set(uri, imgs.length); imgs.push(uri); } return imgIdx.get(uri); };
    const chains = {};
    const chainInfo = (id, style) => {
      const key = id;
      if (!chains[key]) {
        const c = MT.data.chain(id);
        let label = String(c.legendName || c.name || id).trim() || id;
        if (th.legend.row.uppercase !== false) label = label.toLocaleUpperCase('es');
        // color: store dots under logos · mcolor: dot/number style markers (distinct per chain) ·
        // ring: badge ring, also the dot of a logo that found no room.
        chains[key] = { name: c.name || id, label: label, color: MT.markers.chainColor(id), mcolor: MT.markers.markerColor(id), ring: MT.markers.ringColor(id), icons: {} };
      }
      // Legend icon in the map's style, plus the badge (the popups always show the logo).
      [MT.layout.styleOf(style).kind, 'badge'].forEach((kind) => {
        if (chains[key].icons[kind] !== undefined) return;
        const cv = MT.markers.icon(id, 72, { kind: kind, size: 1 });
        chains[key].icons[kind] = [addImg(cv.toDataURL('image/png')), rnd(cv.width / cv.height, 3)];
      });
      return chains[key];
    };
    const outMaps = [];
    for (let i = 0; i < maps.length; i++) {
      const cfg = maps[i];
      if (o.check) o.check();
      if (o.onStep) o.onStep(i, maps.length, 'layout', X.util.mapTitle(cfg));
      const style = MT.layout.styleOf(cfg);
      const view = MT.layout.viewFor(cfg);
      const slideItems = MT.layout.compute(cfg);
      let stores = MT.data.storesForMap(cfg).filter((s) => isFinite(s.lat) && isFinite(s.lng));
      // Dot style: the page stacks markers in this order — big chains first, rare ones on top (as
      // MT.markers.paintOrder on the slide), so a one-store chain never hides under another's dots.
      if (style.kind === 'dot') {
        const cnt = {};
        stores.forEach((s) => { cnt[s.chain] = (cnt[s.chain] || 0) + 1; });
        stores = stores.slice().sort((a, b) => cnt[b.chain] - cnt[a.chain] || (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0) || (a.id < b.id ? -1 : 1));
      }
      await MT.markers.ready(stores.map((s) => s.chain), style);

      // Numbers (style 'number'): the slide's, then the out-of-frame stores in the same order.
      const nums = {};
      if (style.kind === 'number') {
        let max = 0;
        slideItems.forEach((it) => { nums[it.storeId] = it.number; max = Math.max(max, it.number || 0); });
        const label = (id) => MT.data.chain(id).legendName || '';
        U.sortBy(stores.filter((s) => !nums[s.id]), (s) => label(s.chain) + ' ' + s.name + ' ' + s.id).forEach((s) => { nums[s.id] = ++max; });
      }

      // Marker pictures per chain (badge/card), exact MT.markers drawing incl. shadow — at the
      // slide's logo size (smaller than the map's marker size on a crowded slide: layout stats.size).
      const mk = {};
      const mstyle = { kind: style.kind, size: (slideItems.stats && slideItems.stats.size) || style.size };
      stores.forEach((s) => {
        const info = chainInfo(s.chain, style);
        if (mk[s.chain] || style.kind === 'dot' || style.kind === 'number') return;
        const d = MT.markers.dims(s.chain, mstyle);
        const pic = MT.markers.image({ chainId: s.chain, w: d.w, h: d.h, pos: { x: 0, y: 0 } }, style, MARKER_SCALE);
        // Count pip of a grouped logo (same geometry as MT.markers): centre offset, size, colours.
        const pg = MT.markers.pipGeometry(s.chain, d.w, d.h, style, 2);
        mk[s.chain] = { i: addImg(pic.canvas.toDataURL('image/png')), w: rnd(d.w, 2), h: rnd(d.h, 2),
          ix: rnd(pic.x + d.w / 2, 2), iy: rnd(pic.y + d.h / 2, 2), iw: rnd(pic.w, 2), ih: rnd(pic.h, 2),
          pip: { x: rnd(d.w / 2 + pg.dx, 2), y: rnd(d.h / 2 + pg.dy, 2), h: rnd(pg.h, 2), fs: rnd(pg.fs, 2), sw: rnd(pg.sw, 2), bg: pg.fill, fg: pg.color, line: pg.stroke } };
        void info;
      });
      if (o.check) o.check();
      const levels = await levelsFor(cfg, stores, slideItems, view, {
        check: o.check, onLevel: (f) => { if (o.onStep) o.onStep(i, maps.length, 'layout', X.util.mapTitle(cfg), 0.1 + 0.75 * f); },
      });
      await X.util.breathe();

      // Radius circles + results.
      const radius = MT.radius.compute(cfg).map((r) => {
        const c = MT.radius.colorsFor(r.chainId);
        return {
          storeId: r.storeId, chainId: r.chainId, meters: r.meters, label: MT.radius.formatMeters(r.meters), dist: MT.i18n.formatDistance(r.meters),
          stroke: c.stroke, fill: c.fill, fillOpacity: c.fillOpacity, same: r.sameChain, comp: r.competitors,
          ring: roundGeo(r.circle.geometry.coordinates[0], 6),
          inside: r.inside.slice(0, 8).map((x) => ({ name: x.store.name, chain: MT.data.chain(x.store.chain).name, same: x.sameChain, d: MT.i18n.formatDistance(x.distance) })),
          more: Math.max(0, r.inside.length - 8),
        };
      });
      const borders = cfg.showBorders && (cfg.districts || []).length && MT.data.districts.available ? roundGeo(MT.data.districts.features(cfg.districts), 5) : null;
      const rows = MT.legend.items(cfg, stores.map((s) => ({ chainId: s.chain })));
      rows.forEach((r) => chainInfo(r.chainId, style));
      // Analysis map (SPEC §6.3): reference, rings, pills, lines, distances (and the reference
      // store's own marker picture, with its halo).
      const analysis = cfg.analysis ? analysisData(cfg, stores, style, mstyle, addImg) : null;
      if (analysis) analysis.top.forEach((x) => chainInfo(stores[x.i].chain, style));
      const sizeK = style.size;
      outMaps.push({
        id: cfg.id, title: X.util.mapTitle(cfg), hasTitle: !!String(cfg.title || '').trim(),
        sub: MT.data.subtitleFor(cfg) || '', peso: String(cfg.peso || '').trim(),
        kind: style.kind, view: { center: [rnd(view.center[0], 7), rnd(view.center[1], 7)], zoomRef: rnd(view.zoomRef, 5) },
        stores: stores.map((s) => ({
          id: s.id, chain: s.chain, name: s.name || '', address: s.address || '', district: s.district || '', province: s.province || '', department: s.department || '',
          lat: rnd(s.lat, 6), lng: rnd(s.lng, 6), status: s.status || '', precision: s.precision || '', num: nums[s.id] || null,
        })),
        levels: levels, mk: mk, radius: radius, borders: borders, analysis: analysis,
        // The selected districts' names the app writes (MT.mapview 'mt-district-labels').
        labels: roundGeo(MT.mapview.basemap.districtLabelData(cfg), 6),
        // Main avenue names below zoom 14 (data/road-names.js) around the exported stores.
        roads: roadNamesNear(stores, view), roadsCovered: MT.mapview.basemap.roadNamesCover(view),
        rows: rows.map((r) => ({ chainId: r.chainId, text: r.text, label: r.label, count: r.count })),
        showCount: th.legend.showCount !== false,
        anchor: { r: rnd(MT.markers.anchorRadius(style), 2), sw: rnd(th.marker.anchorDot.strokeWidth * Math.sqrt(sizeK), 2) },
        dot: { d: rnd(2 * th.marker.dot.radius * sizeK, 2), sw: rnd(th.marker.dot.strokeWidth * sizeK, 2) },
        num: { d: rnd(th.marker.number.diameter * sizeK, 2), fs: rnd(th.marker.number.fontSize * sizeK, 2), sw: rnd(th.marker.number.strokeWidth * sizeK, 2) },
      });
      if (o.onStep) o.onStep(i, maps.length, 'markers', X.util.mapTitle(cfg));
    }
    const g = th.panel.gradient;
    return {
      v: 1, app: 'Mapa de Tiendas', generated: U.todayISO(), generatedLabel: MT.i18n.formatDate(new Date(), { dateStyle: 'long' }),
      lang: MT.i18n.lang, strings: pageStrings(), mapLocale: MT.i18n.mapLocale(),
      style: th.basemap.style, spanishTextField: th.basemap.spanishTextField, attribution: th.attribution.text,
      frame: { w: F.width, h: rnd(F.height, 3) },
      theme: {
        from: g.from, to: g.to, angle: g.angleDeg, panelW: th.panel.w, panelH: th.panel.h, circles: th.panel.circles,
        leftArea: th.slide.leftArea.color, title: th.title.color, sub: th.subtitle.color, pesoLabel: th.subtitle.pesoLabel || 'Peso:',
        pesoLabelColor: th.subtitle.pesoLabelColor, peso: th.subtitle.peso.color, heading: th.legend.heading.text,
        borders: th.borders, radiusWidth: th.radius.width, radiusDash: th.radius.dash, leader: th.marker.leader,
        spoke: th.marker.spoke || null, footnote: (th.legend.footnote && th.legend.footnote.grouped) || '',
        pipPrefix: (th.marker.countPip && th.marker.countPip.prefix) || '×',
        districtLabel: th.basemap.districtLabel || null, majorRoadNames: th.basemap.majorRoadNames || null,
        mainRoads: th.basemap.mainRoads || null, shieldMinzoom: th.basemap.shieldMinzoom || null,
        placeLabelLayers: MT.mapview.basemap.PLACE_LABEL_LAYERS,
        anchorStroke: th.marker.anchorDot.stroke, dotStroke: th.marker.dot.stroke, numStroke: th.marker.number.stroke, numColor: th.marker.number.color,
        frameBg: th.mapFrame.background, fontSlide: th.fonts.slideCss,
        // Analysis maps: rings and lines (reference units = CSS px at the slide's zoom).
        anaRing: (th.analysis && th.analysis.ring) || null, anaLine: (th.analysis && th.analysis.line) || null,
      },
      img: imgs, chains: chains, maps: outMaps,
    };
  }

  /* ---- The page ------------------------------------------------------------------------------------- */
  const PAGE_CSS = `
:root { --from: #D42A4C; --to: #8E1631; --peso: #1F3864; --bg: #F3F4F6; --ink: #111827; --muted: #6B7280; --panel-w: 340px; --ease: cubic-bezier(.2,.7,.2,1); }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--ink); font-family: var(--font, Calibri, Carlito, 'Segoe UI', system-ui, sans-serif); -webkit-font-smoothing: antialiased; overflow: hidden; }
button { font: inherit; color: inherit; }
.app { display: grid; grid-template-columns: minmax(0, 1fr) var(--panel-w); height: 100vh; height: 100dvh; }
.stage { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 12px; min-width: 0; min-height: 0; padding: 14px 20px 20px; }
.hd { text-align: center; min-width: 0; }
.hd__title { margin: 0; font-size: clamp(21px, 2.3vw, 31px); font-weight: 700; line-height: 1.15; letter-spacing: -0.005em; overflow-wrap: anywhere; }
.hd__sub { margin: 3px 0 0; font-size: clamp(13px, 1.08vw, 16px); line-height: 1.35; color: var(--muted); }
.hd__sub .gap { display: inline-block; width: .6em; }
.hd__peso { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1.5px; }
.tabs { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
.tab { height: 30px; padding: 0 14px; border: 1px solid #D4D4D8; border-radius: 999px; background: #fff; color: #3F3F46; font-size: 13.5px; font-weight: 700; cursor: pointer; transition: background .15s var(--ease), color .15s var(--ease), border-color .15s var(--ease); }
.tab:hover { border-color: #A1A1AA; }
.tab[aria-selected="true"] { background: var(--to); border-color: var(--to); color: #fff; }
.mapwrap { position: relative; min-height: 0; overflow: hidden; border-radius: 3px; background: var(--frame-bg, #EEF0F2); box-shadow: 0 1px 2px rgba(17,24,39,.06), 0 10px 30px -14px rgba(17,24,39,.28); }
#map { position: absolute; inset: 0; }
.notice { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: min(420px, 86%); padding: 14px 18px; border-radius: 10px; background: rgba(255,255,255,.96); box-shadow: 0 8px 30px -10px rgba(17,24,39,.35); color: #3F3F46; font-size: 15px; line-height: 1.45; text-align: center; z-index: 5; }
.hint { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px; background: rgba(24,24,27,.82); color: #fff; font-size: 13px; font-weight: 700; pointer-events: none; z-index: 4; opacity: 0; transition: opacity .2s var(--ease); white-space: nowrap; }
.hint.is-on { opacity: 1; }
/* Legend panel: the slide's crimson panel */
.panel { position: relative; overflow: hidden; color: #fff; background: linear-gradient(var(--angle, 160deg), var(--from) 0%, var(--to) 100%); }
.panel__circles { position: absolute; inset: 0; pointer-events: none; }
.panel__circles span { position: absolute; border-radius: 50%; }
.panel__inner { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 30px 24px 18px; }
.panel__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 0 8px; }
.panel__title { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: .005em; }
.panel__meta { display: inline-flex; align-items: center; gap: 8px; }
.panel__total { font-size: 14px; font-weight: 700; opacity: .78; white-space: nowrap; }
.panel__close { display: none; }
.rows { list-style: none; margin: 14px 0 0; padding: 0 0 4px; overflow: auto; min-height: 0; flex: 1 1 auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.35) transparent; }
.row { margin: 0; }
.row__btn { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 6px 8px; border: 0; border-radius: 9px; background: none; text-align: left; cursor: pointer; transition: background .15s var(--ease); }
.row__btn:hover { background: rgba(255,255,255,.10); }
.row__btn:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.row__icon { flex: none; display: grid; place-items: center; width: 52px; height: 32px; }
.row__icon img { display: block; max-width: 52px; height: 30px; width: auto; filter: drop-shadow(0 1px 1px rgba(0,0,0,.18)); transition: filter .2s var(--ease), opacity .2s var(--ease); }
.row__label { flex: 1; min-width: 0; font-size: 17px; font-weight: 700; letter-spacing: .01em; line-height: 1.2; overflow-wrap: anywhere; transition: opacity .2s var(--ease); }
.row__sw { position: relative; flex: none; width: 32px; height: 18px; border-radius: 999px; background: rgba(255,255,255,.26); transition: background .2s var(--ease); }
.row__sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .2s var(--ease), background .2s var(--ease); }
.row__btn[aria-pressed="true"] .row__sw { background: #fff; }
.row__btn[aria-pressed="true"] .row__sw::after { transform: translateX(14px); background: var(--to); }
.row__btn[aria-pressed="false"] .row__label { opacity: .5; }
.row__btn[aria-pressed="false"] .row__icon img { opacity: .55; filter: grayscale(1); }
.panel__note { margin: 8px 0 0; padding: 0 8px; font-size: 12.5px; line-height: 1.4; opacity: .88; }
.panel__actions { display: flex; gap: 8px; margin-top: 12px; padding: 0 8px; }
.panel__actions button { flex: 1; height: 34px; border: 1px solid rgba(255,255,255,.5); border-radius: 8px; background: transparent; font-size: 13.5px; font-weight: 700; cursor: pointer; transition: background .15s var(--ease); }
.panel__actions button:hover { background: rgba(255,255,255,.12); }
.panel__actions button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.panel__foot { margin-top: 14px; padding: 0 8px; font-size: 11.5px; line-height: 1.45; opacity: .74; }
.sheet-toggle { display: none; }
/* Map overlay: leaders, markers, store dots, radius pills */
.ov { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }
.ov__svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }
.ov__layer { position: absolute; left: 0; top: 0; }
.mk { position: absolute; left: 0; top: 0; display: block; padding: 0; margin: 0; border: 0; background: none; cursor: pointer; pointer-events: auto; will-change: transform; -webkit-tap-highlight-color: transparent; }
.mk[hidden], .dt[hidden], .rl[hidden] { display: none; }
.mk img { position: absolute; display: block; max-width: none; pointer-events: none; transition: transform .14s var(--ease); }
.mk--badge, .mk--pin, .mk--dot { border-radius: 50%; }
.mk--card { border-radius: 6px; }
.mk--ref { z-index: 1; }
.mk:hover, .mk:focus-visible, .mk.is-active { z-index: 2; }
.mk:hover img, .mk.is-active img, .mk:focus-visible img { transform: scale(1.08); }
.mk:focus-visible { outline: 2.5px solid var(--to); outline-offset: 2px; }
.mk--pin { display: grid; place-items: center; font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 700; line-height: 1; border-style: solid; box-shadow: 0 1px 4px rgba(17,24,39,.3); transition: transform .14s var(--ease); }
.mk--pin:hover, .mk--pin.is-active { transform-origin: center; }
.mk--dot { border-style: solid; box-shadow: 0 1px 3px rgba(17,24,39,.3); }
.pip { position: absolute; transform: translate(-50%, -50%); box-sizing: border-box; display: block; border-style: solid; border-radius: 999px; font-family: Calibri, Carlito, 'Segoe UI', system-ui, sans-serif; font-weight: 700; text-align: center; white-space: nowrap; pointer-events: none; box-shadow: 0 0.5px 2px rgba(17,24,39,.3); transition: transform .14s var(--ease); }
.pip[hidden] { display: none; }
.dt { position: absolute; left: 0; top: 0; border-radius: 50%; border-style: solid; pointer-events: none; }
.ov.is-dots .mk--badge, .ov.is-dots .mk--card, .ov.is-dots .mk--pin, .ov.is-dots .ov__svg { display: none; }
.ov.is-dots .dt, .dt.is-solo { pointer-events: auto; cursor: pointer; box-shadow: 0 1px 3px rgba(17,24,39,.3); }
.dt.is-solo:focus-visible, .ov.is-dots .dt:focus-visible { outline: 2.5px solid var(--to); outline-offset: 2px; }
.row__btn.is-zero .row__label { opacity: .62; }
.rl { position: absolute; left: 0; top: 0; padding: 1px 8px; border: 1.5px solid; border-radius: 999px; background: rgba(255,255,255,.94); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 11.5px; font-weight: 700; white-space: nowrap; pointer-events: none; }
/* Analysis maps: the reference pin, the rings' pills (.rl), the nearest-stores list */
.apin { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 3; pointer-events: none; }
.apin img { position: absolute; display: block; max-width: none; pointer-events: auto; cursor: help; }
.dist { flex: 0 1 auto; display: flex; flex-direction: column; min-height: 0; margin: 12px 0 0; padding: 12px 8px 0; border-top: 1px solid rgba(255,255,255,.28); }
.dist[hidden] { display: none; }
.dist__title { margin: 0 0 6px; font-size: 15px; font-weight: 700; line-height: 1.25; }
.dist__list { list-style: none; margin: 0; padding: 0; max-height: 34vh; overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.35) transparent; }
.dist__row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 32px; padding: 3px 6px; border: 0; border-radius: 7px; background: none; text-align: left; cursor: pointer; font-size: 14px; line-height: 1.2; }
.dist__row:hover { background: rgba(255,255,255,.10); }
.dist__row:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.dist__row img { flex: none; height: 22px; width: auto; max-width: 44px; }
.dist__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dist__d { flex: none; font-weight: 700; opacity: .92; }
.pop__dist { margin-top: 8px; font-size: 13.5px; font-weight: 700; color: var(--peso); }
/* Popups */
.maplibregl-popup.pop .maplibregl-popup-content { padding: 13px 15px 12px; border-radius: 11px; box-shadow: 0 14px 34px -10px rgba(17,24,39,.42), 0 2px 6px rgba(17,24,39,.08); font-family: var(--font, Calibri, Carlito, 'Segoe UI', system-ui, sans-serif); color: var(--ink); min-width: 220px; }
.maplibregl-popup.pop .maplibregl-popup-close-button { width: 28px; height: 28px; font-size: 20px; color: #71717A; border-radius: 8px; right: 3px; top: 3px; }
.maplibregl-popup.pop .maplibregl-popup-close-button:hover { background: #F4F4F5; color: #18181B; }
.pop__chain { display: flex; align-items: center; gap: 8px; padding-right: 22px; font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #52525B; }
.pop__chain img { height: 22px; width: auto; }
.pop__name { margin-top: 6px; font-size: 17px; font-weight: 700; line-height: 1.25; }
.pop__addr { margin-top: 3px; font-size: 14px; color: #3F3F46; line-height: 1.35; }
.pop__place { margin-top: 1px; font-size: 13px; color: var(--muted); }
.pop__tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.tag { padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #F4F4F5; color: #52525B; }
.tag--warn { background: #FDF4E7; color: #B45309; }
.pop__radius { margin-top: 10px; padding-top: 9px; border-top: 1px solid #E4E4E7; }
.pop__group { margin-top: 10px; padding-top: 9px; border-top: 1px solid #E4E4E7; }
.pop__rt { font-size: 13px; font-weight: 700; }
.pop__rs { font-size: 13px; color: #52525B; margin-top: 1px; }
.pop__rl { list-style: none; margin: 6px 0 0; padding: 0 2px 0 0; font-size: 13px; max-height: 128px; overflow: auto; scrollbar-width: thin; }
.pop__rl li { display: flex; gap: 8px; justify-content: space-between; padding: 2px 0; }
.pop__rl li span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop__rl li span:last-child { flex: none; color: #71717A; font-variant-numeric: tabular-nums; }
.pop__rl .is-same span:first-child { font-weight: 700; }
.pop__more { font-size: 12.5px; color: #71717A; margin-top: 2px; }
.pop__link { display: inline-flex; margin-top: 10px; font-size: 13.5px; font-weight: 700; color: var(--to); text-decoration: none; }
.pop__link:hover { text-decoration: underline; }
.pop__link:focus-visible { outline: 2px solid var(--to); outline-offset: 2px; border-radius: 4px; }
.maplibregl-ctrl-attrib { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 11px; }
.ctrl-reset svg { display: block; margin: auto; }
@media (max-width: 820px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .stage { padding: 10px 10px 10px; gap: 8px; }
  .hd__title { font-size: 21px; }
  .panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; max-height: 72vh; border-radius: 16px 16px 0 0; transform: translateY(110%); transition: transform .28s var(--ease); box-shadow: 0 -12px 40px -10px rgba(17,24,39,.45); }
  .panel.is-open { transform: none; }
  .panel__inner { padding: 18px 14px 14px; max-height: 72vh; }
  .panel__close { display: grid; place-items: center; width: 32px; height: 32px; margin-left: 4px; border: 0; border-radius: 8px; background: rgba(255,255,255,.14); cursor: pointer; font-size: 18px; }
  .sheet-toggle { display: inline-flex; align-items: center; gap: 8px; position: absolute; left: 10px; bottom: 30px; z-index: 6; height: 38px; padding: 0 14px; border: 0; border-radius: 999px; background: linear-gradient(160deg, var(--from), var(--to)); color: #fff; font-size: 14px; font-weight: 700; box-shadow: 0 6px 18px -6px rgba(142,22,49,.6); cursor: pointer; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

  /* The page script (runs inside the exported file — must stay self-contained: no MT, no closures). */
  function pageMain() {
    'use strict';
    var D = JSON.parse(document.getElementById('mt-data').textContent);
    var S = D.strings || {};
    var TH = D.theme;
    function t(k, v) {
      var s = S[k];
      if (s === undefined || s === null) return k;
      if (typeof s === 'object') s = v && +v.n === 1 ? s.one : s.other;
      return String(s).replace(/\{(\w+)\}/g, function (m, x) { return v && v[x] !== undefined && v[x] !== null ? String(v[x]) : m; });
    }
    function h(tag, attrs) {
      var el = document.createElement(tag), k, i;
      if (attrs) for (k in attrs) {
        var val = attrs[k];
        if (val === null || val === undefined || val === false) continue;
        if (k === 'class') el.className = val;
        else if (k === 'text') el.textContent = val;
        else if (k === 'style') { for (var sk in val) el.style[sk] = val[sk]; }
        else if (k.indexOf('on') === 0 && typeof val === 'function') el.addEventListener(k.slice(2), val);
        else el.setAttribute(k, val === true ? '' : String(val));
      }
      for (i = 2; i < arguments.length; i++) {
        var c = arguments[i];
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
        else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return el;
    }
    var SVGNS = 'http://www.w3.org/2000/svg';
    function svg(tag, attrs) { var el = document.createElementNS(SVGNS, tag); for (var k in attrs) el.setAttribute(k, attrs[k]); return el; }

    document.documentElement.lang = S.lang || 'es';
    var rs = document.documentElement.style;
    rs.setProperty('--from', TH.from); rs.setProperty('--to', TH.to); rs.setProperty('--angle', TH.angle + 'deg');
    rs.setProperty('--peso', TH.peso); rs.setProperty('--bg', TH.leftArea); rs.setProperty('--muted', TH.sub);
    rs.setProperty('--frame-bg', TH.frameBg); rs.setProperty('--font', TH.fontSlide); rs.setProperty('--ink', TH.title);

    var state = { idx: 0, hidden: {}, popup: null, activeEl: null, levelKey: null, dots: false, styleOk: false, failed: false };
    var app = document.getElementById('app');

    /* ---- Static layout ---- */
    var titleEl = h('h1', { class: 'hd__title' }), subEl = h('p', { class: 'hd__sub' });
    var tabs = D.maps.length > 1 ? h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('maps') }) : null;
    var mapEl = h('div', { id: 'map', role: 'region' });
    var hint = h('div', { class: 'hint', 'aria-hidden': 'true' }, t('zoomIn'));
    var notice = h('div', { class: 'notice', hidden: true, role: 'status' });
    var sheetBtn = h('button', { class: 'sheet-toggle', type: 'button', 'aria-expanded': 'false' });
    var mapWrap = h('div', { class: 'mapwrap' }, mapEl, hint, notice, sheetBtn);
    var stage = h('main', { class: 'stage' }, h('header', { class: 'hd' }, titleEl, subEl, tabs), mapWrap);
    var circles = h('div', { class: 'panel__circles', 'aria-hidden': 'true' });
    var totalEl = h('span', { class: 'panel__total' });
    var rowsEl = h('ul', { class: 'rows', role: 'list' });
    // Key for grouped logos ("×N = N tiendas cercanas · • = ubicación exacta"), as on the slide.
    var noteEl = h('p', { class: 'panel__note', hidden: true });
    // Analysis maps: "Distancias a <referencia>" — the nearest stores (click: their popup).
    var distEl = h('div', { class: 'dist', hidden: true });
    var closeBtn = h('button', { class: 'panel__close', type: 'button', 'aria-label': t('close'), title: t('close') }, '×');
    var headEl = h('h2', { class: 'panel__title' }, TH.heading);
    var panel = h('aside', { class: 'panel', 'aria-label': t('legend') },
      circles,
      h('div', { class: 'panel__inner' },
        h('div', { class: 'panel__head' }, headEl, h('span', { class: 'panel__meta' }, totalEl, closeBtn)),
        rowsEl,
        noteEl,
        distEl,
        h('div', { class: 'panel__actions' },
          h('button', { type: 'button', onclick: function () { setAll(true); } }, t('showAll')),
          h('button', { type: 'button', onclick: function () { setAll(false); } }, t('hideAll'))),
        h('div', { class: 'panel__foot' }, t('generated', { date: D.generatedLabel }), h('br'), t('sources'), h('br'), D.attribution)));
    app.appendChild(stage); app.appendChild(panel);
    function openSheet(on) { panel.classList.toggle('is-open', on); sheetBtn.setAttribute('aria-expanded', on ? 'true' : 'false'); }
    sheetBtn.addEventListener('click', function () { openSheet(!panel.classList.contains('is-open')); });
    closeBtn.addEventListener('click', function () { openSheet(false); });

    function paintCircles() {
      while (circles.firstChild) circles.removeChild(circles.firstChild);
      var pw = panel.clientWidth || 340, ph = panel.clientHeight || 700;
      var k = pw / TH.panelW, ky = ph / TH.panelH;
      TH.circles.forEach(function (c) {
        var r = c.r * k;
        circles.appendChild(h('span', { style: { left: (c.cx * k - r) + 'px', top: (c.cy * ky - r) + 'px', width: 2 * r + 'px', height: 2 * r + 'px', background: 'rgba(255,255,255,' + c.alpha + ')' } }));
      });
    }

    function cur() { return D.maps[state.idx]; }
    function chain(id) { return D.chains[id] || { name: id, label: id, color: '#6B7280', ring: '#6B7280', icons: {} }; }
    function iconOf(id, kind) { var c = chain(id), ic = c.icons[kind] || c.icons.badge; return ic ? D.img[ic[0]] : ''; }

    /* ---- Header + legend ---- */
    function renderChrome() {
      var m = cur();
      document.title = m.title + ' · ' + D.app;
      titleEl.textContent = m.title;
      while (subEl.firstChild) subEl.removeChild(subEl.firstChild);
      if (m.sub) subEl.appendChild(document.createTextNode(m.sub));
      if (m.peso) {
        if (m.sub) subEl.appendChild(h('span', { class: 'gap' }));
        subEl.appendChild(h('span', { style: { color: TH.pesoLabelColor } }, TH.pesoLabel + ' '));
        subEl.appendChild(h('span', { class: 'hd__peso', style: { color: TH.peso } }, m.peso));
      }
      subEl.hidden = !m.sub && !m.peso;
      if (tabs) {
        while (tabs.firstChild) tabs.removeChild(tabs.firstChild);
        D.maps.forEach(function (mm, i) {
          tabs.appendChild(h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': i === state.idx ? 'true' : 'false',
            onclick: function () { if (i !== state.idx) selectMap(i); } }, mm.title));
        });
      }
      mapEl.setAttribute('aria-label', m.title);
      while (rowsEl.firstChild) rowsEl.removeChild(rowsEl.firstChild);
      state.rowLabels = {};
      m.rows.forEach(function (r) {
        var on = !state.hidden[r.chainId];
        var src = iconOf(r.chainId, m.kind);
        var lbl = h('span', { class: 'row__label' }, r.text);
        state.rowLabels[r.chainId] = lbl;
        var btn = h('button', { class: 'row__btn', type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-chain': r.chainId,
          title: t('toggleChain', { name: chain(r.chainId).name }),
          onclick: function () { toggle(r.chainId); } },
          h('span', { class: 'row__icon' }, src ? h('img', { src: src, alt: '' }) : null),
          lbl,
          h('span', { class: 'row__sw', 'aria-hidden': 'true' }));
        rowsEl.appendChild(h('li', { class: 'row' }, btn));
      });
      var grouped = m.levels.some(function (lv) { return !!lv.g; });
      noteEl.textContent = grouped && TH.footnote ? TH.footnote : '';
      noteEl.hidden = !(grouped && TH.footnote);
      while (distEl.firstChild) distEl.removeChild(distEl.firstChild);
      var A = m.analysis;
      distEl.hidden = !(A && A.top.length);
      if (A && A.top.length) {
        distEl.appendChild(h('h3', { class: 'dist__title' }, A.heading));
        var ul = h('ul', { class: 'dist__list', 'aria-label': t('distList') });
        A.top.forEach(function (x) {
          var s = m.stores[x.i], src = iconOf(s.chain, m.kind);
          ul.appendChild(h('li', null, h('button', { class: 'dist__row', type: 'button', title: s.name, onclick: function () { if (map && ov.items[x.i]) openPopup(ov.items[x.i]); } },
            src ? h('img', { src: src, alt: '' }) : null, h('span', { class: 'dist__name' }, x.name), h('span', { class: 'dist__d' }, x.d))));
        });
        distEl.appendChild(ul);
      }
      recount();
      showNotice(state.failed ? t('noMap') : (!m.stores.length ? t('noStores') : ''));
    }
    function showNotice(text) { notice.textContent = text || ''; notice.hidden = !text; }
    /**
     * Legend counts and the total cover the stores IN VIEW (as on the slide, whose legend counts
     * what the frame shows): recounted after every move. Before the map exists: all stores.
     */
    function recount() {
      var m = cur(), b = map && map.getBounds ? map.getBounds() : null, by = {}, total = 0;
      m.stores.forEach(function (s) {
        if (b && !b.contains([s.lng, s.lat])) return;
        by[s.chain] = (by[s.chain] || 0) + 1;
        if (!state.hidden[s.chain]) total++;
      });
      m.rows.forEach(function (r) {
        var el = state.rowLabels && state.rowLabels[r.chainId];
        if (!el) return;
        var n = by[r.chainId] || 0;
        el.textContent = m.showCount && r.label ? r.label + ' (' + n + ')' : r.text;
        el.parentNode.classList.toggle('is-zero', n === 0);
      });
      totalEl.textContent = t('stores', { n: total });
      sheetBtn.textContent = TH.heading + ' · ' + total;
    }

    function toggle(id) { state.hidden[id] = !state.hidden[id]; applyVisibility(); }
    function setAll(on) { cur().rows.forEach(function (r) { state.hidden[r.chainId] = !on; }); applyVisibility(); }
    function applyVisibility() {
      Array.prototype.forEach.call(rowsEl.querySelectorAll('.row__btn'), function (b) { b.setAttribute('aria-pressed', state.hidden[b.getAttribute('data-chain')] ? 'false' : 'true'); });
      ov.items.forEach(function (it) {
        var off = !!state.hidden[it.s.chain];
        it.off = off;
        if (it.mk) it.mk.hidden = off;
        it.dt.hidden = off;
        if (it.ln) it.ln.style.display = off ? 'none' : '';
        if (it.hl) it.hl.style.display = off ? 'none' : '';
      });
      ov.labels.forEach(function (l) { l.el.hidden = !!state.hidden[l.r.chainId]; });
      if (state.popup && state.popupChain && state.hidden[state.popupChain]) state.popup.remove();
      if (map && state.styleOk) setRadiusFilter();
      place();
      recount();
    }

    /* ---- Map ---- */
    var map = null;
    var ov = { root: null, svg: null, marks: null, dots: null, labels: [], items: [], level: null };

    /** Zoom ladder steps with a clean (overlap-free) layout. */
    function cleanZooms(m) { return m.levels.filter(function (lv) { return !lv.dense; }).map(function (lv) { return lv.z; }); }
    /* Web Mercator in MapLibre's 512-px world (no map needed). */
    function wpx(ll, z) {
      var s = 512 * Math.pow(2, z), la = Math.max(-85.05, Math.min(85.05, ll[1])) * Math.PI / 180;
      return [(ll[0] + 180) / 360 * s, (1 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / Math.PI) / 2 * s];
    }
    function wll(p, z) {
      var s = 512 * Math.pow(2, z), n = Math.PI - 2 * Math.PI * p[1] / s;
      return [p[0] / s * 360 - 180, 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
    }
    function markerSize(m, s) {
      if (m.kind === 'badge' || m.kind === 'card') { var g = m.mk[s.chain]; return g ? [g.w, g.h] : [0, 0]; }
      return m.kind === 'number' ? [m.num.d, m.num.d] : [m.dot.d, m.dot.d];
    }
    /**
     * Opening view: the slide's frame, zoomed out just enough to fit the window, on a clean ladder
     * step — and then out further (and re-centred) until every marker of the slide's stores is
     * inside the window: at a step below the slide's zoom the declutter may have put a marker a
     * little outside the frame, which a laptop-sized window would cut off.
     */
    function initialView(m) {
      var cw = mapEl.clientWidth || 1000, ch = mapEl.clientHeight || 800;
      var k = Math.min(cw / D.frame.w, ch / D.frame.h);
      var zFit = m.view.zoomRef + Math.min(0, Math.log2(k * 0.985));
      var levels = m.levels.filter(function (lv) { return !lv.dense && lv.z <= zFit + 0.001; });
      if (!levels.length) return { center: m.view.center, zoom: zFit };
      // The slide's stores: inside the frame at the slide's zoom.
      var c0 = wpx(m.view.center, m.view.zoomRef), inFrame = [];
      m.stores.forEach(function (s, i) {
        var p = wpx([s.lng, s.lat], m.view.zoomRef);
        if (Math.abs(p[0] - c0[0]) <= D.frame.w / 2 && Math.abs(p[1] - c0[1]) <= D.frame.h / 2) inFrame.push(i);
      });
      var pad = 8, last = null;
      for (var L = levels.length - 1; L >= 0; L--) {
        var lv = levels[L], z = lv.z, c = wpx(m.view.center, z), f = Math.pow(2, z - m.view.zoomRef);
        var b = [c[0] - D.frame.w / 2 * f, c[1] - D.frame.h / 2 * f, c[0] + D.frame.w / 2 * f, c[1] + D.frame.h / 2 * f];
        inFrame.forEach(function (i) {
          var s = m.stores[i], p = wpx([s.lng, s.lat], z), o = lv.p[i], sz = markerSize(m, s);
          b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
          if (o && o.length) {
            b[0] = Math.min(b[0], p[0] + o[0] - sz[0] / 2); b[2] = Math.max(b[2], p[0] + o[0] + sz[0] / 2);
            b[1] = Math.min(b[1], p[1] + o[1] - sz[1] / 2); b[3] = Math.max(b[3], p[1] + o[1] + sz[1] / 2);
          }
        });
        last = { center: wll([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], z), zoom: z };
        if (b[2] - b[0] + 2 * pad <= cw && b[3] - b[1] + 2 * pad <= ch) return last;
      }
      return last;
    }
    /** After a zoom gesture: settle on the nearest ladder step (inside the ladder's range only). */
    function snap() {
      if (!map || state.snapping) { state.snapping = false; return; }
      var zs = cleanZooms(cur());
      if (!zs.length) return;
      var z = map.getZoom();
      if (z < zs[0] - 0.01 || z > zs[zs.length - 1] + 0.01) return;
      var best = zs.reduce(function (b, s) { return Math.abs(s - z) < Math.abs(b - z) ? s : b; }, zs[0]);
      if (Math.abs(best - z) < 0.002) return;
      state.snapping = true;
      map.easeTo({ zoom: best, duration: 160 });
    }
    function fit() { if (map) map.jumpTo(initialView(cur())); }

    if (!window.maplibregl) {
      state.failed = true;
      renderChrome();
      paintCircles();
      return;
    }

    var iv0 = initialView(cur());
    map = new maplibregl.Map({
      container: mapEl, style: D.style, center: iv0.center, zoom: iv0.zoom,
      attributionControl: { compact: false }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      maxPitch: 0, renderWorldCopies: false, fadeDuration: 150, cooperativeGestures: false,
      locale: D.mapLocale || {},
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl({
      onAdd: function () {
        var b = h('button', { type: 'button', class: 'ctrl-reset', title: t('resetView'), 'aria-label': t('resetView'), onclick: fit });
        b.appendChild(svg('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: '#333', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        b.firstChild.appendChild(svg('path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }));
        this._c = h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' }, b);
        return this._c;
      },
      onRemove: function () { this._c.remove(); },
    }, 'top-right');

    // Positron tuned like the app (MT.mapview.basemap.patch): Spanish names, readable district labels.
    function patchStyle() {
      (map.getStyle().layers || []).forEach(function (l) {
        if (l['source-layer'] === 'poi') { map.setLayoutProperty(l.id, 'visibility', 'none'); return; }
        if (l.type !== 'symbol') return;
        var tf = map.getLayoutProperty(l.id, 'text-field');
        if (tf && JSON.stringify(tf).indexOf('name_en') >= 0) map.setLayoutProperty(l.id, 'text-field', D.spanishTextField);
      });
      function set(id, kind, prop, value) { if (map.getLayer(id)) { try { map[kind](id, prop, value); } catch (e) { /* layer differs */ } } }
      var dl = TH.districtLabel || {};
      set('label_other', 'setLayoutProperty', 'text-size', dl.size ? curve(dl.size) : ['interpolate', ['linear'], ['zoom'], 8, 10, 12, 12.5, 15, 14]);
      set('label_other', 'setPaintProperty', 'text-color', dl.color || '#3F3F46');
      set('label_other', 'setLayoutProperty', 'text-letter-spacing', dl.letterSpacing === undefined ? 0.06 : dl.letterSpacing);
      set('label_town', 'setPaintProperty', 'text-color', '#18181B');
      set('label_village', 'setPaintProperty', 'text-color', '#27272A');
      set('highway-name-major', 'setPaintProperty', 'text-color', '#52525B');
      set('highway-name-minor', 'setPaintProperty', 'text-color', '#71717A');
      set('water', 'setPaintProperty', 'fill-color', '#CBD7DF');
      set('waterway', 'setPaintProperty', 'line-color', '#BCCAD3');
      set('park', 'setPaintProperty', 'fill-color', '#E1E8DE');
      // The main road network in a faint warm tone, route shields from a lower zoom (as the slides).
      var rd = TH.mainRoads;
      if (rd) {
        var main = function (warm, other) { return ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], warm, other]; };
        ['highway_motorway_inner', 'highway_motorway_bridge_inner', 'tunnel_motorway_inner'].forEach(function (id) { set(id, 'setPaintProperty', 'line-color', rd.fill); });
        ['highway_motorway_casing', 'highway_motorway_bridge_casing', 'tunnel_motorway_casing'].forEach(function (id) { set(id, 'setPaintProperty', 'line-color', rd.casing); });
        set('highway_major_inner', 'setPaintProperty', 'line-color', main(rd.fill, '#FFFFFF'));
        set('highway_major_casing', 'setPaintProperty', 'line-color', main(rd.casing, 'rgb(213, 213, 213)'));
        set('highway_major_subtle', 'setPaintProperty', 'line-color', main(rd.subtle || rd.casing, 'hsla(0,0%,85%,0.69)'));
      }
      var shield = (map.getStyle().layers || []).filter(function (l) { return l.id === 'highway-shield-non-us'; })[0];
      if (TH.shieldMinzoom && shield && TH.shieldMinzoom < (shield.minzoom || 11) && !map.getLayer('mt-highway-shield-main')) {
        try {
          var sc = JSON.parse(JSON.stringify(shield)), sids = map.getStyle().layers.map(function (l) { return l.id; });
          sc.id = 'mt-highway-shield-main'; sc.minzoom = TH.shieldMinzoom; sc.maxzoom = shield.minzoom || 11;
          sc.filter = ['all', shield.filter, ['match', ['get', 'class'], ['motorway', 'trunk'], true, false]];
          sc.layout = sc.layout || {}; sc.layout['symbol-placement'] = 'point';
          map.addLayer(sc, sids[sids.indexOf(shield.id) + 1]);
        } catch (e) { /* positron's own shields only */ }
      }
      // Main avenues named from a lower zoom (as the slides: MT.mapview.basemap.patch).
      var mr = TH.majorRoadNames, major = (map.getStyle().layers || []).filter(function (l) { return l.id === 'highway-name-major'; })[0];
      if (mr && major && !map.getLayer('mt-highway-name-main')) {
        try {
          var copy = JSON.parse(JSON.stringify(major)), ids = map.getStyle().layers.map(function (l) { return l.id; });
          copy.id = 'mt-highway-name-main'; copy.minzoom = mr.minzoom;
          copy.filter = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false];
          if (mr.size) { copy.layout = copy.layout || {}; copy.layout['text-size'] = curve(mr.size); }
          map.addLayer(copy, ids[ids.indexOf(major.id) + 1]);
          map.setFilter(major.id, ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false]);
          // Main avenue names below zoom 14 (as the slides: data/road-names.js), fed per map.
          map.addSource('mt-road-names', { type: 'geojson', data: EMPTY });
          var rl = JSON.parse(JSON.stringify(copy));
          rl.id = 'mt-road-names'; rl.source = 'mt-road-names'; delete rl['source-layer']; delete rl.filter; rl.maxzoom = 14;
          rl.layout['text-field'] = ['get', 'name'];
          map.addLayer(rl, ids[ids.indexOf(major.id) + 1]);
        } catch (e) { /* keep the default road names */ }
      }
    }
    function curve(stops) { var e = ['interpolate', ['linear'], ['zoom']]; stops.forEach(function (st) { e.push(st[0], st[1]); }); return e; }
    var EMPTY = { type: 'FeatureCollection', features: [] };
    function addLayers() {
      var before = ((map.getStyle().layers || []).filter(function (l) { return l.type === 'symbol'; })[0] || {}).id;
      var b = TH.borders;
      map.addSource('mt-borders', { type: 'geojson', data: EMPTY });
      map.addSource('mt-radius', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'mt-borders-fill', type: 'fill', source: 'mt-borders', paint: { 'fill-color': b.fill || 'rgba(0,0,0,0)' } }, before);
      var lp = { 'line-color': b.color, 'line-width': b.width, 'line-opacity': b.alpha };
      if (b.dash) lp['line-dasharray'] = b.dash.map(function (d) { return d / b.width; });
      map.addLayer({ id: 'mt-borders-line', type: 'line', source: 'mt-borders', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: lp }, before);
      if (map.getSource('openmaptiles') && map.getLayer('water')) {
        map.addLayer({ id: 'mt-ocean', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'ocean'],
          layout: { visibility: 'none' }, paint: { 'fill-color': map.getPaintProperty('water', 'fill-color') || '#CBD7DF', 'fill-antialias': false } }, before);
      }
      map.addLayer({ id: 'mt-radius-fill', type: 'fill', source: 'mt-radius', paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] } }, before);
      map.addLayer({ id: 'mt-radius-line', type: 'line', source: 'mt-radius', layout: { 'line-join': 'round' },
        paint: { 'line-color': ['get', 'stroke'], 'line-width': TH.radiusWidth, 'line-dasharray': (TH.radiusDash || [1, 0]).map(function (d) { return d / TH.radiusWidth; }) } }, before);
      // Analysis maps: the distance rings around the reference (thin, dashed), as on the slide.
      var ar = TH.anaRing;
      if (ar) {
        map.addSource('mt-analysis', { type: 'geojson', data: EMPTY });
        var ap = { 'line-color': ar.color, 'line-width': ar.width, 'line-opacity': ar.alpha === undefined ? 1 : ar.alpha };
        if (ar.dash) ap['line-dasharray'] = ar.dash.map(function (d) { return d / ar.width; });
        map.addLayer({ id: 'mt-analysis-rings', type: 'line', source: 'mt-analysis', layout: { 'line-join': 'round' }, paint: ap }, before);
      }
      // The selected districts' names the basemap does not write (as on the slides), on top.
      var dl = TH.districtLabel || {};
      var lo = function (prop, fb) { try { var v = map.getLayer('label_other') ? map.getLayoutProperty('label_other', prop) : undefined; return v === undefined ? fb : v; } catch (e) { return fb; } };
      map.addSource('mt-district-labels', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'mt-district-labels', type: 'symbol', source: 'mt-district-labels', minzoom: 8, filter: ['==', ['get', 'k'], 'suburb'],
        layout: { 'text-field': ['get', 'name'], 'text-font': lo('text-font', ['Noto Sans Italic']), 'text-size': dl.size ? curve(dl.size) : 12, 'text-transform': 'uppercase',
          'text-letter-spacing': dl.letterSpacing === undefined ? 0.06 : dl.letterSpacing, 'text-max-width': lo('text-max-width', 9), 'text-allow-overlap': true, 'text-padding': 1 },
        paint: { 'text-color': dl.color || '#3F3F46', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1, 'text-halo-blur': 1 } });
      // Selected districts that are a city / town / village: the basemap's own look for that class.
      [['city', 'label_city'], ['town', 'label_town'], ['village', 'label_village']].forEach(function (x) {
        var base = (map.getStyle().layers || []).filter(function (l) { return l.id === x[1]; })[0];
        if (!base) return;
        var lay = JSON.parse(JSON.stringify(base));
        lay.id = 'mt-district-labels-' + x[0]; lay.source = 'mt-district-labels'; delete lay['source-layer'];
        lay.filter = ['==', ['get', 'k'], x[0]];
        lay.layout = lay.layout || {};
        ['icon-image', 'icon-size', 'icon-allow-overlap', 'icon-optional', 'icon-ignore-placement'].forEach(function (p) { delete lay.layout[p]; });
        lay.layout['text-field'] = ['get', 'name']; lay.layout['text-allow-overlap'] = true;
        try { map.addLayer(lay); } catch (e) { /* that look: none */ }
      });
    }
    /** The app's district names for the current map; the basemap's own labels of those names hidden. */
    function setDistrictLabels(m) {
      var data = m.labels || EMPTY;
      if (map.getSource('mt-district-labels')) map.getSource('mt-district-labels').setData(data);
      var names = (data.features || []).map(function (f) { return String(f.properties.name).toLowerCase(); }), base = D.spanishTextField;
      var tf = names.length ? ['case', ['in', ['downcase', ['to-string', base]], ['literal', names]], '', base] : base;
      (TH.placeLabelLayers || []).forEach(function (id) { if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'text-field', tf); } catch (e) { /* layer differs */ } } });
    }
    function setMapData() {
      var m = cur();
      setDistrictLabels(m);
      // Main avenue names: the app's lines below zoom 14 where it has them, the tiles' names from there.
      if (map.getSource('mt-road-names')) {
        map.getSource('mt-road-names').setData(m.roads || EMPTY);
        var mr = TH.majorRoadNames, cov = !!(m.roads && m.roadsCovered);
        if (map.getLayer('mt-highway-name-main') && mr) map.setLayerZoomRange('mt-highway-name-main', cov ? (m.roads.maxzoom || 14) : mr.minzoom, 24);
      }
      map.getSource('mt-borders').setData(m.borders || EMPTY);
      if (map.getLayer('mt-ocean')) map.setLayoutProperty('mt-ocean', 'visibility', m.borders ? 'visible' : 'none');
      map.getSource('mt-radius').setData({ type: 'FeatureCollection', features: m.radius.map(function (r) {
        return { type: 'Feature', properties: { chainId: r.chainId, stroke: r.stroke, fill: r.fill, fillOpacity: r.fillOpacity }, geometry: { type: 'Polygon', coordinates: [r.ring] } };
      }) });
      if (map.getSource('mt-analysis')) map.getSource('mt-analysis').setData(m.analysis ? m.analysis.rings : EMPTY);
      setRadiusFilter();
    }
    function setRadiusFilter() {
      var visible = cur().rows.map(function (r) { return r.chainId; }).filter(function (id) { return !state.hidden[id]; });
      var f = ['in', ['get', 'chainId'], ['literal', visible]];
      map.setFilter('mt-radius-fill', f); map.setFilter('mt-radius-line', f);
    }
    map.on('style.load', function () {
      state.styleOk = true;
      try { patchStyle(); } catch (e) { /* keep the default look */ }
      try { addLayers(); setMapData(); } catch (e) { console.warn('[mapa] layers', e); }
    });
    map.on('error', function () { if (!state.styleOk && !state.failed) { state.failed = true; showNotice(t('noMap')); } });

    /* ---- Overlay: leaders (SVG) · markers (buttons) · store dots · radius pills ---- */
    function buildOverlay() {
      if (ov.root) ov.root.remove();
      var m = cur();
      ov.root = h('div', { class: 'ov' });
      ov.svg = svg('svg', { class: 'ov__svg', 'aria-hidden': 'true' });
      // Analysis lines (reference → nearest store of each chain), group spokes, then leader halos
      // (white casing) under all the leaders.
      ov.ga = svg('g', {}); ov.gs = svg('g', {}); ov.gh = svg('g', {}); ov.gl = svg('g', {});
      ov.svg.appendChild(ov.ga); ov.svg.appendChild(ov.gs); ov.svg.appendChild(ov.gh); ov.svg.appendChild(ov.gl);
      ov.spokes = [];
      ov.marks = h('div', { class: 'ov__layer' });
      ov.dots = h('div', { class: 'ov__layer' });
      ov.lbl = h('div', { class: 'ov__layer', 'aria-hidden': 'true' });
      ov.root.appendChild(ov.svg); ov.root.appendChild(ov.lbl); ov.root.appendChild(ov.marks); ov.root.appendChild(ov.dots);
      map.getCanvasContainer().appendChild(ov.root);
      var L = TH.leader;
      ov.items = m.stores.map(function (s, i) {
        var c = chain(s.chain), it = { s: s, i: i, off: false, ll: [s.lng, s.lat] };
        var label = t('storeOf', { store: s.name, chain: c.name });
        var open = function (ev) { ev.stopPropagation(); openPopup(it); };
        if (m.kind === 'badge' || m.kind === 'card') {
          // The analysis' reference store: its own picture, with the halo.
          var isRef = !!(m.analysis && m.analysis.refMk && m.analysis.ref.i === i);
          var g = isRef ? m.analysis.refMk : m.mk[s.chain];
          if (isRef) label = t('refTitle', { name: label });
          if (g) {
            it.w = g.w; it.h = g.h;
            it.label = label;
            it.mk = h('button', { class: 'mk mk--' + m.kind, type: 'button', 'aria-label': label, title: label, style: { width: g.w + 'px', height: g.h + 'px' }, onclick: open },
              h('img', { src: D.img[g.i], alt: '', style: { left: g.ix + 'px', top: g.iy + 'px', width: g.iw + 'px', height: g.ih + 'px' } }));
            // Count pip of a grouped logo ("×4"), shown by place() at the zooms where it groups.
            if (g.pip && !isRef) {
              var pp = g.pip;
              it.pip = h('span', { class: 'pip', hidden: true, 'aria-hidden': 'true', style: { left: pp.x + 'px', top: pp.y + 'px', height: pp.h + 'px', minWidth: pp.h + 'px',
                padding: '0 ' + (pp.h * 0.27) + 'px', lineHeight: (pp.h - 2 * pp.sw) + 'px', fontSize: pp.fs + 'px', borderWidth: pp.sw + 'px', borderColor: pp.line, background: pp.bg, color: pp.fg } });
              it.mk.appendChild(it.pip);
            }
          }
        } else if (m.kind === 'number') {
          var n = m.num, mc = c.mcolor || c.color, light = lum(mc) > 0.55;
          it.w = it.h = n.d;
          it.mk = h('button', { class: 'mk mk--pin', type: 'button', 'aria-label': (s.num || '') + ' · ' + label, title: label, onclick: open,
            style: { width: n.d + 'px', height: n.d + 'px', background: mc, borderColor: TH.numStroke, borderWidth: n.sw + 'px', color: light ? '#111827' : TH.numColor, fontSize: (String(s.num).length >= 3 ? n.fs * 0.78 : n.fs) + 'px' } }, String(s.num || ''));
        } else {
          var dd = m.dot;
          it.w = it.h = dd.d;
          it.mk = h('button', { class: 'mk mk--dot', type: 'button', 'aria-label': label, title: label, onclick: open,
            style: { width: dd.d + 'px', height: dd.d + 'px', background: c.mcolor || c.color, borderColor: TH.dotStroke, borderWidth: dd.sw + 'px' } });
        }
        // Dot / number styles: the analysis' reference store is ringed by its halo (as on the slide).
        var AH = m.analysis && m.analysis.halo;
        if (AH && it.mk && m.analysis.ref.i === i) {
          var refLabel = t('refTitle', { name: label });
          it.mk.classList.add('mk--ref');
          it.mk.setAttribute('aria-label', (m.kind === 'number' ? (s.num || '') + ' · ' : '') + refLabel);
          it.mk.title = refLabel;
          it.mk.style.boxShadow = '0 0 0 ' + AH.g + 'px ' + AH.casing + ', 0 0 0 ' + (AH.g + AH.w) + 'px ' + AH.color + ', 0 0 0 ' + (AH.g + AH.w + AH.c) + 'px ' + AH.casing + ', 0 1px 4px ' + (AH.g + AH.w + AH.c) + 'px rgba(17,24,39,.3)';
        }
        if (it.mk) ov.marks.appendChild(it.mk);
        if (m.kind !== 'dot') {
          it.ln = svg('line', { stroke: L.color, 'stroke-width': L.width, 'stroke-opacity': L.alpha, 'stroke-linecap': 'round' });
          ov.gl.appendChild(it.ln);
          if (L.halo && L.halo.width > 0) {
            it.hl = svg('line', { stroke: L.halo.color, 'stroke-width': L.halo.width, 'stroke-opacity': L.halo.alpha === undefined ? 1 : L.halo.alpha, 'stroke-linecap': 'round' });
            ov.gh.appendChild(it.hl);
          }
        }
        var a = m.anchor;
        it.dotColor = m.kind === 'number' ? (c.mcolor || c.color) : c.color;
        it.dt = h('span', { class: 'dt', title: label, style: { width: 2 * a.r + 'px', height: 2 * a.r + 'px', background: it.dotColor, borderColor: TH.anchorStroke, borderWidth: a.sw + 'px', margin: (-a.r) + 'px 0 0 ' + (-a.r) + 'px' } });
        it.dt.addEventListener('click', open);
        if (m.kind !== 'dot') ov.dots.appendChild(it.dt); else it.dt.hidden = true;
        return it;
      });
      ov.labels = m.radius.map(function (r) {
        var el = h('span', { class: 'rl', style: { color: r.stroke, borderColor: r.stroke } }, r.label);
        ov.lbl.appendChild(el);
        // North edge of the circle (max latitude of the ring).
        var top = r.ring.reduce(function (b, p) { return p[1] > b[1] ? p : b; }, r.ring[0]);
        return { el: el, r: r, ll: top };
      });
      // Analysis map: lines to the nearest store of each chain, the rings' pills, the reference pin.
      var A = m.analysis;
      ov.alines = []; ov.apills = []; ov.apin = null;
      if (A) {
        var AL = TH.anaLine || {}, AR = TH.anaRing || {};
        if (AL.width > 0) {
          ov.alines = A.lines.map(function (i) {
            var ln = svg('line', { stroke: AL.color, 'stroke-width': AL.width, 'stroke-opacity': AL.alpha === undefined ? 0.5 : AL.alpha, 'stroke-linecap': 'round' });
            ov.ga.appendChild(ln);
            return { i: i, el: ln };
          });
        }
        var pc = (AR.label && AR.label.color) || AR.color;
        ov.apills = A.labels.map(function (l) {
          var el = h('span', { class: 'rl', style: { color: pc, borderColor: AR.color, fontFamily: TH.fontSlide, fontSize: l.fs + 'px', padding: '0 ' + (l.fs * 0.45) + 'px',
            height: l.h + 'px', lineHeight: (l.h - 3) + 'px', borderWidth: Math.max(0.8, (AR.width || 1.6) * 0.6) + 'px', boxSizing: 'border-box' } }, l.text);
          ov.lbl.appendChild(el);
          return { el: el, ll: l.ll };
        });
        if (A.ref.pin) {
          var P = A.pin, nm = t('refTitle', { name: A.ref.label });
          ov.apin = h('div', { class: 'apin' }, h('img', { src: D.img[P.i], alt: nm, title: nm, style: { left: P.dx + 'px', top: P.dy + 'px', width: P.w + 'px', height: P.h + 'px' } }));
          ov.root.appendChild(ov.apin);
        }
      }
      ov.level = null; state.levelKey = null;
      applyVisibility();
    }
    function lum(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.5;
      var n = parseInt(m[1], 16);
      var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }

    /** Pick the declutter level for the current zoom (or dots when too crowded). */
    function relevel() {
      var m = cur(), z = map.getZoom(), lv = null;
      for (var i = 0; i < m.levels.length; i++) if (m.levels[i].z <= z + 0.001) lv = m.levels[i];
      var dots = m.kind !== 'dot' && (!lv || lv.dense);
      var key = (lv ? lv.z : 'none') + '|' + dots;
      if (key === state.levelKey) return;
      state.levelKey = key; ov.level = dots ? null : lv; state.dots = dots;
      ov.root.classList.toggle('is-dots', dots);
      hint.classList.toggle('is-on', dots && m.stores.length > 0);
      ov.items.forEach(function (it) {
        if (it.mk) it.mk.tabIndex = dots ? -1 : 0;
        it.dt.tabIndex = dots ? 0 : -1;
        if (dots) { it.dt.setAttribute('role', 'button'); it.dt.setAttribute('aria-label', it.mk ? it.mk.getAttribute('aria-label') : ''); }
        else { it.dt.removeAttribute('role'); it.dt.removeAttribute('aria-label'); }
        var big = dots ? Math.max(11, m.anchor.r * 2.6) : 2 * m.anchor.r;
        it.solo = false; it.dt.classList.remove('is-solo');
        it.dt.style.width = it.dt.style.height = big + 'px';
        it.dt.style.margin = (-big / 2) + 'px 0 0 ' + (-big / 2) + 'px';
        it.dt.style.borderWidth = (dots ? Math.max(1.5, m.anchor.sw) : m.anchor.sw) + 'px';
        it.dt.style.background = dots && m.kind !== 'number' ? chain(it.s.chain).ring : it.dotColor;
      });
    }
    var raf = 0;
    function place() {
      if (!map || !ov.root) return;
      relevel();
      var lv = ov.level;
      // Where a store's dot is drawn: its location, spread off a neighbour's at this level.
      var dotAt = function (i) {
        var p = map.project(ov.items[i].ll), f = lv && lv.f ? lv.f[i] : null;
        return f && !state.dots ? { x: p.x + f[0], y: p.y + f[1] } : p;
      };
      ov.items.forEach(function (it) {
        if (it.off) return;
        var p = map.project(it.ll), dp = dotAt(it.i);
        it.dt.style.transform = 'translate(' + dp.x + 'px,' + dp.y + 'px)';
        if (!it.mk) return;
        var o = lv ? lv.p[it.i] : null;
        if (cur().kind === 'dot') o = [0, 0];
        // 0 = no room for this logo at this zoom: its store dot stands in (ring colour, clickable).
        // -1 = its chain's group logo nearby stands for it: just its store dot.
        solo(it, o === 0);
        if (!o || o === -1) { it.mk.style.visibility = 'hidden'; if (it.ln) it.ln.style.display = 'none'; if (it.hl) it.hl.style.display = 'none'; return; }
        it.mk.style.visibility = '';
        var grp = lv && lv.g ? lv.g[it.i] : null;
        if (it.pip) {
          it.pip.hidden = !grp;
          if (grp) it.pip.textContent = TH.pipPrefix + grp.length;
        }
        if (it.label) {
          var lab = grp ? it.label + ' — ' + t('group', { n: grp.length, chain: chain(it.s.chain).name, count: grp.length }) : it.label;
          if (it.mk.getAttribute('aria-label') !== lab) { it.mk.setAttribute('aria-label', lab); it.mk.title = lab; }
        }
        var x = p.x + o[0] - it.w / 2, y = p.y + o[1] - it.h / 2;
        it.mk.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        [it.hl, it.ln].forEach(function (ln) {
          if (!ln) return;
          if (o.length > 2) {
            ln.style.display = '';
            ln.setAttribute('x1', p.x + o[2]); ln.setAttribute('y1', p.y + o[3]);
            ln.setAttribute('x2', p.x + o[4]); ln.setAttribute('y2', p.y + o[5]);
          } else ln.style.display = 'none';
        });
      });
      // Spokes of the grouped logos at this level: faint lines in the chain's ring colour from each
      // store's dot to its logo (or to a neighbouring store of the group), as on the slide.
      var used = 0, SP = TH.spoke;
      if (lv && lv.s && SP && SP.width > 0 && !state.dots) {
        Object.keys(lv.s).forEach(function (k) {
          var rep = ov.items[+k], o = rep ? lv.p[rep.i] : null;
          if (!rep || rep.off || !rep.mk || !o || o === -1 || o === 0) return;
          var p = map.project(rep.ll), col = chain(rep.s.chain).ring;
          lv.s[k].forEach(function (q) {
            var a = dotAt(q[0]), b = q[1] >= 0 ? dotAt(q[1]) : { x: p.x + q[2], y: p.y + q[3] };
            var ln = ov.spokes[used];
            if (!ln) { ln = ov.spokes[used] = svg('line', { 'stroke-linecap': 'round' }); ov.gs.appendChild(ln); }
            ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y); ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
            ln.setAttribute('stroke', col); ln.setAttribute('stroke-width', SP.width); ln.setAttribute('stroke-opacity', SP.alpha === undefined ? 0.5 : SP.alpha);
            ln.style.display = '';
            used++;
          });
        });
      }
      for (var u = used; u < ov.spokes.length; u++) ov.spokes[u].style.display = 'none';
      ov.labels.forEach(function (l) {
        var p = map.project(l.ll);
        l.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px) translate(-50%, -50%)';
      });
      // Analysis map: lines from the reference (its store's dot, or the point) to the stores' dots.
      var A = cur().analysis;
      if (A) {
        var ri = A.ref.i, rit = ri >= 0 ? ov.items[ri] : null;
        var from = rit && !rit.off ? dotAt(ri) : map.project(A.ref.ll);
        ov.alines.forEach(function (l) {
          var it = ov.items[l.i];
          if (!it || it.off) { l.el.style.display = 'none'; return; }
          var d = dotAt(l.i);
          l.el.style.display = '';
          l.el.setAttribute('x1', from.x); l.el.setAttribute('y1', from.y); l.el.setAttribute('x2', d.x); l.el.setAttribute('y2', d.y);
        });
        ov.apills.forEach(function (l) {
          var q = map.project(l.ll);
          l.el.style.transform = 'translate(' + q.x + 'px,' + q.y + 'px) translate(-50%, -50%)';
        });
        if (ov.apin) { var pp = map.project(A.ref.ll); ov.apin.style.transform = 'translate(' + pp.x + 'px,' + pp.y + 'px)'; }
      }
    }
    function solo(it, on) {
      if (!!it.solo === on || state.dots) return;
      it.solo = on;
      var m = cur(), r = on ? Math.max(5, m.anchor.r * 1.7) : m.anchor.r;
      it.dt.classList.toggle('is-solo', on);
      it.dt.style.width = it.dt.style.height = 2 * r + 'px';
      it.dt.style.margin = (-r) + 'px 0 0 ' + (-r) + 'px';
      it.dt.style.background = on ? chain(it.s.chain).ring : it.dotColor;
      it.dt.tabIndex = on ? 0 : -1;
      if (on) { it.dt.setAttribute('role', 'button'); it.dt.setAttribute('aria-label', it.mk ? it.mk.getAttribute('aria-label') : ''); }
      else { it.dt.removeAttribute('role'); it.dt.removeAttribute('aria-label'); }
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; place(); }); }
    map.on('move', place);
    map.on('resize', schedule);
    // The header (title, subtitle, tabs) can change height after the map exists (another tab's
    // longer title, fonts loading): keep the map's canvas the size of its box, or everything drawn
    // over it would be offset.
    if (window.ResizeObserver) new ResizeObserver(function () { map.resize(); }).observe(mapEl);
    map.on('zoomend', snap);
    map.on('moveend', recount);

    /* ---- Popups ---- */
    function openPopup(it) {
      var s = it.s, c = chain(s.chain), m = cur();
      if (state.popup) state.popup.remove();
      var tags = [];
      if (s.status === 'to_verify') tags.push(h('span', { class: 'tag tag--warn' }, t('toVerify')));
      if (s.precision === 'approx') tags.push(h('span', { class: 'tag' }, t('approx')));
      var place2 = [s.district, s.province, s.department].filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' · ');
      var content = h('div', { class: 'pop__body' },
        h('div', { class: 'pop__chain' }, iconOf(s.chain, 'badge') ? h('img', { src: iconOf(s.chain, m.kind === 'card' ? 'card' : 'badge'), alt: '' }) : null, c.name),
        h('div', { class: 'pop__name' }, (s.num ? s.num + '. ' : '') + s.name),
        s.address ? h('div', { class: 'pop__addr' }, s.address) : null,
        place2 ? h('div', { class: 'pop__place' }, place2) : null,
        tags.length ? h('div', { class: 'pop__tags' }, tags) : null);
      // Analysis map: the store's distance to the reference (or: this is the reference).
      var A = m.analysis;
      if (A) {
        var dd = A.dist[it.i];
        if (A.ref.i === it.i) content.appendChild(h('div', { class: 'pop__dist' }, t('reference')));
        else if (dd) content.appendChild(h('div', { class: 'pop__dist' }, t('distanceTo', { d: dd[0], ref: A.ref.label }) + (dd[1] === null ? '' : ' · ' + t(dd[1] ? 'sameChain' : 'competitor'))));
      }
      // A grouped logo: the other stores it stands for at this zoom.
      var grp = ov.level && !state.dots && ov.level.g ? ov.level.g[it.i] : null;
      if (grp && grp.length > 1) {
        content.appendChild(h('div', { class: 'pop__group' },
          h('div', { class: 'pop__rs' }, t('group', { n: grp.length, chain: c.name })),
          h('ul', { class: 'pop__rl' }, grp.filter(function (i) { return i !== it.i; }).map(function (i) { return h('li', null, h('span', null, m.stores[i].name)); }))));
      }
      m.radius.filter(function (r) { return r.storeId === s.id; }).forEach(function (r) {
        var box = h('div', { class: 'pop__radius' },
          h('div', { class: 'pop__rt', style: { color: r.stroke } }, t('radius', { r: r.dist })),
          h('div', { class: 'pop__rs' }, r.same + r.comp ? t('radiusSummary', { same: r.same, comp: r.comp }) : t('radiusNone')));
        if (r.inside.length) {
          box.appendChild(h('ul', { class: 'pop__rl' }, r.inside.map(function (x) {
            return h('li', { class: x.same ? 'is-same' : '' }, h('span', null, x.name + ' · ' + x.chain), h('span', null, x.d));
          })));
          if (r.more) box.appendChild(h('div', { class: 'pop__more' }, t('radiusMore', { n: r.more })));
        }
        content.appendChild(box);
      });
      content.appendChild(h('a', { class: 'pop__link', href: 'https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lng, target: '_blank', rel: 'noopener' }, t('openGoogle') + ' ↗'));
      var lv = ov.level, o = lv && it.mk && !state.dots ? lv.p[it.i] : null;
      var offset = o ? [o[0], o[1] - it.h / 2 - 4] : [0, -8];
      if (m.kind === 'dot') offset = [0, -it.h / 2 - 2];
      state.popup = new maplibregl.Popup({ className: 'pop', maxWidth: '330px', offset: offset, focusAfterOpen: true, closeButton: true })
        .setLngLat(it.ll).setDOMContent(content).addTo(map);
      state.popupChain = s.chain;
      if (state.activeEl) state.activeEl.classList.remove('is-active');
      state.activeEl = it.mk || null;
      if (state.activeEl) state.activeEl.classList.add('is-active');
      var p = state.popup;
      // Pan just enough for the whole popup to be visible inside the map.
      requestAnimationFrame(function () {
        var el = p.getElement && p.getElement();
        if (!el || state.popup !== p) return;
        var r = el.getBoundingClientRect(), mr = mapEl.getBoundingClientRect(), pad = 12, dx = 0, dy = 0;
        if (r.bottom > mr.bottom - pad) dy = r.bottom - mr.bottom + pad;
        if (r.top - dy < mr.top + pad) dy = r.top - mr.top - pad;
        if (r.right > mr.right - pad) dx = r.right - mr.right + pad;
        if (r.left - dx < mr.left + pad) dx = r.left - mr.left - pad;
        if (dx || dy) map.panBy([dx, dy], { duration: 220 });
      });
      p.on('close', function () {
        if (state.popup === p) state.popup = null;
        if (state.activeEl && state.popup === null) { state.activeEl.classList.remove('is-active'); state.activeEl = null; }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (state.popup) state.popup.remove(); else openSheet(false); }
    });

    function selectMap(i) {
      state.idx = i;
      if (state.popup) state.popup.remove();
      state.hidden = {};
      renderChrome();
      if (state.styleOk) setMapData();
      buildOverlay();
      fit();
      place();
    }

    renderChrome();
    paintCircles();
    buildOverlay();
    place();
    map.on('load', function () { fit(); place(); });
    window.addEventListener('resize', function () { paintCircles(); schedule(); });
    window.__mtPage = { map: map, state: state, overlay: ov, data: D, selectMap: selectMap, toggle: toggle, setAll: setAll, openPopup: function (i) { openPopup(ov.items[i]); } };
  }

  /** Loader: MapLibre from the pinned CDNs (SRI), first one that answers; then pageMain. */
  function loaderMain(cdn) {
    var done = false;
    function boot() { if (done) return; done = true; window.__mtBoot(); }
    function css(i) {
      if (i >= cdn.css.length) return;
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = cdn.css[i]; l.integrity = cdn.cssSri; l.crossOrigin = 'anonymous';
      l.onerror = function () { l.remove(); css(i + 1); };
      document.head.appendChild(l);
    }
    function js(i) {
      if (i >= cdn.js.length) { boot(); return; }
      var s = document.createElement('script');
      s.src = cdn.js[i]; s.integrity = cdn.jsSri; s.crossOrigin = 'anonymous';
      s.onload = boot;
      s.onerror = function () { s.remove(); js(i + 1); };
      document.head.appendChild(s);
    }
    css(0); js(0);
  }

  /** The complete standalone HTML text for page data D. */
  function page(D) {
    const LT = String.fromCharCode(92) + 'u003c';      // "<" inside JSON → < (no "</script>" breakout)
    const json = JSON.stringify(D).replace(/</g, LT);
    const title = MT.util.escapeHtml(D.maps.length === 1 ? D.maps[0].title : D.maps.map((m) => m.title).join(' · '));
    const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23B3203D'/%3E%3Cpath d='M16 25s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z' fill='%23fff'/%3E%3Ccircle cx='16' cy='15' r='2.2' fill='%23B3203D'/%3E%3C/svg%3E";
    const cdnJson = JSON.stringify({ js: CDN.js, css: CDN.css, jsSri: CDN.jsSri, cssSri: CDN.cssSri });
    return '<!doctype html>\n<html lang="' + MT.util.escapeHtml(D.strings.lang || 'es') + '">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + title + '</title>\n'
      + '<meta name="generator" content="Mapa de Tiendas ' + MT.util.escapeHtml(MT.version || '') + ' (' + D.generated + ')">\n'
      + '<link rel="icon" href="' + icon + '">\n'
      + '<style>' + PAGE_CSS + '</style>\n</head>\n<body>\n'
      + '<div id="app" class="app"></div>\n'
      + '<noscript>Este mapa necesita JavaScript.</noscript>\n'
      + '<script type="application/json" id="mt-data">' + json + '</script>\n'
      + '<script>\nwindow.__mtBoot = function () {\n(' + pageMain.toString() + ')();\n};\n(' + loaderMain.toString() + ')(' + cdnJson + ');\n</script>\n'
      + '</body>\n</html>\n';
  }

  /* ---- Public: MT.export.html --------------------------------------------------------------------- */
  async function html(mapIds, opts) {
    const XU = X.util;
    opts = XU.optsWithDefaults(opts);
    let maps;
    try { maps = XU.resolveMaps(mapIds); } catch (e) { return XU.fail(XU.job({}), opts, e); }
    const j = XU.job({ ui: opts.ui, signal: opts.signal, onProgress: opts.onProgress, titleKey: 'export.busy.html' });
    try {
      await XU.breathe();
      const D = await buildData(maps, {
        check: () => j.check(),
        onStep: (i, n, key, title, frac) => j.step(i, n, frac !== undefined ? frac : key === 'layout' ? 0.1 : 0.9, key, { title: title }),
      });
      j.check();
      j.progress(0.96, MT.t('export.step.packing'));
      const text = page(D);
      const blob = new Blob([text], { type: 'text/html;charset=utf-8' });
      const res = await XU.deliver([{ name: XU.names.html(maps), blob: blob }], { download: opts.download, ui: opts.ui });
      res.file = res.files[0];
      j.progress(1);
      return XU.finish(j, opts, 'html', res);
    } catch (err) { return XU.fail(j, opts, err); }
  }
  html.data = buildData;
  html.page = page;
  html.CDN = CDN;
  X.html = html;
})();
