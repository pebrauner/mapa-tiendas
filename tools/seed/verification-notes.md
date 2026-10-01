## Verification fixes (2026-10-01)

*Hand-written (`tools/seed/verification-notes.md`); `tools/merge.mjs` inserts it here and appends what the rules and
overrides did in the current run.*

An independent review reported 21 issues with evidence. I re-checked each one before changing anything, using the local
seed data plus fresh lookups: two Overpass queries (house numbers on the streets involved; street geometry for four
crossings), two OSM API batch calls (version and last-edit date of all 60 OSM-only rows → `tools/seed/osm-element-meta.json`)
and four Nominatim requests (one reverse lookup, three searches). Fixes were made **at the source**: general rules in `tools/merge.mjs`, per-store decisions
with their evidence in `tools/seed/overrides.json`, chain metadata, and logos. `data/stores.csv` was not edited by hand.

Net effect: 3,546 → 3,536 rows. Verified 3,318 → 3,278, to_verify 227 → 254, closed 1 → 4. Manual placement 34 → 32.
Lima Sur Tottus goes from 6 to 5 rows.

### Fixed

| # | Issue (review) | Re-check | Fix | Result |
|---:|---|---|---|---|
| 1 | Tottus Comandante Espinar had two rows; the verified one pointed at a `shop=carpet` building | Confirmed. OSM house numbers #689 and #730–750 are at lat −12.1124; the matched building (w435690073) sits between #450 and #529 | **Rule**: a weak element cannot win a name/street match while an unmatched proper shop of the chain is within 600 m | `osm-n7091051785` = Tottus Comandante Espinar (verified); w435690073 dropped as an unused weak element |
| 2 | OSM "Tambo" in Urubamba tagged `description=not the chain` | Confirmed | **Rule**: elements whose description/note/fixme says they are not the chain are excluded. I checked the other plain "Tambo" OSM-only rows (Arequipa, Magdalena, Pueblo Libre, San Juan de Miraflores): none has such a tag | Row removed |
| 3 | Tottus Ica: two OSM-only nodes for one official store | Confirmed. Dollarcity's official coordinates for "Av. San Martín #727-763, CC Plaza del Sol" are 108 m from n2922674739 | **Override** link (evidence in `overrides.json`) + **override** status for the other node | `osm-n2922674739` = Tottus Ica (verified). `osm-n4308090578` is closed (hidden) as a probable duplicate or former site |
| 4 | Plaza Vea OSM-only rows are untouched OSM data from 2016–2017; REPORT called them "most likely real" | Confirmed (OSM API dates) | **Rule**: OSM-only notes now give the survey year (`source=*`) and last-edit date. §0 reworded. The rows are listed first in the queue | Still to_verify (no evidence that they closed) |
| 5 | Mass Cl. Abtao 460 took its coordinates from a school-import node with a position fixme | Confirmed (`isced:level=1`, `source=minedu.gob.pe`, fixme about the position) | **Rule**: elements with isced:level / source=minedu / a fixme about the position only confirm a store; they never supply coordinates | `web-mass-cl-abtao-460` at the official coordinates (verified). The same rule kept the official point for Plaza Vea San Juan de Lurigancho Mall (its OSM node has `fixme=Location`) |
| 6, 15 | Mass "Boulevard De Paracas": Paracas text, Huánuco coordinates | Confirmed: internal code "Juan21 HCO MS"; Nominatim reverse = Av. Juan Velasco Alvarado, Pillco Marca. The Paracas store has its own row | **Rule**: official point in another department than stated → to_verify, approx. **Override**: renamed after its street | `web-mass-av-juan-velasco-alvarado` (to_verify). The rule also caught Mass "A.H. Villa El Sol II Etapa - Nuevo Edén" (says La Victoria, Lambayeque; point in Chimbote) |
| 7, 12 | Dollarcity 28 de Julio (Huaraz) placed 34 km away in Pampas Grande | Confirmed (20.8 km outside Huaraz district) | **Rule**: official point > 5 km outside the stated district → to_verify, approx, unless the stated name is the province (≤ 15 km) or department that contains the point. **Override**: coordinates discarded, geocoded to Urb. Huarupampa | Placed at the Huarupampa neighbourhood centre (approx, to_verify). The rule also flagged Dollarcity Blvd Puntamar and 4 Mass rows (list below) |
| 8 | 2 Maxiahorro OSM-only rows sit on current Dollarcity premises | Confirmed: 4 m and 23 m away, same house numbers; SMU's list is complete (32 = 32 reported) | **Rule**: an OSM-only row of a chain whose official list is complete, on another chain's official premises (same house number or ≤ 10 m) → closed | Both closed. No other row met the condition; 16 other OSM-only rows got a note that another chain's official store is ≤ 60 m away |
| 9 | Holi "wide" logo was the stacked badge (459×512) | Confirmed. Holi has no horizontal wordmark | `logos/holi-wide.png` removed (kept in `tools/seed/logo-src/holi/`); `chains/holi.json` updated; `logos.js` rebuilt | `MT_LOGOS.holi.wide = null`, so the card style falls back to the badge |
| 10 | Press-only Tambo openings that duplicate official entries were separate rows | Confirmed (6 press records flagged "possible duplicate of official entry …") | **Rule**: such press records become a note on the named official entry | 4 rows removed and 2 manual-placement entries dropped. "Jardines Este 587" (July press, not flagged) stays as its own row and no longer shares a point with another row |
| 11 | Precio Uno rows 3–10 km from their addresses | Confirmed with OSM house numbers | **Rule**: house-number check. **Overrides**: two street corners from OSM street geometry | Mariátegui moved 10 km to San Gabriel Alto (interpolated between #2104 and #3119). El Agustino placed at the Ayllón × Riva Agüero corner. Comas placed at the Micaela Bastidas × González Prada crossing. Próceres #5540 rejected (beyond the known numbers; the geocode sat at #750) → manual placement with the official map link |
| 13 | Tiendas 3A Independencia 2: corrupted official coordinates (Los Olivos instead of Barranco) | Confirmed: same latitude as "Independencia 27" and its longitude with one digit dropped. OSM w436474198 is 18 m from Jirón Independencia, Barranco | **Rule**: digit-dropped coordinates are discarded. **Override** link | `osm-w436474198` = Tiendas 3A Independencia 2 (verified). The companion rule (one coordinate identical to another store's) flagged 27 more pairs (23 Tambo, 4 Mass) → to_verify |
| 14 | Tottus Sáenz Peña drawn in Bellavista and again as an OSM-only row | Confirmed: n14208047522 is 58 m from Calle Castilla (Callao) and about 150 m from Sáenz Peña block 4 | **Rule**: geocoded stores whose source names no district may match an OSM store of the same province; the radius is ×1.5 when the address names a cross street | `osm-n14208047522` = Tottus Sáenz Peña (verified); the Bellavista row is gone |
| 16 | Tiendas 3A Manuel 5 geocoded to another street, 3 km away | Confirmed | House-number check (extrapolated from #902 and #1580 on the same avenue) | Moved 3.2 km into Urb. El Retablo (approx) |
| 17 | Approx rows sharing one street point are 1.1–1.6 km from their numbers | Confirmed | House-number check, plus a stricter geocoding rule: a street-level answer must name the street itself | Tambo El Retablo 1378, Mass El Retablo 1131, Holi La Marina 2 and 1, Tambo Alfredo Mendiola 900 and Tambo Alfonso Ugarte 1444 moved (list below). The VES "Pasaje Pachacámac" hit was "Pasaje 16" → manual placement |
| 18 | Dollarcity Blvd Puntamar: address says Punta Hermosa, point in San Bartolo | Confirmed (7.0 km outside Punta Hermosa) | District rule (#7) | to_verify, approx. Not moved: nothing I could retrieve says where "Puntamar" is |
| 19 | 23 rows whose official coordinates the source doubts were still `exact` | Confirmed | **Rule**: doubtful official coordinates are written with precision approx | 33 official-coordinate rows are now approx: 23 doubted by the source, 5 sharing a point with another store, 3 far from the stated district, 2 in another department |

### Not changed, partly done, or rejected

- **Mass on by default (#20)**: left unchanged in the verification (a SPEC decision, not a data error); done in the
  2026-10-01 data polish: `"defaultOn": false` in `tools/seed/chains/mass.json` (see "What changed"
  above). `data/chains.js` is generated from `tools/seed/chains/*.json`; editing it directly would be overwritten.
- **Store-count gaps (#16 of the review)**: partly done. Holi 28 de Julio is now the OSM node on Av. La Paz 971 (house
  numbers put #971 about 20 m from it) and Tottus Ica is placed. The other gaps need new sources and are listed under
  "Remains" below; I did not invent stores to close them.
- **Plaza Vea rows next to Mass stores** (Av. Alejandro Iglesias, Chorrillos; Av. España, Trujillo): not closed. Being
  35–50 m from a Mass store is not evidence of closure, so they stay to_verify with a note.
- **Copied coordinates**: when a store's latitude or longitude equals another store's, the rule cannot tell which of the
  two is wrong. These rows get to_verify but keep precision `exact`. Only the digit-drop case (#13) is certain enough to
  discard the coordinates.
- **The review's "~1.5 km radius whenever a cross street is named"**: applied only to geocoded-address ↔ OSM matching (P5):
  1.5 km for big formats, 375 m for small ones. Applied everywhere, it would have produced false matches.
- **In-app OSM scan**: the "not the chain" and doubtful-position exclusions are not in the app's scan yet. `js/` belongs to
  the app workflow and was not touched here.

### Remains for you to verify manually

1. **The verification queue below**: the to_verify rows most likely to be wrong (112 in this run), most doubtful first. Start with the position conflicts:
   the renamed Huánuco Mass, Dollarcity Blvd Puntamar, Dollarcity 28 de Julio (placed at the neighbourhood centre),
   Precio Uno El Agustino / Comas / Mariátegui (computed positions), and the house-number moves.
2. **§4 Needs manual placement** (32 stores). Precio Uno Próceres, Lurín, Ate Kampu and Iquitos La Marina have official
   Google Maps links in the table; open them yourself and paste the coordinates. Tottus Iquitos is in Mall Aventura
   Iquitos. Holi Pardo and Holi Petit Thouars: the district is unknown.
3. **Decisions only you can make**: (a) is "Mass Av. Juan Velasco Alvarado" (Pillco Marca) a real store, or a stray copy
   of the Paracas record? (b) Tottus `osm-n4308090578` (Calle Lima, Ica) is hidden; re-enable it if Ica has a second
   Tottus. (c) The Plaza Vea OSM-only rows from 2016–2017 ("Express" in Chimbote and San Isidro, "Super" in San Miguel,
   the San Juan de Lurigancho building `osm-w437375221`, and the two next to Mass stores): set each to closed or verified.
   (d) The 27 copied-coordinate pairs: check which store of each pair is misplaced.
4. **Count gaps, and where to look**:
   - **Dollarcity** (112 rows vs 116 reported on 2026-07-02): query the locator again in a few weeks, and read the July–September
     "Dollarcity inaugura" articles in Peru-Retail and Gestión.
   - **Oxxo** (210 vs 215 in the FEMSA 6-K for 2026-06-30): the list is a January 2026 copy, so read FEMSA's quarterly report and the
     Peru-Retail "Oxxo inaugura" articles. The 5 OSM-only Oxxo rows may be openings since January.
   - **Tambo** (890 rows + 19 manual vs 902 reported on 2026-09-09; 52 Justo stores have online ordering disabled, so some may be
     closed): query the Justo API again and read Peru-Retail's monthly opening articles.
   - **Precio Uno**: the 4 manual stores above.
   - **Holi**: Pardo and Petit Thouars.
   - **Tottus**: Iquitos, plus confirming the OSM candidates for Trujillo 1 (`osm-n4453923987`) and Zorritos (`osm-w436598550`).
5. **For the radius / cannibalization feature** (SPEC §1, basic version in v1; the full analysis is phase 2): treat
   rows with `precision = approx` **or** `status = to_verify` as uncertain positions. Never draw `closed` rows. On a long
   avenue an approx row can still be a few hundred metres off.
