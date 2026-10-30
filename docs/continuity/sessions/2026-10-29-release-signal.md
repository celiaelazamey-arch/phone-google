# جلسة 2026-10-29 — إشارة التقدّم في صفحة الإصدارات (RELEASE-SIGNAL)

**الفرع:** `arena/afe3493a-phone-google` من `main@e99ebaf` · **الإصدار:** `v0.2.1` بلا ترقية · **schema=1** بلا ترحيل.

## السؤال

> هل صفحة `https://celiaelazamey-arch.github.io/phone-google/system.html#releases` حيّة وتُظهر التقدّم الحقيقي، أم صفحة ثابتة؟

## الجواب بعد قياس الملفات والمسارات

**نصفها حيّ، ونصفها مجمّد — والادعاء المكسور ليس الأرقام بل التغطية.**

| الجزء | الحقيقة | الدليل |
| --- | --- | --- |
| شبكة المكوّنات وشارة نسخة التشغيل | حيّة: من `GET /api/system` بمقاس فعلي (storage, durable, حالات المكوّنات) | `public/system.js#refresh`, `src/operations.js` |
| قائمة الإصدارات | تُخدَم من الخادم لا من HTML، لكن **محتواها ثلاثة مداخل مكتوبة بيد** في `releases/history.json` كلها `2026-10-27` | `grep` على `RELEASE_HISTORY`, `git log -1 -- releases/history.json` |
| ادعاء النشر | لا يدّعي نشرًا في النص (`catalog-only`)، لكن السجل **يُوحي** بأن 0.2.0/0.1.0 إصداران؛ الواقع: إصدار GitHub واحد `v0.2.1` | `gh release list` |
| التقدّم بعد 0.2.1 | **صفر مرئي**: لا شريحة من PR #93…#98 تظهر | `src/version.js` يرمي استثناءً إذا خالف `history.json` قيمة `package.json` |

## ما بُني في هذه الجلسة (كود مُقاس، لا كلام)

`src/progress.js` — قارئ حتمي بلا شبكة وبلا نموذج لقسم `Unreleased` من `CHANGELOG.md`:

- يحسب: `items` (بحد 500)، وتوزيعًا على أقسام مغلقة (`added/changed/fixed/removed/security/deprecated/limits`)، و`unknownSections`، و`parsed` صريحًا.
- يفشل مغلقًا: ملف مفقود أو أكبر من 2MiB ⇒ `parsed:false` مع سبب مسمّى (`changelog_unavailable`/`changelog_too_large`) ولا صفر مُختلق.
- الحد الفاصل محترم: قسم إصدار سابق **لا** يُحسب (اختبار PRG-01 يثبت ذلك).

`GET /api/releases` صار يحمل `unreleased` + `unreleasedSource: "CHANGELOG.md#Unreleased"`، والصفحة تعرضه بطاقة متقطّعة `.progress-card` **ليست** `.release-card`: لا رقم إصدار، ولا تاريخ، ولا وسم، ولا ادعاء نشر، وعدّادها لا يدخل في `RELEASE_HISTORY.length`.

كلتا صورتي `Dockerfile` و`Dockerfile.mcp` تنسخان `CHANGELOG.md`، والتراجع عند غيابه آمن (البطاقة تختفي).

## القياس

- **الاختبارات:** 796 إجمالًا / **779 ناجحًا** / 1 فشل بيئي (`MCP_TOOLS` N/N−1: كائن Git `2508893…` غير موجود في هذا الاستنساخ) / 16 skipped — قبل الشريحة 789/772/1/16. الشريحة تضيف **7** (`PRG-01..07`).
- **التغطية:** **90.88 / 76.21 / 86.92** (قبل: 90.86 / 76.15 / 86.90) و`src/progress.js` = 100/100/100.
- **البوّابات:** `npm run check` ✅ · `npm run check:secrets` ✅ · `npm run check:continuity` ✅ (يُعاد بعد تحديث `NOW.md`).
- **البطاقة اليوم:** 73 بندًا في `Unreleased` (أُضيف 63 · أُصلح 7 · حدود 3) — أي أن التقدّم **كان موجودًا في المصدر ولم يكن مرئيًا في الصفحة**.

## ما لم يُفعل (لا ادعاء)

1. **لا ترقية إصدار ولا نشر:** `package.json` و`releases/current.json` و`releases/history.json` لم تُمَس، و`main` بلا تغيير. البطاقة إشارة مصدر، ليست إصدارًا.
2. **لا تشغيل لـ Playwright هنا:** لا Chromium في هذا الصندوق. حدّثتُ `e2e/system.spec.js` ليثبت أن البطاقة لا تُحسب مع الإصدارات وتسمّي `CHANGELOG.md`، لكن **لم يُشغَّل** — لا يُدَّعى نجاحه.
3. **لا بناء صور Docker هنا:** إضافة `COPY CHANGELOG.md` لم تُختبر ببناء حقيقي، فقط بمراجعة وتحليل ثابت.
4. **لا إصلاح للعلّة الجذرية:** السجل سيظل مجمّدًا حتى ترقية إصدار صريحة؛ الإصلاح الحقيقي التالي هو أن تُشتق بطاقات الإصدار من الوسم والـcommit عند الترقية، لا أن تُكتب نثرًا.
5. **البطاقة تقيس ملفًا لا عملًا:** من يكتب بندًا في `Unreleased` يستطيع المبالغة؛ المراجعة البشرية قبل الإصدار تبقى الشرط.

## الملفات

`src/progress.js` (جديد) · `test/releases-progress.test.js` (جديد، PRG-01..07) · `src/operations.js` · `public/system.js` · `public/system.css` · `e2e/system.spec.js` · `Dockerfile` · `Dockerfile.mcp` · `CHANGELOG.md` (بند تحت `Unreleased`) · [docs/releases-and-recovery.md](../../releases-and-recovery.md) (§8) · `test/operations.test.js` (توكيد الحقل الجديد).
