#!/usr/bin/env node
/**
 * Render the System Atlas from `src/design/system-atlas.js` (VFE-006 / DEC-087).
 *
 * The atlas is the audit the owner asked for before any construction: twelve domains, every claimed
 * capability cited to a real file, and a status derived from existence and tests. `--check` fails when
 * the page and the audit disagree, so a domain cannot be repainted as covered while its files are gone.
 *
 * Usage:
 *   node scripts/render-system-atlas.mjs           # write docs/design/system-atlas.html
 *   node scripts/render-system-atlas.mjs --check   # fail if it is stale
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATLAS_VERSION,
  PRIORITY_MEANING,
  TRUTH,
  TRUTH_LABEL,
  TRUTH_MARK,
  buildAtlas,
  phasesOf
} from '../src/design/system-atlas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PAGE_PATH = path.join(ROOT, 'docs', 'design', 'system-atlas.html');

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CLASS = {
  [TRUTH.verified]: 'ok',
  [TRUTH.unverified]: 'unv',
  [TRUTH.partial]: 'part',
  [TRUTH.proposed]: 'prop',
  [TRUTH.missing]: 'miss',
  [TRUTH.disabled]: 'off',
  [TRUTH.blocked]: 'blocked'
};

function capabilityRow(capability) {
  return `<li class="${CLASS[capability.status]}" data-status="${capability.status}">
            <span class="mark">${TRUTH_MARK[capability.status]}</span>
            <span class="cap">${esc(capability.ar)}</span>
            <span class="ev mono">${capability.anchors.length ? esc(capability.anchors.slice(0, 2).join(' · ')) : 'بلا ملف'}</span>
          </li>`;
}

export function buildHtml() {
  const atlas = buildAtlas({ root: ROOT });
  const phases = phasesOf(atlas);
  const cards = atlas.domains
    .map(
      (domain) => `<article class="card ${CLASS[domain.status]}" data-domain="${domain.id}" data-status="${domain.status}">
          <header>
            <h3>${esc(domain.ar)}</h3>
            <span class="prio">${esc(domain.priority)}</span>
          </header>
          <div class="sub"><span class="badge">${TRUTH_MARK[domain.status]} ${esc(TRUTH_LABEL[domain.status])}</span><span class="mono small">${esc(domain.en)}</span></div>
          <div class="bar" title="تغطية ${domain.coverage}%"><span style="width:${domain.coverage}%"></span></div>
          <ul class="caps">${domain.capabilities.map(capabilityRow).join('')}</ul>
          <p class="meta">${domain.artifact ? `الأثر: <span class="mono">${esc(domain.artifact)}</span>` : 'لا أثر بصري لهذا المجال بعد'} · تغطية ${domain.coverage}%</p>
        </article>`
    )
    .join('\n      ');
  const phaseBlocks = phases
    .map(
      (phase) => `<div class="phase">
          <div class="phase-head"><b>${esc(phase.priority)}</b><span>${esc(phase.rule)}</span></div>
          <div class="phase-body">${phase.domains.map((id) => {
            const domain = atlas.domains.find((entry) => entry.id === id);
            return `<span class="tag ${CLASS[domain.status]}">${TRUTH_MARK[domain.status]} ${esc(domain.ar)}</span>`;
          }).join('')}</div>
        </div>`
    )
    .join('\n      ');
  const legend = Object.values(TRUTH)
    .map((status) => `<span class="${CLASS[status]}"><b>${TRUTH_MARK[status]}</b> ${esc(TRUTH_LABEL[status])}</span>`)
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="celia-visual" content="generated:${ATLAS_VERSION}:source=src/design/system-atlas.js" />
<title>CeliaOS — System Atlas 2026</title>
<style>
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2") format("woff2"); font-weight: 600; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2") format("woff2"); font-weight: 700; font-display: block; }
  @font-face { font-family: "Mono"; src: url("../../public/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  :root{--bg:#080d24;--panel:#0f1738;--panel-2:#131d47;--line:#26346b;--line-2:#33459b;--txt:#eaf0ff;--mut:#a9b6e8;--gold:#fbbf24;--ok:#34d399;--part:#fbbf24;--miss:#f87171;--unv:#fb923c;--off:#94a3b8;--prop:#60a5fa;--blocked:#e879f9}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--txt);font-family:"Plex",system-ui,sans-serif;line-height:1.55}
  body{width:1440px;padding:40px 46px 34px}
  .mono{font-family:"Mono",monospace;direction:ltr;unicode-bidi:isolate}
  .small{font-size:10.5px}
  header.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding-bottom:20px;border-bottom:2px solid var(--line-2)}
  .logo{display:flex;align-items:center;gap:12px;font-size:32px;font-weight:700}
  .logo .star{color:var(--gold);font-size:28px}
  .logo b{color:var(--gold)}
  .tagline{color:var(--mut);font-size:14px}
  .title{text-align:left;max-width:720px}
  .title h1{margin:0 0 6px;font-size:22px}
  .title p{margin:0;color:var(--mut);font-size:13.5px}
  .pill{display:inline-block;margin-top:8px;padding:4px 12px;border:1px solid var(--line-2);border-radius:999px;color:var(--gold);font-size:11.5px}
  h2.section{margin:26px 0 12px;font-size:17px;color:var(--gold);display:flex;align-items:center;gap:10px}
  h2.section:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line-2),transparent)}
  .stats{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;text-align:center}
  .stat b{display:block;font-size:23px}
  .stat small{color:var(--mut);font-size:11.5px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-right:4px solid var(--line-2);border-radius:12px;padding:12px 14px}
  .card header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
  .card h3{margin:0;font-size:14px}
  .prio{font-family:"Mono",monospace;font-size:10.5px;color:var(--gold);border:1px solid var(--line-2);border-radius:6px;padding:1px 6px}
  .card .sub{display:flex;justify-content:space-between;gap:8px;margin:6px 0 8px;color:var(--mut);font-size:11px}
  .bar{height:6px;background:#0a1230;border:1px solid var(--line);border-radius:999px;overflow:hidden;margin-bottom:10px}
  .bar span{display:block;height:100%;background:linear-gradient(90deg,#22d3ee,#33459b)}
  .caps{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:5px}
  .caps li{display:flex;gap:6px;align-items:baseline;font-size:12px}
  .caps li .cap{flex:1}
  .caps li .ev{font-size:9.5px;color:#7d8dc9;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:right}
  .mark{font-size:11px}
  .card .meta{margin:0;font-size:10.5px;color:var(--mut)}
  .ok{border-right-color:var(--ok)} .part{border-right-color:var(--part)} .miss{border-right-color:var(--miss)}
  .unv{border-right-color:var(--unv)} .off{border-right-color:var(--off)} .prop{border-right-color:var(--prop)} .blocked{border-right-color:var(--blocked)}
  .ok .mark{color:var(--ok)} .part .mark{color:var(--part)} .miss .mark{color:var(--miss)} .unv .mark{color:var(--unv)}
  .phase{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}
  .phase-head{display:flex;gap:10px;align-items:baseline;margin-bottom:8px}
  .phase-head b{color:var(--gold);font-family:"Mono",monospace;font-size:13px}
  .phase-head span{color:var(--mut);font-size:12px}
  .phase-body{display:flex;flex-wrap:wrap;gap:6px}
  .tag{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:11px;background:var(--panel-2)}
  .legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--mut);font-size:11.5px}
  footer{margin-top:24px;padding-top:12px;border-top:2px solid var(--line-2);display:flex;justify-content:space-between;color:var(--mut);font-size:11.5px}
  footer a{color:#93c5fd;text-decoration:none}
</style>
</head>
<body>
  <header class="top">
    <div>
      <div class="logo"><span class="star">✦</span><span>Celia<b>OS</b></span></div>
      <div class="tagline">System Atlas · خريطة النطاق الكامل</div>
    </div>
    <div class="title">
      <h1>اثنا عشر مجالًا — بتغطيتها المقيسة لا الموعودة</h1>
      <p>كل قدرة تشير إلى ملفاتها، وحالتها تُحسب من الوجود والاختبار. هذه خريطة تدقيق قبل البناء.</p>
      <span class="pill mono">${ATLAS_VERSION}</span>
    </div>
  </header>

  <h2 class="section">ما قيس الآن</h2>
  <div class="stats">
    <div class="stat"><b>${atlas.stats.domains}</b><small>مجالًا</small></div>
    <div class="stat"><b>${atlas.stats.capabilities}</b><small>قدرة معلنة</small></div>
    <div class="stat"><b style="color:var(--ok)">${atlas.capabilityCounts[TRUTH.verified]}</b><small>متحققة</small></div>
    <div class="stat"><b style="color:var(--unv)">${atlas.capabilityCounts[TRUTH.unverified]}</b><small>بلا اختبار</small></div>
    <div class="stat"><b style="color:var(--miss)">${atlas.capabilityCounts[TRUTH.missing]}</b><small>غير موجودة</small></div>
    <div class="stat"><b style="color:var(--part)">${atlas.stats.partial}</b><small>مجالات جزئية</small></div>
  </div>

  <h2 class="section">المجالات الاثنا عشر</h2>
  <div class="grid">
      ${cards}
  </div>

  <h2 class="section">المراحل — بالترتيب لا بالاثني عشر معًا</h2>
      ${phaseBlocks}
  <p class="legend" style="margin-top:6px">${PRIORITY_MEANING.P0} · ${PRIORITY_MEANING.P1} · ${PRIORITY_MEANING.P2}</p>

  <h2 class="section">مفتاح الحالات</h2>
  <p class="legend">${legend}</p>

  <footer>
    <div>مُولَّد من <b class="mono">src/design/system-atlas.js</b> — <span class="mono">npm run atlas</span> · الخريطة المعمارية: <a href="./architecture-map.html">architecture-map.html</a></div>
    <div>لا مجال يُرسم أعلى من دليله.</div>
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
      console.error(`missing: ${path.relative(ROOT, PAGE_PATH)} — run \`npm run atlas\``);
      return 1;
    }
    if (current !== wanted) {
      console.error(`stale: ${path.relative(ROOT, PAGE_PATH)} — run \`npm run atlas\``);
      return 1;
    }
    const atlas = buildAtlas({ root: ROOT });
    console.log(
      `system atlas verified: ${atlas.stats.domains} domains · ${atlas.stats.capabilities} capabilities (${atlas.capabilityCounts[TRUTH.verified]} verified · ${atlas.capabilityCounts[TRUTH.missing]} missing)`
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
