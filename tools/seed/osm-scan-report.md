# OSM nationwide scan — provisional report

Generated 2026-10-01T06:07:51.524Z by `tools/scan-osm.mjs`. OSM data as of **2026-10-01T05:51:36Z** (Overpass `timestamp_osm_base`).
Raw candidates inside Peru: **2426** unique elements (dedup by type+id) → `tools/seed/osm-raw.json`.

> Candidate list built with deliberately broad regexes. The buckets below are a *provisional* heuristic to help the
> merge stage design rules — not the final classification. Data © OpenStreetMap contributors (ODbL).

## 0. Key findings and suggested rules for the merge stage

_Hand-written after the 2026-10-01 run (OSM data as of 2026-10-01T05:51Z). `scan-osm.mjs` inserts this file here every time it
regenerates the report, so the numbers quoted below belong to that run. The generated tables further down are authoritative._

**What the scan found**

- 2,426 candidate elements inside Peru (another 249 border-tile candidates were outside Peru and dropped). No tile failed.
- About 740 chain hits look like real stores (strong + likely). That drops to about 715 once same-chain elements closer than 150 m are
  collapsed. About 2/3 of them are in Lima department (incl. Lima Metropolitana; Callao is counted separately).
- `brand:wikidata` is already set on many stores: Tambo+ 87, Plaza Vea 79, Metro 46, Oxxo 41, Tottus 40, Makro 23, Mass 9,
  Dollarcity 8. **No OSM element carries a QID for** Wong, Vivanda, Tiendas 3A, Precio Uno, Maxiahorro, Vega, Flora y Fauna or Holi,
  so those chains depend entirely on name rules.
- OSM coverage is clearly partial for the small formats (Tiendas 3A: 3 elements nationwide; Mass, Tambo and Oxxo are mapped
  mostly in Lima). The web store-locator stage has to fill these gaps; the OSM counts here are **not** chain store counts.
- Holi (6) and Flora y Fauna (5) are all in Lima and tagged `shop=supermarket` (one Holi `convenience`, one Flora y Fauna `health_food`). They look like natural/organic
  supermarkets, so match them by name.
- Precio Uno is mapped mostly as `shop=wholesale` ways (building footprints) named "Hiperbodega Precio Uno <place>".
  Maxiahorro is mapped as named nodes "MaxiAhorro <place>".

**Suggested inclusion rule.** Run it on accent-folded, lower-cased `name` (fall back to `brand`).

1. Accept when `brand:wikidata` equals the chain QID and the element is not a non-store feature. No non-store element with a chain
   QID was observed.
2. Otherwise accept when the name matches the chain's *anchored* pattern (`STRICT_JS` in `scan-osm.mjs`) **and**
   `shop` ∈ {supermarket, convenience, general, wholesale, variety_store, department_store, mall, yes, …}. Some chains also accept
   extra shop types: Dollarcity variety/gift/household; Flora y Fauna pet/garden/health_food.
   A `building|landuse=retail|commercial` polygon with the chain name is the same store as a nearby node; use it only when no node exists.
3. Keep "unusual shop type" matches as `to_verify` or drop them. Examples: Tottus `shop=carpet`/`deli`, Wong `shop=laundry`,
   Vega `jewelry`/`sports`/`tailor`, Tambo `seafood`/`alcohol`/`car`, "Tambo del Inca" (`shop=supermarket`, Lima).

**Exclusions observed (never stores)**

- **Tambo**: 514 `amenity=social_facility` "Tambo …" belong to the government *Programa Nacional PAIS*
  (`operator=Programa Nacional Plataformas de Acción para la Inclusión Social`), so exclude by tag or operator. Also exclude
  `place=*` (Tambo, Tambogrande, Tambo de Mora…), restaurants and hotels "El Tambo", markets "Mercado Tambo …", bridges and
  tolls ("Puente Tambo", "Peaje Tambo Grande"), and `building=yes|public` "Tambo <village>" (also PAIS). Real stores are
  `^tambo\s*(\+|plus)?$` with `shop=convenience`.
- **Metro**: `railway=subway|construction|proposed` (Metro de Lima lines 1/2/4), `public_transport=*`, `amenity=bus_station`
  ("Metropolitano" BRT), "Caja Metropolitana" banks, clinics/schools/"Parque Metropolitano", "Mercado Metro"
  (marketplace, not the chain), "Galería Textil El Metro", opticians "Metro Visión", "El Metro" fuel station. The anchored
  pattern also rejects "Metro de Lima", "Metro Línea …" and "Metro 2".
- **Wong**: restaurants ("Chifa Wong…", "Susy Wong"), "Instituto/Clínica Oftalmológica Wong", "David Wong" (beauty), "D' Wong"
  (convenience in Ica). Malls with `operator=Grupo/Corporación Wong` and a Vivanda with `operator=Wong` are not Wong stores.
- **Vega**: 76 schools "Inca Garcilaso de la Vega", hamlets ("Bella Vega"…), personal names on shops ("Bodega Vega",
  "Bernardo Vega …", "Dulcería Vega", "Embragues Vega", "Peluquería de la Vega"…). Chain names seen: `Vega`, `Vega Market`,
  `Vega Supermayorista`, `Vega mayorista` (one has `brand=Vega`). "Corporación Vega" (`shop=supermarket`, Lima) → `to_verify`.
- **Tiendas 3A**: "3A" is common in block, lot and sector names (`place=city_block`, "Sector 9 Grupo 3A", "Mz … 3A-11"). Accept
  `^(tiendas? ?)?(3|tres) ?a\b` only with `shop=convenience`. `operator=Grupo AJE / Ajegroup` confirms it ("3A",
  "Tiendas 3A", "3A Hard Discount"). Reject "3A Salón & Estética", "3A Amseq" and "Aceros 3A".
- **Mass**: massage parlours, "Massimo/Massima/Massiel/Masstel/Massfarma/Massalud", "Copy Mass", "Lava Mass". The anchored
  `^(tiendas?|mini ?market|supermarket|supermercado)? ?mass\b` keeps "Tienda Mass", "Minimarket Mass" and "Supermercado MASS".
  "Mass Chicken Shop" (`shop=yes`, Junín) is probably not a Mass store → check.
- **Makro**: parking lots "Makro", "CrediScotia Makro Callao" (bank), "Fiesta Makro" (`shop=yes`, unrelated). "Makro - Promart"
  (`building=commercial`) sits next to a Makro node → dedupe.
- **All chains**: `amenity=parking` ("Estacionamiento Plaza Vea", "Deck Plaza Vea"…), banks/ATMs/money markets inside stores
  ("Interbank - PlazaVea Corpac", "Money Market Vivanda…"), taxi stands ("Paradero Tottus"), footbridges ("Puente Peatonal
  Tottus"), distribution centres (`landuse=industrial`, `office=logistics`), schools "Totus Tuus". Matches that come only from
  operator/parent company (Cencosud, InRetail, Supermercados Peruanos on malls, París stores, offices) are not stores.

**Deduplication.** Collapse a node plus building/landuse/mall polygons and "entrada 1/2" nodes into one store. For
super/hiper/wholesale formats a radius of ~150 m works; prefer the element with `shop=*` and `brand:wikidata`, and prefer a node.
For convenience and discount formats (Tambo, Oxxo, Mass, Tiendas 3A), real stores can be less than 150 m apart in Lima. Use about
40 m there, or require an identical name.

**Other notes**

- The scan's department comes from Overpass admin areas. One candidate ("Tambo Uros Titino" on Lake Titicaca) sits in Peru but in
  no department polygon. Use district point-in-polygon in the merge stage.
- The same element can match two chains through `operator` (e.g. "Tiendas Mass" with `operator=Plaza Vea`). Classify by name or
  brand, not by operator.

## 1. How the scan ran

| Endpoint | preflight | ok queries | failed attempts | last error |
|---|---|---|---|---|
| https://overpass-api.de/api/interpreter | OK (1493 ms) | 46 | 13 | HTTP 429 |
| https://maps.mail.ru/osm/tools/overpass/api/interpreter | OK (3696 ms) | 27 | 0 |  |
| https://overpass.private.coffee/api/interpreter | FAIL | 0 | 0 | client timeout after 25 s |
| https://overpass.kumi.systems/api/interpreter | FAIL | 0 | 0 | client timeout after 25 s |

- Tiling: bbox grid of 2° cells over the departments' bounding boxes, 0.5° cells over Lima Metropolitana + Callao (-12.56,-77.26,-11.56,-76.62); tiles that time out are split in 4 (max depth 3).
- Each tile: candidates by bbox, then filtered server-side by the Perú area (rel 288247) and attributed to a department area (admin_level=4 relations).
- Tiles run: 72; split tiles: 0; **failed tiles: 0**.
- Candidates dropped because they are outside Peru (border tiles): 249. Elements without coordinates: 0.
- Departments without an Overpass area: none. Candidates in Peru but in no department area: 1.
- Keys matched: `name`, `name:es`, `brand`, `brand:es`, `operator`, `old_name`, `alt_name`, `official_name`, `short_name` with the broad regex (case-insensitive), plus `brand:wikidata` / `operator:wikidata` ∈ known QIDs.
- In-query exclusions (never stores): `[!"highway"][!"waterway"][!"boundary"]["type"!~"^(route|route_master|boundary|waterway|network|multilinestring)$"]`.

Broad regex (Overpass POSIX ERE, `,i`):

```
plaza[ ._-]*vea|tott?us|(^|[- _.,;:/(&+#|])wong([^a-z]|$)|(^|[- _.,;:/(&+#|])metro|vivanda|tiendas?[ ._-]*(3|tres)[ ._-]*a([^a-z]|$)|(^|[- _.,;:/(&+#|])3[ -]?a([^a-z0-9]|$)|(^|[- _.,;:/(&+#|])mass|precio[ ._-]*(uno|1)([^0-9a-z]|$)|hiper[ -]*bodega|maxi[ ._-]*ahorro|dol+ar[ ._-]*city|makro|ma[ck]ro[ ._-]*(super)?[ ._-]*mayorista|(^|[- _.,;:/(&+#|])vega([^a-z]|$)|flora[ ._&y-]*fauna|(^|[- _.,;:/(&+#|])holi([^a-z]|$)|(^|[- _.,;:/(&+#|])tambo([^a-z]|$)|tambo[ ]*([+]|plus)|oxxo|supermercados[ ]+peruanos|cencosud|inretail|hipermercados[ ]+tottus|corporaci.n[ ]+vega
```

Wikidata QIDs: plazavea Q7203672 · tottus Q7828510 · wong Q28604866 · metro Q16640217 · vivanda Q7937539 · tiendas3a Q136373411 · mass Q104814825 · preciouno Q109657737 · maxiahorro Q136408748 · dollarcity Q107120814 · makro Q704606 · vega Q139603395 · florayfauna — · holi — · tambo Q64516439 · oxxo Q1342538. No QID found for Flora y Fauna or Holi.

## 2. Provisional classification per chain

Buckets: **strong** = `brand:wikidata` is the chain QID or the `brand` tag matches the chain · **likely** = name matches the
chain's strict pattern and the element has a retail tag (shop=*, amenity=marketplace, building/landuse=retail|commercial) ·
**ambiguous** = needs a rule/human decision · **noise** = broad match on an obviously non-store feature (station, school,
place, hotel, restaurant, clinic…). One element can hit several chains.

| Chain | strong | likely | strong+likely | ambiguous | noise | total hits | node / way / rel (strong+likely) |
|---|---:|---:|---:|---:|---:|---:|---|
| Plaza Vea (`plazavea`) | 79 | 22 | **101** | 5 | 13 | 119 | 41 / 60 / 0 |
| Tottus (`tottus`) | 40 | 19 | **59** | 2 | 10 | 71 | 35 / 24 / 0 |
| Wong (`wong`) | 1 | 19 | **20** | 6 | 18 | 44 | 7 / 12 / 1 |
| Metro (`metro`) | 46 | 29 | **75** | 15 | 519 | 609 | 23 / 52 / 0 |
| Vivanda (`vivanda`) | 0 | 6 | **6** | 0 | 3 | 9 | 2 / 4 / 0 |
| Tiendas 3A (`tiendas3a`) | 0 | 3 | **3** | 4 | 23 | 30 | 2 / 1 / 0 |
| Mass (`mass`) | 14 | 148 | **162** | 11 | 10 | 183 | 125 / 37 / 0 |
| Hiperbodega Precio Uno (`preciouno`) | 0 | 23 | **23** | 0 | 0 | 23 | 1 / 22 / 0 |
| Maxiahorro (`maxiahorro`) | 0 | 24 | **24** | 0 | 0 | 24 | 23 / 1 / 0 |
| Dollarcity (`dollarcity`) | 8 | 3 | **11** | 0 | 1 | 12 | 9 / 2 / 0 |
| Makro (`makro`) | 23 | 2 | **25** | 2 | 3 | 30 | 2 / 22 / 1 |
| Vega (`vega`) | 1 | 7 | **8** | 15 | 166 | 189 | 3 / 5 / 0 |
| Flora y Fauna (`florayfauna`) | 0 | 5 | **5** | 0 | 0 | 5 | 5 / 0 / 0 |
| Holi (`holi`) | 0 | 6 | **6** | 0 | 0 | 6 | 5 / 1 / 0 |
| Tambo / Tambo+ (`tambo`) | 89 | 74 | **163** | 22 | 827 | 1012 | 136 / 27 / 0 |
| Oxxo (`oxxo`) | 43 | 5 | **48** | 0 | 2 | 50 | 42 / 6 / 0 |
| **Total hits** | 344 | 395 | **739** | 82 | 1595 | 2416 | |

Elements with strong/likely hits for **more than one chain**: 0. Candidates with no chain hit (caught only by the parent-company/operator net or regex dialect differences): 12.

Note: OSM often maps the same store twice (a node for the shop + a building/landuse way, or a mall polygon with the brand name). The merge stage should collapse near-duplicates of the same chain (e.g. within ~150 m, preferring the node with `shop=*`).

### Strong+likely per department

| Department | plazavea | tottus | wong | metro | vivanda | tiendas3a | mass | preciouno | maxiahorro | dollarcity | makro | vega | florayfauna | holi | tambo | oxxo | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Ancash | 3 | 1 | · | 1 | · | · | 4 | · | · | · | · | · | · | · | 3 | · | 12 |
| Arequipa | 1 | 3 | · | 5 | · | · | 7 | · | · | 1 | 2 | · | · | · | 1 | 1 | 21 |
| Cajamarca | 1 | 1 | · | 2 | · | · | · | · | · | · | · | · | · | · | · | · | 4 |
| Callao | 5 | 5 | · | 4 | · | · | 8 | 1 | · | 1 | 1 | · | · | · | 3 | 2 | 30 |
| Cusco | 2 | 2 | · | · | · | · | 12 | · | · | · | 2 | · | · | · | 4 | · | 22 |
| Huánuco | 1 | 1 | · | 1 | · | · | · | · | · | · | · | · | · | · | · | · | 3 |
| Ica | 3 | 3 | · | 4 | · | · | 4 | 4 | 2 | · | 2 | · | · | · | · | · | 22 |
| Junín | 3 | 1 | · | 1 | · | · | 4 | · | · | · | 1 | · | · | · | · | · | 10 |
| La Libertad | 5 | 3 | 2 | 3 | · | · | 16 | 2 | · | · | 2 | 1 | · | · | 6 | · | 40 |
| Lambayeque | · | 3 | · | 6 | · | · | 3 | 3 | · | 1 | 1 | · | · | · | 1 | · | 18 |
| Lima | 63 | 32 | 18 | 45 | 6 | 3 | 88 | 6 | 9 | 5 | 11 | 7 | 5 | 6 | 142 | 45 | 491 |
| Loreto | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | · | 1 |
| Moquegua | 2 | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 2 |
| Piura | 5 | 3 | · | 2 | · | · | 16 | 3 | 13 | 3 | 3 | · | · | · | 3 | · | 51 |
| Puno | 2 | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 2 |
| San Martín | 1 | · | · | · | · | · | · | 2 | · | · | · | · | · | · | · | · | 3 |
| Tacna | 1 | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 1 |
| Tumbes | 2 | · | · | 1 | · | · | · | · | · | · | · | · | · | · | · | · | 3 |
| Ucayali | 1 | 1 | · | · | · | · | · | 1 | · | · | · | · | · | · | · | · | 3 |
| **Total** | **101** | **59** | **20** | **75** | **6** | **3** | **162** | **23** | **24** | **11** | **25** | **8** | **5** | **6** | **163** | **48** | **739** |

_Department = Overpass department area containing the element (provisional; the merge stage should use district point-in-polygon)._

### Tag profile of strong+likely matches

| Chain | main tag (count) |
|---|---|
| plazavea | shop=supermarket (97), shop=mall (2), amenity=marketplace (1), landuse=retail (1) |
| tottus | shop=supermarket (56), shop=yes (2), shop=mall (1) |
| wong | shop=supermarket (20) |
| metro | shop=supermarket (72), (no main tag) (1), landuse=commercial (1), shop=department_store (1) |
| vivanda | shop=supermarket (6) |
| tiendas3a | shop=convenience (3) |
| mass | shop=supermarket (78), shop=convenience (71), shop=yes (12), shop=general (1) |
| preciouno | shop=wholesale (15), shop=supermarket (8) |
| maxiahorro | shop=supermarket (23), shop=convenience (1) |
| dollarcity | shop=variety_store (9), shop=supermarket (2) |
| makro | shop=wholesale (24), building=commercial (1) |
| vega | shop=supermarket (3), shop=yes (2), shop=convenience (2), shop=wholesale (1) |
| florayfauna | shop=supermarket (4), shop=health_food (1) |
| holi | shop=supermarket (5), shop=convenience (1) |
| tambo | shop=convenience (146), shop=supermarket (7), shop=yes (6), shop=variety_store (2), building=commercial (1), shop=general (1) |
| oxxo | shop=convenience (47), shop=supermarket (1) |

### Name variants among strong+likely (top 15 per chain)

- **plazavea** (9 distinct): `Plaza Vea` ×91, `Plaza Vea Hiper` ×2, `Plaza Vea Express` ×2, `PlazaVea Chaclacayo` ×1, `Plaza Vea entrada 1 Valle Hermoso` ×1, `PlazaVea entrada 2 Valle Hermoso` ×1, `Plaza Vea - Hipermercado` ×1, `Plaza Vea Super` ×1, `PLAZA VEA HIPER` ×1
- **tottus** (8 distinct): `Tottus` ×51, `Tottus Express` ×2, `Tottus Mall Aventura Plaza` ×1, `Tottus Atocongo` ×1, `TOTTUS` ×1, `Tottus Pachacutec` ×1, `Tottus Chorrillos` ×1, `Tottus Veintiséis de Octubre` ×1
- **wong** (5 distinct): `Wong` ×16, `Wong Benavides` ×1, `WONG` ×1, `Wong Marsano` ×1, `Wong Óvalo Gutierrez` ×1
- **metro** (13 distinct): `Metro` ×62, `(no name; brand=Metro)` ×2, `Metro Express` ×1, `Metro Costa Mar Plaza` ×1, `Hipermercados Metro` ×1, `Metro Pedro Miota` ×1, `Metro Minka` ×1, `Supermercado Metro San Eduardo` ×1, `Metro Atocongo` ×1, `Metro Chaclacayo` ×1, `Metro Nuevo Chimbote` ×1, `Metro Cencosud` ×1, `Metro Balta` ×1
- **vivanda** (2 distinct): `Vivanda` ×5, `Vivanda Pezet` ×1
- **tiendas3a** (3 distinct): `Tiendas 3A` ×1, `3A` ×1, `3A Hard Discount` ×1
- **mass** (19 distinct): `Mass` ×102, `Tienda Mass` ×32, `mass` ×6, `Tiendas Mass` ×6, `MASS` ×2, `Mass Chicken Shop` ×1, `Supermarket Mass` ×1, `Mini Market Mass` ×1, `Mass Ahorro` ×1, `Tiendas MASS` ×1, `Supermercado MASS` ×1, `TIENDA MASS` ×1, `Mass Extra` ×1, `Tienda MASS` ×1, `Minimarket Mass` ×1, …
- **preciouno** (20 distinct): `Precio Uno` ×3, `Hiperbodega Precio Uno` ×2, `Precio uno` ×1, `Hiperbodega Precio Uno Zapallal` ×1, `Hiperbodega Precio Uno Chorrillos` ×1, `Hiperbodega Precio Uno Chincha` ×1, `Hiperbodega Precio Uno Huaycán` ×1, `Hiperbodega Precio Uno Pisco` ×1, `Hiperbodega Precio Uno Leguía` ×1, `Hiperbodega Precio Uno Belaúnde y Lora` ×1, `Hiperbodega Precio Uno Barrios Altos` ×1, `Hiperbodega Precio Uno Dueñas` ×1, `Hiperbodega Precio Uno Trujillo` ×1, `Hiperbodega Precio Uno Trujillo Unión` ×1, `Hiperbodega Precio Uno Chulucanas` ×1, …
- **maxiahorro** (20 distinct): `Maxi Ahorro` ×4, `MaxiAhorro` ×2, `MaxiAhorro Pisco` ×1, `MaxiAhorro Ica` ×1, `MaxiAhorro Manco Cápac` ×1, `MaxiAhorro Chorrillos` ×1, `MaxiAhorro Lince` ×1, `MaxiAhorro Rímac` ×1, `MaxiAhorro Barranca` ×1, `MaxiAhorro Canto Grande` ×1, `MaxiAhorro México` ×1, `MaxiAhorro Gran Caquetá` ×1, `Maxi Ahorro Huacho` ×1, `MaxiAhorro Sullana` ×1, `Maxiahorro Santa Isabel` ×1, …
- **dollarcity** (2 distinct): `Dollarcity` ×10, `Dollar City` ×1
- **makro** (9 distinct): `Makro` ×17, `Makro Callao` ×1, `Makro Arequipa` ×1, `Makro Villa El Salvador` ×1, `Makro Trujillo` ×1, `Makro Chiclayo` ×1, `Makro Chincha` ×1, `Makro Huaylas` ×1, `Makro - Promart` ×1
- **vega** (4 distinct): `Vega Market` ×3, `Vega` ×2, `Vega Supermayorista` ×2, `Vega mayorista` ×1
- **florayfauna** (3 distinct): `Flora & Fauna` ×3, `Flora y Fauna` ×1, `Flora Y Fauna` ×1
- **holi** (2 distinct): `Holi Supermercado` ×4, `Holi` ×2
- **tambo** (6 distinct): `Tambo+` ×96, `Tambo` ×62, `TAMBO` ×2, `Tambo +` ×1, `Tambo Bocanegra` ×1, `Tambo del Inca` ×1
- **oxxo** (1 distinct): `Oxxo` ×48

### Probable duplicates (same chain, strong+likely, closer than 150 m)

Clusters are built by single-linkage at 150 m. "Elements" counts every OSM element in a multi-element cluster.

| Chain | strong+likely | clusters with >1 element | elements in those clusters | after collapsing clusters |
|---|---:|---:|---:|---:|
| plazavea | 101 | 5 | 10 | 96 |
| tottus | 59 | 3 | 6 | 56 |
| wong | 20 | 0 | 0 | 20 |
| metro | 75 | 5 | 10 | 70 |
| vivanda | 6 | 0 | 0 | 6 |
| tiendas3a | 3 | 0 | 0 | 3 |
| mass | 162 | 5 | 10 | 157 |
| preciouno | 23 | 0 | 0 | 23 |
| maxiahorro | 24 | 0 | 0 | 24 |
| dollarcity | 11 | 0 | 0 | 11 |
| makro | 25 | 1 | 2 | 24 |
| vega | 8 | 0 | 0 | 8 |
| florayfauna | 5 | 0 | 0 | 5 |
| holi | 6 | 0 | 0 | 6 |
| tambo | 163 | 3 | 6 | 160 |
| oxxo | 48 | 3 | 6 | 45 |

Examples (max 3 per chain):

- plazavea: n2799370511 (shop=supermarket, "Plaza Vea") + n5009957729 (shop=supermarket, "Plaza Vea")
- plazavea: n3141079282 (shop=supermarket, "Plaza Vea") + w515971489 (shop=supermarket, "Plaza Vea")
- plazavea: n6238862185 (shop=supermarket, "Plaza Vea entrada 1 Valle Hermoso") + n6238862186 (shop=supermarket, "PlazaVea entrada 2 Valle Hermoso")
- tottus: w565493831 (shop=supermarket, "Tottus") + n1800680808 (shop=supermarket, "Tottus Atocongo")
- tottus: w520351220 (shop=supermarket, "Tottus") + n5084742171 (shop=yes, "Tottus Express")
- tottus: n5177359491 (shop=supermarket, "Tottus") + w589457239 (shop=mall, "Tottus")
- metro: n2922798818 (shop=supermarket, "Metro") + w762890836 (shop=supermarket, "Metro")
- metro: w439241362 (shop=supermarket) + w67657500 (landuse=commercial, "Hipermercados Metro")
- metro: n4872622409 (shop=supermarket, "Metro") + w289666131 (shop=supermarket, "Metro")
- mass: n10093764112 (shop=convenience, "Mass") + n10105048597 (shop=convenience, "Mass")
- mass: n12852193883 (shop=convenience, "Mass") + n12852193885 (shop=convenience, "Mass")
- mass: n13122786201 (shop=supermarket, "Tienda Mass") + n13122840401 (shop=supermarket, "Mass")
- makro: n5952081293 (shop=wholesale, "Makro") + w463807555 (building=commercial, "Makro - Promart")
- tambo: n4368728206 (shop=convenience, "Tambo+") + n13427763783 (shop=convenience, "Tambo+")
- tambo: n13574534485 (shop=convenience, "Tambo+") + n13574534494 (shop=convenience, "Tambo+")
- tambo: n4374900351 (shop=convenience, "Tambo") + w439789550 (building=commercial, "Tambo")
- oxxo: n11998302741 (shop=convenience, "Oxxo") + n11998302743 (shop=convenience, "Oxxo")
- oxxo: n13544521334 (shop=convenience, "Oxxo") + n13544521337 (shop=convenience, "Oxxo")
- oxxo: n14127660895 (shop=convenience, "Oxxo") + n7373912685 (shop=supermarket, "Oxxo")

## 3. Ambiguous / suspicious matches (input for exclusion rules)

Per chain: ambiguous candidates grouped by reason (capped at 80 rows per group), then noise summarised by category with examples.

### Plaza Vea (`plazavea`) — ambiguous 5, noise 13

**broad regex match only (name does not start like the chain)** (3):

- Almacenes Plaza Vea — (no main tag) · Lima · [w562790856](https://www.openstreetmap.org/way/562790856)
- Real Plaza Guardia Civil — shop=mall · Lima · [w419812664](https://www.openstreetmap.org/way/419812664)
- Tiendas Mass — shop=convenience · operator=Plaza Vea · Lima · [n13125700954](https://www.openstreetmap.org/node/13125700954)

**name matches chain pattern, but no retail tag** (2):

- Plaza Vea — building=yes · Lima · [w401854652](https://www.openstreetmap.org/way/401854652)
- Plaza Vea Caminos del Inca — building=yes · Lima · [w401854653](https://www.openstreetmap.org/way/401854653)

Noise by category: amenity=parking ×6 (e.g. "Plaza Vea", "Deck Plaza Vea", "") · landuse=industrial ×2 (e.g. "Centro de Distribucion Plaza Vea", "Centro de Distribución Supermercados Peruanos") · amenity=bank ×1 (e.g. "Interbank - PlazaVea Corpac") · office=logistics ×1 (e.g. "Centro de Distribución Plaza Vea") · amenity=community_centre ×1 (e.g. "Plaza Vea") · amenity=taxi ×1 (e.g. "Paradero - Plaza Vea") · amenity=food_court ×1 (e.g. "Deli Vea")

### Tottus (`tottus`) — ambiguous 2, noise 10

**name matches chain pattern, but unusual shop type** (2):

- Tottus — shop=carpet · Lima · [w435690073](https://www.openstreetmap.org/way/435690073)
- Tottus al Paso — shop=deli · operator=Tottus · Lima · [n5862296376](https://www.openstreetmap.org/node/5862296376)

Noise by category: amenity=parking ×2 (e.g. "") · amenity=taxi ×2 (e.g. "Paradero Tottus", "Paradero de Tottus") · man_made=bridge ×2 (e.g. "Puente Peatonal Tottus") · amenity=school ×1 (e.g. "Institución Educativa Totus Tuus") · amenity=kindergarten ×1 (e.g. "Institución educativa inicial Totus Tuus") · landuse=industrial ×1 (e.g. "Centro de Distribución Tottus Huachipa") · office=yes ×1 (e.g. "Oficinas Falabella")

### Wong (`wong`) — ambiguous 6, noise 18

**name matches chain pattern, but unusual shop type** (1):

- Wong Express — shop=laundry · Lima · [n5010440540](https://www.openstreetmap.org/node/5010440540)

**broad regex match only (name does not start like the chain)** (5):

- D' Wong — shop=convenience · Ica · [n5029243459](https://www.openstreetmap.org/node/5029243459)
- David Wong — shop=beauty · La Libertad · [n5072446519](https://www.openstreetmap.org/node/5072446519)
- Mall del Sur — shop=mall · operator=Grupo Wong · Lima · [w834758085](https://www.openstreetmap.org/way/834758085)
- Plaza Norte — shop=mall · operator=Corporación Wong · Lima · [r3550274](https://www.openstreetmap.org/relation/3550274)
- Vivanda — shop=supermarket · operator=Wong · Lima · [w289710415](https://www.openstreetmap.org/way/289710415)

Noise by category: amenity=restaurant ×8 (e.g. "Chifa Wong Polleria", "Susy Wong", "Chifa Wong Kog") · amenity=parking ×4 (e.g. "Parqueo Clientes Wong", "", "Wong") · amenity=clinic ×2 (e.g. "Clinica Ofmatologica Wong", "Instituto Oftalmologico Wong") · amenity=atm ×1 (e.g. "Wong") · amenity=school ×1 (e.g. "Institución Educativa Dr. Cesar Augusto Wong Lopez") · tourism=hotel ×1 (e.g. "Wong") · amenity=doctors ×1 (e.g. "Ortopedia Wong")

### Metro (`metro`) — ambiguous 15, noise 519

**broad regex match only (name does not start like the chain)** (13):

- Boletos de Metropolitano — shop=ticket · Callao · [n6139628946](https://www.openstreetmap.org/node/6139628946)
- Construcción de Metro 2 de Lima — (no main tag) · Lima · [n4341418155](https://www.openstreetmap.org/node/4341418155)
- Edificio Metropolis — building=office · Lima · [w1487033611](https://www.openstreetmap.org/way/1487033611)
- El Metro — amenity=fuel · operator=Petroperú · Loreto · [n3748605776](https://www.openstreetmap.org/node/3748605776)
- Galería Textil El Metro — building=commercial · La Libertad · [w524110449](https://www.openstreetmap.org/way/524110449)
- Instituto Metropolitano de Planificación - IMP — building=yes · Lima · [n6368174630](https://www.openstreetmap.org/node/6368174630)
- Mercado El Metro ASCOME — building=construction · Lima · [w443904965](https://www.openstreetmap.org/way/443904965)
- Mercado Metro — amenity=marketplace · Lima · [w513177362](https://www.openstreetmap.org/way/513177362)
- Mercado metropolitano de productores mayoristas Andrés Avenlino Cáceres — amenity=marketplace · Arequipa · [n4019936575](https://www.openstreetmap.org/node/4019936575)
- Metromedicion E.I.R.L. — shop=electronics · Piura · [n5835953985](https://www.openstreetmap.org/node/5835953985)
- Optica Metro Vision — shop=optician · Lima · [n4353166252](https://www.openstreetmap.org/node/4353166252)
- Ópticas Metropolitana — shop=optician · Lima · [n4343685160](https://www.openstreetmap.org/node/4343685160)
- Parque Metropolitano — (no main tag) · Lima · [w1303530908](https://www.openstreetmap.org/way/1303530908)

**name matches chain pattern, but no retail tag** (2):

- Metro — (no main tag) · Lima · [r8609258](https://www.openstreetmap.org/relation/8609258)
- Metro — building=yes · Lima · [w402154792](https://www.openstreetmap.org/way/402154792)

Noise by category: railway=subway ×255 (e.g. "Metro de Lima", "Línea 1 del Metro de Lima", "") · public_transport=stop_area ×39 (e.g. "Estación Tacna hacia el Sur", "Estación Tacna hacia el Norte", "Estacion Ramón Castilla") · amenity=bus_station ×28 (e.g. "Estación Quilca", "Estación 2 de Mayo", "Ramón Castilla") · amenity=hospital ×28 (e.g. "Centro de Asistencia CAP III Metropolitano", "SISOL Salud Centro Médico Trabajadores Hospital del Niño", "SISOL Salud Carabayllo") · public_transport=stop_position ×23 (e.g. "Embarque 2 Norte", "Embarque Norte 1", "Embarque Norte 3") · leisure=park ×17 (e.g. "Parque Metropolitano Ecológico", "Club Metropolitano Wiracocha", "Parque de los Museos") · amenity=bank ×16 (e.g. "Caja Metropolitana", "Banco Metropolitano de Lima", "BCP") · railway=construction ×15 (e.g. "Línea 2 del Metro de Lima", "Metro de Lima Línea 2", "Metro de Lima Línea 4") · amenity=doctors ×13 (e.g. "SISOL Salud Centro Médico Juan Pablo II", "SISOL Salud Centro Médico Señor de los Milagros", "SISOL Salud Centro Médico José Carlos Mariátegui") · amenity=clinic ×11 (e.g. "SISOL Salud Centro Quirúrgico", "Metropolitano", "Sistema Metropolitano de la Solidaridad / Solidaridad Salud "LAS Violetas"") · amenity=parking ×8 (e.g. "Aparcamiento Metro", "Estacionamiento Metro", "Playa Metro") · office=government ×6 (e.g. "Instituto Metropolitano de Planificación", "Dirección Regional de Educación de Lima Metropitana", "Protransporte") · tourism=attraction ×5 (e.g. "Entrada Parque Metropolitano Paul Poblet Lind", "Pabellón Bizantino", "Pabellón Morisco") · amenity=school ×4 (e.g. "CEBA Ceba - Metropolitano", "Institución Educativa Metropolitano", "Metropolitano") · public_transport=platform ×4 (e.g. "") · office=company ×3 (e.g. "Caja Metropolitana", "Consorcio constructor de la línea 2 del metro de Lima y Callao") · landuse=construction ×3 (e.g. "Estación Insurgentes Metro 2 de Lima y Callao", "Estación Central L2 Metro", "Construcción Línea 2 Metro de Lima") · railway=proposed ×3 (e.g. "Metro de Lima Línea 3", "Metro de Lima Línea 4") · amenity=cinema ×2 (e.g. "Cinestar Metro San Juan", "Cine Star") · amenity=driving_school ×2 (e.g. "Metropolis Car") · office=yes ×2 (e.g. "Caja Metropolitana", "Dirección Regional De Educación De Lima Metropolitana") · office=financial ×2 (e.g. "Caja Metropolitana") · tourism=museum ×2 (e.g. "Museo Metropolitano de Lima", "Museo de Sitio Cementerio Presbítero Matías Maestro") · landuse=cemetery ×2 (e.g. "Cementerio Metropolitano", "Cementerio San Miguel Arcángel") · amenity=police ×2 (e.g. "Serenazgo Metropolitano Sin Fronteras", "Puesto de Auxilio Rápido Metropolitano PARMET") · amenity=college ×2 (e.g. "Metropolitano", "Escuela Metropolitana de Formación de Emprendedores- Sede Paraíso") · amenity=fast_food ×1 (e.g. "Ricón de Metro") · amenity=theatre ×1 (e.g. "Palacio Metropolitano de Bellas Artes Mario Vargas Llosa") · amenity=toilets ×1 (e.g. "") · office=medical ×1 (e.g. "Laboratorio Clínico Metropolitano") · place=hamlet ×1 (e.g. "Nueva Metropoli") · tourism=hostel ×1 (e.g. "Hospedaje Metro") · amenity=vending_machine ×1 (e.g. "") · tourism=information ×1 (e.g. "") · amenity=restaurant ×1 (e.g. "Metropolitan") · tourism=apartment ×1 (e.g. "Monterrico Polo Aparts") · amenity=bicycle_parking ×1 (e.g. "") · amenity=townhall ×1 (e.g. "Palacio Municipal de Lima") · landuse=farmland ×1 (e.g. "Parque Metropolitano Lambramani") · tourism=theme_park ×1 (e.g. "Parque de la Reserva") · landuse=residential ×1 (e.g. "Área Metropolitana de Pucallpa") · amenity=social_facility ×1 (e.g. "Puericultorio Pérez Anaribar") · aeroway=aerodrome ×1 (e.g. "Aeródromo Lib Mandi Metropolitano") · amenity=arts_centre ×1 (e.g. "Palacio Mario Vargas Llosa") · landuse=landfill ×1 (e.g. "Relleno sanitario, Arequipa Metropolitana") · office=financial_services ×1 (e.g. "Caja Metropolitana") · landuse=railway ×1 (e.g. "Patio Taller Bocanegra Línea 4 del Metro de Lima y Callao") · landuse=recreation_ground ×1 (e.g. "Club Metropolitano Pascuala Rosado Cornejo")

### Vivanda (`vivanda`) — ambiguous 0, noise 3

Noise by category: amenity=bank ×2 (e.g. "Money Market Vivanda Libertadores", "Interbank MM Vivanda Benavides") · amenity=parking ×1 (e.g. "Estacionamiento Vivanda")

### Tiendas 3A (`tiendas3a`) — ambiguous 4, noise 23

**name matches chain pattern, but unusual shop type** (2):

- 3A Amseq — shop=trade · Ancash · [w519405329](https://www.openstreetmap.org/way/519405329)
- 3A Salón & Estética — shop=beauty · Lima · [n4347902811](https://www.openstreetmap.org/node/4347902811)

**broad regex match only (name does not start like the chain)** (1):

- Aida Mota 3A-11 solidex Alto — shop=convenience · Ancash · [n13998020312](https://www.openstreetmap.org/node/13998020312)

**name matches chain pattern, but no retail tag** (1):

- 3A — (no main tag) · Callao · [w582953927](https://www.openstreetmap.org/way/582953927)

Noise by category: place=city_block ×11 (e.g. "3A", "3A'") · place=neighbourhood ×6 (e.g. "Sector 9 Grupo 3A", "Sector 6 Grupo 3A", "Sector 7 Grupo 3A") · leisure=park ×2 (e.g. "Parque Sector 6 Grupo 3A", "Parque Sector 7 Grupo 3A") · amenity=dentist ×1 (e.g. "3A Dent") · building=house ×1 (e.g. "Sra Julieta Avila 133 3 A") · office=company ×1 (e.g. "3A AMSEQ S.A") · man_made=works ×1 (e.g. "Aceros 3A")

### Mass (`mass`) — ambiguous 11, noise 10

**broad regex match only (name does not start like the chain)** (11):

- Best Massage Cusco — shop=massage · Cusco · [n13306594454](https://www.openstreetmap.org/node/13306594454)
- Copy Mass — shop=copyshop · La Libertad · [n5073884136](https://www.openstreetmap.org/node/5073884136)
- Lava Mass — shop=dry_cleaning · Lima · [n4356231815](https://www.openstreetmap.org/node/4356231815)
- Masssa — shop=yes · Lambayeque · [n5086511733](https://www.openstreetmap.org/node/5086511733)
- Masstel — shop=hairdresser · Junín · [n5039548930](https://www.openstreetmap.org/node/5039548930)
- Namaste Massage — shop=beauty · Cusco · [n13249839501](https://www.openstreetmap.org/node/13249839501)
- Nuna spa massage — shop=massage · Cusco · [n14127155501](https://www.openstreetmap.org/node/14127155501)
- Pro Massage Studio — shop=massage · Lima · [n6185047388](https://www.openstreetmap.org/node/6185047388)
- Quality Massage — shop=massage · Ica · [n5029532732](https://www.openstreetmap.org/node/5029532732)
- Relaxing Time Massage — shop=massage · Cusco · [n3426843299](https://www.openstreetmap.org/node/3426843299)
- Tortas Massiell — shop=bakery · Ayacucho · [n3086299089](https://www.openstreetmap.org/node/3086299089)

Noise by category: amenity=restaurant ×3 (e.g. "Massimo Cafe", "Pizzería Massima", "Massiel Eventos") · amenity=pharmacy ×2 (e.g. "Botica Massalud", "Massfarma") · place=village ×1 (e.g. "Massiapo") · amenity=school ×1 (e.g. "Luis Felipe Massaro Gatnau") · landuse=residential ×1 (e.g. "Massiapo") · tourism=museum ×1 (e.g. "Museo Compañía de Bomberos Voluntarios Italia N° 5") · building=residential ×1 (e.g. "mass")

### Dollarcity (`dollarcity`) — ambiguous 0, noise 1

Noise by category: amenity=bureau_de_change ×1 (e.g. "Dollar City")

### Makro (`makro`) — ambiguous 2, noise 3

**broad regex match only (name does not start like the chain)** (1):

- Fiesta Makro — shop=yes · Lima · [n4373050755](https://www.openstreetmap.org/node/4373050755)

**name matches chain pattern, but unusual shop type** (1):

- MAKRO DE San Juan de Miraflores — shop=hardware · Lima · [w437874815](https://www.openstreetmap.org/way/437874815)

Noise by category: amenity=parking ×2 (e.g. "") · amenity=bank ×1 (e.g. "CrediScotia Makro Callao")

### Vega (`vega`) — ambiguous 15, noise 166

**name matches chain pattern, but unusual shop type** (3):

- Vega — shop=jewelry · Arequipa · [n4328433489](https://www.openstreetmap.org/node/4328433489)
- Vega — shop=tailor · Ancash · [n12786451634](https://www.openstreetmap.org/node/12786451634)
- Vega Sports — shop=sports · Lima · [n4337351914](https://www.openstreetmap.org/node/4337351914)

**broad regex match only (name does not start like the chain)** (12):

- aurora pala Tarazona L-19 Av. Garcilaso de la Vega — shop=convenience · Ancash · [n13998011617](https://www.openstreetmap.org/node/13998011617)
- Bernardo Vega Yakelin E-12 — shop=convenience · Ancash · [n13998023213](https://www.openstreetmap.org/node/13998023213)
- Bodega Vega — shop=convenience · Lima · [n11311019638](https://www.openstreetmap.org/node/11311019638)
- Comercializadora Vega — shop=yes · La Libertad · [n5074082608](https://www.openstreetmap.org/node/5074082608)
- Corporación Vega — shop=supermarket · Lima · [n5965707925](https://www.openstreetmap.org/node/5965707925)
- Distribuidora Vega - IPASA — landuse=commercial · Lima · [w552407577](https://www.openstreetmap.org/way/552407577)
- Dulcería Vega — shop=confectionery · Lima · [n12968650429](https://www.openstreetmap.org/node/12968650429)
- Embragues Vega — shop=car_repair · Lima · [n9644935002](https://www.openstreetmap.org/node/9644935002)
- Motoservicios Vega S.A.C. — shop=car_repair · Lima · [w519437323](https://www.openstreetmap.org/way/519437323)
- Peluqueria de la Vega — shop=hairdresser · Ancash · [n8794078132](https://www.openstreetmap.org/node/8794078132)
- Tienda de Vega — building=commercial · Cusco · [w591039353](https://www.openstreetmap.org/way/591039353)
- Yucra Vega stefany — shop=travel_agency · Cusco · [n13734916301](https://www.openstreetmap.org/node/13734916301)

Noise by category: amenity=school ×76 (e.g. "Institución Educativa Inca Garcilaso De La Vega", "Institución Educativa 38642 Inca Garcilazo De La Vega", "Institución Educativa 38802 Inca Garcilaso De La Vega") · place=hamlet ×19 (e.g. "Fundo Bella Vega", "Vega Pata", "Vega") · amenity=kindergarten ×14 (e.g. "Institución educativa inicial 320 Angel Vega Enriquez", "Institución educativa inicial 325 Inca Garcilaso De La Vega", "Institución educativa inicial 635 Juan Jose Vega") · amenity=university ×6 (e.g. "Universidad Inca Garcilaso de la Vega", "Universidad Inca Garcilazo de la Vega", "Escuela de Posgrado") · office=company ×5 (e.g. "Grupo Vega Distribución", "Vega Distribución - Centro", "Grupo Vega Distribución Sede Cono Este") · place=village ×4 (e.g. "La Vega", "Vega del Puente", "Cruce de Vega") · leisure=park ×4 (e.g. "Parque Inca Garcilaso de la Vega", "Parque Infantil Luis Luza Vega") · historic=memorial ×3 (e.g. "Luis Negreiros Vega", "Inca Garcilaso de la Vega") · place=neighbourhood ×3 (e.g. "Vega Jabonillo", "Conde de la Vega Baja", "Conde de la Vega Alta") · amenity=hospital ×3 (e.g. "Hospital Regional Guillermo Díaz de la Vega", "Centro de salud la vega", "Hospital Luis Negreiros Vega") · building=university ×3 (e.g. "Universidad Inca Garcilaso de la Vega") · tourism=museum ×2 (e.g. "Museo Regional de Arqueología, Antropología e Historia Juan José Vega Tello", "Centro Cultural Inca Garcilazo de la Vega") · tourism=hotel ×2 (e.g. "Gran Hotel de la Vega", "Vincente de la Vega") · office=notary ×2 (e.g. "Notaria Vega Erausquin", "Notaría Bohórquez Vega") · place=isolated_dwelling ×2 (e.g. "Vega del Chino", "El Venado") · office=yes ×1 (e.g. "Inca Garcilaso de la Vega - OPE Callao") · amenity=dentist ×1 (e.g. "Vega") · amenity=public_bookcase ×1 (e.g. "Inca Garcilazo de la Vega") · office=logistics ×1 (e.g. "Grupo Vega Distribución (Sur)") · amenity=doctors ×1 (e.g. "La Vega") · tourism=guest_house ×1 (e.g. "Janet vega eguchi") · amenity=clinic ×1 (e.g. "Conde de la Vega Baja") · office=educational_institution ×1 (e.g. "Local Garcilaso de la Vega de la UNSCH") · landuse=cemetery ×1 (e.g. "Cementerio General Manuel Vega Roa") · building=school ×1 (e.g. "Teatrin del Colegio Inca Garcilazo de la Vega.") · leisure=pitch ×1 (e.g. "Estadio del Colegio Inca Garcilazo de la Vega") · historic=ruins ×1 (e.g. "Hacienda la vega") · amenity=fire_station ×1 (e.g. "Compañía de Bomberos Teniente CBP Lorenzo Giraldo Vega Nº 75") · amenity=police ×1 (e.g. "Comisaría PNP Conde de la Vega") · amenity=college ×1 (e.g. "Universidad Inca Garcilaso de la Vega - Facultad Ciencias Contables Ciencias Contables") · amenity=events_venue ×1 (e.g. "Vega Eventos") · leisure=stadium ×1 (e.g. "Estadio Inca Garcilaso de la Vega") · landuse=residential ×1 (e.g. "Asosiación de Propietarios Conde de la Vega B")

### Tambo / Tambo+ (`tambo`) — ambiguous 22, noise 827

**broad regex match only (name does not start like the chain)** (11):

- CFG & COPEINCA  Tambo de Mora — shop=seafood · Ica · [n11551311574](https://www.openstreetmap.org/node/11551311574)
- El Tambo — shop=car_repair · Junín · [w516463364](https://www.openstreetmap.org/way/516463364)
- El Tambo Perú — building=yes · Lima · [w435685820](https://www.openstreetmap.org/way/435685820)
- Estación de Servicios El Tambo — amenity=fuel · Piura · [w863627669](https://www.openstreetmap.org/way/863627669)
- Grifo Tambo del Sol — amenity=fuel · operator=PetroPerú · Pasco · [n3130479852](https://www.openstreetmap.org/node/3130479852)
- Mercado Qantun Tambo Anqara — amenity=marketplace · Huancavelica · [w1551650435](https://www.openstreetmap.org/way/1551650435)
- Mercado Tambo Inga — amenity=marketplace · Lima · [w835660744](https://www.openstreetmap.org/way/835660744)
- Mercado Tambo Machay — amenity=marketplace · Callao · [w836905818](https://www.openstreetmap.org/way/836905818)
- Qatun Tambo Anqara — amenity=marketplace · Huancavelica · [n6389310188](https://www.openstreetmap.org/node/6389310188)
- Toyota Tambo — shop=car · Junín · [n6007424385](https://www.openstreetmap.org/node/6007424385)
- Unidad de peaje Tambo Grande — (no main tag) · operator=Provias Nacional · Piura · [n649842263](https://www.openstreetmap.org/node/649842263)

**name matches chain pattern, but no retail tag** (6):

- Tambo Cubantia — building=yes · Junín · [w1120677943](https://www.openstreetmap.org/way/1120677943)
- Tambo de Bronce — (no main tag) · Arequipa · [n4354917041](https://www.openstreetmap.org/node/4354917041)
- Tambo Huancabamba — building=yes · Pasco · [w1348624681](https://www.openstreetmap.org/way/1348624681)
- Tambo La Cabezona — building=yes · Arequipa · [n4354917040](https://www.openstreetmap.org/node/4354917040)
- Tambo Pampa Entsa MIDIS — building=yes · Amazonas · [w1030820158](https://www.openstreetmap.org/way/1030820158)
- Tambo Ruelas — building=yes · Arequipa · [w627930729](https://www.openstreetmap.org/way/627930729)

**name matches chain pattern, but unusual shop type** (5):

- Tambo — shop=confectionery · Lima · [n4374364526](https://www.openstreetmap.org/node/4374364526)
- Tambo — shop=car_parts · Lima · [w439920687](https://www.openstreetmap.org/way/439920687)
- Tambo - Licorería & Piqueos — shop=alcohol · Ancash · [n12431227110](https://www.openstreetmap.org/node/12431227110)
- Tambo A comer pescado — shop=seafood · Ayacucho · [n5469209021](https://www.openstreetmap.org/node/5469209021)
- Tambo pesquero San Melchor — shop=seafood · Ayacucho · [n5469295121](https://www.openstreetmap.org/node/5469295121)

Noise by category: amenity=social_facility ×516 (e.g. "Tambo", "Tambo chullunquiani", "Tambo Kallapuma") · place=hamlet ×104 (e.g. "Tambo", "Lliclla Tambo", "El Tambo") · place=village ×26 (e.g. "Tambo", "Tambo Quemado", "El Tambo") · amenity=restaurant ×23 (e.g. "Tambo Turistico", "El Tambo del Chaski", "Tambo") · tourism=hotel ×16 (e.g. "Munay Tambo", "Kenti Tambo", "Tambo Colorado Hostal") · historic=archaeological_site ×14 (e.g. "Gasgaragra Tambo", "Tambo Colorado", "Tambo") · tourism=hostel ×13 (e.g. "Hostal El Tambo", "El Tambo del Chaski", "Tambo Andina Alojmiento") · amenity=doctors ×10 (e.g. "Tambo", "Tambo Quemado", "Tambo Inga") · office=government ×8 (e.g. "Tambo Ayaccasi", "Tambo Tarasacapampa", "Tambo Oquebamba") · amenity=school ×8 (e.g. "Institución Educativa San Martin De Porras Tambo", "Institución Educativa Tambo De Gozo", "Institución Educativa Tambo Del Ene") · amenity=clinic ×6 (e.g. "Clinicas Lima Tambo", "El Tambo", "Santa Rosa de Tambo") · office=company ×6 (e.g. "Tambo San Pedro Zona I", "TAMBO SAN PEDRO ZONA I", "Tambo Pampa Hermosa") · place=isolated_dwelling ×5 (e.g. "Tambo", "Tambo Quemado") · amenity=kindergarten ×5 (e.g. "Institución educativa inicial Tambo De Gozo", "Institución educativa inicial 1015 Tambo", "Institución educativa inicial Tambo") · tourism=guest_house ×4 (e.g. "Tambo del Solar", "El Tambo de Alesia", "Tambo Real Cottage") · tourism=attraction ×4 (e.g. "Tambo o Paredones", "Tambo", "Tambo de Mora") · place=town ×3 (e.g. "Tambogrande", "Tambo", "Tambo de Mora") · amenity=police ×3 (e.g. "Control de El Tambo", "Policlinico Municipal El Tambo", "Comisaría PNP Tambo de Mora") · amenity=cafe ×3 (e.g. "Tambo", "Hotel Acolpacha Tambo Boutique") · amenity=fast_food ×3 (e.g. "Tambo +", "Tambo", "Tambo II") · amenity=community_centre ×3 (e.g. "Tambo Mides", "Tambo Quinjalca", "Tambo Nunumia") · landuse=cemetery ×3 (e.g. "Cementerio San Andrés", "Cementerio El Tambo", "Cementerio de Tambo") · tourism=camp_site ×2 (e.g. "Tambo Qqesccañuma", "Tambo del Alto Shilcayo") · place=suburb ×2 (e.g. "Tambo", "El Tambo") · tourism=information ×2 (e.g. "Tambo", "TAMBO San Pedro Zona I") · leisure=park ×2 (e.g. "PARQUE LOS ALPES", "Parque de la Cruz de Tambo Viejo") · railway=station ×2 (e.g. "Tambo", "Tambo de Viso") · place=neighbourhood ×2 (e.g. "Urb. Tambo de Monterrico", "Nuevo Tambo de Mora") · amenity=townhall ×2 (e.g. "Municipalidad de Tambo de Mora", "Municipalidad de El Tambo") · natural=water ×2 (e.g. "Laguna El Tambo", "Laguna Tambo") · landuse=residential ×2 (e.g. "Tambo", "Condominio Tambo Verde") · man_made=bridge ×2 (e.g. "Puente Tambo") · historic=ruins ×1 (e.g. "Tambo Colorado") · amenity=bar ×1 (e.g. "El Tambo") · tourism=yes ×1 (e.g. "La Cruz de Tambo Viejo") · amenity=public_bath ×1 (e.g. "Aguas Termales Tambo") · amenity=bus_station ×1 (e.g. "Chincha Baja Tambo de Mora") · amenity=social_centre ×1 (e.g. "Tambo Huitotos de Negro Urco") · place=locality ×1 (e.g. "Tambo 1") · tourism=alpine_hut ×1 (e.g. "Tambo Puca Puca") · emergency=defibrillator ×1 (e.g. "") · healthcare=centre ×1 (e.g. "Puesto de salud Tambo Inga") · amenity=hospital ×1 (e.g. "Centro de Salud Tambo de Mora") · amenity=fire_station ×1 (e.g. "Compañía de Bomberos El Tambo Nº 198") · leisure=yes ×1 (e.g. "Club El Tambo de San Miguel") · building=public ×1 (e.g. "Tambo Jalcapampa") · leisure=pitch ×1 (e.g. "Loza deportiva Tambo Real") · building=house ×1 (e.g. "Acolpacha Tambo Boutique") · (no main tag) ×1 (e.g. "Subestación Tambo de Mora") · landuse=farmyard ×1 (e.g. "Viveros el Tambo") · place=square ×1 (e.g. "Villa Tambo") · landuse=recreation_ground ×1 (e.g. "El Tambo") · leisure=sports_centre ×1 (e.g. "Campo deportivo Cesar Medina Cruz- Tambo,Amotape")

### Oxxo (`oxxo`) — ambiguous 0, noise 2

Noise by category: craft=winery ×2 (e.g. "Oxxo")

### Candidates with no chain hit

- París — shop=department_store · operator=Cencosud · brand:wikidata=Q20812805 · Arequipa · [n4020719836](https://www.openstreetmap.org/node/4020719836)
- Paris — shop=fashion · operator=Cencosud · Callao · [n4224791290](https://www.openstreetmap.org/node/4224791290)
- Banco Cencosud — amenity=bank · Lima · [n4346570815](https://www.openstreetmap.org/node/4346570815)
- París — shop=department_store · operator=Cencosud · brand:wikidata=Q20812805 · La Libertad · [n4453931576](https://www.openstreetmap.org/node/4453931576)
- Centro de Capacitación — office=employment_agency · operator=Cencosud · Lima · [n5150561696](https://www.openstreetmap.org/node/5150561696)
- Teleticket — shop=ticket · operator=Cencosud · Arequipa · [n5468199634](https://www.openstreetmap.org/node/5468199634)
- Mz 45 — landuse=residential · operator=Supermercados Peruanos · Callao · [w303407091](https://www.openstreetmap.org/way/303407091)
- Centro Comercial Plaza Center — shop=mall · operator=InRetail · Lima · [w430075294](https://www.openstreetmap.org/way/430075294)
- Almacén InRetail Pharma S.A. — landuse=industrial · old_name=Fábrica Luchetti · Lima · [w466181497](https://www.openstreetmap.org/way/466181497)
- Cenco La Molina — shop=mall · operator=Cencosud Shopping S.A. · Lima · [w474927316](https://www.openstreetmap.org/way/474927316)
- Centro Comercial Plaza Center Lurín — shop=mall · operator=InRetail · Lima · [w612815091](https://www.openstreetmap.org/way/612815091)
- Centro de distribución Supermercados Peruanos — landuse=industrial · Lima · [w685104113](https://www.openstreetmap.org/way/685104113)

