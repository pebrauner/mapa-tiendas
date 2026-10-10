// tools/test/analysis-zones.test.mjs — the Análisis tab offers the Zonas Nielsen (the SUBAREA grouping of the company
// store list, MT.data.zones) wherever it used to offer the "Zonas de Lima" presets (APEIM), on the REAL data.
//
//   node tools/test/analysis-zones.test.mjs
//
//   1. Mode B without a region: "Elige la región" offers the 15 zones as buttons, grouped in two areas
//      (Lima + Callao / Provincias); the search box, the hint and the text mention zones.
//   2. The district picker's "Zonas Nielsen" menu: 15 zones under the two area headings, whole on a 1280 × 720
//      screen; picking a zone adds exactly its districts (a second pick adds nothing, "Esos distritos ya están");
//      a zone already whole shows a check; typing a zone name in the search box offers the zone (after the
//      districts, so Enter on "trujillo" still picks the district).
//   3. A district set equal to a zone — or to two or three whole zones — is named after it: the matrix title, the
//      Excel file name and its "Parámetros" sheet (in any order of the districts); one district less → "N distritos".
//   4. Mode A: the "Zonas Nielsen" universe has the same menu; the empty state and the Excel name the zone.
//   5. English: headings "Lima + Callao" / "Provinces", the title "Proximity matrix · Lima Cono Sur", the Excel name;
//      the zone names themselves are data (never translated).
//   6. The region is stored as districts: after a reload the saved region comes back, named after its zone.
//   7. Without data/zones.js (MT.data.zones.available = false, a second app) there are no zone shortcuts (no menu, no
//      buttons, no zone in the search results) and nothing else breaks: districts are still picked and named.
// Zero console errors.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { openApp, screenshot, waitForMapIdle, captureDownloads, waitForDownload, makeChecker, sleep, splitNetworkNoise, ROOT, OUT } from './lib.mjs';

const { check, finish } = makeChecker('analysis-zones');

const XLSX = (() => {
  const ctx = {}; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'vendor', 'xlsx', 'xlsx.full.min.js'), 'utf8'), ctx);
  return ctx.XLSX;
})();
function readBook(file) {
  const wb = XLSX.read(readFileSync(file), { type: 'buffer' });
  const sheets = {};
  wb.SheetNames.forEach((n) => { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); });
  return { names: wb.SheetNames, sheets };
}
const sorted = (list) => list.slice().sort().join();

/** The picker and menu helpers of a page (mode B's side panel unless `scope` says otherwise). */
function helpers(page) {
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const SIDE = '.mt-analysis-side .mt-analysis-districts';
  return {
    ev,
    head: () => ev(() => (document.querySelector('.mt-analysis-mainhead__h') || {}).textContent),
    idle: () => ev(() => MT.analysisui.whenIdle()),
    region: () => ev(() => MT.analysisui.state().matrix.districts.slice()),
    chips: () => ev((sel) => document.querySelectorAll(sel + ' .mt-analysis-dchip').length, SIDE),
    emptyState: () => ev(() => {
      const pane = document.querySelector('.mt-analysis-respane:not([hidden])');
      return { title: (pane.querySelector('.mt-empty__title') || {}).textContent, text: (pane.querySelector('.mt-empty__text') || {}).textContent,
        buttons: [...pane.querySelectorAll('.mt-analysis-zonebtns button')].map((b) => b.textContent), aria: [...pane.querySelectorAll('.mt-analysis-zonebtns button')].map((b) => b.getAttribute('aria-label')),
        areas: [...pane.querySelectorAll('.mt-analysis-zonegroup__area')].map((x) => x.textContent), groups: pane.querySelectorAll('.mt-analysis-zonegroup').length };
    }),
    presetsBtn: () => ev((sel) => { const b = document.querySelector(sel + ' .mt-analysis-presets'); return b ? { text: b.textContent.trim(), title: b.getAttribute('title') } : null; }, SIDE),
    openMenu: async () => { await page.click(SIDE + ' .mt-analysis-presets'); await page.waitForSelector('.mt-menu.is-open'); await sleep(150); },
    menu: () => ev(() => {
      const m = document.querySelector('.mt-menu');
      if (!m) return null;
      const r = m.getBoundingClientRect(), nameOf = (b) => (b.querySelector('.mt-analysis-zoneopt') || b.querySelector('.mt-menu__label')).firstChild.textContent;
      const tmp = document.createElement('span');                         // the browser's own serialisation of the check icon
      tmp.innerHTML = MT.ui.icon('check', { size: 16 });
      const checkIcon = tmp.innerHTML;
      return { headings: [...m.querySelectorAll('.mt-menu__heading')].map((x) => x.textContent), items: [...m.querySelectorAll('.mt-menu__item')].map(nameOf),
        counts: [...m.querySelectorAll('.mt-analysis-zoneopt__n')].map((x) => x.textContent), checked: [...m.querySelectorAll('.mt-menu__item')].filter((b) => b.querySelector('.mt-menu__icon').innerHTML === checkIcon).map(nameOf),
        top: r.top, bottom: r.bottom, vh: innerHeight, order: [...m.children].map((c) => (c.classList.contains('mt-menu__heading') ? 'H' : 'I')).join('') };
    }),
    pickMenu: (name) => ev((name) => {
      const b = [...document.querySelectorAll('.mt-menu .mt-menu__item')].find((x) => (x.querySelector('.mt-analysis-zoneopt') || x.querySelector('.mt-menu__label')).firstChild.textContent === name);
      b.click();
    }, name),
    closeMenu: async () => { if (await ev(() => !!document.querySelector('.mt-menu'))) { await page.keyboard.press('Escape'); await sleep(150); } },
    toast: () => ev(() => [...document.querySelectorAll('.mt-toast__msg')].map((x) => x.textContent).pop() || ''),
    options: () => ev(() => [...document.querySelectorAll('.mt-analysis-side .mt-analysis-options [role=option]')].map((li) => ({ zone: li.dataset.zone || null, ubigeo: li.dataset.ubigeo || null, name: li.querySelector('.mt-analysis-opt__name').textContent, sub: (li.querySelector('.mt-analysis-opt__sub') || {}).textContent }))),
    type: async (text) => {
      await page.click(SIDE + ' input[role=combobox]');
      await page.keyboard.type(text);
      await sleep(250);
    },
    clearSearch: async () => { await ev(() => { const i = document.querySelector('.mt-analysis-side .mt-analysis-districts input[role=combobox]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }); },
    removeAll: () => ev((sel) => { const b = [...document.querySelectorAll(sel + ' .mt-link, ' + sel + ' button')].find((x) => /^(Quitar todos|Remove all)$/.test(x.textContent.trim())); if (b) b.click(); return !!b; }, SIDE),
  };
}

/* =========================================================================================================== */
const { browser, page, errors } = await openApp({ lang: 'es', hash: 'analisis' });
const H = helpers(page);
const { ev } = H;
const mapIdle = () => waitForMapIdle(page, { expr: 'window.MT && MT.analysisui && MT.analysisui.state().mapReady && MT.analysisui.map()' }).catch((e) => console.log('   (map idle wait:', e.message, ')'));
let fallbackBrowser = null;

try {
  await page.waitForFunction(() => MT.analysisui && MT.analysisui.state().mapReady, { timeout: 45000 });
  await mapIdle();
  const Z = await ev(() => ({ available: MT.data.zones.available, all: MT.data.zones.all().map((z) => ({ id: z.id, name: z.name, area: z.area, ubigeos: z.ubigeos.slice() })), areas: MT.data.zones.byArea().map((g) => g.area) }));
  const zone = (id) => Z.all.find((z) => z.id === id);
  const CONO_SUR = zone('lima-cono-sur'), MET_SUR = zone('metropolitana-sur'), CENTRO = zone('lima-centro'), ORIENTE = zone('lima-oriente');
  check(Z.available && Z.all.length === 15 && Z.areas.join('|') === 'Lima + Callao|Provincias' && CONO_SUR.ubigeos.length === 12 && MET_SUR.ubigeos.length === 4, `data: ${Z.all.length} Zonas Nielsen in ${Z.areas.length} areas (${CONO_SUR.name}: ${CONO_SUR.ubigeos.length} districts)`);
  const names = Z.all.map((z) => z.name);

  /* ---- 1. mode B without a region ------------------------------------------------------------------------- */
  console.log('\n1. Matriz de cercanía sin región: las zonas como botones');
  await page.click('.mt-analysis-modes .mt-seg__opt:nth-child(2)');
  await sleep(500);
  const e1 = await H.emptyState();
  check(e1.title === 'Elige la región' && /zona Nielsen/.test(e1.text) && !/zona de Lima/.test(e1.text), `empty state "${e1.title}": "${e1.text}"`);
  check(e1.buttons.join() === names.join() && e1.groups === 2 && e1.areas.join('|') === 'Lima + Callao|Provincias', `${e1.buttons.length} zone buttons in ${e1.groups} area groups (${e1.areas.join(' / ')}), in the order of the zone list`);
  check(e1.aria[2] === 'Lima Cono Sur · 12 distritos' && e1.aria[8] === 'Cajamarca · 1 distrito', `a button says its size: "${e1.aria[2]}", "${e1.aria[8]}"`);
  const side1 = await ev(() => ({ ph: document.querySelector('.mt-analysis-side .mt-analysis-districts input').placeholder, label: document.querySelector('.mt-analysis-side .mt-analysis-districts input').getAttribute('aria-label'),
    hint: document.querySelector('.mt-analysis-side .mt-hint').textContent }));
  check(side1.ph === 'Buscar zona o distrito…' && side1.label === 'Buscar zona, distrito o provincia' && /Zonas Nielsen/.test(side1.hint), `search box and hint speak of zones ("${side1.ph}" · "${side1.hint}")`);
  const pb = await H.presetsBtn();
  check(pb && pb.text === 'Zonas Nielsen' && pb.title === 'Agregar una zona Nielsen', `the presets button reads "${pb && pb.text}" (no more "Zonas de Lima")`);
  await screenshot(page, 'an-zones-01-empty');

  // a button fills exactly the zone's districts, and the matrix is named after it
  await ev((name) => [...document.querySelectorAll('.mt-analysis-zonebtns button')].find((b) => b.textContent === name).click(), 'Metropolitana Oriente');
  await H.idle();
  check(sorted(await H.region()) === sorted(zone('metropolitana-oriente').ubigeos) && (await H.head()) === 'Matriz de cercanía · Metropolitana Oriente' && (await H.chips()) === 3, `button "Metropolitana Oriente" → its 3 districts, title "${await H.head()}"`);
  await ev(() => MT.analysisui.setMatrix({ districts: [] }));
  await sleep(300);

  /* ---- 2. the menu of the picker -------------------------------------------------------------------------- */
  console.log('\n2. El menú "Zonas Nielsen" del selector');
  await page.setViewport({ width: 1280, height: 720 });
  await sleep(300);
  await H.openMenu();
  const m1 = await H.menu();
  check(m1.headings.join('|') === 'Lima + Callao|Provincias' && m1.items.join() === names.join() && m1.order === 'H' + 'I'.repeat(7) + 'H' + 'I'.repeat(8), `menu: ${m1.items.length} zones under "${m1.headings.join('" and "')}", in the order of the zone list`);
  check(m1.counts[2] === '12 distritos' && m1.counts[8] === '1 distrito', `each zone shows its districts (${m1.counts.slice(0, 3).join(', ')}…)`);
  check(m1.top >= 0 && m1.bottom <= m1.vh && m1.checked.length === 0, `the menu fits a 1280 × 720 screen whole (${Math.round(m1.top)}–${Math.round(m1.bottom)} of ${m1.vh} px), nothing checked yet`);
  await screenshot(page, 'an-zones-02-menu');
  await H.pickMenu('Metropolitana Sur');
  await H.idle();
  check(sorted(await H.region()) === sorted(MET_SUR.ubigeos) && (await H.chips()) === 4 && (await H.head()) === 'Matriz de cercanía · Metropolitana Sur', `pick "Metropolitana Sur" → exactly its ${MET_SUR.ubigeos.length} districts (chips ${await H.chips()}), title "${await H.head()}"`);
  await H.openMenu();
  const m2 = await H.menu();
  check(m2.checked.join() === 'Metropolitana Sur', `a zone already whole is checked in the menu (${m2.checked.join(', ')})`);
  await H.pickMenu('Metropolitana Sur');
  await sleep(300);
  check((await H.region()).length === 4 && /ya están en la lista/.test(await H.toast()), `picking it again adds nothing: "${await H.toast()}"`);
  await H.openMenu();
  await H.pickMenu('Lima Centro');
  await H.idle();
  check(sorted(await H.region()) === sorted(MET_SUR.ubigeos.concat(CENTRO.ubigeos)) && (await H.chips()) === 7, `a second zone adds only its own districts (${(await H.region()).length} in all)`);
  check((await H.head()) === 'Matriz de cercanía · Lima Centro + Metropolitana Sur', `two whole zones are both named: "${await H.head()}"`);
  await screenshot(page, 'an-zones-03-two-zones');
  // one district less: no zone is whole any more for Lima Centro → the count
  await ev(() => document.querySelector('.mt-analysis-side .mt-analysis-dchip[data-ubigeo="150101"] .mt-chip__x').click());
  await H.idle();
  check((await H.region()).length === 6 && (await H.head()) === 'Matriz de cercanía · 6 distritos', `one district of Lima Centro less: no longer two whole zones → "${await H.head()}"`);

  /* ---- 3. typing a zone name ------------------------------------------------------------------------------- */
  console.log('\n3. Buscar una zona por su nombre');
  await H.removeAll();
  await H.idle();
  check((await H.region()).length === 0 && (await H.chips()) === 0, '"Quitar todos" empties the region');
  await H.type('cono sur');
  const o1 = await H.options();
  check(o1.length === 1 && o1[0].zone === 'lima-cono-sur' && o1[0].name === 'Lima Cono Sur' && o1[0].sub === 'Lima + Callao · 12 distritos', `"cono sur" offers the zone: ${JSON.stringify(o1[0])}`);
  await page.keyboard.press('Enter');
  await H.idle();
  check(sorted(await H.region()) === sorted(CONO_SUR.ubigeos) && (await H.head()) === 'Matriz de cercanía · Lima Cono Sur', `Enter on the zone → its 12 districts, title "${await H.head()}"`);
  await H.type('cono sur');
  const o2 = await H.options();
  check(o2.length === 1 && o2[0].zone === 'lima-cono-sur' && await ev(() => document.querySelector('.mt-analysis-side .mt-analysis-options [role=option]').getAttribute('aria-disabled')) === 'true', 'a zone already whole is listed as added (not pickable)');
  await H.clearSearch();
  await H.type('trujillo');
  const o3 = await H.options();
  const iz = o3.findIndex((o) => o.zone === 'trujillo');
  check(o3.length > 1 && o3[0].ubigeo && iz > 0 && o3.slice(0, iz).every((o) => o.ubigeo), `"trujillo": the districts first, the zone "Trujillo" after them (${o3.map((o) => (o.zone ? 'zona ' : '') + o.name).join(', ')})`);
  await page.keyboard.press('Escape');
  await H.clearSearch();
  await sleep(150);

  /* ---- 4. the label of a district set ---------------------------------------------------------------------- */
  console.log('\n4. Un conjunto de distritos igual a una zona se llama como ella');
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos.slice().reverse());
  await H.idle();
  check((await H.head()) === 'Matriz de cercanía · Lima Cono Sur', `the same 12 districts added one by one, in another order: "${await H.head()}"`);
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos.concat(ORIENTE.ubigeos, CENTRO.ubigeos));
  await H.idle();
  check((await H.head()) === 'Matriz de cercanía · Lima Centro + Lima Cono Sur + Lima Oriente', `three whole zones: "${await H.head()}"`);
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos.concat(ORIENTE.ubigeos, CENTRO.ubigeos, MET_SUR.ubigeos));
  await H.idle();
  check((await H.head()) === 'Matriz de cercanía · 27 distritos', `four zones: not a list of names ("${await H.head()}")`);
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos.slice(1));
  await H.idle();
  check((await H.head()) === 'Matriz de cercanía · 11 distritos', `a zone missing one district: "${await H.head()}"`);
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos.concat('150122'));
  await H.idle();
  check((await H.head()) === 'Matriz de cercanía · 13 distritos', `a zone plus one more district: "${await H.head()}"`);
  const prov = await ev(() => { const p = MT.data.districts.byProvince().find((x) => x.province === 'Canta' && x.department === 'Lima'); return p ? p.ubigeos : null; });
  if (prov) { await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), prov); await H.idle(); check((await H.head()) === 'Matriz de cercanía · Provincia de Canta', `a whole province keeps its own label: "${await H.head()}"`); }

  /* ---- 5. Excel: file name and "Parámetros" -------------------------------------------------------------- */
  console.log('\n5. Excel');
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds, includeToVerify: true }), CONO_SUR.ubigeos);
  await H.idle();
  await page.setViewport({ width: 1440, height: 900 });
  const dir = await captureDownloads(page, path.join(OUT, 'an-zones-downloads'));
  await page.click('.mt-analysis-act-excel');
  const fileB = await waitForDownload(dir, /^Matriz de cercanía - Lima Cono Sur - \d{4}-\d\d-\d\d\.xlsx$/);
  const bookB = readBook(fileB);
  const PB = Object.fromEntries(bookB.sheets['Parámetros'].slice(1).map((r) => [r[0], r[1]]));
  check(path.basename(fileB).startsWith('Matriz de cercanía - Lima Cono Sur - ') && PB['Región'].startsWith('Lima Cono Sur (') && /Chorrillos/.test(PB['Región']) && PB['Región'].split(',').length === 12,
    `file "${path.basename(fileB)}"; sheet "Parámetros": Región = "${String(PB['Región']).slice(0, 70)}…"`);
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos.slice(0, 5));
  await H.idle();
  await page.click('.mt-analysis-act-excel');
  const fileB2 = await waitForDownload(dir, /^Matriz de cercanía - 5 distritos - \d{4}-\d\d-\d\d\.xlsx$/);
  const PB2 = Object.fromEntries(readBook(fileB2).sheets['Parámetros'].slice(1).map((r) => [r[0], r[1]]));
  check(!/Cono Sur/.test(PB2['Región']), `5 of its districts: "${path.basename(fileB2)}", Región = "${PB2['Región']}" (no zone name)`);

  /* ---- 6. mode A -------------------------------------------------------------------------------------------- */
  console.log('\n6. Distancias a un punto: el universo "Zonas Nielsen"');
  await ev(() => MT.analysisui.setMode('distance'));
  await sleep(400);
  await ev(() => { MT.analysisui.setReference({ lat: -12.1219, lng: -77.0302, label: 'Parque Kennedy' }); MT.analysisui.setUniverse({ districts: [] }); });
  await sleep(500);
  const seg = await ev(() => [...document.querySelectorAll('.mt-analysis-by .mt-seg__opt')].map((x) => x.textContent.trim()));
  check(seg.join('|') === 'Distancia|Zonas Nielsen', `"Delimitar por": ${seg.join(' | ')} (no more "Distritos")`);
  const eA = await H.emptyState();
  check(eA.title === 'Elige una zona o distritos' && /zona Nielsen/.test(eA.text), `no zone yet: "${eA.title}" — "${eA.text}"`);
  await H.openMenu();
  const mA = await H.menu();
  check(mA.headings.join('|') === 'Lima + Callao|Provincias' && mA.items.join() === names.join(), 'the same menu (15 zones in two areas) in mode A');
  await H.pickMenu('Lima Cono Sur');
  await ev(() => MT.analysisui.whenIdle && MT.analysisui.whenIdle());
  await sleep(600);
  const sA = await ev(() => ({ u: MT.analysisui.state().universe, chips: document.querySelectorAll('.mt-analysis-side .mt-analysis-dchip').length, meta: (document.querySelector('.mt-analysis-mainhead__meta') || {}).textContent, rows: MT.analysisui.results().res.rows.length }));
  check(sA.u.kind === 'districts' && sorted(sA.u.districts) === sorted(CONO_SUR.ubigeos) && sA.chips === 12 && sA.rows > 20, `pick "Lima Cono Sur" → universe = its 12 districts, ${sA.rows} stores ("${sA.meta}")`);
  const dlA = await captureDownloads(page, path.join(OUT, 'an-zones-downloads-a'));
  await page.click('.mt-analysis-act-excel');
  const fileA = await waitForDownload(dlA, /^Distancias a Parque Kennedy - \d{4}-\d\d-\d\d\.xlsx$/);
  const cellsA = Object.values(readBook(fileA).sheets.Resumen || {}).flat();
  check(cellsA.some((c) => typeof c === 'string' && /^Tiendas en Lima Cono Sur \(.*Chorrillos/.test(c)), 'Excel (mode A), sheet "Resumen": the universe reads "Tiendas en Lima Cono Sur (…districts…)"');
  await ev(() => MT.analysisui.setMode('matrix'));
  await sleep(400);
  await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), CONO_SUR.ubigeos);
  await H.idle();

  /* ---- 7. English ------------------------------------------------------------------------------------------- */
  console.log('\n7. English');
  await ev(() => MT.i18n.setLang('en'));
  await sleep(600);
  check((await H.head()) === 'Proximity matrix · Lima Cono Sur', `title: "${await H.head()}" (the zone name is data, not translated)`);
  const pbEn = await H.presetsBtn();
  check(pbEn.text === 'Zonas Nielsen' && pbEn.title === 'Add a Nielsen zone', `the presets button reads "${pbEn.text}" in English too`);
  await H.openMenu();
  const mEn = await H.menu();
  check(mEn.headings.join('|') === 'Lima + Callao|Provinces' && mEn.items.join() === names.join() && mEn.counts[2] === '12 districts' && mEn.counts[8] === '1 district' && mEn.checked.join() === 'Lima Cono Sur',
    `menu: ${mEn.items.length} zones under "${mEn.headings.join('" and "')}", "${mEn.counts[2]}", Lima Cono Sur checked`);
  await H.closeMenu();
  await ev(() => MT.analysisui.setMatrix({ districts: [] }));
  await sleep(400);
  const eEn = await H.emptyState();
  check(eEn.title === 'Choose the region' && /Nielsen zone/.test(eEn.text) && eEn.buttons.join() === names.join() && eEn.areas.join('|') === 'Lima + Callao|Provinces' && eEn.aria[2] === 'Lima Cono Sur · 12 districts',
    `empty state: "${eEn.title}" — "${eEn.text}" · ${eEn.buttons.length} buttons under ${eEn.areas.join(' / ')}`);
  const sideEn = await ev(() => ({ ph: document.querySelector('.mt-analysis-side .mt-analysis-districts input').placeholder, hint: document.querySelector('.mt-analysis-side .mt-hint').textContent }));
  check(sideEn.ph === 'Search zone or district…' && /Nielsen zones/.test(sideEn.hint), `search box and hint: "${sideEn.ph}" · "${sideEn.hint}"`);
  await ev((name) => [...document.querySelectorAll('.mt-analysis-zonebtns button')].find((b) => b.textContent === name).click(), 'Lima Cono Sur');
  await H.idle();
  const dlEn = await captureDownloads(page, path.join(OUT, 'an-zones-downloads-en'));
  await page.click('.mt-analysis-act-excel');
  const fileEn = await waitForDownload(dlEn, /^Proximity matrix - Lima Cono Sur - \d{4}-\d\d-\d\d\.xlsx$/);
  const PBen = Object.fromEntries(readBook(fileEn).sheets.Parameters.slice(1).map((r) => [r[0], r[1]]));
  check(sorted(await H.region()) === sorted(CONO_SUR.ubigeos) && /^Lima Cono Sur \(/.test(PBen.Region), `English: "${path.basename(fileEn)}", sheet "Parameters": Region = "${String(PBen.Region).slice(0, 50)}…"`);
  const miss = await ev(() => MT.i18n.missingKeys());
  check(miss.length === 0, `no missing i18n keys (${miss.join(', ')})`);
  await ev(() => MT.i18n.setLang('es'));
  await sleep(500);

  /* ---- 8. stored as districts, restored after a reload -------------------------------------------------------- */
  console.log('\n8. La región se guarda como distritos');
  const stored = await ev(() => { const raw = MT.storage.pref('analysis.settings', {}); return { b: raw.bDistricts, mode: raw.mode }; });
  check(Array.isArray(stored.b) && sorted(stored.b) === sorted(CONO_SUR.ubigeos) && stored.b.every((u) => /^\d{6}$/.test(u)), `the saved setting is the list of ${stored.b && stored.b.length} ubigeos (no zone id)`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true && MT.analysisui && MT.analysisui.state().mapReady, { timeout: 60000 });
  await H.idle();
  await sleep(500);
  const back = await ev(() => ({ mode: MT.analysisui.state().mode, ds: MT.analysisui.state().matrix.districts.slice(), head: document.querySelector('.mt-analysis-mainhead__h').textContent }));
  check(back.mode === 'matrix' && sorted(back.ds) === sorted(CONO_SUR.ubigeos) && back.head === 'Matriz de cercanía · Lima Cono Sur', `after a reload the region is back, named "${back.head}"`);
  // an old saved setting (a district list that was a Lima preset) still loads
  await ev(() => { MT.storage.setPref('analysis.settings', Object.assign(MT.storage.pref('analysis.settings', {}), { bDistricts: ['150108', '150119', '150123', '150133', '150142', '150143'], mode: 'matrix' })); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true && MT.analysisui && MT.analysisui.state().mapReady, { timeout: 60000 });
  await H.idle();
  await sleep(500);
  const old = await ev(() => ({ ds: MT.analysisui.state().matrix.districts.slice(), head: document.querySelector('.mt-analysis-mainhead__h').textContent, rows: MT.analysisui.results().rows.length, boxes: document.querySelectorAll('#panel-analysis .mt-errbox').length }));
  check(old.ds.length === 6 && old.rows > 20 && old.boxes === 0 && old.head === 'Matriz de cercanía · 6 distritos', `an old saved list of 6 districts loads as it was: "${old.head}", ${old.rows} stores`);

  /* ---- 9. no data/zones.js ----------------------------------------------------------------------------------- */
  console.log('\n9. Sin data/zones.js: sin atajos de zona; los distritos siguen funcionando');
  const fb = await openApp({
    lang: 'es', hash: 'analisis',
    onNewDocument: () => { try { Object.defineProperty(window, 'MT_ZONES', { configurable: true, get: () => undefined, set: () => {} }); } catch (e) { /* ignore */ } },
  });
  fallbackBrowser = fb.browser;
  const F = helpers(fb.page);
  await fb.page.waitForFunction(() => MT.analysisui && MT.analysisui.state().mapReady, { timeout: 45000 });
  check(await F.ev(() => MT.data.zones.available === false && MT.data.zones.all().length === 0), 'MT.data.zones.available is false (zones.js not loaded)');
  await fb.page.click('.mt-analysis-modes .mt-seg__opt:nth-child(2)');
  await sleep(500);
  const eF = await F.emptyState();
  check(eF.title === 'Elige la región' && eF.buttons.length === 0 && eF.groups === 0, `empty state: no zone buttons (${eF.buttons.length}) and no old Lima presets`);
  check((await F.presetsBtn()) === null, 'no zones menu button next to the district search');
  await F.type('cono sur');
  check((await F.options()).length === 0, 'typing a zone name offers no zone');
  await fb.page.keyboard.press('Escape');
  await F.clearSearch();
  await F.type('miraflores');
  await fb.page.keyboard.press('Enter');
  await F.idle();
  check(sorted(await F.region()) === sorted(['150122']), 'a district is still picked from the search');
  check((await F.head()).length > 0, `and the matrix is titled (${await F.head()})`);
  const { real: realF } = splitNetworkNoise(fb.errors);
  check(realF.length === 0, `no console errors without zones.js${realF.length ? ': ' + realF.slice(0, 3).join(' | ') : ''}`);

  const { real, noise } = splitNetworkNoise(errors);
  if (noise.length) console.log(`   (${noise.length} transient tile errors ignored)`);
  check(real.length === 0, `no console errors${real.length ? ': ' + real.slice(0, 4).join(' | ') : ''}`);
} catch (err) {
  console.log(err);
  check(false, 'test run threw: ' + (err && err.message));
} finally {
  await browser.close();
  if (fallbackBrowser) await fallbackBrowser.close();
}
finish();
