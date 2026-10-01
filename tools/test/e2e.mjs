// tools/test/e2e.mjs — end-to-end user journey, from file://, in Spanish and in English.
//
// Drives the app the way a colleague would (clicks, typing, keyboard, file pickers), with the real
// data when it exists (fixtures only for missing data files):
//   1. Mapas: rename the project; build "Lima Metropolitana Sur" (Miraflores, San Borja, San Isidro,
//      Surquillo, Peso 15.8%), "Trujillo" (card logos) and "Chimbote" (+ Nuevo Chimbote, dots);
//      toggle chains; drag a marker; add a 1 km radius from the store popup.
//   2. Exports through the "Exportar" button: PNG map, PNG slide, PowerPoint (all slides), HTML —
//      each file must be produced and non-trivial (PNG size/dimensions, PPTX slide count, HTML text).
//   3. Base de datos: add a store by pasting a Google Maps URL, edit it, delete it; import a CSV
//      (title row above a ';' header, decimal commas).
//   4. Save the project (Ctrl+S → download), start a new one, open the saved file (Ctrl+O) → identical.
//   5. Reload the page → project, current slide, language and local database changes persist.
// Zero console errors throughout. Screenshots: tools/test/out/e2e-<lang>-*.png.
//
//   node tools/test/e2e.mjs [--lang=es|en] [--headful]

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openApp, screenshot, waitForMapIdle, captureDownloads, makeChecker, sleep, splitNetworkNoise, OUT } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const LANGS = args.lang ? [args.lang] : ['es', 'en'];
const { check, finish } = makeChecker('e2e');

// The File System Access pickers cannot be driven headlessly: hide them so the app uses its
// download / <input type=file> fallbacks (the path Firefox users get).
function hideFsAccess() {
  for (const k of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); } catch (e) { /* ignore */ }
  }
}

/* ---- small file inspectors ------------------------------------------------------------------- */
function pngInfo(file) {
  const b = readFileSync(file);
  const sig = b.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  return { ok: sig, width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}
function zipEntries(file) {
  // Central-directory file names (stored uncompressed) — enough to list a .pptx's parts.
  const b = readFileSync(file);
  const names = [];
  for (let i = b.length - 22; i >= 0 && i > b.length - 70000; i--) {
    if (b.readUInt32LE(i) !== 0x06054b50) continue;
    let p = b.readUInt32LE(i + 16);
    const n = b.readUInt16LE(i + 10);
    for (let k = 0; k < n && p < b.length; k++) {
      const len = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32);
      names.push(b.slice(p + 46, p + 46 + len).toString('utf8'));
      p += 46 + len + extra + comment;
    }
    break;
  }
  return names;
}

async function journey(lang) {
  const L = (es, en) => (lang === 'es' ? es : en);
  console.log(`\n================ ${lang.toUpperCase()} ================`);
  const t0 = Date.now();
  const { browser, page, errors, injected } = await openApp({ lang, onNewDocument: hideFsAccess, headless: !args.headful, viewport: { width: 1440, height: 900 } });
  const dl = path.join(OUT, `e2e-downloads-${lang}`);
  await captureDownloads(page, dl);
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const waitFor = (fn, arg, timeout = 15000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
  const selectAll = async () => { await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); };
  const shot = (name) => screenshot(page, `e2e-${lang}-${name}`);
  const idle = async () => { await sleep(250); await waitForMapIdle(page, { timeout: 60000 }).catch(() => null); await sleep(250); };
  const noOverlay = () => waitFor(() => !document.querySelector('.mt-busy-backdrop') && !document.querySelector('.mt-modal-backdrop'), null, 240000);
  const files = () => readdirSync(dl).filter((f) => !f.endsWith('.crdownload'));
  const newDownload = async (pattern, before, timeout = 240000) => {
    const t1 = Date.now();
    while (Date.now() - t1 < timeout) {
      const hit = files().find((f) => pattern.test(f) && !before.includes(f));
      if (hit) { await sleep(300); return path.join(dl, hit); }
      await sleep(200);
    }
    throw new Error(`no new download matching ${pattern}`);
  };
  const dblRow = async (id) => {
    for (let i = 0; i < 10; i++) {
      const r = await ev((id) => { const tr = document.querySelector(`tr[data-id="${id}"]`); if (!tr) return null; tr.scrollIntoView({ block: 'center' }); const b = tr.getBoundingClientRect(); return { x: b.left + Math.min(240, b.width / 2), y: b.top + b.height / 2 }; }, id);
      if (r) { await page.mouse.click(r.x, r.y, { count: 2 }); return; }
      await sleep(200);
    }
    throw new Error('row not found: ' + id);
  };
  console.log(`  data: ${injected.length ? 'fixtures for ' + injected.join(', ') : 'real data files'}`);

  try {
    /* ---------------------------------------------------------------- 1. project + slide 1 */
    console.log('\n1. Mapas — Lima Metropolitana Sur');
    await waitFor(() => document.querySelector('.mt-maps') && document.querySelector('[data-field="title"]'));
    const boot = await ev(() => ({ tab: MT.app.currentTab(), maps: MT.project.maps().length, lang: MT.i18n.lang, html: document.documentElement.lang,
      tabLabel: document.querySelector('#tab-maps').textContent.trim() }));
    check(boot.tab === 'maps' && boot.maps === 1 && boot.lang === lang && boot.html === lang, `boots on Mapas with one blank slide (${JSON.stringify(boot)})`);
    check(boot.tabLabel === L('Mapas', 'Maps'), `tab label in the UI language (${boot.tabLabel})`);

    // Rename the project from the top bar.
    await page.click('.mt-project__name');
    await waitFor(() => document.querySelector('.mt-modal-backdrop.is-open input') && document.activeElement === document.querySelector('.mt-modal-backdrop.is-open input'));
    await selectAll();
    await page.keyboard.type(L('Estudio Supermercados Perú', 'Peru Supermarkets Study'));
    await page.keyboard.press('Enter');
    await noOverlay();
    const pname = await ev(() => MT.project.current().name);
    check(pname === L('Estudio Supermercados Perú', 'Peru Supermarkets Study'), `project renamed (${pname})`);

    const setText = async (field, text) => {
      await page.click(`[data-field="${field}"]`);
      await selectAll();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };
    const addDistrict = async (query, ubigeo) => {
      await page.click('[data-field="districtSearch"]');
      await page.keyboard.type(query);
      await waitFor((u) => document.querySelector(`.mt-maps-results li[data-ubigeo="${u}"]`), ubigeo);
      await page.click(`.mt-maps-results li[data-ubigeo="${ubigeo}"]`);
      await waitFor((u) => MT.project.currentMap().districts.includes(u), ubigeo);
    };
    await setText('title', 'Lima Metropolitana Sur');
    for (const [q, u] of [['Miraflores', '150122'], ['San Borja', '150130'], ['san isidro', '150131'], ['Surquillo', '150141']]) await addDistrict(q, u);
    await setText('peso', '15.8%');
    await idle();
    let m1 = await ev(() => { const m = MT.project.currentMap(); return { id: m.id, title: m.title, peso: m.peso, districts: m.districts, sub: MT.data.subtitleFor(m),
      chips: document.querySelectorAll('.mt-maps-chip').length, slideTitle: (document.querySelector('.mt-slide__title') || {}).textContent }; });
    check(m1.title === 'Lima Metropolitana Sur' && m1.peso === '15.8%', `title and Peso typed (${m1.title}, ${m1.peso})`);
    check(m1.districts.join() === '150122,150130,150131,150141' && m1.chips === 4, `4 districts picked from the search (${m1.districts})`);
    check(m1.sub === '(Miraflores, San Borja, San Isidro, Surquillo)', `automatic subtitle (${m1.sub})`);
    const slideText = await ev(() => (document.querySelector('.mt-slide') || document.body).innerText);
    check(/Lima Metropolitana Sur/.test(slideText) && /15\.8%/.test(slideText) && /Peso:/.test(slideText) && /Tiendas/.test(slideText), 'slide preview shows title, subtitle with Peso and the "Tiendas" panel');

    // Chains: Mass off (as in the reference slide), Tambo stays off (default), Holi off then on again.
    const chainState = () => ev(() => { const m = MT.project.currentMap(); return { mass: MT.data.chainOn(m, 'mass'), tambo: MT.data.chainOn(m, 'tambo'), holi: MT.data.chainOn(m, 'holi'),
      legend: MT.legend.items(m).map((r) => r.chainId) }; });
    // Defaults come from data/chains.js (defaultOn): Tambo/Oxxo off; Mass may be either.
    const massDefault = await ev(() => MT.data.chain('mass').defaultOn !== false);
    let cs = await chainState();
    check(cs.mass === massDefault && !cs.tambo && cs.legend.includes('mass') === massDefault,
      `defaults from data/chains.js: Mass ${massDefault ? 'on' : 'off'}, Tambo off (${cs.legend.length} chains in the legend)`);
    await ev(() => MT.mapsui.section('chains', true));
    for (const id of (massDefault ? ['mass'] : []).concat(['holi', 'holi'])) {
      await page.$eval(`.mt-maps-chain[data-chain="${id}"]`, (el) => el.scrollIntoView({ block: 'center' }));
      await page.click(`.mt-maps-chain[data-chain="${id}"]`);
      await sleep(150);
    }
    await idle();
    cs = await chainState();
    check(!cs.mass && cs.holi && !cs.legend.includes('mass') && cs.legend.includes('holi'), `chain switches: Mass off, Holi back on; legend follows (${cs.legend.join(', ')})`);
    const legendDom = await ev(() => [...document.querySelectorAll('.mt-slide__legend-row')].map((r) => r.textContent.trim()).filter(Boolean));
    check(legendDom.length > 0 && !legendDom.some((x) => /^MASS/.test(x)) && legendDom.some((x) => /\(\d+\)/.test(x)), `legend panel lists chains with counts (${legendDom.slice(0, 4).join(' · ')}…)`);
    await shot('01-lima-sur');

    // Drag a marker (choose one away from the frame edges).
    const pickMarker = () => ev(() => {
      const fr = document.querySelector('.mt-marker-hit').parentElement.getBoundingClientRect();
      const hits = [...document.querySelectorAll('.mt-marker-hit')].map((b) => ({ id: b.dataset.storeId, r: b.getBoundingClientRect() }))
        .filter((x) => x.r.left > fr.left + fr.width * 0.3 && x.r.right < fr.right - fr.width * 0.3 && x.r.top > fr.top + fr.height * 0.3 && x.r.bottom < fr.bottom - fr.height * 0.3);
      const x = hits[0];
      return x ? { id: x.id, x: x.r.left + x.r.width / 2, y: x.r.top + x.r.height / 2 } : null;
    });
    const mk = await pickMarker();
    check(!!mk, `found a marker to drag (${mk && mk.id})`);
    await page.mouse.move(mk.x, mk.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(mk.x + i * 7, mk.y - i * 5);
    await page.mouse.up();
    await sleep(400);
    const drag = await ev((id) => ({ off: MT.project.currentMap().markerOffsets[id] || null, manual: (MT.mapview.items().find((i) => i.storeId === id) || {}).manual }), mk.id);
    check(drag.off && drag.manual, `drag stores a manual marker offset (${JSON.stringify(drag.off)})`);

    // Click a marker → store popup → "Agregar radio 1 km".
    const mk2 = await pickMarker();
    await page.mouse.click(mk2.x, mk2.y);
    await waitFor(() => document.querySelector('.mt-maps-pop.is-open'));
    const popText = await ev(() => document.querySelector('.mt-maps-pop').innerText);
    await shot('02-popup');
    await page.click('.mt-maps-pop [data-m="1000"]');
    await waitFor(() => (MT.project.currentMap().radius || []).length === 1);
    await page.keyboard.press('Escape');
    await idle();
    const rad = await ev(() => { const m = MT.project.currentMap(); const r = MT.radius.compute(m)[0]; return { cfg: m.radius[0], inside: r ? r.inside.length : -1, same: r && r.sameChain, comp: r && r.competitors,
      cards: document.querySelectorAll('.mt-maps-radius').length }; });
    check(/km|m/.test(popText) && rad.cfg && rad.cfg.meters === 1000, `1 km radius added from the popup (${JSON.stringify(rad.cfg)})`);
    check(rad.inside >= 0 && rad.cards === 1, `radius computed: ${rad.same} same chain · ${rad.comp} competitors inside; card in the inspector`);
    await shot('03-radius');

    /* ---------------------------------------------------------------- 2. slides 2 and 3 */
    console.log('\n2. Mapas — Trujillo and Chimbote');
    await page.click('.mt-maps-rail__add');
    await waitFor(() => MT.project.maps().length === 2 && MT.project.currentMap().districts.length === 0);
    await setText('title', 'Trujillo');
    await addDistrict('Trujillo', '130101');
    await addDistrict('Victor Larco', '130111');
    await setText('peso', '8.1%');
    await ev(() => MT.mapsui.section('markers', true));
    await page.$eval('.mt-maps-style__input[data-style="card"]', (el) => el.closest('label').scrollIntoView({ block: 'center' }));
    await page.$eval('.mt-maps-style__input[data-style="card"]', (el) => el.closest('label').click());
    await idle();
    const m2 = await ev(() => { const m = MT.project.currentMap(); return { title: m.title, d: m.districts, style: m.markerStyle, n: MT.mapview.items().length, sub: MT.data.subtitleFor(m) }; });
    check(m2.title === 'Trujillo' && m2.d.length === 2 && m2.style === 'card' && m2.n > 0, `Trujillo: 2 districts, card logos, ${m2.n} markers (${m2.sub})`);
    await shot('04-trujillo');

    await page.click('.mt-maps-rail__add');
    await waitFor(() => MT.project.maps().length === 3);
    await setText('title', 'Chimbote');
    await addDistrict('Chimbote', '021801');
    await addDistrict('Nuevo Chimbote', '021809');
    await setText('peso', '5.2%');
    await page.$eval('.mt-maps-style__input[data-style="dot"]', (el) => el.closest('label').click());
    await idle();
    const m3 = await ev(() => { const m = MT.project.currentMap(); return { d: m.districts, style: m.markerStyle, n: MT.mapview.items().length }; });
    check(m3.d.join() === '021801,021809' && m3.style === 'dot' && m3.n > 0, `Chimbote: Chimbote + Nuevo Chimbote, dots, ${m3.n} markers`);
    const rail = await ev(() => [...document.querySelectorAll('.mt-maps-slide__title')].map((x) => x.textContent));
    check(rail.join('|') === 'Lima Metropolitana Sur|Trujillo|Chimbote', `slide rail in order (${rail.join(' · ')})`);
    await shot('05-chimbote');

    // The legend always matches the map: same chains, same counts as the markers inside the frame.
    const legendCheck = await ev(() => MT.project.maps().map((m) => {
      const fr = MT.layout.frame();
      const items = MT.layout.compute(m).filter((i) => i.anchor.x >= 0 && i.anchor.x <= fr.width && i.anchor.y >= 0 && i.anchor.y <= fr.height);
      const byChain = {};
      items.forEach((i) => { byChain[i.chainId] = (byChain[i.chainId] || 0) + 1; });
      const legend = MT.legend.items(m);
      const same = legend.length === Object.keys(byChain).length && legend.every((r) => byChain[r.chainId] === r.count && r.text.endsWith('(' + r.count + ')'));
      return { title: m.title, same, n: items.length, rows: legend.length };
    }));
    check(legendCheck.every((x) => x.same), `legend = markers on the map for every slide (${legendCheck.map((x) => `${x.title}: ${x.rows} chains / ${x.n} stores`).join('; ')})`);

    /* ---------------------------------------------------------------- 3. exports */
    console.log('\n3. Exports');
    // Back to slide 1 (click it in the rail).
    await page.click('.mt-maps-slide:nth-child(1) .mt-maps-slide__main');
    await waitFor(() => MT.project.currentMap().title === 'Lima Metropolitana Sur');
    await idle();
    const exportVia = async (kind, { scope = 'current', res = null } = {}) => {
      await page.click('.mt-maps-bar__export');
      await waitFor(() => document.querySelector('.mt-maps-popover.is-open'));
      await page.$eval(`.mt-maps-popover input[value="${scope}"]`, (el) => { if (!el.disabled) el.closest('label').click(); });
      if (res) await page.$eval(`.mt-maps-popover input[value="${res}"]`, (el) => el.closest('label').click());
      const before = files();
      await page.click(`.mt-maps-xopt[data-export="${kind}"]`);
      return before;
    };
    const mapScale = lang === 'es' ? 3 : 2, slideW = lang === 'es' ? 3840 : 1920;
    let before = await exportVia('mapPng', { res: String(mapScale) });
    const pngMap = await newDownload(/\.png$/, before);
    await noOverlay();
    let info = pngInfo(pngMap);
    check(info.ok && info.width === 1000 * mapScale && Math.abs(info.height - Math.round(838.71 * mapScale)) <= 2 && info.bytes > 300000,
      `PNG map ${mapScale}×: ${path.basename(pngMap)} ${info.width}×${info.height}, ${Math.round(info.bytes / 1024)} KB`);

    before = await exportVia('slidePng', { res: String(slideW) });
    const pngSlide = await newDownload(/\.png$/, before);
    await noOverlay();
    info = pngInfo(pngSlide);
    check(info.ok && info.width === slideW && info.height === Math.round(slideW * 9 / 16) && info.bytes > 200000,
      `PNG slide: ${path.basename(pngSlide)} ${info.width}×${info.height}, ${Math.round(info.bytes / 1024)} KB`);

    before = await exportVia('pptx', { scope: 'all' });
    const pptx = await newDownload(/\.pptx$/, before);
    await noOverlay();
    const entries = zipEntries(pptx);
    const slides = entries.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
    const media = entries.filter((n) => /^ppt\/media\//.test(n)).length;
    check(slides === 3 && media > 10 && statSync(pptx).size > 400000, `PowerPoint (all slides): ${path.basename(pptx)} — ${slides} slides, ${media} pictures, ${Math.round(statSync(pptx).size / 1024)} KB`);

    before = await exportVia('html', { scope: 'all' });
    const html = await newDownload(/\.html$/, before);
    await noOverlay();
    const htmlText = readFileSync(html, 'utf8');
    check(htmlText.length > 50000 && /Lima Metropolitana Sur/.test(htmlText) && /Trujillo/.test(htmlText) && /Chimbote/.test(htmlText) && /OpenStreetMap/.test(htmlText),
      `interactive HTML: ${path.basename(html)} (${Math.round(htmlText.length / 1024)} KB, all 3 maps, attribution)`);
    await shot('06-after-exports');

    /* ---------------------------------------------------------------- 4. database */
    console.log('\n4. Base de datos');
    await page.click('#tab-db');
    await waitFor(() => document.querySelector('.mt-db-head') && document.querySelectorAll('.mt-db-head__actions .mt-btn').length >= 4);
    const nBefore = await ev(() => MT.data.stores({ includeClosed: true }).length);
    await page.click('.mt-db-head__actions .mt-btn--primary');
    await waitFor(() => document.querySelector('.mt-db-drawer.is-open #mt-db-f-chain'));
    await page.select('#mt-db-f-chain', 'plazavea');
    await page.click('#mt-db-f-name');
    await page.keyboard.type('Plaza Vea Prueba E2E');
    await page.click('#mt-db-f-address');
    await page.keyboard.type('Av. Diagonal 380');
    const gmaps = 'https://www.google.com/maps/place/Parque+Kennedy/@-12.1215,-77.0302,17z/data=!3m1!4b1!4m6!3m5!1s0x9105c8186a1c1b63:0x2f1d0!8m2!3d-12.121104!4d-77.029722!16s';
    await page.click('#mt-db-f-paste');
    await page.keyboard.type(gmaps);
    await page.keyboard.press('Enter');
    await waitFor(() => document.querySelector('#mt-db-f-lat').value === '-12.121104');
    const located = await ev(() => ({ lat: document.querySelector('#mt-db-f-lat').value, lng: document.querySelector('#mt-db-f-lng').value, district: document.querySelector('.mt-db-district').textContent }));
    check(located.lng === '-77.029722' && /Miraflores/.test(located.district), `Google Maps URL pasted → pin at ${located.lat}, ${located.lng} (${located.district.trim()})`);
    await sleep(1500); // let the drawer's mini-map fly to the pin
    await shot('07-db-add');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
    await waitFor(() => MT.data.stores().some((s) => s.name === 'Plaza Vea Prueba E2E'));
    const added = await ev(() => { const s = MT.data.stores().find((x) => x.name === 'Plaza Vea Prueba E2E'); return { s, state: MT.data.storeState(s.id), changes: MT.data.overlayStats().total }; });
    check(/^man-/.test(added.s.id) && added.s.ubigeo === '150122' && added.s.district === 'Miraflores' && added.s.source === 'manual' && added.state === 'added',
      `store created (${added.s.id}, ${added.s.district}, ${added.s.source}, local change #${added.changes})`);
    const onMap = await ev((id) => MT.data.storesForMap(MT.project.getMap(MT.project.maps()[0].id)).some((s) => s.id === id), added.s.id);
    check(onMap, 'the new store is part of the Lima Metropolitana Sur slide');

    // Edit it: search → double-click its row → rename → Ctrl+Enter.
    await waitFor(() => !document.querySelector('.mt-db-drawer.is-open'));
    await page.click('.mt-db-search__input');
    await page.keyboard.type('Prueba E2E');
    await waitFor((id) => document.querySelector(`tr[data-id="${id}"]`), added.s.id);
    await sleep(300);
    await dblRow(added.s.id);
    await waitFor(() => document.querySelector('.mt-db-drawer.is-open #mt-db-f-name'));
    await page.click('#mt-db-f-name');
    await selectAll();
    await page.keyboard.type('Plaza Vea Prueba E2E (editada)');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
    await waitFor((id) => MT.data.store(id) && MT.data.store(id).name === 'Plaza Vea Prueba E2E (editada)', added.s.id);
    check(true, 'store renamed through the edit drawer');

    // Delete it permanently.
    await waitFor(() => !document.querySelector('.mt-db-drawer.is-open'));
    await waitFor((id) => document.querySelector(`tr[data-id="${id}"]`), added.s.id);
    await sleep(300);
    await dblRow(added.s.id);
    await waitFor(() => document.querySelector('.mt-db-drawer.is-open .mt-db-delbtn'));
    await page.click('.mt-db-drawer .mt-db-delbtn');
    await waitFor(() => document.querySelector('.mt-modal-backdrop.is-open input[value="delete"]'));
    await page.$eval('.mt-modal-backdrop.is-open input[value="delete"]', (el) => el.closest('label').click());
    await page.click('.mt-modal-backdrop.is-open .mt-modal__footer .mt-btn:last-child');
    await waitFor((id) => !MT.data.store(id), added.s.id);
    await noOverlay();
    check(await ev(([id, n]) => MT.data.storeState(id) === null && MT.data.stores({ includeClosed: true }).length === n, [added.s.id, nBefore]), 'store deleted (a local addition disappears completely)');
    await page.click('.mt-db-search__input');
    await page.keyboard.press('Escape');

    // Import a CSV: title row, ';' separator, Spanish headers, decimal commas, one row without chain.
    const csvPath = path.join(OUT, `e2e-import-${lang}.csv`);
    writeFileSync(csvPath, '﻿Tiendas nuevas para el estudio\r\n' +
      'cadena;nombre;dirección;latitud;longitud;estado\r\n' +
      'Tottus;Tottus E2E Primavera;Av. Primavera 100;-12,1100;-76,9950;Por verificar\r\n' +
      'WONG;Wong E2E Benavides;Av. Benavides 1500;-12,1281;-77,0185;verificada\r\n' +
      ';Sin cadena E2E;Av. X 1;-12,10;-77,00;\r\n', 'utf8');
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), page.click('.mt-db-head__actions [data-i18n="common.import"]')]);
    await chooser.accept([csvPath]);
    await waitFor(() => document.querySelector('.mt-imp-modal'));
    await sleep(300);
    await shot('08-import');
    const impInfo = await ev(() => document.querySelector('.mt-imp-file') ? document.querySelector('.mt-imp-file').textContent : '');
    await page.click('.mt-imp-modal .mt-modal__footer .mt-btn--primary');
    await waitFor(() => MT.data.stores().filter((s) => / E2E /.test(s.name)).length === 2, null, 30000);
    await sleep(400);
    const imported = await ev(() => MT.data.stores().filter((s) => / E2E /.test(s.name)).map((s) => ({ name: s.name, chain: s.chain, lat: s.lat, status: s.status, district: s.district, id: s.id })));
    check(imported.length === 2 && imported.some((s) => s.chain === 'tottus' && s.lat === -12.11 && s.status === 'to_verify') && imported.some((s) => s.chain === 'wong' && s.status === 'verified'),
      `CSV import: 2 stores added, chain by name/legend, decimal commas, status aliases (${imported.map((s) => s.name + ' — ' + s.district).join('; ')})`);
    check(/2/.test(impInfo), `import dialog found the header below the title row (${impInfo.trim()})`);
    await shot('09-import-summary');
    // Close the summary (Escape or its button).
    await page.keyboard.press('Escape');
    await noOverlay();

    /* ---------------------------------------------------------------- 4b. chains: ring colour */
    const hasRing = await ev(() => !!((window.MT_CHAINS || []).find((c) => c.id === 'mass') || {}).ringColor);
    if (hasRing) {
      console.log('\n4b. Cadenas — Mass ring colour');
      await page.click('#tab-chains');
      await waitFor(() => document.querySelector('.mt-chains-item[data-id="mass"]'));
      await page.click('.mt-chains-item[data-id="mass"]');
      await waitFor(() => MT.chainsui.draft() && MT.chainsui.draft().id === 'mass' && document.querySelector('.mt-chains-ring input[type=color]'));
      await sleep(400);
      const ring0 = await ev(() => ({ picker: document.querySelector('.mt-chains-ring input[type=color]').value, hex: document.querySelector('.mt-chains-ring .mt-chains-color__hex').value, marker: MT.markers.ringColor('mass') }));
      check(ring0.hex === '#0A2DB7' && ring0.picker === '#0a2db7' && ring0.marker === '#0A2DB7', `Mass shows its blue ring colour in Cadenas and on the map (${JSON.stringify(ring0)})`);
      await shot('09b-chains-mass');
      await page.click('.mt-chains-ring__reset');
      await waitFor(() => !document.querySelector('.mt-chains-savebar').hidden);
      await page.click('.mt-chains-savebar .mt-btn--primary');
      await waitFor(() => MT.data.chain('mass').ringColor === '' && MT.data.chainState('mass') === 'edited');
      // data/chains.js always carries ringColor (tools/merge.mjs format); "same as the brand" = ringColor equal to color.
      const ring1 = await ev(() => {
        const c = MT.data.chain('mass'), line = MT.io.chainsJs(MT.data.chains()).split('\n').find((l) => l.startsWith('  {"id":"mass"')) || '';
        return { marker: MT.markers.ringColor('mass'), brand: c.color, file: line.indexOf('"color":"' + c.color + '","ringColor":"' + c.color + '"') >= 0 };
      });
      check(ring1.marker === ring1.brand && ring1.file, `"Usar el color de marca" + Guardar → ring in the brand colour (${ring1.marker}); chains.js ringColor = brand colour: ${ring1.file}`);
      // The detail pane re-renders after the save (debounced): wait for it, then press "Restablecer".
      await sleep(400);
      await waitFor(() => document.querySelector('.mt-chains-hero__actions .mt-btn'));
      await ev(() => document.querySelector('.mt-chains-hero__actions .mt-btn').click());
      await waitFor(() => document.querySelector('.mt-modal-backdrop.is-open'));
      await page.click('.mt-modal-backdrop.is-open .mt-modal__footer .mt-btn:last-child');
      await waitFor(() => MT.data.chainState('mass') === 'seed');
      await noOverlay();
      const ring2 = await ev(() => ({ marker: MT.markers.ringColor('mass'), file: /\{"id":"mass"[^\n]*"ringColor":"#0A2DB7"/.test(MT.io.chainsJs(MT.data.chains())) }));
      check(ring2.marker === '#0A2DB7' && ring2.file, `"Restablecer" brings the shipped chain back; "Guardar en carpeta" would keep ringColor in data/chains.js (${JSON.stringify(ring2)})`);
    } else console.log('  info the chains file has no ringColor for Mass (fixtures) — ring colour step skipped');

    /* ---------------------------------------------------------------- 5. save → new → open */
    console.log('\n5. Save / open the project');
    await page.click('#tab-maps');
    await waitFor(() => MT.app.currentTab() === 'maps');
    const snapshot = await ev(() => { const p = JSON.parse(MT.project.toJSON()); delete p.updated; return JSON.stringify(p); });
    before = files();
    await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
    const saved = await newDownload(/\.mapa\.json$/, before, 20000);
    const savedObj = JSON.parse(readFileSync(saved, 'utf8'));
    check(savedObj.type === 'mapa-tiendas-project' && savedObj.maps.length === 3 && savedObj.name === pname, `Ctrl+S downloads ${path.basename(saved)} (3 maps)`);
    check(await ev(() => !MT.project.isDirty()), 'project marked as saved');

    // The rail's ⋮ menu is the same project menu as the top bar's (incl. the export entries).
    await page.click('.mt-maps-proj [aria-haspopup="menu"]');
    await waitFor(() => document.querySelector('.mt-menu'));
    const railMenu = await ev(() => [...document.querySelectorAll('.mt-menu__item')].map((b) => b.textContent.trim()));
    const expected = await ev(() => ['project.new', 'project.open', 'project.save', 'export.menu.pptx', 'export.menu.html'].map((k) => MT.t(k)));
    check(expected.every((l) => railMenu.some((x) => x.startsWith(l))), `rail project menu = top-bar menu (${railMenu.length} entries, incl. exports)`);
    await page.keyboard.press('Escape');
    await sleep(150);

    // New project (menu), then Ctrl+O the saved file.
    await page.click('.mt-topbar .mt-project [aria-haspopup="menu"]');
    await waitFor(() => document.querySelector('.mt-menu.is-open, .mt-menu'));
    const newLabel = await ev(() => MT.t('project.new'));
    await page.evaluate((label) => { const b = [...document.querySelectorAll('.mt-menu__item')].find((x) => x.textContent.includes(label)); b.click(); }, newLabel);
    await waitFor(() => MT.project.maps().length === 1 && MT.project.maps()[0].districts.length === 0);
    check(true, 'project menu → new project (one blank slide)');
    const [chooser2] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }),
      (async () => { await page.keyboard.down('Control'); await page.keyboard.press('o'); await page.keyboard.up('Control'); })()]);
    await chooser2.accept([saved]);
    await waitFor(() => MT.project.maps().length === 3);
    await idle();
    const reopened = await ev(() => { const p = JSON.parse(MT.project.toJSON()); delete p.updated; return JSON.stringify(p); });
    check(reopened === snapshot, 'Ctrl+O re-opens the saved file: project identical (titles, districts, Peso, chains, offsets, radius, styles)');

    /* ---------------------------------------------------------------- 6. reload */
    console.log('\n6. Reload');
    await page.click('.mt-maps-slide:nth-child(2) .mt-maps-slide__main');
    await waitFor(() => MT.project.currentMap().title === 'Trujillo');
    await sleep(800); // autosave debounce
    const beforeReload = await ev(() => ({ project: (() => { const p = JSON.parse(MT.project.toJSON()); delete p.updated; return JSON.stringify(p); })(), current: MT.project.currentMap().title,
      overlay: MT.data.overlayStats(), e2e: MT.data.stores().filter((s) => / E2E /.test(s.name)).map((s) => s.id).sort() }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true, { timeout: 30000 });
    await idle();
    const afterReload = await ev(() => ({ project: (() => { const p = JSON.parse(MT.project.toJSON()); delete p.updated; return JSON.stringify(p); })(), current: MT.project.currentMap().title,
      overlay: MT.data.overlayStats(), e2e: MT.data.stores().filter((s) => / E2E /.test(s.name)).map((s) => s.id).sort(), lang: MT.i18n.lang, tab: MT.app.currentTab(),
      chip: (document.querySelector('.mt-changes') || {}).textContent || '' }));
    check(afterReload.project === beforeReload.project, 'after reload: the whole project is restored (autosave)');
    check(afterReload.current === 'Trujillo' && afterReload.tab === 'maps', `after reload: same slide (${afterReload.current}) and tab`);
    check(afterReload.lang === lang, `after reload: language kept (${afterReload.lang})`);
    check(JSON.stringify(afterReload.e2e) === JSON.stringify(beforeReload.e2e) && afterReload.overlay.total === beforeReload.overlay.total && afterReload.overlay.total >= 2,
      `after reload: local database changes kept (${afterReload.overlay.total} change(s): "${afterReload.chip.trim()}")`);
    await shot('10-after-reload');

    const missing = await ev(() => MT.i18n.missingKeys());
    check(missing.length === 0, `no missing translation keys (${missing.join(', ')})`);
  } catch (err) {
    check(false, `[${lang}] journey aborted: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
    await shot('zz-failure').catch(() => null);
  } finally {
    const { real, noise } = splitNetworkNoise(errors);
    if (noise.length) console.log(`  info ${noise.length} transient tile request failure(s) from the network (not app errors)`);
    check(real.length === 0, `[${lang}] zero console errors${real.length ? ': ' + real.slice(0, 5).join(' | ') : ''}`);
    console.log(`  (${lang} journey: ${Math.round((Date.now() - t0) / 1000)} s)`);
    await browser.close();
  }
}

mkdirSync(OUT, { recursive: true });
for (const lang of LANGS) await journey(lang);
finish();
