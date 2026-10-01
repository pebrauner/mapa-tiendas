#!/usr/bin/env node
// verify-districts.mjs — checks the outputs of tools/build-districts.mjs and writes
// tools/seed/key-ubigeos.json for later seed stages.
//
//   node tools/seed/verify-districts.mjs
//
// Checks: feature count, unique 6-digit ubigeos, exact property set, proper-case names,
// known points resolve to the right district (high-detail and simplified files), agreement
// between high-detail and simplified shapes on a deterministic sample of city points, and
// the size / shape of data/districts.js.

import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDistricts, locate, locateNearest, listDistricts, createIndex } from './pip.mjs';
import { readDistrictsJs, topoFeatures } from './topo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const JS_FILE = path.join(ROOT, 'data', 'districts.js');
const OUT = path.join(HERE, 'key-ubigeos.json');

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// 1. high-detail GeoJSON ------------------------------------------------------------
const t0 = Date.now();
const { count } = loadDistricts();
console.log(`loaded tools/seed/districts.geojson in ${Date.now() - t0} ms`);
const all = listDistricts();
check(count >= 1880 && count <= 1900, `feature count ${count} (expected ~1,890)`);
const codes = all.map((d) => d.ubigeo);
check(new Set(codes).size === codes.length, `no duplicate ubigeos (${new Set(codes).size} unique)`);
check(codes.every((c) => /^\d{6}$/.test(c)), 'every ubigeo is a 6-digit string');
const hiRaw = JSON.parse(readFileSync(path.join(HERE, 'districts.geojson'), 'utf8'));
const keysOk = hiRaw.features.every((f) => Object.keys(f.properties).join(',') === 'ubigeo,district,province,department');
check(keysOk, 'properties are exactly {ubigeo, district, province, department}');
const shouting = all.filter((d) => [d.district, d.province, d.department].some((n) => !n || /\p{Lu}{4,}/u.test(n)));
check(shouting.length === 0, `names are in proper case (${shouting.length} suspicious)`);
check(new Set(all.map((d) => d.department)).size === 25, `25 departments (${new Set(all.map((d) => d.department)).size})`);
check(new Set(all.map((d) => d.ubigeo.slice(0, 4))).size === 196, `196 provinces (${new Set(all.map((d) => d.ubigeo.slice(0, 4))).size})`);

// 2. known points -------------------------------------------------------------------
const POINTS = [
  { name: 'Larcomar', lat: -12.1318, lng: -77.0305, expect: 'Miraflores' },
  { name: 'Plaza de Armas de Trujillo', lat: -8.1116, lng: -79.0297, expect: 'Trujillo' },
  { name: 'Real Plaza San Borja area', lat: -12.0898, lng: -77.0050, expect: 'San Borja' },
  { name: 'Chimbote Plaza de Armas', lat: -9.0745, lng: -78.5936, expect: 'Chimbote' },
  { name: 'Nuevo Chimbote', lat: -9.1258, lng: -78.5245, expect: 'Nuevo Chimbote' },
  { name: 'Lurín', lat: -12.2747, lng: -76.8706, expect: 'Lurín' },
  { name: 'Punta Hermosa', lat: -12.3367, lng: -76.8240, expect: 'Punta Hermosa' },
];
const topo = readDistrictsJs(JS_FILE);
const loFeats = topoFeatures(topo);
const lo = createIndex({ type: 'FeatureCollection', features: loFeats });
const checkpoints = POINTS.map((p) => {
  const hit = locate(p.lat, p.lng);
  const hitLo = lo.locate(p.lat, p.lng);
  const ok = !!hit && hit.district === p.expect;
  check(ok, `${p.name} (${p.lat}, ${p.lng}) → ${hit ? `${hit.ubigeo} ${hit.district}, ${hit.province}, ${hit.department}` : 'null'}`);
  check(!!hitLo && hit && hitLo.ubigeo === hit.ubigeo, `   simplified data/districts.js agrees (${hitLo ? hitLo.ubigeo : 'null'})`);
  return { ...p, ...(hit || {}), ok };
});
check(locate(-12.5, -78.5) === null, 'a point in the Pacific returns null');
const coast = locateNearest(-12.1335, -77.0335, 300);
console.log(`     locateNearest just off the Miraflores coast → ${coast ? `${coast.district} at ${coast.distanceM} m` : 'null'}`);

// 3. data/districts.js ----------------------------------------------------------------
const jsBytes = statSync(JS_FILE).size;
check(jsBytes <= 3 * 1024 * 1024, `data/districts.js is ${(jsBytes / 1048576).toFixed(2)} MiB (${jsBytes.toLocaleString('en')} bytes, target ≲ 3 MB)`);
check(topo && topo.type === 'Topology' && topo.objects && topo.objects.districts, 'window.MT_DISTRICTS is a Topology with object "districts"');
const geoms = topo.objects.districts.geometries;
check(geoms.length === count, `topology has ${geoms.length} geometries`);
check(geoms.every((g) => Object.keys(g.properties).join(',') === 'ubigeo,district,province,department'), 'topology properties are exactly {ubigeo, district, province, department}');
check(new Set(geoms.map((g) => g.properties.ubigeo)).size === geoms.length, 'topology ubigeos unique');
check(geoms.every((g) => Array.isArray(g.bbox) && g.bbox.length === 4 && g.bbox[0] <= g.bbox[2] && g.bbox[1] <= g.bbox[3]), 'every topology geometry has bbox [w,s,e,n]');
check(geoms.every((g) => g.type === 'Polygon' || g.type === 'MultiPolygon'), 'all geometries are (Multi)Polygons');
// bbox must contain the decoded shape
const bboxOk = loFeats.every((f) => {
  const [w, s, e, n] = f.bbox;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.every((p) => p[0].every(([x, y]) => x >= w - 1e-9 && x <= e + 1e-9 && y >= s - 1e-9 && y <= n + 1e-9));
});
check(bboxOk, 'bboxes contain their shapes');

// 4. high-detail vs simplified agreement on city points (deterministic grid sample) --------
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const AREAS = {
  'Lima Metropolitana': [-77.20, -12.30, -76.80, -11.85],
  Trujillo: [-79.10, -8.18, -78.95, -8.03],
  Chimbote: [-78.62, -9.18, -78.48, -9.03],
};
const agreement = {};
for (const [name, [w, s, e, n]] of Object.entries(AREAS)) {
  let both = 0, same = 0;
  for (let i = 0; i < 20000; i++) {
    const lat = s + rnd() * (n - s), lng = w + rnd() * (e - w);
    const a = locate(lat, lng), b = lo.locate(lat, lng);
    if (!a || !b) continue;
    both++;
    if (a.ubigeo === b.ubigeo) same++;
  }
  agreement[name] = { samples: both, agreePct: Math.round((same / both) * 10000) / 100 };
  check(same / both > 0.995, `${name}: simplified vs high-detail agree on ${agreement[name].agreePct}% of ${both} random land points`);
}

// 5. key ubigeos -----------------------------------------------------------------------
const find = (district, province) => {
  const m = all.filter((d) => d.district === district && (!province || d.province === province));
  if (m.length !== 1) { check(false, `lookup "${district}" (${province}) matched ${m.length}`); return null; }
  return m[0];
};
const NAMED = [
  ['Miraflores', 'Lima'], ['San Borja', 'Lima'], ['San Isidro', 'Lima'], ['Surquillo', 'Lima'],
  ['Chorrillos', 'Lima'], ['San Juan de Miraflores', 'Lima'], ['Villa El Salvador', 'Lima'],
  ['Villa María del Triunfo', 'Lima'], ['Lurín', 'Lima'], ['Punta Hermosa', 'Lima'],
  ['Trujillo', 'Trujillo'], ['Chimbote', 'Santa'], ['Nuevo Chimbote', 'Santa'],
];
const named = {};
for (const [d, p] of NAMED) {
  const hit = find(d, p);
  if (hit) named[`${d} (${p})`] = hit.ubigeo;
}
const prov = (code) => all.filter((d) => d.ubigeo.startsWith(code)).map((d) => ({ ubigeo: d.ubigeo, district: d.district }));
const result = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'tools/seed/districts.geojson (tools/build-districts.mjs: INEI límites censales 2023 + OSM names)',
  districtCount: count,
  checkpoints: checkpoints.map(({ name, lat, lng, expect, ubigeo, district, province, department, ok }) => ({ name, lat, lng, expect, ubigeo, district, province, department, ok })),
  named,
  provinces: {
    'Lima (1501)': prov('1501'),
    'Callao (0701)': prov('0701'),
    'Trujillo (1301)': prov('1301'),
    'Santa (0218)': prov('0218'),
  },
  simplifiedAgreement: agreement,
};
writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
console.log('\nKey ubigeos:');
for (const [k, v] of Object.entries(named)) console.log(`  ${v}  ${k}`);
console.log('  Trujillo province:');
for (const d of result.provinces['Trujillo (1301)']) console.log(`    ${d.ubigeo}  ${d.district}`);
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
