// tools/test/db-shots.mjs — visual pass over the M3 screens (Base de datos, Cadenas, dialogs).
//   node tools/test/db-shots.mjs [--en] [--real]      screenshots → tools/test/out/db-shot-*.png
// --real uses the repository data where present (fixtures only for missing files).
import { openApp, screenshot, sleep, waitForMapIdle } from './lib.mjs';

const lang = process.argv.includes('--en') ? 'en' : 'es';
const fixtures = process.argv.includes('--real') ? 'missing' : 'all';
const { browser, page, errors } = await openApp({ lang, fixtures, viewport: { width: 1440, height: 900 }, hash: 'base' });
const tag = `${lang}${fixtures === 'all' ? '' : '-real'}`;
const t0 = Date.now();

/** Run one step with a log line and a hard timeout (a blocked page must not hang the script). */
async function step(label, fn, ms = 60000) {
  process.stdout.write(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${label}\n`);
  let timer;
  const r = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms); })]);
  clearTimeout(timer);
  return r;
}
const shot = (name) => step(`shot ${name}`, () => screenshot(page, `db-shot-${tag}-${name}`));
const ev = (label, fn, arg) => step(label, () => page.evaluate(fn, arg));

try {
  await step('main map idle', () => waitForMapIdle(page, { expr: 'MT.dbui && MT.dbui._map' }).catch((e) => console.log('   (map idle:', e.message + ')')));
  await sleep(500);
  await shot('table');

  await step('chains popover', () => page.click('.mt-db-fbtn'));
  await sleep(300);
  await shot('pop-chains');
  await page.keyboard.press('Escape');

  await ev('location popover', () => document.querySelectorAll('.mt-db-fbtn')[1].click());
  await sleep(300);
  await shot('pop-location');
  await page.keyboard.press('Escape');

  await ev('select row 4', () => MT.dbui.select(MT.dbui.visible()[3].id, { source: 'api' }));
  await sleep(1200);
  await shot('selected');

  await ev('open editor', () => MT.dbui.openEditor(MT.dbui.visible()[3].id));
  await sleep(2500);
  await shot('drawer');
  await ev('close editor', () => MT.dbui.closeEditor(true));
  await sleep(300);

  await ev('add store', () => MT.dbui.openEditor(null));
  await sleep(1500);
  await shot('add');
  await ev('close editor', () => MT.dbui.closeEditor(true));
  await sleep(300);

  await ev('bulk select', () => { const b = document.querySelectorAll('tbody input.mt-db-check'); b[0].click(); b[2].click(); });
  await sleep(300);
  await shot('bulk');
  await ev('bulk clear', () => document.querySelector('.mt-db-bulk__x').click());

  await ev('scan dialog', () => { MT.dbui.openScan({ ubigeos: ['150122', '150131'] }); });
  await sleep(500);
  await shot('scan');
  await page.keyboard.press('Escape');
  await sleep(300);

  // Delete dialog
  await ev('delete dialog', () => { MT.dbui.openEditor(MT.dbui.visible()[5].id); setTimeout(() => [...document.querySelectorAll('.mt-db-drawer__foot button')][0].click(), 400); });
  await sleep(900);
  await shot('delete');
  await page.keyboard.press('Escape');
  await sleep(300);
  await ev('close editor', () => MT.dbui.closeEditor(true));

  // Import dialog (Spanish headers, title row, one row to geocode)
  await ev('import dialog', () => {
    const rows = [['Reporte'], ['Código', 'Cadena', 'Nombre', 'Dirección', 'Distrito', 'Latitud', 'Longitud', 'Estado', 'Observaciones', 'Gerente'],
      ['osm-w129822354', 'Plaza Vea', 'Plaza Vea Arequipa', '', '', '', '', 'Por verificar', 'visitada', 'Ana'],
      ['', 'Tottus', 'Tottus Primavera', 'Av. Primavera 100', 'Surco', '-12,1100', '-77,0050', '', '', 'Luis'],
      ['', 'Mass', 'Mass Pardo', 'Av. José Pardo 500', 'Miraflores', '', '', '', '', ''],
      ['', '', 'Sin cadena', 'Av. X 1', '', '-12.1', '-77.0', '', '', '']];
    MT.dbui.importRows('tiendas-campo.xlsx', rows);
  });
  await sleep(600);
  await shot('import');
  await page.keyboard.press('Escape');
  await sleep(300);

  await step('tab chains', () => page.click('#tab-chains'));
  await sleep(900);
  await shot('chains');
  await ev('select holi', () => MT.chainsui.select('holi'));
  await sleep(700);
  await shot('chains-holi');

  // Logo upload dialog with a wide wordmark-like test image
  await ev('upload dialog', () => {
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 160;
    const g = cv.getContext('2d'); g.fillStyle = '#7AB800'; g.font = '700 110px Instrument Sans'; g.fillText('HOLI', 30, 120);
    const img = new Image(); img.onload = () => MT.chainsui.uploadBadge({ img, name: 'holi.png' }); img.src = cv.toDataURL();
  });
  await sleep(700);
  await shot('upload');
  await page.keyboard.press('Escape');
} catch (err) {
  console.log('FAILED:', err.message);
  await screenshot(page, `db-shot-${tag}-failure`).catch(() => {});
  process.exitCode = 1;
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
