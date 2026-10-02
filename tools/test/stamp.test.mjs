// tools/test/stamp.test.mjs — cache-busting of the GitHub Pages deploy (tools/stamp-assets.mjs,
// .github/workflows/pages.yml, docs/ARCHITECTURE.md §16). Node only (no browser):
//
//   1. the module contracts: every app script in index.html carries data-api, and every js file declares
//      the same version — (MT.modules = …)['<name>'] = {api}; the repo's own index.html is never stamped;
//   2. --copy-to copies exactly what the site serves (no tools/, tests, docs sources, *.md);
//   3. stamping a copy: every local <script src> / <link href> of every page gets ?v=<first 8 hex of
//      the file's sha256>, index.html gets MT_BUILD + MT_ASSET_V (lazily loaded scripts), version.json
//      {build, generated, commit, files} is valid and agrees with the files; every stamped .js / .css
//      file gets one last line declaring that hash (version trailer: window.MT_V[path] / --mt-v-<path>),
//      the rest of it byte-identical to the repo's file;
//   4. hashes change only when content changes: two stamps of the same files are byte-identical (same
//      build, one trailer per file); editing one file changes only its hash, its URL and the build;
//   5. --check passes on a good stamp and names the problem otherwise (unstamped, edited after the stamp,
//      a trailer missing or of another hash, version.json off); the repo itself is refused; a missing
//      optional file is a warning, a missing required one an error;
//   6. the workflow has the steps and permissions of a Pages deploy from Actions.
//
//   node tools/test/stamp.test.mjs

import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT, makeChecker } from './lib.mjs';
import { SITE_ENTRIES, copySite, stampSite, checkSite, hashFile, trailerFor, cssVersionVar } from '../stamp-assets.mjs';

const { check, finish } = makeChecker('stamp');
const SCRIPT = path.join(ROOT, 'tools', 'stamp-assets.mjs');
const tmp = path.join(os.tmpdir(), `mapa-tiendas-test-${Date.now()}-stamp`);
mkdirSync(tmp, { recursive: true });
const cli = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const read = (f) => readFileSync(f, 'utf8');
const sha8 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 8);
/** Hash of a site file as the repo has it (in a stamped copy a .js / .css file also carries its version trailer). */
const src8 = (rel) => sha8(path.join(ROOT, rel));
/** Local asset URLs of an HTML page (script src / link href; inline scripts and comments skipped). */
function localUrls(html) {
  const masked = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  return [...masked.matchAll(/<(script|link)\b[^>]*?\s(src|href)="([^"]+)"/gi)].map((m) => m[3]).filter((u) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u));
}

try {
  /* ---- 1. module contracts --------------------------------------------------------------------------- */
  console.log('1. module contracts (index.html data-api = each file\'s declaration)');
  const index = read(path.join(ROOT, 'index.html'));
  const tags = [...index.matchAll(/<script src="(js\/[^"?]+)"([^>]*)><\/script>/g)].map((m) => ({ src: m[1], api: (/data-api="([^"]+)"/.exec(m[2]) || [])[1] }));
  const appFiles = readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js') && f !== 'example-project.js').map((f) => 'js/' + f)
    .concat(readdirSync(path.join(ROOT, 'js', 'i18n')).filter((f) => f.endsWith('.js')).map((f) => 'js/i18n/' + f));
  const declared = Object.fromEntries(appFiles.map((f) => {
    const m = /\(\s*(?:window\.)?MT\.modules\s*=\s*(?:window\.)?MT\.modules\s*\|\|\s*\{\}\s*\)\[\s*'([^']+)'\s*\]\s*=\s*\{\s*api:\s*'([^']+)'/.exec(read(path.join(ROOT, f)));
    return [f, m ? { name: m[1], api: m[2] } : null];
  }));
  const undeclared = appFiles.filter((f) => !declared[f]);
  check(undeclared.length === 0, `every app script declares its contract version (${appFiles.length} files${undeclared.length ? '; missing: ' + undeclared.join(', ') : ''})`);
  const badName = appFiles.filter((f) => declared[f] && declared[f].name !== f.replace(/^js\//, '').replace(/\.js$/, ''));
  check(badName.length === 0, `module names = their path under js/ ('i18n', 'i18n/core', 'ui-analysis'…)${badName.length ? ': ' + badName.join(', ') : ''}`);
  const notLoaded = appFiles.filter((f) => !tags.some((t) => t.src === f));
  const noApi = tags.filter((t) => t.src !== 'js/example-project.js' && !t.api).map((t) => t.src);
  const mismatch = tags.filter((t) => t.api && declared[t.src] && declared[t.src].api !== t.api).map((t) => `${t.src} (${t.api} ≠ ${declared[t.src].api})`);
  check(notLoaded.length === 0 && noApi.length === 0 && mismatch.length === 0,
    `index.html loads every app script with data-api = its declaration (${tags.length - 1} tags${[...notLoaded, ...noApi, ...mismatch].length ? '; ' + [...notLoaded.map((f) => 'not loaded ' + f), ...noApi.map((f) => 'no data-api ' + f), ...mismatch].join(', ') : ''})`);
  check(!/\?v=[0-9a-f]{8}/.test(index) && !/id="mt-build"/.test(index) && !existsSync(path.join(ROOT, 'version.json')), 'the repo\'s index.html is not stamped (file:// and "Guardar en carpeta" use it as it is)');
  check(/window\.MT_RELOAD = function/.test(index) && /script\[data-api\]/.test(index) && /data-mt-update="stale"/.test(index), 'index.html has the cache-refreshing reload and the boot consistency check');
  check(/window\.MT_V \|\| \{\}/.test(index) && index.includes("'--mt-v-' + m[1].replace(/[^A-Za-z0-9_-]/g, '-')") && cssVersionVar('vendor/fonts/fonts.css') === '--mt-v-vendor-fonts-fonts-css',
    'the boot check compares each ?v= with the hash its file declares (window.MT_V; --mt-v-<path> named as the stamp names it)');

  /* ---- 2. copy ----------------------------------------------------------------------------------------- */
  console.log('\n2. --copy-to: what the site serves');
  const siteA = path.join(tmp, 'a');
  const c = cli('--copy-to', siteA);
  const top = readdirSync(siteA).sort();
  check(c.code === 0 && ['.nojekyll', 'LICENSE', 'css', 'data', 'docs', 'index.html', 'js', 'logos', 'vendor'].every((x) => top.includes(x)) && top.length === 9,
    `copied: ${top.join(', ')}`);
  check(!existsSync(path.join(siteA, 'tools')) && !existsSync(path.join(siteA, 'README.md')) && !existsSync(path.join(siteA, 'SPEC.md')) && readdirSync(path.join(siteA, 'docs')).join() === 'styleguide.html',
    'no tools/, tests, README/SPEC or docs sources (docs/ has only styleguide.html)');
  check(SITE_ENTRIES.includes('docs/styleguide.html') && read(path.join(siteA, 'js', 'app.js')) === read(path.join(ROOT, 'js', 'app.js')), 'files are copied byte for byte');

  /* ---- 3. stamp ---------------------------------------------------------------------------------------- */
  console.log('\n3. stamping a copy');
  const siteB = path.join(tmp, 'b');
  cpSync(siteA, siteB, { recursive: true });
  const st = cli(siteA, '--commit=0123abc');
  check(st.code === 0, `node tools/stamp-assets.mjs <copy> → ${st.out.trim().split('\n').pop()}`);
  const html = read(path.join(siteA, 'index.html'));
  const urls = localUrls(html);
  const bad = urls.filter((u) => { const m = /^([^?]+)\?v=([0-9a-f]{8})$/.exec(u); return !m || src8(m[1]) !== m[2]; });
  check(urls.length >= 48 && bad.length === 0, `index.html: every local script / stylesheet URL has ?v=<sha256 of the file, 8 hex> (${urls.length} URLs${bad.length ? '; wrong: ' + bad.slice(0, 4).join(', ') : ''})`);
  const sg = read(path.join(siteA, 'docs', 'styleguide.html')), sgUrls = localUrls(sg);
  check(sgUrls.length >= 5 && sgUrls.every((u) => { const m = /^\.\.\/([^?]+)\?v=([0-9a-f]{8})$/.exec(u); return m && src8(m[1]) === m[2]; }), `docs/styleguide.html (served too) is stamped (${sgUrls.length} URLs, relative ../ paths)`);
  check(/<script src="js\/i18n\.js\?v=[0-9a-f]{8}" data-api="1"><\/script>/.test(html) && /<script src="data\/stores\.js\?v=[0-9a-f]{8}" onerror="MT_MISSING\.push\('data\/stores\.js'\)"><\/script>/.test(html)
    && /<script src="data\/road-names\.js\?v=[0-9a-f]{8}" data-optional><\/script>/.test(html), 'other attributes kept (data-api, onerror labels, data-optional)');
  check(/<link rel="icon" href="data:image\/svg\+xml,[^"?]*">/.test(html), 'data: URLs untouched');
  const version = JSON.parse(read(path.join(siteA, 'version.json')));
  const mb = /<script id="mt-build">window\.MT_BUILD = "([0-9a-f]{10})"; window\.MT_ASSET_V = (\{[^<]*\});<\/script>/.exec(html);
  check(!!mb && html.indexOf('id="mt-build"') < html.indexOf('<script src='), `index.html sets window.MT_BUILD (${mb && mb[1]}) before any app script`);
  const lazy = mb ? JSON.parse(mb[2]) : {};
  check(Object.keys(lazy).sort().join() === 'vendor/pptxgenjs/pptxgen.bundle.js,vendor/xlsx/xlsx.full.min.js' && Object.entries(lazy).every(([p, h]) => src8(p) === h),
    `MT_ASSET_V stamps the lazily loaded scripts (${Object.keys(lazy).join(', ')})`);
  check(version.build === (mb && mb[1]) && version.commit === '0123abc' && !isNaN(Date.parse(version.generated)) && /T.*Z$/.test(version.generated), `version.json: build ${version.build}, commit, generated ${version.generated}`);
  const vf = Object.entries(version.files);
  check(vf.length >= 50 && vf.every(([p, h]) => existsSync(path.join(siteA, p)) && hashFile(path.join(siteA, p)) === h) && urls.every((u) => version.files[u.split('?')[0]]),
    `version.json "files": ${vf.length} paths → hashes, all real, every URL of the page listed`);
  // Version trailers: each .js / .css file ends by declaring its hash; the rest of it is the repo's file.
  const assets = Object.keys(version.files).filter((f) => /\.(js|css)$/.test(f));
  const badTrailer = assets.filter((f) => {
    const have = readFileSync(path.join(siteA, f)), orig = readFileSync(path.join(ROOT, f)), t = Buffer.from(trailerFor(f, version.files[f]));
    return !(have.length === orig.length + t.length && have.subarray(0, orig.length).equals(orig) && have.subarray(orig.length).equals(t));
  });
  check(assets.length >= 50 && badTrailer.length === 0, `every stamped .js / .css file = the repo's file + one version trailer line (${assets.length} files${badTrailer.length ? '; wrong: ' + badTrailer.slice(0, 4).join(', ') : ''})`);
  const tailOf = (f) => read(path.join(siteA, f)).split('\n').slice(-2)[0];
  const ctx = { window: {} };
  vm.runInNewContext(['js/app.js', 'data/stores.js', 'vendor/maplibre/maplibre-gl.js'].map(tailOf).join('\n'), ctx);
  check(['js/app.js', 'data/stores.js', 'vendor/maplibre/maplibre-gl.js'].every((f) => ctx.window.MT_V[f] === version.files[f]),
    `JS trailer ${tailOf('js/app.js')} → window.MT_V["js/app.js"] = its ?v= (app, data and vendor scripts alike)`);
  check(tailOf('css/core.css') === `/*mt-v*/:root{--mt-v-css-core-css:"${version.files['css/core.css']}"}` && Object.keys(lazy).every((p) => tailOf(p).includes(JSON.stringify(p) + ']=' + JSON.stringify(lazy[p]))),
    `CSS trailer ${tailOf('css/core.css')}; the lazily loaded scripts carry theirs (MT.loadScript checks it)`);

  /* ---- 4. hashes change only with content -------------------------------------------------------------- */
  console.log('\n4. hashes change only when content changes');
  const p1 = stampSite(siteB, { commit: '0123abc' });
  check(p1.build === version.build && read(path.join(siteB, 'index.html')) === html, 'two stamps of the same files: same build, byte-identical index.html');
  const again = stampSite(siteA, { commit: '0123abc' });
  check(again.build === version.build && read(path.join(siteA, 'index.html')) === html && (read(path.join(siteA, 'js', 'app.js')).match(/\/\*mt-v\*\//g) || []).length === 1
    && readFileSync(path.join(siteA, 'js', 'app.js')).equals(readFileSync(path.join(siteB, 'js', 'app.js'))), 're-stamping a stamped folder changes nothing (idempotent: one trailer per file, never stacked)');
  appendFileSync(path.join(siteB, 'js', 'geo.js'), '\n// edited\n');
  const p2 = stampSite(siteB, { commit: 'fedcba9' });
  const v2 = JSON.parse(read(path.join(siteB, 'version.json')));
  const changed = Object.keys(v2.files).filter((k) => v2.files[k] !== version.files[k]);
  check(changed.join() === 'js/geo.js' && p2.build !== version.build, `editing js/geo.js changes only its hash (${changed.join(', ')}) and the build (${version.build} → ${p2.build})`);
  const d = read(path.join(siteB, 'index.html')).split('\n'), d0 = html.split('\n');
  const diff = d.map((l, i) => (l !== d0[i] ? l.trim() : null)).filter(Boolean);
  check(d.length === d0.length && diff.length === 2 && /MT_BUILD/.test(diff[0]) && /js\/geo\.js\?v=/.test(diff[1]), 'index.html differs only in MT_BUILD and the geo.js URL');

  /* ---- 5. --check --------------------------------------------------------------------------------------- */
  console.log('\n5. --check');
  check(cli(siteA, '--check').code === 0 && checkSite(siteB).ok, '--check passes on a good stamp');
  const siteC = path.join(tmp, 'c');
  copySite(siteC);
  const unst = cli(siteC, '--check');
  check(unst.code === 1 && /js\/mt\.js is not stamped/.test(unst.out) && /no MT_BUILD/.test(unst.out) && /version\.json: missing/.test(unst.out), '--check on an unstamped copy: exit 1, "is not stamped", "no MT_BUILD", version.json missing');
  appendFileSync(path.join(siteA, 'css', 'core.css'), '\n/* edited after the stamp */\n');
  const tamp = cli(siteA, '--check');
  check(tamp.code === 1 && /css\/core\.css\?v=[0-9a-f]{8} does not match the file/.test(tamp.out) && /version\.json/.test(tamp.out), '--check after a file changed: exit 1, names css/core.css and version.json');
  {
    const siteE = path.join(tmp, 'e');
    copySite(siteE);
    const pe = stampSite(siteE);
    const theme = path.join(siteE, 'js', 'theme.js'), buf = readFileSync(theme), t = trailerFor('js/theme.js', pe.files['js/theme.js']);
    writeFileSync(theme, buf.subarray(0, buf.length - t.length));                              // the trailer lost
    const lost = checkSite(siteE);
    writeFileSync(theme, Buffer.concat([buf.subarray(0, buf.length - t.length), Buffer.from(trailerFor('js/theme.js', '0badc0de'))]));
    const other = checkSite(siteE);
    check(!lost.ok && lost.problems.some((x) => /no version trailer in 1 file\(s\): js\/theme\.js$/.test(x)) && !other.ok && other.problems.some((x) => /^js\/theme\.js: its version trailer is not the one of its content/.test(x)),
      `--check: a missing version trailer ("${lost.problems.join('; ')}") or one of another hash is an error`);
  }
  const repo = cli(ROOT);
  check(repo.code === 2 && /refusing/.test(repo.out) && !/id="mt-build"/.test(read(path.join(ROOT, 'index.html'))), 'the repository itself is never stamped (exit 2)');
  const siteD = path.join(tmp, 'd');
  copySite(siteD);
  rmSync(path.join(siteD, 'data', 'road-names.js'));
  const pd = stampSite(siteD);
  check(pd.warnings.some((w) => /road-names\.js does not exist \(optional/.test(w)) && /src="data\/road-names\.js" data-optional/.test(read(path.join(siteD, 'index.html'))), 'a missing optional file is a warning (left unstamped)');
  rmSync(path.join(siteD, 'js', 'geo.js'));
  let threw = '';
  try { stampSite(siteD); } catch (e) { threw = e.message; }
  check(/js\/geo\.js does not exist/.test(threw), 'a missing required file stops the stamp (the deploy fails instead of shipping a broken site)');

  /* ---- 6. workflow --------------------------------------------------------------------------------------- */
  console.log('\n6. .github/workflows/pages.yml');
  const wf = read(path.join(ROOT, '.github', 'workflows', 'pages.yml'));
  const steps = ['actions/checkout@v5', 'node tools/stamp-assets.mjs --copy-to _site', 'node tools/stamp-assets.mjs _site --commit=', 'node tools/stamp-assets.mjs _site --check',
    'touch _site/.nojekyll', 'actions/configure-pages@v6', 'actions/upload-pages-artifact@v5', 'actions/deploy-pages@v5'];
  const order = steps.map((s) => wf.indexOf(s));
  check(order.every((i, k) => i > 0 && (!k || i > order[k - 1])), 'steps in order: checkout → copy → stamp → check → .nojekyll → configure → upload → deploy');
  check(/node-version: 24\b/.test(wf) && wf.includes('actions/setup-node@v5') && /include-hidden-files: true/.test(wf) && /BEFORE pushing/.test(wf), 'Node 24 (setup-node@v5); the artifact keeps .nojekyll (include-hidden-files: true); the header says to switch the Pages source before pushing');
  check(/branches: \[main\]/.test(wf) && /workflow_dispatch:/.test(wf) && /pages: write/.test(wf) && /id-token: write/.test(wf) && /group: pages/.test(wf) && /name: github-pages/.test(wf),
    'on push to main + workflow_dispatch; permissions pages: write, id-token: write; concurrency group pages; github-pages environment');
  check(!wf.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /npm (install|ci)/.test(l)), 'no npm install step (the stamp script uses Node built-ins only)');
} catch (err) {
  console.log(err);
  check(false, 'test run threw: ' + (err && err.message));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
finish();
