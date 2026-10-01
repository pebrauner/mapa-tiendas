// tools/test/lib.mjs — headless-Chrome test harness for Mapa de Tiendas.
//
// The app must run from file:// with no server, so tests do exactly that:
//   1. copy the app (index.html, css/, js/, vendor/, data/, logos/) into a temp folder,
//   2. inject tools/fixtures/* for any data file that is missing (the real data is produced by a
//      separate workflow and may not exist yet),
//   3. open file:///<temp>/index.html in the system Chrome (puppeteer-core, no bundled browser),
//   4. collect console errors, uncaught page errors and failed requests.
//
// Usage:
//   import { openApp, screenshot, waitForMapIdle, loadDemoProject } from './lib.mjs';
//   const { browser, page, errors } = await openApp({ lang: 'es' });
//   await screenshot(page, 'boot-es');
//   await browser.close();

import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');           // repo root
export const OUT = path.join(HERE, 'out');                     // screenshots / artifacts
export const FIXTURES = path.join(ROOT, 'tools', 'fixtures');

export const CHROME = process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');

// WebGL in headless Chrome: there is no GPU, so ANGLE must use the SwiftShader software
// rasteriser. Since Chrome 137 the automatic SwiftShader fallback is gone, so it has to be
// requested explicitly with --enable-unsafe-swiftshader (see docs/TECH-NOTES.md §4).
export const WEBGL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

// Data files the app reads as globals; fixtures are injected only for the missing ones.
export const DATA_FILES = [
  ['data/stores.js', 'stores.js'],
  ['data/chains.js', 'chains.js'],
  ['data/districts.js', 'districts.js'],
  ['logos/logos.js', 'logos.js'],
];

const APP_ENTRIES = ['index.html', 'css', 'js', 'vendor', 'data', 'logos', 'favicon.svg', 'favicon.ico'];

/** Launch the system Chrome (headless by default) with WebGL enabled. */
export async function launch({ headless = true, args = [], devtools = false } = {}) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  return puppeteer.launch({
    executablePath: CHROME,
    headless: headless ? true : false,
    devtools,
    defaultViewport: null,
    args: [...WEBGL_ARGS, '--window-size=1440,900', '--lang=es-PE', ...args],
  });
}

/**
 * Copy the app to a temp folder and inject fixtures.
 * @param {object} o
 * @param {'missing'|'all'|'none'} [o.fixtures='missing'] which data files to replace by fixtures
 * @returns {{dir:string, url:string, injected:string[]}}
 */
export function prepareApp({ fixtures = 'missing' } = {}) {
  const dir = path.join(os.tmpdir(), `mapa-tiendas-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of APP_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(dir, entry), { recursive: true });
  }
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  mkdirSync(path.join(dir, 'logos'), { recursive: true });
  const injected = [];
  for (const [rel, fx] of DATA_FILES) {
    const target = path.join(dir, rel);
    const has = existsSync(target) && statSync(target).size > 0;
    const want = fixtures === 'all' || (fixtures === 'missing' && !has);
    if (fixtures === 'none') continue;
    if (want && existsSync(path.join(FIXTURES, fx))) {
      cpSync(path.join(FIXTURES, fx), target);
      injected.push(rel);
    }
  }
  if (fixtures === 'none') {
    // Simulate a fresh checkout without any generated data: remove whatever was copied.
    for (const [rel] of DATA_FILES) rmSync(path.join(dir, rel), { force: true });
  }
  return { dir, url: pathToFileURL(path.join(dir, 'index.html')).href, injected };
}

/** Remove temp copies older than an hour (best effort). */
export function cleanupTemp() {
  const tmp = os.tmpdir();
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith('mapa-tiendas-test-')) continue;
    const p = path.join(tmp, name);
    try { if (Date.now() - statSync(p).mtimeMs > 3600e3) rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Attach listeners that collect problems into `errors` (strings). */
export function collectErrors(page, errors = []) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push(`console.error: ${msg.text()}${loc && loc.url ? ` (${path.basename(loc.url)}:${loc.lineNumber})` : ''}`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err && err.message ? err.message : err}`));
  page.on('requestfailed', (req) => {
    const f = req.failure();
    const reason = f ? f.errorText : 'unknown';
    // MapLibre aborts tile requests it no longer needs while panning/zooming — not an error.
    if (reason === 'net::ERR_ABORTED') return;
    errors.push(`requestfailed: ${req.url().slice(0, 160)} (${reason})`);
  });
  return errors;
}

/**
 * Open the app from file:// in a fresh profile (clean IndexedDB / localStorage).
 * @param {object} [o]
 * @param {'es'|'en'} [o.lang='es']            UI language (passed as ?lang=, which also persists it)
 * @param {'missing'|'all'|'none'} [o.fixtures='missing']
 * @param {{width:number,height:number,deviceScaleFactor?:number}} [o.viewport]
 * @param {boolean} [o.headless=true]
 * @param {string} [o.hash]                    optional URL hash
 * @param {boolean} [o.waitBoot=true]          wait for MT.app.booted
 * @param {Function} [o.onNewDocument]         script run in the page before any app script (and
 *                                             again after every reload), e.g. to hide browser APIs
 * @returns {Promise<{browser, page, errors:string[], dir:string, url:string, injected:string[]}>}
 */
export async function openApp({ lang = 'es', fixtures = 'missing', viewport = { width: 1440, height: 900 },
  headless = true, hash = '', waitBoot = true, timeout = 30000, onNewDocument = null } = {}) {
  cleanupTemp();
  const { dir, url, injected } = prepareApp({ fixtures });
  const browser = await launch({ headless });
  const [first] = await browser.pages();
  const page = first || await browser.newPage();
  await page.setViewport({ deviceScaleFactor: 1, ...viewport });
  const errors = collectErrors(page);
  if (onNewDocument) await page.evaluateOnNewDocument(onNewDocument);
  const full = `${url}?lang=${lang}${hash ? '#' + hash : ''}`;
  await page.goto(full, { waitUntil: 'load', timeout });
  if (waitBoot) {
    await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true, { timeout });
  }
  return { browser, page, errors, dir, url: full, injected };
}

/** Save a PNG screenshot to tools/test/out/<name>.png and return its path. */
export async function screenshot(page, name, opts = {}) {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  return file;
}

/** Write a data URL (e.g. canvas.toDataURL()) to tools/test/out/<name>. */
export function saveDataUrl(dataUrl, name) {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}

/**
 * Wait until a MapLibre map in the page is fully rendered ('idle': style, tiles and
 * transitions done). `expr` is a JS expression evaluated in the page that returns the map.
 */
export async function waitForMapIdle(page, { expr = 'window.MT && MT.mapview && MT.mapview.getMap && MT.mapview.getMap()', timeout = 45000 } = {}) {
  await page.waitForFunction(`!!(${expr})`, { timeout });
  return page.evaluate(async (expr, timeout) => {
    // eslint-disable-next-line no-eval
    const map = (0, eval)(expr);
    const done = () => map.loaded() && map.isStyleLoaded() && map.areTilesLoaded() && !map.isMoving();
    if (done()) return true;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitForMapIdle: timeout')), timeout);
      map.once('idle', () => { clearTimeout(t); resolve(true); });
      map.triggerRepaint();
    });
  }, expr, timeout);
}

/**
 * Load tools/fixtures/demo.mapa.json (4 maps mirroring the reference slides: Lima Metropolitana Sur,
 * Lima Cono Sur, Trujillo, Chimbote) into the running app through MT.project.open.
 * Returns the map ids. opts.select: map index to select (default 0).
 */
export async function loadDemoProject(page, { select = 0 } = {}) {
  const json = readFileSync(path.join(FIXTURES, 'demo.mapa.json'), 'utf8');
  return page.evaluate(async (json, select) => {
    await MT.project.open(new File([json], 'demo.mapa.json', { type: 'application/json' }));
    const ids = MT.project.maps().map((m) => m.id);
    MT.project.select(ids[select]);
    return ids;
  }, json, select);
}

/**
 * Let the page download files into `dir` (default tools/test/out/downloads, emptied first) — for
 * tests of MT.io.download / exports. Returns the folder.
 */
export async function captureDownloads(page, dir = path.join(OUT, 'downloads')) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  return dir;
}

/** Wait until a downloaded file whose name matches `pattern` (RegExp) is complete; returns its path. */
export async function waitForDownload(dir, pattern, { timeout = 30000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = readdirSync(dir).find((f) => pattern.test(f) && !f.endsWith('.crdownload'));
    if (hit) return path.join(dir, hit);
    await sleep(150);
  }
  throw new Error(`download matching ${pattern} not found in ${dir}`);
}

/**
 * Split collected errors into app problems and transient network failures of third-party map
 * tiles (OpenFreeMap connection resets/timeouts happen on any network and MapLibre retries them).
 * Console errors and page errors are never treated as noise.
 */
const NET_NOISE = /^requestfailed: https:\/\/tiles\.openfreemap\.org\/.*\((net::ERR_(CONNECTION_CLOSED|CONNECTION_RESET|TIMED_OUT|NETWORK_CHANGED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|SSL_PROTOCOL_ERROR|CONNECTION_TIMED_OUT|EMPTY_RESPONSE))\)$/;
export function splitNetworkNoise(errors) {
  const real = [], noise = [];
  for (const e of errors) (NET_NOISE.test(e) ? noise : real).push(e);
  return { real, noise };
}

/** Small sleep helper (prefer explicit waits). */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print a compact pass/fail line and remember failures. */
export function makeChecker(label = 'test') {
  const failures = [];
  const check = (ok, msg) => {
    console.log(`${ok ? '  ok ' : '  FAIL'} ${msg}`);
    if (!ok) failures.push(msg);
    return ok;
  };
  const finish = () => {
    if (failures.length) {
      console.log(`\n${label}: ${failures.length} failure(s)`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log(`\n${label}: all checks passed`);
    }
    return failures;
  };
  return { check, finish, failures };
}
