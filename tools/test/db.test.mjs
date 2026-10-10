// tools/test/db.test.mjs — module M3: Base de datos, Cadenas, import/export, OSM scan.
//
//   node tools/test/db.test.mjs            fixtures for every data file, no network for data
//                                           (Nominatim and Overpass are mocked in the page)
//   node tools/test/db.test.mjs --live     + one real Overpass scan of Miraflores (slow on file://)
//   node tools/test/db.test.mjs --headful  watch it
// Screenshots: tools/test/out/db-*.png. Fails on any console error.
// Section 2b covers the Zonas Nielsen grouping (filter facet, column, drawer line, Excel column) on the
// REAL data files (all stores, every district, the 15 zones of data/zones.js), plus a run without zones.js.

import { openApp, prepareApp, launch, collectErrors, screenshot, makeChecker, sleep, captureDownloads, waitForDownload, waitForMapIdle, splitNetworkNoise, ROOT, OUT } from './lib.mjs';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const headless = !process.argv.includes('--headful');
const live = process.argv.includes('--live');
const { check, finish } = makeChecker('db');

/** Evaluate in the page and print the checks it returns ({ok, msg}[]). */
async function checks(page, label, fn, arg) {
  console.log(`\n[${label}]`);
  let res;
  try { res = await page.evaluate(fn, arg); } catch (err) {
    // Print the checks gathered before the exception, then the error with its first stack lines.
    const before = await page.evaluate(() => (window.__take ? window.__take() : [])).catch(() => []);
    for (const r of before) check(r.ok, r.msg);
    check(false, `${label}: ${String(err.stack || err.message).split('\n').slice(0, 3).join(' | ')}`);
    return null;
  }
  for (const r of res.checks) check(r.ok, r.msg);
  return res;
}
// Shared page helpers (installed once per page).
async function installHelpers(page) {
  await page.evaluate(() => {
    window.__t = [];
    window.__ok = (ok, msg, extra) => window.__t.push({ ok: !!ok, msg: msg + (extra !== undefined ? ` → ${JSON.stringify(extra)}` : '') });
    window.__take = () => { const c = window.__t; window.__t = []; return c; };
    window.__until = (fn, ms = 8000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        let v; try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > ms) return reject(new Error('until: timeout ' + fn.toString().slice(0, 80) + ' | dialogs: ' + [...document.querySelectorAll('.mt-modal-backdrop')].map((b) => b.className + ':' + b.textContent.slice(0, 60)).join(' / ')));
        setTimeout(poll, 40);
      })();
    });
    window.__$ = (s, r) => (r || document).querySelector(s);
    window.__$$ = (s, r) => [...(r || document).querySelectorAll(s)];
    window.__btn = (text, root) => window.__$$('button', root || document).find((b) => b.offsetParent !== null && b.textContent.trim().replace(/\s+/g, ' ').includes(text));
    window.__setValue = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    // The open dialog (closing ones fade out for 160 ms and must be ignored).
    window.__modal = () => { const all = window.__$$('.mt-modal-backdrop'); return all.filter((b) => b.classList.contains('is-open')).pop() || all.pop(); };
    window.__dlg = async () => {
      await window.__until(() => { const all = window.__$$('.mt-modal-backdrop'); return all.length && all.every((b) => b.classList.contains('is-open')); });
      return window.__$$('.mt-modal-backdrop').pop();
    };
    window.__noModal = () => window.__until(() => !document.querySelector('.mt-modal-backdrop'));
  });
}

/* ============================================================================================
 * 1. Main run: fixtures for every file
 * ========================================================================================== */
const { browser, page, errors } = await openApp({ lang: 'es', fixtures: 'all', headless, hash: 'base', viewport: { width: 1440, height: 900 } });
await installHelpers(page);
await page.waitForFunction(() => document.querySelector('.mt-db-table tbody tr[data-id]'));

await checks(page, 'mount & table', async () => {
  const ok = window.__ok;
  const rows = __$$('.mt-db-table tbody tr[data-id]');
  ok(MT.dbui && !MT.osm.stub, 'MT.dbui and MT.osm are real (no stubs)');
  ok(MT.dbui.visible().length === 63, 'all 63 fixture stores listed (closed included)', MT.dbui.visible().length);
  ok(rows.length > 10 && rows.length <= 63, 'table rows rendered (virtualized window)', rows.length);
  ok(/63 tiendas/.test(__$('.mt-db-count').textContent), 'count shows 63 tiendas', __$('.mt-db-count').textContent);
  ok(__$('.mt-db-head__meta').textContent.includes('16 cadenas'), 'header meta shows the chain count');
  // Zona Nielsen was added after "Cadenas" (it is the main grouping): six buttons, found by data-facet, not by position.
  ok(__$$('.mt-db-fbtn').map((b) => b.dataset.facet).join() === 'chains,zones,location,statuses,sources,precisions', 'six filter buttons (chains, Zona Nielsen, location, status, source, precision)', __$$('.mt-db-fbtn').map((b) => b.dataset.facet));
  ok(__$('.mt-db-changes').textContent.includes('Sin cambios locales'), 'no local changes at start');
  const closedRow = rows.find((r) => r.classList.contains('is-muted'));
  ok(!!closedRow || MT.dbui.visible().some((s) => s.status === 'closed'), 'closed store present (muted row)');
  // Sorting by clicking a header
  const thName = __$$('.mt-db-table th').find((th) => th.textContent.trim() === 'Tienda');
  thName.click();
  const names = MT.dbui.visible().map((s) => s.name);
  const sorted = names.slice().sort(MT.util.compare);
  ok(names.join('|') === sorted.join('|'), 'click on "Tienda" sorts by name');
  ok(thName.getAttribute('aria-sort') === 'ascending' || __$$('.mt-db-table th').find((th) => th.textContent.trim() === 'Tienda').getAttribute('aria-sort') === 'ascending', 'aria-sort set');
  __$$('.mt-db-table th').find((th) => th.textContent.trim() === 'Tienda').click();
  ok(MT.dbui.visible()[0].name === sorted[sorted.length - 1], 'second click sorts descending');
  __$$('.mt-db-table th').find((th) => th.textContent.trim() === 'Cadena').click();
  return { checks: __take() };
});
await waitForMapIdle(page, { expr: 'MT.dbui && MT.dbui._map' }).catch(() => {});
await sleep(300);
await screenshot(page, 'db-table');

/* ---- Filters ------------------------------------------------------------------------------ */
await checks(page, 'filters', async () => {
  const ok = window.__ok;
  const all = MT.data.stores({ includeClosed: true });
  const F = (f) => MT.dbui.filterStores(all, f);
  ok(F({ chains: ['wong'] }).every((s) => s.chain === 'wong') && F({ chains: ['wong'] }).length === 6, 'chain filter (wong = 6)', F({ chains: ['wong'] }).length);
  ok(F({ chains: ['wong', 'metro'] }).length === 13, 'multi-chain filter (wong + metro)', F({ chains: ['wong', 'metro'] }).length);
  ok(F({ department: 'La Libertad' }).every((s) => s.department === 'La Libertad') && F({ department: 'La Libertad' }).length > 0, 'department filter');
  ok(F({ department: 'Lima', province: 'Lima' }).every((s) => s.province === 'Lima'), 'province filter');
  ok(F({ ubigeo: '150122' }).every((s) => s.ubigeo === '150122') && F({ ubigeo: '150122' }).length === 15, 'district filter (Miraflores = 15)', F({ ubigeo: '150122' }).length);
  ok(F({ statuses: ['closed'] }).length === 1, 'status filter (1 closed)');
  ok(F({ statuses: ['to_verify'] }).every((s) => s.status === 'to_verify'), 'status filter to_verify');
  ok(F({ sources: ['manual'] }).length === 7, 'source filter (7 manual)', F({ sources: ['manual'] }).length);
  ok(F({ precisions: ['approx'] }).every((s) => s.precision === 'approx') && F({ precisions: ['approx'] }).length > 0, 'precision filter');
  const galvez = F({ q: 'jose galvez' });
  ok(galvez.length >= 1 && galvez.every((s) => /Gálvez/.test(s.name + s.address)), 'accent-insensitive search "jose galvez"', galvez.map((s) => s.name));
  ok(F({ q: 'PLAZA vea miraflores' }).every((s) => s.chain === 'plazavea' && s.district === 'Miraflores'), 'multi-word search (chain + district)');
  ok(F({ q: 'zzzz-no-existe' }).length === 0, 'no match → empty');
  ok(F({ chains: ['plazavea'], ubigeo: '150122', statuses: ['verified'] }).every((s) => s.chain === 'plazavea' && s.ubigeo === '150122' && s.status === 'verified'), 'combined filters');
  // Through the UI state
  MT.dbui.setFilters({ chains: ['tottus'] });
  ok(MT.dbui.visible().length === 6 && MT.dbui.visible().every((s) => s.chain === 'tottus'), 'setFilters updates the visible list');
  ok(__$$('.mt-db-fbtn')[0].classList.contains('is-active') && /Tottus/.test(__$$('.mt-db-fbtn')[0].textContent), 'chain button shows the active value');
  ok(/6 de 63/.test(__$('.mt-db-count').textContent), 'count shows "6 de 63"', __$('.mt-db-count').textContent);
  ok(!__$('.mt-db-clear').hidden, '"Limpiar filtros" visible');
  // Department change resets province/district
  MT.dbui.setFilters({ department: 'Lima', province: 'Lima', ubigeo: '150122' });
  MT.dbui.setFilters({ department: 'Áncash' });
  const f = MT.dbui.filters();
  ok(f.department === 'Áncash' && !f.province && !f.ubigeo, 'changing department clears province and district');
  MT.dbui.clearFilters();
  ok(MT.dbui.visible().length === 63 && __$('.mt-db-clear').hidden, 'clearFilters restores everything');
  // Search box (debounced)
  __setValue(__$('.mt-db-search__input'), 'vivanda');
  await __until(() => MT.dbui.visible().length === 3);
  ok(MT.dbui.visible().every((s) => s.chain === 'vivanda'), 'search box filters as you type');
  __setValue(__$('.mt-db-search__input'), 'zzzqqq');
  await __until(() => MT.dbui.visible().length === 0);
  ok(!__$('.mt-db-empty').hidden && /Ninguna tienda coincide/.test(__$('.mt-db-empty').textContent), 'empty state when nothing matches');
  __btn('Limpiar filtros', __$('.mt-db-empty')).click();
  ok(MT.dbui.visible().length === 63 && __$('.mt-db-search__input').value === '', 'empty-state button clears filters and search');
  return { checks: __take() };
});

await checks(page, 'facet popovers', async () => {
  const ok = window.__ok;
  __$$('.mt-db-fbtn')[0].click();
  await __until(() => __$('.mt-db-pop'));
  const opt = __$$('.mt-db-pop__opt').find((l) => l.textContent.includes('Wong'));
  ok(!!opt && /6/.test(opt.querySelector('.mt-db-pop__n').textContent), 'chain popover lists Wong with its count');
  opt.querySelector('input').click();
  ok(MT.dbui.filters().chains.join() === 'wong' && MT.dbui.visible().length === 6, 'ticking a chain filters live');
  const groupBox = __$$('.mt-db-pop__group').find((l) => /Descuento/i.test(l.textContent)).querySelector('input');
  groupBox.click();
  ok(MT.dbui.filters().chains.length === 6, 'group checkbox adds the whole group', MT.dbui.filters().chains);
  __$('.mt-db-pop__head .mt-db-link').click();
  ok(MT.dbui.filters().chains.length === 0, '"Limpiar" in the popover clears the facet');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  __$('.mt-db-pop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(!__$('.mt-db-pop'), 'Escape closes the popover');
  // Location cascade
  __$('.mt-db-fbtn[data-facet=location]').click();
  await __until(() => __$('.mt-db-pop select'));
  let sels = __$$('.mt-db-pop select');
  ok(sels.length === 3 && sels[1].disabled && sels[2].disabled, 'location popover: province/district disabled until a department is chosen');
  __setValue(sels[0], 'Lima');
  sels = __$$('.mt-db-pop select');
  ok(!sels[1].disabled, 'province enabled after department');
  __setValue(sels[1], 'Lima');
  sels = __$$('.mt-db-pop select');
  const miraOpt = [...sels[2].options].find((o) => /Miraflores/.test(o.textContent));
  ok(!!miraOpt && /\(15\)/.test(miraOpt.textContent), 'district options carry counts', miraOpt && miraOpt.textContent);
  __setValue(sels[2], miraOpt.value);
  ok(MT.dbui.visible().length === 15 && /Miraflores/.test(__$('.mt-db-fbtn[data-facet=location]').textContent), 'district chosen → 15 stores, button shows Miraflores');
  __$('.mt-db-pop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Status popover
  __$('.mt-db-fbtn[data-facet=statuses]').click();
  await __until(() => __$('.mt-db-pop'));
  __$$('.mt-db-pop__opt input')[1].click(); // to_verify
  ok(MT.dbui.filters().statuses.join() === 'to_verify', 'status popover sets the filter');
  __$('.mt-db-pop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  MT.dbui.clearFilters();
  return { checks: __take() };
});
await page.evaluate(() => { __$$('.mt-db-fbtn')[0].click(); });
await sleep(250);
await screenshot(page, 'db-filter-chains');
await page.evaluate(() => { const p = __$('.mt-db-pop'); if (p) p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

/* ---- Keyboard navigation ------------------------------------------------------------------ */
await page.focus('.mt-db-tablewrap');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
let kb = await page.evaluate(() => ({ sel: MT.dbui.state().selected, second: MT.dbui.visible()[1].id, active: document.activeElement.className }));
check(kb.sel === kb.second, 'ArrowDown twice selects the 2nd row');
check(/mt-db-tablewrap/.test(kb.active), 'focus stays in the table after selecting (map popup does not steal it)');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.mt-db-drawer.is-open'));
check(await page.evaluate(() => document.querySelector('.mt-drawer__title').textContent === 'Editar tienda'), 'Enter opens the edit drawer');
await sleep(200);
check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'mt-db-f-name'), 'focus moves into the drawer (name field)');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.mt-db-drawer.is-open'));
check(true, 'Escape closes the drawer');

/* ---- Add store (paste coordinates) -------------------------------------------------------- */
await checks(page, 'add store', async () => {
  const ok = window.__ok;
  __btn('Agregar tienda', __$('.mt-db-head')).click();
  await __until(() => __$('.mt-db-drawer.is-open'));
  ok(__$('.mt-drawer__title').textContent === 'Agregar tienda', 'drawer opens in "add" mode');
  ok(!__$('.mt-db-drawer').classList.contains('is-dirty'), 'a fresh form is not marked dirty');
  // Save with nothing → inline errors
  __btn('Agregar tienda', __$('.mt-db-drawer__foot')).click();
  await __until(() => __$$('.mt-db-drawer .mt-field__error').some((e) => e.textContent));
  const errs = __$$('.mt-db-drawer .mt-field__error').map((e) => e.textContent).filter(Boolean);
  ok(errs.some((e) => /cadena/.test(e)) && errs.some((e) => /nombre/.test(e)) && errs.some((e) => /Ubica la tienda/.test(e)), 'validation errors for chain, name and location', errs);
  __setValue(__$('#mt-db-f-chain'), 'vivanda');
  __setValue(__$('#mt-db-f-name'), 'Vivanda Prueba Larco');
  __setValue(__$('#mt-db-f-address'), 'Av. José Larco 999');
  // Short link → explained error
  const paste = __$('#mt-db-f-paste');
  paste.value = 'https://maps.app.goo.gl/AbCdEf'; paste.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(/enlaces cortos/.test(__$('.mt-db-msg.is-error').textContent), 'short Google link → explained error');
  // lng,lat typed the wrong way round → swapped
  paste.value = '-77.0297, -12.1219'; paste.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(/invirtió/.test(__$$('.mt-db-msg').map((m) => m.textContent).join(' ')), 'swapped "lng, lat" is detected and explained');
  // Google Maps place URL → the !3d!4d pin wins
  paste.value = 'https://www.google.com/maps/place/X/@-12.1300000,-77.0200000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-12.1219!4d-77.0297!16s';
  paste.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(__$('#mt-db-f-lat').value === '-12.121900' && __$('#mt-db-f-lng').value === '-77.029700', 'Google Maps URL pin fills lat/lng', [__$('#mt-db-f-lat').value, __$('#mt-db-f-lng').value]);
  ok(/Miraflores/.test(__$('.mt-db-district').textContent) && /150122/.test(__$('.mt-db-district').textContent), 'district auto-detected (Miraflores 150122)', __$('.mt-db-district').textContent);
  ok(__$('.mt-db-drawer').classList.contains('is-dirty'), 'form is dirty after edits');
  __btn('Agregar tienda', __$('.mt-db-drawer__foot')).click();
  await __until(() => !__$('.mt-db-drawer.is-open'));
  const s = MT.data.stores().find((x) => x.name === 'Vivanda Prueba Larco');
  ok(!!s, 'store created');
  ok(s && /^man-[0-9a-z]+$/.test(s.id) && s.source === 'manual' && s.precision === 'exact' && s.ubigeo === '150122' && s.district === 'Miraflores', 'new store: man- id, manual, exact, located', s && { id: s.id, src: s.source, u: s.ubigeo });
  ok(MT.data.storeState(s.id) === 'added' && MT.data.overlayStats().added === 1, 'counted as a local addition');
  await __until(() => __$('.mt-db-changes__pill'));
  ok(/1 cambio local/.test(__$('.mt-db-changes__pill').textContent), 'changes pill shows "1 cambio local"');
  await __until(() => MT.dbui.state().selected === s.id);
  ok(true, 'the new store is selected after saving');
  window.__newId = s.id;
  return { checks: __take() };
});
await sleep(500);
await screenshot(page, 'db-after-add');

/* ---- Edit, mark closed, delete, restore --------------------------------------------------- */
await checks(page, 'edit & delete', async () => {
  const ok = window.__ok;
  const target = MT.data.stores().find((s) => s.id === 'osm-w338365656'); // Wong Coronel Luis Arias (seed)
  MT.dbui.openEditor(target.id);
  await __until(() => __$('.mt-db-drawer.is-open') && __$('#mt-db-f-name'));
  ok(__$('#mt-db-f-name').value === target.name, 'drawer shows the store');
  const saveBtn = () => __btn('Guardar', __$('.mt-db-drawer__foot'));
  ok(saveBtn().disabled, 'Save is disabled until something changes');
  __setValue(__$('#mt-db-f-name'), 'Wong Arias (editada)');
  ok(!saveBtn().disabled, 'Save enabled after a change');
  // Precision/status segmented
  __$$('.mt-db-drawer .mt-seg__input').find((i) => i.value === 'to_verify').click();
  saveBtn().click();
  await __until(() => !__$('.mt-db-drawer.is-open'));
  const ed = MT.data.store(target.id);
  ok(ed.name === 'Wong Arias (editada)' && ed.status === 'to_verify' && MT.data.storeState(target.id) === 'edited', 'edit saved to the overlay', { n: ed.name, st: ed.status });
  ok(ed.lat === target.lat && ed.ubigeo === target.ubigeo, 'unchanged position keeps lat/ubigeo');
  // Soft delete (mark closed)
  await __noModal();
  MT.dbui.openEditor(target.id);
  await __until(() => __btn('Eliminar', __$('.mt-db-drawer__foot')));
  __btn('Eliminar', __$('.mt-db-drawer__foot')).click();
  await __until(() => __$('.mt-db-choice'));
  ok(__$('input[name=mt-db-del][value=close]').checked, 'delete dialog defaults to "mark as closed"');
  __btn('Aplicar', (await __dlg())).click();
  await __until(() => MT.data.store(target.id).status === 'closed');
  ok(MT.data.store(target.id).status === 'closed', 'soft delete marks the store closed');
  // Permanent delete
  await __until(() => !__$('.mt-db-drawer.is-open'));
  await __noModal();
  MT.dbui.openEditor(target.id);
  await __until(() => __btn('Eliminar', __$('.mt-db-drawer__foot')));
  __btn('Eliminar', __$('.mt-db-drawer__foot')).click();
  await __until(() => __$('input[name=mt-db-del][value=delete]'));
  __$('input[name=mt-db-del][value=delete]').click();
  ok(__btn('Aplicar', (await __dlg())).className.includes('danger'), 'choosing "delete" turns the button red');
  __btn('Aplicar', (await __dlg())).click();
  await __until(() => MT.data.storeState(target.id) === 'deleted');
  ok(!MT.data.store(target.id) && MT.data.storeState(target.id) === 'deleted', 'permanent delete → overlay "deleted"');
  await __until(() => !MT.dbui.visible().some((s) => s.id === target.id));
  ok(true, 'deleted store leaves the normal table');
  // Local changes view shows it with restore
  __$('.mt-db-changes__pill').click();
  ok(MT.dbui.filters().local && MT.dbui.visible().some((s) => s.id === target.id), 'local-changes view lists the deleted store');
  ok(__$$('.mt-db-table tr.is-deleted').length >= 1, 'deleted row rendered struck-through');
  MT.dbui.openEditor(target.id);
  await __until(() => __$('.mt-db-notice--danger'));
  ok(__$$('.mt-db-drawer input').filter((i) => !i.disabled && i.closest('.mt-drawer__body')).length === 0, 'deleted store: form is read-only');
  __btn('Restaurar', __$('.mt-db-notice--danger')).click();
  await __until(() => MT.data.storeState(target.id) === 'seed');
  ok(MT.data.store(target.id) && MT.data.store(target.id).name === target.name, 'restore brings back the seed version');
  MT.dbui.closeEditor(true);
  MT.dbui.setFilters({ local: false });
  // Delete the locally added store → it disappears completely
  await MT.data.deleteStore(window.__newId);
  ok(MT.data.storeState(window.__newId) === null, 'deleting a local addition removes it');
  return { checks: __take() };
});

/* ---- Bulk ----------------------------------------------------------------------------------- */
await checks(page, 'bulk actions', async () => {
  const ok = window.__ok;
  MT.dbui.setFilters({ chains: ['metro'] });
  const ids = MT.dbui.visible().slice(0, 2).map((s) => s.id);
  __$$('tbody input.mt-db-check').slice(0, 2).forEach((b) => b.click());
  ok(!__$('.mt-db-bulk').hidden && /2 seleccionadas/.test(__$('.mt-db-bulk').textContent), 'bulk bar appears with the count');
  ok(__$('.mt-db-th-check input').indeterminate, 'header checkbox indeterminate');
  __btn('Por verificar', __$('.mt-db-bulk')).click();
  await __until(() => ids.every((id) => MT.data.store(id).status === 'to_verify'));
  ok(true, 'bulk "mark as to verify" updated both stores');
  __$('.mt-db-th-check input').click();
  ok(MT.dbui.state().checked.length === MT.dbui.visible().length, 'header checkbox selects all filtered');
  __$('.mt-db-bulk__x').click();
  ok(MT.dbui.state().checked.length === 0 && __$('.mt-db-bulk').hidden, 'clear selection');
  await Promise.all(ids.map((id) => MT.data.restoreStore(id)));
  MT.dbui.clearFilters();
  return { checks: __take() };
});

/* ---- CSV round trip + export downloads --------------------------------------------------- */
const dl = await captureDownloads(page);
await checks(page, 'csv round-trip', async () => {
  const ok = window.__ok;
  const list = MT.data.stores({ includeClosed: true });
  const csv = MT.io.storesToCSV(list);
  const back = MT.io.storesFromCSV(csv);
  ok(back.stores.length === list.length && back.errors.length === 0, 'CSV → stores keeps every row', [back.stores.length, back.errors.length]);
  const byId = {}; back.stores.forEach((s) => { byId[s.id] = s; });
  const same = list.every((s) => {
    const b = MT.data.normalizeStore(byId[s.id]);
    return MT.data.COLUMNS.every((c) => String(b[c]) === String(s[c]));
  });
  ok(same, 'every column survives the round trip (accents, quotes, decimals)');
  ok(csv.charCodeAt(0) === 0xFEFF && csv.split('\r\n')[0].startsWith(String.fromCharCode(0xFEFF) + 'id,chain,name'), 'BOM + SPEC column order');
  MT.dbui.setFilters({ chains: ['wong'] });
  await MT.dbui.exportStores('csv');
  await MT.dbui.exportStores('xlsx');
  MT.dbui.clearFilters();
  return { checks: __take() };
});
const csvFile = await waitForDownload(dl, /\.csv$/);
const xlsxFile = await waitForDownload(dl, /\.xlsx$/);
const csvText = readFileSync(csvFile, 'utf8');
check(/^Tiendas - \d{4}-\d{2}-\d{2}\.csv$/.test(path.basename(csvFile)), `CSV export named by date (${path.basename(csvFile)})`);
check(csvText.trim().split(/\r\n/).length === 7 && /Wong/.test(csvText), 'exported CSV holds the 6 filtered Wong stores + header');
check(readFileSync(xlsxFile).subarray(0, 2).toString() === 'PK', 'Excel export is a real .xlsx (zip)');

/* ---- Import (Spanish headers, ; separator, decimal commas, merge, geocoding mocked) -------- */
await checks(page, 'import', async () => {
  const ok = window.__ok;
  // Mock Nominatim: one address resolves, the other does not.
  window.__realSearch = MT.geo.search;
  MT.geo.search = (q) => Promise.resolve(/Pardo/.test(q) ? [{ lat: -12.1185, lng: -77.0365, label: 'Av. José Pardo, Miraflores', street: 'Avenida José Pardo' }] : []);
  const csv = [
    'Reporte de tiendas 2026',                                          // title row above the header
    'ID;Cadena;Nombre;Dirección;Distrito;Latitud;Longitud;Estado;Comentarios',
    'osm-w129822354;Plaza Vea;Plaza Vea Arequipa;;;;;Por verificar;revisado en campo',  // merge: partial update
    ';TOTTUS;Tottus Nuevo Import;Av. Primavera 100;Surco;-12,1100;-77,0050;;',          // new, decimal commas, legend name
    ';Mass;Mass Pardo;Av. José Pardo 500;Miraflores;;;;',                                 // new, geocoded
    ';Mass;Mass Fantasma;Calle Inexistente 1;;;;;',                                       // geocode fails
    ';;Sin cadena;Av. X 1;;-12.1;-77.0;;',                                               // no chain → skipped
    ';Cadena Rara;Tienda Rara;;;-12.12;-77.02;;',                                          // unknown chain (kept)
  ].join('\r\n');
  const file = new File([csv], 'tiendas-campo.csv', { type: 'text/csv' });
  const done = MT.dbui.importFile(file);
  await __until(() => __$('.mt-imp'));
  ok(/encabezados en la fila 2/.test(__$('.mt-imp-file').textContent), 'header row detected below a title row', __$('.mt-imp-file').textContent);
  const rows = __$$('.mt-imp-row');
  const mapped = rows.map((r) => r.querySelector('select').value);
  ok(mapped.join() === 'id,chain,name,address,district,lat,lng,status,notes', 'Spanish headers auto-mapped', mapped);
  ok(__$('input[name=mt-imp-mode][value=merge]').checked, 'merge-by-ID chosen when an ID column exists');
  const sum = __$('.mt-imp-summary').textContent;
  ok(/1 tienda existente se actualizará/.test(sum) && /1 se ubicará por su dirección/.test(sum) === false && /se ubicarán por su dirección/.test(sum), 'summary: 1 update, 2 to geocode', sum);
  ok(/Cadena Rara|cadenarara/.test(sum), 'unknown chains are announced', sum);
  ok(/Sin cadena/.test(__$('.mt-imp-preview').textContent), 'preview shows the row without chain as skipped');
  // Map the "Comentarios" column away and back to check the select works
  const notesSel = rows[8].querySelector('select');
  __setValue(notesSel, '');
  ok(__$$('.mt-imp-row')[8].classList.contains('is-mapped') === false, 'a column can be unmapped');
  __setValue(__$$('.mt-imp-row')[8].querySelector('select'), 'notes');
  const go = __$('.mt-modal__footer .mt-btn--primary', (await __dlg()));
  ok(/Importar 5 tiendas/.test(go.textContent), 'import button shows the importable count', go.textContent);
  go.click();
  await __until(() => __modal() && /Importación terminada/.test(__modal().textContent), 15000);
  const stats = __$$('.mt-imp-stat__n').map((n) => +n.textContent);
  ok(stats[0] === 3 && stats[1] === 1 && stats[2] === 1 && stats[3] === 2, 'summary: 3 new, 1 updated, 1 geocoded, 2 skipped', stats);
  ok(/Calle Inexistente|Mass Fantasma/.test(__$('.mt-imp-skipped').textContent) && /Dirección no encontrada/.test(__$('.mt-imp-skipped').textContent), 'skipped rows listed with their reason');
  const pv = MT.data.store('osm-w129822354');
  ok(pv.status === 'to_verify' && pv.notes === 'revisado en campo' && pv.lat === -12.11209, 'merge updated status/notes and kept the coordinates', { st: pv.status, n: pv.notes, lat: pv.lat });
  const tot = MT.data.stores().find((s) => s.name === 'Tottus Nuevo Import');
  ok(tot && tot.chain === 'tottus' && tot.lat === -12.11 && tot.lng === -77.005 && tot.source === 'import', 'new row: chain by legend name, decimal commas, source import', tot && { c: tot.chain, lat: tot.lat });
  const mp = MT.data.stores().find((s) => s.name === 'Mass Pardo');
  ok(mp && mp.precision === 'approx' && mp.status === 'to_verify' && mp.ubigeo === '150122', 'geocoded row: approx, to verify, located in Miraflores', mp && { p: mp.precision, st: mp.status, u: mp.ubigeo });
  const rara = MT.data.stores().find((s) => s.name === 'Tienda Rara');
  ok(rara && rara.chain === 'cadenarara' && MT.data.chain('cadenarara').unknown, 'unknown chain id kept and synthesized');
  const ids = [tot, mp, rara].filter(Boolean).map((s) => s.id);
  ok(ids.length === 3 && new Set(ids).size === 3 && ids.every((id) => /^man-[0-9a-z]+$/.test(id)), 'imported rows get unique man- ids', ids);
  __btn('Listo', (await __dlg())).click();
  await done;
  MT.geo.search = window.__realSearch;
  return { checks: __take() };
});

await checks(page, 'import: append mode & geocode cancel', async () => {
  const ok = window.__ok;
  await __noModal();
  const before = MT.data.stores({ includeClosed: true }).length;
  const rows = [['Cadena', 'Nombre', 'Latitud', 'Longitud'], ['Metro', 'Metro A', '-12.10', '-77.03'], ['Metro', 'Metro B', '-12.11', '-77.04']];
  const p = MT.dbui.importRows('lista.xlsx', rows);
  await __until(() => __$('.mt-imp'));
  ok(__$('input[name=mt-imp-mode][value=merge]').disabled && __$('input[name=mt-imp-mode][value=append]').checked, 'without ID column only "append" is possible');
  __$('.mt-modal__footer .mt-btn--primary', (await __dlg())).click();
  await __until(() => __modal() && /Importación terminada/.test(__modal().textContent));
  __btn('Listo', (await __dlg())).click();
  await p;
  ok(MT.data.stores({ includeClosed: true }).length === before + 2, 'append mode added 2 stores');
  return { checks: __take() };
});

/* ---- OSM: pure helpers ------------------------------------------------------------------------ */
await checks(page, 'osm helpers', async () => {
  const ok = window.__ok;
  const O = MT.osm;
  ok(O.toERE('plaza\\s*vea') === 'plaza[[:space:]]*vea', 'toERE: \\s → [[:space:]]', O.toERE('plaza\\s*vea'));
  ok(O.toERE('\\bwong\\b') === 'wong' && O.toERE('^metro\\b') === '^metro', 'toERE: \\b dropped (broader pre-filter)');
  ok(O.toERE('^(?:super\\s+)?metro\\b', { anchors: false }) === '(super[[:space:]]+)?metro', 'toERE {anchors:false}: ^ and $ dropped (rules test folded text, Overpass the raw name)');
  ok(O.toERE('(?:a|b)\\.c') === '(a|b)[.]c', 'toERE: non-capturing groups and escaped dots');
  ok(!/["\\]/.test(O.toERE('say "x" \\d+')), 'toERE: never emits quotes or backslashes', O.toERE('say "x" \\d+'));
  ok(O.toERE('(?<!x)holi') === 'holi', 'toERE: lookbehind removed');
  ok(O.toERE('^\\s*(tiendas?\\s+)?mass\\b(?!\\s+chicken)') === '^[[:space:]]*(tiendas?[[:space:]]+)?mass', 'toERE: negative lookahead removed (never narrower: "Mass" still passes)', O.toERE('^\\s*(tiendas?\\s+)?mass\\b(?!\\s+chicken)'));
  ok(O.toERE('corporaci[oó]n') === 'corporaci.{1,2}n' && O.toERE('más') === 'm.{1,2}s', 'toERE: accents → .{1,2} (UTF-8 safe)');
  ok(O.toERE('(?i)x') === '', 'toERE: unsupported syntax → "" (no name filter)');
  // These tests run on tools/fixtures/chains.js: an OLD data/chains.js (osm = {wikidata, nameRegex, shops},
  // no window.MT_OSM_RULES) → the built-in copy of the cross-chain rules, defaults for the other keys.
  ok(!window.MT_OSM_RULES && O.globalRulesSource() === 'builtin' && O.globalRules() === O.BUILTIN_RULES, 'old chains.js without MT_OSM_RULES → built-in cross-chain rules');
  const pv = MT.data.chain('plazavea').osm;
  ok(MT.data.OSM_KEYS.every((k) => k in pv) && pv.requireShopLike === true && pv.label === 'Plaza Vea' && pv.excludeTags.length === 0, 'old chain entries get every osm key with the merge defaults');
  ok(O.fold('  Súper   MÉTRO ') === 'super metro', 'fold: accents, case and spaces');
  const R = O.compile();
  const cl = (tags) => { const r = O.classifyTags(tags, R); return r.chain ? r.chain + ':' + r.kind : null; };
  ok(cl({ shop: 'supermarket', name: 'Plaza Vea Angamos' }) === 'plazavea:shop', 'name + shop type → shop');
  ok(cl({ shop: 'department_store', name: 'Plaza Vea' }) === 'plazavea:weak', 'name with another (grocery-like) shop type → weak (doubtful, never a plain new store)');
  ok(cl({ amenity: 'parking', name: 'Plaza Vea' }) === 'plazavea:excluded' && cl({ highway: 'bus_stop', name: 'Plaza Vea' }) === 'plazavea:excluded', 'parking lot / bus stop named after the store → excluded');
  ok(cl({ shop: 'vacant', name: 'Plaza Vea' }) === 'plazavea:closed' && cl({ 'disused:shop': 'supermarket', name: 'Plaza Vea' }) === 'plazavea:closed', 'vacant shop / lifecycle prefix → closed');
  ok(cl({ shop: 'supermarket', name: 'PLAZA  VÉA Surco' }) === 'plazavea:shop', 'names are folded before testing (accents, case, spaces)');
  // A chain added by the user: no rules → conservative, anchored name rule from the chain name.
  const user = { id: 'economax', name: 'Economax Perú', group: 'other', osm: { wikidata: [], nameRegex: '', shops: [] } };
  const ur = O.rules(user);
  ok(ur.usable && ur.derived && O.chainRules(user).nameRegex === '^economax\\s*peru(?![a-z0-9])', 'user chain without rules: name rule derived from the chain name', O.chainRules(user).nameRegex);
  const UR = O.compile(MT.data.chains().concat([user]));
  ok(O.classifyTags({ shop: 'chemist', name: 'ECONOMAX  Perú Surco' }, UR).kind === 'shop' && O.classifyTags({ shop: 'chemist', name: 'Farmacia Economax Perú' }, UR).chain === null &&
    O.classifyTags({ name: 'Economax Perú', building: 'retail' }, UR).kind === 'excluded', 'derived rule: anchored at the start, any shop type, a shop tag required');
  ok(!O.rules(MT.data.chain('nope')).usable, 'unregistered chain ids get no rules');
  // Query: built from the rules (name keys + brand + brand:wikidata).
  const q = O.buildQuery({ ubigeos: ['150122'], chains: ['plazavea', 'wong'] });
  ok(/\[out:json\]/.test(q) && /nwr\["name"\]\(-12\.\d+,-77\.\d+,-12\.\d+,-77\.\d+\);/.test(q) && /nwr\["name:es"\]\(/.test(q) && /nwr\["brand"\]\(/.test(q) && /nwr\["brand:wikidata"\]\(/.test(q),
    'query selects the keys the rules read (name, name:es, brand, brand:wikidata) in the bbox (S,W,N,E)', q.split('\n').slice(1, 6).join(' '));
  ok(/nwr\.all\["name"~"plaza\[\[:space:\]\]\*vea\|wong",i\]/.test(q) && /nwr\.all\["brand"~"plaza/.test(q) && /out center tags/.test(q), 'query filters name / brand with the ERE, case-insensitive, outputs centres');
  const qx = O.buildQuery({ bbox: [-77.05, -12.14, -77.0, -12.1], chains: ['wong'] });
  ok(/nwr\.all\["name"~"wong",i\]/.test(qx), 'buildQuery uses the chain ERE');
  const lima = MT.data.districts.all().filter((d) => d.province === 'Lima').map((d) => d.ubigeo);
  ok(O.planTiles(lima).length === 1 && O.planTiles(['130101', '150122']).length >= 2, 'tiles: one for nearby districts, several for distant ones', [O.planTiles(lima).length, O.planTiles(['130101', '150122']).length]);
  // Cluster: a node and a way of one store (167 m, default big radii) → one store, the node represents it.
  const cs = O.cluster(O.classify([
    { type: 'node', id: 11, lat: -12.1200, lon: -77.0300, tags: { shop: 'supermarket', name: 'Wong' } },
    { type: 'way', id: 12, center: { lat: -12.1215, lon: -77.0300 }, tags: { shop: 'supermarket', building: 'yes', name: 'Wong' } },
    { type: 'node', id: 13, lat: -12.1300, lon: -77.0300, tags: { shop: 'supermarket', name: 'Wong' } },
  ], null, R), R);
  ok(cs.length === 2 && cs.find((x) => x.key === 'n11').members.join() === 'n11,w12', 'cluster: node + way of one store merged, the node represents it', cs.map((x) => x.members.join('+')));
  // diff on synthetic data (Wong: match radius 250 m)
  const mk = (id, chain, lat, lng, extra) => Object.assign({ id, chain, name: id, lat, lng, source: 'osm', source_ref: id.replace('osm-', ''), status: 'verified' }, extra || {});
  const db = [mk('osm-n1', 'wong', -12.12, -77.03), mk('osm-n2', 'wong', -12.13, -77.03), mk('web-wong-x', 'wong', -12.14, -77.03, { source: 'web', source_ref: '' }), mk('osm-n9', 'wong', -12.15, -77.03), mk('osm-n7', 'wong', -12.16, -77.03)];
  const osm = [mk('osm-n1', 'wong', -12.12, -77.03), mk('osm-n2', 'wong', -12.1307, -77.03), mk('osm-n5', 'wong', -12.1404, -77.03), mk('osm-n6', 'wong', -12.185, -77.03),
    mk('osm-n7', 'wong', -12.16, -77.03, { _closed: true, _kind: 'closed' }), mk('osm-n8', 'wong', -12.19, -77.03, { _weak: true, _kind: 'weak' }), mk('osm-n4', 'wong', -12.21, -77.03, { _weak: true, _noCoords: true, _kind: 'weak' })];
  const d = O.diff(osm, db);
  ok(d.matched.length === 3 && d.new.length === 2 && d.new[0].id === 'osm-n6' && d.new[1].id === 'osm-n8' && d.new[1]._weak, 'diff: 3 matched, 1 new + 1 doubtful (listed last); a noCoords element is never proposed', { m: d.matched.length, n: d.new.map((x) => x.id) });
  ok(d.matched.find((m) => m.store.id === 'osm-n2').moved && !d.matched.find((m) => m.store.id === 'osm-n1').moved, 'diff: 78 m away → moved, same spot → unchanged');
  ok(d.matched.find((m) => m.store.id === 'web-wong-x') && !d.matched.find((m) => m.store.id === 'web-wong-x').sameId, 'diff: web store matched by proximity (< 250 m for a big format)');
  ok(d.notFound.length === 2 && d.notFound.some((s) => s.id === 'osm-n9' && !s._closedInOsm) && d.notFound.some((s) => s.id === 'osm-n7' && s._closedInOsm),
    'diff: OSM-sourced store missing from OSM → not found; one whose OSM element is closed → not found (closed in OSM)');
  ok(Math.round(d.new[0]._nearest.distance) > 2000, 'diff: new store remembers its nearest same-chain store');
  return { checks: __take() };
});

/* ---- OSM: mocked scan + review --------------------------------------------------------------- */
await checks(page, 'osm scan (mocked Overpass) + review', async () => {
  const ok = window.__ok;
  const seedWong = MT.data.store('osm-n6275372114');      // Wong José Gálvez (osm, Miraflores)
  const seedViv = MT.data.store('osm-w435335789');        // Vivanda Benavides (osm, Miraflores)
  const otherOsm = MT.data.stores().filter((s) => s.source === 'osm' && s.ubigeo === '150122' && ['wong', 'vivanda', 'plazavea'].includes(s.chain) && s.id !== seedWong.id && s.id !== seedViv.id);
  const ref = (s) => ({ type: s.id[4] === 'w' ? 'way' : s.id[4] === 'r' ? 'relation' : 'node', id: +s.id.slice(5) });
  const el = (type, id, lat, lon, tags) => (type === 'node' ? { type, id, lat, lon, tags } : { type, id, center: { lat, lon }, tags });
  // A spot inside Miraflores far (> 300 m) from every Plaza Vea of the database.
  const pvs = MT.data.stores({ includeClosed: true }).filter((s) => s.chain === 'plazavea');
  const cands = [[-12.1305, -77.0215], [-12.1255, -77.0185], [-12.1180, -77.0420], [-12.1290, -77.0300], [-12.1150, -77.0330], [-12.1230, -77.0360]];
  const P = cands.find(([la, ln]) => (MT.data.locate(la, ln) || {}).ubigeo === '150122' && pvs.every((s) => MT.geo.distanceMeters(s, { lat: la, lng: ln }) > 300));
  ok(!!P, 'test setup: free spot in Miraflores for a new Plaza Vea', P);
  const elements = [
    // existing, same place → matched
    el(ref(seedWong).type, ref(seedWong).id, seedWong.lat, seedWong.lng, { shop: 'supermarket', name: 'Wong' }),
    // existing, moved ~90 m north → moved
    el(ref(seedViv).type, ref(seedViv).id, seedViv.lat + 0.0008, seedViv.lng, { shop: 'supermarket', name: 'Vivanda' }),
    // new Plaza Vea far from others, plus its building way (duplicate, 25 m away)
    el('node', 990001, P[0], P[1], { shop: 'supermarket', name: 'Plaza Vea', 'addr:street': 'Av. Prueba', 'addr:housenumber': '123' }),
    el('way', 990002, P[0] - 0.00015, P[1] + 0.0002, { shop: 'supermarket', building: 'yes', name: 'Plaza Vea' }),
    // parking of a Plaza Vea (ignored) and a bus stop
    el('way', 990003, P[0] + 0.0005, P[1] - 0.0005, { amenity: 'parking', name: 'Plaza Vea' }),
    el('node', 990004, P[0] + 0.0015, P[1] - 0.0015, { highway: 'bus_stop', name: 'Plaza Vea' }),
    // a Wong in Trujillo: outside the scanned area → dropped
    el('node', 990005, -8.1116, -79.0288, { shop: 'supermarket', name: 'Wong' }),
  ];
  let calls = 0;
  const realOverpass = MT.geo.overpass;
  MT.geo.overpass = (query) => { calls++; window.__lastQuery = query; return Promise.resolve({ json: { osm3s: { timestamp_osm_base: '2026-07-28T10:00:00Z' }, elements }, endpoint: 'https://overpass.kumi.systems/api/interpreter', timestamp: '2026-07-28T10:00:00Z' }); };
  const progress = [];
  const res = await MT.osm.scan({ ubigeos: ['150122'], chains: ['wong', 'vivanda', 'plazavea'] }, { onProgress: (p) => progress.push(p.phase) });
  ok(calls === 1 && /150122|out center/.test(window.__lastQuery), 'one Overpass query for one district');
  ok(progress.includes('query') && progress.includes('process'), 'progress reported (query → process)');
  ok(res.timestamp === '2026-07-28T10:00:00Z' && res.endpoint.includes('kumi'), 'result carries the OSM data date and endpoint');
  ok(res.new.length === 1 && res.new[0].id === 'osm-n990001' && res.new[0].chain === 'plazavea', 'NEW: the Plaza Vea (node kept, building duplicate merged)', res.new.map((s) => s.id));
  ok(res.new[0].address === 'Av. Prueba 123' && res.new[0].ubigeo === '150122' && res.new[0].status === 'to_verify', 'new store: address from addr:*, located, to verify');
  const mv = res.matched.find((m) => m.store.id === seedViv.id);
  ok(mv && mv.moved && Math.round(mv.distance) > 80, 'MATCHED + moved: Vivanda 89 m away', mv && Math.round(mv.distance));
  ok(res.matched.find((m) => m.store.id === seedWong.id && !m.moved), 'MATCHED: Wong at the same place');
  ok(res.notFound.length === otherOsm.length && res.notFound.every((s) => s.source === 'osm'), 'NOT FOUND: the other OSM-sourced stores of the area', [res.notFound.length, otherOsm.length]);
  ok(!res.new.some((s) => s.lat > -9), 'element outside the area polygons dropped');
  window.__scanRes = res;
  // Review screen
  await __noModal();
  const rev = MT.dbui.openReview(res);
  await __until(() => __$('.mt-osm-review'));
  const modal = __$('.mt-osm-review').closest('.mt-modal-backdrop');
  ok(/Datos OSM al 28\/07\/2026/.test(__$('.mt-osm-meta', modal).textContent), 'review shows the OSM data date');
  ok(/kumi/.test(__$('.mt-osm-meta', modal).textContent), 'review shows the server');
  const tabs = __$$('.mt-osm-tab', modal).map((t) => t.textContent);
  ok(/Nuevas \(1\)/.test(tabs[0]) && /Ya registradas \(2\)/.test(tabs[1]) && /1 movida/.test(tabs[1]), 'tabs with counts', tabs);
  ok(__$$('.mt-osm-row input[type=checkbox]', modal).every((b) => b.checked), 'new stores are pre-selected');
  __$$('.mt-osm-tab', modal)[2].click();
  ok(__$$('.mt-osm-row input[type=checkbox]', modal).every((b) => !b.checked), 'not-found stores are NOT pre-selected (never automatic)');
  // tick the first not-found and choose "Cerrada"
  const nfBox = __$$('.mt-osm-row input[type=checkbox]', modal)[0];
  const nfId = nfBox.closest('.mt-osm-row').dataset.key;
  nfBox.click();
  __$$('.mt-osm-listhead .mt-seg__input', modal).find((i) => i.value === 'closed').click();
  ok(/se agregará/.test(__$('.mt-osm-footsum', modal).textContent) && /cambiará de posición/.test(__$('.mt-osm-footsum', modal).textContent) && /Cerrada/.test(__$('.mt-osm-footsum', modal).textContent), 'footer summarizes what will happen', __$('.mt-osm-footsum', modal).textContent);
  window.__nfId = nfId;
  __btn('Aplicar seleccionadas', modal).click();
  const applied = await rev;
  ok(applied && applied.ids.length === 3, 'apply → one bulk upsert of 3 records', applied && applied.ids);
  const added = MT.data.store('osm-n990001');
  ok(added && added.source === 'osm' && added.precision === 'exact' && added.status === 'to_verify' && added.source_ref === 'n990001', 'new store added (osm, exact, to verify)');
  const moved = MT.data.store(seedViv.id);
  ok(Math.abs(moved.lat - (seedViv.lat + 0.0008)) < 1e-6 && moved.precision === 'exact', 'moved store got the OSM position');
  const nf = MT.data.store(nfId);
  ok(nf.status === 'closed' && /No encontrada en OSM/.test(nf.notes), 'not-found store marked closed with a dated note', { st: nf.status, n: nf.notes });
  ok(MT.data.store(seedWong.id).updated === seedWong.updated, 'unchanged matched store untouched');
  MT.geo.overpass = realOverpass;
  return { checks: __take() };
});

await checks(page, 'osm scan: split on timeout, retries, total failure', async () => {
  const ok = window.__ok;
  const realOverpass = MT.geo.overpass, realSleep = MT.util.sleep;
  MT.util.sleep = () => Promise.resolve(); // skip the retry pauses
  // 1st query: runtime timeout remark → split in 4 → each sub-tile answers.
  let n = 0;
  MT.geo.overpass = () => { n++; return Promise.resolve({ json: n === 1 ? { remark: 'runtime error: Query timed out in "query" at line 3 after 120 seconds.', elements: [] } : { elements: [] }, endpoint: 'https://x/api/interpreter', timestamp: '2026-09-01T00:00:00Z' }); };
  const r1 = await MT.osm.scan({ ubigeos: ['150122'], chains: ['wong'] });
  ok(n === 5 && r1.tiles === 4 && r1.failedTiles.length === 0, 'timeout remark → tile split in 4 and retried', { n, tiles: r1.tiles });
  // Every endpoint failing → retried twice, then a clear error.
  n = 0;
  MT.geo.overpass = () => { n++; const e = new Error('overpass-unavailable'); e.details = [{ endpoint: 'https://overpass.private.coffee/api/interpreter', error: 'overpass-http-504' }]; return Promise.reject(e); };
  let err = null;
  try { await MT.osm.scan({ ubigeos: ['150122'], chains: ['wong'] }); } catch (e) { err = e; }
  ok(err && err.message === 'overpass-unavailable' && n === 3 && err.details.length >= 1, 'all servers busy → 3 attempts then "overpass-unavailable" with details', { n, msg: err && err.message });
  // Abort
  const ctl = new AbortController(); ctl.abort();
  let ab = null;
  try { await MT.osm.scan({ ubigeos: ['150122'], chains: ['wong'] }, { signal: ctl.signal }); } catch (e) { ab = e; }
  ok(ab && ab.name === 'AbortError', 'cancel → AbortError');
  let noRules = null;
  try { await MT.osm.scan({ ubigeos: ['150122'], chains: ['nope'] }); } catch (e) { noRules = e; }
  ok(noRules && noRules.message === 'osm-no-rules', 'chains without rules → osm-no-rules');
  MT.geo.overpass = realOverpass; MT.util.sleep = realSleep;
  return { checks: __take() };
});

await checks(page, 'osm scan dialog UI', async () => {
  const ok = window.__ok;
  await __noModal();
  MT.dbui.setFilters({ department: 'La Libertad', province: 'Trujillo' });
  __btn('Escanear OSM', __$('.mt-db-head')).click();
  await __until(() => __$('.mt-osm-setup'));
  const m = __$('.mt-osm-setup').closest('.mt-modal-backdrop');
  ok(__$('.mt-seg__input[value=province]', m).checked && /Provincia de Trujillo/.test(__$('.mt-osm-area', m).textContent), 'dialog pre-fills the area from the filters (province)');
  ok(/3 distritos/.test(__$('.mt-osm-info', m).textContent), 'plan text shows the area size', __$('.mt-osm-info', m).textContent);
  ok(/servidores espejo/.test(__$('.mt-osm-info', m).textContent), 'file:// warning about slow mirrors shown');
  __$('.mt-seg__input[value=districts]', m).click();
  const inp = __$('.mt-osm-picker input', m);
  __setValue(inp, 'san isidro');
  await __until(() => __$('.mt-osm-sugg__item', m));
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(/San Isidro/.test(__$('.mt-osm-chips', m).textContent), 'district picker adds a chip on Enter');
  __btn('Ninguna', m).click();
  ok(__$('.mt-modal__footer .mt-btn--primary', m).disabled, 'no chains → Scan disabled');
  __btn('Todas', m).click();
  ok(!__$('.mt-modal__footer .mt-btn--primary', m).disabled, 'chains again → Scan enabled');
  __btn('Cancelar', m).click();
  MT.dbui.clearFilters();
  return { checks: __take() };
});
await page.evaluate(() => { MT.geo.overpass = () => Promise.resolve({ json: { elements: [] }, endpoint: 'https://overpass.kumi.systems/api/interpreter', timestamp: '2026-07-28T10:00:00Z' }); });
await page.evaluate(() => { MT.dbui.openReview(Object.assign({}, window.__scanRes)); });
await waitForMapIdle(page, { expr: 'document.querySelector(".mt-osm-map canvas") && true' }).catch(() => {});
await sleep(3500);
await screenshot(page, 'db-osm-review');
await page.evaluate(async () => {
  const rv = document.querySelector('.mt-osm-review');
  const b = rv && window.__btn('Cancelar', rv.closest('.mt-modal-backdrop'));
  if (b) b.click();
  await window.__noModal();
});

/* ---- Cadenas tab -------------------------------------------------------------------------------- */
await page.click('#tab-chains');
await page.waitForFunction(() => document.querySelector('.mt-chains-item'));
await checks(page, 'chains tab', async () => {
  const ok = window.__ok;
  ok(__$$('.mt-chains-item').length === 17, 'list shows the 16 chains + the unregistered one from the import', __$$('.mt-chains-item').length);
  ok(__$$('.mt-chains-group').map((g) => g.firstChild.textContent).join('|').startsWith('Supermercados|Descuento|Mayoristas|Especializadas|Conveniencia'), 'grouped in SPEC order');
  MT.chainsui.select('makro');
  await __until(() => /Makro/.test(__$('.mt-chains-hero__name').textContent));
  const legend = __$$('.mt-chains-card input.mt-input')[1];
  ok(legend.value === 'CASH & CARRY', 'legend name field');
  __setValue(legend, 'MAKRO MAYORISTA');
  const hex = __$('.mt-chains-color__hex');
  __setValue(hex, '#123ABC');
  ok(!__$('.mt-chains-savebar').hidden, 'save bar appears when dirty');
  await __until(() => /MAKRO MAYORISTA/.test(__$('.mt-chains-prevlegend').textContent));
  ok(true, 'legend preview updates live');
  // Invalid regex blocks saving
  const details = __$('.mt-chains-osm'); details.open = true;
  const regex = __$('.mt-chains-osm input.mt-mono');
  __setValue(regex, 'mak(ro');
  ok(regex.classList.contains('is-invalid'), 'invalid regex flagged');
  __setValue(regex, 'makro|macro');
  ok(/makro\|macro/.test(__$('.mt-chains-ere').textContent), 'Overpass filter preview updates');
  const tester = __$('.mt-chains-tester input');
  __setValue(tester, 'Macro Mayorista Ate');
  ok(/Coincide/.test(__$('.mt-chains-test').textContent), 'regex tester: match');
  __btn('Guardar', __$('.mt-chains-savebar')).click();
  await __until(() => MT.data.chain('makro').legendName === 'MAKRO MAYORISTA');
  const c = MT.data.chain('makro');
  ok(c.color === '#123ABC' && c.osm.nameRegex === 'makro|macro' && MT.data.chainState('makro') === 'edited', 'chain saved to the overlay', { col: c.color, re: c.osm.nameRegex });
  await __until(() => __$('.mt-chains-savebar').hidden);
  // Reset
  __btn('Restablecer valores originales').click();
  await __until(() => __modal());
  __btn('Restablecer valores originales', (await __dlg())).click();
  await __until(() => MT.data.chainState('makro') === 'seed');
  ok(MT.data.chain('makro').legendName === 'CASH & CARRY', 'reset restores the shipped chain');
  // Default-off toggle
  MT.chainsui.select('wong');
  await __until(() => /Wong/.test(__$('.mt-chains-hero__name').textContent));
  __$('.mt-chains-switchrow input').click();
  __btn('Guardar', __$('.mt-chains-savebar')).click();
  await __until(() => MT.data.chain('wong').defaultOn === false);
  ok(MT.project.defaultMap().chains.wong === false, 'default-off chain is off in new maps');
  await MT.data.restoreChain('wong');
  return { checks: __take() };
});

await checks(page, 'chains: logos & add/delete', async () => {
  const ok = window.__ok;
  // A 300×120 wide test image with transparent margins (drawn on a canvas → data URI).
  const cv = document.createElement('canvas'); cv.width = 300; cv.height = 120;
  const g = cv.getContext('2d'); g.fillStyle = '#0A7F3F'; g.fillRect(60, 30, 180, 60);
  const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = cv.toDataURL(); });
  MT.chainsui.select('holi');
  await __until(() => /Holi/.test(__$('.mt-chains-hero__name').textContent));
  ok(/Generado/.test(__$('.mt-chains-logo__src').textContent), 'Holi shows the generated-logo note');
  const pBadge = MT.chainsui.uploadBadge({ img, name: 'x.png' });
  await __until(() => __$('.mt-chains-up'));
  ok(__$$('.mt-chains-up canvas').length === 3, 'badge dialog previews the circle at three sizes');
  __$$('.mt-chains-up .mt-seg__input').find((i) => i.value === 'white').click();
  __btn('Usar este logo', (await __dlg())).click();
  const url = await pBadge;
  const dims = await new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = url; });
  ok(dims[0] === 512 && dims[1] === 512 && /^data:image\/png/.test(url), 'badge normalized to a 512×512 PNG data URI', dims);
  ok(MT.logos.get('holi').source === 'overlay' && MT.logos.has('holi'), 'uploaded badge is used for the chain');
  const pWide = MT.chainsui.uploadWide({ img, name: 'w.png' });
  await __until(() => __$('.mt-chains-up__wide'));
  ok(/184 × 64 px/.test((await __dlg()).textContent), 'wide logo trimmed to its content (180×60 + 2 px margin)', (await __dlg()).textContent.match(/\d+ × \d+ px/));
  __btn('Usar este logo', (await __dlg())).click();
  await pWide;
  ok(!!MT.logos.get('holi').wide && MT.data.overlayStats().logos === 1, 'wide logo stored in the overlay');
  await __until(() => __btn('Quitar el subido'));
  // SVG without width/height (only a viewBox) → still a clean 512 px PNG, canvas not tainted
  const svg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="10" y="10" width="180" height="80" rx="16" fill="#E30613"/></svg>');
  const svgImg = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = svg; });
  let svgUrl = null;
  try { const c2 = MT.chainsui.normalizeBadge(svgImg, { fit: 'contain', scale: 1, bg: 'transparent' }); svgUrl = c2.width === 512 && c2.toDataURL('image/png'); } catch (e) { svgUrl = 'ERR ' + e.message; }
  ok(svgImg && /^data:image[/]png/.test(svgUrl || ''), 'SVG logo (viewBox only) normalizes to a 512 px PNG', svgUrl && svgUrl.slice(0, 30));
  // Add a chain through the prompt
  __btn('Nueva cadena').click();
  await __until(() => __$('.mt-modal input'));
  __setValue(__$('.mt-modal input'), 'Plaza Vea');
  __btn('Crear cadena', (await __dlg())).click();
  ok(/Ya existe/.test(__$('.mt-modal .mt-field__error').textContent), 'duplicate chain name rejected');
  __setValue(__$('.mt-modal input'), 'Economax Perú');
  __btn('Crear cadena', (await __dlg())).click();
  await __until(() => MT.data.hasChain('economaxperu'));
  const nc = MT.data.chain('economaxperu');
  ok(nc.name === 'Economax Perú' && nc.legendName === 'ECONOMAX PERÚ' && MT.data.chainState('economaxperu') === 'added', 'new chain created');
  const ncr = MT.osm.rules(nc), v = (s) => MT.osm.nameVerdict(nc, s).verdict;
  ok(nc.osm.nameRegex === '' && ncr.usable && ncr.derived && nc.osm.dense === true && nc.osm.requireShopLike === true && nc.osm.shops.length === 0,
    'new chain: conservative OSM rules (name rule derived from the chain name, dense radii, shop tag required)', MT.osm.chainRules(nc).nameRegex);
  ok(v('ECONOMAX  Perú') === 'match' && v('Economax Peru Surco') === 'match' && v('Economía') === 'none' && v('Farmacia Economax Perú') === 'none',
    'derived rule: accent/case-insensitive, anchored at the start of the name');
  ok(ncr.ere && !/[^\x00-\x7F]/.test(ncr.ere), 'its Overpass filter is pure ASCII', ncr.ere);
  await __until(() => __$('.mt-chains-derived') && !__$('.mt-chains-derived').hidden);
  ok(/nombre de la cadena/.test(__$('.mt-chains-derived').textContent) && __$('.mt-chains-osm input[data-osm=nameRegex]').placeholder === MT.osm.chainRules(nc).nameRegex,
    'Cadenas: the derived rule is shown (placeholder + note)');
  await __until(() => /Economax/.test(__$('.mt-chains-hero__name').textContent));
  __btn('Eliminar cadena').click();
  await __until(() => __modal() && /Eliminar «Economax Perú»/.test(__modal().textContent));
  __btn('Eliminar cadena', (await __dlg())).click();
  await __until(() => !MT.data.hasChain('economaxperu'));
  ok(true, 'custom chain deleted');
  // Unregistered chain (from the import) can be registered
  MT.chainsui.select('cadenarara');
  await __until(() => __btn('Registrar cadena'));
  __btn('Registrar cadena').click();
  await __until(() => __$('.mt-modal input'));
  __setValue(__$('.mt-modal input'), 'Cadena Rara SAC');
  __btn('Registrar cadena', (await __dlg())).click();
  await __until(() => MT.data.hasChain('cadenarara'));
  ok(MT.data.chain('cadenarara').name === 'Cadena Rara SAC' && !MT.data.chain('cadenarara').unknown, 'unknown chain id registered');
  return { checks: __take() };
});
await page.evaluate(() => MT.chainsui.select('holi'));
await sleep(500);
await screenshot(page, 'db-chains-holi-uploaded');

/* ---- Save to folder (download fallback) & discard ----------------------------------------- */
const dl2 = await captureDownloads(page);
await checks(page, 'save to folder (download fallback) & discard', async () => {
  const ok = window.__ok;
  MT.app.showTab('db');
  const st = MT.data.overlayStats();
  ok(st.total >= 8 && st.logos === 1 && st.chains >= 1, 'overlay holds stores, chains and logos', st);
  const realFs = MT.storage.fs.supported;
  MT.storage.fs.supported = false;        // headless cannot click the folder picker: use the download path
  const r = await MT.dbui.saveToFolder();
  MT.storage.fs.supported = realFs;
  ok(r && r.method === 'download', 'without the File System Access API the files are downloaded');
  await __until(() => __modal() && /Archivos descargados/.test(__modal().textContent));
  ok(/data\/stores\.csv/.test((await __dlg()).textContent) && /logos\/logos\.js/.test((await __dlg()).textContent), 'dialog lists the written files');
  __btn('Listo', (await __dlg())).click();
  ok(MT.data.overlayStats().total === st.total, 'download does not clear the overlay (nothing reached the folder)');
  // Discard
  __$('.mt-db-changes .mt-btn--ghost').click();
  await __until(() => __modal() && /Descartar/.test(__modal().textContent));
  ok(/agregada|editada/.test(__$('.mt-db-confirm-detail', (await __dlg())).textContent), 'discard dialog details what will be lost');
  __btn('Descartar cambios', (await __dlg())).click();
  await __until(() => MT.data.overlayStats().total === 0);
  await __until(() => MT.dbui.visible().length === 63);
  ok(true, 'discard brings the database back to the seed');
  await __until(() => /Sin cambios locales/.test(__$('.mt-db-changes').textContent));
  ok(true, 'cluster back to "Sin cambios locales"');
  return { checks: __take() };
});
await sleep(1500);
const files = readdirSync(dl2);
check(['stores.csv', 'stores.js', 'chains.js', 'logos.js'].every((f) => files.includes(f)), `save-to-folder fallback downloads the repo files (${files.join(', ')})`);
check(files.some((f) => /^holi(-wide)?\.png$/.test(f)), 'uploaded logo PNGs included');
const storesJs = readFileSync(path.join(dl2, 'stores.js'), 'utf8');
check(/^\/\*/.test(storesJs) && /window\.MT_SEED = \{"generated":"\d{4}-\d{2}-\d{2}","count":\d+/.test(storesJs), 'stores.js has the MT_SEED shape');
const chainsJs = readFileSync(path.join(dl2, 'chains.js'), 'utf8');
check(/"id":"cadenarara"/.test(chainsJs) && /"name":"Cadena Rara SAC"/.test(chainsJs), 'chains.js includes the registered chain');

/* ---- app:showChanges + language ---------------------------------------------------------------- */
await checks(page, 'showChanges & English', async () => {
  const ok = window.__ok;
  await MT.data.upsertStore({ id: 'osm-w129822354', notes: 'x' });
  MT.app.showTab('maps');
  MT.bus.emit('app:showChanges', {});
  ok(MT.app.currentTab() === 'db' && MT.dbui.filters().local && MT.dbui.visible().length === 1, '"local changes" chip → DB tab filtered to changed stores');
  MT.dbui.setFilters({ local: false });
  await MT.data.resetOverlay();
  MT.i18n.setLang('en');
  await __until(() => /Add store/.test(__$('.mt-db-head').textContent));
  ok(/Add store/.test(__$('.mt-db-head').textContent) && /Chains/.test(__$('.mt-db-fbtn').textContent), 'DB tab re-rendered in English');
  ok(/63 stores/.test(__$('.mt-db-count').textContent), 'count in English');
  MT.dbui.openEditor(MT.dbui.visible()[0].id);
  await __until(() => __$('.mt-db-drawer.is-open'));
  ok(__$('.mt-drawer__title').textContent === 'Edit store', 'drawer in English');
  MT.dbui.closeEditor(true);
  MT.app.showTab('chains');
  await __until(() => /New chain/.test(document.body.textContent));
  ok(/How it will look/.test(__$('.mt-chains-detail').textContent), 'Chains tab in English');
  ok(MT.i18n.missingKeys().length === 0, 'no missing i18n keys', MT.i18n.missingKeys());
  MT.i18n.setLang('es');
  MT.app.showTab('db');
  return { checks: __take() };
});
await sleep(400);
await screenshot(page, 'db-final');
check(errors.length === 0, `no console errors in the main run (${errors.length})`);
errors.forEach((e) => console.log('    ', e));
await browser.close();

/* ============================================================================================
 * 2. Missing data: no files at all
 * ========================================================================================== */
{
  console.log('\n[missing data]');
  const { browser: b2, page: p2, errors: e2 } = await openApp({ lang: 'es', fixtures: 'none', headless, hash: 'base' });
  await sleep(600);
  const st = await p2.evaluate(() => ({
    empty: !document.querySelector('.mt-db-empty').hidden && document.querySelector('.mt-db-empty').textContent,
    scanDisabled: [...document.querySelectorAll('.mt-db-head button')].find((b) => /Escanear/.test(b.textContent)).disabled,
  }));
  check(/data\/stores\.js/.test(st.empty), 'DB tab explains that the stores file is missing');
  check(st.scanDisabled, 'OSM scan disabled without district boundaries');
  await p2.click('#tab-chains');
  await sleep(500);
  const ch = await p2.evaluate(() => document.querySelector('.mt-chains-detail').textContent);
  check(/data\/chains\.js/.test(ch), 'Cadenas tab explains that the chains file is missing');
  await screenshot(p2, 'db-missing-data');
  const unexpected = e2.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
  check(unexpected.length === 0, `only file-not-found errors (${unexpected.join(' | ')})`);
  await b2.close();
}

/* ============================================================================================
 * 2b. Zonas Nielsen on the real data files: facet, column, drawer, Excel; then without data/zones.js
 * ========================================================================================== */
{
  // SheetJS in Node (the vendored build), to read the exported workbooks back.
  const XLSX = (() => {
    const ctx = {}; ctx.window = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(path.join(ROOT, 'vendor', 'xlsx', 'xlsx.full.min.js'), 'utf8'), ctx);
    return ctx.XLSX;
  })();
  const readSheet = (file) => { const wb = XLSX.read(readFileSync(file), { type: 'buffer' }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }); };

  const { browser: bz, page: pz, errors: ez } = await openApp({ lang: 'es', fixtures: 'missing', headless, hash: 'base', viewport: { width: 1440, height: 900 } });
  // Page helpers; the expectations come from the zones' district lists (MT.data.zones.all()[i].ubigeos), NOT from ofStore().
  const installZoneHelpers = async () => {
    await installHelpers(pz);
    await pz.evaluate(() => {
      const Z = MT.data.zones;
      window.__zx = {
        all: () => MT.data.stores({ includeClosed: true }),
        inZone: (zid) => { const set = new Set(Z.get(zid).ubigeos); return MT.data.stores({ includeClosed: true }).filter((s) => set.has(s.ubigeo)); },
        inRest: () => { const set = new Set(Z.all().flatMap((z) => z.ubigeos)); return MT.data.stores({ includeClosed: true }).filter((s) => !set.has(s.ubigeo)); },
        ids: (list) => list.map((s) => s.id).sort().join(),
        btn: () => __$('.mt-db-fbtn[data-facet=zones]'),
        n: (opt) => +opt.querySelector('.mt-db-pop__n').textContent.replace(/\D/g, ''),
        closePop: () => { const p = __$('.mt-db-pop'); if (p) p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); },
        openZones: async () => { __zx.btn().click(); await __until(() => __$('.mt-db-pop--zones')); return __$('.mt-db-pop--zones'); },
      };
    });
  };
  await pz.waitForFunction(() => document.querySelector('.mt-db-table tbody tr[data-id]'));
  await installZoneHelpers();

  await checks(pz, 'zonas nielsen: the facet (es)', async () => {
    const ok = window.__ok;
    const Z = MT.data.zones, all = __zx.all();
    ok(Z.available && Z.all().length === 15, 'the 15 Nielsen zones are loaded', Z.all().length);
    ok(!!__zx.btn() && /Zona Nielsen/.test(__zx.btn().textContent) && __$$('.mt-db-fbtn')[1] === __zx.btn(), 'the filter bar has "Zona Nielsen", right after "Cadenas"', __zx.btn() && __zx.btn().textContent);
    const pop = await __zx.openZones();
    ok(__$$('.mt-db-pop__group', pop).map((g) => g.textContent.trim()).join('|') === 'Lima + Callao|Provincias', 'zones grouped by area: Lima + Callao / Provincias');
    const opts = __$$('.mt-db-pop__opt', pop);
    ok(opts.length === 16 && opts[15].dataset.zone === '__rest__' && /Resto del Perú/.test(opts[15].textContent), '15 zones + "Resto del Perú" as the last option', opts.map((o) => o.dataset.zone));
    ok(opts.slice(0, 15).map((o) => o.dataset.zone).join() === Z.all().map((z) => z.id).join(), 'zones in the order of data/zonas-nielsen.csv');
    const zoneNames = opts.slice(0, 15).map((o) => o.querySelector('.mt-db-pop__name').textContent);
    ok(zoneNames.join() === Z.all().map((z) => z.name).join() && zoneNames.includes('Lima Cono Sur') && zoneNames.includes('Metropolitana Oriente'), 'zone names are shown as data', zoneNames);
    // counts: from the zones' district lists; zones + "Resto del Perú" partition the whole database
    const exp = Z.all().map((z) => __zx.inZone(z.id).length);
    ok(opts.slice(0, 15).every((o, i) => __zx.n(o) === exp[i]) && exp.every((n) => n > 0), 'each zone shows its number of stores', exp);
    ok(__zx.n(opts[15]) === __zx.inRest().length && __zx.inRest().length > 0, '"Resto del Perú" shows the stores that are in no zone', __zx.n(opts[15]));
    ok(exp.reduce((a, b) => a + b, 0) + __zx.inRest().length === all.length, 'zones + "Resto del Perú" add up to every store', all.length);
    ok(__$('.mt-db-pop--zones [role=separator]') && opts.every((o) => o.querySelector('input[type=checkbox]')), 'options are checkboxes; "Resto del Perú" is set apart');
    // select Lima Cono Sur
    opts.find((o) => o.dataset.zone === 'lima-cono-sur').querySelector('input').click();
    ok(__zx.ids(MT.dbui.visible()) === __zx.ids(__zx.inZone('lima-cono-sur')) && MT.dbui.visible().length === exp[2], 'Lima Cono Sur leaves exactly the stores whose district is in that zone', MT.dbui.visible().length);
    ok(MT.dbui.filters().zones.join() === 'lima-cono-sur' && __zx.btn().classList.contains('is-active') && /Zona Nielsen:?\s*Lima Cono Sur/.test(__zx.btn().textContent.trim()), 'the button shows the zone name', __zx.btn().textContent.trim());
    const cnt = __$('.mt-db-count').textContent.match(/^([\d.,]+) de ([\d.,]+) tiendas$/);
    ok(cnt && +cnt[1].replace(/\D/g, '') === exp[2] && +cnt[2].replace(/\D/g, '') === all.length, 'the count shows "n de total tiendas"', __$('.mt-db-count').textContent);
    ok(!__$('.mt-db-clear').hidden, '"Limpiar filtros" appears');
    // a second zone → union, "2 zonas"
    __$$('.mt-db-pop__opt', pop).find((o) => o.dataset.zone === 'metropolitana-sur').querySelector('input').click();
    ok(__zx.ids(MT.dbui.visible()) === __zx.ids(__zx.inZone('lima-cono-sur').concat(__zx.inZone('metropolitana-sur'))) && /2 zonas/.test(__zx.btn().textContent), 'two zones → their union, button says "2 zonas"', __zx.btn().textContent.trim());
    // the area checkbox ticks every zone of the area; indeterminate while partial
    const g = __$$('.mt-db-pop__group', pop);
    const gbox = (i) => g[i].querySelector('input');
    ok(gbox(0).indeterminate && !gbox(0).checked && !gbox(1).indeterminate, 'area checkbox is indeterminate while only some of its zones are ticked');
    gbox(1).click();
    const provs = Z.all().filter((z) => z.area === 'Provincias').map((z) => z.id), lima = Z.all().filter((z) => z.area !== 'Provincias').map((z) => z.id);
    ok(provs.length === 8 && provs.every((id) => MT.dbui.filters().zones.includes(id)) && MT.dbui.filters().zones.length === 10, '"Provincias" ticks its 8 zones (the 2 ticked before stay)', MT.dbui.filters().zones);
    gbox(0).click();   // partial → all ticked
    ok(lima.every((id) => MT.dbui.filters().zones.includes(id)) && gbox(0).checked && !gbox(0).indeterminate && MT.dbui.filters().zones.length === 15, '"Lima + Callao" ticks the rest of its zones: all 15, no "Resto del Perú"', MT.dbui.filters().zones.length);
    ok(__zx.ids(MT.dbui.visible()) === __zx.ids(all.filter((s) => !__zx.inRest().includes(s))) && /15 zonas/.test(__zx.btn().textContent), 'all 15 zones → every store that is in a zone', MT.dbui.visible().length);
    // "Resto del Perú" is the partition's other half
    __$$('.mt-db-pop__opt', pop).find((o) => o.dataset.zone === '__rest__').querySelector('input').click();
    ok(MT.dbui.visible().length === all.length && /16 zonas/.test(__zx.btn().textContent), 'zones + "Resto del Perú" → the whole list', MT.dbui.visible().length);
    gbox(0).click(); gbox(1).click();   // untick both areas (all ticked → click unticks)
    ok(MT.dbui.filters().zones.join() === '__rest__' && __zx.ids(MT.dbui.visible()) === __zx.ids(__zx.inRest()), '"Resto del Perú" alone → the stores in no zone', MT.dbui.visible().length);
    ok(/Zona Nielsen:?\s*Resto del Perú/.test(__zx.btn().textContent.trim()), 'the button says "Resto del Perú"', __zx.btn().textContent.trim());
    ok(MT.dbui.visible().every((s) => !Z.ofStore(s)), 'none of them has a zone (Z.ofStore agrees)');
    __$('.mt-db-pop__head .mt-db-link').click();
    ok(MT.dbui.filters().zones.length === 0 && MT.dbui.visible().length === all.length && !__zx.btn().classList.contains('is-active') && __$$('.mt-db-pop__opt input', pop).every((i) => !i.checked), '"Limpiar" in the popover clears the facet');
    __zx.closePop();
    ok(!__$('.mt-db-pop'), 'Escape closes the popover');
    // pure API
    const F = (f) => MT.dbui.filterStores(all, f);
    ok(F({ zones: ['lima-cono-sur'] }).length === exp[2] && F({ zones: ['lima-cono-sur', 'ya-no-existe'] }).length === exp[2], 'filterStores({zones}) is pure and ignores unknown zone ids');
    ok(F({ zones: ['ya-no-existe'] }).length === all.length && F({}).length === all.length && F({ zones: undefined }).length === all.length, 'only unknown ids (or no zones field) → no zone filter');
    ok(MT.dbui.filterStores(all, { zones: ['lima-cono-sur'] }, 'zones').length === all.length, 'skip="zones" ignores the zone filter (facet counts)');
    ok(F({ zones: ['lima-cono-sur'], chains: ['wong'] }).every((s) => s.chain === 'wong' && Z.ofStore(s).id === 'lima-cono-sur'), 'zones combine with the other filters');
    ok(F({ q: 'cono sur' }).length >= exp[2] && __zx.inZone('lima-cono-sur').every((s) => F({ q: 'cono sur' }).includes(s)), 'the search box also finds a zone by name ("cono sur")');
    return { checks: __take() };
  });
  await pz.evaluate(() => { MT.dbui.setFilters({ zones: ['lima-cono-sur'] }); });
  await sleep(300);
  await screenshot(pz, 'db-zones-table');
  await pz.evaluate(async () => { await __zx.openZones(); });
  await sleep(300);
  await screenshot(pz, 'db-zones-popover');
  await pz.evaluate(() => { __zx.closePop(); MT.dbui.clearFilters(); });
  // Keyboard: the popover focuses its first checkbox; Tab + Space ticks a zone and the focus stays (the list is not rebuilt); Esc gives the focus back
  await pz.evaluate(async () => { await __zx.openZones(); });
  await sleep(100);
  await pz.keyboard.press('Tab');
  await pz.keyboard.press('Space');
  const kz = await pz.evaluate(() => ({ zones: MT.dbui.filters().zones.join(), type: document.activeElement.type, zone: document.activeElement.closest('label') && document.activeElement.closest('label').dataset.zone }));
  check(kz.zones === 'lima-centro' && kz.type === 'checkbox' && kz.zone === 'lima-centro', `keyboard: Tab + Space ticks a zone and the focus stays on its checkbox (${JSON.stringify(kz)})`);
  await pz.keyboard.press('Space');
  check(await pz.evaluate(() => MT.dbui.filters().zones.length === 0 && document.activeElement.type === 'checkbox'), 'keyboard: Space again unticks it');
  await pz.keyboard.press('Escape');
  check(await pz.evaluate(() => !__$('.mt-db-pop') && document.activeElement === __zx.btn()), 'keyboard: Escape closes the popover and the focus returns to the "Zona Nielsen" button');

  await checks(pz, 'zonas nielsen: counts respect the other filters', async () => {
    const ok = window.__ok;
    const Z = MT.data.zones, all = __zx.all();
    const wong = all.filter((s) => s.chain === 'wong');
    MT.dbui.setFilters({ chains: ['wong'] });
    let pop = await __zx.openZones();
    let opts = __$$('.mt-db-pop__opt', pop);
    const zexp = Z.all().map((z) => wong.filter((s) => z.ubigeos.includes(s.ubigeo)).length);
    ok(opts.slice(0, 15).every((o, i) => __zx.n(o) === zexp[i]), 'with Wong ticked, each zone counts only Wong stores', zexp);
    ok(zexp.reduce((a, b) => a + b, 0) + __zx.n(opts[15]) === wong.length && opts.reduce((a, o) => a + __zx.n(o), 0) === wong.length && wong.length > 0, 'and zones + "Resto del Perú" add up to the Wong stores', wong.length);
    __zx.closePop();
    // the other direction: the other facets count under the zone filter
    MT.dbui.setFilters({ chains: [], zones: ['lima-cono-sur'] });
    const inCS = __zx.inZone('lima-cono-sur');
    __$('.mt-db-fbtn[data-facet=chains]').click();
    await __until(() => __$('.mt-db-pop--chains'));
    const wongOpt = __$$('.mt-db-pop__opt').find((l) => /Wong/.test(l.textContent));
    ok(__zx.n(wongOpt) === inCS.filter((s) => s.chain === 'wong').length, 'the chains popover counts only the stores of the selected zone', __zx.n(wongOpt));
    __zx.closePop();
    __$('.mt-db-fbtn[data-facet=location]').click();
    await __until(() => __$('.mt-db-pop--location select'));
    const sel0 = __$('.mt-db-pop--location select');
    const depN = (o) => +o.textContent.match(/\(([\d.,]+)\)$/)[1].replace(/\D/g, '');
    const deps = [...sel0.options].filter((o) => o.value && o.value !== '__none__');
    ok(deps.length > 20 && deps.every((o) => depN(o) === inCS.filter((s) => s.department === o.value).length) && depN(deps.find((o) => o.value === 'Lima')) > 0, 'the location popover counts only the stores of the selected zone (every department)', deps.filter((o) => depN(o)).map((o) => o.textContent));
    __zx.closePop();
    MT.dbui.clearFilters();
    return { checks: __take() };
  });

  await checks(pz, 'zonas nielsen: column & sorting', async () => {
    const ok = window.__ok;
    const Z = MT.data.zones;
    const th = () => __$$('.mt-db-table th').find((x) => x.textContent.trim() === 'Zona Nielsen');
    ok(!!th() && th().classList.contains('is-sortable') && th().getAttribute('aria-sort') === 'none', 'the table has a sortable "Zona Nielsen" column', __$$('.mt-db-table th').map((x) => x.textContent.trim()));
    ok(__$$('.mt-db-table th').map((x) => x.textContent.trim()).join('|') === '|Cadena|Tienda|Zona Nielsen|Distrito|Estado', 'columns at 1440 px with the map open: …Tienda, Zona Nielsen, Distrito, Estado', __$$('.mt-db-table th').map((x) => x.textContent.trim()));
    const rows = __$$('.mt-db-table tbody tr[data-id]');
    const cell = (tr) => tr.querySelector('.mt-db-td-zone');
    const wrongRow = rows.find((tr) => {
      const s = MT.data.store(tr.dataset.id), z = Z.all().find((zz) => zz.ubigeos.includes(s.ubigeo));
      return z ? !cell(tr).textContent.includes(z.name) : cell(tr).dataset.zone !== '__rest__' || !/^—/.test(cell(tr).textContent.trim());
    });
    ok(rows.length > 10 && !wrongRow, 'every row shows its zone (name), or a muted dash for "Resto del Perú"', wrongRow && wrongRow.textContent);
    const restRows = rows.filter((tr) => cell(tr).dataset.zone === '__rest__');
    ok(restRows.length > 0 && restRows.every((tr) => cell(tr).querySelector('.mt-muted') && /Resto del Perú/.test(cell(tr).textContent)), 'the dash is muted and named for screen readers', restRows.length);
    ok(__$('.mt-db-tablewrap').scrollWidth <= __$('.mt-db-tablewrap').clientWidth + 1, 'no horizontal scrolling in the table', [__$('.mt-db-tablewrap').scrollWidth, __$('.mt-db-tablewrap').clientWidth]);
    const rank = (s) => { const i = Z.all().findIndex((z) => z.ubigeos.includes(s.ubigeo)); return i < 0 ? 99 : i; };
    th().click();
    ok(th().getAttribute('aria-sort') === 'ascending' && th().classList.contains('is-sorted'), 'click sorts ascending (aria-sort)');
    const asc = MT.dbui.visible();
    ok(asc.every((s, i) => !i || rank(asc[i - 1]) <= rank(s)) && rank(asc[0]) === 0 && rank(asc[asc.length - 1]) === 99, 'ascending: zones in the order of data/zonas-nielsen.csv, "Resto del Perú" last', [rank(asc[0]), rank(asc[asc.length - 1])]);
    const sameZone = asc.filter((s) => rank(s) === rank(asc[0]));
    ok(sameZone.every((s, i) => !i || MT.util.compare(sameZone[i - 1].name, s.name) <= 0), 'inside a zone: by store name', sameZone.length);
    ok(MT.storage.pref('db.sort', null).key === 'zone', 'the sort is remembered');
    th().click();
    const desc = MT.dbui.visible();
    ok(th().getAttribute('aria-sort') === 'descending' && desc.every((s, i) => !i || rank(desc[i - 1]) >= rank(s)) && rank(desc[0]) === 99, 'second click: descending ("Resto del Perú" first)');
    ok(__$$('.mt-db-table tbody tr[data-id]').every((tr, i, a) => !i || rank(MT.data.store(a[i - 1].dataset.id)) >= rank(MT.data.store(tr.dataset.id))), 'the rendered rows follow the sort');
    __$$('.mt-db-table th').find((x) => x.textContent.trim() === 'Cadena').click();
    return { checks: __take() };
  });
  // Widths: the Tienda column must stay usable; Zona Nielsen comes before Fuente / Actualizado.
  const colsAt = async (width) => {
    await pz.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await sleep(500);
    return pz.evaluate(() => ({ heads: __$$('.mt-db-table th').map((x) => x.textContent.trim()).join('|'), over: __$('.mt-db-tablewrap').scrollWidth - __$('.mt-db-tablewrap').clientWidth,
      tienda: Math.round(__$('.mt-db-table tbody tr[data-id] td:nth-child(3)').getBoundingClientRect().width), tw: __$('.mt-db-tablewrap').clientWidth }));
  };
  for (const [w, heads] of [[1000, '|Cadena|Tienda|Distrito|Estado'], [1300, '|Cadena|Tienda|Distrito|Estado'], [1340, '|Cadena|Tienda|Distrito|Estado'], [1400, '|Cadena|Tienda|Zona Nielsen|Distrito|Estado'], [1440, '|Cadena|Tienda|Zona Nielsen|Distrito|Estado'], [1700, '|Cadena|Tienda|Zona Nielsen|Distrito|Estado|Fuente'], [2000, '|Cadena|Tienda|Zona Nielsen|Distrito|Estado|Fuente|Actualizado']]) {
    const c = await colsAt(w);
    // (the Tienda column takes what is left: Zona Nielsen shows from a table of 800 px, where Tienda keeps >= 130 px)
    check(c.heads === heads && c.over <= 1 && (w < 1400 || c.tienda >= 130), `viewport ${w} px (table ${c.tw} px): columns ${c.heads.replace(/\|/g, ' · ')}; Tienda ${c.tienda} px, no horizontal scroll`);
  }
  await pz.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await sleep(400);

  await checks(pz, 'zonas nielsen: edit drawer', async () => {
    const ok = window.__ok;
    const Z = MT.data.zones;
    const cs = __zx.inZone('lima-cono-sur')[0];
    MT.dbui.openEditor(cs.id);
    await __until(() => __$('.mt-db-drawer.is-open') && __$('.mt-db-zoneline'));
    let line = __$('.mt-db-drawer .mt-db-zoneline');
    ok(/Zona Nielsen/.test(line.textContent) && /Lima Cono Sur/.test(line.textContent) && line.dataset.zone === 'lima-cono-sur', 'the drawer shows the store\'s Zona Nielsen next to its district', line.textContent);
    ok(line.textContent.includes('Lima + Callao'), 'with its area');
    ok(!__$('.mt-db-zoneline input, .mt-db-zoneline select'), 'it is read-only (no control)');
    ok(!__$('.mt-db-drawer').classList.contains('is-dirty'), 'looking at it does not make the form dirty');
    // move the pin (pasted coordinates) to Miraflores, then to Cusco: the zone follows the district
    const paste = (txt) => { const p = __$('#mt-db-f-paste'); p.value = txt; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
    paste('-12.1219, -77.0297');
    const mira = Z.ofDistrict(MT.data.locate(-12.1219, -77.0297).ubigeo);
    line = __$('.mt-db-drawer .mt-db-zoneline');
    ok(mira && mira.id !== 'lima-cono-sur' && line.dataset.zone === mira.id && line.textContent.includes(mira.name) && /Miraflores/.test(__$('.mt-db-district').textContent), 'moving the pin to Miraflores updates the zone to ' + (mira && mira.name), line.textContent);
    paste('-13.5320, -71.9675');
    const cusco = MT.data.locate(-13.5320, -71.9675);
    line = __$('.mt-db-drawer .mt-db-zoneline');
    ok(cusco && !Z.ofDistrict(cusco.ubigeo) && line.dataset.zone === '__rest__' && /Resto del Perú/.test(line.textContent), 'a district in no zone → "Resto del Perú"', line.textContent);
    paste('-13.5320');   // not a coordinate pair: nothing changes
    ok(!!__$('.mt-db-zoneline'), 'an unreadable paste leaves the line alone');
    MT.dbui.closeEditor(true);
    await __until(() => !__$('.mt-db-drawer.is-open'));
    // a new store has no position yet: no zone to show
    MT.dbui.openEditor(null);
    await __until(() => __$('.mt-db-drawer.is-open') && __$('.mt-db-district'));
    ok(!__$('.mt-db-zoneline') && /Todavía sin ubicación/.test(__$('.mt-db-district').textContent), 'a new store without position: no zone line');
    paste('-12.1219, -77.0297');
    ok(!!__$('.mt-db-zoneline') && __$('.mt-db-zoneline').dataset.zone === mira.id, 'it appears when the pin is placed');
    MT.dbui.closeEditor(true);
    await __until(() => !__$('.mt-db-drawer.is-open'));
    return { checks: __take() };
  });
  await pz.evaluate(() => { MT.dbui.openEditor(__zx.inZone('lima-cono-sur')[0].id); });
  await sleep(1500);
  await screenshot(pz, 'db-zones-drawer');
  await pz.evaluate(() => MT.dbui.closeEditor(true));

  await waitForMapIdle(pz, { expr: 'MT.dbui && MT.dbui._map' }).catch(() => {});
  await checks(pz, 'zonas nielsen: map card', async () => {
    const ok = window.__ok;
    const cs = __zx.inZone('lima-cono-sur')[0];
    MT.dbui.select(cs.id, { source: 'api' });
    await __until(() => __$('.mt-db-card'), 15000);
    ok(__$$('.mt-db-card .mt-badge').some((b) => b.textContent === 'Lima Cono Sur'), 'the store card on the map names the zone', __$$('.mt-db-card .mt-badge').map((b) => b.textContent));
    return { checks: __take() };
  });

  await checks(pz, 'zonas nielsen: English', async () => {
    const ok = window.__ok;
    const Z = MT.data.zones;
    MT.i18n.setLang('en');
    MT.dbui.setFilters({ zones: ['lima-cono-sur', '__rest__'] });
    await __until(() => /2 zones/.test(__zx.btn().textContent));
    ok(/Zona Nielsen/.test(__zx.btn().textContent) && /2 zones/.test(__zx.btn().textContent), 'English: the facet is "Zona Nielsen", two selected say "2 zones"', __zx.btn().textContent.trim());
    MT.dbui.setFilters({ zones: ['__rest__'] });
    ok(/Rest of Peru/.test(__zx.btn().textContent), 'English: the single "Resto del Perú" is "Rest of Peru" on the button', __zx.btn().textContent.trim());
    const pop = await __zx.openZones();
    ok(/Filter by Nielsen zone/i.test(pop.textContent) && __$$('.mt-db-pop__group', pop).map((g) => g.textContent.trim()).join('|') === 'Lima + Callao|Provinces', 'English popover: title and areas (Lima + Callao / Provinces)', __$$('.mt-db-pop__group', pop).map((g) => g.textContent.trim()));
    const opts = __$$('.mt-db-pop__opt', pop);
    ok(/Rest of Peru/.test(opts[15].textContent) && opts.slice(0, 15).map((o) => o.querySelector('.mt-db-pop__name').textContent).join() === Z.all().map((z) => z.name).join(), 'English: the last option is "Rest of Peru"; zone names stay as data');
    __zx.closePop();
    MT.dbui.setFilters({ zones: [] });
    ok(__$$('.mt-db-table th').some((x) => x.textContent.trim() === 'Zona Nielsen'), 'English: the column is "Zona Nielsen"');
    const restRow = __$$('.mt-db-table tbody tr[data-id]').find((tr) => tr.querySelector('.mt-db-td-zone').dataset.zone === '__rest__');
    ok(!restRow || /Rest of Peru/.test(restRow.querySelector('.mt-db-td-zone').textContent), 'English: the dash cell is read as "Rest of Peru"');
    MT.dbui.openEditor(__zx.inZone('metropolitana-sur')[0].id);
    await __until(() => __$('.mt-db-drawer.is-open') && __$('.mt-db-zoneline'));
    ok(/Zona Nielsen/.test(__$('.mt-db-zoneline').textContent) && /Metropolitana Sur/.test(__$('.mt-db-zoneline').textContent), 'English drawer: "Zona Nielsen Metropolitana Sur"', __$('.mt-db-zoneline').textContent);
    MT.dbui.closeEditor(true);
    ok(/zone/.test(__$('.mt-db-search__input').placeholder), 'English: the search placeholder mentions the zone', __$('.mt-db-search__input').placeholder);
    ok(MT.i18n.missingKeys().length === 0, 'no missing i18n keys in English', MT.i18n.missingKeys());
    MT.i18n.setLang('es');
    await __until(() => /Zona Nielsen/.test(__zx.btn().textContent));
    MT.dbui.setFilters({ zones: ['__rest__'] });
    ok(/Resto del Perú/.test(__zx.btn().textContent), 'back in Spanish: "Resto del Perú"');
    MT.dbui.clearFilters();
    return { checks: __take() };
  });

  /* ---- Excel export: the filtered list gets a "Zona Nielsen" column; CSV and repository files do not ---- */
  const dlz = await captureDownloads(pz, path.join(OUT, 'downloads-zones'));
  await checks(pz, 'zonas nielsen: exports', async () => {
    MT.dbui.setFilters({ zones: ['lima-cono-sur'] });
    await MT.dbui.exportStores('csv');
    await MT.dbui.exportStores('xlsx');
    MT.dbui.clearFilters();
    return { checks: [] };
  });
  const csvZ = readFileSync(await waitForDownload(dlz, /\.csv$/), 'utf8');
  check(!/Zona Nielsen|zone/i.test(csvZ.split('\r\n')[0]) && csvZ.split('\r\n')[0] === '﻿' + (await pz.evaluate(() => MT.data.COLUMNS.join(','))), 'the filtered CSV keeps the canonical columns (no Zona Nielsen)');
  const xFile = await waitForDownload(dlz, /\.xlsx$/);
  const xr = readSheet(xFile);
  const cols = await pz.evaluate(() => MT.data.COLUMNS.slice());
  const csExpected = await pz.evaluate(() => __zx.inZone('lima-cono-sur').length);
  check(xr[0].join() === [...cols.slice(0, cols.indexOf('ubigeo') + 1), 'Zona Nielsen', ...cols.slice(cols.indexOf('ubigeo') + 1)].join(), `the filtered Excel has a "Zona Nielsen" column right after the Ubigeo (${xr[0].slice(6, 11).join(' · ')})`);
  const iz = xr[0].indexOf('Zona Nielsen'), iLat = xr[0].indexOf('lat'), iId = xr[0].indexOf('id');
  check(xr.length - 1 === csExpected && csExpected > 0 && xr.slice(1).every((r) => r[iz] === 'Lima Cono Sur'), `its ${xr.length - 1} rows all say "Lima Cono Sur"`);
  check(xr.slice(1).every((r) => typeof r[iLat] === 'number' && r[xr[0].indexOf('lng')] < 0), 'lat/lng stay numbers (their column shifted by one)');
  const ids = new Set(await pz.evaluate(() => __zx.inZone('lima-cono-sur').map((s) => s.id)));
  check(xr.slice(1).every((r) => ids.has(r[iId])), 'and they are the stores of that zone');
  rmSync(xFile, { force: true });
  await checks(pz, 'zonas nielsen: Excel of the whole base', async () => {
    await MT.dbui.exportStores('xlsx', { all: true });
    return { checks: [] };
  });
  const xAll = readSheet(await waitForDownload(dlz, /\.xlsx$/));
  const allInfo = await pz.evaluate(() => ({ n: __zx.all().length, rest: __zx.inRest().length }));
  const izA = xAll[0].indexOf('Zona Nielsen');
  check(xAll.length - 1 === allInfo.n && xAll.slice(1).filter((r) => r[izA] === 'Resto del Perú').length === allInfo.rest && xAll.slice(1).every((r) => r[izA]), `the whole-base Excel: ${xAll.length - 1} rows, every one with a zone or "Resto del Perú" (${allInfo.rest})`);

  /* ---- Persistence: a saved filter comes back (and an old one without the field still loads) ---- */
  const reload = async () => {
    await pz.reload({ waitUntil: 'load' });
    await pz.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
    await pz.waitForFunction(() => document.querySelector('.mt-db-table tbody tr[data-id]'));
    await installZoneHelpers();
  };
  await pz.evaluate(() => { MT.dbui.setFilters({ zones: ['lima-cono-sur', 'trujillo'] }); });
  await reload();
  await checks(pz, 'zonas nielsen: filter persistence', async () => {
    const ok = window.__ok;
    ok(MT.dbui.filters().zones.join() === 'lima-cono-sur,trujillo', 'the zone filter survives a reload', MT.dbui.filters().zones);
    ok(__zx.ids(MT.dbui.visible()) === __zx.ids(__zx.inZone('lima-cono-sur').concat(__zx.inZone('trujillo'))) && /2 zonas/.test(__zx.btn().textContent) && __zx.btn().classList.contains('is-active'), 'the table, the count and the button show it', __zx.btn().textContent.trim());
    const pop = await __zx.openZones();
    ok(__$$('.mt-db-pop__opt input', pop).filter((i) => i.checked).length === 2, 'and so does the popover (2 ticked)');
    __zx.closePop();
    // an old saved filter (before zones existed): loads, zones empty, the rest intact
    localStorage.setItem('mt.pref.db.filters', JSON.stringify({ q: '', chains: ['wong'], department: '', province: '', ubigeo: '', statuses: [], sources: [], precisions: [], local: false }));
    return { checks: __take() };
  });
  await reload();
  await checks(pz, 'zonas nielsen: an old saved filter', async () => {
    const ok = window.__ok;
    ok(MT.dbui.filters().zones.length === 0 && MT.dbui.filters().chains.join() === 'wong', 'a filter saved without the "zones" field loads (no zones, chains intact)', MT.dbui.filters());
    ok(MT.dbui.visible().every((s) => s.chain === 'wong') && MT.dbui.visible().length === __zx.all().filter((s) => s.chain === 'wong').length, 'and filters as saved');
    // ids that no longer exist (or junk) are dropped on load; the ones that exist stay
    localStorage.setItem('mt.pref.db.filters', JSON.stringify({ q: '', chains: [], zones: ['lima-cono-sur', 'ya-no-existe', 7, null, '__rest__'], department: '', province: '', ubigeo: '', statuses: [], sources: [], precisions: [], local: false }));
    return { checks: __take() };
  });
  await reload();
  await checks(pz, 'zonas nielsen: saved zone ids are checked', async () => {
    const ok = window.__ok;
    ok(MT.dbui.filters().zones.join() === 'lima-cono-sur,__rest__', 'unknown ids and non-strings are dropped, the known ones stay', MT.dbui.filters().zones);
    ok(__zx.ids(MT.dbui.visible()) === __zx.ids(__zx.inZone('lima-cono-sur').concat(__zx.inRest())), 'the list follows the cleaned filter', MT.dbui.visible().length);
    localStorage.setItem('mt.pref.db.filters', JSON.stringify({ zones: 'lima-cono-sur', chains: 5 }));   // wrong types: ignored field by field
    return { checks: __take() };
  });
  await reload();
  await checks(pz, 'zonas nielsen: wrong types in the saved filter', async () => {
    const ok = window.__ok;
    ok(MT.dbui.filters().zones.length === 0 && MT.dbui.filters().chains.length === 0 && MT.dbui.visible().length === __zx.all().length, 'a non-array "zones" is ignored like the other fields');
    MT.dbui.clearFilters();
    return { checks: __take() };
  });
  const realZ = splitNetworkNoise(ez).real;
  check(realZ.length === 0, `no console errors in the zones run (${realZ.length})`);
  realZ.forEach((e) => console.log('    ', e));
  await bz.close();

  /* ---- Without data/zones.js the tab has no zone UI and nothing breaks ---- */
  console.log('\n[zonas nielsen: without data/zones.js]');
  const noz = prepareApp({ fixtures: 'missing' });
  rmSync(path.join(noz.dir, 'data', 'zones.js'));
  const bn = await launch();
  const pn = (await bn.pages())[0];
  await pn.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const en = collectErrors(pn);
  // a zone filter saved by a session that had the file: must not hide anything now
  await pn.evaluateOnNewDocument(() => { try { localStorage.setItem('mt.pref.db.filters', JSON.stringify({ q: '', chains: [], zones: ['lima-cono-sur'], department: '', province: '', ubigeo: '', statuses: [], sources: [], precisions: [], local: false })); } catch (e) { /* ignore */ } });
  await pn.goto(noz.url + '?lang=es#base', { waitUntil: 'load' });
  await pn.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
  await pn.waitForFunction(() => document.querySelector('.mt-db-table tbody tr[data-id]'));
  await installHelpers(pn);
  const nz = await pn.evaluate(async () => {
    const all = MT.data.stores({ includeClosed: true });
    const out = {
      available: MT.data.zones.available,
      facets: [...document.querySelectorAll('.mt-db-fbtn')].map((b) => b.dataset.facet).join(),
      heads: [...document.querySelectorAll('.mt-db-table th')].map((x) => x.textContent.trim()).join('|'),
      visible: MT.dbui.visible().length, total: all.length, zones: MT.dbui.filters().zones.length,
      pure: MT.dbui.filterStores(all, { zones: ['lima-cono-sur'] }).length, search: MT.dbui.filterStores(all, { q: 'cono sur' }).length,
      clear: document.querySelector('.mt-db-clear').hidden,
    };
    MT.dbui.openEditor(MT.dbui.visible()[0].id);
    await __until(() => __$('.mt-db-drawer.is-open') && __$('.mt-db-district'));
    out.drawerLine = !!document.querySelector('.mt-db-zoneline');
    out.drawerDistrict = document.querySelector('.mt-db-district').textContent.length > 0;
    MT.dbui.closeEditor(true);
    MT.dbui.select(MT.dbui.visible()[3].id, { source: 'api' });
    MT.dbui.setFilters({ chains: ['wong'] });
    out.afterFilter = MT.dbui.visible().length;
    return out;
  });
  check(!nz.available && nz.facets === 'chains,location,statuses,sources,precisions' && !/Zona Nielsen/.test(nz.heads), `without zones.js: no zone facet (${nz.facets}) and no zone column (${nz.heads})`);
  check(nz.visible === nz.total && nz.zones === 0 && nz.pure === nz.total && nz.clear === true, `a saved zone filter is dropped: all ${nz.visible} stores listed, no "Limpiar filtros"`);
  check(nz.drawerLine === false && nz.drawerDistrict, 'the drawer shows the district and no zone line');
  check(nz.afterFilter > 0 && nz.afterFilter < nz.total, `the other filters still work (${nz.afterFilter} Wong stores)`);
  const dln = await captureDownloads(pn, path.join(OUT, 'downloads-nozones'));
  await pn.evaluate(async () => { MT.dbui.clearFilters(); await MT.dbui.exportStores('xlsx'); });
  const xn = readSheet(await waitForDownload(dln, /\.xlsx$/));
  check(xn[0].join() === (await pn.evaluate(() => MT.data.COLUMNS.join(','))) && xn.length - 1 === nz.total, 'the Excel export still works without zones: the canonical columns, every store');
  await screenshot(pn, 'db-zones-missing');
  const unexpectedN = splitNetworkNoise(en).real.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
  check(unexpectedN.length === 0, `only the file-not-found of zones.js (${unexpectedN.join(' | ')})`);
  await bn.close();
  rmSync(noz.dir, { recursive: true, force: true });
}

/* ============================================================================================
 * 3. Optional live Overpass scan (slow from file://: mirrors take 35–170 s)
 * ========================================================================================== */
if (live) {
  console.log('\n[live overpass]');
  const { browser: b3, page: p3, errors: e3 } = await openApp({ lang: 'es', fixtures: 'all', headless, hash: 'base' });
  const r = await p3.evaluate(async () => {
    try {
      const res = await MT.osm.scan({ ubigeos: ['150122'], chains: ['plazavea', 'wong', 'vivanda', 'metro'] }, { timeoutMs: 200000 });
      return { ok: true, n: res.new.length, m: res.matched.length, nf: res.notFound.length, ts: res.timestamp, ep: res.endpoint, el: res.elements };
    } catch (e) { return { ok: false, err: e.message, details: e.details }; }
  });
  console.log('   ', JSON.stringify(r));
  check(r.ok && r.el > 0 && (r.n + r.m) > 0 && r.ts, 'live scan of Miraflores returns stores and a data date');
  check(e3.filter((e) => !/overpass|interpreter/.test(e)).length === 0, 'no unexpected errors in the live run');
  await b3.close();
}

finish();
