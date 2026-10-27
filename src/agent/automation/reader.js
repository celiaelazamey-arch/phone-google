import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from '../../knowledge/csv.js';
import {
  DOCUMENT_CAPABILITY,
  DOCUMENT_SCHEMA_VERSION,
  MAX_DOCUMENT_CHARS,
  SUPPORTED_FORMATS,
  isSha256,
  sha256Text
} from './schema.js';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeFormat(format, filePath, text) {
  if (format !== undefined && format !== null && String(format).trim()) {
    const selected = String(format).trim().toLowerCase().replace(/^\./, '');
    const mapped = selected === 'txt' ? 'txt' : selected === 'md' ? 'markdown' : selected;
    if (!SUPPORTED_FORMATS.includes(mapped)) throw codedError('document_format_unsupported');
    return mapped;
  }
  const extension = path.extname(filePath || '').toLowerCase();
  if (extension === '.csv') return 'csv';
  if (extension === '.json') return 'json';
  if (extension === '.txt') return 'txt';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) return 'json';
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || '';
  if (firstLine.includes(',') && trimmed.includes('\n')) return 'csv';
  return 'txt';
}

function sourceLabel(value, fallback) {
  const clean = String(value || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
  return clean || fallback;
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function assertSafeFileName(filePath) {
  const name = path.basename(filePath);
  if (name.startsWith('.') || /^(?:credentials?|token|secrets?|id_rsa|authorized_keys)(?:\.|$)/i.test(name)) {
    throw codedError('document_sensitive_filename_denied');
  }
}

async function readFromRoot(requestedPath, rootDir) {
  if (!rootDir || typeof rootDir !== 'string') throw codedError('document_path_disabled');
  if (path.isAbsolute(requestedPath) || requestedPath.includes('\0')) throw codedError('document_path_outside_root');
  const normalized = requestedPath.replace(/\\/g, path.sep);
  const configuredRoot = await fs.realpath(path.resolve(rootDir));
  const candidate = path.resolve(configuredRoot, normalized);
  if (!withinRoot(configuredRoot, candidate)) throw codedError('document_path_outside_root');
  assertSafeFileName(candidate);
  const realCandidate = await fs.realpath(candidate);
  if (!withinRoot(configuredRoot, realCandidate)) throw codedError('document_path_outside_root');
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) throw codedError('document_not_file');
  if (stat.size > 8192) throw codedError('document_too_large');
  const text = await fs.readFile(realCandidate, 'utf8');
  if (text.length > MAX_DOCUMENT_CHARS) throw codedError('document_too_large');
  return { text, sourceId: path.relative(configuredRoot, realCandidate).split(path.sep).join('/') };
}

/**
 * Read one small document as untrusted text. PDF/image/OCR are intentionally not
 * accepted in v1; callers must not infer that a scanned page was successfully read.
 */
export async function readDocument({ content, path: requestedPath, format, sourceId, rootDir } = {}) {
  const hasContent = typeof content === 'string';
  const hasPath = typeof requestedPath === 'string' && requestedPath.trim().length > 0;
  if (hasContent === hasPath) throw codedError('document_input_ambiguous_or_missing');

  let text;
  let resolvedSourceId;
  if (hasContent) {
    text = content;
    resolvedSourceId = sourceLabel(sourceId, 'inline-document');
  } else {
    const result = await readFromRoot(requestedPath, rootDir);
    text = result.text;
    resolvedSourceId = result.sourceId;
  }
  if (!text.trim()) throw codedError('document_empty');
  if (text.includes('\0')) throw codedError('document_binary_content_denied');
  if (text.length > MAX_DOCUMENT_CHARS) throw codedError('document_too_large');

  const resolvedFormat = normalizeFormat(format, hasPath ? requestedPath : '', text);
  if (resolvedFormat === 'csv') parseCsv(text, { maxRows: 100 });
  if (resolvedFormat === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw codedError('document_json_invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw codedError('document_json_root_invalid');
  }

  const hash = sha256Text(text);
  if (!isSha256(hash)) throw codedError('document_hash_failed');
  return {
    capability: DOCUMENT_CAPABILITY,
    schema_version: DOCUMENT_SCHEMA_VERSION,
    source: {
      source_id: resolvedSourceId,
      file_sha256: hash,
      format: resolvedFormat,
      untrusted_content: true
    },
    raw_text: text
  };
}
