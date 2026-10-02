// tools/test/analysis-matrix.test.mjs — regression tests of the proximity matrix bugs reported on
// 2026-10-02 ("the cannibalization matrix is not working"), on the REAL data, through the user's own
// flow: English, 1590 × 1190, Analysis → Proximity matrix → type "santiago de surco" in the region box →
// "Include stores 'to verify'" off → click a store dot on the map → click table rows.
//
//   1. the tab renders whole: 3 side sections, title, 4 cards, the per-store table, no error box;
//   2. no line to an empty spot: every store the matrix refers to (each row's nearest same-chain store and
//      nearest competitor, the neighbours counted within R) is drawn — also with R 2 km / pairs 250 m;
//   3. the selected store's dashed lines (Plaza Vea Caminos del Inca → Plaza Vea Primavera, San Borja,
//      outside the region, 1.7 km) end on a ringed dot labelled "<store> · <distance>" at that end, never
//      at the middle; the legend names the two dashed lines;
//      The store card never covers them: it takes the side of its store that leaves both ringed ends,
//      their labels and the selected store in view, and keeps clear of the map legend and controls (zoom
//      13.6 — the report's view —, 14, and 14 with the store low on the left, next to the legend);
//   4. an "outside the region" dot: hover tip says so, a click opens its read-only card ("Nearest same-chain
//      store to …", the distance) and keeps the selection; while that card is open its own end label is
//      hidden (the card says the same; its tip sat on the label) and comes back when it closes;
//   5. the store card: "WITHIN 1 km" (the unit keeps its case), wholly inside the map at 1590 × 1190 and
//      1440 × 900; on a 1366 × 768 laptop never clipped (not shown when the map strip is too short);
//   6. ES card headings: a distance never breaks between number and unit;
//   7. keyboard focus stays on the control just used (radius chip, column header, results tab, mode radio);
//   8. mode A stays consistent: every line ends on a drawn store;
//   9. zero console errors.
//
//   node tools/test/analysis-matrix.test.mjs

import { openApp, screenshot, waitForMapIdle, makeChecker, sleep, splitNetworkNoise } from './lib.mjs';

const { check, finish } = makeChecker('analysis-matrix');
const { browser, page, errors } = await openApp({ lang: 'en', hash: 'analisis', viewport: { width: 1590, height: 1190 } });
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const mapIdle = () => waitForMapIdle(page, { expr: 'MT.analysisui && MT.analysisui.state().mapReady && MT.analysisui.map()' }).catch((e) => console.log('   (map idle wait:', e.message, ')'));
/** Client pixel of a store on the analysis map. */
const pixel = (id) => ev((id) => { const s = MT.data.store(id), map = MT.analysisui.map(), r = map.getCanvas().getBoundingClientRect(), p = map.project([s.lng, s.lat]); return { x: r.left + p.x, y: r.top + p.y }; }, id);
/** Every store the matrix refers to that the map does not draw. */
const undrawn = () => ev(() => {
  const map = MT.analysisui.map(), res = MT.analysisui.results(), st = MT.analysisui.state().matrix, A = MT.analysis;
  const drawn = new Set(map.getSource('mtb-stores').serialize().data.features.map((f) => f.properties.id));
  const targets = res.rows.flatMap((r) => [r.nearestSame, r.nearestCompetitor].filter(Boolean)).map((x) => x.store.id).filter((id) => !drawn.has(id));
  const inR = new Set(res.region.map((s) => s.id));
  const idx = A.index(A.storesForRegion({ chains: st.chains, includeToVerify: false }));
  const within = new Set();
  res.region.forEach((s) => idx.within(s.lat, s.lng, st.radius, (o) => !inR.has(o.id)).forEach((x) => within.add(x.store.id)));
  return { targets: targets.length, within: within.size, withinUndrawn: [...within].filter((id) => !drawn.has(id)).length, rows: res.rows.length };
});
/**
 * What the open card covers on the analysis map: the selected store's line-end rings and labels rendered
 * under it, and which of the selected store / its two line ends lie in its box (`own`: the card's store).
 */
const cardCovers = (own) => ev((own) => {
  const map = MT.analysisui.map(), el = document.querySelector('.mt-analysis-popup');
  if (!el) return null;
  const c = map.getContainer().getBoundingClientRect(), r = el.getBoundingClientRect();
  const box = [[r.left - c.left, r.top - c.top], [r.right - c.left, r.bottom - c.top]];
  const under = map.queryRenderedFeatures(box, { layers: ['mtb-sel-labels', 'mtb-sel-ends'] })
    .filter((f) => f.properties.id !== own).map((f) => (f.layer.id === 'mtb-sel-labels' ? 'label "' + f.properties.label + '"' : 'ring of ' + MT.data.store(f.properties.id).name));
  const st = MT.analysisui.state().matrix, row = MT.analysisui.results().rows.find((x) => x.store.id === st.selected);
  const pts = row ? [row.store, row.nearestSame && row.nearestSame.store, row.nearestCompetitor && row.nearestCompetitor.store].filter((x) => x && x.id !== own) : [];
  const px = (x) => map.project([x.lng, x.lat]);
  return {
    under: [...new Set(under)],
    inside: pts.filter((x) => { const q = px(x); return q.x > box[0][0] - 6 && q.x < box[1][0] + 6 && q.y > box[0][1] - 6 && q.y < box[1][1] + 6; }).map((x) => x.name),
    inView: pts.filter((x) => { const q = px(x); return q.x >= 0 && q.y >= 0 && q.x <= c.width && q.y <= c.height; }).length, pts: pts.length,
    labels: map.queryRenderedFeatures({ layers: ['mtb-sel-labels'] }).map((f) => f.properties.label),
    rings: map.queryRenderedFeatures({ layers: ['mtb-sel-ends'] }).map((f) => f.properties.id),
    anchor: (el.className.match(/maplibregl-popup-anchor-([a-z-]+)/) || [])[1],
    // the map's overlays (legend, zoom buttons, attribution) that would be drawn over the card
    overlays: [document.querySelector('.mt-analysis-maplegend')].concat([...map.getContainer().querySelectorAll('.maplibregl-ctrl')]).filter((x) => x && !x.hidden).filter((x) => {
      const o = x.getBoundingClientRect();
      return o.width && o.height && o.left < r.right - 1 && o.right > r.left + 1 && o.top < r.bottom - 1 && o.bottom > r.top + 1;
    }).map((x) => x.className.split(' ')[0]),
  };
}, own);
/** The open card's box against the map's box. */
const cardFit = () => ev(() => {
  const p = document.querySelector('.mt-analysis-popup'), m = MT.analysisui.map().getContainer().getBoundingClientRect();
  if (!p) return { open: false, mapH: Math.round(m.height) };
  const r = p.getBoundingClientRect();
  return { open: true, inside: r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5 && r.left >= m.left - 0.5 && r.right <= m.right + 0.5, mapH: Math.round(m.height), h: Math.round(r.height),
    kicker: (p.querySelector('.mt-analysis-card__kicker') || {}).innerText, text: p.innerText };
});

try {
  await page.waitForFunction(() => MT.analysisui && MT.analysisui.state().mapReady, { timeout: 60000 });
  await mapIdle();

  /* ---- 1. the user's flow --------------------------------------------------------------------------------- */
  await ev(() => [...document.querySelectorAll('.mt-analysis-modes label')].find((b) => /Proximity matrix/.test(b.textContent)).click());
  await sleep(300);
  await page.click('.mt-analysis-side .mt-analysis-districts input');
  await page.keyboard.type('santiago de surco');
  await page.waitForFunction(() => document.querySelector('.mt-analysis-side .mt-analysis-options [role=option]'));
  await page.keyboard.press('Enter');
  await ev(() => MT.analysisui.whenIdle());
  const toVerify = await page.evaluateHandle(() => [...document.querySelectorAll('.mt-analysis-side .mt-switch')].find((x) => /Include stores .to verify./.test(x.textContent)));
  await toVerify.click();                          // a real click on the switch
  await ev(() => MT.analysisui.whenIdle());
  await mapIdle();
  const ui = await ev(() => ({
    count: MT.data.stores().length, meta: document.querySelector('.mt-analysis-head__meta').textContent,
    side: [...document.querySelectorAll('.mt-analysis-side > section')].map((s) => (s.querySelector('.mt-analysis-sec__title') || {}).textContent || 'ERROR'),
    sideEnd: document.querySelector('.mt-analysis-side').innerText.trim().split('\n').pop(),
    head: (document.querySelector('.mt-analysis-mainhead__h') || {}).textContent, cards: document.querySelectorAll('.mt-analysis-stat').length,
    rows: document.querySelectorAll('.mt-analysis-table--b tbody tr[data-id]').length, boxes: document.querySelectorAll('#panel-analysis .mt-errbox').length,
    mode: document.querySelector('.mt-analysis').dataset.mode, st: MT.analysisui.state().matrix,
  }));
  check(ui.meta === `${ui.count.toLocaleString('en-US')} stores in the database`, `header: "${ui.meta}"`);
  check(ui.side.join(' / ') === 'Region / Stores to include / Proximity matrix' && !/Closed stores are never included\.$/.test(ui.sideEnd), `side panel whole: ${ui.side.join(' / ')} (ends "${ui.sideEnd}")`);
  check(ui.mode === 'matrix' && ui.head === 'Proximity matrix · Santiago de Surco' && ui.cards === 4 && ui.rows > 0 && ui.boxes === 0, `"${ui.head}", ${ui.cards} cards, ${ui.rows} table rows in view, no error box`);
  check(ui.st.districts.join() === '150140' && ui.st.rows > 20 && !ui.st.computing && !ui.st.error, `Santiago de Surco, "to verify" off: ${ui.st.rows} stores, ${ui.st.pairs} pairs`);

  /* ---- 2. every store the matrix refers to is drawn ----------------------------------------------------------- */
  const u1 = await undrawn();
  check(u1.targets === 0 && u1.withinUndrawn === 0, `no line or count points at an empty spot: every nearest same-chain store / competitor and every neighbour within R is drawn (${ui.st.outside} outside the region)`);
  await ev(() => MT.analysisui.setMatrix({ radius: 2000, threshold: 250 }));
  await mapIdle();
  const u2 = await undrawn();
  check(u2.targets === 0 && u2.withinUndrawn === 0 && u2.within >= 20, `R 2 km / pairs 250 m: all ${u2.within} neighbours within R outside the region drawn, 0 nearest stores missing`);
  await ev(() => MT.analysisui.setMatrix({ radius: 1000, threshold: 1000 }));
  await mapIdle();

  /* ---- 3. the selected store's dashed lines (real mouse click on its dot) ------------------------------------ */
  const PV = await ev(() => { const s = MT.data.stores().find((x) => x.name === 'Plaza Vea Caminos del Inca'); return s ? s.id : null; })
    || await ev(() => { const r = MT.analysisui.results(), inR = new Set(r.region.map((s) => s.id)); const x = r.rows.find((y) => y.nearestSame && !inR.has(y.nearestSame.store.id)); return x && x.store.id; });
  check(!!PV, `the store of the report (${PV})`);
  await ev((id) => { const s = MT.data.store(id); MT.analysisui.map().jumpTo({ center: [s.lng, s.lat], zoom: 13.6 }); }, PV);
  await mapIdle();
  let q = await pixel(PV);
  await page.mouse.click(q.x, q.y);
  await sleep(900);
  await mapIdle();
  const sel = await ev((id) => {
    const map = MT.analysisui.map(), row = MT.analysisui.results().rows.find((r) => r.store.id === id);
    const drawn = new Map(map.getSource('mtb-stores').serialize().data.features.map((f) => [f.properties.id, f]));
    const feats = map.getSource('mtb-sel').serialize().data.features;
    const lines = feats.filter((f) => f.geometry.type === 'LineString'), pts = feats.filter((f) => f.geometry.type === 'Point');
    const want = [row.nearestSame, row.nearestCompetitor].filter(Boolean);
    return {
      selected: MT.analysisui.state().matrix.selected,
      lines: lines.length, ends: lines.map((f) => f.geometry.coordinates[1]),
      wantEnds: want.map((x) => [x.store.lng, x.store.lat]), endsDrawn: want.every((x) => drawn.has(x.store.id)),
      labels: pts.map((f) => f.properties.label), wantLabels: want.map((x) => x.store.name + ' · ' + MT.i18n.formatDistance(x.meters)),
      labelsAtEnds: pts.every((f, i) => want[i] && f.geometry.coordinates[0] === want[i].store.lng && f.geometry.coordinates[1] === want[i].store.lat),
      same: row.nearestSame && { name: row.nearestSame.store.name, district: row.nearestSame.store.district, id: row.nearestSame.store.id, meters: row.nearestSame.meters,
        outside: drawn.get(row.nearestSame.store.id) && drawn.get(row.nearestSame.store.id).properties.inRegion === false },
      ring: map.getLayer('mtb-sel-ends') && map.getLayoutProperty('mtb-sel-ends', 'visibility') !== 'none',
      rendered: map.queryRenderedFeatures({ layers: ['mtb-sel-labels'] }).map((f) => f.properties.label),
      legend: document.querySelector('.mt-analysis-maplegend').innerText.split('\n'),
    };
  }, PV);
  check(sel.selected === PV && sel.lines === 2, `map click on the dot selects the store: 2 dashed lines (${sel.selected})`);
  check(sel.endsDrawn && JSON.stringify(sel.ends) === JSON.stringify(sel.wantEnds), 'each dashed line ends on a drawn dot');
  check(sel.same && sel.same.outside, `the same-chain line goes outside the region to a drawn, faded dot: ${sel.same && `${sel.same.name} (${sel.same.district}) · ${MT_dist(sel.same.meters)}`}`);
  check(JSON.stringify(sel.labels) === JSON.stringify(sel.wantLabels) && sel.labelsAtEnds && sel.ring, `labels at the far ends, with the store: "${sel.labels.join('", "')}" (ringed ends)`);
  check(sel.rendered.length === 2 && sel.wantLabels.every((l) => sel.rendered.includes(l)), `both labels are drawn on the map, neither hides the other (${sel.rendered.length})`);
  check(sel.legend.includes('Nearest same-chain store') && sel.legend.includes('Nearest competitor') && sel.legend.includes('Outside the region'), `legend: ${sel.legend.join(' · ')}`);
  const c1 = await cardFit();
  check(c1.open && c1.inside && c1.kicker === 'WITHIN 1 km' && /Nearest same-chain store/.test(c1.text), `store card open and wholly inside the map (${c1.h} px card, ${c1.mapH} px map); kicker "${c1.kicker}"`);
  // The report's view (zoom 13.6, the store in the middle), zoom 14, and zoom 14 with the store low on the left (near the legend).
  for (const [zoom, dLng, dLat, name] of [[13.6, 0, 0, 'an-matrix-01-selected'], [14, 0, 0, 'an-matrix-01b-selected-z14'], [14, 0.006, 0.004, 'an-matrix-01c-selected-z14-low-left']]) {
    if (name !== 'an-matrix-01-selected') {
      await ev(() => { const x = document.querySelector('.mt-analysis-popup .maplibregl-popup-close-button'); if (x) x.click(); });
      await ev(([id, z, a, b]) => { const s = MT.data.store(id); MT.analysisui.map().jumpTo({ center: [s.lng + a, s.lat + b], zoom: z }); }, [PV, zoom, dLng, dLat]);
      await mapIdle();
      q = await pixel(PV);
      await page.mouse.click(q.x, q.y);
      await sleep(900);
      await mapIdle();
    }
    const cv = await cardCovers(PV), f = await cardFit();
    check(cv && f.open && f.inside && cv.under.length === 0 && cv.inside.length === 0 && cv.inView === cv.pts && cv.labels.length === 2 && cv.overlays.length === 0,
      `zoom ${zoom}${dLng ? ', store low on the left' : ''}: the store card (MapLibre anchor ${cv && cv.anchor}) covers neither line end, ring nor label — "${cv && cv.labels.join('", "')}" in view — and no legend or map control sits over it${cv && cv.under.length ? '; under it: ' + cv.under.join(', ') : ''}${cv && cv.inside.length ? '; inside it: ' + cv.inside.join(', ') : ''}${cv && cv.overlays.length ? '; over it: ' + cv.overlays.join(', ') : ''}`);
    await screenshot(page, name);
  }

  /* ---- 4. an "outside the region" dot ----------------------------------------------------------------------- */
  await ev((id) => { const s = MT.data.store(id); MT.analysisui.map().jumpTo({ center: [s.lng, s.lat], zoom: 15 }); }, sel.same.id);
  await mapIdle();
  q = await pixel(sel.same.id);
  await page.mouse.move(q.x - 40, q.y - 40);
  await page.mouse.move(q.x, q.y);
  await sleep(300);
  const tip = await ev(() => (document.querySelector('.mt-analysis-tip') || {}).innerText || '');
  check(/outside the region/.test(tip) && tip.includes(sel.same.name), `hover tip: "${tip.replace(/\s+/g, ' ')}"`);
  await page.mouse.click(q.x, q.y);
  await sleep(500);
  const out = await ev(() => { const c = document.querySelector('.mt-analysis-popup .mt-analysis-card'); return { outside: !!(c && c.classList.contains('is-outside')), text: c ? c.innerText : '', selected: MT.analysisui.state().matrix.selected }; });
  check(out.outside && out.text.includes('Outside the region') && out.text.includes('Nearest same-chain store to Plaza Vea Caminos del Inca') && out.text.includes(MT_dist(sel.same.meters)) && /analysed stores/.test(out.text),
    `its read-only card: "${out.text.replace(/\s+/g, ' ').slice(0, 140)}…"`);
  check(out.selected === PV, 'the selection (and its dashed lines) stays');
  const ownLabel = sel.wantLabels[0];
  const oc = await cardCovers(sel.same.id);
  check(oc && !oc.labels.includes(ownLabel) && oc.rings.includes(sel.same.id) && oc.under.length === 0 && oc.inside.length === 0 && oc.overlays.length === 0,
    `while its card is open, its own end label "${ownLabel}" is hidden (the card says it; no tip on the text), its ring stays; the card covers no other end (anchor ${oc && oc.anchor})`);
  await screenshot(page, 'an-matrix-02-outside-card');
  await page.click('.mt-analysis-popup .maplibregl-popup-close-button');
  await sleep(400);
  const back = await ev(() => MT.analysisui.map().queryRenderedFeatures({ layers: ['mtb-sel-labels'] }).map((f) => f.properties.label));
  check(!(await ev(() => !!document.querySelector('.mt-analysis-popup'))) && back.includes(ownLabel), `card closed → the label is back ("${ownLabel}")`);

  /* ---- 5. table rows: the card fits the map (three window sizes) ------------------------------------------- */
  for (const [w, hgt, row] of [[1590, 1190, 3], [1440, 900, 4], [1366, 768, 4]]) {
    await page.setViewport({ width: w, height: hgt });
    await sleep(500);
    await ev(() => { const b = document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="stores"]'); if (b) b.click(); });
    await sleep(200);
    await page.click(`.mt-analysis-table--b tbody tr[data-id]:nth-of-type(${row + 1})`);
    await sleep(1300);
    const f = await cardFit();
    const selRow = await ev(() => { const tr = document.querySelector('.mt-analysis-table--b tbody tr.is-selected'); return tr && tr.dataset.id === MT.analysisui.state().matrix.selected; });
    if (w === 1366) {
      const lg = await ev(() => { const l = document.querySelector('.mt-analysis-maplegend').getBoundingClientRect(), m = MT.analysisui.map().getContainer().getBoundingClientRect(); return l.top >= m.top && l.bottom <= m.bottom && l.height < m.height / 2; });
      check(lg, 'the map legend stays inside the short map strip (along its bottom edge)');
    }
    if (w === 1366) check(selRow && (!f.open || f.inside), `${w} × ${hgt}: map strip ${f.mapH} px — the card is ${f.open ? 'shown whole' : 'not shown (taller than the map); the highlighted row carries the same facts'}, never clipped`);
    else check(selRow && f.open && f.inside, `${w} × ${hgt}: row click → card wholly inside the ${f.mapH} px map`);
  }
  await screenshot(page, 'an-matrix-03-1366');
  await page.setViewport({ width: 1590, height: 1190 });
  await sleep(500);

  /* ---- 6. ES: distances never break from their unit --------------------------------------------------------- */
  await ev(() => MT.i18n.setLang('es'));
  await sleep(600);
  const es = await ev(() => {
    const units = [...document.querySelectorAll('.mt-analysis-summary .mt-unit')];
    return { n: units.length, nowrap: units.every((u) => getComputedStyle(u).whiteSpace === 'nowrap'), oneLine: units.every((u) => u.getClientRects().length === 1), texts: units.map((u) => u.textContent) };
  });
  check(es.n >= 3 && es.nowrap && es.oneLine, `ES card headings: "${es.texts.join('", "')}" never split between number and unit`);
  await ev(() => MT.analysisui.select(MT.analysisui.state().matrix.selected || MT.analysisui.results().rows[0].store.id));
  await sleep(500);
  const kES = await ev(() => (document.querySelector('.mt-analysis-popup .mt-analysis-card__kicker') || {}).innerText);
  check(kES === 'A MENOS DE 1 km', `ES card kicker "${kES}" (never "1 KM" / "500 M")`);
  await ev(() => MT.i18n.setLang('en'));
  await sleep(500);

  /* ---- 7. keyboard focus stays on the control just used ----------------------------------------------------- */
  const focusIs = (sel) => ev((sel) => { const a = document.activeElement; return !!(a && a.matches(sel)); }, sel);
  await ev(() => document.querySelectorAll('.mt-analysis-side .mt-analysis-dchips')[0].querySelector('[data-value="500"]').focus());
  await page.keyboard.press('Space');
  await ev(() => MT.analysisui.whenIdle());
  check(await focusIs('.mt-analysis-side .mt-analysis-dchips [data-value="500"][aria-pressed="true"]') && await ev(() => MT.analysisui.state().matrix.radius === 500), 'radius chip "500 m" chosen with Space keeps the focus');
  await ev(() => document.querySelectorAll('.mt-analysis-side .mt-analysis-dchips')[0].querySelector('[data-value="1000"]').focus());
  await page.keyboard.press('Enter');
  await ev(() => MT.analysisui.whenIdle());
  await ev(() => document.querySelector('.mt-analysis-table--b th[data-col="store"]').focus());
  await page.keyboard.press('Enter');
  await sleep(200);
  check(await focusIs('.mt-analysis-table--b th[data-col="store"][aria-sort="ascending"]'), 'column header sorted with Enter keeps the focus');
  await ev(() => document.querySelector('.mt-analysis-respane:not([hidden]) .mt-analysis-rtab[data-view="stores"]').focus());
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const t1 = await focusIs('.mt-analysis-rtab[data-view="pairs"][aria-selected="true"]');
  await page.keyboard.press('ArrowLeft');
  await sleep(200);
  check(t1 && await focusIs('.mt-analysis-rtab[data-view="stores"][aria-selected="true"]'), 'results tabs: ArrowRight then ArrowLeft move between "By store" and "Close pairs" with the focus');
  await ev(() => document.querySelector('.mt-analysis-modes input[value="matrix"]').focus());
  await page.keyboard.press('ArrowLeft');
  await sleep(400);
  const m1 = await focusIs('.mt-analysis-modes input[value="distance"]') && await ev(() => MT.analysisui.mode() === 'distance');
  await page.keyboard.press('ArrowRight');
  await ev(() => MT.analysisui.whenIdle());
  await sleep(300);
  check(m1 && await focusIs('.mt-analysis-modes input[value="matrix"]') && await ev(() => MT.analysisui.mode() === 'matrix'), 'mode radios: ArrowLeft / ArrowRight switch modes and keep the focus');

  /* ---- 8. mode A: every line ends on a drawn store ---------------------------------------------------------- */
  await ev(() => MT.analysisui.setReference(MT.data.stores().find((s) => s.name === 'Plaza Vea Miraflores').id));
  await ev(() => MT.analysisui.setOptions({ showLines: true }));
  await mapIdle();
  const a = await ev(() => {
    const map = MT.analysisui.map();
    const drawn = new Set(map.getSource('mta-stores').serialize().data.features.map((f) => f.geometry.coordinates.join()));
    const lines = map.getSource('mta-lines').serialize().data.features;
    return { lines: lines.length, undrawn: lines.filter((f) => !drawn.has(f.geometry.coordinates[1].join())).length };
  });
  check(a.lines > 3 && a.undrawn === 0, `mode A: all ${a.lines} lines to the nearest store of each chain end on a drawn store`);

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

/** The app's distance text (MT.i18n.formatDistance), for messages and expected card text. */
function MT_dist(m) {
  const w = Math.round(Math.round(m * 10) / 10);
  if (w < 1000) return w + ' m';
  const km = w / 1000;
  return new Intl.NumberFormat('es-PE', { maximumFractionDigits: km < 9.95 ? 1 : 0 }).format(km) + ' km';
}
