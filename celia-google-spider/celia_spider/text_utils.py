"""تطبيع وتفكيك النصوص العربية والإنجليزية للبحث المعجمي المحلي."""

from __future__ import annotations

import re
import unicodedata

# حدود عربية/لاتينية/أرقام فقط: تشمل التشكيل داخل النطاق العربي ثم يُزال لاحقًا.
TOKEN_RE = re.compile(r"[؀-ۿa-zA-Z0-9]+")

# تشكيل عربي + تطويل + علامات UNICODE عربية غير مفرّقة.
_DIACRITICS_RE = re.compile(
    r"[ً-ْٰٟـ]"
)

# توحيد صيغ الألف والتاء المربوطة والألف المقصورة والأرقام الهندية.
_CHAR_MAP = str.maketrans(
    {
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ة": "ه",
        "ى": "ي",
        "ؤ": "و",
        "ئ": "ي",
        "٠": "0",
        "١": "1",
        "٢": "2",
        "٣": "3",
        "٤": "4",
        "٥": "5",
        "٦": "6",
        "٧": "7",
        "٨": "8",
        "٩": "9",
    }
)


def normalize_token(token: str) -> str:
    """تطبيع كلمة واحدة: إزالة التشكيل والتوحيد وتحويل الحروف الصغيرة."""
    text = unicodedata.normalize("NFKC", token)
    text = _DIACRITICS_RE.sub("", text)
    text = text.translate(_CHAR_MAP)
    return text.lower()


def normalize_text(text: str) -> str:
    """تطبيع نص كامل مع الحفاظ على الفواصل بين الكلمات."""
    return " ".join(filter(None, (normalize_token(t) for t in TOKEN_RE.findall(text))))


def iter_tokens_with_positions(text: str):
    """يُمرّر (كلمة_مطبَّعة، بداية، نهاية) بمواضعها في النص الأصلي.

    المواضع تشير إلى النص الأصلي حتى تُستخرج المقتطفات بالنص دون تغيير.
    """
    for match in TOKEN_RE.finditer(text):
        normalized = normalize_token(match.group())
        if normalized:
            yield normalized, match.start(), match.end()


def tokenize(text: str) -> list[str]:
    """كلمات مطبَّعة صالحة للفهرسة (طول حرفين فأكثر أو أرقام)."""
    tokens = []
    for normalized, _, _ in iter_tokens_with_positions(text):
        if len(normalized) >= 2 or normalized.isdigit():
            tokens.append(normalized)
    return tokens


def make_snippet(text: str, query_terms: set[str], radius: int = 90) -> str:
    """مقتطف حول أول مطابقة لمصطلحات الاستعلام في النص الأصلي."""
    if not text:
        return ""
    for normalized, start, _ in iter_tokens_with_positions(text):
        if normalized in query_terms:
            begin = max(0, start - radius)
            end = min(len(text), start + radius * 2)
            prefix = "…" if begin > 0 else ""
            suffix = "…" if end < len(text) else ""
            return f"{prefix}{text[begin:end].strip()}{suffix}"
    return text[: radius * 2].strip() + ("…" if len(text) > radius * 2 else "")
