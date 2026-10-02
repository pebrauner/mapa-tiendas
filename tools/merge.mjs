#!/usr/bin/env node
/**
 * tools/merge.mjs — builds the seed store database (SPEC §3.1) from
 *   (a) the nationwide OSM scan          tools/seed/osm-raw.json         (tools/scan-osm.mjs)
 *   (b) each chain's official store list tools/seed/web/<chain>.json
 *   (c) chain metadata + OSM rules       tools/seed/chains/<chain>.json ("osm" object), tools/seed/osm-rules.json
 *                                        (cross-chain rules) — published in data/chains.js, see tools/seed/OSM-RULES.md
 *   (d) district polygons                tools/seed/districts.geojson   (+ tools/seed/pip.mjs; not in git: build it
 *                                        with `node tools/build-districts.mjs` after a fresh clone)
 *   (e) verification inputs (optional)   tools/seed/overrides.json (per-store decisions with evidence),
 *       tools/seed/housenumbers.json (OSM house numbers), tools/seed/osm-element-meta.json (OSM last-edit dates),
 *       tools/seed/merge-notes.md + verification-notes.md (hand-written report sections)
 *
 *   node tools/merge.mjs              full run; geocodes store addresses without coordinates with
 *                                     Nominatim (≤ 1 request/s, every answer cached in
 *                                     tools/seed/geocode-cache.json, so reruns make no requests)
 *   node tools/merge.mjs --offline    never call Nominatim (cache only)
 *   node tools/merge.mjs --no-chains  do not rewrite data/chains.js
 *   node tools/merge.mjs --updated=YYYY-MM-DD   value of the `updated` column (default 2026-10-01)
 *
 * Writes: data/stores.csv, data/chains.js, tools/seed/REPORT.md, tools/seed/merge-log.json,
 *         tools/seed/geocode-cache.json.   Then run `node tools/build-data.mjs` (→ data/stores.js).
 *
 * Node built-ins only. Deterministic: same inputs + same cache → byte-identical outputs.
 *
 * ── Pipeline ────────────────────────────────────────────────────────────────────────────────
 *  1. Classify OSM elements with the rules published in data/chains.js (per-chain `osm` objects from
 *     tools/seed/chains/<id>.json + cross-chain window.MT_OSM_RULES from tools/seed/osm-rules.json; schema
 *     and order of the steps: tools/seed/OSM-RULES.md; code: tools/seed/osm-classify.mjs). The merge
 *     classifies with the very content it writes to data/chains.js, so the app's OSM scan and the seed
 *     use one set of rules. A chain is decided by the NAME first (anchored, accent-
 *     folded pattern), then by the brand tag, then by brand:wikidata. Elements are dropped when they
 *     are closed (disused:/was:/… keys, shop=vacant, operational_status=closed, "cerrado" names)
 *     or not a store (transit, parking, banks/ATMs, restaurants, pharmacies, schools, social
 *     facilities, places, offices, ads… and chain-specific look-alikes: government "Tambo" centres,
 *     "Inca Garcilaso de la Vega" schools, "3A" block names, massage parlours, "Metro de Lima"…).
 *     kind = 'shop'     shop=* is one of the chain's formats
 *            'building' no shop tag but a retail/commercial building, mall part or marketplace named
 *                       like the chain (big formats only)
 *            'weak'     odd tagging (other grocery-like shop types, "Mass Ahorro", or an exact chain
 *                       name on an unrelated shop type): kept ONLY when it confirms an official store.
 *  2. Collapse same-chain OSM duplicates (node + building way, "entrada 1/2" nodes): 200 m for big
 *     formats, 40 m for small/dense formats.
 *  3. Match OSM ↔ official list per chain, one-to-one, greedy by distance / score:
 *       P1 distance ≤ matchM · P2 distance ≤ match2M · P3 same district + branch-name / street-name
 *       tokens (also for official stores without coordinates) · P4 weak OSM elements ≤ 150 m ·
 *       P5 (after geocoding) approximate position ≤ geoM in the same district, unambiguous.
 *  4. Official stores without coordinates that are still unmatched are geocoded (Nominatim,
 *     structured street+district query first, then free text, landmark/mall names). A result is
 *     accepted only if it is street-level (or neighbourhood-level as a last resort) AND falls in
 *     the official district (province/department when the source gives no district). Otherwise the
 *     store is NOT written to stores.csv and is listed in REPORT.md as "needs manual placement".
 *  5. ubigeo/district/province/department of every row come from point-in-polygon (pip.mjs;
 *     locateNearest ≤ 300 m for points just off the coast). Rows outside Peru are dropped.
 *  Status: matched → verified (source osm, OSM coordinates) · official coordinates only → verified
 *  (source web, exact) · geocoded → to_verify (approx) · OSM only → to_verify · any warning flag of
 *  the official source (may be closed, uncertain coordinates, press-only, possible duplicate…) →
 *  to_verify · OSM element of a store the chain reports as closed → closed.
 *
 * ── Verification rules (added 2026-10-01 after an independent review of the seed) ───────────
 *  · OSM elements whose description/note/fixme says they are NOT the chain are excluded.
 *  · OSM elements with a doubtful position (Ministry of Education school imports: isced:level /
 *    source=minedu; a fixme about the position) are weak and never supply coordinates: they only
 *    confirm an official store that has its own coordinates.
 *  · A weak element cannot win a name/street match (P3) while a proper shop of the same chain that
 *    is still unmatched lies within the wider match radius.
 *  · Official coordinates: a latitude/longitude that is another store's value with one digit dropped
 *    is discarded (the store is matched / geocoded as if it had none); a point > 5 km outside the
 *    stated district (unless the stated name is the province — up to 15 km — or the department that
 *    contains the point) or in another department → to_verify, approx; one coordinate identical to
 *    another store's (≥ 6 decimals) → to_verify. Official coordinates the source itself doubts, or
 *    that two stores share, are written with precision approx as well.
 *  · Geocoding: a street-level answer must name the street itself (not just the neighbourhood).
 *    House-number check: reference points on the same street in the same district (OSM house numbers,
 *    exact store rows; each must be consistent with another one) give an interpolated position; a
 *    geocoded point farther than 1 km from it (400 m when the bracketing numbers are ≤ 300 apart) is
 *    moved there; a point that sits near numbers > 1,000 away from its own, beyond the known range,
 *    is rejected (manual placement).
 *  · P5: when the source gives no district, the geocoded store may match an OSM store of the same
 *    province; when the address names a cross street ("altura", "cruce", "esq."), the radius is ×1.5.
 *  · Press records flagged as a possible duplicate of a named official entry are not separate rows:
 *    they become a note on that entry's row.
 *  · OSM-only rows of a chain whose official list is complete that sit on the address of another
 *    chain's official store (same house number, or ≤ 10 m) → closed (premises taken over).
 *  · tools/seed/overrides.json holds per-store decisions that need evidence no rule can see (links
 *    to OSM elements, positions computed from OSM street geometry, renames, statuses); each entry
 *    carries its evidence and is listed in REPORT.md ("Verification fixes").
 *
 * ── Manual placements (added 2026-10-01; SPEC §6.4) ─────────────────────────────────────────────
 *  · tools/seed/overrides.json → manualPlacements.placements: the stores that no rule could place,
 *    decided from evidence and independently re-checked (research + verdict per batch in
 *    tools/seed/manual/). Each entry names the official/press record (chain + exact name in
 *    tools/seed/web/<chain>.json) and has a verdict:
 *      accept / adjust  → lat, lng, precision, status, confidence and a Spanish note. Applied AFTER all
 *                         matching and geocoding, and only to a record that is still unplaced, so they
 *                         never change how other stores match. The row keeps the record's source (web),
 *                         official URL and id (web-<chain>-<slug>; ids of manual rows are assigned after
 *                         all other rows, so existing ids never shift). Optional rename.address.
 *      … with "link"    → the store is an OSM element already in the database: the record is matched
 *                         to it in the P0 link pass (like overrides.json links), no new row.
 *      reject           → stays in REPORT.md §4 with the verifier's reason.
 *    REPORT.md §4 lists every entry ("Colocación manual"); merge-log.json → manualPlacementsApplied.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { loadDistricts, locate, locateNearest, listDistricts, districtDistance } from './seed/pip.mjs';
import { compileOsmRules, classifyOsm } from './seed/osm-classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SEED = path.join(HERE, 'seed');
const FILES = {
  osmRaw: path.join(SEED, 'osm-raw.json'),
  osmMeta: path.join(SEED, 'osm-scan-meta.json'),
  webDir: path.join(SEED, 'web'),
  chainsDir: path.join(SEED, 'chains'),
  osmRules: path.join(SEED, 'osm-rules.json'),
  cache: path.join(SEED, 'geocode-cache.json'),
  keyUbigeos: path.join(SEED, 'key-ubigeos.json'),
  notes: path.join(SEED, 'merge-notes.md'),
  verifyNotes: path.join(SEED, 'verification-notes.md'),
  overrides: path.join(SEED, 'overrides.json'),
  houseNumbers: path.join(SEED, 'housenumbers.json'),
  osmElementMeta: path.join(SEED, 'osm-element-meta.json'),
  report: path.join(SEED, 'REPORT.md'),
  log: path.join(SEED, 'merge-log.json'),
  csv: path.join(ROOT, 'data', 'stores.csv'),
  chainsJs: path.join(ROOT, 'data', 'chains.js'),
  logosDir: path.join(ROOT, 'logos'),
};

const ARGS = process.argv.slice(2);
const OFFLINE = ARGS.includes('--offline');
const WRITE_CHAINS = !ARGS.includes('--no-chains');
const UPDATED = (ARGS.find((a) => a.startsWith('--updated=')) || '--updated=2026-10-01').split('=')[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(UPDATED)) throw new Error('--updated must be YYYY-MM-DD');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'mapa-tiendas-seed/1.0 (github.com/pebrauner/mapa-tiendas)';
const NOMINATIM_GAP_MS = 1100;

const COLUMNS = ['id', 'chain', 'name', 'address', 'district', 'province', 'department', 'ubigeo', 'lat', 'lng',
  'precision', 'source', 'source_ref', 'status', 'notes', 'updated'];
const GROUP_ORDER = ['super', 'discount', 'wholesale', 'specialty', 'convenience'];

/* ════════════════════════════════════ Chain list ═════════════════════════════════════════════
 * Tracked chains (one tools/seed/chains/<id>.json + tools/seed/web/<id>.json each), in data/chains.js order within
 * each group of GROUP_ORDER. The OSM classification rules are NOT here: they are the per-chain "osm" objects of
 * tools/seed/chains/<id>.json and the cross-chain rules of tools/seed/osm-rules.json, published in data/chains.js
 * (see "Chains & OSM rules" below and tools/seed/OSM-RULES.md).
 */
const CHAIN_IDS = ['plazavea', 'tottus', 'wong', 'metro', 'vivanda', 'tiendas3a', 'mass', 'preciouno', 'maxiahorro', 'dollarcity', 'makro', 'vega',
  'florayfauna', 'holi', 'tambo', 'oxxo'];

/* ════════════════════════════════════ Small helpers ══════════════════════════════════════════ */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const fold1 = (ch) => { const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); return f.length === 1 ? f : ch; };
const R_EARTH = 6371008.8;
function distM(a, b) {
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(x)));
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const LOWER_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'con', 'a', 'al', 'o']);
function titleCase(s) {
  return String(s).toLowerCase().split(/(\s+|-|\/|\()/).map((w, i) => {
    if (!w || /^\s+$|^[-/(]$/.test(w)) return w;
    if (i > 0 && LOWER_WORDS.has(w)) return w;
    if (/^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$/i.test(w)) return w.toUpperCase();
    if (/\d/.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
const isAllCaps = (s) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
const isAllLower = (s) => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s);
function slug(s) {
  return norm(s).replace(/&/g, ' y ').replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
}
function districtKey(s) {
  let k = norm(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const ALIAS = { 'cercado de lima': 'lima', 'cercado': 'lima', 'lima cercado': 'lima', 'surco': 'santiago de surco', 'magdalena': 'magdalena del mar',
    'carmen de la legua': 'carmen de la legua reynoso', 'sjl': 'san juan de lurigancho', 'sjm': 'san juan de miraflores', 'ves': 'villa el salvador',
    'vmt': 'villa maria del triunfo', 'smp': 'san martin de porres', 'rimac': 'rimac', 'breña': 'brena', 'callao cercado': 'callao' };
  return ALIAS[k] || k;
}
function qidsOf(v) { return String(v || '').split(/[;,\s]+/).filter(Boolean).map((q) => q.toUpperCase()); }
function osmKey(e) { return e.type[0] + e.id; }
function osmUrl(e) { return `https://www.openstreetmap.org/${e.type}/${e.id}`; }
function readJson(f) { return JSON.parse(readFileSync(f, 'utf8')); }

/** Union-find helper. */
function clusters(n, linked) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (linked(i, j)) { const a = find(i), b = find(j); if (a !== b) p[Math.max(a, b)] = Math.min(a, b); }
  const m = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); }
  return [...m.values()];
}

/* ════════════════════════════════════ Chains & OSM rules ═════════════════════════════════════ */
const CHAIN_META = {};
for (const f of readdirSync(FILES.chainsDir).filter((f) => f.endsWith('.json')).sort()) {
  const j = readJson(path.join(FILES.chainsDir, f));
  if (CHAIN_IDS.includes(j.id)) CHAIN_META[j.id] = j;
  else process.stderr.write(`merge: tools/seed/chains/${f} (${j.id}) is not in CHAIN_IDS; ignored\n`);
}
const CHAIN_ORDER = [...CHAIN_IDS].sort((a, b) => {
  const ga = GROUP_ORDER.indexOf(CHAIN_META[a]?.group), gb = GROUP_ORDER.indexOf(CHAIN_META[b]?.group);
  return ga - gb || CHAIN_IDS.indexOf(a) - CHAIN_IDS.indexOf(b);
});
for (const id of CHAIN_ORDER) if (!CHAIN_META[id]) throw new Error(`missing tools/seed/chains/${id}.json`);

/** Keys of a chain's "osm" object in data/chains.js, in output order, with their defaults (schema: tools/seed/OSM-RULES.md §2). */
const OSM_KEYS = { wikidata: [], nameRegex: '', excludeNameRegex: '', label: null, prefixRegex: '', shops: [], requireShopLike: true, dense: false,
  uniqueName: false, weakNameRegex: '', weakNameShops: [], excludeTags: [] };
function osmOf(id) {
  const o = CHAIN_META[id].osm || {};
  const unknown = Object.keys(o).filter((k) => !(k in OSM_KEYS));
  if (unknown.length) throw new Error(`tools/seed/chains/${id}.json: unknown osm key(s) ${unknown.join(', ')} (see tools/seed/OSM-RULES.md)`);
  const out = {};
  for (const [k, def] of Object.entries(OSM_KEYS)) out[k] = o[k] !== undefined ? o[k] : k === 'label' ? CHAIN_META[id].name : def;
  out.wikidata = out.wikidata.map((q) => String(q).trim().toUpperCase());
  out.excludeTags = out.excludeTags.map((x) => ({ key: x.key, valueRegex: x.valueRegex || '', why: x.why || '' }));
  return out;
}
/** window.MT_OSM_RULES: tools/seed/osm-rules.json without its "about" (the published copy points to the docs instead). */
function osmRulesOf() {
  const { about, version, ...rest } = readJson(FILES.osmRules); // eslint-disable-line no-unused-vars
  return { version, doc: 'tools/seed/OSM-RULES.md', ...rest };
}

/** data/chains.js (SPEC §3.2) + ringColor (read by js/markers.js) + OSM rules. Gaps filled here are listed in REPORT.md. */
const chainGaps = [];
function buildChainsJs() {
  const list = CHAIN_ORDER.map((id) => {
    const c = CHAIN_META[id];
    const hasBadge = existsSync(path.join(FILES.logosDir, `${id}.png`));
    const fill = (k, v, why) => { chainGaps.push(`${id}.${k}: ${why}`); return v; };
    // Official store-list pages found by the web research stage (tools/seed/web/<id>.json → sources).
    const LOCATOR_FROM_WEB = { wong: 'https://www.wong.pe/stores', metro: 'https://www.metro.pe/stores',
      preciouno: 'https://www.hiperbodegapreciouno.com.pe/nosotros/' };
    const storeLocator = c.storeLocator || (LOCATOR_FROM_WEB[id]
      ? fill('storeLocator', LOCATOR_FROM_WEB[id], `filled with the official store-list page used by the web research stage (${LOCATOR_FROM_WEB[id]})`)
      : fill('storeLocator', '', 'no public store list on the chain\'s live site; left empty'));
    // The user's reference slides label Makro "CASH & CARRY" (SPEC §1 uses the same example).
    const LEGEND_FROM_SLIDES = { makro: 'CASH & CARRY' };
    const legendName = LEGEND_FROM_SLIDES[id] && LEGEND_FROM_SLIDES[id] !== c.legendName
      ? fill('legendName', LEGEND_FROM_SLIDES[id], `"${LEGEND_FROM_SLIDES[id]}" as on the reference slides (chain JSON: "${c.legendName}")`)
      : c.legendName || c.name.toUpperCase();
    return {
      id, name: c.name, legendName, group: c.group,
      color: String(c.color).toUpperCase(), ringColor: String(c.ringColor || c.color).toUpperCase(),
      owner: c.owner || '', defaultOn: c.defaultOn !== false, website: c.website || '', storeLocator,
      osm: osmOf(id),
      logo: hasBadge ? id : null,
    };
  });
  const body = '[\n' + list.map((o) => '  ' + JSON.stringify(o)).join(',\n') + '\n]';
  const rules = osmRulesOf();
  const rulesBody = '{\n' + Object.entries(rules).map(([k, v]) => '  ' + JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}';
  return '/* mapa-tiendas — tracked chains (SPEC §3.2). Generated by tools/merge.mjs from tools/seed/chains/*.json and tools/seed/osm-rules.json.\n' +
    ' * ringColor = badge ring colour (js/markers.js); osm = per-chain OpenStreetMap rules; MT_OSM_RULES = cross-chain OSM rules.\n' +
    ' * The seed merge (tools/merge.mjs) and the in-app OSM scan classify with these same rules: schema in tools/seed/OSM-RULES.md. */\n' +
    'window.MT_CHAINS = ' + body + ';\n' +
    'window.MT_OSM_RULES = ' + rulesBody + ';\n';
}
/** Evaluate data/chains.js content like the browser does (classic script setting window.*). */
function evalChainsJs(text) {
  const sandbox = { window: {} };
  vm.runInNewContext(text, sandbox, { filename: 'data/chains.js' });
  if (!Array.isArray(sandbox.window.MT_CHAINS) || !sandbox.window.MT_OSM_RULES) throw new Error('data/chains.js: MT_CHAINS / MT_OSM_RULES missing');
  return JSON.parse(JSON.stringify({ chains: sandbox.window.MT_CHAINS, rules: sandbox.window.MT_OSM_RULES }));
}
// Build data/chains.js once, then classify with exactly what it publishes (single source of truth for the merge and the app).
const CHAINS_JS = buildChainsJs();
if (!WRITE_CHAINS && existsSync(FILES.chainsJs) && readFileSync(FILES.chainsJs, 'utf8') !== CHAINS_JS) {
  process.stderr.write('merge: --no-chains: data/chains.js on disk differs from tools/seed/chains/*.json + osm-rules.json; the merge uses the latter.\n');
}
const PUBLISHED = evalChainsJs(CHAINS_JS);
const OSMR = compileOsmRules(PUBLISHED.chains, PUBLISHED.rules);
if (OSMR.chains.map((c) => c.id).join() !== CHAIN_ORDER.join()) throw new Error('data/chains.js order differs from CHAIN_ORDER');
/** Per-chain rules in the shape the merge code below uses (re.test = nameRegex && !excludeNameRegex). */
const RULES = Object.fromEntries(OSMR.chains.map((c) => [c.id, { label: c.label, re: { test: c.isName }, prefix: c.prefix, shops: c.shops,
  building: c.building, dense: c.dense, unique: c.unique }]));
const QID = Object.fromEntries(OSMR.chains.map((c) => [c.id, c.qids]));
// Radii (metres): OSM dedupe, OSM↔official pass 1 / pass 2, geocoded (approximate) store ↔ OSM.
const RADII = OSMR.g.radii;
const radii = (c) => (RULES[c].dense ? RADII.dense : RADII.big);

/* ════════════════════════════════════ Districts ══════════════════════════════════════════════ */
// tools/seed/districts.geojson is derived (34 MB) and ignored by git: a fresh clone must build it first.
if (!existsSync(path.join(SEED, 'districts.geojson'))) {
  process.stderr.write('merge: tools/seed/districts.geojson is missing (not in git). Build it first:\n  node tools/build-districts.mjs\n' +
    'then rerun node tools/merge.mjs (see tools/seed/districts-README.md).\n');
  process.exit(1);
}
loadDistricts();
const DISTRICTS = listDistricts();
const PLACE_KEYS = new Set();
for (const d of DISTRICTS) { PLACE_KEYS.add(districtKey(d.district)); PLACE_KEYS.add(districtKey(d.province)); PLACE_KEYS.add(districtKey(d.department)); }
['cercado de lima', 'sjl', 'sjm', 'ves', 'vmt', 'smp', 'surco', 'magdalena', 'lima norte', 'lima sur', 'lima este', 'aqp', 'chosica', 'huacho'].forEach((k) => PLACE_KEYS.add(k));
function pip(lat, lng) {
  const hit = locate(lat, lng);
  if (hit) return { ...hit, offshoreM: 0 };
  const near = locateNearest(lat, lng, 300);
  return near ? { ubigeo: near.ubigeo, district: near.district, province: near.province, department: near.department, offshoreM: near.distanceM } : null;
}

/* ════════════════════════════════════ 1. Classify OSM ════════════════════════════════════════ */
const OSM_RAW = readJson(FILES.osmRaw);
const OSM_META = existsSync(FILES.osmMeta) ? readJson(FILES.osmMeta) : {};
// Rules: data/chains.js (see "Chains & OSM rules"); steps and reasons: tools/seed/osm-classify.mjs, tools/seed/OSM-RULES.md §3.
const classify = (e) => classifyOsm(e.tags, OSMR);

const classified = [];
for (const e of OSM_RAW) {
  if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng)) continue;
  const c = classify(e);
  classified.push({ e, ...c, key: osmKey(e) });
}

/* ════════════════════════════════════ 2. OSM dedupe ══════════════════════════════════════════ */
function osmAddress(t) {
  if (t['addr:full']) return t['addr:full'];
  const street = t['addr:street'] || t['addr:place'] || '';
  const hn = t['addr:housenumber'] || '';
  return [street, hn].filter(Boolean).join(' ').trim();
}
function repScore(x, chain) {
  const t = x.e.tags;
  return (x.kind === 'shop' ? 1000 : 0) + (QID[chain].some((q) => qidsOf(t['brand:wikidata']).includes(q)) ? 100 : 0) +
    (x.e.type === 'node' ? 50 : x.e.type === 'way' ? 20 : 0) + Math.min(40, Object.keys(t).length) - (OSMR.g.entrance.test(norm(t.name)) ? 30 : 0);
}
const osmStores = {}; // chain → [{rep, members[], lat, lng, tags(merged), kind, pipd}]
const osmWeak = {};   // chain → [{e, reason, ...}]
for (const c of CHAIN_ORDER) {
  const list = classified.filter((x) => x.chain === c && (x.kind === 'shop' || x.kind === 'building'))
    .sort((a, b) => cmpStr(a.key, b.key));
  const r = radii(c);
  const groups = clusters(list.length, (i, j) => {
    const d = distM(list[i].e, list[j].e);
    return d <= r.dedupe || ((list[i].kind === 'building' || list[j].kind === 'building' || list[i].e.type !== list[j].e.type) && d <= r.link && r === RADII.big);
  });
  osmStores[c] = groups.map((g) => {
    const members = g.map((i) => list[i]).sort((a, b) => repScore(b, c) - repScore(a, c) || cmpStr(a.key, b.key));
    const rep = members[0];
    const tags = { ...rep.e.tags };
    for (const m of members.slice(1)) for (const [k, v] of Object.entries(m.e.tags)) if (/^addr:|^branch$|^name:es$|^operator$/.test(k) && !tags[k]) tags[k] = v;
    return { chain: c, rep, members, key: rep.key, lat: rep.e.lat, lng: rep.e.lng, tags, kind: rep.kind, pipd: pip(rep.e.lat, rep.e.lng) };
  }).sort((a, b) => cmpStr(a.key, b.key));
  // Weak elements next to an accepted store of the same chain are just duplicates of it.
  for (const x of classified.filter((x) => x.chain === c && x.kind === 'weak')) {
    const host = osmStores[c].map((o) => ({ o, d: distM(o, x.e) })).filter((y) => y.d <= r.link).sort((a, b) => a.d - b.d)[0];
    if (host) { host.o.members.push(x); x.absorbed = host.o.key; }
  }
  osmWeak[c] = classified.filter((x) => x.chain === c && x.kind === 'weak' && !x.absorbed).map((x) => ({ chain: c, rep: x, members: [x], key: x.key, lat: x.e.lat, lng: x.e.lng,
    tags: x.e.tags, kind: 'weak', noCoords: !!x.noCoords, reason: x.reason, pipd: pip(x.e.lat, x.e.lng) })).sort((a, b) => cmpStr(a.key, b.key));
}

/* ════════════════════════════════════ 3. Official lists ══════════════════════════════════════ */
const WEB = {};       // chain → {file meta, stores[]}
const CLOSED_REFS = {}; // chain → [{name, lat, lng, reason, source}]
for (const c of CHAIN_ORDER) {
  const f = path.join(FILES.webDir, `${c}.json`);
  if (!existsSync(f)) { WEB[c] = { meta: { complete: false, missing: true }, stores: [] }; continue; }
  const j = readJson(f);
  const stores = j.stores.map((s, idx) => ({
    chain: c, idx, name: s.name || '', address: (s.address || '').replace(/\s+/g, ' ').trim(), district: s.district || '', province: s.province || '',
    department: s.department || '', lat: Number.isFinite(s.lat) ? s.lat : null, lng: Number.isFinite(s.lng) ? s.lng : null,
    url: s.url || j.sources?.[0] || CHAIN_META[c].storeLocator || '', secondary: !!s.secondary, rawNotes: s.notes || '', flags: [],
  }));
  WEB[c] = { meta: { complete: !!j.complete, retrieved: j.retrieved, reportedCount: j.reportedCount, sources: j.sources || [] }, stores };
  CLOSED_REFS[c] = (j.excluded || []).filter((x) => /closed|cierre|cerr/i.test(x.reason || '') && Number.isFinite(x.lat));
}

/** Warning flags of an official record → status to_verify (hard = even when OSM confirms it). */
function addFlags(s) {
  const n = s.rawNotes;
  const add = (code, text, es, hard = false) => { if (!s.flags.some((f) => f.code === code)) s.flags.push({ code, text, es, hard }); };
  if (/ALL pickup\/master-data configs are inactive/i.test(n)) add('maybe-closed', 'official store configuration inactive: may be closed', 'la tienda figura inactiva en el sistema oficial: podría estar cerrada', true);
  if (/verify position|coordinate check/i.test(n)) add('coords-uncertain', 'official coordinates uncertain', 'coordenadas oficiales dudosas');
  if (/QA: locator text is inconsistent/i.test(n)) add('coords-uncertain', 'official address and coordinates disagree', 'la dirección y las coordenadas oficiales no coinciden');
  if (/verify both exist/i.test(n)) add('possible-duplicate', 'possible duplicate entry in the official list', 'posible registro duplicado en la lista oficial');
  if (/possible duplicate/i.test(n)) add('possible-duplicate', 'possible duplicate of another official entry', 'posible duplicado de otro registro de la lista oficial');
  if (/not enabled in the official system/i.test(n)) add('ordering-off', 'online ordering disabled in the official system (new or closed store)', 'venta en línea desactivada en el sistema oficial (tienda nueva o cerrada)');
  if (/opening\/operating status not confirmed|opening report was not found/i.test(n)) add('opening-unconfirmed', 'opening not confirmed', 'apertura no confirmada');
  if (/opening may be seasonal/i.test(n)) add('seasonal', 'may be seasonal', 'podría ser de temporada');
  if (s.chain === 'vivanda') add('stale-source', 'from an inactive legacy official configuration', 'proviene de una configuración oficial antigua e inactiva');
  if (s.secondary) add('press', 'reported by the press, not in the official list', 'reportada por la prensa; no figura en la lista oficial');
}
for (const c of CHAIN_ORDER) {
  const ss = WEB[c].stores;
  ss.forEach(addFlags);
  // Copy-pasted coordinates: two different addresses at (almost) the same point.
  for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) {
    const a = ss[i], b = ss[j];
    if (a.lat == null || b.lat == null) continue;
    if (distM(a, b) < 15 && norm(a.address) !== norm(b.address)) {
      a.flags.push({ code: 'coords-shared', text: `official coordinates nearly identical to "${b.name}"`, es: `coordenadas oficiales casi idénticas a las de "${b.name}"` });
      b.flags.push({ code: 'coords-shared', text: `official coordinates nearly identical to "${a.name}"`, es: `coordenadas oficiales casi idénticas a las de "${a.name}"` });
    }
  }
}

/* Corrupted official coordinates: one coordinate is another store's value (same chain), the other one is that
 * store's value with one digit dropped (e.g. -77.072062 vs -77.0072062) → discarded; one coordinate merely
 * identical (≥ 6 decimals) while the other differs → to_verify (one of the two is probably a copy). */
// Flags that make official coordinates doubtful (→ precision approx). 'coords-copied' (one coordinate identical to another
// store's) only sets to_verify: usually one of the two is wrong, but the rule cannot tell which.
const DOUBTFUL_COORDS = new Set(['coords-uncertain', 'coords-shared', 'coords-corrupt', 'district-far', 'dept-mismatch']);
const coordCheckLog = [];
{
  const decimals = (v) => (String(v).split('.')[1] || '').length;
  const dropsOneDigit = (long, short) => {
    const L = String(long), S = String(short);
    if (L.length !== S.length + 1) return false;
    for (let i = 0; i < L.length; i++) if (/\d/.test(L[i]) && L.slice(0, i) + L.slice(i + 1) === S) return true;
    return false;
  };
  for (const c of CHAIN_ORDER) {
    const ss = WEB[c].stores.filter((s) => s.lat != null);
    for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) {
      const a = ss[i], b = ss[j];
      for (const [same, other] of [['lat', 'lng'], ['lng', 'lat']]) {
        if (a[same] !== b[same] || decimals(a[same]) < 6 || Math.abs(a[other] - b[other]) < 0.0005) continue;
        const bad = dropsOneDigit(b[other], a[other]) ? a : dropsOneDigit(a[other], b[other]) ? b : null;
        if (bad) {
          const good = bad === a ? b : a;
          bad.discarded = { lat: bad.lat, lng: bad.lng };
          bad.flags.push({ code: 'coords-corrupt', text: `official coordinates (${bad.lat}, ${bad.lng}) discarded: ${same === 'lat' ? 'latitude' : 'longitude'} identical to "${good.name}" and ${other === 'lat' ? 'latitude' : 'longitude'} = its value ${good[other]} with one digit dropped`,
            es: `coordenadas oficiales (${bad.lat}, ${bad.lng}) descartadas: la ${same === 'lat' ? 'latitud' : 'longitud'} es idéntica a la de "${good.name}" y la ${other === 'lat' ? 'latitud' : 'longitud'} es su valor ${good[other]} con un dígito menos` });
          coordCheckLog.push({ chain: c, name: bad.name, rule: 'digit dropped', other: good.name, was: [bad.lat, bad.lng] });
          bad.lat = null; bad.lng = null;
        } else {
          for (const [x, y] of [[a, b], [b, a]]) if (!x.flags.some((f) => f.code === 'coords-copied')) x.flags.push({ code: 'coords-copied', text: `official ${same === 'lat' ? 'latitude' : 'longitude'} ${x[same]} identical to "${y.name}" (copy-paste?)`,
            es: `${same === 'lat' ? 'latitud' : 'longitud'} oficial ${x[same]} idéntica a la de "${y.name}" (¿copiada?)` });
          coordCheckLog.push({ chain: c, name: a.name, rule: `${same} identical`, other: b.name });
        }
      }
    }
  }
  // Official point far from the district the source names (or in another department).
  for (const c of CHAIN_ORDER) for (const s of WEB[c].stores) {
    if (s.lat == null || !s.district) continue;
    const pd = pip(s.lat, s.lng);
    if (!pd || districtKey(s.district) === districtKey(pd.district)) continue;
    const k = districtKey(s.district);
    const withArea = (p) => districtKey(p.district) === k && (!s.province || districtKey(p.province) === districtKey(s.province)) &&
      (!s.department || districtKey(p.department) === districtKey(s.department));
    let d = districtDistance(s.lat, s.lng, withArea);
    // No district of that name in the stated department: the name is a locality/neighbourhood there (e.g. "El Milagro",
    // "San Joaquín"), so no check, unless the point lies in another department (then compare with any district of that name).
    const otherDept = s.department && districtKey(s.department) !== districtKey(pd.department);
    if (d === null && (!s.department || otherDept)) d = districtDistance(s.lat, s.lng, (p) => districtKey(p.district) === k);
    const cityUse = k === districtKey(pd.department) || (k === districtKey(pd.province) && (d === null || d <= 15000));
    const deptMismatch = s.department && PLACE_KEYS.has(districtKey(s.department)) && districtKey(s.department) !== districtKey(pd.department) && (d === null || d > 5000);
    if (deptMismatch) {
      s.flags.push({ code: 'dept-mismatch', text: `official coordinates fall in ${pd.district} (${pd.department}) but the official list says ${s.district}, ${s.department}`,
        es: `las coordenadas oficiales caen en ${pd.district} (${pd.department}), pero la lista oficial indica ${s.district}, ${s.department}` });
      coordCheckLog.push({ chain: c, name: s.name, rule: 'department mismatch', km: d === null ? null : Math.round(d / 100) / 10 });
    } else if (d !== null && d > 5000 && !cityUse) {
      s.flags.push({ code: 'district-far', text: `official coordinates are ${(d / 1000).toFixed(1)} km outside the stated district ${s.district}`,
        es: `las coordenadas oficiales caen a ${(d / 1000).toFixed(1)} km del distrito indicado (${s.district})` });
      coordCheckLog.push({ chain: c, name: s.name, rule: 'far from stated district', km: Math.round(d / 100) / 10 });
    }
  }
  // Press records that the gather stage flagged as a possible duplicate of a named official entry.
  for (const c of CHAIN_ORDER) for (const s of WEB[c].stores) {
    const m = s.secondary && /possible duplicate of official entry (.+?)(?:\s+\(|;|$)/.exec(s.rawNotes);
    if (!m) continue;
    const target = WEB[c].stores.find((x) => !x.secondary && norm(x.name) === norm(m[1]));
    if (target) s.dupOf = target;
  }
}

/* ════════════════════════════════════ Overrides (tools/seed/overrides.json) ═════════════════════ */
const OVERRIDES = existsSync(FILES.overrides) ? readJson(FILES.overrides) : { links: [], official: [], osm: [] };
const overrideLog = []; // {kind, chain, target, ok, result, evidence}
function findOfficial(o) {
  const list = (WEB[o.chain]?.stores || []).filter((s) => s.name === o.official && (!o.address || s.address === o.address));
  return list.length === 1 ? list[0] : null;
}
for (const o of OVERRIDES.official || []) {
  const s = findOfficial(o);
  const log = { kind: 'official', chain: o.chain, target: o.official, ok: !!s, actions: [], evidence: o.evidence || '' };
  overrideLog.push(log);
  if (!s) { log.result = 'official record not found (name changed in tools/seed/web?)'; continue; }
  s.override = o;
  if (o.rename) {
    s.listText = { name: s.name, address: s.address };
    if (o.rename.name) s.name = o.rename.name;
    if (o.rename.address != null) s.address = o.rename.address;
    log.actions.push(`renamed to "${s.name}"`);
  }
  if (o.set) {
    if (s.lat != null) s.discarded = s.discarded || { lat: s.lat, lng: s.lng };
    s.lat = null; s.lng = null;
    const pd = pip(o.set.lat, o.set.lng);
    s.geo = { ok: true, lat: o.set.lat, lng: o.set.lng, level: 'override', label: o.set.how, pipd: pd, override: true };
    log.actions.push(`placed at ${o.set.lat}, ${o.set.lng} (${pd ? pd.district : 'outside Peru'})`);
  }
  if (o.geocode) {
    if (s.lat != null) s.discarded = s.discarded || { lat: s.lat, lng: s.lng };
    s.lat = null; s.lng = null;
    s.geoQueriesOverride = o.geocode.queries;
    log.actions.push(`official coordinates discarded; geocoded with ${o.geocode.queries.map((q) => JSON.stringify(q)).join(' / ')}`);
  }
  if (o.manual) { s.lat = null; s.lng = null; s.geo = null; s.forceManual = o.manual; log.actions.push('sent to manual placement'); }
  if (o.status) { s.forceStatus = o.status; log.actions.push(`status ${o.status}`); }
  if (o.note) s.extraNote = o.note;
}
const OSM_OVERRIDE = Object.fromEntries((OVERRIDES.osm || []).map((o) => [o.osm, o]));
/* Manual placements (overrides.json → manualPlacements; see the header). Links join the P0 link pass below; the other
 * entries are applied after P5. manualLog: {kind: 'link'|'place'|'reject', entry, ok, actions[], result, record}. */
const MANUAL = OVERRIDES.manualPlacements || { placements: [] };
const MANUAL_PLACEMENTS = MANUAL.placements || [];
const MANUAL_ON = MANUAL.verifiedOn || UPDATED;
const manualLog = [];
const CONF_ES = { high: 'alta', medium: 'media', low: 'baja' };
{
  const seen = new Set();
  for (const e of MANUAL_PLACEMENTS) {
    const k = `${e.chain}#${e.official}#${e.address || ''}`;
    if (seen.has(k)) throw new Error(`overrides.json manualPlacements: "${e.official}" (${e.chain}) appears twice`);
    seen.add(k);
    if (!['accept', 'adjust', 'reject'].includes(e.verdict)) throw new Error(`overrides.json manualPlacements: "${e.official}": verdict must be accept, adjust or reject`);
    if (e.verdict !== 'reject' && (!Number.isFinite(e.lat) || !Number.isFinite(e.lng) || !['exact', 'approx'].includes(e.precision) ||
      !['verified', 'to_verify'].includes(e.status) || !e.note)) throw new Error(`overrides.json manualPlacements: "${e.official}": lat, lng, precision, status and note are required`);
  }
}
/** Notes-column text of a manual placement (Spanish): "<lead> el <date> a partir de evidencia verificada (…; confianza …): <note>". */
function manualNoteEs(e, lead) {
  let n = String(e.note || '').trim().replace(/\.$/, '');
  // The note's first word is lower-cased after the colon when it is an ordinary word (not a brand or a name).
  n = n.replace(/^(Aproximada|Aproximado|Ubicada|Ubicación|Nodo|Dentro|Edificio|Es|Centro|Punto)\b/, (w) => w.toLocaleLowerCase('es'));
  return `${lead} el ${MANUAL_ON} a partir de evidencia verificada (tools/seed/overrides.json, manualPlacements` +
    `${e.confidence ? `; confianza ${CONF_ES[e.confidence] || e.confidence}` : ''}): ${n}`;
}
/** "closed 2024-08-27 (detail)" → "cerró el 2024-08-27 (detail)"; a `reason_es` in the web JSON wins. */
function closedReasonEs(x) {
  if (x.reason_es) return x.reason_es;
  const m = /^closed\s+(\d{4}-\d{2}-\d{2})(.*)$/i.exec(x.reason || '');
  return m ? `cerró el ${m[1]}${m[2]}` : `(${x.reason})`;
}

/* ════════════════════════════════════ Names & tokens ═════════════════════════════════════════ */
function tamboBranch(raw) {
  let s = String(raw).replace(/^\s*tambo\s*\+?\s*-?\s*/i, '');
  let segs = s.split(/\s*-\s+|\s+-\s*/).map((x) => x.trim()).filter(Boolean);
  while (segs.length > 1 && PLACE_KEYS.has(districtKey(segs[segs.length - 1]))) segs.pop();
  let toks = segs.join(' ').split(/[-\s]+/).filter((w) => w && !/^c\d+$/i.test(w) && !/^tda$/i.test(w));
  while (toks.length > 1 && PLACE_KEYS.has(districtKey(toks[toks.length - 1]))) toks.pop();
  return titleCase(toks.join(' '));
}
/** "Chain label + branch" display name from a raw store name. */
function displayName(chain, raw) {
  const R = RULES[chain];
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return R.label;
  if (chain === 'tambo' && isAllCaps(s)) { const b = tamboBranch(s); return b ? `${R.label} ${b}` : R.label; }
  const chars = Array.from(s), folded = chars.map(fold1).join('');
  let rest = s;
  if (folded.length === chars.length) {
    const m = R.prefix.exec(folded);
    if (m && m.index === 0) rest = chars.slice(m[0].length).join('');
    else if (!R.re.test(folded)) rest = s; // name without the chain (e.g. an operator branch) → keep all as branch
  }
  rest = rest.replace(/^[\s\-–—:|,.+&]+/, '').trim();
  for (let k = 0; k < 3; k++) {
    rest = rest.replace(/^(?:supermercados?|hipermercados?|supermarket|minimarket|mini market|tiendas?|cencosud|hiper\s*bodega|de)\b[\s\-–,]*/i, '')
      .replace(/[\s\-–,]*\b(?:supermercados?|hipermercados?|supermarket|cencosud|s\.?a\.?c?\.?)$/i, '').trim();
  }
  rest = rest.replace(/\b(?:entrada|ingreso|puerta)\s*\d*\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (isAllCaps(rest) || isAllLower(rest)) rest = titleCase(rest);
  return rest ? `${R.label} ${rest}` : R.label;
}
const STOP = new Set(['av', 'ave', 'avenida', 'jr', 'jiron', 'calle', 'cl', 'ca', 'psje', 'pje', 'pasaje', 'prolong', 'prol', 'prolongacion', 'carretera', 'carr', 'urb',
  'urbanizacion', 'mz', 'mza', 'lt', 'lte', 'lote', 'int', 'interior', 'nro', 'num', 'sn', 'cruce', 'con', 'esquina', 'esq', 'altura', 'cdra', 'cuadra', 'del', 'las',
  'los', 'and', 'frente', 'espalda', 'lado', 'ref', 'referencia', 'mall', 'centro', 'comercial', 'tienda', 'tiendas', 'supermercado', 'supermercados', 'hipermercado',
  'hipermercados', 'express', 'hiper', 'super', 'local', 'sector', 'etapa', 'sub', 'zona', 'peru', 'este', 'oeste', 'norte', 'sur', 'san', 'santa', 'nuevo', 'nueva',
  'grupo', 'falabella', 'cencosud', 'intercorp', 'peruanos', 'sac', 'aahh', 'asoc', 'vivienda', 'programa', 'parque', 'plaza', 'real', 'open', 'block', 'piso',
  'nivel', 'sotano', 'tda', 'ex', 'via', 'km', 'panamericana', 'antigua', 'cerca', 'mercado', 'mcdo', 'puerta', 'entrada', 'ingreso', 'lima', 'cercado']);
function tokensOf(text, extraStop) {
  return new Set(norm(text).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w) && !(extraStop && extraStop.has(w))));
}
function chainStop(c) { return tokensOf(`${RULES[c].label} ${CHAIN_META[c].name} ${c === 'preciouno' ? 'hiperbodega bodega uno precio' : ''} ${c === 'tottus' ? 'totus' : ''}`); }
const CHAIN_STOP = Object.fromEntries(CHAIN_ORDER.map((c) => [c, chainStop(c)]));
function streetCore(s) {
  const a = norm(String(s || '').replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = a.replace(/^(?:cruce\s+)?(?:avenida|av|ave|jiron|jr|calle|cl|ca|pasaje|psje|pje|prolongacion|prolong|prol|carretera|carr|malecon|ovalo|alameda)\s+/, '')
    .split(/\s(?:\d|con|cruce|esquina|mz|lt|urb|cdra|cuadra|altura|int|nro|n)\b/)[0].trim();
  return m.length >= 5 ? m : '';
}
function webTokens(s) {
  const placeStop = new Set([...tokensOf(s.district), ...tokensOf(s.province), ...tokensOf(s.department)]);
  const nameToks = tokensOf(s.name, CHAIN_STOP[s.chain]);
  const addrToks = tokensOf(s.address.split(/,|\s-\s/).slice(0, 2).join(' '), new Set([...CHAIN_STOP[s.chain], ...placeStop]));
  return new Set([...nameToks, ...addrToks]);
}
function osmTokens(o) {
  const t = o.tags;
  return tokensOf([t.name, t['name:es'], t.official_name, t.branch, t.operator, t['addr:street']].filter(Boolean).join(' '), CHAIN_STOP[o.chain]);
}
function matchScore(s, o) {
  const wt = webTokens(s), ot = osmTokens(o);
  let n = 0; for (const w of wt) if (ot.has(w)) n++;
  const sc = streetCore(s.address.split(/,|\s-\s/)[0]), oc = streetCore(o.tags['addr:street'] || '');
  const street = sc && oc && (sc.includes(oc) || oc.includes(sc));
  return n + (street ? 3 : 0);
}
function sameArea(s, pipd) {
  if (!pipd) return false;
  // District names repeat across provinces (e.g. Pueblo Nuevo), so the province must agree too when stated.
  if (s.district) return districtKey(s.district) === districtKey(pipd.district) && (!s.province || districtKey(s.province) === districtKey(pipd.province));
  if (s.province) return districtKey(s.province) === districtKey(pipd.province);
  if (s.department) return districtKey(s.department) === districtKey(pipd.department);
  return false;
}

/* ════════════════════════════════════ 4. Matching ════════════════════════════════════════════ */
const matches = []; // {chain, web, osm, pass, d, score}
const matchedWeb = new Set(), matchedOsm = new Set();
const wkey = (s) => `${s.chain}#${s.idx}`;
function assign(cands, pass) {
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.d - b.d || cmpStr(a.osm.key, b.osm.key) || a.web.idx - b.web.idx);
  for (const x of cands) {
    if (matchedWeb.has(wkey(x.web)) || matchedOsm.has(x.osm.key)) continue;
    matchedWeb.add(wkey(x.web)); matchedOsm.add(x.osm.key);
    matches.push({ chain: x.web.chain, web: x.web, osm: x.osm, pass, d: Math.round(x.d), score: x.score ?? null });
  }
}
const coordOf = (s) => (s.lat != null ? s : s.geo ? s.geo : null);
// Records that never take part in matching: sent to manual placement by an override, or press duplicates of a named official entry.
const skipWeb = (s) => matchedWeb.has(wkey(s)) || !!s.forceManual || !!s.dupOf;
function distancePass(c, pool, maxD, pass, onlyOfficial = true) {
  const cands = [];
  for (const s of WEB[c].stores) {
    if (skipWeb(s)) continue;
    const p = onlyOfficial ? (s.lat != null ? s : null) : coordOf(s);
    if (!p) continue;
    for (const o of pool) { if (matchedOsm.has(o.key)) continue; const d = distM(p, o); if (d <= maxD) cands.push({ web: s, osm: o, d }); }
  }
  assign(cands, pass);
}
function tokenPass(c, pool, pass) {
  const cands = [];
  for (const s of WEB[c].stores) {
    if (skipWeb(s)) continue;
    const scored = [];
    for (const o of pool) {
      if (matchedOsm.has(o.key)) continue;
      const score = matchScore(s, o);
      if (score < 1) continue;
      if (s.lat != null) {
        // Official coordinates exist but are farther than P2: same district nearby, or (big formats) same
        // province with a street-name match (official coordinates are sometimes plainly wrong).
        const d = distM(s, o), sp = pip(s.lat, s.lng);
        if (!o.pipd || !sp) continue;
        const sameD = districtKey(o.pipd.district) === districtKey(sp.district), sameP = districtKey(o.pipd.province) === districtKey(sp.province);
        const ok = RULES[c].dense ? sameD && d <= 600 : (sameD && d <= 3000) || (sameP && d <= 8000 && score >= 3);
        if (!ok) continue;
      } else if (!sameArea(s, o.pipd)) continue;
      scored.push({ web: s, osm: o, score, d: s.lat != null ? distM(s, o) : 0 });
    }
    scored.sort((a, b) => b.score - a.score || a.d - b.d);
    if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) cands.push(scored[0]);
  }
  assign(cands, pass);
}
/** Big formats: the only unmatched official store of an area ↔ the only unmatched OSM store there. */
function uniqueAreaPass(c, pool, pass) {
  // Geocoded stores are matched by position (P5) and only count as rivals. An official store with a known
  // district (official point, or stated district) is matched when it is the only unmatched official store of
  // that district and OSM has exactly one unmatched store there. A store known only by province needs the same
  // uniqueness at province level. Province-only stores do not block district-level matches.
  const webLeft = WEB[c].stores.filter((s) => !skipWeb(s));
  const osmLeft = pool.filter((o) => !matchedOsm.has(o.key) && o.pipd);
  const pt = (s) => (s.lat != null ? pip(s.lat, s.lng) : s.geo ? s.geo.pipd : null);
  const provOf = (s) => { const p = pt(s); return p ? districtKey(p.province) : s.province ? districtKey(s.province) : null; };
  const distOf = (s) => { const p = pt(s); return p ? districtKey(p.district) + '|' + districtKey(p.province) : s.district ? districtKey(s.district) + '|' + (provOf(s) || '*') : null; };
  const oDist = (o) => districtKey(o.pipd.district) + '|' + districtKey(o.pipd.province);
  const sameD = (a, b) => { const [ad, ap] = a.split('|'), [bd, bp] = b.split('|'); return ad === bd && (ap === '*' || bp === '*' || ap === bp); };
  const cands = [];
  for (const s of webLeft) {
    if (s.geo) continue;
    const d = distOf(s), pv = provOf(s);
    let os, rivals;
    if (d) {
      os = osmLeft.filter((o) => sameD(d, oDist(o)) && (s.lat == null || distM(s, o) <= 3000));
      rivals = webLeft.filter((w) => w !== s && distOf(w) && sameD(distOf(w), d));
    } else if (pv) {
      os = osmLeft.filter((o) => districtKey(o.pipd.province) === pv);
      rivals = webLeft.filter((w) => w !== s && provOf(w) === pv);
    } else continue;
    if (os.length !== 1 || rivals.length) continue;
    cands.push({ web: s, osm: os[0], d: s.lat != null ? distM(s, os[0]) : 0, score: 0 });
  }
  assign(cands, pass);
}
// P0: links from tools/seed/overrides.json (official store ↔ OSM element, with evidence), then the manual placements
// whose store is an OSM element already in the database (manualPlacements entries with "link").
const MANUAL_LINKS = MANUAL_PLACEMENTS.filter((e) => e.link && e.verdict !== 'reject')
  .map((e) => ({ chain: e.chain, official: e.official, address: e.address, osm: e.link, evidence: e.verification || '', manual: e }));
for (const L of [...(OVERRIDES.links || []), ...MANUAL_LINKS]) {
  const s = findOfficial(L);
  const key = String(L.osm).replace(/^osm-/, '');
  const o = s && [...osmStores[L.chain], ...osmWeak[L.chain]].find((x) => x.key === key || x.members.some((m) => m.key === key));
  const log = L.manual ? { kind: 'link', entry: L.manual, ok: false, actions: [], record: s }
    : { kind: 'link', chain: L.chain, target: `${L.official} ↔ osm-${key}`, ok: false, actions: [], evidence: L.evidence || '' };
  (L.manual ? manualLog : overrideLog).push(log);
  if (!s) { log.result = 'official record not found'; continue; }
  if (!o) { log.result = `OSM element ${key} is not an accepted ${L.chain} element in this scan`; continue; }
  if (matchedWeb.has(wkey(s)) || matchedOsm.has(o.key)) { log.result = 'already matched'; continue; }
  s.link = L;
  if (L.manual) { s.manualPlacement = L.manual; if (L.manual.status) s.forceStatus = L.manual.status; }
  assign([{ web: s, osm: o, d: s.lat != null ? distM(s, o) : 0, score: null }], 'P0 override link');
  log.ok = true; log.actions.push(`matched to osm-${o.key}`);
}
for (const c of CHAIN_ORDER) {
  const r = radii(c);
  const pool = osmStores[c];
  distancePass(c, pool, r.match, 'P1 distance');
  distancePass(c, pool, r.match2, 'P2 distance (wider)');
  // A weak element (odd tagging) may not win a name/street match while a proper shop of the chain that is still
  // unmatched lies within the wider match radius (e.g. a stale "Tottus" on shop=carpet 370 m from the branded node).
  const weakForP3 = osmWeak[c].filter((o) => !o.noCoords && (RULES[c].unique || o.reason?.startsWith('ambiguous') || o.reason?.startsWith('shop=')) &&
    !pool.some((p) => p.kind === 'shop' && !matchedOsm.has(p.key) && distM(p, o) <= r.match2));
  tokenPass(c, [...pool, ...weakForP3], 'P3 name/street');
  distancePass(c, osmWeak[c].filter((o) => !o.noCoords), 150, 'P4 weak OSM element');
  // Elements with a doubtful position only confirm a store (its official coordinates are kept), so the wider radius applies.
  distancePass(c, osmWeak[c].filter((o) => o.noCoords), r.match2, 'P4 weak OSM element (position not used)');
  if (!RULES[c].dense) uniqueAreaPass(c, pool, 'P3 only one in area');
}

/* ════════════════════════════════════ 5. Geocoding ═══════════════════════════════════════════ */
const cache = existsSync(FILES.cache) ? readJson(FILES.cache) : { about: '', entries: {} };
cache.about = 'Nominatim answers cached by tools/merge.mjs (key = sorted query parameters). Data © OpenStreetMap contributors, ODbL. Delete an entry to re-query it.';
let lastRequest = 0, requests = 0, cacheDirty = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function saveCache() {
  const entries = Object.fromEntries(Object.keys(cache.entries).sort().map((k) => [k, cache.entries[k]]));
  writeFileSync(FILES.cache, JSON.stringify({ about: cache.about, entries }, null, 1) + '\n');
  cacheDirty = false;
}
async function nominatim(params) {
  const key = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  if (cache.entries[key]) return cache.entries[key].results;
  if (OFFLINE) return null;
  const u = new URL(NOMINATIM);
  for (const [k, v] of Object.entries({ ...params, format: 'jsonv2', countrycodes: 'pe', addressdetails: '1', limit: '5', 'accept-language': 'es' })) u.searchParams.set(k, v);
  for (const wait of [0, 5000, 15000, 45000]) {
    if (wait) await sleep(wait);
    const gap = lastRequest + NOMINATIM_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastRequest = Date.now(); requests++;
    try {
      const res = await fetch(u, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { process.stderr.write(`  Nominatim HTTP ${res.status}, retrying\n`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const results = j.map((x) => ({ lat: +x.lat, lng: +x.lon, category: x.category, type: x.type, addresstype: x.addresstype, place_rank: x.place_rank,
        name: x.name || '', display_name: x.display_name }));
      cache.entries[key] = { params, retrieved: new Date().toISOString().slice(0, 10), results };
      cacheDirty = true;
      if (requests % 10 === 0) saveCache();
      return results;
    } catch (err) { process.stderr.write(`  Nominatim error: ${err.message}\n`); }
  }
  return null;
}
const ABBR = [[/\bAv\.?\s+/gi, 'Avenida '], [/\bAvda\.?\s+/gi, 'Avenida '], [/\bJr\.?\s+/gi, 'Jirón '], [/\bCl\.?\s+/gi, 'Calle '], [/\bCa\.\s+/gi, 'Calle '],
  [/\bPsje\.?\s+|\bPje\.?\s+|\bPsj\.?\s+/gi, 'Pasaje '], [/\bProlong\.?\s+|\bProl\.\s+/gi, 'Prolongación '], [/\bCarr\.?\s+/gi, 'Carretera '],
  [/\bMcal\.?\s+/gi, 'Mariscal '], [/\bGral\.?\s+/gi, 'General '], [/\bCmdte\.?\s+/gi, 'Comandante '], [/\bSta\.?\s+/gi, 'Santa ']];
const STREET_WORD = /\b(?:av|avenida|avda|jr|jiron|jirón|calle|cl|ca|psje|pje|pasaje|prolong|prolongacion|prolongación|carretera|carr|malecon|malecón|ovalo|óvalo|alameda|via|vía)\b/i;
function streetPart(address) {
  let a = String(address || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  a = a.replace(/^(?:cruce|esquina|esq\.?)\s+(?:de\s+)?/i, '');
  const parts = a.split(/\s*[,;]\s*|\s+[-–]\s+/).map((x) => x.trim()).filter(Boolean);
  let p = parts.find((x) => STREET_WORD.test(x)) || parts[0] || '';
  const sw = p.match(STREET_WORD);
  if (sw && sw.index > 0) p = p.slice(sw.index);                     // "URB. X AV. Y 720" → "AV. Y 720"
  p = p.replace(/(\d+)\s+(?:av|avda|avenida|jr|jiron|jirón|calle|cl|ca|psje|pje|pasaje|prolong|prolongacion|prolongación|carretera|carr)\b.*$/i, '$1') // "Av. X 102 Av. Y 593" → first street
    .replace(/\s+(?:con|cruce\s+con|esquina\s+con|esq\.?\s+con)\s+.*$/i, '')
    .replace(/\s+(?:altura|alt\.|a\s+\d+\s+cuadras?|a\s+media\s+cuadra|ref\.?|referencia|frente|espalda|al\s+costado|al\s+lado|por|entre|dentro)\b.*$/i, '')
    .replace(/\b(?:int|interior|tda|local|of|dpto|block|piso)\.?\s*[\w-]+.*$/i, '')
    .replace(/\b(?:mz|mza|manzana)\.?\s*[\w-]+/gi, ' ').replace(/\b(?:lt|lte|lote|sub\s*lote|sublt)\.?\s*[\w-]+/gi, ' ')
    .replace(/\b(?:n\.?\s*[°º]\.?|nro\.?|num\.?|no\.?(?=\s*\d))\s*|#\s*/gi, '').replace(/\bs\/n\b/gi, ' ').replace(/\b(?:cdra|cuadra)\.?\s*\d+/gi, ' ')
    .replace(/(\d+)\s*[-/]\s*\d+.*$/, '$1').replace(/\s+/g, ' ').replace(/[\s.,;:-]+$/, '').trim();
  for (const [re, rep] of ABBR) p = p.replace(re, rep);
  return p.replace(/^(?:urb|urbanización|urbanizacion)\.?\s+.*$/i, '').trim();
}
const LANDMARK = /\b(?:C\.\s?C\.\s*|Centro Comercial\s+)?((?:Mall|Real Plaza|Plaza|Megaplaza|Mega Plaza|Open Plaza|Estación|Estacion)\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]*(?:\s+(?:de\s+|del\s+)?[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]*){0,3})/;
const LANDMARK2 = /\b((?:Jockey|Mega|Mall|Open|Real)\s+Plaza)\b/; // "Tottus Jockey Plaza"
function landmarkOf(s) {
  const m = s.address.match(LANDMARK) || s.name.match(LANDMARK) || s.address.match(LANDMARK2) || s.name.match(LANDMARK2);
  if (!m) return '';
  const lm = m[1].trim();
  return /^(?:Plaza)\s+(?:de\s+)?Armas/i.test(lm) ? '' : lm;
}
function geoQueries(s) {
  const area = s.district || s.province;
  const st = streetPart(s.address);
  const q = [...(s.geoQueriesOverride || [])];
  const lm = landmarkOf(s);
  if (lm) q.push({ q: `${lm}, ${area || s.department}, Perú` });
  if (st && s.district) q.push({ street: st, city: s.district, country: 'Perú' });
  if (st) q.push({ q: [st, s.district, s.province, 'Perú'].filter(Boolean).join(', ') });
  const raw = s.address.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (raw && norm(raw) !== norm(st)) q.push({ q: [raw, area, 'Perú'].filter(Boolean).join(', ') });
  const seen = new Set();
  return q.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
const geoLevel = (r) => (r.place_rank >= 30 ? 'house' : r.place_rank >= 26 ? 'street' : r.place_rank >= 21 && !['suburb', 'city', 'town', 'village', 'municipality', 'county', 'state', 'region', 'province', 'district'].includes(r.addresstype) ? 'neighbourhood' : null);
// Words that say nothing about WHICH street/place it is.
const GEO_STOP = new Set(['avenida', 'av', 'jiron', 'jr', 'calle', 'cl', 'ca', 'pasaje', 'psje', 'pje', 'prolongacion', 'prolong', 'carretera', 'carr', 'via', 'malecon',
  'alameda', 'ovalo', 'del', 'las', 'los', 'urbanizacion', 'urb', 'general', 'mariscal', 'san', 'santa', 'norte', 'sur', 'este', 'oeste', 'centro',
  'comercial', 'estacion', 'linea', 'sector', 'grupo', 'etapa', 'zona', 'lote', 'manzana', 'asentamiento', 'humano', 'asociacion', 'vivienda']);
const geoTokens = (txt) => new Set(norm(txt).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GEO_STOP.has(w)));
/** Does the Nominatim result name the street / landmark / neighbourhood that was asked for? */
function geoNameOk(r, lvl, s) {
  const lead = r.display_name.split(',').slice(0, 3).join(' ');
  // A street-level answer must name the street itself ("Pasaje 16, Agrupación Pachacámac" is not "Pasaje Pachacámac").
  const got = geoTokens(lvl === 'street' && r.name ? r.name : `${r.name} ${lead}`);
  const asked = lvl === 'neighbourhood' ? geoTokens(s.address.replace(/\([^)]*\)/g, ' ')) : geoTokens(`${streetPart(s.address)} ${landmarkOf(s)}`);
  const own = geoTokens(`${s.district} ${s.province} ${s.department}`); // "… - Lurín" must not match any street in Lurín
  for (const w of asked) if (got.has(w) && !(lvl === 'neighbourhood' && own.has(w))) return true;
  return false;
}
async function geocode(s) {
  const tried = [];
  let fallback = null, ambiguous = null, missed = false;
  for (const params of geoQueries(s)) {
    const res = await nominatim(params);
    tried.push({ params, n: res ? res.length : null });
    if (!res) { missed = true; continue; }
    const cands = [];
    for (const r of res) {
      // A query given by tools/seed/overrides.json names a neighbourhood on purpose: a quarter (rank 20) counts there.
      const lvl = geoLevel(r) || ((s.geoQueriesOverride || []).includes(params) && ['quarter', 'neighbourhood'].includes(r.addresstype) ? 'neighbourhood' : null);
      if (!lvl || !geoNameOk(r, lvl, s)) continue;
      const pd = pip(r.lat, r.lng);
      if (!sameArea(s, pd)) continue;
      cands.push({ lat: round6(r.lat), lng: round6(r.lng), level: lvl === 'neighbourhood' ? 'neighbourhood' : lvl, what: `${r.category}=${r.type}`,
        label: r.display_name.split(',').slice(0, 3).join(',').trim(), params, pipd: pd });
    }
    if (!cands.length) continue;
    if (!s.district) {
      // The source names no district: accept an exact (house/POI) hit, or a street that exists in ONE district only.
      const house = cands.find((x) => x.level === 'house');
      if (house) return { ok: true, ...house, tried };
      const streets = cands.filter((x) => x.level === 'street');
      const ds = [...new Set(streets.map((x) => x.pipd.district))];
      if (ds.length === 1) return { ok: true, ...streets[0], tried, note: 'la fuente no indica el distrito; la calle existe en un solo distrito' };
      if (ds.length > 1) { ambiguous = ds; continue; }
      if (!fallback) fallback = cands[0];
      continue;
    }
    const best = cands.find((x) => x.level !== 'neighbourhood');
    if (best) return { ok: true, ...best, tried };
    if (!fallback) fallback = cands[0];
  }
  if (fallback && (s.district || !ambiguous)) return { ok: true, ...fallback, tried };
  return { ok: false, tried, offline: OFFLINE && missed, failed: !OFFLINE && missed, ambiguous };
}

const geoLog = [];
const toGeocode = [];
for (const c of CHAIN_ORDER) for (const s of WEB[c].stores) if (s.lat == null && !s.geo && !skipWeb(s)) toGeocode.push(s);
if (ARGS.includes('--plan-geocode')) {
  const NL = String.fromCharCode(10);
  for (const s of toGeocode) console.log(`${s.chain} | ${s.name} | ${s.address} | ${s.district}/${s.province}` + NL + geoQueries(s).map((q) => '    ' + JSON.stringify(q)).join(NL));
  process.exit(0);
}
if (toGeocode.length) process.stderr.write(`Geocoding ${toGeocode.length} official stores without coordinates${OFFLINE ? ' (offline: cache only)' : ''}…\n`);
let gi = 0;
for (const s of toGeocode) {
  gi++;
  const g = await geocode(s);
  s.geo = g.ok ? g : null;
  s.geoFail = g.ok ? null : g;
  geoLog.push({ chain: s.chain, name: s.name, address: s.address, district: s.district, ok: g.ok, level: g.level || null, lat: g.lat ?? null, lng: g.lng ?? null,
    found: g.label || null, queries: g.tried.map((t) => t.params) });
  if (gi % 10 === 0 || gi === toGeocode.length) process.stderr.write(`  ${gi}/${toGeocode.length} (requests so far: ${requests})\n`);
}
if (cacheDirty || !existsSync(FILES.cache)) saveCache();

/* House-number check of geocoded positions. Reference points: OSM house numbers fetched for the streets that were
 * checked (tools/seed/housenumbers.json), OSM chain elements with addr:street + addr:housenumber, official stores
 * with (undoubted) official coordinates, and official↔OSM matches (official address, OSM position). */
// "Prolongación X" is a different street from "X" (numbering restarts), so it stays in the key.
const STREET_TYPE = /^(?:avenida|av|ave|avda|jiron|jr|calle|cl|ca|pasaje|psje|pje|carretera|carr|malecon|alameda|ovalo)\b\s*/;
function streetKeyOf(street) {
  let k = norm(String(street || '').replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) k = k.replace(STREET_TYPE, '');
  return k.replace(/^(?:(?:de|del|la|las|el|los)\s+)+/, '').replace(/z/g, 's').trim();
}
const sameStreet = (a, b) => a === b || ((a.startsWith(b + ' ') || b.startsWith(a + ' ')) && Math.min(a.split(' ').length, b.split(' ').length) >= 2);
function addrNumber(address) {
  const m = /^(.*\D)\s+(\d{1,5})\s*[a-z]?$/i.exec(streetPart(address));
  if (!m) return null;
  const key = streetKeyOf(m[1]);
  return key.length >= 4 && +m[2] > 0 ? { key, num: +m[2] } : null;
}
const hnRefs = [];
{
  const addRef = (key, num, lat, lng, src, srcEs = src) => {
    if (!key || !(num > 0) || !Number.isFinite(lat)) return;
    const pd = pip(lat, lng);
    if (pd) hnRefs.push({ key, num, lat, lng, src, srcEs, district: districtKey(pd.district) + '|' + districtKey(pd.province) });
  };
  if (existsSync(FILES.houseNumbers)) for (const e of readJson(FILES.houseNumbers).elements) addRef(streetKeyOf(e.street), parseInt(e.housenumber, 10), e.lat, e.lng, `OSM ${e.ref}`);
  for (const x of classified) if (x.chain && (x.kind === 'shop' || x.kind === 'building') && x.e.tags['addr:street'] && x.e.tags['addr:housenumber'])
    addRef(streetKeyOf(x.e.tags['addr:street']), parseInt(x.e.tags['addr:housenumber'], 10), x.e.lat, x.e.lng, `OSM ${x.key}`);
  for (const c of CHAIN_ORDER) for (const s of WEB[c].stores) {
    if (s.lat == null || s.flags.some((f) => DOUBTFUL_COORDS.has(f.code))) continue;
    const a = addrNumber(s.address); if (a) addRef(a.key, a.num, s.lat, s.lng, `${s.name} (official coordinates)`, `${s.name} (coordenadas oficiales)`);
  }
  for (const m of matches) {
    if (m.pass.includes('only one in area')) continue;
    const a = addrNumber(m.web.address); if (a) addRef(a.key, a.num, m.osm.lat, m.osm.lng, `${m.web.name} (osm-${m.osm.key})`);
  }
}
const hnLog = [];
function houseNumberCheck(s) {
  const a = addrNumber(s.address);
  if (!a || !s.geo || s.geo.override) return;
  const dk = districtKey(s.geo.pipd.district) + '|' + districtKey(s.geo.pipd.province);
  // Two reference points are consistent when their distance fits their number gap (about 0.5–3 m per number: Lima
  // streets number ~100 per block); a reference consistent with no other one (a typo such as "Nro. 12632" for 1632,
  // or another street of that name) is dropped.
  const plausible = (p, q) => { const dn = Math.abs(p.num - q.num), d = distM(p, q); return d <= Math.min(4000, 3 * dn + 500) && d >= 0.5 * dn - 400; };
  const cand = hnRefs.filter((r) => r.district === dk && sameStreet(r.key, a.key));
  const refs = cand.filter((r) => cand.some((q) => q !== r && Math.abs(q.num - r.num) >= 50 && plausible(r, q)));
  if (refs.length < 2) return;
  const G = s.geo, n = a.num;
  const lows = refs.filter((r) => r.num <= n).sort((x, y) => y.num - x.num), highs = refs.filter((r) => r.num >= n).sort((x, y) => x.num - y.num);
  let E = null, how = '', howEs = '', tight = false;
  if (lows.length && highs.length && plausible(lows[0], highs[0])) {
    tight = highs[0].num - lows[0].num <= 300;
    const lo = lows[0], hi = highs[0], t = hi.num === lo.num ? 0 : (n - lo.num) / (hi.num - lo.num);
    E = { lat: lo.lat + t * (hi.lat - lo.lat), lng: lo.lng + t * (hi.lng - lo.lng) };
    how = lo.num === hi.num ? `at #${lo.num} (${lo.src})` : `interpolated between #${lo.num} (${lo.src}) and #${hi.num} (${hi.src})`;
    howEs = lo.num === hi.num ? `en el n.º ${lo.num} (${lo.srcEs})` : `interpolada entre el n.º ${lo.num} (${lo.srcEs}) y el n.º ${hi.num} (${hi.srcEs})`;
  } else {
    const side = lows.length ? lows : highs;
    const near = side[0], second = side.find((r) => Math.abs(r.num - near.num) >= 50);
    if (near && Math.abs(n - near.num) <= 300) {
      if (second && plausible(near, second)) {
        const t = (n - near.num) / (near.num - second.num);
        E = { lat: near.lat + t * (near.lat - second.lat), lng: near.lng + t * (near.lng - second.lng) };
        how = `extrapolated from #${near.num} (${near.src}) and #${second.num} (${second.src})`;
        howEs = `extrapolada a partir del n.º ${near.num} (${near.srcEs}) y el n.º ${second.num} (${second.srcEs})`;
      }
    }
  }
  if (E) {
    // Tolerance: 1 km, or 400 m when E is interpolated between two numbers ≤ 300 apart (then E itself is good to ~100 m).
    const d = distM(G, E);
    if (d <= (tight ? 400 : 1000)) return;
    const pd = pip(E.lat, E.lng);
    if (!pd) return;
    hnLog.push({ chain: s.chain, name: s.name, action: 'moved', fromLat: G.lat, fromLng: G.lng, lat: round6(E.lat), lng: round6(E.lng), movedM: Math.round(d), how });
    s.geo = { ...G, lat: round6(E.lat), lng: round6(E.lng), pipd: pd, level: 'interpolated',
      hnNote: `control de numeración: el punto de calle que dio Nominatim (${G.label}) quedaba a ${(d / 1000).toFixed(1)} km del n.º ${n}; posición ${howEs} de la misma calle` };
    return;
  }
  const nums = refs.map((r) => r.num), min = Math.min(...nums), max = Math.max(...nums);
  if (n <= max + 1000 && n >= min - 1000) return;
  const g = refs.map((r) => ({ r, d: distM(G, r) })).sort((x, y) => x.d - y.d)[0];
  if (g.d > 600 || Math.abs(g.r.num - n) <= 1000) return;
  const why = `the geocoded street point (${G.label}) lies ${Math.round(g.d)} m from #${g.r.num} of the same street, but the store is at #${n}, beyond the known house numbers (#${min}–#${max})`;
  hnLog.push({ chain: s.chain, name: s.name, action: 'rejected', fromLat: G.lat, fromLng: G.lng, why });
  s.geoFail = { ok: false, tried: G.tried || [], rejected: why };
  s.geo = null;
}
for (const s of toGeocode) if (s.geo) houseNumberCheck(s);

// P5: geocoded (approximate) official stores ↔ remaining OSM stores: same district (same province when the source
// names no district), unambiguous; radius ×1.5 when the address names a cross street (the geocoder found the street,
// the store sits at the named crossing).
const CROSS_STREET = /\b(?:altura|alt\.|cruce|esq\.?|esquina)\b/i;
for (const c of CHAIN_ORDER) {
  const r = radii(c);
  const cands = [];
  for (const s of WEB[c].stores) {
    if (!s.geo || matchedWeb.has(wkey(s))) continue;
    const sameZone = (o) => (s.district ? districtKey(o.pipd.district) === districtKey(s.geo.pipd.district) : districtKey(o.pipd.province) === districtKey(s.geo.pipd.province));
    const maxD = r.geo * (CROSS_STREET.test(s.address) ? 1.5 : 1);
    const near = osmStores[c].filter((o) => !matchedOsm.has(o.key) && o.pipd && sameZone(o))
      .map((o) => ({ o, d: distM(s.geo, o) })).filter((x) => x.d <= maxD).sort((a, b) => a.d - b.d);
    if (!near.length) continue;
    if (near.length > 1 && near[1].d < 1.5 * near[0].d) continue; // ambiguous
    cands.push({ web: s, osm: near[0].o, d: near[0].d });
  }
  assign(cands, 'P5 geocoded position');
  // Big formats again: geocoding gave district-less official stores a district.
  if (!RULES[c].dense) uniqueAreaPass(c, osmStores[c], 'P5 only one in area (after geocoding)');
}

// Manual placements (overrides.json → manualPlacements, entries without "link"): applied now, after every matching and
// geocoding pass, so they cannot change how any other store matches; only to records that are still unplaced.
for (const e of MANUAL_PLACEMENTS) {
  if (e.link && e.verdict !== 'reject') continue; // done in the P0 link pass
  const s = findOfficial(e);
  const log = { kind: e.verdict === 'reject' ? 'reject' : 'place', entry: e, ok: false, actions: [], record: s };
  manualLog.push(log);
  if (!s) { log.result = 'official record not found (name changed in tools/seed/web?)'; continue; }
  const m = matches.find((x) => x.web === s);
  if (m) { log.result = `not needed: the rules matched it to osm-${m.osm.key}`; continue; }
  if (s.dupOf) { log.result = `not applied: press duplicate of "${s.dupOf.name}"`; continue; }
  if (s.lat != null) { log.result = 'not applied: the official record has coordinates now'; continue; }
  if (s.geo) { log.result = `not needed: placed by ${s.geo.override ? 'an overrides.json "official" entry' : 'geocoding'}`; continue; }
  if (e.verdict === 'reject') { s.manualReject = e; log.ok = true; log.actions.push('not placed: stays in §4'); continue; }
  const pd = pip(e.lat, e.lng);
  if (!pd) { log.result = 'not applied: the point is outside Peru'; continue; }
  if (e.rename) {
    s.listText = s.listText || { name: s.name, address: s.address };
    if (e.rename.name) s.name = e.rename.name;
    if (e.rename.address != null) s.address = e.rename.address;
    log.actions.push(`address "${s.address}"`);
  }
  s.geo = { ok: true, lat: e.lat, lng: e.lng, level: 'manual', label: e.note, pipd: pd, override: true, manual: e };
  s.geoFail = null;
  s.manualPlacement = e;
  if (e.status) s.forceStatus = e.status;
  log.ok = true; log.actions.push(`placed at ${e.lat}, ${e.lng} (${pd.district})`);
}

/* ════════════════════════════════════ 6. Rows ════════════════════════════════════════════════ */
const rows = [];
const dropped = { outside: [], weak: [], manual: [] };
const manualHintByOsm = {}; // osm-id → names of official stores that could not be placed nearby
/* Row notes (notes column) are Spanish: the audience is a Peruvian analyst team. REPORT.md stays English. */
function flagsText(s, matched) {
  return s.flags.filter((f) => !(matched && f.code === 'coords-uncertain')).map((f) => f.es);
}
function officialDistrictNote(s, pd) {
  if (!s.district || !pd) return null;
  // A press record (s.secondary) is not on the official list: its district is the article's.
  return districtKey(s.district) === districtKey(pd.district) ? null : `distrito según ${s.secondary ? 'la prensa' : 'la lista oficial'}: ${s.district}`;
}
/** Notes every row of an official record carries (overrides, renames, press duplicates merged into it). */
function officialExtraNotes(s) {
  const n = [];
  if (s.listText) n.push(`texto en la lista oficial: "${s.listText.name}", "${s.listText.address}"`);
  if (s.extraNote) n.push(s.extraNote);
  for (const p of s.pressDupNotes || []) n.push(p);
  return n;
}
const statusOf = (s, base) => s.forceStatus || base;
const mapLinkOf = (s) => (/(https:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps)\/[^\s"'),;]+)/.exec(s.rawNotes || '') || [])[1] || '';
// Press records merged into the official entry they probably duplicate.
const MONTH_ES = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo', June: 'junio', July: 'julio', August: 'agosto',
  September: 'setiembre', October: 'octubre', November: 'noviembre', December: 'diciembre' };
for (const c of CHAIN_ORDER) for (const s of WEB[c].stores) if (s.dupOf) {
  const m = /opening reported for ([A-Z][a-z]+) (\d{4})/.exec(s.rawNotes);
  const month = m ? `${MONTH_ES[m[1]] || m[1]} de ${m[2]}` : '';
  (s.dupOf.pressDupNotes ||= []).push(`la prensa también reportó "${displayName(c, s.name)}" (${s.address}${month ? ', apertura en ' + month : ''}; ${s.url}): probablemente es esta misma tienda, por eso no va como fila aparte`);
}
/** Why an OSM element's position is not used (tools/seed/osm-classify.mjs doubtfulPosition), in Spanish. */
function doubtEs(d) {
  if (!d) return 'posición dudosa en OSM';
  const v = String(d.value ?? '').slice(0, 80);
  return d.code === 'school-import' ? `posición dudosa en OSM: ${d.key}=${v}, colegio importado del Minedu y reetiquetado como tienda`
    : d.code === 'school-source' ? `posición dudosa en OSM: source=${v}, importación de colegios`
      : `posición dudosa en OSM: ${d.key}="${v}"`;
}
function pushRow(r, pd, extraNotes) {
  const notes = [...(r.notes || []), ...(extraNotes || [])].filter(Boolean);
  rows.push({ ...r, district: pd.district, province: pd.province, department: pd.department, ubigeo: pd.ubigeo, lat: round6(r.lat), lng: round6(r.lng),
    notes: [...new Set(notes)].join('; '), updated: UPDATED });
}
function bestOsmName(o) {
  const t = o.tags;
  const cands = [t.name, t['name:es'], t.official_name, t.branch ? `${RULES[o.chain].label} ${t.branch}` : null,
    RULES[o.chain].re.test(norm(t.operator)) ? t.operator : null].filter(Boolean).map((n) => displayName(o.chain, n));
  return cands.sort((a, b) => b.length - a.length || cmpStr(a, b))[0] || RULES[o.chain].label;
}
// Matched
for (const m of matches) {
  const { web: s, osm: o } = m;
  const pd = pip(o.lat, o.lng);
  if (!pd) { dropped.outside.push({ chain: s.chain, name: s.name, ref: o.key }); continue; }
  const hard = s.flags.some((f) => f.hard);
  if (o.noCoords && s.lat != null) {
    // The OSM element confirms the store but its position is doubtful: keep the official coordinates.
    const opd = pip(s.lat, s.lng);
    if (opd) {
      const doubtful = s.flags.some((f) => DOUBTFUL_COORDS.has(f.code));
      pushRow({ id: null, chain: s.chain, name: displayName(s.chain, s.name), address: s.address, lat: s.lat, lng: s.lng, precision: doubtful ? 'approx' : 'exact', source: 'web',
        source_ref: s.url, status: statusOf(s, hard || s.flags.length ? 'to_verify' : 'verified'),
        notes: ['de la lista oficial (coordenadas oficiales)', `confirmada por el elemento OSM ${o.key} a ${m.d} m, cuya posición no se usa (${doubtEs(o.rep.doubt)})`, ...flagsText(s, false), officialDistrictNote(s, opd), ...officialExtraNotes(s)], _web: s }, opd);
      m.row = rows[rows.length - 1];
      continue;
    }
  }
  const extra = [];
  if (m.pass.startsWith('P0')) extra.push(s.link.manual ? manualNoteEs(s.link.manual, 'emparejada a mano con este elemento OSM')
    : `emparejada con este elemento OSM en tools/seed/overrides.json (${s.link.why || 'ver «Verification fixes» en tools/seed/REPORT.md'})`);
  if (o.members.length > 1) extra.push(`también mapeada en OSM como ${o.members.slice(1).map((x) => x.key).join(', ')}`);
  if (m.pass.startsWith('P2') || (m.pass.startsWith('P3') && s.lat != null)) extra.push(`coordenadas oficiales a ${m.d} m`);
  if (s.lat == null) {
    const how = m.pass.startsWith('P0') ? ''
      : m.pass.startsWith('P3 name') ? 'emparejada por el nombre de la sede o de la calle'
      : m.pass.includes('only one in area') ? `emparejada por ser la única tienda ${RULES[s.chain].label} de ${s.district || (s.geo && s.geo.pipd.district) || s.province} en la lista oficial y en OSM`
      : m.pass.startsWith('P5 geocoded') ? `emparejada a ${m.d} m de su dirección geocodificada` : `emparejada (${m.pass})`;
    extra.push(`la lista oficial no trae coordenadas${how ? '; ' + how : ''}`);
  }
  pushRow({
    id: `osm-${o.key}`, chain: s.chain, name: displayName(s.chain, s.name) || bestOsmName(o), address: s.address || osmAddress(o.tags), lat: o.lat, lng: o.lng,
    precision: 'exact', source: 'osm', source_ref: o.key, status: statusOf(s, hard ? 'to_verify' : 'verified'),
    notes: ['también en la lista oficial' + (norm(bestOsmName(o)) !== norm(RULES[s.chain].label) && norm(displayName(s.chain, s.name)) !== norm(bestOsmName(o)) ? ` (nombre en OSM: ${o.tags.name || o.tags['name:es'] || '—'})` : ''),
      ...flagsText(s, true), officialDistrictNote(s, pd), ...officialExtraNotes(s)], _matched: true,
  }, pd, extra);
  m.row = rows[rows.length - 1];
}
// Official-only
for (const c of CHAIN_ORDER) for (const s of WEB[c].stores) {
  if (matchedWeb.has(wkey(s)) || s.dupOf) continue;
  const name = displayName(c, s.name);
  if (!s.forceManual && (s.lat != null || s.geo)) {
    const p = s.lat != null ? s : s.geo;
    const pd = pip(p.lat, p.lng);
    if (!pd) { dropped.outside.push({ chain: c, name: s.name, ref: s.url }); continue; }
    const geocoded = s.lat == null;
    const LEVEL_ES = { house: 'número', street: 'calle', neighbourhood: 'barrio' };
    const manual = geocoded && s.geo.manual ? s.geo.manual : null;
    const notes = !geocoded ? ['solo en la lista oficial (coordenadas oficiales)']
      : manual ? [manualNoteEs(manual, 'colocada a mano')]
      : s.geo.override ? [`ubicada a mano (tools/seed/overrides.json): ${s.geo.label}`]
      : s.geo.level === 'interpolated' ? [s.geo.hnNote, s.geo.note]
      : [`geocodificada a partir de la dirección oficial (Nominatim, a nivel de ${LEVEL_ES[s.geo.level] || s.geo.level}: ${s.geo.label})`, s.geo.note];
    const doubtful = !geocoded && s.flags.some((f) => DOUBTFUL_COORDS.has(f.code));
    // A manual placement carries the verifier's precision and status (status via s.forceStatus).
    pushRow({ id: null, chain: c, name, address: s.address, lat: p.lat, lng: p.lng, precision: manual ? manual.precision : geocoded || doubtful ? 'approx' : 'exact', source: 'web',
      source_ref: s.url, status: statusOf(s, geocoded || s.flags.length ? 'to_verify' : 'verified'),
      notes: [...notes, ...flagsText(s, false), officialDistrictNote(s, pd), ...officialExtraNotes(s)], _web: s, _manual: manual }, pd);
  } else {
    // Unmatched OSM stores of the same chain in the same district (province when no district): likely candidates.
    // (no district: the districts where the street exists when geocoding found several, else the province if it has ≤ 3)
    const amb = s.geoFail?.ambiguous ? new Set(s.geoFail.ambiguous.map(districtKey)) : null;
    let hints = osmStores[c].filter((o) => !matchedOsm.has(o.key) && o.pipd && (s.district ? sameArea(s, o.pipd)
      : amb ? amb.has(districtKey(o.pipd.district)) && sameArea(s, o.pipd) : s.province ? sameArea(s, o.pipd) : false)).map((o) => `osm-${o.key}`);
    if (!s.district && !amb && hints.length > 3) hints = [];
    // A verifier already searched for this store (manualPlacements reject): the automatic guess no longer applies.
    if (s.manualReject) hints = [];
    for (const h of hints) (manualHintByOsm[h] ||= []).push(name);
    const why = s.forceManual ? s.forceManual : s.geoFail?.rejected ? `geocoding rejected by the house-number check: ${s.geoFail.rejected}`
      : s.geoFail?.offline ? 'not geocoded (offline run, no cached answer)' : s.geoFail?.failed ? 'Nominatim did not answer every query (rerun to retry)'
      : s.geoFail?.ambiguous ? `the source gives no district and the street exists in several (${s.geoFail.ambiguous.join(', ')})`
      : s.district ? 'no geocoding result naming this street inside the stated district' : 'no geocoding result naming this street in the stated province';
    dropped.manual.push({ chain: c, name, address: s.address, district: s.district, province: s.province, department: s.department, url: s.url,
      flags: s.flags.map((f) => f.text), why, osmCandidates: hints, mapLink: mapLinkOf(s), notes: officialExtraNotes(s),
      checked: s.manualReject ? { on: MANUAL_ON, batch: s.manualReject.batch, reason: s.manualReject.verification || '' } : null });
  }
}
// OSM-only
const OSM_ELEMENT_META = existsSync(FILES.osmElementMeta) ? readJson(FILES.osmElementMeta) : { elements: {} };
// Official stores of OTHER chains with trusted coordinates (to spot OSM-only rows on premises another chain now occupies).
const officialPoints = CHAIN_ORDER.flatMap((c) => WEB[c].stores.filter((s) => s.lat != null && !s.dupOf && !s.flags.some((f) => DOUBTFUL_COORDS.has(f.code))));
const osmOnlyLog = [];
for (const c of CHAIN_ORDER) {
  const complete = WEB[c].meta.complete;
  for (const o of osmStores[c]) {
    if (matchedOsm.has(o.key)) continue;
    const pd = o.pipd;
    if (!pd) { dropped.outside.push({ chain: c, name: o.tags.name || '', ref: o.key }); continue; }
    const closedRef = (CLOSED_REFS[c] || []).map((x) => ({ x, d: distM(x, o) })).filter((y) => y.d <= 300).sort((a, b) => a.d - b.d)[0];
    const notes = [];
    let status = 'to_verify';
    if (closedRef) { status = 'closed'; notes.push(`según fuentes oficiales, ${closedRef.x.name} ${closedReasonEs(closedRef.x)} (a ${Math.round(closedRef.d)} m)`); }
    else notes.push(WEB[c].meta.missing ? 'solo en OSM' : complete ? 'no figura en la lista oficial — posible cierre' : 'solo en OSM');
    if (o.kind === 'building') notes.push('mapeada en OSM como edificio o área, sin etiqueta shop');
    if (manualHintByOsm[`osm-${o.key}`]) notes.push(`posiblemente es la tienda oficial ${manualHintByOsm[`osm-${o.key}`].map((n) => `"${n}"`).join(' o ')} (sin coordenadas en la lista oficial)`);
    if (o.members.length > 1) notes.push(`también mapeada en OSM como ${o.members.slice(1).map((x) => x.key).join(', ')}`);
    // Age of the OSM data (a recent edit may only have added brand tags, so it does not confirm the store).
    const meta = OSM_ELEMENT_META.elements[o.key];
    const survey = /\b(20[01]\d)\b/.exec(o.tags.source || o.tags.Source || '');
    if (survey) notes.push(`mapeada en un levantamiento de campo de ${survey[1]} (source=${o.tags.source || o.tags.Source})`);
    if (meta) notes.push(meta.timestamp < '2019-01-01' ? `datos de OSM editados por última vez el ${meta.timestamp.slice(0, 10)} (v${meta.version}): sin confirmar desde entonces` : `elemento OSM v${meta.version}, última edición el ${meta.timestamp.slice(0, 10)}`);
    // Another chain's official store on the same premises.
    const hn = parseInt(o.tags['addr:housenumber'], 10);
    const other = officialPoints.filter((w) => w.chain !== c).map((w) => ({ w, d: distM(w, o) })).filter((y) => y.d <= 60).sort((a, b) => a.d - b.d)[0];
    if (other && status !== 'closed') {
      const wn = addrNumber(other.w.address);
      const sameNumber = hn > 0 && wn && wn.num === hn;
      if (complete && (sameNumber || other.d <= 10)) {
        status = 'closed';
        notes.push(`el local ahora lo ocupa ${CHAIN_META[other.w.chain].name} "${other.w.name}" (lista oficial, ${other.d < 1 ? 'mismo punto' : 'a ' + Math.round(other.d) + ' m'}${sameNumber ? ', mismo número' : ''}) y no figura en la lista oficial completa de ${CHAIN_META[c].name}: cerrada`);
        osmOnlyLog.push({ chain: c, key: o.key, action: 'closed (premises taken over)', other: other.w.name, d: Math.round(other.d) });
      } else {
        notes.push(`tienda oficial de ${CHAIN_META[other.w.chain].name} "${other.w.name}" a ${Math.round(other.d)} m (¿mismo local? revisar)`);
        osmOnlyLog.push({ chain: c, key: o.key, action: 'note: another chain nearby', other: other.w.name, d: Math.round(other.d) });
      }
    }
    const ov = OSM_OVERRIDE[o.key];
    if (ov && ov.chain === c) {
      if (ov.status) status = ov.status;
      if (ov.note) notes.push(ov.note);
      overrideLog.push({ kind: 'osm', chain: c, target: `osm-${o.key}`, ok: true, actions: [ov.status ? `status ${ov.status}` : 'note'], evidence: ov.evidence || '' });
      ov.applied = true;
    }
    pushRow({ id: `osm-${o.key}`, chain: c, name: bestOsmName(o), address: osmAddress(o.tags), lat: o.lat, lng: o.lng, precision: 'exact', source: 'osm',
      source_ref: o.key, status, notes }, pd);
  }
  for (const o of osmWeak[c]) if (!matchedOsm.has(o.key)) dropped.weak.push({ chain: c, key: o.key, name: o.tags.name || '', reason: o.reason });
}
for (const ov of OVERRIDES.osm || []) if (!ov.applied) overrideLog.push({ kind: 'osm', chain: ov.chain, target: `osm-${ov.osm}`, ok: false, actions: [], result: 'not an OSM-only row in this run', evidence: ov.evidence || '' });
// ids for official-only rows: web-<chain>-<slug of branch>, unique per chain (deterministic order). Manual placements
// get theirs last, so placing a store never shifts the "-2" suffix of an existing row.
{
  const used = new Set(rows.filter((r) => r.id).map((r) => r.id));
  const pending = rows.filter((r) => !r.id).sort((a, b) => (a._manual ? 1 : 0) - (b._manual ? 1 : 0) || cmpStr(a.chain, b.chain) ||
    cmpStr(norm(a.name), norm(b.name)) || cmpStr(a.address, b.address) || a.lat - b.lat || a.lng - b.lng);
  for (const r of pending) {
    const branch = slug(r.name.replace(new RegExp('^' + RULES[r.chain].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '')) || 'tienda';
    let id = `web-${r.chain}-${branch}`, k = 2;
    while (used.has(id)) id = `web-${r.chain}-${branch}-${k++}`;
    used.add(id); r.id = id;
  }
}
// Sort: chain (group order), department, province, district, name, id.
const chainIdx = Object.fromEntries(CHAIN_ORDER.map((c, i) => [c, i]));
rows.sort((a, b) => chainIdx[a.chain] - chainIdx[b.chain] || cmpStr(norm(a.department), norm(b.department)) || cmpStr(norm(a.province), norm(b.province)) ||
  cmpStr(norm(a.district), norm(b.district)) || cmpStr(norm(a.name), norm(b.name)) || cmpStr(a.id, b.id));
{ const ids = new Set(); for (const r of rows) { if (ids.has(r.id)) throw new Error(`duplicate id ${r.id}`); ids.add(r.id); } }
// Geocoded (street-level) rows: flag a nearby exact row of the same chain (possible duplicate) and rows that
// share the same street point (two house numbers on one avenue geocode to the same segment). Manual placements are
// skipped: their duplicate check is part of the evidence (REPORT.md §4 lists the nearest row of the chain).
for (const r of rows.filter((x) => x.precision === 'approx' && !x._manual)) {
  const near = rows.filter((x) => x !== r && x.chain === r.chain && x.status !== 'closed').map((x) => ({ x, d: distM(r, x) }))
    .filter((y) => y.d <= (RULES[r.chain].dense ? 150 : 400)).sort((a, b) => a.d - b.d || cmpStr(a.x.id, b.x.id));
  const add = [];
  for (const { x, d } of near) {
    if (x.precision === 'approx' && d < 1) add.push(`mismo punto de calle geocodificado que ${x.id}`);
    else if (x.precision === 'exact') add.push(`posible duplicado de ${x.id} "${x.name}" (a ${Math.round(d)} m)`);
  }
  if (add.length) r.notes = [r.notes, ...add.slice(0, 2)].filter(Boolean).join('; ');
}
// Notes read as one Spanish sentence list: capital first letter, fragments joined by "; ".
for (const r of rows) if (r.notes) r.notes = r.notes.charAt(0).toLocaleUpperCase('es') + r.notes.slice(1);

/* ════════════════════════════════════ 7. CSV ═════════════════════════════════════════════════ */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",;\t\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; // same rule as js/io.js csvField
}
function csvRow(r) {
  return COLUMNS.map((c) => (c === 'lat' || c === 'lng' ? r[c].toFixed(6) : csvCell(r[c]))).join(',');
}
writeFileSync(FILES.csv, '﻿' + [COLUMNS.join(','), ...rows.map(csvRow)].join('\r\n') + '\r\n');
if (WRITE_CHAINS) writeFileSync(FILES.chainsJs, CHAINS_JS);

/* ════════════════════════════════════ 8. Report & log ════════════════════════════════════════ */
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
const L = [];
const p = (s = '') => L.push(s);
const byChain = (arr) => Object.fromEntries(CHAIN_ORDER.map((c) => [c, arr.filter((x) => x.chain === c)]));
const rowsBy = byChain(rows);
const matchesBy = byChain(matches);
const manualBy = byChain(dropped.manual);
const reported = (c) => {
  const a = CHAIN_META[c].storeCountReported, b = WEB[c].meta.reportedCount;
  const vals = [];
  if (b && b.value != null) vals.push({ v: b.value, date: b.date, src: b.source });
  if (a && a.value != null && !(b && b.value === a.value && b.date === a.date)) vals.push({ v: a.value, date: a.date, src: a.source });
  return vals;
};
const statusCount = (arr, st) => arr.filter((r) => r.status === st).length;
// Manual placements of this run (overrides.json → manualPlacements) and the row each one produced.
const manualRowOf = (x) => (x.kind === 'link' ? matches.find((m) => m.web === x.record)?.row : rows.find((r) => r._manual && r._web === x.record)) || null;
const mPlaced = manualLog.filter((x) => x.ok && x.kind === 'place'), mLinked = manualLog.filter((x) => x.ok && x.kind === 'link');
const mRejected = manualLog.filter((x) => x.ok && x.kind === 'reject'), mSkipped = manualLog.filter((x) => !x.ok);

p('# Seed store database — merge report');
p();
p(`Generated by \`node tools/merge.mjs\` (rows dated ${UPDATED}). OSM data as of **${OSM_META.osmBase || 'unknown'}**; official lists retrieved ` +
  `${[...new Set(CHAIN_ORDER.map((c) => WEB[c].meta.retrieved).filter(Boolean))].sort().join(' / ')}. ` +
  `Output: \`data/stores.csv\` (**${rows.length} rows**: ${statusCount(rows, 'verified')} verified, ${statusCount(rows, 'to_verify')} to_verify, ` +
  `${statusCount(rows, 'closed')} closed) → \`data/stores.js\` via \`node tools/build-data.mjs\`.`);
p();
p(`Exact coordinates: ${rows.filter((r) => r.precision === 'exact').length} rows (${pct(rows.filter((r) => r.precision === 'exact').length, rows.length)}). ` +
  `Geocoded (approx): ${rows.filter((r) => r.precision === 'approx').length}. Needs manual placement (not in the CSV): **${dropped.manual.length}**` +
  `${mPlaced.length + mLinked.length ? ` (${mPlaced.length + mLinked.length} more were placed by hand from evidence: ${mPlaced.length} new rows, ${mLinked.length} linked to OSM rows; §4)` : ''}. ` +
  `Nominatim requests this run: ${requests}${OFFLINE ? ' (offline run)' : ''}; geocode cache entries: ${Object.keys(cache.entries).length}.`);
p();
if (existsSync(FILES.notes)) { p(readFileSync(FILES.notes, 'utf8').trim()); p(); }
/* ── Verification fixes: hand-written verdicts (tools/seed/verification-notes.md) + what the rules and overrides did in THIS run ── */
{
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const rowOf = (name, chain) => rows.find((r) => r.chain === chain && r._web && (r._web.name === name || r._web.listText?.name === name)) ||
    matches.find((m) => m.chain === chain && (m.web.name === name || m.web.listText?.name === name))?.row || null;
  const ref = (r) => (r ? `\`${r.id}\` (${r.status}, ${r.precision})` : 'not in stores.csv');
  if (existsSync(FILES.verifyNotes)) { p(readFileSync(FILES.verifyNotes, 'utf8').trim()); p(); }
  p('### What the verification rules and overrides did in this run');
  p();
  p('Generated by `tools/merge.mjs` on every run, so it always matches `data/stores.csv`. Rules: see the header of `tools/merge.mjs`; per-store decisions: `tools/seed/overrides.json`.');
  p();
  p('**Overrides** (`tools/seed/overrides.json`):');
  p();
  p('| Kind | Store | Applied? | What it did → row |');
  p('|---|---|---|---|');
  for (const o of overrideLog) {
    const r = o.kind === 'osm' ? rowById.get(o.target) : o.kind === 'link' ? rowById.get(o.target.replace(/^.* ↔ /, '')) : rowOf(o.target, o.chain);
    p(`| ${o.kind} | ${esc(CHAIN_META[o.chain]?.name || o.chain)}: ${esc(o.target)} | ${o.ok ? 'yes' : '**no**'} | ${esc([...o.actions, o.result].filter(Boolean).join('; '))} → ${ref(r)} |`);
  }
  p();
  if (manualLog.length) {
    p(`**Manual placements** (\`tools/seed/overrides.json\` → \`manualPlacements\`, verified ${MANUAL_ON}; applied after all matching and geocoding): ` +
      `${mPlaced.length} placed as new rows, ${mLinked.length} linked to OSM rows already in the database, ${mRejected.length} not placed (still in §4)` +
      `${mSkipped.length ? `, **${mSkipped.length} not applied** (${mSkipped.map((x) => `${esc(x.entry.official)}: ${esc(x.result)}`).join('; ')})` : ''}. Every entry is listed in §4 ("Colocación manual").`);
    p();
  }
  const excludedNotChain = classified.filter((x) => x.kind === 'excluded' && /not the chain/.test(x.reason || ''));
  const doubtfulPos = classified.filter((x) => x.noCoords);
  p(`**OSM elements**: ${excludedNotChain.length} excluded because the mapper says they are not the chain (${excludedNotChain.map((x) => `${x.key} "${esc(x.e.tags.name)}"`).join(', ') || 'none'}); ` +
    `${doubtfulPos.length} with a doubtful position used only to confirm an official store (${doubtfulPos.map((x) => `${x.key} ${x.chain} "${esc(x.e.tags.name)}" → ${matchedOsm.has(x.key) ? 'confirms an official store, official coordinates kept' : 'unused'}`).join('; ') || 'none'}).`);
  p();
  p(`**Official coordinates checked** (${coordCheckLog.length} findings): ` + (coordCheckLog.length ? coordCheckLog.map((x) => `${esc(x.name)} (${x.chain}): ${x.rule}${x.other ? ` with "${esc(x.other)}"` : ''}${x.km != null ? ` (${x.km} km)` : ''}`).join('; ') : 'none') +
    '. Digit dropped → coordinates discarded; far from the stated district / other department → to_verify, approx; identical latitude or longitude → to_verify (one of the two is probably a copy; check both).');
  p();
  p(`**House-number check of geocoded stores** (${hnLog.length}): ` + (hnLog.length ? hnLog.map((x) => x.action === 'moved' ? `${esc(x.name)} moved ${(x.movedM / 1000).toFixed(1)} km (${esc(x.how)})` : `${esc(x.name)} **rejected** → manual placement (${esc(x.why)})`).join('; ') : 'none') + '.');
  p();
  const pressMerged = CHAIN_ORDER.flatMap((c) => WEB[c].stores.filter((x) => x.dupOf));
  p(`**Press records merged into the official entry they duplicate** (${pressMerged.length}): ${pressMerged.map((x) => `"${esc(x.name)}" → "${esc(x.dupOf.name)}"`).join('; ') || 'none'}.`);
  p();
  const closedOsm = osmOnlyLog.filter((x) => x.action.startsWith('closed'));
  p(`**OSM-only rows on another chain's premises**: ${closedOsm.length} closed (${closedOsm.map((x) => `osm-${x.key} → ${esc(x.other)}, ${x.d} m`).join('; ') || 'none'}); ` +
    `${osmOnlyLog.length - closedOsm.length} more OSM-only rows got a note that another chain's official store is ≤ 60 m away (listed in the queue below).`);
  p();
  // Verification queue: the to_verify rows most likely to be wrong, first.
  const prio = (r) => {
    const n = r.notes;
    if (r.status !== 'to_verify') return null;
    if (/descartadas|del distrito indicado|pero la lista oficial indica|control de numeración|ubicada a mano \(tools\/seed\/overrides/i.test(n)) return [1, 'position conflict fixed or flagged'];
    if (/sin confirmar desde entonces|levantamiento de campo/i.test(n) && r.source === 'osm') return [2, 'OSM-only, old OSM data'];
    if (/¿mismo local\? revisar/i.test(n)) return [2, "OSM-only, another chain's store on the spot"];
    if (/idéntica a la de .*¿copiada\?/i.test(n)) return [3, 'official coordinate shared with another store'];
    if (/coordenadas oficiales dudosas|no coinciden/i.test(n)) return [3, 'official coordinates doubted by the source'];
    return null;
  };
  const queue = rows.map((r) => ({ r, p: prio(r) })).filter((x) => x.p).sort((a, b) => a.p[0] - b.p[0] || chainIdx[a.r.chain] - chainIdx[b.r.chain] || cmpStr(a.r.id, b.r.id));
  p(`### Verification queue`);
  p();
  p(`${queue.length} of the ${statusCount(rows, 'to_verify')} to_verify rows, most doubtful first (1 = a position conflict was found, 2 = OSM-only with old data or on another chain's premises, ` +
    '3 = official coordinates shared with another store or doubted by the source). The other to_verify rows are geocoded addresses, press-only openings and records the source itself flags (see notes)' +
    (mPlaced.length ? `, plus the ${mPlaced.filter((x) => manualRowOf(x)?.status === 'to_verify').length} stores placed by hand from evidence (listed with their evidence in §4, "Colocación manual").` : '.'));
  p();
  p('| # | Row | Chain | Name | District | Why | Notes |');
  p('|---:|---|---|---|---|---|---|');
  for (const { r, p: q } of queue) p(`| ${q[0]} | \`${r.id}\` | ${CHAIN_META[r.chain].name} | ${esc(r.name)} | ${esc(r.district)} | ${q[1]} | ${esc(r.notes).slice(0, 300)} |`);
  p();
}
p('## 1. Per chain');
p();
p('Columns: **OSM** = OSM elements accepted as stores (after dropping closed/non-store look-alikes) → after collapsing duplicates; **weak** = odd-tagged ' +
  'elements used only to confirm an official store; **official** = stores in the chain\'s official list (with official coordinates); **reported** = store count the ' +
  'chain/press reported; **matched** = official store ↔ OSM element; **rows** = final rows (verified / to_verify / closed); **exact** = share of rows with exact coordinates; ' +
  '**manual** = official stores that could not be placed.');
p();
p('| Chain | OSM (elements → stores) | weak (used/total) | official (with coords) | complete? | reported | matched | rows (v / tv / c) | exact | manual |');
p('|---|---|---|---|---|---|---:|---|---:|---:|');
for (const c of CHAIN_ORDER) {
  const accepted = classified.filter((x) => x.chain === c && (x.kind === 'shop' || x.kind === 'building')).length;
  const weakUsed = matchesBy[c].filter((m) => m.osm.kind === 'weak').length;
  const off = WEB[c].stores, offC = off.filter((s) => s.lat != null).length;
  const rs = rowsBy[c];
  const rep = reported(c).map((x) => `${x.v} (${x.date})`).join(' · ') || '—';
  p(`| ${CHAIN_META[c].name} (\`${c}\`) | ${accepted} → ${osmStores[c].length} | ${weakUsed}/${osmWeak[c].length} | ${off.length} (${offC}) | ${WEB[c].meta.missing ? 'no list' : WEB[c].meta.complete ? 'yes' : 'no'} | ${rep} | ${matchesBy[c].length} | ` +
    `**${rs.length}** (${statusCount(rs, 'verified')} / ${statusCount(rs, 'to_verify')} / ${statusCount(rs, 'closed')}) | ${pct(rs.filter((r) => r.precision === 'exact').length, rs.length)} | ${manualBy[c].length} |`);
}
const tot = (f) => CHAIN_ORDER.reduce((a, c) => a + f(c), 0);
p(`| **Total** | ${tot((c) => classified.filter((x) => x.chain === c && (x.kind === 'shop' || x.kind === 'building')).length)} → ${tot((c) => osmStores[c].length)} | ` +
  `${tot((c) => matchesBy[c].filter((m) => m.osm.kind === 'weak').length)}/${tot((c) => osmWeak[c].length)} | ${tot((c) => WEB[c].stores.length)} (${tot((c) => WEB[c].stores.filter((s) => s.lat != null).length)}) | | | ` +
  `${matches.length} | **${rows.length}** (${statusCount(rows, 'verified')} / ${statusCount(rows, 'to_verify')} / ${statusCount(rows, 'closed')}) | ${pct(rows.filter((r) => r.precision === 'exact').length, rows.length)} | ${dropped.manual.length} |`);
p();
p('Row composition per chain (source / precision):');
p();
p('| Chain | OSM + official (matched) | official only, exact | official only, geocoded | OSM only | closed | match passes (P1/P2/P3/P4/P5) |');
p('|---|---:|---:|---:|---:|---:|---|');
for (const c of CHAIN_ORDER) {
  const rs = rowsBy[c];
  const passes = ['P1', 'P2', 'P3', 'P4', 'P5'].map((k) => matchesBy[c].filter((m) => m.pass.startsWith(k)).length).join(' / ');
  p(`| ${CHAIN_META[c].name} | ${rs.filter((r) => r.source === 'osm' && r._matched).length} | ${rs.filter((r) => r.source === 'web' && r.precision === 'exact').length} | ` +
    `${rs.filter((r) => r.source === 'web' && r.precision === 'approx').length} | ${rs.filter((r) => r.source === 'osm' && !r._matched && r.status !== 'closed').length} | ` +
    `${statusCount(rs, 'closed')} | ${passes} |`);
}
p();
p('Reported counts and their sources:');
p();
for (const c of CHAIN_ORDER) {
  const rs = reported(c);
  p(`- **${CHAIN_META[c].name}**: ${rs.length ? rs.map((x) => `${x.v} as of ${x.date} — ${esc(x.src).slice(0, 220)}`).join(' · ') : 'no reported count found (see the chain JSON notes)'}`);
}
p();
// Departments
p('## 2. Per department');
p();
const depts = [...new Set(rows.map((r) => r.department))].sort((a, b) => cmpStr(norm(a), norm(b)));
const short = { plazavea: 'PV', tottus: 'Tot', wong: 'Wong', metro: 'Met', vivanda: 'Viv', tiendas3a: '3A', mass: 'Mass', preciouno: 'P1', maxiahorro: 'Maxi',
  dollarcity: 'DC', makro: 'Mak', vega: 'Vega', florayfauna: 'F&F', holi: 'Holi', tambo: 'Tam', oxxo: 'Oxxo' };
p('Rows with status verified or to_verify (closed excluded). Chain abbreviations: ' + CHAIN_ORDER.map((c) => `${short[c]} = ${CHAIN_META[c].name}`).join(', ') + '.');
p();
p(`| Department | total | ${CHAIN_ORDER.map((c) => short[c]).join(' | ')} |`);
p(`|---|---:|${CHAIN_ORDER.map(() => '---:').join('|')}|`);
const live = rows.filter((r) => r.status !== 'closed');
for (const d of depts) {
  const rs = live.filter((r) => r.department === d);
  if (!rs.length) continue;
  p(`| ${d} | **${rs.length}** | ${CHAIN_ORDER.map((c) => rs.filter((r) => r.chain === c).length || '').join(' | ')} |`);
}
p(`| **Peru** | **${live.length}** | ${CHAIN_ORDER.map((c) => live.filter((r) => r.chain === c).length).join(' | ')} |`);
p();
// Regions of the reference slides
p('## 3. The four regions of the reference slides');
p();
const findUb = (district, province) => DISTRICTS.find((d) => norm(d.district) === norm(district) && norm(d.province) === norm(province))?.ubigeo;
const REGIONS = [
  { name: 'Lima Metropolitana Sur', slide: 'slide-lima-sur.png', d: [['Miraflores', 'Lima'], ['San Borja', 'Lima'], ['San Isidro', 'Lima'], ['Surquillo', 'Lima']] },
  { name: 'Lima Cono Sur', slide: 'slide-lima-cono-sur.png', d: [['Chorrillos', 'Lima'], ['Lurín', 'Lima'], ['Punta Hermosa', 'Lima'], ['San Juan de Miraflores', 'Lima'], ['Villa El Salvador', 'Lima'], ['Villa María del Triunfo', 'Lima']] },
  { name: 'Trujillo (urban area)', slide: 'slide-trujillo.png', d: [['Trujillo', 'Trujillo'], ['Víctor Larco Herrera', 'Trujillo'], ['La Esperanza', 'Trujillo'], ['El Porvenir', 'Trujillo'], ['Florencia de Mora', 'Trujillo'], ['Huanchaco', 'Trujillo'], ['Moche', 'Trujillo'], ['Laredo', 'Trujillo']] },
  { name: 'Chimbote', slide: 'slide-chimbote.png', d: [['Chimbote', 'Santa'], ['Nuevo Chimbote', 'Santa']] },
];
const keyUb = existsSync(FILES.keyUbigeos) ? readJson(FILES.keyUbigeos).named || {} : {};
const regionData = [];
for (const R of REGIONS) {
  const ubs = R.d.map(([d, pv]) => { const u = findUb(d, pv); if (!u) throw new Error(`ubigeo not found: ${d} (${pv})`); const k = keyUb[`${d} (${pv})`]; if (k && k !== u) throw new Error(`key-ubigeos mismatch ${d}`); return u; });
  const rs = live.filter((r) => ubs.includes(r.ubigeo));
  regionData.push({ ...R, ubs, rs });
  p(`### ${R.name}`);
  p();
  p(`Districts: ${R.d.map(([d], i) => `${d} (${ubs[i]})`).join(', ')}. Reference: \`docs/reference/${R.slide}\`.`);
  p();
  p('| Chain | rows | verified | to_verify | of which approx | by district |');
  p('|---|---:|---:|---:|---:|---|');
  for (const c of CHAIN_ORDER) {
    const cr = rs.filter((r) => r.chain === c);
    if (!cr.length) continue;
    const byD = R.d.map(([d], i) => [d, cr.filter((r) => r.ubigeo === ubs[i]).length]).filter(([, n]) => n).map(([d, n]) => `${d} ${n}`).join(', ');
    p(`| ${CHAIN_META[c].name}${CHAIN_META[c].defaultOn === false ? ' *(default off)*' : ''} | **${cr.length}** | ${statusCount(cr, 'verified')} | ${statusCount(cr, 'to_verify')} | ${cr.filter((r) => r.precision === 'approx').length} | ${byD} |`);
  }
  const on = rs.filter((r) => CHAIN_META[r.chain].defaultOn !== false);
  p(`| **Total** | **${rs.length}** (${on.length} with default-on chains) | ${statusCount(rs, 'verified')} | ${statusCount(rs, 'to_verify')} | ${rs.filter((r) => r.precision === 'approx').length} | |`);
  p();
}
// Manual placement
p('## 4. Needs manual placement');
p();
p(`${dropped.manual.length} official or press-reported stores have no coordinates in their source, no matching OSM element, no geocoding result inside the district the source ` +
  'states (or a geocoding result that the house-number check rejected), and no position decided from evidence. They are **not** in `data/stores.csv`; add them in the app ' +
  '(Base de datos → add store → address search / click on map / paste coordinates or a Google Maps link). Where the official site links the store to Google Maps, the link is in the ' +
  '"official map link" column: open it yourself and paste the coordinates (the tools do not read Google Maps).' +
  (mRejected.length ? ` Stores marked **checked by hand** were researched and independently re-checked on ${MANUAL_ON} without finding a defensible position; the verifier's reason ` +
    'follows in the "Why" column (`tools/seed/overrides.json` → `manualPlacements`, verdict reject).' : ''));
p();
if (dropped.manual.length) {
  p('| Chain | Store | Address | District / province / department (source) | Why | Official map link | Unmatched OSM rows of the chain nearby (check these first) |');
  p('|---|---|---|---|---|---|---|');
  for (const m of [...dropped.manual].sort((a, b) => chainIdx[a.chain] - chainIdx[b.chain] || cmpStr(norm(a.name), norm(b.name)))) {
    const checked = m.checked ? ` — **checked by hand on ${m.checked.on} (batch ${m.checked.batch}), not placed:** ${m.checked.reason}` : '';
    p(`| ${CHAIN_META[m.chain].name} | ${esc(m.name)} | ${esc(m.address)} | ${esc([m.district || '—', m.province || '—', m.department || '—'].join(' / '))} | ${esc([m.why, ...m.flags, ...(m.notes || [])].join('; ') + checked)} | ${m.mapLink || '—'} | ${m.osmCandidates.join(', ') || '—'} |`);
  }
  p();
}
if (mPlaced.length || mLinked.length || mSkipped.length) {
  const done = [...mPlaced, ...mLinked].map((x) => ({ x, r: manualRowOf(x) }));
  const rs = done.map((y) => y.r).filter(Boolean);
  const newRows = mPlaced.map(manualRowOf).filter(Boolean);
  const CONF_EN = { high: 'high', medium: 'medium', low: 'low' };
  const km = (d) => (d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`);
  const urls = (e) => [...new Set([...(e.evidence || []), e.verification || ''].join(' ').match(/https?:\/\/[^\s)'"<>]+/g) || [])].map((u) => u.replace(/[.,;:]+$/, ''));
  p(`### Colocación manual (${MANUAL_ON})`);
  p();
  p(`${rs.length} stores that no rule could place were placed by hand from evidence: **${newRows.length} new rows** ` +
    `(${statusCount(newRows, 'verified')} verified, ${statusCount(newRows, 'to_verify')} to_verify; ${newRows.filter((r) => r.precision === 'exact').length} exact, ` +
    `${newRows.filter((r) => r.precision === 'approx').length} approx) and **${mLinked.length} official stores matched to an OSM row already in the database** (no new row; ` +
    `the OSM-only row becomes the official store). ${mRejected.length} had no defensible position and stay in the table above. Each store was researched and then ` +
    'independently re-checked (`tools/seed/manual/<batch>-research.json`, `<batch>-verdicts.json`): coordinates, precision and status are the verifier\'s. The decisions live in ' +
    '`tools/seed/overrides.json` → `manualPlacements` (full evidence lists there), so every run of `tools/merge.mjs` reproduces them; they are applied after all matching and ' +
    'geocoding and only to records that are still unplaced, so they never change how any other store is matched. Official Google Maps short links were resolved only to read the coordinates in the ' +
    'redirect URL (no Google Maps page content was fetched). A new row keeps its record\'s source (`web`: the official list, or the press note for openings not yet in it), ' +
    'URL and an id `web-<chain>-<slug>`; its `notes` start with "Colocada a mano el … a partir de evidencia verificada" and carry the Spanish note. For a radius or distance ' +
    'analysis, treat `approx` and `to_verify` rows as uncertain positions; the confidence says how far off they can be (low ≈ up to 1 km or more, medium ≈ one block to ' +
    '~200 m, high ≈ the building or a few tens of metres).');
  p();
  p('| Chain | Store | Row · nearest other row of the chain | Position (district) | Precision · status · confidence | Method | Evidence (independent check) · sources |');
  p('|---|---|---|---|---|---|---|');
  for (const { x, r } of done.sort((a, b) => chainIdx[a.x.entry.chain] - chainIdx[b.x.entry.chain] || cmpStr(norm(a.r?.name || a.x.entry.official), norm(b.r?.name || b.x.entry.official)))) {
    const e = x.entry;
    if (!r) { p(`| ${CHAIN_META[e.chain].name} | ${esc(e.official)} | **no row** | — | — | ${esc(e.method)} | ${esc(e.verification)} |`); continue; }
    const near = rows.filter((y) => y !== r && y.chain === r.chain && y.status !== 'closed').map((y) => ({ y, d: distM(r, y) })).sort((a, b) => a.d - b.d || cmpStr(a.y.id, b.y.id))[0];
    const rowCell = `\`${r.id}\`${x.kind === 'link' ? ' (existing OSM row, now matched)' : ' (new)'}${near ? ` · \`${near.y.id}\` ${km(near.d)}` : ''}`;
    const pos = `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)} (${r.district})${r.address !== x.record.listText?.address && x.record.listText ? `; address set to "${esc(r.address)}"` : ''}`;
    const meta = `${r.precision} · ${r.status} · ${CONF_EN[e.confidence] || e.confidence || '—'}${e.verdict === 'adjust' ? ' · **adjusted by the verifier**' : ''}`;
    const src = urls(e).slice(0, 6).join(' ');
    p(`| ${CHAIN_META[e.chain].name} | ${esc(r.name)} | ${rowCell} | ${pos} | ${meta} | ${esc(e.method)} | ${esc(e.verification)}${src ? ` Sources: ${esc(src)}` : ''} |`);
  }
  p();
  if (mSkipped.length) {
    p(`Not applied in this run (${mSkipped.length}): ${mSkipped.map((y) => `${esc(y.entry.official)} (${y.entry.chain}): ${esc(y.result)}`).join('; ')}.`);
    p();
  }
}
// Dropped / excluded
p('## 5. What was left out');
p();
const excl = classified.filter((x) => x.chain && x.kind === 'excluded');
const closed = classified.filter((x) => x.chain && x.kind === 'closed');
p(`- OSM elements whose names look like a chain but are not stores: **${excl.length}** (by chain: ${CHAIN_ORDER.map((c) => `${c} ${excl.filter((x) => x.chain === c).length}`).filter((s) => !/ 0$/.test(s)).join(', ')}). ` +
  `Elements matching no chain pattern at all: ${classified.filter((x) => !x.chain).length}. Full list with reasons in \`tools/seed/merge-log.json\`.`);
const reasonCount = {};
for (const x of excl) { const k = x.reason.replace(/\(([a-z_:]+)=[^)]*\)/, '($1=…)').replace(/"[^"]*"/, '"…"').replace(/operator=.*/, 'operator=…'); reasonCount[k] = (reasonCount[k] || 0) + 1; }
p(`  Top reasons: ${Object.entries(reasonCount).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).slice(0, 12).map(([k, n]) => `${k} ×${n}`).join('; ')}.`);
p(`- OSM elements tagged as closed: **${closed.length}**${closed.length ? ': ' + closed.map((x) => `${x.key} (${x.chain}, ${esc(x.e.tags.name || x.e.tags.brand || '')}: ${x.reason})`).join('; ') : ''}.`);
p(`- Weak OSM elements (odd tagging) that confirmed no official store and were dropped: **${dropped.weak.length}**${dropped.weak.length ? ': ' + dropped.weak.map((x) => `${x.key} ${x.chain} "${esc(x.name)}" (${esc(x.reason)})`).join('; ') : ''}.`);
p(`- Rows outside Peru (no district within 300 m): **${dropped.outside.length}**${dropped.outside.length ? ': ' + dropped.outside.map((x) => `${x.chain} ${esc(x.name)} ${x.ref}`).join('; ') : ''}.`);
if (chainGaps.length) p(`- Gaps filled in data/chains.js: ${chainGaps.join('; ')}.`);
p();
p('## 6. Rules used');
p();
p('Name patterns (accent-folded, lower-case, anchored at the start of `name`, then `brand`, then `brand:wikidata`), exclusions, accepted shop types and radii are ' +
  'published in `data/chains.js` (per-chain `osm` objects from `tools/seed/chains/<id>.json`, cross-chain `window.MT_OSM_RULES` from `tools/seed/osm-rules.json`); ' +
  'the merge classifies with exactly that content (`tools/seed/osm-classify.mjs`), so the app\'s OSM scan can use the same rules. Schema: `tools/seed/OSM-RULES.md`. ' +
  'Big formats (Plaza Vea, Tottus, Wong, Metro, Vivanda, Precio Uno, Makro): duplicates within ' +
  `${RADII.big.dedupe} m collapse, official↔OSM match within ${RADII.big.match} m (then ${RADII.big.match2} m), geocoded↔OSM within ${RADII.big.geo} m. ` +
  `Small formats: ${RADII.dense.dedupe} m / ${RADII.dense.match} m (then ${RADII.dense.match2} m) / ${RADII.dense.geo} m. Store data derived from OSM is © OpenStreetMap contributors (ODbL).`);
p();
writeFileSync(FILES.report, L.join('\n'));

const log = {
  generated: UPDATED,
  note: 'Audit trail of tools/merge.mjs: every OSM classification decision, every official↔OSM match, geocoding outcomes and dropped records.',
  osm: classified.filter((x) => x.chain).map((x) => ({ key: x.key, chain: x.chain, via: x.via, kind: x.kind, reason: x.reason || null, name: x.e.tags.name || null,
    shop: x.e.tags.shop || null, lat: x.e.lat, lng: x.e.lng })),
  osmClusters: Object.fromEntries(CHAIN_ORDER.map((c) => [c, osmStores[c].filter((o) => o.members.length > 1).map((o) => o.members.map((m) => m.key))])),
  matches: matches.map((m) => ({ chain: m.chain, official: m.web.name, osm: m.osm.key, osmName: m.osm.tags.name || null, kind: m.osm.kind, pass: m.pass, distanceM: m.web.lat != null ? m.d : null,
    score: m.score, row: m.row?.id || null })),
  geocoding: geoLog,
  manualPlacement: dropped.manual,
  manualPlacementsApplied: manualLog.map((x) => ({ chain: x.entry.chain, official: x.entry.official, batch: x.entry.batch || null, verdict: x.entry.verdict,
    kind: x.kind, ok: x.ok, actions: x.actions, result: x.result || null, row: x.ok && x.kind !== 'reject' ? manualRowOf(x)?.id || null : null })),
  verification: { coordinateChecks: coordCheckLog, houseNumberChecks: hnLog, osmOnlyChecks: osmOnlyLog, overrides: overrideLog },
  droppedWeak: dropped.weak,
  outsidePeru: dropped.outside,
};
writeFileSync(FILES.log, JSON.stringify(log, null, 1) + '\n');

process.stderr.write(`stores.csv: ${rows.length} rows (${statusCount(rows, 'verified')} verified, ${statusCount(rows, 'to_verify')} to_verify, ${statusCount(rows, 'closed')} closed); ` +
  `matched ${matches.length}; manual placement ${dropped.manual.length}; Nominatim requests ${requests}.\n`);
