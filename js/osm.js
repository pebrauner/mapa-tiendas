/* js/osm.js — MT.osm: OpenStreetMap scan (module M3).
 *
 * Finds the stores of the tracked chains in an area through the Overpass API and compares them
 * with the database (SPEC §4.1.2). Elements are judged with the SAME declarative rules as the seed
 * merge (tools/merge.mjs): the per-chain `osm` objects of window.MT_CHAINS and the cross-chain
 * window.MT_OSM_RULES, both published in data/chains.js (schema and step order:
 * tools/seed/OSM-RULES.md; reference code: tools/seed/osm-classify.mjs, ported line by line in
 * classifyTags below and checked against tools/seed/osm-rules-fixtures.json by the tests).
 *
 *   classification  {chain, via, kind:'shop'|'building'|'weak'|'closed'|'excluded', reason, noCoords, doubt}
 *   NEW        a shop/building of a chain with no store of the same chain within the chain's match
 *              radius (MT_OSM_RULES.radii big|dense .match) in the DB; a `weak` element (odd tagging)
 *              is proposed only flagged as doubtful (_weak, not pre-selected) and never when its
 *              position is doubtful (noCoords);
 *   MATCHED    the store is already in the DB (same OSM id, or same chain within the match radius;
 *              proper shops are matched before weak elements) — flagged "moved" when the DB
 *              position is more than 50 m away (never for noCoords elements);
 *   NOT FOUND  OSM-sourced DB stores inside the area that OSM no longer has, plus DB stores whose
 *              OSM element is now tagged closed (_closedInOsm). Never deleted automatically.
 *
 * API
 *   MT.osm.buildQuery({ubigeos | bbox, chains}) → Overpass QL string (one bbox; chains = ids)
 *   MT.osm.scan({ubigeos, chains}, {signal, onProgress}) → Promise<result>
 *       result = {new:[store], matched:[{store, osm, distance, moved, sameId, weak}], notFound:[store],
 *                 timestamp, endpoint, endpoints, queries, failedTiles, elements, stats, skippedChains,
 *                 area:{ubigeos}, chains, scannedAt}
 *       onProgress({phase:'query'|'retry'|'process', done, total, endpoint?, message?, waitS?})
 *   MT.osm.apply(selection, {notFoundStatus:'to_verify'|'closed'}) → Promise<{added, updated, ids}>
 *       selection = {new:[store], moved:[{store, osm}], notFound:[store]}
 *   Rules: fold(text), globalRules(), chainRules(chain), nameRegexFor(name), compile(chains?, G?),
 *   classifyTags(tags, compiled), nameVerdict(chainId, text, compiled), rules(chain), radii(chainId).
 *   Pipeline helpers (also used by the tests): toERE(jsRegex, {anchors}), classify(elements, chains,
 *   compiled), cluster(classified, compiled, prefer), elementToStore(entry, compiled), displayName(…),
 *   diff(osm, db, opts), planTiles(ubigeos), MATCH_METERS, MOVE_METERS.
 *
 * Network: only through MT.geo.overpass (one query at a time, endpoint fallback). Each tile is
 * retried twice after a pause when every endpoint fails, and split in four when Overpass reports
 * a timeout / out-of-memory remark.
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util;

  var MATCH_METERS = 120;   // fallback match radius (chains without rules radii)
  var MOVE_METERS = 50;     // matched but farther than this → offer "update position"
  var BASE_CELL = 2;        // degrees; tiles over sparse areas
  var MIN_CELL = 0.25;      // degrees; smallest tile when splitting dense areas
  var DENSE_DISTRICTS = 30; // a tile containing more district centres than this is split
  var MAX_SPLIT = 2;        // extra splits when Overpass times out
  var RETRY_WAITS = [5000, 15000];

  /* Built-in copy of tools/seed/osm-rules.json (version 1, without "about"). Used ONLY when
   * data/chains.js has no (valid) window.MT_OSM_RULES — an old file. The tests check that it equals
   * the published block, so it cannot drift silently. */
  var BUILTIN_RULES = {
    version: 1,
    doc: 'tools/seed/OSM-RULES.md',
    nameKeys: ['name', 'name:es'],
    brandKeys: ['brand'],
    wikidataKeys: ['brand:wikidata'],
    genericNameRegex: '^(?:supermercados?|supermarket|hipermercados?|minimarket|tienda|bodega)$',
    notChain: { keys: ['description', 'note', 'fixme', 'FIXME', 'comment', 'description:es', 'note:es'],
      textRegex: '\\bnot\\s+(?:the|a|part\\s+of\\s+(?:the|a))\\s+(?:chain|brand|franchise)\\b|\\bnot\\s+(?:related|affiliated)\\s+(?:to|with)\\b|\\bno\\s+(?:es|forma\\s+parte\\s+de|pertenece\\s+a)\\s+(?:la|una|de\\s+la)\\s+(?:cadena|marca|franquicia)\\b|\\bno\\s+(?:es\\s+)?(?:de\\s+)?la\\s+cadena\\b|\\bsin\\s+relacion\\s+con\\s+la\\s+(?:cadena|marca)\\b' },
    closed: { lifecycleKeyRegex: '^(?:disused|was|abandoned|removed|demolished|razed|closed|destroyed):(?:shop|amenity|name|brand)', shopValues: ['vacant', 'no'],
      operationalStatusRegex: '^(?:closed|abandoned|disused)$', openingHoursRegex: '^(?:closed|off)$', nameRegex: '\\b(?:cerrad[oa]|clausurad[oa]|closed)\\b' },
    notStore: {
      keys: ['railway', 'public_transport', 'highway', 'place', 'tourism', 'leisure', 'office', 'healthcare', 'historic', 'craft', 'man_made', 'natural',
        'aeroway', 'emergency', 'advertising', 'club', 'power', 'waterway', 'boundary', 'military', 'barrier', 'route', 'education'],
      keysEvenIfBranded: ['railway', 'public_transport', 'highway', 'place', 'advertising'],
      amenityAllowed: ['marketplace'],
      nameRegex: '\\b(?:estacionamientos?|parqueo|parking|paradero|puente|deck|cajeros?|agentes?|interbank|bcp|bbva|scotiabank|money\\s*market|al\\s+paso|chicken|eventos?|centro\\s+de\\s+distribucion|almacen(?:es)?|oficinas?|cochera|colegio|instituto|clinica|banco)\\b',
      landuseAllowedWithoutShop: ['retail', 'commercial'],
      buildingExcludedWithoutShop: ['residential', 'house', 'apartments', 'school', 'university', 'church', 'hospital', 'public', 'industrial', 'warehouse',
        'train_station', 'transportation', 'government', 'civic', 'office', 'hotel', 'garage', 'garages', 'roof', 'construction'],
    },
    doubtfulPosition: { schoolImportKeys: ['isced:level'], sourceRegex: 'minedu', fixmeKeys: ['fixme', 'FIXME'],
      positionWordsRegex: '\\b(?:posicion|posisicon|ubicacion|position|location|coordenadas|lugar\\s+correcto)\\b', noteKey: 'note',
      noteFixWordsRegex: '\\b(?:corregir|actualizar|verificar|revisar|incorrect[ao]?|wrong|approximate|aproximad[ao]|check)\\b' },
    genericShops: ['supermarket', 'convenience', 'general', 'yes', 'mall', 'department_store', 'variety_store', 'wholesale', 'hypermarket', 'discount',
      'grocery', 'food', 'kiosk', 'greengrocer', 'health_food', 'deli', 'organic'],
    retailArea: { amenity: ['marketplace'], building: ['retail', 'commercial', 'supermarket', 'yes', 'mall'], keys: ['building:part'], landuse: ['retail', 'commercial'] },
    entranceNameRegex: '\\b(?:entrada|ingreso|puerta)\\b',
    radii: { big: { dedupe: 200, link: 250, match: 250, match2: 600, geo: 1000 }, dense: { dedupe: 40, link: 80, match: 120, match2: 250, geo: 250 } },
  };

  var osm = (MT.osm = { MATCH_METERS: MATCH_METERS, MOVE_METERS: MOVE_METERS, BUILTIN_RULES: BUILTIN_RULES });

  /* ---- JS regex → POSIX ERE for Overpass --------------------------------------------------
   * Overpass filters with POSIX extended regular expressions; chain rules are JavaScript regexes
   * (\s, \b, (?:…), lookaheads…). The query only needs a BROADER-or-equal pre-filter — the exact
   * JS regex runs again client-side — so every construct ERE lacks is replaced by something that
   * matches at least as much:
   *   lookarounds (?=…) (?!…) (?<=…) (?<!…) → removed;  \b \B → removed;  \1 \p{…} \uXXXX → '.*' / '.{1,2}';
   *   \s \d \w → POSIX classes;  (?:…) (?<name>…) → (…);  lazy quantifiers → greedy;
   *   quotes, backslashes and non-ASCII never reach the output (no QL escaping; a C-locale regex
   *   sees UTF-8 bytes, so 'á' becomes '.{1,2}').
   * Returns '' when the regex cannot be converted safely; buildQuery then selects the chain's
   * shop types instead of filtering by name (broader, never narrower).
   * opts.anchors === false also drops ^ and $ (outside classes): the chain rules are tested on FOLDED
   * text (accents removed, white space collapsed) while Overpass sees the raw name, so an anchored
   * "^(?:super\s+)?metro" would miss "Súper Metro" — unanchored, "metro" anywhere passes (broader).
   */
  var BS = String.fromCharCode(92); // backslash (kept out of literals on purpose)
  var CLASS_ESC = { s: '[:space:]', d: '0-9', w: 'a-z0-9_' };
  var OUT_ESC = { s: '[[:space:]]', d: '[0-9]', w: '[a-z0-9_]', S: '[^[:space:]]', D: '[^0-9]', W: '[^a-z0-9_]', t: '[[:space:]]', n: '[[:space:]]', r: '[[:space:]]', f: '[[:space:]]', v: '[[:space:]]' };
  osm.toERE = function (src, opts) {
    var noAnchors = !!opts && opts.anchors === false;
    src = stripLookarounds(String(src || ''));
    if (src === null || !src) return '';
    var out = '', i = 0;
    while (i < src.length) {
      var ch = src[i];
      if (noAnchors && (ch === '^' || ch === '$')) { i++; continue; }
      if (ch === '[') {                                  // character class
        var j = i + 1, neg = '', body = '', dash = false, rb = false, wild = false;
        if (src[j] === '^') { neg = '^'; j++; }
        if (src[j] === ']') { rb = true; j++; }
        for (; j < src.length && src[j] !== ']'; j++) {
          var c = src[j];
          if (c === BS) {
            var e = src[++j];
            if (e === undefined) return '';
            if (CLASS_ESC[e] !== undefined) body += CLASS_ESC[e];
            else if (e === '-') dash = true;
            else if (e === ']') rb = true;
            else if (/[a-zA-Z0-9]/.test(e) || e === BS) wild = true;   // \p{L}, á, \\ … inside a class
            else if (e !== '"') body += e;
          } else if (c !== '"') body += c;
        }
        if (j >= src.length) return '';                    // unterminated class
        // Non-ASCII or unknown escapes inside a class: "any 1–2 characters" (broader).
        out += wild || /[^\x00-\x7F]/.test(body) ? '.{1,2}' : '[' + neg + (rb ? ']' : '') + body + (dash ? '-' : '') + ']';
        i = j + 1; continue;
      }
      if (ch === BS) {
        var c2 = src[i + 1];
        if (c2 === undefined) return '';
        if (c2 === 'b' || c2 === 'B') { i += 2; continue; }           // word boundary: broaden
        if (OUT_ESC[c2] !== undefined) { out += OUT_ESC[c2]; i += 2; continue; }
        if (/[1-9k]/.test(c2)) { out += '.*'; i += escLen(src, i); continue; }       // back-reference
        if (/[pPux]/.test(c2)) { out += '.{1,2}'; i += escLen(src, i); continue; }    // \p{L}, á, \x41
        if (c2 === BS || /[a-zA-Z0-9]/.test(c2)) { out += '.'; i += 2; continue; }   // other escapes: any char
        out += c2 === '"' ? '.' : c2 === '^' ? '[]^]' : c2 === ']' ? '[]]' : /[.+*?()[{}|$]/.test(c2) ? '[' + c2 + ']' : c2;
        i += 2; continue;
      }
      if (ch === '(' && src[i + 1] === '?') {
        if (src[i + 2] === ':') { out += '('; i += 3; continue; }
        var named = /^[(][?]<[A-Za-z_][A-Za-z0-9_]*>/.exec(src.slice(i));
        if (named) { out += '('; i += named[0].length; continue; }
        return '';                                          // (?i) flags and other extensions
      }
      if ((ch === '*' || ch === '+' || ch === '?' || ch === '}') && src[i + 1] === '?') { out += ch; i += 2; continue; } // lazy → greedy
      out += ch === '"' ? '.' : ch.charCodeAt(0) > 127 ? '.{1,2}' : ch;   // accented letter: 2 bytes in UTF-8
      i++;
    }
    // Lookaround removal can leave empty groups/alternatives ("()" or "a|"): harmless in ERE except "()".
    out = out.replace(/[(][)]/g, '');
    return out;
  };
  /** Length of an escape starting at i ("\1", "\k<n>", "\p{L}", "á", "\u{1F600}", "\x41"). */
  function escLen(s, i) {
    var c = s[i + 1], m;
    if (c === 'k' && (m = /^k<[^>]*>/.exec(s.slice(i + 1)))) return 1 + m[0].length;
    if ((c === 'p' || c === 'P') && (m = /^[pP][{][^}]*[}]/.exec(s.slice(i + 1)))) return 1 + m[0].length;
    if (c === 'u' && (m = /^u(?:[{][0-9a-fA-F]+[}]|[0-9a-fA-F]{4})/.exec(s.slice(i + 1)))) return 1 + m[0].length;
    if (c === 'x' && (m = /^x[0-9a-fA-F]{2}/.exec(s.slice(i + 1)))) return 1 + m[0].length;
    if (/[1-9]/.test(c) && (m = /^[0-9]+/.exec(s.slice(i + 1)))) return 1 + m[0].length;
    return 2;
  }
  /**
   * Remove (?=…) (?!…) (?<=…) (?<!…) groups (balanced, escapes and classes respected) and any
   * quantifier right after them. Returns null on unbalanced input.
   */
  function stripLookarounds(s) {
    var out = '', i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (ch === BS) { out += s.substr(i, 2); i += 2; continue; }
      if (ch === '[') {
        var j = i + 1;
        if (s[j] === '^') j++;
        if (s[j] === ']') j++;
        while (j < s.length && s[j] !== ']') j += s[j] === BS ? 2 : 1;
        if (j >= s.length) return null;
        out += s.slice(i, j + 1); i = j + 1; continue;
      }
      if (ch === '(' && /^[(][?](?:[=!]|<[=!])/.test(s.slice(i, i + 4))) {
        var depth = 0, k = i;
        for (; k < s.length; k++) {
          var c = s[k];
          if (c === BS) { k++; continue; }
          if (c === '[') { k++; if (s[k] === '^') k++; if (s[k] === ']') k++; while (k < s.length && s[k] !== ']') k += s[k] === BS ? 2 : 1; continue; }
          if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        if (k >= s.length) return null;
        i = k + 1;
        var q = /^(?:[?*+]|[{][0-9,]*[}])[?]?/.exec(s.slice(i));
        if (q) i += q[0].length;
        continue;
      }
      out += ch; i++;
    }
    return out;
  }

  /* ---- Rules -------------------------------------------------------------------------------- */
  // Text folding of OSM-RULES.md §1: NFD, combining marks removed, lower case, white space collapsed.
  var MARKS = (function () { try { return new RegExp('\\p{M}', 'gu'); } catch (e) { return new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g"); } })();
  var fold = (osm.fold = function (s) {
    return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();
  });
  function fold1(ch) { var f = ch.normalize('NFD').replace(MARKS, '').toLowerCase(); return f.length === 1 ? f : ch; }
  function rx(src) { return src ? new RegExp(src, 'iu') : null; }
  function qidsOf(v) { return String(v || '').split(/[;,\s]+/).filter(Boolean).map(function (q) { return q.toUpperCase(); }); }
  function strArr(v) { return Array.isArray(v) ? v.map(function (x) { return String(x === null || x === undefined ? '' : x).trim(); }).filter(Boolean) : []; }
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function validGlobal(G) {
    return !!G && typeof G === 'object' && Array.isArray(G.nameKeys) && Array.isArray(G.brandKeys) && Array.isArray(G.wikidataKeys) &&
      !!G.notChain && !!G.closed && !!G.notStore && !!G.doubtfulPosition && Array.isArray(G.genericShops) && !!G.retailArea && !!G.radii &&
      !!G.radii.big && !!G.radii.dense;
  }
  /** The cross-chain rules: window.MT_OSM_RULES as loaded from data/chains.js, else the built-in copy. */
  osm.globalRules = function () {
    var G = MT.data && MT.data.osmRules ? MT.data.osmRules() : window.MT_OSM_RULES;
    return validGlobal(G) ? G : BUILTIN_RULES;
  };
  /** 'file' when data/chains.js carries MT_OSM_RULES, 'builtin' when the built-in copy is used. */
  osm.globalRulesSource = function () { return osm.globalRules() === BUILTIN_RULES ? 'builtin' : 'file'; };

  /**
   * Conservative name rule for a chain without OSM rules: the folded chain name, anchored at the
   * start, words separated by optional spaces, ending on a word boundary.
   * "Economax Perú" → "^economax\s*peru(?![a-z0-9])".
   */
  osm.nameRegexFor = function (name) {
    var words = fold(name).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    return words.length ? '^' + words.join('\\s*') + '(?![a-z0-9])' : '';
  };

  /**
   * A chain's osm rules with every key of OSM-RULES.md §2 (defaults filled). A chain with neither a
   * name pattern nor Wikidata ids (e.g. added by the user) gets the conservative name rule of
   * nameRegexFor(name) — derived: true. Synthesized "unknown" chains get no rules at all.
   */
  osm.chainRules = function (chain) {
    var o = (chain && chain.osm) || {};
    var r = {
      wikidata: strArr(o.wikidata).map(function (q) { return q.toUpperCase(); }),
      nameRegex: typeof o.nameRegex === 'string' ? o.nameRegex.trim() : '',
      excludeNameRegex: typeof o.excludeNameRegex === 'string' ? o.excludeNameRegex.trim() : '',
      label: (typeof o.label === 'string' && o.label.trim()) || (chain && chain.name) || '',
      prefixRegex: typeof o.prefixRegex === 'string' ? o.prefixRegex.trim() : '',
      shops: strArr(o.shops).map(function (s) { return s.toLowerCase(); }),
      requireShopLike: o.requireShopLike !== false,
      dense: !!o.dense,
      uniqueName: !!o.uniqueName,
      weakNameRegex: typeof o.weakNameRegex === 'string' ? o.weakNameRegex.trim() : '',
      weakNameShops: strArr(o.weakNameShops).map(function (s) { return s.toLowerCase(); }),
      excludeTags: (Array.isArray(o.excludeTags) ? o.excludeTags : []).filter(function (x) { return x && String(x.key || '').trim(); })
        .map(function (x) { return { key: String(x.key).trim(), valueRegex: String(x.valueRegex || ''), why: String(x.why || '') }; }),
      derived: false,
    };
    if (chain && !chain.unknown && !r.nameRegex && !r.wikidata.length) {
      r.nameRegex = osm.nameRegexFor(chain.name || chain.id);
      r.derived = !!r.nameRegex;
    }
    return r;
  };

  function compileChain(c) {
    var o = osm.chainRules(c);
    var re = rx(o.nameRegex), ex = rx(o.excludeNameRegex);
    return {
      id: c.id, name: c.name, label: o.label || c.name,
      qids: o.wikidata.filter(function (q) { return /^Q\d+$/.test(q); }),
      re: re, ex: ex,
      /** The chain's name pattern: nameRegex matches and excludeNameRegex does not. */
      isName: function (txt) { return !!re && re.test(txt) && !(ex && ex.test(txt)); },
      prefix: rx(o.prefixRegex),
      shops: o.shops,
      // App extension (OSM-RULES.md §6): no shop types listed = any shop=* value is a format of the chain
      // (chains added by the user). Every seed chain lists its shop types.
      anyShop: !o.shops.length,
      building: o.requireShopLike === false,
      dense: !!o.dense,
      unique: !!o.uniqueName,
      weakName: rx(o.weakNameRegex),
      weakNameShops: o.weakNameShops.length ? o.weakNameShops : null,
      excludeTags: o.excludeTags.map(function (x) { return { key: x.key, re: rx(x.valueRegex) }; }),
      derived: o.derived,
    };
  }
  function compileGlobal(G) {
    return {
      src: G,
      nameKeys: G.nameKeys, brandKeys: G.brandKeys, wikidataKeys: G.wikidataKeys,
      genericName: rx(G.genericNameRegex),
      notChainKeys: G.notChain.keys || [], notChainText: rx(G.notChain.textRegex),
      lifecycleKey: rx(G.closed.lifecycleKeyRegex), closedShops: G.closed.shopValues || [],
      closedStatus: rx(G.closed.operationalStatusRegex), closedHours: rx(G.closed.openingHoursRegex), closedName: rx(G.closed.nameRegex),
      notStoreKeys: G.notStore.keys || [], hardKeys: G.notStore.keysEvenIfBranded || [], amenityAllowed: G.notStore.amenityAllowed || [],
      notStoreName: rx(G.notStore.nameRegex), landuseAllowed: G.notStore.landuseAllowedWithoutShop || [],
      badBuilding: G.notStore.buildingExcludedWithoutShop || [],
      dp: { keys: G.doubtfulPosition.schoolImportKeys || [], source: rx(G.doubtfulPosition.sourceRegex), fixmeKeys: G.doubtfulPosition.fixmeKeys || [],
        pos: rx(G.doubtfulPosition.positionWordsRegex), noteKey: G.doubtfulPosition.noteKey, fix: rx(G.doubtfulPosition.noteFixWordsRegex) },
      genericShops: G.genericShops,
      retail: { amenity: G.retailArea.amenity || [], building: G.retailArea.building || [], keys: G.retailArea.keys || [], landuse: G.retailArea.landuse || [] },
      entrance: rx(G.entranceNameRegex),
      radii: G.radii,
    };
  }
  var T = function (re, s) { return !!re && re.test(s); };   // a missing (empty) rule never fires

  /**
   * Compile chains (default: every registered chain, in MT.data.chains() order = data/chains.js
   * order, then local additions) + the cross-chain rules into matchers. A chain whose regex does
   * not compile is left out and listed in `errors` (the scan reports it as skipped).
   * → {chains:[…], byId:{}, g, errors:[{id, error}], source:'file'|'builtin'}
   */
  osm.compile = function (chains, G) {
    G = G || osm.globalRules();
    var g, source = G === BUILTIN_RULES ? 'builtin' : 'file';
    try { g = compileGlobal(G); } catch (e) { g = compileGlobal(BUILTIN_RULES); source = 'builtin'; }
    var list = [], errors = [];
    (chains || (MT.data && MT.data.chains ? MT.data.chains() : [])).forEach(function (c) {
      if (!c || c.unknown) return;
      try { list.push(compileChain(c)); } catch (e) { errors.push({ id: c.id, error: 'regex' }); }
    });
    var byId = {};
    list.forEach(function (c) { byId[c.id] = c; });
    return { chains: list, byId: byId, g: g, errors: errors, source: source };
  };

  function first(t, keys) { for (var i = 0; i < keys.length; i++) if (t[keys[i]]) return t[keys[i]]; return ''; }
  function chainByText(txt, R) {
    if (!txt) return null;
    for (var i = 0; i < R.chains.length; i++) if (R.chains[i].isName(txt)) return R.chains[i].id;
    return null;
  }
  function isFormat(C, shop) { return !!shop && (C.anyShop || C.shops.indexOf(shop) >= 0); }
  /** Doubtful OSM position (school imports re-tagged as shops, a fixme/note about the position). */
  function doubtfulPosition(t, R) {
    var d = R.g.dp, i;
    for (i = 0; i < d.keys.length; i++) {
      var k = d.keys[i];
      if (t[k] !== undefined) return { code: 'school-import', key: k, value: t[k], reason: k + '=' + t[k] + ' (school import re-tagged as a shop)' };
    }
    if (T(d.source, fold(t.source || ''))) return { code: 'school-source', key: 'source', value: t.source, reason: 'source=' + t.source + ' (school import)' };
    var fxRaw = d.fixmeKeys.map(function (k2) { return t[k2]; }).filter(Boolean);
    if (T(d.pos, fold(fxRaw.join(' ')))) return { code: 'fixme', key: 'fixme', value: fxRaw[0], reason: 'fixme="' + String(fxRaw[0]).slice(0, 80) + '"' };
    var nt = fold(t[d.noteKey]);
    if (T(d.pos, nt) && T(d.fix, nt)) return { code: 'note', key: d.noteKey, value: t[d.noteKey], reason: 'note="' + String(t[d.noteKey]).slice(0, 80) + '"' };
    return null;
  }
  function ext(o, more) { return Object.assign({}, o, more); }

  /**
   * Classify one OSM element by its tags — tools/seed/osm-classify.mjs classifyOsm, step for step
   * (OSM-RULES.md §4; the first rule that fires wins).
   * → {chain:null, reason} | {chain, via:'name'|'brand'|'brand:wikidata', kind, reason?, noCoords?, doubt?}
   */
  osm.classifyTags = function (t, R) {
    t = t || {};
    R = R || osm.compile();
    var g = R.g, i;
    var name = fold(first(t, g.nameKeys));
    // 1. Which chain: name, then brand, then brand:wikidata.
    var chain = chainByText(name, R), via = chain ? 'name' : null;
    if (!chain) {
      for (i = 0; i < g.brandKeys.length; i++) { chain = chainByText(fold(t[g.brandKeys[i]]), R); if (chain) { via = 'brand'; break; } }
    }
    if (!chain) {
      var q = [];
      g.wikidataKeys.forEach(function (k) { q = q.concat(qidsOf(t[k])); });
      for (i = 0; i < R.chains.length && !chain; i++) {
        if (R.chains[i].qids.some(function (id) { return q.indexOf(id) >= 0; })) { chain = R.chains[i].id; via = g.wikidataKeys[0]; }
      }
    }
    if (!chain) return { chain: null, reason: 'no chain pattern matches (broad scan hit)' };
    var C = R.byId[chain];
    var out = { chain: chain, via: via };
    // 2. A name that names another business while only brand / Wikidata point to the chain.
    if (via !== 'name' && name && !T(g.genericName, name)) {
      return ext(out, { kind: 'excluded', reason: 'name "' + first(t, g.nameKeys) + '" is not the chain (only ' + via + ' matches)' });
    }
    // 3. The mapper says it is not the chain.
    var notChain = g.notChainKeys.find(function (k) { return t[k] && T(g.notChainText, fold(t[k])); });
    if (notChain) return ext(out, { kind: 'excluded', reason: notChain + '="' + t[notChain] + '" says it is not the chain' });
    // 4. Closed.
    if (Object.keys(t).some(function (k) { return T(g.lifecycleKey, k); }) || g.closedShops.indexOf(t.shop) >= 0 || T(g.closedStatus, fold(t.operational_status)) ||
        T(g.closedHours, fold(t.opening_hours)) || T(g.closedName, name)) {
      var tags = ['operational_status', 'shop', 'opening_hours'].filter(function (k) { return t[k]; }).map(function (k) { return k + '=' + t[k]; }).join(' ');
      return ext(out, { kind: 'closed', reason: 'closed in OSM (' + (tags || 'lifecycle prefix / name') + ')' });
    }
    // 5. Not a store. A proper chain shop (format + brand / QID of the chain) survives a stray extra tag.
    var branded = C.qids.some(function (qq) { return g.wikidataKeys.some(function (k) { return qidsOf(t[k]).indexOf(qq) >= 0; }); }) ||
      g.brandKeys.some(function (k) { return t[k] && C.isName(fold(t[k])); });
    var key = g.notStoreKeys.find(function (k) { return t[k] !== undefined; });
    if (key && !(branded && isFormat(C, t.shop) && g.hardKeys.indexOf(key) < 0)) {
      return ext(out, { kind: 'excluded', reason: 'non-store feature (' + key + '=' + t[key] + ')' });
    }
    if (t.amenity && g.amenityAllowed.indexOf(t.amenity) < 0) return ext(out, { kind: 'excluded', reason: 'non-store feature (amenity=' + t.amenity + ')' });
    if (T(g.notStoreName, name)) return ext(out, { kind: 'excluded', reason: 'name marks a non-store feature' });
    for (i = 0; i < C.excludeTags.length; i++) {
      var x = C.excludeTags[i];
      // An empty value pattern = the key alone excludes (app extension; the seed rules always set one).
      if (t[x.key] !== undefined && (!x.re || x.re.test(fold(t[x.key])))) return ext(out, { kind: 'excluded', reason: x.key + '=' + t[x.key] });
    }
    if (!t.shop && t.landuse && g.landuseAllowed.indexOf(t.landuse) < 0) return ext(out, { kind: 'excluded', reason: 'landuse=' + t.landuse });
    if (!t.shop && t.building && g.badBuilding.indexOf(t.building) >= 0) return ext(out, { kind: 'excluded', reason: 'building=' + t.building });
    // 6. Doubtful position: confirms a store, never supplies coordinates.
    var doubt = doubtfulPosition(t, R);
    if (doubt && t.shop && (isFormat(C, t.shop) || g.genericShops.indexOf(t.shop) >= 0)) {
      return ext(out, { kind: 'weak', noCoords: true, doubt: doubt, reason: 'position doubtful in OSM: ' + doubt.reason + '; confirms an official store but never supplies its coordinates' });
    }
    // 7. Shops.
    if (t.shop) {
      var weakByName = T(C.weakName, name) && (!C.weakNameShops || C.weakNameShops.indexOf(t.shop) >= 0);
      if (isFormat(C, t.shop) && !weakByName) return ext(out, { kind: 'shop' });
      if (weakByName) return ext(out, { kind: 'weak', reason: 'ambiguous name "' + t.name + '" (shop=' + t.shop + ')' });
      if (g.genericShops.indexOf(t.shop) >= 0) return ext(out, { kind: 'weak', reason: 'shop=' + t.shop + ' is not a usual format of the chain' });
      var exactLabel = name === fold(C.label) || name === fold(C.name);
      if (C.unique && exactLabel) return ext(out, { kind: 'weak', reason: 'exact chain name on shop=' + t.shop + ' (probably mis-tagged)' });
      return ext(out, { kind: 'excluded', reason: 'other business type (shop=' + t.shop + ')' });
    }
    // 8. No shop tag: retail buildings / areas count for big formats only.
    var A = g.retail;
    var retailArea = A.amenity.indexOf(t.amenity) >= 0 || A.building.indexOf(t.building) >= 0 || A.keys.some(function (k) { return t[k] !== undefined; }) || A.landuse.indexOf(t.landuse) >= 0;
    if (!retailArea) return ext(out, { kind: 'excluded', reason: 'no shop / retail tag' });
    if (C.building) return ext(out, { kind: 'building' });
    return ext(out, { kind: 'excluded', reason: 'building/area without shop tag (small formats need shop=*)' });
  };

  /**
   * How a store name reads for a chain (the Cadenas tab tester): 'match' | 'excluded' (nameRegex
   * matches but excludeNameRegex removes it) | 'weak' (weakNameRegex) | 'other' (another chain's
   * pattern claims it first) | 'none'. Tested on fold(text), like the scan.
   */
  osm.nameVerdict = function (chainOrRules, text, R) {
    var C = chainOrRules && chainOrRules.isName ? chainOrRules : compileChain(chainOrRules);
    var f = fold(text);
    if (!f) return { verdict: 'none', folded: f };
    if (!C.re || !C.re.test(f)) return { verdict: 'none', folded: f };
    if (C.ex && C.ex.test(f)) return { verdict: 'excluded', folded: f };
    if (R) { var owner = chainByText(f, R); if (owner && owner !== C.id) return { verdict: 'other', chain: owner, folded: f }; }
    if (C.weakName && C.weakName.test(f)) return { verdict: 'weak', folded: f };
    return { verdict: 'match', folded: f };
  };

  /**
   * Overpass-side summary of a chain's rules: {id, re, ex, ere, qids, shops, usable, derived, error?}.
   * `ere` is the BROADER pre-filter (toERE without anchors); exclusions never go into the query.
   */
  osm.rules = function (chain) {
    var r = { id: chain && chain.id, re: null, ex: null, ere: '', qids: [], shops: [], usable: false, derived: false };
    if (!chain || chain.unknown) return r;
    var o = osm.chainRules(chain);
    r.derived = o.derived;
    try {
      r.re = rx(o.nameRegex); r.ex = rx(o.excludeNameRegex);
      rx(o.prefixRegex); rx(o.weakNameRegex);
      o.excludeTags.forEach(function (x) { rx(x.valueRegex); });
    } catch (e) { r.error = 'regex'; r.re = null; r.ex = null; return r; }
    if (r.re) r.ere = osm.toERE(o.nameRegex, { anchors: false });
    r.qids = o.wikidata.filter(function (q) { return /^Q\d+$/.test(q); });
    r.shops = o.shops;
    r.usable = !!(r.re || r.qids.length);
    return r;
  };

  /** Dedupe / link / match radii (metres) of a chain: MT_OSM_RULES.radii.dense for dense chains, else .big. */
  osm.radii = function (chainId, R) {
    R = R || osm.compile();
    var C = R.byId[chainId];
    return (C && C.dense) || !C ? R.g.radii.dense : R.g.radii.big;
  };

  /* ---- Elements → stores ----------------------------------------------------------------------- */
  /**
   * Classify raw Overpass elements → [{key, type, osmId, chainId, via, kind, reason, noCoords, doubt,
   * lat, lng, tags}] for the given chains (ids or chain objects; default all), keeping the kinds the
   * scan uses (shop, building, weak, closed). Every registered chain takes part in deciding WHICH chain
   * an element is (an element named "Metro" is never a Wong just because only Wong was scanned).
   * `stats` (non-enumerable on the array) counts every kind, plus `excluded`.
   */
  osm.classify = function (elements, chains, R) {
    R = R || osm.compile();
    var want = null;
    if (chains) { want = {}; chains.forEach(function (c) { want[typeof c === 'string' ? c : c.id] = true; }); }
    var out = [], seen = {}, stats = { shop: 0, building: 0, weak: 0, closed: 0, excluded: 0 };
    (elements || []).forEach(function (el) {
      if (!el || !el.type || !el.tags) return;
      var key = el.type[0] + el.id;
      if (seen[key]) return;
      var lat = el.lat !== undefined ? el.lat : el.center && el.center.lat;
      var lng = el.lon !== undefined ? el.lon : el.lng !== undefined ? el.lng : el.center && (el.center.lon !== undefined ? el.center.lon : el.center.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      var c = osm.classifyTags(el.tags, R);
      if (!c.chain || (want && !want[c.chain])) return;
      seen[key] = true;
      stats[c.kind]++;
      if (c.kind === 'excluded') return;
      out.push({ key: key, type: el.type, osmId: el.id, chainId: c.chain, via: c.via, kind: c.kind, reason: c.reason || '', noCoords: !!c.noCoords,
        doubt: c.doubt || null, lat: +lat, lng: +lng, tags: el.tags });
    });
    Object.defineProperty(out, 'stats', { value: stats, enumerable: false });
    return out;
  };

  /** Union-find clusters of n items (tools/merge.mjs `clusters`). */
  function clusters(n, linked) {
    var p = [], i, j;
    for (i = 0; i < n; i++) p.push(i);
    var find = function (k) { while (p[k] !== k) { p[k] = p[p[k]]; k = p[k]; } return k; };
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) if (linked(i, j)) { var a = find(i), b = find(j); if (a !== b) p[Math.max(a, b)] = Math.min(a, b); }
    var groups = [], at = {};
    for (i = 0; i < n; i++) { var r = find(i); if (!(r in at)) { at[r] = groups.length; groups.push([]); } groups[at[r]].push(i); }
    return groups;
  }
  var dist = function (a, b) { return MT.geo.distanceMeters(a, b); };

  /**
   * Collapse same-chain OSM duplicates like the seed merge (node + building way, "entrada 1/2"
   * nodes): single-linkage within the chain's `dedupe` radius, or within `link` when one of the two
   * is a building or the element types differ (big formats only). The representative is, in order:
   * an element already in the database (`prefer(id)`), then the seed's score (shop kind, the chain's
   * QID, node > way, number of tags, not an entrance), then the key. Address / branch tags of the
   * other members fill the representative's gaps. Weak elements within `link` of an accepted store
   * are absorbed by it; the others stay separate (kind 'weak'). Closed elements pass through.
   * classified: osm.classify output → [{…rep fields, kind, members:[keys], tags (merged)}]
   */
  osm.cluster = function (classified, R, prefer) {
    R = R || osm.compile();
    prefer = prefer || function () { return false; };
    var out = [];
    var byChain = {};
    classified.forEach(function (x) { (byChain[x.chainId] = byChain[x.chainId] || []).push(x); });
    Object.keys(byChain).forEach(function (cid) {
      var C = R.byId[cid], all = byChain[cid];
      var r = osm.radii(cid, R), big = !(C && C.dense);
      var score = function (x) {
        var t = x.tags;
        return (x.kind === 'shop' ? 1000 : 0) + ((C ? C.qids : []).some(function (q) { return qidsOf(t['brand:wikidata']).indexOf(q) >= 0; }) ? 100 : 0) +
          (x.type === 'node' ? 50 : x.type === 'way' ? 20 : 0) + Math.min(40, Object.keys(t).length) - (T(R.g.entrance, fold(t.name)) ? 30 : 0);
      };
      var list = all.filter(function (x) { return x.kind === 'shop' || x.kind === 'building'; }).sort(function (a, b) { return cmpStr(a.key, b.key); });
      var groups = clusters(list.length, function (i, j) {
        var a = list[i], b = list[j], d = dist(a, b);
        return d <= r.dedupe || ((a.kind === 'building' || b.kind === 'building' || a.type !== b.type) && d <= r.link && big);
      });
      var stores = groups.map(function (g) {
        var members = g.map(function (i) { return list[i]; }).sort(function (a, b) {
          return (prefer('osm-' + b.key) - prefer('osm-' + a.key)) || (score(b) - score(a)) || cmpStr(a.key, b.key);
        });
        var rep = members[0];
        var tags = Object.assign({}, rep.tags);
        members.slice(1).forEach(function (m) {
          Object.keys(m.tags).forEach(function (k) { if (/^addr:|^branch$|^name:es$|^operator$/.test(k) && !tags[k]) tags[k] = m.tags[k]; });
        });
        return Object.assign({}, rep, { tags: tags, members: members.map(function (m) { return m.key; }) });
      }).sort(function (a, b) { return cmpStr(a.key, b.key); });
      all.filter(function (x) { return x.kind === 'weak'; }).sort(function (a, b) { return cmpStr(a.key, b.key); }).forEach(function (x) {
        var host = null, best = Infinity;
        stores.forEach(function (o) { var d = dist(o, x); if (d <= r.link && d < best) { best = d; host = o; } });
        if (host) host.members.push(x.key);
        else stores.push(Object.assign({}, x, { members: [x.key] }));
      });
      all.filter(function (x) { return x.kind === 'closed'; }).forEach(function (x) { stores.push(Object.assign({}, x, { members: [x.key] })); });
      out = out.concat(stores);
    });
    return out;
  };

  var LOWER_WORDS = ['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'con', 'a', 'al', 'o'];
  function titleCase(s) {
    return String(s).toLowerCase().split(/(\s+|-|\/|\()/).map(function (w, i) {
      if (!w || /^\s+$|^[-/(]$/.test(w)) return w;
      if (i > 0 && LOWER_WORDS.indexOf(w) >= 0) return w;
      if (/^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$/i.test(w)) return w.toUpperCase();
      if (/\d/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join('');
  }
  var isAllCaps = function (s) { return /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s); };
  var isAllLower = function (s) { return /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s); };
  /**
   * "Chain label + branch" store name like the seed (tools/merge.mjs displayName, without its
   * Tambo-specific branch parser): the chain part (prefixRegex) is replaced by the chain's label,
   * generic words and entrance numbers are dropped, ALL-CAPS branches are title-cased.
   * "HIPERMERCADOS TOTTUS ANGAMOS" → "Tottus Angamos".
   */
  osm.displayName = function (chainId, raw, R) {
    R = R || osm.compile();
    var C = R.byId[chainId];
    var label = C ? C.label : MT.data.chain(chainId).name;
    var s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return label;
    if (!C) return s;
    var chars = Array.from(s), folded = chars.map(fold1).join('');
    var rest = s, pre = C.prefix || C.re;   // chains without prefixRegex: their (anchored) name rule
    if (folded.length === chars.length && pre) {
      var m = pre.exec(folded);
      if (m && m.index === 0) rest = chars.slice(m[0].length).join('');
    }
    rest = rest.replace(/^[\s\-–—:|,.+&]+/, '').trim();
    for (var k = 0; k < 3; k++) {
      rest = rest.replace(/^(?:supermercados?|hipermercados?|supermarket|minimarket|mini market|tiendas?|cencosud|hiper\s*bodega|de)\b[\s\-–,]*/i, '')
        .replace(/[\s\-–,]*\b(?:supermercados?|hipermercados?|supermarket|cencosud|s\.?a\.?c?\.?)$/i, '').trim();
    }
    rest = rest.replace(/\b(?:entrada|ingreso|puerta)\s*\d*\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (isAllCaps(rest) || isAllLower(rest)) rest = titleCase(rest);
    if (rest && fold(rest).indexOf(fold(label)) === 0) return rest;   // already "Label …"
    return rest ? label + ' ' + rest : label;
  };

  function addressOf(t) {
    if (t['addr:full']) return t['addr:full'];
    var street = t['addr:street'] || t['addr:place'] || '';
    return [street, t['addr:housenumber'] || ''].filter(Boolean).join(' ').trim();
  }
  /** Best raw name of an OSM store (tools/merge.mjs bestOsmName): the longest display name. */
  function bestName(chainId, t, R) {
    var C = R.byId[chainId];
    var label = C ? C.label : MT.data.chain(chainId).name;
    var cands = [t.name, t['name:es'], t.official_name, t.branch ? label + ' ' + t.branch : null,
      C && t.operator && C.isName(fold(t.operator)) ? t.operator : null].filter(Boolean).map(function (n) { return osm.displayName(chainId, n, R); });
    cands.sort(function (a, b) { return b.length - a.length || cmpStr(a, b); });
    return cands[0] || label;
  }

  /**
   * Proposed DB record for a classified element / cluster entry (status to_verify, source osm,
   * precision exact) + scan fields: _kind, _weak, _noCoords, _closed, _reason, _members (OSM keys).
   */
  osm.elementToStore = function (el, chainIdOrR, R) {
    if (chainIdOrR && typeof chainIdOrR === 'object') { R = chainIdOrR; chainIdOrR = null; }
    R = R || osm.compile();
    var chain = MT.data.chain(chainIdOrR || el.chainId);
    var t = el.tags || {};
    var s = {
      id: 'osm-' + el.key, chain: chain.id, name: bestName(chain.id, t, R), address: addressOf(t),
      district: '', province: '', department: '', ubigeo: '',
      lat: U.round(+el.lat, 6), lng: U.round(+el.lng, 6), precision: 'exact', source: 'osm', source_ref: el.key,
      status: 'to_verify', notes: '', updated: U.todayISO(),
    };
    var d = MT.data.districts.locate(s.lat, s.lng);
    if (d) { s.ubigeo = d.ubigeo; s.district = d.district; s.province = d.province; s.department = d.department; }
    s._kind = el.kind || 'shop';
    s._weak = s._kind === 'weak';
    s._noCoords = !!el.noCoords;
    s._closed = s._kind === 'closed';
    s._reason = el.reason || '';
    s._members = el.members ? el.members.slice() : [el.key];
    return s;
  };

  /**
   * Compare proposed OSM stores with DB stores of the same area/chains.
   * osmStores: proposed records (elementToStore); dbStores: DB records (any source, any status).
   * opts: {matchMeters (default: the chain's radii.match), moveMeters, excludeNotFound(store) → bool, compiled}
   * → {new:[store + _nearest], matched:[{store, osm, distance, moved, sameId, weak}], notFound:[store]}
   */
  osm.diff = function (osmStores, dbStores, opts) {
    opts = opts || {};
    var R = opts.compiled || osm.compile();
    var moveM = opts.moveMeters || MOVE_METERS;
    var matchFor = function (chainId) { return opts.matchMeters || (R.byId[chainId] ? osm.radii(chainId, R).match : MATCH_METERS); };
    var db = dbStores.slice();
    var byId = {}, byRef = {};
    db.forEach(function (s) { byId[s.id] = s; if (s.source === 'osm' && s.source_ref) byRef[s.source_ref] = s; });
    var usedDb = {}, usedOsm = {};
    var matched = [], closedHits = [];
    // 1. Same OSM element already in the DB (id osm-n123 or source_ref n123; any member of a cluster).
    osmStores.forEach(function (o) {
      var keys = o._members && o._members.length ? o._members : [o.source_ref];
      var s = null;
      keys.some(function (k) { var c = byId['osm-' + k] || byRef[k]; if (c && !usedDb[c.id]) { s = c; return true; } return false; });
      if (!s && byId[o.id] && !usedDb[o.id]) s = byId[o.id];
      if (!s) return;
      usedDb[s.id] = true; usedOsm[o.id] = true;
      // A closed OSM element: the store it represents goes to "not found" (unless already closed).
      if (o._closed) { if (s.status !== 'closed') closedHits.push(Object.assign({}, s, { _closedInOsm: true, _osmRef: o.source_ref })); return; }
      var d = dist(s, o);
      matched.push({ store: s, osm: o, distance: d, moved: d > moveM && !o._noCoords, sameId: true, weak: !!o._weak });
    });
    // 2. Nearest same-chain store within the chain's match radius (greedy by distance → stable
    //    one-to-one): proper shops/buildings first, then weak elements. Closed elements never match.
    [false, true].forEach(function (weakPass) {
      var pairs = [];
      osmStores.forEach(function (o) {
        if (usedOsm[o.id] || o._closed || !!o._weak !== weakPass) return;
        var mm = matchFor(o.chain);
        db.forEach(function (s) {
          if (usedDb[s.id] || s.chain !== o.chain || !isFinite(s.lat)) return;
          var d = dist(s, o);
          if (d <= mm) pairs.push({ o: o, s: s, d: d });
        });
      });
      pairs.sort(function (a, b) { return a.d - b.d || (a.o.id < b.o.id ? -1 : 1); });
      pairs.forEach(function (p) {
        if (usedOsm[p.o.id] || usedDb[p.s.id]) return;
        usedOsm[p.o.id] = true; usedDb[p.s.id] = true;
        matched.push({ store: p.s, osm: p.o, distance: p.d, moved: p.d > moveM && !p.o._noCoords, sameId: false, weak: !!p.o._weak });
      });
    });
    // 3. The rest is new (never a closed element, never one whose position OSM itself doubts);
    //    remember the nearest same-chain store for the review screen.
    var fresh = osmStores.filter(function (o) { return !usedOsm[o.id] && !o._closed && !o._noCoords; }).map(function (o) {
      var near = null;
      db.forEach(function (s) {
        if (s.chain !== o.chain || !isFinite(s.lat) || s.status === 'closed') return;
        var d = dist(s, o);
        if (!near || d < near.distance) near = { id: s.id, name: s.name, distance: d };
      });
      var copy = Object.assign({}, o);
      copy._nearest = near;
      return copy;
    });
    var notFound = db.filter(function (s) {
      return !usedDb[s.id] && s.source === 'osm' && s.status !== 'closed' && !(opts.excludeNotFound && opts.excludeNotFound(s));
    }).concat(closedHits);
    var byName = function (a, b) { return U.compare(MT.data.chain(a.chain).name, MT.data.chain(b.chain).name) || U.compare(a.name, b.name) || (a.id < b.id ? -1 : 1); };
    fresh.sort(function (a, b) { return (a._weak - b._weak) || byName(a, b); });
    notFound.sort(byName);
    matched.sort(function (a, b) { return (b.moved - a.moved) || byName(a.store, b.store); });
    return { new: fresh, matched: matched, notFound: notFound };
  };

  /* ---- Area tiling ------------------------------------------------------------------------- */
  /**
   * Tiles (bboxes [w,s,e,n]) covering the districts: a 2° grid clipped to the area, keeping
   * cells that touch a district, splitting cells that hold many district centres (cities) down to
   * 0.25° so each Overpass query stays small.
   */
  osm.planTiles = function (ubigeos) {
    var D = MT.data.districts;
    var boxes = (ubigeos || []).map(D.bbox).filter(Boolean);
    if (!boxes.length) return [];
    var area = MT.geo.bboxUnion(boxes);
    var centres = boxes.map(function (b) { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; });
    var touches = function (c) { return boxes.some(function (b) { return b[0] <= c[2] && b[2] >= c[0] && b[1] <= c[3] && b[3] >= c[1]; }); };
    var count = function (c) { return centres.filter(function (p) { return p[0] >= c[0] && p[0] < c[2] && p[1] >= c[1] && p[1] < c[3]; }).length; };
    var out = [];
    function refine(c) {
      if (!touches(c)) return;
      var size = Math.max(c[2] - c[0], c[3] - c[1]);
      if (size > MIN_CELL * 1.01 && count(c) > DENSE_DISTRICTS) { split4(c).forEach(refine); return; }
      out.push(c.map(function (v) { return U.round(v, 6); }));
    }
    var nx = Math.max(1, Math.ceil((area[2] - area[0]) / BASE_CELL - 1e-9));
    var ny = Math.max(1, Math.ceil((area[3] - area[1]) / BASE_CELL - 1e-9));
    var dx = (area[2] - area[0]) / nx, dy = (area[3] - area[1]) / ny;
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        refine([area[0] + i * dx, area[1] + j * dy, i === nx - 1 ? area[2] : area[0] + (i + 1) * dx, j === ny - 1 ? area[3] : area[1] + (j + 1) * dy]);
      }
    }
    return out;
  };
  function split4(c) {
    var mx = (c[0] + c[2]) / 2, my = (c[1] + c[3]) / 2;
    return [[c[0], c[1], mx, my], [mx, c[1], c[2], my], [c[0], my, mx, c[3]], [mx, my, c[2], c[3]]];
  }

  /* ---- Query ------------------------------------------------------------------------------- */
  function fmtBbox(b) { return [b[1], b[0], b[3], b[2]].map(function (v) { return (+v).toFixed(5); }).join(','); }
  function ereLiteral(s) { return String(s).replace(/[^a-z0-9_:-]/gi, '.'); }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

  /**
   * Overpass QL for one bbox, built from the rules (OSM-RULES.md §1): every element that has one of
   * the keys the classifier reads (MT_OSM_RULES.nameKeys + brandKeys, then wikidataKeys) inside the
   * bbox, filtered in memory by the chains' name patterns (toERE without anchors: a BROADER pre-filter
   * than the folded, anchored client-side test) and their Wikidata ids. Exclusions, closed shops,
   * non-stores… are decided client-side (classifyTags) — they would only narrow the query.
   * Key-then-regex is much faster on Overpass than a regex combined with the bbox (tools/scan-osm.mjs).
   */
  osm.buildQuery = function (opts) {
    opts = opts || {};
    var bbox = opts.bbox || MT.data.districts.unionBbox(opts.ubigeos || []);
    if (!bbox) throw new Error('osm-no-area');
    var R = opts.compiled || osm.compile();
    var rules = (opts.chains || MT.data.chains().map(function (c) { return c.id; }))
      .map(function (id) { return osm.rules(MT.data.chain(id)); }).filter(function (r) { return r.usable; });
    if (!rules.length) throw new Error('osm-no-rules');
    var g = R.g;
    var bb = '(' + fmtBbox(bbox) + ')';
    var textKeys = uniq(g.nameKeys.concat(g.brandKeys));
    var sel = textKeys.concat(g.wikidataKeys).map(function (k) { return '  nwr["' + k + '"]' + bb + ';'; });
    var eres = uniq(rules.filter(function (r) { return r.ere; }).map(function (r) { return r.ere; }));
    var flt = [];
    if (eres.length) {
      var re = eres.join('|');
      textKeys.forEach(function (k) { flt.push('  nwr.all["' + k + '"~"' + re + '",i];'); });
    }
    // A name rule that cannot be expressed in ERE: fetch the chain's shop types instead (any shop when none).
    rules.filter(function (r) { return r.re && !r.ere; }).forEach(function (r) {
      flt.push(r.shops.length ? '  nwr.all["shop"~"^(' + r.shops.map(ereLiteral).join('|') + ')$"];' : '  nwr.all["shop"];');
    });
    var qids = [];
    rules.forEach(function (r) { r.qids.forEach(function (q) { if (qids.indexOf(q) < 0) qids.push(q); }); });
    if (qids.length) {
      var q = '(' + qids.join('|') + ')([^0-9]|$)';
      g.wikidataKeys.forEach(function (k) { flt.push('  nwr.all["' + k + '"~"' + q + '"];'); });
    }
    return [
      '[out:json][timeout:' + (opts.timeout || 120) + '][maxsize:268435456];',
      '(\n' + sel.join('\n') + '\n)->.all;',
      '(\n' + flt.join('\n') + '\n)->.m;',
      '.m out center tags;',
    ].join('\n');
  };

  /* ---- Scan -------------------------------------------------------------------------------- */
  function tooBig(json) {
    return json && json.remark && /runtime error|timed out|out of memory|maxsize/i.test(json.remark);
  }

  /**
   * Elements → proposals → diff (the client-side part of a scan, also used by the tests on the
   * seed's raw elements). opts: {chains:[ids], ubigeos:[…] (area filter; omitted = keep all),
   * db:[stores] (default: DB stores of those chains in the area), excludeNotFound, compiled}
   * → {new, matched, notFound, proposals, stats}
   * A proposal is in the area when its position falls in one of the districts — or when it is the
   * OSM element of a DB store of the area (district polygons are simplified in the app: a store on a
   * boundary must not turn into "not found" here and "new" next door).
   */
  osm.process = function (elements, opts) {
    opts = opts || {};
    var R = opts.compiled || osm.compile();
    var chainIds = opts.chains || R.chains.map(function (c) { return c.id; });
    var set = null;
    if (opts.ubigeos) { set = {}; opts.ubigeos.forEach(function (u) { set[u] = true; }); }
    var chainSet = {};
    chainIds.forEach(function (c) { chainSet[c] = true; });
    var db = opts.db || MT.data.stores({ includeClosed: true }).filter(function (s) {
      if (!chainSet[s.chain]) return false;
      if (!set) return true;
      var u = s.ubigeo || ((MT.data.districts.locate(s.lat, s.lng) || {}).ubigeo);
      return !!set[u];
    });
    var dbRef = {};
    db.forEach(function (s) { dbRef[s.id] = true; if (s.source === 'osm' && s.source_ref) dbRef['osm-' + s.source_ref] = true; });
    var inDb = opts.db ? function (id) { return !!dbRef[id]; } : function (id) { return !!(MT.data.store && MT.data.store(id)); };
    var classified = osm.classify(elements, chainIds, R);
    var proposals = osm.cluster(classified, R, inDb).map(function (x) { return osm.elementToStore(x, R); })
      .filter(function (s) { return !set || set[s.ubigeo] || s._members.some(function (k) { return dbRef['osm-' + k]; }); });
    var d = osm.diff(proposals, db, { excludeNotFound: opts.excludeNotFound, compiled: R });
    return { new: d.new, matched: d.matched, notFound: d.notFound, proposals: proposals, stats: classified.stats };
  };

  /**
   * Scan an area. area = {ubigeos:[…], chains:[ids]}. Resolves the diff against the DB.
   * Rejects Error('osm-no-area' | 'osm-no-rules' | 'overpass-unavailable' (details)) or AbortError.
   */
  osm.scan = function (area, opts) {
    opts = opts || {};
    var signal = opts.signal;
    var progress = opts.onProgress || function () {};
    var ubigeos = (area && area.ubigeos || []).filter(function (u) { return MT.data.districts.get(u); });
    if (!ubigeos.length) return Promise.reject(new Error('osm-no-area'));
    var R = osm.compile();
    var chainIds = (area.chains && area.chains.length ? area.chains : MT.data.chains().map(function (c) { return c.id; }));
    var usable = [], skipped = [];
    chainIds.forEach(function (id) { (osm.rules(MT.data.chain(id)).usable && R.byId[id] ? usable : skipped).push(id); });
    if (!usable.length) return Promise.reject(new Error('osm-no-rules'));

    var queue = osm.planTiles(ubigeos).map(function (b) { return { bbox: b, depth: 0 }; });
    var total = queue.length, done = 0;
    var elements = [], seenEl = {}, endpoints = {}, timestamp = null, endpoint = null, failed = [], queries = 0;

    // One tile = one Overpass query; `done` counts finished leaf tiles (splits add tiles).
    function runTile(tile, attempt) {
      if (signal && signal.aborted) return Promise.reject(MT.geo.abortError());
      progress({ phase: 'query', done: done, total: total, attempt: attempt });
      queries++;
      return MT.geo.overpass(osm.buildQuery({ bbox: tile.bbox, chains: usable, compiled: R }), {
        signal: signal, timeoutMs: opts.timeoutMs || 180000,
        onStatus: function (st) { progress({ phase: st.state === 'failed' ? 'endpointFailed' : 'query', done: done, total: total, endpoint: st.endpoint, error: st.error }); },
      }).then(function (r) {
        if (tooBig(r.json)) { var e = new Error('overpass-too-big'); e.tooBig = true; throw e; }
        endpoints[r.endpoint] = true; endpoint = r.endpoint;
        if (r.timestamp && (!timestamp || r.timestamp < timestamp)) timestamp = r.timestamp; // oldest = honest
        (r.json.elements || []).forEach(function (el) {
          var k = el.type + el.id;
          if (!seenEl[k]) { seenEl[k] = true; elements.push(el); }
        });
        done++;
      }).catch(function (err) {
        if (err && err.name === 'AbortError') throw err;
        if (err && err.tooBig && tile.depth < MAX_SPLIT) {
          var parts = split4(tile.bbox).map(function (b) { return { bbox: b, depth: tile.depth + 1 }; });
          total += parts.length - 1;
          return parts.reduce(function (p, t) { return p.then(function () { return runTile(t, 0); }); }, Promise.resolve());
        }
        // No connection at all (browser offline, or every server unreachable before any answered
        // in this scan): stop now with a clear message instead of retrying every area for minutes.
        if (err && (err.offline || (err.network && !Object.keys(endpoints).length))) throw err;
        if (attempt < RETRY_WAITS.length && !(err && err.status === 400)) {
          var wait = RETRY_WAITS[attempt];
          progress({ phase: 'retry', done: done, total: total, waitS: Math.round(wait / 1000) });
          return MT.util.sleep(wait).then(function () { return runTile(tile, attempt + 1); });
        }
        failed.push({ bbox: tile.bbox, error: err && err.message, details: err && err.details });
        done++;
      });
    }

    var chain = queue.reduce(function (p, tile) {
      return p.then(function () { return runTile(tile, 0); }).then(function () { progress({ phase: 'query', done: done, total: total }); });
    }, Promise.resolve());

    return chain.then(function () {
      if (failed.length && !Object.keys(endpoints).length) {
        var e = new Error('overpass-unavailable');
        e.details = [].concat.apply([], failed.map(function (f) { return f.details || [{ endpoint: '', error: f.error }]; }));
        throw e;
      }
      progress({ phase: 'process', done: done, total: total });
      var inFailed = function (s) {
        return failed.some(function (f) { return MT.geo.bboxContains(f.bbox, s.lat, s.lng); });
      };
      var d = osm.process(elements, { chains: usable, ubigeos: ubigeos, excludeNotFound: inFailed, compiled: R });
      return {
        new: d.new, matched: d.matched, notFound: d.notFound, stats: d.stats,
        timestamp: timestamp, endpoint: endpoint, endpoints: Object.keys(endpoints),
        queries: queries, tiles: total, failedTiles: failed, elements: elements.length,
        skippedChains: skipped, chains: usable, area: { ubigeos: ubigeos }, scannedAt: new Date().toISOString(),
        rulesSource: R.source,
      };
    });
  };

  /**
   * Apply the selected review items. New stores → added (source osm, precision exact, status
   * to_verify; doubtful ones carry a note); moved → position updated (precision exact); not found →
   * status to_verify (or closed) with a dated note ("closed in OSM" when OSM tags it closed).
   * Never deletes anything.
   */
  osm.apply = function (sel, opts) {
    opts = opts || {};
    var today = U.todayISO();
    var list = [];
    (sel.new || []).forEach(function (s) {
      var rec = {};
      MT.data.COLUMNS.forEach(function (c) { rec[c] = s[c]; });
      rec.source = 'osm'; rec.precision = 'exact'; rec.status = 'to_verify';
      if (s._weak) rec.notes = [rec.notes, MT.t('osm.doubtfulNote')].filter(Boolean).join(' · ');
      list.push(rec);
    });
    (sel.moved || []).forEach(function (m) {
      var rec = { id: m.store.id, lat: m.osm.lat, lng: m.osm.lng, precision: 'exact' };
      if (m.store.source === 'osm' && !m.store.source_ref) rec.source_ref = m.osm.source_ref;
      list.push(rec);
    });
    var status = opts.notFoundStatus === 'closed' ? 'closed' : 'to_verify';
    (sel.notFound || []).forEach(function (s) {
      var note = s._closedInOsm ? MT.t('osm.closedNote', { date: today, ref: s._osmRef || '' }) : MT.t('osm.notFoundNote', { date: today });
      var notes = s.notes ? (s.notes.indexOf(note) >= 0 ? s.notes : s.notes + ' · ' + note) : note;
      list.push({ id: s.id, status: status, notes: notes });
    });
    if (!list.length) return Promise.resolve({ added: 0, updated: 0, ids: [], errors: [] });
    return MT.data.upsertStores(list, { op: 'import' });
  };
})();
