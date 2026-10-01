// tools/test/run-all.mjs — run every test suite, one after the other, and print a summary.
//
//   node tools/test/run-all.mjs                 # all offline-safe suites (map tiles still need internet)
//   node tools/test/run-all.mjs --network       # + live Nominatim/Overpass checks (net, tech-proof)
//   node tools/test/run-all.mjs --only=e2e,smoke
//   node tools/test/run-all.mjs --skip=export   # skip suites by name
//   node tools/test/run-all.mjs --retries=1     # re-run a failing suite once (reported as FLAKY if it then passes)
//
// Each suite runs as its own `node` process (they each launch headless Chrome); its full output goes
// to tools/test/out/logs/<suite>.log. Exit code 1 when any suite fails.

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(HERE, 'out', 'logs');
mkdirSync(LOGS, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

// name, script, args, what it covers. Order: fast unit-ish checks first, the long journeys last.
const SUITES = [
  ['smoke', 'smoke.mjs', [], 'boot, tabs, language, missing data, 1280 px'],
  ['pages', 'pages-smoke.mjs', [], 'served over HTTP like GitHub Pages: boot, map, tabs, autosave'],
  ['core-api', 'core-api.mjs', [], 'core APIs on fixtures (data, geo, io, project, logos)'],
  ['contracts', 'contracts.mjs', [], 'every MT.* path used by a module exists; events wired'],
  ['roundtrip', 'data-roundtrip.test.mjs', [], 'saved stores.csv/stores.js/chains.js = shipped bytes; data fields; cards; example project'],
  ['i18n', 'i18n-check.mjs', [], 'ES/EN parity, keys used in code, runtime missing keys'],
  ['layout', 'layout.test.mjs', [], 'deterministic marker declutter'],
  ['maps-core', 'maps-core.mjs', [], 'M1 map, slide, markers, legend, radius, render'],
  ['maps-ui', 'maps-ui.test.mjs', [], 'M2 Mapas tab'],
  ['db', 'db.test.mjs', [], 'M3 database, chains, import/export, OSM scan (mocked)'],
  ['osm-rules', 'osm-rules.test.mjs', [], 'in-app OSM scan = seed rules (data/chains.js) vs stores.csv'],
  ['export', 'export.test.mjs', [], 'M4 PNG / PPTX / HTML exports'],
  ['robustness', 'robustness.test.mjs', [], 'review fixes: import encodings, tabs, folder copies, missing files'],
  ['styleguide', 'styleguide.mjs', [], 'design-system catalogue renders'],
  ['e2e', 'e2e.mjs', [], 'full user journey in ES and EN'],
  ['net', 'net.mjs', [], 'live Nominatim / Overpass through MT.geo', 'network'],
  ['tech-proof', 'tech-proof.mjs', [], 'TECH-NOTES evidence (live services)', 'network'],
];

const only = list(args.only), skip = list(args.skip);
const retries = Math.max(0, +args.retries || 0);
const chosen = SUITES.filter(([name, , , , tag]) => {
  if (only.length) return only.includes(name);
  if (skip.includes(name)) return false;
  if (tag === 'network' && !args.network) return false;
  return true;
});

function runOne(name, script, extra) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const log = createWriteStream(path.join(LOGS, `${name}.log`));
    const child = spawn(process.execPath, [path.join(HERE, script), ...extra], { cwd: path.resolve(HERE, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let ok = 0, fail = 0, tail = [];
    const onData = (buf) => {
      const text = buf.toString();
      log.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (/^\s+ok\s/.test(line)) ok++;
        else if (/^\s+FAIL\s/.test(line)) { fail++; tail.push(line.trim()); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { log.write(b); const s = b.toString().trim(); if (s) tail.push(s.split('\n')[0]); });
    // Hard limit per suite: a hung browser must not block the whole run.
    const timer = setTimeout(() => { tail.push('killed after 20 min'); child.kill(); }, 20 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ code, ok, fail, secs: Math.round((Date.now() - t0) / 1000), tail: tail.slice(0, 6) });
    });
  });
}

console.log(`Running ${chosen.length} suite(s): ${chosen.map((s) => s[0]).join(', ')}\n`);
const results = [];
for (const [name, script, extra, what] of chosen) {
  process.stdout.write(`▶ ${name.padEnd(11)} ${what}\n`);
  let r = await runOne(name, script, extra), attempts = 1;
  while (r.code !== 0 && attempts <= retries) {
    process.stdout.write(`  ↻ retrying ${name} (${r.fail} failure(s) on attempt ${attempts})\n`);
    r = Object.assign(await runOne(name, script, extra), { retried: true });
    attempts++;
  }
  const status = r.code === 0 ? (r.retried ? 'FLAKY' : 'PASS') : 'FAIL';
  results.push({ name, status, ...r });
  process.stdout.write(`  ${status.padEnd(5)} ${String(r.ok).padStart(4)} ok  ${String(r.fail).padStart(3)} failed  ${String(r.secs).padStart(4)} s  → out/logs/${name}.log\n`);
  if (r.code !== 0) r.tail.forEach((l) => process.stdout.write(`        ${l}\n`));
}

const total = results.reduce((a, r) => a + r.ok, 0);
const failed = results.filter((r) => r.status === 'FAIL');
console.log('\nSummary');
console.log('  suite        status   checks   time');
for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.status.padEnd(7)} ${String(r.ok).padStart(6)}   ${String(r.secs).padStart(4)} s`);
console.log(`\n${total} checks passed in ${results.length - failed.length}/${results.length} suites` + (failed.length ? ` — FAILED: ${failed.map((r) => r.name).join(', ')}` : ' — all green'));
process.exitCode = failed.length ? 1 : 0;
