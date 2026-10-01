#!/usr/bin/env node
/**
 * tools/seed/check-osm-rules.mjs — checks the OSM rules published in data/chains.js (window.MT_CHAINS[].osm +
 * window.MT_OSM_RULES) against the last seed merge, and writes test fixtures for ports of the classifier.
 *
 *   node tools/seed/check-osm-rules.mjs                   classify every element of tools/seed/osm-raw.json with the rules
 *                                                         in data/chains.js (tools/seed/osm-classify.mjs) and compare with
 *                                                         the decisions logged by tools/merge.mjs (tools/seed/merge-log.json)
 *   node tools/seed/check-osm-rules.mjs --write-fixtures  also write tools/seed/osm-rules-fixtures.json: a deterministic
 *                                                         sample (every chain × kind × reason type, up to 4 each, plus
 *                                                         elements of no chain) as {key, tags, expect:{chain, via, kind, noCoords}}
 *
 * A port (e.g. js/osm.js) is correct when it returns `expect` for every fixture. Exit code 1 on any mismatch.
 * Node built-ins only. Schema: tools/seed/OSM-RULES.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { compileOsmRules, classifyOsm } from './osm-classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(path.join(ROOT, 'data', 'chains.js'), 'utf8'), sandbox, { filename: 'data/chains.js' });
const { MT_CHAINS, MT_OSM_RULES } = sandbox.window;
if (!MT_CHAINS || !MT_OSM_RULES) { console.error('data/chains.js has no MT_CHAINS / MT_OSM_RULES (rerun node tools/merge.mjs)'); process.exit(1); }
const R = compileOsmRules(MT_CHAINS, MT_OSM_RULES);

const raw = JSON.parse(readFileSync(path.join(HERE, 'osm-raw.json'), 'utf8')).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
const log = JSON.parse(readFileSync(path.join(HERE, 'merge-log.json'), 'utf8'));
const logged = new Map(log.osm.map((x) => [x.key, x]));
const keyOf = (e) => e.type[0] + e.id;

let bad = 0, n = 0;
const results = [];
for (const e of raw) {
  const k = keyOf(e), got = classifyOsm(e.tags, R), want = logged.get(k);
  results.push({ e, k, got });
  n++;
  const same = want ? got.chain === want.chain && got.via === want.via && got.kind === want.kind && (got.reason || null) === want.reason
    : got.chain === null;
  if (!same) { bad++; if (bad <= 20) console.log('MISMATCH', k, JSON.stringify(e.tags.name || ''), 'got', JSON.stringify(got), 'logged', JSON.stringify(want || { chain: null })); }
}
const kinds = {};
for (const { got } of results) { const t = got.chain ? got.kind : 'no chain'; kinds[t] = (kinds[t] || 0) + 1; }
console.log(`${n} OSM elements classified with data/chains.js: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}; ` +
  `${bad} differ from tools/seed/merge-log.json`);

if (process.argv.includes('--write-fixtures')) {
  const reasonType = (r) => (r || '').replace(/\(([a-z_:]+)=[^)]*\)/, '($1=…)').replace(/"[^"]*"/g, '"…"').replace(/^(operator|landuse|building)=.*/, '$1=…')
    .replace(/position doubtful in OSM: .*/, 'position doubtful');
  const groups = new Map();
  for (const x of [...results].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))) {
    const g = x.got.chain ? `${x.got.chain}|${x.got.kind}|${reasonType(x.got.reason)}` : 'none';
    if (!groups.has(g)) groups.set(g, []);
    const list = groups.get(g);
    if (list.length < (g === 'none' ? 40 : 4)) list.push(x);
  }
  const fixtures = [...groups.keys()].sort().flatMap((g) => groups.get(g)).map(({ k, e, got }) => ({
    key: k, tags: e.tags, expect: { chain: got.chain, via: got.via || null, kind: got.chain ? got.kind : null, noCoords: !!got.noCoords },
  }));
  const out = {
    about: 'Expected classification of real OSM elements (tools/seed/osm-raw.json) by the rules in data/chains.js, as computed by ' +
      'tools/seed/osm-classify.mjs (the classifier tools/merge.mjs uses). Regenerate with node tools/seed/check-osm-rules.mjs --write-fixtures ' +
      'after a rules change. A port of the rules (js/osm.js) must return `expect` for every entry. Data © OpenStreetMap contributors, ODbL.',
    generatedFrom: { chains: 'data/chains.js', osm: 'tools/seed/osm-raw.json' },
    count: fixtures.length,
    fixtures,
  };
  writeFileSync(path.join(HERE, 'osm-rules-fixtures.json'), JSON.stringify(out, null, 0).replace(/\},\{"key"/g, '},\n{"key"') + '\n');
  console.log(`wrote tools/seed/osm-rules-fixtures.json (${fixtures.length} fixtures in ${groups.size} groups)`);
}
process.exit(bad ? 1 : 0);
