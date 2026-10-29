---
name: governed-pr-merge
description: إدارة الدفع على فرع الجلسة وفتح أو دمج طلبات السحب حصريًا بكلمة المالك مع الفحوص الثلاثة الإلزامية قبل الدمج.
---

# مهارة انضباط الفرع والدمج المحكوم (`governed-pr-merge`)

تحكم هذه المهارة عمليات `git push` وطلبات السحب (`gh pr`) وفق [AGENTS.md](../../../AGENTS.md) و[DEC-040](../../../docs/continuity/DECISIONS.md) و[docs/agent-2026-execution-plan.md](../../../docs/agent-2026-execution-plan.md).

## 1. حدود الصلاحية قبل كلمة المالك

- ادفع **فرع الجلسة المعيَّن من البيئة فقط**: `git push origin <assigned-branch>`.
- **لا تفتح PR ولا تدمج PR ولا تغلق PR ولا تنشر إصدارًا** إلا بطلب صريح من المالك في المحادثة.
- بعد الدفع إلى فرع الجلسة، تحقق من تشغيلة `Celia quality & resilience` على الفرع عبر `gh run list --branch "$(git branch --show-current)" --limit 5` وسجّل معرّف التشغيلة الفعلي.

## 2. الفحوص الثلاثة قبل أي دمج مفوَّض من المالك

عند صدور كلمة المالك الصريحة بالدمج، تحقّق أولًا من الشروط الثلاثة معًا:

1. رأس طلب السحب على GitHub (`headRefOid`) يطابق `git rev-parse HEAD` محليًا بلا التزامات لاحقة غير مرفوعة.
2. شجرة العمل نظيفة (`git status --porcelain` فارغ) وبوابة الاستمرارية (`npm run check:continuity` و`npm run now:check`) خضراء.
3. صفر فحوص معلّقة أو فاشلة في `gh pr checks <number>` عبر وظائف الجودة المطلوبة.

## 3. أمر الدمج والتحقق بعده

- نفّذ `gh pr merge <number> --merge` (أو الإستراتيجية التي يختارها المالك) كآخر أمر صريح دون أنابيب تخفي رمز الخروج، ودون `--auto`، ودون حذف فرع الجلسة النشطة.
- راقب تشغيلات `main` بعد الدمج (`Celia quality & resilience`، `Deploy (Cloudflare Edge)`، `Deploy (GitHub Pages)`، `Publish verified release`، `Quality failure notify`) وسجّل معرّفات التشغيلات الحقيقية فقط.
