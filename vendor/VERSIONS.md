# Vendored libraries

Everything the app needs at runtime is in this folder (no CDN), so `index.html` works from
`file://` and from GitHub Pages. All files are loaded as **classic `<script>` tags** and expose a
global (verified by `tools/test/core-api.mjs`). Pinned on 2026-10-01.

| Library | Version | File(s) | Global | License | Source |
|---|---|---|---|---|---|
| MapLibre GL JS | **5.24.0** (latest 5.x) | `maplibre/maplibre-gl.js`, `maplibre/maplibre-gl.css` | `maplibregl` | BSD-3-Clause (`maplibre/LICENSE.txt`) | npm `maplibre-gl@5.24.0` `dist/` (UMD build, worker inlined as a blob → works from file://) |
| PptxGenJS | **4.0.1** | `pptxgenjs/pptxgen.bundle.js` (includes JSZip) | `PptxGenJS` | MIT (`pptxgenjs/LICENSE`) | npm `pptxgenjs@4.0.1` `dist/pptxgen.bundle.js` |
| SheetJS Community Edition | **0.20.3** | `xlsx/xlsx.full.min.js` | `XLSX` | Apache-2.0 (`xlsx/LICENSE`) | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js |
| Turf | **7.4.0** | `turf/turf.min.js` | `turf` | MIT (`turf/LICENSE`) | npm `@turf/turf@7.4.0` |
| topojson-client | **3.1.0** | `topojson/topojson-client.min.js` | `topojson` | ISC (`topojson/LICENSE`) | npm `topojson-client@3.1.0` `dist/` |
| Instrument Sans (variable, latin) | fontsource 5.3.0 | `fonts/instrument-sans-latin-wght-normal.woff2` | — (CSS) | OFL-1.1 (`fonts/LICENSE-instrument-sans.txt`) | npm `@fontsource-variable/instrument-sans` |
| Bricolage Grotesque (variable, latin) | fontsource 5.3.0 | `fonts/bricolage-grotesque-latin-wght-normal.woff2` | — (CSS) | OFL-1.1 (`fonts/LICENSE-bricolage-grotesque.txt`) | npm `@fontsource-variable/bricolage-grotesque` |
| Carlito 400/700 (latin; metric-compatible with Calibri) | fontsource 5.3.0 | `fonts/carlito-latin-{400,700}-normal.woff2` | — (CSS) | OFL-1.1 (`fonts/LICENSE-carlito.txt`) | npm `@fontsource/carlito` |

`fonts/fonts.css` is **generated** by `node tools/build-fonts.mjs`: it inlines the four WOFF2 files
as data URIs (≈175 KB) so fonts load from `file://` in every browser and canvases stay untainted.

## Loading strategy (index.html)

- Eager: `maplibre-gl.js` (+ css), `turf.min.js`, `topojson-client.min.js`.
- Lazy (first use): SheetJS through `MT.vendor.xlsx()`, PptxGenJS through `MT.vendor.pptx()` —
  injected `<script>` tags, which also work from `file://`. Together ≈1.4 MB that most sessions never need.

## Integrity (sha256, first 16 hex chars)

| File | Bytes | sha256 |
|---|---|---|
| maplibre/maplibre-gl.js | 1,056,837 | 45a9b07a9189ce56… |
| maplibre/maplibre-gl.css | 70,024 | ab1e70d59ec40465… |
| pptxgenjs/pptxgen.bundle.js | 460,889 | 4fb9eac5cfefb213… |
| xlsx/xlsx.full.min.js | 951,904 | cc015130aa8521e7… |
| turf/turf.min.js | 547,400 | 5db5dda50210fa0f… |
| topojson/topojson-client.min.js | 7,169 | 25cd02ae486cc506… |

## Updating

```bash
npm pack maplibre-gl@5 pptxgenjs @turf/turf@7 topojson-client@3   # in a scratch folder, then copy dist files
curl -O https://cdn.sheetjs.com/xlsx-<ver>/package/dist/xlsx.full.min.js
node tools/test/core-api.mjs   # checks the globals and versions
```
MapLibre 6.x (6.11.2 at the time of writing) is **not usable here**: its package ships ES modules only
(`"module": "dist/maplibre-gl.mjs"`, no `main`/UMD), and ES modules do not load from `file://`. Stay on
the 5.x line (classic UMD bundle with an inlined worker). The interactive-HTML export references the same version from a pinned CDN URL
(`https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js`).
