/* js/ui-db.js — "Base de datos" tab (module M3).
 *
 * Layout: header (title, local-changes cluster, Import / Export / OSM scan / Add store) · filter
 * bar (search + Cadenas, Ubicación, Estado, Fuente, Precisión popovers) · split view: virtualized
 * table | MapLibre map of the filtered stores (resizable) · edit drawer (all fields, mini-map with
 * draggable pin, paste coordinates / Google Maps link, address search) · import dialog (column
 * mapping, merge/append, geocoding at 1 req/s) · OSM scan dialog + review screen.
 *
 * Also exposes MT.dbui — helpers shared with the Cadenas tab and the tests:
 *   createMap(el, opts) → maplibregl.Map (positron, Spanish labels, errors swallowed)
 *   popover(anchor, content, opts) → {el, close}
 *   changesCluster({onPill}) → element kept in sync with MT.data.overlayStats()
 *   saveToFolder(), discardChanges(), exportStores('csv'|'xlsx', {all})
 *   filters() / setFilters(patch) / clearFilters() / visible() / select(id) / openEditor(id|null)
 *   importFile(file) / importRows(name, rows) / openScan(prefill) / openReview(result)
 *   filterStores(list, filters) (pure)
 * Events emitted: 'db:selected' {id}, 'db:filtered' {count}.
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util, h = U.h;
  var t = function (k, v) { return MT.t(k, v); };

  var dbui = (MT.dbui = {});

  /* =========================================================================================
   * Shared helpers
   * ======================================================================================= */
  function fmtNum(n) { return MT.i18n.formatNumber(n); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? String(iso) : MT.i18n.formatDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  dbui.fmtDate = fmtDate;
  var STATUS_TONE = { verified: 'success', to_verify: 'warn', closed: 'danger' };
  function statusBadge(st) {
    return h('span', { class: 'mt-badge mt-badge--dot mt-badge--' + (STATUS_TONE[st] || 'info') }, t('data.status.' + st));
  }
  dbui.statusBadge = statusBadge;
  function logoImg(chainId, size, extraClass) {
    var c = MT.data.chain(chainId);
    return h('img', { class: 'mt-db-logo' + (extraClass ? ' ' + extraClass : ''), src: MT.logos.get(chainId).badge, alt: '', width: size, height: size,
      style: { borderColor: c.color, width: size + 'px', height: size + 'px' }, loading: 'lazy', decoding: 'async' });
  }
  dbui.logoImg = logoImg;
  function host(url) { try { return new URL(url).host; } catch (e) { return String(url || ''); } }
  function iconBtn(icon, titleKey, onClick, extra) {
    return MT.ui.button(Object.assign({ icon: icon, kind: 'ghost', size: 'sm', title: t(titleKey), i18nTitle: titleKey, onClick: onClick }, extra || {}));
  }

  /** Chains grouped in MT.data.GROUPS order (unknown chains end up in 'other'). */
  function chainsByGroup(list) {
    var by = {};
    (list || MT.data.chains()).forEach(function (c) { (by[c.group] = by[c.group] || []).push(c); });
    return MT.data.GROUPS.filter(function (g) { return by[g]; }).map(function (g) { return { group: g, chains: by[g] }; });
  }
  dbui.chainsByGroup = chainsByGroup;

  /**
   * A MapLibre map with the basemap, Spanish labels and quiet error handling - or null when the
   * browser cannot draw maps (no WebGL: hardware acceleration off, company policy). Then the
   * element gets the same explanation the Mapas tab shows, and callers carry on without a map.
   */
  dbui.createMap = function (el, opts) {
    opts = opts || {};
    var map;
    try {
      map = new maplibregl.Map(Object.assign({
        container: el, style: MT.theme.basemap.style, center: [-77.03, -12.08], zoom: 10,
        attributionControl: { compact: false }, fadeDuration: 120, dragRotate: false, pitchWithRotate: false,
        maxPitch: 0, cooperativeGestures: false, locale: MT.i18n.mapLocale(),
      }, opts.map || {}));
    } catch (err) {
      console.warn('[db] the map cannot be created', err);
      el.appendChild(h('div', { class: 'mt-db-mapnote mt-db-mapnote--block', role: 'status' }, MT.ui.iconEl('warning', { size: 16 }),
        h('div', null, h('strong', null, t('map.notice.webglError.title')), h('div', null, t('map.notice.webglError.text')))));
      return null;
    }
    map.touchZoomRotate.disableRotation();
    if (opts.nav !== false) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('style.load', function () {
      (map.getStyle().layers || []).forEach(function (layer) {
        if (layer.type !== 'symbol') return;
        var tf = map.getLayoutProperty(layer.id, 'text-field');
        if (tf && JSON.stringify(tf).indexOf('name_en') >= 0) map.setLayoutProperty(layer.id, 'text-field', MT.theme.basemap.spanishTextField);
      });
    });
    // Without a listener MapLibre logs every failed tile with console.error; network failures get
    // one quiet note instead. Anything else (a bad layer definition…) is a real bug: log it.
    var noted = false;
    var note = null;
    map.on('error', function (e) {
      var err = e && e.error;
      var net = err && (err.status !== undefined || err.url || /failed to fetch|networkerror|network|abort/i.test(String(err.message || err.name || '')));
      if (!net) { console.error('[db] map error', err); return; }
      if (noted) return;
      noted = true;
      var retry = h('button', { type: 'button', class: 'mt-db-link', onclick: function () { reloadStyle(); } }, t('common.retry'));
      note = h('div', { class: 'mt-db-mapnote', role: 'status' }, MT.ui.iconEl('cloudOff', { size: 16 }), h('span', null, t('db.map.offline')), retry);
      el.appendChild(note);
    });
    // Basemap failed (offline at start): retry when the connection comes back, or on demand.
    function reloadStyle() {
      if (!map.getContainer().isConnected) return;
      noted = false;
      if (note) { note.remove(); note = null; }
      try { map.setStyle(MT.theme.basemap.style, { diff: false }); } catch (e) { /* the next error shows the note again */ }
    }
    var onOnline = function () { if (noted) reloadStyle(); };
    window.addEventListener('online', onOnline);
    map.on('remove', function () { window.removeEventListener('online', onOnline); });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(U.debounce(function () { if (map.getContainer().isConnected) map.resize(); }, 60));
      ro.observe(el);
      map.on('remove', function () { ro.disconnect(); });
    }
    return map;
  };
  // MapLibre reads `locale` once, when a control is created: relabel the zoom / attribution
  // buttons of the maps that already exist when the language changes.
  MT.bus.on('lang:changed', function () {
    var loc = MT.i18n.mapLocale();
    [['.maplibregl-ctrl-zoom-in', 'NavigationControl.ZoomIn'], ['.maplibregl-ctrl-zoom-out', 'NavigationControl.ZoomOut'],
      ['.maplibregl-ctrl-attrib-button', 'AttributionControl.ToggleAttribution']].forEach(function (x) {
      U.$$(x[0]).forEach(function (b) { if (loc[x[1]]) { b.title = loc[x[1]]; b.setAttribute('aria-label', loc[x[1]]); } });
    });
  });
  /** Run fn once the map's style is ready (immediately when it already is). */
  function whenStyle(map, fn) {
    if (map.isStyleLoaded()) fn(); else map.once('load', fn);
  }
  dbui.whenStyle = whenStyle;

  /** Circle sizes by zoom (zoom expressions must stay top-level, hence two copies). */
  var CIRCLE_RADIUS = ['interpolate', ['linear'], ['zoom'], 4, 2.6, 9, 3.6, 13, 5.5, 16, 8];
  var HALO_RADIUS = ['interpolate', ['linear'], ['zoom'], 4, 9.6, 9, 10.6, 13, 12.5, 16, 15];

  /** Anchored popover (filters, pickers). Esc / outside click closes; focus goes back to the anchor. */
  var openPop = null;
  dbui.popover = function (anchor, content, opts) {
    opts = opts || {};
    if (openPop) openPop.close();
    var el = h('div', { class: 'mt-db-pop' + (opts.className ? ' ' + opts.className : ''), role: 'dialog', 'aria-label': opts.label || null }, content);
    document.body.appendChild(el);
    function place() {
      var r = anchor.getBoundingClientRect();
      var w = el.offsetWidth;
      var left = U.clamp(opts.align === 'end' ? r.right - w : r.left, 8, window.innerWidth - w - 8);
      var top = r.bottom + 6;
      el.style.left = left + 'px'; el.style.top = top + 'px';
      el.style.maxHeight = Math.max(160, window.innerHeight - top - 12) + 'px';
    }
    place();
    anchor.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () { el.classList.add('is-open'); });
    var onDown = function (e) { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); } };
    setTimeout(function () { document.addEventListener('mousedown', onDown, true); }, 0);
    el.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', close);
      anchor.setAttribute('aria-expanded', 'false');
      el.remove();
      if (openPop && openPop.el === el) openPop = null;
      if (opts.onClose) opts.onClose();
    }
    var first = U.$(opts.focus || 'input,select', el) || U.$('button', el);
    if (first) setTimeout(function () { first.focus(); }, 0);
    openPop = { el: el, close: close, place: place };
    return openPop;
  };

  /* ---- Local changes: cluster, save to folder, discard ---------------------------------- */
  function changesDetail(st) {
    var parts = [];
    if (st.added) parts.push(t('db.changes.added', { n: st.added }));
    if (st.edited) parts.push(t('db.changes.edited', { n: st.edited }));
    if (st.deleted) parts.push(t('db.changes.deleted', { n: st.deleted }));
    if (st.chains) parts.push(t('db.changes.chains', { n: st.chains }));
    if (st.logos) parts.push(t('db.changes.logos', { n: st.logos }));
    return parts.join(' · ');
  }
  dbui.changesDetail = changesDetail;

  /** "● 5 cambios locales  [Guardar en carpeta] [↺]" — re-renders itself on data events. */
  dbui.changesCluster = function (opts) {
    opts = opts || {};
    var root = h('div', { class: 'mt-db-changes', role: 'group', 'aria-label': t('db.changes.group') });
    function render() {
      U.clear(root);
      var st = MT.data.overlayStats();
      root.classList.toggle('has-changes', st.total > 0);
      if (!st.total) {
        root.appendChild(h('span', { class: 'mt-db-changes__ok', title: t('db.changes.noneHint') }, MT.ui.iconEl('success', { size: 16 }), t('db.changes.none')));
        return;
      }
      var pill = h('button', { type: 'button', class: 'mt-db-changes__pill' + (opts.isActive && opts.isActive() ? ' is-active' : ''),
        title: changesDetail(st) + ' — ' + t(opts.onPill ? 'db.changes.pillHint' : 'db.changes.browserOnly'),
        'aria-pressed': opts.isActive ? String(!!opts.isActive()) : null,
        onclick: function () { if (opts.onPill) opts.onPill(); } },
        h('span', { class: 'mt-db-changes__dot' }), t('app.localChanges', { n: st.total }));
      root.appendChild(pill);
      root.appendChild(MT.ui.button({ icon: 'folder', label: t('db.save.button'), kind: 'soft', size: 'sm', className: 'mt-db-changes__save',
        title: t('db.save.hint'), onClick: function () { dbui.saveToFolder(); } }));
      root.appendChild(MT.ui.button({ icon: 'undo', kind: 'ghost', size: 'sm', title: t('db.discard.button'), onClick: function () { dbui.discardChanges(); } }));
    }
    render();
    ['stores:changed', 'chains:changed', 'logos:changed', 'lang:changed', 'db:filtered'].forEach(function (e) { MT.bus.on(e, render); });
    root.render = render;
    return root;
  };

  /** "Guardar en carpeta": write data/*.js(+csv) and logos/logos.js into the project folder. */
  dbui.saveToFolder = function () {
    var files;
    try { files = MT.io.repoFiles(); } catch (err) { console.error(err); MT.ui.toast(t('db.save.error'), { type: 'error' }); return Promise.resolve(null); }
    // A shipped data file did not load: writing now would replace it with only the local changes.
    // Refuse (the local changes stay safe in this browser) and explain what to do.
    if (files.skipped && files.skipped.length) {
      return MT.ui.modal({ title: t('db.save.missingTitle'), size: 'md',
        body: h('div', { class: 'mt-stack' }, h('p', { class: 'mt-modal__text' }, t('db.save.missingText')),
          h('ul', { class: 'mt-db-filelist' }, files.skipped.map(function (p) { return h('li', null, MT.ui.iconEl('warning', { size: 15 }), h('code', null, p)); })),
          h('p', { class: 'mt-hint' }, t('db.save.missingHint'))),
        actions: [{ label: t('common.ok'), kind: 'primary', value: null, autofocus: true }] }).result;
    }
    // Build the files from the latest local changes (another tab may have added some) and remember
    // exactly which records went into them: only those are marked as saved afterwards.
    var snapshot = null, st = null;
    function build() {
      return MT.data.reloadOverlay().then(function () {
        st = MT.data.overlayStats();
        snapshot = MT.data.overlaySnapshot();
        files = MT.io.repoFiles();
        return files;
      });
    }
    if (!MT.storage.fs.supported) {
      return build().then(function () { return MT.storage.saveToFolder(files); }).then(function (r) { showSaved(r, files, st, snapshot); return r; });
    }
    function check(folder) {
      if (!folder) return null;
      return MT.storage.fs.looksLikeApp(folder).then(function (ok) {
        if (!ok) {
          return MT.ui.confirm(t('storage.notAppFolder') + ' ' + t('db.save.pickAnotherText'), { title: t('db.save.notAppTitle'), okLabel: t('db.save.pickAnother') })
            .then(function (yes) { return yes ? MT.storage.fs.pickFolder().then(check) : null; });
        }
        // On file:// the folder must be the one this page runs from: every copy of the app on the
        // PC shares the remembered folder, so after an update it can point at the OLD copy.
        return MT.storage.fs.isRunningFolder(folder).then(function (same) {
          if (same !== false) return folder;
          return MT.ui.confirm(h('div', { class: 'mt-stack mt-stack--sm' },
            h('p', { class: 'mt-modal__text' }, t('db.save.wrongFolderText', { folder: folder.name })),
            h('p', { class: 'mt-hint' }, t('db.save.wrongFolderHint'))),
          { title: t('db.save.wrongFolderTitle'), okLabel: t('db.save.pickAnother') })
            .then(function (yes) { return yes ? MT.storage.fs.pickFolder().then(check) : null; });
        });
      });
    }
    return MT.storage.fs.ensureFolder().then(check).then(function (folder) {
      if (!folder) return null;
      var busy = MT.ui.busy({ title: t('db.save.writing'), message: folder.name });
      return build().then(function () { return MT.storage.fs.writeFiles(folder, files); }).then(function (written) {
        busy.close();
        var r = { method: 'folder', folder: folder.name, written: written };
        showSaved(r, files, st, snapshot);
        return r;
      }, function (err) { busy.close(); throw err; });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return null;
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      if (!denied) console.error('[db] save to folder failed', err);
      MT.ui.toast(t(denied ? 'storage.permissionDenied' : 'db.save.error'), { type: 'error' });
      return null;
    });
  };

  function showSaved(r, files, st, snapshot) {
    var list = h('ul', { class: 'mt-db-filelist' }, files.map(function (f) { return h('li', null, MT.ui.iconEl('file', { size: 15 }), h('code', null, f.path)); }));
    if (r.method !== 'folder') {
      MT.ui.modal({ title: t('db.save.downloadTitle'), size: 'md', body: h('div', { class: 'mt-stack' }, h('p', { class: 'mt-modal__text' }, t('storage.downloaded')), list,
        h('p', { class: 'mt-hint' }, t('db.save.downloadHint'))), actions: [{ label: t('common.done'), kind: 'primary', value: true, autofocus: true }] });
      return;
    }
    if (MT.env.isFile) {
      // The running folder now holds the merged data: mark exactly what was written as saved and
      // reload to read the new files (without the reload the view would fall back to the old seed).
      MT.data.commitOverlay(snapshot).then(function () {
        var reload = function () { location.reload(); };
        var timer = setTimeout(reload, 4000);
        MT.ui.modal({ title: t('db.save.doneTitle'), size: 'md', dismissible: false,
          body: h('div', { class: 'mt-stack' }, h('p', { class: 'mt-modal__text' }, t('storage.folderSaved', { folder: r.folder }) + ' ' + changesDetail(st) + '.'), list,
            h('p', { class: 'mt-hint' }, t('db.save.reloading'))),
          actions: [{ label: t('db.save.reloadNow'), kind: 'primary', autofocus: true, onClick: function () { clearTimeout(timer); reload(); return false; } }] });
      });
    } else {
      MT.ui.modal({ title: t('db.save.doneTitle'), size: 'md',
        body: h('div', { class: 'mt-stack' }, h('p', { class: 'mt-modal__text' }, t('storage.folderSaved', { folder: r.folder })), list,
          h('p', { class: 'mt-hint' }, t('db.save.publishHint'))),
        actions: [{ label: t('common.done'), kind: 'primary', value: true, autofocus: true }] });
    }
  }

  dbui.discardChanges = function () {
    var st = MT.data.overlayStats();
    if (!st.total) return Promise.resolve(false);
    return MT.ui.confirm(h('div', { class: 'mt-stack mt-stack--sm' }, h('p', { class: 'mt-modal__text' }, t('db.discard.text')), h('p', { class: 'mt-db-confirm-detail' }, changesDetail(st))),
      { title: t('db.discard.title'), okLabel: t('db.discard.ok'), danger: true }).then(function (ok) {
      if (!ok) return false;
      return MT.data.resetOverlay().then(function () { MT.ui.toast(t('db.discard.done'), { type: 'success' }); return true; });
    });
  };

  /* =========================================================================================
   * Filtering & sorting (pure)
   * ======================================================================================= */
  var EMPTY_FILTERS = { q: '', chains: [], department: '', province: '', ubigeo: '', statuses: [], sources: [], precisions: [], local: false };
  var NONE = '__none__'; // "no location" pseudo-department
  var searchIndex = new WeakMap();
  function searchText(s) {
    var v = searchIndex.get(s);
    if (v === undefined) {
      var c = MT.data.chain(s.chain);
      v = U.normalize([s.name, s.address, s.district, s.province, s.department, s.ubigeo, c.name, c.legendName, s.id, s.notes, s.source_ref].join(' '));
      searchIndex.set(s, v);
    }
    return v;
  }
  function isLocal(id) { var st = MT.data.storeState(id); return st === 'added' || st === 'edited' || st === 'deleted'; }

  /** Pure filter. skip: facet name to ignore ('chains'|'location'|'statuses'|'sources'|'precisions') for facet counts. */
  dbui.filterStores = function (list, f, skip) {
    f = Object.assign({}, EMPTY_FILTERS, f || {});
    var words = U.normalize(f.q).split(' ').filter(Boolean);
    var chains = f.chains.length && skip !== 'chains' ? toSet(f.chains) : null;
    var statuses = f.statuses.length && skip !== 'statuses' ? toSet(f.statuses) : null;
    var sources = f.sources.length && skip !== 'sources' ? toSet(f.sources) : null;
    var precisions = f.precisions.length && skip !== 'precisions' ? toSet(f.precisions) : null;
    var loc = skip !== 'location';
    return list.filter(function (s) {
      if (chains && !chains[s.chain]) return false;
      if (statuses && !statuses[s.status]) return false;
      if (sources && !sources[s.source]) return false;
      if (precisions && !precisions[s.precision]) return false;
      if (loc) {
        if (f.department === NONE) { if (s.ubigeo || s.department) return false; }
        else if (f.department && s.department !== f.department) return false;
        if (f.province && s.province !== f.province) return false;
        if (f.ubigeo && s.ubigeo !== f.ubigeo) return false;
      }
      if (f.local && !isLocal(s.id)) return false;
      if (words.length) {
        var txt = searchText(s);
        for (var i = 0; i < words.length; i++) if (txt.indexOf(words[i]) < 0) return false;
      }
      return true;
    });
  };
  function toSet(arr) { var o = {}; arr.forEach(function (v) { o[v] = true; }); return o; }

  var STATUS_ORDER = { verified: 0, to_verify: 1, closed: 2 };
  var SORTS = {
    chain: function (s) { return MT.data.chain(s.chain).name + '|' + s.name; },
    name: function (s) { return s.name; },
    district: function (s) { return (s.district || '~') + '|' + s.province + '|' + s.name; },
    status: function (s) { return STATUS_ORDER[s.status]; },
    source: function (s) { return t('data.source.' + s.source) + '|' + s.precision; },
    updated: function (s) { return s.updated || ''; },
  };
  function sortList(list, sort) {
    var key = SORTS[sort.key] || SORTS.chain;
    var out = list.map(function (s) { return [key(s), s]; });
    var dir = sort.dir < 0 ? -1 : 1;
    out.sort(function (a, b) {
      var c = typeof a[0] === 'number' ? a[0] - b[0] : U.compare(a[0], b[0]);
      if (!c) c = U.compare(a[1].name, b[1].name) || (a[1].id < b[1].id ? -1 : a[1].id > b[1].id ? 1 : 0);
      else c *= dir;
      return c;
    });
    return out.map(function (x) { return x[1]; });
  }

  /* =========================================================================================
   * Tab state
   * ======================================================================================= */
  var state = {
    filters: Object.assign({}, EMPTY_FILTERS, sanitizeFilters(MT.storage.pref('db.filters', {}))),
    sort: MT.storage.pref('db.sort', { key: 'chain', dir: 1 }),
    selected: null,
    checked: {},
    list: [],
    deleted: {},
    showMap: MT.storage.pref('db.showMap', true),
    mapWidth: MT.storage.pref('db.mapWidth', 0),
  };
  function sanitizeFilters(f) {
    var o = {};
    Object.keys(EMPTY_FILTERS).forEach(function (k) {
      if (f && f[k] !== undefined && typeof f[k] === typeof EMPTY_FILTERS[k] && Array.isArray(f[k]) === Array.isArray(EMPTY_FILTERS[k])) o[k] = f[k];
    });
    o.local = false; // the "local changes" view is never restored
    return o;
  }
  var els = {};
  var mounted = false;
  var map = null, mapReady = false, mapFailed = false, popup = null, hoverTip = null;

  dbui.filters = function () { return U.clone(state.filters); };
  dbui.setFilters = function (patch) {
    Object.assign(state.filters, patch || {});
    if (patch && 'department' in patch && !('province' in patch)) { state.filters.province = ''; state.filters.ubigeo = ''; }
    if (patch && 'province' in patch && !('ubigeo' in patch)) state.filters.ubigeo = '';
    var save = Object.assign({}, state.filters, { local: false });
    MT.storage.setPref('db.filters', save);
    if (mounted) refresh({ fit: true, resetScroll: true });
  };
  dbui.clearFilters = function () { dbui.setFilters(Object.assign({}, EMPTY_FILTERS)); };
  dbui.visible = function () { return state.list.slice(); };
  dbui.state = function () { return { selected: state.selected, checked: Object.keys(state.checked), count: state.list.length, sort: U.clone(state.sort) }; };

  /* =========================================================================================
   * Mount
   * ======================================================================================= */
  function mount(panel) {
    mounted = true;
    els.panel = panel;
    els.root = h('div', { class: 'mt-db' });
    panel.appendChild(els.root);
    buildHeader();
    buildFilterBar();
    buildBody();
    buildDrawer();
    refresh({ fit: true });
    var rerender = U.debounce(function () { refresh({}); }, 40);
    MT.bus.on('stores:changed', rerender);
    MT.bus.on('chains:changed', rerender);
    MT.bus.on('logos:changed', rerender);
    MT.bus.on('lang:changed', function () {
      renderHeaderMeta(); renderFilterButtons(); renderCount(); renderTableHead(); renderRows(true); renderEmpty(); renderBulk(); updateMapData(false);
      if (ed.open) renderEditor();
    });
  }

  /* ---- Header ------------------------------------------------------------------------------ */
  function buildHeader() {
    els.meta = h('div', { class: 'mt-db-head__meta' });
    els.changes = dbui.changesCluster({
      onPill: function () { dbui.setFilters({ local: !state.filters.local }); },
      isActive: function () { return state.filters.local; },
    });
    els.scanBtn = MT.ui.button({ icon: 'globe', i18n: 'db.actions.scan', kind: 'secondary', size: 'sm', onClick: function () { dbui.openScan(); } });
    els.exportBtn = MT.ui.button({ icon: 'download', i18n: 'common.export', kind: 'secondary', size: 'sm', onClick: function () { openExportMenu(els.exportBtn); } });
    els.exportBtn.setAttribute('aria-haspopup', 'menu');
    els.exportBtn.appendChild(MT.ui.iconEl('chevronDown', { size: 14 }));
    var head = h('header', { class: 'mt-db-head' },
      h('div', { class: 'mt-db-head__title' },
        h('h1', { class: 'mt-db-head__h', 'data-i18n': 'tab.db' }, t('tab.db')), els.meta),
      els.changes,
      h('div', { class: 'mt-db-head__actions' },
        MT.ui.button({ icon: 'upload', i18n: 'common.import', kind: 'secondary', size: 'sm', onClick: startImport }),
        els.exportBtn, els.scanBtn,
        MT.ui.button({ icon: 'plus', i18n: 'db.actions.add', kind: 'primary', size: 'sm', onClick: function () { dbui.openEditor(null); } })));
    els.root.appendChild(head);
    renderHeaderMeta();
  }
  function renderHeaderMeta() {
    if (!els.meta) return;
    var all = MT.data.stores({ includeClosed: true });
    var chains = MT.data.chains().filter(function (c) { return !c.unknown; }).length;
    var bits = [t('db.meta.stores', { n: all.length, num: fmtNum(all.length) }), t('db.meta.chains', { n: chains })];
    if (MT.data.seedInfo.generated) bits.push(t('db.meta.seed', { date: fmtDate(MT.data.seedInfo.generated) }));
    els.meta.textContent = bits.join(' · ');
    if (els.scanBtn) {
      els.scanBtn.disabled = !MT.data.districts.available;
      els.scanBtn.title = MT.data.districts.available ? t('db.actions.scanHint') : t('osm.noDistricts');
    }
  }

  function openExportMenu(anchor) {
    var n = state.list.filter(function (s) { return !state.deleted[s.id]; }).length;
    var all = MT.data.stores({ includeClosed: true }).length;
    MT.ui.menu(anchor, [
      { heading: t('db.export.filtered', { n: fmtNum(n) }) },
      { label: t('db.export.csv'), icon: 'file', disabled: !n, onClick: function () { dbui.exportStores('csv'); } },
      { label: t('db.export.xlsx'), icon: 'table', disabled: !n, onClick: function () { dbui.exportStores('xlsx'); } },
      { separator: true },
      { heading: t('db.export.all', { n: fmtNum(all) }) },
      { label: t('db.export.csv'), icon: 'file', disabled: !all, onClick: function () { dbui.exportStores('csv', { all: true }); } },
      { label: t('db.export.xlsx'), icon: 'table', disabled: !all, onClick: function () { dbui.exportStores('xlsx', { all: true }); } },
    ], { align: 'end', minWidth: 250 });
  }
  dbui.exportStores = function (kind, opts) {
    var list = opts && opts.all ? MT.data.stores({ includeClosed: true }) : state.list.filter(function (s) { return !state.deleted[s.id]; });
    // Same row order as data/stores.csv (chain, department, province, district, name), so an
    // export of the whole base is the shipped file plus the local changes.
    list = MT.io.sortStores(list);
    var base = t('db.export.fileBase');
    if (kind === 'xlsx') {
      var busy = MT.ui.busy({ title: t('db.export.working') });
      return MT.io.storesToXLSX(list).then(function (blob) {
        busy.close();
        MT.io.download(blob, MT.io.datedName(base, 'xlsx'));
        MT.ui.toast(t('db.export.done', { n: list.length }), { type: 'success' });
      }, function (err) { busy.close(); console.error(err); MT.ui.toast(t('db.export.error'), { type: 'error' }); });
    }
    MT.io.download(MT.io.storesToCSV(list), MT.io.datedName(base, 'csv'));
    MT.ui.toast(t('db.export.done', { n: list.length }), { type: 'success' });
    return Promise.resolve();
  };

  /* ---- Filter bar --------------------------------------------------------------------------- */
  var FACETS = [
    { id: 'chains', icon: 'store', label: 'db.filter.chains' },
    { id: 'location', icon: 'pin', label: 'db.filter.location' },
    { id: 'statuses', icon: 'check', label: 'db.filter.status', values: function () { return MT.data.STATUSES; }, valueLabel: function (v) { return t('data.status.' + v); }, field: 'status' },
    { id: 'sources', icon: 'database', label: 'db.filter.source', values: function () { return MT.data.SOURCES; }, valueLabel: function (v) { return t('data.source.' + v); }, field: 'source' },
    { id: 'precisions', icon: 'target', label: 'db.filter.precision', values: function () { return MT.data.PRECISIONS; }, valueLabel: function (v) { return t('data.precision.' + v); }, field: 'precision' },
  ];
  function buildFilterBar() {
    els.search = h('input', { class: 'mt-input mt-input--sm mt-db-search__input', type: 'search', value: state.filters.q,
      placeholder: t('db.filter.searchPh'), 'data-i18n-placeholder': 'db.filter.searchPh', 'aria-label': t('db.filter.search'), 'data-i18n-aria': 'db.filter.search' });
    var onSearch = U.debounce(function () { dbui.setFilters({ q: els.search.value }); }, 140);
    els.search.addEventListener('input', onSearch);
    els.search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.search.value) { e.preventDefault(); els.search.value = ''; onSearch.cancel(); dbui.setFilters({ q: '' }); }
      if (e.key === 'ArrowDown' && state.list.length) { e.preventDefault(); els.tableWrap.focus(); if (!state.selected) dbui.select(state.list[0].id, { source: 'key' }); }
    });
    els.fbtns = {};
    var btns = FACETS.map(function (f) {
      var b = h('button', { type: 'button', class: 'mt-db-fbtn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: function () { openFacet(f, b); } });
      els.fbtns[f.id] = b;
      return b;
    });
    els.clearBtn = h('button', { type: 'button', class: 'mt-db-clear', onclick: function () { els.search.value = ''; dbui.clearFilters(); } });
    els.count = h('div', { class: 'mt-db-count', 'aria-live': 'polite' });
    els.mapToggle = MT.ui.button({ icon: 'map', kind: 'ghost', size: 'sm', title: t('db.map.toggle'), i18nTitle: 'db.map.toggle', onClick: function () { setShowMap(!state.showMap); } });
    els.root.appendChild(h('div', { class: 'mt-db-filters' },
      h('div', { class: 'mt-input-group mt-db-search' }, MT.ui.iconEl('search', { size: 16 }), els.search),
      h('div', { class: 'mt-db-fbtns' }, btns, els.clearBtn),
      h('div', { class: 'mt-spacer' }), els.count, els.mapToggle));
    renderFilterButtons();
  }
  function facetActive(id) {
    var f = state.filters;
    if (id === 'location') return !!(f.department || f.province || f.ubigeo);
    return f[id] && f[id].length > 0;
  }
  function renderFilterButtons() {
    var f = state.filters;
    FACETS.forEach(function (fc) {
      var b = els.fbtns[fc.id], val = '';
      if (fc.id === 'chains' && f.chains.length) val = f.chains.length === 1 ? MT.data.chain(f.chains[0]).name : t('db.filter.nChains', { n: f.chains.length });
      else if (fc.id === 'location') {
        if (f.ubigeo) val = (MT.data.districts.get(f.ubigeo) || {}).district || storeDistrictName(f.ubigeo) || f.ubigeo;
        else if (f.province) val = f.province;
        else if (f.department) val = f.department === NONE ? t('db.filter.noLocation') : f.department;
      } else if (fc.values && f[fc.id].length) val = f[fc.id].length === 1 ? fc.valueLabel(f[fc.id][0]) : t('db.filter.nSelected', { n: f[fc.id].length });
      U.clear(b);
      b.classList.toggle('is-active', !!val);
      b.appendChild(MT.ui.iconEl(fc.icon, { size: 15 }));
      b.appendChild(h('span', { class: 'mt-db-fbtn__label' }, t(fc.label)));
      if (val) b.appendChild(h('span', { class: 'mt-db-fbtn__val' }, val));
      b.appendChild(MT.ui.iconEl('chevronDown', { size: 14 }));
    });
    var any = FACETS.some(function (fc) { return facetActive(fc.id); }) || !!f.q || f.local;
    els.clearBtn.hidden = !any;
    els.clearBtn.textContent = t('db.filter.clear');
    if (els.search && document.activeElement !== els.search) els.search.value = f.q;
  }
  function storeDistrictName(ubigeo) {
    var s = MT.data.stores({ includeClosed: true }).find(function (x) { return x.ubigeo === ubigeo; });
    return s ? s.district : '';
  }

  function openFacet(fc, anchor) {
    var all = MT.data.stores({ includeClosed: true });
    var base = dbui.filterStores(all, state.filters, fc.id);
    var content;
    if (fc.id === 'chains') content = chainFacet(base);
    else if (fc.id === 'location') content = locationFacet(all);
    else content = listFacet(fc, base);
    dbui.popover(anchor, content, { label: t(fc.label), className: 'mt-db-pop--' + fc.id });
  }

  function facetHeader(titleKey, onClear) {
    return h('div', { class: 'mt-db-pop__head' }, h('span', { class: 'mt-db-pop__title' }, t(titleKey)),
      h('button', { type: 'button', class: 'mt-db-link', onclick: onClear }, t('db.filter.clearOne')));
  }

  function chainFacet(base) {
    var counts = MT.data.countsByChain(base);
    var sel = toSet(state.filters.chains);
    var body = h('div', { class: 'mt-db-pop__body' });
    var search = h('input', { class: 'mt-input mt-input--sm', type: 'search', placeholder: t('db.filter.chainSearch'), 'aria-label': t('db.filter.chainSearch') });
    function apply() { dbui.setFilters({ chains: Object.keys(sel).filter(function (k) { return sel[k]; }) }); }
    function render() {
      U.clear(body);
      var q = U.normalize(search.value);
      chainsByGroup().forEach(function (g) {
        var chains = g.chains.filter(function (c) { return !q || U.normalize(c.name + ' ' + c.legendName).indexOf(q) >= 0; });
        if (!chains.length) return;
        var allOn = chains.every(function (c) { return sel[c.id]; });
        var someOn = chains.some(function (c) { return sel[c.id]; });
        var gbox = h('input', { type: 'checkbox', checked: allOn });
        gbox.indeterminate = someOn && !allOn;
        gbox.addEventListener('change', function () { chains.forEach(function (c) { sel[c.id] = gbox.checked; }); apply(); render(); });
        body.appendChild(h('label', { class: 'mt-check mt-db-pop__group' }, gbox, h('span', null, t('data.group.' + g.group))));
        chains.forEach(function (c) {
          var box = h('input', { type: 'checkbox', checked: !!sel[c.id] });
          box.addEventListener('change', function () { sel[c.id] = box.checked; apply(); render(); });
          body.appendChild(h('label', { class: 'mt-check mt-db-pop__opt' + (counts[c.id] ? '' : ' is-empty') }, box, logoImg(c.id, 20),
            h('span', { class: 'mt-db-pop__name' }, c.name, c.unknown ? h('small', { class: 'mt-db-pop__flag' }, t('data.unknownChain')) : null),
            h('span', { class: 'mt-db-pop__n' }, fmtNum(counts[c.id] || 0))));
        });
      });
      if (!body.childNodes.length) body.appendChild(h('div', { class: 'mt-db-pop__empty' }, t('db.filter.noMatch')));
      // Keep the focused checkbox when re-rendering with the keyboard.
    }
    search.addEventListener('input', render);
    render();
    return h('div', null, facetHeader('db.filter.chainsTitle', function () { sel = {}; apply(); render(); }),
      MT.data.chains().length > 8 ? h('div', { class: 'mt-db-pop__search' }, search) : null, body);
  }

  function listFacet(fc, base) {
    var counts = {};
    base.forEach(function (s) { counts[s[fc.field]] = (counts[s[fc.field]] || 0) + 1; });
    var sel = toSet(state.filters[fc.id]);
    var body = h('div', { class: 'mt-db-pop__body' });
    fc.values().forEach(function (v) {
      var box = h('input', { type: 'checkbox', checked: !!sel[v] });
      box.addEventListener('change', function () {
        sel[v] = box.checked;
        var patch = {}; patch[fc.id] = fc.values().filter(function (x) { return sel[x]; });
        dbui.setFilters(patch);
      });
      body.appendChild(h('label', { class: 'mt-check mt-db-pop__opt' }, box,
        fc.id === 'statuses' ? statusBadge(v) : h('span', { class: 'mt-db-pop__name' }, fc.valueLabel(v)),
        h('span', { class: 'mt-db-pop__n' }, fmtNum(counts[v] || 0))));
    });
    return h('div', null, facetHeader(fc.label, function () {
      U.$$('input', body).forEach(function (i) { i.checked = false; });
      sel = {}; var patch = {}; patch[fc.id] = []; dbui.setFilters(patch);
    }), body);
  }

  function locationFacet(all) {
    var base = dbui.filterStores(all, state.filters, 'location');
    var body = h('div', { class: 'mt-db-pop__body mt-db-pop__body--form' });
    function render() {
      U.clear(body);
      var f = state.filters;
      var deps = {}, provs = {}, dists = {}, none = 0;
      base.forEach(function (s) {
        if (!s.department && !s.ubigeo) { none++; return; }
        deps[s.department] = (deps[s.department] || 0) + 1;
        if (f.department && s.department === f.department) provs[s.province] = (provs[s.province] || 0) + 1;
        if (f.province && s.province === f.province && s.department === f.department) {
          var k = s.ubigeo || s.district;
          if (!dists[k]) dists[k] = { n: 0, name: s.district || s.ubigeo };
          dists[k].n++;
        }
      });
      // Departments from the districts file too, so empty ones can still be chosen (e.g. before a scan).
      MT.data.districts.all().forEach(function (d) { if (!(d.department in deps)) deps[d.department] = 0; });
      function sel(labelKey, value, options, onChange, disabled) {
        var s = h('select', { class: 'mt-select mt-select--sm', disabled: !!disabled },
          h('option', { value: '' }, t('db.filter.any')),
          options.map(function (o) { return h('option', { value: o.value, selected: o.value === value }, o.label); }));
        s.addEventListener('change', function () { onChange(s.value); });
        return h('label', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t(labelKey)), s);
      }
      var depOpts = U.sortBy(Object.keys(deps).filter(Boolean), function (k) { return k; }).map(function (k) { return { value: k, label: k + ' (' + fmtNum(deps[k]) + ')' }; });
      if (none) depOpts.push({ value: NONE, label: t('db.filter.noLocation') + ' (' + fmtNum(none) + ')' });
      body.appendChild(sel('data.col.department', f.department, depOpts, function (v) { dbui.setFilters({ department: v }); render(); }));
      var provOpts = U.sortBy(Object.keys(provs), function (k) { return k; }).map(function (k) { return { value: k, label: k + ' (' + fmtNum(provs[k]) + ')' }; });
      body.appendChild(sel('data.col.province', f.province, provOpts, function (v) { dbui.setFilters({ province: v }); render(); }, !f.department || f.department === NONE));
      var distOpts = U.sortBy(Object.keys(dists), function (k) { return dists[k].name; }).map(function (k) { return { value: k, label: dists[k].name + ' (' + fmtNum(dists[k].n) + ')' }; });
      body.appendChild(sel('data.col.district', f.ubigeo, distOpts, function (v) { dbui.setFilters({ ubigeo: v }); render(); }, !f.province));
    }
    render();
    return h('div', null, facetHeader('db.filter.locationTitle', function () { dbui.setFilters({ department: '', province: '', ubigeo: '' }); render(); }), body);
  }

  /* ---- Body: table + resizer + map ----------------------------------------------------------- */
  var COLS = [
    { id: 'check', width: 44 },
    { id: 'chain', width: 156, sort: 'chain', label: 'data.col.chain' },
    { id: 'name', sort: 'name', label: 'db.col.store' },
    { id: 'district', width: 176, sort: 'district', label: 'data.col.district' },
    { id: 'status', width: 132, sort: 'status', label: 'data.col.status' },
    { id: 'source', width: 122, sort: 'source', label: 'data.col.source', minWidth: 760 },
    { id: 'updated', width: 108, sort: 'updated', label: 'data.col.updated', minWidth: 880 },
  ];
  var visibleCols = COLS;
  var ROW_H = 52;
  var rendered = { first: -1, last: -1 };

  function buildBody() {
    els.table = h('table', { class: 'mt-table mt-db-table', role: 'grid', 'aria-label': t('tab.db') });
    els.colgroup = h('colgroup');
    els.thead = h('thead');
    els.tbody = h('tbody');
    els.table.append(els.colgroup, els.thead, els.tbody);
    els.tableWrap = h('div', { class: 'mt-table-wrap mt-db-tablewrap', tabindex: '0', 'aria-label': t('db.table.label') }, els.table);
    els.empty = h('div', { class: 'mt-db-empty', hidden: true });
    els.bulk = h('div', { class: 'mt-db-bulk', hidden: true, role: 'toolbar', 'aria-label': t('db.bulk.label') });
    els.tablePane = h('div', { class: 'mt-db-tablepane' }, els.tableWrap, els.empty, els.bulk);
    els.mapEl = h('div', { class: 'mt-db-map' });
    els.mapChip = h('div', { class: 'mt-db-mapchip', 'aria-live': 'polite' });
    els.mapPane = h('div', { class: 'mt-db-mappane' }, els.mapEl, els.mapChip);
    els.resizer = h('div', { class: 'mt-db-resizer', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': t('db.map.resize'), title: t('db.map.resize') });
    els.body = h('div', { class: 'mt-db-body' }, els.tablePane, els.resizer, els.mapPane);
    els.root.appendChild(els.body);
    applyMapWidth();
    setShowMap(state.showMap, true);

    els.tableWrap.addEventListener('scroll', function () { requestAnimationFrame(function () { renderRows(false); }); }, { passive: true });
    els.tableWrap.addEventListener('keydown', onTableKey);
    // Double-click = edit. Detected from the click's detail: selecting re-renders the rows, so the
    // second click lands on a new <tr> and the browser never fires 'dblclick'.
    els.tbody.addEventListener('click', onRowClick);
    if (window.ResizeObserver) new ResizeObserver(U.debounce(function () { updateVisibleCols(); renderRows(true); }, 50)).observe(els.tableWrap);
    initResizer();
    renderTableHead();
  }

  function updateVisibleCols() {
    var w = els.tableWrap.clientWidth || 1200;
    var next = COLS.filter(function (c) { return !c.minWidth || w >= c.minWidth; });
    if (next.length !== visibleCols.length) { visibleCols = next; renderTableHead(); }
  }

  function renderTableHead() {
    U.clear(els.colgroup); U.clear(els.thead);
    visibleCols.forEach(function (c) { els.colgroup.appendChild(h('col', { style: c.width ? { width: c.width + 'px' } : null })); });
    var tr = h('tr');
    visibleCols.forEach(function (c) {
      if (c.id === 'check') {
        els.checkAll = h('input', { type: 'checkbox', class: 'mt-db-check', 'aria-label': t('db.bulk.selectAll') });
        els.checkAll.addEventListener('change', function () {
          if (els.checkAll.checked) state.list.forEach(function (s) { if (!state.deleted[s.id]) state.checked[s.id] = true; });
          else state.checked = {};
          renderRows(true); renderBulk();
        });
        tr.appendChild(h('th', { class: 'mt-db-th-check', scope: 'col' }, els.checkAll));
        return;
      }
      var active = state.sort.key === c.sort;
      var th = h('th', { scope: 'col', class: 'is-sortable' + (active ? ' is-sorted' : ''), tabindex: '0',
        'aria-sort': active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none' }, t(c.label));
      var go = function () { setSort(c.sort); };
      th.addEventListener('click', go);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      tr.appendChild(th);
    });
    els.thead.appendChild(tr);
    syncCheckAll();
  }
  function setSort(key) {
    state.sort = state.sort.key === key ? { key: key, dir: -state.sort.dir } : { key: key, dir: 1 };
    MT.storage.setPref('db.sort', state.sort);
    refresh({});
    renderTableHead();
  }

  /** Re-filter, re-sort and re-render everything that depends on the store list. */
  function refresh(opts) {
    opts = opts || {};
    var f = state.filters;
    var list = MT.data.stores({ includeClosed: true });
    state.deleted = {};
    if (f.local) {
      // Locally deleted seed stores only appear in the "local changes" view (to restore them).
      var del = MT.data.deletedStores();
      del.forEach(function (s) { state.deleted[s.id] = true; });
      list = list.concat(del);
    }
    state.list = sortList(dbui.filterStores(list, f), state.sort);
    // Forget checks of rows that disappeared.
    var ids = toSet(state.list.map(function (s) { return s.id; }));
    Object.keys(state.checked).forEach(function (id) { if (!ids[id]) delete state.checked[id]; });
    if (opts.resetScroll) els.tableWrap.scrollTop = 0;
    renderHeaderMeta();
    renderFilterButtons();
    renderCount();
    renderRows(true);
    renderEmpty();
    renderBulk();
    updateMapData(opts.fit);
    MT.bus.emit('db:filtered', { count: state.list.length }); // also re-renders the changes cluster
  }

  function renderCount() {
    var total = MT.data.stores({ includeClosed: true }).length;
    var n = state.list.length;
    U.clear(els.count);
    els.count.appendChild(n === total && !state.filters.local
      ? h('span', null, t('db.count.all', { n: fmtNum(total) }))
      : h('span', null, t('db.count.some', { n: fmtNum(n), total: fmtNum(total) })));
  }

  function renderEmpty() {
    U.clear(els.empty);
    var empty = !state.list.length;
    els.empty.hidden = !empty;
    els.tableWrap.classList.toggle('is-empty', empty);
    if (!empty) return;
    var hasAny = MT.data.stores({ includeClosed: true }).length > 0;
    if (hasAny) {
      els.empty.appendChild(MT.ui.emptyState({ icon: 'search', title: t('db.empty.filteredTitle'), text: t('db.empty.filteredText'),
        action: MT.ui.button({ label: t('db.filter.clear'), kind: 'secondary', onClick: function () { els.search.value = ''; dbui.clearFilters(); } }) }));
    } else {
      els.empty.appendChild(MT.ui.emptyState({ icon: 'database', title: t('db.empty.noneTitle'),
        text: t(MT.data.missing.stores ? 'db.empty.missingText' : 'db.empty.noneText'),
        action: h('div', { class: 'mt-row mt-row--wrap', style: { justifyContent: 'center' } },
          MT.ui.button({ icon: 'upload', label: t('common.import'), kind: 'secondary', onClick: startImport }),
          MT.ui.button({ icon: 'globe', label: t('db.actions.scan'), kind: 'secondary', onClick: function () { dbui.openScan(); }, disabled: !MT.data.districts.available }),
          MT.ui.button({ icon: 'plus', label: t('db.actions.add'), kind: 'primary', onClick: function () { dbui.openEditor(null); } })) }));
    }
  }

  /** Virtualized rows: only the visible window (+ overscan) is in the DOM. */
  function renderRows(force) {
    if (!els.tbody) return;
    var n = state.list.length;
    var top = els.tableWrap.scrollTop, hgt = els.tableWrap.clientHeight || 600;
    var first = Math.max(0, Math.floor(top / ROW_H) - 10);
    var last = Math.min(n, Math.ceil((top + hgt) / ROW_H) + 10);
    if (!force && first === rendered.first && last === rendered.last) return;
    rendered = { first: first, last: last };
    var frag = document.createDocumentFragment();
    var span = visibleCols.length;
    frag.appendChild(h('tr', { class: 'mt-db-spacer', 'aria-hidden': 'true' }, h('td', { colspan: span, style: { height: first * ROW_H + 'px' } })));
    for (var i = first; i < last; i++) frag.appendChild(rowEl(state.list[i], i));
    frag.appendChild(h('tr', { class: 'mt-db-spacer', 'aria-hidden': 'true' }, h('td', { colspan: span, style: { height: (n - last) * ROW_H + 'px' } })));
    U.clear(els.tbody).appendChild(frag);
    els.table.setAttribute('aria-rowcount', String(n + 1));
    // Measure the real row height once (fonts/zoom may differ) so the spacers stay exact.
    var probe = els.tbody.querySelector('tr[data-id]');
    if (probe && probe.offsetHeight && Math.abs(probe.offsetHeight - ROW_H) > 0.5) { ROW_H = probe.offsetHeight; renderRows(true); }
  }

  function rowEl(s, i) {
    var state_ = MT.data.storeState(s.id);
    var deleted = !!state.deleted[s.id];
    var chain = MT.data.chain(s.chain);
    var tr = h('tr', { 'data-id': s.id, id: 'db-row-' + i, 'aria-rowindex': String(i + 2), 'aria-selected': String(state.selected === s.id),
      class: (state.selected === s.id ? 'is-selected' : '') + (state.checked[s.id] ? ' is-checked' : '') + (s.status === 'closed' || deleted ? ' is-muted' : '') + (deleted ? ' is-deleted' : '') });
    visibleCols.forEach(function (c) {
      var td;
      switch (c.id) {
        case 'check':
          td = h('td', { class: 'mt-db-td-check' }, deleted ? null : h('input', { type: 'checkbox', class: 'mt-db-check', checked: !!state.checked[s.id], tabindex: '-1', 'aria-label': t('db.bulk.selectOne', { name: s.name }) }));
          break;
        case 'chain':
          td = h('td', null, h('div', { class: 'mt-db-cell-chain' }, logoImg(s.chain, 22), h('span', { class: 'mt-truncate' }, chain.name)));
          break;
        case 'name':
          var badge = deleted ? h('span', { class: 'mt-badge mt-badge--danger' }, t('db.state.deleted'))
            : state_ === 'added' && MT.data.storeOrphan(s.id) ? h('span', { class: 'mt-badge mt-badge--warn', title: t('db.state.orphanHint') }, t('db.state.orphan'))
            : state_ === 'added' ? h('span', { class: 'mt-badge mt-badge--info' }, t('db.state.added'))
              : state_ === 'edited' ? h('span', { class: 'mt-badge mt-badge--accent' }, t('db.state.edited')) : null;
          td = h('td', null, h('div', { class: 'mt-db-cell-2' },
            h('div', { class: 'mt-db-cell-2__top' }, h('span', { class: 'mt-truncate mt-db-name' }, s.name || h('em', { class: 'mt-muted' }, t('db.noName'))), badge,
              isFinite(s.lat) ? null : h('span', { class: 'mt-badge mt-badge--warn', title: t('db.noCoordsHint') }, t('db.noCoords'))),
            h('div', { class: 'mt-db-cell-2__sub mt-truncate' }, s.address || '')));
          break;
        case 'district':
          td = h('td', null, h('div', { class: 'mt-db-cell-2' },
            h('div', { class: 'mt-db-cell-2__top mt-truncate' }, s.district || h('span', { class: 'mt-muted' }, t('db.noDistrict'))),
            h('div', { class: 'mt-db-cell-2__sub mt-truncate' }, [s.province, s.department].filter(Boolean).join(', '))));
          break;
        case 'status': td = h('td', null, statusBadge(s.status)); break;
        case 'source':
          td = h('td', null, h('div', { class: 'mt-db-cell-2' }, h('div', { class: 'mt-db-cell-2__top' }, t('data.source.' + s.source)),
            h('div', { class: 'mt-db-cell-2__sub' + (s.precision === 'approx' ? ' is-approx' : '') }, t('data.precision.' + s.precision))));
          break;
        case 'updated': td = h('td', { class: 'is-num mt-db-td-date' }, fmtDate(s.updated)); break;
      }
      tr.appendChild(td);
    });
    return tr;
  }

  function onRowClick(e) {
    var tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    var id = tr.dataset.id;
    if (e.target.matches('input.mt-db-check')) {
      if (e.target.checked) state.checked[id] = true; else delete state.checked[id];
      tr.classList.toggle('is-checked', !!state.checked[id]);
      renderBulk(); syncCheckAll();
      return;
    }
    if (e.detail === 2 && !e.target.closest('input,button')) { dbui.openEditor(id); return; }
    if (e.detail > 2) return;
    dbui.select(id, { source: 'table' });
  }
  function onTableKey(e) {
    if (e.target !== els.tableWrap) return;
    var i = state.list.findIndex(function (s) { return s.id === state.selected; });
    var n = state.list.length;
    if (!n) return;
    var next = null;
    if (e.key === 'ArrowDown') next = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'PageDown') next = Math.min(n - 1, i + Math.floor(els.tableWrap.clientHeight / ROW_H));
    else if (e.key === 'PageUp') next = Math.max(0, i - Math.floor(els.tableWrap.clientHeight / ROW_H));
    else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); dbui.openEditor(state.selected); return; }
    else if (e.key === ' ' && i >= 0 && !state.deleted[state.selected]) {
      e.preventDefault();
      if (state.checked[state.selected]) delete state.checked[state.selected]; else state.checked[state.selected] = true;
      renderRows(true); renderBulk(); syncCheckAll(); return;
    }
    if (next === null) return;
    e.preventDefault();
    dbui.select(state.list[next < 0 ? 0 : next].id, { source: 'key' });
  }
  function scrollToIndex(i, center) {
    var wrap = els.tableWrap, headH = els.thead.offsetHeight || 36;
    var y = i * ROW_H;
    if (center) { wrap.scrollTop = Math.max(0, y - wrap.clientHeight / 2 + ROW_H); return; }
    if (y < wrap.scrollTop) wrap.scrollTop = y;
    else if (y + ROW_H + headH > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = y + ROW_H + headH - wrap.clientHeight;
  }

  /** Select a store: highlight the row, show it on the map. opts.source: 'table'|'map'|'key'|'api'. */
  dbui.select = function (id, opts) {
    opts = opts || {};
    // While the drawer is open it follows the selection (openEditor asks before dropping edits).
    if (ed.open && ed.id !== id && opts.source !== 'api') { dbui.openEditor(id); return; }
    state.selected = id;
    var i = state.list.findIndex(function (s) { return s.id === id; });
    if (i >= 0) scrollToIndex(i, opts.source === 'map' || opts.source === 'api');
    renderRows(true);
    if (i >= 0) els.tableWrap.setAttribute('aria-activedescendant', 'db-row-' + i);
    var s = MT.data.store(id) || MT.data.seedStore(id);
    updateSelectionOnMap(s, opts.source !== 'map');
    MT.bus.emit('db:selected', { id: id });
  };

  /* ---- Bulk actions ------------------------------------------------------------------------- */
  function syncCheckAll() {
    if (!els.checkAll) return;
    var n = Object.keys(state.checked).length;
    var total = state.list.filter(function (s) { return !state.deleted[s.id]; }).length;
    els.checkAll.checked = n > 0 && n === total;
    els.checkAll.indeterminate = n > 0 && n < total;
  }
  function renderBulk() {
    var ids = Object.keys(state.checked);
    U.clear(els.bulk);
    els.bulk.hidden = !ids.length;
    syncCheckAll();
    if (!ids.length) return;
    var setStatus = function (st) {
      return function () {
        MT.data.upsertStores(ids.map(function (id) { return { id: id, status: st }; }), { op: 'upsert' }).then(function (r) {
          MT.ui.toast(t('db.bulk.statusDone', { n: r.ids.length, status: t('data.status.' + st) }), { type: 'success' });
        }, function (err) { console.error(err); MT.ui.toast(t('db.error.save'), { type: 'error' }); });
      };
    };
    els.bulk.append(
      h('span', { class: 'mt-db-bulk__n' }, t('db.bulk.selected', { n: ids.length })),
      h('span', { class: 'mt-db-bulk__sep' }),
      h('span', { class: 'mt-db-bulk__label' }, t('db.bulk.markAs')),
      bulkBtn('success', t('data.status.verified'), setStatus('verified')),
      bulkBtn('warning', t('data.status.to_verify'), setStatus('to_verify')),
      bulkBtn('eyeOff', t('data.status.closed'), setStatus('closed')),
      h('span', { class: 'mt-db-bulk__sep' }),
      bulkBtn('trash', t('common.delete'), function () { bulkDelete(ids); }, 'is-danger'),
      h('button', { type: 'button', class: 'mt-db-bulk__x', title: t('db.bulk.clear'), 'aria-label': t('db.bulk.clear'), html: MT.ui.icon('close', { size: 16 }),
        onclick: function () { state.checked = {}; renderRows(true); renderBulk(); } }));
  }
  function bulkBtn(icon, label, onClick, cls) {
    return h('button', { type: 'button', class: 'mt-db-bulk__btn' + (cls ? ' ' + cls : ''), onclick: onClick }, MT.ui.iconEl(icon, { size: 15 }), label);
  }
  function bulkDelete(ids) {
    MT.ui.confirm(t('db.bulk.deleteText', { n: ids.length }), { title: t('db.bulk.deleteTitle', { n: ids.length }), okLabel: t('common.delete'), danger: true }).then(function (ok) {
      if (!ok) return;
      state.checked = {};
      ids.reduce(function (p, id) { return p.then(function () { return MT.data.deleteStore(id); }); }, Promise.resolve()).then(function () {
        MT.ui.toast(t('db.bulk.deleteDone', { n: ids.length }), { type: 'success', action: { label: t('db.changes.view'), onClick: function () { dbui.setFilters({ local: true }); } } });
      });
    });
  }

  /* ---- Map ---------------------------------------------------------------------------------- */
  function setShowMap(on, initial) {
    state.showMap = !!on;
    MT.storage.setPref('db.showMap', state.showMap);
    els.body.classList.toggle('is-nomap', !state.showMap);
    els.mapToggle.classList.toggle('is-on', state.showMap);
    els.mapToggle.setAttribute('aria-pressed', String(state.showMap));
    if (state.showMap && !map && !initial) initMap();
    if (map) setTimeout(function () { map.resize(); }, 0);
  }
  function applyMapWidth() {
    var w = state.mapWidth || 0;
    els.body.style.setProperty('--db-map-w', w ? w + 'px' : '42%');
  }
  function initResizer() {
    var startX, startW;
    function move(e) {
      var total = els.body.clientWidth;
      var w = U.clamp(startW - (e.clientX - startX), 300, total - 420);
      state.mapWidth = Math.round(w); applyMapWidth();
    }
    function up() {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      els.body.classList.remove('is-resizing');
      MT.storage.setPref('db.mapWidth', state.mapWidth);
      if (map) map.resize();
    }
    els.resizer.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      startX = e.clientX; startW = els.mapPane.offsetWidth;
      els.body.classList.add('is-resizing');
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
    els.resizer.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? 32 : e.key === 'ArrowRight' ? -32 : 0;
      if (!d) return;
      e.preventDefault();
      state.mapWidth = Math.round(U.clamp(els.mapPane.offsetWidth + d, 300, els.body.clientWidth - 420));
      applyMapWidth(); MT.storage.setPref('db.mapWidth', state.mapWidth);
    });
  }

  function initMap() {
    if (map || mapFailed || !window.maplibregl) return;
    map = dbui.createMap(els.mapEl, { map: { bounds: MT.geo.bboxToBounds(MT.geo.PERU_BBOX), fitBoundsOptions: { padding: 20 } } });
    if (!map) { mapFailed = true; return; }   // no WebGL: the table and the editor keep working
    dbui._map = map;
    map.on('load', function () {
      map.addSource('db-stores', { type: 'geojson', data: storesGeoJSON(), promoteId: 'id' });
      map.addLayer({ id: 'db-sel-halo', type: 'circle', source: 'db-stores', filter: ['==', ['get', 'id'], ''],
        paint: { 'circle-radius': HALO_RADIUS, 'circle-color': MT.theme.colors.accent, 'circle-opacity': 0.18,
          'circle-stroke-color': MT.theme.colors.accent, 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'db-stores', type: 'circle', source: 'db-stores',
        paint: { 'circle-radius': CIRCLE_RADIUS, 'circle-color': ['get', 'color'], 'circle-opacity': ['case', ['get', 'closed'], 0.4, 0.95],
          'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 1.4] } });
      mapReady = true;
      fitMap(true);
      if (state.selected) updateSelectionOnMap(MT.data.store(state.selected), false);
    });
    map.on('click', 'db-stores', function (e) {
      var f = e.features && e.features[0];
      if (f) dbui.select(f.properties.id, { source: 'map' });
    });
    hoverTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'mt-db-tip', maxWidth: '260px' });
    map.on('mousemove', 'db-stores', function (e) {
      map.getCanvas().style.cursor = 'pointer';
      var f = e.features && e.features[0];
      if (!f) return;
      var s = MT.data.store(f.properties.id);
      if (!s || (popup && popup.isOpen() && popup._storeId === s.id)) { hoverTip.remove(); return; }
      hoverTip.setLngLat([s.lng, s.lat]).setDOMContent(h('div', null, h('strong', null, s.name), h('div', { class: 'mt-db-tip__sub' }, MT.data.chain(s.chain).name + (s.district ? ' · ' + s.district : '')))).addTo(map);
    });
    map.on('mouseleave', 'db-stores', function () { map.getCanvas().style.cursor = ''; hoverTip.remove(); });
  }

  function storesGeoJSON() {
    var feats = [];
    state.list.forEach(function (s) {
      if (state.deleted[s.id] || !isFinite(s.lat) || !isFinite(s.lng)) return;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { id: s.id, color: MT.data.chain(s.chain).color, closed: s.status === 'closed' } });
    });
    return { type: 'FeatureCollection', features: feats };
  }
  function updateMapData(fit) {
    var gj = storesGeoJSON();
    var noCoords = state.list.filter(function (s) { return !state.deleted[s.id] && !isFinite(s.lat); }).length;
    U.clear(els.mapChip);
    els.mapChip.appendChild(h('span', null, t('db.map.count', { n: fmtNum(gj.features.length) })));
    if (noCoords) els.mapChip.appendChild(h('span', { class: 'mt-db-mapchip__warn' }, t('db.map.noCoords', { n: noCoords })));
    if (state.showMap && !map) initMap();
    if (!map || !mapReady) return;
    map.getSource('db-stores').setData(gj);
    if (fit) fitMap(false);
  }
  function fitMap(instant) {
    if (!map || !mapReady) return;
    var pts = state.list.filter(function (s) { return !state.deleted[s.id] && isFinite(s.lat) && isFinite(s.lng); });
    var b = MT.geo.bboxOfPoints(pts);
    if (!b) return;
    b = MT.geo.bboxMinSize(b, 1500);
    map.fitBounds(MT.geo.bboxToBounds(b), { padding: 48, maxZoom: 15.5, duration: instant ? 0 : 450 });
  }
  function updateSelectionOnMap(s, fly) {
    if (!map || !mapReady) return;
    map.setFilter('db-sel-halo', ['==', ['get', 'id'], s ? s.id : '']);
    if (popup) { popup.remove(); popup = null; }
    if (hoverTip) hoverTip.remove();
    if (!s || !isFinite(s.lat) || state.deleted[s.id]) return;
    if (fly) map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 14.5), duration: 550 });
    // focusAfterOpen:false keeps keyboard focus in the table (arrow-key browsing).
    popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 14, className: 'mt-db-popup', maxWidth: '300px', focusAfterOpen: false })
      .setLngLat([s.lng, s.lat]).setDOMContent(storeCard(s)).addTo(map);
    popup._storeId = s.id;
  }
  function storeCard(s) {
    var c = MT.data.chain(s.chain);
    var gmaps = 'https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lng;
    return h('div', { class: 'mt-db-card' },
      h('div', { class: 'mt-db-card__head' }, logoImg(s.chain, 28),
        h('div', { class: 'mt-db-card__titles' }, h('div', { class: 'mt-db-card__title' }, s.name), h('div', { class: 'mt-db-card__chain' }, c.name))),
      s.address ? h('div', { class: 'mt-db-card__line' }, s.address) : null,
      h('div', { class: 'mt-db-card__line mt-muted' }, [s.district, s.province].filter(Boolean).join(', ') || t('db.noDistrict')),
      h('div', { class: 'mt-db-card__meta' }, statusBadge(s.status), h('span', { class: 'mt-badge' }, t('data.source.' + s.source)),
        s.precision === 'approx' ? h('span', { class: 'mt-badge mt-badge--warn' }, t('data.precision.approx')) : null),
      h('div', { class: 'mt-db-card__actions' },
        MT.ui.button({ icon: 'edit', label: t('common.edit'), kind: 'primary', size: 'sm', onClick: function () { dbui.openEditor(s.id); } }),
        h('a', { class: 'mt-db-card__ext', href: gmaps, target: '_blank', rel: 'noopener noreferrer' }, t('db.card.gmaps'))));
  }

  /* =========================================================================================
   * Edit drawer
   * ======================================================================================= */
  var ed = { open: false, id: null, isNew: false, draft: null, orig: null, map: null, marker: null, mapReady: false, results: [], searchCtl: null, errors: {} };

  function buildDrawer() {
    els.drawer = h('aside', { class: 'mt-drawer mt-db-drawer', 'aria-hidden': 'true', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'mt-db-drawer-title', inert: true });
    els.drawerTitle = h('h2', { class: 'mt-drawer__title', id: 'mt-db-drawer-title' });
    els.drawerSub = h('div', { class: 'mt-db-drawer__sub' });
    els.drawerBody = h('div', { class: 'mt-drawer__body mt-db-form' });
    els.drawerFoot = h('div', { class: 'mt-drawer__footer mt-db-drawer__foot' });
    els.drawer.append(
      h('div', { class: 'mt-drawer__header' }, h('div', { class: 'mt-db-drawer__titles' }, els.drawerTitle, els.drawerSub),
        h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon', title: t('common.close'), 'aria-label': t('common.close'), html: MT.ui.icon('close'), onclick: function () { closeEditor(); } })),
      els.drawerBody, els.drawerFoot);
    els.drawer.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.body.classList.contains('mt-has-modal') && !openPop) { e.preventDefault(); closeEditor(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); }
    });
    els.root.appendChild(els.drawer);
  }

  function blankDraft() {
    var f = state.filters;
    var chain = f.chains.length === 1 ? f.chains[0] : '';
    return { id: '', chain: chain, name: '', address: '', district: '', province: '', department: '', ubigeo: '',
      lat: NaN, lng: NaN, precision: 'exact', source: 'manual', source_ref: '', status: 'verified', notes: '', updated: '' };
  }

  /** Open the drawer for a store id (null = new store). */
  dbui.openEditor = function (id, opts) {
    var go = function () {
      var s = id ? (MT.data.store(id) || MT.data.seedStore(id)) : null;
      if (id && !s) return;
      ed.id = id; ed.isNew = !id;
      ed.draft = Object.assign(blankDraft(), s ? U.clone(s) : {}, opts && opts.draft ? opts.draft : {});
      if (s) { ed.draft.lat = s.lat; ed.draft.lng = s.lng; }
      ed.orig = U.clone(ed.draft);
      ed.errors = {}; ed.results = []; ed.coordMsg = null; ed.searchMsg = null;
      ed.open = true;
      els.drawer.classList.add('is-open');
      els.drawer.setAttribute('aria-hidden', 'false');
      els.drawer.inert = false;
      renderEditor();
      initEditorMap();
      if (id) dbui.select(id, { source: 'api' });
      setTimeout(function () {
        var first = U.$(ed.isNew ? '#mt-db-f-chain' : '#mt-db-f-name', els.drawer);
        if (first) first.focus();
      }, 60);
    };
    if (ed.open && isDirty()) {
      return confirmDiscard().then(function (ok) { if (ok) go(); });
    }
    go();
    return Promise.resolve();
  };
  function isDirty() {
    if (!ed.open || !ed.draft) return false;
    return MT.data.COLUMNS.some(function (c) {
      var a = ed.draft[c], b = ed.orig[c];
      if (c === 'lat' || c === 'lng') {
        // The JSON clone of the original turns NaN into null: both mean "no coordinate".
        var na = a === null || a === undefined || !isFinite(a), nb = b === null || b === undefined || !isFinite(b);
        return na !== nb || (!na && +a !== +b);
      }
      return String(a == null ? '' : a) !== String(b == null ? '' : b);
    });
  }
  function confirmDiscard() {
    return MT.ui.confirm(t('db.edit.discardText'), { title: t('db.edit.discardTitle'), okLabel: t('db.edit.discardOk'), danger: true });
  }
  function closeEditor(force) {
    if (!ed.open) return Promise.resolve(true);
    if (!force && isDirty()) return confirmDiscard().then(function (ok) { if (ok) closeEditor(true); return ok; });
    ed.open = false;
    if (ed.searchCtl) ed.searchCtl.abort();
    els.drawer.classList.remove('is-open');
    els.drawer.setAttribute('aria-hidden', 'true');
    els.drawer.inert = true;
    if (els.tableWrap) els.tableWrap.focus({ preventScroll: true });
    return Promise.resolve(true);
  }
  dbui.closeEditor = closeEditor;

  function field(labelKey, control, opts) {
    opts = opts || {};
    return h('label', { class: 'mt-field' + (opts.className ? ' ' + opts.className : ''), for: control.id || null },
      h('span', { class: 'mt-label' }, t(labelKey), opts.required ? h('span', { class: 'mt-db-req', 'aria-hidden': 'true' }, ' *') : null, opts.hint ? h('small', null, ' ' + opts.hint) : null),
      control, h('div', { class: 'mt-field__error', role: 'alert' }, opts.error || ''));
  }
  function input(id, key, opts) {
    opts = opts || {};
    var el = h('input', { class: 'mt-input' + (ed.errors[key] ? ' is-invalid' : ''), id: id, type: 'text', value: ed.draft[key] == null ? '' : ed.draft[key],
      placeholder: opts.placeholder || null, autocomplete: 'off', spellcheck: opts.spellcheck === false ? 'false' : null });
    el.addEventListener('input', function () { ed.draft[key] = el.value; if (ed.errors[key]) { delete ed.errors[key]; el.classList.remove('is-invalid'); } updateFooter(); });
    return el;
  }

  function renderEditor() {
    var d = ed.draft, s = ed.id ? (MT.data.store(ed.id) || MT.data.seedStore(ed.id)) : null;
    var lstate = ed.id ? MT.data.storeState(ed.id) : null;
    var deleted = lstate === 'deleted';
    els.drawerTitle.textContent = t(ed.isNew ? 'db.edit.addTitle' : 'db.edit.editTitle');
    U.clear(els.drawerSub);
    if (!ed.isNew) U.append(els.drawerSub, [h('span', { class: 'mt-mono' }, ed.id), lstate && lstate !== 'seed' ? h('span', { class: 'mt-badge mt-badge--' + (lstate === 'deleted' ? 'danger' : lstate === 'added' ? 'info' : 'accent') }, t('db.state.' + lstate)) : null]);
    else U.append(els.drawerSub, h('span', { class: 'mt-muted' }, t('db.edit.addSub')));

    var body = els.drawerBody;
    U.clear(body);
    if (ed.id && MT.data.storeOrphan(ed.id)) {
      // Edited here, but the published database no longer has this id (a re-scan changed it, or
      // it was merged): the edit is kept as a local store so nothing is lost — the user decides.
      body.appendChild(h('div', { class: 'mt-db-notice mt-db-notice--warn' }, MT.ui.iconEl('warning', { size: 18 }),
        h('div', null, h('strong', null, t('db.edit.orphanTitle')), h('div', null, t('db.edit.orphanText')))));
    }
    if (deleted) {
      body.appendChild(h('div', { class: 'mt-db-notice mt-db-notice--danger' }, MT.ui.iconEl('trash', { size: 18 }),
        h('div', null, h('strong', null, t('db.edit.deletedTitle')), h('div', null, t('db.edit.deletedText'))),
        MT.ui.button({ icon: 'undo', label: t('common.restore'), kind: 'secondary', size: 'sm', onClick: function () {
          MT.data.restoreStore(ed.id).then(function () { MT.ui.toast(t('db.edit.restored'), { type: 'success' }); ed.open = false; dbui.openEditor(ed.id); });
        } })));
    }

    /* -- Datos -- */
    var chainSel = h('select', { class: 'mt-select' + (ed.errors.chain ? ' is-invalid' : ''), id: 'mt-db-f-chain' },
      h('option', { value: '' }, t('db.edit.chooseChain')),
      chainsByGroup().map(function (g) {
        return h('optgroup', { label: t('data.group.' + g.group) }, g.chains.map(function (c) {
          return h('option', { value: c.id, selected: c.id === d.chain }, c.name + (c.unknown ? ' (' + t('data.unknownChain') + ')' : ''));
        }));
      }));
    chainSel.addEventListener('change', function () {
      d.chain = chainSel.value; delete ed.errors.chain; chainSel.classList.remove('is-invalid');
      updateChainPreview(); updatePin(false); updateFooter();
    });
    els.chainPreview = h('span', { class: 'mt-db-chainprev' });
    body.appendChild(section('db.edit.secData', 'store', [
      field('data.col.chain', h('div', { class: 'mt-db-chainrow' }, els.chainPreview, chainSel), { required: true, error: ed.errors.chain }),
      field('data.col.name', input('mt-db-f-name', 'name', { placeholder: t('db.edit.namePh') }), { required: true, error: ed.errors.name }),
      field('data.col.address', input('mt-db-f-address', 'address', { placeholder: t('db.edit.addressPh') })),
    ]));
    updateChainPreview();

    /* -- Ubicación -- */
    els.miniMapEl = els.miniMapEl || h('div', { class: 'mt-db-minimap' });
    els.miniHint = h('div', { class: 'mt-db-minimap__hint' });
    els.latIn = h('input', { class: 'mt-input mt-input--sm mt-input--num', id: 'mt-db-f-lat', inputmode: 'decimal', value: isFinite(d.lat) ? d.lat.toFixed(6) : '', 'aria-label': t('data.col.lat') });
    els.lngIn = h('input', { class: 'mt-input mt-input--sm mt-input--num', id: 'mt-db-f-lng', inputmode: 'decimal', value: isFinite(d.lng) ? d.lng.toFixed(6) : '', 'aria-label': t('data.col.lng') });
    // Typed coordinates reach the draft on 'change' (blur/Enter) — and from saveEditor(), so
    // Ctrl+Enter while still typing in a coordinate box saves what is typed.
    var onLatLng = function () {
      var la = MT.io.parseCoord(els.latIn.value), ln = MT.io.parseCoord(els.lngIn.value);
      if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
        // Something typed that is not a coordinate: say so (on save it blocks the save).
        return String(els.latIn.value).trim() || String(els.lngIn.value).trim() ? 'invalid' : 'empty';
      }
      if (la === ed.draft.lat && ln === ed.draft.lng) return 'same';
      setPosition(la, ln, { precision: 'exact', fromInputs: true });
      return 'ok';
    };
    els.commitLatLng = onLatLng;
    els.latIn.addEventListener('change', onLatLng); els.lngIn.addEventListener('change', onLatLng);
    els.districtLine = h('div', { class: 'mt-db-district' });
    els.coordsIn = h('input', { class: 'mt-input', id: 'mt-db-f-paste', type: 'text', placeholder: t('db.edit.pastePh'), autocomplete: 'off', spellcheck: 'false' });
    els.coordsMsg = h('div', { class: 'mt-db-msg', role: 'status' });
    var useCoords = function () { applyPastedCoords(els.coordsIn.value); };
    els.coordsIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); useCoords(); } });
    els.coordsIn.addEventListener('paste', function () { setTimeout(useCoords, 0); });
    els.addrIn = h('input', { class: 'mt-input', id: 'mt-db-f-search', type: 'search', placeholder: t('db.edit.searchPh'), autocomplete: 'off' });
    els.addrBtn = MT.ui.button({ icon: 'search', label: t('common.search'), kind: 'secondary', size: 'sm', onClick: function () { runAddressSearch(); } });
    els.addrIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runAddressSearch(); } });
    els.addrResults = h('div', { class: 'mt-db-results', role: 'listbox', 'aria-label': t('db.edit.results') });
    els.posError = h('div', { class: 'mt-field__error', role: 'alert' }, ed.errors.coords || '');
    body.appendChild(section('db.edit.secLocation', 'pin', [
      h('div', { class: 'mt-db-minimap-wrap' + (ed.errors.coords ? ' is-invalid' : '') }, els.miniMapEl, els.miniHint),
      els.posError,
      h('div', { class: 'mt-db-latlng' },
        h('label', { class: 'mt-db-latlng__f' }, h('span', null, t('db.edit.lat')), els.latIn),
        h('label', { class: 'mt-db-latlng__f' }, h('span', null, t('db.edit.lng')), els.lngIn)),
      els.districtLine,
      h('div', { class: 'mt-field' }, h('label', { class: 'mt-label', for: 'mt-db-f-paste' }, t('db.edit.paste')),
        h('div', { class: 'mt-db-inline' }, els.coordsIn, MT.ui.button({ label: t('db.edit.use'), kind: 'secondary', size: 'sm', onClick: useCoords })), els.coordsMsg),
      h('div', { class: 'mt-field' }, h('label', { class: 'mt-label', for: 'mt-db-f-search' }, t('db.edit.search'), h('small', null, ' ' + t('db.edit.searchHint'))),
        h('div', { class: 'mt-db-inline' }, els.addrIn, els.addrBtn), els.addrResults),
    ]));
    renderDistrictLine();
    renderResults();

    /* -- Estado -- */
    var statusSeg = MT.ui.segmented({ ariaLabel: t('data.col.status'), value: d.status, options: MT.data.STATUSES.map(function (v) { return { value: v, label: t('data.status.' + v) }; }),
      onChange: function (v) { d.status = v; updateFooter(); } });
    statusSeg.classList.add('mt-seg--block');
    els.precSeg = MT.ui.segmented({ ariaLabel: t('data.col.precision'), value: d.precision, options: MT.data.PRECISIONS.map(function (v) { return { value: v, label: t('data.precision.' + v) }; }),
      onChange: function (v) { d.precision = v; updateFooter(); } });
    els.precSeg.classList.add('mt-seg--block');
    var srcSel = h('select', { class: 'mt-select', id: 'mt-db-f-source' }, MT.data.SOURCES.map(function (v) { return h('option', { value: v, selected: v === d.source }, t('data.source.' + v)); }));
    srcSel.addEventListener('change', function () { d.source = srcSel.value; updateFooter(); });
    var notes = h('textarea', { class: 'mt-textarea', id: 'mt-db-f-notes', rows: 3, placeholder: t('db.edit.notesPh') }, d.notes || '');
    notes.addEventListener('input', function () { d.notes = notes.value; updateFooter(); });
    body.appendChild(section('db.edit.secStatus', 'check', [
      h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('data.col.status')), statusSeg),
      h('div', { class: 'mt-db-grid2' },
        h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('data.col.precision')), els.precSeg),
        field('data.col.source', srcSel)),
      field('data.col.source_ref', input('mt-db-f-ref', 'source_ref', { placeholder: t('db.edit.refPh'), spellcheck: false })),
      field('data.col.notes', notes),
    ]));

    if (!ed.isNew && s) {
      body.appendChild(h('div', { class: 'mt-db-metabox' },
        h('div', null, h('span', { class: 'mt-muted' }, t('data.col.updated') + ': '), fmtDate(s.updated) || '—'),
        lstate === 'edited' ? h('button', { type: 'button', class: 'mt-db-link', onclick: undoLocal }, t('db.edit.undoLocal')) : null));
    }
    if (deleted) U.$$('input,select,textarea', body).forEach(function (x) { x.disabled = true; });
    renderFooter(deleted);
    if (ed.map) { updatePin(false); }
  }

  function section(titleKey, icon, children) {
    return h('section', { class: 'mt-db-sec' }, h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl(icon, { size: 15 }), t(titleKey)), children);
  }
  function updateChainPreview() {
    if (!els.chainPreview) return;
    U.clear(els.chainPreview);
    if (ed.draft.chain) els.chainPreview.appendChild(logoImg(ed.draft.chain, 30));
    else els.chainPreview.appendChild(h('span', { class: 'mt-db-chainprev__empty', html: MT.ui.icon('store', { size: 16 }) }));
  }
  function renderFooter(deleted) {
    U.clear(els.drawerFoot);
    if (!ed.isNew && !deleted) {
      els.drawerFoot.appendChild(MT.ui.button({ icon: 'trash', label: t('common.delete') + '…', kind: 'ghost', className: 'mt-db-delbtn', onClick: deleteFlow }));
    }
    els.drawerFoot.appendChild(h('div', { class: 'mt-spacer' }));
    els.saveHint = h('span', { class: 'mt-db-savehint' }, h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Enter'));
    els.drawerFoot.appendChild(els.saveHint);
    els.drawerFoot.appendChild(MT.ui.button({ label: t('common.cancel'), kind: 'secondary', onClick: function () { closeEditor(); } }));
    els.saveBtn = MT.ui.button({ icon: 'check', label: t(ed.isNew ? 'db.edit.create' : 'common.save'), kind: 'primary', onClick: saveEditor, disabled: deleted });
    els.drawerFoot.appendChild(els.saveBtn);
    updateFooter();
  }
  function updateFooter() {
    if (!els.saveBtn) return;
    var dirty = isDirty();
    els.saveBtn.disabled = (!dirty && !ed.isNew) || MT.data.storeState(ed.id) === 'deleted';
    els.drawer.classList.toggle('is-dirty', dirty);
  }

  /* -- Position helpers -- */
  function setPosition(lat, lng, opts) {
    opts = opts || {};
    ed.draft.lat = MT.util.round(lat, 6); ed.draft.lng = MT.util.round(lng, 6);
    if (opts.precision) { ed.draft.precision = opts.precision; if (els.precSeg) els.precSeg.setValue(opts.precision); }
    if (!opts.fromInputs) { els.latIn.value = ed.draft.lat.toFixed(6); els.lngIn.value = ed.draft.lng.toFixed(6); }
    if (ed.errors.coords) { delete ed.errors.coords; els.posError.textContent = ''; els.miniMapEl.parentNode.classList.remove('is-invalid'); }
    renderDistrictLine();
    updatePin(opts.fly !== false && !opts.fromMap);
    updateFooter();
  }
  function renderDistrictLine() {
    var el = els.districtLine;
    if (!el) return;
    U.clear(el);
    var d = ed.draft;
    if (!isFinite(d.lat)) { el.appendChild(h('span', { class: 'mt-muted' }, t('db.edit.noPosition'))); return; }
    if (!MT.geo.inPeru(d.lat, d.lng)) { el.appendChild(h('span', { class: 'mt-db-warn' }, MT.ui.iconEl('warning', { size: 15 }), t('geo.notInPeru'))); return; }
    if (!MT.data.districts.available) { el.appendChild(h('span', { class: 'mt-muted' }, t('db.edit.noDistricts'))); return; }
    var dist = MT.data.locate(d.lat, d.lng);
    if (!dist) { el.appendChild(h('span', { class: 'mt-db-warn' }, MT.ui.iconEl('warning', { size: 15 }), t('db.edit.outside'))); return; }
    el.appendChild(h('span', { class: 'mt-db-district__ok' }, MT.ui.iconEl('pin', { size: 15 }),
      h('strong', null, dist.district), ' — ' + dist.province + ', ' + dist.department, h('span', { class: 'mt-mono mt-muted' }, ' · ' + dist.ubigeo)));
  }
  function applyPastedCoords(text) {
    var r = MT.geo.parseCoordsDetailed(text);
    U.clear(els.coordsMsg);
    els.coordsMsg.className = 'mt-db-msg';
    if (r.error) {
      if (r.error === 'empty') return;
      els.coordsMsg.classList.add('is-error');
      els.coordsMsg.appendChild(document.createTextNode(t('geo.error.' + r.error)));
      els.coordsIn.classList.add('is-invalid');
      return;
    }
    els.coordsIn.classList.remove('is-invalid');
    setPosition(r.lat, r.lng, { precision: 'exact' });
    var notes = [t('db.edit.coordsOk', { lat: r.lat.toFixed(6), lng: r.lng.toFixed(6) })];
    if (r.swapped) notes.push(t('geo.swapped'));
    if (!r.inPeru) notes.push(t('geo.notInPeru'));
    els.coordsMsg.classList.add(r.inPeru ? 'is-ok' : 'is-warn');
    els.coordsMsg.appendChild(document.createTextNode(notes.join(' ')));
    els.coordsIn.value = '';
  }

  function runAddressSearch() {
    var q = els.addrIn.value.trim();
    if (!q) { els.addrIn.focus(); return; }
    if (ed.searchCtl) ed.searchCtl.abort();
    var ctl = ed.searchCtl = new AbortController();
    ed.results = null; ed.searchMsg = null;
    renderResults(true);
    var bias = ed.map ? (function () { var b = ed.map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; })() : null;
    MT.geo.search(q, { limit: 6, signal: ctl.signal, bbox: bias }).then(function (list) {
      if (ctl.signal.aborted) return;
      ed.results = list;
      ed.searchMsg = list.length ? null : t('geo.noResults');
      renderResults();
    }, function (err) {
      if (err && err.name === 'AbortError') return;
      ed.results = [];
      ed.searchMsg = t('geo.searchFailed');
      renderResults();
    });
  }
  function renderResults(loading) {
    var box = els.addrResults;
    if (!box) return;
    U.clear(box);
    if (loading) { box.appendChild(h('div', { class: 'mt-db-results__loading' }, h('span', { class: 'mt-spinner' }), t('db.edit.searching'))); return; }
    if (ed.searchMsg) box.appendChild(h('div', { class: 'mt-db-msg is-warn' }, ed.searchMsg));
    (ed.results || []).forEach(function (p) {
      var parts = String(p.label || '').split(',').map(function (x) { return x.trim(); });
      var b = h('button', { type: 'button', class: 'mt-db-result', role: 'option' },
        MT.ui.iconEl('pin', { size: 16 }),
        h('span', { class: 'mt-db-result__main' }, h('span', { class: 'mt-db-result__title' }, parts[0] || p.name),
          h('span', { class: 'mt-db-result__sub' }, parts.slice(1, 4).join(', '))));
      b.addEventListener('click', function () {
        setPosition(p.lat, p.lng, { precision: 'approx' });
        if (!ed.draft.address && p.street) { ed.draft.address = p.street; var a = U.$('#mt-db-f-address', els.drawer); if (a) a.value = p.street; }
        ed.results = []; ed.searchMsg = null;
        U.clear(box);
        box.appendChild(h('div', { class: 'mt-db-msg is-ok' }, t('db.edit.placed')));
      });
      box.appendChild(b);
    });
  }

  /* -- Mini-map with draggable pin -- */
  function pinEl() {
    var el = h('div', { class: 'mt-db-pin', html: '<svg viewBox="0 0 32 42" width="32" height="42" aria-hidden="true"><path d="M16 41s13-12.6 13-24A13 13 0 0 0 3 17c0 11.4 13 24 13 24Z" fill="currentColor" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16.5" r="5.2" fill="#fff"/></svg>' });
    return el;
  }
  function initEditorMap() {
    if (ed.map) { setTimeout(function () { ed.map.resize(); updatePin(true, true); }, 260); return; }
    if (!window.maplibregl) return;
    var start = blankView();
    if (ed.mapFailed) return;
    ed.map = dbui.createMap(els.miniMapEl, { map: { center: start.center, zoom: start.zoom } });
    if (!ed.map) { ed.mapFailed = true; return; }   // no WebGL: coordinates can still be typed, pasted or searched
    ed.marker = new maplibregl.Marker({ element: pinEl(), draggable: true, anchor: 'bottom' });
    ed.marker.on('dragend', function () {
      var p = ed.marker.getLngLat();
      setPosition(p.lat, p.lng, { precision: 'exact', fromMap: true });
    });
    ed.map.on('click', function (e) {
      if (!ed.open || MT.data.storeState(ed.id) === 'deleted') return;
      setPosition(e.lngLat.lat, e.lngLat.lng, { precision: 'exact', fromMap: true });
    });
    ed.map.on('load', function () { ed.mapReady = true; updatePin(true, true); });
    setTimeout(function () { if (ed.map) ed.map.resize(); }, 260);
  }
  function updatePin(fly, instant) {
    if (!ed.map || !ed.marker) return;
    var d = ed.draft;
    var color = d.chain ? MT.data.chain(d.chain).color : MT.theme.colors.accent;
    ed.marker.getElement().style.color = color;
    U.clear(els.miniHint);
    if (isFinite(d.lat) && isFinite(d.lng)) {
      ed.marker.setLngLat([d.lng, d.lat]).addTo(ed.map);
      els.miniHint.appendChild(document.createTextNode(t('db.edit.dragHint')));
      els.miniHint.classList.remove('is-cta');
      if (fly) ed.map.easeTo({ center: [d.lng, d.lat], zoom: Math.max(ed.map.getZoom(), 15), duration: instant ? 0 : 500 });
    } else {
      ed.marker.remove();
      els.miniHint.appendChild(document.createTextNode(t('db.edit.clickHint')));
      els.miniHint.classList.add('is-cta');
      if (instant) ed.map.jumpTo(blankView());
    }
  }
  /**
   * Where the mini-map starts for a store without coordinates: the side map's area when it shows a
   * city (zoom ≥ 10), else Lima — the side map zoomed out over all of Peru would put the user in
   * the middle of the Andes at street zoom.
   */
  function blankView() {
    if (map && map.getZoom() >= 10) { var c = map.getCenter(); return { center: [c.lng, c.lat], zoom: Math.max(12, map.getZoom()) }; }
    return { center: [-77.03, -12.08], zoom: 11 };
  }

  /* -- Save / delete -- */
  function validate() {
    var d = ed.draft, e = {};
    if (!d.chain) e.chain = t('db.edit.errChain');
    if (!String(d.name || '').trim()) e.name = t('db.edit.errName');
    if (!isFinite(d.lat) || !isFinite(d.lng)) e.coords = t('db.edit.errCoords');
    return e;
  }
  function saveEditor() {
    if (!ed.open) return;
    // Pending text in Latitud/Longitud (no 'change' yet): use it — or refuse an unreadable value
    // instead of saving the old position under a "Cambios guardados" toast.
    var typed = els.commitLatLng ? els.commitLatLng() : 'ok';
    if (typed === 'invalid') {
      ed.errors = Object.assign({}, ed.errors, { coords: t('geo.error.invalid') });
      if (els.posError) els.posError.textContent = ed.errors.coords;
      if (els.miniMapEl && els.miniMapEl.parentNode) els.miniMapEl.parentNode.classList.add('is-invalid');
      els.latIn.focus();
      return;
    }
    if (els.saveBtn && els.saveBtn.disabled && !ed.isNew) return;
    var errs = validate();
    if (Object.keys(errs).length) {
      ed.errors = errs;
      var scrollTop = els.drawerBody.scrollTop;
      renderEditor();
      els.drawerBody.scrollTop = scrollTop;
      var firstBad = U.$('.is-invalid', els.drawerBody);
      if (firstBad) { firstBad.scrollIntoView({ block: 'center' }); if (firstBad.focus) firstBad.focus(); }
      return;
    }
    var rec = {};
    MT.data.COLUMNS.forEach(function (c) { rec[c] = ed.draft[c]; });
    rec.name = String(rec.name).trim();
    rec.updated = '';
    if (ed.isNew) {
      delete rec.id;
      rec.ubigeo = ''; rec.district = ''; rec.province = ''; rec.department = '';
    }
    els.saveBtn.disabled = true;
    MT.data.upsertStore(rec).then(function (saved) {
      MT.ui.toast(t(ed.isNew ? 'db.edit.created' : 'db.edit.saved', { name: saved.name }), { type: 'success' });
      closeEditor(true);
      // Make sure the store is visible: a new one outside the filters would silently vanish.
      setTimeout(function () {
        if (!state.list.some(function (s) { return s.id === saved.id; })) {
          MT.ui.toast(t('db.edit.hiddenByFilters'), { type: 'info', action: { label: t('db.filter.clear'), onClick: function () { dbui.clearFilters(); setTimeout(function () { dbui.select(saved.id, { source: 'api' }); }, 60); } } });
        } else dbui.select(saved.id, { source: 'api' });
      }, 80);
    }, function (err) {
      els.saveBtn.disabled = false;
      console.error('[db] save failed', err);
      MT.ui.toast(t('db.error.save'), { type: 'error' });
    });
  }
  function undoLocal() {
    var id = ed.id;
    MT.ui.confirm(t('db.edit.undoText'), { title: t('db.edit.undoLocal'), okLabel: t('db.edit.undoOk') }).then(function (ok) {
      if (!ok) return;
      MT.data.restoreStore(id).then(function () { MT.ui.toast(t('db.edit.undone'), { type: 'success' }); closeEditor(true).then(function () { dbui.openEditor(id); }); });
    });
  }
  function deleteFlow() {
    var id = ed.id, s = MT.data.store(id);
    if (!s) return;
    var added = MT.data.storeState(id) === 'added';
    var choice = s.status === 'closed' ? 'delete' : 'close';
    var opt = function (value, titleKey, textKey, icon) {
      var r = h('input', { type: 'radio', name: 'mt-db-del', value: value, checked: choice === value, disabled: value === 'close' && s.status === 'closed' });
      r.addEventListener('change', function () { choice = value; okBtn.className = 'mt-btn mt-btn--' + (value === 'delete' ? 'danger' : 'primary'); });
      return h('label', { class: 'mt-db-choice' + (r.disabled ? ' is-disabled' : '') }, r,
        h('span', { class: 'mt-db-choice__icon', html: MT.ui.icon(icon, { size: 18 }) }),
        h('span', { class: 'mt-db-choice__body' }, h('strong', null, t(titleKey)), h('span', null, t(textKey))));
    };
    var body = h('div', { class: 'mt-stack' },
      h('p', { class: 'mt-modal__text' }, t('db.delete.intro', { name: s.name })),
      opt('close', 'db.delete.closeTitle', s.status === 'closed' ? 'db.delete.alreadyClosed' : 'db.delete.closeText', 'eyeOff'),
      opt('delete', 'db.delete.deleteTitle', added ? 'db.delete.deleteTextAdded' : 'db.delete.deleteText', 'trash'));
    var m = MT.ui.modal({ title: t('db.delete.title'), size: 'sm', body: body, actions: [
      { label: t('common.cancel'), kind: 'secondary', value: null },
      { label: t('common.apply'), kind: choice === 'delete' ? 'danger' : 'primary', value: 'ok', autofocus: true },
    ] });
    var okBtn = m.el.querySelector('.mt-modal__footer .mt-btn:last-child');
    m.result.then(function (v) {
      if (v !== 'ok') return;
      var p = choice === 'close' ? MT.data.upsertStore({ id: id, status: 'closed' }) : MT.data.deleteStore(id);
      p.then(function () {
        closeEditor(true);
        MT.ui.toast(t(choice === 'close' ? 'db.delete.closedDone' : 'db.delete.deletedDone', { name: s.name }), { type: 'success',
          action: choice === 'delete' && !added ? { label: t('common.undo'), onClick: function () { MT.data.restoreStore(id); } } : null });
      }, function (err) { console.error(err); MT.ui.toast(t('db.error.save'), { type: 'error' }); });
    });
  }

  /* =========================================================================================
   * Import (CSV / XLSX)
   * ======================================================================================= */
  function startImport() {
    MT.ui.pickFile({ accept: '.csv,.txt,.tsv,.xlsx,.xls,.ods' }).then(function (file) { if (file) dbui.importFile(file); });
  }
  dbui.importFile = function (file) {
    var busy = MT.ui.busy({ title: t('db.import.reading'), message: file.name });
    // MT.io.detectDelimiter looks at the first 12 lines, so a title row above a ';' header works.
    return MT.io.readTable(file).then(function (rows) {
      busy.close();
      rows = (rows || []).filter(function (r) { return r && r.some(function (c) { return String(c || '').trim() !== ''; }); });
      if (rows.length < 2) { MT.ui.toast(t('io.error.empty'), { type: 'error' }); return null; }
      return dbui.importRows(file.name, rows);
    }, function (err) {
      busy.close();
      console.warn('[db] import read failed', err);
      MT.ui.toast(t('io.error.read'), { type: 'error' });
      return null;
    });
  };

  /** Pick the header row: the one (among the first 10) with the most recognised column names. */
  function detectHeaderRow(rows) {
    var best = 0, bestN = 0;
    for (var r = 0; r < Math.min(10, rows.length - 1); r++) {
      var n = MT.io.mapHeaders(rows[r]).filter(function (m) { return m.column; }).length;
      if (n > bestN) { best = r; bestN = n; }
    }
    return best;
  }

  /** Import dialog for parsed rows → resolves the summary or null when cancelled. */
  dbui.importRows = function (fileName, rows) {
    var hi = detectHeaderRow(rows);
    var header = rows[hi].map(function (x) { return String(x || '').trim(); });
    var data = rows.slice(hi + 1);
    var mapping = MT.io.mapHeaders(header).map(function (m) { return m.column || ''; });
    // Avoid two source columns feeding the same target (the later one wins otherwise).
    var used = {};
    mapping = mapping.map(function (c) { if (!c || used[c]) return ''; used[c] = true; return c; });
    // Merge by id only when the ids are this app's (osm-…, web-…, man-…, or existing stores):
    // a client's own store codes must not update unrelated stores of ours.
    var opts = { mode: idsLookFamiliar(data, mapping) ? 'merge' : 'append', defaultChain: '', geocode: true, defaultStatus: 'verified' };
    var analysis = null;

    var mapBox = h('div', { class: 'mt-imp-map' });
    var optBox = h('div', { class: 'mt-imp-opts' });
    var sumBox = h('div', { class: 'mt-imp-summary', 'aria-live': 'polite' });
    var prevBox = h('div', { class: 'mt-imp-preview' });
    var body = h('div', { class: 'mt-imp' },
      h('div', { class: 'mt-imp-file' }, MT.ui.iconEl('file', { size: 18 }), h('strong', null, fileName),
        h('span', { class: 'mt-muted' }, t('db.import.rows', { n: fmtNum(data.length) }) + (hi ? ' · ' + t('db.import.headerRow', { n: hi + 1 }) : ''))),
      h('div', { class: 'mt-imp-cols' },
        h('div', { class: 'mt-imp-col' }, h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl('table', { size: 15 }), t('db.import.columns')),
          h('p', { class: 'mt-hint' }, t('db.import.columnsHint')), mapBox),
        h('div', { class: 'mt-imp-col' }, h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl('sliders', { size: 15 }), t('db.import.options')), optBox, sumBox)),
      h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl('eye', { size: 15 }), t('db.import.preview')), prevBox);

    var m = MT.ui.modal({ title: t('db.import.title'), size: 'xl', className: 'mt-imp-modal', body: body, actions: [
      { label: t('common.cancel'), kind: 'secondary', value: null },
      { label: t('db.import.go'), kind: 'primary', icon: 'upload', onClick: function () { if (!analysis || !analysis.importable) return false; m.close('go'); return false; } },
    ] });
    var goBtn = m.el.querySelector('.mt-modal__footer .mt-btn--primary');

    function renderMapping() {
      U.clear(mapBox);
      header.forEach(function (hd, i) {
        var samples = [];
        for (var r = 0; r < data.length && samples.length < 2; r++) { var v = String(data[r][i] || '').trim(); if (v) samples.push(v); }
        var sel = h('select', { class: 'mt-select mt-select--sm', 'aria-label': t('db.import.targetFor', { col: hd || '#' + (i + 1) }) },
          h('option', { value: '' }, t('db.import.skip')),
          MT.data.COLUMNS.map(function (c) { return h('option', { value: c, selected: mapping[i] === c }, t('data.col.' + c)); }));
        sel.addEventListener('change', function () {
          var v = sel.value;
          if (v) mapping = mapping.map(function (c, j) { return j !== i && c === v ? '' : c; });
          mapping[i] = v;
          if (v === 'id' && opts.mode === 'append') opts.mode = 'merge';
          renderMapping(); update();
        });
        mapBox.appendChild(h('div', { class: 'mt-imp-row' + (mapping[i] ? ' is-mapped' : '') },
          h('div', { class: 'mt-imp-row__src' }, h('span', { class: 'mt-imp-row__name' }, hd || h('em', null, '#' + (i + 1))),
            h('span', { class: 'mt-imp-row__ex mt-truncate' }, samples.join(' · ') || t('db.import.emptyCol'))),
          h('span', { class: 'mt-imp-row__arrow', html: MT.ui.icon('chevronRight', { size: 16 }) }), sel));
      });
    }

    function renderOptions() {
      U.clear(optBox);
      var hasId = mapping.indexOf('id') >= 0;
      var radio = function (value, titleKey, textKey, disabled) {
        var r = h('input', { type: 'radio', name: 'mt-imp-mode', value: value, checked: opts.mode === value, disabled: !!disabled });
        r.addEventListener('change', function () { opts.mode = value; update(); });
        return h('label', { class: 'mt-db-choice mt-db-choice--sm' + (disabled ? ' is-disabled' : '') }, r,
          h('span', { class: 'mt-db-choice__body' }, h('strong', null, t(titleKey)), h('span', null, t(textKey))));
      };
      optBox.appendChild(h('div', { class: 'mt-stack mt-stack--sm' },
        radio('merge', 'db.import.merge', 'db.import.mergeText', !hasId),
        radio('append', 'db.import.append', 'db.import.appendText')));
      var chainSel = h('select', { class: 'mt-select mt-select--sm' }, h('option', { value: '' }, t('db.import.noDefaultChain')),
        chainsByGroup(MT.data.chains().filter(function (c) { return !c.unknown; })).map(function (g) {
          return h('optgroup', { label: t('data.group.' + g.group) }, g.chains.map(function (c) { return h('option', { value: c.id, selected: c.id === opts.defaultChain }, c.name); }));
        }));
      chainSel.addEventListener('change', function () { opts.defaultChain = chainSel.value; update(); });
      var stSel = h('select', { class: 'mt-select mt-select--sm' }, ['verified', 'to_verify'].map(function (v) { return h('option', { value: v, selected: v === opts.defaultStatus }, t('data.status.' + v)); }));
      stSel.addEventListener('change', function () { opts.defaultStatus = stSel.value; update(); });
      optBox.appendChild(h('div', { class: 'mt-db-grid2 mt-imp-defaults' },
        h('label', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('db.import.defaultChain')), chainSel),
        h('label', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('db.import.defaultStatus')), stSel)));
      var geo = h('input', { type: 'checkbox', checked: opts.geocode });
      geo.addEventListener('change', function () { opts.geocode = geo.checked; update(); });
      els.impGeo = h('label', { class: 'mt-check mt-imp-geo' }, geo, h('span', { class: 'mt-imp-geo__text' }));
      optBox.appendChild(els.impGeo);
    }

    function update() {
      analysis = analyzeImport(header, data, mapping, opts);
      var a = analysis;
      var geoText = U.$('.mt-imp-geo__text', optBox);
      if (geoText) {
        geoText.textContent = t('db.import.geocode', { n: a.toGeocode.length, time: etaText(a.toGeocode.length) });
        els.impGeo.hidden = !a.toGeocode.length;
      }
      U.clear(sumBox);
      var line = function (icon, tone, text) { return h('div', { class: 'mt-imp-sum mt-imp-sum--' + tone }, MT.ui.iconEl(icon, { size: 16 }), h('span', null, text)); };
      if (a.updates) sumBox.appendChild(line('refresh', 'info', t('db.import.sumUpdate', { n: a.updates })));
      if (a.adds) sumBox.appendChild(line('plus', 'ok', t('db.import.sumAdd', { n: a.adds })));
      if (a.chainChanges.length) {
        var cc = a.chainChanges[0];
        sumBox.appendChild(line('warning', 'warn', t('db.import.sumChainChange', { n: a.chainChanges.length, name: cc.name, from: MT.data.chain(cc.from).name, to: MT.data.chain(cc.to).name })));
      }
      if (mapping.indexOf('id') >= 0 && opts.mode === 'append' && !idsLookFamiliar(data, mapping)) sumBox.appendChild(line('info', 'info', t('db.import.idsForeign')));
      if (a.swapped) sumBox.appendChild(line('refresh', 'info', t('db.import.sumSwapped', { n: a.swapped })));
      if (a.toGeocode.length) sumBox.appendChild(line('search', opts.geocode ? 'info' : 'warn', t(opts.geocode ? 'db.import.sumGeocode' : 'db.import.sumNoGeocode', { n: a.toGeocode.length })));
      if (a.skipped.length) sumBox.appendChild(line('warning', 'warn', t('db.import.sumSkip', { n: a.skipped.length })));
      if (a.unknownChains.length) sumBox.appendChild(line('info', 'warn', t('db.import.sumUnknownChains', { list: a.unknownChains.slice(0, 4).join(', ') + (a.unknownChains.length > 4 ? '…' : '') })));
      if (mapping.indexOf('chain') < 0 && !opts.defaultChain) sumBox.appendChild(line('error', 'error', t('db.import.needChain')));
      if (goBtn) {
        goBtn.disabled = !a.importable;
        U.$('span:last-child', goBtn).textContent = a.importable ? t('db.import.goN', { n: a.importable }) : t('db.import.go');
      }
      renderPreview(a);
      renderOptionsState();
    }
    function renderOptionsState() {
      var mergeRadio = U.$('input[value=merge]', optBox);
      if (mergeRadio) {
        mergeRadio.disabled = mapping.indexOf('id') < 0;
        mergeRadio.closest('label').classList.toggle('is-disabled', mergeRadio.disabled);
        if (mergeRadio.disabled && opts.mode === 'merge') { opts.mode = 'append'; U.$('input[value=append]', optBox).checked = true; }
      }
    }
    function renderPreview(a) {
      U.clear(prevBox);
      var cols = ['chain', 'name', 'address', 'district', 'lat', 'lng', 'status'];
      var table = h('table', { class: 'mt-table mt-imp-table' },
        h('thead', null, h('tr', null, h('th', null, '#'), cols.map(function (c) { return h('th', null, t('data.col.' + c)); }), h('th', null, t('db.import.result')))),
        h('tbody', null, a.rows.slice(0, 8).map(function (r) {
          var s = r.store || {};
          var res = r.skip ? h('span', { class: 'mt-badge mt-badge--danger' }, t('db.import.reason.' + r.skip))
            : r.geocode ? h('span', { class: 'mt-badge mt-badge--info' }, t('db.import.willGeocode'))
              : r.update ? h('span', { class: 'mt-badge mt-badge--accent' }, t('db.import.willUpdate'))
                : h('span', { class: 'mt-badge mt-badge--success' }, t('db.import.willAdd'));
          return h('tr', { class: r.skip ? 'is-muted' : '' }, h('td', { class: 'mt-muted' }, String(r.row)),
            cols.map(function (c) {
              var v = s[c];
              if (c === 'chain') v = s.chain ? MT.data.chain(s.chain).name : '';
              if (c === 'status') v = s.status ? t('data.status.' + s.status) : '';
              if ((c === 'lat' || c === 'lng')) v = isFinite(v) ? (+v).toFixed(5) : '';
              return h('td', null, h('span', { class: 'mt-truncate' }, v == null ? '' : String(v)));
            }), h('td', null, res));
        })));
      prevBox.appendChild(h('div', { class: 'mt-table-wrap mt-imp-tablewrap' }, table));
      if (a.rows.length > 8) prevBox.appendChild(h('div', { class: 'mt-hint' }, t('db.import.more', { n: fmtNum(a.rows.length - 8) })));
    }

    renderMapping(); renderOptions(); update();
    return m.result.then(function (v) {
      if (v !== 'go') return null;
      return runImport(fileName, header, data, analysis, opts);
    });
  };

  function etaText(n) {
    var s = Math.ceil(n * 1.15);
    return s < 90 ? t('db.import.etaS', { n: Math.max(2, s) }) : t('db.import.etaM', { n: Math.ceil(s / 60) });
  }

  /**
   * Turn mapped rows into upsert candidates. Rows are parsed one by one with MT.io.rowsToStores so
   * every result keeps its file row number. Merge mode: an existing id gets a partial update (empty
   * cells never erase data); otherwise the row becomes a new store.
   */
  /** Ids that this app generates (SPEC §3.1): osm-n123 / osm-w456 / osm-r789, web-<chain>-<slug>, man-<base36>. */
  function looksLikeAppId(id) { return /^(osm-[nwr]\d+|web-[a-z0-9]+-\S+|man-[a-z0-9]+)$/.test(String(id || '')); }
  dbui.looksLikeAppId = looksLikeAppId;
  /** At least half of the non-empty ids in the id column are this app's (or existing stores). */
  function idsLookFamiliar(data, mapping) {
    var col = mapping.indexOf('id');
    if (col < 0) return false;
    var n = 0, ok = 0;
    data.forEach(function (row) {
      var v = String(row[col] === undefined || row[col] === null ? '' : row[col]).trim();
      if (!v) return;
      n++;
      if (looksLikeAppId(v) || MT.data.store(v) || MT.data.seedStore(v)) ok++;
    });
    return n > 0 && ok * 2 >= n;
  }

  function analyzeImport(header, data, mapping, opts) {
    var canon = mapping.map(function (c) { return c || ''; });
    var known = {};
    MT.data.chains().forEach(function (c) { if (!c.unknown) known[c.id] = true; });
    var res = { rows: [], updates: 0, adds: 0, toGeocode: [], skipped: [], importable: 0, unknownChains: [], chainChanges: [], swapped: 0 };
    var unknown = {};
    var seenIds = {};
    data.forEach(function (row, i) {
      var fileRow = i + 2; // 1-based, after the header
      var parsed = MT.io.rowsToStores([canon, row]);
      var s = parsed.stores[0];
      var r = { row: fileRow, raw: row, store: s || null };
      res.rows.push(r);
      if (!s) { r.skip = 'empty'; res.skipped.push(r); return; }
      var flags = s._flags || {};
      // Coordinates that are not in Peru even after swapping lat/lng: never on any map.
      if (flags.outside) { r.skip = 'outsidePeru'; res.skipped.push(r); return; }
      if (flags.swapped) res.swapped++;
      var hasCoords = isFinite(s.lat) && isFinite(s.lng);
      if (opts.mode === 'merge' && s.id) {
        // The same id twice in one file is a duplicated row, not a second store.
        if (seenIds[s.id]) { r.skip = 'duplicate'; res.skipped.push(r); return; }
        seenIds[s.id] = true;
      }
      var existing = opts.mode === 'merge' && s.id ? MT.data.store(s.id) : null;
      if (existing) {
        var patch = { id: s.id };
        Object.keys(s).forEach(function (k) {
          var v = s[k];
          if (k === 'id' || v === '' || v === undefined || (typeof v === 'number' && !isFinite(v))) return;
          patch[k] = v;
        });
        if (!hasCoords) { delete patch.lat; delete patch.lng; }
        else if (!patch.precision) patch.precision = 'exact';
        if (patch.chain && patch.chain !== existing.chain) res.chainChanges.push({ name: existing.name, from: existing.chain, to: patch.chain });
        r.update = true; r.patch = patch; res.updates++; res.importable++;
        return;
      }
      var rec = Object.assign({}, s);
      // Unknown ids that are not this app's get a fresh man- id (no "101" stores).
      if (opts.mode !== 'merge' || !rec.id || !looksLikeAppId(rec.id)) rec.id = '';
      if (!rec.chain) rec.chain = opts.defaultChain;
      if (!rec.chain) { r.skip = 'chain'; res.skipped.push(r); return; }
      if (!known[rec.chain]) unknown[rec.chain] = true;
      if (!rec.source) rec.source = 'import';
      r.statusGiven = !!rec.status;
      if (!rec.status) rec.status = opts.defaultStatus;
      if (!rec.name) rec.name = MT.data.chain(rec.chain).name + (rec.district ? ' ' + rec.district : '');
      r.store = rec;
      if (!hasCoords) {
        var query = [rec.address, rec.district, rec.province, rec.department].filter(Boolean).join(', ');
        if (!rec.address || !query) { r.skip = 'coords'; res.skipped.push(r); return; }
        r.query = query + ', Perú';
        if (opts.geocode) { r.geocode = true; res.toGeocode.push(r); res.adds++; res.importable++; }
        else { r.skip = 'coords'; res.skipped.push(r); }
        return;
      }
      if (!rec.precision) rec.precision = 'exact';
      r.add = true; res.adds++; res.importable++;
    });
    // Rows dropped by geocoding stay counted as "to geocode" in the dialog; the run reports them.
    res.unknownChains = Object.keys(unknown);
    // In "skip geocoding" mode, rows waiting for coordinates are skipped.
    return res;
  }

  /** Unique ids for new rows: man-<base36 timestamp>, consecutive and never colliding. */
  function allocIds(n) {
    var out = [], tms = Date.now();
    while (out.length < n) {
      var id = 'man-' + tms.toString(36);
      tms++;
      if (!MT.data.store(id) && !MT.data.seedStore(id)) out.push(id);
    }
    return out;
  }

  function runImport(fileName, header, data, a, opts) {
    var geocoded = 0;
    var step = Promise.resolve();
    if (a.toGeocode.length && opts.geocode) step = geocodePass(a.toGeocode);

    /** Rows still waiting for a location (not tried yet, or the service failed on them). */
    function pending() { return a.toGeocode.filter(function (r) { return !r.done; }); }
    function geocodePass(rows) {
      var busy = MT.ui.busy({ title: t('db.import.geocodingTitle'), message: t('db.import.geocodingMsg', { done: 0, total: rows.length, eta: etaText(rows.length) }), progress: true, cancellable: true });
      // Results are applied as they arrive, so a cancel keeps everything geocoded so far.
      return MT.geo.geocodeBatch(rows.map(function (r) { return { query: r.query, r: r }; }), function (done, total, item, place, failure) {
        applyGeocode(item.r, place, failure);
        busy.update({ progress: done / total, message: t('db.import.geocodingMsg', { done: done, total: total, eta: etaText(total - done) }) });
      }, { signal: busy.signal }).then(function (res) {
        busy.close();
        if (res.stopped) return serviceFailed(res.stopped);
      }, function (err) {
        busy.close();
        if (!(err && err.name === 'AbortError')) { console.warn('[db] geocoding failed', err); }
        // Cancelled: rows already geocoded keep their result (the cache makes this instant).
        return MT.ui.confirm(t('db.import.cancelledText'), { title: t('db.import.cancelledTitle'), okLabel: t('db.import.importRest') }).then(function (ok) {
          if (!ok) throw MT.geo.abortError();
          pending().forEach(function (r) { r.skip = 'cancelled'; });
        });
      });
    }
    // The address service is down, offline or rate-limited: say so (the addresses are not wrong)
    // and let the user retry later rows, import what is located, or cancel.
    function serviceFailed(info) {
      var left = pending(), total = a.toGeocode.length;
      var why = info && (info.status === 429 || info.status === 403) ? t('db.import.serviceLimit') : t('db.import.serviceOffline');
      return MT.ui.modal({ title: t('db.import.serviceTitle'), size: 'md',
        body: h('div', { class: 'mt-stack mt-stack--sm' }, h('p', { class: 'mt-modal__text' }, why),
          h('p', { class: 'mt-hint' }, t('db.import.serviceProgress', { done: total - left.length, total: total, n: left.length }))),
        actions: [
          { label: t('common.cancel'), kind: 'ghost', value: 'cancel' },
          { label: t('db.import.importRest'), kind: 'secondary', value: 'rest' },
          { label: t('common.retry'), kind: 'primary', icon: 'refresh', value: 'retry', autofocus: true },
        ] }).result.then(function (v) {
        if (v === 'retry') return geocodePass(left);
        if (v === 'rest') { left.forEach(function (r) { r.skip = 'serviceError'; }); return; }
        throw MT.geo.abortError();
      });
    }
    function applyGeocode(r, place, failure) {
      if (failure) { r.done = false; r.skip = 'serviceError'; return; }
      r.done = true;
      if (place && isFinite(place.lat)) {
        delete r.skip;
        r.store.lat = place.lat; r.store.lng = place.lng; r.store.precision = 'approx';
        if (r.store.status === opts.defaultStatus && !r.statusGiven) r.store.status = 'to_verify';
        geocoded++;
      } else { r.skip = 'notFound'; }
    }
    return step.then(function () {
      var list = [];
      var newRows = a.rows.filter(function (r) { return !r.skip && !r.update && r.store && (r.add || r.geocode); });
      var ids = allocIds(newRows.filter(function (r) { return !r.store.id; }).length);
      newRows.forEach(function (r) { if (!r.store.id) r.store.id = ids.shift(); list.push(r.store); });
      a.rows.forEach(function (r) { if (r.update && !r.skip) list.push(r.patch); });
      var skipped = a.rows.filter(function (r) { return r.skip; });
      if (!list.length) { showImportSummary(fileName, header, { added: 0, updated: 0, errors: [] }, geocoded, skipped); return null; }
      var busy2 = MT.ui.busy({ title: t('db.import.saving') });
      return MT.data.upsertStores(list, { op: 'import' }).then(function (r) {
        busy2.close();
        r.errors.forEach(function (e) {
          var src = list[e.index];
          var row = a.rows.find(function (x) { return x.store === src || x.patch === src; });
          if (row) { row.skip = e.error === 'store-coords-required' ? 'coords' : 'error'; skipped.push(row); }
        });
        showImportSummary(fileName, header, r, geocoded, skipped);
        return r;
      }, function (err) { busy2.close(); console.error(err); MT.ui.toast(t('db.error.save'), { type: 'error' }); return null; });
    }).catch(function (err) { if (err && err.name === 'AbortError') { MT.ui.toast(t('db.import.aborted'), { type: 'info' }); return null; } throw err; });
  }

  function showImportSummary(fileName, header, r, geocoded, skipped) {
    var added = r.added || 0, updated = r.updated || 0;
    var stat = function (n, key, tone) { return h('div', { class: 'mt-imp-stat mt-imp-stat--' + tone }, h('div', { class: 'mt-imp-stat__n' }, fmtNum(n)), h('div', { class: 'mt-imp-stat__l' }, t(key, { n: n }))); };
    var body = h('div', { class: 'mt-stack' },
      h('div', { class: 'mt-imp-stats' }, stat(added, 'db.import.statAdded', 'ok'), stat(updated, 'db.import.statUpdated', 'info'),
        stat(geocoded, 'db.import.statGeocoded', 'neutral'), stat(skipped.length, 'db.import.statSkipped', skipped.length ? 'warn' : 'neutral')),
      geocoded ? h('p', { class: 'mt-hint' }, t('db.import.approxNote')) : null);
    if (skipped.length) {
      body.appendChild(h('div', { class: 'mt-imp-skipped' }, h('div', { class: 'mt-label' }, t('db.import.skippedList')),
        h('ul', null, skipped.slice(0, 200).map(function (x) {
          var name = x.store && x.store.name || (x.raw || []).filter(Boolean).slice(0, 2).join(' · ');
          return h('li', null, h('span', { class: 'mt-mono mt-muted' }, t('db.import.rowN', { n: x.row })), ' ', h('span', null, name), ' — ', h('span', { class: 'mt-muted' }, t('db.import.reason.' + x.skip)));
        }))));
    }
    var actions = [];
    if (skipped.length) actions.push({ label: t('db.import.downloadSkipped'), kind: 'secondary', icon: 'download', onClick: function () {
      var rows = [header.concat([t('db.import.reasonCol')])].concat(skipped.map(function (x) { return (x.raw || []).concat([t('db.import.reason.' + x.skip)]); }));
      MT.io.download(MT.io.stringifyCSV(rows), MT.io.datedName(t('db.import.skippedFile'), 'csv'));
      return false;
    } });
    if (added + updated) actions.push({ label: t('db.import.viewImported'), kind: 'secondary', onClick: function () { dbui.setFilters({ local: true }); } });
    actions.push({ label: t('common.done'), kind: 'primary', value: true, autofocus: true });
    MT.ui.modal({ title: t('db.import.doneTitle'), size: 'md', body: body, actions: actions });
  }

  /* =========================================================================================
   * OSM scan: area + chains dialog, progress, review
   * ======================================================================================= */
  function departments() {
    var by = {};
    MT.data.districts.all().forEach(function (d) { (by[d.department] = by[d.department] || []).push(d.ubigeo); });
    return U.sortBy(Object.keys(by), function (k) { return k; }).map(function (k) { return { name: k, ubigeos: by[k] }; });
  }

  /** Scan dialog. prefill: {ubigeos?, province?, department?, chains?}. */
  dbui.openScan = function (prefill) {
    if (!MT.data.districts.available) { MT.ui.toast(t('osm.noDistricts'), { type: 'warn' }); return; }
    var f = state.filters;
    prefill = prefill || {};
    var area = { mode: 'districts', ubigeos: [], province: null, department: '' };
    if (prefill.ubigeos) area.ubigeos = prefill.ubigeos.slice();
    else if (f.ubigeo && MT.data.districts.get(f.ubigeo)) area.ubigeos = [f.ubigeo];
    else if (f.province) {
      var p = MT.data.districts.byProvince().find(function (x) { return x.province === f.province && (!f.department || x.department === f.department); });
      if (p) { area.mode = 'province'; area.province = p; }
    } else if (f.department && f.department !== NONE) { area.mode = 'department'; area.department = f.department; }
    var chainsAll = MT.data.chains().filter(function (c) { return !c.unknown; });
    var chainSel = {};
    var pre = prefill.chains || (f.chains.length ? f.chains : null);
    chainsAll.forEach(function (c) { var ok = MT.osm.rules(c).usable; chainSel[c.id] = ok && (pre ? pre.indexOf(c.id) >= 0 : true); });

    var areaBox = h('div', { class: 'mt-osm-area' });
    var chainBox = h('div', { class: 'mt-osm-chains' });
    var infoBox = h('div', { class: 'mt-osm-info' });
    var seg = MT.ui.segmented({ ariaLabel: t('osm.area'), value: area.mode, options: [
      { value: 'districts', label: t('osm.mode.districts') }, { value: 'province', label: t('osm.mode.province') }, { value: 'department', label: t('osm.mode.department') }],
    onChange: function (v) { area.mode = v; renderArea(); renderInfo(); } });
    var body = h('div', { class: 'mt-osm-setup' },
      h('p', { class: 'mt-modal__text' }, t('osm.intro')),
      h('section', { class: 'mt-db-sec' }, h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl('pin', { size: 15 }), t('osm.area')), seg, areaBox),
      h('section', { class: 'mt-db-sec' }, h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl('store', { size: 15 }), t('osm.chains'),
        h('span', { class: 'mt-db-sec__tools' },
          h('button', { type: 'button', class: 'mt-db-link', onclick: function () { chainsAll.forEach(function (c) { if (MT.osm.rules(c).usable) chainSel[c.id] = true; }); renderChains(); renderInfo(); } }, t('common.all')),
          h('button', { type: 'button', class: 'mt-db-link', onclick: function () { chainSel = {}; renderChains(); renderInfo(); } }, t('common.none')))), chainBox),
      infoBox);
    var m = MT.ui.modal({ title: t('osm.title'), size: 'lg', className: 'mt-osm-modal', body: body, actions: [
      { label: t('common.cancel'), kind: 'secondary', value: null },
      { label: t('osm.start'), kind: 'primary', icon: 'globe', onClick: function () { var u = areaUbigeos(); if (!u.length || !selectedChains().length) return false; m.close({ ubigeos: u, chains: selectedChains() }); return false; } },
    ] });
    var goBtn = m.el.querySelector('.mt-modal__footer .mt-btn--primary');

    function areaUbigeos() {
      if (area.mode === 'districts') return area.ubigeos.slice();
      if (area.mode === 'province') return area.province ? area.province.ubigeos.slice() : [];
      var d = departments().find(function (x) { return x.name === area.department; });
      return d ? d.ubigeos.slice() : [];
    }
    function selectedChains() { return Object.keys(chainSel).filter(function (k) { return chainSel[k]; }); }

    function renderArea() {
      U.clear(areaBox);
      if (area.mode === 'districts') {
        var chips = h('div', { class: 'mt-chips mt-osm-chips' });
        area.ubigeos.forEach(function (u) {
          var d = MT.data.districts.get(u);
          chips.appendChild(h('span', { class: 'mt-chip' }, h('span', { class: 'mt-chip__label' }, d ? d.district : u), h('span', { class: 'mt-chip__sub' }, d ? d.province : ''),
            h('button', { type: 'button', class: 'mt-chip__x', 'aria-label': t('common.remove') + ' ' + (d ? d.district : u), html: MT.ui.icon('close', { size: 14 }),
              onclick: function () { area.ubigeos = area.ubigeos.filter(function (x) { return x !== u; }); renderArea(); renderInfo(); } })));
        });
        areaBox.appendChild(districtPicker(function (u) { if (area.ubigeos.indexOf(u) < 0) area.ubigeos.push(u); renderArea(); renderInfo(); setTimeout(function () { var i = U.$('.mt-osm-picker input', areaBox); if (i) i.focus(); }, 0); }));
        areaBox.appendChild(area.ubigeos.length ? chips : h('div', { class: 'mt-hint' }, t('osm.noDistrictsYet')));
      } else if (area.mode === 'province') {
        areaBox.appendChild(provincePicker(area.province, function (p) { area.province = p; renderArea(); renderInfo(); }));
      } else {
        var sel = h('select', { class: 'mt-select', 'aria-label': t('osm.mode.department') }, h('option', { value: '' }, t('osm.chooseDepartment')),
          departments().map(function (d) { return h('option', { value: d.name, selected: d.name === area.department }, d.name + ' (' + t('data.districts', { n: d.ubigeos.length }) + ')'); }));
        sel.addEventListener('change', function () { area.department = sel.value; renderInfo(); });
        areaBox.appendChild(sel);
      }
    }
    function renderChains() {
      U.clear(chainBox);
      chainsByGroup(chainsAll).forEach(function (g) {
        chainBox.appendChild(h('div', { class: 'mt-osm-chaingroup' }, h('div', { class: 'mt-osm-chaingroup__t' }, t('data.group.' + g.group)),
          h('div', { class: 'mt-osm-chaingrid' }, g.chains.map(function (c) {
            var cr = MT.osm.rules(c), usable = cr.usable;
            var box = h('input', { type: 'checkbox', checked: !!chainSel[c.id], disabled: !usable });
            box.addEventListener('change', function () { chainSel[c.id] = box.checked; renderInfo(); });
            return h('label', { class: 'mt-osm-chain' + (usable ? '' : ' is-disabled'), title: usable ? (cr.derived ? t('osm.derivedRules') : '') : t('osm.noRules') }, box, logoImg(c.id, 22), h('span', { class: 'mt-truncate' }, c.name));
          }))));
      });
    }
    function renderInfo() {
      U.clear(infoBox);
      var u = areaUbigeos(), ch = selectedChains();
      var tiles = u.length ? MT.osm.planTiles(u).length : 0;
      if (goBtn) goBtn.disabled = !u.length || !ch.length;
      if (u.length && ch.length) {
        infoBox.appendChild(h('div', { class: 'mt-osm-note' }, MT.ui.iconEl('info', { size: 16 }),
          h('span', null, t('osm.plan', { districts: t('data.districts', { n: u.length }), chains: ch.length, queries: t('osm.queries', { n: tiles }) }))));
      }
      if (MT.env.isFile) infoBox.appendChild(h('div', { class: 'mt-osm-note mt-osm-note--warn' }, MT.ui.iconEl('warning', { size: 16 }), h('span', null, t('osm.fileWarning'))));
    }
    renderArea(); renderChains(); renderInfo();
    return m.result.then(function (v) { if (v) return runScan(v); return null; });
  };

  /** Inline district search (local, as-you-type is fine: no network). */
  function districtPicker(onPick) {
    var inp = h('input', { class: 'mt-input', type: 'search', placeholder: t('osm.districtPh'), 'aria-label': t('osm.districtPh'), autocomplete: 'off', 'data-autofocus': '' });
    var list = h('div', { class: 'mt-osm-sugg', role: 'listbox', hidden: true });
    var items = [], active = -1;
    function render() {
      var res = MT.data.districts.search(inp.value, { limit: 8 });
      items = res; active = res.length ? 0 : -1;
      U.clear(list);
      list.hidden = !res.length;
      res.forEach(function (d, i) {
        var b = h('button', { type: 'button', role: 'option', class: 'mt-osm-sugg__item' + (i === active ? ' is-active' : ''), tabindex: '-1' },
          h('strong', null, d.district), h('span', { class: 'mt-muted' }, ' — ' + d.province + ', ' + d.department));
        b.addEventListener('mousedown', function (e) { e.preventDefault(); pick(d); });
        list.appendChild(b);
      });
    }
    function pick(d) { inp.value = ''; list.hidden = true; onPick(d.ubigeo); }
    inp.addEventListener('input', render);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        U.$$('.mt-osm-sugg__item', list).forEach(function (b, i) { b.classList.toggle('is-active', i === active); });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[active]) pick(items[active]);
      } else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); list.hidden = true; }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 120); });
    return h('div', { class: 'mt-osm-picker' }, h('div', { class: 'mt-input-group' }, MT.ui.iconEl('search', { size: 16 }), inp), list);
  }
  function provincePicker(current, onPick) {
    var wrap = h('div', { class: 'mt-stack mt-stack--sm' });
    var inp = h('input', { class: 'mt-input', type: 'search', placeholder: t('osm.provincePh'), 'aria-label': t('osm.provincePh'), autocomplete: 'off' });
    var list = h('div', { class: 'mt-osm-sugg mt-osm-sugg--inline' });
    function render() {
      U.clear(list);
      MT.data.districts.searchProvinces(inp.value, { limit: 8 }).forEach(function (p) {
        list.appendChild(h('button', { type: 'button', class: 'mt-osm-sugg__item', onclick: function () { onPick(p); } },
          h('strong', null, p.province), h('span', { class: 'mt-muted' }, ' — ' + p.department + ' · ' + t('data.districts', { n: p.ubigeos.length }))));
      });
    }
    inp.addEventListener('input', render);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var b = U.$('.mt-osm-sugg__item', list); if (b) b.click(); } });
    if (current) wrap.appendChild(h('div', { class: 'mt-chips' }, h('span', { class: 'mt-chip mt-chip--accent mt-chip--plain' },
      h('span', { class: 'mt-chip__label' }, t('osm.provinceChip', { name: current.province })), h('span', { class: 'mt-chip__sub' }, current.department + ' · ' + t('data.districts', { n: current.ubigeos.length })))));
    wrap.appendChild(h('div', { class: 'mt-input-group' }, MT.ui.iconEl('search', { size: 16 }), inp));
    wrap.appendChild(list);
    return wrap;
  }

  function runScan(req) {
    var busy = MT.ui.busy({ title: t('osm.scanning'), message: t('osm.preparing'), progress: true, cancellable: true });
    var lastHost = '';
    return MT.osm.scan(req, { signal: busy.signal, onProgress: function (p) {
      if (p.endpoint) lastHost = host(p.endpoint);
      var msg;
      if (p.phase === 'retry') msg = t('osm.progress.retry', { s: p.waitS });
      else if (p.phase === 'endpointFailed') msg = t('osm.progress.failed', { host: host(p.endpoint) });
      else if (p.phase === 'process') msg = t('osm.progress.process');
      else msg = t('osm.progress.query', { n: Math.min(p.done + 1, p.total), total: p.total }) + (lastHost ? ' · ' + lastHost : '');
      busy.update({ progress: p.total ? Math.min(0.97, (p.done + (p.phase === 'process' ? 1 : 0.15)) / (p.total + 0.5)) : 0, message: msg });
    } }).then(function (result) {
      busy.close();
      return dbui.openReview(result);
    }, function (err) {
      busy.close();
      if (err && err.name === 'AbortError') { MT.ui.toast(t('osm.cancelled'), { type: 'info' }); return null; }
      showScanError(err, req);
      return null;
    });
  }
  function showScanError(err, req) {
    var details = (err && err.details) || [];
    var body = h('div', { class: 'mt-stack' },
      h('p', { class: 'mt-modal__text' }, t(err && (err.offline || err.network) ? 'osm.error.offline' : err && err.message === 'overpass-unavailable' ? 'osm.error.busy' : 'osm.error.generic')),
      details.length ? h('ul', { class: 'mt-osm-errlist' }, details.slice(0, 8).map(function (d) { return h('li', null, h('code', null, host(d.endpoint) || '—'), ' ', h('span', { class: 'mt-muted' }, d.error)); })) : null,
      h('p', { class: 'mt-hint' }, t(MT.env.isFile ? 'osm.error.tipFile' : 'osm.error.tip')));
    if (!(err && err.message === 'overpass-unavailable')) console.warn('[osm] scan failed', err);
    MT.ui.modal({ title: t('osm.error.title'), size: 'md', body: body, actions: [
      { label: t('common.close'), kind: 'secondary', value: null },
      { label: t('common.retry'), kind: 'primary', icon: 'refresh', onClick: function (close) { close(); runScan(req); return false; } },
    ] });
  }

  /** Review screen for a scan result. Resolves the apply result, or null. */
  dbui.openReview = function (res) {
    var checked = { new: {}, moved: {}, notFound: {} };
    // Doubtful proposals (odd OSM tagging, `weak` in the rules) are listed but never pre-selected.
    res.new.forEach(function (s) { checked.new[s.id] = !s._weak; });
    res.matched.forEach(function (m) { if (m.moved) checked.moved[m.store.id] = true; });
    var tab = res.new.length ? 'new' : res.matched.some(function (m) { return m.moved; }) ? 'matched' : res.notFound.length ? 'notFound' : 'new';
    var nfStatus = 'to_verify';
    var moved = res.matched.filter(function (m) { return m.moved; });
    var rmap = null, rmapReady = false;

    var meta = h('div', { class: 'mt-osm-meta' });
    var tabs = h('div', { class: 'mt-osm-tabs', role: 'tablist' });
    var listHead = h('div', { class: 'mt-osm-listhead' });
    var list = h('div', { class: 'mt-osm-list', role: 'list' });
    var mapEl = h('div', { class: 'mt-osm-map' });
    var legend = h('div', { class: 'mt-osm-legend' },
      h('span', null, h('i', { class: 'is-new' }), t('osm.legend.new')), h('span', null, h('i', { class: 'is-moved' }), t('osm.legend.moved')),
      h('span', null, h('i', { class: 'is-same' }), t('osm.legend.same')), h('span', null, h('i', { class: 'is-nf' }), t('osm.legend.notFound')));
    var body = h('div', { class: 'mt-osm-review' }, meta,
      h('div', { class: 'mt-osm-split' }, h('div', { class: 'mt-osm-left' }, tabs, listHead, list), h('div', { class: 'mt-osm-right' }, mapEl, legend)));
    var summary = h('div', { class: 'mt-osm-footsum' });
    var m = MT.ui.modal({ title: t('osm.reviewTitle'), size: 'xl', className: 'mt-osm-reviewmodal', body: body, actions: [
      { label: t('common.cancel'), kind: 'secondary', value: null },
      { label: t('osm.apply'), kind: 'primary', icon: 'check', onClick: function () { if (!countSel()) return false; m.close('apply'); return false; } },
    ], onClose: function () { if (rmap) { rmap.remove(); rmap = null; } } });
    var footer = m.el.querySelector('.mt-modal__footer');
    footer.insertBefore(summary, footer.firstChild);
    var applyBtn = footer.querySelector('.mt-btn--primary');

    // Meta line: data date, endpoint, area, warnings.
    var ts = res.timestamp ? new Date(res.timestamp) : null;
    var ageDays = ts ? Math.floor((Date.now() - ts.getTime()) / 864e5) : null;
    U.append(meta, [
      h('span', { class: 'mt-osm-meta__item' + (ageDays !== null && ageDays > 14 ? ' is-warn' : ''), title: t('osm.dataDateHint') }, MT.ui.iconEl('globe', { size: 15 }),
        ts ? t('osm.dataDate', { date: MT.i18n.formatDate(ts, { day: '2-digit', month: '2-digit', year: 'numeric' }) }) : t('osm.dataDateUnknown')),
      res.endpoint ? h('span', { class: 'mt-osm-meta__item' }, MT.ui.iconEl('database', { size: 15 }), t('osm.server', { host: res.endpoints.map(host).join(', ') })) : null,
      h('span', { class: 'mt-osm-meta__item' }, MT.ui.iconEl('pin', { size: 15 }), t('data.districts', { n: res.area.ubigeos.length }) + ' · ' + t('osm.queries', { n: res.queries })),
      h('span', { class: 'mt-osm-meta__item' }, MT.ui.iconEl('layers', { size: 15 }), t('osm.elements', { n: res.elements })),
      res.stats && res.stats.excluded ? h('span', { class: 'mt-osm-meta__item', title: t('osm.excludedHint') }, MT.ui.iconEl('sliders', { size: 15 }), t('osm.excluded', { n: res.stats.excluded })) : null]);
    if (res.failedTiles.length) meta.appendChild(h('div', { class: 'mt-osm-note mt-osm-note--warn' }, MT.ui.iconEl('warning', { size: 16 }), h('span', null, t('osm.partial', { n: res.failedTiles.length }))));
    if (res.skippedChains.length) meta.appendChild(h('div', { class: 'mt-osm-note' }, MT.ui.iconEl('info', { size: 16 }), h('span', null, t('osm.skippedChains', { list: res.skippedChains.map(function (id) { return MT.data.chain(id).name; }).join(', ') }))));
    if (ageDays !== null && ageDays > 14 && MT.env.isFile) meta.appendChild(h('div', { class: 'mt-osm-note mt-osm-note--warn' }, MT.ui.iconEl('warning', { size: 16 }), h('span', null, t('osm.staleFile', { n: ageDays }))));

    function countSel() {
      return Object.keys(checked.new).filter(function (k) { return checked.new[k]; }).length +
        Object.keys(checked.moved).filter(function (k) { return checked.moved[k]; }).length +
        Object.keys(checked.notFound).filter(function (k) { return checked.notFound[k]; }).length;
    }
    function renderTabs() {
      U.clear(tabs);
      [['new', t('osm.tab.new', { n: res.new.length })], ['matched', t('osm.tab.matched', { n: res.matched.length }) + (moved.length ? ' · ' + t('osm.tab.moved', { n: moved.length }) : '')],
        ['notFound', t('osm.tab.notFound', { n: res.notFound.length })]].forEach(function (x) {
        var b = h('button', { type: 'button', role: 'tab', class: 'mt-osm-tab mt-osm-tab--' + x[0] + (tab === x[0] ? ' is-active' : ''), 'aria-selected': String(tab === x[0]),
          'data-autofocus': tab === x[0] ? '' : null, onclick: function () { tab = x[0]; renderTabs(); renderList(); } },
          h('i', { class: 'mt-osm-tab__dot' }), x[1]);
        tabs.appendChild(b);
      });
    }
    function rowFor(kind, s, extra, key, isChecked, onToggle, dist) {
      var box = onToggle ? h('input', { type: 'checkbox', checked: !!isChecked, 'aria-label': s.name }) : h('span', { class: 'mt-osm-row__nocheck', html: MT.ui.icon('check', { size: 15 }) });
      if (onToggle) box.addEventListener('change', function () { onToggle(box.checked); renderSummary(); });
      var row = h('div', { class: 'mt-osm-row mt-osm-row--' + kind, role: 'listitem', 'data-key': key },
        h('label', { class: 'mt-osm-row__check' }, box),
        logoImg(s.chain, 26),
        h('button', { type: 'button', class: 'mt-osm-row__main', onclick: function () { focusOn(key); } },
          h('span', { class: 'mt-osm-row__title' }, h('span', { class: 'mt-truncate' }, s.name), extra),
          h('span', { class: 'mt-osm-row__sub mt-truncate' }, [s.address, s.district].filter(Boolean).join(' · ') || MT.data.chain(s.chain).name)),
        dist ? h('span', { class: 'mt-osm-row__dist' }, dist) : null);
      return row;
    }
    function bulkHead(kind, items) {
      var all = items.length > 0 && items.every(function (k) { return checked[kind][k]; });
      var some = items.some(function (k) { return checked[kind][k]; });
      var box = h('input', { type: 'checkbox', checked: all, disabled: !items.length, 'aria-label': t('osm.selectAll') });
      box.indeterminate = some && !all;
      box.addEventListener('change', function () { items.forEach(function (k) { checked[kind][k] = box.checked; }); renderList(); });
      return h('label', { class: 'mt-check mt-osm-listhead__all' }, box, h('span', null, t('osm.selectAll')));
    }
    function renderList() {
      U.clear(list); U.clear(listHead);
      if (tab === 'new') {
        listHead.append(bulkHead('new', res.new.map(function (s) { return s.id; })), h('span', { class: 'mt-osm-listhead__text' }, t('osm.head.new')));
        if (!res.new.length) list.appendChild(h('div', { class: 'mt-osm-empty' }, t('osm.none.new')));
        res.new.forEach(function (s) {
          var near = s._nearest ? t('osm.nearest', { d: MT.i18n.formatDistance(s._nearest.distance) }) : t('osm.firstOfChain');
          var badge = s._weak ? h('span', { class: 'mt-badge mt-badge--warn', title: t('osm.doubtfulHint') + (s._reason ? ' (' + s._reason + ')' : '') }, t('osm.badge.doubtful'))
            : h('span', { class: 'mt-badge mt-badge--success' }, t('osm.badge.new'));
          list.appendChild(rowFor('new', s, badge, s.id, checked.new[s.id], function (v) { checked.new[s.id] = v; }, near));
        });
        if (res.new.some(function (s) { return s._weak; })) list.appendChild(h('div', { class: 'mt-osm-hintrow' }, MT.ui.iconEl('info', { size: 15 }), t('osm.doubtfulHint')));
      } else if (tab === 'matched') {
        listHead.append(bulkHead('moved', moved.map(function (x) { return x.store.id; })), h('span', { class: 'mt-osm-listhead__text' }, t('osm.head.matched')));
        if (!res.matched.length) list.appendChild(h('div', { class: 'mt-osm-empty' }, t('osm.none.matched')));
        res.matched.forEach(function (x) {
          var s = x.store;
          var extra = x.moved ? h('span', { class: 'mt-badge mt-badge--warn' }, t('osm.badge.moved')) : s.status === 'closed' ? statusBadge('closed') : null;
          list.appendChild(rowFor(x.moved ? 'moved' : 'same', s, extra, s.id, checked.moved[s.id], x.moved ? function (v) { checked.moved[s.id] = v; } : null,
            x.moved ? t('osm.movedBy', { d: MT.i18n.formatDistance(x.distance) }) : t('osm.same')));
        });
      } else {
        var seg = MT.ui.segmented({ ariaLabel: t('osm.nfAction'), value: nfStatus, options: [{ value: 'to_verify', label: t('data.status.to_verify') }, { value: 'closed', label: t('data.status.closed') }],
          onChange: function (v) { nfStatus = v; renderSummary(); } });
        seg.classList.add('mt-seg--compact');
        listHead.append(bulkHead('notFound', res.notFound.map(function (s) { return s.id; })), h('span', { class: 'mt-osm-listhead__text' }, t('osm.markAs')), seg);
        if (!res.notFound.length) list.appendChild(h('div', { class: 'mt-osm-empty' }, t('osm.none.notFound')));
        res.notFound.forEach(function (s) {
          var badge = h('span', { class: 'mt-badge mt-badge--danger' }, t(s._closedInOsm ? 'osm.badge.closedInOsm' : 'osm.badge.notFound'));
          list.appendChild(rowFor('nf', s, badge, s.id, checked.notFound[s.id], function (v) { checked.notFound[s.id] = v; }, s._osmRef || s.source_ref || ''));
        });
        list.appendChild(h('div', { class: 'mt-osm-hintrow' }, MT.ui.iconEl('info', { size: 15 }), t('osm.nfHint')));
      }
      renderSummary();
    }
    function renderSummary() {
      var n = function (k) { return Object.keys(checked[k]).filter(function (x) { return checked[k][x]; }).length; };
      var parts = [];
      if (n('new')) parts.push(t('osm.sum.add', { n: n('new') }));
      if (n('moved')) parts.push(t('osm.sum.move', { n: n('moved') }));
      if (n('notFound')) parts.push(t('osm.sum.mark', { n: n('notFound'), status: t('data.status.' + nfStatus) }));
      summary.textContent = parts.length ? parts.join(' · ') : t('osm.sum.nothing');
      applyBtn.disabled = !parts.length;
    }

    // Review map: green = new, amber = moved (line from DB to OSM), grey = unchanged, red = not found.
    function reviewGeo() {
      var f = [];
      var pt = function (s, kind, key) { f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { kind: kind, key: key } }); };
      res.new.forEach(function (s) { pt(s, 'new', s.id); });
      res.matched.forEach(function (x) {
        if (x.moved) {
          f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[x.store.lng, x.store.lat], [x.osm.lng, x.osm.lat]] }, properties: { kind: 'line', key: x.store.id } });
          pt(x.store, 'old', x.store.id); pt(x.osm, 'moved', x.store.id);
        } else pt(x.osm, 'same', x.store.id);
      });
      res.notFound.forEach(function (s) { if (isFinite(s.lat)) pt(s, 'nf', s.id); });
      return { type: 'FeatureCollection', features: f };
    }
    function focusOn(key) {
      U.$$('.mt-osm-row', list).forEach(function (r) { r.classList.toggle('is-focus', r.dataset.key === key); });
      if (!rmap || !rmapReady) return;
      var feat = reviewGeo().features.find(function (x) { return x.properties.key === key && x.geometry.type === 'Point' && x.properties.kind !== 'old'; });
      if (!feat) return;
      rmap.setFilter('osm-focus', ['==', ['get', 'key'], key]);
      rmap.easeTo({ center: feat.geometry.coordinates, zoom: Math.max(rmap.getZoom(), 16), duration: 500 });
    }
    setTimeout(function () {
      if (!window.maplibregl || !m.el.isConnected) return;
      var gj = reviewGeo();
      var pts = gj.features.filter(function (x) { return x.geometry.type === 'Point'; }).map(function (x) { return x.geometry.coordinates; });
      var b = MT.geo.bboxOfPoints(pts) || MT.data.districts.unionBbox(res.area.ubigeos);
      rmap = dbui.createMap(mapEl, { map: b ? { bounds: MT.geo.bboxToBounds(MT.geo.bboxMinSize(b, 1500)), fitBoundsOptions: { padding: 40 } } : {} });
      if (!rmap) return;
      rmap.on('load', function () {
        rmap.addSource('osm', { type: 'geojson', data: gj });
        rmap.addLayer({ id: 'osm-line', type: 'line', source: 'osm', filter: ['==', ['get', 'kind'], 'line'], paint: { 'line-color': '#B45309', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
        rmap.addLayer({ id: 'osm-focus', type: 'circle', source: 'osm', filter: ['==', ['get', 'key'], ''], paint: { 'circle-radius': 14, 'circle-color': MT.theme.colors.accent, 'circle-opacity': 0.15, 'circle-stroke-color': MT.theme.colors.accent, 'circle-stroke-width': 2 } });
        rmap.addLayer({ id: 'osm-pts', type: 'circle', source: 'osm', filter: ['==', ['geometry-type'], 'Point'], paint: {
          'circle-radius': ['match', ['get', 'kind'], 'same', 4, 'old', 4.5, 6.5],
          'circle-color': ['match', ['get', 'kind'], 'new', '#16A34A', 'moved', '#D97706', 'same', '#A1A1AA', 'old', '#FFFFFF', 'nf', '#FFFFFF', '#71717A'],
          'circle-stroke-color': ['match', ['get', 'kind'], 'old', '#D97706', 'nf', '#DC2626', '#FFFFFF'],
          'circle-stroke-width': ['match', ['get', 'kind'], 'nf', 2.5, 'old', 2, 1.5] } });
        rmap.on('click', 'osm-pts', function (e) {
          var k = e.features[0].properties.key, kind = e.features[0].properties.kind;
          tab = kind === 'new' ? 'new' : kind === 'nf' ? 'notFound' : 'matched';
          renderTabs(); renderList(); focusOn(k);
          var row = U.$('.mt-osm-row[data-key="' + CSS.escape(k) + '"]', list);
          if (row) row.scrollIntoView({ block: 'nearest' });
        });
        rmap.on('mouseenter', 'osm-pts', function () { rmap.getCanvas().style.cursor = 'pointer'; });
        rmap.on('mouseleave', 'osm-pts', function () { rmap.getCanvas().style.cursor = ''; });
        rmapReady = true;
      });
    }, 220);

    renderTabs(); renderList();
    return m.result.then(function (v) {
      if (v !== 'apply') return null;
      var pick = function (k) { return function (x) { return checked[k][x.id || x.store.id]; }; };
      var sel = { new: res.new.filter(pick('new')), moved: moved.filter(pick('moved')), notFound: res.notFound.filter(pick('notFound')) };
      return MT.osm.apply(sel, { notFoundStatus: nfStatus }).then(function (r) {
        var parts = [];
        if (sel.new.length) parts.push(t('osm.done.added', { n: sel.new.length }));
        if (sel.moved.length) parts.push(t('osm.done.moved', { n: sel.moved.length }));
        if (sel.notFound.length) parts.push(t('osm.done.marked', { n: sel.notFound.length, status: t('data.status.' + nfStatus) }));
        MT.ui.toast(parts.join(' · '), { type: 'success', timeout: 7000, action: { label: t('db.changes.view'), onClick: function () { MT.app.showTab('db'); dbui.setFilters({ local: true }); } } });
        return r;
      }, function (err) { console.error(err); MT.ui.toast(t('db.error.save'), { type: 'error' }); return null; });
    });
  };

  /* =========================================================================================
   * Registration
   * ======================================================================================= */
  MT.app.registerTab({
    id: 'db', labelKey: 'tab.db', icon: 'database', order: 20, hash: 'base',
    mount: mount,
    onShow: function () {
      if (map) setTimeout(function () { map.resize(); }, 0);
      if (mounted) requestAnimationFrame(function () { renderRows(true); });
    },
    onHide: function () { if (openPop) openPop.close(); },
  });
  MT.bus.on('app:showChanges', function () {
    MT.app.showTab('db');
    dbui.setFilters({ local: true });
  });
})();
