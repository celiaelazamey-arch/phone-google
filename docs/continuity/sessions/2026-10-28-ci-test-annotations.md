# تسليم جلسة — 2026-10-28 — فشل CI يسمّي نفسه (DEC-032، QA-006)

## المهمة والتفويض

- طلب المستخدم: «نفّذ» ردًّا على اقتراحي إضافة مُبلِّغ annotations للاختبارات بعد فشلين أعميين في يوم واحد. قبلها بالترتيب:
  «تم» (ضبط `CELIA_VOICE_ID`) → دفعتا `[reality]`؛ ثم «Please merge the pull request» → دمج PR #48 → `main@fc4d60f`.
- الفرع: `arena/afd3acff-phone-google` (متفرع من `fc4d60f`). لا دمج ولا نشر ولا تغيير أسرار من هنا؛ PR عند الطلب فقط.
- المعرفات: QA-006 (جديد)، DEC-032 (جديد)؛ يعتمد على QA-005.

## واقع البداية

- `main@fc4d60f` (دمج PR #48): Edge ✅ `40665130452`، Quality ✅ `40665130587`، Pages ✅ `40665130450`، Render ✅
  `40665295476`؛ **Publish verified release ❌ `40665130469`** في خطوة `check && release:check && npm test && npm audit` —
  لا سجل يُقرأ؛ `npm audit` نظيف محليًا بنفس الـlockfile؛ Quality نجح على الـSHA نفسه؛ `npm test` ×3 تحت Node 24.22.1 محليًا
  326/326. قبلها بساعتين: فشل ساق Node 24 في run `40662071493` بالنمط نفسه. أي: تقلّب على Node 24 في runner GitHub لا
  يُستنسخ هنا، وبلا اسم.
- ElevenLabs بعد «تم» الثانية (runs `40663032835`، `40663707956`): الـworkflow ما زال يستلم معرّفًا مختلفًا تمامًا (20 حرفًا،
  18 تعديلًا من أقرب صوت مرئي) → التحديث لم يصل إلى Repository secret في تبويب Actions → Secrets. ما زال 91.7%.

## ما تغير فعليًا

- `scripts/test-reporter-gha.mjs` (جديد): مُبلِّغ `node --test` يطبع `::error file=…,line=…,col=…,title=<اسم الاختبار>::<الخطأ>`
  لكل اختبار فاشل (الآباء الفاشلون بسبب أبنائهم `subtestsFailed` لا يتكررون؛ ملف ينهار عند التحميل يحمل ذيل stderr الخاص به)،
  `::error` لكل عتبة تغطية غير محققة (`test:diagnostic` بمستوى `error`)، سطرًا ختاميًا `::notice`/`::error` بالأعداد والتغطية
  وكل أسماء الفاشلين (9 تفصيلية + 1 ختامي = سقف GitHub)، وجدولًا في `GITHUB_STEP_SUMMARY`. خارج Actions نص عادي. لا يسقط
  التشغيل أبدًا (الأخطاء الداخلية → `::warning`).
- `package.json`: `test:ci` و`test:coverage:ci` (المُبلِّغان `spec` + GHA إلى `stdout`). `celia-mcp.yml` → `test:coverage:ci`؛
  `release.yml` و`pages.yml` → `test:ci`.
- `scripts/service-reality.mjs`: `parseTestSummary` يعيد `failing: [...]` من أسطر TAP `not ok` (بلا ملفات)، والـannotation
  `Service Reality · offline` تحمله عند الفشل. تشخيص ElevenLabs يضيف «أقرب صوت مرئي» (حالة أحرف / خطأ كتابة / لم يُحدَّث)
  بمسافة تحرير دون كشف القيمة (`editDistance`).
- اختبارات: `test/test-reporter-gha.test.js` (9: الهروب، `describeError`، `toFailure`، وضع GitHub بسقف الميزانية والعتبات
  وملخص الخطوة، الوضع العادي، صمود المُبلِّغ، تشغيل حقيقي لـ`node --test` بملفات مؤقتة أحمر/أخضر/منهار، وسلك الـworkflows)؛
  توسيع `test/service-reality.test.js`. الإجمالي 336.
- وثائق: CHANGELOG (بندان: المُبلِّغ + تشخيص ElevenLabs من PR #48)، `docs/preservation-plan.md` (صف ضابط جديد)، BACKLOG
  (QA-006 جديد، QA-005 محدث)، DECISIONS (DEC-032)، STATE، هذا السجل.

## الدليل

- محليًا: `npm run check` (116 ملفًا)، `node --test test/test-reporter-gha.test.js` 9/9 على Node 22.22.3 و24.22.1؛
  `GITHUB_ACTIONS=true npm run test:coverage:ci` على Node 22: 336/336 مع `::notice title=node --test::336 tests · 336 passed ·
  0 failed · coverage lines 85.84% · branches 71.87% · functions 84.11% (floor 80/65/78)` وجدول Step Summary؛ على Node 24:
  336/336 (85.72/71.81/83.83).
- تشغيل أحمر مُصطنع (ملف يفشل + ملف لا يُحمَّل + عتبات تغطية): كل فشل يحمل اسمه وملفه وسطره؛ العتبات تُسمّى؛ السطر الختامي
  يجمع الكل؛ `exit 1` من `node --test` نفسه.
- دليل CI: run `Celia quality & resilience` `40793725152` على `531b090` ✅ (7 وظائف)؛ قراءة annotations عبر
  `check-runs/<job>/annotations` بلا سجلات: Node 24 (`123184952053`) «336 tests · 336 passed · 0 failed · coverage lines
  85.65% · branches 71.75% · functions 83.83% (floor 80/65/78)»، Node 22 (`123184952077`) 336/336، 85.80/71.75/84.11.

## ما لم يُفعل ولماذا

- لم يُستنسخ التقلّب نفسه: 3 تشغيلات محلية تحت Node 24 خضراء؛ الهدف من هذه الجلسة أن يسمّي التقلّب القادم نفسه لا تخمينه.
- لا إعادة تشغيل للـruns الفاشلة (لا صلاحية، ولا فائدة بلا أسماء). الإصدار v0.2.1 لم يتأثر (5 أصول؛ الـworkflow idempotent
  ويُعاد مع أول دفعة إلى `main`).
- ElevenLabs بيد المالك: Settings → Secrets and variables → Actions → تبويب Secrets → Repository secrets → `CELIA_VOICE_ID` →
  `AnsOWV53Mdx5fcIanRBB` → Update secret؛ ثم «تم» → `[reality]`.
- لم يُفتح PR (الطلب كان «نفّذ» على الفرع؛ PR عند طلب صريح كما في #47/#48).

## الخطوة التالية بالضبط

1. (تم) قراءة annotations run الجودة على الفرع — `node --test` notice ظهر على ساقي Node 22/24. أي فشل مستقبلي يُقرأ من
   هناك مباشرة (`gh run view <id> --json jobs` ثم `check-runs/<job>/annotations`).
2. عند «تم» الصحيحة لـ`CELIA_VOICE_ID`: دفعة `[reality]` → 12/12 = 100% → QA-005 «متحقق» + `docs/service-reality.md` + README.
3. بنود المالك من خطة المحافظة §د كما هي (حماية الفرع بأسماء الفحوص، Watch، PRs #34/#38/#39، Dependabot).
