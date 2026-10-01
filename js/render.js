/* js/render.js — MT.render: high-resolution offscreen rendering for the exports. Module M1.
 *
 * WYSIWYG: the export map is the preview map at a higher pixel ratio — same basemap CSS width
 * (MT.layout.BASEMAP_WIDTH), same view, same style patches and layers (MT.mapview.basemap), and the
 * overlay (radius labels, leaders, dots, markers, attribution) is painted by drawOverlay, the very
 * function the live preview uses.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.1, TECH-NOTES §2):
 *   mapCanvas(mapCfg, {scale=3, markers=true, overlays=true, attribution=true})
 *       → Promise<{canvas, layout, frame:{width, height, scale}, view}>
 *     canvas = 1000·scale × refHeight·scale px. overlays:false → basemap only (+ attribution unless
 *     attribution:false); markers:false → borders/radius/labels/attribution but no leaders, dots or
 *     markers (the PPTX places those as separate pictures/shapes from `layout`). The layout's
 *     markers, dots and leaders block the basemap's labels (MT.mapview.basemap blockers) once the
 *     view's labels are known — of opts.blockersFor (default mapCfg); markerBlockers:false → never.
 *   slideCanvas(mapCfg, {width=3840}) → Promise<HTMLCanvasElement>  the complete 16:9 slide.
 * Extras: drawOverlay(ctx, mapCfg, items, scale, opts), drawAttribution(ctx, scale, opts),
 *   drawSlide(ctx, mapCfg, W, mapImage, layout) (slide without the map → canvas), queue-serialized.
 * Errors reject with err.code 'basemap-unavailable' | 'basemap-timeout' and err.messageKey
 * ('map.error.<code>') for a translated message.
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;

  /* ---- Overlay compositor (preview + exports) ------------------------------------------------- */
  function drawAttribution(ctx, scale, opts) {
    const a = MT.theme.attribution, box = MT.layout.attributionBox();
    ctx.save();
    if (opts && (opts.offsetX || opts.offsetY)) ctx.translate(opts.offsetX || 0, opts.offsetY || 0);
    ctx.scale(scale, scale);
    const r = Math.min(4, box.h / 2);
    ctx.beginPath();
    if (a.position === 'bottom-left') {
      ctx.moveTo(box.x, box.y); ctx.lineTo(box.x + box.w - r, box.y); ctx.arcTo(box.x + box.w, box.y, box.x + box.w, box.y + r, r);
      ctx.lineTo(box.x + box.w, box.y + box.h); ctx.lineTo(box.x, box.y + box.h);
    } else {
      ctx.moveTo(box.x + r, box.y); ctx.lineTo(box.x + box.w, box.y); ctx.lineTo(box.x + box.w, box.y + box.h);
      ctx.lineTo(box.x, box.y + box.h); ctx.lineTo(box.x, box.y + r); ctx.arcTo(box.x, box.y, box.x + r, box.y, r);
    }
    ctx.closePath();
    ctx.fillStyle = a.background; ctx.fill();
    ctx.font = box.font; ctx.fillStyle = a.color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(box.text, box.x + box.w / 2, box.y + box.h / 2 + box.fontPx * 0.06);
    ctx.restore();
  }

  /**
   * Everything drawn over the basemap, in reference units × scale: radius labels, leaders, anchor
   * dots, markers, attribution. opts: {highlight, radiusLabels, view, markers=true, attribution=true,
   * offsetX, offsetY}.
   */
  function drawOverlay(ctx, mapCfg, items, scale, opts) {
    opts = opts || {};
    if (!mapCfg) return;
    let labels = opts.radiusLabels;
    if (!labels && mapCfg.radius && mapCfg.radius.length) {
      labels = MT.radius.labels(MT.radius.compute(mapCfg), MT.layout.projector(opts.view || MT.layout.viewFor(mapCfg)));
    }
    MT.radius.drawLabels(ctx, labels, scale, opts);
    if (opts.markers !== false && items && items.length) {
      MT.markers.drawAll(ctx, items, MT.layout.styleOf(mapCfg), scale, { highlight: opts.highlight, offsetX: opts.offsetX, offsetY: opts.offsetY });
    }
    if (opts.attribution !== false) drawAttribution(ctx, scale, opts);
  }

  /* ---- Offscreen basemap ------------------------------------------------------------------------- */
  // One offscreen map at a time (WebGL contexts are limited; exports of whole projects queue here).
  let queue = Promise.resolve();
  function serial(job) {
    const p = queue.then(job, job);
    queue = p.catch(() => undefined);
    return p;
  }
  function fail(code, cause) {
    const e = new Error(code);
    e.code = code; e.messageKey = 'map.error.' + ({ 'basemap-unavailable': 'unavailable', 'basemap-timeout': 'timeout', 'webgl-unavailable': 'webgl' }[code] || 'unavailable');
    if (cause) e.cause = cause;
    return e;
  }

  let webglOk = null;
  /** Can this browser create a WebGL context at all? (cached) */
  function webglAvailable() {
    if (webglOk === null) {
      try { const c = document.createElement('canvas'); webglOk = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { webglOk = false; }
    }
    return webglOk;
  }

  /** Render the basemap (with borders/radius layers unless overlays:false) into a W×H 2D canvas. */
  function renderBasemap(mapCfg, view, W, H, opts) {
    const bw = MT.layout.BASEMAP_WIDTH, bh = Math.round(bw / MT.theme.frame.aspect);
    const container = U.h('div', { class: 'mt-render-stage', 'aria-hidden': 'true', style: {
      position: 'fixed', left: '-30000px', top: '0', width: bw + 'px', height: bh + 'px', pointerEvents: 'none' } });
    document.body.appendChild(container);
    let map;
    try {
      map = new maplibregl.Map({
        container: container, style: MT.theme.basemap.style,
        center: view.center, zoom: MT.layout.basemapZoom(view),
        pixelRatio: W / bw, interactive: false, fadeDuration: 0, attributionControl: false,
        renderWorldCopies: false, trackResize: false,
        maxCanvasSize: [8192, 8192],
        canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      });
    } catch (err) {
      // The map could not even be created: no WebGL (hardware acceleration off, a company policy
      // disabling 3D graphics...). Say so: "check your internet connection" would send the user
      // after the wrong cause.
      container.remove();
      return Promise.reject(fail(/webgl/i.test(String(err && (err.message || err))) || !webglAvailable() ? 'webgl-unavailable' : 'basemap-unavailable', err));
    }
    const cleanup = () => { try { map.remove(); } catch (e) { /* ignore */ } container.remove(); };
    return new Promise((resolve, reject) => {
      let loaded = false, done = false;
      const timer = setTimeout(() => finish(fail('basemap-timeout')), (opts && opts.timeoutMs) || 60000);
      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { cleanup(); reject(err); return; }
        try {
          const out = document.createElement('canvas');
          out.width = W; out.height = H;
          const ctx = out.getContext('2d');
          ctx.fillStyle = MT.theme.mapFrame.background;
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(map.getCanvas(), 0, 0, W, H);
          cleanup();
          resolve(out);
        } catch (e) { cleanup(); reject(fail('basemap-unavailable', e)); }
      }
      map.on('style.load', () => {
        loaded = true;
        try {
          MT.mapview.basemap.patch(map);
          MT.mapview.basemap.apply(map, mapCfg, { overlays: !(opts && opts.overlays === false), items: opts && opts.items });
        } catch (e) { console.warn('[render] style patch', e); }
      });
      map.on('error', (e) => { if (!loaded) finish(fail('basemap-unavailable', e && e.error)); });
      map.on('idle', () => {
        if (!loaded || !map.areTilesLoaded()) return;
        // Where the basemap writes the districts' names: learnt here too, so an export of a slide
        // never shown in the preview still keeps its markers off them (the layout is computed
        // after this, from the cache).
        try { MT.mapview.basemap.harvestPlaces(map, mapCfg); } catch (e) { /* keep the fallback points */ }
        // …and where it wrote its labels (soft obstacles + exact district-name boxes for the layout).
        try { MT.mapview.basemap.harvestLabels(map, mapCfg); } catch (e) { /* no label obstacles */ }
        finish(null);
      });
    });
  }

  /**
   * Map frame at `scale` (px per reference unit): basemap + borders + radius + leaders + dots +
   * markers + attribution. Resolves {canvas, layout, frame, view}.
   */
  function mapCanvas(mapCfg, opts) {
    opts = Object.assign({ scale: MT.theme.export.mapScale || 3, markers: true, overlays: true, attribution: true }, opts || {});
    return serial(async () => {
      await MT.data.ready;
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const F = MT.layout.frame();
      const scale = +opts.scale || 3;
      const W = Math.round(F.width * scale), H = Math.round(F.height * scale);
      let view = MT.layout.viewFor(mapCfg);
      const st = MT.layout.styleOf(mapCfg);
      const sig0 = MT.layout.labels.sig(mapCfg);
      // The markers, dots and leaders block basemap labels (MT.mapview.basemap blockers) — once the
      // view's own labels are known: the declutter first keeps logos off them, then the few labels
      // still in the way move or are left out. opts.blockersFor: the config whose layout is drawn
      // over this basemap (the PPTX basemap is rendered from a copy with fewer radius circles).
      const lcfg = opts.blockersFor || mapCfg;
      const blockers = () => (opts.markerBlockers !== false && MT.layout.labels.get(mapCfg, MT.layout.viewFor(mapCfg)) ? MT.layout.compute(lcfg) : null);
      let blk = blockers();
      let canvas = await renderBasemap(mapCfg, view, W, H, { overlays: opts.overlays, timeoutMs: opts.timeoutMs, items: blk });
      // The basemap may just have taught MT.layout where the district names are: an automatic view
      // widens to keep a selected district's name inside the frame, and a district the basemap names
      // itself no longer gets the app's label (or the app's label moves). Draw the basemap again then
      // — and once more when the layout (now laid out around the labels just learnt) blocks other labels.
      const v2 = MT.layout.viewFor(mapCfg);
      const viewMoved = Math.abs(v2.zoomRef - view.zoomRef) > 1e-9 || Math.abs(v2.center[0] - view.center[0]) > 1e-9 || Math.abs(v2.center[1] - view.center[1]) > 1e-9;
      const blk2 = blockers();
      if (viewMoved || MT.layout.labels.sig(mapCfg) !== sig0 || MT.mapview.basemap.blockerKey(blk2) !== MT.mapview.basemap.blockerKey(blk)) {
        view = v2; blk = blk2;
        canvas = await renderBasemap(mapCfg, view, W, H, { overlays: opts.overlays, timeoutMs: opts.timeoutMs, items: blk });
        const blk3 = blockers();
        if (MT.mapview.basemap.blockerKey(blk3) !== MT.mapview.basemap.blockerKey(blk)) {
          blk = blk3;
          canvas = await renderBasemap(mapCfg, view, W, H, { overlays: opts.overlays, timeoutMs: opts.timeoutMs, items: blk });
        }
      }
      // After the basemap: it may just have taught MT.layout where the district names are.
      const layout = MT.layout.compute(mapCfg);
      await MT.markers.ready(layout.map((i) => i.chainId), st);
      const ctx = canvas.getContext('2d');
      const s = W / F.width;
      if (opts.overlays) drawOverlay(ctx, mapCfg, layout, s, { view: view, markers: opts.markers, attribution: opts.attribution });
      else if (opts.attribution) drawAttribution(ctx, s);
      return { canvas: canvas, layout: layout, frame: { width: W, height: H, scale: s }, view: view };
    });
  }

  /* ---- Full slide ------------------------------------------------------------------------------------ */
  function gradientFor(ctx, x, y, w, h, g) {
    const th = g.angleDeg * Math.PI / 180;
    const dx = Math.sin(th), dy = -Math.cos(th);                 // CSS: 0deg = to top, clockwise
    const len = Math.abs(w * dx) + Math.abs(h * dy);
    const cx = x + w / 2, cy = y + h / 2;
    const lg = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
    lg.addColorStop(0, g.from); lg.addColorStop(1, g.to);
    return lg;
  }

  /** Paint the slide (everything but the map, which comes as `mapImage` drawn into the frame). */
  function drawSlide(ctx, mapCfg, W, mapImage, g) {
    const th = MT.theme;
    g = g || MT.slide.layout(mapCfg, W);
    const H = g.H;
    ctx.save();
    ctx.fillStyle = th.slide.background; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = th.slide.leftArea.color; ctx.fillRect(g.leftArea.x, g.leftArea.y, g.leftArea.w, g.leftArea.h);
    // Template decoration (theme slide.decoration; decoded by slideCanvas → decoration()).
    const deco = g.decoration && decoImages[g.decoration.src];
    if (deco) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(deco, g.decoration.x, g.decoration.y, g.decoration.w, g.decoration.h); }
    // Title
    if (g.title.text) {
      ctx.font = MT.slide.font('bold', g.title.fontPx); ctx.fillStyle = g.title.color;
      ctx.textBaseline = 'alphabetic';
      const align = th.title.align || 'center';
      ctx.textAlign = align;
      const tx = align === 'center' ? g.title.x + g.title.w / 2 : align === 'right' ? g.title.x + g.title.w : g.title.x;
      ctx.fillText(g.title.text, tx, g.title.baseline);
    }
    // Subtitle runs
    const s = g.subtitle;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    s.lines.forEach((ln) => {
      ln.runs.forEach((r) => {
        ctx.font = MT.slide.font(r.weight, s.fontPx); ctx.fillStyle = r.color;
        ctx.fillText(r.text, r.x, ln.baseline);
        if (r.kind === 'peso' && th.subtitle.peso.underline) ctx.fillRect(r.x, ln.baseline + s.underline.offset, r.w, s.underline.thickness);
      });
    });
    // Map frame
    const f = g.frame;
    ctx.fillStyle = th.mapFrame.background; ctx.fillRect(f.x, f.y, f.w, f.h);
    if (mapImage) ctx.drawImage(mapImage, f.x, f.y, f.w, f.h);
    if (th.mapFrame.border && th.mapFrame.border.widthPt) {
      const bw = th.pt2px(th.mapFrame.border.widthPt, W);
      ctx.strokeStyle = th.mapFrame.border.color; ctx.lineWidth = bw;
      ctx.strokeRect(f.x + bw / 2, f.y + bw / 2, f.w - bw, f.h - bw);
    }
    // Panel: gradient + faint circles (clipped to the panel)
    const p = g.panel;
    ctx.fillStyle = gradientFor(ctx, p.x, p.y, p.w, p.h, th.panel.gradient);
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    th.panel.circles.forEach((c) => {
      ctx.beginPath(); ctx.arc(p.x + c.cx * g.k, p.y + c.cy * g.k, c.r * g.k, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + c.alpha + ')'; ctx.fill();
    });
    ctx.restore();
    // Legend
    const lg = g.legend, style = MT.layout.styleOf(mapCfg);
    ctx.font = MT.slide.font('bold', lg.heading.fontPx); ctx.fillStyle = lg.heading.color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(lg.heading.text, lg.heading.cx, lg.heading.baseline);
    ctx.textAlign = 'left';
    lg.rows.forEach((r) => {
      const icon = MT.markers.icon(r.chainId, Math.round(r.icon.h * 2), style);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(icon, r.icon.x, r.icon.y, r.icon.w, r.icon.h);
      ctx.font = MT.slide.font('bold', r.fontPx); ctx.fillStyle = lg.color;
      ctx.fillText(r.text, r.textX, r.baseline);
    });
    // Key for grouped logos under the rows.
    if (lg.note) {
      ctx.font = MT.slide.font('normal', lg.note.fontPx); ctx.fillStyle = lg.note.color;
      ctx.fillText(lg.note.text, lg.note.x, lg.note.baseline);
    }
    ctx.restore();
    return g;
  }

  /** Decoded template decoration images (theme slide.decoration), by data URI. */
  const decoImages = {};
  function decoration() {
    const d = MT.theme.slide.decoration;
    if (!d || !d.src || decoImages[d.src]) return Promise.resolve();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { decoImages[d.src] = img; resolve(); };
      img.onerror = () => resolve();             // a broken decoration must not break the export
      img.src = d.src;
    });
  }

  /** The complete 16:9 slide as one canvas (default 3840 × 2160). */
  async function slideCanvas(mapCfg, opts) {
    opts = opts || {};
    const W = Math.round(opts.width || MT.theme.export.slideWidth || 3840);
    await MT.data.ready;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const geo0 = MT.slide.layout(mapCfg, W, []);
    const map = mapCfg ? await mapCanvas(mapCfg, { scale: geo0.frame.w / MT.layout.frame().width, timeoutMs: opts.timeoutMs }) : null;
    const rows = mapCfg ? MT.legend.items(mapCfg, map.layout) : [];
    const st = MT.layout.styleOf(mapCfg);
    await MT.markers.ready(rows.map((r) => r.chainId), st);
    await decoration();
    const g = MT.slide.layout(mapCfg, W, rows);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Math.round(g.H);
    drawSlide(cv.getContext('2d'), mapCfg, W, map && map.canvas, g);
    return cv;
  }

  MT.render = {
    mapCanvas: mapCanvas,
    slideCanvas: slideCanvas,
    drawOverlay: drawOverlay,
    drawAttribution: drawAttribution,
    drawSlide: drawSlide,
    /** Decode the theme's slide decoration (if any) before drawSlide. */
    decoration: decoration,
  };
})();
