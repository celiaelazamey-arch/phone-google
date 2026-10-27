import {
  ALLOWED_CURRENCIES,
  computeInvoiceFingerprint,
  isSha256,
  isValidIsoDate,
  validateExtractedShape
} from './schema.js';

const REQUIRED_FIELDS = Object.freeze([
  'invoice_number', 'supplier_name', 'issue_date', 'currency',
  'subtotal', 'tax', 'total', 'line_items'
]);

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function validateInvoice(extracted, { existingReport = null } = {}) {
  const shape = validateExtractedShape(extracted);
  if (!shape.ok) {
    return {
      status: 'invalid',
      errors: shape.errors,
      review_items: [],
      invoice_fingerprint: null,
      duplicate_of_run_id: null
    };
  }

  const fields = extracted.fields;
  const provenance = extracted.provenance || {};
  const missing = [];
  const errors = [];
  const reviewItems = [];

  for (const field of REQUIRED_FIELDS) {
    const value = fields[field];
    if (value === null || value === undefined || value === '' || (field === 'line_items' && (!Array.isArray(value) || !value.length))) {
      missing.push('missing_' + field);
    }
  }

  for (const field of ['subtotal', 'tax', 'total']) {
    if (provenance[field] && fields[field] === null) errors.push('invalid_' + field);
    if (typeof fields[field] === 'number' && fields[field] < 0) errors.push('negative_' + field);
  }

  if (fields.issue_date && !isValidIsoDate(fields.issue_date)) errors.push('invalid_issue_date');
  if (fields.currency && !ALLOWED_CURRENCIES.includes(fields.currency)) errors.push('unsupported_currency');

  const numericTotals = ['subtotal', 'tax', 'total'].every((field) => typeof fields[field] === 'number' && Number.isFinite(fields[field]));
  if (numericTotals && Math.abs(roundMoney(fields.subtotal + fields.tax) - roundMoney(fields.total)) > 0.01) {
    errors.push('total_mismatch');
  }

  if (Array.isArray(fields.line_items)) {
    for (const item of fields.line_items) {
      if (!item || typeof item !== 'object') {
        errors.push('line_item_invalid');
        continue;
      }
      if (typeof item.quantity === 'number' && typeof item.unit_price === 'number' && typeof item.amount === 'number') {
        if (Math.abs(roundMoney(item.quantity * item.unit_price) - roundMoney(item.amount)) > 0.01) {
          errors.push('line_item_amount_mismatch');
        }
      } else {
        reviewItems.push('line_item_fields_incomplete');
      }
    }
    if (fields.line_items.length && fields.line_items.every((item) => typeof item.amount === 'number') && typeof fields.subtotal === 'number') {
      const itemTotal = roundMoney(fields.line_items.reduce((sum, item) => sum + item.amount, 0));
      if (Math.abs(itemTotal - roundMoney(fields.subtotal)) > 0.01) errors.push('subtotal_mismatch');
    }
  }

  const fingerprint = computeInvoiceFingerprint(fields);
  if (extracted.source?.file_sha256 && !isSha256(extracted.source.file_sha256)) errors.push('source_hash_invalid');
  if (extracted.security?.prompt_injection_attempted) reviewItems.push('prompt_injection_detected');
  if (Array.isArray(extracted.security?.sanitized_warnings) && extracted.security.sanitized_warnings.includes('line_items_truncated')) {
    reviewItems.push('line_items_truncated');
  }

  let duplicateOf = null;
  if (existingReport) {
    errors.push('duplicate_document_or_invoice_fingerprint');
    duplicateOf = existingReport.run_id || existingReport.runId || null;
  }

  const uniqueErrors = [...new Set(errors)];
  const uniqueMissing = [...new Set(missing)];
  const uniqueReviewItems = [...new Set(reviewItems)];
  const status = uniqueErrors.length ? 'invalid' : uniqueMissing.length || uniqueReviewItems.length ? 'review_required' : 'valid';

  return {
    status,
    errors: uniqueErrors,
    review_items: [...uniqueMissing, ...uniqueReviewItems],
    invoice_fingerprint: fingerprint,
    duplicate_of_run_id: duplicateOf
  };
}
