#!/usr/bin/env node
/**
 * Render the Visual-First Engineering board from `src/design/visual-registry.js`.
 *
 * The board is a build artifact of the rule, not a poster beside it: `--check` fails when the
 * committed page no longer matches the registry, so a diagram status cannot be improved on the page
 * while the underlying evidence is missing. Deterministic output (no timestamps) keeps the gate real.
 *
 * Usage:
 *   node scripts/render-visual-first.mjs           # write docs/design/visual-first.html
 *   node scripts/render-visual-first.mjs --check   # fail if it is stale
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTANCE,
  DELIVERY_ORDER,
  DIAGRAM_KINDS,
  MASTER_VISUALS,
  PIPELINE,
  SAFETY_KEPT,
  STATUS,
  STATUS_LABEL,
  STATUS_MARK,
  STATUS_RULE,
  VFE_VERSION,
  VERIFICATION_RULES,
  visualSummary
} from '../src/design/visual-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PAGE_PATH = path.join(ROOT, 'docs', 'design', 'visual-first.html');

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS_CLASS = {
  [STATUS.implemented]: 'ok',
  [STATUS.partial]: 'part',
  [STATUS.proposed]: 'prop',
  [STATUS.missing]: 'miss',
  [STATUS.disabled]: 'off'
};

export function buildHtml() {
  const summary = visualSummary();
  const pipeline = PIPELINE.map(
    (step, index) =>
      `<li><span class="num">${String(index + 1).padStart(2, '0')}</span><b>${esc(step)}</b></li>`
  ).join('');
  const legend = Object.values(STATUS)
    .map(
      (status) =>
        `<div class="legend-item ${STATUS_CLASS[status]}"><span class="mark">${STATUS_MARK[status]}</span><div><b>${esc(STATUS_LABEL[status])}</b><small>${esc(STATUS_RULE[status])}</small></div></div>`
    )
    .join('\n        ');
  const cards = MASTER_VISUALS.map(
    (entry) => `<article class="card ${STATUS_CLASS[entry.status]}">
          <header><h3>${esc(entry.ar)}</h3><span class="mark">${STATUS_MARK[entry.status]} ${esc(STATUS_LABEL[entry.status])}</span></header>
          <p class="artifact mono">${entry.artifact ? esc(entry.artifact) : 'لا يوجد رسم بعد'}</p>
          <p class="gap">${esc(entry.gap)}</p>
          <ul class="ev">${entry.evidence.map((file) => `<li class="mono">${esc(file)}</li>`).join('')}</ul>
        </article>`
  ).join('\n        ');
  const order = DELIVERY_ORDER.map(
    (step) => `<li><span class="num">${String(step.n).padStart(2, '0')}</span><b>${esc(step.ar)}</b><small>${esc(step.en)}</small></li>`
  ).join('');
  const kinds = DIAGRAM_KINDS.map((kind) => `<li><b>${esc(kind.ar)}</b><small class="mono">${esc(kind.en)}</small></li>`).join('');
  const rules = VERIFICATION_RULES.map((rule) => `<li>${esc(rule)}</li>`).join('');
  const acceptance = ACCEPTANCE.map((item) => `<li>${esc(item)}</li>`).join('');
  const safety = SAFETY_KEPT.map((item) => `<li>${esc(item)}</li>`).join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=1440" />
<meta name="celia-visual" content="generated:${VFE_VERSION}:source=src/design/visual-registry.js" />
<title>CeliaOS — Visual-First Engineering 2026</title>
<style>
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2") format("woff2"); font-weight: 600; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2") format("woff2"); font-weight: 700; font-display: block; }
  @font-face { font-family: "Mono"; src: url("../../public/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }

  :root{
    --bg:#080d24; --panel:#0f1738; --panel-2:#131d47; --line:#26346b; --line-2:#33459b;
    --txt:#eaf0ff; --mut:#a9b6e8; --gold:#fbbf24; --gold-2:#fcd34d;
    --ok:#34d399; --part:#fbbf24; --miss:#f87171; --cyan:#22d3ee; --prop:#60a5fa; --off:#94a3b8;
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--txt);font-family:"Plex",system-ui,sans-serif;line-height:1.55}
  body{width:1440px;padding:44px 48px 36px}
  .mono{font-family:"Mono",monospace;direction:ltr;unicode-bidi:isolate}
  header.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding-bottom:22px;border-bottom:2px solid var(--line-2)}
  .brand{display:flex;flex-direction:column;gap:6px}
  .logo{display:flex;align-items:center;gap:12px;font-size:34px;font-weight:700}
  .logo .star{color:var(--gold);font-size:30px}
  .logo b{color:var(--gold)}
  .tag{color:var(--mut);font-size:15px;letter-spacing:.4px}
  .title{text-align:left;max-width:720px}
  .title h1{margin:0 0 6px;font-size:22px;font-weight:700}
  .title p{margin:0;color:var(--mut);font-size:14px}
  .pill{display:inline-block;margin-top:8px;padding:5px 12px;border:1px solid var(--line-2);border-radius:999px;color:var(--gold-2);font-size:12px}
  h2.section{margin:30px 0 12px;font-size:18px;color:var(--gold-2);display:flex;align-items:center;gap:10px}
  h2.section:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line-2),transparent)}
  ol.pipeline{list-style:none;display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:0;padding:0}
  ol.pipeline li{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--line-2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}
  ol.pipeline .num{color:var(--cyan);font-size:12px;font-family:"Mono",monospace}
  ol.pipeline b{font-size:13px;letter-spacing:.6px}
  .legend{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
  .legend-item{display:flex;gap:10px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
  .legend-item small{display:block;color:var(--mut);font-size:11.5px;line-height:1.45}
  .mark{font-size:14px;white-space:nowrap}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;text-align:center}
  .stat b{display:block;font-size:26px}
  .stat small{color:var(--mut);font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-right:4px solid var(--line-2);border-radius:12px;padding:12px 14px}
  .card header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
  .card h3{margin:0;font-size:14px}
  .card .artifact{margin:8px 0 6px;font-size:11.5px;color:var(--cyan)}
  .card .gap{margin:0 0 8px;font-size:12px;color:var(--mut)}
  .card .ev{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
  .card .ev li{font-size:10.5px;color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
  .ok{border-right-color:var(--ok)} .part{border-right-color:var(--part)} .miss{border-right-color:var(--miss)}
  .prop{border-right-color:var(--prop)} .off{border-right-color:var(--off)}
  .ok .mark{color:var(--ok)} .part .mark{color:var(--part)} .miss .mark{color:var(--miss)}
  .prop .mark{color:var(--prop)} .off .mark{color:var(--off)}
  ol.order{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0;padding:0}
  ol.order li{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
  ol.order .num{color:var(--gold);font-size:12px;font-family:"Mono",monospace}
  ol.order small{color:var(--mut);font-size:11px}
  .cols{display:grid;grid-template-columns:1.15fr .85fr;gap:14px}
  .box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .box h3{margin:0 0 8px;font-size:13.5px;color:var(--gold-2)}
  .box ul{margin:0;padding-inline-start:18px;font-size:12.5px;color:var(--txt)}
  .box ul li{margin-bottom:5px}
  .kinds{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:0;padding:0;list-style:none}
  .kinds li{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:11.5px}
  .kinds small{display:block;color:var(--mut);font-size:10.5px}
  footer{margin-top:28px;padding-top:14px;border-top:2px solid var(--line-2);display:flex;justify-content:space-between;color:var(--mut);font-size:12px}
  footer b{color:var(--gold-2)}
</style>
</head>
<body>
  <header class="top">
    <div class="brand">
      <div class="logo"><span class="star">✦</span><span>Celia<b>OS</b></span></div>
      <div class="tag">Crafted to Think · Learn · Grow</div>
    </div>
    <div class="title">
      <h1>Visual-First Engineering 2026</h1>
      <p>Show the System, Don't Just Describe It — كل نتيجة هندسية تُعرض بحالتها ودليلها.</p>
      <span class="pill mono">${VFE_VERSION}</span>
    </div>
  </header>

  <h2 class="section">خط الإنتاج</h2>
  <ol class="pipeline">${pipeline}</ol>

  <h2 class="section">حالات العنصر البصري</h2>
  <div class="legend">
        ${legend}
  </div>

  <h2 class="section">تغطية المخططات الرئيسية</h2>
  <div class="stats">
    <div class="stat"><b>${summary.total}</b><small>مخططًا رئيسيًا مطلوبًا</small></div>
    <div class="stat"><b style="color:var(--ok)">${summary.implemented}</b><small>موجود ومتحقق</small></div>
    <div class="stat"><b style="color:var(--part)">${summary.partial}</b><small>جزئي أو بقيود</small></div>
    <div class="stat"><b style="color:var(--miss)">${summary.missing}</b><small>غير موجود</small></div>
  </div>
  <div class="grid" style="margin-top:12px">
        ${cards}
  </div>

  <h2 class="section">ترتيب تقديم كل مهمة</h2>
  <ol class="order">${order}</ol>

  <h2 class="section">أشكال العرض المسموح بها</h2>
  <ul class="kinds">${kinds}</ul>

  <h2 class="section">قواعد التحقق والحوكمة</h2>
  <div class="cols">
    <div class="box"><h3>التحقق</h3><ul>${rules}</ul></div>
    <div class="box"><h3>معيار القبول</h3><ul>${acceptance}</ul><h3 style="margin-top:12px">ما لا يُمس</h3><ul>${safety}</ul></div>
  </div>

  <footer>
    <div>مُولَّد من <b class="mono">src/design/visual-registry.js</b> — لا يُحرَّر يدويًا.</div>
    <div>لا يُمنح أي شكل حالة أعلى من دليله.</div>
  </footer>
</body>
</html>
`;
}

export async function run({ check = false } = {}) {
  const wanted = buildHtml();
  if (check) {
    let current = null;
    try {
      current = await readFile(PAGE_PATH, 'utf8');
    } catch {
      console.error(`missing: ${path.relative(ROOT, PAGE_PATH)} — run \`npm run visual:first\``);
      return 1;
    }
    if (current !== wanted) {
      console.error(`stale: ${path.relative(ROOT, PAGE_PATH)} — run \`npm run visual:first\``);
      return 1;
    }
    const summary = visualSummary();
    console.log(
      `visual-first board verified: ${summary.total} master diagrams (${summary.implemented} verified · ${summary.partial} partial · ${summary.missing} missing)`
    );
    return 0;
  }
  await mkdir(path.dirname(PAGE_PATH), { recursive: true });
  await writeFile(PAGE_PATH, wanted, 'utf8');
  console.log(`wrote ${path.relative(ROOT, PAGE_PATH)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run({ check: process.argv.includes('--check') });
}
