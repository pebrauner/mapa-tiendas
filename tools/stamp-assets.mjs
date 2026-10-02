#!/usr/bin/env node
// tools/stamp-assets.mjs — cache-busting for the GitHub Pages deploy (docs/ARCHITECTURE.md §16).
//
// GitHub Pages serves every file with Cache-Control: max-age=600 and index.html loads ~45 local
// scripts and stylesheets. Without a version in their URLs, a reload after a deploy pairs the NEW
// index.html with OLD copies of js/*.js still in the browser cache (the "matrix not working" report
// of 2026-10-02). The deploy therefore serves a STAMPED copy of the app:
//
//   node tools/stamp-assets.mjs --copy-to _site   copy the files the site serves (index.html, LICENSE,
//                                                 .nojekyll, css/, js/, vendor/, data/, logos/,
//                                                 docs/styleguide.html) into _site (emptied first)
//   node tools/stamp-assets.mjs _site             stamp _site in place:
//                                                 · every local <script src> / <link href> / <img src> of
//                                                   every HTML page gets ?v=<first 8 hex of the file's sha256>
//                                                 · index.html gets <script id="mt-build">window.MT_BUILD =
//                                                   "<build>"; window.MT_ASSET_V = {lazy script: hash}</script>
//                                                   (MT.assetUrl stamps the scripts loaded later, e.g. SheetJS)
//                                                 · every stamped .js / .css file gets a last line declaring
//                                                   the hash its URL carries (its "version trailer"):
//                                                   JS  ;(window.MT_V=…)["js/app.js"]="<hash>";
//                                                   CSS :root{--mt-v-css-core-css:"<hash>"}
//                                                   index.html's boot check compares each ?v= with what the
//                                                   file says: a cached OLD index.html that gets files of a
//                                                   NEW deploy (Pages ignores ?v=) shows the update notice
//                                                   instead of running a mix of two builds
//                                                 · version.json {build, generated, commit?, files:{path: hash}}
//                                                   (the app compares it with MT_BUILD: "Hay una versión nueva")
//   node tools/stamp-assets.mjs _site --check     verify a stamped folder; exit 1 with the list of problems
//   options: --commit=<sha> (recorded in version.json), --quiet
//
// A file's hash is of its content WITHOUT the trailer (= the repo's file). The build id is derived from
// the content (the assets' hashes + the pages), so a deploy that changes nothing the browser loads keeps
// its id (no "new version" banner), and a re-run is idempotent (a trailer is replaced, never stacked).
// The repo's own files are never stamped: file:// and "Guardar en carpeta" use them as they are.
// Node built-ins only (the workflow runs it without npm install).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');

/** What the site serves (paths relative to the repo root). Everything else (tools/, docs sources, *.md) stays out. */
export const SITE_ENTRIES = ['index.html', 'LICENSE', '.nojekyll', 'css', 'js', 'vendor', 'data', 'logos', 'docs/styleguide.html'];
/** Length of the ?v= hash and of the build id. */
export const HASH_LEN = 8, BUILD_LEN = 10;
const STAMP_RE = /^[0-9a-f]{8}$/;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

/* ---- Version trailers ------------------------------------------------------------------------------ */
/** The last line stamping adds to a .js / .css file (withoutTrailer removes it). */
export const TRAILER_RE = /\n\/\*mt-v\*\/[^\n]*\n$/;
/** CSS custom property a stamped stylesheet sets on :root to its hash ('css/core.css' → '--mt-v-css-core-css'). */
export function cssVersionVar(rel) { return '--mt-v-' + rel.replace(/[^A-Za-z0-9_-]/g, '-'); }
/** The version trailer of the site file `rel` stamped with `hash`; '' for a file that cannot carry one (images). */
export function trailerFor(rel, hash) {
  if (/\.js$/i.test(rel)) return `\n/*mt-v*/;(window.MT_V=window.MT_V||{})[${JSON.stringify(rel)}]=${JSON.stringify(hash)};\n`;
  if (/\.css$/i.test(rel)) return `\n/*mt-v*/:root{${cssVersionVar(rel)}:${JSON.stringify(hash)}}\n`;
  return '';
}
/** A file's bytes without its version trailer: what its ?v= hash is computed from (= the repo's file). */
export function withoutTrailer(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString('latin1');   // one char per byte: lengths match
  const m = TRAILER_RE.exec(tail);
  return m ? buf.subarray(0, buf.length - m[0].length) : buf;
}

/** First HASH_LEN hex characters of the sha256 of a file's bytes (its version trailer left out). */
export function hashFile(file) { return sha(withoutTrailer(readFileSync(file))).slice(0, HASH_LEN); }

/** Copy the served files of `src` (default: this repo) into `out` (emptied first). Returns the copied entries. */
export function copySite(out, src = REPO) {
  const abs = path.resolve(out), root = path.resolve(src);
  if (abs === root || root.startsWith(abs + path.sep)) throw new Error(`refusing to empty ${abs}: it contains the source folder`);
  rmSync(abs, { recursive: true, force: true });
  mkdirSync(abs, { recursive: true });
  const copied = [];
  for (const e of SITE_ENTRIES) {
    const from = path.join(root, e);
    if (!existsSync(from)) continue;
    mkdirSync(path.dirname(path.join(abs, e)), { recursive: true });
    cpSync(from, path.join(abs, e), { recursive: true });
    copied.push(e);
  }
  return copied;
}

/* ---- HTML scanning ------------------------------------------------------------------------------ */
/** Every *.html file of the site (posix paths relative to dir), index.html first. */
function htmlPages(dir) {
  const out = [];
  (function walk(rel) {
    for (const name of readdirSync(path.join(dir, rel))) {
      const r = rel ? rel + '/' + name : name;
      const full = path.join(dir, r);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules' && name[0] !== '.') walk(r); }
      else if (/\.html?$/i.test(name)) out.push(r);
    }
  })('');
  return out.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a < b ? -1 : 1));
}

/** The page with comments and inline <script>/<style> bodies blanked out (same length): tags inside them are not markup. */
function maskInert(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/(<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi, (m, open, tag, body, close) => open + ' '.repeat(body.length) + close);
}

/** A URL of a file of the site itself (not http:, data:, //host, /root, #frag). */
function isLocalUrl(u) { return !!u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u.trim()); }

/**
 * Local asset references of a page: [{start, end, url, base, query, frag, tag, optional}] where
 * html.slice(start, end) is the attribute value.
 */
function assetRefs(html) {
  const masked = maskInert(html), refs = [];
  const tagRe = /<(script|link|img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let m;
  while ((m = tagRe.exec(masked))) {
    const tag = m[0], name = m[1].toLowerCase();
    const attr = name === 'link' ? 'href' : 'src';
    const am = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
    if (!am) continue;
    const url = am[2] !== undefined ? am[2] : am[3];
    if (!isLocalUrl(url)) continue;
    const start = m.index + am.index + am[0].indexOf(am[1]) + 1;
    const [, base, query = '', frag = ''] = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
    refs.push({ start, end: start + url.length, url, base, query, frag, tag: name,
      optional: /\sdata-optional\b/i.test(tag) || /\sonerror\s*=/i.test(tag) });
  }
  return refs;
}

/** Remove what stamping added (the mt-build script, ?v= of local assets): the page as in the repo. */
function unstampPage(html) {
  html = html.replace(/[ \t]*<script id="mt-build">[\s\S]*?<\/script>\r?\n?/, '');
  const refs = assetRefs(html);
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i];
    const q = r.query.replace(/^\?/, '').split('&').filter((kv) => kv && !/^v=[0-9a-f]{8}$/.test(kv)).join('&');
    html = html.slice(0, r.start) + r.base + (q ? '?' + q : '') + r.frag + html.slice(r.end);
  }
  return html;
}

/** Lazily loaded scripts (MT.loadScript('vendor/…') in js/**): their paths, relative to the site root. */
function lazyScripts(dir) {
  const found = new Set();
  (function walk(rel) {
    const full = path.join(dir, rel);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full)) {
      const r = rel + '/' + name;
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else if (name.endsWith('.js')) {
        for (const m of readFileSync(path.join(dir, r), 'utf8').matchAll(/loadScript\(\s*(['"])([^'"]+)\1/g)) if (isLocalUrl(m[2])) found.add(m[2]);
      }
    }
  })('js');
  return [...found].filter((p) => existsSync(path.join(dir, p))).sort();
}

/**
 * Plan the stamping of `dir` without writing anything: {build, pages:{path: stampedHtml}, files:{path: hash},
 * lazy:{path: hash}, problems:[…], warnings:[…]}.
 */
export function plan(dir) {
  dir = path.resolve(dir);
  const problems = [], warnings = [], files = {}, pageHashes = {}, sources = {};
  if (!existsSync(path.join(dir, 'index.html'))) problems.push('index.html is missing');
  const hashOf = (rel) => (files[rel] || (files[rel] = hashFile(path.join(dir, rel))));
  const pages = htmlPages(dir);
  for (const p of pages) {
    const src = unstampPage(readFileSync(path.join(dir, p), 'utf8'));
    sources[p] = src;
    pageHashes[p] = sha(src);
    for (const r of assetRefs(src)) {
      const rel = posix(path.normalize(path.join(path.dirname(p), decodeURIComponent(r.base))));
      if (rel.startsWith('..')) { problems.push(`${p}: ${r.url} points outside the site`); continue; }
      if (!existsSync(path.join(dir, rel)) || statSync(path.join(dir, rel)).isDirectory()) {
        (r.optional ? warnings : problems).push(`${p}: ${r.url} does not exist${r.optional ? ' (optional: left unstamped)' : ''}`);
        continue;
      }
      r.rel = rel;
      hashOf(rel);
    }
  }
  const lazy = {};
  for (const rel of lazyScripts(dir)) lazy[rel] = hashOf(rel);
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  const build = sha(JSON.stringify({ files: sorted, pages: pageHashes })).slice(0, BUILD_LEN);
  const out = {};
  for (const p of pages) {
    let html = sources[p];
    const refs = assetRefs(html);
    for (let i = refs.length - 1; i >= 0; i--) {
      const r = refs[i];
      const rel = posix(path.normalize(path.join(path.dirname(p), decodeURIComponent(r.base))));
      if (!files[rel]) continue;
      const q = r.query.replace(/^\?/, '');
      html = html.slice(0, r.start) + r.base + '?' + (q ? q + '&' : '') + 'v=' + files[rel] + r.frag + html.slice(r.end);
    }
    if (p === 'index.html') {
      const tag = `<script id="mt-build">window.MT_BUILD = ${JSON.stringify(build)}; window.MT_ASSET_V = ${JSON.stringify(lazy)};</script>\n`;
      const cm = /<meta\s+charset[^>]*>\r?\n?/i.exec(html) || /<head[^>]*>\r?\n?/i.exec(html);
      if (!cm) problems.push('index.html: no <head> to put MT_BUILD in');
      else html = html.slice(0, cm.index + cm[0].length) + tag + html.slice(cm.index + cm[0].length);
    }
    out[p] = html;
  }
  return { dir, build, pages: out, files: sorted, lazy, problems, warnings };
}

/** Stamp `dir` in place (see the header). Returns the plan; throws when the site is broken. */
export function stampSite(dir, { commit = null, now = new Date() } = {}) {
  const p = plan(dir);
  if (p.problems.length) throw new Error('cannot stamp ' + p.dir + ':\n  ' + p.problems.join('\n  '));
  for (const [rel, html] of Object.entries(p.pages)) writeFileSync(path.join(p.dir, rel), html);
  // Each .js / .css file ends by declaring its own hash (replacing the trailer of an earlier stamp).
  p.trailers = 0;
  for (const [rel, hash] of Object.entries(p.files)) {
    const t = trailerFor(rel, hash);
    if (!t) continue;
    const f = path.join(p.dir, rel);
    writeFileSync(f, Buffer.concat([withoutTrailer(readFileSync(f)), Buffer.from(t, 'utf8')]));
    p.trailers++;
  }
  const version = { build: p.build, generated: now.toISOString() };
  if (commit) version.commit = String(commit);
  version.files = p.files;
  writeFileSync(path.join(p.dir, 'version.json'), JSON.stringify(version, null, 2) + '\n');
  return p;
}

/** Verify a stamped folder: {ok, build, problems:[…], warnings:[…], stamped: n URLs, trailers: n files}. */
export function checkSite(dir) {
  const p = plan(dir), problems = p.problems.slice();
  let stamped = 0;
  for (const [rel, want] of Object.entries(p.pages)) {
    const have = readFileSync(path.join(p.dir, rel), 'utf8');
    if (have === want) { stamped += assetRefs(have).filter((r) => /(^|[?&])v=/.test(r.query.slice(1))).length; continue; }
    // Say precisely what is off.
    const wantRefs = new Map(assetRefs(want).map((r) => [r.base, r.query]));
    for (const r of assetRefs(have)) {
      const w = wantRefs.get(r.base);
      if (w === undefined) continue;
      const v = /(?:^|[?&])v=([^&]*)/.exec(r.query.slice(1));
      if (!v) problems.push(`${rel}: ${r.base} is not stamped`);
      else if (!STAMP_RE.test(v[1]) || w !== r.query) problems.push(`${rel}: ${r.base}?v=${v[1]} does not match the file (want ${w})`);
    }
    if (rel === 'index.html' && !/<script id="mt-build">window\.MT_BUILD = "([0-9a-f]+)"/.test(have)) problems.push('index.html: no MT_BUILD');
    else if (rel === 'index.html' && !have.includes(`window.MT_BUILD = ${JSON.stringify(p.build)};`)) problems.push(`index.html: MT_BUILD is not the build of these files (${p.build})`);
    if (!problems.some((x) => x.startsWith(rel + ':'))) problems.push(`${rel}: differs from a fresh stamp of the same files`);
  }
  // Every .js / .css file ends with the trailer of its hash (index.html's boot check reads it).
  const noTrailer = [];
  let trailers = 0;
  for (const [rel, hash] of Object.entries(p.files)) {
    const t = trailerFor(rel, hash);
    if (!t) continue;
    const buf = readFileSync(path.join(p.dir, rel));
    if (buf.length >= t.length && buf.subarray(buf.length - t.length).toString('utf8') === t) { trailers++; continue; }
    const m = TRAILER_RE.exec(buf.subarray(Math.max(0, buf.length - 1024)).toString('latin1'));
    if (m) problems.push(`${rel}: its version trailer is not the one of its content (${m[0].trim()}; want ${t.trim()})`);
    else noTrailer.push(rel);
  }
  if (noTrailer.length) problems.push(`no version trailer in ${noTrailer.length} file(s): ${noTrailer.slice(0, 6).join(', ')}${noTrailer.length > 6 ? ', …' : ''}`);
  const vf = path.join(p.dir, 'version.json');
  let version = null;
  try { version = JSON.parse(readFileSync(vf, 'utf8')); } catch (e) { problems.push(`version.json: ${existsSync(vf) ? 'not valid JSON' : 'missing'}`); }
  if (version) {
    if (version.build !== p.build) problems.push(`version.json: build ${version.build} ≠ ${p.build}`);
    if (typeof version.generated !== 'string' || isNaN(Date.parse(version.generated))) problems.push('version.json: no valid "generated" date');
    if (JSON.stringify(version.files) !== JSON.stringify(p.files)) problems.push('version.json: "files" does not match the files (path → hash)');
  }
  return { ok: problems.length === 0, build: p.build, problems, warnings: p.warnings, stamped, trailers };
}

/* ---- CLI ---------------------------------------------------------------------------------------------- */
function main(argv) {
  const opts = {}, pos = [];
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] === undefined ? true : m[2]; else pos.push(a);
  }
  const say = (s) => { if (!opts.quiet) console.log(s); };
  if (opts['copy-to']) {
    const out = typeof opts['copy-to'] === 'string' ? opts['copy-to'] : pos[0];
    if (!out) throw new Error('--copy-to needs a folder');
    const copied = copySite(out);
    say(`copied ${copied.join(', ')} → ${path.resolve(out)}`);
    return 0;
  }
  const dir = pos[0];
  if (!dir) { console.error('usage: node tools/stamp-assets.mjs <site folder> [--check] [--commit=<sha>] | --copy-to <folder>'); return 2; }
  const abs = path.resolve(dir);
  if (abs === REPO || existsSync(path.join(abs, '.git')) || existsSync(path.join(abs, 'tools', 'stamp-assets.mjs'))) {
    console.error(`refusing to stamp ${abs}: it looks like the repository itself (stamp a copy: --copy-to _site first)`);
    return 2;
  }
  if (opts.check) {
    const r = checkSite(abs);
    r.warnings.forEach((w) => say('  warn ' + w));
    if (!r.ok) { console.error(`${abs}: ${r.problems.length} problem(s)\n  ` + r.problems.join('\n  ')); return 1; }
    say(`${abs}: stamped correctly (build ${r.build}, ${r.stamped} asset URLs, ${r.trailers} version trailers)`);
    return 0;
  }
  const p = stampSite(abs, { commit: typeof opts.commit === 'string' ? opts.commit : null });
  p.warnings.forEach((w) => say('  warn ' + w));
  say(`stamped ${Object.keys(p.pages).join(', ')}: ${Object.keys(p.files).length} files (${p.trailers} with a version trailer), build ${p.build} → version.json`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { console.error(err.message || err); process.exitCode = 1; }
}
