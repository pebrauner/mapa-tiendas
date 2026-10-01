#!/usr/bin/env node
/**
 * tools/build-data.mjs — data/stores.csv (canonical, SPEC §3.1) → data/stores.js (window.MT_SEED).
 *
 *   node tools/build-data.mjs                       # generated = latest `updated` date in the CSV
 *   node tools/build-data.mjs --generated=2026-10-01
 *   node tools/build-data.mjs --check               # validate only, write nothing
 *
 * Output (same shape as the app's "Guardar en carpeta"):
 *   window.MT_SEED = {"generated":"YYYY-MM-DD","count":N,"columns":[…16 columns…],"stores":[ {…}, … ]};
 * lat/lng are numbers (6 decimals), everything else strings. Rows are sorted by chain (order of
 * data/chains.js, i.e. group order; unknown chains last, alphabetically), department, province,
 * district, name, id — accent-insensitive — so the file is deterministic and diffs stay small.
 * Node built-ins only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CSV = path.join(ROOT, 'data', 'stores.csv');
const OUT = path.join(ROOT, 'data', 'stores.js');
const CHAINS = path.join(ROOT, 'data', 'chains.js');
const COLUMNS = ['id', 'chain', 'name', 'address', 'district', 'province', 'department', 'ubigeo', 'lat', 'lng',
  'precision', 'source', 'source_ref', 'status', 'notes', 'updated'];
const ENUMS = { precision: ['exact', 'approx'], source: ['osm', 'web', 'manual', 'import'], status: ['verified', 'to_verify', 'closed'] };

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const genArg = (args.find((a) => a.startsWith('--generated=')) || '').split('=')[1];

/** RFC-4180 parser (quoted fields, doubled quotes, CRLF/LF, embedded newlines). */
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
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const text = readFileSync(CSV, 'utf8').replace(/^﻿/, '');
const [header, ...body] = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''));
if (!header || header.join(',') !== COLUMNS.join(',')) {
  console.error(`build-data: unexpected header in data/stores.csv:\n  ${header && header.join(',')}\nexpected:\n  ${COLUMNS.join(',')}`);
  process.exit(1);
}
const problems = [];
const seen = new Set();
const stores = body.map((r, k) => {
  const line = k + 2;
  if (r.length !== COLUMNS.length) problems.push(`line ${line}: ${r.length} fields (expected ${COLUMNS.length})`);
  const o = {};
  COLUMNS.forEach((c, j) => { o[c] = r[j] === undefined ? '' : r[j]; });
  for (const c of ['lat', 'lng']) {
    const v = Number(o[c]);
    if (o[c] === '' || !Number.isFinite(v)) problems.push(`line ${line} (${o.id}): ${c} is not a number`);
    o[c] = Math.round(v * 1e6) / 1e6;
  }
  if (!o.id) problems.push(`line ${line}: empty id`);
  if (seen.has(o.id)) problems.push(`line ${line}: duplicate id ${o.id}`);
  seen.add(o.id);
  for (const [c, vals] of Object.entries(ENUMS)) if (!vals.includes(o[c])) problems.push(`line ${line} (${o.id}): ${c}="${o[c]}"`);
  if (o.ubigeo && !/^\d{6}$/.test(o.ubigeo)) problems.push(`line ${line} (${o.id}): ubigeo "${o.ubigeo}"`);
  if (o.updated && !/^\d{4}-\d{2}-\d{2}$/.test(o.updated)) problems.push(`line ${line} (${o.id}): updated "${o.updated}"`);
  return o;
});
if (problems.length) {
  console.error(`build-data: ${problems.length} problem(s) in data/stores.csv:\n  ` + problems.slice(0, 40).join('\n  '));
  process.exit(1);
}

// Chain order from data/chains.js (group order); unknown chains after, alphabetically.
let chainOrder = [];
if (existsSync(CHAINS)) {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(CHAINS, 'utf8'), sandbox, { filename: 'chains.js' });
  chainOrder = (sandbox.window.MT_CHAINS || []).map((c) => c.id);
}
const rank = (c) => { const i = chainOrder.indexOf(c); return i < 0 ? chainOrder.length : i; };
stores.sort((a, b) => rank(a.chain) - rank(b.chain) || cmp(a.chain, b.chain) || cmp(fold(a.department), fold(b.department)) ||
  cmp(fold(a.province), fold(b.province)) || cmp(fold(a.district), fold(b.district)) || cmp(fold(a.name), fold(b.name)) || cmp(a.id, b.id));

const generated = genArg || stores.reduce((m, s) => (s.updated > m ? s.updated : m), '') || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(generated)) { console.error('build-data: --generated must be YYYY-MM-DD'); process.exit(1); }

const js = '/* mapa-tiendas — store database. Generated by tools/build-data.mjs from data/stores.csv on ' + generated + '.\n' +
  ' * Canonical source: data/stores.csv. Store data derived from OpenStreetMap is © OpenStreetMap contributors (ODbL). */\n' +
  'window.MT_SEED = {"generated":' + JSON.stringify(generated) + ',"count":' + stores.length + ',"columns":' + JSON.stringify(COLUMNS) +
  ',"stores":[\n' + stores.map((s) => '  ' + JSON.stringify(Object.fromEntries(COLUMNS.map((c) => [c, s[c]])))).join(',\n') + '\n]};\n';

const count = (k) => Object.entries(stores.reduce((m, s) => ((m[s[k]] = (m[s[k]] || 0) + 1), m), {})).map(([v, n]) => `${v} ${n}`).join(', ');
if (CHECK) { console.error(`build-data --check: ${stores.length} stores OK (${count('status')}).`); process.exit(0); }
writeFileSync(OUT, js);
console.error(`stores.js: ${stores.length} stores, generated ${generated}, ${(Buffer.byteLength(js) / 1024).toFixed(0)} KiB · status: ${count('status')} · source: ${count('source')} · precision: ${count('precision')}`);
