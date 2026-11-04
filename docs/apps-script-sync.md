# مزامنة Google Apps Script عبر clasp — الدليل والحدود (GOOG-006)

**الحالة الصريحة:** البنية والأداة والاختبارات مبنية محليًا (`AS-01…AS-10`)،
لكن **لم يحدث أي `clasp login` ولا `clone` ولا `pull` حقيقي حتى الآن**:
لا `~/.clasprc.json` في بيئة العمل، ولا وصلنا `SCRIPT_ID`، وشبكة بيئة الوكيل
لا تصل إلى Google. أي سحب فعلي خطوة مالك بالأوامر أدناه — ولا تقرير هنا
يدّعي مزامنة لم تُقَس.

## لماذا أداة بدل أوامر يدوية متناثرة؟

الأوامر اليدوية (`clone` ثم نسخ فوق المصدر) تمحو الفرق قبل أن يُرى.
الأداة (`scripts/apps-script-sync.mjs`) تجعل الترتيب قسريًا:

| الوضع | ما يحدث | ما لا يحدث أبدًا |
|---|---|---|
| `npm run apps-script:sync` (افتراضي) | فحص جاف: بصمات SHA-256 للشجرتين وفرق مسمّى ملفًا ملفًا | لا كتابة، لا clasp، لا شبكة |
| `--clone --script-id <ID>` | `clasp clone` داخل نسخة العمل ثم عرض الفرق | لا كتابة في مصدر المستودع |
| `--pull` | `clasp pull` في نسخة العمل ثم عرض الفرق، والحكم `diff-pending-review` | لا تطبيق على `deploy/apps-script/` |
| `--pull --accept` | نسخة احتياطية في `.validation-artifacts/` (خارج Git) ثم تطبيق الإضافة/التعديل/الحذف، والتحقق أن الفرق بعده صفر | لا قبول إن وُجد سرّ ظاهر في ملف مسحوب (`blocked-secret`) |
| `--push` | مرفوض (`refused`) | الرفع إلى Google تعديل خارجي يحتاج قرار مالك مستقلًا |

رموز الخروج: `0` مطابق/مقبول · `1` فرق بانتظار المراجعة أو فشل · `2` غير مهيّأ/مرفوض.

## خطوات المالك (مرة واحدة ثم عند كل مزامنة)

```sh
npx @google/clasp login            # بحسابك، مرة واحدة
cp -r deploy/apps-script ~/celia-apps && cd ~/celia-apps
npx @google/clasp clone <SCRIPT_ID>   # من رابط مشروعك: الجزء الطويل بعد /projects/
# إن اختلفت النسختان، راجع الفرق ثم:
cd /path/to/phone-google
npm run apps-script:sync -- --pull            # الفرق أولًا، بلا تطبيق
npm run apps-script:sync -- --pull --accept   # التطبيق بعد المراجعة فقط
```

- بديل الـ`--work-dir` الافتراضي (`~/celia-apps`): `--work-dir DIR` أو `CELIA_APPS_DIR`.
- بديل `SCRIPT_ID` بلا `.clasp.json`: `--script-id <ID>` أو `CELIA_APPS_SCRIPT_ID`.
  يُعرض المعرّف في التقارير مقنّعًا (`1BxiMV…upms`) و`.clasp.json` الحقيقي مُهمل في Git.

## حدود معلنة

- `deploy/apps-script/Code.gs` نقطة بداية بصفر سلوك خارجي و`oauthScopes: []` —
  أي غرض حقيقي (Sheets/Gmail/…) قرار مستقل بنطاقات دنيا، لا يُستنتج هنا.
- `clasp` يُستدعى عبر `npx -y @google/clasp` عند الطلب فقط؛ ليس اعتمادية مثبتة
  في `package.json`، فلا يتغير `package-lock.json` ولا بوابة `npm audit` بهذه الخطوة.
- بعد أي انقطاع أثناء سحب حقيقي: لا إعادة إرسال عمياء — أعد الفحص الجاف أولًا
  واقرأ الفرق؛ الحالة عند البعيد تُسمّى `remoteSynced:false` حتى تُثبت بسحب ناجح.
