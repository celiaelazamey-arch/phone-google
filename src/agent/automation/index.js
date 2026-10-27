import { RISK } from '../tools.js';
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
  scanUntrustedDocumentContent,
  validateAutomationSchema,
  validateExplanationContract
} from './schema.js';
import { readLocalDocument, resolveSafeDocumentPath } from './reader.js';
import {
  extractStructuredDocument,
  explainExtractedFields,
  measureExtractionAccuracy
} from './extractor.js';
import {
  computeInvoiceFingerprint,
  validateExtractedData,
  explainValidationOutcome,
  evaluateComprehensionGate,
  buildComprehensionExplanation,
  buildAutomationReport
} from './validator.js';

export {
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  VALIDATION_STATUS,
  ACTION_STATUS,
  COMPREHENSION_GATE_STATUS,
  EXPLANATION_VERIFICATION_STATUS,
  NEXT_PERMITTED_ACTION,
  ALLOWED_CURRENCIES,
  scanUntrustedDocumentContent,
  validateAutomationSchema,
  validateExplanationContract,
  readLocalDocument,
  resolveSafeDocumentPath,
  extractStructuredDocument,
  explainExtractedFields,
  measureExtractionAccuracy,
  computeInvoiceFingerprint,
  validateExtractedData,
  explainValidationOutcome,
  evaluateComprehensionGate,
  buildComprehensionExplanation,
  buildAutomationReport
};

/**
 * In-process purchase ledger store for local verification & independent read-back.
 * Deduplicates by `invoice_fingerprint` so a retried or re-submitted invoice can
 * never create a second ledger row.
 */
export function createPurchaseLedgerStore() {
  const records = new Map();
  return {
    get(fingerprint) {
      return records.get(fingerprint) || null;
    },
    has(fingerprint) {
      return records.has(fingerprint);
    },
    list() {
      return [...records.values()];
    },
    fingerprints() {
      return [...records.keys()];
    },
    commit({ invoice_fingerprint, invoice_number, supplier_name, supplier_tax_id, issue_date, currency, subtotal, tax, total, file_sha256, idempotencyKey }) {
      if (!invoice_fingerprint || !invoice_number || !currency || typeof total !== 'number' || total <= 0) {
        throw Object.assign(new Error('Incomplete or invalid purchase ledger payload'), {
          status: 400,
          code: 'invalid_purchase_ledger_entry'
        });
      }
      if (records.has(invoice_fingerprint)) {
        const existing = records.get(invoice_fingerprint);
        return {
          externalRef: existing.id,
          deduplicated: true,
          record: existing
        };
      }
      const entry = Object.freeze({
        id: `pledger_${invoice_fingerprint.slice(0, 12)}`,
        invoice_fingerprint,
        invoice_number,
        supplier_name,
        supplier_tax_id: supplier_tax_id || null,
        issue_date,
        currency,
        subtotal: subtotal ?? total,
        tax: tax ?? 0,
        total,
        file_sha256: file_sha256 || null,
        idempotencyKey: idempotencyKey || null,
        committedAt: new Date().toISOString()
      });
      records.set(invoice_fingerprint, entry);
      return {
        externalRef: entry.id,
        deduplicated: false,
        record: entry
      };
    }
  };
}

/**
 * Explicit connector for `document.commit_purchase_ledger` routed through `agent_outbox`.
 * Like `google.calendar`, it is opt-in and only invoked after owner approval and
 * outbox single-dispatch claim.
 */
export function createPurchaseLedgerConnector({ ledgerStore = createPurchaseLedgerStore() } = {}) {
  return {
    name: 'purchases.ledger',
    toolName: 'document.commit_purchase_ledger',
    description: 'سجل المشتريات المحكوم — يكتب الفواتير الصالحة فقط بعد موافقة المالك وبمفتاح تفرد يمنع التكرار',
    ledgerStore,
    async send(payload, { idempotencyKey } = {}) {
      if (!payload || payload.validation_status !== VALIDATION_STATUS.valid) {
        throw Object.assign(
          new Error('Cannot commit a document whose validation status is not valid'),
          { status: 400, code: 'unvalidated_document_commit_refused' }
        );
      }
      const committed = ledgerStore.commit({
        ...payload,
        idempotencyKey
      });
      return {
        externalRef: committed.externalRef,
        deduplicated: committed.deduplicated,
        record: committed.record
      };
    }
  };
}

/**
 * Tool definitions for the `document_data_automation` Native Capability.
 */
export function documentAutomationToolDefinitions({
  allowedRoots,
  modelRouter = null,
  ledgerStore = null
} = {}) {
  return [
    {
      name: 'document.read',
      description: 'قراءة ملف مستند محلي معروف النوع (CSV/JSON/TXT) وحساب بصمة SHA-256 ومواضع الحقول',
      risk: RISK.read,
      deterministic: true,
      arguments: {
        path: 'string',
        content: 'string',
        format: 'string',
        sourceId: 'string'
      },
      replayArgs: ({ toolRun } = {}) => {
        let parsed = null;
        try {
          parsed = typeof toolRun?.outcome === 'string' ? JSON.parse(toolRun.outcome) : toolRun?.outcome;
        } catch {
          parsed = null;
        }
        if (parsed?.source?.path) {
          return {
            path: parsed.source.path,
            format: parsed.source.format,
            sourceId: parsed.source.source_id
          };
        }
        if (parsed?.rawText) {
          return {
            content: parsed.rawText,
            format: parsed.source?.format || 'txt',
            sourceId: parsed.source?.source_id || 'replay-doc'
          };
        }
        return {};
      },
      async execute(args) {
        return readLocalDocument(args, { ...(allowedRoots ? { allowedRoots } : {}) });
      }
    },
    {
      name: 'document.extract',
      description: 'استخراج حقول منظمة من المستند وفق مخطط معلوم الإصدار (schema 1.0) مع مرجع المصدر لكل حقل',
      risk: RISK.read,
      deterministic: !modelRouter,
      arguments: {
        document: 'object',
        documentType: 'string',
        mode: 'string',
        allowModelFallback: 'boolean'
      },
      replayArgs: ({ toolRun, context } = {}) => {
        const priorRead = [...(context?.toolRuns || [])]
          .reverse()
          .find((item) => item.toolName === 'document.read' && item.status === 'succeeded');
        let document = null;
        let parsed = null;
        try {
          document = typeof priorRead?.outcome === 'string' ? JSON.parse(priorRead.outcome) : priorRead?.outcome;
          parsed = typeof toolRun?.outcome === 'string' ? JSON.parse(toolRun.outcome) : toolRun?.outcome;
        } catch {
          document = null;
        }
        return {
          document,
          documentType: parsed?.document_type || 'invoice'
        };
      },
      async execute(args) {
        return extractStructuredDocument(args, { modelRouter });
      }
    },
    {
      name: 'data.validate',
      description: 'فحص حتمي للقيم والتواريخ والعملات ومطابقة الإجماليات والتكرارات ومحاولة حقن التعليمات',
      risk: RISK.read,
      deterministic: true,
      arguments: {
        extracted: 'object',
        seenFingerprints: 'object',
        seenFileHashes: 'object',
        requireSupplierTaxId: 'boolean'
      },
      replayArgs: ({ context } = {}) => {
        const priorExtract = [...(context?.toolRuns || [])]
          .reverse()
          .find((item) => item.toolName === 'document.extract' && item.status === 'succeeded');
        let extracted = null;
        try {
          extracted = typeof priorExtract?.outcome === 'string' ? JSON.parse(priorExtract.outcome) : priorExtract?.outcome;
        } catch {
          extracted = null;
        }
        return {
          extracted,
          seenFingerprints: [],
          seenFileHashes: []
        };
      },
      async execute(args, { context } = {}) {
        const currentRunCommitKeys = new Set(
          (context?.toolRuns || [])
            .filter((tr) => tr.toolName === 'document.commit_purchase_ledger' && tr.idempotencyKey)
            .map((tr) => tr.idempotencyKey)
        );
        const ledgerFingerprints = ledgerStore
          ? ledgerStore
              .list()
              .filter((entry) => !entry.idempotencyKey || !currentRunCommitKeys.has(entry.idempotencyKey))
              .map((entry) => entry.invoice_fingerprint)
          : [];
        const combinedFingerprints = [
          ...(Array.isArray(args?.seenFingerprints) ? args.seenFingerprints : []),
          ...ledgerFingerprints
        ];
        return validateExtractedData({
          ...args,
          seenFingerprints: combinedFingerprints
        });
      }
    },
    {
      name: 'data.report',
      description: 'إنشاء تقرير موحد بالنتائج والأخطاء والشرح المبسّط المدعوم بالأدلة (schema 1.0) دون تنفيذ كتابة خارجية',
      risk: RISK.internalWrite,
      arguments: {
        taskId: 'string',
        goal: 'string',
        docPath: 'string',
        commitRequested: 'boolean',
        extracted: 'object',
        validation: 'object',
        actionStatus: 'string',
        executionState: 'string',
        evidenceRefs: 'object',
        explanationOverride: 'object'
      },
      async execute(args, { run, context } = {}) {
        const priorToolRunIds = (context?.toolRuns || [])
          .filter((tr) => tr.status === 'succeeded' && tr.id)
          .map((tr) => tr.id);
        return buildAutomationReport({
          taskId: args?.taskId || run?.id || 'task-local',
          goal: args?.goal || run?.goal || '',
          docPath: args?.docPath || null,
          commitRequested: Boolean(args?.commitRequested),
          extracted: args?.extracted,
          validation: args?.validation,
          actionStatus: args?.actionStatus || ACTION_STATUS.notCommitted,
          executionState: args?.executionState || null,
          evidenceRefs: Array.isArray(args?.evidenceRefs) ? args.evidenceRefs : priorToolRunIds,
          explanationOverride: args?.explanationOverride || null
        });
      }
    },
    {
      name: 'document.commit_purchase_ledger',
      description: 'إدراج فاتورة متحققة (valid) في سجل المشتريات — أثر محكوم يمر عبر بوابة الموافقة وoutbox مرة واحدة',
      risk: RISK.externalEffect,
      requiresApproval: true,
      connector: 'purchases.ledger',
      arguments: {
        invoice_fingerprint: 'string',
        invoice_number: 'string',
        supplier_name: 'string',
        supplier_tax_id: 'string',
        issue_date: 'string',
        currency: 'string',
        subtotal: 'number',
        tax: 'number',
        total: 'number',
        file_sha256: 'string',
        validation_status: 'string'
      },
      validate(args) {
        if (!args || args.validation_status !== VALIDATION_STATUS.valid) {
          return {
            ok: false,
            code: 'policy_violation_unvalidated_document',
            message: 'Cannot request approval or commit a document unless validation.status is valid'
          };
        }
        if (!args.invoice_fingerprint || !args.invoice_number || !args.supplier_name || typeof args.total !== 'number' || args.total <= 0) {
          return {
            ok: false,
            code: 'policy_violation_incomplete_invoice',
            message: 'Invoice commit requires invoice_fingerprint, invoice_number, supplier_name, and positive total'
          };
        }
        return { ok: true };
      }
    }
  ];
}
