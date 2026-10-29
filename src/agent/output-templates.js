import crypto from 'node:crypto';

/**
 * M-B/B3 — قوالب مخرجات حتمية (تقرير Markdown→HTML، جدول CSV، صفحة ويب ثابتة).
 *
 * دوال نقية بلا ساعة وبلا عشوائية وبلا شبكة: نفس الـspec ينتج نفس البايتات دائمًا،
 * فتصلح بوابةً ذهبية ببصمة SHA-256 مثبتة في CI. كل نص مُدخل يُهرَّب HTML —
 * القالب لا ينفذ محتوى ولا يضمّن سكربتات ولا يطلب أي مورد خارجي
 * (خطوط النظام فقط، CSS داخلي فقط — نفس ثابت صفحات المستودع).
 *
 * subset الـMarkdown المدعوم معلن ومحدود عمدًا: عناوين `#`/`##`/`###`، فقرات،
 * قوائم `- `، **عريض**، و`كود`. ما عداه نص عادي يُهرَّب كما هو — لا HTML خام أبدًا.
 */

export const TEMPLATE_KINDS = Object.freeze(['markdown_report', 'csv_table', 'static_page']);

const MAX_TEXT = 20_000;
const MAX_ROWS = 2_000;
const MAX_COLUMNS = 64;

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertText(value, code, { max = MAX_TEXT, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw coded(code);
  return value;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** سطر Markdown مضمّن: عريض وكود فقط — بعد تهريب HTML الكامل. */
function inlineMd(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

/** subset حتمي: عناوين/قوائم/فقرات. لا HTML خام يمر إطلاقًا. */
export function markdownToHtml(markdown) {
  assertText(markdown, 'template_markdown_invalid');
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(inlineMd).join(' ')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<ul>${list.map((item) => `<li>${inlineMd(item)}</li>`).join('')}</ul>`);
      list = null;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1; // المستند يحجز <h1> للعنوان الرئيسي.
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      flushParagraph();
      list = list || [];
      list.push(trimmed.slice(2));
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

/** غلاف صفحة واحد للقالبين HTML: RTL، CSS داخلي، صفر طلبات خارجية. */
function htmlDocument({ title, lang, dir, bodyHtml, footer }) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${escapeHtml(dir)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:2rem 1rem;line-height:1.7;max-width:56rem;margin-inline:auto}
h1{border-block-end:2px solid currentColor;padding-block-end:.4rem}
table{border-collapse:collapse;width:100%;margin-block:1rem}
th,td{border:1px solid currentColor;padding:.45rem .7rem;text-align:start}
code{padding:.1rem .35rem;border:1px solid currentColor;border-radius:.3rem;font-size:.92em}
footer{margin-block-start:2.5rem;font-size:.85em;opacity:.75;border-block-start:1px solid currentColor;padding-block-start:.6rem}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
<footer>${escapeHtml(footer)}</footer>
</body>
</html>
`;
}

/** B3-1: تقرير Markdown→HTML — أقسام من عناوين ونص subset محدود. */
export function renderMarkdownReport(spec = {}) {
  const title = assertText(spec.title, 'template_title_invalid', { max: 200 });
  if (!Array.isArray(spec.sections) || spec.sections.length === 0 || spec.sections.length > 40) {
    throw coded('template_sections_invalid');
  }
  const parts = [];
  for (const section of spec.sections) {
    const heading = assertText(section?.heading, 'template_section_heading_invalid', { max: 200 });
    const body = assertText(section?.body, 'template_section_body_invalid');
    parts.push(`<section>\n<h2>${inlineMd(heading)}</h2>\n${markdownToHtml(body)}\n</section>`);
  }
  return htmlDocument({
    title,
    lang: typeof spec.lang === 'string' && spec.lang ? spec.lang : 'ar',
    dir: spec.dir === 'ltr' ? 'ltr' : 'rtl',
    bodyHtml: parts.join('\n'),
    footer: 'تقرير مُولَّد حتميًا من قالب B3 — المحتوى مُهرَّب بالكامل ولا يحمّل أي مورد خارجي.'
  });
}

/** B3-2: جدول CSV — اقتباس RFC 4180، فواصل أسطر \n حتمية. */
export function renderCsvTable(spec = {}) {
  if (!Array.isArray(spec.columns) || spec.columns.length === 0 || spec.columns.length > MAX_COLUMNS) {
    throw coded('template_columns_invalid');
  }
  if (!Array.isArray(spec.rows) || spec.rows.length > MAX_ROWS) throw coded('template_rows_invalid');
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (text.length > MAX_TEXT) throw coded('template_cell_too_large');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [spec.columns.map((column) => cell(assertText(column, 'template_columns_invalid', { max: 200 }))).join(',')];
  for (const row of spec.rows) {
    if (!Array.isArray(row) || row.length !== spec.columns.length) throw coded('template_row_shape_invalid');
    lines.push(row.map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** B3-3: صفحة ويب ثابتة واحدة — body بنفس subset الـMarkdown. */
export function renderStaticPage(spec = {}) {
  const title = assertText(spec.title, 'template_title_invalid', { max: 200 });
  const body = assertText(spec.body, 'template_body_invalid', { max: 60_000 });
  return htmlDocument({
    title,
    lang: typeof spec.lang === 'string' && spec.lang ? spec.lang : 'ar',
    dir: spec.dir === 'ltr' ? 'ltr' : 'rtl',
    bodyHtml: markdownToHtml(body),
    footer: 'صفحة ثابتة مُولَّدة حتميًا من قالب B3 — بلا سكربتات وبلا أي طلب خارجي.'
  });
}

/** نقطة دخول الأداة: kind معلن أو رفض بكود صريح؛ الناتج Buffer وبصمته. */
export function renderTemplate(kind, spec) {
  let text;
  if (kind === 'markdown_report') text = renderMarkdownReport(spec);
  else if (kind === 'csv_table') text = renderCsvTable(spec);
  else if (kind === 'static_page') text = renderStaticPage(spec);
  else throw coded('template_kind_unknown');
  const content = Buffer.from(text, 'utf8');
  return { content, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length };
}
