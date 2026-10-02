// tools/test/version-guard.test.mjs — what a user sees around a deploy, and when a part of the UI fails
// (docs/ARCHITECTURE.md §16). The site is served like GitHub Pages (max-age=600 + ETag, lib.servePages)
// and the browser keeps a real HTTP cache between loads.
//
//   A. Stamped deploys (.github/workflows/pages.yml): build A open in a tab, build B deployed → when the
//      tab comes back into view (throttled), version.json says B → a non-blocking ES/EN banner "Hay una
//      versión nueva de la herramienta — Recargar"; Recargar → B, consistent, no banner.
//   B. The 2026-10-02 report: an UNSTAMPED deploy (as the site was served until now) over files of the
//      previous version in the browser cache. A plain reload revalidates index.html only, so the new
//      index.html meets old cached scripts: the boot check sees modules of another version and shows the
//      update notice («Recargar», Ctrl+F5 hint) instead of a half-rendered app; Recargar refreshes the
//      cached files and the app boots whole. Run with the real previous version (git ab04721, v1) when
//      the history has it, and always with a synthetic one (a module's contract version bumped).
//   D. (run after A) Stamped deploys, the other way round: build A's index.html still fresh in the cache
//      (an F5 renewed it) while its files are stale; B is deployed; opening the tool again takes A's page
//      from the cache and gets B's files under A's URLs (Pages ignores ?v=). Each file's version trailer
//      gives it away: the update notice (ES) instead of a mix, «Recargar» → build B whole (also its new
//      module), the matrix working. Time compressed with a 16 s max-age.
//   C. Error isolation (file://): an API missing under the Análisis tab (MT.i18n.formatDistanceExact, as
//      with the stale i18n.js) → every other part renders, the broken ones show an inline error box with
//      «Recargar» (no blank or half-cleared area); a failing matrix / distance computation → an error
//      with «Reintentar» instead of a spinner or stale numbers; a tab whose mount throws → the tab's error
//      state, no onShow; then everything recovers.
//
//   node tools/test/version-guard.test.mjs

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, launch, collectErrors, makeChecker, openApp, servePages, sleep, splitNetworkNoise } from './lib.mjs';
import { copySite, stampSite } from '../stamp-assets.mjs';

const { check, finish } = makeChecker('version-guard');
const tmp = path.join(os.tmpdir(), `mapa-tiendas-test-${Date.now()}-vg`);
mkdirSync(tmp, { recursive: true });
const V1 = 'ab04721';
const booted = (page, timeout = 45000) => page.waitForFunction(() => window.MT && MT.app && MT.app.booted === true, { timeout });
const realErrors = (errors) => splitNetworkNoise(errors).real;

/** A copy of the app as the previous version `rev` had it (git history), or null when the history lacks it. */
function gitTree(rev, dir) {
  try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', rev + '^{commit}'], { stdio: 'ignore' }); } catch (e) { return null; }
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', rev, '--', 'index.html', 'css', 'js', 'vendor', 'data', 'logos'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    const out = path.join(dir, f);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, execFileSync('git', ['-C', ROOT, 'show', `${rev}:${f}`], { maxBuffer: 256 * 1024 * 1024 }));
  }
  return files.length;
}

try {
  /* ==== A. stamped deploys ================================================================================ */
  console.log('A. stamped deploy A → B while the app is open');
  {
    const dirA = path.join(tmp, 'stampA'), dirB = path.join(tmp, 'stampB');
    copySite(dirA); copySite(dirB);
    appendFileSync(path.join(dirB, 'js', 'analysis.js'), '\n;window.__mtDeployB = true;\n');   // deploy B changes one file
    const A = stampSite(dirA), B = stampSite(dirB);
    check(A.build !== B.build && A.files['js/analysis.js'] !== B.files['js/analysis.js'], `two builds (${A.build} → ${B.build}; js/analysis.js ${A.files['js/analysis.js']} → ${B.files['js/analysis.js']})`);
    const srv = await servePages(dirA);
    const browser = await launch();
    try {
      const [page] = await browser.pages();
      await page.setViewport({ width: 1440, height: 900 });
      const errors = collectErrors(page);
      await page.goto(srv.url('index.html?lang=en'), { waitUntil: 'load' });
      await booted(page);
      const a0 = await page.evaluate(async () => ({ build: MT.app.build, v: await MT.app.checkVersion({ force: true }), banner: !!document.querySelector('[data-mt-update]') }));
      check(a0.build === A.build && a0.v && !a0.v.outdated && !a0.banner, `build A open: MT_BUILD ${a0.build}, version.json agrees, no banner`);
      srv.setRoot(dirB);                                                  // ── deploy B ──
      await page.evaluate(() => { MT.app.versionCheckInterval = 5 * 60 * 1000; window.dispatchEvent(new Event('focus')); });
      await sleep(600);
      check(await page.evaluate(() => !document.querySelector('[data-mt-update]') && MT.app.updateAvailable() === null), 'coming back into view right after a check: throttled (at most one check per 5 minutes)');
      const fetched = srv.log.length;
      await page.evaluate(() => { MT.app.versionCheckInterval = 0; document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForSelector('[data-mt-update="newer"]', { timeout: 10000 });
      const ban = await page.evaluate(() => {
        const b = document.querySelector('[data-mt-update="newer"]');
        return { text: b.innerText.replace(/\s+/g, ' ').trim(), btn: (b.querySelector('.mt-update__reload') || {}).textContent, modal: document.body.classList.contains('mt-has-modal'),
          latest: MT.app.updateAvailable(), inBanners: !!b.closest('.mt-banners') };
      });
      check(srv.log.slice(fetched).some(([s, p]) => s === 200 && p === '/version.json'), 'the check read version.json from the server (not from the cache)');
      check(/A new version of the tool is available\./.test(ban.text) && ban.btn === 'Reload' && ban.latest === B.build, `banner: "${ban.text}" (build ${ban.latest})`);
      check(ban.inBanners && !ban.modal && await page.evaluate(() => { MT.app.showTab('analysis'); return MT.app.currentTab() === 'analysis'; }), 'non-blocking: a banner under the top bar, the app keeps working');
      await page.evaluate(() => MT.i18n.setLang('es'));
      const es = await page.evaluate(() => { const b = document.querySelector('[data-mt-update="newer"]'); return { text: b.innerText.replace(/\s+/g, ' '), btn: b.querySelector('.mt-update__reload').textContent }; });
      check(/Hay una versión nueva de la herramienta\./.test(es.text) && es.btn === 'Recargar', `ES: "${es.text.trim()}"`);
      errors.length = 0;
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.mt-update__reload')]);
      await booted(page);
      const b1 = await page.evaluate(async () => ({ build: MT.app.build, deployB: window.__mtDeployB === true, banner: !!document.querySelector('[data-mt-update]'),
        v: await MT.app.checkVersion({ force: true }), src: (document.querySelector('script[src^="js/analysis.js"]') || {}).getAttribute('src') }));
      check(b1.build === B.build && b1.deployB && !b1.banner && b1.v && !b1.v.outdated && b1.src === `js/analysis.js?v=${B.files['js/analysis.js']}`,
        `«Recargar» → build B, its new file under its new URL (${b1.src}), no banner`);
      check(realErrors(errors).length === 0, `no console errors${realErrors(errors).length ? ': ' + realErrors(errors).slice(0, 3).join(' | ') : ''}`);
    } finally { await browser.close(); await srv.close(); }
  }

  /* ==== D. stamped: a cached OLD index.html gets the files of a NEW deploy ================================== */
  // Pages ignores ?v=, so URLs alone protect one way only. F5 revalidates index.html (a 304 renews its cache
  // time) but not the files, which keep theirs. After a deploy, opening the tool again (new tab, bookmark)
  // takes build A's index.html from the cache while A's file URLs, now stale, revalidate to build B's
  // content. Every stamped file declares its own hash (version trailer), so A's boot check sees B's files
  // and shows the update notice instead of running a mix. Time compressed: max-age 16 s instead of 600.
  console.log('\nD. stamped deploy: the cached index.html of build A gets the files of build B (F5 → deploy → open again)');
  {
    const AGE = 16;
    const dirA = path.join(tmp, 'navA'), dirB = path.join(tmp, 'navB');
    copySite(dirA); copySite(dirB);
    // B changes a file and adds a module the Análisis tab needs when it mounts (as phase 2a added ui-analysis.js).
    appendFileSync(path.join(dirB, 'js', 'analysis.js'), '\n;window.__mtDeployB = true;\n');
    writeFileSync(path.join(dirB, 'js', 'extra.js'), "(window.MT.modules = window.MT.modules || {})['extra'] = { api: '1' };\nwindow.MT.extra = { ok: true };\n");
    const ixB = path.join(dirB, 'index.html'), uaB = path.join(dirB, 'js', 'ui-analysis.js');
    writeFileSync(ixB, readFileSync(ixB, 'utf8').replace('<script src="js/ui-analysis.js" data-api="1"></script>', '<script src="js/extra.js" data-api="1"></script>\n<script src="js/ui-analysis.js" data-api="1"></script>'));
    writeFileSync(uaB, readFileSync(uaB, 'utf8').replace(/(\n  function mount\(panel\) \{\r?\n)/, "$1    if (!MT.extra.ok) throw new Error('no MT.extra');\n"));
    const A = stampSite(dirA), B = stampSite(dirB);
    check(B.files['js/extra.js'] && /js\/extra\.js\?v=/.test(readFileSync(ixB, 'utf8')) && /MT\.extra\.ok/.test(readFileSync(uaB, 'utf8')) && A.files['js/analysis.js'] !== B.files['js/analysis.js'],
      `build B (${B.build}) changes js/analysis.js and adds js/extra.js, which its Análisis tab needs (build A ${A.build})`);
    const srv = await servePages(dirA, { maxAge: AGE });
    const browser = await launch();
    try {
      const [page] = await browser.pages();
      await page.setViewport({ width: 1590, height: 1190 });
      const url = srv.url('index.html?lang=es#analisis');
      await page.goto(url, { waitUntil: 'load' });
      await booted(page);
      const got = srv.log.filter(([s, p]) => s === 200 && p !== '/version.json').map((x) => x[2]);
      const tFirst = Math.min(...got), tLast = Math.max(...got);
      await sleep(Math.max(0, tFirst + (AGE * 1000) / 2 - Date.now()));   // half the cache time: every file still fresh
      const nF5 = srv.log.length;
      await page.reload({ waitUntil: 'load' });                           // F5
      await booted(page);
      const f5 = srv.log.slice(nF5);
      const tIndex = (f5.find(([, p]) => p === '/index.html') || [])[2] || 0;
      check(f5.some(([s, p]) => s === 304 && p === '/index.html') && f5.every(([, p]) => p === '/index.html' || p === '/version.json'),
        `F5 revalidates index.html only (${f5.map(([s, p]) => s + ' ' + p).join(', ')}): its cache time is renewed, the files keep theirs`);
      await sleep(Math.max(0, tLast + AGE * 1000 + 700 - Date.now()));     // now the files are stale, index.html is not
      srv.setRoot(dirB);                                                   // ── deploy B ──
      const n0 = srv.log.length, tNav = Date.now();
      const page2 = await browser.newPage();                               // the tool opened again (new tab, bookmark, link)
      await page2.setViewport({ width: 1590, height: 1190 });
      const errors = collectErrors(page2);
      await page2.goto(url, { waitUntil: 'load' });
      await page2.waitForSelector('[data-mt-update="stale"]', { timeout: 20000 }).catch(() => null);
      const nav = srv.log.slice(n0);
      check(tNav < tIndex + AGE * 1000 && !nav.some(([, p]) => p === '/index.html') && nav.some(([s, , , u]) => s === 200 && u === `/js/analysis.js?v=${A.files['js/analysis.js']}`),
        `the scenario is real: build A's index.html from the cache, js/analysis.js?v=<A> answered with build B's file (${nav.filter(([s]) => s === 200).length} files fetched again)`);
      const s = await page2.evaluate(() => {
        const n = document.querySelector('[data-mt-update="stale"]');
        return { notice: !!n, title: n && n.querySelector('h1').textContent, btn: n && n.querySelector('button').textContent, text: n ? n.innerText.replace(/\s+/g, ' ').trim() : '',
          build: window.MT_BUILD, booted: !!(window.MT && MT.app && MT.app.booted), tabs: !!document.querySelector('.mt-tabs'), analysis: !!document.querySelector('.mt-analysis'),
          errbox: !!document.querySelector('.mt-errbox'), focus: document.activeElement && document.activeElement.tagName };
      });
      check(s.build === A.build && s.notice && s.title === 'Hay una versión nueva de la herramienta' && s.btn === 'Recargar' && /Ctrl\+F5/.test(s.text),
        `build A's page with build B's files: the update notice in Spanish ("${s.title}" · «${s.btn}» · Ctrl+F5 hint)`);
      check(!s.booted && !s.tabs && !s.analysis && !s.errbox && s.focus === 'BUTTON' && /Archivos de otra versión: .*js\/analysis\.js/.test(s.text),
        `no mix of two builds runs: not booted, no tabs, no half-built Análisis tab; it names the files (${(/Archivos de otra versión: (.{0,90})/.exec(s.text) || [])[1]}…)`);
      errors.length = 0;
      await Promise.all([page2.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page2.click('[data-mt-update="stale"] button')]);
      await booted(page2);
      const r = await page2.evaluate(async () => {
        const res = { build: MT.app.build, deployB: window.__mtDeployB === true, extra: !!(MT.extra && MT.extra.ok), notice: !!document.querySelector('[data-mt-update]') };
        MT.app.showTab('analysis');
        await MT.analysisui.setMatrix({ districts: ['150140'], includeToVerify: false });
        res.head = (document.querySelector('.mt-analysis-mainhead__h') || {}).textContent;
        res.cards = document.querySelectorAll('.mt-analysis-stat').length;
        res.errboxes = document.querySelectorAll('.mt-errbox').length;
        return res;
      });
      check(r.build === B.build && r.deployB && r.extra && !r.notice, `«Recargar» → build B whole (${r.build}, with its new js/extra.js), no notice`);
      check(r.head === 'Matriz de cercanía · Santiago de Surco' && r.cards === 4 && r.errboxes === 0, `the proximity matrix works: "${r.head}", ${r.cards} cards, no error box`);
      check(realErrors(errors).length === 0, `no console errors after the reload${realErrors(errors).length ? ': ' + realErrors(errors).slice(0, 3).join(' | ') : ''}`);
    } finally { await browser.close(); await srv.close(); }
  }

  /* ==== B. unstamped deploy over a stale browser cache ===================================================== */
  const current = path.join(tmp, 'current');
  copySite(current);                                                      // what an unstamped deploy serves
  // The new data's store count as the app shows it (MT.data.stores(): every store but the closed ones).
  const nStores = (() => { const ctx = {}; new Function('window', readFileSync(path.join(current, 'data', 'stores.js'), 'utf8'))(ctx); return ctx.MT_SEED.stores.filter((s) => s.status !== 'closed').length; })();
  const scenarios = [];
  const v1 = path.join(tmp, 'v1');
  const n1 = gitTree(V1, v1);
  if (n1) scenarios.push({ name: `the previous version (git ${V1}, v1: ${n1} files)`, dir: v1, staleMust: ['js/i18n.js'] });
  else console.log(`  info git ${V1} is not in this checkout's history: the v1 scenario is skipped`);
  const synth = path.join(tmp, 'synthetic');
  copySite(synth);
  {                                                                       // the same app, i18n.js one contract version older
    const f = path.join(synth, 'js', 'i18n.js');
    writeFileSync(f, readFileSync(f, 'utf8').replace("['i18n'] = { api: '1' }", "['i18n'] = { api: '0' }"));
    const ix = path.join(synth, 'index.html');
    writeFileSync(ix, readFileSync(ix, 'utf8').replace('<script src="js/i18n.js" data-api="1">', '<script src="js/i18n.js" data-api="0">'));
  }
  scenarios.push({ name: 'a synthetic previous version (js/i18n.js contract 0)', dir: synth, staleMust: ['js/i18n.js'], exact: true });

  for (const sc of scenarios) {
    console.log(`\nB. unstamped deploy over cached files of ${sc.name}`);
    const srv = await servePages(sc.dir);
    const browser = await launch();
    try {
      const [page] = await browser.pages();
      await page.setViewport({ width: 1590, height: 1190 });
      const errors = collectErrors(page);
      const fromCache = new Map();
      page.on('response', (r) => { const u = new URL(r.url()); if (u.origin === srv.origin) fromCache.set(u.pathname, r.fromCache()); });
      await page.goto(srv.url('index.html?lang=en'), { waitUntil: 'load' });
      await booted(page);
      const old = await page.evaluate(() => MT.data.stores().length);
      check(true, `old version open (${old} stores)`);
      await sleep(500);
      srv.setRoot(current);                                               // ── deploy (unstamped) ──
      fromCache.clear();
      await page.reload({ waitUntil: 'load' });                           // F5: index.html revalidated, the rest from cache
      await page.waitForSelector('[data-mt-update="stale"]', { timeout: 20000 }).catch(() => null);
      const s = await page.evaluate(() => {
        const n = document.querySelector('[data-mt-update="stale"]');
        return { notice: !!n, title: n && n.querySelector('h1').textContent, btn: n && n.querySelector('button').textContent, text: n && n.innerText.replace(/\s+/g, ' '),
          booted: !!(window.MT && MT.app && MT.app.booted), tabs: !!document.querySelector('.mt-tabs'), analysis: !!document.querySelector('.mt-analysis'),
          app: document.getElementById('mt-app').childElementCount, focus: document.activeElement && document.activeElement.tagName };
      });
      check(fromCache.get('/index.html') === false && fromCache.get('/js/i18n.js') === true, 'the scenario is real: index.html came from the server, js/i18n.js from the browser cache');
      check(s.notice && s.title === 'A new version of the tool is available' && s.btn === 'Reload' && /Ctrl\+F5/.test(s.text), `the update notice instead of the app: "${s.title}" · «${s.btn}» · Ctrl+F5 hint`);
      check(sc.staleMust.every((f) => s.text.includes(f)) && (!sc.exact || /Files of another version: js\/i18n\.js$/.test(s.text.trim())), `it names the files of another version (${(/Files of another version: (.*)$/.exec(s.text.trim()) || [])[1]})`);
      check(!s.booted && !s.tabs && !s.analysis && s.app === 0 && s.focus === 'BUTTON', 'no half-rendered app: not booted, no tabs, no Análisis tab; «Reload» has the focus');
      errors.length = 0;
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('[data-mt-update="stale"] button')]);
      await booted(page);
      const r = await page.evaluate(async () => {
        const res = { stores: MT.data.stores().length, exact: typeof MT.i18n.formatDistanceExact, modules: Object.keys(MT.modules).length, notice: !!document.querySelector('[data-mt-update]') };
        MT.app.showTab('analysis');
        await MT.analysisui.setMatrix({ districts: ['150140'], includeToVerify: false });
        res.cards = document.querySelectorAll('.mt-analysis-stat').length;
        res.head = (document.querySelector('.mt-analysis-mainhead__h') || {}).textContent;
        res.side = [...document.querySelectorAll('.mt-analysis-side .mt-analysis-sec__title')].map((x) => x.textContent);
        res.errboxes = document.querySelectorAll('.mt-errbox').length;
        return res;
      });
      check(r.stores === nStores && r.exact === 'function' && r.modules === 32 && !r.notice, `«Reload» refreshed the cached files: the new version boots whole (${r.stores} stores, 32 modules of one version)`);
      check(r.head === 'Proximity matrix · Santiago de Surco' && r.cards === 4 && r.side.length === 3 && r.errboxes === 0, `the proximity matrix works: "${r.head}", ${r.cards} cards, side ${r.side.join(' / ')}`);
      check(realErrors(errors).length === 0, `no console errors after the reload${realErrors(errors).length ? ': ' + realErrors(errors).slice(0, 3).join(' | ') : ''}`);
    } finally { await browser.close(); await srv.close(); }
  }

  /* ==== C. error isolation =============================================================================== */
  console.log('\nC. error isolation in the Análisis tab (file://)');
  const EXPECTED = /\[app\] (analysis: .* failed|tab "analysis" failed)|\[analysis\] (matrix|distances) failed/;
  const { browser, page, errors } = await openApp({ lang: 'en', hash: 'mapas', viewport: { width: 1590, height: 1190 } });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const pageErrors = () => errors.filter((e) => e.startsWith('pageerror'));
  try {
    // C1 — the API the stale i18n.js lacked
    await ev(() => { window.__fde = MT.i18n.formatDistanceExact; delete MT.i18n.formatDistanceExact; MT.app.showTab('analysis'); });
    await sleep(400);
    await ev(() => [...document.querySelectorAll('.mt-analysis-modes label')].find((b) => /matrix/i.test(b.textContent)).click());
    await sleep(300);
    await ev(() => MT.analysisui.setMatrix({ districts: ['150140'], includeToVerify: false }));
    await sleep(800);
    const c1 = await ev(() => {
      const box = (sel) => { const el = document.querySelector(sel); return !!(el && el.querySelector('.mt-errbox')); };
      return {
        mode: document.querySelector('.mt-analysis').dataset.mode, head: (document.querySelector('.mt-analysis-head__h') || {}).textContent,
        seg: !!document.querySelector('.mt-analysis-modes'),
        sections: [...document.querySelectorAll('.mt-analysis-side > section')].map((s) => s.classList.contains('mt-analysis-sec--error') ? 'ERROR' : s.querySelector('.mt-analysis-sec__title').textContent),
        region: [...document.querySelectorAll('.mt-analysis-side .mt-chip, .mt-analysis-side [class*="chip"]')].some((c) => /Santiago de Surco/.test(c.textContent)),
        mainHead: box('.mt-analysis-mainhead'), summary: box('.mt-analysis-summary'), results: box('.mt-analysis-respane[data-mode="matrix"]'),
        map: !!document.querySelector('.mt-analysis-map canvas'), mapErr: box('.mt-analysis-maperror'),
        boxes: [...document.querySelectorAll('#panel-analysis .mt-errbox')].map((b) => ({ where: b.dataset.where, reload: !!b.querySelector('.mt-errbox__reload'), title: b.querySelector('.mt-errbox__head').textContent })),
        rows: MT.analysisui.state().matrix.rows,
      };
    });
    check(c1.mode === 'matrix' && c1.head === 'Distance analysis' && c1.seg, 'the header and the mode switch render; the layout switched to the matrix');
    check(c1.sections.length === 3 && c1.sections[0] === 'Region' && c1.sections[1] === 'Stores to include' && c1.sections[2] === 'ERROR' && c1.region,
      `side panel: ${c1.sections.join(' / ')} — the failing section is an error box, the others (with Santiago de Surco) render`);
    check(c1.mainHead && c1.summary && c1.results && c1.map, 'results header, cards and results pane each show their own error box; the map is there');
    check(c1.boxes.length >= 4 && c1.boxes.every((b) => b.reload && b.where && /could not be displayed/.test(b.title)), `${c1.boxes.length} inline error boxes, each with «Reload» (${[...new Set(c1.boxes.map((b) => b.where))].join(', ')})`);
    check(c1.rows > 0 && pageErrors().length === 0, `the computation itself still ran (${c1.rows} stores); no uncaught error`);
    await ev(() => { MT.i18n.formatDistanceExact = window.__fde; MT.i18n.setLang('es'); });
    await sleep(800);
    const c1b = await ev(() => ({ boxes: document.querySelectorAll('#panel-analysis .mt-errbox').length, cards: document.querySelectorAll('.mt-analysis-stat').length,
      sections: document.querySelectorAll('.mt-analysis-side > section:not(.mt-analysis-sec--error)').length, rows: document.querySelectorAll('.mt-analysis-table--b tbody tr[data-id]').length,
      head: (document.querySelector('.mt-analysis-mainhead__h') || {}).textContent }));
    check(c1b.boxes === 0 && c1b.cards === 4 && c1b.sections === 3 && c1b.rows > 0 && c1b.head === 'Matriz de cercanía · Santiago de Surco', `fixed → every part renders again (${c1b.cards} cards, ${c1b.rows} rows, no error box)`);

    // C2 — the matrix computation fails
    await ev(async () => { window.__nm = MT.analysis.neighborMatrix; MT.analysis.neighborMatrix = () => { throw new Error('injected matrix failure'); }; await MT.analysisui.setMatrix({ radius: 500 }); });
    await sleep(300);
    const c2 = await ev(() => {
      const pane = document.querySelector('.mt-analysis-respane[data-mode="matrix"]'), b = pane.querySelector('.mt-errbox');
      return { box: !!b, title: b && b.querySelector('.mt-errbox__head').textContent, retry: !!(b && b.querySelector('.mt-errbox__retry')), reload: !!(b && b.querySelector('.mt-errbox__reload')),
        spinner: !!pane.querySelector('.mt-analysis-loading'), summary: document.querySelector('.mt-analysis-summary').hidden,
        excel: document.querySelector('.mt-analysis-act-excel').disabled, st: MT.analysisui.state().matrix };
    });
    check(c2.box && c2.title === 'No se pudo calcular la matriz.' && c2.retry && c2.reload, `matrix failure: "${c2.title}" with «Reintentar» and «Recargar»`);
    check(!c2.spinner && c2.summary && c2.excel && !c2.st.computing && c2.st.rows === 0 && /injected/.test(c2.st.error || ''), 'no endless spinner, no stale cards or rows, Excel disabled');
    await ev(() => { MT.analysis.neighborMatrix = window.__nm; document.querySelector('.mt-analysis-respane[data-mode="matrix"] .mt-errbox__retry').click(); });
    await ev(() => MT.analysisui.whenIdle());
    await sleep(300);
    const c2b = await ev(() => ({ rows: MT.analysisui.state().matrix.rows, error: MT.analysisui.state().matrix.error, boxes: document.querySelectorAll('#panel-analysis .mt-errbox').length, cards: document.querySelectorAll('.mt-analysis-stat').length }));
    check(c2b.rows > 0 && !c2b.error && c2b.boxes === 0 && c2b.cards === 4, `«Reintentar» → computed (${c2b.rows} stores)`);

    // C3 — the distance computation fails (mode A)
    await ev(() => { window.__df = MT.analysis.distancesFrom; MT.analysis.distancesFrom = () => { throw new Error('injected distances failure'); };
      MT.analysisui.setReference(MT.data.stores().find((s) => s.name === 'Plaza Vea Miraflores' || s.chain === 'plazavea').id); });
    await sleep(400);
    const c3 = await ev(() => { const b = document.querySelector('.mt-analysis-respane[data-mode="distance"] .mt-errbox');
      return { title: b && b.querySelector('.mt-errbox__head').textContent, retry: !!(b && b.querySelector('.mt-errbox__retry')), summary: document.querySelector('.mt-analysis-summary').hidden, side: document.querySelectorAll('.mt-analysis-side > section').length }; });
    check(c3.title === 'No se pudieron calcular las distancias.' && c3.retry && c3.summary && c3.side === 4, `distances failure: "${c3.title}" with «Reintentar»; the side panel stays`);
    await ev(() => { MT.analysis.distancesFrom = window.__df; document.querySelector('.mt-analysis-respane[data-mode="distance"] .mt-errbox__retry').click(); });
    await sleep(400);
    check(await ev(() => MT.analysisui.state().rows > 0 && !document.querySelector('#panel-analysis .mt-errbox')), '«Reintentar» → the distances are back');

    // C4 — a tab whose mount throws
    await page.goto(page.url().replace(/#.*$/, '') + '#mapas', { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' });
    await booted(page);
    await ev(() => { MT.analysis.defaultChains = undefined; MT.app.showTab('analysis'); });
    await sleep(500);
    const c4 = await ev(() => {
      const panel = document.getElementById('panel-analysis'), b = panel.querySelector('.mt-errbox--tab');
      const tab = MT.app.tabs().find((t) => t.id === 'analysis');
      return { box: !!b, title: b && b.querySelector('.mt-errbox__head').textContent, reload: !!(b && b.querySelector('.mt-errbox__reload')), details: !!(b && b.querySelector('details')),
        only: panel.childElementCount, failed: !!tab.failed, map: !!panel.querySelector('canvas'), half: !!panel.querySelector('.mt-analysis') };
    });
    check(c4.box && c4.reload && c4.details && c4.only === 1 && !c4.half, `a mount that throws: the tab shows only its error state ("${c4.title}", «Recargar», details) — nothing half-built`);
    check(c4.failed && !c4.map, 'its onShow is not called (no map created on a broken tab)');
    check(await ev(() => { MT.app.showTab('db'); return !!document.querySelector('#panel-db').childElementCount && !document.querySelector('#panel-db .mt-errbox'); }), 'the other tabs keep working');
    const unexpected = realErrors(errors).filter((e) => !EXPECTED.test(e));
    check(unexpected.length === 0, `only the expected, logged errors (${realErrors(errors).length} logged; unexpected: ${unexpected.slice(0, 3).join(' | ') || 'none'})`);
  } finally { await browser.close(); }
} catch (err) {
  console.log(err);
  check(false, 'test run threw: ' + (err && err.message));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
finish();
