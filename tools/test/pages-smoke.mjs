// tools/test/pages-smoke.mjs — the app served over HTTP, as on GitHub Pages (not file://).
//
// Serves a copy of the app (prepareApp: real data, fixtures only for missing files) from a tiny
// static server on 127.0.0.1 and checks that it boots, that MT.env sees an http origin, that every
// tab mounts, that the slide map renders and that the project autosave works — zero console errors.
// (GitHub Pages is https, but nothing in the app depends on the scheme beyond file: vs. not file:.)
//
//   node tools/test/pages-smoke.mjs

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareApp, launch, collectErrors, makeChecker, screenshot, waitForMapIdle, splitNetworkNoise, loadDemoProject, sleep } from './lib.mjs';

const { check, finish } = makeChecker('pages');
const { dir } = prepareApp({ fixtures: 'missing' });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(dir, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?lang=es`;
console.log(`serving ${dir} at ${url}`);

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
  await loadDemoProject(page);
  await waitForMapIdle(page, { timeout: 60000 });
  await sleep(500);
  const map = await page.evaluate(() => ({ n: MT.mapview.items().length, title: MT.project.currentMap().title }));
  check(map.n > 0, `slide map rendered with ${map.n} markers (${map.title})`);
  await screenshot(page, 'pages-maps');
  for (const id of ['db', 'chains', 'maps']) {
    await page.evaluate((id) => MT.app.showTab(id), id);
    await sleep(600);
  }
  check(await page.evaluate(() => MT.app.tabs().every((t) => t.mounted)), 'every tab mounts');
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
  server.close();
}
finish();
