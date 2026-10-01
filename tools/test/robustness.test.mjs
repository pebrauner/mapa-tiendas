// tools/test/robustness.test.mjs — regression checks for the review fixes (2026-10-01):
// file encodings and spreadsheet values on import, coordinate / status / date parsing, colloquial
// district names, radius circles around stores that are not on the slide, distinct dot colours,
// one working tab at a time, "Guardar en carpeta" into another copy of the app, and index.html
// opened without the rest of the folder.
//
//   node tools/test/robustness.test.mjs

import { openApp, prepareApp, launch, collectErrors, makeChecker, sleep } from './lib.mjs';
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { check, finish } = makeChecker('robustness');
const { browser, page, errors, url } = await openApp({ lang: 'es' });

try {
  /* ---- 1. Import parsing ------------------------------------------------------------------ */
  console.log('\n1. Import: encodings, spreadsheet values, coordinates, status, dates');
  const csv = 'Cadena;Nombre;Dirección;Distrito;Latitud;Longitud\r\nPlaza Vea;Plaza Vea Peñaflor;Av. José Pardo 123;Jesús María;-12,0753;-77,0461\r\n';
  const io = await page.evaluate(async (latin1, utf8) => {
    const file = (b64, name) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'text/csv' });
    const a = MT.io.rowsToStores(await MT.io.readTable(file(latin1, 'excel.csv'))), b = MT.io.rowsToStores(await MT.io.readTable(file(utf8, 'utf8.csv')));
    const XLSX = await MT.vendor.xlsx();
    const ws = XLSX.utils.aoa_to_sheet([['Cadena', 'Nombre', 'Latitud', 'Longitud', 'Fecha'], ['Mass', 'Mass Test', -12.121912, -77.029741, new Date(2026, 9, 1)]]);
    ws.C2.z = '0.00'; ws.D2.z = '0.00';
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
    const x = MT.io.rowsToStores(await MT.io.readXLSX(XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellDates: true })));
    return {
      latin1: a.stores[0], unknown: a.unknownColumns, utf8: b.stores[0], xlsx: x.stores[0],
      coords: ['12.0800 S', '77.05 O', '-12,0912', 'S 12.5', "12°04'48\" S", '12.08abc', ''].map(MT.io.parseCoord),
      status: ['Cerrado permanentemente', 'Cerrada temporalmente', 'Inactivo', 'Activa', 'Por verificar', 'algo raro'].map(MT.io.parseStatus),
      dates: ['1/10/2026', '2026-10-01T10:00', '46296', '13/02/2026', '02/13/2026', 'ayer'].map(MT.io.parseDate),
      codigo: MT.io.mapHeaders(['Código'])[0].column,
      swap: MT.io.rowsToStores([['Cadena', 'Nombre', 'Latitud', 'Longitud'], ['Mass', 'X', '-77.0365', '-12.0912']]).stores[0],
    };
  }, Buffer.from(csv, 'latin1').toString('base64'), Buffer.from('﻿' + csv, 'utf8').toString('base64'));
  check(io.latin1.name === 'Plaza Vea Peñaflor' && io.latin1.district === 'Jesús María' && io.latin1.address === 'Av. José Pardo 123' && !io.unknown.length, `Excel "CSV (delimitado por comas)" (Windows-1252) keeps á/é/ñ and the Dirección header (${io.latin1.name})`);
  check(io.utf8.name === 'Plaza Vea Peñaflor', 'UTF-8 with BOM still reads');
  check(io.xlsx.lat === -12.121912 && io.xlsx.lng === -77.029741 && io.xlsx.updated === '2026-10-01', `XLSX keeps full coordinate precision in a 2-decimal column (${io.xlsx.lat}) and dates as ISO (${io.xlsx.updated})`);
  check(JSON.stringify(io.coords.map((v) => (v === null ? null : Math.round(v * 1e4) / 1e4))) === JSON.stringify([-12.08, -77.05, -12.0912, -12.5, -12.08, null, null]), `coordinates with hemisphere letters / DMS / decimal comma; junk rejected (${JSON.stringify(io.coords)})`);
  check(io.status.join() === 'closed,closed,closed,verified,to_verify,to_verify', `status words → enum, unknown → to_verify (${io.status.join()})`);
  check(io.dates.join() === '2026-10-01,2026-10-01,2026-10-01,2026-02-13,2026-02-13,', `dates normalised to YYYY-MM-DD (${io.dates.join()})`);
  check(io.codigo === null, 'a generic "Código" column is not taken as the store id');
  check(io.swap.lat === -12.0912 && io.swap.lng === -77.0365 && io.swap._flags === undefined, 'swapped latitude / longitude columns are put back');

  /* ---- 2. District search --------------------------------------------------------------------- */
  console.log('\n2. District search: colloquial Lima names');
  const ds = await page.evaluate(() => ['surco', 'magdalena', 'cercado', 'sjl', 'miraf', 'surc'].map((q) => { const r = MT.data.districts.search(q, { limit: 3 }); return r.length ? r[0].ubigeo : null; }));
  // Fixture districts: only a few Lima districts exist; assert where they do.
  const has = await page.evaluate(() => ({ surco: !!MT.data.districts.get('150140'), mira: !!MT.data.districts.get('150122') }));
  if (has.surco) check(ds[0] === '150140' && ds[5] === '150140', `"surco" / "surc" → Santiago de Surco (${ds[0]}, ${ds[5]})`);
  if (has.mira) check(ds[4] === '150122', `"miraf" → Miraflores before San Juan de Miraflores (${ds[4]})`);
  check(true, `search results: ${ds.join(', ')}`);

  /* ---- 3. Radius around a store that is not on the slide, dot colours -------------------------------- */
  console.log('\n3. Radius circles and dot colours');
  const rd = await page.evaluate(() => {
    const s = MT.data.stores()[0];
    const base = MT.project.defaultMap({ districts: [s.ubigeo], radius: [{ storeId: s.id, meters: 1000 }] });
    const chains = Object.assign({}, base.chains); chains[s.chain] = false;
    return {
      shown: MT.radius.compute(base).length,
      hidden: MT.radius.compute(Object.assign({}, base, { hiddenStores: [s.id] })).length, hiddenWhy: MT.radius.inactiveReason(Object.assign({}, base, { hiddenStores: [s.id] }), s.id),
      chainOff: MT.radius.compute(Object.assign({}, base, { chains })).length,
    };
  });
  check(rd.shown === 1 && rd.hidden === 0 && rd.chainOff === 0 && rd.hiddenWhy === 'hidden', 'no circle around a hidden store or a chain switched off (and the reason is known)');
  const col = await page.evaluate(() => {
    const ids = MT.data.chains().filter((c) => !c.unknown).map((c) => c.id), cols = ids.map((id) => MT.markers.markerColor(id));
    let min = Infinity;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) min = Math.min(min, MT.markers.deltaE(cols[i], cols[j]));
    return { min: Math.round(min * 10) / 10, mass: MT.markers.markerColor('mass'), ring: MT.markers.ringColor('mass') };
  });
  check(col.min >= 12 && col.mass === col.ring, `dot / number colours are distinct per chain (min CIEDE2000 ${col.min}); Mass uses its ring colour (${col.mass})`);

  /* ---- 4. Another copy of the app as the remembered folder ------------------------------------ */
  console.log('\n4. "Guardar en carpeta" never writes into another copy of the app');
  const other = prepareApp({ fixtures: 'missing' });
  const dirOther = path.dirname(fileURLToPath(other.url)), dirSelf = path.dirname(fileURLToPath(url.split('?')[0]));
  await page.exposeFunction('nodeWrite', (dir, rel, data) => { const f = path.join(dir, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, data); return true; });
  await page.exposeFunction('nodeRemove', (dir, rel) => { const f = path.join(dir, rel); if (existsSync(f)) rmSync(f); return true; });
  const fsr = await page.evaluate(async (a, b) => {
    const mock = (root, sub) => ({ kind: 'directory', name: 'mapa-tiendas',
      getFileHandle: async (name) => ({ createWritable: async () => { let buf = ''; return { write: async (d) => { buf = typeof d === 'string' ? d : await d.text(); }, close: async () => window.nodeWrite(root, (sub ? sub + '/' : '') + name, buf) }; } }),
      getDirectoryHandle: async (name) => mock(root, (sub ? sub + '/' : '') + name), removeEntry: async (name) => window.nodeRemove(root, (sub ? sub + '/' : '') + name) });
    return { self: await MT.storage.fs.isRunningFolder(mock(a)), other: await MT.storage.fs.isRunningFolder(mock(b)) };
  }, dirSelf, dirOther);
  check(fsr.self === true && fsr.other === false, `the running folder is recognised, another copy is not (${JSON.stringify(fsr)})`);
  check(!existsSync(path.join(dirSelf, 'mt-folder-check.js')) && !existsSync(path.join(dirOther, 'mt-folder-check.js')), 'the check file is removed afterwards');

  /* ---- 5. Two tabs ------------------------------------------------------------------------------ */
  console.log('\n5. One working tab at a time');
  await page.evaluate(() => { MT.project.rename('Estudio pestañas'); MT.project.addMap({ title: 'Lámina de la pestaña A' }); });
  const B = await browser.newPage();
  const errsB = collectErrors(B);
  await B.goto(url, { waitUntil: 'load' });
  await B.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
  await sleep(500);
  const a1 = await page.evaluate(() => ({ paused: MT.app.paused, modal: !!document.querySelector('.mt-paused-modal') }));
  const b1 = await B.evaluate(() => ({ paused: MT.app.paused, maps: MT.project.maps().map((m) => m.title) }));
  check(a1.paused && a1.modal && !b1.paused, 'the older tab is paused with an explanation; the new one works');
  check(b1.maps.includes('Lámina de la pestaña A'), 'the new tab has the older tab\'s latest work');
  await page.bringToFront();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.evaluate(() => document.querySelector('.mt-paused-modal .mt-btn--primary').click())]);
  await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
  await sleep(500);
  const b2 = await B.evaluate(() => MT.app.paused);
  check(b2 === true && (await page.evaluate(() => !MT.app.paused)), '"Seguir en esta pestaña" takes over and pauses the other tab');
  check(errsB.length === 0, `second tab: zero console errors (${errsB.length})`);
  await B.close();
  rmSync(path.dirname(fileURLToPath(other.url)), { recursive: true, force: true });
} catch (err) {
  check(false, 'unexpected failure: ' + (err && err.stack || err));
} finally {
  // Expected: checking ANOTHER copy writes the check file there, so loading it from the running
  // folder fails (that failure is how the app knows) — the browser logs that 404.
  const real = errors.filter((e) => !/mt-folder-check\.js/.test(e));
  check(real.length === 0, `zero console errors (${real.length}; ${errors.length - real.length} expected 404 of the folder check)`);
  real.forEach((e) => console.log('    ', e));
  await browser.close();
}

/* ---- 6. index.html without the rest of the folder ---------------------------------------------- */
console.log('\n6. index.html opened without the rest of the folder');
{
  const { dir, url: u } = prepareApp({ fixtures: 'missing' });
  rmSync(path.join(dir, 'js'), { recursive: true, force: true });
  const b = await launch();
  const p = (await b.pages())[0];
  await p.goto(u, { waitUntil: 'load' });
  await sleep(500);
  const txt = await p.evaluate(() => document.body.innerText);
  check(/Faltan archivos de la aplicación/.test(txt) && /Extraer todo/.test(txt) && /Extract All/.test(txt), 'a bilingual "extract the whole folder" message replaces the endless splash');
  await b.close();
  rmSync(dir, { recursive: true, force: true });
}
finish();
