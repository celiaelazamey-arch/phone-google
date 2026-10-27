"""خادم MCP المحلي عبر stdio: ``python -m celia_spider.server``.

ست أدوات فقط، ولا يُفتح أي منفذ شبكة: الاتصال بعميل MCP يتم عبر stdio
كما هو موثّق في دليل الإعداد. النسخة الحالية ليست موصلًا داخل ChatGPT.
"""

from __future__ import annotations

import sys

from . import config, google_drive, store

# توافق مع مخططتَي MCP Python SDK: v1 (FastMCP) وv2 (MCPServer).
try:  # pragma: no cover - حسب الإصدار المثبت
    from mcp.server.mcpserver import MCPServer as _Server
except ModuleNotFoundError:  # pragma: no cover
    from mcp.server.fastmcp import FastMCP as _Server

_SERVER = _Server(
    name="celia-google-spider",
    instructions=(
        "فهرس معرفة محلي لملفات Google Drive: بحث معجمي وشبكة مستند ↔ مصطلح. "
        "القراءة فقط ولا يحذف أي ملفات."
    ),
)


@_SERVER.tool()
def spider_sync_google_drive(max_files: int = 0) -> dict:
    """مزامنة الملفات النصية المدعومة من Google Drive وبناء الشبكة المحلية.

    لا تحذف عناصر محلية قديمة؛ الملفات غير المدعومة أو كبيرة الحجم تُتخطّى.
    max_files=0 يستخدم حد الإعداد (2000 افتراضيًا).
    """
    creds = google_drive.load_credentials()
    service = google_drive.build_service(creds)
    conn = store.connect()
    try:
        return google_drive.sync(service, conn, max_files=max_files or None)
    finally:
        conn.close()


@_SERVER.tool()
def spider_search_knowledge(query: str, limit: int = 10) -> dict:
    """البحث عن المعرفة وإظهار مقتطفات مع مصدرها (بحث معجمي محلي)."""
    conn = store.connect()
    try:
        results = store.search(conn, query, limit=max(1, min(limit, 50)))
        return {"query": query, "count": len(results), "results": results}
    finally:
        conn.close()


@_SERVER.tool()
def spider_read_document(document_id: str) -> dict:
    """قراءة مستند مفهرس بواسطة Google Drive file ID."""
    conn = store.connect()
    try:
        document = store.read_document(conn, document_id)
    finally:
        conn.close()
    if document is None:
        raise ValueError(f"المستند غير موجود في الفهرس المحلي: {document_id}")
    return document


@_SERVER.tool()
def spider_explore_network(document_id: str, limit: int = 20) -> dict:
    """استكشاف عقد المستندات والكلمات المتصلة بها (مستند ↔ مصطلح ↔ مستند)."""
    conn = store.connect()
    try:
        network = store.explore_network(
            conn, document_id, limit=max(1, min(limit, 100))
        )
    finally:
        conn.close()
    if network is None:
        raise ValueError(f"المستند غير موجود في الفهرس المحلي: {document_id}")
    return network


@_SERVER.tool()
def spider_list_sources(limit: int = 100) -> dict:
    """عرض المصادر المفهرسة وروابط Drive (قراءة فقط)."""
    conn = store.connect()
    try:
        sources = store.list_sources(conn, limit=max(1, min(limit, 500)))
        return {"count": len(sources), "sources": sources}
    finally:
        conn.close()


@_SERVER.tool()
def spider_graph_stats() -> dict:
    """عرض عدد المستندات والمصطلحات والروابط وحجم الفهرس."""
    conn = store.connect()
    try:
        return store.graph_stats(conn)
    finally:
        conn.close()


def main() -> int:
    try:
        _SERVER.run(transport="stdio")
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
