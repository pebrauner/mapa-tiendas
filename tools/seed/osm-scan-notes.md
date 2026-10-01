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
