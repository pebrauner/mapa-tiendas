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

## 5. Phase 2a — distance & cannibalization analysis: review fixes (2026-10-01)

`node tools/test/run-all.mjs` → **1,309 checks, 19/19 suites green**, zero console errors (every suite fails
on any console error, page error or failed request): smoke 38 · pages 6 · core-api 84 · contracts 18 ·
**analysis 92** · roundtrip 46 · i18n 15 · layout 60 · maps-core 76 · maps-ui 94 · db 213 · osm-rules 43 ·
export 145 · **analysis-slide 76** · **analysis-ui 108** · robustness 21 · styleguide 4 · e2e 86 ·
**analysis-e2e 84**. Not run: `net`, `tech-proof` (`--network`, live services). Also run:
`node tools/test/analysis-slide.test.mjs --office` (PowerPoint 16 opens the 4-slide analysis deck without
repair; render ≈ PNG, mean |Δ| frame 3.8 / 3.6, panel 2.7 / 2.7) and `node tools/test/demo-slides.mjs` (the 4
example slides; PNG ↔ PowerPoint mean |Δ| frame ≤ 4.21, panel ≤ 1.85, title ≤ 2.64; Calibri only).

Each finding was reproduced (reviewer probe, an equivalent probe in `tools/test/review/fx-*.mjs`, or the code
path), fixed at the root and pinned by a check (ARCHITECTURE §8.5, §15). Before → after:

| # | Area | Finding | Before | After |
|---|---|---|---|---|
| 1, 7 | Análisis tab | rings past the distance universe | universe 2 km, rings to 5 km: card "2 km 26 · 3 km 26 · 5 km 26", Excel "3 km,26", bands "2–3 km 0"; map drew empty 3 / 5 km rings (engine: 48 / 104) | cards, ring table, both Excel sheets and the map use the rings within the universe + the universe (the slide's rule): 500 m / 1 km / 2 km = `distancesFrom(maxMeters: ring)` (0/5/26), "Los anillos de 3 km y 5 km quedan fuera del universo (2 km)."; *Distritos*: "Cuenta solo las tiendas de los distritos elegidos." |
| 8 | Análisis tab | nearest same-chain store limited by the universe | Tottus San Luis, 2 km: "Ninguna de Tottus en el universo." (Jockey Plaza at 2.1 km); Excel "—" | searched in all of Peru (same chains / *por verificar*): "2.1 km · Tottus Jockey Plaza · *Fuera del universo (2 km)* · *Ampliar a 3 km*"; Excel row with metres + *Nota* |
| 2 | Data | *por verificar* off ignored on a district slide | tab 24 rows → slide 27 (+ Holi Pardo, Vivanda Pardo, Metro Express) | `MT.data.storesForMap` drops them on every analysis slide: tab 24 = slide 24 |
| 3 | Mode B | pair threshold up to 1000 km | 10 km: 985,706 pairs, 5–7 s frozen, ≈ 1 GB, Excel failed / hung; 50–90 ms per click | threshold ≤ 5 km (chips, custom box, `setMatrix`, saved settings); pairs in idle chunks (`closePairs` + `candidates`); counts cover all pairs, list / lines / Excel keep the first 50,000 with a notice. Lima province, every chain, competitors, 5 km: 334,816 pairs counted, < 1 s, longest block ≈ 0.3 s, ≈ 92 MB heap, Excel 2.4 s; a click changes one layer filter (≈ 10 ms) |
| 4, 9 | Excel (A) | "Misma cadena" counts with a decimal | "2.0", "5.0" | per-cell formats: counts `#,##0`, metres `#,##0.0` on the "más cercana" rows only |
| 5, 16 | Formatting | distance texts disagree at boundaries; no thousands separator; Excel double rounding | 999.6 m: "1 km" / "1,000 m" / "1000 m"; 12,345 m: "12 km" / "12.3 km"; "1954 km"; 322.5 next to "322 m" | one formatter (`MT.i18n.formatDistance`, 0.1 m then whole metres): "1 km", "12 km", "1,954 km", 322.5 / "323 m" everywhere (Mapas popup, slide, v1 radius notes, engine, tab, Excel) |
| 27 | Slides | typed ring labels rounded | 1250 m ring → "1.3 km" pill / "Anillo 1.3 km" / "Hasta 1.3 km" | `MT.i18n.formatDistanceExact`: "1.25 km" on the pill, the shape, the notes, the tab's and the inspector's chips |
| 10 | Análisis tab | Google Maps short link sent to Nominatim | "Buscar «https://maps.app.goo.gl/…» como dirección" → request, "No se encontraron resultados" | one disabled option with `geo.error.shortlink` (or `invalid`); Enter never geocodes a URL; a full link's `/place/Parque+Kennedy/` prefills the label |
| 11 | Layout | matrix unreadable at 1366 × 768 | table 189 px, 2 rows | `max-height: 820px`: two-line cards, 22 % map strip, denser rows → 8 full rows (checked) |
| 12 | Excel (B) | *Por tienda* not client-ready | id order, ID first, "Distancia (m)" twice | the tab's order (nearest same-chain first), chain / store first, ids last, distinct headers |
| 13 | Excel | no frozen / bold header | `<sheetView workbookViewId="0"/>` | `MT.io.polishXLSX` (also in `MT.io.writeXLSX`): bold header rows on a fill, frozen header on data sheets; Excel 16 via COM: *Distancias*, *Por tienda*, *Pares cercanos* FreezePanes = true, A1 bold |
| 14 | UI | units upper-cased | "HASTA 500 M", "MISMA ≤ 1 KM" | `.mt-unit`: "HASTA 500 m", "MISMA ≤ 1 km", "PARES … A MENOS DE 1 km" |
| 15 | UI | flags column "Marcas" | — | "Alertas" |
| 17 | Análisis tab | no-store state | 6 clicks to learn the nearest store is 210 km away; Excel / slide live with 0 rows | "La tienda más cercana es Precio Uno La Merced, a 210 km." + one button (*Todo el Perú*); Excel, *Agregar* / *Actualizar la lámina* disabled (API returns null) |
| 18 | Keyboard | Esc did not close a card | popup stays | Esc closes it, focus stays on the table |
| 19 | Excel | store totals differ from the header | "(3,561 tiendas)" vs "3,557 tiendas en la base" | "Datos del 2026-10-01 (3,557 tiendas activas) · 4 cerradas, excluidas" |
| 20 | Wording | ES / EN | "Ninguna de Tottus…", "Líneas a la más cercana…", "Own chain", mixed spelling | "No hay otra tienda Tottus en la base.", "Ninguna entre las cadenas elegidas.", "Líneas a la tienda más cercana de cada cadena"; EN "Your chain (optional)", "Pick your chain to split “same chain” from “competitors”." |
| 21 | PPTX | lines drawn over the ring pills | pills pushed before lines | rings → lines → pills, as `MT.render.drawOverlay` (plan-order check) |
| 22 | HTML | reference store unmarked in dot / number styles | `{pin: false, refMk: false}`: a plain dot / "4" pin | `analysis.halo` → the page rings the reference marker (white gap, dark ring, white casing; `.mk--ref`, labelled "Referencia — …"); data + page checked |
| 23 | PPTX | lines re-glue 5.2 pt below the pin tip | glue site = bottom of the halo / shadow margin | the pin picture is cut at its tip (`pinImage(scale, {tipAtBottom})`): bottom-centre site = tip (≤ 1e-6 in) |
| 24 | PPTX | line to a collapsed logo not glued | `msoLine` without connections | glued to the collapsed ring-colour dot (`startRole: 'marker'`); slide D: 15 / 15 connectors incl. Flora y Fauna Cavenecia |
| 25 | PPTX notes | district slide said "tiendas hasta 2 km"; "1 tiendas" | — | "tiendas de los distritos seleccionados"; "1 tienda" |
| 26 | Slides | flags dropped from the distance list | "Pardo 750 m" | "≈ 750 m" in the preview, PNG, PPTX text and HTML list; notes "— ≈ 750 m (ubicación aproximada, por verificar)" |
| 6 | Data | press row cites the official list | "…no figura en la lista oficial; distrito según la lista oficial: Callao" | `tools/merge.mjs`: "distrito según la prensa: Callao"; rerun `--offline` (only that row changed in `data/stores.csv`; `data/stores.js` rebuilt; REPORT.md unchanged) |

**Partly accepted (with reason).** #20 asked for US spelling; the rest of the English UI is consistently
British (colour, centre, neighbouring, analysed, recognised), so the analysis strings now follow it
("cannibalisation") — one convention, the app's. #26: the slide shows "≈" rather than a footnote (the
reviewer's first option; no extra legend row competes for space), and the notes spell the flags out. #11: a
denser layout rather than a map toggle (8 rows without an extra click). #5: the v1 radius tool's typed radii
keep `formatMeters` (now = the measured formatter; its presets are round numbers) — SPEC §6.3 keeps that tool
as is. Nothing rejected outright.

**Visual verification.** Análisis tab, both modes (`tools/test/out/final-an-a-pv-5km.png`,
`final-an-a-tottus-2km.png` — the outside-the-universe card and the cut-rings line —, `final-an-a-ringtable.png`,
`final-an-b-moderna.png`, `final-an-b-1366.png`, `final-an-a-en.png`); analysis slide PNG `analysis-slide-a.png`
("≈" rows right-aligned) and its PowerPoint render `analysis-slide-ppt-1.png`, point slide
`analysis-slide-ppt-2.png` (lines meet the pin tip, under the pills); the 4 example slides
`fix-slide-demo-*.png` (contact sheet `final-demo-4.png`) and `ppt-compare-demo-*.png` — unchanged look.

**Known limitations (this round).** The pair list is capped at 50,000 (the counts are not); the 22 % map strip
on short windows is an overview (selecting a store or pair zooms to it); the PPTX pin picture leaves out the
halo sliver and shadow under its tip (≈ 1 pt, within the PNG ↔ PowerPoint tolerance).
