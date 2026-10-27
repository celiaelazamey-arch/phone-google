"""OAuth وقراءة Drive واستخراج النص والمزامنة (قراءة فقط)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import config, store

# أنواع الملفات النصية المباشرة + مستندات Google Docs/Sheets القابلة للتصدير.
TEXT_PLAIN_MIMES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/x-yaml",
}
GOOGLE_DOCS_MIME = "application/vnd.google-apps.document"
GOOGLE_SHEETS_MIME = "application/vnd.google-apps.spreadsheet"
MAX_PAGE_SIZE = 100


def load_credentials():
    """تحميل رمز OAuth المحفوظ وتجديده عند انتهاء الصلاحية."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    token_file = config.token_path()
    if not token_file.is_file():
        raise RuntimeError(
            "token.json غير موجود — شغّل `python -m celia_spider.auth` أولًا."
        )
    creds = Credentials.from_authorized_user_file(
        str(token_file), [config.DRIVE_READONLY_SCOPE]
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(creds.to_json(), encoding="utf-8")
    if not creds.valid:
        raise RuntimeError("رمز OAuth غير صالح — أعد تشغيل celia_spider.auth.")
    return creds


def build_service(creds):
    """بناء خدمة Drive API v3 بصلاحية القراءة فقط."""
    from googleapiclient.discovery import build

    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _export_or_download(service, file_meta: dict, max_bytes: int) -> str | None:
    """استخراج نص ملف واحد؛ يعيد None للملفات غير المدعومة أو كبيرة الحجم."""
    mime = file_meta.get("mimeType", "")
    file_id = file_meta["id"]
    size = int(file_meta.get("size") or 0)
    if size and size > max_bytes:
        return None

    if mime in TEXT_PLAIN_MIMES:
        data = service.files().get(fileId=file_id, alt="media").execute()
        if isinstance(data, bytes):
            if len(data) > max_bytes:
                return None
            return data.decode("utf-8", errors="replace")
        text = str(data)
    elif mime == GOOGLE_DOCS_MIME:
        data = service.files().export(fileId=file_id, mimeType="text/plain").execute()
        text = data if isinstance(data, str) else str(data)
        if len(text.encode("utf-8")) > max_bytes:
            return None
    elif mime == GOOGLE_SHEETS_MIME:
        # نسخة CSV من الورقة الأولى فقط في هذه النسخة.
        data = service.files().export(fileId=file_id, mimeType="text/csv").execute()
        text = data if isinstance(data, str) else str(data)
        if len(text.encode("utf-8")) > max_bytes:
            return None
    else:
        return None
    return text if text and text.strip() else None


def iter_supported_files(service, max_files: int):
    """يُرشّح ملفات Drive المدعومة للقراءة فقط حتى حد max_files."""
    page_token = None
    scanned = 0
    while scanned < max_files:
        request = service.files().list(
            q="trashed = false",
            spaces="drive",
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)",
            pageSize=min(MAX_PAGE_SIZE, max_files - scanned),
            pageToken=page_token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=False,
        )
        response = request.execute()
        files = response.get("files", [])
        if not files:
            break
        for file_meta in files:
            scanned += 1
            yield file_meta
            if scanned >= max_files:
                break
        page_token = response.get("nextPageToken")
        if not page_token:
            break


def sync(
    service,
    conn,
    max_files: int | None = None,
    max_bytes: int | None = None,
) -> dict:
    """مزامنة بناء الشبكة المحلية: إدراج/تحديث فقط دون أي حذف.

    الملفات غير المدعومة أو كبيرة الحجم أو التي فشلت قراءتها تُتخطّى
    وتُعدّ في الملخص دون مقاومة المزامنة.
    """
    limit = max_files if max_files and max_files > 0 else config.max_files()
    byte_limit = max_bytes if max_bytes and max_bytes > 0 else config.max_file_bytes()
    summary = {
        "scanned": 0,
        "indexed": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped_unsupported": 0,
        "skipped_too_large": 0,
        "failed": 0,
        "max_files": limit,
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    for file_meta in iter_supported_files(service, limit):
        summary["scanned"] += 1
        try:
            mime = file_meta.get("mimeType", "")
            size = int(file_meta.get("size") or 0)
            if size > byte_limit:
                summary["skipped_too_large"] += 1
                continue
            text = _export_or_download(service, file_meta, byte_limit)
            if text is None:
                if mime in TEXT_PLAIN_MIMES or mime in (
                    GOOGLE_DOCS_MIME,
                    GOOGLE_SHEETS_MIME,
                ):
                    summary["skipped_too_large"] += 1
                else:
                    summary["skipped_unsupported"] += 1
                continue
            meta = {
                "id": file_meta["id"],
                "name": file_meta.get("name") or "",
                "mime_type": mime,
                "source": "google_drive",
                "web_view_link": file_meta.get("webViewLink"),
                "size": size or None,
                "modified_time": file_meta.get("modifiedTime"),
            }
            if store.index_document(conn, meta, text):
                summary["indexed"] += 1
            else:
                summary["unchanged"] += 1
        except Exception:
            summary["failed"] += 1
    summary["stats"] = store.graph_stats(conn)
    return summary
