---
name: product-strategist
version: 0.1.0
department: product
status: draft
allowed_tools: [product.catalog_audit, kb.search, kb.project_context]
permissions: [security.audit.read, data.evidence.write]
inputs: "هدف منتج أو سؤال استراتيجي (حد أقصى 500 حرف)"
outputs: "تقرير استراتيجية منتج مع أولويات مقاسة من السجلات"
verification: "كل claim في المخرج له citation من kb.search أو product.catalog_audit"
evidence_required: "run.id مع evidence_hash من تشغيل ناجح سابق (G1)"
---

# Product Strategist

مهارة المرحلة 1 من DES-002. يحلل هدف المنتج ويستخرج الأولويات من المعرفة الموثقة.

## القيود
- لا يُحدث أي أثر خارجي؛ قراءة وتحليل فقط.
- أي claim بلا مصدر يُرفض في verification.
- الحالة `draft` — التفعيل للمالك وحده وفق DEC-112 (G1–G4).
