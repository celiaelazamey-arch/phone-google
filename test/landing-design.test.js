/**
 * DSN-001 — بوابة انحدار تصميم صفحة الهبوط (Hallmark audit + redesign).
 *
 * هذه البوابة تثبّت العيوب التي كشفها الفحص البصري الحقيقي، لا الشكل العام:
 * LND-01 لا شراب حاجب (eyebrow) فوق العنوان، ولا كلمة متدرّجة اللون داخل العنوان.
 * LND-02 لا رمز تعبيري يُستخدم أيقونةً (كان 🙏 يظهر ▯ في تكديس الخطوط العربي).
 * LND-03 لا مصطلح حقول برمجية (optedIn/aiOptedIn) في نص يقرؤه المستخدم العادي.
 * LND-04 كل لون وخط في landing.css مرمّز في :root، ولا transition: all.
 * LND-05 overflow-x: clip على html وbody معًا (hidden يكسر sticky).
 * LND-06 تباين نص الزر الأساسي ≥ 4.5:1 عند كل محطات تدرّجه (قياس محسوب).
 * LND-07 لقطات الفحص البصري لا تدخل نسخة النشر.
 *
 * الفاحص الأشمل يعمل عبر `npm run design:audit`؛ هذه البوابة تمنع عودة ما أُصلح.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const HTML = read('public/landing.html');
const CSS = read('public/landing.css');

/** كتلة الرموز الأولى في الملف. */
function tokenBlock(css) {
  const start = css.indexOf(':root {');
  assert.ok(start >= 0, 'landing.css defines a :root token block');
  return css.slice(start, css.indexOf('\n}', start));
}

/** ما بعد كتلة الرموز: القواعد التي يجب ألا تحمل قيمًا حرفية. */
function rulesAfterTokens(css) {
  const start = css.indexOf(':root {');
  return css.slice(css.indexOf('\n}', start) + 2);
}

function srgb(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test('LND-01 لا حاجب فوق العنوان ولا كلمة متدرّجة اللون داخله', () => {
  assert.ok(!/class="[^"]*\beyebrow\b/.test(HTML), 'no eyebrow paragraph above a heading');
  assert.ok(!/\.section-eyebrow\s*\{/.test(CSS), 'no dead eyebrow rules left behind');
  // التدرّج على النص كان يلوّن كلمة واحدة داخل العنوان ويُحركها بلا نهاية.
  assert.ok(!/background-clip:\s*text/.test(CSS), 'no gradient-clipped text');
  assert.ok(!/animation:\s*shine/.test(CSS), 'no endless shine animation on a heading');
});

test('LND-02 لا رمز تعبيري يُستخدم أيقونة في صفحة الهبوط', () => {
  // 🙏 كان يُرسم ▯ لأن الخط العربي المستضاف لا يحمل مقاطع Emoji.
  const emoji = [...HTML].filter((c) => {
    const n = c.codePointAt(0);
    return (n >= 0x1f300 && n <= 0x1faff) || (n >= 0x2600 && n <= 0x27bf);
  });
  assert.deepEqual(emoji, [], `emoji used as icons: ${emoji.join(' ')}`);
});

test('LND-03 نص الصفحة لا يخاطب المستخدم العادي بأسماء حقول برمجية', () => {
  for (const field of ['optedIn', 'aiOptedIn']) {
    assert.ok(!HTML.includes(field), `${field} is an internal field name, not reader-facing copy`);
  }
});

test('LND-04 كل لون وخط في القواعد مرمّز، ولا transition: all', () => {
  const rules = rulesAfterTokens(CSS);
  // تُستثنى صور SVG المضمّنة: هي أصل مرسوم لا لون قابل للترميز.
  const withoutDataUris = rules.replace(/url\("data:[^"]*"\)/g, 'url("")');
  const literals = [...withoutDataUris.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `colour literals outside :root: ${literals.slice(0, 5).join(', ')}`);
  for (const [, value] of rules.matchAll(/font-family:\s*([^;{}]+)/g)) {
    assert.ok(value.includes('var('), `font-family must come from a token: ${value.trim()}`);
  }
  assert.ok(!/transition:\s*all\b/.test(CSS), 'name the transitioned properties');
});

test('LND-05 overflow-x: clip على html وbody معًا', () => {
  const html = CSS.match(/^html\s*\{[^}]*\}/m)?.[0] ?? '';
  const body = CSS.match(/^body\s*\{[^}]*\}/m)?.[0] ?? '';
  assert.match(html, /overflow-x:\s*clip/, 'html clips horizontal overflow');
  assert.match(body, /overflow-x:\s*clip/, 'body clips horizontal overflow');
  assert.ok(!/overflow-x:\s*hidden/.test(CSS), 'hidden on body breaks position: sticky');
});

test('LND-06 تباين نص الزر الأساسي ≥ 4.5:1 عند كل محطات التدرّج', () => {
  const tokens = tokenBlock(CSS);
  const ink = tokens.match(/--on-accent:\s*(#[0-9a-fA-F]{3,8})/)?.[1];
  assert.ok(ink, '--on-accent is defined');
  const stops = ['--accent-ink-1', '--accent-ink-2', '--accent-ink-3'].map((name) => {
    const value = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1];
    assert.ok(value, `${name} is defined`);
    return value;
  });
  for (const stop of stops) {
    const ratio = contrast(ink, stop);
    assert.ok(ratio >= 4.5, `button ink on ${stop} is ${ratio.toFixed(2)}:1, below 4.5:1`);
  }
  // الحقل يحتاج حدّه 3:1 على الأقل against ما يحيط به.
  const edge = tokens.match(/--field-edge:\s*(#[0-9a-fA-F]{3,8})/)?.[1];
  assert.ok(edge, '--field-edge is defined');
  assert.ok(contrast(edge, '#1a1c22') >= 3, 'field edge clears 3:1 against its fill');
});

test('LND-07 لقطات الفحص البصري أدوات محلية ولا تدخل نسخة النشر', () => {
  const build = read('scripts/build-pages.mjs');
  assert.match(build, /entry\.name\.startsWith\('\.'\)/, 'build skips dot-directories under public/');
  const ignore = read('.gitignore');
  assert.match(ignore, /public\/\.hallmark\//, 'audit screenshots are git-ignored');
  const dist = path.join(root, 'dist', '.hallmark');
  assert.ok(!fs.existsSync(dist), 'dist never ships audit screenshots');
});
