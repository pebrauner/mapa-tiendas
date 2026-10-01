/* js/ui-maps.js — the "Mapas" tab (module M2): a PowerPoint-like workspace for the project's slides.
 *
 *   ┌ rail ───────────┬ centre ─────────────────────────────────┬ inspector ──────────────┐
 *   │ project (name,  │ bar: "Lámina 2 de 4" · title · stats ·  │ collapsible sections:   │
 *   │ save, menu)     │      ‹ › · Exportar ▾                   │ texts, districts,       │
 *   │ slide list with │ live 16:9 slide = MT.slide (M1)         │ chains, logos & legend, │
 *   │ thumbnails,     │ floating hint (no stores, dense map…)   │ framing, radius,        │
 *   │ drag / Alt+↑↓   │ store popup on 'store:click'            │ hidden stores           │
 *   └─────────────────┴─────────────────────────────────────────┴─────────────────────────┘
 *
 * Rules (docs/ARCHITECTURE.md §6.2): every write goes through MT.project.updateMap (text fields and
 * sliders are debounced and flushed on blur / Enter / map switch / Ctrl+S); the slide re-renders
 * itself on 'map:changed' (M1) and M2 calls MT.slide.render on 'map:selected'. Inspector controls
 * are built once per selected map and then synced in place, so typing never loses focus.
 * Exports call MT.export.* (M4) behind typeof guards. Strings: js/i18n/maps-ui.js ('maps.*').
 * Public helpers for tests / other modules: MT.mapsui (see the bottom of this file).
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util, h = U.h;
  const t = (k, v) => MT.t(k, v);
  const icon = (name, size) => MT.ui.icon(name, { size: size || 18 });
  const iconSpan = (name, size, cls) => h('span', { class: 'mt-icon' + (cls ? ' ' + cls : ''), html: icon(name, size) });

  const PRESET_METERS = [500, 1000, 2000];
  const DEFAULT_METERS = 1000;
  const MIN_M = 50, MAX_M = 50000;
  const DENSE = 120;            // markers on one slide above which we suggest dots / smaller logos
  const CHIP_LIMIT = 14;        // district chips shown before "+N más"

  // Lima Metropolitana zones (APEIM grouping) + Callao — quick presets for the district picker.
  const LIMA_ZONES = [
    { id: 'moderna', ubigeos: ['150104', '150113', '150114', '150116', '150120', '150121', '150122', '150130', '150131', '150136', '150140', '150141'] },
    { id: 'centro', ubigeos: ['150101', '150105', '150115', '150128', '150134'] },
    { id: 'norte', ubigeos: ['150102', '150106', '150110', '150112', '150117', '150125', '150135', '150139'] },
    { id: 'este', ubigeos: ['150103', '150107', '150109', '150111', '150118', '150132', '150137'] },
    { id: 'sur', ubigeos: ['150108', '150119', '150123', '150133', '150142', '150143'] },
    { id: 'balnearios', ubigeos: ['150124', '150126', '150127', '150129', '150138'] },
    { id: 'callao', ubigeos: ['070101', '070102', '070103', '070104', '070105', '070106', '070107'] },
  ];

  /* =========================================================================================
   * State
   * ======================================================================================= */
  const st = {
    mounted: false,
    els: {},
    secs: {},                    // section id → {el, head, body, summary, update, rebuild}
    open: Object.assign({ content: true, districts: true, chains: true }, MT.storage.pref('maps.sections', {}) || {}),
    thumbs: {},                  // map id → <canvas> (kept across list re-renders)
    counts: {},                  // map id → markers on the slide (from MT.layout.compute)
    stats: {},                   // map id → layout stats from 'mapview:layout'
    popup: null,                 // store popup {el, storeId, mapId}
    pop: null,                   // open popover (export)
    exporting: false,
    dismissed: {},               // 'mapId:kind' → true (hints the user closed)
    chipsExpanded: false,
    radiusOpen: {},              // storeId → results list expanded
    iconCache: {},               // 'chainId|px' → data URI of the badge icon
    ubigeoCounts: null,          // ubigeo → stores (all chains), for the district search
    pointerAt: 0,                // last pointerdown (to tell mouse from keyboard)
  };

  function cur() { return MT.project.currentMap(); }
  function curId() { return MT.project.currentMapId(); }

  /* ---- Debounced writes ---------------------------------------------------------------------
   * commit(id, patch, ms) merges patches for one map and writes them after `ms`; flush() writes
   * now. now(patch) flushes, then writes immediately to the current map. */
  const pending = { id: null, patch: null, timer: 0 };
  function commit(id, patch, ms) {
    if (!id) return;
    if (pending.id && pending.id !== id) flush();
    pending.id = id;
    pending.patch = Object.assign(pending.patch || {}, patch);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(flush, ms === undefined ? 220 : ms);
  }
  function flush() {
    clearTimeout(pending.timer);
    if (!pending.id) return;
    const id = pending.id, patch = pending.patch;
    pending.id = null; pending.patch = null;
    if (MT.project.getMap(id)) MT.project.updateMap(id, patch);
  }
  /** Latest value of a key for the current map, including a not-yet-written debounced edit. */
  function latest(m, key) { return pending.id === m.id && pending.patch && key in pending.patch ? pending.patch[key] : m[key]; }
  function now(patch) {
    const m = cur();
    if (!m) return null;
    flush();
    return MT.project.updateMap(m.id, patch);
  }

  /* =========================================================================================
   * Small helpers
   * ======================================================================================= */
  function setVal(el, v) {
    v = v === null || v === undefined ? '' : String(v);
    if (document.activeElement !== el && el.value !== v) el.value = v;
  }
  function field(label, control, opts) {
    opts = opts || {};
    if (!control.id) control.id = U.uid('mt-maps-f');
    return h('div', { class: 'mt-field mt-maps-field' + (opts.className ? ' ' + opts.className : '') },
      label ? h('label', { class: 'mt-label', for: control.id }, label) : null,
      control,
      opts.hint ? h('div', { class: 'mt-hint' }, opts.hint) : null);
  }
  function note(iconName, text, tone) {
    return h('div', { class: 'mt-maps-note' + (tone ? ' mt-maps-note--' + tone : '') }, iconSpan(iconName, 16), h('span', null, text));
  }
  function linkBtn(label, onClick, title) {
    return h('button', { type: 'button', class: 'mt-maps-link', title: title || null, onclick: onClick }, label);
  }
  function iconBtn(name, label, onClick, cls) {
    return h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-btn--sm' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label, html: icon(name, 16), onclick: onClick });
  }
  function storeLabel(s) { return s ? (s.name || MT.data.chain(s.chain).name) : ''; }
  function fmtM(m) { return MT.i18n.formatDistance(m); }

  /** Chain badge icon (the same drawing as the map markers) as an <img>; cached per size. */
  function chainIcon(chainId, cssPx, cls) {
    const img = h('img', { class: 'mt-maps-cicon' + (cls ? ' ' + cls : ''), alt: '', width: cssPx, height: cssPx, draggable: 'false' });
    paintChainIcon(img, chainId, cssPx);
    return img;
  }
  function paintChainIcon(img, chainId, cssPx) {
    const px = Math.round(cssPx * Math.max(2, Math.min(3, window.devicePixelRatio || 1)));
    const key = chainId + '|' + px;
    if (st.iconCache[key]) { img.src = st.iconCache[key]; return; }
    const style = { kind: 'badge', size: 1 };
    const paint = () => {
      try {
        const url = MT.markers.icon(chainId, px, style).toDataURL('image/png');
        st.iconCache[key] = url;
        img.src = url;
      } catch (err) { /* canvas unavailable: keep the raw logo */ }
    };
    if (MT.markers.isReady([chainId], style)) { paint(); return; }
    img.src = MT.logos.get(chainId).badge;           // raw logo until the badge is decoded
    img.classList.add('is-raw');
    MT.markers.ready([chainId], style).then(() => { img.classList.remove('is-raw'); paint(); }, () => {});
  }

  /** Non-closed stores per ubigeo (all chains) — shown next to district search results. */
  function ubigeoCount(u) {
    if (!st.ubigeoCounts) {
      st.ubigeoCounts = {};
      MT.data.stores().forEach((s) => { if (s.ubigeo) st.ubigeoCounts[s.ubigeo] = (st.ubigeoCounts[s.ubigeo] || 0) + 1; });
    }
    return st.ubigeoCounts[u] || 0;
  }
  /** Stores of the map's region with every chain on (counts per chain in the chain list). */
  function regionStores(m) {
    const all = {};
    MT.data.chains().forEach((c) => { all[c.id] = true; });
    return MT.data.storesForMap(Object.assign({}, m, { chains: all }));
  }
  /** Markers on a slide (memoized by M1's layout). */
  function markerCount(m) {
    try { st.counts[m.id] = MT.layout.compute(m).length; } catch (err) { st.counts[m.id] = MT.data.storesForMap(m).length; }
    return st.counts[m.id];
  }

  /* =========================================================================================
   * Mount
   * ======================================================================================= */
  function mount(panel) {
    const els = st.els;
    els.rail = h('nav', { class: 'mt-maps__rail' });
    els.bar = h('div', { class: 'mt-maps-bar' });
    els.stage = h('div', { class: 'mt-maps__stage' });
    els.hint = h('div', { class: 'mt-maps-hintbox', role: 'status', 'aria-live': 'polite' });
    els.empty = h('div', { class: 'mt-maps__empty', hidden: true });
    els.center = h('section', { class: 'mt-maps__center' }, els.bar,
      h('div', { class: 'mt-maps__stagewrap' }, els.stage, els.hint, els.empty));
    els.inspector = h('aside', { class: 'mt-maps__inspector' });
    els.live = h('div', { class: 'mt-sr-only', 'aria-live': 'polite' });
    els.root = h('div', { class: 'mt-maps' }, els.rail, els.center, els.inspector, els.live);
    panel.appendChild(els.root);
    MT.slide.mount(els.stage);
    st.mounted = true;
    renderRail();
    renderBar();
    renderInspector();
    renderHints();
    renderEmpty();
    MT.slide.render(cur() || null);
    // A wheel zoom or a drag on the map moves the marker under an open popup: close it.
    els.stage.addEventListener('wheel', () => closePopup(), { passive: true });
  }

  function announce(text) {
    if (!st.els.live) return;
    st.els.live.textContent = '';
    setTimeout(() => { st.els.live.textContent = text; }, 30);
  }

  /* =========================================================================================
   * Rail: project header + slide list
   * ======================================================================================= */
  function renderRail() {
    const els = st.els, rail = els.rail;
    const hadFocus = rail.contains(document.activeElement);
    U.clear(rail);
    rail.setAttribute('aria-label', t('maps.rail.aria'));
    const p = MT.project.current();

    els.projName = h('button', { type: 'button', class: 'mt-maps-proj__name', title: t('project.renameHint'), onclick: renameProject }, p ? MT.project.displayName() : '');
    els.projState = h('div', { class: 'mt-maps-proj__state' });
    const menuBtn = h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-btn--sm', title: t('maps.rail.projectMenu'),
      'aria-label': t('maps.rail.projectMenu'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: icon('more', 16),
      onclick: (e) => projectMenu(e.currentTarget) });
    const saveBtn = iconBtn('save', t('project.save') + ' (Ctrl+S)', () => { flush(); MT.app.saveProject(); });
    rail.appendChild(h('div', { class: 'mt-maps-proj' },
      h('div', { class: 'mt-maps-proj__top' },
        h('span', { class: 'mt-maps-proj__label' }, t('maps.rail.project')),
        h('span', { class: 'mt-spacer' }), saveBtn, menuBtn),
      els.projName, els.projState));
    updateProjState();

    const maps = MT.project.maps();
    rail.appendChild(h('div', { class: 'mt-maps-rail__head' },
      h('span', { class: 'mt-maps-rail__title' }, t('maps.rail.slides')),
      h('span', { class: 'mt-maps-rail__count' }, String(maps.length)),
      h('span', { class: 'mt-spacer' }),
      iconBtn('plus', t('maps.rail.newSlide'), addSlide, 'mt-maps-rail__plus')));

    const curIdNow = curId();
    els.list = h('ol', { class: 'mt-maps-rail__list', 'aria-label': t('maps.rail.listAria') });
    maps.forEach((m, i) => els.list.appendChild(slideItem(m, i, m.id === curIdNow)));
    els.drop = h('div', { class: 'mt-maps-rail__drop', hidden: true, 'aria-hidden': 'true' });
    els.railScroll = h('div', { class: 'mt-maps-rail__scroll' }, els.list, els.drop,
      h('button', { type: 'button', class: 'mt-maps-rail__add', onclick: addSlide }, iconSpan('plus', 16), h('span', null, t('maps.rail.newSlide'))));
    rail.appendChild(els.railScroll);
    if (maps.length > 1) rail.appendChild(h('div', { class: 'mt-maps-rail__foot', title: t('maps.rail.reorderKeys') }, iconSpan('grip', 14), t('maps.rail.reorderHint')));
    bindList(els.list);
    if (hadFocus) focusActiveItem();
    scheduleThumbs(maps.map((m) => m.id));
  }

  function updateProjState() {
    const els = st.els, p = MT.project.current();
    if (!els.projState || !p) return;
    els.projName.textContent = MT.project.displayName();
    els.projName.classList.toggle('is-placeholder', !p.name);
    const dirty = MT.project.isDirty(), fn = MT.project.fileName();
    U.clear(els.projState);
    els.projState.className = 'mt-maps-proj__state' + (dirty ? ' is-dirty' : '');
    U.append(els.projState, [h('span', { class: 'mt-maps-proj__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'mt-truncate' }, dirty ? t('maps.rail.unsaved') : fn ? t('maps.rail.savedIn', { name: fn }) : t('maps.rail.saved'))]);
  }

  function slideMeta(m) {
    const nd = (m.districts || []).length;
    if (!nd) return t('maps.rail.noDistricts');
    const n = st.counts[m.id] !== undefined ? st.counts[m.id] : MT.data.storesForMap(m).length;
    return t('data.districts', { n: nd }) + ' · ' + t('data.stores', { n: n });
  }

  function slideItem(m, i, active) {
    const title = m.title || t('maps.slide.untitled');
    const main = h('button', {
      type: 'button', class: 'mt-maps-slide__main', tabindex: active ? '0' : '-1', 'aria-current': active ? 'true' : null,
      'aria-label': t('maps.rail.slideAria', { n: i + 1, title: title }), dataset: { id: m.id },
    },
    h('span', { class: 'mt-maps-slide__num', 'aria-hidden': 'true' }, String(i + 1)),
    h('span', { class: 'mt-maps-slide__body' },
      h('span', { class: 'mt-maps-slide__thumb' }, thumbFor(m.id)),
      h('span', { class: 'mt-maps-slide__title' + (m.title ? '' : ' is-empty') }, title),
      h('span', { class: 'mt-maps-slide__meta' }, slideMeta(m))));
    main.addEventListener('click', () => { flush(); MT.project.select(m.id); });
    const more = h('button', { type: 'button', class: 'mt-maps-slide__more', title: t('maps.rail.itemMenu'), 'aria-label': t('maps.rail.itemMenu') + ': ' + title,
      'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: active ? '0' : '-1', html: icon('more', 16),
      onclick: (e) => { e.stopPropagation(); slideMenu(e.currentTarget, m.id); } });
    return h('li', { class: 'mt-maps-slide' + (active ? ' is-active' : ''), draggable: 'true', dataset: { id: m.id } }, main, more);
  }

  /** Update one rail item in place (title, meta, aria) — no re-render while typing. */
  function updateItem(id) {
    const li = st.els.list && st.els.list.querySelector('.mt-maps-slide[data-id="' + CSS.escape(id) + '"]');
    const m = MT.project.getMap(id);
    if (!li || !m) return;
    const i = MT.project.maps().indexOf(m);
    const title = m.title || t('maps.slide.untitled');
    const tEl = li.querySelector('.mt-maps-slide__title');
    tEl.textContent = title;
    tEl.classList.toggle('is-empty', !m.title);
    li.querySelector('.mt-maps-slide__meta').textContent = slideMeta(m);
    li.querySelector('.mt-maps-slide__main').setAttribute('aria-label', t('maps.rail.slideAria', { n: i + 1, title: title }));
  }

  /** Reflect the current map in the list (classes, roving tabindex) and keep it in view. */
  function markActive() {
    if (!st.els.list) return;
    const id = curId();
    U.$$('.mt-maps-slide', st.els.list).forEach((li) => {
      const on = li.dataset.id === id;
      li.classList.toggle('is-active', on);
      const main = li.querySelector('.mt-maps-slide__main');
      main.tabIndex = on ? 0 : -1;
      if (on) main.setAttribute('aria-current', 'true'); else main.removeAttribute('aria-current');
      li.querySelector('.mt-maps-slide__more').tabIndex = on ? 0 : -1;
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
  }
  function focusActiveItem() {
    const b = st.els.list && st.els.list.querySelector('.mt-maps-slide.is-active .mt-maps-slide__main');
    if (b) b.focus({ preventScroll: false });
  }

  // Same menu as the top bar's ⋮ (MT.app owns it, so module entries such as the exports appear too).
  function projectMenu(anchor) {
    flush();
    MT.app.openProjectMenu(anchor, { align: 'start', minWidth: 236 });
  }
  function renameProject() {
    if (MT.project.current()) MT.app.renameProject();
  }

  function slideMenu(anchor, id) {
    const maps = MT.project.maps(), i = maps.findIndex((m) => m.id === id);
    MT.ui.menu(anchor, [
      { label: t('maps.slide.duplicate'), icon: 'copy', onClick: () => duplicateSlide(id) },
      { label: t('maps.slide.moveUp'), icon: 'up', shortcut: 'Alt+↑', disabled: i <= 0, onClick: () => moveSlide(id, i - 1) },
      { label: t('maps.slide.moveDown'), icon: 'down', shortcut: 'Alt+↓', disabled: i >= maps.length - 1, onClick: () => moveSlide(id, i + 1) },
      { separator: true },
      { label: t('maps.slide.delete'), icon: 'trash', danger: true, onClick: () => deleteSlide(id) },
    ], { align: 'start', minWidth: 210 });
  }

  function addSlide() {
    flush();
    MT.project.addMap();          // selects it: the inspector is rebuilt synchronously
    focusDistricts();
  }
  function duplicateSlide(id) {
    flush();
    MT.project.duplicateMap(id);   // selected + visible in the rail: no toast needed
  }
  function moveSlide(id, to) {
    flush();
    const n = MT.project.maps().length;
    to = U.clamp(to, 0, n - 1);
    if (!MT.project.moveMap(id, to)) return;
    const hadFocus = st.els.rail.contains(document.activeElement) || document.activeElement === document.body;
    MT.project.select(id);
    announce(t('maps.rail.moved', { n: to + 1 }));
    if (hadFocus) focusActiveItem();
  }
  function deleteSlide(id) {
    flush();
    const m = MT.project.getMap(id);
    if (!m) return Promise.resolve(false);
    const title = m.title || t('maps.slide.untitled');
    return MT.ui.confirm(t('maps.slide.deleteText', { title: title }), { title: t('maps.slide.deleteTitle'), okLabel: t('maps.slide.deleteOk'), danger: true })
      .then((ok) => {
        if (!ok) return false;
        const index = MT.project.maps().indexOf(m);
        const copy = U.clone(m);
        MT.project.removeMap(id);
        MT.ui.toast(t('maps.slide.deleted', { title: title }), {
          type: 'success', timeout: 7000,
          action: { label: t('common.undo'), onClick: () => { if (!MT.project.getMap(copy.id)) MT.project.addMap(copy, { index: index }); } },
        });
        if (!document.activeElement || document.activeElement === document.body) focusActiveItem();
        return true;
      });
  }

  /** Keyboard (arrows select, Alt+arrows reorder, Delete) and drag-and-drop on the slide list. */
  function bindList(list) {
    list.addEventListener('keydown', (e) => {
      const main = e.target.closest && e.target.closest('.mt-maps-slide__main');
      if (!main) return;
      const ids = MT.project.maps().map((m) => m.id);
      const i = ids.indexOf(main.dataset.id);
      if (i < 0) return;
      let to = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        if (e.altKey) { moveSlide(ids[i], i + d); return; }
        to = U.clamp(i + d, 0, ids.length - 1);
      } else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = ids.length - 1;
      else if (e.key === 'Delete') { e.preventDefault(); deleteSlide(ids[i]); return; }
      if (to === null) return;
      e.preventDefault();
      if (to === i) return;
      flush();
      MT.project.select(ids[to]);
      focusActiveItem();
    });

    let dragId = null, dropAt = -1;
    const endDrag = () => {
      dragId = null; dropAt = -1;
      if (st.els.drop) st.els.drop.hidden = true;
      U.$$('.mt-maps-slide.is-dragging', list).forEach((li) => li.classList.remove('is-dragging'));
      st.els.rail.classList.remove('is-sorting');
    };
    list.addEventListener('dragstart', (e) => {
      const li = e.target.closest && e.target.closest('.mt-maps-slide');
      if (!li) return;
      dragId = li.dataset.id;
      li.classList.add('is-dragging');
      st.els.rail.classList.add('is-sorting');
      closePopup();
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* some browsers refuse */ }
      }
    });
    list.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const lis = U.$$('.mt-maps-slide', list);
      let ins = lis.length;
      for (let k = 0; k < lis.length; k++) {
        const r = lis[k].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { ins = k; break; }
      }
      dropAt = ins;
      const drop = st.els.drop;
      const ref = lis[ins] || lis[lis.length - 1];
      if (!ref) return;
      const y = ins < lis.length ? ref.offsetTop - 4 : ref.offsetTop + ref.offsetHeight + 2;
      drop.style.top = y + 'px';
      drop.hidden = false;
    });
    list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget) && st.els.drop) st.els.drop.hidden = true; });
    list.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const ids = MT.project.maps().map((m) => m.id);
      const from = ids.indexOf(dragId), id = dragId, at = dropAt;
      endDrag();
      if (from < 0 || at < 0) return;
      const to = at > from ? at - 1 : at;
      if (to !== from) moveSlide(id, to);
    });
    list.addEventListener('dragend', endDrag);
  }

  /* ---- Thumbnails: the real slide drawing (MT.render.drawSlide) over a schematic map ------- */
  function thumbFor(id) {
    if (!st.thumbs[id]) st.thumbs[id] = h('canvas', { class: 'mt-maps-thumb', width: 320, height: 180, 'aria-hidden': 'true' });
    return st.thumbs[id];
  }
  function pruneThumbs() {
    const ids = {};
    MT.project.maps().forEach((m) => { ids[m.id] = true; });
    Object.keys(st.thumbs).forEach((id) => { if (!ids[id]) { delete st.thumbs[id]; delete st.counts[id]; delete st.stats[id]; } });
  }
  const thumbQ = new Set();
  let thumbTimer = 0;
  function scheduleThumbs(ids, ms) {
    ids.forEach((id) => thumbQ.add(id));
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(runThumbs, ms === undefined ? 160 : ms);
  }
  function runThumbs() {
    const ric = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 500 })
      : (fn) => setTimeout(() => fn({ timeRemaining: () => 12 }), 30);
    const step = (deadline) => {
      while (thumbQ.size) {
        const c = curId();
        const id = thumbQ.has(c) ? c : thumbQ.values().next().value;   // the visible slide first
        thumbQ.delete(id);
        try { drawThumb(id); } catch (err) { console.warn('[maps] thumbnail failed', err); }
        if (deadline.timeRemaining() < 5) break;
      }
      if (thumbQ.size) ric(step);
    };
    ric(step);
  }
  function drawThumb(id) {
    const m = MT.project.getMap(id), cv = st.thumbs[id];
    if (!m || !cv) return;
    const cssW = (cv.parentNode && cv.parentNode.clientWidth) || 168;
    const W = Math.round(cssW * Math.max(2, Math.min(3, window.devicePixelRatio || 1)));
    const items = MT.layout.compute(m);
    st.counts[id] = items.length;
    const rows = MT.legend.items(m, items);
    const style = MT.layout.styleOf(m);
    const g = MT.slide.layout(m, W, rows);
    const mapImg = schematicMap(m, items, Math.max(1, Math.round(g.frame.w)), Math.max(1, Math.round(g.frame.h)));
    const H = Math.round(g.H);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    MT.render.drawSlide(ctx, m, W, mapImg, g);
    cv.dataset.drawn = '1';
    updateItem(id);
    const ids = rows.map((r) => r.chainId);
    if (!MT.markers.isReady(ids, style) && !cv.dataset.waiting) {
      cv.dataset.waiting = '1';
      MT.markers.ready(ids, style).then(() => { delete cv.dataset.waiting; scheduleThumbs([id], 0); }, () => { delete cv.dataset.waiting; });
    }
  }
  /** A light "map" for the thumbnail: district shapes, radius circles and store dots. */
  function schematicMap(m, items, w, hgt) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hgt;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#E6E9EC';
    ctx.fillRect(0, 0, w, hgt);
    const F = MT.layout.frame(), s = w / F.width;
    const proj = MT.layout.projector(MT.layout.viewFor(m));
    const trace = (ring) => {
      let lx = null, ly = null;
      ring.forEach((c, i) => {
        const p = proj(c), x = p.x * s, y = p.y * s;
        if (i && Math.abs(x - lx) < 0.6 && Math.abs(y - ly) < 0.6) return;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        lx = x; ly = y;
      });
      ctx.closePath();
    };
    if ((m.districts || []).length && MT.data.districts.available) {
      ctx.beginPath();
      MT.data.districts.features(m.districts).features.forEach((f) => {
        const g = f.geometry;
        if (!g) return;
        (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).forEach((poly) => poly.forEach(trace));
      });
      ctx.fillStyle = '#FAFAFA'; ctx.fill();
      ctx.lineWidth = Math.max(0.7, w / 300); ctx.strokeStyle = '#B7BEC7'; ctx.stroke();
    }
    MT.radius.features(m).features.forEach((f) => {
      ctx.beginPath(); trace(f.geometry.coordinates[0]);
      ctx.globalAlpha = 0.16; ctx.fillStyle = f.properties.color; ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = Math.max(0.8, w / 260); ctx.strokeStyle = f.properties.stroke; ctx.stroke();
    });
    const r = Math.max(1.4, w / 150);
    items.forEach((it) => {
      ctx.beginPath(); ctx.arc(it.anchor.x * s, it.anchor.y * s, r, 0, Math.PI * 2);
      ctx.fillStyle = MT.markers.dotColor(it.chainId, m); ctx.fill();
      ctx.lineWidth = r * 0.5; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
    });
    return cv;
  }

  /* =========================================================================================
   * Centre: bar, hints, empty state
   * ======================================================================================= */
  function renderBar() {
    const els = st.els;
    U.clear(els.bar);
    els.barInfo = h('div', { class: 'mt-maps-bar__info' });
    els.prev = iconBtn('chevronLeft', t('maps.bar.prev'), () => stepSlide(-1));
    els.next = iconBtn('chevronRight', t('maps.bar.next'), () => stepSlide(1));
    els.exportLabel = h('span', null, t('maps.bar.export'));
    els.exportIcon = h('span', { class: 'mt-icon', html: icon('download', 18) });
    els.exportBtn = h('button', { type: 'button', class: 'mt-btn mt-btn--primary mt-maps-bar__export', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: (e) => openExport(e.currentTarget) }, els.exportIcon, els.exportLabel, h('span', { class: 'mt-icon mt-maps-bar__caret', html: icon('chevronDown', 16) }));
    els.nav = h('div', { class: 'mt-maps-bar__nav' }, els.prev, els.next);
    U.append(els.bar, [els.barInfo, els.nav, els.exportBtn]);
    updateBar();
  }
  function updateBar() {
    const els = st.els;
    if (!els.barInfo) return;
    const maps = MT.project.maps(), m = cur();
    const i = m ? maps.indexOf(m) : -1;
    U.clear(els.barInfo);
    if (m) {
      const items = (() => { try { return MT.layout.compute(m); } catch (err) { return []; } })();
      st.counts[m.id] = items.length;
      const chains = new Set(items.map((x) => x.chainId)).size;
      U.append(els.barInfo, [
        h('span', { class: 'mt-maps-bar__pos' }, t('maps.bar.position', { n: i + 1, total: maps.length })),
        h('span', { class: 'mt-maps-bar__title' + (m.title ? '' : ' is-empty') }, m.title || t('maps.slide.untitled')),
        (m.districts || []).length ? h('span', { class: 'mt-maps-bar__stats' },
          h('span', null, t('data.stores', { n: items.length })), h('span', { class: 'mt-maps-bar__dot', 'aria-hidden': 'true' }),
          h('span', null, t('maps.bar.chains', { n: chains }))) : null,
      ]);
    }
    els.prev.disabled = i <= 0;
    els.next.disabled = i < 0 || i >= maps.length - 1;
    els.nav.hidden = maps.length < 2;
    els.exportBtn.disabled = !maps.length || st.exporting;
  }
  function stepSlide(d) {
    const maps = MT.project.maps(), i = maps.indexOf(cur());
    const to = maps[i + d];
    if (!to) return;
    flush();
    MT.project.select(to.id);
  }

  /** The most useful hint for the current slide (or null). */
  function hintFor(m) {
    if (!m || MT.data.missing.stores || !(m.districts || []).length) return null;
    const visible = MT.data.storesForMap(m).length;
    if (!visible) {
      const chains = MT.data.chains();
      if (chains.length && chains.every((c) => !MT.data.chainOn(m, c.id))) {
        return { kind: 'chainsOff', tone: 'warn', icon: 'warning', text: t('maps.hint.chainsOff'), actions: [{ label: t('maps.hint.chainsOn'), onClick: () => setChains(chains.map((c) => c.id), true) }] };
      }
      if (m.onlyInside !== false) {
        const near = MT.data.storesForMap(Object.assign({}, m, { onlyInside: false, view: null })).length;
        if (near) return { kind: 'nearby', tone: 'info', icon: 'info', text: t('maps.hint.nearby', { n: near }), actions: [{ label: t('maps.hint.includeNearby'), onClick: () => now({ onlyInside: false }) }] };
      }
      return { kind: 'noneHere', tone: 'info', icon: 'info', text: t('maps.hint.noneHere'), actions: [{ label: t('maps.hint.goDb'), onClick: () => MT.app.showTab('db') }] };
    }
    const style = MT.layout.styleOf(m);
    const n = st.counts[m.id] !== undefined ? st.counts[m.id] : markerCount(m);
    let dots = 0;
    try { const lay = MT.layout.compute(m); dots = (lay.stats && lay.stats.collapsed) || 0; } catch (e) { dots = 0; }
    const crowded = dots >= Math.max(3, n * 0.05);
    if ((n > DENSE || crowded) && (style.kind === 'badge' || style.kind === 'card') && !st.dismissed[m.id + ':dense']) {
      const actions = [];
      // Grouping switched off on a crowded slide: offer it first (it keeps the logos).
      if (MT.layout.groupMode(m) === false) actions.push({ label: t('maps.hint.group'), onClick: () => now({ groupNearby: 'auto' }) });
      if (style.size > 0.75) actions.push({ label: t('maps.hint.smaller'), onClick: () => now({ markerSize: Math.max(0.6, U.round(style.size - 0.2, 2)) }) });
      actions.push({ label: t('maps.hint.useDots'), onClick: () => now({ markerStyle: 'dot' }) });
      const text = crowded ? t('maps.hint.crowded', { n: dots, total: n }) : t('maps.hint.dense', { n: n });
      return { kind: 'dense', tone: crowded ? 'warn' : 'info', icon: 'sliders', text: text, actions: actions, dismiss: true };
    }
    return null;
  }
  function renderHints() {
    const box = st.els.hint;
    if (!box) return;
    const m = cur();
    const hint = hintFor(m);
    const key = hint ? hint.kind + '|' + hint.text + '|' + MT.i18n.lang : '';
    if (box.dataset.key === key) return;            // unchanged: no flicker while typing
    box.dataset.key = key;
    U.clear(box);
    box.hidden = !hint;
    if (!hint) return;
    box.appendChild(h('div', { class: 'mt-maps-hint mt-maps-hint--' + hint.tone, dataset: { kind: hint.kind } },
      h('span', { class: 'mt-maps-hint__icon', html: icon(hint.icon, 18) }),
      h('span', { class: 'mt-maps-hint__text' }, hint.text),
      h('span', { class: 'mt-maps-hint__actions' }, hint.actions.map((a, k) => h('button', { type: 'button', class: 'mt-btn mt-btn--sm ' + (k ? 'mt-btn--ghost' : 'mt-btn--secondary'), onclick: a.onClick }, a.label))),
      hint.dismiss ? h('button', { type: 'button', class: 'mt-maps-hint__x', title: t('maps.hint.dismiss'), 'aria-label': t('maps.hint.dismiss'), html: icon('close', 16),
        onclick: () => { st.dismissed[m.id + ':' + hint.kind] = true; renderHints(); } }) : null));
  }

  function renderEmpty() {
    const els = st.els;
    const none = !MT.project.maps().length;
    els.empty.hidden = !none;
    els.stage.classList.toggle('is-hidden', none);
    els.root.classList.toggle('is-empty', none);
    U.clear(els.empty);
    if (none) {
      // "Crear lámina" + the built-in example (4 slides like the reference deck).
      const example = MT.app.exampleAvailable && MT.app.exampleAvailable()
        ? MT.ui.button({ label: t('project.example.button'), icon: 'slides', kind: 'secondary', className: 'mt-maps__example', onClick: () => MT.app.openExampleProject() }) : null;
      els.empty.appendChild(MT.ui.emptyState({ icon: 'slides', title: t('maps.empty.title'), text: t('maps.empty.text'),
        action: h('div', { class: 'mt-maps__empty-actions' },
          MT.ui.button({ label: t('maps.empty.action'), icon: 'plus', kind: 'primary', onClick: addSlide }), example) }));
    }
  }

  /* =========================================================================================
   * Inspector: collapsible sections
   * ======================================================================================= */
  const SECTIONS = [
    { id: 'content', icon: 'edit', build: buildContent, summary: (m) => '' },
    { id: 'districts', icon: 'pin', build: buildDistricts, summary: (m) => (m.districts.length ? String(m.districts.length) : '') },
    { id: 'chains', icon: 'store', build: buildChains, summary: chainsSummary },
    { id: 'markers', icon: 'layers', build: buildMarkers, summary: (m) => t('maps.markers.styleName.' + MT.layout.styleOf(m).kind) },
    { id: 'map', icon: 'map', build: buildFraming, summary: (m) => (m.view ? t('maps.map.viewManualShort') : '') },
    { id: 'radius', icon: 'target', build: buildRadius, summary: (m) => (m.radius.length ? String(m.radius.length) : '') },
    { id: 'hidden', icon: 'eyeOff', build: buildHidden, summary: (m) => (m.hiddenStores.length ? String(m.hiddenStores.length) : '') },
  ];
  function chainsSummary(m) {
    const list = MT.data.chains();
    if (!list.length) return '';
    return t('maps.chains.summary', { on: list.filter((c) => MT.data.chainOn(m, c.id)).length, total: list.length });
  }

  function renderInspector(keepScroll) {
    const box = st.els.inspector;
    const scroll = box.scrollTop;
    U.clear(box);
    st.secs = {};
    box.setAttribute('aria-label', t('maps.inspector.aria'));
    const m = cur();
    if (!m) { box.appendChild(h('div', { class: 'mt-maps-insp__none' }, t('maps.inspector.none'))); return; }
    SECTIONS.forEach((def) => {
      const s = buildSection(def, m);
      st.secs[def.id] = s;
      box.appendChild(s.el);
    });
    box.scrollTop = keepScroll ? scroll : 0;
  }

  function buildSection(def, m) {
    const open = !!st.open[def.id];
    const bodyId = 'mt-maps-sec-' + def.id;
    const title = t('maps.sec.' + def.id);
    const summary = h('span', { class: 'mt-maps-sec__summary' });
    const head = h('button', { type: 'button', class: 'mt-maps-sec__head', 'aria-expanded': String(open), 'aria-controls': bodyId },
      h('span', { class: 'mt-maps-sec__icon', html: icon(def.icon, 16) }),
      h('span', { class: 'mt-maps-sec__title' }, title),
      summary,
      h('span', { class: 'mt-maps-sec__chev', html: icon('chevronDown', 16) }));
    const body = h('div', { class: 'mt-maps-sec__body', id: bodyId, role: 'region', 'aria-label': title, hidden: !open });
    const el = h('section', { class: 'mt-maps-sec' + (open ? ' is-open' : ''), dataset: { sec: def.id } }, h('h3', { class: 'mt-maps-sec__h' }, head), body);
    head.addEventListener('click', () => setSection(def.id, head.getAttribute('aria-expanded') !== 'true'));
    const sec = { id: def.id, el: el, head: head, body: body, summary: summary, api: null };
    sec.rebuild = () => { U.clear(body); sec.api = def.build(body, cur() || m) || {}; };
    sec.update = (map, keys) => {
      try { if (sec.api.update) sec.api.update(map, keys); } catch (err) { console.warn('[maps] section ' + def.id, err); }
      const s = def.summary(map);
      summary.textContent = s;
      summary.classList.toggle('is-count', /^\d+$/.test(s));
    };
    sec.rebuild();
    sec.update(m, null);
    return sec;
  }
  function setSection(id, open) {
    st.open[id] = !!open;
    MT.storage.setPref('maps.sections', st.open);
    const s = st.secs[id];
    if (!s) return;
    s.el.classList.toggle('is-open', !!open);
    s.head.setAttribute('aria-expanded', String(!!open));
    s.body.hidden = !open;
  }
  function syncInspector(m, keys) {
    Object.keys(st.secs).forEach((id) => st.secs[id].update(m, keys));
  }

  /* ---- Section: slide text (title, subtitle, peso) ------------------------------------------ */
  function buildContent(body) {
    const title = h('input', { class: 'mt-input', type: 'text', placeholder: t('maps.content.titlePh'), autocomplete: 'off', maxlength: '160', dataset: { field: 'title' } });
    title.addEventListener('input', () => commit(curId(), { title: title.value }));
    // New slides have an empty title (the field and the rail show a placeholder in the current
    // language). A placeholder stored by an older version, in any language, is selected on focus
    // so typing replaces it. (Re-checked in the frame callback: a fast typist may already have typed.)
    const isUntitled = () => MT.project.isPlaceholder(title.value, 'project.untitledMap');
    title.addEventListener('focus', () => { if (isUntitled()) requestAnimationFrame(() => { if (isUntitled() && document.activeElement === title) title.select(); }); });
    commitKeys(title);

    const autoSw = MT.ui.switchEl({ label: t('maps.content.subtitleAuto'), onChange: (on) => toggleAuto(on) });
    autoSw.classList.add('mt-maps-subswitch');
    const autoInput = autoSw.querySelector('input');
    autoInput.dataset.field = 'subtitleAuto';
    const autoBox = h('div', { class: 'mt-maps-subauto' });
    const sub = h('input', { class: 'mt-input', type: 'text', placeholder: t('maps.content.subtitlePh'), autocomplete: 'off', maxlength: '260', dataset: { field: 'subtitle' } });
    sub.addEventListener('input', () => commit(curId(), { subtitle: sub.value }));
    commitKeys(sub);
    const manual = h('div', { class: 'mt-maps-submanual' }, sub, h('div', { class: 'mt-hint' }, t('maps.content.subtitleHint')));
    const subLabel = h('span', { class: 'mt-label', id: U.uid('mt-maps-sublbl') }, t('maps.content.subtitle'));
    sub.setAttribute('aria-labelledby', subLabel.id);

    const peso = h('input', { class: 'mt-input mt-maps-peso', type: 'text', placeholder: t('maps.content.pesoPh'), autocomplete: 'off', maxlength: '40', dataset: { field: 'peso' } });
    peso.addEventListener('input', () => commit(curId(), { peso: peso.value }));
    commitKeys(peso);

    U.append(body, [
      field(t('maps.content.title'), title),
      h('div', { class: 'mt-field mt-maps-field' }, subLabel, autoSw, autoBox, manual),
      field(t('maps.content.peso'), peso, { hint: t('maps.content.pesoHint') }),
    ]);

    function toggleAuto(on) {
      const m = cur();
      if (!m) return;
      if (on) { now({ subtitleAuto: true }); return; }
      // Manual: start from the automatic text so the user only abbreviates what they need.
      const auto = MT.data.subtitleFor(Object.assign({}, m, { subtitleAuto: true }));
      now({ subtitleAuto: false, subtitle: latest(m, 'subtitle') || auto });   // shows the input synchronously
      sub.focus();
      const n = sub.value.length;
      sub.setSelectionRange(n, n);
    }
    return {
      update(m) {
        setVal(title, latest(m, 'title'));
        const auto = m.subtitleAuto !== false;
        autoInput.checked = auto;
        autoBox.hidden = !auto;
        manual.hidden = auto;
        const s = MT.data.subtitleFor(Object.assign({}, m, { subtitleAuto: true }));
        autoBox.textContent = s || t('maps.content.subtitleEmpty');
        autoBox.classList.toggle('is-empty', !s);
        setVal(sub, latest(m, 'subtitle'));
        setVal(peso, latest(m, 'peso'));
      },
    };
  }
  function commitKeys(input) {
    input.addEventListener('blur', flush);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); } });
  }

  /* ---- Generic combobox (inline results list under an input) -------------------------------
   * cfg: {options(query) → [{…, disabled}], render(option, i) → <li>, onPick(option),
   *       openWhenEmpty: bool, onRefresh(options, query)} */
  function combobox(input, list, cfg) {
    let opts = [], active = -1;
    const enabled = (i) => opts[i] && !opts[i].disabled;
    function setActive(i) {
      active = i;
      U.$$('[role="option"]', list).forEach((li, k) => {
        li.classList.toggle('is-active', k === i);
        li.setAttribute('aria-selected', String(k === i));
      });
      const li = list.children[i];
      if (li && i >= 0) { input.setAttribute('aria-activedescendant', li.id); if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    let moved = false;   // the user chose a row with ↑/↓ (Enter then picks it even when ambiguous)
    function refresh() {
      const q = input.value;
      moved = false;
      const open = !!q.trim() || cfg.openWhenEmpty;
      opts = open ? (cfg.options(q) || []) : [];
      U.clear(list);
      opts.forEach((o, i) => {
        const li = cfg.render(o, i);
        li.id = list.id + '-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        if (o.disabled) li.setAttribute('aria-disabled', 'true');
        li.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the input
        li.addEventListener('click', () => pick(i));
        list.appendChild(li);
      });
      list.hidden = !opts.length;
      input.setAttribute('aria-expanded', String(!!opts.length));
      let first = -1;
      for (let k = 0; k < opts.length; k++) if (enabled(k)) { first = k; break; }
      setActive(first);
      if (cfg.onRefresh) cfg.onRefresh(opts, q, open);
    }
    function move(d) {
      if (!opts.length) return;
      let i = active;
      for (let k = 0; k < opts.length; k++) { i = (i + d + opts.length) % opts.length; if (enabled(i)) break; }
      moved = true;
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
    input.addEventListener('focus', () => { if (input.value.trim() || cfg.openWhenEmpty) refresh(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) refresh(); else move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        if (!list.hidden && active >= 0) {
          e.preventDefault();
          // Several equally good matches ("San Juan"): do not guess — ask the user to choose.
          if (!moved && cfg.ambiguous && cfg.ambiguous(opts, active)) { if (cfg.onAmbiguous) cfg.onAmbiguous(); return; }
          pick(active);
        }
      } else if (e.key === 'Escape') {
        if (!list.hidden || input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; close(); }
        if (cfg.onEscape) cfg.onEscape(e);
      }
    });
    return { refresh: refresh, close: close, isOpen: () => !list.hidden };
  }

  /* ---- Section: districts ---------------------------------------------------------------------- */
  function buildDistricts(body) {
    const D = MT.data.districts;
    if (!D.available) {
      body.appendChild(note('warning', t('maps.districts.unavailable'), 'warn'));
      return { update() {} };
    }
    const listId = U.uid('mt-maps-dres');
    const input = h('input', { class: 'mt-input', type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': listId, 'aria-label': t('maps.districts.searchLabel'), placeholder: t('maps.districts.searchPh'),
      autocomplete: 'off', spellcheck: 'false', dataset: { field: 'districtSearch' } });
    const results = h('ul', { class: 'mt-maps-results', id: listId, role: 'listbox', 'aria-label': t('maps.districts.resultsAria'), hidden: true });
    const noRes = h('div', { class: 'mt-maps-results__empty', hidden: true });
    const start = h('div', { class: 'mt-maps-start' },
      h('span', { class: 'mt-maps-start__icon', html: icon('pin', 18) }),
      h('div', null, h('div', { class: 'mt-maps-start__title' }, t('maps.districts.startTitle')), h('div', { class: 'mt-maps-start__text' }, t('maps.districts.startText'))));
    const zones = LIMA_ZONES.map((z) => ({ id: z.id, ubigeos: z.ubigeos.filter((u) => D.get(u)) })).filter((z) => z.ubigeos.length);
    const presets = zones.length ? h('button', { type: 'button', class: 'mt-btn mt-btn--secondary mt-btn--sm mt-maps-presets', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      title: t('maps.districts.presetsAria'), onclick: (e) => presetMenu(e.currentTarget) },
    iconSpan('layers', 15), h('span', null, t('maps.districts.presets')), iconSpan('chevronDown', 14)) : null;
    const removeAll = linkBtn(t('maps.districts.removeAll'), clearAll);
    const chips = h('div', { class: 'mt-chips mt-maps-chips', role: 'list', 'aria-label': t('maps.sec.districts') });
    U.append(body, [
      start,
      h('div', { class: 'mt-maps-combo' }, h('div', { class: 'mt-input-group mt-maps-search' }, iconSpan('search', 16), input), results, noRes),
      h('div', { class: 'mt-maps-row mt-maps-row--tools' }, presets, h('span', { class: 'mt-spacer' }), removeAll),
      chips,
    ]);

    const combo = combobox(input, results, {
      options(q) {
        const m = cur();
        const have = new Set(m ? latest(m, 'districts') : []);
        const out = D.search(q, { limit: 8 }).map((d) => ({ kind: 'd', d: d, disabled: have.has(d.ubigeo) }));
        if (U.normalize(q).length >= 3) {
          D.searchProvinces(q, { limit: 2 }).forEach((p) => { if (p.ubigeos.length > 1) out.push({ kind: 'p', p: p }); });
        }
        return out;
      },
      render(o) {
        if (o.kind === 'p') {
          return h('li', { class: 'mt-maps-opt mt-maps-opt--province' },
            h('span', { class: 'mt-maps-opt__icon', html: icon('layers', 16) }),
            h('span', { class: 'mt-maps-opt__main' },
              h('span', { class: 'mt-maps-opt__name' }, t('maps.districts.province', { province: o.p.province })),
              h('span', { class: 'mt-maps-opt__sub' }, t('maps.districts.provinceSub', { department: o.p.department, n: o.p.ubigeos.length }))),
            h('span', { class: 'mt-maps-opt__count', html: icon('plus', 14) }));
        }
        const n = ubigeoCount(o.d.ubigeo);
        return h('li', { class: 'mt-maps-opt' + (o.disabled ? ' is-added' : ''), dataset: { ubigeo: o.d.ubigeo } },
          h('span', { class: 'mt-maps-opt__icon', html: icon(o.disabled ? 'check' : 'pin', 16) }),
          h('span', { class: 'mt-maps-opt__main' },
            h('span', { class: 'mt-maps-opt__name' }, o.d.district),
            h('span', { class: 'mt-maps-opt__sub' }, o.d.province + ', ' + o.d.department)),
          h('span', { class: 'mt-maps-opt__count' }, o.disabled ? t('maps.districts.already') : n ? t('data.stores', { n: n }) : ''));
      },
      onPick(o) {
        if (o.kind === 'p') addMany(o.p.ubigeos);
        else {
          const m = cur();
          const list = latest(m, 'districts');
          if (list.indexOf(o.d.ubigeo) < 0) now({ districts: list.concat(o.d.ubigeo) });
        }
        input.value = '';
        combo.close();
        input.focus();
      },
      onRefresh(opts, q, open) {
        noRes.hidden = !(open && q.trim() && !opts.length);
        noRes.textContent = t('maps.districts.noResults', { q: q.trim() });
      },
      // Enter does not guess between districts that match equally well (same score).
      ambiguous(opts, i) {
        const a = opts[i], b = opts.slice(i + 1).find((o) => o.kind === 'd' && !o.disabled);
        return !!(a && b && a.kind === 'd' && a.d.score === b.d.score);
      },
      onAmbiguous() {
        noRes.hidden = false;
        noRes.textContent = t('maps.districts.ambiguous');
        announce(t('maps.districts.ambiguous'));
      },
    });
    // (No "Backspace in the empty box removes the last chip": holding Backspace to clear the text
    // silently removed every district. Each chip has its own keyboard-accessible ×.)

    function addMany(list) {
      const m = cur();
      if (!m) return;
      const have = new Set(m.districts);
      const add = list.filter((u) => !have.has(u) && D.get(u));
      if (!add.length) { MT.ui.toast(t('maps.districts.nothingNew'), { type: 'info' }); return; }
      now({ districts: m.districts.concat(add) });
      announce(t('maps.districts.added', { n: add.length }));
    }
    function presetMenu(anchor) {
      MT.ui.menu(anchor, zones.map((z) => ({
        label: t('maps.districts.preset.' + z.id), hint: t('data.districts', { n: z.ubigeos.length }), icon: 'pin',
        onClick: () => addMany(z.ubigeos),
      })), { align: 'start', minWidth: 230 });
    }
    function clearAll() {
      const m = cur();
      if (!m || !m.districts.length) return;
      const go = () => { now({ districts: [] }); input.focus(); };
      if (m.districts.length < 4) { go(); return; }
      MT.ui.confirm(t('maps.districts.removeAllConfirm', { n: m.districts.length }), { okLabel: t('maps.districts.removeAll'), danger: true })
        .then((ok) => { if (ok) go(); });
    }
    function removeOne(u) {
      const m = cur();
      if (!m) return;
      const i = m.districts.indexOf(u);
      const hadFocus = chips.contains(document.activeElement);
      now({ districts: m.districts.filter((x) => x !== u) });   // re-renders the chips synchronously
      // Keep the keyboard where it was (next chip's ×, else the search box) — only if the removed
      // button had focus, and right now: a deferred focus() could steal it from wherever the user went.
      if (hadFocus && !chips.contains(document.activeElement)) {
        const xs = U.$$('.mt-chip__x', chips);
        (xs[Math.min(i, xs.length - 1)] || input).focus();
      }
    }

    const toolsRow = removeAll.parentNode;
    const api = {
      update(m) {
        const ds = m.districts || [];
        start.hidden = ds.length > 0;
        removeAll.hidden = ds.length < 2;
        toolsRow.hidden = !presets && ds.length < 2;
        const provinces = new Set(ds.map((u) => (D.get(u) || {}).province));
        const showSub = provinces.size > 1;
        U.clear(chips);
        const many = ds.length > CHIP_LIMIT + 2;
        const shown = many && !st.chipsExpanded ? ds.slice(0, CHIP_LIMIT) : ds;
        shown.forEach((u) => {
          const d = D.get(u);
          const name = d ? d.district : u;
          chips.appendChild(h('span', { class: 'mt-chip mt-maps-chip' + (d ? '' : ' is-unknown'), role: 'listitem', title: d ? d.label : u, dataset: { ubigeo: u } },
            h('span', { class: 'mt-chip__label' }, name),
            showSub && d ? h('span', { class: 'mt-chip__sub' }, d.province) : null,
            h('button', { type: 'button', class: 'mt-chip__x', 'aria-label': t('maps.districts.remove', { name: name }), title: t('maps.districts.remove', { name: name }),
              html: icon('close', 14), onclick: () => removeOne(u) })));
        });
        if (many) {
          chips.appendChild(h('button', { type: 'button', class: 'mt-maps-chipmore', onclick: () => { st.chipsExpanded = !st.chipsExpanded; api.update(cur()); } },
            st.chipsExpanded ? t('maps.districts.less') : t('maps.districts.more', { n: ds.length - CHIP_LIMIT })));
        }
        if (combo.isOpen()) combo.refresh();
      },
      focus() { input.focus(); },
    };
    return api;
  }

  /* ---- Section: chains -------------------------------------------------------------------------- */
  function buildChains(body) {
    const chains = MT.data.chains();
    if (!chains.length) {
      body.appendChild(note('warning', t('maps.chains.empty'), 'warn'));
      return { update() {} };
    }
    const rows = {};
    const groups = [];
    U.append(body, [
      h('div', { class: 'mt-maps-row mt-maps-chains__top' },
        h('span', { class: 'mt-hint mt-maps-chains__hint' }, t('maps.chains.hint')),
        h('span', { class: 'mt-maps-chains__all' },
          linkBtn(t('maps.chains.all'), () => setChains(MT.data.chains().map((c) => c.id), true)),
          h('span', { class: 'mt-maps-sep', 'aria-hidden': 'true' }, '·'),
          linkBtn(t('maps.chains.none'), () => setChains(MT.data.chains().map((c) => c.id), false)))),
    ]);
    MT.data.GROUPS.forEach((g) => {
      const list = chains.filter((c) => (c.group || 'other') === g);
      if (!list.length) return;
      const gname = t('data.group.' + g);
      const ids = list.map((c) => c.id);
      const cnt = h('span', { class: 'mt-maps-group__count' });
      body.appendChild(h('div', { class: 'mt-maps-group__head' },
        h('span', { class: 'mt-maps-group__name' }, gname), cnt, h('span', { class: 'mt-spacer' }),
        linkBtn(t('maps.chains.all'), () => setChains(ids, true), t('maps.chains.groupAll', { group: gname })),
        h('span', { class: 'mt-maps-sep', 'aria-hidden': 'true' }, '·'),
        linkBtn(t('maps.chains.none'), () => setChains(ids, false), t('maps.chains.groupNone', { group: gname }))));
      const box = h('div', { class: 'mt-maps-chainlist', role: 'group', 'aria-label': gname });
      list.forEach((c) => {
        const input = h('input', { type: 'checkbox', role: 'switch', class: 'mt-maps-chain__input', dataset: { chain: c.id } });
        input.addEventListener('change', () => setChains([c.id], input.checked));
        const count = h('span', { class: 'mt-maps-chain__count' });
        const row = h('label', { class: 'mt-maps-chain', dataset: { chain: c.id } },
          input,
          h('span', { class: 'mt-maps-chain__track', 'aria-hidden': 'true' }),
          chainIcon(c.id, 26, 'mt-maps-chain__logo'),
          h('span', { class: 'mt-maps-chain__name' }, c.name, c.unknown ? h('small', null, ' · ' + t('maps.chains.unknown')) : null),
          count);
        rows[c.id] = { input: input, count: count, row: row };
        box.appendChild(row);
      });
      body.appendChild(box);
      groups.push({ ids: ids, cnt: cnt });
    });
    return {
      update(m, keys) {
        const counts = MT.data.countsByChain(regionStores(m));
        Object.keys(rows).forEach((id) => {
          const r = rows[id], on = MT.data.chainOn(m, id), n = counts[id] || 0;
          r.input.checked = on;
          r.row.classList.toggle('is-off', !on);
          r.row.classList.toggle('is-zero', !n);
          r.count.textContent = String(n);
          r.count.title = t('maps.chains.count', { n: n });
        });
        groups.forEach((g) => { g.cnt.textContent = g.ids.filter((id) => MT.data.chainOn(m, id)).length + '/' + g.ids.length; });
      },
    };
  }
  function setChains(ids, on) {
    const m = cur();
    if (!m) return;
    const chains = Object.assign({}, m.chains);
    ids.forEach((id) => { chains[id] = !!on; });
    now({ chains: chains });
  }

  /* ---- Section: logos & legend ------------------------------------------------------------------- */
  function sampleChains(m) {
    let ids = [];
    try { ids = MT.legend.items(Object.assign({}, m, { legendSort: 'count' })).map((r) => r.chainId); } catch (err) { ids = []; }
    ['plazavea', 'tottus', 'wong', 'metro', 'mass'].forEach((id) => { if (MT.data.hasChain(id)) ids.push(id); });
    MT.data.chains().forEach((c) => ids.push(c.id));
    return Array.from(new Set(ids)).slice(0, 3);
  }
  // Marker positions in each style preview (CSS px in a 72 × 44 tile) and the marker height there.
  const PREVIEW = {
    badge: { h: 21, at: [[19, 27], [36, 18], [53, 28]] },
    card: { h: 13, at: [[28, 15], [45, 30]] },
    dot: { h: 9, at: [[16, 28], [27, 16], [39, 29], [50, 18], [58, 31]] },
    number: { h: 17, at: [[19, 27], [36, 18], [53, 28]] },
  };
  function drawStylePreview(cv, kind, ids) {
    const W = 72, H = 44, dpr = 2;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // A tiny map: soft land, two streets.
    ctx.fillStyle = '#ECEFF1';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, W, H, 6); else ctx.rect(0, 0, W, H);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-4, 34); ctx.lineTo(W + 4, 8); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(22, -4); ctx.lineTo(48, H + 4); ctx.stroke();
    if (!ids.length) return;
    const p = PREVIEW[kind], style = { kind: kind, size: 1 };
    p.at.forEach((pt, i) => {
      const id = ids[i % ids.length];
      const d = MT.markers.dims(id, style);
      const k = p.h / d.h;
      ctx.save();
      ctx.translate(pt[0], pt[1]);
      ctx.scale(k, k);
      MT.markers.drawMarker(ctx, id, 0, 0, style, { number: i + 1, shadow: true });
      ctx.restore();
    });
  }

  function buildMarkers(body) {
    const name = U.uid('mt-maps-style');
    const grid = h('div', { class: 'mt-maps-styles', role: 'radiogroup', 'aria-label': t('maps.markers.style') });
    const cards = {};
    MT.theme.marker.styles.forEach((k) => {
      const input = h('input', { type: 'radio', name: name, value: k, class: 'mt-maps-style__input', dataset: { style: k } });
      input.addEventListener('change', () => { if (input.checked) now({ markerStyle: k }); });
      const cv = h('canvas', { class: 'mt-maps-style__cv', 'aria-hidden': 'true' });
      grid.appendChild(h('label', { class: 'mt-maps-style', title: t('maps.markers.styleHint.' + k) }, input,
        h('span', { class: 'mt-maps-style__face' }, cv, h('span', { class: 'mt-maps-style__name' }, t('maps.markers.styleName.' + k)))));
      cards[k] = { input: input, cv: cv };
    });
    const hint = h('div', { class: 'mt-hint mt-maps-style__hint' });
    const d = MT.theme.marker.defaults;
    const range = h('input', { type: 'range', class: 'mt-range mt-maps-range', min: String(d.minSize), max: String(d.maxSize), step: '0.05', id: U.uid('mt-maps-size'), dataset: { field: 'markerSize' } });
    const out = h('output', { class: 'mt-maps-range__val', for: range.id });
    const pct = (v) => t('maps.markers.sizeValue', { n: Math.round(+v * 100) });
    range.addEventListener('input', () => { out.textContent = pct(range.value); commit(curId(), { markerSize: +range.value }, 140); });
    range.addEventListener('change', flush);
    const sort = MT.ui.segmented({ ariaLabel: t('maps.markers.sortLabel'), value: 'alpha',
      options: [{ value: 'alpha', label: t('maps.markers.sortAlpha') }, { value: 'count', label: t('maps.markers.sortCount') }],
      onChange: (v) => now({ legendSort: v }) });
    sort.classList.add('mt-seg--block');
    // Same-chain grouping (MT.layout, theme marker.declutter.aggregate): the switch shows whether it
    // applies now; 'auto' (default) decides by how crowded the slide is; a click fixes it on / off,
    // "Automático" goes back to deciding by itself.
    const group = MT.ui.switchEl({ label: t('maps.markers.group'), onChange: (v) => now({ groupNearby: v }) });
    group.querySelector('input').dataset.field = 'groupNearby';
    const groupHint = h('span', { class: 'mt-maps-group-hint' });
    const groupAuto = h('button', { type: 'button', class: 'mt-maps-link', dataset: { action: 'groupAuto' }, onclick: () => now({ groupNearby: 'auto' }) }, t('maps.markers.groupAuto'));
    U.append(body, [
      h('div', { class: 'mt-field mt-maps-field' }, h('span', { class: 'mt-label' }, t('maps.markers.style')), grid, hint),
      h('div', { class: 'mt-field mt-maps-field' },
        h('div', { class: 'mt-maps-field__row' }, h('label', { class: 'mt-label', for: range.id }, t('maps.markers.size')), out), range),
      h('div', { class: 'mt-maps-switchrow' }, group, h('div', { class: 'mt-hint' }, groupHint, ' ', groupAuto)),
      h('div', { class: 'mt-field mt-maps-field' }, h('span', { class: 'mt-label' }, t('maps.markers.sortLabel')), sort),
    ]);
    let previewKey = '';
    return {
      update(m) {
        const s = MT.layout.styleOf(m);
        Object.keys(cards).forEach((k) => { cards[k].input.checked = k === s.kind; });
        hint.textContent = t('maps.markers.styleHint.' + s.kind);
        const size = latest(m, 'markerSize');
        if (document.activeElement !== range) range.value = String(size);
        out.textContent = pct(document.activeElement === range ? range.value : size);
        sort.setValue(m.legendSort === 'count' ? 'count' : 'alpha');
        // Grouping: effective state from the slide's own layout.
        const logos = s.kind === 'badge' || s.kind === 'card';
        const mode = MT.layout.groupMode(m);
        let gs = null, eff = 0;
        try { const st = logos ? MT.layout.compute(m).stats || {} : {}; gs = st.grouping || null; eff = st.size || 0; } catch (err) { gs = null; }
        const gi = group.querySelector('input');
        gi.checked = logos && (mode === true || (mode === 'auto' && !!(gs && gs.on)));
        gi.disabled = !logos;
        group.classList.toggle('is-disabled', !logos);
        const counts = { n: gs ? gs.groups : 0, stores: gs ? gs.grouped : 0 };
        groupHint.textContent = !logos ? t('maps.markers.groupLogosOnly')
          : mode === false ? t('maps.markers.groupOff')
            : mode === true ? (counts.n ? t('maps.markers.groupOn', counts) : t('maps.markers.groupNone'))
              : gs && gs.on ? (counts.n ? t('maps.markers.groupAutoOn', counts) : t('maps.markers.groupNone')) : t('maps.markers.groupAutoOff');
        // A crowded slide draws its logos a little smaller (theme declutter.aggregate.autoSize).
        if (logos && eff && eff < s.size - 1e-6) groupHint.textContent += ' ' + t('maps.markers.groupSmaller', { n: Math.round(eff / s.size * 100) });
        groupAuto.hidden = !logos || mode === 'auto';
        const ids = sampleChains(m);
        const key = ids.join(',') + '|' + MT.layout.dataVersion();
        if (key !== previewKey) {
          previewKey = key;
          const paint = () => Object.keys(cards).forEach((k) => drawStylePreview(cards[k].cv, k, ids));
          paint();
          Promise.all([MT.markers.ready(ids, { kind: 'badge', size: 1 }), MT.markers.ready(ids, { kind: 'card', size: 1 })])
            .then(() => { if (previewKey === key) paint(); }, () => {});
        }
      },
    };
  }

  /* ---- Section: map framing ---------------------------------------------------------------------- */
  function buildFraming(body) {
    const inside = MT.ui.switchEl({ label: t('maps.map.onlyInside'), onChange: (v) => now({ onlyInside: v }) });
    inside.querySelector('input').dataset.field = 'onlyInside';
    const borders = MT.ui.switchEl({ label: t('maps.map.borders'), onChange: (v) => now({ showBorders: v }) });
    borders.querySelector('input').dataset.field = 'showBorders';
    const fit = MT.ui.segmented({ ariaLabel: t('maps.map.fitTo'), value: 'stores',
      options: [{ value: 'stores', label: t('maps.map.fitStores') }, { value: 'districts', label: t('maps.map.fitDistricts') }],
      onChange: (v) => now({ fitTo: v }) });
    fit.classList.add('mt-seg--block');
    const viewVal = h('span', { class: 'mt-maps-status__value' });
    const viewBtn = MT.ui.button({ label: t('maps.map.resetView'), icon: 'target', kind: 'secondary', size: 'sm', onClick: () => now({ view: null }) });
    const logosVal = h('span', { class: 'mt-maps-status__value' });
    const logosBtn = MT.ui.button({ label: t('maps.map.resetLogos'), icon: 'undo', kind: 'secondary', size: 'sm', onClick: () => now({ markerOffsets: {} }) });
    U.append(body, [
      h('div', { class: 'mt-maps-switchrow' }, inside, h('div', { class: 'mt-hint' }, t('maps.map.onlyInsideHint'))),
      h('div', { class: 'mt-maps-switchrow' }, borders),
      h('div', { class: 'mt-field mt-maps-field' }, h('span', { class: 'mt-label' }, t('maps.map.fitTo')), fit),
      h('div', { class: 'mt-maps-status' }, h('div', { class: 'mt-maps-status__main' }, h('span', { class: 'mt-maps-status__label' }, t('maps.map.view')), viewVal), viewBtn),
      h('div', { class: 'mt-maps-status' }, h('div', { class: 'mt-maps-status__main' }, h('span', { class: 'mt-maps-status__label' }, t('maps.map.logos')), logosVal), logosBtn),
      h('p', { class: 'mt-maps-tip' }, iconSpan('info', 15), h('span', null, t('maps.map.tip'))),
    ]);
    return {
      update(m) {
        inside.querySelector('input').checked = m.onlyInside !== false;
        borders.querySelector('input').checked = !!m.showBorders;
        fit.setValue(m.fitTo === 'districts' ? 'districts' : 'stores');
        viewVal.textContent = m.view ? t('maps.map.viewManual') : t('maps.map.viewAuto');
        viewVal.classList.toggle('is-manual', !!m.view);
        viewBtn.disabled = !m.view;
        const moved = Object.keys(m.markerOffsets || {}).length;
        logosVal.textContent = moved ? t('maps.map.logosMoved', { n: moved }) : t('maps.map.logosAuto');
        logosVal.classList.toggle('is-manual', !!moved);
        logosBtn.disabled = !moved;
      },
    };
  }

  /* ---- Section: radius circles --------------------------------------------------------------------- */
  function buildRadius(body) {
    const intro = h('p', { class: 'mt-maps-intro' }, t('maps.radius.intro'), ' ', h('span', { class: 'mt-maps-intro__tip' }, t('maps.radius.clickTip')));
    const list = h('div', { class: 'mt-maps-radii' });
    const listId = U.uid('mt-maps-sres');
    const pin = h('input', { class: 'mt-input mt-input--sm', type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': listId, 'aria-label': t('maps.radius.pickLabel'), placeholder: t('maps.radius.pickPh'), autocomplete: 'off', spellcheck: 'false',
      dataset: { field: 'radiusSearch' } });
    const presults = h('ul', { class: 'mt-maps-results mt-maps-results--stores', id: listId, role: 'listbox', 'aria-label': t('maps.radius.pickAria'), hidden: true });
    const pnone = h('div', { class: 'mt-maps-results__empty', hidden: true }, t('maps.radius.pickNone'));
    const picker = h('div', { class: 'mt-maps-picker', hidden: true },
      h('div', { class: 'mt-maps-picker__row' },
        h('div', { class: 'mt-input-group mt-maps-search' }, iconSpan('search', 15), pin),
        iconBtn('close', t('common.close'), () => closePicker())),
      presults, pnone);
    const addBtn = MT.ui.button({ label: t('maps.radius.add'), icon: 'plus', kind: 'secondary', size: 'sm', onClick: () => openPicker() });
    addBtn.dataset.action = 'addRadius';
    const xlsBtn = MT.ui.button({ label: t('maps.radius.exportXlsx'), icon: 'table', kind: 'ghost', size: 'sm', onClick: exportRadiusXlsx });
    xlsBtn.dataset.action = 'radiusXlsx';
    U.append(body, [intro, list, picker, h('div', { class: 'mt-maps-row mt-maps-row--actions' }, addBtn, h('span', { class: 'mt-spacer' }), xlsBtn)]);

    const pcombo = combobox(pin, presults, {
      openWhenEmpty: true,
      options(q) {
        const m = cur();
        if (!m) return [];
        const have = new Set(m.radius.map((r) => r.storeId));
        const words = U.normalize(q).split(' ').filter(Boolean);
        let stores = MT.data.storesForMap(m);
        if (words.length) {
          stores = stores.filter((s) => {
            const hay = U.normalize([s.name, MT.data.chain(s.chain).name, s.address, s.district].join(' '));
            return words.every((w) => hay.indexOf(w) >= 0);
          });
        }
        stores = U.sortBy(stores, (s) => MT.data.chain(s.chain).name + ' ' + (s.name || ''));
        return stores.slice(0, 40).map((s) => ({ s: s, disabled: have.has(s.id) }));
      },
      render(o) {
        return h('li', { class: 'mt-maps-opt mt-maps-opt--store' + (o.disabled ? ' is-added' : ''), dataset: { storeId: o.s.id } },
          chainIcon(o.s.chain, 22, 'mt-maps-opt__logo'),
          h('span', { class: 'mt-maps-opt__main' },
            h('span', { class: 'mt-maps-opt__name' }, storeLabel(o.s)),
            h('span', { class: 'mt-maps-opt__sub' }, [MT.data.chain(o.s.chain).name, o.s.district].filter(Boolean).join(' · '))),
          o.disabled ? h('span', { class: 'mt-maps-opt__count', html: icon('target', 14) }) : null);
      },
      onPick(o) { closePicker(); addRadius(o.s.id, DEFAULT_METERS); },
      onRefresh(opts, q, open) { pnone.hidden = !(open && !opts.length); },
      onEscape() { closePicker(); },
    });
    function openPicker() {
      picker.hidden = false;
      addBtn.hidden = true;
      pin.value = '';
      pin.focus();
      pcombo.refresh();
    }
    function closePicker() {
      picker.hidden = true;
      addBtn.hidden = false;
      pcombo.close();
    }

    const rows = new Map();
    return {
      update(m) {
        const results = MT.radius.compute(m);
        const byId = {};
        results.forEach((r) => { byId[r.storeId] = r; });
        const radius = latest(m, 'radius') || [];
        intro.hidden = radius.length > 0;
        xlsBtn.disabled = !results.length;
        const want = radius.map((r) => r.storeId);
        rows.forEach((row, id) => { if (want.indexOf(id) < 0) { row.el.remove(); rows.delete(id); } });
        radius.forEach((r, i) => {
          let row = rows.get(r.storeId);
          if (!row) { row = radiusRow(r.storeId); rows.set(r.storeId, row); }
          if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] || null);
          row.update(r, byId[r.storeId]);
        });
        if (!picker.hidden && pcombo.isOpen()) pcombo.refresh();
      },
    };
  }

  function radiusRow(storeId) {
    const iconBox = h('span', { class: 'mt-maps-radius__icon' });
    const name = h('div', { class: 'mt-maps-radius__name' });
    const sub = h('div', { class: 'mt-maps-radius__sub' });
    const rm = iconBtn('close', '', () => removeRadius(storeId), 'mt-maps-radius__rm');
    const meters = h('input', { class: 'mt-input mt-input--sm mt-input--num mt-maps-radius__m', type: 'number', min: String(MIN_M), max: String(MAX_M), step: '50',
      inputmode: 'numeric', dataset: { field: 'meters' } });
    const err = h('div', { class: 'mt-field__error', role: 'alert' });
    const chips = PRESET_METERS.map((v) => h('button', { type: 'button', class: 'mt-maps-mchip', dataset: { m: String(v) }, 'aria-pressed': 'false', onclick: () => setMeters(storeId, v) }, fmtM(v)));
    const stats = h('div', { class: 'mt-maps-radius__stats' });
    const toggle = h('button', { type: 'button', class: 'mt-maps-link mt-maps-radius__toggle', 'aria-expanded': 'false' });
    const table = h('div', { class: 'mt-maps-radius__list', hidden: true });
    const valid = (v) => isFinite(v) && v >= MIN_M && v <= MAX_M;
    const showErr = (on) => {
      meters.classList.toggle('is-invalid', on);
      err.textContent = on ? t('maps.radius.invalid', { min: MT.i18n.formatNumber(MIN_M), max: MT.i18n.formatNumber(MAX_M) }) : '';
    };
    meters.addEventListener('input', () => {
      const v = Math.round(+meters.value);
      if (!meters.value) return;
      if (!valid(v)) { showErr(true); return; }
      showErr(false);
      setMeters(storeId, v, true);
    });
    meters.addEventListener('change', () => {
      const v = Math.round(+meters.value);
      if (!valid(v)) { showErr(true); return; }
      showErr(false);
      setMeters(storeId, v);
    });
    meters.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); meters.dispatchEvent(new Event('change')); } });
    meters.addEventListener('blur', () => { if (!valid(+meters.value)) { showErr(false); const m = cur(); const r = m && m.radius.find((x) => x.storeId === storeId); if (r) meters.value = String(r.meters); } });
    toggle.addEventListener('click', () => {
      st.radiusOpen[storeId] = !st.radiusOpen[storeId];
      const m = cur();
      if (m) api.update(m.radius.find((r) => r.storeId === storeId) || { storeId: storeId, meters: DEFAULT_METERS }, MT.radius.compute(m).find((r) => r.storeId === storeId));
    });
    const mId = U.uid('mt-maps-m');
    meters.id = mId;
    const el = h('div', { class: 'mt-maps-radius', dataset: { storeId: storeId } },
      h('div', { class: 'mt-maps-radius__head' }, iconBox, h('div', { class: 'mt-maps-radius__who' }, name, sub), rm),
      h('div', { class: 'mt-maps-radius__ctl' },
        h('label', { class: 'mt-maps-radius__mwrap', for: mId }, h('span', { class: 'mt-maps-radius__mlabel' }, t('maps.radius.meters')), meters, h('span', { class: 'mt-maps-radius__unit' }, t('maps.radius.unit'))),
        h('div', { class: 'mt-maps-mchips' }, chips)),
      err, stats, table, toggle);
    let iconChain = null;
    const api = {
      el: el,
      update(r, res) {
        const s = MT.data.store(storeId);
        const label = s ? storeLabel(s) : storeId;
        name.textContent = label;
        sub.textContent = s ? [MT.data.chain(s.chain).name, s.district].filter(Boolean).join(' · ') : t('maps.radius.missingStore');
        el.classList.toggle('is-missing', !s);
        rm.title = t('maps.radius.remove', { name: label });
        rm.setAttribute('aria-label', rm.title);
        meters.setAttribute('aria-label', t('maps.radius.metersAria', { name: label }));
        if (s && iconChain !== s.chain) { iconChain = s.chain; U.clear(iconBox); iconBox.appendChild(chainIcon(s.chain, 30)); }
        if (document.activeElement !== meters) { meters.value = String(r.meters); showErr(false); }
        chips.forEach((c) => { const on = +c.dataset.m === +r.meters; c.classList.toggle('is-on', on); c.setAttribute('aria-pressed', String(on)); });
        U.clear(stats);
        el.classList.toggle('is-inactive', !res && !!s);
        if (!res) {
          toggle.hidden = true; table.hidden = true;
          // The centre store is not on the slide (hidden here, chain off, closed): no circle is
          // drawn anywhere, so say why and offer the fix.
          const m = cur(), why = s && m ? MT.radius.inactiveReason(m, storeId) : null;
          if (why) {
            const fix = why === 'hidden' ? linkBtn(t('maps.radius.showStore'), () => unhide(storeId))
              : why === 'chainOff' ? linkBtn(t('maps.radius.chainOn', { chain: MT.data.chain(s.chain).name }), () => {
                const mm = cur(); if (!mm) return; const ch = Object.assign({}, mm.chains); ch[s.chain] = true; now({ chains: ch });
              }) : null;
            U.append(stats, [h('span', { class: 'mt-maps-radius__off' }, iconSpan('eyeOff', 14), t('maps.radius.inactive.' + why)), fix]);
          }
          return;
        }
        const color = MT.radius.colorsFor(res.chainId).stroke;
        const same = h('span', { class: 'mt-maps-stat mt-maps-stat--same' }, h('i', { 'aria-hidden': 'true' }), t('maps.radius.same', { n: res.sameChain }));
        same.style.setProperty('--c', color);
        U.append(stats, [
          same,
          h('span', { class: 'mt-maps-stat mt-maps-stat--comp' }, h('i', { 'aria-hidden': 'true' }), t('maps.radius.competitors', { n: res.competitors })),
        ]);
        const n = res.inside.length;
        const open = !!st.radiusOpen[storeId] && n > 0;
        toggle.hidden = !n;
        toggle.textContent = open ? t('maps.radius.hideStores') : t('maps.radius.showStores', { n: n });
        toggle.setAttribute('aria-expanded', String(open));
        table.hidden = !open && n > 0;
        U.clear(table);
        if (!n) { table.hidden = false; table.appendChild(h('div', { class: 'mt-maps-radius__none' }, t('maps.radius.none'))); return; }
        if (!open) return;
        res.inside.forEach((x) => {
          table.appendChild(h('div', { class: 'mt-maps-rrow' + (x.sameChain ? ' is-same' : '') },
            chainIcon(x.store.chain, 20, 'mt-maps-rrow__logo'),
            h('span', { class: 'mt-maps-rrow__main' },
              h('span', { class: 'mt-maps-rrow__name' }, storeLabel(x.store)),
              h('span', { class: 'mt-maps-rrow__sub' }, MT.data.chain(x.store.chain).name + ' · ' + t(x.sameChain ? 'maps.radius.sameShort' : 'maps.radius.compShort'))),
            h('span', { class: 'mt-maps-rrow__d' }, fmtM(x.distance))));
        });
      },
    };
    return api;
  }

  function addRadius(storeId, meters) {
    const m = cur(), s = MT.data.store(storeId);
    if (!m || !s) return;
    const list = (latest(m, 'radius') || []).slice();
    const i = list.findIndex((r) => r.storeId === storeId);
    if (i >= 0) {
      if (list[i].meters === meters) return;
      list[i] = { storeId: storeId, meters: meters };
      now({ radius: list });
      announce(t('maps.radius.updated', { name: storeLabel(s), m: fmtM(meters) }));
    } else {
      list.push({ storeId: storeId, meters: meters });
      now({ radius: list });
      announce(t('maps.radius.added', { name: storeLabel(s), m: fmtM(meters) }));
    }
    setSection('radius', true);
  }
  function setMeters(storeId, meters, debounced) {
    const m = cur();
    if (!m) return;
    const list = (latest(m, 'radius') || []).map((r) => (r.storeId === storeId ? { storeId: storeId, meters: meters } : r));
    if (debounced) commit(m.id, { radius: list }, 450); else now({ radius: list });
  }
  function removeRadius(storeId) {
    const m = cur();
    if (!m) return;
    const before = U.clone(latest(m, 'radius') || []);
    now({ radius: before.filter((r) => r.storeId !== storeId) });
    MT.ui.toast(t('maps.radius.removed'), { type: 'info', action: { label: t('common.undo'), onClick: () => { const c = cur(); if (c && c.id === m.id) now({ radius: before }); } } });
  }
  function exportRadiusXlsx() {
    flush();
    const m = cur();
    if (!m) return Promise.resolve(null);
    const results = MT.radius.compute(m);
    if (!results.length) return Promise.resolve(null);
    const name = MT.io.datedName(t('maps.radius.fileBase', { title: m.title || MT.project.displayName() }), 'xlsx');
    return MT.io.writeXLSX([{ name: t('maps.radius.sheet'), rows: MT.radius.rows(results), colWidths: [30, 18, 10, 34, 18, 16, 12, 38, 20], numberColumns: [2, 6] }])
      .then((blob) => {
        MT.io.download(blob, name);
        MT.ui.toast(t('maps.radius.exported', { name: name }), { type: 'success' });
        return name;
      }, (err) => {
        console.warn('[maps] radius xlsx failed', err);
        MT.ui.toast(t('maps.radius.exportError'), { type: 'error' });
        return null;
      });
  }

  /* ---- Section: hidden stores ---------------------------------------------------------------------- */
  function buildHidden(body) {
    const empty = h('p', { class: 'mt-maps-intro' }, t('maps.hidden.empty'));
    const list = h('div', { class: 'mt-maps-hidden', role: 'list' });
    const all = MT.ui.button({ label: t('maps.hidden.showAll'), icon: 'eye', kind: 'ghost', size: 'sm', onClick: () => { now({ hiddenStores: [] }); announce(t('maps.hidden.restoredAll')); } });
    const foot = h('div', { class: 'mt-maps-row mt-maps-row--actions' }, h('span', { class: 'mt-spacer' }), all);
    U.append(body, [empty, list, foot]);
    return {
      update(m) {
        const ids = m.hiddenStores || [];
        empty.hidden = ids.length > 0;
        foot.hidden = ids.length < 2;
        U.clear(list);
        ids.forEach((id) => {
          const s = MT.data.store(id);
          const label = s ? storeLabel(s) : id;
          list.appendChild(h('div', { class: 'mt-maps-hrow', role: 'listitem', dataset: { storeId: id } },
            s ? chainIcon(s.chain, 24, 'mt-maps-hrow__logo') : h('span', { class: 'mt-maps-hrow__logo is-gone', html: icon('warning', 14) }),
            h('span', { class: 'mt-maps-hrow__main' },
              h('span', { class: 'mt-maps-hrow__name' }, label),
              h('span', { class: 'mt-maps-hrow__sub' }, s ? [MT.data.chain(s.chain).name, s.district].filter(Boolean).join(' · ') : t('maps.hidden.gone'))),
            h('button', { type: 'button', class: 'mt-btn mt-btn--secondary mt-btn--sm', 'aria-label': t('maps.hidden.showAria', { name: label }),
              onclick: () => unhide(id) }, iconSpan('eye', 15), h('span', null, t('maps.hidden.show')))));
        });
      },
    };
  }
  function unhide(id) {
    const m = cur();
    if (!m) return;
    now({ hiddenStores: m.hiddenStores.filter((x) => x !== id) });
    announce(t('maps.hidden.restored'));
  }
  function hideStore(id) {
    const m = cur(), s = MT.data.store(id);
    if (!m) return;
    if (m.hiddenStores.indexOf(id) >= 0) return;
    const prev = m.hiddenStores.slice();
    now({ hiddenStores: prev.concat(id) });
    MT.ui.toast(t('maps.popup.hidden', { name: storeLabel(s) || id }), {
      type: 'success', timeout: 6000,
      action: { label: t('common.undo'), onClick: () => { const c = MT.project.getMap(m.id); if (c) MT.project.updateMap(m.id, { hiddenStores: c.hiddenStores.filter((x) => x !== id) }); } },
    });
  }

  function focusDistricts() {
    setSection('districts', true);
    const s = st.secs.districts;
    if (!s) return;
    s.el.scrollIntoView({ block: 'nearest' });
    if (s.api && s.api.focus) s.api.focus();
  }

  /* =========================================================================================
   * Store popup (on 'store:click')
   * ======================================================================================= */
  function openPopup(ev) {
    const map = MT.project.getMap(ev.mapId), s = MT.data.store(ev.storeId);
    if (!map || !s || ev.mapId !== curId()) return;
    const viaKeyboard = Date.now() - st.pointerAt > 700;
    closePopup(true);
    const el = h('div', { class: 'mt-maps-pop', role: 'dialog', 'aria-label': t('maps.popup.aria'), tabindex: '-1', dataset: { storeId: s.id } });
    document.body.appendChild(el);
    st.popup = { el: el, storeId: s.id, mapId: map.id, rect: ev.rect || { left: ev.screen.x, right: ev.screen.x, top: ev.screen.y, bottom: ev.screen.y } };
    fillPopup();
    placePopup();
    requestAnimationFrame(() => el.classList.add('is-open'));
    MT.mapview.highlight(s.id);
    const first = el.querySelector('.mt-maps-pop__actions button, .mt-maps-pop__radius button');
    (viaKeyboard && first ? first : el).focus({ preventScroll: true });
  }
  function fillPopup() {
    const p = st.popup;
    if (!p) return;
    const map = MT.project.getMap(p.mapId), s = MT.data.store(p.storeId);
    if (!map || !s) { closePopup(); return; }
    const chain = MT.data.chain(s.chain);
    const radius = (map.radius || []).find((r) => r.storeId === s.id);
    const status = s.status || 'verified';
    const badges = [h('span', { class: 'mt-badge mt-badge--dot mt-badge--' + (status === 'verified' ? 'success' : status === 'closed' ? 'danger' : 'warn') }, t('data.status.' + status))];
    if (s.precision === 'approx') badges.push(h('span', { class: 'mt-badge' }, t('maps.popup.approx')));
    const rChips = PRESET_METERS.map((v) => h('button', { type: 'button', class: 'mt-maps-mchip' + (radius && radius.meters === v ? ' is-on' : ''), 'aria-pressed': String(!!(radius && radius.meters === v)),
      dataset: { m: String(v) }, onclick: () => { addRadius(s.id, v); fillPopup(); } }, v === DEFAULT_METERS && !radius ? t('maps.popup.addRadius', { m: fmtM(v) }) : fmtM(v)));
    const el = p.el;
    U.clear(el);
    U.append(el, [
      h('div', { class: 'mt-maps-pop__head' },
        chainIcon(s.chain, 38, 'mt-maps-pop__logo'),
        h('div', { class: 'mt-maps-pop__who' },
          h('div', { class: 'mt-maps-pop__chain' }, chain.name),
          h('div', { class: 'mt-maps-pop__name' }, storeLabel(s))),
        iconBtn('close', t('common.close'), () => closePopup(), 'mt-maps-pop__x')),
      s.address || s.district ? h('div', { class: 'mt-maps-pop__addr' }, iconSpan('pin', 14), h('span', null, [s.address, s.district].filter(Boolean).join(' · '))) : null,
      h('div', { class: 'mt-maps-pop__badges' }, badges),
      h('div', { class: 'mt-maps-pop__radius' },
        h('div', { class: 'mt-maps-pop__label' }, iconSpan('target', 14), h('span', null, radius ? t('maps.popup.radiusOn', { m: fmtM(radius.meters) }) : t('maps.popup.radiusTitle'))),
        h('div', { class: 'mt-maps-mchips' }, rChips,
          radius ? h('button', { type: 'button', class: 'mt-maps-link mt-maps-pop__rm', onclick: () => { removeRadius(s.id); fillPopup(); } }, t('maps.popup.removeRadius')) : null)),
      h('div', { class: 'mt-maps-pop__actions' },
        h('button', { type: 'button', class: 'mt-btn mt-btn--secondary mt-btn--sm', dataset: { action: 'hide' }, onclick: () => { const id = s.id; closePopup(); hideStore(id); } }, iconSpan('eyeOff', 15), h('span', null, t('maps.popup.hide'))),
        h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--sm', dataset: { action: 'edit' }, onclick: () => editInDb(s.id) }, iconSpan('edit', 15), h('span', null, t('maps.popup.edit')))),
    ]);
  }
  function placePopup() {
    const p = st.popup;
    if (!p) return;
    const el = p.el, r = p.rect, pad = 10, gap = 12;
    const w = el.offsetWidth, hgt = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = r.right + gap, top = (r.top + r.bottom) / 2 - hgt / 2, side = 'right';
    if (left + w > vw - pad) { left = r.left - gap - w; side = 'left'; }
    if (left < pad) {
      left = U.clamp((r.left + r.right) / 2 - w / 2, pad, vw - w - pad);
      top = r.bottom + gap; side = 'below';
      if (top + hgt > vh - pad) { top = r.top - gap - hgt; side = 'above'; }
    }
    top = U.clamp(top, pad, Math.max(pad, vh - hgt - pad));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.dataset.side = side;
  }
  function closePopup(silent) {
    const p = st.popup;
    if (!p) return;
    st.popup = null;
    p.el.remove();
    if (MT.mapview && MT.mapview.highlight) MT.mapview.highlight(null);
    if (!silent && p.el.contains(document.activeElement)) refocusMarker(p.storeId);
  }
  function refocusMarker(storeId) {
    const b = document.querySelector('.mt-marker-hit[data-store-id="' + CSS.escape(storeId) + '"]');
    if (b) b.focus({ preventScroll: true });
  }
  function editInDb(id) {
    closePopup(true);
    flush();
    MT.app.showTab('db');
    setTimeout(() => {
      try {
        if (MT.db && typeof MT.db.openStore === 'function') MT.db.openStore(id);
        else if (MT.dbui && typeof MT.dbui.openEditor === 'function') {
          if (typeof MT.dbui.select === 'function') MT.dbui.select(id, { source: 'api' });
          MT.dbui.openEditor(id);
        }
      } catch (err) { console.warn('[maps] could not open the store in the database tab', err); }
    }, 0);
  }
  document.addEventListener('pointerdown', (e) => {
    st.pointerAt = Date.now();
    if (st.popup && !st.popup.el.contains(e.target)) closePopup(true);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.popup && !document.body.classList.contains('mt-has-modal')) {
      const id = st.popup.storeId;
      e.preventDefault();
      closePopup(true);
      refocusMarker(id);
    }
    // Ctrl+S / Ctrl+O: write the debounced edit first (the app handles the shortcut itself).
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'o' || e.key === 'O')) flush();
  }, true);
  window.addEventListener('resize', () => { if (st.popup) closePopup(true); });
  // Closing / reloading the tab: write the debounced text edit, then the project autosave right
  // away (project.js flushes on these events too, but its listeners run before this one).
  const flushForUnload = () => { flush(); if (MT.project.flushAutosave) MT.project.flushAutosave(); };
  window.addEventListener('beforeunload', flushForUnload);
  window.addEventListener('pagehide', flushForUnload);
  // The app was opened in another tab and this one is being paused: write the edit first.
  MT.bus.on('app:paused', flush);

  /* =========================================================================================
   * Export (M4 APIs, guarded)
   * ======================================================================================= */
  function popover(anchor, content, opts) {
    const el = h('div', { class: 'mt-maps-popover' + (opts.className ? ' ' + opts.className : ''), role: 'dialog', 'aria-label': opts.label || null, tabindex: '-1' }, content);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
    const left = U.clamp(opts.align === 'end' ? r.right - w : r.left, 8, window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + hh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - hh - 8);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    const f = el.querySelector('input:checked, button:not([disabled])');
    (f || el).focus({ preventScroll: true });
    requestAnimationFrame(() => el.classList.add('is-open'));
    let closed = false;
    const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); } });
    // Focus leaving the popover closes it - also when it goes nowhere (Tab past the last option
    // lands on <body>): an orphaned panel would cover the slide and ignore Escape. A window
    // switch keeps the focused element, so the deferred check leaves the popover open then.
    el.addEventListener('focusout', (e) => {
      if (e.relatedTarget) { if (!el.contains(e.relatedTarget) && e.relatedTarget !== anchor) close(); return; }
      setTimeout(() => { if (!closed && !el.contains(document.activeElement)) close(); }, 0);
    });
    window.addEventListener('resize', close, { once: true });
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', onDown, true);
      anchor.setAttribute('aria-expanded', 'false');
      el.classList.remove('is-open');
      setTimeout(() => el.remove(), 140);
      if (st.pop && st.pop.el === el) st.pop = null;
    }
    return { el: el, close: close };
  }

  function openExport(anchor) {
    if (st.pop) { st.pop.close(); return; }
    flush();
    const maps = MT.project.maps();
    if (!maps.length) return;
    const ex = MT.theme.export;
    let scope = maps.length > 1 ? MT.storage.pref('maps.exportScope', 'current') : 'current';
    let slideW = MT.storage.pref('maps.exportSlideW', ex.slideWidth);
    let mapScale = MT.storage.pref('maps.exportMapScale', ex.mapScale);
    if (ex.slideWidths.indexOf(slideW) < 0) slideW = ex.slideWidth;
    if (ex.mapScales.indexOf(mapScale) < 0) mapScale = ex.mapScale;
    const scopeSeg = MT.ui.segmented({ ariaLabel: t('maps.export.scope'), value: scope,
      options: [{ value: 'current', label: t('maps.export.scopeCurrent') }, { value: 'all', label: t('maps.export.scopeAll', { n: maps.length }) }],
      onChange: (v) => { scope = v; MT.storage.setPref('maps.exportScope', v); } });
    scopeSeg.classList.add('mt-seg--block');
    if (maps.length < 2) { const all = scopeSeg.querySelector('input[value="all"]'); if (all) all.disabled = true; }
    const slideSeg = MT.ui.segmented({ ariaLabel: t('maps.export.resolution'), value: String(slideW),
      options: ex.slideWidths.slice().sort((a, b) => a - b).map((w) => ({ value: String(w), label: w + ' × ' + Math.round(w / MT.theme.slide.aspect) })),
      onChange: (v) => { slideW = +v; MT.storage.setPref('maps.exportSlideW', slideW); } });
    slideSeg.classList.add('mt-seg--compact');
    const mapSeg = MT.ui.segmented({ ariaLabel: t('maps.export.resolution'), value: String(mapScale),
      options: ex.mapScales.map((s) => ({ value: String(s), label: s + '×', title: Math.round(MT.layout.frame().width * s) + ' × ' + Math.round(MT.layout.frame().height * s) + ' px' })),
      onChange: (v) => { mapScale = +v; MT.storage.setPref('maps.exportMapScale', mapScale); } });
    mapSeg.classList.add('mt-seg--compact');
    const available = (fn) => !!(MT.export && typeof MT.export[fn] === 'function');
    const option = (kind, fn, iconName, title, ext, hint, extra) => {
      const b = h('button', { type: 'button', class: 'mt-maps-xopt', dataset: { export: kind }, disabled: !available(fn),
        onclick: () => { pop.close(); runExport(kind, { scope: scope, slideW: slideW, mapScale: mapScale }); } },
      h('span', { class: 'mt-maps-xopt__icon', html: icon(iconName, 20) }),
      h('span', { class: 'mt-maps-xopt__text' },
        h('span', { class: 'mt-maps-xopt__title' }, title, h('span', { class: 'mt-maps-xopt__ext' }, ext)),
        h('span', { class: 'mt-maps-xopt__hint' }, hint)));
      return h('div', { class: 'mt-maps-xrow' }, b,
        extra ? h('div', { class: 'mt-maps-xrow__extra' }, h('span', { class: 'mt-maps-xrow__lbl' }, t('maps.export.resolution')), extra) : null);
    };
    const content = h('div', { class: 'mt-maps-export' },
      h('div', { class: 'mt-maps-export__head' }, t('maps.export.title')),
      h('div', { class: 'mt-maps-export__scope' }, h('span', { class: 'mt-maps-export__lbl' }, t('maps.export.scope')), scopeSeg),
      option('pptx', 'pptx', 'slides', t('maps.export.pptx'), '.pptx', t('maps.export.pptxHint')),
      option('slidePng', 'png', 'image', t('maps.export.slidePng'), '.png', t('maps.export.slidePngHint'), slideSeg),
      option('mapPng', 'png', 'map', t('maps.export.mapPng'), '.png', t('maps.export.mapPngHint'), mapSeg),
      option('html', 'html', 'code', t('maps.export.html'), '.html', t('maps.export.htmlHint')),
      // M4's full dialog: pick any set of slides, see store counts per slide.
      MT.export && typeof MT.export.dialog === 'function' ? h('div', { class: 'mt-maps-export__foot' },
        h('button', { type: 'button', class: 'mt-maps-link', dataset: { action: 'exportDialog' }, onclick: () => {
          pop.close();
          // The dialog gives focus back to whatever had it when it opened: make that the
          // Exportar button, not this link (removed with the popover).
          if (st.els.exportBtn && st.els.exportBtn.isConnected) st.els.exportBtn.focus({ preventScroll: true });
          MT.export.dialog({ mapIds: scope === 'all' ? 'all' : curId() });
        } }, iconSpan('sliders', 15), h('span', null, t('maps.export.more')))) : null);
    const pop = popover(anchor, content, { align: 'end', label: t('maps.export.title') });
    st.pop = pop;
  }

  function setExporting(on) {
    st.exporting = on;
    const els = st.els;
    if (!els.exportBtn) return;
    els.exportBtn.classList.toggle('is-busy', on);
    els.exportBtn.setAttribute('aria-busy', String(on));
    els.exportLabel.textContent = on ? t('maps.bar.exporting') : t('maps.bar.export');
    els.exportIcon.innerHTML = on ? '<span class="mt-spinner mt-maps-bar__spin" aria-hidden="true"></span>' : icon('download', 18);
    updateBar();
  }
  /** Did M4 show its own toast during the export? (then M2 stays quiet) */
  function watchToasts() {
    let saw = false;
    const scan = (recs) => recs.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.classList && n.classList.contains('mt-toast')) saw = true; }));
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    const seen = () => { scan(mo.takeRecords()); return saw; };
    seen.stop = () => mo.disconnect();
    return seen;
  }
  function fileNames(res) {
    if (!res) return { n: 0, name: '' };
    const nm = (f) => (typeof f === 'string' ? f : (f && (f.name || f.filename)) || '');
    if (Array.isArray(res.files)) return { n: res.files.length, name: res.files.length === 1 ? nm(res.files[0]) : '' };
    if (res.file) return { n: 1, name: nm(res.file) };
    if (typeof res === 'string') return { n: 1, name: res };
    return { n: 0, name: '' };
  }
  async function runExport(kind, o) {
    flush();
    if (st.exporting) { MT.ui.toast(t('maps.export.busy'), { type: 'warn' }); return null; }
    const ids = o.scope === 'all' ? MT.project.maps().map((m) => m.id) : [curId()].filter(Boolean);
    if (!ids.length) { MT.ui.toast(t('maps.export.noMaps'), { type: 'warn' }); return null; }
    const api = MT.export || {};
    const opts = kind === 'slidePng' ? { kind: 'slide', width: o.slideW } : kind === 'mapPng' ? { kind: 'map', scale: o.mapScale } : {};
    // Prefer M4's UI-level runner (progress overlay + toasts, never rejects); else the format function.
    const format = kind === 'slidePng' ? 'slide' : kind === 'mapPng' ? 'map' : kind;
    const fn = typeof api.run === 'function' ? (ids2, op) => api.run(format, ids2, op)
      : kind === 'pptx' ? api.pptx : kind === 'html' ? api.html : api.png;
    if (typeof fn !== 'function') { MT.ui.toast(t('maps.export.notReady'), { type: 'info' }); return null; }
    closePopup(true);
    setExporting(true);
    const seen = watchToasts();
    try {
      const res = await fn.call(api, ids, opts);
      if (!seen()) {
        const f = fileNames(res);
        if (f.n === 1 && f.name) MT.ui.toast(t('maps.export.done', { name: f.name }), { type: 'success' });
        else if (f.n) MT.ui.toast(t('maps.export.doneMany', { n: f.n }), { type: 'success' });
      }
      return res;
    } catch (err) {
      const msg = (err && err.message) || '';
      if (err && (err.name === 'AbortError' || msg === 'aborted' || err.code === 'aborted')) return null;
      if (/not-implemented/.test(msg)) MT.ui.toast(t('maps.export.notReady'), { type: 'info' });
      else if (!seen() && !(err && err.shown)) {
        console.warn('[maps] export failed', err);
        MT.ui.toast(err && err.messageKey ? MT.t(err.messageKey) : t('maps.export.failed'), { type: 'error' });
      }
      return null;
    } finally {
      seen.stop();
      setExporting(false);
    }
  }

  /* =========================================================================================
   * Events
   * ======================================================================================= */
  function dataChanged(ev) {
    if (ev === 'stores:changed') st.ubigeoCounts = null;
    if (ev !== 'stores:changed') st.iconCache = {};
    st.counts = {};
    if (ev === 'chains:changed' && st.secs.chains) st.secs.chains.rebuild();
    const m = cur();
    if (m) syncInspector(m, null);
    scheduleThumbs(MT.project.maps().map((x) => x.id));
    updateBar();
    renderHints();
    if (st.popup) { if (MT.data.store(st.popup.storeId)) fillPopup(); else closePopup(true); }
  }

  MT.bus.on('project:loaded', () => {
    if (!st.mounted) return;
    flush();
    closePopup(true);
    st.dismissed = {};
    pruneThumbs();
    renderRail();
    updateBar();
    renderEmpty();
  });
  MT.bus.on('project:changed', (e) => {
    if (!st.mounted) return;
    if (e && e.reason === 'rename') { updateProjState(); return; }
    pruneThumbs();
    renderRail();
    updateBar();
    renderEmpty();
  });
  MT.bus.on('project:dirty', () => { if (st.mounted) updateProjState(); });
  MT.bus.on('project:saved', () => { if (st.mounted) updateProjState(); });
  MT.bus.on('map:selected', (e) => {
    if (!st.mounted) return;
    flush();
    closePopup(true);
    st.chipsExpanded = false;
    renderInspector();
    markActive();
    updateBar();
    renderHints();
    renderEmpty();
    MT.slide.render((e && e.map) || null);
  });
  MT.bus.on('map:changed', (e) => {
    if (!st.mounted || !e) return;
    delete st.counts[e.id];
    scheduleThumbs([e.id]);
    if (e.id !== curId()) { updateItem(e.id); return; }
    syncInspector(e.map, e.keys);
    updateBar();
    updateItem(e.id);
    renderHints();
    if (st.popup && e.keys.some((k) => ['hiddenStores', 'chains', 'districts', 'onlyInside', 'markerStyle', 'markerSize', 'view'].indexOf(k) >= 0)) closePopup(true);
    else if (st.popup && e.keys.indexOf('radius') >= 0) fillPopup();
  });
  ['stores:changed', 'chains:changed', 'logos:changed'].forEach((ev) => MT.bus.on(ev, () => { if (st.mounted) dataChanged(ev); }));
  MT.bus.on('mapview:layout', (e) => {
    if (!st.mounted || !e) return;
    st.stats[e.id] = e.stats || null;
    if (e.items) st.counts[e.id] = e.items.length;
    if (e.id === curId()) { updateBar(); renderHints(); }
    updateItem(e.id);
  });
  MT.bus.on('view:changed', () => closePopup(true));
  MT.bus.on('store:click', (e) => { if (st.mounted && e) openPopup(e); });
  MT.bus.on('tab:shown', (e) => { if (e && e.id !== 'maps') { closePopup(true); if (st.pop) st.pop.close(); } });
  MT.bus.on('lang:changed', () => {
    if (!st.mounted) return;
    closePopup(true);
    if (st.pop) st.pop.close();
    renderRail();
    renderBar();
    renderInspector(true);
    st.els.hint.dataset.key = '';
    renderHints();
    renderEmpty();
    scheduleThumbs(MT.project.maps().map((m) => m.id));
  });

  MT.app.registerTab({
    id: 'maps', labelKey: 'tab.maps', icon: 'map', order: 10, hash: 'mapas',
    mount: mount,
    onShow: function () {
      if (!st.mounted) return;
      MT.slide.resize();
      updateBar();
      scheduleThumbs(MT.project.maps().map((m) => m.id));
    },
    onHide: function () { flush(); closePopup(true); if (st.pop) st.pop.close(); },
  });

  /* =========================================================================================
   * Public helpers (tests, other modules)
   * ======================================================================================= */
  MT.mapsui = {
    /** Write any debounced edit now. */
    flush: flush,
    /** Open the store popup for a store of the current map (anchored at its marker when visible). */
    openPopup: function (storeId) {
      const b = document.querySelector('.mt-marker-hit[data-store-id="' + CSS.escape(storeId) + '"]');
      const r = b ? b.getBoundingClientRect() : st.els.stage.getBoundingClientRect();
      const rect = b ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : { left: r.left + r.width / 2, right: r.left + r.width / 2, top: r.top + r.height / 2, bottom: r.top + r.height / 2 };
      openPopup({ storeId: storeId, mapId: curId(), screen: { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }, rect: rect });
    },
    closePopup: function () { closePopup(); },
    /** Open/close an inspector section ('content'|'districts'|'chains'|'markers'|'map'|'radius'|'hidden'). */
    section: setSection,
    focusDistricts: focusDistricts,
    addRadius: addRadius,
    exportRadiusXlsx: exportRadiusXlsx,
    runExport: runExport,
    state: function () {
      return { mounted: st.mounted, popup: st.popup ? st.popup.storeId : null, sections: Object.assign({}, st.open), exporting: st.exporting, pending: !!pending.id };
    },
  };
})();
