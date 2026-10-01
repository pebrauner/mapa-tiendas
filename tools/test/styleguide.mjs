// tools/test/styleguide.mjs — renders docs/styleguide.html (design-system catalogue) from file://
// and saves full-page + dialog screenshots: tools/test/out/styleguide*.png.
import { launch, collectErrors, screenshot, makeChecker, sleep, ROOT } from './lib.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { check, finish } = makeChecker('styleguide');
const browser = await launch();
const page = await browser.newPage();
const errors = collectErrors(page);
await page.setViewport({ width: 1280, height: 900 });
await page.goto(pathToFileURL(path.join(ROOT, 'docs', 'styleguide.html')).href + '?lang=es', { waitUntil: 'load' });
await page.evaluate(() => Promise.all([document.fonts.ready, document.fonts.load('700 14px Carlito')]));
await sleep(300);
const fonts = await page.evaluate(() => ({
  ui: document.fonts.check("14px 'Instrument Sans'"), display: document.fonts.check("700 14px 'Bricolage Grotesque'"), slide: document.fonts.check('700 14px Carlito'),
  bodyFont: getComputedStyle(document.body).fontFamily,
}));
check(fonts.ui && fonts.display && fonts.slide, `inlined fonts available (${JSON.stringify(fonts)})`);
await screenshot(page, 'styleguide', { fullPage: true });

// Open a menu and a modal for visual review.
const [menuBtn] = await page.$$('xpath/.//button[.//span[text()="Menú"]]');
await menuBtn.click(); await sleep(250);
await screenshot(page, 'styleguide-menu');
await page.keyboard.press('Escape');
const [modalBtn] = await page.$$('xpath/.//button[.//span[text()="Modal"]]');
await modalBtn.click(); await sleep(300);
check(await page.evaluate(() => document.activeElement && document.activeElement.textContent.includes('Importar')), 'modal autofocuses the primary action');
await screenshot(page, 'styleguide-modal');
await page.keyboard.press('Escape'); await sleep(250);
check(await page.evaluate(() => !document.querySelector('.mt-modal')), 'Escape closes the modal');
const [toastBtn] = await page.$$('xpath/.//button[.//span[text()="Avisos"]]');
await toastBtn.click(); await sleep(350);
await screenshot(page, 'styleguide-toasts');
check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
await browser.close();
finish();
