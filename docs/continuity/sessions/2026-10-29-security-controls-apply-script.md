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

## 6. متابعة — «تم» الثانية (2026-10-29، 03:47 UTC)

- بعد التقرير أرسل المالك الأوامر الأربعة نفسها ثم كلمة «تم». الوكيل أعاد `--verify` مرتين (بفاصل 75 ثانية) وقرأ الخام مباشرة:
  `rulesets` → 0، `rules/branches/main` → `[]`، `branches/main.protected` → `false`، `dependabot/alerts` → «Dependabot alerts are disabled»،
  لا `dynamic/github-code-scanning/codeql` بين 12 workflow. **أي: «تم» الثانية غير منعكسة في الواجهة أيضًا** — لم تُغيَّر أي حالة (DEC-045).
- تشغيل الأوامر من بيئة الوكيل بعد الطلب أعاد `forbidden ×5` بنص السبب؛ السبب المرجّح لعدم الانعكاس: الأوامر لم تُشغَّل من جهاز المالك
  بـ`gh auth login` بحسابه (أو شُغّلت وفشلت ولم يُقرأ ناتجها). طُلب من المالك ناتج `--verify` من جهازه أو لقطة Settings → Rules / Advanced Security.

## 7. مسار بلا طرفية + تثبيت الفحوص على GitHub Actions (إلحاق DEC-046)

- المالك أعاد لصق `gh auth status` / `--verify` مرة ثالثة بدل ناتجهما؛ تنفيذهما من بيئة الوكيل يعطي الهوية `celiaelazamey-arch (GH_TOKEN)`
  والقراءة نفسها (3 `NOT ENABLED`، 2 `UNKNOWN`). الاستنتاج العملي: المالك على الأرجح بلا طرفية (هاتف/متصفح) فبُني مسار لا يحتاجها.
- **`docs/github/ruleset-main-quality-gate.json`**: الـruleset بصيغة الاستيراد التي تقبلها GitHub (`name/target/source_type/enforcement/conditions/rules/bypass_actors`
  — الصيغة نفسها في `github/ruleset-recipes`)؛ يولّده `npm run -s security:posture -- --ruleset-json`، و**SPA-08** يُفشل CI إن اختلف بايتًا عن جسم `--apply`.
- **`integration_id: 15368`** على كل فحص مطلوب: قُرئ حيًّا من `GET /apps/github-actions` (id 15368) ومن check-runs آخر التزام (`360663d`) حيث
  التطبيق الوحيد المبلّغ عن السياقات الست هو `github-actions` — فلا يستطيع تطبيق آخر إرضاء البوابة. SPA-02 يثبته.
- الوثيقة §2: فقرة «المسار بلا طرفية» بالروابط المباشرة (`settings/rules`، `settings/security_analysis`) والبديل اليدوي إن فشل الاستيراد.
- البوابات: 572/572، تغطية 91.25/73.83/85.63؛ `check` 147؛ `check:secrets` ✅؛ `check:continuity` ✅. لم يُطبَّق شيء على GitHub (403 كما قبل)
  ولم تتغير أي حالة في §2.

## 8. الخاتمة — PR #77 مدمج بيد المالك

- سُئل المالك (خيارات): متصفح فقط / طرفية / فعّلتها فعلًا / «أجّل هذا — افتح PR». اختار الأخير → فُتح **PR #77** (`bc55cab`، فحوص الـPR خضراء)
  ثم **دمجه المالك بنفسه** 2026-10-29T03:58Z → **`main@8aa4a15507e4098ef2ce4b23ecad86ee035ff37a`** (الوكيل لم يدمج).
- تشغيلات `main` على `8aa4a15`: الجودة `40815077219` ✅ · الحافة `40815077156` ✅ · Pages `40815077161` ✅ · الإصدار `40815077164` ✅ ·
  Render `40815150451` ✅ · الإشعار `40815150464` ✅ · التدقيق متخطّى.
- `--verify` بعد الدمج (فرع `arena/b698a028-phone-google` من `8aa4a15`): **بلا تغيير** — Branch protection / Dependabot alerts / CodeQL
  `NOT ENABLED (2026-10-29)`، Secret scanning / Workflow permissions `UNKNOWN`. الدمج أوصل الأداة إلى `main`؛ لم يفعّل أي ضابط — ذلك فعل المالك
  وحده (مسار المتصفح في §7 / `docs/security-posture.md` §2).
