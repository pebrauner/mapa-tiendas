#!/usr/bin/env node
// tools/fixtures/build-fixtures.mjs — builds the TEST fixtures (not the real seed data!).
//
//   node tools/fixtures/build-fixtures.mjs            # uses the download cache when present
//   node tools/fixtures/build-fixtures.mjs --refresh  # re-download
//
// Writes, next to this script:
//   districts.js  window.MT_DISTRICTS — TopoJSON, object "districts", 12 real district boundaries
//                 (OSM via Nominatim polygon_geojson), properties {ubigeo, district, province,
//                 department}, per-geometry bbox [w,s,e,n] — same shape as data/districts.js.
//   stores.js     window.MT_SEED — 63 stores at real retail locations (OSM shops found via Nominatim)
//                 across Miraflores, San Isidro, San Borja, Surquillo, Trujillo and Chimbote; all 16
//                 chain ids represented; ubigeo from point-in-polygon; addresses by reverse geocoding.
//   chains.js     is hand-written (see chains.js); logos.js is built by make-logos.py.
//
// The harness (tools/test/lib.mjs) injects these files only when the real data file is missing.
// Network etiquette: Nominatim ≤ 1 request/s with an identifying User-Agent.
// Everything is cached in tools/fixtures/.cache/ so re-runs are offline and deterministic.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const UA = 'mapa-tiendas-fixtures/1.0 (github.com/pebrauner/mapa-tiendas)';
const REFRESH = process.argv.includes('--refresh');

// Real INEI ubigeos (validated against OSM's pe:ubigeo tag at download time).
const DISTRICTS = [
  { ubigeo: '150122', district: 'Miraflores', province: 'Lima', department: 'Lima' },
  { ubigeo: '150131', district: 'San Isidro', province: 'Lima', department: 'Lima' },
  { ubigeo: '150130', district: 'San Borja', province: 'Lima', department: 'Lima' },
  { ubigeo: '150141', district: 'Surquillo', province: 'Lima', department: 'Lima' },
  { ubigeo: '150116', district: 'Lince', province: 'Lima', department: 'Lima' },
  { ubigeo: '150104', district: 'Barranco', province: 'Lima', department: 'Lima' },
  { ubigeo: '150108', district: 'Chorrillos', province: 'Lima', department: 'Lima' },
  { ubigeo: '130101', district: 'Trujillo', province: 'Trujillo', department: 'La Libertad' },
  { ubigeo: '130111', district: 'Víctor Larco Herrera', province: 'Trujillo', department: 'La Libertad' },
  { ubigeo: '130105', district: 'La Esperanza', province: 'Trujillo', department: 'La Libertad' },
  { ubigeo: '021801', district: 'Chimbote', province: 'Santa', department: 'Áncash' },
  { ubigeo: '021809', district: 'Nuevo Chimbote', province: 'Santa', department: 'Áncash' },
];

// Stores to generate: [chain, ubigeo]. Positions prefer a real OSM shop of that chain in the
// district, then any other real OSM shop there, then a seeded point near the district centre.
const PLAN = [
  // Miraflores (15)
  ...['plazavea', 'plazavea', 'wong', 'wong', 'metro', 'vivanda', 'vivanda', 'tottus', 'florayfauna', 'holi', 'dollarcity', 'mass', 'tambo', 'tambo', 'oxxo'].map((c) => [c, '150122']),
  // San Isidro (10)
  ...['plazavea', 'wong', 'vivanda', 'tottus', 'florayfauna', 'metro', 'tambo', 'oxxo', 'mass', 'tiendas3a'].map((c) => [c, '150131']),
  // San Borja (8)
  ...['plazavea', 'wong', 'metro', 'tottus', 'tiendas3a', 'dollarcity', 'florayfauna', 'tambo'].map((c) => [c, '150130']),
  // Surquillo (9)
  ...['plazavea', 'metro', 'wong', 'tiendas3a', 'mass', 'maxiahorro', 'preciouno', 'holi', 'tambo'].map((c) => [c, '150141']),
  // Trujillo (14)
  ...['plazavea', 'plazavea', 'tottus', 'tottus', 'metro', 'metro', 'wong', 'makro', 'preciouno', 'preciouno', 'maxiahorro', 'dollarcity', 'tambo', 'vega'].map((c) => [c, '130101']),
  // Chimbote (7)
  ...['plazavea', 'tottus', 'metro', 'makro', 'vega', 'mass', 'preciouno'].map((c) => [c, '021801']),
];

const CHAIN_NAMES = {
  plazavea: 'Plaza Vea', tottus: 'Tottus', wong: 'Wong', metro: 'Metro', vivanda: 'Vivanda',
  tiendas3a: 'Tiendas 3A', mass: 'Mass', preciouno: 'Precio Uno', maxiahorro: 'Maxiahorro',
  dollarcity: 'Dollarcity', makro: 'Makro', vega: 'Vega', florayfauna: 'Flora y Fauna', holi: 'Holi',
  tambo: 'Tambo', oxxo: 'Oxxo',
};
const CHAIN_RX = {
  plazavea: /plaza\s*vea/i, tottus: /tottus/i, wong: /\bwong\b/i, metro: /^metro\b|\bmetro\s+(super|hiper)/i,
  vivanda: /vivanda/i, tiendas3a: /\b3\s*a\b|tiendas\s*3a/i, mass: /^mass\b|tiendas\s+mass/i, preciouno: /precio\s*uno/i,
  maxiahorro: /maxi\s*ahorro/i, dollarcity: /dollar\s*city/i, makro: /makro/i, vega: /^(mayorista\s+)?vega\b|\bvega\s+(mayorista|market)/i,
  florayfauna: /flora\s*(y|&)\s*fauna/i, holi: /^holi\b/i, tambo: /tambo/i, oxxo: /oxxo/i,
};

// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;
async function nominatim(url) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es' } });
  if (!r.ok) throw new Error(`Nominatim ${r.status} for ${url}`);
  return r.json();
}
async function cached(name, fn) {
  const file = path.join(CACHE, name);
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const data = await fn();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

// Seeded PRNG (mulberry32) so fixtures are reproducible.
function prng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Point in polygon (GeoJSON Polygon / MultiPolygon, even-odd over all rings).
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(pt, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h)));
}
function bboxOf(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const rings of polys) for (const [x, y] of rings[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [w, s, e, n];
}

// Minimal TopoJSON encoder: one arc per ring (no arc sharing — fine for a fixture), quantized
// and delta-encoded exactly like topojson-server output, readable by topojson-client.
function toTopology(features, q = 1e6) {
  let [W, S, E, N] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) { const b = bboxOf(f.geometry); W = Math.min(W, b[0]); S = Math.min(S, b[1]); E = Math.max(E, b[2]); N = Math.max(N, b[3]); }
  const kx = (E - W) / (q - 1), ky = (N - S) / (q - 1);
  const arcs = [];
  const encodeRing = (ring) => {
    const pts = [];
    for (const [x, y] of ring) {
      const p = [Math.round((x - W) / kx), Math.round((y - S) / ky)];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (pts.length < 4) return null;
    const delta = pts.map((p, i) => (i ? [p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]] : p));
    arcs.push(delta);
    return [arcs.length - 1];
  };
  const geometries = features.map((f) => {
    const g = f.geometry;
    const poly = (rings) => rings.map(encodeRing).filter(Boolean);
    const out = g.type === 'Polygon'
      ? { type: 'Polygon', arcs: poly(g.coordinates) }
      : { type: 'MultiPolygon', arcs: g.coordinates.map(poly).filter((p) => p.length) };
    out.properties = f.properties;
    out.bbox = bboxOf(g).map((v) => +v.toFixed(6));
    return out;
  });
  return {
    type: 'Topology',
    bbox: [W, S, E, N].map((v) => +v.toFixed(6)),
    transform: { scale: [kx, ky], translate: [W, S] },
    objects: { districts: { type: 'GeometryCollection', geometries } },
    arcs,
  };
}

// ---------------------------------------------------------------------------------------------
async function fetchDistricts() {
  const features = [];
  for (const d of DISTRICTS) {
    const res = await cached(`nominatim-${d.ubigeo}.json`, () => nominatim(
      'https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.00004' +
      '&extratags=1&limit=6&countrycodes=pe&q=' + encodeURIComponent(`${d.district}, ${d.province}, ${d.department}, Perú`)));
    const hit = res.find((r) => r.extratags && r.extratags['pe:ubigeo'] === d.ubigeo && /Polygon/.test(r.geojson && r.geojson.type));
    if (!hit) throw new Error(`No OSM boundary with pe:ubigeo=${d.ubigeo} for ${d.district}`);
    features.push({ type: 'Feature', properties: { ...d }, geometry: hit.geojson, center: [+hit.lon, +hit.lat], osm: `r${hit.osm_id}` });
    console.log(`  district ${d.ubigeo} ${d.district.padEnd(22)} OSM r${hit.osm_id} ${hit.geojson.type}`);
  }
  return features;
}

// Real shop positions via Nominatim (Overpass is often overloaded): for every (chain, district)
// pair in PLAN search "<chain name>" bounded to the district bbox, plus a generic "supermercado"
// search per district for realistic retail spots when a chain has no OSM presence there.
async function fetchShops(features) {
  const elements = [];
  const pairs = [...new Set(PLAN.map(([c, u]) => `${c}|${u}`))];
  const queries = pairs.map((p) => { const [c, u] = p.split('|'); return { u, q: CHAIN_NAMES[c] }; })
    .concat([...new Set(PLAN.map(([, u]) => u))].flatMap((u) => [{ u, q: 'supermercado' }, { u, q: 'minimarket' }]));
  for (const { u, q } of queries) {
    const f = features.find((x) => x.properties.ubigeo === u);
    const [w, so, e, n] = bboxOf(f.geometry);
    const res = await cached(`search-${u}-${slug(q)}.json`, () => nominatim(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&limit=15&bounded=1&viewbox=${w},${n},${e},${so}&q=${encodeURIComponent(q)}`));
    for (const r of res) {
      if (r.category !== 'shop') continue;
      elements.push({ type: r.osm_type, id: r.osm_id, lat: +r.lat, lon: +r.lon, tags: { name: r.name, brand: (r.extratags || {}).brand || '', 'addr:street': '', shop: r.type } });
    }
  }
  // De-duplicate by OSM ref.
  const seen = new Set();
  return { elements: elements.filter((e) => { const k = e.type + e.id; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

const slug = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleStreet = (s) => (s || '').replace(/^Avenida\b/, 'Av.').replace(/^Calle\b/, 'Ca.').replace(/^Jirón\b/, 'Jr.');

async function main() {
  console.log('Districts (Nominatim, ≤1 req/s):');
  const features = await fetchDistricts();
  const topo = toTopology(features.map(({ type, properties, geometry }) => ({ type, properties, geometry })));
  const districtsJs = `// TEST FIXTURE — generated by tools/fixtures/build-fixtures.mjs (OSM boundaries via Nominatim, ODbL).\n` +
    `// 12 districts only. The real all-Peru file is data/districts.js (data workflow).\n` +
    `window.MT_DISTRICTS = ${JSON.stringify(topo)};\n`;
  await writeFile(path.join(HERE, 'districts.js'), districtsJs);
  console.log(`  -> districts.js (${(districtsJs.length / 1024).toFixed(0)} KB)`);

  console.log('Shops (Nominatim searches, ≤1 req/s, cached):');
  const osm = await fetchShops(features);
  const shops = osm.elements.map((e) => ({
    ref: `${e.type[0]}${e.id}`, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, tags: e.tags || {},
  })).filter((s) => s.lat != null);
  for (const s of shops) {
    const f = features.find((f) => inGeom([s.lng, s.lat], f.geometry));
    s.ubigeo = f ? f.properties.ubigeo : null;
    const label = `${s.tags.brand || ''} ${s.tags.name || ''}`;
    s.chain = Object.keys(CHAIN_RX).find((c) => CHAIN_RX[c].test(label)) || null;
  }
  console.log(`  ${shops.length} shops, ${shops.filter((s) => s.chain).length} matched to a tracked chain`);

  const used = new Set();
  const rnd = prng(20260930);
  const stores = [];
  const minSep = 0.0009; // ~100 m between fixture stores so they look like distinct sites
  const farEnough = (lat, lng) => stores.every((t) => Math.hypot(t.lat - lat, t.lng - lng) > minSep);
  for (const [i, [chain, ubigeo]] of PLAN.entries()) {
    const f = features.find((f) => f.properties.ubigeo === ubigeo);
    const inD = shops.filter((s) => s.ubigeo === ubigeo && !used.has(s.ref) && farEnough(s.lat, s.lng));
    // Tambo/Oxxo are convenience stores; others prefer supermarkets & co.
    let pick = inD.find((s) => s.chain === chain);
    let kind = 'osm';
    if (!pick) {
      const generic = inD.filter((s) => !s.chain).sort((a, b) => a.ref.localeCompare(b.ref));
      if (generic.length) { pick = generic[Math.floor(rnd() * generic.length)]; kind = 'osm-position'; }
    }
    let lat, lng;
    if (pick) { used.add(pick.ref); lat = pick.lat; lng = pick.lng; } else {
      kind = 'sampled';
      const [cx, cy] = f.center; const radius = 0.02;
      for (let k = 0; k < 500; k++) {
        const x = cx + (rnd() * 2 - 1) * radius, y = cy + (rnd() * 2 - 1) * radius;
        if (inGeom([x, y], f.geometry) && farEnough(y, x)) { lng = x; lat = y; break; }
      }
    }
    if (kind === 'sampled') {
      // Snap to the nearest mapped object (building/road) so the point sits on the street grid.
      const rev = await cached(`snap-${lat.toFixed(5)}_${lng.toFixed(5)}.json`, () => nominatim(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`));
      if (rev && rev.lat && inGeom([+rev.lon, +rev.lat], f.geometry) && farEnough(+rev.lat, +rev.lon)) { lat = +rev.lat; lng = +rev.lon; }
    }
    stores.push({ i, chain, ubigeo, lat: +lat.toFixed(6), lng: +lng.toFixed(6), kind, pick, f });
  }

  console.log('Addresses (Nominatim reverse, ≤1 req/s, cached):');
  const out = [];
  for (const s of stores) {
    const rev = await cached(`rev-${s.lat}_${s.lng}.json`, () => nominatim(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=es&lat=${s.lat}&lon=${s.lng}`));
    const a = rev.address || {};
    const t = s.pick ? s.pick.tags : {};
    const street = t['addr:street'] || a.road || a.pedestrian || a.neighbourhood || '';
    const num = t['addr:housenumber'] || a.house_number || '';
    const address = [titleStreet(street), num].filter(Boolean).join(' ');
    const chainName = CHAIN_NAMES[s.chain];
    // Use the OSM name only when it says more than the bare brand ("Vivanda - Libertadores").
    const osmName = s.kind === 'osm' && t.name && CHAIN_RX[s.chain].test(t.name) &&
      slug(t.name).replace(/-/g, '') !== slug(chainName).replace(/-/g, '') && !/^tambo\+?$/i.test(t.name) ? t.name : '';
    const where = (street && !/^(ingreso|pasillo|ciclov)/i.test(street) ? titleStreet(street).replace(/^(Av\.|Ca\.|Jr\.)\s*/, '') : s.f.properties.district)
      .split(/\s+/).slice(0, 3).join(' ');
    let name = osmName || `${chainName} ${where}`;
    // Keep names unique: add the district, then a number.
    if (out.some((o) => o.name === name)) name = `${chainName} ${where} (${s.f.properties.district})`;
    for (let k = 2; out.some((o) => o.name === name); k++) name = `${chainName} ${where} ${k}`;
    const isOsm = s.kind === 'osm';
    // A few web-only / manual / closed rows so status & source filters have something to show.
    let source = isOsm ? 'osm' : (s.i % 5 === 0 ? 'manual' : 'web');
    let status = source === 'web' && s.i % 3 === 0 ? 'to_verify' : 'verified';
    if (s.i === 13) status = 'closed';
    const id = source === 'osm' ? `osm-${s.pick.ref}`
      : source === 'web' ? `web-${s.chain}-${slug(name).replace(new RegExp('^' + slug(chainName) + '-?'), '') || s.i}`
        : `man-${(1759190400000 + s.i * 86400000).toString(36)}`;
    out.push({
      id, chain: s.chain, name, address,
      district: s.f.properties.district, province: s.f.properties.province, department: s.f.properties.department,
      ubigeo: s.ubigeo, lat: s.lat, lng: s.lng,
      precision: source === 'web' && s.i % 2 ? 'approx' : 'exact',
      source,
      source_ref: source === 'osm' ? s.pick.ref : source === 'web' ? `https://www.example.com/${s.chain}/tiendas` : '',
      status,
      notes: status === 'closed' ? 'Cerrada (fixture de prueba)' : '',
      updated: '2026-09-30',
    });
  }
  const columns = ['id', 'chain', 'name', 'address', 'district', 'province', 'department', 'ubigeo', 'lat', 'lng', 'precision', 'source', 'source_ref', 'status', 'notes', 'updated'];
  const seed = { generated: '2026-09-30', count: out.length, columns, stores: out };
  const storesJs = `// TEST FIXTURE — generated by tools/fixtures/build-fixtures.mjs. Positions are real OSM shop\n` +
    `// locations (ODbL); chain assignment for non-matching shops is synthetic. NOT the real seed.\n` +
    `window.MT_SEED = ${JSON.stringify(seed, null, 0).replace(/\},\{/g, '},\n{')};\n`;
  await writeFile(path.join(HERE, 'stores.js'), storesJs);
  const byKind = stores.reduce((m, s) => ((m[s.kind] = (m[s.kind] || 0) + 1), m), {});
  console.log(`  -> stores.js: ${out.length} stores`, byKind, 'chains:', new Set(out.map((s) => s.chain)).size);
}

main().catch((err) => { console.error(err); process.exit(1); });
