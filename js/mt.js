/* js/mt.js — the MT namespace, event bus and small shared helpers.
 *
 * Loaded first among the app scripts (after vendor + data globals). Classic script, no modules:
 * everything hangs off window.MT. See docs/ARCHITECTURE.md for the full API reference.
 */
(function () {
  'use strict';
  var MT = (window.MT = window.MT || {});

  MT.version = '1.0.0';

  // Environment facts used across modules.
  MT.env = {
    isFile: location.protocol === 'file:',
    fsAccess: typeof window.showDirectoryPicker === 'function',
    saveFilePicker: typeof window.showSaveFilePicker === 'function',
    // Data files that failed to load (index.html pushes into window.MT_MISSING via onerror).
    missingFiles: (window.MT_MISSING || []).slice(),
  };

  /* ------------------------------------------------------------------------------------------
   * Event bus. Handlers run synchronously in registration order; a throwing handler is logged
   * and does not stop the others.  on() returns an unsubscribe function.
   * ---------------------------------------------------------------------------------------- */
  var handlers = {};
  MT.bus = {
    on: function (event, fn) {
      (handlers[event] = handlers[event] || []).push(fn);
      return function () { MT.bus.off(event, fn); };
    },
    once: function (event, fn) {
      var off = MT.bus.on(event, function (payload) { off(); fn(payload); });
      return off;
    },
    off: function (event, fn) {
      var list = handlers[event];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (event, payload) {
      var list = (handlers[event] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (err) { console.error('[MT.bus] handler for "' + event + '" failed:', err); }
      }
    },
    /** For debugging: number of listeners per event. */
    count: function (event) { return (handlers[event] || []).length; },
  };

  /* ------------------------------------------------------------------------------------------
   * Utilities
   * ---------------------------------------------------------------------------------------- */
  var U = (MT.util = {});

  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /**
   * Hyperscript-style element builder.
   *   h('button', { class: 'mt-btn', onclick: fn, 'data-i18n': 'common.save' }, 'Guardar')
   * attrs: class/className, style (string|object), dataset (object), on<event> (function),
   * html (trusted innerHTML), text, any other attribute (false/null = omitted, true = "").
   * children: strings, nodes, arrays (nested), null/false (skipped).
   */
  U.h = function (tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class' || k === 'className') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value' && 'value' in el) el.value = v;
        else if ((k === 'checked' || k === 'disabled' || k === 'selected') && k in el) el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    U.append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  };
  U.append = function (el, children) {
    (function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    })(children);
    return el;
  };
  U.clear = function (el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; };

  U.debounce = function (fn, ms) {
    var t = null;
    var d = function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
    d.cancel = function () { clearTimeout(t); t = null; };
    d.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return d;
  };
  U.throttle = function (fn, ms) {
    var last = 0, t = null;
    return function () {
      var args = arguments, self = this, now = Date.now();
      var run = function () { last = Date.now(); t = null; fn.apply(self, args); };
      if (now - last >= ms) run();
      else if (!t) t = setTimeout(run, ms - (now - last));
    };
  };
  /** Next animation frame as a promise (useful to let the DOM settle). */
  U.nextFrame = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };
  U.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var uidCounter = 0;
  /** Unique-enough id: prefix + base36 time + counter (e.g. "m-lx3k9a-1"). */
  U.uid = function (prefix) {
    uidCounter += 1;
    return (prefix ? prefix + '-' : '') + Date.now().toString(36) + '-' + uidCounter.toString(36);
  };

  U.escapeHtml = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** Accent/case-insensitive normal form for searching: "Víctor  Larco" -> "victor larco". */
  U.normalize = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .normalize('NFD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/[^a-z0-9ñ&+]+/g, ' ').trim().replace(/\s+/g, ' ');
  };
  /** URL/id-safe slug: "Plaza Vea Angamos" -> "plaza-vea-angamos". */
  U.slug = function (s) {
    return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  };

  /** Spanish-aware, accent-insensitive, numeric collation (used for every alphabetical sort). */
  U.collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  U.compare = function (a, b) { return U.collator.compare(String(a || ''), String(b || '')); };
  /** Stable sort by key function (returns a new array). */
  U.sortBy = function (arr, key) {
    return arr.map(function (v, i) { return [key(v), i, v]; })
      .sort(function (a, b) {
        var c = typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : U.compare(a[0], b[0]);
        return c || a[1] - b[1];
      })
      .map(function (x) { return x[2]; });
  };

  U.clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  U.round = function (v, digits) { var f = Math.pow(10, digits || 0); return Math.round(v * f) / f; };
  U.clone = function (o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); };
  U.isEqual = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  U.todayISO = function () {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  /** Relative luminance of a #rrggbb colour (0..1) — pick readable text on brand colours. */
  U.luminance = function (hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 0.5;
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  U.isHexColor = function (s) { return /^#[0-9a-f]{6}$/i.test(String(s || '')); };

  /* ------------------------------------------------------------------------------------------
   * Lazy script loading (classic <script> injection works from file://).
   * ---------------------------------------------------------------------------------------- */
  var scriptPromises = {};
  MT.loadScript = function (src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete scriptPromises[src]; reject(new Error('No se pudo cargar ' + src)); };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  };

  /** Heavy vendor libraries loaded on first use (keeps startup fast). */
  MT.vendor = {
    xlsx: function () {
      if (window.XLSX) return Promise.resolve(window.XLSX);
      return MT.loadScript('vendor/xlsx/xlsx.full.min.js').then(function () { return window.XLSX; });
    },
    pptx: function () {
      if (window.PptxGenJS) return Promise.resolve(window.PptxGenJS);
      return MT.loadScript('vendor/pptxgenjs/pptxgen.bundle.js').then(function () { return window.PptxGenJS; });
    },
  };
})();
