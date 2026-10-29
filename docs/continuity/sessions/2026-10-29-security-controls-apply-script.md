# جلسة 29 أكتوبر 2026 — سكربت تفعيل ضوابط المالك (DEC-046، SEC-006) وقراءة «الدستور/الشخصية» المرسلَين

**الفرع:** `arena/74ff3f8d-phone-google` (نظيف من `main@f223648` = دمج PR #76) · **المدخل:** رسالة المالك تحمل (أ) إعلان «بروتوكول شخصية ودستور»
و(ب) تحليلًا خارجيًا يقترح سكربت bash لتفعيل الضوابط الأربعة عبر `gh api` ويطلب من المالك تشغيله ثم قول «تم».

## 1. ما نُفِّذ

| البند | النتيجة |
| --- | --- |
| تجربة الاستدعاءات الخمسة برمز الوكيل | **403 ×5** «Resource not accessible by integration» (`gh api user` = `celiaelazamey-arch`، `viewerPermission: ADMIN`، لكن رمز تكامل بلا أذونات إدارة/أمان). لا تغيير حدث |
| تدقيق السكربت الخارجي | 3 عيوب قاطعة: `-f field=null` يرسل النص `"null"` (422)؛ check باسم `CI / build` غير موجود (كان سيقفل كل دمج)؛ `strict=true` يعطّل نمط PR-تلو-PR. تفاصيل في DEC-046 |
| البديل الحتمي | `scripts/security-posture-apply.mjs` (`--plan` / `--apply` / `--verify`) + `test/security-posture-apply.test.js` SPA-01..SPA-07 + `npm run security:posture` |
| `--verify` حيًّا (2026-10-29) | Branch protection **NOT ENABLED** (`rules/branches/main → []`، `protected: false`) · Dependabot alerts **NOT ENABLED** (نص الواجهة) · CodeQL **NOT ENABLED** (لا workflow ديناميكي) · Secret scanning **UNKNOWN** (403) · Workflow permissions **UNKNOWN** (403) — مطابق لقراءة DEC-045 |
| الوثائق | `docs/security-posture.md` §2 (الخطة، الفروق، تصحيح التوصية: لا linear history) و§4 (الأوامر)؛ DEC-046؛ STATE؛ BACKLOG SEC-006؛ CHANGELOG |

## 2. البوابات محليًا

- `GITHUB_ACTIONS=true npm run test:coverage:ci` → **571/571**، تغطية 91.25 / 73.82 / 85.62 (الأرضية 89/71/82)؛ `check` 147 ملفًا؛ `check:secrets` ✅؛
  `check:continuity` ✅. اختبار الطفرات: إعادة تسمية وظيفة `container` في `celia-mcp.yml` → SPA-01 يفشل (ثم أُعيدت).
- ملاحظة بيئة: الاستنساخ كان ضحلًا فسقط اختبار `secrets-hub` (خط الأساس `2508893b`)؛ `git fetch --unshallow` أصلحه — ليس عيبًا في الكود.

## 3. ما ينتظر المالك (الخطوة الوحيدة الحاسمة)

من جهازه حيث `gh auth status` يُظهر حسابه هو: `npm run security:posture -- --plan` ثم `-- --apply` ثم `-- --verify` (أو الاستدعاءات الخمسة
نفسها يدويًا كما يطبعها `--plan`). بعدها كلمة «تم» → يعيد الوكيل `--verify` ويحدّث §2 إلى `VERIFIED (تاريخ)` لما قُرئ إيجابيًا فقط.

## 4. «الدستور والشخصية» — ما لم يُفعل ولماذا

- النص المرسل إعلان مبادئ (الصدق، الإتقان، الأمانة، الوسطية، أدب الحوار) بصيغة «تم دمجه كشخصية للنظام». في هذا المستودع هذه المبادئ
  **مفروضة فعلًا كقيود قابلة للاختبار** لا كإعلان: لا واجهة بلا جوهر (DEC-030)، لا retry أعمى ولا إصلاح ذاتي (DEC-041)، الوضع الأمني
  كاختبارات (DEC-043)، القراءة قبل التصديق (DEC-045)، الفشل باسمه (`forbidden`/`api-rejected`)، وAGENTS.md.
- لم يُضف ملف «شخصية» أو «دستور» نصي: ملف إعلاني بلا أثر تنفيذي هو الـ«موكب» الذي يرفضه المالك نفسه (DEC-030). إن أراد المالك أن
  تحكم هذه الصياغة **سطح ردّ محدد** (مثلًا system prompt لردود WhatsApp في `src/ai-reply.js` / حافة `runtime.js`) فذلك تغيير سلوكي
  يحتاج طلبًا صريحًا وقرارًا مرقّمًا واختبارًا، لا نسخًا للنص.

## 5. ما لم يُفعل أيضًا (قصدًا)

- لا PR من هذا الفرع إلا بكلمة المالك؛ لا `curl | bash` (السطر المقترح placeholder وخطر)؛ لا تحديث لأي حالة إلى VERIFIED.
