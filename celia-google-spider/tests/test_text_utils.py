"""اختبارات تطبيع النص العربي والإنجليزية."""

from __future__ import annotations

import unittest

from celia_spider.text_utils import make_snippet, normalize_text, tokenize


class TextUtilsTests(unittest.TestCase):
    def test_arabic_diacritics_and_alef_normalization(self):
        self.assertEqual(normalize_text("مَرْحَبًا بِكُمْ"), "مرحبا بكم")
        self.assertEqual(normalize_text("أحمد وإبراهيم آمل"), "احمد وابراهيم امل")

    def test_tokenize_mixed_arabic_english(self):
        tokens = tokenize("Celia تبحث في Google Drive عن «المعرفة»")
        self.assertIn("celia", tokens)
        self.assertIn("google", tokens)
        self.assertIn("drive", tokens)
        self.assertIn("المعرفه", tokens)

    def test_single_letter_words_dropped_from_index(self):
        # كلمات الحرف الواحد (عربية أو لاتينية) لا تُفهرس لأنها تربط كل شيء.
        tokens = tokenize("و ا ب a I")
        self.assertEqual(tokens, [])

    def test_make_snippet_uses_original_text(self):
        text = "هذا مستند يشرح مسار النشر الجديد بالتفصيل داخل النظام."
        snippet = make_snippet(text, {"النشر"})
        self.assertIn("مسار النشر الجديد", snippet)
        self.assertTrue(snippet.startswith("…") or snippet.startswith("هذا"))


if __name__ == "__main__":
    unittest.main()
