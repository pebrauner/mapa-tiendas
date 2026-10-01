// tools/test/core-api.mjs — behavioural checks of the core APIs (mt, i18n, geo, io, data, project,
// storage, logos, lazy vendor loading) inside the real page opened from file://.
//
//   node tools/test/core-api.mjs
// Uses the fixtures for every data file (deterministic), so counts below refer to tools/fixtures.

import { openApp, makeChecker, captureDownloads, waitForDownload } from './lib.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { check, finish } = makeChecker('core-api');
const { browser, page, errors } = await openApp({ lang: 'es', fixtures: 'all' });

const results = await page.evaluate(async () => {
  const out = [];
  const t = (ok, msg, extra) => out.push({ ok: !!ok, msg: msg + (extra !== undefined ? ` → ${JSON.stringify(extra)}` : '') });
  const U = MT.util;

  /* ---- util ---- */
  t(U.normalize('  Víctor  LARCO-Herrera ') === 'victor larco herrera', 'normalize strips accents/case/punctuation', U.normalize('  Víctor  LARCO-Herrera '));
  t(U.slug('Plaza Vea Angamos') === 'plaza-vea-angamos', 'slug');
  t(U.escapeHtml('<a href="x">&</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;', 'escapeHtml');
  t(U.sortBy(['Ñaña', 'Ate', 'Ávila', 'Zárate'], (x) => x).join() === 'Ate,Ávila,Ñaña,Zárate', 'Spanish collation sort', U.sortBy(['Ñaña', 'Ate', 'Ávila', 'Zárate'], (x) => x));
  let busCount = 0; const off = MT.bus.on('x:test', (p) => { busCount += p.n; }); MT.bus.emit('x:test', { n: 2 }); off(); MT.bus.emit('x:test', { n: 5 });
  t(busCount === 2, 'bus on/emit/off');

  /* ---- i18n ---- */
  t(MT.t('data.stores', { n: 1 }) === '1 tienda' && MT.t('data.stores', { n: 3 }) === '3 tiendas', 'plurals (es)');
  t(MT.t('project.copyOf', { title: 'X' }) === 'X (copia)', 'interpolation');
  t(MT.t('data.group.wholesale') === 'Mayoristas', 'nested keys');
  t(MT.i18n.formatDistance(850) === '850 m' && /^1[.,]2 km$/.test(MT.i18n.formatDistance(1234)), 'formatDistance', [MT.i18n.formatDistance(850), MT.i18n.formatDistance(1234)]);

  /* ---- geo ---- */
  const pc = (s) => MT.geo.parseCoordsDetailed(s);
  t(pc('-12.1219, -77.0297').lat === -12.1219, 'coords "lat, lng"');
  t(pc('-12.1219 -77.0297').lng === -77.0297, 'coords "lat lng"');
  t(pc('-12,1219; -77,0297').lat === -12.1219, 'coords decimal comma with ;');
  t(pc('12.1219 S, 77.0297 W').lat === -12.1219 && pc('12.1219°S 77.0297°O').lng === -77.0297, 'coords with hemispheres (W/O)');
  t(pc('-77.0297, -12.1219').swapped === true && pc('-77.0297, -12.1219').lat === -12.1219, 'swapped lng,lat detected');
  const gm = 'https://www.google.com/maps/place/Plaza+Vea/@-12.1300000,-77.0200000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-12.1312345!4d-77.0223456!16s';
  t(Math.abs(pc(gm).lat + 12.1312345) < 1e-6 && pc(gm).source === 'pin', 'Google Maps place URL uses the !3d!4d pin', pc(gm));
  t(pc('https://www.google.com/maps/@-12.1219,-77.0297,15z').source === 'view', 'Google Maps @lat,lng');
  t(pc('https://maps.google.com/?q=-12.1219,-77.0297').lat === -12.1219, 'Google Maps ?q=');
  t(pc('https://maps.app.goo.gl/AbCdEf').error === 'shortlink', 'short link detected');
  t(pc('hola').error === 'invalid' && pc('').error === 'empty', 'invalid/empty');
  const d = MT.geo.distanceMeters({ lat: -12.1219, lng: -77.0297 }, { lat: -12.1129, lng: -77.0297 });
  t(Math.abs(d - 1000.8) < 3, 'distanceMeters ~1 km', Math.round(d));
  const vb = MT.geo.viewBounds({ center: [-77.03, -12.12], zoomRef: 14 });
  t(vb && vb[0] < -77.03 && vb[2] > -77.03 && vb[1] < -12.12 && vb[3] > -12.12, 'viewBounds contains the centre', vb);
  t(MT.geo.overpassEndpoints()[0].includes('private.coffee'), 'file:// prefers an Overpass mirror that accepts Origin:null');

  /* ---- districts ---- */
  const D = MT.data.districts;
  t(D.available && D.all().length === 12, 'fixture districts loaded', D.all().length);
  const s1 = D.search('miraflores');
  t(s1[0] && s1[0].ubigeo === '150122' && s1[0].label === 'Miraflores — Lima, Lima', 'search "miraflores"', s1[0] && s1[0].label);
  t(D.search('victor larco')[0].ubigeo === '130111', 'accent-insensitive search "victor larco"');
  t(D.search('chimbote')[0].ubigeo === '021801' && D.search('chimbote')[1].ubigeo === '021809', 'exact name ranks before partial (Chimbote, Nuevo Chimbote)');
  t(D.search('san lima').every((r) => r.province === 'Lima'), 'multi-word filter by province');
  t(D.searchProvinces('truj')[0].ubigeos.length === 3, 'province search', D.searchProvinces('truj')[0]);
  const loc = D.locate(-12.1219, -77.0297);
  t(loc && loc.ubigeo === '150122', 'locate a point in Miraflores', loc && loc.district);
  t(D.locate(-12.0, -78.5) === null, 'locate in the sea → null');
  const f = D.feature('150122');
  t(f && /Polygon/.test(f.geometry.type) && f.properties.district === 'Miraflores', 'feature() decodes TopoJSON');

  /* ---- stores, chains, regions ---- */
  t(MT.data.chains().length === 16 && MT.data.chain('makro').legendName === 'CASH & CARRY', 'chains from fixture');
  const unk = MT.data.chain('nope');
  t(unk.unknown && unk.color && unk.legendName === 'NOPE', 'unknown chain synthesized');
  const all = MT.data.stores({ includeClosed: true }).length, open = MT.data.stores().length;
  t(all === 63 && open === 62, 'closed stores filtered by default', [all, open]);
  const map = MT.project.defaultMap({ districts: ['150122', '150130', '150131', '150141'] });
  const sfm = MT.data.storesForMap(map);
  t(sfm.length > 30 && sfm.every((s) => ['150122', '150130', '150131', '150141'].includes(s.ubigeo)), 'storesForMap onlyInside', sfm.length);
  t(!sfm.some((s) => s.chain === 'tambo' || s.chain === 'oxxo'), 'Tambo/Oxxo default off');
  const withTambo = MT.data.storesForMap(Object.assign({}, map, { chains: Object.assign({}, map.chains, { tambo: true }) }));
  t(withTambo.length > sfm.length, 'toggling a chain on adds its stores');
  const hidden = MT.data.storesForMap(Object.assign({}, map, { hiddenStores: [sfm[0].id] }));
  t(hidden.length === sfm.length - 1, 'hiddenStores');
  t(MT.data.subtitleFor(map) === '(Miraflores, San Borja, San Isidro, Surquillo)', 'auto subtitle sorted', MT.data.subtitleFor(map));
  t(MT.data.subtitleFor(Object.assign({}, map, { subtitleAuto: false, subtitle: 'Lima Top' })) === 'Lima Top', 'manual subtitle');
  const b = MT.data.boundsForMap(map), bd = MT.data.boundsForMap(Object.assign({}, map, { fitTo: 'districts' }));
  t(b && bd && bd[0] <= b[0] && bd[2] >= b[2], 'boundsForMap stores ⊂ districts', { b, bd });
  const outside = MT.data.storesForMap(Object.assign({}, map, { districts: ['150122'], onlyInside: false }));
  t(outside.length > MT.data.storesForMap(Object.assign({}, map, { districts: ['150122'] })).length, 'onlyInside=false also shows neighbours');

  /* ---- overlay edits (IndexedDB) ---- */
  const added = await MT.data.upsertStore({ chain: 'wong', name: 'Wong Prueba', lat: -12.1219, lng: -77.0297 });
  t(/^man-/.test(added.id) && added.ubigeo === '150122' && added.district === 'Miraflores', 'upsertStore adds + locates', added);
  t(MT.data.storeState(added.id) === 'added' && MT.data.overlayStats().added === 1, 'overlay stats after add');
  const seedId = MT.data.stores()[0].id;
  await MT.data.upsertStore({ id: seedId, name: 'Renombrada' });
  t(MT.data.store(seedId).name === 'Renombrada' && MT.data.storeState(seedId) === 'edited', 'edit a seed store');
  await MT.data.deleteStore(seedId);
  t(!MT.data.store(seedId) && MT.data.deletedStores().some((s) => s.id === seedId), 'delete a seed store');
  await MT.data.restoreStore(seedId);
  t(MT.data.store(seedId) && MT.data.store(seedId).name !== 'Renombrada' && MT.data.storeState(seedId) === 'seed', 'restore a seed store');
  const persisted = await MT.storage.getAll('stores');
  t(persisted.length === 1 && persisted[0].id === added.id, 'overlay persisted in IndexedDB', persisted.length);
  let evt = null; const off2 = MT.bus.on('stores:changed', (p) => { evt = p; });
  await MT.data.restoreStore(added.id);
  off2();
  t(!MT.data.store(added.id) && evt && evt.op === 'restore', 'stores:changed emitted');
  await MT.data.upsertChain({ id: 'micadena', name: 'Mi Cadena', color: '#123456', group: 'super' });
  t(MT.data.chain('micadena').legendName === 'MI CADENA' && MT.data.chainState('micadena') === 'added', 'add a chain');
  await MT.data.restoreChain('micadena');

  /* ---- logos ---- */
  const holi = MT.logos.get('holi'), pv = MT.logos.get('plazavea');
  t(holi.generated && /^data:image\/png/.test(holi.badge), 'missing logo → generated badge');
  t(!pv.generated && pv.source === 'seed' && pv.wide, 'seed logo with wide variant');
  t(MT.logos.initials('Plaza Vea') === 'PV' && MT.logos.initials('Wong') === 'WONG' && MT.logos.initials('Flora y Fauna') === 'FF' && MT.logos.initials('Dollarcity') === 'DOL', 'initials');
  const img = await MT.logos.image('plazavea');
  t(img.naturalWidth === 256, 'logo image decodes', img.naturalWidth);
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  cv.getContext('2d').drawImage(img, 0, 0, 64, 64);
  let tainted = false; try { cv.toDataURL(); } catch (e) { tainted = true; }
  t(!tainted, 'canvas with a logo is not tainted (data URIs)');

  /* ---- io ---- */
  const rows = MT.io.parseCSV(String.fromCharCode(0xFEFF) + 'a;b;c\r\n1;"x;y";"he said ""hi""\nnext"\r\n');
  t(rows.length === 2 && rows[1][1] === 'x;y' && rows[1][2] === 'he said "hi"\nnext', 'CSV parse ; quotes newlines', rows);
  const stores = MT.data.stores({ includeClosed: true });
  const csv = MT.io.storesToCSV(stores);
  t(csv.charCodeAt(0) === 0xFEFF && csv.split('\r\n')[0] === String.fromCharCode(0xFEFF) + MT.data.COLUMNS.join(','), 'CSV header + BOM');
  const back = MT.io.storesFromCSV(csv);
  t(back.stores.length === stores.length && back.missingColumns.length === 0 && back.unknownColumns.length === 0, 'CSV round trip', back.stores.length);
  const same = back.stores.every((s, i) => { const o = MT.data.normalizeStore(s), x = stores[i]; return MT.data.COLUMNS.every((c) => String(o[c]) === String(x[c])); });
  t(same, 'CSV round trip preserves every field');
  const es = MT.io.rowsToStores([['Cadena', 'Nombre', 'Dirección', 'Latitud', 'Longitud', 'Estado', 'Extra'], ['Plaza Vea', 'PV X', 'Av. Larco 1', '-12,12', '-77,03', 'Por verificar', 'z']]);
  t(es.stores[0].chain === 'plazavea' && es.stores[0].lat === -12.12 && es.stores[0].status === 'to_verify' && es.unknownColumns[0] === 'Extra', 'Spanish headers, chain by name, decimal comma', es.stores[0]);
  const js = MT.io.storesJs(stores);
  const sandbox = {}; new Function('window', js)(sandbox);
  t(sandbox.MT_SEED.count === stores.length && sandbox.MT_SEED.columns.length === 16, 'storesJs evaluates to MT_SEED');
  const cjs = {}; new Function('window', MT.io.chainsJs(MT.data.chains()))(cjs);
  t(cjs.MT_CHAINS.length === 16, 'chainsJs evaluates to MT_CHAINS');
  // ringColor survives normalizeChain → chainsJs ("Guardar en carpeta" must not drop it).
  const rawRing = (window.MT_CHAINS || []).filter((c) => c.ringColor && c.ringColor.toUpperCase() !== String(c.color).toUpperCase());
  t(rawRing.every((c) => (cjs.MT_CHAINS.find((x) => x.id === c.id) || {}).ringColor === c.ringColor.toUpperCase()), 'chainsJs keeps ringColor', rawRing.map((c) => c.id));
  t(MT.data.normalizeChain({ id: 'x', name: 'X', color: '#112233', ringColor: '#abcdef' }).ringColor === '#ABCDEF' &&
    MT.data.normalizeChain({ id: 'x', name: 'X', color: '#112233' }).ringColor === '', 'normalizeChain keeps a valid ringColor');
  // Delimiter: title row above a ';' header, and commas inside unquoted ';' fields.
  t(MT.io.detectDelimiter('Reporte de tiendas, octubre\r\nid;cadena;nombre\r\n1;Mass;Mass Pardo, Miraflores\r\n2;Tottus;Tottus\r\n') === ';', 'detectDelimiter reads past a title row');
  t(MT.io.detectDelimiter('a\tb\tc\n1\t2\t3\n') === '\t' && MT.io.detectDelimiter('a,b\n1,2\n') === ',' && MT.io.detectDelimiter('solo') === ',', 'detectDelimiter tab / comma / default');
  const idSet = new Set(); for (let i = 0; i < 300; i++) idSet.add(MT.data.newStoreId());
  t(idSet.size === 300 && [...idSet].every((x) => /^man-[a-z0-9]+$/.test(x)), 'newStoreId never repeats inside a batch');
  const files = MT.io.repoFiles();
  t(files.map((f) => f.path).join() === 'data/stores.csv,data/stores.js,data/chains.js,logos/logos.js', 'repoFiles list');
  const prevMissing = MT.data.missing;
  MT.data.missing = Object.assign({}, prevMissing, { stores: true });
  const partial = MT.io.repoFiles();
  MT.data.missing = prevMissing;
  t(partial.skipped.join() === 'data/stores.csv,data/stores.js' && partial.map((f) => f.path).join() === 'data/chains.js,logos/logos.js',
    'repoFiles never rewrites a data file whose shipped version did not load', partial.skipped);
  const xblob = await MT.io.storesToXLSX(stores);
  const xrows = await MT.io.readXLSX(await xblob.arrayBuffer());
  const xback = MT.io.rowsToStores(xrows);
  t(window.XLSX && xback.stores.length === stores.length && xback.stores[0].ubigeo === stores[0].ubigeo, 'XLSX write/read round trip (SheetJS lazy-loaded)', xback.stores.length);
  const P = await MT.vendor.pptx();
  t(typeof P === 'function' && typeof new P().addSlide === 'function', 'PptxGenJS lazy-loads from file://');

  /* ---- project ---- */
  const pj = MT.project;
  const events = [];
  const offs = ['map:changed', 'map:selected', 'project:changed'].map((e) => MT.bus.on(e, (p) => events.push(e + ':' + (p.reason || (p.keys || []).join('+') || p.id))));
  const m1 = pj.currentMap();
  pj.updateMap(m1.id, { title: 'Lima Sur', districts: ['150122'] });
  pj.updateMap(m1.id, { title: 'Lima Sur' }); // no-op
  const m2 = pj.duplicateMap(m1.id);
  pj.moveMap(m2.id, 0);
  t(pj.maps()[0].id === m2.id && pj.currentMapId() === m2.id && m2.title === 'Lima Sur (copia)', 'duplicate + move + select');
  pj.removeMap(m2.id);
  t(pj.maps().length === 1 && pj.currentMapId() === m1.id, 'remove selects a neighbour');
  offs.forEach((o) => o());
  t(events.filter((e) => e.startsWith('map:changed')).length === 1 && events.includes('map:changed:title+districts'), 'map:changed only when something changed', events);
  const json = JSON.parse(pj.toJSON());
  t(json.type === 'mapa-tiendas-project' && json.version === 1 && json.maps[0].onlyInside === true && json.maps[0].markerStyle === 'badge', 'project JSON per SPEC §3.5');
  const norm = pj.normalize({ type: 'mapa-tiendas-project', version: 1, name: 'X', maps: [{ title: 'A', chains: { plazavea: false, zzz: true }, markerSize: 9 }] });
  t(norm.maps[0].chains.zzz === true && norm.maps[0].chains.plazavea === false && norm.maps[0].chains.wong === true && norm.maps[0].markerSize === 1.6, 'normalize fills defaults, keeps unknown chains, clamps size');
  let bad = null; try { pj.normalize({ foo: 1 }); } catch (e) { bad = e.message; }
  t(bad === 'project-invalid', 'invalid project rejected');

  /* ---- vendor globals (classic scripts) ---- */
  t(window.maplibregl && maplibregl.getVersion() === '5.24.0', 'maplibregl 5.24.0 global', window.maplibregl && maplibregl.getVersion());
  t(window.turf && typeof turf.circle === 'function' && typeof turf.booleanPointInPolygon === 'function', 'turf global');
  t(window.topojson && typeof topojson.feature === 'function', 'topojson-client global');
  t(window.XLSX && XLSX.version === '0.20.3', 'SheetJS 0.20.3 global', window.XLSX && XLSX.version);

  /* ---- theme ---- */
  const th = MT.theme;
  t(Math.abs(th.frame.refHeight - 838.71) < 0.01 && th.in2px(13.333, 3840) === 3840 && Math.abs(th.ref2in(1000) - 7.75) < 1e-9, 'theme units');
  return out;
});

for (const r of results) check(r.ok, r.msg);

// Downloads (MT.io.download) land on disk with the right content.
const dl = await captureDownloads(page);
await page.evaluate(() => MT.io.download(MT.io.storesToCSV(MT.data.stores({ includeClosed: true })), MT.io.datedName('Tiendas', 'csv')));
const file = await waitForDownload(dl, /^Tiendas - \d{4}-\d{2}-\d{2}\.csv$/);
const text = readFileSync(file, 'utf8');
check(text.charCodeAt(0) === 0xFEFF && text.split('\r\n').length === 65, `download written (${path.basename(file)}, ${text.length} chars)`);
check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
await browser.close();
finish();
