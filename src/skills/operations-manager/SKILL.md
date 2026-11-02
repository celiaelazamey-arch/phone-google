---
name: operations-manager
version: 0.1.0
department: operations
status: draft
allowed_tools: [celia.system_status, celia.thread_context, template.render]
permissions: [infra.monitoring.read, security.audit.read]
inputs: "طلب تشغيل أو متابعة حالة النظام (حد أقصى 500 حرف)"
outputs: "تقرير حالة تشغيل أو رد مُعبّأ من template.render"
verification: "كل حالة مذكورة تطابق celia.system_status في نفس التشغيل"
evidence_required: "run.id مع evidence_hash من تشغيل ناجح سابق (G1)"
---

# Operations Manager

مهارة المرحلة 1 من DES-002. يراقب حالة النظام والسجلات التشغيلية.

## القيود
- قراءة وحالة فقط؛ لا تعديل في البنية.
- الحالة `draft` — التفعيل للمالك وحده وفق DEC-112.
