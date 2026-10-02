/* js/layout.js — MT.layout: reference frame, map views, projection and the deterministic marker
 * declutter (SPEC §4.2). Module M1. Pure functions of (mapCfg, MT.data): no DOM, no MapLibre —
 * the live preview (MT.mapview) and every export (MT.render, PPTX, HTML) call the same code, so
 * they place every marker at exactly the same spot.
 *
 * Reference frame: the map frame is always 1000 units wide and MT.theme.frame.refHeight tall.
 * A view is {center:[lng,lat], zoomRef}; zoomRef = MapLibre zoom of a 1000-px-wide frame.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.1):
 *   MT.layout.compute(mapCfg, {width, height, project}?) → Array<{
 *       storeId, chainId, name, lngLat:[lng,lat],
 *       anchor:{x,y}   projected store location (reference units),
 *       dot:{x,y}      where its store dot is drawn: the anchor, spread a little off the dots of
 *                      stores at the same spot (badge / card / number styles; leaders start here),
 *       pos:{x,y}      marker CENTRE (reference units),
 *       w, h           marker size (reference units),
 *       shape          'circle' | 'rect',
 *       displaced      true when the marker is not at its default spot (directly above the dot),
 *       manual         position comes from mapCfg.markerOffsets (user drag),
 *       leader         {x1,y1,x2,y2} | null — dot → marker edge (also the short default stem),
 *       number?        1-based for markerStyle 'number' (by chain legend name, then store name),
 *       collapsed?     no room for its logo near the store: a small dot on the location,
 *       count?, members?, leaderFrom?, spokes?   same-chain group (badge/card, mapCfg.groupNearby):
 *                      this item carries the logo of `count` stores (`members`, ids incl. its own) with
 *                      a count pip; its leader starts at the dot of `leaderFrom`; `spokes` tie every
 *                      other member's dot to the logo ([{x1,y1,x2,y2,storeId,to?}]: to the logo's edge,
 *                      or with `to` to that store's dot — a spanning tree, groupTree),
 *       grouped?, groupOf?   a store drawn by another item's group logo: only its dot (pos = anchor,
 *                      w = h = a small hit target), no leader
 *       isRef?, refPad?      analysis slide (mapCfg.analysis, SPEC §6.3): the reference store — never
 *                      grouped or collapsed; w / h include its halo (refPad per side, MT.markers draws
 *                      the logo refPad smaller inside it)
 *   }>
 *   One item per store, always (legend counts). Without opts.project the map's own view is used
 *   (saved view or auto-fit) and results are memoized, so the slide legend, the preview and the
 *   exports share one computation. opts.groupNearby overrides the map's setting; opts.groups
 *   ([[storeId…]]) forces these groups (the HTML export replays the slide's); opts.logoScale draws
 *   the logos at that share of the map's size; opts.autoSize:false never shrinks them.
 *   items.stats.size = the marker size the logos are drawn at (smaller than the map's on a crowded
 *   map that groups by itself: theme declutter.aggregate.autoSize).
 * Extras: frame(), styleOf(), viewFor(), autoView(), fitView(), projector(), unprojector(),
 *   fitPadding(), attributionBox(), districtLabels(), districtLabelBoxes(), roadLabels(), places,
 *   labels, place() (core solver, used by the tests), clusterNodes(), spreadDots(), spokesFor(),
 *   nameLayer(), weights, lastStats, BASEMAP_WIDTH.
 *   Analysis slides: analysis(mapCfg, view?) → {ref:{ll, x, y, type, storeId, onSlide, chainId, label,
 *   inFrame}, pin:{ll, x, y, box}|null, rings:[{meters, text, pts, bbox, inside, visible, label:{ll, x, y,
 *   w, h, fs, text, bearing}|null}], lines:[{storeId, chainId, meters}], top, rows, maxMeters, label,
 *   view} | null — where the reference pin, the rings and their pills go (pills placed off the store
 *   dots and the logos' default spots); analysisBoxes(mapCfg, project) → the pills + pin as obstacles
 *   (the declutter keeps logos off them); pinBox(), ringPill(), ringLabelFont(), refHaloPad().
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;

  // The basemap is ALWAYS rendered at this CSS width (preview: CSS-scaled to the frame; exports:
  // pixelRatio = 1000·scale / BASEMAP_WIDTH) so map labels keep the same size relative to the
  // frame everywhere — true WYSIWYG. 620 × 520 px keeps the 31:26 frame aspect in whole pixels.
  // Smaller = bigger, slide-readable labels; a theme key basemap.cssWidth overrides it.
  const BASEMAP_WIDTH = (MT.theme.basemap && MT.theme.basemap.cssWidth) || 620;

  // Fallback view when there is nothing to fit (no districts, no stores): all of Peru.
  const PERU_VIEW_BBOX = [-81.4, -18.4, -68.6, -0.03];

  // Declutter cost weights (see SPEC §4.2). Overlaps dominate everything; then hidden store dots,
  // then crossings; distance and angle only break ties between clean spots.
  //   labelCross / labelLen: a leader through an obstacle box (a selected district's name, a radius
  //     pill, the attribution) — plus a cost per unit of leader inside it, so a store whose dot sits
  //     IN a name gets its logo on the side where the leader leaves the text by the shortest path.
  //   label / labelLeader: the basemap's other labels (street, village, water names; harvested from
  //     the rendered map) are soft: a logo avoids covering one when a free spot is close, but is
  //     never pushed far for it (≈ 2 rings of distance); a leader goes around one when it can.
  //   roadName / roadLeader: the same for the main avenue names the app writes (roadLabels): one
  //     label per avenue, the reader's orientation — logos and leaders keep off it more firmly.
  //   through: a leader passing under another marker (it reads as that marker's leader).
  //   groupFar / groupBlock / spoke: a grouped logo ("×4") sits on its stores' side — a cost per
  //     marker size to its farthest store, per marker between it and its stores' centre, and per
  //     spoke (logo → store dot) passing under another marker.
  const W = {
    overlap: 1000, penetration: 25,
    ownAnchor: 2500, anchor: 450, obstacle: 700,
    labelCross: 300, labelLen: 4,
    cross: 40, through: 80,
    label: 16, labelLeader: 12, roadName: 45, roadLeader: 30,
    groupFar: 9, groupBlock: 60, spoke: 12,
    ring: 7, angle: 3.2, clamp: 4,
  };
  const ROAD_LAYER = 'mt-road-names';       // MT.mapview's layer of the avenue names the app writes
  // Extra rings (in marker sizes) tried only when nothing closer is free — and only up to
  // opts.maxRing (badges and cards are capped by theme.marker.declutter.maxLeader).
  const EXTRA_RINGS = [4.6, 5.8, 7.2, 8.8];

  /* ---- Frame & style ------------------------------------------------------------------------- */
  function frame() { return { width: MT.theme.frame.refWidth || 1000, height: MT.theme.frame.refHeight }; }

  /** {kind, size} from a map config or a style object (validated). */
  function styleOf(x) {
    const d = MT.theme.marker.defaults;
    const kind = x && (x.kind || x.markerStyle);
    const size = x && (x.size !== undefined ? x.size : x.markerSize);
    return {
      kind: MT.theme.marker.styles.indexOf(kind) >= 0 ? kind : d.style,
      size: U.clamp(+size || d.size, d.minSize, d.maxSize),
    };
  }

  /* ---- Projection ------------------------------------------------------------------------------ */
  /** view → ([lng,lat]) → {x,y} in reference units (Web Mercator, 512·2^zoomRef world). */
  function projector(view, fr) {
    fr = fr || frame();
    const c = MT.geo.project(view.center, view.zoomRef);
    const hx = fr.width / 2, hy = fr.height / 2;
    return function (lngLat) {
      const p = MT.geo.project(lngLat, view.zoomRef);
      return { x: p[0] - c[0] + hx, y: p[1] - c[1] + hy };
    };
  }
  /** view → ({x,y}) → [lng,lat]. */
  function unprojector(view, fr) {
    fr = fr || frame();
    const c = MT.geo.project(view.center, view.zoomRef);
    return function (pt) { return MT.geo.unproject([pt.x - fr.width / 2 + c[0], pt.y - fr.height / 2 + c[1]], view.zoomRef); };
  }

  function validView(v) {
    return !!(v && Array.isArray(v.center) && isFinite(v.center[0]) && isFinite(v.center[1]) && isFinite(v.zoomRef));
  }

  /** Fit padding (reference units) that leaves room for markers drawn above their dots. */
  function fitPadding(style) {
    const st = styleOf(style);
    const P = MT.theme.frame.padding;
    const m = MT.theme.marker;
    if (st.kind === 'dot') return { top: P * 0.6, right: P * 0.6, bottom: P * 0.6, left: P * 0.6 };
    const dims = MT.theme.markerDims(st.kind, st.size);
    const side = Math.max(P, dims.w / 2 + 18);
    return { top: Math.max(P, dims.h + m.stem + 16), right: side, bottom: Math.max(P * 0.7, dims.h * 0.6), left: side };
  }

  /** Smallest-zoom view that fits a bbox [w,s,e,n] inside the frame with padding. */
  function fitView(bbox, padding, fr) {
    if (!bbox) return null;
    fr = fr || frame();
    const pad = padding || { top: 0, right: 0, bottom: 0, left: 0 };
    const p0 = MT.geo.project([bbox[0], bbox[3]], 0), p1 = MT.geo.project([bbox[2], bbox[1]], 0);
    const w0 = Math.max(1e-9, p1[0] - p0[0]), h0 = Math.max(1e-9, p1[1] - p0[1]);
    const aw = Math.max(50, fr.width - pad.left - pad.right), ah = Math.max(50, fr.height - pad.top - pad.bottom);
    const z = U.clamp(Math.log2(Math.min(aw / w0, ah / h0)), 2, 17.5);
    const s = Math.pow(2, z);
    const cx = (p0[0] + p1[0]) / 2 * s + (pad.right - pad.left) / 2;
    const cy = (p0[1] + p1[1]) / 2 * s + (pad.bottom - pad.top) / 2;
    const c = MT.geo.unproject([cx, cy], z);
    return { center: [c[0], c[1]], zoomRef: z };
  }

  /**
   * Automatic view of a map (bounds of its stores or districts + marker padding), or null.
   * The names of the selected districts are the reader's orientation: when the basemap would write
   * one (its place point inside the frame) across an edge of the frame — "Nuevo Chiml…" — the fit
   * widens just enough to keep the whole name inside (LABEL_MARGIN). A few deterministic passes: the
   * name has a fixed size on the slide, so its extent in degrees follows the zoom.
   */
  const LABEL_MARGIN = 4;
  function autoView(mapCfg) {
    const b = MT.data.boundsForMap(mapCfg);
    if (!b) return null;
    const pad = fitPadding(mapCfg), fr = frame(), m = LABEL_MARGIN;
    const bb = b.slice();
    let view = fitView(bb, pad, fr);
    for (let pass = 0; pass < 4 && view; pass++) {
      const un = unprojector(view, fr);
      const cut = districtLabelBoxes(mapCfg, projector(view, fr), view, fr, { estimate: true })
        .filter((x) => x.x < m || x.y < m || x.x + x.w > fr.width - m || x.y + x.h > fr.height - m);
      if (!cut.length) break;
      // Points the padded fit must contain so that each name ends up inside the frame.
      cut.forEach((x) => {
        const cx = x.x + x.w / 2, cy = x.y + x.h / 2, pts = [];
        if (x.x < m) pts.push({ x: x.x + pad.left - m, y: cy });
        if (x.x + x.w > fr.width - m) pts.push({ x: x.x + x.w - pad.right + m, y: cy });
        if (x.y < m) pts.push({ x: cx, y: x.y + pad.top - m });
        if (x.y + x.h > fr.height - m) pts.push({ x: cx, y: x.y + x.h - pad.bottom + m });
        pts.forEach((p) => {
          const ll = un(p);
          bb[0] = Math.min(bb[0], ll[0]); bb[1] = Math.min(bb[1], ll[1]); bb[2] = Math.max(bb[2], ll[0]); bb[3] = Math.max(bb[3], ll[1]);
        });
      });
      view = fitView(bb, pad, fr);
    }
    return view;
  }

  /** The view a map is drawn with: saved view → auto-fit → all of Peru. Never null. */
  function viewFor(mapCfg) {
    if (mapCfg && validView(mapCfg.view)) return { center: mapCfg.view.center.slice(), zoomRef: +mapCfg.view.zoomRef };
    return (mapCfg && autoView(mapCfg)) || fitView(PERU_VIEW_BBOX, { top: 20, right: 20, bottom: 20, left: 20 });
  }

  /* ---- Attribution box (an obstacle for markers; drawn by MT.render.overlay) --------------------- */
  let measureCtx = null;
  function textWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  /**
   * {x, y, w, h, fontPx, font, text, obstacle} in reference units (bottom-right of the frame).
   * `obstacle` also covers the PowerPoint text box, which uses a real point size in Calibri
   * (theme attribution.pptx) and can be a little wider: markers and basemap labels keep off both.
   */
  function attributionBox() {
    const a = MT.theme.attribution, fr = frame();
    const font = '500 ' + a.fontSize + 'px ' + MT.theme.fonts.ui;
    const tw = textWidth(a.text, font);
    const w = tw + a.padding * 2.4, h = a.fontSize * 1.25 + a.padding * 1.2;
    const x = a.position === 'bottom-left' ? 0 : fr.width - w;
    const pt = Math.max(a.fontSize, a.pptx && a.pptx.sizePt ? MT.theme.pt2ref(a.pptx.sizePt) : 0);
    const ow = Math.max(w, textWidth(a.text, '400 ' + pt + 'px ' + MT.theme.fonts.slideCss) + a.padding * 2 + MT.theme.in2ref(0.04)), oh = Math.max(h, pt * 1.3);
    const obstacle = { x: a.position === 'bottom-left' ? 0 : fr.width - ow, y: fr.height - oh, w: ow, h: oh };
    return { x: x, y: fr.height - h, w: w, h: h, font: font, fontPx: a.fontSize, text: a.text, textWidth: tw, obstacle: obstacle };
  }

  /* ---- Geometry helpers -------------------------------------------------------------------------- */
  // Proper segment intersection (shared endpoints and collinear touches do not count).
  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  }
  // Does segment (x1,y1)-(x2,y2) pass within r of (cx,cy)?
  function segCircle(x1, y1, x2, y2, cx, cy, r) {
    const vx = x2 - x1, vy = y2 - y1, l2 = vx * vx + vy * vy;
    let t = l2 ? ((cx - x1) * vx + (cy - y1) * vy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x1 + t * vx - cx, py = y1 + t * vy - cy;
    return px * px + py * py < r * r;
  }
  // Length of the segment inside the box {x, y, w, h} (top-left corner), 0 when it misses it (Liang–Barsky).
  function segBoxLen(x1, y1, x2, y2, b) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy], q = [x1 - b.x, b.x + b.w - x1, y1 - b.y, b.y + b.h - y1];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return 0; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return 0; if (r > t0) t0 = r; } else { if (r < t0) return 0; if (r < t1) t1 = r; }
    }
    return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
  }
  // Does the segment intersect the axis-aligned box centred at (cx,cy)? (Liang–Barsky)
  function segRect(x1, y1, x2, y2, cx, cy, hw, hh) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy], q = [x1 - (cx - hw), (cx + hw) - x1, y1 - (cy - hh), (cy + hh) - y1];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return false; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 < t1;
  }
  // Distance from a shape centre to its edge along the unit direction (ux,uy).
  function edgeDist(circle, w, h, ux, uy) {
    if (circle) return w / 2;
    const ax = Math.abs(ux), ay = Math.abs(uy);
    const tx = ax > 1e-9 ? (w / 2) / ax : Infinity, ty = ay > 1e-9 ? (h / 2) / ay : Infinity;
    return Math.min(tx, ty);
  }
  /** Leader from anchor (ax,ay) to the edge of a marker centred at (x,y); null when the dot is under the marker. */
  function leaderFor(circle, ax, ay, x, y, w, h) {
    const dx = x - ax, dy = y - ay, d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    const ux = dx / d, uy = dy / d;
    const e = edgeDist(circle, w, h, ux, uy);
    if (d - e <= 0.5) return null;
    return { x1: ax, y1: ay, x2: x - ux * e, y2: y - uy * e };
  }

  /**
   * How a grouped logo is tied to its stores' dots: a minimum spanning tree over the logo (root) and
   * the dots, built from the logo out (Prim; the distance logo → dot is the leader's length). The
   * dot nearest the logo gets the leader (`from`); other dots joined to the logo get a spoke
   * (`spokes`: indexes into pts), dots nearer to another store of the group than to the logo are
   * joined to that store (`links`: [a, b] index pairs) — so a group whose logo had to go a little
   * away shows one leader and short local links, not a fan of long rays across the map.
   * Deterministic: ties go to the lower index.
   */
  function groupTree(pts, x, y, w, h, circle) {
    const k = pts.length, inTree = new Uint8Array(k), best = new Float64Array(k), parent = new Int32Array(k).fill(-1);
    const rootDist = (p) => { const l = leaderFor(circle, p.x, p.y, x, y, w, h); return l ? Math.hypot(l.x2 - l.x1, l.y2 - l.y1) : 0; };
    for (let i = 0; i < k; i++) best[i] = rootDist(pts[i]);
    const out = { from: -1, spokes: [], links: [] };
    for (let n = 0; n < k; n++) {
      let pick = -1;
      for (let i = 0; i < k; i++) if (!inTree[i] && (pick < 0 || best[i] < best[pick] - 1e-9)) pick = i;
      inTree[pick] = 1;
      if (parent[pick] < 0) { if (out.from < 0) out.from = pick; else out.spokes.push(pick); } else out.links.push([parent[pick], pick]);
      for (let i = 0; i < k; i++) {
        if (inTree[i]) continue;
        const d = Math.hypot(pts[i].x - pts[pick].x, pts[i].y - pts[pick].y);
        if (d < best[i] - 1e-9) { best[i] = d; parent[i] = pick; }
      }
    }
    return out;
  }

  /**
   * Spokes of a grouped logo `rep` (an item with pos, w, h, shape, leaderFrom) over its members'
   * items (their `dot`): [{x1, y1, x2, y2, storeId, to?}] — from the dot of `storeId` to the logo's
   * edge, or (with `to`) to the dot of store `to`. The leader's own dot gets none.
   */
  function spokesFor(rep, members) {
    const circle = rep.shape !== 'rect';
    const ms = members.filter((m) => m && (m.dot || m.anchor));
    const dot = (m) => m.dot || m.anchor;
    const gt = groupTree(ms.map(dot), rep.pos.x, rep.pos.y, rep.w, rep.h, circle);
    const list = [];
    [gt.from].concat(gt.spokes).forEach((k) => {
      if (k < 0 || ms[k].storeId === rep.leaderFrom) return;
      const l = leaderFor(circle, dot(ms[k]).x, dot(ms[k]).y, rep.pos.x, rep.pos.y, rep.w, rep.h);
      if (l) list.push(Object.assign(l, { storeId: ms[k].storeId }));
    });
    gt.links.forEach(([a, b]) => {
      list.push({ x1: dot(ms[b]).x, y1: dot(ms[b]).y, x2: dot(ms[a]).x, y2: dot(ms[a]).y, storeId: ms[b].storeId, to: ms[a].storeId });
    });
    return list;
  }

  /* ---- Core solver --------------------------------------------------------------------------------
   * nodes: [{ax, ay, w, h, fixed:{x,y}|null, key, group?, pts?}] (reference units). A node with
   * `pts` ([{x,y}], ≥ 2) is a GROUP of stores drawn as one marker (same-chain grouping): (ax, ay) is
   * their centroid, pts their dots. Its marker keeps off all of them ("directly above" = above the
   * topmost one) and its leader starts at the dot nearest to the marker (`from` = index in pts).
   * Returns aligned [{x, y, displaced, cost, leader, collapsed, from}]. opts: {width, height,
   * shape:'circle'|'rect', stem, rings, angles, minGap, passes, margin, anchorRadius,
   * obstacles:[{x,y,w,h}] (markers keep off them; a leader through one costs W.labelCross +
   * W.labelLen per unit inside), soft:[{x,y,w,h,parts?}] (basemap labels: a marker covering one costs
   * W.label × (0.35 + 0.65 × share covered), a leader through one W.labelLeader; `parts` = the boxes
   * of a line label, the share is then the share of parts covered),
   * maxRing (marker sizes; candidates farther away are never tried), maxLeader (reference units:
   * longest leader allowed — the same absolute cap for wide cards and round badges), collapse}.
   * collapse: markers that still overlap others after the passes are "collapsed" — left out of the
   * declutter and reported with `collapsed: true` (the caller draws a small dot at the store),
   * the most crowded first, the most common group (chain) first on ties; afterwards each one is
   * given back its marker if a free spot within maxRing exists. Rare chains keep their logos.
   * Deterministic: fixed candidate order, stable sorts, no randomness. */
  function place(nodes, opts) {
    const n = nodes.length;
    const FW = opts.width, FH = opts.height, M = opts.margin === undefined ? 3 : opts.margin;
    const circle = opts.shape !== 'rect';
    const gap = opts.minGap || 0;
    const A = opts.angles || 16;
    const maxRing = opts.maxRing === undefined ? Infinity : opts.maxRing;
    const maxLeader = opts.maxLeader === undefined ? Infinity : opts.maxLeader;
    let rings = (opts.rings || [0, 0.6, 1.2, 1.9, 2.7, 3.6]).concat(EXTRA_RINGS).filter((r) => r <= maxRing + 1e-9);
    if (isFinite(maxRing) && rings.indexOf(maxRing) < 0) rings = rings.concat(maxRing).sort((a, b) => a - b);
    const stem = opts.stem || 0;
    const anchorR = opts.anchorRadius || 4;
    const obstacles = opts.obstacles || [];
    const soft = opts.soft || [];
    const out = new Array(n);
    if (!n) return out;

    let maxDim = 1;
    for (let i = 0; i < n; i++) maxDim = Math.max(maxDim, nodes[i].w, nodes[i].h);
    const C = maxDim + gap + 1;                 // grid cell ≥ any interaction distance
    const GX = Math.max(1, Math.ceil(FW / C) + 1), GY = Math.max(1, Math.ceil(FH / C) + 1);
    const cellOf = (x, y) => [U.clamp(Math.floor(x / C), 0, GX - 1), U.clamp(Math.floor(y / C), 0, GY - 1)];

    // Store dots (static): one per node, or one per store of a group node. apts[k] = {x, y, o: node}.
    const apts = [];
    for (let i = 0; i < n; i++) {
      if (nodes[i].pts && nodes[i].pts.length) nodes[i].pts.forEach((p) => apts.push({ x: p.x, y: p.y, o: i }));
      else apts.push({ x: nodes[i].ax, y: nodes[i].ay, o: i });
    }
    const AC = 32, AGX = Math.ceil(FW / AC) + 1, AGY = Math.ceil(FH / AC) + 1;
    const agrid = new Array(AGX * AGY);
    for (let p = 0; p < apts.length; p++) {
      const cx = U.clamp(Math.floor(apts[p].x / AC), 0, AGX - 1), cy = U.clamp(Math.floor(apts[p].y / AC), 0, AGY - 1);
      const k = cy * AGX + cx;
      (agrid[k] || (agrid[k] = [])).push(p);
    }
    function anchorsIn(x0, y0, x1, y1, fn) {
      const cx0 = U.clamp(Math.floor(x0 / AC), 0, AGX - 1), cx1 = U.clamp(Math.floor(x1 / AC), 0, AGX - 1);
      const cy0 = U.clamp(Math.floor(y0 / AC), 0, AGY - 1), cy1 = U.clamp(Math.floor(y1 / AC), 0, AGY - 1);
      for (let gy = cy0; gy <= cy1; gy++) for (let gx = cx0; gx <= cx1; gx++) {
        const list = agrid[gy * AGX + gx];
        if (list) for (let t = 0; t < list.length; t++) fn(apts[list[t]]);
      }
    }
    /** Leader of node nd for a marker at (x, y): from its dot, or from the group's nearest dot. */
    function leaderOf(nd, x, y) {
      if (!nd.pts || !nd.pts.length) return { l: leaderFor(circle, nd.ax, nd.ay, x, y, nd.w, nd.h), f: 0 };
      let best = null, bestLen = Infinity, f = 0;
      for (let k = 0; k < nd.pts.length; k++) {
        const p = nd.pts[k], l = leaderFor(circle, p.x, p.y, x, y, nd.w, nd.h);
        const len = l ? Math.hypot(l.x2 - l.x1, l.y2 - l.y1) : 0;
        if (len < bestLen - 1e-9) { bestLen = len; best = l; f = k; }
      }
      return { l: best, f: f };
    }
    /** Static cost of a leader through obstacle boxes (district names, pills) and soft labels. */
    function leaderCost(l) {
      if (!l) return 0;
      let cost = 0;
      for (let o = 0; o < obstacles.length; o++) {
        const len = segBoxLen(l.x1, l.y1, l.x2, l.y2, obstacles[o]);
        if (len > 0) cost += W.labelCross + W.labelLen * len;
      }
      for (let o = 0; o < soft.length; o++) {
        const sb = soft[o];
        if (segBoxLen(l.x1, l.y1, l.x2, l.y2, sb) <= 0) continue;
        if (!sb.parts || sb.parts.some((p) => segBoxLen(l.x1, l.y1, l.x2, l.y2, p) > 0)) cost += sb.l === ROAD_LAYER ? W.roadLeader : W.labelLeader;
      }
      return cost;
    }
    /** Static cost of a marker box covering soft labels. */
    function softCost(x0, y0, x1, y1) {
      let cost = 0;
      for (let o = 0; o < soft.length; o++) {
        const sb = soft[o];
        if (x1 <= sb.x || x0 >= sb.x + sb.w || y1 <= sb.y || y0 >= sb.y + sb.h) continue;
        let share;
        if (sb.parts && sb.parts.length) {
          let hit = 0;
          sb.parts.forEach((p) => { if (x1 > p.x && x0 < p.x + p.w && y1 > p.y && y0 < p.y + p.h) hit++; });
          share = hit / sb.parts.length;
        } else {
          const ix = Math.min(x1, sb.x + sb.w) - Math.max(x0, sb.x), iy = Math.min(y1, sb.y + sb.h) - Math.max(y0, sb.y);
          share = Math.max(0, ix) * Math.max(0, iy) / Math.max(1, sb.w * sb.h);
        }
        if (share > 0) cost += (sb.l === ROAD_LAYER ? W.roadName : W.label) * (0.35 + 0.65 * Math.min(1, share));
      }
      return cost;
    }

    // Candidates per node, sorted by static cost.
    const cands = new Array(n);
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const w = nd.w, h = nd.h, hw = w / 2, hh = h / 2;
      const D = (w + h) / 2;
      const list = [];
      const seen = {};
      const minX = M + hw, maxX = FW - M - hw, minY = M + hh, maxY = FH - M - hh;
      const push = (x0, y0, ring, dev, idx) => {
        const x = U.clamp(x0, minX, Math.max(minX, maxX)), y = U.clamp(y0, minY, Math.max(minY, maxY));
        const kk = Math.round(x * 4) + ',' + Math.round(y * 4);
        if (seen[kk]) return;
        const ld = leaderOf(nd, x, y);
        // A group's leader starts at its nearest dot: keep it within the cap too (the first ring is
        // always kept, so every node has candidates).
        if (ring > 0 && isFinite(maxLeader) && nd.pts && ld.l && Math.hypot(ld.l.x2 - ld.l.x1, ld.l.y2 - ld.l.y1) > maxLeader + 1) return;
        seen[kk] = true;
        const clampD = Math.hypot(x - x0, y - y0);
        let cost = W.ring * ring + W.angle * dev + W.clamp * clampD / D;
        // Store dots covered by this spot (static: dots never move).
        let own = false, others = 0;
        anchorsIn(x - hw - anchorR, y - hh - anchorR, x + hw + anchorR, y + hh + anchorR, (a) => {
          const inside = circle ? Math.hypot(a.x - x, a.y - y) < hw + anchorR * 0.6
            : Math.abs(a.x - x) < hw + anchorR * 0.6 && Math.abs(a.y - y) < hh + anchorR * 0.6;
          if (!inside) return;
          if (a.o === i) own = true; else others++;
        });
        if (own) cost += W.ownAnchor;
        cost += others * W.anchor;
        for (let o = 0; o < obstacles.length; o++) {
          const ob = obstacles[o];
          if (x + hw > ob.x && x - hw < ob.x + ob.w && y + hh > ob.y && y - hh < ob.y + ob.h) cost += W.obstacle;
        }
        if (soft.length) cost += softCost(x - hw, y - hh, x + hw, y + hh);
        cost += leaderCost(ld.l);
        // A grouped logo stays close to ALL its stores, not only to the nearest one; its spokes
        // (groupTree) are checked against the other markers in evaluate().
        let sp = null;
        if (nd.pts && nd.pts.length > 1) {
          let far = 0;
          for (let k = 0; k < nd.pts.length; k++) far = Math.max(far, Math.hypot(nd.pts[k].x - x, nd.pts[k].y - y));
          cost += W.groupFar * far / D;
          sp = groupTree(nd.pts, x, y, w, h, circle).spokes;
        }
        list.push({ x: x, y: y, s: cost, idx: idx, def: idx === 0 && clampD < 0.5, l: ld.l, f: ld.f, sp: sp });
      };
      let idx = 0;
      // Rings for this node: within maxLeader (leader = stem + ring·D), plus the cap itself.
      let nr = rings;
      if (isFinite(maxLeader)) {
        const capRing = Math.max(0, (maxLeader - stem) / D);
        nr = rings.filter((r) => r <= capRing + 1e-9);
        if (nr[nr.length - 1] < capRing - 0.05) nr = nr.concat(capRing);
      }
      // A group's marker starts beyond its outermost dot in each direction (`ext`).
      const ext = new Float64Array(A);
      for (let k = 0; k < A; k++) {
        const step = k === 0 ? 0 : (k % 2 ? (k + 1) / 2 : -k / 2);
        const th = -Math.PI / 2 + step * 2 * Math.PI / A;
        if (nd.pts) nd.pts.forEach((p) => { ext[k] = Math.max(ext[k], (p.x - nd.ax) * Math.cos(th) + (p.y - nd.ay) * Math.sin(th)); });
      }
      for (let r = 0; r < nr.length; r++) {
        for (let k = 0; k < A; k++) {
          // k = 0 is straight up, then alternating right/left: deterministic order.
          const step = k === 0 ? 0 : (k % 2 ? (k + 1) / 2 : -k / 2);
          const th = -Math.PI / 2 + step * 2 * Math.PI / A;
          const ux = Math.cos(th), uy = Math.sin(th);
          const d = edgeDist(circle, w, h, ux, uy) + stem + ext[k] + nr[r] * D;
          push(nd.ax + ux * d, nd.ay + uy * d, nr[r], Math.abs(step) / (A / 2), idx++);
        }
      }
      // A spread-out group may also have room for its logo in a gap among its own dots (the
      // store dots stay visible: covering one costs as usual).
      if (nd.pts && nd.pts.length > 1) {
        let spread = 0;
        for (let k = 0; k < A; k++) spread = Math.max(spread, ext[k]);
        for (let f = 0; f <= 1.0001 && f * spread < spread + 1; f += 0.25) {
          for (let k = 0; k < (f ? A : 1); k++) {
            const step = k === 0 ? 0 : (k % 2 ? (k + 1) / 2 : -k / 2);
            const th = -Math.PI / 2 + step * 2 * Math.PI / A;
            const d = f * spread;
            if (d > ext[k] + 1e-9 && f) continue;     // only inside the group's extent that way
            push(nd.ax + Math.cos(th) * d, nd.ay + Math.sin(th) * d, 0, Math.abs(step) / (A / 2), idx++);
          }
        }
      }
      list.sort((a, b) => a.s - b.s || a.idx - b.idx);
      cands[i] = list;
    }

    // Dynamic state: placed markers (grid by centre) and leaders (grid by bbox).
    const px = new Float64Array(n), py = new Float64Array(n);
    const placed = new Uint8Array(n);
    const lead = new Array(n);
    const mgrid = new Array(GX * GY), lgrid = new Array(GX * GY);
    const stamp = new Uint32Array(n);
    let stampId = 1;
    function gridAdd(grid, k, i) { (grid[k] || (grid[k] = [])).push(i); }
    function gridDel(grid, k, i) { const l = grid[k]; if (!l) return; const p = l.indexOf(i); if (p >= 0) l.splice(p, 1); }
    function leaderCells(l, fn) {
      const a = cellOf(Math.min(l.x1, l.x2), Math.min(l.y1, l.y2)), b = cellOf(Math.max(l.x1, l.x2), Math.max(l.y1, l.y2));
      for (let gy = a[1]; gy <= b[1]; gy++) for (let gx = a[0]; gx <= b[0]; gx++) fn(gy * GX + gx);
    }
    function add(i, c) {
      px[i] = c.x; py[i] = c.y; placed[i] = 1; lead[i] = c.l;
      const cc = cellOf(c.x, c.y);
      gridAdd(mgrid, cc[1] * GX + cc[0], i);
      if (c.l) leaderCells(c.l, (k) => gridAdd(lgrid, k, i));
    }
    function remove(i) {
      if (!placed[i]) return;
      const cc = cellOf(px[i], py[i]);
      gridDel(mgrid, cc[1] * GX + cc[0], i);
      if (lead[i]) leaderCells(lead[i], (k) => gridDel(lgrid, k, i));
      placed[i] = 0; lead[i] = null;
    }
    // Markers whose centre lies in cells overlapping the box.
    function markersNear(x0, y0, x1, y1, fn) {
      const a = cellOf(x0 - C, y0 - C), b = cellOf(x1 + C, y1 + C);
      for (let gy = a[1]; gy <= b[1]; gy++) for (let gx = a[0]; gx <= b[0]; gx++) {
        const l = mgrid[gy * GX + gx];
        if (l) for (let t = 0; t < l.length; t++) if (fn(l[t]) === false) return;
      }
    }
    function leadersNear(x0, y0, x1, y1, fn) {
      stampId++;
      const a = cellOf(x0, y0), b = cellOf(x1, y1);
      for (let gy = a[1]; gy <= b[1]; gy++) for (let gx = a[0]; gx <= b[0]; gx++) {
        const l = lgrid[gy * GX + gx];
        if (!l) continue;
        for (let t = 0; t < l.length; t++) {
          const j = l[t];
          if (stamp[j] === stampId) continue;
          stamp[j] = stampId;
          if (fn(j) === false) return;
        }
      }
    }

    // Total cost of candidate c for node i against the placed set; stops once ≥ bound.
    function evaluate(i, c, bound) {
      let cost = c.s;
      if (cost >= bound) return cost;
      const nd = nodes[i], hw = nd.w / 2, hh = nd.h / 2;
      // 1. overlaps with placed markers (min gap included)
      markersNear(c.x - hw, c.y - hh, c.x + hw, c.y + hh, (j) => {
        if (j === i) return true;
        const o = nodes[j];
        let pen;
        if (circle) pen = hw + o.w / 2 + gap - Math.hypot(px[j] - c.x, py[j] - c.y);
        else {
          const ox = hw + o.w / 2 + gap - Math.abs(px[j] - c.x), oy = hh + o.h / 2 + gap - Math.abs(py[j] - c.y);
          pen = ox > 0 && oy > 0 ? Math.min(ox, oy) : -1;
        }
        if (pen > 0) { cost += W.overlap + W.penetration * pen; if (cost >= bound) return false; }
        return true;
      });
      if (cost >= bound) return cost;
      // 2. this leader crossing placed leaders / passing under placed markers
      const L = c.l;
      if (L) {
        const x0 = Math.min(L.x1, L.x2), x1 = Math.max(L.x1, L.x2), y0 = Math.min(L.y1, L.y2), y1 = Math.max(L.y1, L.y2);
        leadersNear(x0, y0, x1, y1, (j) => {
          const m = lead[j];
          if (!m || j === i) return true;
          if (Math.abs(m.x1 - L.x1) < 1e-6 && Math.abs(m.y1 - L.y1) < 1e-6) return true; // same store location
          if (segCross(L.x1, L.y1, L.x2, L.y2, m.x1, m.y1, m.x2, m.y2)) { cost += W.cross; if (cost >= bound) return false; }
          return true;
        });
        if (cost >= bound) return cost;
        markersNear(x0, y0, x1, y1, (j) => {
          if (j === i) return true;
          const o = nodes[j];
          const hit = circle ? segCircle(L.x1, L.y1, L.x2, L.y2, px[j], py[j], o.w / 2)
            : segRect(L.x1, L.y1, L.x2, L.y2, px[j], py[j], o.w / 2, o.h / 2);
          if (hit) { cost += W.through; if (cost >= bound) return false; }
          return true;
        });
        if (cost >= bound) return cost;
      }
      // 2b. a grouped logo: another marker between it and its stores, or under its spokes, would
      //     make its dots read as that other logo's.
      if (nd.pts && nd.pts.length > 1) {
        const under = (x2, y2, w) => {
          let hits = 0;
          markersNear(Math.min(c.x, x2), Math.min(c.y, y2), Math.max(c.x, x2), Math.max(c.y, y2), (j) => {
            if (j === i) return true;
            const o = nodes[j];
            if (circle ? segCircle(c.x, c.y, x2, y2, px[j], py[j], o.w / 2) : segRect(c.x, c.y, x2, y2, px[j], py[j], o.w / 2, o.h / 2)) hits++;
            return true;
          });
          return hits * w;
        };
        cost += under(nd.ax, nd.ay, W.groupBlock);
        if (cost >= bound) return cost;
        const sp = c.sp || [];
        for (let t = 0; t < sp.length; t++) {
          cost += under(nd.pts[sp[t]].x, nd.pts[sp[t]].y, W.spoke);
          if (cost >= bound) return cost;
        }
      }
      // 3. placed leaders passing under this marker
      leadersNear(c.x - hw, c.y - hh, c.x + hw, c.y + hh, (j) => {
        const m = lead[j];
        if (!m || j === i) return true;
        const hit = circle ? segCircle(m.x1, m.y1, m.x2, m.y2, c.x, c.y, hw) : segRect(m.x1, m.y1, m.x2, m.y2, c.x, c.y, hw, hh);
        if (hit) { cost += W.through; if (cost >= bound) return false; }
        return true;
      });
      return cost;
    }
    function best(i, current) {
      let bestC = current || null, bestCost = current ? evaluate(i, current, Infinity) : Infinity;
      const list = cands[i];
      for (let t = 0; t < list.length; t++) {
        const c = list[t];
        if (c === current) continue;
        if (c.s >= bestCost) break;           // sorted by static cost → nothing better follows
        const v = evaluate(i, c, bestCost);
        if (v < bestCost - 1e-9) { bestCost = v; bestC = c; }
      }
      return { c: bestC, cost: bestCost };
    }

    // Fixed (manual) markers first: they are obstacles for everyone else.
    const chosen = new Array(n);
    for (let i = 0; i < n; i++) {
      const f = nodes[i].fixed;
      if (!f) continue;
      const hw = nodes[i].w / 2, hh = nodes[i].h / 2;
      const x = U.clamp(f.x, M + hw, Math.max(M + hw, FW - M - hw)), y = U.clamp(f.y, M + hh, Math.max(M + hh, FH - M - hh));
      const ld = leaderOf(nodes[i], x, y);
      const c = { x: x, y: y, s: 0, idx: -1, def: false, l: ld.l, f: ld.f, sp: null };
      chosen[i] = c;
      add(i, c);
    }

    // Greedy, densest first (ties: higher on the frame first, then key).
    const order = [];
    const density = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (nodes[i].fixed) continue;
      const R = 2.5 * Math.max(nodes[i].w, nodes[i].h);
      let cnt = 0;
      anchorsIn(nodes[i].ax - R, nodes[i].ay - R, nodes[i].ax + R, nodes[i].ay + R, (a) => {
        if (a.o !== i && Math.hypot(a.x - nodes[i].ax, a.y - nodes[i].ay) < R) cnt++;
      });
      density[i] = cnt;
      order.push(i);
    }
    order.sort((a, b) => density[b] - density[a] || nodes[a].ay - nodes[b].ay || (nodes[a].key < nodes[b].key ? -1 : nodes[a].key > nodes[b].key ? 1 : a - b));
    const costs = new Float64Array(n);
    for (let t = 0; t < order.length; t++) {
      const i = order[t];
      const r = best(i, null);
      chosen[i] = r.c; costs[i] = r.cost;
      add(i, r.c);
    }
    // Improvement passes: re-place each marker against all the others, worst first (true cost now
    // that everyone is placed; stable tie-break on the greedy order). Then a short extra round for
    // markers still in trouble (overlap or a hidden dot), which often frees once neighbours moved.
    const passes = opts.passes === undefined ? 3 : opts.passes;
    const rank = new Float64Array(n);
    order.forEach((i, t) => { rank[i] = t; });
    const improve = (list) => {
      let moved = 0;
      for (let t = 0; t < list.length; t++) {
        const i = list[t];
        remove(i);
        const r = best(i, chosen[i]);
        if (r.c !== chosen[i]) moved++;
        chosen[i] = r.c; costs[i] = r.cost;
        add(i, r.c);
      }
      return moved;
    };
    const byCost = (list) => {
      const cur = new Float64Array(n);
      list.forEach((i) => { cur[i] = evaluate(i, chosen[i], Infinity); });
      return list.slice().sort((a, b) => cur[b] - cur[a] || rank[a] - rank[b]);
    };
    for (let p = 0; p < passes; p++) if (!improve(byCost(order))) break;
    for (let p = 0; p < 4; p++) {
      const bad = order.filter((i) => evaluate(i, chosen[i], Infinity) >= W.anchor);
      if (!bad.length) break;
      // Neighbours of troubled markers get re-placed too (they may be the ones blocking).
      const set = new Set(bad);
      bad.forEach((i) => markersNear(chosen[i].x - 2 * C, chosen[i].y - 2 * C, chosen[i].x + 2 * C, chosen[i].y + 2 * C, (j) => { if (!nodes[j].fixed) set.add(j); return true; }));
      if (!improve(byCost(order.filter((i) => set.has(i))))) break;
    }
    // Collapse: no free spot within the leader cap → a dot at the store instead of a logo far away.
    const collapsed = new Uint8Array(n);
    if (opts.collapse) {
      const overlaps = (i, x, y, j) => {
        const a = nodes[i], b = nodes[j];
        if (circle) return Math.hypot(px[j] - x, py[j] - y) < (a.w + b.w) / 2 - 0.01;
        return Math.abs(px[j] - x) < (a.w + b.w) / 2 - 0.01 && Math.abs(py[j] - y) < (a.h + b.h) / 2 - 0.01;
      };
      const hits = (i, x, y) => {
        const list = [], hw = nodes[i].w / 2, hh = nodes[i].h / 2;
        markersNear(x - hw, y - hh, x + hw, y + hh, (j) => { if (j !== i && overlaps(i, x, y, j)) list.push(j); return true; });
        return list;
      };
      const freq = {};
      for (let i = 0; i < n; i++) { const g = nodes[i].group || ''; freq[g] = (freq[g] || 0) + 1; }
      const lens = (i) => (chosen[i].l ? Math.hypot(chosen[i].l.x2 - chosen[i].l.x1, chosen[i].l.y2 - chosen[i].l.y1) : 0);
      const conflict = new Array(n);
      const collapseOverlapping = () => {
        let any = false;
        for (let i = 0; i < n; i++) conflict[i] = collapsed[i] ? new Set() : new Set(hits(i, px[i], py[i]));
        for (;;) {
          let pick = -1;
          for (let i = 0; i < n; i++) {
            if (collapsed[i] || nodes[i].fixed || nodes[i].keep || !conflict[i].size) continue;
            if (pick < 0) { pick = i; continue; }
            const a = conflict[i].size - conflict[pick].size;
            const b = (freq[nodes[i].group || ''] || 0) - (freq[nodes[pick].group || ''] || 0);
            const c = lens(i) - lens(pick);
            if (a > 0 || (a === 0 && (b > 0 || (b === 0 && (c > 1e-6 || (Math.abs(c) <= 1e-6 && nodes[i].key > nodes[pick].key)))))) pick = i;
          }
          if (pick < 0) return any;
          any = true;
          collapsed[pick] = 1;
          remove(pick);
          conflict[pick].forEach((j) => conflict[j].delete(pick));
          conflict[pick].clear();
        }
      };
      // Collapse, let the others settle closer to their stores now that there is room, repeat while
      // settling created new overlaps (rare), and finish with a plain collapse: zero overlaps.
      for (let round = 0; round < 3 && collapseOverlapping(); round++) {
        const near = order.filter((i) => !collapsed[i]);
        if (near.length) improve(byCost(near));
      }
      collapseOverlapping();
      // Give a logo back wherever one now fits (rare chains first) without touching another marker.
      const back = order.filter((i) => collapsed[i]).sort((a, b) => (freq[nodes[a].group || ''] || 0) - (freq[nodes[b].group || ''] || 0) || rank[a] - rank[b]);
      back.forEach((i) => {
        const r = best(i, null);
        if (r.c && !hits(i, r.c.x, r.c.y).length) { collapsed[i] = 0; chosen[i] = r.c; costs[i] = r.cost; add(i, r.c); }
      });
    }
    for (let i = 0; i < n; i++) {
      const c = chosen[i];
      if (collapsed[i]) { out[i] = { x: nodes[i].ax, y: nodes[i].ay, displaced: false, cost: 0, leader: null, collapsed: true, from: 0 }; continue; }
      out[i] = { x: c.x, y: c.y, displaced: !!nodes[i].fixed || !c.def, cost: costs[i] || 0, leader: c.l, collapsed: false, from: c.f || 0 };
    }
    return out;
  }

  /* ---- Same-chain grouping ------------------------------------------------------------------------
   * Stores of one chain whose dots are close merge into ONE marker with a count pip (theme
   * marker.declutter.aggregate). Complete linkage: every two stores of a group are within R, so a
   * group stays compact and its logo sits right above its dots. Pairs are merged closest first
   * (ties by store id): deterministic. Stores the user dragged on their own (markerOffsets without
   * `g`) keep their own logo; a group the user dragged (offset with g: 1 on one member) keeps its
   * place. Returns arrays of node indexes (≥ minCount stores each), ordered by their first key. */
  function clusterNodes(nodes, R, minCount) {
    const n = nodes.length;
    const ok = (i) => !nodes[i].fixed || nodes[i].gfix;
    const keyCmp = (a, b) => (nodes[a].key < nodes[b].key ? -1 : nodes[a].key > nodes[b].key ? 1 : a - b);
    const cell = Math.max(1, R), grid = new Map();
    const ck = (gx, gy) => gx + ',' + gy;
    for (let i = 0; i < n; i++) {
      if (!ok(i)) continue;
      const k = ck(Math.floor(nodes[i].ax / cell), Math.floor(nodes[i].ay / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const pairs = [];
    for (let i = 0; i < n; i++) {
      if (!ok(i)) continue;
      const gx = Math.floor(nodes[i].ax / cell), gy = Math.floor(nodes[i].ay / cell);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get(ck(gx + dx, gy + dy));
        if (!list) continue;
        for (let t = 0; t < list.length; t++) {
          const j = list[t];
          if (j <= i || (nodes[j].group || '') !== (nodes[i].group || '')) continue;
          const d = Math.hypot(nodes[j].ax - nodes[i].ax, nodes[j].ay - nodes[i].ay);
          if (d <= R) pairs.push(keyCmp(i, j) < 0 ? [d, i, j] : [d, j, i]);
        }
      }
    }
    pairs.sort((a, b) => a[0] - b[0] || keyCmp(a[1], b[1]) || keyCmp(a[2], b[2]));
    const comp = new Int32Array(n);
    const members = new Map();
    for (let i = 0; i < n; i++) { comp[i] = i; members.set(i, [i]); }
    const fixedIn = (list) => list.some((i) => nodes[i].gfix);
    pairs.forEach(([, i, j]) => {
      const ci = comp[i], cj = comp[j];
      if (ci === cj) return;
      const A = members.get(ci), B = members.get(cj);
      if (fixedIn(A) && fixedIn(B)) return;               // two groups the user placed stay apart
      for (let a = 0; a < A.length; a++) for (let b = 0; b < B.length; b++) {
        if (Math.hypot(nodes[A[a]].ax - nodes[B[b]].ax, nodes[A[a]].ay - nodes[B[b]].ay) > R) return;
      }
      B.forEach((k) => { comp[k] = ci; A.push(k); });
      members.delete(cj);
    });
    const groups = [];
    members.forEach((list) => { if (list.length >= Math.max(2, minCount || 2)) groups.push(list.slice().sort(keyCmp)); });
    groups.sort((a, b) => keyCmp(a[0], b[0]));
    return groups;
  }

  /**
   * Is a layout crowded enough to group nearby stores (theme aggregate.auto*)? Counted over the
   * markers placed automatically (a group counts once; its stores without a logo do not count).
   */
  function crowded(nodes, res, unit, agg, minStores) {
    let n = 0, long = 0, moved = 0;
    for (let i = 0; i < nodes.length; i++) {
      const p = res[i];
      if (nodes[i].fixed || p.grouped) continue;          // dragged by the user / no logo of its own
      n++;
      if (p.collapsed) { long++; moved++; continue; }
      if (p.displaced) moved++;
      if (p.leader && Math.hypot(p.leader.x2 - p.leader.x1, p.leader.y2 - p.leader.y1) > agg.autoLongRatio * unit) long++;
    }
    return n >= minStores && (long > agg.autoLongShare * n || moved > agg.autoDisplacedShare * n);
  }

  /**
   * How untidy a (grouped) layout reads: each logo whose leader is longer than autoLongRatio marker
   * sizes counts 1, each store whose dot is more than 2 marker sizes from its group's logo (a long
   * spoke) ½, each store shown as a dot for want of room 2. Lower is better.
   */
  function untidiness(nodes, res, unit, agg, circle) {
    let s = 0;
    const L = agg.autoLongRatio * unit, S = 2 * unit;
    for (let i = 0; i < nodes.length; i++) {
      const p = res[i];
      if (nodes[i].fixed || p.grouped) continue;
      if (p.collapsed) { s += 2; continue; }
      if (p.leader && Math.hypot(p.leader.x2 - p.leader.x1, p.leader.y2 - p.leader.y1) > L) s += 1;
      if (p.count > 1) {
        const pts = p.members.map((m) => ({ x: nodes[m].ax, y: nodes[m].ay }));
        groupTree(pts, p.x, p.y, nodes[i].w, nodes[i].h, circle).spokes.forEach((k) => {
          const l = leaderFor(circle, pts[k].x, pts[k].y, p.x, p.y, nodes[i].w, nodes[i].h);
          if (l && Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > S) s += 0.5;
        });
      }
    }
    return s;
  }

  /**
   * Lay out nodes with some of them merged into groups (arrays of node indexes). Returns per node:
   * the group's representative (the store whose dot the leader starts at — or the member the user
   * dragged the group by) carries the marker {x, y, leader, count, members, leaderFrom}; the other
   * members {grouped: true, rep} are only their dot; a group without room collapses into dots.
   */
  function placeGroups(nodes, groups, popts) {
    const inGroup = new Int32Array(nodes.length).fill(-1);
    groups.forEach((g, gi) => g.forEach((i) => { inGroup[i] = gi; }));
    const merged = [], back = [];
    nodes.forEach((nd, i) => { if (inGroup[i] < 0) { merged.push(nd); back.push({ i: i }); } });
    groups.forEach((g) => {
      const first = nodes[g[0]];
      const fx = g.find((i) => nodes[i].gfix);
      let cx = 0, cy = 0;
      g.forEach((i) => { cx += nodes[i].ax; cy += nodes[i].ay; });
      merged.push({ ax: cx / g.length, ay: cy / g.length, w: first.w, h: first.h, fixed: fx !== undefined ? nodes[fx].fixed : null,
        key: first.key, group: first.group, pts: g.map((i) => ({ x: nodes[i].ax, y: nodes[i].ay })) });
      back.push({ g: g, fx: fx });
    });
    const out = place(merged, popts);
    const res = new Array(nodes.length);
    out.forEach((p, m) => {
      const b = back[m];
      if (b.i !== undefined) { res[b.i] = p; return; }
      if (p.collapsed) { b.g.forEach((i) => { res[i] = { x: nodes[i].ax, y: nodes[i].ay, displaced: false, cost: 0, leader: null, collapsed: true }; }); return; }
      const from = b.g[p.from || 0];
      const rep = b.fx !== undefined ? b.fx : from;
      b.g.forEach((i) => {
        res[i] = i === rep ? Object.assign({}, p, { count: b.g.length, members: b.g, leaderFrom: from })
          : { x: nodes[i].ax, y: nodes[i].ay, displaced: false, cost: 0, leader: null, collapsed: false, grouped: true, rep: rep };
      });
    });
    return res;
  }

  /* ---- Overlap stats (for hints and tests) ---------------------------------------------------------- */
  function countOverlaps(items, gap) {
    gap = gap || 0;
    let n = 0;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.collapsed || b.collapsed || a.grouped || b.grouped) continue;   // store dots, not markers
      if (a.shape === 'circle' && b.shape === 'circle') {
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < a.w / 2 + b.w / 2 + gap - 0.01) n++;
      } else if (Math.abs(a.pos.x - b.pos.x) < (a.w + b.w) / 2 + gap - 0.01 && Math.abs(a.pos.y - b.pos.y) < (a.h + b.h) / 2 + gap - 0.01) n++;
    }
    return n;
  }

  /* ---- Names of the selected districts ------------------------------------------------------------------
   * They are the reader's main orientation (the subtitle lists them), so markers keep off the spot
   * where the basemap writes them. That spot is OSM's place point for the name, which only the map
   * tiles know: MT.mapview.basemap.harvestPlaces learns it whenever a map with those districts has
   * loaded (preview or export) into this persistent cache. Until then, the district's visual centre
   * stands in. The layout stays a deterministic function of (map config, data, cache). */
  const PLACES_PREF = 'layout.places';
  let placeCache = null;
  const places = {
    all() { if (!placeCache) placeCache = (MT.storage && MT.storage.pref(PLACES_PREF, {})) || {}; return placeCache; },
    get(ubigeo) { return places.all()[ubigeo] || null; },
    /** Merge harvested points {ubigeo: {ll, c}}; re-layout (event 'layout:places') when one changed. */
    set(found) {
      const all = places.all(), changed = [];
      Object.keys(found || {}).forEach((u) => {
        const f = found[u], old = all[u];
        if (!f || !Array.isArray(f.ll)) return;
        if (old && old.ll[0] === f.ll[0] && old.ll[1] === f.ll[1] && old.c === f.c) return;
        // Views at other zooms load other tiles: the same place point comes back a few metres off
        // (vector-tile quantization), or another point of that name shows up. The cache keeps its
        // point against the first and only moves to a better one (harvestPlaces' order: inside the
        // district, then the smaller coordinate key), so it settles whatever the order in which maps
        // are shown or exported — the layout (and an automatic view) must not drift between exports.
        if (old && !betterPlace(u, f, old)) return;
        all[u] = { ll: f.ll, c: f.c || '' };
        changed.push(u);
      });
      if (!changed.length) return false;
      if (MT.storage) MT.storage.setPref(PLACES_PREF, all);
      dataVersion++; memo.clear();
      MT.bus.emit('layout:places', { ubigeos: changed });
      return true;
    },
  };
  const PLACE_SAME_METERS = 30;
  function placeKey(ll) { return (+ll[0]).toFixed(5) + ',' + (+ll[1]).toFixed(5); }
  function placeInside(u, ll) { const d = MT.data.districts.locate(ll[1], ll[0]); return !!d && d.ubigeo === u; }
  /** Does the harvested place point f replace the cached one? (see places.set) */
  function betterPlace(u, f, old) {
    if (MT.geo.distanceMeters({ lat: f.ll[1], lng: f.ll[0] }, { lat: old.ll[1], lng: old.ll[0] }) < PLACE_SAME_METERS) return false;
    const inF = typeof f.inside === 'boolean' ? f.inside : placeInside(u, f.ll), inO = placeInside(u, old.ll);
    if (inF !== inO) return inF;
    return placeKey(f.ll) < placeKey(old.ll);
  }
  const labelPoints = {};
  /**
   * Point inside the district, as far as possible from its edges (grid search; cached). clip
   * ([w, s, e, n], optional): only its part inside that box, also kept away from the box's edges —
   * the visible part of a district whose centre is outside the frame (Lurín on "Lima Cono Sur").
   */
  function labelPoint(ubigeo, clip) {
    const ck = ubigeo + (clip ? '|' + clip.map((v) => v.toFixed(4)).join(',') : '');
    if (ck in labelPoints) return labelPoints[ck];
    let best = null;
    try {
      const f = MT.data.districts.feature(ubigeo);
      if (f) {
        const g = f.geometry;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        // Largest outer ring (by bbox area) carries the label.
        let poly = null, area = -1;
        polys.forEach((p) => {
          let b = MT.geo.bboxOfPoints(p[0]);
          if (clip) b = [Math.max(b[0], clip[0]), Math.max(b[1], clip[1]), Math.min(b[2], clip[2]), Math.min(b[3], clip[3])];
          const a = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
          if (a > area) { area = a; poly = p; }
        });
        if (poly && area > 0) {
          let b = MT.geo.bboxOfPoints(poly[0]);
          if (clip) b = [Math.max(b[0], clip[0]), Math.max(b[1], clip[1]), Math.min(b[2], clip[2]), Math.min(b[3], clip[3])];
          const N = 24, kx = Math.cos((b[1] + b[3]) / 2 * Math.PI / 180);
          const inRing = (x, y, ring) => {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
              if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
          };
          const edgeDist = (x, y) => {
            let d = clip ? Math.min((x - clip[0]) * kx, (clip[2] - x) * kx, y - clip[1], clip[3] - y) : Infinity;
            poly.forEach((ring) => {
              for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const ax = ring[j][0] * kx, ay = ring[j][1], bx = ring[i][0] * kx, by = ring[i][1], qx = x * kx;
                const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
                let t = l2 ? ((qx - ax) * vx + (y - ay) * vy) / l2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                d = Math.min(d, Math.hypot(ax + t * vx - qx, ay + t * vy - y));
              }
            });
            return d;
          };
          let bd = -1;
          for (let gy = 0; gy <= N; gy++) for (let gx = 0; gx <= N; gx++) {
            const x = b[0] + (b[2] - b[0]) * gx / N, y = b[1] + (b[3] - b[1]) * gy / N;
            if (!inRing(x, y, poly[0]) || poly.slice(1).some((h) => inRing(x, y, h))) continue;
            const d = edgeDist(x, y);
            if (d > bd) { bd = d; best = [x, y]; }
          }
        }
      }
    } catch (e) { best = null; }
    return (labelPoints[ck] = best);
  }
  /**
   * The selected districts' names on the map: [{ubigeo, name, ll, cls, look, app}]. The basemap
   * writes a district's name only when its tiles carry an OSM place of that name: a city / town /
   * village (Chimbote, Trujillo, Punta Hermosa) at any slide zoom, but a suburb (Chorrillos, Villa
   * El Salvador — most Lima districts) only from about zoom 11, so a zoomed-out slide would show
   * village names and none of the districts of its subtitle. And where the basemap writes a name,
   * a store right at its place point splits it ("Chimb•ote") or makes it vanish. So the app writes
   * every selected district's name ITSELF (`app: true`; MT.mapview's 'mt-district-labels' layers,
   * the basemap's own label of that name hidden), in the basemap's look for its place class
   * (`look`: 'city' | 'town' | 'village' — regular, above the point — or 'suburb' — positron's
   * district names, upper case, centred), at the harvested place point (a suburb's only when inside
   * the district) or the district's visual centre, moved a little off the store dots
   * (nameClearOfDots). Always drawn (never left out for a logo). Deterministic: a function of
   * (config, data, place cache).
   */
  const BASEMAP_PLACE_CLASSES = ['city', 'town', 'village'];
  const insideCache = {};
  const nameMemo = new Map();
  function districtLabels(mapCfg, view) {
    if (!mapCfg || !MT.data.districts.available) return [];
    view = view || viewFor(mapCfg);
    const key = JSON.stringify([dataVersion, view.center, view.zoomRef, mapCfg.districts, mapCfg.chains, mapCfg.onlyInside, mapCfg.hiddenStores, mapCfg.analysis]);
    if (nameMemo.has(key)) return nameMemo.get(key).map((l) => Object.assign({}, l, { ll: l.ll.slice() }));
    const out = districtLabelsOf(mapCfg, view);
    if (nameMemo.size >= 24) nameMemo.delete(nameMemo.keys().next().value);
    nameMemo.set(key, out);
    return out.map((l) => Object.assign({}, l, { ll: l.ll.slice() }));
  }
  function districtLabelsOf(mapCfg, view) {
    const out = [], taken = [];
    let clip = null, fr = null, proj = null;
    (mapCfg.districts || []).forEach((u) => {
      const d = MT.data.districts.get(u);
      if (!d) return;
      const hit = places.get(u);
      const look = hit && BASEMAP_PLACE_CLASSES.indexOf(hit.c) >= 0 ? hit.c : 'suburb';
      const app = look === 'suburb';          // (named like a suburb: place point checked, visible part)
      let ll = hit ? hit.ll : null;
      if (ll && app) {
        const key = u + '|' + placeKey(ll);
        if (!(key in insideCache)) insideCache[key] = placeInside(u, ll);
        if (!insideCache[key]) ll = null;
      }
      if (!ll) {
        ll = labelPoint(u);
        // Its centre is outside the frame: name the visible part (kept away from the frame's edges).
        if (ll && app) {
          if (!proj) {
            fr = frame(); proj = projector(view, fr);
            const un = unprojector(view, fr), a = un({ x: 0, y: 0 }), b = un({ x: fr.width, y: fr.height });
            clip = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
          }
          const p = proj(ll);
          if (p.x < 0 || p.y < 0 || p.x > fr.width || p.y > fr.height) ll = labelPoint(u, clip) || ll;
        }
      }
      if (!ll) return;
      // Off the store dots.
      const F = frame();
      ll = nameClearOfDots({ name: String(d.district), look: look }, ll, storeDots(mapCfg, view, F), view, F, taken);
      out.push({ ubigeo: u, name: String(d.district), ll: [ll[0], ll[1]], cls: hit ? hit.c : '', look: look, app: true, guessed: !hit });
    });
    return out;
  }
  /* ---- Main avenue names (data/road-names.js) ----------------------------------------------------------
   * The tiles name most main avenues only from zoom 14. For the cities in window.MT_ROAD_NAMES the
   * app writes them itself below that zoom — ONE label per avenue, on the stretch of it that suits
   * a slide best: straight enough for the text, clear of the store dots and of the spot right above
   * each dot where its logo goes by default, of the selected districts' names, of the frame's edges
   * and of the other avenue names; the most central such stretch of the avenue's visible part.
   * → [{name, line: [[lng, lat]…]}] (MT.mapview draws it with 'line-center' placement, so the label
   * sits exactly there). Deterministic: a function of (config, view, data); memoized. */
  const roadMemo = new Map();
  function roadLabels(mapCfg, view) {
    const rn = window.MT_ROAD_NAMES, mr = MT.theme.basemap.majorRoadNames;
    if (!mapCfg || !rn || !Array.isArray(rn.features) || !mr) return [];
    view = view || viewFor(mapCfg);
    const zb = view.zoomRef + Math.log2(BASEMAP_WIDTH / 1000);
    if (zb < mr.minzoom || zb >= (rn.maxzoom || 14)) return [];
    const key = JSON.stringify([dataVersion, view.center, view.zoomRef, mapCfg.districts, mapCfg.chains, mapCfg.onlyInside, mapCfg.hiddenStores, mapCfg.markerStyle, mapCfg.markerSize, mapCfg.analysis]);
    if (roadMemo.has(key)) return roadMemo.get(key);
    const out = roadLabelsOf(mapCfg, view, zb, rn, mr);
    if (roadMemo.size >= 24) roadMemo.delete(roadMemo.keys().next().value);
    roadMemo.set(key, out);
    return out;
  }
  function roadLabelsOf(mapCfg, view, zb, rn, mr) {
    const fr = frame(), proj = projector(view, fr), un = unprojector(view, fr), k = 1000 / BASEMAP_WIDTH;
    const c = view.center, bb = [Infinity, Infinity, -Infinity, -Infinity];
    const tl = un({ x: 0, y: 0 }), br = un({ x: fr.width, y: fr.height });
    bb[0] = Math.min(tl[0], br[0]); bb[2] = Math.max(tl[0], br[0]); bb[1] = Math.min(tl[1], br[1]); bb[3] = Math.max(tl[1], br[1]);
    if (!rn.regions.some((r) => c[0] >= r.bbox[0] && c[0] <= r.bbox[2] && c[1] >= r.bbox[1] && c[1] <= r.bbox[3])) return [];
    const px = interp(zb, mr.size.map((s) => s[0]), mr.size.map((s) => s[1]));       // text size, basemap px
    const halfH = px * 0.6 * k, M = 10, dotR = MT.theme.marker.anchorDot.radius + 3;
    // Keep-out boxes: the store dots (their logos then keep off the name: W.roadName), the
    // selected districts' names, the attribution.
    const boxes = [];
    storeDots(mapCfg, view, fr).forEach((d) => boxes.push({ x: d.x - dotR, y: d.y - dotR, w: 2 * dotR, h: 2 * dotR }));
    districtLabelBoxes(mapCfg, proj, view, fr, { estimate: true }).forEach((b) => boxes.push(b));
    boxes.push(attributionBox().obstacle);
    // An analysis slide: its ring pills and reference pin (none on ordinary slides).
    analysisBoxes(mapCfg, proj).forEach((b) => boxes.push(b));
    const hit = (p) => boxes.some((b) => p.x > b.x - halfH && p.x < b.x + b.w + halfH && p.y > b.y - halfH && p.y < b.y + b.h + halfH);
    // Softer: the spot right above each store, where its logo goes by default — a stretch clear of
    // those too leaves the logos where they are.
    const st = styleOf(mapCfg), md = MT.theme.markerDims(st.kind === 'dot' ? 'badge' : st.kind, st.size), stem = MT.theme.marker.stem * Math.sqrt(st.size);
    const spots = st.kind === 'dot' ? [] : storeDots(mapCfg, view, fr).map((d) => ({ x: d.x - md.w / 2, y: d.y - stem - md.h, w: md.w, h: md.h }));
    const near = (p) => spots.some((b) => p.x > b.x - halfH && p.x < b.x + b.w + halfH && p.y > b.y - halfH && p.y < b.y + b.h + halfH);
    // Roads by name (a name may come in several classes); main ones first, then the longest.
    const rank = { motorway: 0, trunk: 1, primary: 2 }, byName = new Map();
    rn.features.forEach((f) => {
      const name = f.properties && f.properties.name;
      if (!name) return;
      const lines = f.geometry.coordinates.filter((l) => l.some((q) => q[0] >= bb[0] && q[0] <= bb[2] && q[1] >= bb[1] && q[1] <= bb[3]));
      if (!lines.length) return;
      const e = byName.get(name) || byName.set(name, { name: name, rank: 9, lines: [] }).get(name);
      e.rank = Math.min(e.rank, rank[f.properties.class] === undefined ? 3 : rank[f.properties.class]);
      lines.forEach((l) => e.lines.push(l));
    });
    const step = 4;                                          // resampling step (reference units)
    const roads = [...byName.values()].map((e) => {
      // Projected, resampled pieces inside the frame (minus a margin).
      const pieces = [];
      e.lines.forEach((l) => {
        let cur = [];
        const flush = () => { if (cur.length > 1) pieces.push(cur); cur = []; };
        for (let i = 0; i + 1 < l.length; i++) {
          const a = proj(l[i]), b = proj(l[i + 1]), n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
          for (let s = 0; s < n; s++) {
            const p = { x: a.x + (b.x - a.x) * s / n, y: a.y + (b.y - a.y) * s / n };
            if (p.x < M || p.y < M || p.x > fr.width - M || p.y > fr.height - M) flush(); else cur.push(p);
          }
        }
        const last = proj(l[l.length - 1]);
        if (last.x >= M && last.y >= M && last.x <= fr.width - M && last.y <= fr.height - M) cur.push(last);
        flush();
      });
      const length = pieces.reduce((s, p) => s + (p.length - 1) * step, 0);
      return { name: e.name, rank: e.rank, pieces: pieces, length: length };
    }).filter((r) => r.length > 0).sort((a, b) => a.rank - b.rank || b.length - a.length || (a.name < b.name ? -1 : 1));
    const out = [];
    roads.forEach((r) => {
      // "Av. Javier Prado Este": a shorter label fits between more stores (usual Peruvian usage).
      const text = r.name.replace(/^Avenida\s+/i, 'Av. ');
      const len = (text.length * 0.52 * px + 12) * k;      // the text along the line (+ room), reference units
      const n = Math.ceil(len / step) + 1;
      let best = null;
      r.pieces.forEach((pc) => {
        if (pc.length < n) return;
        const mid = (pc.length - 1) / 2;
        // Samples in a keep-out box, as prefix sums (a window is clear when its count is 0).
        const pre = new Int32Array(pc.length + 1), soft = new Int32Array(pc.length + 1);
        for (let i = 0; i < pc.length; i++) { pre[i + 1] = pre[i] + (hit(pc[i]) ? 1 : 0); soft[i + 1] = soft[i] + (near(pc[i]) ? 1 : 0); }
        const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
        for (let s = 0; s + n <= pc.length; s += 2) {
          if (pre[s + n] - pre[s]) continue;
          const w = pc.slice(s, s + n);
          // Straight enough for the text: close to its chord, and the first and last thirds run
          // in about the same direction (the geometry's small zig-zags do not count).
          const a0 = w[0], a1 = w[w.length - 1], cl = Math.hypot(a1.x - a0.x, a1.y - a0.y);
          if (cl < len * 0.85) continue;
          let dev = 0;
          for (let i = 1; i < w.length - 1; i++) dev = Math.max(dev, Math.abs((a1.x - a0.x) * (a0.y - w[i].y) - (a0.x - w[i].x) * (a1.y - a0.y)) / cl);
          const t3 = Math.floor(w.length / 3);
          let d = Math.abs(ang(w[0], w[t3]) - ang(w[w.length - 1 - t3], w[w.length - 1]));
          if (d > Math.PI) d = 2 * Math.PI - d;
          if (dev > Math.max(6, len * 0.06) || d > 0.45) continue;
          const score = (soft[s + n] - soft[s]) / n + Math.abs(s + n / 2 - mid) / Math.max(1, pc.length) - pc.length * step / 4000;
          if (!best || score < best.score - 1e-9) best = { score: score, w: w, pc: pc, s: s };
        }
      });
      if (!best) return;
      // Keep the next names off this one.
      const xs = best.w.map((p) => p.x), ys = best.w.map((p) => p.y);
      boxes.push({ x: Math.min.apply(null, xs) - 4, y: Math.min.apply(null, ys) - halfH, w: Math.max.apply(null, xs) - Math.min.apply(null, xs) + 8, h: Math.max.apply(null, ys) - Math.min.apply(null, ys) + 2 * halfH });
      // The line handed to MapLibre: the same road, centred on this stretch and long enough that the
      // text fits at the tile's integer zoom too (where the line is up to 2× shorter than on the
      // slide) — 'line-center' then writes the name right on the stretch kept clear for it.
      const need = Math.ceil(n * Math.pow(2, zb - Math.floor(zb)) * 1.2 / 2);
      const pc = best.pc, mid = best.s + Math.floor(n / 2);
      const h = Math.min(need, mid, pc.length - 1 - mid);
      let w = pc.slice(mid - h, mid + h + 1);
      if (h < need) {                                    // too close to an end: extend straight on
        const ext = (a, b, m) => { const dx = (a.x - b.x), dy = (a.y - b.y), d = Math.hypot(dx, dy) || 1; return { x: a.x + dx / d * step * m, y: a.y + dy / d * step * m }; };
        w = [ext(w[0], w[Math.min(4, w.length - 1)], need - h)].concat(w, [ext(w[w.length - 1], w[Math.max(0, w.length - 5)], need - h)]);
      }
      // Left to right, so the text reads upright.
      if (w[w.length - 1].x < w[0].x) w = w.slice().reverse();
      out.push({ name: text, line: w.filter((p, i) => i % 3 === 0 || i === w.length - 1).map((p) => { const q = un(p); return [U.round(q[0], 6), U.round(q[1], 6)]; }) });
    });
    return out;
  }

  /** The MT.mapview layer that writes a selected district's name in a look. */
  const NAME_LAYER = 'mt-district-labels';
  function nameLayer(look) { return look && look !== 'suburb' ? NAME_LAYER + '-' + look : NAME_LAYER; }
  /** Text size (basemap px) of a district name at basemap zoom zb (theme basemap.districtLabel.size). */
  function districtLabelPx(zb) {
    const stops = (MT.theme.basemap.districtLabel && MT.theme.basemap.districtLabel.size) || [[8, 10], [12, 12.5], [15, 14]];
    return interp(zb, stops.map((s) => s[0]), stops.map((s) => s[1]));
  }
  /**
   * Boxes (reference units) where the selected districts' names are written, inside the frame:
   * [{ubigeo, label, x, y, w, h, guessed, app, exact}]. Sizes follow positron: district names
   * ("label_other" style, which the app's own names copy: upper case, centred on the point, wrapping
   * at 9 em) and town / village / city names (regular, above the point). When the rendered map's
   * labels are known for this view (labels cache, below) the exact box is used (`exact`); otherwise
   * an estimate measured with the UI font. o.estimate: estimates only (the automatic view uses them:
   * the harvested labels belong to one view). `guessed` = no harvested place point yet.
   */
  function districtLabelBoxes(mapCfg, project, view, fr, o) {
    const out = [];
    if (!MT.data.districts.available || !mapCfg) return out;
    fr = fr || frame();
    const zb = view.zoomRef + Math.log2(BASEMAP_WIDTH / 1000);          // basemap zoom
    if (zb < 8) return out;
    const harvested = o && o.estimate ? null : labels.get(mapCfg, view);
    districtLabels(mapCfg, view).forEach((L) => {
      const p = project(L.ll);
      if (p.x < 0 || p.y < 0 || p.x > fr.width || p.y > fr.height) return;
      let box = estimateNameBox(L, p, zb);
      const ex = harvested ? matchLabel(harvested, box, [nameLayer(L.look)]) : null;
      if (ex) box = { x: ex.x - 3, y: ex.y - 3, w: ex.w + 6, h: ex.h + 6 };
      out.push({ ubigeo: L.ubigeo, label: L.name, x: box.x, y: box.y, w: box.w, h: box.h, guessed: L.guessed, app: L.app, exact: !!ex });
    });
    return out;
  }
  /**
   * Estimated box (reference units) of a district name L ({name, app, cls}) written at the projected
   * point p, at basemap zoom zb. Sizes follow positron: district names ("label_other" style, which
   * the app's own names copy: upper case, centred on the point, wrapping at 9 em) and town /
   * village / city names (regular, above the point).
   */
  function estimateNameBox(L, p, zb, approx) {
    const k = 1000 / BASEMAP_WIDTH;                                        // basemap px → reference units
    const cls = L.look || 'suburb';
    let px, upper = false, above = false;
    if (cls === 'city') { px = interp(zb, [4, 7, 11], [11, 13, 18]); above = true; }
    else if (cls === 'town') { px = interp(zb, [7, 11], [12, 14]); above = true; }
    else if (cls === 'village') { px = interp(zb, [7, 11], [10, 12]); above = true; }
    else { px = districtLabelPx(zb); upper = true; }
    const font = (upper ? 'italic 500 ' : '400 ') + px + 'px ' + MT.theme.fonts.ui;
    // approx: a per-character width (no canvas metrics: the same whether or not a web font has
    // loaded yet — the name's position must not depend on that).
    const measure = approx ? (t) => t.length * (upper ? 0.53 : 0.48) * px : (t) => textWidth(t, font);
    const text = upper ? L.name.toUpperCase() : L.name;
    const words = text.split(/\s+/), lines = [''];
    words.forEach((w) => { const t = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + w : w; if (lines[lines.length - 1] && measure(t) > (upper ? 9 : 8) * px) lines.push(w); else lines[lines.length - 1] = t; });
    const tw = Math.max.apply(null, lines.map((l) => measure(l) + (upper ? l.length * 0.06 * px : 0)));
    // A little margin: the basemap's font (Noto Sans) is a little wider than ours, and a logo
    // brushing the first or last letter still hides the name.
    const w = (tw * 1.04 + 6) * k, h = (lines.length * px * 1.25 + 4) * k;
    return { x: p.x - w / 2, y: above ? p.y - h : p.y - h / 2, w: w, h: h };
  }

  /**
   * A district name the app writes keeps off the store dots: when its box (estimated) would hold
   * one — a dot splitting "CH|ORRILLOS" — it moves a little (up / down by most of a line, or
   * sideways by a quarter of its width), staying inside the frame; the first clear spot wins, else
   * the one with the fewest dots. Stores only (no layout: the declutter then keeps logos off the
   * name). → [lng, lat].
   */
  const NAME_SHIFTS = [[0, 0], [0, -0.8], [0, 0.8], [-0.25, 0], [0.25, 0], [0, -1.5], [0, 1.5], [-0.25, -0.8], [0.25, -0.8], [-0.25, 0.8], [0.25, 0.8],
    [-0.5, 0], [0.5, 0], [0, -2.2], [0, 2.2], [-0.5, -0.8], [0.5, -0.8], [-0.5, 0.8], [0.5, 0.8], [-0.75, 0], [0.75, 0]];
  const NAME_NEAR = 13;
  function nameClearOfDots(L, ll, dots, view, fr, taken) {
    if (!dots.length) return ll;
    const proj = projector(view, fr), un = unprojector(view, fr);
    const zb = view.zoomRef + Math.log2(BASEMAP_WIDTH / 1000);
    const p = proj(ll), b0 = estimateNameBox(L, p, zb, true);
    const r = MT.theme.marker.anchorDot.radius + 2.5, m = LABEL_MARGIN;
    // A dot on the letters splits the name (2); one in the box's margin touches it (0.5), one just
    // around it hardly matters (0.05).
    // Moving costs too (0.5 a line height or a quarter width): the name stays near its place. A name
    // next to another one already placed (`taken`) would read as one ("CHORRILLOS MIRAFLORES"): +3.
    let best = null, bestC = Infinity;
    for (let s = 0; s < NAME_SHIFTS.length; s++) {
      // The farther spots only when every near one puts a dot on the letters.
      if (s === NAME_NEAR && bestC < 2) break;
      const sx = NAME_SHIFTS[s][0], sy = NAME_SHIFTS[s][1], dx = sx * b0.w, dy = sy * b0.h;
      const b = { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h };
      if (s && (b.x < m || b.y < m || b.x + b.w > fr.width - m || b.y + b.h > fr.height - m)) continue;
      let c = 0.5 * (Math.abs(sx) * 4 + Math.abs(sy));
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        if (!(d.x > b.x - r && d.x < b.x + b.w + r && d.y > b.y - r && d.y < b.y + b.h + r)) continue;
        const inside = Math.min(d.x - b.x, b.x + b.w - d.x, d.y - b.y, b.y + b.h - d.y);
        c += inside > 3 ? 2 : inside > 0 ? 0.5 : 0.05;
      }
      (taken || []).forEach((t) => { if (b.x < t.x + t.w + b0.h && b.x + b.w > t.x - b0.h && b.y < t.y + t.h + b0.h / 2 && b.y + b.h > t.y - b0.h / 2) c += 3; });
      if (c < bestC - 1e-9) { bestC = c; best = [dx, dy]; }
    }
    if (taken) taken.push({ x: b0.x + (best ? best[0] : 0), y: b0.y + (best ? best[1] : 0), w: b0.w, h: b0.h });
    if (!best || (!best[0] && !best[1])) return ll;
    const q = un({ x: p.x + best[0], y: p.y + best[1] });
    return [U.round(q[0], 6), U.round(q[1], 6)];
  }
  /** Projected store locations of a map in a view (inside the frame), memoized per data version. */
  const dotMemo = new Map();
  function storeDots(mapCfg, view, fr) {
    const key = JSON.stringify([dataVersion, view.center, view.zoomRef, mapCfg.districts, mapCfg.chains, mapCfg.onlyInside, mapCfg.hiddenStores, mapCfg.analysis]);
    if (dotMemo.has(key)) return dotMemo.get(key);
    const proj = projector(view, fr), out = [];
    try {
      MT.data.storesForMap(mapCfg).forEach((s) => {
        if (!isFinite(s.lat) || !isFinite(s.lng)) return;
        const a = proj([s.lng, s.lat]);
        if (a.x >= 0 && a.x <= fr.width && a.y >= 0 && a.y <= fr.height) out.push(a);
      });
    } catch (e) { /* no store data: nothing to avoid */ }
    if (dotMemo.size >= 24) dotMemo.delete(dotMemo.keys().next().value);
    dotMemo.set(key, out);
    return out;
  }

  /** The harvested label of one of `layers` closest to an estimated box (centre within ~its size). */
  function matchLabel(list, box, layers) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, lim = Math.max(box.w, box.h) * 0.75;
    let best = null, bd = Infinity;
    list.forEach((b) => {
      if (layers.indexOf(b.l) < 0 || b.parts) return;
      const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
      if (d < lim && d < bd) { bd = d; best = b; }
    });
    return best;
  }
  function interp(z, zs, vs) {
    if (z <= zs[0]) return vs[0];
    for (let i = 1; i < zs.length; i++) if (z <= zs[i]) return vs[i - 1] + (vs[i] - vs[i - 1]) * (z - zs[i - 1]) / (zs[i] - zs[i - 1]);
    return vs[vs.length - 1];
  }

  /* ---- The rendered map's labels (per view) -------------------------------------------------------------
   * Where the basemap actually wrote its labels (street, village, water names, road shields and the
   * app's district names): MT.mapview.basemap.harvestLabels reads MapLibre's collision boxes after a
   * render of a map config's own view (preview or export) — same CSS size and zoom, so the same
   * boxes. They are soft obstacles for the declutter and give the selected districts' exact boxes.
   * Keyed by view + the app-written names (they change where the basemap's labels go); a small
   * persistent LRU, so a reload starts with the final layout. Entries: {l: layer id, x, y, w, h,
   * parts?} in reference units (`parts` = the boxes of a label placed along a line). */
  const LABELS_PREF = 'layout.labels', LABELS_MAX = 24;
  let labelStore = null;
  function labelSig(mapCfg, view) {
    return districtLabels(mapCfg, view).filter((l) => l.app).map((l) => l.name + '@' + (l.look || '') + '@' + placeKey(l.ll))
      .concat(roadLabels(mapCfg, view).map((r) => r.name + '@' + placeKey(r.line[0])))
      .join(';');
  }
  const labels = {
    /** Signature of the district names the app writes for a config (they move the basemap's labels). */
    sig(mapCfg, view) { return mapCfg ? labelSig(mapCfg, view) : ''; },
    key(mapCfg, view) {
      return [(+view.center[0]).toFixed(6), (+view.center[1]).toFixed(6), (+view.zoomRef).toFixed(4), labelSig(mapCfg, view)].join('|');
    },
    store() {
      if (!labelStore) {
        const s = MT.storage ? MT.storage.pref(LABELS_PREF, null) : null;
        labelStore = s && Array.isArray(s.order) && s.map && typeof s.map === 'object' ? s : { order: [], map: {} };
      }
      return labelStore;
    },
    get(mapCfg, view) { return (mapCfg && view && labels.store().map[labels.key(mapCfg, view)]) || null; },
    /** Save the labels of a rendered view; re-layout (event 'layout:places') when they changed. */
    set(mapCfg, view, list) {
      const st = labels.store(), key = labels.key(mapCfg, view);
      if (JSON.stringify(st.map[key] || null) === JSON.stringify(list)) return false;
      st.map[key] = list;
      st.order = st.order.filter((x) => x !== key).concat(key);
      while (st.order.length > LABELS_MAX) delete st.map[st.order.shift()];
      if (MT.storage) MT.storage.setPref(LABELS_PREF, st);
      dataVersion++; memo.clear();
      MT.bus.emit('layout:places', { labels: true });
      return true;
    },
  };
  /** Soft obstacles of a view: the harvested labels inside the frame (district names excluded — they are hard obstacles). */
  function softLabels(mapCfg, view, fr) {
    const list = labels.get(mapCfg, view);
    if (!list) return [];
    return list.filter((b) => String(b.l).indexOf(NAME_LAYER) !== 0 && b.x < fr.width && b.y < fr.height && b.x + b.w > 0 && b.y + b.h > 0);
  }
  /** The "1 km" pills of the map's radius circles (same geometry as MT.radius.drawLabels). */
  function radiusLabelBoxes(mapCfg, project, fr) {
    if (!mapCfg || !(mapCfg.radius || []).length || !MT.radius) return [];
    const fs = MT.theme.pt2ref(MT.theme.radius.label.sizePt), font = MT.radius.labelFont(fs);
    return MT.radius.labels(MT.radius.compute(mapCfg), project).map((l) => {
      const w = textWidth(l.text, font) + fs * 0.9, h = fs * 1.45;
      const x = U.clamp(l.x, w / 2 + 2, fr.width - w / 2 - 2), y = U.clamp(l.y, h / 2 + 2, fr.height - h / 2 - 2);
      return { x: x - w / 2 - 2, y: y - h / 2 - 2, w: w + 4, h: h + 4 };
    });
  }

  /* ---- Analysis slides (SPEC §6.3) ------------------------------------------------------------------
   * A map config with `analysis` draws, over its map: the reference (a pin for a point — or for a
   * store that is not drawn on the slide; a store on the slide keeps its logo, drawn with a halo),
   * concentric rings around it (thin dashed MapLibre lines, MT.mapview) labelled "500 m", "1 km"…
   * in pills, and faint lines to the nearest store of each chain. analysisGeometry() says where, in
   * the config's OWN view: the pills sit on their ring at the bearing that keeps them off the store
   * dots, the spots right above the dots where the logos go by default, the district names, the
   * attribution, the pin and each other (preferring the top of the ring and the previous ring's
   * bearing, so they line up). The declutter then treats the pills and the pin as obstacles
   * (analysisBoxes), so logos keep off them. Pure and deterministic; memoized per (config, view,
   * data). Distances on the slide are es-PE slide text (MT.legend.distance: "500 m", "1.5 km"; ring pills
   * show the typed value, MT.legend.ringLabel: "1.25 km"). */
  const anaMemo = new Map();
  // Bearings tried for a ring's pill: straight up first, then alternating right / left (15° steps).
  const RING_BEARINGS = [0];
  for (let d = 15; d <= 180; d += 15) { RING_BEARINGS.push(d); if (d < 180) RING_BEARINGS.push(-d); }
  function ringLabelFont(fs) { return '700 ' + fs + 'px ' + MT.theme.fonts.slideCss; }
  /** Size (reference units) of a ring pill for its text: same proportions as the radius pills. */
  function ringPill(text) {
    const lab = (MT.theme.analysis.ring || {}).label || { sizePt: 9 };
    const fs = MT.theme.pt2ref(lab.sizePt || 9);
    return { fs: fs, w: textWidth(text, ringLabelFont(fs)) + fs * 0.9, h: fs * 1.45 };
  }
  /** Room (reference units, per side) the reference store's halo takes around its marker. */
  function refHaloPad(size) {
    const H = MT.theme.analysis.halo || { gap: 1.8, width: 3, casingWidth: 1.4 };
    return ((H.gap || 0) + (H.width || 0) + (H.casingWidth || 0)) * Math.sqrt(size || 1);
  }
  /** Box (reference units, top-left + size) of the reference pin whose tip is at (x, y). */
  function pinBox(x, y) {
    const P = MT.theme.analysis.pin || { width: 30, height: 40, haloWidth: 2 };
    const hw = (P.haloWidth || 0) + 1;
    return { x: x - P.width / 2 - hw, y: y - P.height - hw, w: P.width + 2 * hw, h: P.height + hw * 1.6 };
  }
  function analysisGeometry(mapCfg, view) {
    if (!mapCfg || !mapCfg.analysis || typeof mapCfg.analysis !== 'object' || !MT.analysis) return null;
    view = view || viewFor(mapCfg);
    const key = JSON.stringify([dataVersion, view.center, view.zoomRef, mapCfg.analysis, mapCfg.districts, mapCfg.chains, mapCfg.onlyInside,
      mapCfg.hiddenStores, mapCfg.markerStyle, mapCfg.markerSize]);
    if (anaMemo.has(key)) return anaMemo.get(key);
    let out = null;
    try { out = analysisGeometryOf(mapCfg, view); } catch (e) { console.warn('[layout] analysis', e); out = null; }
    if (anaMemo.size >= 24) anaMemo.delete(anaMemo.keys().next().value);
    anaMemo.set(key, out);
    return out;
  }
  function analysisGeometryOf(mapCfg, view) {
    const fa = MT.analysis.forMap(mapCfg);
    if (!fa || !fa.ref) return null;
    const fr = frame(), proj = projector(view, fr);
    const ref = fa.ref, ll = [ref.lng, ref.lat], p = proj(ll);
    const inFrame = (q) => q.x >= 0 && q.y >= 0 && q.x <= fr.width && q.y <= fr.height;
    // A reference store drawn on the slide keeps its logo (with a halo); otherwise a pin marks it.
    const storeId = ref.type === 'store' && !ref.missing ? ref.storeId : null;
    let onSlide = false;
    if (storeId && inFrame(p)) onSlide = MT.data.storesForMap(mapCfg).some((s) => s.id === storeId);
    const pin = !onSlide && inFrame(p) ? { ll: ll, x: p.x, y: p.y, box: pinBox(p.x, p.y) } : null;
    // Keep-out boxes for the pills (reference units).
    const st = styleOf(mapCfg), dotR = MT.theme.marker.anchorDot.radius * Math.sqrt(st.size) + 2;
    const dots = storeDots(mapCfg, view, fr);
    const md = MT.theme.markerDims(st.kind === 'dot' ? 'badge' : st.kind, st.size), stem = MT.theme.marker.stem * Math.sqrt(st.size);
    const spots = st.kind === 'dot' ? [] : dots.map((d) => ({ x: d.x - md.w / 2, y: d.y - stem - md.h, w: md.w, h: md.h }));
    const names = districtLabelBoxes(mapCfg, proj, view, fr, { estimate: true });
    const ab = attributionBox().obstacle;
    const lines = fa.lines.map((r) => ({ storeId: r.store.id, chainId: r.store.chain, meters: r.meters, to: proj([r.store.lng, r.store.lat]) }));
    const over = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const share = (a, b) => {
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return ix > 0 && iy > 0 ? ix * iy / Math.max(1, a.w * a.h) : 0;
    };
    const placed = [];
    let prevBearing = null;
    const rings = fa.rings.map((m) => {
      const text = MT.legend.ringLabel(m);
      const ring = MT.analysis.ringFeatures(ref, [m], { steps: 96 }).features[0];
      const pts = ring ? ring.geometry.coordinates[0].map((c) => proj(c)) : [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach((q) => { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); });
      const inside = pts.length > 0 && x0 >= 0 && y0 >= 0 && x1 <= fr.width && y1 <= fr.height;
      const visible = pts.length > 0 && x1 > 0 && y1 > 0 && x0 < fr.width && y0 < fr.height;
      const pill = ringPill(text);
      let best = null;
      if (visible) {
        RING_BEARINGS.forEach((deg, k) => {
          const c = MT.analysis.destination(ref.lat, ref.lng, deg, m), q = proj([c.lng, c.lat]);
          const b = { x: q.x - pill.w / 2 - 2, y: q.y - pill.h / 2 - 2, w: pill.w + 4, h: pill.h + 4 };
          if (b.x < 2 || b.y < 2 || b.x + b.w > fr.width - 2 || b.y + b.h > fr.height - 2) return;
          // Store dots on the pill hide a store (heavy); logos' default spots, district names, the
          // pin, the attribution and the other pills are avoided when a free bearing is close.
          let cost = 0;
          dots.forEach((d) => { if (d.x > b.x - dotR && d.x < b.x + b.w + dotR && d.y > b.y - dotR && d.y < b.y + b.h + dotR) cost += 60; });
          spots.forEach((s) => { const f = share(b, s); if (f > 0) cost += 6 + 18 * f; });
          names.forEach((n) => { if (over(b, n)) cost += 40; });
          if (pin && over(b, pin.box)) cost += 200;
          if (over(b, ab)) cost += 200;
          placed.forEach((o) => { if (over(b, o)) cost += 300; });
          lines.forEach((l) => { if (segBoxLen(p.x, p.y, l.to.x, l.to.y, b) > 0) cost += 3; });
          // Prefer the top of the ring, then the previous ring's bearing (pills in one line).
          const turn = (a, z) => { const d = Math.abs(a - z) % 360; return d > 180 ? 360 - d : d; };
          cost += 0.04 * Math.abs(deg) + (prevBearing === null ? 0 : 0.08 * turn(deg, prevBearing));
          if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && k < best.k)) best = { cost: cost, k: k, deg: deg, ll: [c.lng, c.lat], x: q.x, y: q.y, box: b };
        });
      }
      let label = null;
      if (best) {
        placed.push(best.box);
        prevBearing = best.deg;
        label = { ll: [U.round(best.ll[0], 7), U.round(best.ll[1], 7)], x: best.x, y: best.y, w: pill.w, h: pill.h, fs: pill.fs, text: text, bearing: best.deg };
      }
      return { meters: m, text: text, pts: pts, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, inside: inside, visible: visible, label: label };
    });
    return {
      ref: { ll: ll, x: p.x, y: p.y, type: ref.type, storeId: storeId, onSlide: onSlide, chainId: ref.chainId || null, label: fa.label, inFrame: inFrame(p) },
      pin: pin, rings: rings, lines: lines.map((l) => ({ storeId: l.storeId, chainId: l.chainId, meters: l.meters })),
      top: fa.top, rows: fa.rows, maxMeters: fa.maxMeters, label: fa.label, view: view,
    };
  }
  /**
   * The analysis' obstacles for the declutter, in a projection: its ring pills and the reference pin
   * (placed for the config's own view; their size is fixed in reference units, so a zoom level of
   * the HTML export gets them where the page draws them). [] on ordinary slides.
   */
  function analysisBoxes(mapCfg, project) {
    const g = mapCfg && mapCfg.analysis ? analysisGeometry(mapCfg) : null;
    if (!g) return [];
    const out = [];
    g.rings.forEach((r) => {
      if (!r.label) return;
      const q = project(r.label.ll);
      out.push({ x: q.x - r.label.w / 2 - 3, y: q.y - r.label.h / 2 - 3, w: r.label.w + 6, h: r.label.h + 6 });
    });
    if (g.pin) { const q = project(g.pin.ll); out.push(pinBox(q.x, q.y)); }
    return out;
  }

  /* ---- compute(): stores → items ---------------------------------------------------------------------- */
  let dataVersion = 0;
  ['stores:changed', 'chains:changed', 'logos:changed', 'data:ready'].forEach((ev) => MT.bus.on(ev, () => { dataVersion++; memo.clear(); }));
  const memo = new Map();
  const MEMO_MAX = 12;

  function signature(mapCfg, view, fr, opts) {
    return JSON.stringify([dataVersion, fr.width, fr.height, view.center, view.zoomRef,
      mapCfg.districts, mapCfg.chains, mapCfg.onlyInside, mapCfg.hiddenStores, mapCfg.markerStyle, mapCfg.markerSize,
      mapCfg.markerOffsets, mapCfg.view, mapCfg.fitTo, groupMode(mapCfg), mapCfg.radius,
      opts.groupNearby === undefined ? null : opts.groupNearby, opts.autoSize === false, opts.labels === false, opts.logoScale || 0,
      mapCfg.analysis]);
  }
  /** Same-chain grouping setting of a map: true | false | 'auto' (default). */
  function groupMode(mapCfg) {
    const v = mapCfg && mapCfg.groupNearby;
    return v === true || v === false ? v : 'auto';
  }

  function compute(mapCfg, opts) {
    opts = opts || {};
    if (!mapCfg) return [];
    const fr = { width: opts.width || frame().width, height: opts.height || frame().height };
    let project = opts.project, key = null;
    if (!project && !opts.stores) {
      const view = opts.view || viewFor(mapCfg);
      key = signature(mapCfg, view, fr, opts);
      const hit = memo.get(key);
      if (hit) return hit;
      project = projector(view, fr);
    } else if (!project) {
      project = projector(opts.view || viewFor(mapCfg), fr);
    }
    const t0 = performance.now();
    const style = styleOf(mapCfg);
    const stores = opts.stores || MT.data.storesForMap(mapCfg);
    const circle = style.kind !== 'card';
    const mk = MT.markers;
    const offsets = mapCfg.markerOffsets || {};
    const nodes = [], meta = [], anchors = [];
    const dimsAt = (chain, size) => (mk && mk.dims ? mk.dims(chain, { kind: style.kind, size: size }) : MT.theme.markerDims(style.kind, size));
    // Analysis slide (SPEC §6.3): the reference store keeps its own logo — never grouped, never
    // collapsed to a dot — drawn with a halo, which its box includes (refPad on each side).
    const ana = mapCfg.analysis ? analysisGeometry(mapCfg) : null;
    const refId = ana && ana.ref.onSlide ? ana.ref.storeId : null;
    const refPadAt = (size) => (refId && style.kind !== 'dot' ? refHaloPad(size) : 0);
    for (const s of stores) {
      if (!isFinite(s.lat) || !isFinite(s.lng)) continue;
      const a = project([s.lng, s.lat]);
      if (!(a.x >= 0 && a.x <= fr.width && a.y >= 0 && a.y <= fr.height)) continue;   // outside the frame
      const d = dimsAt(s.chain, style.size);
      const off = offsets[s.id];
      const fixed = off && isFinite(off.dx) && isFinite(off.dy) ? { x: a.x + off.dx * fr.width, y: a.y + off.dy * fr.width } : null;
      // An offset with `g` was made by dragging a grouped logo: the store may still group.
      const nd = { ax: a.x, ay: a.y, w: d.w, h: d.h, fixed: fixed, gfix: !!(fixed && off.g), key: s.id, group: s.chain };
      if (refId && s.id === refId) {
        const pad = refPadAt(style.size);
        Object.assign(nd, { w: d.w + 2 * pad, h: d.h + 2 * pad, refPad: pad, keep: true, group: s.chain + '\u0000ref', gfix: false });
      }
      nodes.push(nd);
      meta.push(s);
      anchors.push(a);
    }
    // Store dots of shops at (almost) the same spot — a mall with several chains — are spread a
    // little apart so every dot shows (the dot style fans out its own markers below). The layout
    // then works with the dots as drawn: a leader starts at its store's dot.
    if (style.kind !== 'dot') {
      const ad = MT.theme.marker.anchorDot, sp = ad.spread || { sep: 1.7, max: 1 };
      const spread = spreadDots(nodes, ad.radius * Math.sqrt(style.size), sp.sep, sp.max);
      nodes.forEach((nd, i) => { nd.ax = spread[i].x; nd.ay = spread[i].y; });
    }
    let placedPos;
    let grouping = { on: false, auto: false, groups: 0 };
    let size = style.size;                  // marker size actually drawn (aggregate.autoSize)
    const box = attributionBox();
    if (style.kind === 'dot') {
      // Dots sit exactly on the location (no declutter); a dragged dot keeps its offset + leader.
      // Stores at the very same spot (several shops in one mall) are fanned out by less than one
      // dot radius, so every dot shows.
      const fan = fanOut(nodes);
      placedPos = nodes.map((nd, i) => {
        if (!nd.fixed) return { x: fan[i].x, y: fan[i].y, displaced: false, leader: null };
        const x = U.clamp(nd.fixed.x, nd.w / 2 + 2, fr.width - nd.w / 2 - 2), y = U.clamp(nd.fixed.y, nd.h / 2 + 2, fr.height - nd.h / 2 - 2);
        return { x: x, y: y, displaced: true, leader: leaderFor(true, nd.ax, nd.ay, x, y, nd.w, nd.h) };
      });
    } else {
      const dc = MT.theme.marker.declutter;
      const logos = style.kind === 'badge' || style.kind === 'card';
      let stem = MT.theme.marker.stem * Math.sqrt(style.size);
      // Leader cap in reference units: maxLeader × the marker's size (a badge's diameter; for the
      // wide cards 1.6 × their height, so a card moves about as far as a badge would).
      let dims = MT.theme.markerDims(style.kind, style.size);
      let capUnits = (dc.maxLeader || 0) * (style.kind === 'card' ? dims.h * 1.6 : dims.w);
      const lview = opts.view || viewFor(mapCfg);
      const ob = box.obstacle || box;
      const obstacles = [{ x: ob.x - 2, y: ob.y - 2, w: ob.w + 4, h: ob.h + 4 }]
        .concat(opts.labels === false ? [] : districtLabelBoxes(mapCfg, project, lview, fr))
        .concat(opts.labels === false ? [] : radiusLabelBoxes(mapCfg, project, fr))
        // Analysis slide: its ring pills and reference pin.
        .concat(ana ? analysisBoxes(mapCfg, project) : []);
      const popts = {
        width: fr.width, height: fr.height, shape: circle ? 'circle' : 'rect',
        stem: stem, rings: dc.rings, angles: dc.angles, minGap: dc.minGap, passes: dc.passes,
        margin: 3, anchorRadius: MT.theme.marker.anchorDot.radius + 1,
        obstacles: obstacles,
        // The basemap's other labels (known once this view was rendered): avoided when it is cheap.
        soft: opts.labels === false ? [] : softLabels(mapCfg, lview, fr),
        // Logos stay close to their store (leader ≤ maxLeader marker sizes) or become a dot.
        maxLeader: logos && capUnits > 0 ? capUnits : undefined,
        collapse: logos && capUnits > 0,
      };
      // Same-chain grouping (logos only): forced groups (the HTML export replays the slide's), on,
      // or 'auto' = only when a first layout is crowded (theme declutter.aggregate).
      const agg = dc.aggregate;
      const mode = opts.groupNearby !== undefined ? opts.groupNearby : groupMode(mapCfg);
      let unit = style.kind === 'card' ? dims.h * 1.6 : dims.w;
      // Smaller logos for a crowded map (aggregate.autoSize): every size-dependent value follows.
      const resize = (k) => {
        size = U.clamp(style.size * k, MT.theme.marker.defaults.minSize, MT.theme.marker.defaults.maxSize);
        nodes.forEach((nd, i) => {
          const d = dimsAt(meta[i].chain, size);
          if (nd.refPad) nd.refPad = refPadAt(size);
          nd.w = d.w + 2 * (nd.refPad || 0); nd.h = d.h + 2 * (nd.refPad || 0);
        });
        stem = MT.theme.marker.stem * Math.sqrt(size);
        dims = MT.theme.markerDims(style.kind, size);
        capUnits = (dc.maxLeader || 0) * (style.kind === 'card' ? dims.h * 1.6 : dims.w);
        unit = style.kind === 'card' ? dims.h * 1.6 : dims.w;
        popts.stem = stem;
        if (popts.maxLeader !== undefined) popts.maxLeader = capUnits;
      };
      let groups = null;
      // A fixed logo scale (the HTML export draws every zoom level at the slide's logo size).
      if (opts.logoScale > 0 && Math.abs(opts.logoScale - 1) > 1e-9) resize(opts.logoScale);
      if (logos && agg && Array.isArray(opts.groups)) {
        const idx = {};
        nodes.forEach((nd, i) => { idx[nd.key] = i; });
        groups = opts.groups.map((g) => g.map((id) => idx[id]).filter((i) => i !== undefined && (!nodes[i].fixed || nodes[i].gfix))
          .sort((a, b) => (nodes[a].key < nodes[b].key ? -1 : nodes[a].key > nodes[b].key ? 1 : 0))).filter((g) => g.length >= 2);
      } else if (logos && agg && mode !== false && nodes.length >= 2) {
        let want = mode === true;
        if (!want) {
          placedPos = place(nodes, popts);
          want = crowded(nodes, placedPos, unit, agg, agg.autoMinStores || 0);
          grouping.auto = want;
          // Crowded: the logos also get a little smaller (not when the caller fixes the size, as
          // the HTML export's zoom ladder does with the slide's own size).
          if (want && opts.autoSize !== false && !(opts.logoScale > 0) && agg.autoSize > 0 && agg.autoSize < 1) {
            resize(agg.autoSize);
            if (size < style.size - 1e-9) placedPos = null; else size = style.size;
          }
        }
        if (want) {
          // Group, and group wider while the result is still crowded (radius → radiusMax); keep the
          // tidiest of the layouts tried (wider groups mean fewer logos but longer spokes).
          const r0 = agg.radius || 1.2, step = agg.radiusStep || 0, rMax = Math.max(r0, agg.radiusMax || r0);
          let best = null;
          for (let r = r0; ; r = Math.min(rMax, r + step)) {
            const g = clusterNodes(nodes, r * unit, agg.minCount);
            const res = g.length ? placeGroups(nodes, g, popts) : (placedPos || place(nodes, popts));
            const sc = untidiness(nodes, res, unit, agg, circle);
            if (!best || sc < best.sc - 1e-9) best = { g: g, res: res, r: r, sc: sc };
            if (!step || r >= rMax - 1e-9 || !crowded(nodes, res, unit, agg, 2)) break;
          }
          groups = best.g; placedPos = best.res; grouping.radius = best.r;
        }
      }
      // `on`: grouping applies to this layout (even when no two stores are close enough).
      grouping.on = !!groups;
      if (groups && groups.length) {
        if (!placedPos) placedPos = placeGroups(nodes, groups, popts);
        grouping.groups = groups.length;
      } else if (!placedPos) placedPos = place(nodes, popts);
    }
    const cd = MT.theme.marker.collapsed || { radius: 6 };
    const cdD = 2 * cd.radius * Math.sqrt(style.size);
    const items = nodes.map((nd, i) => {
      const s = meta[i], p = placedPos[i];
      const it = {
        storeId: s.id, chainId: s.chain, name: s.name, lngLat: [s.lng, s.lat],
        anchor: { x: anchors[i].x, y: anchors[i].y }, dot: { x: nd.ax, y: nd.ay }, pos: { x: p.x, y: p.y }, w: nd.w, h: nd.h,
        shape: circle ? 'circle' : 'rect',
        displaced: !!p.displaced, manual: !!nd.fixed, leader: p.leader || null,
      };
      // The analysis' reference store: w / h include its halo (refPad per side; the logo itself is
      // drawn refPad smaller on each side — MT.markers).
      if (nd.keep) { it.isRef = true; if (nd.refPad) it.refPad = nd.refPad; }
      if (style.kind === 'dot') it.dot = { x: it.anchor.x, y: it.anchor.y };
      // No room for its logo near the store: drawn as a small dot right on the location.
      if (p.collapsed) { it.collapsed = true; it.w = it.h = cdD; it.shape = 'circle'; }
      // Same-chain group: the representative carries the logo + count pip; the others are only
      // their store dot (a small hit target on the dot), no leader.
      if (p.count > 1) {
        it.count = p.count;
        it.members = p.members.map((k) => meta[k].id);
        it.leaderFrom = meta[p.leaderFrom].id;
      }
      if (p.grouped) {
        it.grouped = true; it.groupOf = meta[p.rep].id; it.manual = false; it.displaced = false;
        it.pos = { x: nd.ax, y: nd.ay }; it.w = it.h = 2 * (MT.theme.marker.anchorDot.radius * Math.sqrt(style.size) + 2); it.shape = 'circle';
      }
      return it;
    });
    // A grouped logo's spokes (groupTree): every dot of the group is tied to the logo — by the
    // leader, a spoke to the logo's edge, or a short link to a neighbouring store of the group —
    // so which logo a dot belongs to stays readable however crowded the spot.
    //   spokes: [{x1, y1, x2, y2, storeId, to?}] — from the dot of `storeId` to the logo edge, or
    //   (with `to`) to the dot of store `to`.
    const byId = {};
    items.forEach((it) => { byId[it.storeId] = it; });
    items.forEach((it) => {
      if (!(it.count > 1) || it.collapsed) return;
      it.spokes = spokesFor(it, it.members.map((id) => byId[id]).filter(Boolean));
    });
    if (style.kind === 'number') numberItems(items);
    const nCollapsed = items.filter((it) => it.collapsed).length;
    const nGroups = items.filter((it) => it.count > 1).length;
    const stats = { ms: performance.now() - t0, n: items.length, overlaps: style.kind === 'dot' ? 0 : countOverlaps(items, 0), collapsed: nCollapsed,
      // Marker size the logos are drawn at (the map's size, or smaller on a crowded map: aggregate.autoSize).
      size: size,
      // Same-chain grouping: mode ('auto' | true | false), whether it applies here, logos with a
      // count pip and the stores they stand for.
      grouping: { mode: groupMode(mapCfg), on: grouping.on, auto: grouping.auto, radius: grouping.radius || 0, groups: nGroups,
        grouped: items.filter((it) => it.count > 1).reduce((s, it) => s + it.count, 0) } };
    MT.layout.lastStats = stats;
    Object.defineProperty(items, 'stats', { value: stats, enumerable: false });
    if (key) {
      if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
      memo.set(key, items);
    }
    return items;
  }

  /**
   * Dot style: stores whose dots would sit exactly on top of each other (closer than 0.35 dot
   * radius) are spread on a small circle (≤ 0.9 radius) around their common spot, in key order.
   */
  function fanOut(nodes) {
    const out = nodes.map((nd) => ({ x: nd.ax, y: nd.ay }));
    const done = new Uint8Array(nodes.length);
    const idx = nodes.map((nd, i) => i).sort((a, b) => (nodes[a].key < nodes[b].key ? -1 : nodes[a].key > nodes[b].key ? 1 : a - b));
    idx.forEach((i) => {
      if (done[i] || nodes[i].fixed) return;
      const r = nodes[i].w / 2;
      const group = idx.filter((j) => !done[j] && !nodes[j].fixed && Math.hypot(nodes[j].ax - nodes[i].ax, nodes[j].ay - nodes[i].ay) < 0.35 * r);
      group.forEach((j) => { done[j] = 1; });
      if (group.length < 2) return;
      const cx = group.reduce((s, j) => s + nodes[j].ax, 0) / group.length, cy = group.reduce((s, j) => s + nodes[j].ay, 0) / group.length;
      group.forEach((j, k) => {
        const th = -Math.PI / 2 + k * 2 * Math.PI / group.length;
        out[j] = { x: cx + Math.cos(th) * 0.9 * r, y: cy + Math.sin(th) * 0.9 * r };
      });
    });
    // Then a few gentle passes push apart dots whose centres sit under another dot, each staying
    // within one radius of its store (deterministic: fixed order, fixed number of passes).
    const n = nodes.length;
    if (n > 1 && n <= 3000) {
      for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        for (let a = 0; a < n; a++) {
          const i = idx[a];
          if (nodes[i].fixed) continue;
          for (let b = a + 1; b < n; b++) {
            const j = idx[b];
            if (nodes[j].fixed) continue;
            const r = Math.min(nodes[i].w, nodes[j].w) / 2;
            let dx = out[j].x - out[i].x, dy = out[j].y - out[i].y;
            if (Math.abs(dx) >= r || Math.abs(dy) >= r) continue;
            let d = Math.hypot(dx, dy);
            if (d >= r) continue;
            if (d < 1e-6) { dx = 0; dy = 1; d = 1; }
            const push = (r - d) / 4;
            const ux = dx / d, uy = dy / d;
            [[i, -1], [j, 1]].forEach(([k, sgn]) => {
              const x = out[k].x + sgn * ux * push, y = out[k].y + sgn * uy * push;
              const ox = x - nodes[k].ax, oy = y - nodes[k].ay, od = Math.hypot(ox, oy), lim = nodes[k].w / 2;
              out[k] = od > lim ? { x: nodes[k].ax + ox / od * lim, y: nodes[k].ay + oy / od * lim } : { x: x, y: y };
            });
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    return out;
  }

  /**
   * Store dots (badge / card / number styles) of shops at almost the same spot: spread so that
   * their centres end up about `sepR` dot radii apart, each moving at most `maxR` radii from its
   * store. Stores at the very same point go on a small circle around it (key order, starting on the
   * left: leaders mostly go up, so side by side keeps both dots clear of a leader); then a few
   * gentle passes push apart the pairs still too close. Deterministic (key order, fixed passes).
   * → [{x, y}] aligned with nodes (reference units).
   */
  function spreadDots(nodes, r, sepR, maxR) {
    const n = nodes.length, out = nodes.map((nd) => ({ x: nd.ax, y: nd.ay }));
    if (n < 2 || !(r > 0) || !(sepR > 0) || !(maxR > 0)) return out;
    const sep = sepR * r, lim = maxR * r, same = 0.25 * r;
    const idx = nodes.map((nd, i) => i).sort((a, b) => (nodes[a].key < nodes[b].key ? -1 : nodes[a].key > nodes[b].key ? 1 : a - b));
    const rank = new Int32Array(n);
    idx.forEach((i, k) => { rank[i] = k; });
    const gridOf = (pts) => {
      const g = new Map();
      for (let t = 0; t < n; t++) {
        const i = idx[t], k = Math.floor(pts[i].x / sep) + ',' + Math.floor(pts[i].y / sep);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(i);
      }
      return g;
    };
    const near = (g, p, fn) => {
      const gx = Math.floor(p.x / sep), gy = Math.floor(p.y / sep);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = g.get((gx + dx) + ',' + (gy + dy)); if (l) l.forEach(fn); }
    };
    const clampTo = (i, x, y) => {
      const ox = x - nodes[i].ax, oy = y - nodes[i].ay, d = Math.hypot(ox, oy);
      return d > lim ? { x: nodes[i].ax + ox / d * lim, y: nodes[i].ay + oy / d * lim } : { x: x, y: y };
    };
    // 1. The very same spot.
    const g0 = gridOf(out), done = new Uint8Array(n);
    idx.forEach((i) => {
      if (done[i]) return;
      const grp = [];
      near(g0, out[i], (j) => { if (!done[j] && Math.hypot(nodes[j].ax - nodes[i].ax, nodes[j].ay - nodes[i].ay) < same) grp.push(j); });
      grp.sort((a, b) => rank[a] - rank[b]);
      grp.forEach((j) => { done[j] = 1; });
      if (grp.length < 2) return;
      const m = grp.length;
      const cx = grp.reduce((s, j) => s + nodes[j].ax, 0) / m, cy = grp.reduce((s, j) => s + nodes[j].ay, 0) / m;
      const rho = Math.min(lim, Math.max(sep / 2, sep / (2 * Math.sin(Math.PI / m))));
      grp.forEach((j, k) => {
        const th = Math.PI + k * 2 * Math.PI / m;
        out[j] = clampTo(j, cx + Math.cos(th) * rho, cy + Math.sin(th) * rho);
      });
    });
    // 2. Pairs still closer than `sep`.
    for (let pass = 0; pass < 8; pass++) {
      const g = gridOf(out);
      let moved = false;
      idx.forEach((i) => {
        near(g, out[i], (j) => {
          if (rank[j] <= rank[i]) return;
          let dx = out[j].x - out[i].x, dy = out[j].y - out[i].y, d = Math.hypot(dx, dy);
          if (d >= sep - 0.05) return;
          if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
          const push = (sep - d) * 0.3, ux = dx / d, uy = dy / d;
          out[i] = clampTo(i, out[i].x - ux * push, out[i].y - uy * push);
          out[j] = clampTo(j, out[j].x + ux * push, out[j].y + uy * push);
          moved = true;
        });
      });
      if (!moved) break;
    }
    return out;
  }

  /** Stable numbering for the 'number' style: by chain legend name, then store name, then id. */
  function numberItems(items) {
    const label = {};
    items.forEach((it) => { if (!(it.chainId in label)) label[it.chainId] = MT.data.chain(it.chainId).legendName; });
    const sorted = items.slice().sort((a, b) => U.compare(label[a.chainId], label[b.chainId]) || U.compare(a.name, b.name) || (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
    sorted.forEach((it, i) => { it.number = i + 1; });
  }

  MT.layout = {
    BASEMAP_WIDTH: BASEMAP_WIDTH,
    frame: frame,
    styleOf: styleOf,
    projector: projector,
    unprojector: unprojector,
    validView: validView,
    fitPadding: fitPadding,
    fitView: fitView,
    autoView: autoView,
    viewFor: viewFor,
    attributionBox: attributionBox,
    districtLabelBoxes: districtLabelBoxes,
    districtLabels: districtLabels,
    roadLabels: roadLabels,
    districtLabelPx: districtLabelPx,
    nameLayer: nameLayer,
    places: places,
    labels: labels,
    groupMode: groupMode,
    leaderFor: leaderFor,
    place: place,
    clusterNodes: clusterNodes,
    spreadDots: spreadDots,
    spokesFor: spokesFor,
    countOverlaps: countOverlaps,
    compute: compute,
    /** Analysis slides (SPEC §6.3): where the reference, rings, pills and lines go (null otherwise). */
    analysis: analysisGeometry,
    analysisBoxes: analysisBoxes,
    pinBox: pinBox,
    ringPill: ringPill,
    ringLabelFont: ringLabelFont,
    refHaloPad: refHaloPad,
    /** The declutter cost weights (read-only use; tests and tuning). */
    weights: W,
    lastStats: null,
    /** Zoom of the basemap (rendered BASEMAP_WIDTH px wide) for a view. */
    basemapZoom: function (view) { return MT.geo.zoomForWidth(view.zoomRef, BASEMAP_WIDTH); },
    /** Bumps whenever stores, chains or logos change (cache keys for other modules). */
    dataVersion: function () { return dataVersion; },
    /** Drop memoized layouts (tests). */
    clearCache: function () { memo.clear(); },
  };
})();
