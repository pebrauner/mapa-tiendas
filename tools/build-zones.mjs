#!/usr/bin/env node
/**
 * tools/build-zones.mjs — data/zonas-nielsen.csv (canonical) → data/zones.js (window.MT_ZONES).
 *
 *   node tools/build-zones.mjs            # writes data/zones.js
 *   node tools/build-zones.mjs --check    # validate only, write nothing (also fails if data/zones.js is out of date)
 *
 * Zonas Nielsen = the SUBAREA column of the company's store list ("Listado de tiendas - Octubre 2026 V2 -
 * Zona Nielsen", sheet BD): the main grouping of the stores. Each district belongs to ONE zone (the zone
 * most of its stores carry in that list); districts with no store in the list were placed by neighbourhood
 * (column `origin` = "vecindad"). "Resto Perú / Norte / Sur" is not a set of districts (the list gives the
 * same district several of them), so it is not a zone here: stores outside the zones belong to "the rest of Peru".
 *
 * CSV: UTF-8 with BOM, comma separator, header row, columns in this order:
 *   ubigeo (6-digit INEI code) · district · province · department (informational, must match data/districts.js)
 *   · zone (display name) · area ("Lima + Callao" | "Provincias": groups the zones in the picker)
 *   · origin ("excel" | "vecindad") · note (free text)
 * Zones keep the order of their first row in the CSV; districts keep the CSV order.
 *
 * Output: window.MT_ZONES = {count, zones:[{id, name, area, ubigeos:[…]}]}. Node built-ins only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CSV = path.join(ROOT, 'data', 'zonas-nielsen.csv');
const OUT = path.join(ROOT, 'data', 'zones.js');
const DISTRICTS = path.join(ROOT, 'data', 'districts.js');
const COLUMNS = ['ubigeo', 'district', 'province', 'department', 'zone', 'area', 'origin', 'note'];
const ORIGINS = ['excel', 'vecindad'];
const CHECK = process.argv.includes('--check');

/** RFC-4180 parser (quoted fields, doubled quotes, CRLF/LF). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const [header, ...body] = parseCsv(readFileSync(CSV, 'utf8').replace(/^﻿/, '')).filter((r) => !(r.length === 1 && r[0] === ''));
const problems = [];
if (!header || header.join(',') !== COLUMNS.join(',')) {
  console.error(`build-zones: unexpected header in data/zonas-nielsen.csv:\n  ${header && header.join(',')}\nexpected:\n  ${COLUMNS.join(',')}`);
  process.exit(1);
}

// INEI districts the app ships (TopoJSON properties), to check codes and names.
const inei = new Map();
if (existsSync(DISTRICTS)) {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(DISTRICTS, 'utf8'), sandbox, { filename: 'districts.js' });
  const topo = sandbox.window.MT_DISTRICTS;
  for (const g of Object.values(topo.objects)[0].geometries) inei.set(g.properties.ubigeo, g.properties);
} else problems.push('data/districts.js not found: district codes cannot be checked');

const zones = [], byId = new Map(), seen = new Map();
body.forEach((r, k) => {
  const line = k + 2;
  if (r.length !== COLUMNS.length) { problems.push(`line ${line}: ${r.length} fields (expected ${COLUMNS.length})`); return; }
  const o = Object.fromEntries(COLUMNS.map((c, j) => [c, r[j]]));
  if (!/^\d{6}$/.test(o.ubigeo)) problems.push(`line ${line}: ubigeo "${o.ubigeo}" is not 6 digits`);
  if (inei.size) {
    const d = inei.get(o.ubigeo);
    if (!d) problems.push(`line ${line}: ubigeo ${o.ubigeo} is not in data/districts.js`);
    else if (d.district !== o.district || d.province !== o.province || d.department !== o.department)
      problems.push(`line ${line}: ${o.ubigeo} is "${d.district}, ${d.province}, ${d.department}" in data/districts.js, not "${o.district}, ${o.province}, ${o.department}"`);
  }
  if (seen.has(o.ubigeo)) problems.push(`line ${line}: district ${o.ubigeo} (${o.district}) is already in zone "${seen.get(o.ubigeo)}": a district belongs to ONE zone`);
  seen.set(o.ubigeo, o.zone);
  if (!o.zone.trim()) problems.push(`line ${line}: empty zone`);
  if (!o.area.trim()) problems.push(`line ${line}: empty area`);
  if (!ORIGINS.includes(o.origin)) problems.push(`line ${line}: origin "${o.origin}" (expected ${ORIGINS.join(' | ')})`);
  let z = byId.get(slug(o.zone));
  if (!z) { z = { id: slug(o.zone), name: o.zone, area: o.area, ubigeos: [] }; byId.set(z.id, z); zones.push(z); }
  else if (z.area !== o.area) problems.push(`line ${line}: zone "${o.zone}" appears with two areas ("${z.area}" and "${o.area}")`);
  if (z.name !== o.zone) problems.push(`line ${line}: zone "${o.zone}" collides with "${z.name}" (same id)`);
  z.ubigeos.push(o.ubigeo);
});
if (problems.length) {
  console.error(`build-zones: ${problems.length} problem(s) in data/zonas-nielsen.csv:\n  ` + problems.slice(0, 40).join('\n  '));
  process.exit(1);
}

const js = '/* mapa-tiendas — Zonas Nielsen (SUBAREA of the company store list). Generated by tools/build-zones.mjs from data/zonas-nielsen.csv.\n' +
  ' * Edit the CSV, not this file. A district belongs to one zone; stores outside every zone are "the rest of Peru". */\n' +
  'window.MT_ZONES = {"count":' + zones.length + ',"zones":[\n' + zones.map((z) => '  ' + JSON.stringify(z)).join(',\n') + '\n]};\n';

const summary = zones.map((z) => `${z.name} ${z.ubigeos.length}`).join(', ');
if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== js) { console.error('build-zones --check: data/zones.js is out of date: run node tools/build-zones.mjs'); process.exit(1); }
  console.error(`build-zones --check: ${zones.length} zones, ${seen.size} districts OK (${summary}).`);
  process.exit(0);
}
writeFileSync(OUT, js);
console.error(`zones.js: ${zones.length} zones, ${seen.size} districts · ${summary}`);
