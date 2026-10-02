// tools/test/analysis-e2e.mjs — the phase 2a journey (SPEC §6), from file://, in Spanish and in English.
//
//   node tools/test/analysis-e2e.mjs [--lang=es|en] [--headful]
//
// Drives the app the way a colleague would (clicks, typing, keyboard, the Exportar popover), on the
// real data, once per UI language:
//   1. Base de datos: a store placed by hand from the seed report (Holi Pardo — REPORT §4 →
//      tools/seed/overrides.json `manualPlacements`) is found by the search, "por verificar".
//   2. Análisis, mode A, a store reference: type-ahead "plaza vea miraf" + Enter → Plaza Vea
//      Miraflores; the table = MT.analysis.distancesFrom; universe chip 2 km; the hand-placed Holi Pardo
//      is listed with its "≈" and "por verificar" flags.
//   3. Excel (mode A), read back with SheetJS: sheet names in the UI language, metres as numbers = engine.
//   4. "Agregar como lámina" → Mapas on the slide (a new project's blank slide is filled, not left empty) (automatic subtitle, legend counts, the "Distancias
//      a …" list) → PNG slide and PowerPoint through the Exportar popover (rings, the list, glued lines in
//      the slide XML) → inspector "Editar en Análisis" → the tab, linked to the slide → universe 1 km →
//      "Actualizar la lámina" → the slide's analysis follows.
//   5. Mode A, a point reference from a pasted Google Maps link, with a label and an own chain → = engine;
//      "Agregar como lámina" again → a second slide.
//   6. Mode B on Lima Sur (zone button) = MT.analysis.neighborMatrix / closePairs; its Excel read back.
//   7. Reload → the tab, mode B with its region, the mode A settings (universe, rings), the slide with its
//      analysis (autosave), the language and the recent references persist; the reference itself is per
//      session by design (SPEC §6.1: recent list) — one click on it restores the analysis.
// Zero console errors. Screenshots: tools/test/out/an-e2e-<lang>-*.png; downloads in out/an-e2e-downloads-<lang>/.

import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import path from 'node:path';
import { openApp, screenshot, waitForMapIdle, captureDownloads, makeChecker, sleep, splitNetworkNoise, OUT, ROOT } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const LANGS = args.lang ? [args.lang] : ['es', 'en'];
const { check, finish } = makeChecker('analysis-e2e');

const LIMA_SUR = ['150108', '150119', '150123', '150133', '150142', '150143'];
const GMAPS = 'https://www.google.com/maps/place/Parque+Kennedy/@-12.1219,-77.0302,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-12.12185!4d-77.03007';

// The File System Access pickers cannot be driven headlessly: the app then downloads (like Firefox).
function hideFsAccess() {
  for (const k of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); } catch (e) { /* ignore */ }
  }
}

/* ---- file readers ------------------------------------------------------------------------------ */
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
function pngInfo(file) {
  const b = readFileSync(file);
  return { ok: b.slice(0, 8).toString('hex') === '89504e470d0a1a0a', width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}
/** Every entry of a ZIP (a .pptx) → Buffer (stored or deflated). */
function unzip(file) {
  const b = readFileSync(file), out = {};
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return out;
  let p = b.readUInt32LE(e + 16);
  const n = b.readUInt16LE(e + 10);
  for (let k = 0; k < n; k++) {
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), len = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + len).toString('utf8');
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const data = b.slice(start, start + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + len + extra + comment;
  }
  return out;
}
/** UI distance text of the Análisis tab: "850 m", "1.2 km", "12 km" (es-PE and English: decimal point). */
// The app's one distance text (MT.i18n.formatDistance), re-implemented: rounded to 0.1 m (the Excel
// value), then to whole metres; one decimal below 9.95 km, whole km above; es-PE grouping.
function fmtDist(m) {
  const w = Math.round(Math.round(m * 10) / 10);
  if (w < 1000) return w + ' m';
  const km = w / 1000;
  return new Intl.NumberFormat('es-PE', { maximumFractionDigits: km < 9.95 ? 1 : 0 }).format(km) + ' km';
}
const round1 = (m) => Math.round(m * 10) / 10;

async function journey(lang) {
  const L = (es, en) => (lang === 'es' ? es : en);
  console.log(`\n================ ${lang.toUpperCase()} ================`);
  const t0 = Date.now();
  const { browser, page, errors, injected } = await openApp({ lang, onNewDocument: hideFsAccess, headless: !args.headful, viewport: { width: 1440, height: 900 } });
  const dl = path.join(OUT, `an-e2e-downloads-${lang}`);
  await captureDownloads(page, dl);
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const waitFor = (fn, arg, timeout = 20000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
  const shot = (name) => screenshot(page, `an-e2e-${lang}-${name}`);
  const anaIdle = () => waitForMapIdle(page, { expr: 'window.MT && MT.analysisui && MT.analysisui.state().mapReady && MT.analysisui.map()', timeout: 60000 }).catch(() => null);
  const mapsIdle = async () => { await sleep(250); await waitForMapIdle(page, { timeout: 60000 }).catch(() => null); await sleep(250); };
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
  const typeInto = async (sel, text) => {
    await page.click(sel, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text);
  };
  console.log(`  data: ${injected.length ? 'fixtures for ' + injected.join(', ') : 'real data files'}`);

  try {
    /* ---------------------------------------------------------------- 1. a hand-placed store */
    console.log('\n1. Base de datos — a store placed by hand from the seed report');
    await waitFor(() => window.MT && MT.app && MT.app.booted && document.querySelector('#tab-db'));
    await page.click('#tab-db');
    await waitFor(() => document.querySelector('.mt-db-table tbody tr[data-id]'));
    await page.click('.mt-db-search__input');
    await page.keyboard.type('holi pardo');
    await waitFor(() => document.querySelector('.mt-db-table tbody tr[data-id="web-holi-pardo"]'));
    const db = await ev(() => {
      const s = MT.data.store('web-holi-pardo');
      return { s: s && { status: s.status, precision: s.precision, source: s.source, district: s.district, notes: s.notes },
        row: document.querySelector('.mt-db-table tbody tr[data-id="web-holi-pardo"]').textContent, status: MT.t('data.status.to_verify'),
        placed: MT.data.stores().filter((x) => /^Colocada a mano/.test(x.notes || '')).length };
    });
    check(db.s && db.s.status === 'to_verify' && db.s.precision === 'approx' && db.s.source === 'web' && db.s.district === 'Miraflores' && /^Colocada a mano/.test(db.s.notes),
      `Holi Pardo (manualPlacements) is in the database: web, approx, to_verify, Miraflores`);
    check(db.row.includes('Holi Pardo') && db.row.includes(db.status), `DB search "holi pardo" finds it, status "${db.status}" shown`);
    check(db.placed >= 25, `${db.placed} stores placed by hand are in the app's data`);
    await page.keyboard.press('Escape');

    /* ---------------------------------------------------------------- 2. mode A: store */
    console.log('\n2. Análisis — distances to Plaza Vea Miraflores');
    await page.click('#tab-analysis');
    await waitFor(() => MT.app.currentTab() === 'analysis' && MT.analysisui && MT.analysisui.state().mapReady, null, 60000);
    await anaIdle();
    const tab = await ev(() => ({ label: document.querySelector('#tab-analysis').textContent.trim(), hash: location.hash, title: document.querySelector('.mt-analysis-head__h').textContent }));
    check(tab.label === L('Análisis', 'Analysis') && tab.hash === '#analisis' && tab.title === L('Análisis de distancias', 'Distance analysis'), `tab "${tab.label}" (${tab.hash}): ${tab.title}`);
    await page.click('[data-field="refSearch"]');
    await page.keyboard.type('plaza vea miraf');
    await waitFor(() => document.querySelector('.mt-analysis-options [role=option]'));
    await page.keyboard.press('Enter');
    await waitFor(() => MT.analysisui.state().ref && MT.analysisui.state().ref.type === 'store');
    const PV = await ev(() => MT.analysisui.state().ref.storeId);
    check(await ev(() => MT.data.store(MT.analysisui.state().ref.storeId).name) === 'Plaza Vea Miraflores', `type-ahead + Enter → reference Plaza Vea Miraflores (${PV})`);
    await page.click('.mt-analysis-chip[data-value="2000"]');
    await waitFor(() => MT.analysisui.state().universe.meters === 2000);
    await sleep(200);
    const a2 = await ev(() => {
      const st = MT.analysisui.state(), ui = MT.analysisui.results();
      const eng = MT.analysis.distancesFrom(MT.analysis.refFromStore(st.ref.storeId), { chains: st.chains, maxMeters: 2000, includeToVerify: true });
      const sig = (rows) => rows.map((r) => r.store.id + ':' + r.meters + ':' + r.rank).join('|');
      const holi = ui.res.rows.find((r) => r.store.id === 'web-holi-pardo');
      return { n: ui.res.rows.length, same: sig(eng.rows) === sig(ui.res.rows), max: Math.max(...ui.res.rows.map((r) => r.meters)),
        head: document.querySelector('.mt-analysis-mainhead__h').textContent, meta: document.querySelector('.mt-analysis-mainhead__meta').textContent,
        holi: holi && { flags: holi.flags, meters: holi.meters, rank: holi.rank }, first: ui.res.rows.slice(0, 3).map((r) => r.meters) };
    });
    check(a2.same && a2.n > 20 && a2.max <= 2000, `universe 2 km: ${a2.n} stores, table = MT.analysis.distancesFrom, all ≤ 2 km`);
    check(a2.head === L('Distancias a Plaza Vea Miraflores', 'Distances to Plaza Vea Miraflores') && a2.meta.startsWith(L(`${a2.n} tiendas a menos de 2 km`, `${a2.n} stores within 2 km`)),
      `header "${a2.head}" · "${a2.meta}"`);
    check(!!a2.holi && a2.holi.flags.approx && a2.holi.flags.toVerify, `the hand-placed Holi Pardo is in the table (#${a2.holi && a2.holi.rank}, ${a2.holi && fmtDist(a2.holi.meters)}), flagged ≈ and por verificar`);
    await page.type('[data-field="filterA"]', 'holi pardo');
    await waitFor(() => document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id]').length === 1);
    const holiRow = await ev(() => document.querySelector('.mt-analysis-table--a tbody tr[data-id="web-holi-pardo"]').textContent);
    check(holiRow.includes('≈') && holiRow.includes(L('Por verificar', 'To verify')) && holiRow.includes(fmtDist(a2.holi.meters)), `its row: "${holiRow.replace(/\s+/g, ' ').trim().slice(0, 90)}"`);
    await ev(() => { const i = document.querySelector('[data-field="filterA"]'); i.value = ''; i.dispatchEvent(new Event('input')); });
    await waitFor(() => document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id]').length > 5);
    const firstCells = await ev(() => [...document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id]')].slice(0, 3).map((tr) => tr.children[2].textContent));
    check(firstCells.join('|') === a2.first.map(fmtDist).join('|'), `distances in the table: ${firstCells.join(', ')}`);
    await anaIdle();
    await shot('01-store');

    /* ---------------------------------------------------------------- 3. Excel (mode A) */
    console.log('\n3. Excel (distances)');
    let before = files();
    await page.click('.mt-analysis-act-excel');
    const xa = await newDownload(new RegExp(`^${L('Distancias a', 'Distances to')} Plaza Vea Miraflores - \\d{4}-\\d\\d-\\d\\d\\.xlsx$`), before, 30000);
    const bookA = readBook(xa);
    const sheetA = L('Distancias', 'Distances');
    check(bookA.names.join('|') === L('Resumen|Distancias|Por cadena y anillo|Parámetros', 'Summary|Distances|By chain and ring|Parameters'), `${path.basename(xa)}: sheets ${bookA.names.join(', ')}`);
    const engA = await ev(() => MT.analysisui.results().res.rows.map((r) => [r.rank, r.store.id, r.meters]));
    const D = bookA.sheets[sheetA] || [[]], hd = D[0];
    const iM = hd.indexOf(L('Distancia (m)', 'Distance (m)')), iT = hd.indexOf(L('Distancia', 'Distance')), iId = hd.indexOf('ID');
    check(D.length === engA.length + 1 && iM > 0 && iT > 0 && iId > 0 &&
      engA.every((x, i) => D[i + 1][0] === x[0] && D[i + 1][iId] === x[1] && D[i + 1][iM] === round1(x[2]) && D[i + 1][iT] === fmtDist(x[2])),
      `"${sheetA}": ${D.length - 1} rows = engine (metres as numbers, "${D[1] && D[1][iT]}" text)`);
    const P = Object.fromEntries((bookA.sheets[L('Parámetros', 'Parameters')] || []).slice(1).map((r) => [r[0], r[1]]));
    check(P[L('Referencia', 'Reference')] === 'Plaza Vea Miraflores' && P[L('Universo', 'Universe')] === L('Tiendas a menos de 2 km', 'Stores within 2 km'),
      `parameters: ${P[L('Referencia', 'Reference')]} · ${P[L('Universo', 'Universe')]}`);

    /* ---------------------------------------------------------------- 4. slide */
    console.log('\n4. Agregar como lámina → Mapas → exports → Editar en Análisis');
    const blank = await ev(() => { const ms = MT.project.maps(); return ms.length === 1 && !ms[0].title && !ms[0].districts.length ? ms[0].id : null; });
    await page.click('.mt-analysis-act-slide');
    await waitFor(() => MT.app.currentTab() === 'maps' && MT.project.currentMap() && !!MT.project.currentMap().analysis);
    await mapsIdle();
    await waitFor(() => document.querySelector('.mt-slide') && /Distancia|Distance/.test(document.querySelector('.mt-slide').innerText), null, 30000).catch(() => null);
    const sl = await ev(() => {
      const m = MT.project.currentMap(), items = MT.legend.items(m), d = items.distances;
      const holi = items.find((r) => r.chainId === 'holi');
      const sfm = MT.data.storesForMap(m);
      return { id: m.id, slides: MT.project.maps().length, title: m.title, an: m.analysis, districts: m.districts.length, sub: MT.data.subtitleFor(m),
        slideText: (document.querySelector('.mt-slide') || document.body).innerText,
        heading: d && d.heading, list: d ? d.items.length : 0, listText: d ? d.items.map((x) => x.text) : [],
        holiCount: holi ? holi.count : 0, holiStores: sfm.filter((s) => s.chain === 'holi').length, holiPardo: sfm.some((s) => s.id === 'web-holi-pardo'),
        n: sfm.length, rows: MT.analysis.forMap(m).rows.length };
    });
    check(!!blank && sl.id === blank && sl.slides === 1, 'a new project: the analysis fills its blank first slide (no empty slide left in the deck)');
    check(sl.title === 'Plaza Vea Miraflores' && sl.an && sl.an.maxMeters === 2000 && sl.an.rings.join() === '500,1000,2000' && sl.districts === 0,
      `new slide "${sl.title}": rings ${sl.an && sl.an.rings.join('/')}, stores within ${sl.an && sl.an.maxMeters} m, no districts`);
    check(sl.sub === 'Distancias a Plaza Vea Miraflores' && sl.slideText.includes('Distancias a Plaza Vea Miraflores'), `slide subtitle (Spanish slide text in both UIs): "${sl.sub}"`);
    // es-PE slide text; a store with an approximate or "por verificar" location is marked "≈ 750 m" (Holi Pardo, first).
    check(sl.heading === 'Distancias a Plaza Vea Miraflores' && sl.list === 8 && sl.listText.every((x) => /^(≈ )?(\d+ m|\d+(\.\d)? km)$/.test(x)) && sl.listText[0].startsWith('≈ '),
      `legend panel list "${sl.heading}": ${sl.list} stores (${sl.listText.slice(0, 4).join(', ')}…)`);
    check(sl.holiPardo && sl.holiCount === sl.holiStores, `Mapas legend counts the hand-placed store: HOLI (${sl.holiCount})`);
    check(sl.n === a2.n + 1 && sl.rows === a2.n, `the slide shows the tab's ${a2.n} stores + the reference`);
    await shot('02-slide');
    const exportVia = async (kind, { scope = 'current', res = null } = {}) => {
      await page.click('.mt-maps-bar__export');
      await waitFor(() => document.querySelector('.mt-maps-popover.is-open'));
      await page.$eval(`.mt-maps-popover input[value="${scope}"]`, (el) => { if (!el.disabled) el.closest('label').click(); });
      if (res) await page.$eval(`.mt-maps-popover input[value="${res}"]`, (el) => el.closest('label').click());
      const b = files();
      await page.click(`.mt-maps-xopt[data-export="${kind}"]`);
      return b;
    };
    before = await exportVia('slidePng', { res: '1920' });
    const png = await newDownload(/\.png$/, before);
    await noOverlay();
    const pi = pngInfo(png);
    check(pi.ok && pi.width === 1920 && pi.height === 1080 && pi.bytes > 150000, `PNG slide: ${path.basename(png)} ${pi.width}×${pi.height}, ${Math.round(pi.bytes / 1024)} KB`);
    before = await exportVia('pptx', { scope: 'current' });
    const pptx = await newDownload(/\.pptx$/, before);
    await noOverlay();
    const zip = unzip(pptx);
    const slides = Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const xml = slides.length ? zip[slides[0]].toString('utf8') : '';
    const lines = [...xml.matchAll(/<p:cxnSp>([\s\S]*?)<\/p:cxnSp>/g)].filter((x) => /name="Distancia — /.test(x[1]) && /<a:stCxn id="\d+"/.test(x[1]) && /<a:endCxn id="\d+"/.test(x[1])).length;
    check(slides.length === 1 && /name="Anillo 500 m"/.test(xml) && /name="Anillo 1 km"/.test(xml) && /name="Anillo 2 km"/.test(xml),
      `PowerPoint: ${path.basename(pptx)} — 1 slide with the 500 m / 1 km / 2 km rings as shapes`);
    check(/<a:t>Distancias a Plaza Vea Miraflores<\/a:t>/.test(xml) && lines > 0, `PowerPoint: the "Distancias a …" list as text, ${lines} distance lines glued to the stores`);
    // "Editar en Análisis" in the inspector → back on the tab, linked to the slide.
    await page.click('[data-action="editAnalysis"]');
    await waitFor((id) => MT.app.currentTab() === 'analysis' && MT.analysisui.state().linked === id && MT.analysisui.state().ref, sl.id);
    await sleep(300);
    const ed = await ev(() => ({ st: MT.analysisui.state(), bar: document.querySelector('.mt-analysis-linkbar').textContent, upd: !!document.querySelector('.mt-analysis-act-update') }));
    check(ed.st.ref.storeId === PV && ed.st.universe.meters === 2000 && ed.st.rings.join() === '500,1000,2000' && ed.upd &&
      ed.bar.includes(L('Editando el análisis de la lámina «Plaza Vea Miraflores»', 'Editing the analysis of the slide “Plaza Vea Miraflores”')),
      `"Editar en Análisis" → the tab with the slide's reference, universe and rings, linked ("${ed.bar.trim()}")`);
    await page.click('.mt-analysis-chip[data-value="1000"]');
    await waitFor(() => MT.analysisui.state().universe.meters === 1000);
    await page.click('.mt-analysis-act-update');
    await waitFor((id) => MT.project.getMap(id).analysis.maxMeters === 1000, sl.id);
    const upd = await ev((id) => { const m = MT.project.getMap(id); return { an: m.analysis, n: MT.data.storesForMap(m).length, ui: MT.analysisui.results().res.rows.length }; }, sl.id);
    check(upd.an.rings.join() === '500,1000' && upd.n === upd.ui + 1, `"Actualizar la lámina" → 1 km, rings ${upd.an.rings.join('/')}, ${upd.n} stores on the slide`);

    /* ---------------------------------------------------------------- 5. mode A: point */
    console.log('\n5. A point from a Google Maps link');
    await ev(() => { const b = [...document.querySelectorAll('.mt-analysis-linkbar button')].pop(); if (b) b.click(); });
    await page.click('.mt-analysis-chip[data-value="2000"]');
    await waitFor(() => MT.analysisui.state().universe.meters === 2000);
    await page.click('[data-field="refSearch"]');
    await page.keyboard.type(GMAPS);
    await waitFor(() => document.querySelector('.mt-analysis-options [role=option]'));
    const opt = await ev(() => document.querySelector('.mt-analysis-options [role=option]').textContent);
    check(opt.includes('-12.12185, -77.03007') && opt.includes(L('Enlace de Google Maps', 'Google Maps link')), `pasted link → "${opt.slice(0, 60)}…"`);
    await page.keyboard.press('Enter');
    await waitFor(() => MT.analysisui.state().ref && MT.analysisui.state().ref.type === 'point');
    // A full link names the place ("/place/Parque+Kennedy/"): the point's label starts as that name.
    const pre = await ev(() => ({ label: MT.analysisui.state().ref.label, box: document.querySelector('[data-field="refLabel"]').value }));
    check(pre.label === 'Parque Kennedy' && pre.box === 'Parque Kennedy', `the link's place name prefills the point's label ("${pre.label}")`);
    await page.focus('[data-field="refLabel"]');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('[data-field="refLabel"]', L('Local propuesto Kennedy', 'Proposed site Kennedy'));
    await page.select('[data-field="ownChain"]', 'tottus');
    await waitFor((want) => MT.analysisui.state().ref.chainId === 'tottus' && MT.analysisui.state().ref.label === want, L('Local propuesto Kennedy', 'Proposed site Kennedy'));
    await sleep(400);
    const pt = await ev(() => {
      const st = MT.analysisui.state(), ui = MT.analysisui.results();
      const ref = MT.analysis.refFromPoint({ lat: st.ref.lat, lng: st.ref.lng, chainId: 'tottus' });
      const eng = MT.analysis.distancesFrom(ref, { chains: st.chains, maxMeters: 2000 });
      const sum = MT.analysis.summary(eng);
      return { ref: st.ref, n: ui.res.rows.length, same: eng.rows.map((r) => r.store.id + r.meters).join() === ui.res.rows.map((r) => r.store.id + r.meters).join(),
        card: (document.querySelector('.mt-analysis-stat.is-comp .mt-analysis-stat__store') || {}).textContent, comp: sum.nearestCompetitor && sum.nearestCompetitor.store.name,
        head: document.querySelector('.mt-analysis-mainhead__h').textContent, district: (MT.data.districts.locate(st.ref.lat, st.ref.lng) || {}).district };
    });
    check(pt.ref.lat === -12.12185 && pt.ref.lng === -77.03007 && pt.district === 'Miraflores', `point at the link's pin (${pt.ref.lat}, ${pt.ref.lng}) in ${pt.district}`);
    check(pt.same && pt.n > 20 && pt.card === pt.comp && pt.head === L('Distancias a Local propuesto Kennedy', 'Distances to Proposed site Kennedy'),
      `own chain Tottus + label: ${pt.n} stores = engine, nearest competitor ${pt.comp}`);
    await anaIdle();
    await shot('03-point');
    // A second analysis → a second slide (the project is no longer blank).
    await page.click('.mt-analysis-act-slide');
    await waitFor(() => MT.app.currentTab() === 'maps' && MT.project.maps().length === 2);
    const sl2 = await ev(() => { const m = MT.project.currentMap(); return { title: m.title, ref: m.analysis && m.analysis.ref, sub: MT.data.subtitleFor(m), n: MT.data.storesForMap(m).length }; });
    check(sl2.title === L('Local propuesto Kennedy', 'Proposed site Kennedy') && sl2.ref && sl2.ref.type === 'point' && sl2.ref.chainId === 'tottus' && sl2.n === pt.n,
      `"Agregar como lámina" again → slide 2 "${sl2.title}" (point, own chain Tottus, ${sl2.n} stores), subtitle "${sl2.sub}"`);
    await mapsIdle();
    await shot('03b-point-slide');
    await page.click('#tab-analysis');
    await waitFor(() => MT.app.currentTab() === 'analysis');

    /* ---------------------------------------------------------------- 6. mode B */
    console.log('\n6. Matriz de cercanía — Lima Sur');
    await page.click('.mt-analysis-modes .mt-seg__opt:nth-child(2)');
    await waitFor(() => MT.analysisui.mode() === 'matrix');
    await sleep(300);
    const zoneBtn = await ev(() => !!document.querySelector('.mt-analysis-zonebtns button'));
    if (zoneBtn) await ev(() => [...document.querySelectorAll('.mt-analysis-zonebtns button')].find((b) => b.textContent === 'Lima Sur').click());
    else await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), LIMA_SUR);
    await waitFor((n) => MT.analysisui.state().matrix.districts.length === n, LIMA_SUR.length);
    await ev(() => MT.analysisui.whenIdle());
    await sleep(300);
    const mb = await ev(() => {
      const A = MT.analysis, st = MT.analysisui.state().matrix, r = MT.analysisui.results();
      const region = A.storesForRegion({ districts: st.districts, chains: st.chains, includeToVerify: true });
      const nm = A.neighborMatrix(region, { radius: st.radius, candidates: st.neighbors ? A.storesForRegion({ chains: st.chains, includeToVerify: true }) : region });
      const sig = (rows) => rows.map((x) => [x.store.id, x.nearestSame && x.nearestSame.meters, x.nearestCompetitor && x.nearestCompetitor.store.id, x.sameWithin, x.competitorsWithin].join(':')).join('|');
      return { n: nm.length, same: sig(nm) === sig(r.rows), pairs: r.pairs.length, sameFirst: r.pairs.every((p, i, a) => !i || !(p.sameChain && !a[i - 1].sameChain)),
        head: document.querySelector('.mt-analysis-mainhead__h').textContent, districts: st.districts.slice().sort().join() };
    });
    check(mb.districts === LIMA_SUR.slice().sort().join() && mb.same && mb.n > 40, `Lima Sur: ${mb.n} stores, per-store matrix = MT.analysis.neighborMatrix`);
    check(mb.pairs > 0 && mb.sameFirst && mb.head === L('Matriz de cercanía · Lima Sur', 'Proximity matrix · Lima Sur'), `${mb.pairs} close pairs (same chain first), "${mb.head}"`);
    await anaIdle();
    await shot('04-matrix');
    before = files();
    await page.click('.mt-analysis-act-excel');
    const xb = await newDownload(new RegExp(`^${L('Matriz de cercanía', 'Proximity matrix')} - Lima Sur - \\d{4}-\\d\\d-\\d\\d\\.xlsx$`), before, 30000);
    const bookB = readBook(xb);
    const engB = await ev(() => { const r = MT.analysisui.results(); return { rows: r.rows.map((x) => [x.store.id, x.sameWithin, x.competitorsWithin, x.nearestSame ? x.nearestSame.meters : null]), pairs: r.pairs.map((p) => [p.a.id, p.b.id, p.meters]) }; });
    const PT = bookB.sheets[L('Por tienda', 'By store')] || [[]], PP = bookB.sheets[L('Pares cercanos', 'Close pairs')] || [[]];
    // "Por tienda": chain and store first, the id near the end, rows in the tab's order (nearest same-chain store first).
    const iIdB = PT[0].indexOf('ID'), byIdB = new Map(engB.rows.map((x) => [x[0], x]));
    const kB = (r) => (r[3] === null ? Infinity : r[3]);
    const orderB = engB.rows.slice().sort((a, b) => (kB(a) === kB(b) ? 0 : kB(a) < kB(b) ? -1 : 1) || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
    check(bookB.names.join('|') === L('Por tienda|Pares cercanos|Parámetros', 'By store|Close pairs|Parameters') && PT.length === engB.rows.length + 1 && iIdB > 10 &&
      PT[0][0] === L('Cadena', 'Chain') && PT.slice(1).every((r, i) => r[iIdB] === orderB[i] && byIdB.has(r[iIdB])) && new Set(PT[0]).size === PT[0].length,
      `${path.basename(xb)}: ${PT.length - 1} store rows = engine, in the tab's order, distinct headers`);
    check(PP.length === engB.pairs.length + 1 && engB.pairs.every((p, i) => PP[i + 1][PP[0].length - 2] === p[0] && PP[i + 1][PP[0].length - 1] === p[1] && PP[i + 1][7] === round1(p[2])),
      `"${L('Pares cercanos', 'Close pairs')}": ${PP.length - 1} pairs, metres as numbers`);

    /* ---------------------------------------------------------------- 7. reload */
    console.log('\n7. Reload');
    await sleep(800);                                  // project autosave debounce
    const beforeReload = await ev(() => ({ project: (() => { const p = JSON.parse(MT.project.toJSON()); delete p.updated; return JSON.stringify(p); })(),
      matrix: MT.analysisui.state().matrix, recent: [...document.querySelectorAll('.mt-analysis-recent__item')].length }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true, { timeout: 30000 });
    await waitFor(() => MT.app.currentTab() === 'analysis' && MT.analysisui.state().mapReady, null, 60000);
    await ev(() => MT.analysisui.whenIdle());
    await sleep(300);
    const after = await ev(() => ({ project: (() => { const p = JSON.parse(MT.project.toJSON()); delete p.updated; return JSON.stringify(p); })(),
      st: MT.analysisui.state(), lang: MT.i18n.lang, hash: location.hash, rows: (MT.analysisui.results().rows || []).length,
      slides: MT.project.maps().length, slide: MT.project.maps().find((m) => m.analysis && m.analysis.ref && m.analysis.ref.type === 'store') }));
    check(after.lang === lang && after.hash === '#analisis' && after.st.mode === 'matrix', `after reload: language ${after.lang}, the Análisis tab, mode B`);
    check(after.st.matrix.districts.slice().sort().join() === LIMA_SUR.slice().sort().join() && after.rows === mb.n && after.st.matrix.radius === beforeReload.matrix.radius,
      `after reload: mode B region (Lima Sur) and R kept, recomputed (${after.rows} stores)`);
    check(after.project === beforeReload.project && after.slides === 2 && after.slide && after.slide.analysis.maxMeters === 1000, 'after reload: the project and its two analysis slides are restored (autosave)');
    check(!after.st.ref && !after.st.linked, 'after reload: no reference is restored (per session by design) and no slide link');
    await page.click('.mt-analysis-modes .mt-seg__opt:nth-child(1)');
    await waitFor(() => MT.analysisui.mode() === 'distance');
    await sleep(300);
    const ra = await ev(() => ({ st: MT.analysisui.state(), recent: [...document.querySelectorAll('.mt-analysis-recent__item')].map((b) => b.textContent),
      empty: (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-empty__title') || {}).textContent }));
    check(ra.st.universe.kind === 'distance' && ra.st.universe.meters === 2000 && ra.st.rings.join() === '500,1000,2000',
      `after reload: mode A settings kept (universe ${ra.st.universe.meters} m, rings ${ra.st.rings.join('/')})`);
    check(ra.empty === L('Elige una referencia', 'Choose a reference') && ra.recent.includes('Plaza Vea Miraflores') && ra.recent.includes(L('Local propuesto Kennedy', 'Proposed site Kennedy')),
      `after reload: recent references kept for the session (${ra.recent.join(' · ')})`);
    for (const b of await page.$$('.mt-analysis-recent__item')) {
      if ((await b.evaluate((x) => x.textContent)) === 'Plaza Vea Miraflores') { await b.click(); break; }
    }
    await waitFor(() => MT.analysisui.state().ref && MT.analysisui.state().ref.type === 'store');
    const back = await ev(() => ({ st: MT.analysisui.state(), n: MT.analysisui.results().res.rows.length }));
    check(back.st.ref.storeId === PV && back.n === a2.n, `one click on the recent store → the same ${back.n} stores within 2 km`);
    await anaIdle();
    await shot('05-after-reload');

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

for (const lang of LANGS) await journey(lang);
finish();
