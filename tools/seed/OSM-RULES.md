# OSM classification rules — schema (`data/chains.js`)

Since 2026-10-01 the rules that decide whether an OpenStreetMap element is a store of a tracked chain live in **one
place**, published in `data/chains.js`:

- `window.MT_CHAINS[i].osm` — per-chain rules (name pattern, look-alike exclusions, shop types, format…);
- `window.MT_OSM_RULES` — cross-chain rules (closed shops, transit/parking/banks/schools, "not the chain" notes,
  doubtful positions, retail buildings, dedupe radii).

The seed merge (`tools/merge.mjs`) builds `data/chains.js` and then **classifies with exactly the content it wrote**
(it evaluates the generated file in a sandbox and compiles it with `tools/seed/osm-classify.mjs`). The in-app OSM scan
(`js/osm.js`) uses the same structures (§6), so a store found by the app is judged like the seed.

| What | Where you edit it | Generated into |
|---|---|---|
| Per-chain rules | the `"osm"` object of `tools/seed/chains/<id>.json` | `MT_CHAINS[i].osm` (all keys, fixed order, defaults filled) |
| Cross-chain rules | `tools/seed/osm-rules.json` | `MT_OSM_RULES` (same content; `about` replaced by `"doc": "tools/seed/OSM-RULES.md"`) |
| Classifier (reference code) | `tools/seed/osm-classify.mjs` (pure ES module, no Node APIs) | used by `tools/merge.mjs` and `tools/seed/check-osm-rules.mjs` |
| Test fixtures for a port | — | `tools/seed/osm-rules-fixtures.json` (177 real OSM elements with the expected result) |

Never edit `data/chains.js` by hand: `node tools/merge.mjs` rewrites it. After editing rules: `node tools/merge.mjs`
→ `node tools/build-data.mjs` → `node tools/seed/check-osm-rules.mjs --write-fixtures`.

## 1. Text folding and regex flags

Every regex below is a **JavaScript regex source string**. Compile it with flags **`'iu'`** and test it against
**`fold(text)`**:

```js
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
// "  Supermercado  MÉTRO " → "supermercado metro"
```

The only exception is `MT_OSM_RULES.closed.lifecycleKeyRegex`, which is tested against tag **keys** (unfolded). Patterns
are written for folded text, but where an accent is likely they also accept it (`l[ií]nea`, `estaci[oó]n`, `m[aá]s`),
so they mostly work on raw lower-cased text; folding is still required for exact parity with the seed (e.g.
`"Súper Metro"` only matches the `super…` prefix after folding).

For the Overpass pre-filter, `MT.osm.toERE(nameRegex)` (lookarounds and `\b` dropped → broader) is still the right
tool: the query may over-select, the client-side classification below decides. `excludeNameRegex` and every
`MT_OSM_RULES` rule are **client-side only** (never put them in the query: they would only narrow it).

## 2. Per-chain rules: `MT_CHAINS[i].osm`

All keys are always present in `data/chains.js` (defaults filled by the generator).

| Key | Type (default) | Meaning |
|---|---|---|
| `wikidata` | `string[]` (`[]`) | Wikidata QIDs of the brand (upper case). `brand:wikidata` ∈ these → the element is this chain (step 1). |
| `nameRegex` | regex (`''`) | Anchored pattern of the chain's **name** (on folded `name`/`name:es`, then `brand`). `''` = the chain is matched by Wikidata only. |
| `excludeNameRegex` | regex (`''`) | Names that match `nameRegex` but are **not** the chain (look-alikes). A name "is the chain" when `nameRegex` matches **and** `excludeNameRegex` does not. Equivalent to the negative lookaheads the merge used before. |
| `label` | string (chain name) | Chain part of store names (`"Precio Uno"`, `"Tiendas 3A"`); also an "exact chain name" for `uniqueName`. |
| `prefixRegex` | regex (`''`) | The chain part at the start of a store name (folded), replaced by `label` when building display names ("HIPERMERCADOS TOTTUS ANGAMOS" → "Tottus Angamos"). Naming only. |
| `shops` | `string[]` | `shop=*` values that are a format of this chain → kind `shop`. |
| `requireShopLike` | bool (`true`) | `true`: small formats — an element without `shop=*` is never a store. `false`: big formats — a retail building / mall part / marketplace named like the chain (no `shop` tag) counts (kind `building`). |
| `dense` | bool (`false`) | Small proximity format (stores can be < 150 m apart): use the `dense` radii of `MT_OSM_RULES.radii` (dedupe 40 m instead of 200 m…). |
| `uniqueName` | bool (`false`) | The name is distinctive: an **exact** chain name (`label` or chain `name`) on an unrelated shop type is a mis-tagged store (kind `weak`), not another business. |
| `weakNameRegex` | regex (`''`) | Names that look like the chain but may be another business (e.g. Mass: `"Mass Ahorro"`, `"Mass Extra"`) → kind `weak`. |
| `weakNameShops` | `string[]` (`[]`) | Restrict `weakNameRegex` to these shop values (`[]` = any shop). Vega: a bare `"Vega"` is weak only on `shop=yes`. |
| `excludeTags` | `{key, valueRegex, why}[]` (`[]`) | Element is excluded when tag `key` exists and `valueRegex` matches its folded value. Tambo: `operator` of the government *Programa Nacional PAIS* (MIDIS) "Tambo" social centres. |

Current per-chain values (16 chains): `node -e` on `data/chains.js`, or read the chain JSONs. Formats:
`requireShopLike:false` (big) = Plaza Vea, Tottus, Wong, Metro, Vivanda, Precio Uno, Makro; all others are `dense`.

## 3. Cross-chain rules: `MT_OSM_RULES`

| Key | Meaning |
|---|---|
| `version` | `1`. Bump when a key changes meaning. |
| `nameKeys` | `["name","name:es"]` — the element's name is the first non-empty of these (folded). |
| `brandKeys` | `["brand"]` — tried when no chain matches by name. |
| `wikidataKeys` | `["brand:wikidata"]` — QIDs (split on `;`, `,` or space), tried last. |
| `genericNameRegex` | Names that do not contradict a brand/QID match (`supermercado`, `minimarket`, `tienda`, `bodega`…). |
| `notChain.keys` / `.textRegex` | `description`, `note`, `fixme`, `comment`… whose folded text says the element is **not** the chain ("not the chain", "no es de la cadena"…). |
| `closed.lifecycleKeyRegex` | Lifecycle-prefixed keys (`disused:shop`, `was:name`…), tested on **keys**. |
| `closed.shopValues` | `shop=vacant`, `shop=no`. |
| `closed.operationalStatusRegex` / `.openingHoursRegex` / `.nameRegex` | `operational_status=closed…`, `opening_hours=closed|off`, names with "cerrado/clausurado/closed". |
| `notStore.keys` | Any of these keys present → not a store (`railway`, `public_transport`, `highway`, `place`, `tourism`, `leisure`, `office`, `healthcare`, `historic`, `craft`, `man_made`, `natural`, `aeroway`, `emergency`, `advertising`, `club`, `power`, `waterway`, `boundary`, `military`, `barrier`, `route`, `education`)… |
| `notStore.keysEvenIfBranded` | …except that a **branded** chain shop (QID or brand of the chain **and** `shop` ∈ chain `shops`) survives a stray key, unless the key is one of these (`railway`, `public_transport`, `highway`, `place`, `advertising`). |
| `notStore.amenityAllowed` | Any `amenity=*` other than these (`marketplace`) → not a store (parking, bank, ATM, fuel, restaurant, school, social_facility…). |
| `notStore.nameRegex` | Name words of non-stores (estacionamiento, paradero, puente, cajero, agente, banks, "al paso", chicken, almacén, oficina, colegio, instituto, clínica…). |
| `notStore.landuseAllowedWithoutShop` | Without `shop`: a `landuse` other than these (`retail`, `commercial`) → not a store. |
| `notStore.buildingExcludedWithoutShop` | Without `shop`: these `building` values → not a store (residential, school, church, hospital, public, warehouse, train_station…). |
| `doubtfulPosition` | Position not to be trusted: `isced:level` present or `source` ~ `minedu` (Ministry of Education school imports re-tagged as shops), a `fixme` about the position (`positionWordsRegex`), or a `note` with position words **and** fix words (`noteFixWordsRegex`). |
| `genericShops` | Grocery-like shop types that are plausible mis-tags of any chain → `weak` when not in the chain's `shops`. |
| `retailArea` | Without `shop`: `amenity` ∈ `["marketplace"]`, `building` ∈ `retail/commercial/supermarket/yes/mall`, any key of `keys` (`building:part`), or `landuse` ∈ `retail/commercial` = a retail building/area. |
| `entranceNameRegex` | `entrada/ingreso/puerta`: when collapsing duplicates, an element named like an entrance is a poor representative. |
| `radii.big` / `radii.dense` | Metres. `dedupe` (same-chain OSM duplicates collapse), `link` (node ↔ building of one store), `match` / `match2` (official list ↔ OSM, two passes), `geo` (geocoded address ↔ OSM). |

## 4. Evaluation order (`classifyOsm(tags)` in `tools/seed/osm-classify.mjs`)

The order matters (first rule that fires wins) and is part of the contract:

1. **Which chain?** `name = fold(first non-empty nameKeys)`. First chain (in `MT_CHAINS` order) whose name test passes
   (`nameRegex` && !`excludeNameRegex`) on `name` → `via:'name'`; else on `fold(brand)` → `via:'brand'`; else the first
   chain whose `wikidata` contains a QID of `brand:wikidata` → `via:'brand:wikidata'`. None → `{chain:null}`.
2. If `via` ≠ `name` and the element has a name that is not generic (`genericNameRegex`) → **excluded** (the name says
   another business).
3. A `notChain.keys` tag whose folded text matches `notChain.textRegex` → **excluded**.
4. Lifecycle key, `shop` ∈ `closed.shopValues`, `operational_status` / `opening_hours` / name closed → **closed**.
5. Not a store → **excluded**, in this order: a `notStore.keys` key (branded-shop exception above); `amenity` not in
   `amenityAllowed`; `notStore.nameRegex` on the name; the chain's `excludeTags`; (no `shop`) `landuse` not allowed;
   (no `shop`) `building` in `buildingExcludedWithoutShop`.
6. Doubtful position and `shop` ∈ chain `shops` ∪ `genericShops` → **weak, noCoords** (may confirm an official store;
   its coordinates must never be used).
7. Has `shop`: in chain `shops` and not a weak name → **shop**; weak name → **weak**; in `genericShops` → **weak**;
   `uniqueName` and exact chain name → **weak**; otherwise → **excluded** (other business type).
8. No `shop`: not a `retailArea` → **excluded**; `requireShopLike:false` → **building**; else **excluded**.

Result: `{chain, via, kind:'shop'|'building'|'weak'|'closed'|'excluded', reason?, noCoords?, doubt?}`. The seed keeps
`shop` and `building` as stores, uses `weak` only to confirm official stores, writes `closed` OSM elements as closed
rows only when an official source agrees, and drops `excluded`.

A suggested mapping for the app's scan (proposals the user reviews): `shop`/`building` → propose as new/matched;
`weak` → propose only with a "dudoso" flag (and never move a store to a `noCoords` position); `closed` → treat like
"not found in OSM"; `excluded`/`null` → ignore.

## 5. Which rule removes which look-alike

| Look-alike | Removed by |
|---|---|
| Metro de Lima / Línea 1–2 / "Metro 2" / Metropolitano stations, "Metro Visión", "Metro Gas" | `metro.excludeNameRegex` (names), `notStore.keys` (`railway`, `public_transport`), `amenity=bus_station` |
| Government "Tambo" social centres (Programa Nacional PAIS, MIDIS), "Tambo de Mora", "Tambo del Inca", places "Tambo…" | `tambo.excludeTags` (`operator`), `amenity=social_facility`, `place=*`, `tambo.excludeNameRegex` ("Tambo de/del …"), `requireShopLike` |
| "Inca Garcilaso de la Vega" schools, "Bella Vega" hamlets, "Bodega Vega", "Peluquería de la Vega" | anchored `vega.nameRegex` (the name must *start* with Vega or a Vega format word), `amenity=school`, `place=*` |
| "3A" in block / lot / sector names ("Sector 9 Grupo 3A", "Mz … 3A-11"), "Aceros 3A", "3A Salón & Estética" | anchored `tiendas3a.nameRegex` (`3A` alone or `3A Hard Discount`, or `Tienda(s) 3A …`), `place=*` (city blocks), `requireShopLike` |
| "Tottus al paso" counters, "Mass Chicken", "Holi Day", "Oxxo Gas" | `excludeNameRegex` of the chain |
| Restaurants ("Chifa Wong"), ATMs/agents/banks ("Interbank – PlazaVea"), parking ("Estacionamiento Plaza Vea"), bridges, taxi stops, schools, clinics, offices, warehouses | `notStore.amenityAllowed`, `notStore.nameRegex`, `notStore.keys`, `buildingExcludedWithoutShop` |
| "Not the chain" in `description` / `note` / `fixme` / `comment` | `notChain` |
| `disused:` / `was:` / `abandoned:` keys, `shop=vacant`, "cerrado" | `closed` |
| Minedu school imports re-tagged as shops, fixme "corregir ubicación" | `doubtfulPosition` → weak, `noCoords` |
| Malls / offices that only carry the operator (Cencosud, InRetail…) | step 1 never uses `operator`; step 2 when only brand/QID matches a non-generic name |

## 6. The app (`js/osm.js`) uses these rules

Since 2026-10-01 the in-app OSM scan classifies with exactly these structures (docs/ARCHITECTURE.md §6.3, `MT.osm`):

- `MT.osm.classifyTags(tags, MT.osm.compile())` is `classifyOsm` ported line by line (folding of §1, the step order of
  §4, the same `reason` strings). `node tools/test/osm-rules.test.mjs` checks it against the 177 fixtures of
  `tools/seed/osm-rules-fixtures.json`, against `classifyOsm` on all 2,426 elements of `tools/seed/osm-raw.json`
  (chain, via, kind, reason, noCoords, doubt) and against `tools/seed/merge-log.json`.
- The Overpass query is built from the rules: every element with one of `nameKeys` + `brandKeys` or `wikidataKeys` in
  the tile, filtered in memory by the selected chains' `toERE(nameRegex, {anchors:false})` and Wikidata ids. Anchors
  are dropped because the rules test folded text and Overpass the raw name ("Súper Metro"); `excludeNameRegex` and
  every `MT_OSM_RULES` rule stay client-side. The test proves that the query lets through all 1,456 elements the
  classifier assigns to a chain.
- Duplicates collapse like step 2 of the merge (`MT.osm.cluster`: `radii.dedupe` / `.link`, the merge's
  representative score, weak elements absorbed within `link`); matching DB stores uses `radii.match` of the chain.
- Mapping of the kinds in the review: `shop` / `building` → new or matched; `weak` → matched (shops first), otherwise
  a «Dudosa» proposal that is not pre-selected, and never when `noCoords` (its position is never used, not even to
  "move" a store); `closed` → the store it represents goes to «No encontradas» as «Cerrada en OSM»; `excluded` /
  `null` → ignored (counted as «descartados por las reglas»).
- On the seed's raw data the app reproduces the seed: for the 4 demo areas and for all Peru, the proposals are exactly
  the `stores.csv` rows with `source=osm` (same ids, same chains); the only row that is not a plain proposal,
  `osm-n13699135001` (Mass), is a weak element the merge kept because the official list confirms it — the app shows
  it as «Dudosa». A scan of a demo area answered by the seed's elements finds 0 new, 0 moved, 0 not found.
- `MT.data.normalizeChain` keeps every key of §2 (`MT.data.normalizeOsm`, merge order and defaults); chain edits saved
  by an older version are completed from the shipped chain; `MT.data.upsertChain` merges a partial `osm`.
  `MT.io.chainsJs` ("Guardar en carpeta") writes `data/chains.js` in the merge's exact format, `MT_OSM_RULES` block
  included: unedited data is written back byte for byte (`tools/test/data-roundtrip.test.mjs`), and the reference
  classifier compiles a file the app wrote with an edited chain.
- The Cadenas tab shows and edits every per-chain key (advanced section) and summarizes `MT_OSM_RULES` (edited here,
  in `tools/seed/osm-rules.json`, not in the app).
- `MT_OSM_RULES` missing (an old `data/chains.js`): the app uses its built-in copy of `tools/seed/osm-rules.json` v1
  (`MT.osm.BUILTIN_RULES`; a test checks it equals the published block — update both when the rules change).
- App-only extensions, unused by the 16 seed chains: `shops: []` means "any `shop=*` value"; an `excludeTags` entry
  with an empty `valueRegex` excludes on the key alone; a registered chain with neither `nameRegex` nor `wikidata`
  (added by the user) is searched with `MT.osm.nameRegexFor(name)` = the folded name anchored at the start
  (`^economax\s*peru(?![a-z0-9])`), and new chains get `dense: true`, `requireShopLike: true`.

## 7. Proof that the move changed nothing in the seed

On 2026-10-01 `tools/merge.mjs` was switched from its hard-coded `RULES` / constants to these structures. With the same
inputs the outputs were **byte-identical**: `data/stores.csv`, `data/stores.js`, `tools/seed/REPORT.md` and
`tools/seed/merge-log.json` (which logs chain, via, kind and reason of all 1,456 OSM elements matched to a chain). In
addition, the old and new name / prefix / weak-name patterns agree on 3.3 million (string, chain) checks over every tag
value of the scan plus a synthetic grammar of chain words (folded text). `node tools/seed/check-osm-rules.mjs`
repeats the classification check at any time (2,426 elements, 0 differences).

`tools/scan-osm.mjs` keeps its own deliberately **broad** candidate patterns (it collects candidates nationwide for the
merge to classify); it is not a classifier and does not use these rules. `tools/seed/logo-src/osm_rules.json` is a
superseded snapshot from the logo stage's OSM probe (read only by `logo-src/osm_analyze.mjs`): not a source of rules.
