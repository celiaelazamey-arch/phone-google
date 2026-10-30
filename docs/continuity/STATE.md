# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **RELEASE-SIGNAL — «هل `system.html#releases` تعكس التقدّم فعلًا؟»** على `arena/afe3493a-phone-google` من `main@e99ebaf`. **الجواب:** نصفها حيّ ونصفها مجمّد — المكوّنات من `GET /api/system` الحقيقي، وسجل الإصدارات ثلاثة مداخل مكتوبة بيد في `releases/history.json` لا تتحرك إلا بترقية إصدار (`src/version.js` يرمي استثناءً عند المخالفة)، فلا شريحة من PR #93…#98 ظهرت، وGitHub يحمل إصدارًا منشورًا واحدًا (`v0.2.1`) بينما السجل يعرض ثلاثة. **الإصلاح المقيس:** [`src/progress.js`](../../src/progress.js) يقرأ قسم `Unreleased` من `CHANGELOG.md` بلا شبكة ولا نموذج، ويُضاف إلى `GET /api/releases` كحقل `unreleased`، وتعرضه الصفحة بطاقة متقطّعة `.progress-card` **ليست** بطاقة إصدار ولا تحمل تاريخًا أو وسمًا أو ادعاء نشر، وتصمت (`parsed:false`) إن غاب الملف. الاختبارات `PRG-01..07`. سجل الجلسة: [2026-10-29-release-signal](sessions/2026-10-29-release-signal.md) · الشرح التشغيلي: [§8 من دليل الإصدارات](../releases-and-recovery.md).

**الجلسة السابقة:** **MANUS-GAP-PLAN — خطة إغلاق الفجوات** (PR [#99](https://github.com/celiaelazamey-arch/phone-google/pull/99) مفتوح، توثيق فقط، صفر كود): جرد 19 فجوة (G1..G19) ونقد بناء وخطة ثماني شرائح S1..S8 وستة قرارات مالك D1..D6 في [agent-web-gaps.md](../agent-web-gaps.md).
**قبلها:** MANUS-C2aL («اجلب ولخّص من ٣ مصادر» → `main@e99ebaf`، PR #98، `DEC-062`) · C1-b/C2-a (PR #96 → `main@00a2386`) · C1-a (PR #95 → `main@97078dc`) · B4 (PR #93 → `main@acafa13`) · B3 + إنقاذ A4 + قارئ العنكبوت (PR #92 → `main@bdfbb6b`) · وما قبلها في `docs/continuity/sessions/` وروابطها في [NOW.md](NOW.md).
**ملاحظة استمرارية:** **PR #99 مفتوح بانتظار كلمة المالك — لا دمج تلقائي** (`DEC-015`/`DEC-016`). **#97 و#94 أُغلقا كمُستبدَلين** بعد نقل كل نص فريد منهما (لا شيء ضاع).

## 0. خط الأساس والدرجة

- **بداية الجلسة:** `arena/afe3493a-phone-google` من `main@e99ebaf` (دمج PR #98) بشجرة نظيفة؛ **`main` لم يتغيّر** ولا نشر ولا ترحيل ولا تفعيل `proxy` في أي بيئة.
- **الإصدار:** `v0.2.1` · `schema=1` · Node `>=22`. **لا ترقية إصدار في هذه الشريحة** (ولا ترحيل، ولا جدول، ولا نوع أدلة).
- **السلّم:** S1/A4 ✅ · S5 (M-C): C1-a ✅ · C1-b ✅ · C2-a ✅ أداةً وحلقةً · **C2-b (`web.search`) مؤجّلة** بقرار المالك · C3/C4 موقوفة على بيئة بلا Chromium هنا.
- **التالي المقترح (لا يحتاج قرارًا):** `S1` عقد الادعاء (`claims.js` + `claim_attribution` + CL-01…CL-05) → `S2` كشف التعارض بين المصادر → `S3` تقوية الجلب (منع العناوين الداخلية **قبل** أي تفعيل حقيقي).
- **الجودة:** **796 اختبارًا / 779 ناجحًا / 1 فشل بيئي (`MCP_TOOLS` N/N−1: كائن Git `2508893…` غير موجود في هذا الاستنساخ) / 16 skipped** وتغطية **90.88 / 76.21 / 86.92** (قبل الشريحة: 789 / 772 / 1 / 16 و90.86 / 76.15 / 86.90). الشريحة تضيف **7** اختبارات (`PRG-01..07`) و`src/progress.js` بتغطية 100/100/100.

## 1. مخرَج هذه الجلسة (إشارة تقدّم حقيقية، بلا ادعاء إصدار)

- **الجواب:** الصفحة لا تكذب في أرقامها، لكنها **لا تغطي التقدّم**: السجل `catalog-only`، ثلاثة مداخل كلها `2026-10-27`، إصدار GitHub واحد، و`src/version.js` يمنع أن يخالف السجل `package.json`. الشريحة تُظهر ما جرى بعد آخر إصدار بدل تجميد السجل.
- **`src/progress.js`:** قارئ حتمي لقسم `Unreleased` — `items` (بحد 500)، توزيع على أقسام مغلقة، `unknownSections`، و`parsed` صريح؛ يفشل مغلقًا (`changelog_unavailable` / `changelog_too_large`) بلا صفر مُختلق. قسم إصدار سابق لا يُحسب (PRG-01).
- **الواجهة:** `GET /api/releases` + `unreleasedSource`، وبطاقة `.progress-card` متقطّعة منفصلة عن `.release-card`؛ `RELEASE_HISTORY.length` يبقى مرجع عدد الإصدارات في الاختبارات.
- **الصورة:** `Dockerfile` و`Dockerfile.mcp` تنسخان `CHANGELOG.md`، والغياب مُعالج.
- **القياس اليوم:** 73 بندًا في `Unreleased` (أُضيف 63 · أُصلح 7 · حدود 3) — التقدّم كان في المصدر ولم يكن مرئيًا.

## 2. الحدود والعوائق

1. **لا ترقية إصدار ولا نشر:** `package.json` و`releases/current.json` و`releases/history.json` لم تُمَس؛ البطاقة إشارة مصدر لا إصدار.
2. **Playwright لم يُشغَّل هنا** (لا Chromium): حُدِّث `e2e/system.spec.js` ليثبت أن البطاقة لا تُحسب مع الإصدارات وتسمّي `CHANGELOG.md`، ولا يُدَّعى نجاحه.
3. **صور Docker لم تُبنَ هنا:** إضافة `COPY CHANGELOG.md` مراجَعة ثابتة فقط.
4. **البطاقة تقيس ملفًا لا عملًا:** كتابة بند في `Unreleased` لا تُثبت إنجازًا؛ المراجعة البشرية قبل الإصدار شرط. والعلّة الجذرية (سجل يُكتب بيد) تبقى حتى تُشتق البطاقات من الوسم والـcommit عند الترقية.
5. **لا إنترنت حقيقي:** كل مشاهد الويب على `127.0.0.1`؛ `proxy` غير مُفعَّل في أي بيئة؛ `web.search` مؤجّلة.
6. **العزل بلا شبكة (`DEC-060`):** `sandbox-policy.js` يرفض `network.allowlist`، وEP-11 يحرس ذلك. طبقة المحوّلات لم تُبنَ (`DEC-061`).
7. **لا MySQL/Chromium في هذا الصندوق:** `test:mysql`/`test:browser` لم تُشغَّل.

## 3. الاستئناف والفحوص

1. ابقَ على `arena/afe3493a-phone-google`؛ اقرأ [سجل هذه الجلسة](sessions/2026-10-29-release-signal.md) و[§8 من دليل الإصدارات](../releases-and-recovery.md) قبل تعديل `/api/releases` أو `public/system.js`.
2. لا ترفع الإصدار في `package.json` وحدها؛ الترقية تحتاج `releases/current.json` و`history.json` و`CHANGELOG.md` معًا وإلا رمى `src/version.js`.
3. لا تُضف بطاقة تقدّم ثانية أو قائمة إصدارات مكتوبة يدويًا في HTML؛ مصدرا الصفحة هما `/api/system` و`/api/releases`.
4. أول فحص آمن: `node --test test/releases-progress.test.js test/operations.test.js` ثم `npm run check:continuity`.
5. دمج PR #99 ليس تلقائيًا؛ ينتظر كلمة المالك.

```sh
git branch --show-current && git status --short && git log -3 --oneline
node --test test/releases-progress.test.js test/operations.test.js test/r0-continuity-2026.test.js
npm run check && npm run now && npm run now:check && npm run check:continuity && npm run check:secrets
npm run test:coverage
```
