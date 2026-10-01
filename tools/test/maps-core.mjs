// tools/test/maps-core.mjs — module M1 (map core & rendering) in headless Chrome from file://.
//
//   node tools/test/maps-core.mjs                     all sections, screenshots in tools/test/out/m1-*.png
//   node tools/test/maps-core.mjs --headful           watch it
//   node tools/test/maps-core.mjs --only=lima         preview/export only the demo maps whose id contains "lima"
//   node tools/test/maps-core.mjs --section=styles,interact
//        sections: preview, styles, interact, wysiwyg, dense, export, states
//
// Uses the demo project (tools/fixtures/demo.mapa.json — the four reference slides) and, when the
// real logos/logos.js is not there yet, a temporary logos.js built from logos/*.png inside the
// TEMP copy of the app (never in the repo). Needs network (OpenFreeMap).

import { openApp, prepareApp, launch, collectErrors, screenshot, makeChecker, waitForMapIdle, loadDemoProject, saveDataUrl, sleep, ROOT } from './lib.mjs';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const headless = !process.argv.includes('--headful');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const sections = (process.argv.find((a) => a.startsWith('--section=')) || '').slice(10).split(',').filter(Boolean);
const want = (name) => !sections.length || sections.includes(name);
const { check, finish } = makeChecker('maps-core');

/** Temp-copy logos.js from the real logo PNGs (when the data workflow has not produced logos.js yet). */
function realLogosJs() {
  const dir = path.join(ROOT, 'logos');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (!files.length) return null;
  const out = {};
  for (const f of files) {
    const m = /^(.+?)(-wide)?\.png$/.exec(f);
    const id = m[1];
    out[id] = out[id] || {};
    out[id][m[2] ? 'wide' : 'badge'] = 'data:image/png;base64,' + readFileSync(path.join(dir, f)).toString('base64');
  }
  for (const id of Object.keys(out)) if (!out[id].badge) delete out[id];
  return 'window.MT_LOGOS = ' + JSON.stringify(out) + ';\n';
}

async function boot() {
  const app = await openApp({ lang: 'es', headless, viewport: { width: 1500, height: 900 } });
  if (app.injected.includes('logos/logos.js')) {
    const js = realLogosJs();
    if (js) {
      writeFileSync(path.join(app.dir, 'logos', 'logos.js'), js);
      await app.page.reload({ waitUntil: 'load' });
      await app.page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
      console.log('  (temporary logos.js from logos/*.png)');
    }
  }
  console.log('  fixtures injected for:', app.injected.join(', ') || 'none');
  // Our own host for the slide (independent of the M2 tab UI; mount() re-parents the slide here).
  await app.page.evaluate(() => {
    const host = MT.util.h('div', { id: 'm1-host', style: { position: 'fixed', left: '0', top: '58px', width: '1500px', height: '842px', zIndex: 60, background: '#F4F4F5' } });
    document.body.appendChild(host);
    MT.slide.mount(host);
  });
  return app;
}

async function showMap(page, id) {
  await page.evaluate((id) => { MT.project.select(id); MT.slide.render(MT.project.getMap(id)); }, id);
  await waitForMapIdle(page);
  await sleep(250);
}

const { browser, page, errors } = await boot();
const ids = await loadDemoProject(page);
check(ids.length === 4, 'demo project loaded');
const CLIP = { x: 0, y: 58, width: 1500, height: 842 };

/* ---- 1. Each reference slide in the live preview -------------------------------------------- */
if (want('preview')) for (const id of ids) {
  if (only && !id.includes(only)) continue;
  console.log(`\n[preview] ${id}`);
  await showMap(page, id);
  const st = await page.evaluate(() => {
    const s = MT.mapview.state();
    const items = MT.mapview.items();
    const legend = [...document.querySelectorAll('.mt-slide__legend-text')].map((e) => e.textContent);
    return { s, n: items.length, expected: MT.data.storesForMap(MT.slide.current()).length, legend, title: document.querySelector('.mt-slide__title').textContent,
      sub: document.querySelector('.mt-slide__subtitle').textContent, hits: document.querySelectorAll('.mt-marker-hit').length,
      notice: !document.querySelector('.mt-mapview__notice').hidden };
  });
  console.log('  ', JSON.stringify({ n: st.n, ms: st.s.stats && Math.round(st.s.stats.ms), overlaps: st.s.stats && st.s.stats.overlaps, title: st.title, sub: st.sub, legend: st.legend }));
  check(st.s.styleReady && st.s.idle, `${id}: basemap ready`);
  if (st.expected) {
    check(st.n > 0 && st.hits === st.n, `${id}: ${st.n} markers with hit targets`);
    check(st.legend.length > 0 && !st.notice, `${id}: legend rows (${st.legend.length}), no notice`);
    // Visual QA round 2: once the view's labels are known, the markers, dots and leaders block the
    // basemap's labels; every selected district's name is written by the app, off the store dots.
    await waitForMapIdle(page); await sleep(600); await waitForMapIdle(page); await sleep(300);
    const lb = await page.evaluate(() => {
      const cfg = MT.slide.current(), view = MT.layout.viewFor(cfg), m = MT.mapview.getMap();
      const names = MT.layout.districtLabels(cfg), boxes = MT.layout.districtLabelBoxes(cfg, MT.layout.projector(view), view);
      const dots = MT.mapview.items().map((it) => it.dot || it.anchor);
      let inside = 0;
      boxes.forEach((b) => dots.forEach((d) => { if (d.x > b.x + 3 && d.x < b.x + b.w - 3 && d.y > b.y + 3 && d.y < b.y + b.h - 3) inside++; }));
      return { blockers: !!m.__mtMarkerBlockers, known: !!MT.layout.labels.get(cfg, view), app: names.every((l) => l.app), n: names.length, inside: inside };
    });
    check(lb.blockers === lb.known && lb.known, `${id}: labels known for the view → markers block basemap labels (${JSON.stringify(lb)})`);
    // (A name moves a little off the dots; in a knot as dense as SJM on "Lima Cono Sur" no spot
    // near its place is entirely free: at most 2 dots per slide.)
    check(lb.app && lb.inside <= 2, `${id}: the ${lb.n} district names are written by the app, off the store dots (${lb.inside} dots inside a name)`);
  } else {
    check(st.n === 0 && st.notice && st.legend.length === 0, `${id}: no stores in the data → notice shown, empty legend`);
  }
  await screenshot(page, `m1-preview-${id}`, { clip: CLIP });
}

/* ---- 2. Marker styles and sizes ------------------------------------------------------------------- */
if (want('styles')) {
  console.log('\n[styles] demo-lima-sur');
  for (const [style, size] of [['card', 1], ['dot', 1], ['number', 1], ['badge', 1.4], ['badge', 0.7]]) {
    await page.evaluate((style, size) => { MT.project.updateMap('demo-lima-sur', { markerStyle: style, markerSize: size }); }, style, size);
    await showMap(page, 'demo-lima-sur');
    const st = await page.evaluate(() => ({ n: MT.mapview.items().length, stats: MT.mapview.state().stats, nums: MT.mapview.items().map((i) => i.number).filter(Boolean).length }));
    console.log(`   ${style} ×${size}: ${JSON.stringify(st)}`);
    check(st.n > 0 && st.stats.overlaps === 0, `${style} ×${size}: ${st.n} markers, no overlaps`);
    if (style === 'number') check(st.nums === st.n, 'number style numbers every marker');
    await screenshot(page, `m1-style-${style}-${String(size).replace('.', '_')}`, { clip: CLIP });
  }
  const num = await page.evaluate(async () => {
    MT.project.updateMap('demo-lima-sur', { markerStyle: 'number', markerSize: 1 });
    return (await MT.render.slideCanvas(MT.project.getMap('demo-lima-sur'), { width: 1920 })).toDataURL('image/png');
  });
  saveDataUrl(num, 'm1-export-slide-number.png');
  await page.evaluate(() => MT.project.updateMap('demo-lima-sur', { markerStyle: 'badge', markerSize: 1 }));
}

/* ---- 3. Interactions: click, hover, drag, double-click, keyboard, pan → saved view ----------------- */
if (want('interact')) {
  console.log('\n[interactions] demo-lima-sur');
  await showMap(page, 'demo-lima-sur');
  await page.evaluate(() => {
    window.__ev = [];
    MT.bus.on('store:click', (e) => window.__ev.push(['click', e]));
    MT.bus.on('view:changed', (e) => window.__ev.push(['view', e]));
  });
  const pick = async (k) => page.evaluate((k) => {
    const items = MT.mapview.items();
    const it = items[k];
    const b = document.querySelector(`.mt-marker-hit[data-store-id="${CSS.escape(it.storeId)}"]`).getBoundingClientRect();
    return { id: it.storeId, name: it.name, x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width };
  }, k);
  const indexOf = (id) => page.evaluate((id) => MT.mapview.items().findIndex((i) => i.storeId === id), id);
  const offsetOf = (id) => page.evaluate((id) => MT.project.getMap('demo-lima-sur').markerOffsets[id] || null, id);
  // Current marker-centre-minus-dot offset of an item (fraction of the frame width), manual or not.
  const autoOffsetOf = (id) => page.evaluate((id) => {
    const it = MT.mapview.items().find((i) => i.storeId === id);
    const W = MT.layout.frame().width;
    return it ? { dx: (it.pos.x - it.anchor.x) / W, dy: (it.pos.y - it.anchor.y) / W } : null;
  }, id);
  // Click → store:click
  const m0 = await pick(3);
  await page.mouse.click(m0.x, m0.y);
  await sleep(150);
  let ev = await page.evaluate(() => window.__ev.slice());
  check(ev.some((e) => e[0] === 'click' && e[1].storeId === m0.id && e[1].mapId === 'demo-lima-sur' && e[1].screen.x > 0), `click emits store:click for ${m0.id}`);
  // Hover → tooltip with the store name
  await page.mouse.move(m0.x + 1, m0.y + 1);
  await sleep(150);
  const tip = await page.evaluate(() => { const t = document.querySelector('.mt-mapview__tip'); return { hidden: t.hidden, text: t.textContent }; });
  check(!tip.hidden && tip.text.includes(m0.name), `hover shows a tooltip with the store name (${tip.text.slice(0, 50)})`);
  await screenshot(page, 'm1-interact-hover', { clip: CLIP });
  // Drag → markerOffsets (72 px right, 48 px up from where the auto-layout had put it)
  const auto0 = await autoOffsetOf(m0.id);
  await page.mouse.move(m0.x, m0.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(m0.x + i * 9, m0.y - i * 6);
  await page.mouse.up();
  await sleep(250);
  let off = await offsetOf(m0.id);
  const manual = await page.evaluate((id) => (MT.mapview.items().find((i) => i.storeId === id) || {}).manual, m0.id);
  check(off && off.dx - auto0.dx > 0.03 && off.dy - auto0.dy < 0 && manual, `drag saves markerOffsets (${JSON.stringify(off)}, auto was ${JSON.stringify(auto0)})`);
  await screenshot(page, 'm1-interact-dragged', { clip: CLIP });
  // Double-click → back to automatic
  const m0b = await pick(await indexOf(m0.id));
  await page.mouse.click(m0b.x, m0b.y, { count: 2 });
  await sleep(300);
  check(await offsetOf(m0.id) === null, 'double-click resets the marker');
  // Keyboard: focus a marker, arrow keys nudge, Enter = click, Delete resets
  const auto1 = await autoOffsetOf(m0.id);
  await page.evaluate((id) => document.querySelector(`.mt-marker-hit[data-store-id="${CSS.escape(id)}"]`).focus(), m0.id);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await sleep(800);
  off = await offsetOf(m0.id);
  check(off && off.dx > auto1.dx, `arrow keys nudge the focused marker (${JSON.stringify(off)}, auto was ${JSON.stringify(auto1)})`);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.dataset.storeId);
  check(focused === m0.id, 'focus stays on the nudged marker');
  await page.keyboard.press('Enter');
  await sleep(100);
  ev = await page.evaluate(() => window.__ev.filter((e) => e[0] === 'click').length);
  check(ev >= 2, 'Enter on a focused marker emits store:click');
  await page.keyboard.press('Escape'); // closes M2's store popup (if mounted) → focus back on the marker
  await sleep(150);
  await page.evaluate((id) => { const b = document.querySelector(`.mt-marker-hit[data-store-id="${CSS.escape(id)}"]`); if (b && document.activeElement !== b) b.focus(); }, m0.id);
  await page.keyboard.press('Delete');
  await sleep(300);
  check(await offsetOf(m0.id) === null, 'Delete resets the focused marker');
  // Pan the map on an empty spot → view saved + chip; chip → back to automatic
  const empty = await page.evaluate(() => { const r = document.querySelector('.mt-mapview').getBoundingClientRect(); return { x: r.left + r.width * 0.93, y: r.top + r.height * 0.9 }; });
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(empty.x - i * 12, empty.y - i * 6);
  await page.mouse.up();
  await sleep(700);
  const v = await page.evaluate(() => ({ view: MT.project.getMap('demo-lima-sur').view, chip: [...document.querySelectorAll('.mt-mapview__chip')].map((c) => c.textContent), ev: window.__ev.filter((e) => e[0] === 'view').length }));
  check(v.view && Array.isArray(v.view.center) && v.ev >= 1, `pan saves the view and emits view:changed (${JSON.stringify(v.view)})`);
  check(v.chip.some((t) => /Encuadre manual/.test(t)), `"Encuadre manual" chip shown (${v.chip.join(' | ')})`);
  await waitForMapIdle(page);
  await screenshot(page, 'm1-interact-panned', { clip: CLIP });
  // The export uses the saved view: same layout as the preview.
  const same = await page.evaluate(async () => {
    const m = MT.project.getMap('demo-lima-sur');
    const r = await MT.render.mapCanvas(m, { scale: 2 });
    const a = MT.mapview.items().map((i) => [i.storeId, i.pos.x.toFixed(3), i.pos.y.toFixed(3)]);
    const b = r.layout.map((i) => [i.storeId, i.pos.x.toFixed(3), i.pos.y.toFixed(3)]);
    return JSON.stringify(a) === JSON.stringify(b);
  });
  check(same, 'export layout === preview layout (saved view)');
  await page.evaluate(() => [...document.querySelectorAll('.mt-mapview__chip')].find((c) => /Encuadre manual/.test(c.textContent)).click());
  await sleep(300);
  check(await page.evaluate(() => MT.project.getMap('demo-lima-sur').view === null), 'chip resets to automatic framing');
  // Wheel zoom over the map saves a view too
  await page.mouse.move(empty.x - 200, empty.y - 200);
  await page.mouse.wheel({ deltaY: -240 });
  await sleep(1000);
  check(await page.evaluate(() => !!MT.project.getMap('demo-lima-sur').view), 'wheel zoom saves the view');
  await page.evaluate(() => MT.project.updateMap('demo-lima-sur', { view: null, markerOffsets: {} }));
}

/* ---- 4. WYSIWYG across screen sizes -------------------------------------------------------------- */
if (want('wysiwyg')) {
  console.log('\n[wysiwyg] resize');
  await showMap(page, 'demo-lima-sur');
  const lay = () => page.evaluate(() => ({ items: JSON.stringify(MT.mapview.items().map((i) => [i.storeId, +i.pos.x.toFixed(3), +i.pos.y.toFixed(3)])),
    frame: MT.mapview.state().frame, legend: [...document.querySelectorAll('.mt-slide__legend-text')].map((e) => e.textContent).join('|') }));
  const a = await lay();
  await page.evaluate(() => { const h = document.getElementById('m1-host'); h.style.width = '980px'; h.style.height = '620px'; });
  await sleep(500);
  await waitForMapIdle(page);
  const b = await lay();
  check(a.frame.width !== b.frame.width && a.items === b.items && a.legend === b.legend, `same layout & legend at frame ${a.frame.width}px and ${b.frame.width}px`);
  await screenshot(page, 'm1-wysiwyg-small', { clip: { x: 0, y: 58, width: 980, height: 620 } });
  await page.evaluate(() => { const h = document.getElementById('m1-host'); h.style.width = '1500px'; h.style.height = '842px'; });
  await sleep(400);
}

/* ---- 5. Dense Miraflores with Tambo/Oxxo (synthetic stores added to the local overlay) ------------- */
if (want('dense')) {
  console.log('\n[dense] Miraflores');
  const st = await page.evaluate(async () => {
    function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
    function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    const r = rng(77);
    const chains = ['tambo', 'oxxo', 'tambo', 'oxxo', 'tambo', 'plazavea', 'wong', 'metro', 'tottus', 'vivanda', 'mass', 'tiendas3a', 'dollarcity', 'florayfauna'];
    const hubs = [[-12.1219, -77.0297], [-12.1253, -77.0228], [-12.1185, -77.0353], [-12.1302, -77.0262], [-12.1120, -77.0300]];
    const list = [];
    for (let i = 0; i < 175; i++) {
      const hub = hubs[i % hubs.length], hubby = r() < 0.5;
      list.push({ id: 'man-dense' + i, chain: chains[i % chains.length], name: 'Tienda prueba ' + i, address: 'Calle ' + i,
        lat: hubby ? hub[0] + gauss(r) * 0.0025 : -12.132 + r() * 0.024, lng: hubby ? hub[1] + gauss(r) * 0.0025 : -77.043 + r() * 0.03, source: 'manual', status: 'verified' });
    }
    await MT.data.upsertStores(list, { op: 'import' });
    // The synthetic set alone (the shipped Miraflores stores hidden) must lay out without overlaps,
    // whatever the real data holds; then the real stores are added on top as a stress case.
    // Every chain on (the demo slides only show the chains of the reference legends).
    const toggles = {};
    MT.data.chains().forEach((c) => { toggles[c.id] = true; });
    const real = MT.data.stores().filter((x) => x.ubigeo === '150122' && x.id.indexOf('man-dense') !== 0).map((x) => x.id);
    const m = MT.project.addMap({ id: 'dense', title: 'Miraflores — densidad alta', peso: '9.9%', districts: ['150122'], chains: toggles, hiddenStores: real });
    MT.layout.clearCache();
    const t0 = performance.now();
    const items = MT.layout.compute(MT.project.getMap(m.id));
    const ms = Math.round(performance.now() - t0);
    MT.project.updateMap(m.id, { hiddenStores: [] });
    MT.layout.clearCache();
    const t1 = performance.now();
    const all = MT.layout.compute(MT.project.getMap(m.id));
    return { id: m.id, n: items.length, ms, overlaps: items.stats.overlaps, real: real.length,
      nAll: all.length, msAll: Math.round(performance.now() - t1), overlapsAll: all.stats.overlaps };
  });
  console.log('  ', JSON.stringify(st));
  check(st.n >= 140 && st.ms < 150 && st.overlaps === 0, `dense Miraflores (synthetic): ${st.n} markers in ${st.ms} ms, ${st.overlaps} overlaps`);
  // With the real stores on top (200+ badges in one district) a few overlaps are acceptable: the
  // preview flags them ("N logos se superponen") and the Mapas tab suggests dots / smaller logos.
  check(st.msAll < 400 && st.overlapsAll <= Math.ceil(st.nAll * 0.06), `dense Miraflores + ${st.real} real stores: ${st.nAll} markers in ${st.msAll} ms, ${st.overlapsAll} overlaps (≤ 6 %)`);
  await showMap(page, st.id);
  await screenshot(page, 'm1-dense-miraflores', { clip: CLIP });
  const img = await page.evaluate(async (id) => (await MT.render.mapCanvas(MT.project.getMap(id), { scale: 3 })).canvas.toDataURL('image/png'), st.id);
  saveDataUrl(img, 'm1-export-map3x-dense.png');
  await page.evaluate(async (id) => {
    MT.project.removeMap(id);
    for (const s of MT.data.stores().filter((x) => x.id.indexOf('man-dense') === 0)) await MT.data.deleteStore(s.id);
  }, st.id);
}

/* ---- 6. Exports: slide canvas + map canvas at 3× ------------------------------------------------- */
if (want('export')) for (const id of ids) {
  if (only && !id.includes(only)) continue;
  console.log(`\n[export] ${id}`);
  const r = await page.evaluate(async (id) => {
    const m = MT.project.getMap(id);
    const t0 = performance.now();
    const slide = await MT.render.slideCanvas(m, { width: 1920 });
    const t1 = performance.now();
    const map = await MT.render.mapCanvas(m, { scale: 3 });
    const t2 = performance.now();
    return { slide: slide.toDataURL('image/png'), sw: slide.width, sh: slide.height, map: map.canvas.toDataURL('image/png'),
      mw: map.canvas.width, mh: map.canvas.height, n: map.layout.length, ms1: Math.round(t1 - t0), ms2: Math.round(t2 - t1) };
  }, id);
  saveDataUrl(r.slide, `m1-export-slide-${id}.png`);
  saveDataUrl(r.map, `m1-export-map3x-${id}.png`);
  console.log(`   slide ${r.sw}×${r.sh} in ${r.ms1} ms · map ${r.mw}×${r.mh} (${r.n} markers) in ${r.ms2} ms`);
  check(r.sw === 1920 && r.sh === 1080, `${id}: slide canvas 1920×1080`);
  check(r.mw === 3000 && Math.abs(r.mh - 2516) <= 1, `${id}: map canvas 3000×2516`);
}
if (want('export') && (!only || 'demo-lima-sur'.includes(only))) {
  console.log('\n[export] largest sizes (4× map, 3840 slide, markers:false for PPTX)');
  const r = await page.evaluate(async () => {
    const m = MT.project.getMap('demo-lima-sur');
    const big = await MT.render.mapCanvas(m, { scale: 4 });
    const slide = await MT.render.slideCanvas(m, { width: 3840 });
    const bare = await MT.render.mapCanvas(m, { scale: 2, markers: false });
    // A blank (all one colour) canvas would mean the WebGL capture failed: sample a few pixels.
    const px = (cv, x, y) => Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data).join(',');
    const samples = new Set([[0.2, 0.2], [0.5, 0.5], [0.8, 0.3], [0.3, 0.8], [0.7, 0.7]].map(([fx, fy]) => px(big.canvas, Math.round(fx * big.canvas.width), Math.round(fy * big.canvas.height))));
    const pic = MT.markers.image(bare.layout[0], MT.layout.styleOf(m), 4);
    return { bw: big.canvas.width, bh: big.canvas.height, sw: slide.width, sh: slide.height, distinct: samples.size,
      slide: slide.toDataURL('image/png'), bare: bare.canvas.toDataURL('image/png'), bareN: bare.layout.length, pic: [pic.canvas.width, pic.canvas.height, +pic.w.toFixed(1)] };
  });
  saveDataUrl(r.slide, 'm1-export-slide-3840.png');
  saveDataUrl(r.bare, 'm1-export-map2x-nomarkers.png');
  check(r.bw === 4000 && Math.abs(r.bh - 3355) <= 1 && r.distinct > 1, `4× map canvas ${r.bw}×${r.bh} (not blank)`);
  check(r.sw === 3840 && r.sh === 2160, `slide canvas ${r.sw}×${r.sh}`);
  check(r.bareN > 0 && r.pic[0] > 0, `markers:false keeps the layout for PPTX pieces (${r.bareN} items, marker picture ${r.pic.join('×')})`);
}

/* ---- 7. Empty states, English UI ------------------------------------------------------------------- */
if (want('states')) {
  console.log('\n[states]');
  await page.evaluate(() => { const m = MT.project.addMap({ id: 'empty', title: '' }); MT.slide.render(MT.project.getMap(m.id)); });
  await sleep(400);
  let st = await page.evaluate(() => ({ notice: document.querySelector('.mt-mapview__notice').textContent, ph: document.querySelector('.mt-slide__title').textContent }));
  check(/Elige los distritos/.test(st.notice) && st.ph === 'Título del mapa', `new map: "${st.notice.slice(0, 40)}…", title placeholder`);
  await screenshot(page, 'm1-state-empty-es', { clip: CLIP });
  await page.evaluate(() => MT.i18n.setLang('en'));
  await sleep(300);
  st = await page.evaluate(() => ({ notice: document.querySelector('.mt-mapview__notice').textContent, ph: document.querySelector('.mt-slide__title').textContent }));
  check(/Choose the districts/.test(st.notice) && st.ph === 'Map title', 'English: notice and placeholder translated');
  await page.evaluate(() => { MT.i18n.setLang('es'); MT.slide.render(null); });
  await sleep(200);
  st = await page.evaluate(() => document.querySelector('.mt-mapview__notice').textContent);
  check(/No hay un mapa seleccionado/.test(st), 'render(null) → "no map" notice');
  await page.evaluate(() => MT.project.removeMap('empty'));
}

/* ---- 8. Radius maths, unknown chains, unreachable basemap ------------------------------------------ */
if (want('data')) {
  console.log('\n[data] radius / unknown chain / basemap failure');
  const rad = await page.evaluate(() => {
    const base = MT.project.getMap('demo-lima-sur');
    // Only Miraflores selected: the radius must still count stores of the other districts.
    const cfg = Object.assign({}, base, { districts: ['150122'], hiddenStores: [] });
    const res = MT.radius.compute(cfg);
    const r = res[0];
    const center = MT.data.store(r.storeId);
    const brute = MT.data.stores().filter((s) => s.id !== center.id && MT.data.chainOn(cfg, s.chain) && MT.geo.distanceMeters(center, s) <= r.meters).map((s) => s.id).sort();
    const got = r.inside.map((x) => x.store.id).slice().sort();
    const sorted = r.inside.every((x, i) => i === 0 || r.inside[i - 1].distance <= x.distance);
    const outside = r.inside.filter((x) => x.store.ubigeo !== '150122').length;
    // Hiding a store removes it from the count.
    const hideId = r.inside.length ? r.inside[0].store.id : null;
    const res2 = MT.radius.compute(Object.assign({}, cfg, { hiddenStores: hideId ? [hideId] : [] }))[0];
    const rows = MT.radius.rows(res);
    const ring = r.circle.geometry.coordinates[0];
    const far = ring.reduce((m, p) => Math.max(m, Math.abs(MT.geo.distanceMeters(center, p) - r.meters)), 0);
    return { n: r.inside.length, same: r.sameChain, comp: r.competitors, eq: JSON.stringify(brute) === JSON.stringify(got), sorted, outside,
      hidden: hideId ? !res2.inside.some((x) => x.store.id === hideId) : true, rows: rows.length, header: rows[0], steps: ring.length, circleErr: far,
      sameOk: r.sameChain === r.inside.filter((x) => x.store.chain === center.chain).length, gone: MT.radius.compute(Object.assign({}, cfg, { radius: [{ storeId: 'nope', meters: 500 }] })).length };
  });
  console.log('  ', JSON.stringify(rad));
  check(rad.eq && rad.sorted, `radius: same stores as brute force (${rad.n}), sorted by distance`);
  check(rad.outside > 0, `radius counts stores outside the selected districts (${rad.outside})`);
  check(rad.sameOk && rad.same + rad.comp === rad.n, `radius: same chain ${rad.same} + competitors ${rad.comp}`);
  check(rad.hidden, 'radius: hidden stores are not counted');
  check(rad.steps === 97 && rad.circleErr < 2, `radius circle is geodesic (97 points, max error ${rad.circleErr.toFixed(2)} m)`);
  check(rad.rows === rad.n + 1 && rad.header[0] === 'Tienda central', 'radius rows for Excel (header + one row per store)');
  check(rad.gone === 0, 'radius entries of deleted stores are skipped');

  // A store of a chain id nobody defined: grey synthesized chain, generated badge, still on map + legend.
  const unk = await page.evaluate(async () => {
    await MT.data.upsertStore({ id: 'man-unknown1', chain: 'cadenanueva', name: 'Cadena Nueva Larco', lat: -12.1265, lng: -77.0301, source: 'manual' });
    const m = MT.project.addMap({ id: 'unk', title: 'Cadena desconocida', districts: ['150122'], chains: { cadenanueva: true } });
    MT.slide.render(MT.project.getMap(m.id));
    await new Promise((r) => setTimeout(r, 400));
    return { on: MT.mapview.items().some((i) => i.storeId === 'man-unknown1'), legend: [...document.querySelectorAll('.mt-slide__legend-text')].map((e) => e.textContent) };
  });
  check(unk.on && unk.legend.some((t) => /CADENANUEVA/.test(t)), `unknown chain id drawn and in the legend (${unk.legend.join(', ')})`);
  await waitForMapIdle(page);
  await screenshot(page, 'm1-unknown-chain', { clip: CLIP });
  await page.evaluate(async () => { MT.project.removeMap('unk'); await MT.data.deleteStore('man-unknown1'); });

  // Unreachable basemap: exports reject with a code + translated message key (no unhandled errors).
  const before = errors.length;
  const fail = await page.evaluate(async () => {
    const keep = MT.theme.basemap.style;
    MT.theme.basemap.style = 'https://tiles.openfreemap.org/styles/no-such-style-m1-test';
    try { await MT.render.mapCanvas(MT.project.getMap('demo-lima-sur'), { scale: 1 }); return { ok: true }; }
    catch (e) { return { ok: false, code: e.code, key: e.messageKey, msg: MT.t(e.messageKey) }; }
    finally { MT.theme.basemap.style = keep; }
  });
  check(!fail.ok && fail.code === 'basemap-unavailable' && /mapa base/.test(fail.msg), `unreachable basemap → ${fail.code} ("${(fail.msg || '').slice(0, 40)}…")`);
  // The browser itself logs the 404 of that request; nothing else may be logged.
  const extra = errors.splice(before).filter((e) => !/404|no-such-style/.test(e));
  check(extra.length === 0, `no other errors during the failed export (${extra.join(' | ')})`);
}

/* ---- 8b. Text stress: long title, many districts, 20+ legend rows ----------------------------------- */
if (want('text')) {
  console.log('\n[text] long title / many districts / long legend');
  const st = await page.evaluate(async () => {
    // 22 stores of 22 different chain ids around Miraflores → 22 legend rows (unknown ids are grey chains).
    const list = [];
    for (let i = 0; i < 22; i++) list.push({ id: 'man-txt' + i, chain: 'cadena' + String.fromCharCode(97 + i) + 'larga', name: 'Tienda ' + i,
      lat: -12.112 - (i % 6) * 0.004, lng: -77.04 + Math.floor(i / 6) * 0.006, source: 'manual' });
    await MT.data.upsertStores(list, { op: 'import' });
    const chains = {};
    list.forEach((s) => { chains[s.chain] = true; });
    const lima = MT.data.districts.all().filter((d) => d.province === 'Lima').slice(0, 14).map((d) => d.ubigeo).concat(['150122']);
    const m = MT.project.addMap({ id: 'txt', title: 'Supermercados y tiendas de conveniencia — Lima Metropolitana Centro y Sur (actualizado)', peso: '15.8%',
      districts: lima, chains: chains, onlyInside: false, fitTo: 'stores' });
    MT.slide.render(MT.project.getMap(m.id));
    await new Promise((r) => setTimeout(r, 500));
    const g = MT.slide.layout(MT.project.getMap(m.id), 1920);
    return { titlePx: g.title.fontPx, title: g.title.text, lines: g.subtitle.lines.length, subPx: g.subtitle.fontPx, cols: g.legend.cols, rows: g.legend.rows.length,
      cut: g.legend.rows.filter((r) => /…/.test(r.text)).length, fontPx: g.legend.fontPx };
  });
  console.log('  ', JSON.stringify(st));
  check(st.lines === 2, `long district list wraps to 2 subtitle lines (${st.lines})`);
  check(st.rows >= 22 && st.cols >= 2 && st.cut === 0, `${st.rows} legend rows in ${st.cols} columns, none cut`);
  await waitForMapIdle(page);
  await screenshot(page, 'm1-text-stress', { clip: CLIP });
  const img = await page.evaluate(async () => (await MT.render.slideCanvas(MT.project.getMap('txt'), { width: 1920 })).toDataURL('image/png'));
  saveDataUrl(img, 'm1-export-slide-text-stress.png');
  await page.evaluate(async () => { MT.project.removeMap('txt'); for (let i = 0; i < 22; i++) await MT.data.deleteStore('man-txt' + i); });
}

check(errors.length === 0, `no console errors (${errors.length})`);
errors.forEach((e) => console.log('    ', e));
await browser.close();

/* ---- 9. No data files at all: the preview explains it, nothing breaks ------------------------------- */
if (want('missing')) {
  console.log('\n[missing] no data files');
  const app = await openApp({ lang: 'es', fixtures: 'none', headless, viewport: { width: 1500, height: 900 } });
  const st = await app.page.evaluate(async () => {
    const host = MT.util.h('div', { id: 'm1-host', style: { position: 'fixed', left: '0', top: '58px', width: '1500px', height: '842px', zIndex: 60, background: '#F4F4F5' } });
    document.body.appendChild(host);
    MT.slide.mount(host);
    MT.slide.render(MT.project.currentMap());
    await new Promise((r) => setTimeout(r, 500));
    return { notice: document.querySelector('.mt-mapview__notice').textContent, legend: MT.legend.items(MT.project.currentMap()).length, layout: MT.layout.compute(MT.project.currentMap()).length };
  });
  check(/Falta la base de tiendas/.test(st.notice) && st.legend === 0 && st.layout === 0, `missing data → "${st.notice.slice(0, 30)}…", empty legend/layout`);
  await screenshot(app.page, 'm1-missing-data', { clip: CLIP });
  const unexpected = app.errors.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
  check(unexpected.length === 0, `only file-not-found errors (${unexpected.join(' | ')})`);
  await app.browser.close();
}

/* ---- 10. No WebGL: markers + legend still shown, the frame explains the missing basemap ------------ */
if (want('nowebgl')) {
  console.log('\n[nowebgl] Chrome with --disable-3d-apis');
  const { dir, url } = prepareApp({ fixtures: 'missing' });
  const b = await launch({ headless, args: ['--disable-3d-apis'] });
  const [pg] = await b.pages();
  await pg.setViewport({ width: 1500, height: 900 });
  const errs = collectErrors(pg);
  await pg.goto(url + '?lang=es', { waitUntil: 'load' });
  await pg.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
  await loadDemoProject(pg);
  const st = await pg.evaluate(async () => {
    const host = MT.util.h('div', { id: 'm1-host', style: { position: 'fixed', left: '0', top: '58px', width: '1500px', height: '842px', zIndex: 60, background: '#F4F4F5' } });
    document.body.appendChild(host);
    MT.slide.mount(host);
    MT.slide.render(MT.project.getMap('demo-lima-sur'));
    await new Promise((r) => setTimeout(r, 600));
    let exportErr = null;
    try { await MT.render.mapCanvas(MT.project.getMap('demo-lima-sur'), { scale: 1 }); } catch (e) { exportErr = e.code; }
    return { state: MT.mapview.state(), notice: document.querySelector('.mt-mapview__notice').textContent,
      legend: document.querySelectorAll('.mt-slide__legend-row').length, exportErr };
  });
  check(!st.state.webgl && st.state.n > 0 && st.legend > 0, `no WebGL → ${st.state.n} markers and ${st.legend} legend rows still shown`);
  check(/no puede dibujar el mapa/.test(st.notice), `no WebGL → notice ("${st.notice.slice(0, 40)}…")`);
  check(st.exportErr === 'webgl-unavailable', `no WebGL → exports reject with webgl-unavailable, not a network error (${st.exportErr})`);
  await screenshot(pg, 'm1-nowebgl', { clip: CLIP });
  const unexpected = errs.filter((e) => !/WebGL|webgl/.test(e));
  check(unexpected.length === 0, `no unexpected errors (${unexpected.join(' | ')})`);
  await b.close();
  void dir;
}
finish();
