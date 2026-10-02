// tools/test/analysis.test.mjs — the phase 2a engine MT.analysis (SPEC §6.2) and the analysis parts of
// MT.data / MT.project (SPEC §6.3), on the REAL data (data/stores.js: ~3,500 stores incl. Tambo, Oxxo, Mass).
//
//   node tools/test/analysis.test.mjs
//
//  1. distances vs an independent Vincenty (WGS84 ellipsoid) implementation, bearings, compass codes
//  2. ring bands (inclusive upper bound d ≤ ring), cumulative counts, same chain / competitors
//  3. exclusions: closed stores, the reference itself, hidden / excluded, "por verificar", chains, districts
//  4. determinism (repeat, shuffled input)
//  5. grid spatial index == brute force for neighborMatrix / closePairs on all of Peru
//  6. performance budget (neighborMatrix over all of Peru < 300 ms)
//  7. MT.project analysis key: defaults, validation, normalize/updateMap/save round trip
//  8. MT.data.storesForMap / boundsForMap / subtitleFor for analysis slides; MT.analysis.forMap
//  9. the Análisis tab is registered between Mapas and Base de datos; zero console errors
//
// Accuracy note: MT.geo.distanceMeters is haversine on the mean-radius sphere (R = 6 371 008.8 m). Its
// error vs the ellipsoid is direction dependent: ≈0.13 % east–west but up to ≈0.56 % north–south near the
// equator (0.52 % at Lima) — the sphere's radius is larger than the ellipsoid's meridian radius there.
// The check below therefore uses the analytic bound 0.6 % for every direction and 0.5 % for the others.

import { openApp, makeChecker } from './lib.mjs';

const { check, finish } = makeChecker('analysis');

/* ---- Independent oracle: Vincenty inverse on WGS84 (T. Vincenty 1975) -------------------------------- */
function vincenty(lat1, lon1, lat2, lon2) {
  const a = 6378137, f = 1 / 298.257223563, b = (1 - f) * a, rad = Math.PI / 180;
  const L = (lon2 - lon1) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * rad)), U2 = Math.atan((1 - f) * Math.tan(lat2 * rad));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, lambdaP, iter = 200, sinSigma, cosSigma, sigma, cos2Alpha, cos2SigmaM;
  do {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinL / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cos2Alpha : 0;
    const C = f / 16 * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - lambdaP) > 1e-12 && --iter > 0);
  const uSq = cos2Alpha * (a * a - b * b) / (b * b);
  const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSigma = B * sinSigma * (cos2SigmaM + B / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
    B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - dSigma);
}
// The oracle itself: Flinders Peak → Buninyong, the textbook example (54 972.271 m).
check(Math.abs(vincenty(-37.95103342, 144.42486789, -37.65282114, 143.92649554) - 54972.271) < 0.01, 'Vincenty oracle reproduces the reference geodesic (54 972.271 m)');

const { browser, page, errors } = await openApp({ lang: 'es' });
try {
  const res = await page.evaluate(async () => {
    const out = [];
    const t = (ok, msg, extra) => out.push({ ok: !!ok, msg: msg + (extra !== undefined ? ` → ${JSON.stringify(extra)}` : '') });
    const A = MT.analysis, D = MT.data, G = MT.geo;
    const all = D.stores();                                   // non-closed, merged
    const withClosed = D.stores({ includeClosed: true });
    const fake = (id, chain, lat, lng, extra) => Object.assign({ id, chain, name: id, lat, lng, status: 'verified', precision: 'exact', ubigeo: '' }, extra || {});
    const pick = (chain, ubigeo) => all.find((s) => s.chain === chain && (!ubigeo || s.ubigeo === ubigeo)) || all.find((s) => s.chain === chain);
    const sig = (rows) => rows.map((r) => `${r.store.id}:${r.meters}:${r.dir}:${r.rank}`).join('|');

    t(all.length > 3000 && D.countsByChain().tambo > 0 && D.countsByChain().oxxo > 0 && D.countsByChain().mass > 0, 'real data loaded (Tambo, Oxxo and Mass included)', { stores: all.length });
    // Notes of the hand-placed rows are consistent: a press-only store never cites the official list for its district.
    const pressBad = withClosed.filter((s) => /reportada por la prensa/.test(s.notes || '') && /según la lista oficial/.test(s.notes || '')).map((s) => s.id);
    t(pressBad.length === 0, 'press-reported rows say "distrito según la prensa", not "según la lista oficial"', pressBad);

    /* ---- 1. distances, bearings ------------------------------------------------------------------ */
    const origins = [[-3.75, -73.25], [-5.19, -80.63], [-8.11, -79.03], [-12.12, -77.03], [-16.40, -71.54], [-18.01, -70.25]];
    const meters = [50, 100, 500, 1000, 2500, 5000, 10000, 20000];
    const pairs = [];
    let n = 0;
    origins.forEach(([lat, lng]) => {
      const ref = A.refFromPoint({ lat, lng, label: 'Origen' });
      const stores = [];
      for (let b = 0; b < 360; b += 15) meters.forEach((m) => { const p = A.destination(lat, lng, b, m); stores.push(fake('t' + (n++), 'x', p.lat, p.lng, { _b: b, _m: m })); });
      const rows = A.distancesFrom(ref, { stores }).rows;
      rows.forEach((r) => pairs.push({ lat1: lat, lng1: lng, lat2: r.store.lat, lng2: r.store.lng, m: r.meters, b: r.store._b, want: r.store._m, same: r.meters === G.distanceMeters(ref, r.store), brg: r.bearingDeg }));
    });
    t(pairs.every((p) => p.same), 'row.meters is exactly MT.geo.distanceMeters(ref, store)', pairs.length);
    t(pairs.every((p) => Math.abs(p.m - p.want) <= 1e-6 * p.want + 1e-6), 'destination() and the distance agree (same sphere)');
    t(pairs.every((p) => Math.abs(((p.brg - p.b + 540) % 360) - 180) < 0.02), 'bearing(origin, destination(origin, θ)) ≈ θ for every 15°');
    const o = { lat: -12.12, lng: -77.03 };
    const card = [[{ lat: -12.11, lng: -77.03 }, 0, 'N'], [{ lat: -12.13, lng: -77.03 }, 180, 'S'], [{ lat: -12.12, lng: -77.02 }, 90, 'E'], [{ lat: -12.12, lng: -77.04 }, 270, 'W']];
    t(card.every(([p, deg, c]) => Math.abs(((A.bearing(o, p) - deg + 540) % 360) - 180) < 0.01 && A.compass(A.bearing(o, p)) === c), 'cardinal bearings N / E / S / W', card.map(([p]) => A.bearing(o, p)));
    t(A.bearing(o, { lat: -12.12, lng: -77.03 }) === null && A.compass(null) === null, 'same point → no bearing');
    t(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].every((c, i) => A.compass(i * 45) === c && A.compass(i * 45 + 22.4) === c && A.compass((i * 45 - 22.4 + 360) % 360) === c), 'compass: 45° sectors centred on N, NE, E, …');
    t(A.compass(22.6) === 'NE' && A.compass(337.4) === 'NW' && A.compass(337.6) === 'N' && A.compass(359.99) === 'N' && A.compass(-90) === 'W' && A.compass(720 + 90) === 'E', 'compass sector edges and angles outside 0–360');
    const ring = A.ringFeatures(o, [500, 2000], { steps: 64 });
    const verts = ring.features[1].geometry.coordinates[0];
    t(ring.features.length === 2 && ring.features[0].properties.label === '500 m' && ring.features[1].properties.label === '2 km' && verts.length === 65 &&
      verts.every((v) => Math.abs(G.distanceMeters(o, { lng: v[0], lat: v[1] }) - 2000) < 0.05), 'ringFeatures: geodesic circles exactly 2 km from the reference');
    const bb = A.ringBbox(o, 2000);
    t([0, 90, 180, 270].every((b) => { const p = A.destination(o.lat, o.lng, b, 2000); return G.bboxContains(bb, p.lat, p.lng); }) &&
      Math.abs((bb[3] - bb[1]) / 2 - 2000 / 6371008.8 * 180 / Math.PI) < 1e-6, 'ringBbox is the exact box of the circle', bb);
    t(A.formatMeters(500) === '500 m' && A.formatMeters(1000) === '1 km' && A.formatMeters(1500) === '1.5 km', 'slide distance text (Spanish, Peru: decimal point)');
    // One distance text everywhere (MT.i18n.formatDistance): the Mapas popups, the slides, the v1 radius
    // notes, the engine and the Análisis tab agree, also at the boundaries (0.1 m first, then whole metres).
    const fx = [[322.46, '323 m'], [999.46, '1 km'], [999.6, '1 km'], [9949, '9.9 km'], [9951, '10 km'], [12345, '12 km'], [1234567, '1,235 km']];
    t(fx.every(([m, want]) => [MT.i18n.formatDistance(m), MT.legend.distance(m), MT.radius.formatMeters(m), A.formatMeters(m)].every((x) => x === want)),
      'formatDistance = legend.distance = radius.formatMeters = analysis.formatMeters (323 m, 1 km, 9.9 km, 10 km, 12 km, 1,235 km)');
    t(MT.i18n.formatDistanceExact(1250) === '1.25 km' && MT.legend.ringLabel(2750) === '2.75 km' && MT.i18n.formatDistanceExact(1255) === '1,255 m' &&
      MT.i18n.formatDistanceExact(20000) === '20 km' && A.ringFeatures(o, [1250]).features[0].properties.label === '1.25 km', 'a typed ring keeps its value ("1.25 km", never "1.3 km")');

    /* ---- 2. rings ---------------------------------------------------------------------------------- */
    const R5 = [500, 1000, 2000, 3000, 5000];
    const rowsAt = (list) => list.map(([m, chain, same], i) => ({ store: fake('r' + i, chain), meters: m, sameChain: same }));
    const rr = rowsAt([[0, 'a', true], [499.999, 'b', false], [500, 'a', true], [500.001, 'b', false], [1000, 'b', false], [1999, 'c', false],
      [2000, 'a', true], [2000.5, 'c', false], [5000, 'c', false], [5000.0001, 'a', true], [12000, 'b', false]]);
    const sm = A.ringSummary(rr, R5);
    t(sm.bands.map((b) => b.total).join() === '3,2,2,1,1' && sm.beyond.total === 2 && sm.total === 11, 'ring bands: inclusive upper bound (d ≤ ring), rest "beyond"', sm.bands.map((b) => [b.from, b.to, b.total]));
    t(sm.bands[0].from === 0 && sm.bands[1].from === 500 && sm.bands[1].to === 1000 && sm.beyond.from === 5000 && sm.beyond.to === null, 'band limits');
    t(sm.cumulative.map((c) => c.total).join() === '3,5,7,8,9' && sm.cumulative[2].to === 2000, 'cumulative counts (d ≤ ring)');
    t(sm.bands[0].sameChain === 2 && sm.bands[0].competitors === 1 && sm.cumulative[4].sameChain === 3 && sm.cumulative[4].competitors === 6 && sm.relation === true, 'same chain / competitors per band');
    t(JSON.stringify(sm.bands[2].byChain) === '{"a":1,"c":1}' && JSON.stringify(sm.cumulative[4].byChain) === '{"a":3,"b":3,"c":3}', 'per-chain counts per band and cumulative');
    t(A.ringSummary(rr, [2000, 500, 500, -3, 'x']).rings.join() === '500,2000' && A.ringSummary(rr).rings.join() === R5.join(), 'rings sorted, unique, positive; default 500 m / 1 / 2 / 3 / 5 km');
    const ptRes = A.distancesFrom(A.refFromPoint({ lat: -12.12, lng: -77.03 }), { maxMeters: 1500 });
    const ptSum = A.ringSummary(ptRes, [500, 1000, 1500]);
    t(ptRes.rows.every((r) => r.sameChain === null) && ptSum.relation === false && ptSum.cumulative[2].total === ptRes.rows.length && ptSum.cumulative[2].competitors === 0,
      'a point without chain: sameChain null, no same/competitor split', ptSum.cumulative[2].total);

    /* ---- 3. exclusions, filters ------------------------------------------------------------------- */
    const pv = pick('plazavea', '150122');
    const refPv = A.refFromStore(pv.id);
    t(refPv && refPv.type === 'store' && refPv.storeId === pv.id && refPv.chainId === 'plazavea' && refPv.lat === pv.lat && refPv.label === pv.name, 'refFromStore', refPv);
    t(A.refFromStore('nope') === null && A.refFromPoint({ lat: 'x', lng: 1 }) === null && A.refFromPoint({ lat: 95, lng: 1 }) === null, 'invalid references → null');
    const dPv = A.distancesFrom(pv.id);   // all Peru, every chain
    const closed = withClosed.filter((s) => s.status === 'closed');
    t(dPv.rows.length === all.length - 1 && !dPv.rows.some((r) => r.store.id === pv.id), 'all Peru: every other store, the reference store excluded', dPv.rows.length);
    t(closed.length > 0 && !dPv.rows.some((r) => r.store.status === 'closed'), 'closed stores never included', closed.length);
    if (closed.length) {
      const c0 = closed[0];
      const atClosed = A.distancesFrom(A.refFromPoint({ lat: c0.lat, lng: c0.lng }), { maxMeters: 3000 });
      t(!atClosed.rows.some((r) => r.store.id === c0.id), 'not even at its own location');
      t(!A.neighborMatrix(withClosed).some((r) => r.store.status === 'closed' || (r.nearestSame && r.nearestSame.store.status === 'closed') || (r.nearestCompetitor && r.nearestCompetitor.store.status === 'closed')) &&
        !A.closePairs(withClosed, { meters: 500 }).some((p) => p.a.status === 'closed' || p.b.status === 'closed'), 'closed stores excluded from neighborMatrix / closePairs');
    }
    t(dPv.rows.every((r, i) => r.rank === i + 1 && (!i || dPv.rows[i - 1].meters < r.meters || (dPv.rows[i - 1].meters === r.meters && dPv.rows[i - 1].store.id < r.store.id))), 'rows sorted by distance, then id; rank 1…n');
    t(dPv.rows.every((r) => r.sameChain === (r.store.chain === 'plazavea')) && dPv.rows.every((r) => r.flags.toVerify === (r.store.status === 'to_verify') && r.flags.approx === (r.store.precision === 'approx')), 'sameChain and flags per row');
    t(dPv.rows.some((r) => r.flags.toVerify) && dPv.rows.some((r) => r.flags.approx), '"por verificar" included by default and flagged; approx flagged');
    t(!A.distancesFrom(pv.id, { includeToVerify: false }).rows.some((r) => r.store.status === 'to_verify'), 'includeToVerify:false drops "por verificar"');
    const d5 = A.distancesFrom(pv.id, { maxMeters: 5000 });
    const brute5 = all.filter((s) => s.id !== pv.id && G.distanceMeters(refPv, s) <= 5000).length;
    t(d5.rows.length === brute5 && d5.rows.every((r) => r.meters <= 5000) && d5.params.maxMeters === 5000, 'maxMeters: d ≤ max (= brute force count)', d5.rows.length);
    const ex = d5.rows.slice(0, 3).map((r) => r.store.id);
    t(!A.distancesFrom(pv.id, { maxMeters: 5000, exclude: ex }).rows.some((r) => ex.includes(r.store.id)) && A.distancesFrom(pv.id, { maxMeters: 5000, hiddenStores: ex }).rows.length === d5.rows.length - 3, 'hidden / excluded stores');
    const onlyTwo = A.distancesFrom(pv.id, { maxMeters: 5000, chains: ['plazavea', 'tottus'] }).rows;
    t(onlyTwo.length && onlyTwo.every((r) => r.store.chain === 'plazavea' || r.store.chain === 'tottus'), 'chains as an array = exactly those chains');
    const tog = A.distancesFrom(pv.id, { maxMeters: 5000, chains: { tambo: true, plazavea: false } }).rows;
    t(tog.some((r) => r.store.chain === 'tambo') && !tog.some((r) => r.store.chain === 'plazavea') && tog.every((r) => D.chainOn({ chains: { tambo: true, plazavea: false } }, r.store.chain)), 'chains as map toggles (missing → defaultOn)');
    const dist2 = ['150122', '150131'];
    const inD = A.distancesFrom(pv.id, { districts: dist2 }).rows;
    t(inD.length && inD.every((r) => dist2.includes(r.store.ubigeo)), 'districts restrict the universe');
    const twin = fake('zz-twin', 'tottus', pv.lat, pv.lng);
    const tw = A.distancesFrom(refPv, { stores: [pv, twin] }).rows;
    t(tw.length === 1 && tw[0].store.id === 'zz-twin' && tw[0].meters === 0 && tw[0].bearingDeg === null && tw[0].dir === null, 'another store at the same spot: 0 m, no direction; the reference itself excluded');
    const near = A.nearest(pv.id, { competitors: true, limit: 3, maxMeters: 10000 });
    const nearSame = A.nearest(pv.id, { sameChain: true });
    t(near.length === 3 && near.every((r) => r.sameChain === false) && near[0].rank === dPv.rows.find((r) => r.sameChain === false).rank, 'nearest competitors (rank kept)', near.map((r) => r.store.id));
    t(nearSame.length === 1 && nearSame[0].store.chain === 'plazavea' && nearSame[0].store.id === dPv.rows.find((r) => r.sameChain).store.id, 'nearest same-chain store');
    t(A.nearest(dPv, { chainId: 'wong', limit: 2 }).every((r) => r.store.chain === 'wong') && A.nearest(dPv, { limit: null }).length === dPv.rows.length, 'nearest() filters an existing result');
    const sum = A.summary(dPv);
    const nbc = A.nearestByChain(dPv);
    t(sum.nearestSame.store.id === nearSame[0].store.id && sum.nearestCompetitor.store.id === near[0].store.id && new Set(nbc.map((r) => r.store.chain)).size === nbc.length &&
      nbc.every((r, i) => !i || nbc[i - 1].meters <= r.meters), 'summary + nearestByChain (one row per chain, nearest first)', nbc.length);
    const dc = A.defaultChains(A.refFromStore(pick('tambo').id));
    t(dc.includes('tambo') && dc.includes('plazavea') && !dc.includes('oxxo'), 'defaultChains = defaultOn chains + the reference store\'s chain', dc);

    /* ---- storesForRegion ---------------------------------------------------------------------- */
    const reg = A.storesForRegion({ districts: ['150122', '150130', '150131', '150141'], chains: { tambo: false } });
    const cfgD = MT.project.defaultMap({ districts: ['150122', '150130', '150131', '150141'] });
    t(reg.map((s) => s.id).join() === D.storesForMap(cfgD).map((s) => s.id).join(), 'storesForRegion(map districts + toggles) = storesForMap of an "only inside" map', reg.length);
    t(A.storesForRegion().length === all.length && A.storesForRegion({ chains: [] }).length === 0, 'storesForRegion(): all of Peru, every chain; chains [] → none');

    /* ---- 4. determinism --------------------------------------------------------------------------- */
    t(sig(A.distancesFrom(pv.id, { maxMeters: 20000 }).rows) === sig(A.distancesFrom(pv.id, { maxMeters: 20000 }).rows), 'distancesFrom repeatable');
    let seed = 7;
    const shuffled = all.map((s) => [s, (seed = (seed * 16807) % 2147483647)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    const lima = A.storesForRegion({ districts: ['150122', '150130', '150131', '150141', '150140', '150115'] });
    const limaShuf = lima.slice().reverse();
    const nmSig = (rows) => rows.map((r) => [r.store.id, r.nearestSame && r.nearestSame.store.id, r.nearestSame && r.nearestSame.meters, r.nearestCompetitor && r.nearestCompetitor.store.id, r.nearestCompetitor && r.nearestCompetitor.meters, r.sameWithin, r.competitorsWithin, JSON.stringify(r.byChainWithin)].join(':')).join('|');
    const cpSig = (pairs) => pairs.map((p) => `${p.a.id}-${p.b.id}:${p.meters}:${p.sameChain}`).join('|');
    t(nmSig(A.neighborMatrix(lima)) === nmSig(A.neighborMatrix(limaShuf)) && nmSig(A.neighborMatrix(all)) === nmSig(A.neighborMatrix(shuffled)), 'neighborMatrix independent of input order');
    t(cpSig(A.closePairs(all, { meters: 800 })) === cpSig(A.closePairs(shuffled, { meters: 800 })), 'closePairs independent of input order');

    /* ---- 5. grid index == brute force on all of Peru ------------------------------------------------ */
    function bruteMatrix(list, radius, cands) {
      cands = cands || list;
      // One row per store in id order (the documented order of neighborMatrix).
      return list.slice().sort((x, y) => (x.id < y.id ? -1 : 1)).map((s) => {
        let ns = null, nc = null, sw = 0, cw = 0; const by = {}, q = { lat: s.lat, lng: s.lng };
        for (const o of cands) {
          if (o.id === s.id) continue;
          const d = G.distanceMeters(q, o);
          const better = (b) => !b || d < b.meters || (d === b.meters && o.id < b.store.id);
          if (o.chain === s.chain) { if (better(ns)) ns = { store: o, meters: d }; } else if (better(nc)) nc = { store: o, meters: d };
          if (d <= radius) { by[o.chain] = (by[o.chain] || 0) + 1; if (o.chain === s.chain) sw++; else cw++; }
        }
        const keys = {}; Object.keys(by).sort().forEach((k) => { keys[k] = by[k]; });
        return { store: s, nearestSame: ns, nearestCompetitor: nc, sameWithin: sw, competitorsWithin: cw, byChainWithin: keys };
      });
    }
    function brutePairs(list, m, sameOnly) {
      const outp = [];
      for (const a of list) {
        const q = { lat: a.lat, lng: a.lng };
        for (const b of list) {
          if (!(a.id < b.id) || (sameOnly && a.chain !== b.chain)) continue;
          const d = G.distanceMeters(q, b);
          if (d <= m) outp.push({ a, b, meters: d, sameChain: a.chain === b.chain });
        }
      }
      return outp.sort((x, y) => (y.sameChain - x.sameChain) || (x.meters - y.meters) || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0) || (x.b.id < y.b.id ? -1 : 1));
    }
    const nmGrid = A.neighborMatrix(all, { radius: 1000 });
    const nmBrute = bruteMatrix(all, 1000);
    const far = nmGrid.filter((r) => r.nearestSame && r.nearestSame.meters > 50000).length;
    const none = nmGrid.filter((r) => !r.nearestSame).length;
    t(nmGrid.length === all.length && nmSig(nmGrid) === nmSig(nmBrute), 'neighborMatrix (1 km, all Peru, every chain) = brute force', { stores: nmGrid.length, nearestSameOver50km: far, withoutSameChain: none });
    const nm250 = A.neighborMatrix(lima, { radius: 250 });
    t(nmSig(nm250) === nmSig(bruteMatrix(lima, 250)), 'neighborMatrix (250 m, Lima subset) = brute force');
    t(nmSig(A.neighborMatrix(lima, { radius: 1500, candidates: all })) === nmSig(bruteMatrix(lima, 1500, all)), 'neighborMatrix with a wider candidate universe = brute force');
    const cpGrid = A.closePairs(all, { meters: 1000 });
    t(cpSig(cpGrid) === cpSig(brutePairs(all, 1000, false)), 'closePairs (1 km, all Peru) = brute force', cpGrid.length);
    const cpSame = A.closePairs(all, { meters: 2000, sameChainOnly: true });
    t(cpSig(cpSame) === cpSig(brutePairs(all, 2000, true)) && cpSame.every((p) => p.sameChain), 'closePairs (2 km, same chain only) = brute force', cpSame.length);
    t(cpGrid.findIndex((p) => !p.sameChain) === cpGrid.filter((p) => p.sameChain).length, 'same-chain pairs first ("posible canibalización")');
    const idx = A.index(all);
    const probe = [[-12.0464, -77.0428, 3000], [-8.1116, -79.0288, 800], [-16.409, -71.5375, 10000], [-9.0745, -78.5936, 100]];
    t(probe.every(([la, ln, m]) => idx.within(la, ln, m).map((h) => h.store.id).sort().join() === all.filter((s) => G.distanceMeters({ lat: la, lng: ln }, s) <= m).map((s) => s.id).sort().join()), 'index.within = brute force at Lima / Trujillo / Arequipa / Chimbote', { cells: idx.cells });
    const nearestB = (la, ln, test) => { let b = null; all.forEach((s) => { if (!test(s)) return; const d = G.distanceMeters({ lat: la, lng: ln }, s); if (!b || d < b.meters || (d === b.meters && s.id < b.store.id)) b = { store: s, meters: d }; }); return b; };
    const qn = [[-12.0464, -77.0428, (s) => s.chain === 'vivanda'], [-3.75, -73.25, (s) => s.chain === 'makro'], [-14.07, -75.73, () => true], [-12.1, -77.0, (s) => s.chain === 'nope']];
    t(qn.every(([la, ln, f]) => { const a = idx.nearest(la, ln, f), b = nearestB(la, ln, f); return (!a && !b) || (a && b && a.store.id === b.store.id && a.meters === b.meters); }), 'index.nearest = brute force (near, far, none)');

    /* ---- 6. performance ---------------------------------------------------------------------------- */
    const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
    const cold = time(() => A.neighborMatrix(all, { radius: 1000 }));
    const runs = [0, 1, 2].map(() => time(() => A.neighborMatrix(all, { radius: 1000 }))).sort((a, b) => a - b);
    const cpT = [0, 1, 2].map(() => time(() => A.closePairs(all, { meters: 1000 }))).sort((a, b) => a - b);
    const dT = time(() => { for (let i = 0; i < 10; i++) A.distancesFrom(pv.id); }) / 10;
    t(runs[1] < 300, `neighborMatrix over all Peru (${all.length} stores) < 300 ms`, { medianMs: Math.round(runs[1]), coldMs: Math.round(cold) });
    t(cpT[1] < 300, 'closePairs (1 km) over all Peru < 300 ms', { medianMs: Math.round(cpT[1]) });
    t(dT < 50, 'distancesFrom over all Peru < 50 ms', { ms: +dT.toFixed(1) });

    /* ---- 7. project: the analysis key ---------------------------------------------------------------- */
    const P = MT.project;
    const def = P.normalizeAnalysis({ ref: { type: 'store', storeId: pv.id } });
    t(def && def.kind === 'distance' && def.rings.join() === '500,1000,2000' && def.maxMeters === 2000 && def.listTop === 8 && def.showLines === true && def.includeToVerify === true && def.chains === null &&
      JSON.stringify(def.ref) === JSON.stringify({ type: 'store', storeId: pv.id }), 'defaults: rings 500/1000/2000, maxMeters = largest ring, listTop 8, showLines', def);
    const messy = P.normalizeAnalysis({ kind: 'distance', ref: { lat: '-12.1219', lng: -77.0297, label: '  Local propuesto Av. Primavera ', chainId: 'wong', extra: 1 },
      rings: [3000, 'x', 500, 500, -1, 1500.4, 5], maxMeters: 'todo', chains: ['wong', 'wong', '', 'tottus'], listTop: 99, showLines: 'no', custom: { keep: true } });
    t(messy.ref.type === 'point' && messy.ref.lat === -12.1219 && messy.ref.label === 'Local propuesto Av. Primavera' && messy.ref.chainId === 'wong' && !('extra' in messy.ref) &&
      messy.rings.join() === '500,1500,3000' && messy.maxMeters === 3000 && messy.chains.join() === 'wong,tottus' && messy.listTop === 30 && messy.showLines === true && messy.custom.keep === true,
      'validation: point from text, rings cleaned, chains unique, listTop clamped, unknown keys kept', messy);
    t(JSON.stringify(P.normalizeAnalysis(messy)) === JSON.stringify(messy) && JSON.stringify(P.normalizeAnalysis(JSON.parse(JSON.stringify(def)))) === JSON.stringify(def), 'normalizeAnalysis is idempotent');
    t([null, 5, [], { ref: null }, { ref: { type: 'point' } }, { ref: { type: 'store' } }, { kind: 'heatmap', ref: { storeId: 'x' } }, { ref: { lat: 200, lng: 0 } }].every((x) => P.normalizeAnalysis(x) === null), 'unusable analyses → null');
    const proj = P.normalize({ type: 'mapa-tiendas-project', version: 1, maps: [
      { id: 'a1', title: 'Con análisis', analysis: { ref: { type: 'store', storeId: pv.id, lat: pv.lat, lng: pv.lng, label: pv.name }, rings: [1000, 500], maxMeters: 1500, showLines: false, listTop: 5 } },
      { id: 'a2', title: 'Sin análisis', districts: ['150122'] },
      { id: 'a3', analysis: null }, { id: 'a4', analysis: { ref: {} } }] });
    const back = P.normalize(JSON.parse(JSON.stringify(proj)));
    t(proj.maps[0].analysis.rings.join() === '500,1000' && proj.maps[0].analysis.maxMeters === 1500 && proj.maps[0].analysis.showLines === false && proj.maps[0].analysis.listTop === 5 &&
      !('analysis' in proj.maps[1]) && !('analysis' in proj.maps[2]) && !('analysis' in proj.maps[3]), 'project normalize keeps / validates / drops the analysis key');
    t(JSON.stringify(back.maps.map((m) => m.analysis)) === JSON.stringify(proj.maps.map((m) => m.analysis)), 'project JSON round trip keeps the analysis');
    const mapsBefore = P.maps().map((m) => m.id).join();
    const added = P.addMap({ title: 'Distancias', analysis: { ref: A.refFromPoint({ lat: -12.1, lng: -77.02, label: 'Punto X' }), rings: [2000, 1000] } }, { select: false });
    t(added.analysis.rings.join() === '1000,2000' && added.analysis.ref.type === 'point' && added.analysis.ref.label === 'Punto X', 'addMap stores the analysis normalized');
    let evts = 0; const off = MT.bus.on('map:changed', () => evts++);
    P.updateMap(added.id, { analysis: Object.assign({}, added.analysis, { listTop: '3' }) });
    const afterUpd = P.getMap(added.id).analysis.listTop;
    P.updateMap(added.id, { analysis: P.getMap(added.id).analysis });
    P.updateMap(added.id, { analysis: null });
    const cleared = P.getMap(added.id).analysis;
    P.updateMap(added.id, { analysis: null });
    off();
    t(afterUpd === 3 && cleared === null && evts === 2, 'updateMap normalizes the analysis; no event when unchanged', { afterUpd, cleared, evts });
    const viaFile = P.normalize(JSON.parse(P.toJSON()));
    t(viaFile.maps.find((m) => m.id === added.id) && !('analysis' in viaFile.maps.find((m) => m.id === added.id)), 'a removed analysis is not written back');
    P.removeMap(added.id);
    t(P.maps().map((m) => m.id).join() === mapsBefore, 'project back to its slides');

    /* ---- 8. analysis slides: storesForMap / boundsForMap / subtitleFor / forMap ----------------------- */
    const aCfg = P.defaultMap({ title: 'Plaza Vea', analysis: { ref: { type: 'store', storeId: pv.id }, rings: [500, 1000, 2000] } });
    const sfm = D.storesForMap(aCfg);
    const exp = all.filter((s) => D.chainOn(aCfg, s.chain) && G.distanceMeters(refPv, s) <= 2000).map((s) => s.id).sort();
    t(sfm.length > 5 && sfm.map((s) => s.id).join() === exp.join() && sfm.some((s) => s.id === pv.id), 'storesForMap: stores within maxMeters (2 km) of the reference, chain toggles apply, reference store included', sfm.length);
    t(!sfm.some((s) => s.chain === 'tambo' || s.chain === 'oxxo'), 'Tambo / Oxxo off by default on an analysis slide too');
    const big = D.storesForMap(P.defaultMap({ analysis: { ref: { type: 'store', storeId: pv.id }, rings: [500, 1000, 2000], maxMeters: 5000 } }));
    t(big.length > sfm.length && big.every((s) => G.distanceMeters(refPv, s) <= 5000), 'maxMeters 5 km → more stores', big.length);
    const hid = sfm.find((s) => s.id !== pv.id);
    t(!D.storesForMap(Object.assign({}, aCfg, { hiddenStores: [hid.id] })).some((s) => s.id === hid.id), 'hiddenStores apply');
    t(!D.storesForMap(Object.assign({}, aCfg, { chains: Object.assign({}, aCfg.chains, { plazavea: false }) })).some((s) => s.chain === 'plazavea'), 'chain toggles apply');
    const noTv = D.storesForMap(P.defaultMap({ analysis: { ref: { type: 'store', storeId: pv.id }, maxMeters: 20000, includeToVerify: false } }));
    t(!noTv.some((s) => s.status === 'to_verify'), 'analysis.includeToVerify false → no "por verificar" store');
    // …also on a slide with districts (the Análisis tab's "Distritos" universe).
    const dTv = P.defaultMap({ districts: ['150122', '150141'], analysis: { ref: { type: 'store', storeId: pv.id }, includeToVerify: false } });
    const dTvStores = D.storesForMap(dTv);
    t(dTvStores.length > 5 && !dTvStores.some((s) => s.status === 'to_verify') &&
      dTvStores.map((s) => s.id).join() === A.storesForRegion({ districts: ['150122', '150141'], chains: dTv.chains, includeToVerify: false }).map((s) => s.id).join(),
      'district slide + includeToVerify false → no "por verificar" store (= storesForRegion)', dTvStores.length);
    const bnd = D.boundsForMap(aCfg), rb = A.ringBbox(refPv, 2000);
    t(bnd && bnd[0] < rb[0] && bnd[1] < rb[1] && bnd[2] > rb[2] && bnd[3] > rb[3] && (bnd[2] - bnd[0]) < (rb[2] - rb[0]) * 1.1, 'boundsForMap fits the largest ring (+ padding)', { bnd, rb });
    const bnd5 = D.boundsForMap(Object.assign({}, aCfg, { analysis: Object.assign({}, aCfg.analysis, { maxMeters: 5000 }) }));
    t(JSON.stringify(bnd5) === JSON.stringify(bnd), 'the view fits the rings, not maxMeters');
    const view = MT.layout.viewFor(aCfg), vb = G.viewBounds(view);
    t(vb && vb[0] <= rb[0] && vb[1] <= rb[1] && vb[2] >= rb[2] && vb[3] >= rb[3], 'the slide\'s automatic view contains the whole largest ring', { view });
    t(D.subtitleFor(aCfg) === 'Distancias a ' + pv.name, 'subtitle "Distancias a <store>"', D.subtitleFor(aCfg));
    const ptCfg = P.defaultMap({ analysis: { ref: { type: 'point', lat: -12.1219, lng: -77.0297, label: 'Local propuesto Av. Primavera' } } });
    const ptCfg2 = P.defaultMap({ analysis: { ref: { type: 'point', lat: -12.1219, lng: -77.0297 } } });
    t(D.subtitleFor(ptCfg) === 'Distancias a Local propuesto Av. Primavera' && D.subtitleFor(ptCfg2) === 'Distancias al punto -12.12190, -77.02970' &&
      D.subtitleFor(Object.assign({}, ptCfg, { subtitleAuto: false, subtitle: 'Mi subtítulo' })) === 'Mi subtítulo', 'subtitle for points (label / coordinates) and the manual override');
    const withD = Object.assign({}, aCfg, { districts: ['150122'] });
    t(D.subtitleFor(withD) === '(Miraflores)' && D.storesForMap(withD).every((s) => s.ubigeo === '150122') && JSON.stringify(D.boundsForMap(withD)) !== JSON.stringify(bnd), 'analysis + districts → a normal district slide');
    const gone = P.defaultMap({ analysis: { ref: { type: 'store', storeId: 'osm-n0-deleted', lat: pv.lat, lng: pv.lng, label: 'Tienda cerrada X' } } });
    t(A.resolveRef(gone.analysis.ref).missing === true && D.storesForMap(gone).length > 0 && D.subtitleFor(gone) === 'Distancias a Tienda cerrada X', 'a reference store gone from the database: last known position');
    t(D.storesForMap(P.defaultMap({ analysis: { ref: { type: 'store', storeId: 'osm-n0-deleted' } } })).length === 0 && D.boundsForMap(P.defaultMap({ analysis: { ref: { type: 'store', storeId: 'osm-n0-deleted' } } })) === null, '… and without one: no stores, no bounds');
    const fm = A.forMap(aCfg);
    t(fm && fm.ref.storeId === pv.id && fm.rows.length === sfm.length - 1 && fm.top.length === Math.min(8, fm.rows.length) && fm.summary.rings.join() === '500,1000,2000' &&
      fm.summary.cumulative[2].total === fm.rows.length && fm.lines.length === new Set(fm.rows.map((r) => r.store.chain)).size && fm.label === pv.name, 'forMap: rows, top N, ring counts, one line per chain', { rows: fm.rows.length, lines: fm.lines.length });
    t(A.forMap(Object.assign({}, aCfg, { analysis: Object.assign({}, aCfg.analysis, { showLines: false }) })).lines.length === 0 && A.forMap(MT.project.defaultMap()) === null, 'forMap: showLines false → no lines; ordinary slide → null');

    /* ---- 9. the Análisis tab --------------------------------------------------------------------------- */
    const tabs = MT.app.tabs().map((x) => `${x.id}#${x.hash}`).join(' ');
    MT.app.showTab('analysis');
    await new Promise((r) => setTimeout(r, 200));
    const panel = document.querySelector('#panel-analysis');
    t(tabs === 'maps#mapas analysis#analisis db#base chains#cadenas' && location.hash === '#analisis' && panel && !panel.hidden && panel.textContent.includes('Análisis de distancias'), 'Análisis tab between Mapas and Base de datos (#analisis)', tabs);
    MT.app.showTab('maps');
    return { out, pairs: pairs.map((p) => [p.lat1, p.lng1, p.lat2, p.lng2, p.m, p.b]),
      real: nmGrid.filter((r) => r.nearestCompetitor && r.nearestCompetitor.meters <= 20000 && r.nearestCompetitor.meters > 20).slice(0, 3000)
        .map((r) => [r.store.lat, r.store.lng, r.nearestCompetitor.store.lat, r.nearestCompetitor.store.lng, r.nearestCompetitor.meters]) };
  });

  for (const r of res.out) check(r.ok, r.msg);

  /* ---- distances vs Vincenty (Node side) ---------------------------------------------------------------- */
  const errOf = ([a, b, c, d, m]) => Math.abs(m - vincenty(a, b, c, d)) / vincenty(a, b, c, d);
  const errs = res.pairs.map((p) => ({ e: errOf(p), b: p[5] }));
  const max = Math.max(...errs.map((x) => x.e));
  const ew = Math.max(...errs.filter((x) => x.b % 180 === 90).map((x) => x.e));
  const diag = Math.max(...errs.filter((x) => { const k = x.b % 180; return k >= 45 && k <= 135; }).map((x) => x.e));
  const mean = errs.reduce((s, x) => s + x.e, 0) / errs.length;
  check(max < 0.006, `haversine vs Vincenty ≤ 20 km at 6 Peruvian latitudes, 24 directions: max error ${(max * 100).toFixed(3)} % < 0.6 % (analytic bound, north–south)`);
  check(diag < 0.005 && ew < 0.002, `… < 0.5 % from 45° to 135° off north (${(diag * 100).toFixed(3)} %), east–west ${(ew * 100).toFixed(3)} %`);
  check(mean < 0.004, `… mean error ${(mean * 100).toFixed(3)} % over ${errs.length} pairs`);
  const realErr = res.real.map(errOf);
  check(realErr.length > 1000 && Math.max(...realErr) < 0.006, `real nearest-competitor pairs (≤ 20 km, ${realErr.length}): max error ${(Math.max(...realErr) * 100).toFixed(3)} %, mean ${(realErr.reduce((s, e) => s + e, 0) / realErr.length * 100).toFixed(3)} %`);

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} finally {
  await browser.close();
}
finish();
