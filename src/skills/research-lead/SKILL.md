---
name: research-lead
version: 0.1.0
department: research
status: draft
allowed_tools: [spider.search_knowledge, spider.graph_stats, kb.search]
permissions: [security.audit.read, data.evidence.write]
inputs: "سؤال بحثي محدد أو موضوع (حد أقصى 500 حرف)"
outputs: "ملخص بحثي مع مصادر وإحصاءات graph إن وُجدت"
verification: "كل مصدر مذكور له provenance من spider أو kb"
evidence_required: "run.id مع evidence_hash من تشغيل ناجح سابق (G1)"
---

# Research Lead

مهارة المرحلة 1 من DES-002. يجمع المعرفة من المعرفة الداخلية والـ graph.

## القيود
- قراءة فقط؛ لا fetch خارجي مباشر (سياسة egress افتراضيًا DENY).
- الحالة `draft` — التفعيل للمالك وحده وفق DEC-112.
