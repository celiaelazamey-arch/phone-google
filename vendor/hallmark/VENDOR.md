# Hallmark — نسخة بائع (vendored)

| الحقل | القيمة |
|---|---|
| المصدر | https://github.com/Nutlope/hallmark |
| الالتزام | `4f6a46c6dc325d40ab268c93e25c7b96676ebccd` |
| الترخيب | MIT — انسخ `LICENSE` المرفق كما هو |
| تاريخ الجلب | 31 أكتوبر 2026 |
| القرار | [DEC-078](../../docs/continuity/DECISIONS.md) |

## لماذا هنا وليس في `.agents/skills/`

`.agents/skills/` عقد حوكمة مثبّت بالاختبار: `R0-04` يفرض أن المهارات الإجرائية أربع بالضبط، و`R0-05` يولّد `NOW.md` من قائمتها. وضع Hallmark هناك كسر البوابتين فعليًا. Hallmark أداة تصميم تابعة لطرف ثالث، لا مهارة حوكمة، فموضعها دليل البائعين. لم يُضعف أي اختبار لاستيعابها.

## ما نُسخ وما استُثني

المثبت: `SKILL.md` و`LICENSE` و`agents/` ونصوص `references/**/*.md` (ومنها 50 ثيمًا) وسكربتات الفحص.

المستثنى عمدًا:

- **صور معاينات الثيمات** (`references/themes/*.jpg`, نحو 5MB): لا تدخل في أي فحص آلي.
- **`install.mjs` و`install-hook.mjs` و`lint-hook.mjs`**: تُعدّل خطافات Git ومهارات المضيف. لا نريد أداة تصميم تكتب في `.git/hooks/` أو في عقد المهارات.
- **`imagegen.mjs`**: يولّد صورًا عبر خدمة خارجية بمفتاح؛ لا استخدام له تحت سياسة CSP بأصول محلية.

## التشغيل

```bash
npm run design:audit -- public/landing.html
npm run design:audit -- public/landing.html --json
```

الفحص البصري يحتاج Chrome و`puppeteer-core`، وهما **غير مضافين إلى `package.json`**:

```bash
npm install --no-save puppeteer-core
CHROME_PATH=/path/to/chrome npm run design:audit -- public/landing.html --render
```

يكتب الفحص البصري لقطاته في `public/.hallmark/` وهو مُستثنى في `.gitignore`، و`scripts/build-pages.mjs` يتجاوز الأدلة النقطية فلا تدخل اللقطات نسخة النشر (`LND-07` يثبّت ذلك).

## التحديث

عند الترقية: اجلب الالتزام الجديد، وانسخ الملفات نفسها فقط، وحدّث رقم الالتزام أعلاه، ثم شغّل `npm run design:audit` و`npm run check:continuity` و`R0`. لا تشغّل سكربتات التثبيت من المستودع الأصلي.
