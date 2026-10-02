// tools/test/analysis-slide.test.mjs — slides carrying a distance analysis (SPEC §6.3, ARCHITECTURE §8.4):
// the reference (store with a halo / point pin), the rings and their pills, the lines to the nearest
// store of each chain, the "Distancias a <referencia>" legend list, the Mapas inspector section, and
// the same drawing in the preview, PNG, PPTX and the interactive HTML — on the real data, from file://.
//
//   node tools/test/analysis-slide.test.mjs            all checks (network: OpenFreeMap tiles, MapLibre CDN)
//   node tools/test/analysis-slide.test.mjs --office   also open the deck in PowerPoint (Windows, COM) and
//                                                      export its slides → out/analysis-slide-ppt-*.png
//
// Slides: A = Plaza Vea Miraflores (store reference, rings 500 m / 1 km / 2 km), B = a labelled point on
// Av. Primavera (own chain Tottus, listTop 10), C = A with every chain on and rings to 5 km, listTop 30
// (the legend's space rule). Outputs in tools/test/out/: analysis-slide-*.png, analysis-slide.pptx,
// analysis-slide.html.

import { openApp, launch, collectErrors, waitForMapIdle, screenshot, makeChecker, splitNetworkNoise, sleep, OUT } from './lib.mjs';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const office = process.argv.includes('--office');
const { check, finish } = makeChecker('analysis-slide');
const REF_STORE = 'osm-w129822354';            // Plaza Vea Miraflores (Av. Arequipa 4651)
const toB64 = `async (blob) => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); }`;

const { browser, page, errors } = await openApp({ lang: 'es', viewport: { width: 1600, height: 1000 } });
try {
  const has = await page.evaluate((id) => !!MT.data.store(id), REF_STORE);
  check(has, `reference store ${REF_STORE} (Plaza Vea Miraflores) is in the database`);

  /* ---- 1. Slides ------------------------------------------------------------------------------ */
  const ids = await page.evaluate(async (refId) => {
    await MT.app.openExampleProject();
    MT.app.showTab('maps');
    const chains = {}; MT.data.chains().forEach((c) => { chains[c.id] = !!c.defaultOn; });
    const all = {}; MT.data.chains().forEach((c) => { all[c.id] = true; });
    const a = MT.project.addMap({ title: 'Plaza Vea Miraflores — distancias', districts: [], chains: chains,
      analysis: { ref: { type: 'store', storeId: refId }, rings: [500, 1000, 2000] } }, { select: false });
    const b = MT.project.addMap({ title: 'Local propuesto — Av. Primavera', districts: [], chains: chains,
      analysis: { ref: { type: 'point', lat: -12.1105, lng: -76.9935, label: 'Local propuesto Av. Primavera', chainId: 'tottus' }, rings: [500, 1000, 2000], listTop: 10 } }, { select: false });
    const c = MT.project.addMap({ title: 'Miraflores — todas las cadenas', districts: [], chains: all,
      analysis: { ref: { type: 'store', storeId: refId }, rings: [500, 1000, 2000, 3000, 5000], listTop: 30 } }, { select: false });
    // D = C with the default list (8): one of its lines goes to a logo collapsed to a dot (Flora y Fauna Cavenecia).
    const d = MT.project.addMap({ title: 'Miraflores — todas las cadenas (8)', districts: [], chains: all,
      analysis: { ref: { type: 'store', storeId: refId }, rings: [500, 1000, 2000, 3000, 5000], listTop: 8 } }, { select: false });
    return { a: a.id, b: b.id, c: c.id, d: d.id, demo: MT.project.maps().filter((m) => !m.analysis).map((m) => m.id) };
  }, REF_STORE);
  const show = async (id) => {
    await page.evaluate((id) => MT.project.select(id), id);
    await sleep(700);
    await waitForMapIdle(page, { timeout: 60000 }).catch(() => {});
    await sleep(900);
  };
  await show(ids.a);

  /* ---- 2. Model: region, geometry, layout ------------------------------------------------------ */
  const m = await page.evaluate((ids, refId) => {
    const F = MT.layout.frame();
    const out = {};
    for (const key of ['a', 'b', 'c']) {
      const cfg = MT.project.getMap(ids[key]);
      const reg = MT.data.analysisRegion(cfg), g = MT.layout.analysis(cfg), lay = MT.layout.compute(cfg);
      const st = MT.layout.styleOf(cfg), sm = MT.markers.shadowMargin(st);
      const boxes = MT.layout.analysisBoxes(cfg, MT.layout.projector(MT.layout.viewFor(cfg)));
      const markers = lay.filter((it) => MT.markers.isMarker(it));
      const hitBox = (it, b) => Math.abs(it.pos.x - (b.x + b.w / 2)) < it.w / 2 + b.w / 2 - 0.5 && Math.abs(it.pos.y - (b.y + b.h / 2)) < it.h / 2 + b.h / 2 - 0.5;
      const pills = g.rings.filter((r) => r.label).map((r) => ({ x: r.label.x - r.label.w / 2, y: r.label.y - r.label.h / 2, w: r.label.w, h: r.label.h }));
      const dotIn = (b) => lay.some((it) => { const d = it.dot || it.anchor; return d.x > b.x && d.x < b.x + b.w && d.y > b.y && d.y < b.y + b.h; });
      const pillOverlap = pills.some((p, i) => pills.some((q, j) => j > i && p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y));
      const rows = MT.legend.items(cfg, lay);
      const refItems = lay.filter((it) => it.isRef);
      out[key] = {
        reg: !!reg, regMax: reg && reg.maxMeters, stores: MT.data.storesForMap(cfg).length, n: lay.length,
        rings: g.rings.map((r) => ({ m: r.meters, inside: r.inside, label: !!r.label, text: r.text })),
        pillsInFrame: pills.every((p) => p.x >= 0 && p.y >= 0 && p.x + p.w <= F.width && p.y + p.h <= F.height),
        pillOverlap: pillOverlap, dotsOnPills: pills.filter(dotIn).length,
        markerOnObstacle: markers.filter((it) => boxes.some((b) => hitBox(it, b))).map((it) => it.storeId),
        pin: g.pin ? { inFrame: g.pin.x >= 0 && g.pin.x <= F.width && g.pin.y >= 0 && g.pin.y <= F.height } : null,
        refItems: refItems.map((it) => ({ id: it.storeId, pad: it.refPad || 0, grouped: !!it.grouped, collapsed: !!it.collapsed, count: it.count || 1, w: it.w, body: MT.markers.bodyOf(it).w })),
        inGroups: lay.filter((it) => it.count > 1 && it.members.indexOf(refId) >= 0).length,
        lines: g.lines.length, linesInLayout: g.lines.filter((l) => lay.some((it) => it.storeId === l.storeId)).length,
        chainsInRows: new Set(g.rows.map((r) => r.store.chain)).size,
        dist: rows.distances ? rows.distances.items.map((d) => ({ s: d.short, n: d.name, t: d.text, m: d.meters, c: d.chainId, f: !!(d.approx || d.toVerify), id: d.storeId })) : null,
        heading: rows.distances ? rows.distances.heading : null,
        subtitle: MT.data.subtitleFor(cfg),
        bounds: MT.data.boundsForMap(cfg), view: MT.layout.viewFor(cfg), sm: sm,
      };
    }
    // Ordinary slides (the example project) carry none of it.
    out.demo = ids.demo.map((id) => {
      const cfg = MT.project.getMap(id), lay = MT.layout.compute(cfg), rows = MT.legend.items(cfg, lay);
      return { id: id, ana: MT.layout.analysis(cfg), isRef: lay.filter((it) => it.isRef || it.refPad).length, dist: rows.distances, legendDist: !!MT.slide.layout(cfg, 1920, rows).legend.dist,
        rings: MT.mapview.basemap && MT.render.analysisOverlay(cfg) };
    });
    return out;
  }, ids, REF_STORE);

  const A = m.a, B = m.b, C = m.c;
  check(A.reg && A.regMax === 2000 && A.stores > 5, `slide A is defined by its analysis (no districts): ${A.stores} stores within ${A.regMax} m`);
  check(A.subtitle === 'Distancias a Plaza Vea Miraflores', `automatic subtitle "${A.subtitle}"`);
  check(A.rings.length === 3 && A.rings.every((r) => r.inside && r.label), `3 rings, wholly inside the frame, each with its pill (${A.rings.map((r) => r.text).join(', ')})`);
  check(A.rings.map((r) => r.text).join('|') === '500 m|1 km|2 km', 'ring pills read "500 m", "1 km", "2 km"');
  check(A.pillsInFrame && !A.pillOverlap, 'pills inside the frame and not overlapping each other');
  check(A.dotsOnPills === 0 && B.dotsOnPills === 0, `no store dot under a pill (A ${A.dotsOnPills}, B ${B.dotsOnPills})`);
  check(A.markerOnObstacle.length === 0 && B.markerOnObstacle.length === 0, `no logo covers a pill or the pin (A: ${A.markerOnObstacle.join(', ') || 'none'}; B: ${B.markerOnObstacle.join(', ') || 'none'})`);
  check(A.refItems.length === 1 && A.refItems[0].id === REF_STORE && A.refItems[0].pad > 0 && !A.refItems[0].grouped && !A.refItems[0].collapsed && A.refItems[0].count === 1,
    `the reference store keeps its own logo with a halo (refPad ${A.refItems[0] && A.refItems[0].pad.toFixed(2)}; box ${A.refItems[0] && A.refItems[0].w.toFixed(1)} = logo ${A.refItems[0] && A.refItems[0].body.toFixed(1)} + halo)`);
  check(A.inGroups === 0 && C.refItems.length === 1 && C.inGroups === 0, 'the reference store is never part of a same-chain group (also on the crowded slide C)');
  check(A.pin === null, 'a reference store drawn on the slide has no pin');
  check(!!B.pin && B.pin.inFrame && B.refItems.length === 0, 'a reference point gets a pin inside the frame');
  check(A.lines === A.chainsInRows && A.linesInLayout === A.lines, `lines to the nearest store of each chain: ${A.lines} (chains ${A.chainsInRows}), all to stores on the slide`);
  check(Array.isArray(A.dist) && A.dist.length === 8 && A.dist.every((d, i) => !i || d.m >= A.dist[i - 1].m), `legend list: the 8 nearest stores, nearest first (${A.dist && A.dist.map((d) => d.t).join(', ')})`);
  check(A.dist && A.dist.every((d) => /^(≈ )?(\d+ m|\d+(\.\d)? km)$/.test(d.t)), 'distances as es-PE slide text ("754 m", "1.1 km")');
  check(A.dist && A.dist.every((d) => d.t.startsWith('≈ ') === d.f) && A.dist.some((d) => d.f && d.id === 'web-holi-pardo'),
    `a store with an approximate / "por verificar" location is marked on the slide list ("${(A.dist.find((d) => d.f) || {}).t}" — Holi Pardo)`);
  check(A.dist && A.dist.some((d) => d.s !== d.n) && A.dist.every((d) => d.s && d.n.indexOf(d.s) >= 0), `short names without the chain's name (${A.dist && A.dist.slice(0, 3).map((d) => d.s).join(', ')})`);
  check(A.heading === 'Distancias a Plaza Vea Miraflores' && B.heading === 'Distancias a Local propuesto Av. Primavera', `list headings "${A.heading}" / "${B.heading}"`);
  check(B.dist && B.dist.length === 10, `listTop 10 → 10 rows on slide B (${B.dist && B.dist.length})`);
  check(C.rings.length === 5 && C.regMax === 5000, `slide C: 5 rings, stores within 5 km (${C.stores})`);
  check(m.demo.every((d) => d.ana === null && d.isRef === 0 && d.dist === null && !d.legendDist && d.rings === null), 'ordinary slides (example project): no analysis geometry, halo, list or overlay');

  /* ---- 3. Legend panel geometry (MT.slide.layout) ---------------------------------------------- */
  const lg = await page.evaluate((ids) => {
    const th = MT.theme, out = {};
    for (const key of ['a', 'b', 'c']) {
      const cfg = MT.project.getMap(ids[key]);
      const W = 1920, k = W / th.slide.width, area = { x: th.legend.area.x * k, y: th.legend.area.y * k, w: th.legend.area.w * k, h: th.legend.area.h * k };
      const g = MT.slide.layout(cfg, W, MT.legend.items(cfg));
      const L = g.legend, D = L.dist;
      const bottom = D ? D.rows.reduce((mx, r) => Math.max(mx, r.y + r.h), D.y) : 0;
      const chainBottom = L.rows.reduce((mx, r) => Math.max(mx, r.y + r.h), L.heading.y + L.heading.h);
      const nameFits = D ? D.rows.every((r) => r.textX + MT.slide.textWidth(r.text, 'normal', r.fontPx) <= r.distX - r.distW + 0.5) : false;
      out[key] = { dist: !!D, rows: D ? D.rows.length : 0, listOnly: !!L.listOnly, chainRows: L.rows.length, fitsArea: !!D && D.y >= area.y - 0.5 && bottom <= area.y + area.h + 0.5,
        order: !D || L.listOnly || chainBottom <= D.y + 0.5, nameFits: nameFits, chainPt: L.fontPx / k * 72, distPt: D ? D.fontPx / k * 72 : 0, headLines: D ? D.heading.lines.length : 0 };
    }
    return out;
  }, ids);
  check(lg.a.dist && lg.a.rows === 8 && !lg.a.listOnly && lg.a.chainRows > 0 && lg.a.fitsArea && lg.a.order,
    `slide A legend: chain legend (${lg.a.chainRows} rows, ${lg.a.chainPt.toFixed(1)} pt) above the list (${lg.a.rows} rows, ${lg.a.distPt.toFixed(1)} pt), inside the panel`);
  check(lg.a.distPt <= lg.a.chainPt + 0.01 && lg.b.distPt <= lg.b.chainPt + 0.01, 'the list is never in a larger type than the chain legend');
  check(lg.a.nameFits && lg.b.nameFits && lg.c.nameFits, 'store names never run into their distance');
  check(lg.c.dist && lg.c.fitsArea && (lg.c.rows < 30 || lg.c.listOnly), `space rule on slide C (16 chains, listTop 30): ${lg.c.listOnly ? 'only the list' : 'both blocks'}, ${lg.c.rows} list rows, inside the panel`);
  // Last step of the rule: a chain legend that cannot fit at its minimum size leaves the panel to the list.
  const lo = await page.evaluate(() => {
    const th = MT.theme, k = 1920 / th.slide.width;
    const rows = [];
    for (let i = 0; i < 34; i++) rows.push({ chainId: 'prueba' + i, label: 'CADENA DE PRUEBA NÚMERO ' + i, text: 'CADENA DE PRUEBA NÚMERO ' + i + ' (3)', count: 3 });
    Object.defineProperty(rows, 'footnote', { value: null });
    Object.defineProperty(rows, 'distances', { value: { heading: 'Distancias a Punto de prueba', items: rows.slice(0, 12).map((r, i) => ({ storeId: 's' + i, chainId: r.chainId, name: 'Tienda ' + i, short: 'Tienda ' + i, text: (i + 1) * 100 + ' m', meters: (i + 1) * 100 })) } });
    const L = MT.slide.legendLayout(rows, 1920, { markerStyle: 'badge' });
    const bottom = L.dist.rows.reduce((mx, r) => Math.max(mx, r.y + r.h), 0);
    return { listOnly: !!L.listOnly, chainRows: L.rows.length, head: L.heading.text, rows: L.dist.rows.length, fits: bottom <= (th.legend.area.y + th.legend.area.h) * k + 0.5 };
  });
  check(lo.listOnly && lo.chainRows === 0 && lo.head === '' && lo.rows === 12 && lo.fits, `34 long chain names: only the distance list (${lo.rows} rows, chain icons stand in for the legend)`);

  /* ---- 4. Preview (Mapas tab) -------------------------------------------------------------------- */
  const pv = await page.evaluate(async (ids) => {
    const map = MT.mapview.getMap(), notice = document.querySelector('.mt-mapview__notice');
    const src = map && map.getSource('mt-analysis');
    let feats = -1;
    try { const d = src && src.getData ? await src.getData() : null; feats = d && d.features ? d.features.length : -1; } catch (e) { feats = -1; }
    const rail = [...document.querySelectorAll('.mt-maps-slide')].find((li) => li.dataset.id === ids.a);
    return {
      notice: notice ? (notice.hidden ? '' : notice.textContent) : '', layer: !!(map && map.getLayer('mt-analysis-rings')), feats: feats,
      distRows: document.querySelectorAll('.mt-slide__dist-row').length, distHead: [...document.querySelectorAll('.mt-slide__dist-heading')].map((e) => e.textContent).join(' '),
      sec: !!document.querySelector('.mt-maps-sec[data-sec="analysis"]'), anote: !!document.querySelector('.mt-maps-anote:not([hidden])'),
      start: !!document.querySelector('.mt-maps-start:not([hidden])'), rail: rail ? rail.querySelector('.mt-maps-slide__meta').textContent : '',
      stats: !!document.querySelector('.mt-maps-bar__stats'),
    };
  }, ids);
  check(!pv.notice, `no "Elige los distritos" (or any) notice over an analysis slide${pv.notice ? ': ' + pv.notice : ''}`);
  check(pv.layer && pv.feats === 3, `the rings are a MapLibre layer of the preview map (mt-analysis-rings, ${pv.feats} features)`);
  check(pv.distRows === 8 && /Distancias a Plaza Vea Miraflores/.test(pv.distHead), `preview legend shows "${pv.distHead}" with ${pv.distRows} rows`);
  check(pv.sec && pv.anote && !pv.start, 'inspector: "Análisis de distancias" section; districts section explains they are optional (no "Empieza por aquí")');
  check(/Distancias/.test(pv.rail) && pv.stats, `rail meta "${pv.rail}" and the bar's store count`);
  await screenshot(page, 'analysis-slide-preview-a');

  /* ---- 5. Inspector edits --------------------------------------------------------------------------- */
  const cfgOf = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(MT.project.getMap(id).analysis || null)), id);
  await page.evaluate(() => MT.mapsui.section('analysis', true));
  await page.click('.mt-maps-sec[data-sec="analysis"] .mt-maps-arings [data-m="2000"] .mt-chip__x');
  await sleep(150);
  let an = await cfgOf(ids.a);
  check(an.rings.join() === '500,1000' && an.maxMeters === 1000, `remove the 2 km ring → rings ${an.rings.join(', ')}, the slide's distance follows (${an.maxMeters} m)`);
  await page.click('.mt-maps-sec[data-sec="analysis"] .mt-maps-apresets [data-m="3000"]');
  await sleep(150);
  an = await cfgOf(ids.a);
  check(an.rings.join() === '500,1000,3000' && an.maxMeters === 3000, `add the 3 km preset → rings ${an.rings.join(', ')} (${an.maxMeters} m)`);
  await page.click('.mt-maps-sec[data-sec="analysis"] [data-field="ringAdd"]');
  await page.keyboard.type('2000');
  await page.keyboard.press('Enter');
  await sleep(150);
  an = await cfgOf(ids.a);
  check(an.rings.join() === '500,1000,2000,3000' && an.maxMeters === 3000, `type 2000 + Enter → rings ${an.rings.join(', ')}; the distance stays ${an.maxMeters} m (not the largest ring's change)`);
  await page.select('.mt-maps-sec[data-sec="analysis"] [data-field="maxMeters"]', '2000');
  await sleep(150);
  an = await cfgOf(ids.a);
  const n2 = await page.evaluate((id) => MT.data.storesForMap(MT.project.getMap(id)).length, ids.a);
  check(an.maxMeters === 2000 && n2 === A.stores, `"Tiendas de la lámina": within 2 km → ${n2} stores again`);
  await page.evaluate(() => { const i = document.querySelector('.mt-maps-sec[data-sec="analysis"] [data-field="listTop"]'); i.value = '5'; i.dispatchEvent(new Event('change')); });
  await sleep(250);
  const top5 = await page.evaluate((id) => ({ a: MT.project.getMap(id).analysis.listTop, dom: document.querySelectorAll('.mt-slide__dist-row').length }), ids.a);
  check(top5.a === 5 && top5.dom === 5, `listTop 5 → ${top5.dom} rows in the preview legend`);
  const clickSel = (sel) => page.evaluate((sel) => document.querySelector(sel).click(), sel);
  await clickSel('.mt-maps-sec[data-sec="analysis"] [data-field="showLines"]');
  await sleep(150);
  const noLines = await page.evaluate((id) => ({ v: MT.project.getMap(id).analysis.showLines, n: MT.layout.analysis(MT.project.getMap(id)).lines.length }), ids.a);
  check(noLines.v === false && noLines.n === 0, 'lines switch off → no lines');
  await clickSel('.mt-maps-sec[data-sec="analysis"] [data-field="showLines"]');
  await page.evaluate((id) => MT.project.updateMap(id, { analysis: Object.assign({}, MT.project.getMap(id).analysis, { rings: [500, 1000, 2000], maxMeters: 2000, listTop: 8 }) }), ids.a);
  await sleep(200);
  // "Editar en Análisis" → the Análisis tab.
  await page.click('.mt-maps-sec[data-sec="analysis"] [data-action="editAnalysis"]');
  await page.waitForFunction((id) => MT.app.currentTab() === 'analysis' && MT.analysisui.state().linked === id, { timeout: 15000 }, ids.a).catch(() => null);
  const tab = await page.evaluate(() => ({ id: MT.app.currentTab(), st: MT.analysisui.state() }));
  check(tab.id === 'analysis' && tab.st.linked === ids.a && tab.st.ref && tab.st.ref.storeId === REF_STORE && tab.st.universe.meters === 2000 && tab.st.rings.join() === '500,1000,2000',
    `"Editar en Análisis" opens the Análisis tab with the slide's analysis, linked (${tab.id}, ${tab.st.ref && tab.st.ref.label}, ${tab.st.universe.meters} m)`);
  await page.evaluate(() => MT.app.showTab('maps'));
  await sleep(400);
  // Remove the analysis (with undo).
  await page.click('.mt-maps-sec[data-sec="analysis"] [data-action="removeAnalysis"]');
  await sleep(200);
  const gone = await page.evaluate((id) => ({ ana: MT.project.getMap(id).analysis || null, sec: !!document.querySelector('.mt-maps-sec[data-sec="analysis"]'),
    notice: (() => { const n = document.querySelector('.mt-mapview__notice'); return n && !n.hidden ? n.textContent : ''; })() }), ids.a);
  check(gone.ana === null && !gone.sec && /distritos/i.test(gone.notice), 'remove the analysis → section gone, the slide asks for districts again');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.mt-toast button')].find((x) => /Deshacer/.test(x.textContent)); if (b) b.click(); });
  await sleep(300);
  const back = await page.evaluate((id) => ({ ana: !!MT.project.getMap(id).analysis, sec: !!document.querySelector('.mt-maps-sec[data-sec="analysis"]') }), ids.a);
  check(back.ana && back.sec, '"Deshacer" puts the analysis back');
  // Normal slide: no analysis section.
  await page.evaluate((id) => MT.project.select(id), ids.demo[0]);
  await sleep(300);
  check(!(await page.evaluate(() => !!document.querySelector('.mt-maps-sec[data-sec="analysis"]'))), 'ordinary slide: no "Análisis de distancias" section');
  await show(ids.a);

  /* ---- 6. PNG exports -------------------------------------------------------------------------------- */
  for (const key of ['a', 'b']) await show(ids[key]);
  const png = await page.evaluate(async (ids, toB64) => {
    const b64 = eval(toB64);
    const out = {};
    for (const key of ['a', 'b']) {
      const id = ids[key], cfg = MT.project.getMap(id);
      const res = await MT.export.png(id, { kind: 'slide', width: 1920, download: false, ui: false });
      const map = await MT.render.mapCanvas(cfg, { scale: 2 });
      const g = MT.layout.analysis(cfg), ctx = map.canvas.getContext('2d'), s = map.frame.scale;
      const px = (x, y) => Array.from(ctx.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data);
      // A pill: white inside, dark text across its middle.
      const l = g.rings[0].label;
      const row = ctx.getImageData(Math.round((l.x - l.w / 2 + 2) * s), Math.round(l.y * s), Math.round((l.w - 4) * s), 1).data;
      let darkN = 0, whiteN = 0;
      for (let i = 0; i < row.length; i += 4) { const v = row[i] + row[i + 1] + row[i + 2]; if (v < 3 * 120) darkN++; else if (v > 3 * 235) whiteN++; }
      const pill = { pad: px(l.x - l.w / 2 + 1.6, l.y), dark: darkN, white: whiteN };
      // The pin's head (left of its star) is dark; a reference store's halo ring is dark too.
      const P = MT.theme.analysis.pin;
      const pin = g.pin ? px(g.pin.x - P.width * 0.36, g.pin.y - P.height + P.width / 2) : null;
      const ref = MT.layout.compute(cfg).find((it) => it.isRef);
      const H = MT.theme.analysis.halo;
      const halo = ref ? px(ref.pos.x + MT.markers.bodyOf(ref).w / 2 + (H.gap + H.width / 2) * ref.refPad / (H.gap + H.width + H.casingWidth), ref.pos.y) : null;
      out[key] = { slide: await b64(res.blobs[0].blob), map: map.canvas.toDataURL('image/png').split(',')[1], w: map.canvas.width, pill, pin, halo };
    }
    return out;
  }, ids, toB64);
  const dark = (c) => c && c[0] + c[1] + c[2] < 3 * 90;
  const light = (c) => c && c[0] + c[1] + c[2] > 3 * 225;
  for (const key of ['a', 'b']) {
    writeFileSync(path.join(OUT, `analysis-slide-${key}.png`), Buffer.from(png[key].slide, 'base64'));
    writeFileSync(path.join(OUT, `analysis-slide-map-${key}.png`), Buffer.from(png[key].map, 'base64'));
  }
  check(light(png.a.pill.pad) && png.a.pill.dark > 3 && png.a.pill.white > 3, `PNG map: the "500 m" pill is drawn (white padding ${png.a.pill.pad.slice(0, 3)}; across it ${png.a.pill.dark} text px, ${png.a.pill.white} white px)`);
  check(dark(png.a.halo), `PNG map: the reference store's halo ring is drawn (${png.a.halo && png.a.halo.slice(0, 3)})`);
  check(dark(png.b.pin), `PNG map: the reference pin is drawn (${png.b.pin && png.b.pin.slice(0, 3)})`);

  /* ---- 7. PowerPoint ----------------------------------------------------------------------------------- */
  await show(ids.d);                       // its basemap labels known: the layout of the export (a collapsed line target)
  const plan = await page.evaluate(async (ids) => {
    const out = {};
    const th = MT.theme, k = th.mapFrame.w / 1000;
    for (const key of ['a', 'b', 'c', 'd']) {
      const cfg = MT.project.getMap(ids[key]);
      const p = await MT.export.pptx.plan(cfg, { basemap: false });
      const g = MT.layout.analysis(cfg);
      const idx = (re) => p.elements.map((e, i) => (re.test(e.name || '') ? i : -1)).filter((i) => i >= 0);
      const lineIdx = p.elements.map((e, i) => (e.role === 'aline' ? i : -1)).filter((i) => i >= 0), pillIdx = idx(/^Etiqueta anillo /);
      const refEl = p.elements.find((e) => e.role === 'ref');
      const ell = p.elements.filter((e) => e.role === 'ring');
      const exp = g.rings.map((r) => ({ name: 'Anillo ' + r.text, x: th.mapFrame.x + r.bbox.x * k, y: th.mapFrame.y + r.bbox.y * k, w: r.bbox.w * k, h: r.bbox.h * k }));
      const err = exp.reduce((mx, e) => { const f = ell.find((x) => x.name === e.name); return f ? Math.max(mx, Math.abs(f.x - e.x), Math.abs(f.y - e.y), Math.abs(f.w - e.w), Math.abs(f.h - e.h)) : Infinity; }, 0);
      out[key] = {
        rings: ell.map((e) => ({ name: e.name, fill: e.fill, dash: e.dash })), ringErr: err,
        pills: p.elements.filter((e) => e.kind === 'pill' && /^Etiqueta anillo/.test(e.name)).map((e) => e.text),
        lines: p.elements.filter((e) => e.role === 'aline').length, expLines: g.lines.length,
        ref: p.elements.filter((e) => /^Referencia — /.test(e.name)).map((e) => ({ name: e.name, role: e.role })),
        distTexts: p.elements.filter((e) => e.role === 'dist-name').map((e) => e.runs[0].text),
        distVals: p.elements.filter((e) => e.role === 'dist-value').map((e) => e.runs[0].text),
        distHead: p.elements.filter((e) => e.role === 'dist-heading').map((e) => e.runs.map((r) => r.text).join(' ')).join(''),
        notes: p.notes, analysis: p.analysis,
        // MT.render.drawOverlay paints the lines, then the pills: so does the deck (lines under pills).
        linesUnderPills: lineIdx.length > 0 && pillIdx.length > 0 && Math.max(...lineIdx) < Math.min(...pillIdx),
        collapsedLines: p.elements.filter((e) => e.role === 'aline' && e.startRole === 'marker').length,
        expCollapsed: (() => { const lay = MT.layout.compute(cfg); return g.lines.filter((l) => lay.some((it) => it.storeId === l.storeId && it.collapsed)).length; })(),
        // The pin picture ends at its tip: its bottom-centre glue site IS the tip.
        pinTip: refEl && g.pin ? Math.max(Math.abs(refEl.x + refEl.w / 2 - (th.mapFrame.x + g.pin.x * k)), Math.abs(refEl.y + refEl.h - (th.mapFrame.y + g.pin.y * k))) : null,
      };
    }
    return out;
  }, ids);
  check(plan.a.rings.length === 3 && plan.a.rings.every((r) => r.fill === null && r.dash === 'dash'), `PPTX: rings are dashed ellipses without fill (${plan.a.rings.map((r) => r.name).join(', ')})`);
  check(plan.a.ringErr < 0.001 && plan.b.ringErr < 0.001, `PPTX: ellipses exactly on the projected rings (worst ${Math.max(plan.a.ringErr, plan.b.ringErr).toExponential(1)} in)`);
  check(plan.a.pills.join('|') === '500 m|1 km|2 km', `PPTX: ring pills as text (${plan.a.pills.join(', ')})`);
  check(plan.a.lines === plan.a.expLines && plan.b.lines === plan.b.expLines && plan.a.lines > 0, `PPTX: ${plan.a.lines} / ${plan.b.lines} lines to the nearest store of each chain`);
  check(plan.a.ref.length === 1 && plan.a.ref[0].name === 'Referencia — Plaza Vea Miraflores', `PPTX: the reference store's own picture ("${plan.a.ref[0] && plan.a.ref[0].name}")`);
  check(plan.b.ref.length === 1 && plan.b.ref[0].role === 'ref', `PPTX: the reference pin as its own picture ("${plan.b.ref[0] && plan.b.ref[0].name}")`);
  check(plan.a.distHead === 'Distancias a Plaza Vea Miraflores' && plan.a.distTexts.length === 8 && plan.a.distVals.length === 8,
    `PPTX: the distance list is real text (heading + ${plan.a.distTexts.length} names + ${plan.a.distVals.length} distances)`);
  check(/Distancias en línea recta a Plaza Vea Miraflores/.test(plan.a.notes) && /Hasta 1 km: \d+ tiendas?/.test(plan.a.notes) && !/: 1 tiendas/.test(plan.a.notes + plan.b.notes + plan.c.notes),
    'PPTX speaker notes: rings with their store counts (singular "1 tienda") and the nearest stores');
  check(/Holi Pardo \(Holi\) — ≈ \d+ m \(ubicación aproximada, por verificar\)/.test(plan.a.notes), 'PPTX speaker notes: the hand-placed Holi Pardo is flagged ("≈ … (ubicación aproximada, por verificar)")');
  check(plan.a.linesUnderPills && plan.c.linesUnderPills, 'PPTX: the distance lines are stacked under the ring pills (as the PNG / HTML)');
  check(plan.b.pinTip !== null && plan.b.pinTip < 1e-6, `PPTX: the pin picture's bottom centre is its tip (off by ${plan.b.pinTip && plan.b.pinTip.toExponential(1)} in), so glued lines meet the tip after the pin is moved`);

  const deck = await page.evaluate(async (ids, toB64) => {
    const b64 = eval(toB64);
    const res = await MT.export.pptx([ids.a, ids.b, ids.c, ids.d], { download: false, ui: false });
    const zip = await window.JSZip.loadAsync(res.blobs[0].blob);
    const xml = [];
    for (const n of [1, 2, 3, 4]) xml.push(await zip.file('ppt/slides/slide' + n + '.xml').async('string'));
    return { b64: await b64(res.blobs[0].blob), xml: xml };
  }, ids, toB64);
  const pptPath = path.join(OUT, 'analysis-slide.pptx');
  rmSync(pptPath, { force: true });
  writeFileSync(pptPath, Buffer.from(deck.b64, 'base64'));
  const cxn = (xml) => [...xml.matchAll(/<p:cxnSp>([\s\S]*?)<\/p:cxnSp>/g)].filter((x) => /name="Distancia — /.test(x[1]) && /<a:stCxn id="\d+"/.test(x[1]) && /<a:endCxn id="\d+"/.test(x[1])).length;
  check(cxn(deck.xml[0]) === plan.a.lines && cxn(deck.xml[1]) === plan.b.lines, `PPTX: every line is a connector glued to the store dot and to the reference (${cxn(deck.xml[0])} + ${cxn(deck.xml[1])})`);
  check(cxn(deck.xml[2]) === plan.c.lines && plan.d.collapsedLines === plan.d.expCollapsed && cxn(deck.xml[3]) === plan.d.lines,
    `PPTX crowded slides C / D: all ${plan.c.lines} / ${plan.d.lines} lines glued, incl. ${plan.d.collapsedLines} to a logo collapsed to a dot`);
  check(deck.xml.every((x) => /name="Mapa"/.test(x)), 'PPTX: the map (rings, pills, lines, reference included) is grouped as "Mapa"');
  check(/name="Anillo 500 m"[\s\S]*?<a:noFill\/>[\s\S]*?prstDash val="dash"/.test(deck.xml[0]), 'PPTX: ring XML has no fill and a dashed outline');

  if (office && process.platform === 'win32') {
    const outs = [1, 2].map((i) => path.join(OUT, `analysis-slide-ppt-${i}.png`));
    outs.forEach((f) => rmSync(f, { force: true }));
    const ps = path.join(OUT, 'analysis-slide-ppt.ps1');
    writeFileSync(ps, `
$ErrorActionPreference = 'Stop'
$src = '${pptPath.replace(/'/g, "''")}'
$outs = @(${outs.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')})
$running = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$app = New-Object -ComObject PowerPoint.Application
$pres = $null
try {
  $pres = $app.Presentations.Open($src, $true, $false, $false)
  $i = 0
  foreach ($s in $pres.Slides) { if ($i -lt $outs.Count) { $s.Export($outs[$i], 'PNG', 1920, 1080) }; $i++ }
  Write-Output ("slides=" + $pres.Slides.Count)
} finally { if ($pres) { $pres.Close() }; if (-not $running) { $app.Quit() } }
`);
    try {
      const o = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { encoding: 'utf8', timeout: 240000 });
      check(/slides=4/.test(o) && outs.every((f) => existsSync(f)), 'PowerPoint opened the deck without repair and exported its slides (analysis-slide-ppt-*.png)');
      // PowerPoint's render vs the PNG export: mean |Δ| in the map frame and the legend panel.
      const d = await page.evaluate(async (pairs) => {
        const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
        const out = [];
        for (const [a, b] of pairs) {
          const [x, y] = await Promise.all([load(a), load(b)]);
          const px = (img) => { const k = document.createElement('canvas'); k.width = 1920; k.height = 1080; const c = k.getContext('2d'); c.drawImage(img, 0, 0, 1920, 1080); return c.getImageData(0, 0, 1920, 1080).data; };
          const P = px(x), Q = px(y), s = 1920 / MT.theme.slide.width, f = MT.theme.mapFrame;
          const box = (x0, y0, x1, y1) => { let sum = 0, n = 0; for (let yy = Math.round(y0); yy < Math.round(y1); yy += 2) for (let xx = Math.round(x0); xx < Math.round(x1); xx += 2) { const i = (yy * 1920 + xx) * 4; sum += (Math.abs(P[i] - Q[i]) + Math.abs(P[i + 1] - Q[i + 1]) + Math.abs(P[i + 2] - Q[i + 2])) / 3; n++; } return sum / n; };
          out.push({ frame: box(f.x * s, f.y * s, (f.x + f.w) * s, (f.y + f.h) * s), panel: box(MT.theme.panel.x * s, 0, 1920, 1080) });
        }
        return out;
      }, ['a', 'b'].map((key, i) => ['data:image/png;base64,' + png[key].slide, 'data:image/png;base64,' + readFileSync(outs[i]).toString('base64')]));
      check(d.every((x) => x.frame < 12 && x.panel < 12), `PowerPoint render ≈ PNG export (mean |Δ| frame ${d.map((x) => x.frame.toFixed(1)).join(' / ')}, panel ${d.map((x) => x.panel.toFixed(1)).join(' / ')})`);
    } catch (e) {
      check(false, 'PowerPoint render failed: ' + String(e.stderr || e.message).slice(0, 300));
    }
  }

  /* ---- 8. Interactive HTML ------------------------------------------------------------------------------ */
  const html = await page.evaluate(async (ids) => {
    const src = Object.assign({}, MT.project.getMap(ids.a), { title: 'A — puntos', markerStyle: 'dot' });
    delete src.id;
    const dot = MT.project.addMap(src, { select: false });
    const res = await MT.export.html([ids.a, ids.b, dot.id], { download: false, ui: false });
    MT.project.removeMap(dot.id);
    const text = await res.blobs[0].blob.text();
    const D = await MT.export.html.data([MT.project.getMap(ids.a), MT.project.getMap(ids.b)]);
    const a = D.maps[0].analysis, b = D.maps[1].analysis;
    const base = MT.project.getMap(ids.a);
    const DS = await MT.export.html.data(['dot', 'number'].map((k) => Object.assign({}, base, { id: 'tmp-h-' + k, markerStyle: k })));
    const styles = DS.maps.map((x) => ({ refI: x.analysis.ref.i, pin: x.analysis.ref.pin, refMk: !!x.analysis.refMk, halo: x.analysis.halo }));
    return { text: text, a: a && { rings: a.rings.features.length, labels: a.labels.length, lines: a.lines.length, top: a.top.length, refI: a.ref.i, refMk: !!a.refMk, pin: a.ref.pin, dist: Object.keys(a.dist).length },
      b: b && { pin: b.ref.pin, top: b.top.length }, normal: (await MT.export.html.data([MT.project.getMap(ids.demo[0])])).maps[0].analysis, styles: styles };
  }, ids);
  check(html.styles.every((x) => x.refI >= 0 && !x.pin && !x.refMk && x.halo && x.halo.w > 0), `HTML data, dot / number styles: the reference store gets the halo rings (${html.styles.map((x) => x.halo && x.halo.w).join(' / ')} px)`);
  check(html.a && html.a.rings === 3 && html.a.labels === 3 && html.a.lines === A.lines && html.a.top === 8 && html.a.refI >= 0 && html.a.refMk && !html.a.pin,
    `HTML data: rings ${html.a && html.a.rings}, pills ${html.a && html.a.labels}, lines ${html.a && html.a.lines}, list ${html.a && html.a.top}, the reference store's own marker (halo)`);
  check(html.b && html.b.pin && html.b.top === 10 && html.normal === null, 'HTML data: a pin for the point; no analysis data on an ordinary map');
  const htmlPath = path.join(OUT, 'analysis-slide.html');
  writeFileSync(htmlPath, html.text);
  const b2 = await launch();
  try {
    const [p2] = await b2.pages();
    await p2.setViewport({ width: 1500, height: 950 });
    const e2 = collectErrors(p2);
    await p2.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    const ok = await p2.waitForFunction(() => window.__mtPage && window.__mtPage.map && window.__mtPage.map.loaded(), { timeout: 60000 }).then(() => true, () => false);
    if (!ok) check(false, 'HTML page: MapLibre (CDN) and the basemap loaded');
    else {
      await sleep(2500);
      const s1 = await p2.evaluate(() => {
        const P = window.__mtPage, ov = P.overlay;
        return { pills: ov.apills.length, lines: ov.alines.filter((l) => l.el.style.display !== 'none').length, pin: !!ov.apin, layer: !!P.map.getLayer('mt-analysis-rings'),
          rows: document.querySelectorAll('.dist__row').length, head: (document.querySelector('.dist__title') || {}).textContent };
      });
      check(s1.layer && s1.pills === 3 && s1.lines === A.lines && !s1.pin && s1.rows === 8 && s1.head === 'Distancias a Plaza Vea Miraflores',
        `HTML page A: ring layer, ${s1.pills} pills, ${s1.lines} lines, legend list of ${s1.rows} ("${s1.head}")`);
      await p2.evaluate(() => { const P = window.__mtPage; P.openPopup(P.data.maps[0].analysis.top[0].i); });
      await sleep(600);
      const pop = await p2.evaluate(() => (document.querySelector('.pop__dist') || {}).textContent || '');
      check(/^A .+ de Plaza Vea Miraflores · (competencia|misma cadena)$/.test(pop), `HTML popup: "${pop}"`);
      await p2.screenshot({ path: path.join(OUT, 'analysis-slide-html-a.png') });
      await p2.evaluate(() => window.__mtPage.selectMap(1));
      await sleep(2500);
      const s2 = await p2.evaluate(() => ({ pin: !!window.__mtPage.overlay.apin, rows: document.querySelectorAll('.dist__row').length }));
      check(s2.pin && s2.rows === 10, `HTML page B: the reference pin and a list of ${s2.rows}`);
      await p2.screenshot({ path: path.join(OUT, 'analysis-slide-html-b.png') });
      await p2.evaluate(() => window.__mtPage.selectMap(2));
      await sleep(2500);
      const s3 = await p2.evaluate(() => { const r = document.querySelector('.mk--ref'); return { n: document.querySelectorAll('.mk--ref').length, shadow: r ? r.style.boxShadow : '', label: r ? r.getAttribute('aria-label') : '' }; });
      check(s3.n === 1 && /,.*,/.test(s3.shadow) && /Plaza Vea Miraflores/.test(s3.label), `HTML page, dot style: the reference store's dot is ringed by its halo ("${s3.label}")`);
      await p2.screenshot({ path: path.join(OUT, 'analysis-slide-html-dot.png') });
      const { real } = splitNetworkNoise(e2);
      check(real.length === 0, `HTML page: no console errors${real.length ? ': ' + real.join(' | ') : ''}`);
    }
  } finally { await b2.close(); }

  /* ---- 9. Edge cases: a district slide with an analysis; rings leaving a zoomed-in frame ------------------- */
  const edge = await page.evaluate(async (ids, refId) => {
    const base = MT.project.getMap(ids.a), out = {};
    // San Isidro's stores, distances to Plaza Vea Miraflores (outside the district): a pin, no halo.
    const d = MT.project.addMap({ title: 'San Isidro — distancias a Plaza Vea Miraflores', districts: ['150131'], chains: base.chains,
      analysis: { ref: { type: 'store', storeId: refId }, rings: [500, 1000, 2000] } }, { select: false });
    const gd = MT.layout.analysis(d), ld = MT.layout.compute(d);
    out.district = { reg: !!MT.data.analysisRegion(d), sub: MT.data.subtitleFor(d), pin: !!gd.pin, inFrame: gd.ref.inFrame, ref: ld.filter((it) => it.isRef).length,
      onlyDistrict: MT.data.storesForMap(d).every((s) => s.ubigeo === '150131') };
    const pd = await MT.export.pptx.plan(d, { basemap: false });
    out.district.plan = pd.analysis;
    out.district.notes = pd.notes;
    // "Incluir «por verificar»" off holds on a district slide too.
    const dtv = Object.assign({}, d, { id: 'tmp-tv', districts: ['150122', '150141'], analysis: Object.assign({}, d.analysis, { includeToVerify: false }) });
    out.district.tv = { slide: MT.data.storesForMap(dtv).filter((s) => s.status === 'to_verify').length,
      rows: MT.analysis.forMap(dtv).rows.length,
      engine: MT.analysis.distancesFrom(MT.analysis.refFromStore(refId), { districts: ['150122', '150141'], chains: d.chains, includeToVerify: false }).rows.length };
    // A typed ring (1250 m) is labelled with its exact value on the pill, the ellipse and the notes.
    const r1250 = Object.assign({}, base, { id: 'tmp-1250', analysis: Object.assign({}, base.analysis, { rings: [500, 1250, 2000], maxMeters: 2000 }) });
    const p1250 = await MT.export.pptx.plan(r1250, { basemap: false });
    out.r1250 = { pills: MT.layout.analysis(r1250).rings.map((r) => r.text), shapes: p1250.elements.filter((e) => e.role === 'ring').map((e) => e.name), notes: p1250.notes };
    // Slide A zoomed in (manual view): the 2 km ring leaves the frame → baked into the PPTX basemap.
    const v = MT.layout.viewFor(base);
    const z = Object.assign({}, base, { id: 'tmp-zoom', view: { center: v.center.slice(), zoomRef: v.zoomRef + 0.8 } });
    const gz = MT.layout.analysis(z), F = MT.layout.frame();
    const pills = gz.rings.filter((r) => r.label).map((r) => r.label);
    out.zoom = { inside: gz.rings.map((r) => r.inside), pillsIn: pills.every((l) => l.x - l.w / 2 >= 0 && l.x + l.w / 2 <= F.width && l.y - l.h / 2 >= 0 && l.y + l.h / 2 <= F.height),
      plan: (await MT.export.pptx.plan(z, { basemap: false })).analysis };
    MT.project.removeMap(d.id);
    return out;
  }, ids, REF_STORE);
  check(!edge.district.reg && edge.district.onlyDistrict && /San Isidro/.test(edge.district.sub), `district slide + analysis: its stores are the district's ("${edge.district.sub}")`);
  check(edge.district.ref === 0 && (edge.district.pin === edge.district.inFrame), `… the reference store outside the districts is marked by a pin (in frame: ${edge.district.inFrame})`);
  check(/tiendas de los distritos seleccionados/.test(edge.district.notes) && !/tiendas hasta/.test(edge.district.notes) && !/: 1 tiendas/.test(edge.district.notes),
    '… its speaker notes say the stores are the districts\' (not "tiendas hasta 2 km"); "1 tienda" in the singular');
  check(edge.district.tv.slide === 0 && edge.district.tv.rows === edge.district.tv.engine, `… "por verificar" off: none on the district slide, ${edge.district.tv.rows} rows = the tab's engine call`);
  check(edge.r1250.pills.join('|') === '500 m|1.25 km|2 km' && edge.r1250.shapes.includes('Anillo 1.25 km') && /Hasta 1.25 km: /.test(edge.r1250.notes),
    `a typed 1250 m ring keeps its value: pill "${edge.r1250.pills[1]}", shape, notes`);
  check(edge.zoom.inside.some((x) => !x) && edge.zoom.pillsIn && edge.zoom.plan.baked === edge.zoom.inside.filter((x) => !x).length && edge.zoom.plan.shapes === edge.zoom.inside.filter((x) => x).length,
    `zoomed-in view: rings leaving the frame are baked into the PPTX basemap (${edge.zoom.plan.baked}), the others stay ellipses (${edge.zoom.plan.shapes}); pills inside the frame`);

  /* ---- 10. Other marker styles, English UI ---------------------------------------------------------------- */
  const styles = await page.evaluate(async (id) => {
    const out = {};
    const base = MT.project.getMap(id);
    for (const kind of ['card', 'dot', 'number']) {
      const cfg = Object.assign({}, base, { id: 'tmp-' + kind, markerStyle: kind });
      const lay = MT.layout.compute(cfg);
      await MT.markers.ready(lay.map((i) => i.chainId), MT.layout.styleOf(cfg));
      const cv = document.createElement('canvas'); cv.width = 1000; cv.height = 840;
      MT.render.drawOverlay(cv.getContext('2d'), cfg, lay, 1);
      const ref = lay.find((it) => it.isRef);
      const pic = ref ? MT.markers.image(ref, MT.layout.styleOf(cfg), 2) : null;
      out[kind] = { ref: !!ref, pad: ref ? ref.refPad || 0 : 0, pic: !!pic, overlaps: lay.stats.overlaps };
    }
    return out;
  }, ids.a);
  check(styles.card.ref && styles.card.pad > 0 && styles.number.ref && styles.number.pad > 0 && styles.dot.ref && styles.dot.pad === 0,
    `card / number / dot styles: the reference store is marked (halo room ${styles.card.pad.toFixed(1)} / ${styles.number.pad.toFixed(1)} / dot drawn in place)`);
  await page.evaluate(() => MT.i18n.setLang('en'));
  await show(ids.a);
  const en = await page.evaluate(() => ({ sec: (document.querySelector('.mt-maps-sec[data-sec="analysis"] .mt-maps-sec__title') || {}).textContent, missing: MT.i18n.missingKeys() }));
  check(en.sec === 'Distance analysis' && !en.missing.length, `English UI: "${en.sec}", no missing keys${en.missing.length ? ' (' + en.missing.join(', ') + ')' : ''}`);
  await screenshot(page, 'analysis-slide-preview-en');
  await page.evaluate(() => MT.i18n.setLang('es'));

  const { real } = splitNetworkNoise(errors);
  check(real.length === 0, `no console errors${real.length ? ': ' + real.join(' | ') : ''}`);
} finally {
  await browser.close();
}
finish();
