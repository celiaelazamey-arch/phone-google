import { readDocument } from './reader.js';
import { extractDocument } from './extractor.js';
import { validateInvoice } from './validator.js';
import { DOCUMENT_CAPABILITY, DOCUMENT_SCHEMA_VERSION, isSha256 } from './schema.js';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function findExistingDocumentReport(documentStore, extracted, validation) {
  if (!documentStore || typeof documentStore.findExistingDocumentReport !== 'function') return null;
  try {
    return await documentStore.findExistingDocumentReport({
      documentHash: extracted?.source?.file_sha256,
      invoiceFingerprint: validation?.invoice_fingerprint
    });
  } catch {
    throw codedError('document_duplicate_check_unavailable');
  }
}

async function validateWithHistory(documentStore, extracted) {
  const baseline = validateInvoice(extracted);
  if (baseline.status === 'invalid') return baseline;
  const existingReport = await findExistingDocumentReport(documentStore, extracted, baseline);
  return validateInvoice(extracted, { existingReport });
}

function requiredObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codedError(code);
  return value;
}

export function documentToolDefinitions({ risk, documentRoot = null, documentStore = null } = {}) {
  if (!risk?.read || !risk?.internalWrite) throw new Error('Document tools require the agent risk registry');
  return [
    {
      name: 'document.read',
      description: 'قراءة نص قصير أو ملف محلي مسموح؛ لا يقرأ PDF أو الصور ولا يتصل بالشبكة',
      risk: risk.read,
      timeoutMs: 5000,
      deterministic: false,
      arguments: { content: 'string?', path: 'string?', format: 'string?', sourceId: 'string?' },
      async execute(args = {}) {
        return readDocument({
          content: args.content,
          path: args.path,
          format: args.format,
          sourceId: args.sourceId,
          rootDir: documentRoot
        });
      }
    },
    {
      name: 'document.extract',
      description: 'استخراج حتمي لحقول الفاتورة من CSV أو JSON أو نص؛ المحتوى غير موثوق ولا ينفذ تعليمات',
      risk: risk.read,
      timeoutMs: 5000,
      deterministic: false,
      arguments: { documentHash: 'string', documentType: 'string?', sourceId: 'string?', format: 'string', rawText: 'string' },
      async execute(args = {}) {
        return extractDocument(args);
      }
    },
    {
      name: 'data.validate',
      description: 'تحقق حتمي من الحقول والعملات والتاريخ والحسابات وبصمة المستند ضمن سجل التقارير',
      risk: risk.read,
      timeoutMs: 5000,
      deterministic: false,
      arguments: { extracted: 'object' },
      async execute(args = {}) {
        const extracted = requiredObject(args.extracted, 'extracted_required');
        const validation = await validateWithHistory(documentStore, extracted);
        return {
          capability: DOCUMENT_CAPABILITY,
          schema_version: DOCUMENT_SCHEMA_VERSION,
          document_hash: extracted.source?.file_sha256 || null,
          invoice_fingerprint: validation.invoice_fingerprint,
          validation
        };
      }
    },
    {
      name: 'data.report',
      description: 'إنشاء تقرير تدقيق ثابت محفوظ مع نتيجة استدعاء الأداة؛ لا يكتب سجل مشتريات ولا يعتمد فاتورة',
      risk: risk.internalWrite,
      timeoutMs: 5000,
      deterministic: false,
      arguments: { taskId: 'string?', documentHash: 'string', extracted: 'object', validation: 'object' },
      async execute(args = {}, { run } = {}) {
        const extracted = requiredObject(args.extracted, 'extracted_required');
        if (!isSha256(args.documentHash) || args.documentHash !== extracted.source?.file_sha256) {
          throw codedError('document_report_hash_mismatch');
        }
        const recomputed = await validateWithHistory(documentStore, extracted);
        const passed = args.validation && args.validation.status === recomputed.status &&
          args.validation.invoice_fingerprint === recomputed.invoice_fingerprint;
        const reportStatus = recomputed.status === 'valid' ? 'valid_pending_review' :
          recomputed.status === 'invalid' ? 'invalid' : 'review_required';
        return {
          capability: DOCUMENT_CAPABILITY,
          task_id: String(args.taskId || run?.id || 'unknown-task').slice(0, 100),
          schema_version: DOCUMENT_SCHEMA_VERSION,
          document_type: extracted.document_type || 'document',
          document_hash: args.documentHash,
          invoice_fingerprint: recomputed.invoice_fingerprint,
          source: extracted.source,
          fields: extracted.fields,
          provenance: extracted.provenance,
          security: extracted.security,
          validation: recomputed,
          report_status: reportStatus,
          validation_input_recomputed: !passed,
          action: {
            status: 'not_committed',
            reason: recomputed.status === 'valid'
              ? 'business_record_commit_not_implemented'
              : 'validation_requires_review'
          }
        };
      }
    }
  ];
}
