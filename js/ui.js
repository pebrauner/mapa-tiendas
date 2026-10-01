/* js/ui.js — MT.ui: shared UI primitives (styled by css/core.css).
 *
 *   icon(name) → SVG markup string        iconEl(name) → <span class="mt-icon">
 *   toast(message, {type, timeout, action})            → {close}
 *   modal({title, body, actions, size, dismissible})   → {el, body, close(value), result:Promise}
 *   confirm(message, {title, okLabel, danger})         → Promise<boolean>
 *   prompt(message, {title, value, placeholder, validate}) → Promise<string|null>
 *   menu(anchor, items, {align})                        → {close}   (keyboard navigable)
 *   pickFile({accept, multiple})                        → Promise<File|File[]|null>
 *   busy({title, message, progress, cancellable})       → {update({progress, message}), close(), signal}
 *   switchEl / segmented / emptyState / button          small builders for consistent controls
 * Every string shown comes from MT.t() — pass already-translated text in.
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util, h = U.h;

  /* ---- Icons (24×24, stroke 1.75, currentColor) ------------------------------------------ */
  var P = {
    map: '<path d="M9 4 3 6.2v13.6L9 18l6 2 6-2.2V4.2L15 6 9 4Z"/><path d="M9 4v14M15 6v14"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-13"/><path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8"/>',
    store: '<path d="M3.5 9 5 4.5h14L20.5 9"/><path d="M3.5 9h17v1.2a2.85 2.85 0 0 1-5.67 0 2.85 2.85 0 0 1-5.66 0 2.85 2.85 0 0 1-5.67 0Z"/><path d="M5.2 12.6V20h13.6v-7.4"/><path d="M10 20v-4.5h4V20"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l.9 11.2A2 2 0 0 0 8.9 20h6.2a2 2 0 0 0 2-1.8L18 7M9 7V4.5h6V7"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
    save: '<path d="M5 3.5h10.5L20 8v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M8 3.5V8h7V3.5M7.5 20.5v-6h9v6"/>',
    folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.8l2 2.2h7.2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
    folderOpen: '<path d="M3.5 17V7.5a2 2 0 0 1 2-2h3.8l2 2.2h6.2a2 2 0 0 1 2 2V11"/><path d="M3.5 17.5 6 11.8a1.5 1.5 0 0 1 1.4-.9h13a1 1 0 0 1 .9 1.4l-2.4 5.5a1.5 1.5 0 0 1-1.4.9H4.4a1 1 0 0 1-.9-1.2Z"/>',
    file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 3.5V8h4.5"/>',
    filePlus: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 3.5V8h4.5M12 11v6M9 14h6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    more: '<circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5M12 3.5C9.6 5.9 8.4 8.7 8.4 12s1.2 6.1 3.6 8.5"/>',
    warning: '<path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 16.8h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8h.01"/>',
    success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/>',
    error: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2h.01"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeOff: '<path d="m3.5 3.5 17 17"/><path d="M10.3 5.7A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.7 16.7 0 0 1-2.9 3.7M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.9-1.4"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4.2 4.2"/>',
    grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5" stroke-dasharray="2.5 2"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 15.5-4.8-4.8-9.2 8.8"/>',
    slides: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8M14 4v12" opacity=".55"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
    refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 6.2 7.2L4.5 9M4.5 4.5V9H9M4.5 13a7.5 7.5 0 0 0 13.3 3.8l1.7-1.8M19.5 19.5V15H15"/>',
    edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10Z"/><path d="m13.5 6.5 4 4"/>',
    pin: '<path d="M12 20.5s-6.5-5.7-6.5-10.8a6.5 6.5 0 0 1 13 0c0 5.1-6.5 10.8-6.5 10.8Z"/><circle cx="12" cy="9.7" r="2.4"/>',
    undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
    layers: '<path d="m12 3.5 8.5 4.7L12 13 3.5 8.2Z"/><path d="m3.5 12.5 8.5 4.8 8.5-4.8M3.5 16.3l8.5 4.7 8.5-4.7" opacity=".7"/>',
    table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
    sliders: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    cloudOff: '<path d="m3.5 3.5 17 17"/><path d="M8.2 6.6A6 6 0 0 1 17.6 10h.4a3.8 3.8 0 0 1 2.2 6.9M16.5 18.5H7a4.5 4.5 0 0 1-1.4-8.8"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  };
  var ui = (MT.ui = {});
  ui.icons = Object.keys(P);
  ui.icon = function (name, opts) {
    var s = (opts && opts.size) || 18;
    return '<svg class="mt-svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (P[name] || P.info) + '</svg>';
  };
  ui.iconEl = function (name, opts) { return h('span', { class: 'mt-icon', html: ui.icon(name, opts) }); };

  /** <button> with optional icon. opts: {label, icon, kind:'primary'|'secondary'|'ghost'|'danger', size:'sm', title, onClick, i18n, i18nTitle}. */
  ui.button = function (opts) {
    var b = h('button', {
      type: 'button', class: 'mt-btn mt-btn--' + (opts.kind || 'secondary') + (opts.size ? ' mt-btn--' + opts.size : '') + (opts.label || opts.i18n ? '' : ' mt-btn--icon') + (opts.className ? ' ' + opts.className : ''),
      title: opts.title || null, onclick: opts.onClick || null, disabled: !!opts.disabled,
      'data-i18n-title': opts.i18nTitle || null, 'aria-label': opts.title || null,
    });
    if (opts.icon) b.appendChild(ui.iconEl(opts.icon));
    if (opts.label || opts.i18n) b.appendChild(h('span', { 'data-i18n': opts.i18n || null }, opts.label || MT.t(opts.i18n)));
    return b;
  };

  /* ---- Toasts ---------------------------------------------------------------------------- */
  var toastHost = null;
  ui.toast = function (message, opts) {
    opts = opts || {};
    if (!toastHost) { toastHost = h('div', { class: 'mt-toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
    var type = opts.type || 'info';
    var el = h('div', { class: 'mt-toast mt-toast--' + type },
      ui.iconEl(type === 'warn' ? 'warning' : type),
      h('div', { class: 'mt-toast__msg' }, message));
    var timer;
    var close = function () { clearTimeout(timer); el.classList.add('is-leaving'); setTimeout(function () { el.remove(); }, 180); };
    if (opts.action) {
      el.appendChild(h('button', { type: 'button', class: 'mt-toast__action', onclick: function () { close(); opts.action.onClick(); } }, opts.action.label));
    }
    el.appendChild(h('button', { type: 'button', class: 'mt-toast__close', 'aria-label': MT.t('common.close'), html: ui.icon('close', { size: 16 }), onclick: close }));
    el._mtClose = close;
    toastHost.appendChild(el);
    // At most 3 toasts at a time (quick successions of actions must not pile up over dialogs).
    var live = toastHost.querySelectorAll('.mt-toast:not(.is-leaving)');
    for (var i = 0; i < live.length - 3; i++) if (live[i]._mtClose) live[i]._mtClose();
    var timeout = opts.timeout === undefined ? (type === 'error' ? 8000 : 4000) : opts.timeout;
    if (timeout) timer = setTimeout(close, timeout);
    return { close: close, el: el };
  };

  /* ---- Modal ------------------------------------------------------------------------------- */
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var openModals = [];

  /**
   * opts: {title, body: Node|string, actions:[{label, kind, value, onClick(close)→false keeps open,
   * autofocus}], size:'sm'|'md'|'lg'|'xl', dismissible=true, className, onClose(value)}.
   */
  ui.modal = function (opts) {
    opts = opts || {};
    var resolveResult;
    var result = new Promise(function (r) { resolveResult = r; });
    var prevFocus = document.activeElement;
    var titleId = U.uid('mt-modal-title');
    var bodyEl = h('div', { class: 'mt-modal__body' });
    if (typeof opts.body === 'string') bodyEl.textContent = opts.body; else if (opts.body) bodyEl.appendChild(opts.body);
    var footer = null;
    if (opts.actions && opts.actions.length) {
      footer = h('div', { class: 'mt-modal__footer' }, opts.actions.map(function (a) {
        var btn = h('button', { type: 'button', class: 'mt-btn mt-btn--' + (a.kind || 'secondary'), 'data-autofocus': a.autofocus ? '' : null },
          a.icon ? ui.iconEl(a.icon) : null, h('span', null, a.label));
        btn.addEventListener('click', function () {
          if (a.onClick && a.onClick(close, btn) === false) return;
          close(a.value);
        });
        return btn;
      }));
    }
    var dismissible = opts.dismissible !== false;
    var dialog = h('div', { class: 'mt-modal mt-modal--' + (opts.size || 'md') + (opts.className ? ' ' + opts.className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': opts.title ? titleId : null },
      opts.title ? h('div', { class: 'mt-modal__header' },
        h('h2', { class: 'mt-modal__title', id: titleId }, opts.title),
        dismissible ? h('button', { type: 'button', class: 'mt-btn mt-btn--ghost mt-btn--icon mt-modal__x', 'aria-label': MT.t('common.close'), title: MT.t('common.close'), html: ui.icon('close'), onclick: function () { close(null); } }) : null) : null,
      bodyEl, footer);
    var backdrop = h('div', { class: 'mt-modal-backdrop' }, dialog);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop && dismissible) close(null); });
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(null); return; }
      if (e.key === 'Tab') {
        var f = U.$$(FOCUSABLE, dialog).filter(function (x) { return x.offsetParent !== null; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(backdrop);
    document.body.classList.add('mt-has-modal');
    openModals.push(backdrop);
    requestAnimationFrame(function () {
      backdrop.classList.add('is-open');
      var af = U.$('[data-autofocus]', dialog) || U.$('input,select,textarea', bodyEl) || U.$(FOCUSABLE, footer || dialog) || dialog;
      if (af === dialog) dialog.setAttribute('tabindex', '-1');
      af.focus();
    });
    var closed = false;
    function close(value) {
      if (closed) return;
      closed = true;
      backdrop.classList.remove('is-open');
      backdrop.classList.add('is-closing');   // fading out: clicks go through (CSS)
      setTimeout(function () { backdrop.remove(); }, 160);
      openModals.splice(openModals.indexOf(backdrop), 1);
      if (!openModals.length) document.body.classList.remove('mt-has-modal');
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (opts.onClose) opts.onClose(value);
      resolveResult(value === undefined ? null : value);
    }
    return { el: dialog, body: bodyEl, close: close, result: result };
  };

  ui.confirm = function (message, opts) {
    opts = opts || {};
    var body = typeof message === 'string' ? h('p', { class: 'mt-modal__text' }, message) : message;
    return ui.modal({
      title: opts.title || MT.t('common.confirmTitle'), body: body, size: 'sm',
      actions: [
        { label: opts.cancelLabel || MT.t('common.cancel'), kind: 'secondary', value: false },
        { label: opts.okLabel || MT.t('common.ok'), kind: opts.danger ? 'danger' : 'primary', value: true, autofocus: true },
      ],
    }).result.then(function (v) { return v === true; });
  };

  ui.prompt = function (message, opts) {
    opts = opts || {};
    // The visible label is tied to the input (for + id) so screen readers announce its name.
    var inputId = U.uid('mt-prompt'), errId = inputId + '-err';
    var input = h('input', { class: 'mt-input', type: 'text', id: inputId, value: opts.value || '', placeholder: opts.placeholder || '',
      'aria-label': message ? null : (opts.title || null), 'aria-describedby': errId });
    var err = h('div', { class: 'mt-field__error', role: 'alert', id: errId });
    var body = h('div', { class: 'mt-field' }, message ? h('label', { class: 'mt-label', for: inputId }, message) : null, input, err);
    var m = ui.modal({
      title: opts.title || '', body: body, size: 'sm',
      actions: [
        { label: opts.cancelLabel || MT.t('common.cancel'), kind: 'secondary', value: null },
        { label: opts.okLabel || MT.t('common.ok'), kind: 'primary', onClick: function (close) { return submit(close); } },
      ],
    });
    function submit(close) {
      var v = input.value.trim();
      var e = opts.validate ? opts.validate(v) : (!v && opts.required !== false ? MT.t('common.required') : '');
      if (e) { err.textContent = e; input.classList.add('is-invalid'); input.focus(); return false; }
      close(v);
      return false;
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(m.close); } });
    requestAnimationFrame(function () { input.select(); });
    return m.result;
  };

  /* ---- Dropdown menu ------------------------------------------------------------------------ */
  var openMenu = null;
  /**
   * items: [{label, icon, onClick, disabled, danger, checked, shortcut, hint} | {separator:true} | {heading}]
   * opts: {align:'start'|'end', minWidth}
   */
  ui.menu = function (anchor, items, opts) {
    opts = opts || {};
    if (openMenu) openMenu.close();
    var list = h('div', { class: 'mt-menu', role: 'menu' });
    var buttons = [];
    items.forEach(function (it) {
      if (!it) return;
      if (it.separator) { list.appendChild(h('div', { class: 'mt-menu__sep', role: 'separator' })); return; }
      if (it.heading) { list.appendChild(h('div', { class: 'mt-menu__heading' }, it.heading)); return; }
      var b = h('button', { type: 'button', role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem', class: 'mt-menu__item' + (it.danger ? ' is-danger' : ''), disabled: !!it.disabled, 'aria-checked': it.checked !== undefined ? String(!!it.checked) : null, tabindex: '-1' },
        h('span', { class: 'mt-menu__icon', html: it.icon ? ui.icon(it.icon, { size: 16 }) : (it.checked ? ui.icon('check', { size: 16 }) : '') }),
        h('span', { class: 'mt-menu__label' }, it.label, it.hint ? h('small', { class: 'mt-menu__hint' }, it.hint) : null),
        it.shortcut ? h('kbd', { class: 'mt-menu__kbd' }, it.shortcut) : null);
      b.addEventListener('click', function () { close(); if (it.onClick) it.onClick(); });
      buttons.push(b);
      list.appendChild(b);
    });
    if (opts.minWidth) list.style.minWidth = opts.minWidth + 'px';
    document.body.appendChild(list);
    var r = anchor.getBoundingClientRect(), mw = list.offsetWidth, mh = list.offsetHeight;
    var left = opts.align === 'end' ? r.right - mw : r.left;
    left = U.clamp(left, 8, window.innerWidth - mw - 8);
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    list.style.left = left + 'px'; list.style.top = top + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () { list.classList.add('is-open'); });

    var focusAt = function (i) { var en = buttons.filter(function (b) { return !b.disabled; }); if (en.length) en[(i + en.length) % en.length].focus(); };
    var onKey = function (e) {
      var en = buttons.filter(function (b) { return !b.disabled; }), i = en.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
      else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); anchor.focus(); }
    };
    var onDown = function (e) { if (!list.contains(e.target) && !anchor.contains(e.target)) close(); };
    list.addEventListener('keydown', onKey);
    setTimeout(function () { document.addEventListener('mousedown', onDown, true); }, 0);
    window.addEventListener('resize', close, { once: true });
    focusAt(0);
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', onDown, true);
      anchor.setAttribute('aria-expanded', 'false');
      list.remove();
      if (openMenu && openMenu.el === list) openMenu = null;
    }
    openMenu = { el: list, close: close };
    return openMenu;
  };

  /* ---- File picker --------------------------------------------------------------------------- */
  ui.pickFile = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var input = h('input', { type: 'file', accept: opts.accept || null, multiple: !!opts.multiple, style: { display: 'none' } });
      var done = false;
      input.addEventListener('change', function () {
        done = true;
        var files = Array.prototype.slice.call(input.files || []);
        input.remove();
        resolve(opts.multiple ? files : (files[0] || null));
      });
      // 'cancel' fires in Chromium when the dialog is dismissed.
      input.addEventListener('cancel', function () { if (!done) { input.remove(); resolve(opts.multiple ? [] : null); } });
      document.body.appendChild(input);
      input.click();
    });
  };

  /* ---- Busy / progress overlay --------------------------------------------------------------- */
  ui.busy = function (opts) {
    opts = opts || {};
    var ctrl = opts.cancellable ? new AbortController() : null;
    var bar = h('div', { class: 'mt-progress' + (opts.progress ? '' : ' is-indeterminate'), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { class: 'mt-progress__bar' }));
    var msg = h('div', { class: 'mt-busy__msg' }, opts.message || '');
    var box = h('div', { class: 'mt-busy', role: 'alertdialog', 'aria-live': 'polite', 'aria-busy': 'true' },
      h('div', { class: 'mt-busy__title' }, opts.title || MT.t('common.working')), msg, bar,
      ctrl ? h('div', { class: 'mt-busy__actions' }, h('button', { type: 'button', class: 'mt-btn mt-btn--secondary mt-btn--sm', onclick: function () { ctrl.abort(); handle.close(); } }, MT.t('common.cancel'))) : null);
    var overlay = h('div', { class: 'mt-busy-backdrop' }, box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    var handle = {
      signal: ctrl ? ctrl.signal : null,
      update: function (u) {
        if (u.message !== undefined) msg.textContent = u.message;
        if (u.progress !== undefined) {
          bar.classList.remove('is-indeterminate');
          var pct = Math.round(U.clamp(u.progress, 0, 1) * 100);
          bar.firstChild.style.width = pct + '%';
          bar.setAttribute('aria-valuenow', String(pct));
        }
      },
      // While it fades out (160 ms) the overlay must not swallow the user's next click.
      close: function () { overlay.classList.remove('is-open'); overlay.classList.add('is-closing'); setTimeout(function () { overlay.remove(); }, 160); },
    };
    return handle;
  };

  /* ---- Small control builders ------------------------------------------------------------------ */
  /** Toggle switch: <label class="mt-switch"><input type=checkbox role=switch>…</label>. */
  ui.switchEl = function (opts) {
    var input = h('input', { type: 'checkbox', role: 'switch', checked: !!opts.checked, id: opts.id || null });
    input.addEventListener('change', function () { if (opts.onChange) opts.onChange(input.checked); });
    return h('label', { class: 'mt-switch' + (opts.className ? ' ' + opts.className : '') }, input,
      h('span', { class: 'mt-switch__track', 'aria-hidden': 'true' }),
      opts.label || opts.i18n ? h('span', { class: 'mt-switch__label', 'data-i18n': opts.i18n || null }, opts.label || MT.t(opts.i18n)) : null);
  };

  /** Segmented control (radio group). options: [{value, label|i18n, icon, title}]. */
  ui.segmented = function (opts) {
    var name = U.uid('seg');
    var wrap = h('div', { class: 'mt-seg', role: 'radiogroup', 'aria-label': opts.ariaLabel || null });
    opts.options.forEach(function (o) {
      var input = h('input', { type: 'radio', name: name, value: o.value, checked: o.value === opts.value, class: 'mt-seg__input' });
      input.addEventListener('change', function () { if (input.checked && opts.onChange) opts.onChange(o.value); });
      wrap.appendChild(h('label', { class: 'mt-seg__opt', title: o.title || null },
        input, h('span', { class: 'mt-seg__face' }, o.icon ? ui.iconEl(o.icon, { size: 16 }) : null,
          o.label || o.i18n ? h('span', { 'data-i18n': o.i18n || null }, o.label || MT.t(o.i18n)) : null)));
    });
    wrap.setValue = function (v) { U.$$('input', wrap).forEach(function (i) { i.checked = i.value === String(v); }); };
    return wrap;
  };

  /** Empty / placeholder state block. opts: {icon, title|titleKey, text|textKey, action, className}. */
  ui.emptyState = function (opts) {
    return h('div', { class: 'mt-empty' + (opts.className ? ' ' + opts.className : '') },
      opts.icon ? h('div', { class: 'mt-empty__icon', html: ui.icon(opts.icon, { size: 28 }) }) : null,
      opts.title || opts.titleKey ? h('div', { class: 'mt-empty__title', 'data-i18n': opts.titleKey || null }, opts.title || MT.t(opts.titleKey)) : null,
      opts.text || opts.textKey ? h('div', { class: 'mt-empty__text', 'data-i18n': opts.textKey || null }, opts.text || MT.t(opts.textKey)) : null,
      opts.action || null);
  };

  /** Chain colour dot / logo chip used in lists: <span class="mt-chain-chip">. */
  ui.chainChip = function (chainId, opts) {
    var c = MT.data.chain(chainId), l = MT.logos.get(chainId);
    return h('span', { class: 'mt-chain-chip' + (opts && opts.compact ? ' is-compact' : ''), title: c.name },
      h('img', { class: 'mt-chain-chip__logo', src: l.badge, alt: '', style: { borderColor: c.color } }),
      opts && opts.compact ? null : h('span', { class: 'mt-chain-chip__name' }, c.name));
  };
})();
