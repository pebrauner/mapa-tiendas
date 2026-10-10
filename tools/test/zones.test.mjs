// tools/test/zones.test.mjs — Zonas Nielsen: the data files, the MT.data.zones API and the picker of the Mapas tab.
//
//   node tools/test/zones.test.mjs              all checks (headless Chrome from file://)
//   node tools/test/zones.test.mjs --headful    watch it
//
// 1. Data: data/zonas-nielsen.csv (canonical) → data/zones.js (generated, `build-zones --check`), 15 zones / 114 districts,
//    a district in ONE zone, every code in data/districts.js, the Lima + Callao zones cover all 50 districts of Lima Metropolitana
//    and Callao, and a few zones that must not drift (Metropolitana Sur = Miraflores, San Borja, San Isidro, Surquillo).
// 2. API: available / all / get / byArea / ofDistrict / ofStore / search (accents) / covered.
// 3. Picker (es): section "Zonas Nielsen", pills by area, a pill adds / removes the zone's districts, a fully selected zone is one chip
//    (expandable), removing a district of it leaves a partial pill, a district set that equals a zone shows the zone chip, search by
//    zone (Enter), a name that is both district and zone keeps picking the district, the project stores only districts.
// 4. English UI, keyboard use, the hint texts.
// 5. Without data/zones.js (optional file): the tab works, no zone UI, no console errors beyond the missing file itself.

import { openApp, screenshot, makeChecker, sleep, ROOT } from './lib.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';

const headless = !process.argv.includes('--headful');
const { check, finish } = makeChecker('zones');

/* ---------------------------------------------------------------- 1. data files */
console.log('\n1. Data files');
const gen = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-zones.mjs'), '--check'], { encoding: 'utf8' });
check(gen.status === 0, `data/zones.js = tools/build-zones.mjs of data/zonas-nielsen.csv${gen.status === 0 ? '' : ': ' + (gen.stderr || '').trim()}`);
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(path.join(ROOT, 'data', 'zones.js'), 'utf8'), sandbox, { filename: 'zones.js' });
const Z = sandbox.window.MT_ZONES;
const sb2 = { window: {} };
vm.runInNewContext(readFileSync(path.join(ROOT, 'data', 'districts.js'), 'utf8'), sb2, { filename: 'districts.js' });
const inei = new Map(Object.values(sb2.window.MT_DISTRICTS.objects)[0].geometries.map((g) => [g.properties.ubigeo, g.properties]));
const all = Z.zones.flatMap((z) => z.ubigeos);
check(Z.zones.length === 15 && Z.count === 15, `15 zones (${Z.zones.map((z) => z.name).join(', ')})`);
check(all.length === 114 && new Set(all).size === 114, `114 districts, each in one zone only (${all.length} / ${new Set(all).size} distinct)`);
check(all.every((u) => inei.has(u)), 'every district code exists in data/districts.js');
check(Z.zones.every((z) => z.id && z.name && z.area && z.ubigeos.length), 'every zone has id, name, area and districts');
check(JSON.stringify([...new Set(Z.zones.map((z) => z.area))]) === JSON.stringify(['Lima + Callao', 'Provincias']), 'two areas, in order: Lima + Callao, Provincias');
const limaCallao = [...inei.values()].filter((d) => (d.department === 'Lima' && d.province === 'Lima') || d.department === 'Callao').map((d) => d.ubigeo);
const inLima = new Set(Z.zones.filter((z) => z.area === 'Lima + Callao').flatMap((z) => z.ubigeos));
check(limaCallao.length === 50 && limaCallao.every((u) => inLima.has(u)) && inLima.size === 50,
  `the 7 Lima + Callao zones cover all ${limaCallao.length} districts of Lima Metropolitana and Callao, and only those`);
const byName = Object.fromEntries(Z.zones.map((z) => [z.name, z.ubigeos]));
check(JSON.stringify([...byName['Metropolitana Sur']].sort()) === JSON.stringify(['150122', '150130', '150131', '150141']),
  'Metropolitana Sur = Miraflores, San Borja, San Isidro, Surquillo');
check(byName['Lima Cono Norte'].includes('070106') && byName['Lima Cono Norte'].includes('150110') && byName['Lima Centro'].includes('150101'),
  'Lima Cono Norte has Comas and Ventanilla; Lima Centro has Lima (Cercado)');
check(byName['Trujillo'].includes('130101') && byName['Piura'].includes('200101') && byName['Arequipa'].includes('040101'), 'the provincial city zones hold their city district');
const csv = readFileSync(path.join(ROOT, 'data', 'zonas-nielsen.csv'), 'utf8');
check(csv.charCodeAt(0) === 0xFEFF && (csv.match(/,vecindad,/g) || []).length === 3, 'CSV: BOM, and exactly 3 districts placed by neighbourhood (no stores in the Excel)');

/* ---------------------------------------------------------------- 2-4. in the app */
const app = await openApp({ lang: 'es', headless, viewport: { width: 1440, height: 900 }, hash: 'mapas' });
const { page, errors, browser } = app;
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const cur = () => ev(() => JSON.parse(JSON.stringify(MT.project.currentMap())));
const waitFor = (fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg);
async function openSection(id) {
  const open = await ev((id) => document.querySelector(`.mt-maps-sec[data-sec="${id}"] .mt-maps-sec__head`).getAttribute('aria-expanded') === 'true', id);
  if (!open) { await page.focus(`.mt-maps-sec[data-sec="${id}"] .mt-maps-sec__head`); await page.keyboard.press('Enter'); }
  await page.$eval(`.mt-maps-sec[data-sec="${id}"]`, (el) => el.scrollIntoView({ block: 'start' }));
}
const chips = () => ev(() => [...document.querySelectorAll('.mt-maps-chips .mt-chip')].map((c) => (c.classList.contains('mt-maps-chip--zone') ? 'ZONE:' : c.classList.contains('is-member') ? '·' : '') + c.querySelector('.mt-chip__label').textContent));
const pills = () => ev(() => ({ on: [...document.querySelectorAll('.mt-maps-zone.is-on')].map((b) => b.textContent), partial: [...document.querySelectorAll('.mt-maps-zone.is-partial')].map((b) => b.textContent) }));
const sorted = (a) => JSON.stringify([...a].sort());
async function typeSearch(text) {
  await page.$eval('[data-field="districtSearch"]', (el) => { el.focus(); el.value = ''; });
  await page.type('[data-field="districtSearch"]', text);
  await sleep(300);
}
const results = () => ev(() => [...document.querySelectorAll('.mt-maps-results .mt-maps-opt')].map((o) => (o.dataset.zone ? 'ZONE ' : o.classList.contains('mt-maps-opt--province') ? 'PROV ' : 'DIST ') + o.querySelector('.mt-maps-opt__name').textContent));
const clearAllDistricts = () => ev(() => MT.project.updateMap(MT.project.currentMapId(), { districts: [] }));

try {
  await waitFor(() => MT.app && MT.app.booted === true && document.querySelector('.mt-maps .mt-maps-sec'), null, 20000);
  await openSection('districts');

  console.log('\n2. MT.data.zones API');
  const api = await ev(() => {
    const Z = MT.data.zones;
    const ms = Z.get('metropolitana-sur'), cn = Z.get('lima-cono-norte');
    const cov = Z.covered(ms.ubigeos.concat(['150101']));
    const cov2 = Z.covered(ms.ubigeos.slice(1));
    const store = MT.data.stores().find((s) => s.ubigeo === '150122');
    return {
      available: Z.available, n: Z.all().length, areas: Z.byArea().map((g) => g.area + ':' + g.zones.length),
      ofD: Z.ofDistrict('150122') && Z.ofDistrict('150122').name, ofNone: Z.ofDistrict('010101'), ofStore: Z.ofStore(store) && Z.ofStore(store).name, ofStoreNone: Z.ofStore({ ubigeo: '010101' }),
      searchAcc: Z.search('huanuco').map((z) => z.name), searchWords: Z.search('cono sur').map((z) => z.name), searchNone: Z.search('zzzz').length,
      covZones: cov.zones.map((z) => z.name), covRest: cov.rest, cov2Zones: cov2.zones.length, cov2Rest: cov2.rest.length, cn: cn.ubigeos.length,
    };
  });
  check(api.available && api.n === 15 && api.areas.join() === 'Lima + Callao:7,Provincias:8', `available, 15 zones, areas ${api.areas.join(' / ')}`);
  check(api.ofD === 'Metropolitana Sur' && api.ofNone === null && api.ofStore === 'Metropolitana Sur' && api.ofStoreNone === null, 'ofDistrict / ofStore: the zone of a store is its district\'s zone; none outside the zones');
  check(api.searchAcc.join() === 'Huánuco' && api.searchWords.join() === 'Lima Cono Sur' && api.searchNone === 0, 'search is accent-insensitive and word based');
  check(api.covZones.join() === 'Metropolitana Sur' && api.covRest.join() === '150101' && api.cov2Zones === 0 && api.cov2Rest === 3, 'covered(): the zones fully inside a district list, and the rest');

  console.log('\n3. Picker in the Mapas tab (es)');
  const head = await ev(() => ({
    title: document.querySelector('.mt-maps-sec[data-sec="districts"] .mt-maps-sec__title, .mt-maps-sec[data-sec="districts"] .mt-maps-sec__head')?.textContent.trim(),
    ph: document.querySelector('[data-field="districtSearch"]').placeholder, start: document.querySelector('.mt-maps-start__text')?.textContent,
    areas: [...document.querySelectorAll('.mt-maps-zones__area')].map((a) => a.textContent), pills: document.querySelectorAll('.mt-maps-zone').length,
    aria: document.querySelector('.mt-maps-zones').getAttribute('aria-label'), noOldMenu: !document.querySelector('.mt-maps-presets'),
  }));
  check(/Zonas Nielsen/.test(head.title), `section title is "Zonas Nielsen" (${head.title})`);
  check(head.ph === 'Escribe una zona, distrito o provincia…' && /zona Nielsen/.test(head.start), 'search placeholder and start hint mention zones');
  check(head.areas.join() === 'Lima + Callao,Provincias' && head.pills === 15 && head.aria === 'Zonas Nielsen', 'two area groups, 15 pills, the group is labelled');
  check(head.noOldMenu, 'the old "Zonas de Lima" dropdown is gone');
  await screenshot(page, 'zones-picker-es');

  const ms = Z.zones.find((z) => z.name === 'Metropolitana Sur');
  await page.click('.mt-maps-zone[data-zone="metropolitana-sur"]');
  await waitFor((n) => MT.project.currentMap().districts.length === n, ms.ubigeos.length);
  let m = await cur();
  check(sorted(m.districts) === sorted(ms.ubigeos), 'a pill adds exactly the districts of the zone');
  check(JSON.stringify(await chips()) === JSON.stringify(['ZONE:Metropolitana Sur']), 'a fully selected zone is ONE chip');
  let pl = await pills();
  const pressed = await ev(() => document.querySelector('.mt-maps-zone[data-zone="metropolitana-sur"]').getAttribute('aria-pressed'));
  check(pl.on.join() === 'Metropolitana Sur' && pl.partial.length === 0 && pressed === 'true', 'the pill is on (is-on, aria-pressed=true)');
  const sum = await ev(() => document.querySelector('.mt-maps-sec[data-sec="districts"] .mt-maps-sec__summary').textContent);
  check(sum === '1', `the section badge counts what the chips show: one zone = 1 (${sum})`);
  const sub = await ev(() => MT.data.subtitleFor(MT.project.currentMap()));
  check(sub === '(Miraflores, San Borja, San Isidro, Surquillo)', `the automatic subtitle still lists the districts: ${sub}`);
  const nStores = await ev(() => MT.data.storesForMap(MT.project.currentMap()).length);
  const expectStores = await ev((u) => MT.data.stores().filter((s) => u.includes(s.ubigeo) && s.status !== 'closed').length, ms.ubigeos);
  check(nStores > 0 && nStores <= expectStores, `the map shows stores of the zone (${nStores} of ${expectStores} non-closed; chains toggled off are left out)`);

  // expand the chip, remove one district → individual chips + partial pill
  await page.click('.mt-maps-chip__zone');
  await sleep(150);
  const open = await chips();
  check(open[0] === 'ZONE:Metropolitana Sur' && open.length === 5 && open.slice(1).every((c) => c.startsWith('·')), `expanding shows its 4 districts (${open.join(', ')})`);
  const exp = await ev(() => document.querySelector('.mt-maps-chip__zone').getAttribute('aria-expanded'));
  check(exp === 'true', 'the chip button reports aria-expanded=true');
  await page.evaluate(() => [...document.querySelectorAll('.mt-maps-chip.is-member')].find((c) => c.querySelector('.mt-chip__label').textContent === 'Surquillo').querySelector('.mt-chip__x').click());
  await waitFor(() => MT.project.currentMap().districts.length === 3);
  pl = await pills();
  const ptitle = await ev(() => document.querySelector('.mt-maps-zone[data-zone="metropolitana-sur"]').title);
  const plabel = await ev(() => document.querySelector('.mt-maps-zone[data-zone="metropolitana-sur"]').getAttribute('aria-label'));
  check(pl.on.length === 0 && pl.partial.join() === 'Metropolitana Sur' && /Falta 1 por agregar/.test(ptitle), `removing one district: the zone chip is gone, the pill is partial (${ptitle})`);
  check(plabel === 'Metropolitana Sur, Falta 1 por agregar', `a partial pill says so in its accessible name (${plabel})`);
  check((await chips()).length === 3 && (await chips()).every((c) => !c.startsWith('ZONE')), 'its 3 remaining districts are individual chips');
  // a pill completes the zone; a second click removes it
  await page.click('.mt-maps-zone[data-zone="metropolitana-sur"]');
  await waitFor((n) => MT.project.currentMap().districts.length === n, ms.ubigeos.length);
  check(JSON.stringify(await chips()) === JSON.stringify(['ZONE:Metropolitana Sur']), 'a partial pill adds only the missing districts and the chip is back');
  await page.click('.mt-maps-zone[data-zone="metropolitana-sur"]');
  await waitFor(() => MT.project.currentMap().districts.length === 0);
  check((await chips()).length === 0 && (await pills()).on.length === 0, 'a second click removes the whole zone');

  // adding the districts one by one that make up a zone shows the zone chip
  await ev((u) => MT.project.updateMap(MT.project.currentMapId(), { districts: ['150101'].concat(u) }), ms.ubigeos);
  await waitFor((n) => MT.project.currentMap().districts.length === n, ms.ubigeos.length + 1);
  const mixed = await chips();
  check(mixed.length === 2 && mixed[0] === 'ZONE:Metropolitana Sur' && mixed[1] === 'Lima', `a zone's districts + one more: zone chip, then the district (${mixed.join(', ')})`);
  // the zone chip's × removes only that zone's districts
  await page.click('.mt-maps-chip--zone .mt-chip__x');
  await waitFor(() => MT.project.currentMap().districts.length === 1);
  m = await cur();
  check(m.districts.join() === '150101', 'the zone chip × removes the zone\'s districts and keeps the others');
  await clearAllDistricts();

  // two zones, project keeps only districts
  await page.click('.mt-maps-zone[data-zone="lima-centro"]');
  await page.click('.mt-maps-zone[data-zone="trujillo"]');
  await waitFor(() => MT.project.currentMap().districts.length === 3 + 9);
  m = await cur();
  const saved = await ev(() => JSON.stringify(MT.project.currentMap()));
  check(!/zone|zona|nielsen/i.test(JSON.stringify(Object.keys(m))) && m.districts.length === 12, 'the slide stores only its districts (no new field: old projects and files keep working)');
  const state = await chips();
  check(state.join() === 'ZONE:Lima Centro,ZONE:Trujillo', `two zones from two areas (${state.join(', ')})`);
  await page.reload({ waitUntil: 'load' });
  await waitFor(() => MT.app && MT.app.booted === true && document.querySelector('.mt-maps-chips'), null, 20000);
  await openSection('districts');
  check(JSON.stringify(await chips()) === JSON.stringify(['ZONE:Lima Centro', 'ZONE:Trujillo']) && (await pills()).on.length === 2, 'after a reload the zones are still shown as zones');
  await clearAllDistricts();

  // search
  await typeSearch('cono sur');
  let r = await results();
  check(r.length === 1 && r[0] === 'ZONE Lima Cono Sur', `search "cono sur" offers the zone (${r.join(' | ')})`);
  const opt = await ev(() => document.querySelector('.mt-maps-opt--zone .mt-maps-opt__sub').textContent + ' || ' + document.querySelector('.mt-maps-opt--zone .mt-maps-opt__count').textContent);
  check(/Zona Nielsen · Lima \+ Callao · 12 distritos/.test(opt) && /tiendas/.test(opt), `the option says what it is: ${opt}`);
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().districts.length === 12);
  check(JSON.stringify(await chips()) === JSON.stringify(['ZONE:Lima Cono Sur']), 'Enter on a zone adds it');
  await typeSearch('cono sur');
  r = await results();
  const dis = await ev(() => document.querySelector('.mt-maps-opt--zone').classList.contains('is-added'));
  check(dis, 'a zone already on the slide is marked "ya está" in the results');
  await page.keyboard.press('Escape');
  await clearAllDistricts();
  await typeSearch('trujillo');
  r = await results();
  check(r[0] === 'DIST Trujillo' && r.includes('ZONE Trujillo'), 'a name that is both district and zone lists the district first (Enter keeps picking the district) and the zone below');
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().districts.length === 1);
  m = await cur();
  check(m.districts.join() === '130101', 'Enter on "trujillo" adds the district Trujillo, not the zone');
  await clearAllDistricts();

  // the empty-state card of the map and the slide list speak of zones
  const empty = await ev(() => ({ notice: document.querySelector('.mt-map-notice, .mt-mapview__notice, [data-notice]')?.textContent || document.body.textContent.match(/Elige las zonas Nielsen/)?.[0] || '', rail: document.querySelector('.mt-maps-slide__meta, .mt-maps-slide')?.textContent }));
  check(/Elige las zonas Nielsen|Elegir zonas/.test(empty.notice) || /Elige las zonas Nielsen/.test(await ev(() => document.body.innerText)), 'the empty map card says "Elige las zonas Nielsen"');
  check(/Sin zonas ni distritos aún/.test(empty.rail || ''), 'the slide list says "Sin zonas ni distritos aún"');

  console.log('\n3b. Review fixes: focus, expanded zones, search order, groups');
  // keyboard: removing a loose district next to a complete zone must not jump onto the zone's ×
  await ev(() => MT.project.updateMap(MT.project.currentMapId(), { districts: ['150122', '150130', '150105', '150101', '150128'] }));   // Miraflores, San Borja + Lima Centro
  await waitFor(() => document.querySelectorAll('.mt-maps-chips .mt-chip').length === 3);
  check(JSON.stringify(await chips()) === JSON.stringify(['ZONE:Lima Centro', 'Miraflores', 'San Borja']), `chips: the complete zone first, then the loose districts (${(await chips()).join(', ')})`);
  await page.focus('.mt-maps-chip[data-ubigeo="150122"] .mt-chip__x');
  await page.keyboard.press('Enter');
  await sleep(200);
  const foc = await ev(() => { const a = document.activeElement; const chip = a && a.closest('.mt-chip'); return chip ? (chip.dataset.zone ? 'zone ' + chip.dataset.zone : 'district ' + chip.dataset.ubigeo) : (a && a.tagName); });
  check(foc === 'district 150130', `after removing Miraflores by keyboard the focus is on the next chip's × (San Borja), not the zone's (${foc})`);
  await clearAllDistricts();
  // keyboard: the expander keeps the focus when the chips are rebuilt
  await page.click('.mt-maps-zone[data-zone="arequipa"]');
  await waitFor(() => MT.project.currentMap().districts.length === 19);
  await page.focus('.mt-maps-chip__zone');
  await page.keyboard.press('Enter');
  await sleep(200);
  const f2 = await ev(() => { const a = document.activeElement; return { onZoneBtn: !!(a && a.classList.contains('mt-maps-chip__zone')), expanded: a && a.getAttribute('aria-expanded'), members: document.querySelectorAll('.mt-maps-chip.is-member').length, more: !!document.querySelector('.mt-maps-chipmore') }; });
  check(f2.onZoneBtn && f2.expanded === 'true', 'after Enter on the zone chip the focus stays on its button and it reports aria-expanded=true');
  check(f2.members === 19 && !f2.more, `an opened zone with 19 districts (Arequipa) shows all of them, no "+N más" (${f2.members})`);
  await page.keyboard.press('Space');
  await sleep(200);
  check((await ev(() => document.activeElement.getAttribute('aria-expanded'))) === 'false', 'Space collapses it and the focus is still there');
  await clearAllDistricts();
  // the badge: a zone + 2 loose districts = 3 chips
  await ev(() => MT.project.updateMap(MT.project.currentMapId(), { districts: ['150105', '150101', '150128', '150122', '150130'] }));
  await waitFor(() => document.querySelectorAll('.mt-maps-chips .mt-chip').length === 3);
  const badge = await ev(() => document.querySelector('.mt-maps-sec[data-sec="districts"] .mt-maps-sec__summary').textContent);
  check(badge === '3', `badge = zone chips + loose districts (${badge})`);
  await clearAllDistricts();
  // search order: the zone of a city name is on screen without scrolling (row <= 5), the district still first
  await typeSearch('trujillo');
  r = await results();
  const zi = r.indexOf('ZONE Trujillo');
  check(r[0] === 'DIST Trujillo' && zi > 0 && zi <= 4, `"trujillo": the district first, the zone within the first 5 rows (row ${zi + 1})`);
  await page.keyboard.press('Escape');
  // area groups are real groups, named by their heading
  const groups = await ev(() => [...document.querySelectorAll('.mt-maps-zones__row')].map((g) => ({ role: g.getAttribute('role'), name: document.getElementById(g.getAttribute('aria-labelledby')).textContent })));
  check(JSON.stringify(groups) === JSON.stringify([{ role: 'group', name: 'Lima + Callao' }, { role: 'group', name: 'Provincias' }]), 'each area is a labelled group (Lima + Callao, Provincias)');

  console.log('\n4. Keyboard and English');
  await page.focus('.mt-maps-zone[data-zone="lima-oriente"]');
  await page.keyboard.press('Space');
  await waitFor(() => MT.project.currentMap().districts.length === 8);
  check((await pills()).on.join() === 'Lima Oriente', 'a pill is a button: Space toggles it from the keyboard');
  await page.keyboard.press('Enter');
  await waitFor(() => MT.project.currentMap().districts.length === 0);
  check(true, 'and Enter toggles it back');
  await clearAllDistricts();
  await ev(() => MT.i18n.setLang('en'));
  await sleep(400);
  await openSection('districts');
  const en = await ev(() => ({
    title: document.querySelector('.mt-maps-sec[data-sec="districts"] .mt-maps-sec__head').textContent, areas: [...document.querySelectorAll('.mt-maps-zones__area')].map((a) => a.textContent),
    ph: document.querySelector('[data-field="districtSearch"]').placeholder, start: document.querySelector('.mt-maps-start__text')?.textContent, aria: document.querySelector('.mt-maps-zones').getAttribute('aria-label'),
  }));
  check(/Zonas Nielsen/.test(en.title) && en.aria === 'Zonas Nielsen', `English: the section is still "Zonas Nielsen" (${en.title.trim()})`);
  check(en.areas.join() === 'Lima + Callao,Provinces' && en.ph === 'Type a zone, district or province…' && /Nielsen zone/.test(en.start), 'English: area names, placeholder and hint');
  await page.click('.mt-maps-zone[data-zone="chimbote"]');
  await waitFor(() => MT.project.currentMap().districts.length === 5);
  const enChip = await ev(() => document.querySelector('.mt-maps-chip--zone').textContent.trim() + ' | ' + document.querySelector('.mt-maps-chip__zone').getAttribute('aria-label'));
  check(/Chimbote.*5 districts/.test(enChip) && /Show the districts of Chimbote/.test(enChip), `English: zone chip and its button label (${enChip})`);
  await screenshot(page, 'zones-picker-en');
  await ev(() => MT.i18n.setLang('es'));
  check(errors.length === 0, `zero console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} catch (err) {
  check(false, 'picker scenario: ' + (err && err.stack || err));
} finally {
  await browser.close();
}

/* ---------------------------------------------------------------- 5. without zones.js */
console.log('\n5. Without data/zones.js (optional data file)');
{
  const bare = await openApp({ lang: 'es', headless, viewport: { width: 1440, height: 900 }, hash: 'mapas' });
  try {
    rmSync(path.join(bare.dir, 'data', 'zones.js'), { force: true });
    await bare.page.reload({ waitUntil: 'load' });
    await bare.page.waitForFunction(() => MT.app && MT.app.booted === true && document.querySelector('.mt-maps .mt-maps-sec'), { timeout: 20000 });
    const info = await bare.page.evaluate(() => ({ available: MT.data.zones.available, pills: document.querySelectorAll('.mt-maps-zone').length, group: !!document.querySelector('.mt-maps-zones'), search: !!document.querySelector('[data-field="districtSearch"]') }));
    check(info.available === false && info.pills === 0 && !info.group && info.search, 'no zones: no pills, the district search is still there');
    const txt = await bare.page.evaluate(() => ({ ph: document.querySelector('[data-field="districtSearch"]').placeholder, notes: [...document.querySelectorAll('.mt-maps-note')].map((n) => n.textContent).join(' | '), start: (document.querySelector('.mt-maps-start__text') || {}).textContent || '' }));
    check(txt.ph === 'Escribe un distrito o provincia…' && !/zona/i.test(txt.start) && /zones\.js/.test(txt.notes), `no zones: the texts do not promise zones, and a note says why (${txt.notes.slice(0, 60)}…)`);
    await bare.page.$eval('[data-field="districtSearch"]', (el) => el.focus());
    await bare.page.type('[data-field="districtSearch"]', 'miraflores');
    await sleep(300);
    await bare.page.keyboard.press('Enter');
    await bare.page.waitForFunction(() => MT.project.currentMap().districts.length === 1, { timeout: 5000 });
    check(true, 'districts can still be picked');
    const unexpected = bare.errors.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
    check(unexpected.length === 0, `no console errors besides the missing file${unexpected.length ? ': ' + unexpected.join(' | ') : ''}`);
  } catch (err) {
    check(false, 'without zones.js: ' + (err && err.stack || err));
  } finally {
    await bare.browser.close();
  }
}
finish();
