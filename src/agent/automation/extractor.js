import { parseCsv } from '../../knowledge/csv.js';
import {
  DOCUMENT_CAPABILITY,
  DOCUMENT_SCHEMA_VERSION,
  MAX_LINE_ITEMS,
  isSha256,
  normalizeCurrency,
  normalizeIsoDate,
  parseNumericValue,
  sha256Text
} from './schema.js';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

const ALIASES = Object.freeze({
  invoice_number: ['invoice number', 'invoice no', 'invoice_number', 'invoice #', 'رقم الفاتورة', 'رقم فاتورة'],
  supplier_name: ['supplier name', 'supplier', 'vendor', 'اسم المورد', 'المورد', 'جهة التوريد'],
  issue_date: ['issue date', 'invoice date', 'date', 'تاريخ الفاتورة', 'التاريخ', 'تاريخ'],
  currency: ['currency', 'العملة', 'العمله'],
  subtotal: ['subtotal', 'sub total', 'الإجمالي الفرعي', 'الاجمالي الفرعي', 'المجموع قبل الضريبة'],
  tax: ['tax', 'vat', 'ضريبة', 'الضريبة', 'القيمة المضافة'],
  total: ['grand total', 'invoice total', 'total', 'الإجمالي النهائي', 'الإجمالي', 'الاجمالي', 'المبلغ الإجمالي'],
  description: ['item description', 'description', 'item name', 'product', 'item', 'وصف الصنف', 'اسم الصنف', 'الصنف', 'المنتج'],
  quantity: ['quantity', 'qty', 'الكمية'],
  unit_price: ['unit price', 'price per unit', 'سعر الوحدة', 'السعر'],
  amount: ['line total', 'item total', 'amount', 'القيمة', 'مبلغ البند', 'الإجمالي للبند']
});

const KEY_SETS = Object.fromEntries(
  Object.entries(ALIASES).map(([key, aliases]) => [key, new Set(aliases.map(normalizeKey))])
);

function pick(record, field) {
  if (!record || typeof record !== 'object') return { value: null, key: null };
  for (const [key, value] of Object.entries(record)) {
    if (KEY_SETS[field].has(normalizeKey(key)) && value !== undefined && value !== null && String(value).trim() !== '') {
      return { value, key };
    }
  }
  return { value: null, key: null };
}

function refFor(kind, row, key) {
  if (kind === 'csv') return 'row:' + row + ',col:' + String(key);
  if (kind === 'json') return 'json:' + String(key);
  return 'line:' + String(row);
}

function detectPromptInjection(text) {
  const patterns = [
    /\bignore (?:all )?(?:previous|prior|system) instructions\b/i,
    /\b(reveal|print|exfiltrate)\b.{0,50}\b(api key|secret|token|password|credential)s?\b/i,
    /\b(send|upload)\b.{0,50}\b(secret|token|credential|private key)s?\b/i,
    /تجاهل\s+(?:كل\s+)?(?:التعليمات|السياسات|القواعد)/i,
    /اكشف\s+(?:لي\s+)?(?:المفتاح|الرمز|السر)/i,
    /أرسل\s+.{0,50}(?:مفتاح|رمز|سر)/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function findTextField(lines, field) {
  const patterns = {
    invoice_number: /(?:رقم\s+(?:الفاتورة|فاتورة)|invoice\s*(?:number|no\.?|#))/i,
    supplier_name: /(?:اسم\s+المورد|جهة\s+التوريد|المورد|supplier|vendor)/i,
    issue_date: /(?:تاريخ\s+(?:الفاتورة|الإصدار)|التاريخ|issue\s*date|invoice\s*date|date)/i,
    currency: /(?:العملة|العمله|currency)/i,
    subtotal: /(?:الإجمالي\s+الفرعي|الاجمالي\s+الفرعي|المجموع\s+قبل\s+الضريبة|subtotal)/i,
    tax: /(?:الضريبة|ضريبة|القيمة\s+المضافة|tax|vat)/i,
    total: /(?:الإجمالي\s+النهائي|المبلغ\s+الإجمالي|الإجمالي|الاجمالي|grand\s+total|invoice\s+total|total)/i
  };
  const pattern = patterns[field];
  if (!pattern) return { value: null, key: null, line: null };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || !pattern.test(line)) continue;
    const separator = line.search(/[:：=]/);
    if (separator < 0) continue;
    const value = line.slice(separator + 1).trim();
    if (value) return { value, key: field, line: index + 1 };
  }
  return { value: null, key: null, line: null };
}

function normalizeField(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  if (field === 'invoice_number' || field === 'supplier_name') return String(value).trim().slice(0, 120);
  if (field === 'issue_date') return normalizeIsoDate(String(value).trim());
  if (field === 'currency') return normalizeCurrency(String(value));
  if (['subtotal', 'tax', 'total', 'quantity', 'unit_price', 'amount'].includes(field)) {
    return parseNumericValue(value);
  }
  return value;
}

function normalizedLineItem(record, kind, row, sourceWarnings) {
  const desc = pick(record, 'description');
  const qty = pick(record, 'quantity');
  const price = pick(record, 'unit_price');
  const amount = pick(record, 'amount');
  if (!desc.value && qty.value === null && price.value === null && amount.value === null) return null;
  if (!desc.value || qty.value === null || price.value === null || amount.value === null) {
    sourceWarnings.push('line_item_fields_incomplete');
  }
  return {
    description: desc.value === null ? null : String(desc.value).trim().slice(0, 100),
    quantity: normalizeField(qty.value, 'quantity'),
    unit_price: normalizeField(price.value, 'unit_price'),
    amount: normalizeField(amount.value, 'amount'),
    source_ref: refFor(kind, row, desc.key || qty.key || price.key || amount.key || 'line_item')
  };
}

export function extractDocument({ documentHash, documentType = 'document', sourceId = 'inline-document', format = 'txt', rawText } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) throw codedError('document_text_required');
  if (!isSha256(documentHash) || sha256Text(rawText) !== documentHash) throw codedError('document_hash_mismatch');
  const kind = String(format).toLowerCase();
  if (!['csv', 'json', 'txt', 'markdown'].includes(kind)) throw codedError('document_format_unsupported');

  let records = [];
  let parsedObject = null;
  let lines = rawText.split(/\r?\n/);
  if (kind === 'csv') {
    const parsed = parseCsv(rawText, { maxRows: 100 });
    records = parsed.records;
    if (!records.length) throw codedError('document_csv_has_no_records');
  } else if (kind === 'json') {
    try {
      parsedObject = JSON.parse(rawText);
    } catch {
      throw codedError('document_json_invalid');
    }
    if (!parsedObject || typeof parsedObject !== 'object' || Array.isArray(parsedObject)) throw codedError('document_json_root_invalid');
    const nested = parsedObject.invoice && typeof parsedObject.invoice === 'object' ? parsedObject.invoice : parsedObject;
    if (Array.isArray(nested.line_items)) {
      records = nested.line_items.map((item, index) => ({ line: index + 1, values: item }));
    }
    parsedObject = nested;
  }

  const firstRecord = kind === 'csv' ? records[0]?.values : parsedObject;
  const provenance = {};
  const warnings = [];
  const fields = {};

  for (const field of ['invoice_number', 'supplier_name', 'issue_date', 'currency', 'subtotal', 'tax', 'total']) {
    let found;
    if (firstRecord) {
      const selected = pick(firstRecord, field);
      found = { ...selected, line: kind === 'csv' ? records[0]?.line : null };
    } else {
      found = findTextField(lines, field);
    }
    fields[field] = normalizeField(found.value, field);
    if (found.value !== null && found.value !== undefined && String(found.value).trim()) {
      provenance[field] = {
        ref: refFor(kind === 'csv' ? 'csv' : kind === 'json' ? 'json' : 'text', found.line || 1, found.key || field),
        extraction: 'deterministic'
      };
      if (fields[field] === null && ['subtotal', 'tax', 'total'].includes(field)) warnings.push('numeric_field_unparsed:' + field);
    }
  }

  let items = [];
  if (kind === 'json' && Array.isArray(parsedObject.line_items)) {
    items = parsedObject.line_items.map((item, index) => normalizedLineItem(item, 'json', index + 1, warnings)).filter(Boolean);
  } else if (kind === 'csv') {
    items = records.map((record) => normalizedLineItem(record.values, 'csv', record.line, warnings)).filter(Boolean);
  } else {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      const parts = line.split(/\s*[|؛]\s*/);
      if (parts.length !== 4 || !parts[0]) continue;
      const possibleItem = {
        description: parts[0],
        quantity: parts[1],
        unit_price: parts[2],
        amount: parts[3]
      };
      items.push({
        description: String(possibleItem.description).slice(0, 100),
        quantity: parseNumericValue(possibleItem.quantity),
        unit_price: parseNumericValue(possibleItem.unit_price),
        amount: parseNumericValue(possibleItem.amount),
        source_ref: refFor('text', index + 1, 'line_item')
      });
    }
  }

  if (items.length > MAX_LINE_ITEMS) {
    items = items.slice(0, MAX_LINE_ITEMS);
    warnings.push('line_items_truncated');
  }
  fields.line_items = items;
  if (items.length) provenance.line_items = { ref: items.map((item) => item.source_ref).join(';'), extraction: 'deterministic' };

  const injection = detectPromptInjection(rawText);
  if (injection) warnings.push('prompt_injection_detected');

  return {
    capability: DOCUMENT_CAPABILITY,
    schema_version: DOCUMENT_SCHEMA_VERSION,
    document_type: String(documentType || 'document').slice(0, 40),
    source: {
      source_id: String(sourceId || 'inline-document').slice(0, 120),
      file_sha256: documentHash,
      format: kind,
      untrusted_content: true
    },
    fields,
    provenance,
    security: {
      prompt_injection_attempted: injection,
      sanitized_warnings: warnings.slice(0, 12)
    }
  };
}
