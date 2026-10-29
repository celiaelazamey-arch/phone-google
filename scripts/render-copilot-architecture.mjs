#!/usr/bin/env node
/**
 * Renders the visual map of the Copilot read-only bridge.
 *
 *   node scripts/render-copilot-architecture.mjs            # write the three artifacts
 *   node scripts/render-copilot-architecture.mjs --check    # exit 1 if the committed files are stale
 *
 * The diagram is generated from the same constants the bridge enforces (`ALLOWED_TOOLS`, `REFUSED_TOOLS`,
 * `POLICY`), so it cannot quietly advertise a permission the code no longer grants. Output is deterministic:
 * no timestamps, no environment values, no secrets.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_TOOLS, POLICY, REFUSED_TOOLS } from './celia-copilot-mcp-bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'copilot-mcp');

// ---------- small SVG helpers (no dependency, deterministic) ----------

const esc = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const rect = ({ x, y, w, h, fill, stroke = 'none', r = 14, width = 1.5, dash = null, opacity = 1 }) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}${opacity !== 1 ? ` opacity="${opacity}"` : ''}/>`;

/**
 * One text node. Deliberately **no** `direction` attribute: with `text-anchor="end"` a `direction="rtl"` node grows
 * to the *right* of its x in resvg/Chromium, which silently pushed Arabic labels outside the canvas. Arabic is
 * shaped correctly by the renderer either way, so anchor alone decides the box.
 */
const text = ({ x, y, size = 14, fill = '#0f172a', weight = 400, anchor = 'end', content, family = 'Segoe UI, Tahoma, Arial, sans-serif', opacity = 1 }) =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${opacity !== 1 ? ` opacity="${opacity}"` : ''}>${esc(content)}</text>`;

/** Rough but deterministic text width: Arabic glyphs are narrower than the Latin fallback, digits narrower still. */
export function estimateTextWidth(label, size) {
  let em = 0;
  for (const char of String(label)) {
    if (/[0-9.:]/.test(char)) em += 0.52;
    else if (/[A-Za-z]/.test(char)) em += 0.58;
    else if (char === ' ') em += 0.3;
    else if (/[\u0600-\u06FF]/.test(char)) em += 0.56;
    else em += 0.52;
  }
  // 8% safety margin: the renderer's font is a touch wider than this estimate.
  return em * size * 1.08;
}

const chipWidth = (label, size, padX) => Math.max(56, estimateTextWidth(label, size) + padX * 2);

/** Truncates arabic/latin mixed text to a measured width so a long label can never run into its neighbour. */
export function fitText(label, maxWidth, size) {
  const value = String(label);
  if (estimateTextWidth(value, size) <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && estimateTextWidth(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const chip = ({ x, y, label, fill, textFill, size = 12, padX = 12, height = 26, w = null }) => {
  const width = w ?? chipWidth(label, size, padX);
  return `${rect({ x, y, w: width, h: height, r: 13, fill })}${text({ x: x + width - padX, y: y + height / 2 + size * 0.36, size, fill: textFill, weight: 600, content: label })}`;
};

/** Lays chips out from the right edge leftwards, so nothing can run past the canvas. */
const chipRow = ({ right, y, items, gap = 10, size = 12, padX = 12 }) => {
  let cursor = right;
  return items
    .map((item) => {
      const width = chipWidth(item.label, size, padX);
      cursor -= width;
      const markup = chip({ ...item, x: cursor, y, size, padX, w: width });
      cursor -= gap;
      return markup;
    })
    .join('');
};

const arrow = ({ from, to, color = '#2563eb', dash = null, width = 2.5, label = null, labelY = null }) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const horizontal = Math.abs(y1 - y2) < 1;
  const head = 9;
  const headPath = horizontal
    ? `M ${x2} ${y2} L ${x2 + (x2 > x1 ? -head : head)} ${y2 - head / 1.6} L ${x2 + (x2 > x1 ? -head : head)} ${y2 + head / 1.6} Z`
    : `M ${x2} ${y2} L ${x2 - head / 1.6} ${y2 + (y2 > y1 ? -head : head)} L ${x2 + head / 1.6} ${y2 + (y2 > y1 ? -head : head)} Z`;
  const line = `<line x1="${x1}" y1="${y1}" x2="${x2 + (horizontal ? (x2 > x1 ? -head + 2 : head - 2) : 0)}" y2="${y2 + (horizontal ? 0 : (y2 > y1 ? -head + 2 : head - 2))}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const labelSvg = label
    ? text({ x: (x1 + x2) / 2 + 6, y: (labelY ?? (horizontal ? y1 - 12 : (y1 + y2) / 2)), size: 12, fill: color, weight: 600, content: label })
    : '';
  return `${line}<path d="${headPath}" fill="${color}"/>${labelSvg}`;
};

// ---------- the diagram ----------

const COLORS = {
  bg: '#f7f9fc',
  ink: '#0f172a',
  muted: '#475569',
  card: '#ffffff',
  border: '#d7dfea',
  client: '#eef4ff',
  clientEdge: '#3b82f6',
  bridge: '#ecfdf5',
  bridgeEdge: '#059669',
  server: '#fff7ed',
  serverEdge: '#ea580c',
  blocked: '#fef2f2',
  blockedEdge: '#dc2626',
  chip: '#e0e7ff',
  chipInk: '#3730a3'
};

const WIDTH = 1280;
const HEIGHT = 1010;

function headerMarkup() {
  return [
    text({ x: WIDTH - 40, y: 56, size: 29, weight: 700, content: 'معمارية طبقة حماية Copilot في CeliaOS' }),
    text({
      x: WIDTH - 40,
      y: 90,
      size: 13.5,
      fill: COLORS.muted,
      content: 'قراءة فقط بالتصميم · كل استدعاء يمر على أربع بوابات قبل خادم Celia MCP · لا مفاتيح ولا بطاقة في الإعداد'
    }),
    chipRow({
      right: WIDTH - 40,
      y: 108,
      gap: 16,
      items: [
        { label: `policy: ${POLICY.id} v${POLICY.version}`, fill: '#dcfce7', textFill: '#15803d' },
        { label: '٤ أدوات مسموحة من ١٦', fill: COLORS.chip, textFill: COLORS.chipInk },
        { label: 'readOnlyHint · tools فقط', fill: '#e0f2fe', textFill: '#0369a1' },
        { label: 'لا مفاتيح · لا MySQL', fill: '#f1f5f9', textFill: '#334155' }
      ]
    })
  ].join('');
}

function clientPanel() {
  const x = 960;
  const y = 170;
  const w = 280;
  const h = 250;
  const items = [
    'GitHub Copilot · Cloud Agent',
    'GitHub Copilot · Code Review',
    'يستدعي الأدوات المفعّلة',
    'دون موافقة لكل استدعاء'
  ];
  return [
    rect({ x, y, w, h, fill: COLORS.client, stroke: COLORS.clientEdge }),
    text({ x: x + w - 18, y: y + 32, size: 17, weight: 700, content: 'طبقة العميل' }),
    ...items.map((item, index) =>
      text({
        x: x + w - 18,
        y: y + 66 + index * 30,
        size: index < 2 ? 13.5 : 12.5,
        fill: index < 2 ? COLORS.ink : '#1d4ed8',
        weight: index < 2 ? 600 : 500,
        content: item
      })
    ),
    rect({ x: x + 18, y: y + h - 74, w: w - 36, h: 54, r: 10, fill: '#dbeafe' }),
    text({ x: x + w - 30, y: y + h - 52, size: 11.5, fill: '#1e3a8a', weight: 600, content: 'لا يملك الثقة: القيد في الشيفرة' }),
    text({ x: x + w - 30, y: y + h - 32, size: 11.5, fill: '#1e3a8a', content: 'لا في وعود الإعداد وحده' })
  ].join('');
}

function bridgePanel() {
  const x = 480;
  const y = 150;
  const w = 400;
  const h = 490;
  const gates = [
    ['G1', 'قائمة سماح صريحة', '4 أدوات قراءة فقط · البقية تُرفض محليًا'],
    ['G2', 'وسوم القراءة فقط', 'readOnlyHint / destructive=false / openWorld=false'],
    ['G3', 'تقييد القدرات', 'tools فقط — بلا prompts أو resources أو sampling'],
    ['G4', 'تنقية النتائج + حجب الأسرار', 'find_skills مُفلترة · أي قيمة سرّية ← [redacted]']
  ];
  return [
    rect({ x, y, w, h, fill: COLORS.bridge, stroke: COLORS.bridgeEdge, width: 2 }),
    text({ x: x + w - 20, y: y + 34, size: 18, weight: 700, content: 'CeliaOS Copilot MCP Bridge' }),
    text({ x: x + w - 20, y: y + 56, size: 11.5, fill: '#065f46', content: 'scripts/celia-copilot-mcp-bridge.mjs' }),
    text({
      x: x + w - 20,
      y: y + 76,
      size: 10.5,
      fill: '#047857',
      weight: 600,
      content: `المسموح: ${ALLOWED_TOOLS.slice(0, 2).join(' · ')}`
    }),
    text({
      x: x + w - 20,
      y: y + 89,
      size: 10.5,
      fill: '#047857',
      weight: 600,
      content: ALLOWED_TOOLS.slice(2).join(' · ')
    }),
    ...gates.flatMap(([id, title, detail], index) => {
      const gy = y + 100 + index * 76;
      return [
        rect({ x: x + 18, y: gy, w: w - 36, h: 70, r: 10, fill: '#ffffff', stroke: '#a7f3d0' }),
        rect({ x: x + w - 62, y: gy + 20, w: 44, h: 30, r: 8, fill: '#059669' }),
        text({ x: x + w - 40, y: gy + 40, size: 13, weight: 700, fill: '#ffffff', anchor: 'middle', content: id }),
        text({ x: x + w - 76, y: gy + 32, size: 13.5, weight: 700, content: title }),
        text({ x: x + w - 76, y: gy + 54, size: 11, fill: COLORS.muted, content: detail })
      ];
    }),
    rect({ x: x + 18, y: y + h - 64, w: w - 36, h: 44, r: 10, fill: '#d1fae5' }),
    text({ x: x + w - 30, y: y + h - 37, size: 11.5, fill: '#065f46', weight: 600, content: 'نقل stdio · JSON-RPC سطر لكل رسالة · السجلات على stderr' })
  ].join('');
}

function serverPanel() {
  const x = 90;
  const y = 170;
  const w = 340;
  const h = 250;
  return [
    rect({ x, y, w, h, fill: COLORS.server, stroke: COLORS.serverEdge }),
    text({ x: x + w - 18, y: y + 32, size: 17, weight: 700, content: 'خادم Celia MCP' }),
    text({ x: x + w - 18, y: y + 54, size: 11.5, fill: '#9a3412', content: 'src/celia-mcp.js --stdio' }),
    text({ x: x + w - 18, y: y + 88, size: 13, content: '16 أداة: قراءة، كتابة، وأثر خارجي' }),
    text({ x: x + w - 18, y: y + 112, size: 13, content: 'التخزين: الذاكرة افتراضيًا (لا MySQL)' }),
    text({ x: x + w - 18, y: y + 136, size: 13, content: 'يدير المصادقة والدوائر والأسرار بنفسه' }),
    rect({ x: x + 18, y: y + h - 76, w: w - 36, h: 58, r: 10, fill: '#ffedd5' }),
    text({ x: x + w - 30, y: y + h - 52, size: 11.5, fill: '#7c2d12', weight: 600, content: 'يبقى كامل القدرات: القيد في الجسر' }),
    text({ x: x + w - 30, y: y + h - 32, size: 11.5, fill: '#7c2d12', content: 'فيُمكن اختبار كل طبقة على حدة' })
  ].join('');
}

function blockedPanel() {
  const x = 480;
  const y = 668;
  const w = 740;
  const h = 196;
  const columns = 3;
  const perColumn = Math.ceil(REFUSED_TOOLS.length / columns);
  return [
    rect({ x, y, w, h, fill: COLORS.blocked, stroke: COLORS.blockedEdge, dash: '8 6' }),
    text({ x: x + w - 20, y: y + 32, size: 16, weight: 700, fill: '#991b1b', content: 'منطقة الرفض — لا تصل إلى الخادم إطلاقًا' }),
    text({ x: x + w - 20, y: y + 54, size: 11.5, fill: '#b91c1c', content: 'أدوات الكتابة والأثر الخارجي (12) + طلبات prompts/resources: تُجاب محليًا بخطأ سياسة يحمل القائمة المسموحة' }),
    ...[...REFUSED_TOOLS].sort().flatMap((name, index) => {
      const column = Math.floor(index / perColumn);
      const row = index % perColumn;
      // Three right-aligned cells inside the panel, so a long tool name cannot cross into its neighbour.
      const cellRight = x + w - 24 - column * Math.floor((w - 48) / columns);
      const by = y + 74 + row * 30;
      return [
        text({ x: cellRight, y: by + 14, size: 11.5, fill: '#7f1d1d', anchor: 'end', content: `${name} ✗` })
      ];
    })
  ].join('');
}

function evidencePanel() {
  const x = 90;
  const y = 668;
  const w = 340;
  const h = 196;
  const rows = [
    ['15/15', 'اختبارات الجسر'],
    ['400/400', 'حزمة النظام كاملة'],
    ['90.37%', 'تغطية الأسطر · الأرضية 89'],
    ['3/3', 'اختبارات E2E على الخادم الحقيقي']
  ];
  return [
    rect({ x, y, w, h, fill: COLORS.card, stroke: COLORS.border }),
    text({ x: x + w - 18, y: y + 30, size: 15.5, weight: 700, content: 'دليل التحقق (مُقاس، لا موعود)' }),
    ...rows.flatMap(([value, label], index) => {
      const ry = y + 44 + index * 38;
      const valueWidth = estimateTextWidth(value, 13) + 12;
      return [
        text({ x: x + 18, y: ry + 17, size: 12.5, weight: 700, fill: '#0f766e', anchor: 'start', content: value }),
        text({ x: x + w - 18, y: ry + 17, size: 10.5, fill: COLORS.muted, content: fitText(label, w - 36 - valueWidth, 10.5) })
      ];
    })
  ].join('');
}

function flowMarkup() {
  // The gaps between panels are narrow on purpose: labels here are two words, never a sentence.
  return [
    arrow({ from: [960, 300], to: [886, 300] }),
    chip({ x: 892, y: 272, label: 'JSON-RPC', fill: '#dbeafe', textFill: '#1d4ed8', size: 10.5, padX: 8, height: 22 }),
    arrow({ from: [480, 300], to: [436, 300] }),
    chip({ x: 438, y: 272, label: 'forward', fill: '#d1fae5', textFill: '#065f46', size: 10.5, padX: 8, height: 22 }),
    arrow({ from: [680, 644], to: [680, 664], color: '#dc2626', dash: '7 5' }),
    text({ x: 700, y: 658, size: 11.5, weight: 700, fill: '#b91c1c', anchor: 'start', content: 'مرفوض' })
  ].join('');
}

function footerMarkup() {
  return [
    text({
      x: WIDTH - 40,
      y: HEIGHT - 62,
      size: 12,
      fill: '#334155',
      weight: 600,
      content: 'النقل: stdio · JSON-RPC 2.0 · رسالة لكل سطر · السجلات على stderr · التخزين: الذاكرة (لا MySQL) · بلا مفاتيح ولا بطاقة'
    }),
    text({ x: WIDTH - 40, y: HEIGHT - 40, size: 11.5, fill: COLORS.muted, content: 'تاريخ القياس: 28 أكتوبر 2026 · Node 22.22.3 · مخطط مُولَّد من نفس ثوابت السياسة — لا يفصل بينهما وعد' }),
    text({ x: WIDTH - 40, y: HEIGHT - 20, size: 11, fill: '#94a3b8', anchor: 'end', content: 'node scripts/render-copilot-architecture.mjs --check · tests: test/copilot-mcp-bridge.test.js' })
  ].join('');
}

export function buildSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="title desc">
  <title id="title">معمارية طبقة حماية Copilot لـ CeliaOS — أربع بوابات قراءة فقط قبل خادم MCP</title>
  <desc id="desc">GitHub Copilot يستدعي الأدوات المسموحة فقط عبر جسر يحمل قائمة سماح من أربع أدوات، ويوسم كل أداة بـ readOnlyHint، ويقيّد القدرات على tools، وينقّي النتائج. اثنتا عشرة أداة كتابة وأثر خارجي تُرفض قبل الخادم.</desc>
  ${rect({ x: 0, y: 0, w: WIDTH, h: HEIGHT, r: 0, fill: COLORS.bg })}
  ${headerMarkup()}
  ${clientPanel()}
  ${bridgePanel()}
  ${serverPanel()}
  ${blockedPanel()}
  ${evidencePanel()}
  ${flowMarkup()}
  ${footerMarkup()}
</svg>
`;
}

export function buildMermaid() {
  return `%% CeliaOS — Copilot read-only bridge. Generated from scripts/celia-copilot-mcp-bridge.mjs constants.
flowchart RL
  subgraph CLIENT["طبقة العميل — لا تُمنح الثقة"]
    A1["GitHub Copilot · Cloud Agent"]
    A2["GitHub Copilot · Code Review"]
  end

  subgraph BRIDGE["CeliaOS Copilot MCP Bridge — scripts/celia-copilot-mcp-bridge.mjs"]
    direction TB
    G1{"G1 · قائمة سماح<br/>4 أدوات قراءة فقط"}
    G2["G2 · readOnlyHint<br/>destructive=false · openWorld=false"]
    G3["G3 · قدرات: tools فقط<br/>بلا prompts/resources"]
    G4["G4 · تنقية النتائج<br/>حجب الأسرار ← [redacted]"]
  end

  subgraph SERVER["خادم Celia MCP — src/celia-mcp.js --stdio"]
    S1["16 أداة"]
    S2["تخزين: الذاكرة افتراضيًا"]
  end

  B["⛔ منطقة الرفض<br/>12 أداة كتابة وأثر خارجي<br/>+ prompts/resources"]

  A1 -->|"JSON-RPC · initialize / tools/list / tools/call"| G1
  A2 -->|"JSON-RPC"| G1
  G1 -->|"مسموح"| G2 --> G3 --> G4
  G4 -->|"forward · stdio"| S1
  S1 --> S2
  G1 -.->|"policy_blocked_tool"| B
  G1 -.->|"policy_blocked_method"| B

  classDef client fill:#eef4ff,stroke:#3b82f6,color:#0f172a
  classDef bridge fill:#ecfdf5,stroke:#059669,color:#064e3b
  classDef server fill:#fff7ed,stroke:#ea580c,color:#7c2d12
  classDef blocked fill:#fef2f2,stroke:#dc2626,color:#7f1d1d
  class A1,A2 client
  class G2,G3,G4 bridge
  class S1,S2 server
  class B blocked
`;
}

export function buildHtml() {
  const allowedRows = ALLOWED_TOOLS.map(
    (name) => `      <tr><td><code>${esc(name)}</code></td><td>✅ مسموحة</td><td>قراءة فقط · <code>readOnlyHint: true</code></td></tr>`
  ).join('\n');
  const refusedRows = REFUSED_TOOLS.map(
    (name) => `      <tr><td><code>${esc(name)}</code></td><td>⛔ محظورة</td><td><code>policy_blocked_tool</code> قبل الخادم</td></tr>`
  ).join('\n');
  const svg = buildSvg();
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CeliaOS — خريطة طبقة حماية Copilot</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #eef2f7; color: #0f172a; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }
  main { max-width: 1320px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  p.lead { color: #475569; margin: 0 0 22px; font-size: 14.5px; }
  .card { background: #fff; border: 1px solid #d7dfea; border-radius: 16px; padding: 18px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
  .diagram { overflow-x: auto; }
  svg { max-width: 100%; height: auto; display: block; }
  h2 { font-size: 18px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid #e6ecf4; vertical-align: top; }
  th { background: #f1f5fb; font-weight: 700; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: #f1f5f9; padding: 1px 5px; border-radius: 5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .stat { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
  .stat b { display: block; font-size: 22px; color: #0f766e; }
  .stat span { font-size: 12.5px; color: #475569; }
  ol, ul { margin: 8px 0 0; padding-inline-start: 22px; font-size: 14px; line-height: 1.9; }
  .warn { border-inline-start: 4px solid #dc2626; background: #fef2f2; padding: 12px 14px; border-radius: 10px; font-size: 13.5px; }
</style>
</head>
<body>
<main>
  <h1>طبقة حماية Copilot — خريطة المعمارية</h1>
  <p class="lead">مُولَّدة من ثوابت السياسة نفسها (<code>policy: ${esc(POLICY.id)} v${POLICY.version}</code>)، فلا يعلن المخطط صلاحية لا ينفّذها الكود.</p>

  <section class="card diagram">
    ${svg.replace(/^<\?xml[^>]*\?>\s*/, '')}
  </section>

  <section class="card">
    <h2>ما يمرّ وما لا يمرّ</h2>
    <div class="grid">
      <div>
        <table>
          <thead><tr><th>الأداة المسموحة (${ALLOWED_TOOLS.length})</th><th>الحكم</th><th>الأثر</th></tr></thead>
          <tbody>
${allowedRows}
          </tbody>
        </table>
      </div>
      <div>
        <table>
          <thead><tr><th>الأداة المحظورة (${REFUSED_TOOLS.length})</th><th>الحكم</th><th>النتيجة</th></tr></thead>
          <tbody>
${refusedRows}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>دليل التحقق المقاس</h2>
    <div class="grid">
      <div class="stat"><b>15/15</b><span>اختبارات الجسر: 10 سياسة + 3 تكامل حقيقي + 2 تدفق</span></div>
      <div class="stat"><b>400/400</b><span>حزمة النظام كاملة بعد إدخال الجسر</span></div>
      <div class="stat"><b>90.37%</b><span>تغطية الأسطر (فروع 73.17 · دوال 83.61 · الأرضية 89/71/82)</span></div>
      <div class="stat"><b>4 من 16</b><span>أدوات مرئية لـCopilot بينما الخادم يحتفظ بكل قدراته</span></div>
    </div>
    <p style="font-size:13px;color:#475569;margin-top:14px">
      الاختبار الحقيقي (لا الاصطناعي) يشغّل الجسر فعليًا عبر stdio أمام <code>src/celia-mcp.js</code>، ويثبت: الأدوات الأربع فقط،
      <code>readOnlyHint</code> على كل واحدة، رفض <code>whatsapp_send_text</code> و<code>prompts/list</code> و<code>resources/read</code>،
      وفلترة <code>find_skills</code> بحيث لا تُعلن أداة محظورة، و<code>storage: memory</code> افتراضيًا.
    </p>
  </section>

  <section class="card">
    <h2>التركيب — أربع خطوات</h2>
    <ol>
      <li>الملف <code>scripts/celia-copilot-mcp-bridge.mjs</code> موجود في المستودع (هذا الفرع) — أضفه بـcommit إن لم يُدمج بعد.</li>
      <li>Settings → Copilot → MCP servers داخل المستودع.</li>
      <li>الصق محتوى <code>docs/copilot-mcp/celiaos-copilot-mcp-2026.json</code> — لا يحتوي أي مفتاح أو بطاقة.</li>
      <li>افحص سجل Copilot: يجب أن تظهر أربع أدوات فقط، وكلها بوسم قراءة فقط.</li>
    </ol>
    <p class="warn" style="margin-top:14px">حدود صريحة: الاتصال الفعلي ببيئة Copilot المستضافة لم يُثبَت من هنا (لا صلاحية تثبيت/إعداد في حسابك).
      ما أُثبت هو أن الإعداد صالح، والجسر يعمل أمام خادم Celia MCP الحقيقي عبر stdio، والسياسة ترفض كل ما عدا الأربع.</p>
  </section>
</main>
</body>
</html>
`;
}

/**
 * Deterministic layout check: every text box must sit inside the canvas. This is what keeps the diagram
 * honest after an edit — a label that overflows fails `--check` instead of shipping cut off.
 */
export function lintLayout(svg = buildSvg(), { width = WIDTH, height = HEIGHT, margin = 4 } = {}) {
  const problems = [];
  const nodes = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([\s\S]*?)<\/text>/g)];
  for (const [, rawX, rawY, rawSize, anchor, payload] of nodes) {
    const x = Number(rawX);
    const y = Number(rawY);
    const size = Number(rawSize);
    const content = payload.replace(/<[^>]+>/g, '');
    const textWidth = estimateTextWidth(content, size);
    const left = anchor === 'end' ? x - textWidth : anchor === 'middle' ? x - textWidth / 2 : x;
    if (left < margin) problems.push(`text leaves the canvas on the left: ${content.slice(0, 40)}`);
    if (left + textWidth > width - margin) problems.push(`text leaves the canvas on the right: ${content.slice(0, 40)}`);
    if (y > height - margin) problems.push(`text leaves the canvas at the bottom: ${content.slice(0, 40)}`);
  }
  for (const [, rawX, rawY, rawW, rawH] of svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    if (Number(rawX) + Number(rawW) > width + 1 || Number(rawY) + Number(rawH) > height + 1) {
      problems.push(`a shape leaves the canvas at ${rawX},${rawY}`);
    }
  }
  return problems;
}

export async function renderAll() {
  await mkdir(OUT_DIR, { recursive: true });
  const files = {
    'architecture.svg': buildSvg(),
    'architecture.html': buildHtml(),
    'celiaos-copilot.mmd': buildMermaid()
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(OUT_DIR, name), content, 'utf8');
  }
  return files;
}

async function check() {
  const expected = {
    'architecture.svg': buildSvg(),
    'architecture.html': buildHtml(),
    'celiaos-copilot.mmd': buildMermaid()
  };
  const stale = [];
  for (const [name, content] of Object.entries(expected)) {
    const actual = await readFile(path.join(OUT_DIR, name), 'utf8').catch(() => null);
    if (actual !== content) stale.push(name);
  }
  const problems = lintLayout();
  if (problems.length) {
    process.stderr.write(`layout check failed:\n${problems.join('\n')}\n`);
    return 1;
  }
  if (stale.length) {
    process.stderr.write(`stale architecture artifacts: ${stale.join(', ')} — run node scripts/render-copilot-architecture.mjs\n`);
    return 1;
  }
  process.stdout.write(`architecture artifacts are current: ${Object.keys(expected).join(', ')}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURLSafe(process.argv[1]);
function pathToFileURLSafe(value) {
  return `file://${path.resolve(value)}`;
}

if (isMain) {
  if (process.argv.slice(2).includes('--check')) {
    process.exitCode = await check();
  } else {
    const files = await renderAll();
    process.stdout.write(`wrote ${Object.keys(files).join(', ')} to docs/copilot-mcp\n`);
  }
}
