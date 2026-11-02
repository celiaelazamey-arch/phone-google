---
name: finance-manager
version: 0.1.0
department: finance
status: draft
allowed_tools: [kb.search, celia.system_status]
permissions: [security.audit.read, infra.monitoring.read]
inputs: "سؤال مالي أو تكلفة تشغيل (حد أقصى 500 حرف)"
outputs: "تحليل مالي/تكلفة مع أرقام من السجلات لا من الذاكرة"
verification: "كل رقم في المخرج يعود إلى مصدر في kb أو system_status"
evidence_required: "run.id مع evidence_hash من تشغيل ناجح سابق (G1)"
---

# Finance Manager

مهارة المرحلة 1 من DES-002. يتابع التكاليف والمؤشرات المالية من السجلات.

## القيود
- قراءة فقط؛ لا توجد عمليات مالية فعلية.
- الحالة `draft` — التفعيل للمالك وحده وفق DEC-112.
