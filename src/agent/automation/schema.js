/**
 * Document & Data Automation — Canonical Schema & Untrusted Content Guard.
 *
 * Capability: `document_data_automation`
 * Schema Version: `1.0`
 *
 * Every document is treated strictly as untrusted data, never as instructions
 * that can alter agent policies, select tools, or bypass approval gates.
 */

export const CAPABILITY_NAME = 'document_data_automation';
export const AUTOMATION_SCHEMA_VERSION = '1.0';

export const DOCUMENT_TYPES = Object.freeze({
  invoice: 'invoice',
  purchaseOrder: 'purchase_order',
  receipt: 'receipt',
  tabular: 'tabular'
});

export const VALIDATION_STATUS = Object.freeze({
  valid: 'valid',
  reviewRequired: 'review_required',
  invalid: 'invalid'
});

export const ACTION_STATUS = Object.freeze({
  notCommitted: 'not_committed',
  waitingApproval: 'waiting_approval',
  committed: 'committed'
});

export const ALLOWED_CURRENCIES = Object.freeze(new Set(['EGP', 'USD', 'SAR', 'EUR', 'AED', 'GBP']));

const INJECTION_PATTERNS = [
  {
    id: 'ignore_policies_ar',
    pattern: /تجاهل\s+(?:كل\s+|جميع\s+)?(?:السياسات|التعليمات|القواعد|الموافقة|شروط)/i
  },
  {
    id: 'force_approve_ar',
    pattern: /(?:اعتمد|نفذ|نفّذ|مرر)\s+(?:الفاتورة|العملية|الكتابة|الأمر)\s+(?:فورًا|فورا|بدون\s+موافقة|تلقائيًا)/i
  },
  {
    id: 'ignore_instructions_en',
    pattern: /ignore\s+(?:all\s+|previous\s+|prior\s+|system\s+)?(?:instructions|policies|rules|approvals)/i
  },
  {
    id: 'privilege_escalation',
    pattern: /\b(?:sandbox\.exec|CELIA_MCP_API_TOKEN|TOKEN_ENCRYPTION_KEY|GEMINI_API_KEY|system\s*prompt|bypass\s+approval)\b/i
  }
];

/**
 * Scan untrusted document text for embedded prompt-injection or policy-override attempts.
 * Never mutates the original numbers/fields, but flags the document so policy validation
 * routes it to human review (`review_required`) and blocks automatic commitment.
 */
export function scanUntrustedDocumentContent(rawText = '') {
  const text = String(rawText || '');
  const findings = [];
  for (const rule of INJECTION_PATTERNS) {
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push({
        ruleId: rule.id,
        excerpt: String(match[0]).slice(0, 120)
      });
    }
  }
  return {
    untrustedContent: true,
    promptInjectionDetected: findings.length > 0,
    findings
  };
}

/**
 * Validate that an extraction or report payload conforms to `schema_version: "1.0"`.
 */
export function validateAutomationSchema(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['record_must_be_object'] };
  }
  if (record.capability !== CAPABILITY_NAME) {
    errors.push('invalid_capability_name');
  }
  if (record.schema_version !== AUTOMATION_SCHEMA_VERSION) {
    errors.push('unsupported_schema_version');
  }
  if (!Object.values(DOCUMENT_TYPES).includes(record.document_type)) {
    errors.push('invalid_document_type');
  }
  if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
    errors.push('missing_fields_object');
  } else {
    const f = record.fields;
    if (f.invoice_number !== undefined && f.invoice_number !== null && typeof f.invoice_number !== 'string') {
      errors.push('field_invoice_number_must_be_string');
    }
    if (f.currency !== undefined && f.currency !== null && typeof f.currency !== 'string') {
      errors.push('field_currency_must_be_string');
    }
    if (f.total !== undefined && f.total !== null && (typeof f.total !== 'number' || !Number.isFinite(f.total))) {
      errors.push('field_total_must_be_finite_number');
    }
    if (f.subtotal !== undefined && f.subtotal !== null && (typeof f.subtotal !== 'number' || !Number.isFinite(f.subtotal))) {
      errors.push('field_subtotal_must_be_finite_number');
    }
    if (f.tax !== undefined && f.tax !== null && (typeof f.tax !== 'number' || !Number.isFinite(f.tax))) {
      errors.push('field_tax_must_be_finite_number');
    }
    if (f.line_items !== undefined && !Array.isArray(f.line_items)) {
      errors.push('field_line_items_must_be_array');
    }
  }
  if (record.validation !== undefined) {
    if (!record.validation || typeof record.validation !== 'object') {
      errors.push('invalid_validation_object');
    } else if (!Object.values(VALIDATION_STATUS).includes(record.validation.status)) {
      errors.push('invalid_validation_status');
    } else if (!Array.isArray(record.validation.errors)) {
      errors.push('validation_errors_must_be_array');
    }
  }
  if (record.action !== undefined) {
    if (!record.action || typeof record.action !== 'object') {
      errors.push('invalid_action_object');
    } else if (!Object.values(ACTION_STATUS).includes(record.action.status)) {
      errors.push('invalid_action_status');
    }
  }
  return {
    ok: errors.length === 0,
    errors
  };
}
