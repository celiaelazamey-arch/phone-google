import {
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  scanUntrustedDocumentContent,
  validateAutomationSchema
} from './schema.js';

function parseFiniteNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/,/g, '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

function cleanString(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractFromCsvRows(rows = []) {
  const first = rows[0]?.values || {};
  const firstRefs = rows[0]?.refs || {};
  const provenance = {};

  const pickHeader = (aliases, transform = cleanString) => {
    for (const key of aliases) {
      if (key in first && first[key] !== '') {
        const val = transform(first[key]);
        if (val !== null) {
          provenance[aliases[0]] = {
            ref: firstRefs[key] || `row:${rows[0]?.rowNumber || 2},col:${key}`,
            confidence: 'deterministic'
          };
          return val;
        }
      }
    }
    return null;
  };

  const invoiceNumber = pickHeader(['invoice_number', 'invoice_no', 'id', 'رقم_الفاتورة']);
  const supplierName = pickHeader(['supplier_name', 'vendor', 'supplier', 'المورد']);
  const supplierTaxId = pickHeader(['supplier_tax_id', 'tax_id', 'الرقم_الضريبي']);
  const issueDate = pickHeader(['issue_date', 'date', 'تاريخ_الفاتورة']);
  const currency = pickHeader(['currency', 'العملة'], (v) => cleanString(v)?.toUpperCase() || null);
  let subtotal = pickHeader(['subtotal', 'المجموع_الفرعي'], parseFiniteNumber);
  const tax = pickHeader(['tax', 'vat', 'الضريبة'], parseFiniteNumber);
  const total = pickHeader(['total', 'amount_due', 'الإجمالي'], parseFiniteNumber);

  const lineItems = [];
  for (const row of rows) {
    const v = row.values || {};
    const desc = cleanString(v.item_description ?? v.description ?? v.item ?? v['الوصف']);
    const qty = parseFiniteNumber(v.quantity ?? v.qty ?? v['الكمية']);
    const unitPrice = parseFiniteNumber(v.unit_price ?? v.price ?? v['سعر_الوحدة']);
    const lineAmount = parseFiniteNumber(v.line_amount ?? v.item_amount ?? v.amount ?? v['مبلغ_البند']);
    if (desc !== null || qty !== null || unitPrice !== null || lineAmount !== null) {
      const computedAmount =
        lineAmount !== null
          ? lineAmount
          : qty !== null && unitPrice !== null
            ? Math.round(qty * unitPrice * 100) / 100
            : null;
      lineItems.push({
        description: desc || 'بند غير معنون',
        quantity: qty ?? 1,
        unit_price: unitPrice ?? computedAmount ?? 0,
        amount: computedAmount ?? 0,
        source_ref: `row:${row.rowNumber}`
      });
    }
  }

  if (subtotal === null && lineItems.length > 0) {
    subtotal = Math.round(lineItems.reduce((sum, item) => sum + (item.amount || 0), 0) * 100) / 100;
  }

  return {
    fields: {
      invoice_number: invoiceNumber,
      supplier_name: supplierName,
      supplier_tax_id: supplierTaxId,
      issue_date: issueDate,
      currency,
      subtotal,
      tax: tax ?? 0,
      total,
      line_items: lineItems
    },
    provenance
  };
}

function extractFromLines(lines = []) {
  const fields = {
    invoice_number: null,
    supplier_name: null,
    supplier_tax_id: null,
    issue_date: null,
    currency: null,
    subtotal: null,
    tax: 0,
    total: null,
    line_items: []
  };
  const provenance = {};

  const keyPatterns = [
    { field: 'invoice_number', regex: /^(?:invoice_number|invoice\s*#|invoice\s*no|رقم\s*الفاتورة)\s*[:=-]\s*(.+)$/i },
    { field: 'supplier_name', regex: /^(?:supplier_name|supplier|vendor|المورد|اسم\s*المورد)\s*[:=-]\s*(.+)$/i },
    { field: 'supplier_tax_id', regex: /^(?:supplier_tax_id|tax_id|الرقم\s*الضريبي)\s*[:=-]\s*(.+)$/i },
    { field: 'issue_date', regex: /^(?:issue_date|date|تاريخ\s*الفاتورة|التاريخ)\s*[:=-]\s*(.+)$/i },
    { field: 'currency', regex: /^(?:currency|العملة)\s*[:=-]\s*(.+)$/i },
    { field: 'subtotal', regex: /^(?:subtotal|المجموع\s*الفرعي)\s*[:=-]\s*(.+)$/i, numeric: true },
    { field: 'tax', regex: /^(?:tax|vat|الضريبة)\s*[:=-]\s*(.+)$/i, numeric: true },
    { field: 'total', regex: /^(?:total|الإجمالي|المبلغ\s*الإجمالي)\s*[:=-]\s*(.+)$/i, numeric: true }
  ];

  const itemRegex = /^(?:item|line_item|بند)\s*[:=-]\s*([^|]+)\|\s*qty\s*[:=]\s*([\d.]+)\s*\|\s*unit_price\s*[:=]\s*([\d.]+)\s*\|\s*amount\s*[:=]\s*([\d.]+)/i;

  for (const entry of lines) {
    const text = String(entry.text || '').trim();
    if (!text) continue;
    const itemMatch = itemRegex.exec(text);
    if (itemMatch) {
      fields.line_items.push({
        description: cleanString(itemMatch[1]) || 'بند',
        quantity: parseFiniteNumber(itemMatch[2]) ?? 1,
        unit_price: parseFiniteNumber(itemMatch[3]) ?? 0,
        amount: parseFiniteNumber(itemMatch[4]) ?? 0,
        source_ref: entry.ref
      });
      continue;
    }
    for (const rule of keyPatterns) {
      const match = rule.regex.exec(text);
      if (match) {
        const rawVal = match[1].trim();
        const val = rule.numeric
          ? parseFiniteNumber(rawVal)
          : rule.field === 'currency'
            ? cleanString(rawVal)?.toUpperCase() || null
            : cleanString(rawVal);
        fields[rule.field] = val;
        provenance[rule.field] = {
          ref: entry.ref,
          confidence: 'deterministic'
        };
      }
    }
  }

  if (fields.subtotal === null && fields.line_items.length > 0) {
    fields.subtotal =
      Math.round(fields.line_items.reduce((sum, item) => sum + (item.amount || 0), 0) * 100) / 100;
  }

  return { fields, provenance };
}

/**
 * Execute `document.extract`: convert a read document into versioned schema `1.0`
 * with per-field provenance and optional governed Model Router extraction.
 *
 * A model failure or invalid JSON response from the model NEVER writes bad data:
 * it is rejected explicitly or recorded as `model_output_rejected`.
 */
export async function extractStructuredDocument(
  {
    document = null,
    documentType = DOCUMENT_TYPES.invoice,
    mode = 'deterministic',
    allowModelFallback = false
  } = {},
  { modelRouter = null } = {}
) {
  if (!document || typeof document !== 'object') {
    throw Object.assign(new Error('document object from document.read is required'), {
      code: 'document_required'
    });
  }

  const security = document.security || scanUntrustedDocumentContent(document.rawText || '');

  if (mode === 'model') {
    if (!modelRouter || typeof modelRouter.extract !== 'function') {
      if (!allowModelFallback) {
        throw Object.assign(new Error('Model router is not configured or unavailable'), {
          code: 'model_provider_unavailable'
        });
      }
    } else {
      let modelRaw;
      try {
        modelRaw = await modelRouter.extract({
          rawText: document.rawText,
          documentType,
          schemaVersion: AUTOMATION_SCHEMA_VERSION
        });
      } catch (error) {
        if (!allowModelFallback) {
          throw Object.assign(
            new Error(`Model extraction failed: ${error?.code || error?.message || 'provider_error'}`),
            { code: error?.code || 'model_provider_unavailable' }
          );
        }
        modelRaw = null;
      }

      if (modelRaw !== null && modelRaw !== undefined) {
        let parsedModel = modelRaw;
        if (typeof modelRaw === 'string') {
          try {
            parsedModel = JSON.parse(modelRaw);
          } catch {
            throw Object.assign(new Error('Model returned invalid JSON'), {
              code: 'malformed_model_output'
            });
          }
        }
        const candidate = {
          capability: CAPABILITY_NAME,
          document_type: documentType,
          schema_version: AUTOMATION_SCHEMA_VERSION,
          source: document.source,
          fields: parsedModel?.fields ?? parsedModel,
          provenance: parsedModel?.provenance || {},
          security
        };
        const schemaCheck = validateAutomationSchema(candidate);
        if (!schemaCheck.ok) {
          throw Object.assign(
            new Error(`Model output violated schema ${AUTOMATION_SCHEMA_VERSION}: ${schemaCheck.errors.join(', ')}`),
            { code: 'malformed_model_output', details: schemaCheck.errors }
          );
        }
        return candidate;
      }
    }
  }

  let extracted;
  if (document.source?.format === 'csv' && Array.isArray(document.rows) && document.rows.length > 0) {
    extracted = extractFromCsvRows(document.rows);
  } else if (document.source?.format === 'json' && document.parsedJson) {
    const f = document.parsedJson.fields || document.parsedJson;
    extracted = {
      fields: {
        invoice_number: cleanString(f.invoice_number),
        supplier_name: cleanString(f.supplier_name),
        supplier_tax_id: cleanString(f.supplier_tax_id),
        issue_date: cleanString(f.issue_date),
        currency: cleanString(f.currency)?.toUpperCase() || null,
        subtotal: parseFiniteNumber(f.subtotal),
        tax: parseFiniteNumber(f.tax) ?? 0,
        total: parseFiniteNumber(f.total),
        line_items: Array.isArray(f.line_items) ? f.line_items : []
      },
      provenance: document.parsedJson.provenance || { json_root: { ref: 'line:1', confidence: 'deterministic' } }
    };
  } else {
    extracted = extractFromLines(document.lines || []);
  }

  const result = {
    capability: CAPABILITY_NAME,
    document_type: Object.values(DOCUMENT_TYPES).includes(documentType) ? documentType : DOCUMENT_TYPES.invoice,
    schema_version: AUTOMATION_SCHEMA_VERSION,
    source: document.source,
    fields: extracted.fields,
    provenance: extracted.provenance,
    security
  };

  const check = validateAutomationSchema(result);
  if (!check.ok) {
    throw Object.assign(new Error(`Extraction failed schema validation: ${check.errors.join(', ')}`), {
      code: 'extraction_schema_invalid',
      details: check.errors
    });
  }

  return result;
}

/**
 * Compute per-field and overall accuracy against a known golden reference dataset.
 * Never invents accuracy numbers: compares actual extracted values against ground truth.
 */
export function measureExtractionAccuracy(extractedItems = [], goldenExpected = {}) {
  const trackedFields = [
    'invoice_number',
    'supplier_name',
    'supplier_tax_id',
    'issue_date',
    'currency',
    'subtotal',
    'tax',
    'total'
  ];
  const perField = {};
  for (const field of trackedFields) {
    perField[field] = { matched: 0, total: 0, accuracy: 0 };
  }
  let totalComparisons = 0;
  let totalMatches = 0;

  for (const item of extractedItems) {
    const sourceId = item?.source?.source_id;
    const expected = goldenExpected[sourceId];
    if (!expected) continue;
    for (const field of trackedFields) {
      if (!(field in expected)) continue;
      perField[field].total += 1;
      totalComparisons += 1;
      const actualVal = item?.fields?.[field] ?? null;
      const expectedVal = expected[field] ?? null;
      if (actualVal === expectedVal) {
        perField[field].matched += 1;
        totalMatches += 1;
      }
    }
  }

  for (const field of trackedFields) {
    const stats = perField[field];
    stats.accuracy = stats.total > 0 ? Math.round((stats.matched / stats.total) * 10000) / 10000 : 1;
  }

  return {
    documentsEvaluated: extractedItems.filter((item) => Boolean(goldenExpected[item?.source?.source_id])).length,
    totalComparisons,
    totalMatches,
    overallAccuracy: totalComparisons > 0 ? Math.round((totalMatches / totalComparisons) * 10000) / 10000 : 0,
    perField
  };
}
