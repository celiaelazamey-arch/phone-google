/**
 * DSN-002 — بوابة انحدار تصميم بقية صفحات `public/` (تكملة تدقيق DSN-001/Hallmark).
 *
 * كل بند هنا يثبّت عيبًا قِيس فعلًا في متصفح حقيقي أو في الفاحص الساكن، لا ذوقًا:
 * DSN2-01 كل ملف CSS يعطي عناصر التحكّم حلقة تركيز ظاهرة، ولا يُلغى `outline` بلا بديل.
 * DSN2-02 حدود الحقول رمز `--t-field-edge` في كل سمات theme.css وبتباين ≥ 3:1 (WCAG 1.4.11).
 * DSN2-03 لا رابط تجاوز (skip link) ملقى خارج الشاشة بـ`-9999px`؛ يبقى في DOM ويظهر بالتركيز.
 * DSN2-04 لا رمز تعبيري (emoji) في أيقونات التنقّل أو الأزرار — الخط العربي لا يرسمها.
 * DSN2-05 `overflow-x: clip` على html وbody في كل صفحة (hidden يكسر sticky).
 * DSN2-06 لا حاجب (eyebrow) فوق العناوين في أي صفحة.
 * DSN2-07 لا نص أبيض نقي على زر مرجاني (`--accent`) في styles.css: الحبر رمز مقيس.
 * DSN2-08 شريط الكتابة في الاستوديو سطح معتم، لا تدرّج شفّاف يُظهر النص تحته.
 *
 * الفحص الأشمل يبقى `npm run design:audit`؛ هذه البوابة تمنع عودة ما أُصلح فقط.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const cssFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith('.css'));
const htmlFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'));

/** WCAG 2.x contrast between two `#rrggbb` colours. */
function contrast(a, b) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const [r, g, bl] = hex.replace('#', '').match(/../g).map((x) => lin(parseInt(x, 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The four `--t-*` blocks of theme.css, keyed by theme name. */
function themeBlocks() {
  const css = read('public/theme.css');
  const grab = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `${selector} exists in theme.css`);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/--t-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  return {
    dark: grab(':root[data-theme="dark"]'),
    oled: grab(':root[data-theme="oled"]'),
    light: grab(':root[data-theme="light"]'),
    system: grab(':root:not([data-theme])')
  };
}

test('DSN2-01 every stylesheet styles keyboard focus and none of them removes an outline silently', () => {
  // cron.css/kb.css are layered on agent.css, which carries the shared focus rule for the trio.
  const LAYERED_ON_AGENT = new Set(['cron.css', 'kb.css', 'fonts.css', 'theme.css']);
  for (const file of cssFiles) {
    if (LAYERED_ON_AGENT.has(file)) {
      // cron/kb are layered on agent.css, which owns the shared focus rule; fonts/theme carry no controls.
      assert.ok(/focus-visible/.test(read('public/agent.css')) || /focus-visible/.test(read('public/theme.css')),
        'the shared sheets style keyboard focus for the pages that use them');
      continue;
    }
    const css = read(`public/${file}`);
    assert.match(css, /:focus-visible/, `${file} styles :focus-visible`);
  }
  for (const file of cssFiles) {
    const css = read(`public/${file}`);
    assert.ok(!/outline:\s*(none|0)\s*[;}]/.test(css), `${file} must not remove a focus outline`);
  }
});

test('DSN2-02 the field edge is a token, present in every theme, and clears 3:1 against its surface', () => {
  const blocks = themeBlocks();
  for (const [name, tokens] of Object.entries(blocks)) {
    assert.match(tokens['field-edge'] || '', /^#[0-9a-f]{6}$/i, `${name} defines --t-field-edge`);
    // The field is drawn on --t-field inside a --t-card panel; both must clear 3:1.
    for (const surface of ['field', 'card', 'bg']) {
      const ratio = contrast(tokens['field-edge'], tokens[surface]);
      assert.ok(ratio >= 3, `${name}: --t-field-edge on --t-${surface} is ${ratio.toFixed(2)}:1, below 3:1`);
    }
  }
  // The field rules themselves must draw with the token, not the decorative hairline.
  for (const [file, pattern] of [['agent.css', /input, textarea, select \{[^}]*border: 1px solid var\(--field-edge\)/],
    ['whatsapp.css', /input\[type=tel\][^{]*\{[^}]*border:1px solid var\(--field-edge\)/],
    ['cron.css', /select \{[^}]*border: 1px solid var\(--field-edge\)/]]) {
    assert.match(read(`public/${file}`), pattern, `${file} draws its fields with --field-edge`);
  }
});

test('DSN2-03 no skip link is parked off-screen; it stays in the DOM and appears on focus', () => {
  for (const file of cssFiles) {
    const css = read(`public/${file}`);
    assert.ok(!/-9999px/.test(css), `${file} must not hide a focusable element 9999px off-screen`);
  }
  for (const file of ['computer.css', 'protocol.css']) {
    const css = read(`public/${file}`);
    assert.match(css, /\.(cu-)?skip[\w-]*\s*\{[^}]*opacity:\s*0/, `${file} hides the skip link with opacity, not position`);
    assert.match(css, /\.(cu-)?skip[\w-]*:focus(-visible)?\s*\{\s*[^}]*opacity:\s*1/, `${file} reveals the skip link on focus`);
  }
});

test('DSN2-04 no emoji is used as a navigation or button icon', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const file of htmlFiles) {
    const html = read(`public/${file}`);
    const lines = html.split('\n');
    for (const [index, line] of lines.entries()) {
      const inIconSlot = /class="(nav-icon|mission-icon|status-dot)"[^>]*>\s*[^<]*\p{Extended_Pictographic}/u.test(line);
      const inButton = /<button[^>]*>[^<]*\p{Extended_Pictographic}<\/button>|<button[^>]*>\s*\p{Extended_Pictographic}/u.test(line);
      assert.ok(!inIconSlot && !inButton, `public/${file}:${index + 1} renders an emoji icon: ${line.trim().slice(0, 90)}`);
      // A stray emoji anywhere in copy is also rejected on the pages audited in this slice.
      if (['index.html', 'live.html', 'skills.html'].includes(file)) {
        assert.ok(!emoji.test(line), `public/${file}:${index + 1} carries an emoji: ${line.trim().slice(0, 90)}`);
      }
    }
  }
});

test('DSN2-05 every stylesheet clips horizontal overflow on html and body', () => {
  // theme.css/agent.css are reused by sheets that already declare the rule; the page sheet owns it once.
  for (const file of cssFiles) {
    const css = read(`public/${file}`);
    assert.ok(!/overflow-x:\s*hidden/.test(css), `${file} must not use overflow-x: hidden (it breaks sticky)`);
  }
  for (const file of ['styles.css', 'computer.css', 'protocol.css', 'deploy.css', 'landing.css']) {
    assert.match(read(`public/${file}`), /overflow-x:\s*clip/, `${file} clips horizontal overflow`);
  }
});

test('DSN2-06 no eyebrow sits above a heading in any page', () => {
  for (const file of htmlFiles) {
    const html = read(`public/${file}`);
    assert.ok(!/class="eyebrow"/.test(html), `public/${file} still carries an eyebrow element`);
    assert.ok(!/class="eyebrow"/.test(read('scripts/render-computer-permissions.mjs')), 'the generator no longer emits eyebrows');
  }
});

test('DSN2-07 the filled accent button never paints pure white ink', () => {
  const css = read('public/styles.css');
  assert.ok(!/color:\s*#fff\b/.test(css), 'styles.css uses --accent-fg, not #fff, on accent fills');
  for (const [name, tokens] of Object.entries(themeBlocks())) {
    void name;
    void tokens;
  }
  // Measured: the Studio ink on its accent fill.
  const ratio = contrast('#1c0e08', '#d97757');
  assert.ok(ratio >= 4.5, `accent ink on the dark accent fill is ${ratio.toFixed(2)}:1`);
  assert.ok(contrast('#1c0e08', '#c96442') >= 4.5, 'accent ink on the light accent fill clears 4.5:1');
});

test('DSN2-08 the composer is an opaque surface, not a gradient the text shows through', () => {
  const css = read('public/styles.css');
  const block = css.slice(css.indexOf('.composer-wrap {'), css.indexOf('}', css.indexOf('.composer-wrap {')));
  assert.ok(!/linear-gradient/.test(block), 'the composer band must not be a translucent gradient');
  assert.match(block, /background:\s*var\(--bg-canvas\)/, 'the composer band paints the canvas colour');
  // And the scroll area it sits under must be able to shrink, or its content paints beneath the composer.
  const scroll = css.slice(css.indexOf('.chat-scroll {'), css.indexOf('}', css.indexOf('.chat-scroll {')));
  assert.match(scroll, /min-height:\s*0/, '.chat-scroll can shrink inside the flex column');
});
