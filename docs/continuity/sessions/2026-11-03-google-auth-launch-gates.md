# جلسة بوابات Google Auth — WA-010 / REL-004 / DEC-132

**التاريخ:** 3–4 نوفمبر 2026  
**الفرع:** `arena/d3067d04-phone-google`  
**الأساس:** `main@3bd53d667d9c54ecc6803dcf557a2e83ee6019b8`  
**PR:** [#159](https://github.com/celiaelazamey-arch/phone-google/pull/159) — مفتوح بطلب المالك، بلا مراجعة/دمج

**النطاق:** تحقق حي من بدء OAuth، إصلاح رفض الموافقة، وفحص نشر آمن؛ فُتح PR #159 بطلب المالك، ولا دمج أو نشر يدوي أو تعديل Google Console ضمنه.

## 1. الحكم والتسمية

- لم يُعَد تعريف `PUB-001`؛ ما زال بوابة النشر ذات القواعد الاثنتي عشرة. سُمّيت بوابات هذه الرحلة `GA-F0…GA-F5` لمنع الالتباس.
- الإطلاق العام باقٍ متوقفًا بموجب `DEC-129+130` و`REL-004`. لا تُشتق الجاهزية من `configured=true` أو بدء OAuth أو نجاح CI وحده.
- المعايير والمسؤولون والأدلة المطلوبة في [`docs/google-auth-launch-gates.md`](../../google-auth-launch-gates.md).

## 2. القياس الحي المستقل

عند `2026-11-03T21:26:15Z` كان `/version` يعلن `0.3.0@3bd53d667d9c54ecc6803dcf557a2e83ee6019b8`. تشغيلة النشر `41684088925` ناجحة وروّجت الالتزام نفسه إلى `known_good`.

| الفحص | النتيجة | الحد |
|---|---|---|
| `/auth/google/diagnostics` | `ok=true` · `google.accepted=true` · `reason=null` · `secretExposed=false` | GA-F0 ناجح لحظة القياس |
| `/auth/google/signin` | وصل إلى `accounts.google.com` بعنوان **Sign in - Google Accounts** و`response_type=code` و`scope=openid email profile` والـRedirect URI المطابق | GA-F1 initiation فقط؛ لا consent ولا جلسة |
| callback اصطناعي بلا كوكي | `oauth_state_cookie_mismatch` | يثبت حارسًا محددًا، لا الرحلة الكاملة |

الأثر المنقّح في [`docs/evidence/google-auth-live-2026-11-03.json`](../../evidence/google-auth-live-2026-11-03.json). لم تُحفظ قيم `state` أو `continue/part/rart` أو الكوكي أو أي رمز/سر.

محاولات Bash/Node المباشرة إلى `/signin` انتهت بـ`ECONNRESET`. لذلك استُخدمت قراءة الصفحة الحية لإثبات الوصول، ولا يُدّعى أن المحاولة الفاشلة قرأت `302` أو `Location` أو `Set-Cookie`.

## 3. العيب والإصلاح

كان callback الذي يحمل `error=access_denied` يسقط عند شرط `code/state` المبكر ويعيد `400 missing_oauth_code_or_state` بصيغة JSON.

الإصلاح المحلي:

1. التحقق من كوكي الحالة كما في مسار النجاح؛ الكوكي الخاطئ يرفض ولا يستهلك الحالة المشروعة.
2. استهلاك `signin:` عبر `consumeOauthState` الذرّي قبل معالجة الرفض.
3. إعادة `302` إلى `/whatsapp?google_error=google_access_denied` ومسح كوكي OAuth.
4. لا Token Exchange ولا userinfo ولا حساب ولا `__Host-celia_wa`.
5. إعادة callback نفسها تفشل `invalid_or_expired_oauth_state`.
6. تعرض الواجهة العربية سببًا ثابتًا وتزيل معلمة الخطأ بـ`replaceState` دون إضافة مدخل تاريخ.

لم تُغيّر هذه الشريحة مسار ربط Workspace للمالك أو صلاحياته.

## 4. فاحص النشر الآمن

`scripts/verify-google-auth.mjs` (`npm run verify:google-auth`) ينفذ تسع بوابات: `GA-F0` و`GA-F1` و`GA-F2-redirect` و`GA-F2-https` و`GA-F2-secrets` و`GA-F2-cookie` و`GA-F2-csrf` و`GA-F3-denial` و`GA-F2-replay`.

- يشترط `302` إلى مسار Google الدقيق؛ HTML المحلي `200` ليس نجاحًا.
- يفشل عند look-alike host أو `client_secret` في URL أو كوكي غير آمن أو JSON denial القديم أو replay مقبول.
- ينقّح state/cookie/code/token/raw Location والقيم السرية، ويكشف تسريب السر دون نسخه إلى الدليل.
- لا يتبع Google consent ولا ينشئ جلسة، ويكتب دائمًا `launch.ready=false` و`blocked_pending_external_gates`.
- في `cloudflare-deploy.yml` يعمل بعد `verify:live` وقبل ترقية `known_good`، ثم يُرفع `google-auth-live.json`.

## 5. نتائج التنفيذ المحلية

- `test/google-account-signin.test.js`: **16/16**.
- `test/verify-google-auth.test.js`: **9/9**.
- التشغيل المشترك للملفين: **25/25**.
- `test/google-account-signin.test.js test/edge-full-runtime.test.js`: **34/34**.
- البوابة الأساسية قبل الإصلاح (`google-account-signin` + `verify-live` + `security-posture`): **38/38**.
- `npm run test:browser`: **40/40** على desktop/mobile، بما فيها denial العربي وتنظيف URL وعدم ظهور جلسة.
- `build:edge-ui` و`build:manifest` و`arch:map` و`atlas` و`atlas:facts` و`atlas:dashboard` و`visual:first`: نجحت.
- `npm audit --omit=dev --audit-level=moderate`: **0 vulnerabilities** على أساس الشجرة المدققة؛ يعاد في البوابة النهائية.

### عائق بيئة المتصفح

لم يكن Chromium موجودًا. بعد `npm install --no-save @sparticuz/chromium` أخفق loader الحالي لأن الحزمة الأحدث لا تصدّر `bin/al2023.tar.br` (`ERR_PACKAGE_PATH_NOT_EXPORTED`). لم يُغيّر كود المتصفح خارج النطاق؛ استُخرج الثنائي والمكتبات إلى `/tmp` وشُغّلت البوابة بمتغيري `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` و`CELIA_CHROMIUM_LIB_DIR`. التشغيلان الأحمران السابقان كانا قبل إطلاق المتصفح (غيابه ثم مسار `libnspr4.so`)، والتشغيل الكامل النهائي أخضر 40/40.

## الدليل البصري

- [لقطة رفض Google على واجهة الحساب](../../design/google-auth-denial-2026-11-04.png): التُقطت من أصل `public` الفعلي مع تحويل `<body data-runtime="edge">` نفسه الذي يطبقه Worker، وبعرض 390px. كان `/api/account/me=401` stub معلنًا، فظهرت بطاقة الحساب والرسالة العربية كاملة وزر Google مفعّلًا. لا توجد جلسة أو استجابة إنتاج في اللقطة.
- تحقق Playwright أثناء الالتقاط من نص «لم تمنح Google الإذن. لم يتم تسجيل الدخول أو إنشاء حساب.» ومن إزالة `google_error` من URL. بوابة المتصفح الكاملة 40/40 تغطي أيضًا سطح المكتب والهاتف وWCAG.

## 6. ما لم يُنجز ولا يجوز ادعاؤه

- لا موافقة مستخدم حقيقية ولا `/api/account/me=200` ولا دليل كوكي جلسة نجاح حي أو عزل حساب ثانٍ.
- لا تشغيلة GitHub Quality/CodeQL على الالتزام الجديد بعد، ولا artifact حي للفاحص قبل أول نشر يحمله.
- PR #159 مفتوح بطلب المالك؛ لا مراجعة مالك/دمج بعد (GA-F4)، ولا نشر معتمد أو مراقبة 60 دقيقة أو `attempts>0` مع `successful=attempts` (GA-F5).
- لا رسالة واتساب ذهابًا وعودة ضمن هذه الشريحة؛ شرط `REL-004` مستقل.
- لا تعديل Google Cloud Console ولا أسرار ولا تكلفة جديدة.

## 7. بوابة التسليم النهائية

- `npm test`: **1305 / 1288 pass / 0 fail / 17 skipped**. فاحص التخطيات قبل 17 فجوة بيئية مسماة و0 غير متوقع؛ لم تُحسب المتخطيات نجاحًا.
- `npm run test:browser`: **40/40** بعد `npm ci` النظيف، من ثنائي ومكتبات مستقلة داخل `node_modules/.cache` غير المتعقَّب.
- `npm run test:coverage`: **92.70 / 78.24 / 87.71** للأسطر/الفروع/الدوال؛ أرضيات 89/71/82 ناجحة.
- `npm run check`: **268 JavaScript files**؛ و`plan:check` = 68 مهمة مفتوحة (23 P0 · 31 P1 · 14 P2) و`check:continuity` = 157 وثيقة / 496 رابطًا / 137 مهمة، و`now:check` ناجح.
- نجحت فحوص drift للحزمة والـmanifest والخريطة والأطلس واللوحة وVisual-First والصلاحيات وCopilot وKB، و`verify:edge-provenance` (12 وحدة، `sha256:34b3b23803fb…`) و`build:pages`.
- `check:secrets`: 18/18 wiring وzero-leak؛ `npm audit --omit=dev --audit-level=moderate`: صفر ثغرات؛ `agents:doctor`: 11 يعمل / 1 جزئي / 1 غير مفعّل / 1 متعطل خارجيًا / 0 معطوب.
- إخفاقات الجولة الكاملة الأولى الأربع كانت خطوط أساس توثيقية بعد إعادة فتح WA-008 وإضافة Unreleased؛ حُدّثت PSC/PRG لتصف الواقع الجديد، ونجحت إعادة التشغيل الكاملة. لم تُخفَّض أي بوابة أمن أو تغطية.
- أظهر أول CI للـPR #159 فشل Node 22/24 عند Visual-First لغياب قسم الدليل في هذا السجل؛ أُضيفت اللقطة أعلاه ونجح محليًا `visual:first:check` و`check:continuity` مع `CELIA_CONTINUITY_BASE=3bd53d6…` وبوابة handoff. لا يُدّعى نجاح CI الجديد قبل ظهوره على GitHub.
- **المتبقي بعد هذه البوابة:** تشغيلات GitHub على commit الـPR، مراجعة المالك، ثم قرار دمج مستقل. لا دمج أو نشر أو مراقبة إنتاج ضمن هذا التسليم.
