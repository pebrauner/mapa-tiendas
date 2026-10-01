// tools/test/demo-slides.mjs — the four demo slides of the built-in example project (js/example-project.js =
// tools/fixtures/demo.mapa.json, mirroring docs/reference/slide-*.png), exported like a user would:
//
//   1. PNG full-slide export of each map → tools/test/out/fix-slide-<id>.png (after showing each map in the
//      preview, so the basemap's district-name positions are learnt);
//   2. one PowerPoint deck with the 4 maps → tools/test/out/demo-slides.pptx;
//   3. (Windows + Microsoft PowerPoint, unless --no-office) the deck opened by PowerPoint through COM: it must
//      open without a repair prompt, every slide is exported → tools/test/out/ppt-render-<id>.png, and its text
//      (title, subtitle, legend) and fonts are read back → tools/test/out/ppt-render-report.json;
//   4. comparison sheets reference | app PNG | PowerPoint render → tools/test/out/ppt-compare-<id>.png, plus the
//      mean pixel difference PNG ↔ PowerPoint inside the map frame and the legend panel.
//
//   node tools/test/demo-slides.mjs [width=1920] [--no-office]
import { openApp, waitForMapIdle, OUT, ROOT } from './lib.mjs';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const width = +(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 1920);
const office = process.platform === 'win32' && !process.argv.includes('--no-office');
const REF = { 'demo-lima-sur': 'slide-lima-sur.png', 'demo-lima-cono-sur': 'slide-lima-cono-sur.png', 'demo-trujillo': 'slide-trujillo.png', 'demo-chimbote': 'slide-chimbote.png' };
const failures = [];
const fail = (m) => { failures.push(m); console.log('FAIL ' + m); };

const { browser, page, errors } = await openApp({ lang: 'es', viewport: { width: 1600, height: 1000 } });
// The built-in example project (what "Abrir proyecto de ejemplo" opens).
const ids = await page.evaluate(async () => { await MT.app.openExampleProject(); return MT.project.maps().map((m) => m.id); });
console.log('example project:', await page.evaluate(() => MT.project.current().name), ids.join(', '));
await page.evaluate(() => MT.app.showTab('maps'));
for (const id of ids) {
  await page.evaluate((id) => MT.project.select(id), id);
  await new Promise((r) => setTimeout(r, 800));
  await waitForMapIdle(page, { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
}
const toB64 = `async (blob) => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); }`;

/* 1. PNG slides */
for (const id of ids) {
  const r = await page.evaluate(async (id, width, toB64) => {
    const b64 = eval(toB64);
    const res = await MT.export.png(id, { kind: 'slide', width, download: false, ui: false });
    const cfg = MT.project.getMap(id), lay = MT.layout.compute(cfg), view = MT.layout.viewFor(cfg);
    const boxes = MT.layout.districtLabelBoxes(cfg, MT.layout.projector(view), view);
    const lead = lay.filter((i) => i.leader).map((i) => Math.hypot(i.leader.x2 - i.leader.x1, i.leader.y2 - i.leader.y1));
    return { b64: await b64(res.blobs[0].blob), n: lay.length, stats: lay.stats, maxLeader: Math.round(Math.max(0, ...lead)), boxes: boxes.map((b) => b.label + (b.guessed ? '?' : '')) };
  }, id, width, toB64);
  writeFileSync(path.join(OUT, `fix-slide-${id}.png`), Buffer.from(r.b64, 'base64'));
  console.log(id, JSON.stringify({ n: r.n, stats: r.stats, maxLeader: r.maxLeader, labels: r.boxes }));
}

/* 2. PowerPoint deck: the 4 maps */
const pptPath = path.join(OUT, 'demo-slides.pptx');
const deck = await page.evaluate(async (ids, toB64) => {
  const b64 = eval(toB64);
  const res = await MT.export.pptx(ids, { download: false, ui: false });
  const plans = [];
  for (const id of ids) {
    const p = await MT.export.pptx.plan(MT.project.getMap(id));
    plans.push({ id, title: MT.project.getMap(id).title, texts: p.elements.filter((e) => e.kind === 'text' || e.text).map((e) => e.text || (e.runs || []).map((r) => r.text).join('')).filter(Boolean) });
  }
  return { name: res.files[0], b64: await b64(res.blobs[0].blob), plans, fonts: [MT.theme.fonts.slide] };
}, ids, toB64);
rmSync(pptPath, { force: true });
writeFileSync(pptPath, Buffer.from(deck.b64, 'base64'));
console.log(`deck: ${deck.name} → ${pptPath} (${(readFileSync(pptPath).length / 1048576).toFixed(1)} MB)`);

/* 3. PowerPoint render (COM) */
let report = null;
if (office) {
  const ps = path.join(OUT, 'ppt-render.ps1');
  const outNames = ids.map((id) => path.join(OUT, `ppt-render-${id}.png`));
  outNames.forEach((f) => rmSync(f, { force: true }));
  const reportPath = path.join(OUT, 'ppt-render-report.json');
  rmSync(reportPath, { force: true });
  writeFileSync(ps, `
$ErrorActionPreference = 'Stop'
$src = '${pptPath.replace(/'/g, "''")}'
$outs = @(${outNames.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')})
$reportPath = '${reportPath.replace(/'/g, "''")}'
$running = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$app = New-Object -ComObject PowerPoint.Application
$pres = $null
try {
  # ReadOnly, Untitled=false, WithWindow=false: a file PowerPoint has to repair raises an error here instead of opening.
  $pres = $app.Presentations.Open($src, $true, $false, $false)
  $slides = @()
  $i = 0
  foreach ($s in $pres.Slides) {
    $s.Export($outs[$i], 'PNG', 1920, 1080)
    $shapes = @()
    foreach ($sh in $s.Shapes) {
      $o = [ordered]@{ name = $sh.Name; type = [int]$sh.Type; left = [math]::Round($sh.Left, 2); top = [math]::Round($sh.Top, 2); width = [math]::Round($sh.Width, 2); height = [math]::Round($sh.Height, 2) }
      if ($sh.HasTextFrame -and $sh.TextFrame.HasText) {
        $tr = $sh.TextFrame.TextRange
        $o.text = $tr.Text
        $o.font = $tr.Font.Name
        $o.size = $tr.Font.Size
        $o.bold = [int]$tr.Font.Bold
        $o.autoSize = [int]$sh.TextFrame.AutoSize
        $o.wordWrap = [int]$sh.TextFrame.WordWrap
        $o.boundHeight = [math]::Round($tr.BoundHeight, 2)
        $o.boundWidth = [math]::Round($tr.BoundWidth, 2)
        $o.lines = $tr.Lines().Count
      }
      $shapes += $o
    }
    $slides += [ordered]@{ index = $s.SlideIndex; shapes = $shapes }
    $i++
  }
  $fonts = @()
  foreach ($f in $pres.Fonts) { $fonts += [ordered]@{ name = $f.Name; embedded = [int]$f.Embedded } }
  $rep = [ordered]@{ slides = $slides; fonts = $fonts; width = $pres.PageSetup.SlideWidth; height = $pres.PageSetup.SlideHeight; count = $pres.Slides.Count; version = $app.Version }
  $rep | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8
  Write-Output ("slides=" + $pres.Slides.Count + " version=" + $app.Version)
} finally {
  if ($pres) { $pres.Close() }
  if (-not $running) { $app.Quit() }
}
`);
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { encoding: 'utf8', timeout: 240000 });
    console.log('PowerPoint:', out.trim());
    report = JSON.parse(readFileSync(reportPath, 'utf8').replace(/^﻿/, ''));
    if (report.count !== ids.length) fail(`PowerPoint sees ${report.count} slides, expected ${ids.length}`);
    for (const f of outNames) if (!existsSync(f)) fail('missing render ' + f);
  } catch (e) {
    fail('PowerPoint render failed (repair prompt or COM error): ' + String(e.stderr || e.message).slice(0, 400));
  }
}

/* 4. Comparison sheets + PNG ↔ PowerPoint pixel difference */
const dataUrl = (f) => (existsSync(f) ? 'data:image/png;base64,' + readFileSync(f).toString('base64') : null);
for (const id of ids) {
  const pngF = path.join(OUT, `fix-slide-${id}.png`), pptF = path.join(OUT, `ppt-render-${id}.png`), refF = path.join(ROOT, 'docs', 'reference', REF[id] || '');
  const r = await page.evaluate(async (ref, png, ppt) => {
    const load = (src) => new Promise((res) => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
    const [a, b, c] = await Promise.all([load(ref), load(png), load(ppt)]);
    const W = 1280, H = 720, gap = 12, lab = 34;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = (H + lab) * 3 + gap * 2;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    [[a, 'Referencia (docs/reference)'], [b, 'App: exportación PNG'], [c, 'PowerPoint (COM): render del .pptx']].forEach(([img, t], k) => {
      const y = k * (H + lab + gap);
      g.fillStyle = '#111'; g.font = 'bold 22px Calibri, Arial'; g.fillText(t, 8, y + 25);
      if (img) g.drawImage(img, 0, y + lab, W, H); else { g.fillStyle = '#eee'; g.fillRect(0, y + lab, W, H); }
    });
    // Mean |Δ| PNG ↔ PowerPoint at 1920×1080: map frame and legend panel (MT.theme geometry).
    let diff = null;
    if (b && c) {
      const px = (img) => { const k = document.createElement('canvas'); k.width = 1920; k.height = 1080; const x = k.getContext('2d'); x.drawImage(img, 0, 0, 1920, 1080); return x.getImageData(0, 0, 1920, 1080).data; };
      const P = px(b), Q = px(c);
      const s = 1920 / MT.theme.slide.width, f = MT.theme.mapFrame;
      const box = (x0, y0, x1, y1) => { let sum = 0, n = 0, big = 0; for (let y = Math.round(y0); y < Math.round(y1); y += 2) for (let x = Math.round(x0); x < Math.round(x1); x += 2) { const i = (y * 1920 + x) * 4; const d = (Math.abs(P[i] - Q[i]) + Math.abs(P[i + 1] - Q[i + 1]) + Math.abs(P[i + 2] - Q[i + 2])) / 3; sum += d; n++; if (d > 64) big++; } return { mean: sum / n, big: big / n }; };
      diff = { frame: box(f.x * s, f.y * s, (f.x + f.w) * s, (f.y + f.h) * s), panel: box(MT.theme.panel.x * s, 0, 1920, 1080), title: box(f.x * s, 0, (f.x + f.w) * s, f.y * s) };
    }
    return { sheet: cv.toDataURL('image/png'), diff };
  }, dataUrl(refF), dataUrl(pngF), dataUrl(pptF));
  writeFileSync(path.join(OUT, `ppt-compare-${id}.png`), Buffer.from(r.sheet.split(',')[1], 'base64'));
  if (r.diff) console.log(`${id}: PNG ↔ PowerPoint mean |Δ| frame ${r.diff.frame.mean.toFixed(2)} (${(r.diff.frame.big * 100).toFixed(2)} % px > 64), panel ${r.diff.panel.mean.toFixed(2)}, title ${r.diff.title.mean.toFixed(2)}`);
}
if (report) {
  const fonts = report.fonts.map((f) => f.name);
  console.log('fonts used in the deck:', fonts.join(', '));
  report.slides.forEach((s, i) => {
    const texts = s.shapes.filter((x) => x.text);
    const over = texts.filter((x) => x.boundHeight > x.height + 1 || (x.wordWrap && x.lines > 1 && /Tiendas|\(\d+\)$/.test(x.text)));
    console.log(`slide ${s.index} (${ids[i]}): ${s.shapes.length} shapes, ${texts.length} text boxes; ` + texts.slice(0, 3).map((x) => JSON.stringify(x.text.slice(0, 60)) + ` ${x.font} ${x.size}pt`).join(' · '));
    over.forEach((x) => fail(`slide ${s.index}: text overflows its box: "${x.text}" (${x.lines} lines, text ${x.boundWidth}×${x.boundHeight} pt in ${x.width}×${x.height} pt)`));
  });
}
console.log('errors:', errors);
if (errors.length) fail('console errors');
await browser.close();
if (failures.length) { console.log(`\n${failures.length} problem(s)`); process.exitCode = 1; } else console.log('\ndemo slides + PowerPoint render: OK');
