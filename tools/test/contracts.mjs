// tools/test/contracts.mjs — integration check of the module contracts (docs/ARCHITECTURE.md).
//
// Every `MT.a.b.c` path referenced anywhere in js/*.js must exist at runtime once the app has
// booted and every tab has been mounted (catches renamed/missing APIs between modules built in
// parallel). Also checks: no namespace is still a stub (except the PENDING_STUBS of the phase being
// built), the MT.analysis engine exposes its API, every tab/menu entry the docs promise is
// registered, and the documented events have listeners where a module depends on them.
//
//   node tools/test/contracts.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openApp, makeChecker, ROOT } from './lib.mjs';

const { check, finish } = makeChecker('contracts');

// Paths that are optional by design (always typeof-guarded where used).
const OPTIONAL = new Set([
  'MT.db', 'MT.db.openStore',            // alternative entry point M2 tries before MT.dbui
  'MT.theme.basemap.cssWidth',           // optional theme override read by MT.layout
  'MT.render.overlay',                   // mentioned in comments only
]);
// Namespaces that are still stubs ON PURPOSE while a phase is being built (docs/ARCHITECTURE.md §8).
// (Phase 2a's Análisis tab, MT.analysisui, is built: none pending.)
const PENDING_STUBS = new Set([]);
// Trailing segments that are methods of built-in values (arrays, strings, promises).
const BUILTIN = new Set(['forEach', 'map', 'filter', 'some', 'every', 'slice', 'indexOf', 'then', 'catch',
  'length', 'find', 'reduce', 'concat', 'join', 'includes', 'push', 'call', 'apply', 'bind', 'toFixed']);

function collectRefs() {
  const dir = path.join(ROOT, 'js');
  const refs = new Map(); // path -> [files]
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(path.join(dir, f), 'utf8');
    // Skip the exported HTML page's own script templates? They reference window.__mtPage, not MT.
    for (const m of src.matchAll(/\bMT\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
      let parts = m[0].split('.');
      while (parts.length > 2 && BUILTIN.has(parts[parts.length - 1])) parts.pop();
      // Skip refs that are immediately followed by digits in the source (e.g. MT.theme.ref2in is
      // matched fully because \w includes digits) — nothing to do.
      const p = parts.join('.');
      if (!refs.has(p)) refs.set(p, new Set());
      refs.get(p).add(f);
    }
  }
  return refs;
}

const refs = collectRefs();
console.log(`${refs.size} distinct MT.* paths referenced in js/*.js`);

const { browser, page, errors } = await openApp({ lang: 'es' });
try {
  // Mount every tab so lazily-defined helpers exist.
  await page.evaluate(async () => {
    for (const t of MT.app.tabs()) { MT.app.showTab(t.id); await new Promise((r) => setTimeout(r, 150)); }
    MT.app.showTab('maps');
  });
  await new Promise((r) => setTimeout(r, 500));

  const result = await page.evaluate((paths) => {
    const out = {};
    for (const p of paths) {
      let v = window;
      let ok = true;
      for (const seg of p.split('.')) {
        if (v === null || v === undefined || !(seg in Object(v))) { ok = false; break; }
        v = v[seg];
      }
      out[p] = ok;
    }
    return out;
  }, [...refs.keys()]);

  const missing = Object.keys(result).filter((p) => !result[p] && !OPTIONAL.has(p));
  for (const p of missing) check(false, `${p} is referenced by ${[...refs.get(p)].join(', ')} but does not exist at runtime`);
  check(missing.length === 0, `all ${Object.keys(result).length - [...OPTIONAL].filter((p) => p in result).length} referenced MT.* paths resolve at runtime`);

  const info = await page.evaluate(() => {
    const stubs = Object.keys(MT).filter((k) => MT[k] && typeof MT[k] === 'object' && MT[k].stub === true);
    if (MT.export && MT.export.stub) stubs.push('export');
    return {
      stubs,
      analysis: MT.analysis && !MT.analysis.stub ? ['refFromStore', 'refFromPoint', 'resolveRef', 'distancesFrom', 'ringSummary', 'nearest',
        'neighborMatrix', 'closePairs', 'storesForRegion', 'index', 'bearing', 'compass', 'forMap'].filter((k) => typeof MT.analysis[k] !== 'function') : null,
      tabs: MT.app.tabs().map((t) => `${t.id}#${t.hash}`),
      listeners: Object.fromEntries(['map:changed', 'map:selected', 'stores:changed', 'chains:changed', 'logos:changed',
        'lang:changed', 'store:click', 'project:loaded', 'app:showChanges', 'view:changed', 'mapview:layout']
        .map((e) => [e, MT.bus.count(e)])),
      exportApi: ['png', 'pptx', 'html', 'run', 'dialog'].filter((k) => typeof MT.export[k] === 'function'),
      mapsui: MT.mapsui ? Object.keys(MT.mapsui) : [],
      dbui: MT.dbui ? ['select', 'openEditor', 'importFile', 'saveToFolder'].filter((k) => typeof MT.dbui[k] === 'function') : [],
    };
  });
  const unexpected = info.stubs.filter((s) => !PENDING_STUBS.has(s));
  check(unexpected.length === 0, `no stub namespaces left (${unexpected.join(', ') || 'none'}; pending on purpose: ${info.stubs.filter((s) => PENDING_STUBS.has(s)).join(', ') || 'none'})`);
  check(Array.isArray(info.analysis) && info.analysis.length === 0, `MT.analysis engine exposes its API (${info.analysis === null ? 'missing or stub' : 'missing: ' + (info.analysis.join(', ') || 'none')})`);
  check(info.tabs.join(' ') === 'maps#mapas analysis#analisis db#base chains#cadenas', `tabs registered in order: ${info.tabs.join(' ')}`);
  for (const [e, n] of Object.entries(info.listeners)) check(n > 0, `event '${e}' has ${n} listener(s)`);
  check(info.exportApi.length === 5, `MT.export exposes png/pptx/html/run/dialog (${info.exportApi.join(', ')})`);
  check(info.dbui.length === 4, `MT.dbui exposes select/openEditor/importFile/saveToFolder`);
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
} finally {
  await browser.close();
}
finish();
