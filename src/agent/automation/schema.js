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

export const COMPREHENSION_GATE_STATUS = Object.freeze({
  pass: 'PASS',
  block: 'BLOCK',
  unknown: 'UNKNOWN'
});

export const EXPLANATION_VERIFICATION_STATUS = Object.freeze({
  valid: 'valid',
  reviewRequired: 'review_required',
  invalid: 'invalid',
  unknown: 'unknown'
});

export const NEXT_PERMITTED_ACTION = Object.freeze({
  awaitOwnerApproval: 'await_owner_approval_for_commit',
  reportOnlyNoCommit: 'report_only_no_external_write',
  requestHumanReview: 'request_human_review_no_commit',
  fixSourceDocument: 'fix_source_document_no_commit',
  reconcileUnknownOutcome: 'reconcile_unknown_outcome_no_replay'
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
    pattern: /ignore\s+(?:all\s+|previous\s+|prior\s+|system\s+)*(?:instructions|policies|rules|approvals)/i
  },
  {
    id: 'privilege_escalation',
    pattern: /\b(?:sandbox\.exec|CELIA_MCP_API_TOKEN|TOKEN_ENCRYPTION_KEY|GEMINI_API_KEY|system\s*prompt|system\s+override|bypass\s+(?:owner\s+)?approval)\b/i
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
  if (record.explanation !== undefined) {
    const expCheck = validateExplanationContract(record.explanation);
    if (!expCheck.ok) {
      errors.push(...expCheck.errors);
    }
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

/**
 * Validate the Phase 3 Comprehension Gate (`explanation`) contract.
 * Compatible additive extension on `schema_version: "1.0"`.
 */
export function validateExplanationContract(explanation) {
  const errors = [];
  if (!explanation || typeof explanation !== 'object' || Array.isArray(explanation)) {
    return { ok: false, errors: ['explanation_must_be_object'] };
  }
  if (typeof explanation.goal_plain !== 'string' || !explanation.goal_plain.trim()) {
    errors.push('explanation_missing_goal_plain');
  }
  if (!Array.isArray(explanation.success_criteria) || explanation.success_criteria.length === 0) {
    errors.push('explanation_missing_success_criteria');
  }
  if (
    !Array.isArray(explanation.plan_steps) ||
    explanation.plan_steps.length === 0 ||
    explanation.plan_steps.some(
      (step) =>
        !step ||
        typeof step !== 'object' ||
        typeof step.tool !== 'string' ||
        !step.tool.trim() ||
        typeof step.why_plain !== 'string' ||
        !step.why_plain.trim()
    )
  ) {
    errors.push('explanation_invalid_plan_steps');
  }
  if (!Array.isArray(explanation.verified_facts)) {
    errors.push('explanation_verified_facts_must_be_array');
  } else {
    for (const fact of explanation.verified_facts) {
      if (
        !fact ||
        typeof fact !== 'object' ||
        typeof fact.field !== 'string' ||
        !fact.field.trim() ||
        typeof fact.source_ref !== 'string' ||
        !fact.source_ref.trim() ||
        typeof fact.plain_statement !== 'string' ||
        !fact.plain_statement.trim()
      ) {
        errors.push('explanation_verified_fact_missing_provenance');
        break;
      }
    }
  }
  if (!Array.isArray(explanation.assumptions)) {
    errors.push('explanation_assumptions_must_be_array');
  }
  if (!Array.isArray(explanation.unknowns)) {
    errors.push('explanation_unknowns_must_be_array');
  }
  if (!Array.isArray(explanation.risks_and_side_effects)) {
    errors.push('explanation_risks_must_be_array');
  }
  if (typeof explanation.simple_summary !== 'string' || !explanation.simple_summary.trim()) {
    errors.push('explanation_missing_simple_summary');
  }
  if (!Object.values(EXPLANATION_VERIFICATION_STATUS).includes(explanation.verification_status)) {
    errors.push('explanation_invalid_verification_status');
  }
  if (!Object.values(NEXT_PERMITTED_ACTION).includes(explanation.next_permitted_action)) {
    errors.push('explanation_invalid_next_permitted_action');
  }
  if (
    !explanation.comprehension_gate ||
    typeof explanation.comprehension_gate !== 'object' ||
    !Object.values(COMPREHENSION_GATE_STATUS).includes(explanation.comprehension_gate.status) ||
    !Array.isArray(explanation.comprehension_gate.contradictions) ||
    !Array.isArray(explanation.comprehension_gate.ungrounded_claims)
  ) {
    errors.push('explanation_invalid_comprehension_gate');
  }
  return {
    ok: errors.length === 0,
    errors
  };
}
