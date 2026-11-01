# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 1 نوفمبر 2026 · **الجلسة الحالية:** VFE-009 / `DEC-089` — نشر أرقام Atlas بياناتٍ ليرسم منها أي أداة · **السجل:** [atlas-facts](sessions/2026-11-01-atlas-facts.md)
**الفرع:** `arena/89c49feb-phone-google` من `main@55ed7a2` (بعد #117). الدفع والدمج بكلمة المالك.

## 31 أكتوبر 2026 — DSN-002/‏3 (هجرة الألوان) — ملخّص

- **النتيجة:** قاعدة 48 (لون حرفي خارج `theme.css`) **244 ⇒ 0**، والقياس الساكن **283 ⇒ 43 FAIL**، والبصري **54 ⇒ 4**. رموز لكل صفحة `--t-<page>-*` + `--t-mask`/`--t-sheen`، والشفافية بـ`color-mix` من رمز لا برقم.
- **بوابتان أصلحتا نفسيهما:** تسمية الرمز بكلمة لون تُقرأ لونًا حرفيًا؛ و`THM-04` صارت «المبدّل يستلزم الرموز» + `SINGLE_IDENTITY`.
- **المولّد لا يُحرَّر:** `npm run computer:permissions` و`npm run build:edge-ui` بعد تغيّر `theme.css`.
- **التفاصيل والقواعد:** [color-tokens-migration](sessions/2026-10-31-color-tokens-migration.md) · [hallmark-pages-audit](../design/hallmark-pages-audit.md) · `DEC-080`.

## 31 أكتوبر 2026 — DOC-003 / DEC-081 (تدقيق البنية الإدراكية) — ملخّص

- **36 ادعاءً = 18 ✅ · 9 🟡 · 9 ❌** على صورة تدّعي حزامًا من تسع مراحل؛ الحقيقة **10 مراحل و10 مكونات**، ولا متصفح ولا Playwright ولا MCP كمصدر إدراك، والتعلم غير منفّذ.
- **التقرير:** [agent-cognitive-architecture-audit.md](../agent-cognitive-architecture-audit.md) · `DEC-081` · التصحيحات النصية في §8 منه.

## 1 نوفمبر 2026 — REL-002 / DEC-083 (تجميد الإصدارات)

- **العلة والإصلاح:** `v0.2.1` صار `immutable=true`، وخطوة النشر تُنفّذ `--clobber` فتسقط وحدها في كل دفعة. صارت تقرأ `.immutable` أولًا: عند `true` تحذير أن الحزمة لم تُنشر والحاجة إلى ترقية إصدار، ثم خروج `0`؛ والمسار غير المجمّد كما هو.
- **السجل:** [release-immutability](sessions/2026-11-01-release-immutability.md) · **القرار:** `DEC-083`.

## الجلسة الحالية — 31 أكتوبر 2026 — DOC-003 / DEC-082 (النسخة المصححة)

- **المخرَج:** [runtime-verified-architecture.html](../design/runtime-verified-architecture.html) + [PNG 2880×4828](../design/runtime-verified-architecture.png) — استبدال لا تلويين، استنادًا إلى §8 من [التقرير](../agent-cognitive-architecture-audit.md).
- **الأسماء حرفية:** `Goal` · `Plan` · `Select Tool` · `Policy Check` · `Approval` · `Sandbox Execute` · `Observe` · `Independently Verify` · `Persist Evidence` · `Update State` من `HARNESS_LIFECYCLE_STAGES` (`src/agent/harness.js:20`)، والعربي ترجمة تحتها لا اسم بديل.
- **سبعة أقسام:** الحزام العشري بتمييز المراحل الثلاث المضافة وفصل `Policy Check` عن `Approval` · المكونات العشرة مع `isolatedContainerAvailable=false` · **القيود التشغيلية المقيسة** (`RUNTIME=off` · `SANDBOX=off` · `CONNECTORS=none` · `SPIDER=off` · WhatsApp `configured=false`) · التصحيح الجوهري للإدراك (لا Browser، Playwright للاختبارات، MCP اتجاهه معكوس، `web.fetch` مقيّد و`web.search` مؤجّلة) · الوظائف السبع بالحكم · التصحيحات الستة · ما ثبت بالكود (DENY، بصمة الموافقة، سلسلة الأدلة، المتحقق المستقل).
- **عيبا عرض أُصلحا بالقياس:** الإيموجي رسم ▯ ⇒ وسوم نصية وأيقونات SVG؛ خلط الاتجاه ⇒ `unicode-bidi: plaintext` ليبقى رقم المرحلة على اليمين.
- **الخطوط محلية** من `public/fonts/`؛ صفر طلب خارجي، والملف يُفتح بلا شبكة.
### سجل الدمج وإصلاح المعاينة (أكتوبر–نوفمبر 2026)

- **عائق الدمج زال:** كان `BLOCKED` بسبب قاعدة `require_last_push_approval` وغياب `bypass_actors`؛ حُلّ بمنح المالك تجاوزًا لدوره (`RepositoryRole:5`)، ثم دُمجت #115 (`c4e28d4`) و#116 (`1993eeb`) و#117 (`55ed7a2`) بـsquash.
- **مسار المعاينة (`a53e0fc`):** الفرع صار مدخلًا لا نصًّا محفورًا، والنشر إلى Pages يشترط اختيارًا صريحًا و`vars.PREVIEW_PAGES=true` — وإلا فمخرَج مؤقت فقط. سير عمل الجلسة لا تستطيع تشغيله (403)، والتشغيل بضغطة المالك.

## 1 نوفمبر 2026 — GOV-002 / DEC-084 (صلاحيات CeliaOS 2026)

- **المخرج:** `src/agent/access-policy.js` — **66** صلاحية في ثمانية نطاقات، ستة مستويات كشبكة لا سلم، **10** منها للمالك وحده، **21** بموافقة مسجّلة، **5** حوكمة ذاتية، و**0** موصولة تشغيليًا.
- **المصفوفة مولَّدة** من الثوابت (`npm run access:policy`)، و`access:policy:check` في CI يمنع الانحراف؛ وكل صلاحية تشير إلى دليلٍ في المستودع يتحقق منه الاختبار.
- **الحد الصريح:** `admin` لا يبلغ `infra_admin` ولا `system_operator`؛ ولا تبلغ أي طبقة الأسرار أو البيئات أو الويب هوكس أو الإعدادات أو القواعد. **السجل:** [access-policy](sessions/2026-11-01-access-policy.md) · **القرار:** `DEC-084`.

## 1 نوفمبر 2026 — VFE-001 / DEC-085 (العرض البصري أولًا)

- **القاعدة:** لا تسليم بوصفٍ وحده. الحالات الخمس (🟢/🟡/🔵/🔴/⚪) والأشكال العشرة والترتيب الثماني في `AGENTS.md` و`docs/visual-first-engineering.md`.
- **الآلية:** `src/design/visual-registry.js` مصدر الحالة، و`docs/design/visual-first.html` مولَّد، و`visual:first:check` يرفض الانحراف ويرفض تسليمًا بلا «الدليل البصري».
- **الحالة الصادقة:** 11 مخططًا رئيسيًا: **1 🟢 · 6 🟡 · 4 🔴**؛ والفجوة التالية `Executor → Verifier → Evidence`.
- **السجل:** [visual-first](sessions/2026-11-01-visual-first-engineering.md) · **القرار:** `DEC-085`.

## 1 نوفمبر 2026 — VFE-003/004 / DEC-086 (الخريطة الحية)

- **الخريطة تُشتق من الكود:** 111 وحدة و237 اعتمادية داخلية، و16 مكوّنًا: **13 🟢 · 3 🟡**؛ والحالة من الاختبار، والتفعيل من المفتاح (⚪ لثلاثة مكوّنات).
- **الأثر:** `npm run arch:impact` يحسب الإغلاق العكسي على نفس الرسم.
- **التسميات صارت سبعًا:** أُضيف 🟠 و⛔ إلى السجل واللوحة.
- **المنتجات السبعة:** 2 🟢 · 2 🟡 · 3 🔴.
- **السجل:** [living-architecture-map](sessions/2026-11-01-living-architecture-map.md) · **القرار:** `DEC-086`.

## 1 نوفمبر 2026 — VFE-006 / DEC-087 (System Atlas)

- **التدقيق:** 12 مجالًا و54 قدرة: **39 🟢 · 9 🟠 · 6 🔴**، والمجالات **4 🟢 · 8 🟡**.
- **الغائب المسمّى:** اكتشاف التضارب · دمج الذاكرة · الإشعارات · تفويض الوكلاء · قناة التعاون · حل التعارض.
- **الترتيب:** P0 (5 مجالات) ← P1 (4) ← P2 (3)، وبوابة `atlas:check` تمنع أن تُرسم قدرة بلا ملف.
- **السجل:** [system-atlas](sessions/2026-11-01-system-atlas.md) · **القرار:** `DEC-087`.

## 1 نوفمبر 2026 — VFE-008 / DEC-088 (ملصق Atlas)

- **العلة:** ملصق المالك حمل أرقامًا لا تطابق التدقيق (نسب تغطية، وتوزيع P1/P2، وقدرات ✓ غير موجودة، وبصمة التزام `249f1b5` غير موجودة).
- **الإصلاح:** الملصق صار مولَّدًا من نفس التدقيق، ببصمة بيانات `13345e9ec0`، وفجوة مسمّاة على كل بطاقة، وبوابة `atlas:poster:check`.
- **السجل:** [atlas-poster](sessions/2026-11-01-atlas-poster.md) · **القرار:** `DEC-088`.

## 1 نوفمبر 2026 — VFE-009 / DEC-089 (حقائق Atlas)

- **العلة:** الملصق الثاني صحّح البصمة والمراحل والإجماليات، وبقيت **8 من 12** نسبة تغطية مخالفة، وبطاقة وكلاء تدّعي وكيلَي بحث وبرمجة.
- **العلة الجذرية:** البصمة تصدق على التدقيق لا على الصورة؛ والصورة تُنقل من نص.
- **الإصلاح:** `docs/design/system-atlas-facts.json` — الأرقام بياناتٍ (تغطية 60/80/40/25/80/100/100/75/25/100/75/100)، تُفحص مع الملصق في بوابة واحدة.
- **السجل:** [atlas-facts](sessions/2026-11-01-atlas-facts.md) · **القرار:** `DEC-089`.

## جلسات سابقة (ملخّصات، التفاصيل في `sessions/`)

- **31 أكتوبر — DSN-002/‏1 / `DEC-079`:** 12 صفحة بعد الهبوط. الساكن **386 ⇒ 283**، البصري **54 ⇒ 4**. `--t-field-edge` (1.45 ⇒ ≥3:1)، `--accent-fg` (3.03 ⇒ 6.03:1)، `outline: none` ⇒ 0، 13 حاجبًا و38 رمزًا تعبيريًا ⇒ 0، روابط تجاوز مقيسة، `computer-permissions` من مولّده. سجل: [dsn002](sessions/2026-10-31-dsn002-pages-design.md).
- **31 أكتوبر — DSN-001 / `DEC-078`:** تدقيق Hallmark على صفحة الهبوط **201 FAIL + 105 REFLEX ⇒ 0/0**، بوابة `LND-01..07`، وأُصلح تضخّم `dist` من 4.8MB إلى 1.4MB. منشور: PR #113 → `main@ec7da14`.
- **31 أكتوبر — MAN-002 / `DEC-077`:** بوابة `verify-edge-provenance` ترفض أي انحراف، ثم إثبات OIDC للبصمة (PR #111 → `main@4fc5112`). `gh attestation verify` غير متاح بالجلسة.
- **31 أكتوبر — MAN-001/003/005/007 (`DEC-074/075/076`):** عقد مُولَّد ببوابة انحراف، جاهزية مشتقّة، حاجز تكافؤ أدوات، و`known_good` (PR #110 → `main@d0c56bb`).
- **31 أكتوبر — WA-005/WA-007/VER-01 (`DEC-064/065/066`):** ربط WhatsApp Embedded Signup v5 على Cloudflare Edge/D1، حسابات ذاتية الخدمة وعزل لكل مستخدم. **الإنتاج يقول `configured=false`**: ناقص تطبيق Meta وconfig وapp secret ومفتاح تشفير؛ Code منشور والربط محجوب بإعدادات المالك (`DEC-073`). سجل: [whatsapp-embedded-signup](sessions/2026-10-31-whatsapp-embedded-signup.md).
- **29 أكتوبر — RELEASE-SIGNAL:** `system.html#releases` كانت تعرض نصف الحقيقة؛ `src/progress.js` يقرأ `Unreleased` من `CHANGELOG.md` ويعرضه بطاقة متقطّعة لا إصدار (`PRG-01..07`). سجل: [release-signal](sessions/2026-10-29-release-signal.md).
- **MANUS-GAP-PLAN:** 19 فجوة (G1..G19 + G20) وخطة S1..S8 وستة قرارات مالك في [agent-web-gaps.md](../agent-web-gaps.md).

## 0. خط الأساس والدرجة

- **الإصدار:** `v0.2.1` · `schema=1` · Node `>=22`. **لا ترقية إصدار ولا ترحيل جديد في هذه الشريحة.**
- **الجودة (بعد هذه الدفعة):** `npm test` **943 اختبارًا / 926 ناجحًا / 0 فشل / 17 skipped**؛ وقبلها `test:coverage` **943 / 942 / 0 / 1**، تغطية **92.28 / 77.43 / 86.95** (الأرضية 89/71/82). `check` 205 ملفًا، و`build:edge-ui:check` و`computer:permissions:check` و`manifest` و`secrets` و`release:check` و`build:pages` و`now:check` و`check:continuity` ناجحة.
- **السلّم:** S1/A4 ✅ · S5: C1-a ✅ · C1-b ✅ · C2-a ✅ · **C2-b (`web.search`) مؤجّلة** بقرار المالك · C3/C4 موقوفة على بيئة بلا Chromium.

## 1. حدود هذه الدفعة

1. **لا تغيير سلوك مرئي:** القيم المنقولة مطابقة بايتًا لقيمها (`system #0b1117`, `deploy #091512`, `protocol #070b14`, `computer #0b1030`, الهبوط `#0b0c10`)، ومُتحقَّق منها في متصفح حقيقي.
2. **لا استثناء في THM-02:** `theme.css` وحده يحمل الحرفي؛ `landing.css` و`fonts.css` المتبقيان خارج البوابة بقائمة ratchet صريحة تنكمش فقط.
3. **الملفات المولّدة لا تُحرَّر مباشرة:** `computer-permissions.html` من مولّده، و`workers/celia-edge/whatsapp-ui.generated.js` من `build:edge-ui` (يحزم `theme.css`).
4. **الإيجابيات الكاذبة مسجّلة لا معمَّمة:** قاعدة 67 على العربية، وقاعدة 49 على تسمية طويلة، وقاعدة 73 على نص داخل حاوية تمرير.
5. **لا أصل خارجي ولا ادعاء نشر:** الخطوط محلية، والصفحات ساكنة، والنشر يمر بمسار `main` المعتاد بعد كلمة المالك.

## 2. الاستئناف والفحوص

1. ابقَ على فرع الجلسة المعيَّن؛ اقرأ [سجل الهجرة](sessions/2026-10-31-color-tokens-migration.md) و[تقرير التصميم](../design/hallmark-pages-audit.md) قبل تعديل أي `public/*.css`.
2. **قاعدة التسمية:** لا تُسمِّ رمزًا بكلمة لون (`white`, `red`, `blue`…) — البوابتان (48 وTHM-02) تقرآنها لونًا حرفيًا. الاسم يصف الدور (`--t-sheen`, `--t-sys-bad`).
3. أي لون جديد يُضاف في `theme.css` فقط، وتستهلكه الصفحة بـ`var()`؛ والشفافية بـ`color-mix` من رمز لا برقم.
4. الصفحة التي تستورد `theme.css` بلا مبدّل يجب أن تُضاف إلى `SINGLE_IDENTITY` في `test/theme-tokens.test.js` (وإلا فشلت THM-04).
5. بعد أي تعديل في `theme.css` أو `styles.css`: `npm run build:edge-ui` وإلا فشل `VER-07`.

```sh
git branch --show-current && git status --short && git log -3 --oneline
npm run design:audit -- public/
node --test test/theme-tokens.test.js test/design-system-pages.test.js test/landing-design.test.js
npm run now && npm run now:check && npm run check:continuity
npm run check && npm run build:pages && npm run test:coverage
```
