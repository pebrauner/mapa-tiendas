/* js/data.js — MT.data (stores, chains, districts, map regions) and MT.logos.
 *
 * Merges the shipped seed globals (window.MT_SEED, MT_CHAINS, MT_LOGOS, MT_DISTRICTS — any of
 * which may be missing or broken while data is being regenerated) with the browser overlay kept
 * by MT.storage (SPEC §3.6). Everything waits for MT.data.ready.
 *
 * Arrays returned by stores()/chains() are shared caches: treat them as READ-ONLY and use the
 * mutation API (upsertStore, deleteStore, …), which persists to IndexedDB and emits events:
 *   'stores:changed' {ids: string[] | '*', op: 'upsert'|'delete'|'restore'|'reset'|'import'}
 *   'chains:changed' {ids: string[] | '*'}
 *   'logos:changed'  {chainId: string | '*'}
 *   'data:ready'     {missing}
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util;

  var COLUMNS = ['id', 'chain', 'name', 'address', 'district', 'province', 'department', 'ubigeo',
    'lat', 'lng', 'precision', 'source', 'source_ref', 'status', 'notes', 'updated'];
  var GROUPS = ['super', 'discount', 'wholesale', 'specialty', 'convenience', 'other'];
  var STATUSES = ['verified', 'to_verify', 'closed'];
  var SOURCES = ['osm', 'web', 'manual', 'import'];
  var PRECISIONS = ['exact', 'approx'];

  /* ---- Validate the seed globals (a half-written file must not break the app) ------------ */
  function seedStores() {
    var s = window.MT_SEED;
    if (Array.isArray(s)) return s;
    return s && Array.isArray(s.stores) ? s.stores : null;
  }
  function seedChains() { return Array.isArray(window.MT_CHAINS) ? window.MT_CHAINS : null; }
  function seedLogos() { var l = window.MT_LOGOS; return l && typeof l === 'object' && !Array.isArray(l) ? l : null; }
  function seedTopo() {
    var t = window.MT_DISTRICTS;
    if (!t || t.type !== 'Topology' || !t.objects) return null;
    var obj = t.objects.districts || t.objects[Object.keys(t.objects)[0]];
    return obj && Array.isArray(obj.geometries) ? { topo: t, obj: obj } : null;
  }

  var data = (MT.data = {
    COLUMNS: COLUMNS, GROUPS: GROUPS, STATUSES: STATUSES, SOURCES: SOURCES, PRECISIONS: PRECISIONS,
    missing: { stores: false, chains: false, districts: false, logos: false },
    seedInfo: { generated: null, count: 0 },
    ready: null, // set below
  });

  /* ---- Internal state -------------------------------------------------------------------- */
  var seedById = {};          // id -> seed store (normalized)
  var seedChainById = {};     // id -> seed chain (normalized)
  var storeOverlay = {};      // id -> {id, op, store?, at}
  var chainOverlay = {};      // id -> {id, op, chain, at}
  var logoOverlay = {};       // chainId -> {id, badge?, wide?, at}
  var merged = null;          // cached merged store list (status any, not deleted)
  var mergedById = {};
  var mergedChains = null;
  var chainById = {};

  /* ---- Normalization --------------------------------------------------------------------- */
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function num(v) {
    if (typeof v === 'number') return v;
    var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : NaN;
  }
  /** Normalize a store record to the SPEC §3.1 shape (all 16 columns, typed). */
  data.normalizeStore = function (s) {
    var o = {};
    COLUMNS.forEach(function (c) { o[c] = str(s[c]); });
    o.lat = U.round(num(s.lat), 6);
    o.lng = U.round(num(s.lng !== undefined ? s.lng : s.lon), 6);
    o.chain = U.slug(o.chain).replace(/-/g, '') || o.chain;
    if (o.ubigeo && /^\d{5}$/.test(o.ubigeo)) o.ubigeo = '0' + o.ubigeo; // Excel ate the leading zero
    // Empty → verified (the usual default); an unknown word is doubtful → to_verify, never verified.
    if (STATUSES.indexOf(o.status) < 0) o.status = !o.status ? 'verified' : MT.io && MT.io.parseStatus ? MT.io.parseStatus(o.status) : 'to_verify';
    if (SOURCES.indexOf(o.source) < 0) o.source = 'manual';
    if (PRECISIONS.indexOf(o.precision) < 0) o.precision = 'exact';
    return o;
  };

  data.normalizeChain = function (c) {
    var id = U.slug(c.id || c.name || '').replace(/-/g, '');
    var name = str(c.name) || id;
    return {
      id: id,
      name: name,
      legendName: str(c.legendName) || name.toUpperCase(),
      group: GROUPS.indexOf(c.group) >= 0 ? c.group : 'other',
      color: U.isHexColor(c.color) ? c.color.toUpperCase() : MT.theme.colors.unknownChain,
      // Badge ring colour when it differs from the brand colour (e.g. Mass: yellow brand, blue
      // ring). '' = use `color`. Kept so "Guardar en carpeta" writes it back to data/chains.js.
      ringColor: U.isHexColor(c.ringColor) ? c.ringColor.toUpperCase() : '',
      // Optional logo zoom inside the badge disc (1 = as drawn; 1.3 = 30 % larger) for square marks
      // with a lot of padding around a small wordmark. Kept and written back like ringColor.
      badgeZoom: isFinite(+c.badgeZoom) && +c.badgeZoom > 0 ? U.clamp(+c.badgeZoom, 0.5, 2.5) : 1,
      owner: str(c.owner),
      defaultOn: c.defaultOn !== false,
      website: str(c.website),
      storeLocator: str(c.storeLocator),
      osm: data.normalizeOsm(c.osm, name),
      logo: c.logo === null ? null : (str(c.logo) || id),
    };
  };
  /**
   * A chain's OpenStreetMap rules with EVERY key of tools/seed/OSM-RULES.md §2, in the order
   * tools/merge.mjs writes them, defaults filled like the merge (label = chain name). Regexes are kept
   * verbatim (not trimmed) so "Guardar en carpeta" writes data/chains.js back byte for byte.
   */
  var OSM_KEYS = ['wikidata', 'nameRegex', 'excludeNameRegex', 'label', 'prefixRegex', 'shops', 'requireShopLike', 'dense', 'uniqueName',
    'weakNameRegex', 'weakNameShops', 'excludeTags'];
  data.OSM_KEYS = OSM_KEYS;
  data.normalizeOsm = function (o, chainName) {
    o = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    var s = function (v) { return typeof v === 'string' ? v : ''; };
    var list = function (v) { return Array.isArray(v) ? v.map(function (x) { return str(x); }).filter(Boolean) : []; };
    return {
      wikidata: list(o.wikidata).map(function (q) { return q.toUpperCase(); }),
      nameRegex: s(o.nameRegex),
      excludeNameRegex: s(o.excludeNameRegex),
      label: typeof o.label === 'string' ? o.label : str(chainName),
      prefixRegex: s(o.prefixRegex),
      shops: list(o.shops),
      requireShopLike: o.requireShopLike !== false,
      dense: o.dense === true,
      uniqueName: o.uniqueName === true,
      weakNameRegex: s(o.weakNameRegex),
      weakNameShops: list(o.weakNameShops),
      excludeTags: (Array.isArray(o.excludeTags) ? o.excludeTags : []).filter(function (x) { return x && typeof x === 'object' && str(x.key); })
        .map(function (x) { return { key: str(x.key), valueRegex: s(x.valueRegex), why: s(x.why) }; }),
    };
  };
  /** window.MT_OSM_RULES as shipped in data/chains.js (cross-chain OSM rules; read-only), or null. */
  var seedOsmRules = null;
  data.osmRules = function () { return seedOsmRules; };

  /* ---- Merge ----------------------------------------------------------------------------- */
  function rebuildStores() {
    merged = [];
    mergedById = {};
    Object.keys(seedById).forEach(function (id) {
      var ov = storeOverlay[id];
      if (ov && ov.op === 'delete') return;
      var rec = ov && ov.op === 'edit' && ov.store ? ov.store : seedById[id];
      merged.push(rec); mergedById[id] = rec;
    });
    Object.keys(storeOverlay).forEach(function (id) {
      var ov = storeOverlay[id];
      if (ov.op === 'add' && ov.store && !seedById[id]) { merged.push(ov.store); mergedById[id] = ov.store; }
    });
  }
  function rebuildChains() {
    var list = [];
    chainById = {};
    Object.keys(seedChainById).forEach(function (id) {
      var ov = chainOverlay[id];
      var c = ov && ov.chain ? ov.chain : seedChainById[id];
      list.push(c); chainById[id] = c;
    });
    var added = Object.keys(chainOverlay).filter(function (id) { return !seedChainById[id] && chainOverlay[id].chain; })
      .map(function (id) { return chainOverlay[id].chain; });
    U.sortBy(added, function (c) { return c.name; }).forEach(function (c) { list.push(c); chainById[c.id] = c; });
    // Chain ids used by stores but not defined anywhere → synthesized "unknown" chains (last).
    var unknown = {};
    (merged || []).forEach(function (s) { if (s.chain && !chainById[s.chain]) unknown[s.chain] = true; });
    var unknownIds = Object.keys(unknown).sort();
    unknownIds.forEach(function (id) { var c = unknownChain(id); list.push(c); chainById[id] = c; });
    mergedChains = list;
    // A store edit/import can introduce (or remove the last store of) an unregistered chain id:
    // the chain lists (Mapas → Cadenas, Cadenas tab) must hear about it to offer its toggle.
    var sig = unknownIds.join(',');
    if (lastUnknownSig !== null && sig !== lastUnknownSig) {
      var before = lastUnknownSig ? lastUnknownSig.split(',') : [];
      var diff = unknownIds.filter(function (id) { return before.indexOf(id) < 0; })
        .concat(before.filter(function (id) { return unknownIds.indexOf(id) < 0; }));
      Promise.resolve().then(function () { MT.bus.emit('chains:changed', { ids: diff }); });
    }
    lastUnknownSig = sig;
  }
  var lastUnknownSig = null;
  function unknownChain(id) {
    var c = data.normalizeChain({ id: id, name: id, group: 'other', color: MT.theme.colors.unknownChain, logo: null });
    c.id = id; c.unknown = true;
    return c;
  }

  /* ---- Stores API ------------------------------------------------------------------------ */
  /**
   * Merged stores. opts: {includeClosed=false, chain, ubigeo, status}. Without filters returns the
   * shared cached array of non-closed stores (or all when includeClosed).
   */
  data.stores = function (opts) {
    opts = opts || {};
    var list = merged;
    if (!opts.includeClosed) list = list.filter(function (s) { return s.status !== 'closed'; });
    if (opts.chain) list = list.filter(function (s) { return s.chain === opts.chain; });
    if (opts.ubigeo) list = list.filter(function (s) { return s.ubigeo === opts.ubigeo; });
    if (opts.status) list = list.filter(function (s) { return s.status === opts.status; });
    return list;
  };
  data.store = function (id) { return mergedById[id] || null; };
  /** Seed version of a store (null for locally added ones). */
  data.seedStore = function (id) { return seedById[id] || null; };
  /** 'seed' | 'added' | 'edited' | 'deleted' | null (unknown id). */
  data.storeState = function (id) {
    var ov = storeOverlay[id];
    if (ov) return ov.op === 'add' ? 'added' : ov.op === 'edit' ? 'edited' : 'deleted';
    return seedById[id] ? 'seed' : null;
  };
  /** Seed stores deleted locally (to show them with a "restore" action). */
  data.deletedStores = function () {
    return Object.keys(storeOverlay).filter(function (id) { return storeOverlay[id].op === 'delete' && seedById[id]; })
      .map(function (id) { return seedById[id]; });
  };
  // Ids handed out in this session: a bulk import calls newStoreId() many times before any of
  // them is stored, so checking mergedById alone could return the same id twice.
  var issuedIds = {};
  data.newStoreId = function () {
    var id;
    do { id = 'man-' + Date.now().toString(36) + (Math.random() * 36 | 0).toString(36); } while (mergedById[id] || seedById[id] || issuedIds[id]);
    issuedIds[id] = true;
    return id;
  };

  /** Fill district/province/department/ubigeo from the coordinates when possible. */
  function locateInto(s) {
    var d = data.districts.locate(s.lat, s.lng);
    if (d) { s.ubigeo = d.ubigeo; s.district = d.district; s.province = d.province; s.department = d.department; }
    return s;
  }

  function prepareUpsert(input) {
    var s = data.normalizeStore(Object.assign({}, data.store(input.id) || {}, input));
    if (!s.id) s.id = data.newStoreId();
    if (!s.chain) throw new Error('store-chain-required');
    if (!isFinite(s.lat) || !isFinite(s.lng)) throw new Error('store-coords-required');
    var prev = data.store(s.id);
    var moved = !prev || prev.lat !== s.lat || prev.lng !== s.lng;
    if ((moved || !s.ubigeo) && data.districts.available) {
      locateInto(s);
      // Moved outside every known district: the old ubigeo would be wrong.
      if (moved && prev && s.ubigeo === prev.ubigeo && !data.districts.locate(s.lat, s.lng)) s.ubigeo = '';
    }
    if (!input.updated) s.updated = U.todayISO();
    var seed = seedById[s.id];
    if (seed) {
      if (sameStore(seed, s)) return { id: s.id, restore: true, store: seed };
      // `base` = the shipped version this edit was made on: when a newer seed arrives, fields the
      // user did not touch follow the new seed (reconcileOverlay) instead of masking it forever.
      return { id: s.id, record: { id: s.id, op: 'edit', store: s, base: seed, at: Date.now() }, store: s };
    }
    return { id: s.id, record: { id: s.id, op: 'add', store: s, at: Date.now() }, store: s };
  }

  /**
   * Create or update a store (partial records are merged onto the current version).
   * Locates ubigeo/district from the coordinates when they changed. Resolves the saved store.
   */
  data.upsertStore = function (input) {
    var p;
    try { p = prepareUpsert(input); } catch (err) { return Promise.reject(err); }
    var op = p.restore ? MT.storage.delete('stores', p.id) : MT.storage.put('stores', p.record);
    return op.then(function () {
      if (p.restore) delete storeOverlay[p.id]; else storeOverlay[p.id] = p.record;
      rebuildStores(); rebuildChains();
      MT.bus.emit('stores:changed', { ids: [p.id], op: 'upsert' });
      return p.store;
    });
  };

  /** Bulk upsert (imports, OSM scan). One transaction, one event. Resolves {added, updated, ids}. */
  data.upsertStores = function (inputs, opts) {
    opts = opts || {};
    var prepared = [], errors = [];
    inputs.forEach(function (input, i) {
      try { prepared.push(prepareUpsert(input)); } catch (err) { errors.push({ index: i, error: err.message }); }
    });
    var puts = prepared.filter(function (p) { return !p.restore; }).map(function (p) { return p.record; });
    var dels = prepared.filter(function (p) { return p.restore; }).map(function (p) { return p.id; });
    var added = 0, updated = 0;
    prepared.forEach(function (p) { if (mergedById[p.id] || seedById[p.id]) updated++; else added++; });
    return Promise.all([puts.length ? MT.storage.put('stores', puts) : 0, dels.length ? MT.storage.delete('stores', dels) : 0]).then(function () {
      puts.forEach(function (r) { storeOverlay[r.id] = r; });
      dels.forEach(function (id) { delete storeOverlay[id]; });
      rebuildStores(); rebuildChains();
      var ids = prepared.map(function (p) { return p.id; });
      MT.bus.emit('stores:changed', { ids: ids, op: opts.op || 'import' });
      return { added: added, updated: updated, ids: ids, errors: errors };
    });
  };

  /** Delete a store: seed stores get a 'delete' overlay record, local additions are dropped. */
  data.deleteStore = function (id) {
    var p = seedById[id] ? MT.storage.put('stores', { id: id, op: 'delete', at: Date.now() }) : MT.storage.delete('stores', id);
    return p.then(function () {
      if (seedById[id]) storeOverlay[id] = { id: id, op: 'delete', at: Date.now() }; else delete storeOverlay[id];
      rebuildStores(); rebuildChains();
      MT.bus.emit('stores:changed', { ids: [id], op: 'delete' });
    });
  };

  /** Drop the local change of a store (back to the seed version; local additions disappear). */
  data.restoreStore = function (id) {
    return MT.storage.delete('stores', id).then(function () {
      delete storeOverlay[id];
      rebuildStores(); rebuildChains();
      MT.bus.emit('stores:changed', { ids: [id], op: 'restore' });
    });
  };

  /** Same store data (every column except `updated`). */
  function sameStore(a, b) {
    return !!a && !!b && COLUMNS.every(function (c) { return c === 'updated' || String(a[c]) === String(b[c]); });
  }

  /** A local store whose shipped original disappeared from data/stores.js (id changed by a re-scan…). */
  data.storeOrphan = function (id) { var ov = storeOverlay[id]; return !!(ov && ov.orphan); };

  /**
   * Bring the overlay up to date with the shipped seed (at boot and in reloadOverlay):
   *  - edits / additions identical to the seed are dropped (they were published: "Guardar en
   *    carpeta" then commit/push, or a folder save on another PC);
   *  - an edit made on an older seed keeps only the fields the user changed (3-way merge with the
   *    record's `base`); everything else follows the new seed;
   *  - an addition whose id is now shipped becomes an edit of it;
   *  - an edit whose id is no longer shipped is kept as a local addition flagged `orphan` (listed
   *    in "Cambios locales" and written by "Guardar en carpeta" - never dropped silently);
   *  - deletions of ids that are no longer shipped are dropped (nothing left to delete);
   *  - chain edits and uploaded logos identical to the shipped ones are dropped.
   * Persists what it changed (best effort). Returns true when something changed.
   */
  function reconcileOverlay() {
    var puts = [], dels = [];
    Object.keys(storeOverlay).forEach(function (id) {
      var ov = storeOverlay[id], seed = seedById[id];
      if (ov.op === 'delete' || !ov.store) {
        if (!seed) { dels.push(id); delete storeOverlay[id]; }
        return;
      }
      if (!seed) {
        if (ov.op === 'edit') {
          var orphan = { id: id, op: 'add', store: ov.store, at: ov.at, orphan: true };
          storeOverlay[id] = orphan; puts.push(orphan);
        }
        return;
      }
      var store = ov.store;
      if (ov.op === 'edit' && ov.base && !sameStore(ov.base, seed)) {
        store = Object.assign({}, seed);
        COLUMNS.forEach(function (c) { if (String(ov.store[c]) !== String(ov.base[c])) store[c] = ov.store[c]; });
      }
      if (sameStore(store, seed)) { dels.push(id); delete storeOverlay[id]; return; }
      if (ov.op !== 'edit' || store !== ov.store || !ov.base || !sameStore(ov.base, seed)) {
        var rec = { id: id, op: 'edit', store: store, base: seed, at: ov.at };
        storeOverlay[id] = rec; puts.push(rec);
      }
    });
    var chainDels = Object.keys(chainOverlay).filter(function (id) {
      var ov = chainOverlay[id], seed = seedChainById[id];
      return !!seed && !!ov.chain && U.isEqual(data.normalizeChain(ov.chain), seed);
    });
    chainDels.forEach(function (id) { delete chainOverlay[id]; });
    var shipped = seedLogos() || {};
    var logoDels = Object.keys(logoOverlay).filter(function (id) {
      var ov = logoOverlay[id], key = (seedChainById[id] && seedChainById[id].logo) || id, l = shipped[key];
      return !!l && (!ov.badge || ov.badge === l.badge) && (!ov.wide || ov.wide === l.wide);
    });
    logoDels.forEach(function (id) { delete logoOverlay[id]; });
    var jobs = [];
    if (puts.length) jobs.push(MT.storage.put('stores', puts));
    if (dels.length) jobs.push(MT.storage.delete('stores', dels));
    if (chainDels.length) jobs.push(MT.storage.delete('chains', chainDels));
    if (logoDels.length) jobs.push(MT.storage.delete('logos', logoDels));
    if (jobs.length) Promise.all(jobs).catch(function (err) { console.warn('[data] overlay reconcile not persisted', err); });
    return jobs.length > 0;
  }

  /** Counts of local (unsaved-to-folder) changes. */
  data.overlayStats = function () {
    var st = { added: 0, edited: 0, deleted: 0, chains: 0, logos: 0, total: 0 };
    Object.keys(storeOverlay).forEach(function (id) {
      var op = storeOverlay[id].op;
      if (op === 'add') st.added++; else if (op === 'edit') st.edited++; else st.deleted++;
    });
    st.chains = Object.keys(chainOverlay).length;
    st.logos = Object.keys(logoOverlay).length;
    st.total = st.added + st.edited + st.deleted + st.chains + st.logos;
    return st;
  };

  /** Discard local changes. what: {stores, chains, logos} (all true by default). */
  data.resetOverlay = function (what) {
    what = Object.assign({ stores: true, chains: true, logos: true }, what || {});
    var jobs = [];
    if (what.stores) jobs.push(MT.storage.clear('stores').then(function () { storeOverlay = {}; }));
    if (what.chains) jobs.push(MT.storage.clear('chains').then(function () { chainOverlay = {}; }));
    if (what.logos) jobs.push(MT.storage.clear('logos').then(function () { logoOverlay = {}; MT.logos._clearCache(); }));
    return Promise.all(jobs).then(function () {
      rebuildStores(); rebuildChains();
      if (what.stores) MT.bus.emit('stores:changed', { ids: '*', op: 'reset' });
      if (what.chains) MT.bus.emit('chains:changed', { ids: '*' });
      if (what.logos) MT.bus.emit('logos:changed', { chainId: '*' });
    });
  };

  /**
   * Re-read the local changes from IndexedDB (another tab or window may have written some) and
   * merge them again. Emits the change events. "Guardar en carpeta" calls it before building the
   * files, so it never writes a stale copy.
   */
  data.reloadOverlay = function () {
    return Promise.all([MT.storage.getAll('stores'), MT.storage.getAll('chains'), MT.storage.getAll('logos')]).then(function (r) {
      storeOverlay = {}; chainOverlay = {}; logoOverlay = {};
      r[0].forEach(function (rec) { storeOverlay[rec.id] = rec; });
      r[1].forEach(function (rec) { chainOverlay[rec.id] = migrateChainRec(rec); });
      r[2].forEach(function (rec) { logoOverlay[rec.id] = rec; });
      if (!data.missing.stores && !data.missing.chains) reconcileOverlay();
      MT.logos._clearCache();
      rebuildStores(); rebuildChains();
      MT.bus.emit('stores:changed', { ids: '*', op: 'sync' });
      MT.bus.emit('chains:changed', { ids: '*' });
      MT.bus.emit('logos:changed', { chainId: '*' });
    });
  };

  /** {stores:{id: at}, chains:{id: at}, logos:{id: at}} - what a folder save is about to write. */
  data.overlaySnapshot = function () {
    var snap = function (o) { var out = {}; Object.keys(o).forEach(function (id) { out[id] = o[id].at; }); return out; };
    return { stores: snap(storeOverlay), chains: snap(chainOverlay), logos: snap(logoOverlay) };
  };

  /**
   * Mark local changes as saved after "Guardar en carpeta" wrote them into the running folder.
   * Only the records that were written (same id AND same `at` as in `snapshot`, taken when the
   * files were built) are removed - a change made meanwhile (another tab, an import still
   * running) stays. Without a snapshot: everything currently in memory.
   */
  data.commitOverlay = function (snapshot) {
    snapshot = snapshot || data.overlaySnapshot();
    var names = ['stores', 'chains', 'logos'];
    return Promise.all(names.map(function (n) { return MT.storage.getAll(n); })).then(function (all) {
      return Promise.all(names.map(function (n, i) {
        var want = snapshot[n] || {};
        var ids = all[i].filter(function (rec) { return want[rec.id] !== undefined && want[rec.id] === rec.at; }).map(function (rec) { return rec.id; });
        return ids.length ? MT.storage.delete(n, ids) : 0;
      }));
    }).then(function () { return data.reloadOverlay(); });
  };

  /** {chainId: count} for a list of stores (default: all non-closed). */
  data.countsByChain = function (list) {
    var out = {};
    (list || data.stores()).forEach(function (s) { out[s.chain] = (out[s.chain] || 0) + 1; });
    return out;
  };

  /* ---- Chains API ------------------------------------------------------------------------ */
  /** Merged chains: seed order, then locally added (by name), then unknown ids used by stores. */
  data.chains = function () { return mergedChains; };
  /** A chain by id; unknown ids get a synthesized grey chain {unknown:true} (never null). */
  data.chain = function (id) { return chainById[id] || unknownChain(id); };
  data.hasChain = function (id) { return !!chainById[id] && !chainById[id].unknown; };
  data.chainState = function (id) {
    if (chainOverlay[id]) return seedChainById[id] ? 'edited' : 'added';
    return seedChainById[id] ? 'seed' : chainById[id] ? 'unknown' : null;
  };
  data.upsertChain = function (input) {
    var base = chainById[input.id] && !chainById[input.id].unknown ? chainById[input.id] : {};
    var merged = Object.assign({}, base, input);
    // A partial osm object (e.g. only {wikidata, nameRegex, shops}) keeps the chain's other OSM rules.
    if (input.osm && base.osm) merged.osm = Object.assign({}, base.osm, input.osm);
    var c = data.normalizeChain(merged);
    if (!c.id) return Promise.reject(new Error('chain-id-required'));
    var rec = { id: c.id, op: seedChainById[c.id] ? 'edit' : 'add', chain: c, at: Date.now() };
    return MT.storage.put('chains', rec).then(function () {
      chainOverlay[c.id] = rec;
      rebuildChains();
      MT.bus.emit('chains:changed', { ids: [c.id] });
      return c;
    });
  };
  /** Remove a local chain edit/addition (seed chains go back to their shipped version). */
  data.restoreChain = function (id) {
    return MT.storage.delete('chains', id).then(function () {
      delete chainOverlay[id];
      rebuildChains();
      MT.bus.emit('chains:changed', { ids: [id] });
    });
  };
  /** Chain toggle state for a map (missing entry → chain.defaultOn). */
  data.chainOn = function (mapCfg, chainId) {
    var m = mapCfg && mapCfg.chains;
    if (m && Object.prototype.hasOwnProperty.call(m, chainId)) return !!m[chainId];
    return data.chain(chainId).defaultOn !== false;
  };

  /* ---- Districts --------------------------------------------------------------------------- */
  var D = (data.districts = {
    available: false,
    _list: [], _byUbigeo: {}, _features: {}, _geoms: {},
  });

  function initDistricts() {
    var s = seedTopo();
    if (!s) return;
    D._topo = s.topo;
    s.obj.geometries.forEach(function (g) {
      var p = g.properties || {};
      if (!p.ubigeo) return;
      var rec = {
        ubigeo: String(p.ubigeo), district: p.district || p.name || '', province: p.province || '',
        department: p.department || '', bbox: g.bbox || null,
      };
      rec.label = rec.district + ' — ' + rec.province + ', ' + rec.department;
      rec._n = U.normalize(rec.district); rec._np = U.normalize(rec.province); rec._nd = U.normalize(rec.department);
      D._list.push(rec); D._byUbigeo[rec.ubigeo] = rec; D._geoms[rec.ubigeo] = g;
    });
    D._list = U.sortBy(D._list, function (r) { return r.department + '|' + r.province + '|' + r.district; });
    D.available = D._list.length > 0;
  }

  /** All districts [{ubigeo, district, province, department, bbox, label}] (sorted). */
  D.all = function () { return D._list; };
  D.get = function (ubigeo) { return D._byUbigeo[ubigeo] || null; };
  D.label = function (ubigeo) { var d = D.get(ubigeo); return d ? d.label : ubigeo; };
  /** GeoJSON Feature for a district (decoded from TopoJSON on first use, then cached). */
  D.feature = function (ubigeo) {
    if (D._features[ubigeo]) return D._features[ubigeo];
    var g = D._geoms[ubigeo];
    if (!g || !window.topojson) return null;
    var f = window.topojson.feature(D._topo, g);
    f.id = ubigeo;
    if (!D._byUbigeo[ubigeo].bbox) D._byUbigeo[ubigeo].bbox = featureBbox(f);
    D._features[ubigeo] = f;
    return f;
  };
  /** FeatureCollection of several districts (unknown ubigeos skipped). */
  D.features = function (ubigeos) {
    return { type: 'FeatureCollection', features: (ubigeos || []).map(D.feature).filter(Boolean) };
  };
  D.bbox = function (ubigeo) {
    var d = D.get(ubigeo);
    if (!d) return null;
    if (!d.bbox) D.feature(ubigeo);
    return d.bbox;
  };
  /** Union bbox [w,s,e,n] of districts, or null. */
  D.unionBbox = function (ubigeos) { return MT.geo.bboxUnion((ubigeos || []).map(D.bbox)); };

  /**
   * Accent-insensitive ranked search. Every query word must match the district, province or
   * department; district-name matches rank first. Also matches 6-digit ubigeo codes.
   * Resolves synchronously: [{ubigeo, district, province, department, label, score}].
   */
  /**
   * Colloquial names of Lima / Callao districts → official INEI name (resolved by name within
   * the province, so a wrong code can never slip in). "Surco" is Santiago de Surco for anyone in
   * Lima, not Surco (Huarochirí); "Magdalena" is Magdalena del Mar; "Cercado" is the district Lima.
   */
  var DISTRICT_ALIASES = {
    'surco': ['Santiago de Surco', 'Lima'], 'santiago de surco': ['Santiago de Surco', 'Lima'],
    'magdalena': ['Magdalena del Mar', 'Lima'],
    'cercado': ['Lima', 'Lima'], 'cercado de lima': ['Lima', 'Lima'], 'lima cercado': ['Lima', 'Lima'], 'centro de lima': ['Lima', 'Lima'],
    'sjl': ['San Juan de Lurigancho', 'Lima'], 'smp': ['San Martín de Porres', 'Lima'],
    'sjm': ['San Juan de Miraflores', 'Lima'], 'ves': ['Villa El Salvador', 'Lima'],
    'vmt': ['Villa María del Triunfo', 'Lima'], 'ate vitarte': ['Ate', 'Lima'], 'vitarte': ['Ate', 'Lima'],
    'chosica': ['Lurigancho', 'Lima'], 'callao cercado': ['Callao', 'Callao'],
  };
  function aliasTarget(nq) {
    var a = DISTRICT_ALIASES[nq];
    if (!a) return null;
    if (!a._ubigeo) {
      var n = U.normalize(a[0]), p = U.normalize(a[1]);
      var hit = D._list.find(function (d) { return d._n === n && d._np === p; });
      a._ubigeo = hit ? hit.ubigeo : '-';
    }
    return a._ubigeo === '-' ? null : a._ubigeo;
  }

  D.search = function (q, opts) {
    opts = opts || {};
    var limit = opts.limit || 20;
    var nq = U.normalize(q);
    if (!nq) return [];
    if (/^\d{4,6}$/.test(nq)) return D._list.filter(function (d) { return d.ubigeo.indexOf(nq) === 0; }).slice(0, limit);
    var words = nq.split(' ');
    var out = [];
    var alias = aliasTarget(nq);
    if (alias) { var ad = D.get(alias); if (ad) out.push({ d: ad, score: 1000 }); }
    D._list.forEach(function (d) {
      if (d.ubigeo === alias) return;
      var score = 0;
      var metro = (d._np === 'lima' && d._nd === 'lima') || d._np === 'callao';
      for (var i = 0; i < words.length; i++) {
        var w = words[i], s = 0;
        if (d._n === w) s = 100; else if (d._n.indexOf(w) === 0) s = 70;
        // A later word of a Lima / Callao name ("surc" → Santiago de Surco) beats a non-Lima name
        // that starts with it (Surco, Huarochirí), but not a Lima name that starts with it
        // ("miraf" → Miraflores before San Juan de Miraflores).
        else if ((' ' + d._n).indexOf(' ' + w) >= 0) s = metro ? 68 : 50;
        else if (d._n.indexOf(w) >= 0) s = 30;
        else if (d._np === w || d._nd === w) s = 20; else if ((' ' + d._np + ' ' + d._nd).indexOf(' ' + w) >= 0) s = 12;
        if (!s) return;
        score += s;
      }
      if (d._n === nq) score += 200;            // whole-name exact match
      if (metro) score += 3;                    // gentle Lima Metropolitana / Callao bias for ties
      out.push({ d: d, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score || U.compare(a.d.district, b.d.district) || U.compare(a.d.province, b.d.province); });
    return out.slice(0, limit).map(function (x) { return Object.assign({ score: x.score }, x.d); });
  };

  /** Provinces grouped: [{key:'Lima|Lima', province, department, ubigeos:[…], label}] sorted. */
  D.byProvince = function () {
    if (D._provinces) return D._provinces;
    var map = {};
    D._list.forEach(function (d) {
      var k = d.province + '|' + d.department;
      (map[k] = map[k] || { key: k, province: d.province, department: d.department, ubigeos: [] }).ubigeos.push(d.ubigeo);
    });
    D._provinces = U.sortBy(Object.keys(map).map(function (k) {
      var p = map[k]; p.label = p.province + ' — ' + p.department; p._n = U.normalize(p.province); return p;
    }), function (p) { return p.department + '|' + p.province; });
    return D._provinces;
  };
  /** Province search for "add whole province". */
  D.searchProvinces = function (q, opts) {
    var nq = U.normalize(q), limit = (opts && opts.limit) || 10;
    if (!nq) return [];
    return D.byProvince().filter(function (p) { return p._n.indexOf(nq) === 0 || (' ' + p._n).indexOf(' ' + nq) >= 0; })
      .sort(function (a, b) { return (b._n === nq) - (a._n === nq) || U.compare(a.province, b.province); })
      .slice(0, limit);
  };

  /** District containing a point (bbox prefilter + point-in-polygon), or null. */
  D.locate = function (lat, lng) {
    if (!D.available || !isFinite(lat) || !isFinite(lng)) return null;
    var pt = [lng, lat];
    for (var i = 0; i < D._list.length; i++) {
      var d = D._list[i], b = d.bbox;
      if (b && (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3])) continue;
      var f = D.feature(d.ubigeo);
      if (!f) continue;
      b = d.bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      if (pointInFeature(pt, f)) return d;
    }
    return null;
  };
  data.locate = D.locate;

  function pointInFeature(pt, f) {
    if (window.turf && window.turf.booleanPointInPolygon) return window.turf.booleanPointInPolygon(pt, f);
    var g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return polys.some(function (rings) { return inRing(pt, rings[0]) && !rings.slice(1).some(function (h) { return inRing(pt, h); }); });
  }
  function inRing(pt, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function featureBbox(f) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function walk(c) {
      if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); return; }
      c.forEach(walk);
    })(f.geometry.coordinates);
    return b;
  }

  /* ---- Map regions (used by the map, legend, exports) ------------------------------------ */
  /**
   * Stores drawn on a map: status ≠ closed, chain toggled on, not hidden on this map, and
   *  - onlyInside: ubigeo ∈ mapCfg.districts;
   *  - otherwise: inside the manual view (mapCfg.view) or the districts' bbox padded by 25%
   *    (neighbouring stores show up; the map layout culls whatever falls outside the frame).
   * Sorted by id (deterministic).
   */
  data.storesForMap = function (mapCfg) {
    if (!mapCfg) return [];
    var districts = mapCfg.districts || [];
    var hidden = {};
    (mapCfg.hiddenStores || []).forEach(function (id) { hidden[id] = true; });
    var inRegion;
    if (mapCfg.onlyInside !== false) {
      if (!districts.length) return [];
      var set = {};
      districts.forEach(function (u) { set[u] = true; });
      inRegion = function (s) { return set[s.ubigeo]; };
    } else {
      var box = mapCfg.view ? MT.geo.viewBounds(mapCfg.view) : MT.geo.bboxPad(D.unionBbox(districts), 0.25);
      if (!box) return [];
      inRegion = function (s) { return MT.geo.bboxContains(box, s.lat, s.lng); };
    }
    var onCache = {};
    var out = data.stores().filter(function (s) {
      if (hidden[s.id] || !isFinite(s.lat) || !isFinite(s.lng)) return false;
      if (!(s.chain in onCache)) onCache[s.chain] = data.chainOn(mapCfg, s.chain);
      return onCache[s.chain] && inRegion(s);
    });
    return out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  };

  /**
   * Geographic extent to fit: fitTo 'districts' → districts' bbox; 'stores' (default) → bbox of
   * storesForMap (min 800 m span), falling back to the districts. [w,s,e,n] or null. Unpadded —
   * the map adds MT.theme.frame.padding.
   */
  data.boundsForMap = function (mapCfg) {
    if (!mapCfg) return null;
    var dBox = D.unionBbox(mapCfg.districts || []);
    if (mapCfg.fitTo === 'districts' && dBox) return dBox;
    var sBox = MT.geo.bboxOfPoints(data.storesForMap(mapCfg));
    if (sBox) return MT.geo.bboxMinSize(sBox, 800);
    return dBox;
  };

  /** "(Miraflores, San Borja, San Isidro, Surquillo)" — or the manual override. */
  data.subtitleFor = function (mapCfg) {
    if (!mapCfg) return '';
    if (mapCfg.subtitleAuto === false) return mapCfg.subtitle || '';
    var names = [];
    (mapCfg.districts || []).forEach(function (u) {
      var d = D.get(u), n = d ? d.district : '';
      if (n && names.indexOf(n) < 0) names.push(n);
    });
    names.sort(U.compare);
    return names.length ? '(' + names.join(', ') + ')' : '';
  };

  /* ---- Logos ------------------------------------------------------------------------------- */
  var genCache = {}, imgCache = {};
  var logos = (MT.logos = {
    /**
     * {badge, wide, source:'overlay'|'seed'|'generated', generated:boolean} for a chain.
     * badge is always a usable PNG data URI (generated fallback); wide may be null.
     */
    get: function (chainId) {
      var ov = logoOverlay[chainId];
      var chain = data.chain(chainId);
      var seed = seedLogos();
      var key = chain.logo === null ? null : (chain.logo || chainId);
      var s = seed && key && seed[key] ? seed[key] : null;
      if (ov && ov.badge) return { badge: ov.badge, wide: ov.wide || (s && s.wide) || null, source: 'overlay', generated: false };
      if (s && s.badge) return { badge: s.badge, wide: (ov && ov.wide) || s.wide || null, source: 'seed', generated: false };
      return { badge: logos.generated(chainId), wide: (ov && ov.wide) || null, source: 'generated', generated: true };
    },
    has: function (chainId) { return !logos.get(chainId).generated; },

    /** Generated fallback badge: brand-colour circle with the chain's initials (PNG data URI, transparent corners). */
    generated: function (chainId) {
      var c = data.chain(chainId);
      var k = c.id + '|' + c.name + '|' + c.color;
      if (genCache[k]) return genCache[k];
      var size = 256, cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var g = cv.getContext('2d');
      g.fillStyle = c.color;
      g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.fill();
      var text = logos.initials(c.name);
      g.fillStyle = U.luminance(c.color) > 0.45 ? '#111827' : '#FFFFFF';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      var fs = text.length <= 2 ? 116 : text.length === 3 ? 92 : 70;
      g.font = '700 ' + fs + 'px ' + MT.theme.fonts.ui;
      while (g.measureText(text).width > size * 0.68 && fs > 30) { fs -= 4; g.font = '700 ' + fs + 'px ' + MT.theme.fonts.ui; }
      g.fillText(text, size / 2, size / 2 + fs * 0.04);
      return (genCache[k] = cv.toDataURL('image/png'));
    },

    /** "Plaza Vea" → "PV", "Wong" → "WONG", "Dollarcity" → "DOL", "Flora y Fauna" → "FF". */
    initials: function (name) {
      var words = String(name || '?').replace(/[^\p{L}\p{N}& ]/gu, ' ').split(/\s+/).filter(function (w) { return w && !/^(y|de|del|la|las|el|los|e)$/i.test(w); });
      if (!words.length) return '?';
      if (words.length === 1) return words[0].length <= 5 ? words[0].toUpperCase() : words[0].slice(0, 3).toUpperCase();
      return words.slice(0, 3).map(function (w) { return w[0]; }).join('').toUpperCase();
    },

    /** Decoded <img> for a chain logo (cached). kind: 'badge' | 'wide' (falls back to badge). */
    image: function (chainId, kind) {
      var l = logos.get(chainId);
      var src = kind === 'wide' && l.wide ? l.wide : l.badge;
      if (imgCache[src]) return imgCache[src];
      imgCache[src] = new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { delete imgCache[src]; reject(new Error('logo-decode-failed:' + chainId)); };
        img.src = src;
      });
      return imgCache[src];
    },

    /** Save an uploaded logo (data URIs) for a chain into the overlay. */
    set: function (chainId, parts) {
      var rec = Object.assign({ id: chainId }, logoOverlay[chainId] || {}, parts, { at: Date.now() });
      return MT.storage.put('logos', rec).then(function () {
        logoOverlay[chainId] = rec;
        MT.bus.emit('logos:changed', { chainId: chainId });
        return logos.get(chainId);
      });
    },
    /** Drop the uploaded logo of a chain (back to the shipped/generated one). */
    remove: function (chainId) {
      return MT.storage.delete('logos', chainId).then(function () {
        delete logoOverlay[chainId];
        MT.bus.emit('logos:changed', { chainId: chainId });
      });
    },
    /** Uploaded logos in the overlay: {chainId: {badge?, wide?}}. */
    overlay: function () { return U.clone(logoOverlay); },

    /**
     * Read an image File and normalize it to a PNG data URI:
     *  kind 'badge' → 256×256, contained & centred on transparent;  'wide' → trimmed to ≤512 px wide.
     */
    fromFile: function (file, kind) {
      return MT.io.readAsDataURL(file).then(function (url) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () {
            var cv = document.createElement('canvas'), g;
            if (kind === 'wide') {
              var w = Math.min(512, img.naturalWidth), h = Math.round(img.naturalHeight * w / img.naturalWidth);
              cv.width = w; cv.height = h; g = cv.getContext('2d');
              g.drawImage(img, 0, 0, w, h);
            } else {
              cv.width = cv.height = 256; g = cv.getContext('2d');
              var k = Math.min(256 / img.naturalWidth, 256 / img.naturalHeight);
              var dw = img.naturalWidth * k, dh = img.naturalHeight * k;
              g.drawImage(img, (256 - dw) / 2, (256 - dh) / 2, dw, dh);
            }
            resolve(cv.toDataURL('image/png'));
          };
          img.onerror = function () { reject(new Error('image-unreadable')); };
          img.src = url;
        });
      });
    },
    _clearCache: function () { imgCache = {}; },
  });

  /* ---- Boot -------------------------------------------------------------------------------- */
  function loadFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var faces = ["400 14px 'Instrument Sans'", "700 14px 'Instrument Sans'", "700 14px 'Bricolage Grotesque'",
      "400 14px Carlito", "700 14px Carlito"];
    return Promise.all(faces.map(function (f) { return document.fonts.load(f).catch(function () { return null; }); }));
  }

  /**
   * Chain edits saved by an older version kept only {wikidata, nameRegex, shops} of the OSM rules:
   * the missing keys (exclusions, format flags…) come from the shipped chain, so an edited chain does
   * not lose its look-alike exclusions. Every overlay chain is re-normalized (current key set).
   */
  function migrateChainRec(rec) {
    if (!rec || !rec.chain) return rec;
    var o = rec.chain.osm && typeof rec.chain.osm === 'object' ? rec.chain.osm : {};
    var seed = seedChainById[rec.id];
    var chain = rec.chain;
    if (seed && OSM_KEYS.some(function (k) { return !(k in o); })) {
      var osm = Object.assign({}, seed.osm);
      Object.keys(o).forEach(function (k) { osm[k] = o[k]; });
      chain = Object.assign({}, chain, { osm: osm });
    }
    return Object.assign({}, rec, { chain: data.normalizeChain(chain) });
  }

  data.ready = Promise.all([MT.storage.ready, loadFonts()]).then(function () {
    var ss = seedStores(), sc = seedChains(), sl = seedLogos();
    data.missing = { stores: !ss, chains: !sc, districts: !seedTopo(), logos: !sl };
    if (ss) {
      ss.forEach(function (raw) {
        if (!raw || !raw.id) return;
        var s = data.normalizeStore(raw);
        seedById[s.id] = s;
      });
      var meta = window.MT_SEED && !Array.isArray(window.MT_SEED) ? window.MT_SEED : {};
      data.seedInfo = { generated: meta.generated || null, count: Object.keys(seedById).length };
    }
    (sc || []).forEach(function (raw) {
      if (!raw || !(raw.id || raw.name)) return;
      var c = data.normalizeChain(raw);
      seedChainById[c.id] = c;
    });
    var G = window.MT_OSM_RULES;
    seedOsmRules = sc && G && typeof G === 'object' && !Array.isArray(G) && Array.isArray(G.nameKeys) ? U.clone(G) : null;
    initDistricts();
    return Promise.all([MT.storage.getAll('stores'), MT.storage.getAll('chains'), MT.storage.getAll('logos')]);
  }).then(function (r) {
    r[0].forEach(function (rec) { storeOverlay[rec.id] = rec; });
    r[1].forEach(function (rec) { chainOverlay[rec.id] = migrateChainRec(rec); });
    r[2].forEach(function (rec) { logoOverlay[rec.id] = rec; });
    // Only reconcile against a seed that actually loaded (a missing stores.js would otherwise
    // turn every edit into an orphan).
    if (!data.missing.stores && !data.missing.chains) reconcileOverlay();
    rebuildStores();
    rebuildChains();
    MT.bus.emit('data:ready', { missing: data.missing });
    return data;
  });
})();
