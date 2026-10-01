// tools/test/osm-rules.test.mjs — the in-app OSM scan (js/osm.js) judges OpenStreetMap elements with the SAME
// declarative rules as the seed merge: data/chains.js (window.MT_CHAINS[].osm + window.MT_OSM_RULES), schema in
// tools/seed/OSM-RULES.md. Runs on the real data (file://, headless Chrome).
//
//   node tools/test/osm-rules.test.mjs
//
// 1. Port parity: MT.osm.classifyTags = tools/seed/osm-classify.mjs (chain, via, kind, reason, noCoords, doubt) on the
//    177 fixtures of tools/seed/osm-rules-fixtures.json and on every element of tools/seed/osm-raw.json, and = the
//    decisions the merge logged (tools/seed/merge-log.json).
// 2. Overpass pre-filter: the query MT.osm.buildQuery builds from the rules lets through every element the
//    classifier assigns to a chain (its ERE, run here as a JS regex on the RAW tags, and the QID filter).
// 3. Areas: the seed's raw OSM elements of the 4 demo areas (Lima Metropolitana Sur, Lima Cono Sur, Trujillo,
//    Chimbote) and of all Peru go through the app pipeline (classify → cluster → area) and are compared with the
//    stores.csv rows from OSM (source=osm) of the same area. Every difference is listed with its reason; the only
//    accepted reason is "weak element confirmed by the official list" (the app proposes it as doubtful).
// 4. End-to-end: MT.osm.scan of each demo area with Overpass answering the seed's raw elements → nothing new
//    except doubtful ones, nothing "not found", every OSM store of the area matched by its own OSM id.
// 5. Real rules: look-alikes and exclusions of OSM-RULES.md §5, closed, weak, brand / name order.
// 6. Cadenas tab, advanced section: every osm key shown and editable; saving keeps the others; the tester.
import { openApp, makeChecker, screenshot, sleep, ROOT } from './lib.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { compileOsmRules, classifyOsm } from '../seed/osm-classify.mjs';

const { check, finish } = makeChecker('osm-rules');
const SEED = path.join(ROOT, 'tools', 'seed');
const raw = JSON.parse(readFileSync(path.join(SEED, 'osm-raw.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(path.join(SEED, 'osm-rules-fixtures.json'), 'utf8')).fixtures;
const mergeLog = JSON.parse(readFileSync(path.join(SEED, 'merge-log.json'), 'utf8'));
const demo = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'fixtures', 'demo.mapa.json'), 'utf8'));
// Reference classification in Node, from the published data/chains.js.
const sb = { window: {} };
vm.runInNewContext(readFileSync(path.join(ROOT, 'data', 'chains.js'), 'utf8'), sb);
const REF = compileOsmRules(sb.window.MT_CHAINS, sb.window.MT_OSM_RULES);
const key = (e) => e.type[0] + e.id;
// The seed's raw elements as Overpass returns them (nodes: lat/lon; ways and relations: center).
const overpassEl = (e) => (e.type === 'node' ? { type: e.type, id: e.id, lat: e.lat, lon: e.lng, tags: e.tags } : { type: e.type, id: e.id, center: { lat: e.lat, lon: e.lng }, tags: e.tags });
const elements = raw.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng)).map(overpassEl);

const { browser, page, errors, injected } = await openApp({ lang: 'es', viewport: { width: 1440, height: 900 }, hash: 'base' });
try {
  check(!injected.includes('data/chains.js') && !injected.includes('data/stores.js'), `real data/chains.js and data/stores.js loaded (injected: ${injected.join(', ') || 'none'})`);

  /* ------------------------------------------------------------------ 1. port parity */
  console.log('\n1. MT.osm.classifyTags = tools/seed/osm-classify.mjs');
  const src = await page.evaluate(() => ({ source: MT.osm.globalRulesSource(), same: JSON.stringify(MT.osm.BUILTIN_RULES) === JSON.stringify(window.MT_OSM_RULES),
    keys: MT.data.chains().filter((c) => !c.unknown).every((c) => MT.data.OSM_KEYS.every((k) => k in c.osm)) }));
  check(src.source === 'file' && src.keys, 'the app reads MT_OSM_RULES and every per-chain osm key from data/chains.js');
  check(src.same, 'the built-in fallback copy of the cross-chain rules = the published MT_OSM_RULES (no drift)');
  const appFx = await page.evaluate((fx) => { const R = MT.osm.compile(); return fx.map((f) => MT.osm.classifyTags(f.tags, R)); }, fixtures);
  const fxBad = fixtures.filter((f, i) => {
    const a = appFx[i], e = f.expect;
    return a.chain !== e.chain || (a.via || null) !== (e.via || null) || (a.kind || null) !== (e.kind || null) || !!a.noCoords !== !!e.noCoords;
  });
  check(fxBad.length === 0, `tools/seed/osm-rules-fixtures.json: ${fixtures.length - fxBad.length}/${fixtures.length} fixtures give the expected {chain, via, kind, noCoords}` +
    (fxBad.length ? ' — ' + fxBad.slice(0, 5).map((f) => f.key).join(', ') : ''));
  const appRaw = await page.evaluate((els) => { const R = MT.osm.compile(); return els.map((e) => MT.osm.classifyTags(e.tags, R)); }, raw);
  const norm = (x) => JSON.stringify({ chain: x.chain, via: x.via || null, kind: x.kind || null, reason: x.reason || null, noCoords: !!x.noCoords, doubt: x.doubt || null });
  const rawBad = raw.filter((e, i) => norm(appRaw[i]) !== norm(classifyOsm(e.tags, REF)));
  check(rawBad.length === 0, `tools/seed/osm-raw.json: all ${raw.length} elements classified like the reference (chain, via, kind, reason, noCoords, doubt)` +
    (rawBad.length ? ' — ' + rawBad.slice(0, 5).map(key).join(', ') : ''));
  const logged = new Map(mergeLog.osm.map((x) => [x.key, x]));
  const logBad = raw.filter((e, i) => {
    const l = logged.get(key(e)), a = appRaw[i];
    return l ? (l.chain !== a.chain || l.via !== a.via || l.kind !== a.kind) : a.chain !== null;
  });
  const kinds = {};
  appRaw.forEach((a) => { const k = a.chain ? a.kind : 'no chain'; kinds[k] = (kinds[k] || 0) + 1; });
  check(logBad.length === 0 && logged.size === appRaw.filter((a) => a.chain).length,
    `= the merge's logged decisions (tools/seed/merge-log.json, ${logged.size} chain-matched elements): ${JSON.stringify(kinds)}` + (logBad.length ? ' — ' + logBad.slice(0, 5).map(key).join(', ') : ''));

  /* ------------------------------------------------------------------ 2. pre-filter */
  console.log('\n2. Overpass pre-filter built from the rules');
  const q = await page.evaluate(() => {
    const ids = MT.data.chains().filter((c) => !c.unknown).map((c) => c.id);
    const query = MT.osm.buildQuery({ bbox: [-81.4, -18.4, -68.6, -0.03], chains: ids });
    const name = /nwr\.all\["name"~"(.*)",i\];/.exec(query), qid = /nwr\.all\["brand:wikidata"~"(.*)"\];/.exec(query);
    const sel = [...query.matchAll(/^ {2}nwr\["([^"]+)"\]\(/gm)].map((m) => m[1]);
    const flt = [...query.matchAll(/^ {2}nwr\.all\["([^"]+)"~/gm)].map((m) => m[1]);
    return { query, ere: name && name[1], qid: qid && qid[1], sel, flt };
  });
  check(q.sel.join() === 'name,name:es,brand,brand:wikidata' && q.flt.join() === 'name,name:es,brand,brand:wikidata',
    `query selects and filters the keys of MT_OSM_RULES (nameKeys + brandKeys, wikidataKeys): ${q.sel.join(', ')}`);
  check(!/[^\x00-\x7F]/.test(q.query) && !/\\/.test(q.query), 'query is pure ASCII, without backslashes');
  const BS = String.fromCharCode(92);
  const ereJs = new RegExp(q.ere.split('[[:space:]]').join(BS + 's').split('[^[:space:]]').join(BS + 'S'), 'i');
  const qidJs = new RegExp(q.qid);
  const lost = raw.filter((e, i) => appRaw[i].chain && !(['name', 'name:es', 'brand'].some((k) => e.tags[k] && ereJs.test(e.tags[k])) || (e.tags['brand:wikidata'] && qidJs.test(e.tags['brand:wikidata']))));
  check(lost.length === 0, `every element the classifier assigns to a chain passes the query filter (${appRaw.filter((a) => a.chain).length} elements, raw tags, unanchored ERE)` +
    (lost.length ? ' — lost: ' + lost.slice(0, 5).map((e) => key(e) + ' ' + e.tags.name).join(', ') : ''));

  /* ------------------------------------------------------------------ 3. areas vs stores.csv */
  console.log('\n3. App pipeline on the seed\'s raw elements vs the stores.csv rows from OSM');
  const dbOsm = await page.evaluate(() => MT.data.stores({ includeClosed: true }).filter((s) => s.source === 'osm').map((s) => ({ id: s.id, chain: s.chain, ubigeo: s.ubigeo, status: s.status })));
  const mergeKind = new Map(mergeLog.osm.map((x) => [x.key, x.kind]));
  const areas = demo.maps.map((m) => ({ id: m.id, title: m.title, ubigeos: m.districts })).concat([{ id: 'peru', title: 'Todo el Perú', ubigeos: null }]);
  for (const a of areas) {
    const set = a.ubigeos ? new Set(a.ubigeos) : null;
    const res = await page.evaluate((els, ubigeos) => {
      // The elements a scan of the area would fetch: the tiles' bbox (+ 0.02° margin), every chain.
      let list = els;
      if (ubigeos) {
        const b = MT.data.districts.unionBbox(ubigeos), m = 0.02;
        list = els.filter((e) => { const p = e.center || e; return p.lon >= b[0] - m && p.lon <= b[2] + m && p.lat >= b[1] - m && p.lat <= b[3] + m; });
      }
      const ids = MT.data.chains().filter((c) => !c.unknown).map((c) => c.id);
      const r = MT.osm.process(list, { chains: ids, ubigeos: ubigeos || undefined, db: [] });
      return { fetched: list.length, stats: r.stats, proposals: r.proposals.map((s) => ({ id: s.id, chain: s.chain, kind: s._kind, noCoords: s._noCoords, ubigeo: s.ubigeo, members: s._members })) };
    }, elements, a.ubigeos);
    const strong = new Map(res.proposals.filter((p) => p.kind === 'shop' || p.kind === 'building').map((p) => [p.id, p]));
    const weak = new Map(res.proposals.filter((p) => p.kind === 'weak').map((p) => [p.id, p]));
    const rows = dbOsm.filter((s) => !set || set.has(s.ubigeo));
    const rowIds = new Set(rows.map((s) => s.id));
    const diffs = [], accepted = [];
    let same = 0;
    for (const s of rows) {
      const p = strong.get(s.id);
      if (p) { if (p.chain === s.chain) same++; else diffs.push(`${s.id}: chain ${p.chain} in the app, ${s.chain} in stores.csv`); continue; }
      const w = weak.get(s.id);
      if (w && w.chain === s.chain && mergeKind.get(s.id.slice(4)) === 'weak') { accepted.push(`${s.id} (${s.chain}): weak in OSM, confirmed by the official list → doubtful proposal`); continue; }
      diffs.push(`${s.id} (${s.chain}, ${s.status}) only in stores.csv (merge kind: ${mergeKind.get(s.id.slice(4)) || '—'}${w ? ', app: weak' : ''})`);
    }
    for (const p of strong.values()) if (!rowIds.has(p.id)) diffs.push(`${p.id} (${p.chain}, ${p.kind}) only in the app (${dbOsm.some((s) => s.id === p.id) ? 'stores.csv puts it in another district' : 'not in stores.csv'})`);
    const n = (k) => res.proposals.filter((p) => p.kind === k).length;
    check(diffs.length === 0, `${a.title}${a.ubigeos ? ` (${a.ubigeos.length} districts, ${res.fetched} raw elements)` : ` (${res.fetched} raw elements)`}: ` +
      `${same} of ${rows.length} OSM rows of stores.csv proposed with the same id and chain; ${accepted.length} weak-confirmed (doubtful); app: ${n('shop')} shop + ${n('building')} building + ${n('weak')} weak + ${n('closed')} closed, ` +
      `${res.stats.excluded} excluded` + (diffs.length ? '\n      ' + diffs.slice(0, 12).join('\n      ') : ''));
    if (accepted.length) console.log('      accepted: ' + accepted.join('\n      accepted: '));
  }

  /* ------------------------------------------------------------------ 4. mocked scans */
  console.log('\n4. MT.osm.scan with Overpass answering the seed\'s raw elements');
  for (const m of demo.maps) {
    const r = await page.evaluate(async (els, ubigeos) => {
      const real = MT.geo.overpass;
      let queries = 0;
      MT.geo.overpass = (query) => {
        queries++;
        const b = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/.exec(query).slice(1).map(Number); // S,W,N,E
        const inside = els.filter((e) => { const p = e.center || e; return p.lat >= b[0] && p.lat <= b[2] && p.lon >= b[1] && p.lon <= b[3]; });
        return Promise.resolve({ json: { elements: inside }, endpoint: 'mock', timestamp: '2026-10-01T01:07:00Z' });
      };
      try {
        const ids = MT.data.chains().filter((c) => !c.unknown).map((c) => c.id);
        const res = await MT.osm.scan({ ubigeos, chains: ids });
        return { queries, newStrong: res.new.filter((s) => !s._weak).map((s) => s.id), newWeak: res.new.filter((s) => s._weak).map((s) => s.id),
          notFound: res.notFound.map((s) => s.id + (s._closedInOsm ? ' (closed in OSM)' : '')), matched: res.matched.length,
          sameId: res.matched.filter((x) => x.sameId).length, moved: res.matched.filter((x) => x.moved).map((x) => x.store.id),
          dbOsm: MT.data.stores({ includeClosed: true }).filter((s) => s.source === 'osm' && ubigeos.includes(s.ubigeo)).length, stats: res.stats };
      } finally { MT.geo.overpass = real; }
    }, elements, m.districts);
    check(r.newStrong.length === 0 && r.notFound.length === 0 && r.moved.length === 0 && r.sameId >= r.dbOsm,
      `${m.title}: ${r.queries} quer${r.queries === 1 ? 'y' : 'ies'}, ${r.matched} matched (${r.sameId} by OSM id ≥ ${r.dbOsm} OSM rows of the area), 0 new, 0 moved, 0 not found` +
      `${r.newWeak.length ? `; ${r.newWeak.length} doubtful proposal(s) ${r.newWeak.join(', ')}` : ''}; ${r.stats.excluded} excluded by the rules` +
      (r.newStrong.length || r.notFound.length || r.moved.length ? ` — new: ${r.newStrong.join(', ')} not found: ${r.notFound.join(', ')} moved: ${r.moved.join(', ')}` : ''));
  }

  /* ------------------------------------------------------------------ 5. real rules */
  console.log('\n5. Real rules (OSM-RULES.md §5)');
  const cl = await page.evaluate(() => {
    const R = MT.osm.compile();
    const c = (tags) => { const r = MT.osm.classifyTags(tags, R); return r.chain ? r.chain + ':' + r.kind + (r.noCoords ? ':noCoords' : '') : null; };
    return {
      metroLima: [c({ railway: 'station', name: 'Metro de Lima - Estación Angamos' }), c({ shop: 'supermarket', name: 'Metro de Lima' }), c({ shop: 'supermarket', name: 'Metro 2' }), c({ shop: 'supermarket', name: 'Súper Metro Benavides' })],
      tambo: [c({ shop: 'convenience', name: 'Tambo+', operator: 'Programa Nacional PAIS' }), c({ shop: 'convenience', name: 'Tambo de Mora' }), c({ shop: 'convenience', name: 'TAMBO+ LARCO' })],
      lookalikes: [c({ shop: 'convenience', name: 'Tottus al paso' }), c({ amenity: 'fast_food', name: 'Mass Chicken' }), c({ shop: 'convenience', name: 'Holi Day' }), c({ amenity: 'fuel', name: 'Oxxo Gas' })],
      vega: [c({ amenity: 'school', name: 'I.E. Inca Garcilaso de la Vega' }), c({ shop: 'yes', name: 'Vega' }), c({ shop: 'wholesale', name: 'Vega Mayorista' })],
      tres: [c({ place: 'neighbourhood', name: '3A' }), c({ shop: 'convenience', name: 'Sector 9 Grupo 3A' }), c({ shop: 'convenience', name: '3A Hard Discount' })],
      closed: [c({ shop: 'supermarket', name: 'Plaza Vea', 'disused:shop': 'supermarket' }), c({ shop: 'supermarket', name: 'Wong (cerrado)' })],
      nonStore: [c({ amenity: 'parking', name: 'Estacionamiento Plaza Vea' }), c({ amenity: 'atm', name: 'Wong' }), c({ amenity: 'restaurant', name: 'Chifa Wong' })],
      weak: [c({ shop: 'department_store', name: 'Wong' }), c({ shop: 'convenience', name: 'Mass Ahorro' }), c({ shop: 'carpet', name: 'Tottus' }), c({ shop: 'convenience', name: 'Tambo', 'isced:level': '1' })],
      big: [c({ landuse: 'retail', name: 'Plaza Vea' }), c({ building: 'retail', name: 'Tiendas 3A' })],
      brand: [c({ shop: 'supermarket', name: 'Supermercado', brand: 'Wong' }), c({ shop: 'supermarket', name: 'Chifa Lucky', brand: 'Wong' }), c({ shop: 'supermarket', name: 'Metro', brand: 'Wong' }),
        c({ shop: 'supermarket', name: 'Supermercado', 'brand:wikidata': 'Q7828510' })],
      notChain: [c({ shop: 'supermarket', name: 'Tottus', description: 'No es de la cadena Tottus' })],
      only: MT.osm.classify([{ type: 'node', id: 1, lat: -12.12, lon: -77.03, tags: { shop: 'supermarket', name: 'Metro' } }, { type: 'node', id: 2, lat: -12.12, lon: -77.03, tags: { shop: 'supermarket', name: 'Wong' } }], ['wong'], R).map((x) => x.key).join(),
      verdict: [MT.osm.nameVerdict(MT.data.chain('metro'), 'Metro de Lima', R).verdict, MT.osm.nameVerdict(MT.data.chain('mass'), 'Mass Extra Surco', R).verdict,
        MT.osm.nameVerdict(MT.data.chain('wong'), 'Supermercado Wong', R).verdict],
      names: [MT.osm.displayName('tottus', 'HIPERMERCADOS TOTTUS ANGAMOS', R), MT.osm.displayName('plazavea', 'Plaza Vea', R), MT.osm.displayName('wong', 'Supermercados Wong Benavides', R)],
      radii: [MT.osm.radii('plazavea', R).dedupe, MT.osm.radii('tambo', R).dedupe, MT.osm.radii('wong', R).match, MT.osm.radii('oxxo', R).match],
    };
  });
  check(cl.metroLima.join() === ',,,metro:shop', '"Metro de Lima" station / shop and "Metro 2" are not Metro; "Súper Metro Benavides" is (folded)', cl.metroLima);
  check(cl.tambo.join() === 'tambo:excluded,,tambo:shop', 'Tambo: government centre (operator ~ Programa Nacional PAIS) excluded, "Tambo de Mora" not Tambo, "TAMBO+ LARCO" a shop', cl.tambo);
  check(cl.lookalikes.join() === ',,,', '"Tottus al paso", "Mass Chicken", "Holi Day", "Oxxo Gas" are not the chains');
  check(cl.vega.join() === ',vega:weak,vega:shop', '"Inca Garcilaso de la Vega" school not Vega; a bare "Vega" on shop=yes weak; "Vega Mayorista" a shop', cl.vega);
  check(cl.tres.join() === 'tiendas3a:excluded,,tiendas3a:shop', '"3A" as a place excluded, block names not 3A, "3A Hard Discount" a shop', cl.tres);
  check(cl.closed.join() === 'plazavea:closed,wong:closed', 'lifecycle prefix / "cerrado" → closed', cl.closed);
  check(cl.nonStore.join() === ',wong:excluded,', 'parking (name), ATM (amenity), "Chifa Wong" (not anchored) are not stores', cl.nonStore);
  check(cl.weak.join() === 'wong:weak,mass:weak,tottus:weak,tambo:weak:noCoords', 'weak: odd shop type, ambiguous name, exact distinctive name on another shop, school import (never its coordinates)', cl.weak);
  check(cl.big.join() === 'plazavea:building,tiendas3a:excluded', 'retail area: a store for big formats only', cl.big);
  check(cl.brand.join() === 'wong:shop,wong:excluded,metro:shop,tottus:shop', 'brand / Wikidata: generic name ok, another business name excluded, the name decides first', cl.brand);
  check(cl.notChain.join() === 'tottus:excluded', '"No es de la cadena" in description → excluded');
  check(cl.only === 'n2', 'scanning only Wong keeps the Wong (an element named "Metro" is never a Wong)');
  check(cl.verdict.join() === 'excluded,weak,match', 'Cadenas tester verdicts: excluded / weak / match');
  check(cl.names.join('|') === 'Tottus Angamos|Plaza Vea|Wong Benavides', 'store names like the seed', cl.names);
  check(cl.radii.join() === '200,40,250,120', 'radii from MT_OSM_RULES: dedupe big 200 / dense 40, match big 250 / dense 120', cl.radii);

  /* ------------------------------------------------------------------ 6. Cadenas advanced section */
  console.log('\n6. Cadenas tab: advanced OSM section');
  await page.evaluate(() => MT.app.showTab('chains'));
  await page.waitForFunction(() => document.querySelector('.mt-chains-item'));
  await page.evaluate(() => MT.chainsui.select('tambo'));
  await page.waitForFunction(() => /Tambo/.test(document.querySelector('.mt-chains-hero__name').textContent));
  const setValue = (sel, v, idx = 0) => page.evaluate((sel, v, idx) => { const el = document.querySelectorAll(sel)[idx]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v, idx);
  const ui = await page.evaluate(() => {
    const d = document.querySelector('.mt-chains-osm'); d.open = true;
    const f = (k) => document.querySelector('.mt-chains-osm input[data-osm=' + k + ']');
    const rows = [...document.querySelectorAll('.mt-chains-xtag')].map((r) => [...r.querySelectorAll('input')].map((i) => i.value));
    const flags = [...document.querySelectorAll('.mt-chains-osmflag input')].map((i) => i.checked);
    const tambo = MT.data.chain('tambo').osm;
    return { name: f('nameRegex').value === tambo.nameRegex, excl: f('excludeNameRegex').value === tambo.excludeNameRegex, prefix: f('prefixRegex').value === tambo.prefixRegex,
      weak: f('weakNameRegex').value, rows, flags, common: document.querySelector('.mt-chains-osmcommon').textContent, ere: document.querySelector('.mt-chains-ere').textContent };
  });
  check(ui.name && ui.excl && ui.prefix && ui.weak === '', 'name, exclusion and prefix patterns shown as published');
  check(ui.rows.length === 1 && ui.rows[0][0] === 'operator' && /midis/.test(ui.rows[0][1]) && /PAIS/.test(ui.rows[0][2]), 'tag exclusion row: operator ~ …midis (with its reason)', ui.rows);
  check(ui.flags.join() === 'false,true,false', 'format flags: big format off, proximity stores on, distinctive name off', ui.flags);
  check(/MT_OSM_RULES v1/.test(ui.common) && /tools\/seed\/osm-rules\.json/.test(ui.common), 'cross-chain rules summarized (MT_OSM_RULES v1)');
  check(!ui.ere.startsWith('^') && !ui.ere.endsWith('$') && /tambo/.test(ui.ere), `Overpass filter preview is the unanchored ERE: ${ui.ere}`);
  await setValue('.mt-chains-tester input', 'Tambo de Mora');
  const t1 = await page.evaluate(() => document.querySelector('.mt-chains-test').textContent);
  await setValue('.mt-chains-tester input', 'TAMBO+ LARCO');
  const t2 = await page.evaluate(() => document.querySelector('.mt-chains-test').textContent.trim());
  await setValue('.mt-chains-tester input', 'Metro Benavides');
  const t3 = await page.evaluate(() => document.querySelector('.mt-chains-test').textContent.trim());
  check(/descarta/.test(t1) && t2 === 'Coincide' && t3 === 'No coincide', `tester folds the name and applies the exclusions: "${t1}" / "${t2}" / "${t3}"`);
  await screenshot(page, 'osm-rules-chains-advanced');
  // Edit: distinctive name on + a second tag exclusion → saved with every other key kept; the scan uses it at once.
  await page.evaluate(() => document.querySelectorAll('.mt-chains-osmflag input')[2].click());
  await page.evaluate(() => [...document.querySelectorAll('.mt-chains-osm .mt-btn')].find((b) => /Agregar exclusión/.test(b.textContent)).click());
  await setValue('.mt-chains-xtag input', 'description', 3);      // row 2: key, value, reason = inputs 3, 4, 5
  await setValue('.mt-chains-xtag input', 'centro social', 4);
  await page.evaluate(() => [...document.querySelectorAll('.mt-chains-savebar .mt-btn')].find((b) => /Guardar/.test(b.textContent)).click());
  await page.waitForFunction(() => MT.data.chain('tambo').osm.uniqueName === true, { timeout: 5000 });
  const saved = await page.evaluate(() => {
    const o = MT.data.chain('tambo').osm;
    return { o, cls: MT.osm.classifyTags({ shop: 'convenience', name: 'Tambo', description: 'Centro social del distrito' }).kind,
      file: /"id":"tambo".*"uniqueName":true.*"key":"description"/.test(MT.io.chainsJs(MT.data.chains())) };
  });
  check(saved.o.excludeTags.length === 2 && saved.o.excludeTags[1].key === 'description' && saved.o.excludeNameRegex && saved.o.dense && saved.o.label === 'Tambo' && saved.o.wikidata[0] === 'Q64516439',
    'saved: the new flag and tag exclusion, every other osm key kept', saved.o.excludeTags.map((x) => x.key));
  check(saved.cls === 'excluded' && saved.file, 'the scan uses the edited rule at once, and "Guardar en carpeta" writes it to data/chains.js');
  // A partial osm update (older callers) keeps the other keys.
  const partial = await page.evaluate(async () => { await MT.data.upsertChain({ id: 'metro', osm: { shops: ['supermarket'] } }); const o = MT.data.chain('metro').osm; await MT.data.restoreChain('metro'); return o; });
  check(partial.shops.join() === 'supermarket' && partial.excludeNameRegex && partial.requireShopLike === false, 'upsertChain with a partial osm object keeps the chain\'s other rules');
  await page.evaluate(() => MT.data.restoreChain('tambo'));
} catch (err) {
  check(false, 'unexpected failure: ' + (err && err.stack || err));
  await screenshot(page, 'osm-rules-failure').catch(() => {});
} finally {
  await sleep(200);
  check(errors.length === 0, `zero console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}
finish();
