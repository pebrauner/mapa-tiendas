/* js/storage.js — MT.storage: browser persistence.
 *
 *  - IndexedDB "mapa-tiendas" holds the LOCAL OVERLAY on top of the shipped seed (SPEC §3.6):
 *      stores  {id, op:'add'|'edit'|'delete', store?, at}      (store = full record for add/edit)
 *      chains  {id, op:'add'|'edit', chain, at}
 *      logos   {id: chainId, badge?, wide?, at}                 (data URIs uploaded by the user)
 *      kv      {key, value}                                     (folder handle, misc)
 *    If IndexedDB is unavailable (private mode, blocked) an in-memory fallback keeps the app
 *    working for the session and MT.storage.persistent is false.
 *  - localStorage holds small preferences: MT.storage.pref(key, fallback) / setPref(key, value).
 *  - File System Access "save to folder" (Chrome/Edge): remembered folder handle, permission
 *    re-request, nested writes; falls back to downloads elsewhere.
 */
(function () {
  'use strict';
  var MT = window.MT;
  var DB_NAME = 'mapa-tiendas', DB_VERSION = 1;
  var STORES = { stores: 'id', chains: 'id', logos: 'id', kv: 'key' };
  var db = null;
  var memory = { stores: {}, chains: {}, logos: {}, kv: {} };

  function openDb() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        Object.keys(STORES).forEach(function (name) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: STORES[name] });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function tx(store, mode, fn) {
    if (!db) {
      // In-memory fallback mirrors the IndexedDB API surface used below.
      return Promise.resolve(fn(null));
    }
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode), os = t.objectStore(store), result;
      try { result = fn(os); } catch (err) { reject(err); return; }
      t.oncomplete = function () { resolve(result && result.__req ? result.__req.result : result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('IndexedDB transaction aborted')); };
    });
  }
  function reqWrap(req) { return { __req: req }; }

  // localStorage can throw (site data blocked) even when the object exists.
  function probeLocal() {
    try { localStorage.setItem('mt.probe', '1'); localStorage.removeItem('mt.probe'); return true; } catch (e) { return false; }
  }

  var storage = (MT.storage = {
    /** IndexedDB works (false → local database changes live in memory only, lost on reload). */
    persistent: false,
    /** localStorage works (false → the project autosave and preferences are not kept). */
    localUsable: probeLocal(),
    ready: openDb().then(function (d) {
      db = d; storage.persistent = !!d;
      // Ask the browser not to evict our data under storage pressure (silent, best effort).
      try { if (d && navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(function (p) { return p || navigator.storage.persist(); }).catch(function () {}); } catch (e) { /* ignore */ }
      return storage;
    }),

    /** All records of an overlay store ('stores' | 'chains' | 'logos' | 'kv'). */
    getAll: function (store) {
      return tx(store, 'readonly', function (os) {
        if (!os) return Object.keys(memory[store]).map(function (k) { return MT.util.clone(memory[store][k]); });
        return reqWrap(os.getAll());
      });
    },
    get: function (store, id) {
      return tx(store, 'readonly', function (os) {
        if (!os) return MT.util.clone(memory[store][id]);
        return reqWrap(os.get(id));
      });
    },
    /** Insert/replace one record (or an array of records, in one transaction). */
    put: function (store, records) {
      var list = Array.isArray(records) ? records : [records];
      return tx(store, 'readwrite', function (os) {
        list.forEach(function (r) {
          if (!os) memory[store][r[STORES[store]]] = MT.util.clone(r);
          else os.put(r);
        });
        return list.length;
      });
    },
    delete: function (store, ids) {
      var list = Array.isArray(ids) ? ids : [ids];
      return tx(store, 'readwrite', function (os) {
        list.forEach(function (id) { if (!os) delete memory[store][id]; else os.delete(id); });
        return list.length;
      });
    },
    clear: function (store) {
      return tx(store, 'readwrite', function (os) { if (!os) memory[store] = {}; else os.clear(); return true; });
    },
    kvGet: function (key) { return storage.get('kv', key).then(function (r) { return r ? r.value : undefined; }); },
    kvSet: function (key, value) { return storage.put('kv', { key: key, value: value }); },

    /* ---- Preferences (localStorage, JSON) ------------------------------------------------ */
    pref: function (key, fallback) {
      try {
        var raw = localStorage.getItem('mt.pref.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    setPref: function (key, value) {
      try { localStorage.setItem('mt.pref.' + key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    /** Raw localStorage access that never throws (used by project autosave). */
    local: {
      get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
      remove: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
    },
  });

  /* ------------------------------------------------------------------------------------------
   * Messages between tabs/windows of the app in this browser (all copies on file:// share one
   * storage, like all pages of one https origin). BroadcastChannel where it works, plus a
   * localStorage 'storage' event as the fallback; duplicates are dropped by nonce.
   *   MT.storage.channel.post(type, data)   MT.storage.channel.on(fn(msg)) → off()
   *   msg = {type, data, from (tab id), nonce, at}
   * ---------------------------------------------------------------------------------------- */
  var TAB_ID = 'tab-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679616).toString(36);
  var MSG_KEY = 'mt.tabs.msg';
  var bc = null, handlers = [], seenMsg = {}, msgSeq = 0;
  try { bc = new BroadcastChannel('mapa-tiendas'); } catch (e) { bc = null; }
  function deliver(msg) {
    if (!msg || typeof msg !== 'object' || msg.from === TAB_ID || !msg.nonce || seenMsg[msg.nonce]) return;
    seenMsg[msg.nonce] = true;
    handlers.slice().forEach(function (fn) { try { fn(msg); } catch (err) { console.error('[storage] channel handler failed', err); } });
  }
  if (bc) bc.onmessage = function (e) { deliver(e.data); };
  window.addEventListener('storage', function (e) {
    if (e.key !== MSG_KEY || !e.newValue) return;
    try { deliver(JSON.parse(e.newValue)); } catch (err) { /* not ours */ }
  });
  storage.channel = {
    id: TAB_ID,
    post: function (type, data) {
      var msg = { type: type, data: data || {}, from: TAB_ID, nonce: TAB_ID + '-' + (++msgSeq), at: Date.now() };
      if (bc) { try { bc.postMessage(msg); } catch (e) { /* closed */ } }
      storage.local.set(MSG_KEY, JSON.stringify(msg));
      return msg;
    },
    on: function (fn) { handlers.push(fn); return function () { handlers = handlers.filter(function (x) { return x !== fn; }); }; },
  };

  /* ------------------------------------------------------------------------------------------
   * File System Access: "Guardar en carpeta" (Chrome/Edge). The folder handle is persisted in
   * IndexedDB; permission must be re-granted after a browser restart (needs a user gesture, so
   * call ensureFolder() from a click handler).
   * ---------------------------------------------------------------------------------------- */
  var FOLDER_KEY = 'folderHandle';
  storage.fs = {
    supported: MT.env.fsAccess,

    /** The remembered folder handle (may lack permission), or null. */
    remembered: function () {
      if (!storage.fs.supported) return Promise.resolve(null);
      return storage.kvGet(FOLDER_KEY).then(function (h) { return h || null; }, function () { return null; });
    },
    folderName: function () { return storage.fs.remembered().then(function (h) { return h ? h.name : null; }); },

    /** Ask the user to choose the project folder (the one containing index.html). */
    pickFolder: function () {
      if (!storage.fs.supported) return Promise.reject(new Error('fs-unsupported'));
      return window.showDirectoryPicker({ id: 'mapa-tiendas', mode: 'readwrite' }).then(function (h) {
        return storage.kvSet(FOLDER_KEY, h).then(function () { return h; }, function () { return h; });
      });
    },

    /** Return a writable folder: remembered one (re-requesting permission) or a newly picked one. */
    ensureFolder: function (opts) {
      opts = opts || {};
      return storage.fs.remembered().then(function (h) {
        if (!h || opts.pick) return storage.fs.pickFolder();
        return verifyPermission(h).then(function (ok) { return ok ? h : storage.fs.pickFolder(); });
      });
    },

    /** Does the folder look like the app folder (has index.html and/or data/)? */
    looksLikeApp: function (h) {
      return Promise.all([fileExists(h, 'index.html'), dirExists(h, 'data')]).then(function (r) { return r[0] || r[1]; });
    },

    /**
     * Write files into the folder. files: [{path: 'data/stores.csv', data: string|Blob}].
     * Intermediate directories are created.
     */
    writeFiles: function (folder, files) {
      return files.reduce(function (p, f) {
        return p.then(function () { return writePath(folder, f.path, f.data); });
      }, Promise.resolve()).then(function () { return files.map(function (f) { return f.path; }); });
    },

    forget: function () { return storage.delete('kv', FOLDER_KEY); },

    /**
     * Is `folder` the folder this page is running from? Only answerable on file://: a tiny
     * script with a random nonce is written into the folder and loaded from the running page's
     * own address. All file:// copies of the app share one remembered folder handle, so after
     * updating the app (new ZIP extracted elsewhere) the remembered folder can be an OLD copy.
     * Resolves true / false (null when the question does not apply, e.g. on https).
     */
    isRunningFolder: function (folder) {
      if (!MT.env.isFile) return Promise.resolve(null);
      var nonce = 'mt-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
      var name = 'mt-folder-check.js';
      var src = name + '?v=' + nonce;
      return writePath(folder, name, 'window.MT_FOLDER_CHECK = ' + JSON.stringify(nonce) + ';\n').then(function () {
        return new Promise(function (resolve) {
          var el = document.createElement('script');
          var done = function () { el.remove(); resolve(window.MT_FOLDER_CHECK === nonce); };
          el.onload = done; el.onerror = done;
          el.src = src;
          document.head.appendChild(el);
        });
      }).then(function (same) {
        // Tidy up either way; a leftover check file is harmless (and git-ignored).
        return folder.removeEntry(name).then(function () { return same; }, function () { return same; });
      });
    },
  };

  /**
   * High-level "save to folder" with graceful fallback: tries the File System Access API,
   * otherwise downloads each file. Resolves {method:'folder'|'download', folder?, written[]}.
   * Must be called from a user gesture (click) for the picker / permission prompt.
   */
  storage.saveToFolder = function (files, opts) {
    opts = opts || {};
    if (!storage.fs.supported || opts.forceDownload) {
      files.forEach(function (f) { MT.io.download(f.data, f.path.split('/').pop()); });
      return Promise.resolve({ method: 'download', written: files.map(function (f) { return f.path; }) });
    }
    return storage.fs.ensureFolder({ pick: opts.pick }).then(function (folder) {
      return storage.fs.writeFiles(folder, files).then(function (written) {
        return { method: 'folder', folder: folder.name, written: written };
      });
    });
  };

  function verifyPermission(h) {
    var o = { mode: 'readwrite' };
    if (!h.queryPermission) return Promise.resolve(true);
    return h.queryPermission(o).then(function (state) {
      if (state === 'granted') return true;
      return h.requestPermission(o).then(function (s) { return s === 'granted'; });
    }).catch(function () { return false; });
  }
  function fileExists(dir, name) { return dir.getFileHandle(name).then(function () { return true; }, function () { return false; }); }
  function dirExists(dir, name) { return dir.getDirectoryHandle(name).then(function () { return true; }, function () { return false; }); }
  function writePath(root, path, data) {
    var parts = path.split('/').filter(Boolean), name = parts.pop();
    return parts.reduce(function (p, part) {
      return p.then(function (dir) { return dir.getDirectoryHandle(part, { create: true }); });
    }, Promise.resolve(root)).then(function (dir) {
      return dir.getFileHandle(name, { create: true });
    }).then(function (fh) {
      return fh.createWritable();
    }).then(function (w) {
      return w.write(data).then(function () { return w.close(); });
    });
  }
})();
