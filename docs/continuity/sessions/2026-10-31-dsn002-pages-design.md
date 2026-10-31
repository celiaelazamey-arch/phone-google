# جلسة 31 أكتوبر 2026 — DSN-002: إصلاح ما قِيس على 12 صفحة (DEC-079)

**الفرع:** `arena/9dceca86-phone-google` من `main@ec7da14` · **النشر:** لم يحدث في هذه الجلسة · **القرار:** [DEC-079](../DECISIONS.md) · **التقرير:** [hallmark-pages-audit.md](../../design/hallmark-pages-audit.md)

## المهمة والتفويض

- طلب المستخدم: «الرد بإيجاز وبسعي إلى تحقيق الهدف» — أي إكمال العمل القائم لا شرحه.
- المهمة التالية المسجّلة في `STATE`/`BACKLOG` كانت `DSN-002`: بقية واجهات `public/` بعد معالجة صفحة الهبوط وحدها.
- النطاق المسموح: أدوات Hallmark المثبتة في `vendor/`، الفحص الساكن والبصري، إصلاح العيوب المقيسة. خارج النطاق: نشر، ترقية إصدار، تغيير أرقام معروضة أو ادعاءات، أصول خارجية.

## واقع البداية

- الفرع `arena/9dceca86-phone-google` نظيف على `ec7da14` (دمج PR #113). لا عمل مستخدم غير محفوظ.
- `main@ec7da14`: كل تشغيلاته خضراء — `Deploy (GitHub Pages)` `41192222022` (13/13 مسارًا)، `Deploy (Cloudflare Edge)` `41192222041` (تحقق الحزمة، رفع، إثبات OIDC، قبول حيّ، ترقية شريحة)، `Render` و`Release` ناجحان.
- Chromium غير مثبت في الصندوق؛ شُغّل عبر `@sparticuz/chromium` + `puppeteer-core` بلا حفظ، ومكتبات NSS من `al2023.tar.br` في `LD_LIBRARY_PATH`.
- خط الأساس المقيس: الساكن **386 FAIL**، والبصري على 13 صفحة **54 FAIL**.

## ما تغير فعليًا

| الملف | الغرض |
|---|---|
| `public/theme.css` | رمز `--t-field-edge` في السمات الأربع بقيم مقيسة ≥ 3:1؛ منتقي السمة يستعمله |
| `public/agent.css` | ربط `--field-edge` بالرمز؛ حلقة تركيز على `select`/`a`؛ إزالة `transition: width`؛ `overflow-x: clip` |
| `public/styles.css` | `--text-muted` أفتح (6.41–7.71:1)، `--accent-fg` و`--field-edge` و`--focus-ring`، حلقة تركيز شاملة، `prefers-reduced-motion`، `overflow-x: clip`، شريط كتابة معتم + `min-height: 0`، `.check-card` صفّ لا بطاقة، إزالة `#fff` عن المرجاني، حدود حقول 3:1 |
| `public/computer.css` + مولّده | تدرّج واحد بدل اثنين، حبر على البنفسجي `#140b2e`، رابط تجاوز يظهر بالتركيز بدل `-9999px` |
| `public/protocol.css` / `system.css` / `deploy.css` / `whatsapp.css` | حبر صريح على الأسطح الداكنة، `clip`، حلقات تركيز، حاجب محذوف، حدود حقول، `nowrap` على زر واحد طويل |
| `public/*.html` (11 ملفًا) | حذف 13 حاجبًا و38 رمزًا تعبيريًا، نقل الشرائح الوصفية بعد العناوين، شرطات في النثر صارت فاصلة عربية، بدائل `…` لقيم لم تُقرأ بعد، عنوان `h1` واحد في `whatsapp.html` |
| `public/app.js` | أيقونة السمة `◐/◑` بدل ☀️/🌙 |
| `scripts/static/celia-static-shim.template.js` | الشريط السفلي لا يغطّي شريط الكتابة (`padding-bottom` + ارتفاع الغلاف)، وأيقونة SVG بدل 🧪، وحلقة تركيز لزر الإخفاء |
| `scripts/render-computer-permissions.mjs` | كل إصلاحات الصفحة المولّدة في المصدر |
| `test/design-system-pages.test.js` (جديد) | بوابة `DSN2-01..08` |
| `docs/design/hallmark-pages-audit.md` (جديد) | تقرير Before/After وأسباب ما لم يُصلح |
| `CHANGELOG.md`, `STATE.md`, `BACKLOG.md`, `DECISIONS.md` | التسليم والاستمرارية |

## الفحوص

| الأمر/الفحص | البيئة | النتيجة |
|---|---|---|
| `npm run design:audit -- public/` قبل/بعد | محلي | **386 ⇒ 283 FAIL** |
| الفحص البصري على 13 صفحة (`--render`) قبل/بعد | Chromium محلي | **54 ⇒ 4 FAIL** |
| `node --test test/design-system-pages.test.js` | محلي | **8/8**، وأُثبت القبض بعيب مفتعل (رمز 🚀 ⇒ فشل) |
| `node --test test/landing-design.test.js test/theme-tokens.test.js test/browser-runtime.test.js` | محلي | **24/24** (بقيت LND-06 وTHM-02 وVER-07 خضراء بعد إعادة تسمية الرمز وتوليد حزمة الحافة) |
| `npm run computer:permissions` / `build:edge-ui` / `build:pages` | محلي | ناجحة بلا انحراف |
| `CELIA_SANDBOX_INTEGRATION=1 npm run test:coverage` | محلي | **943 / 942 ناجحًا / 0 فشل / 1 skipped**، تغطية **92.28 / 77.43 / 86.95** |
| `npm run build:manifest` + `:check` | محلي | بصمة حزمة الحافة تجدّدت بعد `build:edge-ui` (PP-09/PR-10/MAN-01 كانت تفشل قبل التوليد) |
| `npm run check` · `now:check` · `check:continuity` · `check:secrets` · `release:check` | محلي | ناجحة |

## الحفظ والتسليم

- الالتزامات على فرع الجلسة فقط؛ لا دفع إلى `main` ولا PR ولا دمج ولا نشر في هذه الجلسة.
- لم تُلمس الأسرار ولا قاعدة البيانات ولا ترقيم الإصدار (`0.2.1` كما هو).

## الاستئناف

- **الخطوة التالية:** دفعة `DSN-002` الثانية — هجرة ألوان الصفحات إلى `theme.css` (244 نتيجة قاعدة 48)، تبدأ بـ`system.css` (99) ثم `styles.css` (39) ثم `computer.css` (39).
- **أول فحص آمن:** `npm run design:audit -- public/` ثم `node --test test/design-system-pages.test.js test/theme-tokens.test.js`.
- **لا تُعمَّم** 30 نتيجة قاعدة 67 و12 قاعدة 49 وإيجابية 73 على أنها عيوب؛ هي مسجّلة بأسبابها في التقرير.
