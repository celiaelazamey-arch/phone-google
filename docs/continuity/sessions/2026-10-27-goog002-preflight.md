# تسليم جلسة — 2026-10-27 — GOOG-002: فحص جاهزية الربط قبل فتح المتصفح

## السياق

المالك بلّغ أن فحوص PR #27 خضراء وأن الكود جاهز، وطلب متابعة الربط. **الحقيقة الأولى:** PR #27 **مدموج
بالفعل** في `main` عند `47c7033357127b3d93af3088af0346b206ae73c3` (دمج آلي الساعة 11:00Z)؛ لا شيء ينتظر
دمجًا، والفرع الحالي `arena/24d51c71-phone-google` مبني على هذا الدمج. لم يُعَد فتح عمل مدموج.

**الفجوة العملية المتبقية** لم تكن الكود بل أن أي عطل في الربط كان يُكتشف فقط بعد فتح المتصفح ورؤية شاشة
Google. أربعة أخطاء تتكرر وكلها مشاكل **بيئة** قابلة للفحص محليًا:

1. `503 google_not_configured` لغياب `GOOGLE_CLIENT_ID/SECRET` أو لبقائهما placeholder.
2. `redirect_uri_mismatch` لاختلاف حرفي (شرطة زائدة أو مسار مختلف) أو `http` على نطاق عام.
3. **تخطّي تحقق الهوية بهدوء** عندما يكون `APP_OWNER_EMAIL` فارغًا — أخطر من الأولين لأنه لا يُظهر خطأً.
4. رابط ربط على `localhost` يُفتح من الهاتف فيفشل بلا رسالة مفيدة (HOST-003).

## ما نُفّذ (GOOG-002)

| الملف | المحتوى |
|---|---|
| `src/google-preflight.js` | دالة نقية `preflightGoogleConfig(env)` + `formatPreflightReport(report)`: 10 فحوص بحالات `pass/warn/fail` و`fix` عملي لكل فشل. لا شبكة، لا قاعدة بيانات، **ولا تُعاد أي قيمة سرية** (الطول والصيغة فقط) |
| `scripts/google-doctor.mjs` | `npm run google:doctor` (و`-- --json`)، يقرأ `.env` عبر `dotenv/config`، رمز خروج 1 عند وجود مانع |
| `src/google.js` | `GET /api/google/preflight` بعد `requireApiToken` (مالك فقط، `Cache-Control: no-store`)، ويقبل `env` قابلًا للحقن في `createGoogleRouter` |
| `test/google-preflight.test.js` | 10 اختبارات: بيئة كاملة تمر · اعتماد ناقص · صيغة عميل غير Web · المسار الخاطئ/الشرطة/`http` · `localhost` كتحذير مرتبط بـHOST-003 · انقسام المضيف · `APP_OWNER_EMAIL` فارغ مانع · هاتف غير E.164 · مفتاح/رمز/مفتاح ميزة · **لا تسرّب لأي سر في المخرجات** |
| `test/google-preflight-route.test.js` | 2: المسار يرد 401 بلا Bearer، و200 بتقرير `ok: true` بلا تسريب |
| `docs/google-connect.md` | قسم 6 الجديد: الأمران، جدول الفحوص، وحدود ما لا يثبته الفحص |

## الفحوص

| الأمر | النتيجة |
|---|---|
| `npm test` | **95/95 ناجحة** (83 + 12) على Node 22.22.3 |
| `npm run check` | ناجح — **61** ملف JavaScript |
| `npm run check:secrets` | ناجح — 9/9 أسرار، لا تسريب في الردود |
| `npm run release:check` | ناجح — `0.2.1` / السابق `0.2.0` / `schema: 1` |
| `npm run google:doctor` (بيئة فارغة) | 5 موانع + 2 تحذير + رمز خروج 1 — كما هو متوقع |

**ملاحظة بيئية متكررة:** المستودع مقتطاع؛ أول `npm test` في هذه الجلسة أعطى 82/83 لأن commit قاعدة 0.2.0
(`2508893…`) غائب. الحل نفسه المعتاد: `git fetch --unshallow origin` ثم يعود 95/95. هذا ليس عيبًا في
الكود ولا في الاختبار.

## ما لا يُثبته هذا التسليم

- **لا ربط حي مع Google** — يحتاج عميل OAuth من المالك ونطاق HTTPS عام (HOST-003). الفحص يقلّل المفاجآت،
  ولا يستبدل `200` من `GET /api/google/calendar/events?maxResults=1`.
- لا تحقق من وجود العميل فعلًا في Google Cloud، ولا من إضافة البريد في **Test users**، ولا من أن النطاق حي.
- لم يُنشأ سر جديد، ولم يُغيّر أي عقد REST/MCP أو جدول SQL (`schema: 1`).

## الخطوة التالية

1. المالك: عميل OAuth (Web application) + `APP_OWNER_EMAIL` + `APP_OWNER_PHONE_E164` + `APP_BASE_URL` HTTPS.
2. `npm run google:doctor` (أو `GET /api/google/preflight`) حتى يختفي كل `fail`.
3. `POST /api/google/consent-link` أو «اربط جوجل» في واتساب، ثم فتح الرابط، ثم إثبات `200` من أحد مسارات
   جوجل الأربعة.
4. بعد الربط الحي: تجربة الأسئلة الأربعة، ثم واتساب المباشر (Meta app + opted_in)، ثم AGENT-001 بالقرارات
   الأربعة في [خطة الوكيل](../../agent-runtime-plan.md).
