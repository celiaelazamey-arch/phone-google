#!/usr/bin/env node
/**
 * Integration in CeliaOS — engineering infographic (Arabic RTL).
 *
 * Output: docs/design/integration-in-celiaos.png (1800px wide).
 *
 * Requirements are intentionally NOT npm dependencies: this is a one-off design
 * artifact generator, not part of the runtime or the CI gates.
 *   1. npm install --no-save @napi-rs/canvas
 *   2. TTF cuts of the repo faces (public/fonts/*.woff2 are woff2, canvas needs TTF):
 *        PlexArabic-{400,500,600,700}.ttf  (IBM Plex Sans Arabic)
 *        Mono-{400,600}.ttf               (JetBrains Mono)
 *      Point CELIA_FONTS_DIR at the directory holding them.
 *
 * Usage: CELIA_FONTS_DIR=/path/to/fonts node scripts/render-integration-infographic.mjs [out.png]
 *
 * Deterministic and offline: no network, no emoji, no external assets.
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const F = process.env.CELIA_FONTS_DIR || '/home/user/.tools/fonts';
const FACES = ['PlexArabic-400.ttf', 'PlexArabic-500.ttf', 'PlexArabic-600.ttf', 'PlexArabic-700.ttf', 'Mono-400.ttf', 'Mono-600.ttf'];
const missing = FACES.filter((face) => !existsSync(path.join(F, face)));
if (missing.length) {
  console.error(`Missing font files in ${F}: ${missing.join(', ')}`);
  console.error('Set CELIA_FONTS_DIR to a directory holding the TTF cuts listed in the header.');
  process.exit(1);
}
GlobalFonts.registerFromPath(path.join(F, 'PlexArabic-400.ttf'), 'Plex4');
GlobalFonts.registerFromPath(path.join(F, 'PlexArabic-500.ttf'), 'Plex5');
GlobalFonts.registerFromPath(path.join(F, 'PlexArabic-600.ttf'), 'Plex6');
GlobalFonts.registerFromPath(path.join(F, 'PlexArabic-700.ttf'), 'Plex7');
GlobalFonts.registerFromPath(path.join(F, 'Mono-400.ttf'), 'Mono4');
GlobalFonts.registerFromPath(path.join(F, 'Mono-600.ttf'), 'Mono6');

const W = 1800;
const M = 64;
const CW = W - M * 2;
const PAD = 34;
const TMP_H = 8000;

const C = {
  bg: '#070d1b',
  panel: '#0e1730',
  card: '#141f3f',
  cardSoft: '#101a35',
  code: '#0a1226',
  line: 'rgba(140,160,220,0.16)',
  lineStrong: 'rgba(150,170,230,0.32)',
  text: '#eef2ff',
  body: '#c6d2f2',
  muted: '#9aa8cf',
  dim: '#7b89b4',
  gold: '#e2b357',
  goldSoft: '#f2cf86',
  blue: '#7c9cff',
  purple: '#a78bfa',
  teal: '#3dd8c8',
  green: '#3ddc97',
  amber: '#ffcb6b',
  red: '#ff7b8a',
  rose: '#ff9bb0',
  orange: '#ffa24d'
};
const STATUS = { ok: C.green, part: C.amber, no: C.red };

const canvas = createCanvas(W, TMP_H);
const ctx = canvas.getContext('2d');
ctx.direction = 'rtl';

/* ------------------------------------------------------------- primitives */

const px = (weight, size) => `${size}px ${weight}`;

function measure(str, size, weight = 'Plex4', ls = 0) {
  ctx.save();
  if (ls && 'letterSpacing' in ctx) ctx.letterSpacing = `${ls}px`;
  ctx.font = px(weight, size);
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

function text(str, x, y, { size = 26, weight = 'Plex4', color = C.text, align = 'right', dir = 'rtl', alpha = 1, ls = 0 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.direction = dir;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.font = px(weight, size);
  ctx.fillStyle = color;
  if (ls && 'letterSpacing' in ctx) ctx.letterSpacing = `${ls}px`;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** centred text around a true centre x */
function ctext(str, cx, y, opts = {}) {
  const w = measure(str, opts.size ?? 26, opts.weight ?? 'Plex4', opts.ls ?? 0);
  text(str, cx - w / 2, y, { ...opts, align: 'left', dir: 'ltr' });
}

function wrapLines(str, maxW, size, weight = 'Plex4') {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, size, weight) <= maxW || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function para(str, xRight, yTop, maxW, { size = 26, weight = 'Plex4', color = C.body, lh = 1.6, align = 'right' } = {}) {
  const lines = wrapLines(str, maxW, size, weight);
  const step = Math.round(size * lh);
  lines.forEach((line, i) => text(line, xRight, yTop + i * step, { size, weight, color, align }));
  return lines.length * step;
}

function cpara(str, cx, yTop, maxW, opts = {}) {
  const size = opts.size ?? 20;
  const lh = opts.lh ?? 1.45;
  const weight = opts.weight ?? 'Plex4';
  const lines = wrapLines(str, maxW, size, weight);
  const step = Math.round(size * lh);
  lines.forEach((line, i) => ctext(line, cx, yTop + i * step, { ...opts, size, weight }));
  return lines.length * step;
}

function rrect(x, y, w, h, r) {
  ctx.beginPath();
  const rr = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function panel(x, y, w, h, { fill = C.panel, stroke = C.line, r = 26 } = {}) {
  rrect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function card(x, y, w, h, { fill = C.card, stroke = C.line, r = 18, accent = null, accentW = 5, accentSide = 'right' } = {}) {
  panel(x, y, w, h, { fill, stroke, r });
  if (accent) {
    ctx.save();
    rrect(x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.fillRect(accentSide === 'right' ? x + w - accentW : x, y, accentW, h);
    ctx.restore();
  }
}

const dot = (x, y, r, color) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
};

function arrow(x1, y1, x2, y2, { color = C.lineStrong, width = 3, head = 13, dash = null } = {}) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const hx = x2 - Math.cos(ang) * Math.min(head, len);
  const hy = y2 - Math.sin(ang) * Math.min(head, len);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head);
  ctx.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const XR = W - M - PAD;      // right text edge inside a full-width panel
const XL = M + PAD;          // left text edge inside a full-width panel

function sectionHeader(y, { num, kicker, title, note, accent = C.gold }) {
  const badgeW = 72;
  const tx = XR - badgeW - 18;
  ctx.save();
  ctx.font = px('Plex7', 41);
  const asc = ctx.measureText(title).actualBoundingBoxAscent || 32;
  ctx.restore();
  text(kicker, tx, y - asc - 15, { size: 19, weight: 'Mono6', color: accent, ls: 1.6, dir: 'ltr' });
  text(title, tx, y, { size: 41, weight: 'Plex7', color: C.text });
  if (num) {
    rrect(XR - badgeW, y - 38, badgeW, 52, 14);
    ctx.fillStyle = 'rgba(226,179,87,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(226,179,87,0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctext(num, XR - badgeW / 2, y - 1, { size: 24, weight: 'Mono6', color: C.gold });
  }
  if (note) text(note, XL, y + 4, { size: 21, weight: 'Plex4', color: C.dim, align: 'left' });
}

/** legend laid out left-to-right: dot then label */
function legendRow(x, y, items, size = 18) {
  let cx = x;
  for (const [color, label] of items) {
    dot(cx + 5, y - 6, 5.5, STATUS[color] ?? color);
    text(label, cx + 18, y, { size, weight: 'Plex4', color: C.muted, align: 'left', dir: 'ltr' });
    cx += 18 + measure(label, size, 'Plex4') + 34;
  }
}

function codeBlock(x, y, w, h, lines, { size = 17, color = C.body, label = null, labelColor = C.dim } = {}) {
  rrect(x, y, w, h, 14);
  ctx.fillStyle = C.code;
  ctx.fill();
  ctx.strokeStyle = 'rgba(124,156,255,0.22)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  let cy = y + 30;
  for (const line of lines) {
    text(line, x + 20, cy, { size, weight: 'Mono4', color, dir: 'ltr', align: 'left' });
    cy += Math.round(size * 1.55);
  }
  if (label) text(label, x + w - 18, y + 28, { size: 15, weight: 'Mono6', color: labelColor, dir: 'ltr' });
}

/* ------------------------------------------------------------------ icons */

function iconWhatsApp(x, y, s) {
  const r = s / 2;
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1fbf5f';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + r, y + r, r * 0.60, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + r, y + r, r * 0.37, 0, Math.PI * 2);
  ctx.fillStyle = '#1fbf5f';
  ctx.fill();
  ctx.save();
  ctx.translate(x + r, y + r);
  ctx.rotate(-Math.PI / 4);
  rrect(-r * 0.075, -r * 0.29, r * 0.15, r * 0.58, r * 0.075);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

function iconGit(x, y, s) {
  const r = s / 2;
  const cx = x + r;
  ctx.beginPath();
  ctx.arc(cx, y + r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#171b21';
  ctx.fill();
  ctx.strokeStyle = '#8a95a6';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.strokeStyle = '#e6edf3';
  ctx.fillStyle = '#e6edf3';
  ctx.lineWidth = s * 0.055;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.15, y + s * 0.29);
  ctx.lineTo(cx - s * 0.15, y + s * 0.71);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.15, y + s * 0.45);
  ctx.quadraticCurveTo(cx + s * 0.19, y + s * 0.45, cx + s * 0.19, y + s * 0.59);
  ctx.stroke();
  for (const [dx, dy] of [[-0.15, 0.29], [-0.15, 0.71], [0.19, 0.59]]) {
    ctx.beginPath();
    ctx.arc(cx + s * dx, y + s * dy, s * 0.085, 0, Math.PI * 2);
    ctx.fill();
  }
}

function iconBrowser(x, y, s) {
  const r = s / 2;
  const cx = x + r;
  const cy = y + r;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, '#4285f4');
  g.addColorStop(0.55, '#34a853');
  g.addColorStop(1, '#fbbc05');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.50, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.29, 0, Math.PI * 2);
  ctx.fillStyle = '#4285f4';
  ctx.fill();
}

function iconDatabase(x, y, s) {
  const w = s * 0.72;
  const h = s * 0.84;
  const x0 = x + (s - w) / 2;
  const y0 = y + (s - h) / 2;
  const ry = h * 0.14;
  const g = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
  g.addColorStop(0, '#8098ff');
  g.addColorStop(1, '#3a5ad6');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x0 + w / 2, y0 + ry, w / 2, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x0, y0 + ry);
  ctx.lineTo(x0, y0 + h - ry);
  ctx.ellipse(x0 + w / 2, y0 + h - ry, w / 2, ry, 0, Math.PI, 0, true);
  ctx.lineTo(x0 + w, y0 + ry);
  ctx.ellipse(x0 + w / 2, y0 + ry, w / 2, ry, 0, 0, Math.PI, false);
  ctx.fill();
  ctx.strokeStyle = 'rgba(7,13,27,0.55)';
  ctx.lineWidth = 2;
  for (const t of [0.42, 0.62]) {
    ctx.beginPath();
    ctx.ellipse(x0 + w / 2, y0 + h * t, w / 2, ry, 0, 0, Math.PI);
    ctx.stroke();
  }
}

const iconApi = (x, y, s, color = C.blue) => ctext('{}', x + s / 2, y + s * 0.78, { size: s * 0.95, weight: 'Mono6', color });

function iconMcp(x, y, s, color = C.purple) {
  const pts = [
    [x + s * 0.26, y + s * 0.26],
    [x + s * 0.74, y + s * 0.34],
    [x + s * 0.40, y + s * 0.76],
    [x + s * 0.78, y + s * 0.72]
  ];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.065;
  for (const [a, b] of [[0, 1], [0, 2], [1, 2], [1, 3]]) {
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  }
  for (const [ax, ay] of pts) {
    ctx.beginPath();
    ctx.arc(ax, ay, s * 0.095, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

function iconAdapter(x, y, s, color = C.teal) {
  const w = s * 0.50;
  const h = s * 0.32;
  const x0 = x + (s - w) / 2;
  const y0 = y + s * 0.40;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.065;
  rrect(x0, y0, w, h, s * 0.07);
  ctx.stroke();
  for (const dx of [0.32, 0.68]) {
    ctx.beginPath();
    ctx.moveTo(x0 + w * dx, y0);
    ctx.lineTo(x0 + w * dx, y0 - s * 0.15);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x0 + w / 2, y0 + h);
  ctx.lineTo(x0 + w / 2, y0 + h + s * 0.16);
  ctx.stroke();
  ctx.restore();
}

function iconBus(x, y, s, color = C.purple) {
  const cx = x + s * 0.30;
  const cy = y + s * 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.062;
  for (const r of [0.16, 0.26, 0.36]) {
    ctx.beginPath();
    ctx.arc(cx, cy, s * r, -Math.PI / 3.4, Math.PI / 3.4);
    ctx.stroke();
  }
  ctx.restore();
  dot(cx, cy, s * 0.07, color);
}

/* ----------------------------------------------------------------- layout */

ctx.fillStyle = C.bg;
ctx.fillRect(0, 0, W, TMP_H);
{
  const g = ctx.createLinearGradient(0, 0, 0, TMP_H);
  g.addColorStop(0, '#081025');
  g.addColorStop(0.45, '#070d1b');
  g.addColorStop(1, '#050912');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, TMP_H);
  ctx.strokeStyle = 'rgba(124,156,255,0.04)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx < W; gx += 60) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, TMP_H);
    ctx.stroke();
  }
  for (let gy = 0; gy < TMP_H; gy += 60) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
  }
  const glow = ctx.createRadialGradient(W * 0.3, 90, 30, W * 0.3, 90, 980);
  glow.addColorStop(0, 'rgba(124,156,255,0.16)');
  glow.addColorStop(1, 'rgba(124,156,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 1300);
}

let y = 44;

/* ================================ HEADER ================================ */
const headerH = 262;
panel(M - 20, y, CW + 40, headerH, { fill: 'rgba(12,20,42,0.88)', stroke: 'rgba(226,179,87,0.22)', r: 30 });

text('Integration في CeliaOS', XR, y + 126, { size: 66, weight: 'Plex7', color: C.text });
text('تكامل ذكي… منظومة واحدة… إمكانيات لا محدودة', XR, y + 180, { size: 28, weight: 'Plex5', color: C.goldSoft });
{
  const label = 'v0.2.1 · schema 1 · 2026-11-01 · حالة موثّقة بدليل';
  const w = measure(label, 19, 'Plex5') + 44;
  rrect(XR - w, y + 202, w, 40, 20);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  text(label, XR - 22, y + 229, { size: 19, weight: 'Plex5', color: C.muted });
}

// brand (left)
const brandX = M + 10;
const starX = brandX + 58;
const starY = y + 128;
ctx.save();
ctx.translate(starX, starY);
const sg = ctx.createLinearGradient(-46, -46, 46, 46);
sg.addColorStop(0, '#f8e3b4');
sg.addColorStop(1, '#d79a2b');
ctx.fillStyle = sg;
ctx.beginPath();
for (let i = 0; i < 8; i += 1) {
  const a = (Math.PI / 4) * i - Math.PI / 2;
  const rad = i % 2 === 0 ? 46 : 12;
  const px0 = Math.cos(a) * rad;
  const py0 = Math.sin(a) * rad;
  if (i === 0) ctx.moveTo(px0, py0);
  else ctx.lineTo(px0, py0);
}
ctx.closePath();
ctx.fill();
ctx.restore();
text('CeliaOS', starX + 82, y + 150, { size: 54, weight: 'Plex7', color: '#f4f7ff', dir: 'ltr', align: 'left' });
text('Cognitive Operating System', starX + 82, y + 186, { size: 20, weight: 'Plex4', color: C.muted, dir: 'ltr', align: 'left' });
text('هندسة التكامل · وثيقة تشغيلية', starX + 82, y + 220, { size: 19, weight: 'Plex4', color: C.dim, align: 'left' });

y += headerH + 34;

/* ================================ 01 · DEFINITION ======================= */
const defH = 492;
panel(M, y, CW, defH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '01',
  kicker: 'DEFINITION',
  title: 'ما معنى Integration؟',
  note: 'أربعة مصطلحات تُخلط كثيرًا، وفرقها هو الفرق بين الربط والتكديس',
  accent: C.gold
});

const halfW = (CW - 56) / 2;
const rightCol = XR;

para(
  'التكامل هو تحويل أنظمة وأدوات وخدمات مستقلة إلى منظومة واحدة مترابطة: تتبادل البيانات، وتُدار صلاحياتها مركزيًا، ويُثبت ما حدث فيها بدليل. CeliaOS لا يعيد بناء كل خدمة من الصفر، بل يتصل بها عبر طبقة تكامل موحّدة.',
  rightCol,
  y + 122,
  halfW - 16,
  { size: 24, color: C.body, lh: 1.62 }
);

const terms = [
  ['Integration', 'ربط الأنظمة بعضها ببعض', C.blue],
  ['Implementation', 'بناء الميزة أو المكوّن', C.teal],
  ['Configuration', 'ضبط السلوك والإعدادات', C.purple],
  ['Automation', 'تنفيذ المهمة تلقائيًا وفق قواعد', C.orange]
];
const termsTop = y + 300;
const termW = (halfW - 12) / 2;
terms.forEach((t, i) => {
  const col = i % 2;
  const row = Math.floor(i / 2);
  const tx = rightCol - col * (termW + 12) - termW;
  const tyy = termsTop + row * 82;
  card(tx, tyy, termW, 74, { fill: 'rgba(255,255,255,0.04)', r: 13 });
  dot(tx + termW - 18, tyy + 24, 5, t[2]);
  text(t[0], tx + termW - 34, tyy + 30, { size: 17, weight: 'Mono6', color: t[2], dir: 'ltr' });
  text(t[1], tx + termW - 34, tyy + 58, { size: 18, weight: 'Plex4', color: C.muted });
});

// left column: why a layer
const leftColRight = M + CW - PAD - halfW;
text('لماذا طبقة تكامل؟', leftColRight, y + 122, { size: 31, weight: 'Plex7', color: C.text });
para(
  'كل خدمة لها بروتوكولها ومصادقتها وصيغ بياناتها وسلوكها عند الفشل. التوصيل المباشر يضاعف التبعيات، بينما طبقة واحدة تُعيدها إلى عدد خطّي.',
  leftColRight,
  y + 166,
  halfW - 30,
  { size: 22, color: C.body, lh: 1.58 }
);

const hubX = leftColRight - halfW / 2 - 10;
const hubY = y + 386;
[
  { dx: -168, dy: -86, label: 'W' },
  { dx: -146, dy: 34, label: 'G' },
  { dx: 150, dy: -92, label: 'B' },
  { dx: 172, dy: 38, label: 'D' }
].forEach((s) => {
  const nx = hubX + s.dx;
  const ny = hubY + s.dy;
  ctx.save();
  ctx.strokeStyle = 'rgba(124,156,255,0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(hubX, hubY);
  ctx.stroke();
  ctx.restore();
  dot(nx, ny, 19, 'rgba(124,156,255,0.14)');
  ctext(s.label, nx, ny + 7, { size: 18, weight: 'Mono6', color: C.blue });
});
dot(hubX, hubY, 28, 'rgba(226,179,87,0.14)');
dot(hubX, hubY, 13, C.gold);
ctext('طبقة واحدة', hubX, hubY + 62, { size: 18, weight: 'Plex5', color: C.muted });
ctext('O(n) instead of O(n²)', hubX, hubY + 88, { size: 16, weight: 'Mono4', color: C.dim });

y += defH + 34;

/* ========================= 02 · ARCHITECTURE ============================ */
const archH = 848;
panel(M, y, CW, archH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '02',
  kicker: 'ARCHITECTURE',
  title: 'البنية: من الخارج إلى النواة',
  note: 'طبقة التكامل وسيط لا نواة: النواة لا تعرف تفاصيل أي خدمة',
  accent: C.blue
});

const innerTop = y + 128;
const gap = 112;
const colW = (CW - 2 * PAD - gap * 2) / 3;
const col1X = XR - colW;
const col2X = col1X - gap - colW;
const col3X = M + PAD;
const colH = archH - 178;

card(col1X, innerTop, colW, colH, { fill: 'rgba(255,255,255,0.03)', r: 22 });
text('١ · أنظمة خارجية', col1X + colW - 22, innerTop + 44, { size: 26, weight: 'Plex6', color: C.text });
text('مصادر الطلب والبيانات', col1X + colW - 22, innerTop + 74, { size: 19, weight: 'Plex4', color: C.muted });

const ext = [
  { icon: iconWhatsApp, t: 'WhatsApp', d: 'استقبال الرسائل والردود', s: 'part' },
  { icon: iconGit, t: 'GitHub', d: 'المستودعات وطلبات الدمج', s: 'no' },
  { icon: iconBrowser, t: 'Browser', d: 'التصفح والبحث والتحقق', s: 'no' },
  { icon: iconDatabase, t: 'Database', d: 'قراءة البيانات وكتابتها', s: 'ok' }
];
ext.forEach((e, i) => {
  const th = 112;
  const ty0 = innerTop + 96 + i * (th + 16);
  card(col1X + 18, ty0, colW - 36, th, { fill: C.cardSoft });
  e.icon(col1X + colW - 18 - 18 - 52, ty0 + 14, 52);
  text(e.t, col1X + colW - 88, ty0 + 50, { size: 25, weight: 'Plex6', color: C.text, dir: 'ltr' });
  para(e.d, col1X + colW - 88, ty0 + 82, colW - 130, { size: 19, color: C.muted, lh: 1.4 });
  dot(col1X + 32, ty0 + th - 18, 5, STATUS[e.s]);
});

panel(col2X, innerTop - 12, colW, colH + 24, { fill: 'rgba(124,156,255,0.07)', stroke: 'rgba(124,156,255,0.30)', r: 24 });
text('٢ · طبقة التكامل', col2X + colW - 22, innerTop + 34, { size: 26, weight: 'Plex6', color: C.text });
text('Integration Layer', col2X + 22, innerTop + 34, { size: 19, weight: 'Mono4', color: C.blue, dir: 'ltr', align: 'left' });

const parts = [
  { t: 'API', d: 'واجهات برمجية للتواصل المباشر وتبادل البيانات', icon: (x, yy, s) => iconApi(x, yy, s), c: C.blue },
  { t: 'MCP', d: 'بروتوكول موحّد لاكتشاف الأدوات واستدعائها', icon: (x, yy, s) => iconMcp(x, yy, s), c: C.purple },
  { t: 'Adapters', d: 'محوّلات تترجم كل خدمة إلى عقد موحّد', icon: (x, yy, s) => iconAdapter(x, yy, s), c: C.teal },
  { t: 'Event Bus', d: 'ناقل أحداث يوزّع ما يحدث داخليًا بلا اقتران مباشر', icon: (x, yy, s) => iconBus(x, yy, s), c: C.purple }
];
parts.forEach((p, i) => {
  const th = 122;
  const py = innerTop + 68 + i * (th + 14);
  card(col2X + 18, py, colW - 36, th, { fill: 'rgba(9,16,36,0.78)', r: 18, stroke: 'rgba(124,156,255,0.22)' });
  p.icon(col2X + colW - 40 - 40, py + 14, 40);
  text(p.t, col2X + colW - 94, py + 46, { size: 24, weight: 'Plex7', color: p.c, dir: 'ltr' });
  para(p.d, col2X + colW - 24, py + 78, colW - 60, { size: 19, color: C.muted, lh: 1.4 });
});

panel(col3X, innerTop - 12, colW, 264, { fill: 'rgba(61,220,151,0.06)', stroke: 'rgba(61,220,151,0.28)', r: 22 });
text('٣ · نواة CeliaOS', col3X + colW - 22, innerTop + 34, { size: 26, weight: 'Plex6', color: C.text });
text('Core', col3X + 22, innerTop + 34, { size: 19, weight: 'Mono4', color: C.green, dir: 'ltr', align: 'left' });
['Kernel — دورة حياة النظام', 'Agent Runtime — تشغيل الوكلاء', 'Workflow — تنسيق الخطوات', 'Memory — السياق والمعرفة'].forEach((t0, i) => {
  const ryy = innerTop + 72 + i * 44;
  dot(col3X + colW - 30, ryy - 6, 4, C.green);
  text(t0, col3X + colW - 46, ryy, { size: 21, weight: 'Plex4', color: C.body });
});

text('حوكمة التنفيذ', col3X + colW - 22, innerTop + 302, { size: 24, weight: 'Plex6', color: C.text });
const gov = [
  ['Tool Registry', 'ما الأدوات المسجّلة وقدراتها', 'ok'],
  ['Policy & Approval', 'ما المسموح، ومتى تتوقف للموافقة', 'ok'],
  ['Execution Sandbox', 'أين يُنفَّذ الأثر الخارجي', 'part'],
  ['Evidence & Verification', 'ما الدليل أن النتيجة تحققت', 'ok']
];
gov.forEach((g, i) => {
  const gy = innerTop + 322 + i * 80;
  card(col3X + 14, gy, colW - 28, 70, { fill: 'rgba(9,16,36,0.72)', r: 16 });
  text(g[0], col3X + colW - 36, gy + 29, { size: 21, weight: 'Plex6', color: C.text, dir: 'ltr' });
  text(g[1], col3X + colW - 36, gy + 55, { size: 18, weight: 'Plex4', color: C.muted });
  dot(col3X + 28, gy + 34, 6, STATUS[g[2]]);
});

const ay1 = innerTop + 196;
arrow(col1X - 12, ay1, col2X + colW + 12, ay1, { color: 'rgba(124,156,255,0.62)', width: 4, head: 14 });
arrow(col2X + colW + 12, ay1 + 62, col1X - 12, ay1 + 62, { color: 'rgba(124,156,255,0.38)', width: 4, head: 14, dash: [8, 6] });
ctext('طلب/حدث', (col2X + colW + col1X) / 2, ay1 - 20, { size: 16, weight: 'Plex5', color: C.muted });
ctext('استجابة', (col2X + colW + col1X) / 2, ay1 + 96, { size: 16, weight: 'Plex5', color: C.dim });

const ay2 = innerTop + 436;
arrow(col2X - 12, ay2, col3X + colW + 12, ay2, { color: 'rgba(61,220,151,0.55)', width: 4, head: 14 });
arrow(col3X + colW + 12, ay2 + 62, col2X - 12, ay2 + 62, { color: 'rgba(61,220,151,0.38)', width: 4, head: 14, dash: [8, 6] });
ctext('عقود وأدوات', (col3X + colW + col2X) / 2, ay2 - 20, { size: 16, weight: 'Plex5', color: C.muted });
ctext('حوكمة وأدلة', (col3X + colW + col2X) / 2, ay2 + 96, { size: 16, weight: 'Plex5', color: C.dim });

const footY = y + archH - 60;
rrect(M + 30, footY - 26, CW - 60, 48, 14);
ctx.fillStyle = 'rgba(255,255,255,0.04)';
ctx.fill();
text('القاعدة الحاكمة: وجود API أو MCP لا يعني السماح بالتنفيذ — السياسة والصلاحية تحدّدان ما يجوز.', XR - 24, footY + 6, { size: 23, weight: 'Plex5', color: C.goldSoft });
text('لون النقطة = الحالة الفعلية في القسم ١٠', XL + 24, footY + 6, { size: 18, weight: 'Plex4', color: C.dim, align: 'left' });

y += archH + 34;

/* =========================== 03 · GOVERNED FLOW ========================= */
const stageGap = 26;
const stageW = (CW - 2 * PAD - 4 * stageGap) / 5;
const flowH = 646;
panel(M, y, CW, flowH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '03',
  kicker: 'GOVERNED FLOW',
  title: 'تدفّق البيانات إلى التنفيذ الآمن',
  note: 'خمس مراحل — كل انتقال مسجَّل بدليل',
  accent: C.gold
});

const flowTop = y + 146;
const stageX = (i) => XR - stageW - i * (stageW + stageGap);
const stages = [
  { n: '1', t: 'النظام الخارجي', d: 'يصل طلب أو حدث من واتساب أو GitHub أو المتصفح أو القاعدة', c: C.blue },
  { n: '2', t: 'Tool Registry', d: 'يُحدَّد القادر على التنفيذ، ويُرفض أي أداة غير مسجّلة', c: C.teal },
  { n: '3', t: 'Policy & Approval', d: 'فحص الصلاحية والمخاطر؛ قرار بشري عند الحاجة', c: C.amber },
  { n: '4', t: 'Execution', d: 'تنفيذ معزول في بيئة مسموحة، بلا أثر خارج الموافقة', c: C.green },
  { n: '5', t: 'Evidence & Verification', d: 'تسجيل الدليل ثم التحقق من أن النتيجة تحققت فعلًا', c: C.purple }
];
stages.forEach((s, i) => {
  const sx = stageX(i);
  card(sx, flowTop, stageW, 258, { fill: 'rgba(255,255,255,0.035)', stroke: 'rgba(255,255,255,0.10)', accent: s.c, accentW: 4 });
  ctx.beginPath();
  ctx.arc(sx + stageW - 38, flowTop + 38, 20, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.strokeStyle = s.c;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctext(s.n, sx + stageW - 38, flowTop + 46, { size: 21, weight: 'Mono6', color: s.c });
  const tl = wrapLines(s.t, stageW - 44, 20, 'Plex7');
  const tStep = Math.round(20 * 1.35);
  tl.forEach((ln, k) => text(ln, sx + stageW - 20, flowTop + 100 + k * tStep, { size: 20, weight: 'Plex7', color: C.text }));
  para(s.d, sx + stageW - 20, flowTop + 100 + tl.length * tStep + 16, stageW - 36, { size: 18, color: C.muted, lh: 1.5 });
  if (i < 4) arrow(sx - 3, flowTop + 112, sx - 23, flowTop + 112, { color: 'rgba(226,179,87,0.75)', width: 4, head: 11 });
});

const decX = stageX(2);
rrect(decX + 10, flowTop + 274, stageW - 20, 80, 16);
ctx.fillStyle = 'rgba(255,203,107,0.10)';
ctx.fill();
ctx.strokeStyle = 'rgba(255,203,107,0.40)';
ctx.lineWidth = 1.4;
ctx.stroke();
ctext('تتطلب موافقة؟', decX + stageW / 2, flowTop + 304, { size: 21, weight: 'Plex6', color: C.amber });
ctext('توقّف حتى القرار — والرفض بلا أثر', decX + stageW / 2, flowTop + 334, { size: 17, weight: 'Plex4', color: C.muted });

const loopY = flowTop + 424;
const fromX = stageX(4) + stageW / 2;
const toX = stageX(0) + stageW / 2;
ctx.save();
ctx.strokeStyle = 'rgba(61,220,151,0.42)';
ctx.lineWidth = 3;
ctx.setLineDash([10, 8]);
ctx.beginPath();
ctx.moveTo(fromX, flowTop + 258);
ctx.lineTo(fromX, loopY);
ctx.lineTo(toX, loopY);
ctx.stroke();
ctx.restore();
arrow(toX, loopY, toX, flowTop + 258, { color: 'rgba(61,220,151,0.55)', width: 3, head: 12 });

const loopLabel = 'النتيجة النهائية: مسجّلة ومتحقَّق منها';
const lw = measure(loopLabel, 22, 'Plex5') + 92;
rrect(W / 2 - lw / 2, loopY - 26, lw, 52, 26);
ctx.fillStyle = '#0b1a22';
ctx.fill();
ctx.strokeStyle = 'rgba(61,220,151,0.50)';
ctx.lineWidth = 1.4;
ctx.stroke();
dot(W / 2 + lw / 2 - 30, loopY, 6, C.green);
text(loopLabel, W / 2 + lw / 2 - 48, loopY + 8, { size: 22, weight: 'Plex5', color: C.green });

y += flowH + 34;

/* ============================== 04 · SECURITY =========================== */
const secH = 408;
panel(M, y, CW, secH, { fill: 'rgba(255,123,138,0.045)', stroke: 'rgba(255,123,138,0.26)' });
sectionHeader(y + 92, {
  num: '04',
  kicker: 'SECURITY',
  title: 'الأمان أولًا: الاتصال ليس إذنًا',
  note: 'الصفر الافتراضي: لا اتصال بلا تصريح',
  accent: C.red
});

const badgeW = 348;
const badgeX = XR - badgeW;
rrect(badgeX, y + 126, badgeW, 162, 22);
{
  const g2 = ctx.createLinearGradient(badgeX, y + 126, badgeX + badgeW, y + 288);
  g2.addColorStop(0, 'rgba(255,123,138,0.22)');
  g2.addColorStop(1, 'rgba(255,123,138,0.05)');
  ctx.fillStyle = g2;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,123,138,0.55)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}
ctext('NETWORK = DENY', badgeX + badgeW / 2, y + 190, { size: 33, weight: 'Mono6', color: C.red });
ctext('الوجهات تُسمَّح صراحةً، لا تُفتح افتراضيًا', badgeX + badgeW / 2, y + 232, { size: 19, weight: 'Plex4', color: C.body });
ctext('وما يُسمح يبقى خاضعًا للموافقة والتحقق', badgeX + badgeW / 2, y + 262, { size: 18, weight: 'Plex4', color: C.muted });

const rules = [
  'لا اتصال خارجي دون تصريح صريح',
  'أقل صلاحية ممكنة لكل أداة',
  'موافقة بشرية مسجّلة قبل الأثر',
  'عزل التنفيذ الحسّاس عن النواة',
  'Trace ID لكل عملية وكل نتيجة',
  'التحقق قبل اعتبار المهمة ناجحة',
  'الأسرار خارج الكود وخارج السجلات',
  'توقيع Webhook ومنع إعادة الأحداث',
  'Idempotency يمنع التنفيذ المكرر',
  'حدود معدل ومهل زمنية صريحة'
];
const rulesArea = badgeX - 56;
const rcolW = rulesArea / 2;
rules.forEach((r0, i) => {
  const col = i % 2;
  const row = Math.floor(i / 2);
  const rx = rulesArea - col * rcolW;
  const ryy = y + 148 + row * 50;
  dot(rx + 12, ryy - 7, 5, C.red);
  text(r0, rx - 10, ryy, { size: 22, weight: 'Plex4', color: C.body });
});

y += secH + 34;

/* ============================ 05 · FAILURE MODES ======================== */
const failH = 376;
panel(M, y, CW, failH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '05',
  kicker: 'FAILURE MODES',
  title: 'ماذا يحدث عندما يفشل التكامل؟',
  note: 'النظام لا يُصمَّم للحالة الناجحة وحدها',
  accent: C.rose
});

const fails = [
  ['الخدمة غير متاحة', 'تسجيل الخطأ وتحديد إمكانية الإعادة'],
  ['انتهاء المهلة', 'إيقاف وفق Timeout لا انتظار مفتوح'],
  ['صلاحية منتهية', 'لا تجاوز للمصادقة؛ معالجة الاعتماد'],
  ['بيانات غير صحيحة', 'رفض الطلب وتسجيل السبب بلا أثر'],
  ['رفض السياسة', 'إظهار الرفض لا محاولة الالتفاف'],
  ['نتيجة غير مؤكدة', 'لا تُسجَّل ناجحة؛ تُصالح يدويًا'],
  ['حدث مكرر', 'منع التنفيذ المكرر بـIdempotency']
];
const fW = (CW - 2 * PAD - 6 * 12) / 7;
fails.forEach((f, i) => {
  const fx = XR - fW - i * (fW + 12);
  card(fx, y + 128, fW, 210, { fill: 'rgba(255,255,255,0.035)', r: 16, accent: C.rose, accentW: 3 });
  text(String(i + 1).padStart(2, '0'), fx + fW - 16, y + 156, { size: 16, weight: 'Mono6', color: 'rgba(255,155,176,0.7)', dir: 'ltr' });
  cpara(f[0], fx + fW / 2, y + 200, fW - 28, { size: 19, weight: 'Plex6', color: C.text, lh: 1.35 });
  cpara(f[1], fx + fW / 2, y + 266, fW - 28, { size: 16, color: C.muted, lh: 1.45 });
});

y += failH + 34;

/* ======================= 06 · SEPARATION OF DUTIES ====================== */
const respH = 324;
panel(M, y, CW, respH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '06',
  kicker: 'SEPARATION OF DUTIES',
  title: 'من يجيب عن أي سؤال؟',
  note: 'الفصل يمنع أن يصير النظام كومة أوامر متشابكة',
  accent: C.teal
});

const resp = [
  ['Integration', 'كيف نتصل بالأداة؟'],
  ['Tool Registry', 'ما الأدوات التي نملكها؟'],
  ['Planner', 'أي أداة نحتاج؟'],
  ['Policy Engine', 'هل يُسمح باستخدامها؟'],
  ['Executor', 'كيف ننفّذ بأمان؟'],
  ['Verifier', 'هل تحقق الهدف فعلًا؟']
];
const rW = (CW - 2 * PAD - 5 * 14) / 6;
resp.forEach((r0, i) => {
  const rx = XR - rW - i * (rW + 14);
  card(rx, y + 128, rW, 110, { fill: 'rgba(61,216,200,0.06)', r: 16, stroke: 'rgba(61,216,200,0.22)' });
  ctext(r0[0], rx + rW / 2, y + 164, { size: 19, weight: 'Mono6', color: C.teal });
  cpara(r0[1], rx + rW / 2, y + 200, rW - 26, { size: 17, color: C.body, lh: 1.35 });
});
text('التكامل يعني القدرة على الوصول، ولا يعني تلقائيًا الإذن أو الذكاء: الإذن للسياسة، والاختيار للمخطِّط، والإثبات للمُتحقِّق.', XR, y + 286, { size: 21, weight: 'Plex4', color: C.muted });

y += respH + 34;

/* ===================== 07 · CONTRACT + EVENT (2 panels) ================= */
const obH = 452;
const obGap = 34;
const obW = (CW - obGap) / 2;
const obRight = XR - obW;
const obLeft = M + PAD - PAD; // = M

panel(obRight, y, obW, obH, { fill: C.panel, stroke: C.line });
text('عقد الطلب والاستجابة', obRight + obW - 28, y + 56, { size: 29, weight: 'Plex7', color: C.text });
text('غلاف واحد لكل نداء — لا استدعاء أداة بلا هوية ولا دليل', obRight + obW - 28, y + 90, { size: 19, weight: 'Plex4', color: C.muted });

const cbW = obW - 56;
codeBlock(obRight + 28, y + 108, cbW, 106, [
  '{ tool: "whatsapp.send_text",',
  '  args: { to: "+20…", text: "…" },',
  '  trace_id: "…", idempotency_key: "…" }'
], { label: 'REQUEST', labelColor: C.blue });

codeBlock(obRight + 28, y + 228, cbW, 106, [
  '{ status: "ok" | "denied" | "failed",',
  '  result: { … },',
  '  evidence_hash: "sha256:…", verified: true }'
], { label: 'RESPONSE', labelColor: C.green });

[
  'الحالة صريحة دائمًا: ok | denied | failed — لا «نجاح» مفترض',
  'evidence_hash يربط النتيجة بالدليل، وidempotency_key يمنع التكرار',
  'نفس الغلاف لكل خدمة: يتبدّل الوسيط لا العقد'
].forEach((t0, i) => {
  dot(obRight + obW - 34, y + 372 + i * 30 - 7, 5, C.gold);
  text(t0, obRight + obW - 50, y + 372 + i * 30, { size: 19, weight: 'Plex4', color: C.body });
});

panel(obLeft, y, obW, obH, { fill: C.panel, stroke: C.line });
text('حدث على ناقل الأحداث', obLeft + obW - 28, y + 56, { size: 29, weight: 'Plex7', color: C.text });
text('ما حدث يُنشر مرة، ويُستهلك بلا معرفة متبادلة', obLeft + obW - 28, y + 90, { size: 19, weight: 'Plex4', color: C.muted });

codeBlock(obLeft + 28, y + 108, cbW, 106, [
  '{ type: "tool.call.completed",',
  '  tool: "calendar.create_event", status: "ok",',
  '  trace_id: "…", at: "2026-11-01T09:12Z" }'
], { label: 'EVENT', labelColor: C.purple });

const pub = [
  ['Tool Registry', 'ينشر'],
  ['Event Bus', 'يوزّع'],
  ['Audit · Memory', 'يستهلك']
];
const pubW = (cbW - 2 * 44) / 3;
pub.forEach((p, i) => {
  const pxx = obLeft + 28 + cbW - pubW - i * (pubW + 44);
  card(pxx, y + 232, pubW, 84, { fill: 'rgba(167,139,250,0.07)', r: 14, stroke: 'rgba(167,139,250,0.24)' });
  ctext(p[0], pxx + pubW / 2, y + 266, { size: 18, weight: 'Mono6', color: C.purple });
  ctext(p[1], pxx + pubW / 2, y + 294, { size: 18, weight: 'Plex4', color: C.muted });
  if (i < 2) arrow(pxx - 6, y + 274, pxx - 38, y + 274, { color: 'rgba(167,139,250,0.55)', width: 3, head: 10 });
});

[
  'الناقل لا يعرف المحتوى ولا يقرّره: يسلّم ويسجّل فقط',
  'المشتركون لا يتصلون ببعضهم؛ كل واحد يكتفي بالحدث',
  'كل حدث يحمل معرّفه وبصمته ووقته'
].forEach((t0, i) => {
  dot(obLeft + obW - 34, y + 366 + i * 30 - 7, 5, C.purple);
  text(t0, obLeft + obW - 50, y + 366 + i * 30, { size: 19, weight: 'Plex4', color: C.body });
});

y += obH + 34;

/* ===================== 08 · ONE TASK ACROSS FOUR SERVICES =============== */
const taskH = 392;
panel(M, y, CW, taskH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '08',
  kicker: 'WORKED EXAMPLE',
  title: 'مهمة واحدة عبر أربع خدمات',
  note: '«رتّب لي اجتماعًا الخميس ٣ عصرًا» — من رسالة واتساب إلى دليل موثّق',
  accent: C.blue
});

const steps = [
  { s: 'WhatsApp', g: 'src/whatsapp.js', n: '1', d: 'رسالة واردة عبر Webhook موقَّع؛ تُطبَّع إلى طلب موحّد بدل أن تُنفَّذ كما هي.', c: C.green },
  { s: 'Google Calendar', g: 'src/google.js', n: '2', d: 'فحص صلاحية الإنشاء، ثم إنشاء الحدث؛ الموافقة مطلوبة لأنه أثر خارجي.', c: C.blue },
  { s: 'WhatsApp', g: 'src/whatsapp.js', n: '3', d: 'إرسال نص التأكيد للمستخدم بعد نجاح الخطوة السابقة، لا قبلها.', c: C.green },
  { s: 'Store · Evidence', g: 'src/store.js', n: '4', d: 'كتابة السجل وبصمة SHA-256، ثم التحقق قبل اعتبار المهمة ناجحة.', c: C.purple }
];
const stGap = 28;
const stW = (CW - 2 * PAD - 3 * stGap) / 4;
steps.forEach((st, i) => {
  const sx = XR - stW - i * (stW + stGap);
  card(sx, y + 132, stW, 176, { fill: 'rgba(255,255,255,0.035)', r: 18, accent: st.c, accentW: 4 });
  text(st.n, sx + stW - 18, y + 162, { size: 17, weight: 'Mono6', color: st.c, dir: 'ltr' });
  text(st.s, sx + stW - 46, y + 162, { size: 22, weight: 'Plex6', color: C.text, dir: 'ltr' });
  para(st.d, sx + stW - 18, y + 202, stW - 36, { size: 18, color: C.muted, lh: 1.45 });
  text(st.g, sx + 18, y + 292, { size: 15, weight: 'Mono4', color: C.dim, dir: 'ltr', align: 'left' });
  if (i < 3) arrow(sx - 5, y + 220, sx - 25, y + 220, { color: 'rgba(124,156,255,0.65)', width: 3.5, head: 11 });
});

rrect(M + PAD, y + 322, CW - 2 * PAD, 46, 14);
ctx.fillStyle = 'rgba(255,255,255,0.04)';
ctx.fill();
text('ما لم يحدث في هذه المهمة: لا كتابة في GitHub، لا متصفح آلي، ولا اتصال بشبكة خارج ما سُمح به صراحةً.', XR - 22, y + 351, { size: 21, weight: 'Plex4', color: C.goldSoft });

y += taskH + 34;

/* ================= 09 · TERMS + LIFECYCLE (two panels) ================= */
const trioH = 372;
const boxW = (CW - obGap) / 2;
const boxRight = XR - boxW;
const boxLeft = M;

panel(boxRight, y, boxW, trioH, { fill: C.panel, stroke: C.line });
text('التكامل ≠ الأتمتة ≠ التنسيق', boxRight + boxW - 28, y + 56, { size: 29, weight: 'Plex7', color: C.text });
text('ثلاثة مستويات: الوصول، ثم التنفيذ، ثم التنسيق', boxRight + boxW - 28, y + 88, { size: 19, weight: 'Plex4', color: C.muted });
const trio = [
  ['Integration', 'Connect', 'ربط الأنظمة وإتاحة تبادل القدرات', C.blue],
  ['Automation', 'Execute', 'تنفيذ الخطوات تلقائيًا وفق قواعد', C.teal],
  ['Orchestration', 'Coordinate', 'تنسيق أدوات متعددة وترتيب تنفيذها', C.purple]
];
const triCardW = (boxW - 56 - 2 * 12) / 3;
trio.forEach((t0, i) => {
  const cx = boxRight + boxW - 28 - triCardW - i * (triCardW + 12);
  card(cx, y + 108, triCardW, 200, { fill: 'rgba(255,255,255,0.035)', r: 16, accent: t0[3], accentW: 3 });
  ctext(t0[0], cx + triCardW / 2, y + 152, { size: 17, weight: 'Mono6', color: t0[3] });
  ctext(t0[1], cx + triCardW / 2, y + 190, { size: 21, weight: 'Plex6', color: C.text });
  cpara(t0[2], cx + triCardW / 2, y + 226, triCardW - 30, { size: 17, color: C.muted, lh: 1.4 });
});
text('الترتيب الطبقي: التكامل يفتح الباب، والأتمتة تسير في الممر، والتنسيق يوزّع الأدوار.', boxRight + boxW - 28, y + 346, { size: 20, weight: 'Plex4', color: C.body });

panel(boxLeft, y, boxW, trioH, { fill: C.panel, stroke: C.line });
text('دورة التشغيل', boxLeft + boxW - 28, y + 56, { size: 29, weight: 'Plex7', color: C.text });
text('ست خطوات تتكرر مع كل خدمة جديدة', boxLeft + boxW - 28, y + 88, { size: 19, weight: 'Plex4', color: C.muted });
const cycle = [
  ['Connect', 'اتصال'],
  ['Discover', 'اكتشاف'],
  ['Authorize', 'إذن'],
  ['Execute', 'تنفيذ'],
  ['Verify', 'تحقق'],
  ['Learn', 'تعلّم']
];
const chipW = (boxW - 56 - 5 * 8) / 6;
cycle.forEach((c0, i) => {
  const cx = boxLeft + boxW - 28 - chipW - i * (chipW + 8);
  card(cx, y + 108, chipW, 96, { fill: 'rgba(226,179,87,0.08)', r: 14, stroke: 'rgba(226,179,87,0.28)' });
  ctext(c0[0], cx + chipW / 2, y + 146, { size: 15, weight: 'Mono6', color: C.gold });
  ctext(c0[1], cx + chipW / 2, y + 180, { size: 19, weight: 'Plex5', color: C.text });
  if (i < 5) arrow(cx - 1, y + 156, cx - 8, y + 156, { color: 'rgba(226,179,87,0.5)', width: 2.5, head: 7 });
});
para('كل خدمة جديدة لا تعني إعادة تصميم النظام: يُضاف محوّل متوافق مع العقد الموحّد، ويُسجَّل بقدراته وصلاحياته، ثم يُختبر.', boxLeft + boxW - 28, y + 242, boxW - 56, { size: 21, color: C.body, lh: 1.55 });
text('ما يُتعلَّم يعود إلى السياسة والسجل، لا إلى الكود وحده.', boxLeft + boxW - 28, y + 346, { size: 20, weight: 'Plex4', color: C.goldSoft });

y += trioH + 34;

/* ============================ 10 · REALITY ============================== */
const realRows = [
  ['Tool Registry', 'سجل أدوات ورفض غير المسجّل', 'ok', 'src/agent/tools.js'],
  ['MCP', '١٢ أداة معرَّفة وتكافؤها محروس', 'ok', 'src/celia-mcp.js'],
  ['Policy & Approval', 'صفوف موافقة وتوقّف قبل الأثر', 'ok', 'src/agent/runtime.js'],
  ['Evidence & Verification', 'سلسلة بصمات SHA-256 ومُتحقِّق', 'ok', 'src/agent/evidence.js'],
  ['Database · MySQL', 'مخزن دائم، اختُبر 8.4 و N−1', 'ok', 'src/store.js'],
  ['Evidence · Audit', 'سجل إلحاق بسلسلة هاش', 'ok', 'workers/celia-edge/state.js'],
  ['Access policy', '٦٧ صلاحية بمصفوفة مولَّدة', 'ok', 'src/agent/access-policy.js'],
  ['WhatsApp', 'Webhook مبني؛ بلا أسرار Meta بعد', 'part', 'src/whatsapp.js'],
  ['Google', 'OAuth2 للخدمات الأربع؛ ربط حي غير متحقق', 'part', 'src/google.js'],
  ['Event Bus', 'ناقل تسليم وتسجيل، لا يستهلك المحتوى', 'part', 'src/agent/collaboration-bus.js'],
  ['Execution Sandbox', 'مبني ومُختبَر؛ الافتراضي off', 'part', 'src/agent/sandbox.js'],
  ['Adapters', 'محوّل لكل خدمة، لا عقد موحّد بعد', 'part', 'src/google.js'],
  ['GitHub', 'فرز Issue كنص بيانات؛ لا كتابة', 'no', 'src/agent/issue-triage'],
  ['Browser', 'غير متاح كأداة وكيل (Playwright للاختبار)', 'no', 'docs/computer-use.md']
];
const rowH = 48;
const realH = 158 + realRows.length * rowH + 84;
panel(M, y, CW, realH, { fill: C.panel, stroke: C.line });
sectionHeader(y + 92, {
  num: '10',
  kicker: 'STATUS IN THIS REPOSITORY',
  title: 'الحالة الفعلية اليوم — لا تصميم مستهدف',
  note: 'كل صف بدليله؛ ما لم يُنفَّذ يُقال إنه لم يُنفَّذ',
  accent: C.green
});

let ry0 = y + 148;
realRows.forEach((r0, i) => {
  if (i % 2 === 0) {
    rrect(M + 24, ry0 - 27, CW - 48, rowH - 6, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fill();
  }
  dot(XR - 40, ry0 - 7, 6, STATUS[r0[2]]);
  text(r0[0], XR - 60, ry0, { size: 21, weight: 'Plex6', color: C.text, dir: /^[A-Za-z]/.test(r0[0]) ? 'ltr' : 'rtl' });
  text(r0[1], XR - 366, ry0, { size: 20, weight: 'Plex4', color: C.body });
  text(r0[3], M + 46, ry0, { size: 17, weight: 'Mono4', color: C.dim, dir: 'ltr', align: 'left' });
  ry0 += rowH;
});

legendRow(M + 46, y + realH - 34, [['ok', 'مُنفَّذ ومُختبَر'], ['part', 'جزئي أو مشروط'], ['no', 'غير منفَّذ']]);
text('لا يمثّل هذا الجدول «كل ما يمكن بناؤه»، بل ما هو موجود فعلًا في هذا المستودع حتى ١ نوفمبر ٢٠٢٦.', XR, y + realH - 34, { size: 18, weight: 'Plex4', color: C.dim });

y += realH + 34;

/* ============================ 11 · PHILOSOPHY =========================== */
const philH = 236;
panel(M, y, CW, philH, { fill: 'rgba(226,179,87,0.06)', stroke: 'rgba(226,179,87,0.28)', r: 26 });
text('فلسفة التكامل', XR, y + 58, { size: 27, weight: 'Plex7', color: C.goldSoft });
text('اربط كل شيء · تحكّم في كل إجراء · تحقّق من كل نتيجة', XR, y + 116, { size: 38, weight: 'Plex7', color: C.text });
text('Connect Everything. Control Every Action. Verify Every Result.', XR, y + 162, { size: 24, weight: 'Mono6', color: C.gold, dir: 'ltr' });
text('التكامل جسر لا نواة: النواة لا تعرف تفاصيل الخدمات، والسياسة تحدّد ما يجوز، والأدلة تُثبت ما حدث.', XR, y + 206, { size: 20, weight: 'Plex4', color: C.muted });

y += philH + 36;

/* ================================ FOOTER =============================== */
rrect(M, y, CW, 64, 18);
ctx.fillStyle = 'rgba(255,255,255,0.04)';
ctx.fill();
text('CeliaOS — Integration in CeliaOS', M + 30, y + 40, { size: 19, weight: 'Mono6', color: C.muted, dir: 'ltr', align: 'left' });
text('v0.2.1 · schema 1 · 2026-11-01 · خطوط محلية · صفر طلب خارجي', XR, y + 40, { size: 19, weight: 'Plex4', color: C.dim });
y += 64 + 44;

const finalH = y;
const out = createCanvas(W, finalH);
out.getContext('2d').drawImage(canvas, 0, 0, W, finalH, 0, 0, W, finalH);
const target = process.argv[2] || 'docs/design/integration-in-celiaos.png';
writeFileSync(target, out.toBuffer('image/png'));
console.log(`wrote ${target} ${W}x${finalH}`);
