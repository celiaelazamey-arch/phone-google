import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * تفعيل «الخيوط العنكبوتية» في حلقة الوكيل — قارئ فهرس Celia Google Spider.
 *
 * قراءة فقط وصفر شبكة: يفتح `knowledge.sqlite3` الذي يبنيه العنكبوت
 * (`celia-google-spider/`، مزامنة Drive عبر MCP/stdio خارج هذا المسار تمامًا)
 * بوضع read-only، ويعيد تنفيذ دلالات البحث المعجمي نفسها حرفيًا:
 * نفس تطبيع `text_utils.py` (NFKC، إزالة التشكيل، توحيد الألف/التاء المربوطة/
 * الألف المقصورة، الأرقام الهندية)، نفس ترتيب `store.search` (مصطلحات مطابقة ثم
 * تكرار ثم اسم)، نفس الدرجة `matched*10 + min(freq, 90)`، ونفس المقتطف (نصف قطر 90).
 *
 * فاشل-مغلقًا: غياب الفهرس خطأ مرمّز صريح (`spider_index_unavailable`) لا نتيجة
 * فارغة صامتة — الوكيل لا يدّعي أنه «بحث فلم يجد» وهو لم يفتح فهرسًا أصلًا.
 * هذا القارئ لا يزامن ولا يكتب ولا يفتح أي اتصال خارجي؛ المزامنة قرار المالك
 * عبر أدوات العنكبوت الست المستقلة.
 */

const TOKEN_RE = /[\u0600-\u06FF\u0750-\u077Fa-zA-Z0-9]+/g;
const DIACRITICS_RE = /[\u064B-\u0652\u0670\u065F\u0640]/g;
const CHAR_MAP = new Map(Object.entries({
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ؤ': 'و', 'ئ': 'ي',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
}));

function coded(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function normalizeToken(token) {
  let text = String(token).normalize('NFKC').replace(DIACRITICS_RE, '');
  let mapped = '';
  for (const ch of text) mapped += CHAR_MAP.get(ch) ?? ch;
  return mapped.toLowerCase();
}

function* iterTokensWithPositions(text) {
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(String(text))) !== null) {
    const normalized = normalizeToken(match[0]);
    if (normalized) yield { normalized, start: match.index, end: match.index + match[0].length };
  }
}

export function tokenize(text) {
  const tokens = [];
  for (const { normalized } of iterTokensWithPositions(text)) {
    if (normalized.length >= 2 || /^[0-9]+$/.test(normalized)) tokens.push(normalized);
  }
  return tokens;
}

export function makeSnippet(text, queryTerms, radius = 90) {
  const source = String(text || '');
  if (!source) return '';
  for (const { normalized, start } of iterTokensWithPositions(source)) {
    if (queryTerms.has(normalized)) {
      const begin = Math.max(0, start - radius);
      const end = Math.min(source.length, start + radius * 2);
      const prefix = begin > 0 ? '…' : '';
      const suffix = end < source.length ? '…' : '';
      return `${prefix}${source.slice(begin, end).trim()}${suffix}`;
    }
  }
  return source.slice(0, radius * 2).trim() + (source.length > radius * 2 ? '…' : '');
}

export function defaultSpiderDbPath(env = process.env) {
  const dataDir = String(env.CELIA_SPIDER_DATA_DIR || '').trim() || path.join(os.homedir(), '.celia_spider');
  return path.join(dataDir, 'knowledge.sqlite3');
}

export function createSpiderReader({ dbPath } = {}) {
  const file = path.resolve(String(dbPath || ''));
  if (!dbPath || !existsSync(file)) {
    throw coded('spider_index_unavailable');
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw coded('spider_index_unavailable', error);
  }

  const guarded = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (error?.code) throw error;
      throw coded('spider_index_unavailable', error);
    }
  };

  return {
    dbPath: file,

    /** بحث معجمي مطابق لدلالات `store.search` في حزمة العنكبوت. */
    search(query, limit = 10) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 25);
      const queryTerms = [...new Set(tokenize(String(query || '')))].sort();
      if (!queryTerms.length) return [];
      return guarded(() => {
        const placeholders = queryTerms.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT d.id, d.name, d.web_view_link, d.mime_type, d.modified_time,
                  COUNT(DISTINCT dt.term_id) AS matched,
                  COALESCE(SUM(dt.freq), 0) AS freq
           FROM document_terms dt
           JOIN terms t ON t.id = dt.term_id
           JOIN documents d ON d.id = dt.document_id
           WHERE t.term IN (${placeholders})
           GROUP BY d.id
           ORDER BY matched DESC, freq DESC, d.name ASC
           LIMIT ?`
        ).all(...queryTerms, bounded);
        const wanted = new Set(queryTerms);
        const contentOf = db.prepare('SELECT content FROM documents WHERE id = ?');
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          webViewLink: row.web_view_link ?? null,
          mimeType: row.mime_type,
          modifiedTime: row.modified_time ?? null,
          matchedTerms: Number(row.matched),
          score: Number(row.matched) * 10 + Math.min(Number(row.freq), 90),
          snippet: makeSnippet(contentOf.get(row.id)?.content || '', wanted)
        }));
      });
    },

    /** إحصاءات الشبكة — مرآة `graph_stats` بلا data_dir المضيف (لا تسريب مسارات). */
    stats() {
      return guarded(() => {
        const count = (sql) => Number(db.prepare(sql).get().c);
        const last = db.prepare("SELECT value FROM meta WHERE key = 'last_indexed_at'").get();
        return {
          documents: count('SELECT COUNT(*) AS c FROM documents'),
          terms: count('SELECT COUNT(*) AS c FROM terms'),
          links: count('SELECT COUNT(*) AS c FROM document_terms'),
          indexBytes: statSync(file).size,
          lastIndexedAt: last?.value ?? null
        };
      });
    },

    close() {
      try { db.close(); } catch { /* الإغلاق المزدوج غير مهم */ }
    }
  };
}
