// tools/test/export.test.mjs — module M4 (PNG / PowerPoint / interactive HTML exports) in headless
// Chrome from file://, on the demo project (tools/fixtures/demo.mapa.json = the 4 reference slides).
//
//   node tools/test/export.test.mjs                       all sections
//   node tools/test/export.test.mjs --section=pptx,html   sections: ui, png, pptx, html, errors
//   node tools/test/export.test.mjs --office              also render the .pptx with the installed
//                                                         PowerPoint (Windows, COM) → out/m4-office-*.png
//   node tools/test/export.test.mjs --headful
//
// Outputs (tools/test/out/): m4-*.png screenshots and renders, m4-demo.pptx, m4-demo.html, downloads/.
// PPTX checks: the file is a valid OOXML package (re-opened with JSZip), one slide per map + store
// table slide(s) for the 'number' style, every marker is its own named picture placed exactly where
// MT.layout puts it (EMU positions compared with reference-frame → inch conversion), identical marker
// pictures are stored once per slide, and an independent re-draw of the slide from the PPTX XML +
// media matches the PNG slide export (mean pixel difference in the map frame).
// Needs network (OpenFreeMap tiles; unpkg / jsDelivr for the HTML page).

import { openApp, launch, collectErrors, screenshot, makeChecker, loadDemoProject, captureDownloads, waitForDownload, sleep, ROOT, OUT } from './lib.mjs';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const headless = !process.argv.includes('--headful');
const office = process.argv.includes('--office');
const sections = (process.argv.find((a) => a.startsWith('--section=')) || '').slice(10).split(',').filter(Boolean);
const want = (name) => !sections.length || sections.includes(name);
const { check, finish } = makeChecker('export');
mkdirSync(OUT, { recursive: true });

/** Temp-copy logos.js from the real logo PNGs (when the data workflow has not produced logos.js yet). */
function realLogosJs() {
  const dir = path.join(ROOT, 'logos');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (!files.length) return null;
  const out = {};
  for (const f of files) {
    const m = /^(.+?)(-wide)?\.png$/.exec(f);
    out[m[1]] = out[m[1]] || {};
    out[m[1]][m[2] ? 'wide' : 'badge'] = 'data:image/png;base64,' + readFileSync(path.join(dir, f)).toString('base64');
  }
  for (const id of Object.keys(out)) if (!out[id].badge) delete out[id];
  return 'window.MT_LOGOS = ' + JSON.stringify(out) + ';\n';
}

const app = await openApp({ lang: 'es', headless, viewport: { width: 1440, height: 900 } });
const { browser, page, errors } = app;
if (app.injected.includes('logos/logos.js')) {
  const js = realLogosJs();
  if (js) {
    writeFileSync(path.join(app.dir, 'logos', 'logos.js'), js);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true);
    console.log('  (temporary logos.js from logos/*.png)');
  }
}
console.log('  fixtures injected for:', app.injected.join(', ') || 'none');
const ids = await loadDemoProject(page);
check(ids.length === 4, 'demo project loaded (4 maps)');
// The demo maps are all badges (like the reference deck): add one copy per other marker style.
// Numbered style (store-table slide) — a copy of Lima Sur.
const numId = await page.evaluate(() => {
  const src = MT.project.getMap('demo-lima-sur');
  const m = MT.project.addMap(Object.assign(MT.util.clone(src), { id: undefined, title: 'Lima Sur — numerado', markerStyle: 'number', radius: [] }), { select: false });
  return m.id;
});
// Cards sorted by count (Trujillo) and dots with district borders fitted to the districts (Chimbote),
// with every chain but Tambo/Oxxo on: the Trujillo cards are crowded enough for logos shown as dots
// (same-chain grouping off on that copy, so the "dots" path stays covered; the demo's Lima Cono Sur
// groups its stores automatically).
const [cardId, dotId] = await page.evaluate(() => {
  const chains = {};
  MT.data.chains().forEach((c) => { chains[c.id] = c.id !== 'tambo' && c.id !== 'oxxo'; });
  return [
    ['demo-trujillo', { title: 'Trujillo — tarjetas', markerStyle: 'card', legendSort: 'count', chains, groupNearby: false }],
    ['demo-chimbote', { title: 'Chimbote — puntos', markerStyle: 'dot', showBorders: true, fitTo: 'districts', chains }],
  ].map(([id, patch]) => MT.project.addMap(Object.assign(MT.util.clone(MT.project.getMap(id)), { id: undefined }, patch), { select: false }).id);
});
const nMaps = ids.length + 3;
const downloads = await captureDownloads(page);

/** Blob produced in the page → Buffer in Node. */
async function pageBlob(expr) {
  const b64 = await page.evaluate(async (expr) => {
    // eslint-disable-next-line no-eval
    const blob = await (0, eval)(expr);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, expr);
  return Buffer.from(b64, 'base64');
}
function pngInfo(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  let dpi = null;
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'pHYs') { dpi = buf.readUInt32BE(p + 8) * 0.0254; break; }
    if (type === 'IDAT') break;
    p += 12 + len;
  }
  return { w, h, dpi };
}

/* ---- 1. UI: project menu + export dialog ---------------------------------------------------------- */
if (want('ui')) {
  console.log('\n[ui] menu + dialog');
  await page.evaluate(() => MT.app.showTab('maps'));
  const menu = await page.evaluate(async () => {
    document.querySelector('button[aria-haspopup="menu"][aria-label="' + MT.t('project.menu') + '"]')?.click();
    await MT.util.sleep(250);
    const labels = [...document.querySelectorAll('.mt-menu__item')].map((b) => b.textContent.trim());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector('.mt-menu') && document.querySelector('.mt-menu').remove();
    return labels;
  });
  check(['Exportar a PowerPoint…', 'Exportar imagen PNG…', 'Exportar mapa interactivo (HTML)…'].every((l) => menu.some((m) => m.includes(l))), 'project menu has the 3 export entries');
  await page.evaluate(() => { MT.project.select('demo-lima-sur'); window.__dlg = MT.export.dialog({ format: 'pptx' }); });
  await sleep(900);
  const d1 = await page.evaluate(() => ({
    formats: [...document.querySelectorAll('.mt-export__fmt')].map((x) => x.dataset.format),
    checked: document.querySelector('.mt-export__fmt.is-checked')?.dataset.format,
    maps: [...document.querySelectorAll('.mt-export__map')].map((x) => [x.querySelector('.mt-export__map-title').textContent, x.querySelector('input').checked, x.querySelector('.mt-export__map-meta').textContent]),
    summary: document.querySelector('.mt-export__summary')?.textContent,
    focus: document.activeElement && document.activeElement.closest('.mt-export__fmt') ? 'format' : document.activeElement?.tagName,
  }));
  console.log('   ', JSON.stringify(d1));
  check(d1.formats.join() === 'pptx,slide,map,html' && d1.checked === 'pptx', 'dialog: 4 formats, PowerPoint preselected');
  check(d1.maps.length === nMaps && d1.maps[0][1] === true && d1.maps.filter((m) => m[1]).length === 1, 'dialog: current map preselected');
  check(d1.maps.every((m) => /^\d+ tiendas?( · \d+ como puntos?)?$|^Sin tiendas visibles$/.test(m[2])), 'dialog: visible-store count of every map filled in (+ logos shown as dots)');
  check(d1.maps.some((m) => / como puntos?$/.test(m[2])), 'dialog: a crowded slide says how many stores will be dots');
  check(/Lima Metropolitana Sur\.pptx/.test(d1.summary || ''), 'dialog: summary names the file');
  check(d1.focus === 'format', 'dialog: focus on the selected format');
  await screenshot(page, 'm4-dialog-pptx');
  // Keyboard: arrow → next format (PNG slide) shows the resolution choice.
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  const d2 = await page.evaluate(() => ({ checked: document.querySelector('.mt-export__fmt.is-checked')?.dataset.format, res: [...document.querySelectorAll('.mt-export__res-opt')].map((x) => x.textContent) }));
  check(d2.checked === 'slide' && d2.res.length === 2, 'dialog: arrow key → "Lámina como imagen" with 2 resolutions ' + JSON.stringify(d2.res));
  await page.evaluate(() => { [...document.querySelectorAll('.mt-export__fmt')].find((x) => x.dataset.format === 'map').click(); });
  await sleep(150);
  await page.evaluate(() => { [...document.querySelectorAll('.mt-export__label-actions button')][0].click(); });
  await sleep(150);
  const d3 = await page.evaluate(() => ({ res: [...document.querySelectorAll('.mt-export__res-opt')].map((x) => x.textContent), summary: document.querySelector('.mt-export__summary').textContent, n: [...document.querySelectorAll('.mt-export__map input')].filter((x) => x.checked).length }));
  check(d3.res.length === 3 && d3.n === nMaps && /\.zip/.test(d3.summary), 'dialog: map PNG → 3 scales; "Todos" → zip summary: ' + d3.summary);
  await screenshot(page, 'm4-dialog-map-all');
  await page.evaluate(() => { [...document.querySelectorAll('.mt-export__label-actions button')][1].click(); });
  await sleep(100);
  const d4 = await page.evaluate(() => ({ disabled: document.querySelector('.mt-modal__footer .mt-btn--primary').disabled, summary: document.querySelector('.mt-export__summary').textContent }));
  check(d4.disabled && /Elige al menos una lámina/.test(d4.summary), 'dialog: no map → Export disabled + hint');
  await page.keyboard.press('Escape');
  const dres = await page.evaluate(() => window.__dlg);
  check(dres === null, 'dialog: Esc cancels (resolves null)');
  // English dialog.
  await page.evaluate(() => { MT.i18n.setLang('en'); window.__dlg = MT.export.dialog({ format: 'html' }); });
  await sleep(700);
  await screenshot(page, 'm4-dialog-html-en');
  const en = await page.evaluate(() => document.querySelector('.mt-modal__title').textContent + ' | ' + document.querySelector('.mt-export__fmt.is-checked .mt-export__fmt-name').textContent);
  check(en === 'Export | Interactive map', 'dialog in English: ' + en);
  await page.keyboard.press('Escape');
  await page.evaluate(() => MT.i18n.setLang('es'));
  await sleep(200);
  // i18n parity of the export dictionary
  const parity = await page.evaluate(() => {
    const es = MT.i18n.keys('es').filter((k) => k.startsWith('export.')), en = MT.i18n.keys('en').filter((k) => k.startsWith('export.'));
    return { es: es.length, en: en.length, onlyEs: es.filter((k) => !en.includes(k)), onlyEn: en.filter((k) => !es.includes(k)) };
  });
  check(parity.onlyEs.length === 0 && parity.onlyEn.length === 0, `export.* keys in ES/EN parity (${parity.es})`);
}

/* ---- 2. PNG ------------------------------------------------------------------------------------- */
if (want('png')) {
  console.log('\n[png] slide + map PNG');
  let t0 = Date.now();
  const slide = await pageBlob(`MT.export.png('demo-lima-sur', {kind:'slide', width:1920, download:false, ui:false}).then(r => r.blobs[0].blob)`);
  writeFileSync(path.join(OUT, 'm4-png-slide-lima-sur.png'), slide);
  let info = pngInfo(slide);
  check(info.w === 1920 && info.h === 1080 && Math.abs(info.dpi - 144) < 0.5, `slide PNG 1920×1080 @ ${info.dpi && info.dpi.toFixed(1)} dpi (${Date.now() - t0} ms)`);
  t0 = Date.now();
  const map2 = await pageBlob(`MT.export.png('demo-chimbote', {kind:'map', scale:2, download:false, ui:false}).then(r => r.blobs[0].blob)`);
  writeFileSync(path.join(OUT, 'm4-png-map-chimbote-2x.png'), map2);
  info = pngInfo(map2);
  check(info.w === 2000 && info.h === 1677 && Math.abs(info.dpi - 2000 / 7.75) < 0.5, `map PNG 2× = 2000×1677 @ ${info.dpi && info.dpi.toFixed(1)} dpi (frame = 7.75 in) (${Date.now() - t0} ms)`);
  // Several maps → one zip (download:false to inspect it).
  t0 = Date.now();
  const zipInfo = await page.evaluate(async (ids) => {
    const r = await MT.export.png(ids, { kind: 'slide', width: 1920, download: false, ui: false });
    const zip = await window.JSZip.loadAsync(r.blobs[0].blob);
    const names = Object.keys(zip.files);
    const first = await zip.file(names[0]).async('uint8array');
    return { files: r.files, entries: r.entries, names, sig: Array.from(first.slice(0, 4)) };
  }, ['demo-trujillo', 'demo-chimbote']);
  console.log('   ', JSON.stringify(zipInfo));
  check(zipInfo.files.length === 1 && /láminas PNG\.zip$/.test(zipInfo.files[0]) && zipInfo.names.length === 2 && zipInfo.names[0] === '01 Trujillo - lámina.png' && zipInfo.sig[1] === 0x50,
    `2 maps → 1 zip with 2 PNGs (${Date.now() - t0} ms)`);
  // The real UI path: progress overlay, download, success toast.
  t0 = Date.now();
  const busySeen = page.waitForSelector('.mt-busy', { timeout: 10000 }).then(() => true).catch(() => false);
  await page.evaluate(() => { window.__run = MT.export.run('slide', ['demo-trujillo'], { width: 1920 }); });
  check(await busySeen, 'progress overlay shown during export');
  await sleep(1200);
  await screenshot(page, 'm4-busy');
  const res = await page.evaluate(() => window.__run);
  const file = await waitForDownload(downloads, /Trujillo - lámina\.png$/);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.mt-toast')].map((t) => t.textContent).join(' | '));
  check(res && res.files[0] === 'Trujillo - lámina.png' && statSync(file).size > 100000, `run('slide') downloaded ${path.basename(file)} (${statSync(file).size} B, ${Date.now() - t0} ms)`);
  check(/Listo: se descargó «Trujillo - lámina\.png»/.test(toast), 'success toast: ' + toast);
}

/* ---- 3. PowerPoint ---------------------------------------------------------------------------------- */
if (want('pptx')) {
  console.log('\n[pptx] whole project → one deck');
  const all = ids.concat([numId, cardId, dotId]);
  let t0 = Date.now();
  // Plans (the slide as data) for the geometry checks; same cache semantics as the export.
  const pptBuf = await pageBlob(`MT.export.pptx(${JSON.stringify(all)}, {download:false, ui:false}).then(r => (window.__pptxRes = r, r.blobs[0].blob))`);
  const ms = Date.now() - t0;
  const pptPath = path.join(OUT, 'm4-demo.pptx');
  writeFileSync(pptPath, pptBuf);
  const name = await page.evaluate(() => window.__pptxRes.files[0]);
  check(pptBuf.length > 100000 && pptBuf[0] === 0x50 && pptBuf[1] === 0x4b, `deck written: ${name} — ${(pptBuf.length / 1048576).toFixed(1)} MB in ${ms} ms`);

  // Re-open the package in the page (JSZip) and extract what we need.
  const pkg = await page.evaluate(async (b64) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const zip = await window.JSZip.loadAsync(bytes);
    const files = Object.keys(zip.files);
    const slides = files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    const out = { files, slides: [] };
    for (const s of slides) {
      const xml = await zip.file(s).async('string');
      const relsPath = s.replace('slides/', 'slides/_rels/') + '.rels';
      const rels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '';
      out.slides.push({ path: s, xml, rels });
    }
    out.contentTypes = await zip.file('[Content_Types].xml').async('string');
    out.presentation = await zip.file('ppt/presentation.xml').async('string');
    out.media = files.filter((f) => f.startsWith('ppt/media/')).length;
    return out;
  }, pptBuf.toString('base64'));
  const slideCount = pkg.slides.length;
  const tableSlides = pkg.slides.filter((s) => s.xml.includes('<a:tbl>')).length;
  check(/sldSz cx="12192000" cy="6858000"/.test(pkg.presentation), 'LAYOUT_WIDE 13.333 × 7.5 in');
  check(slideCount === all.length + tableSlides && tableSlides >= 1, `${slideCount} slides = ${all.length} maps + ${tableSlides} store-table slide(s) for the numbered map`);
  check(pkg.contentTypes.includes('presentationml.slide+xml') && pkg.files.includes('ppt/presentation.xml'), 'valid OOXML package structure');

  // Expected geometry, computed independently from M1's layout (reference units → inches).
  const expect = await page.evaluate((all) => all.map((id) => {
    const cfg = MT.project.getMap(id), th = MT.theme;
    const items = MT.layout.compute(cfg), style = MT.layout.styleOf(cfg);
    const fx = th.mapFrame.x, fy = th.mapFrame.y, k = th.mapFrame.w / 1000;
    // Logos that found no room near their store are ring-colour ellipses, not pictures; stores drawn
    // by their chain's group logo ("Tiendas 3A ×5") are only their dot.
    const collapsed = items.filter((it) => it.collapsed).length;
    const grouped = items.filter((it) => it.grouped).length;
    const pics = items.filter((it) => style.kind !== 'dot' && !it.collapsed && !it.grouped).map((it) => {
      const m = MT.markers.shadowMargin(style);
      const name = it.count > 1 ? MT.data.chain(it.chainId).name + ' ×' + it.count : it.name;
      return { name: name, x: fx + (it.pos.x - it.w / 2 - m) * k, y: fy + (it.pos.y - it.h / 2 - m) * k, w: (it.w + 2 * m) * k, h: (it.h + 2 * m) * k };
    });
    const dots = items.filter((it) => !it.collapsed && (style.kind !== 'dot' || it.displaced)).map((it) => {
      const r = MT.markers.anchorRadius(style);
      const d = it.dot || it.anchor;   // spread off a neighbour's dot (MT.layout)
      return { name: 'Ubicación — ' + it.name, x: fx + (d.x - r) * k, y: fy + (d.y - r) * k, w: 2 * r * k };
    });
    const leaders = items.filter((it) => it.leader).length;
    // A grouped logo's spokes (store dot → logo / neighbouring store dot): glued connectors too.
    const spokes = (th.marker.spoke && th.marker.spoke.width > 0) ? items.reduce((n, it) => n + (it.spokes || []).length, 0) : 0;
    const halo = !!(th.marker.leader.halo && th.marker.leader.halo.width > 0);
    const legend = MT.legend.items(cfg, items).map((r) => r.text);
    const note = MT.legend.items(cfg, items).footnote || '';
    // Distinct marker pictures: one per chain, and one per chain and group size.
    const chains = new Set(items.filter((it) => !it.collapsed && !it.grouped).map((it) => it.chainId + '|' + (it.count || 1))).size;
    return { id, kind: style.kind, n: items.length, collapsed, grouped, pics, dots, leaders, spokes, halo, legend, note, title: cfg.title, chains, attrPt: th.attribution.pptx && th.attribution.pptx.sizePt };
  }), all);

  const EMU = 914400;
  const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const parseShapes = (xml) => {
    const out = [];
    const re = /<p:(pic|sp|cxnSp)>([\s\S]*?)<\/p:\1>/g;
    let m;
    while ((m = re.exec(xml))) {
      const body = m[2];
      const nm = /<p:cNvPr id="\d+" name="([^"]*)"/.exec(body);
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(body), ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(body);
      const geom = /<a:prstGeom prst="(\w+)"/.exec(body);
      const emb = /r:embed="(rId\d+)"/.exec(body);
      const txt = unxml([...body.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join(''));
      out.push({ tag: m[1], name: nm ? unxml(nm[1]) : '',
        x: off ? +off[1] / EMU : null, y: off ? +off[2] / EMU : null, w: ext ? +ext[1] / EMU : null, h: ext ? +ext[2] / EMU : null,
        geom: geom ? geom[1] : null, embed: emb ? emb[1] : null, text: txt, body });
    }
    return out;
  };
  const mapSlides = pkg.slides.filter((s) => !s.xml.includes('<a:tbl>'));
  let worst = 0, matched = 0, totalPics = 0;
  expect.forEach((e, i) => {
    const sl = mapSlides[i];
    const shapes = parseShapes(sl.xml);
    const pics = shapes.filter((s) => s.tag === 'pic');
    const byName = {};
    pics.forEach((p) => { (byName[p.name] = byName[p.name] || []).push(p); });
    e.pics.forEach((p) => {
      const cand = (byName[p.name] || []).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
      totalPics++;
      if (!cand) return;
      const err = Math.max(Math.abs(cand.x - p.x), Math.abs(cand.y - p.y), Math.abs(cand.w - p.w), Math.abs(cand.h - p.h));
      worst = Math.max(worst, err);
      if (err < 0.002) matched++;
    });
    const dotShapes = shapes.filter((s) => s.tag === 'sp' && s.geom === 'ellipse' && s.name.startsWith('Ubicación'));
    let dotWorst = 0;
    e.dots.forEach((d) => {
      const c = dotShapes.find((s) => s.name === d.name && Math.abs(s.x - d.x) < 0.01 && Math.abs(s.y - d.y) < 0.01);
      dotWorst = Math.max(dotWorst, c ? Math.max(Math.abs(c.x - d.x), Math.abs(c.y - d.y), Math.abs(c.w - d.w)) : 1);
    });
    // Leaders are connectors glued to their dot and marker (straightConnector1), inside the "Mapa" group.
    const lines = shapes.filter((s) => s.geom === 'line' || s.geom === 'straightConnector1').length;
    const connectors = shapes.filter((s) => s.tag === 'cxnSp' && /<a:stCxn id="\d+"/.test(s.body) && /<a:endCxn id="\d+"/.test(s.body)).length;
    const grouped = /<p:grpSp><p:nvGrpSpPr><p:cNvPr id="\d+" name="Mapa"\/>/.test(sl.xml);
    const ph = /<p:cNvPr id="\d+" name="Título"\/><p:cNvSpPr\/><p:nvPr><p:ph [^>]*type="title"/.test(sl.xml);
    const title = shapes.find((s) => s.name === 'Título');
    const sub = shapes.find((s) => s.name === 'Subtítulo');
    const legendTexts = shapes.filter((s) => s.tag === 'sp' && s.name.startsWith('Leyenda — ') && s.text && s.name !== 'Leyenda — título').map((s) => s.text);
    const legendPics = pics.filter((p) => p.name.startsWith('Leyenda — ')).length;
    const base = pics.find((p) => p.name === 'Mapa base');
    const attrib = shapes.find((s) => s.name === 'Atribución');
    const radius = shapes.filter((s) => s.geom === 'ellipse' && s.name.startsWith('Radio'));
    const pesoU = sub ? /<a:rPr[^>]*\bu="sng"[^>]*\bb="1"|<a:rPr[^>]*\bb="1"[^>]*\bu="sng"/.test(sub.body) : false;
    console.log(`   ${e.id}: ${e.kind}, ${e.n} markers → ${pics.length} pictures, ${lines} leader lines, dot worst ${dotWorst.toFixed(4)} in, legend [${legendTexts.join(', ')}]`);
    check(base && Math.abs(base.x - 0.35) < 1e-3 && Math.abs(base.y - 0.85) < 1e-3 && Math.abs(base.w - 7.75) < 1e-3 && Math.abs(base.h - 6.5) < 1e-3, `${e.id}: basemap picture exactly at the map frame (0.35, 0.85, 7.75 × 6.5 in)`);
    if (e.kind !== 'dot') {
      check(pics.filter((p) => !p.name.startsWith('Leyenda') && p.name !== 'Mapa base' && p.name !== 'Panel de leyenda').length === e.n - e.collapsed - e.grouped,
        `${e.id}: one picture per marker (${e.n - e.collapsed - e.grouped}${e.collapsed ? ' + ' + e.collapsed + ' shown as dots' : ''}${e.grouped ? ' + ' + e.grouped + ' stores in grouped logos' : ''})`);
      if (e.collapsed) check(shapes.filter((s) => s.geom === 'ellipse' && !s.name.startsWith('Ubicación') && !s.name.startsWith('Radio')).length === e.collapsed, `${e.id}: ${e.collapsed} logos without room → ellipses`);
    } else check(shapes.filter((s) => s.geom === 'ellipse' && !s.name.startsWith('Ubicación') && !s.name.startsWith('Radio')).length === e.n, `${e.id}: dot style → ${e.n} dot shapes`);
    // Every leader is a connector glued to its dot and marker — and so is its white halo, under it.
    const nl = e.leaders * (e.halo ? 2 : 1) + e.spokes;
    check(lines === nl && connectors === nl, `${e.id}: ${e.leaders} leaders${e.halo ? ' + halos' : ''}${e.spokes ? ' + ' + e.spokes + ' group spokes' : ''} as connectors glued to dot and marker (${connectors})`);
    check(grouped, `${e.id}: the map frame objects are one group "Mapa"`);
    if (e.title) check(ph, `${e.id}: the title is the slide's title placeholder`);
    check(dotWorst < 0.002, `${e.id}: store dots as ellipses at the layout positions`);
    if (e.title) check(title && title.text === e.title && /latin typeface="Calibri"/.test(title.body) && /b="1"/.test(title.body), `${e.id}: title is real Calibri bold text "${title && title.text}"`);
    if (sub) check(pesoU && /1F3864/i.test(sub.body), `${e.id}: subtitle "${sub.text}" with Peso bold + underlined + navy`);
    check(legendTexts.join('|') === e.legend.join('|') && legendPics === e.legend.length, `${e.id}: legend rows = picture + text, same as MT.legend (${e.legend.length})`);
    check(attrib && /OpenStreetMap/.test(attrib.text), `${e.id}: attribution text box`);
    if (e.attrPt) check(attrib && new RegExp('sz="' + Math.round(e.attrPt * 100) + '"').test(attrib.body) && !/<a:normAutofit/.test(attrib.body), `${e.id}: attribution at ${e.attrPt} pt`);
    // The key for grouped logos ("×N = N tiendas cercanas · • = ubicación exacta") under the legend.
    const noteShape = shapes.find((s) => s.name === 'Nota de la leyenda');
    check(e.note ? !!noteShape && noteShape.text === e.note : !noteShape, `${e.id}: legend key ${e.note ? '"' + e.note + '"' : 'absent (no grouped logos)'}`);
    if (e.id === 'demo-lima-sur') check(radius.length === 1 && /prstDash val="dash"/.test(radius[0].body) && /alpha val=/.test(radius[0].body), `${e.id}: radius circle = dashed ellipse with translucent fill`);
    // Identical marker pictures (same chain, same style) are stored once per slide.
    const markerPics = pics.filter((p) => !p.name.startsWith('Leyenda') && p.name !== 'Mapa base' && p.name !== 'Panel de leyenda');
    const markerMedia = new Set([...sl.rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].filter((m) => markerPics.some((p) => p.embed === m[1])).map((m) => m[2]));
    if (e.kind === 'badge' || e.kind === 'card') check(markerMedia.size <= e.chains && markerMedia.size < markerPics.length, `${e.id}: ${markerPics.length} marker pictures share ${markerMedia.size} media files (${e.chains} chain / group-size pictures)`);
  });
  check(matched === totalPics && worst < 0.002, `every marker picture at its layout position: ${matched}/${totalPics}, worst error ${worst.toFixed(5)} in`);
  // Store table slide(s)
  const tbl = pkg.slides.filter((s) => s.xml.includes('<a:tbl>'));
  const rows = tbl.reduce((n, s) => n + (s.xml.match(/<a:tr /g) || []).length, 0);
  const nNum = expect.find((e) => e.id === numId).n;
  check(rows === nNum + tbl.length, `store table: ${nNum} stores (+ repeated header on ${tbl.length} slide(s))`);
  check(/N°/.test(tbl[0].xml) && /Dirección/.test(tbl[0].xml), 'store table headers in Spanish');

  // Independent re-draw of slide 1 from the PPTX (XML + media) vs the PNG slide export.
  const cmp = await page.evaluate(async (b64) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const zip = await window.JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const relMap = {};
    for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2].replace('../', 'ppt/');
    const W = 1920, k = W / 13.333, EMU = 914400;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = 1080;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, 1080);
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main', P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    // Shapes in drawing order, group members included (the "Mapa" group keeps slide coordinates).
    const flat = (el) => [...el.children].flatMap((c) => (c.localName === 'grpSp' ? flat(c) : [c]));
    const nodes = flat(doc.getElementsByTagNameNS(P, 'spTree')[0]).filter((c) => /^(sp|pic|cxnSp)$/.test(c.localName));
    const imgCache = {};
    const loadImg = async (p) => imgCache[p] || (imgCache[p] = await new Promise(async (res) => {
      const b = await zip.file(p).async('base64');
      const im = new Image(); im.onload = () => res(im); im.src = 'data:image/' + (p.endsWith('png') ? 'png' : 'jpeg') + ';base64,' + b;
    }));
    const colorOf = (el) => {
      const s = el && el.getElementsByTagNameNS(A, 'srgbClr')[0];
      if (!s) return null;
      const a = s.getElementsByTagNameNS(A, 'alpha')[0];
      const hex = s.getAttribute('val');
      const al = a ? +a.getAttribute('val') / 100000 : 1;
      return 'rgba(' + parseInt(hex.slice(0, 2), 16) + ',' + parseInt(hex.slice(2, 4), 16) + ',' + parseInt(hex.slice(4, 6), 16) + ',' + al + ')';
    };
    for (const n of nodes) {
      const xfrm = n.getElementsByTagNameNS(A, 'xfrm')[0];
      if (!xfrm) continue;
      const off = xfrm.getElementsByTagNameNS(A, 'off')[0], ext = xfrm.getElementsByTagNameNS(A, 'ext')[0];
      const x = +off.getAttribute('x') / EMU * k, y = +off.getAttribute('y') / EMU * k, w = +ext.getAttribute('cx') / EMU * k, h = +ext.getAttribute('cy') / EMU * k;
      if (n.localName === 'pic') {
        const blip = n.getElementsByTagNameNS(A, 'blip')[0];
        const im = await loadImg(relMap[blip.getAttributeNS(R, 'embed')]);
        ctx.drawImage(im, x, y, w, h);
        continue;
      }
      const geom = n.getElementsByTagNameNS(A, 'prstGeom')[0];
      const prst = geom ? geom.getAttribute('prst') : 'rect';
      const spPr = n.getElementsByTagNameNS(P, 'spPr')[0];
      const fill = spPr && [...spPr.children].find((c) => c.localName === 'solidFill');
      const ln = spPr && [...spPr.children].find((c) => c.localName === 'ln');
      const lnFill = ln && [...ln.children].find((c) => c.localName === 'solidFill');
      const lw = ln && ln.getAttribute('w') ? +ln.getAttribute('w') / EMU * k : 1;
      ctx.beginPath();
      if (prst === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else if (prst === 'line' || prst === 'straightConnector1') {
        const fh = xfrm.getAttribute('flipH') === '1', fv = xfrm.getAttribute('flipV') === '1';
        ctx.moveTo(fh ? x + w : x, fv ? y + h : y); ctx.lineTo(fh ? x : x + w, fv ? y : y + h);
      } else ctx.rect(x, y, w, h);
      if (fill && prst !== 'line') { ctx.fillStyle = colorOf(fill); ctx.fill(); }
      if (lnFill) { ctx.strokeStyle = colorOf(lnFill); ctx.lineWidth = lw; ctx.stroke(); }
      // Text (approximate: first run's size / colour, centred lines).
      const paras = [...n.getElementsByTagNameNS(A, 'p')];
      const body = n.getElementsByTagNameNS(A, 'bodyPr')[0];
      const anchor = body && body.getAttribute('anchor');
      const lines = paras.map((p) => [...p.getElementsByTagNameNS(A, 'r')].map((r) => {
        const rp = r.getElementsByTagNameNS(A, 'rPr')[0];
        return { t: r.getElementsByTagNameNS(A, 't')[0].textContent, sz: rp && rp.getAttribute('sz') ? +rp.getAttribute('sz') / 100 : 18, b: rp && rp.getAttribute('b') === '1', c: colorOf(rp) || '#000', u: rp && rp.getAttribute('u') === 'sng' };
      })).filter((l) => l.length);
      if (!lines.length) continue;
      const algn = (paras[0].getElementsByTagNameNS(A, 'pPr')[0] || { getAttribute: () => null }).getAttribute('algn');
      const lh = lines[0][0].sz / 72 * k * 1.2;
      let ty = anchor === 'ctr' ? y + (h - lh * lines.length) / 2 : y;
      for (const l of lines) {
        const widths = l.map((r) => { ctx.font = (r.b ? '700 ' : '400 ') + (r.sz / 72 * k) + 'px Calibri, Carlito'; return ctx.measureText(r.t).width; });
        const tw = widths.reduce((a, b) => a + b, 0);
        let tx = algn === 'ctr' ? x + (w - tw) / 2 : x;
        l.forEach((r, i) => {
          ctx.font = (r.b ? '700 ' : '400 ') + (r.sz / 72 * k) + 'px Calibri, Carlito';
          ctx.fillStyle = r.c; ctx.textBaseline = 'middle';
          ctx.fillText(r.t, tx, ty + lh / 2);
          if (r.u) ctx.fillRect(tx, ty + lh / 2 + r.sz / 72 * k * 0.42, widths[i], Math.max(1, r.sz / 72 * k * 0.07));
          tx += widths[i];
        });
        ty += lh;
      }
    }
    const redraw = cv.toDataURL('image/png');
    // Reference: the PNG slide export at the same width.
    const ref = await MT.render.slideCanvas(MT.project.getMap('demo-lima-sur'), { width: W });
    const a = ctx.getImageData(0, 0, W, 1080).data, b = ref.getContext('2d').getImageData(0, 0, W, 1080).data;
    // Mean absolute difference inside the map frame (markers, dots, leaders, basemap) and in the legend panel.
    const region = (x0, y0, x1, y1) => {
      let s = 0, n = 0, big = 0;
      for (let yy = Math.round(y0); yy < Math.round(y1); yy++) for (let xx = Math.round(x0); xx < Math.round(x1); xx++) {
        const i = (yy * W + xx) * 4;
        const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
        s += d; n++; if (d > 48) big++;
      }
      return { mean: s / n, bigShare: big / n };
    };
    const th = MT.theme;
    const frame = region(th.mapFrame.x * k, th.mapFrame.y * k, (th.mapFrame.x + th.mapFrame.w) * k, (th.mapFrame.y + th.mapFrame.h) * k);
    const panel = region(th.panel.x * k, 0, W, 1080);
    // Side-by-side picture for humans.
    const both = document.createElement('canvas'); both.width = W; both.height = 1080 * 2 + 20;
    const bc = both.getContext('2d'); bc.fillStyle = '#888'; bc.fillRect(0, 0, both.width, both.height);
    bc.drawImage(ref, 0, 0); bc.drawImage(cv, 0, 1100);
    return { redraw, both: both.toDataURL('image/png'), frame, panel };
  }, pptBuf.toString('base64'));
  writeFileSync(path.join(OUT, 'm4-pptx-redraw-lima-sur.png'), Buffer.from(cmp.redraw.split(',')[1], 'base64'));
  writeFileSync(path.join(OUT, 'm4-pptx-vs-png-lima-sur.png'), Buffer.from(cmp.both.split(',')[1], 'base64'));
  console.log('    map-frame diff', JSON.stringify(cmp.frame), 'panel diff', JSON.stringify(cmp.panel));
  // The basemap is a 3× picture in the PPTX vs a native render in the PNG: resampling noise only.
  check(cmp.frame.mean < 5 && cmp.frame.bigShare < 0.01, `PPTX re-draw ≈ PNG slide inside the map frame (mean Δ ${cmp.frame.mean.toFixed(2)}/255, ${(cmp.frame.bigShare * 100).toFixed(2)} % px differ)`);
  check(cmp.panel.mean < 6, `PPTX re-draw ≈ PNG slide in the legend panel (mean Δ ${cmp.panel.mean.toFixed(2)}/255)`);

  // Optional: real rendering with the installed PowerPoint (COM).
  if (office) {
    const ps = path.join(OUT, 'm4-office.ps1');
    writeFileSync(ps, `
$ErrorActionPreference = 'Stop'
$src = '${pptPath.replace(/'/g, "''")}'
$outDir = '${OUT.replace(/'/g, "''")}'
$running = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$app = New-Object -ComObject PowerPoint.Application
try {
  $pres = $app.Presentations.Open($src, $true, $false, $false)
  $i = 0
  foreach ($s in $pres.Slides) { $i++; $s.Export((Join-Path $outDir ("m4-office-slide" + $i + ".png")), 'PNG', 1920, 1080) }
  $notes = $pres.Slides.Item(1).NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text
  Set-Content -Path (Join-Path $outDir 'm4-office-notes1.txt') -Value $notes -Encoding UTF8
  Write-Output ("slides=" + $pres.Slides.Count)
  $pres.Close()
} finally { if (-not $running) { $app.Quit() } }
`);
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { encoding: 'utf8', timeout: 180000 });
      console.log('   ', out.trim());
      check(/slides=\d+/.test(out) && existsSync(path.join(OUT, 'm4-office-slide1.png')), 'PowerPoint opened the deck and rendered every slide (m4-office-slide*.png)');
    } catch (e) {
      check(false, 'PowerPoint render failed: ' + (e.stderr || e.message).toString().slice(0, 300));
    }
  }
}

/* ---- 4. Interactive HTML ------------------------------------------------------------------------------ */
if (want('html')) {
  console.log('\n[html] standalone interactive page');
  let t0 = Date.now();
  const htmlBuf = await pageBlob(`MT.export.html(${JSON.stringify(['demo-lima-sur', cardId, dotId, numId])}, {download:false, ui:false}).then(r => (window.__htmlRes = r, r.blobs[0].blob))`);
  const htmlPath = path.join(OUT, 'm4-demo.html');
  writeFileSync(htmlPath, htmlBuf);
  const text = htmlBuf.toString('utf8');
  const hname = await page.evaluate(() => window.__htmlRes.files[0]);
  check(text.startsWith('<!doctype html>') && /unpkg\.com\/maplibre-gl@5\.24\.0/.test(text) && /integrity/.test(text), `${hname}: ${(htmlBuf.length / 1024).toFixed(0)} KB in ${Date.now() - t0} ms, MapLibre pinned + SRI`);
  check(!/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/.test(text), 'no "</script>" break-out from the inline data');
  check(!/src="(?!https:|data:)[^"]+"/.test(text) && !/href="(?!https:|data:|#)[^"]+"/.test(text), 'no local file references (data + logos inline)');

  // Open the exported file from disk in a fresh page.
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errs2 = collectErrors(p2);
  await p2.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await p2.waitForFunction(() => window.__mtPage && window.__mtPage.map && window.__mtPage.map.loaded(), { timeout: 60000 });
  const idle = (pg) => pg.evaluate(() => new Promise((r) => { const m = window.__mtPage.map; if (m.loaded() && m.areTilesLoaded() && !m.isMoving()) return r(true); m.once('idle', () => r(true)); m.triggerRepaint(); }));
  await idle(p2); await sleep(400);
  await screenshot(p2, 'm4-html-lima-sur');
  // Shape-aware overlap count of the visible markers (circles: centre distance; cards: boxes).
  await p2.evaluate(() => {
    window.__overlaps = () => {
      const rect = document.getElementById('map').getBoundingClientRect();
      const els = [...document.querySelectorAll('.ov:not(.is-dots) .mk')].filter((e) => !e.hidden && e.style.visibility !== 'hidden');
      const boxes = els.map((e) => ({ r: e.getBoundingClientRect(), round: !e.classList.contains('mk--card') }))
        .filter((b) => b.r.right > rect.left && b.r.left < rect.right && b.r.bottom > rect.top && b.r.top < rect.bottom);
      let n = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (boxes[i].round && boxes[j].round) {
          const d = Math.hypot((a.left + a.right) / 2 - (b.left + b.right) / 2, (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
          if (d < (a.width + b.width) / 2 - 1) n++;
        } else if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) n++;
      }
      return { n, visible: boxes.length };
    };
  });
  const s1 = await p2.evaluate(() => {
    const P = window.__mtPage, m = P.data.maps[0];
    const vis = [...document.querySelectorAll('.mk')].filter((e) => !e.hidden && e.style.visibility !== 'hidden');
    // A visible grouped logo ("×4" pip) also stands for the other stores of its group.
    const inGroups = vis.reduce((a, e) => { const p = e.querySelector('.pip'); return a + (p && !p.hidden ? (+(p.textContent.match(/\d+/) || [1])[0] - 1) : 0); }, 0);
    const ov = window.__overlaps();
    return {
      title: document.querySelector('.hd__title').textContent, sub: document.querySelector('.hd__sub').textContent,
      peso: getComputedStyle(document.querySelector('.hd__peso')).textDecorationLine,
      tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
      rows: [...document.querySelectorAll('.row__label')].map((e) => e.textContent),
      stores: m.stores.length, markers: vis.length, inGroups, solo: document.querySelectorAll('.dt.is-solo').length, inView: ov.visible, overlaps: ov.n, dots: document.querySelector('.ov').classList.contains('is-dots'),
      zoom: P.map.getZoom(), zoomRef: m.view.zoomRef, levels: m.levels.map((l) => l.d + (l.dense ? '*' : '')).join(' '),
      attrib: (document.querySelector('.maplibregl-ctrl-attrib') || {}).textContent || '',
      radiusLayer: !!P.map.getLayer('mt-radius-line') && P.map.querySourceFeatures('mt-radius').length > 0,
      labels: [...document.querySelectorAll('.rl')].map((e) => e.textContent),
    };
  });
  console.log('   ', JSON.stringify(s1));
  check(s1.title === 'Lima Metropolitana Sur' && /Peso: 15\.8%/.test(s1.sub) && /underline/.test(s1.peso), 'header: title + subtitle with underlined Peso');
  check(s1.tabs.length === 4, 'map tabs for the 4 exported maps');
  check(s1.markers + s1.inGroups + s1.solo === s1.stores && s1.stores > 20, `every store has a marker (${s1.markers} logos${s1.inGroups ? ' (+ ' + s1.inGroups + ' stores in grouped logos)' : ''} + ${s1.solo} dots for logos without room)`);
  check(s1.overlaps === 0, `no overlapping markers at the initial view (zoom ${s1.zoom.toFixed(2)} vs slide ${s1.zoomRef.toFixed(2)}; levels ${s1.levels})`);
  check(s1.rows.length > 3 && s1.rows.every((r) => /\(\d+\)$/.test(r)), 'legend rows with counts: ' + s1.rows.join(', '));
  check(/OpenStreetMap/.test(s1.attrib), 'attribution visible: ' + s1.attrib.trim());
  check(s1.radiusLayer && s1.labels.join() === '1 km', 'radius circle layer + "1 km" pill');
  // Toggle a chain off/on.
  const tg = await p2.evaluate(async () => {
    const btn = document.querySelector('.row__btn');
    const id = btn.dataset.chain;
    const count = () => [...document.querySelectorAll('.mk')].filter((e) => !e.hidden).length;
    const before = count();
    btn.click(); await new Promise((r) => setTimeout(r, 50));
    const after = count(), pressed = btn.getAttribute('aria-pressed');
    btn.click(); await new Promise((r) => setTimeout(r, 50));
    return { id, before, after, pressed, back: count() };
  });
  check(tg.after < tg.before && tg.pressed === 'false' && tg.back === tg.before, `legend toggle hides/shows ${tg.id} (${tg.before} → ${tg.after} → ${tg.back})`);
  // Popup on click (the radius centre store).
  const pop = await p2.evaluate(async () => {
    const P = window.__mtPage, m = P.data.maps[0];
    const i = m.stores.findIndex((s) => m.radius.length && s.id === m.radius[0].storeId);
    const it = P.overlay.items[i >= 0 ? i : 0];
    it.mk.click();
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector('.maplibregl-popup');
    return el ? { name: el.querySelector('.pop__name').textContent, radius: (el.querySelector('.pop__radius') || {}).textContent || '', link: el.querySelector('.pop__link').href, active: it.mk.classList.contains('is-active') } : null;
  });
  console.log('    popup', JSON.stringify(pop));
  check(pop && pop.name && /Radio de 1 km/.test(pop.radius) && /google\.com\/maps/.test(pop.link) && pop.active, 'popup with store details + radius results + Google Maps link');
  await sleep(350); await idle(p2);
  const popIn = await p2.evaluate(() => { const r = document.querySelector('.maplibregl-popup').getBoundingClientRect(), m = document.getElementById('map').getBoundingClientRect(); return r.top >= m.top - 1 && r.bottom <= m.bottom + 1 && r.left >= m.left - 1 && r.right <= m.right + 1; });
  check(popIn, 'popup fully visible inside the map (auto-pan)');
  await screenshot(p2, 'm4-html-popup');
  await p2.keyboard.press('Escape');
  // Zoom in: markers spread; zoom far out: brand dots + hint.
  await p2.evaluate(() => window.__mtPage.map.jumpTo({ zoom: window.__mtPage.map.getZoom() + 1.2 }));
  await idle(p2); await sleep(200);
  await sleep(400); await idle(p2);
  const zin = await p2.evaluate(() => ({ dots: document.querySelector('.ov').classList.contains('is-dots'), hint: document.querySelector('.hint').classList.contains('is-on'),
    zoom: window.__mtPage.map.getZoom(), steps: window.__mtPage.data.maps[0].levels.map((l) => l.z), ov: window.__overlaps() }));
  const onStep = zin.steps.some((z) => Math.abs(z - zin.zoom) < 0.003);
  check(!zin.dots && !zin.hint && onStep && zin.ov.n === 0, `zoomed in by 1.2: snapped to a ladder step (${zin.zoom.toFixed(3)}), logos, ${zin.ov.n} overlaps of ${zin.ov.visible}`);
  await screenshot(p2, 'm4-html-zoomin');
  await p2.evaluate(() => window.__mtPage.map.jumpTo({ zoom: window.__mtPage.map.getZoom() - 5 }));
  await idle(p2); await sleep(200);
  const zout = await p2.evaluate(() => ({ dots: document.querySelector('.ov').classList.contains('is-dots'), hint: document.querySelector('.hint').classList.contains('is-on') }));
  check(zout.dots && zout.hint, 'zoomed far out: brand dots + "Acerca el mapa" hint');
  await screenshot(p2, 'm4-html-zoomout');
  // Other maps (tabs): Trujillo copy in cards (count sort), Chimbote copy in dots (borders), numbered.
  for (const [i, shot] of [[1, 'm4-html-trujillo'], [2, 'm4-html-chimbote'], [3, 'm4-html-numbered']]) {
    await p2.evaluate((i) => document.querySelectorAll('.tab')[i].click(), i);
    await idle(p2); await sleep(400);
    await screenshot(p2, shot);
    const st = await p2.evaluate(() => ({ title: document.querySelector('.hd__title').textContent, kind: window.__mtPage.data.maps[window.__mtPage.state.idx].kind,
      mk: [...document.querySelectorAll('.mk')].filter((e) => !e.hidden && e.style.visibility !== 'hidden').reduce((a, e) => { const p = e.querySelector('.pip'); return a + (p && !p.hidden ? +(p.textContent.match(/\d+/) || [1])[0] : 1); }, 0),
      solo: document.querySelectorAll('.dt.is-solo').length, n: window.__mtPage.data.maps[window.__mtPage.state.idx].stores.length, sel: document.querySelector('.tab[aria-selected="true"]').textContent, ov: window.__overlaps(), dots: document.querySelector('.ov').classList.contains('is-dots') }));
    check(st.mk + st.solo === st.n && st.sel === st.title && (st.kind === 'dot' || st.dots || st.ov.n === 0), `tab ${st.title} (${st.kind}): ${st.mk}/${st.n} markers${st.solo ? ' + ' + st.solo + ' dots' : ''}, ${st.dots ? 'dots mode' : st.ov.n + ' overlaps'}`);
  }
  // Phone: legend as a bottom sheet.
  await p2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p2.evaluate(() => document.querySelectorAll('.tab')[0].click());
  await idle(p2); await sleep(400);
  await screenshot(p2, 'm4-html-phone');
  await p2.evaluate(() => document.querySelector('.sheet-toggle').click());
  await sleep(450);
  await screenshot(p2, 'm4-html-phone-legend');
  const sheet = await p2.evaluate(() => { const r = document.querySelector('.panel').getBoundingClientRect(); return { open: document.querySelector('.panel').classList.contains('is-open'), top: r.top, h: innerHeight, scrollX: document.documentElement.scrollWidth - innerWidth }; });
  check(sheet.open && sheet.top < sheet.h * 0.7 && sheet.scrollX <= 0, 'phone: legend opens as a bottom sheet, no horizontal scroll');
  check(errs2.length === 0, 'exported page: zero console errors' + (errs2.length ? '\n      ' + errs2.join('\n      ') : ''));
  await p2.close();
  // Offline (both CDNs unreachable): a clear message, the header and the legend still work.
  const p3 = await browser.newPage();
  await p3.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const pageErrors3 = [];
  p3.on('pageerror', (e) => pageErrors3.push(e.message));
  await p3.setRequestInterception(true);
  p3.on('request', (r) => (/unpkg\.com|jsdelivr\.net|openfreemap\.org/.test(r.url()) ? r.abort() : r.continue()));
  await p3.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await p3.waitForFunction(() => document.querySelector('.notice') && !document.querySelector('.notice').hidden, { timeout: 20000 }).catch(() => {});
  const off = await p3.evaluate(() => ({ notice: document.querySelector('.notice') && !document.querySelector('.notice').hidden ? document.querySelector('.notice').textContent : '', rows: document.querySelectorAll('.row__btn').length, title: document.querySelector('.hd__title').textContent }));
  await screenshot(p3, 'm4-html-offline');
  check(/conexión a internet/.test(off.notice) && off.rows > 3 && off.title && pageErrors3.length === 0, 'offline: "no se pudo cargar el mapa base" notice, header + legend still shown, no script errors');
  await p3.close();
}

/* ---- 5. Error paths ------------------------------------------------------------------------------------- */
if (want('errors')) {
  console.log('\n[errors]');
  const e1 = await page.evaluate(async () => { try { await MT.export.pptx(['nope'], { ui: false }); return 'resolved'; } catch (e) { return e.code; } });
  check(e1 === 'no-maps', 'unknown map id → rejects with code no-maps');
  const e2 = await page.evaluate(async () => {
    const c = new AbortController(); c.abort();
    try { await MT.export.png('demo-chimbote', { kind: 'map', scale: 2, ui: false, signal: c.signal, download: false }); return 'resolved'; } catch (e) { return e.name; }
  });
  check(e2 === 'AbortError', 'aborted signal → AbortError');
  const e3 = await page.evaluate(async () => { const r = await MT.export.run('pptx', ['nope']); await MT.util.sleep(100); return { r, toast: [...document.querySelectorAll('.mt-toast')].map((t) => t.textContent).pop() }; });
  check(e3.r === null && /No hay láminas para exportar/.test(e3.toast || ''), 'run() never rejects; error toast: ' + e3.toast);
}

check(errors.length === 0, 'app page: zero console errors' + (errors.length ? '\n      ' + errors.join('\n      ') : ''));
await browser.close();
finish();
