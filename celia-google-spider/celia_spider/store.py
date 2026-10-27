"""فهرس SQLite وشبكة المصطلحات والبحث المحلي.

الشبكة ثنائية: ``مستند ↔ مصطلح ↔ مستند``. الفهرس محلي فقط ولا يرسل أي
نص خارج الجهاز. لا يوجد مسار حذف تلقائي: المزامنة تُحدث المستندات الموجودة
ولا تحذف عناصر محلية قديمة غابت عن Drive (التزام «لا حذف تلقائي»).
"""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .text_utils import make_snippet, tokenize

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  source TEXT NOT NULL,
  web_view_link TEXT,
  size INTEGER,
  modified_time TEXT,
  content_hash TEXT,
  content TEXT,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS document_terms (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  freq INTEGER NOT NULL,
  PRIMARY KEY (document_id, term_id)
);
CREATE INDEX IF NOT EXISTS idx_document_terms_term ON document_terms(term_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_file: Path | None = None) -> sqlite3.Connection:
    """فتح/تهيئة الفهرس المحلي مع ربط صفوف كـdict."""
    path = db_file or config.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def index_document(conn: sqlite3.Connection, meta: dict, text: str) -> bool:
    """إدراج/تحديث مستند وربط مصطلحاته. يعيد False عند تطابق المحتوى.

    لا يحذف أي مستندًا آخر؛ الغائب عن مزامنة لاحقة يبقى محليًا كما هو.
    """
    doc_id = str(meta["id"])
    digest = content_hash(text)
    existing = conn.execute(
        "SELECT content_hash FROM documents WHERE id = ?", (doc_id,)
    ).fetchone()
    if existing and existing["content_hash"] == digest:
        conn.execute(
            "UPDATE documents SET name = ?, web_view_link = ?, modified_time = ? WHERE id = ?",
            (
                meta.get("name") or "",
                meta.get("web_view_link"),
                meta.get("modified_time"),
                doc_id,
            ),
        )
        conn.commit()
        return False

    terms = tokenize(text)
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.execute(
            """
            INSERT INTO documents
              (id, name, mime_type, source, web_view_link, size, modified_time,
               content_hash, content, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                doc_id,
                meta.get("name") or "",
                meta.get("mime_type") or "application/octet-stream",
                meta.get("source") or "google_drive",
                meta.get("web_view_link"),
                meta.get("size"),
                meta.get("modified_time"),
                digest,
                text,
                _now(),
            ),
        )
        freq: dict[str, int] = {}
        for term in terms:
            freq[term] = freq.get(term, 0) + 1
        for term, count in freq.items():
            conn.execute("INSERT OR IGNORE INTO terms (term) VALUES (?)", (term,))
            term_id = conn.execute(
                "SELECT id FROM terms WHERE term = ?", (term,)
            ).fetchone()["id"]
            conn.execute(
                "INSERT INTO document_terms (document_id, term_id, freq) VALUES (?, ?, ?)",
                (doc_id, term_id, count),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)",
            (_now(),),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return True


def search(conn: sqlite3.Connection, query: str, limit: int = 10) -> list[dict]:
    """بحث معجمي محلي: يُرتّب بعدد المصطلحات المطابقة ثم بالتكرار."""
    query_terms = sorted(set(tokenize(query)))
    if not query_terms:
        return []
    placeholders = ",".join("?" for _ in query_terms)
    rows = conn.execute(
        f"""
        SELECT d.id, d.name, d.web_view_link, d.mime_type, d.modified_time,
               COUNT(DISTINCT dt.term_id) AS matched,
               COALESCE(SUM(dt.freq), 0) AS freq
        FROM document_terms dt
        JOIN terms t ON t.id = dt.term_id
        JOIN documents d ON d.id = dt.document_id
        WHERE t.term IN ({placeholders})
        GROUP BY d.id
        ORDER BY matched DESC, freq DESC, d.name ASC
        LIMIT ?
        """,
        (*query_terms, limit),
    ).fetchall()
    wanted = set(query_terms)
    results = []
    for row in rows:
        content = conn.execute(
            "SELECT content FROM documents WHERE id = ?", (row["id"],)
        ).fetchone()["content"]
        results.append(
            {
                "id": row["id"],
                "name": row["name"],
                "web_view_link": row["web_view_link"],
                "mime_type": row["mime_type"],
                "modified_time": row["modified_time"],
                "matched_terms": row["matched"],
                "score": row["matched"] * 10 + min(row["freq"], 90),
                "snippet": make_snippet(content or "", wanted),
            }
        )
    return results


def read_document(conn: sqlite3.Connection, document_id: str) -> dict | None:
    row = conn.execute(
        "SELECT id, name, mime_type, source, web_view_link, size, modified_time,"
        " content, indexed_at FROM documents WHERE id = ?",
        (document_id,),
    ).fetchone()
    return dict(row) if row else None


def explore_network(
    conn: sqlite3.Connection, document_id: str, limit: int = 20
) -> dict | None:
    """استكشاف عقد المستند: مصطلحاته ثم المستندات المرتبطة بها مشتركة."""
    doc = conn.execute(
        "SELECT id, name, web_view_link FROM documents WHERE id = ?",
        (document_id,),
    ).fetchone()
    if not doc:
        return None
    terms = conn.execute(
        """
        SELECT t.term, dt.freq FROM document_terms dt
        JOIN terms t ON t.id = dt.term_id
        WHERE dt.document_id = ?
        ORDER BY dt.freq DESC, t.term ASC
        LIMIT ?
        """,
        (document_id, limit),
    ).fetchall()
    connected = conn.execute(
        """
        SELECT d.id, d.name, d.web_view_link,
               COUNT(DISTINCT dt1.term_id) AS shared_terms
        FROM document_terms dt0
        JOIN document_terms dt1 ON dt1.term_id = dt0.term_id
                             AND dt1.document_id != dt0.document_id
        JOIN documents d ON d.id = dt1.document_id
        WHERE dt0.document_id = ?
        GROUP BY d.id
        ORDER BY shared_terms DESC, d.name ASC
        LIMIT ?
        """,
        (document_id, limit),
    ).fetchall()
    return {
        "document": dict(doc),
        "terms": [dict(t) for t in terms],
        "connected_documents": [dict(c) for c in connected],
    }


def list_sources(conn: sqlite3.Connection, limit: int = 100) -> list[dict]:
    """المصادر المفهرسة وروابط Drive (للقراءة فقط)."""
    rows = conn.execute(
        """
        SELECT id, name, mime_type, source, web_view_link, size,
               modified_time, indexed_at
        FROM documents
        ORDER BY indexed_at DESC, name ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def graph_stats(conn: sqlite3.Connection) -> dict:
    """إحصاء المستندات والمصطلحات والروابط وحجم الفهرس."""
    documents = conn.execute("SELECT COUNT(*) AS c FROM documents").fetchone()["c"]
    terms = conn.execute("SELECT COUNT(*) AS c FROM terms").fetchone()["c"]
    links = conn.execute("SELECT COUNT(*) AS c FROM document_terms").fetchone()["c"]
    last = conn.execute(
        "SELECT value FROM meta WHERE key = 'last_indexed_at'"
    ).fetchone()
    # مسار ملف القاعدة الفعلي لهذا الاتصال (يدعم مسارات اختبار مخصصة).
    db_row = conn.execute("PRAGMA database_list").fetchone()
    db_file = Path(db_row[2]) if db_row and db_row[2] else config.db_path()
    size = db_file.stat().st_size if db_file.is_file() else 0
    return {
        "documents": documents,
        "terms": terms,
        "links": links,
        "index_bytes": size,
        "data_dir": str(config.data_dir()),
        "last_indexed_at": last["value"] if last else None,
    }
