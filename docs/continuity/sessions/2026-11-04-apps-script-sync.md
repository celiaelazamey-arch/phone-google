# تسليم جلسة — 2026-11-04 — GOOG-006: بنية مزامنة Apps Script عبر clasp (offline)

## المهمة والتفويض

- طلب المستخدم: أوامر حرفيًا — `npx @google/clasp login` (بحسابه، مرة واحدة) ·
  `cp -r deploy/apps-script ~/celia-apps && cd ~/celia-apps` ·
  `npx @google/clasp clone <SCRIPT_ID>` · ثم عند اختلاف النسختين مراجعة الفرق وبعدها
  `npm run apps-script:sync -- --pull --accept`.
- أسئلة توضيح أجاب عنها المالك: البنية offline أولًا (لا SCRIPT_ID الآن) · الغرض
  «مزامنة فقط حاليًا» (تخطّى اختيار Sheets/Gmail) · الاتجاه pull بـaccept بعد مراجعة الفرق.
- معرف BACKLOG: `GOOG-006` (جديد) · القرار: `DEC-142`.
- النطاق المسموح: بناء البنية والأداة والاختبارات والتوثيق + تنفيذ `cp -r` المحلي.
  ما يحتاج مالكًا ولا نُفّذ: `clasp login` بحسابه، و`clone`/`pull` حقيقيان إلى Google.

## واقع البداية

- الفرع: `arena/a6ae0090-phone-google` (مثبّت من البيئة وGit) · الأساس `99f09f6` · worktree نظيف.
- القياس قبل البناء: `deploy/` فيه `free-always-on` فقط (لا `apps-script`) ·
  لا سكربت `apps-script:sync` في `package.json` · لا `~/.clasprc.json` · لا `~/celia-apps` ·
  لا أي ذكر لـclasp في المستودع خارج `vendor/` غير ذي الصلة.

## ما تغير فعليًا

- `deploy/apps-script/`: `Code.gs` (صفر سلوك خارجي) + `appsscript.json`
  (`Africa/Cairo`، `oauthScopes: []`) + `.claspignore` + `.clasp.json.example` + `README.md`.
- `scripts/apps-script-sync.mjs` + سكربت `apps-script:sync` في `package.json`:
  فحص جاف افتراضي ببصمات SHA-256 وفرق مسمّى · `--pull` يعرض بلا تطبيق ·
  `--pull --accept` وحده يطبّق بعد نسخة احتياطية في `.validation-artifacts/` ·
  `--push` مرفوض · سرّ ظاهر في مسحوب ⇒ `blocked-secret` · المعرّف يُعرض مقنّعًا.
- `test/apps-script-sync.test.js` (`AS-01…AS-10`) · `docs/apps-script-sync.md` ·
  `.gitignore` يهمل `.clasp.json` الحقيقي · BACKLOG `GOOG-006` · `DEC-142` · STATE.
- نُفّذ فعليًا في البيئة: `cp -r deploy/apps-script ~/celia-apps` (خارج Git).
- ما بقي اقتراحًا/مالكًا ولم يُنفّذ: أي غرض Apps Script حقيقي، وأي اتصال بـGoogle.

## الفحوص

| الأمر/الفحص | البيئة | النتيجة |
|---|---|---|
| `node --test test/apps-script-sync.test.js` | هذه الجلسة | **10/10 ناجح** (بعد إصلاحين أثناء التطوير: `await` لمسار pull، وأفعال مالك في فرع dry-run) |
| `npm run apps-script:sync` (قبل النسخ) | المستودع الحقيقي | `not-configured`، خروج 2، صفر كتابة، `remoteSynced:false` |
| `cp -r deploy/apps-script ~/celia-apps` ثم الفحص الجاف | هذه البيئة | `identical` — 5 ملفات مطابقة، خروج 0، بلا أي اتصال بالبعيد |
| بقية الفحوص (`check`/`npm test`/`now:check`…) | هذه الجلسة | تُسجَّل نتيجتها الفعلية في نص التسليم النهائي لا هنا بأرقام منقولة |

## الدليل البصري

لا يوجد تغيير بصري — التغيير أداة سطر أوامر ومصدر Apps Script بلا واجهة؛
لا لوحة `docs/design/*.html` تدّعي حالته، وحالته المقيسة في `AS-01…AS-10` والتشغيلين أعلاه.

## الحفظ والتسليم

- الحالة عند التسليم تُذكر في الرد النهائي (commit/دفع فعليان أو سببهما).
- عمليات خطرة لم تُنفّذ: لا `clasp login` نيابة عن المالك، لا طلب/حفظ بيانات اعتماد،
  لا `clone`/`pull`/`push` إلى Google، لا `.clasp.json` حقيقي في Git، لا تغيير نطاقات OAuth.
- لا نتيجة خارجية غير معروفة: لم يُرسَل شيء أصلًا، فلا `outcomeUnknown` يحتاج مصالحة.

## الاستئناف

- العائق الوحيد: حساب المالك + `SCRIPT_ID` (يُمرَّر كوسيط/بيئة لحظة التشغيل، لا يُكتب في Git).
- الخطوة التالية بالضبط: عند المالك `npx @google/clasp login` ثم داخل `~/celia-apps`:
  `npx @google/clasp clone <SCRIPT_ID>`، ثم من جذر المستودع
  `npm run apps-script:sync -- --pull` (أول فحص آمن) ومراجعة الفرق قبل أي `--accept`.
- تأكيد: STATE و`GOOG-006` و`DEC-142` محدّثة، و`NOW.md` يُجدَّد بـ`npm run now` قبل الإغلاق.
