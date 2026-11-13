// Loads the content script into Chromium with a fake `browser` API and
// checks the remapped colours. Usage: node test/run.js [outDir]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const url = (f) => 'file://' + path.join(__dirname, 'fixtures', f);

const shim = (initial) => `
  (() => {
    const data = ${JSON.stringify(initial)};
    const listeners = [];
    window.__setSettings = (patch) => {
      const changes = {};
      for (const k in patch) { changes[k] = { oldValue: data[k], newValue: patch[k] }; data[k] = patch[k]; }
      listeners.forEach((l) => l(changes, 'local'));
    };
    window.browser = {
      storage: { local: { get: async () => ({ ...data }) }, onChanged: { addListener: (l) => listeners.push(l) } },
      runtime: { onMessage: { addListener: (l) => { window.__onMessage = l; } }, sendMessage: async () => {} }
    };
  })();`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

async function open(browser, file, settings = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(shim(settings));
  await page.addInitScript(src('src/palette.js'));
  await page.addInitScript(src('src/content.js'));
  await page.goto(url(file));
  await page.waitForTimeout(700);
  return { page, errors };
}

const L = (page, sel, prop) => page.$eval(sel, (el, prop) => {
  const c = getComputedStyle(el)[prop];
  const m = c.match(/[\d.]+/g).map(Number);
  return { css: c, l: MidnightFox.color.lightness({ r: m[0], g: m[1], b: m[2] }) };
}, prop);

(async () => {
  const browser = await chromium.launch();

  // Light page gets darkened.
  const { page, errors } = await open(browser, 'light.html', { theme: 'midnight' });
  const status = await page.evaluate(() => window.__onMessage({ type: 'mf-status' }));
  check('light page is darkened', status.active && status.reason === 'auto', JSON.stringify(status));
  check('no script errors', errors.length === 0, errors.join('; '));
  const bodyBg = await L(page, 'html', 'backgroundColor');
  check('page background is dark', bodyBg.l < 0.2, bodyBg.css);
  for (const [sel, prop, test, label] of [
    ['p', 'color', (l) => l > 0.75, 'body text is light'],
    ['.muted', 'color', (l) => l > 0.55, 'muted text readable'],
    ['.card', 'backgroundColor', (l) => l < 0.3, 'card background dark'],
    ['.btn', 'backgroundColor', (l) => l < 0.5, 'primary button darkened'],
    ['.alert', 'color', (l) => l > 0.6, 'alert text light'],
    ['.dark-band', 'color', (l) => l > 0.6, 'dark band text stays light'],
    ['td', 'borderTopColor', (l) => l < 0.5, 'table borders dark'],
    ['input', 'backgroundColor', (l) => l < 0.3, 'input dark'],
    ['#added', 'backgroundColor', (l) => l < 0.3, 'content added later is darkened'],
    ['svg path', 'stroke', (l) => l > 0.6, 'svg icon stroke light']
  ]) {
    const r = await L(page, sel, prop);
    check(label, test(r.l), `${sel} ${prop} = ${r.css}`);
  }
  await page.hover('nav a');
  const hover = await L(page, 'nav a', 'backgroundColor');
  check(':hover rule remapped', hover.l < 0.4, hover.css);
  await page.mouse.move(0, 600);
  await page.screenshot({ path: path.join(OUT, 'light-original-midnight.png') });

  // Switch themes live.
  for (const theme of Object.keys(await page.evaluate(() => MidnightFox.THEMES))) {
    await page.evaluate((t) => window.__setSettings({ theme: t }), theme);
    await page.waitForTimeout(150);
    const bg = await L(page, 'html', 'backgroundColor');
    const fg = await L(page, 'p', 'color');
    check(`theme ${theme}: dark bg + light text`, bg.l < 0.3 && fg.l > 0.7, `${bg.css} / ${fg.css}`);
    await page.screenshot({ path: path.join(OUT, `theme-${theme}.png`) });
  }

  // Site off → restored.
  await page.evaluate(() => window.__setSettings({ sites: { '': 'off' } }));
  await page.waitForTimeout(100);
  const restored = await L(page, 'p', 'color');
  const attrs = await page.$$eval('[data-midnight-fox]', (e) => e.length);
  check('site "Never" restores the page', restored.l < 0.3 && attrs === 0, restored.css);
  await page.screenshot({ path: path.join(OUT, 'light-off.png') });
  await page.close();

  // Text must stay readable even when the page fights back.
  const hostile = await open(browser, 'hostile.html', { theme: 'oled' });
  const ratios = await hostile.page.$$eval('#mail p', (ps) => ps.map((p) => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    let el = p, bg = [0, 0, 0];
    for (; el; el = el.parentElement) {
      const c = parse(getComputedStyle(el).backgroundColor);
      if (c.length < 4 || c[3] > 0.95) { bg = c.slice(0, 3); break; }
    }
    const fg = parse(getComputedStyle(p).webkitTextFillColor);
    const f = { r: fg[0], g: fg[1], b: fg[2] }, b = { r: bg[0], g: bg[1], b: bg[2] };
    return [p.textContent, MidnightFox.color.contrastRatio(f, b)];
  }));
  for (const [text, ratio] of ratios) {
    check(`readable: ${text}`, ratio >= 4.5, `contrast ${ratio.toFixed(2)}`);
  }
  const hues = await hostile.page.evaluate(() => Object.fromEntries(
    ['blue-text', 'navy-text', 'blue-link', 'blue-in-link'].map((id) => {
      const m = getComputedStyle(document.getElementById(id)).color.match(/[\d.]+/g).map(Number);
      return [id, MidnightFox.color.isBlue({ r: m[0], g: m[1], b: m[2] })];
    })));
  check('non-link text is never blue', !hues['blue-text'] && !hues['navy-text'], JSON.stringify(hues));
  check('links stay blue', hues['blue-link'] && hues['blue-in-link'], JSON.stringify(hues));
  await hostile.page.close();

  // Hovered table rows: the highlight must be dark, readable and visible,
  // whatever technique the page uses, and go away when the pointer leaves.
  const tables = await open(browser, 'tables.html', { theme: 'midnight' });
  const cell = (id, row) => tables.page.$eval(`#${id} tr:nth-child(${row}) td:last-child`, (td) => {
    const C = MidnightFox.color;
    const cs = getComputedStyle(td);
    let bg = C.parseColor(cs.backgroundColor);
    if (!bg || bg.a < 0.5) bg = C.parseColor(getComputedStyle(td.parentElement).backgroundColor);
    if (!bg || bg.a < 0.5) bg = C.parseColor(getComputedStyle(document.documentElement).backgroundColor);
    const inset = cs.boxShadow.includes('inset') && C.parseColor((cs.boxShadow.match(/rgba?\([^)]*\)/) || [])[0]);
    if (inset && inset.a > 0.5) bg = inset;
    return { bg: C.toCss(bg), l: C.lightness(bg), ratio: C.contrastRatio(C.parseColor(cs.color), bg) };
  });
  for (const id of ['t-plain', 't-var', 't-external', 't-shadow', 't-anim', 't-js']) {
    await tables.page.hover(`#${id} tr:first-child td:first-child`);
    await tables.page.waitForTimeout(300);
    const on = await cell(id, 1), other = await cell(id, 2);
    check(`row hover (${id}): dark + readable`, on.l < 0.4 && on.ratio >= 4.5, `${on.bg}, contrast ${on.ratio.toFixed(1)}`);
    // A script setting an inline colour looks like any other colour change,
    // so that highlight is remapped like normal content (readable, but faint).
    if (id !== 't-js') {
      check(`row hover (${id}): highlight visible`, Math.abs(on.l - other.l) >= 0.03, `${on.bg} vs ${other.bg}`);
    }
    await tables.page.mouse.move(690, 690);
    await tables.page.waitForTimeout(300);
    const off = await cell(id, 1);
    check(`row hover (${id}): restored on leave`, off.bg === other.bg, `${off.bg} vs ${other.bg}`);
  }
  check('no script errors (tables)', tables.errors.length === 0, tables.errors.join('; '));
  await tables.page.close();

  // Already-dark page is left alone.
  const dark = await open(browser, 'dark.html');
  const ds = await dark.page.evaluate(() => window.__onMessage({ type: 'mf-status' }));
  const touched = await dark.page.$$eval('[data-midnight-fox]', (e) => e.length);
  check('natively dark page left alone', !ds.active && ds.reason === 'native-dark' && touched === 0, JSON.stringify(ds));
  await dark.page.close();

  // "Always" forces it even on a dark page.
  const forced = await open(browser, 'dark.html', { sites: { '': 'on' }, theme: 'sepia' });
  const fs2 = await forced.page.evaluate(() => window.__onMessage({ type: 'mf-status' }));
  check('"Always" forces dark palette', fs2.active && fs2.reason === 'forced', JSON.stringify(fs2));
  await forced.page.close();

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
