import crypto from 'node:crypto';

export const DOCUMENT_CAPABILITY = 'document_data_automation';
export const DOCUMENT_SCHEMA_VERSION = '1.0';
export const MAX_DOCUMENT_CHARS = 1200;
export const MAX_LINE_ITEMS = 5;
export const SUPPORTED_FORMATS = Object.freeze(['csv', 'json', 'txt', 'markdown']);
export const ALLOWED_CURRENCIES = Object.freeze(['EGP', 'SAR', 'USD', 'EUR']);

export function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

export function parseNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  let normalized = normalizeDigits(value).replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!normalized || !/\d/.test(normalized)) return null;
  if (normalized.includes(',') && !normalized.includes('.') && /,\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(',', '.');
  } else {
    normalized = normalized.replace(/,/g, '');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCurrency(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim().toUpperCase();
  if (/\bEGP\b|\bLE\b|جنيه|جنية/.test(raw)) return 'EGP';
  if (/\bSAR\b|ر\.?\s*س|ريال سعودي/.test(raw)) return 'SAR';
  if (/\bUSD\b|\bUS\s*\$|\$|دولار/.test(raw)) return 'USD';
  if (/\bEUR\b|€|يورو/.test(raw)) return 'EUR';
  return raw;
}

export function normalizeIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = normalizeDigits(value.trim());
  let year;
  let month;
  let day;
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) return raw;
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return raw;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return normalizeIsoDate(value) === value;
}

export function computeInvoiceFingerprint(fields = {}) {
  const invoiceNumber = String(fields.invoice_number ?? '').trim().toLowerCase();
  const supplier = String(fields.supplier_name ?? '').trim().toLowerCase();
  if (!invoiceNumber || !supplier) return null;
  const material = JSON.stringify({
    invoice_number: invoiceNumber,
    supplier_name: supplier,
    issue_date: fields.issue_date ?? null,
    currency: fields.currency ?? null,
    total: fields.total ?? null
  });
  return sha256Text(material);
}

export function validateExtractedShape(extracted) {
  const errors = [];
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) {
    return { ok: false, errors: ['extracted_not_object'] };
  }
  if (extracted.capability !== DOCUMENT_CAPABILITY) errors.push('capability_mismatch');
  if (extracted.schema_version !== DOCUMENT_SCHEMA_VERSION) errors.push('schema_version_mismatch');
  if (!extracted.source || !isSha256(extracted.source.file_sha256)) errors.push('source_hash_invalid');
  if (!extracted.fields || typeof extracted.fields !== 'object' || Array.isArray(extracted.fields)) {
    errors.push('fields_not_object');
  }
  if (!extracted.provenance || typeof extracted.provenance !== 'object') errors.push('provenance_missing');
  if (!extracted.security || typeof extracted.security.prompt_injection_attempted !== 'boolean') {
    errors.push('security_metadata_missing');
  }
  return { ok: errors.length === 0, errors };
}
