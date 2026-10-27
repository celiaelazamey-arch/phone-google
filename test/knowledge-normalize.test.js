import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTerms, normalize, normalizeWithMap, queryTerms, snippet, stem, tokenize } from '../src/knowledge/normalize.js';

test('normalize: unifies Arabic letter variants, removes diacritics and tatweel', () => {
  assert.equal(normalize('أَحْمَد'), 'احمد');
  assert.equal(normalize('إبراهيم'), 'ابراهيم');
  assert.equal(normalize('آمال'), 'امال');
  assert.equal(normalize('مُصْطَفَى'), 'مصطفي');
  assert.equal(normalize('مدرسة'), 'مدرسه');
  assert.equal(normalize('مستشفــى'), 'مستشفي');
  assert.equal(normalize('كتاب'), 'كتاب');
  assert.equal(normalize('Google Drive'), 'google drive');
  assert.equal(normalize('١٢٣ ٤٥٦'), '123 456');
  assert.equal(normalize('  فواصل   متعددة  '), 'فواصل متعدده');
});

test('normalize: every normalized character keeps a source offset (snippets stay exact)', () => {
  const input = 'بدأ العمل في مصطفى ٢٠٢٦ مع Google';
  const { text, offsets, source } = normalizeWithMap(input);
  assert.equal(text.length + 1, offsets.length);
  for (let index = 0; index <= text.length; index += 1) {
    const at = offsets[index];
    assert.ok(at >= 0 && at <= source.length, `offset ${index} within source`);
    if (index < text.length && index > 0) assert.ok(at >= offsets[index - 1], 'offsets are monotonic');
  }
});

test('tokenize: removes stopwords, keeps bilingual terms and indexes the article-free stem', () => {
  const tokens = tokenize('الكتاب في المكتبة مع Google Drive');
  assert.ok(tokens.includes('الكتاب'));
  assert.ok(tokens.includes('كتاب'));
  assert.ok(tokens.includes('المكتبه'));
  assert.ok(tokens.includes('مكتبه'));
  assert.ok(tokens.includes('google'));
  assert.ok(!tokens.includes('في'));
  assert.ok(!tokens.includes('مع'), 'stopwords are excluded');
  assert.equal(stem('المشروع'), 'مشروع');
  assert.equal(stem('مشروع'), 'مشروع');
  assert.equal(stem('مال'), 'مال');
});

test('queryTerms: deduplicates and drops stopwords but keeps user intent', () => {
  assert.deepEqual(queryTerms('كيف أربط حساب Google مع التقويم؟'), ['اربط', 'حساب', 'google', 'التقويم']);
  assert.ok(!queryTerms('كيف حالك').includes('كيف'), 'question words are stopwords');
  assert.deepEqual(queryTerms('   '), []);
});

test('expandTerms: Arabic affixes are stripped for recall without inventing words', () => {
  const expanded = expandTerms(['اربط', 'المواعيد', 'إرسال']);
  assert.ok(expanded.includes('اربط'));
  assert.ok(expanded.includes('المواعيد'));
  assert.ok(expanded.includes('مواعيد'), 'definite article removed');
  assert.ok(expandTerms(['الكتابات']).includes('كتاب'), 'sound plural suffix removed down to the stem');
  assert.ok(!expanded.some((term) => term.length < 3), 'no fragments shorter than 3 characters');
  assert.ok(expanded.length <= 3 + 3 * 12, 'expansion stays bounded');
});

test('snippet: cuts real source text around the match and marks truncation', () => {
  const body = 'مقدمة طويلة جدًا عن النظام '.repeat(10) + 'المواعيد في التقويم تحتاج موافقة صريحة قبل الإنشاء' + ' ذيل '.repeat(20);
  const result = snippet(body, ['المواعيد'], { width: 120 });
  assert.ok(result.includes('المواعيد'), 'contains the matched term');
  assert.ok(result.startsWith('…'), 'marks a leading truncation');
  assert.ok(result.length <= 140, 'respects the budget');
  assert.equal(snippet('نص قصير', ['غير-موجود'], { width: 50 }), 'نص قصير');
  assert.equal(snippet('', ['x']), '');
});
