"""اختبارات البحث المعجمي والشبكة المحلية على SQLite."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from celia_spider import store


DOC_A = {
    "id": "file-a",
    "name": "خطة النشر",
    "mime_type": "application/vnd.google-apps.document",
    "source": "google_drive",
    "web_view_link": "https://drive.google.com/file/d/file-a",
    "size": 512,
    "modified_time": "2026-10-27T09:00:00Z",
}
DOC_B = {
    "id": "file-b",
    "name": "ملخص الاجتماع",
    "mime_type": "text/plain",
    "source": "google_drive",
    "web_view_link": "https://drive.google.com/file/d/file-b",
    "size": 256,
    "modified_time": "2026-10-27T10:00:00Z",
}


class StoreKnowledgeNetworkTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_file = Path(self._tmp.name) / "knowledge.sqlite3"
        self.conn = store.connect(self.db_file)
        store.index_document(
            self.conn,
            DOC_A,
            "خطة النشر المجاني تعتمد على Render وAiven مع فحص صحي قبل التبديل.",
        )
        store.index_document(
            self.conn,
            DOC_B,
            "ملخص اجتماع النشر: تمت مناقشة خطة النشر ومخاطر التبديل بدون فحص.",
        )

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_search_returns_ranked_snippet_and_source(self):
        results = store.search(self.conn, "خطة النشر المجاني")
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["id"], "file-a")
        self.assertGreaterEqual(results[0]["matched_terms"], 3)
        self.assertIn("web_view_link", results[0])
        self.assertTrue(results[0]["snippet"])
        self.assertIn("render", results[0]["snippet"].lower())
        # الطرف الآخر يطابق مصطلحين فقط فيبقى في المرتبة الثانية.
        self.assertEqual(results[1]["id"], "file-b")
        self.assertEqual(results[1]["matched_terms"], 2)

    def test_network_connects_documents_via_shared_terms(self):
        network = store.explore_network(self.conn, "file-a")
        self.assertIsNotNone(network)
        term_names = {t["term"] for t in network["terms"]}
        self.assertIn("النشر", term_names)
        connected_ids = {c["id"] for c in network["connected_documents"]}
        self.assertEqual(connected_ids, {"file-b"})
        self.assertEqual(network["connected_documents"][0]["shared_terms"] >= 2, True)

    def test_read_document_and_list_sources(self):
        document = store.read_document(self.conn, "file-a")
        self.assertEqual(document["name"], "خطة النشر")
        self.assertIn("Render", document["content"])
        sources = store.list_sources(self.conn)
        self.assertEqual(len(sources), 2)
        self.assertTrue(all(s["web_view_link"].startswith("https://") for s in sources))
        self.assertIsNone(store.read_document(self.conn, "missing-id"))

    def test_stats_and_no_automatic_deletion(self):
        before = store.graph_stats(self.conn)
        self.assertEqual(before["documents"], 2)
        self.assertGreater(before["links"], 0)
        # مزامنة لاحقة تُحدّث مستندًا فقط ولا تحذف الغائب (التزام لا حذف تلقائي).
        store.index_document(
            self.conn,
            {**DOC_A, "name": "خطة النشر (محدَّثة)"},
            "خطة النشر المجاني تعتمد على Render وAiven مع فحص صحي قبل التبديل.",
        )
        after = store.graph_stats(self.conn)
        self.assertEqual(after["documents"], 2)
        self.assertIsNotNone(store.read_document(self.conn, "file-b"))

    def test_identical_content_does_not_reindex(self):
        changed = store.index_document(
            self.conn,
            DOC_B,
            "ملخص اجتماع النشر: تمت مناقشة خطة النشر ومخاطر التبديل بدون فحص.",
        )
        self.assertFalse(changed)


if __name__ == "__main__":
    unittest.main()
