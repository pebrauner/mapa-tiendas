#!/usr/bin/env node
// build-districts.mjs — builds the Peru district boundary files used by mapa-tiendas.
//
//   node tools/build-districts.mjs            # download (cached) + build everything
//   node tools/build-districts.mjs --refresh  # ignore the download cache and fetch again
//
// Sources (see tools/seed/districts-README.md):
//   * Geometry + ubigeo: INEI "límites censales" 2023 (1,891 districts), served by the
//     PCM / Secretaría de Demarcación y Organización Territorial GeoServer (WFS layer
//     geoportal:v_distritos_2023). Names there are UPPERCASE without accents.
//   * Proper-case Spanish names with accents: OpenStreetMap boundary relations, matched by
//     their `pe:ubigeo` tag (Overpass API, one query). OSM spelling is only used when it
//     folds (accents/case removed) to exactly the INEI name, word for word; otherwise the
//     INEI name is title-cased with accents restored from a word dictionary. A short,
//     documented override list (NAME_OVERRIDES) fixes known source defects.
//
// Geometry: mapshaper -clean (repairs census overlaps/slivers), then two simplifications of the
// same topology. Shared borders keep the finer interval of their two districts (mapshaper
// takes the minimum per arc), so city borders stay detailed even next to a big rural district.
//
// Outputs:
//   tools/seed/districts.geojson   high-detail (lightly simplified) FeatureCollection, for
//                                  point-in-polygon in Node (tools/seed/pip.mjs)
//   data/districts.js              window.MT_DISTRICTS = <TopoJSON Topology>, object "districts",
//                                  properties { ubigeo, district, province, department },
//                                  per-geometry bbox [w,s,e,n]
//   tools/seed/districts-build-report.json   counts, name-matching report
//
// Only Node built-ins are used; the geometry work shells out to `npx -y mapshaper@0.6.121`.

import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'tools', 'seed');
const CACHE = path.join(SEED, '.cache-districts');
const OUT_GEOJSON = path.join(SEED, 'districts.geojson');
const OUT_JS = path.join(ROOT, 'data', 'districts.js');
const OUT_REPORT = path.join(SEED, 'districts-build-report.json');

const UA = 'mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)';
const MAPSHAPER = 'mapshaper@0.6.121';
const WFS = 'https://geosdot.servicios.gob.pe/geoserver/geoportal/wfs';
const WFS_LAYER = 'geoportal:v_distritos_2023';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const DEPARTMENT_CODES = Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(2, '0'));
const EXPECTED_DISTRICTS = 1891;

// Simplification settings -------------------------------------------------------------
// High-detail file: drop only vertices that matter at < ~3 m.
const HI_INTERVAL_M = 3;
// App file (TopoJSON): resolution varies with district size so dense urban districts keep
// street-level detail at zoom 12-14 while huge rural districts are simplified harder.
//   interval (m) = clamp(K * sqrt(area_km2), MIN, MAX)
const LO_K = 4.5, LO_MIN_M = 12, LO_MAX_M = 400;
const LO_QUANTIZATION = 1_000_000; // ~1.4 m grid over Peru's extent
const MAX_JS_BYTES = 3 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
const REFRESH = args.has('--refresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[districts]', ...a);

// --------------------------------------------------------------------------------------
// 1. Downloads (cached)
// --------------------------------------------------------------------------------------
async function fetchText(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 300_000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      log(`  retry ${i + 1}/${tries} after error: ${e.message}`);
      await sleep(5000 * (i + 1));
    }
  }
  throw lastErr;
}

async function downloadInei() {
  const files = [];
  for (const dep of DEPARTMENT_CODES) {
    const file = path.join(CACHE, `inei-distritos-${dep}.geojson`);
    files.push(file);
    if (!REFRESH && existsSync(file)) continue;
    const params = new URLSearchParams({
      service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: WFS_LAYER,
      outputFormat: 'application/json', srsName: 'EPSG:4326',
      CQL_FILTER: `ubigeo LIKE '${dep}%'`,
    });
    log(`downloading INEI districts of department ${dep} ...`);
    const text = await fetchText(`${WFS}?${params}`);
    const fc = JSON.parse(text); // validate before caching
    if (fc.type !== 'FeatureCollection' || !fc.features.length) throw new Error(`empty WFS answer for ${dep}`);
    await writeFile(file, text);
    log(`  ${fc.features.length} districts, ${(text.length / 1e6).toFixed(1)} MB`);
    await sleep(1500); // be gentle with a public government server
  }
  return files;
}

async function downloadOsmNames() {
  const file = path.join(CACHE, 'osm-admin-names.json');
  if (!REFRESH && existsSync(file)) return file;
  const query = '[out:json][timeout:180];area["ISO3166-1"="PE"][admin_level=2]->.pe;' +
    'rel(area.pe)["boundary"="administrative"]["admin_level"~"^(4|6|8)$"];out tags;';
  let lastErr;
  for (const ep of OVERPASS) {
    try {
      log(`downloading OSM admin names from ${ep} ...`);
      const text = await fetchText(ep, {
        method: 'POST', body: new URLSearchParams({ data: query }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, 2);
      const j = JSON.parse(text);
      if (!j.elements || j.elements.length < 1000) throw new Error('suspiciously small Overpass answer');
      await writeFile(file, text);
      return file;
    } catch (e) { lastErr = e; log(`  failed: ${e.message}`); }
  }
  throw lastErr;
}

// --------------------------------------------------------------------------------------
// 2. Names: INEI uppercase -> proper Spanish case with accents
// --------------------------------------------------------------------------------------
const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const words = (s) => s.normalize('NFC').match(/[\p{L}\p{N}]+/gu) || [];
// Orthographic fixes for words that never appear accented in the OSM dictionary.
const WORD_FIXES = { VEINTISEIS: 'Veintiséis' };
// Known defects in the source names (documented in tools/seed/districts-README.md).
const NAME_OVERRIDES = {
  '060506': 'Santa Cruz de Toledo', // INEI name field is truncated: "SANTA CRUZ DE TOLED"
  '070103': 'Carmen de la Legua Reynoso', // OSM capitalises the article ("de La Legua")
};
const LOWER_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'el', 'en', 'al', 'a']);
const ROMAN = /^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/;

// Word dictionary learned from OSM names: FOLDED -> { variant: count }
const wordDict = new Map();
function learnWords(name) {
  for (const w of words(name)) {
    const k = fold(w);
    if (!wordDict.has(k)) wordDict.set(k, new Map());
    const m = wordDict.get(k);
    m.set(w, (m.get(w) || 0) + 1);
  }
}
function bestVariant(foldedWord) {
  const m = wordDict.get(foldedWord);
  if (!m) return null;
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Replace each word of the INEI name (keeping INEI separators) by the given cased words.
function applyWords(ineiName, casedWords) {
  let i = 0;
  return ineiName.normalize('NFC').replace(/[\p{L}\p{N}]+/gu, () => casedWords[i++]);
}

function titleCaseEs(ineiName) {
  const ws = words(ineiName);
  const cased = ws.map((w, idx) => {
    const k = fold(w);
    if (ROMAN.test(k)) return k;
    if (WORD_FIXES[k]) return WORD_FIXES[k];
    const lower = w.toLowerCase();
    if (idx > 0 && LOWER_PARTICLES.has(fold(lower).toLowerCase())) return lower;
    const v = bestVariant(k);
    // use the dictionary variant only if it is capitalised (a proper-noun spelling)
    if (v && v[0] === v[0].toUpperCase()) return v;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  return applyWords(ineiName, cased);
}

// candidates: OSM spellings in order of preference. Returns { name, how }.
function properName(ineiName, candidates) {
  const iw = words(ineiName).map(fold);
  for (const c of candidates) {
    if (!c) continue;
    const cw = words(c);
    if (cw.length === iw.length && cw.every((w, i) => fold(w) === iw[i])) {
      return { name: applyWords(ineiName, cw), how: 'osm' };
    }
  }
  return { name: titleCaseEs(ineiName), how: 'titlecase' };
}

const stripPrefix = (s) => s && s.replace(/^(Departamento|Provincia constitucional|Provincia Constitucional|Provincia|Distrito)\s+(de|del)\s+/i, '');

// --------------------------------------------------------------------------------------
// 3. Merge INEI geometry + names
// --------------------------------------------------------------------------------------
// Approximate area (km²) of a (Multi)Polygon: local equirectangular projection per ring.
function areaKm2(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const R = 6371.0088, rad = Math.PI / 180;
  let total = 0;
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      let a = 0;
      const lat0 = ring[0][1] * rad, kx = Math.cos(lat0) * R * rad, ky = R * rad;
      for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
        a += (ring[k][0] * kx) * (ring[j][1] * ky) - (ring[j][0] * kx) * (ring[k][1] * ky);
      }
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return total;
}

async function buildRaw(ineiFiles, osmFile) {
  const osm = JSON.parse(await readFile(osmFile, 'utf8')).elements;
  const byCode = { 4: new Map(), 6: new Map(), 8: new Map() };
  for (const e of osm) {
    const t = e.tags || {};
    const code = t['pe:ubigeo'];
    if (!code || !byCode[t.admin_level]) continue;
    byCode[t.admin_level].set(code, t);
    for (const n of [t.name, stripPrefix(t.official_name)]) if (n) learnWords(n);
  }
  log(`OSM names: ${byCode[4].size} departments, ${byCode[6].size} provinces, ${byCode[8].size} districts`);

  const features = [];
  const report = { districts: { osm: 0, titlecase: [] }, provinces: { osm: 0, titlecase: [] }, departments: { osm: 0, titlecase: [] }, overrides: [], osmNameDiffers: [] };
  const provCache = new Map(), depCache = new Map();
  for (const file of ineiFiles) {
    const fc = JSON.parse(await readFile(file, 'utf8'));
    for (const f of fc.features) {
      const p = f.properties;
      const ubigeo = String(p.ubigeo).trim();
      if (!/^\d{6}$/.test(ubigeo)) throw new Error(`bad ubigeo ${p.ubigeo}`);
      const depCode = ubigeo.slice(0, 2), provCode = ubigeo.slice(0, 4);

      if (!depCache.has(depCode)) {
        const t = byCode[4].get(depCode) || {};
        const r = properName(p.nombdep, [stripPrefix(t.official_name), t.name]);
        depCache.set(depCode, r.name);
        if (r.how === 'osm') report.departments.osm++; else report.departments.titlecase.push(`${depCode} ${p.nombdep} -> ${r.name}`);
      }
      if (!provCache.has(provCode)) {
        // Callao is a department-level "Provincia Constitucional" with no separate province relation in OSM
        const t = byCode[6].get(provCode) || (provCode === '0701' ? byCode[4].get('07') : null) || {};
        const r = properName(p.nombprov, [t.name, stripPrefix(t.official_name)]);
        provCache.set(provCode, r.name);
        if (r.how === 'osm') report.provinces.osm++; else report.provinces.titlecase.push(`${provCode} ${p.nombprov} -> ${r.name}`);
      }
      const t = byCode[8].get(ubigeo) || {};
      const r = properName(p.nombdist, [t.name, stripPrefix(t.name), stripPrefix(t.official_name), t.alt_name]);
      if (NAME_OVERRIDES[ubigeo]) {
        report.overrides.push(`${ubigeo} ${p.nombdist} -> ${NAME_OVERRIDES[ubigeo]} (was "${r.name}")`);
        r.name = NAME_OVERRIDES[ubigeo];
        r.how = 'override';
      }
      if (r.how === 'osm') report.districts.osm++;
      else if (r.how === 'override') { /* counted in report.overrides */ }
      else {
        report.districts.titlecase.push(`${ubigeo} ${p.nombdist} -> ${r.name}`);
        if (t.name) report.osmNameDiffers.push(`${ubigeo} INEI "${p.nombdist}" vs OSM "${t.name}"`);
      }
      if (!f.geometry) throw new Error(`district ${ubigeo} has no geometry`);
      const km2 = areaKm2(f.geometry);
      features.push({
        type: 'Feature',
        properties: {
          ubigeo, district: r.name, province: provCache.get(provCode), department: depCache.get(depCode),
          // per-district simplification interval for the app file (dropped before output)
          simp_m: Math.round(Math.min(LO_MAX_M, Math.max(LO_MIN_M, LO_K * Math.sqrt(km2)))),
        },
        geometry: f.geometry,
      });
    }
  }
  features.sort((a, b) => a.properties.ubigeo.localeCompare(b.properties.ubigeo));
  const codes = new Set(features.map((f) => f.properties.ubigeo));
  if (codes.size !== features.length) throw new Error(`duplicate ubigeos: ${features.length - codes.size}`);
  if (features.length !== EXPECTED_DISTRICTS) log(`WARNING: ${features.length} districts (expected ${EXPECTED_DISTRICTS})`);
  const missingInOsm = [...codes].filter((c) => !byCode[8].has(c));
  const extraInOsm = [...byCode[8].keys()].filter((c) => !codes.has(c));
  Object.assign(report, { missingInOsm, extraInOsm });

  const rawFile = path.join(CACHE, 'districts-raw.geojson');
  await writeFile(rawFile, JSON.stringify({ type: 'FeatureCollection', features }));
  return { rawFile, report, count: features.length };
}

// --------------------------------------------------------------------------------------
// 4. Geometry processing with mapshaper
// --------------------------------------------------------------------------------------
function mapshaper(argv) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  log(`$ npx -y ${MAPSHAPER} ${argv.join(' ')}`);
  // npx is a .cmd shim on Windows, which needs a shell; pass one pre-quoted command string there
  const r = isWin
    ? spawnSync([cmd, '-y', MAPSHAPER, ...argv].join(' '), { stdio: ['ignore', 'inherit', 'inherit'], shell: true })
    : spawnSync(cmd, ['-y', MAPSHAPER, ...argv], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`mapshaper failed (exit ${r.status})`);
}
const q = (s) => (process.platform === 'win32' ? `"${s}"` : s); // quote paths for the Windows shell

async function buildGeometry(rawFile) {
  const cleanFile = path.join(CACHE, 'districts-clean.json');
  const loFile = path.join(CACHE, 'districts-lo.topojson');

  // a) clean: repair the census polygons once (overlaps/gaps/self-intersections) and keep
  //    the result as an unquantized topology shared by both outputs
  mapshaper([q(rawFile), '-clean', '-o', 'format=topojson', 'no-quantization', q(cleanFile)]);

  // b) high-detail GeoJSON for point-in-polygon
  mapshaper([q(cleanFile), '-simplify', `interval=${HI_INTERVAL_M}`, 'keep-shapes',
    '-filter-fields', 'ubigeo,district,province,department',
    '-o', 'format=geojson', 'precision=0.000001', q(OUT_GEOJSON)]);

  // c) presentation TopoJSON: size-dependent simplification (interval per district in simp_m)
  mapshaper([q(cleanFile), '-simplify', 'variable', 'interval=simp_m', 'keep-shapes',
    '-filter-fields', 'ubigeo,district,province,department',
    '-o', 'format=topojson', `quantization=${LO_QUANTIZATION}`, q(loFile)]);
  return loFile;
}

// Adds bbox [w,s,e,n] to every geometry object of a quantized topology.
function addBboxes(topo) {
  const [kx, ky] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  const arcBox = topo.arcs.map((arc) => {
    let x = 0, y = 0, w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [dx, dy] of arc) { x += dx; y += dy; if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return [w, s, e, n];
  });
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  for (const g of topo.objects.districts.geometries) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const visit = (a) => { if (typeof a === 'number') { const b = arcBox[a < 0 ? ~a : a]; if (b[0] < w) w = b[0]; if (b[1] < s) s = b[1]; if (b[2] > e) e = b[2]; if (b[3] > n) n = b[3]; } else a.forEach(visit); };
    visit(g.arcs);
    // round outward so the bbox always contains the shape
    g.bbox = [Math.floor((w * kx + tx) * 1e5) / 1e5, Math.floor((s * ky + ty) * 1e5) / 1e5,
      Math.ceil((e * kx + tx) * 1e5) / 1e5, Math.ceil((n * ky + ty) * 1e5) / 1e5].map(r5);
  }
}

async function writeAppFile(loFile, count) {
  const topo = JSON.parse(await readFile(loFile, 'utf8'));
  const objName = Object.keys(topo.objects)[0];
  if (objName !== 'districts') { topo.objects.districts = topo.objects[objName]; delete topo.objects[objName]; }
  const geoms = topo.objects.districts.geometries;
  if (geoms.length !== count) throw new Error(`topology has ${geoms.length} geometries, expected ${count}`);
  for (const g of geoms) {
    const p = g.properties;
    g.properties = { ubigeo: p.ubigeo, district: p.district, province: p.province, department: p.department };
    delete g.id;
  }
  if (!topo.transform) throw new Error('expected a quantized topology');
  addBboxes(topo);
  const header = '/* mapa-tiendas — Peru districts (TopoJSON). Generated by tools/build-districts.mjs on ' +
    new Date().toISOString().slice(0, 10) + '.\n' +
    ' * Boundaries: INEI límites censales 2023 (via PCM-SDOT GeoServer, layer v_distritos_2023) — referential, not legal demarcation.\n' +
    ' * Names (accents/case): © OpenStreetMap contributors (ODbL), matched by ubigeo. See tools/seed/districts-README.md. */\n';
  const js = header + 'window.MT_DISTRICTS = ' + JSON.stringify(topo) + ';\n';
  await mkdir(path.dirname(OUT_JS), { recursive: true });
  await writeFile(OUT_JS, js);
  return Buffer.byteLength(js);
}

// --------------------------------------------------------------------------------------
async function main() {
  await mkdir(CACHE, { recursive: true });
  // the cache directory ignores itself, so no shared .gitignore needs to change
  await writeFile(path.join(CACHE, '.gitignore'), '*\n');

  const ineiFiles = await downloadInei();
  const osmFile = await downloadOsmNames();
  const { rawFile, report, count } = await buildRaw(ineiFiles, osmFile);
  log(`merged ${count} districts; names from OSM: ${report.districts.osm}, title-cased fallback: ${report.districts.titlecase.length}`);

  const loFile = await buildGeometry(rawFile);
  const jsBytes = await writeAppFile(loFile, count);
  const hiBytes = (await stat(OUT_GEOJSON)).size;
  log(`data/districts.js: ${(jsBytes / 1048576).toFixed(2)} MB` + (jsBytes > MAX_JS_BYTES ? '  (WARNING: above 3 MB target)' : ''));
  log(`tools/seed/districts.geojson: ${(hiBytes / 1048576).toFixed(2)} MB`);

  const full = {
    generated: new Date().toISOString(),
    count,
    sources: {
      geometry: `${WFS}?typeName=${WFS_LAYER} (INEI límites censales 2023)`,
      names: 'OpenStreetMap boundary relations (pe:ubigeo), via Overpass API',
    },
    settings: { HI_INTERVAL_M, LO_K, LO_MIN_M, LO_MAX_M, LO_QUANTIZATION, mapshaper: MAPSHAPER },
    sizes: { districtsJsBytes: jsBytes, districtsGeojsonBytes: hiBytes },
    names: report,
  };
  await writeFile(OUT_REPORT, JSON.stringify(full, null, 2) + '\n');
  await rm(path.join(CACHE, 'districts-lo.topojson'), { force: true });
  log('done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
