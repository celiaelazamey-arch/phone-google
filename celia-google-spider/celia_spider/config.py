"""مسارات الإعداد والتخزين لـ Celia Google Spider.

كل المسارات قابلة للتوجيه عبر متغيرات البيئة دون لمس الكود:

- ``CELIA_SPIDER_DATA_DIR``: مجلد البيانات الافتراضي ``~/.celia_spider``
  ويحوي ``knowledge.sqlite3`` و``token.json``.
- ``CELIA_SPIDER_CREDENTIALS``: مسار ملف OAuth ``credentials.json``.
- ``CELIA_SPIDER_MAX_FILES``: حد الملفات في المزامنة الواحدة (افتراضي 2000).
- ``CELIA_SPIDER_MAX_FILE_BYTES``: حد حجم الملف النصي (افتراضي 1MB).
"""

from __future__ import annotations

import os
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = Path.home() / ".celia_spider"
DEFAULT_MAX_FILES = 2000
DEFAULT_MAX_FILE_BYTES = 1_000_000

# صلاحية القراءة فقط — لا صلاحيات كتابة أو حذف على Drive.
DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"


def data_dir() -> Path:
    """مجلد البيانات المحلي (البيئة أو ~/.celia_spider)."""
    raw = os.environ.get("CELIA_SPIDER_DATA_DIR", "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_DATA_DIR


def db_path() -> Path:
    """مسار فهرس SQLite المحلي."""
    return data_dir() / "knowledge.sqlite3"


def token_path() -> Path:
    """مسار رمز OAuth المحفوظ محليًا (لا يُرفع إلى Git)."""
    return data_dir() / "token.json"


def credentials_path() -> Path:
    """مسار ملف اعتماد OAuth Desktop المحمول بجوار سكربتات التثبيت."""
    raw = os.environ.get("CELIA_SPIDER_CREDENTIALS", "").strip()
    if raw:
        return Path(raw).expanduser()
    packaged = PACKAGE_ROOT / "credentials.json"
    if packaged.is_file():
        return packaged
    return Path.cwd() / "credentials.json"


def max_files(default: int = DEFAULT_MAX_FILES) -> int:
    """حد الملفات في المزامنة الواحدة."""
    raw = os.environ.get("CELIA_SPIDER_MAX_FILES", "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        return default
    return value if value > 0 else default


def max_file_bytes(default: int = DEFAULT_MAX_FILE_BYTES) -> int:
    """حد حجم الملف النصي المقبول عند المزامنة."""
    raw = os.environ.get("CELIA_SPIDER_MAX_FILE_BYTES", "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        return default
    return value if value > 0 else default


def ensure_data_dir() -> Path:
    """ينشئ مجلد البيانات إن لم يكن موجودًا ويعيد مساره."""
    path = data_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path
