# Mapa de Tiendas — Specification (v1)

A zero-install web tool that keeps a **master database of retail stores in Peru** and turns any
region into a **presentation-ready store map** (editable PowerPoint, PNG, interactive HTML).
It replaces hand-placing chain logos on map screenshots.

Owner: Pedro (GitHub `pebrauner`). Repo: `pebrauner/mapa-tiendas` (public) + GitHub Pages.
Local folder: `Z:\mapa-tiendas`.

---

## 1. Decisions (from requirements Q&A, 2026-09-30)

| Topic | Decision |
|---|---|
| Store universe | Auto-scan finds **all stores of all tracked chains** → one **master database**; user adds/edits manually later. Individual stores can be hidden per map. |
| Data source at runtime | **OpenStreetMap only** (Overpass API) — no API keys, no billing. Manual add must be fast: address search (Nominatim), click on map, or paste coordinates / a Google Maps URL. |
| Seed data | Pre-filled for **all of Peru**: OSM nationwide scan + web research of each chain's store locator to fill gaps; web-only stores flagged `to_verify`. |
| Outputs | **All four**: editable PPTX slide(s), PNG map only, PNG full slide, interactive HTML map. |
| Distribution | Static folder (double-click `index.html`) **and** GitHub Pages. Public repo. No install. |
| Marker style | Default **uniform logo badges**: same-size circle, logo inside, ring in brand color, small dot at the exact location, crowded badges spread apart automatically with thin leader lines. Other styles available as a per-map switch: `card` (natural-shape logo on a rounded white card), `dot` (brand-color dots, logos only in legend), `number` (numbered pins + store table). |
| Region | Built by **picking districts** (all Peru districts bundled). Subtitle and zoom are automatic. Toggles: **"only stores inside the selected districts"** (default ON) and **"show district borders"** (default OFF). |
| Basemap | **Clean light grey** — MapLibre GL + OpenFreeMap `positron` (free, no key, commercial OK). POIs hidden, Spanish labels preferred. Attribution always shown. |
| Logos | Collected by us (official sources), stored in repo; user can upload replacements/new chains in the app. Generated name badge is the fallback when a chain has no logo. |
| Coverage | **All of Peru**. |
| Legend | **By chain with store count**, e.g. `PLAZA VEA (6)`; built only from what is visible on the map; each chain has an editable legend name (e.g. Makro → `CASH & CARRY`). |
| Peso | **Typed by the user** per map (free text, e.g. `15.8%`). |
| UI language | **Spanish / English toggle** (default from browser language; remembered). Slide text is Spanish and editable. |
| Chains | Supermarkets: Plaza Vea, Tottus, Wong, Metro, Vivanda · Discount: Tiendas 3A, Mass, Precio Uno, Maxiahorro, Dollarcity · Wholesale: Makro, Vega · Specialty: Flora y Fauna, Holi · Convenience: Tambo, Oxxo. **Every chain toggleable**; Tambo & Oxxo default OFF. Users can add chains. |
| Slide look | **Replicate the current red layout** (16:9): title + districts + Peso on top, map left, red "Tiendas" legend panel right. Theme values centralized in one place. |
| Radius / cannibalization | **Basic version in v1**: click a store → circle of 500 m / 1 km / custom; list & count stores inside (same chain vs competitors, with distances); circles appear in all exports; results exportable to Excel. Full analysis (nearest-competitor for all stores, overlap matrix, heatmap) = phase 2. |

---

## 2. Hard technical constraints

1. **Works from `file://`** in Chrome/Edge (primary) and from GitHub Pages. Firefox best effort.
   - **No ES modules**, no build step. Classic `<script>` tags, one global namespace `window.MT`.
   - **No `fetch()` of local files.** Local data ships as `.js` files assigning globals (see §3).
   - **Images drawn on canvas must be data URIs** (file:// images taint the canvas). Logos are
     bundled as data URIs in `logos/logos.js`.
2. **Libraries vendored** in `vendor/` (pinned versions, with their LICENSE files). Runtime network
   needs only: OpenFreeMap (tiles/style/fonts/sprites), Overpass API (scan), Nominatim (address search).
3. **Respect public-service policies**: Nominatim max 1 request/second, no search-as-you-type
   (search on Enter/button only), identify via Referer. Overpass: one query at a time, endpoint
   fallback list, sensible timeouts, split large areas.
4. **WYSIWYG**: the map preview in the app is exactly what gets exported (same bounds, same
   marker layout), only at higher resolution.
5. **Attribution** "© OpenStreetMap contributors · OpenFreeMap" visible on maps and in every export.
   Store data derived from OSM is ODbL — note this in README.
6. Deterministic marker layout (no randomness) so re-exports are identical.

---

## 3. Data contracts

### 3.1 Stores — `data/stores.csv` (canonical) and `data/stores.js` (generated)

CSV: UTF-8 with BOM, comma separator, RFC-4180 quoting, header row, columns **in this order**:

| column | type | notes |
|---|---|---|
| `id` | string | stable unique id: `osm-n123` / `osm-w456` / `osm-r789` (OSM type+id), `web-<chain>-<slug>`, `man-<base36 timestamp>` |
| `chain` | string | chain id (§3.2) |
| `name` | string | store name as commonly known, e.g. `Plaza Vea Angamos` |
| `address` | string | street address |
| `district` | string | district name (INEI spelling, proper case with accents) |
| `province` | string | |
| `department` | string | |
| `ubigeo` | string | 6-digit INEI district code, e.g. `150122` (Miraflores) — from point-in-polygon |
| `lat` | number | WGS84, 6 decimals |
| `lng` | number | WGS84, 6 decimals |
| `precision` | enum | `exact` (OSM/official coordinates or user-placed) · `approx` (geocoded address) |
| `source` | enum | `osm` · `web` · `manual` · `import` |
| `source_ref` | string | OSM `n123`/`w456`, or URL of the store locator |
| `status` | enum | `verified` · `to_verify` · `closed` (closed stores are kept but never drawn) |
| `notes` | string | |
| `updated` | date | `YYYY-MM-DD` |

`data/stores.js`:
```js
window.MT_SEED = { generated: "2026-10-01", count: 1234, columns: [...], stores: [ {id, chain, ...}, ... ] };
```
Generated from the CSV by `node tools/build-data.mjs` (and written by the app's "Save to folder").

### 3.2 Chains — `data/chains.js`

```js
window.MT_CHAINS = [
  { id: "plazavea", name: "Plaza Vea", legendName: "PLAZA VEA", group: "super",
    color: "#E30613", owner: "InRetail (Supermercados Peruanos)", defaultOn: true,
    website: "https://www.plazavea.com.pe", storeLocator: "https://...",
    osm: { wikidata: ["Q..."], nameRegex: "plaza\\s*vea", shops: ["supermarket"] },
    logo: "plazavea" /* key in MT_LOGOS; null → generated badge */ },
  ...
];
```
`group` ∈ `super` | `discount` | `wholesale` | `specialty` | `convenience`.

Chain ids (fixed): `plazavea`, `tottus`, `wong`, `metro`, `vivanda`, `tiendas3a`, `mass`,
`preciouno`, `maxiahorro`, `dollarcity`, `makro`, `vega`, `florayfauna`, `holi`, `tambo`, `oxxo`.

### 3.3 Logos — `logos/<id>.png`, `logos/<id>-wide.png`, `logos/logos.js`

- `logos/<id>.png`: **square badge mark**, 512×512, transparent or brand-colored background,
  designed to read inside a circle (prefer the brand's app icon / social avatar / favicon mark).
- `logos/<id>-wide.png`: horizontal wordmark (natural aspect, transparent, trimmed), max 512 px wide —
  used by the `card` marker style. Optional.
- `logos/logos.js`: `window.MT_LOGOS = { plazavea: { badge: "data:image/png;base64,...", wide: "data:..." }, ... }`
  (badge downscaled to 256×256 to keep the file small).

### 3.4 Districts — `data/districts.js`

```js
window.MT_DISTRICTS = { /* TopoJSON Topology */ type: "Topology", objects: { districts: {...} }, ... };
```
Each district feature `properties`: `{ ubigeo, district, province, department }` (names in proper
case with accents). All of Peru (~1,890 districts). Simplified to keep the file ≲ 3 MB while district
shapes still look right at city zoom.

### 3.5 Project file — `*.mapa.json` (user's PC, not in repo)

```json
{ "type": "mapa-tiendas-project", "version": 1, "name": "Estudio X", "updated": "...",
  "maps": [ {
    "id": "m1", "title": "Lima Metropolitana Sur",
    "subtitle": "", "subtitleAuto": true,           // auto = "(Miraflores, San Borja, San Isidro, Surquillo)"
    "peso": "15.8%",
    "districts": ["150122","150130","150131","150141"],
    "chains": { "plazavea": true, "tambo": false, ... },
    "onlyInside": true, "showBorders": false, "fitTo": "stores",   // stores | districts
    "markerStyle": "badge", "markerSize": 1.0, "legendSort": "alpha", // alpha | count
    "groupNearby": "auto",                            // auto | true | false — same-chain grouping (§4.2)
    "view": null,                                     // null = auto-fit; else {center:[lng,lat], zoomRef}
    "hiddenStores": ["osm-n123"],
    "markerOffsets": { "osm-n456": { "dx": 0.031, "dy": -0.02 } },   // manual drags, fraction of frame width
    "radius": [ { "storeId": "osm-n789", "meters": 1000 } ]
  } ] }
```

### 3.6 Local edits (browser)

Seed (`MT_SEED`, `MT_CHAINS`, `MT_LOGOS`) + a **local overlay** in IndexedDB
(`added`, `edited`, `deleted` stores; edited/added chains and uploaded logos) → merged view.
UI shows "N unsaved local changes". Persist options:
- **Save to folder** (File System Access API, Chrome/Edge; folder handle remembered): writes
  `data/stores.csv`, `data/stores.js`, `data/chains.js`, `logos/logos.js` (+ new logo PNGs). User then commits/pushes.
- **Export** CSV / Excel (.xlsx) — and **Import** CSV/XLSX (merge by `id`, or append new rows; geocode
  rows that have an address but no coordinates, 1 req/s with progress).

---

## 4. App structure

```
index.html            app shell; loads vendor → data → js in order
css/                  one stylesheet per module (core.css, maps.css, db.css, ...)
js/                   classic scripts; each registers into window.MT
js/i18n/              per-module ES/EN dictionaries (MT.i18n.add)
data/                 stores.csv, stores.js, chains.js, districts.js
logos/                <id>.png, <id>-wide.png, logos.js
vendor/               maplibre-gl, pptxgenjs, xlsx (SheetJS), turf, topojson-client (+ licenses)
tools/                Node dev scripts (NOT needed by users): seed scans, build-data, logo build, tests
docs/                 ARCHITECTURE.md (module APIs), user guide
```

### 4.1 Screens

1. **Mapas** (map builder) — project = list of maps (slides). Left: map list (add / duplicate /
   delete / reorder) + settings for the current map: title, district picker (search all Peru,
   chips, "add whole province"), subtitle (auto/override), Peso, chain toggles grouped with counts
   (all/none per group), options (only inside, show borders, fit to stores/districts, marker style,
   marker size, legend sort), radius circles. Center: **live 16:9 slide preview** with the MapLibre
   map inside the map frame + the red legend panel. Badges draggable (manual override, "reset layout").
   Click a badge → popup (name, address, hide on this map, add radius).
2. **Base de datos** — filterable table (chain, department/province/district, status, source, text),
   side map of filtered stores, edit drawer, add store (address search / click map / paste coords or
   Google Maps URL — parse `@lat,lng`, `!3dlat!4dlng`, `?q=lat,lng`, plain `lat, lng`), drag pin to fix,
   **OSM scan** for selected districts/department & chains → review screen (New / Matched / Not found
   in OSM → possibly closed) → accept selected, import/export, save to folder, reset local changes.
3. **Cadenas** — chain list: logo (upload/replace), color, legend name, group, default on, OSM rules
   (advanced), add new chain.

### 4.2 Marker layout (declutter)

All layout in a **reference frame** (width 1000 units, height = 1000 / frameAspect) so app and
export agree. Each visible store → anchor dot at its projected location; marker placed at an
offset (default: directly above, short stem). Greedy placement from densest to sparsest using
candidate positions (rings × 16 angles), cost = overlaps with markers (heavy) + covering other
anchors + leaving frame (heavy) + leader-line crossings + distance + angle-from-up; then a few
deterministic improvement passes. Manual offsets are fixed obstacles. Leader line drawn from dot to
marker edge when displaced. On a crowded map, nearby stores of one chain are grouped into one logo with
a count ("×4"); every store keeps its dot and its count in the legend (per map: auto / on / off); faint
spokes in the chain colour tie each grouped store's dot to its logo, and a key under the legend explains
"×N" and the dots. Basemap labels a marker, dot or leader would cut are left out; the selected districts'
names are always written, off the store dots.

### 4.3 Slide layout (replicating the current deck, 16:9 = 13.333 × 7.5 in)

- Left area background very light grey `#F3F4F6`; title centered over the map, Calibri bold ~24 pt,
  black; subtitle line grey `#6B7280` ~12 pt: `(districts)  Peso: 15.8%` with the value bold,
  underlined, navy `#1F3864`.
- Map frame ≈ x 0.35 in, y 0.85 in, w 7.75 in, h 6.5 in.
- Right panel x ≈ 8.55 in → right edge, full height: crimson gradient (`#D42A4C` → `#8E1631`) with
  large faint translucent circles; heading "Tiendas" white bold ~18 pt; legend rows = marker icon +
  legend name (+ count) white bold ~16 pt uppercase, vertically centered; 2 columns or smaller font if many rows.
- All values live in `MT.theme` so the look can be adjusted in one place.

### 4.4 Exports

- **PNG map only** — map frame at 3× (2×–4× selectable): basemap + borders (if on) + radius
  circles + leader lines + dots + markers + attribution.
- **PNG full slide** — 3840×2160 (or 1920×1080): complete slide as above.
- **PowerPoint (.pptx)** via PptxGenJS — one slide per map (current map or whole project): basemap
  image (+ borders/radius circles baked in or as shapes) as a picture; **each marker as its own
  picture**, leader lines as line shapes, title/subtitle/Peso as real text, legend rows as picture +
  text box — all editable in PowerPoint. `number` style adds a store-table slide.
- **Interactive HTML** — one standalone file (MapLibre from CDN, data + logos inline): title,
  legend with per-chain toggles and counts, popups with store details, radius circles.

---

## 5. Phase 2 (not in v1)
Full cannibalization analysis (nearest competitor for every store, overlap matrix, density heatmap,
catchment comparison), batch "re-scan all Peru" with change report, multi-user shared database.
