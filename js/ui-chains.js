/* js/ui-chains.js — "Cadenas" tab (module M3).
 *
 * Master/detail editor for the tracked chains: list grouped by MT.data.GROUPS (with store counts,
 * local-state badges and unregistered chain ids found in stores), and a detail pane with
 *   - live previews: the badge as drawn on the map (ring = brand colour, logo inside, anchor dot),
 *     the card and dot styles, and the legend row on the crimson panel;
 *   - fields: name, legend name, group, brand colour, default on, owner, website, store locator;
 *   - logos: upload / replace / remove the square badge (normalized to a 512 px PNG, fit/zoom/
 *     background controls, previewed inside the circle) and the wide logo (auto-trimmed, ≤512 px);
 *   - OSM rules (advanced): every per-chain key of tools/seed/OSM-RULES.md §2 — Wikidata ids, name
 *     pattern (validated, Overpass filter preview, tester that folds the name and applies the
 *     exclusions like the scan), exclusion pattern, label + prefix, shop types, weak names, format
 *     flags (big format / dense / distinctive name) and tag exclusions; the cross-chain
 *     MT_OSM_RULES are summarized (edited in tools/seed/osm-rules.json);
 *   - add chain, delete a locally added chain, reset a shipped chain, register an unknown id.
 * All edits go to the local overlay (MT.data.upsertChain / MT.logos.set) and are written by
 * "Guardar en carpeta" (data/chains.js + logos/logos.js) through MT.dbui.saveToFolder.
 * Strings: js/i18n/db.js ('chains.*'). Styles: css/db.css (.mt-chains-*).
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util, h = U.h;
  var t = function (k, v) { return MT.t(k, v); };

  var els = {};
  var st = { selected: MT.storage.pref('chains.selected', null), draft: null, orig: null, q: '' };
  var PALETTE = ['#0F766E', '#7C3AED', '#C2410C', '#0369A1', '#BE185D', '#4D7C0F', '#A16207', '#1D4ED8', '#9F1239', '#047857'];

  /* =========================================================================================
   * Badge drawing (mirrors MT.theme.marker so the preview matches the map)
   * ======================================================================================= */
  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image-unreadable')); };
      img.src = src;
    });
  }
  function hidpi(canvas, w, hgt) {
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = hgt + 'px';
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }

  /** Draw a badge marker (ring + white disc + logo) of diameter d centred at (cx, cy). */
  function drawBadge(g, img, color, cx, cy, d) {
    var b = MT.theme.marker.badge, k = d / b.diameter;
    g.save();
    g.shadowColor = b.shadow.color; g.shadowBlur = b.shadow.blur * k; g.shadowOffsetY = b.shadow.offsetY * k;
    g.fillStyle = color; circle(g, cx, cy, d / 2); g.fill();
    g.restore();
    var inner = d / 2 - b.ring * k;
    g.save();
    g.fillStyle = b.background; circle(g, cx, cy, inner); g.fill();
    circle(g, cx, cy, inner); g.clip();
    if (img) {
      var s = inner * 2 - (b.logoInset || 0) * 2 * k;
      g.drawImage(img, cx - s / 2, cy - s / 2, s, s);
    }
    g.restore();
  }
  /** The marker as on the map: badge above a short stem and the exact-location dot (ring = optional ring colour). */
  function drawMarker(canvas, img, color, d, ring) {
    var m = MT.theme.marker, k = d / m.badge.diameter;
    var dot = m.anchorDot.radius * k, stem = m.stem * k, pad = 6;
    var w = d + pad * 2, hh = d + stem + dot * 2 + pad * 2;
    var g = hidpi(canvas, w, hh);
    var cx = w / 2, cy = pad + d / 2, ay = pad + d + stem + dot;
    g.strokeStyle = m.leader.color; g.globalAlpha = m.leader.alpha; g.lineWidth = Math.max(1, m.leader.width * k);
    g.beginPath(); g.moveTo(cx, cy + d / 2 - 1); g.lineTo(cx, ay); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = color; circle(g, cx, ay, dot); g.fill();
    g.strokeStyle = m.anchorDot.stroke; g.lineWidth = m.anchorDot.strokeWidth * k; g.stroke();
    drawBadge(g, img, ring || color, cx, cy, d);
  }

  /* =========================================================================================
   * Logo normalization
   * ======================================================================================= */
  function natural(img) {
    var w = img.naturalWidth || img.width, hgt = img.naturalHeight || img.height;
    if (!w || !hgt) { w = 512; hgt = 512; } // SVG without intrinsic size
    return { w: w, h: hgt };
  }
  /** Square badge PNG (512 px): fit 'contain'|'cover', scale 0.5–1.5, background 'transparent'|'white'|hex. */
  function normalizeBadge(img, o) {
    var S = 512, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var g = cv.getContext('2d');
    if (o.bg && o.bg !== 'transparent') { g.fillStyle = o.bg === 'white' ? '#FFFFFF' : o.bg; g.fillRect(0, 0, S, S); }
    var n = natural(img);
    var k = (o.fit === 'cover' ? Math.max(S / n.w, S / n.h) : Math.min(S / n.w, S / n.h)) * (o.scale || 1);
    var dw = n.w * k, dh = n.h * k;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
    return cv;
  }
  /** Wide logo: trimmed to its content (transparent or uniform background), ≤512×256 px. */
  function normalizeWide(img) {
    var n = natural(img);
    var k0 = Math.min(1, 2048 / Math.max(n.w, n.h));
    var w = Math.max(1, Math.round(n.w * k0)), hgt = Math.max(1, Math.round(n.h * k0));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = hgt;
    var g = cv.getContext('2d');
    g.drawImage(img, 0, 0, w, hgt);
    var box = contentBox(g.getImageData(0, 0, w, hgt));
    var k = Math.min(512 / box.w, 256 / box.h, 1);
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(box.w * k)); out.height = Math.max(1, Math.round(box.h * k));
    var g2 = out.getContext('2d');
    g2.imageSmoothingQuality = 'high';
    g2.drawImage(cv, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
    return out;
  }
  function contentBox(id) {
    var d = id.data, w = id.width, hgt = id.height;
    var c0 = [d[0], d[1], d[2], d[3]];
    var opaqueBg = c0[3] > 240 && sameAt(d, w * 4 - 4, c0) && sameAt(d, (hgt - 1) * w * 4, c0);
    var x0 = w, y0 = hgt, x1 = -1, y1 = -1;
    for (var y = 0; y < hgt; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var bg = opaqueBg ? sameAt(d, i, c0) : d[i + 3] < 12;
        if (!bg) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return { x: 0, y: 0, w: w, h: hgt };
    var pad = 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hgt - 1, y1 + pad);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  function sameAt(d, i, c) { return Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) < 40 && d[i + 3] > 200; }

  MT.chainsui = { drawBadge: drawBadge, drawMarker: drawMarker, normalizeBadge: normalizeBadge, normalizeWide: normalizeWide, select: function (id) { selectChain(id, true); } };

  /* =========================================================================================
   * Layout
   * ======================================================================================= */
  function mount(panel) {
    els.root = h('div', { class: 'mt-chains' });
    panel.appendChild(els.root);
    els.meta = h('div', { class: 'mt-db-head__meta' });
    els.root.appendChild(h('header', { class: 'mt-db-head' },
      h('div', { class: 'mt-db-head__title' }, h('h1', { class: 'mt-db-head__h', 'data-i18n': 'tab.chains' }, t('tab.chains')), els.meta),
      MT.dbui.changesCluster({}),
      h('div', { class: 'mt-db-head__actions' }, MT.ui.button({ icon: 'plus', i18n: 'chains.add', kind: 'primary', size: 'sm', onClick: addChain }))));
    els.search = h('input', { class: 'mt-input mt-input--sm', type: 'search', placeholder: t('chains.searchPh'), 'data-i18n-placeholder': 'chains.searchPh', 'aria-label': t('chains.searchPh') });
    els.search.addEventListener('input', function () { st.q = els.search.value; renderList(); });
    els.list = h('div', { class: 'mt-chains-list', role: 'listbox', 'aria-label': t('tab.chains') });
    els.list.addEventListener('keydown', onListKey);
    els.detail = h('div', { class: 'mt-chains-detail' });
    els.savebar = h('div', { class: 'mt-chains-savebar', hidden: true });
    els.root.appendChild(h('div', { class: 'mt-chains-body' },
      h('aside', { class: 'mt-chains-side' }, h('div', { class: 'mt-chains-side__search mt-input-group' }, MT.ui.iconEl('search', { size: 16 }), els.search), els.list),
      h('main', { class: 'mt-chains-main' }, els.detail, els.savebar)));
    var chains = MT.data.chains();
    if (!st.selected || !chains.some(function (c) { return c.id === st.selected; })) st.selected = chains.length ? chains[0].id : null;
    renderAll(true);
    var rerender = U.debounce(function () { renderAll(false); }, 30);
    MT.bus.on('chains:changed', rerender);
    MT.bus.on('logos:changed', rerender);
    MT.bus.on('stores:changed', rerender);
    MT.bus.on('lang:changed', function () { renderAll(false, true); });
  }

  function renderAll(resetDraft, keepDraft) {
    var chains = MT.data.chains();
    if (st.selected && !chains.some(function (c) { return c.id === st.selected; })) { st.selected = chains.length ? chains[0].id : null; resetDraft = true; }
    renderMeta();
    renderList();
    if (resetDraft || !st.draft || st.draft.id !== st.selected) loadDraft();
    else if (!keepDraft && !isDirty()) loadDraft();
    renderDetail();
  }
  function renderMeta() {
    var chains = MT.data.chains().filter(function (c) { return !c.unknown; });
    var noLogo = chains.filter(function (c) { return !MT.logos.has(c.id); }).length;
    var unknown = MT.data.chains().length - chains.length;
    var bits = [t('db.meta.chains', { n: chains.length })];
    if (noLogo) bits.push(t('chains.meta.noLogo', { n: noLogo }));
    if (unknown) bits.push(t('chains.meta.unknown', { n: unknown }));
    els.meta.textContent = bits.join(' · ');
  }

  /* ---- List ---------------------------------------------------------------------------------- */
  function renderList() {
    U.clear(els.list);
    var counts = MT.data.countsByChain();
    var q = U.normalize(st.q);
    var any = false;
    MT.dbui.chainsByGroup().forEach(function (g) {
      var list = g.chains.filter(function (c) { return !q || U.normalize(c.name + ' ' + c.legendName + ' ' + c.id + ' ' + c.owner).indexOf(q) >= 0; });
      if (!list.length) return;
      any = true;
      els.list.appendChild(h('div', { class: 'mt-chains-group', role: 'presentation' }, t('data.group.' + g.group), h('span', { class: 'mt-count' }, String(list.length))));
      list.forEach(function (c) {
        var stt = MT.data.chainState(c.id);
        var active = c.id === st.selected;
        var badges = [];
        if (c.unknown) badges.push(h('span', { class: 'mt-badge mt-badge--warn' }, t('chains.state.unknown')));
        else if (stt === 'added') badges.push(h('span', { class: 'mt-badge mt-badge--info' }, t('chains.state.added')));
        else if (stt === 'edited') badges.push(h('span', { class: 'mt-badge mt-badge--accent' }, t('chains.state.edited')));
        if (MT.logos.overlay()[c.id]) badges.push(h('span', { class: 'mt-badge mt-badge--accent', title: t('chains.state.logoHint') }, t('chains.state.logo')));
        var b = h('button', { type: 'button', role: 'option', 'aria-selected': String(active), tabindex: active ? '0' : '-1', 'data-id': c.id,
          class: 'mt-chains-item' + (active ? ' is-active' : '') + (c.defaultOn ? '' : ' is-off'), onclick: function () { selectChain(c.id); } },
          MT.dbui.logoImg(c.id, 34, 'mt-chains-item__logo'),
          h('span', { class: 'mt-chains-item__main' },
            h('span', { class: 'mt-chains-item__name' }, h('span', { class: 'mt-truncate' }, c.name), badges),
            h('span', { class: 'mt-chains-item__sub' }, h('span', { class: 'mt-truncate' }, c.legendName), h('span', { class: 'mt-chains-item__n' }, t('chains.storesN', { n: counts[c.id] || 0 })))),
          c.defaultOn ? null : h('span', { class: 'mt-chains-item__off', title: t('chains.offHint'), html: MT.ui.icon('eyeOff', { size: 15 }) }));
        els.list.appendChild(b);
      });
    });
    if (!any) els.list.appendChild(h('div', { class: 'mt-chains-empty' }, t(MT.data.chains().length ? 'chains.noMatch' : 'chains.none')));
  }
  function onListKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    var items = U.$$('.mt-chains-item', els.list);
    var i = items.indexOf(document.activeElement);
    var n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : U.clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
    if (!items[n]) return;
    e.preventDefault();
    items[n].focus();
    selectChain(items[n].dataset.id);
  }
  function selectChain(id, fromApi) {
    if (id === st.selected && st.draft) return;
    var go = function () {
      st.selected = id;
      MT.storage.setPref('chains.selected', id);
      loadDraft();
      renderList(); renderDetail();
      var item = U.$('.mt-chains-item[data-id="' + CSS.escape(id) + '"]', els.list);
      if (item) { item.scrollIntoView({ block: 'nearest' }); if (fromApi !== false && document.activeElement && els.list.contains(document.activeElement)) item.focus(); }
    };
    if (isDirty()) {
      MT.ui.confirm(t('chains.discardText'), { title: t('chains.discardTitle'), okLabel: t('chains.discardOk'), danger: true }).then(function (ok) { if (ok) go(); else renderList(); });
    } else go();
  }

  /* ---- Draft -------------------------------------------------------------------------------- */
  function loadDraft() {
    var c = st.selected ? MT.data.chain(st.selected) : null;
    st.draft = c ? U.clone(c) : null;
    if (st.draft) {
      // '' = ring in the brand colour. Chains edited before ringColor existed fall back to MT_CHAINS.
      st.draft.ringColor = c.ringColor !== undefined ? c.ringColor : seedRing(c.id);
      // A ring equal to the brand colour = "same as the brand" (it then follows colour changes).
      if (U.isHexColor(st.draft.ringColor) && st.draft.ringColor.toUpperCase() === String(c.color).toUpperCase()) st.draft.ringColor = '';
      var o = MT.data.normalizeOsm(c.osm, c.name);
      st.draft.wikidataText = o.wikidata.join(', ');
      st.draft.shopsText = o.shops.join(', ');
      st.draft.nameRegex = o.nameRegex;
      st.draft.excludeNameRegex = o.excludeNameRegex;
      st.draft.osmLabel = o.label;
      st.draft.prefixRegex = o.prefixRegex;
      st.draft.osmBig = !o.requireShopLike;
      st.draft.osmDense = o.dense;
      st.draft.osmUnique = o.uniqueName;
      st.draft.weakNameRegex = o.weakNameRegex;
      st.draft.weakShopsText = o.weakNameShops.join(', ');
      st.draft.excludeTags = o.excludeTags.map(function (x) { return { key: x.key, valueRegex: x.valueRegex, why: x.why }; });
    }
    st.orig = st.draft ? U.clone(st.draft) : null;
    st.errors = {};
  }
  function seedRing(id) {
    var raw = (Array.isArray(window.MT_CHAINS) ? window.MT_CHAINS : []).find(function (x) { return x && x.id === id; });
    return raw && U.isHexColor(raw.ringColor) ? raw.ringColor.toUpperCase() : '';
  }
  /** Effective ring colour of the draft (valid ringColor, else the brand colour). */
  function draftRing(d) { return U.isHexColor(d.ringColor) ? d.ringColor : (U.isHexColor(d.color) ? d.color : MT.theme.colors.unknownChain); }
  var FIELDS = ['name', 'legendName', 'group', 'color', 'ringColor', 'defaultOn', 'owner', 'website', 'storeLocator', 'wikidataText', 'shopsText', 'nameRegex',
    'excludeNameRegex', 'osmLabel', 'prefixRegex', 'osmBig', 'osmDense', 'osmUnique', 'weakNameRegex', 'weakShopsText'];
  function isDirty() {
    if (!st.draft || !st.orig) return false;
    if (st.draft.unknown) return false;
    return FIELDS.some(function (k) { return String(st.draft[k]) !== String(st.orig[k]); }) ||
      JSON.stringify(cleanTags(st.draft.excludeTags)) !== JSON.stringify(cleanTags(st.orig.excludeTags));
  }
  /** Tag exclusions as saved: rows without a key are dropped. */
  function cleanTags(list) {
    return (list || []).filter(function (x) { return String(x.key || '').trim(); })
      .map(function (x) { return { key: String(x.key).trim(), valueRegex: String(x.valueRegex || ''), why: String(x.why || '').trim() }; });
  }
  /** The draft's osm object (all keys of OSM-RULES.md §2). */
  function draftOsm(d) {
    return {
      wikidata: splitList(d.wikidataText).map(function (q) { return q.toUpperCase(); }),
      nameRegex: String(d.nameRegex || '').trim(),
      excludeNameRegex: String(d.excludeNameRegex || '').trim(),
      label: String(d.osmLabel || '').trim(),   // '' = the chain name (follows renames)
      prefixRegex: String(d.prefixRegex || '').trim(),
      shops: splitList(d.shopsText).map(function (x) { return x.toLowerCase(); }),
      requireShopLike: !d.osmBig,
      dense: !!d.osmDense,
      uniqueName: !!d.osmUnique,
      weakNameRegex: String(d.weakNameRegex || '').trim(),
      weakNameShops: splitList(d.weakShopsText).map(function (x) { return x.toLowerCase(); }),
      excludeTags: cleanTags(d.excludeTags),
    };
  }
  function regexOk(v) { v = String(v || '').trim(); if (!v) return true; try { new RegExp(v, 'iu'); return true; } catch (e) { return false; } }
  var REGEX_FIELDS = ['nameRegex', 'excludeNameRegex', 'prefixRegex', 'weakNameRegex'];
  function draftToChain() {
    var d = st.draft;
    return {
      id: d.id, name: d.name.trim(), legendName: (d.legendName || '').trim() || d.name.trim().toUpperCase(), group: d.group, color: d.color.toUpperCase(),
      // Only keep a ring colour that differs from the brand colour ('' = same as the brand).
      ringColor: U.isHexColor(d.ringColor) && d.ringColor.toUpperCase() !== d.color.toUpperCase() ? d.ringColor.toUpperCase() : '',
      defaultOn: !!d.defaultOn, owner: (d.owner || '').trim(), website: (d.website || '').trim(), storeLocator: (d.storeLocator || '').trim(),
      osm: draftOsm(d),
      logo: d.logo === undefined ? d.id : d.logo,
    };
  }
  function splitList(s) { return String(s || '').split(/[,;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  /**
   * Name rule of a chain without OSM rules (MT.osm.nameRegexFor): the folded name anchored at the
   * start — "Economax Perú" → "^economax\s*peru(?![a-z0-9])". New chains keep nameRegex empty, so the
   * scan derives it from the current name (it follows renames); the field shows it as placeholder.
   */
  function nameToRegex(name) { return MT.osm.nameRegexFor(name); }
  MT.chainsui.nameToRegex = nameToRegex;
  function validate() {
    var d = st.draft, e = {};
    if (!d.name.trim()) e.name = t('chains.err.name');
    if (!U.isHexColor(d.color)) e.color = t('chains.err.color');
    if (d.ringColor && !U.isHexColor(d.ringColor)) e.ringColor = t('chains.err.ringColor');
    var bad = splitList(d.wikidataText).filter(function (q) { return !/^Q\d+$/i.test(q); });
    if (bad.length) e.wikidata = t('chains.err.wikidata', { list: bad.join(', ') });
    REGEX_FIELDS.forEach(function (k) { if (!regexOk(d[k])) e[k] = t('chains.err.regex'); });
    (d.excludeTags || []).forEach(function (x) {
      if (!String(x.key || '').trim() && (String(x.valueRegex || '').trim() || String(x.why || '').trim())) e.excludeTags = t('chains.err.xtagKey');
      else if (!regexOk(x.valueRegex)) e.excludeTags = t('chains.err.regex');
    });
    return e;
  }

  /* ---- Detail ------------------------------------------------------------------------------- */
  function renderDetail() {
    var main = els.detail;
    var scroll = main.parentNode ? main.parentNode.scrollTop : 0;
    U.clear(main);
    var d = st.draft;
    if (!d) {
      main.appendChild(MT.ui.emptyState({ icon: 'store', title: t('chains.emptyTitle'), text: t(MT.data.missing.chains ? 'chains.missingText' : 'chains.emptyText'),
        action: MT.ui.button({ icon: 'plus', label: t('chains.add'), kind: 'primary', onClick: addChain }) }));
      updateSavebar();
      return;
    }
    var stt = MT.data.chainState(d.id);
    var count = (MT.data.countsByChain()[d.id] || 0);
    var closedCount = MT.data.stores({ includeClosed: true, chain: d.id }).length - count;

    // Header with the big marker preview.
    els.heroCanvas = h('canvas', { class: 'mt-chains-hero__marker', 'aria-hidden': 'true' });
    var actions = [];
    if (d.unknown) actions.push(MT.ui.button({ icon: 'plus', label: t('chains.register'), kind: 'primary', size: 'sm', onClick: registerUnknown }));
    if (stt === 'edited') actions.push(MT.ui.button({ icon: 'undo', label: t('chains.reset'), kind: 'secondary', size: 'sm', onClick: resetChain }));
    if (stt === 'added') actions.push(MT.ui.button({ icon: 'trash', label: t('chains.delete'), kind: 'ghost', size: 'sm', className: 'mt-db-delbtn', onClick: deleteChain }));
    main.appendChild(h('div', { class: 'mt-chains-hero' },
      h('div', { class: 'mt-chains-hero__art' }, els.heroCanvas),
      h('div', { class: 'mt-chains-hero__text' },
        h('div', { class: 'mt-chains-hero__eyebrow' }, t('data.group.' + d.group), h('span', { class: 'mt-mono' }, ' · ' + d.id)),
        h('h2', { class: 'mt-chains-hero__name' }, d.name || '—'),
        h('div', { class: 'mt-chains-hero__stats' },
          h('span', null, h('strong', null, MT.i18n.formatNumber(count)), ' ', t('chains.activeStores', { n: count })),
          closedCount ? h('span', null, h('strong', null, MT.i18n.formatNumber(closedCount)), ' ', t('chains.closedStores', { n: closedCount })) : null,
          MT.dbui && count ? h('button', { type: 'button', class: 'mt-db-link', onclick: function () { MT.app.showTab('db'); MT.dbui.setFilters({ chains: [d.id] }); } }, t('chains.viewStores')) : null)),
      h('div', { class: 'mt-chains-hero__actions' }, actions)));
    if (d.unknown) {
      main.appendChild(h('div', { class: 'mt-db-notice mt-db-notice--warn' }, MT.ui.iconEl('warning', { size: 18 }),
        h('div', null, h('strong', null, t('chains.unknownTitle')), h('div', null, t('chains.unknownText', { id: d.id, n: count })))));
    }

    var grid = h('div', { class: 'mt-chains-grid' });
    main.appendChild(grid);
    var disabled = !!d.unknown;

    /* Datos */
    var text = function (key, labelKey, opts) {
      opts = opts || {};
      var inp = h('input', { class: 'mt-input' + (st.errors[key] ? ' is-invalid' : ''), type: opts.type || 'text', value: d[key] || '', placeholder: opts.placeholder || null, disabled: disabled, spellcheck: opts.spellcheck === false ? 'false' : null, autocomplete: 'off' });
      inp.addEventListener('input', function () { d[key] = inp.value; if (opts.live) renderPreviews(); updateSavebar(); });
      return h('label', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t(labelKey), opts.hint ? h('small', null, ' ' + opts.hint) : null), inp, h('div', { class: 'mt-field__error' }, st.errors[key] || ''));
    };
    var groupSel = h('select', { class: 'mt-select', disabled: disabled }, MT.data.GROUPS.map(function (g) { return h('option', { value: g, selected: g === d.group }, t('data.group.' + g)); }));
    groupSel.addEventListener('change', function () { d.group = groupSel.value; updateSavebar(); });
    var colorIn = h('input', { type: 'color', class: 'mt-chains-color__picker', value: U.isHexColor(d.color) ? d.color.toLowerCase() : '#6b7280', disabled: disabled, 'aria-label': t('chains.color') });
    var hexIn = h('input', { class: 'mt-input mt-input--sm mt-mono mt-chains-color__hex' + (st.errors.color ? ' is-invalid' : ''), value: d.color, maxlength: 7, disabled: disabled, 'aria-label': t('chains.colorHex'), spellcheck: 'false' });
    colorIn.addEventListener('input', function () { d.color = colorIn.value.toUpperCase(); hexIn.value = d.color; hexIn.classList.remove('is-invalid'); syncRing(); renderPreviews(); updateSavebar(); });
    hexIn.addEventListener('input', function () {
      var v = hexIn.value.trim(); if (v && v[0] !== '#') v = '#' + v;
      d.color = v.toUpperCase();
      var ok = U.isHexColor(d.color);
      hexIn.classList.toggle('is-invalid', !ok);
      if (ok) { colorIn.value = d.color.toLowerCase(); syncRing(); renderPreviews(); }
      updateSavebar();
    });
    var swatches = h('div', { class: 'mt-chains-swatches' }, suggestedColors(d).map(function (c) {
      return h('button', { type: 'button', class: 'mt-chains-swatch', style: { background: c }, title: c, 'aria-label': c, disabled: disabled,
        onclick: function () { d.color = c; colorIn.value = c.toLowerCase(); hexIn.value = c; syncRing(); renderPreviews(); updateSavebar(); } });
    }));
    // Optional ring colour (badge ring and card border); empty = same as the brand colour.
    var ringIn = h('input', { type: 'color', class: 'mt-chains-color__picker', value: draftRing(d).toLowerCase(), disabled: disabled, 'aria-label': t('chains.ringColor') });
    var ringHex = h('input', { class: 'mt-input mt-input--sm mt-mono mt-chains-color__hex' + (st.errors.ringColor ? ' is-invalid' : ''), value: d.ringColor || '', maxlength: 7, disabled: disabled, 'aria-label': t('chains.ringColor'), spellcheck: 'false', placeholder: '#RRGGBB' });
    var ringNote = h('span', { class: 'mt-hint mt-chains-ring__note' });
    var ringReset = h('button', { type: 'button', class: 'mt-db-link mt-chains-ring__reset', disabled: disabled, onclick: function () { d.ringColor = ''; ringHex.value = ''; ringHex.classList.remove('is-invalid'); syncRing(); renderPreviews(); updateSavebar(); } }, t('chains.ringReset'));
    ringIn.addEventListener('input', function () { d.ringColor = ringIn.value.toUpperCase(); ringHex.value = d.ringColor; ringHex.classList.remove('is-invalid'); syncRing(); renderPreviews(); updateSavebar(); });
    ringHex.addEventListener('input', function () {
      var v = ringHex.value.trim(); if (v && v[0] !== '#') v = '#' + v;
      d.ringColor = v.toUpperCase();
      var ok = !v || U.isHexColor(d.ringColor);
      ringHex.classList.toggle('is-invalid', !ok);
      if (ok) { syncRing(); renderPreviews(); }
      updateSavebar();
    });
    function syncRing() {
      var custom = U.isHexColor(d.ringColor) && d.ringColor.toUpperCase() !== String(d.color).toUpperCase();
      ringIn.value = draftRing(d).toLowerCase();
      ringNote.textContent = custom ? '' : t('chains.ringSame');
      ringNote.hidden = custom;
      ringReset.hidden = !custom;
    }
    syncRing();
    var defaultSwitch = MT.ui.switchEl({ label: t('chains.defaultOn'), checked: d.defaultOn, onChange: function (v) { d.defaultOn = v; updateSavebar(); } });
    if (disabled) U.$('input', defaultSwitch).disabled = true;
    grid.appendChild(card('chains.secData', 'edit', [
      h('div', { class: 'mt-db-grid2' }, text('name', 'chains.name', { live: true }), text('legendName', 'chains.legendName', { live: true, hint: t('chains.legendHint') })),
      h('div', { class: 'mt-db-grid2' },
        h('label', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('chains.group')), groupSel),
        h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('chains.color'), h('small', null, ' ' + t('chains.colorHint'))),
          h('div', { class: 'mt-chains-color' }, colorIn, hexIn, swatches), h('div', { class: 'mt-field__error' }, st.errors.color || ''))),
      h('div', { class: 'mt-field mt-chains-ring' }, h('span', { class: 'mt-label' }, t('chains.ringColor'), h('small', null, ' ' + t('chains.ringHint'))),
        h('div', { class: 'mt-chains-color' }, ringIn, ringHex, ringNote, ringReset), h('div', { class: 'mt-field__error' }, st.errors.ringColor || '')),
      h('div', { class: 'mt-chains-switchrow' }, defaultSwitch, h('span', { class: 'mt-hint' }, t('chains.defaultOnHint'))),
      h('div', { class: 'mt-divider' }),
      text('owner', 'chains.owner'),
      h('div', { class: 'mt-db-grid2' }, text('website', 'chains.website', { type: 'url', placeholder: 'https://', spellcheck: false }), text('storeLocator', 'chains.storeLocator', { type: 'url', placeholder: 'https://', spellcheck: false })),
    ]));

    /* Previews */
    els.prevMap = h('div', { class: 'mt-chains-prevmap' });
    els.prevLegend = h('div', { class: 'mt-chains-prevlegend', style: { background: MT.theme.panelCss() } });
    grid.appendChild(card('chains.secPreview', 'eye', [
      h('div', { class: 'mt-label mt-chains-prevlabel' }, t('chains.prevMap')), els.prevMap,
      h('div', { class: 'mt-label mt-chains-prevlabel' }, t('chains.prevLegend')), els.prevLegend,
      h('p', { class: 'mt-hint' }, t('chains.prevHint')),
    ], 'mt-chains-card--preview'));

    /* Logos */
    var logo = MT.logos.get(d.id);
    var ov = MT.logos.overlay()[d.id] || {};
    var srcKey = logo.source === 'overlay' ? 'chains.logo.srcOverlay' : logo.source === 'seed' ? 'chains.logo.srcSeed' : 'chains.logo.srcGenerated';
    els.badgeTile = h('canvas', { class: 'mt-chains-logo__badge', 'aria-hidden': 'true' });
    var wideBox = h('div', { class: 'mt-chains-logo__wide', style: { borderColor: d.color } },
      logo.wide ? h('img', { src: logo.wide, alt: '' }) : h('span', { class: 'mt-muted' }, t('chains.logo.noWide')));
    grid.appendChild(card('chains.secLogos', 'image', [
      h('div', { class: 'mt-chains-logos' },
        h('div', { class: 'mt-chains-logo' },
          h('div', { class: 'mt-chains-logo__art' }, els.badgeTile),
          h('div', { class: 'mt-chains-logo__body' },
            h('strong', null, t('chains.logo.badge')), h('span', { class: 'mt-hint' }, t('chains.logo.badgeHint')),
            h('span', { class: 'mt-chains-logo__src' + (logo.generated ? ' is-generated' : '') }, t(srcKey)),
            h('div', { class: 'mt-row mt-row--wrap' },
              MT.ui.button({ icon: 'upload', label: t(logo.generated ? 'chains.logo.upload' : 'chains.logo.replace'), kind: 'secondary', size: 'sm', disabled: disabled, onClick: function () { uploadBadge(); } }),
              ov.badge ? MT.ui.button({ icon: 'undo', label: t('chains.logo.removeUpload'), kind: 'ghost', size: 'sm', onClick: function () { removeLogo('badge'); } }) : null))),
        h('div', { class: 'mt-chains-logo' },
          h('div', { class: 'mt-chains-logo__art mt-chains-logo__art--wide' }, wideBox),
          h('div', { class: 'mt-chains-logo__body' },
            h('strong', null, t('chains.logo.wide')), h('span', { class: 'mt-hint' }, t('chains.logo.wideHint')),
            h('div', { class: 'mt-row mt-row--wrap' },
              MT.ui.button({ icon: 'upload', label: t(logo.wide ? 'chains.logo.replace' : 'chains.logo.upload'), kind: 'secondary', size: 'sm', disabled: disabled, onClick: function () { uploadWide(); } }),
              ov.wide ? MT.ui.button({ icon: 'undo', label: t('chains.logo.removeUpload'), kind: 'ghost', size: 'sm', onClick: function () { removeLogo('wide'); } }) : null)))),
    ]));

    /* OSM rules (advanced): every per-chain key of tools/seed/OSM-RULES.md §2 */
    var rulesBody = h('div', { class: 'mt-stack' });
    var compiled = MT.osm.compile();   // the saved chains, to tell when another chain claims a name first
    var refreshers = [];
    var refresh = function () { refreshers.forEach(function (f) { f(); }); };
    var regexField = function (key, labelKey, hintKey, placeholder) {
      var inp = h('input', { class: 'mt-input mt-mono' + (st.errors[key] ? ' is-invalid' : ''), value: d[key] || '', disabled: disabled, spellcheck: 'false',
        autocomplete: 'off', placeholder: placeholder || null, 'data-osm': key });
      var err = h('div', { class: 'mt-field__error' }, st.errors[key] || '');
      inp.addEventListener('input', function () {
        d[key] = inp.value;
        var bad = !regexOk(inp.value);
        inp.classList.toggle('is-invalid', bad);
        err.textContent = bad ? t('chains.err.regex') : '';
        refresh(); updateSavebar();
      });
      return { input: inp, el: h('label', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t(labelKey), hintKey ? h('small', null, ' ' + t(hintKey)) : null), inp, err) };
    };
    var nameF = regexField('nameRegex', 'chains.osm.regex', 'chains.osm.regexHint');
    var exclF = regexField('excludeNameRegex', 'chains.osm.exclude', 'chains.osm.excludeHint');
    var weakF = regexField('weakNameRegex', 'chains.osm.weak', 'chains.osm.weakHint');
    var prefixF = regexField('prefixRegex', 'chains.osm.prefix', 'chains.osm.prefixHint');
    var ereOut = h('code', { class: 'mt-chains-ere' });
    var derivedNote = h('span', { class: 'mt-hint mt-chains-derived' });
    var testIn = h('input', { class: 'mt-input mt-input--sm', placeholder: t('chains.osm.testPh'), disabled: disabled });
    var testOut = h('span', { class: 'mt-chains-test' });
    var runTest = function () {
      U.clear(testOut);
      var v = testIn.value.trim();
      if (!v) return;
      var res;
      try { res = MT.osm.nameVerdict({ id: d.id, name: d.name, osm: draftOsm(d) }, v, compiled); } catch (e) { return; }
      var ok = res.verdict === 'match', warn = res.verdict === 'weak';
      testOut.className = 'mt-chains-test ' + (ok ? 'is-ok' : warn ? 'is-warn' : 'is-no');
      testOut.appendChild(MT.ui.iconEl(ok ? 'success' : warn ? 'warning' : 'error', { size: 15 }));
      testOut.appendChild(document.createTextNode(t('chains.osm.verdict.' + res.verdict, { name: res.chain ? MT.data.chain(res.chain).name : '' })));
    };
    var updateName = function () {
      var o = draftOsm(d);
      var derived = !o.nameRegex && !o.wikidata.length;
      var auto = derived ? MT.osm.nameRegexFor(d.name || d.id) : '';
      nameF.input.placeholder = auto || 'plaza\\s*vea';
      derivedNote.textContent = derived && auto ? t('chains.osm.derived') : '';
      derivedNote.hidden = !derived;
      var src = o.nameRegex || auto;
      ereOut.textContent = src && regexOk(src) ? MT.osm.toERE(src, { anchors: false }) || '—' : '—';
      runTest();
    };
    refreshers.push(updateName);
    testIn.addEventListener('input', runTest);
    var wd = text('wikidataText', 'chains.osm.wikidata', { placeholder: 'Q7203672', spellcheck: false, hint: t('chains.osm.wikidataHint') });
    U.$('input', wd).addEventListener('input', function () { refresh(); });
    var labelIn = text('osmLabel', 'chains.osm.label', { placeholder: d.name, hint: t('chains.osm.labelHint') });
    var shops = text('shopsText', 'chains.osm.shops', { placeholder: 'supermarket, convenience', spellcheck: false, hint: t('chains.osm.shopsHint') });
    var weakShops = text('weakShopsText', 'chains.osm.weakShops', { placeholder: 'yes', spellcheck: false, hint: t('chains.osm.weakShopsHint') });
    var flag = function (key, labelKey, hintKey) {
      var sw = MT.ui.switchEl({ label: t(labelKey), checked: !!d[key], onChange: function (v) { d[key] = v; updateSavebar(); } });
      if (disabled) U.$('input', sw).disabled = true;
      return h('div', { class: 'mt-chains-osmflag' }, sw, h('span', { class: 'mt-hint' }, t(hintKey)));
    };
    // Tag exclusions: rows of {key, value pattern, why}.
    if (!Array.isArray(d.excludeTags)) d.excludeTags = [];
    var tagsBox = h('div', { class: 'mt-chains-xtags' });
    var tagsErr = h('div', { class: 'mt-field__error' }, st.errors.excludeTags || '');
    var renderTags = function () {
      U.clear(tagsBox);
      if (!d.excludeTags.length) tagsBox.appendChild(h('div', { class: 'mt-hint mt-chains-xtags__none' }, t('chains.osm.xtagsNone')));
      d.excludeTags.forEach(function (x, i) {
        var inp = function (k, cls, ph, aria) {
          var el = h('input', { class: 'mt-input mt-input--sm' + (cls ? ' ' + cls : ''), value: x[k] || '', placeholder: ph, disabled: disabled, spellcheck: 'false', autocomplete: 'off', 'aria-label': aria });
          el.addEventListener('input', function () {
            x[k] = el.value;
            if (k === 'valueRegex') el.classList.toggle('is-invalid', !regexOk(el.value));
            updateSavebar();
          });
          if (k === 'valueRegex' && !regexOk(x[k])) el.classList.add('is-invalid');
          return el;
        };
        tagsBox.appendChild(h('div', { class: 'mt-chains-xtag' },
          inp('key', 'mt-mono mt-chains-xtag__key', 'operator', t('chains.osm.xtagKey')),
          h('span', { class: 'mt-chains-xtag__op', 'aria-hidden': 'true' }, '~'),
          inp('valueRegex', 'mt-mono', 'programa nacional|midis', t('chains.osm.xtagValue')),
          inp('why', '', t('chains.osm.xtagWhyPh'), t('chains.osm.xtagWhy')),
          MT.ui.button({ icon: 'trash', kind: 'ghost', size: 'sm', title: t('common.remove'), disabled: disabled,
            onClick: function () { d.excludeTags.splice(i, 1); renderTags(); updateSavebar(); } })));
      });
    };
    renderTags();
    var addTag = MT.ui.button({ icon: 'plus', label: t('chains.osm.xtagAdd'), kind: 'ghost', size: 'sm', disabled: disabled,
      onClick: function () { d.excludeTags.push({ key: '', valueRegex: '', why: '' }); renderTags(); var k = tagsBox.querySelectorAll('.mt-chains-xtag__key'); if (k.length) k[k.length - 1].focus(); } });
    // Cross-chain rules (MT_OSM_RULES): read-only summary.
    var G = MT.osm.globalRules();
    var common = h('p', { class: 'mt-hint mt-chains-osmcommon' }, MT.ui.iconEl('info', { size: 14 }),
      h('span', null, t(MT.osm.globalRulesSource() === 'file' ? 'chains.osm.common' : 'chains.osm.commonBuiltin',
        { v: G.version, keys: (G.notStore && G.notStore.keys || []).length, shops: (G.genericShops || []).length,
          big: G.radii.big.dedupe, dense: G.radii.dense.dedupe })));
    rulesBody.append(
      h('p', { class: 'mt-hint' }, t('chains.osm.intro')),
      wd,
      nameF.el,
      h('div', { class: 'mt-chains-erebox' }, h('span', { class: 'mt-hint' }, t('chains.osm.ere')), ereOut, derivedNote),
      h('div', { class: 'mt-chains-tester' }, testIn, testOut),
      h('div', { class: 'mt-db-grid2' }, exclF.el, weakF.el),
      h('div', { class: 'mt-db-grid2' }, labelIn, prefixF.el),
      h('div', { class: 'mt-db-grid2' }, shops, weakShops),
      h('div', { class: 'mt-chains-osmflags' },
        flag('osmBig', 'chains.osm.big', 'chains.osm.bigHint'),
        flag('osmDense', 'chains.osm.dense', 'chains.osm.denseHint'),
        flag('osmUnique', 'chains.osm.unique', 'chains.osm.uniqueHint')),
      h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('chains.osm.xtags'), h('small', null, ' ' + t('chains.osm.xtagsHint'))), tagsBox,
        h('div', { class: 'mt-row' }, addTag), tagsErr),
      common);
    var rules = MT.osm.rules(MT.data.chain(d.id));
    var anyErr = REGEX_FIELDS.some(function (k) { return !!st.errors[k]; }) || !!st.errors.wikidata || !!st.errors.excludeTags;
    var details = h('details', { class: 'mt-chains-osm', open: MT.storage.pref('chains.osmOpen', false) || anyErr },
      h('summary', null, MT.ui.iconEl('globe', { size: 16 }), h('span', null, t('chains.secOsm')),
        h('span', { class: 'mt-badge ' + (rules.usable ? 'mt-badge--success' : 'mt-badge--warn') }, t(rules.usable ? (rules.derived ? 'chains.osm.readyDerived' : 'chains.osm.ready') : 'chains.osm.notReady')),
        h('span', { class: 'mt-chains-osm__chev', html: MT.ui.icon('chevronDown', { size: 16 }) })),
      rulesBody);
    details.addEventListener('toggle', function () { MT.storage.setPref('chains.osmOpen', details.open); });
    if (st.errors.wikidata) U.$('.mt-field__error', wd).textContent = st.errors.wikidata;
    grid.appendChild(h('section', { class: 'mt-card mt-chains-card mt-chains-card--wide' }, details));
    updateName();

    renderPreviews();
    updateSavebar();
    if (main.parentNode) main.parentNode.scrollTop = scroll;
  }

  function card(titleKey, icon, children, cls) {
    return h('section', { class: 'mt-card mt-chains-card' + (cls ? ' ' + cls : '') },
      h('h3', { class: 'mt-db-sec__title' }, MT.ui.iconEl(icon, { size: 15 }), t(titleKey)), children);
  }
  function suggestedColors(d) {
    var used = {};
    MT.data.chains().forEach(function (c) { if (c.id !== d.id) used[c.color.toUpperCase()] = true; });
    return PALETTE.filter(function (c) { return !used[c]; }).slice(0, 6);
  }

  /** Re-draw hero, map previews, legend row and the badge tile with the draft colour/name. */
  var previewToken = 0;
  function renderPreviews() {
    var d = st.draft;
    if (!d || !els.prevMap) return;
    var color = U.isHexColor(d.color) ? d.color : MT.theme.colors.unknownChain;
    var ring = draftRing(d);
    var token = ++previewToken;
    var logo = MT.logos.get(d.id);
    Promise.all([loadImage(logo.badge), logo.wide ? loadImage(logo.wide) : null]).then(function (imgs) {
      if (token !== previewToken) return;
      var badge = imgs[0], wide = imgs[1];
      drawMarker(els.heroCanvas, badge, color, 64, ring);
      var g = hidpi(els.badgeTile, 96, 96);
      drawBadge(g, badge, ring, 48, 48, 84);
      // Map preview: the three marker styles on a basemap-like backdrop.
      U.clear(els.prevMap);
      var c1 = h('canvas'); drawMarker(c1, badge, color, 46, ring);
      var c2 = h('canvas'); drawCard(c2, wide || badge, ring, !!wide);
      var c3 = h('canvas'); drawDot(c3, color);
      els.prevMap.append(
        h('figure', { class: 'mt-chains-prev' }, c1, h('figcaption', null, t('chains.style.badge'))),
        h('figure', { class: 'mt-chains-prev' }, c2, h('figcaption', null, t('chains.style.card'))),
        h('figure', { class: 'mt-chains-prev' }, c3, h('figcaption', null, t('chains.style.dot'))));
      U.clear(els.prevLegend);
      var li = h('canvas'); var gl = hidpi(li, 26, 26); drawBadge(gl, badge, ring, 13, 13, 24);
      var label = ((d.legendName || '').trim() || (d.name || '').toUpperCase()) + (MT.theme.legend.showCount ? ' (' + (MT.data.countsByChain()[d.id] || 0) + ')' : '');
      els.prevLegend.append(h('span', { class: 'mt-chains-prevlegend__h' }, MT.theme.legend.heading.text),
        h('span', { class: 'mt-chains-prevlegend__row' }, li, h('span', null, MT.theme.legend.row.uppercase ? label.toUpperCase() : label)));
    }).catch(function () { /* broken image: previews stay empty */ });
  }
  function drawCard(canvas, img, color, isWide) {
    var c = MT.theme.marker.card, k = 1.5;
    var hh = c.height * k, pad = c.padding * k;
    var n = natural(img);
    var lh = hh - pad * 2, lw = Math.min(c.maxWidth * k - pad * 2, lh * n.w / n.h);
    var w = lw + pad * 2, m = 6;
    var g = hidpi(canvas, w + m * 2, hh + m * 2);
    g.save();
    g.shadowColor = c.shadow.color; g.shadowBlur = c.shadow.blur * k; g.shadowOffsetY = c.shadow.offsetY * k;
    g.fillStyle = c.background; roundRect(g, m, m, w, hh, c.radius * k); g.fill();
    g.restore();
    g.strokeStyle = color; g.lineWidth = c.borderWidth * k; roundRect(g, m, m, w, hh, c.radius * k); g.stroke();
    if (isWide) g.drawImage(img, m + pad, m + pad, lw, lh);
    else {
      // No wide logo: the badge mark inside a square white card, as MT.markers draws it on the map.
      var inset = Math.max(pad * 0.6, (c.borderWidth + 1) * k), s = hh - inset * 2;
      g.save(); roundRect(g, m + (w - s) / 2, m + inset, s, s, Math.max(0, c.radius * k - inset / 2)); g.clip();
      g.drawImage(img, m + (w - s) / 2, m + inset, s, s); g.restore();
    }
  }
  function drawDot(canvas, color) {
    var dd = MT.theme.marker.dot, k = 1.6, r = dd.radius * k, m = 6;
    var g = hidpi(canvas, r * 2 + m * 2, r * 2 + m * 2);
    g.fillStyle = color; circle(g, r + m, r + m, r); g.fill();
    g.strokeStyle = dd.stroke; g.lineWidth = dd.strokeWidth * k; g.stroke();
  }
  function roundRect(g, x, y, w, hh, r) {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + hh - r);
    g.quadraticCurveTo(x + w, y + hh, x + w - r, y + hh); g.lineTo(x + r, y + hh); g.quadraticCurveTo(x, y + hh, x, y + hh - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }

  /* ---- Save bar ------------------------------------------------------------------------------ */
  function updateSavebar() {
    var dirty = isDirty();
    els.savebar.hidden = !dirty;
    U.clear(els.savebar);
    if (!dirty) return;
    els.savebar.append(h('span', { class: 'mt-chains-savebar__dot' }), h('span', { class: 'mt-chains-savebar__text' }, t('chains.unsaved')),
      h('span', { class: 'mt-spacer' }),
      MT.ui.button({ label: t('chains.discard'), kind: 'ghost', size: 'sm', onClick: function () { loadDraft(); renderDetail(); } }),
      MT.ui.button({ icon: 'check', label: t('common.save'), kind: 'primary', size: 'sm', onClick: saveChain }));
  }
  function saveChain() {
    var errs = validate();
    st.errors = errs;
    if (Object.keys(errs).length) { renderDetail(); var bad = U.$('.is-invalid', els.detail); if (bad) { bad.scrollIntoView({ block: 'center' }); bad.focus(); } return Promise.resolve(null); }
    return MT.data.upsertChain(draftToChain()).then(function (c) {
      MT.ui.toast(t('chains.saved', { name: c.name }), { type: 'success' });
      st.errors = {};
      loadDraft(); renderAll(false);
      return c;
    }, function (err) { console.error(err); MT.ui.toast(t('chains.err.save'), { type: 'error' }); return null; });
  }
  MT.chainsui.save = saveChain;
  MT.chainsui.draft = function () { return st.draft; };

  /* ---- Add / register / reset / delete -------------------------------------------------------- */
  /**
   * Conservative OSM rules of a chain added here: no name pattern (the scan derives "^name" from the
   * chain name, MT.osm.nameRegexFor), any shop=* type, a shop tag required, dense radii (stores are
   * never merged beyond 40 m). Refine them in the advanced section.
   */
  function newChainOsm() {
    return { wikidata: [], nameRegex: '', excludeNameRegex: '', label: '', prefixRegex: '', shops: [], requireShopLike: true, dense: true,
      uniqueName: false, weakNameRegex: '', weakNameShops: [], excludeTags: [] };
  }
  function addChain() {
    MT.ui.prompt(t('chains.newLabel'), { title: t('chains.add'), placeholder: t('chains.newPh'), okLabel: t('chains.create'), validate: function (v) {
      if (!v) return t('common.required');
      var id = U.slug(v).replace(/-/g, '');
      if (!id) return t('chains.err.name');
      if (MT.data.hasChain(id)) return t('chains.err.exists', { name: MT.data.chain(id).name });
      return '';
    } }).then(function (name) {
      if (!name) return;
      var id = U.slug(name).replace(/-/g, '');
      var color = suggestedColors({ id: id })[0] || PALETTE[0];
      return MT.data.upsertChain({ id: id, name: name, legendName: name.toUpperCase(), group: 'other', color: color, defaultOn: true,
        osm: newChainOsm(name) }).then(function (c) {
        MT.ui.toast(t('chains.created', { name: c.name }), { type: 'success' });
        st.selected = c.id; loadDraft(); renderAll(false); selectChain(c.id);
      });
    });
  }
  function registerUnknown() {
    var d = st.draft;
    var nice = d.id.charAt(0).toUpperCase() + d.id.slice(1);
    MT.ui.prompt(t('chains.registerLabel', { id: d.id }), { title: t('chains.register'), value: nice, okLabel: t('chains.register') }).then(function (name) {
      if (!name) return;
      return MT.data.upsertChain({ id: d.id, name: name, legendName: name.toUpperCase(), group: 'other', color: suggestedColors(d)[0] || PALETTE[0], defaultOn: true,
        osm: newChainOsm(name) }).then(function (c) {
        MT.ui.toast(t('chains.registered', { name: c.name }), { type: 'success' });
        loadDraft(); renderAll(false);
      });
    });
  }
  function resetChain() {
    var d = st.draft;
    MT.ui.confirm(t('chains.resetText', { name: d.name }), { title: t('chains.reset'), okLabel: t('chains.reset') }).then(function (ok) {
      if (!ok) return;
      MT.data.restoreChain(d.id).then(function () { MT.ui.toast(t('chains.resetDone'), { type: 'success' }); loadDraft(); renderAll(false); });
    });
  }
  function deleteChain() {
    var d = st.draft;
    var n = MT.data.stores({ includeClosed: true, chain: d.id }).length;
    MT.ui.confirm(t(n ? 'chains.deleteTextStores' : 'chains.deleteText', { name: d.name, n: n }), { title: t('chains.deleteTitle', { name: d.name }), okLabel: t('chains.delete'), danger: true }).then(function (ok) {
      if (!ok) return;
      var p = MT.logos.overlay()[d.id] ? MT.logos.remove(d.id) : Promise.resolve();
      p.then(function () { return MT.data.restoreChain(d.id); }).then(function () {
        MT.ui.toast(t('chains.deleted', { name: d.name }), { type: 'success' });
        st.selected = null; renderAll(true);
      });
    });
  }

  /* ---- Logo uploads --------------------------------------------------------------------------- */
  var ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp,.png,.jpg,.jpeg,.svg,.webp';
  function pickImage() {
    return MT.ui.pickFile({ accept: ACCEPT }).then(function (file) {
      if (!file) return null;
      if (file.size > 8 * 1024 * 1024) { MT.ui.toast(t('chains.logo.tooBig'), { type: 'error' }); return null; }
      return MT.io.readAsDataURL(file).then(loadImage).then(function (img) { return { img: img, name: file.name }; }, function () {
        MT.ui.toast(t('chains.logo.unreadable'), { type: 'error' }); return null;
      });
    });
  }
  function uploadBadge(preset) {
    var d = st.draft;
    var p = preset ? Promise.resolve(preset) : pickImage();
    return p.then(function (picked) {
      if (!picked) return null;
      var o = { fit: 'contain', scale: 0.92, bg: 'transparent' };
      var color = U.isHexColor(d.color) ? d.color : MT.theme.colors.unknownChain;
      var ring = draftRing(d);
      var big = h('canvas'), small = h('canvas'), tiny = h('canvas');
      var render = function () {
        var cv = normalizeBadge(picked.img, o);
        var g = hidpi(big, 184, 184); drawBadge(g, cv, ring, 92, 92, 168);
        drawMarker(small, cv, color, 46, ring);
        var g3 = hidpi(tiny, 30, 30); drawBadge(g3, cv, ring, 15, 15, 28);
        return cv;
      };
      var fit = MT.ui.segmented({ ariaLabel: t('chains.logo.fit'), value: o.fit, options: [{ value: 'contain', label: t('chains.logo.contain') }, { value: 'cover', label: t('chains.logo.cover') }], onChange: function (v) { o.fit = v; render(); } });
      var bg = MT.ui.segmented({ ariaLabel: t('chains.logo.bg'), value: o.bg, options: [{ value: 'transparent', label: t('chains.logo.bgNone') }, { value: 'white', label: t('chains.logo.bgWhite') }, { value: color, label: t('chains.logo.bgBrand') }], onChange: function (v) { o.bg = v; render(); } });
      var range = h('input', { type: 'range', class: 'mt-range', min: '50', max: '150', step: '2', value: String(Math.round(o.scale * 100)), 'aria-label': t('chains.logo.zoom') });
      var pct = h('span', { class: 'mt-count' }, Math.round(o.scale * 100) + ' %');
      range.addEventListener('input', function () { o.scale = +range.value / 100; pct.textContent = range.value + ' %'; render(); });
      var body = h('div', { class: 'mt-chains-up' },
        h('div', { class: 'mt-chains-up__stage' }, big, h('div', { class: 'mt-chains-up__sizes' }, h('figure', null, small, h('figcaption', null, t('chains.logo.onMap'))), h('figure', null, tiny, h('figcaption', null, t('chains.logo.inLegend'))))),
        h('div', { class: 'mt-chains-up__controls' },
          h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('chains.logo.fit')), fit),
          h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('chains.logo.zoom'), ' ', pct), range),
          h('div', { class: 'mt-field' }, h('span', { class: 'mt-label' }, t('chains.logo.bg')), bg),
          h('p', { class: 'mt-hint' }, t('chains.logo.badgeTips'))));
      render();
      return MT.ui.modal({ title: t('chains.logo.badgeTitle', { name: d.name }), size: 'md', body: body, actions: [
        { label: t('common.cancel'), kind: 'secondary', value: null },
        { label: t('chains.logo.use'), kind: 'primary', icon: 'check', value: 'ok', autofocus: true },
      ] }).result.then(function (v) {
        if (v !== 'ok') return null;
        var url = normalizeBadge(picked.img, o).toDataURL('image/png');
        return MT.logos.set(d.id, { badge: url }).then(function () { MT.ui.toast(t('chains.logo.saved'), { type: 'success' }); return url; });
      });
    });
  }
  function uploadWide(preset) {
    var d = st.draft;
    var p = preset ? Promise.resolve(preset) : pickImage();
    return p.then(function (picked) {
      if (!picked) return null;
      var cv = normalizeWide(picked.img);
      var url = cv.toDataURL('image/png');
      var body = h('div', { class: 'mt-stack' },
        h('div', { class: 'mt-chains-up__wide', style: { borderColor: d.color } }, h('img', { src: url, alt: '' })),
        h('p', { class: 'mt-hint' }, t('chains.logo.wideDone', { w: cv.width, h: cv.height })));
      return MT.ui.modal({ title: t('chains.logo.wideTitle', { name: d.name }), size: 'sm', body: body, actions: [
        { label: t('common.cancel'), kind: 'secondary', value: null },
        { label: t('chains.logo.use'), kind: 'primary', icon: 'check', value: 'ok', autofocus: true },
      ] }).result.then(function (v) {
        if (v !== 'ok') return null;
        return MT.logos.set(d.id, { wide: url }).then(function () { MT.ui.toast(t('chains.logo.saved'), { type: 'success' }); return url; });
      });
    });
  }
  MT.chainsui.uploadBadge = uploadBadge;
  MT.chainsui.uploadWide = uploadWide;
  function removeLogo(kind) {
    var d = st.draft;
    var ov = MT.logos.overlay()[d.id] || {};
    var rest = {};
    if (kind === 'badge' && ov.wide) rest.wide = ov.wide;
    if (kind === 'wide' && ov.badge) rest.badge = ov.badge;
    var p = MT.logos.remove(d.id).then(function () { return Object.keys(rest).length ? MT.logos.set(d.id, rest) : null; });
    p.then(function () { MT.ui.toast(t('chains.logo.removed'), { type: 'success' }); });
  }

  /* =========================================================================================
   * Registration
   * ======================================================================================= */
  MT.app.registerTab({
    id: 'chains', labelKey: 'tab.chains', icon: 'store', order: 30, hash: 'cadenas',
    mount: mount,
  });
})();
