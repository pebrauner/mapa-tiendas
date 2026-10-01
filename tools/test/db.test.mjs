// tools/test/db.test.mjs — module M3: Base de datos, Cadenas, import/export, OSM scan.
//
//   node tools/test/db.test.mjs            fixtures for every data file, no network for data
//                                           (Nominatim and Overpass are mocked in the page)
//   node tools/test/db.test.mjs --live     + one real Overpass scan of Miraflores (slow on file://)
//   node tools/test/db.test.mjs --headful  watch it
// Screenshots: tools/test/out/db-*.png. Fails on any console error.

import { openApp, screenshot, makeChecker, sleep, captureDownloads, waitForDownload, waitForMapIdle } from './lib.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

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
  ok(__$$('.mt-db-fbtn').length === 5, 'five filter buttons (chains, location, status, source, precision)');
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
  __$$('.mt-db-fbtn')[1].click();
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
  ok(MT.dbui.visible().length === 15 && /Miraflores/.test(__$$('.mt-db-fbtn')[1].textContent), 'district chosen → 15 stores, button shows Miraflores');
  __$('.mt-db-pop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Status popover
  __$$('.mt-db-fbtn')[2].click();
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
