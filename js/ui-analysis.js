/* js/ui-analysis.js — the "Análisis" tab (SPEC §6.1, docs/ARCHITECTURE.md §8).
 *
 * Two modes over the engine MT.analysis (js/analysis.js — straight-line haversine distances):
 *  A. "Distancias a un punto": a reference (a store from a type-ahead, a point clicked on the map,
 *     pasted coordinates / a Google Maps link, or an address found with Nominatim on Enter), a
 *     universe (max distance 1–20 km / all of Peru, or selected districts; chains; "por verificar"),
 *     editable rings → summary cards, ring × chain table, full sortable table (virtualized), a
 *     MapLibre map (reference pin, labelled rings, chain-coloured dots, badges + distances for the
 *     nearest N, lines to the nearest store of each chain), Excel export (Resumen, Distancias,
 *     Por cadena y anillo, Parámetros) and "Agregar como lámina" (a slide carrying the analysis,
 *     SPEC §6.3) — or, when opened from a slide, "Actualizar la lámina".
 *  B. "Matriz de cercanía": region districts + chains + radius R + pair threshold → per-store
 *     nearest same-chain store / nearest competitor / counts within R, close pairs (same chain first,
 *     "posible canibalización"), map with red lines for same-chain pairs (grey for competitor pairs),
 *     Excel export (Por tienda, Pares cercanos, Parámetros). Big regions are computed in idle chunks.
 *
 * Tab {id:'analysis', labelKey:'tab.analysis', icon:'target', order:15, hash:'analisis'} (Alt+2).
 * Strings 'analysis.*' (js/i18n/analysis.js) · styles .mt-analysis-* (css/analysis.css).
 *
 * MT.analysisui (tests, other modules — e.g. the Mapas inspector's "Editar en Análisis"):
 *   edit(mapId | mapCfg) → bool        load a slide's analysis into mode A (and link it: "Actualizar la lámina");
 *   open(…) = edit(…)                  (the name the Mapas inspector's "Editar en Análisis" calls)
 *   setMode('distance'|'matrix') · mode()
 *   setReference(x) → ref|null         x = store id | {lat, lng, label?, chainId?} | a reference
 *   setUniverse({meters} | {all:true} | {districts:[…]}) · setChains(ids) · setRings(meters[])
 *   setOptions({includeToVerify, showLines, listTop})
 *   setMatrix({districts, chains, radius, threshold, showCompetitors, neighbors, includeToVerify})
 *   results() → {mode:'distance', ref, res, ringSummary} | {mode:'matrix', rows, pairs, region}
 *   select(storeId) · selectPair(i) · setPicking(on) · searchAddress(q) → Promise
 *   exportXlsx() → Promise<file name|null> · addAsSlide() → map|null · updateSlide() → map|null
 *   whenIdle() → Promise (mode B computation finished) · state() → plain summary of the tab · map() → the MapLibre map
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util, h = U.h;
  const t = (k, v) => MT.t(k, v);
  const AN = () => MT.analysis;
  const icon = (name, size) => MT.ui.icon(name, { size: size || 18 });
  const iconSpan = (name, size, cls) => h('span', { class: 'mt-icon' + (cls ? ' ' + cls : ''), html: icon(name, size) });

  /* =========================================================================================
   * Constants & state
   * ======================================================================================= */
  const UNIVERSE_KM = [1, 2, 3, 5, 10, 20];
  const DEFAULT_RINGS = [500, 1000, 2000, 3000, 5000];          // SPEC §6.1 (= MT.analysis.DEFAULT_RINGS)
  const RING_MIN = 10, RING_MAX = 1000000, MAX_RINGS = 8, TOP_MAX = 30;
  const NEAR_PRESETS = [250, 500, 1000, 2000];                   // mode B radius / pair threshold chips
  // Mode B close pairs: the threshold stays ≤ 5 km (Lima province with every chain and competitor
  // pairs: ≈ 335,000 pairs at 5 km), and the list / map lines / Excel keep the first 50,000 pairs
  // (same chain first, then the nearest) — the counts always cover every pair. Measured (headless,
  // Lima province, every chain, competitor pairs on): 1 km = 21,391 pairs, all listed; 5 km = 334,816
  // pairs, 50,000 listed — < 1 s to compute and draw, longest main-thread block ≈ 0.3 s, Excel 2.4 s.
  const PAIR_MAX = 5000, PAIR_LIST_MAX = 50000;
  const RECENT_MAX = 6, RECENT_KEY = 'mt.analysis.recent';
  const CHUNK = 500;                                             // mode B: stores per idle chunk
  const BADGE = { kind: 'badge', size: 1 };
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const COLOR_SAME = '#D92D3A', COLOR_COMP = '#8B8F98';
  // Lima Metropolitana zones (APEIM grouping) + Callao — the same presets as the Mapas district picker.
  const LIMA_ZONES = [
    { id: 'moderna', ubigeos: ['150104', '150113', '150114', '150116', '150120', '150121', '150122', '150130', '150131', '150136', '150140', '150141'] },
    { id: 'centro', ubigeos: ['150101', '150105', '150115', '150128', '150134'] },
    { id: 'norte', ubigeos: ['150102', '150106', '150110', '150112', '150117', '150125', '150135', '150139'] },
    { id: 'este', ubigeos: ['150103', '150107', '150109', '150111', '150118', '150132', '150137'] },
    { id: 'sur', ubigeos: ['150108', '150119', '150123', '150133', '150142', '150143'] },
    { id: 'balnearios', ubigeos: ['150124', '150126', '150127', '150129', '150138'] },
    { id: 'callao', ubigeos: ['070101', '070102', '070103', '070104', '070105', '070106', '070107'] },
  ];

  // UI settings remembered between sessions (pref 'analysis.settings'); references only per session.
  const saved = Object.assign({}, MT.storage.pref('analysis.settings', {}) || {});
  const numOr = (v, def, min, max) => { const n = +v; return v !== null && v !== undefined && v !== '' && isFinite(n) ? U.clamp(Math.round(n), min, max) : def; };
  const boolOr = (v, def) => (typeof v === 'boolean' ? v : def);
  function cleanRings(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((x) => { const m = Math.round(+x); if (isFinite(m) && m >= RING_MIN && m <= RING_MAX && out.indexOf(m) < 0) out.push(m); });
    return out.sort((a, b) => a - b).slice(0, MAX_RINGS);
  }

  const st = {
    mounted: false, els: {}, side: {},
    mode: saved.mode === 'matrix' ? 'matrix' : 'distance',
    map: null, mapReady: false, mapFailed: false, badges: new Set(), pendingFit: false,
    popup: null, tip: null, picking: false, linked: null, recent: loadRecent(),
    a: {
      ref: null,
      uniKind: saved.uniKind === 'all' || saved.uniKind === 'districts' ? saved.uniKind : 'distance',
      uniMeters: numOr(saved.uniMeters, 5000, 100, RING_MAX),
      lastDist: saved.uniKind === 'all' ? 'all' : 'distance',
      districts: Array.isArray(saved.uniDistricts) ? saved.uniDistricts.filter((u) => typeof u === 'string') : [],
      chains: null, chainsTouched: false,
      includeToVerify: boolOr(saved.includeToVerify, true),
      rings: cleanRings(saved.rings).length ? cleanRings(saved.rings) : DEFAULT_RINGS.slice(),
      showLines: boolOr(saved.showLines, true),
      listTop: numOr(saved.listTop, 8, 0, TOP_MAX),
      res: null, ringSum: null, counts: {}, byId: null, near: null,
      view: 'stores', filter: '', selected: null,
      address: null,                     // {q, state:'busy'|'done'|'error', list, msg}
      table: null, ui: null,
    },
    b: {
      districts: Array.isArray(saved.bDistricts) ? saved.bDistricts.filter((u) => typeof u === 'string') : [],
      chains: null,
      radius: numOr(saved.bRadius, 1000, 10, RING_MAX),
      threshold: numOr(saved.bThreshold, 1000, 10, PAIR_MAX),
      showComp: boolOr(saved.bShowComp, false),
      neighbors: boolOr(saved.bNeighbors, true),
      includeToVerify: boolOr(saved.bToVerify, true),
      rows: null, pairs: null, pairCounts: null, byId: null, region: null, inRegion: null, extra: null, counts: {},
      computing: false, progress: 0, gen: 0, ms: 0,
      view: 'stores', filter: '', selected: null, selectedPair: null,
      table: null, pairTable: null, ui: null,
    },
  };

  function saveSettings() {
    const a = st.a, b = st.b;
    MT.storage.setPref('analysis.settings', {
      mode: st.mode, uniKind: a.uniKind, uniMeters: a.uniMeters, uniDistricts: a.districts, includeToVerify: a.includeToVerify,
      rings: a.rings, showLines: a.showLines, listTop: a.listTop,
      bDistricts: b.districts, bRadius: b.radius, bThreshold: b.threshold, bShowComp: b.showComp, bNeighbors: b.neighbors, bToVerify: b.includeToVerify,
    });
  }

  /* =========================================================================================
   * Small helpers
   * ======================================================================================= */
  const fmtNum = (n) => MT.i18n.formatNumber(n);
  /**
   * "850 m", "1.2 km", "12 km", "1,954 km" — a measured distance: MT.i18n.formatDistance, the one
   * distance text of the app (Mapas, the slides, the exports, this tab and its Excel), the es-PE
   * decimal point in both languages, like "Peso: 15.8%".
   */
  function fmtDist(m) { return MT.i18n.formatDistance(m); }
  /** "500 m", "1.25 km" — a distance the user typed (ring, universe, R, pair threshold): its exact value. */
  function fmtRing(m) { return MT.i18n.formatDistanceExact(m); }
  /** "3 km y 5 km" / "3 km and 5 km" in the UI language. */
  function listText(items) {
    try { return new Intl.ListFormat(MT.i18n.locale(), { style: 'long', type: 'conjunction' }).format(items); } catch (e) { return items.join(', '); }
  }
  /**
   * A label whose distances ("500 m", "1.5 km") must keep their case under a CSS upper-case header
   * ("HASTA 500 m", not "500 M" — which a Peruvian reader takes for 500 mil): spans .mt-unit.
   */
  function unitText(text) {
    const parts = String(text).split(/(\d[\d.,]*\s?(?:km|m)(?![a-záéíóúñ]))/i);
    if (parts.length === 1) return String(text);
    return h('span', null, parts.map((x, i) => (i % 2 ? h('span', { class: 'mt-unit' }, x) : x)).filter((x) => x !== ''));
  }
  /** A pasted web link (a Google Maps link, a short link…) — never an address to geocode. */
  function looksLikeLink(q) { return /^\s*(https?:\/\/|www\.)|maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps/i.test(String(q || '')); }
  /** "Plaza Vea Angamos" from a full Google Maps link's "/place/Plaza+Vea+Angamos/" segment, or ''. */
  function placeName(q) {
    const m = /\/place\/([^/@?#]+)/.exec(String(q || ''));
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim().slice(0, 80); } catch (e) { return ''; }
  }
  /** "1,234.5 m" — exact metres for tooltips (locale number format). */
  function fmtMeters(m) { return MT.i18n.formatNumber(Math.round(m * 10) / 10, { maximumFractionDigits: 1 }) + ' m'; }
  const round1 = (m) => Math.round(m * 10) / 10;
  const chainName = (id) => MT.data.chain(id).name;
  const dirShort = (code) => (code ? t('analysis.dir.' + code) : '—');
  const dirLong = (code) => (code ? t('analysis.dirName.' + code) : '');
  function logo(chainId, px, cls) { return MT.dbui.logoImg(chainId, px, 'mt-analysis-logo' + (cls ? ' ' + cls : '')); }
  function note(name, text, tone) {
    return h('div', { class: 'mt-analysis-note' + (tone ? ' mt-analysis-note--' + tone : '') }, iconSpan(name, 15), h('span', null, text));
  }
  function linkBtn(label, onClick, title) {
    return h('button', { type: 'button', class: 'mt-analysis-link', title: title || null, onclick: onClick }, label);
  }
  function field(label, control, hint) {
    if (control && !control.id && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) control.id = U.uid('mt-an-f');
    return h('div', { class: 'mt-field mt-analysis-field' },
      label ? h(control && control.id ? 'label' : 'div', { class: 'mt-label', for: control && control.id ? control.id : null }, label) : null,
      control, hint ? h('div', { class: 'mt-hint' }, hint) : null);
  }
  function announce(text) {
    const live = st.els.live;
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
  }
  function chainOrder() { const o = {}; MT.data.chains().forEach((c, i) => { o[c.id] = i; }); return o; }
  function sortedChainIds(set) { const o = chainOrder(); return Array.from(set || []).sort((x, y) => (x in o ? o[x] : 999) - (y in o ? o[y] : 999) || (x < y ? -1 : 1)); }
  function storeSub(s) { return [chainName(s.chain), s.district].filter(Boolean).join(' · '); }
  /**
   * Parse "1500", "1.5 km", "1,5km", "800 m", "1,500" → metres (NaN when junk). A comma followed by
   * groups of exactly three digits (no "km") is a thousands separator ("1,500" = 1500 m, es-PE);
   * any other comma is a decimal comma ("1,5 km").
   */
  function parseDistance(text) {
    let s = String(text || '').trim().toLowerCase();
    if (/^\d{1,3}(,\d{3})+\s*m?$/.test(s)) s = s.replace(/,/g, '');
    const m = s.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(km|m)?$/);
    if (!m) return NaN;
    return Math.round(+m[1] * (m[2] === 'km' ? 1000 : 1));
  }
  function percent(n, d) { return d ? Math.round(n / d * 100) : 0; }
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 60 }) : setTimeout(r, 0)));

  /* ---- References ------------------------------------------------------------------------ */
  function refName(r) {
    if (!r) return '';
    if (r.label) return r.label;
    return t('analysis.ref.unnamedPoint', { coords: AN().formatCoords(r.lat, r.lng) });
  }
  function refKey(r) { return r.type === 'store' ? 's:' + r.storeId : 'p:' + r.lat + ',' + r.lng; }
  /** The reference as saved on a slide / in the recent list (SPEC §6.3 ref shape). */
  function savedRef(r) {
    const o = { type: r.type };
    if (r.type === 'store') o.storeId = r.storeId;
    if (r.chainId) o.chainId = r.chainId;
    o.lat = r.lat; o.lng = r.lng;
    if (r.label) o.label = r.label;
    return o;
  }
  function loadRecent() {
    try {
      const list = JSON.parse(window.sessionStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter((x) => x && (x.type === 'store' || x.type === 'point')).slice(0, RECENT_MAX) : [];
    } catch (e) { return []; }
  }
  function pushRecent(r) {
    const key = refKey(r);
    st.recent = [savedRef(r)].concat(st.recent.filter((x) => refKey(x) !== key)).slice(0, RECENT_MAX);
    try { window.sessionStorage.setItem(RECENT_KEY, JSON.stringify(st.recent)); } catch (e) { /* private mode: session list only */ }
  }

  /* ---- Store search (reference type-ahead): accent-insensitive over name / chain / district ---- */
  let searchIdx = null;
  function storeIndex() {
    if (searchIdx) return searchIdx;
    searchIdx = MT.data.stores().filter((s) => isFinite(s.lat) && isFinite(s.lng)).map((s) => {
      const c = MT.data.chain(s.chain);
      return { s: s, name: U.normalize(s.name), hay: ' ' + U.normalize([s.name, c.name, c.legendName, s.district, s.province].join(' ')) };
    });
    return searchIdx;
  }
  function searchStores(q, limit) {
    const qn = U.normalize(q);
    if (!qn) return [];
    const words = qn.split(' ');
    const hits = [];
    storeIndex().forEach((x) => {
      for (let i = 0; i < words.length; i++) if (x.hay.indexOf(words[i]) < 0) return;
      const score = x.name.indexOf(qn) === 0 ? 0 : x.name.indexOf(qn) >= 0 ? 1 : words.every((w) => x.hay.indexOf(' ' + w) >= 0) ? 2 : 3;
      hits.push({ x: x, score: score });
    });
    hits.sort((a, b) => a.score - b.score || U.compare(a.x.s.name, b.x.s.name) || (a.x.s.id < b.x.s.id ? -1 : 1));
    return hits.slice(0, limit).map((o) => o.x.s);
  }

  /* =========================================================================================
   * Reusable widgets
   * ======================================================================================= */
  /**
   * Inline combobox (results list under an input; ↑/↓, Enter, Esc). cfg: {options(q) → [{…, disabled}],
   * render(option) → <li>, onPick(option), onEnterEmpty(q), onRefresh(options, q, open)}.
   */
  function combobox(input, list, cfg) {
    let opts = [], active = -1;
    const enabled = (i) => opts[i] && !opts[i].disabled;
    function setActive(i) {
      active = i;
      U.$$('[role="option"]', list).forEach((li, k) => { li.classList.toggle('is-active', k === i); li.setAttribute('aria-selected', String(k === i)); });
      const li = list.children[i];
      if (li && i >= 0) { input.setAttribute('aria-activedescendant', li.id); if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function refresh() {
      const q = input.value;
      opts = q.trim() ? (cfg.options(q) || []) : [];
      U.clear(list);
      opts.forEach((o, i) => {
        const li = cfg.render(o, i);
        li.id = list.id + '-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        if (o.disabled) li.setAttribute('aria-disabled', 'true');
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => pick(i));
        list.appendChild(li);
      });
      list.hidden = !opts.length;
      input.setAttribute('aria-expanded', String(!!opts.length));
      let first = -1;
      for (let k = 0; k < opts.length; k++) if (enabled(k)) { first = k; break; }
      setActive(first);
      if (cfg.onRefresh) cfg.onRefresh(opts, q, !!q.trim());
    }
    function move(d) {
      if (!opts.length) return;
      let i = active;
      for (let k = 0; k < opts.length; k++) { i = (i + d + opts.length) % opts.length; if (enabled(i)) break; }
      setActive(i);
    }
    function pick(i) { if (enabled(i)) cfg.onPick(opts[i]); }
    function close() {
      opts = [];
      list.hidden = true;
      U.clear(list);
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      if (cfg.onRefresh) cfg.onRefresh([], input.value, false);
    }
    input.addEventListener('input', refresh);
    input.addEventListener('focus', () => { if (input.value.trim()) refresh(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) refresh(); else move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && active >= 0) pick(active);
        else if (cfg.onEnterEmpty && input.value.trim()) cfg.onEnterEmpty(input.value.trim());
      } else if (e.key === 'Escape') {
        if (!list.hidden || input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; close(); }
      }
    });
    return { refresh: refresh, close: close, isOpen: () => !list.hidden };
  }

  /**
   * District picker: combobox over MT.data.districts.search (+ "Toda la provincia de X"), "Zonas de
   * Lima" presets, chips with ×. cfg: {get() → ubigeos, set(ubigeos)}.
   */
  function districtPicker(cfg) {
    const D = MT.data.districts;
    const wrap = h('div', { class: 'mt-analysis-districts' });
    if (!D.available) { wrap.appendChild(note('warning', t('analysis.districts.unavailable'), 'warn')); return { el: wrap, update() {}, focus() {} }; }
    const listId = U.uid('mt-an-dres');
    const input = h('input', { class: 'mt-input mt-input--sm', type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': listId, 'aria-label': t('analysis.districts.searchLabel'), placeholder: t('analysis.districts.searchPh'), autocomplete: 'off', spellcheck: 'false' });
    const results = h('ul', { class: 'mt-analysis-options', id: listId, role: 'listbox', 'aria-label': t('analysis.districts.resultsAria'), hidden: true });
    const noRes = h('div', { class: 'mt-analysis-options__empty', hidden: true });
    const zones = LIMA_ZONES.map((z) => ({ id: z.id, ubigeos: z.ubigeos.filter((u) => D.get(u)) })).filter((z) => z.ubigeos.length);
    const presets = zones.length ? h('button', { type: 'button', class: 'mt-btn mt-btn--secondary mt-btn--sm', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => MT.ui.menu(e.currentTarget, zones.map((z) => ({ label: t('maps.districts.preset.' + z.id), hint: t('data.districts', { n: z.ubigeos.length }), icon: 'pin', onClick: () => addMany(z.ubigeos) })), { minWidth: 230 }) },
    iconSpan('layers', 15), h('span', null, t('analysis.districts.presets')), iconSpan('chevronDown', 14)) : null;
    const removeAll = linkBtn(t('analysis.districts.removeAll'), () => { cfg.set([]); input.focus(); });
    const chips = h('div', { class: 'mt-chips mt-analysis-chips', role: 'list' });
    U.append(wrap, [
      h('div', { class: 'mt-analysis-combo' }, h('div', { class: 'mt-input-group' }, iconSpan('search', 15), input), results, noRes),
      h('div', { class: 'mt-analysis-row' }, presets, h('span', { class: 'mt-spacer' }), removeAll),
      chips,
    ]);
    const combo = combobox(input, results, {
      options(q) {
        const have = new Set(cfg.get());
        const out = D.search(q, { limit: 8 }).map((d) => ({ kind: 'd', d: d, disabled: have.has(d.ubigeo) }));
        if (U.normalize(q).length >= 3) D.searchProvinces(q, { limit: 2 }).forEach((p) => { if (p.ubigeos.length > 1) out.push({ kind: 'p', p: p }); });
        return out;
      },
      render(o) {
        if (o.kind === 'p') {
          return h('li', { class: 'mt-analysis-opt' }, iconSpan('layers', 16, 'mt-analysis-opt__icon'),
            h('span', { class: 'mt-analysis-opt__main' }, h('span', { class: 'mt-analysis-opt__name' }, t('analysis.districts.province', { province: o.p.province })),
              h('span', { class: 'mt-analysis-opt__sub' }, t('analysis.districts.provinceSub', { department: o.p.department, n: o.p.ubigeos.length }))));
        }
        return h('li', { class: 'mt-analysis-opt' + (o.disabled ? ' is-added' : ''), dataset: { ubigeo: o.d.ubigeo } },
          iconSpan(o.disabled ? 'check' : 'pin', 16, 'mt-analysis-opt__icon'),
          h('span', { class: 'mt-analysis-opt__main' }, h('span', { class: 'mt-analysis-opt__name' }, o.d.district),
            h('span', { class: 'mt-analysis-opt__sub' }, o.d.province + ', ' + o.d.department)),
          o.disabled ? h('span', { class: 'mt-analysis-opt__aside' }, t('analysis.districts.already')) : null);
      },
      onPick(o) {
        if (o.kind === 'p') addMany(o.p.ubigeos);
        else if (cfg.get().indexOf(o.d.ubigeo) < 0) cfg.set(cfg.get().concat(o.d.ubigeo));
        input.value = '';
        combo.close();
        input.focus();
      },
      onRefresh(opts, q, open) {
        noRes.hidden = !(open && q.trim() && !opts.length);
        noRes.textContent = t('analysis.districts.noResults', { q: q.trim() });
      },
    });
    function addMany(list) {
      const have = new Set(cfg.get());
      const add = list.filter((u) => !have.has(u) && D.get(u));
      if (!add.length) { MT.ui.toast(t('analysis.districts.nothingNew'), { type: 'info' }); return; }
      cfg.set(cfg.get().concat(add));
      announce(t('analysis.districts.added', { n: add.length }));
    }
    function update() {
      const ds = cfg.get();
      removeAll.hidden = ds.length < 2;
      U.clear(chips);
      ds.forEach((u) => {
        const d = D.get(u), name = d ? d.district : u;
        chips.appendChild(h('span', { class: 'mt-chip mt-analysis-dchip', role: 'listitem', title: d ? d.label : u, dataset: { ubigeo: u } },
          h('span', { class: 'mt-chip__label' }, name),
          h('button', { type: 'button', class: 'mt-chip__x', 'aria-label': t('analysis.districts.remove', { name: name }), title: t('analysis.districts.remove', { name: name }),
            html: icon('close', 14), onclick: () => removeOne(u) })));
      });
      if (combo.isOpen()) combo.refresh();
    }
    function removeOne(u) {
      const ds = cfg.get(), i = ds.indexOf(u);
      const hadFocus = chips.contains(document.activeElement);
      cfg.set(ds.filter((x) => x !== u));
      if (hadFocus && !chips.contains(document.activeElement)) { const xs = U.$$('.mt-chip__x', chips); (xs[Math.min(i, xs.length - 1)] || input).focus(); }
    }
    update();
    return { el: wrap, update: update, focus: () => input.focus(), addMany: addMany };
  }

  /**
   * Chains field: a button "13 de 16 cadenas ▾" + the selected chains' logos; the button opens a
   * popover with the chains grouped (Todas / Ninguna per group and global, Predeterminadas) and the
   * number of stores of each chain in the current universe. cfg: {get() → Set, set(Set),
   * counts() → {id: n}, defaults() → ids}.
   */
  function chainField(cfg) {
    const btn = h('button', { type: 'button', class: 'mt-analysis-chainbtn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => open() });
    const logos = h('div', { class: 'mt-analysis-chainlogos', 'aria-hidden': 'true' });
    const wrap = h('div', { class: 'mt-field mt-analysis-field' }, h('div', { class: 'mt-label' }, t('analysis.universe.chains')), btn, logos);
    let pop = null, boxes = null;
    function render() {
      const sel = cfg.get(), all = MT.data.chains();
      U.clear(btn);
      btn.append(iconSpan('store', 15), h('span', { class: 'mt-analysis-chainbtn__label' }, t('analysis.universe.chainsBtn', { n: all.filter((c) => sel.has(c.id)).length, total: all.length })), iconSpan('chevronDown', 14));
      U.clear(logos);
      sortedChainIds(sel).forEach((id) => logos.appendChild(logo(id, 20)));
      if (boxes) syncBoxes();
    }
    function syncBoxes() {
      const sel = cfg.get();
      boxes.chains.forEach((b) => { b.input.checked = sel.has(b.id); });
      boxes.groups.forEach((g) => { const on = g.ids.filter((id) => sel.has(id)).length; g.input.checked = on === g.ids.length; g.input.indeterminate = on > 0 && on < g.ids.length; });
    }
    function setIds(ids, on) {
      const sel = new Set(cfg.get());
      ids.forEach((id) => { if (on) sel.add(id); else sel.delete(id); });
      cfg.set(sel);
    }
    function open() {
      const counts = cfg.counts() || {};
      boxes = { chains: [], groups: [] };
      const body = h('div', { class: 'mt-db-pop__body' });
      MT.dbui.chainsByGroup().forEach((g) => {
        const ids = g.chains.map((c) => c.id);
        const gbox = h('input', { type: 'checkbox' });
        gbox.addEventListener('change', () => setIds(ids, gbox.checked));
        boxes.groups.push({ ids: ids, input: gbox });
        body.appendChild(h('label', { class: 'mt-check mt-db-pop__group', title: t('analysis.universe.chainsGroupAll', { group: t('data.group.' + g.group) }) }, gbox, h('span', null, t('data.group.' + g.group))));
        g.chains.forEach((c) => {
          const box = h('input', { type: 'checkbox', dataset: { chain: c.id } });
          box.addEventListener('change', () => setIds([c.id], box.checked));
          boxes.chains.push({ id: c.id, input: box });
          const n = counts[c.id] || 0;
          body.appendChild(h('label', { class: 'mt-check mt-db-pop__opt' + (n ? '' : ' is-empty'), title: t('analysis.universe.chainsCount', { n: n }) }, box, logo(c.id, 20),
            h('span', { class: 'mt-db-pop__name' }, c.name), h('span', { class: 'mt-db-pop__n' }, fmtNum(n))));
        });
      });
      const head = h('div', { class: 'mt-db-pop__head' }, h('span', { class: 'mt-db-pop__title' }, t('analysis.universe.chainsTitle')),
        h('span', { class: 'mt-analysis-pop__links' },
          h('button', { type: 'button', class: 'mt-db-link', onclick: () => cfg.set(new Set(MT.data.chains().map((c) => c.id))) }, t('analysis.universe.chainsAll')),
          h('button', { type: 'button', class: 'mt-db-link', onclick: () => cfg.set(new Set()) }, t('analysis.universe.chainsNone')),
          h('button', { type: 'button', class: 'mt-db-link', onclick: () => cfg.set(new Set(cfg.defaults())) }, t('analysis.universe.chainsDefault'))));
      syncBoxes();
      pop = MT.dbui.popover(btn, h('div', null, head, body), { label: t('analysis.universe.chainsTitle'), className: 'mt-analysis-pop', onClose: () => { pop = null; boxes = null; } });
    }
    render();
    return { el: wrap, update: render, close: () => { if (pop) pop.close(); } };
  }

  /**
   * Distance chips (+ optional "Todo el Perú" and a custom value box). cfg: {values: [m], extra:
   * [{value, label}], value() → current, onChange(v), custom: bool, ariaLabel}.
   */
  function distChips(cfg) {
    const wrap = h('div', { class: 'mt-analysis-dchips', role: 'group', 'aria-label': cfg.ariaLabel || null });
    function render() {
      const v = cfg.value();
      U.clear(wrap);
      const list = cfg.values.map((m) => ({ value: m, label: fmtRing(m) }));
      if (typeof v === 'number' && cfg.values.indexOf(v) < 0) list.push({ value: v, label: fmtRing(v), custom: true });
      list.sort((x, y) => x.value - y.value);
      (cfg.extra || []).forEach((x) => list.push(x));
      list.forEach((o) => {
        wrap.appendChild(h('button', { type: 'button', class: 'mt-analysis-chip' + (o.custom ? ' is-custom' : ''), 'aria-pressed': String(o.value === v), dataset: { value: String(o.value) },
          onclick: () => { if (o.value !== cfg.value()) cfg.onChange(o.value); } }, o.label));
      });
      if (cfg.custom) {
        const input = h('input', { class: 'mt-input mt-input--sm mt-analysis-chip-input', type: 'text', inputmode: 'decimal', placeholder: t('analysis.matrix.custom'), 'aria-label': t('analysis.matrix.customLabel') });
        const apply = () => {
          const m = parseDistance(input.value), max = cfg.max || RING_MAX;
          if (!(m >= RING_MIN && m <= max)) { input.classList.add('is-invalid'); input.title = cfg.invalidText || t('analysis.rings.invalid'); return; }
          input.classList.remove('is-invalid');
          cfg.onChange(m);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        input.addEventListener('change', () => { if (input.value.trim()) apply(); });
        wrap.appendChild(input);
      }
    }
    render();
    return { el: wrap, update: render };
  }

  /** Results tab strip (role=tablist). items: [{id, label}]. */
  function tabStrip(items, value, onChange) {
    const wrap = h('div', { class: 'mt-analysis-rtabs', role: 'tablist', 'aria-label': t('analysis.results.tabsAria') });
    items.forEach((it) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'mt-analysis-rtab', 'aria-selected': String(it.id === value), tabindex: it.id === value ? '0' : '-1', dataset: { view: it.id },
        onclick: () => onChange(it.id) }, h('span', null, it.label), it.count !== undefined ? h('span', { class: 'mt-analysis-rtab__n' }, fmtNum(it.count)) : null);
      wrap.appendChild(b);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const bs = U.$$('[role="tab"]', wrap), i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = bs[(i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length];
      n.focus(); n.click();
    });
    return wrap;
  }

  /**
   * Virtualized, sortable table (only the visible rows are in the DOM; 3,500 rows stay smooth).
   * cfg: {label, cls, rowHeight, columns:[{id, label, width, num, minWidth, sortKey(row) → value|null
   * (empty values sort last), desc (first click descending), render(row) → node|string, title}],
   * sort:{key, dir}|null (null = the given order), id(row), rowClass(row), onSelect(id, source),
   * onHover(id|null), onActivate(id)}.
   */
  function vtable(cfg) {
    const cols = cfg.columns;
    let rows = [], view = [], sort = cfg.sort ? Object.assign({}, cfg.sort) : null;
    let selected = null, hoverId = null, rowH = cfg.rowHeight || 46, rendered = { first: -1, last: -1 }, visible = [];
    const uid = U.uid('mt-an-row');
    const colgroup = h('colgroup'), thead = h('thead'), tbody = h('tbody');
    const table = h('table', { class: 'mt-table mt-analysis-table' + (cfg.cls ? ' ' + cfg.cls : ''), role: 'grid', 'aria-label': cfg.label }, colgroup, thead, tbody);
    const wrap = h('div', { class: 'mt-analysis-tablewrap', tabindex: '0', 'aria-label': cfg.label }, table);

    function computeVisible(force) {
      const w = wrap.clientWidth || 900;
      const next = cols.filter((c) => !c.minWidth || w >= c.minWidth);
      if (force || next.length !== visible.length) { visible = next; head(); return true; }
      return false;
    }
    function head() {
      U.clear(colgroup); U.clear(thead);
      visible.forEach((c) => colgroup.appendChild(h('col', { style: c.width ? { width: c.width + 'px' } : null })));
      const tr = h('tr');
      visible.forEach((c) => {
        const active = !!(sort && sort.key === c.id);
        const th = h('th', { scope: 'col', class: [c.sortKey ? 'is-sortable' : '', c.num ? 'is-num' : '', c.wrapHead ? 'is-wrap' : '', active ? 'is-sorted' : ''].join(' ').trim() || null,
          tabindex: c.sortKey ? '0' : null, title: c.title || null, dataset: { col: c.id },
          'aria-sort': c.sortKey ? (active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none') : null }, typeof c.label === 'function' ? c.label() : c.label);
        if (c.sortKey) {
          th.addEventListener('click', () => setSort(c.id));
          th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort(c.id); } });
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }
    function doSort() {
      const c = sort && cols.find((x) => x.id === sort.key);
      if (!c || !c.sortKey) { view = rows.slice(); return; }
      const dec = rows.map((r, i) => [c.sortKey(r), i, r]);
      dec.sort((x, y) => {
        const xn = x[0] === null || x[0] === undefined, yn = y[0] === null || y[0] === undefined;
        if (xn || yn) return xn && yn ? x[1] - y[1] : xn ? 1 : -1;      // empty values always last
        const d = typeof x[0] === 'number' && typeof y[0] === 'number' ? x[0] - y[0] : U.compare(x[0], y[0]);
        return d * sort.dir || x[1] - y[1];
      });
      view = dec.map((d) => d[2]);
    }
    function setSort(key) {
      const c = cols.find((x) => x.id === key);
      sort = sort && sort.key === key ? { key: key, dir: -sort.dir } : { key: key, dir: c && c.desc ? -1 : 1 };
      doSort(); head(); render(true);
    }
    function spacer(px) { return h('tr', { class: 'mt-analysis-spacer', 'aria-hidden': 'true' }, h('td', { colspan: visible.length, style: { height: px + 'px' } })); }
    function rowEl(r, i, vis) {
      const id = cfg.id(r);
      const tr = h('tr', { 'data-id': id, id: uid + '-' + i, 'aria-rowindex': String(i + 2), 'aria-selected': String(selected === id),
        class: ((selected === id ? 'is-selected ' : '') + (cfg.rowClass ? cfg.rowClass(r) || '' : '')).trim() || null });
      // render(row, index, visibleColumnIds): a cell may show inline what a hidden column would show.
      visible.forEach((c) => tr.appendChild(h('td', { class: c.num ? 'is-num' : (c.cls || null) }, c.render(r, i, vis))));
      return tr;
    }
    function render(force) {
      if (!visible.length) computeVisible(true);
      const n = view.length, top = wrap.scrollTop, hgt = wrap.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / rowH) - 8);
      const last = Math.min(n, Math.ceil((top + hgt) / rowH) + 8);
      if (!force && first === rendered.first && last === rendered.last) return;
      rendered = { first: first, last: last };
      const frag = document.createDocumentFragment();
      const vis = new Set(visible.map((c) => c.id));
      frag.appendChild(spacer(first * rowH));
      for (let i = first; i < last; i++) frag.appendChild(rowEl(view[i], i, vis));
      frag.appendChild(spacer((n - last) * rowH));
      U.clear(tbody).appendChild(frag);
      table.setAttribute('aria-rowcount', String(n + 1));
      const probe = tbody.querySelector('tr[data-id]');
      if (probe && probe.offsetHeight && Math.abs(probe.offsetHeight - rowH) > 0.5) { rowH = probe.offsetHeight; render(true); }
    }
    function indexOf(id) { for (let i = 0; i < view.length; i++) if (cfg.id(view[i]) === id) return i; return -1; }
    function scrollTo(i, center) {
      const headH = thead.offsetHeight || 36, y = i * rowH;
      if (center) { wrap.scrollTop = Math.max(0, y - wrap.clientHeight / 2 + rowH); return; }
      if (y < wrap.scrollTop) wrap.scrollTop = y;
      else if (y + rowH + headH > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = y + rowH + headH - wrap.clientHeight;
    }
    function select(id, opts) {
      opts = opts || {};
      selected = id;
      const i = id === null ? -1 : indexOf(id);
      if (i >= 0 && opts.scroll !== false) scrollTo(i, opts.center);
      render(true);
      if (i >= 0) wrap.setAttribute('aria-activedescendant', uid + '-' + i); else wrap.removeAttribute('aria-activedescendant');
      if (opts.source && opts.source !== 'api' && cfg.onSelect) cfg.onSelect(id, opts.source);
    }
    wrap.addEventListener('scroll', () => requestAnimationFrame(() => render(false)), { passive: true });
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || e.target.closest('button,a,input')) return;
      select(tr.dataset.id, { source: 'table', scroll: false });
    });
    tbody.addEventListener('mouseover', (e) => {
      const tr = e.target.closest('tr[data-id]'), id = tr ? tr.dataset.id : null;
      if (id !== hoverId) { hoverId = id; if (cfg.onHover) cfg.onHover(id); }
    });
    tbody.addEventListener('mouseleave', () => { if (hoverId !== null) { hoverId = null; if (cfg.onHover) cfg.onHover(null); } });
    wrap.addEventListener('keydown', (e) => {
      if (e.target !== wrap || !view.length) return;
      const i = selected === null ? -1 : indexOf(selected), n = view.length, page = Math.max(1, Math.floor(wrap.clientHeight / rowH) - 1);
      let next = null;
      if (e.key === 'ArrowDown') next = Math.min(n - 1, i + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      else if (e.key === 'PageDown') next = Math.min(n - 1, i + page);
      else if (e.key === 'PageUp') next = Math.max(0, i - page);
      else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); if (cfg.onActivate) cfg.onActivate(selected); return; }
      if (next === null) return;
      e.preventDefault();
      select(cfg.id(view[next]), { source: 'key' });
    });
    if (window.ResizeObserver) new ResizeObserver(U.debounce(() => { if (wrap.isConnected && wrap.clientWidth) { computeVisible(); render(true); } }, 60)).observe(wrap);
    return {
      el: wrap,
      setRows(r, opts) {
        rows = r || [];
        doSort();
        if (!(opts && opts.keepScroll)) wrap.scrollTop = 0;
        rendered = { first: -1, last: -1 };
        computeVisible();
        render(true);
      },
      select: select,
      selected: () => selected,
      rows: () => view.slice(),
      sort: () => (sort ? Object.assign({}, sort) : null),
      setSort: setSort,
      refresh() { computeVisible(true); render(true); },
      focus() { wrap.focus(); },
    };
  }

  /* =========================================================================================
   * Mount & frame
   * ======================================================================================= */
  function mount(panel) {
    const els = st.els;
    st.mounted = true;
    els.panel = panel;
    els.head = h('header', { class: 'mt-analysis-head' });
    els.side = h('aside', { class: 'mt-analysis-side' });
    els.linkBar = h('div', { class: 'mt-analysis-linkbar', hidden: true });
    els.mainHead = h('div', { class: 'mt-analysis-mainhead' });
    els.summary = h('div', { class: 'mt-analysis-summary' });
    els.mapEl = h('div', { class: 'mt-analysis-map' });
    els.mapHint = h('div', { class: 'mt-analysis-maphint', hidden: true, role: 'status' });
    els.mapLegend = h('div', { class: 'mt-analysis-maplegend', hidden: true });
    els.mapPane = h('div', { class: 'mt-analysis-mappane' }, els.mapEl, els.mapHint, els.mapLegend);
    // One results pane per mode (kept while the other mode is shown: table sort and scroll survive).
    els.resA = h('div', { class: 'mt-analysis-respane', dataset: { mode: 'distance' } });
    els.resB = h('div', { class: 'mt-analysis-respane', dataset: { mode: 'matrix' }, hidden: true });
    els.results = h('section', { class: 'mt-analysis-results' }, els.resA, els.resB);
    els.body = h('div', { class: 'mt-analysis-body' }, els.mapPane, els.results);
    els.main = h('div', { class: 'mt-analysis-main' }, els.linkBar, els.mainHead, els.summary, els.body);
    els.live = h('div', { class: 'mt-sr-only', 'aria-live': 'polite' });
    els.root = h('div', { class: 'mt-analysis', dataset: { mode: st.mode } }, els.head, h('div', { class: 'mt-analysis-cols' }, els.side, els.main), els.live);
    panel.appendChild(els.root);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (st.picking) { e.preventDefault(); setPicking(false); return; }
      if (st.popup) {
        e.preventDefault();
        const act = document.activeElement, inCard = !!(act && act.closest && act.closest('.mt-analysis-popup'));
        closePopup();
        // Focus stays where it was (the table, after Enter on a row) — or goes back to the table from the card.
        const tbl = st.mode === 'distance' ? st.a.table : (st.b.view === 'pairs' ? st.b.pairTable : st.b.table);
        if (inCard && tbl) tbl.focus();
      }
    });
    if (!st.a.chains) st.a.chains = new Set(AN().defaultChains(null));
    if (!st.b.chains) st.b.chains = new Set(AN().defaultChains(null));
    renderAll();
    if (st.mode === 'matrix') { st.b.fitPending = true; scheduleB(0); }
    requestAnimationFrame(() => initMap());
  }

  function renderAll() {
    renderHead();
    renderSide();
    st.a.ui = null; st.b.ui = null;                // results panes are rebuilt (new language, new mode)
    renderMain();
  }

  function renderHead() {
    const els = st.els;
    U.clear(els.head);
    const seg = MT.ui.segmented({
      options: [{ value: 'distance', label: t('analysis.mode.distance'), icon: 'target' }, { value: 'matrix', label: t('analysis.mode.matrix'), icon: 'table' }],
      value: st.mode, onChange: (v) => setMode(v), ariaLabel: t('analysis.mode.label'),
    });
    seg.classList.add('mt-analysis-modes');
    const n = MT.data.stores().length;
    els.head.append(
      h('div', { class: 'mt-analysis-head__title' },
        h('h1', { class: 'mt-analysis-head__h' }, t('analysis.title')),
        h('span', { class: 'mt-analysis-head__meta' }, t('analysis.meta', { n: n, num: fmtNum(n) }))),
      seg,
      h('span', { class: 'mt-spacer' }),
      h('span', { class: 'mt-analysis-method', tabindex: '0', title: t('analysis.methodHint'), 'aria-label': t('analysis.methodHint') }, iconSpan('info', 15), h('span', null, t('analysis.method'))));
  }

  function section(titleKey, iconName, nodes, extra) {
    return h('section', { class: 'mt-analysis-sec' },
      h('h2', { class: 'mt-analysis-sec__title' }, iconSpan(iconName, 15), h('span', null, t(titleKey)), extra ? h('span', { class: 'mt-spacer' }) : null, extra || null),
      h('div', { class: 'mt-analysis-sec__body' }, nodes));
  }

  function renderSide() {
    closeTransient();
    U.clear(st.els.side);
    st.side = {};
    st.els.side.setAttribute('aria-label', t(st.mode === 'distance' ? 'analysis.mode.distance' : 'analysis.mode.matrix'));
    if (st.mode === 'distance') buildSideA(st.els.side); else buildSideB(st.els.side);
  }

  function renderMain() {
    if (!st.mounted) return;
    st.els.root.dataset.mode = st.mode;
    st.els.resA.hidden = st.mode !== 'distance';
    st.els.resB.hidden = st.mode !== 'matrix';
    renderLinkBar();
    if (st.mode === 'distance') { renderMainHeadA(); renderSummaryA(); renderResultsA(); }
    else { renderMainHeadB(); renderSummaryB(); renderResultsB(); }
    renderMapHint();
    updateMap();
  }

  function closeTransient() {
    if (st.side.chainField) st.side.chainField.close();
    closePopup();
  }

  function setMode(mode) {
    mode = mode === 'matrix' ? 'matrix' : 'distance';
    if (mode === st.mode) return;
    st.mode = mode;
    saveSettings();
    if (!st.mounted) return;
    setPicking(false, true);
    closePopup();
    renderHead();
    renderSide();
    renderMain();
    if (mode === 'matrix') { st.b.fitPending = true; scheduleB(0); }
    else fitA(true);
  }

  /* =========================================================================================
   * Mode A — sidebar
   * ======================================================================================= */
  function buildSideA(side) {
    const a = st.a, S = st.side;
    /* Reference */
    S.refCard = h('div', { class: 'mt-analysis-refwrap' });
    const listId = U.uid('mt-an-ref');
    S.refInput = h('input', { class: 'mt-input', type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
      'aria-label': t('analysis.ref.searchLabel'), placeholder: t('analysis.ref.searchPh'), autocomplete: 'off', spellcheck: 'false', dataset: { field: 'refSearch' } });
    S.refList = h('ul', { class: 'mt-analysis-options', id: listId, role: 'listbox', 'aria-label': t('analysis.ref.resultsAria'), hidden: true });
    S.refHint = h('div', { class: 'mt-hint mt-analysis-refhint' }, t('analysis.ref.hint'));
    S.addr = h('div', { class: 'mt-analysis-addr', hidden: true, 'aria-live': 'polite' });
    S.pickBtn = h('button', { type: 'button', class: 'mt-btn mt-btn--secondary mt-btn--sm mt-analysis-pickbtn', 'aria-pressed': String(st.picking), title: t('analysis.ref.pickOnMapHint'), disabled: st.mapFailed,
      onclick: () => setPicking(!st.picking) }, iconSpan('pin', 15), h('span', null, t('analysis.ref.pickOnMap')));
    S.recent = h('div', { class: 'mt-analysis-recent' });
    side.appendChild(section('analysis.ref.section', 'target', [
      S.refCard,
      h('div', { class: 'mt-analysis-combo' }, h('div', { class: 'mt-input-group' }, iconSpan('search', 16), S.refInput), S.refList),
      S.refHint, S.addr,
      h('div', { class: 'mt-analysis-row' }, S.pickBtn),
      S.recent,
    ]));
    S.refCombo = combobox(S.refInput, S.refList, {
      options: refOptions,
      render: renderRefOption,
      onPick: pickRefOption,
      onEnterEmpty: (q) => searchAddress(q),
    });

    /* Universe */
    const by = MT.ui.segmented({
      options: [{ value: 'distance', label: t('analysis.universe.distance') }, { value: 'districts', label: t('analysis.universe.districts') }],
      value: a.uniKind === 'districts' ? 'districts' : 'distance', ariaLabel: t('analysis.universe.by'),
      onChange: (v) => setUniverseA(v === 'districts' ? { kind: 'districts' } : { kind: a.lastDist }),
    });
    by.classList.add('mt-seg--block', 'mt-analysis-by');
    S.uniBy = by;
    S.uniChips = distChips({
      values: UNIVERSE_KM.map((k) => k * 1000), extra: [{ value: 'all', label: t('analysis.universe.all') }],
      value: () => (a.uniKind === 'all' ? 'all' : a.uniMeters), ariaLabel: t('analysis.universe.maxLabel'),
      onChange: (v) => setUniverseA(v === 'all' ? { kind: 'all' } : { kind: 'distance', meters: v }),
    });
    S.uniDist = field(t('analysis.universe.maxLabel'), S.uniChips.el);
    S.uniDistricts = districtPicker({ get: () => a.districts, set: (list) => setUniverseA({ kind: 'districts', districts: list }) });
    S.uniDistrictsBox = h('div', { class: 'mt-analysis-field' }, S.uniDistricts.el);
    S.chainField = chainField({ get: () => a.chains, set: (set) => { a.chains = set; a.chainsTouched = true; onParamsA(); }, counts: () => a.counts, defaults: () => AN().defaultChains(a.ref) });
    const tv = MT.ui.switchEl({ label: t('analysis.universe.toVerify'), checked: a.includeToVerify, onChange: (on) => { a.includeToVerify = on; onParamsA(); } });
    side.appendChild(section('analysis.universe.section', 'layers', [
      by, S.uniDist, S.uniDistrictsBox, S.chainField.el,
      h('div', { class: 'mt-analysis-field' }, tv, h('div', { class: 'mt-hint mt-analysis-switchhint' }, t('analysis.universe.toVerifyHint') + ' ' + t('analysis.universe.closedNote'))),
    ]));

    /* Rings */
    S.ringChips = h('div', { class: 'mt-chips mt-analysis-chips', role: 'list' });
    S.ringInput = h('input', { class: 'mt-input mt-input--sm', type: 'text', inputmode: 'decimal', placeholder: t('analysis.rings.addPh'), 'aria-label': t('analysis.rings.addLabel'), dataset: { field: 'ringAdd' } });
    S.ringMsg = h('div', { class: 'mt-field__error', role: 'alert' });
    const addRing = () => {
      const m = parseDistance(S.ringInput.value);
      let err = '';
      if (!(m >= RING_MIN && m <= RING_MAX)) err = t('analysis.rings.invalid');
      else if (a.rings.indexOf(m) >= 0) err = t('analysis.rings.exists');
      else if (a.rings.length >= MAX_RINGS) err = t('analysis.rings.max');
      S.ringMsg.textContent = err;
      S.ringInput.classList.toggle('is-invalid', !!err);
      if (err) return;
      S.ringInput.value = '';
      setRingsA(a.rings.concat(m));
    };
    S.ringInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addRing(); } });
    side.appendChild(section('analysis.rings.section', 'target', [
      h('div', { class: 'mt-hint' }, t('analysis.rings.hint')),
      S.ringChips,
      h('div', { class: 'mt-analysis-row mt-analysis-ringadd' }, S.ringInput, MT.ui.button({ icon: 'plus', label: t('analysis.rings.add'), kind: 'secondary', size: 'sm', onClick: addRing })),
      S.ringMsg,
    ], linkBtn(t('analysis.rings.reset'), () => { S.ringMsg.textContent = ''; setRingsA(DEFAULT_RINGS.slice()); })));

    /* Map options */
    const lines = MT.ui.switchEl({ label: t('analysis.mapOpts.lines'), checked: a.showLines, onChange: (on) => { a.showLines = on; saveSettings(); updateMap(); } });
    S.topInput = h('input', { class: 'mt-input mt-input--sm mt-input--num mt-analysis-topin', type: 'number', min: '0', max: String(TOP_MAX), step: '1', value: String(a.listTop), 'aria-label': t('analysis.mapOpts.topAria') });
    const setTop = () => { const v = numOr(S.topInput.value, a.listTop, 0, TOP_MAX); S.topInput.value = String(v); if (v !== a.listTop) { a.listTop = v; saveSettings(); updateMap(); } };
    S.topInput.addEventListener('change', setTop);
    S.topInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setTop(); } });
    side.appendChild(section('analysis.mapOpts.section', 'map', [
      h('div', { class: 'mt-analysis-field' }, lines),
      h('label', { class: 'mt-analysis-inline' }, h('span', { class: 'mt-analysis-inline__text' }, h('span', null, t('analysis.mapOpts.top')), h('small', { class: 'mt-hint' }, t('analysis.mapOpts.topHint'))), S.topInput),
    ]));

    renderRefCard();
    renderUniverseA();
    renderRingChips();
    renderRecent();
    renderAddress();
  }

  /* ---- Reference: type-ahead options ---- */
  function refOptions(q) {
    const out = [];
    const c = MT.geo.parseCoordsDetailed(q);
    if (c && !c.error) out.push({ kind: 'coords', lat: c.lat, lng: c.lng, link: c.source !== 'text', inPeru: c.inPeru, label: placeName(q) });
    else if (looksLikeLink(q)) {
      // A short link (maps.app.goo.gl — what "Compartir" and WhatsApp give) or a link without
      // coordinates: say how to get a usable one instead of geocoding the URL.
      out.push({ kind: 'error', disabled: true, text: t(c && c.error === 'shortlink' ? 'geo.error.shortlink' : 'geo.error.invalid') });
    } else {
      searchStores(q, 7).forEach((s) => out.push({ kind: 'store', s: s }));
      if (U.normalize(q).length >= 3) out.push({ kind: 'address', q: q.trim() });
    }
    return out;
  }
  function renderRefOption(o) {
    if (o.kind === 'error') {
      return h('li', { class: 'mt-analysis-opt mt-analysis-opt--error', 'aria-disabled': 'true' }, iconSpan('warning', 16, 'mt-analysis-opt__icon'),
        h('span', { class: 'mt-analysis-opt__main' }, h('span', { class: 'mt-analysis-opt__msg' }, o.text)));
    }
    if (o.kind === 'store') {
      const s = o.s;
      return h('li', { class: 'mt-analysis-opt', dataset: { id: s.id } }, logo(s.chain, 24, 'mt-analysis-opt__logo'),
        h('span', { class: 'mt-analysis-opt__main' }, h('span', { class: 'mt-analysis-opt__name' }, s.name), h('span', { class: 'mt-analysis-opt__sub' }, storeSub(s))),
        s.status === 'to_verify' ? h('span', { class: 'mt-badge mt-badge--warn' }, t('analysis.flag.toVerify')) : null);
    }
    if (o.kind === 'coords') {
      return h('li', { class: 'mt-analysis-opt mt-analysis-opt--accent' }, iconSpan('pin', 16, 'mt-analysis-opt__icon'),
        h('span', { class: 'mt-analysis-opt__main' }, h('span', { class: 'mt-analysis-opt__name' }, t('analysis.ref.useCoords', { coords: AN().formatCoords(o.lat, o.lng) })),
          h('span', { class: 'mt-analysis-opt__sub' }, t(o.link ? 'analysis.ref.fromLink' : 'analysis.ref.fromCoords') + (o.inPeru ? '' : ' · ' + t('analysis.ref.outsidePeru')))));
    }
    return h('li', { class: 'mt-analysis-opt mt-analysis-opt--address' }, iconSpan('globe', 16, 'mt-analysis-opt__icon'),
      h('span', { class: 'mt-analysis-opt__main' }, h('span', { class: 'mt-analysis-opt__name' }, t('analysis.ref.searchAddress', { q: o.q })),
        h('span', { class: 'mt-analysis-opt__sub' }, t('analysis.ref.searchAddressSub'))));
  }
  function pickRefOption(o) {
    const S = st.side;
    if (o.kind === 'address') { searchAddress(o.q); return; }
    S.refInput.value = '';
    S.refCombo.close();
    if (o.kind === 'store') setRef(AN().refFromStore(o.s.id));
    else if (o.kind === 'coords') setRef(AN().refFromPoint({ lat: o.lat, lng: o.lng, label: o.label || '' }));
  }

  /** Nominatim address search (explicit submit only — SPEC §2.3). Results listed under the box. */
  let addrCtl = null;
  function searchAddress(q) {
    q = String(q || '').trim();
    if (!q) return Promise.resolve([]);
    const a = st.a;
    if (st.side.refCombo) st.side.refCombo.close();
    if (addrCtl) addrCtl.abort();
    // A pasted link is not an address: never send it to Nominatim.
    if (looksLikeLink(q)) {
      const c = MT.geo.parseCoordsDetailed(q);
      a.address = { q: q, state: 'error', list: [], msg: t(c && c.error === 'shortlink' ? 'geo.error.shortlink' : 'geo.error.invalid') };
      renderAddress();
      return Promise.resolve([]);
    }
    const ctl = addrCtl = new AbortController();
    a.address = { q: q, state: 'busy', list: [] };
    renderAddress();
    let bias = null;
    if (st.mapReady) { const b = st.map.getBounds(); bias = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; }
    return MT.geo.search(q, { limit: 6, signal: ctl.signal, bbox: bias }).then((list) => {
      if (ctl.signal.aborted) return [];
      a.address = { q: q, state: 'done', list: list || [], msg: list && list.length ? '' : t('geo.noResults') };
      renderAddress();
      return list || [];
    }, (err) => {
      if (err && err.name === 'AbortError') return [];
      a.address = { q: q, state: 'error', list: [], msg: t('geo.searchFailed') };
      renderAddress();
      return [];
    });
  }
  function renderAddress() {
    const S = st.side, a = st.a;
    if (!S.addr) return;
    U.clear(S.addr);
    const x = a.address;
    S.addr.hidden = !x;
    if (!x) return;
    const head = h('div', { class: 'mt-analysis-addr__head' },
      h('span', null, x.state === 'busy' ? t('analysis.ref.searching') : x.list.length ? t('analysis.ref.addressPick') : x.msg),
      h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-btn--sm', title: t('common.close'), 'aria-label': t('common.close'), html: icon('close', 15),
        onclick: () => { a.address = null; if (addrCtl) addrCtl.abort(); renderAddress(); S.refInput.focus(); } }));
    if (x.state === 'busy') head.insertBefore(h('span', { class: 'mt-spinner mt-analysis-addr__spin' }), head.firstChild);
    S.addr.appendChild(head);
    if (x.list.length) {
      const ul = h('ul', { class: 'mt-analysis-addr__list', 'aria-label': t('analysis.ref.addressResults') });
      x.list.forEach((p) => {
        ul.appendChild(h('li', null, h('button', { type: 'button', class: 'mt-analysis-addr__item', onclick: () => {
          const label = p.name || p.street || String(p.label || '').split(',')[0] || '';
          a.address = null;
          S.refInput.value = '';
          setRef(AN().refFromPoint({ lat: p.lat, lng: p.lng, label: label.trim() }));
        } }, iconSpan('pin', 15), h('span', { class: 'mt-analysis-addr__text' }, p.label))));
      });
      S.addr.appendChild(ul);
    }
  }

  function renderRefCard() {
    const S = st.side, a = st.a, r = a.ref;
    if (!S.refCard) return;
    U.clear(S.refCard);
    S.refHint.hidden = !!r;
    if (!r) return;
    const clear = h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-btn--sm mt-analysis-refcard__x', title: t('analysis.ref.clear'), 'aria-label': t('analysis.ref.clear'),
      html: icon('close', 16), onclick: () => clearRef() });
    if (r.type === 'store') {
      const s = MT.data.store(r.storeId);
      S.refCard.appendChild(h('div', { class: 'mt-analysis-refcard', dataset: { type: 'store' } },
        logo(r.chainId, 34, 'mt-analysis-refcard__logo'),
        h('div', { class: 'mt-analysis-refcard__main' },
          h('div', { class: 'mt-analysis-refcard__kicker' }, t('analysis.ref.store')),
          h('div', { class: 'mt-analysis-refcard__title' }, r.label),
          h('div', { class: 'mt-analysis-refcard__sub' }, [chainName(r.chainId), s && s.district].filter(Boolean).join(' · ')),
          h('div', { class: 'mt-analysis-refcard__coords' }, AN().formatCoords(r.lat, r.lng),
            s && s.precision === 'approx' ? h('span', { class: 'mt-badge mt-badge--warn', title: t('analysis.ref.approx') }, '≈') : null,
            s && s.status === 'to_verify' ? h('span', { class: 'mt-badge mt-badge--warn' }, t('analysis.flag.toVerify')) : null)),
        clear));
      if (r.missing) S.refCard.appendChild(note('warning', t('analysis.ref.missing'), 'warn'));
      return;
    }
    const labelIn = h('input', { class: 'mt-input mt-input--sm', type: 'text', value: r.label || '', placeholder: t('analysis.ref.labelPh'), dataset: { field: 'refLabel' } });
    const commitLabel = U.debounce(() => {
      if (!a.ref || a.ref.type !== 'point') return;
      a.ref = Object.assign({}, a.ref, { label: labelIn.value.trim() });
      pushRecent(a.ref);
      renderMainHeadA();
      renderRecent();
      updateCardTitle();
    }, 250);
    labelIn.addEventListener('input', commitLabel);
    labelIn.addEventListener('blur', () => commitLabel.flush());
    const own = h('select', { class: 'mt-select mt-select--sm', dataset: { field: 'ownChain' } },
      h('option', { value: '' }, t('analysis.ref.ownChainNone')),
      MT.dbui.chainsByGroup().map((g) => h('optgroup', { label: t('data.group.' + g.group) }, g.chains.map((c) => h('option', { value: c.id, selected: c.id === r.chainId }, c.name)))));
    own.addEventListener('change', () => {
      const id = own.value || null;
      a.ref = Object.assign({}, a.ref, { chainId: id });
      if (id) a.chains.add(id);
      pushRecent(a.ref);
      onParamsA();
    });
    S.ownChain = own;
    const title = h('div', { class: 'mt-analysis-refcard__title' }, refName(r));
    function updateCardTitle() { title.textContent = refName(a.ref); }
    S.refCard.appendChild(h('div', { class: 'mt-analysis-refcard', dataset: { type: 'point' } },
      h('span', { class: 'mt-analysis-refcard__pin', html: icon('pin', 20) }),
      h('div', { class: 'mt-analysis-refcard__main' },
        h('div', { class: 'mt-analysis-refcard__kicker' }, t('analysis.ref.point')), title,
        h('div', { class: 'mt-analysis-refcard__coords' }, AN().formatCoords(r.lat, r.lng))),
      clear));
    S.refCard.appendChild(h('div', { class: 'mt-analysis-refcard__fields' },
      field(t('analysis.ref.labelLabel'), labelIn),
      field(t('analysis.ref.ownChain'), own, t('analysis.ref.ownChainHint'))));
  }

  function renderRecent() {
    const S = st.side, a = st.a;
    if (!S.recent) return;
    U.clear(S.recent);
    const cur = a.ref ? refKey(a.ref) : null;
    const list = st.recent.filter((x) => refKey(x) !== cur).slice(0, 5);
    if (!list.length) return;
    S.recent.appendChild(h('div', { class: 'mt-analysis-recent__title' }, t('analysis.ref.recent')));
    const ul = h('div', { class: 'mt-analysis-recent__list' });
    list.forEach((x) => {
      const isStore = x.type === 'store';
      const name = x.label || AN().formatCoords(x.lat, x.lng);
      ul.appendChild(h('button', { type: 'button', class: 'mt-analysis-recent__item', title: name, onclick: () => setRef(AN().resolveRef(x)) },
        isStore && x.chainId ? logo(x.chainId, 18) : iconSpan('pin', 15, 'mt-analysis-recent__pin'), h('span', { class: 'mt-truncate' }, name)));
    });
    S.recent.appendChild(ul);
  }

  function renderUniverseA() {
    const S = st.side, a = st.a;
    if (!S.uniDist) return;
    const byDistricts = a.uniKind === 'districts';
    if (S.uniBy) S.uniBy.setValue(byDistricts ? 'districts' : 'distance');   // also after MT.analysisui.setUniverse
    S.uniDist.hidden = byDistricts;
    S.uniDistrictsBox.hidden = !byDistricts;
    S.uniChips.update();
    S.uniDistricts.update();
    S.chainField.update();
  }
  function renderRingChips() {
    const S = st.side, a = st.a;
    if (!S.ringChips) return;
    U.clear(S.ringChips);
    a.rings.forEach((m) => {
      S.ringChips.appendChild(h('span', { class: 'mt-chip mt-analysis-ringchip', role: 'listitem', dataset: { meters: String(m) } },
        h('span', { class: 'mt-chip__label' }, fmtRing(m)),
        a.rings.length > 1 ? h('button', { type: 'button', class: 'mt-chip__x', 'aria-label': t('analysis.rings.remove', { d: fmtRing(m) }), title: t('analysis.rings.remove', { d: fmtRing(m) }),
          html: icon('close', 14), onclick: () => setRingsA(a.rings.filter((x) => x !== m)) }) : null));
    });
  }

  /* ---- Mode A — state changes ---- */
  function setRef(ref, opts) {
    opts = opts || {};
    if (!ref) return null;
    const a = st.a;
    a.ref = ref;
    if (!a.chains) a.chains = new Set();
    if (!a.chainsTouched) a.chains = new Set(AN().defaultChains(ref));
    else if (ref.chainId) a.chains.add(ref.chainId);
    a.selected = null;
    a.filter = '';
    a.address = null;
    if (addrCtl) addrCtl.abort();
    pushRecent(ref);
    closePopup();
    st.picking = false;
    if (st.mode !== 'distance') { st.mode = 'distance'; saveSettings(); if (st.mounted) { renderHead(); renderSide(); } }
    computeA();
    if (st.mounted) {
      if (st.side.refCard) { renderRefCard(); renderRecent(); renderAddress(); renderUniverseA(); syncPickBtn(); }
      if (st.a.ui) st.a.ui.filter.value = '';
      renderMain();
      if (opts.fit !== false) fitA(true);
      announce(t('analysis.ref.set', { label: refName(ref) }));
    }
    return ref;
  }
  function clearRef() {
    const a = st.a;
    a.ref = null; a.res = null; a.ringSum = null; a.selected = null; a.byId = null;
    closePopup();
    if (st.side.refCard) { renderRefCard(); renderRecent(); renderUniverseA(); }
    renderMain();
    if (st.side.refInput) st.side.refInput.focus();
  }
  function setUniverseA(u) {
    const a = st.a;
    if (u.kind === 'districts') { a.uniKind = 'districts'; if (Array.isArray(u.districts)) a.districts = u.districts.slice(); }
    else if (u.kind === 'all') { a.uniKind = 'all'; a.lastDist = 'all'; }
    else { a.uniKind = 'distance'; a.lastDist = 'distance'; if (u.meters > 0) a.uniMeters = Math.round(u.meters); }
    onParamsA({ fit: true });
  }
  function setRingsA(list) {
    const r = cleanRings(list);
    st.a.rings = r.length ? r : DEFAULT_RINGS.slice();
    renderRingChips();
    onParamsA();
  }
  /** Any universe / chain / ring change: recompute, re-render (keeps the table's scroll). */
  function onParamsA(opts) {
    saveSettings();
    computeA();
    if (!st.mounted) return;
    if (st.side.chainField) renderUniverseA();
    renderMain();
    if (opts && opts.fit) fitA(true);
  }

  /* ---- Mode A — computation (≈ 5 ms for all of Peru: synchronous) ---- */
  function universeOpts(chains) {
    const a = st.a;
    return {
      chains: chains,
      maxMeters: a.uniKind === 'distance' ? a.uniMeters : null,
      districts: a.uniKind === 'districts' ? a.districts.slice() : [],
      includeToVerify: a.includeToVerify,
    };
  }
  function emptyReasonA() {
    const a = st.a;
    if (!a.ref) return 'noRef';
    if (a.uniKind === 'districts' && !a.districts.length) return 'noDistricts';
    if (!a.chains || !a.chains.size) return 'noChains';
    if (!a.res || !a.res.rows.length) return 'noStores';
    return null;
  }
  /**
   * The rings the results count with: with a distance universe, the rings within it plus the
   * universe's own distance (a ring past the universe would only repeat its count) — the rule of
   * slideConfig, so the tab, its Excel and the slide it makes show the same columns; otherwise the
   * rings as set.
   */
  function ringsInUse() {
    const a = st.a;
    if (a.uniKind !== 'distance') return a.rings.slice();
    const r = a.rings.filter((m) => m <= a.uniMeters);
    if (r.indexOf(a.uniMeters) < 0) r.push(a.uniMeters);
    return r.sort((x, y) => x - y);
  }
  /** The rings left out because they lie past the distance universe ([] otherwise). */
  function ringsCut() { const a = st.a; return a.uniKind === 'distance' ? a.rings.filter((m) => m > a.uniMeters) : []; }
  function computeA() {
    const a = st.a;
    if (!a.ref) { a.res = null; a.ringSum = null; a.counts = {}; a.byId = null; a.near = null; return; }
    // A store reference follows the store's current position (or its last known one).
    if (a.ref.type === 'store') a.ref = AN().resolveRef(savedRef(a.ref)) || a.ref;
    const ids = sortedChainIds(a.chains);
    a.near = null;
    if (a.uniKind === 'districts' && !a.districts.length) { a.res = { ref: a.ref, rows: [], params: {} }; a.counts = {}; }
    else {
      a.res = AN().distancesFrom(a.ref, universeOpts(ids));
      a.counts = MT.data.countsByChain(AN().distancesFrom(a.ref, universeOpts(null)).rows.map((r) => r.store));
      // The headline (nearest same-chain store, nearest competitor, nearest store) is searched in all
      // of Peru — same chains, same "por verificar" choice: a cannibalization risk does not stop at the
      // universe's edge (the card then says the store lies outside the universe).
      const full = a.uniKind === 'all' ? a.res : AN().distancesFrom(a.ref, { chains: ids, maxMeters: null, includeToVerify: a.includeToVerify });
      const sum = AN().summary(full);
      a.near = { same: sum.nearestSame, comp: sum.nearestCompetitor, any: full.rows[0] || null };
    }
    a.ringSum = AN().ringSummary(a.res, ringsInUse());
    a.byId = new Map(a.res.rows.map((r) => [r.store.id, r]));
    if (a.selected && !a.byId.has(a.selected)) a.selected = null;
  }
  /** Is a row of the all-Peru search (a.near) inside the current universe? */
  function inUniverseA(row) { return !!(row && st.a.byId && st.a.byId.has(row.store.id)); }
  /** The smallest universe chip holding `meters` ({kind:'distance', meters} or {kind:'all'}). */
  function widenFor(meters) {
    const m = UNIVERSE_KM.map((k) => k * 1000).find((x) => x >= meters && x > st.a.uniMeters);
    return m ? { kind: 'distance', meters: m } : { kind: 'all' };
  }
  function whereTextA() {
    const a = st.a;
    if (a.uniKind === 'districts') return t('analysis.results.inDistricts', { n: a.districts.length });
    if (a.uniKind === 'all') return t('analysis.results.inPeru');
    return t('analysis.results.within', { d: fmtRing(a.uniMeters) });
  }
  function filteredRowsA() {
    const a = st.a;
    if (!a.res) return [];
    const q = U.normalize(a.filter);
    if (!q) return a.res.rows;
    const words = q.split(' ');
    return a.res.rows.filter((r) => {
      const hay = U.normalize([r.store.name, chainName(r.store.chain), r.store.district, r.store.province].join(' '));
      return words.every((w) => hay.indexOf(w) >= 0);
    });
  }

  /* =========================================================================================
   * Mode A — main area
   * ======================================================================================= */
  function renderLinkBar() {
    const bar = st.els.linkBar;
    U.clear(bar);
    const m = st.linked ? MT.project.getMap(st.linked) : null;
    if (st.linked && !m) st.linked = null;
    bar.hidden = !m || st.mode !== 'distance';
    if (bar.hidden) return;
    bar.append(iconSpan('slides', 16), h('span', { class: 'mt-analysis-linkbar__text' }, t('analysis.actions.linked', { title: m.title || t('analysis.actions.untitled') })),
      h('span', { class: 'mt-spacer' }), linkBtn(t('analysis.actions.unlink'), () => { st.linked = null; renderMain(); }));
  }

  function renderMainHeadA() {
    const el = st.els.mainHead, a = st.a;
    if (!el || st.mode !== 'distance') return;
    U.clear(el);
    const reason = emptyReasonA();
    const n = a.res ? a.res.rows.length : 0;
    const meta = a.ref
      ? [t('analysis.results.stores', { n: n, num: fmtNum(n) }) + ' ' + whereTextA(), t('analysis.results.chains', { n: a.chains ? a.chains.size : 0 })].join(' · ')
      : t('analysis.results.noRefMeta');
    const linkedMap = st.linked ? MT.project.getMap(st.linked) : null;
    // No stores in the universe: nothing to export or to put on a slide (the empty state offers to widen it).
    const none = !a.ref || !!reason;
    const actions = h('div', { class: 'mt-analysis-mainhead__actions' },
      MT.ui.button({ icon: 'table', label: t('analysis.actions.excel'), kind: 'secondary', size: 'sm', disabled: none, onClick: () => exportXlsx(), className: 'mt-analysis-act-excel' }),
      linkedMap ? MT.ui.button({ icon: 'refresh', label: t('analysis.actions.updateSlide'), kind: 'secondary', size: 'sm', disabled: none,
        title: t('analysis.actions.updateSlideHint', { title: linkedMap.title || t('analysis.actions.untitled') }), onClick: () => updateSlide(), className: 'mt-analysis-act-update' }) : null,
      MT.ui.button({ icon: 'slides', label: t('analysis.actions.addSlide'), kind: 'primary', size: 'sm', disabled: none,
        title: t('analysis.actions.addSlideHint'), onClick: () => addAsSlide(), className: 'mt-analysis-act-slide' }));
    // The icon-only title attribute of MT.ui.button is set only without a label: keep the hint visible on hover.
    U.$$('.mt-analysis-act-slide, .mt-analysis-act-update', actions).forEach((b) => { b.removeAttribute('aria-label'); });
    el.append(
      h('div', { class: 'mt-analysis-mainhead__titles' },
        h('h2', { class: 'mt-analysis-mainhead__h' }, !a.ref ? t('analysis.results.noRef')
          : a.ref.label ? t('analysis.results.title', { ref: a.ref.label }) : t('analysis.results.titlePoint', { coords: AN().formatCoords(a.ref.lat, a.ref.lng) })),
        h('div', { class: 'mt-analysis-mainhead__meta' }, meta)),
      actions);
  }

  function statCard(cls, label, nodes) {
    return h('div', { class: 'mt-analysis-stat' + (cls ? ' ' + cls : '') }, h('div', { class: 'mt-analysis-stat__label', title: String(label) }, unitText(label)), nodes);
  }
  /** "Fuera del universo (2 km)" / "Fuera de los distritos elegidos" — a nearest store found past the universe. */
  function outsideText() {
    const a = st.a;
    return a.uniKind === 'districts' ? t('analysis.summary.outsideDistricts') : t('analysis.summary.outsideUniverse', { u: fmtRing(a.uniMeters) });
  }
  /**
   * A "nearest …" card. `row` comes from the all-Peru search (a.near): inside the universe it links to
   * its table row; outside it still gives the distance, tagged, with one click to widen the universe.
   */
  function nearestStat(label, row, emptyText, cls) {
    if (!row) return statCard(cls, label, h('div', { class: 'mt-analysis-stat__empty' }, emptyText));
    const s = row.store, inside = inUniverseA(row), a = st.a;
    const nodes = [
      h('div', { class: 'mt-analysis-stat__value' }, fmtDist(row.meters)),
      inside ? h('button', { type: 'button', class: 'mt-analysis-stat__store', title: s.name, onclick: () => selectStoreA(s.id, { source: 'summary' }) },
        logo(s.chain, 20), h('span', { class: 'mt-truncate' }, s.name))
        : h('div', { class: 'mt-analysis-stat__store is-static', title: s.name }, logo(s.chain, 20), h('span', { class: 'mt-truncate' }, s.name)),
      h('div', { class: 'mt-analysis-stat__sub' }, [dirLong(row.dir), s.district].filter(Boolean).join(' · ')),
    ];
    if (!inside) {
      const w = a.uniKind === 'districts' ? null : widenFor(row.meters);
      nodes.push(h('div', { class: 'mt-analysis-stat__out' }, h('span', { class: 'mt-badge mt-badge--warn' }, outsideText()),
        w ? linkBtn(w.kind === 'all' ? t('analysis.empty.allPeru') : t('analysis.empty.widen', { d: fmtRing(w.meters) }), () => setUniverseA(w)) : null));
    }
    return statCard(cls + (inside ? '' : ' is-outside'), label, nodes);
  }
  function renderSummaryA() {
    const el = st.els.summary, a = st.a;
    U.clear(el);
    const reason = emptyReasonA();
    el.hidden = !!(reason && reason !== 'noStores') || !a.ringSum;
    if (el.hidden) return;
    const near = a.near || {}, rs = a.ringSum, rel = rs.relation;
    const cards = [];
    if (rel) cards.push(nearestStat(t('analysis.summary.nearestSame'), near.same || null, t('analysis.summary.noneSame', { chain: chainName(a.ref.chainId) }), 'is-same'));
    else {
      cards.push(statCard('is-same', t('analysis.summary.nearestSame'), [
        h('div', { class: 'mt-analysis-stat__empty' }, t('analysis.summary.noChain')),
        st.side.ownChain ? linkBtn(t('analysis.summary.pickChain'), () => st.side.ownChain.focus()) : null]));
    }
    cards.push(rel ? nearestStat(t('analysis.summary.nearestComp'), near.comp || null, t('analysis.summary.noneComp'), 'is-comp')
      : nearestStat(t('analysis.summary.nearestAny'), near.any || null, t('analysis.summary.noneComp'), 'is-comp'));
    // Cumulative counts per ring ("Tiendas a menos de…") — only the rings within the universe.
    const tbl = h('table', { class: 'mt-analysis-ringsum' });
    const hr = h('tr', null, h('th', { scope: 'col' }, ''));
    rs.cumulative.forEach((c) => hr.appendChild(h('th', { scope: 'col', class: 'is-num' }, fmtRing(c.to))));
    tbl.appendChild(h('thead', null, hr));
    const body = h('tbody');
    const line = (label, key, cls) => {
      const tr = h('tr', { class: cls || null }, h('th', { scope: 'row' }, label));
      rs.cumulative.forEach((c) => tr.appendChild(h('td', { class: 'is-num' + (c[key] ? '' : ' is-zero') }, fmtNum(c[key]))));
      body.appendChild(tr);
    };
    line(t('analysis.summary.total'), 'total', 'is-total');
    if (rel) { line(t('analysis.summary.same'), 'sameChain', 'is-same'); line(t('analysis.summary.comp'), 'competitors', 'is-comp'); }
    tbl.appendChild(body);
    cards.push(statCard('is-rings', t('analysis.summary.rings'), [h('div', { class: 'mt-analysis-ringsum__wrap' }, tbl), ringsNote()]));
    cards.forEach((c) => el.appendChild(c));
  }
  /** Muted line under the ring counts: rings left out past the universe / counts limited to the districts. */
  function ringsNoteText() {
    const a = st.a, cut = ringsCut();
    if (cut.length) return t('analysis.summary.ringsCut', { n: cut.length, list: listText(cut.map(fmtRing)), u: fmtRing(a.uniMeters) });
    if (a.uniKind === 'districts') return t('analysis.summary.inDistricts');
    return '';
  }
  function ringsNote() {
    const text = ringsNoteText();
    return text ? h('div', { class: 'mt-analysis-ringsum__note' }, text) : null;
  }

  /* ---- Results pane (A): tabs, filter, table / ring table / empty states ---- */
  function columnsA() {
    return [
      { id: 'rank', label: t('analysis.col.rank'), width: 50, num: true, sortKey: (r) => r.rank, render: (r) => String(r.rank) },
      { id: 'store', label: t('analysis.col.store'), sortKey: (r) => r.store.name,
        render: (r, i, vis) => storeCell(r.store, [
          vis && !vis.has('relation') && r.sameChain === true ? h('span', { class: 'mt-badge mt-badge--accent' }, t('analysis.relation.same')) : null,
          vis && !vis.has('flags') ? flagBadges(r, true) : null]) },
      { id: 'chain', label: t('analysis.col.chain'), width: 124, minWidth: 900, sortKey: (r) => chainName(r.store.chain), render: (r) => h('span', { class: 'mt-truncate' }, chainName(r.store.chain)) },
      { id: 'distance', label: t('analysis.col.distance'), width: 88, num: true, sortKey: (r) => r.meters,
        render: (r) => h('span', { class: 'mt-analysis-dist', title: fmtMeters(r.meters) }, fmtDist(r.meters)) },
      { id: 'dir', label: t('analysis.col.dir'), width: 70, sortKey: (r) => (r.bearingDeg === null ? null : r.bearingDeg), render: dirCell },
      { id: 'relation', label: t('analysis.col.relation'), width: 124, minWidth: 540, sortKey: (r) => (r.sameChain === true ? 0 : r.sameChain === false ? 1 : null), render: relCell },
      { id: 'flags', label: t('analysis.col.flags'), width: 112, minWidth: 700, desc: true, sortKey: (r) => (r.flags.toVerify ? 2 : 0) + (r.flags.approx ? 1 : 0) || null, render: (r) => flagBadges(r, false) },
    ];
  }
  /** Logo + name (+ inline badges) over "Cadena · Distrito". */
  function storeCell(s, extra) {
    return h('div', { class: 'mt-analysis-cell-store' }, logo(s.chain, 26),
      h('div', { class: 'mt-analysis-cell-2' },
        h('div', { class: 'mt-analysis-cell-2__top' }, h('span', { class: 'mt-truncate' }, s.name), extra || null),
        h('div', { class: 'mt-analysis-cell-2__sub mt-truncate' }, storeSub(s))));
  }
  function dirCell(r) {
    if (!r.dir) return h('span', { class: 'mt-muted' }, '—');
    return h('span', { class: 'mt-analysis-dir', title: dirLong(r.dir) + ' · ' + Math.round(r.bearingDeg) + '°' },
      h('span', { class: 'mt-analysis-dir__arrow', style: { transform: 'rotate(' + Math.round(r.bearingDeg) + 'deg)' }, html: icon('up', 13) }),
      h('span', null, dirShort(r.dir)));
  }
  function relCell(r) {
    if (r.sameChain === true) return h('span', { class: 'mt-badge mt-badge--accent' }, t('analysis.relation.same'));
    if (r.sameChain === false) return h('span', { class: 'mt-badge' }, t('analysis.relation.competitor'));
    return h('span', { class: 'mt-muted' }, '—');
  }
  function flagBadges(r, inline) {
    if (!r.flags.approx && !r.flags.toVerify) return null;
    return h('span', { class: 'mt-analysis-flags' + (inline ? ' is-inline' : '') },
      r.flags.approx ? h('span', { class: 'mt-badge mt-badge--warn', title: t('analysis.flag.approx') }, '≈') : null,
      r.flags.toVerify ? h('span', { class: 'mt-badge mt-badge--warn', title: t('analysis.flag.toVerify') }, t('analysis.flag.toVerify')) : null);
  }

  function buildResultsA() {
    const a = st.a, R = st.els.resA;
    U.clear(R);
    const ui = a.ui = {};
    ui.tabs = h('div', { class: 'mt-analysis-rtabs-wrap' });
    ui.filter = h('input', { class: 'mt-input mt-input--sm', type: 'search', placeholder: t('analysis.results.filterPh'), 'aria-label': t('analysis.results.filterLabel'), value: a.filter, dataset: { field: 'filterA' } });
    const onFilter = U.debounce(() => { a.filter = ui.filter.value; renderResultsA(); }, 120);
    ui.filter.addEventListener('input', onFilter);
    ui.filter.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && a.table) { e.preventDefault(); a.table.focus(); } });
    ui.filterBox = h('div', { class: 'mt-input-group mt-analysis-filter' }, iconSpan('search', 15), ui.filter);
    ui.count = h('span', { class: 'mt-analysis-rcount', 'aria-live': 'polite' });
    ui.bar = h('div', { class: 'mt-analysis-rbar' }, ui.tabs, h('span', { class: 'mt-spacer' }), ui.count, ui.filterBox);
    ui.content = h('div', { class: 'mt-analysis-rcontent' });
    R.append(ui.bar, ui.content);
    a.table = vtable({
      label: t('analysis.results.tableLabel'), cls: 'mt-analysis-table--a', rowHeight: 48, columns: columnsA(), sort: { key: 'rank', dir: 1 },
      id: (r) => r.store.id,
      rowClass: (r) => (r.sameChain === true ? 'is-same' : ''),
      onSelect: (id, source) => selectStoreA(id, { source: source }),
      onHover: (id) => hoverStore(id),
      onActivate: (id) => selectStoreA(id, { source: 'activate' }),
    });
  }
  function renderResultsA() {
    const a = st.a;
    if (st.mode !== 'distance') return;
    if (!a.ui) buildResultsA();
    const ui = a.ui, reason = emptyReasonA();
    const n = a.res ? a.res.rows.length : 0;
    U.clear(ui.tabs);
    ui.tabs.appendChild(tabStrip([{ id: 'stores', label: t('analysis.results.tabStores'), count: reason === 'noRef' ? undefined : n }, { id: 'rings', label: t('analysis.results.tabRings') }],
      a.view, (v) => { a.view = v; renderResultsA(); }));
    ui.bar.hidden = reason === 'noRef';
    U.clear(ui.content);
    if (reason && reason !== 'noStores') { ui.filterBox.hidden = true; ui.count.textContent = ''; ui.content.appendChild(emptyA(reason)); return; }
    if (reason === 'noStores') { ui.filterBox.hidden = true; ui.count.textContent = ''; ui.content.appendChild(emptyA(reason)); return; }
    if (a.view === 'rings') {
      ui.filterBox.hidden = true; ui.count.textContent = '';
      ui.content.appendChild(ringTableA());
      return;
    }
    ui.filterBox.hidden = false;
    const rows = filteredRowsA();
    ui.count.textContent = rows.length !== n ? t('analysis.results.filtered', { n: fmtNum(rows.length), total: fmtNum(n) }) : '';
    ui.content.appendChild(a.table.el);
    if (!rows.length) ui.content.appendChild(h('div', { class: 'mt-analysis-nomatch' }, t('analysis.results.noMatch')));
    // A new result (reference, universe, chains…) or a new filter starts at the top of the table.
    const same = ui.shown === a.res && ui.shownFilter === a.filter;
    ui.shown = a.res; ui.shownFilter = a.filter;
    a.table.setRows(rows, { keepScroll: same });
    a.table.select(a.selected, { scroll: false });
  }
  function emptyA(reason) {
    const a = st.a;
    if (reason === 'noRef') {
      return MT.ui.emptyState({ icon: 'target', title: t('analysis.ref.emptyTitle'), text: MT.data.stores().length ? t('analysis.ref.emptyText') : t('analysis.empty.noData'), className: 'mt-analysis-empty',
        action: MT.ui.button({ icon: 'search', label: t('analysis.ref.searchLabel'), kind: 'secondary', onClick: () => { if (st.side.refInput) st.side.refInput.focus(); } }) });
    }
    if (reason === 'noDistricts') {
      return MT.ui.emptyState({ icon: 'pin', title: t('analysis.empty.noDistrictsTitle'), text: t('analysis.empty.noDistrictsText'), className: 'mt-analysis-empty',
        action: MT.ui.button({ label: t('analysis.universe.distance'), kind: 'secondary', onClick: () => setUniverseA({ kind: a.lastDist }) }) });
    }
    if (reason === 'noChains') {
      return MT.ui.emptyState({ icon: 'store', title: t('analysis.empty.noChainsTitle'), text: t('analysis.empty.noChainsText'), className: 'mt-analysis-empty',
        action: MT.ui.button({ label: t('analysis.empty.allChains'), kind: 'secondary', onClick: () => setChainsA(MT.data.chains().map((c) => c.id)) }) });
    }
    // noStores: say where the nearest store of the chosen chains is, and widen to it in one click.
    const actions = h('div', { class: 'mt-row mt-row--wrap', style: { justifyContent: 'center' } });
    const any = a.near && a.near.any;
    let text = t('analysis.empty.noStoresText', { where: whereTextA() });
    if (any) text += ' ' + t('analysis.empty.nearestHint', { store: any.store.name, d: fmtDist(any.meters) });
    if (a.uniKind === 'distance' && any) {
      const w = widenFor(any.meters);
      actions.appendChild(MT.ui.button({ label: w.kind === 'all' ? t('analysis.empty.allPeru') : t('analysis.empty.widen', { d: fmtRing(w.meters) }), kind: 'secondary', className: 'mt-analysis-widen',
        onClick: () => setUniverseA(w) }));
    }
    if (a.chains.size < MT.data.chains().length) actions.appendChild(MT.ui.button({ label: t('analysis.empty.allChains'), kind: 'secondary', onClick: () => setChainsA(MT.data.chains().map((c) => c.id)) }));
    return MT.ui.emptyState({ icon: 'search', title: t('analysis.empty.noStoresTitle'), text: text, className: 'mt-analysis-empty', action: actions });
  }
  function setChainsA(ids) {
    st.a.chains = new Set(ids);
    st.a.chainsTouched = true;
    onParamsA();
  }

  function bandLabel(b, i) {
    if (b.to === null) return t('analysis.ringTable.beyond', { from: fmtRing(b.from) });
    return i === 0 ? t('analysis.ringTable.first', { to: fmtRing(b.to) }) : t('analysis.ringTable.band', { from: fmtRing(b.from), to: fmtRing(b.to) });
  }
  /** Ring bands × (total / same chain / competitors / each chain). */
  function ringTableA() {
    const a = st.a, rs = a.ringSum, rel = rs.relation;
    const bands = rs.bands.slice();
    if (rs.beyond.total) bands.push(rs.beyond);
    const tbl = h('table', { class: 'mt-table mt-analysis-ringtable', 'aria-label': t('analysis.ringTable.label') });
    const hr = h('tr', null, h('th', { scope: 'col' }, t('analysis.ringTable.chain')));
    bands.forEach((b, i) => hr.appendChild(h('th', { scope: 'col', class: 'is-num' }, unitText(bandLabel(b, i)))));
    hr.appendChild(h('th', { scope: 'col', class: 'is-num' }, t('analysis.ringTable.total')));
    tbl.appendChild(h('thead', null, hr));
    const body = h('tbody');
    const row = (head, values, total, cls) => {
      const tr = h('tr', { class: cls || null }, h('th', { scope: 'row' }, head));
      values.forEach((v) => tr.appendChild(h('td', { class: 'is-num' + (v ? '' : ' is-zero') }, fmtNum(v))));
      tr.appendChild(h('td', { class: 'is-num mt-analysis-ringtable__total' }, fmtNum(total)));
      body.appendChild(tr);
    };
    row(t('analysis.summary.total'), bands.map((b) => b.total), rs.total, 'is-total');
    if (rel) {
      row(t('analysis.summary.same'), bands.map((b) => b.sameChain), bands.reduce((s, b) => s + b.sameChain, 0), 'is-same');
      row(t('analysis.summary.comp'), bands.map((b) => b.competitors), bands.reduce((s, b) => s + b.competitors, 0), 'is-comp');
    }
    const totals = {};
    bands.forEach((b) => Object.keys(b.byChain).forEach((id) => { totals[id] = (totals[id] || 0) + b.byChain[id]; }));
    const order = chainOrder();
    Object.keys(totals).sort((x, y) => totals[y] - totals[x] || (order[x] || 999) - (order[y] || 999)).forEach((id, i) => {
      row(h('span', { class: 'mt-analysis-cell-chain' }, logo(id, 20), h('span', { class: 'mt-truncate' }, chainName(id)),
        a.ref.chainId === id ? h('span', { class: 'mt-badge mt-badge--accent' }, t('analysis.relation.same')) : null),
      bands.map((b) => b.byChain[id] || 0), totals[id], i === 0 ? 'is-firstchain' : null);
    });
    tbl.appendChild(body);
    const extra = ringsNoteText();
    return h('div', { class: 'mt-analysis-ringtable-wrap' }, tbl, h('p', { class: 'mt-hint mt-analysis-ringtable__note' }, t('analysis.ringTable.note') + (extra ? ' ' + extra : '')));
  }

  /* ---- Selection (A) ---- */
  function selectStoreA(id, opts) {
    opts = opts || {};
    const a = st.a, row = a.byId && a.byId.get(id);
    if (!row) return;
    a.selected = id;
    if (a.view !== 'stores' && opts.source !== 'table') { a.view = 'stores'; renderResultsA(); }
    if (a.table && opts.source !== 'table' && opts.source !== 'key') {
      // Make sure the row is not hidden by the text filter.
      if (a.filter && filteredRowsA().indexOf(row) < 0) { a.filter = ''; if (a.ui) a.ui.filter.value = ''; renderResultsA(); }
      a.table.select(id, { center: true, source: 'api' });
    }
    updateSelection();
    if (opts.source !== 'map') ensureVisible(row.store);
    if (opts.source !== 'key' || opts.popup) openPopupA(row);
    else closePopup();
  }

  /* =========================================================================================
   * Mode B — sidebar, computation, main area
   * ======================================================================================= */
  function buildSideB(side) {
    const b = st.b, S = st.side;
    S.regionPicker = districtPicker({ get: () => b.districts, set: (list) => { b.districts = list; onParamsB({ fit: true }); } });
    side.appendChild(section('analysis.matrix.region', 'pin', [h('div', { class: 'mt-hint' }, t('analysis.matrix.regionHint')), S.regionPicker.el]));
    S.chainField = chainField({ get: () => b.chains, set: (set) => { b.chains = set; onParamsB(); }, counts: () => b.counts, defaults: () => AN().defaultChains(null) });
    const tv = MT.ui.switchEl({ label: t('analysis.universe.toVerify'), checked: b.includeToVerify, onChange: (on) => { b.includeToVerify = on; onParamsB(); } });
    side.appendChild(section('analysis.universe.section', 'layers', [S.chainField.el,
      h('div', { class: 'mt-analysis-field' }, tv, h('div', { class: 'mt-hint mt-analysis-switchhint' }, t('analysis.universe.closedNote')))]));
    S.radius = distChips({ values: NEAR_PRESETS, value: () => b.radius, custom: true, ariaLabel: t('analysis.matrix.radius'), onChange: (v) => { b.radius = v; S.radius.update(); onParamsB(); } });
    S.threshold = distChips({ values: NEAR_PRESETS, value: () => b.threshold, custom: true, max: PAIR_MAX, invalidText: t('analysis.matrix.thresholdInvalid', { max: fmtRing(PAIR_MAX) }),
      ariaLabel: t('analysis.matrix.threshold'), onChange: (v) => { b.threshold = v; S.threshold.update(); onParamsB(); } });
    const comp = MT.ui.switchEl({ label: t('analysis.matrix.showComp'), checked: b.showComp, onChange: (on) => { b.showComp = on; onParamsB(); } });
    const nb = MT.ui.switchEl({ label: t('analysis.matrix.neighbors'), checked: b.neighbors, onChange: (on) => { b.neighbors = on; onParamsB(); } });
    side.appendChild(section('analysis.matrix.title', 'sliders', [
      field(t('analysis.matrix.radius'), S.radius.el, t('analysis.matrix.radiusHint')),
      field(t('analysis.matrix.threshold'), S.threshold.el, t('analysis.matrix.thresholdHint', { max: fmtRing(PAIR_MAX) })),
      h('div', { class: 'mt-analysis-field' }, comp),
      h('div', { class: 'mt-analysis-field' }, nb, h('div', { class: 'mt-hint mt-analysis-switchhint' }, t('analysis.matrix.neighborsHint'))),
    ]));
  }
  function onParamsB(opts) {
    saveSettings();
    st.b.selectedPair = null;                          // pair indices change with every recomputation
    closePopup();
    if (st.side.regionPicker) { st.side.regionPicker.update(); st.side.chainField.update(); }
    if (opts && opts.fit) st.b.fitPending = true;     // framed on the region's stores once computed
    scheduleB(0);
  }

  let timerB = 0, waitersB = [];
  function scheduleB(ms) {
    clearTimeout(timerB);
    const gen = ++st.b.gen;                          // cancels a running chunked computation
    st.b.computing = true;
    timerB = setTimeout(() => {
      computeB().catch((err) => { console.error('[analysis] matrix failed', err); st.b.computing = false; }).then(() => {
        if (gen !== st.b.gen) return;                  // superseded: the newer run resolves the waiters
        const w = waitersB; waitersB = [];
        w.forEach((fn) => fn());
      });
    }, ms || 0);
  }
  /** Resolves when no mode B computation is pending. */
  function whenIdleB() { return st.b.computing ? new Promise((r) => waitersB.push(r)) : Promise.resolve(); }
  /**
   * Mode B: per-store neighbours (MT.analysis.neighborMatrix; candidates = every store of the chosen
   * chains in Peru when "contar vecinas fuera de la región" is on, else the region) and close pairs
   * (MT.analysis.closePairs over the region + neighbours within the threshold, pairs touching the
   * region). Large regions are computed in idle chunks of CHUNK stores (rows are sorted by id, so
   * the concatenation equals one call).
   */
  async function computeB() {
    const b = st.b, gen = b.gen, t0 = performance.now();
    const ids = sortedChainIds(b.chains);
    if (!b.districts.length) {
      Object.assign(b, { rows: null, pairs: null, pairCounts: null, byId: null, region: null, inRegion: null, extra: null, counts: {}, computing: false, fitPending: false });
      renderB();
      return;
    }
    b.counts = MT.data.countsByChain(AN().storesForRegion({ districts: b.districts, chains: null, includeToVerify: b.includeToVerify }));
    const region = AN().storesForRegion({ districts: b.districts, chains: ids, includeToVerify: b.includeToVerify });
    const cands = b.neighbors ? AN().storesForRegion({ chains: ids, includeToVerify: b.includeToVerify }) : region;
    const split = (list) => {
      const out = [];
      if (list.length > CHUNK * 1.5) for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
      else out.push(list);
      return out;
    };
    const chunks = split(region);
    const inRegion = new Set(region.map((s) => s.id));
    let pool = region;
    const extra = new Map();
    if (b.neighbors && region.length) {
      const idx = AN().index(cands);
      region.forEach((s) => idx.within(s.lat, s.lng, b.threshold, (o) => !inRegion.has(o.id)).forEach((x) => extra.set(x.store.id, x.store)));
      pool = region.concat(Array.from(extra.values()));
    }
    const pairChunks = split(pool);
    const steps = chunks.length + pairChunks.length, chunked = steps > 2;
    let done = 0;
    const step = async () => {
      done++;
      if (!chunked) return true;
      b.progress = done / steps;
      renderProgressB();
      await idle();
      return gen === b.gen;
    };
    b.progress = 0;
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      AN().neighborMatrix(chunks[i], { radius: b.radius, candidates: cands }).forEach((r) => rows.push(r));
      if (!(await step())) return;
    }
    // Close pairs in chunks of the pool against the whole pool (= one closePairs call, re-sorted).
    let pairs = [];
    for (let i = 0; i < pairChunks.length; i++) {
      AN().closePairs(pairChunks[i], { meters: b.threshold, sameChainOnly: !b.showComp, candidates: pool }).forEach((p) => {
        if (!extra.size || inRegion.has(p.a.id) || inRegion.has(p.b.id)) pairs.push(p);
      });
      if (!(await step())) return;
    }
    if (pairChunks.length > 1) pairs.sort(AN().comparePairs);
    if (gen !== b.gen) return;
    const same = pairs.reduce((n, p) => n + (p.sameChain ? 1 : 0), 0);
    const pairCounts = { total: pairs.length, same: same, comp: pairs.length - same };
    if (pairs.length > PAIR_LIST_MAX) pairs = pairs.slice(0, PAIR_LIST_MAX);
    pairs.forEach((p, i) => { p.key = String(i); });
    Object.assign(b, { rows: rows, pairs: pairs, pairCounts: pairCounts, region: region, inRegion: inRegion, extra: extra, byId: new Map(rows.map((r) => [r.store.id, r])), computing: false, progress: 1, ms: Math.round(performance.now() - t0) });
    if (b.selected && !b.byId.has(b.selected)) b.selected = null;
    if (b.selectedPair && !pairs[+b.selectedPair]) b.selectedPair = null;
    renderB();
    if (b.fitPending && st.mode === 'matrix') { b.fitPending = false; fitB(true); }
  }
  function renderB() {
    if (!st.mounted || st.mode !== 'matrix') return;
    if (st.side.chainField) st.side.chainField.update();
    renderMainHeadB(); renderSummaryB(); renderResultsB(); renderMapHint(); updateMap();
    if (st.b.rows) announce(t('analysis.results.stores', { n: st.b.rows.length, num: fmtNum(st.b.rows.length) }));
  }
  function renderProgressB() {
    const ui = st.b.ui;
    if (!ui || !ui.progress) return;
    ui.progress.hidden = false;
    ui.progress.querySelector('.mt-progress__bar').style.width = Math.round(st.b.progress * 100) + '%';
    ui.progressText.textContent = t('analysis.matrix.computing', { pct: Math.round(st.b.progress * 100) });
  }

  function regionName() {
    const ds = st.b.districts, D = MT.data.districts;
    if (!ds.length) return '';
    const set = new Set(ds);
    const zone = LIMA_ZONES.find((z) => { const u = z.ubigeos.filter((x) => D.get(x)); return u.length === set.size && u.every((x) => set.has(x)); });
    if (zone) return t('maps.districts.preset.' + zone.id);
    const prov = D.byProvince().find((p) => p.ubigeos.length === set.size && p.ubigeos.every((u) => set.has(u)));
    if (prov) return t('analysis.matrix.provinceName', { province: prov.province });
    if (ds.length <= 3) return ds.map((u) => (D.get(u) || {}).district || u).join(', ');
    return t('analysis.matrix.regionDistricts', { n: ds.length });
  }
  function renderMainHeadB() {
    const el = st.els.mainHead, b = st.b;
    if (!el || st.mode !== 'matrix') return;
    U.clear(el);
    const has = b.districts.length > 0;
    const meta = has
      ? [t('analysis.matrix.regionDistricts', { n: b.districts.length }), b.rows ? t('analysis.results.stores', { n: b.rows.length, num: fmtNum(b.rows.length) }) : null,
        t('analysis.matrix.meta', { r: fmtRing(b.radius), p: fmtRing(b.threshold) })].filter(Boolean).join(' · ')
      : t('analysis.matrix.noRegionMeta');
    el.append(
      h('div', { class: 'mt-analysis-mainhead__titles' },
        h('h2', { class: 'mt-analysis-mainhead__h' }, has ? t('analysis.matrix.titleRegion', { region: regionName() }) : t('analysis.matrix.title')),
        h('div', { class: 'mt-analysis-mainhead__meta' }, meta)),
      h('div', { class: 'mt-analysis-mainhead__actions' },
        MT.ui.button({ icon: 'table', label: t('analysis.actions.excel'), kind: 'secondary', size: 'sm', disabled: !b.rows || !b.rows.length || b.computing, onClick: () => exportXlsx(), className: 'mt-analysis-act-excel' })));
  }
  function renderSummaryB() {
    const el = st.els.summary, b = st.b;
    U.clear(el);
    el.hidden = !b.rows || !b.rows.length;
    if (el.hidden) return;
    const n = b.rows.length;
    const samePairs = b.pairCounts ? b.pairCounts.same : b.pairs.filter((p) => p.sameChain).length;
    const withSame = b.rows.filter((r) => r.sameWithin > 0).length;
    const withComp = b.rows.filter((r) => r.competitorsWithin > 0).length;
    const chains = new Set(b.rows.map((r) => r.store.chain)).size;
    const big = (v) => h('div', { class: 'mt-analysis-stat__value' }, fmtNum(v));
    const sub = (text) => h('div', { class: 'mt-analysis-stat__sub' }, text);
    el.append(
      statCard('is-count', t('analysis.matrix.summary.stores'), [big(n), sub(t('analysis.matrix.summary.chainsSub', { n: chains }))]),
      statCard('is-alert' + (samePairs ? ' is-hot' : ''), t('analysis.matrix.summary.samePairs', { d: fmtRing(b.threshold) }), [big(samePairs), sub(t('analysis.matrix.summary.samePairsSub'))]),
      statCard('is-count', t('analysis.matrix.summary.withSame', { d: fmtRing(b.radius) }), [big(withSame), sub(t('analysis.matrix.summary.share', { pct: percent(withSame, n) }))]),
      statCard('is-count', t('analysis.matrix.summary.withComp', { d: fmtRing(b.radius) }), [big(withComp), sub(t('analysis.matrix.summary.share', { pct: percent(withComp, n) }))]));
  }

  function columnsB() {
    const b = st.b;
    const near = (x, comp) => {
      if (!x) return h('span', { class: 'mt-muted' }, t('analysis.matrix.none'));
      return h('div', { class: 'mt-analysis-cell-near' + (comp ? ' is-comp' : ' is-same') },
        comp ? logo(x.store.chain, 18) : null,
        h('div', { class: 'mt-analysis-cell-2' }, h('div', { class: 'mt-analysis-cell-2__top mt-truncate' }, x.store.name),
          h('div', { class: 'mt-analysis-cell-2__sub mt-truncate' }, [comp ? chainName(x.store.chain) : null, x.store.district, b.inRegion && !b.inRegion.has(x.store.id) ? t('analysis.matrix.outside') : null].filter(Boolean).join(' · '))),
        h('span', { class: 'mt-analysis-pill' + (!comp && x.meters <= b.threshold ? ' is-hot' : ''), title: fmtMeters(x.meters) }, fmtDist(x.meters)));
    };
    return [
      { id: 'store', label: t('analysis.matrix.col.store'), sortKey: (r) => r.store.name, render: (r) => storeCell(r.store) },
      { id: 'same', label: t('analysis.matrix.col.nearestSame'), width: 270, sortKey: (r) => (r.nearestSame ? r.nearestSame.meters : null), render: (r) => near(r.nearestSame, false) },
      { id: 'comp', label: t('analysis.matrix.col.nearestComp'), width: 290, minWidth: 640, sortKey: (r) => (r.nearestCompetitor ? r.nearestCompetitor.meters : null), render: (r) => near(r.nearestCompetitor, true) },
      { id: 'sameN', label: () => unitText(t('analysis.matrix.col.sameWithin', { d: fmtRing(st.b.radius) })), width: 84, num: true, desc: true, wrapHead: true, sortKey: (r) => r.sameWithin, render: (r) => countCell(r.sameWithin, true) },
      { id: 'compN', label: () => unitText(t('analysis.matrix.col.compWithin', { d: fmtRing(st.b.radius) })), width: 84, num: true, desc: true, wrapHead: true, minWidth: 520, sortKey: (r) => r.competitorsWithin, render: (r) => countCell(r.competitorsWithin, false) },
    ];
  }
  function countCell(n, same) { return h('span', { class: 'mt-analysis-count' + (n ? '' : ' is-zero') + (same && n ? ' is-hot' : '') }, fmtNum(n)); }
  function pairColumns() {
    const b = st.b;
    // One line per store of the pair: logo · name · chain, district (· outside the region).
    const line = (s) => h('div', { class: 'mt-analysis-pairline' }, logo(s.chain, 20),
      h('span', { class: 'mt-analysis-pairline__name' }, s.name),
      h('span', { class: 'mt-analysis-pairline__sub' }, [s.district, b.inRegion && !b.inRegion.has(s.id) ? t('analysis.matrix.outside') : null].filter(Boolean).join(' · ')));
    return [
      { id: 'tag', label: t('analysis.matrix.col.tag'), width: 132, sortKey: (p) => (p.sameChain ? 0 : 1),
        render: (p) => h('span', { class: 'mt-analysis-tag' + (p.sameChain ? ' is-same' : '') }, p.sameChain ? t('analysis.matrix.tag') : t('analysis.matrix.tagComp')) },
      { id: 'pair', label: t('analysis.matrix.col.pair'), sortKey: (p) => p.a.name, render: (p) => h('div', { class: 'mt-analysis-pair' }, line(p.a), line(p.b)) },
      { id: 'meters', label: t('analysis.matrix.col.distance'), width: 96, num: true, sortKey: (p) => p.meters, render: (p) => h('span', { class: 'mt-analysis-dist', title: fmtMeters(p.meters) }, fmtDist(p.meters)) },
    ];
  }
  function buildResultsB() {
    const b = st.b, R = st.els.resB;
    U.clear(R);
    const ui = b.ui = {};
    ui.tabs = h('div', { class: 'mt-analysis-rtabs-wrap' });
    ui.filter = h('input', { class: 'mt-input mt-input--sm', type: 'search', placeholder: t('analysis.results.filterPh'), 'aria-label': t('analysis.results.filterLabel'), value: b.filter, dataset: { field: 'filterB' } });
    ui.filter.addEventListener('input', U.debounce(() => { b.filter = ui.filter.value; renderResultsB(); }, 120));
    ui.filterBox = h('div', { class: 'mt-input-group mt-analysis-filter' }, iconSpan('search', 15), ui.filter);
    ui.count = h('span', { class: 'mt-analysis-rcount', 'aria-live': 'polite' });
    ui.progressText = h('span', { class: 'mt-analysis-progress__text' });
    ui.progress = h('div', { class: 'mt-analysis-progress', hidden: true }, h('div', { class: 'mt-progress' }, h('div', { class: 'mt-progress__bar' })), ui.progressText);
    ui.bar = h('div', { class: 'mt-analysis-rbar' }, ui.tabs, ui.progress, h('span', { class: 'mt-spacer' }), ui.count, ui.filterBox);
    ui.content = h('div', { class: 'mt-analysis-rcontent' });
    R.append(ui.bar, ui.content);
    b.table = vtable({
      label: t('analysis.matrix.tableLabel'), cls: 'mt-analysis-table--b', rowHeight: 52, columns: columnsB(), sort: { key: 'same', dir: 1 },
      id: (r) => r.store.id,
      rowClass: (r) => (r.nearestSame && r.nearestSame.meters <= b.threshold ? 'is-hot' : ''),
      onSelect: (id, source) => selectStoreB(id, { source: source }),
      onHover: (id) => hoverStore(id),
      onActivate: (id) => selectStoreB(id, { source: 'activate' }),
    });
    b.pairTable = vtable({
      label: t('analysis.matrix.pairsLabel'), cls: 'mt-analysis-table--pairs', rowHeight: 60, columns: pairColumns(), sort: null,
      id: (p) => p.key,
      rowClass: (p) => (p.sameChain ? 'is-same' : ''),
      onSelect: (key, source) => selectPair(key, { source: source }),
      onHover: (key) => hoverPair(key),
      onActivate: (key) => selectPair(key, { source: 'activate' }),
    });
  }
  function filterRowsB(list, storesOf) {
    const q = U.normalize(st.b.filter);
    if (!q) return list;
    const words = q.split(' ');
    return list.filter((x) => {
      const hay = U.normalize(storesOf(x).map((s) => [s.name, chainName(s.chain), s.district].join(' ')).join(' '));
      return words.every((w) => hay.indexOf(w) >= 0);
    });
  }
  function renderResultsB() {
    const b = st.b;
    if (st.mode !== 'matrix') return;
    if (!b.ui) buildResultsB();
    const ui = b.ui;
    U.clear(ui.tabs);
    ui.tabs.appendChild(tabStrip([
      { id: 'stores', label: t('analysis.matrix.tabStores'), count: b.rows ? b.rows.length : undefined },
      { id: 'pairs', label: t('analysis.matrix.tabPairs'), count: b.pairCounts ? b.pairCounts.total : b.pairs ? b.pairs.length : undefined }], b.view, (v) => { b.view = v; renderResultsB(); updateMap(); }));
    ui.progress.hidden = !(b.computing && b.progress > 0 && b.progress < 1);
    U.clear(ui.content);
    if (!b.districts.length) {
      ui.bar.hidden = true;
      const zones = h('div', { class: 'mt-analysis-zonebtns' });
      LIMA_ZONES.forEach((z) => {
        const us = z.ubigeos.filter((u) => MT.data.districts.get(u));
        if (us.length) zones.appendChild(MT.ui.button({ label: t('maps.districts.preset.' + z.id), kind: 'secondary', size: 'sm', onClick: () => { b.districts = us.slice(); if (st.side.regionPicker) st.side.regionPicker.update(); onParamsB({ fit: true }); } }));
      });
      ui.content.appendChild(MT.ui.emptyState({ icon: 'pin', title: t('analysis.matrix.emptyTitle'), text: t('analysis.matrix.emptyText'), className: 'mt-analysis-empty', action: zones }));
      return;
    }
    ui.bar.hidden = false;
    if (!b.rows) { ui.filterBox.hidden = true; ui.count.textContent = ''; ui.content.appendChild(h('div', { class: 'mt-analysis-loading' }, h('span', { class: 'mt-spinner' }))); return; }
    if (!b.rows.length) {
      ui.filterBox.hidden = true; ui.count.textContent = '';
      ui.content.appendChild(MT.ui.emptyState({ icon: 'search', title: t('analysis.matrix.noStoresTitle'), text: t('analysis.matrix.noStoresText'), className: 'mt-analysis-empty',
        action: b.chains.size < MT.data.chains().length ? MT.ui.button({ label: t('analysis.empty.allChains'), kind: 'secondary', onClick: () => { b.chains = new Set(MT.data.chains().map((c) => c.id)); onParamsB(); } }) : null }));
      return;
    }
    ui.filterBox.hidden = false;
    if (b.view === 'pairs') {
      const rows = filterRowsB(b.pairs, (p) => [p.a, p.b]);
      ui.count.textContent = rows.length !== b.pairs.length ? t('analysis.results.filtered', { n: fmtNum(rows.length), total: fmtNum(b.pairs.length) }) : '';
      if (!b.pairs.length) {
        ui.content.appendChild(MT.ui.emptyState({ icon: 'success', title: b.showComp ? t('analysis.matrix.noPairs', { d: fmtRing(b.threshold) }) : t('analysis.matrix.noPairsSame', { d: fmtRing(b.threshold) }), className: 'mt-analysis-empty' }));
        return;
      }
      if (b.pairCounts && b.pairCounts.total > b.pairs.length) {
        ui.content.appendChild(h('div', { class: 'mt-analysis-capnote', role: 'note' }, iconSpan('info', 14),
          h('span', null, t('analysis.matrix.pairsCapped', { shown: fmtNum(b.pairs.length), total: fmtNum(b.pairCounts.total) }))));
      }
      ui.content.appendChild(b.pairTable.el);
      if (!rows.length) ui.content.appendChild(h('div', { class: 'mt-analysis-nomatch' }, t('analysis.results.noMatch')));
      b.pairTable.setRows(rows, { keepScroll: true });
      b.pairTable.select(b.selectedPair, { scroll: false });
      return;
    }
    const rows = filterRowsB(b.rows, (r) => [r.store]);
    ui.count.textContent = rows.length !== b.rows.length ? t('analysis.results.filtered', { n: fmtNum(rows.length), total: fmtNum(b.rows.length) }) : '';
    ui.content.appendChild(b.table.el);
    if (!rows.length) ui.content.appendChild(h('div', { class: 'mt-analysis-nomatch' }, t('analysis.results.noMatch')));
    b.table.setRows(rows, { keepScroll: true });
    b.table.refresh();               // header labels carry R
    b.table.select(b.selected, { scroll: false });
  }

  function selectStoreB(id, opts) {
    opts = opts || {};
    const b = st.b, row = b.byId && b.byId.get(id);
    if (!row) return;
    b.selected = id;
    b.selectedPair = null;
    if (b.view !== 'stores' && opts.source !== 'table') { b.view = 'stores'; renderResultsB(); }
    if (b.table && opts.source !== 'table' && opts.source !== 'key') {
      if (b.filter && filterRowsB([row], (r) => [r.store]).length === 0) { b.filter = ''; if (b.ui) b.ui.filter.value = ''; renderResultsB(); }
      b.table.select(id, { center: true, source: 'api' });
    }
    updateSelection();
    if (opts.source !== 'map') ensureVisible(row.store, [row.nearestSame && row.nearestSame.store].filter(Boolean));
    if (opts.source !== 'key') openPopupB(row); else closePopup();
  }
  function selectPair(key, opts) {
    opts = opts || {};
    const b = st.b, p = b.pairs && b.pairs[+key];
    if (!p) return;
    b.selectedPair = String(key);
    b.selected = null;
    if (b.view !== 'pairs') { b.view = 'pairs'; renderResultsB(); }
    if (b.pairTable && opts.source !== 'table' && opts.source !== 'key') b.pairTable.select(String(key), { center: true, source: 'api' });
    closePopup();
    updateSelection();
    if (st.mapReady && opts.source !== 'map') {
      const box = MT.geo.bboxMinSize(MT.geo.bboxOfPoints([p.a, p.b]), 600);
      st.map.fitBounds(MT.geo.bboxToBounds(box), { padding: 80, maxZoom: 16, duration: 450 });
    }
  }

  /* =========================================================================================
   * Map
   * ======================================================================================= */
  function initMap() {
    const els = st.els;
    if (st.map || st.mapFailed || !window.maplibregl || !els.mapEl || !els.mapEl.isConnected) return;
    if (!els.mapEl.clientWidth || !els.mapEl.clientHeight) return;          // hidden: created on the next show
    const map = MT.dbui.createMap(els.mapEl, { map: { center: [-77.03, -12.1], zoom: 11 } });
    if (!map) {                                     // no WebGL: tables, cards and Excel keep working
      st.mapFailed = true;
      if (st.side.pickBtn) st.side.pickBtn.disabled = true;
      renderMapHint();
      return;
    }
    st.map = map;
    map.on('style.load', installLayers);
    st.tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'mt-analysis-tip', maxWidth: '260px' });
    const hit = (e) => {
      const p = e.point, layers = st.mode === 'distance' ? ['mta-badges', 'mta-stores', 'mta-ref', 'mta-all'] : ['mtb-stores', 'mtb-pairs-same', 'mtb-pairs-comp'];
      const have = layers.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
      if (!have.length) return [];
      return map.queryRenderedFeatures([[p.x - 6, p.y - 6], [p.x + 6, p.y + 6]], { layers: have });
    };
    map.on('click', (e) => {
      if (!st.mapReady) return;
      const feats = hit(e);
      const storeF = feats.find((f) => /stores|badges|all$/.test(f.layer.id));
      if (st.mode === 'distance' && (st.picking || !st.a.ref)) {
        if (storeF && storeF.properties.id) setRef(AN().refFromStore(storeF.properties.id), { fit: false });
        else setRef(AN().refFromPoint({ lat: e.lngLat.lat, lng: e.lngLat.lng }), { fit: false });
        return;
      }
      if (st.mode === 'distance') {
        if (storeF && st.a.byId && st.a.byId.has(storeF.properties.id)) { selectStoreA(storeF.properties.id, { source: 'map' }); return; }
        if (feats.find((f) => f.layer.id === 'mta-ref')) { openRefPopup(); return; }
        closePopup();
        return;
      }
      if (storeF && st.b.byId && st.b.byId.has(storeF.properties.id)) { selectStoreB(storeF.properties.id, { source: 'map' }); return; }
      const pairF = feats.find((f) => /pairs/.test(f.layer.id));
      if (pairF) { selectPair(pairF.properties.key, { source: 'map' }); return; }
      closePopup();
    });
    map.on('mousemove', (e) => {
      if (!st.mapReady) return;
      const feats = hit(e);
      const f = feats.find((x) => /stores|badges|all$/.test(x.layer.id)) || feats[0];
      map.getCanvas().style.cursor = f ? 'pointer' : (st.picking || (st.mode === 'distance' && !st.a.ref) ? 'crosshair' : '');
      if (!f || !f.properties.id || (st.popup && st.popup._id === f.properties.id)) { st.tip.remove(); return; }
      const s = MT.data.store(f.properties.id);
      if (!s) { st.tip.remove(); return; }
      let sub = storeSub(s);
      if (st.mode === 'distance' && st.a.byId && st.a.byId.has(s.id)) sub = fmtDist(st.a.byId.get(s.id).meters) + ' · ' + sub;
      st.tip.setLngLat([s.lng, s.lat]).setDOMContent(h('div', null, h('strong', null, s.name), h('div', { class: 'mt-analysis-tip__sub' }, sub))).addTo(map);
    });
    map.on('mouseout', () => { if (st.tip) st.tip.remove(); });
  }

  function firstSymbolId(map) {
    const l = (map.getStyle().layers || []).find((x) => x.type === 'symbol');
    return l ? l.id : undefined;
  }
  const CIRCLE_R = ['interpolate', ['linear'], ['zoom'], 4, 2.4, 9, 3.4, 12, 4.6, 15, 6.5];
  const HALO_R = ['interpolate', ['linear'], ['zoom'], 4, 8, 9, 9, 12, 11, 15, 14];
  const SOURCES = ['mta-rings', 'mta-ringlabels', 'mta-lines', 'mta-all', 'mta-stores', 'mta-ref', 'mtb-districts', 'mtb-pairs', 'mtb-stores', 'mtb-sel'];

  /** (Re)create the analysis sources/layers — at the first style load and after a basemap retry. */
  function installLayers() {
    const map = st.map;
    st.badges.clear();
    const before = firstSymbolId(map);
    const crimson = MT.theme.colors.crimson, dark = MT.theme.colors.crimsonDark;
    const font = MT.theme.fonts.mapLabelsBold;
    SOURCES.forEach((id) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY }); });
    const add = (layer, under) => { if (!map.getLayer(layer.id)) map.addLayer(layer, under ? before : undefined); };
    // Lines under the basemap labels
    add({ id: 'mtb-district-line', type: 'line', source: 'mtb-districts', paint: { 'line-color': '#52525B', 'line-width': 1.3, 'line-opacity': 0.6, 'line-dasharray': [3, 2] } }, true);
    add({ id: 'mta-limit-line', type: 'line', source: 'mta-rings', filter: ['==', ['get', 'kind'], 'limit'], paint: { 'line-color': '#71717A', 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [1, 2] } }, true);
    add({ id: 'mta-ring-line', type: 'line', source: 'mta-rings', filter: ['==', ['get', 'kind'], 'ring'], paint: { 'line-color': dark, 'line-width': 1.7, 'line-opacity': 0.8, 'line-dasharray': [5, 3] } }, true);
    add({ id: 'mta-lines', type: 'line', source: 'mta-lines', layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 0.85 } }, true);
    add({ id: 'mtb-pairs-comp', type: 'line', source: 'mtb-pairs', filter: ['!', ['get', 'same']], layout: { 'line-cap': 'round' }, paint: { 'line-color': COLOR_COMP, 'line-width': 1.8, 'line-opacity': 0.9 } }, true);
    add({ id: 'mtb-pairs-same', type: 'line', source: 'mtb-pairs', filter: ['get', 'same'], layout: { 'line-cap': 'round' }, paint: { 'line-color': COLOR_SAME, 'line-width': 2.8, 'line-opacity': 0.9 } }, true);
    // The selected pair: its own layer (a filter change on a click — the pair lines are not rebuilt).
    add({ id: 'mtb-pair-sel', type: 'line', source: 'mtb-pairs', filter: ['==', ['get', 'key'], ''], layout: { 'line-cap': 'round' },
      paint: { 'line-color': ['case', ['get', 'same'], COLOR_SAME, COLOR_COMP], 'line-width': ['case', ['get', 'same'], 5, 4], 'line-opacity': 1 } }, true);
    add({ id: 'mtb-sel-lines', type: 'line', source: 'mtb-sel', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-dasharray': [2, 1.5] } }, true);
    // Points and labels on top
    add({ id: 'mta-all', type: 'circle', source: 'mta-all', paint: { 'circle-radius': CIRCLE_R, 'circle-color': ['get', 'color'], 'circle-opacity': 0.55, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 0.8 } });
    add({ id: 'mta-hover', type: 'circle', source: 'mta-stores', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': HALO_R, 'circle-color': '#18181B', 'circle-opacity': 0.12 } });
    add({ id: 'mta-sel', type: 'circle', source: 'mta-stores', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': HALO_R, 'circle-color': crimson, 'circle-opacity': 0.18, 'circle-stroke-color': crimson, 'circle-stroke-width': 2 } });
    add({ id: 'mta-stores', type: 'circle', source: 'mta-stores', paint: { 'circle-radius': CIRCLE_R, 'circle-color': ['get', 'color'], 'circle-opacity': 0.95, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 12, 1.4] } });
    add({ id: 'mtb-hover', type: 'circle', source: 'mtb-stores', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': HALO_R, 'circle-color': '#18181B', 'circle-opacity': 0.12 } });
    add({ id: 'mtb-sel', type: 'circle', source: 'mtb-stores', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': HALO_R, 'circle-color': crimson, 'circle-opacity': 0.18, 'circle-stroke-color': crimson, 'circle-stroke-width': 2 } });
    add({ id: 'mtb-stores', type: 'circle', source: 'mtb-stores', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.6, 9, 3.6, 12, 5, 15, 7], 'circle-color': ['get', 'color'],
      'circle-opacity': ['case', ['get', 'inRegion'], 0.95, 0.4], 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': ['case', ['get', 'inRegion'], 1.3, 0.6] } });
    add({ id: 'mta-dist', type: 'symbol', source: 'mta-stores', filter: ['has', 'label'], layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.6],
      'symbol-sort-key': ['get', 'rank'], 'text-padding': 1 }, paint: { 'text-color': '#18181B', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.6 } });
    add({ id: 'mta-badges', type: 'symbol', source: 'mta-stores', filter: ['has', 'badge'], layout: { 'icon-image': ['get', 'badge'], 'icon-anchor': 'bottom', 'icon-offset': [0, -4],
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['-', 0, ['get', 'rank']] } });
    add({ id: 'mta-ringlabels', type: 'symbol', source: 'mta-ringlabels', layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': ['case', ['==', ['get', 'kind'], 'limit'], '#52525B', dark], 'text-halo-color': '#FFFFFF', 'text-halo-width': 2 } });
    add({ id: 'mtb-sel-labels', type: 'symbol', source: 'mtb-sel', filter: ['has', 'label'], layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 11.5, 'text-allow-overlap': true },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#FFFFFF', 'text-halo-width': 2 } });
    if (!map.hasImage('mta-ref-pin')) map.addImage('mta-ref-pin', refPinImage(), { pixelRatio: 2 });
    add({ id: 'mta-ref', type: 'symbol', source: 'mta-ref', layout: { 'icon-image': 'mta-ref-pin', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    st.mapReady = true;
    updateMap();
    st.pendingFit = false;
    if (st.mode === 'distance') fitA(false); else fitB(false);
  }

  /** Reference pin (crimson drop, white centre) as RGBA for map.addImage (2× pixels). */
  function refPinImage() {
    const W = 52, H = 66, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const cx = W / 2, r = 19, cy = r + 4;
    c.shadowColor = 'rgba(0,0,0,.28)'; c.shadowBlur = 5; c.shadowOffsetY = 2;
    c.beginPath();
    c.moveTo(cx, H - 3);
    c.bezierCurveTo(cx - 5, H - 15, cx - r, cy + 13, cx - r, cy);
    c.arc(cx, cy, r, Math.PI, 0);
    c.bezierCurveTo(cx + r, cy + 13, cx + 5, H - 15, cx, H - 3);
    c.closePath();
    c.fillStyle = MT.theme.colors.crimson;
    c.fill();
    c.shadowColor = 'transparent';
    c.lineWidth = 3; c.strokeStyle = '#FFFFFF'; c.stroke();
    c.beginPath(); c.arc(cx, cy, 7.5, 0, Math.PI * 2); c.fillStyle = '#FFFFFF'; c.fill();
    const d = c.getImageData(0, 0, W, H);
    return { width: W, height: H, data: new Uint8Array(d.data.buffer.slice(0)) };
  }

  /** Badge pictures (MT.markers — the same drawing as the slides) for the given chains. */
  function ensureBadges(ids) {
    const map = st.map;
    const need = ids.filter((id) => !st.badges.has(id));
    if (!need.length || !st.mapReady) return;
    MT.markers.ready(need, BADGE).then(() => {
      if (st.map !== map || !st.mapReady) return;
      let added = false;
      need.forEach((id) => {
        if (st.badges.has(id)) return;
        try {
          const cv = MT.markers.icon(id, 60, BADGE);
          const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
          const name = 'mta-b-' + id;
          if (map.hasImage(name)) map.removeImage(name);
          map.addImage(name, { width: cv.width, height: cv.height, data: new Uint8Array(img.data.buffer.slice(0)) }, { pixelRatio: 2 });
          st.badges.add(id);
          added = true;
        } catch (err) { console.warn('[analysis] badge not drawn', id, err); }
      });
      if (added) updateMap();
    }, () => {});
  }

  function fc(features) { return { type: 'FeatureCollection', features: features }; }
  function pointF(lng, lat, props) { return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props || {} }; }
  function lineF(a, b, props) { return { type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] }, properties: props || {} }; }
  function setData(id, data) { const s = st.map.getSource(id); if (s) s.setData(data); }
  function setVisible(prefix, on) {
    (st.map.getStyle().layers || []).forEach((l) => { if (l.id.indexOf(prefix) === 0) st.map.setLayoutProperty(l.id, 'visibility', on ? 'visible' : 'none'); });
  }

  function updateMap() {
    if (!st.mapReady || !st.map) return;
    setVisible('mta-', st.mode === 'distance');
    setVisible('mtb-', st.mode === 'matrix');
    if (st.mode === 'distance') updateMapA(); else updateMapB();
    renderMapLegend();
  }

  function updateMapA() {
    const a = st.a, r = a.ref, map = st.map;
    const showAll = st.picking || !r;
    // Every store of the selected chains, faint, while choosing a reference on the map.
    if (showAll) {
      const ids = a.chains || new Set();
      setData('mta-all', fc(MT.data.stores().filter((s) => isFinite(s.lat) && isFinite(s.lng) && ids.has(s.chain) && (!r || r.storeId !== s.id))
        .map((s) => pointF(s.lng, s.lat, { id: s.id, color: MT.data.chain(s.chain).color }))));
    } else setData('mta-all', EMPTY);
    map.setLayoutProperty('mta-all', 'visibility', showAll ? 'visible' : 'none');
    setData('mta-ref', r ? fc([pointF(r.lng, r.lat, { kind: r.type })]) : EMPTY);
    if (!r || !a.res) { ['mta-rings', 'mta-ringlabels', 'mta-lines', 'mta-stores'].forEach((id) => setData(id, EMPTY)); return; }
    // Rings (geodesic circles) + the universe's limit when it is not a ring
    const rings = [], labels = [];
    const addRing = (m, kind) => {
      const f = AN().ringFeatures(r, [m], { steps: 128 }).features[0];
      if (!f) return;
      rings.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: f.geometry.coordinates[0] }, properties: { meters: m, kind: kind } });
      const top = AN().destination(r.lat, r.lng, 0, m);
      labels.push(pointF(top.lng, top.lat, { label: fmtRing(m), kind: kind }));
    };
    // Rings past a distance universe are not drawn (no store is listed there); its limit is.
    a.rings.filter((m) => a.uniKind !== 'distance' || m <= a.uniMeters).forEach((m) => addRing(m, 'ring'));
    if (a.uniKind === 'distance' && a.rings.indexOf(a.uniMeters) < 0) addRing(a.uniMeters, 'limit');
    setData('mta-rings', fc(rings));
    setData('mta-ringlabels', fc(labels));
    // Lines to the nearest store of each chain
    const lines = a.showLines ? AN().nearestByChain(a.res) : [];
    const lineEnds = new Set(lines.map((x) => x.store.id));
    setData('mta-lines', fc(lines.map((x) => lineF(r, x.store, { color: MT.data.chain(x.store.chain).color, id: x.store.id }))));
    // Stores: dot for all; badge + distance for the nearest N; distance at the line ends
    const top = a.listTop, chains = new Set();
    const feats = a.res.rows.map((x) => {
      const p = { id: x.store.id, color: MT.data.chain(x.store.chain).color, rank: x.rank };
      if (x.rank <= top) { chains.add(x.store.chain); if (st.badges.has(x.store.chain)) p.badge = 'mta-b-' + x.store.chain; }
      if (x.rank <= top || lineEnds.has(x.store.id)) p.label = fmtDist(x.meters);
      return pointF(x.store.lng, x.store.lat, p);
    });
    setData('mta-stores', fc(feats));
    ensureBadges(Array.from(chains));
    updateSelection();
  }

  function updateMapB() {
    const b = st.b;
    setData('mtb-districts', b.districts.length && MT.data.districts.available ? MT.data.districts.features(b.districts) : EMPTY);
    if (!b.rows) { ['mtb-pairs', 'mtb-stores', 'mtb-sel'].forEach((id) => setData(id, EMPTY)); return; }
    const feats = b.region.map((s) => pointF(s.lng, s.lat, { id: s.id, color: MT.data.chain(s.chain).color, inRegion: true }));
    b.extra.forEach((s) => feats.push(pointF(s.lng, s.lat, { id: s.id, color: MT.data.chain(s.chain).color, inRegion: false })));
    setData('mtb-stores', fc(feats));
    setData('mtb-pairs', fc(b.pairs.map((p) => lineF(p.a, p.b, { key: p.key, same: p.sameChain, meters: p.meters }))));
    updateSelection();
  }

  /** Selection halo (+ mode B: dashed lines to the selected store's nearest same-chain store and competitor). */
  function updateSelection() {
    if (!st.mapReady) return;
    const map = st.map;
    if (st.mode === 'distance') { map.setFilter('mta-sel', ['==', ['get', 'id'], st.a.selected || '']); return; }
    const b = st.b;
    map.setFilter('mtb-sel', ['==', ['get', 'id'], b.selected || '']);
    const row = b.selected && b.byId ? b.byId.get(b.selected) : null;
    const f = [];
    if (row) {
      [[row.nearestSame, COLOR_SAME], [row.nearestCompetitor, '#52525B']].forEach(([x, color]) => {
        if (!x) return;
        f.push(lineF(row.store, x.store, { color: color }));
        f.push(pointF((row.store.lng + x.store.lng) / 2, (row.store.lat + x.store.lat) / 2, { color: color, label: fmtDist(x.meters) }));
      });
    }
    setData('mtb-sel', fc(f));
    map.setFilter('mtb-pair-sel', ['==', ['get', 'key'], b.selectedPair || '']);
  }
  function hoverStore(id) {
    if (!st.mapReady) return;
    st.map.setFilter(st.mode === 'distance' ? 'mta-hover' : 'mtb-hover', ['==', ['get', 'id'], id || '']);
  }
  function hoverPair(key) {
    if (!st.mapReady || !st.b.pairs) return;
    const p = key !== null ? st.b.pairs[+key] : null;
    st.map.setFilter('mtb-hover', ['in', ['get', 'id'], ['literal', p ? [p.a.id, p.b.id] : []]]);
  }

  function renderMapHint() {
    const el = st.els.mapHint;
    if (!el) return;
    U.clear(el);
    const show = st.mode === 'distance' && (st.picking || !st.a.ref) && !st.mapFailed;
    el.hidden = !show;
    if (!show) return;
    el.append(iconSpan('pin', 16), h('span', null, t('analysis.ref.pickActive')));
    if (st.picking) {
      el.appendChild(h('span', { class: 'mt-analysis-maphint__esc' }, t('analysis.ref.pickEsc')));
      el.appendChild(h('button', { type: 'button', class: 'mt-analysis-maphint__btn', onclick: () => setPicking(false) }, t('analysis.ref.pickCancel')));
    }
  }
  function renderMapLegend() {
    const el = st.els.mapLegend;
    if (!el) return;
    U.clear(el);
    const b = st.b;
    el.hidden = st.mode !== 'matrix' || !b.rows || !b.rows.length;
    if (el.hidden) return;
    const item = (cls, text) => h('div', { class: 'mt-analysis-maplegend__item' }, h('span', { class: 'mt-analysis-maplegend__sw ' + cls }), h('span', null, text));
    el.append(item('is-same', t('analysis.matrix.tag') + ' · < ' + fmtRing(b.threshold)));
    if (b.showComp) el.append(item('is-comp', t('analysis.matrix.tagComp') + ' · < ' + fmtRing(b.threshold)));
    if (b.extra && b.extra.size) el.append(item('is-outside', t('analysis.popup.outside')));
  }

  function setPicking(on, silent) {
    st.picking = !!on && st.mode === 'distance';
    syncPickBtn();
    if (silent) return;
    renderMapHint();
    updateMap();
    if (st.map) st.map.getCanvas().style.cursor = st.picking ? 'crosshair' : '';
  }
  function syncPickBtn() {
    const b = st.side.pickBtn;
    if (!b) return;
    b.setAttribute('aria-pressed', String(st.picking));
    b.classList.toggle('is-on', st.picking);
  }

  /* ---- Camera ---- */
  function canFit() {
    if (!st.mapReady) { st.pendingFit = true; return false; }
    if (!st.els.mapEl.clientWidth || !st.els.mapEl.clientHeight) { st.pendingFit = true; return false; }
    return true;
  }
  function fitBox(box, animate) {
    if (!box || !canFit()) return;
    st.map.resize();               // the pane may have just changed size (mode switch): fit the real one
    st.map.fitBounds(MT.geo.bboxToBounds(box), { padding: 36, maxZoom: 16, duration: animate ? 450 : 0 });
  }
  function fitA(animate) {
    const a = st.a, r = a.ref;
    if (st.mode !== 'distance') return;
    if (!r) {
      if (a.uniKind === 'districts' && a.districts.length) fitBox(MT.data.districts.unionBbox(a.districts), animate);
      return;
    }
    let box;
    if (a.uniKind === 'districts' && a.districts.length) box = MT.geo.bboxUnion([MT.data.districts.unionBbox(a.districts), [r.lng, r.lat, r.lng, r.lat]]);
    else box = AN().ringBbox(r, fitMetersA());
    fitBox(box, animate);
  }
  /**
   * Radius the mode A map opens at: the smallest ring holding the stores that get a logo (the
   * nearest N) — they are what the map is read for; the wider universe stays one zoom-out away.
   */
  function fitMetersA() {
    const a = st.a, rows = a.res ? a.res.rows : [];
    const cap = a.uniKind === 'distance' ? a.uniMeters : Infinity;
    if (!rows.length) return Math.min(cap, a.rings[a.rings.length - 1]);
    const need = rows[Math.min(rows.length, Math.max(1, a.listTop)) - 1].meters;
    const ring = a.rings.find((m) => m >= need);
    return Math.min(cap, ring || need * 1.08);
  }
  function fitB(animate) {
    const b = st.b;
    if (st.mode !== 'matrix' || !b.districts.length) return;
    // The region's stores (a big rural district would otherwise shrink them to a corner); its
    // districts while computing or when it has no store.
    if (b.region && b.region.length) fitBox(MT.geo.bboxMinSize(MT.geo.bboxOfPoints(b.region), 1500), animate);
    else if (MT.data.districts.available) fitBox(MT.data.districts.unionBbox(b.districts), animate);
  }
  function ensureVisible(s, others) {
    if (!st.mapReady || !canFit()) return;
    const pts = [s].concat(others || []);
    const bounds = st.map.getBounds();
    if (pts.every((p) => bounds.contains([p.lng, p.lat]))) return;
    if (pts.length > 1) { fitBox(MT.geo.bboxMinSize(MT.geo.bboxOfPoints(pts), 800), true); return; }
    st.map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(st.map.getZoom(), 13.5), duration: 450 });
  }

  /* ---- Popups ---- */
  function closePopup() {
    if (st.popup) { const p = st.popup; st.popup = null; p.remove(); }
  }
  function showPopup(lngLat, content, id) {
    if (!st.mapReady) return;
    closePopup();
    const p = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 14, className: 'mt-analysis-popup', maxWidth: '320px', focusAfterOpen: false })
      .setLngLat(lngLat).setDOMContent(content).addTo(st.map);
    p._id = id;
    p.on('close', () => { if (st.popup === p) st.popup = null; });
    st.popup = p;
    if (st.tip) st.tip.remove();
  }
  function cardHead(s) {
    return h('div', { class: 'mt-analysis-card__head' }, logo(s.chain, 30),
      h('div', { class: 'mt-analysis-card__titles' }, h('div', { class: 'mt-analysis-card__title' }, s.name), h('div', { class: 'mt-analysis-card__sub' }, storeSub(s))));
  }
  function openPopupA(row) {
    const s = row.store;
    const text = row.dir ? t('analysis.popup.distance', { d: fmtDist(row.meters), dir: dirLong(row.dir).toLowerCase() }) : t('analysis.popup.distanceSame');
    showPopup([s.lng, s.lat], h('div', { class: 'mt-analysis-card' }, cardHead(s),
      s.address ? h('div', { class: 'mt-analysis-card__line' }, s.address) : null,
      h('div', { class: 'mt-analysis-card__dist' }, text),
      h('div', { class: 'mt-analysis-card__meta' }, relCell(row),
        row.flags.approx ? h('span', { class: 'mt-badge mt-badge--warn' }, t('analysis.flag.approx')) : null,
        row.flags.toVerify ? h('span', { class: 'mt-badge mt-badge--warn' }, t('analysis.flag.toVerify')) : null),
      h('div', { class: 'mt-analysis-card__actions' },
        MT.ui.button({ icon: 'target', label: t('analysis.popup.useAsRef'), kind: 'secondary', size: 'sm', className: 'mt-analysis-useref', onClick: () => setRef(AN().refFromStore(s.id)) }))), s.id);
  }
  function openRefPopup() {
    const r = st.a.ref;
    if (!r) return;
    showPopup([r.lng, r.lat], h('div', { class: 'mt-analysis-card' },
      h('div', { class: 'mt-analysis-card__kicker' }, t('analysis.popup.isRef')),
      h('div', { class: 'mt-analysis-card__title' }, refName(r)),
      h('div', { class: 'mt-analysis-card__sub' }, r.type === 'store' ? chainName(r.chainId) : AN().formatCoords(r.lat, r.lng))), '__ref');
  }
  function openPopupB(row) {
    const s = row.store, b = st.b;
    const near = (label, x) => h('div', { class: 'mt-analysis-card__near' }, h('span', { class: 'mt-analysis-card__nearlabel' }, label),
      x ? h('span', { class: 'mt-analysis-card__nearval' }, x.store.name + ' · ' + fmtDist(x.meters)) : h('span', { class: 'mt-muted' }, t('analysis.popup.none')));
    const by = Object.keys(row.byChainWithin);
    const order = chainOrder();
    by.sort((x, y) => row.byChainWithin[y] - row.byChainWithin[x] || (order[x] || 999) - (order[y] || 999));
    showPopup([s.lng, s.lat], h('div', { class: 'mt-analysis-card' }, cardHead(s),
      near(t('analysis.popup.nearestSame'), row.nearestSame),
      near(t('analysis.popup.nearestComp'), row.nearestCompetitor),
      h('div', { class: 'mt-analysis-card__kicker' }, t('analysis.popup.within', { d: fmtRing(b.radius) })),
      by.length ? h('div', { class: 'mt-analysis-card__chains' }, by.map((id) => h('span', { class: 'mt-analysis-card__chain', title: chainName(id) }, logo(id, 18), h('span', null, fmtNum(row.byChainWithin[id])))))
        : h('div', { class: 'mt-muted mt-small' }, t('analysis.popup.none'))), s.id);
  }

  /* =========================================================================================
   * Excel
   * ======================================================================================= */
  /**
   * Workbook writer (SheetJS through MT.vendor.xlsx, like MT.io.writeXLSX) with per-sheet options:
   * autofilter and a frozen header row on the data tables only (not on the summary / parameter
   * sheets), number formats per column (`formats` {col: z}, data rows) or per cell (`cells`
   * [[row, col, z]] — e.g. the metres of the summary rows only), and header rows in bold
   * (`heads`, default [0]; MT.io.polishXLSX). sheets: [{name, rows, widths, filter, formats, cells, heads}].
   */
  function writeBook(sheets) {
    return MT.vendor.xlsx().then((XLSX) => {
      const wb = XLSX.utils.book_new();
      sheets.forEach((sh) => {
        const ws = XLSX.utils.aoa_to_sheet(sh.rows);
        if (sh.widths) ws['!cols'] = sh.widths.map((w) => ({ wch: w }));
        if (sh.filter && sh.rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sh.rows.length - 1, c: sh.rows[0].length - 1 } }) };
        const fmt = (r, c, z) => { const cell = ws[XLSX.utils.encode_cell({ r: r, c: c })]; if (cell && cell.t === 'n') cell.z = z; };
        if (sh.formats) Object.keys(sh.formats).forEach((c) => { for (let r = 1; r < sh.rows.length; r++) fmt(r, +c, sh.formats[c]); });
        (sh.cells || []).forEach((x) => fmt(x[0], x[1], x[2]));
        XLSX.utils.book_append_sheet(wb, ws, String(sh.name).slice(0, 31));
      });
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      const data = MT.io.polishXLSX(XLSX, out, sheets.map((sh) => ({ heads: sh.heads || [0], freeze: !!sh.filter && sh.rows.length > 1 })));
      return new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }
  const X = (k, v) => t('analysis.xlsx.' + k, v);
  const yes = (b) => (b ? X('yes') : '');
  /** "Datos del 2026-10-01 (3,557 tiendas activas; 4 cerradas, excluidas)" — the tab header's count (non-closed stores). */
  function dataVersion() {
    const info = MT.data.seedInfo || {}, local = MT.data.overlayStats ? MT.data.overlayStats().total : 0;
    const n = MT.data.stores().length, closed = Math.max(0, MT.data.stores({ includeClosed: true }).length - n);
    return X('dataVersionText', { date: info.generated || '—', n: n, num: fmtNum(n) }) + (closed ? X('closedPart', { n: closed, num: fmtNum(closed) }) : '') + (local ? X('localChanges', { n: local }) : '');
  }
  function nowText() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return U.todayISO() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function chainNames(set) { return sortedChainIds(set).map(chainName).join(', '); }
  function districtNames(list) { return list.map((u) => (MT.data.districts.get(u) || {}).district || u).join(', '); }

  function sheetsA() {
    const a = st.a, r = a.ref, res = a.res, rs = a.ringSum, rel = rs.relation, sum = AN().summary(res), near = a.near || {};
    const universe = a.uniKind === 'districts' ? X('universeDistricts', { list: districtNames(a.districts) }) : a.uniKind === 'all' ? X('universePeru') : X('universeDistance', { d: fmtRing(a.uniMeters) });
    // Number formats per cell: metres with one decimal on the "más cercana" rows only, whole counts elsewhere.
    const cells = [], heads = [0];
    const M1 = '#,##0.0', N0 = '#,##0';
    // The nearest same-chain store / competitor / store is searched in all of Peru (as on the cards):
    // one found past the universe is still given, with a note.
    const nearRow = (label, x) => {
      if (!x) return [label, '—', '', ''];
      cells.push([summary.length, 2, M1]);
      return [label, x.store.name + ' (' + chainName(x.store.chain) + ')', round1(x.meters), fmtDist(x.meters)].concat(inUniverseA(x) ? [] : [outsideText()]);
    };
    const summary = [[X('concept'), X('value'), X('meters'), X('distanceText'), X('note')],
      [X('ref'), refName(r)],
      [X('refType'), r.type === 'store' ? X('typeStore') : X('typePoint')],
      [X('refChain'), r.chainId ? chainName(r.chainId) : '—'],
      [X('coords'), AN().formatCoords(r.lat, r.lng)],
      [X('universe'), universe],
      [X('storesIn'), res.rows.length],
      [X('chainsIn'), chainNames(a.chains)]];
    cells.push([summary.length - 2, 1, N0]);
    if (rel) { summary.push(nearRow(t('analysis.summary.nearestSame'), near.same || null)); summary.push(nearRow(t('analysis.summary.nearestComp'), near.comp || null)); }
    else summary.push(nearRow(t('analysis.summary.nearestAny'), near.any || null));
    summary.push([]);
    heads.push(summary.length);
    summary.push(rel ? [X('withinHead'), t('analysis.summary.total'), t('analysis.summary.same'), t('analysis.summary.comp')] : [X('withinHead'), t('analysis.summary.total')]);
    rs.cumulative.forEach((c) => {
      for (let k = 1; k <= (rel ? 3 : 1); k++) cells.push([summary.length, k, N0]);
      summary.push(rel ? [fmtRing(c.to), c.total, c.sameChain, c.competitors] : [fmtRing(c.to), c.total]);
    });
    const cutNote = ringsNoteText();
    if (cutNote) summary.push([cutNote]);
    summary.push([]);
    heads.push(summary.length);
    summary.push([X('nearestByChain'), X('store'), X('meters'), X('distanceText')]);
    sum.byChain.forEach((x) => { cells.push([summary.length, 2, M1]); summary.push([chainName(x.store.chain), x.store.name, round1(x.meters), fmtDist(x.meters)]); });

    const C = (k) => X('col.' + k);
    const dist = [[C('rank'), C('chain'), C('store'), C('address'), C('district'), C('province'), C('department'), C('meters'), C('distance'), C('dir'), C('bearing'),
      C('relation'), C('toVerify'), C('approx'), C('lat'), C('lng'), C('id')]];
    res.rows.forEach((x) => {
      const s = x.store;
      dist.push([x.rank, chainName(s.chain), s.name, s.address || '', s.district || '', s.province || '', s.department || '', round1(x.meters), fmtDist(x.meters),
        x.dir ? dirShort(x.dir) : '', x.bearingDeg === null ? '' : round1(x.bearingDeg),
        x.sameChain === true ? t('analysis.relation.same') : x.sameChain === false ? t('analysis.relation.competitor') : '',
        yes(x.flags.toVerify), yes(x.flags.approx), s.lat, s.lng, s.id]);
    });

    const bands = rs.bands.slice();
    if (rs.beyond.total) bands.push(rs.beyond);
    const ringRows = [[t('analysis.ringTable.chain')].concat(bands.map(bandLabel), [t('analysis.ringTable.total')])];
    ringRows.push([t('analysis.summary.total')].concat(bands.map((b) => b.total), [rs.total]));
    if (rel) {
      ringRows.push([t('analysis.summary.same')].concat(bands.map((b) => b.sameChain), [bands.reduce((s, b) => s + b.sameChain, 0)]));
      ringRows.push([t('analysis.summary.comp')].concat(bands.map((b) => b.competitors), [bands.reduce((s, b) => s + b.competitors, 0)]));
    }
    const totals = {};
    bands.forEach((b) => Object.keys(b.byChain).forEach((id) => { totals[id] = (totals[id] || 0) + b.byChain[id]; }));
    const order = chainOrder();
    const chainIds = Object.keys(totals).sort((x, y) => totals[y] - totals[x] || (order[x] || 999) - (order[y] || 999));
    chainIds.forEach((id) => ringRows.push([chainName(id)].concat(bands.map((b) => b.byChain[id] || 0), [totals[id]])));
    if (cutNote) ringRows.push([cutNote]);
    ringRows.push([]);
    const ringHead2 = ringRows.length;
    ringRows.push([X('withinHead')].concat(rs.cumulative.map((c) => fmtRing(c.to))));
    ringRows.push([t('analysis.summary.total')].concat(rs.cumulative.map((c) => c.total)));
    chainIds.forEach((id) => ringRows.push([chainName(id)].concat(rs.cumulative.map((c) => c.byChain[id] || 0))));

    const params = [[X('concept'), X('value')],
      [X('ref'), refName(r)],
      [X('refType'), r.type === 'store' ? X('typeStore') : X('typePoint')],
      [X('refStoreId'), r.type === 'store' ? r.storeId : ''],
      [X('refChain'), r.chainId ? chainName(r.chainId) : '—'],
      [X('lat'), r.lat], [X('lng'), r.lng],
      [X('universe'), universe],
      [X('chainsIn'), chainNames(a.chains)],
      [X('toVerify'), a.includeToVerify ? X('yes') : X('no')],
      [X('closed'), X('closedExcluded')],
      [X('rings'), ringsInUse().map(fmtRing).join(', ') + (ringsCut().length ? X('ringsCutParam', { list: listText(ringsCut().map(fmtRing)) }) : '')],
      [X('date'), nowText()],
      [X('dataVersion'), dataVersion()],
      [X('source'), X('sourceText')],
      [X('method'), X('methodText')],
      [X('tool'), 'Mapa de Tiendas ' + MT.version]];
    return [
      { name: X('sheet.summary'), rows: summary, widths: [34, 44, 14, 12, 26], cells: cells, heads: heads },
      { name: X('sheet.distances'), rows: dist, widths: [6, 16, 34, 40, 20, 16, 16, 13, 11, 8, 10, 15, 12, 12, 11, 11, 18], filter: true,
        formats: { 7: '#,##0.0', 10: '0.0', 14: '0.000000', 15: '0.000000' } },
      { name: X('sheet.rings'), rows: ringRows, widths: [24].concat(bands.map(() => 15), [10]), heads: [0, ringHead2] },
      { name: X('sheet.params'), rows: params, widths: [34, 90], formats: { 1: '0.000000' } },
    ];
  }

  function sheetsB() {
    const b = st.b, C = (k, v) => X('colB.' + k, v), D = (k) => X('col.' + k);
    const ids = sortedChainIds(b.chains);
    // Chain and store first, the ids last (as the Distancias sheet); one header per column.
    const per = [[D('chain'), D('store'), D('address'), D('district'), D('province'), D('department'),
      C('nearestSame'), C('nearestSameDistrict'), C('sameMeters'), C('sameText'),
      C('nearestComp'), C('nearestCompChain'), C('compMeters'), C('compText'),
      C('sameWithin', { d: fmtRing(b.radius) }), C('compWithin', { d: fmtRing(b.radius) })]
      .concat(ids.map((id) => C('chainWithin', { chain: chainName(id), d: fmtRing(b.radius) })), [D('toVerify'), D('approx'), D('lat'), D('lng'), D('id'), C('nearestSameId'), C('nearestCompId')])];
    // The tab's order: nearest same-chain store first (stores without one last), then id.
    const key = (r) => (r.nearestSame ? r.nearestSame.meters : Infinity);
    const rows = b.rows.slice().sort((x, y) => (key(x) === key(y) ? 0 : key(x) < key(y) ? -1 : 1) || (x.store.id < y.store.id ? -1 : 1));
    rows.forEach((r) => {
      const s = r.store, ns = r.nearestSame, nc = r.nearestCompetitor;
      per.push([chainName(s.chain), s.name, s.address || '', s.district || '', s.province || '', s.department || '',
        ns ? ns.store.name : '', ns ? ns.store.district || '' : '', ns ? round1(ns.meters) : '', ns ? fmtDist(ns.meters) : '',
        nc ? nc.store.name : '', nc ? chainName(nc.store.chain) : '', nc ? round1(nc.meters) : '', nc ? fmtDist(nc.meters) : '',
        r.sameWithin, r.competitorsWithin]
        .concat(ids.map((id) => r.byChainWithin[id] || 0), [yes(s.status === 'to_verify'), yes(s.precision === 'approx'), s.lat, s.lng, s.id, ns ? ns.store.id : '', nc ? nc.store.id : '']));
    });
    const pairs = [[C('tag'), C('storeA'), C('chainA'), C('districtA'), C('storeB'), C('chainB'), C('districtB'), D('meters'), D('distance'), D('relation'), C('inRegion'), C('idA'), C('idB')]];
    b.pairs.forEach((p) => {
      pairs.push([p.sameChain ? t('analysis.matrix.tag') : '', p.a.name, chainName(p.a.chain), p.a.district || '', p.b.name, chainName(p.b.chain), p.b.district || '',
        round1(p.meters), fmtDist(p.meters), p.sameChain ? t('analysis.relation.same') : t('analysis.relation.competitor'),
        b.inRegion.has(p.a.id) && b.inRegion.has(p.b.id) ? X('yes') : X('no'), p.a.id, p.b.id]);
    });
    const pc = b.pairCounts || { same: 0, comp: 0, total: 0 };
    const params = [[X('concept'), X('value')],
      [X('region'), districtNames(b.districts)],
      [X('storesRegion'), b.rows.length],
      [X('chainsIn'), chainNames(b.chains)],
      [X('radius'), fmtRing(b.radius) + ' (' + b.radius + ' m)'],
      [X('threshold'), fmtRing(b.threshold) + ' (' + b.threshold + ' m)'],
      [X('samePairs'), pc.same],
      [X('compPairs'), b.showComp ? pc.comp : '—']];
    if (b.pairs.length < pc.total) params.push([X('pairsListed'), X('pairsListedText', { shown: fmtNum(b.pairs.length), total: fmtNum(pc.total) })]);
    params.push(
      [X('showComp'), b.showComp ? X('yes') : X('no')],
      [X('neighbors'), b.neighbors ? X('yes') : X('no')],
      [X('toVerify'), b.includeToVerify ? X('yes') : X('no')],
      [X('closed'), X('closedExcluded')],
      [X('date'), nowText()],
      [X('dataVersion'), dataVersion()],
      [X('source'), X('sourceText')],
      [X('method'), X('methodText')],
      [X('tool'), 'Mapa de Tiendas ' + MT.version]);
    const fm = { 8: '#,##0.0', 12: '#,##0.0' };
    fm[per[0].length - 6] = '0.000000'; fm[per[0].length - 5] = '0.000000';
    return [
      { name: X('sheet.byStore'), rows: per, filter: true, formats: fm,
        widths: [16, 34, 40, 20, 16, 16, 34, 20, 16, 14, 34, 16, 16, 14, 14, 14].concat(ids.map(() => 14), [12, 12, 11, 11, 18, 18, 18]) },
      { name: X('sheet.pairs'), rows: pairs, filter: true, formats: { 7: '#,##0.0' }, widths: [24, 34, 16, 20, 34, 16, 20, 13, 11, 15, 12, 18, 18] },
      { name: X('sheet.params'), rows: params, widths: [40, 90] },
    ];
  }

  function exportXlsx() {
    let sheets, base;
    if (st.mode === 'distance') {
      if (!st.a.ref || !st.a.res || !st.a.res.rows.length) return Promise.resolve(null);
      sheets = sheetsA();
      base = X('fileA', { ref: refName(st.a.ref) });
    } else {
      if (!st.b.rows || !st.b.rows.length) return Promise.resolve(null);
      sheets = sheetsB();
      base = X('fileB', { region: regionName() });
    }
    const name = MT.io.datedName(base, 'xlsx');
    const busy = MT.ui.busy({ title: X('working') });
    return writeBook(sheets).then((blob) => {
      busy.close();
      MT.io.download(blob, name);
      MT.ui.toast(X('done', { name: name }), { type: 'success' });
      return name;
    }, (err) => {
      busy.close();
      console.warn('[analysis] xlsx failed', err);
      MT.ui.toast(X('error'), { type: 'error' });
      return null;
    });
  }

  /* =========================================================================================
   * Slides (SPEC §6.3)
   * ======================================================================================= */
  /** {districts, chains, analysis} of a slide showing the current mode A analysis. */
  function slideConfig() {
    const a = st.a, r = a.ref;
    let rings = a.rings.slice(), maxMeters, districts = [];
    if (a.uniKind === 'distance') {
      maxMeters = a.uniMeters;
      rings = ringsInUse().slice(-MAX_RINGS);       // the rings the tab shows: ≤ the universe, plus it
    } else {
      if (a.uniKind === 'districts') districts = a.districts.slice();
      maxMeters = rings[rings.length - 1];
    }
    const chains = {};
    MT.data.chains().forEach((c) => { chains[c.id] = a.chains.has(c.id); });
    return {
      districts: districts, chains: chains,
      analysis: { kind: 'distance', ref: savedRef(r), rings: rings, maxMeters: maxMeters, chains: sortedChainIds(a.chains),
        showLines: a.showLines, listTop: a.listTop, includeToVerify: a.includeToVerify },
    };
  }
  /**
   * The project's only slide while it is still untouched (a new project: no title, Peso, manual
   * subtitle, districts, radius, analysis, hidden stores or dragged logos) — "Agregar como lámina"
   * fills it instead of leaving an empty first slide in the deck. null otherwise.
   */
  function blankOnlySlide() {
    const maps = MT.project.maps();
    if (maps.length !== 1) return null;
    const m = maps[0];
    const untouched = !m.title && !m.peso && !(m.subtitleAuto === false && m.subtitle) && !(m.districts || []).length && !(m.radius || []).length
      && !m.analysis && !(m.hiddenStores || []).length && !Object.keys(m.markerOffsets || {}).length;
    return untouched ? m : null;
  }
  function addAsSlide() {
    const a = st.a;
    if (!a.ref || !a.chains || !a.chains.size || !a.res || !a.res.rows.length) return null;
    const cfg = slideConfig();
    cfg.title = a.ref.label || '';
    const blank = blankOnlySlide();
    let m;
    if (blank) {
      m = MT.project.updateMap(blank.id, Object.assign(cfg, { subtitleAuto: true, subtitle: '', view: null }));
      MT.project.select(blank.id);
    } else m = MT.project.addMap(cfg);
    st.linked = m.id;
    renderMain();
    MT.app.showTab('maps');
    MT.ui.toast(t('analysis.actions.slideAdded', { title: m.title || t('analysis.actions.untitled') }), { type: 'success' });
    return m;
  }
  function updateSlide() {
    const a = st.a, m = st.linked ? MT.project.getMap(st.linked) : null;
    if (!m) { st.linked = null; renderMain(); MT.ui.toast(t('analysis.actions.slideGone'), { type: 'warn' }); return null; }
    if (!a.ref || !a.res || !a.res.rows.length) return null;
    const out = MT.project.updateMap(m.id, slideConfig());
    MT.ui.toast(t('analysis.actions.slideUpdated', { title: m.title || t('analysis.actions.untitled') }), { type: 'success' });
    return out;
  }
  /**
   * Load a slide's analysis (Mapas → "Editar en Análisis"). x = a map id or a map config (the
   * project's current version of that slide is used when it still exists).
   */
  function edit(x) {
    const id = typeof x === 'string' ? x : x && x.id;
    const m = (id && MT.project.getMap(id)) || (x && typeof x === 'object' ? x : null);
    if (!m) { MT.ui.toast(t('analysis.actions.slideGone'), { type: 'warn' }); return false; }
    const an = m.analysis && MT.project.normalizeAnalysis(m.analysis);
    const ref = an ? AN().resolveRef(an.ref) : null;
    if (!ref) { MT.ui.toast(t('analysis.actions.slideNoAnalysis'), { type: 'warn' }); return false; }
    const a = st.a;
    if ((m.districts || []).length) { a.uniKind = 'districts'; a.districts = m.districts.slice(); }
    else { a.uniKind = 'distance'; a.lastDist = 'distance'; a.uniMeters = an.maxMeters; }
    a.rings = cleanRings(an.rings).length ? cleanRings(an.rings) : DEFAULT_RINGS.slice();
    a.chains = new Set(MT.data.chains().filter((c) => MT.data.chainOn(m, c.id)).map((c) => c.id));
    a.chainsTouched = true;
    a.showLines = an.showLines !== false;
    a.listTop = numOr(an.listTop, 8, 0, TOP_MAX);
    a.includeToVerify = an.includeToVerify !== false;
    st.linked = m.id && MT.project.getMap(m.id) ? m.id : null;
    st.mode = 'distance';
    saveSettings();
    if (MT.app.currentTab() !== 'analysis') MT.app.showTab('analysis');
    if (st.mounted) { renderHead(); renderSide(); }
    setRef(ref);
    return true;
  }

  /* =========================================================================================
   * Events
   * ======================================================================================= */
  const dataChanged = U.debounce(() => {
    searchIdx = null;
    if (!st.mounted) return;
    if (st.mode === 'distance') { computeA(); if (st.side.refCard) { renderRefCard(); renderUniverseA(); } renderMain(); }
    else { renderHead(); scheduleB(0); }
  }, 80);
  MT.bus.on('stores:changed', dataChanged);
  MT.bus.on('chains:changed', () => { searchIdx = null; if (st.mounted) { renderSide(); dataChanged(); } });
  MT.bus.on('logos:changed', () => {
    if (st.map && st.mapReady) st.badges.forEach((id) => { if (st.map.hasImage('mta-b-' + id)) st.map.removeImage('mta-b-' + id); });
    st.badges.clear();
    if (st.mounted) { st.a.ui = null; st.b.ui = null; renderSide(); renderMain(); }
  });
  MT.bus.on('lang:changed', () => { if (st.mounted) { closePopup(); renderAll(); } });
  MT.bus.on('project:loaded', () => { st.linked = null; if (st.mounted) renderMain(); });
  MT.bus.on('project:changed', (e) => {
    if (!st.mounted || !st.linked || (e && e.reason !== 'remove')) return;
    renderLinkBar();
    if (st.mode === 'distance') renderMainHeadA();
  });
  MT.bus.on('map:changed', (e) => { if (st.mounted && e && e.id === st.linked && e.keys.indexOf('title') >= 0) renderLinkBar(); });

  MT.app.registerTab({
    id: 'analysis', labelKey: 'tab.analysis', icon: 'target', order: 15, hash: 'analisis',
    mount: mount,
    onShow: function () {
      if (!st.mounted) return;
      requestAnimationFrame(() => {
        if (!st.map) initMap();
        else st.map.resize();
        if (st.pendingFit && st.mapReady) { st.pendingFit = false; if (st.mode === 'distance') fitA(false); else fitB(false); }
        if (st.a.table && st.mode === 'distance') st.a.table.refresh();
        if (st.b.table && st.mode === 'matrix') { st.b.table.refresh(); st.b.pairTable.refresh(); }
      });
    },
    onHide: function () { closePopup(); setPicking(false, true); if (st.tip) st.tip.remove(); closeTransient(); },
  });

  /* =========================================================================================
   * Public API
   * ======================================================================================= */
  function ensureMounted() { if (!st.mounted) MT.app.showTab('analysis'); }
  MT.analysisui = {
    edit: edit,
    open: edit,
    mode: () => st.mode,
    setMode: (m) => { ensureMounted(); setMode(m); },
    setReference: (x) => {
      ensureMounted();
      let ref = null;
      if (typeof x === 'string') ref = AN().refFromStore(x);
      else if (x && (x.type === 'store' || x.type === 'point' || x.storeId)) ref = AN().resolveRef(x);
      else if (x) ref = AN().refFromPoint(x);
      return setRef(ref);
    },
    setUniverse: (u) => {
      ensureMounted();
      u = u || {};
      if (Array.isArray(u.districts)) setUniverseA({ kind: 'districts', districts: u.districts });
      else if (u.all) setUniverseA({ kind: 'all' });
      else setUniverseA({ kind: 'distance', meters: u.meters || (u.km ? u.km * 1000 : st.a.uniMeters) });
      if (st.side.uniDist) renderUniverseA();
    },
    setChains: (ids) => { ensureMounted(); setChainsA(ids || []); },
    setRings: (list) => { ensureMounted(); setRingsA(list); },
    setOptions: (o) => {
      ensureMounted();
      o = o || {};
      const a = st.a;
      if (typeof o.includeToVerify === 'boolean') a.includeToVerify = o.includeToVerify;
      if (typeof o.showLines === 'boolean') a.showLines = o.showLines;
      if (o.listTop !== undefined) a.listTop = numOr(o.listTop, a.listTop, 0, TOP_MAX);
      if (st.mode === 'distance') renderSide();
      onParamsA();
    },
    setMatrix: (o) => {
      ensureMounted();
      o = o || {};
      const b = st.b;
      if (Array.isArray(o.districts)) b.districts = o.districts.slice();
      if (Array.isArray(o.chains)) b.chains = new Set(o.chains);
      if (o.radius > 0) b.radius = Math.round(o.radius);
      if (o.threshold > 0) b.threshold = U.clamp(Math.round(o.threshold), RING_MIN, PAIR_MAX);
      if (typeof o.showCompetitors === 'boolean') b.showComp = o.showCompetitors;
      if (typeof o.neighbors === 'boolean') b.neighbors = o.neighbors;
      if (typeof o.includeToVerify === 'boolean') b.includeToVerify = o.includeToVerify;
      if (st.mode !== 'matrix') setMode('matrix'); else renderSide();
      onParamsB({ fit: true });
      return whenIdleB();
    },
    results: () => (st.mode === 'distance'
      ? { mode: 'distance', ref: st.a.ref, res: st.a.res, ringSummary: st.a.ringSum, counts: Object.assign({}, st.a.counts) }
      : { mode: 'matrix', rows: st.b.rows, pairs: st.b.pairs, region: st.b.region, ms: st.b.ms }),
    select: (id) => (st.mode === 'distance' ? selectStoreA(id, { source: 'api' }) : selectStoreB(id, { source: 'api' })),
    selectPair: (i) => selectPair(String(i), { source: 'api' }),
    setPicking: (on) => { ensureMounted(); setPicking(on); },
    searchAddress: (q) => { ensureMounted(); if (st.mode !== 'distance') setMode('distance'); return searchAddress(q); },
    exportXlsx: exportXlsx,
    addAsSlide: addAsSlide,
    updateSlide: updateSlide,
    whenIdle: () => whenIdleB(),
    map: () => st.map,
    state: () => ({
      mounted: st.mounted, mode: st.mode, picking: st.picking, linked: st.linked, mapReady: st.mapReady,
      ref: st.a.ref ? savedRef(st.a.ref) : null,
      universe: { kind: st.a.uniKind, meters: st.a.uniMeters, districts: st.a.districts.slice() },
      chains: st.a.chains ? sortedChainIds(st.a.chains) : [], rings: st.a.rings.slice(), includeToVerify: st.a.includeToVerify,
      showLines: st.a.showLines, listTop: st.a.listTop, view: st.a.view, filter: st.a.filter,
      rows: st.a.res ? st.a.res.rows.length : 0, selected: st.a.selected, recent: st.recent.length,
      matrix: { districts: st.b.districts.slice(), chains: st.b.chains ? sortedChainIds(st.b.chains) : [], radius: st.b.radius, threshold: st.b.threshold,
        showComp: st.b.showComp, neighbors: st.b.neighbors, computing: st.b.computing, rows: st.b.rows ? st.b.rows.length : 0, pairs: st.b.pairs ? st.b.pairs.length : 0,
        view: st.b.view, selected: st.b.selected, selectedPair: st.b.selectedPair, ms: st.b.ms },
    }),
  };
})();
