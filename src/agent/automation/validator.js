import crypto from 'node:crypto';
import {
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  VALIDATION_STATUS,
  ACTION_STATUS,
  COMPREHENSION_GATE_STATUS,
  EXPLANATION_VERIFICATION_STATUS,
  NEXT_PERMITTED_ACTION,
  ALLOWED_CURRENCIES,
  validateAutomationSchema,
  validateExplanationContract
} from './schema.js';
import { explainExtractedFields } from './extractor.js';

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

  const baseResult = {
    status,
    errors: allErrors,
    warnings,
    invoice_fingerprint: fingerprint,
    file_sha256: fileSha256,
    duplicate_of: duplicateOf
  };

  const validationExplanation = explainValidationOutcome({
    extracted,
    validation: baseResult
  });

  return {
    ...baseResult,
    explanation_summary: validationExplanation.simple_summary,
    reason_explanations: validationExplanation.reason_explanations,
    math_check: validationExplanation.math_check
  };
}

/**
 * Translate deterministic validation findings into plain language understandable
 * by a beginner, strictly derived from the extracted numbers and rule codes.
 */
export function explainValidationOutcome({
  extracted = null,
  validation = null,
  executionState = null
} = {}) {
  const fields = extracted?.fields || {};
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  const status =
    executionState === 'unknown'
      ? EXPLANATION_VERIFICATION_STATUS.unknown
      : validation?.status || VALIDATION_STATUS.invalid;

  const lineItems = Array.isArray(fields.line_items) ? fields.line_items : [];
  const computedLineSum =
    lineItems.length > 0
      ? Math.round(lineItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0) * 100) / 100
      : null;
  const baseAmount =
    typeof fields.subtotal === 'number' && Number.isFinite(fields.subtotal)
      ? fields.subtotal
      : computedLineSum;
  const taxAmount = typeof fields.tax === 'number' && Number.isFinite(fields.tax) ? fields.tax : 0;
  const expectedTotal =
    typeof baseAmount === 'number' && Number.isFinite(baseAmount)
      ? Math.round((baseAmount + taxAmount) * 100) / 100
      : null;

  const reason_explanations = [];

  if (executionState === 'unknown') {
    reason_explanations.push(
      'توقف التنفيذ أو انقطع قبل التأكد من النتيجة النهائية (الحالة unknown). لا يدّعي النظام نجاح العملية، ويجب إجراء مصالحة بشرية قبل أي خطوة تالية.'
    );
  }

  for (const err of errors) {
    if (err === 'total_mismatch') {
      const subText = baseAmount !== null ? String(baseAmount) : 'غير محدد';
      const taxText = String(taxAmount);
      const expText = expectedTotal !== null ? String(expectedTotal) : 'غير محدد';
      const actText = fields.total !== null && fields.total !== undefined ? String(fields.total) : 'غير محدد';
      reason_explanations.push(
        `الفاتورة تحتاج إلى تصحيح. مجموع ${subText} و${taxText} يساوي ${expText}، وليس ${actText}. لذلك لا يمكن اعتماد الفاتورة حتى يُحلّ الاختلاف.`
      );
    } else if (err === 'subtotal_mismatch') {
      reason_explanations.push(
        `مجموع البنود (${computedLineSum}) لا يطابق المجموع الفرعي المسجل (${fields.subtotal}). لا يمكن اعتماد الفاتورة قبل تصحيح الأرقام.`
      );
    } else if (err === 'line_item_math_mismatch') {
      reason_explanations.push(
        'أحد بنود الفاتورة يحتوي على حاصل ضرب (الكمية × سعر الوحدة) لا يطابق مبلغ البند المسجل.'
      );
    } else if (err === 'supplier_identity_not_verified') {
      const missingPart = !fields.supplier_name
        ? 'اسم المورد غير مذكور'
        : !fields.supplier_tax_id
          ? 'الرقم الضريبي للمورد غير مذكور'
          : 'بيانات المورد غير مكتملة';
      reason_explanations.push(
        `الفاتورة تحتاج إلى مراجعة بشرية قبل أي اعتماد؛ بيانات هوية المورد ناقصة (${missingPart})، ولم يخترع النظام بيانات بديلة.`
      );
    } else if (err === 'untrusted_instruction_in_document') {
      reason_explanations.push(
        'اكتشف النظام داخل نص المستند عبارة تحاول إصدار أوامر أو تجاوز السياسات. تعامل النظام مع محتوى المستند كبيانات غير موثوقة فقط وليس كأوامر، وأوقف اعتماد الفاتورة للمراجعة البشرية.'
      );
    } else if (err === 'duplicate_invoice' || err === 'duplicate_document_fingerprint') {
      reason_explanations.push(
        'الفاتورة مكررة؛ بصمتها الرقمية مسجلة مسبقًا، لذلك رُفضت لمنع تسجيل نفس الفاتورة مرتين.'
      );
    } else if (err === 'missing_invoice_number') {
      reason_explanations.push('رقم الفاتورة مفقود في المستند، ولا يمكن قبول فاتورة بلا رقم تعريفي.');
    } else if (err === 'missing_issue_date' || err === 'invalid_issue_date') {
      reason_explanations.push('تاريخ إصدار الفاتورة مفقود أو بصيغة غير صحيحة.');
    } else if (err === 'missing_currency' || err === 'unsupported_currency') {
      reason_explanations.push('عملة الفاتورة مفقودة أو غير مدعومة في السياسة الحالية.');
    } else if (err === 'missing_total' || err === 'invalid_total_amount') {
      reason_explanations.push('المبلغ الإجمالي مفقود أو غير صالح.');
    } else {
      reason_explanations.push(`تعذر تمرير الفاتورة بسبب مخالفة قاعدة التحقق: ${err}.`);
    }
  }

  if (status === EXPLANATION_VERIFICATION_STATUS.valid && reason_explanations.length === 0) {
    reason_explanations.push(
      `الفاتورة صحيحة ومكتملة؛ مجموع ${baseAmount ?? fields.total} والضريبة ${taxAmount} يساوي الإجمالي المسجل ${fields.total} ${fields.currency || ''}، وكل الحقول الأساسية موثقة بمواضعها في المستند.`
    );
  }

  const simple_summary = reason_explanations.join(' ');

  return {
    status,
    simple_summary,
    reason_explanations,
    math_check: {
      subtotal: baseAmount,
      tax: taxAmount,
      expected_total: expectedTotal,
      recorded_total: fields.total ?? null,
      matches:
        expectedTotal !== null &&
        typeof fields.total === 'number' &&
        Math.abs(expectedTotal - fields.total) <= 0.01
    }
  };
}

/**
 * Evaluate the Comprehension Gate (`evaluateComprehensionGate`) against deterministic
 * extraction, provenance, validation, and execution state.
 *
 * A persuasive explanation that contradicts the numbers, invents ungrounded facts,
 * claims success on an invalid/unknown run, or tries to bypass approval is BLOCKED.
 */
export function evaluateComprehensionGate({
  explanation,
  extracted = null,
  validation = null,
  action = null,
  executionState = null
} = {}) {
  const contractCheck = validateExplanationContract(explanation);
  const contradictions = [];
  const ungrounded_claims = [];

  if (!contractCheck.ok) {
    return {
      status: COMPREHENSION_GATE_STATUS.block,
      contradictions: contractCheck.errors,
      ungrounded_claims
    };
  }

  const actualStatus =
    executionState === 'unknown'
      ? EXPLANATION_VERIFICATION_STATUS.unknown
      : validation?.status || VALIDATION_STATUS.invalid;

  if (explanation.verification_status !== actualStatus) {
    contradictions.push(
      `verification_status_mismatch:explanation=${explanation.verification_status},actual=${actualStatus}`
    );
  }

  // Verify every claimed verified_fact against extracted fields and source provenance.
  const fields = extracted?.fields || {};
  const provenance = extracted?.provenance || {};
  const fallbackRef = provenance?.json_root?.ref || null;

  for (const fact of explanation.verified_facts || []) {
    const fieldName = fact.field;
    const actualVal = fields[fieldName];
    const provRef = provenance[fieldName]?.ref || fallbackRef;

    if (actualVal === undefined || actualVal === null || actualVal === '') {
      ungrounded_claims.push(`fact_field_missing_in_extraction:${fieldName}`);
      continue;
    }
    if (fact.value !== actualVal) {
      contradictions.push(`fact_value_mismatch:${fieldName}:claimed=${fact.value},actual=${actualVal}`);
    }
    if (!provRef || fact.source_ref !== provRef) {
      ungrounded_claims.push(`fact_source_ref_unverified:${fieldName}:claimed=${fact.source_ref},actual=${provRef || 'none'}`);
    }
  }

  // Detect persuasive text in simple_summary that contradicts non-valid or unknown status.
  const summaryText = String(explanation.simple_summary || '');
  const claimsValidOrApproved =
    /(?:الفاتورة\s+صحيحة\s+ومكتملة|المجموع\s+يطابق\s+الإجمالي|تم\s+اعتماد\s+الفاتورة\s+بنجاح|العملية\s+مكتملة\s+وصحيحة\s+تمامًا|invoice\s+is\s+valid\s+and\s+approved)/i.test(
      summaryText
    );
  if (actualStatus !== EXPLANATION_VERIFICATION_STATUS.valid && claimsValidOrApproved) {
    contradictions.push('persuasive_summary_contradicts_non_valid_status');
  }

  if (
    actualStatus === EXPLANATION_VERIFICATION_STATUS.unknown &&
    (!Array.isArray(explanation.unknowns) || explanation.unknowns.length === 0)
  ) {
    contradictions.push('unknown_execution_state_omitted_from_unknowns');
  }

  // Check next_permitted_action discipline: non-valid runs can NEVER permit commit/approval for commit.
  if (
    actualStatus !== EXPLANATION_VERIFICATION_STATUS.valid &&
    explanation.next_permitted_action === NEXT_PERMITTED_ACTION.awaitOwnerApproval
  ) {
    contradictions.push('invalid_or_review_document_cannot_advance_to_commit_approval');
  }

  if (
    action?.status === ACTION_STATUS.notCommitted &&
    /(?:أُدرجت\s+في\s+سجل\s+المشتريات\s+فعليًا|تم\s+الحفظ\s+النهائي\s+في\s+سجل\s+المشتريات)/i.test(summaryText)
  ) {
    contradictions.push('summary_claims_committed_when_action_is_not_committed');
  }

  const gateStatus =
    contradictions.length > 0 || ungrounded_claims.length > 0
      ? COMPREHENSION_GATE_STATUS.block
      : actualStatus === EXPLANATION_VERIFICATION_STATUS.unknown
        ? COMPREHENSION_GATE_STATUS.unknown
        : COMPREHENSION_GATE_STATUS.pass;

  return {
    status: gateStatus,
    contradictions,
    ungrounded_claims
  };
}

/**
 * Build the complete Phase 3 Comprehension Gate explanation object (`explanation`)
 * grounded in the extraction provenance, deterministic validation, and run policy.
 */
export function buildComprehensionExplanation({
  goal = '',
  docPath = null,
  commitRequested = false,
  extracted = null,
  validation = null,
  actionStatus = ACTION_STATUS.notCommitted,
  executionState = null,
  evidenceRefs = []
} = {}) {
  const docLabel = docPath || extracted?.source?.source_id || 'المستند';
  const fieldExp = extracted?.field_explanations || explainExtractedFields(extracted || {});
  const valExp = explainValidationOutcome({ extracted, validation, executionState });

  const goal_plain = commitRequested
    ? `نريد قراءة الفاتورة (${docLabel}) واستخراج أرقامها والتحقق من صحتها، ثم عرضها على المالك للموافقة قبل إضافتها إلى سجل المشتريات.`
    : `نريد قراءة الفاتورة (${docLabel}) واستخراج بياناتها والتحقق حسابيًا من صحتها، ثم تقديم تقرير موثق بالأدلة دون أي كتابة خارجية.`;

  const success_criteria = [
    'قراءة المستند وحساب بصمة SHA-256 ومواضع الحقول',
    'استخراج الحقول وفق المخطط (1.0) وربط كل حقل بموضعه',
    'تطابق المجموع والضريبة مع الإجمالي وعدم التكرار أو الحقن',
    'لا كتابة في سجل المشتريات إلا لفاتورة صالحة وبعد موافقة المالك'
  ];

  const plan_steps = [
    {
      step: 1,
      tool: 'document.read',
      why_plain: 'فتح الملف المحلي وحساب بصمة SHA-256 وتحديد موضع كل سطر أو عمود.'
    },
    {
      step: 2,
      tool: 'document.extract',
      why_plain: 'استخراج رقم الفاتورة والمورد والتاريخ والمبالغ وربطها بمواضعها.'
    },
    {
      step: 3,
      tool: 'data.validate',
      why_plain: 'مراجعة الحسابات والتواريخ والتكرارات وفحص خلو النص من حقن الأوامر.'
    },
    {
      step: 4,
      tool: 'data.report',
      why_plain: 'إعداد تقرير مبسّط يوضح ما ثبت بالدليل وما يحتاج إلى مراجعة أو تصحيح.'
    }
  ];

  if (commitRequested) {
    plan_steps.push({
      step: 5,
      tool: 'document.commit_purchase_ledger',
      why_plain: 'طلب موافقة المالك أولًا ثم إدراج الفاتورة الصالحة مرة واحدة في سجل المشتريات.'
    });
  }

  const verified_facts = fieldExp.verified_facts;

  const assumptions = [
    ...fieldExp.assumptions.map((item) => item.plain_statement || String(item)),
    'نفترض أن الملف المحلي يمثل النسخة المقدمة للفحص حتى يراجعه المالك.'
  ];

  const unknowns = [
    ...fieldExp.unknown_fields.map((item) => item.plain_statement || String(item))
  ];
  if (executionState === 'unknown') {
    unknowns.push(
      'حالة التنفيذ غير محسومة (unknown) بسبب انقطاع العملية قبل اكتمالها؛ تلزم المصالحة البشرية.'
    );
  }

  const risks_and_side_effects = [
    'يُعامل محتوى المستند كبيانات غير موثوقة ولا يُنفَّذ أبدًا كأوامر.',
    'لا كتابة خارجية قبل موافقة المالك (WAITING_FOR_APPROVAL).'
  ];
  if (extracted?.security?.promptInjectionDetected) {
    risks_and_side_effects.push(
      'تحذير أمني: عُزلت نصوص تحاول تجاوز السياسات كمحتوى غير موثوق.'
    );
  }

  let next_permitted_action = NEXT_PERMITTED_ACTION.reportOnlyNoCommit;
  if (executionState === 'unknown') {
    next_permitted_action = NEXT_PERMITTED_ACTION.reconcileUnknownOutcome;
  } else if (valExp.status === EXPLANATION_VERIFICATION_STATUS.invalid) {
    next_permitted_action = NEXT_PERMITTED_ACTION.fixSourceDocument;
  } else if (valExp.status === EXPLANATION_VERIFICATION_STATUS.reviewRequired) {
    next_permitted_action = NEXT_PERMITTED_ACTION.requestHumanReview;
  } else if (valExp.status === EXPLANATION_VERIFICATION_STATUS.valid && commitRequested) {
    next_permitted_action = NEXT_PERMITTED_ACTION.awaitOwnerApproval;
  }

  const draftExplanation = {
    goal_plain,
    success_criteria,
    plan_steps,
    verified_facts,
    evidence_refs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    source_sha256: extracted?.source?.file_sha256 || null,
    assumptions,
    unknowns,
    risks_and_side_effects,
    simple_summary: valExp.simple_summary,
    verification_status: valExp.status,
    next_permitted_action,
    comprehension_gate: {
      status: COMPREHENSION_GATE_STATUS.pass,
      contradictions: [],
      ungrounded_claims: []
    }
  };

  const gateEval = evaluateComprehensionGate({
    explanation: draftExplanation,
    extracted,
    validation,
    action: { status: actionStatus },
    executionState
  });

  draftExplanation.comprehension_gate = gateEval;
  return draftExplanation;
}

/**
 * Execute `data.report`: build the canonical `schema_version: "1.0"` automation
 * report. Extraction and reporting NEVER auto-commit an external write: `action.status`
 * begins as `not_committed`.
 */
export function buildAutomationReport({
  taskId = 'task-unknown',
  goal = '',
  docPath = null,
  commitRequested = false,
  extracted,
  validation,
  actionStatus = ACTION_STATUS.notCommitted,
  committedRef = null,
  executionState = null,
  evidenceRefs = [],
  explanationOverride = null
} = {}) {
  const safeActionStatus =
    validation?.status === VALIDATION_STATUS.valid && Object.values(ACTION_STATUS).includes(actionStatus)
      ? actionStatus
      : ACTION_STATUS.notCommitted;

  let explanation;
  if (explanationOverride && typeof explanationOverride === 'object') {
    const gateEval = evaluateComprehensionGate({
      explanation: explanationOverride,
      extracted,
      validation,
      action: { status: safeActionStatus },
      executionState
    });
    explanation = {
      ...explanationOverride,
      comprehension_gate: gateEval
    };
  } else {
    explanation = buildComprehensionExplanation({
      goal,
      docPath,
      commitRequested,
      extracted,
      validation,
      actionStatus: safeActionStatus,
      executionState,
      evidenceRefs
    });
  }

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
    },
    explanation
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
