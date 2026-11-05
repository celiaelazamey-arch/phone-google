/**
 * L1 — لوحات الواجهة الثلاث: سجل المحادثات (U2) · صندوق المهام (U5) · معاينة المخرجات (U3).
 *
 * الوحدة نقية (`public/agent-console.js`) فلا تحتاج DOM ولا متصفحًا ولا شبكة، وتُختبر
 * هنا في Node. كل بند يثبّت قاعدة من الثلاث الحاكمة: لا اختراع، لا تلطيف، لا حقن.
 * الطفرات السلبية مكتوبة صراحةً: ما الذي يجب أن يفشل لو كُسر الثابت.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';

import {
  CONSOLE_VERSION,
  MESSAGE_MAX_CHARS,
  PREVIEWABLE_EXTENSIONS,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_CSV_ROWS,
  PREVIEW_REFUSALS,
  REFUSED_EXTENSIONS,
  ROLE_LABELS,
  SEVERITY_LABELS,
  THREAD_LIST_LIMIT,
  escapeHtml,
  filterThreads,
  groupAttention,
  previewKind,
  renderCsvPreview,
  renderInbox,
  renderMarkdownPreview,
  renderTextPreview,
  renderThreadDetail,
  renderThreadList,
  shortHash,
  waitingLabel
} from '../public/agent-console.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const thread = (id, title, status = 'active', updatedAt = '2026-11-05T10:00:00.000Z') => ({
  id, title, status, updatedAt, createdAt: updatedAt, ownerId: 'owner'
});

/* ── L1-01: الهرم يُهرَّب — لا عنوان ولا بادئة تُحقن من بيانات الخادم ─────────── */
test('L1-01 every value that reaches the page is escaped first', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
  assert.equal(escapeHtml(null), '');

  const list = renderThreadList({ threads: [thread('id-1', '"><script>alert(1)</script>')], activeThreadId: null });
  assert.ok(!list.html.includes('<script>'), 'a title cannot inject a script tag');
  assert.ok(list.html.includes('&lt;script&gt;'), 'the title is shown escaped, not dropped');

  const detail = renderThreadDetail({
    thread: thread('id-1', 't'),
    messages: [{ id: 'm1', role: 'user', content: '<svg onload=alert(1)>', createdAt: '2026-11-05T10:00:00.000Z' }],
    runs: []
  });
  assert.ok(!detail.includes('<svg'), 'message content is escaped');
  assert.ok(detail.includes('&lt;svg'), 'and still visible to the owner');
});

/* ── L1-02: لا اختراع — بلا سجل لا رسم، والحالات الفارغة صادقة ───────────────── */
test('L1-02 empty and missing states are stated, never filled with invented rows', () => {
  const none = renderThreadList({ threads: [], activeThreadId: null });
  assert.equal(none.total, 0);
  assert.match(none.html, /لا خيوط محفوظة بعد/);

  assert.match(renderThreadDetail({ thread: null }), /اختر خيطًا/);
  const bare = renderThreadDetail({ thread: thread('id-1', 'مهمة'), messages: [], runs: [] });
  assert.match(bare, /لا رسالة محفوظة/);
  assert.match(bare, /لا تشغيل في هذا الخيط/);

  const inbox = renderInbox({ total: 0, items: [] });
  assert.match(inbox.html, /لا شيء ينتظرك الآن/);
  assert.equal(inbox.view.total, 0);
});

/* ── L1-03: حدّ الخادم معلن — التصفية محلية في ما حُمِّل، لا «بحث في كل شيء» ─── */
test('L1-03 the thread list states the server limit and filters only what was loaded', () => {
  assert.equal(THREAD_LIST_LIMIT, 20, 'the UI advertises the limit listThreads actually applies');
  const threads = [thread('aaaa-1', 'تقرير المبيعات'), thread('bbbb-2', 'مراجعة النظام')];
  const all = filterThreads({ threads, query: '' });
  assert.equal(all.shown, 2);
  assert.equal(all.filtered, false);
  assert.deepEqual(all.items.map((item) => item.matched), ['all', 'all']);

  const byTitle = filterThreads({ threads, query: 'مبيعات' });
  assert.equal(byTitle.shown, 1);
  assert.equal(byTitle.items[0].matched, 'title');
  assert.equal(byTitle.filtered, true);

  const byId = filterThreads({ threads, query: 'BBBB' });
  assert.equal(byId.shown, 1, 'id matching is case-insensitive');
  assert.equal(byId.items[0].matched, 'id');

  const miss = renderThreadList({ threads, query: 'لا شيء' });
  assert.equal(miss.shown, 0);
  assert.match(miss.html, /لا خيط يطابق/, 'a miss says so instead of showing an empty box');
  assert.match(miss.html, /ضمن آخر 2 خيطًا محمّلًا/, 'and names the loaded scope');

  const injected = renderThreadList({ threads, query: '<b>' });
  assert.ok(!injected.html.includes('<b>'), 'the query itself is escaped in the miss message');
});

/* ── L1-04: الخيط النشط معلَّم، والحالة مجهولة تُعرض كما هي ───────────────────── */
test('L1-04 the active thread is marked and an unstated status is shown verbatim', () => {
  const html = renderThreadList({
    threads: [thread('aaaa-1', 'أ', 'active'), thread('bbbb-2', 'ب', 'weird_status')],
    activeThreadId: 'bbbb-2'
  }).html;
  assert.match(html, /aria-current="true"/);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1, 'exactly one thread is current');
  assert.match(html, /weird_status/, 'an unknown status is printed, not silently mapped to "نشط"');
});

/* ── L1-05: الرسائل تُقتطع للعرض مع إعلان الاقتطاع — النص الكامل يبقى في السجل ── */
test('L1-05 long message content is truncated for display and says so', () => {
  const long = 'x'.repeat(MESSAGE_MAX_CHARS + 50);
  const detail = renderThreadDetail({
    thread: thread('id-1', 't'),
    messages: [{ id: 'm1', role: 'user', content: long, createdAt: '2026-11-05T10:00:00.000Z' }],
    runs: []
  });
  assert.match(detail, /مقتطع للعرض — النص الكامل في السجل/);
  assert.ok(!detail.includes('x'.repeat(MESSAGE_MAX_CHARS + 1)), 'the DOM does not carry the whole payload');

  const short = renderThreadDetail({
    thread: thread('id-1', 't'),
    messages: [{ id: 'm1', role: 'user', content: 'قصير', createdAt: '2026-11-05T10:00:00.000Z' }],
    runs: []
  });
  assert.ok(!short.includes('مقتطع للعرض'), 'a short message carries no truncation claim');
  assert.match(short, /أنت/, 'the owner role is labelled in Arabic');
  assert.match(renderThreadDetail({
    thread: thread('id-1', 't'),
    messages: [{ id: 'm1', role: 'ghost_role', content: 'x', createdAt: '' }],
    runs: []
  }), /ghost_role/, 'an unlabelled role is printed, not invented');
});

/* ── L1-06: تشغيلات الخيط أول 10 مع إعلان الباقي — لا قائمة تدّعي الكمال ──────── */
test('L1-06 thread runs are capped for display and the remainder is announced', () => {
  const runs = Array.from({ length: 13 }, (_unused, index) => ({
    id: `run-${index}`, status: index === 0 ? 'succeeded' : 'failed', planSummary: `خطة ${index}`
  }));
  const detail = renderThreadDetail({ thread: thread('id-1', 't'), messages: [], runs });
  assert.equal((detail.match(/run-open/g) || []).length, 10, 'ten buttons, not thirteen');
  assert.match(detail, /و3 تشغيلًا آخر في السجل/, 'and the other three are named, not hidden');
  assert.match(detail, /نُفذ/);
  assert.match(detail, /فشل/);

  const unknown = renderThreadDetail({ thread: thread('id-1', 't'), messages: [], runs: [{ id: 'r', status: 'odd' }] });
  assert.match(unknown, /odd/, 'an unknown run status is printed verbatim');
});

/* ── L1-07: لا تلطيف — التجميع يحفظ ترتيب الخادم وشدّته وبصمته حرفيًا ─────────── */
test('L1-07 the inbox groups without re-ranking, softening or dropping', () => {
  const queue = {
    version: '1',
    now: '2026-11-05T10:00:00.000Z',
    total: 3,
    counts: { decision: 1, ambiguous: 1, info: 1 },
    owed: 2,
    clear: false,
    sends: false,
    tracksRead: false,
    digest: 'abc123def456',
    dropped: [],
    items: [
      { id: 'run:r1', reason: 'approval_pending', severity: 'decision', ar: 'موافقة تنتظر قرارك', en: 'an approval is waiting', next: 'decide', evidence: { approvalId: 'a1' }, waitingMs: 180_000 },
      { id: 'run:r2', reason: 'outbox_unknown', severity: 'ambiguous', ar: 'أثر غير محسوم', en: 'unresolved', next: 'reconcile', evidence: {} },
      { id: 'run:r3', reason: 'run_succeeded', severity: 'info', ar: 'تشغيل اكتمل', en: 'completed', next: 'none', evidence: {} }
    ]
  };
  const view = groupAttention(queue);
  assert.deepEqual(view.groups.map((group) => group.severity), ['decision', 'ambiguous', 'info'], 'server order survives grouping');
  assert.deepEqual(view.groups.map((group) => group.items.length), [1, 1, 1]);
  assert.equal(view.total, 3);
  assert.equal(view.owed, 2);
  assert.equal(view.digest, 'abc123def456', 'the digest is carried, not recomputed locally');
  assert.equal(view.sends, false);
  assert.equal(view.tracksRead, false);

  const rendered = renderInbox(queue);
  assert.match(rendered.html, /قرار مطلوب · 1/);
  assert.match(rendered.html, /run:r1/, 'every item keeps its evidence id');
  assert.match(rendered.html, /approvalId=a1/);
  assert.match(rendered.html, /منتظر 3 دقيقة/);
  // زمن الانتظار يُقال لصاحب القرار: أقل من دقيقة تُسمّى كذلك، ولا تُلفَّف إلى «0 دقيقة».
  assert.equal(waitingLabel(180_000), '3 دقيقة');
  assert.equal(waitingLabel(59_999), 'أقل من دقيقة');
  assert.equal(waitingLabel(3_000), 'أقل من دقيقة');
  assert.equal(waitingLabel(0), null, 'zero is not a wait');
  assert.equal(waitingLabel(-5), null, 'a negative wait is not dressed as a fresh item');
  assert.equal(waitingLabel(Number.NaN), null);
  assert.equal(waitingLabel(90_000), '2 دقيقة', 'rounded to the nearest minute, stated as such');
  const subMinute = renderInbox({ total: 1, items: [{ id: 'x', reason: 'r', severity: 'info', ar: 'بند', en: 'i', waitingMs: 3_000 }] }).html;
  assert.match(subMinute, /منتظر أقل من دقيقة/);
  assert.ok(!subMinute.includes('منتظر 0 دقيقة'), 'the wording CI caught never returns');
  assert.ok(!rendered.html.includes('>none<'), 'a "none" next-step is not rendered as an action');
  assert.equal(rendered.view.items === undefined, true, 'the view is a grouping, not a rewritten queue');

  // طفرة سلبية: بند ناقص في المدخل يظهر ناقصًا في المخرج — لا يُستكمل من عندنا.
  const partial = groupAttention({ total: 2, items: [queue.items[0]] });
  assert.equal(partial.groups[0].items.length, 1);
  assert.equal(partial.total, 2, 'the server total is reported even when items are fewer — no silent agreement');
});

/* ── L1-08: تسميات الشدة من الخادم — لا شدة مخترعة ولا ثامنة ──────────────────── */
test('L1-08 severity labels cover exactly the four the queue emits', () => {
  assert.deepEqual(Object.keys(SEVERITY_LABELS).sort(), ['ambiguous', 'decision', 'failure', 'info']);
  const odd = renderInbox({ total: 1, items: [{ id: 'x', reason: 'r', severity: 'cosmic', ar: 'بند', en: 'item' }] }).html;
  assert.match(odd, /cosmic/, 'an unstated severity is printed as-is rather than dressed as info');
  assert.deepEqual(Object.keys(ROLE_LABELS).sort(), ['assistant', 'system', 'tool', 'user']);
});

/* ── L1-09: قرار المعاينة من السجل قبل أي جلب — الحجم والاسم وحدهما ────────────── */
test('L1-09 the preview decision is taken from the record, before any fetch', () => {
  assert.deepEqual(previewKind({ name: 'report.md', bytes: 1024 }), { mode: 'markdown', reason: null, extension: 'md', bytes: 1024 });
  assert.equal(previewKind({ name: 'NOTES.MARKDOWN', bytes: 10 }).mode, 'markdown', 'the extension read is case-insensitive');
  assert.equal(previewKind({ name: 'table.csv', bytes: 10 }).mode, 'csv');
  assert.equal(previewKind({ name: 'log.txt', bytes: 10 }).mode, 'text');
  assert.equal(previewKind({ name: 'data.json', bytes: 10 }).mode, 'text');

  for (const extension of REFUSED_EXTENSIONS) {
    const decision = previewKind({ name: `page.${extension}`, bytes: 10 });
    assert.equal(decision.mode, 'refused', `${extension} must never be rendered`);
    assert.equal(decision.reason, 'html_not_rendered');
  }
  assert.equal(previewKind({ name: 'archive.zip', bytes: 10 }).reason, 'type_not_previewable');
  assert.equal(previewKind({ name: 'noextension', bytes: 10 }).reason, 'name_has_no_extension');
  assert.equal(previewKind({ name: 'big.md', bytes: PREVIEW_MAX_BYTES + 1 }).reason, 'too_large_for_preview');
  assert.equal(previewKind({ name: 'zero.md', bytes: 0 }).reason, 'unknown_size');
  assert.equal(previewKind({ name: 'nan.md', bytes: Number.NaN }).reason, 'unknown_size');

  // كل رفض له سطر عربي مسمّى — لا صمت ولا «تعذّر» عامة.
  for (const reason of ['html_not_rendered', 'type_not_previewable', 'too_large_for_preview', 'unknown_size', 'name_has_no_extension', 'fetch_failed', 'digest_mismatch']) {
    assert.ok(typeof PREVIEW_REFUSALS[reason] === 'string' && PREVIEW_REFUSALS[reason].length > 10, reason);
  }
  assert.ok(PREVIEWABLE_EXTENSIONS.md === 'markdown' && PREVIEWABLE_EXTENSIONS.csv === 'csv');
});

/* ── L1-10: Markdown subset مغلق — هرم أولًا، ثم أربع قواعد ضيقة فقط ──────────── */
test('L1-10 markdown preview escapes everything then applies a closed subset', () => {
  const rendered = renderMarkdownPreview('# عنوان\n\nنص **عريض** و`شفرة`\n\n- بند أول\n- بند ثاني\n');
  assert.ok(!rendered.html.includes('<h1>'), 'a source heading can never outrank the panel heading');
  assert.match(rendered.html, /<h4>عنوان<\/h4>/, 'h1 is shifted to h4');
  assert.match(rendered.html, /<strong>عريض<\/strong>/);
  assert.match(rendered.html, /<code>شفرة<\/code>/);
  assert.equal((rendered.html.match(/<li>/g) || []).length, 2);
  assert.equal(rendered.truncated, false);

  const hostile = renderMarkdownPreview('<script>alert(1)</script>\n\n**<img src=x>**');
  assert.ok(!hostile.html.includes('<script>'));
  assert.ok(!hostile.html.includes('<img'));
  assert.match(hostile.html, /&lt;script&gt;/);

  const huge = renderMarkdownPreview('y'.repeat(70_000));
  assert.equal(huge.truncated, true, 'the display ceiling is stated, not silently applied');
  assert.equal(renderMarkdownPreview('').html, '');
});

/* ── L1-11: CSV — خلايا مُهرَّبة، اقتباسات صحيحة، وسقف صفوف معلن ──────────────── */
test('L1-11 csv preview escapes cells, honours quotes and caps rows', () => {
  const table = renderCsvPreview('الاسم,القيمة\n"دوسي، جونيور",<b>3</b>\nعادي,4\n');
  assert.equal(table.rows, 3);
  assert.match(table.html, /<th>الاسم<\/th>/, 'the first row is a header');
  assert.match(table.html, /دوسي، جونيور/, 'a quoted comma stays inside one cell');
  assert.ok(!table.html.includes('<b>3</b>'), 'a cell cannot inject markup');
  assert.match(table.html, /&lt;b&gt;3&lt;\/b&gt;/);
  assert.equal(table.truncated, false);

  const many = Array.from({ length: PREVIEW_MAX_CSV_ROWS + 40 }, (_unused, index) => `r${index},v`).join('\n');
  const capped = renderCsvPreview(many);
  assert.equal(capped.rows, PREVIEW_MAX_CSV_ROWS, 'the row ceiling holds');
  assert.equal(capped.totalRows, PREVIEW_MAX_CSV_ROWS + 40, 'and the real count is still reported');
  assert.equal(capped.truncated, true);

  assert.match(renderCsvPreview('\n\n').html, /بلا صفوف/);
});

/* ── L1-12: النص الخام نص خام — بلا تلوين ولا تفسير ───────────────────────────── */
test('L1-12 text preview is escaped raw text inside a pre', () => {
  const rendered = renderTextPreview('{ "a": "<b>" }');
  assert.match(rendered.html, /^<pre class="raw">/);
  assert.ok(!rendered.html.includes('<b>'));
  assert.match(rendered.html, /&lt;b&gt;/);
  assert.equal(renderTextPreview('z'.repeat(70_000)).truncated, true);
});

/* ── L1-13: البصمة تُعرض مختصرة أو تُترك — لا تُجمَّل ─────────────────────────── */
test('L1-13 a digest is shown shortened only when it really is a digest', () => {
  assert.equal(shortHash('a'.repeat(64)), `${'a'.repeat(12)}…`);
  assert.equal(shortHash('not-a-digest'), '—');
  assert.equal(shortHash(null), '—');
});

/* ── L1-14: اللوحات موصولة بالصفحة فعلًا — لا وحدة يتيمة ──────────────────────── */
test('L1-14 the three panels exist in the page and are wired to the existing routes', () => {
  const html = read('public/agent.html');
  const js = read('public/agent.js');
  for (const id of ['history-list', 'history-detail', 'history-filter', 'history-badge', 'inbox-list', 'inbox-badge', 'inbox-summary', 'artifact-preview', 'preview-body', 'preview-note', 'preview-close']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is in the page`);
  }
  assert.match(html, /aria-labelledby="history-title"/);
  assert.match(html, /aria-labelledby="inbox-title"/);
  assert.match(html, /<h2 id="history-title">سجل المحادثات<\/h2>/);
  assert.match(html, /<h2 id="inbox-title">صندوق المهام<\/h2>/);
  assert.match(html, /آخر <span id="history-limit">20<\/span> خيطًا/, 'the server limit is stated in the page itself');

  // المسارات القائمة وحدها — لا مسار جديد اخترعته الواجهة.
  assert.match(js, /api\/agent\/threads`/, 'history reads the existing threads route');
  assert.match(js, /api\/agent\/attention/, 'the inbox reads the existing attention route');
  assert.match(js, /preview-toggle/, 'artifacts carry a preview control');
  assert.match(js, /agent-console\.js/, 'the page imports the pure module');
  assert.ok(!/\/api\/agent\/(history|inbox|preview)/.test(js), 'no invented endpoint');
  assert.ok(CONSOLE_VERSION === '1.0');
});

/* ── L1-15: لا لون حرفي ولا emoji في الأنماط والهيكل الجديد (DSN-002) ─────────── */
test('L1-15 the new styles use theme tokens only and no emoji icon sneaks in', () => {
  const css = read('public/agent.css');
  const added = css.slice(css.indexOf('L1 · U2 — سجل المحادثات'));
  assert.ok(added.length > 500, 'the L1 block is present');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(added), 'no literal hex colour outside theme.css');
  assert.ok(!/\brgba?\(/.test(added), 'no literal rgb() either');
  assert.match(css, /\.history:focus-visible/, 'the new scrollable lists keep a visible focus ring');
  assert.match(css, /\.inbox:focus-visible/);

  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  assert.ok(!emoji.test(read('public/agent.html')), 'no emoji used as an icon (DSN2-04)');
  assert.ok(!emoji.test(css));
});

/* ── L1-17: كل وحدة تستوردها الصفحة مخدومة بمسار صريح — لا 404 يلاحظه المتصفح وحده ──
 * أصول `public/` تُخدَم بمسار صريح بلا static fallback (سابقة `TRC-03b`). وحدة جديدة
 * بلا مسار = 404 = خطأ console يسقط كل اختبارات المتصفح. هذا الحارس يفشل في Node. */
test('L1-17 every ES module the page imports is served by an explicit route (no browser-only 404)', async (t) => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: crypto.randomBytes(32).toString('hex') });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // المسارات مشتقة من الاستيراد الفعلي في الصفحة — لا قائمة مكتوبة يدًا تقادُم.
  const pageJs = await (await fetch(`${baseUrl}/agent.js`)).text();
  const imported = [...pageJs.matchAll(/from '\.\/([A-Za-z0-9._-]+\.js)'/g)].map((match) => match[1]);
  assert.ok(imported.includes('agent-console.js'), 'the page really imports the new module');
  assert.ok(imported.includes('agent-trace.js'), 'and the trace module it already imported');

  for (const name of imported) {
    const response = await fetch(`${baseUrl}/${name}`);
    assert.equal(response.status, 200, `/${name} must be served by an explicit route`);
    assert.match(response.headers.get('content-type') || '', /javascript/, `/${name} must be JavaScript`);
    assert.ok((await response.text()).length > 100, `/${name} must not be an empty body`);
  }

  // اللوحتان موجودتان في الصفحة التي يخدمها الخادم نفسه، لا في ملف محلي فقط.
  const pageHtml = await (await fetch(`${baseUrl}/agent`)).text();
  for (const id of ['history-list', 'history-detail', 'history-filter', 'inbox-list', 'inbox-badge', 'artifact-preview', 'preview-body']) {
    assert.ok(pageHtml.includes(`id="${id}"`), `served /agent carries #${id}`);
  }
  const moduleSource = await (await fetch(`${baseUrl}/agent-console.js`)).text();
  assert.match(moduleSource, /export function previewKind/, 'the served module is the real one');
});

/* ── L1-18: سقف مسار الوحدة مقاس لا مزخرف ──
 * CodeQL يرفض وصول نظام ملفات بلا تحديد معدل داخل معالج مسار (CWE-770)، وقاعدة المستودع
 * (ruleset) تمنع الدمج عند أي تنبيه أمني جديد — فالتنبيه مانع بنيوي لا رأي. هذا الحارس يثبت أن
 * السقف حقيقي: ترويسات الحد على أول طلب، ثم 429 فعلي عند السقف المعلَن. بلا هذا الاختبار
 * يمكن حذف الوسيط فيعود التنبيه ويسقط الدمج، أو يبقى السقف رقمًا لا يفعله أحد. */
test('L1-18 the module route is rate-limited for real: limit headers, then a measured 429', async (t) => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: crypto.randomBytes(32).toString('hex') });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const first = await fetch(`${baseUrl}/agent-console.js`);
  assert.equal(first.status, 200, 'the module is still served');
  assert.match(first.headers.get('content-type') || '', /javascript/, 'as JavaScript');
  const limit = Number(first.headers.get('ratelimit-limit'));
  assert.ok(Number.isInteger(limit) && limit >= 1, 'the route announces a real ceiling');
  assert.equal(Number(first.headers.get('ratelimit-remaining')), limit - 1, 'one page load costs exactly one unit');
  await first.text();

  let rejected = null;
  for (let i = 1; i <= limit + 2; i += 1) {
    const response = await fetch(`${baseUrl}/agent-console.js`);
    if (response.status !== 200) { rejected = { at: i + 1, response }; break; }
    await response.text();
  }
  assert.ok(rejected, `the ceiling is enforced within ${limit + 2} requests, not left unbounded`);
  assert.equal(rejected.response.status, 429, 'exceeding it is a 429');
  assert.ok(Number(rejected.response.headers.get('retry-after')) >= 1, 'with Retry-After');
  assert.equal((await rejected.response.json()).error, 'rate_limited', 'and a named reason');
  assert.ok(rejected.at <= limit + 1, 'the enforced ceiling is the announced one');
});

/* ── L1-19: التقديم من الذاكرة لا يُنقص البايتات ولا يُسقط التفاوض الشرطي ──
 * المسار يقرأ الوحدة مرة عند إنشاء الموجه (فلا وصول لنظام الملفات داخل المعالج — وهذا ما يزيل
 * تنبيه CodeQL من أساسه). الثمن المقاس كان أن `res.send` لا يتفاوض على الطزاجة كما فعل `sendFile`:
 * الطلب الشرطي أرجع 200 لا 304. أُعيد التفاوض ببصمة قوية، وهذا الحارس يثبّت الأمرين معًا. */
test('L1-19 the in-memory module route serves the exact bytes and answers a conditional GET with 304', async (t) => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: crypto.randomBytes(32).toString('hex') });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const onDisk = readFileSync(path.join(root, 'public/agent-console.js'), 'utf8');
  const response = await fetch(`${baseUrl}/agent-console.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /javascript/);
  const served = await response.text();
  assert.equal(served, onDisk, 'the served module is byte-identical to the file on disk');

  const etag = response.headers.get('etag');
  assert.ok(etag && etag.startsWith('"') && !etag.startsWith('W/'), 'a strong ETag is announced');
  assert.equal(response.headers.get('cache-control'), 'no-cache', 'so a deploy cannot leave a stale module');

  const revalidated = await fetch(`${baseUrl}/agent-console.js`, { headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304, 'a conditional GET is answered without a body, as sendFile used to');
  assert.equal((await revalidated.text()).length, 0, 'and it carries no bytes');
});

test('L1-16 the derived panel board equals the render of the real page and module', () => {
  const out = execFileSync(process.execPath, ['scripts/render-agent-console-panels.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.match(out, /identical|مطابق/);
  const board = read('docs/design/agent-console-panels.html');
  assert.match(board, /history-list/, 'the board names the real DOM ids');
  assert.match(board, /inbox-list/);
  assert.match(board, /artifact-preview/);
  assert.match(board, /html_not_rendered/, 'and the refusal codes it promises');
  assert.match(board, /agent-console\.js/, 'with its sources cited');
});
