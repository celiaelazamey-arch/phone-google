# L2 — الصدق البصري: `U9` هجرة الأوراق، `DSN-002` إلى صفر ساكن، `U4` عرض الخطة المشتق

- **التاريخ:** 5 نوفمبر 2026 · **الفرع:** `arena/e055d6db-phone-google` · **الأساس:** `22d49a3` (= `origin/main`) + مزامنة ما بعد الدمج `b69a619`
- **الإيداعان:** `aa3a024` (‏`U9` + تصفير الدين الساكن) · `50ecb8a` (‏`U4` شجرة الخطة)
- **الخطة:** [plan-live-operation-ui-2026.md](../../plan-live-operation-ui-2026.md) — الشريحة **L2 الصدق البصري**، ومعيار قبولها `design:audit` 0/0 + `visual:first:check` + `arch:map:check`
- **قرار المالك المطبَّق:** طيّ مزامنة ما بعد الدمج (`428cced` ⇒ `b69a619`) داخل PR الـ`L2` بدل PR منفصل، تعليلًا بتجنّب فتح PR لمجرد مزامنة وثائقية وحماية المستودع من تسجيل تجاوز `--admin` ثامن بلا داعٍ.

## 1) `U9` — هجرة `landing.css` إلى رموز السمة

**الأداة:** `/tmp/migrate-landing.mjs` (قابلة لإعادة الاستعمال لأي ورقة مستقبلية) بمرورين: قيم كاملة (`^#hex$`) ثم ألوان مضمّنة داخل قيم مركّبة (`color-mix`/`rgb`/منحدرات)، مع **تحقّق مرتّب لكل لون مضمّن** (`resolveExpr` مقابل الأصل لكل ظهور) ورفض الخروج بنجاح إن بقي لون ثابت.

**النتيجة المقاسة:** 112 إعلانًا أُعيدت كتابتها · **49 رمز `--t-lnd-shell-*` جديدًا** · **0 اختلاف لوني** · 0 لون ثابت خارج التعليقات · **217 رمز `--t-*` معرَّفًا في `theme.css` و0 مرجع معلّق** في كل أوراق الصفحات.

**بنية الرموز:** أُدرجت داخل كتلة `:root` الأخيرة في `theme.css` («مكوّنات الصفحة — لا تتغيّر مع السمة») **بلا تسميت**، لأن `landing.html` هوية واحدة بلا مبدّل سمة (DEC-080)؛ ولذا رُفعت خصوصية `color-scheme` في `landing.css` إلى `:root, :root:not([data-theme])` لتعادل خصوصية (0,2,0) في كتلة `prefers-color-scheme: light`.

**تصحيحتا تسمية فرضتهما `THM-02`** (البوابة تلتقط أسماء الألوان داخل المعرّفات لا في القيم فقط: `\b(?:white|black|…)\b(?=\s*[;,)!])`):
1. `--t-lnd-shell-base-white` / `-black` ⇒ **`-paper` / `-ink`** (23 + 2 موضعًا) — أي اسم رمز ينتهي بلون قبل `)` يفشل.
2. المتغيّر المحلي `--black` (`#111`، يُستعمل حبرًا على `--on-accent`) ⇒ **`--ink-solid`** + رمز `--t-lnd-shell-ink-solid`. **رُفض `--accent-ink`** لوجود `--accent-ink-1/2/3` (منحدر مرجاني مختلف `#a94a26/#9c4322/#8a3a1d`) فكان سيُلبس.
   - **درس مسجَّل:** `re.sub(r'--black(?![-\w])')` لا يلمس `--t-lnd-shell-black` (لا يحوي `--black` سلسلةً) ⇒ أنشأ مرجعًا معلّقًا؛ لذلك أُضيف `THM-07`. والإخوة المتصلة بشرطة (`--black-2`) آمنة.

**`landing.html`:** أُضيف `<link rel="stylesheet" href="./theme.css" />` **قبل** `./fonts.css` (شرط `THM-04` الحرفي) بتعليق يعلّل. بقي `<meta name="theme-color" content="#0b0c10">` لأن Meta لا تقبل `var()`، والبوابة تفحص `.css` فقط.

**الاختبارات:** `THM-02`: قائمة «لم تُهاجر بعد» **فارغة** (تنكمش فقط، وأي إعادة اسم تُبرَّر في DECISIONS) و11 ورقة في قائمة المهجَّرة. `THM-04`: ‏`SINGLE_IDENTITY` وقائمة `themed` تضمّان `landing.html`. **`THM-07` جديد:** كل `var(--t-*)` في أوراق الصفحات (بعد تجريد التعليقات) معرَّف في `theme.css`، مع `assert.ok(defined.size > 100)`. ‏`test/landing-design.test.js`: ‏`tokenBlock` يقبل قائمة محددات (`/^:root[^{]*\{/m`) بعد أن كان يرهن `':root {'` حرفيًا (رسالة مضللة: فشل `LND-06` لا `LND-04`)، ومساعدات `THEME/themeToken/parseColour/solidOf/hexOf` تجعل `LND-06` **يتبع سلسلة الرموز** عبر `theme.css` مع بقاء توقعات التباين 4.5:1 و3:1. ‏`#1a1c22` بقي في الاختبار لأنه مرجعه الخاص (غير موجود في `landing.css`). ⇒ `theme-tokens` **7/7** · `landing-design` **7/7**.

## 2) `DSN-002` — الدين الساكن 45 ⇒ 0، بصفر كبت

**القياس المرجعي:** `node vendor/hallmark/scripts/sloplint.mjs public --json` (لا `npm run design:audit`، فهو يطبع الاستعمال فقط). **قبل:** `fails:45` موزّعة `{67:30, 20:5, 39a:5, 19:3, 4:2}` — والرقم الموثّق في BACKLOG (43) كان **متقادمًا**. **الإعفاء مرفوض مسبقًا:** الـ45 كلها من طبقة `floor` والأداة تقول «Floor is never waivable»، فلم يُكتب `waive` ولا `answered` واحد؛ والنتيجة النهائية `waived:0 · rejected:0 · answered:0 · dismissed:0`.

| البوابة | العدد | الإصلاح (بدليل الأداة) |
|---|---|---|
| 20 | 5 | ختم `/* Hallmark · … */` على أول سطر غير فارغ في `agent.css` و`computer.css` و`deploy.css` و`fonts.css` و`theme.css` على منوال `landing.css:1`. (`cron.css`/`kb.css` لم تفشلا لأن `parts` في صفحة مختومة.) الختم توثيق لا مفتاح: ‏`ctx.genre` يأتي من راية `--genre` وحدها، فلا قاعدة تُعطَّل به. |
| 39a | 5 | `cursor:not-allowed` للمعطّل في `system.css:40` (كان `cursor:wait`، وهو «مشغول» لا «غير متاح») و`system.css:49` و`whatsapp.css:8` و`deploy.css:6`؛ وحلقة تركيز `.lead-form input:focus` صارت بالظل و`:focus-visible` بالـ`outline` بدل `border-color`. **لم تُضف قنوات `fill`/`ink`** لأن البوابة 40/41 تقيس تباين أي قاعدة تحمل `color` و`background` معًا، ونصّ المعطّل منخفض التباين بطبعه فكان سيخلق إخفاقًا جديدًا. |
| 4 | 2 | ‏`.check-card` في الاستوديو **ليست بطاقة** (`background:transparent` · `border:0` · `border-radius:0`) ⇒ الاسم كان يكذب على البوابة، فسُمّيت **`.check-row`** في `index.html` و`styles.css`. بطاقة `deploy` المسماة `.check-card` تُركت لأنها بطاقة فعلًا (`--panel` + حدود + انحناء 11px) ويرهنها `e2e/deploy.spec.js` (6 عناصر). |
| 19 | 3 | البوابة تُبلغ **نتيجة واحدة لكل مستند**، فإصلاح الأولى كشف الثانية: `agent.html:126` و`:144` (من عمل L1) ⇒ فاصلة، ونصّا `computer-permissions.html` أُصلحا **في المصدر** `src/agent/computer-policy.js` (الصفحة مولَّدة)، ونطاق السعر `$0.40–$1.33` ⇒ «$0.40 إلى $1.33». المسح الدقيق (بـ`python3` لا `grep` بقوس متعدد البايتات الذي طابق `…` والأسهم) أظهر **شرطتين حقيقيتين فقط** في كل النسخة المقروءة. |
| 67 | 30 | **CSS (9):** حذف قواعد `.eyebrow` **الميتة** من `system.css` (3 مواضع) و`protocol.css` و`deploy.css` (‏`DSN2-06` يحظر `class="eyebrow"` في أي صفحة ⇒ لا مستهلك)، وإلغاء `letter-spacing` من ست تسميات في `system.css` (‏`.brand small` · `.side-bottom > .mono` · `.release-name` · `.compatibility strong` · `.step-number` · `footer > .mono`) ومن `.steps .kind` في `agent.css`. **HTML (21):** المعرّفات التقنية إلى دلالتها الصحيحة `<code>`/`<abbr title="…">` بعناوين شارحة (`AES-256-GCM` · `HMAC-SHA256` · `JSON-RPC` · `MCP` · `HTTPS` · `CSV/JSON/TXT` · `NETWORK = DENY` · أسماء الأسرار التسعة)، والشعارات إلى حالة الجملة (`Built to evolve / 2026` · `System topology` · `01 / Upgrade` · `02 / Rollback` · `03 / Recover` · `Evolve. Isolate. Recover.` · `Build with proof`)، و`CELIA SYSTEMS` وُسمت `class="wordmark"` لأنها العلامة الاسمبة فعلًا (الإعفاء بالاسم هو الآلية التي تنصّ عليها القاعدة). |

**ملاحظتان مسجّلتان:** (أ) نصّ `schema` الحيّ في `public/system.js` وُحّدت حالته مع الساكن (`Schema … / declared`) كي لا تنقلب الحالة عند الجلب. (ب) ‏`AGENETROUTERAPI_KEY` المعروض في `index.html` **ليس تحريفًا يُصلَح**: هو اسم السرّ الفعلي في GitHub Actions بحسب `docs/continuity/DECISIONS.md:492`، و`src/ai-providers.js:201` يقرأ الاسم المعياري `AGENTROUTER_API_KEY` بديلًا — لذا وُسِم بـ`<code>` بلا تغيير في الاسم، ويُرفع للمالك كملاحظة لا كتحرير.

## 3) `U4` — شجرة الخطة المشتقة من `agent_steps` وحدها

**الثغرة والمعيار** (`docs/plan-live-operation-ui-2026.md:52`): «العرض قائمة مسطّحة؛ لا تبعية ولا حالة لكل خطوة بلون مشتق من السجل» ⇒ «العرض مشتق من `agent_steps` حصرًا — أي خطوة بلا سجل لا تُرسم (بوابة `DEC-030`)». المسار الخادمي كان منجزًا (`POST /api/agent/runs/:id/plan` بشرط `expectedRevision` ورفض `revision_conflict 409`)، فالناقص العرض وحده.

**ما هو مُسجَّل وما هو مُشتق** (موثّق في رأس `buildStepTree` في `public/agent-trace.js`):
- تُرسم العقدة فقط إن كانت خطوة مسجّلة (فهرس رقمي + عنوان)؛ وما بلا سجل يُدرج في `dropped` بسببه (`no_index` · `no_title` · `not_a_step`) **ولا يُرسم** — لا خطوة متوقّعة ولا عنصر نائب، وسطر الأدلة تحت الشجرة يعلن العدد والسبب.
- **التبعية `dependsOn` هي ترتيب التسجيل:** `store.appendStep` يسند `step_index = MAX(step_index)+1` داخل التشغيل (`src/agent/store.js:607`)، فالخطوة التالية لا تُسجَّل قبل السابقة. ليست مخططًا أعلنه المخطط ولا تُعرض كذلك، و`tooltip` يقول ذلك حرفيًا.
- **ابن «استدعاء الأداة»** يُرسم فقط حين يوجد سجله (`toolRunId` أو `toolRunStatus` أو `durationMs` المُثبَتة من `agent_tool_runs`)، وحالته من `stepNodeStatus` نفسها — **إعادة استخدام للاشتقاق القائم لا جدول حالات موازٍ** — و`kind` للابن `null` لأنه ليس حقلًا مسجَّلًا فلا يُختلق.
- المدة المُثبَتة تبقى على عقدة الخطوة (سطر «الزمن:» في الأب) ولا يكررها الابن، والابن يحمل رقم سجل الاستدعاء.

**حماية رهونات CI القائمة:** `e2e/agent.spec.js:348-371` ترهن `#steps li[data-index="N"]` بـ`data-node` وبالنص «الزمن: —» (:351 و:371) و«الزمن: 42 ms» (:369). لذلك: بقي العمود الفقري `li[data-index][data-node]` كما هو، وبقي سطر الزمن يُرسم في الأب **دائمًا** (مسوّدي الأول كان يحجبه حين يوجد سجل استدعاء، فكان سيكسر :351 — كُشف بالفحص قبل الدفع لا في CI)، وأبناء الأداة يحملون `data-tool-for` بدل `data-index` كي لا يطابق المحدد نفسه عقدتين فينكسر الوضع الصارم في Playwright. التنسيق بحدود منطقية (`border-inline-start` / `padding-inline-start`) فلا ينكسر RTL، وكل الألوان `color-mix` على رموز السمة القائمة — **لا لون حرفي واحد** لأن `agent.css` داخل قائمة `THM-02` المهجَّرة، و`agent-trace.js` ليس من مصادر لوحة الكونسول الأربع فأُعيد توليد `console:panels` مع ذلك وبقي مطابقًا (7261 بايت).

**اختبار جديد `TRC-05`** في `test/agent-trace.test.js` بطفرات سلبية صريحة: ‏`act` بلا سجل استدعاء ⇒ لا ابن · صفوف ناقصة ⇒ `dropped` بلا رسم · تكرار فهرس ⇒ عقدة واحدة وآخر كتابة تفوز · انتظار الموافقة على الأخيرة فقط · مدخلات غير مصفوفة ⇒ شجرة فارغة صادقة. ⇒ الملف **6/6**.

## 4) الأدلة (VERIFIED محليًا) — والأوامر التي أنتجتها

```sh
node vendor/hallmark/scripts/sloplint.mjs public --json   # fails:0 · waived:0 · rejected:0 · answered:0 · dismissed:0
npm test                       # 1439 · 1423 pass · 0 fail · 16 skipped
npm run check                  # 284 ملف JS
npm run visual:first:check     # board, registry and page agree (MASTER_VISUALS = 11 بلا تغيير)
npm run arch:map:check         # 16 مكوّنًا · 129 وحدة · 15 متحقق
npm run computer:permissions:check && npm run console:panels:check
npm run build:edge-ui:check && npm run build:manifest:check   # current (40063 · 7537 بايت)
npm run plan:check && npm run measure && npm run check:continuity && npm run now:check
npx playwright test --list     # 48 في 4 ملفات
```

إعادة التوليد الإلزامية بعد كل تحرير نُفّذت من المصدر: `computer:permissions` (الصفحة + `docs/computer-permissions/README.md`) · `console:panels` · `build:edge-ui` · `build:manifest` · `now`.

## الدليل البصري

- **[لوحة لوحات الكونسول المشتقة](../../design/agent-console-panels.html)** — مولَّدة من `public/agent.html` و`agent-console.js` و`agent.js` و`agent.css` بعد تغيير `U4` مباشرة (`npm run console:panels`، و`:check` يقول «مطابق»، 7261 بايت). اللوحة تشتق المسارات والمعرّجات من المصادر نفسها التي رسمت الشجرة.
- **[لوحة Visual-First](../../design/visual-first.html)** — `npm run visual:first:check` أخضر: اللوحة والسجل والصفحة متفقة، و`MASTER_VISUALS` بقي **11** (لم تُضف لوحة).
- **دليل متصفح حيّ من CI لا من هذه البيئة:** وظيفة «RTL dashboard · desktop / mobile / accessibility» **pass** على رأس هذا الفرع (run `42049300569` · job `127320749296` · 10m11s) — متصفح حقيقي على سطح المكتب والهاتف مع `axe`، يغطّي الصفحات التي عُدّلت.
- **الهجرة مطابقة لونيًا بايتًا:** 112 إعلانًا مع تحقّق مرتّب لكل لون مضمّن ⇒ **0 اختلاف لوني**، فصفحة الهبوط تُعرض بالألوان نفسها حرفيًا (الرموز تحلّ إلى القيم الأصلية).
- **ما تغيّر بصريًا فعلًا (بلا تلطيف):** إلغاء `letter-spacing` من سبع تسميات · علوية ⇒ حالة الجملة في سبع شعارات · معرّفات تقنية ⇒ وجه `code`/`abbr` · حلقة تركيز `.lead-form input:focus` بـ`outline` وظلّ بدل `border-color` · مؤشر المعطّل `not-allowed` · قائمة الخطوات صارت شجرة متداخلة بفاصل منطقي وألوان حالة.
- **حدّ معلن بلا تجميل:** لا لقطة شاشة مبصومة في هذه الجلسة — متصفحات Playwright غير قابلة للتثبيت في هذا الرمل (مضيفات تنزيلها خارج القائمة المسموحة). لذلك يبقى على CI أو المالك: التقاط اللقطات، والفحص البصري الحيّ للصفحات الثلاث عشرة (**4 FAIL** متبقية من قياس سابق)، وإغلاق `DSN-002` فعلًا بتحقيق `0/0`.

## 5) ما لم يُدَّعَ (صريحًا)

- **لا دليل بصري ملتقط:** متصفحات Playwright غير مثبّتة في الرمل، فالشجرة والهجرة لم تُريا في متصفح ولا لقطة مبصومة ⇒ **`DSN-002` يبقى مفتوحًا** حتى الفحص البصري الحيّ للصفحات الثلاث عشرة (القياس السابق: 4 FAIL بصرية)، واختبارات المتصفح الـ48 تُحكم من CI.
- **لم يُضف اختبار e2e جديد** لـ`U4`: كان سيُدفع بلا قدرة على تشغيله محليًا ⇒ **PROPOSED / NOT TESTED**، واقتراحه: تثبيت أن `#steps li[data-index] > ul.branch > li[data-tool-for]` يظهر فقط مع سجل استدعاء.
- `B1 = 5.5/8` · `B2 = 2.5/6` · 66 مهمة مفتوحة (P0 21 · P1 31 · P2 14) · `L5 = 0/17` · `DATA-001` ما زالت `SIMULATED_PASS` · العزل off · `NETWORK=DENY` · `CHANGELOG` لم يُلمس (`PRG-07` يقفل أربعة بنود في Unreleased) · لا مراقبة 60 دقيقة ولا إطلاق عام · `MASTER_VISUALS` بقي **11** (لم تُضف لوحة).
- **مغلق حتى قرار مالك:** `L3` (مفتاح مزوّد + `GOV-001`) · `L4` (`HOST-003`) · `L5` (لوحات Meta/Google) · `L6` (`DES-002`, multi-user) · `L7` (`REL-001`/`REL-004`).

## 6) الخطوة التالية

1. دمج `L2` (PR من `arena/e055d6db-phone-google`) — **بلا `--admin` إلا بأمر صريح**، والفحوص تُحكم من CI.
2. بعد الدمج: التقاط الدليل البصري الحيّ للصفحات الثلاث عشرة (متصفح حقيقي) لإنزال الـ4 البصرية وإغلاق `DSN-002` فعليًا.
3. اختبار e2e لـ`U4` (المقترح أعلاه) حين تتوفر بيئة متصفح.
