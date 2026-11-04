# بوابات قبول وإطلاق الدخول بحساب Google (`GA-F0…GA-F5`)

**النطاق:** تسجيل المستخدم العادي عبر `/auth/google/signin` على Cloudflare Edge، وليس ربط Workspace للمالك عبر `/auth/google`.  
**مرجع حالة المهام:** [`BACKLOG.md`](continuity/BACKLOG.md) (`WA-008…WA-010` و`REL-004`).  
**الحكم الحاكم:** لا إطلاق عام قبل اكتمال `REL-004` وبوابات `PUB-001`؛ نجاح بدء OAuth أو نجاح الفاحص الآلي ليس إذن نشر أو فتح للجمهور.

## 1. تسمية لا تخلط بين البوابات

- `GA-F0…GA-F5` هي بوابات **Google Auth** في هذا المستند. استُخدمت البادئة `GA` لأن أسماء `F0…F5` وحدها مستعملة أيضاً في [`plan-free-full-power.md`](plan-free-full-power.md) بمعنى مختلف.
- `PUB-001` ليست اسماً لموانع OAuth الخمسة. هي بوابة النشر القائمة في `src/agent/publish-gate.js`: 12 قاعدة، مراجعة وتوقيع وموافقة مربوطة ببصمة `pub:` وسجل hash-chain. الموانع الخمسة أدناه جزء من `GA-F2`، ولا تستبدل `PUB-001` ولا تتجاوزها.
- `WA-010` يجيب عن سؤال محدود: **هل قبل Google زوج `client_id` و`redirect_uri` الآن؟** لا يجيب عن موافقة المستخدم أو إنشاء الجلسة.

## 2. لقطة الدليل الحيّ — 3 نوفمبر 2026، 21:26Z

هذه لقطة مؤرخة وليست ضماناً دائماً. أعيد فحصها على الالتزام الحيّ المطابق للأساس المحلي `3bd53d667d9c54ecc6803dcf557a2e83ee6019b8`. الأثر المنقّح محفوظ في [`docs/evidence/google-auth-live-2026-11-03.json`](evidence/google-auth-live-2026-11-03.json)، من دون `state` أو رموز تنقل Google أو كوكي أو سر:

| الفحص المستقل | النتيجة المنقّحة | ما يثبته وما لا يثبته |
|---|---|---|
| `GET /version` | `version=0.3.0` و`commit=3bd53d667d9c54ecc6803dcf557a2e83ee6019b8` | يربط القراءة الحيّة بالشجرة المدققة، لا بصفحة قديمة |
| `GET /auth/google/diagnostics` | `ok=true` · `google.accepted=true` · `google.reason=null` · `secretExposed=false` | **GA-F0 ناجح**؛ لا يوجد `redirect_uri_mismatch` في لحظة الفحص |
| متابعة `GET /auth/google/signin` | الوصول إلى `accounts.google.com` وصفحة **Sign in - Google Accounts** التي تعرض «to continue to celiaelazamey.workers.dev» | Google يفتح شاشة الدخول فعلاً؛ لم تُسجَّل قيمة `state` أو معلمات الاستمرار في الدليل |
| callback اصطناعي بلا كوكي مطابق | `400 {"error":"oauth_state_cookie_mismatch"}` | رفض CSRF منشور؛ لم يصل الطلب إلى Token Exchange |

الوصول إلى شاشة Google **لا يثبت** نجاح الموافقة أو `/api/account/me=200`. والتقرير الآلي الجديد هو الذي سيحفظ استجابة الـ`302` الأولى وترويسات الكوكي حرفياً وبشكل منقّح في تشغيلة النشر؛ لا تُدّعى قراءة ترويسة لم تُقرأ يدوياً.

## 3. الجدول التنفيذي ومعايير القبول

| البوابة | الهدف والمسؤول | معيار القبول الصارم | الدليل المطلوب | الوضع بعد هذه الشريحة |
|---|---|---|---|---|
| **GA-F0** | خط أساس التشخيص — مهندس الموثوقية | `/auth/google/diagnostics` يعيد `200` و`google.accepted=true` و`reason=null` و`no-store` و`secretExposed=false`؛ أي `redirect_uri_mismatch` يفشل البوابة | `google-auth-live.json` من `npm run verify:google-auth`، أو قراءة حيّة منقّحة مؤرخة | 🟢 متحقق حيّاً باللقطة أعلاه؛ الفاحص يضيف artifact حتمياً |
| **GA-F1** | التوجيه الفعلي — Backend | `302` فقط إلى `https://accounts.google.com/o/oauth2/v2/auth`؛ `response_type=code` و`scope=openid email profile` و`state=signin:<64 hex>` و`client_id/redirect_uri` مطابقان للتشخيص. **صفحة HTML محلية بحالة 200 ليست نجاحاً** | الفحص `GA-F1` في التقرير + Network trace منقّح | 🟢 شاشة Google حيّة؛ artifact الآلي يبدأ مع أول نشر يحمل هذا التغيير |
| **GA-F2** | موانع الأمان الخمسة — Quality/Security | اجتياز البنود الخمسة في §4 كلها، ثم Quality وCodeQL و`npm audit` بلا إنذار حرج على الـcommit نفسه | تقرير `GA-F2-*` + روابط CI وCodeQL + فحص الأسرار | 🟡 محلياً مختبَر وبعضه حيّ؛ ينتظر artifact النشر الجديد ومراجعة المالك |
| **GA-F3** | التكامل الكامل — QA | نجاح consent حقيقي إلى جلسة ثم `/api/account/me=200`؛ رفض الأذونات برسالة عربية بلا جلسة؛ replay وcookie mismatch مرفوضان؛ عزل حساب ثانٍ | CI + تقرير E2E حيّ منقّح | 🟡 الرفض/replay منفذان ومختبران محلياً؛ **consent الحقيقي لم يُنفّذ هنا** |
| **GA-F4** | المراجعة والمطابقة — Tech Lead | PR للـcommit نفسه، مراجعة بشرية موثقة، CI أخضر، دمج معتمد، تحديث WA/REL ولا تعارض مع `PUB-001` | رابط PR و`headRefOid`/merge SHA وسجل المراجعة والتشغيلات | 🟡 [PR #159](https://github.com/celiaelazamey-arch/phone-google/pull/159) مفتوح بطلب المالك؛ لا مراجعة/اعتماد أو دمج بعد |
| **GA-F5** | الإنتاج والمراقبة — DevOps | نشر معتمد ثم **60 دقيقة كاملة**، `attempts>0` و`successful=attempts` وصفر أخطاء حرجة، مع readiness مستقر وتراجع معروف | Dashboard وسجلات إنتاج منقّحة ببداية/نهاية النافذة وأعدادها | ⛔ لا نشر ولا مراقبة 60 دقيقة من هذه الجلسة؛ `REL-004` يبقى مغلقاً |

> **لا يجوز حساب «صفر محاولات» كنسبة نجاح 100%.** ولا يجوز استبدال نجاح `/diagnostics` أو `/signin` بعداد نجاح دورة المصادقة.

## 4. موانع `GA-F2` الخمسة وكيف تُفحص

### 1) لا Client Secret أو API secret في العميل

- يفحص `GA-F2-secrets` الردود العامة لـ`diagnostics` و`signin` و`/whatsapp` و`/whatsapp.js`. إذا وُجد `GOOGLE_CLIENT_SECRET` في بيئة الفاحص يُقارن **في الذاكرة فقط**، وتُفشل أنماط `GOCSPX-…` و`AIza…` أيضاً.
- لا تدخل قيمة السر أو `state` أو الكوكي أو raw `Location` في التقرير. لا تضع السر في أمر مقروء أو Git؛ يمرّ من مخزن أسرار CI إلى خطوة الفحص فقط.
- يبقى فحص الحزمة الثابتة في `.github/workflows/pages.yml` وبوابة `check:secrets` في Quality مطلوبين؛ فاحص أربعة أسطح ليس إثباتاً لكل أصل حالي ومستقبل.

### 2) Redirect URI حرفي ومسجل

- `GA-F2-redirect` يشترط مساواة القيمة بـ`<origin>/auth/google/callback`، والمساواة بين التشخيص ومعلمة التحويل، و`google.accepted=true`.
- قبول المسبار هو الدليل التشغيلي اللحظي على تسجيل الزوج لدى Google. لا يُستنتج من شكل URI أو من `configured=true`.

### 3) HTTPS إلزامي

- يرفض الفاحص هدف `http://` قبل إرسال أي طلب، ويفشل إن كان callback أو authorization endpoint غير HTTPS.
- يشمل ذلك بدء التفويض والعودة وتبادل authorization code؛ التبادل نفسه خادم-إلى-خادم ولا يمرّ عبر المتصفح.

### 4) الجلسات والرموز ومنع إعادة الاستخدام

- `GA-F2-cookie` يفحص كوكي حالة OAuth: `HttpOnly; Secure; SameSite=Lax; Path=/auth/google; Max-Age=600`، بلا تسجيل قيمته.
- اختبار الجلسة الناجحة في `test/google-account-signin.test.js` يشترط `__Host-celia_wa` مع `Path=/; HttpOnly; Secure; SameSite=Lax`. تُحفظ **بصمة** الجلسة لا الرمز الخام، وكل دخول ينشئ رمزاً جديداً.
- لا تُحفظ Google access/refresh tokens في تدفق المستخدم العادي. تُستهلك `state` ذرّياً قبل Token Exchange، و`GA-F2-replay` يثبت رفض تكرار callback. أما ترويسة جلسة النجاح الحيّة فتُقرأ في قبول GA-F3 اليدوي؛ لا يدّعي الفاحص الاصطناعي أنه أنشأ جلسة.

### 5) CSRF/state والأمن الآلي

- `GA-F2-csrf` يرسل كوكي غير مطابق ويشترط `400 oauth_state_cookie_mismatch` قبل استهلاك `state`.
- `GA-F3-denial` يستخدم حالة مشروعة أنشأها `/signin` ثم يرسل `error=access_denied`: القبول هو `302` إلى `/whatsapp?google_error=google_access_denied` مع مسح كوكي الحالة وعدم إنشاء `__Host-celia_wa`.
- إعادة callback نفسها يجب أن تعيد `400 invalid_or_expired_oauth_state`. لا يتصل الفرع بـGoogle ولا ينشئ حساباً.
- تبقى `npm audit --omit=dev --audit-level=moderate` وCodeQL ومجموعة الجودة على الـcommit نفسه شرطاً مستقلاً؛ لا يحل الفاحص محلها.

## 5. الأمر والأثر وترتيب النشر

```bash
# الفحص الحي الافتراضي للحافة المنشورة
npm run verify:google-auth

# هدف أو مسار إثبات مختلف؛ لا تمرر أسراراً في عنوان URL
node scripts/verify-google-auth.mjs \
  --url https://celia-phone-google.celiaelazamey.workers.dev \
  --out .validation-artifacts/google-auth-live.json

# الفحوص المحلية المرتبطة
node --test test/google-account-signin.test.js test/verify-google-auth.test.js
npm audit --omit=dev --audit-level=moderate
```

التقرير `.validation-artifacts/` خارج Git. حقول `verdict=pass` تعني نجاح **الفحوص الآمنة فقط**، بينما يبقى `launch.ready=false` مع `blocked_pending_external_gates` حتى تُستوفى الأدلة الخارجية.

في `.github/workflows/cloudflare-deploy.yml` يكون الترتيب:

1. نجاح Quality على `main` ومنع الالتزام المتجاوَز وإثبات الحزمة.
2. النشر ثم `verify-live` للحافة وD1.
3. `verify-google-auth` لـGA-F0/F1 وموانع GA-F2 الحية ورفض/replay في GA-F3.
4. فقط عند نجاحها تُرفع الشريحة إلى `known_good`، ثم يُرفع `google-auth-live.json` مع أدلة النشر.
5. أي فشل يمنع `known_good` ويُسمّى بمعرّف الفحص؛ لا retry أعمى ولا تخطّي.

**الدليل المحلي لهذه الشريحة:** `npm test` = 1305 اختبارًا / 1288 ناجحًا / 0 فشل / 17 تخطيًا بيئيًا مصرحًا به، و40/40 لبوابة المتصفح على desktop/mobile (ومنها denial العربي وتنظيف URL وغياب الجلسة). وضمن ذلك 16/16 لاختبارات Google و9/9 للفاحص. هذه أدلة شجرة العمل المحلية، وليست CI أو قبولاً حيًا على الالتزام الجديد.

## 6. قبول GA-F3 اليدوي المتبقي

بحساب اختبار مدرج في **Test users** وبموافقة المالك:

1. ابدأ من زر «الدخول بحساب Google»، وافق فعلاً؛ يجب العودة إلى `/whatsapp` وإظهار الحساب.
2. نفّذ `GET /api/account/me` بالكوكي نفسه وتوقع `200` والبريد الصحيح، ثم تأكد من خصائص كوكي الجلسة في Network.
3. أعد التشغيل وارفض الأذونات؛ يجب ظهور «لم تمنح Google الإذن. لم يتم تسجيل الدخول أو إنشاء حساب.» ولا تُنشأ جلسة.
4. كرر callback القديم؛ يجب الرفض وعدم تبادل code ثانية.
5. استخدم حساب اختبار ثانياً وتأكد أنه لا يرى بيانات الأول.
6. احذف `code` و`state` و`Set-Cookie` وقيم الرموز من HAR/اللقطات قبل حفظها. لا تُرفق بيانات حساب شخصي أو محتوى بريد.

## 7. حدود القرار التالي

- فُتح [PR #159](https://github.com/celiaelazamey-arch/phone-google/pull/159) بطلب صريح من المالك؛ لا دمج أو نشر يدوي أو تعديل Google Cloud Console أو إطلاق عام ضمن هذا الإذن.
- لا تُرفع `WA-010` إلى «دورة دخول مكتملة»: نجاحها الحالي هو قبول Redirect URI فقط.
- لا تُرفع `REL-004` قبل GA-F3 الحقيقي ورسالة WhatsApp ذهاباً وعودة ومتطلبات التشغيل والتكلفة والمراجعة المدرجة في `DEC-129/DEC-130`.
- التراجع عن هذا التغيير هو `git revert` للالتزام بعد المراجعة؛ التراجع عن إنتاج مستقبلي يتبع آخر `known_good` ولا يُوصف بأنه استعادة بيانات.
