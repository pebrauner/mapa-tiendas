/**
 * tools/seed/osm-classify.mjs — reference implementation of the OSM classification rules published in
 * data/chains.js (per-chain `osm` objects of window.MT_CHAINS + the cross-chain window.MT_OSM_RULES).
 * Schema and evaluation order: tools/seed/OSM-RULES.md. Used by tools/merge.mjs; pure (no Node APIs),
 * so js/osm.js can port it line for line and test against the same fixtures.
 *
 *   const R = compileOsmRules(window.MT_CHAINS, window.MT_OSM_RULES);
 *   classifyOsm(tags, R) → { chain: null, reason }                                  no chain matches
 *                        | { chain, via: 'name'|'brand'|'brand:wikidata', kind, reason?, noCoords?, doubt? }
 *     kind = 'shop'      a store of the chain (shop=* is one of the chain's formats)
 *            'building'  no shop tag, but a retail building / mall part / marketplace named like a big-format chain
 *            'weak'      odd tagging: only good to confirm an official store (noCoords: its position must not be used)
 *            'closed'    closed in OSM (lifecycle prefix, shop=vacant, operational_status, opening_hours, "cerrado")
 *            'excluded'  not a store (or not the chain); `reason` says why
 *   doubt = { code: 'school-import'|'school-source'|'fixme'|'note', key, value } when kind = 'weak' && noCoords.
 *
 * Every regex is compiled with flags 'iu' and tested against fold(text) — except closed.lifecycleKeyRegex,
 * which is tested against tag KEYS.
 */

/** NFD, combining marks removed, lower-case, runs of white space → one space, trimmed. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

function rx(src, what) {
  if (!src) return null;
  try { return new RegExp(src, 'iu'); } catch (e) { throw new Error(`OSM rules: invalid regex in ${what}: ${e.message}`); }
}
const qidsOf = (v) => String(v || '').split(/[;,\s]+/).filter(Boolean).map((q) => q.toUpperCase());

/** Compile MT_CHAINS[].osm + MT_OSM_RULES into matchers. Throws on an invalid regex. */
export function compileOsmRules(chains, G) {
  if (!G || !Array.isArray(chains)) throw new Error('OSM rules: MT_CHAINS and MT_OSM_RULES are required');
  const list = chains.map((c) => {
    const o = c.osm || {};
    const re = rx(o.nameRegex, `${c.id}.osm.nameRegex`), ex = rx(o.excludeNameRegex, `${c.id}.osm.excludeNameRegex`);
    return {
      id: c.id, name: c.name, label: o.label || c.name,
      qids: (o.wikidata || []).map((q) => String(q).trim().toUpperCase()),
      /** The chain's name pattern: nameRegex matches and excludeNameRegex does not. */
      isName: (txt) => !!re && re.test(txt) && !(ex && ex.test(txt)),
      prefix: rx(o.prefixRegex, `${c.id}.osm.prefixRegex`),
      shops: o.shops || [],
      building: o.requireShopLike === false,
      dense: !!o.dense,
      unique: !!o.uniqueName,
      weakName: rx(o.weakNameRegex, `${c.id}.osm.weakNameRegex`),
      weakNameShops: o.weakNameShops && o.weakNameShops.length ? o.weakNameShops : null,
      excludeTags: (o.excludeTags || []).map((x, i) => ({ key: x.key, re: rx(x.valueRegex, `${c.id}.osm.excludeTags[${i}]`) })),
    };
  });
  const g = {
    nameKeys: G.nameKeys, brandKeys: G.brandKeys, wikidataKeys: G.wikidataKeys,
    genericName: rx(G.genericNameRegex, 'genericNameRegex'),
    notChainKeys: G.notChain.keys, notChainText: rx(G.notChain.textRegex, 'notChain.textRegex'),
    lifecycleKey: rx(G.closed.lifecycleKeyRegex, 'closed.lifecycleKeyRegex'), closedShops: G.closed.shopValues,
    closedStatus: rx(G.closed.operationalStatusRegex, 'closed.operationalStatusRegex'), closedHours: rx(G.closed.openingHoursRegex, 'closed.openingHoursRegex'),
    closedName: rx(G.closed.nameRegex, 'closed.nameRegex'),
    notStoreKeys: G.notStore.keys, hardKeys: G.notStore.keysEvenIfBranded, amenityAllowed: G.notStore.amenityAllowed,
    notStoreName: rx(G.notStore.nameRegex, 'notStore.nameRegex'), landuseAllowed: G.notStore.landuseAllowedWithoutShop,
    badBuilding: new Set(G.notStore.buildingExcludedWithoutShop),
    dp: { keys: G.doubtfulPosition.schoolImportKeys, source: rx(G.doubtfulPosition.sourceRegex, 'doubtfulPosition.sourceRegex'), fixmeKeys: G.doubtfulPosition.fixmeKeys,
      pos: rx(G.doubtfulPosition.positionWordsRegex, 'doubtfulPosition.positionWordsRegex'), noteKey: G.doubtfulPosition.noteKey,
      fix: rx(G.doubtfulPosition.noteFixWordsRegex, 'doubtfulPosition.noteFixWordsRegex') },
    genericShops: new Set(G.genericShops),
    retail: G.retailArea,
    entrance: rx(G.entranceNameRegex, 'entranceNameRegex'),
    radii: G.radii,
  };
  return { chains: list, byId: Object.fromEntries(list.map((c) => [c.id, c])), g };
}

/** First non-empty value of the keys. */
const first = (t, keys) => { for (const k of keys) if (t[k]) return t[k]; return ''; };

/** Doubtful OSM position (school imports re-tagged as shops, a fixme/note about the position) → {code, key, value, reason} | null. */
export function doubtfulPosition(t, R) {
  const d = R.g.dp;
  for (const k of d.keys) if (t[k] !== undefined) return { code: 'school-import', key: k, value: t[k], reason: `${k}=${t[k]} (school import re-tagged as a shop)` };
  if (d.source.test(fold(t.source || ''))) return { code: 'school-source', key: 'source', value: t.source, reason: `source=${t.source} (school import)` };
  const fxRaw = d.fixmeKeys.map((k) => t[k]).filter(Boolean);
  if (d.pos.test(fold(fxRaw.join(' ')))) return { code: 'fixme', key: 'fixme', value: fxRaw[0], reason: `fixme="${fxRaw[0].slice(0, 80)}"` };
  const nt = fold(t[d.noteKey]);
  if (d.pos.test(nt) && d.fix.test(nt)) return { code: 'note', key: d.noteKey, value: t[d.noteKey], reason: `note="${t[d.noteKey].slice(0, 80)}"` };
  return null;
}

/** Which chain does a name-like text belong to (first in MT_CHAINS order)? */
export function chainByText(txt, R) {
  if (!txt) return null;
  const c = R.chains.find((x) => x.isName(txt));
  return c ? c.id : null;
}

/** Classify one OSM element by its tags (see the header and tools/seed/OSM-RULES.md §3 for the order of the steps). */
export function classifyOsm(t, R) {
  t = t || {};
  const g = R.g;
  const name = fold(first(t, g.nameKeys));
  // 1. Which chain: name, then brand, then brand:wikidata.
  let chain = chainByText(name, R), via = chain ? 'name' : null;
  if (!chain) { for (const k of g.brandKeys) { chain = chainByText(fold(t[k]), R); if (chain) { via = 'brand'; break; } } }
  if (!chain) {
    const q = g.wikidataKeys.flatMap((k) => qidsOf(t[k]));
    const c = R.chains.find((x) => x.qids.some((id) => q.includes(id)));
    if (c) { chain = c.id; via = g.wikidataKeys[0]; }
  }
  if (!chain) return { chain: null, reason: 'no chain pattern matches (broad scan hit)' };
  const C = R.byId[chain];
  const out = { chain, via };
  // 2. A name that names another business while only brand / Wikidata point to the chain.
  if (via !== 'name' && name && !g.genericName.test(name)) {
    return { ...out, kind: 'excluded', reason: `name "${first(t, g.nameKeys)}" is not the chain (only ${via} matches)` };
  }
  // 3. The mapper says it is not the chain.
  const notChain = g.notChainKeys.find((k) => t[k] && g.notChainText.test(fold(t[k])));
  if (notChain) return { ...out, kind: 'excluded', reason: `${notChain}="${t[notChain]}" says it is not the chain` };
  // 4. Closed.
  if (Object.keys(t).some((k) => g.lifecycleKey.test(k)) || g.closedShops.includes(t.shop) || g.closedStatus.test(fold(t.operational_status)) ||
      g.closedHours.test(fold(t.opening_hours)) || g.closedName.test(name)) {
    return { ...out, kind: 'closed', reason: `closed in OSM (${['operational_status', 'shop', 'opening_hours'].filter((k) => t[k]).map((k) => `${k}=${t[k]}`).join(' ') || 'lifecycle prefix / name'})` };
  }
  // 5. Not a store. A proper chain shop (format + brand / QID of the chain) survives a stray extra tag (e.g. leisure=* on a Tottus).
  const branded = C.qids.some((q) => g.wikidataKeys.some((k) => qidsOf(t[k]).includes(q))) || g.brandKeys.some((k) => t[k] && C.isName(fold(t[k])));
  const key = g.notStoreKeys.find((k) => t[k] !== undefined);
  if (key && !(branded && C.shops.includes(t.shop) && !g.hardKeys.includes(key))) {
    return { ...out, kind: 'excluded', reason: `non-store feature (${key}=${t[key]})` };
  }
  if (t.amenity && !g.amenityAllowed.includes(t.amenity)) return { ...out, kind: 'excluded', reason: `non-store feature (amenity=${t.amenity})` };
  if (g.notStoreName.test(name)) return { ...out, kind: 'excluded', reason: 'name marks a non-store feature' };
  for (const x of C.excludeTags) if (t[x.key] !== undefined && x.re.test(fold(t[x.key]))) return { ...out, kind: 'excluded', reason: `${x.key}=${t[x.key]}` };
  if (!t.shop && t.landuse && !g.landuseAllowed.includes(t.landuse)) return { ...out, kind: 'excluded', reason: `landuse=${t.landuse}` };
  if (!t.shop && t.building && g.badBuilding.has(t.building)) return { ...out, kind: 'excluded', reason: `building=${t.building}` };
  // 6. Doubtful position: confirms an official store, never supplies coordinates.
  const doubt = doubtfulPosition(t, R);
  if (doubt && t.shop && (C.shops.includes(t.shop) || g.genericShops.has(t.shop))) {
    return { ...out, kind: 'weak', noCoords: true, doubt, reason: `position doubtful in OSM: ${doubt.reason}; confirms an official store but never supplies its coordinates` };
  }
  // 7. Shops.
  if (t.shop) {
    const weakByName = C.weakName && C.weakName.test(name) && (!C.weakNameShops || C.weakNameShops.includes(t.shop));
    if (C.shops.includes(t.shop) && !weakByName) return { ...out, kind: 'shop' };
    if (weakByName) return { ...out, kind: 'weak', reason: `ambiguous name "${t.name}" (shop=${t.shop})` };
    if (g.genericShops.has(t.shop)) return { ...out, kind: 'weak', reason: `shop=${t.shop} is not a usual format of the chain` };
    const exactLabel = name === fold(C.label) || name === fold(C.name);
    if (C.unique && exactLabel) return { ...out, kind: 'weak', reason: `exact chain name on shop=${t.shop} (probably mis-tagged)` };
    return { ...out, kind: 'excluded', reason: `other business type (shop=${t.shop})` };
  }
  // 8. No shop tag: retail buildings / areas count for big formats only.
  const A = g.retail;
  const retailArea = A.amenity.includes(t.amenity) || A.building.includes(t.building) || A.keys.some((k) => t[k] !== undefined) || A.landuse.includes(t.landuse);
  if (!retailArea) return { ...out, kind: 'excluded', reason: 'no shop / retail tag' };
  if (C.building) return { ...out, kind: 'building' };
  return { ...out, kind: 'excluded', reason: 'building/area without shop tag (small formats need shop=*)' };
}
