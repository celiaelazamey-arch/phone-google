# 2026-10-31 — DSN-002 (الدفعة الثانية) / DEC-080: هجرة ألوان الصفحات إلى `theme.css`

**الفرع:** `arena/9dceca86-phone-google` من `main@ec7da14` · **الرأس قبل الدفعة:** `a254efd` · **الوضع:** منفّذ ومُختبر محليًا، بلا PR وبلا نشر.

## السؤال
بعد الدفعة الأولى بقي **244** لونًا حرفيًا خارج `theme.css` (قاعدة 48). هل يمكن تصفيرها دون تغيير مظهر أي صفحة؟

## ما جرى
1. جرد لكل ورقة: `system.css` 99، `computer.css` 37، `styles.css` 36، `deploy.css` 28، `protocol.css` 20، ثم `computer-permissions.html` 14 و`live.html` 5 و`index/skills` 2+2.
2. كتلة هوية لكل صفحة في `theme.css` (`--t-sys-*`, `--t-dep-*`, `--t-pro-*`, `--t-cu-*`, `--t-lnd-*` + `--t-mask` و`--t-sheen`)، والشيفافيات صارت `color-mix(in srgb, var(--tok) N%, transparent)`.
3. كل صفحة تربط `theme.css` قبل `fonts.css` وبعد `theme.js` حيث يوجد مبدّل.
4. الملفات المولّدة صُحّحت من مولّداتها: `render-computer-permissions.mjs` ثم `npm run computer:permissions`، و`npm run build:edge-ui` بعد تغيّر `theme.css` (الوحدة تحزم الأصول).
5. البوابات عُدّلت بقدر الحاجة فقط: قائمة THM-02 انكمشت إلى `landing.css`/`fonts.css`، وTHM-04 صارت «المبدّل يستلزم الرموز» + قائمة `SINGLE_IDENTITY`، ومطابقة `color-mix` صارت تقبل أقواسًا متداخلة وأسماء رموز بأرقام.

## أرقام مقيسة
- `npm run design:audit -- public/`: **283 ⇒ 43 FAIL** (قاعدة 48 وحدها: **244 ⇒ 0**)، 25 ملفًا، 67 WARN.
- `node --test test/theme-tokens.test.js`: **6/6**؛ `design-system-pages` + `landing-design`: **15/15**.
- `npm test` كاملًا: **943 اختبارًا / 926 ناجحًا / 0 فشل / 17 skipped**. أوقفت الدفعة ثلاثة انحدارات توليد وليس كودًا: `VER-07` (وحدة الحافة تحزم `theme.css`)، و`computer-permissions` (الملف مولّد)، و`MAN-01`/`PR-09`/`PR-10` (بصمة البيان بعد تغيّر الملفات) — أُعيد التوليد لكل منها فخضرت.

## عيوب كشفها التشغيل لا المراجعة
- **اسم رمز بلون:** `var(--t-white)` و`var(--t-sys-red)` و`var(--red)` تُقرأ كألوان حرفية لأن البوابتين تفحصان الكلمة قبل `)`. أُعيدت التسمية دلاليًا (`--t-sheen`, `--t-sys-bad`, `--t-sys-info`, `--bad`).
- **ملف مولّد:** تحرير `public/computer-permissions.html` مباشرة يُمسح في التوليد التالي؛ الاختبار كشفه (`computer-permissions.html is stale`).
- **وحدة الحافة:** `build-edge-ui` يحزم `theme.css`، فأي تعديل فيه يوجب إعادة التوليد وإلا فشل `VER-07`.

## الحدود
الـ43 المتبقية ليست قواعد لون: 24b كثافة، 67 على العربية، 39a، 38iii، وسلاسل F. لم تُلمس النصوص ولا الأرقام ولا الأصول الخارجية. لا PR ولا نشر.
