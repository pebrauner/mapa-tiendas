/* js/export-png.js — MT.export.png + the shared export plumbing (dialog, progress, file names,
 * zip, downloads). Module M4. export-pptx.js and export-html.js build on MT.export.util.
 *
 * CONTRACT (docs/ARCHITECTURE.md §6.4, SPEC §4.4):
 *   MT.export.png(mapIds, {kind:'map'|'slide', scale, width, ...}) → Promise<{files:[name]}>
 *     kind 'map'   → MT.render.mapCanvas(map, {scale: 2|3|4}) (default MT.theme.export.mapScale)
 *     kind 'slide' → MT.render.slideCanvas(map, {width: 3840|1920}) (default MT.theme.export.slideWidth)
 *     One PNG per map. Several maps → ONE .zip (JSZip from the PptxGenJS bundle), else one download
 *     per file. PNGs carry their physical size (pHYs): a slide PNG inserted in PowerPoint fills the
 *     slide, a map PNG has exactly the size of the map frame (7.75 in).
 *   Common options of png/pptx/html: {download=true, ui=true, signal, onProgress(fraction, message)}.
 *     ui:true shows MT.ui.busy (cancellable) and a success/error toast; errors still reject
 *     (err.code, err.shown=true when a toast was shown). download:false → result also has `blobs`.
 *   mapIds: array of map ids | a single id | 'all' | null (= current map).
 *
 *   MT.export.dialog({format?, mapIds?}) → Promise<result|null>   the export dialog (formats, maps,
 *     resolution) used by the project menu; M2's export button should open it too.
 *   MT.export.run(format, mapIds, opts) → Promise<result|null>   UI-level call that never rejects.
 *     format: 'pptx' | 'slide' (PNG slide) | 'map' (PNG map) | 'html'.
 *   Event 'export:done' {format, files}.
 */
(function () {
  'use strict';
  const MT = window.MT, U = MT.util, h = U.h;
  const X = (MT.export = MT.export || {});

  /* ---- Map selection & file names --------------------------------------------------------------- */
  function exportError(code, extra) {
    const e = new Error(code);
    e.code = code;
    return Object.assign(e, extra || {});
  }
  function abortError() { return MT.geo && MT.geo.abortError ? MT.geo.abortError() : new DOMException('Aborted', 'AbortError'); }
  function isAbort(err) { return !!err && (err.name === 'AbortError' || err.code === 'aborted'); }

  /** Map configs for mapIds (array | id | 'all' | null = current map). Throws 'no-maps'. */
  function resolveMaps(mapIds) {
    let ids;
    if (mapIds === 'all') ids = MT.project.maps().map((m) => m.id);
    else if (Array.isArray(mapIds)) ids = mapIds;
    else if (typeof mapIds === 'string') ids = [mapIds];
    else ids = MT.project.currentMapId() ? [MT.project.currentMapId()] : [];
    const maps = ids.map((id) => MT.project.getMap(id)).filter(Boolean);
    if (!maps.length) throw exportError('no-maps');
    return maps;
  }
  function mapTitle(cfg) { return String((cfg && cfg.title) || '').trim() || MT.t('project.untitledMap'); }
  function projectName() {
    const p = MT.project.current();
    return String((p && p.name) || '').trim() || MT.t('project.untitled');
  }
  /** Readable, file-system-safe base name (accents kept: "Lima Metropolitana Sur"). */
  function safe(name) { return MT.io.safeFilename(name, 'mapa'); }
  /** Make names unique inside one batch ("x.png", "x (2).png"). */
  function uniqueNames(names) {
    const seen = {};
    return names.map((n) => {
      const key = n.toLowerCase();
      if (!seen[key]) { seen[key] = 1; return n; }
      seen[key] += 1;
      const dot = n.lastIndexOf('.');
      return dot > 0 ? n.slice(0, dot) + ' (' + seen[key] + ')' + n.slice(dot) : n + ' (' + seen[key] + ')';
    });
  }
  /** The file names an export will produce (the dialog shows them before exporting). */
  const names = {
    pptx(maps) { return safe(maps.length === 1 ? mapTitle(maps[0]) : projectName()) + '.pptx'; },
    html(maps) { return safe((maps.length === 1 ? mapTitle(maps[0]) : projectName()) + ' - ' + MT.t('export.file.interactive')) + '.html'; },
    pngEntries(maps, kind) {
      const suffix = MT.t(kind === 'map' ? 'export.file.map' : 'export.file.slide');
      const pad = String(maps.length).length < 2 ? 2 : String(maps.length).length;
      return uniqueNames(maps.map((m, i) => safe((maps.length > 1 ? String(i + 1).padStart(pad, '0') + ' ' : '') + mapTitle(m) + ' - ' + suffix) + '.png'));
    },
    pngZip(kind) { return safe(projectName() + ' - ' + MT.t(kind === 'map' ? 'export.file.mapsZip' : 'export.file.slidesZip')) + '.zip'; },
  };

  /* ---- Progress / cancellation ------------------------------------------------------------------- */
  /**
   * A running export: merged abort signal, MT.ui.busy overlay (opts.ui), progress callback.
   * step(i, n, frac, key, vars) reports "map i of n" progress.
   */
  function job(opts) {
    const ctrl = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let busy = null;
    if (opts.ui) {
      busy = MT.ui.busy({ title: MT.t(opts.titleKey), progress: true, cancellable: true });
      if (busy.signal) busy.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let last = 0;
    const j = {
      signal: ctrl.signal,
      progress(frac, message) {
        last = Math.max(last, U.clamp(frac, 0, 1));
        if (busy) busy.update({ progress: last, message: message });
        if (opts.onProgress) { try { opts.onProgress(last, message); } catch (e) { /* caller's problem */ } }
      },
      step(i, n, frac, key, vars) {
        j.progress((i + frac) / n, MT.t('export.step.' + key, Object.assign({ i: i + 1, n: n }, vars || {})));
      },
      check() { if (ctrl.signal.aborted) throw abortError(); },
      close() { if (busy) { busy.close(); busy = null; } },
    };
    return j;
  }
  /** Let the busy overlay paint before heavy synchronous work. */
  function breathe() { return new Promise((r) => setTimeout(r, 16)); }

  /** Translated, user-facing message for an export error. */
  function errorMessage(err) {
    if (!err) return MT.t('export.error.generic', { detail: '' });
    if (err.messageKey && MT.i18n.has(err.messageKey)) return MT.t(err.messageKey);
    if (err.code === 'no-maps') return MT.t('export.error.noMaps');
    if (err.code === 'lib-unavailable') return MT.t('export.error.lib');
    return MT.t('export.error.generic', { detail: err.message || String(err) });
  }
  /** Shared ending of an export: toast + event (ui), or the error toast. */
  function finish(j, opts, format, result) {
    j.close();
    if (opts.ui) {
      const n = result.files.length;
      MT.ui.toast(n === 1 ? MT.t('export.done.one', { name: result.files[0] }) : MT.t('export.done.many', { n: n }), { type: 'success' });
    }
    MT.bus.emit('export:done', { format: format, files: result.files.slice() });
    return result;
  }
  function fail(j, opts, err) {
    j.close();
    if (isAbort(err)) {
      if (opts.ui) MT.ui.toast(MT.t('export.cancelled'), { type: 'info' });
    } else {
      // Expected failures (no network, nothing to export) are not bugs: warn, do not error-log.
      if (err && (err.messageKey || err.code)) console.warn('[export]', err.code || err.message, err.cause || '');
      else console.error('[export] failed', err);
      if (opts.ui) { MT.ui.toast(errorMessage(err), { type: 'error' }); if (err && typeof err === 'object') err.shown = true; }
    }
    throw err;
  }

  /* ---- Files: PNG physical size, zip, download ----------------------------------------------------- */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, start, end) {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /**
   * Add a pHYs chunk (pixels per metre) right after IHDR so Office/Windows know the image's
   * physical size. Returns the original blob when it is not a plain PNG or already has pHYs.
   */
  async function pngWithDpi(blob, dpi) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const isPng = buf.length > 33 && buf[0] === 0x89 && buf[1] === 0x50 && buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52;
    if (!isPng || !(dpi > 0)) return blob;
    // Scan the chunks before IDAT for an existing pHYs.
    const dv0 = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let p = 8; p + 8 <= buf.length;) {
      const len = dv0.getUint32(p), type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      if (type === 'pHYs') return blob;
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);           // "pHYs"
    dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;   // unit: metre
    dv.setUint32(17, crc32(chunk, 4, 17));
    return new Blob([buf.subarray(0, 33), chunk, buf.subarray(33)], { type: 'image/png' });
  }

  /** JSZip ships inside the PptxGenJS bundle (window.JSZip once it is loaded). */
  async function zipLib() {
    if (window.JSZip) return window.JSZip;
    try { await MT.vendor.pptx(); } catch (e) { return null; }
    return window.JSZip || null;
  }
  /**
   * Hand files to the user. Several files → one zip when possible (one download prompt, no
   * "allow multiple downloads" question), otherwise one download per file.
   * files: [{name, blob}] → {files:[downloaded names], entries:[names inside], blobs?}
   */
  async function deliver(files, opts) {
    let out = files;
    if (files.length > 1 && opts.zipName) {
      const JSZip = await zipLib();
      if (JSZip) {
        const zip = new JSZip();
        files.forEach((f) => zip.file(f.name, f.blob, { binary: true }));
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
        out = [{ name: opts.zipName, blob: blob }];
      } else if (opts.ui) {
        MT.ui.toast(MT.t('export.error.multiDownload'), { type: 'info' });
      }
    }
    if (opts.download !== false) {
      for (let i = 0; i < out.length; i++) {
        MT.io.download(out[i].blob, out[i].name);
        if (i < out.length - 1) await U.sleep(450);   // browsers drop rapid-fire downloads
      }
    }
    const res = { files: out.map((f) => f.name), entries: files.map((f) => f.name) };
    if (opts.download === false) res.blobs = out;
    return res;
  }

  /* ---- PNG export -------------------------------------------------------------------------------------- */
  function optsWithDefaults(opts) {
    return Object.assign({ download: true, ui: true }, opts || {});
  }

  /** PNG of each map (map frame only, or the full slide). */
  async function png(mapIds, opts) {
    opts = optsWithDefaults(opts);
    const kind = opts.kind === 'map' ? 'map' : 'slide';
    const th = MT.theme;
    const scale = U.clamp(+opts.scale || th.export.mapScale || 3, 1, 4);
    const width = Math.round(+opts.width || th.export.slideWidth || 3840);
    let maps;
    try { maps = resolveMaps(mapIds); } catch (e) { return fail(job({}), opts, e); }
    const j = job({ ui: opts.ui, signal: opts.signal, onProgress: opts.onProgress, titleKey: 'export.busy.png' });
    try {
      await breathe();
      await MT.data.ready;
      const entryNames = names.pngEntries(maps, kind);
      const files = [];
      for (let i = 0; i < maps.length; i++) {
        const cfg = maps[i];
        j.check();
        j.step(i, maps.length, 0.05, kind === 'map' ? 'basemap' : 'slide', { title: mapTitle(cfg) });
        let canvas, dpi;
        if (kind === 'map') {
          canvas = (await MT.render.mapCanvas(cfg, { scale: scale })).canvas;
          dpi = canvas.width / th.mapFrame.w;
        } else {
          canvas = await MT.render.slideCanvas(cfg, { width: width });
          dpi = canvas.width / th.slide.width;
        }
        j.check();
        j.step(i, maps.length, 0.85, 'packing');
        const blob = await pngWithDpi(await MT.io.canvasToBlob(canvas, 'image/png'), dpi);
        canvas.width = canvas.height = 0;     // free the (large) backing store early
        files.push({ name: entryNames[i], blob: blob });
      }
      j.progress(0.97, MT.t('export.step.packing'));
      const res = await deliver(files, { zipName: names.pngZip(kind), download: opts.download, ui: opts.ui });
      j.progress(1);
      return finish(j, opts, kind === 'map' ? 'png-map' : 'png-slide', res);
    } catch (err) { return fail(j, opts, err); }
  }

  /* ---- Export dialog ------------------------------------------------------------------------------------ */
  const FORMATS = [
    { id: 'pptx', icon: 'slides', ext: '.pptx' },
    { id: 'slide', icon: 'image', ext: '.png' },
    { id: 'map', icon: 'map', ext: '.png' },
    { id: 'html', icon: 'globe', ext: '.html' },
  ];
  const CSS = `
.mt-export { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--mt-s6); align-items: start; }
@media (max-width: 760px) { .mt-export { grid-template-columns: minmax(0, 1fr); gap: var(--mt-s5); } }
.mt-export__label { display: flex; align-items: center; justify-content: space-between; gap: var(--mt-s2); min-height: 26px; margin: 0 0 var(--mt-s2); font-size: var(--mt-fs-xs); font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--mt-g500); }
.mt-export__label-actions { display: inline-flex; gap: 2px; text-transform: none; letter-spacing: 0; }
.mt-export__formats { display: grid; gap: var(--mt-s2); }
.mt-export__fmt { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: start; gap: var(--mt-s3); padding: 12px 14px 12px 12px; border: 1px solid var(--mt-border); border-radius: var(--mt-r-lg); background: var(--mt-surface); cursor: pointer; transition: border-color var(--mt-fast) var(--mt-ease), background var(--mt-fast) var(--mt-ease), box-shadow var(--mt-fast) var(--mt-ease); }
.mt-export__fmt:hover { border-color: var(--mt-g400); }
.mt-export__fmt > input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.mt-export__fmt-icon { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; background: var(--mt-g100); color: var(--mt-g600); transition: background var(--mt-med) var(--mt-ease), color var(--mt-med) var(--mt-ease); }
.mt-export__fmt-name { display: block; font-weight: 650; color: var(--mt-g900); line-height: 1.3; }
.mt-export__fmt-desc { display: block; margin-top: 2px; font-size: var(--mt-fs-sm); color: var(--mt-g600); line-height: 1.4; }
.mt-export__ext { margin-top: 1px; padding: 2px 6px; border-radius: 5px; background: var(--mt-g100); color: var(--mt-g500); font-family: var(--mt-font-mono); font-size: 11px; line-height: 1.5; }
.mt-export__fmt.is-checked { border-color: var(--mt-accent); background: var(--mt-accent-soft); box-shadow: inset 0 0 0 1px var(--mt-accent); }
.mt-export__fmt.is-checked .mt-export__fmt-icon { background: var(--mt-accent-gradient); color: #fff; box-shadow: 0 2px 8px -2px rgba(142, 22, 49, .45); }
.mt-export__fmt.is-checked .mt-export__ext { background: var(--mt-surface); color: var(--mt-accent-press); }
.mt-export__fmt:has(> input:focus-visible) { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.mt-export__maps { display: grid; gap: 1px; max-height: 236px; overflow: auto; padding: 4px; border: 1px solid var(--mt-border); border-radius: var(--mt-r); background: var(--mt-g50); }
.mt-export__map { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 36px; padding: 5px 9px; border-radius: var(--mt-r-sm); cursor: pointer; }
.mt-export__map:hover { background: var(--mt-surface); }
.mt-export__map > input { width: 16px; height: 16px; margin: 0; accent-color: var(--mt-accent); cursor: pointer; }
.mt-export__map-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mt-export__map-num { flex: none; min-width: 18px; color: var(--mt-g400); font-size: var(--mt-fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
.mt-export__map-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; color: var(--mt-g800); }
.mt-export__map-meta { font-size: var(--mt-fs-xs); color: var(--mt-g500); font-variant-numeric: tabular-nums; white-space: nowrap; }
.mt-export__map-meta.is-empty, .mt-export__map-meta.is-warn { color: var(--mt-warn); }
.mt-export__opts { margin-top: var(--mt-s5); }
.mt-export__res { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px; }
.mt-export__res-opt { position: relative; display: flex; flex-direction: column; gap: 1px; padding: 8px 10px; border: 1px solid var(--mt-border); border-radius: var(--mt-r); background: var(--mt-surface); cursor: pointer; transition: border-color var(--mt-fast) var(--mt-ease), background var(--mt-fast) var(--mt-ease); }
.mt-export__res-opt:hover { border-color: var(--mt-g400); }
.mt-export__res-opt > input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.mt-export__res-name { font-weight: 650; font-size: var(--mt-fs-sm); color: var(--mt-g900); }
.mt-export__res-sub { font-size: var(--mt-fs-xs); color: var(--mt-g500); font-variant-numeric: tabular-nums; white-space: nowrap; }
.mt-export__res-opt.is-checked { border-color: var(--mt-accent); background: var(--mt-accent-soft); box-shadow: inset 0 0 0 1px var(--mt-accent); }
.mt-export__res-opt:has(> input:focus-visible) { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.mt-export__tip { display: flex; gap: 9px; align-items: flex-start; margin-top: var(--mt-s4); padding: 10px 12px; border-radius: var(--mt-r); background: var(--mt-g50); border: 1px solid var(--mt-border); font-size: var(--mt-fs-sm); color: var(--mt-g600); line-height: 1.45; }
.mt-export__tip .mt-icon { flex: none; margin-top: 1px; color: var(--mt-g400); }
.mt-export__tip--warn { background: var(--mt-warn-soft); border-color: rgba(180, 83, 9, .22); color: #7C3A06; }
.mt-export__tip--warn .mt-icon { color: var(--mt-warn); }
.mt-export__tip[hidden] { display: none; }
.mt-export__summary { margin-right: auto; align-self: center; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--mt-fs-sm); color: var(--mt-g600); }
.mt-export__summary.is-error { color: var(--mt-danger); font-weight: 550; }
`;
  function ensureCss() {
    if (document.getElementById('mt-export-css')) return;
    document.head.appendChild(h('style', { id: 'mt-export-css' }, CSS));
  }

  function pref(key, fallback) { return MT.storage && MT.storage.pref ? MT.storage.pref(key, fallback) : fallback; }
  function setPref(key, value) { if (MT.storage && MT.storage.setPref) MT.storage.setPref(key, value); }

  /**
   * The export dialog: format cards, map checklist (with visible-store counts), resolution for PNG,
   * a one-line summary of what will be downloaded. Resolves with the export result or null.
   */
  function dialog(o) {
    o = o || {};
    ensureCss();
    const all = MT.project.maps();
    if (!all.length) { MT.ui.toast(MT.t('export.error.noMaps'), { type: 'warn' }); return Promise.resolve(null); }
    const th = MT.theme, F = MT.layout.frame();
    const state = {
      format: FORMATS.some((f) => f.id === o.format) ? o.format : pref('export.format', 'pptx'),
      scale: U.clamp(+pref('export.mapScale', th.export.mapScale || 3), 2, 4),
      width: +pref('export.slideWidth', th.export.slideWidth || 3840),
    };
    if ((th.export.slideWidths || [3840, 1920]).indexOf(state.width) < 0) state.width = th.export.slideWidth || 3840;
    const currentId = MT.project.currentMapId();
    const initial = o.mapIds === 'all' ? all.map((m) => m.id) : Array.isArray(o.mapIds) ? o.mapIds : o.mapIds ? [o.mapIds] : currentId ? [currentId] : [all[0].id];
    const chosen = new Set(initial.filter((id) => MT.project.getMap(id)));

    // Formats
    const fmtName = U.uid('mt-export-fmt');
    const fmtCards = FORMATS.map((f) => {
      const input = h('input', { type: 'radio', name: fmtName, value: f.id, checked: f.id === state.format });
      const card = h('label', { class: 'mt-export__fmt', dataset: { format: f.id } },
        input,
        h('span', { class: 'mt-export__fmt-icon', html: MT.ui.icon(f.icon, { size: 20 }) }),
        h('span', null,
          h('span', { class: 'mt-export__fmt-name' }, MT.t('export.format.' + f.id + '.name')),
          h('span', { class: 'mt-export__fmt-desc' }, MT.t('export.format.' + f.id + '.desc'))),
        h('span', { class: 'mt-export__ext' }, f.ext));
      input.addEventListener('change', () => { if (input.checked) { state.format = f.id; refresh(); } });
      return card;
    });
    const formats = h('div', { class: 'mt-export__formats', role: 'radiogroup', 'aria-label': MT.t('export.dialog.format') }, fmtCards);

    // Maps
    const pad = String(all.length).length;
    const metas = {};
    const checks = {};
    const mapRows = all.map((m, i) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(m.id) });
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(m.id); else chosen.delete(m.id); refresh(); });
      checks[m.id] = cb;
      metas[m.id] = h('span', { class: 'mt-export__map-meta' }, '');
      return h('label', { class: 'mt-export__map', title: mapTitle(m) },
        cb,
        h('span', { class: 'mt-export__map-main' },
          h('span', { class: 'mt-export__map-num' }, String(i + 1).padStart(pad, '0')),
          h('span', { class: 'mt-export__map-title' }, mapTitle(m)),
          m.id === currentId && all.length > 1 ? h('span', { class: 'mt-badge mt-badge--accent' }, MT.t('export.dialog.current')) : null),
        metas[m.id]);
    });
    const setAll = (on) => { all.forEach((m) => { checks[m.id].checked = on; if (on) chosen.add(m.id); else chosen.delete(m.id); }); refresh(); };
    const mapsHead = h('div', { class: 'mt-export__label' },
      h('span', null, MT.t('export.dialog.maps')),
      all.length > 1 ? h('span', { class: 'mt-export__label-actions' },
        MT.ui.button({ label: MT.t('export.dialog.selectAll'), kind: 'ghost', size: 'sm', onClick: () => setAll(true) }),
        MT.ui.button({ label: MT.t('export.dialog.selectNone'), kind: 'ghost', size: 'sm', onClick: () => setAll(false) })) : null);
    const mapsBox = h('div', { class: 'mt-export__maps', role: 'group', 'aria-label': MT.t('export.dialog.mapsAria') }, mapRows);

    // Options (resolution) + tip
    const opts = h('div', { class: 'mt-export__opts' });
    const tip = h('div', { class: 'mt-export__tip' });
    // Crowded slides: stores whose logo found no room near the store are drawn as dots.
    const crowd = {};                 // map id → {n, dots}
    const crowdNote = h('div', { class: 'mt-export__tip mt-export__tip--warn', hidden: true, role: 'note' });
    const isCrowded = (c) => c && c.dots >= Math.max(3, c.n * 0.05);
    function resChoices() {
      const name = U.uid('mt-export-res');
      let list;
      if (state.format === 'map') {
        list = (th.export.mapScales || [2, 3, 4]).map((s) => ({
          value: s, checked: s === state.scale, title: MT.t('export.res.scale', { n: s }) + ' · ' + MT.t('export.res.mapHint.' + s),
          sub: MT.t('export.res.px', { w: Math.round(F.width * s), h: Math.round(F.height * s) }), set: () => { state.scale = s; setPref('export.mapScale', s); },
        }));
      } else {
        list = (th.export.slideWidths || [3840, 1920]).slice().sort((a, b) => a - b).map((w) => ({
          value: w, checked: w === state.width, title: MT.t(w >= 3000 ? 'export.res.slide3840' : 'export.res.slide1920'),
          sub: MT.t('export.res.px', { w: w, h: Math.round(w / th.slide.aspect) }), set: () => { state.width = w; setPref('export.slideWidth', w); },
        }));
      }
      const cards = list.map((c) => {
        const input = h('input', { type: 'radio', name: name, value: String(c.value), checked: c.checked });
        const card = h('label', { class: 'mt-export__res-opt' + (c.checked ? ' is-checked' : '') }, input,
          h('span', { class: 'mt-export__res-name' }, c.title), h('span', { class: 'mt-export__res-sub' }, c.sub));
        input.addEventListener('change', () => {
          if (!input.checked) return;
          c.set();
          U.$$('.mt-export__res-opt', opts).forEach((x) => x.classList.toggle('is-checked', x === card));
          refresh();
        });
        return card;
      });
      return [h('div', { class: 'mt-export__label' }, MT.t('export.dialog.resolution')), h('div', { class: 'mt-export__res', role: 'radiogroup', 'aria-label': MT.t('export.dialog.resolution') }, cards)];
    }

    const summary = h('div', { class: 'mt-export__summary', role: 'status', 'aria-live': 'polite' });
    let goBtn = null;
    function selectedMaps() { return all.filter((m) => chosen.has(m.id)); }
    function expectedName(maps) {
      if (state.format === 'pptx') return { text: MT.t('export.dialog.oneFile', { name: names.pptx(maps) }) };
      if (state.format === 'html') return { text: MT.t('export.dialog.oneFile', { name: names.html(maps) }) };
      if (maps.length === 1) return { text: MT.t('export.dialog.oneFile', { name: names.pngEntries(maps, state.format)[0] }) };
      return { text: MT.t('export.dialog.zip', { n: maps.length, name: names.pngZip(state.format) }) };
    }
    function refresh() {
      fmtCards.forEach((c) => c.classList.toggle('is-checked', c.dataset.format === state.format));
      setPref('export.format', state.format);
      const want = state.format === 'map' || state.format === 'slide' ? state.format : '';
      if (opts.dataset.kind !== want) {
        opts.dataset.kind = want;
        U.clear(opts);
        if (want) U.append(opts, resChoices());
      }
      const tipKey = state.format === 'pptx' ? 'export.tip.pptx' : state.format === 'html' ? 'export.tip.html' : 'export.tip.png';
      U.clear(tip);
      U.append(tip, [MT.ui.iconEl('info', { size: 16 }), h('span', null, MT.t(tipKey) + ' ' + MT.t('export.dialog.netHint'))]);
      const maps = selectedMaps();
      summary.classList.toggle('is-error', !maps.length);
      summary.textContent = maps.length ? expectedName(maps).text : MT.t('export.dialog.needMaps');
      summary.title = summary.textContent;
      if (goBtn) goBtn.disabled = !maps.length;
      const crowded = maps.filter((mm) => isCrowded(crowd[mm.id]));
      crowdNote.hidden = !crowded.length;
      U.clear(crowdNote);
      if (crowded.length) {
        const list = crowded.slice(0, 3).map((mm) => MT.t('export.dialog.crowdItem', { title: mapTitle(mm), dots: crowd[mm.id].dots, n: crowd[mm.id].n })).join(' · ');
        U.append(crowdNote, [MT.ui.iconEl('warning', { size: 16 }), h('span', null, MT.t('export.dialog.crowd', { n: crowded.length, list: list + (crowded.length > 3 ? ' …' : '') }))]);
      }
    }

    const body = h('div', { class: 'mt-export' },
      h('div', null, h('div', { class: 'mt-export__label' }, MT.t('export.dialog.format')), formats),
      h('div', null, mapsHead, mapsBox, opts, tip, crowdNote));
    let started = null;
    const m = MT.ui.modal({
      title: MT.t('export.dialog.title'), body: body, size: 'lg', className: 'mt-export-modal',
      actions: [
        { label: MT.t('common.cancel'), kind: 'secondary', value: null },
        { label: MT.t('export.dialog.go'), kind: 'primary', icon: 'download', onClick: (close) => {
          const ids = selectedMaps().map((x) => x.id);
          if (!ids.length) { refresh(); return false; }
          started = { format: state.format, ids: ids, opts: { scale: state.scale, width: state.width } };
          close('go');
          return false;
        } },
      ],
    });
    const footer = m.el.querySelector('.mt-modal__footer');
    if (footer) { footer.insertBefore(summary, footer.firstChild); goBtn = footer.querySelector('.mt-btn--primary'); }
    // Focus the chosen format (arrow keys then switch formats).
    requestAnimationFrame(() => { const r = U.$('.mt-export__fmt.is-checked input', body) || U.$('input', body); if (r) r.focus(); });
    refresh();

    // Visible-store counts per map, filled in after the dialog is on screen (layouts are memoized).
    const queue = all.slice();
    const fillNext = () => {
      if (!queue.length || !document.body.contains(m.el)) return;
      const mm = queue.shift();
      try {
        const lay = MT.layout.compute(mm), n = lay.length, dots = (lay.stats && lay.stats.collapsed) || 0;
        crowd[mm.id] = { n: n, dots: dots };
        metas[mm.id].textContent = n ? MT.t('data.stores', { n: n }) + (dots ? ' · ' + MT.t('export.dialog.dots', { n: dots }) : '') : MT.t('export.dialog.noStores');
        metas[mm.id].classList.toggle('is-empty', !n);
        metas[mm.id].classList.toggle('is-warn', isCrowded(crowd[mm.id]));
        if (chosen.has(mm.id)) refresh();
      } catch (e) { metas[mm.id].textContent = ''; }
      setTimeout(fillNext, 0);
    };
    setTimeout(fillNext, 60);

    return m.result.then((v) => {
      if (v !== 'go' || !started) return null;
      return run(started.format, started.ids, started.opts);
    });
  }

  /** UI-level export: progress + toasts, never rejects (null on failure / cancel). */
  function run(format, mapIds, opts) {
    opts = Object.assign({ ui: true }, opts || {});
    let p;
    if (format === 'pptx') p = X.pptx(mapIds, opts);
    else if (format === 'html') p = X.html(mapIds, opts);
    else if (format === 'map' || format === 'slide' || format === 'png') p = X.png(mapIds, Object.assign({}, opts, { kind: format === 'map' ? 'map' : (opts.kind || 'slide') }));
    else return Promise.resolve(null);
    return p.catch(() => null);
  }

  /* ---- Project-menu entries ------------------------------------------------------------------------ */
  const hasMaps = () => !!(MT.project && MT.project.maps && MT.project.maps().length);
  MT.app.addProjectMenuItem({ id: 'export-pptx', group: 'export', order: 10, labelKey: 'export.menu.pptx', icon: 'slides', enabled: hasMaps, onClick: () => dialog({ format: 'pptx' }) });
  MT.app.addProjectMenuItem({ id: 'export-png', group: 'export', order: 20, labelKey: 'export.menu.png', icon: 'image', enabled: hasMaps,
    onClick: () => dialog({ format: pref('export.format', 'slide') === 'map' ? 'map' : 'slide' }) });
  MT.app.addProjectMenuItem({ id: 'export-html', group: 'export', order: 30, labelKey: 'export.menu.html', icon: 'globe', enabled: hasMaps, onClick: () => dialog({ format: 'html' }) });

  /* ---- Public ---------------------------------------------------------------------------------------- */
  X.png = png;
  X.dialog = dialog;
  X.run = run;
  X.FORMATS = FORMATS.map((f) => f.id);
  X.util = {
    resolveMaps: resolveMaps,
    mapTitle: mapTitle,
    projectName: projectName,
    names: names,
    uniqueNames: uniqueNames,
    job: job,
    breathe: breathe,
    finish: finish,
    fail: fail,
    errorMessage: errorMessage,
    exportError: exportError,
    isAbort: isAbort,
    deliver: deliver,
    zipLib: zipLib,
    pngWithDpi: pngWithDpi,
    optsWithDefaults: optsWithDefaults,
  };
})();
