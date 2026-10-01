/* js/app.js — MT.app: application shell, tab registry, project menu, boot.
 *
 * Modules register before boot (their scripts load before the final MT.app.start() call):
 *   MT.app.registerTab({id:'maps', labelKey:'tab.maps', icon:'map', order:10, hash:'mapas',
 *                       mount(panelEl), onShow(), onHide()})   // mount runs once, lazily
 *   MT.app.addProjectMenuItem({id, labelKey, icon, group:'file'|'export'|'data', order,
 *                       shortcut, onClick(), enabled()→bool})
 * Events: 'app:ready' {}, 'tab:shown' {id}, 'app:showChanges' {} (user clicked the local-changes chip).
 * Built-in example: MT.app.openExampleProject() (asks before replacing work), exampleAvailable(),
 * isBlankProject().
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util, h = U.h;

  var tabs = [];
  var menuItems = [];
  var current = null;
  var els = {};

  var app = (MT.app = {
    booted: false,

    registerTab: function (def) {
      if (!def || !def.id) throw new Error('registerTab: id required');
      var existing = tabs.findIndex(function (t) { return t.id === def.id; });
      var tab = Object.assign({ order: 100, icon: 'layers', hash: def.id, mounted: false }, def);
      if (existing >= 0) tabs[existing] = tab; else tabs.push(tab);
      tabs.sort(function (a, b) { return a.order - b.order; });
      if (app.booted) renderTabs();
      return tab;
    },
    tabs: function () { return tabs.slice(); },
    currentTab: function () { return current; },

    addProjectMenuItem: function (item) {
      menuItems = menuItems.filter(function (m) { return m.id !== item.id; });
      menuItems.push(Object.assign({ group: 'file', order: 100 }, item));
    },

    /** Show a tab by id (mounting it on first use). */
    showTab: function (id, opts) {
      var tab = tabs.find(function (t) { return t.id === id; }) || tabs[0];
      if (!tab) return;
      if (current && current !== tab.id) {
        var prev = tabs.find(function (t) { return t.id === current; });
        if (prev && prev.onHide) safe(prev.onHide, prev);
      }
      current = tab.id;
      tabs.forEach(function (t) {
        var on = t.id === tab.id;
        if (t.button) { t.button.setAttribute('aria-selected', String(on)); t.button.tabIndex = on ? 0 : -1; t.button.classList.toggle('is-active', on); }
        if (t.panel) t.panel.hidden = !on;
      });
      if (!tab.mounted && tab.mount) {
        tab.mounted = true;
        safe(function () { tab.mount(tab.panel); MT.i18n.applyDom(tab.panel); }, tab);
      }
      if (tab.onShow) safe(tab.onShow, tab);
      MT.storage.setPref('lastTab', tab.id);
      if (!opts || opts.updateHash !== false) {
        var hash = '#' + tab.hash;
        if (location.hash !== hash) history.replaceState(null, '', hash);
      }
      MT.bus.emit('tab:shown', { id: tab.id });
    },

    /** Boot: wait for data, restore the project, render the shell. */
    start: function () {
      MT.i18n.applyDom(document);
      return MT.data.ready.then(function () {
        // Give a tab that is already open a moment to hear our 'hello' and write its last project
        // autosave before we read it (usually long over: loading the data takes longer).
        return MT.util.sleep(Math.max(0, HELLO_GRACE_MS - (Date.now() - helloAt)));
      }).then(function () {
        MT.project.restore();
        renderShell();
        var fromHash = tabs.find(function (t) { return '#' + t.hash === location.hash; });
        app.showTab(fromHash ? fromHash.id : MT.storage.pref('lastTab', tabs[0] && tabs[0].id));
        app.booted = true;
        document.body.classList.add('is-ready');
        var splash = U.$('#mt-splash');
        if (splash) { splash.classList.add('is-gone'); setTimeout(function () { splash.remove(); }, 300); }
        MT.bus.emit('app:ready', {});
        if (app.paused) showPaused();
        else if (otherTabPaused) noteOtherTabPaused();
      }).catch(function (err) {
        console.error('[app] boot failed', err);
        var splash = U.$('#mt-splash');
        if (splash) {
          splash.classList.add('is-error');
          U.clear(splash).appendChild(h('div', { class: 'mt-splash__box' },
            h('div', { class: 'mt-splash__title' }, MT.t('app.bootError')),
            h('pre', { class: 'mt-splash__detail' }, String(err && err.stack || err))));
        }
        throw err;
      });
    },
  });

  function safe(fn, tab) {
    try { fn(); } catch (err) {
      console.error('[app] tab "' + (tab && tab.id) + '" failed', err);
      if (tab && tab.panel && !tab.panel.childNodes.length) {
        tab.panel.appendChild(MT.ui.emptyState({ icon: 'warning', title: MT.t('app.tabError'), text: String(err.message || err) }));
      }
    }
  }

  /* ---- Shell ------------------------------------------------------------------------------- */
  function renderShell() {
    var root = U.$('#mt-app');
    U.clear(root);

    els.tabs = h('nav', { class: 'mt-tabs', role: 'tablist', 'aria-label': MT.t('app.sections'), 'data-i18n-aria': 'app.sections' });
    els.changes = h('button', { type: 'button', class: 'mt-changes', hidden: true, onclick: function () { MT.bus.emit('app:showChanges', {}); } });
    els.projectName = h('button', { type: 'button', class: 'mt-project__name', 'data-i18n-title': 'project.renameHint', title: MT.t('project.renameHint'), onclick: renameProject });
    els.dirty = h('span', { class: 'mt-project__dirty', 'data-i18n-title': 'project.unsaved', title: MT.t('project.unsaved'), hidden: true });
    els.menuBtn = h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'data-i18n-title': 'project.menu', 'data-i18n-aria': 'project.menu', title: MT.t('project.menu'), 'aria-label': MT.t('project.menu'), html: MT.ui.icon('more'), onclick: openProjectMenu });
    els.lang = MT.ui.segmented({
      ariaLabel: MT.t('app.language'), value: MT.i18n.lang,
      options: [{ value: 'es', label: 'ES', title: 'Español' }, { value: 'en', label: 'EN', title: 'English' }],
      onChange: function (v) { MT.i18n.setLang(v); },
    });
    els.lang.classList.add('mt-seg--compact', 'mt-lang');

    var header = h('header', { class: 'mt-topbar' },
      h('div', { class: 'mt-brand' },
        h('span', { class: 'mt-brand__mark', html: BRAND_SVG }),
        h('span', { class: 'mt-brand__name', 'data-i18n': 'app.name' }, MT.t('app.name'))),
      els.tabs,
      h('div', { class: 'mt-topbar__right' },
        els.changes,
        h('div', { class: 'mt-project' },
          h('span', { class: 'mt-project__icon', html: MT.ui.icon('file', { size: 16 }) }),
          els.projectName, els.dirty, els.menuBtn),
        els.lang));

    els.banner = h('div', { class: 'mt-banners' });
    els.main = h('main', { class: 'mt-main', id: 'mt-main' });
    root.appendChild(header);
    root.appendChild(els.banner);
    root.appendChild(els.main);

    tabs.forEach(function (t) {
      t.panel = h('section', { class: 'mt-tabpanel', id: 'panel-' + t.id, role: 'tabpanel', hidden: true, 'aria-labelledby': 'tab-' + t.id, 'data-tab': t.id });
      els.main.appendChild(t.panel);
    });
    renderTabs();
    renderBanners();
    updateProject();
    updateChanges();
  }

  function renderTabs() {
    if (!els.tabs) return;
    U.clear(els.tabs);
    tabs.forEach(function (t) {
      if (!t.panel) {
        t.panel = h('section', { class: 'mt-tabpanel', id: 'panel-' + t.id, role: 'tabpanel', hidden: true, 'aria-labelledby': 'tab-' + t.id, 'data-tab': t.id });
        els.main.appendChild(t.panel);
      }
      t.button = h('button', { type: 'button', role: 'tab', id: 'tab-' + t.id, class: 'mt-tab', 'aria-controls': 'panel-' + t.id, 'aria-selected': String(t.id === current), tabindex: t.id === current ? '0' : '-1', onclick: function () { app.showTab(t.id); } },
        MT.ui.iconEl(t.icon),
        h('span', { 'data-i18n': t.labelKey }, MT.t(t.labelKey)));
      els.tabs.appendChild(t.button);
    });
    // Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
    els.tabs.onkeydown = function (e) {
      var i = tabs.findIndex(function (t) { return t.id === current; });
      var n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (n === null) return;
      e.preventDefault();
      var t = tabs[(n + tabs.length) % tabs.length];
      app.showTab(t.id); t.button.focus();
    };
  }

  /* ---- Banners: browser storage not kept, data files missing --------------------------------- */
  function renderBanners() {
    U.clear(els.banner);
    renderStorageBanner();
    renderDataBanner();
  }
  /** Not kept between sessions: local database changes and the autosaved project would be lost. */
  function storageAtRisk() { return !MT.storage.persistent || !MT.storage.localUsable; }
  function renderStorageBanner() {
    if (!storageAtRisk() || storageBannerClosed) return;
    var actions = h('div', { class: 'mt-banner__actions' },
      MT.ui.button({ icon: 'save', label: MT.t('storage.atRisk.saveProject'), kind: 'secondary', size: 'sm', onClick: function () { app.saveProject(); } }),
      MT.dbui && MT.dbui.saveToFolder ? MT.ui.button({ icon: 'folder', label: MT.t('db.save.button'), kind: 'secondary', size: 'sm', onClick: function () { MT.dbui.saveToFolder(); } }) : null);
    var banner = h('div', { class: 'mt-banner mt-banner--error', role: 'alert' },
      MT.ui.iconEl('warning'),
      h('div', { class: 'mt-banner__body' },
        h('strong', null, MT.t('storage.atRisk.title')), ' ',
        h('span', null, MT.t('storage.notPersistent')),
        h('div', { class: 'mt-banner__hint' }, MT.t('storage.atRisk.hint')), actions),
      h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-btn--sm', title: MT.t('common.close'), 'aria-label': MT.t('common.close'), html: MT.ui.icon('close', { size: 16 }),
        onclick: function () { storageBannerClosed = true; banner.remove(); } }));
    els.banner.appendChild(banner);
  }
  var storageBannerClosed = false;
  // With storage that is not kept, leaving the page loses work: let the browser ask first.
  window.addEventListener('beforeunload', function (e) {
    if (!app.booted || app.paused || !storageAtRisk()) return;
    if (!MT.data.overlayStats().total && !MT.project.isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  function renderDataBanner() {
    var miss = MT.data.missing, files = [];
    if (miss.stores) files.push('data/stores.js');
    if (miss.chains) files.push('data/chains.js');
    if (miss.districts) files.push('data/districts.js');
    if (miss.logos) files.push('logos/logos.js');
    if (!files.length) return;
    var serious = miss.stores || miss.chains || miss.districts;
    var bits = [];
    if (miss.stores) bits.push(MT.t('banner.noStores'));
    if (miss.districts) bits.push(MT.t('banner.noDistricts'));
    if (miss.chains) bits.push(MT.t('banner.noChains'));
    if (miss.logos) bits.push(MT.t('banner.noLogos'));
    var banner = h('div', { class: 'mt-banner mt-banner--' + (serious ? 'warn' : 'info'), role: 'status' },
      MT.ui.iconEl(serious ? 'warning' : 'info'),
      h('div', { class: 'mt-banner__body' },
        h('strong', null, MT.t('banner.missingTitle', { n: files.length })), ' ',
        h('span', null, bits.join(' ')), ' ',
        h('span', { class: 'mt-banner__files' }, files.map(function (f) { return h('code', null, f); })),
        h('div', { class: 'mt-banner__hint' }, MT.t('banner.missingHint'))),
      h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-btn--sm', title: MT.t('common.close'), 'aria-label': MT.t('common.close'), html: MT.ui.icon('close', { size: 16 }), onclick: function () { banner.remove(); } }));
    els.banner.appendChild(banner);
  }

  /* ---- Project name / dirty / menu ---------------------------------------------------------- */
  function updateProject() {
    var p = MT.project.current();
    if (!p || !els.projectName) return;
    els.projectName.textContent = MT.project.displayName();
    els.projectName.classList.toggle('is-placeholder', !p.name);
    els.dirty.hidden = !MT.project.isDirty();
    document.title = (app.paused ? MT.t('app.paused.tabTitle') + ' · ' : '') + MT.project.displayName() + ' · ' + MT.t('app.name');
  }
  function updateChanges() {
    if (!els.changes) return;
    var st = MT.data.overlayStats();
    els.changes.hidden = !st.total;
    U.clear(els.changes);
    if (st.total) {
      els.changes.appendChild(h('span', { class: 'mt-changes__dot' }));
      els.changes.appendChild(document.createTextNode(MT.t('app.localChanges', { n: st.total })));
      els.changes.title = MT.t('app.localChangesHint');
    }
  }
  function renameProject() {
    MT.ui.prompt(MT.t('project.renameLabel'), { title: MT.t('project.rename'), value: MT.project.current().name, placeholder: MT.t('project.untitled'), okLabel: MT.t('common.save') })
      .then(function (v) { if (v) MT.project.rename(v); });
  }

  // Core project-menu entries; modules add theirs (exports, data…) with addProjectMenuItem().
  app.addProjectMenuItem({ id: 'new', group: 'file', order: 10, labelKey: 'project.new', icon: 'filePlus', onClick: function () { app.newProject(); } });
  app.addProjectMenuItem({ id: 'open', group: 'file', order: 20, labelKey: 'project.open', icon: 'folderOpen', shortcut: 'Ctrl+O', onClick: function () { app.openProject(); } });
  app.addProjectMenuItem({ id: 'example', group: 'file', order: 25, labelKey: 'project.example.menu', icon: 'slides',
    enabled: function () { return app.exampleAvailable(); }, onClick: function () { app.openExampleProject(); } });
  app.addProjectMenuItem({ id: 'save', group: 'file', order: 30, labelKey: 'project.save', icon: 'save', shortcut: 'Ctrl+S', onClick: function () { app.saveProject(); } });
  app.addProjectMenuItem({ id: 'saveAs', group: 'file', order: 40, labelKey: 'project.saveAs', icon: 'download', onClick: function () { app.saveProject({ saveAs: true }); } });
  app.addProjectMenuItem({ id: 'rename', group: 'file', order: 50, labelKey: 'project.rename', icon: 'edit', onClick: renameProject });

  var GROUP_ORDER = ['file', 'export', 'data', 'other'];
  /**
   * The project menu (core entries + everything modules registered). Other places that offer a
   * project menu (e.g. the Mapas rail) call this so every menu lists the same actions.
   */
  function openProjectMenu(anchor, opts) {
    var items = [], lastGroup = null;
    U.sortBy(menuItems.slice(), function (m) { return (GROUP_ORDER.indexOf(m.group) + 1) * 1000 + m.order; }).forEach(function (m) {
      if (lastGroup !== null && m.group !== lastGroup) items.push({ separator: true });
      lastGroup = m.group;
      items.push({ label: MT.t(m.labelKey), icon: m.icon, shortcut: m.shortcut, disabled: m.enabled ? !m.enabled() : false, onClick: m.onClick });
    });
    var a = anchor && anchor.nodeType === 1 ? anchor : els.menuBtn;
    return MT.ui.menu(a, items, Object.assign({ align: 'end', minWidth: 240 }, opts || {}));
  }
  app.openProjectMenu = openProjectMenu;
  app.renameProject = renameProject;

  app.newProject = function () {
    var go = function () { MT.project.newProject(); MT.ui.toast(MT.t('project.created'), { type: 'success' }); };
    if (!MT.project.isDirty()) { go(); return Promise.resolve(true); }
    return MT.ui.confirm(MT.t('project.discardText'), { title: MT.t('project.discardTitle'), okLabel: MT.t('project.discardOk'), danger: true })
      .then(function (ok) { if (ok) go(); return ok; });
  };
  app.openProject = function () {
    var go = function () {
      return MT.project.openDialog().then(function (p) {
        if (p) MT.ui.toast(MT.t('project.opened', { name: MT.project.displayName() }), { type: 'success' });
      }, function (err) {
        MT.ui.toast(MT.t(err && /project-(invalid|newer)/.test(err.message) ? 'project.' + err.message.replace('project-', 'error.') : 'project.error.open'), { type: 'error' });
      });
    };
    if (!MT.project.isDirty()) return go();
    return MT.ui.confirm(MT.t('project.discardText'), { title: MT.t('project.discardTitle'), okLabel: MT.t('project.discardOpen'), danger: true })
      .then(function (ok) { return ok ? go() : null; });
  };

  /* ---- Built-in example project (js/example-project.js → window.MT_EXAMPLE_PROJECT) ----------
   * Four slides mirroring the reference deck (Lima Metropolitana Sur, Lima Cono Sur, Trujillo,
   * Chimbote), generated from tools/fixtures/demo.mapa.json by tools/fixtures/build-example.mjs.
   * Opening it never silently replaces the user's work: unsaved changes → "save first?" dialog;
   * a saved project with content → a confirmation; a blank project → opens straight away. */
  app.exampleAvailable = function () {
    var p = window.MT_EXAMPLE_PROJECT;
    return !!(p && typeof p === 'object' && Array.isArray(p.maps) && p.maps.length);
  };
  /** True when the current project holds nothing worth keeping (a fresh "Nuevo proyecto"). */
  app.isBlankProject = function () {
    var p = MT.project.current();
    if (!p) return true;
    if (p.name || p.maps.length > 1) return false;
    return p.maps.every(function (m) {
      return !m.title && !m.peso && !(m.subtitleAuto === false && m.subtitle) && !(m.districts || []).length && !(m.radius || []).length;
    });
  };
  var exampleOpened = null;   // the project object the example became (unchanged → reopen without asking)
  app.openExampleProject = function () {
    if (!app.exampleAvailable()) {
      MT.ui.toast(MT.t('project.example.unavailable'), { type: 'error' });
      return Promise.resolve(false);
    }
    var go = function () {
      try {
        exampleOpened = MT.project.openData(window.MT_EXAMPLE_PROJECT, { name: MT.t('project.example.name') });
      } catch (err) {
        console.error('[app] example project', err);
        MT.ui.toast(MT.t('project.error.open'), { type: 'error' });
        return false;
      }
      if (app.currentTab() !== 'maps') app.showTab('maps');
      MT.ui.toast(MT.t('project.example.opened', { n: MT.project.maps().length }), { type: 'success', timeout: 7000 });
      return true;
    };
    var cur = MT.project.current();
    var dirty = MT.project.isDirty();
    if (!dirty && (app.isBlankProject() || cur === exampleOpened)) return Promise.resolve(go());
    var name = MT.project.displayName();
    var body = h('p', { class: 'mt-modal__text' }, MT.t(dirty ? 'project.example.saveText' : 'project.example.replaceText', { name: name }));
    var actions = dirty ? [
      { label: MT.t('common.cancel'), kind: 'secondary', value: 'cancel' },
      { label: MT.t('project.example.openWithoutSaving'), kind: 'danger', value: 'open' },
      { label: MT.t('project.example.saveAndOpen'), kind: 'primary', icon: 'save', value: 'save', autofocus: true },
    ] : [
      { label: MT.t('common.cancel'), kind: 'secondary', value: 'cancel' },
      { label: MT.t('project.example.open'), kind: 'primary', icon: 'slides', value: 'open', autofocus: true },
    ];
    return MT.ui.modal({ title: MT.t(dirty ? 'project.example.saveTitle' : 'project.example.replaceTitle'), body: body, size: 'md',
      className: 'mt-example-modal', actions: actions }).result.then(function (choice) {
      if (choice === 'open') return go();
      if (choice !== 'save') return false;
      return app.saveProject().then(function (r) {
        // Cancelled or failed save (saveProject already showed the error): keep the current project.
        if (!r) { MT.ui.toast(MT.t('project.example.notSaved'), { type: 'info' }); return false; }
        return go();
      });
    });
  };

  app.saveProject = function (opts) {
    return MT.project.save(opts).then(function (r) {
      if (r) MT.ui.toast(MT.t(r.method === 'file' ? 'project.savedFile' : 'project.savedDownload', { name: r.name }), { type: 'success' });
      return r;
    }, function (err) {
      console.error(err);
      MT.ui.toast(MT.t('project.error.save'), { type: 'error' });
    });
  };

  /* ---- Global listeners ----------------------------------------------------------------------- */
  MT.bus.on('project:loaded', updateProject);
  MT.bus.on('project:changed', updateProject);
  MT.bus.on('project:dirty', updateProject);
  MT.bus.on('project:saved', updateProject);
  // Once saved to a file the example is the user's project: replacing it asks again.
  MT.bus.on('project:saved', function () { exampleOpened = null; });
  ['stores:changed', 'chains:changed', 'logos:changed'].forEach(function (e) { MT.bus.on(e, updateChanges); });
  MT.bus.on('lang:changed', function () {
    if (!app.booted) return;
    updateProject(); updateChanges(); renderBanners();
    if (els.lang) els.lang.setValue(MT.i18n.lang);
  });
  window.addEventListener('hashchange', function () {
    var t = tabs.find(function (x) { return '#' + x.hash === location.hash; });
    if (t && t.id !== current) app.showTab(t.id, { updateHash: false });
  });
  document.addEventListener('keydown', function (e) {
    if (!app.booted || document.body.classList.contains('mt-has-modal')) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); app.saveProject(); }
    else if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); app.openProject(); }
    else if (e.altKey && /^[1-9]$/.test(e.key) && tabs[+e.key - 1]) { e.preventDefault(); app.showTab(tabs[+e.key - 1].id); }
  });

  /* ---- One working tab at a time ---------------------------------------------------------------
   * Every tab keeps the project and the local database changes in memory and writes them to the
   * same browser storage, so two working tabs (index.html double-clicked twice) would overwrite
   * each other's work. The newest tab works; an older one is PAUSED: it writes its pending
   * autosave right away, stops autosaving and shows a dialog whose only action reloads it — the
   * reload reads the latest project and database changes and pauses the other tab in turn. */
  var HELLO_GRACE_MS = 250;
  var born = (window.performance && performance.timeOrigin) || Date.now();
  var helloAt = Date.now();
  var otherTabPaused = false, pausedModal = null;
  app.paused = false;
  MT.storage.channel.on(function (msg) {
    if (msg.type === 'hello') {
      if (app.paused) return;
      var d = msg.data || {};
      var newer = d.born > born || (d.born === born && msg.from > MT.storage.channel.id);
      if (!newer) return;
      pauseThisTab();
      MT.storage.channel.post('paused', {});
    } else if (msg.type === 'paused') {
      if (app.booted && !app.paused) noteOtherTabPaused(); else otherTabPaused = true;
    }
  });
  MT.storage.channel.post('hello', { born: born });

  function pauseThisTab() {
    app.paused = true;
    MT.bus.emit('app:paused', {});            // modules write their debounced edits now
    MT.project.suspendAutosave(true);         // last autosave, then no more writes from this tab
    document.body.classList.add('mt-is-paused');
    if (app.booted) { showPaused(); updateProject(); }
  }
  function showPaused() {
    if (pausedModal) return;
    pausedModal = MT.ui.modal({ title: MT.t('app.paused.title'), size: 'md', dismissible: false, className: 'mt-paused-modal',
      body: h('div', { class: 'mt-stack mt-stack--sm' }, h('p', { class: 'mt-modal__text' }, MT.t('app.paused.text')), h('p', { class: 'mt-hint' }, MT.t('app.paused.hint'))),
      actions: [{ label: MT.t('app.paused.use'), kind: 'primary', icon: 'refresh', autofocus: true, onClick: function () { location.reload(); return false; } }] });
  }
  function noteOtherTabPaused() {
    otherTabPaused = false;
    MT.ui.toast(MT.t('app.paused.other'), { type: 'info', timeout: 9000 });
  }

  // Brand mark: a pin over a folded map, in the slide crimson.
  var BRAND_SVG = '<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><defs><linearGradient id="mtg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#D42A4C"/><stop offset="1" stop-color="#8E1631"/></linearGradient></defs>' +
    '<rect width="32" height="32" rx="8" fill="url(#mtg)"/><path d="M7 11.5 12.5 9.5l7 2.5 5.5-2v12.5l-5.5 2-7-2.5L7 24Z" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M16 23.2s-4.6-4-4.6-7.7a4.6 4.6 0 0 1 9.2 0c0 3.7-4.6 7.7-4.6 7.7Z" fill="#fff"/><circle cx="16" cy="15.4" r="1.7" fill="#B3203D"/></svg>';
})();
