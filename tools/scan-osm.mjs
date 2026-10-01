#!/usr/bin/env node
// tools/scan-osm.mjs — nationwide OpenStreetMap candidate scan for the 16 tracked chains.
//
// Queries the Overpass API for ALL of Peru and saves every element whose name-like tags match a
// BROAD case-insensitive regex for any tracked chain, or whose brand/operator:wikidata is a known
// chain QID. Classification is NOT done here (that is the merge stage); this script only collects
// candidates and writes a provisional report to help design the merge stage's rules.
//
// How: Peru is split into bbox tiles (2° grid; 0.5° over Lima Metropolitana + Callao). Each tile query
// selects elements by key presence in the bbox, regex-filters that set, then filters the (small)
// candidate set by the Perú country area and by each department area to drop foreign elements and
// attribute a department. (Area-filtered regex queries took >120 s even for Tumbes; value-regex+bbox
// statements and negative key filters were also very slow — see buildQuery.) Tiles that time out are
// split in 4. Results are deduplicated by type+id.
//
// Outputs (all in tools/seed/):
//   osm-raw.json         [{ type:"node|way|relation", id, lat, lng, tags:{...} }]   (Peru only, deduped)
//   osm-scan-meta.json   provenance: endpoints, tiles, OSM base timestamp, department per element
//   osm-scan-report.md   provisional classification + ambiguous/suspicious matches
//                        (hand-written tools/seed/osm-scan-notes.md, if present, is inserted as its section 0)
//
// Usage:
//   node tools/scan-osm.mjs                 full scan (tile results cached in the OS temp dir → resumable)
//   node tools/scan-osm.mjs --fresh         ignore the tile cache
//   node tools/scan-osm.mjs --report-only   rebuild osm-scan-report.md from existing osm-raw.json + meta
//   node tools/scan-osm.mjs --dept=Callao,Tumbes   only tiles touching these departments (→ *.partial files)
//   node tools/scan-osm.mjs --endpoint=https://overpass-api.de/api/interpreter   try this endpoint first
//   node tools/scan-osm.mjs --endpoint=URL --only   use only that endpoint
//   node tools/scan-osm.mjs --print-query   print the query of one tile and exit
//   node tools/scan-osm.mjs --test-bbox=s,w,n,e   run a single tile query, print counts/timing, exit
//
// Node built-ins only (Node >= 18 for global fetch). Polite: one query at a time, pauses between
// queries, on HTTP 429 switches endpoint (or waits for the slot the server announces), per-endpoint
// exponential backoff, endpoint fallback.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = path.join(ROOT, 'tools', 'seed');
const UA = 'mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const PERU_REL = 288247; // relation "Perú" (ISO3166-1=PE, admin_level=2)
const PERU_AREA = 3600000000 + PERU_REL;
// Server-side limits: a modest [timeout] matters — overpass-api.de rejected [timeout:180] with 504 at
// admission under load, while [timeout:60..90][maxsize:128MB] queries were accepted immediately.
const Q_TIMEOUT = 90;
const Q_MAXSIZE = 134217728;
const CLIENT_TIMEOUT_MS = 170000;

// ---------------------------------------------------------------------------------------------
// Chains: broad (candidate) patterns for Overpass (POSIX ERE, case-insensitive via ",i") and
// Wikidata QIDs. Keep these GENEROUS — false positives are triaged in the report / merge stage.
// QIDs: name-suggestion-index (brands/shop/*) for plazavea, tottus, metro, dollarcity, makro, tambo,
// oxxo; Wikidata search (wbsearchentities, label/description/country checked) for the others.
// No QID found for Flora y Fauna. Holi: Q139603397 (found later by the logo stage; no OSM element carried it on 2026-10-01).
// ---------------------------------------------------------------------------------------------
const B = '(^|[- _.,;:/(&+#|])'; // "word start" without \b (not supported by Overpass ERE)
const CHAINS = [
  { id: 'plazavea', name: 'Plaza Vea', group: 'super', qids: ['Q7203672'], ere: ['plaza[ ._-]*vea'] },
  { id: 'tottus', name: 'Tottus', group: 'super', qids: ['Q7828510'], ere: ['tott?us'] },
  { id: 'wong', name: 'Wong', group: 'super', qids: ['Q28604866'], ere: [`${B}wong([^a-z]|$)`] },
  { id: 'metro', name: 'Metro', group: 'super', qids: ['Q16640217'], ere: [`${B}metro`] },
  { id: 'vivanda', name: 'Vivanda', group: 'super', qids: ['Q7937539'], ere: ['vivanda'] },
  { id: 'tiendas3a', name: 'Tiendas 3A', group: 'discount', qids: ['Q136373411'],
    ere: ['tiendas?[ ._-]*(3|tres)[ ._-]*a([^a-z]|$)', `${B}3[ -]?a([^a-z0-9]|$)`] },
  { id: 'mass', name: 'Mass', group: 'discount', qids: ['Q104814825'], ere: [`${B}mass`] },
  { id: 'preciouno', name: 'Hiperbodega Precio Uno', group: 'discount', qids: ['Q109657737'],
    ere: ['precio[ ._-]*(uno|1)([^0-9a-z]|$)', 'hiper[ -]*bodega'] },
  { id: 'maxiahorro', name: 'Maxiahorro', group: 'discount', qids: ['Q136408748'], ere: ['maxi[ ._-]*ahorro'] },
  { id: 'dollarcity', name: 'Dollarcity', group: 'discount', qids: ['Q107120814'], ere: ['dol+ar[ ._-]*city'] },
  { id: 'makro', name: 'Makro', group: 'wholesale', qids: ['Q704606'], ere: ['makro', 'ma[ck]ro[ ._-]*(super)?[ ._-]*mayorista'] },
  { id: 'vega', name: 'Vega', group: 'wholesale', qids: ['Q139603395'], ere: [`${B}vega([^a-z]|$)`] },
  { id: 'florayfauna', name: 'Flora y Fauna', group: 'specialty', qids: [], ere: ['flora[ ._&y-]*fauna'] },
  { id: 'holi', name: 'Holi', group: 'specialty', qids: ['Q139603397'], ere: [`${B}holi([^a-z]|$)`] },
  { id: 'tambo', name: 'Tambo / Tambo+', group: 'convenience', qids: ['Q64516439'], ere: [`${B}tambo([^a-z]|$)`, 'tambo[ ]*([+]|plus)'] },
  { id: 'oxxo', name: 'Oxxo', group: 'convenience', qids: ['Q1342538'], ere: ['oxxo'] },
];
// Parent companies / operators — generous extra net (mainly meaningful on brand/operator).
const CORP_ERE = ['supermercados[ ]+peruanos', 'cencosud', 'inretail', 'hipermercados[ ]+tottus', 'corporaci.n[ ]+vega'];

const NAME_KEYS = ['name', 'name:es', 'brand', 'brand:es', 'operator', 'old_name', 'alt_name', 'official_name', 'short_name'];
const BROAD_ERE = [...CHAINS.flatMap((c) => c.ere), ...CORP_ERE].join('|');
const ALL_QIDS = CHAINS.flatMap((c) => c.qids);
const QID_ERE = `(${ALL_QIDS.join('|')})([^0-9]|$)`;
// Exclusions applied inside the query: streets/rivers/admin boundaries/route relations are never stores.
const EXCL = '[!"highway"][!"waterway"][!"boundary"]["type"!~"^(route|route_master|boundary|waterway|network|multilinestring)$"]';

// Tiling. With the key-select-then-filter query shape a 2° rural tile, a 2° tile containing
// Trujillo and a 0.25° Callao tile each took ~10–20 s on overpass-api.de, a 4° tile ~27 s.
const BASE_CELL = 2.0;
const FINE_CELL = 0.5;
const FINE_ZONE = { s: -12.56, w: -77.26, n: -11.56, e: -76.62 }; // Lima Metropolitana + Callao
const MAX_SPLIT_DEPTH = 3;

// ---------------------------------------------------------------------------------------------
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const CACHE_DIR = path.join(os.tmpdir(), 'mapa-tiendas-osm-cache');

const endpointStats = new Map(); // url -> stats
function stat(url) {
  if (!endpointStats.has(url)) endpointStats.set(url, { ok: 0, fail: 0, ms: 0, lastError: null, preflight: null, preflightMs: null, osmBase: null, penaltyUntil: 0 });
  return endpointStats.get(url);
}
function allEndpoints() {
  if (typeof args.endpoint === 'string' && args.only) return [args.endpoint]; // --endpoint=URL --only
  return [...new Set([...(typeof args.endpoint === 'string' ? [args.endpoint] : []), ...ENDPOINTS])];
}
// Each endpoint has a "not before" time (penaltyUntil). A failure or HTTP 429 pushes it into the
// future, so the next query goes to the other live endpoint instead of idling; once the penalty
// expires a fast-but-busy server such as overpass-api.de gets used again. Still ONE query at a time.
function penalize(url, ms) { const s = stat(url); s.penaltyUntil = Math.max(s.penaltyUntil || 0, Date.now() + ms); }
function liveEndpoints() {
  const all = allEndpoints();
  const reachable = all.filter((u) => !stat(u).unreachable);
  return reachable.length ? reachable : all;
}
function pickEndpoint() {
  const list = liveEndpoints();
  const pref = typeof args.endpoint === 'string' ? args.endpoint : null;
  let best = null; let bestT = Infinity;
  for (const u of list) { // earliest available; ties → list order (preferred endpoint first)
    const t = Math.max(stat(u).penaltyUntil || 0, Date.now()) - (u === pref ? 1 : 0);
    if (t < bestT) { best = u; bestT = t; }
  }
  return best;
}

class OverpassError extends Error {
  constructor(msg, { tooBig = false, status = 0 } = {}) { super(msg); this.tooBig = tooBig; this.status = status; }
}

async function postOverpass(url, query, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new OverpassError(`HTTP ${res.status}${res.status === 400 ? ': ' + text.slice(0, 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : ''}`, { status: res.status });
    let json;
    try { json = JSON.parse(text); } catch {
      throw new OverpassError(`non-JSON response: ${text.slice(0, 160).replace(/\s+/g, ' ')}`, { tooBig: /timed out|out of memory/i.test(text) });
    }
    // Overpass reports runtime errors (timeouts, out of memory) with HTTP 200 + "remark" → INCOMPLETE result.
    if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
      throw new OverpassError(`remark: ${json.remark.slice(0, 160)}`, { tooBig: /timed out|out of memory/i.test(json.remark) });
    }
    return { json, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof OverpassError) throw e;
    if (e.name === 'AbortError') throw new OverpassError(`client timeout after ${Math.round(timeoutMs / 1000)} s`);
    throw new OverpassError(`network: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// On HTTP 429, ask the endpoint's /status how long until a slot frees up (seconds).
async function slotWaitSeconds(url) {
  try {
    const res = await fetch(url.replace(/\/interpreter$/, '/status'), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const txt = await res.text();
    if (/slots? available now/i.test(txt)) return 3;
    const secs = [...txt.matchAll(/in (\d+) seconds/g)].map((m) => +m[1]);
    if (secs.length) return Math.min(...secs) + 2;
  } catch { /* ignore */ }
  return 30;
}

async function preflight() {
  const q = '[out:json][timeout:20];node["shop"="supermarket"](-12.13,-77.04,-12.11,-77.02);out ids 1;';
  for (const url of allEndpoints()) {
    const s = stat(url);
    try {
      const { json, ms } = await postOverpass(url, q, 25000);
      s.preflight = true; s.preflightMs = ms; s.osmBase = json.osm3s?.timestamp_osm_base || null;
      log(`preflight OK   ${url} (${ms} ms, osm_base ${s.osmBase})`);
    } catch (e) {
      s.preflight = false; s.lastError = e.message; penalize(url, 4 * 60 * 1000);
      // Not reachable at all from here (connect hang / network error) → don't waste minutes on it later.
      s.unreachable = !e.status && /client timeout|network/.test(e.message);
      log(`preflight FAIL ${url}: ${e.message}`);
    }
    await sleep(1000);
  }
}

// Run one query with endpoint fallback + backoff. Throws OverpassError (tooBig=true → caller splits).
async function runQuery(query, label) {
  let lastErr = null;
  let clientTimeouts = 0;
  let failures = 0;
  const MAX_FAILURES = 8;
  while (failures < MAX_FAILURES) {
    const url = pickEndpoint();
    const s = stat(url);
    const wait = (s.penaltyUntil || 0) - Date.now();
    if (wait > 0) { log(`    waiting ${Math.ceil(wait / 1000)}s for ${new URL(url).host}`); await sleep(wait); }
    try {
      const { json, ms } = await postOverpass(url, query, CLIENT_TIMEOUT_MS);
      s.ok++; s.ms += ms;
      return { json, url, ms };
    } catch (e) {
      s.fail++; s.lastError = e.message; lastErr = e;
      log(`  ! ${label} @ ${new URL(url).host}: ${e.message}`);
      if (e.tooBig) throw e; // server says the query is too heavy → caller splits the tile
      if (/client timeout/.test(e.message) && ++clientTimeouts >= 2) { e.tooBig = true; throw e; }
      if (e.status === 429) { penalize(url, (await slotWaitSeconds(url)) * 1000); continue; } // not a failure
      failures++;
      penalize(url, Math.min(15000 * 2 ** failures, 240000)); // 30 s, 60 s, 120 s, 240 s …
      await sleep(2000);
    }
  }
  throw lastErr;
}

const fmtBb = (b) => `${b.s.toFixed(4)},${b.w.toFixed(4)},${b.n.toFixed(4)},${b.e.toFixed(4)}`;
// Query shape matters a lot for speed: a value-regex filter combined directly with a bbox
// (nwr["name"~"…",i](bbox)) took >40 s (timeout) on a 1° tile, while selecting by key presence
// first and regex-filtering that in-memory set took ~1.4 s. So: (1) key-presence selection in the
// bbox, (2) regex / QID filters on that set, (3) drop non-store features, (4) Peru/department areas.
function buildQuery(bbox, depts) {
  const bb = `(${fmtBb(bbox)})`;
  const sel = NAME_KEYS.map((k) => `  nwr["${k}"]${bb};`); // NB: no negative filters here — [!"highway"] made this ~10x slower
  sel.push(`  nwr["brand:wikidata"]${bb};`, `  nwr["operator:wikidata"]${bb};`);
  const flt = NAME_KEYS.map((k) => `  nwr.all["${k}"~"${BROAD_ERE}",i];`);
  flt.push(`  nwr.all["brand:wikidata"~"${QID_ERE}"];`, `  nwr.all["operator:wikidata"~"${QID_ERE}"];`);
  const parts = [
    `[out:json][timeout:${Q_TIMEOUT}][maxsize:${Q_MAXSIZE}];`,
    `(\n${sel.join('\n')}\n)->.all;`,
    `(\n${flt.join('\n')}\n)->.m;`,
    `nwr.m${EXCL}->.c;`,
    '.c out center tags;',
    // Which candidates are inside Peru, and inside which department (cheap: filters the small set .c).
    'make mt_sep k="peru"; out;',
    `area(id:${PERU_AREA})->.pe; nwr.c(area.pe); out ids;`,
  ];
  for (const d of depts) {
    parts.push(`make mt_sep k="dept", rel="${d.relId}"; out;`);
    parts.push(`area(id:${d.areaId})->.d; nwr.c(area.d); out ids;`);
  }
  return parts.join('\n');
}

function parseTile(json) {
  const cand = []; const inPeru = new Set(); const deptOf = new Map();
  let mode = 'cand'; let dept = null;
  for (const el of json.elements) {
    if (el.type === 'mt_sep') {
      if (el.tags?.k === 'peru') mode = 'peru';
      else { mode = 'dept'; dept = Number(el.tags?.rel); }
      continue;
    }
    const k = el.type[0] + el.id;
    if (mode === 'cand') cand.push(el);
    else if (mode === 'peru') inPeru.add(k);
    else if (!deptOf.has(k)) deptOf.set(k, dept);
  }
  return { cand, inPeru, deptOf };
}

function cacheGet(key) {
  if (args.fresh) return null;
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + '.json'), 'utf8')); } catch { return null; }
}
function cachePut(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(value));
}

const intersects = (a, b) => a.s < b.n && a.n > b.s && a.w < b.e && a.e > b.w;
function split4(bb) {
  const mlat = (bb.s + bb.n) / 2; const mlng = (bb.w + bb.e) / 2;
  return [
    { s: bb.s, w: bb.w, n: mlat, e: mlng }, { s: bb.s, w: mlng, n: mlat, e: bb.e },
    { s: mlat, w: bb.w, n: bb.n, e: mlng }, { s: mlat, w: mlng, n: bb.n, e: bb.e },
  ];
}

async function fetchDepartments() {
  const q = `[out:json][timeout:90];area(id:${PERU_AREA})->.pe;rel(area.pe)["boundary"="administrative"]["admin_level"="4"];out tags bb;`;
  const key = 'depts-' + crypto.createHash('sha1').update(q).digest('hex').slice(0, 12);
  let json = cacheGet(key);
  if (!json) { ({ json } = await runQuery(q, 'departments')); cachePut(key, json); }
  const depts = json.elements.map((e) => ({
    relId: e.id, areaId: 3600000000 + e.id, name: e.tags.name, iso: e.tags['ISO3166-2'] || '',
    bbox: { s: e.bounds.minlat, w: e.bounds.minlon, n: e.bounds.maxlat, e: e.bounds.maxlon },
  })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (depts.length !== 25) throw new Error(`Expected 25 departments (incl. Callao), got ${depts.length}`);
  // Verify the areas exist (an area filter on a missing area silently returns nothing).
  const aq = `[out:json][timeout:60];area(id:${[PERU_AREA, ...depts.map((d) => d.areaId)].join(',')});out ids;`;
  const { json: aj } = await runQuery(aq, 'area check');
  const have = new Set(aj.elements.map((e) => e.id));
  if (!have.has(PERU_AREA)) throw new Error(`Overpass area ${PERU_AREA} (Perú) missing on this endpoint`);
  for (const d of depts) d.areaOk = have.has(d.areaId);
  return depts;
}

function planTiles(depts) {
  const deptBoxes = depts.map((d) => d.bbox);
  const S = Math.floor(Math.min(...deptBoxes.map((b) => b.s)) / BASE_CELL) * BASE_CELL;
  const W = Math.floor(Math.min(...deptBoxes.map((b) => b.w)) / BASE_CELL) * BASE_CELL;
  const N = Math.max(...deptBoxes.map((b) => b.n));
  const E = Math.max(...deptBoxes.map((b) => b.e));
  const out = [];
  const refine = (c) => {
    const size = c.n - c.s;
    if (!deptBoxes.some((b) => intersects(c, b))) return; // ocean / foreign only
    if (intersects(c, FINE_ZONE) && size > FINE_CELL + 1e-9) return split4(c).forEach(refine);
    out.push(c);
  };
  for (let s = S; s < N; s += BASE_CELL) for (let w = W; w < E; w += BASE_CELL) refine({ s, w, n: s + BASE_CELL, e: w + BASE_CELL });
  return out.map((bbox) => ({ bbox, depth: 0 }));
}

function toRecord(e) {
  let lat = e.lat; let lng = e.lon;
  if (lat == null && e.center) { lat = e.center.lat; lng = e.center.lon; }
  if (lat == null) return null;
  return { type: e.type, id: e.id, lat: +lat.toFixed(7), lng: +lng.toFixed(7), tags: e.tags || {} };
}

async function scan() {
  fs.mkdirSync(SEED_DIR, { recursive: true });
  log(`Overpass scan — UA "${UA}", tile cache ${CACHE_DIR}${args.fresh ? ' (fresh)' : ''}`);
  await preflight();
  const depts = await fetchDepartments();
  const deptByRel = new Map(depts.map((d) => [d.relId, d]));
  log(`departments: ${depts.length}; areas missing: ${depts.filter((d) => !d.areaOk).map((d) => d.name).join(', ') || 'none'}`);
  let tiles = planTiles(depts);
  let partial = false;
  if (typeof args.dept === 'string') {
    const want = args.dept.split(',').map((s) => s.trim().toLowerCase());
    const sel = depts.filter((d) => want.includes(d.name.toLowerCase()) || want.includes(d.iso.toLowerCase()));
    tiles = tiles.filter((t) => sel.some((d) => intersects(t.bbox, d.bbox)));
    partial = true;
  }
  if (typeof args['test-bbox'] === 'string') { // debugging: run one tile, print stats, exit
    const [ts, tw, tn, te] = args['test-bbox'].split(',').map(Number);
    const tb = { s: ts, w: tw, n: tn, e: te };
    const { json, url, ms } = await runQuery(buildQuery(tb, depts.filter((d) => d.areaOk && intersects(tb, d.bbox))), 'test');
    const { cand, inPeru, deptOf } = parseTile(json);
    console.log(`test tile ${fmtBb(tb)}: ${cand.length} candidates, ${inPeru.size} in Peru, ${deptOf.size} with dept, ${ms} ms via ${url}`);
    process.exit(0);
  }
  if (args['print-query']) { console.log(buildQuery(tiles[0].bbox, depts.filter((d) => d.areaOk && intersects(tiles[0].bbox, d.bbox)))); process.exit(0); }
  log(`tiles planned: ${tiles.length}`);

  const byKey = new Map(); // "n123" -> record
  const deptById = {};
  const outside = new Map(); // candidates outside Peru (dropped)
  const tileLog = [];
  const failedTiles = [];
  let osmBase = null; let noCoord = 0; let i = 0;
  const queue = [...tiles];
  while (queue.length) {
    const tile = queue.shift(); i++;
    const tdepts = depts.filter((d) => d.areaOk && intersects(tile.bbox, d.bbox));
    const q = buildQuery(tile.bbox, tdepts);
    const key = 'tile-' + crypto.createHash('sha1').update(q).digest('hex').slice(0, 16);
    const label = `tile ${i} [${fmtBb(tile.bbox)}]`;
    let json = cacheGet(key); let url = 'cache'; let ms = 0;
    if (!json) {
      try {
        ({ json, url, ms } = await runQuery(q, label));
        cachePut(key, json);
        await sleep(1500); // politeness gap between queries
      } catch (e) {
        if (e.tooBig && tile.depth < MAX_SPLIT_DEPTH) {
          log(`  ↳ splitting ${label} into 4 (depth ${tile.depth + 1})`);
          queue.unshift(...split4(tile.bbox).map((b) => ({ bbox: b, depth: tile.depth + 1 })));
        } else {
          log(`  ✗ FAILED ${label}: ${e.message}`);
          failedTiles.push({ bbox: tile.bbox, error: e.message });
        }
        continue;
      }
    }
    osmBase = osmBase || json.osm3s?.timestamp_osm_base || null;
    const { cand, inPeru, deptOf } = parseTile(json);
    let added = 0; let foreign = 0;
    for (const el of cand) {
      const k = el.type[0] + el.id;
      if (!inPeru.has(k)) {
        if (!byKey.has(k) && !outside.has(k)) outside.set(k, { k, name: el.tags?.name || el.tags?.brand || '', tile: fmtBb(tile.bbox) });
        foreign++;
        continue;
      }
      outside.delete(k);
      const d = deptOf.get(k);
      if (byKey.has(k)) { if (!deptById[k] && d) deptById[k] = deptByRel.get(d)?.name; continue; }
      const r = toRecord(el);
      if (!r) { noCoord++; continue; }
      byKey.set(k, r); deptById[k] = d ? deptByRel.get(d)?.name : null; added++;
    }
    tileLog.push({ bbox: tile.bbox, depth: tile.depth, candidates: cand.length, outsidePeru: foreign, added, endpoint: url, ms });
    log(`${label}: ${cand.length} cand (${foreign} outside PE, +${added} new) via ${url === 'cache' ? 'cache' : new URL(url).host}${ms ? ' ' + ms + ' ms' : ''} | total ${byKey.size}`);
  }

  const records = [...byKey.values()].sort((a, b) => (a.type.localeCompare(b.type)) || (a.id - b.id));
  const rawPath = path.join(SEED_DIR, partial ? 'osm-raw.partial.json' : 'osm-raw.json');
  const metaPath = path.join(SEED_DIR, partial ? 'osm-scan-meta.partial.json' : 'osm-scan-meta.json');
  fs.writeFileSync(rawPath, '[\n' + records.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
  const meta = {
    generated: new Date().toISOString(),
    script: 'tools/scan-osm.mjs',
    userAgent: UA,
    osmBase,
    broadRegex: BROAD_ERE,
    qidRegex: QID_ERE,
    keys: NAME_KEYS,
    queryExclusions: EXCL,
    tiling: { baseCell: BASE_CELL, fineCell: FINE_CELL, fineZone: FINE_ZONE, maxSplitDepth: MAX_SPLIT_DEPTH },
    endpoints: Object.fromEntries([...endpointStats].map(([u, s]) => [u, { preflight: s.preflight, preflightMs: s.preflightMs, unreachable: !!s.unreachable, ok: s.ok, fail: s.fail, lastError: s.lastError }])),
    departments: depts.map((d) => ({ name: d.name, iso: d.iso, relId: d.relId, areaOk: d.areaOk, bbox: d.bbox })),
    tiles: tileLog,
    failedTiles,
    elementsWithoutCoordinates: noCoord,
    droppedOutsidePeru: [...outside.values()],
    count: records.length,
    deptById,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1) + '\n');
  log(`wrote ${rawPath} (${records.length} elements), ${metaPath}`);
  if (failedTiles.length) log(`WARNING: ${failedTiles.length} tile(s) failed — data is INCOMPLETE for ${failedTiles.map((t) => '[' + fmtBb(t.bbox) + ']').join(' ')}`);
  return { records, meta, partial };
}

// =============================================================================================
// Provisional classification + report (helps the merge stage design rules; NOT authoritative).
// =============================================================================================
const norm = (s) => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// JS versions of the broad patterns (run on accent-stripped lowercase text).
const W = '(?:^|[^a-z0-9])';
const E = '(?=[^a-z]|$)';
const BROAD_JS = {
  plazavea: /plaza[\s._-]*vea/,
  tottus: /tott?us/,
  wong: new RegExp(`${W}wong${E}`),
  metro: new RegExp(`${W}metro`),
  vivanda: /vivanda/,
  tiendas3a: new RegExp(`tiendas?[\\s._-]*(?:3|tres)[\\s._-]*a${E}|${W}3[\\s-]?a(?=[^a-z0-9]|$)`),
  mass: new RegExp(`${W}mass`),
  preciouno: /precio[\s._-]*(?:uno|1)(?=[^0-9a-z]|$)|hiper[\s-]*bodega/,
  maxiahorro: /maxi[\s._-]*ahorro/,
  dollarcity: /dol+ar[\s._-]*city/,
  makro: /makro|ma[ck]ro[\s._-]*(?:super)?[\s._-]*mayorista/,
  vega: new RegExp(`${W}vega${E}`),
  florayfauna: /flora[\s._&y-]*fauna/,
  holi: new RegExp(`${W}holi${E}`),
  tambo: new RegExp(`${W}tambo${E}|tambo\\s*(?:\\+|plus)`),
  oxxo: /oxxo/,
};
// Stricter "looks like the chain's store name" patterns (tested on name / brand, accent-stripped lowercase).
const STRICT_JS = {
  plazavea: /^(?:hiper(?:mercado)?\s+|super(?:mercado)?\s+)?plaza\s*vea\b/,
  tottus: /^(?:hiper(?:mercados?)?\s+|super(?:mercados?)?\s+)?tott?us\b/,
  wong: /^(?:supermercados?\s+|e\.?\s*)?wong\b/,
  metro: /^(?:hiper(?:mercados?)?\s+|super(?:mercados?)?\s+)?metro\b(?!\s*(?:de\s+lima|linea|\d))/,
  vivanda: /^(?:supermercados?\s+)?vivanda\b/,
  tiendas3a: /^(?:tiendas?\s*)?(?:3|tres)\s*a\b(?!\s*-?\d)/,
  mass: /^(?:tiendas?\s+|mini\s*market\s+|supermarket\s+|supermercados?\s+)?mass\b/,
  preciouno: /^(?:hiper\s*bodega\s+)?precio\s*(?:uno|1)\b|^hiper\s*bodega\b/,
  maxiahorro: /^maxi\s*ahorro\b/,
  dollarcity: /^dol+ar\s*city\b/,
  makro: /^makro\b/,
  vega: /^(?:mayorista\s+|supermercados?\s+|tiendas?\s+|market\s+)?vega\b/,
  florayfauna: /^flora\s*(?:y|&|and)?\s*fauna\b/,
  holi: /^holi\b/,
  tambo: /^tambo\b\s*(?:\+|plus|mas)?/,
  oxxo: /^oxxo\b/,
};
const QID_TO_CHAIN = Object.fromEntries(CHAINS.flatMap((c) => c.qids.map((q) => [q, c.id])));

function textsOf(t) { return NAME_KEYS.map((k) => t[k]).filter(Boolean); }
function categoryOf(t) {
  if (t.shop) return `shop=${t.shop}`;
  for (const k of ['amenity', 'railway', 'public_transport', 'tourism', 'leisure', 'office', 'healthcare', 'place', 'landuse', 'building', 'man_made', 'craft', 'historic', 'club', 'emergency', 'aeroway', 'natural', 'construction']) {
    if (t[k]) return `${k}=${t[k]}`;
  }
  return '(no main tag)';
}
function isNoiseCategory(t) {
  if (t.shop) return false;
  if (t.railway || t.public_transport || t.place || t.tourism || t.leisure || t.office || t.healthcare || t.natural || t.historic || t.craft || t.club || t.emergency || t.aeroway || t.man_made || t.power) return true;
  const a = t.amenity;
  if (a && !['marketplace', 'fuel'].includes(a)) return true; // incl. parking, bank, atm, restaurant, school, social_facility…
  if (t.landuse && !['retail', 'commercial'].includes(t.landuse)) return true;
  if (t.building && ['school', 'university', 'church', 'hospital', 'house', 'residential', 'apartments', 'train_station', 'transportation', 'public', 'industrial', 'warehouse'].includes(t.building)) return true;
  return false;
}
// shop=* values that are plausible for the tracked formats (others → "ambiguous: unusual shop type").
const SHOP_OK = new Set(['supermarket', 'convenience', 'general', 'wholesale', 'variety_store', 'department_store', 'mall', 'yes', 'hypermarket', 'discount', 'food', 'grocery', 'kiosk']);
const SHOP_OK_EXTRA = {
  dollarcity: ['gift', 'household', 'houseware', 'party', 'stationery', 'toys'],
  florayfauna: ['pet', 'garden_centre', 'doityourself', 'household', 'houseware', 'health_food', 'florist'],
  holi: ['cosmetics', 'chemist', 'beauty', 'health_food'],
};
function retailFit(t, chain) { // → 'ok' | 'odd-shop' | 'none'
  if (t.shop) return SHOP_OK.has(t.shop) || (SHOP_OK_EXTRA[chain] || []).includes(t.shop) ? 'ok' : 'odd-shop';
  if (t.amenity === 'marketplace') return 'ok';
  if (['retail', 'commercial', 'supermarket'].includes(t.building)) return 'ok';
  if (['retail', 'commercial'].includes(t.landuse)) return 'ok';
  return 'none';
}

function classify(r) {
  const t = r.tags;
  const texts = textsOf(t).map(norm);
  const name = norm(t.name || t['name:es'] || t.brand || '');
  const brand = norm(t.brand || '');
  const brandQids = (t['brand:wikidata'] || '').split(/[;,\s]+/).filter(Boolean);
  const opQids = (t['operator:wikidata'] || '').split(/[;,\s]+/).filter(Boolean);
  const hits = [];
  for (const c of CHAINS) {
    const byBrandQid = brandQids.some((q) => QID_TO_CHAIN[q] === c.id);
    const byOpQid = opQids.some((q) => QID_TO_CHAIN[q] === c.id);
    const byText = texts.some((x) => BROAD_JS[c.id].test(x));
    if (!byBrandQid && !byOpQid && !byText) continue;
    let bucket; let reason;
    const noise = isNoiseCategory(t);
    const fit = retailFit(t, c.id);
    const strictName = STRICT_JS[c.id].test(name);
    if ((byBrandQid || (brand && STRICT_JS[c.id].test(brand))) && !noise) {
      bucket = 'strong'; reason = byBrandQid ? 'brand:wikidata' : 'brand tag';
    } else if (strictName && fit === 'ok' && !noise) { bucket = 'likely'; reason = 'name + retail tag'; }
    else if (strictName && fit === 'odd-shop') { bucket = 'ambiguous'; reason = 'name matches chain pattern, but unusual shop type'; }
    else if (strictName && !noise) { bucket = 'ambiguous'; reason = 'name matches chain pattern, but no retail tag'; }
    else if (noise) { bucket = 'noise'; reason = (byBrandQid || brand) ? 'non-store feature (even though brand/QID matches)' : 'non-store feature'; }
    else if (byOpQid) { bucket = 'ambiguous'; reason = 'operator:wikidata only'; }
    else { bucket = 'ambiguous'; reason = 'broad regex match only (name does not start like the chain)'; }
    hits.push({ chain: c.id, bucket, reason });
  }
  return hits;
}

function osmLink(r) { return `https://www.openstreetmap.org/${r.type}/${r.id}`; }
function short(r) {
  const t = r.tags;
  const nm = t.name || t.brand || t.operator || t['name:es'] || t.old_name || '(no name)';
  const extra = [];
  if (t.brand && t.brand !== nm) extra.push(`brand=${t.brand}`);
  if (t.operator && t.operator !== nm) extra.push(`operator=${t.operator}`);
  if (t.old_name) extra.push(`old_name=${t.old_name}`);
  if (t['brand:wikidata']) extra.push(`brand:wikidata=${t['brand:wikidata']}`);
  const s = `${nm} — ${categoryOf(t)}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
  return s.replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
}

function buildReport(records, meta) {
  const deptOf = (r) => meta.deptById?.[r.type[0] + r.id] || '(no dept)';
  const rows = records.map((r) => ({ r, hits: classify(r), dept: deptOf(r) }));
  const L = [];
  const p = (s = '') => L.push(s);
  const bbs = (b) => (b ? `${b.s.toFixed(2)},${b.w.toFixed(2)},${b.n.toFixed(2)},${b.e.toFixed(2)}` : '');

  p('# OSM nationwide scan — provisional report');
  p();
  p(`Generated ${meta.generated} by \`tools/scan-osm.mjs\`. OSM data as of **${meta.osmBase || 'unknown'}** (Overpass \`timestamp_osm_base\`).`);
  p(`Raw candidates inside Peru: **${records.length}** unique elements (dedup by type+id) → \`tools/seed/osm-raw.json\`.`);
  p();
  p('> Candidate list built with deliberately broad regexes. The buckets below are a *provisional* heuristic to help the');
  p('> merge stage design rules — not the final classification. Data © OpenStreetMap contributors (ODbL).');
  p();
  p('## 1. How the scan ran');
  p();
  p('| Endpoint | preflight | ok queries | failed attempts | last error |');
  p('|---|---|---|---|---|');
  for (const [u, s] of Object.entries(meta.endpoints || {})) p(`| ${u} | ${s.preflight ? `OK (${s.preflightMs} ms)` : 'FAIL'} | ${s.ok} | ${s.fail} | ${(s.lastError || '').replace(/\|/g, '/').slice(0, 90)} |`);
  p();
  const tiles = meta.tiles || [];
  const fromCache = tiles.filter((t) => t.endpoint === 'cache').length;
  const tl = meta.tiling || {};
  p(`- Tiling: bbox grid of ${tl.baseCell}° cells over the departments' bounding boxes, ${tl.fineCell}° cells over Lima Metropolitana + Callao (${bbs(tl.fineZone)}); tiles that time out are split in 4 (max depth ${tl.maxSplitDepth}).`);
  p(`- Each tile: candidates by bbox, then filtered server-side by the Perú area (rel 288247) and attributed to a department area (admin_level=4 relations).`);
  p(`- Tiles run: ${tiles.length}${fromCache ? ` (${fromCache} from the local tile cache of an earlier run)` : ''}; split tiles: ${tiles.filter((t) => t.depth > 0).length}; **failed tiles: ${(meta.failedTiles || []).length}**${(meta.failedTiles || []).length ? ' → ' + meta.failedTiles.map((t) => `[${bbs(t.bbox)}] ${t.error}`).join('; ') : ''}.`);
  p(`- Candidates dropped because they are outside Peru (border tiles): ${(meta.droppedOutsidePeru || []).length}. Elements without coordinates: ${meta.elementsWithoutCoordinates ?? 0}.`);
  p(`- Departments without an Overpass area: ${(meta.departments || []).filter((d) => !d.areaOk).map((d) => d.name).join(', ') || 'none'}. Candidates in Peru but in no department area: ${rows.filter((x) => x.dept === '(no dept)').length}.`);
  p(`- Keys matched: ${(meta.keys || []).map((k) => '`' + k + '`').join(', ')} with the broad regex (case-insensitive), plus \`brand:wikidata\` / \`operator:wikidata\` ∈ known QIDs.`);
  p(`- In-query exclusions (never stores): \`${meta.queryExclusions}\`.`);
  p();
  p('Broad regex (Overpass POSIX ERE, `,i`):');
  p();
  p('```');
  p(meta.broadRegex);
  p('```');
  p();
  p('Wikidata QIDs: ' + CHAINS.map((c) => `${c.id} ${c.qids.join('/') || '—'}`).join(' · ') + '. No QID found for Flora y Fauna.');
  p();

  p('## 2. Provisional classification per chain');
  p();
  p('Buckets: **strong** = `brand:wikidata` is the chain QID or the `brand` tag matches the chain · **likely** = name matches the');
  p('chain\'s strict pattern and the element has a retail tag (shop=*, amenity=marketplace, building/landuse=retail|commercial) ·');
  p('**ambiguous** = needs a rule/human decision · **noise** = broad match on an obviously non-store feature (station, school,');
  p('place, hotel, restaurant, clinic…). One element can hit several chains.');
  p();
  p('| Chain | strong | likely | strong+likely | ambiguous | noise | total hits | node / way / rel (strong+likely) |');
  p('|---|---:|---:|---:|---:|---:|---:|---|');
  const per = {};
  for (const c of CHAINS) per[c.id] = { strong: [], likely: [], ambiguous: [], noise: [] };
  for (const row of rows) for (const h of row.hits) per[h.chain][h.bucket].push({ ...row, hit: h });
  const tot = { strong: 0, likely: 0, ambiguous: 0, noise: 0 };
  for (const c of CHAINS) {
    const x = per[c.id];
    const good = [...x.strong, ...x.likely];
    const ty = (k) => good.filter((g) => g.r.type === k).length;
    for (const b of Object.keys(tot)) tot[b] += x[b].length;
    p(`| ${c.name} (\`${c.id}\`) | ${x.strong.length} | ${x.likely.length} | **${good.length}** | ${x.ambiguous.length} | ${x.noise.length} | ${good.length + x.ambiguous.length + x.noise.length} | ${ty('node')} / ${ty('way')} / ${ty('relation')} |`);
  }
  p(`| **Total hits** | ${tot.strong} | ${tot.likely} | **${tot.strong + tot.likely}** | ${tot.ambiguous} | ${tot.noise} | ${tot.strong + tot.likely + tot.ambiguous + tot.noise} | |`);
  p();
  const multi = rows.filter((x) => x.hits.filter((h) => h.bucket === 'strong' || h.bucket === 'likely').length > 1);
  const none = rows.filter((x) => x.hits.length === 0);
  p(`Elements with strong/likely hits for **more than one chain**: ${multi.length}. Candidates with no chain hit (caught only by the parent-company/operator net or regex dialect differences): ${none.length}.`);
  p();
  p('Note: OSM often maps the same store twice (a node for the shop + a building/landuse way, or a mall polygon with the brand name). The merge stage should collapse near-duplicates of the same chain (e.g. within ~150 m, preferring the node with `shop=*`).');
  p();

  p('### Strong+likely per department');
  p();
  const deptNames = [...new Set([...(meta.departments || []).map((d) => d.name), '(no dept)'])].sort((a, b) => a.localeCompare(b, 'es'));
  const chainCols = CHAINS.filter((c) => per[c.id].strong.length + per[c.id].likely.length > 0);
  p('| Department | ' + chainCols.map((c) => c.id).join(' | ') + ' | total |');
  p('|---|' + chainCols.map(() => '---:').join('|') + '|---:|');
  const colTot = Object.fromEntries(chainCols.map((c) => [c.id, 0]));
  for (const d of deptNames) {
    let t = 0;
    const cells = chainCols.map((c) => {
      const n = [...per[c.id].strong, ...per[c.id].likely].filter((g) => g.dept === d).length;
      t += n; colTot[c.id] += n;
      return n || '·';
    });
    if (t) p(`| ${d} | ${cells.join(' | ')} | ${t} |`);
  }
  p('| **Total** | ' + chainCols.map((c) => `**${colTot[c.id]}**`).join(' | ') + ` | **${Object.values(colTot).reduce((a, b) => a + b, 0)}** |`);
  p();
  p('_Department = Overpass department area containing the element (provisional; the merge stage should use district point-in-polygon)._');
  p();

  p('### Tag profile of strong+likely matches');
  p();
  p('| Chain | main tag (count) |');
  p('|---|---|');
  for (const c of CHAINS) {
    const good = [...per[c.id].strong, ...per[c.id].likely];
    if (!good.length) { p(`| ${c.id} | — no strong/likely OSM matches — |`); continue; }
    const cnt = {};
    for (const g of good) { const k = categoryOf(g.r.tags); cnt[k] = (cnt[k] || 0) + 1; }
    p(`| ${c.id} | ${Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ')} |`);
  }
  p();

  p('### Name variants among strong+likely (top 15 per chain)');
  p();
  for (const c of CHAINS) {
    const good = [...per[c.id].strong, ...per[c.id].likely];
    if (!good.length) continue;
    const cnt = {};
    for (const g of good) { const k = g.r.tags.name || '(no name; brand=' + (g.r.tags.brand || '') + ')'; cnt[k] = (cnt[k] || 0) + 1; }
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
    p(`- **${c.id}** (${top.length} distinct): ` + top.slice(0, 15).map(([k, v]) => `\`${k.replace(/`/g, "'")}\` ×${v}`).join(', ') + (top.length > 15 ? ', …' : ''));
  }
  p();

  // ---- near-duplicates (same chain, strong+likely, < 150 m): node + building/landuse/mall polygons etc.
  const hav = (a, b) => {
    const R = 6371000; const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad; const dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  p('### Probable duplicates (same chain, strong+likely, closer than 150 m)');
  p();
  p('Clusters are built by single-linkage at 150 m. "Elements" counts every OSM element in a multi-element cluster.');
  p();
  p('| Chain | strong+likely | clusters with >1 element | elements in those clusters | after collapsing clusters |');
  p('|---|---:|---:|---:|---:|');
  const dupExamples = [];
  for (const c of CHAINS) {
    const good = [...per[c.id].strong, ...per[c.id].likely].map((g) => g.r);
    if (!good.length) continue;
    const parent = good.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < good.length; i++) for (let j = i + 1; j < good.length; j++) {
      if (Math.abs(good[i].lat - good[j].lat) < 0.002 && hav(good[i], good[j]) < 150) parent[find(i)] = find(j);
    }
    const groups = {};
    good.forEach((r, i) => (groups[find(i)] ||= []).push(r));
    const multi = Object.values(groups).filter((g) => g.length > 1);
    p(`| ${c.id} | ${good.length} | ${multi.length} | ${multi.reduce((a, g) => a + g.length, 0)} | ${Object.keys(groups).length} |`);
    for (const g of multi.slice(0, 3)) dupExamples.push(`- ${c.id}: ` + g.map((r) => `${r.type[0]}${r.id} (${categoryOf(r.tags)}${r.tags.name ? ', "' + r.tags.name.replace(/\|/g, '/') + '"' : ''})`).join(' + '));
  }
  p();
  if (dupExamples.length) { p('Examples (max 3 per chain):'); p(); dupExamples.forEach((x) => p(x)); p(); }

  p('## 3. Ambiguous / suspicious matches (input for exclusion rules)');
  p();
  p('Per chain: ambiguous candidates grouped by reason (capped at 80 rows per group), then noise summarised by category with examples.');
  p();
  for (const c of CHAINS) {
    const amb = per[c.id].ambiguous;
    const noise = per[c.id].noise;
    if (!amb.length && !noise.length) continue;
    p(`### ${c.name} (\`${c.id}\`) — ambiguous ${amb.length}, noise ${noise.length}`);
    p();
    if (amb.length) {
      const byReason = {};
      for (const a of amb) (byReason[a.hit.reason] ||= []).push(a);
      for (const [reason, list] of Object.entries(byReason)) {
        p(`**${reason}** (${list.length}):`);
        p();
        const sorted = list.sort((a, b) => (a.r.tags.name || '').localeCompare(b.r.tags.name || '', 'es'));
        for (const a of sorted.slice(0, 80)) p(`- ${short(a.r)} · ${a.dept} · [${a.r.type[0]}${a.r.id}](${osmLink(a.r)})`);
        if (sorted.length > 80) p(`- … ${sorted.length - 80} more`);
        p();
      }
    }
    if (noise.length) {
      const byCat = {};
      for (const a of noise) (byCat[categoryOf(a.r.tags)] ||= []).push(a);
      p('Noise by category: ' + Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => `${k} ×${v.length} (e.g. "${[...new Set(v.map((x) => (x.r.tags.name || '').replace(/\|/g, '/')))].slice(0, 3).join('", "')}")`).join(' · '));
      p();
    }
  }

  if (multi.length) {
    p('### Elements hitting several chains (strong/likely)');
    p();
    for (const m of multi.slice(0, 80)) p(`- ${short(m.r)} · ${m.dept} · chains: ${m.hits.filter((h) => h.bucket === 'strong' || h.bucket === 'likely').map((h) => h.chain).join(', ')} · [${m.r.type[0]}${m.r.id}](${osmLink(m.r)})`);
    if (multi.length > 80) p(`- … ${multi.length - 80} more`);
    p();
  }
  if (none.length) {
    p('### Candidates with no chain hit');
    p();
    for (const m of none.slice(0, 60)) p(`- ${short(m.r)} · ${m.dept} · [${m.r.type[0]}${m.r.id}](${osmLink(m.r)})`);
    if (none.length > 60) p(`- … ${none.length - 60} more`);
    p();
  }
  return { text: L.join('\n'), per };
}

// =============================================================================================
async function main() {
  let records; let meta; let partial = false;
  if (args['report-only']) {
    records = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'osm-raw.json'), 'utf8'));
    meta = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'osm-scan-meta.json'), 'utf8'));
  } else {
    ({ records, meta, partial } = await scan());
  }
  const { text, per } = buildReport(records, meta);
  // Optional hand-written analysis appended to the generated report (kept in tools/seed/).
  const notesPath = path.join(SEED_DIR, 'osm-scan-notes.md');
  const notes = !partial && fs.existsSync(notesPath) ? '\n' + fs.readFileSync(notesPath, 'utf8') : '';
  const reportPath = path.join(SEED_DIR, partial ? 'osm-scan-report.partial.md' : 'osm-scan-report.md');
  fs.writeFileSync(reportPath, (notes ? text.replace('## 1. How the scan ran', () => notes.trim() + '\n\n## 1. How the scan ran') : text) + '\n');
  console.log('\nProvisional classification   strong  likely  ambig  noise');
  for (const c of CHAINS) {
    const x = per[c.id];
    console.log(`  ${c.id.padEnd(26)} ${String(x.strong.length).padStart(6)} ${String(x.likely.length).padStart(7)} ${String(x.ambiguous.length).padStart(6)} ${String(x.noise.length).padStart(6)}`);
  }
  console.log(`\nReport: ${reportPath}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
