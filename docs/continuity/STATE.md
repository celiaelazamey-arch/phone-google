# الحالة الحالية — ابدأ من هنا

> **تحديث 2026-10-28 (جلسة النشر الحي — `DEC-038`):** دُمج PR `#70` في `main` (`0ebf8cac86faaea67e6f969c273549b2f8b33220`)
> فانتشر محرك الحافة الكامل بلا فيزا تلقائيًا وتحقق حيًّا على الرابط العام في التشغيلة **`40719074394`**
> (`verify:live --mode edge` PASS، D1 بـ12 عبارة SQL، `durable: true`، 18/18 سرًا) مع Pages `40719074587` (12/12 مسارًا)
> والإصدار `40719074453` والجودة `40719074375`. المتبقي حصرًا لإجراء المالك: رابط استدعاء Google، وأسرار Meta الاختيارية.
> انظر [سجل جلسة النشر الحي](sessions/2026-10-28-live-edge-publication.md). ما يلي توثيق الجلسة السابقة كما كُتب، محفوظ بلا حذف.

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **«ابدا» → WP-1.3 رموز السمات (DEC-049) بعد دمج #81 (WP-1.2 → `main@5ea6fd8`)** — على الفرع
`arena/1003f0da-phone-google` (من `main@5ea6fd8`؛ **لا PR بعد — يُفتح بكلمة المالك**) ·
سجل الجلسة الحالي: [2026-10-29-wp-1-3-theme-tokens](sessions/2026-10-29-wp-1-3-theme-tokens.md) ·
سجل WP-1.2: [2026-10-29-wp-1-2-execution-trace](sessions/2026-10-29-wp-1-2-execution-trace.md) ·
سجل النقد والخطة وWP-1.1: [2026-10-29-architecture-critique-2026](sessions/2026-10-29-architecture-critique-2026.md) ·
سجل ضوابط المالك (DEC-046 مُرجَع): [2026-10-29-security-controls-apply-script](sessions/2026-10-29-security-controls-apply-script.md) ·
سجل «نفّذ الستة» (DEC-044 حيًّا، DEC-045): [2026-10-29-execute-six-deploy-fix-live](sessions/2026-10-29-execute-six-deploy-fix-live.md) ·
سجل دمج #74 وتشخيص الفشل: [2026-10-29-merge-74-and-edge-deploy-fix](sessions/2026-10-29-merge-74-and-edge-deploy-fix.md) ·
سجل SEC-006 + LEARN-001 (DEC-043): [2026-10-29-security-posture-and-video-record](sessions/2026-10-29-security-posture-and-video-record.md) ·
سجل OPS-007 (DEC-042): [2026-10-29-edge-cron-outbox](sessions/2026-10-29-edge-cron-outbox.md) ·
سجل QA-009 (DEC-041): [2026-10-29-qa-009-ci-failure-notify](sessions/2026-10-29-qa-009-ci-failure-notify.md) ·
سجل الـPRs المتعارضة (DEC-040): [2026-10-29-open-prs-reconciliation](sessions/2026-10-29-open-prs-reconciliation.md) ·
سجل النشر الحي (DEC-038): [2026-10-28-live-edge-publication](sessions/2026-10-28-live-edge-publication.md) ·
السجلات السابقة: [2026-10-28-ci-test-annotations](sessions/2026-10-28-ci-test-annotations.md) ·
[2026-10-28-executive-gap-closure](sessions/2026-10-28-executive-gap-closure.md) ·
الخطة التنفيذية الشاملة: [docs/executive-completion-plan.md](../executive-completion-plan.md) ·
سجل D1 السابق: [2026-10-28-edge-d1-sql-splitter-and-pr-hygiene](sessions/2026-10-28-edge-d1-sql-splitter-and-pr-hygiene.md) ·
الدليل: [docs/computer-permissions](../computer-permissions/README.md) · صفحة الكمبيوتر:
[docs/computer-use.md](../computer-use.md) · حوكمة المشكلات: [docs/issue-triage.md](../issue-triage.md) ·
واقع الخدمات: [docs/service-reality.md](../service-reality.md) · خطة المحافظة: [docs/preservation-plan.md](../preservation-plan.md)

## الطلب الحالي — نقد معماري بنّاء مقابل معايير وكلاء 2026 (وثيقة فقط)

- **ما وصل:** برومبت «لجنة مراجعة معمارية» بأربعة محاور (الحلقة، الذاكرة، الواجهة/الأثر، الزمن/التكلفة) وجدول «ضعف × معيار × توصية» وخارطة 3 خطوات.
- **ما فُعل:** [`docs/architecture-critique-2026.md`](../architecture-critique-2026.md) — 13 صفًا بدليل ملف/اختبار/قرار، تفصيل المحاور، خارطة طريق
  (1 قياس + أثر مرئي + سمات → 2 ذاكرة موصولة → 3 مخطط مزوّدي بإعادة تخطيط محكومة = AI-002)، «ما لا يجب فعله»، وقرارات المالك. بلا كود،
  بلا صفوف BACKLOG جديدة، بلا «مثل Manus». سجل الجلسة: [2026-10-29-architecture-critique-2026](sessions/2026-10-29-architecture-critique-2026.md).
- **«خطة تنفيذية» (الطلب التالي):** [`docs/agent-2026-execution-plan.md`](../agent-2026-execution-plan.md) — 12 حزمة عمل (WP-1.1…WP-3.4) بملفات واختبارات
  ومعايير قبول وبوابات G1/G2/G3 وجهد تقريبي (6/8/11 يوم عمل)، وقرارات المالك مع افتراض إن لم يُجب، وتعريف اكتمال لكل PR. صفوف BACKLOG جديدة
  بحالة «بانتظار اعتماد»: AGENT-008، AGENT-009، AGENT-010، UX-003، WA-006 (وتُستخدم AI-001/AI-002 القائمة للتقييم والمخطط المزوّدي).
  **لا تنفيذ قبل كلمة الاعتماد** (الاعتماد = قرار مرقّم جديد + تحويل الصفوف إلى «جارٍ»).
- **«اعتمد الخطة» → DEC-047 وWP-1.1 منفَّذة:** `src/agent/timing.js` + `durationMs` على استدعاءات الأدوات والخطوات + `durations` (p50/p95 لكل أداة ولكل تشغيل)
  في `GET /api/agent/metrics`؛ MET-01..05 (ساعة وهمية 7 ms)؛ 569/569. BACKLOG: AGENT-008 «جارٍ»، AGENT-009/010، UX-003، WA-006 «مخطط — معتمد».
  الافتراضات المطبّقة: السمة تتبع النظام؛ `CELIA_WA_CONTEXT` مطفأ؛ الخطوة 3 بانتظار اختيار المزوّد.
- **التالي:** WP-1.2 (شجرة الخطة + زمن/تكلفة لكل خطوة + سطر «الآن» في `/agent`) ثم WP-1.3 (سمات) وWP-1.4 (قياسات WhatsApp وD1) — كل حزمة PR بكلمة المالك.
- **«ادمج 79» → PR #79 MERGED** `8f850ce0b507d78cf839f0f68c54bb49836d2407` (2026-10-29T05:26:36Z، merge commit، الفرع لم يُحذف). تشغيلات `main` عليه **كلها خضراء**:
  الجودة `40823425680` ✅ · **الحافة `40823425686` ✅ (الرفع + التحقق الحي: `deployed`، `commit 8f850ce`، `liveReady`، `durable`، D1 130 ms، 18/18، الوحدات الخمس)** ·
  Pages `40823425679` ✅ · الإصدار `40823425694` ✅ · Render `40823516105` ✅ · الإشعار `40823516139` ✅ · التدقيق متخطّى. فشل التحقق الحي على الإرجاع
  `40815516801` **لم يتكرر** — سببه يبقى غير معروف (لم يُقرأ سجله)، ولا يُدّعى أنه عابر؛ الحالة الحية الآن = `8f850ce`.
  **على `main` الآن:** DEC-047، WP-1.1 (`timing.js`، `durations` في `/api/agent/metrics`)، النقد والخطة، سجل #77/#78.
  **معلّق من قبل:** هل إرجاع #77 كان مقصودًا؟ مزوّد التخطيط للخطوة 3.
- **«الخطوات الصحيحة التالية» → WP-1.2 منفَّذ (DEC-048)** على `arena/92148788-phone-google`: `deriveNow` + حدث `step` مُثرى + `toolRunStatus` (خادم)،
  `public/agent-trace.js` + شجرة/«الآن»/ميزانية في `/agent` (واجهة)، مسار `/agent-trace.js`، TRC-01..04 + e2e معترِض. البوابات محليًا: 574/574،
  تغطية 91.37/74.34/85.79، `check` 148، `check:secrets` ✅، `check:continuity` ✅. **CI على الفرع:** `40825780768` كشف عيبًا قائمًا (axe:
  `#steps` منطقة تمرير بلا لوحة مفاتيح) → أُصلح في `bc0d6c4` → **`40826250081` الوظائف الست ✅، Playwright 26/26**.
  **التالي:** WP-1.3 (سمات بالرموز) ∥ WP-1.4 (قياسات WhatsApp وD1)؛ فتح PR لهذا الفرع ودمجه بكلمة المالك.
  → **تم:** PR #81 فُتح على رسالة المنصة ودمجه المالك بنفسه → `main@5ea6fd8` (2026-10-29T06:07:07Z).
- **«ابدا» → WP-1.3 منفَّذ (DEC-049)** على `arena/1003f0da-phone-google`: `public/theme.css` (17 رمزًا × `dark`/`oled`/`light` + تتبع النظام بلا سمة
  + حركة مخفَّضة)، `public/theme.js` (قبل الرسم، مفتاح الاستوديو `celia_theme`، `window.celiaTheme`)، مبدّل مشترك في `/agent` و`/kb` و`/cron`،
  `agent.css`/`kb.css`/`cron.css` بلا لون ثابت (`color-mix` على الرموز)، مساران `/theme.css` و`/theme.js`. اختبارات: THM-01..06 (أدنى تباين مقيس 5.37:1؛
  قائمة «لم تُهاجَر بعد» تنكمش فقط) + وصف e2e رابع (تتبع النظام، axe لكل سمة بمحتوى تشغيل، بقاء الاختيار، `0.12s`→`0s`). البوابات محليًا: 580/580،
  تغطية 91.38/74.35/85.87، `check` 150، `check:secrets` ✅. **CI على الفرع:** انظر سجل الجلسة §5 (يُسجَّل بعد الدفع).
  **التالي:** WP-1.4 (عدّاد `reply_truncated` + سلسلة زمن D1 في `verify:live`) على فرع جديد بعد PR/دمج هذا الفرع بكلمة المالك.

## الطلب السابق — سكربت خارجي لتفعيل ضوابط الأمان + إعلان «دستور/شخصية» (DEC-046، SEC-006) — **دُمج (PR #77 → `main@8aa4a15`) ثم أُرجع (PR #78 → `main@17862f2`) بيد المالك**

- **ما وصل:** تحليل خارجي يقترح سكربت bash (`gh api`) يفعّل Branch protection / Dependabot / CodeQL / Secret scanning ويطلب من المالك تشغيله.
- **ما فُعل:** (1) جرّب الوكيل الاستدعاءات الخمسة بنفسه → **403 ×5** (رمز تكامل بهوية المالك بلا صلاحية إدارة) — لا تغيير حدث؛
  (2) السكربت الخارجي فيه عيوب قاطعة (`"null"` نصًا → 422؛ check `CI / build` غير موجود → يقفل كل دمج؛ `strict=true`) فلم يُمرَّر؛
  (3) بُني البديل الحتمي **`scripts/security-posture-apply.mjs`** (`--plan` / `--apply` / `--verify`) باختبارات SPA-01..SPA-07 —
  ruleset بأسماء وظائف الجودة الست الحقيقية (SPA-01 يثبت مطابقتها للـworkflow)، بلا مراجعات، بلا linear history (merge commits)،
  بلا bypass، `strict=false`؛ ثم Dependabot alerts + security updates، CodeQL الافتراضي، Secret scanning + Push protection؛
  (4) `--verify` حيًّا يطابق DEC-045: ثلاثة `NOT ENABLED (2026-10-29)` واثنان `UNKNOWN`. 571/571 محليًا.
- **«الدستور/الشخصية»:** لم يُضف كملف إعلاني (موكب بمقياس DEC-030)؛ المبادئ مفروضة أصلًا كقيود مختبَرة (DEC-030/041/043/045). إن أراد
  المالك حَكْم سطح ردّ محدد (system prompt لردود WhatsApp) فبطلب صريح وقرار مرقّم (سجل الجلسة §4).
- **بانتظار المالك:** (أ) من جهازه: `npm run security:posture -- --apply` ثم `-- --verify` (بعد `gh auth status` بحسابه) ثم «تم» → يعيد الوكيل
  القراءة ويحدّث §2 بتاريخ؛ (ب) كلمة فتح PR لهذا الفرع («افتح PR») ثم «ادمج».
- **«تم» الثانية (2026-10-29 03:47 UTC) غير منعكسة:** `--verify` ×2 + القراءة الخام (`rulesets` 0، `protected:false`، Dependabot معطّل، لا CodeQL)
  — لا تغيير في أي حالة؛ لا `VERIFIED`. المطلوب: ناتج `--verify` من جهاز المالك (بعد `gh auth status` بحسابه) أو لقطة الإعدادات (سجل الجلسة §6).
- **مسار بلا طرفية (أُضيف لأن المالك يلصق الأوامر بدل ناتجها):** `docs/github/ruleset-main-quality-gate.json` → Settings → Rules → New ruleset ▾ →
  **Import a ruleset** → Create؛ ثم `settings/security_analysis` → Enable ×5. SPA-08 يُبقي الملف مطابقًا لجسم `--apply`؛ الفحوص مثبّتة على
  GitHub Actions (`integration_id` 15368). 572/572.
- **PR #77 → MERGED** `8aa4a15507e4098ef2ce4b23ecad86ee035ff37a` — فُتح بكلمة المالك («أجّل هذا — افتح PR») ودمجه **المالك بنفسه** 2026-10-29T03:58Z
  (3 التزامات: `360663d`، `d3a6433`، `bc55cab`). تشغيلات `main` عليه كلها خضراء: الجودة `40815077219` ✅ · الحافة `40815077156` ✅ · Pages
  `40815077161` ✅ · الإصدار `40815077164` ✅ · Render `40815150451` ✅ · الإشعار `40815150464` ✅ · التدقيق `40815077125` متخطّى (كالمعتاد).
- **`--verify` بعد الدمج (من الفرع الجديد):** لم يتغير شيء — 3 `NOT ENABLED (2026-10-29)`، 2 `UNKNOWN`. **التفعيل ما زال بند المالك الوحيد:**
  استيراد `docs/github/ruleset-main-quality-gate.json` (Settings → Rules → New ruleset ▾ → Import a ruleset) + Enable ×5 في
  `settings/security_analysis`، ثم «تم» → تُعاد القراءة ويُحدَّث §2 بتاريخ لما قُرئ إيجابيًا فقط.
- **⚠ الإرجاع (2026-10-29T04:02:51Z):** بعد 5 دقائق من الدمج أنشأ المالك **PR #78** («Revert #77»، بلا سبب مكتوب) ودمجه → **`main@17862f2a879af09398e59774f4baa741a996fc37`**.
  أثره على `main`: حُذف `scripts/security-posture-apply.mjs` و`test/security-posture-apply.test.js` و`docs/github/ruleset-main-quality-gate.json`
  وسطر `security:posture` من `package.json`، وعادت `docs/security-posture.md` وDEC-046 وCHANGELOG وهذا الملف وBACKLOG إلى ما قبل #77 (10 ملفات، −722 سطرًا).
  **الوكيل لم يُرجع شيئًا ولم يعترض؛ سبب الإرجاع غير معروف — سؤال مفتوح للمالك.** التنفيذ محفوظ في تاريخ الفرع (`360663d`، `d3a6433`، `bc55cab`)
  ويمكن إعادته بـcherry-pick في PR جديد بكلمة المالك.
- **تشغيلات `main` على الإرجاع `17862f2`:** الجودة `40815516844` ✅ · Pages `40815516967` ✅ · الإصدار `40815516872` ✅ · Render `40815613170` ✅ ·
  الإشعار `40815613140` ✅ · **نشر الحافة `40815516801` ❌** — خطوة الرفع نجحت (`status: deployed`، `commit: 17862f2`، `durable: true`، 18/18 سرًا،
  الوحدات الخمس) لكن خطوة **التحقق الحي** (`verify:live --mode edge`) خرجت بـ1 خلال ثانية واحدة؛ سجل الخطوة وتقرير القبول (artifact على
  Azure blob) غير قابلين للقراءة من بيئة الوكيل، فالسبب **غير معروف** — لا يُدّعى أنه عابر. المرشّحون: `edge_auth_gate` / `edge_mcp_tools` /
  `edge_cron_governed` (الأخير يعتمد على cron-job.org). الإرجاع لم يمسّ `workers/` ولا `src/` (الكود الحي = كود `8aa4a15` الذي نجح تحققه
  `40815077156` قبل 5 دقائق). إعادة التشغيل: المالك («Re-run failed jobs» على `40815516801`) أو تلقائيًا مع الدفع التالي إلى `main` (مثلًا دمج #79).
- **الحالة الآن (الفرع الحالي يحوي `main@17862f2`):** `npm run security:posture` **غير موجود على `main`**؛ ضوابط GitHub كما كانت (3 `NOT ENABLED`،
  2 `UNKNOWN`)؛ مسار المتصفح لا يزال ممكنًا يدويًا من خطوات `docs/security-posture.md` §2 (نسخة ما قبل #77) لكن بلا ملف استيراد على `main`.

## الطلب السابق — «نفّذ الستة» (DEC-044 حيًّا، DEC-045، OPS-007، SEC-006) — **منجز ومدمج (PR #75 → `main@8ce7ded`، PR #76 → `main@f223648`)**

- **1 ✓ النقل:** الفرع السابق قُفل (`pr_merged`) فنُقل الإصلاح إلى `arena/2f11f424-phone-google` بـcherry-pick (`ea078f4` كود، `ebef990`/`3bdc6f4`
  وثائق) — الشجرة مطابقة بايتًا لما كان مدفوعًا؛ 564/564 محليًا.
- **5 ✓ ضوابط المالك — قراءة قبل التصديق (DEC-045):** الواجهة تقول إن `main` **غير محمي** (`protected: false`، لا rulesets)، و**Dependabot
  alerts معطّلة** (نص الرسالة)، و**لا CodeQL** (لا workflow ديناميكي)؛ Secret scanning وWorkflow permissions 403. لذلك لا `VERIFIED`؛
  سُجِّلت `NOT ENABLED (2026-10-29)` حيث القراءة سلبية و`UNKNOWN` حيث لا قراءة، وSP-12 يقبل الحالة الثالثة ويرفض الادعاء بلا تاريخ.
  **مطلوب من المالك:** تنفيذ خطوات §2 في `docs/security-posture.md` ثم «تم» بالاسم.
- **2 ✓ PR #75 → MERGED** `main@8ce7ded1995693f60b509aaf20a81a6b881d5b14` (2026-10-29T03:18Z؛ CI الـPR `40811207864` ✅).
- **3 ✓ النشر حيّ:** `Deploy (Cloudflare Edge)` run **`40811383082`** ✅ — `status: deployed`، **`modules: [state.js, crypto.js, runtime.js, cron.js, worker.js]`**،
  `storage.durable: true`، 18/18 سرًا، 14 عبارة هجرة (تشمل `0003_cron_outbox`)، وخطوة التحقق الحي (`verify:live --mode edge` بالرمز، تشمل
  `edge_cron_governed`) خضراء. بقية تشغيلات `main`: الجودة `40811383198` ✅، الإصدار `40811383079` ✅، Pages `40811383057` ✅، Render `40811478017` ✅.
  **DEC-042 حيّ الآن** على `https://celia-phone-google.celiaelazamey.workers.dev`؛ OPS-007 → «متحقق».
- **4 ✓ #38 CLOSED** بتعليق يحيل إلى OPS-007/DEC-042 وDEC-040 (الفرع لم يُحذف). **لا PR مفتوح في المستودع.**
- **6 ✓ الوثائق:** هذا الملف، BACKLOG (OPS-007 متحقق، OPS-006 مكتمل، SEC-006 قراءة DEC-045)، CHANGELOG، `docs/deployment-profile.json → edgeFullRuntime.latestDeploy`،
  سجل الجلسة. وثائق ما بعد الدمج في **PR #76** (وثائق فقط، تحت التفويض نفسه).
- **المتبقي للمالك (بحكم طبيعته):** تفعيل ضوابط GitHub (خطوات `docs/security-posture.md` §2) ثم «تم» بالاسم؛ التجربة التفاعلية للوحة `/cron.html`
  برمز المالك؛ رابط استدعاء Google (GOOG-001)؛ أسرار Meta الاختيارية؛ Aiven/Render المقيّدان بالبطاقة؛ AI-002/GOV-001.

## الطلب السابق (0) — «ادمج #74» → مدمج؛ نشر الحافة رُفض (`cron.js` خارج حزمة الرفع) → الإصلاح نُقل إلى الفرع الجديد (DEC-044، OPS-007)

- **ما نُفِّذ بالكلمة:** `gh pr merge 74 --merge` → **MERGED** `2026-10-29T02:53Z`، التزام الدمج **`c3cc9ba7247ac4c1211f2ef0b3871dfc3a2b0564`**؛
  الفرع لم يُحذف؛ #38 ما زال مفتوحًا. على `main` الآن: OPS-007/DEC-042 + SEC-006/DEC-043 + LEARN-001.
- **تشغيلات `main` على `c3cc9ba`:** الجودة `40809007948` ✅ · الإصدار `40809008009` ✅ · Pages `40809007925` ✅ · Render `40809107628` ✅ ·
  الإشعار `40809107697` ✅ · التدقيق `40809007880` متخطّى (كالسابق) · **نشر الحافة `40809007805` ❌**.
- **الحادثة (من تعليق التشغيلة):** Cloudflare رفضت الرفع `400/10021` «No such module "cron.js" imported from "worker.js"» — سكربت النشر
  كان يرفع قائمة وحدات يدوية (`worker/state/crypto/runtime`) وأُضيف `cron.js` في OPS-007 دونها (خطأ مني بلا اختبار حارس).
  **الأثر الحي:** الرفع المرفوض لا يستبدل الإصدار العامل → إصدار `main@4f6af77` ما زال حيًّا (استنتاج من دلالات Cloudflare ومن فشل
  `--expect-commit`؛ لا استدعاء مباشر لـ`workers.dev` من بيئة التنفيذ). هجرة `0003` طُبِّقت قبل الرفع على الأرجح (بلا ضرر).
  **لا شيء من DEC-042 حيّ بعد.**
- **الإصلاح (الالتزام `8e3641b` على الفرع):** `collectWorkerModules()` يشتق حزمة الرفع من رسم الاستيراد (كل وحدة يستوردها `worker.js`
  تنتقل معه؛ وحدة مفقودة تُفشل النشر محليًا)؛ الرفض `::error` + خروج `1` بدل `::notice` أخضر؛ `verify:live --mode edge` يكتسب
  `edge_cron_governed` (`/api/cron/status` برمز المالك → `outbox-approval-only`, `durable=true`, `DEC-042`, عدّادات outbox = الجدول
  `0003` موجود). الدليل محليًا: **564/564**، تغطية 91.21/73.72/85.46، `check` 145، `check:secrets` ✅، `--dry-run` يطبع
  `modules: [state, crypto, runtime, cron, worker]`؛ CI الدفع على الفرع (`e3d14e1`): run **`40809989577`** ✅ 6/6.
- **بانتظار المالك:** كلمة فتح PR للإصلاح ثم «ادمج»؛ بعدها تشغيلة `cloudflare-deploy.yml` خضراء (`status: deployed`، `modules` تتضمن
  `cron.js`، `edge_cron_governed: pass`) = تحويل OPS-007 إلى «متحقق». كذلك: قرار #38؛ «تم» لضوابط الإعدادات.

## الطلب السابق (1) — «الاثنان معًا»: اختبار الوضع الأمني + تصحيح سجل الفيديو (DEC-043، SEC-006، LEARN-001) — **مدمج في `main@c3cc9ba`**

- **ما طُلب:** بعد تحليل خارجي عرضه المالك (أربعة مسارات دفاع، جسر «استدلال عميق» وهمي، محرك «تطور ذاتي»، قاموس 17 مصطلحًا
  منسوبًا للفيديو) ومطابقته بالمستودع، اختار المالك تنفيذ البندين الحقيقيين: (أ) تثبيت الوضع الأمني المحقَّق كاختبارات؛ (ب) إكمال
  سجل `yt-Cb3mBAH0IaY` وعدم نسب أي مصطلح لم يرد في نصه. الجسر ومحرك التطور الذاتي **لم يُبنَيا** (DEC-030/DEC-041).
- **ما نُفِّذ (أ):** `test/security-posture.test.js` SP-01..SP-12 (أذونات workflows، `contents: write` في النشر وحده، لا
  `pull_request_target`، SHA-pinning لكل `uses:`، `npm audit`، Dependabot، `.env` خارج Git، `check:secrets` على كل فرع، صفر تنفيذ
  ديناميكي في `src/`+`workers/`، حارس SSRF 21 مضيفًا، `edge_audit` إلحاق فقط، وثيقة الوضع لا تعلن ضابط مالك إلا UNKNOWN/VERIFIED
  بتاريخ) + `docs/security-posture.md` (المسارات → الدليل → الاختبار؛ owner-only بخطوات؛ ما ليس مُنفَّذًا؛ كيف يُكسر الوضع).
- **ما نُفِّذ (ب):** حدّ المرور الأول كان حدّ قطعة القارئ لا حدّ الفيديو؛ المرور الثاني أعاد النص **كاملًا** (481 سطرًا، القطعة الأولى
  مطابقة بايتًا ببايت `c7747dbc…`)، 29 مقطعًا، +11 وحدة `T1` (المجموع 20)، `EXTRACTION=FULL · COMPREHENSION=VERIFIED` (بوابة حتمية)،
  والمواضيع المعلنة بلا مقطع (NLP/CV/الروبوتات/قسم التطبيقات) UNKNOWN. المصطلحات الـ17 في القاموس الخارجي كلها واردة فعلًا الآن.
- **الدليل محليًا:** 561/561 (12 SP جديدة)، تغطية 91.19/73.57/85.42، `check` 145 ملفًا، `check:secrets` ✅، `kb -- verify` 20 صفًا
  0 مرفوض، `learn-source --check` drift `[]`. CI الدفع (`fb463c0`): run **`40808265240`** ✅ 6/6 (التفاصيل في سجل الجلسة §5).
- **PR #74** (`arena/90163669-phone-google` → `main`؛ 32 ملفًا، +2687/−220) حمل OPS-007 + SEC-006 + LEARN-001 — **دُمج** بكلمة «ادمج #74»
  في `main@c3cc9ba` (انظر «الطلب الحالي»).
- **بانتظار المالك:** قرار #38؛ تأكيد ضوابط الإعدادات
  (Branch protection / Dependabot alerts / Secret scanning / CodeQL) بكلمة «تم» لتُحدَّث إلى VERIFIED بتاريخ.

## الطلب السابق (2) — «إعادة فكرة لوحة cron كمهمة جديدة داخل `workers/celia-edge` عبر outbox» (DEC-042، OPS-007) — **مدمج؛ النشر ينتظر إصلاح DEC-044**

- **ما طُلب:** الخيار (3) من DEC-040: فكرة PR #38 (لوحة المهام المجدولة على cron-job.org) تُعاد داخل العامل الواحد بالمفتاح
  الموجود `CELIAOS_CRONJOB_ORG_API_KEY` ورمز المالك؛ قراءة أولًا، وكل كتابة خارجية عبر outbox وموافقة (DEC-015) — بلا عامل ثانٍ ولا
  أسرار جديدة ولا متجر محاكاة ولا واجهة زائفة.
- **ما وُجد:** `worker.js` كان أصلًا يوكّل `api.cron-job.org` قراءةً **وكتابةً مباشرة** (`POST→PUT`, `PATCH`, `DELETE`) بعد حارس SSRF —
  أي أن فجوة DEC-015 كانت في الحافة نفسها.
- **ما نُفِّذ:** `workers/celia-edge/cron.js` + هجرة `0003_cron_outbox.sql` (`edge_cron_outbox`) + مسارات `/api/cron/intents*`؛
  القراءة مُنقّاة (لا `auth`/قيم ترويسات/سلاسل استعلام/أجسام استجابات)؛ الكتابة نيّة بـ`Idempotency-Key` → موافقة بـ`expectedHash`
  → ادعاء مشروط → إرسال مرة واحدة → `applied|failed|unknown`؛ `unknown` يخرج بتسوية المالك فقط؛ كل انتقال على `edge_audit`؛
  المسارات القديمة تردّ 202 بنيّة؛ `/api/cron/status` يعلن `configured/durable/writes/outbox` بصدق (503 بلا D1 أو بلا مفتاح).
  لوحة `public/cron.html` (`/cron`) تتحدث مع أصل الحافة مباشرة (CSP Express تسمح به عبر `resolveEdgeOrigin`).
- **الدليل محليًا:** 549/549 (`test/edge-cron-outbox.test.js` 8/8 بهجرات حقيقية على SQLite، `test/cron-page.test.js` 4/4)، تغطية
  91.17/73.39/85.42 (الأرضية 89/71/82)، `check` 144 ملفًا، `check:secrets` ✅. CI الدفع على الفرع (`673d6a9`): run **`40805521838`** ✅ (6/6 وظائف، التفاصيل في سجل الجلسة §4).
- **القيد المعلن:** لا دليل حيّ قبل دمج `main` وتشغيلة `cloudflare-deploy.yml` (تطبّق `0003` تلقائيًا) ثم `GET /api/cron/status` →
  `durable: true, writes: outbox-approval-only`. لا PR مفتوح لهذا الفرع إلا بكلمة المالك («افتح PR»)؛ #38 ما زال مفتوحًا حتى «أغلق #38».
- **بانتظار المالك:** ~~«افتح PR» ثم «ادمج»~~ (تمّا: PR #74 → `main@c3cc9ba`)؛ **النشر الحي فشل** (`40809007805`، `cron.js` خارج حزمة
  الرفع — DEC-044) والإصلاح ينتظر PR و«ادمج»؛ قرار #38؛ بعد نشر أخضر: تجربة حية — اتصال من `/cron.html` على Pages برمز المالك،
  قراءة المهام، نيّة تعطيل/تفعيل مهمة keep-alive ثم موافقتها ومراجعة `edge_audit`.

## الطلب السابق — «نعم» على QA-009 ومصفوفة المخاطر (DEC-041) — مدموج (PR #73 → `main@4f6af77`)

- **ما طُلب:** بعد مقترح خارجي بـ«وكيل إصلاح ذاتي مستقل» ومصفوفة مخاطر بأربعة أركان، أرفق المالك سكربت `qa_alert.js` ووثيقة
  مصفوفة وقال «نعم». نُفِّذ الاثنان **بالشكل المتوافق مع النظام**: السكربت المرفق لم يُعتمد (يقرأ ملف سجل لا يكتبه شيء، لا يسمّي
  الاختبار — «موكب» بمقياس DEC-030)؛ والوثيقة كُتبت مصحَّحة بإحالات.
- **ما نُفِّذ:** `scripts/ci-failure-notify.mjs` + `.github/workflows/quality-failure-notify.yml` (`workflow_run` بعد «Celia quality &
  resilience» على `main`، push فقط): أحمر → **issue واحدة** `ci-failure` تسمّي كل اختبار فاشل (ملف:سطر، وظيفة، رأس خطأ مُعقَّم،
  تغطية، ملخص، أمر إعادة الإنتاج)، تعليق واحد لكل تشغيلة، معرّف التشغيلة لا يُسجَّل مرتين؛ أخضر → تعليق وإغلاق؛ PR/فرع آخر/ملغاة/
  متجاوَزة → تخطٍّ. صلاحيات `contents/actions/checks: read` + `issues: write` فقط؛ `GITHUB_TOKEN` فقط؛ لا retry/رقعة/rollback/دمج.
  `docs/ci-failure-notify.md` و`docs/agent-risk-matrix.md`؛ `npm run ci:notify`.
- **الدليل:** CI على الفرع (`ae0dd98`) run **`40802365022`** ✅ (Node 24 `123213195228`: 537/537، تغطية 90.81/72.78/85.02)؛ محليًا 537/537؛
  `test/ci-failure-notify.test.js` 17/17؛ قراءات حية بلا كتابة: `40797023396` → green، `40673613296` → red
  بوظيفة صامتة (قبل DEC-039)، `40687283608` → متجاوَزة، `40798428314` → ليست `main`. التفاصيل في سجل الجلسة §3.
- **القيد المعلن:** `workflow_run` يعمل من الفرع الافتراضي فقط → QA-009 «بانتظار الدمج»؛ أول تشغيلة Quality مكتملة على `main` بعد
  الدمج هي الدليل الحي (حتى الخضراء تطبع `nothing to do`).
- **دُمج PR #73** بأمر المالك («ادمج #73») في 2026-10-29T01:54:01Z → **`main@4f6af77`** (يحمل DEC-038 المعاد + DEC-040 + DEC-041). الفرع لم يُحذف
  (الجلسة مربوطة به). **#71 صار MERGED تلقائيًا** (رأسه ضمن `main` عبر `0366942`) — لا إغلاق يدوي. بعد الدمج على `main`: Quality
  `40803168857` ✅، Release `40803168705` ✅، Pages `40803168884` ✅، Edge `40803168839` ✅، Render `40803254362` ✅، و**أول تشغيلة حية
  لـQA-009: `40803254356`** (`workflow_run`) → `green run 40803168857 — nothing to do (no open tracking issue)`؛ لا issue أُنشئت. QA-009 **متحقق**.
- **بانتظار المالك:** قرار **#38** وحده (DEC-040 يوصي بالإغلاق — بكلمة «أغلق #38»)؛ تحديث التوثيق هذا (ما بعد الدمج) يعيش على الفرع
  حتى يُفتح له PR بكلمة المالك؛ طبقة «يقترح» (رقعة + PR عبر بوابة الموافقة) بعد قرار AI-002/GOV-001.

## الطلب السابق — «السبب والحل بما يتوافق مع نظامي دون تعارض: PR #71 و#38 مفتوحان» (DEC-040، OPS-006)

- **السبب:** #71 (`DEC-038`) متفرع من `0ebf8ca` وتعارض مع دمج PR #72 في النقاط الساخنة الثلاث فقط (رأس STATE، أول CHANGELOG، ذيل
  DECISIONS) — محتواه صحيح وما زال صحيحًا على `c7723be` (Edge run `40797023547`: `liveReady`, `durable`, 18/18). #38 متفرع من
  `4d4eb85` (99 commit خلف `main`)، معرّفاته DEC-016/017/018 مستهلكة، وبنيته (Worker ثانٍ بأسرار مستقلة، أفعال خارجية بلا outbox،
  متجر محاكاة) تخالف DEC-037/DEC-015/DEC-030.
- **الحل المنفذ:** محتوى #71 أُعيد إنشاؤه كاملًا فوق `main` في هذا الفرع بمعرّفه `DEC-038` (الملفات الثمانية + ملحق بدليل `c7723be`)؛
  من #38 استُبقيت فكرته المتوافقة الوحيدة: مُبلِّغ Playwright `github` في Actions (`playwright.config.js`) ضمن DEC-039.
- **بانتظار المالك:** «افتح PR» لهذا الفرع ثم دمجه ثم إغلاق #71؛ وقرار #38: «أغلق #38» (التوصية في DEC-040) أو إعادته مهمة جديدة
  داخل `workers/celia-edge` عبر outbox.
- **التحقق محليًا:** 520/520، تغطية 90.84/72.76/85.15، `check` 139 ملفًا، `check:continuity` 50 وثيقة. CI على الفرع (`0366942`): run `Celia quality & resilience` **`40798428314`** ✅ كله — Node 24 (`123200418839`) 520/520، Node 22 (`123200419068`)، RTL dashboard مع مُبلِّغ Playwright `github` (`123200418899`) ✅.

## الطلب السابق — «نفّذ»: مُبلِّغ annotations لاختبارات CI (DEC-039، QA-008) — مدموج في PR #72 → `main@c7723be`

- **لماذا:** فشلان أعميان في يوم واحد على commits خضراء في كل مكان آخر — ساق Node 24 في run `40662071493` ثم
  `Publish verified release` run `40665130469` على `main@fc4d60f`؛ الـannotation الوحيدة «exit code 1»، والسجلات لا تُقرأ من هنا.
  (لاحقًا كشف PR #49 أن الثاني كان خطأ تعادل طوابع زمنية حقيقيًا في `test/knowledge-ingest.test.js:164` — وهو بالضبط ما كان
  هذا المُبلِّغ سيسمّيه من أول run.)
- **ما نُفِّذ:** `scripts/test-reporter-gha.mjs` (مُبلِّغ ثانٍ إلى جانب `spec`: `::error title=<اسم الاختبار>` بالملف والسطر
  والرسالة لكل فشل، `::error` لكل عتبة تغطية، سطر ختامي بالأعداد والتغطية وكل الفاشلين — سقف GitHub 10 annotations/خطوة —
  وجدول Step Summary؛ نص عادي خارج Actions؛ لا يُسقط التشغيل)؛ `npm run test:ci` / `test:coverage:ci` في `celia-mcp.yml`
  و`release.yml` (البوابة 3/4) و`pages.yml`؛ اختبار يمنع العودة إلى `npm test` أعمى؛ تدقيق الواقع يضيف `failing` إلى annotation
  الحزمة offline. `test/test-reporter-gha.test.js` (9).
- **الدليل قبل الدمج مع main:** run `Celia quality & resilience` **`40793725152`** على `531b090` ✅ كله؛ annotations مقروءة عبر
  API بلا سجلات: Node 24 (`123184952053`) «336 tests · 336 passed · 0 failed · coverage lines 85.65% · branches 71.75% ·
  functions 83.83%»، Node 22 (`123184952077`) 336/336.
- **الدمج مع `main@0ebf8ca` (PR #70):** تعارضات في workflows/package.json/الوثائق حُلّت بأخذ نسخة `main` وإعادة سلك المُبلِّغ فوقها؛
  أرضية التغطية الحالية 89/71/82 (REL-002/QA-006 على main) لم تُمَس. **إعادة ترقيم:** DEC-032 → **DEC-039** (DEC-032 صار
  WhatsApp على main وDEC-038 محجوز لـPR #71 المفتوح)، QA-006 → **QA-008** (QA-006/QA-007 مستعملان على main).
- **الدليل بعد الدمج (رأس PR #72 = `2ac0911`):** run `Celia quality & resilience` **`40796383857`** ✅ (7 وظائف) + run الدفع
  `40796379598` ✅؛ annotations: Node 24 (`123193748389`) «520 tests · 520 passed · 0 failed · coverage lines 90.76% · branches
  72.71% · functions 84.95% (floor 89/71/82)»، Node 22 (`123193748330`) 520/520، 90.80/72.65/85.15. PR #72 `MERGEABLE/CLEAN`.
- **PR #72** فتحه المالك من الواجهة بقالب فارغ؛ مُلئ بالوقائع. الدمج بتفويض صريح فقط.

## الطلب السابق — «خطة تنفيذية لإكمال البنود الناقصة وسد الفجوات والثغرات والتنفيذ الشامل» (DEC-036، DEC-037، مدموج في PR #70 → `main@0ebf8ca`)

### 1. إثبات خط الأساس الحي على `main@44532f4` بعد دمج PR `#69`

- **Cloudflare Edge + D1 (`40706047781`):** `status: "deployed"`، `liveReady: true`، `18/18` سرًّا، إنشاء وترحيل وربط القاعدة `celia-edge-state` (`f63ccd9f-49b1-4eca-861b-fd478c433518`، `4` عبارات SQL نظيفة)، وإثبات حي من `/readyz`: `storage: { mode: "d1", durable: true, latencyMs: 106 }`.
- **GitHub Pages (`40706047514`) والإصدار (`40706047877`) والجودة (`40706047968`):** كلها خضراء على `main@44532f4`.
- **واقع الخدمات الحية (`40680228320`):** `verdict: pass`، **12/12 خدمة متحققة = 100%** (`workingRate: 1`, `failed: []`) شاملة توليف ElevenLabs الصوتي الفعلي وFigma وGemini وCloudflare وGoogle OAuth client.

### 2. الثغرات والفجوات البرمجية والأمنية التي أُغلقت في `arena/83dde20a-phone-google` (`DEC-036`)

1. **تدوير مفاتيح تشفير رموز OAuth (`SEC-005` — `src/security.js`, `src/{config,google,celia-mcp,celia-ui}.js`):** دعم حلقة مفاتيح مسمّاة `parseEncryptionKeyring` والمغلف المختوم بـAAD (`v2.<keyId>.<iv>.<tag>.<ciphertext>`) مع بقاء `v1.*` متوافقًا بالكامل ودالة `rotateEncryptedJson` دون كسر العقود القائمة.
2. **تحصين حارس SSRF الشامل (`SEC-003` — `src/ai-providers.js`, `workers/celia-edge/worker.js`):** حجب جميع عناوين IPv4/IPv6 الخاصة والمحلية وCGNAT وmetadata وعناوين `::ffff:` المدمجة، وتطبيقه كذلك على أهداف مهام الحافة في `validateCronJobPayload` (`422`).
3. **تحصين خادم الحافة ومركز الأسرار (`SEC-001`, `SEC-002`, `OPS-005`):** مقارنة رمز المالك بزمن ثابت آمن للطول عبر `SHA-256`، فرض حد `8 KiB` على أجسام JSON (`413`)، `405` مع `Allow`، فصل `/health` عن `/readyz`، ترويسات أمنية صارمة، دعم أصليْ CORS (`celiaelazamey-arch.github.io` + `localhost:3000`)، وإضافة `wiredInEdgeOrReadinessNames` في `src/secrets-hub.js` وإبراز `storage.mode`/`durable` في `scripts/service-reality.mjs`.
4. **سد فجوة التوجيه وفحوص الصفحات والوثائق (`DOC-002`, `QA-005`, `QA-006`, `PLAN-001`):** ربط مسارات `/computer` و`/computer.html` و`/computer-permissions` و`/computer-permissions.html` و`/computer.css` في `src/celia-ui.js`، ورفع فحص `pages.yml` إلى `12/12` مسارًا حيًا، وتحديث `docs/{deployment-profile.json,service-reality.md,plan-100-percent.md,preservation-plan.md}` و`README.md` وإصدار [docs/executive-completion-plan.md](../executive-completion-plan.md)، مع إضافة `test/security-surface-audit.test.js` وتوسيع اختبارات الحافة والكمبيوتر ومخزن المعرفة.
5. **مزامنة الموصلات الـ11 المتصلة بنطاق خاص للمالك وصفر أسرار:** توثيق وتتبع الخطة التنفيذية عبر مشروع `Linear` (`55a2e8fd-c1fe-4253-9485-efc0b76cc95e` ومهام `CEL-5`..`CEL-11` على فريق `CEL`)، ومجلد `Google Drive` الخاص (`1ZhVmTDGam2i_EixiwI0bGPxbJ4gShOPo` شاملاً مستند `Google Docs` `1HEv5hkdaYfGu8akZkR3fFcyis3sJrstF2jwiikQE0PA` وجدول `Google Sheets` `18cXH45gVKC8QALyvHRAFddW_0EoZXY7gaSXts4yeNhw` وعرض `Google Slides` `1MLHKJx0Ukr3DB5jn6dmNUpkQ4_Hv__atDEjnbwRzios` من 5 شرائح)، ونسخة `Dropbox` (`/CeliaOS-Executive-Plan-2026/executive-completion-plan.md`)، مع التحقق القرائي من `Google Calendar` (`timezone: UTC`) و`Gmail` (`celiaelazamey@gmail.com` دون إرسال أي بريد) و`Supabase` (`yqzhgogmtscoqejuxplv` `INACTIVE`) و`Vercel` (`0` مشاريع) و`Notion` (المتاح للتكامل حالياً هو دليل `People` المُدار من Notion فقط — مشاركة صفحة عادية تتيح إنشاء صفحات فرعية).

### 3. تطبيق مسار النشر الإنتاجي الكامل مجانًا 100% بدون فيزا (`DEC-037`)

استجابةً لطلب المالك («طبق ما يحتاجه نظامي ليتم نشره مجانا بدون فيزا تحقق في البداية»):
- **التحقق الأولي:** تأكيد حجب `Render` ببوابة بطاقة `1$` (`DEC-034`) وتوقف `Supabase` المجاني بالخمول (`INACTIVE`) مقابل عمل **Cloudflare Workers + Cloudflare D1 (`celia-edge-state`) + GitHub Pages** حيًّا بلا أي بطاقة دفع ومع `18/18` سرًّا مربوطة آليًا.
- **التنفيذ الكامل على الحافة + D1 ([docs/no-visa-deployment.md](../no-visa-deployment.md)):**
  - ترحيل `workers/celia-edge/migrations/0002_runtime.sql` (إجمالي `12` جملة SQL idempotent تشمل `app_users`، `oauth_states`، `google_credentials`، `whatsapp_contacts`، `whatsapp_messages`، `edge_idempotency`).
  - وحدة التشفير `workers/celia-edge/crypto.js` (`AES-256-GCM` بصيغة `v2.<keyId>` عبر `TOKEN_ENCRYPTION_KEY` أو اشتقاق `HKDF-SHA-256` مع توافق `v1.*`، وتذاكر ربط المتصفح، وHMAC الخام لـMeta).
  - محرك التشغيل الكامل `workers/celia-edge/runtime.js` المربوط في `worker.js` و`scripts/deploy-cloudflare-edge.mjs`: جميع أدوات MCP الـ12 (`POST /mcp`)، وربط Google OAuth2 + Gmail/Drive/Calendar/Contacts، وWebhook واتساب + أوامر المالك العربية («اربط جوجل»، «لخص آخر إيميل»، «هات جدولي») + رد Gemini الذكي، وبوابة القبول الحية `npm run verify:edge` في `cloudflare-deploy.yml` وربط `CELIA_REAL_SERVICE_URL` في `pages.yml`.

### 4. ما يتبقى حصريًا لقرار أو لوحة المالك (لا يُغلق بكود)

- ~~دمج PR `#70` في `main` لينطلق النشر التلقائي لـCloudflare Edge + D1 (الـ12 أداة كاملة) وGitHub Pages بلا أي بطاقة دفع.~~
  **✅ أُنجز في 2026-10-28:** دُمج PR `#70` في `main@0ebf8cac86faaea67e6f969c273549b2f8b33220`، وانتشر محرك الحافة الكامل
  (MCP 12 أداة + Google OAuth2 + WhatsApp + Gemini) على `https://celia-phone-google.celiaelazamey.workers.dev` مع قاعدة D1
  الدائمة، ونجحت بوابة `verify:live --mode edge` داخل التشغيلة `40719074394`، و Pages `40719074587` (12/12 مسارًا) والإصدار
  `40719074453` والجودة `40719074375` كلها خضراء (`DEC-038`).
- إضافة رابط الاستدعاء `https://celia-phone-google.celiaelazamey.workers.dev/auth/google/callback` في Google Cloud Console لإتمام ربط `GOOG-001` الحي، وإضافة أسرار Meta الأربعة عند الرغبة بتشغيل `WA-005` (خطوتان بلا أي بطاقة؛ التفاصيل في [docs/no-visa-deployment.md](../no-visa-deployment.md)).
- مضيف حاويات مجاني بلا بطاقة لمحرك Express + MySQL الكامل (`HOST-003`) ونسخة إنتاجية مستعادة (`DATA-001`) — القراران الوحيدان اللذان لا يزالان يمنعان اكتمال الركنين 6 و8 من [docs/plan-100-percent.md](../plan-100-percent.md).
- تفعيل حماية الفرع `main` في إعدادات GitHub (`Settings → Branches` — حالياً `protected: false`)، وقرار PR `#38` المفتوح، وبيانات `SPDR-002` وسياسات `DATA-004`/`GOV-001`/`REL-001` (ويظل `HOST-003` لخادم حاوية MySQL المستقل اختياريًا فقط بعد توفر البديل الكامل على Workers + D1).

## الطلب السابق — «إتمام دوام D1 الفعلي على الحافة وتنظيف الـPRs المفتوحة»

### حجب Render بالبطاقة → الدوام على الحافة (2026-10-28، DEC-034/DEC-035)

- **Render لا يُنشئ خدمة بلا تفويض بطاقة** (1$ مؤقت، بلا زر تخطٍّ) — قيد موثّق، لا عطل في الكود. القرار: لا بطاقة،
  ولا وسيلة دفع، ولا تجاوز تحقق. `HOST-003` يبقى مفتوحًا ولا يُغلق بكود.
- **البديل المنفَّذ:** D1 على Cloudflare (مجاني، والحساب والمفتاح موجودان): `workers/celia-edge/state.js` +
  مسارات `/api/state` و`/api/audit` + `migrations/0001_state.sql` + إنشاء/ترحيل/ربط آلي في
  `scripts/deploy-cloudflare-edge.mjs`.
- **قاعدة الصدق:** `storage.durable` تُقاس بكتابة رمز جديد وقراءته في كل نداء؛ لا تُعلن من وجود اعتماد. بلا ربط
  ⇒ `false` + `d1_not_bound`، وقاعدة معطوبة ⇒ `false` + سببها.
- **بعد دمج #66 نُشر الـWorker فعلًا** (`main@d46a816`): 18/18 سرًّا، والرابط الحقيقي أعلن الكود الجديد بصدق
  `storage.durable:false` + `reason:d1_not_bound`، وبيانات النشر حملت `d1_migration_400`.
- **بعد دمج #68 (`main@202aa19`، التشغيلة `40700333139` / الوظيفة `122858095918`):** أثمرت ميزة التشخيص وكشفت السبب
  الحرفي في annotations:
  `d1_migration_failed:statement_1:near "every": syntax error at offset 0: SQLITE_ERROR`
  على القاعدة `f63ccd9f-49b1-4eca-861b-fd478c433518`. السبب الجذري: `applyMigrations` كانت تقسم النص عبر `.split(';')`
  **قبل** حذف أسطر التعليقات `--`، والسطر الثاني من `0001_state.sql` يحوي فاصلة منقوطة داخل التعليق
  (`-- ... D1 query API; every statement is`) فبقي المقطع `every statement is` بلا `--` في مطلع العبارة الأولى.
- **الإصلاح النهائي في هذا الفرع (`arena/3f0d6498-phone-google`):**
  1. دالة `splitSqlStatements(sql)` المصدّرة تحذف تعليقات `--` وتعليقات الكتل `/* ... */` **قبل** التقسيم على `;`
     مع صون النصوص والمعرّفات المقتبسة (`'...'` و`"..."` و`` `...` ``).
  2. اختبار تكامل حقيقي في `test/edge-d1.test.js` يمرّر ملف `workers/celia-edge/migrations/0001_state.sql` الفعلي عبر
     `applyMigrations` على محرك `node:sqlite` (`DatabaseSync(':memory:')`) مرتين لإثبات الصلاحية والـidempotency
     (4 عبارات نظيفة)، ثم يشغّل `worker.fetch` على `/readyz` و`/api/state` و`/api/audit` فوق قاعدة SQLite الحقيقية
     ويثبت `storage.durable: true` وسلامة سلسلة التدقيق `chain.ok: true`.
  3. تسجيل حقل `storage` الراجع من `/readyz` الحي مباشرةً في تقرير النشر (`::notice title=Cloudflare Edge Status::`)
     وملخص GitHub Step Summary، وتصحيح رسالة تحذير `Celia D1` عندما يكون ربط `DB` قد طُبِّق فعليًا.
  4. **الدليل المحلي:** `test/edge-d1.test.js` + `test/deploy-cloudflare-edge.test.js` **23/23** · المجموع **498/498**
     · تغطية `90.72 / 73.51 / 84.50` · `check` 135 ملفًا. **الحد الباقي:** النشر على `main` فقط؛ بعد دمج هذا الـPR
     يُفحص حقل `d1.ok` و`storage.durable` من تشغيلة `Deploy (Cloudflare Edge)` على `main`.
- **تنظيف الـPRs المفتوحة (OPS-005):** أُغلقت بتوثيق صريح دون حذف الفروع كل من **#67** (مكرر 100% من #68 بفرق صفر)،
  و**#39** (مسودة متجاوزة بـ#40 `DEC-020` و#43 `DEC-026` ومتعارضة مع `main`)، و**#34** (ريفيرت آلي قديم لـ#33 خطر على
  `agent_outbox`)؛ وبقي **#38** مفتوحًا لقرار المالك بشأن صفحات `/cron` و`/google-map`.

### النشر على Render — الحالة الحقيقية (2026-10-28، DEC-033)

- **لم يُنشر شيء بعد، والسبب ليس عطلًا:** المالك أضاف `CELIA_LIVE_URL` (سرًّا) و`RENDER_API_KEY`، لكن الـworkflow
  كان يقرأ `vars.CELIA_LIVE_URL` وحده ويطلب `RENDER_SERVICE_ID` (غير موجود). لذلك كل تشغيل ينتهي `success` في
  ~20 ثانية برسالة `not-configured` — سلوك مقصود، لكنه كان يخفي أن المالك أدّى دوره.
- **أُصلح:** الرابط `CELIA_LIVE_URL` يُقبل من تبويب المتغيّرات أو الأسرار (المتغيّر أولًا)؛ ومفتاح API وحده يكفي
  (اكتشاف `id`+`url` من `GET /v1/services`، ورفض التخمين عند تعدّد الخدمات مع طباعة الأسماء المرئية).
- **الدليل:** 14/14 في `test/deploy-render.test.js`، و`--plan` بمفتاح فقط يعطي `status: planned` و`missing: []`.
- **`celia-phone-google.onrender.com` يعيد صفحة Render «Not Found»** → الخدمة لم تُنشأ بعد (أو باسم آخر).
- **دُمج #62** (`main@23154a8`): Pages نشرت صفحة الصلاحيات (متحقَّق بجلبها)، والـWorker يعلن `commit 23154a8`.
- **تشخيص حقيقي (28 أكتوبر، تشغيل `40694847170`):** `GET /v1/services` = **200 و`count=0`** → لا خدمة واحدة في
  حساب Render؛ و`celia-phone-google.onrender.com/readyz` = **404**؛ و`CELIA_LIVE_URL` **غير قابل للتحليل كـURL**.
  أي أن «تم» لم تُنشئ خدمة، والقيمة المخزّنة ليست رابطًا. التفصيل: [جلسة التحقق](sessions/2026-10-28-live-verification.md).
- **أُصلح:** رابط فاسد لم يعد يمنع الاكتشاف — يُسقَط بتحذير عند وجود المفتاح، ويأتي الرابط من الـAPI (15/15).
- **ما يتبقى:** إنشاء Blueprint في Render + ضبط `CELIA_LIVE_URL` **بالمخطّط**. بعدها أول CI على `main` ينشر
  تلقائيًا. `workflow_dispatch` و`actions/secrets` = 403 للجلسة، والدمج/الإنشاء قرار المالك.


- **السياسة شيفرة:** `src/agent/computer-policy.js` — 16 قدرة × 4 حالات (مسموح 7 · موافقة 3 · مقيّد 2 · محظور 4)
  مع نطاق وبوابة لكل قدرة. `decideAction` يطبّق الطبقات بالترتيب: منع صريح ← `NETWORK=DENY` ← `IDENTITY=NOT_PROVEN`
  ← النطاق ← الموافقة/الإذن. المنع الافتراضي حرفي: قدرة غير مسمّاة مرفوضة.
- **الحكم ≠ القدرة:** كل قدرة `wired=false` (لأن `AGENT-003` موقوفة)، فالنقر يعطي `verdict: allow` مع
  `executable: false`؛ واختبار يثبت `wired === 0`. أي وصل مستقبلي يفرض تحديث السياسة والاختبار والصورة معًا.
- **الإنفوجرافيك مُولَّد:** `public/computer-permissions.html` + `docs/computer-permissions/README.md` من نفس الثوابت،
  و`npm run computer:permissions:check` يُفشل CI عند الانحراف (خطوة في `celia-mcp.yml`).
- **الميزة التنافسية:** Evidence-Carrying Autonomy — 5 ركائز و4 مراحل ببوابات، تنتهي بمقارنة عادلة، ومعلَّمة صراحة
  «مستهدفة لا مُثبتة» (`notClaimed` مطبوع ومُختبر).
- **البوابات:** 22 اختبارًا للسياسة · الصفحة بلا طلبات خارجية · تقليل الحركة · روابط داخلية سليمة.
- **لم يُثبت:** لا تنفيذ كمبيوتر ولا اختبار صلاحيات حي على جهاز حقيقي، ولا مقارنة مهام مع Claude/Manus.

## الطلب السابق — «أضف حوكمة أتمتة المشكلات لنظامي وأكّد النشر من بيانات المستودع»

- **منفَّذ كشيفرة مفروضة لا كمخطط:** عتبات 0.90/0.60 في `src/agent/issue-triage/policy.js`، قائمة سماح مغلقة
  للوسوم والمُسندين، سقف 10 تطبيقات تلقائية يوميًا، نافذة تراجع 7 أيام، وحجب بالاسم لتعديل الكود/الفرع/PR/
  الـworkflow/الأسرار/النشر/الإصدار (`EFFECT_SCOPE.blocked` + `assertInScope` + حارس ثابت على الكاتب الوحيد).
- **نص الـIssue بيانات لا تعليمات:** `injection.js` يكشف ويُنقّي ويسجّل أوامر التعطيل والتمثيل والأسرار والنشر
  وقذائف الطرفية والتخفّي، ولا يرفع الثقة أبدًا — الحقن يمكنه فقط أن *يخفض* القرار إلى مراجعة بشرية.
- **سجل تدقيق بسلسلة SHA-256:** كل قرار في سجل واحد (#59) بحقول التصميم الدنيا؛ `npm run triage:verify` يعيد بناء
  السلسلة بلا صلاحية كتابة.
- **الدليل الحي من المستودع:** run `40682911724` (#56 تلقائي 0.94 · #57 رفض 0.35 · #58 حقن → بشري) وrun
  `40683251035` (#61 تلقائي 0.94) — والسجل #59: 3 سجلات، سلسلة سليمة.
- **عيب كشفه التشغيل الحي:** سجلّا تدقيق بسبب تأخر البحث بعد الإنشاء؛ أُصلح (ترتيب الإنشاء + الأقدم + تحذير +
  اختبار انحدار) وأُغلق #60 كمتجاوَز.
- **البوابات:** 443/443 اختبارًا · تغطية 90.36/73.12/84.15 · `check` 131 ملفًا · 35 اختبارًا للتصنيف وحده.
- **النشر:** Pages وWorker والإصدار `v0.2.1` متحققة من بيانات المستودع؛ Render ما زال `not-configured` ويحتاج
  إجراء المالك (`CELIA_LIVE_URL` + `RENDER_API_KEY`/`RENDER_SERVICE_ID`) — وصلاحية الجلسة لا تسمح بـdispatch (403).
- **تفعيل الحوكمة تلقائيًا:** يحتاج الدمج في `main`، لأن أحداث `issues` لا تشغّل workflow غير موجود على الفرع الافتراضي.
- **لم يُثبت:** لا اتصال ببيئة Copilot المستضافة؛ والمصنّف قواعد حتمية لا نموذج.

## الطلب السابق — «تحقق `CELIA_VOICE_ID` + تنفيذ النشر المجاني بمعدل 100% نجاح»

- **الصوت: ✅ متحقَّق بدليل حي.** تدقيق `40680228320` (commit `b708056`، `verdict: pass`): حي **12/12**،
  `workingRate: 1`، `failed: []`، offline 401/401، تغطية 90.49/73.32/83.88، MySQL 11/11. الـrun السابق
  `40678857684` كان 11/12 بسبب `elevenlabs — voice_not_found` وحده. الشاهد أن `verified` لذلك المزوّد لا يُمنح إلا بعد
  `POST /text-to-speech/<CELIA_VOICE_ID>` يعيد `audio/*` (6 حروف، لا تُخزَّن) — أي أن السرّ صار صوتًا فعليًا.
- **النشر: ❌ لم يُنفَّذ، ولا يُنفَّذ من الجلسة.** `deploy-render.yml` run `40679651805` = success لكن
  `status: not-configured` و`missing: [CELIA_LIVE_URL, RENDER_API_KEY + RENDER_SERVICE_ID (أو RENDER_DEPLOY_HOOK_URL)]`
  — وأُعيد التحقق محليًا بـ`node scripts/deploy-render.mjs --plan` بنفس النتيجة. العوائق صلاحية مالك:
  `gh workflow run` و`gh secret list` و`gh api …/actions/variables` كلها **403**، والـworkflow يعمل فقط على
  `workflow_run` من `main` أو dispatch، والجلسة لا تدفع إلى `main`.
- **إصلاح جوهري في هذه الجلسة:** `render.yaml` لم يكن يعلن `APP_BASE_URL` ولا `GOOGLE_*`، فكان `redirectUri` سيُبنى على
  `http://localhost:PORT` ويرسل «اربط جوجل» رابط موافقة لا يعمل. أُضيف `APP_BASE_URL` (`sync: false`)،
  `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`، و`CELIA_TIMEZONE=Africa/Cairo`؛ وحُمي بـ`test/deployment-blueprint.test.js`
  (**7/7**) الذي يربط `render.yaml` بـ`src/config.js` و`docs/deployment-profile.json`.
- **البوابات المحلية:** `test:coverage` **408/408** (90.51/73.24/83.88) · `check` 128 ملفًا · `copilot:diagram:check` نظيف ·
  `check:continuity` 39 وثيقة/138 رابطًا.
- **لم يُثبت:** لا خدمة Render ولا Aiven ولا URL حي؛ ولا اتصال بيئة Copilot المستضافة بالجسر. 12 متحققة = 12 مزوّدًا
  ردّوا من CI، وليست دليلًا على تشغيل التطبيق كاملًا على مضيف عام.

## الطلب السابق — طبقة حماية Copilot ومخططها (AGENT-005، PR #54 مدموج في `main@8dc3c0e`)

- **جسر مفروض لا إعداد JSON:** Copilot يستدعي أدوات MCP المفعّلة دون موافقة لكل استدعاء، فالقيد في شيفرة أمام الخادم.
  `scripts/celia-copilot-mcp-bridge.mjs` يفرض: قائمة سماح بأربع أدوات قراءة، `readOnlyHint` مثبتًا من الجسر، قدرات
  `tools` فقط (رفض prompts/resources)، وتنقية نتائج تحجب أي قيمة سرّية. الاختبار الحاسم E2E على **الخادم الحقيقي** (16 أداة).
- **المخطط:** `docs/copilot-mcp/architecture.svg` (+`.html` وMermaid) مُولَّد من ثوابت السياسة نفسها، و`--check` يفشل عند
  أي قدم أو تجاوز نصي — وصار خطوة في CI.
- **لم يُثبت:** اتصال بيئة Copilot المستضاف بالجسر (لا صلاحية لوحة المالك).

## الطلب السابق — WhatsApp مجاني-أولًا (DEC-032، PR #51، مدموج في `main@b70f914`)

- PR #51 أضاف حقول تشغيل WhatsApp إلى `render.yaml`، وجعل إصدار Graph الافتراضي `v26.0`، وأضاف مسبار `whatsapp_cloud_api`
  للقراءة فقط (GET فقط، لا إرسال) مع اختبارات وتوثيق؛ سجل الجلسة:
  [2026-10-28-whatsapp-free-first-setup](sessions/2026-10-28-whatsapp-free-first-setup.md).
- **بعد دمج #51 صار الإصدار أخضر على `main`:** جودة `40673821757`، Pages `40673821758`، Worker `40673821848`، وإصدار
  `v0.2.1` بأصوله `40673821824` — أي أن فشل `Publish verified release` الذي عالجه هذا الفرع **لم يتكرر بعد إصلاح PR #49**.
- **Render ما زال غير منشور:** run `40673950617` انتهى `not-configured` وينقص `CELIA_LIVE_URL` و`RENDER_API_KEY` +
  `RENDER_SERVICE_ID` (أو `RENDER_DEPLOY_HOOK_URL`) وإنشاء خادم Render وقاعدة Aiven.
- الأسرار الأربعة `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN`
  لم تظهر في قائمة الأسرار؛ `PHONE_NUMBER` هو رقم المالك لا Phone Number ID ولا توكن. الرد الآلي باقٍ `false`، ولم يُشغَّل
  تدقيق حي لـMeta بعد الدمج (لا يوجد دليل على اتصال WhatsApp حقيقي).
- `main` غير محمي في آخر قراءة (`protected=false`) — إجراء مالك مستقل.



- **ما نُفِّذ في هذه الجلسة (على الفرع، قبل الدمج):** فصل بوابات الإصدار الأربع في خطوات مسمّاة داخل
  `.github/workflows/release.yml` (الفشل الوحيد على `main@fc4d60f` كان «exit code 1» بلا اسم بوابة، والـjob توقف بعد 20
  ثانية أي قبل `npm test` البالغ 24 ثانية) + **نشر idempotent** يقارن `SHA256SUMS` فلا يفشل إعادة التشغيل على أصول متطابقة
  + مدخل `live_only` في `service-reality.yml` (تحقق من السرّ في ~دقيقة بدل ~20).
- **التغطية:** 383/383 اختبارًا (كانت 326)، أسطر **90.29%** وفروع 73.20 ودوال 83.79 (كانت 85.72/71.79/83.83)، والأرضية في
  CI صارت **89/71/82** بدل 80/65/78 (`package.json` + `COVERAGE_FLOOR` + اختبارها).
- **اختبارات جديدة:** `deploy-cloudflare-edge`، `deploy-release`، `learn-source`، `reality-notify-main`، `lifecycle`،
  `celia-mcp-tools`، `celia-mcp-protocol`، `celia-mcp-selftest`، `agent-tool-validation`، `outbound-guards`.
- **الخدمات الحية لم تتغيّر:** 11 متحققة / 1 فاشلة / 4 متقاعدة من 12 مهيأة = **91.7%**؛ الفشل الوحيد `CELIA_VOICE_ID`
  (القيمة الواصلة للـworkflow ليست بين 22 صوتًا مرئيًا؛ القائمة تضم `cela=AnsOWV53Mdx5fcIanRBB`).
- **النشر الكامل:** لم يُنفَّذ ولا يُدّعى — `deploy-render.yml` يخرج `not-configured` ويسمّي الناقص:
  `CELIA_LIVE_URL` (variable) + `RENDER_API_KEY`/`RENDER_SERVICE_ID` أو `RENDER_DEPLOY_HOOK_URL`، والحسابان (Render Free،
  Aiven MySQL Free) غير موجودين.
- **مدموج:** PR #50 ← `main@5709bad` (28 أكتوبر 2026). كل الـworkflows على commit الدمج ناجحة: الجودة `40674752264`
  (Node 22/24 + Python + حاوية + RTL + MySQL)، `Publish verified release` `40674752228` بخطواته المسمّاة
  `Gate 1/4 … Gate 4/4` ثم نشر موقّع OIDC، Pages `40674752288`، Worker `40674752211`، Render `40674873835`
  (`not-configured` صريح) → **REL-002 وQA-006 «متحقق»**. WhatsApp صار له حقول تشغيل ومسبار قراءة فقط (DEC-032).
- **ما زال ناقصًا (كله لوحات مالك):** `CELIA_VOICE_ID` (91.7% < 95%)، Render+Aiven (`not-configured`)، أسرار Meta الأربعة،
  عميل Google OAuth، وحماية `main` (`protected=false`).
- **الخطوة التالية (المالك، خمس لوحات في [plan-100-percent](../plan-100-percent.md) §2):** `CELIA_VOICE_ID` في Repository
  secrets → «تم»؛ ثم Aiven + Render Blueprint + `CELIA_LIVE_URL` وأسرار Render → `verify:live` PASS؛ ثم أسرار Meta الأربعة
  وتحدي Webhook؛ ثم عميل Google OAuth.

## الطلب السابق — إصلاح حتمي لفشل نشر الإصدار (PR #49، مدموج في `main@8a9fc56`)

- **السبب الجذري الحقيقي لفشل `Publish verified release` على `main@fc4d60f` (run `40665130469`):** اختبار
  `test/knowledge-ingest.test.js:164` — `KnowledgeStore.stats()` كان يختار آخر سجل بـ`ORDER BY started_at DESC` وحده، فإذا
  تساوى توقيتان بدقة المللي ثانية لم يكن السجل المختار هو الأحدث. الإصلاح: `rowid DESC` لكسر التعادل + تثبيت ساعة الاختبار
  (سجل الجلسة: [2026-10-28-knowledge-ingest-tie-fix](sessions/2026-10-28-knowledge-ingest-tie-fix.md)). **تصحيح ذاتي:** تحليلي
  المبدئي في جلسة PLAN-001 استنتج من زمن التوقف (20 ثانية) أن الفشل قبل `npm test`؛ الفحص المتوازي أثبت أنه داخل الاختبار —
  ولهذا صار فصل البوابات في خطوات مسمّاة مطلبًا لا تحسينًا.
- `main` ما زال عند `fc4d60fddb66ad4349ddf664e23e094444a939b8` وقت بدء هذه الجلسة؛ لا دمج ولا تغيير على `main`.
- run `40665130469` لـ`Publish verified release` فشل في `test/knowledge-ingest.test.js:164`؛ فحوص الجودة على commit نفسه نجحت في run `40665130587`، ونشر Pages/Cloudflare وRender نجح في التشغيلات المسجلة.
- السبب الجذري: `KnowledgeStore.stats()` كان يختار آخر سجل بـ`ORDER BY started_at DESC` فقط. إذا تساوى توقيت تشغيلين بدقة المللي ثانية، فقد لا يكون السجل المختار هو الأحدث.
- الإصلاح المعزول في PR #49: إضافة `rowid DESC` لكسر التعادل، وتثبيت ساعة الاختبار بحيث تتساوى الطوابع الزمنية عمدًا. رابط PR: https://github.com/celiaelazamey-arch/phone-google/pull/49.
- تشغيل PR `40671238246`: سجل Node 24 `fail 0` في الاختبارات، لكن بوابة `check:continuity` رفضت التغيير أولًا لغياب `STATE.md` وسجل الجلسة؛ أضيف هذا السجل والملف المصاحب ضمن الـPR. لا يُعلن نجاح CI الكامل قبل اكتمال التشغيل النهائي بعد التوثيق.
- لا تغييرات على الأسرار أو إعدادات النشر أو بيانات الإنتاج في هذا الإصلاح. لم يُدمج PR، ولم يُعاد تشغيل نشر الإصدار.
- فجوات المالك المستقلة ما زالت: ضبط `CELIA_VOICE_ID` في **Repository secrets → Actions** إلى `AnsOWV53Mdx5fcIanRBB` ثم تشغيل تدقيق الخدمات الحية؛ تفعيل حماية `main` بأسماء الفحوص المطلوبة في خطة المحافظة. التدقيق الحي الأخير الموثق على الفرع هو 11/12 (91.7%)، وليس 95% أو 100%.
- معيار الاستكمال: نجاح كل وظائف PR #49، ثم الدمج وفق بوابة الفحوص، وإعادة فحص الإصدار على commit الدمج، وبعد تحديث السر تشغيل تدقيق حي على `main` وإثبات نسبة الخدمات من artifact/annotations. لا تُغيّر عتبات التغطية لإخفاء الفشل.

## الطلب السابق — «خطط للمحافظة لما وصلنا له حتى الآن» (DEC-031، OPS-005) — مدموج في PR #47 و#48
- **ما وصلنا إليه (مدموج في `main@715060a`):** 324/324 اختبارًا (تغطية 85.8/72/84)، MySQL حقيقي 11/11، Pages ✅ `40650636259`،
  Worker ✅ `40650636104` (`liveReady`، 18/18 + مفاتيح التقاعد)، Release ✅ `40650636330`، 10 خدمات متحققة / 4 متقاعدة في Git /
  2 بانتظار سرّ مالك (83.3%).
- **ما نُفِّذ للمحافظة:** `docs/preservation-plan.md` (جرد بالدليل، مخاطر، ضوابط، أسرار، إعادة بناء، إيقاع، مؤشرات)؛
  `service-reality.yml` يعمل أسبوعيًا (اثنين 06:00 UTC) ويشغّل `scripts/reality-notify.mjs` على `main`: issue واحدة
  `service-reality` تُفتح/يُعلَّق عليها عند الفشل وتُغلق وحدها عند النجاح؛ CI يفرض أرضية تغطية `npm run test:coverage`
  (80/65/78) و`COVERAGE_FLOOR` في التدقيق؛ اختبارات `test/reality-notify.test.js` (2) + توسيع `test/service-reality.test.js`.
- **بنود المالك (لا تُنفَّذ من هنا — 403):** حماية `main` بأسماء الفحوص المذكورة في الخطة §د؛ Watch → Actions أو الاكتفاء
  بالـissue؛ `CELIA_VOICE_ID` وتوكن Figma؛ قرار PRs #34 (revert — لا يُدمج) و#38/#39؛ Dependabot security updates.
- **الدليل على الفرع:** `1fd0628` → `Celia quality & resilience` run `40652077014` ✅ (أرضية التغطية مرّت على Node 22/24، 326/326).
- **مدموج:** PR #47 → `main@2d3da5b` (2026-10-28 07:55 UTC)؛ الجدول الأسبوعي فعّال على `main`.
- **28 أكتوبر 2026 — المالك أبلغ بتحديث السرّين** `CELIA_VOICE_ID` و`FIGMA_ACCESS_TOKEN` («تم»). `workflow_dispatch` من هذا
  التكامل → 403، لذلك يُشغَّل التحقق بدفعة `[reality]` على الفرع `arena/3d9557b5-phone-google`؛ النتيجة تُسجَّل هنا بعد الـrun.
- **النتيجة (runs `40660546276` ثم `40661486530`):** **Figma ✅ متحقق** بالتوكن الجديد → 11 متحققة / 1 فاشلة / 4 متقاعدة =
  **91.7%**. ElevenLabs: المفتاح الجديد صالح (`/user` 200) ويولّد صوتًا فعلًا (17,597 بايت)، لكن `CELIA_VOICE_ID` (20 حرفًا)
  ليس بين 22 صوتًا مرئيًا — **والقائمة تضم صوتًا مخصصًا باسم `cela` معرّفه `AnsOWV53Mdx5fcIanRBB`**؛ الأرجح أن القيمة
  الملصوقة معرّف آخر. التشخيص الكامل في annotation الـrun (كل الأصوات المرئية بأسمائها ومعرّفاتها).
- **28 أكتوبر 2026 — المالك أبلغ («تم») بضبط `CELIA_VOICE_ID` = معرّف صوت `cela`.** runs `40663032835` و`40663707956`
  (`77a7165`، `71afedd`): **القيمة التي يستلمها الـworkflow من `secrets.CELIA_VOICE_ID` ما زالت معرّفًا آخر** (20 حرفًا، يبعد
  18 تعديلًا عن أقرب صوت مرئي — ليس خطأ حالة أحرف ولا خطأ كتابة)؛ المفتاح صالح ويولّد صوتًا. الاستنتاج: التحديث لم يصل إلى
  **Repository secret** في تبويب **Actions → Secrets** (ربما Variables، أو تبويب Codespaces/Dependabot، أو سرّ بيئة، أو لم يُحفظ).
  المدقق صار يبلّغ «أقرب صوت مرئي» (حالة/خطأ كتابة/لم يُحدَّث) دون كشف القيمة.
- **الخطوة التالية (المالك):** Settings → Secrets and variables → Actions → تبويب Secrets → Repository secrets →
  `CELIA_VOICE_ID` → Update → `AnsOWV53Mdx5fcIanRBB` → Update secret؛ ثم «تم» → run `[reality]` → عند ≥95% تحديث QA-005.
- **مدموج:** PR #48 → `main@fc4d60f` (2026-10-28 09:33 UTC) بأمر المالك؛ بعده Edge/Quality/Pages/Render ✅ و`Publish verified
  release` ❌ `40665130469` (بلا اسم اختبار → DEC-039 أعلاه؛ السبب الحقيقي كشفه PR #49؛ v0.2.1 لم يتأثر، 5 أصول).

## الطلب السابق — «لا خدمة مجرد اسم أو موكب؛ خدمات حقيقية مختبرة ≥95%» (DEC-030، QA-005) — مدموج في PR #46

- **ما نُفِّذ:** `scripts/service-reality.mjs` (`npm run reality`) + `.github/workflows/service-reality.yml` (يعمل عند commit
  يحمل `[reality]` أو `workflow_dispatch` من `main`) + `test/service-reality.test.js` (10) + `test/ai-providers.test.js` (3).
  ست تشغيلات حقيقية بالأسرار الـ18 من داخل Actions؛ التشخيص الكامل في run `40646881277`؛ **الأخيرة run `40649403028`**:
  324/324 بلا شبكة (85.82% أسطر)، MySQL 8.4 حقيقي 11/11، مسابر حية: **10 متحققة · 2 فاشلة · 4 متقاعدة صراحةً · 1 غير مهيأة
  · 2 لا يمكن التحقق · 1 غير منشورة → 83.3% < 95%** (كانت 62.5%).
- **التقاعد الصريح (بعد «ابدأ كما ذكرت»):** لا صلاحية لمتغيرات/أسرار المستودع (403) → `docs/deployment-profile.json →
  serviceRetirements` لـAI Gateway (403 «بطاقة مطلوبة»)، R2 (TLS مرفوض/غير مفعّل)، DeepSeek (402)، AgentRouter (0 نماذج)؛
  يغذّي المدقق وbindings الـWorker و`render.yaml` معًا؛ التراجع = حذف السطر بعد إصلاح الحساب + commit `[reality]`.
- **ما بقي فاشلًا وسببه سرّ مالك:** ElevenLabs — **المفتاح يولّد صوتًا فعلًا** (17,597 بايت في الـrun) لكن `CELIA_VOICE_ID`
  ليس بين الأصوات المرئية (مرئية مثلًا `EXAVITQu4vr4xnSDxMaL` Sarah، `FGY2WhTYpPnrIDTdsKH5` Laura، `CwhRBWXzGAHq8TQ4Fs17` Roger)؛
  Figma — توكن 401. الجدول: [docs/service-reality.md](../service-reality.md).
- **ما أصلحه الدليل:** `/readyz` للـWorker لم يعد يدّعي `durable: true`؛ افتراضي DeepSeek `deepseek-flash`؛ رسائل رفض المزوّد
  تحمل سببها بلا مفتاح؛ `/api/secrets/status` على الحافة يعرض `retiredServices`.
- **الخطوة التالية (المالك، خطوتان):** (1) سرّ `CELIA_VOICE_ID` = صوت مرئي للمفتاح (أو إعادة إنشاء صوت سيليا في هذا
  الحساب)؛ (2) توكن Figma جديد **أو** سطر `figma` في `serviceRetirements`. ثم commit `[reality]` (أو dispatch من `main` بعد
  دمج PR #46) → 100% بدليل run، وتحديث QA-005 إلى «متحقق».

## الطلب السابق في الجلسة نفسها — «هنربط جوجل بالواتساب: لخص آخر إيميل / هات جدولي» (DEC-029، GOOG-003)

- **ما طلبه المالك (بلصق إرشاد من محادثة أخرى):** ربط Google بواتساب بمسار Python `InstalledAppFlow` + `credentials.json` +
  `token.json`، وإصلاح «مافيش إيميلات جديدة» بـ`q=""`. **الحكم:** لا يُنسخ (خادم بلا متصفح، عميل Desktop ≠ Web، توكن خام في ملف)؛
  الربط موجود في Node بعميل Web + تشفير، و`credentials.json` شأن السبّابة Python (Drive فقط). التفاصيل: `docs/google-connect.md` §6ب.
- **ما نُفِّذ:** `src/owner-google-commands.js` (تحليل/تنسيق نقي، منطقة زمنية `CELIA_TIMEZONE` افتراضي `Africa/Cairo` مع التوقيت
  الصيفي)، `fetchInboxMessages`/`listAgendaEvents` في `src/google.js` (`INBOX` بلا `is:unread` إلا عند طلب «الجديدة»؛ عميل محقون
  للاختبار)، التوصيل في `src/whatsapp.js` **للمالك فقط** بعد أمر «اربط جوجل»؛ `test/owner-google-commands.test.js` 8/8 (تحليل،
  مدى اليوم عبر تبديل DST المصري 29 أكتوبر، التنسيق، أخطاء بلا تسريب، 409 قبل الربط، webhook: المالك يحصل على الرد وعميل بنفس
  النص لا يحرّك Google ولا واتساب). لا نموذج لغوي، لا إرسال بريد، لا تعديل تقويم.
- **ما يبقى:** التشغيل الحي يحتاج الخادم الكامل منشورًا (HOST-003 → الخطوات الثلاث أدناه) ثم «اربط جوجل» من رقم المالك.
  `credentials.json` غير مطلوب للخادم.

## الطلب السابق في الجلسة نفسها — «الأسرار موجودة، استخدمها» → أتمتة النشر على Render والتحقق (DEC-028)

- **الواقع عند `main@a930383` (دمج PR #45، 2026-10-28 01:31 UTC):** Pages `https://celiaelazamey-arch.github.io/phone-google/`
  (deployment `7374774785`، 10/10 مسارات في `40615518798`)، Worker `https://celia-phone-google.celiaelazamey.workers.dev`
  (`liveReady:true`، 18/18 سرًا في `40615518722`)، الإصدار `v0.2.1` موثق (`40615518730`)، صورة GHCR عامة.
  **غير منشور:** الخادم الكامل Express + MySQL — لا خدمة Render ولا قاعدة Aiven ولا `verify:live` PASS.
- **أسرار Actions الثمانية عشر:** كلها مستخدمة (مزوّدو الذكاء ×4، cron-job.org، رمز المالك، الصوت ×2، Cloudflare ×2،
  R2 ×3، Figma، Google OAuth ×2، الهاتف، Coda) — ولا واحد منها مضيف Node أو قاعدة MySQL؛ هذان حسابان ينشئهما المالك فقط.
- **ما نُفِّذ:** `.github/workflows/deploy-render.yml` (بعد نجاح CI على `main` أو يدويًا؛ `contents: read`) +
  `scripts/deploy-render.mjs` (`npm run deploy:render`): `not-configured` أخضر مع تسمية الناقص → إطلاق نشر Render (API أو
  hook) وانتظار `live`/تطابق `/version` → `verify:live --expect-commit` بالرمز من البيئة → artifact → keep-alive
  cron-job.org `celia-keepalive:<host>` كل 10 دقائق بعد PASS فقط؛ `sanitize` لكل مخرجات. اختبارات
  `test/deploy-render.test.js` (8). الوثائق: `deploy/free-always-on/README.md` §4.2، README §روابط النشر،
  `docs/deployment-profile.json`.
- **ما يبقى على المالك (≈10 دقائق، بلا بطاقة):** (1) Aiven → MySQL Free فارغة؛ (2) Render → New → Blueprint → هذا
  المستودع (`render.yaml`) → لصق `MYSQL_*` الستة في Render فقط؛ (3) في GitHub: variable `CELIA_LIVE_URL` + secrets
  `RENDER_API_KEY`/`RENDER_SERVICE_ID` (أو `RENDER_DEPLOY_HOOK_URL`). بعدها أول دمج/تشغيل يدوي لـ`deploy-render.yml`
  يكتب `verified` أو سبب الفشل. البنود `manual` في §5 تبقى بسجل جلسة.
- **الخطوة التالية:** مراجعة/دمج PR هذا الفرع (قرار المالك)، ثم الخطوات الثلاث أعلاه؛ لا نشر من هذه الجلسة.

## الطلب السابق — التعلم المحكوم من المصادر الخارجية وروابط النشر (DEC-027)

- **روابط النشر الحية (دليل GitHub API عند `main@1a11810`، 2026-10-28 00:53 UTC):**
  - GitHub Pages: `https://celiaelazamey-arch.github.io/phone-google/` — deployment `7374226427` ناجح + فحص 10/10 مسارات
    (التشغيلة `40611588083`).
  - Cloudflare Worker: `https://celia-phone-google.celiaelazamey.workers.dev` — `deployed`، `liveReady:true`، 18/18 سرًا
    (التشغيلة `40611588035`).
  - الإصدار `v0.2.1` موثق OIDC (التشغيلة `40611588118`)؛ صورة `ghcr.io/celiaelazamey-arch/phone-google:v0.2.1` **عامة**.
  - **غير منشور:** الخادم الكامل (Express + MySQL): لا خدمة Render ولا قاعدة Aiven ولا `verify:live` PASS — يبقى
    `not-verified` حتى يأذن المالك بإنشاء الحسابات المجانية. الصندوق الرملي لا يفتح `github.io`/`workers.dev`؛ الدليل من
    حالات النشر وتعليقات التشغيلات.
- **ما نُفِّذ (التعلم):** سجل مصدر `data/learning/sources/yt-Cb3mBAH0IaY/source.json` (SHA-256 للنص و12 مقطعًا؛ النص
  نفسه خارج Git)، `scripts/learn-source.mjs`، عقود `video` + `reference-only` (مصادر فقط) في `validate.js`،
  `data/kb/learned_registry.csv` بـ9 وحدات `T1` موسومة `learn:yt-Cb3mBAH0IaY`، بطارية `LS-01..LS-10` (10/10)،
  `kb -- verify` 0 مرفوض و`unresolved: []`، `npm test` 295/295.
- **متجه حالة المصدر:** `SOURCE=VERIFIED · EXTRACTION=PARTIAL (بلا طوابع زمنية) · COMPREHENSION=PARTIAL ·
  KNOWLEDGE=CANDIDATE(9) · PROCEDURE=NONE · CAPABILITY=NONE · REGRESSION=PASS`. مواضيع NLP/CV/الروبوتات/AGI/ASI **UNKNOWN**.
  **تحديث 2026-10-29 (DEC-043):** المرور الثاني أكمل النص (481 سطرًا، 29 مقطعًا، 20 وحدة) → `EXTRACTION=FULL ·
  COMPREHENSION=VERIFIED · KNOWLEDGE=CANDIDATE(20)`؛ AGI/ASI صارا مقطعين موثقين (S24/S25)؛ NLP/CV/الروبوتات/قسم التطبيقات
  تبقى UNKNOWN لأن لا مقطع لها في نص التسميات الكامل.
- **الخطوة التالية:** (1) المالك يراجع PR هذا الفرع ويدمجه (= بوابة الموافقة؛ الدمج ينشر Pages/Worker/Release تلقائيًا)؛
  (2) إن أراد الاستخراج الكامل: لصق نص «إظهار النص» بصيغة `mm:ss نص` أو `.srt`؛ (3) HOST-003: إنشاء Render Free + Aiven
  Free من لوحتي المالك ثم `verify:live`.

## الطلب السابق — دورة الخطة والـAgent Harness وقدرة `document_data_automation` وبوابة `Comprehension Gate` (DEC-019، DEC-020، DEC-021)

- **ما نُفِّذ في هذه الجلسة (`arena/5fccc4e6-phone-google`):**
  - **آلة حالات الخطة (`src/agent/harness.js` + `src/agent/runtime.js`):** انتقالات صريحة
    `PLAN_READY → WAITING_FOR_APPROVAL → APPROVED → EXECUTING` مع مسار التعديل المحكوم
    `PLAN_READY → WAITING_FOR_APPROVAL → EDITED → WAITING_FOR_APPROVAL` ومسار الرفض `REJECTED`.
  - **تعديل الخطة وإعادة فحص السياسات (`POST /api/agent/runs/:id/plan` و`decision: 'edited'`):** يتحقق من
    الحمولة المعدّلة ضد `inputSchema` ويرفض تغيير الأداة أو الحقول غير المصرّح بها، ويسجل القرار السابق `edited`
    وينشئ طلب موافقة جديدًا مربوطًا ببصمة الحمولة الجديدة ويحدّث نية الـoutbox المعلّقة ويدوّن `plan_edited` في
    سلسلة SHA-256، ويبقي التشغيل في `waiting_approval` دون أي تنفيذ خارجي حتى موافقة المالك.
  - **حارس النزاهة بعد الموافقة (`verifyApprovedEffectIntegrity` + `verifier.js`):** يمنع أي تلاعب صامت بحمولة
    الـoutbox بعد صدور الموافقة قبل استدعاء أي موصل خارجي.
  - **القدرة الأصيلة `document_data_automation` (`src/agent/automation/{schema,reader,extractor,validator,index}.js`، DEC-020):**
    تعمل محليًا بالكامل (`NETWORK = DENY`، `EXTERNAL GATES = CLOSED` افتراضيًا) فوق بنية CeliaOS القائمة:
    قراءة مستندات محلية معروفة النوع (`CSV`/`JSON`/`TXT`) ببصمة `SHA-256` ومراجع الحقول/الأسطر (`document.read`)،
    واستخراج منظم وفق مخطط معلوم الإصدار `schema_version: "1.0"` مع عزل محتوى المستند كبيانات غير موثوقة وقياس الدقة
    على حزمة مرجعية ذهبية (`document.extract` + `measureExtractionAccuracy`)، وفحص حتمي للقيم والتواريخ والعملات
    ومطابقة الإجماليات والتكرارات ومؤشرات حقن التعليمات (`data.validate`)، وتوليد تقرير موحد مع ربط البصمات بسلسلة
    الأدلة (`data.report`)، وإدراج محكوم اختياري في سجل المشتريات بعد موافقة المالك عبر `agent_outbox`
    (`document.commit_purchase_ledger`) مع فحوص المُتحقِّق المستقل (`document_automation_schema`،
    `document_automation_policy`، `document_automation_commit_parity`).
  - **بوابة الفهم والشرح المبسّط المدعوم بالأدلة (`Comprehension Gate — Explain to Understand`، DEC-021):**
    إضافة القاعدة إلى `AGENTS.md`، وعقد الشرح المتوافق عكسيًا مع `schema_version: "1.0"` (`validateExplanationContract`)،
    وشرح الحقول بالرجوع إلى مواضعها (`explainExtractedFields`) مع فصل الحقائق المثبتة (`verified_facts`) عن الافتراضات
    (`assumptions`) والحقول الغائبة/غير المحسومة (`unknowns`)، وتفسير نتائج التحقق بلغة بسيطة (`explainValidationOutcome`)،
    وفاحص البوابة (`evaluateComprehensionGate`) وربطه في `src/agent/verifier.js` (`comprehension_gate_grounding`) و`src/agent/planner.js`،
    واختبارات `CL-01` إلى `CL-10` في `test/agent-comprehension-gate.test.js`.
  - **معمارية Agent Harness الـ10 مكونات (`GET /api/agent/harness`)** وواجهة تعديل الخطة في `/agent`، وتشخيص
    Playwright Chromium الصريح (`e2e/diagnostics.js`، `e2e/agent.spec.js`، `playwright.config.js`)، وإصلاح
    الروابط النسبية وتباين WCAG 2.2 AA وعرض 320px في `/agent` و`/kb`.
  - **إضافة المرحلة 1 من خارطة التوسعة (`AGENT-002` — موصلا WhatsApp وGoogle Drive عبر `agent_outbox`، [DEC-022](DECISIONS.md#dec-022--استكمال-موصلات-الأثر-الخارجي-في-agent_outbox-agent-002-whatsapp-cloud--google-drive-report-export)):**
    - إضافة موصل `whatsapp.cloud` (`whatsapp.send_text`) بفحص `E.164` و`opted_in` ونافذة 24 ساعة ومنع التكرار عبر `whatsapp_messages`، وموصل `google.drive` (`google.drive_export_report`) ببصمة `appProperties.celiaOutboxKey` وفحص `findByOutboxKey` قبل الإنشاء.
    - توسيع `CELIA_AGENT_CONNECTORS` ليقبل `none, calendar, whatsapp, drive` مع بقاء `none` هو الوضع الافتراضي الآمن.
    - نجاح جميع الاختبارات المحلية (**273/273** في `npm test` شاملة `WA-01..WA-04` و`DRV-01..DRV-04` في `test/agent-connectors.test.js`).
  - **إضافة محرك التطبيق والقياس ذي الخطوات الست (`6-Step AI Application & Evaluation Engine`، [DEC-023](DECISIONS.md#dec-023--محرك-التطبيق-والقياس-ذو-الخطوات-الست-6-step-ai-application--evaluation-engine--product-catalog-audit--6-stage-creative-workflow--3-way-truth-partition)):**
    - بناء [src/agent/evaluation.js](../../src/agent/evaluation.js) و[docs/ai-workflow-6-steps.md](../ai-workflow-6-steps.md) لتطبيق: توجيه المهام (`recommendTaskStrategy`)، معادلة التكلفة وحارس الخطط المجانية (`estimateTokenCost` و`evaluateProviderSafety`)، فاحص كتالوج المنتجات (`product.catalog_audit`)، سير العمل الإبداعي ذي الـ6 مراحل (`creative.workflow_plan`)، الفصل الثلاثي (`executed / verified / unverified` في `buildTruthPartition` وواجهة `/agent`)، ومؤشرات الأداء الستة (`computeAgentMetrics` ونقطة `GET /api/agent/metrics`).
    - نجاح جميع الاختبارات المحلية (**280/280** في `npm test`).
  - **إضافة حزمة التدقيق الموقّعة واستئناف وحذف الخيوط وضبط متغيرات البيئة ([DEC-024](DECISIONS.md#dec-024--حزمة-التدقيق-الموقعة-audit-bundle-واستئناف-وحذف-الخيوط-ux-001-وضبط-متغيرات-البيئة)):**
    - إضافة `GET /api/agent/runs/:id/audit-bundle` (`bundle_sha256`) و`DELETE /api/agent/threads/:id` وقائمة اختيار الخيوط السابقة في `/agent`، ودعم `PHONE_NUMBER` كبديل توافقي لـ`APP_OWNER_PHONE_E164`.
    - نجاح جميع الاختبارات المحلية (**280/280** في `npm test`) ونجاح تشغيلة GitHub Actions CI رقم **`40599659235`** (الـCommit `f0114b3bddca5605ea5d4c2c820b99c011aed400` على الفرع `arena/981ee27e-phone-google`) في جميع الوظائف الست: `MySQL 8.4` (`122524304770` في 43 ثانية)، `RTL dashboard · Playwright Chromium` (`122524304986` في 44 ثانية)، `Node 22` (`122524304995` في 25 ثانية)، `Node 24` (`122524305136` في 32 ثانية)، `Python 3.11 Spider` (`122524305019` في 20 ثانية)، و`Node 24 Container` (`122524305069` في 22 ثانية).
  - **توظيف الأسرار الـ18 جميعًا وبوابة Cloudflare Worker والنشر الآلي الموقّع ([DEC-025](DECISIONS.md#dec-025--توظيف-جميع-أسرار-المستودع-الـ18-وبوابة-cloudflare-worker-والنشر-الآلي-الموقع-1818-secrets-wiring--edge-release)):**
    - توسيع `buildSecretsReadiness` و`scripts/check-secrets-wiring.mjs` و`.github/workflows/celia-mcp.yml` لتتبع وفحص **18/18 سرًا** مع صفر تسريب، وإضافة `GET /api/cron/status` و`POST /api/cron/probe` و`GET /api/storage/r2/status`.
    - إضافة خادم الحافة `workers/celia-edge/worker.js` وسكربت `scripts/deploy-cloudflare-edge.mjs` وسير عمل `.github/workflows/cloudflare-deploy.yml` وتفعيل نشر الإصدار الموقّع `v0.2.1` في `.github/workflows/release.yml`.
  - **بروتوكول التفوق واكتساب المستخدمين وحزمة Benchmark الـ20 حالة وإنفوجرافيك `/protocol` ([DEC-026](DECISIONS.md#dec-026--بروتوكول-التفوق-واكتساب-المستخدمين-user-switch--product-superiority-protocol-benchmark-الـ20-حالة-وإنفوجرافيك-protocol)):**
    - إضافة [src/agent/automation/benchmark.js](../../src/agent/automation/benchmark.js) (`BM-01..BM-20` بـ20/20 PASS وصفر قبول/رفض خاطئ وثبات إعادة تشغيل 100%)، وصفحة الإنفوجرافيك المعماري العربي التفاعلي [public/protocol.html](../../public/protocol.html) (`/protocol`)، ووثيقة [docs/user-switch-protocol.md](../user-switch-protocol.md)، واختبارات [test/agent-benchmark-20.test.js](../../test/agent-benchmark-20.test.js).
    - التحقق الحي الآلي في `.github/workflows/pages.yml` لجميع المسارات العشرة على GitHub Pages، ومزامنة أصول الإصدار الموقّع `v0.2.1` في `.github/workflows/release.yml` مع أحدث التزام على `main`.
  - **الفحوص المحلية وفحوص GitHub Actions CI الفعلية (`Verification Closure`):**
    - محليًا: `npm test` **268/268** ناجحة (منها 7 اختبارات في `test/agent-document-automation.test.js` و10 اختبارات
      `CL-01..CL-10` في `test/agent-comprehension-gate.test.js`)، و`check` و`release:check` و`check:continuity`
      و`check:secrets` و`build:pages` كلها خضراء.
    - في GitHub Actions CI على الفرع `arena/5fccc4e6-phone-google`:
      - التشغيلة الأولى `40592598360` (`6bf47b3`) كشفت تجاوز طول مخرج `data.report` لسقف `VARCHAR(4000)` في
        `agent_tool_runs.outcome` تحت وضع `STRICT_TRANS_TABLES` في MySQL 8.4؛ عُولج بضبط حجم التقرير ليظل `< 4000`
        حرف وتثبيت الحد `4000` في `src/agent/store.js`.
      - التشغيلة الثانية **`40593284086`** (الـCommit `99b789582911043f6d1cd45aa9ca9f135cd380f0`) **نجحت بالكامل في جميع
        الوظائف الست**: `Node 22` (`122502699179`)، `Node 24` (`122502699163`)، `Python 3.11 Spider` (`122502699173`)،
        `Node 24 Container` (`122502699186`)، **`RTL dashboard · Playwright Chromium`** (`122502699198` في 48 ثانية)،
        و**`MySQL 8.4 · persistence / N−1 / backup restore`** (`122502699207` في 45 ثانية شاملة `DEC-019` و`DEC-020` و`DEC-021`).
    - **ما يظل مغلقًا (`not-verified`):** النشر الحي على Render وAiven MySQL وتشغيل `verify:live` على رابط عام.

## الطلب السابق — الخطوات التالية للتشغيل الحقيقي (DEC-018)

**الفرع `arena/0220ec0b-phone-google` بُني فوق فرع PR #36 (`daf815a` مدمج فيه)** لأن كل خطوة تعتمد على DEC-017
وقائمة §5. الترتيب الصحيح: دمج #36 ثم هذا الفرع (أو دمج هذا الفرع وحده فيحمل #36 معه).

- **حقائق جديدة بالدليل الحي (تُبطل ادعاءات الصباح):**
  - **Pages مفعّل:** `gh api repos/…/pages` يعيد موقعًا بـ`build_type: workflow`، `https_enforced: true` على
    `https://celiaelazamey-arch.github.io/phone-google/`. لكن **لم يُنشر شيء بعد**: آخر `pages.yml` على `main`
    (`4d4eb85`، 14:58) سبق التفعيل فكانت خطوة Configure Pages `outcome=failure` وتخطّى الرفع/النشر؛ ومحاولة
    `gh workflow run pages.yml --ref main` من هذه الجلسة ⇒ `403`. **أول دمج إلى `main` هو ما سينشر.**
  - **PR #34 خطر مفتوح:** Revert لـPR #33 (الـoutbox وموصل التقويم) أُنشئ بعد دمج #33 بـ24 ثانية،
    `mergeable: UNKNOWN`. دمجه يكسر #35 و#36. التوصية إغلاقه بلا دمج — **لم أغلقه** (قرار المالك).
  - PR #36: مفتوح، `mergeStateStatus: CLEAN`، الفحوص السبع خضراء. المستودع عام.
- **ما نُفِّذ هنا (كود + اختبارات، بلا نشر):**
  - **الاستعادة عند الإقلاع (DEC-018):** `runtime.recoverOnBoot()` = `outbox.recoverStale()` ثم `resumePending()`؛
    `agentHost.recoverOnBoot()` لا يرمي ويسجّل `status().bootRecovery`؛ `scheduleBootRecovery()` موصولة بعد
    `listen` في `src/celia-mcp.js` و`src/server.js`. **معطّلة افتراضيًا** (`CELIA_AGENT_RESUME_ON_BOOT=false`).
    `test/agent-boot-recovery.test.js` (5): نية `dispatching` مهجورة ⇒ `unknown` بلا استدعاء موصل؛ تشغيل
    `queued` يكتمل؛ استدعاء غير محسوم ⇒ `needs_reconciliation`؛ الإقلاع الثاني لا يغيّر شيئًا؛ قيمة خاطئة
    للمتغيّر خطأ معلن.
  - **القبول الحي أمر:** `scripts/verify-live.mjs` + `npm run verify:live -- --url https://…` (7 فحوص آلية +
    4 بنود `manual`؛ الرمز من البيئة فقط ولا يُكتب؛ المضيف فقط في التقرير؛ رمز خروج 1 عند أي إخفاق).
    `test/verify-live.test.js` (5): التطبيق الحقيقي على ذاكرة صريحة **يفشل**؛ خدمة مثالية تنجح؛ عدم تطابق
    commit إخفاق؛ https إلزامي؛ CLI يكتب تقريرًا منقّحًا.
  - **الوثائق:** `docs/go-live-plan.md` (الأركان السبعة، البوابات، تسلسل الأيام الأولى، أربعة قرارات للمالك)،
    تحديث `deploy/free-always-on/README.md` (حالة Pages، المتغيّر الجديد، §5 بالأمر) وعقده، `docs/agent-runtime.md`،
    `.env.example`، DEC-018، BACKLOG (AGENT-001، HOST-003، OPS-004)، CHANGELOG.
- **ما لم يُنفَّذ ويحتاج المالك:** دمج/إغلاق PRs، حسابات Aiven/Render، الأسرار، الترحيل على قاعدة حقيقية،
  النداء الدوري، تشغيل `verify:live` على رابط حقيقي. **الحالة ما زالت `not-verified`.**
- **قرارات مطلوبة الآن (§4 من الخطة):** دمج #36 وإغلاق #34؟ · العمودي الأول (تقويم عبر WhatsApp؟) · مزوّد
  المخطط اللغوي (Gemini غير المدفوع يستخدم المحتوى ويراجعه بشر — [الشروط](https://ai.google.dev/gemini-api/terms)) ·
  سياسة الاحتفاظ (DATA-004).

## الطلب السابق — تشغيل دائم مجاني بلا بطاقة (DEC-017، PR #36)

**الجواب الصريح: «دائم مضمون» غير موجود مجانًا وبلا بطاقة على أي مزوّد.** Render Free بلا بطاقة لكنها تنام
بعد 15 دقيقة خمول وتُوقَظ في ~دقيقة، وبحصة **750 ساعة/شهر** — أي أن خدمة واحدة تعمل بلا توقف تستهلك 744 ساعة
في شهر 31 يومًا، فلا مجال لخدمة ثانية. لذلك الخطة الحرة = خدمة `web` واحدة + نداء دوري كل 10 دقائق يمنع
النوم + Aiven Free MySQL + واجهة ثابتة لا تنام أصلًا.

- **ما أُنجز في هذه الجلسة (كود ووثائق واختبارات، بلا نشر):**
  - `deploy/free-always-on/README.md`: خطة تنفيذية بالحساب والأرقام والمصادر، وجدول المتغيّرات، وقائمة قبول
    قابلة للتأشير، وحدود صريحة (لا SLA، لا نسخ احتياطي، حصة حدّ صلب).
  - **ثغرة صدق أُغلقت في الواجهة الثابتة:** `public/agent.html` في نسخة Pages كانت تنادي `/api/agent/*`
    فلا يعترضها المحاكي فترتد 404/HTML بصمت. أُضيف اعتراض صريح لـ`GET /api/agent/status` يعيد
    `enabled:false, mode:off` ويحيل إلى الخدمة الحقيقية بحالة **`verified:false`**. ولا تُحاكى موافقة ولا
    مصالحة في المتصفح (اختبار يثبت أن مسارات الكتابة غير معترضة).
  - `GET /api/deployment/hosting` في الطبقة الثابتة: يقول «معاينة ثابتة» و`verification: not-verified`
    ويشير إلى الخطة، مع رفض البناء لأي `CELIA_REAL_SERVICE_URL` غير https.
  - تصحيح تعارض قديم في `docs/free-hosting.md` (كان يمنع النداء الدوري مطلقًا): النداء الدوري استهلاك
    مقصود داخل الحصة، لكنه ليس تشغيلًا مضمونًا.
  - اختبارات: `test/free-hosting-plan.test.js` (4) عقد مستند↔`render.yaml` في الاتجاهين، و3 اختبارات في
    `test/static-shim.test.js`. الإجمالي المحلي **236** اختبارًا.
- **ما لم يُنفَّذ ويحتاج المالك:** إنشاء حساب Aiven/Render، إدخال الأسرار، **تفعيل Pages** (صلاحية الرمز
  تعيد `403 Resource not accessible by integration` — أُعيد فحصها الآن)، تطبيق ترحيلات `agent_*` على قاعدة
  حقيقية، وتنفيذ قائمة القبول §5 بيده. حتى ذلك الحين لا يُقال «متحقق» ولا «24/7».

## الطلب السابق — سد فجوات وإغلاق ثغرات (DEC-016، مدموج في PR #35)

دُقّق الكود الفعلي على `0a0fa2f`، ثم نُفِّذ النطاق القابل للإثبات هنا (G1–G5 من الخطة) ولم يُدَّع ما لم يُختبر.

- **G1 — المصالحة مخرج، لا طريق مسدود:** كان تشغيل `needs_reconciliation` يُرفض فيه `approve()` بـ
  `409 reconciliation_required` ولا مسار يغيّر حالة الاستدعاء، فيبقى ميتًا. الآن
  `POST /api/agent/runs/:id/reconcile` (مالك فقط) يسجّل قرار `applied`/`not_applied` على `tool_run` أو `outbox`،
  **بلا أي استدعاء موصل**، ويستأنف التشغيل فقط إذا لم يبقَ صف غير محسوم.
- **حدود القرار:** لا يُصالح إلا `unknown`/`started` أو `dispatching` بlease منتهٍ (`409 target_not_reconcilable`
  لغير ذلك)، والهدف من تشغيل آخر `400 target_not_in_run` بلا كشف وجوده، ودخول مالك آخر `404` على كل سطح.
- **قرار واحد = حقيقة واحدة:** الاستدعاء والنية المتقارنان بنفس `idempotency_key` يُسوَّيان معًا، فلا تبقى
  نية `sent` مع استدعاء `unknown`.
- **G2 — إعادة محاولة `failed`:** النية الفاشلة تُقبل معها `not_applied` + `resume: true` فقط، وتُعاد بنفس الصف
  والمفتاح ثم تُرسل مرة واحدة بعد قرار مسجل. **ومفتاح الموافقة صار مربوطًا ببصمة الحمولة**
  (`approval:<run>:<tool>:<hash12>`) فلا تركب حمولة مختلفة على قرار سابق — ثغرة أُغلقت بالاختبار.
- **G4 — المُتحقِّق:** فحص `reconciliation_evidence` (نتيجة معلنة محسومة بلا مدخل في السلسلة ⇒ `BLOCK`) و
  `reconciliation_reference` (أثر مؤكد بلا مرجع ولا ملاحظة ⇒ `UNKNOWN`)، ومحاولة فاشلة عولجت بـ`not_applied`
  لم تعد تمنع تسليمًا لاحقًا ناجحًا.
- **G5 — السطح:** لوحة «المصالحة والإعادة» في `/agent` بأزرار صريحة وملاحظة/مرجع، وأحداث
  `reconciliation.recorded`/`run.reconciled` عبر SSE.
- **الفحوص:** `npm test` **229** اختبارًا، **228** ناجحًا محليًا، والإخفاق الوحيد هو `N/N−1` البيئي القائم
  (استنساخ ضحل بعمق commit واحد). `check` 87 ملفًا، `release:check` 0.2.1/schema 1، `check:continuity`،
  `check:secrets`، `build:pages` 8 صفحات، `audit` 0 ثغرات. **لم يُشغَّل** `test:mysql` ولا `test:browser`
  (لا MySQL ولا Chromium هنا).
- **الحدود المعلنة:** لا ترحيل SQL جديد ولا تغيير في `schema 1` أو الإصدار أو أدوات MCP؛ ولا موصلا
  WhatsApp/Drive، ولا تخطيط لغوي، ولا عزل AGENT-003، ولا استئناف تلقائي عند الإقلاع، ولا نشر.

## الطلب السابق — «ابدأ AGENT-002» (outbox + موصل، منفذ ومدموج)

المالك اختار صراحةً متابعة AGENT-002 بعد دمج PR #32. نُفِّذت الشريحة البرمجية كاملة على الفرع الحالي، إضافية فقط:

- **جدول `agent_outbox`** (`sql/migrations/0004_agent-outbox.sql`): نية واحدة لكل أثر، مفتاح `idempotency_key`
  فريد، حالات `pending/dispatching/sent/failed/unknown/cancelled`، lease، مرجع خارجي، وخطأ آمن بلا محتوى خام.
- **الترتيب: نية → قرار → إرسال.** البوابة تسجل النية `pending` قبل طلب الموافقة فيرى المالك الحمولة الدقيقة
  (بما فيها الوقت المقترح حتميًا) قبل أي قرار؛ والرفض يحوّلها `cancelled` فلا أثر خارجي إطلاقًا.
- **إرسال واحد مضمون:** ادعاء شرطي من `pending` فقط؛ صف `dispatching` لا يُدعى ثانية أبدًا — إن انتهت مهلته
  يُسوّى `unknown` للمصالحة، لأن الطلب قد يكون وصل (DEC-007). `recoverStale` يسوّي ولا يرسل.
- **تصنيف فشل صريح:** `failed` فقط عند إثبات عدم الوصول (تحقق/مصادقة/4xx عدا 408 و429)، وكل التباس `unknown`.
- **المُرسِل لا يعتمد على المخطط:** `drainApprovedIntents` تصرّف النوايا المعتمدة قبل سؤال المخطط، فلا تبقى
  موافقة معتمدة بلا تنفيذ.
- **موصل التقويم** (`src/agent/connectors.js`) فوق تفويض Google القائم نفسه: `iCalUID` حتمي من مفتاح الـoutbox،
  وتكرار المزوّد يُفسَّر مصالحة لا موعدًا ثانيًا. الافتراضي **بلا موصلات** (`CELIA_AGENT_CONNECTORS=none`)
  فتبقى `external_connector_unavailable` بدل ادعاء قدرة غير مهيأة.
- **المُتحقِّق** حصل على أربعة فحوص: `outbox_approval`، `outbox_outcome`، `outbox_evidence`، `outbox_tool_run_parity`.
- **الأسطح:** `GET /api/agent/runs/:id/outbox` ولوحة outbox في `/agent`.
- **الفحوص:** 211 اختبارًا، 210 ناجحة محليًا، والإخفاق الوحيد هو اختبار N/N−1 البيئي القائم (استنساخ ضحل).
  `npm run check` و`check:continuity` و`check:secrets` ناجحة. **لم يُشغَّل** `test:mysql` ولا `test:browser`
  محليًا (لا MySQL ولا Chromium في الساندبوكس).
- **CI (run `40517989595` على `77d5d50`):** MySQL 8.4 ✅ (37 ث؛ ترحيل `0004` و9 جداول ومسار إرسال حي على
  InnoDB)، Node 22/24 ✅، container ✅، Python ✅. وظيفة المتصفح أُلغيت عند حد 12 دقيقة لأن تثبيت Chromium
  استغرق 734 ثانية (13 ثانية فقط للاختبار) — حادثة بنية تحتية موثقة في سجل الجلسة، وأُعيد تحفيز التشغيل بدفعة
  توثيقية. لم تُخفَّف أي بوابة ولم يُحذف أي اختبار.
- **الحدود المعلنة:** لا موصل WhatsApp/Drive بعد، لا إعادة محاولة تلقائية لـ`unknown` (تصميمًا)، لا عزل AGENT-003،
  ولا ترحيل إنتاج من هذه البيئة.

## الطلب السابق — حوكمة الوكيل (DEC-014، مدموج في PR #32)

بعد تحليل فجوات خريطة الوكيل (بوابة موافقات مسدودة، غياب عقد هدف ومُتحقِّق وأدلة متسلسلة)، نُفذت الشريحتان 2 و3
من خارطة الطريق على فرع نظيف من أحدث main. كل تشغيل الآن يحمل عقد بيانات، وكل قرار موافقة يُحفظ ويُستأنف،
وكل حقيقة تُقيَّد في سلسلة بصمات، ولا تسليم بلا حكم مستقل.

- **عقد الهدف:** `src/agent/goal-contract.js` + جدول `agent_goal_contracts` — معايير نجاح وقيود وشروط توقف
  وميزانية وموعد نهائي، بناء حتمي من حدود التشغيل وتحقق بنيوي آلي.
- **بوابة الموافقات:** جدول `agent_approvals` + `POST /api/agent/runs/:id/approval` (و`GET .../approvals`) —
  قرار `approved`/`rejected` بمفتاح idempotency وممثل وملاحظة. **القاعدة الصارمة:** استدعاء `unknown`/`started`
  يمنع الاستئناف بـ`409 reconciliation_required`؛ الرفض يلغي بلا أثر؛ الموافقة بلا منفذ outbox تنتهي
  بـ`external_connector_unavailable` لا بنجاح وهمي.
- **سجل الأدلة:** `src/agent/evidence.js` + جدول `agent_evidence` — إضافي فقط، `prev_hash`/`hash` من SHA-256
  وجذر genesis لكل تشغيل؛ كشف العبث/الحذف بالرقم والسبب في الاختبارات؛ والاستدعاء المقطوع يُعاد بناؤه كمدخل
  `tool_call_reconciled` صادق.
- **المُتحقِّق المستقل:** `src/agent/verifier.js` بأحكام `PASS`/`BLOCK`/`UNKNOWN` وسبع فحوص، خطوة `verify`
  إلزامية قبل `deliver`؛ إعادة تنفيذ القراءات الحتمية المعلّمة صراحةً فقط، و`UNKNOWN` معلن للآثار غير القابلة
  للقراءة بدل التخمين.
- **الترحيل:** `sql/migrations/0003_agent-governance.sql` إضافي بثلاثة جداول (8 جداول `agent_*` الآن)؛ الجداول
  الخمسة الأساسية و`schema 1` والإصدار `0.2.1` بلا مساس. SQLite ينشئها عند الفتح، MySQL عبر سجل الترحيل.
- **الواجهة:** `/agent` تعرض العقد ولوحة الموافقات (قرار وملاحظة) وسجل الأدلة وشارة الحكم وسلامة السلسلة.
- **الفحوص:** 31 اختبارًا جديدًا (4 عقد + 9 موافقات + 6 أدلة + 8 تحقق + 4 مسارات HTTP)؛ الإجمالي 185، الأخضر
  المحلي 184 والإخفاق الوحيد عائق استنساخ git ضحل قائم قبل الجلسة (اختبار N/N−1 يحتاج عمق التاريخ الكامل).
  فحص حي على خادم كامل: تدفق انتظار→موافقة→استئناف→`succeeded` بحكم PASS وسلسلة 7 مداخل، والرفض→`cancelled`.
- **الحدود المعلنة (سياق تاريخي — تجاوزها DEC-015):** حينها لم يكن هناك outbox ولا اتصال خارجي فعلي (باقي
  AGENT-002)، ولا عزل sandbox (AGENT-003)، ولا مخطط لغوي، ولا ترحيل MySQL حي من تلك البيئة. الـoutbox نُفِّذ
  لاحقًا في جلسة 2026-10-27-agent-outbox.

## طلب أقدم — «نفذ بالكامل بشكل انتاجي» (شبكة المعرفة KB-01…KB-004، مدموج)


بعد تصميم شبكة المعرفة نصيًا، أمر المالك بتنفيذها إنتاجيًا. المنفَّذ الآن في `src/knowledge/` و`src/kb-routes.js`
و`public/kb.*` و`data/kb/` و`scripts/kb*.mjs`:

- **السجلات:** 5 ملفات CSV (56 صفًا) مولّدة من الكود، مع `manifest.json` ببصمات SHA-256؛ تعديل يدوي بلا `kb:manifest`
  يُفشل الاستيراد. كل صف يحمل ترخيصًا وثقة ومصدرًا، وأي سر أو خطر مخالف لـ`CANONICAL_TOOLS` يُرفض برمزه وسطره.
- **المخزن:** SQLite + FTS5 بمخطط إصدار 1 مستقل عن `schema: 1`؛ `UNIQUE(content_hash)`، `item_aliases`،
  `absent_since` بدل الحذف، وكل كيان/حافة لها `evidence_item_id` إلزامي.
- **الاسترجاع:** تطبيع عربي مع خريطة إزاحات، توسيع سوابق/لواحق عند الاستعلام فقط، و`score = 0.55 lexical + 0.20 trust
  + 0.15 freshness + 0.10 graph`، وحزمة أدلة بسقف `limit/maxChars` وإعلان `truncated/omitted`، وسبب صريح عند عدم المطابقة.
- **الأسطح:** `/api/kb` مالك فقط بلا كتابة، و`import` معطّل إلا ببوابة صريحة؛ `kb.search`/`kb.tool_profile`/
  `kb.project_context` أدوات وكيل قراءة فقط تُسجَّل فقط عند `CELIA_KB=sqlite`، والمخطط يسرد المراجع الفعلية في التسليم
  ويعمل بلا LLM. صفحة `/kb` عربية RTL ببناء DOM آمن.
- **الأدلة المقاسة:** `verify` 56 مضافًا/55 حافة/0 مرفوض · إعادة استيراد `unchanged 56` · «كيف أربط جوجل» → 3 نتائج ·
  «موعد تقويم» → كيان التقويم بخطره وموافقته · `npm test` **153/153** · `check` 78 ملفًا · `celia:mcp:verify` 12 أداة بلا تغيير.
- **الحدود المعلنة:** Drive غير مزامن، لا embeddings ولا بحث دلالي، تخطيط حتمي لا لغوي، فهرس محلي لا يُدَّعى دوامه
  (`status.durability.persistent=false`)، والنسخة البعيدة المشفرة غير منفذة (KB-004 باقٍ). Claude/Drive/NAS ليست بديلًا موثقًا.
- **CI حقيقي أخضر على `dc17493` (run `40502456740`):** الوظائف السبع ناجحة (Node 22/24، MySQL 8.4، الحاوية،
  المتصفح RTL، Python)، وخطوتا المعرفة — `verify/import/search/entity/stale` و«التصدير ثم الاستعادة» — ناجحتان
  داخل وظيفتي Node. هذا دليل CI لا دليل إنتاج.

## الطلب السابق — AGENT-001/M1 + COMP-003 (مكتمل جزئيًا ومدموج)

طلب المالك: **«بقدر ما تستطيع»** — تنفيذ فعلي لا خطوات، وتوقف صريح عند أي بطاقة/تكلفة. في هذه الجلسة نُفِّذ
المسار الوحيد القابل للإثبات بلا حساب خارجي: **حلقة الوكيل M1** ومعه **سجل الترحيل**.

- **منفذ ومختبر (AGENT-001 جزئيًا):** `src/agent/{drivers,store,runtime,tools,planner,index}.js` + `src/agent-routes.js`
  + `public/agent.{html,css,js}`: خيوط/رسائل/تشغيلات/خطوات/استدعاءات دائمة، قفل lease، استئناف من آخر خطوة مؤكدة،
  `needs_reconciliation` لأي استدعاء غير محسوم، إلغاء، ميزانيات خطوة/تكلفة/زمن، بوابة مخاطر، SSE، وملكية على كل صف.
  التخزين صريح: `CELIA_AGENT_RUNTIME=mysql|sqlite`، والافتراضي `off` — **لا ذاكرة ولا ارتداد صامت**.
- **منفذ ومختبر (COMP-003 جزئيًا):** `scripts/migrate.mjs` + `sql/migrations/0002_agent-runtime.sql` مع سجل
  `schema_migrations` وبصمات SHA-256 ورفض drift وdry-run افتراضي؛ الجداول الخمسة الأساسية و`schema 1` بلا مساس.
- **الفحوص المحلية:** `npm test` **124/124** (منها 25 اختبارًا جديدًا)، `npm run check` 69 ملفًا، `release:check`
  0.2.1/schema 1، `check:continuity` ناجح، `check:secrets` ناجح، `celia:mcp:verify` 12 أداة، `build:pages` 7 صفحات،
  `npm audit` 0 ثغرات.
- **CI حقيقي أخضر على `5cfa05d` (run `40499146250`):** Node 22/24 و**MySQL 8.4** — والوظيفة الأخيرة شغّلت اختبار
  الوكيل الجديد على MySQL حقيقي: الترحيل `0002_agent-runtime.sql` طُبق مرتين (idempotent)، وحلقة كاملة نُفذت
  ودُهست، وتكرار `client_message_id` لم يُنفّذ ثانيًا، واستدعاء منقطع أصبح `unknown` بلا إعادة. **هذا دليل MySQL
  الحقيقي الوحيد؛ لا يوجد اختبار على قاعدة إنتاج.**
- **لم يُنفَّذ محليًا ويُصرَّح به:** MySQL محلي (لا خدمة هنا؛ غطّاه CI)، اختبار متصفح محلي (لا Chromium؛ غطّاه CI)،
  مخطط لغوي/مزوّد AI (AI-002)، أثر خارجي (AGENT-002)، عزل (AGENT-003)، استئناف تلقائي عند الإقلاع، وأي نشر دائم.
- **النشر المجاني ما زال محجوبًا بصلاحية الحساب:** `gh api` يعيد `has_pages=false`، ومحاولة التفعيل من الجلسة ما زالت
  `403` — وأثبت تشغيل `Agent branch Pages preview` (`40497695505`) أن `configure-pages` مع `enablement: true`
  يفشل بالخطأ نفسه من داخل Actions. إذن نقرة المالك في Settings → Pages لا بديل عنها (HOST-003). لا Render/Aiven
  بلا بطاقة/تفويض.
- **الحد المعلن:** لا يُوصف النظام بأنه «مثل Manus». الحلقة حقيقية ودائمة، لكن التخطيط حتمي تجريبي والتنفيذ
  خارجيًا مرفوض بالتصميم حتى المراحل التالية.

## الطلب السابق — GOOG-002 (مكتمل ومدموج)

قال المالك: **«الغرض نظام متكامل مثل مانوس»** — أي أن الهدف المنتجي هو وكيل ينفّذ مهمة كاملة لا مساعد
يستدعي أداة واحدة. الاستجابة المنتجية الموثقة هي [خطة الوكيل](../agent-runtime-plan.md)
(تحليل قدرات Manus السبع، الفجوة الفعلية بالدليل من الكود، معمارية M1–M4، حدود مستحيلة على الطبقة المجانية)،
DEC-012، وأربعة صفوف AGENT. **جلسة تثبيت CLI الحالية لا تنفذ AGENT-001 ولا تضيف ادعاء قدرة** — النظام اليوم
مساعد موصول بأدوات، ووصفه بأنه «مثل Manus» ممنوع حتى إنجاز AGENT-001.

**منفذ (GOOG-001):** `src/consent-ticket.js` (تذكرة HMAC بعشرة دقائق ومفتاح مشتق بفصل نطاق) ·
`POST /api/google/consent-link` (مالك فقط) · `GET /auth/google?ticket=` عام يتحقق من التوقيع والصف غير المستخدم
قبل التحويل · أمر واتساب «اربط جوجل» يعمل فقط من `APP_OWNER_PHONE_E164`. **8/8 اختبارات** في
`test/google-consent.test.js` والمجموع **83/83**. **لم يُختبر ربط حي مع Google** (لا اعتماد ولا نطاق عام).

**منفذ (GOOG-002، مدموج في PR #28 عند `10b9b5d`):** `src/google-preflight.js` (10 فحوص بيئة بحالات
pass/warn/fail، بلا شبكة وبلا طباعة أي سر) · `npm run google:doctor` · `GET /api/google/preflight`
(مالك فقط) · قسم 6 في [دليل الربط](../google-connect.md). **تثبيت CLI في هذه الجلسة:** صار `--json`
يُخرج JSON وحده، مع الأمر الموثق `npm run --silent google:doctor -- --json` لمنع ترويسة npm؛ أُضيفت
3 اختبارات CLI للنجاح والفشل وعدم التسريب، فصارت فحوص GOOG-002 **15/15** والمجموع **98/98** و`npm run check`
على **62** ملفًا. **PR #27 وPR #28 مدموجان**، وتثبيت CLI محفوظ في [PR #29](https://github.com/celiaelazamey-arch/phone-google/pull/29) للمراجعة؛ لا يثبت الفحص قبول Google نفسه ولا يُغني عن `200` حي.

**سياق (جلسة جوجل):** المالك أرسل مقتطف ربط Google من محادثة أخرى ليُضاف إلى `src/server.js`. التدقيق بالكود أثبت أن
الربط **منفذ بالفعل** في `src/google.js` بشكل أقوى، وأن المقتطف غير صالح هنا: `require` في مشروع ESM، وملف
`server.js` لا يحوي مسارات، و`state: req.query.phone` ثغرة CSRF، وحفظ توكنات خامة في جدول غير موجود، ونطاق
`calendar` أوسع من الحاجة. لا يُنسخ. الفجوة الحقيقية = ملف اعتماد + نطاق HTTPS عام + رابط أحادي الاستخدام
(GOOG-001) للربط من واتساب بلا كشف Bearer.

**أربعة قرارات مطلوبة من المالك قبل M1:** مستوى الاستقلالية الافتراضي (موافقة لكل أثر خارجي أم تفويض مسبق
بنطاق) · العمودي الأول (Google Workspace أم WhatsApp أم ملفات) · الميزانية (مجاني حتى M2 أم عامل تنفيذ من
الآن) · تعدد المستخدمين (مالك واحد الآن أم عزل كامل من البداية).

## الطلب السابق (مكتمل/مستمر)

المستخدم وجّه في رسالة ثنائية الجزء: (1) التحقق من إنجاز «توظيف أسرار المستودع التسعة + إصلاح توافق MCP 0.2.0» — تحقّق: PR #24 مدموج بـ`017507b` وفحوصه كلها خضراء؛ و(2) بناء **Celia Google Spider v0.1.0** وفق مواصفة كاملة: حزمة `celia_spider/` (`google_drive.py` و`store.py` و`server.py` و`text_utils.py` و`config.py`)، فهرس محلي في `~/.celia_spider/knowledge.sqlite3` (يُعاد تحديده عبر `CELIA_SPIDER_DATA_DIR`)، ست أدوات MCP، حد 2000 ملف، أول ورقة Sheet فقط، **لا حذف تلقائي** لعناصر محلية غائبة عن Drive، **لا embeddings/بحث دلالي**، **ChatGPT خارج النطاق**، `.gitignore` لـ`credentials.json` و`token.json` وقاعدة البيانات، سكربتات Windows، README عربي بالمراجع، اختبارات unittest وpytest، ترخيص MIT، وتسليم مصدرًا + ZIP.

متطلبات ثابتة مستمرة: قواعد `AGENTS.md` (فرع البيئة فقط، لا تفويض تجاوز الفرع، استمرارية STATE + سجل الجلسة مع ملفات التنفيذ)، عدم كشف أي من أسرار المستودع التسعة ولا ملفات OAuth، عدم اختلاق محتوى (إن زوّد المالك `RULE.MD` يُحفظ حرفيًا وتُوثّق الفروق في `DECISIONS.md`)، وعدم إنشاء مستودع GitHub جديد أو دفع خارج الفرع المعطى دون تأكيد صريح.

## الواقع والهوية

- المستودع: `celiaelazamey-arch/phone-google`؛ خط الأساس لهذه الجلسة `10b9b5dd4ca81e7b53541819b795d369fd859120` (دمج PR #28 على `main`). طلبات PR #17 و#21 و#22 و#23 و#24 و#25 و#26 و#27 و#28 مدموجة.
- الفرع المعطى لهذه الجلسة: `arena/bc862105-phone-google` على خط أساس `c3c42e2` (دمج PR #29). تحقّق دائمًا من الفرع النشط ولا تنشئ أو تنتقل لفرع آخر. (`arena/69d96c03-…` و`arena/24d51c71-…` و`arena/051ed103-…` و`arena/20079390-…` و`arena/64505100-…` انتهت بعد الدمج ولا يُعدّل منها شيء.)
- الكود الحالي `0.2.1` / السابق `0.2.0` / `schema: 1` كما هي دون أي تعديل. جداول الوكيل `agent_*` إضافية عبر سجل ترحيل مستقل (DEC-013) ولا تغيّر مخطط الجداول الخمسة.
- كان المستودع مقتطاعًا (shallow) بعمق 1؛ نجح `git fetch --unshallow origin` في هذه الجلسة، فصار commit قاعدة 0.2.0 متاحًا وعمل اختبار N/N−1. أي استنساخ جديد يحتاج الخطوة نفسها قبل `npm test`.
- لا رابط Render/Aiven دائم منشأ (HOST-003 بانتظار تفويض المالك).

## سجل العمل السابق (مكتمل) — حزمة السبّابة SPDR-001

1. **حزمة `celia-google-spider/` (SPDR-001 / DEC-011) — مكتملة:**
   - 17 ملف مصدرًا: `pyproject.toml` (0.1.0، Python ≥3.11، MIT) و`LICENSE` و`.gitignore` معزول للاعتمادات والقوالب و`celia_spider/{__init__,config,text_utils,store,google_drive,auth,check,server}.py` و`tests/` (3 ملفات) و`install_windows.bat` و`run_server.bat` و`README.md` عربي، وأرشيف `dist/celia-google-spider-v0.1.0.zip` (متجاهل في Git، سلامته مختبرة).
   - الأدوات الست عبر stdio فقط: مزامنة (إدراج/تحديث بلا حذف)، بحث معجمي بمقتطف ومصدر، قراءة، استكشاف شبكة، مصادر، إحصاءات. خادم MCP يتوافق مع مخططتَي SDK (`MCPServer` مع ارتداد `FastMCP`) ومصافحة stdio حقيقية في الاختبارات تضبط الأدوات الست بالضبط.
   - الحدود مكتوبة في README الحزمة: قراءة فقط (`drive.readonly`)، Docs→نص وSheets→CSV للأولى فقط، بلا embeddings، بلا ChatGPT، بلا مزامنة حية قبل اعتماد المالك وملف اعتماده (SPDR-002).
2. **وظيفة CI اختيارية:** إضافة `spider` في `.github/workflows/celia-mcp.yml` (Python 3.11 بمفتاح SHA مثبت) لتشغيل `unittest` + `pytest` + `compileall` بلا أي بيانات اعتماد.
3. **الاستمرارية:** تحديث `STATE.md` وسجل جلسة جديد `sessions/2026-10-27-celia-google-spider.md`، صفّا SPDR-001/SPDR-002 في `BACKLOG.md`، DEC-011 في `DECISIONS.md`، ومؤشر الحزمة في `README.md` الجذري.

## تغيير سابق موثق (SPDR-003)

- `celia-google-spider/README.md` قسم «المراجع»: السطر المعنون «Python quickstart» كان يشير إلى
  `guides/manage-downloads` — صُحّح إلى `quickstart/python`، وأُضيف فهرس REST v3 ودليل التنزيلات
  كسطرين منفصلين، وبقي رابط الحصص. الروابط الثلاثة على المسار القانوني `/workspace/drive/…`.
- **تدقيق:** لا workflow يستخدم `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`؛ ذكر `pages.yml` لهما هو فحص
  تسرّب في `dist` فقط. إضافتهما إلى Repository secrets لا تفعّل مزامنة ولا أي خطوة بذاتها؛ وصولهما للتشغيل
  عبر `.env` المحلي أو متغيرات Render إلى `src/config.js` و`src/celia-mcp.js`.
- التفاصيل والفحوص في `sessions/2026-10-27-reference-link-fix.md`.

## التحقق الحالي

**جلسة حوكمة الوكيل (2026-10-27، الفرع `arena/9c083c60-phone-google`):** بيئة Node 22.22.3 بلا MySQL/Chromium.

- `npm test`: **185 اختبارًا، 184 خضراء**. الجديد 31 اختبار حوكمة (4 عقد هدف، 9 موافقات، 6 أدلة، 8 مُتحقِّق،
  4 مسارات HTTP). الإخفاق الوحيد سابق للجلسة: اختبار توافق N/N−1 يحتاج كائن commit الأساس في مستنسخ غير ضحل.
- `npm run check`: 83 ملف JS · `release:check`: `0.2.1`/schema 1 · `check:continuity`: ناجح ·
  `celia:mcp:verify`: 12 أداة · `build:pages`: 8 صفحات · `audit`: 0 ثغرات.
- فحص حي بخادم كامل (SQLite للوكيل، MySQL منحط معلن): انتظار موافقة → قرار → استئناف → `succeeded` بحكم PASS
  وسلسلة أدلة 7 مداخل سليمة؛ مسار الرفض → `cancelled` بلا أثر؛ رموز 400/401/409 مسلكها صحيح.
- ترحيل `0003_agent-governance.sql` **مطبَّق على MySQL 8.4 حي في CI ومتحقق منه**: وظيفة MySQL في run
  `40511042421` (PR #32) خضراء، واختبار التكامل يؤكد تطبيق الترحيلين معًا (`0002`+`0003`)، ووجود 8 جداول
  `agent_*`، واكتمال حلقة الوكيل على قاعدة حقيقية. لا تطبيق على قاعدة إنتاج — CI فقط على مخطط معزول مؤقت.
- **الحالة النهائية لـPR #32:** كل الفحوص السبع خضراء في run `40513964269` (آخر دفعة `b9d9529`): Node 22/24،
  MySQL 8.4، الحاوية، RTL للمتصفح (40 ثانية)، Python، الخارجي skipped. حادثة عابرة واحدة في run `40511560404`:
  إلغاء وظيفة المتصفح لمهلة 12 دقيقة **أثناء تنزيل Chromium قبل أي اختبار** (بنية تحتية، لا كود) — موثقة في سجل
  الجلسة، وإعادة تشغيل API محظورة (403) فحُفز المسار بدفعة توثيقية ونجح. المعاينة الحيّة على المنفذ 3000 لا تزال
  ترد 200 على `/healthz` و`/agent` و`/kb` و`/system`.

**الأرقام السابقة موثقة كما هي (جلسة شبكة المعرفة):** بيئة محلية Node 22.22.3 / npm 10.9.8، بلا MySQL أو Docker أو Chromium:

- `npm test`: **153/153** ناجحة بعد `git fetch --unshallow`. الجديد: `knowledge-normalize` 6، `knowledge-ingest` 9،
  `knowledge-store` 8، `kb-routes` 6، إضافة إلى اختبارات الوكيل 25.
- `npm run check`: ناجح — 78 ملف JavaScript.
- `npm run kb -- verify|import|search|export`: ناجحة على قاعدة نظيفة — 56 عنصرًا و55 حافة و0 مرفوض، والاستيراد الثاني متطابق.
- `npm run release:check`: ناجح — `0.2.1` / السابق `0.2.0` / `databaseSchema: 1`.
- `npm run check:continuity`: ناجح — 23 وثيقة و59 رابطًا و47 معرفًا بلا دورات.
- `npm run check:secrets`: ناجح · `npm run celia:mcp:verify`: ناجح — 12 أداة، `storage=memory` صريح.
- `npm run build:pages`: ناجح — 7 صفحات (`agent.html` و`kb.html` ضمنها) · `npm audit --omit=dev --audit-level=moderate`: 0 ثغرات.
- `npm run migrate` (dry-run) و`-- --apply` **لم يُنفَّذا**: لا MySQL في البيئة؛ الكود يرفض الذاكرة ويطلب قاعدة حقيقية.
- اختبارات المتصفح وMySQL 8.4 تُشغَّل في CI فقط. **لا نتيجة CI لهذه الجلسة بعد الدفع** — المرجع الحي هو PR الفرع.

## حدود لا يجوز نسيانها

- فرع الجلسة الحالية `arena/2edb2881-phone-google` هو الوحيد للعمل والدفع؛ أسماء الفروع في الأقسام التاريخية تخص جلسات منتهية بعد الدمج ولا يُعمل عليها. لا دفع إلى `main` ولا `workflow_dispatch` من الجلسة (403).
- أسرار المستودع التسعة لا تُقرأ ولا تُطبع ولا تُضاف لملفات الحزمة؛ و`credentials.json` و`token.json` ممنوعان من Git مهما طُلب من التوثيق.
- الحزمة ليست موصلة ChatGPT (خارج النطاق صراحةً) ولا تدّعي بحثًا دلاليًا ولا حذفًا تلقائيًا، ولا يُعلن نشرها كمكوّن من النظام قبل قبول المالك (SPDR-002).
- لا مستودع GitHub جديد ولا دفع خارج فرع الجلسة الحالي؛ لا releases ولا دمج/إغلاق PR من هذه الجلسة دون طلب صريح (ينطبق على #34 و#36).
- شبكة المعرفة ليست «بحثًا دلاليًا» وليست مزامنة Drive، ولا يُعرض فهرس محلي كأنه مخزن دائم على مضيف بلا قرص.
- إن زوّد المالك `RULE.MD`: حفظ حرفي في الجذر وتوثيق الفروق في `DECISIONS.md` دون اختلاق.
- مهام الخطة الأخرى تبقى كما هي في `BACKLOG.md` (COMP-001/DATA-001/SEC-001… ) دون ادعاء إغلاقها.

## الخطوة التالية بالضبط

> **مُحدَّث 2026-10-28 بعد النشر الحي (`DEC-038`):** البندان 1 و2 أدناه يخصّان **محرك Express + MySQL الكامل فقط** ولم
> يَعُدا عائقًا أمام النظام العامل: محرك الحافة الكامل منشور ومتحقَّق حيًّا بلا فيزا على
> `https://celia-phone-google.celiaelazamey.workers.dev` (التشغيلة `40719074394`). الخطوة التالية الفعلية الآن هي
> البندان 0.أ و0.ب (إجراءان في لوحات المالك، بلا أي بطاقة).

0. **المالك — الإجراءان المتبقيان للمسار بلا فيزا (دقيقتان، بلا بطاقة):**
   1. **ربط Google (`GOOG-001`):** Google Cloud Console → Credentials → عميل OAuth → إضافة Authorized redirect URI
      `https://celia-phone-google.celiaelazamey.workers.dev/auth/google/callback`، ثم
      `curl -sS -X POST https://celia-phone-google.celiaelazamey.workers.dev/auth/google/link -H "Authorization: Bearer $CELIA_MCP_API_TOKEN"`
      وفتح الرابط والموافقة. دليل الإغلاق: `GET /api/google/status` → `"connected": true`.
   2. **واتساب (`WA-005`, اختياري):** webhook تطبيق Meta على
      `https://celia-phone-google.celiaelazamey.workers.dev/webhooks/whatsapp` + الأسرار الأربعة `WHATSAPP_*` في GitHub
      Secrets، ثم إعادة تشغيل workflow **Deploy (Cloudflare Edge)**. دليل الإغلاق: تحدي Meta ينجح + `whatsapp_cloud_api verified`.

1. **المالك — المحرك الكامل بـMySQL (مؤجَّل، لا يعطّل النظام):** Render → New → Blueprint من `render.yaml`
   (تير Free) ← Aiven MySQL Free ← إدخال الستة `MYSQL_*` في Render Environment ← نسخ رابط الخدمة إلى `APP_BASE_URL`
   وإعادة النشر ← `npm run migrate -- --apply` مرة واحدة. **محجوب حاليًا ببوابة تفويض بطاقة `1$` (`DEC-034`)؛ البديل هو
   اختيار مضيف حاويات مجاني بلا بطاقة لحاوية GHCR.**
2. **المالك — تشغيل النشر المتحقَّق (خاص بمحرك MySQL):** GitHub → Settings → Secrets and variables → Actions:
   Variable `CELIA_LIVE_URL=https://<service>.onrender.com` · Secrets `RENDER_API_KEY` و`RENDER_SERVICE_ID`
   (أو `RENDER_DEPLOY_HOOK_URL`). أول push على `main` بعدها يشغّل `deploy-render.yml` تلقائيًا (نشر ← انتظار `/readyz`
   بـ`storage.mode=mysql` ← `verify:live --expect-commit` ← keep-alive كل 10 دقائق). **حينها فقط** يُكتب «منشور» عن
   المحرك الكامل؛ أما محرك الحافة فمنشور بالفعل بدليل `verify:live --mode edge` في `40719074394`.
3. **بعد النشر:** لصق تقرير `verify:live` في سجل جلسة جديد وتحديث HOST-003 إلى «متحقق»، ثم `backup:verify` (DATA-001)،
   ثم موصل WhatsApp في الـoutbox (AGENT-002)، ثم AI-001/AI-002 بعد قرار المزوّد
   ([docs/go-live-plan.md](../go-live-plan.md)).
4. **أي ادعاء «يعمل»:** شغّل `[reality]` واقرأ annotations الـrun؛ ولا يُكتب «منشور» عن أي نشر إلا ببوابة حية ناجحة على
   الرابط العام داخل نفس التشغيلة (`verify:live` للمحرك الكامل، و`verify:live --mode edge` للحافة)؛ لا يُستبدل بدليل محلي أو محاكاة.

## التحقق من الحفظ في الجلسة التالية

```sh
git branch --show-current
git status --short
git log -3 --oneline
gh pr list --state all --head "$(git branch --show-current)"
npm run check && npm run check:secrets && npm run check:continuity && npm test
cd celia-google-spider && python -m unittest discover -s tests -q
```
