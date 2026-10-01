/* js/i18n.js — MT.i18n / MT.t: Spanish & English UI strings.
 *
 * Every user-visible string goes through MT.t(key, vars). Dictionaries are added per module:
 *   MT.i18n.add('es', { 'maps.addMap': 'Agregar mapa', ... });   // flat or nested objects
 * Values may contain {placeholders} and may be plural objects selected by vars.n / vars.count:
 *   'db.rows': { one: '{n} tienda', other: '{n} tiendas' }
 * Static markup is translated by MT.i18n.applyDom(root) through attributes:
 *   data-i18n="key"  (textContent)   data-i18n-title="key"   data-i18n-placeholder="key"
 *   data-i18n-aria="key" (aria-label)   data-i18n-vars='{"n":3}' (vars for any of the above)
 * Language: ?lang= URL parameter > saved preference > browser language (es* → es, else en).
 * setLang() persists it, re-applies the DOM and emits 'lang:changed' {lang}.
 */
(function () {
  'use strict';
  var MT = window.MT;
  var LANGS = ['es', 'en'];
  var dicts = { es: {}, en: {} };
  var missing = {};
  var PREF_KEY = 'mt.lang';

  function flatten(obj, prefix, out) {
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k], key = prefix ? prefix + '.' + k : k;
      // Plural objects ({one, other, [zero]}) are leaves, not namespaces.
      if (v && typeof v === 'object' && !isPlural(v)) flatten(v, key, out);
      else out[key] = v;
    }
    return out;
  }
  var PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];
  function isPlural(v) {
    return !!v && typeof v === 'object' && typeof v.other === 'string' &&
      Object.keys(v).every(function (k) { return PLURAL_KEYS.indexOf(k) >= 0; });
  }

  function initialLang() {
    try {
      var p = new URLSearchParams(location.search).get('lang');
      if (p && LANGS.indexOf(p) >= 0) { localStorage.setItem(PREF_KEY, p); return p; }
    } catch (e) { /* ignore */ }
    try {
      var saved = localStorage.getItem(PREF_KEY);
      if (saved && LANGS.indexOf(saved) >= 0) return saved;
    } catch (e) { /* storage blocked */ }
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'es';
    return /^es\b/i.test(nav) ? 'es' : 'en';
  }

  var i18n = (MT.i18n = {
    langs: LANGS.slice(),
    lang: initialLang(),

    /** Merge a dictionary (flat keys or nested objects) into a language. */
    add: function (lang, dict) {
      if (!dicts[lang]) dicts[lang] = {};
      flatten(dict, '', dicts[lang]);
    },

    has: function (key, lang) { return Object.prototype.hasOwnProperty.call(dicts[lang || i18n.lang] || {}, key); },

    /** Translate `key` with {vars}. Falls back to the other language, then to the key itself. */
    t: function (key, vars) {
      var v = lookup(key, i18n.lang);
      if (v === undefined) {
        for (var i = 0; i < LANGS.length && v === undefined; i++) v = lookup(key, LANGS[i]);
        if (!missing[key]) { missing[key] = true; console.warn('[i18n] missing key "' + key + '" for ' + i18n.lang); }
        if (v === undefined) return key;
      }
      if (isPlural(v)) {
        var n = vars && (vars.n !== undefined ? vars.n : vars.count);
        var cat = n === 0 && v.zero !== undefined ? 'zero' : pluralRules().select(+n || 0);
        v = v[cat] !== undefined ? v[cat] : v.other;
      }
      return interpolate(String(v), vars);
    },

    /**
     * Texts of MapLibre's own controls in the UI language, for the `locale` option of every
     * maplibregl.Map (zoom buttons, attribution toggle, the map's and markers' aria labels...).
     * Without it they stay in English inside the Spanish UI and the exported HTML.
     */
    mapLocale: function () {
      var out = {};
      Object.keys(MAP_LOCALE).forEach(function (k) { if (i18n.has('map.locale.' + MAP_LOCALE[k])) out[k] = i18n.t('map.locale.' + MAP_LOCALE[k]); });
      return out;
    },

    /** A key in a given language (no fallback, no warning): '' when that language lacks it. */
    tIn: function (lang, key, vars) {
      var v = lookup(key, lang);
      if (v === undefined) return '';
      if (isPlural(v)) v = v.other;
      return interpolate(String(v), vars);
    },

    /** Keys requested but not found (for tests / translators). */
    missingKeys: function () { return Object.keys(missing); },
    /** All keys of a language (for coverage checks). */
    keys: function (lang) { return Object.keys(dicts[lang || i18n.lang] || {}); },

    setLang: function (lang) {
      if (LANGS.indexOf(lang) < 0 || lang === i18n.lang) return;
      i18n.lang = lang;
      try { localStorage.setItem(PREF_KEY, lang); } catch (e) { /* ignore */ }
      document.documentElement.lang = lang;
      i18n.applyDom(document);
      MT.bus.emit('lang:changed', { lang: lang });
    },

    /** Translate elements carrying data-i18n* attributes inside `root` (root included). */
    applyDom: function (root) {
      root = root || document;
      var nodes = [];
      if (root.nodeType === 1 && hasI18nAttr(root)) nodes.push(root);
      Array.prototype.push.apply(nodes, (root.querySelectorAll ? root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria]') : []));
      nodes.forEach(function (el) {
        var vars;
        if (el.dataset.i18nVars) { try { vars = JSON.parse(el.dataset.i18nVars); } catch (e) { vars = undefined; } }
        if (el.dataset.i18n) el.textContent = i18n.t(el.dataset.i18n, vars);
        if (el.dataset.i18nTitle) el.title = i18n.t(el.dataset.i18nTitle, vars);
        if (el.dataset.i18nPlaceholder) el.placeholder = i18n.t(el.dataset.i18nPlaceholder, vars);
        if (el.dataset.i18nAria) el.setAttribute('aria-label', i18n.t(el.dataset.i18nAria, vars));
      });
      return root;
    },

    /** BCP-47 locale for Intl formatting. */
    locale: function () { return i18n.lang === 'es' ? 'es-PE' : 'en-US'; },
    formatNumber: function (n, opts) { return new Intl.NumberFormat(i18n.locale(), opts).format(n); },
    formatDate: function (d, opts) {
      var date = d instanceof Date ? d : new Date(d);
      return new Intl.DateTimeFormat(i18n.locale(), opts || { dateStyle: 'medium' }).format(date);
    },
    /** "350 m" / "1,2 km" in the current language. */
    formatDistance: function (meters) {
      if (meters < 1000) return i18n.formatNumber(Math.round(meters)) + ' m';
      return i18n.formatNumber(meters / 1000, { maximumFractionDigits: meters < 10000 ? 1 : 0 }) + ' km';
    },
  });

  // MapLibre locale key -> our key under map.locale.* (js/i18n/map.js).
  var MAP_LOCALE = {
    'NavigationControl.ZoomIn': 'zoomIn', 'NavigationControl.ZoomOut': 'zoomOut', 'NavigationControl.ResetBearing': 'resetBearing',
    'AttributionControl.ToggleAttribution': 'toggleAttribution', 'AttributionControl.MapFeedback': 'mapFeedback',
    'FullscreenControl.Enter': 'fullscreenEnter', 'FullscreenControl.Exit': 'fullscreenExit',
    'Map.Title': 'mapTitle', 'Marker.Title': 'markerTitle', 'Popup.Close': 'popupClose',
    'CooperativeGesturesHandler.WindowsHelpText': 'coopWindows', 'CooperativeGesturesHandler.MacHelpText': 'coopMac',
    'CooperativeGesturesHandler.MobileHelpText': 'coopMobile',
  };
  function hasI18nAttr(el) { var d = el.dataset; return !!(d && (d.i18n || d.i18nTitle || d.i18nPlaceholder || d.i18nAria)); }
  function lookup(key, lang) { var d = dicts[lang]; return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined; }
  function interpolate(s, vars) {
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m; });
  }
  var rulesCache = {};
  function pluralRules() {
    var loc = i18n.locale();
    return rulesCache[loc] || (rulesCache[loc] = new Intl.PluralRules(loc));
  }

  /** Shorthand used everywhere. */
  MT.t = function (key, vars) { return i18n.t(key, vars); };
  document.documentElement.lang = i18n.lang;
})();
