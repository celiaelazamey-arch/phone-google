#!/usr/bin/env node
/**
 * Render the bilingual System Atlas dashboard (VFE-011 / DEC-091).
 *
 * The owner asked for a dashboard, not a drawing: twelve domains, the measured coverage, each
 * domain's priority, state and named gap, the audit summary, the phase plan, and the next gap to
 * close — in Arabic and English, on the same data the poster and the facts file use.
 *
 * Nothing here is typed twice. Every number comes from `factsOf(buildAtlas())`, and the builder
 * refuses a facts payload that does not re-derive from the capability states. There is no date and
 * no "impact" line, because neither is measured anywhere in the audit.
 *
 * Usage:
 *   node scripts/render-atlas-dashboard.mjs           # write docs/design/system-atlas-dashboard.html
 *   node scripts/render-atlas-dashboard.mjs --check   # fail if it is stale
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
  verifyFacts
} from '../src/design/system-atlas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const DASHBOARD_PATH = path.join(ROOT, 'docs', 'design', 'system-atlas-dashboard.html');

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Bilingual labels. Arabic from the audit, English added here — one place, no per-card typing. */
export const LABEL = Object.freeze({
  status: {
    [TRUTH.verified]: { ar: TRUTH_LABEL[TRUTH.verified], en: 'Verified by a named test' },
    [TRUTH.unverified]: { ar: TRUTH_LABEL[TRUTH.unverified], en: 'No test names its file' },
    [TRUTH.partial]: { ar: TRUTH_LABEL[TRUTH.partial], en: 'Partly implemented' },
    [TRUTH.proposed]: { ar: TRUTH_LABEL[TRUTH.proposed], en: 'Proposed, not built' },
    [TRUTH.missing]: { ar: TRUTH_LABEL[TRUTH.missing], en: 'Not implemented' },
    [TRUTH.disabled]: { ar: TRUTH_LABEL[TRUTH.disabled], en: 'Present but off' },
    [TRUTH.blocked]: { ar: TRUTH_LABEL[TRUTH.blocked], en: 'Blocked' }
  },
  priority: {
    P0: { ar: 'أولوية قصوى', en: 'Highest priority' },
    P1: { ar: 'أولوية عالية', en: 'High priority' },
    P2: { ar: 'أولوية متوسطة', en: 'Medium priority' }
  }
});

const CLASS = {
  [TRUTH.verified]: 'ok',
  [TRUTH.unverified]: 'unv',
  [TRUTH.partial]: 'part',
  [TRUTH.proposed]: 'prop',
  [TRUTH.missing]: 'miss',
  [TRUTH.disabled]: 'off',
  [TRUTH.blocked]: 'blocked'
};

export const round = (value) => Math.round(value);

/** The mean of the twelve measured coverages — computed, never quoted. */
export function averageCoverage(facts) {
  const total = facts.domains.reduce((sum, domain) => sum + domain.coverage, 0);
  return facts.domains.length === 0 ? 0 : round(total / facts.domains.length);
}

/**
 * The next gap to close, derived from the owner's own order: the first missing capability in the
 * first P0 domain. Today that is «اكتشاف المعلومات المتضاربة»; if the audit changes, so does this.
 */
export function nextGap(facts) {
  const order = ['P0', 'P1', 'P2'];
  for (const priority of order) {
    for (const domain of facts.domains.filter((item) => item.priority === priority)) {
      const gap = domain.capabilities.find((capability) => capability.status === TRUTH.missing);
      if (gap) return { domain, gap, priority };
    }
  }
  return null;
}

/** What a card may say: a named gap, a named untested capability, or the honest all-clear. */
export function gapLine(domain) {
  const missing = domain.capabilities.filter((capability) => capability.status === TRUTH.missing);
  if (missing.length) {
    return {
      kind: 'gap',
      ar: `فجوة: ${missing.map((capability) => capability.ar).join(' · ')}`,
      en: `Gap: ${missing.map((capability) => capability.id).join(', ')}`
    };
  }
  const unverified = domain.capabilities.filter((capability) => capability.status === TRUTH.unverified);
  if (unverified.length) {
    return {
      kind: 'warn',
      ar: `بلا اختبار يسمّي ملفه: ${unverified.map((capability) => capability.ar).join(' · ')}`,
      en: `No test names: ${unverified.map((capability) => capability.id).join(', ')}`
    };
  }
  return { kind: 'done', ar: 'لا فجوة مقيسة', en: 'No measured gap' };
}

const ring = (percent) => `conic-gradient(var(--ring) ${percent * 3.6}deg, rgba(255,255,255,.10) 0deg)`;

export function buildHtml({ facts = factsOf(buildAtlas({ root: ROOT })) } = {}) {
  const problems = verifyFacts(facts);
  if (problems.length > 0) {
    throw new Error(`refusing to draw facts that do not re-derive from the audit:\n${problems.join('\n')}`);
  }
  const fingerprint = facts.fingerprint;
  const average = averageCoverage(facts);
  const next = nextGap(facts);
  const complete = facts.domains.filter((domain) => domain.status === TRUTH.verified).length;
  const partial = facts.domains.filter((domain) => domain.status === TRUTH.partial).length;
  const absent = facts.domains.length - complete - partial;

  const cards = facts.domains
    .map((domain, index) => {
      const gap = gapLine(domain);
      const status = LABEL.status[domain.status];
      const priority = LABEL.priority[domain.priority];
      const verifiedCount = domain.capabilities.filter((capability) => capability.status === TRUTH.verified).length;
      return `<article class="card ${CLASS[domain.status]}" data-domain="${esc(domain.id)}" data-coverage="${domain.coverage}" data-priority="${esc(domain.priority)}" lang="ar">
          <div class="card-top">
            <span class="idx mono">${String(index + 1).padStart(2, '0')}</span>
            <div class="names">
              <h3>${esc(domain.ar)}</h3>
              <p class="en" lang="en" dir="ltr">${esc(domain.en)}</p>
            </div>
            <span class="prio p-${esc(domain.priority.toLowerCase())}" title="${esc(priority.en)}">${esc(domain.priority)}</span>
          </div>
          <div class="mid">
            <div class="donut" style="background:${ring(domain.coverage)}"><span><b>${domain.coverage}%</b></span></div>
            <div class="meta">
              <p class="count">${verifiedCount} من ${domain.capabilities.length} متحققة <span class="en" lang="en" dir="ltr">${verifiedCount}/${domain.capabilities.length} verified</span></p>
              <p class="prio-say">${esc(priority.ar)} <span class="en" lang="en" dir="ltr">${esc(priority.en)}</span></p>
              <p class="state ${CLASS[domain.status]}"><span class="m">${TRUTH_MARK[domain.status]}</span> ${esc(status.ar)} <span class="en" lang="en" dir="ltr">${esc(status.en)}</span></p>
            </div>
          </div>
          <div class="bar" aria-hidden="true"><span style="width:${domain.coverage}%"></span></div>
          <p class="gap ${gap.kind}">${esc(gap.ar)} <span class="en" lang="en" dir="ltr">${esc(gap.en)}</span></p>
        </article>`;
    })
    .join('\n      ');

  const phases = facts.phases
    .map(
      (phase, index) => `<div class="phase p-${esc(phase.priority.toLowerCase())}">
            <b>${esc(phase.priority)}</b>
            <strong>${phase.domains}</strong>
            <span>مجالات <span class="en" lang="en" dir="ltr">domains</span></span>
            ${index < facts.phases.length - 1 ? '<i aria-hidden="true">←</i>' : ''}
          </div>`
    )
    .join('');

  const nextPanel = next
    ? `<section class="next" aria-labelledby="next-title">
        <div class="next-head">
          <h2 id="next-title">الأولوية التالية <span class="en" lang="en" dir="ltr">Next priority</span></h2>
          <span class="prio p-${esc(next.priority.toLowerCase())}">${esc(next.priority)}</span>
        </div>
        <p class="next-gap">${esc(next.gap.ar)} <span class="mono">${esc(next.gap.id)}</span></p>
        <p class="next-why">${esc(next.domain.ar)} · لم تُبنَ بعد: لا ملف ولا اختبار يسمّيها في التدقيق حتى الآن.
          <span class="en" lang="en" dir="ltr">${esc(next.domain.en)} · absent from the audit: no file and no test names it yet.</span></p>
        ${next.priority === 'P0' ? '' : '<p class="next-why" data-p0-clear="true">لا فجوة متبقية في P0 — كل ما تبقّى في P1 أو P2. <span class="en" lang="en" dir="ltr">No P0 gap remains; what is left sits in P1 or P2.</span></p>'}
      </section>`
    : '';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="celia-visual" content="generated:${ATLAS_VERSION}:fingerprint=${fingerprint}:source=src/design/system-atlas.js" />
<title>CeliaOS — System Atlas 2026 · لوحة المعلومات</title>
<style>
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2") format("woff2"); font-weight: 600; font-display: block; }
  @font-face { font-family: "Plex"; src: url("../../public/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2") format("woff2"); font-weight: 700; font-display: block; }
  @font-face { font-family: "Mono"; src: url("../../public/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
  :root{
    --bg:#050a18; --bg-2:#070f26; --panel:#0c1533; --panel-2:#101c45; --line:#1f2f66; --line-2:#2f4699;
    --txt:#eaf1ff; --mut:#9fb0dd; --blue:#38bdf8; --blue-2:#0ea5e9; --gold:#fbbf24; --gold-2:#f59e0b;
    --ok:#34d399; --part:#fbbf24; --miss:#f87171; --unv:#fb923c; --off:#94a3b8; --blocked:#a78bfa;
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:radial-gradient(1200px 600px at 80% -10%, #10204f 0%, transparent 60%), radial-gradient(900px 500px at 10% 110%, #0b1a3d 0%, transparent 55%), var(--bg);color:var(--txt);font-family:"Plex",system-ui,sans-serif;line-height:1.5}
  body{padding:28px 32px 22px;max-width:1500px;margin:0 auto}
  .mono{font-family:"Mono",monospace;direction:ltr;unicode-bidi:isolate}
  .en{font-family:"Plex",system-ui,sans-serif;direction:ltr;unicode-bidi:isolate;color:var(--mut);font-size:.8em}
  header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:14px;border-bottom:1px solid var(--line-2)}
  .brand{display:flex;align-items:center;gap:12px}
  .brand .star{width:38px;height:38px;color:var(--gold)}
  .brand h1{margin:0;font-size:26px;font-weight:700;letter-spacing:.2px}
  .brand h1 span{color:var(--gold)}
  .brand p{margin:2px 0 0;font-size:12.5px;color:var(--mut)}
  .subtitle{text-align:left}
  .subtitle h2{margin:0;font-size:21px;font-weight:700}
  .subtitle p{margin:2px 0 0;font-size:12px;color:var(--mut)}
  .seal{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:12px;border:1px solid var(--blue-2);background:linear-gradient(180deg,#0d2145,#0a1733);box-shadow:0 0 0 1px rgba(56,189,248,.15) inset}
  .seal b{display:block;font-size:12.5px}
  .seal small{display:block;font-size:11.5px;color:var(--mut)}
  .seal .tick{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--ok);color:#04240f;font-weight:700}

  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}
  .card{position:relative;border:1px solid var(--line);border-radius:14px;padding:12px 13px 11px;background:linear-gradient(180deg,var(--panel-2),var(--panel));overflow:hidden}
  .card::before{content:"";position:absolute;inset:0 auto auto 0;width:100%;height:2px;background:var(--line-2);opacity:.6}
  .card.ok::before{background:var(--ok)} .card.part::before{background:var(--part)} .card.miss::before{background:var(--miss)}
  .card-top{display:flex;align-items:flex-start;gap:8px}
  .idx{font-size:11.5px;color:var(--mut);border:1px solid var(--line-2);border-radius:6px;padding:1px 6px;background:#0a122c;font-family:"Mono",monospace}
  .names{flex:1}
  .names h3{margin:0;font-size:15px;font-weight:700;line-height:1.35}
  .names .en{margin:1px 0 0;font-size:10.5px}
  .prio{font-family:"Mono",monospace;font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid currentColor}
  .p-p0{color:var(--gold)} .p-p1{color:var(--blue)} .p-p2{color:#c4b5fd}
  .mid{display:flex;gap:11px;align-items:center;margin:9px 0 7px}
  .donut{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;position:relative}
  .donut::after{content:"";position:absolute;inset:6px;border-radius:50%;background:var(--panel)}
  .donut span{position:relative;z-index:1;font-size:15px;font-weight:700}
  .meta p{margin:0 0 2px;font-size:11.5px;line-height:1.45}
  .meta .count{font-weight:600}
  .meta .state{color:var(--mut)}
  .meta .state.ok{color:var(--ok)} .meta .state.part{color:var(--part)} .meta .state.miss{color:var(--miss)}
  .bar{height:5px;border-radius:99px;background:#0a122c;overflow:hidden;border:1px solid #16224c}
  .bar span{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--gold))}
  .gap{margin:7px 0 0;font-size:11.5px;padding:5px 8px;border-radius:8px;background:#0a122c;border:1px solid #17244f;color:var(--mut)}
  .gap.gap{border-color:#5b2230;background:#1c0f1a;color:#fca5a5}
  .gap.warn{border-color:#5c3d13;background:#1d150a;color:#fcd34d}
  .gap.done{border-color:#14503a;background:#071c16;color:#86efac}

  .lower{display:grid;grid-template-columns:1.15fr 1.5fr 1fr;gap:12px;margin-top:14px}
  .box{border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--panel-2),var(--panel));padding:12px 13px}
  .box h3{margin:0 0 9px;font-size:14px;font-weight:700;color:var(--gold)}
  .box h3 .en{font-size:.78em;color:var(--mut)}
  .phases{display:flex;align-items:center;gap:8px;justify-content:space-between}
  .phase{flex:1;border:1px solid var(--line-2);border-radius:11px;padding:7px 9px;text-align:center;background:#0a122c;position:relative}
  .phase b{display:block;font-family:"Mono",monospace;font-size:12px}
  .phase.p-p0 b{color:var(--gold)} .phase.p-p1 b{color:var(--blue)} .phase.p-p2 b{color:#c4b5fd}
  .phase strong{display:block;font-size:21px;line-height:1.1}
  .phase span{font-size:11px;color:var(--mut)}
  .phase i{position:absolute;left:-13px;top:50%;transform:translateY(-50%);font-style:normal;color:var(--mut)}

  .totals{display:flex;gap:10px;align-items:stretch}
  .totals .cell{flex:1;border:1px solid #182654;border-radius:10px;padding:7px 9px;background:#0a122c;text-align:center}
  .totals .cell b{display:block;font-size:20px;line-height:1.15}
  .totals .cell.ok b{color:var(--ok)} .totals .cell.unv b{color:var(--unv)} .totals .cell.miss b{color:var(--miss)} .totals .cell.all b{color:var(--gold)}
  .totals .cell small{display:block;font-size:10.5px;color:var(--mut);margin-top:1px}
  .overall{display:flex;gap:12px;align-items:center;margin-top:9px}
  .overall .donut{width:58px;height:58px}
  .overall .donut span{font-size:14px}
  .overall ul{list-style:none;margin:0;padding:0;font-size:11.5px;color:var(--mut)}
  .overall li{display:flex;justify-content:space-between;gap:8px;padding:1px 0}
  .overall li b{color:var(--txt)}

  .next{border:1px solid var(--gold-2);border-radius:14px;padding:12px 13px;background:linear-gradient(180deg,#1b1730,#12132b);box-shadow:0 0 0 1px rgba(251,191,36,.12) inset}
  .next-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .next-head h2{margin:0;font-size:14px;color:var(--gold)}
  .next-gap{margin:7px 0 5px;font-size:16px;font-weight:700}
  .next-gap .mono{font-size:.72em;color:var(--mut);margin-inline-start:6px}
  .next-why{margin:0;font-size:11.5px;color:var(--mut)}

  footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:11px;border-top:1px solid var(--line-2);font-size:11.5px;color:var(--mut)}
  footer .seal-mini{display:flex;align-items:center;gap:7px;padding:5px 10px;border:1px solid var(--blue-2);border-radius:999px;background:#0a1733}
  footer .seal-mini .mono{color:var(--blue)}
  .note{color:var(--mut)}
  @media (max-width:1240px){ .grid{grid-template-columns:repeat(3,1fr)} .lower{grid-template-columns:1fr 1fr} .next{grid-column:1 / -1} }
  @media (max-width:900px){ .grid{grid-template-columns:repeat(2,1fr)} .lower{grid-template-columns:1fr} body{padding:18px 16px} header{flex-wrap:wrap} }
  @media (max-width:560px){ .grid{grid-template-columns:1fr} }
</style>
</head>
<body>
  <header>
    <div class="brand">
      <svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.6l2.3 6.4 6.4 2.3-6.4 2.3-2.3 6.4-2.3-6.4L3.3 10.3l6.4-2.3z"/><circle cx="12" cy="10.3" r="1.8" fill="#050a18"/></svg>
      <div>
        <h1>Celia<span>OS</span></h1>
        <p>Crafted to Think · Learn · Grow</p>
      </div>
    </div>
    <div class="subtitle">
      <h2>System Atlas 2026</h2>
      <p>خريطة النظام الشاملة + لوحة المعلومات · <span lang="en" dir="ltr">System map &amp; bilingual dashboard</span></p>
    </div>
    <div class="seal">
      <span class="tick" aria-hidden="true">✓</span>
      <div>
        <b>تم التحقق من البيانات <span class="en" lang="en" dir="ltr">Data verified</span></b>
        <small>بصمة التدقيق <span class="mono">${fingerprint}</span></small>
      </div>
    </div>
  </header>

  <main>
    <section class="grid" aria-label="المجالات الاثنا عشر">
      ${cards}
    </section>

    <section class="lower">
      <div class="box">
        <h3>مراحل التطوير <span class="en" lang="en" dir="ltr">Roadmap</span></h3>
        <div class="phases">${phases}</div>
        <p class="note" style="margin:9px 0 0;font-size:11px">P0 أولًا، ولا يبدأ مجال قبل دليله. <span class="en" lang="en" dir="ltr">P0 first; no domain starts without its evidence.</span></p>
      </div>

      <div class="box">
        <h3>نتائج التدقيق <span class="en" lang="en" dir="ltr">Audit results</span></h3>
        <div class="totals">
          <div class="cell ok"><b>${facts.totals.verified}</b><small>متحققة باختبار <span class="en" lang="en" dir="ltr">verified</span></small></div>
          <div class="cell unv"><b>${facts.totals.unverified}</b><small>بلا اختبار يسمّي ملفها <span class="en" lang="en" dir="ltr">no test</span></small></div>
          <div class="cell miss"><b>${facts.totals.missing}</b><small>غائبة <span class="en" lang="en" dir="ltr">missing</span></small></div>
          <div class="cell all"><b>${facts.totals.capabilities}</b><small>إجمالي القدرات <span class="en" lang="en" dir="ltr">capabilities</span></small></div>
        </div>
        <div class="overall">
          <div class="donut" style="background:${ring(average)}"><span><b>${average}%</b></span></div>
          <ul>
            <li><span>متوسط التغطية المقيس <span class="en" lang="en" dir="ltr">measured average</span></span><b>${average}%</b></li>
            <li><span>مجالات مكتملة <span class="en" lang="en" dir="ltr">complete</span></span><b>${complete}</b></li>
            <li><span>مجالات جزئية <span class="en" lang="en" dir="ltr">partial</span></span><b>${partial}</b></li>
            <li><span>مجالات مفقودة <span class="en" lang="en" dir="ltr">absent</span></span><b>${absent}</b></li>
          </ul>
        </div>
      </div>

      ${nextPanel}
    </section>
  </main>

  <footer>
    <div class="seal-mini">
      <span aria-hidden="true">✓</span>
      <span>بصمة البيانات <span class="mono">${fingerprint}</span></span>
    </div>
    <div class="note">مُولَّد من <span class="mono">src/design/system-atlas.js</span> — <span class="mono">npm run atlas:dashboard</span> · لا تاريخ ولا نسبة غير مقيسة <span class="en" lang="en" dir="ltr">no date, no unmeasured ratio</span></div>
  </footer>
</body>
</html>
`;
}

export async function run({ check = false } = {}) {
  const wanted = buildHtml();
  if (!check) {
    await mkdir(path.dirname(DASHBOARD_PATH), { recursive: true });
    await writeFile(DASHBOARD_PATH, wanted, 'utf8');
    console.log(`wrote ${path.relative(ROOT, DASHBOARD_PATH)}`);
    return 0;
  }
  const current = await readFile(DASHBOARD_PATH, 'utf8').catch(() => null);
  if (current === null) {
    console.error(`missing: ${path.relative(ROOT, DASHBOARD_PATH)} — run \`npm run atlas:dashboard\``);
    return 1;
  }
  if (current !== wanted) {
    console.error(`stale: ${path.relative(ROOT, DASHBOARD_PATH)} — run \`npm run atlas:dashboard\``);
    return 1;
  }
  const facts = factsOf(buildAtlas({ root: ROOT }));
  console.log(`atlas dashboard verified: ${facts.domains.length} domains · ${facts.totals.capabilities} capabilities · fingerprint ${facts.fingerprint}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run({ check: process.argv.includes('--check') });
}
