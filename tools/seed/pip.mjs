// pip.mjs — point-in-polygon lookup of Peru districts (Node, ESM, built-ins only).
//
//   import { loadDistricts, locate, locateNearest } from './pip.mjs';
//   loadDistricts();                          // optional; locate() loads lazily
//   locate(-12.1318, -77.0305)                // → { ubigeo:'150122', district:'Miraflores', province:'Lima', department:'Lima' }
//   locate(-12.5, -78.5)                      // → null (in the sea)
//   locateNearest(lat, lng, 300)              // → same object + distanceM; for points just off the
//                                             //   coastline / on a river (null if farther than maxMeters)
//
// Data: tools/seed/districts.geojson (built by tools/build-districts.mjs).
// Algorithm: uniform grid index of polygon bboxes (0.1°) → bbox prefilter → even-odd ray
// casting over all rings of a polygon (outer ring + holes), MultiPolygons supported.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('./districts.geojson', import.meta.url));
const CELL = 0.1; // degrees

let DB = null;

/**
 * Loads the district polygons and builds the spatial index. Safe to call more than once
 * (later calls are no-ops unless `force` is true or another path is given).
 * @returns {{count:number, districts:Array<{ubigeo,district,province,department}>}}
 */
export function loadDistricts(file = DEFAULT_PATH, { force = false } = {}) {
  if (DB && !force && DB.file === file) return { count: DB.props.length, districts: DB.props };
  DB = buildIndex(JSON.parse(readFileSync(file, 'utf8')));
  DB.file = file;
  return { count: DB.props.length, districts: DB.props };
}

/**
 * Builds an independent index from a GeoJSON FeatureCollection (features with
 * {ubigeo, district, province, department} properties). Returns
 * { props, locate(lat,lng), locateNearest(lat,lng,maxMeters) } — handy for comparing datasets.
 */
export function createIndex(fc) {
  const db = buildIndex(fc);
  return { props: db.props, locate: (lat, lng) => locateIn(db, lat, lng), locateNearest: (lat, lng, m) => nearestIn(db, lat, lng, m) };
}

function buildIndex(fc) {
  const props = [];
  const polys = []; // { f: featureIndex, rings: Float64Array[], bbox: [w,s,e,n] }
  fc.features.forEach((feat) => {
    const p = feat.properties;
    const fi = props.length;
    props.push(Object.freeze({ ubigeo: p.ubigeo, district: p.district, province: p.province, department: p.department }));
    const g = feat.geometry;
    if (!g) return;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of list) {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      const rings = poly.map((ring) => {
        const a = new Float64Array(ring.length * 2);
        ring.forEach(([x, y], i) => {
          a[2 * i] = x; a[2 * i + 1] = y;
          if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
        });
        return a;
      });
      polys.push({ f: fi, rings, bbox: [w, s, e, n] });
    }
  });
  const grid = new Map();
  polys.forEach((pg, idx) => {
    const [w, s, e, n] = pg.bbox;
    for (let cx = Math.floor(w / CELL); cx <= Math.floor(e / CELL); cx++) {
      for (let cy = Math.floor(s / CELL); cy <= Math.floor(n / CELL); cy++) {
        const k = cx + ',' + cy;
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(idx);
      }
    }
  });
  return { props, polys, grid };
}

function ensure() { if (!DB) loadDistricts(); }

// even-odd test over all rings (outer + holes) of one polygon
function inPolygon(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * District containing the point, or null (sea, outside Peru, or in a tiny boundary gap).
 * If census polygons overlap at the point, the lowest ubigeo wins (deterministic).
 */
export function locate(lat, lng) {
  ensure();
  return locateIn(DB, lat, lng);
}

function locateIn(db, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = -1;
  for (const idx of db.grid.get(Math.floor(lng / CELL) + ',' + Math.floor(lat / CELL)) || []) {
    const pg = db.polys[idx];
    const b = pg.bbox;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
    if (inPolygon(pg.rings, lng, lat) && (best < 0 || pg.f < best)) best = pg.f;
  }
  return best < 0 ? null : { ...db.props[best] };
}

/**
 * Like locate(), but if the point is outside every district, returns the district whose
 * boundary is nearest within maxMeters (useful for stores mapped right on the coastline).
 * Result has an extra `distanceM` (0 when the point is inside).
 */
export function locateNearest(lat, lng, maxMeters = 300) {
  ensure();
  return nearestIn(DB, lat, lng, maxMeters);
}

function nearestIn(db, lat, lng, maxMeters = 300) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const hit = locateIn(db, lat, lng);
  if (hit) return { ...hit, distanceM: 0 };
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  const dLng = maxMeters / kx, dLat = maxMeters / ky;
  const seen = new Set();
  let bestF = -1, bestD = Infinity;
  for (let cx = Math.floor((lng - dLng) / CELL); cx <= Math.floor((lng + dLng) / CELL); cx++) {
    for (let cy = Math.floor((lat - dLat) / CELL); cy <= Math.floor((lat + dLat) / CELL); cy++) {
      for (const idx of db.grid.get(cx + ',' + cy) || []) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const pg = db.polys[idx], b = pg.bbox;
        if (lng < b[0] - dLng || lng > b[2] + dLng || lat < b[1] - dLat || lat > b[3] + dLat) continue;
        for (const r of pg.rings) {
          const n = r.length / 2;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            // distance point→segment in a local metric projection
            const ax = (r[2 * j] - lng) * kx, ay = (r[2 * j + 1] - lat) * ky;
            const bx = (r[2 * i] - lng) * kx, by = (r[2 * i + 1] - lat) * ky;
            const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
            let t = len2 ? -(ax * vx + ay * vy) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + t * vx, py = ay + t * vy;
            const d = Math.sqrt(px * px + py * py);
            if (d < bestD || (d === bestD && pg.f < bestF)) { bestD = d; bestF = pg.f; }
          }
        }
      }
    }
  }
  if (bestF < 0 || bestD > maxMeters) return null;
  return { ...db.props[bestF], distanceM: Math.round(bestD * 10) / 10 };
}

/** All districts (frozen property objects), in ubigeo order. */
export function listDistricts() { ensure(); return DB.props; }

/**
 * Distance in metres from the point to the nearest district whose properties satisfy `pred`
 * (0 when the point is inside one of them); null when no district satisfies `pred`.
 * Brute force over the selected districts' rings — meant for a few hundred checks, not bulk use.
 */
export function districtDistance(lat, lng, pred) {
  ensure();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  let best = null;
  for (const pg of DB.polys) {
    if (!pred(DB.props[pg.f])) continue;
    if (inPolygon(pg.rings, lng, lat)) return 0;
    for (const r of pg.rings) {
      const n = r.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = (r[2 * j] - lng) * kx, ay = (r[2 * j + 1] - lat) * ky;
        const bx = (r[2 * i] - lng) * kx, by = (r[2 * i + 1] - lat) * ky;
        const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
        let t = len2 ? -(ax * vx + ay * vy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * vx, ay + t * vy);
        if (best === null || d < best) best = d;
      }
    }
  }
  return best === null ? null : Math.round(best);
}
