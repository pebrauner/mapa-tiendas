## 0. Notes (hand-written; `tools/merge.mjs` inserts this file into the report on every run)

### What changed in the 2026-10-01 data polish

- **Mass is off by default.** `"defaultOn": false` in `tools/seed/chains/mass.json` (→ `data/chains.js`): like Tambo and
  Oxxo it is a ~1,600-store proximity format that the reference slides never show and that swamps a map; users switch it
  on per map. §3 marks it *(default off)*, so the "with default-on chains" totals drop (Lima Metropolitana Sur 99 → 54,
  Lima Cono Sur 205 → 75, Trujillo 125 → 23, Chimbote 48 → 7). No row changed.
- **The OSM rules moved into `data/chains.js`.** Name patterns, look-alike exclusions (`excludeNameRegex`,
  `excludeTags`), shop types and formats are now the `osm` object of each chain, and the cross-chain rules (closed shops,
  transit/parking/banks/schools, "not the chain" notes, doubtful positions, retail buildings, radii) are
  `window.MT_OSM_RULES`; both are edited in `tools/seed/chains/<id>.json` and `tools/seed/osm-rules.json`. The merge
  classifies with exactly what it writes to `data/chains.js` (`tools/seed/osm-classify.mjs`), so the app's OSM scan can
  use the same rules. Proof: with the rules moved and nothing else changed, `data/stores.csv`, `data/stores.js`, this
  report and `merge-log.json` came out byte-identical; `node tools/seed/check-osm-rules.mjs` re-checks all 2,426 scanned
  elements (0 differences). Schema for the app: `tools/seed/OSM-RULES.md`; fixtures for a port: `tools/seed/osm-rules-fixtures.json`.
- **Notes are in Spanish.** Every generated text of the `notes` column is now Spanish (the audience is a Peruvian
  analyst team); the texts from `tools/seed/overrides.json` that reach the CSV too. Main phrases: "also in official list"
  → "También en la lista oficial"; "official list" → "Solo en la lista oficial (coordenadas oficiales)"; "OSM only" →
  "Solo en OSM"; "not in official list" → "No figura en la lista oficial — posible cierre"; "official list has no
  coordinates; matched by branch/street name" → "la lista oficial no trae coordenadas; emparejada por el nombre de la
  sede o de la calle"; "geocoded from the official address (Nominatim, street level: …)" → "Geocodificada a partir de la
  dirección oficial (Nominatim, a nivel de calle: …)"; "official list says district X" → "distrito según la lista
  oficial: X"; "same premises? check" → "¿mismo local? revisar". Only the `notes` cells changed (all 3,536 rows) plus
  one `address` that was generated in English (`web-mass-av-juan-velasco-alvarado`); ids, coordinates, statuses and
  precision are unchanged, and the verification queue below lists the same 112 rows. This report stays in English and
  quotes the notes as written. Two runs are byte-identical.
- **Logos.** New horizontal wordmarks `logos/wong-wide.png` (from the official Google Play icon) and
  `logos/metro-wide.png` (from the metro.pe logo SVG), so every chain except Holi has a wordmark card. Badges re-composed
  to read at 32–40 px: Plaza Vea (official white wordmark stacked "plaza / vea"; the app-icon swoosh is kept as
  `logos/plazavea-alt.png`), Tottus (white dot grid + TOTTUS on green, like the slides), Dollarcity ("Dollar / city"),
  Mass (letters only); all other badges enlarged to fill ~70% of the badge diameter. Contact sheet drawn exactly as the
  app draws markers: `tools/seed/logos-contact-final.png`. Sources: `logoSources` in each chain JSON.
- **`tools/seed/districts.geojson` is no longer committed** (34 MB, derived): run `node tools/build-districts.mjs`
  before `node tools/merge.mjs` on a fresh clone (`tools/seed/districts-README.md`).

### How to read the database

- **`verified`** = the store is in the chain's official list **and** has exact coordinates (OSM element or official
  coordinates). **`to_verify`** = one source only (OSM-only, press-only), a geocoded position, or an official record with a
  warning (configuration inactive / "may be closed", coordinates the source itself flags, possible duplicate, opening not
  confirmed). **`closed`** (kept, never drawn) = the OSM element at the site of Metro UNI, which Cencosud closed on 2024-08-27;
  2 Maxiahorro elements whose premises are now Dollarcity stores; and a second Tottus node in Ica (probable duplicate).
- **`approx` rows** (geocoded) sit on the street segment Nominatim returns for that street inside the stated district, **not
  on the door**: on a long avenue the error can be several hundred metres. Two stores on the same avenue can get the same
  point; those rows say so in `notes` ("mismo punto de calle geocodificado que …" / "posible duplicado de …").
  Treat them with care in radius / cannibalization analysis (the `precision` column tells them apart). Since the
  2026-10-01 verification, `approx` also marks **official coordinates that are doubtful**: the source itself flags them,
  two stores share them, or they fall > 5 km outside the stated district / in another department. For a radius analysis,
  treat `approx` **and** `to_verify` rows as uncertain.
- Stores whose official list has no coordinates were placed, in this order: (1) matched to an OSM element by branch or
  street name in the same district; (2) "only one in the area": the only unmatched official store of the chain in a
  district (province when the source gives no district) ↔ the only unmatched OSM store of the chain there (big formats
  only: Plaza Vea, Tottus, Wong, Metro, Vivanda, Precio Uno, Makro); (3) geocoded and matched to an OSM store nearby;
  (4) geocoded only. Every matched row says how in `notes`.
- A geocoding answer was accepted only if the result **names the street (or mall/station/neighbourhood) that was asked
  for** and lies in the official district (province + district, because district names repeat across provinces). When the
  source gives no district, only a house/POI-level hit or a street that exists in a single district of the province was
  accepted. This is why **"Holi Pardo — Av. José Pardo 200"** was not placed: Nominatim knows an "Avenida José Pardo" in
  Miraflores, Comas, Carabayllo and Villa María del Triunfo and the source does not say which.
- OSM-only rows of chains whose official list is complete say **"No figura en la lista oficial — posible cierre"**: they are candidates for
  closed stores or OSM mistakes (e.g. Metro Express on Av. Benavides, 2 Maxiahorro in Lima, 6 Mass). For chains
  whose official list is incomplete (Plaza Vea, Tottus, Vivanda, Dollarcity, Tambo, Oxxo) they say **"Solo en OSM"**: some are
  real stores missing from the list, others are stale OSM data. Their notes give the OSM last-edit date and the survey year
  when OSM has one. Several Plaza Vea rows are untouched OSM data from 2016–2017, including the old "Express" and "Super"
  formats, and two sit 35–50 m from current Mass stores. These are listed first in the **verification queue**. The Plaza
  Vea total (81 official + 23 OSM-only = 104 rows) is close to the ~105 Plaza Vea implied by InRetail's 113 supermarkets
  (Plaza Vea + Vivanda). That only shows the totals are similar; it does not confirm any single OSM-only row.
- The stores in **§4 Needs manual placement** are not in `stores.csv`. Where OSM has an unmatched store of the same
  chain in the right area, the last column names it: often that OSM row *is* the store (e.g. Tottus Trujillo 1 →
  `osm-n4453923987` on Av. Mansiche). Confirm and merge in the app. Where the official site links the store to Google
  Maps, the link is in the table; open it yourself, because the tools do not read Google Maps.
- `data/chains.js`: Makro's default legend name is **CASH & CARRY**, as on all four reference slides (the logo stage had
  "MAKRO"; it is editable per chain in the app).

### Comparison with the reference slides

Slide counts are my reading of the hand-made PNGs in `docs/reference/` (markers overlap, so counts marked ~ are approximate).
The slides' map frames also show parts of neighbouring districts, while the database columns count only the region's
districts (tables in §3). Mass, Tambo and Oxxo never appear on the slides (all three are default-off chains since 2026-10-01).

**Lima Metropolitana Sur** (Miraflores, San Borja, San Isidro, Surquillo)

| Chain | slide | database | comment |
|---|---:|---:|---|
| Plaza Vea | 7 | 7 | same count; DB includes Plaza Vea Dasso (official config inactive → to_verify) and 2 OSM-only (an unnamed one in San Borja, "Plaza Vea Express" in San Isidro: OSM data last edited 2017, tagged as a marketplace) |
| Tottus | 4 | 5 | DB: 5 official stores (Begonias, San Luis, Comandante Espinar, Miraflores/28 de Julio, Angamos). Until 2026-10-01 there were 6: Comandante Espinar was matched to a stale "Tottus" building (shop=carpet) 330 m from its address, and the real store showed up again as an OSM-only node |
| Wong | ~6 | 7 | Óvalo Gutiérrez, Benavides, Larcomar, Aurora, Bajada Balta, Ucello, Dos de Mayo |
| Metro | 3 | 4 | DB's 4th is "Metro Express" (Av. Benavides 620), OSM only, not in Cencosud's list → probably closed |
| Vivanda | 4 | 5 | all from Vivanda's old (inactive) store configuration; Pardo has no OSM confirmation |
| Tiendas 3A | 4 | 5 | 2 of the slide's 3A markers appear to sit near San Luis, outside the four districts |
| Dollarcity | 4 | 6 | |
| Flora y Fauna | 6 | 7 | |
| Holi | ~4–5 | 4 | Holi 28 de Julio = the OSM node on Av. La Paz 971, Miraflores (linked 2026-10-01); Holi Pardo and Holi Petit Thouars still need manual placement (probably Miraflores / Lince) |
| Vega | 0 | 4 | Vega Market stores (Benavides, Aviación, La Cultura, Villarán) are not on the slide |

**Lima Cono Sur** (Chorrillos, Lurín, Punta Hermosa, San Juan de Miraflores, Villa El Salvador, Villa María del Triunfo)

| Chain | slide | database | comment |
|---|---:|---:|---|
| Plaza Vea | ~6 | 9 | 5 in the official list + 4 OSM-only (2 Chorrillos, 1 Lurín, 1 VES); the Chorrillos one on Av. Alejandro Iglesias (2016 survey) is 50 m from a current Mass store |
| Tottus | ~5 | 6 | Punta Hermosa is geocoded (approx) |
| Wong | 1 | 1 | Wong KM40, Punta Hermosa (on the map, missing from the slide legend) |
| Metro | ~3 | 6 | 5 official + 1 OSM-only in Chorrillos |
| Makro (CASH & CARRY) | 2 | 3 | Chorrillos, San Juan de Miraflores, Villa El Salvador |
| Tiendas 3A | ~5 | 31 | the official 3A locator lists 31 stores in these districts |
| Dollarcity | ~4–5 | 10 | + "Blvd Puntamar": the official address says Punta Hermosa but its coordinates are in San Bartolo, 7 km away (to_verify). If it is in Punta Hermosa, the count is 11 |
| Vega | ~2 | 6 | 2 of them geocoded |
| Precio Uno | 2 | 2 | DB: Chorrillos (Guardia Civil) + Villa María del Triunfo (Mariátegui 2524). On 2026-10-01 the house-number check moved Mariátegui 10 km north, to San Gabriel Alto (approx). The slide also has a Precio Uno marker at the north edge, near Villa María del Triunfo. **Precio Uno Lurín** (on the slide) needs manual placement |
| Maxiahorro | legend only | 1 | "MaxiAhorro Chorrillos" is OSM-only and not in SMU's current list → probably closed |
| Holi, Flora y Fauna | legend only | 0 | none in these districts |

**Trujillo** (urban districts of Trujillo province)

| Chain | slide | database | comment |
|---|---:|---:|---|
| Plaza Vea | 5 | 5 | 2 official (Chacarero, Trujillo) + 3 OSM-only; the one on Av. España (2017 survey) is 35 m from a current Mass store |
| Tottus | 2 | 2 | Tottus Trujillo 2 geocoded (approx, Av. América Norte); the OSM-only node on Av. Mansiche is probably Tottus Trujillo 1 (manual placement list) |
| Wong | 2 | 3 | the 3rd is Wong El Golf (pickup point active, opening not confirmed → to_verify) |
| Metro | 3 | 3 | |
| Precio Uno | 2 | 2 | |
| Makro (CASH & CARRY) | 2 | 2 | La Esperanza (in Trujillo district) and El Bosque (Laredo) |
| Dollarcity | 0 | 6 | not on the slide |

**Chimbote** (Chimbote, Nuevo Chimbote)

| Chain | slide | database | comment |
|---|---:|---:|---|
| Plaza Vea | 1 | 3 | DB: Plaza Vea Chimbote, Plaza Vea Nuevo Chimbote, and an OSM-only "Plaza Vea Express" (OSM data from 2016-12, not edited since; probably gone) |
| Tottus | 1 | 1 | |
| Metro | 1 | 1 | Metro Pacífico, Nuevo Chimbote |
| Makro (CASH & CARRY) | 1 | 1 | |
| Dollarcity | 0 | 1 | not on the slide |

In short: for the big formats the database reproduces the slides (Trujillo and Chimbote almost exactly) and adds
stores the slides miss. The small formats differ most (3A, Dollarcity, Vega), where the official locators list many more
stores than the hand-made slides show.
