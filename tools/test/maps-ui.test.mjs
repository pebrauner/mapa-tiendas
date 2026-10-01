// tools/test/maps-ui.test.mjs — module M2 (the "Mapas" tab) in headless Chrome from file://.
//
//   node tools/test/maps-ui.test.mjs              all checks, screenshots in tools/test/out/m2-*.png
//   node tools/test/maps-ui.test.mjs --headful    watch it
//
// Covers: mount + layout, create a slide, pick districts by typing (keyboard and mouse), zone preset,
// title / subtitle / Peso, chain toggles (single, per group, all/none), marker style / size / legend
// order, store popup from a marker click, radius (popup, meters input, presets, results, Excel export),
// hide / restore a store, slide reorder (Alt+arrows and drag-and-drop), duplicate / delete (confirm +
// undo), export panel, hints (no chains on), save → open project round trip, English UI, empty
// project, 1280 px. Uses the real data when present, else tools/fixtures (injected by lib.mjs).
// Needs network for the basemap (OpenFreeMap); the checks do not depend on tiles being loaded.

import { openApp, screenshot, makeChecker, waitForMapIdle, captureDownloads, waitForDownload, sleep, ROOT } from './lib.mjs';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const headless = !process.argv.includes('--headful');
const { check, finish } = makeChecker('maps-ui');

/** A temporary logos.js from logos/*.png when the data workflow has not produced logos.js yet (temp copy only). */
function realLogosJs() {
  const dir = path.join(ROOT, 'logos');
  if (!existsSync(dir)) return null;
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
    const m = /^(.+?)(-wide)?\.png$/.exec(f);
    out[m[1]] = out[m[1]] || {};
    out[m[1]][m[2] ? 'wide' : 'badge'] = 'data:image/png;base64,' + readFileSync(path.join(dir, f)).toString('base64');
  }
  for (const id of Object.keys(out)) if (!out[id].badge) delete out[id];
  return Object.keys(out).length ? 'window.MT_LOGOS = ' + JSON.stringify(out) + ';\n' : null;
}

const app = await openApp({ lang: 'es', headless, viewport: { width: 1440, height: 900 }, hash: 'mapas' });
const { page, errors, browser } = app;
if (app.injected.includes('logos/logos.js')) {
  const js = realLogosJs();
  if (js) {
    writeFileSync(path.join(app.dir, 'logos', 'logos.js'), js);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
    console.log('  (temporary logos.js from logos/*.png)');
  }
}
console.log('  fixtures injected for:', app.injected.join(', ') || 'none (real data)');

const ev = (fn, ...args) => page.evaluate(fn, ...args);
const cur = () => ev(() => JSON.parse(JSON.stringify(MT.project.currentMap())));
const waitFor = (fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg);
async function openSection(id) {
  const open = await ev((id) => document.querySelector(`.mt-maps-sec[data-sec="${id}"] .mt-maps-sec__head`).getAttribute('aria-expanded') === 'true', id);
  if (!open) {
    await page.focus(`.mt-maps-sec[data-sec="${id}"] .mt-maps-sec__head`);
    await page.keyboard.press('Enter');
  }
  await page.$eval(`.mt-maps-sec[data-sec="${id}"]`, (el) => el.scrollIntoView({ block: 'start' }));
}
async function waitMarkers() {
  await waitFor(() => MT.mapview && MT.mapview.items().length > 0 && document.querySelectorAll('.mt-marker-hit').length > 0, null, 15000);
}
async function typeInto(selector, text) {
  await page.focus(selector);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, text, { delay: 15 });
}

try {
  /* ---------------------------------------------------------------- 1. mount */
  console.log('\n1. Tab mounts');
  await waitFor(() => document.querySelector('.mt-maps .mt-maps-slide') && document.querySelector('.mt-slide'));
  const boot = await ev(() => ({
    tab: MT.app.currentTab(), stub: !!document.querySelector('#panel-maps .mt-stub'),
    rail: document.querySelectorAll('.mt-maps-slide').length, secs: [...document.querySelectorAll('.mt-maps-sec')].map((s) => s.dataset.sec),
    slide: !!document.querySelector('#panel-maps .mt-slide .mt-mapview'), bar: document.querySelector('.mt-maps-bar__pos').textContent,
  }));
  check(boot.tab === 'maps' && !boot.stub, 'Mapas tab shown, stub replaced');
  check(boot.rail === 1, 'rail lists the single map of a fresh project');
  check(boot.secs.join() === 'content,districts,chains,markers,map,radius,hidden', `inspector sections (${boot.secs})`);
  check(boot.slide, 'live slide (MT.slide + MT.mapview) mounted in the centre');
  check(/1 de 1/.test(boot.bar), `bar shows the slide position (${boot.bar})`);

  /* ---------------------------------------------------------------- 2. new slide */
  console.log('\n2. Create a slide');
  await page.click('.mt-maps-rail__add');
  await waitFor(() => MT.project.maps().length === 2);
  await sleep(120);
  const created = await ev(() => ({ n: MT.project.maps().length, cur: MT.project.currentMapId(), second: MT.project.maps()[1].id,
    focus: document.activeElement && document.activeElement.dataset.field, start: !document.querySelector('.mt-maps-start').hidden,
    active: document.querySelector('.mt-maps-slide.is-active').dataset.id }));
  check(created.cur === created.second && created.active === created.second, 'new slide added at the end and selected');
  check(created.focus === 'districtSearch', 'district search focused for the first step');
  check(created.start, 'friendly "Empieza por aquí" prompt while there are no districts');
  await screenshot(page, 'm2-new-slide');

  /* ---------------------------------------------------------------- 3. districts by typing */
  console.log('\n3. Districts');
  await page.type('[data-field="districtSearch"]', 'miraf', { delay: 20 });
  await waitFor(() => document.querySelectorAll('.mt-maps-results [role="option"]').length > 0);
  const opts = await ev(() => [...document.querySelectorAll('.mt-maps-results [role="option"]')].map((li) => li.textContent));
  check(/Miraflores/.test(opts[0]) && /Lima/.test(opts[0]), `first result is Miraflores (Lima): ${opts[0]}`);
  const aria = await ev(() => { const i = document.querySelector('[data-field="districtSearch"]'); return { exp: i.getAttribute('aria-expanded'), ad: i.getAttribute('aria-activedescendant') }; });
  check(aria.exp === 'true' && !!aria.ad, 'combobox exposes aria-expanded + aria-activedescendant');
  await screenshot(page, 'm2-district-search');
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().districts.includes('150122'));
  check(true, 'Enter adds the highlighted district (150122)');
  check(await ev(() => document.querySelector('[data-field="districtSearch"]').value === '' && document.activeElement.dataset.field === 'districtSearch'), 'input cleared and keeps focus');
  await page.type('[data-field="districtSearch"]', 'san isid', { delay: 15 });
  await waitFor(() => !!document.querySelector('.mt-maps-results [data-ubigeo="150131"]'));
  await page.click('.mt-maps-results [data-ubigeo="150131"]');
  await waitFor(() => MT.project.currentMap().districts.includes('150131'));
  check(true, 'clicking a result adds San Isidro');
  await page.type('[data-field="districtSearch"]', 'surquillo', { delay: 15 });
  await waitFor(() => !!document.querySelector('.mt-maps-results [data-ubigeo="150141"]'));
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().districts.length === 3);
  // Already-added districts are marked and cannot be picked twice.
  await page.type('[data-field="districtSearch"]', 'miraflores', { delay: 10 });
  await waitFor(() => !!document.querySelector('.mt-maps-results [data-ubigeo="150122"]'));
  check(await ev(() => document.querySelector('.mt-maps-results [data-ubigeo="150122"]').getAttribute('aria-disabled') === 'true'), 'an added district shows as already on the slide');
  await page.keyboard.press('Escape');
  const chips = await ev(() => [...document.querySelectorAll('.mt-maps-chip .mt-chip__label')].map((x) => x.textContent));
  check(chips.join('|') === 'Miraflores|San Isidro|Surquillo', `chips (${chips.join(', ')})`);
  await waitFor(() => /\(Miraflores, San Isidro, Surquillo\)/.test(document.querySelector('.mt-slide__subtitle').textContent));
  check(true, 'automatic subtitle on the slide: (Miraflores, San Isidro, Surquillo)');
  check(await ev(() => document.querySelector('.mt-maps-start').hidden), 'start prompt hidden once districts exist');
  // Remove a chip, then add it back with Backspace-less flow.
  await page.click('.mt-maps-chip[data-ubigeo="150141"] .mt-chip__x');
  await waitFor(() => !MT.project.currentMap().districts.includes('150141'));
  check(true, 'chip × removes the district');
  await page.type('[data-field="districtSearch"]', 'surquillo', { delay: 10 });
  await waitFor(() => !!document.querySelector('.mt-maps-results [data-ubigeo="150141"]'));
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().districts.length === 3);

  /* ---------------------------------------------------------------- 4. texts */
  console.log('\n4. Title, subtitle, Peso');
  await typeInto('[data-field="title"]', 'Lima Moderna (prueba)');
  await waitFor(() => MT.project.currentMap().title === 'Lima Moderna (prueba)', null, 3000);
  await waitFor(() => document.querySelector('.mt-slide__title').textContent === 'Lima Moderna (prueba)');
  check(true, 'title is debounced into the project and shown on the slide');
  check(await ev(() => document.querySelector('.mt-maps-slide.is-active .mt-maps-slide__title').textContent === 'Lima Moderna (prueba)'), 'rail item title updated in place');
  await typeInto('[data-field="peso"]', '15.8%');
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().peso === '15.8%', null, 3000);
  await waitFor(() => /Peso:\s*15\.8%/.test(document.querySelector('.mt-slide__subtitle').textContent));
  check(true, 'Peso written (Enter flushes) and shown as "Peso: 15.8%"');
  await page.click('[data-field="subtitleAuto"]');
  await waitFor(() => MT.project.currentMap().subtitleAuto === false);
  const manual = await cur();
  check(manual.subtitle === '(Miraflores, San Isidro, Surquillo)', `manual subtitle starts from the automatic text (${manual.subtitle})`);
  check(await ev(() => document.activeElement.dataset.field === 'subtitle'), 'manual subtitle input focused');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.type('[data-field="subtitle"]', ', etc.)');
  await page.keyboard.press('Tab');
  await waitFor(() => MT.project.currentMap().subtitle === '(Miraflores, San Isidro, Surquillo, etc.)', null, 3000);
  check(true, 'manual subtitle edited (blur flushes)');
  await page.click('[data-field="subtitleAuto"]');
  await waitFor(() => MT.project.currentMap().subtitleAuto === true);
  await waitFor(() => /\(Miraflores, San Isidro, Surquillo\)/.test(document.querySelector('.mt-slide__subtitle').textContent), null, 3000);
  check(true, 'back to the automatic subtitle');

  /* ---------------------------------------------------------------- 5. chains */
  console.log('\n5. Chains');
  const chainInfo = await ev(() => {
    const rows = [...document.querySelectorAll('.mt-maps-chain')];
    return { n: rows.length, chains: MT.data.chains().length,
      tambo: (document.querySelector('.mt-maps-chain[data-chain="tambo"] input') || {}).checked,
      pvCount: +(document.querySelector('.mt-maps-chain[data-chain="plazavea"] .mt-maps-chain__count') || {}).textContent,
      expect: MT.data.storesForMap(Object.assign({}, MT.project.currentMap(), { chains: { plazavea: true } })).filter((s) => s.chain === 'plazavea').length };
  });
  check(chainInfo.n === chainInfo.chains, `one row per chain (${chainInfo.n})`);
  if (chainInfo.tambo !== undefined) check(chainInfo.tambo === false, 'Tambo is off by default');
  check(chainInfo.pvCount === chainInfo.expect, `Plaza Vea count = stores in the region (${chainInfo.pvCount})`);
  await waitMarkers();
  const hadTottus = await ev(() => MT.legend.items(MT.project.currentMap()).some((r) => r.chainId === 'tottus'));
  await page.click('.mt-maps-chain[data-chain="tottus"]');
  await waitFor(() => MT.project.currentMap().chains.tottus === false);
  check(true, 'clicking a chain row toggles it off');
  await sleep(150);
  check(await ev(() => ![...document.querySelectorAll('.mt-slide__legend-row')].some((r) => r.dataset.chainId === 'tottus')), `TOTTUS gone from the legend${hadTottus ? '' : ' (was not there)'}`);
  check(await ev(() => document.querySelector('.mt-maps-chain[data-chain="tottus"]').classList.contains('is-off')), 'row dimmed when off');
  // Group "Ninguna" / global "Todas".
  await ev(() => [...document.querySelectorAll('.mt-maps-group__head')].find((h) => /supermercados/i.test(h.textContent)).querySelectorAll('.mt-maps-link')[1].click());
  await waitFor(() => ['plazavea', 'tottus', 'wong', 'metro', 'vivanda'].filter((id) => MT.data.hasChain(id)).every((id) => MT.project.currentMap().chains[id] === false));
  check(true, 'group "Ninguna" turns the whole group off');
  await ev(() => document.querySelectorAll('.mt-maps-chains__all .mt-maps-link')[0].click());
  await waitFor(() => MT.data.chains().every((c) => MT.data.chainOn(MT.project.currentMap(), c.id)));
  check(true, 'global "Todas" turns every chain on');
  // Back to the defaults for the rest of the test (Tambo/Oxxo off).
  for (const id of ['tambo', 'oxxo']) {
    if (await ev((id) => !!document.querySelector(`.mt-maps-chain[data-chain="${id}"]`), id)) await page.click(`.mt-maps-chain[data-chain="${id}"]`);
  }
  // Keyboard: the switch is a real checkbox.
  await page.focus('.mt-maps-chain[data-chain="plazavea"] input');
  await page.keyboard.press('Space');
  await waitFor(() => MT.project.currentMap().chains.plazavea === false);
  await page.keyboard.press('Space');
  await waitFor(() => MT.project.currentMap().chains.plazavea === true);
  check(true, 'chain switch works with the keyboard (Space)');
  await screenshot(page, 'm2-chains');

  /* ---------------------------------------------------------------- 6. style */
  console.log('\n6. Logos & legend');
  await openSection('markers');
  await page.click('.mt-maps-style__input[data-style="card"] + .mt-maps-style__face');
  await waitFor(() => MT.project.currentMap().markerStyle === 'card');
  check(await ev(() => document.querySelector('.mt-maps-style__input[data-style="card"]').checked), 'style "Tarjetas" selected');
  await sleep(300);
  await screenshot(page, 'm2-style-card');
  await page.click('.mt-maps-style__input[data-style="dot"] + .mt-maps-style__face');
  await waitFor(() => MT.project.currentMap().markerStyle === 'dot');
  await page.click('.mt-maps-style__input[data-style="badge"] + .mt-maps-style__face');
  await waitFor(() => MT.project.currentMap().markerStyle === 'badge');
  check(true, 'styles switch live (card → dot → badge)');
  const previews = await ev(() => [...document.querySelectorAll('.mt-maps-style__cv')].map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && (d[i] < 200 || d[i + 1] < 200)) n++; return n; }));
  check(previews.every((n) => n > 50), `style previews drawn (${previews.join(', ')} coloured px)`);
  await page.focus('[data-field="markerSize"]');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await waitFor(() => Math.abs(MT.project.currentMap().markerSize - 0.8) < 1e-6, null, 3000);
  check(await ev(() => /80/.test(document.querySelector('.mt-maps-range__val').textContent)), 'size slider with the keyboard → 80 %');
  await ev(() => [...document.querySelectorAll('.mt-maps-sec[data-sec="markers"] .mt-seg__input')].find((i) => i.value === 'count').click());
  await waitFor(() => MT.project.currentMap().legendSort === 'count');
  check(true, 'legend order "Por cantidad"');

  /* ---------------------------------------------------------------- 7. framing */
  console.log('\n7. Framing');
  await openSection('map');
  await ev(() => document.querySelector('[data-field="showBorders"]').click());
  await waitFor(() => MT.project.currentMap().showBorders === true);
  check(true, 'show district borders');
  await ev(() => [...document.querySelectorAll('.mt-maps-sec[data-sec="map"] .mt-seg__input')].find((i) => i.value === 'districts').click());
  await waitFor(() => MT.project.currentMap().fitTo === 'districts');
  check(true, 'fit to districts');
  check(await ev(() => document.querySelector('.mt-maps-sec[data-sec="map"] .mt-maps-status .mt-btn').disabled), '"Volver al automático" disabled while the view is automatic');
  await ev(() => MT.project.updateMap(MT.project.currentMapId(), { view: { center: [-77.03, -12.11], zoomRef: 13.2 } }));
  await waitFor(() => !document.querySelector('.mt-maps-sec[data-sec="map"] .mt-maps-status .mt-btn').disabled);
  await page.click('.mt-maps-sec[data-sec="map"] .mt-maps-status .mt-btn');
  await waitFor(() => MT.project.currentMap().view === null);
  check(true, 'manual view shown and reset to automatic');

  /* ---------------------------------------------------------------- 8. popup + radius */
  console.log('\n8. Store popup and radius');
  await waitForMapIdle(page).catch(() => console.log('  (basemap not idle — continuing)'));
  await waitMarkers();
  const target = await ev(() => {
    const items = MT.mapview.items();
    const it = items.find((x) => x.chainId === 'plazavea') || items[0];
    return it.storeId;
  });
  await page.click(`.mt-marker-hit[data-store-id="${target}"]`);
  await waitFor(() => !!document.querySelector('.mt-maps-pop.is-open'));
  const pop = await ev(() => ({ name: document.querySelector('.mt-maps-pop__name').textContent, id: document.querySelector('.mt-maps-pop').dataset.storeId,
    actions: [...document.querySelectorAll('.mt-maps-pop button')].map((b) => b.textContent.trim()).filter(Boolean) }));
  check(pop.id === target, `popup opens for the clicked marker (${pop.name})`);
  check(pop.actions.some((a) => /Ocultar/.test(a)) && pop.actions.some((a) => /Radio de 1 km/.test(a)) && pop.actions.some((a) => /Base de datos/.test(a)), `popup actions: ${pop.actions.join(' / ')}`);
  await screenshot(page, 'm2-popup');
  await ev(() => [...document.querySelectorAll('.mt-maps-pop .mt-maps-mchip')].find((b) => b.dataset.m === '1000').click());
  await waitFor((id) => MT.project.currentMap().radius.some((r) => r.storeId === id && r.meters === 1000), target);
  check(true, '"Radio de 1 km" adds a 1 km radius');
  check(await ev(() => /1 km/.test(document.querySelector('.mt-maps-pop__label').textContent)), 'popup shows the radius state');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.mt-maps-pop'));
  check(true, 'Esc closes the popup');
  // Keyboard path: Enter on a focused marker opens the popup with focus inside; Esc returns to the marker.
  await sleep(250);
  await ev((id) => document.querySelector(`.mt-marker-hit[data-store-id="${CSS.escape(id)}"]`).focus(), target);
  await page.keyboard.press('Enter');
  await waitFor(() => !!document.querySelector('.mt-maps-pop.is-open') && document.querySelector('.mt-maps-pop').contains(document.activeElement));
  check(true, 'Enter on a focused marker opens the popup and moves focus into it');
  await page.keyboard.press('Escape');
  await waitFor((id) => !document.querySelector('.mt-maps-pop') && document.activeElement && document.activeElement.dataset.storeId === id, target);
  check(true, 'Esc returns focus to the marker');
  check(await ev(() => document.querySelector('.mt-maps-sec[data-sec="radius"] .mt-maps-sec__head').getAttribute('aria-expanded') === 'true'), 'radius section opened');
  const r1 = await ev((id) => { const r = MT.radius.compute(MT.project.currentMap()).find((x) => x.storeId === id); return { same: r.sameChain, comp: r.competitors, n: r.inside.length,
    stats: document.querySelector(`.mt-maps-radius[data-store-id="${id}"] .mt-maps-radius__stats`).textContent }; }, target);
  check(r1.stats.includes(String(r1.same)) && r1.stats.includes(String(r1.comp)), `radius card shows ${r1.same} own / ${r1.comp} competitors (${r1.stats})`);
  await openSection('radius');
  await typeInto(`.mt-maps-radius[data-store-id="${target}"] [data-field="meters"]`, '750');
  await waitFor((id) => MT.project.currentMap().radius.find((r) => r.storeId === id).meters === 750, target, 3000);
  check(true, 'typing 750 in the meters box updates the radius (debounced)');
  await page.click(`.mt-maps-radius[data-store-id="${target}"] .mt-maps-mchip[data-m="2000"]`);
  await waitFor((id) => MT.project.currentMap().radius.find((r) => r.storeId === id).meters === 2000, target);
  check(true, '2 km preset chip');
  await typeInto(`.mt-maps-radius[data-store-id="${target}"] [data-field="meters"]`, '10');
  await page.keyboard.press('Enter');
  await sleep(200);
  check(await ev((id) => !!document.querySelector(`.mt-maps-radius[data-store-id="${id}"] [data-field="meters"].is-invalid`) && MT.project.currentMap().radius.find((r) => r.storeId === id).meters === 2000, target), 'invalid radius (10 m) flagged, not saved');
  await page.keyboard.press('Tab');
  const hasInside = await ev((id) => MT.radius.compute(MT.project.currentMap()).find((x) => x.storeId === id).inside.length, target);
  if (hasInside) {
    await page.click(`.mt-maps-radius[data-store-id="${target}"] .mt-maps-radius__toggle`);
    await waitFor((id) => document.querySelectorAll(`.mt-maps-radius[data-store-id="${id}"] .mt-maps-rrow`).length > 0, target);
    check(await ev((id) => document.querySelectorAll(`.mt-maps-radius[data-store-id="${id}"] .mt-maps-rrow`).length, target) === hasInside, `results list shows the ${hasInside} stores inside, nearest first`);
  }
  // Second radius via the in-section store picker.
  await page.click('[data-action="addRadius"]');
  await waitFor(() => document.activeElement.dataset.field === 'radiusSearch' && document.querySelectorAll('.mt-maps-results--stores [role="option"]').length > 0);
  await page.type('[data-field="radiusSearch"]', 'wong', { delay: 15 });
  await sleep(150);
  const pickable = await ev(() => document.querySelectorAll('.mt-maps-results--stores [role="option"]:not([aria-disabled])').length);
  if (pickable) {
    await page.keyboard.press('Enter');
    await waitFor(() => MT.project.currentMap().radius.length === 2);
    check(true, 'store picker adds a second radius (1 km default)');
  } else {
    await page.keyboard.press('Escape');
    console.log('  (no Wong store in the region — picker add skipped)');
  }
  await sleep(400);
  await screenshot(page, 'm2-radius');
  const dl = await captureDownloads(page);
  await page.click('[data-action="radiusXlsx"]');
  const xlsx = await waitForDownload(dl, /\.xlsx$/, { timeout: 20000 });
  const buf = readFileSync(xlsx);
  check(buf.length > 2000 && buf[0] === 0x50 && buf[1] === 0x4B, `Excel export downloaded (${path.basename(xlsx)}, ${buf.length} bytes)`);

  /* ---------------------------------------------------------------- 9. hide / restore */
  console.log('\n9. Hide and restore a store');
  await waitMarkers();
  const hideId = await ev((skip) => (MT.mapview.items().find((x) => x.storeId !== skip) || {}).storeId, target);
  await page.click(`.mt-marker-hit[data-store-id="${hideId}"]`);
  await waitFor(() => !!document.querySelector('.mt-maps-pop.is-open'));
  await page.click('.mt-maps-pop [data-action="hide"]');
  await waitFor((id) => MT.project.currentMap().hiddenStores.includes(id), hideId);
  check(true, '"Ocultar en esta lámina" adds the store to hiddenStores');
  await sleep(150);
  check(await ev((id) => !MT.mapview.items().some((x) => x.storeId === id), hideId), 'hidden store no longer on the map');
  await openSection('hidden');
  check(await ev((id) => !!document.querySelector(`.mt-maps-hrow[data-store-id="${id}"]`), hideId), 'hidden list shows it');
  await screenshot(page, 'm2-hidden');
  await page.click(`.mt-maps-hrow[data-store-id="${hideId}"] .mt-btn`);
  await waitFor((id) => !MT.project.currentMap().hiddenStores.includes(id), hideId);
  check(true, '"Mostrar" restores it');

  /* ---------------------------------------------------------------- 10. hints */
  console.log('\n10. Hints');
  await ev(() => document.querySelectorAll('.mt-maps-chains__all .mt-maps-link')[1].click());
  await waitFor(() => document.querySelector('.mt-maps-hint[data-kind="chainsOff"]'));
  check(true, 'all chains off → hint with "Activar todas"');
  await screenshot(page, 'm2-hint-chains-off');
  await page.click('.mt-maps-hint .mt-btn');
  await waitFor(() => !document.querySelector('.mt-maps-hint[data-kind="chainsOff"]'));
  check(await ev(() => MT.data.chains().every((c) => MT.data.chainOn(MT.project.currentMap(), c.id))), 'hint action turned the chains back on');
  // With every chain on (Tambo/Oxxo too) a busy area may pass the density threshold → "dense" hint.
  const dense = await ev(() => { const h = document.querySelector('.mt-maps-hint[data-kind="dense"]'); return { shown: !!h, n: MT.mapview.items().length }; });
  if (dense.shown) {
    await screenshot(page, 'm2-hint-dense');
    await page.click('.mt-maps-hint__x');
    await waitFor(() => !document.querySelector('.mt-maps-hint[data-kind="dense"]'));
    check(true, `dense map (${dense.n} markers) → hint offered, dismissable`);
  }
  for (const id of ['tambo', 'oxxo']) {
    if (await ev((id) => !!document.querySelector(`.mt-maps-chain[data-chain="${id}"]`), id)) await ev((id) => document.querySelector(`.mt-maps-chain[data-chain="${id}"] input`).click(), id);
  }

  /* ---------------------------------------------------------------- 11. reorder, duplicate, delete */
  console.log('\n11. Slides: reorder, duplicate, delete');
  const before = await ev(() => MT.project.maps().map((m) => m.id));
  await page.focus('.mt-maps-slide.is-active .mt-maps-slide__main');
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Alt');
  await waitFor((id) => MT.project.maps()[0].id === id, before[1]);
  check(true, 'Alt+↑ moves the slide up');
  check(await ev(() => document.activeElement.classList.contains('mt-maps-slide__main') && document.activeElement.closest('.mt-maps-slide').classList.contains('is-active')), 'focus stays on the moved slide');
  await page.keyboard.press('ArrowDown');
  await waitFor((id) => MT.project.currentMapId() === id, before[0]);
  check(true, 'arrow keys select the next slide');
  // Drag-and-drop: drag slide 1 below slide 2.
  await ev(() => {
    const lis = document.querySelectorAll('.mt-maps-rail__list .mt-maps-slide');
    const src = lis[0], dst = lis[1];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.bottom - 4 };
    dst.dispatchEvent(new DragEvent('dragover', o));
    dst.dispatchEvent(new DragEvent('drop', o));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await waitFor((ids) => MT.project.maps().map((m) => m.id).join() === ids.join(), before);
  check(true, 'drag-and-drop reorders (back to the original order)');
  // Duplicate via the item menu.
  await page.hover('.mt-maps-slide.is-active');
  await page.click('.mt-maps-slide.is-active .mt-maps-slide__more');
  await waitFor(() => document.querySelector('.mt-menu.is-open'));
  await screenshot(page, 'm2-slide-menu');
  await ev(() => [...document.querySelectorAll('.mt-menu__item')].find((b) => /Duplicar/.test(b.textContent)).click());
  await waitFor(() => MT.project.maps().length === 3);
  const dup = await ev(() => ({ cur: MT.project.currentMap().title, idx: MT.project.maps().indexOf(MT.project.currentMap()) }));
  check(/copia/.test(dup.cur), `duplicate selected (${dup.cur})`);
  // Delete with confirmation, then undo, then delete for good.
  await page.click('.mt-maps-slide.is-active .mt-maps-slide__more');
  await waitFor(() => document.querySelector('.mt-menu.is-open'));
  await ev(() => [...document.querySelectorAll('.mt-menu__item')].find((b) => /Eliminar/.test(b.textContent)).click());
  await waitFor(() => document.querySelector('.mt-modal-backdrop.is-open'));
  await screenshot(page, 'm2-delete-confirm');
  await ev(() => document.querySelector('.mt-modal .mt-btn--danger').click());
  await waitFor(() => MT.project.maps().length === 2);
  check(true, 'delete asks for confirmation, then removes the slide');
  const undoBtn = () => [...document.querySelectorAll('.mt-toast')].filter((x) => /Se eliminó/.test(x.textContent)).map((x) => x.querySelector('.mt-toast__action'))[0];
  await waitFor(`(${undoBtn})()`);
  await ev(`(${undoBtn})().click()`);
  await waitFor(() => MT.project.maps().length === 3);
  check(true, 'undo restores the deleted slide');
  const dupId = await ev(() => MT.project.maps().find((m) => /copia/.test(m.title)).id);
  await ev((id) => MT.project.select(id), dupId);
  await page.focus('.mt-maps-slide.is-active .mt-maps-slide__main');
  await page.keyboard.press('Delete');
  await waitFor(() => document.querySelector('.mt-modal-backdrop.is-open'));
  await page.keyboard.press('Enter');   // the confirm button has autofocus
  await waitFor(() => MT.project.maps().length === 2);
  check(true, 'Delete key + Enter deletes the focused slide');
  await ev(() => MT.project.select(MT.project.maps()[1].id));

  /* ---------------------------------------------------------------- 12. thumbnails */
  console.log('\n12. Thumbnails');
  await sleep(700);
  const thumbs = await ev(() => [...document.querySelectorAll('.mt-maps-thumb')].map((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let red = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] > 120 && d[i + 1] < 70 && d[i + 2] < 100) red++;
    return { w: c.width, red: red, drawn: c.dataset.drawn === '1' };
  }));
  check(thumbs.length === 2 && thumbs.every((x) => x.drawn && x.red > 50), `thumbnails drawn with the crimson panel (${thumbs.map((x) => x.w + 'px').join(', ')})`);

  /* ---------------------------------------------------------------- 13. export panel */
  console.log('\n13. Export panel');
  await page.click('.mt-maps-bar__export');
  await waitFor(() => document.querySelector('.mt-maps-popover.is-open'));
  const xp = await ev(() => ({ opts: [...document.querySelectorAll('.mt-maps-xopt')].map((b) => b.dataset.export), focusIn: document.querySelector('.mt-maps-popover').contains(document.activeElement),
    expanded: document.querySelector('.mt-maps-bar__export').getAttribute('aria-expanded') }));
  check(xp.opts.join() === 'pptx,slidePng,mapPng,html', `four export formats (${xp.opts})`);
  check(xp.focusIn && xp.expanded === 'true', 'focus moves into the export panel');
  await screenshot(page, 'm2-export');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.mt-maps-popover.is-open') && document.activeElement.classList.contains('mt-maps-bar__export'));
  check(true, 'Esc closes it and returns focus to the button');
  const m4 = await ev(() => ({ html: typeof (MT.export && MT.export.html), stub: !!(MT.export && MT.export.html && /not-implemented/.test(String(MT.export.html))),
    dialog: typeof (MT.export && MT.export.dialog), run: typeof (MT.export && MT.export.run) }));
  console.log('  M4:', JSON.stringify(m4));
  if (m4.html === 'function' && !m4.stub) {
    // End to end through M4: the interactive HTML of the current slide.
    await captureDownloads(page, dl);
    await page.click('.mt-maps-bar__export');
    await waitFor(() => document.querySelector('.mt-maps-popover.is-open'));
    await page.click('.mt-maps-xopt[data-export="html"]');
    const html = await waitForDownload(dl, /\.html$/, { timeout: 60000 });
    const body = readFileSync(html, 'utf8');
    check(body.length > 5000 && /Lima Moderna \(prueba\)/.test(body), `interactive HTML exported through M4 (${path.basename(html)}, ${Math.round(body.length / 1024)} KB)`);
    await waitFor(() => !document.querySelector('.mt-maps-bar__export.is-busy'), null, 30000);
    check(await ev(() => /Exportar/.test(document.querySelector('.mt-maps-bar__export').textContent)), 'export button back to normal after the export');
  }
  if (m4.dialog === 'function') {
    await page.click('.mt-maps-bar__export');
    await waitFor(() => document.querySelector('.mt-maps-popover.is-open'));
    await page.click('[data-action="exportDialog"]');
    await waitFor(() => document.querySelector('.mt-modal-backdrop.is-open'));
    check(true, '"Más opciones" opens the full export dialog (M4)');
    await screenshot(page, 'm2-export-dialog');
    await page.keyboard.press('Escape');
    await waitFor(() => !document.querySelector('.mt-modal-backdrop'));
  }

  /* ---------------------------------------------------------------- 14. save → open round trip */
  console.log('\n14. Save → open round trip');
  const saved = await ev(() => MT.project.toJSON());
  await captureDownloads(page, dl);
  await ev(() => MT.app.saveProject({ download: true }));
  const file = await waitForDownload(dl, /\.mapa\.json$/);
  const json = readFileSync(file, 'utf8');
  check(!(await ev(() => MT.project.isDirty())), 'project not dirty after saving');
  check(await ev(() => /Guardado/.test(document.querySelector('.mt-maps-proj__state').textContent)), 'rail shows the saved state');
  await ev(() => MT.app.newProject());
  await waitFor(() => MT.project.maps().length === 1 && document.querySelectorAll('.mt-maps-slide').length === 1);
  check(true, 'new project → rail resets to one slide');
  await ev(async (text) => { await MT.project.open(new File([text], 'roundtrip.mapa.json', { type: 'application/json' })); }, json);
  await waitFor(() => MT.project.maps().length === 2 && document.querySelectorAll('.mt-maps-slide').length === 2);
  const reopened = await ev(() => MT.project.toJSON());
  const strip = (s) => { const o = JSON.parse(s); delete o.updated; return o; };
  check(JSON.stringify(strip(reopened).maps) === JSON.stringify(strip(saved).maps), 'maps identical after save → open (districts, chains, radius, hidden, style…)');
  await ev(() => MT.project.select(MT.project.maps().find((m) => /prueba/.test(m.title)).id));
  await sleep(200);
  const insp = await ev(() => ({ title: document.querySelector('[data-field="title"]').value, peso: document.querySelector('[data-field="peso"]').value,
    chips: document.querySelectorAll('.mt-maps-chip').length, radius: document.querySelectorAll('.mt-maps-radius').length }));
  check(insp.title === 'Lima Moderna (prueba)' && insp.peso === '15.8%' && insp.chips === 3 && insp.radius >= 1, `inspector restored (${JSON.stringify(insp)})`);
  await screenshot(page, 'm2-reopened');

  /* ---------------------------------------------------------------- 15. English */
  console.log('\n15. English UI');
  await ev(() => MT.i18n.setLang('en'));
  await sleep(300);
  const en = await ev(() => ({ secs: [...document.querySelectorAll('.mt-maps-sec__title')].map((x) => x.textContent), bar: document.querySelector('.mt-maps-bar__pos').textContent,
    add: document.querySelector('.mt-maps-rail__add').textContent, missing: MT.i18n.missingKeys ? MT.i18n.missingKeys() : [] }));
  check(en.secs[0] === 'Slide text' && en.secs[2] === 'Chains' && /Slide 2 of 2/.test(en.bar) && /New slide/.test(en.add), `inspector, bar and rail re-translated (${en.secs.slice(0, 3).join(', ')})`);
  const miss = Array.isArray(en.missing) ? en.missing : Object.values(en.missing || {}).flat();
  check(!miss.filter((k) => /^maps\./.test(k)).length, 'no missing maps.* keys (ES/EN parity)');
  await screenshot(page, 'm2-en');
  await ev(() => MT.i18n.setLang('es'));
  await sleep(200);

  /* ---------------------------------------------------------------- 16. demo slides + 1280 */
  console.log('\n16. Demo project at 1440 and 1280');
  const demo = readFileSync(path.join(ROOT, 'tools', 'fixtures', 'demo.mapa.json'), 'utf8');
  await ev(async (text) => { await MT.project.open(new File([text], 'demo.mapa.json', { type: 'application/json' })); }, demo);
  await waitFor(() => MT.project.maps().length === 4);
  await waitForMapIdle(page).catch(() => {});
  await sleep(900);
  await screenshot(page, 'm2-demo-1440');
  await ev(() => MT.project.select('demo-trujillo'));
  await waitForMapIdle(page).catch(() => {});
  await sleep(700);
  await screenshot(page, 'm2-demo-trujillo');
  await page.setViewport({ width: 1280, height: 800 });
  await ev(() => MT.project.select('demo-lima-sur'));
  await waitForMapIdle(page).catch(() => {});
  await sleep(900);
  const narrow = await ev(() => ({ overflowX: document.documentElement.scrollWidth > window.innerWidth, insp: document.querySelector('.mt-maps__inspector').getBoundingClientRect().width,
    slide: document.querySelector('.mt-slide').getBoundingClientRect().width }));
  check(!narrow.overflowX && narrow.slide > 600, `1280 px: no horizontal overflow, slide ${Math.round(narrow.slide)} px wide`);
  await screenshot(page, 'm2-demo-1280');
  await page.setViewport({ width: 1440, height: 900 });

  /* ---------------------------------------------------------------- 17. empty project */
  console.log('\n17. Empty project');
  await ev(() => { MT.project.maps().slice().forEach((m) => MT.project.removeMap(m.id)); });
  await waitFor(() => !document.querySelector('.mt-maps__empty').hidden);
  check(await ev(() => /no tiene láminas/.test(document.querySelector('.mt-maps__empty').textContent) && !!document.querySelector('.mt-maps-insp__none')), 'empty project: centre prompt + inspector note');
  await screenshot(page, 'm2-empty');
  await page.click('.mt-maps__empty .mt-btn--primary');
  await waitFor(() => MT.project.maps().length === 1 && document.querySelector('.mt-maps__empty').hidden);
  check(true, '"Crear lámina" creates a slide');
} catch (err) {
  check(false, 'unexpected failure: ' + (err && err.stack || err));
  await screenshot(page, 'm2-failure').catch(() => {});
} finally {
  await sleep(200);
  check(errors.length === 0, `zero console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

/* ---------------------------------------------------------------- 18. no data files at all */
console.log('\n18. Missing data files (fresh checkout while the data is regenerated)');
{
  const bare = await openApp({ lang: 'es', headless, fixtures: 'none', viewport: { width: 1440, height: 900 }, hash: 'mapas' });
  try {
    await bare.page.waitForFunction(() => document.querySelector('.mt-maps .mt-maps-sec'), { timeout: 15000 });
    await sleep(500);
    const info = await bare.page.evaluate(() => ({
      notes: [...document.querySelectorAll('.mt-maps-note')].map((n) => n.textContent),
      rail: document.querySelectorAll('.mt-maps-slide').length, hint: !!document.querySelector('.mt-maps-hint'),
    }));
    check(info.rail === 1 && info.notes.some((n) => /districts\.js/.test(n)) && info.notes.some((n) => /chains\.js/.test(n)),
      `tab still works and explains what is missing (${info.notes.length} notes)`);
    await bare.page.type('[data-field="title"]', ' X');
    await bare.page.waitForFunction(() => /X$/.test(MT.project.currentMap().title), { timeout: 3000 });
    check(true, 'texts still editable without data');
    await screenshot(bare.page, 'm2-missing-data');
  } catch (err) {
    check(false, 'missing-data scenario: ' + (err && err.message || err));
  } finally {
    // The missing data files themselves are expected 404s (as in smoke.mjs); anything else is a bug.
    const unexpected = bare.errors.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
    check(unexpected.length === 0, `zero console errors without data${unexpected.length ? ': ' + unexpected.join(' | ') : ''}`);
    await bare.browser.close();
  }
}
finish();
