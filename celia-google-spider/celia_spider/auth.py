"""تفويض Google OAuth للقراءة فقط: ``python -m celia_spider.auth``."""

from __future__ import annotations

import os
import sys

from . import config


def run_auth(open_browser: bool = True) -> str:
    """تشغيل تدفق الموافقة وحفظ token.json محليًا (خارج Git)."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds_file = config.credentials_path()
    if not creds_file.is_file():
        raise FileNotFoundError(
            f"credentials.json غير موجود في {creds_file} — نزّله من Google Cloud "
            "وضعه بجوار install_windows.bat أولًا."
        )
    flow = InstalledAppFlow.from_client_secrets_file(
        str(creds_file), [config.DRIVE_READONLY_SCOPE]
    )
    config.ensure_data_dir()
    creds = flow.run_local_server(
        port=0,
        open_browser=open_browser,
        authorization_prompt_message=(
            "افتح الرابط التالي لتفويض Google بصلاحية القراءة فقط:\n{url}"
        ),
        success_message="اكتمل تفويض Celia Google Spider. يمكنك إغلاق هذه النافذة.",
    )
    token_file = config.token_path()
    token_file.write_text(creds.to_json(), encoding="utf-8")
    try:
        os.chmod(token_file, 0o600)
    except OSError:
        pass
    return str(token_file)


def main() -> int:
    try:
        token_file = run_auth(open_browser="--no-browser" not in sys.argv)
    except Exception as exc:
        print(f"[celia_spider.auth] فشل التفويض: {exc}", file=sys.stderr)
        return 1
    print(f"[celia_spider.auth] حُفظ الرمز محليًا في: {token_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
