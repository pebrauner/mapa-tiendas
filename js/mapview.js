/* js/mapview.js — MT.mapview: the single interactive MapLibre map inside the slide's map frame.
 * Module M1.
 *
 * WYSIWYG design (docs/ARCHITECTURE.md §6.1 + M1 notes):
 *   - The basemap is always rendered at MT.layout.BASEMAP_WIDTH CSS px and CSS-scaled to the frame
 *     (pixel ratio raised accordingly, so it stays sharp). Exports render the same width with a
 *     higher pixel ratio → identical label sizes, roads and tiles at any screen size.
 *   - Markers, leaders, dots, radius labels and the attribution are painted on ONE canvas over the
 *     map by MT.render.drawOverlay — the very routine the exports use — from MT.layout.compute
 *     (deterministic, in reference units). Transparent buttons on top make markers clickable,
 *     draggable and keyboard-accessible.
 *   - District borders and radius circles are MapLibre layers below the labels (the export map adds
 *     the same layers through MT.mapview.basemap.apply).
 *
 * CONTRACT:
 *   mount(el)       create the map inside `el` (the slide's map-frame element)
 *   render(mapCfg)  sync to a map config (saved view or auto-fit, borders, radius, markers);
 *                   idempotent and cheap when nothing changed
 *   getMap()        maplibregl.Map | null
 *   resize()        re-measure the frame (also automatic, ResizeObserver)
 * Events: 'store:click' {storeId, mapId, screen:{x,y}, rect} · 'view:changed' {id, view}
 *   (the view is saved with MT.project.updateMap first) · 'mapview:layout' {id, items, stats, view}.
 * Marker drag → updateMap(id, {markerOffsets}); double-click / Delete → that marker back to auto.
 * Extras: basemap.{patch, apply, ensureLayers, firstSymbolId, harvestPlaces, harvestLabels,
 *   districtLabelData} (used by MT.render), items(), state().
 * District names: every selected district's name is written by the app ('mt-district-labels' and
 *   its city / town / village looks, MT.layout.districtLabels — off the store dots), the basemap's
 *   own label of that name hidden; after each render the map's label boxes are harvested
 *   (MT.layout.labels). Main avenue names below zoom 14 in the cities of data/road-names.js:
 *   'mt-road-names' (MT.layout.roadLabels). Main roads in a warm tone, route shields from zoom 10.
 * Label blockers ('mt-label-blockers'): the frame's edges, the attribution and — once the view's
 *   labels are known — the layout's markers, store dots and leaders: a basemap label they would cut
 *   is left out instead (no harvest while they block).
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util, h = U.h;
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  /* ---- Basemap style helpers (shared with MT.render) ---------------------------------------- */
  const L = { bFill: 'mt-borders-fill', bLine: 'mt-borders-line', ocean: 'mt-ocean-mask', rFill: 'mt-radius-fill', rLine: 'mt-radius-line',
    dLabels: 'mt-district-labels', mainRoads: 'mt-highway-name-main', roadNames: 'mt-road-names', blockers: 'mt-label-blockers', shields: 'mt-highway-shield-main' };
  const BLOCK_IMG = 'mt-blank', BLOCK_IMG_PX = 32, BLOCK_PX = 24;
  // Positron's place-name layers: a selected district's name the app writes itself is hidden here.
  const PLACE_LABEL_LAYERS = ['label_other', 'label_village', 'label_town', 'label_city', 'label_city_capital'];

  /** [zoom, value] stops → a linear 'interpolate' expression on the zoom. */
  function zoomCurve(stops) {
    return ['interpolate', ['linear'], ['zoom']].concat([].concat.apply([], stops.map((s) => [s[0], s[1]])));
  }

  /**
   * Positron tuned for slides: Spanish names, no POIs, slightly larger place labels, soft blue water,
   * and the main avenues (motorway / trunk / primary) named from a lower zoom, a little larger —
   * a copy of "highway-name-major" restricted to them ('mt-highway-name-main'; the original keeps
   * secondary / tertiary roads). Note: the vector tiles carry no names for many main avenues below
   * zoom 13, whatever the style.
   */
  function patchStyle(map) {
    const layers = map.getStyle().layers || [];
    for (const l of layers) {
      if (l['source-layer'] === 'poi') { map.setLayoutProperty(l.id, 'visibility', 'none'); continue; }
      if (l.type !== 'symbol') continue;
      const tf = map.getLayoutProperty(l.id, 'text-field');
      if (tf && JSON.stringify(tf).indexOf('name_en') >= 0) map.setLayoutProperty(l.id, 'text-field', MT.theme.basemap.spanishTextField);
    }
    const set = (id, kind, prop, value) => { if (map.getLayer(id)) { try { map[kind](id, prop, value); } catch (e) { /* layer differs */ } } };
    const dl = MT.theme.basemap.districtLabel || {};
    // Neighbourhood / district names (Lima districts are "label_other"): readable on a slide.
    if (dl.size) set('label_other', 'setLayoutProperty', 'text-size', zoomCurve(dl.size));
    set('label_other', 'setPaintProperty', 'text-color', dl.color || '#3F3F46');
    set('label_other', 'setLayoutProperty', 'text-letter-spacing', dl.letterSpacing === undefined ? 0.06 : dl.letterSpacing);
    set('label_town', 'setPaintProperty', 'text-color', '#18181B');
    set('label_village', 'setPaintProperty', 'text-color', '#27272A');
    set('highway-name-major', 'setPaintProperty', 'text-color', '#52525B');
    set('highway-name-minor', 'setPaintProperty', 'text-color', '#71717A');
    set('water', 'setPaintProperty', 'fill-color', '#CBD7DF');
    set('waterway', 'setPaintProperty', 'line-color', '#BCCAD3');
    set('park', 'setPaintProperty', 'fill-color', '#E1E8DE');
    // The main road network (motorway / trunk / primary) in a faint warm tone with a darker casing.
    const rd = MT.theme.basemap.mainRoads;
    if (rd) {
      const main = (warm, other) => ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], warm, other];
      ['highway_motorway_inner', 'highway_motorway_bridge_inner', 'tunnel_motorway_inner'].forEach((id) => set(id, 'setPaintProperty', 'line-color', rd.fill));
      ['highway_motorway_casing', 'highway_motorway_bridge_casing', 'tunnel_motorway_casing'].forEach((id) => set(id, 'setPaintProperty', 'line-color', rd.casing));
      set('highway_major_inner', 'setPaintProperty', 'line-color', main(rd.fill, '#FFFFFF'));
      set('highway_major_casing', 'setPaintProperty', 'line-color', main(rd.casing, 'rgb(213, 213, 213)'));
      set('highway_major_subtle', 'setPaintProperty', 'line-color', main(rd.subtle || rd.casing, 'hsla(0,0%,85%,0.69)'));
    }
    // Route shields of motorways and trunk roads (1S, PE-1N) from a lower zoom than positron's 11.
    const sz = MT.theme.basemap.shieldMinzoom, shield = (map.getStyle().layers || []).find((l) => l.id === 'highway-shield-non-us');
    if (sz && shield && sz < (shield.minzoom || 11) && !map.getLayer(L.shields)) {
      try {
        const copy = JSON.parse(JSON.stringify(shield));
        copy.id = L.shields; copy.minzoom = sz; copy.maxzoom = shield.minzoom || 11;
        copy.filter = ['all', shield.filter, ['match', ['get', 'class'], ['motorway', 'trunk'], true, false]];
        copy.layout = Object.assign({}, copy.layout, { 'symbol-placement': 'point' });
        const ids = map.getStyle().layers.map((l) => l.id);
        map.addLayer(copy, ids[ids.indexOf(shield.id) + 1]);
      } catch (e) { /* positron's own shields only */ }
    }
    const mr = MT.theme.basemap.majorRoadNames;
    const major = (map.getStyle().layers || []).find((l) => l.id === 'highway-name-major');
    if (mr && major && !map.getLayer(L.mainRoads)) {
      try {
        const main = ['motorway', 'trunk', 'primary'];
        const copy = JSON.parse(JSON.stringify(major));
        copy.id = L.mainRoads;
        copy.minzoom = mr.minzoom;
        copy.filter = ['match', ['get', 'class'], main, true, false];
        copy.layout = Object.assign({}, copy.layout, mr.size ? { 'text-size': zoomCurve(mr.size) } : {});
        const ids = map.getStyle().layers.map((l) => l.id);
        map.addLayer(copy, ids[ids.indexOf(major.id) + 1]);
        map.setFilter(major.id, ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false]);
        // Main avenue names the tiles only carry from zoom 14 (data/road-names.js, main cities):
        // the same look, written by the app below that zoom — one label per avenue, on the stretch
        // MT.layout.roadLabels picked (applyRoadNames).
        const rn = window.MT_ROAD_NAMES;
        if (rn && Array.isArray(rn.features) && !map.getSource('mt-road-names')) {
          map.addSource('mt-road-names', { type: 'geojson', data: EMPTY_FC });
          const app = JSON.parse(JSON.stringify(copy));
          app.id = L.roadNames; app.source = 'mt-road-names'; delete app['source-layer']; delete app.filter;
          app.maxzoom = rn.maxzoom || 14;
          app.layout = Object.assign({}, app.layout, { 'text-field': ['get', 'name'], 'symbol-placement': 'line-center' });
          map.addLayer(app, ids[ids.indexOf(major.id) + 1]);
        }
      } catch (e) { /* keep positron's own road names */ }
    }
  }
  /**
   * Main avenue names: inside a city of data/road-names.js the app's layer names them up to its
   * maxzoom (14) and the tiles' own main-road names start there (no name twice); elsewhere the tiles'
   * names as usual (theme basemap.majorRoadNames.minzoom).
   */
  function roadNamesCover(view) {
    const rn = window.MT_ROAD_NAMES;
    if (!rn || !Array.isArray(rn.regions) || !view) return false;
    const c = view.center;
    return rn.regions.some((r) => c[0] >= r.bbox[0] && c[0] <= r.bbox[2] && c[1] >= r.bbox[1] && c[1] <= r.bbox[3]);
  }
  function applyRoadNames(map, mapCfg) {
    const mr = MT.theme.basemap.majorRoadNames, rn = window.MT_ROAD_NAMES;
    if (!mr || !map.getLayer(L.mainRoads)) return;
    const covered = !!(mapCfg && map.getLayer(L.roadNames) && roadNamesCover(MT.layout.viewFor(mapCfg)));
    try { map.setLayerZoomRange(L.mainRoads, covered ? (rn.maxzoom || 14) : mr.minzoom, 24); } catch (e) { /* layer differs */ }
    if (map.getSource('mt-road-names')) map.getSource('mt-road-names').setData(roadLabelData(covered ? mapCfg : null));
  }
  /** GeoJSON of the avenue names the app writes for a map config (MT.layout.roadLabels). */
  function roadLabelData(mapCfg) {
    const list = mapCfg ? MT.layout.roadLabels(mapCfg) : [];
    return { type: 'FeatureCollection', features: list.map((r) => ({ type: 'Feature', properties: { name: r.name }, geometry: { type: 'LineString', coordinates: r.line } })) };
  }
  function firstSymbolId(map) {
    const l = (map.getStyle().layers || []).find((x) => x.type === 'symbol');
    return l ? l.id : undefined;
  }
  /** Add the M1 sources/layers (borders, ocean mask, radius) below the labels — once per style. */
  function ensureLayers(map) {
    if (map.getSource('mt-borders')) return;
    const th = MT.theme, k = MT.layout.BASEMAP_WIDTH / 1000;   // reference units → basemap CSS px
    map.addSource('mt-borders', { type: 'geojson', data: EMPTY_FC });
    map.addSource('mt-radius', { type: 'geojson', data: EMPTY_FC });
    const before = firstSymbolId(map);
    const vis = { visibility: 'none' };
    map.addLayer({ id: L.bFill, type: 'fill', source: 'mt-borders', layout: vis, paint: { 'fill-color': th.borders.fill || 'rgba(0,0,0,0)' } }, before);
    map.addLayer({ id: L.bLine, type: 'line', source: 'mt-borders', layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
      paint: Object.assign({ 'line-color': th.borders.color, 'line-width': th.borders.width * k, 'line-opacity': th.borders.alpha },
        th.borders.dash ? { 'line-dasharray': th.borders.dash.map((d) => d / th.borders.width) } : {}) }, before);
    // INEI district polygons extend over the sea: repaint the ocean above them so borders stop at the coast.
    if (map.getSource('openmaptiles') && map.getLayer('water')) {
      map.addLayer({ id: L.ocean, type: 'fill', source: 'openmaptiles', 'source-layer': 'water', layout: vis,
        filter: ['==', ['get', 'class'], 'ocean'], paint: { 'fill-color': map.getPaintProperty('water', 'fill-color') || '#CBD7DF', 'fill-antialias': false } }, before);
    }
    map.addLayer({ id: L.rFill, type: 'fill', source: 'mt-radius', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] } }, before);
    map.addLayer({ id: L.rLine, type: 'line', source: 'mt-radius', layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'stroke'], 'line-width': th.radius.width * k, 'line-dasharray': (th.radius.dash || [1, 0]).map((d) => d / th.radius.width) } }, before);
    // The selected districts' names the basemap does not write (MT.layout.districtLabels `app`),
    // styled like positron's district names. On top of every layer: placed first, always shown, and
    // the basemap's labels give way to them.
    map.addSource('mt-district-labels', { type: 'geojson', data: EMPTY_FC });
    const lo = (prop, fb) => { try { const v = map.getLayer('label_other') ? map.getLayoutProperty('label_other', prop) : undefined; return v === undefined ? fb : v; } catch (e) { return fb; } };
    const po = (prop, fb) => { try { const v = map.getLayer('label_other') ? map.getPaintProperty('label_other', prop) : undefined; return v === undefined ? fb : v; } catch (e) { return fb; } };
    const dl = th.basemap.districtLabel || {};
    map.addLayer({ id: L.dLabels, type: 'symbol', source: 'mt-district-labels', minzoom: 8, filter: ['==', ['get', 'k'], 'suburb'],
      layout: { 'text-field': ['get', 'name'], 'text-font': lo('text-font', ['Noto Sans Italic']), 'text-size': dl.size ? zoomCurve(dl.size) : lo('text-size', 12),
        'text-transform': 'uppercase', 'text-letter-spacing': dl.letterSpacing === undefined ? 0.06 : dl.letterSpacing, 'text-max-width': lo('text-max-width', 9),
        'text-allow-overlap': true, 'text-ignore-placement': false, 'text-padding': 1 },
      paint: { 'text-color': dl.color || '#3F3F46', 'text-halo-color': po('text-halo-color', '#FFFFFF'), 'text-halo-width': po('text-halo-width', 1), 'text-halo-blur': po('text-halo-blur', 1) } });
    // Selected districts that are a city / town / village in OSM: written in the basemap's own look
    // for that class (a copy of positron's place layer, fed by the app's data, never left out).
    nameLooks(map).forEach((x) => { try { map.addLayer(x); } catch (e) { /* that look falls back to none */ } });
    // Label blockers (invisible, top-most, placed first): a basemap label that would be cut by the
    // frame's edge, or hidden under the attribution, collides with them and is not placed at all
    // ("BLO LIBRE", "Pampa I", "Vía Expresa Su…" under the attribution). The app's own district
    // names allow overlap and are kept (the automatic view keeps them inside the frame).
    try {
      if (!map.hasImage(BLOCK_IMG)) map.addImage(BLOCK_IMG, { width: BLOCK_IMG_PX, height: BLOCK_IMG_PX, data: new Uint8Array(BLOCK_IMG_PX * BLOCK_IMG_PX * 4) });
      map.addSource('mt-label-blockers', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({ id: L.blockers, type: 'symbol', source: 'mt-label-blockers',
        layout: { 'icon-image': BLOCK_IMG, 'icon-size': ['get', 's'], 'icon-anchor': ['get', 'a'], 'icon-allow-overlap': true, 'icon-ignore-placement': false,
          'icon-padding': 0, 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport' },
        paint: { 'icon-opacity': 0 } });
    } catch (e) { /* no blockers: edge labels may be cut */ }
  }
  /**
   * Blocker squares (basemap CSS px, BLOCK_PX) along the outside of the frame's four edges — anchored
   * ON the edge, the icon extending outwards (their tiles are loaded) — and tiling the attribution
   * box, for a map config's view. Geographic points: right for that view only (hidden while the
   * user moves the preview map).
   * items (a layout of that view, optional): the markers, their count pips, the store dots and the
   * leaders block labels too — a basemap name a logo, a dot or a leader would cut ("CE…O",
   * "Chimb•ote", "Punta H|ermosa") moves to another of its anchors (theme basemap.placeAnchors) or
   * is left out, instead of being drawn in pieces. The faint group spokes do not block.
   */
  function blockerData(mapCfg, items) {
    if (!mapCfg) return EMPTY_FC;
    const view = MT.layout.viewFor(mapCfg), fr = MT.layout.frame(), un = MT.layout.unprojector(view, fr);
    const k = fr.width / baseW(), Wc = baseW(), Hc = fr.height / k, q = BLOCK_PX;
    const feats = [];
    const add = (x, y, a, size) => {
      const ll = un({ x: x * k, y: y * k });
      feats.push({ type: 'Feature', properties: { a: a, s: U.round(size / BLOCK_IMG_PX, 4) }, geometry: { type: 'Point', coordinates: [U.round(ll[0], 7), U.round(ll[1], 7)] } });
    };
    for (let x = -q / 2; x < Wc + q; x += q) { add(x, 0, 'bottom', q); add(x, Hc, 'top', q); }
    for (let y = q / 2; y < Hc; y += q) { add(0, y, 'right', q); add(Wc, y, 'left', q); }
    const ab0 = MT.layout.attributionBox(), ab = ab0.obstacle || ab0, h = ab.h / k;
    for (let x = ab.x / k + h / 2; x < (ab.x + ab.w) / k + h / 2; x += h) add(Math.min(x, (ab.x + ab.w) / k - h / 2), (ab.y + ab.h / 2) / k, 'center', h);
    // Markers, dots and leaders of the layout (reference units → basemap px via `add`'s k).
    if (items && items.length) {
      const st = MT.layout.styleOf(mapCfg);
      const box = (x, y, w, hh) => {                  // a w × hh box (reference units) as squares
        const s = Math.min(w, hh), nx = Math.max(1, Math.ceil(w / s - 0.01)), ny = Math.max(1, Math.ceil(hh / s - 0.01));
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const cx = nx === 1 ? x : x - w / 2 + s / 2 + i * (w - s) / (nx - 1), cy = ny === 1 ? y : y - hh / 2 + s / 2 + j * (hh - s) / (ny - 1);
          add(cx / k, cy / k, 'center', s / k);
        }
      };
      const dotR = MT.markers.anchorRadius(st) + MT.theme.marker.anchorDot.strokeWidth;
      const seg = (l) => {                            // squares of 4 px every 3 px along a leader
        const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) / k, n = Math.max(1, Math.ceil(len / 3));
        for (let i = 0; i <= n; i++) add((l.x1 + (l.x2 - l.x1) * i / n) / k, (l.y1 + (l.y2 - l.y1) * i / n) / k, 'center', 4);
      };
      items.forEach((it) => {
        if (it.leader) seg(it.leader);
        if (it.collapsed) { box(it.pos.x, it.pos.y, it.w, it.h); return; }
        if (st.kind !== 'dot' || it.displaced) { const d = it.dot || it.anchor; box(d.x, d.y, 2 * dotR, 2 * dotR); }
        if (it.grouped) return;
        box(it.pos.x, it.pos.y, it.w, it.h);
        if (it.count > 1) {
          const pg = MT.markers.pipGeometry(it.chainId, it.w, it.h, st, it.count);
          box(it.pos.x + pg.dx, it.pos.y + pg.dy, pg.w, pg.h);
        }
      });
    }
    return { type: 'FeatureCollection', features: feats };
  }
  /** Set the label blockers for a config (and its layout `items`, or none). */
  function applyBlockers(map, mapCfg, items) {
    const src = map.getSource('mt-label-blockers');
    if (!src) return;
    src.setData(blockerData(mapCfg, items));
    // Labels placed around the markers are not where the basemap writes them on its own: no
    // harvest (MT.layout.labels) from this map until the blockers are the frame's alone again.
    map.__mtMarkerBlockers = !!(mapCfg && items && items.length);
    if (map.getLayer(L.blockers)) map.setLayoutProperty(L.blockers, 'visibility', 'visible');
  }
  /** A cheap signature of what the markers block (change detection). */
  function blockerKey(items) {
    if (!items || !items.length) return '';
    const r = (v) => Math.round(v * 2);
    return items.map((it) => {
      const d = it.dot || it.anchor;
      return [r(it.pos.x), r(it.pos.y), r(d.x), r(d.y), r(it.w), it.count || 0, it.collapsed ? 1 : 0, it.grouped ? 1 : 0,
        it.leader ? [r(it.leader.x1), r(it.leader.y1), r(it.leader.x2), r(it.leader.y2)].join(',') : ''].join(':');
    }).join(';');
  }
  /**
   * Layers writing the selected districts' names in a city / town / village look: copies of
   * positron's label_city / label_town / label_village (same font, size, colour, halo, anchor) on
   * the 'mt-district-labels' source, filtered by the feature's look `k`, always drawn (allow
   * overlap; other labels still give way), without the small dot icon.
   */
  const NAME_LOOKS = [['city', 'label_city'], ['town', 'label_town'], ['village', 'label_village']];
  function nameLooks(map) {
    const layers = map.getStyle().layers || [];
    return NAME_LOOKS.map(([k, src]) => {
      const base = layers.find((l) => l.id === src);
      if (!base) return null;
      const lay = JSON.parse(JSON.stringify(base));
      lay.id = L.dLabels + '-' + k; lay.source = 'mt-district-labels'; delete lay['source-layer'];
      lay.filter = ['==', ['get', 'k'], k];
      const lo = Object.assign({}, lay.layout || {});
      ['icon-image', 'icon-size', 'icon-allow-overlap', 'icon-optional', 'icon-ignore-placement'].forEach((p) => { delete lo[p]; });
      lay.layout = Object.assign(lo, { 'text-field': ['get', 'name'], 'text-allow-overlap': true, 'text-ignore-placement': false });
      return lay;
    }).filter(Boolean);
  }
  /** GeoJSON of the district names the app writes for a map config (`k` = look, MT.layout). */
  function districtLabelData(mapCfg) {
    const list = mapCfg ? MT.layout.districtLabels(mapCfg).filter((l) => l.app) : [];
    return { type: 'FeatureCollection', features: list.map((l) => ({ type: 'Feature', properties: { name: l.name, ubigeo: l.ubigeo, k: l.look || 'suburb' }, geometry: { type: 'Point', coordinates: l.ll } })) };
  }
  /** Write the app's district names and hide the basemap's own labels of those names (no duplicates). */
  function applyDistrictLabels(map, mapCfg) {
    const data = districtLabelData(mapCfg);
    if (map.getSource('mt-district-labels')) map.getSource('mt-district-labels').setData(data);
    const names = data.features.map((f) => String(f.properties.name).toLowerCase());
    const base = MT.theme.basemap.spanishTextField;
    const tf = names.length ? ['case', ['in', ['downcase', ['to-string', base]], ['literal', names]], '', base] : base;
    PLACE_LABEL_LAYERS.forEach((id) => { if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'text-field', tf); } catch (e) { /* layer differs */ } } });
    // What this map now shows (harvestLabels keys its boxes by it).
    map.__mtLabelSig = MT.layout.labels.sig(mapCfg);
  }
  /**
   * Where the rendered map wrote its labels (MapLibre's collision boxes / circles of the last
   * placement, CSS px + its viewport padding) → MT.layout.labels for this config's view, in
   * reference units. Only when the map shows exactly that view and the app's district names of the
   * current place cache. Internal MapLibre structures (pinned vendor version): any surprise and the
   * layout simply goes without them.
   */
  function harvestLabels(map, mapCfg) {
    if (!map || !mapCfg || !MT.layout.labels || map.__mtMarkerBlockers) return;
    const view = MT.layout.viewFor(mapCfg);
    const c = map.getCenter(), zr = MT.geo.zoomRefFor(map.getZoom(), map.transform.width);
    if (Math.abs(c.lng - view.center[0]) > 1e-6 || Math.abs(c.lat - view.center[1]) > 1e-6 || Math.abs(zr - view.zoomRef) > 1e-4) return;
    if (map.__mtLabelSig !== MT.layout.labels.sig(mapCfg)) return;
    let pl, ci, g;
    try { pl = map.style.placement; ci = pl && pl.collisionIndex; g = ci && ci.grid; } catch (e) { return; }
    if (!g || !Array.isArray(g.boxKeys) || !Array.isArray(g.bboxes) || !pl.retainedQueryData) return;
    // The last placement must be of this camera (a jump since — e.g. a widened automatic view — has
    // not been placed yet: its labels come with the next idle).
    try {
      const pt = pl.transform, pc = pt && pt.center;
      if (pc && (Math.abs(pc.lng - c.lng) > 1e-6 || Math.abs(pc.lat - c.lat) > 1e-6 || Math.abs(pt.zoom - map.getZoom()) > 1e-6)) return;
    } catch (e) { /* no transform to check */ }
    try {
      const W = map.transform.width, pad = (ci.screenRightBoundary - W) || 0, k = 1000 / W;
      const F = MT.layout.frame();
      const layerOf = (key) => {
        const q = pl.retainedQueryData[key.bucketInstanceId];
        const ids = q && q.featureIndex && q.featureIndex.bucketLayerIDs && q.featureIndex.bucketLayerIDs[q.bucketIndex];
        return ids && ids.length ? String(ids[0]) : '';
      };
      const r2 = (v) => Math.round(v * 2) / 2;
      const box = (x0, y0, x1, y1) => ({ x: r2((x0 - pad) * k), y: r2((y0 - pad) * k), w: r2((x1 - x0) * k), h: r2((y1 - y0) * k) });
      const inFrame = (b) => b.x < F.width && b.y < F.height && b.x + b.w > 0 && b.y + b.h > 0 && b.w > 0 && b.h > 0;
      const out = [];
      for (let i = 0; i < g.boxKeys.length; i++) {
        const l = layerOf(g.boxKeys[i]);
        if (!l || l === L.blockers) continue;
        const b = box(g.bboxes[4 * i], g.bboxes[4 * i + 1], g.bboxes[4 * i + 2], g.bboxes[4 * i + 3]);
        if (inFrame(b)) out.push(Object.assign({ l: l }, b));
      }
      // Labels along a line: one collision circle per glyph run → one entry with its parts.
      const lines = new Map();
      for (let i = 0; Array.isArray(g.circleKeys) && i < g.circleKeys.length; i++) {
        const key = g.circleKeys[i], l = layerOf(key);
        if (!l) continue;
        const x = g.circles[3 * i], y = g.circles[3 * i + 1], r = g.circles[3 * i + 2];
        const id = key.bucketInstanceId + ':' + key.featureIndex;
        if (!lines.has(id)) lines.set(id, { l: l, parts: [] });
        lines.get(id).parts.push(box(x - r, y - r, x + r, y + r));
      }
      lines.forEach((e) => {
        const parts = e.parts.filter(inFrame);
        if (!parts.length) return;
        const x0 = Math.min.apply(null, parts.map((p) => p.x)), y0 = Math.min.apply(null, parts.map((p) => p.y));
        const x1 = Math.max.apply(null, parts.map((p) => p.x + p.w)), y1 = Math.max.apply(null, parts.map((p) => p.y + p.h));
        parts.sort((a, b) => a.x - b.x || a.y - b.y);
        out.push({ l: e.l, x: x0, y: y0, w: r2(x1 - x0), h: r2(y1 - y0), parts: parts });
      });
      out.sort((a, b) => (a.l < b.l ? -1 : a.l > b.l ? 1 : 0) || a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h);
      MT.layout.labels.set(mapCfg, view, out);
    } catch (e) { /* MapLibre internals differ: no label obstacles */ }
  }
  /**
   * Learn where the basemap writes the selected districts' names: OSM place points of the vector
   * tiles ("place" layer) whose name is a selected district, preferring one inside that district.
   * Saved in MT.layout's place cache (persistent); the declutter keeps markers off those labels.
   */
  function harvestPlaces(map, mapCfg) {
    if (!map || !mapCfg || !(mapCfg.districts || []).length || !MT.data.districts.available || !map.getSource('openmaptiles')) return;
    const want = {};
    mapCfg.districts.forEach((u) => {
      const d = MT.data.districts.get(u);
      if (!d) return;
      want[U.normalize(d.district)] = u;
      if (u === '150101') { want[U.normalize('Cercado de Lima')] = u; want[U.normalize('Lima Cercado')] = u; }
    });
    let feats = [];
    try { feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' }); } catch (err) { return; }
    const found = {};
    feats.forEach((f) => {
      const p = f.properties || {};
      const u = want[U.normalize(p['name:es'] || p.name || '')] || want[U.normalize(p.name || '')];
      if (!u || !f.geometry || f.geometry.type !== 'Point') return;
      const ll = f.geometry.coordinates;
      const loc = MT.data.districts.locate(ll[1], ll[0]);
      const inside = !!loc && loc.ubigeo === u;
      const prev = found[u];
      const key = [ll[0].toFixed(5), ll[1].toFixed(5)].join(',');
      if (!prev || (inside && !prev.inside) || (inside === prev.inside && key < prev.key)) found[u] = { ll: [U.round(ll[0], 5), U.round(ll[1], 5)], c: String(p.class || ''), inside: inside, key: key };
    });
    return MT.layout.places.set(found);
  }

  /**
   * Set borders + radius data, the app's district names and the label blockers on a map for a
   * config. opts: {overlays, items} — items: the config's layout, whose markers, dots and leaders
   * then block basemap labels too (applyBlockers).
   */
  function applyOverlays(map, mapCfg, opts) {
    ensureLayers(map);
    const show = !!(mapCfg && mapCfg.showBorders && (mapCfg.districts || []).length && MT.data.districts.available) && !(opts && opts.overlays === false);
    map.getSource('mt-borders').setData(show ? MT.data.districts.features(mapCfg.districts) : EMPTY_FC);
    [L.bFill, L.bLine, L.ocean].forEach((id) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none'); });
    const radius = mapCfg && !(opts && opts.overlays === false) ? MT.radius.features(mapCfg) : EMPTY_FC;
    map.getSource('mt-radius').setData(radius);
    // District names, main avenue names and the label blockers are part of the basemap (overlays:false too).
    applyDistrictLabels(map, mapCfg);
    applyRoadNames(map, mapCfg);
    applyBlockers(map, mapCfg, opts && opts.items);
  }

  /* ---- State ----------------------------------------------------------------------------------- */
  let root = null, stage = null, canvas = null, hits = null, ui = null, map = null, ro = null;
  let els = {};
  let cfg = null, view = null;
  let items = [], live = [], liveLabels = [], radiusResults = [];
  let frameW = 0, frameH = 0, dprNow = 1;
  let styleReady = false, basemapFailed = false, webglFailed = false, firstIdle = false;
  let applying = false, userMoving = false;
  let hoverId = null, selectedId = null, drag = null, raf = 0, renderToken = 0;
  let keys = { borders: '', radius: '', view: '' };
  let nudgeCommit = null;     // {timer, run} — a keyboard nudge waiting to be saved
  let moveMapId = null;       // the map whose camera the current user gesture started on
  let rovingId = null;        // the one marker button in the Tab order (roving tabindex)

  function baseW() { return MT.layout.BASEMAP_WIDTH; }
  function baseH() { return Math.round(baseW() / MT.theme.frame.aspect); }
  function fr() { return MT.layout.frame(); }

  function mount(el) {
    if (root) { if (root.parentNode !== el) el.appendChild(root); resize(); return root; }
    root = h('div', { class: 'mt-mapview' });
    stage = h('div', { class: 'mt-mapview__stage', style: { width: baseW() + 'px', height: baseH() + 'px' } });
    canvas = h('canvas', { class: 'mt-mapview__canvas', 'aria-hidden': 'true' });
    hits = h('div', { class: 'mt-mapview__hits', style: { width: fr().width + 'px', height: fr().height + 'px' } });
    ui = h('div', { class: 'mt-mapview__ui' });
    els.chips = h('div', { class: 'mt-mapview__chips' });
    els.controls = h('div', { class: 'mt-mapview__controls', role: 'group' });
    els.notice = h('div', { class: 'mt-mapview__notice', hidden: true, role: 'status' });
    els.tip = h('div', { class: 'mt-mapview__tip', hidden: true, role: 'tooltip', id: U.uid('mt-tip') });
    els.loading = h('div', { class: 'mt-mapview__loading' }, h('span', { class: 'mt-spinner', 'aria-hidden': 'true' }), h('span', { class: 'mt-mapview__loading-text' }));
    buildControls();
    U.append(ui, [els.chips, els.controls, els.notice, els.loading, els.tip]);
    U.append(root, [stage, canvas, hits, ui]);
    el.appendChild(root);
    bindHits();

    try {
      map = createMap();
    } catch (err) {
      // No WebGL (hardware acceleration off, very old GPU…): markers, legend and exports of the
      // slide text still work; the frame explains why the basemap is missing.
      console.warn('[mapview] the map cannot be created', err);
      map = null; webglFailed = true;
    }

    ro = new ResizeObserver(() => resize());
    ro.observe(root);
    window.addEventListener('resize', () => resize());   // also fires when the device pixel ratio changes
    // The basemap failed (opened before Wi-Fi / VPN was up): try again as soon as we are online.
    window.addEventListener('online', () => { if (basemapFailed) retryBasemap(); });
    MT.bus.on('lang:changed', () => { labelCanvas(); buildControls(); updateUi(); });
    // The basemap's district-name positions were just learnt: lay the markers out around them.
    MT.bus.on('layout:places', () => { if (cfg) render(cfg); });
    resize();
    updateLoading();
    if (cfg) render(cfg);
    return root;
  }

  function createMap() {
    const m = new maplibregl.Map({
      container: stage,
      style: MT.theme.basemap.style,
      center: [-75.2, -9.3], zoom: 4.5,
      attributionControl: false,          // drawn by MT.render.drawOverlay (same as the exports)
      fadeDuration: 120,
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
      renderWorldCopies: false, boxZoom: false, keyboard: true,
      minZoom: 2, maxZoom: 19.5,
      trackResize: false,
      locale: MT.i18n.mapLocale(),
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
    });
    m.touchZoomRotate.disableRotation();
    m.keyboard.disableRotation();
    m.on('style.load', onStyleLoad);
    m.on('error', onMapError);
    // Every camera move that is not ours (applyCamera / resize run with `applying`) comes from the
    // user: drag, wheel, double-click, keyboard, zoom buttons. MapLibre 5 gives wheel zooms no originalEvent.
    m.on('movestart', () => {
      if (!applying) {
        userMoving = true; moveMapId = cfg && cfg.id;
        // The blockers belong to the saved view: off while the camera moves (render() puts them back).
        if (styleReady && m.getLayer(L.blockers)) { try { m.setLayoutProperty(L.blockers, 'visibility', 'none'); } catch (e) { /* ignore */ } keys.view = ''; }
      }
      hideTip();
    });
    m.on('move', () => { if (!applying) scheduleLive(); });
    m.on('moveend', onMoveEnd);
    m.on('idle', () => {
      if (!firstIdle) { firstIdle = true; updateLoading(); }
      root.dataset.idle = '1';
      if (cfg && styleReady) {
        let moved = false;
        try { moved = harvestPlaces(m, cfg); } catch (err) { /* keep fallback points */ }
        // Then the labels the map wrote (only once the district names above are the current ones;
        // new place points re-render the slide first — maybe with a wider view — next idle then).
        if (!moved) { try { harvestLabels(m, cfg); } catch (err) { /* no label obstacles */ } }
      }
    });
    m.on('dataloading', () => { root.dataset.idle = '0'; });
    m.getCanvas().setAttribute('aria-label', MT.t('map.canvasAria'));
    return m;
  }

  /** Load the basemap style again (after a failure). 'style.load' clears the error state. */
  function retryBasemap() {
    if (!map) return;
    basemapFailed = false; styleReady = false; firstIdle = false;
    updateUi();
    try { map.setStyle(MT.theme.basemap.style, { diff: false }); } catch (err) { basemapFailed = true; updateUi(); }
  }

  function onStyleLoad() {
    try { patchStyle(map); ensureLayers(map); } catch (err) { console.warn('[mapview] style patch failed', err); }
    styleReady = true;
    basemapFailed = false;
    keys = { borders: '', radius: '', view: '' };
    syncLayers();
    updateUi();
  }
  function onMapError(e) {
    // Tile hiccups are normal; only a style that never loads is fatal for the preview.
    if (!styleReady) { basemapFailed = true; updateUi(); }
    const msg = e && e.error && e.error.message;
    if (msg && !/abort/i.test(msg)) console.warn('[mapview]', msg);
  }

  /* ---- Size ------------------------------------------------------------------------------------- */
  function resize() {
    if (!root) return;
    const w = root.clientWidth, hgt = root.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    const changed = w !== frameW || hgt !== frameH || dpr !== dprNow;
    const wasZero = !frameW;
    frameW = w; frameH = hgt; dprNow = dpr;
    if (!changed) return;
    const s = w / fr().width;
    stage.style.transform = 'scale(' + (w / baseW()) + ')';
    hits.style.transform = 'scale(' + s + ')';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = hgt + 'px';
    if (map) {
      applying = true;
      try {
        if (wasZero) map.resize();
        // Sharp basemap at any frame size: device pixels per basemap CSS px.
        const pr = U.clamp(dpr * w / baseW(), 1, 4);
        if (Math.abs(map.getPixelRatio() - pr) > 0.01) map.setPixelRatio(pr);
      } finally { applying = false; }
    }
    positionHits();
    draw();
  }

  /* ---- Render ----------------------------------------------------------------------------------- */
  /**
   * Another slide is about to be shown. Whatever the user was doing on the previous one belongs to
   * the previous one: a pending keyboard nudge is saved there now, and a camera animation still
   * running (wheel inertia, +/− zoom, keyboard pan) is stopped so its end is not saved as the new
   * slide's framing.
   */
  function leaveMap() {
    if (nudgeCommit) { const n = nudgeCommit; nudgeCommit = null; clearTimeout(n.timer); n.run(false); }
    if (map) { applying = true; try { map.stop(); } finally { applying = false; } }
    userMoving = false; moveMapId = null;
    if (drag) {
      try { drag.el.releasePointerCapture(drag.id); } catch (err) { /* already released */ }
      drag = null;
      if (root) root.classList.remove('is-dragging');
    }
    rovingId = null;
  }

  function render(mapCfg) {
    const next = mapCfg || null;
    if (root && (next ? next.id : null) !== (cfg ? cfg.id : null)) leaveMap();
    cfg = next;
    if (!root) return;
    const token = ++renderToken;
    if (!cfg) {
      items = []; live = []; liveLabels = []; radiusResults = []; view = null;
      buildHits(); draw(); updateUi();
      return;
    }
    view = MT.layout.viewFor(cfg);
    if (!userMoving && !drag) applyCamera(view);
    items = MT.layout.compute(cfg);
    syncLayers();
    resetLive();
    buildHits();
    updateUi();
    const st = MT.layout.styleOf(cfg);
    const ids = Array.from(new Set(items.map((i) => i.chainId)));
    // A render that arrives mid-gesture (data changed while panning): follow the live camera.
    if (userMoving) scheduleLive();
    const emit = () => MT.bus.emit('mapview:layout', { id: cfg.id, items: items, stats: items.stats || null, view: view });
    if (MT.markers.isReady(ids, st)) { draw(); emit(); } else {
      draw();
      MT.markers.ready(ids, st).then(() => { if (token === renderToken) { draw(); emit(); } });
    }
  }

  function applyCamera(v) {
    if (!map) return;
    const z = MT.layout.basemapZoom(v);
    const c = map.getCenter();
    if (Math.abs(c.lng - v.center[0]) < 1e-7 && Math.abs(c.lat - v.center[1]) < 1e-7 && Math.abs(map.getZoom() - z) < 1e-6) return;
    applying = true;
    try { map.jumpTo({ center: v.center, zoom: z }); } finally { applying = false; }
  }

  function syncLayers() {
    if (!map || !styleReady || !cfg) {
      if (map && styleReady && !cfg) { keys = { borders: '', radius: '', view: '', blockers: '' }; try { applyOverlays(map, null); } catch (e) { /* ignore */ } }
      return;
    }
    const v = MT.layout.viewFor(cfg);
    const kb = JSON.stringify([cfg.showBorders, cfg.districts, MT.data.districts.available, MT.layout.labels.sig(cfg)]);
    const kr = JSON.stringify([cfg.radius, cfg.chains, cfg.hiddenStores, MT.layout.dataVersion()]);
    const kv = JSON.stringify([v.center, v.zoomRef]);
    // The markers block basemap labels once this view's own labels are known (harvested from a
    // render without them: the declutter keeps logos off those labels first).
    const blk = items && items.length && MT.layout.labels.get(cfg, v) ? items : null;
    const kk = kv + '|' + blockerKey(blk);
    if (kb === keys.borders && kr === keys.radius && kv === keys.view && kk === keys.blockers) return;
    const onlyBlockers = kb === keys.borders && kr === keys.radius && kv === keys.view;
    keys = { borders: kb, radius: kr, view: kv, blockers: kk };
    try { if (onlyBlockers) applyBlockers(map, cfg, blk); else applyOverlays(map, cfg, { items: blk }); } catch (err) { console.warn('[mapview] overlay layers', err); }
  }

  /* ---- Live positions (while panning/zooming or dragging) ---------------------------------------- */
  function cloneItem(it) {
    const d = it.dot || it.anchor;
    return Object.assign({}, it, { anchor: { x: it.anchor.x, y: it.anchor.y }, dot: { x: d.x, y: d.y }, pos: { x: it.pos.x, y: it.pos.y }, leader: it.leader ? Object.assign({}, it.leader) : null,
      spokes: it.spokes ? it.spokes.map((s) => Object.assign({}, s)) : undefined });
  }
  function resetLive() {
    live = items.map(cloneItem);
    radiusResults = cfg ? MT.radius.compute(cfg) : [];
    liveLabels = cfg ? MT.radius.labels(radiusResults, MT.layout.projector(view)) : [];
  }
  function liveView() {
    const c = map.getCenter();
    return { center: [c.lng, c.lat], zoomRef: MT.geo.zoomRefFor(map.getZoom(), baseW()) };
  }
  function scheduleLive() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!cfg || !map) return;
      const proj = MT.layout.projector(liveView());
      for (let i = 0; i < items.length; i++) {
        const it = items[i], lv = live[i];
        const a = proj(it.lngLat);
        lv.anchor.x = a.x; lv.anchor.y = a.y;
        const dx = a.x - it.anchor.x, dy = a.y - it.anchor.y;
        lv.pos.x = it.pos.x + dx; lv.pos.y = it.pos.y + dy;
        // Markers keep their offset (reference units) while the map moves: the whole leader too (a
        // group's leader starts at another store's dot).
        lv.leader = it.leader ? { x1: it.leader.x1 + dx, y1: it.leader.y1 + dy, x2: it.leader.x2 + dx, y2: it.leader.y2 + dy } : null;
        const d = it.dot || it.anchor;
        lv.dot = { x: d.x + dx, y: d.y + dy };
        if (it.spokes) lv.spokes = it.spokes.map((s) => ({ x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy, storeId: s.storeId }));
      }
      liveLabels = MT.radius.labels(radiusResults, proj);
      positionHits();
      draw();
    });
  }
  function onMoveEnd() {
    if (applying) return;
    if (!userMoving) return;
    userMoving = false;
    // A gesture that started on another slide (switched mid-animation) is not this slide's framing.
    if (!cfg || moveMapId !== cfg.id) return;
    const v = liveView();
    const saved = { center: [U.round(v.center[0], 6), U.round(v.center[1], 6)], zoomRef: U.round(v.zoomRef, 3) };
    if (cfg.view && U.isEqual(cfg.view, saved)) { syncLayers(); return; }   // same framing: blockers back
    const updated = MT.project.getMap(cfg.id) ? MT.project.updateMap(cfg.id, { view: saved }) : null;
    MT.bus.emit('view:changed', { id: cfg.id, view: saved });
    render(updated || Object.assign({}, cfg, { view: saved }));
  }

  /* ---- Drawing ------------------------------------------------------------------------------------ */
  function draw() {
    if (!canvas || !frameW) return;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cfg) return;
    MT.render.drawOverlay(ctx, cfg, live, canvas.width / fr().width, { highlight: hoverId || selectedId, radiusLabels: liveLabels });
  }

  /* ---- Hit targets (accessible marker buttons) ---------------------------------------------------- */
  /*
   * The markers are ONE stop in the Tab order (roving tabindex): Tab reaches the first marker, the
   * next Tab leaves the map for the slide settings. Inside, PageDown / PageUp (or N / P) go to the
   * next / previous store in reading order, Home / End to the first / last; the arrow keys keep
   * nudging the focused marker.
   */
  function buildHits() {
    U.clear(hits);
    const chainName = {};
    if (rovingId && !live.some((it) => it.storeId === rovingId)) rovingId = null;
    live.forEach((it, i) => {
      if (!(it.chainId in chainName)) chainName[it.chainId] = MT.data.chain(it.chainId).name;
      const b = h('button', {
        type: 'button', class: 'mt-marker-hit' + (it.shape === 'circle' ? ' is-round' : ''),
        'aria-label': MT.t('map.marker.aria', { name: it.name || chainName[it.chainId], chain: chainName[it.chainId] }),
        'aria-describedby': els.tip.id,
        tabindex: '-1',
        dataset: { i: String(i), storeId: it.storeId },
      });
      hits.appendChild(b);
    });
    setRoving(rovingId || (readingOrder()[0] !== undefined ? live[readingOrder()[0]].storeId : null));
    positionHits();
  }
  /** Indexes of `live` sorted top-to-bottom, then left-to-right (rows of ~ one marker height). */
  function readingOrder() {
    const rowH = 30;
    return live.map((it, i) => i).sort((a, b) => {
      const A = live[a], B = live[b];
      return Math.floor(A.pos.y / rowH) - Math.floor(B.pos.y / rowH) || A.pos.x - B.pos.x || a - b;
    });
  }
  function setRoving(storeId) {
    rovingId = storeId;
    for (const b of hits.children) b.tabIndex = b.dataset.storeId === storeId ? 0 : -1;
  }
  function positionHits() {
    const list = hits.children;
    for (let i = 0; i < list.length && i < live.length; i++) {
      const it = live[i], b = list[i];
      b.style.left = (it.pos.x - it.w / 2) + 'px';
      b.style.top = (it.pos.y - it.h / 2) + 'px';
      b.style.width = it.w + 'px';
      b.style.height = it.h + 'px';
    }
  }
  function hitIndex(el) { const b = el && el.closest ? el.closest('.mt-marker-hit') : null; return b ? +b.dataset.i : -1; }

  function screenOf(it) {
    const r = root.getBoundingClientRect(), s = frameW / fr().width;
    return {
      x: r.left + it.pos.x * s, y: r.top + it.pos.y * s,
      rect: { left: r.left + (it.pos.x - it.w / 2) * s, top: r.top + (it.pos.y - it.h / 2) * s, right: r.left + (it.pos.x + it.w / 2) * s, bottom: r.top + (it.pos.y + it.h / 2) * s },
    };
  }
  function emitClick(i) {
    const it = live[i];
    if (!it || !cfg) return;
    const sc = screenOf(it);
    MT.bus.emit('store:click', { storeId: it.storeId, mapId: cfg.id, screen: { x: sc.x, y: sc.y }, rect: sc.rect });
  }
  /**
   * Save a drag / nudge (or its reset). A grouped logo moves as a group: its offset carries g: 1
   * (MT.layout keeps the group together at that spot) and replaces any offset of its members.
   * Dragging the dot of a grouped store (or a collapsed one) gives that store its own logo.
   */
  function commitOffset(i, reset) {
    const it = live[i];
    if (!it || !cfg) return;
    const offsets = Object.assign({}, cfg.markerOffsets || {});
    const ids = it.members && it.members.length ? it.members : [it.storeId];
    if (reset) {
      if (!ids.some((id) => offsets[id])) return;
      ids.forEach((id) => { delete offsets[id]; });
    } else {
      const W = fr().width;
      ids.forEach((id) => { delete offsets[id]; });
      offsets[it.storeId] = { dx: U.round((it.pos.x - it.anchor.x) / W, 5), dy: U.round((it.pos.y - it.anchor.y) / W, 5) };
      if (it.count > 1) offsets[it.storeId].g = 1;
    }
    const updated = MT.project.getMap(cfg.id) ? MT.project.updateMap(cfg.id, { markerOffsets: offsets }) : null;
    render(updated || Object.assign({}, cfg, { markerOffsets: offsets }));
  }

  function clampPos(it, x, y) {
    const F = fr(), m = 3;
    return { x: U.clamp(x, it.w / 2 + m, F.width - it.w / 2 - m), y: U.clamp(y, it.h / 2 + m, F.height - it.h / 2 - m) };
  }
  function moveLive(i, x, y) {
    const it = live[i], p = clampPos(it, x, y);
    it.pos.x = p.x; it.pos.y = p.y;
    // A dragged grouped store leaves its group: it is drawn as its own marker while dragging.
    if (it.grouped || it.collapsed) {
      const st = MT.layout.styleOf(cfg), size = (items.stats && items.stats.size) || st.size;
      it.grouped = false; it.collapsed = false;
      const d = MT.markers.dims(it.chainId, { kind: st.kind, size: size }); it.w = d.w; it.h = d.h;
      it.shape = items[i].shape === 'rect' || st.kind === 'card' ? 'rect' : 'circle';
    }
    const from = it.leaderFrom ? live.find((x) => x.storeId === it.leaderFrom) : null;
    const d = (from || it).dot || it.anchor;
    it.leader = MT.layout.leaderFor(it.shape === 'circle', d.x, d.y, p.x, p.y, it.w, it.h);
    // A grouped logo's spokes follow it.
    if (it.count > 1 && it.members) it.spokes = MT.layout.spokesFor(it, it.members.map((id) => live.find((x) => x.storeId === id)));
    it.displaced = true;
    positionHits();
    draw();
  }

  /** Pointer + keyboard handling for the marker buttons (event delegation on the hits layer). */
  function bindHits() {
    hits.addEventListener('pointerdown', (e) => {
      const i = hitIndex(e.target);
      if (i < 0 || e.button !== 0) return;
      e.preventDefault();
      e.target.closest('.mt-marker-hit').focus({ preventScroll: true });
      e.target.setPointerCapture(e.pointerId);
      drag = { i: i, id: e.pointerId, sx: e.clientX, sy: e.clientY, px: live[i].pos.x, py: live[i].pos.y, moved: false, el: e.target };
    });
    hits.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.id) {
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!drag.moved) { drag.moved = true; hideTip(); root.classList.add('is-dragging'); }
        const s = frameW / fr().width;
        moveLive(drag.i, drag.px + dx / s, drag.py + dy / s);
        return;
      }
      const i = hitIndex(e.target);
      if (i >= 0) setHover(i);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      root.classList.remove('is-dragging');
      try { d.el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      if (e.type === 'pointercancel') { resetLive(); positionHits(); draw(); return; }
      if (d.moved) commitOffset(d.i, false); else emitClick(d.i);
    };
    hits.addEventListener('pointerup', end);
    hits.addEventListener('pointercancel', end);
    hits.addEventListener('dblclick', (e) => { const i = hitIndex(e.target); if (i >= 0) { e.preventDefault(); commitOffset(i, true); } });
    hits.addEventListener('pointerover', (e) => { const i = hitIndex(e.target); if (i >= 0 && !drag) setHover(i); });
    hits.addEventListener('pointerout', (e) => {
      const i = hitIndex(e.target);
      if (i >= 0 && !drag && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.mt-marker-hit') === e.target.closest('.mt-marker-hit'))) setHover(-1);
    });
    hits.addEventListener('focusin', (e) => { const i = hitIndex(e.target); if (i >= 0) { setRoving(live[i].storeId); setHover(i); } });
    hits.addEventListener('focusout', () => { if (!drag) setHover(-1); });
    hits.addEventListener('keydown', onKey);
    // Wheel over a marker still zooms the map.
    hits.addEventListener('wheel', (e) => {
      if (!map) return;
      e.preventDefault();
      map.getCanvasContainer().dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
  }

  function onKey(e) {
    const i = hitIndex(e.target);
    if (i < 0) return;
    const step = e.shiftKey ? 16 : 4;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emitClick(i); return; }
    const nav = { PageDown: 1, PageUp: -1, n: 1, N: 1, p: -1, P: -1, Home: -Infinity, End: Infinity }[e.key];
    if (nav !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const order = readingOrder(), at = order.indexOf(i);
      const k = nav === -Infinity ? 0 : nav === Infinity ? order.length - 1 : U.clamp(at + nav, 0, order.length - 1);
      refocus(order[k]);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); commitOffset(i, true); refocus(i); return; }
    if (moves[e.key]) {
      e.preventDefault();
      moveLive(i, live[i].pos.x + moves[e.key][0], live[i].pos.y + moves[e.key][1]);
      showTip(i);
      if (nudgeCommit) clearTimeout(nudgeCommit.timer);
      const id = live[i].storeId;
      // Saved after a short pause (one write per burst of key presses). If the slide changes
      // first, leaveMap() runs it right away, on this slide.
      const run = (keepFocus) => {
        const j = live.findIndex((x) => x.storeId === id);
        if (j >= 0) { commitOffset(j, false); if (keepFocus !== false) refocus(j); }
      };
      nudgeCommit = { run: run, timer: setTimeout(() => { nudgeCommit = null; run(true); }, 450) };
    }
  }
  function refocus(i) {
    const id = live[i] && live[i].storeId;
    requestAnimationFrame(() => {
      const b = id && hits.querySelector('[data-store-id="' + CSS.escape(id) + '"]');
      if (b) b.focus({ preventScroll: true });
    });
  }

  /* ---- Hover / tooltip ------------------------------------------------------------------------------ */
  function setHover(i) {
    const id = i >= 0 && live[i] ? live[i].storeId : null;
    if (id === hoverId) { if (i >= 0) showTip(i); return; }
    hoverId = id;
    if (i >= 0) showTip(i); else hideTip();
    draw();
  }
  function showTip(i) {
    const it = live[i];
    if (!it || !root) return;
    const s = frameW / fr().width;
    const store = MT.data.store(it.storeId);
    const chain = MT.data.chain(it.chainId);
    U.clear(els.tip);
    U.append(els.tip, [
      h('div', { class: 'mt-mapview__tip-title' }, (it.number ? it.number + '. ' : '') + (it.name || chain.name)),
      h('div', { class: 'mt-mapview__tip-sub' }, [chain.name, store && store.district].filter(Boolean).join(' · ')),
      it.count > 1 ? h('div', { class: 'mt-mapview__tip-sub' }, MT.t('map.marker.group', { n: it.count, chain: chain.name })) : null,
      h('div', { class: 'mt-mapview__tip-hint' }, MT.t('map.marker.hint')),
    ]);
    els.tip.hidden = false;
    const x = it.pos.x * s, top = (it.pos.y - it.h / 2) * s;
    const below = top < els.tip.offsetHeight + 16;
    els.tip.classList.toggle('is-below', below);
    els.tip.style.top = (below ? (it.pos.y + it.h / 2) * s : top) + 'px';
    // Keep the bubble inside the frame; the arrow keeps pointing at the marker.
    const half = els.tip.offsetWidth / 2, pad = 6;
    const cx = U.clamp(x, half + pad, Math.max(half + pad, frameW - half - pad));
    els.tip.style.left = cx + 'px';
    els.tip.style.setProperty('--mt-tip-arrow', (x - cx) + 'px');
  }
  function hideTip() { if (els.tip) els.tip.hidden = true; }

  /* ---- UI chrome (preview only, never exported) ------------------------------------------------------ */
  const MINUS = '<svg class="mt-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M5 12h14"/></svg>';
  function ctrlButton(html, label, onClick) {
    return h('button', { type: 'button', class: 'mt-mapview__ctrl', title: label, 'aria-label': label, html: html, onclick: onClick });
  }
  function buildControls() {
    if (!els.controls) return;
    U.clear(els.controls);
    els.controls.setAttribute('aria-label', MT.t('map.controls'));
    const zoom = (dir) => () => {
      if (!map) return;
      if (dir > 0) map.zoomIn({ duration: 220 }); else map.zoomOut({ duration: 220 });
    };
    els.controls.appendChild(ctrlButton(MT.ui.icon('plus'), MT.t('map.zoomIn'), zoom(1)));
    els.controls.appendChild(ctrlButton(MINUS, MT.t('map.zoomOut'), zoom(-1)));
  }
  function chip(icon, text, title, onClick, kind) {
    const content = [h('span', { class: 'mt-icon', html: MT.ui.icon(icon, { size: 14 }) }), h('span', null, text)];
    const cls = 'mt-mapview__chip' + (kind ? ' mt-mapview__chip--' + kind : '');
    // Informational chips are not buttons (nothing to press); actions are real buttons.
    if (!onClick) return h('span', { class: cls + ' is-static', title: title, role: 'note' }, content);
    return h('button', { type: 'button', class: cls, title: title, 'aria-label': text + ' — ' + title, onclick: onClick }, content);
  }
  function labelCanvas() {
    if (map) map.getCanvas().setAttribute('aria-label', MT.t('map.canvasAria'));
  }
  function updateUi() {
    if (!root) return;
    U.clear(els.chips);
    if (cfg) {
      const inProject = !!MT.project.getMap(cfg.id);
      if (cfg.view && inProject) {
        els.chips.appendChild(chip('target', MT.t('map.chip.manualView'), MT.t('map.resetView'), () => {
          MT.project.updateMap(cfg.id, { view: null });
          render(MT.project.getMap(cfg.id));
        }));
      }
      const moved = Object.keys(cfg.markerOffsets || {}).filter((id) => items.some((it) => it.storeId === id)).length;
      if (moved && inProject) {
        els.chips.appendChild(chip('undo', MT.t('map.chip.moved', { n: moved }), MT.t('map.resetLayout'), () => {
          MT.project.updateMap(cfg.id, { markerOffsets: {} });
          render(MT.project.getMap(cfg.id));
        }));
      }
      const stats = items.stats;
      if (stats && stats.overlaps > 0) {
        els.chips.appendChild(chip('warning', MT.t('map.chip.overlaps', { n: stats.overlaps }), MT.t('map.chip.overlapsHint'), null, 'warn'));
      }
      if (stats && stats.collapsed > 0) {
        els.chips.appendChild(chip('info', MT.t('map.chip.collapsed', { n: stats.collapsed }), MT.t('map.chip.collapsedHint'), null, 'warn'));
      }
    }
    // Centre notice for empty / error states.
    let key = null;
    if (webglFailed) key = 'webglError';
    else if (basemapFailed) key = 'basemapError';
    else if (!cfg) key = 'noMap';
    else if (MT.data.missing.stores) key = 'noData';
    else if (!(cfg.districts || []).length) key = 'noDistricts';
    else if (!items.length) key = MT.data.storesForMap(cfg).length ? 'outOfView' : 'noStores';
    els.notice.hidden = !key;
    root.classList.toggle('has-notice', !!key);
    if (key) {
      U.clear(els.notice);
      // The two states the user can fix from here get a button: retry the basemap, pick districts.
      let action = null;
      if (key === 'basemapError') action = MT.ui.button({ icon: 'refresh', label: MT.t('common.retry'), kind: 'secondary', size: 'sm', onClick: retryBasemap });
      else if (key === 'noDistricts' && MT.mapsui && MT.mapsui.focusDistricts && MT.project.getMap(cfg.id)) {
        action = MT.ui.button({ icon: 'pin', label: MT.t('map.notice.noDistricts.action'), kind: 'primary', size: 'sm', onClick: () => MT.mapsui.focusDistricts() });
      }
      // First run (a blank project): also offer the built-in example with the 4 reference slides.
      const example = key === 'noDistricts' && action && MT.app.exampleAvailable && MT.app.exampleAvailable() && MT.app.isBlankProject()
        ? MT.ui.button({ icon: 'slides', label: MT.t('project.example.button'), kind: 'ghost', size: 'sm', className: 'mt-mapview__example', onClick: () => MT.app.openExampleProject() }) : null;
      U.append(els.notice, [
        h('span', { class: 'mt-mapview__notice-icon', html: MT.ui.icon(key === 'basemapError' || key === 'webglError' ? 'cloudOff' : key === 'noData' ? 'warning' : key === 'noMap' ? 'map' : 'pin', { size: 20 }) }),
        h('div', { class: 'mt-mapview__notice-title' }, MT.t('map.notice.' + key + '.title')),
        h('div', { class: 'mt-mapview__notice-text' }, MT.t('map.notice.' + key + '.text')),
        action ? h('div', { class: 'mt-mapview__notice-actions' }, action, example) : null,
      ]);
      // The whole "Elige los distritos" card leads to the district search (it is the first step).
      els.notice.classList.toggle('is-action', key === 'noDistricts' && !!action);
      els.notice.onclick = key === 'noDistricts' && action ? (e) => { if (!e.target.closest('button')) MT.mapsui.focusDistricts(); } : null;
    }
    updateLoading();
  }
  function updateLoading() {
    if (!els.loading) return;
    const show = !!map && !firstIdle && !basemapFailed;
    els.loading.hidden = !show;
    const t = els.loading.querySelector('.mt-mapview__loading-text');
    if (t) t.textContent = MT.t('map.loading');
  }

  MT.mapview = {
    mount: function (el) { return mount(el); },
    render: render,
    getMap: function () { return map; },
    resize: function () { frameW = 0; resize(); },
    /** Lift one marker (e.g. while M2 shows its popup); null clears. */
    highlight: function (storeId) { selectedId = storeId || null; draw(); },
    /** Current layout items (read-only) and live state, for tests/other modules. */
    items: function () { return items; },
    state: function () {
      return { id: cfg && cfg.id, view: view, styleReady: styleReady, idle: firstIdle, failed: basemapFailed || webglFailed, webgl: !webglFailed, frame: { width: frameW, height: frameH }, n: items.length, stats: items.stats || null };
    },
    basemap: { patch: patchStyle, ensureLayers: ensureLayers, apply: applyOverlays, firstSymbolId: firstSymbolId, harvestPlaces: harvestPlaces,
      harvestLabels: harvestLabels, districtLabelData: districtLabelData, zoomCurve: zoomCurve, blockerData: blockerData, blockerKey: blockerKey, roadNamesCover: roadNamesCover,
      PLACE_LABEL_LAYERS: PLACE_LABEL_LAYERS, LAYERS: L },
  };
})();
