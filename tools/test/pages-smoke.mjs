// tools/test/pages-smoke.mjs — the app served over HTTP, as on GitHub Pages (not file://).
//
// Serves a copy of the app (prepareApp: real data, fixtures only for missing files) from a tiny
// static server on 127.0.0.1 that caches like GitHub Pages (max-age=600, ETag) and checks that it
// boots, that MT.env sees an http origin, that every tab mounts, that the slide map renders and that
// the project autosave works — zero console errors.
// (GitHub Pages is https, but nothing in the app depends on the scheme beyond file: vs. not file:.)
//
//   node tools/test/pages-smoke.mjs             the repo's files as they are
//   node tools/test/pages-smoke.mjs --stamped   the deploy of .github/workflows/pages.yml: the site copied
//                                               and stamped by tools/stamp-assets.mjs (?v=<hash> on every
//                                               local URL, MT_BUILD, version.json) — ARCHITECTURE §16

import { mkdirSync, readFileSync, existsSync, statSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareApp, launch, collectErrors, makeChecker, screenshot, waitForMapIdle, splitNetworkNoise, loadDemoProject, sleep, servePages, DATA_FILES, FIXTURES } from './lib.mjs';
import { copySite, stampSite } from '../stamp-assets.mjs';

const STAMPED = process.argv.includes('--stamped');
const { check, finish } = makeChecker(STAMPED ? 'pages-stamped' : 'pages');
let dir, version = null;
if (STAMPED) {
  dir = path.join(os.tmpdir(), `mapa-tiendas-test-${Date.now()}-site`);
  mkdirSync(dir, { recursive: true });
  copySite(dir);
  for (const [rel, fx] of DATA_FILES) {       // fixtures only for data files the checkout lacks
    const target = path.join(dir, rel);
    if (!(existsSync(target) && statSync(target).size > 0) && existsSync(path.join(FIXTURES, fx))) cpSync(path.join(FIXTURES, fx), target);
  }
  stampSite(dir, { commit: 'test' });
  version = JSON.parse(readFileSync(path.join(dir, 'version.json'), 'utf8'));
} else ({ dir } = prepareApp({ fixtures: 'missing' }));
const srv = await servePages(dir);
const url = srv.url('index.html?lang=es');
console.log(`serving ${dir} at ${url}${STAMPED ? ` (stamped, build ${version.build})` : ''}`);

const browser = await launch();
try {
  const [page] = await browser.pages();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = collectErrors(page);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true, { timeout: 30000 });
  const env = await page.evaluate(() => ({ isFile: MT.env.isFile, protocol: location.protocol, missing: MT.data.missing, stores: MT.data.stores().length,
    endpoints: MT.geo.overpassEndpoints().map((u) => new URL(u).host) }));
  check(!env.isFile && env.protocol === 'http:', `served over HTTP (MT.env.isFile=${env.isFile})`);
  check(env.stores > 0 && !env.missing.stores && !env.missing.districts, `data loaded from the server (${env.stores} stores)`);
  console.log(`  info Overpass order off file://: ${env.endpoints.join(' → ')}`);
  if (STAMPED) {
    const s = await page.evaluate(async () => {
      const local = [...document.querySelectorAll('script[src],link[rel=stylesheet][href]')].map((el) => el.getAttribute('src') || el.getAttribute('href')).filter((u) => !/^(https?:|data:|blob:)/.test(u));
      const v = await MT.app.checkVersion({ force: true });
      await MT.vendor.xlsx();                      // lazily loaded: its URL is stamped too (MT.assetUrl)
      const lazy = [...document.querySelectorAll('script[src*="xlsx.full.min.js"]')].map((el) => el.getAttribute('src'));
      return { build: MT.app.build, local: local.length, bare: local.filter((u) => !/\?v=[0-9a-f]{8}$/.test(u)), v, lazy, xlsx: !!window.XLSX,
        banner: !!document.querySelector('[data-mt-update]'), modules: Object.keys(MT.modules || {}).length };
    });
    check(s.build === version.build, `index.html carries the deploy's build (MT_BUILD ${s.build} = version.json ${version.build})`);
    check(s.local >= 45 && s.bare.length === 0, `every local script / stylesheet of the page has ?v=<hash> (${s.local} URLs${s.bare.length ? '; bare: ' + s.bare.slice(0, 4).join(', ') : ''})`);
    check(s.v && s.v.outdated === false && s.v.latest === version.build && !s.banner, 'version.json read past the cache: same build, no "new version" banner');
    check(s.xlsx && s.lazy.length === 1 && s.lazy[0] === `vendor/xlsx/xlsx.full.min.js?v=${version.files['vendor/xlsx/xlsx.full.min.js']}`, `lazily loaded SheetJS uses its stamped URL (${s.lazy[0]})`);
    check(s.modules >= 32, `every app script declared its contract version (${s.modules} modules; the boot check passed)`);
  }
  await loadDemoProject(page);
  await waitForMapIdle(page, { timeout: 60000 });
  await sleep(500);
  const map = await page.evaluate(() => ({ n: MT.mapview.items().length, title: MT.project.currentMap().title }));
  check(map.n > 0, `slide map rendered with ${map.n} markers (${map.title})`);
  await screenshot(page, STAMPED ? 'pages-stamped-maps' : 'pages-maps');
  for (const id of ['analysis', 'db', 'chains', 'maps']) {
    await page.evaluate((id) => MT.app.showTab(id), id);
    await sleep(600);
  }
  check(await page.evaluate(() => MT.app.tabs().every((t) => t.mounted && !t.failed)), 'every tab mounts');
  const nMaps = await page.evaluate(() => { MT.project.rename('Proyecto en Pages'); return MT.project.maps().length; });
  await sleep(700);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true, { timeout: 30000 });
  check(await page.evaluate((n) => MT.project.current().name === 'Proyecto en Pages' && MT.project.maps().length === n, nMaps), 'autosave survives a reload on the http origin');
  const { real, noise } = splitNetworkNoise(errors);
  if (noise.length) console.log(`  info ${noise.length} transient tile request failure(s)`);
  check(real.length === 0, `zero console errors${real.length ? ': ' + real.slice(0, 4).join(' | ') : ''}`);
} finally {
  await browser.close();
  await srv.close();
}
finish();
