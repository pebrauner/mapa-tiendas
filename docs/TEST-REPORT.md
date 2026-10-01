# Mapa de Tiendas — test report

Date: 2026-10-01 · Windows 11, Chrome (system install) headless with SwiftShader WebGL, Node 24 ·
real data (`data/*.js`, `logos/logos.js` as produced by the data workflow; fixtures only for files
that are missing). This report covers the round of fixes made after the independent reviews.

## 0. Round of 2026-10-01 (later): OSM rules in the app, `data/chains.js` round trip, PowerPoint render

`node tools/test/run-all.mjs`: **901 checks, 15/15 suites green**, zero console errors — smoke 37 · pages 6 ·
core-api 84 · contracts 18 · roundtrip 46 · i18n 15 · layout 35 · maps-core 68 · maps-ui 94 · db 213 ·
**osm-rules 43 (new)** · export 131 · robustness 21 · styleguide 4 · e2e 86. (`db` runs on the fixtures, i.e. an
old-format `data/chains.js` without `MT_OSM_RULES`: it covers the built-in fallback; `osm-rules` runs on the real data.)

**In-app OSM scan = seed rules** (`node tools/test/osm-rules.test.mjs`, real data):

| Check | Result |
|---|---|
| `MT.osm.classifyTags` vs `tools/seed/osm-rules-fixtures.json` | 177 / 177 fixtures (chain, via, kind, noCoords) |
| vs `tools/seed/osm-classify.mjs` on `tools/seed/osm-raw.json` | 2,426 / 2,426 elements identical (incl. `reason`, `doubt`); = `merge-log.json` (1,456 chain-matched: 723 shop, 8 building, 8 weak, 1 closed, 716 excluded) |
| Overpass pre-filter built from the rules (`name`, `name:es`, `brand` + unanchored ERE; `brand:wikidata` + QIDs) | lets through all 1,456 chain-classified elements (raw tags) |
| Seed's raw elements → app pipeline (classify → cluster → area) vs `stores.csv` rows with `source=osm` | Lima Metropolitana Sur 105/105 · Lima Cono Sur 51/51 · Trujillo 28/28 · Chimbote 10/10 · all Peru 711/712 same id and chain; the 712th (`osm-n13699135001`, Mass) is a weak element the merge kept because the official list confirms it → shown by the app as «Dudosa» |
| `MT.osm.scan` of each demo area, Overpass answering the seed's elements | 0 new, 0 moved, 0 not found; every OSM row matched by its own id (105, 51, 28, 10); doubtful proposals only for the 3 weak elements the seed dropped |
| Real rules | "Metro de Lima" / "Metro 2", Tambo social centres (`operator`), "Tambo de Mora", "Tottus al paso", "Mass Chicken", "Holi Day", "Oxxo Gas", "Inca Garcilaso de la Vega", "3A" blocks, closed, weak, brand-vs-name order — all as in OSM-RULES.md §5 |
| Cadenas tab, advanced section | every per-chain key shown and editable; tester folds the name and applies the exclusions; saving keeps the other keys; the scan uses the edit at once |

**Data files.** "Guardar en carpeta" writes `data/chains.js` byte for byte (15,056 bytes, `MT_OSM_RULES` block
included), `data/stores.csv` (955,644 B) and `data/stores.js` (1,585,296 B) too; an edited chain changes only its
own line and the seed's reference classifier compiles the result. New maps: Mass, Tambo and Oxxo off; ring colours
read (Mass `#0A2DB7`); 15 wordmark cards + Holi as a square card.

**Demo slides and PowerPoint** (`node tools/test/demo-slides.mjs`): the built-in example project → 4 PNG slides
(`tools/test/out/fix-slide-demo-*.png`), one deck (`demo-slides.pptx`, 4.0 MB), opened by Microsoft PowerPoint 16.0
through COM (read-only, no window: no repair prompt) and exported (`ppt-render-demo-*.png`, 1920×1080);
`ppt-compare-demo-*.png` stack reference | app PNG | PowerPoint. Only Calibri is used; every text box is one line
inside its box. Mean |Δ| PNG ↔ PowerPoint (0–255): map frame 4.17 / 3.91 / 2.66 / 1.76, legend panel ≤ 1.70,
title area ≤ 2.64. Fixed: a selected district's name cut by the frame edge ("Nuevo Chiml…" on Chimbote) — the
automatic view now widens to keep those names whole (Trujillo's "Florencia de Mora" also moved off the top edge).

## 1. Automated suites

`node tools/test/run-all.mjs` — every suite opens the app from `file://` in a fresh profile and fails
on any console error, page error or failed request.

| Suite | Checks | Result | Covers |
|---|---:|---|---|
| smoke | 37 | PASS | boot, tabs, ES/EN, missing data files, 1280 px |
| pages | 6 | PASS | served over HTTP like GitHub Pages: boot, map, tabs, autosave |
| core-api | 84 | PASS | data, geo, io, project, logos APIs |
| contracts | 18 | PASS | every `MT.*` path used by a module exists; events wired |
| i18n | 15 | PASS | ES/EN key parity, keys used in code exist, nothing untranslated on screen |
| layout | 34 | PASS | deterministic declutter; leader cap; logos shown as dots counted |
| maps-core | 68 | PASS | map, slide, markers, legend, radius, render (incl. no-WebGL path) |
| maps-ui | 94 | PASS | Mapas tab |
| db | 206 | PASS | database, chains, import/export, OSM scan (mocked) |
| export | 109 | PASS | PNG / PPTX / HTML exports (PPTX geometry vs layout, group + connectors, title placeholder, PPTX re-draw ≈ PNG) |
| robustness *(new)* | 21 | PASS | review fixes: Windows-1252 CSV, XLSX values, coordinate/status/date parsing, colloquial districts, inactive radius, distinct dot colours, wrong-folder save, two tabs, index.html without its folder |
| styleguide | 4 | PASS | design-system catalogue |
| e2e | 86 | PASS | full user journey in Spanish and English |
| **Total** | **782** | **13/13 green** | |

Not run in this round: `net` and `tech-proof` (`--network`: live Nominatim / Overpass calls). Both
services are mocked in `db` and were exercised by the probes below.

## 2. Review findings — verification

Each finding was reproduced with the reviewers' probe scripts (`tools/test/review/*.mjs`) or an
equivalent probe, fixed at the root, and re-checked. Numbers are before → after.

| # | Area | Check | Before | After |
|---|---|---|---|---|
| 1 | CSV import | Excel "CSV (delimitado por comas)" (Windows-1252) | `Pe�aflor`, `Direcci�n` unmapped | `Peñaflor`, all headers mapped; UTF-8/UTF-16 still read |
| 2 | Slide switch | wheel-zoom / +/− / keyboard nudge, then switch slide | previous slide's framing / nudge saved on the new slide | new slide untouched; nudge saved on its own slide |
| 3, 22 | Local changes vs newer data | publish, re-ship seed with corrections, re-scan ids | 3 local changes forever, stale address, orphan note invisible | published changes reconcile to 0; untouched fields follow the new seed; orphan edits kept as flagged local stores and written by "Guardar en carpeta" |
| 4 | XLSX import | latitude in a 2-decimal "Número" column | `-12.12` | `-12.121912` |
| 5 | Editor | Ctrl+Enter while typing a latitude | old latitude saved, "Cambios guardados" | typed value saved; an unreadable value blocks the save with an error |
| 6 | Import ids | "Código" column with client codes | store `101` created, then overwritten by another chain | not an id column → appended with new ids; merge only for this app's ids; chain changes warned |
| 7 | District search | `surco` / `magdalena` / `cercado` + Enter | Surco (Huarochirí) / Magdalena (Cajamarca) / nothing | Santiago de Surco / Magdalena del Mar / Lima; equally good matches ("San Juan") ask instead of guessing |
| 8 | Coordinates & status | `12.0800 S`, swapped columns, "Cerrado permanentemente" | `+12.08`, outside Peru, verified | `-12.08`, swapped back, closed; rows still outside Peru skipped; unknown status → por verificar |
| 9 | Import | same id twice in one file | duplicate store created | second row skipped ("ID repetido en el archivo") |
| 10 | Import | `updated` = `1/10/2026` | stored as is | `2026-10-01` |
| 11 | Unknown chain ids | import of `supermercadosx` on an open slide | on the map, no toggle | toggle appears (`chains:changed`) |
| 12 | Unload | type a title, reload at once | lost | kept |
| 13 | Two tabs | A adds a slide + a store, B opens, B edits, A reloads | A's slide and store lost | A paused (dialog), its last edit written first; B has everything; "Seguir en esta pestaña" takes over and pauses B; both stores present |
| 14 | Blocked storage | site data blocked / localStorage throws | "1 cambio local", no warning, lost on reload | red banner with *Guardar el proyecto* / *Guardar en carpeta*; the browser asks before leaving with unsaved work |
| 15 | Folder of another copy | remembered handle = old copy | files written there, overlay wiped, current copy reloaded without them | nothing written, overlay kept, "Esa no es la carpeta que tienes abierta"; right folder → written, committed, reloaded with the store in the seed |
| 16 | index.html alone | opened inside the ZIP / partial copy | endless "Cargando…" | bilingual "Extraer todo" message listing the missing files |
| 17 | Geocoding failures | Nominatim 429 / 500 / offline during import | 8 requests, "Dirección no encontrada" for all | 429: 1 request; errors: 3; dialog "No se pudo consultar el servicio de direcciones" with Reintentar / Importar las demás / Cancelar |
| 18 | HTML export responsiveness | longest main-thread block / Cancel | 600 stores 12.9 s, 1000 stores 11.6 s; Cancel after 30 s | 0.98 s / 2.6 s per level; Cancel answered after 1.3 s |
| 19 | Basemap after reconnect | start offline, go online | stuck on the error | reloads by itself (also *Reintentar*); DB map too |
| 20 | No WebGL | `--disable-webgl --disable-3d-apis` | DB tab throws on every keystroke; export blamed the internet | DB tab and editor work with an explanation; exports say "WebGL desactivado" |
| 21 | OSM scan offline | every server unreachable | 32 s per area (≈ 9 min for Lima) | 4 s, or immediately when the browser is offline: "Sin conexión a internet" |
| 23 | Dense slides | Lima Cono Sur (205 stores), Trujillo cards, 746-store stress | longest leader 373 / 401 units, 17 / 489 overlaps | ≤ 108 / 125 units (cap 2.6 marker sizes), 0 overlaps; logos without room become ring-colour dots (Cono Sur: 114 of 205), with a hint, a chip and an export-dialog warning |
| 24 | Dot / number colours | Plaza Vea vs Wong vs Vega, Mass vs Metro | indistinguishable (ΔE 3.7–10) | distinct per chain (min CIEDE2000 15.6 over all chains); Mass blue as its ring |
| 25 | Radius around a hidden store | store hidden / chain off | circle + "1 km" around nothing, in PPTX notes | no circle in any output; the radius card says why and offers the fix |
| 26 | HTML opening view | 1366 × 768 | Trujillo 16 markers cut, 18 outside | 0 cut, 0 outside (all maps, 1366 × 768 and 1920 × 1080) |
| 27 | PPTX editing | PowerPoint 16 via COM | 330–650 loose shapes, leaders stay behind | one group "Mapa" per slide; 99 / 91 / 103 leaders are connectors glued to dot and logo — moving a logo re-routes its leader |
| 28 | District names | Lima Sur | SAN ISIDRO, SAN BORJA, SURQUILLO, MIRAFLORES half hidden | readable (markers avoid where the basemap writes them) |
| 29 | HTML legend counts | manual view | whole-area counts | counts of the stores in view, updated after every move |
| 30 | Dot style | rare chain under a big one | 3 dots fully hidden, single Tottus under Cash & Carry | 0 fully hidden; rare chains drawn on top; coincident dots fanned out |
| 31 | PPTX title | outline / accessibility checker | "Missing slide title" | title placeholder (PowerPoint `HasTitle` = true) |
| 33 | Layout at laptop width | 1366 px, long title | Export button under the inspector | title truncates; Export stays at 880–1008 px |
| 34 | Backspace in district search | hold Backspace | all 6 districts removed | text only (6 → 6) |
| 35 | Keyboard | Tabs from Export to the first setting (Cono Sur) | 212 | 8 (markers are one Tab stop; PageUp/PageDown move between stores) |
| 36 | Hint over the slide | 1366 × 633 / 1280 × 620 | covers the title band | hint above the slide in normal flow at every size |
| 37 | MapLibre tooltips | Spanish UI / exported HTML | "Zoom in", "Map" | "Acercar", "Mapa", … (UI language) |
| 39–46 | Small UI | export popover focus, dialog focus return, lámina wording, placeholder titles, start card, subtitle wrap, prompt label, contrast | — | fixed (see the fixer summary); contrast of the flagged texts ≥ 4.5:1 |

## 3. Visual verification

The four reference-style slides were exported as PNG (1920 px) with `node tools/test/demo-slides.mjs`
→ `tools/test/out/fix-slide-demo-{lima-sur,lima-cono-sur,trujillo,chimbote}.png` and compared by eye
with `docs/reference/*.png`: same red layout, uniform markers, legends matching the maps. The demo deck
was also exported as PPTX and rendered by PowerPoint 16 (`fix-office-slide*.png`): identical to the PNG
slides. Lima Cono Sur keeps its logos near their stores and shows the rest of its 205 stores as dots in
the chains' ring colours; Chimbote (dot style) now has one distinct colour per chain.

## 4. Known limitations

- **Session-only site data** (Chrome/Edge "clear site data when closing", corporate policy) cannot be
  detected by a page: the app warns only when storage is blocked outright. Users in that situation must
  rely on *Guardar el proyecto* and *Guardar en carpeta*.
- **District-name positions** come from the basemap tiles: a slide's markers may re-arrange once, the
  first time its area loads on a given PC (later loads and exports use the cached positions). Before
  that, the district's visual centre stands in. A marker can still touch a name when nothing else is free.
- **Very dense slides** show many stores as dots (e.g. Lima Cono Sur: 114 of 205); the app suggests
  smaller logos, zooming in or the dot style. In the capped layout a logo may sit over a neighbouring
  store's dot (dots are drawn on top, so every location still shows).
- **Dot style** in tight clusters: up to ~40 % of dot centres are partly covered (none fully hidden).
- **Interactive HTML** of 1,000+ stores: each zoom level still blocks the page up to ≈ 2.6 s (progress
  and Cancel work between levels).
- **PowerPoint connectors** glue to the marker picture's box (which includes the shadow margin), so a
  re-routed leader ends a few points before the round badge.
- **Data-workflow items (not app code)**: some badge logos are small inside their square (Mass,
  Dollarcity) or lack the wordmark (Plaza Vea, Tottus) — chains can now set `badgeZoom` in
  `data/chains.js`; and 3,508 seed stores carry English provenance notes ("official list", "geocoded
  from …") that Spanish users see in *Notas* and in CSV/XLSX exports.
- `net` / `tech-proof` (live services) were not part of this run.

## 3. App polish round (2026-10-01, later)

`node tools/test/run-all.mjs` → **843 checks, 14/14 suites green** (smoke 37 · pages 6 · core-api 84 ·
contracts 18 · **roundtrip 39 (new)** · i18n 15 · layout 34 · maps-core 68 · maps-ui 94 · db 206 ·
export 131 · robustness 21 · styleguide 4 · e2e 86), zero console errors.

- `data-roundtrip.test.mjs` (new): the app's "Guardar en carpeta" output for the shipped data is
  byte-identical to `data/stores.csv` (BOM, CRLF, quoting, 6-decimal coordinates) and `data/stores.js`;
  with local edits (accents, ñ, an unknown chain, a closed store, a deletion) the real
  `tools/build-data.mjs` run on the app's CSV produces exactly the app's `stores.js`. Square cards for
  chains without a wide logo. The built-in example project: in sync with its fixture, chain toggles =
  reference legends, opens directly on a blank project, asks before replacing unsaved work
  (cancel / open without saving / save first), confirmation for a saved project, empty-state and
  first-run buttons, Spanish and English.
- `export.test.mjs`: the demo maps are all badges now, so the suite adds card (count sort, crowded)
  and dot (borders, fit to districts) copies next to the numbered one; marker-media sharing is checked
  per chain. `maps-core.mjs` dense case and `e2e.mjs` chain defaults no longer depend on the demo's or
  `data/chains.js`'s `defaultOn` values.
- Fixed while testing: a fading modal/busy backdrop swallowed the next click for 160 ms (seen as the
  Exportar popover not opening right after an export).
