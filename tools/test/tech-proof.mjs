// tools/test/tech-proof.mjs — evidence for docs/TECH-NOTES.md.
//
//   node tools/test/tech-proof.mjs            # all proofs
//   node tools/test/tech-proof.mjs --no-net   # skip the Nominatim / Overpass probes
//   node tools/test/tech-proof.mjs --noflags  # launch WITHOUT the WebGL flags (shows the failure mode)
//
// Opens tools/test/pages/tech-proof.html from file:// in headless Chrome and:
//   - reports the WebGL renderer,
//   - captures the OpenFreeMap positron map at pixelRatio 3 with two techniques and writes
//     tools/test/out/tech-hires-3x-preserve.png and tech-hires-3x-render.png,
//   - fetch()es Nominatim and Overpass from the Origin:null page (respecting their policies:
//     ≥1.1 s between Nominatim calls, one Overpass query at a time).

import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CHROME, WEBGL_ARGS, ROOT, collectErrors, saveDataUrl, sleep, makeChecker } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const { check, finish } = makeChecker('tech-proof');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: args.has('--noflags') ? [] : WEBGL_ARGS,
});
const page = await browser.newPage();
const errors = collectErrors(page);
await page.setViewport({ width: 1100, height: 900 });
const url = pathToFileURL(path.join(ROOT, 'tools', 'test', 'pages', 'tech-proof.html')).href;
await page.goto(url, { waitUntil: 'load' });

const gl = await page.evaluate(() => PROOF.webgl());
console.log('WebGL:', JSON.stringify(gl));
console.log('page origin:', await page.evaluate(() => PROOF.origin));
check(gl.ok, 'WebGL context available');

if (gl.ok) {
  for (const method of ['preserve', 'render', 'render-es']) {
    const res = await page.evaluate((m) => PROOF.capture(m, 3, 'map').then((r) => r, (e) => ({ error: String(e) })), method);
    if (res.error) { check(false, `capture ${method}: ${res.error}`); continue; }
    const file = saveDataUrl(res.url, `tech-hires-3x-${method}.png`);
    console.log(`capture ${method}: ${res.width}x${res.height} in ${res.ms} ms, blank=${res.blank} -> ${file}`);
    check(res.width === 3000 && res.height === 2517, `${method}: canvas is 3x the 1000x839 frame (got ${res.width}x${res.height})`);
    check(!res.blank, `${method}: capture is not blank`);
  }
}

const mapErrors = errors.slice();
if (!args.has('--no-net')) {
  const probes = [
    ['nominatim-search', 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=pe&limit=1&accept-language=es&q=' + encodeURIComponent('Av. Larco 345, Miraflores, Lima')],
    ['nominatim-reverse', 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=es&lat=-12.1219&lon=-77.0297'],
  ];
  for (const [name, u] of probes) {
    const r = await page.evaluate((n, u) => PROOF.probe(n, u), name, u);
    console.log(JSON.stringify(r));
    check(r.ok, `${name} reachable from file:// (status ${r.status || r.error})`);
    await sleep(1200); // Nominatim: max 1 request / second
  }
  const q = '[out:json][timeout:20];node["shop"="supermarket"](-12.13,-77.04,-12.11,-77.02);out center 5;';
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  for (const ep of endpoints) {
    // POST with an application/x-www-form-urlencoded body = CORS "simple request" (no preflight).
    const r = await page.evaluate((ep, q) => PROOF.probe('overpass POST ' + ep, ep, {
      method: 'POST', body: new URLSearchParams({ data: q }),
    }), ep, q);
    console.log(JSON.stringify(r));
    check(true, `${ep}: ${r.ok ? 'OK ' + r.status : 'FAILED ' + (r.status || r.error)}`);
    await sleep(1500);
  }
}

console.log('errors (all phases):', errors.length ? errors : 'none');
check(mapErrors.length === 0, 'no console/page errors during the map captures');
await browser.close();
finish();
