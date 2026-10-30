import { readFileSync } from 'node:fs';

/**
 * «هل تقدّم المستودع بعد آخر إصدار؟» — مقيسًا لا مُعلنًا.
 *
 * سجل الإصدارات (`releases/history.json`) لا يستطيع أن يعرف ما جرى بعد آخر إصدار:
 * هو يسجّل الإصدارات فقط. فبدل إضافة لوحة أرقام تجميلية (تفضي DEC-030)، نقرأ ملفًا
 * واحدًا هو المصدر الحقيقي لما لم يُطلق بعد: قسم `Unreleased` في `CHANGELOG.md`.
 *
 * القواعد:
 * - لا نختلق صفرًا: إن تعذّرت القراءة أو فشل التحليل نُعيد `parsed: false` وتصمت الواجهة.
 * - لا نستنتج إصدارًا: `items` عدد بنود موثّقة، ليس «نسخة قادمة» ولا وعد إطلاق.
 * - حدود صريحة: ملف ≤2MiB، وأول 500 بند فقط، وأسماء أقسام مغلقة.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const UNRELEASED_HEADING = /^##\s+unreleased\b[^\n]*$/im;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+\S/;
const KNOWN_SECTIONS = Object.freeze([
  'added',
  'changed',
  'fixed',
  'removed',
  'security',
  'deprecated',
  'limits',
]);

function blankSections() {
  const sections = {};
  for (const key of KNOWN_SECTIONS) sections[key] = 0;
  return sections;
}

/**
 * يحلّل نص CHANGELOG ويعيد ما لم يُطلق بعد.
 * @returns {{parsed: boolean, items: number, sections: object, unknownSections: number}}
 */
export function parseUnreleased(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { parsed: false, items: 0, sections: blankSections(), unknownSections: 0 };
  const start = markdown.search(UNRELEASED_HEADING);
  if (start === -1) return { parsed: true, items: 0, sections: blankSections(), unknownSections: 0 };

  const afterHeading = markdown.slice(markdown.indexOf('\n', start) + 1);
  const end = afterHeading.search(/^##\s+\S/m);
  const block = end === -1 ? afterHeading : afterHeading.slice(0, end);

  const sections = blankSections();
  let items = 0;
  let unknownSections = 0;
  let current = null;
  for (const line of block.split('\n')) {
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      const key = heading[1].trim().toLowerCase();
      const known = KNOWN_SECTIONS.find((name) => key.startsWith(name));
      current = known || null;
      if (!known) unknownSections += 1;
      continue;
    }
    if (!BULLET.test(line)) continue;
    if (items >= MAX_ITEMS) break;
    items += 1;
    if (current) sections[current] += 1;
  }
  return { parsed: true, items, sections, unknownSections };
}

let cache = null;

/**
 * يقرأ `CHANGELOG.md` من جذر الحزمة. الصورة قد لا تحمله، والفشل هنا لا يُفشل أي طلب:
 * الواجهة تصمت حين `parsed=false` بدل أن تعرض صفرًا كأنه حقيقة.
 */
export function unreleasedProgress({ file = new URL('../CHANGELOG.md', import.meta.url), fresh = false } = {}) {
  if (!fresh && cache) return cache;
  try {
    const text = readFileSync(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      cache = { parsed: false, items: 0, sections: blankSections(), unknownSections: 0, reason: 'changelog_too_large' };
      return cache;
    }
    cache = parseUnreleased(text);
    return cache;
  } catch {
    cache = { parsed: false, items: 0, sections: blankSections(), unknownSections: 0, reason: 'changelog_unavailable' };
    return cache;
  }
}

export const UNRELEASED_LIMITS = Object.freeze({ MAX_BYTES, MAX_ITEMS, KNOWN_SECTIONS });
