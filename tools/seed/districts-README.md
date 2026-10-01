# Peru district boundaries — source, license, build

Built by `node tools/build-districts.mjs` (Node built-ins + `npx -y mapshaper@0.6.121`).
Checked by `node tools/seed/verify-districts.mjs`. Last build: 2026-10-01.

## Files

| File | What | Size |
|---|---|---|
| `data/districts.js` | `window.MT_DISTRICTS = <TopoJSON Topology>`, object `districts`, 1,891 geometries. `properties` are exactly `{ ubigeo, district, province, department }`. Every geometry object also carries a `bbox: [w, s, e, n]` (TopoJSON allows `bbox` on any object; `topojson-client` ignores it). Quantized (1e6) and simplified per district (see below). | 2.79 MiB |
| `tools/seed/districts.geojson` | High-detail FeatureCollection (same properties) for point-in-polygon in Node. Coordinates to 6 decimals. **Not in git** (`.gitignore`, since 2026-10-01): it is derived and too big. Re-create it before running `tools/merge.mjs` (see below). | 33.2 MiB |
| `tools/seed/pip.mjs` | `loadDistricts()`, `locate(lat, lng)`, `locateNearest(lat, lng, maxMeters)`, `listDistricts()`, `createIndex(featureCollection)` | |
| `tools/seed/key-ubigeos.json` | Check points with their resolved ubigeos, the ubigeos of key districts, and the districts of the Lima, Callao, Trujillo and Santa (Chimbote) provinces | |
| `tools/seed/districts-build-report.json` | Counts, sizes, settings and the name-matching report from the last build | |
| `tools/seed/preview-lima.png` | Lima Metropolitana (Lima province + Callao) rendered from `data/districts.js` | |
| `tools/seed/topo.mjs`, `render-districts-preview.mjs`, `verify-districts.mjs` | Helpers: decode the TopoJSON, render previews with headless Chrome, run the checks | |
| `tools/seed/.cache-districts/` | Downloaded sources and intermediate files. Ignored by git through its own `.gitignore`. | ~120 MB |

## After a fresh clone: re-create `districts.geojson` before the seed merge

`tools/seed/districts.geojson` is ignored by git, so a fresh clone does not have it. The app does not need it (it reads
`data/districts.js`, which is committed), but `tools/merge.mjs` does: it places every store in its district with
`tools/seed/pip.mjs`, which loads this file. Run, from the repo root:

```
node tools/build-districts.mjs     # downloads the INEI/SDOT layer + OSM names (cached in tools/seed/.cache-districts/), ~1-3 min
node tools/merge.mjs               # then the seed merge (and node tools/build-data.mjs)
```

`build-districts.mjs` needs the network on its first run (WFS, Overpass and `npx -y mapshaper@0.6.121`) and also
rewrites `data/districts.js` and `tools/seed/districts-build-report.json`. If the upstream sources changed since the
last build, those change too: check `git diff --stat data/districts.js` and keep or revert it deliberately. Without
the file, `tools/merge.mjs` stops with this instruction instead of failing on a missing file.

## Sources

### Geometry and ubigeo: INEI census limits, 2023 edition (used)

- **What:** INEI *límites censales* (census limits), district level, 2023 edition. There are 1,891 districts, each with
  the 6-digit INEI `ubigeo` (for example `150122` is Miraflores). The data covers 196 provinces and 25 departments
  (24 departments plus the Provincia Constitucional del Callao). This is the newest complete set I could find: it already
  includes recently created districts such as Alto Trujillo (`130112`).
- **Where:** the GeoServer of the PCM's *Secretaría de Demarcación y Organización Territorial* (SDOT), which also
  feeds the SDOT map viewer at <https://geosdot.servicios.gob.pe/visor/>.
  - WFS: `https://geosdot.servicios.gob.pe/geoserver/geoportal/wfs`, layer `geoportal:v_distritos_2023`
  - Fields: `ubigeo, nombdep, nombprov, nombdist, capital, region_nat, tipo_norma, numero, fecha_fin, comentarios`
  - Downloaded as GeoJSON, one request per department (`CQL_FILTER=ubigeo LIKE 'NN%'`, EPSG:4326), with a pause
    between requests. The WFS reported `numberMatched: 1891`.
- **License and terms:** the service publishes no explicit license. Its WFS capabilities declare `Fees: NONE` and
  `AccessConstraints: NONE`. It is public information from the Peruvian State. The SDOT viewer shows this notice
  (paraphrased): *these are census limits produced by INEI. They are referential, are not territorial limits, and
  have no demarcation effect. Publishing them does not mean SDOT-PCM validates them.* Treat the boundaries as
  approximate. They are good for statistics and maps, but not for legal purposes.
  Suggested credit: "Límites distritales: INEI, límites censales 2023 (vía SDOT-PCM)".

### Proper-case names with accents: OpenStreetMap (used for names only)

INEI names are in UPPERCASE without accents (`VILLA MARIA DEL TRIUNFO`). The correctly spelled forms
(`Villa María del Triunfo`, `Áncash`) come from the OpenStreetMap administrative boundary relations in Peru.
OSM has 1,891 `admin_level=8` relations, 196 `admin_level=6` relations and 25 `admin_level=4` relations. All districts
and departments, and 195 of the 196 provinces, are tagged `pe:ubigeo`. They were read with one Overpass query (`out tags`). No OSM geometry is used.

- **License:** ODbL 1.0, © OpenStreetMap contributors. The project already credits OSM (SPEC §2.5).
- **Matching rule:** match by ubigeo. The OSM spelling is used only if, with accents and case removed, it equals the
  INEI name word for word. INEI's own word separators are kept. Otherwise the INEI name is title-cased in the Spanish
  style (`de`, `del`, `la`, … in lowercase), and accents are restored from a word dictionary learned from all OSM names.
  Departments use the OSM `official_name` with "Departamento de" removed, which gives `Áncash` instead of `Ancash`.

### Candidates that were checked and not used

| Candidate | Why not |
|---|---|
| HDX "Peru – Subnational Administrative Boundaries" (`cod-ab-per`, OCHA COD-AB, CC BY-IGO) | Only **1,873** ADM3 units. The boundaries were made by IGN in 2015, so districts created since then are missing. Names have no accents (`Villa Maria del Triunfo`). |
| geoBoundaries PER ADM3 | The API `https://www.geoboundaries.org/api/current/gbOpen/PER/ADM3/` returned 404 when checked. |
| ANA ArcGIS `Limite_Distrital_DU_N_030_2023` | Only 220 features: a subset, not all of Peru. |
| github.com/juaneladio/peru-geojson | A pre-simplified 1.9 MB `peru_distrital_simple.geojson`. Not evaluated in depth, because a current official source with all 1,891 districts was available. |

## Name decisions (from the last build)

- 1,875 district names were matched to OSM. All 196 provinces except one and all 25 departments were also matched.
- **14 districts and 1 province were title-cased from INEI**, because the OSM spelling differs from INEI's. INEI's spelling is
  kept (SPEC §3.1: "INEI spelling"). In parentheses is the OSM spelling, which was not used:
  `010110 Leimebamba` (Leymebamba) · `030214 San Miguel de Chaccrampa` (Chaccrapampa) · `030407 Ihuayllo` (Huayllo) ·
  `051010 Hualla` (Huaya) · `061111 San Silvestre de Cochan` (Conchán) · `080807 Suyckutambo` (Suykutambo) ·
  `100106 Quisqui (Kichki)` (Quisqui) · `120127 Quichuay` (Qhichuay) · `120129 San Agustín` (San Agustín de Cajas) ·
  `150612 Veintisiete de Noviembre` (27 de noviembre) · `151003 Allauca` (Ayauca) · `200115 Veintiséis de Octubre`
  (26 de Octubre) · `220709 Tingo de Ponasa` (Ponaza) · `250201 Raimondi` (Raymondi) · province `0503 Huanca Sancos`.
- **Overrides** (`NAME_OVERRIDES` in the build script):
  - `060506` Santa Cruz de Toledo: the INEI name field is cut off (`SANTA CRUZ DE TOLED`).
  - `070103` Carmen de la Legua Reynoso: OSM writes "de La Legua" with a capital L.
- **Word fix:** `VEINTISEIS` becomes `Veintiséis` (standard spelling; the word never appears in OSM).

## Geometry processing

1. `mapshaper -clean` repairs the census polygons: it removed 30 of 36 slivers (overlaps and gaps under about 0.05 km²)
   and kept all 1,891 features. The result is stored as an unquantized topology, which both outputs share.
2. High-detail file: `-simplify interval=3` (metres) with `keep-shapes`. The source is already generalised, so this
   removes almost nothing. Size is driven by vertex count (about 1.7 M vertices in the source).
3. App file: `-simplify variable interval=simp_m keep-shapes`, where
   `simp_m = clamp(4.5 × √(area km²), 12 m, 400 m)`. Small urban districts keep about 12–30 m detail, and huge Amazon
   districts are simplified harder. When two districts share a border, mapshaper keeps the **finer** interval of the two,
   so a city border stays detailed even if one side is a large rural district. Then `quantization=1e6` (a grid of about
   1.4 m), a bbox for each geometry, and the result is wrapped as `window.MT_DISTRICTS = …;`.

Tuning (these numbers are from experiments on this data):

- Raising the maximum from 260 to 600 m saved only about 50 KB.
- Changing quantization from 2e6 to 1e6 saved about 140 KB.
- Raising the multiplier from 4.5 to 5.5 would bring the file down to about 2.6 MB if more room is ever needed.

## Verification (`node tools/seed/verify-districts.mjs`, all checks pass)

- 1,891 features and 1,891 unique 6-digit ubigeos. 196 provinces, 25 departments. Properties are exactly the four
  required keys. No names in all caps.
- Check points (high-detail file; the simplified file gives the same answer for every point):

  | Point | lat, lng | Result |
  |---|---|---|
  | Larcomar | -12.1318, -77.0305 | `150122` Miraflores, Lima, Lima |
  | Plaza de Armas de Trujillo | -8.1116, -79.0297 | `130101` Trujillo, Trujillo, La Libertad |
  | Real Plaza San Borja area | -12.0898, -77.0050 | `150130` San Borja, Lima, Lima |
  | Chimbote Plaza de Armas | -9.0745, -78.5936 | `021801` Chimbote, Santa, Áncash |
  | Nuevo Chimbote | -9.1258, -78.5245 | `021809` Nuevo Chimbote, Santa, Áncash |
  | Lurín | -12.2747, -76.8706 | `150119` Lurín, Lima, Lima |
  | Punta Hermosa | -12.3367, -76.8240 | `150126` Punta Hermosa, Lima, Lima |

- The simplified and high-detail files were compared on 13–17 k random land points per city. They agree on 99.94 %
  in Lima Metropolitana, 99.98 % in Trujillo and 99.92 % in Chimbote. Any differences lie within a few metres of a border.
- Visual checks were rendered at zoom 13–14 with the high-detail outline drawn on top (`render-districts-preview.mjs
  lima-sur|trujillo|chimbote --hi`). In the cities, the two outlines stay within 1–2 px of each other.

## Using it

```js
import { locate, locateNearest } from './tools/seed/pip.mjs';
locate(-12.1318, -77.0305);          // { ubigeo: '150122', district: 'Miraflores', province: 'Lima', department: 'Lima' }
locateNearest(-12.1335, -77.0335);   // just off the coast → { …Miraflores, distanceM: 155.1 } (null if > maxMeters, default 300)
```

- `locate` returns `null` for points in the sea or outside Peru. The census coastline is approximate, so for stores on
  the shoreline use `locateNearest(lat, lng, 300)`.
- Holes and MultiPolygons are handled with the even-odd rule. If polygons overlap, the lowest ubigeo wins.
  The data has 8 MultiPolygons and 2 holes (enclaves inside `040119` and `200601`).
- Loading takes about 0.3 s, and a lookup takes about 2 µs on average (grid index of 0.1° cells, then a bbox prefilter, then ray casting).

## Rebuilding

```
node tools/build-districts.mjs            # uses tools/seed/.cache-districts/ when it is there
node tools/build-districts.mjs --refresh  # downloads again (25 WFS requests + 1 Overpass query)
node tools/seed/verify-districts.mjs      # checks + rewrites key-ubigeos.json
node tools/seed/render-districts-preview.mjs lima   # → tools/seed/preview-lima.png
```

With the same inputs, the output files are identical from one run to the next. Only the date in the
`data/districts.js` header comment changes. When rebuilding later, check whether SDOT has published a
newer layer (for example `v_distritos_2025`) in the WFS capabilities, and update `WFS_LAYER` and `EXPECTED_DISTRICTS`.
