// tools/build-road-names.mjs — main avenue names for slides that show a city zoomed out.
//
// OpenMapTiles (OpenFreeMap) vector tiles carry the names of most main avenues only from zoom 14:
// a slide of several Lima districts (basemap zoom 10.5–13) shows Av. Javier Prado, Arequipa,
// Angamos, Benavides… as nameless lines. This script reads the names and geometry of the motorway /
// trunk / primary roads of Peru's main cities from the z14 tiles (through MapLibre itself, in the
// system Chrome), joins the tile pieces into long lines, simplifies them and writes
//
//   data/road-names.js   window.MT_ROAD_NAMES = { generated, source, minzoom, maxzoom, regions:[{name, bbox}],
//                                                 features: GeoJSON MultiLineString features {name, class} }
//
// which MT.mapview writes as an app line-label layer ('mt-road-names') below zoom 14 inside those
// regions (docs/ARCHITECTURE.md §13). Network: OpenFreeMap tiles (≈ 1,400 tiles). Re-run when OSM
// changes a lot:  node tools/build-road-names.mjs [--only=lima]
import { openApp, ROOT } from './test/lib.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Cities (bbox [west, south, east, north]) whose slides are usually zoomed out below 14.
const REGIONS = [
  ['Lima y Callao', 'lima', [-77.22, -12.52, -76.72, -11.75]],
  ['Arequipa', 'arequipa', [-71.62, -16.47, -71.45, -16.33]],
  ['Trujillo', 'trujillo', [-79.10, -8.20, -78.95, -8.04]],
  ['Chiclayo', 'chiclayo', [-79.90, -6.82, -79.78, -6.72]],
  ['Piura', 'piura', [-80.72, -5.24, -80.58, -5.14]],
  ['Cusco', 'cusco', [-72.02, -13.56, -71.90, -13.49]],
  ['Chimbote', 'chimbote', [-78.62, -9.16, -78.50, -9.03]],
  ['Huancayo', 'huancayo', [-75.25, -12.10, -75.17, -12.02]],
  ['Iquitos', 'iquitos', [-73.30, -3.80, -73.22, -3.72]],
  ['Ica', 'ica', [-75.76, -14.10, -75.70, -14.03]],
];
const CLASSES = ['motorway', 'trunk', 'primary'];
const ZOOM = 14, VIEW_PX = 2048;
const GRID = 1e-4;          // raster cells (≈ 11 m): joins the pieces of one road across tile edges
const SIMPLIFY = 8e-5;      // Douglas–Peucker tolerance (≈ 9 m; a slide shows ≈ 15 m per pixel)
const MIN_LEN_M = 250;      // shorter pieces cannot carry a label at slide zooms

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const regions = REGIONS.filter((r) => !only.length || only.includes(r[1]));
// The raw tile pieces are kept in a download cache (git-ignored): --cached re-builds from it offline.
const CACHE_DIR = path.join(ROOT, 'tools', 'seed', '.cache-roads'), CACHE = path.join(CACHE_DIR, 'pieces.json');
const cached = process.argv.includes('--cached') && existsSync(CACHE);

const segs = new Map();     // name|class → Set of segment keys; segment list per key
const byKey = new Map();
let views = 0;
if (cached) {
  const raw = JSON.parse(readFileSync(CACHE, 'utf8'));
  Object.keys(raw).forEach((k) => byKey.set(k, raw[k]));
  console.log('pieces from ' + path.relative(ROOT, CACHE));
} else {
const { browser, page, errors } = await openApp({ lang: 'es', viewport: { width: 1200, height: 900 } });
await page.evaluate((px) => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:-9000px;top:0;width:' + px + 'px;height:' + px + 'px';
  document.body.appendChild(el);
  window.__rn = new maplibregl.Map({ container: el, style: MT.theme.basemap.style, center: [-77, -12], zoom: 14, interactive: false, fadeDuration: 0, pixelRatio: 1 });
  return new Promise((res) => window.__rn.once('load', res));
}, VIEW_PX);

for (const [label, , bbox] of regions) {
  // View centres: a grid over the bbox, one view = VIEW_PX at ZOOM (slight overlap).
  const span = await page.evaluate((z, px, bbox) => {
    const c = MT.geo.project([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], z), h = px * 0.92 / 2;
    const a = MT.geo.unproject([c[0] - h, c[1] - h], z), b = MT.geo.unproject([c[0] + h, c[1] + h], z);
    return [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
  }, ZOOM, VIEW_PX, bbox);
  const cols = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / span[0])), rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / span[1]));
  console.log(`${label}: ${cols}×${rows} views`);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const center = [bbox[0] + (c + 0.5) * (bbox[2] - bbox[0]) / cols, bbox[1] + (r + 0.5) * (bbox[3] - bbox[1]) / rows];
    const found = await page.evaluate(async (center, z, classes) => {
      const map = window.__rn;
      map.jumpTo({ center: center, zoom: z });
      await new Promise((res) => { const done = () => { if (map.areTilesLoaded()) res(); else map.once('idle', done); }; map.once('idle', done); map.triggerRepaint(); });
      const out = [];
      map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' }).forEach((f) => {
        const p = f.properties || {}, name = p['name:es'] || p.name;
        if (!name || classes.indexOf(p.class) < 0 || !f.geometry) return;
        const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
        lines.forEach((l) => out.push([String(name), p.class, l.map((q) => [Math.round(q[0] * 1e6) / 1e6, Math.round(q[1] * 1e6) / 1e6])]));
      });
      return out;
    }, center, ZOOM, CLASSES);
    views++;
    found.forEach(([name, cls, line]) => {
      if (line.length < 2) return;
      const k = name + '|' + cls, sk = JSON.stringify(line);
      if (!segs.has(k)) { segs.set(k, new Set()); byKey.set(k, []); }
      if (segs.get(k).has(sk)) return;
      segs.get(k).add(sk);
      byKey.get(k).push(line);
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');
}
await browser.close();
if (errors.length) console.log('page errors:', errors.slice(0, 5));
mkdirSync(CACHE_DIR, { recursive: true });
writeFileSync(CACHE, JSON.stringify(Object.fromEntries(byKey)));
}

/* ---- Join the tile pieces of each road into long lines --------------------------------------------- */
const snap = (q) => Math.round(q[0] / GRID) + ',' + Math.round(q[1] / GRID);
const meters = (a, b) => {
  const R = 6371008.8, r = Math.PI / 180, la = (a[1] + b[1]) / 2 * r;
  return Math.hypot((b[0] - a[0]) * r * Math.cos(la), (b[1] - a[1]) * r) * R;
};
/**
 * The tile pieces of one road as long lines. Tile clipping leaves pieces that overlap a little
 * (each tile's buffer) instead of sharing end points, so every line is rasterized onto a GRID of
 * cells (sampled every GRID/3): overlapping pieces then pass through the same cells and join. A
 * cell's point is the mean of the samples in it. Lines are walked from their ends, at a junction
 * along the straightest continuation (≤ 60° turn), so an avenue stays one line across junctions.
 */
function chainsOf(lines) {
  const sum = new Map(), adj = new Map();
  const edge = (a, b) => { if (a === b) return; (adj.get(a) || adj.set(a, new Set()).get(a)).add(b); (adj.get(b) || adj.set(b, new Set()).get(b)).add(a); };
  lines.forEach((l) => {
    let prev = null;
    for (let i = 0; i < l.length; i++) {
      const p = l[i], q = l[i + 1] || p;
      const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (GRID / 3)));
      for (let s = 0; s < (i + 1 < l.length ? n : 1); s++) {
        const x = p[0] + (q[0] - p[0]) * s / n, y = p[1] + (q[1] - p[1]) * s / n, k = snap([x, y]);
        const a = sum.get(k) || sum.set(k, [0, 0, 0]).get(k); a[0] += x; a[1] += y; a[2]++;
        if (prev !== null) edge(prev, k);
        prev = k;
      }
    }
  });
  const coord = (k) => { const a = sum.get(k); return [a[0] / a[2], a[1] / a[2]]; };
  const used = new Set(), ek = (a, b) => (a < b ? a + '|' + b : b + '|' + a), out = [];
  const turn = (a, b, c) => {
    const p = coord(a), q = coord(b), r = coord(c);
    const u = Math.atan2(q[1] - p[1], q[0] - p[0]), v = Math.atan2(r[1] - q[1], r[0] - q[0]);
    let d = Math.abs(v - u); if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  const walk = (start, next) => {
    const path = [start, next];
    used.add(ek(start, next));
    for (;;) {
      const cur = path[path.length - 1], back = path[Math.max(0, path.length - 4)];
      let best = null, bt = Math.PI / 3;
      [...(adj.get(cur) || [])].sort().forEach((n) => {
        if (used.has(ek(cur, n))) return;
        const t = turn(back === cur ? path[path.length - 2] : back, cur, n);
        if (t < bt - 1e-9) { bt = t; best = n; }
      });
      if (best === null) break;
      used.add(ek(cur, best)); path.push(best);
    }
    return path;
  };
  // Start at ends first (degree 1), then junctions, then what is left (loops). Sorted: deterministic.
  const nodes = [...adj.keys()].sort();
  for (const pass of [1, 3, 2]) {
    nodes.forEach((k) => {
      const d = adj.get(k).size;
      if (pass === 1 ? d !== 1 : pass === 3 ? d < 3 : false) return;
      [...adj.get(k)].sort().forEach((n) => { if (!used.has(ek(k, n))) out.push(walk(k, n).map(coord)); });
    });
  }
  return out;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bd = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    for (let i = a + 1; i < b; i++) {
      let t = l2 ? ((pts[i][0] - ax) * vx + (pts[i][1] - ay) * vy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(pts[i][0] - ax - t * vx, pts[i][1] - ay - t * vy);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((p, i) => keep[i]);
}
const features = [];
[...byKey.keys()].sort().forEach((k) => {
  const [name, cls] = k.split('|');
  const chains = chainsOf(byKey.get(k)).map((c) => simplify(c, SIMPLIFY))
    .filter((c) => c.length >= 2 && c.slice(1).reduce((s, q, i) => s + meters(c[i], q), 0) >= MIN_LEN_M)
    .map((c) => c.map((q) => [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]));
  if (chains.length) features.push({ type: 'Feature', properties: { name: name, class: cls }, geometry: { type: 'MultiLineString', coordinates: chains } });
});

const data = {
  generated: new Date().toISOString().slice(0, 10),
  source: '© OpenStreetMap contributors · OpenMapTiles (OpenFreeMap), zoom ' + ZOOM,
  minzoom: 0, maxzoom: ZOOM,
  regions: regions.map(([name, id, bbox]) => ({ id: id, name: name, bbox: bbox })),
  features: features,
};
const js = '// Generated by tools/build-road-names.mjs — do not edit. Names and simplified geometry of the main roads\n' +
  '// (motorway / trunk / primary) of Peru\'s main cities, from the OpenMapTiles z' + ZOOM + ' tiles (© OpenStreetMap\n' +
  '// contributors, ODbL). MT.mapview writes them where the basemap tiles at slide zooms have no names.\n' +
  'window.MT_ROAD_NAMES = ' + JSON.stringify(data) + ';\n';
const file = path.join(ROOT, 'data', 'road-names.js');
writeFileSync(file, js);
const pts = features.reduce((s, f) => s + f.geometry.coordinates.reduce((a, c) => a + c.length, 0), 0);
console.log(`${views} views, ${features.length} roads, ${pts} points → ${path.relative(ROOT, file)} (${(js.length / 1024).toFixed(0)} KB)`);
