/**
 * Arabic-first text normalization for the knowledge index.
 *
 * Deterministic and length-mapped: every character of the normalized string keeps
 * a pointer to its offset in the NFKC source, so snippets are cut from real text
 * and never from a re-assembled guess. No stemming beyond the definite article:
 * aggressive roots would silently merge unrelated tools and skills.
 */

const ARABIC_DIACRITIC_RANGES = [
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06ed],
  [0x08d3, 0x08ff]
];

const TATWEEL = 0x0640;
const LETTER_MAP = new Map([
  [0x0622, 'ا'], // آ
  [0x0623, 'ا'], // أ
  [0x0625, 'ا'], // إ
  [0x0627, 'ا'], // ا
  [0x0671, 'ا'], // ٱ
  [0x0649, 'ي'], // ى
  [0x064a, 'ي'], // ي
  [0x0626, 'ي'], // ئ
  [0x0624, 'و'], // ؤ
  [0x0629, 'ه'], // ة
  [0x06a9, 'ك'], // ک
  [0x06cc, 'ي'], // ی
  [0x06c0, 'ه'], // ۀ
  [0x200c, ''], // ZWNJ
  [0x200d, ''], // ZWJ
  [0x200e, ''],
  [0x200f, ''],
  [0xfeff, '']
]);

const DIGIT_MAP = new Map();
for (let index = 0; index < 10; index += 1) {
  DIGIT_MAP.set(0x0660 + index, String(index)); // ٠-٩
  DIGIT_MAP.set(0x06f0 + index, String(index)); // ۰-۹
}

const isDiacritic = (code) => ARABIC_DIACRITIC_RANGES.some(([start, end]) => code >= start && code <= end);

export const STOPWORDS = Object.freeze(
  new Set([
    'في', 'من', 'على', 'الى', 'عن', 'ان', 'انه', 'انها', 'هذا', 'هذه', 'ذلك', 'تلك',
    'التي', 'الذي', 'الذين', 'مع', 'او', 'ثم', 'قد', 'كان', 'كانت', 'يكون', 'هو', 'هي',
    'هم', 'لا', 'ما', 'كل', 'بعد', 'قبل', 'عند', 'بين', 'حتى', 'اذا', 'كما', 'لكن',
    'بل', 'اي', 'اين', 'كيف', 'متى', 'لماذا', 'هل', 'نحن', 'انا', 'انت', 'عليه',
    'عليها', 'له', 'لها', 'به', 'بها', 'منه', 'منها', 'ايضا', 'غير', 'فقط', 'ثم',
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
    'with', 'by', 'at', 'as', 'it', 'this', 'that', 'be', 'from', 'how', 'what',
    'which', 'when', 'why', 'who', 'do', 'does', 'can', 'should'
  ])
);

/** NFKC source kept for snippets plus a per-character offset map. */
export function normalizeWithMap(input) {
  const source = String(input ?? '').normalize('NFKC');
  let text = '';
  const offsets = [];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.codePointAt(index);
    if (code > 0xffff) {
      // Astral characters are kept as-is but consume two UTF-16 units.
      text += source.slice(index, index + 2);
      offsets.push(index, index + 1);
      index += 1;
      continue;
    }
    if (isDiacritic(code) || code === TATWEEL) continue;
    let mapped = LETTER_MAP.get(code);
    if (mapped === '') continue;
    if (mapped === undefined) mapped = DIGIT_MAP.get(code);
    if (mapped === undefined) mapped = String.fromCharCode(code);
    mapped = mapped.toLowerCase();
    if (/\s/.test(mapped)) mapped = ' ';
    for (let k = 0; k < mapped.length; k += 1) offsets.push(index);
    text += mapped;
  }
  text = text.replace(/\s+/g, ' ').trim();
  offsets.push(source.length);
  return { source, text, offsets: offsets.slice(0, text.length + 1) };
}

export function normalize(input) {
  return normalizeWithMap(input).text;
}

/** Index term for a normalized token: strip the definite article only. */
export function stem(term) {
  if (term.length > 4 && term.startsWith('ال')) return term.slice(2);
  return term;
}

export function tokenize(input, { keepStopwords = false } = {}) {
  const normalized = normalize(input);
  const tokens = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0];
    if (raw.length < 2) continue;
    if (!keepStopwords && STOPWORDS.has(raw)) continue;
    tokens.push(raw);
    const stemmed = stem(raw);
    if (stemmed !== raw) tokens.push(stemmed);
  }
  return [...new Set(tokens)];
}

/** Unique tokens for FTS/query use, without the stem duplicates. */
export function queryTerms(input) {
  const normalized = normalize(input);
  const terms = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0];
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (!terms.includes(raw)) terms.push(raw);
  }
  return terms;
}

/**
 * Snippet around the first matching term, cut from the NFKC source so the text
 * stays original. `width` is the approximate character budget.
 */
export function snippet(input, terms, { width = 180, highlight = false } = {}) {
  const { source, text, offsets } = normalizeWithMap(input);
  if (!text) return '';
  const wanted = (terms || []).map((term) => normalize(term)).filter(Boolean);
  let at = -1;
  let hit = '';
  for (const term of wanted) {
    const index = term ? text.indexOf(term) : -1;
    if (index !== -1 && (at === -1 || index < at)) {
      at = index;
      hit = term;
    }
  }
  const clean = (value) => value.replace(/\s+/g, ' ').trim();
  if (at === -1) return clean(source.slice(0, width)) + (source.length > width ? '…' : '');
  const lead = Math.max(0, Math.floor((width - hit.length) / 3));
  const start = Math.max(0, at - lead);
  const end = Math.min(text.length, start + width);
  const sourceStart = offsets[start] ?? 0;
  const sourceEnd = offsets[end] ?? source.length;
  const body = clean(source.slice(sourceStart, sourceEnd));
  const marked = highlight && hit ? body.replace(new RegExp(escapeRegExp(hit), 'gu'), `«${hit}»`) : body;
  return `${start > 0 ? '…' : ''}${marked}${end < text.length ? '…' : ''}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map a normalized query term back to the source offset (used by diagnostics). */
export function offsetOf(input, term) {
  const { text, offsets } = normalizeWithMap(input);
  const at = text.indexOf(normalize(term));
  return at === -1 ? null : offsets[at];
}

const PREFIXES = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'و', 'ب', 'ك', 'ف', 'ل', 'س'];
const SUFFIXES = ['هما', 'هم', 'ها', 'كم', 'نا', 'ات', 'ون', 'ين', 'ان', 'ه', 'ي'];

/**
 * Recall-oriented query expansion (never used for indexing): Arabic attaches
 * prefixes and suffixes to stems, so "أربط" must still reach "ربط". Only whole
 * affixes are removed, the result must stay >= 3 characters, and the variants are
 * used with OR after the exact terms fail to produce enough candidates.
 */
export function expandTerms(terms) {
  const out = new Set();
  for (const term of terms) {
    out.add(term);
    if (term.length < 5) continue;
    for (const prefix of PREFIXES) {
      if (term.startsWith(prefix) && term.length - prefix.length >= 3) {
        const stemmed = term.slice(prefix.length);
        out.add(stemmed);
        for (const suffix of SUFFIXES) {
          if (stemmed.endsWith(suffix) && stemmed.length - suffix.length >= 3) out.add(stemmed.slice(0, -suffix.length));
        }
      }
    }
    for (const suffix of SUFFIXES) {
      if (term.endsWith(suffix) && term.length - suffix.length >= 3) out.add(term.slice(0, -suffix.length));
    }
  }
  return [...out];
}
