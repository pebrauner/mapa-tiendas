/* js/analysis.js — MT.analysis: straight-line distance & cannibalization analysis (SPEC §6, phase 2a).
 *
 * Pure and deterministic: functions of their arguments and MT.data (no DOM, no network, no
 * randomness, stable ordering — distance, then store id). Results are plain objects whose `store`
 * fields are the shared MT.data records: READ-ONLY.
 *
 * DISTANCES = MT.geo.distanceMeters: haversine on a sphere of radius R = 6 371 008.8 m (the IUGG
 * mean Earth radius, the same as turf). Compared with the WGS84 ellipsoid (Vincenty) the error is
 * at most ≈0.56 % (north–south lines at the equator; ≈0.52 % at Lima's latitude, ≈0.13 % east–west)
 * — a few metres per kilometre, far below the accuracy of a store's coordinates. Every module (the
 * v1 radius tool, this engine, the slides) uses this one formula, so a pair of stores always shows
 * the same distance everywhere. No routing: these are straight-line distances.
 * BEARINGS: initial great-circle bearing from the reference to the store, degrees clockwise from
 * north (0…360). Compass codes 'N','NE','E','SE','S','SW','W','NW' (45° sectors, N = [337.5, 22.5));
 * they are language-neutral codes — show them with MT.t('analysis.dir.' + code).
 *
 * CONTRACT (docs/ARCHITECTURE.md §8):
 *   References
 *     refFromStore(id) → ref | null           {type:'store', storeId, chainId, lat, lng, label (= store name)}
 *     refFromPoint({lat, lng, label?, chainId?}) → ref | null
 *                                             {type:'point', chainId (own chain or null), lat, lng, label ('' = none)}
 *     resolveRef(x) → ref | null              x = store id | ref | saved slide ref ({type, storeId?, lat?, lng?, label?,
 *                                             chainId?}) | a distancesFrom result. A store reference follows the
 *                                             store's CURRENT position; a store gone from the database falls back to
 *                                             the saved lat/lng (`missing: true`).
 *     refLabel(x) · subtitle(analysis) · defaultChains(ref) · formatCoords(lat, lng)
 *   Geometry
 *     bearing(a, b) → deg | null · compass(deg) → code | null · destination(lat, lng, deg, m) → {lat, lng}
 *     ringBbox(x, meters) → [w,s,e,n] (exact bounding box of the circle) · ringFeatures(x, rings, {steps})
 *     → FeatureCollection of geodesic circles {properties:{meters, label (the typed value, "1.25 km")}} ·
 *     formatMeters(m) (a measured distance, "1.5 km" = MT.i18n.formatDistance)
 *   Universes
 *     storesForRegion({districts?, chains?, hiddenStores?, exclude?, includeToVerify=true, stores?}) → store[]
 *       non-closed stores with coordinates; districts [] = all of Peru; chains = array of ids (exactly those)
 *       | {id: bool} toggles like a map (missing → chain.defaultOn) | null = every chain; sorted by id.
 *       With a map config it gives the same stores as MT.data.storesForMap for an "only inside" map.
 *     index(stores, {cellMeters=1000}) → grid spatial index {size, within(lat, lng, m, test?) → [{store, meters}],
 *       nearest(lat, lng, test?, {maxMeters, start}) → {store, meters} | null}
 *   Analyses
 *     distancesFrom(ref, {chains, maxMeters (null = all Peru), districts, includeToVerify=true, exclude, stores})
 *       → {ref, rows:[{store, meters, bearingDeg, dir, sameChain (bool | null for a point without chain),
 *          flags:{toVerify, approx}, rank}], params}   sorted by meters then id; the reference store itself,
 *          closed stores and stores without coordinates are never included; d ≤ maxMeters.
 *     ringSummary(rows | result, rings=[500,1000,2000,3000,5000]) → {rings, relation, total, bands:[{from, to,
 *          total, sameChain, competitors, byChain:{id:n}}], beyond, cumulative:[{to, …}]}  — band i holds
 *          rings[i-1] < d ≤ rings[i] (the first one 0 ≤ d ≤ rings[0]); `beyond` = d > last ring.
 *     nearest(refOrId | result, {chainId | sameChain | competitors, limit=1, …distancesFrom opts}) → rows
 *     nearestByChain(rows | result) → rows (the nearest store of each chain, nearest first)
 *     summary(result) → {nearestSame, nearestCompetitor, byChain}
 *     neighborMatrix(stores, {radius=1000, candidates=stores}) → [{store, nearestSame:{store, meters} | null,
 *          nearestCompetitor:{store, chainId, meters} | null, sameWithin, competitorsWithin, byChainWithin}]
 *          one row per (non-closed, located) store, sorted by id; "within" = d ≤ radius, the store excluded.
 *     closePairs(stores, {meters=1000, sameChainOnly=false, candidates}) → [{a, b, meters, sameChain}]  each
 *          pair once (a.id < b.id), d ≤ meters; same-chain pairs first, then meters, then ids (comparePairs).
 *          candidates: b is taken from them (a from stores) — chunks of a list against the whole list.
 *     forMap(mapCfg) → {ref, label, rows, summary, top, lines, rings, maxMeters} | null — what an analysis
 *          slide draws (SPEC §6.3), over MT.data.storesForMap(mapCfg).
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util;

  const R = 6371008.8;                 // = MT.geo.distanceMeters' sphere (metres)
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const DEFAULT_RINGS = [500, 1000, 2000, 3000, 5000];
  const CELL_METERS = 1000;
  const EPS_DEG = 1e-9;                // margin of the bounding boxes (≈0.1 mm): never miss a point on a ring

  const finite = (v) => typeof v === 'number' && isFinite(v);
  const toNum = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : +v);
  const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const hasCoords = (s) => !!s && finite(s.lat) && finite(s.lng);
  const dist = (a, b) => MT.geo.distanceMeters(a, b);
  /** Better hit: nearer, or as near and a smaller id (deterministic ties). */
  const better = (h, best) => !best || h.meters < best.meters || (h.meters === best.meters && h.store.id < best.store.id);
  function sortKeys(o) { const out = {}; Object.keys(o).sort(cmpId).forEach((k) => { out[k] = o[k]; }); return out; }

  /* ---- References -------------------------------------------------------------------------- */
  /** Reference = a store of the database (its current position; label = its name). */
  function refFromStore(id) {
    const s = typeof id === 'string' && id ? MT.data.store(id) : null;
    if (!hasCoords(s)) return null;
    return { type: 'store', storeId: s.id, chainId: s.chain || null, lat: s.lat, lng: s.lng, label: s.name || s.id };
  }

  /** Reference = a point (clicked, pasted, geocoded). chainId = the user's "own chain" for it, or null. */
  function refFromPoint(p) {
    if (!p || typeof p !== 'object') return null;
    const lat = toNum(p.lat), lng = toNum(p.lng !== undefined ? p.lng : p.lon);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const chainId = typeof p.chainId === 'string' && p.chainId.trim() ? p.chainId.trim() : null;
    return { type: 'point', chainId: chainId, lat: U.round(lat, 6), lng: U.round(lng, 6), label: typeof p.label === 'string' ? p.label.trim() : '' };
  }

  /**
   * Any reference form → a normalized reference, or null. Accepts a store id, a normalized or saved
   * reference, or a distancesFrom result.
   */
  function resolveRef(x) {
    if (!x) return null;
    if (typeof x === 'string') return refFromStore(x);
    if (typeof x !== 'object') return null;
    if (Array.isArray(x.rows) && x.ref && typeof x.ref === 'object') return x.ref;
    const type = x.type === 'store' || x.type === 'point' ? x.type : (x.storeId ? 'store' : 'point');
    if (type === 'point') return refFromPoint(x);
    const r = refFromStore(x.storeId);
    if (r) return r;
    // The store left the database (deleted, re-scanned under another id): a saved slide keeps
    // measuring from the store's last known position.
    const p = typeof x.storeId === 'string' && x.storeId ? refFromPoint(x) : null;
    return p ? { type: 'store', storeId: x.storeId, chainId: p.chainId, lat: p.lat, lng: p.lng, label: p.label || x.storeId, missing: true } : null;
  }

  /** "-12.12190, -77.02970" (5 decimals ≈ 1 m). */
  function formatCoords(lat, lng) { return (+lat).toFixed(5) + ', ' + (+lng).toFixed(5); }

  /** The reference's name for texts: its label, a store's name, or its coordinates. */
  function refLabel(x) {
    const r = resolveRef(x) || (x && typeof x === 'object' ? x : {});
    if (r.label) return r.label;
    if (finite(r.lat) && finite(r.lng)) return formatCoords(r.lat, r.lng);
    return r.storeId || '';
  }

  /** Automatic slide subtitle of an analysis (Spanish slide text from MT.theme.analysis). */
  function subtitle(analysis) {
    const ref = analysis && analysis.ref;
    if (!ref) return '';
    const T = MT.theme.analysis;
    const r = resolveRef(ref) || ref;
    if (r.label) return T.subtitle.replace('{ref}', r.label);
    if (finite(r.lat) && finite(r.lng)) return T.subtitlePoint.replace('{coords}', formatCoords(r.lat, r.lng));
    return T.subtitle.replace('{ref}', r.storeId || '');
  }

  /** Default chain selection of the Análisis tab (SPEC §6.1): chains on by default + the reference's chain. */
  function defaultChains(ref) {
    const r = resolveRef(ref);
    const ids = MT.data.chains().filter((c) => !c.unknown && c.defaultOn !== false).map((c) => c.id);
    if (r && r.chainId && ids.indexOf(r.chainId) < 0) ids.push(r.chainId);
    return ids;
  }

  /* ---- Geometry ---------------------------------------------------------------------------- */
  /** {lat, lng} of a point-like value: [lng, lat], {lat, lng}, a store, a reference or a store id. */
  function where(x) {
    if (Array.isArray(x)) return finite(+x[0]) && finite(+x[1]) ? { lat: +x[1], lng: +x[0] } : null;
    if (!x) return null;
    if (typeof x === 'string' || (typeof x === 'object' && (x.type || x.storeId || Array.isArray(x.rows)))) {
      const r = resolveRef(x);
      return r ? { lat: r.lat, lng: r.lng } : null;
    }
    const lat = toNum(x.lat), lng = toNum(x.lng !== undefined ? x.lng : x.lon);
    return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  /** Initial great-circle bearing a → b in degrees (0 = north, clockwise), null for the same point. */
  function bearing(a, b) {
    const p = where(a), q = where(b);
    if (!p || !q) return null;
    const f1 = p.lat * RAD, f2 = q.lat * RAD, dl = (q.lng - p.lng) * RAD;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    if (Math.abs(x) < 1e-15 && Math.abs(y) < 1e-15) return null;
    return (Math.atan2(y, x) * DEG + 360) % 360;
  }

  /** Compass code of a bearing: 45° sectors centred on N, NE, E, … (N = [337.5°, 22.5°)). */
  function compass(deg) {
    if (!finite(deg)) return null;
    return DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  /** Point reached from (lat, lng) after `meters` on the initial bearing `deg` (same sphere). */
  function destination(lat, lng, deg, meters) {
    const d = meters / R, f1 = lat * RAD, b = deg * RAD;
    const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b));
    const l2 = lng * RAD + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return { lat: f2 * DEG, lng: ((l2 * DEG + 540) % 360) - 180 };
  }

  /**
   * Half-extent in degrees of the bounding box of all points within `meters` of latitude `lat`
   * (spherical cap): |Δlat| ≤ m/R, |Δlng| ≤ asin(sin(m/R) / cos lat). null when the cap reaches a pole.
   */
  function capSpan(lat, meters) {
    const d = meters / R, dLat = d * DEG;
    if (!(meters >= 0) || Math.abs(lat) + dLat >= 90) return null;
    const s = Math.sin(d) / Math.cos(lat * RAD);
    if (!(s < 1)) return null;
    return { dLat: dLat + EPS_DEG, dLng: Math.asin(s) * DEG + EPS_DEG };
  }

  /** [w, s, e, n] containing every point within `meters` of x (exact bounding box of the circle). */
  function ringBbox(x, meters) {
    const c = where(x);
    if (!c || !(meters >= 0)) return null;
    const sp = capSpan(c.lat, meters);
    if (!sp) return [-180, -90, 180, 90];
    return [c.lng - sp.dLng, c.lat - sp.dLat, c.lng + sp.dLng, c.lat + sp.dLat];
  }

  /** Positive finite ring distances, unique, ascending. */
  function normRings(rings) {
    const out = [];
    (Array.isArray(rings) ? rings : []).forEach((v) => { const m = toNum(v); if (isFinite(m) && m > 0 && out.indexOf(m) < 0) out.push(m); });
    return out.sort((a, b) => a - b);
  }

  /**
   * Text of a measured distance (es-PE decimal point, like "Peso: 15.8%"): "500 m", "1 km", "1.5 km",
   * "12 km" — MT.i18n.formatDistance, the same as MT.radius.formatMeters, MT.legend.distance and the
   * Análisis tab.
   */
  function formatMeters(m) { return MT.i18n.formatDistance(m); }

  /**
   * Geodesic circles (rings) around a reference: points exactly `meters` away on the analysis sphere,
   * counter-clockwise from north (GeoJSON exterior rings), so a store drawn inside a ring is counted
   * in it. properties: {meters, label}. Ascending order.
   */
  function ringFeatures(x, rings, opts) {
    const c = where(x), steps = Math.max(8, (opts && opts.steps) | 0 || 96);
    const list = c ? normRings(rings) : [];
    return {
      type: 'FeatureCollection',
      features: list.map((m) => {
        const ring = [];
        for (let i = 0; i < steps; i++) {
          const p = destination(c.lat, c.lng, -i * 360 / steps, m);
          ring.push([U.round(p.lng, 7), U.round(p.lat, 7)]);
        }
        ring.push(ring[0].slice());
        return { type: 'Feature', properties: { meters: m, label: MT.i18n.formatDistanceExact(m) }, geometry: { type: 'Polygon', coordinates: [ring] } };
      }),
    };
  }

  /* ---- Universes --------------------------------------------------------------------------- */
  /** Chain filter: array → exactly those ids; {id: bool} → map toggles (missing → defaultOn); else all. */
  function chainTest(chains) {
    if (Array.isArray(chains)) { const set = new Set(chains.map(String)); return (id) => set.has(id); }
    if (chains && typeof chains === 'object') {
      const cfg = { chains: chains }, memo = {};
      return (id) => (id in memo ? memo[id] : (memo[id] = MT.data.chainOn(cfg, id)));
    }
    return () => true;
  }

  /** Stores of a region: see the contract above. */
  function storesForRegion(cfg) {
    cfg = cfg || {};
    const districts = Array.isArray(cfg.districts) ? cfg.districts.map(String) : [];
    const dset = districts.length ? new Set(districts) : null;
    const hidden = new Set([].concat(cfg.hiddenStores || [], cfg.exclude || []).map(String));
    const chainOk = chainTest(cfg.chains);
    const toVerify = cfg.includeToVerify !== false;
    const src = Array.isArray(cfg.stores) ? cfg.stores : MT.data.stores();
    const seen = new Set(), out = [];
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      if (!hasCoords(s) || s.status === 'closed' || seen.has(s.id) || hidden.has(s.id)) continue;
      if (!toVerify && s.status === 'to_verify') continue;
      if (dset && !dset.has(s.ubigeo)) continue;
      if (!chainOk(s.chain)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out.sort((a, b) => cmpId(a.id, b.id));
  }

  /** Non-closed located stores, one per id, sorted by id (inputs of the store-to-store analyses). */
  function clean(stores) {
    const seen = new Set(), out = [];
    (stores || []).forEach((s) => {
      if (!hasCoords(s) || s.status === 'closed' || seen.has(s.id)) return;
      seen.add(s.id); out.push(s);
    });
    return out.sort((a, b) => cmpId(a.id, b.id));
  }

  /**
   * Grid spatial index. Cells are `cellMeters` tall (in degrees of latitude) and as wide at the
   * mean |latitude| of the points (degrees of longitude adjusted by cos lat). A query scans only the
   * cells of the circle's exact bounding box (capSpan) and measures each point there with
   * MT.geo.distanceMeters — so results equal a brute-force scan. When the box would cover more cells
   * than there are points (huge radius, few points) or crosses ±180°/a pole, it scans the points
   * instead (cost ≤ min(cells, points)).
   */
  function makeIndex(stores, opts) {
    const cellM = opts && opts.cellMeters > 0 ? +opts.cellMeters : CELL_METERS;
    const pts = (stores || []).filter(hasCoords);
    let sum = 0;
    pts.forEach((s) => { sum += Math.abs(s.lat); });
    const refLat = pts.length ? Math.min(80, sum / pts.length) : 0;
    const cellLat = cellM / R * DEG, cellLng = cellLat / Math.cos(refLat * RAD);
    const KEY = 16777216; // 2^24: |ix| stays far below it for cells ≥ 10 m, so keys are unique and exact
    const cells = new Map();
    pts.forEach((s) => {
      const k = Math.floor(s.lat / cellLat) * KEY + Math.floor(s.lng / cellLng);
      let c = cells.get(k);
      if (!c) cells.set(k, (c = []));
      c.push(s);
    });

    /** Cell range covering the circle, or null when scanning the points is cheaper / required. */
    function span(lat, lng, meters) {
      const sp = capSpan(lat, meters);
      if (!sp || lng - sp.dLng < -180 || lng + sp.dLng > 180) return null;
      const y0 = Math.floor((lat - sp.dLat) / cellLat), y1 = Math.floor((lat + sp.dLat) / cellLat);
      const x0 = Math.floor((lng - sp.dLng) / cellLng), x1 = Math.floor((lng + sp.dLng) / cellLng);
      return (y1 - y0 + 1) * (x1 - x0 + 1) > pts.length ? null : { y0: y0, y1: y1, x0: x0, x1: x1 };
    }
    function scan(list, q, meters, test, out) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (test && !test(s)) continue;
        const d = dist(q, s);
        if (d <= meters) out.push({ store: s, meters: d });
      }
    }
    /** Every point with distance ≤ meters (and test(store) true): [{store, meters}] (cell order). */
    function within(lat, lng, meters, test) {
      const out = [], q = { lat: lat, lng: lng }, sp = span(lat, lng, meters);
      if (!sp) { scan(pts, q, meters, test, out); return out; }
      for (let iy = sp.y0; iy <= sp.y1; iy++) {
        for (let ix = sp.x0; ix <= sp.x1; ix++) {
          const c = cells.get(iy * KEY + ix);
          if (c) scan(c, q, meters, test, out);
        }
      }
      return out;
    }
    /**
     * Nearest point passing test (ties → smaller id), or null. Searches circles growing ×4 from
     * opts.start (default 2 cells): the first circle holding a match holds the nearest one.
     */
    function nearest(lat, lng, test, o) {
      const max = o && o.maxMeters > 0 ? +o.maxMeters : Infinity;
      let r = Math.min(max, o && o.start > 0 ? +o.start : 2 * cellM);
      for (;;) {
        let hits;
        if (!isFinite(r) || !span(lat, lng, r)) { hits = []; scan(pts, { lat: lat, lng: lng }, max, test, hits); r = max; }
        else hits = within(lat, lng, r, test);
        if (hits.length) { let b = null; hits.forEach((h) => { if (better(h, b)) b = h; }); return b; }
        if (r >= max) return null;
        r = Math.min(max, r * 4);
      }
    }
    return { size: pts.length, cellMeters: cellM, cellLat: cellLat, cellLng: cellLng, cells: cells.size, within: within, nearest: nearest };
  }

  /* ---- Mode A: distances to a reference ---------------------------------------------------- */
  function distancesFrom(refIn, opts) {
    opts = opts || {};
    const ref = resolveRef(refIn);
    const maxMeters = finite(toNum(opts.maxMeters)) && +opts.maxMeters > 0 ? +opts.maxMeters : null;
    const params = {
      chains: Array.isArray(opts.chains) ? opts.chains.slice() : opts.chains && typeof opts.chains === 'object' ? Object.assign({}, opts.chains) : null,
      maxMeters: maxMeters,
      districts: Array.isArray(opts.districts) ? opts.districts.map(String) : [],
      includeToVerify: opts.includeToVerify !== false,
    };
    if (!ref) return { ref: null, rows: [], params: params };
    const universe = storesForRegion({ stores: opts.stores, chains: opts.chains, districts: params.districts,
      includeToVerify: params.includeToVerify, exclude: [].concat(opts.exclude || [], opts.hiddenStores || []) });
    const rows = [];
    for (let i = 0; i < universe.length; i++) {
      const s = universe[i];
      if (ref.type === 'store' && s.id === ref.storeId) continue;
      const d = dist(ref, s);
      if (maxMeters !== null && !(d <= maxMeters)) continue;
      rows.push({ store: s, meters: d });
    }
    rows.sort((a, b) => a.meters - b.meters || cmpId(a.store.id, b.store.id));
    return {
      ref: ref,
      rows: rows.map((r, i) => {
        const deg = r.meters > 0 ? bearing(ref, r.store) : null;
        return {
          store: r.store, meters: r.meters, bearingDeg: deg, dir: compass(deg),
          sameChain: ref.chainId ? r.store.chain === ref.chainId : null,
          flags: { toVerify: r.store.status === 'to_verify', approx: r.store.precision === 'approx' },
          rank: i + 1,
        };
      }),
      params: params,
    };
  }

  /** Ring bands × (same chain / competitors / per chain), plus cumulative counts (d ≤ ring). */
  function ringSummary(input, rings) {
    const rows = Array.isArray(input) ? input : (input && input.rows) || [];
    const ref = !Array.isArray(input) && input && input.ref ? input.ref : null;
    const list = normRings(rings === undefined || rings === null ? DEFAULT_RINGS : rings);
    const relation = ref ? !!ref.chainId : rows.some((r) => r.sameChain === true || r.sameChain === false);
    const blank = (from, to) => ({ from: from, to: to, total: 0, sameChain: 0, competitors: 0, byChain: {} });
    const bands = list.map((to, i) => blank(i ? list[i - 1] : 0, to));
    const beyond = blank(list.length ? list[list.length - 1] : 0, null);
    const add = (b, r) => {
      b.total++;
      if (r.sameChain === true) b.sameChain++; else if (r.sameChain === false) b.competitors++;
      const c = r.store.chain;
      b.byChain[c] = (b.byChain[c] || 0) + 1;
    };
    rows.forEach((r) => {
      let i = 0;
      while (i < list.length && !(r.meters <= list[i])) i++;
      add(i < list.length ? bands[i] : beyond, r);
    });
    bands.forEach((b) => { b.byChain = sortKeys(b.byChain); });
    beyond.byChain = sortKeys(beyond.byChain);
    const cumulative = [];
    bands.forEach((b, i) => {
      const prev = i ? cumulative[i - 1] : blank(0, 0);
      const c = { to: b.to, total: prev.total + b.total, sameChain: prev.sameChain + b.sameChain, competitors: prev.competitors + b.competitors, byChain: Object.assign({}, prev.byChain) };
      Object.keys(b.byChain).forEach((k) => { c.byChain[k] = (c.byChain[k] || 0) + b.byChain[k]; });
      c.byChain = sortKeys(c.byChain);
      cumulative.push(c);
    });
    return { rings: list, relation: relation, total: rows.length, bands: bands, beyond: beyond, cumulative: cumulative };
  }

  /** Nearest rows to a reference (or filtered from a distancesFrom result), keeping their rank. */
  function nearest(x, opts) {
    opts = opts || {};
    const res = x && typeof x === 'object' && Array.isArray(x.rows) ? x : distancesFrom(x, opts);
    let rows = res.rows;
    if (opts.chainId) rows = rows.filter((r) => r.store.chain === opts.chainId);
    if (opts.sameChain) rows = rows.filter((r) => r.sameChain === true);
    if (opts.competitors) rows = rows.filter((r) => r.sameChain === false);
    const limit = opts.limit === undefined ? 1 : opts.limit === null ? Infinity : Math.max(0, Math.floor(+opts.limit) || 0);
    return isFinite(limit) ? rows.slice(0, limit) : rows.slice();
  }

  /** The nearest store of each chain (rows, nearest first) — the lines of an analysis slide. */
  function nearestByChain(x) {
    const rows = Array.isArray(x) ? x : (x && x.rows) || [];
    const seen = {}, out = [];
    rows.forEach((r) => { if (!seen[r.store.chain]) { seen[r.store.chain] = true; out.push(r); } });
    return out;
  }

  /** Headline of a distance table: nearest same-chain store, nearest competitor, nearest per chain. */
  function summary(res) {
    const rows = (res && res.rows) || [];
    return {
      nearestSame: rows.find((r) => r.sameChain === true) || null,
      nearestCompetitor: rows.find((r) => r.sameChain === false) || null,
      byChain: nearestByChain(rows),
    };
  }

  /* ---- Mode B: proximity between stores (cannibalization) ---------------------------------- */
  function neighborMatrix(stores, opts) {
    opts = opts || {};
    const radius = toNum(opts.radius) > 0 ? +opts.radius : 1000;
    const list = clean(stores);
    const cands = opts.candidates ? clean(opts.candidates) : list;
    const idx = makeIndex(cands);
    const byChainIdx = new Map();
    const chainIndex = (id) => {
      let x = byChainIdx.get(id);
      if (!x) byChainIdx.set(id, (x = makeIndex(cands.filter((s) => s.chain === id))));
      return x;
    };
    return list.map((s) => {
      const near = idx.within(s.lat, s.lng, radius, (o) => o.id !== s.id);
      let same = null, comp = null, sameN = 0, compN = 0;
      const byChain = {};
      near.forEach((h) => {
        const c = h.store.chain;
        byChain[c] = (byChain[c] || 0) + 1;
        if (c === s.chain) { sameN++; if (better(h, same)) same = h; } else { compN++; if (better(h, comp)) comp = h; }
      });
      // Nothing within the radius: search farther (circles from 2 × radius outwards).
      if (!same) same = chainIndex(s.chain).nearest(s.lat, s.lng, (o) => o.id !== s.id, { start: radius * 2 });
      if (!comp) comp = idx.nearest(s.lat, s.lng, (o) => o.chain !== s.chain, { start: radius * 2 });
      return {
        store: s,
        nearestSame: same ? { store: same.store, meters: same.meters } : null,
        nearestCompetitor: comp ? { store: comp.store, chainId: comp.store.chain, meters: comp.meters } : null,
        sameWithin: sameN, competitorsWithin: compN, byChainWithin: sortKeys(byChain),
      };
    });
  }

  /** Order of closePairs: same-chain pairs first, then meters, then the ids. */
  function comparePairs(x, y) { return (y.sameChain - x.sameChain) || (x.meters - y.meters) || cmpId(x.a.id, y.a.id) || cmpId(x.b.id, y.b.id); }
  /**
   * opts.candidates: pairs {a ∈ stores, b ∈ candidates, a.id < b.id} — so for chunks of one list L,
   * closePairs(chunk, {candidates: L}) over all the chunks, concatenated and sorted with comparePairs,
   * equals closePairs(L) (the Análisis tab computes big regions that way, in idle chunks).
   */
  function closePairs(stores, opts) {
    opts = opts || {};
    const meters = toNum(opts.meters) > 0 ? +opts.meters : 1000;
    const sameOnly = !!opts.sameChainOnly;
    const list = clean(stores);
    const idx = makeIndex(opts.candidates ? clean(opts.candidates) : list);
    const out = [];
    list.forEach((a) => {
      idx.within(a.lat, a.lng, meters, (b) => b.id > a.id && (!sameOnly || b.chain === a.chain)).forEach((h) => {
        out.push({ a: a, b: h.store, meters: h.meters, sameChain: h.store.chain === a.chain });
      });
    });
    return out.sort(comparePairs);
  }

  /* ---- Analysis slides (SPEC §6.3) ---------------------------------------------------------- */
  /**
   * What a slide with `mapCfg.analysis` shows: distances from its reference to the slide's stores
   * (MT.data.storesForMap — maxMeters / districts, chain toggles, hidden stores, includeToVerify),
   * ring counts, the nearest `listTop` rows and, when showLines, the nearest store of each chain.
   */
  function forMap(mapCfg) {
    const a = mapCfg && mapCfg.analysis;
    if (!a || typeof a !== 'object') return null;
    const ref = resolveRef(a.ref);
    if (!ref) return null;
    const res = distancesFrom(ref, { stores: MT.data.storesForMap(mapCfg) });
    const rings = normRings(a.rings);
    const top = Math.max(0, Math.floor(toNum(a.listTop)) || 0);
    return {
      ref: ref, label: refLabel(ref), rows: res.rows, summary: ringSummary(res, rings.length ? rings : DEFAULT_RINGS),
      top: res.rows.slice(0, top), lines: a.showLines === false ? [] : nearestByChain(res),
      rings: rings, maxMeters: toNum(a.maxMeters) > 0 ? +a.maxMeters : (rings.length ? rings[rings.length - 1] : null),
    };
  }

  MT.analysis = {
    EARTH_RADIUS: R, DIRS: DIRS, DEFAULT_RINGS: DEFAULT_RINGS, CELL_METERS: CELL_METERS,
    refFromStore: refFromStore, refFromPoint: refFromPoint, resolveRef: resolveRef,
    refLabel: refLabel, subtitle: subtitle, defaultChains: defaultChains, formatCoords: formatCoords,
    bearing: bearing, compass: compass, destination: destination, ringBbox: ringBbox, ringFeatures: ringFeatures,
    formatMeters: formatMeters, normRings: normRings,
    storesForRegion: storesForRegion, index: makeIndex,
    distancesFrom: distancesFrom, ringSummary: ringSummary, nearest: nearest, nearestByChain: nearestByChain, summary: summary,
    neighborMatrix: neighborMatrix, closePairs: closePairs, comparePairs: comparePairs,
    forMap: forMap,
  };
})();
