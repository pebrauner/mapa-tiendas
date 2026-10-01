/* js/radius.js — MT.radius: radius circles around stores = the basic cannibalization view
 * (SPEC §1 "Radius / cannibalization"). Module M1.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.1):
 *   MT.radius.compute(mapCfg) → [{
 *       storeId, meters, chainId,
 *       center: store,                            // MT.data.store(storeId)
 *       circle: GeoJSON Feature<Polygon>,         // turf.circle([lng,lat], meters/1000, {steps: 96}) (geodesic)
 *       inside: [{store, distance, sameChain}],   // sorted by distance (m, rounded); centre excluded
 *       sameChain: number, competitors: number
 *   }]  one per mapCfg.radius entry ({storeId, meters}); entries whose store is gone are skipped.
 *   Candidates: non-closed stores of chains toggled on in this map and not hidden on it — whatever
 *   the district filter (a competitor just across the border still counts).
 * Extras: features(mapCfg|results) → FeatureCollection with {color, stroke, fillOpacity} for map
 *   layers; labels(results, project) → label anchors; drawLabels(ctx, labels, scale); labelFont(fs);
 *   formatMeters();
 *   rows(results) → spreadsheet rows (header first, UI language) for MT.io.writeXLSX.
 * Phase 2 (full cannibalization analysis, ARCHITECTURE §8) reuses compute() for every store: it is a
 * pure function of (mapCfg, MT.data) and returns plain data.
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;

  /** Geodesic circle polygon (turf when available; same maths otherwise). */
  function circle(lng, lat, meters, steps) {
    steps = steps || 96;
    if (window.turf && window.turf.circle) {
      return window.turf.circle([lng, lat], meters / 1000, { steps: steps, units: 'kilometers' });
    }
    const R = 6371008.8, d = meters / R, la = lat * Math.PI / 180, lo = lng * Math.PI / 180, ring = [];
    for (let i = 0; i < steps; i++) {
      const b = -i * 2 * Math.PI / steps;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      ring.push([lo2 * 180 / Math.PI, la2 * 180 / Math.PI]);
    }
    ring.push(ring[0].slice());
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  }

  /**
   * Why a radius of this map is not drawn, or null when it is: 'missing' (store no longer in the
   * database), 'closed', 'hidden' (hidden on this map) or 'chainOff' (its chain is switched off).
   * A circle around a store that is not on the slide would point at nothing.
   */
  function inactiveReason(mapCfg, storeId) {
    const s = MT.data.store(storeId);
    if (!s || !isFinite(s.lat) || !isFinite(s.lng)) return 'missing';
    if (s.status === 'closed') return 'closed';
    if ((mapCfg.hiddenStores || []).indexOf(storeId) >= 0) return 'hidden';
    if (!MT.data.chainOn(mapCfg, s.chain)) return 'chainOff';
    return null;
  }

  function compute(mapCfg) {
    if (!mapCfg || !Array.isArray(mapCfg.radius) || !mapCfg.radius.length) return [];
    const hidden = {};
    (mapCfg.hiddenStores || []).forEach((id) => { hidden[id] = true; });
    const on = {};
    const candidates = MT.data.stores().filter((s) => {
      if (hidden[s.id] || !isFinite(s.lat) || !isFinite(s.lng)) return false;
      if (!(s.chain in on)) on[s.chain] = MT.data.chainOn(mapCfg, s.chain);
      return on[s.chain];
    });
    const out = [];
    mapCfg.radius.forEach((r) => {
      const center = r && MT.data.store(r.storeId);
      const meters = r ? +r.meters : NaN;
      if (!center || !(meters > 0) || inactiveReason(mapCfg, r.storeId)) return;
      // Bbox prefilter (stores are thousands), then exact haversine distance.
      const dLat = meters / 111320 * 1.02, dLng = meters / (111320 * Math.cos(center.lat * Math.PI / 180)) * 1.02;
      const inside = [];
      for (let i = 0; i < candidates.length; i++) {
        const s = candidates[i];
        if (s.id === center.id) continue;
        if (Math.abs(s.lat - center.lat) > dLat || Math.abs(s.lng - center.lng) > dLng) continue;
        const dist = MT.geo.distanceMeters(center, s);
        if (dist <= meters) inside.push({ store: s, distance: Math.round(dist), sameChain: s.chain === center.chain });
      }
      inside.sort((a, b) => a.distance - b.distance || (a.store.id < b.store.id ? -1 : 1));
      const same = inside.filter((x) => x.sameChain).length;
      const feature = circle(center.lng, center.lat, meters, 96);
      feature.properties = Object.assign({}, feature.properties, { storeId: center.id, meters: meters, chainId: center.chain });
      out.push({
        storeId: center.id, meters: meters, chainId: center.chain, center: center, circle: feature,
        inside: inside, sameChain: same, competitors: inside.length - same,
      });
    });
    return out;
  }

  /** Stroke / fill colours for a chain: brand colour, darkened when too light for a dashed line. */
  function colorsFor(chainId) {
    const base = MT.markers.chainColor(chainId);
    const lum = U.luminance(base);
    const stroke = lum > 0.42 ? MT.markers.darken(base, 0.3) : base;
    const m = /rgba?\([^)]*,\s*([\d.]+)\)\s*$/.exec(MT.theme.radius.fill || '');
    return { stroke: stroke, fill: base, fillOpacity: m ? +m[1] : 0.09 };
  }

  /** FeatureCollection for the map layers (properties: color, stroke, fillOpacity). */
  function features(x) {
    const results = Array.isArray(x) ? x : compute(x);
    return {
      type: 'FeatureCollection',
      features: results.map((r) => {
        const c = colorsFor(r.chainId);
        const f = U.clone(r.circle);
        f.properties = Object.assign({}, f.properties, { color: c.fill, stroke: c.stroke, fillOpacity: c.fillOpacity });
        return f;
      }),
    };
  }

  /** Slide text for a distance (Spanish: the deck is in Spanish): "500 m", "1 km", "1,5 km". */
  function formatMeters(m) {
    if (m < 1000) return Math.round(m) + ' m';
    const km = Math.round(m / 100) / 10;
    return String(km).replace('.', ',') + ' km';
  }

  /** Label anchors (reference units) at the top of each circle: [{x, y, text, color}]. */
  function labels(results, project) {
    return results.map((r) => {
      const dLat = r.meters / 111320;   // north edge of the circle
      const top = project([r.center.lng, r.center.lat + dLat]);
      return { x: top.x, y: top.y, text: formatMeters(r.meters), color: colorsFor(r.chainId).stroke, storeId: r.storeId };
    });
  }

  /**
   * Font of the "1 km" pills (fs in reference units): the slide font (Calibri, Carlito where it is
   * missing) — the PowerPoint pill is real Calibri text, so the PNG and the deck read the same
   * ("1 km", with its space: the UI font's narrow space made it look like "1km").
   */
  function labelFont(fs) { return '700 ' + fs + 'px ' + MT.theme.fonts.slideCss; }

  /** Draw radius labels (small white pills) on a canvas; coordinates = reference units × scale. */
  function drawLabels(ctx, list, scale, opts) {
    if (!list || !list.length) return;
    const lab = MT.theme.radius.label;
    const fs = MT.theme.pt2ref(lab.sizePt);
    const fr = MT.layout.frame();
    ctx.save();
    if (opts && (opts.offsetX || opts.offsetY)) ctx.translate(opts.offsetX || 0, opts.offsetY || 0);
    ctx.scale(scale, scale);
    ctx.font = labelFont(fs);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    list.forEach((l) => {
      const w = ctx.measureText(l.text).width + fs * 0.9, h = fs * 1.45;
      const x = U.clamp(l.x, w / 2 + 2, fr.width - w / 2 - 2), y = U.clamp(l.y, h / 2 + 2, fr.height - h / 2 - 2);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); else ctx.rect(x - w / 2, y - h / 2, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.fill();
      ctx.lineWidth = Math.max(0.8, MT.theme.radius.width * 0.6); ctx.strokeStyle = l.color; ctx.stroke();
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, x, y + fs * 0.04);
    });
    ctx.restore();
  }

  /** Spreadsheet rows for the radius results (header row first; UI language). */
  function rows(results) {
    const t = (k) => MT.t('map.radius.col.' + k);
    const out = [[t('center'), t('centerChain'), t('radius'), t('store'), t('chain'), t('relation'), t('distance'), t('address'), t('district')]];
    results.forEach((r) => {
      const cc = MT.data.chain(r.chainId).name;
      if (!r.inside.length) out.push([r.center.name, cc, r.meters, MT.t('map.radius.none'), '', '', '', '', '']);
      r.inside.forEach((x) => {
        out.push([r.center.name, cc, r.meters, x.store.name, MT.data.chain(x.store.chain).name,
          MT.t(x.sameChain ? 'map.radius.same' : 'map.radius.competitor'), x.distance, x.store.address, x.store.district]);
      });
    });
    return out;
  }

  MT.radius = {
    compute: compute,
    inactiveReason: inactiveReason,
    circle: circle,
    features: features,
    colorsFor: colorsFor,
    labels: labels,
    labelFont: labelFont,
    drawLabels: drawLabels,
    formatMeters: formatMeters,
    rows: rows,
  };
})();
