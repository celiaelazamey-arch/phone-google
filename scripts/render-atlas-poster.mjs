#!/usr/bin/env node
/**
 * Render the System Atlas poster (VFE-008 / DEC-088).
 *
 * The owner drew this poster by hand once; the numbers on it did not match the audit. This generator
 * makes the poster a function of the audit: the same twelve domains, the measured coverage, the real
 * gaps, and a content fingerprint that names exactly which findings it draws. Deterministic output —
 * no commit, no date, no unit of truth that cannot be re-computed.
 *
 * Usage:
 *   node scripts/render-atlas-poster.mjs           # write docs/design/system-atlas-poster.html
 *   node scripts/render-atlas-poster.mjs --check   # fail if it is stale
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATLAS_VERSION,
  TRUTH,
  TRUTH_LABEL,
  TRUTH_MARK,
  buildAtlas,
  factsOf,
  fingerprintOf,
  verifyFacts,
  phasesOf
} from '../src/design/system-atlas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const POSTER_PATH = path.join(ROOT, 'docs', 'design', 'system-atlas-poster.html');
export const FACTS_PATH = path.join(ROOT, 'docs', 'design', 'system-atlas-facts.json');

/** Deterministic JSON: two runs of the same audit produce the same bytes. */
export function buildFacts() {
  return `${JSON.stringify(factsOf(buildAtlas({ root: ROOT })), null, 2)}\n`;
}

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

/** Only what was measured may appear on a card: a gap is named, never rounded away. */
export function domainVerdict(domain) {
  const missing = domain.capabilities.filter((capability) => capability.status === TRUTH.missing);
  if (missing.length) return { kind: 'gap', text: `فجوة: ${missing.map((capability) => capability.ar).join(' · ')}` };
  const unverified = domain.capabilities.filter((capability) => capability.status === TRUTH.unverified);
  if (unverified.length) return { kind: 'warn', text: `بلا اختبار يسمّي ملفه: ${unverified.map((capability) => capability.ar).join(' · ')}` };
  return { kind: 'done', text: 'مكتمل — كل قدرة متحققة باختبار' };
}

export function buildHtml() {
  const atlas = buildAtlas({ root: ROOT });
  const fingerprint = fingerprintOf(atlas);
  const phases = phasesOf(atlas);

  const cards = atlas.domains
    .map((domain, index) => {
      const verdict = domainVerdict(domain);
      const capabilities = domain.capabilities
        .slice(0, 3)
        .map(
          (capability) =>
            `<li class="${CLASS[capability.status]}"><span class="m">${TRUTH_MARK[capability.status]}</span>${esc(capability.ar)}</li>`
        )
        .join('');
      const more = domain.capabilities.length - 3;
      return `<article class="card ${CLASS[domain.status]}">
          <div class="head">
            <span class="idx">${String(index + 1).padStart(2, '0')}</span>
            <h3>${esc(domain.ar)}</h3>
            <span class="prio">${esc(domain.priority)}</span>
          </div>
          <div class="cov"><b>${domain.coverage}%</b><span>تغطية مقيسة</span></div>
          <div class="bar"><span style="width:${domain.coverage}%"></span></div>
          <ul class="caps">${capabilities}${more > 0 ? `<li class="more">+${more} قدرة أخرى</li>` : ''}</ul>
          <p class="verdict ${verdict.kind}">${esc(verdict.text)}</p>
        </article>`;
    })
    .join('\n      ');

  const roadmap = phases
    .map(
      (phase, index) =>
        `<div class="phase">
          <b>${esc(phase.priority)}</b>
          <span>${phase.domains.length} مجالات</span>
          ${index < phases.length - 1 ? '<i class="arrow">←</i>' : ''}
        </div>`
    )
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="celia-visual" content="generated:${ATLAS_VERSION}:fingerprint=${fingerprint}:source=src/design/system-atlas.js" />
<title>CeliaOS — System Atlas Poster 2026</title>
<style>
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2") format("woff2"); font-weight: 600; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2") format("woff2"); font-weight: 700; font-display: block; }
  @font-face { font-family: "Mono"; src: url("../../public/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  :root{--bg:#080d24;--panel:#0f1738;--panel-2:#131d47;--line:#26346b;--line-2:#33459b;--txt:#eaf0ff;--mut:#a9b6e8;--gold:#fbbf24;--ok:#34d399;--part:#fbbf24;--miss:#f87171;--unv:#fb923c;--off:#94a3b8}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--txt);font-family:"Plex",system-ui,sans-serif;line-height:1.5}
  body{width:1440px;padding:34px 40px 26px}
  .mono{font-family:"Mono",monospace;direction:ltr;unicode-bidi:isolate}
  header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:16px;border-bottom:2px solid var(--line-2)}
  .logo{display:flex;align-items:center;gap:10px;font-size:30px;font-weight:700}
  .logo .star{color:var(--gold);font-size:26px}
  .logo b{color:var(--gold)}
  .tag{color:var(--mut);font-size:13px}
  h1{margin:0;font-size:24px}
  .sub{margin:4px 0 0;color:var(--mut);font-size:13px}
  .seal{border:1px solid var(--gold);border-radius:12px;padding:8px 14px;color:var(--gold);font-size:12px;text-align:center}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
  .card{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--line);border-top:3px solid var(--line-2);border-radius:12px;padding:10px 12px}
  .card.ok{border-top-color:var(--ok)} .card.part{border-top-color:var(--part)} .card.miss{border-top-color:var(--miss)}
  .card.unv{border-top-color:var(--unv)} .card.prop{border-top-color:var(--prop)} .card.off{border-top-color:var(--off)}
  .head{display:flex;align-items:center;gap:8px}
  .idx{font-family:"Mono",monospace;font-size:11px;color:var(--mut)}
  .head h3{margin:0;font-size:13.5px;flex:1}
  .prio{font-family:"Mono",monospace;font-size:10px;color:var(--bg);background:var(--gold);border-radius:6px;padding:1px 6px;font-weight:600}
  .cov{display:flex;align-items:baseline;gap:6px;margin-top:6px}
  .cov b{font-size:20px;color:var(--gold)}
  .cov span{font-size:10.5px;color:var(--mut)}
  .bar{height:5px;background:#0a1230;border:1px solid var(--line);border-radius:999px;overflow:hidden;margin:4px 0 7px}
  .bar span{display:block;height:100%;background:linear-gradient(90deg,#22d3ee,#33459b)}
  .caps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:11px}
  .caps .m{margin-inline-end:5px}
  .caps .more{color:var(--mut);font-size:10px}
  .verdict{margin:7px 0 0;font-size:10.5px;padding:4px 7px;border-radius:6px}
  .verdict.gap{color:#fecaca;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35)}
  .verdict.warn{color:#fed7aa;background:rgba(251,146,60,.12);border:1px solid rgba(251,146,60,.35)}
  .verdict.done{color:#bbf7d0;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35)}
  .bottom{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:12px;margin-top:14px}
  .box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
  .box h4{margin:0 0 8px;font-size:12px;color:var(--gold)}
  .phase{display:flex;align-items:center;gap:8px;font-size:11.5px;margin-bottom:5px}
  .phase b{font-family:"Mono",monospace;color:var(--gold)}
  .phase span{color:var(--mut)}
  .tally{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center}
  .tally div b{display:block;font-size:20px}
  .tally div small{font-size:10px;color:var(--mut)}
  .legend{display:flex;flex-wrap:wrap;gap:10px;font-size:10.5px;color:var(--mut)}
  footer{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:10px;border-top:2px solid var(--line-2);color:var(--mut);font-size:11px}
  footer b{color:var(--gold)}
</style>
</head>
<body>
  <header>
    <div>
      <div class="logo"><span class="star">✦</span><span>Celia<b>OS</b></span></div>
      <div class="tag">Crafted to Think · Learn · Grow</div>
    </div>
    <div style="text-align:center">
      <h1>System Atlas — خريطة النظام الشاملة</h1>
      <p class="sub">12 مجالًا · رؤية موحّدة · حالة مُشتقة من التدقيق لا من التقدير</p>
    </div>
    <div class="seal">Visual Engineering<br/><span class="mono">${esc(ATLAS_VERSION)}</span></div>
  </header>

  <div class="grid">
      ${cards}
  </div>

  <div class="bottom">
    <div class="box">
      <h4>مراحل التطوير</h4>
      ${roadmap}
    </div>
    <div class="box">
      <h4>نتائج التدقيق التشغيلي</h4>
      <div class="tally">
        <div><b style="color:var(--ok)">${atlas.capabilityCounts[TRUTH.verified]}</b><small>متحققة</small></div>
        <div><b style="color:var(--unv)">${atlas.capabilityCounts[TRUTH.unverified]}</b><small>بلا اختبار</small></div>
        <div><b style="color:var(--miss)">${atlas.capabilityCounts[TRUTH.missing]}</b><small>غير موجودة</small></div>
      </div>
      <p class="sub" style="margin-top:6px">من ${atlas.stats.capabilities} قدرة · ${atlas.stats.domains} مجالًا</p>
    </div>
    <div class="box">
      <h4>مفتاح الحالات</h4>
      <div class="legend">
        ${Object.values(TRUTH).map((status) => `<span>${TRUTH_MARK[status]} ${esc(TRUTH_LABEL[status])}</span>`).join('')}
      </div>
    </div>
  </div>

  <footer>
    <div>مُولَّد من <b class="mono">src/design/system-atlas.js</b> — <span class="mono">npm run atlas:poster</span></div>
    <div>بصمة البيانات <b class="mono">${fingerprint}</b> · البصمة تغطّي كل حقل منشور، وكل رقم يُعاد اشتقاقه من حالات القدرات</div>
  </footer>
</body>
</html>
`;
}

export async function run({ check = false, facts = false } = {}) {
  if (facts) {
    const body = buildFacts();
    if (check) {
      const current = await readFile(FACTS_PATH, 'utf8').catch(() => null);
      if (current === null) {
        console.error(`missing: ${path.relative(ROOT, FACTS_PATH)} — run \`npm run atlas:facts\``);
        return 1;
      }
      const problems = verifyFacts(JSON.parse(current));
      for (const problem of problems) console.error(`  ${problem}`);
      if (current !== body || problems.length > 0) {
        console.error(`stale: ${path.relative(ROOT, FACTS_PATH)} — run \`npm run atlas:facts\``);
        return 1;
      }
      console.log(`atlas facts verified: ${JSON.parse(body).fingerprint} · every number re-derived from capability states`);
      return 0;
    }
    await mkdir(path.dirname(FACTS_PATH), { recursive: true });
    await writeFile(FACTS_PATH, body, 'utf8');
    console.log(`wrote ${path.relative(ROOT, FACTS_PATH)}`);
    return 0;
  }
  const wanted = buildHtml();
  if (check) {
    let current = null;
    try {
      current = await readFile(POSTER_PATH, 'utf8');
    } catch {
      console.error(`missing: ${path.relative(ROOT, POSTER_PATH)} — run \`npm run atlas:poster\``);
      return 1;
    }
    if (current !== wanted) {
      console.error(`stale: ${path.relative(ROOT, POSTER_PATH)} — run \`npm run atlas:poster\``);
      return 1;
    }
    const published = await readFile(FACTS_PATH, 'utf8').catch(() => null);
    const problems = published === null ? ['missing facts file'] : verifyFacts(JSON.parse(published));
    for (const problem of problems) console.error(`  ${problem}`);
    if (published !== buildFacts() || problems.length > 0) {
      console.error(`stale: ${path.relative(ROOT, FACTS_PATH)} — run \`npm run atlas:facts\``);
      return 1;
    }
    const atlas = buildAtlas({ root: ROOT });
    console.log(`atlas poster verified: fingerprint ${fingerprintOf(atlas)} covers every published number`);
    return 0;
  }
  await mkdir(path.dirname(POSTER_PATH), { recursive: true });
  await writeFile(POSTER_PATH, wanted, 'utf8');
  console.log(`wrote ${path.relative(ROOT, POSTER_PATH)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run({
    check: process.argv.includes('--check'),
    facts: process.argv.includes('--facts')
  });
}
