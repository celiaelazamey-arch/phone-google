#!/usr/bin/env node
/**
 * L1 — لوحة اللوحات الثلاث المشتقة (`docs/design/agent-console-panels.html`).
 *
 * الدليل البصري لتغيير واجهة لا يُكتب يدًا: هذه اللوحة **تُشتق** من الصفحة والوحدة
 * النقيّة نفسيهما، فأي تحسّن مزعوم في اللوحة دون تغيّر في الكود يسقط في `--check`.
 * على نمط `render-visual-first.mjs`: مخرجات حتمية، بلا ساعة حائط وبلا شبكة.
 *
 *   node scripts/render-agent-console-panels.mjs           # اكتب اللوحة
 *   node scripts/render-agent-console-panels.mjs --check   # قارن البايتات (انحراف ⇒ خروج 1)
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAGE_PATH = 'docs/design/agent-console-panels.html';
const SOURCES = ['public/agent.html', 'public/agent.js', 'public/agent-console.js', 'public/agent.css'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

/** قيمة ثابت مُصدَّر كما هي في المصدر — لا تقدير ولا إعادة كتابة. */
function constantOf(moduleSource, name) {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(moduleSource);
  return match ? match[1].trim() : null;
}

function keysOf(moduleSource, name) {
  const body = constantOf(moduleSource, name);
  if (!body) return [];
  return [...body.matchAll(/(?:^|[,{])\s*([A-Za-z_][\w-]*)\s*:/g)].map((match) => match[1]);
}

function listOf(moduleSource, name) {
  const body = constantOf(moduleSource, name);
  if (!body) return [];
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** المعرّفات التي تعلنها الصفحة فعلًا داخل قسم اللوحة — لا قائمة مكتوبة يدًا. */
function idsInSection(html, sectionClass) {
  const start = html.indexOf(`class="card ${sectionClass}`);
  if (start === -1) return null;
  const end = html.indexOf('</section>', start);
  return [...html.slice(start, end).matchAll(/id="([a-z0-9-]+)"/g)].map((match) => match[1]);
}

function headingOf(html, id) {
  const match = new RegExp(`<h2 id="${id}">([^<]+)</h2>`).exec(html);
  return match ? match[1].trim() : null;
}

function routesOf(agentJs) {
  return [...new Set([...agentJs.matchAll(/\/api\/agent\/([a-z-]+)(?::|\`|\/|\?)?/g)].map((match) => `/api/agent/${match[1]}`))].sort();
}

export function buildHtml({ html, agentJs, moduleSource, css }) {
  const historyIds = idsInSection(html, 'history-card') || [];
  const inboxIds = idsInSection(html, 'inbox-card') || [];
  const previewIds = [...html.slice(html.indexOf('id="artifact-preview"')).matchAll(/id="([a-z0-9-]+)"/g)]
    .map((match) => match[1])
    .slice(0, 4);
  const routes = routesOf(agentJs);
  const refusals = keysOf(moduleSource, 'PREVIEW_REFUSALS');
  const previewable = keysOf(moduleSource, 'PREVIEWABLE_EXTENSIONS');
  const refused = listOf(moduleSource, 'REFUSED_EXTENSIONS');
  const severities = keysOf(moduleSource, 'SEVERITY_LABELS');
  const constants = [
    ['PREVIEW_MAX_BYTES', constantOf(moduleSource, 'PREVIEW_MAX_BYTES')],
    ['PREVIEW_MAX_TEXT_CHARS', constantOf(moduleSource, 'PREVIEW_MAX_TEXT_CHARS')],
    ['PREVIEW_MAX_CSV_ROWS', constantOf(moduleSource, 'PREVIEW_MAX_CSV_ROWS')],
    ['MESSAGE_MAX_CHARS', constantOf(moduleSource, 'MESSAGE_MAX_CHARS')],
    ['THREAD_LIST_LIMIT', constantOf(moduleSource, 'THREAD_LIST_LIMIT')]
  ];
  const focusRings = ['.history:focus-visible', '.inbox:focus-visible', '.history-detail:focus-visible']
    .filter((selector) => css.includes(selector));

  const panel = ({ code, title, ids, heading, source, limits }) => `      <section class="panel">
        <h2>${escapeHtml(code)} — ${escapeHtml(heading || title)}</h2>
        <p class="source">المصدر: <code>${escapeHtml(source)}</code></p>
        <ul class="ids">${ids.map((id) => `<li><code>#${escapeHtml(id)}</code></li>`).join('')}</ul>
        <ul class="limits">${limits.map((limit) => `<li>${escapeHtml(limit)}</li>`).join('')}</ul>
      </section>`;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>لوحات L1 — الدليل البصري المشتق | سيليا</title>
<style>
:root { color-scheme: dark light; }
body { margin: 0; padding: 1.5rem; font-family: system-ui, sans-serif; line-height: 1.7; }
header { border-bottom: 1px solid currentColor; padding-bottom: .5rem; margin-bottom: 1rem; }
h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 0 0 .35rem; }
p { margin: .25rem 0; }
code { font-family: ui-monospace, monospace; font-size: .85em; }
ul { margin: .25rem 0 .6rem; padding-inline-start: 1.2rem; }
li { margin: .1rem 0; }
.panels { display: grid; gap: 1rem; }
.panel { border: 1px solid currentColor; border-radius: 12px; padding: .75rem 1rem; }
.source { opacity: .8; font-size: .85rem; }
table { border-collapse: collapse; font-size: .85rem; }
th, td { border: 1px solid currentColor; padding: .25rem .5rem; text-align: start; }
footer { margin-top: 1rem; font-size: .8rem; opacity: .8; }
</style>
</head>
<body>
<header>
<h1>لوحات L1 — سجل المحادثات · صندوق المهام · معاينة المخرجات</h1>
<p>هذه اللوحة <strong>مشتقة</strong> من <code>public/agent.html</code> و<code>public/agent-console.js</code> بأمر
<code>node scripts/render-agent-console-panels.mjs</code>؛ ولا تُحرَّر يدويًا: <code>--check</code> يقارن البايتات
ويسقط عند أي انحراف. الإصدار <code>${escapeHtml(constantOf(moduleSource, 'CONSOLE_VERSION')?.replace(/'/g, '') || '—')}</code>.</p>
</header>
<main>
    <div class="panels">
${panel({
  code: 'U2',
  title: 'سجل المحادثات',
  heading: headingOf(html, 'history-title'),
  ids: historyIds,
  source: 'GET /api/agent/threads · GET /api/agent/threads/:id',
  limits: [
    'القائمة آخر 20 خيطًا — حدّ listThreads في الخادم، معلن في الصفحة نفسها',
    'التصفية محلية في ما حُمِّل فقط (عنوان أو بادئة معرّف) مع إعلان سبب التطابق',
    'الرسائل المعروضة من agent_messages؛ دور غير مسمّى يُطبع كما هو ولا يُخترع رد',
    'تشغيلات الخيط أول 10 مع إعلان الباقي — لا قائمة تدّعي الكمال',
    'استئناف الخيط يمرّ بمعالج thread-select القائم نفسه: لا منطق ثانٍ ولا حالة موازية'
  ]
})}
${panel({
  code: 'U5',
  title: 'صندوق المهام',
  heading: headingOf(html, 'inbox-title'),
  ids: inboxIds,
  source: 'GET /api/agent/attention',
  limits: [
    'الترتيب والشدّة كما رتّبهما الخادم — التجميع لا يعيد رتبة ولا يخفّف شدة',
    'البصمة (digest) تُحمل كما هي ولا تُعاد محليًا',
    'كل بند يعرض معرّف دليله وزمن انتظاره؛ next=none لا يُرسم كفعل',
    'القراءة معلنة: sends=false · tracksRead=false',
    'إجمالي الخادم يُعرض حتى لو قلّت البنود — لا اتفاق صامت'
  ]
})}
${panel({
  code: 'U3',
  title: 'معاينة المخرجات',
  heading: 'معاينة',
  ids: previewIds,
  source: 'GET /api/agent/runs/:id/artifacts · GET /api/agent/artifacts/:id/download',
  limits: [
    'قرار المعاينة من الاسم والحجم في السجل قبل أي جلب — ملف ضخم لا يُنزَّل أصلًا',
    'لا تخزين ثانٍ ولا بصمة جديدة: البايتات من الرابط الموقّع نفسه',
    'HTML/SVG/JS/CSS مرفوضة رفضًا مسمّى — لا innerHTML لحمولة ناتجة ولا iframe',
    'كل معروض يُهرَّب أولًا؛ Markdown subset مغلق (عناوين h4..h6، عريض، شفرة، قوائم)',
    'رفض الخادم بالبصمة (409) يعني صفر بايتات معروضة'
  ]
})}
    </div>
    <h2>المسارات المستعملة (مشتقة من public/agent.js)</h2>
    <ul>${routes.map((route) => `<li><code>${escapeHtml(route)}</code></li>`).join('')}</ul>
    <h2>سقوف المعاينة (كما في الوحدة)</h2>
    <table>
      <thead><tr><th>الثابت</th><th>القيمة في المصدر</th></tr></thead>
      <tbody>
${constants.map(([name, value]) => `        <tr><td><code>${escapeHtml(name)}</code></td><td><code>${escapeHtml(value ?? '—')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
    <h2>أنواع تُعاين وأنواع تُرفض</h2>
    <p>تُعاين: ${previewable.map((key) => `<code>${escapeHtml(key)}</code>`).join(' · ')}</p>
    <p>تُرفض: ${refused.map((key) => `<code>${escapeHtml(key)}</code>`).join(' · ')}</p>
    <h2>أكواد الرفض المسماة</h2>
    <ul>${refusals.map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join('')}</ul>
    <h2>شدّات الطابور المعروضة</h2>
    <ul>${severities.map((severity) => `<li><code>${escapeHtml(severity)}</code></li>`).join('')}</ul>
    <h2>حلقات التركيز المرئية في الأنماط الجديدة</h2>
    <ul>${focusRings.map((selector) => `<li><code>${escapeHtml(selector)}</code></li>`).join('')}</ul>
</main>
<footer>
<p>المصادر: ${SOURCES.map((source) => `<code>${escapeHtml(source)}</code>`).join(' · ')}. لا ساعة حائط في المخرَج:
نفس الكود يعيد نفس البايتات. الاختبار <code>test/agent-console.test.js</code> (L1-16) يفرض المطابقة.</p>
</footer>
</body>
</html>
`;
}

async function main() {
  const check = process.argv.includes('--check');
  const [html, agentJs, moduleSource, css] = await Promise.all(
    SOURCES.map((file) => readFile(path.join(ROOT, file), 'utf8'))
  );
  const expected = buildHtml({ html, agentJs, moduleSource, css });
  const target = path.join(ROOT, PAGE_PATH);
  if (check) {
    const actual = await readFile(target, 'utf8').catch(() => null);
    if (actual === expected) {
      console.log(`${PAGE_PATH} identical to the render of ${SOURCES.length} sources — مطابق.`);
      return;
    }
    console.error(`${PAGE_PATH} drifted from the render of public/. Run \`npm run console:panels\`.`);
    process.exitCode = 1;
    return;
  }
  await writeFile(target, expected, 'utf8');
  console.log(`Generated ${PAGE_PATH} (${Buffer.byteLength(expected)} bytes) from ${SOURCES.length} sources.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
