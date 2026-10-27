import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from '../../knowledge/csv.js';
import { scanUntrustedDocumentContent } from './schema.js';

const SUPPORTED_FORMATS = new Set(['csv', 'json', 'txt', 'md']);
const FORBIDDEN_FILENAMES = /(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|token\.json|id_rsa|.*\.pem|.*\.key)$/i;

const DEFAULT_ALLOWED_ROOTS = [
  path.resolve(process.cwd(), 'test/fixtures/documents'),
  path.resolve(process.cwd(), 'data/documents')
];

function sha256Hex(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function detectFormat(filePath = '', explicitFormat = '') {
  const norm = String(explicitFormat || '').trim().toLowerCase().replace(/^\./, '');
  if (norm && SUPPORTED_FORMATS.has(norm)) return norm === 'md' ? 'txt' : norm;
  const ext = path.extname(String(filePath || '')).toLowerCase().replace(/^\./, '');
  if (SUPPORTED_FORMATS.has(ext)) return ext === 'md' ? 'txt' : ext;
  return null;
}

export function resolveSafeDocumentPath(requestedPath, allowedRoots = DEFAULT_ALLOWED_ROOTS) {
  const raw = String(requestedPath || '').trim();
  if (!raw) {
    throw Object.assign(new Error('Document path is required'), { code: 'document_path_required' });
  }
  if (raw.includes('\0') || FORBIDDEN_FILENAMES.test(raw.replace(/\\/g, '/'))) {
    throw Object.assign(new Error('Access to sensitive or secret files is forbidden'), {
      code: 'document_path_forbidden'
    });
  }
  const roots = (allowedRoots && allowedRoots.length ? allowedRoots : DEFAULT_ALLOWED_ROOTS).map((r) =>
    path.resolve(r)
  );
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
  const insideAllowed = roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
  if (!insideAllowed) {
    // Also check if relative to the first allowed root (e.g. "invoice-valid-1042.csv")
    if (!path.isAbsolute(raw) && !raw.includes('..')) {
      for (const root of roots) {
        const joined = path.resolve(root, raw);
        if (joined.startsWith(root + path.sep)) {
          return joined;
        }
      }
    }
    throw Object.assign(new Error('Document path is outside allowed document directories'), {
      code: 'document_path_forbidden'
    });
  }
  return candidate;
}

/**
 * Execute `document.read`: read a local document of a known format, compute its
 * SHA-256 fingerprint, extract row/line coordinates for provenance, and mark all
 * content as untrusted data.
 */
export async function readLocalDocument(
  { path: filePath = null, content = null, format = null, sourceId = null } = {},
  { allowedRoots = DEFAULT_ALLOWED_ROOTS } = {}
) {
  let rawText;
  let resolvedSourceId;
  let detectedFormat;

  if (typeof content === 'string') {
    rawText = content;
    resolvedSourceId = String(sourceId || filePath || 'inline-document').trim();
    detectedFormat = detectFormat(resolvedSourceId, format || 'txt');
  } else if (filePath) {
    const safePath = resolveSafeDocumentPath(filePath, allowedRoots);
    detectedFormat = detectFormat(safePath, format);
    if (!detectedFormat) {
      throw Object.assign(new Error('Unsupported document format'), { code: 'unsupported_document_format' });
    }
    try {
      rawText = await readFile(safePath, 'utf8');
    } catch (error) {
      throw Object.assign(new Error(`Unable to read document: ${error?.code || 'read_failed'}`), {
        code: 'document_not_found'
      });
    }
    resolvedSourceId = sourceId || path.basename(safePath);
  } else {
    throw Object.assign(new Error('Either path or content is required for document.read'), {
      code: 'document_input_required'
    });
  }

  if (!detectedFormat) {
    throw Object.assign(new Error('Unsupported document format'), { code: 'unsupported_document_format' });
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    throw Object.assign(new Error('Document is empty or unreadable'), { code: 'document_empty' });
  }

  const fileSha256 = sha256Hex(rawText);
  const sizeBytes = Buffer.byteLength(rawText, 'utf8');
  const security = scanUntrustedDocumentContent(rawText);
  const lines = rawText.replace(/\r\n/g, '\n').split('\n').map((text, idx) => ({
    line: idx + 1,
    ref: `line:${idx + 1}`,
    text
  }));

  let rows = [];
  let headers = [];
  let parsedJson = null;

  if (detectedFormat === 'csv') {
    let parsed;
    try {
      parsed = parseCsv(rawText);
    } catch (error) {
      throw Object.assign(new Error(`Corrupted CSV document: ${error.message}`), {
        code: 'document_corrupted'
      });
    }
    headers = parsed.header || [];
    rows = (parsed.records || []).map((row) => {
      const cells = {};
      const refs = {};
      for (const header of headers) {
        cells[header] = row.values[header] ?? '';
        refs[header] = `row:${row.line},col:${header}`;
      }
      return {
        rowNumber: row.line,
        values: cells,
        refs
      };
    });
    if (!headers.length || !rows.length) {
      throw Object.assign(new Error('CSV document has no header or data rows'), {
        code: 'document_corrupted'
      });
    }
  } else if (detectedFormat === 'json') {
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw Object.assign(new Error('Invalid JSON document'), { code: 'document_corrupted' });
    }
  }

  return {
    capability: 'document_data_automation',
    source: {
      source_id: resolvedSourceId,
      file_sha256: fileSha256,
      format: detectedFormat,
      size_bytes: sizeBytes,
      untrusted_content: true
    },
    headers,
    rows,
    lines,
    parsedJson,
    rawText,
    security
  };
}
