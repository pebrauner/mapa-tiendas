// tools/test/data-roundtrip.test.mjs — "Guardar en carpeta" writes the data files exactly like the
// data workflow, and the built-in example project ships and opens safely.
//
//   node tools/test/data-roundtrip.test.mjs
//
// 1. Byte-identical round trip: the shipped data/stores.js and data/chains.js are loaded by the app (file://,
//    real data), serialized with MT.io (repoFiles = what "Guardar en carpeta" writes) and compared BYTE FOR BYTE
//    with data/stores.csv, data/stores.js and data/chains.js (MT_CHAINS with every osm key + the MT_OSM_RULES
//    block); an edited chain changes only its own line and the seed's reference classifier still compiles the file. Then, with local edits (accents, ñ, a new unknown chain, a closed
//    store, a deletion), the app's stores.csv is fed to the real tools/build-data.mjs (in a temp copy)
//    and its output must equal the app's stores.js — i.e. MT.io.sortStores = build-data's order.
// 2. Card markers without a wide logo: a white card of the same height as the others (w = h) with
//    the badge mark inside (not a bare colour tile).
// 3. Example project: js/example-project.js is in sync with tools/fixtures/demo.mapa.json; the
//    project menu entry, the Mapas first-run notice and the empty state open it; it never replaces
//    unsaved work without asking (cancel / open without saving / save first) — ES and EN labels.
import { openApp, makeChecker, screenshot, sleep, captureDownloads, waitForDownload, ROOT, FIXTURES } from './lib.mjs';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { compileOsmRules, classifyOsm } from '../seed/osm-classify.mjs';

const { check, finish } = makeChecker('data-roundtrip');
const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0; while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  const s = (buf) => buf.subarray(Math.max(0, i - 80), i + 80).toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `byte ${i} (sizes ${a.length} / ${b.length})\n      app : …${s(a)}…\n      file: …${s(b)}…`;
};

/* ---------------------------------------------------------------- 1. data files */
const { browser, page, errors, injected } = await openApp({ lang: 'es', viewport: { width: 1440, height: 900 } });
try {
  console.log('\n1. Store files: app serializers = data workflow');
  check(!injected.includes('data/stores.js') && !injected.includes('data/chains.js'), `real data/stores.js and data/chains.js loaded (injected fixtures: ${injected.join(', ') || 'none'})`);
  const out = await page.evaluate(() => {
    const files = MT.io.repoFiles();
    const get = (p) => (files.find((f) => f.path === p) || {}).data;
    return { csv: get('data/stores.csv'), js: get('data/stores.js'), n: MT.data.stores({ includeClosed: true }).length, local: MT.data.overlayStats().total };
  });
  check(out.local === 0, 'no local changes in a fresh profile');
  const csvFile = readFileSync(path.join(ROOT, 'data', 'stores.csv'));
  const jsFile = readFileSync(path.join(ROOT, 'data', 'stores.js'));
  const csvApp = Buffer.from(out.csv || '', 'utf8'), jsApp = Buffer.from(out.js || '', 'utf8');
  const d1 = firstDiff(csvApp, csvFile), d2 = firstDiff(jsApp, jsFile);
  check(!d1, `data/stores.csv: the app writes the same ${csvFile.length} bytes (${out.n} stores)${d1 ? ' — differs at ' + d1 : ''}`);
  check(!d2, `data/stores.js: the app writes the same ${jsFile.length} bytes${d2 ? ' — differs at ' + d2 : ''}`);

  // data/chains.js: MT_CHAINS (every osm key, ringColor, logo) + the MT_OSM_RULES block, byte for byte.
  const chainsOut = await page.evaluate(() => {
    const files = MT.io.repoFiles();
    return { file: (files.find((f) => f.path === 'data/chains.js') || {}).data, old: MT.io.chainsJs(MT.data.chains(), null) };
  });
  const chainsFile = readFileSync(path.join(ROOT, 'data', 'chains.js'));
  const d4 = firstDiff(Buffer.from(chainsOut.file || '', 'utf8'), chainsFile);
  check(!d4 && /window\.MT_OSM_RULES = \{/.test(chainsOut.file), `data/chains.js (with MT_OSM_RULES): "Guardar en carpeta" writes the same ${chainsFile.length} bytes${d4 ? ' — differs at ' + d4 : ''}`);
  check(!/MT_OSM_RULES/.test(chainsOut.old.split('\n').slice(3).join('\n')) && /^window\.MT_CHAINS = \[/m.test(chainsOut.old), 'an old chains.js without MT_OSM_RULES is written back without the block');
  // An edited chain: the change is written, everything else (other chains, MT_OSM_RULES) stays byte-identical,
  // and the reference classifier of the seed merge (tools/seed/osm-classify.mjs) compiles the result.
  const editedChains = await page.evaluate(async () => {
    await MT.data.upsertChain({ id: 'oxxo', osm: { excludeTags: [{ key: 'description', valueRegex: 'gasolinera', why: 'prueba' }] }, defaultOn: true });
    const text = MT.io.repoFiles().find((f) => f.path === 'data/chains.js').data;
    await MT.data.restoreChain('oxxo');
    return text;
  });
  {
    const before = chainsFile.toString('utf8').split('\n'), after = editedChains.split('\n');
    const changed = after.map((l, i) => (l !== before[i] ? i : -1)).filter((i) => i >= 0);
    const sbx = { window: {} };
    vm.runInNewContext(editedChains, sbx);
    let compiled = null;
    try { compiled = compileOsmRules(sbx.window.MT_CHAINS, sbx.window.MT_OSM_RULES); } catch (e) { compiled = e.message; }
    const oxxo = sbx.window.MT_CHAINS.find((c) => c.id === 'oxxo');
    check(after.length === before.length && changed.length === 1 && /^ {2}\{"id":"oxxo"/.test(after[changed[0]]) && oxxo.defaultOn === true &&
      oxxo.osm.excludeTags[0].key === 'description' && oxxo.osm.excludeNameRegex === '^oxxo\\s+gas',
      `edited chain: only its line changes (line ${changed.map((i) => i + 1).join(', ')}), its other osm keys kept`);
    check(compiled && typeof compiled === 'object' && classifyOsm({ shop: 'convenience', name: 'Oxxo', description: 'Gasolinera' }, compiled).kind === 'excluded',
      'the seed\'s reference classifier (tools/seed/osm-classify.mjs) compiles the app\'s file and applies the edit');
  }
  // The new data fields are read: defaultOn (Mass off), ringColor, wide logos (card style), osm rules.
  const fields = await page.evaluate(async () => {
    const m = MT.project.defaultMap();
    const ids = MT.data.chains().filter((c) => !c.unknown).map((c) => c.id);
    await MT.markers.ready(ids, { kind: 'card', size: 1 });
    const cards = ids.map((id) => ({ id, d: MT.markers.dims(id, { kind: 'card', size: 1 }) }));
    return {
      off: ids.filter((id) => m.chains[id] === false), massSeed: MT.data.chain('mass').defaultOn,
      rings: ['mass', 'tottus', 'plazavea', 'metro'].map((id) => MT.markers.ringColor(id)),
      raw: ['mass', 'tottus', 'plazavea', 'metro'].map((id) => window.MT_CHAINS.find((c) => c.id === id).ringColor),
      wide: ids.filter((id) => MT.logos.get(id).wide), seedWide: Object.keys(window.MT_LOGOS).filter((k) => window.MT_LOGOS[k].wide).sort(),
      wideCards: cards.filter((c) => c.d.w > c.d.h * 1.2).map((c) => c.id), squareCards: cards.filter((c) => Math.abs(c.d.w - c.d.h) < 1e-6).map((c) => c.id),
      rules: MT.osm.globalRulesSource(),
    };
  });
  check(fields.massSeed === false && fields.off.sort().join() === 'mass,oxxo,tambo', `new maps: Mass, Tambo and Oxxo off by default (defaultOn from data/chains.js): ${fields.off.join(', ')}`);
  check(fields.rings.join() === fields.raw.join() && fields.rings[0] === '#0A2DB7', `ringColor read: badge rings ${fields.rings.join(' ')} (Mass blue ring on a yellow brand)`);
  check(fields.wide.slice().sort().join() === fields.seedWide.join() && fields.wide.length === 15 && !fields.wide.includes('holi') &&
    fields.wideCards.length === 15 && fields.squareCards.join() === 'holi', `wide logos read: ${fields.wide.length} wordmark cards, Holi a square card`);

  // Local edits that exercise the sort: accents / ñ / case in names and districts, an unknown chain
  // (sorted after every known chain), a closed store (kept), a deletion (dropped).
  const edited = await page.evaluate(async () => {
    const all = MT.data.stores({ includeClosed: true });
    const del = all.find((s) => s.chain === 'tottus');
    // Around Parque Kennedy, Miraflores (the district comes from the coordinates).
    const base = { address: 'Av. Prueba 123', lat: -12.1219, lng: -77.0297, source: 'manual', precision: 'exact', status: 'verified' };
    await MT.data.upsertStores([
      Object.assign({}, base, { chain: 'wong', name: 'Wong Ñaña' }),
      Object.assign({}, base, { chain: 'wong', name: 'wong ñandú', lat: -12.1225, lng: -77.0290 }),
      Object.assign({}, base, { chain: 'wong', name: 'Wong Árbol', status: 'closed' }),
      Object.assign({}, base, { chain: 'zzcadena', name: 'Cadena Rara Norte' }),
      Object.assign({}, base, { chain: 'aacadena', name: 'Otra Cadena' }),
    ], { op: 'import' });
    await MT.data.deleteStore(del.id);
    const files = MT.io.repoFiles();
    const get = (p) => (files.find((f) => f.path === p) || {}).data;
    return { csv: get('data/stores.csv'), js: get('data/stores.js'), chains: get('data/chains.js'), local: MT.data.overlayStats().total, deleted: del.id };
  });
  check(edited.local >= 6, `local edits made (${edited.local})`);
  // Run the real build-data.mjs on the app's CSV + chains.js in a temp copy of the repo layout.
  const tmp = path.join(os.tmpdir(), `mapa-tiendas-roundtrip-${Date.now()}`);
  mkdirSync(path.join(tmp, 'tools'), { recursive: true });
  mkdirSync(path.join(tmp, 'data'), { recursive: true });
  copyFileSync(path.join(ROOT, 'tools', 'build-data.mjs'), path.join(tmp, 'tools', 'build-data.mjs'));
  writeFileSync(path.join(tmp, 'data', 'stores.csv'), edited.csv, 'utf8');
  writeFileSync(path.join(tmp, 'data', 'chains.js'), edited.chains, 'utf8');
  const run = spawnSync(process.execPath, [path.join(tmp, 'tools', 'build-data.mjs')], { encoding: 'utf8' });
  check(run.status === 0, `tools/build-data.mjs accepts the app's stores.csv${run.status ? ': ' + run.stderr.trim() : ''}`);
  if (run.status === 0) {
    const built = readFileSync(path.join(tmp, 'data', 'stores.js'));
    const d3 = firstDiff(Buffer.from(edited.js, 'utf8'), built);
    check(!d3, `with local edits: build-data(app stores.csv) = app stores.js, byte for byte${d3 ? ' — differs at ' + d3 : ''}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  const lines = edited.csv.split('\r\n');
  const idx = (re) => lines.findIndex((l) => re.test(l));
  check(idx(/,aacadena,/) > idx(/,oxxo,|,tambo,/) && idx(/,zzcadena,/) > idx(/,aacadena,/), 'unknown chains after every known chain, by id');
  check(!lines.some((l) => l.startsWith(edited.deleted + ',')) && /,Wong Árbol,.*,closed,/.test(edited.csv), 'deleted store dropped, closed store kept');
  const wongRows = lines.filter((l) => /^[^,]+,wong,/.test(l) && /,Miraflores,Lima,Lima,/.test(l)).map((l) => l.split(',')[2]);
  const iA = wongRows.indexOf('Wong Árbol'), iN = wongRows.indexOf('Wong Ñaña'), iN2 = wongRows.indexOf('wong ñandú');
  check(iA >= 0 && iN > iA && iN2 > iN, `accent/case-insensitive name order inside a district (${wongRows.slice(Math.max(0, iA - 1), iA + 4).join(' · ')})`);
  // DB export of the whole base uses the same order.
  const exportOrder = await page.evaluate(() => {
    const ids = MT.io.sortStores(MT.data.stores({ includeClosed: true })).map((s) => s.id);
    const csvIds = MT.io.parseCSV(MT.io.repoFiles()[0].data).slice(1).map((r) => r[0]);
    return ids.join() === csvIds.join();
  });
  check(exportOrder, 'MT.io.sortStores order = data/stores.csv order');
  await page.evaluate(() => MT.data.resetOverlay({ stores: true, chains: true, logos: true }));

  /* ---------------------------------------------------------------- 2. card without wide logo */
  console.log('\n2. Card markers without a wide logo');
  const card = await page.evaluate(async () => {
    // A chain with a solid blue square badge and no wide logo, next to a chain with a wordmark.
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d'); g.fillStyle = '#1040C0'; g.fillRect(0, 0, 256, 256);
    await MT.logos.set('cardtest', { badge: cv.toDataURL('image/png') });
    const style = { kind: 'card', size: 1 };
    const wideId = MT.data.chains().map((c) => c.id).find((id) => MT.logos.get(id).wide);
    await MT.markers.ready(['cardtest', wideId], style);
    const d = MT.markers.dims('cardtest', style), dw = MT.markers.dims(wideId, style);
    const ic = MT.markers.icon('cardtest', 120, style), iw = MT.markers.icon(wideId, 120, style);
    const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
    const k = ic.height / (d.h + 2);                 // icon px per reference unit (1-unit margin around the card)
    const res = {
      d, dw, icon: [ic.width, ic.height], wideIcon: [iw.width, iw.height],
      center: px(ic, ic.width >> 1, ic.height >> 1),
      pad: px(ic, Math.round((1 + 2.4) * k), ic.height >> 1),      // inside the border, in the white padding
    };
    await MT.logos.remove('cardtest');
    return res;
  });
  check(Math.abs(card.d.w - card.d.h) < 1e-9 && Math.abs(card.d.h - card.dw.h) < 1e-9, `square card: w = h = ${card.d.h.toFixed(1)} units, same height as a wordmark card (${card.dw.w.toFixed(1)} × ${card.dw.h.toFixed(1)})`);
  check(card.icon[1] === card.wideIcon[1] && Math.abs(card.icon[0] - card.icon[1]) <= 1, `legend icon square and as tall as a wordmark icon (${card.icon.join('×')} vs ${card.wideIcon.join('×')})`);
  const isBlue = (p) => p[2] > 150 && p[0] < 60 && p[3] > 200, isWhite = (p) => p[0] > 235 && p[1] > 235 && p[2] > 235 && p[3] > 200;
  check(isBlue(card.center), `badge mark drawn inside the card (centre pixel ${card.center})`);
  check(isWhite(card.pad), `white card padding around the mark (pixel ${card.pad}) — not a bare colour tile`);

  /* ---------------------------------------------------------------- 3. example project */
  console.log('\n3. Built-in example project');
  const sync = spawnSync(process.execPath, [path.join(FIXTURES, 'build-example.mjs'), '--check'], { encoding: 'utf8' });
  check(sync.status === 0, `js/example-project.js in sync with tools/fixtures/demo.mapa.json${sync.status ? ': ' + sync.stderr.trim() : ''}`);
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'demo.mapa.json'), 'utf8'));
  const shipped = await page.evaluate(() => JSON.stringify(window.MT_EXAMPLE_PROJECT));
  check(shipped === JSON.stringify(fixture), 'window.MT_EXAMPLE_PROJECT = demo.mapa.json');
  const want = {
    'demo-lima-sur': ['tiendas3a', 'dollarcity', 'florayfauna', 'holi', 'metro', 'tottus', 'plazavea', 'wong', 'vivanda'],
    'demo-lima-cono-sur': ['tiendas3a', 'makro', 'dollarcity', 'florayfauna', 'holi', 'maxiahorro', 'metro', 'preciouno', 'tottus', 'vega', 'plazavea', 'wong'],
    'demo-trujillo': ['makro', 'wong', 'metro', 'plazavea', 'tottus', 'preciouno'],
    'demo-chimbote': ['makro', 'metro', 'plazavea', 'tottus'],
  };
  for (const m of fixture.maps) {
    const on = Object.keys(m.chains).filter((k) => m.chains[k]).sort().join();
    check(on === want[m.id].slice().sort().join() && m.markerStyle === 'badge' && m.fitTo === 'stores' && m.showBorders === false,
      `${m.id}: badge, fit to stores, no borders, chains = reference legend (${want[m.id].length})`);
  }
  check(fixture.maps[0].radius.length === 1 && fixture.maps[0].radius[0].meters === 1000, 'Lima Metropolitana Sur keeps one 1 km radius');

  // (a) First run: a blank project → the "Elige los distritos" notice offers the example; no dialog.
  await page.evaluate(() => { MT.project.newProject(); MT.app.showTab('maps'); });
  await page.waitForFunction(() => document.querySelector('.mt-mapview__notice:not([hidden]) .mt-mapview__example'), { timeout: 15000 });
  await sleep(300);
  const notice = await page.evaluate(() => document.querySelector('.mt-mapview__notice').textContent);
  check(/Ver ejemplo con 4 regiones/.test(notice), 'blank project: the centre notice offers "Ver ejemplo con 4 regiones"');
  await screenshot(page, 'example-first-run');
  await page.click('.mt-mapview__notice:not([hidden]) .mt-mapview__example');
  await page.waitForFunction(() => MT.project.maps().length === 4, { timeout: 5000 });
  const opened = await page.evaluate(() => ({ name: MT.project.current().name, ids: MT.project.maps().map((m) => m.id), dirty: MT.project.isDirty(),
    modal: !!document.querySelector('.mt-example-modal'), tab: MT.app.currentTab(), cur: MT.project.currentMapId(),
    toast: [...document.querySelectorAll('.mt-toast')].map((t) => t.textContent).join(' | ') }));
  check(!opened.modal && opened.ids.join() === fixture.maps.map((m) => m.id).join() && opened.cur === 'demo-lima-sur' && opened.tab === 'maps',
    `opens straight away on a blank project (${opened.ids.length} slides, ${opened.cur})`);
  check(opened.name === 'Ejemplo — Lima, Trujillo y Chimbote' && !opened.dirty && /proyecto de ejemplo \(4 láminas\)/.test(opened.toast), `named "${opened.name}", not dirty, toast shown`);
  await sleep(1500);
  await screenshot(page, 'example-opened');
  // The example itself, unchanged: opening it again does not ask.
  check(await page.evaluate(async () => { const p = MT.app.openExampleProject(); await MT.util.sleep(200); const asked = !!document.querySelector('.mt-example-modal'); await p; return !asked; }),
    're-opening the unchanged example does not ask');

  // (b) Project menu entry (top bar).
  await page.click('.mt-topbar .mt-project [aria-haspopup="menu"]');
  await page.waitForSelector('.mt-menu');
  const menu = await page.evaluate(() => [...document.querySelectorAll('.mt-menu__item')].map((b) => ({ t: b.textContent.trim(), d: b.disabled })));
  const entry = menu.find((m) => m.t.startsWith('Abrir proyecto de ejemplo'));
  check(entry && !entry.d && menu.findIndex((m) => m.t.startsWith('Abrir proyecto…')) === menu.indexOf(entry) - 1, `project menu: "Abrir proyecto de ejemplo" after "Abrir proyecto…" (${menu.map((m) => m.t).slice(0, 4).join(' / ')})`);
  await page.keyboard.press('Escape');
  await sleep(150);

  // (c) Unsaved work → "save first?" dialog. Cancel keeps it; "Abrir sin guardar" replaces it.
  await page.evaluate(() => { MT.project.newProject(); MT.project.rename('Estudio Arequipa'); MT.project.updateMap(MT.project.currentMapId(), { title: 'Cercado', districts: ['040101'] }); });
  const ask = async () => {
    await page.evaluate(() => { window.__ex = MT.app.openExampleProject(); });
    await page.waitForSelector('.mt-example-modal', { timeout: 5000 });
    await sleep(250);
    return page.evaluate(() => ({ title: document.querySelector('.mt-example-modal .mt-modal__title').textContent,
      text: document.querySelector('.mt-example-modal .mt-modal__body').textContent,
      buttons: [...document.querySelectorAll('.mt-example-modal .mt-modal__footer .mt-btn')].map((b) => b.textContent.trim()),
      focus: document.activeElement && document.activeElement.textContent.trim() }));
  };
  const clickBtn = (label) => page.evaluate((label) => [...document.querySelectorAll('.mt-example-modal .mt-modal__footer .mt-btn')].find((b) => b.textContent.trim() === label).click(), label);
  let dlg = await ask();
  check(dlg.title === '¿Guardar el proyecto actual?' && /«Estudio Arequipa» tiene cambios que no se guardaron/.test(dlg.text) &&
    dlg.buttons.join('|') === 'Cancelar|Abrir sin guardar|Guardar y abrir el ejemplo' && dlg.focus === 'Guardar y abrir el ejemplo',
    `unsaved work → asks to save first [${dlg.buttons.join(' | ')}], focus on "${dlg.focus}"`);
  await screenshot(page, 'example-save-first');
  await clickBtn('Cancelar');
  check(await page.evaluate(async () => (await window.__ex) === false && MT.project.current().name === 'Estudio Arequipa' && MT.project.maps()[0].title === 'Cercado' && MT.project.isDirty()),
    'Cancelar keeps the current project untouched');
  dlg = await ask();
  await clickBtn('Abrir sin guardar');
  check(await page.evaluate(async () => (await window.__ex) === true && MT.project.maps().length === 4 && MT.project.currentMap().title === 'Lima Metropolitana Sur'),
    '"Abrir sin guardar" opens the example');

  // (d) "Guardar y abrir el ejemplo": the project is saved first (download fallback here), then replaced.
  const downloads = await captureDownloads(page, path.join(os.tmpdir(), `mapa-tiendas-example-dl-${Date.now()}`));
  await page.evaluate(() => { MT.env.saveFilePicker = false; MT.project.newProject(); MT.project.rename('Estudio Piura'); MT.project.updateMap(MT.project.currentMapId(), { districts: ['200101'] }); });
  dlg = await ask();
  await clickBtn('Guardar y abrir el ejemplo');
  const savedFile = await waitForDownload(downloads, /Estudio Piura\.mapa\.json$/).catch(() => null);
  const savedObj = savedFile ? JSON.parse(readFileSync(savedFile, 'utf8')) : null;
  check(savedObj && savedObj.name === 'Estudio Piura' && savedObj.maps[0].districts[0] === '200101', `saved first: ${savedFile ? path.basename(savedFile) : 'no download'}`);
  check(await page.evaluate(async () => (await window.__ex) === true && MT.project.maps().length === 4), '…then the example opens');
  rmSync(downloads, { recursive: true, force: true });

  // (e) A project already saved to a file → a plain confirmation (2 buttons), no save offer.
  const dl2 = await captureDownloads(page, path.join(os.tmpdir(), `mapa-tiendas-example-dl2-${Date.now()}`));
  await page.evaluate(async () => { MT.project.newProject(); MT.project.rename('Estudio Cusco'); MT.project.updateMap(MT.project.currentMapId(), { districts: ['080101'] }); await MT.project.save({ download: true }); });
  await waitForDownload(dl2, /Estudio Cusco\.mapa\.json$/).catch(() => null);
  dlg = await ask();
  check(dlg.title === '¿Abrir el proyecto de ejemplo?' && /ya está guardado en un archivo/.test(dlg.text) && dlg.buttons.join('|') === 'Cancelar|Abrir el ejemplo',
    `saved project → confirmation only [${dlg.buttons.join(' | ')}]`);
  await clickBtn('Abrir el ejemplo');
  check(await page.evaluate(async () => (await window.__ex) === true && MT.project.maps().length === 4), 'confirmed → example opened');
  rmSync(dl2, { recursive: true, force: true });

  // (f) Empty state of the Mapas tab (no slides): "Crear lámina" + "Ver ejemplo con 4 regiones".
  await page.evaluate(() => { MT.project.newProject(); MT.project.maps().slice().forEach((m) => MT.project.removeMap(m.id)); });
  await page.waitForFunction(() => !document.querySelector('.mt-maps__empty').hidden);
  const empty = await page.evaluate(() => [...document.querySelectorAll('.mt-maps__empty .mt-btn')].map((b) => b.textContent.trim()));
  check(empty.join('|') === 'Crear lámina|Ver ejemplo con 4 regiones', `empty state buttons: ${empty.join(' | ')}`);
  await screenshot(page, 'example-empty-state');
  await page.click('.mt-maps__empty .mt-maps__example');
  // Removing every slide is a change: the dialog asks first.
  await page.waitForSelector('.mt-example-modal', { timeout: 5000 });
  await sleep(250);
  await clickBtn('Abrir sin guardar');
  await page.waitForFunction(() => MT.project.maps().length === 4 && document.querySelector('.mt-maps__empty').hidden, { timeout: 5000 });
  check(true, 'empty state → example opened, slides shown');

  // (g) English labels.
  await page.evaluate(() => MT.i18n.setLang('en'));
  await sleep(200);
  const en = await page.evaluate(() => ({ menu: MT.t('project.example.menu'), button: MT.t('project.example.button'), name: MT.t('project.example.name') }));
  check(en.menu === 'Open example project' && en.button === 'See an example with 4 regions', `English: "${en.menu}" / "${en.button}"`);
  await page.evaluate(() => { MT.project.newProject(); MT.app.showTab('maps'); });
  await page.waitForFunction(() => { const b = document.querySelector('.mt-mapview__notice:not([hidden]) .mt-mapview__example'); return b && /See an example/.test(b.textContent); }, { timeout: 15000 });
  await sleep(300);
  // Earlier toasts may sit over the notice at this viewport height: close them first.
  await page.evaluate(() => document.querySelectorAll('.mt-toast').forEach((t) => t.remove()));
  await page.click('.mt-mapview__notice:not([hidden]) .mt-mapview__example');
  await page.waitForFunction(() => MT.project.maps().length === 4, { timeout: 5000 });
  check(await page.evaluate(() => MT.project.current().name) === 'Example — Lima, Trujillo and Chimbote', 'English: notice button "See an example with 4 regions" opens the example, named in English');
  await page.evaluate(() => MT.i18n.setLang('es'));
} catch (err) {
  check(false, 'unexpected failure: ' + (err && err.stack || err));
  await screenshot(page, 'roundtrip-failure').catch(() => {});
} finally {
  await sleep(200);
  check(errors.length === 0, `zero console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}
finish();
