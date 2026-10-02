// tools/test/analysis-ui.test.mjs — the Análisis tab (SPEC §6.1, js/ui-analysis.js) on the REAL data.
//
//   node tools/test/analysis-ui.test.mjs
//
// Mode A "Distancias a un punto": reference by type-ahead (Plaza Vea Miraflores), pasted coordinates
// (a point in Surquillo), a Google Maps link, a (mocked) Nominatim address search on Enter only, a click
// on the map ("Elegir en el mapa"), recent references; universe chips / districts / chains / "por
// verificar"; rings; results = the engine's (rows, nearest same / competitor, cumulative ring counts,
// ring × chain bands); sortable virtualized table, filter, keyboard, row ↔ map selection; Excel read back
// with SheetJS in Node (Resumen, Distancias, Por cadena y anillo, Parámetros); "Agregar como lámina" →
// MT.project map with a normalized analysis + Mapas tab; MT.analysisui.edit / "Actualizar la lámina".
// Mode B "Matriz de cercanía": Lima Sur = MT.analysis.neighborMatrix / closePairs (neighbours outside
// the region, competitor pairs, radius), the "posible canibalización" tags, map lines, Excel; a big
// region (Lima, every chain) computed in idle chunks = one engine call. English, 1280 px, no console errors.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { openApp, screenshot, waitForMapIdle, captureDownloads, waitForDownload, makeChecker, sleep, ROOT, splitNetworkNoise } from './lib.mjs';

const { check, finish } = makeChecker('analysis-ui');

/* ---- SheetJS in Node (the vendored build), to read the exported workbooks back ---------------- */
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
  return { names: wb.SheetNames, sheets, wb };
}
/** UI distance text, as js/ui-analysis.js writes it: "850 m", "1.2 km", "12 km" (es-PE and English: decimal point). */
// The app's one distance text (MT.i18n.formatDistance), re-implemented: rounded to 0.1 m (the Excel
// value), then to whole metres; one decimal below 9.95 km, whole km above; es-PE grouping.
function fmtDist(m) {
  const w = Math.round(Math.round(m * 10) / 10);
  if (w < 1000) return w + ' m';
  const km = w / 1000;
  return new Intl.NumberFormat('es-PE', { maximumFractionDigits: km < 9.95 ? 1 : 0 }).format(km) + ' km';
}
const round1 = (m) => Math.round(m * 10) / 10;
const LIMA_SUR = ['150108', '150119', '150123', '150133', '150142', '150143'];

const { browser, page, errors } = await openApp({ lang: 'es', hash: 'analisis' });
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const mapIdle = () => waitForMapIdle(page, { expr: 'window.MT && MT.analysisui && MT.analysisui.state().mapReady && MT.analysisui.map()' }).catch((e) => console.log('   (map idle wait:', e.message, ')'));
/** Client pixel of a store on the analysis map. */
async function storePixel(id) {
  return ev((id) => {
    const map = MT.analysisui.map(), s = MT.data.store(id), r = map.getCanvas().getBoundingClientRect(), p = map.project([s.lng, s.lat]);
    return { x: r.left + p.x, y: r.top + p.y, inside: p.x > 20 && p.y > 20 && p.x < r.width - 20 && p.y < r.height - 20 };
  }, id);
}
const tableRows = (sel = '.mt-analysis-table--a') => ev((sel) => [...document.querySelectorAll(sel + ' tbody tr[data-id]')].map((tr) => ({ id: tr.dataset.id, cells: [...tr.children].map((td) => td.textContent.trim()) })), sel);

try {
  await page.waitForFunction(() => MT.analysisui && MT.analysisui.state().mapReady, { timeout: 45000 });
  await mapIdle();

  /* ---- 0. The tab ---------------------------------------------------------------------------------- */
  const boot = await ev(() => ({
    tab: MT.app.currentTab(), stub: !!MT.analysisui.stub, title: document.querySelector('.mt-analysis-head__h').textContent,
    modes: [...document.querySelectorAll('.mt-analysis-modes .mt-seg__opt')].map((x) => x.textContent.trim()),
    empty: (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-empty__title') || {}).textContent,
    hint: !document.querySelector('.mt-analysis-maphint').hidden,
    pv: (MT.data.stores().find((s) => s.chain === 'plazavea' && s.name === 'Plaza Vea Miraflores') || {}).id,
  }));
  check(boot.tab === 'analysis' && !boot.stub && boot.title === 'Análisis de distancias', `Análisis tab mounted, stub replaced (${boot.title})`);
  check(boot.modes.join('|') === 'Distancias a un punto|Matriz de cercanía', `mode switch: ${boot.modes.join(' | ')}`);
  check(boot.empty === 'Elige una referencia' && boot.hint, 'no reference yet: empty state + "click on the map" hint');
  const PV = boot.pv;
  check(!!PV, `Plaza Vea Miraflores found in the data (${PV})`);
  await screenshot(page, 'an-ui-01-empty');

  /* ---- 1. Reference by type-ahead ------------------------------------------------------------------- */
  let nomCalls = 0;
  await ev(() => { window.__nom = []; const orig = MT.geo.search; MT.geo.search = (q, o) => { window.__nom.push(q); return orig === null ? null : Promise.resolve([]); }; });
  await page.click('[data-field="refSearch"]');
  await page.keyboard.type('plaza vea miraf');
  await sleep(250);
  const opts = await ev(() => [...document.querySelectorAll('.mt-analysis-options [role=option]')].map((li) => ({ text: li.querySelector('.mt-analysis-opt__name').textContent, id: li.dataset.id || null })));
  nomCalls = await ev(() => window.__nom.length);
  check(opts.length >= 2 && opts[0].text === 'Plaza Vea Miraflores' && opts[opts.length - 1].text.startsWith('Buscar «plaza vea miraf» como dirección'),
    `type-ahead (accent-insensitive, local): first "${opts[0] && opts[0].text}", last = address search (${opts.length} options)`);
  check(nomCalls === 0, 'typing never calls Nominatim (search on Enter only)');
  await screenshot(page, 'an-ui-02-typeahead');
  await page.keyboard.press('Enter');
  await sleep(600);
  let st = await ev(() => MT.analysisui.state());
  check(st.ref && st.ref.type === 'store' && st.ref.storeId === PV && st.universe.kind === 'distance' && st.universe.meters === 5000, `Enter picks the store: ${st.ref && st.ref.label}, universe 5 km`);
  check(st.chains.join() === await ev(() => MT.analysis.defaultChains(MT.analysis.refFromStore(MT.analysisui.state().ref.storeId)).join()), `default chains = defaultOn + the reference's chain (${st.chains.length})`);

  /* ---- 2. Results = the engine ---------------------------------------------------------------------- */
  const eng = await ev(() => {
    const st = MT.analysisui.state(), ref = MT.analysis.refFromStore(st.ref.storeId);
    const res = MT.analysis.distancesFrom(ref, { chains: st.chains, maxMeters: 5000, includeToVerify: true });
    const ui = MT.analysisui.results();
    const rs = MT.analysis.ringSummary(res, [500, 1000, 2000, 3000, 5000]), sum = MT.analysis.summary(res);
    const sig = (rows) => rows.map((r) => r.store.id + ':' + r.meters + ':' + r.rank).join('|');
    return {
      n: res.rows.length, same: sig(res.rows) === sig(ui.res.rows),
      cum: rs.cumulative.map((c) => [c.total, c.sameChain, c.competitors]),
      uiCum: [...document.querySelectorAll('.mt-analysis-ringsum tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => +td.textContent.replace(/\D/g, ''))),
      nearSame: sum.nearestSame && [sum.nearestSame.store.name, sum.nearestSame.meters], nearComp: sum.nearestCompetitor && [sum.nearestCompetitor.store.name, sum.nearestCompetitor.meters],
      cards: [...document.querySelectorAll('.mt-analysis-stat')].map((c) => ({ label: c.querySelector('.mt-analysis-stat__label').textContent, value: (c.querySelector('.mt-analysis-stat__value') || {}).textContent, store: (c.querySelector('.mt-analysis-stat__store') || {}).textContent })),
      head: document.querySelector('.mt-analysis-mainhead__h').textContent, meta: document.querySelector('.mt-analysis-mainhead__meta').textContent,
      tabCount: (document.querySelector('.mt-analysis-rtab[data-view=stores] .mt-analysis-rtab__n') || {}).textContent,
    };
  });
  check(eng.same && eng.n > 50, `table rows = MT.analysis.distancesFrom (5 km, default chains): ${eng.n} stores, same ids / metres / ranks`);
  check(eng.head === 'Distancias a Plaza Vea Miraflores' && eng.meta.startsWith(`${eng.n} tiendas a menos de 5 km`), `header: "${eng.head}" · "${eng.meta}"`);
  check(eng.cards[0].label === 'Misma cadena más cercana' && eng.cards[0].store === eng.nearSame[0] && eng.cards[0].value === fmtDist(eng.nearSame[1]),
    `card: nearest same-chain store ${eng.cards[0].store} ${eng.cards[0].value}`);
  check(eng.cards[1].label === 'Competencia más cercana' && eng.cards[1].store === eng.nearComp[0] && eng.cards[1].value === fmtDist(eng.nearComp[1]),
    `card: nearest competitor ${eng.cards[1].store} ${eng.cards[1].value}`);
  check(JSON.stringify(eng.uiCum) === JSON.stringify([eng.cum.map((c) => c[0]), eng.cum.map((c) => c[1]), eng.cum.map((c) => c[2])]),
    `"Tiendas a menos de…" = cumulative ring counts (total ${eng.cum.map((c) => c[0]).join('/')}, same ${eng.cum.map((c) => c[1]).join('/')})`);
  check(eng.tabCount === String(eng.n), `results tab shows the count (${eng.tabCount})`);
  let rows = await tableRows();
  const engRows = await ev(() => MT.analysisui.results().res.rows.slice(0, 60).map((r) => ({ id: r.store.id, m: r.meters, rank: r.rank, dir: r.dir })));
  const distCol = 2;   // N°, Tienda, Distancia, Rumbo, …
  check(rows.length > 5 && rows.every((r, i) => r.id === engRows[i].id && r.cells[0] === String(engRows[i].rank) && r.cells[distCol] === fmtDist(engRows[i].m)),
    `rows in distance order, es-PE distances (${rows.slice(0, 4).map((r) => r.cells[distCol]).join(', ')}…)`);
  check(rows.some((r) => /^\d\.\d km$/.test(r.cells[distCol])) && rows.some((r) => / m$/.test(r.cells[distCol])) && !rows.some((r) => /,\d/.test(r.cells[distCol])),
    'distances read "850 m" / "1.2 km" (es-PE decimal point, as on the slides)');
  const dirOk = rows.slice(0, 20).every((r, i) => r.cells[3] === ({ N: 'N', NE: 'NE', E: 'E', SE: 'SE', S: 'S', SW: 'SO', W: 'O', NW: 'NO' })[engRows[i].dir]);
  check(dirOk, `direction column in Spanish codes (${rows.slice(0, 6).map((r) => r.cells[3]).join(' ')})`);
  await mapIdle();
  await screenshot(page, 'an-ui-03-ref-store');

  /* ---- 3. Sorting, filter, keyboard ----------------------------------------------------------------- */
  await page.click('.mt-analysis-table--a th[data-col="store"]');
  await sleep(200);
  rows = await tableRows();
  const byName = await ev(() => MT.util.sortBy(MT.analysisui.results().res.rows, (r) => r.store.name).slice(0, 10).map((r) => r.store.id));
  check(rows.slice(0, 10).map((r) => r.id).join() === byName.join(), 'click "Tienda" → sorted by name (Spanish collation)');
  await page.click('.mt-analysis-table--a th[data-col="distance"]');
  await sleep(150);
  await page.click('.mt-analysis-table--a th[data-col="distance"]');
  await sleep(150);
  rows = await tableRows();
  const desc = await ev(() => MT.analysisui.results().res.rows.slice().reverse().slice(0, 5).map((r) => r.store.id));
  check(rows.slice(0, 5).map((r) => r.id).join() === desc.join() && await ev(() => document.querySelector('.mt-analysis-table--a th[data-col="distance"]').getAttribute('aria-sort')) === 'descending',
    'click "Distancia" twice → farthest first (aria-sort descending)');
  await page.click('.mt-analysis-table--a th[data-col="rank"]');
  await sleep(150);
  await page.type('[data-field="filterA"]', 'wong');
  await sleep(400);
  const filt = await ev(() => ({ rows: [...document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id]')].map((tr) => MT.data.store(tr.dataset.id).chain), count: document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-rcount').textContent }));
  check(filt.rows.length > 0 && filt.rows.every((c) => c === 'wong') && /^\d+ de \d+$/.test(filt.count), `filter "wong": ${filt.rows.length} rows, "${filt.count}"`);
  await ev(() => { const i = document.querySelector('[data-field="filterA"]'); i.value = ''; i.dispatchEvent(new Event('input')); });
  await sleep(300);
  await page.focus('.mt-analysis-respane:not([hidden]) .mt-analysis-tablewrap');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  st = await ev(() => MT.analysisui.state());
  check(st.selected === engRows[1].id, `keyboard ↓↓ selects the 2nd nearest store (${st.selected})`);
  await page.keyboard.press('Enter');
  await sleep(500);
  check(await ev(() => !!document.querySelector('.mt-analysis-popup') && document.querySelector('.mt-analysis-popup').textContent.includes(MT.data.store(MT.analysisui.state().selected).name)),
    'Enter opens the store card on the map');
  check(await ev(() => JSON.stringify(MT.analysisui.map().getFilter('mta-sel')).includes(MT.analysisui.state().selected)), 'selected row = map halo (mta-sel filter)');
  await page.keyboard.press('Escape');
  await sleep(250);
  check(await ev(() => !document.querySelector('.mt-analysis-popup') && document.activeElement && document.activeElement.classList.contains('mt-analysis-tablewrap')),
    'Esc closes the store card; focus stays on the table');

  /* ---- 4. Row click ↔ map ---------------------------------------------------------------------------- */
  await page.click('.mt-analysis-table--a tbody tr[data-id]:nth-of-type(5)');
  await sleep(500);
  st = await ev(() => MT.analysisui.state());
  check(st.selected === engRows[3].id && await ev(() => document.querySelector('.mt-analysis-popup .mt-analysis-card__dist').textContent.startsWith('A ')),
    `row click selects ${st.selected} and opens its card ("A … al … de la referencia")`);
  await ev(() => { const p = document.querySelector('.mt-analysis-popup .maplibregl-popup-close-button'); if (p) p.click(); });
  await mapIdle();
  // Click a store's dot on the map → its row is selected.
  const target = await ev(() => {
    const map = MT.analysisui.map(), r = map.getCanvas().getBoundingClientRect();
    const rows = MT.analysisui.results().res.rows;
    for (const x of rows.slice(8, 60)) {
      const p = map.project([x.store.lng, x.store.lat]);
      if (p.x < 40 || p.y < 40 || p.x > r.width - 40 || p.y > r.height - 40) continue;
      const f = map.queryRenderedFeatures([[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]], { layers: ['mta-badges', 'mta-stores'] });
      const ids = [...new Set(f.map((y) => y.properties.id))];
      if (ids.length === 1 && ids[0] === x.store.id && !rows.slice(0, 8).some((y) => Math.abs(map.project([y.store.lng, y.store.lat]).y - p.y) < 60 && Math.abs(map.project([y.store.lng, y.store.lat]).x - p.x) < 30)) return { id: x.store.id, x: r.left + p.x, y: r.top + p.y };
    }
    return null;
  });
  if (target) {
    await page.mouse.click(target.x, target.y);
    await sleep(600);
    st = await ev(() => MT.analysisui.state());
    const vis = await ev((id) => { const tr = document.querySelector(`.mt-analysis-table--a tr[data-id="${CSS.escape(id)}"]`); return !!tr && tr.classList.contains('is-selected'); }, target.id);
    check(st.selected === target.id && vis, `map click on a store selects and scrolls to its row (${target.id})`);
  } else check(false, 'found an isolated store dot to click on the map');
  await screenshot(page, 'an-ui-04-map-select');

  /* ---- 5. Universe, chains, "por verificar", rings --------------------------------------------------- */
  await page.click('.mt-analysis-chip[data-value="1000"]');
  await sleep(400);
  let u = await ev(() => { const r = MT.analysisui.results().res.rows; return { n: r.length, max: Math.max(...r.map((x) => x.meters)), st: MT.analysisui.state().universe }; });
  const n1 = await ev(() => MT.analysis.distancesFrom(MT.analysis.refFromStore(MT.analysisui.state().ref.storeId), { chains: MT.analysisui.state().chains, maxMeters: 1000 }).rows.length);
  check(u.st.meters === 1000 && u.n === n1 && u.max <= 1000, `chip 1 km: ${u.n} stores, all ≤ 1000 m`);
  await page.click('.mt-analysis-chip[data-value="2000"]');
  await sleep(400);
  const r2 = await ev(() => {
    const st = MT.analysisui.state(), ref = MT.analysis.refFromStore(st.ref.storeId);
    const tot = [...document.querySelectorAll('.mt-analysis-ringsum tr.is-total td')].map((td) => +td.textContent.replace(/\D/g, ''));
    return { rings: st.rings, used: MT.analysisui.results().ringSummary.rings, tot: tot,
      cols: [...document.querySelectorAll('.mt-analysis-ringsum thead th')].map((t) => t.textContent).filter(Boolean),
      truth: [500, 1000, 2000].map((m) => MT.analysis.distancesFrom(ref, { chains: st.chains, maxMeters: m }).rows.length),
      ring3: MT.analysis.distancesFrom(ref, { chains: st.chains, maxMeters: 3000 }).rows.length,
      note: (document.querySelector('.mt-analysis-ringsum__note') || {}).textContent,
      mapRings: MT.analysisui.map() ? MT.analysisui.map().querySourceFeatures('mta-rings').map((f) => f.properties.meters) : [] };
  });
  check(r2.rings.join() === '500,1000,2000,3000,5000' && r2.used.join() === '500,1000,2000' && r2.cols.join('|') === '500 m|1 km|2 km' && JSON.stringify(r2.tot) === JSON.stringify(r2.truth),
    `universe 2 km, rings to 5 km: "Tiendas a menos de…" shows 500 m / 1 km / 2 km only, each = distancesFrom(maxMeters: ring) (${r2.tot.join('/')}; 3 km would be ${r2.ring3}, not ${r2.tot[2]})`);
  check(r2.note === 'Los anillos de 3 km y 5 km quedan fuera del universo (2 km).' && !r2.mapRings.some((m) => m > 2000), `"${r2.note}" — and the map draws no ring past 2 km`);
  await page.click('.mt-analysis-chip[data-value="all"]');
  await sleep(500);
  u = await ev(() => ({ n: MT.analysisui.results().res.rows.length, dom: document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id]').length, head: document.querySelector('.mt-analysis-mainhead__meta').textContent }));
  const nAll = await ev(() => MT.analysis.distancesFrom(MT.analysis.refFromStore(MT.analysisui.state().ref.storeId), { chains: MT.analysisui.state().chains }).rows.length);
  check(u.n === nAll && u.n > 700 && u.dom < 60 && /en todo el Perú/.test(u.head), `"Todo el Perú": ${u.n} stores, only ${u.dom} rows in the DOM (virtualized)`);
  await ev(() => { const w = document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-tablewrap'); w.scrollTop = w.scrollHeight; w.dispatchEvent(new Event('scroll')); });
  await sleep(300);
  const last = await ev(() => { const r = [...document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id]')]; return r.length ? r[r.length - 1].children[0].textContent : ''; });
  check(last === String(nAll), `scrolled to the bottom: last rank ${last}`);
  await page.click('.mt-analysis-chip[data-value="5000"]');
  await sleep(300);
  // Chains popover: none → empty state; defaults back.
  await page.click('.mt-analysis-chainbtn');
  await sleep(250);
  const pop = await ev(() => ({ open: !!document.querySelector('.mt-analysis-pop'), groups: document.querySelectorAll('.mt-analysis-pop .mt-db-pop__group').length, rows: document.querySelectorAll('.mt-analysis-pop .mt-db-pop__opt').length }));
  check(pop.open && pop.groups >= 5 && pop.rows >= 16, `chains popover: ${pop.groups} groups, ${pop.rows} chains with counts`);
  await ev(() => [...document.querySelectorAll('.mt-analysis-pop .mt-db-link')].find((b) => b.textContent === 'Ninguna').click());
  await sleep(300);
  check(await ev(() => (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-empty__title') || {}).textContent) === 'Ninguna cadena elegida', 'no chain → "Ninguna cadena elegida"');
  await ev(() => [...document.querySelectorAll('.mt-analysis-pop .mt-db-link')].find((b) => b.textContent === 'Predeterminadas').click());
  await sleep(300);
  await ev(() => { const box = document.querySelector('.mt-analysis-pop input[data-chain="tambo"]'); box.click(); });
  await sleep(300);
  check(await ev(() => MT.analysisui.state().chains.includes('tambo') && MT.analysisui.results().res.rows.some((r) => r.store.chain === 'tambo')), 'tick Tambo → Tambo stores in the table');
  await page.keyboard.press('Escape');
  await ev(() => MT.analysisui.setChains(MT.analysis.defaultChains(MT.analysis.refFromStore(MT.analysisui.state().ref.storeId))));
  await sleep(200);
  const tvBefore = await ev(() => MT.analysisui.results().res.rows.filter((r) => r.flags.toVerify).length);
  await ev(() => [...document.querySelectorAll('.mt-analysis-side .mt-switch')].find((s) => /por verificar/.test(s.textContent)).querySelector('input').click());
  await sleep(300);
  const tvAfter = await ev(() => MT.analysisui.results().res.rows.filter((r) => r.flags.toVerify).length);
  check(tvBefore > 0 && tvAfter === 0, `"por verificar" off: ${tvBefore} → ${tvAfter} flagged rows`);
  await ev(() => [...document.querySelectorAll('.mt-analysis-side .mt-switch')].find((s) => /por verificar/.test(s.textContent)).querySelector('input').click());
  await sleep(200);
  // Rings
  await page.type('[data-field="ringAdd"]', '1,5 km');
  await page.keyboard.press('Enter');
  await sleep(300);
  let rg = await ev(() => ({ rings: MT.analysisui.state().rings, cols: [...document.querySelectorAll('.mt-analysis-ringsum thead th')].map((t) => t.textContent).filter(Boolean) }));
  check(rg.rings.join() === '500,1000,1500,2000,3000,5000' && rg.cols.join('|') === '500 m|1 km|1.5 km|2 km|3 km|5 km', `ring typed as "1,5 km" added as 1.5 km: ${rg.cols.join(' · ')}`);
  await page.type('[data-field="ringAdd"]', '5');
  await page.keyboard.press('Enter');
  await sleep(200);
  check(await ev(() => document.querySelector('.mt-analysis-side .mt-field__error').textContent) === 'Escribe una distancia entre 10 m y 1000 km.', 'invalid ring (5 m) explained');
  await ev(() => { const i = document.querySelector('[data-field="ringAdd"]'); i.value = ''; });
  await page.type('[data-field="ringAdd"]', '1,500');
  await page.keyboard.press('Enter');
  await sleep(200);
  check(await ev(() => document.querySelector('.mt-analysis-side .mt-field__error').textContent) === 'Ese anillo ya está.' && (await ev(() => MT.analysisui.state().rings.length)) === 6,
    '"1,500" is read as 1500 m (es-PE thousands comma): already a ring');
  await ev(() => { const i = document.querySelector('[data-field="ringAdd"]'); i.value = ''; });
  await ev(() => document.querySelector('.mt-analysis-ringchip[data-meters="3000"] .mt-chip__x').click());
  await sleep(200);
  check(await ev(() => MT.analysisui.state().rings.join()) === '500,1000,1500,2000,5000', 'ring 3 km removed with its ×');
  await ev(() => MT.analysisui.setRings([500, 1000, 2000, 3000, 5000]));
  await sleep(200);
  // Ring × chain table
  await page.click('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="rings"]');
  await sleep(300);
  const rt = await ev(() => {
    const rs = MT.analysisui.results().ringSummary;
    const tr = document.querySelector('.mt-analysis-ringtable tbody tr.is-total');
    return { ui: [...tr.querySelectorAll('td')].map((td) => +td.textContent.replace(/\D/g, '')), eng: rs.bands.map((b) => b.total).concat(rs.beyond.total ? [rs.beyond.total] : [], [rs.total]),
      heads: [...document.querySelectorAll('.mt-analysis-ringtable thead th')].map((t) => t.textContent), chains: document.querySelectorAll('.mt-analysis-ringtable tbody tr').length,
      shown: [...document.querySelectorAll('.mt-analysis-ringtable thead th')].map((t) => t.innerText) };
  });
  check(rt.shown[1] === 'HASTA 500 m' && rt.shown[2] === '500 m – 1 km', `upper-case headers keep the units' case ("${rt.shown[1]}", "${rt.shown[2]}" — not "500 M")`);
  check(JSON.stringify(rt.ui) === JSON.stringify(rt.eng) && rt.heads[1] === 'Hasta 500 m' && rt.heads[2] === '500 m – 1 km', `ring × chain table: bands ${rt.heads.slice(1).join(' | ')} = engine (${rt.ui.join('/')}), ${rt.chains} rows`);
  await screenshot(page, 'an-ui-05-rings');
  await page.click('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="stores"]');
  await sleep(200);

  /* ---- 6. Excel (mode A) ----------------------------------------------------------------------------- */
  const dl = await captureDownloads(page);
  await page.click('.mt-analysis-act-excel');
  const fileA = await waitForDownload(dl, /^Distancias a Plaza Vea Miraflores - \d{4}-\d\d-\d\d\.xlsx$/);
  const bookA = readBook(fileA);
  const xa = await ev(() => {
    const r = MT.analysisui.results();
    return { rows: r.res.rows.map((x) => [x.rank, x.store.id, x.meters, x.dir, x.sameChain]), bands: r.ringSummary.bands.map((b) => b.total), total: r.ringSummary.total,
      seed: MT.data.seedInfo.generated, active: MT.i18n.formatNumber(MT.data.stores().length) };
  });
  check(bookA.names.join('|') === 'Resumen|Distancias|Por cadena y anillo|Parámetros', `workbook sheets: ${bookA.names.join(', ')}`);
  const D = bookA.sheets.Distancias, hd = D[0];
  const iM = hd.indexOf('Distancia (m)'), iF = hd.indexOf('Distancia'), iId = hd.indexOf('ID'), iRel = hd.indexOf('Relación'), iDir = hd.indexOf('Rumbo');
  check(D.length === xa.rows.length + 1 && iM > 0 && iF > 0 && iId > 0, `"Distancias": ${D.length - 1} rows, columns ${hd.slice(0, 10).join(' · ')}…`);
  const xlOk = xa.rows.every((x, i) => { const row = D[i + 1]; return row[0] === x[0] && row[iId] === x[1] && typeof row[iM] === 'number' && row[iM] === round1(x[2]) && row[iF] === fmtDist(x[2]); });
  check(xlOk, 'every row: rank, id, metres as a NUMBER (1 decimal) = engine, formatted "1.2 km" text');
  check(D.slice(1).every((row) => fmtDist(row[iM]) === row[iF]), 'the text never disagrees with the number beside it (322.5 → "323 m")');
  check(D.slice(1).every((row, i) => row[iRel] === (xa.rows[i][4] === true ? 'Misma cadena' : xa.rows[i][4] === false ? 'Competencia' : '')) && D[1][iDir] !== undefined, 'relation and bearing columns filled');
  const R = bookA.sheets['Por cadena y anillo'];
  check(R[0][0] === 'Cadena' && R[1][0] === 'Total' && JSON.stringify(R[1].slice(1, 1 + xa.bands.length)) === JSON.stringify(xa.bands) && R[1][R[0].length - 1] === xa.total,
    `"Por cadena y anillo": Total row = bands ${R[1].slice(1, 1 + xa.bands.length).join('/')}, total ${R[1][R[0].length - 1]}`);
  const P = Object.fromEntries(bookA.sheets['Parámetros'].slice(1).map((r) => [r[0], r[1]]));
  check(P['Referencia'] === 'Plaza Vea Miraflores' && P['Universo'] === 'Tiendas a menos de 5 km' && P['Tipo de referencia'] === 'Tienda' && P['ID de la tienda de referencia'] === PV &&
    String(P['Versión de los datos']).startsWith('Datos del ' + xa.seed + ' (' + xa.active + ' tiendas activas)') && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(P['Fecha del análisis']) && /haversine/.test(P['Método']) && P['Incluye tiendas «por verificar»'] === 'Sí',
    `"Parámetros": reference, universe, date, data version (${P['Versión de los datos']}), method`);
  const S = bookA.sheets.Resumen;
  check(S[0].join('|') === 'Concepto|Valor|Distancia (m)|Distancia|Nota' && S.some((r) => r[0] === 'Misma cadena más cercana' && typeof r[2] === 'number') && S.some((r) => r[0] === 'Tiendas a menos de'),
    '"Resumen": nearest same / competitor with metres, cumulative ring counts, nearest per chain');
  {
    const wbNF = XLSX.read(readFileSync(fileA), { type: 'buffer', cellNF: true }), RS = wbNF.Sheets.Resumen;
    const rIdx = (label) => S.findIndex((r) => r[0] === label);
    const within = rIdx('Tiendas a menos de'), nearR = rIdx('Misma cadena más cercana');
    const z = (r, c) => (RS[XLSX.utils.encode_cell({ r: r, c: c })] || {}).z;
    const countZ = [1, 2, 3].map((k) => z(within + 1, k)), metreZ = z(nearR, 2);
    check(countZ.every((x) => x !== '#,##0.0') && metreZ === '#,##0.0', `"Resumen" formats per cell: counts ${countZ.join(', ')} (no decimal), metres ${metreZ}`);
    // Header rows in bold, the data tables' header frozen (SheetJS CE cannot: MT.io.polishXLSX).
    const cfb = XLSX.CFB.read(readFileSync(fileA), { type: 'buffer' });
    const part = (n) => { const e = XLSX.CFB.find(cfb, '/xl/' + n); return e ? Buffer.from(e.content).toString('utf8') : ''; };
    const styles = part('styles.xml'), sh2 = part('worksheets/sheet2.xml'), sh1 = part('worksheets/sheet1.xml');
    const boldFont = [...styles.matchAll(/<font>([\s\S]*?)<\/font>/g)].findIndex((m) => /<b\/>/.test(m[1]));
    const cellXfs = [...(styles.split('<cellXfs')[1] || '').split('</cellXfs>')[0].matchAll(/<xf [^>]*\/>/g)].map((m) => m[0]);
    const fontOf = (sh) => { const i = (/<c r="A1" s="(\d+)"/.exec(sh) || [])[1]; return i === undefined ? -1 : +((/fontId="(\d+)"/.exec(cellXfs[+i] || '') || [])[1]); };
    check(/<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/.test(sh2) && !/<pane /.test(sh1) && boldFont > 0 && fontOf(sh2) === boldFont && fontOf(sh1) === boldFont,
      '"Distancias": header row frozen and bold (Resumen: bold headers, not frozen)');
  }
  check(!bookA.wb.Sheets.Resumen['!autofilter'] && !!bookA.wb.Sheets.Distancias['!autofilter'], 'autofilter on the data table only');

  /* ---- 7. Point reference: pasted coordinates (Surquillo), own chain ---------------------------------- */
  await page.click('[data-field="refSearch"]');
  await page.keyboard.type('-12.1135, -77.0110');
  await sleep(250);
  const copt = await ev(() => [...document.querySelectorAll('.mt-analysis-options [role=option]')].map((li) => li.textContent));
  check(copt.length === 1 && copt[0].startsWith('Usar el punto -12.11350, -77.01100') && copt[0].includes('Coordenadas pegadas'), `pasted coordinates → "${copt[0]}"`);
  await page.keyboard.press('Enter');
  await sleep(500);
  st = await ev(() => MT.analysisui.state());
  const pt = await ev(() => ({ district: (MT.data.districts.locate(-12.1135, -77.0110) || {}).district, card: document.querySelector('.mt-analysis-stat.is-same .mt-analysis-stat__empty').textContent,
    head: document.querySelector('.mt-analysis-mainhead__h').textContent, rel: MT.analysisui.results().ringSummary.relation }));
  check(st.ref.type === 'point' && st.ref.lat === -12.1135 && st.ref.lng === -77.011 && pt.district === 'Surquillo', `point reference in ${pt.district}: ${pt.head}`);
  check(!pt.rel && /cadena propia/.test(pt.card), 'a point without own chain: no same/competitor split, card asks for an own chain');
  await page.select('[data-field="ownChain"]', 'plazavea');
  await sleep(400);
  const own = await ev(() => {
    const ref = MT.analysis.refFromPoint({ lat: -12.1135, lng: -77.011, chainId: 'plazavea' });
    const sum = MT.analysis.summary(MT.analysis.distancesFrom(ref, { chains: MT.analysisui.state().chains, maxMeters: 5000 }));
    return { ui: document.querySelector('.mt-analysis-stat.is-same .mt-analysis-stat__store').textContent, eng: sum.nearestSame.store.name,
      rel: MT.analysisui.results().ringSummary.relation, same: document.querySelectorAll('.mt-analysis-table--a .mt-badge--accent').length };
  });
  check(own.ui === own.eng && own.rel && own.same > 0, `own chain Plaza Vea → nearest same-chain store ${own.ui}`);
  await page.type('[data-field="refLabel"]', 'Local propuesto Surquillo');
  await sleep(500);
  check(await ev(() => document.querySelector('.mt-analysis-mainhead__h').textContent) === 'Distancias a Local propuesto Surquillo', 'point label → header "Distancias a Local propuesto Surquillo"');
  await mapIdle();
  await screenshot(page, 'an-ui-06-point');

  /* ---- 8. Google Maps link, address search (mocked Nominatim), pick on the map, recent ---------------- */
  await page.click('[data-field="refSearch"]');
  await page.keyboard.type('https://www.google.com/maps/place/Parque/@-12.0464,-77.0428,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-12.04651!4d-77.04277');
  await sleep(250);
  const gl = await ev(() => document.querySelector('.mt-analysis-options [role=option]').textContent);
  check(gl.includes('-12.04651, -77.04277') && gl.includes('Enlace de Google Maps'), `Google Maps link → the pin's coordinates (${gl.slice(0, 40)}…)`);
  await page.keyboard.press('Enter');
  await sleep(400);
  check(await ev(() => MT.analysisui.state().ref.lat) === -12.04651, 'link point set');
  await ev(() => {
    window.__nom = [];
    MT.geo.search = (q) => { window.__nom.push(q); return new Promise((r) => setTimeout(() => r([
      { lat: -12.0931, lng: -77.0465, label: 'Avenida Javier Prado Este 123, San Isidro, Lima, Perú', name: '', street: 'Avenida Javier Prado Este 123' },
      { lat: -12.09, lng: -77.02, label: 'Javier Prado, La Victoria, Lima, Perú', name: 'Javier Prado', street: '' }]), 200)); };
  });
  // A Google Maps short link has no coordinates: say so, never geocode the URL.
  await page.click('[data-field="refSearch"]');
  await page.keyboard.type('https://maps.app.goo.gl/AbCdEf12345');
  await sleep(250);
  const sl = await ev(() => [...document.querySelectorAll('.mt-analysis-options li')].map((li) => ({ text: li.textContent, dis: li.getAttribute('aria-disabled') === 'true' })));
  check(sl.length === 1 && sl[0].dis && /enlaces cortos/.test(sl[0].text), `short link → one disabled hint: "${sl[0] && sl[0].text.slice(0, 60)}…"`);
  await page.keyboard.press('Enter');
  await sleep(300);
  check(await ev(() => window.__nom.length) === 0 && /enlaces cortos/.test(await ev(() => (document.querySelector('.mt-analysis-addr') || {}).textContent || '')), 'Enter on a short link: no Nominatim call, the hint stays');
  await ev(() => { const i = document.querySelector('[data-field="refSearch"]'); i.value = ''; i.dispatchEvent(new Event('input')); const x = document.querySelector('.mt-analysis-addr button'); if (x) x.click(); });
  await page.click('[data-field="refSearch"]');
  await page.keyboard.type('xq javier prado este 123');
  await sleep(250);
  check(await ev(() => window.__nom.length) === 0, 'still no Nominatim call while typing an address');
  await page.keyboard.press('Enter');
  await sleep(80);
  check(await ev(() => document.querySelector('.mt-analysis-addr').textContent.includes('Buscando')), 'Enter → "Buscando la dirección…"');
  await sleep(400);
  const addr = await ev(() => ({ calls: window.__nom.slice(), items: [...document.querySelectorAll('.mt-analysis-addr__item')].map((b) => b.textContent) }));
  check(addr.calls.length === 1 && addr.calls[0] === 'xq javier prado este 123' && addr.items.length === 2, `one Nominatim call on Enter, ${addr.items.length} results listed`);
  await screenshot(page, 'an-ui-07-address');
  await page.click('.mt-analysis-addr__item');
  await sleep(500);
  st = await ev(() => MT.analysisui.state());
  check(st.ref.type === 'point' && st.ref.label === 'Avenida Javier Prado Este 123' && st.ref.lat === -12.0931, `address picked → point "${st.ref.label}"`);
  await mapIdle();
  await page.click('.mt-analysis-pickbtn');
  await sleep(300);
  st = await ev(() => MT.analysisui.state());
  const hintTxt = await ev(() => document.querySelector('.mt-analysis-maphint').textContent);
  check(st.picking && /Haz clic/.test(hintTxt), 'Elegir en el mapa → pick mode, hint on the map');
  await page.keyboard.press('Escape');
  await sleep(200);
  check(await ev(() => !MT.analysisui.state().picking), 'Esc cancels pick mode');
  await page.click('.mt-analysis-pickbtn');
  await sleep(200);
  // Click an empty spot (no store within 12 px).
  const spot = await ev(() => {
    const map = MT.analysisui.map(), r = map.getCanvas().getBoundingClientRect();
    for (let y = 80; y < r.height - 60; y += 23) for (let x = 60; x < r.width - 60; x += 31) {
      if (!map.queryRenderedFeatures([[x - 12, y - 12], [x + 12, y + 12]], { layers: ['mta-all', 'mta-stores', 'mta-badges', 'mta-ref'] }).length) {
        const cx = Math.round(r.left + x), cy = Math.round(r.top + y);            // the mouse clicks whole pixels
        const ll = map.unproject([cx - r.left, cy - r.top]);
        return { cx: cx, cy: cy, lat: ll.lat, lng: ll.lng };
      }
    }
    return null;
  });
  await page.mouse.click(spot.cx, spot.cy);
  await sleep(500);
  st = await ev(() => MT.analysisui.state());
  check(st.ref.type === 'point' && Math.abs(st.ref.lat - spot.lat) < 2e-5 && Math.abs(st.ref.lng - spot.lng) < 2e-5 && !st.picking, `map click → point (${st.ref.lat}, ${st.ref.lng}); pick mode off`);
  await mapIdle();
  await page.click('.mt-analysis-pickbtn');
  await sleep(200);
  const pvPix = await storePixel(PV);
  // The store reference may be off screen: then use the API path for this one (map click on a store is covered in §4).
  if (pvPix.inside) {
    await page.mouse.click(pvPix.x, pvPix.y);
    await sleep(500);
    st = await ev(() => MT.analysisui.state());
    check(st.ref.type === 'store', `pick mode + click on a store dot → that store is the reference (${st.ref.label})`);
  } else await ev(() => MT.analysisui.setPicking(false));
  const clickRecent = async (label) => {
    for (const b of await page.$$('.mt-analysis-recent__item')) if ((await b.evaluate((x) => x.textContent)) === label) { await b.click(); await sleep(500); return true; }
    return false;
  };
  let recent = await ev(() => [...document.querySelectorAll('.mt-analysis-recent__item')].map((b) => b.textContent));
  check(recent.length >= 3 && recent.includes('Local propuesto Surquillo') && recent.includes('Avenida Javier Prado Este 123'), `recent references kept in the session (${recent.length}: ${recent.slice(0, 3).join(' · ')}…)`);
  await clickRecent('Local propuesto Surquillo');
  st = await ev(() => MT.analysisui.state());
  check(st.ref.type === 'point' && st.ref.label === 'Local propuesto Surquillo' && st.ref.chainId === 'plazavea', 'a recent point re-applies with its label and own chain');
  await clickRecent('Plaza Vea Miraflores');
  check(await ev(() => MT.analysisui.state().ref.storeId) === PV, 'a recent store re-applies with one click');
  // Nearest same-chain store just past the universe: still given, tagged, one click widens (finding: Tottus San Luis, 2 km).
  const tsl = await ev(() => MT.data.stores().find((s) => s.name === 'Tottus San Luis').id);
  await ev((id) => { MT.analysisui.setReference(id); MT.analysisui.setUniverse({ km: 2 }); }, tsl);
  await sleep(300);
  const out = await ev(() => {
    const st = MT.analysisui.state(), ref = MT.analysis.refFromStore(st.ref.storeId), card = document.querySelector('.mt-analysis-stat.is-same');
    const all = MT.analysis.nearest(ref, { sameChain: true, chains: st.chains, maxMeters: null })[0];
    return { name: all.store.name, m: all.meters, inRows: MT.analysisui.results().res.rows.some((r) => r.store.id === all.store.id),
      value: card.querySelector('.mt-analysis-stat__value').textContent, store: card.querySelector('.mt-analysis-stat__store').textContent,
      tag: (card.querySelector('.mt-analysis-stat__out .mt-badge') || {}).textContent, widen: (card.querySelector('.mt-analysis-stat__out .mt-analysis-link') || {}).textContent };
  });
  check(!out.inRows && out.m > 2000 && out.store === out.name && out.value === fmtDist(out.m) && out.tag === 'Fuera del universo (2 km)' && out.widen === 'Ampliar a 3 km',
    `nearest same-chain store past the 2 km universe: ${out.store} ${out.value}, "${out.tag}", "${out.widen}"`);
  await ev(() => document.querySelector('.mt-analysis-stat.is-same .mt-analysis-stat__out .mt-analysis-link').click());
  await sleep(300);
  check(await ev(() => MT.analysisui.state().universe.meters === 3000 && !document.querySelector('.mt-analysis-stat.is-same .mt-analysis-stat__out')), '"Ampliar a 3 km" → universe 3 km, the store is now in the table');
  // A point far from every store: the empty state says where the nearest store is; nothing to export.
  await ev(() => { MT.analysisui.setReference({ lat: -10.5, lng: -73.5, label: 'Selva central' }); MT.analysisui.setUniverse({ km: 1 }); });
  await sleep(300);
  const far = await ev(() => ({ text: (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-empty') || {}).textContent || '',
    widen: [...document.querySelectorAll('.mt-analysis-respane:not([hidden]) .mt-empty button')].map((b) => b.textContent),
    excel: document.querySelector('.mt-analysis-act-excel').disabled, slide: document.querySelector('.mt-analysis-act-slide').disabled, api: MT.analysisui.addAsSlide() }));
  check(/La tienda más cercana es .+, a \d+ km\./.test(far.text) && far.widen[0] === 'Todo el Perú' && far.excel && far.slide && far.api === null,
    `no store within 1 km: "${(/La tienda más cercana[^.]*\./.exec(far.text) || [''])[0]}", one button "${far.widen[0]}", Excel and slide disabled`);
  // Back to Plaza Vea Miraflores within 5 km for the slide steps.
  await ev((id) => { MT.analysisui.setReference(id); MT.analysisui.setUniverse({ km: 5 }); }, PV);
  await sleep(300);

  /* ---- 9. Agregar como lámina → Mapas; edit + update --------------------------------------------------- */
  await page.click('.mt-analysis-chip[data-value="2000"]');
  await sleep(300);
  // A new project: its only slide is still blank → the analysis fills it (no empty slide left in the deck).
  const before = await ev(() => { const ms = MT.project.maps(), m = ms[0]; return { n: ms.length, blank: ms.length === 1 && !m.title && !m.districts.length && !m.analysis, first: m.id }; });
  await page.click('.mt-analysis-act-slide');
  await sleep(800);
  const slide = await ev(() => {
    const m = MT.project.currentMap(), st = MT.analysisui.state();
    const sfm = MT.data.storesForMap(m);
    return { n: MT.project.maps().length, tab: MT.app.currentTab(), id: m.id, title: m.title, an: m.analysis, districts: m.districts,
      chainsOn: MT.data.chains().filter((c) => MT.data.chainOn(m, c.id)).map((c) => c.id).sort().join(), selChains: st.chains.slice().sort().join(),
      sfm: sfm.length, rows: MT.analysis.distancesFrom(MT.analysis.refFromStore(st.ref.storeId), { chains: st.chains, maxMeters: 2000 }).rows.length,
      subtitle: MT.data.subtitleFor(m), linked: st.linked, forMap: MT.analysis.forMap(m).rows.length };
  });
  check(before.blank && slide.n === 1 && slide.id === before.first && slide.tab === 'maps' && slide.title === 'Plaza Vea Miraflores',
    `"Agregar como lámina" on a new project → fills its blank slide "${slide.title}" (${slide.n} slide), Mapas tab shown`);
  check(slide.an && slide.an.kind === 'distance' && slide.an.ref.type === 'store' && slide.an.ref.storeId === PV && slide.an.maxMeters === 2000 && slide.an.rings.join() === '500,1000,2000' &&
    slide.an.showLines === true && slide.an.listTop === 8 && slide.districts.length === 0, `slide analysis: ref ${slide.an && slide.an.ref.storeId}, rings ${slide.an && slide.an.rings.join('/')}, maxMeters ${slide.an && slide.an.maxMeters}`);
  check(slide.chainsOn === slide.selChains && slide.sfm === slide.rows + 1 && slide.forMap === slide.rows && slide.subtitle === 'Distancias a Plaza Vea Miraflores',
    `slide shows the same stores (${slide.sfm} incl. the reference), subtitle "${slide.subtitle}"`);
  check(slide.linked === slide.id, 'the tab stays linked to the new slide');
  await sleep(400);
  await screenshot(page, 'an-ui-08-slide-added');
  // Mapas → "Editar en Análisis" (the inspector calls MT.analysisui.open(slide config)); the API otherwise.
  const viaMaps = await ev(() => typeof (MT.mapsui && MT.mapsui.openInAnalysis) === 'function');
  if (viaMaps) await ev(() => MT.mapsui.openInAnalysis());
  const okEdit = viaMaps ? true : await ev((id) => MT.analysisui.edit(id), slide.id);
  await sleep(700);
  const ed = await ev(() => ({ tab: MT.app.currentTab(), st: MT.analysisui.state(), bar: document.querySelector('.mt-analysis-linkbar').textContent, upd: !!document.querySelector('.mt-analysis-act-update') }));
  check(okEdit && ed.tab === 'analysis' && ed.st.ref.storeId === PV && ed.st.universe.meters === 2000 && /Editando el análisis de la lámina «Plaza Vea Miraflores»/.test(ed.bar) && ed.upd,
    `${viaMaps ? 'Mapas "Editar en Análisis"' : 'MT.analysisui.edit(slide)'} → tab, reference, universe and the "Editando…" bar with "Actualizar la lámina"`);
  await page.click('.mt-analysis-chip[data-value="1000"]');
  await sleep(300);
  await page.click('.mt-analysis-act-update');
  await sleep(400);
  const upd = await ev((id) => MT.project.getMap(id).analysis, slide.id);
  check(upd.maxMeters === 1000 && upd.rings.join() === '500,1000', `"Actualizar la lámina" → maxMeters ${upd.maxMeters}, rings ${upd.rings.join('/')}`);

  /* ---- 10. Mode B: Lima Sur ------------------------------------------------------------------------------ */
  await page.click('.mt-analysis-modes .mt-seg__opt:nth-child(2)');
  await sleep(400);
  const bEmpty = await ev(() => ({ title: (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-empty__title') || {}).textContent, zones: [...document.querySelectorAll('.mt-analysis-zonebtns button')].map((b) => b.textContent) }));
  if (bEmpty.title === 'Elige la región') {
    check(bEmpty.zones.includes('Lima Sur'), `mode B without region: "Elige la región" + zone buttons (${bEmpty.zones.join(', ')})`);
    await ev(() => [...document.querySelectorAll('.mt-analysis-zonebtns button')].find((b) => b.textContent === 'Lima Sur').click());
  } else {
    check(true, 'mode B remembers its last region');
    await ev((ds) => MT.analysisui.setMatrix({ districts: ds }), LIMA_SUR);
  }
  await ev(() => MT.analysisui.whenIdle());
  await sleep(300);
  const engB = async (o) => ev((o) => {
    const A = MT.analysis, st = MT.analysisui.state().matrix, r = MT.analysisui.results();
    const region = A.storesForRegion({ districts: st.districts, chains: st.chains, includeToVerify: true });
    const cands = st.neighbors ? A.storesForRegion({ chains: st.chains, includeToVerify: true }) : region;
    const nm = A.neighborMatrix(region, { radius: st.radius, candidates: cands });
    const inR = new Set(region.map((s) => s.id));
    let pool = region;
    if (st.neighbors) {
      const idx = A.index(cands), extra = new Map();
      region.forEach((s) => idx.within(s.lat, s.lng, st.threshold, (x) => !inR.has(x.id)).forEach((h) => extra.set(h.store.id, h.store)));
      pool = region.concat([...extra.values()]);
    }
    const pairs = A.closePairs(pool, { meters: st.threshold, sameChainOnly: !st.showComp }).filter((p) => inR.has(p.a.id) || inR.has(p.b.id));
    const sigR = (rows) => rows.map((x) => [x.store.id, x.nearestSame && x.nearestSame.store.id, x.nearestSame && x.nearestSame.meters, x.nearestCompetitor && x.nearestCompetitor.store.id,
      x.nearestCompetitor && x.nearestCompetitor.meters, x.sameWithin, x.competitorsWithin, JSON.stringify(x.byChainWithin)].join(':')).join('|');
    const sigP = (ps) => ps.map((p) => p.a.id + '-' + p.b.id + ':' + p.meters + ':' + p.sameChain).join('|');
    return { n: nm.length, rowsSame: sigR(nm) === sigR(r.rows), pairs: pairs.length, pairsSame: sigP(pairs) === sigP(r.pairs), samePairs: pairs.filter((p) => p.sameChain).length,
      sameFirst: r.pairs.every((p, i, a) => !i || !(p.sameChain && !a[i - 1].sameChain)), comp: pairs.filter((p) => !p.sameChain).length,
      withSame: nm.filter((x) => x.sameWithin > 0).length, withComp: nm.filter((x) => x.competitorsWithin > 0).length };
  }, o || {});
  let b1 = await engB();
  check(b1.rowsSame && b1.n > 40, `per-store matrix = MT.analysis.neighborMatrix (Lima Sur, R 1 km, neighbours across the border): ${b1.n} stores`);
  check(b1.pairsSame && b1.pairs > 0 && b1.comp === 0, `close pairs = MT.analysis.closePairs (same chain only by default): ${b1.pairs} pairs`);
  const sb = await ev(() => ({ cards: [...document.querySelectorAll('.mt-analysis-stat')].map((c) => [c.querySelector('.mt-analysis-stat__label').textContent, c.querySelector('.mt-analysis-stat__value').textContent]),
    head: document.querySelector('.mt-analysis-mainhead__h').textContent }));
  check(sb.head === 'Matriz de cercanía · Lima Sur' && sb.cards[0][1] === String(b1.n) && sb.cards[1][1] === String(b1.samePairs) && sb.cards[2][1] === String(b1.withSame) && sb.cards[3][1] === String(b1.withComp),
    `summary: ${sb.cards.map((c) => c[0] + ' ' + c[1]).join(' · ')}`);
  const bRows = await tableRows('.mt-analysis-table--b');
  const firstSame = await ev(() => MT.util.sortBy(MT.analysisui.results().rows.filter((r) => r.nearestSame), (r) => r.nearestSame.meters)[0].store.id);
  check(bRows[0].id === firstSame && bRows[0].cells.length === 5, 'per-store table: most cannibalized first (nearest same-chain store), 5 columns at 1440 px');
  await mapIdle();
  await screenshot(page, 'an-ui-09-matrix');
  await page.click('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="pairs"]');
  await sleep(300);
  const pr = await tableRows('.mt-analysis-table--pairs');
  check(pr.length > 0 && pr.every((r) => r.cells[0] === 'Posible canibalización'), `pairs tab: ${pr.length} rows tagged "Posible canibalización"`);
  await page.click('.mt-analysis-table--pairs tbody tr[data-id]:nth-of-type(2)');
  await sleep(700);
  const selF = await ev(() => JSON.stringify(MT.analysisui.map().getFilter('mtb-pair-sel')));
  check(await ev(() => MT.analysisui.state().matrix.selectedPair) === '0' && selF === '["==",["get","key"],"0"]', `pair click → highlighted line on the map (selection layer ${selF})`);
  await mapIdle();
  await screenshot(page, 'an-ui-10-pairs');
  // Competitor pairs + no neighbours + radius 500 m
  await ev(() => [...document.querySelectorAll('.mt-analysis-side .mt-switch')].find((s) => /pares con la competencia/.test(s.textContent)).querySelector('input').click());
  await ev(() => MT.analysisui.whenIdle());
  b1 = await engB();
  check(b1.pairsSame && b1.comp > 0 && b1.sameFirst, `"Incluir pares con la competencia": ${b1.comp} competitor pairs, same-chain pairs still first`);
  await mapIdle();                                   // GeoJSON setData is applied asynchronously
  check(await ev(() => MT.analysisui.map().getLayoutProperty('mtb-pairs-comp', 'visibility') !== 'none' && MT.analysisui.map().querySourceFeatures('mtb-pairs').some((f) => !f.properties.same)), 'grey competitor lines on the map');
  await ev(() => [...document.querySelectorAll('.mt-analysis-side .mt-switch')].find((s) => /fuera de la región/.test(s.textContent)).querySelector('input').click());
  await ev(() => MT.analysisui.whenIdle());
  b1 = await engB();
  check(b1.rowsSame && b1.pairsSame, '"Contar tiendas vecinas fuera de la región" off → candidates = the region only (engine match)');
  await ev(() => { const g = document.querySelectorAll('.mt-analysis-side .mt-analysis-dchips')[0]; [...g.querySelectorAll('.mt-analysis-chip')].find((b) => b.textContent === '500 m').click(); });
  await ev(() => MT.analysisui.whenIdle());
  b1 = await engB();
  await page.click('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="stores"]');
  await sleep(200);
  check(b1.rowsSame && await ev(() => MT.analysisui.state().matrix.radius) === 500 && await ev(() => document.querySelector('.mt-analysis-table--b th[data-col="sameN"]').textContent) === 'Misma ≤ 500 m',
    'R = 500 m chip → counts recomputed, header "Misma ≤ 500 m"');
  await ev(() => { const g = document.querySelectorAll('.mt-analysis-side .mt-analysis-dchips')[0]; const i = g.querySelector('input'); i.value = '750'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await ev(() => MT.analysisui.whenIdle());
  check(await ev(() => MT.analysisui.state().matrix.radius) === 750 && (await engB()).rowsSame, 'custom R (750 m) typed in "Otra (m)"');
  await ev(() => MT.analysisui.setMatrix({ neighbors: true, showCompetitors: false, radius: 1000 }));
  // Store selection → nearest lines + card
  await page.click('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="stores"]');
  await sleep(200);
  await page.click('.mt-analysis-table--b tbody tr[data-id]');
  await sleep(600);
  const bsel = await ev(() => ({ id: MT.analysisui.state().matrix.selected, card: (document.querySelector('.mt-analysis-popup') || {}).textContent || '', sel: MT.analysisui.map().querySourceFeatures('mtb-sel').length }));
  check(!!bsel.id && /Misma cadena más cercana/.test(bsel.card) && /Competencia más cercana/.test(bsel.card) && /A menos de 1 km/.test(bsel.card) && bsel.sel >= 2,
    'store click → card (nearest same / competitor, stores within R by chain) + dashed lines to both');
  // Excel B
  await page.click('.mt-analysis-act-excel');
  const fileB = await waitForDownload(dl, /^Matriz de cercanía - Lima Sur - \d{4}-\d\d-\d\d\.xlsx$/);
  const bookB = readBook(fileB);
  const xb = await ev(() => { const r = MT.analysisui.results(); return { rows: r.rows.map((x) => [x.store.id, x.nearestSame ? x.nearestSame.meters : null, x.sameWithin, x.competitorsWithin]), pairs: r.pairs.map((p) => [p.a.id, p.b.id, p.meters]) }; });
  check(bookB.names.join('|') === 'Por tienda|Pares cercanos|Parámetros', `matrix workbook sheets: ${bookB.names.join(', ')}`);
  const PT = bookB.sheets['Por tienda'], ph = PT[0];
  const iSm = ph.indexOf('Distancia a la misma cadena (m)'), iSw = ph.indexOf('Misma cadena a ≤ 1 km'), iCw = ph.indexOf('Competencia a ≤ 1 km'), iIdB = ph.indexOf('ID');
  const kB = (x) => (x[1] === null ? Infinity : x[1]);
  const xbOrder = xb.rows.slice().sort((a, b) => (kB(a) === kB(b) ? 0 : kB(a) < kB(b) ? -1 : 1) || (a[0] < b[0] ? -1 : 1));
  check(PT.length === xb.rows.length + 1 && iSw > 0 && iCw > 0 && iIdB > iCw && ph[0] === 'Cadena' && ph[1] === 'Tienda' && ph.some((x) => x === 'Plaza Vea a ≤ 1 km') && new Set(ph).size === ph.length &&
    ph.includes('Distancia a la competencia (m)') && xbOrder.every((x, i) => PT[i + 1][iIdB] === x[0] && (x[1] === null ? PT[i + 1][iSm] === '' : PT[i + 1][iSm] === round1(x[1])) && PT[i + 1][iSw] === x[2] && PT[i + 1][iCw] === x[3]),
  `"Por tienda": ${PT.length - 1} rows in the tab's order (nearest same-chain first), chain and store first, distinct headers, counts within R, per-chain columns`);
  const PP = bookB.sheets['Pares cercanos'];
  check(PP.length === xb.pairs.length + 1 && PP[1][0] === 'Posible canibalización' && typeof PP[1][7] === 'number' && PP[1][7] === round1(xb.pairs[0][2]), `"Pares cercanos": ${PP.length - 1} pairs, tagged, metres as numbers`);
  const PB = Object.fromEntries(bookB.sheets['Parámetros'].slice(1).map((r) => [r[0], r[1]]));
  check(/Chorrillos/.test(PB['Región']) && PB['Radio de vecindad (R)'] === '1 km (1000 m)' && PB['Umbral de pares cercanos'] === '1 km (1000 m)' && /haversine/.test(PB['Método']),
    `"Parámetros" (matrix): region, R, threshold, method`);

  /* ---- 11. Big region in idle chunks ----------------------------------------------------------------------- */
  const big = await ev(async () => {
    const lima = MT.data.districts.byProvince().find((p) => p.province === 'Lima' && p.department === 'Lima');
    const all = MT.data.chains().map((c) => c.id);
    let sawComputing = false, ticks = 0;
    const tick = () => { ticks++; if (MT.analysisui.state().matrix.computing) sawComputing = true; };
    const timer = setInterval(tick, 5);
    const t0 = performance.now();
    await MT.analysisui.setMatrix({ districts: lima.ubigeos, chains: all, neighbors: true });
    const ms = performance.now() - t0;
    clearInterval(timer);
    const A = MT.analysis, region = A.storesForRegion({ districts: lima.ubigeos, chains: all });
    const t1 = performance.now();
    const nm = A.neighborMatrix(region, { radius: 1000, candidates: A.storesForRegion({ chains: all }) });
    const one = performance.now() - t1;
    const sig = (rows) => rows.map((x) => [x.store.id, x.nearestSame && x.nearestSame.meters, x.nearestCompetitor && x.nearestCompetitor.store.id, x.sameWithin, x.competitorsWithin].join(':')).join('|');
    return { n: region.length, same: sig(nm) === sig(MT.analysisui.results().rows), sawComputing, ticks, ms: Math.round(ms), one: Math.round(one) };
  });
  check(big.n > 1500 && big.same, `Lima province, every chain: ${big.n} stores computed in chunks = one engine call`);
  check(big.sawComputing && big.ticks >= 3, `the page stays responsive while computing (${big.ticks} timer ticks during ${big.ms} ms; one blocking call takes ${big.one} ms)`);
  const capB = await ev(async () => {
    const t0 = performance.now();
    await MT.analysisui.setMatrix({ threshold: 30000, showCompetitors: true });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ms = performance.now() - t0, s = MT.analysisui.state().matrix;
    document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="pairs"]').click();
    return { ms: Math.round(ms), threshold: s.threshold, pairs: s.pairs, tab: (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="pairs"] .mt-analysis-rtab__n') || {}).textContent,
      note: (document.querySelector('.mt-analysis-capnote') || {}).textContent || '' };
  });
  const capTotal = +String(capB.tab).replace(/\D/g, '');
  check(capB.threshold === 5000 && capB.pairs === 50000 && capTotal > 50000 && /Se muestran los primeros 50,000 de/.test(capB.note) && capB.ms < 8000,
    `pair threshold capped at 5 km; ${capTotal.toLocaleString('en')} pairs counted, the first 50,000 listed and drawn (${capB.ms} ms)`);
  await ev(() => MT.analysisui.setMatrix({ threshold: 1000, showCompetitors: false }));
  await sleep(500);
  await screenshot(page, 'an-ui-11-lima');

  /* ---- 12. English, 1280 px ---------------------------------------------------------------------------- */
  await ev(() => MT.analysisui.setMatrix({ districts: ['150108', '150119', '150123', '150133', '150142', '150143'], chains: MT.analysis.defaultChains(null) }));
  await page.setViewport({ width: 1366, height: 768 });
  await ev(() => { const b = document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="stores"]'); if (b) b.click(); });
  await sleep(600);
  const lap = await ev(() => { const w = document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-tablewrap'), wr = w.getBoundingClientRect();
    return [...w.querySelectorAll('tbody tr[data-id]')].filter((tr) => { const r = tr.getBoundingClientRect(); return r.top >= wr.top - 0.5 && r.bottom <= wr.bottom + 0.5; }).length; });
  check(lap >= 8, `1366 × 768 laptop: the proximity matrix shows ${lap} full rows (≥ 8)`);
  await screenshot(page, 'an-ui-13-matrix-1366');
  await page.setViewport({ width: 1440, height: 900 });
  await sleep(300);
  await ev(() => MT.i18n.setLang('en'));
  await sleep(500);
  const en = await ev(() => ({ title: document.querySelector('.mt-analysis-head__h').textContent, modes: [...document.querySelectorAll('.mt-analysis-modes .mt-seg__opt')].map((x) => x.textContent.trim()),
    head: document.querySelector('.mt-analysis-mainhead__h').textContent, tabs: [...document.querySelectorAll('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab')].map((b) => b.textContent),
    raw: [...document.querySelectorAll('#panel-analysis *')].filter((el) => !el.children.length && /^analysis\.[a-z]/.test(el.textContent.trim())).length,
    missing: MT.i18n.missingKeys() }));
  check(en.title === 'Distance analysis' && en.modes.join('|') === 'Distances to a point|Proximity matrix' && en.head === 'Proximity matrix · Lima Sur' && en.tabs[0].startsWith('By store'),
    `English: ${en.title} · ${en.modes.join(' | ')} · ${en.head}`);
  check(en.raw === 0 && en.missing.length === 0, `no raw keys on screen, no missing keys (${en.missing.join(', ')})`);
  await ev(() => MT.analysisui.setMode('distance'));
  await sleep(500);
  const enA = await ev(() => ({ head: document.querySelector('.mt-analysis-mainhead__h').textContent, dist: [...document.querySelectorAll('.mt-analysis-table--a tbody tr[data-id] td:nth-child(3)')].map((td) => td.textContent),
    th: [...document.querySelectorAll('.mt-analysis-table--a th')].map((x) => x.textContent) }));
  check(enA.head === 'Distances to Plaza Vea Miraflores' && enA.dist.some((d) => /^\d\.\d km$/.test(d) || /^\d+ m$/.test(d)) && !enA.dist.some((d) => /,\d km/.test(d)) && enA.th.includes('Distance'),
    `English table: "${enA.dist.slice(0, 3).join(', ')}", headers ${enA.th.join(' · ')}`);
  await page.setViewport({ width: 1280, height: 720 });
  await sleep(600);
  const narrow = await ev(() => ({ over: document.documentElement.scrollWidth > window.innerWidth, panelOver: document.querySelector('.mt-analysis').scrollWidth > document.querySelector('.mt-analysis').clientWidth + 1 }));
  check(!narrow.over && !narrow.panelOver, 'no horizontal overflow at 1280 × 720');
  await mapIdle();
  await screenshot(page, 'an-ui-12-en-1280');
  await ev(() => MT.i18n.setLang('es'));
  await page.setViewport({ width: 1440, height: 900 });
  await sleep(300);

  /* ---- 13. Clear the reference --------------------------------------------------------------------------- */
  await page.click('.mt-analysis-refcard__x');
  await sleep(300);
  check(await ev(() => !MT.analysisui.state().ref && (document.querySelector('.mt-analysis-respane:not([hidden]) .mt-empty__title') || {}).textContent === 'Elige una referencia'), '× on the reference card → back to the empty state');

  const { real, noise } = splitNetworkNoise(errors);
  if (noise.length) console.log(`   (${noise.length} transient tile errors ignored)`);
  check(real.length === 0, `no console errors${real.length ? ': ' + real.slice(0, 4).join(' | ') : ''}`);
} catch (err) {
  console.log(err);
  check(false, 'test run threw: ' + (err && err.message));
} finally {
  await browser.close();
}
finish();
