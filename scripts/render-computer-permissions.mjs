#!/usr/bin/env node
/**
 * Render the computer-agent permission infographic from `src/agent/computer-policy.js`.
 *
 * The picture is a build artifact of the policy, not a drawing kept beside it: `--check` fails when the committed
 * page no longer matches the constants, so a permission cannot be widened in code while the infographic still says
 * otherwise. Output is deterministic (no timestamps), so the check is meaningful in CI.
 *
 * Usage:
 *   node scripts/render-computer-permissions.mjs           # write the page + the docs page
 *   node scripts/render-computer-permissions.mjs --check   # fail if either is stale
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES,
  COMPETITIVE_FEATURE,
  COMPUTER_POLICY_VERSION,
  DECISION_STEPS,
  GROUPS,
  MANDATORY_RULES,
  STATUS,
  STATUS_LABELS,
  SYSTEM_STATE,
  policySummary
} from '../src/agent/computer-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PAGE_PATH = path.join(ROOT, 'public', 'computer-permissions.html');
export const DOCS_PATH = path.join(ROOT, 'docs', 'computer-permissions', 'README.md');

const STATUS_ORDER = [STATUS.allowed, STATUS.approval, STATUS.restricted, STATUS.denied];
// Keyed by the STATUS constants, not by literal strings: the first draft used a colloquial key and printed
// "undefined" under one column — the test below now refuses that class of bug outright.
const STATUS_NOTE = {
  [STATUS.allowed]: 'داخل النطاق المحدد، وبلا أثر خارجي',
  [STATUS.approval]: 'تتوقف حتى قرار بشري مسجَّل',
  [STATUS.restricted]: 'إذن صريح لهذا الهدف تحديدًا',
  [STATUS.denied]: 'مرفوضة بالسياسة، لا استثناء'
};
for (const status of STATUS_ORDER) {
  if (!STATUS_NOTE[status]) throw new Error(`render: no column note for status ${status}`);
}

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function buildMermaid() {
  const lines = ['flowchart LR', `  S["CeliaOS · ${COMPUTER_POLICY_VERSION}"]`];
  for (const status of STATUS_ORDER) {
    const entries = CAPABILITIES.filter((capability) => capability.status === status);
    lines.push(`  subgraph ${status.toUpperCase()}["${STATUS_LABELS[status]} (${entries.length})"]`);
    for (const entry of entries) lines.push(`    ${entry.id}["${entry.ar}"]`);
    lines.push('  end');
    lines.push(`  S --> ${status.toUpperCase()}`);
  }
  lines.push(`  STATE["NETWORK=${SYSTEM_STATE.network} · GATES=${SYSTEM_STATE.externalGates} · IDENTITY=${SYSTEM_STATE.identity}"]`);
  lines.push('  DENY["المنع الافتراضي: ما لم يُذكر مرفوض"] --> S');
  return `${lines.join('\n')}\n`;
}

export function buildMarkdown() {
  const summary = policySummary();
  const rows = CAPABILITIES.map(
    (entry) =>
      `| \`${entry.id}\` | ${entry.ar} | ${STATUS_LABELS[entry.status]} | ${entry.scope} | ${entry.gate} | ${entry.wired ? 'نعم' : 'لا'} |`
  ).join('\n');
  return `# صلاحيات وكيل الكمبيوتر في CeliaOS

> **مُولَّد آليًا** من \`src/agent/computer-policy.js\` (\`${COMPUTER_POLICY_VERSION}\`). لا تُحرّره يدويًا:
> \`npm run computer:permissions\` يعيد توليده، و\`npm run computer:permissions:check\` يُفشل CI عند الانحراف.
>
> **لا شيء هنا مُنفَّذ:** ${summary.wired} من ${summary.total} قدرة موصولة بمحرك Computer Use. Backend AGENT-003 المحلي غير موصول بهذه القدرات،
> لذا \`decideAction\` يعيد الحكم السياسي مع \`executable: false\`. المخطط يوثّق الحدود، ولا يثبت أن النقر والكتابة يعملان.

**حالة النظام المعلنة:** \`NETWORK = ${SYSTEM_STATE.network}\` · \`EXTERNAL GATES = ${SYSTEM_STATE.externalGates}\` · \`IDENTITY = ${SYSTEM_STATE.identity}\`

## المصفوفة

| المعرف | القدرة | الحالة | الحد | البوابة | موصولة |
|---|---|---|---|---|---|
${rows}

## مخطط

\`\`\`mermaid
${buildMermaid()}\`\`\`

## قواعد إلزامية

${MANDATORY_RULES.map((rule) => `- ${rule}`).join('\n')}

## الميزة التنافسية: ${COMPETITIVE_FEATURE.ar} (${COMPETITIVE_FEATURE.en})

${COMPETITIVE_FEATURE.thesis}

${COMPETITIVE_FEATURE.pillars.map((pillar) => `- **${pillar.ar}:** ${pillar.detail}`).join('\n')}

### المراحل

| # | المرحلة | ما نبنيه | معيار النجاح |
|---|---|---|---|
${COMPETITIVE_FEATURE.stages.map((stage) => `| ${stage.n} | ${stage.ar} | ${stage.build} | ${stage.gate} |`).join('\n')}

> ${COMPETITIVE_FEATURE.notClaimed}
`;
}

export function buildHtml() {
  const summary = policySummary();
  const columns = STATUS_ORDER.map((status) => {
    const entries = CAPABILITIES.filter((capability) => capability.status === status);
    const cards = entries
      .map(
        (entry) => `          <article class="cap" data-status="${status}">
            <h4>${esc(entry.ar)}</h4>
            <p class="scope">${esc(entry.scope)}</p>
            <p class="gate"><span>البوابة</span> ${esc(entry.gate)}</p>
            <div class="flags">
              <span class="flag ${entry.wired ? 'on' : 'off'}">${entry.wired ? 'موصولة' : 'غير موصولة'}</span>
              <span class="flag ${entry.tested ? 'on' : 'off'}">${entry.tested ? 'مختبَرة' : 'بلا اختبار'}</span>
            </div>
          </article>`
      )
      .join('\n');
    return `        <section class="col" aria-labelledby="col-${status}">
          <h3 id="col-${status}" class="col-title" data-status="${status}">
            ${esc(STATUS_LABELS[status])} <span class="count">${entries.length}</span>
          </h3>
          <p class="col-note">${esc(STATUS_NOTE[status])}</p>
${cards}
        </section>`;
  }).join('\n');

  const flow = DECISION_STEPS.map(
    (step) => `          <li><b>${step.n}</b><span><strong>${esc(step.ar)}</strong><small>${esc(step.detail)}</small></span></li>`
  ).join('\n');

  const rules = MANDATORY_RULES.map((rule) => `          <li>${esc(rule)}</li>`).join('\n');

  const pillars = COMPETITIVE_FEATURE.pillars
    .map((pillar) => `          <article class="pillar"><h4>${esc(pillar.ar)}</h4><p>${esc(pillar.detail)}</p></article>`)
    .join('\n');

  const stages = COMPETITIVE_FEATURE.stages
    .map(
      (stage) =>
        `              <tr><td>${stage.n}</td><td>${esc(stage.ar)}</td><td>${esc(stage.build)}</td><td>${esc(stage.gate)}</td></tr>`
    )
    .join('\n');

  const groupLegend = Object.entries(GROUPS)
    .map(([id, label]) => `<li data-group="${id}">${esc(label)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>صلاحيات وكيل الكمبيوتر في CeliaOS — مصفوفة سياسة (غير موصولة)</title>
    <meta
      name="description"
      content="مصفوفة صلاحيات وكيل الكمبيوتر داخل CeliaOS: مسموح، موافقة، مقيّد، محظور — مع NETWORK=DENY وEXTERNAL GATES=CLOSED وIDENTITY=NOT_PROVEN، وميزة الاستقلالية المصحوبة بأدلة."
    />
    <link rel="stylesheet" href="./fonts.css" />
    <style>
      :root {
        --bg: #0b1030; --bg2: #121a4a; --card: #161f55; --line: #2e3a8c; --txt: #eaf0ff; --mut: #a9b6e8;
        --ok: #34d399; --warn: #fbbf24; --rest: #38bdf8; --bad: #f87171; --vio: #8b5cf6; --cy: #22d3ee;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; color: var(--txt); line-height: 1.7;
        background: radial-gradient(1100px 560px at 82% -10%, #3b2a8f55, transparent),
          radial-gradient(880px 480px at 8% 8%, #0e749033, transparent), var(--bg);
        font-family: "IBM Plex Sans Arabic", system-ui, Tahoma, sans-serif;
      }
      .wrap { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
      .skip { position: absolute; inset-inline-start: -9999px; }
      .skip:focus { inset-inline-start: 12px; top: 8px; background: var(--cy); color: #06102c; padding: 8px 12px; border-radius: 8px; }
      .topbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;
        border: 1px solid var(--line); border-radius: 14px; padding: 10px 14px; background: #ffffff08; }
      .brand { font-weight: 800; background: linear-gradient(135deg, var(--vio), var(--cy));
        -webkit-background-clip: text; background-clip: text; color: transparent; }
      nav { display: flex; flex-wrap: wrap; gap: 6px; }
      nav a { color: var(--mut); text-decoration: none; font-size: 13px; padding: 5px 11px; border-radius: 999px; }
      nav a:hover, nav a:focus-visible { color: var(--txt); background: #ffffff0a; }
      nav a[aria-current="page"] { color: var(--cy); border: 1px solid var(--cy); }
      header.hero { text-align: center; margin: 26px 0 10px; }
      header.hero h1 { margin: 0 0 6px; font-size: clamp(24px, 3.8vw, 36px); }
      header.hero p { margin: 0; color: var(--mut); }
      .truth { margin: 18px 0; border: 1px solid #fbbf2477; background: #fbbf2412; border-radius: 14px; padding: 12px 14px; font-size: 13.5px; }
      .truth b { color: var(--warn); }
      .state { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .state code { background: #00000033; border: 1px solid var(--line); border-radius: 8px; padding: 2px 8px; font-size: 12px; direction: ltr; }
      .cols { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 10px; }
      .col { background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; padding: 12px; }
      .col-title { margin: 0 0 4px; font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
      .col-title[data-status="allowed"] { color: var(--ok); }
      .col-title[data-status="approval_required"] { color: var(--warn); }
      .col-title[data-status="restricted"] { color: var(--rest); }
      .col-title[data-status="denied"] { color: var(--bad); }
      .count { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--mut); }
      .col-note { margin: 0 0 10px; color: var(--mut); font-size: 12px; }
      .cap { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; margin-bottom: 10px; }
      .cap h4 { margin: 0 0 4px; font-size: 13.5px; }
      .cap .scope { margin: 0 0 6px; color: var(--mut); font-size: 12px; }
      .cap .gate { margin: 0; font-size: 11.5px; color: var(--mut); }
      .cap .gate span { color: var(--cy); }
      .flags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .flag { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--line); }
      .flag.off { color: var(--warn); border-color: #fbbf2466; }
      .flag.on { color: var(--ok); border-color: #34d39966; }
      section.block { margin-top: 26px; }
      section.block h2 { font-size: 19px; margin: 0 0 12px; }
      section.block h2 small { font-size: 12.5px; color: var(--mut); font-weight: 400; }
      ol.flow { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
      ol.flow li { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; display: flex; gap: 8px; }
      ol.flow b { width: 24px; height: 24px; flex: none; border-radius: 50%; background: var(--vio); color: #fff;
        display: grid; place-items: center; font-size: 12px; }
      ol.flow small { display: block; color: var(--mut); font-size: 11.5px; }
      ul.rules { margin: 0; padding-inline-start: 18px; color: var(--mut); font-size: 13.5px; }
      ul.rules li { margin-bottom: 4px; }
      .feature { background: linear-gradient(160deg, var(--card), var(--bg2)); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
      .feature h2 { margin-top: 0; }
      .thesis { color: var(--txt); font-size: 14.5px; margin: 0 0 12px; }
      .pillars { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
      .pillar { background: #ffffff08; border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
      .pillar h4 { margin: 0 0 4px; color: var(--cy); font-size: 13.5px; }
      .pillar p { margin: 0; color: var(--mut); font-size: 12.5px; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
      th, td { border: 1px solid var(--line); padding: 7px 9px; text-align: start; vertical-align: top; }
      th { background: #ffffff0a; color: var(--cy); font-weight: 700; }
      td { color: var(--mut); }
      .notclaimed { margin-top: 12px; border: 1px dashed #fbbf2477; border-radius: 12px; padding: 10px; color: var(--warn); font-size: 13px; }
      footer { margin-top: 26px; text-align: center; color: var(--mut); font-size: 12.5px; }
      footer a { color: var(--cy); }
      @media (max-width: 980px) {
        .cols { grid-template-columns: 1fr 1fr; }
        ol.flow { grid-template-columns: 1fr; }
      }
      @media (max-width: 620px) { .cols { grid-template-columns: 1fr; } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
      @media (forced-colors: active) { .cap, .col, .feature { border: 1px solid CanvasText; } }
      :focus-visible { outline: 2px solid var(--cy); outline-offset: 2px; }
    </style>
  </head>
  <body data-page="computer-permissions">
    <a class="skip" href="#main-content">انتقل إلى المحتوى الرئيسي</a>
    <div class="wrap">
      <div class="topbar">
        <span class="brand">CeliaOS</span>
        <nav aria-label="التنقل الرئيسي">
          <a href="./index.html">الاستوديو</a>
          <a href="./agent">الوكيل المحكوم</a>
          <a href="./system">مركز النظام</a>
          <a href="./computer.html">استخدام الكمبيوتر</a>
          <a href="./computer-permissions.html" aria-current="page">صلاحيات الكمبيوتر</a>
        </nav>
      </div>

      <header class="hero">
        <h1>صلاحيات وكيل الكمبيوتر في CeliaOS</h1>
        <p>مصفوفة سياسة — تُولَّد من الشيفرة نفسها التي تصدر القرار.</p>
      </header>

      <div class="truth" role="note">
        <b>ليست قدرات مُشغَّلة.</b>
        ${summary.wired} من ${summary.total} قدرة موصولة بمحرك Computer Use (Backend <code>AGENT-003</code> المحلي غير موصول بها). القرار يُحسب فعليًا، لكن
        <code>executable</code> يبقى <code>false</code> — والمخطط يوثّق الحدود بدل أن يوحي بقدرة قائمة.
        <div class="state">
          <code>NETWORK = ${SYSTEM_STATE.network}</code>
          <code>EXTERNAL GATES = ${SYSTEM_STATE.externalGates}</code>
          <code>IDENTITY = ${SYSTEM_STATE.identity}</code>
          <code>${COMPUTER_POLICY_VERSION}</code>
        </div>
      </div>

      <main id="main-content">
        <section class="block" aria-label="مصفوفة الصلاحيات">
          <div class="cols">
${columns}
          </div>
        </section>

        <section class="block" aria-labelledby="flow-title">
          <h2 id="flow-title">كيف يقرر الوكيل النقرة أو الكتابة؟ <small>خمس خطوات، لا واحدة</small></h2>
          <ol class="flow">
${flow}
          </ol>
        </section>

        <section class="block" aria-labelledby="rules-title">
          <h2 id="rules-title">قواعد إلزامية داخل CeliaOS</h2>
          <ul class="rules">
${rules}
          </ul>
        </section>

        <section class="block">
          <div class="feature">
            <h2>الميزة التنافسية: ${esc(COMPETITIVE_FEATURE.ar)} <small>${esc(COMPETITIVE_FEATURE.en)}</small></h2>
            <p class="thesis">${esc(COMPETITIVE_FEATURE.thesis)}</p>
            <div class="pillars">
${pillars}
            </div>
            <table>
              <caption class="col-note">المراحل — معيار نجاح لكل مرحلة، لا شعارات</caption>
              <thead>
                <tr><th>#</th><th>المرحلة</th><th>ما نبنيه</th><th>معيار النجاح</th></tr>
              </thead>
              <tbody>
${stages}
              </tbody>
            </table>
            <p class="notclaimed">${esc(COMPETITIVE_FEATURE.notClaimed)}</p>
          </div>
        </section>
      </main>

      <footer>
        ${COMPUTER_POLICY_VERSION} · مُولَّد من <code>src/agent/computer-policy.js</code> ·
        <a href="./computer.html">صفحة استخدام الكمبيوتر</a> · <a href="./system">حالة النظام الحقيقية</a>
      </footer>
    </div>
  </body>
</html>
`;
}

async function renderAll() {
  return [
    { path: PAGE_PATH, content: buildHtml(), label: 'public/computer-permissions.html' },
    { path: DOCS_PATH, content: buildMarkdown(), label: 'docs/computer-permissions/README.md' }
  ];
}

async function main() {
  const check = process.argv.includes('--check');
  const artifacts = await renderAll();
  let stale = 0;
  for (const artifact of artifacts) {
    if (check) {
      let current = null;
      try {
        current = await readFile(artifact.path, 'utf8');
      } catch {
        current = null;
      }
      if (current !== artifact.content) {
        console.error(`stale: ${artifact.label} — run \`npm run computer:permissions\``);
        stale += 1;
      }
    } else {
      await mkdir(path.dirname(artifact.path), { recursive: true });
      await writeFile(artifact.path, artifact.content, 'utf8');
      console.log(`wrote ${artifact.label}`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log('computer permission artifacts are current: public/computer-permissions.html, docs/computer-permissions/README.md');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
