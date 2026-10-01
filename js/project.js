/* js/project.js — MT.project: the project (a list of maps = slides), SPEC §3.5.
 *
 * Always mutate through this API so autosave and events stay consistent:
 *   'project:loaded'  {project}                    new/open/restore replaced the whole project
 *   'project:changed' {reason, id?}                reason: 'add'|'duplicate'|'remove'|'move'|'rename'
 *   'map:changed'     {id, keys, map}              updateMap() (keys = top-level keys patched)
 *   'map:selected'    {id, map}                    current map changed (id may be null)
 *   'project:saved'   {method:'file'|'download', name}
 *   'project:dirty'   {dirty}                      unsaved-to-file state flipped
 * The project is autosaved to localStorage (debounced) and restored on startup.
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util;
  var AUTOSAVE_KEY = 'mt.project.autosave';
  var TYPE = 'mapa-tiendas-project', VERSION = 1;

  var project = null;     // the live project object
  var currentId = null;
  var dirty = false;
  var fileHandle = null;  // FS Access handle of the last saved/opened file

  var P = (MT.project = {
    TYPE: TYPE, VERSION: VERSION,
    MARKER_STYLES: ['badge', 'card', 'dot', 'number'],
    FIT_TO: ['stores', 'districts'],
    LEGEND_SORT: ['alpha', 'count'],
  });

  /** A new map with SPEC defaults: all chains at their defaultOn, onlyInside on, borders off… */
  P.defaultMap = function (partial) {
    var chains = {};
    (MT.data.chains() || []).forEach(function (c) { if (!c.unknown) chains[c.id] = c.defaultOn !== false; });
    var m = {
      id: U.uid('m'),
      // Empty = untitled: the UI shows a placeholder in the CURRENT language ("Mapa sin título" /
      // "Untitled map") instead of storing one language's placeholder as real slide text.
      title: '',
      subtitle: '', subtitleAuto: true,
      peso: '',
      districts: [],
      chains: chains,
      onlyInside: true, showBorders: false, fitTo: 'stores',
      markerStyle: MT.theme.marker.defaults.style, markerSize: MT.theme.marker.defaults.size, legendSort: 'alpha',
      // Same-chain grouping of nearby stores (one logo with a count): 'auto' | true | false.
      groupNearby: 'auto',
      view: null,
      hiddenStores: [],
      markerOffsets: {},
      radius: [],
    };
    return Object.assign(m, partial ? U.clone(partial) : {});
  };

  /** A blank project. */
  P.blank = function (name) {
    return { type: TYPE, version: VERSION, name: name || '', updated: new Date().toISOString(), maps: [] };
  };
  /** Placeholder texts in every UI language (older projects stored them as real names). */
  function isPlaceholder(text, key) {
    var v = String(text || '').trim();
    return !!v && MT.i18n.langs.some(function (l) { return v === MT.i18n.tIn(l, key); });
  }
  P.isPlaceholder = isPlaceholder;
  /** The project name to show ("Proyecto sin título" in the current language when unnamed). */
  P.displayName = function () { return (project && project.name) || MT.t('project.untitled'); };

  /** Validate/migrate a parsed project object (fills missing fields; keeps unknown chain ids). */
  P.normalize = function (obj) {
    if (!obj || typeof obj !== 'object' || obj.type !== TYPE || !Array.isArray(obj.maps)) throw new Error('project-invalid');
    if (obj.version > VERSION) throw new Error('project-newer');
    var p = P.blank(isPlaceholder(obj.name, 'project.untitled') ? '' : String(obj.name || ''));
    p.updated = obj.updated || p.updated;
    var seen = {};
    p.maps = obj.maps.map(function (raw) {
      var base = P.defaultMap();
      var defaultChains = base.chains;
      var m = Object.assign(base, U.clone(raw));
      if (!m.id || seen[m.id]) m.id = U.uid('m');
      seen[m.id] = true;
      m.title = String(m.title === undefined || m.title === null ? '' : m.title);
      if (isPlaceholder(m.title, 'project.untitledMap')) m.title = '';
      m.peso = String(m.peso === undefined || m.peso === null ? '' : m.peso);
      m.districts = Array.isArray(m.districts) ? m.districts.map(String) : [];
      m.chains = Object.assign({}, defaultChains, m.chains && typeof m.chains === 'object' ? m.chains : {});
      if (P.MARKER_STYLES.indexOf(m.markerStyle) < 0) m.markerStyle = 'badge';
      if (P.FIT_TO.indexOf(m.fitTo) < 0) m.fitTo = 'stores';
      if (P.LEGEND_SORT.indexOf(m.legendSort) < 0) m.legendSort = 'alpha';
      m.markerSize = U.clamp(+m.markerSize || 1, MT.theme.marker.defaults.minSize, MT.theme.marker.defaults.maxSize);
      if (m.groupNearby !== true && m.groupNearby !== false) m.groupNearby = 'auto';
      m.hiddenStores = Array.isArray(m.hiddenStores) ? m.hiddenStores : [];
      m.markerOffsets = m.markerOffsets && typeof m.markerOffsets === 'object' ? m.markerOffsets : {};
      m.radius = Array.isArray(m.radius) ? m.radius.filter(function (r) { return r && r.storeId && +r.meters > 0; }) : [];
      if (m.view && !(Array.isArray(m.view.center) && isFinite(m.view.zoomRef))) m.view = null;
      return m;
    });
    return p;
  };

  /* ---- Accessors ------------------------------------------------------------------------- */
  P.current = function () { return project; };
  P.maps = function () { return project ? project.maps : []; };
  P.getMap = function (id) { return P.maps().find(function (m) { return m.id === id; }) || null; };
  P.currentMapId = function () { return currentId; };
  P.currentMap = function () { return P.getMap(currentId); };
  P.isDirty = function () { return dirty; };
  P.fileName = function () { return fileHandle ? fileHandle.name : null; };
  /** Chain toggle state on a map (missing entry → chain.defaultOn). */
  P.chainOn = function (map, chainId) { return MT.data.chainOn(map, chainId); };

  /* ---- Mutations ------------------------------------------------------------------------- */
  function touch(reason, id) {
    project.updated = new Date().toISOString();
    setDirty(true);
    autosave();
    if (reason) MT.bus.emit('project:changed', { reason: reason, id: id });
  }
  function setDirty(v) {
    if (dirty === v) return;
    dirty = v;
    MT.bus.emit('project:dirty', { dirty: v });
  }

  P.addMap = function (partial, opts) {
    var m = P.defaultMap(partial);
    var at = opts && isFinite(opts.index) ? opts.index : project.maps.length;
    project.maps.splice(at, 0, m);
    touch('add', m.id);
    if (!opts || opts.select !== false) P.select(m.id);
    return m;
  };

  P.duplicateMap = function (id) {
    var src = P.getMap(id);
    if (!src) return null;
    var copy = U.clone(src);
    copy.id = U.uid('m');
    copy.title = src.title ? MT.t('project.copyOf', { title: src.title }) : '';
    var idx = project.maps.indexOf(src) + 1;
    project.maps.splice(idx, 0, copy);
    touch('duplicate', copy.id);
    P.select(copy.id);
    return copy;
  };

  P.removeMap = function (id) {
    var i = project.maps.findIndex(function (m) { return m.id === id; });
    if (i < 0) return false;
    project.maps.splice(i, 1);
    touch('remove', id);
    if (currentId === id) {
      var next = project.maps[Math.min(i, project.maps.length - 1)];
      P.select(next ? next.id : null);
    }
    return true;
  };

  P.moveMap = function (id, toIndex) {
    var i = project.maps.findIndex(function (m) { return m.id === id; });
    if (i < 0) return false;
    var to = U.clamp(toIndex, 0, project.maps.length - 1);
    if (to === i) return false;
    var m = project.maps.splice(i, 1)[0];
    project.maps.splice(to, 0, m);
    touch('move', id);
    return true;
  };

  /**
   * Patch a map: top-level keys are REPLACED (pass whole objects for chains, markerOffsets,
   * radius, …). Emits 'map:changed' {id, keys, map} only when something actually changed.
   */
  P.updateMap = function (id, patch) {
    var m = P.getMap(id);
    if (!m || !patch) return null;
    var keys = Object.keys(patch).filter(function (k) { return k !== 'id' && !U.isEqual(m[k], patch[k]); });
    if (!keys.length) return m;
    keys.forEach(function (k) { m[k] = U.clone(patch[k]); });
    touch(null);
    MT.bus.emit('map:changed', { id: id, keys: keys, map: m });
    return m;
  };

  P.select = function (id) {
    if (id !== null && !P.getMap(id)) return;
    if (currentId === id) return;
    currentId = id;
    MT.storage.local.set(AUTOSAVE_KEY + '.current', id || '');
    MT.bus.emit('map:selected', { id: id, map: P.getMap(id) });
  };

  P.rename = function (name) {
    name = String(name || '').trim();
    if (!name || name === project.name) return;
    project.name = name;
    touch('rename');
  };

  /* ---- Load / save ----------------------------------------------------------------------- */
  function load(p, opts) {
    project = p;
    currentId = null;
    fileHandle = (opts && opts.handle) || null;
    setDirty(!!(opts && opts.dirty));
    MT.bus.emit('project:loaded', { project: project });
    var want = opts && opts.current;
    P.select(want && P.getMap(want) ? want : (project.maps[0] ? project.maps[0].id : null));
  }

  /** Start a new project (with one empty map). The UI asks for confirmation first if dirty. */
  P.newProject = function (name) {
    var p = P.blank(name);
    load(p);
    P.addMap();
    setDirty(false);
    writeAutosave();
    return project;
  };

  P['new'] = P.newProject; // alias

  /** Open a *.mapa.json File (or a FileSystemFileHandle). Resolves the project. */
  P.open = function (fileOrHandle) {
    var handle = fileOrHandle && fileOrHandle.getFile ? fileOrHandle : null;
    var getFile = handle ? handle.getFile() : Promise.resolve(fileOrHandle);
    return getFile.then(function (file) { return MT.io.readAsText(file); }).then(function (text) {
      var obj;
      try { obj = JSON.parse(text); } catch (e) { throw new Error('project-invalid'); }
      load(P.normalize(obj), { handle: handle });
      writeAutosave();
      return project;
    });
  };

  /**
   * Open a project from a plain object (e.g. the built-in example, window.MT_EXAMPLE_PROJECT).
   * The object is validated and copied (never kept or mutated). opts.name replaces the project
   * name. Not tied to any file: Ctrl+S asks where to save it. Throws project-invalid/-newer.
   */
  P.openData = function (obj, opts) {
    var p = P.normalize(U.clone(obj));
    if (opts && opts.name) p.name = String(opts.name);
    p.updated = new Date().toISOString();
    load(p, {});
    writeAutosave();
    return project;
  };

  /** Show the open dialog (FS Access when available, else a file input) and open the file. */
  P.openDialog = function () {
    if (MT.env.fsAccess && window.showOpenFilePicker) {
      return window.showOpenFilePicker({ id: 'mapa-tiendas-project', types: [{ description: MT.t('project.fileType'), accept: { 'application/json': ['.json'] } }] })
        .then(function (hs) { return P.open(hs[0]); }, function (err) { if (err && err.name === 'AbortError') return null; throw err; });
    }
    return MT.ui.pickFile({ accept: '.json,application/json' }).then(function (f) { return f ? P.open(f) : null; });
  };

  P.toJSON = function () {
    return JSON.stringify(Object.assign({}, project, { type: TYPE, version: VERSION, updated: new Date().toISOString() }), null, 2);
  };
  P.suggestedFileName = function () { return MT.io.safeFilename(P.displayName(), 'proyecto') + '.mapa.json'; };

  /**
   * Save the project file. With File System Access it writes to the same file again (Ctrl+S);
   * saveAs or no handle → save picker (or a download where the API does not exist).
   * Resolves {method, name} or null if the user cancelled.
   */
  P.save = function (opts) {
    opts = opts || {};
    var json = P.toJSON();
    var done = function (method, name) {
      setDirty(false);
      writeAutosave();
      MT.bus.emit('project:saved', { method: method, name: name });
      return { method: method, name: name };
    };
    if (MT.env.saveFilePicker && !opts.download) {
      var getHandle = fileHandle && !opts.saveAs ? Promise.resolve(fileHandle)
        : window.showSaveFilePicker({ id: 'mapa-tiendas-project', suggestedName: P.suggestedFileName(),
          types: [{ description: MT.t('project.fileType'), accept: { 'application/json': ['.json'] } }] });
      return getHandle.then(function (h) {
        return h.createWritable().then(function (w) { return w.write(json).then(function () { return w.close(); }); })
          .then(function () { fileHandle = h; return done('file', h.name); });
      }, function (err) { if (err && err.name === 'AbortError') return null; throw err; });
    }
    var name = P.suggestedFileName();
    MT.io.download(new Blob([json], { type: 'application/json' }), name);
    return Promise.resolve(done('download', name));
  };

  /* ---- Autosave (localStorage) ------------------------------------------------------------ */
  var suspended = false;  // true while this tab is paused because the app is open in another tab
  function writeAutosave() {
    if (!project || suspended) return;
    MT.storage.local.set(AUTOSAVE_KEY, JSON.stringify({ project: project, dirty: dirty, fileName: P.fileName() }));
  }
  var autosave = U.debounce(writeAutosave, 500);
  /** Write the pending autosave now (modules call it after flushing their own debounced edits). */
  P.flushAutosave = function () { autosave.flush(); };
  /** Stop (true) / resume (false) autosaving — a paused tab must not overwrite the active tab's project. */
  P.suspendAutosave = function (on) { if (on) autosave.flush(); suspended = !!on; if (on) autosave.cancel(); };
  // Both events: 'beforeunload' does not fire on every close (mobile, bfcache); 'pagehide' does.
  // Modules with their own debounced edits (Mapas text fields) flush those first, then call
  // P.flushAutosave() — their listeners are registered later and would otherwise run too late.
  window.addEventListener('beforeunload', function () { autosave.flush(); });
  window.addEventListener('pagehide', function () { autosave.flush(); });

  /**
   * Restore the autosaved project (or create a fresh one). Called once by MT.app at boot,
   * after MT.data.ready. Returns the project.
   */
  P.restore = function () {
    var raw = MT.storage.local.get(AUTOSAVE_KEY);
    if (raw) {
      try {
        var saved = JSON.parse(raw);
        load(P.normalize(saved.project), { dirty: !!saved.dirty, current: MT.storage.local.get(AUTOSAVE_KEY + '.current') });
        return project;
      } catch (e) {
        console.warn('[project] autosave unreadable, starting fresh', e);
      }
    }
    return P.newProject();
  };
})();
