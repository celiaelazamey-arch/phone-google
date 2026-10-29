---
name: session-orient
description: استهلال كل جلسة تطوير في مستودع Celia بفحص الفرع الحي وسياق الاستمرارية والحالة الفعلية على GitHub قبل لمس أي ملف.
---

# مهارة استهلال الجلسة وفحص الواقع الحي (`session-orient`)

نفّذ هذه الخطوات في بداية كل جلسة قبل كتابة أي شيفرة أو تعديل أي وثيقة، التزامًا بـ[AGENTS.md](../../../AGENTS.md) و[DEC-003](../../../docs/continuity/DECISIONS.md) و[DEC-045](../../../docs/continuity/DECISIONS.md):

## 1. فحص البيئة والفرع المعيَّن

```sh
pwd
git branch --show-current
git status --short
git log -5 --oneline
```

- التزم بالفرع المعيَّن من البيئة فقط؛ لا تنشئ فرعًا جديدًا ولا تغيّر اسمه ولا تدفع إلى فرع آخر.
- حافظ على أي تغييرات محلية غير محفوظة؛ لا تشغّل `git reset --hard` أو `git clean`.
- تحقق مما إذا كان الفرع السابق قد حمل commit توثيق لما بعد الدمج فوق `main` لنقله بـ`git cherry-pick` عند الحاجة.

## 2. قراءة المراجع الحاكمة بالترتيب

1. [NOW.md](../../../docs/continuity/NOW.md) — اللقطة المشتقة آليًا للحالة والقرارات والمهام الجارية (للقراءة السريعة فقط؛ ليست مرجعًا ثانيًا).
2. [STATE.md](../../../docs/continuity/STATE.md) — التركيز النشط والخطوة التالية (التاريخ السابق محفوظ حرفيًا في [STATE-ARCHIVE-2026-10.md](../../../docs/continuity/STATE-ARCHIVE-2026-10.md)).
3. [BACKLOG.md](../../../docs/continuity/BACKLOG.md) — المرجع الوحيد لحالات المهام ومعايير القبول.
4. [DECISIONS.md](../../../docs/continuity/DECISIONS.md) — سجل القرارات المتسلسل؛ اقرأ آخر `DEC-NNN` فعليًا قبل حجز أي رقم قرار جديد.
5. [docs/agent-2026-execution-plan.md](../../../docs/agent-2026-execution-plan.md) و[docs/compatibility-contract.md](../../../docs/compatibility-contract.md).

## 3. التحقق الحي بدل الاعتماد على لقطات الدردشة

- افحص طلبات السحب والتشغيلات الحية عبر `gh pr list --state all --limit 10` و`gh run list --branch main --limit 10` قبل تصديق أي ادعاء عن حالة `main` أو النشر.
- إذا جلب المستخدم محادثة خارجية من مساحة عمل منفصلة أو معزولة، قارن كل ملف ومعرّف قرار بسجل المستودع الفعلي قبل التطبيق.
- اختر معرّف مهمة واضحًا من `BACKLOG.md` ومعيار قبول محددًا قبل البدء بالتنفيذ.
