---
name: creative-director
version: 0.1.0
department: creative
status: draft
allowed_tools: [creative.workflow_plan, celia.draft_outline]
permissions: [frontend.design.write, data.evidence.write]
inputs: "هدف إبداعي أو brief محتوى (حد أقصى 500 حرف)"
outputs: "خطة عمل إبداعية أو outline أولي"
verification: "المخرج يحتوي workflow plan أو outline produced من الأداتين"
evidence_required: "run.id مع evidence_hash من تشغيل ناجح سابق (G1)"
---

# Creative Director

مهارة المرحلة 1 من DES-002. يبني خطط العمل الإبداعية والـ outlines من القوالب.

## القيود
- لا ينشر فعليًا؛ بوابة النشر تمر بالمالك.
- الحالة `draft` — التفعيل للمالك وحده وفق DEC-112.
