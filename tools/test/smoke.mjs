// tools/test/smoke.mjs — the app boots from file://, every tab renders, the language toggles,
// and there are no console errors. Also checks the "data missing" path.
//
//   node tools/test/smoke.mjs            (screenshots in tools/test/out/smoke-*.png)
//   node tools/test/smoke.mjs --headful  (watch it)
//   node tools/test/smoke.mjs --no-net   (skip [4], which needs OpenFreeMap)

import { openApp, screenshot, makeChecker, sleep, waitForMapIdle, loadDemoProject } from './lib.mjs';

const headless = !process.argv.includes('--headful');
const noNet = process.argv.includes('--no-net');
const { check, finish } = makeChecker('smoke');

/* ---------- 1. Normal boot (real data where present, fixtures for missing files) ---------- */
{
  console.log('\n[1] boot (es)');
  const { browser, page, errors, injected } = await openApp({ lang: 'es', headless });
  console.log('  fixtures injected for:', injected.length ? injected.join(', ') : 'none (all real data)');
  const info = await page.evaluate(() => ({
    lang: MT.i18n.lang,
    title: document.title,
    tabs: MT.app.tabs().map((t) => t.id),
    tabLabels: [...document.querySelectorAll('.mt-tab')].map((b) => b.textContent.trim()),
    stores: MT.data.stores().length,
    chains: MT.data.chains().length,
    districts: MT.data.districts.all().length,
    missing: MT.data.missing,
    project: MT.project.current().name,
    maps: MT.project.maps().length,
    splashGone: !document.querySelector('#mt-splash') || document.querySelector('#mt-splash').classList.contains('is-gone'),
  }));
  console.log('  ', JSON.stringify(info));
  check(info.lang === 'es', 'language is es from ?lang=es');
  check(info.tabs.join() === 'maps,analysis,db,chains', `tabs registered in order (got ${info.tabs})`);
  check(info.tabLabels.join('|') === 'Mapas|Análisis|Base de datos|Cadenas', `Spanish tab labels (got ${info.tabLabels.join('|')})`);
  check(info.stores > 0 && info.chains >= 16 && info.districts > 0, 'data loaded (stores, chains, districts)');
  check(!Object.values(info.missing).some(Boolean), 'no data file reported missing');
  check(info.maps === 1, 'fresh project has one map');
  check(info.splashGone, 'splash removed');
  // District search/locate on whatever districts file is loaded (real all-Peru data or fixture).
  const geo = await page.evaluate(() => {
    const t0 = performance.now();
    const loc = MT.data.districts.locate(-12.1219, -77.0297);
    const t1 = performance.now();
    const loc2 = MT.data.districts.locate(-8.1116, -79.0288);
    const t2 = performance.now();
    return { first: (MT.data.districts.search('miraflores')[0] || {}).label, loc: loc && loc.ubigeo, loc2: loc2 && loc2.ubigeo,
      ms1: Math.round(t1 - t0), ms2: Math.round(t2 - t1), n: MT.data.districts.all().length };
  });
  console.log('   districts:', JSON.stringify(geo));
  check(geo.first === 'Miraflores — Lima, Lima', `"miraflores" ranks Miraflores (Lima) first (got ${geo.first})`);
  check(geo.loc === '150122' && geo.loc2 === '130101', 'locate() finds Miraflores and Trujillo');
  check(geo.ms1 < 300 && geo.ms2 < 300, `locate() is fast (${geo.ms1} ms, ${geo.ms2} ms over ${geo.n} districts)`);
  await sleep(300);
  await screenshot(page, 'smoke-es-maps');

  for (const id of ['analysis', 'db', 'chains', 'maps']) {
    await page.click(`#tab-${id}`);
    await sleep(350);
    const st = await page.evaluate((id) => {
      const panel = document.querySelector(`#panel-${id}`);
      return { current: MT.app.currentTab(), visible: panel && !panel.hidden, children: panel ? panel.childElementCount : 0, hash: location.hash };
    }, id);
    check(st.current === id && st.visible && st.children > 0, `tab ${id} renders (hash ${st.hash})`);
    await screenshot(page, `smoke-es-${id}`);
  }

  // Demo project (reference slides) loads through MT.project.open.
  const ids = await loadDemoProject(page);
  const demo = await page.evaluate(() => ({ name: MT.project.current().name, n: MT.project.maps().length, cur: MT.project.currentMapId(),
    sub: MT.data.subtitleFor(MT.project.maps()[0]), sub2: MT.data.subtitleFor(MT.project.maps()[1]), dirty: MT.project.isDirty() }));
  check(ids.length === 4 && demo.cur === 'demo-lima-sur' && demo.sub === '(Miraflores, San Borja, San Isidro, Surquillo)' && /SJM/.test(demo.sub2) && !demo.dirty,
    `demo project loads (${JSON.stringify(demo)})`);
  await page.evaluate(() => MT.project.newProject());

  // Keyboard: arrow keys move between tabs.
  await page.focus('#tab-maps');
  await page.keyboard.press('ArrowRight');
  check(await page.evaluate(() => MT.app.currentTab()) === 'analysis', 'ArrowRight moves to the next tab');
  await page.keyboard.press('ArrowLeft');

  // Project menu.
  await page.click('.mt-project .mt-btn');
  await sleep(250);
  const menu = await page.evaluate(() => [...document.querySelectorAll('.mt-menu__item')].map((b) => b.textContent.trim()));
  check(menu.length >= 5 && menu[0].startsWith('Nuevo proyecto'), `project menu opens (${menu.length} items)`);
  await screenshot(page, 'smoke-es-menu');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => !document.querySelector('.mt-menu')), 'Escape closes the menu');

  // Rename dialog (modal + prompt).
  await page.click('.mt-project__name');
  await sleep(250);
  check(await page.evaluate(() => !!document.querySelector('.mt-modal input')), 'rename opens a prompt modal');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('Estudio Lima Sur');
  await screenshot(page, 'smoke-es-rename');
  await page.keyboard.press('Enter');
  await sleep(250);
  check(await page.evaluate(() => MT.project.current().name) === 'Estudio Lima Sur', 'project renamed through the modal');
  check(await page.evaluate(() => document.querySelector('.mt-project__name').textContent) === 'Estudio Lima Sur', 'top bar shows the new name');

  let missingKeys = await page.evaluate(() => MT.i18n.missingKeys());
  check(missingKeys.length === 0, `no missing i18n keys in Spanish (${missingKeys.join(', ')})`);

  // Language toggle → EN.
  await page.click('.mt-lang label:nth-child(2)');
  await sleep(300);
  const en = await page.evaluate(() => ({
    lang: MT.i18n.lang, html: document.documentElement.lang,
    tabLabels: [...document.querySelectorAll('.mt-tab')].map((b) => b.textContent.trim()),
    stubTitle: (document.querySelector('#panel-maps .mt-empty__title') || {}).textContent,
  }));
  check(en.lang === 'en' && en.html === 'en', 'language switched to en');
  check(en.tabLabels.join('|') === 'Maps|Analysis|Database|Chains', `English tab labels (got ${en.tabLabels.join('|')})`);
  check(!en.stubTitle || en.stubTitle === 'Section under construction' || !/construcción/.test(en.stubTitle), 'panel text re-translated');
  await screenshot(page, 'smoke-en-maps');

  // Persisted across reloads (no ?lang in the URL).
  await page.goto(page.url().replace(/\?lang=es/, ''), { waitUntil: 'load' });
  await page.waitForFunction(() => window.MT && MT.app && MT.app.booted);
  check(await page.evaluate(() => MT.i18n.lang) === 'en', 'language persisted after reload');
  check(await page.evaluate(() => MT.project.current().name) === 'Estudio Lima Sur', 'project autosave restored after reload');

  for (const id of ['analysis', 'db', 'chains', 'maps']) { await page.click(`#tab-${id}`); await sleep(150); }
  missingKeys = await page.evaluate(() => MT.i18n.missingKeys());
  check(missingKeys.length === 0, `no missing i18n keys in English (${missingKeys.join(', ')})`);
  // Every key must exist in both languages.
  const parity = await page.evaluate(() => {
    const es = new Set(MT.i18n.keys('es')), en = new Set(MT.i18n.keys('en'));
    return { onlyEs: [...es].filter((k) => !en.has(k)), onlyEn: [...en].filter((k) => !es.has(k)) };
  });
  check(!parity.onlyEs.length && !parity.onlyEn.length, `ES/EN dictionaries have the same keys (only es: ${parity.onlyEs.join(', ')}; only en: ${parity.onlyEn.join(', ')})`);
  check(errors.length === 0, `no console errors (${errors.length})`);
  errors.forEach((e) => console.log('    ', e));
  await browser.close();
}

/* ---------- 2. No data files at all → banner, app still usable ---------- */
{
  console.log('\n[2] boot without data files');
  const { browser, page, errors } = await openApp({ lang: 'es', fixtures: 'none', headless });
  const st = await page.evaluate(() => ({
    missing: MT.data.missing,
    banner: (document.querySelector('.mt-banner') || {}).textContent || '',
    stores: MT.data.stores().length,
    booted: MT.app.booted,
  }));
  check(st.booted, 'app boots with no data');
  check(st.missing.stores && st.missing.chains && st.missing.districts && st.missing.logos, 'all four files reported missing');
  check(/Faltan 4 archivos de datos/.test(st.banner), 'banner explains the missing files');
  for (const id of ['maps', 'analysis', 'db', 'chains']) {
    await page.click(`#tab-${id}`);
    await sleep(200);
  }
  await screenshot(page, 'smoke-missing-data');
  // The only acceptable errors are the four data files that are not there.
  const unexpected = errors.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
  check(unexpected.length === 0, `only file-not-found errors (${unexpected.length} unexpected)`);
  unexpected.forEach((e) => console.log('    ', e));
  await browser.close();
}

/* ---------- 3. Narrow window (laptop 1280×720) ---------- */
{
  console.log('\n[3] 1280×720');
  const { browser, page, errors } = await openApp({ lang: 'es', headless, viewport: { width: 1280, height: 720 } });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no horizontal page overflow at 1280 px');
  await screenshot(page, 'smoke-1280');
  check(errors.length === 0, 'no console errors');
  await browser.close();
}

/* ---------- 4. MapLibre renders inside the app page (needs OpenFreeMap) ---------- */
if (!noNet) {
  console.log('\n[4] MapLibre inside the app (file://, SwiftShader)');
  const { browser, page, errors } = await openApp({ lang: 'es', headless });
  await page.evaluate(() => {
    const el = MT.util.h('div', { id: 'smoke-map', style: { position: 'fixed', left: '20px', top: '80px', width: '1000px', height: Math.round(MT.theme.frame.refHeight) + 'px', zIndex: 50, boxShadow: '0 4px 20px rgba(0,0,0,.2)' } });
    document.body.appendChild(el);
    const b = MT.data.districts.unionBbox(['150122', '150131', '150130', '150141']);
    window.__smokeMap = new maplibregl.Map({ container: el, style: MT.theme.basemap.style, bounds: MT.geo.bboxToBounds(b), fitBoundsOptions: { padding: 40 }, fadeDuration: 0 });
    window.__smokeMap.on('style.load', () => {
      for (const l of window.__smokeMap.getStyle().layers) {
        const tf = l.type === 'symbol' && window.__smokeMap.getLayoutProperty(l.id, 'text-field');
        if (tf && JSON.stringify(tf).includes('name_en')) window.__smokeMap.setLayoutProperty(l.id, 'text-field', MT.theme.basemap.spanishTextField);
      }
      window.__smokeMap.addSource('d', { type: 'geojson', data: MT.data.districts.features(['150122', '150131', '150130', '150141']) });
      window.__smokeMap.addLayer({ id: 'd', type: 'line', source: 'd', paint: { 'line-color': MT.theme.borders.color, 'line-width': 2 } });
    });
  });
  await waitForMapIdle(page, { expr: 'window.__smokeMap' });
  const st = await page.evaluate(() => ({ loaded: window.__smokeMap.loaded(), zoom: window.__smokeMap.getZoom().toFixed(2) }));
  check(st.loaded, `map reached idle (zoom ${st.zoom})`);
  await screenshot(page, 'smoke-maplibre');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await browser.close();
}

finish();
