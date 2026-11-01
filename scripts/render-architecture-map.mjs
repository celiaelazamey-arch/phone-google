#!/usr/bin/env node
/**
 * Render the Living Architecture Map from the source tree (VFE-003 / DEC-086).
 *
 * Nothing on this page is typed by hand: the components, their status, their activation and the
 * edges between them are computed from the imports in `src/` and `workers/` on every build. `--check`
 * fails when the committed page no longer matches the code, so the map ages honestly instead of
 * drifting silently.
 *
 * Usage:
 *   node scripts/render-architecture-map.mjs           # write docs/design/architecture-map.html
 *   node scripts/render-architecture-map.mjs --check   # fail if it is stale
 *   node scripts/render-architecture-map.mjs --impact <file...>   # print what a change touches
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCH_MAP_VERSION,
  LAYERS,
  TRUTH,
  TRUTH_LABEL,
  TRUTH_MARK,
  buildArchitectureMap,
  impactOf,
  scanModules
} from '../src/design/architecture-map.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PAGE_PATH = path.join(ROOT, 'docs', 'design', 'architecture-map.html');

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

const ORDER = ['runtime', 'intelligence', 'data', 'security', 'delivery'];
const NODE_W = 208;
const NODE_H = 56;
const COL_W = 262;
const ROW_H = 78;

export function layout(map) {
  const positions = new Map();
  let column = 0;
  for (const layer of ORDER) {
    const entries = map.components.filter((component) => component.layer === layer);
    entries.forEach((component, row) => {
      positions.set(component.id, { x: 24 + column * COL_W, y: 96 + row * ROW_H });
    });
    column += 1;
  }
  return { positions, width: 24 + ORDER.length * COL_W, height: 96 + Math.max(...ORDER.map((layer) => map.components.filter((c) => c.layer === layer).length)) * ROW_H + 40 };
}

export function buildSvg(map) {
  const { positions, width, height } = layout(map);
  const edges = map.edges
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      return `<path class="edge" data-from="${edge.from}" data-to="${edge.to}" d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" marker-end="url(#arrow)" />`;
    })
    .join('\n      ');
  const nodes = map.components
    .map((component) => {
      const position = positions.get(component.id);
      const palette = CLASS[component.status];
      return `<g class="node ${palette}" data-id="${component.id}" data-status="${component.status}" transform="translate(${position.x} ${position.y})" tabindex="0" role="button" aria-label="${esc(component.ar)} — ${esc(TRUTH_LABEL[component.status])}">
        <rect width="${NODE_W}" height="${NODE_H}" rx="12" />
        <text class="n-mark" x="${NODE_W - 14}" y="22" text-anchor="end">${TRUTH_MARK[component.status]}</text>
        <text class="n-title" x="14" y="26">${esc(component.ar)}</text>
        <text class="n-sub" x="14" y="44">${esc(component.files.length)} ملف · ${component.wired ? 'موصول بالمدخل' : 'غير موصول'}${component.activation.state === 'off_by_default' ? ' · معطّل افتراضيًا' : ''}</text>
      </g>`;
    })
    .join('\n      ');
  const bands = ORDER.map((layer, index) => {
    const x = 12 + index * COL_W;
    return `<text class="band" x="${x + 4}" y="72">${esc(LAYERS[layer])}</text>`;
  }).join('\n      ');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="خريطة معمارية حية لمكونات CeliaOS">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#3b4b8f" /></marker></defs>
      ${bands}
      <g class="edges">
      ${edges}
      </g>
      <g class="nodes">
      ${nodes}
      </g>
    </svg>`;
}

export function buildHtml() {
  const map = buildArchitectureMap({ root: ROOT });
  const cards = map.components
    .map(
      (component) => `<article class="card ${CLASS[component.status]}" data-id="${component.id}" data-status="${component.status}">
        <header><h3>${esc(component.ar)}</h3><span class="badge">${TRUTH_MARK[component.status]} ${esc(TRUTH_LABEL[component.status])}</span></header>
        <ul class="files">${component.files.map((file) => `<li class="mono">${esc(file)}</li>`).join('')}${
          component.missing.length ? `<li class="mono missing">⬜ ${esc(component.missing.join(' · '))} (غائب)</li>` : ''
        }</ul>
        <p class="meta">اختبارات تطال هذه الوحدات: ${component.tested.length}/${component.files.length} · ${
          component.wired ? 'موصول من مدخل تنفيذي' : 'غير موصول بعد'
        }${
          component.activation.state === 'off_by_default'
            ? ` · <span class="off-flag">⚪ معطّل افتراضيًا</span>`
            : ''
        }</p>
      </article>`
    )
    .join('\n      ');
  const filters = Object.values(TRUTH)
    .map((status) => `<button type="button" class="chip ${CLASS[status]}" data-filter="${status}">${TRUTH_MARK[status]} ${esc(TRUTH_LABEL[status])} <b>${map.stats.counts[status]}</b></button>`)
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="celia-visual" content="generated:${ARCH_MAP_VERSION}:source=src/design/architecture-map.js" />
<title>CeliaOS — Living Architecture Map</title>
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
  header.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding-bottom:20px;border-bottom:2px solid var(--line-2)}
  .logo{display:flex;align-items:center;gap:12px;font-size:32px;font-weight:700}
  .logo .star{color:var(--gold);font-size:28px}
  .logo b{color:var(--gold)}
  .tag{color:var(--mut);font-size:14px}
  .title{text-align:left;max-width:720px}
  .title h1{margin:0 0 6px;font-size:22px}
  .title p{margin:0;color:var(--mut);font-size:13.5px}
  .pill{display:inline-block;margin-top:8px;padding:4px 12px;border:1px solid var(--line-2);border-radius:999px;color:var(--gold);font-size:11.5px}
  h2.section{margin:26px 0 12px;font-size:17px;color:var(--gold);display:flex;align-items:center;gap:10px}
  h2.section:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line-2),transparent)}
  .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;text-align:center}
  .stat b{display:block;font-size:24px}
  .stat small{color:var(--mut);font-size:11.5px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:0}
  .chip{background:var(--panel);border:1px solid var(--line);color:var(--txt);border-radius:999px;padding:6px 12px;font-family:inherit;font-size:12px;cursor:pointer}
  .chip[aria-pressed="true"]{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset}
  .canvas{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--line-2);border-radius:14px;padding:8px;overflow:auto}
  svg .node rect{fill:#101a3d;stroke:#2c3a76;stroke-width:1.4}
  svg .node .n-title{fill:#eaf0ff;font-size:13px;font-weight:600}
  svg .node .n-sub{fill:#a9b6e8;font-size:10.5px}
  svg .node .n-mark{font-size:13px}
  svg .node{cursor:pointer;outline:none}
  svg .node.ok rect{stroke:var(--ok)} svg .node.part rect{stroke:var(--part)} svg .node.miss rect{stroke:var(--miss)}
  svg .node.unv rect{stroke:var(--unv)} svg .node.off rect{stroke:var(--off)} svg .node.prop rect{stroke:var(--prop)}
  svg .node.sel rect{stroke:var(--gold);stroke-width:2.6}
  svg .edge{fill:none;stroke:#31407f;stroke-width:1.2;opacity:.55}
  svg .edge.hot{stroke:var(--gold);opacity:1;stroke-width:2}
  svg .band{fill:#7b8cc9;font-size:12px}
  svg.dim .node:not(.sel):not(.near){opacity:.35}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .card{background:var(--panel);border:1px solid var(--line);border-right:4px solid var(--line-2);border-radius:12px;padding:11px 13px}
  .card header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
  .card h3{margin:0;font-size:13.5px}
  .card .badge{font-size:10.5px;color:var(--mut);white-space:nowrap}
  .card ul.files{list-style:none;margin:7px 0 6px;padding:0;display:flex;flex-wrap:wrap;gap:4px}
  .card ul.files li{font-size:10px;color:var(--cyan,#22d3ee);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
  .card ul.files li.missing{color:var(--miss)}
  .card .meta{margin:0;font-size:11px;color:var(--mut)}
  .off-flag{color:var(--off)}
  .card.ok{border-right-color:var(--ok)} .card.part{border-right-color:var(--part)} .card.miss{border-right-color:var(--miss)}
  .card.unv{border-right-color:var(--unv)} .card.off{border-right-color:var(--off)} .card.prop{border-right-color:var(--prop)}
  .card.hidden{display:none}
  .legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--mut);font-size:11.5px}
  footer{margin-top:24px;padding-top:12px;border-top:2px solid var(--line-2);display:flex;justify-content:space-between;color:var(--mut);font-size:11.5px}
</style>
</head>
<body>
  <header class="top">
    <div>
      <div class="logo"><span class="star">✦</span><span>Celia<b>OS</b></span></div>
      <div class="tag">Engineering Center · Visual Engineering System</div>
    </div>
    <div class="title">
      <h1>Living Architecture Map — الخريطة الحية</h1>
      <p>مولَّدة من استيرادات <span class="mono">src/</span> و<span class="mono">workers/</span> في كل بناء؛ الحالة تُحسب ولا تُكتب.</p>
      <span class="pill mono">${ARCH_MAP_VERSION}</span>
    </div>
  </header>

  <h2 class="section">ما قيس الآن</h2>
  <div class="stats">
    <div class="stat"><b>${map.stats.modules}</b><small>وحدة برمجية</small></div>
    <div class="stat"><b>${map.stats.edges}</b><small>اعتمادية داخلية</small></div>
    <div class="stat"><b>${map.stats.components}</b><small>مكوّنًا</small></div>
    <div class="stat"><b style="color:var(--ok)">${map.stats.verified}</b><small>متحقق</small></div>
    <div class="stat"><b style="color:var(--part)">${map.stats.partial}</b><small>جزئي</small></div>
  </div>

  <h2 class="section">الخريطة — اضغط أي مكوّن لعرض علاقاته</h2>
  <div class="chips" id="chips">${filters}<button type="button" class="chip" id="reset">إظهار الكل</button></div>
  <div class="canvas" style="margin-top:10px">${buildSvg(map)}</div>
  <div class="legend" style="margin-top:8px">
    <span>🟢 منفّذ ومتحقق</span><span>🟠 منفّذ وغير متحقق</span><span>🟡 جزئي</span><span>🔵 مقترح</span><span>🔴 غير منفّذ</span><span>⚪ موجود ومعطّل</span><span>⛔ محجوب</span>
    <span>الخط: اعتمادية مقروءة من الاستيراد الفعلي</span>
  </div>

  <h2 class="section">المكوّنات وملفاتها</h2>
  <div class="grid" id="grid">
      ${cards}
  </div>

  <footer>
    <div>مُولَّد من <b class="mono">src/design/architecture-map.js</b> — لا يُحرَّر يدويًا؛ <span class="mono">npm run arch:map</span>.</div>
    <div>${map.stats.counts[TRUTH.verified]} متحقق · ${map.stats.counts[TRUTH.unverified]} غير متحقق · ${map.stats.counts[TRUTH.partial]} جزئي · ${map.stats.counts[TRUTH.missing]} غائب</div>
  </footer>

<script>
  const nodes = [...document.querySelectorAll('svg .node')];
  const edges = [...document.querySelectorAll('svg .edge')];
  const cards = [...document.querySelectorAll('#grid .card')];
  const svg = document.querySelector('svg.canvas svg') || document.querySelector('svg');
  function select(id) {
    for (const node of nodes) node.classList.toggle('sel', node.dataset.id === id);
    for (const card of cards) card.classList.toggle('sel', card.dataset.id === id);
    const near = new Set([id]);
    for (const edge of edges) {
      const hot = edge.dataset.from === id || edge.dataset.to === id;
      edge.classList.toggle('hot', hot);
      if (hot) { near.add(edge.dataset.from); near.add(edge.dataset.to); }
    }
    for (const node of nodes) node.classList.toggle('near', near.has(node.dataset.id));
    if (svg) svg.classList.toggle('dim', true);
  }
  for (const node of nodes) {
    node.addEventListener('click', () => select(node.dataset.id));
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') select(node.dataset.id); });
  }
  let active = null;
  for (const chip of document.querySelectorAll('#chips .chip[data-filter]')) {
    chip.addEventListener('click', () => {
      active = active === chip.dataset.filter ? null : chip.dataset.filter;
      for (const other of document.querySelectorAll('#chips .chip')) other.setAttribute('aria-pressed', 'false');
      if (active) chip.setAttribute('aria-pressed', 'true');
      for (const card of cards) card.classList.toggle('hidden', Boolean(active) && card.dataset.status !== active);
      for (const node of nodes) node.style.display = active && node.dataset.status !== active ? 'none' : '';
      for (const edge of edges) {
        const visible = !active || nodes.some((node) => node.dataset.id === edge.dataset.from && node.style.display !== 'none') && nodes.some((node) => node.dataset.id === edge.dataset.to && node.style.display !== 'none');
        edge.style.display = visible ? '' : 'none';
      }
    });
  }
  document.getElementById('reset').addEventListener('click', () => {
    active = null;
    for (const node of nodes) { node.style.display = ''; node.classList.remove('sel'); }
    for (const edge of edges) { edge.style.display = ''; edge.classList.remove('hot'); }
    for (const card of cards) card.classList.remove('hidden', 'sel');
    if (svg) svg.classList.remove('dim');
    for (const chip of document.querySelectorAll('#chips .chip')) chip.setAttribute('aria-pressed', 'false');
  });
</script>
</body>
</html>
`;
}

export function buildImpactReport(files, { root = ROOT } = {}) {
  const map = buildArchitectureMap({ root });
  const modules = scanModules(root);
  const impact = impactOf(files, map, modules);
  return { map, impact };
}

export async function run({ check = false, impact = null } = {}) {
  if (impact) {
    const { map, impact: result } = buildImpactReport(impact);
    const name = (id) => map.components.find((component) => component.id === id)?.ar || id;
    console.log(`Changed files: ${result.files.length}`);
    if (result.components.length) console.log(`Components: ${result.components.map(name).join(' · ')}`);
    console.log(`Modules reached: ${result.modules.length}`);
    if (result.unmapped.length) console.log(`Outside the map: ${result.unmapped.join(', ')}`);
    return 0;
  }
  const wanted = buildHtml();
  if (check) {
    let current = null;
    try {
      current = await readFile(PAGE_PATH, 'utf8');
    } catch {
      console.error(`missing: ${path.relative(ROOT, PAGE_PATH)} — run \`npm run arch:map\``);
      return 1;
    }
    if (current !== wanted) {
      console.error(`stale: ${path.relative(ROOT, PAGE_PATH)} — run \`npm run arch:map\``);
      return 1;
    }
    const map = buildArchitectureMap({ root: ROOT });
    console.log(
      `architecture map verified: ${map.stats.components} components · ${map.stats.modules} modules · ${map.stats.verified} verified`
    );
    return 0;
  }
  await mkdir(path.dirname(PAGE_PATH), { recursive: true });
  await writeFile(PAGE_PATH, wanted, 'utf8');
  console.log(`wrote ${path.relative(ROOT, PAGE_PATH)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const impactIndex = process.argv.indexOf('--impact');
  const impact = impactIndex === -1 ? null : process.argv.slice(impactIndex + 1).filter((arg) => !arg.startsWith('--'));
  process.exitCode = await run({ check: process.argv.includes('--check'), impact });
}
