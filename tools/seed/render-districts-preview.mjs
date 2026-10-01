#!/usr/bin/env node
// render-districts-preview.mjs — renders a PNG of district shapes from data/districts.js
// (the simplified app file) using headless Chrome, to eyeball shape quality.
//
//   node tools/seed/render-districts-preview.mjs [lima|lima-sur|trujillo|chimbote|peru] [--zoom N] [--hi] [--out file.png]
//
//   --hi   overlay the high-detail tools/seed/districts.geojson outline in red (quality check)
//   zoom   Web-Mercator zoom the pixels correspond to (default per area)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { readDistrictsJs, topoFeatures } from './topo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const AREAS = {
  // Lima Metropolitana = Lima province (1501) + Callao (0701)
  lima: { keep: (p) => /^(1501|0701)/.test(p.ubigeo), zoom: 11 },
  'lima-sur': { bbox: [-77.06, -12.32, -76.84, -12.08], zoom: 13 },
  trujillo: { keep: (p) => /^1301/.test(p.ubigeo), bbox: [-79.12, -8.20, -78.92, -7.98], zoom: 13 },
  chimbote: { bbox: [-78.65, -9.20, -78.45, -8.98], zoom: 13 },
  peru: { zoom: 6, noLabels: true },
};

const argv = process.argv.slice(2);
const areaName = argv.find((a) => !a.startsWith('--') && AREAS[a]) || 'lima';
const area = AREAS[areaName];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const zoom = Number(opt('--zoom', area.zoom));
const withHi = argv.includes('--hi');
const out = path.resolve(opt('--out', path.join(HERE, `preview-${areaName}${withHi ? '-hi' : ''}.png`)));

const topo = readDistrictsJs(path.join(ROOT, 'data', 'districts.js'));
let feats = topoFeatures(topo, area.keep || (() => true));
const intersects = (b, c) => !(b[2] < c[0] || b[0] > c[2] || b[3] < c[1] || b[1] > c[3]);
if (area.bbox) feats = feats.filter((f) => intersects(f.bbox, area.bbox));

let bbox = area.bbox;
if (!bbox) {
  bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of feats) { bbox[0] = Math.min(bbox[0], f.bbox[0]); bbox[1] = Math.min(bbox[1], f.bbox[1]); bbox[2] = Math.max(bbox[2], f.bbox[2]); bbox[3] = Math.max(bbox[3], f.bbox[3]); }
}

// Web Mercator pixels at the given zoom
const S = 256 * 2 ** zoom;
const mx = (lng) => ((lng + 180) / 360) * S;
const my = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * S; };
const pad = 20;
const x0 = mx(bbox[0]) - pad, y0 = my(bbox[3]) - pad;
const W = Math.ceil(mx(bbox[2]) - x0 + pad), H = Math.ceil(my(bbox[1]) - y0 + pad);
const P = ([lng, lat]) => `${(mx(lng) - x0).toFixed(1)},${(my(lat) - y0).toFixed(1)}`;
const ringPath = (ring) => 'M' + ring.map(P).join('L') + 'Z';
const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

const palette = ['#dbeafe', '#fde68a', '#bbf7d0', '#fecaca', '#e9d5ff', '#fed7aa', '#a5f3fc', '#f5d0fe', '#d9f99d', '#e5e7eb'];
let svg = '';
let labels = '';
feats.forEach((f, i) => {
  const d = polysOf(f.geometry).map((poly) => poly.map(ringPath).join('')).join('');
  svg += `<path d="${d}" fill="${palette[i % palette.length]}" fill-rule="evenodd" stroke="#374151" stroke-width="${area.noLabels ? 0.4 : 1}"/>`;
  // label at the area-weighted centroid of the largest outer ring
  let best = null, bestA = 0;
  for (const poly of polysOf(f.geometry)) {
    const r = poly[0].map(([a, b]) => [mx(a) - x0, my(b) - y0]);
    let A = 0, cx = 0, cy = 0;
    for (let k = 0, j = r.length - 1; k < r.length; j = k++) { const c = r[j][0] * r[k][1] - r[k][0] * r[j][1]; A += c; cx += (r[j][0] + r[k][0]) * c; cy += (r[j][1] + r[k][1]) * c; }
    if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = [cx / (3 * A), cy / (3 * A)]; }
  }
  if (!area.noLabels && best && best[0] > 0 && best[0] < W && best[1] > 0 && best[1] < H) {
    labels += `<text x="${best[0].toFixed(1)}" y="${best[1].toFixed(1)}">${f.properties.district}</text>`;
  }
});

let hiSvg = '';
if (withHi) {
  const hi = JSON.parse(readFileSync(path.join(HERE, 'districts.geojson'), 'utf8'));
  const codes = new Set(feats.map((f) => f.properties.ubigeo));
  for (const f of hi.features) {
    if (!codes.has(f.properties.ubigeo)) continue;
    const d = polysOf(f.geometry).map((poly) => poly.map(ringPath).join('')).join('');
    hiSvg += `<path d="${d}" fill="none" stroke="#dc2626" stroke-width="0.8" stroke-opacity="0.9"/>`;
  }
}

const title = `${areaName} — ${feats.length} districts — data/districts.js (simplified)${withHi ? ' + red: high-detail' : ''} — zoom ${zoom}`;
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
text{font:600 11px Segoe UI,Arial,sans-serif;fill:#111827;text-anchor:middle;paint-order:stroke;stroke:#fff;stroke-width:3px}
.t{font:600 13px Segoe UI,Arial,sans-serif;text-anchor:start}
</style><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#f8fafc"/>${svg}${hiSvg}${labels}<text class="t" x="8" y="16">${title}</text></svg>`;

const tmp = path.join(os.tmpdir(), 'mt-districts-preview');
mkdirSync(tmp, { recursive: true });
const htmlFile = path.join(tmp, `${areaName}.html`);
writeFileSync(htmlFile, html);
const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${W},${H}`, `--screenshot=${out}`, pathToFileURL(htmlFile).href], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log(`wrote ${out} (${W}×${H}px, ${feats.length} districts)`);
