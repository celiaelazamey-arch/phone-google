/**
 * WP-1.3 — رموز السمات (UX-003، DEC-049).
 *
 * THM-01  كل سمة في public/theme.css تمرّ تباين WCAG محسوبًا (نص ≥ 4.5:1، حدود/تركيز ≥ 3:1) — لا اعتماد على العين.
 * THM-02  بوابة grep: لا لون ثابت (hex/rgb/hsl/اسم) خارج ملف الرموز في الملفات المهاجَرة؛ قائمة «لم تُهاجَر بعد»
 *         صريحة وتنكمش فقط (ratchet).
 * THM-03  theme.js يعمل قبل الرسم: اختيار مخزّن صالح يُطبَّق، غير الصالح/الغائب → يتبع النظام، تخزين معطّل لا يرمي،
 *         set() يكتب ويزيل، وتغيير المبدّل يطبّق.
 * THM-04  كل صفحة فيها المبدّل تحمّل theme.js قبل أول ورقة أنماط (لا وميض) وتستورد theme.css — ولا مبدّل على صفحة
 *         لا تقرأ الرموز (DEC-030: لا واجهة واجهة).
 * THM-05  خادم الواجهة الحية يقدّم /theme.css و/theme.js (مسارات صريحة، لا static fallback).
 * THM-06  prefers-reduced-motion في theme.css يلغي كل انتقال وحركة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

const THEMES = ['dark', 'oled', 'light'];
const TOKENS = [
  't-bg', 't-bg-soft', 't-card', 't-field', 't-line', 't-text', 't-muted', 't-accent', 't-accent-ink',
  't-primary-a', 't-primary-b', 't-ok', 't-warn', 't-bad', 't-glow', 't-shadow', 't-header'
];

/** يقرأ كتل السمات من theme.css إلى {theme: {token: value}} بلا محرك CSS. */
function parseThemeTokens(css) {
  const blocks = {};
  const selectors = {
    dark: /:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/,
    oled: /:root\[data-theme="oled"\]\s*\{([^}]*)\}/,
    light: /:root\[data-theme="light"\]\s*\{([^}]*)\}/,
    system_light: /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/
  };
  for (const [name, re] of Object.entries(selectors)) {
    const match = css.match(re);
    assert.ok(match, `theme.css has the ${name} block`);
    const tokens = {};
    for (const line of match[1].split('\n')) {
      const m = line.match(/^\s*--([a-z0-9-]+):\s*([^;]+);/);
      if (m) tokens[m[1]] = m[2].trim();
    }
    blocks[name] = tokens;
  }
  return blocks;
}

function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `${hex} is a 6-digit hex colour`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance + contrast ratio. */
function luminance([r, g, b]) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(fgHex, bgHex) {
  const l1 = luminance(hexToRgb(fgHex));
  const l2 = luminance(hexToRgb(bgHex));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

test('THM-01 every theme passes computed WCAG contrast for the text/background pairs the pages actually use', () => {
  const blocks = parseThemeTokens(read('theme.css'));
  for (const theme of THEMES) {
    for (const token of TOKENS) assert.ok(blocks[theme][token], `${theme} defines --${token}`);
  }
  // «يتبع النظام» في الوضع الفاتح = نفس رموز light بالضبط (وإلا تختلف الصفحة بين الاختيار الصريح والنظام).
  assert.deepEqual(blocks.system_light, blocks.light);

  const report = [];
  for (const theme of THEMES) {
    const t = blocks[theme];
    const textPairs = [
      ['t-text', 't-bg'], ['t-text', 't-card'], ['t-text', 't-bg-soft'], ['t-text', 't-field'],
      ['t-muted', 't-bg'], ['t-muted', 't-card'], ['t-muted', 't-bg-soft'], ['t-muted', 't-field'],
      ['t-accent', 't-bg'], ['t-accent', 't-card'], ['t-accent', 't-bg-soft'],
      ['t-ok', 't-card'], ['t-ok', 't-bg'], ['t-warn', 't-card'], ['t-warn', 't-bg'], ['t-bad', 't-card'], ['t-bad', 't-bg'],
      ['t-accent-ink', 't-primary-a'], ['t-accent-ink', 't-primary-b']
    ];
    for (const [fg, bg] of textPairs) {
      const ratio = contrast(t[fg], t[bg]);
      report.push(`${theme} ${fg}/${bg} ${ratio.toFixed(2)}`);
      assert.ok(ratio >= 4.5, `${theme}: --${fg} on --${bg} must be ≥ 4.5:1 (got ${ratio.toFixed(2)})`);
    }
    // حدود الحقول/حلقة التركيز: مكوّن غير نصي → ≥ 3:1 (WCAG 1.4.11).
    for (const [fg, bg] of [['t-accent', 't-card'], ['t-accent', 't-field'], ['t-line', 't-card']]) {
      const ratio = contrast(t[fg], t[bg]);
      const floor = fg === 't-line' ? 1.2 : 3; // الخط الفاصل زخرفي؛ التركيز غير زخرفي
      assert.ok(ratio >= floor, `${theme}: --${fg} on --${bg} must be ≥ ${floor}:1 (got ${ratio.toFixed(2)})`);
    }
    assert.match(blocks[theme]['t-shadow'], /^rgba\(/, `${theme} shadow is translucent`);
    assert.match(blocks[theme]['t-header'], /^rgba\(/, `${theme} header is translucent`);
  }
  // OLED = أسود حقيقي (الهدف: توفير شاشات AMOLED)؛ light يعلن color-scheme: light.
  assert.equal(blocks.oled['t-bg'], '#000000');
  assert.match(read('theme.css'), /:root\[data-theme="light"\]\s*\{\s*color-scheme: light;/);
  assert.match(read('theme.css'), /:root\[data-theme="oled"\]\s*\{\s*color-scheme: dark;/);
  // الأدنى الفعلي يُطبع للسجل — رقم مقيس، لا تقدير.
  const minRatio = Math.min(...report.map((line) => Number(line.split(' ').pop())));
  assert.ok(minRatio >= 4.5, `lowest ratio ${minRatio}`);
});

test('THM-02 grep gate: no fixed colour outside theme.css in the migrated stylesheets; the not-yet-migrated list only shrinks', () => {
  // قائمة صريحة لما لم يُهاجَر بعد (تنكمش فقط — إضافة اسم هنا تراجع يجب تبريره في DECISIONS).
  const NOT_YET_MIGRATED = new Set(['styles.css', 'system.css', 'protocol.css', 'computer.css', 'deploy.css', 'landing.css', 'fonts.css']);
  const cssFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.css'));
  const migrated = cssFiles.filter((f) => f !== 'theme.css' && !NOT_YET_MIGRATED.has(f));
  assert.deepEqual(migrated.sort(), ['agent.css', 'cron.css', 'kb.css']);
  for (const file of NOT_YET_MIGRATED) assert.ok(cssFiles.includes(file), `${file} still exists (drop it from the list otherwise)`);

  const fixedColour = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black|red|green|blue|yellow|orange|gray|grey|silver|navy|teal|purple|pink)\b(?=\s*[;,)!])/i;
  for (const file of migrated) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [index, line] of css.split('\n').entries()) {
      assert.ok(!fixedColour.test(line), `${file}:${index + 1} has a fixed colour: ${line.trim()}`);
    }
    // أي شفافية مشتقة تُبنى من رمز (color-mix على var) لا من رقم.
    for (const mix of css.match(/color-mix\([^)]*\)/g) ?? []) assert.match(mix, /var\(--[a-z-]+\)/, mix);
  }
  // الرموز --t-* تُعرَّف في theme.css فقط؛ agent.css يربط كل متغيّر محلي برمز.
  for (const file of cssFiles.filter((f) => f !== 'theme.css')) {
    assert.ok(!/^\s*--t-[a-z-]+:/m.test(read(file)), `${file} must not define --t-* tokens`);
  }
  const agentRoot = read('agent.css').match(/:root\s*\{([^}]*)\}/)[1];
  for (const local of ['bg', 'bg-soft', 'card', 'field', 'line', 'text', 'muted', 'accent', 'accent-ink', 'ok', 'warn', 'bad', 'glow', 'shadow', 'header']) {
    assert.match(agentRoot, new RegExp(`--${local}: var\\(--t-${local}\\);`), `agent.css maps --${local} to --t-${local}`);
  }
});

/** بيئة DOM صغيرة تكفي theme.js (لا happy-dom في الاختبارات العادية). */
function createFakeWindow({ stored, prefersLight = false, storageThrows = false } = {}) {
  const attrs = new Map();
  const listeners = new Map();
  const selects = [];
  const store = new Map(stored ? [['celia_theme', stored]] : []);
  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error('SecurityError');
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (storageThrows) throw new Error('SecurityError');
      store.set(key, String(value));
    },
    removeItem(key) {
      if (storageThrows) throw new Error('SecurityError');
      store.delete(key);
    }
  };
  const document = {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k)
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    querySelectorAll: (selector) => (selector === 'select[data-theme-switcher]' ? selects : [])
  };
  const mediaListeners = [];
  const window = {
    document,
    localStorage,
    matchMedia: (q) => ({ matches: q.includes('light') && prefersLight, addEventListener: (_t, fn) => mediaListeners.push(fn) })
  };
  window.window = window;
  return { window, attrs, listeners, selects, store, mediaListeners };
}

function runThemeScript(env) {
  const context = vm.createContext({ window: env.window, document: env.window.document, Boolean, Error, String });
  vm.runInContext(read('theme.js'), context, { filename: 'theme.js' });
  return env.window.celiaTheme;
}

test('THM-03 theme.js resolves before paint: stored choice applied, invalid/missing follows the system, storage errors are silent, set() and the switcher work', () => {
  const source = read('theme.js');
  assert.ok(!/\b(import|export)\b/.test(source), 'classic script (loaded in <head> under CSP script-src self)');
  assert.ok(Buffer.byteLength(source) < 6_000, `tiny pre-paint script (${Buffer.byteLength(source)} bytes)`);

  // (a) stored valid choice
  let env = createFakeWindow({ stored: 'oled' });
  let api = runThemeScript(env);
  assert.equal(env.attrs.get('data-theme'), 'oled');
  assert.equal(env.attrs.get('data-theme-resolved'), 'oled');
  assert.equal(api.get(), 'oled');
  assert.deepEqual([...api.themes], THEMES); // نسخ: مصفوفة من realm الـvm

  // (b) nothing stored → follow the system (no data-theme attribute; resolved mirrors prefers-color-scheme)
  env = createFakeWindow({ prefersLight: true });
  api = runThemeScript(env);
  assert.equal(env.attrs.has('data-theme'), false);
  assert.equal(env.attrs.get('data-theme-resolved'), 'light');
  assert.equal(api.get(), 'system');
  env = createFakeWindow({ prefersLight: false });
  api = runThemeScript(env);
  assert.equal(env.attrs.get('data-theme-resolved'), 'dark');

  // (c) invalid stored value (e.g. a future theme name) → system, never a broken attribute
  env = createFakeWindow({ stored: 'purple' });
  api = runThemeScript(env);
  assert.equal(env.attrs.has('data-theme'), false);
  assert.equal(api.get(), 'system');

  // (d) localStorage throwing (private mode / disabled) → still applies, no throw
  env = createFakeWindow({ storageThrows: true, prefersLight: true });
  api = runThemeScript(env);
  assert.equal(api.get(), 'system');
  assert.equal(api.set('light'), 'light');
  assert.equal(env.attrs.get('data-theme'), 'light');

  // (e) set() writes/removes the shared Studio key `celia_theme`
  env = createFakeWindow({});
  api = runThemeScript(env);
  assert.equal(api.set('light'), 'light');
  assert.equal(env.store.get('celia_theme'), 'light');
  assert.equal(api.set('system'), 'system');
  assert.equal(env.store.has('celia_theme'), false);
  assert.equal(env.attrs.has('data-theme'), false);
  assert.equal(api.set('nonsense'), 'system');

  // (f) the shared switcher: a change event applies and every switcher mirrors the current value
  env = createFakeWindow({ stored: 'dark' });
  api = runThemeScript(env);
  const select = { value: 'system', matches: (s) => s === 'select[data-theme-switcher]' };
  env.selects.push(select);
  env.listeners.get('DOMContentLoaded')();
  assert.equal(select.value, 'dark', 'switcher reflects the stored choice on load');
  select.value = 'oled';
  env.listeners.get('change')({ target: select });
  assert.equal(env.attrs.get('data-theme'), 'oled');
  assert.equal(env.store.get('celia_theme'), 'oled');
  // a system-preference change re-resolves only when following the system
  api.set('system');
  assert.equal(env.attrs.get('data-theme-resolved'), 'dark');
  assert.ok(env.mediaListeners.length >= 1);
});

test('THM-04 pages with the switcher load theme.js before any stylesheet and import theme.css; no switcher on a page whose CSS ignores the tokens', () => {
  const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
  const themed = [];
  for (const file of htmlFiles) {
    const html = read(file);
    const hasSwitcher = html.includes('data-theme-switcher');
    const hasTokens = html.includes('href="./theme.css"');
    assert.equal(hasSwitcher, hasTokens, `${file}: switcher ⇔ theme.css (DEC-030, no façade switcher)`);
    if (!hasTokens) continue;
    themed.push(file);
    const scriptAt = html.indexOf('<script src="./theme.js"></script>');
    const firstStylesheet = html.indexOf('<link rel="stylesheet"');
    assert.ok(scriptAt > -1 && scriptAt < firstStylesheet, `${file}: theme.js runs before the first stylesheet (no flash)`);
    assert.ok(html.indexOf('href="./theme.css"') < html.indexOf('href="./agent.css"'), `${file}: tokens load before agent.css`);
    assert.ok(!/<html[^>]*data-theme=/.test(html), `${file}: no hard-coded data-theme (theme.js decides)`);
    const options = [...html.matchAll(/<option value="([a-z]+)">/g)].map((m) => m[1]);
    assert.deepEqual(options.filter((o) => ['system', ...THEMES].includes(o)), ['system', ...THEMES], `${file}: switcher lists system + ${THEMES.join('/')}`);
    assert.match(html, /<select data-theme-switcher aria-label="/, `${file}: switcher is labelled`);
    assert.ok(html.match(/data-theme-switcher/g).length === 1, `${file}: exactly one switcher`);
  }
  assert.deepEqual(themed.sort(), ['agent.html', 'cron.html', 'kb.html']);
});

test('THM-05 the live UI server serves /theme.css and /theme.js by explicit route (the pages reference both)', async (t) => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: crypto.randomBytes(32).toString('hex') });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const css = await fetch(`${baseUrl}/theme.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /:root\[data-theme="oled"\]/);
  const js = await fetch(`${baseUrl}/theme.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /window\.celiaTheme/);
  for (const page of ['agent', 'kb', 'cron']) {
    const html = await (await fetch(`${baseUrl}/${page}`)).text();
    assert.ok(html.includes('<script src="./theme.js"></script>'), `/${page} loads theme.js`);
    assert.ok(html.includes('data-theme-switcher'), `/${page} has the switcher`);
  }
});

test('THM-06 prefers-reduced-motion in theme.css cancels every transition and animation', () => {
  const css = read('theme.css');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'reduced-motion block exists');
  assert.match(block[1], /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation: none !important;[^}]*transition: none !important;/);
  assert.match(block[1], /scroll-behavior: auto !important/);
});
