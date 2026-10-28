/**
 * Text normalisation shared by the classifier and the injection scanner.
 *
 * Issue text arrives in Arabic and English, with or without diacritics, with alef/ya/ta-marbuta spellings that
 * change nothing semantically. Matching on the raw bytes would make a policy depend on how the reporter types,
 * so both sides normalise first and every rule is written against the normalised form.
 */

const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** A short, single-line excerpt safe to quote in an audit record (no newlines, no long dumps). */
export function excerpt(text, limit = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function countWords(text) {
  const flat = String(text ?? '').trim();
  return flat ? flat.split(/\s+/).length : 0;
}
