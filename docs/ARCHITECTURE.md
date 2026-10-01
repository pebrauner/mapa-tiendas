# Mapa de Tiendas — Architecture & module contracts

Source of truth for decisions and data formats: [`SPEC.md`](../SPEC.md). Verified technical facts:
[`TECH-NOTES.md`](TECH-NOTES.md). Live component catalogue: [`styleguide.html`](styleguide.html)
(double-click it). This document is the **API reference** every module builder codes against.

---

## 1. Ground rules (SPEC §2)

1. Runs by **double-clicking `index.html`** (`file://`, Chrome/Edge) and on GitHub Pages.
2. **Classic `<script>` tags only** — no ES modules, no bundler, no framework. Each file is an IIFE
   that attaches to the single global namespace **`window.MT`**. ES5-compatible style is used in core
   (`var`, `function`), but ES2017+ syntax (arrow functions, `const`, template literals, `async`) is
   fine in modules: Chrome/Edge are the targets.
3. **No `fetch()` of local files.** Data arrives as globals: `MT_SEED` (data/stores.js),
   `MT_CHAINS` (data/chains.js), `MT_DISTRICTS` (data/districts.js), `MT_LOGOS` (logos/logos.js).
   Any of them may be **missing or broken** (a separate data workflow regenerates them) — read them
   only through `MT.data` / `MT.logos`, which degrade gracefully.
4. **Canvas safety:** anything drawn on a canvas must be a data URI or a generated canvas
   (`MT.logos.get(id).badge`, `MT.logos.image(id)`). An `<img src="logos/x.png">` taints the canvas
   on `file://`.
5. **Libraries only from `vendor/`** (see `vendor/VERSIONS.md`). Heavy ones are lazy:
   `await MT.vendor.xlsx()`, `await MT.vendor.pptx()`. The interactive-HTML export is the only place
   allowed to reference a pinned CDN URL.
6. **Network etiquette:** Nominatim and Overpass are reached **only** through `MT.geo`
   (1 req/s queue, one Overpass query at a time, endpoint fallback). Never call `fetch` on them directly.
7. **Deterministic** marker layout and exports (no `Math.random`, stable sorting).
8. **Attribution** `MT.theme.attribution.text` visible on every map and every export.
9. **i18n:** every user-visible string goes through `MT.t()` / `data-i18n` (ES + EN, Spanish first,
   Peruvian business wording). Slide content (title, "Peso:", "Tiendas", legend names) is Spanish
   data, not UI — it comes from the project and `MT.theme`.

---

## 2. Files and ownership

| Path | Owner | Notes |
|---|---|---|
| `index.html`, `css/core.css`, `js/{mt,theme,i18n,storage,geo,io,data,project,ui,app}.js`, `js/i18n/core.js` | **Foundation** | change only via the foundation |
| `vendor/**`, `tools/test/**`, `tools/fixtures/**`, `tools/package.json`, `tools/build-fonts.mjs`, `docs/ARCHITECTURE.md`, `docs/TECH-NOTES.md`, `docs/styleguide.html`, `.gitignore` | **Foundation** | |
| `js/mapview.js`, `js/layout.js`, `js/markers.js`, `js/slide.js`, `js/render.js`, `js/radius.js`, `js/legend.js`, `css/maps.css`, `js/i18n/map.js` | **M1** map core & rendering | |
| `js/ui-maps.js`, `css/maps-ui.css`, `js/i18n/maps-ui.js` | **M2** Mapas tab UI | |
| `js/ui-db.js`, `js/ui-chains.js`, `js/osm.js`, `css/db.css`, `js/i18n/db.js` | **M3** database, chains, OSM, import/export UI | |
| `js/export-png.js`, `js/export-pptx.js`, `js/export-html.js`, `js/i18n/export.js` | **M4** exports | M4 has no CSS file; reuse core classes (add `css/export.css` + link it in index.html via the foundation if really needed) |
| `data/*`, `logos/*`, `tools/seed/**`, `tools/{scan-osm,build-districts,merge,build-data,build-logos}.mjs` | **Data workflow** | **never write these from app modules** |

Module files currently contain **stubs** whose header comment repeats the contract below; replace the
whole file. A stub sets `stub: true` on its namespace — remove that flag in the real implementation.

---

## 3. Load order (index.html)

```
<head>  vendor/maplibre/maplibre-gl.css · vendor/fonts/fonts.css · css/core.css · css/maps.css · css/maps-ui.css · css/db.css
<body>  #mt-splash · #mt-app
  vendor:  maplibre-gl.js (maplibregl) · turf.min.js (turf) · topojson-client.min.js (topojson)
  data:    window.MT_MISSING = [] ; data/chains.js · data/stores.js · data/districts.js · logos/logos.js   (each with onerror → MT_MISSING.push(path))
           js/example-project.js (window.MT_EXAMPLE_PROJECT, `data-optional`: a load error does not stop the app)
  core:    mt.js · theme.js · i18n.js · i18n/core.js · storage.js · geo.js · io.js · data.js · project.js · ui.js · app.js
  dicts:   i18n/map.js · i18n/maps-ui.js · i18n/db.js · i18n/export.js
  M1:      layout.js · markers.js · legend.js · radius.js · mapview.js · slide.js · render.js
  M3:      osm.js · ui-db.js · ui-chains.js
  M4:      export-png.js · export-pptx.js · export-html.js
  M2:      ui-maps.js
  boot:    <script>MT.app.start();</script>
```

At **script-evaluation time** a module may only *define* things (namespaces, functions, tab and menu
registrations, bus listeners). Data is available after `MT.data.ready` resolves; `MT.app.start()`
awaits it, restores the project, renders the shell, then mounts the first tab. Code that runs later
(tab `mount`, event handlers) can use everything synchronously.

Adding a file: add the `<script>`/`<link>` tag in the right group of `index.html` (ask the foundation
owner) and add it to the list above.

---

## 4. Core API reference

### 4.1 `MT` basics — js/mt.js

| API | Description |
|---|---|
| `MT.version` | `'1.0.0'` |
| `MT.env` | `{isFile, fsAccess, saveFilePicker, missingFiles[]}` |
| `MT.bus.on(event, fn) → off()` | subscribe; returns an unsubscribe function |
| `MT.bus.once(event, fn) → off()` · `MT.bus.off(event, fn)` · `MT.bus.emit(event, payload)` | synchronous; a throwing handler is logged and skipped |
| `MT.util.$(sel, root?)`, `MT.util.$$(sel, root?) → Element[]` | query helpers |
| `MT.util.h(tag, attrs?, ...children) → Element` | element builder. attrs: `class`, `style` (string or object), `dataset`, `html` (trusted innerHTML), `text`, `on<event>` functions, booleans (`false`/`null` omit), anything else → attribute. Children: nodes, strings, arrays, null |
| `MT.util.append(el, children)`, `MT.util.clear(el)` | |
| `MT.util.debounce(fn, ms)` (+ `.cancel()`, `.flush()`), `MT.util.throttle(fn, ms)` | |
| `MT.util.nextFrame() → Promise`, `MT.util.sleep(ms) → Promise` | |
| `MT.util.uid(prefix?) → 'm-lx3k9a-1'` | |
| `MT.util.escapeHtml(s)` | always escape data put into `html:` |
| `MT.util.normalize(s)` | accent/case/punctuation-insensitive search form: `"Víctor  LARCO"` → `"victor larco"` |
| `MT.util.slug(s)` | `"Plaza Vea Angamos"` → `"plaza-vea-angamos"` |
| `MT.util.collator`, `MT.util.compare(a, b)`, `MT.util.sortBy(arr, keyFn) → new array` | Spanish collation (Ñ after N, accents ignored), stable |
| `MT.util.clamp`, `round(v, digits)`, `clone` (JSON), `isEqual` (JSON), `todayISO()`, `luminance(hex)`, `isHexColor(s)` | |
| `MT.loadScript(src) → Promise` | classic script injection (works on file://), deduplicated |
| `MT.vendor.xlsx() → Promise<XLSX>`, `MT.vendor.pptx() → Promise<PptxGenJS>` | lazy vendor loading |

### 4.2 `MT.theme` — js/theme.js

All look-and-feel constants (SPEC §4.3). **Never hard-code** a slide/marker colour, size or font in a
module — read it here so the deck can be restyled in one place.

| Key | Content |
|---|---|
| `slide` | `{width: 13.333, height: 7.5, aspect, background, leftArea:{x,y,w,h,color:'#F3F4F6'}}` (inches) |
| `title` | `{x, y, w, h, font:'Calibri', sizePt:24, bold, color:'#000000', align:'center'}` |
| `subtitle` | `{x, y, w, h, font, sizePt:12, minSizePt:9, maxLines:2, color:'#6B7280', align, pesoLabelColor, peso:{color:'#1F3864', bold, underline}, gap}` |
| `mapFrame` | `{x:0.35, y:0.85, w:7.75, h:6.5, aspect, background, border}` |
| `panel` | `{x:8.55, y:0, w, h, gradient:{from:'#D42A4C', to:'#8E1631', angleDeg:160}, circles:[{cx,cy,r,alpha}]}` (panel-local inches) |
| `legend` | `{heading:{text:'Tiendas', sizePt:18, …}, row:{sizePt:16, minSizePt:11, heightIn:0.47, uppercase…}, icon:{sizeIn, gapIn}, showCount, area:{x,y,w,h}, maxRowsPerColumn:11, columnGapIn, headingGapIn}` |
| `frame` | **reference frame** `{refWidth:1000, refHeight:≈838.7, aspect, padding:60}` |
| `marker` | `{defaults:{style:'badge', size:1, minSize:0.6, maxSize:1.6}, styles[], badge:{diameter:46, ring:3.5, background, logoInset, shadow}, card:{height, maxWidth, padding, radius, background, borderWidth, shadow}, dot:{radius, stroke, strokeWidth}, number:{diameter, fontSize, color, stroke, strokeWidth}, anchorDot:{radius, stroke, strokeWidth}, stem:9, leader:{color, width, alpha, halo:{color, width, alpha}}, declutter:{rings[], angles:16, minGap, passes, maxLeader, aggregate:{radius:1.2, radiusStep, radiusMax, minCount:2, autoMinStores, autoLongRatio, autoLongShare, autoDisplacedShare}}, countPip:{diameter, fontSize, prefix:'×', stroke, strokeWidth, at}, collapsed:{radius, stroke, strokeWidth}}` (reference units) |
| `borders` | district outline `{color, width, alpha, dash, fill}` |
| `radius` | `{stroke, width, dash, fill, presets:[500,1000], label}` |
| `attribution` | `{text:'© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap', fontSize, color, background, padding, position}` |
| `colors` | `{crimson, crimsonDark, accent, navy, text, textMuted, unknownChain, white, black}` |
| `fonts` | `{slide:'Calibri', slideCss:"Calibri, Carlito, …", ui, display, mapLabels:['Noto Sans Regular'], mapLabelsBold}` |
| `basemap` | `{style:'https://tiles.openfreemap.org/styles/positron', labelLayers[], spanishTextField, maxCanvasSize:4096, districtLabel:{size:[[zoom,px]…], color, letterSpacing}, majorRoadNames:{minzoom, size:[[zoom,px]…]}}` |
| `export` | `{mapScales:[2,3,4], mapScale:3, slideWidths:[3840,1920], slideWidth:3840}` |
| helpers | `in2px(in, slidePx)`, `pt2px(pt, slidePx)`, `ref2in(units)`, `in2ref(in)`, `ref2px(units, framePx)`, `pt2ref(pt)`, `markerDims(style, size) → {w, h, k}`, `panelCss()` |

**Reference frame (SPEC §4.2):** the map frame is always **1000 units wide** and `refHeight` tall,
whatever its pixel size. Layout, marker sizes, offsets, leader lines and radius strokes live in these
units, so the preview (any width) and the exports (1000 × scale px) are identical.

### 4.3 `MT.i18n` / `MT.t` — js/i18n.js

| API | Description |
|---|---|
| `MT.t(key, vars?)` | translate; `{placeholders}`; plural values `{one, other}` chosen by `vars.n` (or `vars.count`); falls back to the other language, then to the key (and warns once) |
| `MT.i18n.add(lang, dict)` | merge a nested or flat dictionary (`{maps:{addMap:'…'}}` ≡ `{'maps.addMap':'…'}`) |
| `MT.i18n.lang` · `MT.i18n.langs` · `MT.i18n.setLang(lang)` | `setLang` persists (`localStorage['mt.lang']`), sets `<html lang>`, re-applies the DOM, emits `'lang:changed'` |
| `MT.i18n.applyDom(root)` | translates `data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria` (aria-label); `data-i18n-vars='{"n":3}'` |
| `MT.i18n.has(key, lang?)`, `keys(lang?)`, `missingKeys()` | coverage checks (the smoke test fails on missing keys and on ES/EN key mismatch) |
| `MT.i18n.locale()` | `'es-PE'` / `'en-US'` |
| `MT.i18n.formatNumber(n, opts)`, `formatDate(d, opts)`, `formatDistance(m)` | `"850 m"`, `"1,2 km"` |

Initial language: `?lang=es|en` URL parameter (also persisted) → saved preference → browser
(`es*` → es, else en). **Static markup** should carry `data-i18n*` attributes so `setLang` updates it
in place; content you render from JS should re-render on `'lang:changed'`.

Shared vocabulary already in `js/i18n/core.js` (reuse it): `common.*` (ok, cancel, close, save, delete,
edit, add, remove, search, apply, reset, restore, undo, retry, back, next, done, yes, no, all, none,
show, hide, more, copy, duplicate, moveUp, moveDown, export, import, loading, working, required,
confirmTitle, notAvailable, unknown, comingSoon), `data.group.<group>`, `data.status.<status>`,
`data.source.<source>`, `data.precision.<precision>`, `data.state.<seed|added|edited|deleted>`,
`data.col.<column>`, `data.stores` / `data.districts` (plurals), `geo.error.<empty|invalid|shortlink|range>`,
`geo.notInPeru`, `geo.swapped`, `geo.searchFailed`, `geo.noResults`, `geo.overpassUnavailable`,
`storage.*`, `io.*`, `project.*`, `tab.*`.

### 4.4 `MT.storage` — js/storage.js

| API | Description |
|---|---|
| `MT.storage.ready → Promise` · `MT.storage.persistent` · `MT.storage.localUsable` | IndexedDB `mapa-tiendas` opened (false → in-memory fallback) · localStorage writable. When either is false the shell shows a red banner (`storage.notPersistent`, `storage.atRisk.*`) with *Guardar el proyecto* / *Guardar en carpeta*, and asks before leaving with unsaved work. `ready` also calls `navigator.storage.persist()` (best effort) |
| `MT.storage.channel.post(type, data)` · `.on(fn(msg)) → off()` · `.id` | messages between tabs of the app in this browser (BroadcastChannel + localStorage `storage` event, de-duplicated by nonce) |
| `getAll(store)`, `get(store, id)`, `put(store, record|records[])`, `delete(store, id|ids[])`, `clear(store)` | stores: `'stores'`, `'chains'`, `'logos'`, `'kv'` — **modules should use `MT.data`/`MT.logos` instead** |
| `kvGet(key)`, `kvSet(key, value)` | misc persisted values (structured-cloneable, e.g. file handles) |
| `pref(key, fallback)`, `setPref(key, value)` | small JSON preferences in localStorage (`mt.pref.<key>`), never throw — use for UI state like sort order, panel widths |
| `local.get/set/remove(k)` | raw localStorage that never throws |
| `fs.supported` | File System Access API available (Chrome/Edge, also on file://) |
| `fs.remembered() → Promise<handle|null>`, `fs.folderName()`, `fs.pickFolder()`, `fs.ensureFolder({pick?})`, `fs.looksLikeApp(handle)`, `fs.writeFiles(handle, [{path, data}])`, `fs.forget()` | folder handle persisted in IndexedDB; `ensureFolder` re-requests permission — **call from a click handler** |
| `fs.isRunningFolder(handle) → Promise<true|false|null>` | file:// only (null elsewhere): writes `mt-folder-check.js` with a nonce, loads it from the running page, removes it. All file:// copies of the app share one remembered handle, so after an update it may point at an OLD copy |
| `saveToFolder(files, {pick?, forceDownload?}) → Promise<{method:'folder'|'download', folder?, written[]}>` | high level: folder write, or one download per file when unsupported |

### 4.5 `MT.geo` — js/geo.js

| API | Description |
|---|---|
| `parseCoords(text) → {lat, lng, source, inPeru, swapped?} | null` | accepts `"-12.1219, -77.0297"`, `"-12.1219 -77.0297"`, `"-12,1219; -77,0297"`, `"12.12 S 77.03 W/O"`, Google Maps URLs (`!3d…!4d…` pin preferred, `@lat,lng`, `?q=`, `query=`, `ll=`, `center=`); swaps `lng, lat` typed for Peru |
| `parseCoordsDetailed(text)` | same, or `{error: 'empty'|'invalid'|'shortlink'|'range'}` → show `MT.t('geo.error.' + error)` |
| `inPeru(lat, lng)`, `PERU_BBOX` | |
| `distanceMeters(a, b)` | haversine; points as `{lat, lng}` or `[lng, lat]` |
| `bboxOfPoints(points)`, `bboxUnion(boxes)`, `bboxPad(b, frac)`, `bboxMinSize(b, meters)`, `bboxContains(b, lat, lng)`, `bboxToBounds(b)` | bboxes are `[west, south, east, north]` |
| `zoomForWidth(zoomRef, widthPx)`, `zoomRefFor(zoom, widthPx)` | saved views use **zoomRef** = MapLibre zoom when the frame is 1000 px wide |
| `project([lng,lat], zoom) → [x,y]`, `unproject([x,y], zoom)` | Web Mercator in a 512·2^z world (MapLibre's) |
| `viewBounds(view, refW?, refH?) → bbox` | area covered by a saved `{center, zoomRef}` view |
| `search(q, {limit, signal, bbox}) → Promise<place[]>` | Nominatim, Peru only, Spanish; **only on explicit submit**. place = `{lat, lng, label, name, type, category, street, district, address, bbox, osm}` |
| `reverse(lat, lng, {signal}) → Promise<place|null>` | |
| `geocodeBatch(items[{query,…}], onProgress(done, total, item, place, failure), {signal, maxFailures=3}) → Promise<[{item, place, error?, status?}]>` | sequential at 1 req/s, abortable. `failure` = `{error, status}` when the SERVICE failed (≠ address not found). Stops on HTTP 429/403, when offline, or after `maxFailures` failures in a row; `results.stopped = {error, status} | null` |
| `overpassEndpoints() → string[]` | ordered by context (file:// → mirrors first; see TECH-NOTES §4.2) |
| `overpass(query, {signal, timeoutMs, onStatus}) → Promise<{json, endpoint, timestamp}>` | one at a time, fallback; `timestamp` = OSM data date to show users; rejects `Error('overpass-unavailable')` with `.details`, `.offline` (browser offline: no request sent) and `.network` (every server failed without an HTTP answer) |
| `abortError()` | DOMException AbortError helper |

### 4.6 `MT.io` — js/io.js

| API | Description |
|---|---|
| `parseCSV(text, {delimiter?}) → rows[][]` · `detectDelimiter(text)` | RFC 4180, BOM, CRLF, quoted newlines; auto `,` `;` tab — the delimiter that splits most of the first 12 lines into the same number of fields wins, so a title row above a `;` header works |
| `stringifyCSV(rows, {bom=true, delimiter=','}) → string` | CRLF, BOM |
| `mapHeaders(headerRow) → [{index, header, column|null}]` | tolerant matching (Spanish/English aliases, accents/case ignored). A generic "Código"/"code" is **not** an id alias (client store codes must never update our stores) |
| `storesToRows(stores) → rows` (header first, SPEC §3.1 order) · `rowsToStores(rows) → {stores, errors[{row, message}], unknownColumns[], missingColumns[]}` | chain may be id, name or legend name; coordinates via `parseCoord`; a Peru point typed as lng/lat is swapped; status via `parseStatus`; `updated` via `parseDate`; 5-digit ubigeo repaired; rows without coords kept (NaN) for geocoding. Each store has a non-enumerable `_flags {swapped, outside}` |
| `parseCoord(v)` · `parseStatus(v)` · `parseDate(v)` | "-12,08", "12.08 S", "77°03'W" → number (S/W/O negative; junk → NaN) · words → enum (closed/inactive → `closed`, unknown → `to_verify`) · ISO, D/M/YYYY (day first), Excel serials, Dates → `YYYY-MM-DD` or '' |
| `decodeText(arrayBuffer) → string` | UTF-8 (BOM or not), UTF-16 BOMs; anything not valid UTF-8 is Windows-1252 (Excel's "CSV (delimitado por comas)") |
| `storesToCSV(stores)`, `storesFromCSV(text)` | |
| `readXLSX(arrayBuffer, {sheet?}) → Promise<rows>` · `writeXLSX([{name, rows, colWidths?, numberColumns?}]) → Promise<Blob>` · `storesToXLSX(stores, sheetName?)` | SheetJS lazy-loaded. Cells are read as stored **values** (a coordinate in a 2-decimal "Número" column keeps its full precision); dates → `YYYY-MM-DD` |
| `readTable(file) → Promise<rows>` | `.csv/.txt/.xlsx/.xls/.ods`; text files decoded with `decodeText` |
| `sortStores(stores, {chainOrder?}) → new array` | the canonical row order of `data/stores.csv` / `data/stores.js` = **exactly** `tools/build-data.mjs`: chain in `data/chains.js` order (unknown ids after, by id), then department, province, district, name — accent/case-folded (`NFD`, marks removed, lower case) and compared by code units, not locale collation — then id. Also used by the DB tab's CSV/Excel export |
| `storesJs(stores, {generated?, chainOrder?})`, `storesCsvFile(stores)`, `chainsJs(chains, osmRules?)`, `logosJs({id:{badge, wide}})` | file contents for `data/stores.js` (byte for byte what build-data generates from the CSV: same header comment, `generated` = latest `updated`), `data/stores.csv` (sorted), `data/chains.js` (byte for byte what `tools/merge.mjs` writes: same header, key order, every `osm` key, `ringColor` always, then the `window.MT_OSM_RULES` block from `MT.data.osmRules()` — none when the shipped file had none), `logos/logos.js` |
| `repoFiles() → [{path, data}]` | everything "Guardar en carpeta" writes (stores.csv/js, chains.js, logos.js, uploaded logo PNGs). Without local edits the store files are **byte-identical** to the shipped ones (`tools/test/data-roundtrip.test.mjs`) |
| `download(blob|string, filename, mime?)` | |
| `readAsText(file)`, `readAsDataURL(file)`, `readAsArrayBuffer(file)`, `dataUrlToBlob(url)`, `blobToDataURL(blob)`, `canvasToBlob(canvas, type?, quality?)` | |
| `safeFilename(name, fallback)`, `datedName(base, ext)` | `"Lima Sur - 2026-10-01.xlsx"` |

### 4.7 `MT.data` — js/data.js

Constants: `MT.data.COLUMNS` (SPEC §3.1 order), `GROUPS` (`super, discount, wholesale, specialty,
convenience, other`), `STATUSES` (`verified, to_verify, closed`), `SOURCES` (`osm, web, manual, import`),
`PRECISIONS` (`exact, approx`).

| API | Description |
|---|---|
| `MT.data.ready → Promise<MT.data>` | storage open, fonts loaded, seed + overlay merged |
| `MT.data.missing` | `{stores, chains, districts, logos}` booleans (file absent **or** unusable) |
| `MT.data.seedInfo` | `{generated, count}` of the shipped seed |
| **Stores** | (records are plain objects with the 16 SPEC columns; `lat`/`lng` numbers) |
| `stores({includeClosed=false, chain?, ubigeo?, status?}) → store[]` | merged list, **read-only** (shared cache when unfiltered) |
| `store(id)`, `seedStore(id)`, `storeState(id) → 'seed'|'added'|'edited'|'deleted'|null`, `deletedStores()` | |
| `newStoreId() → 'man-<base36>'` | never repeats within a session (safe for bulk imports before the records are stored) |
| `normalizeStore(record)` | typed 16-column record (used by imports) |
| `upsertStore(partial) → Promise<store>` | merges onto the current version; generates id; fills `ubigeo/district/province/department` from coordinates when they changed or are empty; `updated` = today; an edit identical to the seed removes the overlay record |
| `upsertStores(partials, {op}) → Promise<{added, updated, ids, errors}>` | bulk (imports, OSM accept) — one transaction, one event |
| `deleteStore(id)`, `restoreStore(id)` | restore = drop the local change |
| `overlayStats() → {added, edited, deleted, chains, logos, total}` | the top bar shows `total` |
| `resetOverlay({stores, chains, logos})` | discard local changes (the user confirmed) |
| `reloadOverlay() → Promise` · `overlaySnapshot() → {stores, chains, logos: {id: at}}` · `commitOverlay(snapshot?)` | re-read the overlay from IndexedDB (another tab may have written) · what a folder save is about to write · after a successful folder save: delete **only** the records written (same id and `at`), never `clear()` |
| `storeOrphan(id)` | a local edit whose shipped original disappeared from `data/stores.js` (kept as a local addition, flagged in the DB table and editor) |
| *(boot)* overlay reconciliation | edits/additions identical to the shipped seed are dropped (they were published); an edit made on an older seed keeps only the fields the user changed (3-way merge with the record's `base`); orphan edits become flagged additions; deletions of ids no longer shipped are dropped; chain edits and uploaded logos identical to the shipped ones are dropped |
| `countsByChain(stores?) → {chainId: n}` | |
| **Chains** | |
| `chains() → chain[]` | seed order, then local additions, then **unknown ids used by stores** (`unknown: true`, grey, `group:'other'`). When that set of unknown ids changes (an import, an OSM accept) `'chains:changed'` is emitted |
| `chain(id) → chain` | **never null** — unknown ids get a synthesized grey chain |
| `hasChain(id)`, `chainState(id) → 'seed'|'edited'|'added'|'unknown'|null` | |
| `upsertChain(partial) → Promise<chain>`, `restoreChain(id)`, `normalizeChain(c)`, `normalizeOsm(o, name)`, `OSM_KEYS`, `osmRules()` | chain keys: `id, name, legendName, group, color, ringColor ('' = same as color), badgeZoom (1 = as drawn; enlarges a small mark inside the badge disc), owner, defaultOn, website, storeLocator, osm, logo`; `osm` keeps **every** key of `tools/seed/OSM-RULES.md` §2 in the merge's order (`wikidata, nameRegex, excludeNameRegex, label, prefixRegex, shops, requireShopLike, dense, uniqueName, weakNameRegex, weakNameShops, excludeTags`; defaults like the merge, regexes verbatim). `upsertChain` merges a partial `osm` into the chain's current one; chain edits saved by an older version are completed from the shipped chain at load. `osmRules()` = `window.MT_OSM_RULES` as shipped (read-only) or null. `MT.io.chainsJs` writes `ringColor` (always, like the merge) and `badgeZoom` when set |
| `chainOn(mapCfg, chainId) → bool` | toggle state, defaulting to `chain.defaultOn` (Tambo/Oxxo off) |
| **Districts** `MT.data.districts` | |
| `available`, `all() → [{ubigeo, district, province, department, bbox, label}]` | label = `"Miraflores — Lima, Lima"` |
| `get(ubigeo)`, `label(ubigeo)`, `bbox(ubigeo)`, `unionBbox(ubigeos)` | |
| `feature(ubigeo) → GeoJSON Feature` (cached), `features(ubigeos) → FeatureCollection` | decoded from TopoJSON on demand |
| `search(q, {limit=20}) → ranked results` | accent-insensitive; every word must match district/province/department; district matches first; 4–6 digit codes match ubigeos; colloquial Lima/Callao names first (Surco → Santiago de Surco, Magdalena → Magdalena del Mar, Cercado, SJL, SMP, SJM, VES, VMT, Chosica…); Lima Metropolitana / Callao win word-prefix ties. Synchronous — fine to run as the user types |
| `byProvince() → [{key, province, department, ubigeos[], label}]`, `searchProvinces(q, {limit})` | for "agregar provincia completa" |
| `locate(lat, lng) → district|null` (also `MT.data.locate`) | bbox prefilter + `turf.booleanPointInPolygon` |
| **Regions** | |
| `storesForMap(mapCfg) → store[]` | status ≠ closed, chain toggled on, not in `hiddenStores`; `onlyInside` → ubigeo ∈ districts, else inside the saved view or the districts' bbox +25%; sorted by id |
| `boundsForMap(mapCfg) → bbox|null` | `fitTo:'districts'` → districts bbox; `'stores'` → stores bbox (min 800 m), falls back to districts. Unpadded: add `MT.theme.frame.padding` |
| `subtitleFor(mapCfg) → string` | `"(Miraflores, San Borja, San Isidro, Surquillo)"` (alphabetical, unique) or the manual subtitle |

### 4.8 `MT.logos` — js/data.js

| API | Description |
|---|---|
| `get(chainId) → {badge, wide, source:'overlay'|'seed'|'generated', generated}` | `badge` is **always** a PNG data URI (uploaded > shipped > generated); `wide` may be null |
| `has(chainId)` | a real (non-generated) logo exists |
| `generated(chainId)` | 256 px brand-colour circle (transparent corners) with the initials (`initials(name)`: "Plaza Vea" → PV, "Wong" → WONG, "Dollarcity" → DOL) |
| `image(chainId, 'badge'|'wide') → Promise<HTMLImageElement>` | decoded and cached — await before synchronous canvas drawing |
| `set(chainId, {badge?, wide?}) → Promise`, `remove(chainId)`, `overlay()` | uploads (emit `'logos:changed'`) |
| `fromFile(file, 'badge'|'wide') → Promise<dataURI>` | normalizes uploads: badge 256×256 contained; wide ≤512 px |

### 4.9 `MT.project` — js/project.js

Project model = SPEC §3.5. Map config fields (`mapCfg`):
`{id, title, subtitle, subtitleAuto, peso, districts[], chains{id:bool}, onlyInside, showBorders,
fitTo:'stores'|'districts', markerStyle:'badge'|'card'|'dot'|'number', markerSize (0.6–1.6),
legendSort:'alpha'|'count', groupNearby:'auto'|true|false, view:null|{center:[lng,lat], zoomRef},
hiddenStores[], markerOffsets{storeId:{dx,dy,g?}}, radius[{storeId, meters}]}`.
`markerOffsets`: marker **centre minus anchor dot**, as a fraction of the frame width; `g: 1` = a
grouped logo dragged by the user (its stores stay one group at that spot). `groupNearby`: same-chain
grouping of nearby stores (§6.1), `'auto'` by default.

| API | Description |
|---|---|
| `current() → project` (live object — read only), `maps()`, `getMap(id)`, `currentMapId()`, `currentMap()` | |
| `displayName()` · `isPlaceholder(text, key)` | the project name, or "Proyecto sin título"/"Untitled project" in the CURRENT language when unnamed. New projects and slides store an empty name/title (placeholders are never saved as data; old projects with a stored placeholder in any language are cleaned by `normalize`) |
| `flushAutosave()` · `suspendAutosave(on)` | write the pending autosave now (modules flush their own debounced edits first, also on `beforeunload`/`pagehide`) · stop/resume autosaving (a paused tab) |
| `defaultMap(partial?)` | all known chains at `defaultOn`, onlyInside true, showBorders false, fitTo stores, markerStyle badge, size 1, legendSort alpha, view null, title '' |
| `addMap(partial?, {index?, select=true}) → map` | |
| `duplicateMap(id) → map` ("… (copia)", inserted after, selected) · `removeMap(id)` (selects a neighbour) · `moveMap(id, toIndex)` | |
| `updateMap(id, patch) → map` | **top-level keys are replaced** (pass whole `chains`, `markerOffsets`, `radius`, …); no event when nothing changed |
| `select(id)` | |
| `rename(name)`, `isDirty()`, `fileName()` | dirty = not saved to a file since last change |
| `newProject(name?)` (alias `new`), `open(file|handle)`, `openDialog()`, `save({saveAs?, download?}) → Promise<{method, name}|null>` | FS Access save picker / same file on Ctrl+S; download fallback |
| `openData(obj, {name?}) → project` | open a project from a plain object (validated + copied; not tied to a file, not dirty) — used for the built-in example |
| `toJSON()`, `normalize(obj)`, `suggestedFileName()` | `normalize` validates (`project-invalid`, `project-newer`) and fills defaults; keeps unknown chain ids |
| `restore()` | used by the app at boot (localStorage autosave `mt.project.autosave`, 500 ms debounce) |
| `chainOn(map, chainId)` | = `MT.data.chainOn` |

### 4.10 `MT.ui` — js/ui.js (styles in css/core.css)

| API | Description |
|---|---|
| `icon(name, {size}) → svg string`, `iconEl(name, {size}) → <span class="mt-icon">`, `icons` | names: map, database, store, plus, copy, trash, up, down, chevronDown/Right/Left, download, upload, save, folder, folderOpen, file, filePlus, search, close, check, more, globe, warning, info, success, error, eye, eyeOff, grip, target, image, slides, code, refresh, edit, pin, undo, layers, table, sliders, link, cloudOff, keyboard |
| `button({label|i18n, icon, kind:'primary'|'secondary'|'ghost'|'danger'|'soft', size:'sm', title, i18nTitle, onClick, disabled, className})` | icon-only when no label (give a `title`) |
| `toast(message, {type:'info'|'success'|'warn'|'error', timeout, action:{label, onClick}}) → {close}` | |
| `modal({title, body, actions:[{label, kind, value, icon, autofocus, onClick(close, btn) → false keeps open}], size:'sm'|'md'|'lg'|'xl', dismissible, className, onClose}) → {el, body, close(value), result: Promise}` | focus trap, Esc, restores focus |
| `confirm(message, {title, okLabel, cancelLabel, danger}) → Promise<bool>` · `prompt(message, {title, value, placeholder, okLabel, validate(v) → error|'' , required}) → Promise<string|null>` | |
| `menu(anchor, items[{label, icon, onClick, disabled, danger, checked, shortcut, hint} | {separator:true} | {heading}], {align:'start'|'end', minWidth}) → {close}` | arrow keys, Home/End, Esc |
| `pickFile({accept, multiple}) → Promise<File|File[]|null>` | |
| `busy({title, message, progress:bool, cancellable}) → {update({progress 0..1, message}), close(), signal}` | full-screen progress; `signal` aborts |
| `switchEl({label|i18n, checked, onChange, id})`, `segmented({options:[{value, label|i18n, icon, title}], value, onChange, ariaLabel})` (`.setValue(v)`), `emptyState({icon, title|titleKey, text|textKey, action})`, `chainChip(chainId, {compact})` | |

**CSS components** (see styleguide.html): `.mt-btn`, `.mt-field/.mt-label/.mt-hint/.mt-field__error`,
`.mt-input/.mt-select/.mt-textarea` (`--sm`, `.is-invalid`), `.mt-input-group`, `.mt-check`,
`.mt-switch`, `.mt-seg` (`--compact`, `--block`), `.mt-range`, `.mt-chips/.mt-chip` (`__label`,
`__sub`, `__x`, `--accent`, `--plain`), `.mt-badge` (`--success|warn|danger|info|accent`, `--dot`),
`.mt-swatch`, `.mt-list/.mt-list__item` (`.is-active`, `__index`, `__main`, `__title`, `__sub`,
`__actions`, `.is-dragging`, `.is-drop-target`), `.mt-grip`, `.mt-table-wrap/.mt-table`
(`th.is-sortable[aria-sort]`, `tr.is-selected`, `tr.is-muted`, `.is-num`), `.mt-split`
(`--right`) + `.mt-sidebar` + `.mt-content`, `.mt-section/.mt-section-title`, `.mt-panel`
(`__header/__title/__body`), `.mt-card`, `.mt-toolbar` (`__group`, `__sep`), `.mt-drawer`
(`.is-open`, `__header/__title/__body/__footer`), `.mt-popover`, `.mt-empty`, `.mt-progress`,
`.mt-spinner`, `.mt-count`, `.mt-muted`, `.mt-small`, `.mt-mono`, `.mt-truncate`, `.mt-row`,
`.mt-stack`, `.mt-spacer`, `.mt-divider`, `.mt-sr-only`. Tokens: `--mt-accent*`, `--mt-g0…g900`,
`--mt-text*`, `--mt-border*`, `--mt-success/warn/danger/info(-soft)`, `--mt-font*`, `--mt-fs-*`,
`--mt-s1…s10`, `--mt-r-*`, `--mt-shadow-*`, `--mt-ease`, `--mt-control-h(-sm)`, `--mt-sidebar-w`.

### 4.11 `MT.app` — js/app.js

| API | Description |
|---|---|
| `registerTab({id, labelKey, icon, order, hash, mount(panelEl), onShow(), onHide()})` | call at script-evaluation time; `mount` runs **once, lazily**, the first time the tab is shown; `MT.i18n.applyDom(panel)` runs after it |
| `showTab(id)`, `currentTab()`, `tabs()` | URL hash `#mapas`, `#base`, `#cadenas`; Alt+1/2/3; arrow keys in the tab bar |
| `addProjectMenuItem({id, labelKey, icon, group:'file'|'export'|'data'|'other', order, shortcut, onClick, enabled() → bool})` | entries of the ⋮ project menu (core adds new/open/save/saveAs/rename) |
| `newProject()`, `openProject()`, `saveProject({saveAs?})` | with confirmations + toasts (Ctrl+O / Ctrl+S) |
| `openExampleProject() → Promise<bool>`, `exampleAvailable()`, `isBlankProject()` | the built-in example (`window.MT_EXAMPLE_PROJECT` from `js/example-project.js`, generated from `tools/fixtures/demo.mapa.json` by `node tools/fixtures/build-example.mjs`). Opens straight away on a blank project (or the unchanged example); unsaved changes → dialog *Cancelar / Abrir sin guardar / Guardar y abrir el ejemplo* (a cancelled or failed save keeps the project); a project already saved to a file → a confirmation. Entry points: project menu *Abrir proyecto de ejemplo* (`id:'example'`), the Mapas empty state (no slides) and the *Elige los distritos* notice of a blank project (*Ver ejemplo con 4 regiones*) |
| `openProjectMenu(anchor?, menuOpts?)`, `renameProject()` | the one project menu (core + module entries) and the rename prompt — the Mapas rail reuses them so every project menu lists the same actions |
| `start()`, `booted`, `paused` | boot (index.html calls it; if the app's own scripts did not load — index.html opened inside the ZIP, a partial copy — index.html replaces the splash with a bilingual "extract the whole folder" message instead) |

**One working tab.** Every tab keeps the project and the database overlay in memory and writes the
same storage, so two working tabs would overwrite each other. At load a tab posts `'hello'` on
`MT.storage.channel`; an older tab then emits `'app:paused'` (modules write their debounced edits),
writes its last autosave, suspends autosaving and shows a non-dismissable dialog whose only action
(*Seguir en esta pestaña*) reloads it — which pauses the other one in turn. The new tab waits
≥ 250 ms after its hello before reading the autosave and tells the user the other tab was paused.

Tab panels are `section.mt-tabpanel#panel-<id>` filling the area under the top bar
(`position:absolute; inset:0; overflow:auto`). Give your root `height:100%` for full-height layouts.

---

## 5. Events (MT.bus)

| Event | Payload | Emitted by |
|---|---|---|
| `data:ready` | `{missing}` | data.js |
| `stores:changed` | `{ids: string[] | '*', op: 'upsert'|'delete'|'restore'|'reset'|'import'|'sync'}` | data.js (`sync` = `reloadOverlay`) |
| `chains:changed` | `{ids: string[] | '*'}` | data.js |
| `logos:changed` | `{chainId: string | '*'}` | data.js |
| `lang:changed` | `{lang}` | i18n.js |
| `project:loaded` | `{project}` | project.js (new/open/restore) |
| `project:changed` | `{reason:'add'|'duplicate'|'remove'|'move'|'rename', id?}` | project.js |
| `map:changed` | `{id, keys: string[], map}` | project.js `updateMap` |
| `map:selected` | `{id|null, map|null}` | project.js |
| `project:saved` | `{method:'file'|'download', name}` | project.js |
| `project:dirty` | `{dirty}` | project.js |
| `app:ready` | `{}` | app.js |
| `app:paused` | `{}` | app.js (the app was opened in another tab; write pending edits now) |
| `layout:places` | `{ubigeos}` | layout.js (basemap district-name positions learnt; layouts recomputed) |
| `tab:shown` | `{id}` | app.js |
| `app:showChanges` | `{}` | app.js (local-changes chip clicked → M3 shows the DB tab/changes) |
| `store:click` | `{storeId, mapId, screen:{x, y}, rect:{left, top, right, bottom}}` | **M1** mapview (marker clicked or Enter on a focused marker; marker centre / box in client px) |
| `view:changed` | `{id, view:{center, zoomRef}}` | **M1** mapview (after user pan/zoom; already saved via `updateMap`) |
| `mapview:layout` | `{id, items, stats:{ms, n, overlaps}, view}` | **M1** mapview (markers laid out and painted for a map; `items` read-only) |
| `slide:rendered` | `{id}` | **M1** slide (the HTML slide preview was updated) |
| `export:done` | `{format: 'png-map'|'png-slide'|'pptx'|'html', files: string[]}` | **M4** (an export finished and its files were handed to the user) |

Modules may add their own events; prefix them with the module (`maps:…`, `db:…`, `export:…`) and
document them here.

---

## 6. Module contracts

### 6.1 M1 — map core & rendering

Status: **implemented** (tests: `node tools/test/layout.test.mjs`, `node tools/test/maps-core.mjs`).
Everything is computed in the **reference frame** (1000 × `refHeight` units) and only scaled at the
end, so the live preview, the PNG/slide exports and the PPTX pieces are the same picture.

**WYSIWYG model (how M1 guarantees preview = export)**
- **Fixed basemap width:** MapLibre always renders the map at `MT.layout.BASEMAP_WIDTH` CSS px
  (620 × 520, the frame aspect in whole pixels; a theme key `basemap.cssWidth` would override it). The
  preview CSS-scales that stage to the frame (pixel ratio raised so it stays sharp); exports render
  the same stage with `pixelRatio = 1000·scale / 620`. Map labels, roads and tile zooms therefore keep
  the same size relative to the frame on any screen and in any export. Basemap zoom =
  `zoomRef + log2(620/1000)` (`MT.layout.basemapZoom(view)`); `view.zoomRef` keeps its §4.9 meaning.
- **One overlay painter:** markers, leaders, store dots, radius labels and the attribution are drawn
  on a canvas by `MT.render.drawOverlay` in the preview *and* in `MT.render.mapCanvas`. District
  borders (plus an ocean mask so the INEI polygons stop at the coast) and radius circles are MapLibre
  layers below the labels, added to both maps by `MT.mapview.basemap.apply`.
- **Text is laid out once:** `MT.slide.layout(mapCfg, W)` measures with canvas metrics (title shrink,
  subtitle wrap, legend columns/size); the DOM slide and `MT.render.drawSlide` both use the result.
- Basemap tweaks for slides (`MT.mapview.basemap.patch`): Spanish names (`name:es` → `name`), POI
  layers hidden, slightly larger/darker district labels, soft blue water, greener parks.

**`MT.mapview`** (js/mapview.js)
- `mount(el)` — create the single interactive map inside `el` (normally done by `MT.slide.mount`, which
  hosts it in the slide's map frame). Calling it again re-parents the same map.
- `render(mapCfg|null)` — camera from `MT.layout.viewFor(mapCfg)`, borders/radius layers, markers
  (`MT.layout.compute`, memoized), preview chrome. Idempotent; cheap when nothing changed.
- `getMap()`, `resize()`, `items()` (current layout, read-only), `state()` → `{id, view, styleReady,
  idle, failed, frame, n, stats}`, `highlight(storeId|null)` (lift one marker, e.g. while a popup is open).
- `basemap.{patch(map), ensureLayers(map), apply(map, mapCfg, {overlays}), firstSymbolId(map), LAYERS}`.
- Interactions: click / Enter → `'store:click'`; hover / focus → tooltip (name, chain, district);
  drag → `updateMap(id, {markerOffsets})` (`{dx, dy}` = marker centre − dot, fraction of the frame
  width); double-click or Delete → that marker back to automatic; arrow keys nudge a focused marker
  (Shift = ×4); the wheel over a marker still zooms the map. Any pan/zoom by the user (drag, wheel,
  keyboard on the focused map, +/− buttons) saves `view` with `updateMap` and emits `'view:changed'`.
- The markers are **one Tab stop** (roving tabindex): PageDown/PageUp or N/P move to the next/previous
  store in reading order, Home/End to the first/last.
- Switching slides (`render` with another map id) first runs `leaveMap()`: a pending keyboard nudge
  is saved on the slide it was made on, a running camera animation (wheel inertia, +/−, keyboard pan)
  is stopped, a drag is dropped; `onMoveEnd` ignores a gesture that started on another map.
- Basemap failure: retried automatically on the window `online` event and from the notice's
  *Reintentar* button (`setStyle`); the *Elige los distritos* notice has an *Elegir distritos* button.
- Preview-only chrome (never exported): +/− buttons (on hover/focus), chips **Encuadre manual** (click →
  `{view:null}`), **N logos movidos** (click → `{markerOffsets:{}}`), **N logos se superponen** (hint),
  centre notices (no map / no districts / no stores / stores out of view / store data missing /
  basemap unreachable), a loading pill. Strings in `js/i18n/map.js` (`map.*`).

**`MT.layout`** (js/layout.js) — pure and deterministic (no randomness, stable order).
- `compute(mapCfg, {width, height, project, view, stores}?) → item[]`, memoized per (map config, view,
  data version) when `project` / `stores` are not passed. **Items are shared: never mutate them.**
  `item = {storeId, chainId, name, lngLat, anchor:{x,y}, dot:{x,y}, pos:{x,y}, w, h, shape:'circle'|'rect',
  displaced, manual, leader:{x1,y1,x2,y2}|null, number?}` (reference units). `dot` = where the store
  dot is drawn: the anchor, spread ≤ one dot radius off the dots of shops at the same spot
  (`spreadDots`, theme `anchorDot.spread`; badge/card/number). `leader` runs from the dot to the
  marker edge; it is also the short default stem, so draw it whenever it is not null.
  `items.stats = {ms, n, overlaps, collapsed, size, grouping}` (non-enumerable; `size` = the marker
  size the logos are drawn at). `number` = 1…n by chain legend name, then store name.
- Declutter (SPEC §4.2): candidates = theme rings (+ farther rings for the `number` style) × 16 angles
  (straight up first, then alternating right/left), clamped inside the frame; cost = overlaps (+ min gap)
  ≫ covering another store's dot ≫ obstacles (attribution, radius "1 km" pills, the basemap's labels of
  the selected districts) ≫ leader crossings / leaders under markers ≫ distance and angle from "up".
  Manual offsets are fixed obstacles. Greedy densest → sparsest with branch-and-bound, worst-first
  improvement passes, then a focused round for markers still in trouble.
- **Leader cap + collapse (badge/card):** a logo never moves farther than
  `theme.marker.declutter.maxLeader` (2.6) marker sizes from its store (a badge's diameter; 1.6 × the
  height of a card). Markers that still overlap are *collapsed* — the most crowded first, the most
  common chain first on ties — and drawn as a small dot in the chain's **ring** colour on the location
  (`item.collapsed`, `w = h = 2·theme.marker.collapsed.radius`, no leader); each gets its logo back if a
  free spot within the cap appears. Legend counts are unchanged; `items.stats.collapsed` counts them
  (preview chip, Mapas hint, export-dialog warning). Dragging a collapsed dot gives it a fixed logo.
- **District names:** `districtLabelBoxes(mapCfg, project, view, fr)` = where the basemap writes the
  selected districts' names (positron sizes per class/zoom). The point comes from
  `MT.layout.places` — a persistent cache (`pref layout.places`, ubigeo → `{ll, c}`) filled by
  `MT.mapview.basemap.harvestPlaces(map, cfg)` (OSM `place` features of the loaded tiles whose name is a
  selected district, preferring one inside it) on every preview idle and in every export's offscreen
  map; until learnt, the district's visual centre stands in (street zooms only). A change emits
  `'layout:places'` and re-lays out. The **automatic view** also keeps those names whole: when one
  whose place point is inside the frame would cross an edge ("Nuevo Chiml…" on the Chimbote demo), the
  fit widens just enough to bring it 4 units inside (`autoView`, ≤ 4 deterministic passes; saved views
  are never changed). Because a basemap render can teach the cache, `MT.render.mapCanvas` draws the
  basemap once more when `viewFor` changed during the render, and `MT.export.pptx.plan` plans once more.
- **Same-chain grouping (badge/card, `mapCfg.groupNearby`, theme `declutter.aggregate`):** stores of
  ONE chain whose dots are all within `radius` marker sizes of each other (complete linkage, closest
  pairs first: deterministic) merge into one logo with a count pip ("×4", `MT.markers` at the
  top-right, ring colour). `'auto'` (default) runs a first layout and groups only when it is crowded
  (≥ `autoMinStores` stores and > `autoLongShare` of the logos with a leader longer than
  `autoLongRatio` marker sizes or no room, or > `autoDisplacedShare` moved off their default spot);
  while the grouped layout is still crowded the radius grows by `radiusStep` up to `radiusMax`.
  `true` / `false` force it. When 'auto' turns grouping on, the logos are also drawn at
  `aggregate.autoSize` (0.85) of the map's size (`stats.size`; the Mapas hint says so). The radius
  loop keeps the tidiest layout tried (`untidiness`: long leaders, long spokes, collapsed logos).
  A group is placed as ONE node of `place()` (`pts` = its dots): its logo keeps off all of them,
  "directly above" = above the topmost one (or in a gap among them), and its leader starts at the dot
  nearest to the logo; costs `W.groupFar` (per marker size to its farthest store), `W.groupBlock`
  (another marker between it and its stores' centre) and `W.spoke` (a spoke under another marker)
  keep it on its stores' side. Its other stores are tied to it by `spokes` (faint lines in the ring
  colour, theme `marker.spoke`): a spanning tree from the logo (`groupTree`) — a store near the logo
  gets a spoke to its edge, one nearer to another store of the group a link to that store's dot. Items stay **one per store** (legend counts unchanged): the representative
  carries `count`, `members` (ids, incl. its own) and `leaderFrom` (the store whose dot the leader
  starts at); the others are `grouped: true, groupOf` — only their dot (`pos` = anchor, a small hit
  target, no leader). Dragging a grouped logo saves its offset with `g: 1` (the group stays together
  there; members' own offsets are dropped); dragging a grouped store's dot gives it its own logo.
  `items.stats.grouping = {mode, on, auto, radius, groups, grouped}` (Mapas switch and hint).
  `MT.layout.place` also takes `obstacles` with a leader cost (`W.labelCross` + `W.labelLen` per unit
  inside: a store whose dot sits in a name leaves it by the shortest way) and `soft` obstacles (the
  basemap's other labels: `W.label` × share covered, `W.labelLeader` per leader through one — avoided
  when a free spot is close, never a reason for a long leader). `compute(cfg, {groups})` replays
  given groups (HTML export, slide zoom); `groupNearby` in opts overrides the map's setting.
- **App-written district names:** positron names suburbs (most Lima districts) only from about zoom
  11, so a zoomed-out slide showed village names and none of its districts; and where it names a
  town, a store at its place point split the name ("Chimb•ote"). `MT.layout.districtLabels(cfg,
  view?) → [{ubigeo, name, ll, cls, look, app: true}]`: every selected district's name is written by
  the app — `look` 'city' | 'town' | 'village' (the harvested place class: positron's look for it,
  above the point; layers `'mt-district-labels-<look>'` copied from `label_city` / `label_town` /
  `label_village`) or 'suburb' (`'mt-district-labels'`, `label_other` look, size
  `theme.basemap.districtLabel`); on top of every layer, always drawn; the basemap's own label of that
  name hidden (text-field `case` on the place layers) — at the harvested place point (a suburb's only
  inside the district), else its visual centre, or (centre outside the frame) the centre of its
  visible part; then moved a little off the store dots (`nameClearOfDots`, round 2 §13). Drawn in the
  preview, the PNG/PPTX basemap and the HTML page; `districtLabelBoxes` returns them (no zoom cut-off
  any more). `MT.layout.nameLayer(look)` = the layer id.
- **Rendered labels (`MT.layout.labels`):** after a render of a config's own view (preview idle or
  export map) `MT.mapview.basemap.harvestLabels` reads MapLibre's collision boxes / circles (pinned
  vendor internals, guarded) → `labels.set(cfg, view, [{l: layer, x, y, w, h, parts?}])` (reference
  units; persistent LRU of 24 views; keyed by view + `labels.sig(cfg)` = the app-written names). They
  give the selected districts' exact boxes (`exact`) and the soft obstacles. `autoView` uses
  estimates only (`districtLabelBoxes(…, {estimate: true})`). `MT.render.mapCanvas` draws the
  basemap again when the harvest changed which names the app writes (`labels.sig`).
- **No cut labels:** an invisible top-most symbol layer `'mt-label-blockers'` (transparent icons,
  allow-overlap, not ignore-placement) lines the outside of the frame's four edges and tiles the
  attribution box for the config's view, so MapLibre does not place a basemap label the frame would
  cut ("BLO LIBRE") or the attribution would cover — and, once the view's labels are known, covers
  the layout's markers, count pips, store dots and leaders (§13), so no label is drawn in pieces
  under them. Hidden while the user moves the preview map (geographic points belong to the saved
  view), restored by the next render.
- `dot` style: dots exactly on the location (no declutter), stores at the very same spot fanned out
  by < 1 dot radius; a dragged dot keeps a leader. Painting order for dots: chains with the most dots
  first, so a rare chain is never hidden (`MT.markers.paintOrder`).
- Helpers: `frame()`, `styleOf(mapCfg|style) → {kind, size}`, `viewFor(mapCfg)` (saved view → auto-fit
  → all of Peru; never null), `autoView(mapCfg)`, `fitView(bbox, padding)`, `fitPadding(style)` (room for
  markers above their dots), `projector(view) → ([lng,lat]) → {x,y}`, `unprojector(view)`,
  `basemapZoom(view)`, `attributionBox()`, `leaderFor(...)`, `place(nodes, opts)` (core solver),
  `countOverlaps(items)`, `dataVersion()`, `clearCache()`, `lastStats`, `BASEMAP_WIDTH`.

**`MT.markers`** (js/markers.js) — `style = MT.layout.styleOf(mapCfg)` = `{kind, size}`
- `ready(chainIds, style) → Promise` — decode the logos (await before synchronous drawing); `isReady(...)`.
- `markerColor(chainId)` — colour of the `dot` / `number` styles and their legend icons: the ring colour
  in chain order, replaced by a fixed categorical palette when it is too close (CIEDE2000 < 20,
  `deltaE(a, b)`) to a colour already kept — one assignment over ALL chains, so a chain has the same
  colour in every deck. `dotColor(chainId, style)` = markerColor for dot/number, else the brand colour.
  `paintOrder(items, style)`.
- `draw(ctx, item, style, scale, {parts?, offsetX?, offsetY?})` — one item: leader/stem, marker, store
  dot; coordinates = reference units × `scale` (composes with the ctx transform).
- `drawAll(ctx, items, style, scale, {highlight?, offsetX?, offsetY?})` — layered: group spokes →
  leader halos (white casing, `theme.marker.leader.halo`) → leaders → store dots (at `item.dot`; the
  dots a leader starts at last, `dotOrder`, so a leader always ends on its own chain's dot) → markers
  (top to bottom; the highlighted one last, ×1.08) → collapsed logos. Store dots go **under** the
  markers: a dot on another chain's logo read as part of that logo.
- `drawMarker(ctx, chainId, x, y, style, {w, h, number, count, shadow})` — marker body only (ctx in
  ref units); `count > 1` adds the count pip of a grouped logo (`pipGeometry(chainId, w, h, style,
  count) → {dx, dy, w, h, fs, text, fill, color, stroke, sw}`, inside the picture's shadow margin).
- `image(item, style, scale) → {canvas, x, y, w, h}` — **one marker as its own picture (PPTX)**; box in
  reference units including the shadow margin (`x, y` = top-left) and the count pip.
- `isMarker(item)` — drawn as a marker (not a collapsed logo or a grouped store).
- `element(item, style, {pxPerUnit}) → HTMLElement` — stand-alone canvas marker positioned in reference
  units (CSS px) inside an overlay of 1000 × refHeight px.
- `icon(chainId, px, style) → canvas` — legend icon, `px` tall: badge / card (wider than tall — check
  `canvas.width`) / number (plain chain pin) / dot (brand dot with a white ring).
- `dims(chainId, style) → {w, h}` (card width from the wide logo's PNG header: synchronous and
  deterministic; no wide logo → **square card** (w = h = card height) with the badge mark inside a
  white card, inset and rounded like an app icon — so every card on a slide and in the legend has
  the same height and the same white face; no logo at all → chain name as wordmark),
  `ringColor(chainId)` (`ringColor` of the chain or of its raw MT_CHAINS entry, else `color`; light
  colours turn grey), `chainColor(id)`, `darken(hex, f)`, `anchorRadius(style)`, `shadowMargin(style)`.

**`MT.legend.items(mapCfg, layout?) → [{chainId, label, name, count, text}]`** (js/legend.js) — only the
layout items inside the frame (the map's own layout when none is given); `label` = legendName
(upper-cased per `theme.legend.row.uppercase`); `text` = `label + " (n)"` when `theme.legend.showCount`;
sorted by `legendSort` (`alpha` via `MT.util.compare`; `count` desc, then alpha). `rows.footnote`
(non-enumerable) = theme `legend.footnote.grouped` ("×N = N tiendas cercanas · • = ubicación exacta")
when the layout has group logos, else null; `MT.slide.layout` puts it under the rows (`legend.note`),
drawn by the DOM slide, `drawSlide` and the PPTX ("Nota de la leyenda").

**`MT.slide`** (js/slide.js)
- `mount(el)` — builds the slide inside `el` (it fills `el`: give `el` a definite height) and mounts
  `MT.mapview` in the map frame; the slide is fitted 16:9 and centred (ResizeObserver).
- `render(mapCfg|null)`, `element()`, `current()`, `resize()`. The slide also re-renders itself
  (coalesced to one frame) on `map:changed` for its map, `stores:changed`, `chains:changed` and
  `logos:changed`; M2 may still call `render` directly — double calls are cheap.
- `layout(mapCfg, W, legendRows?)` → slide geometry in px for a slide `W` px wide: `{W, H, k (px per
  inch), leftArea, title:{text, full, fontPx, x, y, w, h, baseline, color}, subtitle:{lines:[{runs:[{text,
  kind:'text'|'label'|'peso', x, w, weight, color}], y, h, baseline}], fontPx, underline:{offset,
  thickness}}, frame, panel, legend:{heading:{text, x, y, w, h, cx, baseline, fontPx, color},
  rows:[{chainId, text, x, y, h, icon:{x, y, w, h}, textX, baseline, fontPx}], cols, fontPx, color}}`.
  **M4 PPTX:** divide px by `k` for inches; font size in pt = `fontPx / k * 72`.
- Title: one line, shrinks down to 16 pt, then ellipsis. Subtitle: `(districts)  Peso: x` on one line,
  otherwise districts on line 1 and "Peso: x" on line 2 (as in the reference deck), or word-wrapped;
  12 → 9 pt. Legend: fewest columns (1–3, `maxRowsPerColumn`) at the largest size 16 → 11 pt that fits,
  then smaller (down to 8 pt) before any ellipsis; card icons capped at 2.3 : 1.
- `legendLayout(rows, W, style)`, `font(weight, px)`, `metrics(weight, px)`, `textWidth(text, weight, px)`.
- In the preview an empty title shows a grey placeholder ("Título del mapa") that is never exported.

**`MT.render`** (js/render.js)
- `mapCanvas(mapCfg, {scale=3, markers=true, overlays=true, attribution=true, timeoutMs=60000})
  → Promise<{canvas, layout, frame:{width, height, scale}, view}>` — offscreen map (620 × 520 CSS px,
  `pixelRatio = 1000·scale/620`, `preserveDrawingBuffer`, `fadeDuration: 0`), same view and layers as
  the preview, waits for `'idle'` with all tiles; canvas = `round(1000·scale) × round(refHeight·scale)`
  (3× → 3000 × 2516). `markers:false` → borders, radius circles + labels and attribution, **no**
  leaders/markers/dots (the PPTX places those from `layout`); `overlays:false` → basemap only (+
  attribution unless `attribution:false`). Calls are queued (one WebGL map at a time). Rejects with
  `err.code` `'basemap-unavailable'` | `'basemap-timeout'` and `err.messageKey` (`'map.error.unavailable'`
  | `'map.error.timeout'`) → show `MT.t(err.messageKey)`.
- `slideCanvas(mapCfg, {width=3840}) → Promise<canvas>` — the complete 16:9 slide (`W × round(W/aspect)`).
- `drawOverlay(ctx, mapCfg, items, scale, {highlight, radiusLabels, view, markers, attribution, offsetX,
  offsetY})`, `drawAttribution(ctx, scale, opts)`, `drawSlide(ctx, mapCfg, W, mapImage, layout?)`.
- **For M4 PPTX** (per map): picture of `mapCanvas(cfg, {markers:false})` at `MT.theme.mapFrame`; for
  each `item` of its `layout`: a line shape from `item.leader` (`theme.marker.leader` colour/width/alpha;
  ref units → inches with `MT.theme.ref2in`, offset by the frame x/y), the marker picture
  `MT.markers.image(item, style, 4)`, then the store dot (ellipse of radius `MT.markers.anchorRadius(style)`,
  fill `MT.markers.chainColor(item.chainId)`, white outline `theme.marker.anchorDot.strokeWidth`) — no
  dot for the `dot` style unless `item.displaced`; collapsed items are ring-colour ellipses. Legend rows: `MT.slide.layout(cfg, W,
  MT.legend.items(cfg, layout)).legend` + `MT.markers.icon`. Store table (`number` style): `item.number`.
  Z-order as `drawAll`: leader halos and leaders (connectors glued to the dot of `leaderFrom` and to
  the marker), store dots, markers (grouped stores: dot only; a group's picture includes its pip and
  is named "Cadena ×n"), collapsed logos.

**`MT.radius`** (js/radius.js)
- `compute(mapCfg) → [{storeId, meters, chainId, center, circle, inside:[{store, distance, sameChain}],
  sameChain, competitors}]` — one entry per `mapCfg.radius` item whose store exists; `circle` =
  `turf.circle([lng,lat], meters/1000, {steps: 96})` (geodesic, 97 points); candidates = non-closed
  stores of chains toggled on in the map and not hidden, **ignoring the district filter**; distances in
  metres (rounded, `MT.geo.distanceMeters`), sorted ascending; centre excluded. A pure function of
  `(mapCfg, MT.data)` — the base for phase 2 (§8).
- `features(mapCfg|results)` (circles with `color`, `stroke`, `fillOpacity` in the centre store's chain
  colour, stroke darkened for light brands), `labels(results, project)`, `drawLabels(ctx, labels, scale)`
  ("1 km" pills at the top of each circle, slide font `labelFont(fs)` — the same Calibri text as the
  PPTX pill), `formatMeters(m)` ("500 m", "1,5 km" — slide text, Spanish),
  `rows(results)` → spreadsheet rows (header in the UI language) for `MT.io.writeXLSX`, `colorsFor(chainId)`.
- `inactiveReason(mapCfg, storeId) → 'missing'|'closed'|'hidden'|'chainOff'|null` — `compute` skips a
  radius whose centre store is not on the slide (no circle around nothing in any output); the Mapas
  radius card explains why and offers *Mostrar la tienda* / *Activar {cadena}*.

**Theme notes:** M1 reads every look from `MT.theme` (marker sizes, ring, shadows, leader, borders,
radius stroke width/dash and fill alpha, attribution, slide/panel/legend geometry and fonts). District
borders use `theme.borders` (navy `#1F3864`, width 2 ref units ≈ 1.2 px in the preview, 6 px at 3×);
radius circles use the **chain colour** of the centre store with `theme.radius.width/dash` and the alpha
of `theme.radius.fill`. M1's dictionary is `js/i18n/map.js` (the file index.html loads).

### 6.2 M2 — Mapas tab (js/ui-maps.js)

Status: **implemented** (test: `node tools/test/maps-ui.test.mjs`, screenshots `tools/test/out/m2-*.png`).
Files: `js/ui-maps.js`, `css/maps-ui.css` (`.mt-maps-*`), `js/i18n/maps-ui.js` (`maps.*`, ES/EN parity).
Registers `{id:'maps', labelKey:'tab.maps', icon:'map', order:10, hash:'mapas'}` (mounts lazily).

**Layout** — a PowerPoint-like workspace (`.mt-maps`, grid `rail | centre | inspector`; 224/364 px
columns, narrower below 1380 and 1200 px):
- **Rail** — project header (name → rename prompt, save state "Guardado / Cambios sin guardar", save
  button, ⋮ = `MT.app.openProjectMenu`, the same menu as the top bar incl. the export entries), then the slide list:
  number, **thumbnail**, title, "n distritos · n tiendas". Thumbnails are the real slide drawing
  (`MT.render.drawSlide` + `MT.slide.layout`: title, subtitle, legend panel) over a light schematic
  map (district shapes, radius circles, store dots in chain colours) — no WebGL, drawn in idle time,
  current slide first. Item ⋮ menu: duplicate, move up/down, delete (confirm + "Deshacer" toast).
  Reorder by drag-and-drop (HTML5 DnD, drop line) or **Alt+↑/↓**; ↑/↓/Home/End select, Delete deletes.
- **Centre** — bar ("Lámina 2 de 4", title, "n tiendas · n cadenas" from `MT.layout.compute`, ‹ ›,
  **Exportar ▾**), then the dotted artboard holding `MT.slide.mount(stage)` (mounted once; M2 calls
  `MT.slide.render(map)` on `'map:selected'`, M1 re-renders itself on `'map:changed'` and data events).
  A **hint** above the slide (in normal flow: the slide shrinks while it shows, so it never covers
  the title band) explains empty results and offers the fix: all chains off → "Activar todas"; no
  store inside the districts but some nearby → "Incluir tiendas cercanas" (`onlyInside:false`); none
  at all → "Revisar Base de datos"; > 120 badges/cards or ≥ 5 % of the logos collapsed to dots →
  "Achicar logos" / "Usar puntos" (dismissable). Empty project → centre card "Crear lámina".
- **Inspector** — collapsible sections (open state in pref `maps.sections`), each header shows a summary:
  1. *Textos de la lámina*: title; subtitle with switch "Lista automática de distritos" (read-only
     preview) or manual text (starts from the automatic text, abbreviations allowed); Peso (free text).
  2. *Distritos*: inline **combobox** over `MT.data.districts.search` (local, as-you-type; ↑/↓, Enter,
     Esc; shows "Provincia, Departamento" and store counts; already-added rows disabled) + province rows
     ("Toda la provincia de X", `searchProvinces`) + **"Zonas de Lima"** presets (Lima Moderna / Centro /
     Norte / Este / Sur, Balnearios del sur, Callao — APEIM grouping, only ubigeos present in the data);
     chips with × (Backspace in the box only edits the text — holding it used to remove every
     district), "+N más" above 16, "Quitar todos" (confirm from 4). Enter does not guess between
     equally good matches ("San Juan"): it asks to pick one. With no districts a "Empieza por aquí"
     card is shown; a new slide focuses the box.
  3. *Cadenas*: grouped by `MT.data.GROUPS`, badge icon (`MT.markers.icon`) + name + count of stores of
     that chain in the slide's region (`storesForMap` with every chain on) + switch; Todas/Ninguna per
     group and global. Unknown chain ids appear under "Otras".
  4. *Logos y leyenda*: style cards with live previews drawn by `MT.markers.drawMarker` (badge, card,
     dot, number), size slider (60–160 %, debounced), switch "Agrupar tiendas cercanas de la misma
     cadena" (`groupNearby`: shows whether grouping applies now — `stats.grouping` — with a hint; a
     click forces on/off, "Automático" returns to `'auto'`; disabled for dot/number), legend order
     (alfabético / por cantidad).
  5. *Encuadre del mapa*: only inside districts, district borders, fit to stores/districts, framing
     status + "Volver al automático" (`view:null`), moved-logo count + "Restablecer" (`markerOffsets:{}`).
  6. *Radios de influencia*: one card per circle (centre store, metres input 50–50 000 with validation,
     500 m / 1 km / 2 km chips, "n propias · n de la competencia", expandable list with distances from
     `MT.radius.compute`), "Agregar radio" (store picker over `storesForMap`, default 1 km), **"Exportar a
     Excel"** (`MT.radius.rows` → `MT.io.writeXLSX` → `<title> - radios - <date>.xlsx`).
  7. *Tiendas ocultas*: hidden stores with "Mostrar" / "Mostrar todas".
- **Store popup** (`'store:click'`, current slide only): chain, name, address · district, status and
  "Ubicación aproximada" badges; radius chips (add / change / "Quitar radio"); "Ocultar en esta lámina"
  (toast with "Deshacer"); "Editar en Base de datos" → `MT.app.showTab('db')` then `MT.db.openStore(id)`
  if it exists, else `MT.dbui.select(id)` + `MT.dbui.openEditor(id)`. The marker is lifted with
  `MT.mapview.highlight(id)`. Closes on Esc (focus back to the marker), outside click, wheel, pan,
  map/tab change. Opened from the keyboard (Enter on a marker) it focuses its first action.
- **Exportar ▾** popover: scope (esta lámina / todas), PowerPoint, PNG slide (1920 × 1080 / 3840 × 2160),
  PNG map (2× / 3× / 4×), interactive HTML; choices remembered (`maps.export*` prefs). Calls
  `MT.export.run(format, ids, opts)` when M4 provides it (`'pptx'|'slide'|'map'|'html'`, opts
  `{width}` / `{scale}`), else `MT.export.pptx/png/html` (typeof-guarded; a stub's
  `export-not-implemented` → "todavía no está disponible"). M4 owns progress and toasts; M2 only shows
  a toast when none appeared (and never for `err.shown`). "Más opciones: elegir láminas…" opens
  `MT.export.dialog({mapIds})`. The button shows "Exportando…" while a job runs.

**Writes & events** — every change goes through `MT.project.updateMap` (top-level keys replaced). Text
fields, the size slider and the metres box are debounced (140–450 ms) and flushed on blur, Enter, map
switch, tab hide, Ctrl+S / Ctrl+O and `pagehide`. Inspector controls are built once per selected map and
synced in place on `'map:changed'`, so typing never loses focus or caret. Listens to `project:loaded`,
`project:changed`, `project:dirty`, `project:saved`, `map:selected`, `map:changed`, `stores:changed`,
`chains:changed`, `logos:changed`, `mapview:layout`, `view:changed`, `store:click`, `tab:shown`,
`lang:changed` (full re-render, scroll kept). Emits no events of its own.

**`MT.mapsui`** (helpers for tests and other modules): `flush()`, `openPopup(storeId)`, `closePopup()`,
`section(id, open)` (`'content'|'districts'|'chains'|'markers'|'map'|'radius'|'hidden'`),
`focusDistricts()`, `addRadius(storeId, meters)`, `exportRadiusXlsx() → Promise<name|null>`,
`runExport(kind, {scope:'current'|'all', slideW, mapScale})` (`kind`: `'pptx'|'slidePng'|'mapPng'|'html'`),
`state() → {mounted, popup, sections, exporting, pending}`.

**Phase 2 (§8) hook** — the inspector is a list of section definitions (`SECTIONS` in ui-maps.js:
`{id, icon, build(body, map) → {update(map, keys)}, summary(map)}`); the cannibalization analysis would
add an "Análisis" section next to *Radios de influencia*, reusing the store picker, the radius cards'
result list and the Excel export, with its results stored under a per-map `analysis` key.

### 6.3 M3 — Base de datos, Cadenas, OSM (js/ui-db.js, js/ui-chains.js, js/osm.js)

**Implemented** (no stubs). Styles `css/db.css` (`.mt-db-*`, `.mt-chains-*`, `.mt-imp-*`, `.mt-osm-*`),
strings `js/i18n/db.js` (`db.*`, `chains.*`, `osm.*`). Tests: `node tools/test/db.test.mjs`
(≈200 checks, Nominatim/Overpass mocked; `--live` adds one real Overpass scan of Miraflores) and
`node tools/test/db-shots.mjs [--en] [--real]` (visual pass → `tools/test/out/db-shot-*.png`).

- Tabs `{id:'db', labelKey:'tab.db', icon:'database', order:20, hash:'base'}` and
  `{id:'chains', labelKey:'tab.chains', icon:'store', order:30, hash:'cadenas'}`.
  `'app:showChanges'` → shows the DB tab filtered to locally changed stores (deleted seed stores
  included, with *Restaurar*).
- **Base de datos**: header (counts, local-changes cluster, Importar, Exportar ▾, Escanear OSM,
  Agregar tienda) · filter bar (accent-insensitive search; popovers Cadenas (grouped, faceted counts),
  Ubicación (departamento → provincia → distrito, + "sin ubicación"), Estado, Fuente, Precisión) ·
  virtualized table (fixed layout, ~25 DOM rows for 3,500 stores, sortable headers, keyboard ↑↓
  PgUp/PgDn Home/End, Enter = edit, Space = check) · bulk bar (mark verified / to verify / closed,
  delete) · resizable MapLibre map of the filtered stores (GeoJSON circles by chain colour, selection
  halo, store card popup with *Editar* and a Google Maps link) · edit drawer (all fields, chain select,
  status/precision, mini-map with draggable pin + click to place, paste coordinates / Google Maps link
  via `parseCoordsDetailed`, Nominatim address search on Enter/button only, live district via
  `MT.data.locate`, soft delete = mark closed vs permanent delete, undo local changes).
- **Import** (CSV/TXT/XLSX/XLS/ODS): header row auto-detected among the first 10 rows, column mapping
  (`MT.io.mapHeaders` + manual override), *merge by ID* (partial update — empty cells never erase) or
  *append*, default chain/status, rows parsed one by one with `MT.io.rowsToStores` (row numbers kept),
  geocoding of address-only rows with `MT.geo.geocodeBatch` (1 req/s, `MT.ui.busy` progress + cancel;
  results kept on cancel; precision `approx`, status `to_verify`). When the address SERVICE fails
  (offline, 429/403, repeated errors) the batch stops and a dialog offers *Reintentar* / *Importar las
  demás* / *Cancelar* (skip reason `serviceError`, not "address not found"). New ids `man-<base36 ms>`
  allocated consecutively, one `upsertStores` call, summary with skipped rows (+ CSV of them).
  Merge mode is the default only when the id column holds this app's ids (osm-/web-/man- or existing
  stores); unknown non-app ids get new `man-` ids; an id repeated in the file is skipped
  (`duplicate`); a merge that would change a store's chain is warned about; coordinates outside Peru
  are skipped (`outsidePeru`) and swapped lat/lng are fixed and reported. Files are read with
  `MT.io.readTable`.
- **Export** CSV / Excel of the filtered list or the whole base (`MT.io.storesToCSV/storesToXLSX`,
  `datedName('Tiendas', …)`), rows in the `data/stores.csv` order (`MT.io.sortStores`).
- **Guardar en carpeta** (`MT.dbui.saveToFolder`): `MT.io.repoFiles()` (refuses when a shipped data
  file did not load) → `fs.ensureFolder()` → `fs.looksLikeApp()` and, on file://,
  `fs.isRunningFolder()` (another copy of the app → nothing is written, "Esa no es la carpeta que tienes
  abierta", pick again) → `MT.data.reloadOverlay()` + `overlaySnapshot()` → `repoFiles()` →
  `fs.writeFiles()`. Then: `file://` → `MT.data.commitOverlay(snapshot)` + automatic reload; `https:`
  (GitHub Pages) → the overlay is **kept** (it is reconciled away at the next load once the published
  files contain the changes); no File System Access → per-file downloads, overlay kept.
  *Descartar cambios locales* → `MT.data.resetOverlay()` after a confirmation listing what is lost.
- `createMap` returns **null** without WebGL (the map area shows the same explanation as the Mapas
  tab; table, filters and editor keep working); network failures show a note with *Reintentar*, also
  retried on `online`. MapLibre controls get `locale: MT.i18n.mapLocale()` (Spanish tooltips).
- **Cadenas**: master/detail. List grouped by `MT.data.GROUPS` (store counts, *Nueva / Editada /
  Sin registrar / Logo* badges, default-off icon). Detail: hero with the marker as drawn on the map,
  fields (name, legend name, group, brand colour + hex + unused-colour swatches, default on, owner,
  website, store locator), live previews (badge with stem and anchor dot, card, dot, legend row on the
  crimson panel — all from `MT.theme.marker` / `MT.theme.legend`), logos, OSM rules (collapsible:
  every per-chain key of `tools/seed/OSM-RULES.md` §2 — Wikidata ids; name pattern validated, with the
  unanchored ERE sent to Overpass and a tester that folds the name and gives the scan's verdict
  (coincide / la descarta «Excluir nombres» / dudosa / la reconoce otra cadena / no coincide); exclusion
  and weak-name patterns; name on stores (`label`) + prefix; shop types and weak-name shop types; the
  three format switches (*Formato grande* = `requireShopLike:false`, *Tiendas de cercanía* = `dense`,
  *Nombre distintivo* = `uniqueName`); tag exclusions as rows key ~ value pattern + reason; a read-only
  summary of the cross-chain `MT_OSM_RULES`). Explicit save bar (`MT.data.upsertChain`); *Restablecer*
  (`restoreChain`) for edited shipped chains; *Eliminar* for locally added ones (also drops their
  uploaded logo); *Registrar cadena* for unknown ids found in stores. *Nueva cadena* / *Registrar
  cadena* get conservative OSM rules: no pattern (the scan derives `^economax\s*peru…` from the current
  name — shown as placeholder), any shop type, a shop tag required, dense radii.
  - **Badge upload**: PNG/JPG/SVG/WebP → dialog (fit *completo/llenar*, size 50–150 %, background
    transparent/white/brand) → **512 × 512 PNG** data URI → `MT.logos.set(id, {badge})` (512 rather than
    `MT.logos.fromFile`'s 256 so `logos/<id>.png` written by "Guardar en carpeta" is the SPEC §3.3
    master; logos.js then carries that 512 px image for uploaded chains). SVGs without intrinsic size
    are treated as 512 px.
  - **Wide logo**: trimmed to its content (transparent or uniform-corner background), ≤ 512 × 256 px.
  - **Ring colour** (optional, field *Color del anillo*): badge ring and card border when the logo reads
    better on another colour than the brand's (Mass: yellow brand, blue ring). Empty = brand colour.
    Kept by `MT.data.normalizeChain`, written to `data/chains.js` by `MT.io.chainsJs`, read by
    `MT.markers.ringColor` (which falls back to the shipped `MT_CHAINS` entry for chains edited before
    the key existed). Dots, legend text colour and radius circles keep the brand colour.
  - Table rows: click selects, **double-click** edits (detected from `click.detail === 2`, because
    selecting re-renders the rows and the browser would never fire `dblclick`), Enter edits.

**`MT.osm`** (js/osm.js) — network only through `MT.geo.overpass`. **Same rules as the seed merge**: the
per-chain `osm` objects of `MT_CHAINS` and the cross-chain `window.MT_OSM_RULES`, both in `data/chains.js`
(schema and step order: `tools/seed/OSM-RULES.md`; reference code `tools/seed/osm-classify.mjs`, ported line
by line). `tools/test/osm-rules.test.mjs` proves the port (177/177 fixtures, all 2,426 elements of
`tools/seed/osm-raw.json` incl. reasons, = `merge-log.json`), that the query never loses an element the
classifier keeps, and that the seed's raw elements of the 4 demo areas and of all Peru give exactly the
`stores.csv` rows from OSM (same ids and chains); a mocked scan of each demo area finds 0 new / 0 moved / 0 not found.

| API | Description |
|---|---|
| `fold(s)` | NFD, combining marks removed, lower case, white space collapsed — every rule is tested on folded text (OSM-RULES §1) |
| `globalRules()` · `globalRulesSource()` · `BUILTIN_RULES` | `MT.data.osmRules()` (= `MT_OSM_RULES`), or — for an old `data/chains.js` without the block — a built-in copy of `tools/seed/osm-rules.json` v1 (`'builtin'`; a test checks it equals the published block) |
| `chainRules(chain)` | the chain's `osm` with every key of OSM-RULES §2 and defaults. A registered chain with neither `nameRegex` nor Wikidata ids (added by the user) gets the conservative `nameRegexFor(name)` = `^<folded words joined by \s*>(?![a-z0-9])` (`derived: true`); synthesized unknown chains get none |
| `compile(chains?, G?) → R` · `classifyTags(tags, R)` | `classifyOsm` of the seed: `{chain, via:'name'\|'brand'\|'brand:wikidata', kind:'shop'\|'building'\|'weak'\|'closed'\|'excluded', reason, noCoords, doubt}` or `{chain:null}`. Every registered chain decides WHICH chain an element is (in `MT.data.chains()` order). App extensions (no seed chain uses them): `shops: []` = any `shop=*` value; an `excludeTags` entry with an empty value pattern excludes on the key alone. A chain whose regex does not compile is left out (`R.errors`) |
| `nameVerdict(chain, text, R?)` | Cadenas tester: `'match'\|'excluded'\|'weak'\|'other'` (another chain claims it first) `\|'none'` |
| `rules(chain) → {re, ex, ere, qids, shops, usable, derived, error?}` · `radii(chainId, R)` | Overpass-side summary (`ere` = `toERE(nameRegex, {anchors:false})`); radii = `MT_OSM_RULES.radii.dense` for `dense` chains, else `.big` (`dedupe`, `link`, `match`…) |
| `buildQuery({ubigeos \| bbox, chains, timeout?, compiled?}) → string` | one bbox, built from the rules: `nwr[k](bbox)` for every key the classifier reads (`nameKeys` + `brandKeys`, `wikidataKeys` → `name`, `name:es`, `brand`, `brand:wikidata`), then filtered in memory by the selected chains' **unanchored** name ERE (`,i`; the rules test folded text, Overpass the raw name, so `^`/`$` are dropped → broader) and their QIDs (`(Q…)([^0-9]\|$)`); `out center tags`. Exclusions are client-side only (they would only narrow the query). Key-then-regex is much faster on Overpass than regex+bbox (`tools/scan-osm.mjs` uses the same shape) |
| `classify(elements, chains?, R?)` | raw Overpass elements → `[{key, type, osmId, chainId, via, kind, reason, noCoords, doubt, lat, lng, tags}]` for the given chains, kinds shop/building/weak/closed; `.stats` (non-enumerable) counts every kind incl. `excluded` |
| `cluster(classified, R, prefer?)` | the seed's OSM dedupe: single-linkage within `dedupe` m, or `link` m when one is a building or the types differ (big formats); representative = a DB element (`prefer(id)`) › shop › chain QID › node › more tags › not an entrance; address/branch tags of the members fill the gaps; weak elements within `link` of a store are absorbed; closed ones pass through. Each entry carries `members` |
| `elementToStore(entry, R)` · `displayName(chainId, raw, R)` | proposed record (status `to_verify`, source `osm`, precision `exact`, located with `MT.data.locate`) + `_kind`, `_weak`, `_noCoords`, `_closed`, `_reason`, `_members`; names like the seed (`"HIPERMERCADOS TOTTUS ANGAMOS"` → `"Tottus Angamos"`) |
| `process(elements, {chains, ubigeos?, db?, excludeNotFound?, compiled?}) → {new, matched, notFound, proposals, stats}` | classify → cluster → area (a proposal is in the area when its point is in one of the districts **or** it is the OSM element of a DB store of the area — simplified polygons must not turn a boundary store into "not found" + "new") → `diff`. Used by `scan` and by the tests on the seed's raw elements |
| `diff(osmStores, dbStores, {matchMeters?, moveMeters=50, excludeNotFound, compiled})` | 1. same OSM id (`osm-<key>` / `source_ref`, any cluster member); a **closed** OSM element sends its store to "not found" with `_closedInOsm`. 2. greedy nearest same-chain store within the chain's `radii.match` (250 m big, 120 m dense), proper shops first, then weak elements; closed elements never match. 3. new = the rest except closed and `noCoords` elements; weak ones are flagged `_weak` (listed last). `moved` > 50 m, never for `noCoords`. Not found = OSM-sourced, not closed, unmatched + the closed-in-OSM ones |
| `scan({ubigeos, chains}, {signal, onProgress, timeoutMs}) → Promise<result>` | tiles (`planTiles`), one query at a time; per tile 2 retries (5 s, 15 s) when every endpoint fails; a timeout/out-of-memory `remark` splits the tile in 4 (max 2 levels); then `process`. Rejects `osm-no-area`, `osm-no-rules`, `overpass-unavailable` (`.details` = endpoint errors) or AbortError |
| result | `{new:[store+_nearest], matched:[{store, osm, distance, moved, sameId, weak}], notFound:[store], stats:{shop, building, weak, closed, excluded}, timestamp, endpoint, endpoints[], queries, tiles, failedTiles[], elements, skippedChains[], chains[], area:{ubigeos}, scannedAt, rulesSource}` — `timestamp` is the **oldest** OSM base date among tiles; stores inside failed tiles are never reported "not found" |
| `onProgress(p)` | `{phase:'query'\|'endpointFailed'\|'retry'\|'process', done, total, endpoint?, error?, waitS?}` |
| `apply({new, moved, notFound}, {notFoundStatus:'to_verify'\|'closed'}) → upsertStores result` | new → source `osm`, precision `exact`, status `to_verify` (doubtful ones get the note «OSM: etiquetado dudoso, confirmar»); moved → OSM position, precision `exact`; not found → status + dated note («No encontrada en OSM» / «Cerrada según OSM»). Never deletes |
| `planTiles(ubigeos)` · `toERE(jsRegex, {anchors})` | `toERE` turns JS regexes into a broader-or-equal POSIX ERE without quotes, backslashes or non-ASCII (`\s`→`[[:space:]]`, `\b` dropped, `\.`→`[.]`, `á`→`.{1,2}`, lookarounds removed; `{anchors:false}` also drops `^`/`$`) |
| `MATCH_METERS`, `MOVE_METERS` | 120 (fallback match radius), 50 |

Review screen (`MT.dbui.openReview`): doubtful proposals carry a «Dudosa» badge with the reason as tooltip and
are **not** pre-selected; not-found rows whose OSM element is closed say «Cerrada en OSM»; the meta line counts
the elements the rules ruled out («N descartados por las reglas»).

**`MT.dbui`** (js/ui-db.js — shared helpers + test hooks): `createMap(el, {map, nav})` (positron,
Spanish labels, network errors → one quiet note, other map errors logged), `whenStyle(map, fn)`,
`popover(anchor, content, {label, className, align, focus, onClose}) → {el, close, place}`,
`changesCluster({onPill, isActive})` (self-updating), `changesDetail(stats)`, `saveToFolder()`,
`discardChanges()`, `exportStores('csv'|'xlsx', {all})`, `filterStores(list, filters, skipFacet)`
(pure; filters `{q, chains[], department, province, ubigeo, statuses[], sources[], precisions[], local}`),
`filters()`, `setFilters(patch)` (department change clears province/district), `clearFilters()`,
`visible()`, `state()`, `select(id, {source})`, `openEditor(id|null, {draft})`, `closeEditor(force)`,
`importFile(file)`, `importRows(name, rows)`, `openScan({ubigeos?, chains?})`, `openReview(result)`,
`chainsByGroup(list?)`, `logoImg(chainId, px)`, `statusBadge(status)`, `fmtDate(iso)`.
**`MT.chainsui`** (js/ui-chains.js): `select(id)`, `save()`, `draft()`, `drawBadge(ctx, img, color,
cx, cy, d)`, `drawMarker(canvas, img, color, d)`, `normalizeBadge(img, {fit, scale, bg}) → canvas`,
`normalizeWide(img) → canvas`, `nameToRegex(name)`, `uploadBadge(preset?)`, `uploadWide(preset?)`.

**Events added**: `'db:selected' {id}` (row/map selection), `'db:filtered' {count}` (after every
re-filter). **Preferences**: `db.filters`, `db.sort`, `db.showMap`, `db.mapWidth`, `chains.selected`,
`chains.osmOpen`. Overpass on `file://` uses the slow mirrors (TECH-NOTES §4.2): the scan dialog warns
about it, the review shows the data date + server, and warns when the data is older than 14 days.

### 6.4 M4 — exports (js/export-*.js)

Status: **implemented** (test: `node tools/test/export.test.mjs [--section=ui,png,pptx,html,errors] [--office]`).
Strings: `js/i18n/export.js` (`export.*`; `export.page.*` = texts of the exported HTML page, taken in
the UI language at export time). Deck content (title, "Peso:", "Tiendas", legend names, store-table
headers, speaker notes) stays Spanish, like `MT.theme`. No CSS file: the dialog injects a small
`<style id="mt-export-css">` (`.mt-export*` classes, core tokens only) the first time it opens.

**Common to `png` / `pptx` / `html`** — `mapIds`: array of ids | one id | `'all'` | `null` (= current map).
`opts`: `{download=true, ui=true, signal, onProgress(fraction, message)}`.
- `ui:true` shows `MT.ui.busy` (progress + Cancel) and a toast on success / failure; errors still
  **reject** (`err.code`: `'no-maps'` | `'lib-unavailable'` | M1's `'basemap-unavailable'|'basemap-timeout'`
  with `err.messageKey`; `err.shown = true` when a toast was shown); cancel → `AbortError` + an info toast.
  `ui:false` → silent (tests, scripted use).
- Resolves `{files:[downloaded names], entries:[names inside a zip], file?, blobs?}` (`blobs` =
  `[{name, blob}]` only with `download:false`). Emits **`'export:done'` `{format, files}`**
  (`format`: `'png-map'|'png-slide'|'pptx'|'html'`).
- File names come from the titles, file-system safe but readable (`MT.io.safeFilename`, accents kept):
  `Lima Metropolitana Sur - lámina.png`, `Lima Metropolitana Sur - mapa.png`,
  `<title or project>.pptx`, `<title or project> - mapa interactivo.html`; several PNGs →
  `<project> - láminas PNG.zip` with `01 <title> - lámina.png`, … (suffixes translated).

**UI entry points**
- `MT.export.dialog({format?, mapIds?}) → Promise<result|null>` — the export dialog: 4 format cards
  (`pptx`, `slide` = PNG slide, `map` = PNG map, `html`), map checklist with visible-store counts
  (current map preselected, Todos/Ninguno), resolution for PNG (1920/3840 px; 2×/3×/4×), the file name
  that will be downloaded. Remembers format/resolution (`MT.storage` prefs `export.*`). Used by the
  project-menu entries `export-pptx`, `export-png`, `export-html` (group `'export'`).
- `MT.export.run(format, mapIds, opts) → Promise<result|null>` — UI-level call that never rejects.
- M2's "Exportar ▾" popover (quick path: this slide / all slides, format, resolution) calls
  `MT.export.run(format, ids, opts)`; its "Más opciones" link opens `MT.export.dialog`. M2 stays quiet
  when M4 already showed a toast.

**`MT.export.png(mapIds, {kind:'slide'|'map', width=3840|1920, scale=2|3|4})`** — `MT.render.slideCanvas`
/ `mapCanvas`; one PNG per map, several maps → one `.zip` (JSZip from the PptxGenJS bundle; falls back
to one download per file). Each PNG gets a `pHYs` chunk so Office inserts it at its real size: a slide
PNG fills a 13.333 in slide, a map PNG is exactly the 7.75 in map frame.

**`MT.export.pptx(mapIds, {mapScale=3, basemapFormat='jpeg'|'png'})`** — PptxGenJS `LAYOUT_WIDE`
(basemap picture JPEG 92 % by default: indistinguishable at 1:1, ≈ 1 MB per map instead of ≈ 3.5 MB),
one slide per map (one PowerPoint
section per map when several), every object named in the selection pane, z-order:
1. `Fondo` (left-area rect), `Título` (the slide master's **title placeholder** — PowerPoint's outline,
   Zoom and accessibility checker see it), `Subtítulo` (runs; Peso value bold +
   underlined + navy; `lang es-PE` so PowerPoint spell-checks in Spanish) — geometry from
   `MT.slide.layout(cfg, 1920, rows)` (px ÷ `k` = inches, `fontPx ÷ k × 72` = pt).
2. `Mapa base`: `MT.render.mapCanvas(cfg, {markers:false, attribution:false, scale:3})` at
   `MT.theme.mapFrame` — district borders baked in.
3. Radius circles: an **ellipse** (bbox of the projected geodesic circle — exact for Mercator at city
   scale; brand fill at `theme.radius.fill` alpha, dashed outline) + a "1 km" rounded-rect label.
   A circle that does **not fit inside the frame** is baked into the basemap instead (an ellipse would
   spill over the slide; the label is then baked too).
4. Leader lines (line shapes, `theme.marker.leader`) → markers (**one picture per marker**:
   `MT.markers.image(item, style, 4)`, sorted top-to-bottom like `drawAll`; the `dot` style uses ellipse
   shapes) → store dots (ellipses, white outline). Positions: reference units × `ref2in` + frame offset —
   the test checks every picture against `MT.layout.compute` (worst error 0.00005 in). Identical
   marker pictures are stored once per slide (PptxGenJS de-duplicates by `path`).
5. `Atribución` (text box on translucent white, at `MT.layout.attributionBox()`).
6. `Panel de leyenda` (gradient + faint circles as one JPEG), `Leyenda — título`, and per row an icon
   picture (`MT.markers.icon`, 600 dpi) + a text box.
7. Speaker notes: title/subtitle, store count per legend row, radius results (counts + nearest stores
   with distances), generation date + attribution.
8. Post-processing of the written file (`groupSlideXml`, JSZip + DOMParser): everything from `Mapa
   base` to `Atribución` is wrapped in one group **"Mapa"** (child coordinates unchanged) and every
   leader becomes a **connector** glued to its store dot (`stCxn`) and its marker picture (`endCxn`,
   the side facing the dot), so PowerPoint re-routes it when a logo is dragged. Slides are skipped
   when their XML does not match the plan one-to-one.
- `markerStyle:'number'` adds store-table slide(s) (`N° · Cadena · Tienda · Dirección · Distrito`, the
  number cell in the chain colour), paginated by measured row height (wrapped addresses), title +
  header repeated, "(1/3)".
- `MT.export.pptx.plan(cfg, {mapScale, basemap, cache}) → Promise<{elements, notes, table, layout, …}>`
  — the slide as plain data in inches (what the writer emits; used by the tests).
- Verified by rendering the deck with PowerPoint itself (`--office`, Windows COM): identical to the PNG
  slide export.

**`MT.export.html(mapIds)`** — one standalone `.html` (all selected maps, tabs to switch):
- MapLibre GL **5.24.0** from unpkg, then jsDelivr, both with SRI (`MT.export.html.CDN`; the files are
  byte-identical to `vendor/maplibre`); OpenFreeMap positron with the app's Spanish-label patch,
  district borders + ocean mask, radius circles + "1 km" pills; data, logos and page script inline
  (JSON in `<script type="application/json">`, `<` escaped). Works from `file://`; offline → a clear
  message, header and legend still shown.
- Header: title + `(districts)  Peso: x`; the crimson legend panel with per-chain toggles
  (`aria-pressed`), counts (all exported stores), "Mostrar/Ocultar todas", credits; phones → bottom sheet.
- **Same markers as the slide**: DOM buttons showing the `MT.markers.image` picture of each chain, SVG
  leader lines, store dots. The declutter is pre-computed with `MT.layout.compute` (enlarged frame
  holding all exported stores) on a zoom ladder around the slide's `zoomRef`
  (`-3 … +4`, ¼–½ steps; fewer above 300 / 600 stores), computed **one level at a time with a pause**
  (progress per level, Cancel answers at once); at the slide's zoom the in-frame markers are fixed at
  their slide positions; a collapsed logo is `0` in the level and the page shows its store dot (ring
  colour, clickable).
  The page shows the layout of the highest step ≤ current zoom and **snaps the zoom to the nearest
  clean step when a zoom gesture ends** (a layout is overlap-free at its own zoom). Steps that are too
  crowded (overlaps, or — away from the slide's zoom — most markers far from their store) show brand
  dots + "Acerca el mapa para ver los logos" instead. The **opening view** is the slide's frame on a
  clean step, zoomed out further (and re-centred) until every marker of the slide's stores fits the
  window. Legend counts and the total are **recounted for the stores in view** after every move.
  MapLibre controls are localized (`D.mapLocale`).
- Popups: chain, name, address, district, "Por verificar" / approximate-location tags, radius results
  (same chain / competitors + nearest stores), Google Maps link; auto-pan so they are fully visible.
- Extras: `MT.export.html.data(maps)` (the embedded JSON), `MT.export.html.page(data)` (HTML text).
  `window.__mtPage` in the exported page exposes `{map, state, overlay, data, selectMap, toggle,
  setAll, openPopup}` for tests.

**Shared helpers** `MT.export.util` (export-png.js): `resolveMaps`, `mapTitle`, `projectName`,
`names.{pptx, html, pngEntries, pngZip}`, `job` (busy + abort + progress), `deliver` (zip / downloads),
`pngWithDpi`, `finish`, `fail`, `errorMessage`, `exportError`, `isAbort`, `zipLib`, `breathe`.

---

## 7. Conventions

- **Files:** one IIFE per file, `'use strict'`, header comment stating purpose + contract. Short comments
  where the code is not obvious. No build step, no transpiling.
- **Naming:** namespaces `MT.<module>`; CSS classes `mt-<block>__<element>--<modifier>` with a module
  prefix (`mt-maps-…`, `mt-db-…`, `mt-chains-…`, `mt-slide-…`, `mt-marker-…`); events `noun:verb`.
- **Never mutate** objects returned by `MT.data`/`MT.project` getters; use the mutation APIs.
- **Escape** any data rendered through `html:`/`innerHTML` with `MT.util.escapeHtml`; prefer `h()` with
  text children.
- **Accessibility:** real `<button>`s, labels for inputs (`<label class="mt-field">`), visible focus
  (`:focus-visible` is styled globally), keyboard paths for every action (menus, lists, dialogs),
  `aria-label`/`title` on icon-only buttons.
- **Performance:** render lists > 300 rows virtually or paged; debounce map re-renders (≈100 ms);
  keep work off the critical path until a tab is shown (tabs mount lazily).
- **Errors:** catch failures at user-action boundaries and show `MT.ui.toast(MT.t(...), {type:'error'})`;
  log with `console.error` only for real bugs (the tests fail on any console error).
- **Persistence:** UI preferences via `MT.storage.pref/setPref` (keys prefixed by module,
  e.g. `db.sort`).
- **Tests:** add `tools/test/<module>.mjs` using `openApp/screenshot/waitForMapIdle` from
  `tools/test/lib.mjs`; view screenshots; zero console errors.

### Testing quick reference

```bash
cd tools && npm install            # once (puppeteer-core, uses the system Chrome)
node tools/test/run-all.mjs        # EVERYTHING below in sequence + summary (logs in tools/test/out/logs)
node tools/test/smoke.mjs          # boot, tabs, language, missing-data path, 1280 px
node tools/test/core-api.mjs       # core API behaviour on fixtures
node tools/test/pages-smoke.mjs    # the app served over HTTP (as on GitHub Pages): boot, map, tabs, autosave
node tools/test/contracts.mjs      # every MT.* path used by any module exists at runtime; events wired
node tools/test/i18n-check.mjs     # ES/EN key parity, keys used in code exist, nothing untranslated on screen
node tools/test/e2e.mjs            # full user journey (build 3 slides, exports, DB add/edit/delete/import,
                                   #   save/open, reload) in ES and EN — --lang=es|en
node tools/test/styleguide.mjs     # design-system screenshots
node tools/test/tech-proof.mjs     # TECH-NOTES evidence (network)
node tools/test/net.mjs            # live MT.geo calls (network)
node tools/build-road-names.mjs    # (data) main avenue names from the z14 tiles → data/road-names.js (network;
                                   #   --cached rebuilds from tools/seed/.cache-roads/, --only=lima,…)
```
Module suites: `layout.test.mjs`, `maps-core.mjs` (M1), `maps-ui.test.mjs` (M2), `db.test.mjs` (M3),
`export.test.mjs` (M4), `data-roundtrip.test.mjs` (saved `data/stores.csv`/`.js` byte-identical to the
shipped files and to `tools/build-data.mjs` output with local edits; square cards; the example
project and its "save first?" flow), `robustness.test.mjs` (review fixes: Windows-1252 CSV, XLSX values, coordinate /
status / date parsing, colloquial districts, inactive radius, dot colours, wrong-folder save, two tabs,
index.html without its folder). `run-all.mjs --network` adds the live-service checks; `--only=a,b`, `--skip=a`,
`--retries=1`. `splitNetworkNoise(errors)` (lib.mjs) separates transient OpenFreeMap tile failures
(connection resets) from real app errors.
`openApp({lang, fixtures:'missing'|'all'|'none', viewport, headless, hash})` copies the app to a temp
folder, injects `tools/fixtures/*` for missing data files (fixtures: 12 real district boundaries,
63 stores in Miraflores/San Isidro/San Borja/Surquillo/Trujillo/Chimbote covering all 16 chains, one
closed, Holi without logo), opens it from `file://` with SwiftShader WebGL and collects console errors,
page errors and failed requests. `screenshot(page, name)` → `tools/test/out/<name>.png`;
`waitForMapIdle(page, {expr})` waits for MapLibre `'idle'` (default `MT.mapview.getMap()`);
`loadDemoProject(page, {select})` opens `tools/fixtures/demo.mapa.json` — the **example project**
shipped in the app (`js/example-project.js`): four maps mirroring the reference slides in
`docs/reference/`, all `badge` markers, fit to stores, no borders, alphabetical legend, chain toggles
exactly as the reference legends: Lima Metropolitana Sur (4 districts, 9 chains, a 1 km radius),
Lima Cono Sur (6 districts, manual subtitle "(Chorrillos, Lurín, Punta Hermosa, SJM, Villa el
Salvador, VMT)", 12 chains), Trujillo (Trujillo, Víctor Larco Herrera, La Esperanza, El Porvenir,
Florencia de Mora and Laredo — Makro El Bosque, on the reference's right edge, lies in Laredo — 6
chains, empty subtitle), Chimbote (Chimbote + Nuevo Chimbote, 4 chains, empty subtitle); ids
`demo-lima-sur`, `demo-lima-cono-sur`, `demo-trujillo`, `demo-chimbote`. After editing it run
`node tools/fixtures/build-example.mjs` (the roundtrip suite fails while they differ);
`node tools/test/demo-slides.mjs` exports the four slides to `tools/test/out/fix-slide-demo-*.png`
for a side-by-side look with the references. The export suite adds `card`, `dot` and `number`
copies itself. With fixture data only the districts present in the fixture are drawn (missing
ubigeos are skipped silently).

---

## 8. Phase 2 — cannibalization analysis (planned)

The user wants a fuller **cannibalization analysis** later ("analizar el radio en el que una tienda
está cerca de otras"). v1 ships the basic radius tool (SPEC §1: click a store → 500 m / 1 km / custom
circle, same-chain vs competitor counts with distances, in all exports, Excel export). Keep v1 code
ready for it:

- `MT.radius.compute` stays a **pure function** of `(mapCfg, MT.data)` returning plain data — phase 2
  reuses it for every store instead of one.
- Reserved namespace **`MT.analysis`** (do not use it for anything else), expected APIs:
  `nearest(storeId, {sameChain|competitors, limit})`, `overlapMatrix(storeIds, meters)` (pairs of
  stores closer than 2 × radius, shared catchment area via `turf.intersect`),
  `densityGrid(stores, cellMeters)` (heatmap layer), `catchmentCompare(chainA, chainB, meters)`.
  Distances with `MT.geo.distanceMeters`; spatial pre-filtering with bboxes (stores are ≈ thousands).
- Results export with `MT.io.writeXLSX`; map layers through `MT.mapview` (a future
  `MT.mapview.setAnalysisLayer(geojson, style)` hook) so they also appear in exports.
- The project model already allows extra per-map keys; phase 2 would add e.g.
  `analysis: {kind, meters, chains}` — `MT.project.normalize` keeps unknown keys.

---

## 9. Integration notes (2026-10-01)

All modules are wired and verified together on the real data (`node tools/test/run-all.mjs`). Fixes
made while integrating, so module owners know what changed under them:

- **Ring colour** is a real chain field now (`normalizeChain` keeps it, `chainsJs` writes it, Cadenas
  edits it). Before, "Guardar en carpeta" silently dropped `ringColor` from `data/chains.js`.
- **"Guardar en carpeta" refuses to write** a data file whose shipped version did not load
  (`MT.io.repoFiles().skipped`): with a missing/half-written `data/stores.js` it would have replaced
  the whole database by the local changes only.
- `MT.io.detectDelimiter` reads 12 lines (title rows above `;` headers); M3's private copy removed.
  `MT.data.newStoreId` never repeats within a session.
- DB table: double-click to edit never fired (rows are re-rendered on select) → `click.detail === 2`.
  New-store mini-map starts on Lima (or the side map's city), not mid-Andes at street zoom.
- One project menu: `MT.app.openProjectMenu` is used by the top bar and the Mapas rail (the rail's own
  copy lacked the export entries). Export format names are the same in M2's popover and M4's dialog.
- A new slide's placeholder title is selected on focus, so typing replaces it.
- At most 3 toasts at once (they no longer pile up over dialog buttons). Dead stub CSS/keys removed.
- Tests added: `contracts.mjs`, `i18n-check.mjs`, `e2e.mjs` (ES + EN journey), `pages-smoke.mjs`
  (HTTP origin), `run-all.mjs`; `maps-core.mjs` updated for the real (denser) data.

---

## 10. Review fixes (2026-10-01, second round)

Independent reviews (correctness, robustness, export fidelity, UX) found 46 issues; the fixes and
their verification are in [`TEST-REPORT.md`](TEST-REPORT.md). What changed for module owners:

- **Data safety:** overlay reconciliation at boot (edits carry `base`; published changes drop out;
  orphan edits become flagged additions), `reloadOverlay` / `overlaySnapshot` / `commitOverlay(snapshot)`
  (never `clear()` after a folder save), `fs.isRunningFolder` before writing on file://, one working
  tab (`MT.storage.channel`, `'app:paused'`, `MT.project.suspendAutosave`), storage-at-risk banner,
  unload flushes (`MT.project.flushAutosave`), index.html "missing files" fallback.
- **Import:** `MT.io.decodeText` (Windows-1252), XLSX values not display text, `parseCoord` /
  `parseStatus` / `parseDate`, no "Código" id alias, merge only for this app's ids, duplicate ids and
  coordinates outside Peru skipped, chain changes warned, address-service failures stop the batch.
- **Slides:** leader cap + collapsed logos (`item.collapsed`, `stats.collapsed`), district-name and
  radius-pill obstacles (`MT.layout.places`, `'layout:places'`), distinct dot/number colours
  (`MT.markers.markerColor`), rare chains painted last, inactive radius circles skipped
  (`MT.radius.inactiveReason`), preview gestures/nudges tied to their slide, markers one Tab stop.
- **Exports:** PPTX title placeholder, "Mapa" group, glued connectors, ring-colour ellipses for collapsed
  logos; HTML levels computed asynchronously (fewer above 300 stores), opening view fits every marker,
  legend recounted in view, map resized with its box, localized MapLibre controls; WebGL failures
  reported as such (`webgl-unavailable`).
- **UI:** no Backspace chip removal, Enter does not guess between equal district matches, hint in
  normal flow, centre column `minmax(0, 1fr)`, export popover/dialog focus, lámina wording, empty
  titles render a placeholder in the current language, subtitle wraps by district, labelled prompt
  input, AA contrast for small grey text.

---

## 11. App polish (2026-10-01, third round)

- **Example project in the app:** `js/example-project.js` (`window.MT_EXAMPLE_PROJECT`, generated from
  `tools/fixtures/demo.mapa.json` by `node tools/fixtures/build-example.mjs`; loaded by index.html as an
  optional script) + `MT.app.openExampleProject()` / `exampleAvailable()` / `isBlankProject()` +
  `MT.project.openData(obj, {name})`. Entry points: project menu *Abrir proyecto de ejemplo*, the Mapas
  empty state and the first-run *Elige los distritos* notice (*Ver ejemplo con 4 regiones*). Strings
  `project.example.*` (core). It never replaces unsaved work without the *save first?* dialog.
- **Store file order:** `MT.io.sortStores` = `tools/build-data.mjs` order; `repoFiles()` writes
  `data/stores.csv` and `data/stores.js` byte-identical to the data workflow (same header comment and
  `generated` rule in `storesJs`). The DB tab's exports use the same order.
- **Card style:** a chain without a wide logo is a square white card of the normal card height with the
  badge mark inside (was a bare colour tile filling the card).
- **Demo fixture:** all four maps now mirror the reference slides (badges, fit to stores, no borders,
  reference chain toggles); tests that need other marker styles build copies (`export.test.mjs`), and
  tests no longer assume a chain's `defaultOn` (Mass is off by default in `data/chains.js` now).
- **Overlays:** a closing `MT.ui.modal` / `MT.ui.busy` backdrop gets `.is-closing` (pointer-events
  none) during its 160 ms fade, so the user's next click is not swallowed.

---

## 12. Visual QA fixes (2026-10-01, round 1)

Visual QA of the four demo slides against the reference deck (Lima Cono Sur was not deck-ready):

- **Same-chain grouping** (§6.1): crowded maps merge nearby stores of one chain into one logo with a
  count pip ("×4"), automatically (`groupNearby: 'auto'`, Mapas switch to force it on/off). Lima Cono
  Sur: 75 stores → 38 logos; leaders over 1.5 marker sizes 26 → 6, leader crossings 25 → 3, leaders
  under another logo 34 → 3, dots on another chain's logo 5 → 0. Lima Sur, Trujillo and Chimbote are
  not crowded and stay ungrouped.
- **District names written by the app** when the basemap has none at the slide's zoom (§6.1), in the
  preview, PNG/PPTX basemap and HTML page — Lima Cono Sur now names all six subtitle districts.
- **Leaders and labels:** a leader through a district name, radius pill or the attribution costs
  `W.labelCross` + `W.labelLen`/unit (logos go beside / below a name their store sits in); leaders
  have a white halo (`theme.marker.leader.halo`; PPTX: a second glued connector under each leader);
  store dots are drawn under the logos.
- **Basemap labels as soft obstacles** (`MT.layout.labels`, harvested from the rendered map):
  "Avenida España", "Villa Nueva Navarra" stay readable when a free spot is close. Exact district
  boxes from the same harvest (estimate padding trimmed to `tw·1.04 + 6`): the Plaza Vea near San Borja
  sits right above its store.
- **Main avenue names** (motorway / trunk / primary) from basemap zoom 11.5, a little larger
  (`theme.basemap.majorRoadNames`). Note: below zoom 13 the OpenMapTiles vector tiles carry no name
  for many main avenues (Av. Javier Prado, Av. Arequipa on Lima Sur), so no style can label them there.
- **No basemap label cut by the frame or under the attribution** (`'mt-label-blockers'`, §6.1).
- **"1 km" pill** drawn in the slide font on the canvas too (the UI font's narrow space read "1km").
- Tests: `layout.test.mjs` (grouping: automatic, on/off, compact one-chain groups, one item per store,
  legend unchanged, dragged group; leader out of a district name), `export.test.mjs` (halo connectors,
  group pictures, grouped stores in the HTML page).

---

## 13. Visual QA fixes (2026-10-01, round 2)

Second visual QA of the four demo slides (Lima Cono Sur still not deck-ready). Numbers are from
`MT.layout.compute` on the demo, before → after:

- **Grouped logos tied to their stores** (§6.1): `item.spokes` — a spanning tree from the logo over
  its stores' dots (spoke to the logo's edge, or link to a neighbouring store of the group), faint, in
  the chain's ring colour (theme `marker.spoke`), drawn by `MT.markers.drawAll`, the PPTX (connectors
  glued to the dots and the logo, "Agrupación — …") and the HTML page (per zoom level, `lv.s`). No
  more loose dots: 37 of 75 stores were only dots that nothing connected. A ray to every member
  crossed the whole knot; the tree keeps the spokes to the logo ≤ 1.3 marker sizes. Placement:
  `W.groupFar`, `W.groupBlock`, `W.spoke`, logo spots in gaps among the group's own dots, and the radius
  loop keeps the tidiest layout. Legend key under the rows when the slide groups (§6.1 `MT.legend`).
- **Store dots of one mall spread apart** (`spreadDots`, theme `anchorDot.spread`; `item.dot`): 17
  different-chain dot pairs < 5 units apart → 0; the dots leaders start at are painted last
  (`MT.markers.dotOrder`; PPTX ellipses in the same order) — the 3A ×9 leader no longer ends on a Vega dot.
- **Smaller logos on a crowded map** (`aggregate.autoSize` 0.85 when 'auto' groups; `stats.size`;
  Mapas hint *Logos al 85 %…*; the HTML export keeps the slide's size on every level, `logoScale`).
  `W.through` 45 → 80 (leaders under other markers), `W.labelLeader` 5 → 12. Lima Cono Sur: mean leader
  0.8 → 0.5 marker sizes, leaders > 1.5 sizes 6 → 3, crossings 3 → 1, leaders under markers 3 → 0.
- **Basemap labels never cut by a pin, a leader or a logo**: once a view's labels are known
  (harvested from a render without them), the layout's markers (+ count pips), store dots and leaders
  are added to `'mt-label-blockers'` (`MT.mapview.basemap.blockerData(cfg, items)`, `blockerKey`); the
  preview applies them in `syncLayers`, `MT.render.mapCanvas` renders the basemap once more when the
  layout's blockers changed (`opts.blockersFor`: the PPTX basemap blocks with the full config's layout).
  No label harvest while marker blockers are on (`map.__mtMarkerBlockers`), and none from a placement
  of another camera (a widened automatic view after `harvestPlaces`; `placement.transform` checked) —
  that race had stored one view's boxes under another view's key. "CE…O" (Chimbote) and "Pampa Pacta"
  under a logo are left out instead of cut. MapLibre's variable anchors were tried and rejected:
  placement then depends on the previous frame (preview ≠ export).
- **Every selected district's name is written by the app** (§6.1 `districtLabels`: `look` city / town /
  village / suburb; layers `mt-district-labels[-city|-town|-village]` copied from positron's place
  layers, always drawn) **and moved off the store dots** (`nameClearOfDots`: small shifts, a dot on the
  letters costs most, moving and touching another name cost too; a character-width box estimate, so a
  web font loading later never moves a name). "Chimb•ote", "Nue•vo Chimbote", "Punta H|ermosa",
  "CH|ORRILLOS" → clear; SJM in the densest knot keeps two dots at its line ends.
- **Main roads** (theme `basemap.mainRoads`): motorway / trunk / primary in a faint warm fill with a
  darker casing; route shields (1S, PE-1N) from zoom 10 (`basemap.shieldMinzoom`, layer
  `mt-highway-shield-main`). **Main avenue names below zoom 14** (the tiles have none there):
  `data/road-names.js` (`window.MT_ROAD_NAMES`, built by `node tools/build-road-names.mjs` from the z14
  tiles of Lima y Callao and 9 cities; optional script) → `MT.layout.roadLabels(cfg)`: one label per
  avenue ("Av. Javier Prado Este"), on a straight stretch clear of the store dots, the district names
  and the other avenue names, written with `'line-center'` placement (`mt-road-names`); the layout keeps
  logos and leaders off them (`W.roadName`, `W.roadLeader`); inside those cities the tiles' main-road
  names start at zoom 14. The HTML page gets the raw lines near its stores (`roads`).
- **PPTX attribution** at 6 pt (theme `attribution.pptx`) on a 50 % white box, wide enough not to wrap;
  the layout's attribution obstacle covers that box too (`attributionBox().obstacle`).
- **Optional template decoration** (theme `slide.decoration`, off by default): an image over the left
  area in the preview, the PNG slide (`MT.render.decoration()`) and the PPTX ("Decoración").
- Tests: `layout.test.mjs` (auto size, spokes tree, spread dots, dot paint order, legend key),
  `maps-core.mjs` (marker blockers once labels are known, names written by the app and off the dots),
  `export.test.mjs` (spoke connectors, legend key, 6 pt attribution).
