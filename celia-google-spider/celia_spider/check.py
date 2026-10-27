"""فحص جاهزية الإعداد: ``python -m celia_spider.check``."""

from __future__ import annotations

import json
import sys

from . import config


def run_check(live: bool = False) -> dict:
    """فحص محلي (وسريع حي اختياري) دون طباعة أي محتوى حساس."""
    report: dict = {"ok": True, "checks": {}}
    checks = report["checks"]

    creds = config.credentials_path()
    checks["credentials_json"] = creds.is_file()
    if checks["credentials_json"]:
        try:
            payload = json.loads(creds.read_text(encoding="utf-8"))
            installed = payload.get("installed") or payload.get("web") or {}
            checks["credentials_shape"] = bool(installed.get("client_id"))
        except (json.JSONDecodeError, OSError, AttributeError):
            checks["credentials_shape"] = False

    token = config.token_path()
    checks["token_json"] = token.is_file()
    if checks["token_json"]:
        try:
            payload = json.loads(token.read_text(encoding="utf-8"))
            checks["token_has_scope"] = config.DRIVE_READONLY_SCOPE in str(
                payload.get("scope", "")
            )
            checks["token_refreshable"] = bool(payload.get("refresh_token"))
        except (json.JSONDecodeError, OSError):
            checks["token_has_scope"] = False

    try:
        config.ensure_data_dir()
        checks["data_dir_writable"] = True
    except OSError:
        checks["data_dir_writable"] = False

    try:
        from . import store

        conn = store.connect()
        report["stats"] = store.graph_stats(conn)
        conn.close()
        checks["index_openable"] = True
    except Exception:
        checks["index_openable"] = False

    if live and checks["token_json"]:
        try:
            from . import google_drive

            service = google_drive.build_service(google_drive.load_credentials())
            service.files().list(
                q="trashed = false", pageSize=1, fields="files(id)"
            ).execute()
            checks["drive_reachable"] = True
        except Exception as exc:
            checks["drive_reachable"] = False
            report["drive_error"] = type(exc).__name__

    required = [
        "credentials_json",
        "credentials_shape",
        "token_json",
        "data_dir_writable",
        "index_openable",
    ]
    if live:
        required.append("drive_reachable")
    report["ok"] = all(checks.get(name) for name in required)
    return report


def main() -> int:
    report = run_check(live="--live" in sys.argv)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
