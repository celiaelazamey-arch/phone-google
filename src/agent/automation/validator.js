import crypto from 'node:crypto';
import {
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  VALIDATION_STATUS,
  ACTION_STATUS,
  ALLOWED_CURRENCIES,
  validateAutomationSchema
} from './schema.js';

export function computeInvoiceFingerprint(fields = {}) {
  const norm = [
    String(fields.supplier_name || '').trim().toLowerCase(),
    String(fields.supplier_tax_id || '').trim().toLowerCase(),
    String(fields.invoice_number || '').trim().toUpperCase(),
    String(fields.currency || '').trim().toUpperCase(),
    typeof fields.total === 'number' && Number.isFinite(fields.total) ? fields.total.toFixed(2) : ''
  ].join('|');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Execute `data.validate`: deterministic programmatic check of fields, dates,
 * currencies, line-item totals, untrusted prompt-injection flags, and duplicates.
 */
export function validateExtractedData(
  {
    extracted = null,
    seenFingerprints = [],
    seenFileHashes = [],
    requireSupplierTaxId = true
  } = {}
) {
  if (!extracted || typeof extracted !== 'object' || !extracted.fields) {
    return {
      status: VALIDATION_STATUS.invalid,
      errors: ['missing_extracted_payload'],
      warnings: [],
      invoice_fingerprint: null,
      duplicate_of: null
    };
  }

  const fields = extracted.fields;
  const hardErrors = [];
  const reviewErrors = [];
  const warnings = [];

  if (!fields.invoice_number || typeof fields.invoice_number !== 'string' || !fields.invoice_number.trim()) {
    hardErrors.push('missing_invoice_number');
  }
  if (!fields.issue_date) {
    hardErrors.push('missing_issue_date');
  } else if (!isValidIsoDate(fields.issue_date)) {
    hardErrors.push('invalid_issue_date');
  }
  if (!fields.currency) {
    hardErrors.push('missing_currency');
  } else if (!ALLOWED_CURRENCIES.has(String(fields.currency).toUpperCase())) {
    hardErrors.push('unsupported_currency');
  }
  if (fields.total === null || fields.total === undefined || typeof fields.total !== 'number' || !Number.isFinite(fields.total)) {
    hardErrors.push('missing_total');
  } else if (fields.total <= 0) {
    hardErrors.push('invalid_total_amount');
  }

  if (!fields.supplier_name || !String(fields.supplier_name).trim()) {
    reviewErrors.push('supplier_identity_not_verified');
  } else if (requireSupplierTaxId && (!fields.supplier_tax_id || !String(fields.supplier_tax_id).trim())) {
    reviewErrors.push('supplier_identity_not_verified');
  }

  const lineItems = Array.isArray(fields.line_items) ? fields.line_items : [];
  if (lineItems.length > 0) {
    let computedItemsSum = 0;
    for (let i = 0; i < lineItems.length; i += 1) {
      const item = lineItems[i];
      const qty = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      const amount = Number(item.amount);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(amount)) {
        hardErrors.push(`invalid_line_item_${i + 1}`);
        continue;
      }
      const expectedLine = Math.round(qty * unitPrice * 100) / 100;
      if (Math.abs(expectedLine - amount) > 0.01) {
        hardErrors.push('line_item_math_mismatch');
      }
      computedItemsSum = Math.round((computedItemsSum + amount) * 100) / 100;
    }

    if (
      typeof fields.subtotal === 'number' &&
      Number.isFinite(fields.subtotal) &&
      Math.abs(computedItemsSum - fields.subtotal) > 0.01
    ) {
      hardErrors.push('subtotal_mismatch');
    }

    const baseAmount =
      typeof fields.subtotal === 'number' && Number.isFinite(fields.subtotal)
        ? fields.subtotal
        : computedItemsSum;
    const taxAmount = typeof fields.tax === 'number' && Number.isFinite(fields.tax) ? fields.tax : 0;
    const expectedTotal = Math.round((baseAmount + taxAmount) * 100) / 100;

    if (
      typeof fields.total === 'number' &&
      Number.isFinite(fields.total) &&
      Math.abs(expectedTotal - fields.total) > 0.01
    ) {
      hardErrors.push('total_mismatch');
    }
  } else if (
    typeof fields.subtotal === 'number' &&
    Number.isFinite(fields.subtotal) &&
    typeof fields.total === 'number' &&
    Number.isFinite(fields.total)
  ) {
    const taxAmount = typeof fields.tax === 'number' && Number.isFinite(fields.tax) ? fields.tax : 0;
    const expectedTotal = Math.round((fields.subtotal + taxAmount) * 100) / 100;
    if (Math.abs(expectedTotal - fields.total) > 0.01) {
      hardErrors.push('total_mismatch');
    }
  }

  if (extracted.security?.promptInjectionDetected) {
    reviewErrors.push('untrusted_instruction_in_document');
  }

  const fingerprint = computeInvoiceFingerprint(fields);
  const fileSha256 = extracted.source?.file_sha256 || null;

  let duplicateOf = null;
  if (Array.isArray(seenFingerprints) && seenFingerprints.includes(fingerprint)) {
    hardErrors.push('duplicate_invoice');
    duplicateOf = fingerprint;
  } else if (fileSha256 && Array.isArray(seenFileHashes) && seenFileHashes.includes(fileSha256)) {
    hardErrors.push('duplicate_document_fingerprint');
    duplicateOf = fileSha256;
  }

  const allErrors = [...new Set([...hardErrors, ...reviewErrors])];
  let status = VALIDATION_STATUS.valid;
  if (hardErrors.length > 0) {
    status = VALIDATION_STATUS.invalid;
  } else if (reviewErrors.length > 0) {
    status = VALIDATION_STATUS.reviewRequired;
  }

  return {
    status,
    errors: allErrors,
    warnings,
    invoice_fingerprint: fingerprint,
    file_sha256: fileSha256,
    duplicate_of: duplicateOf
  };
}

/**
 * Execute `data.report`: build the canonical `schema_version: "1.0"` automation
 * report. Extraction and reporting NEVER auto-commit an external write: `action.status`
 * begins as `not_committed`.
 */
export function buildAutomationReport({
  taskId = 'task-unknown',
  extracted,
  validation,
  actionStatus = ACTION_STATUS.notCommitted,
  committedRef = null
} = {}) {
  const safeActionStatus =
    validation?.status === VALIDATION_STATUS.valid && Object.values(ACTION_STATUS).includes(actionStatus)
      ? actionStatus
      : ACTION_STATUS.notCommitted;

  const report = {
    task_id: String(taskId || 'task-unknown'),
    capability: CAPABILITY_NAME,
    document_type: extracted?.document_type || DOCUMENT_TYPES.invoice,
    schema_version: AUTOMATION_SCHEMA_VERSION,
    source: extracted?.source || null,
    fields: extracted?.fields || {},
    provenance: extracted?.provenance || {},
    security: extracted?.security || { untrustedContent: true, promptInjectionDetected: false, findings: [] },
    validation: {
      status: validation?.status || VALIDATION_STATUS.invalid,
      errors: Array.isArray(validation?.errors) ? validation.errors : ['missing_validation'],
      invoice_fingerprint: validation?.invoice_fingerprint || null
    },
    action: {
      status: safeActionStatus,
      ...(committedRef ? { external_ref: committedRef } : {})
    }
  };

  const schemaCheck = validateAutomationSchema(report);
  if (!schemaCheck.ok) {
    throw Object.assign(new Error(`Report violated schema ${AUTOMATION_SCHEMA_VERSION}: ${schemaCheck.errors.join(', ')}`), {
      code: 'report_schema_invalid',
      details: schemaCheck.errors
    });
  }

  return report;
}
