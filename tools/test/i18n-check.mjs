// tools/test/i18n-check.mjs — every UI string exists in Spanish AND English.
//
// Static part (no browser):
//   1. loads every js/i18n/*.js dictionary and compares the ES and EN key sets;
//   2. values: non-empty, same {placeholders}, plural objects in both languages or in neither;
//   3. scans js/*.js for string literals that look like i18n keys ('ns.key', 'ns.prefix.' + x) and
//      checks each one exists (or is the prefix of existing keys) in both languages;
//   4. lists keys no code refers to (informational: keys can be built dynamically).
// Runtime part (headless Chrome, file://): boots the app in ES and in EN, visits every tab and the
// main dialogs, then asserts MT.i18n.missingKeys() is empty and no raw key is visible on screen.
//
//   node tools/test/i18n-check.mjs [--static]

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, openApp, makeChecker, loadDemoProject, sleep } from './lib.mjs';

const { check, finish } = makeChecker('i18n');
const STATIC_ONLY = process.argv.includes('--static');

/* ---- 1. dictionaries ------------------------------------------------------------------------ */
const PLURAL = ['zero', 'one', 'two', 'few', 'many', 'other'];
const isPlural = (v) => !!v && typeof v === 'object' && typeof v.other === 'string' && Object.keys(v).every((k) => PLURAL.includes(k));
function flatten(obj, prefix, out) {
  for (const k of Object.keys(obj)) {
    const v = obj[k], key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !isPlural(v)) flatten(v, key, out); else out[key] = v;
  }
  return out;
}
const dicts = { es: {}, en: {} };
const fileOf = {};
const i18nDir = path.join(ROOT, 'js', 'i18n');
for (const f of readdirSync(i18nDir).filter((x) => x.endsWith('.js'))) {
  const ctx = { MT: { i18n: { add: (lang, o) => { const flat = flatten(o, '', {}); for (const k of Object.keys(flat)) { (dicts[lang] ||= {})[k] = flat[k]; fileOf[k] = f; } } } } };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(i18nDir, f), 'utf8'), ctx, { filename: f });
}
const es = dicts.es, en = dicts.en;
const esKeys = Object.keys(es), enKeys = Object.keys(en);
const onlyEs = esKeys.filter((k) => !(k in en)), onlyEn = enKeys.filter((k) => !(k in es));
check(onlyEs.length === 0, `every ES key has an EN translation (${esKeys.length} keys)${onlyEs.length ? ': missing EN ' + onlyEs.slice(0, 20).join(', ') : ''}`);
check(onlyEn.length === 0, `every EN key has an ES translation (${enKeys.length} keys)${onlyEn.length ? ': missing ES ' + onlyEn.slice(0, 20).join(', ') : ''}`);

/* ---- 2. values ---------------------------------------------------------------------------- */
const placeholders = (v) => {
  const s = isPlural(v) ? Object.values(v).join(' ') : String(v);
  return [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
};
const empty = [], phMismatch = [], pluralMismatch = [];
for (const k of esKeys.filter((x) => x in en)) {
  for (const [lang, v] of [['es', es[k]], ['en', en[k]]]) {
    const vals = isPlural(v) ? Object.values(v) : [v];
    if (vals.some((x) => typeof x !== 'string' || !x.trim())) empty.push(`${lang}:${k}`);
  }
  if (isPlural(es[k]) !== isPlural(en[k])) pluralMismatch.push(k);
  // Plural forms may legitimately drop {n} in one language ("Una tienda" / "{n} stores").
  const a = placeholders(es[k]).split(',').filter((x) => x && x !== 'n' && x !== 'count');
  const b = placeholders(en[k]).split(',').filter((x) => x && x !== 'n' && x !== 'count');
  if (a.join() !== b.join()) phMismatch.push(`${k} (es {${a}} / en {${b}})`);
}
check(empty.length === 0, `no empty translations${empty.length ? ': ' + empty.slice(0, 20).join(', ') : ''}`);
check(pluralMismatch.length === 0, `plural forms match between languages${pluralMismatch.length ? ': ' + pluralMismatch.join(', ') : ''}`);
check(phMismatch.length === 0, `same {placeholders} in ES and EN${phMismatch.length ? ': ' + phMismatch.slice(0, 20).join('; ') : ''}`);

/* ---- 3. keys referenced from code --------------------------------------------------------- */
const namespaces = [...new Set(esKeys.map((k) => k.split('.')[0]))];
const nsRe = new RegExp(`(['"\`])((?:${namespaces.join('|')})\\.[A-Za-z0-9_.]+)\\1`, 'g');
// Literal strings that are not i18n keys although they share a namespace: preference keys,
// storage keys, event names and object paths.
const NOT_KEY_CONTEXT = /(pref|setPref|kvGet|kvSet|local\.(get|set|remove)|getItem|setItem|removeItem)\(\s*$/;
const refs = new Map(); // key -> Set(files)
const prefixes = new Map();
const jsDir = path.join(ROOT, 'js');
const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => path.join(jsDir, f));

/** Blank out comments (keeps strings, regex literals and offsets intact enough for scanning). */
function stripComments(src) {
  let out = '', i = 0, state = 'code', quote = '', lastSig = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; out += c; i++; continue; }
      if (c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || /\breturn\s*$/.test(out.slice(-12)))) {
        state = 'regex'; out += c; i++; continue;
      }
      if (!/\s/.test(c)) lastSig = c;
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i++; } continue; }
    if (state === 'str') {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === quote) { state = 'code'; lastSig = c; }
      i++; continue;
    }
    if (state === 'regex') {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === '[') { // character class: '/' inside does not end the regex
        i++;
        while (i < src.length && src[i] !== ']') { if (src[i] === '\\') { out += src[i]; i++; } out += src[i]; i++; }
        continue;
      }
      if (c === '/' || c === '\n') { state = 'code'; lastSig = 'x'; }
      i++; continue;
    }
  }
  return out;
}

for (const file of jsFiles) {
  const src = stripComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(nsRe)) {
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    if (NOT_KEY_CONTEXT.test(before)) continue;
    const key = m[2];
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 4);
    const target = key.endsWith('.') || /^\s*\+/.test(after) ? prefixes : refs;
    if (!target.has(key)) target.set(key, new Set());
    target.get(key).add(path.basename(file));
  }
}
// Known non-key literals that match a namespace (pref keys passed through variables, etc.).
const NOT_KEYS = new Set(Object.keys(JSON.parse(process.env.MT_I18N_IGNORE || '{}')));
const unknown = [];
for (const [k, files] of refs) {
  if (NOT_KEYS.has(k)) continue;
  if (k in es && k in en) continue;
  // A literal may be a namespace object used for lookups (e.g. 'data.status') — accept when it
  // is a prefix of real keys.
  if (esKeys.some((x) => x.startsWith(k + '.'))) continue;
  unknown.push(`${k} (${[...files].join(', ')})`);
}
check(unknown.length === 0, `every literal key used in js/*.js exists in ES and EN (${refs.size} literals)${unknown.length ? ': ' + unknown.join('; ') : ''}`);
const badPrefixes = [...prefixes.keys()].filter((p) => {
  const pre = p.endsWith('.') ? p : p;
  return !esKeys.some((x) => x.startsWith(pre)) || !enKeys.some((x) => x.startsWith(pre));
});
check(badPrefixes.length === 0, `every dynamic key prefix has keys (${prefixes.size} prefixes)${badPrefixes.length ? ': ' + badPrefixes.join(', ') : ''}`);

// Informational: keys never referenced literally nor through a dynamic prefix.
const allSrc = jsFiles.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
const unused = esKeys.filter((k) => {
  if (refs.has(k)) return false;
  if ([...prefixes.keys()].some((p) => k.startsWith(p))) return false;
  const last = k.split('.').pop();
  const parent = k.slice(0, k.length - last.length - 1);
  // Built as parent + '.' + something, or the parent is passed around (e.g. 'map.notice.' + key).
  return !allSrc.includes(`'${parent}.`) && !allSrc.includes(`'${parent}'`) && !allSrc.includes(`"${parent}.`);
});
console.log(`  info ${unused.length} key(s) not referenced literally (may be built dynamically)${unused.length ? ': ' + unused.slice(0, 40).join(', ') : ''}`);

/* ---- 4. runtime ----------------------------------------------------------------------------- */
async function runtime(lang) {
  const { browser, page, errors } = await openApp({ lang });
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warn' && /\[i18n\]/.test(m.text())) warnings.push(m.text()); });
  try {
    await loadDemoProject(page);
    // Visit every tab and open the main dialogs/menus so lazily-built UI is translated too.
    await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const t of MT.app.tabs()) { MT.app.showTab(t.id); await wait(400); }
      MT.app.showTab('maps'); await wait(600);
      const sections = ['content', 'districts', 'chains', 'markers', 'map', 'radius', 'hidden'];
      for (const s of sections) MT.mapsui.section(s, true);
      await wait(300);
    });
    const scan = () => page.evaluate((nsList) => {
      const re = new RegExp(`^(?:${nsList.join('|')})\\.[a-z][A-Za-z0-9_.]*$`);
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const s = walker.currentNode.nodeValue.trim(); if (re.test(s)) out.push(s); }
      document.querySelectorAll('[title],[placeholder],[aria-label]').forEach((el) => {
        for (const a of ['title', 'placeholder', 'aria-label']) { const v = (el.getAttribute(a) || '').trim(); if (re.test(v)) out.push(`${a}=${v}`); }
      });
      return out;
    }, namespaces);
    const raw1 = await scan();
    // Export dialog + DB editor + chain tab
    await page.evaluate(async () => { MT.export.dialog({ format: 'pptx' }); await new Promise((r) => setTimeout(r, 400)); });
    const raw2 = await scan();
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      MT.app.showTab('db'); await new Promise((r) => setTimeout(r, 300));
      MT.dbui.openEditor(null); await new Promise((r) => setTimeout(r, 400));
    });
    const raw3 = await scan();
    await page.evaluate(async () => { MT.dbui.closeEditor(true); MT.app.showTab('chains'); await new Promise((r) => setTimeout(r, 400)); });
    const raw4 = await scan();
    const missing = await page.evaluate(() => MT.i18n.missingKeys());
    const raw = [...new Set([...raw1, ...raw2, ...raw3, ...raw4])];
    check(missing.length === 0, `[${lang}] no missing keys requested at runtime${missing.length ? ': ' + missing.join(', ') : ''}`);
    check(warnings.length === 0, `[${lang}] no i18n warnings${warnings.length ? ': ' + warnings.slice(0, 5).join(' | ') : ''}`);
    check(raw.length === 0, `[${lang}] no untranslated key visible on screen${raw.length ? ': ' + raw.slice(0, 10).join(', ') : ''}`);
    check(errors.length === 0, `[${lang}] no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  } finally {
    await browser.close();
  }
}
if (!STATIC_ONLY) {
  await runtime('es');
  await runtime('en');
}
await sleep(10);
finish();
