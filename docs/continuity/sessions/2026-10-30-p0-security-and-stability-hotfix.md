# تسليم جلسة — 2026-10-30 — إصلاحات الأمان والاستقرار الحرجة P0 (`CRIT-01..04`, `LOW-02`)

## المهمة والتفويض

- **طلب المستخدم والمتطلبات المهمة:** تنفيذ شريحة الإصلاحات الحرجة العاجلة (Option A — P0 Hotfix) على الفرع `arena/0a520cc0-phone-google` في التزامات ذرية متسلسلة مع اختبارات فشل-قبل/نجاح-بعد لكل ثغرة، مع الفصل الصارم عن الشريحة الثانية (`HIGH-05`، `HIGH-01..09`، `MED-01..06`، `LOW-01`)، ورفع الفرع وفتح طلب دمج (PR) إلى `main` دون دمج أو نشر على الإنتاج قبل مراجعة المالك وتفويضه الصريح.
- **معرفات `BACKLOG` ذات الصلة ومعايير القبول:** `SEC-001`، `AGENT-001`، `AGENT-006`، `CONT-004` — إغلاق حقن الأوامر في `workflow_dispatch` عبر تمرير المدخلات بمتغيرات `env:` والتحقق الصارم بالـRegex مع حارس ثابت (`test/workflows-static.test.js`)، وتمرير `getConnection` في مغلّف تجمع MySQL (`src/db.js`)، ومنع انهيار الإقلاع في `createAgentHost` وإغلاق `egressProxy` عند الإيقاف (`src/agent/index.js`)، وحماية `headersSent` وتسقيف سجل الأحداث في الذاكرة واحتساب `head` في أنفاق `CONNECT` (`src/agent/egress-proxy.js` و`src/agent-routes.js`)، وتخطي فحص الكائن التاريخي في الاستنساخات السطحية (`test/secrets-hub.test.js`) ليبلغ `npm run test:ci` صفر إخفاقات (`0 fail`).
- **النطاق المسموح؛ ما يحتاج موافقة مستقلة:** `.github/workflows/` (4 ملفات)، `src/db.js`، `src/agent/index.js`، `src/agent-routes.js`، `src/agent/egress-proxy.js`، `test/`، `docs/continuity/`. يحتاج دمج الـPR في `main` وتشغيل النشر على Render وتدوير الأسرار إلى تفويض صريح من المالك.

## واقع البداية

- **الفرع الذي أثبتته البيئة وGit:** `arena/0a520cc0-phone-google` متفرع من `main@112fe714aebaf57bd8fb455ac2ae5e4a83ba91ff` (`112fe71`).
- **baseline commit وإصدار التطبيق:** `112fe71` · الإصدار `v0.2.1` (`schema=1`، بلا ترقية إصدار وبلا ترحيل قاعدة بيانات).
- **worktree المستخدم الذي وجب الحفاظ عليه:** نظيف تمامًا عند البداية؛ قياس خط الأساس قبل التعديل لـ `npm run test:ci` كان `802` اختبارًا (`785 pass` / `16 skip` / `1 fail` في `test/secrets-hub.test.js:323` بسبب الاستنساخ السطحي).
- **حالة PR/CI/النشر عند البداية:** لم يكن هناك PR مفتوح لهذا الفرع؛ الإنتاج على Render وCloudflare لم يُمس.

## ما تغير فعليًا

- **الملفات والوحدات والغرض (مرتبة حسب الالتزامات):**
  1. **`bdb08ca` (`CRIT-01`) + `bd1c033` (`CRIT-01 follow-up`):** إزالة الاستيفاء المباشر لـ `${{ inputs.* }}` و`${{ github.event* }}` من كتل `run:` في [`.github/workflows/service-reality.yml`](../../../.github/workflows/service-reality.yml)، و[`.github/workflows/deploy-render.yml`](../../../.github/workflows/deploy-render.yml)، و[`.github/workflows/issue-triage.yml`](../../../.github/workflows/issue-triage.yml)، و[`.github/workflows/issue-triage-selftest.yml`](../../../.github/workflows/issue-triage-selftest.yml) واستبدالها بمتغيرات `env:` محققة بصرامة (`^(0(\.[0-9]+)?|1(\.0+)?)$` لـ `min_rate`، و`^[1-9][0-9]*$` لأرقام التذاكر، و`^(cautious|propose)$` للوضع) مع الحفاظ على القيم الافتراضية (`0.95`، `61`، `cautious`)، وإضافة الحارس الثابت [`test/workflows-static.test.js`](../../../test/workflows-static.test.js) الذي يفحص جميع ملفات `.github/workflows/*.yml` (الصيغة الخطية وجميع صيغ الكتل `|`، `|-`، `|+`، `>`، `>-`، `>+`).
  2. **`b24b267` (`CRIT-02`):** كشف `getConnection` على المغلّف المُعاد من `createPool()` في [`src/db.js`](../../../src/db.js) مع تحضير صف المالك عند تفعيل `prepareOwner`، وإضافة اختبار العقد [`test/db-pool-contract.test.js`](../../../test/db-pool-contract.test.js) الذي يختبر `createPool -> createMysqlDriver(pool).transaction(...)` على اتصال `mysql2` فعلي (التزام وتراجع عند الخطأ) وحارس فشل حتمي عند غياب `getConnection`.
  3. **`e0fff91` (`CRIT-04`):** إحاطة `readAgentEgress(env)` بـ `try/catch` داخل `createAgentHost()` في [`src/agent/index.js`](../../../src/agent/index.js) لتسجيل فشل الإقلاع المرمّز دون إسقاط الخادم الرئيسي، وربط معالج جانبي `ready.catch(...)` يمنع `ERR_UNHANDLED_REJECTION` عند عدم انتظار `host.ready` في النبضة الأولى مع إبقاء رفض `await host.ready` سليمًا لـ `HOST-01`/`HOST-02`، وإضافة `async host.close()` لإيقاف وقت التشغيل وإغلاق مستمع `egressProxy` المحلي، مع اختبارات [`test/agent-host-boot-safety.test.js`](../../../test/agent-host-boot-safety.test.js).
  4. **`859adf6` (`CRIT-03`):** حراسة `reply()` ضد `res.headersSent || res.writableEnded || res.destroyed` في [`src/agent/egress-proxy.js`](../../../src/agent/egress-proxy.js)، وتسقيف حلقة سجل الأحداث `events[]` في الذاكرة عبر `limits.maxEvents` (الافتراضي `1000`)، واحتساب بايتات `head` في أنفاق `CONNECT` ضمن `bytesOut` وفرض سقف `maxRequestBytes` عليها، ومنع الإرسال المزدوج في `GET /api/agent/egress` وحراسة `fail()` وميدلوير الأخطاء في [`src/agent-routes.js`](../../../src/agent-routes.js)، مع توسيع [`test/agent-egress-proxy.test.js`](../../../test/agent-egress-proxy.test.js) (`EP-15..17`) و[`test/agent-routes.test.js`](../../../test/agent-routes.test.js).
  5. **`3b1daaa` (`LOW-02`):** تعديل [`test/secrets-hub.test.js`](../../../test/secrets-hub.test.js) لاستدعاء `t.skip(...)` نظيفًا عندما يغيب الكائن التاريخي `2508893` في الاستنساخات السطحية، مع بقاء فحص التوافق العكسي `N/N-1` فعّالًا بالكامل عند توفر التاريخ الكامل (`fetch-depth: 0` في CI).
- **قرارات `DEC` الجديدة/المستبدلة:** لا يوجد قرار معماري جديد؛ التنفيذ يلتزم بـ `DEC-015` و`DEC-016` و`DEC-052` و`DEC-060`.
- **ما بقي مؤجّلًا للشريحة الثانية ولم يُنفذ عمدًا في هذا الـPR:** `HIGH-05` (إصلاح استنزاف المفتاح وجعل `idempotencyStore.complete()` يسبق `INSERT` المحلي دون استدعاء `fail()` بعد نجاح المزود الخارجي)، وبقية بنود `HIGH-01..09` و`MED-01..06` و`LOW-01`.

## الفحوص

| الأمر/الفحص | commit/البيئة | النتيجة الفعلية |
|---|---|---|
| `node --test test/workflows-static.test.js` | `bd1c033` (Node 22.22.3) | `2 / 2 pass` (`0 fail`) |
| `node --test test/db-pool-contract.test.js` | `b24b267` (Node 22.22.3) | `2 / 2 pass` (`0 fail`) |
| `node --test test/agent-host-boot-safety.test.js test/agent-gemini-planner.test.js test/agent-web-access.test.js test/agent-boot-recovery.test.js` | `e0fff91` (Node 22.22.3) | `47 / 47 pass` (`HOST-01/02` و`WB-01..14` خضراء) |
| `node --test test/agent-egress-proxy.test.js test/agent-routes.test.js test/agent-web-access.test.js` | `859adf6` (Node 22.22.3) | `35 / 35 pass` (`EP-01..17` خضراء) |
| `npm run check` | `3b1daaa` (Node 22.22.3) | `Syntax verified: 187 JavaScript files.` |
| `npm run test:ci` | `3b1daaa` (Node 22.22.3) | `812 tests · 795 passed · 0 failed · 17 skipped` |
| `npm run now && npm run now:check && npm run check:continuity && npm run check:secrets` | التزام التسليم (Commit 6) | `0 fail` — التحقق من الروابط و`STATE.md < 20KB` و`NOW.md` |

## الحفظ والتسليم

- **commit/مرجع التغيير، وحالة الدفع الفعلية:** الفرع `arena/0a520cc0-phone-google` يُرفع إلى `origin/arena/0a520cc0-phone-google` مباشرة بعد التزام التسليم هذا مع فتح PR إلى `main`.
- **رابط PR وCI:** يُفتح الـPR إلى `main` فور الدفع؛ هذا الالتزام وفتح الـPR **لا يُعدّان نشرًا** لأن `main` والإنتاج لم يتغيرا بعد.
- **حالة الإنتاج والبيانات والأسرار (العمليات التي لم تُنفذ):**
  - لم يُدمج الـPR في `main`.
  - لم يُشغَّل `deploy-render.yml` ولم يُنشر أي كود على Render أو Cloudflare.
  - لم تُمس أي قاعدة بيانات إنتاجية أو أسرار مستودع.
  - **إجراء أمني واجب بعد الدمج (`CRIT-01`):** إذا سبق لأي حساب غير المالك تشغيل `service-reality.yml` عبر `workflow_dispatch` قبل دمج هذا الإصلاح، يجب تدوير الـ **28 سرًا** المحمّلة في الخطوة المتأثرة (`.github/workflows/service-reality.yml` الأسطر 67–96) وفق `SECURITY.md`.
- **أي نتيجة خارجية غير معروفة:** لا توجد أي طلبات خارجية معلّقة أو غير معروفة النتيجة.

## الاستئناف

- **العوائق والمعلومات المطلوبة دون أسرار:** انتظار مراجعة المالك للـPR المفتوح من `arena/0a520cc0-phone-google` إلى `main` وقراره بشأن الدمج والنشر وتدوير الأسرار إن لزم.
- **الخطوة التالية بالضبط وأول فحص آمن:**
  1. مراجعة فحوص CI على الـPR المفتوح ثم دمجه في `main` بقرار المالك، يليها نشر Render والتحقق من `/health` وتطابق SHA.
  2. في فرع مستقل بعد الدمج: البدء بالشريحة الثانية (`HIGH-05` في `src/idempotency.js` والمسارات المستهلكة بحيث يُستدعى `complete()` فور نجاح المزود الخارجي قبل `INSERT` المحلي).
  3. أول فحص آمن عند الاستئناف: `npm run check && npm run now:check && npm run check:continuity && npm run test:ci`.
- **تأكيد تحديث `STATE` و`NOW`:** تم تحديث [`STATE.md`](../STATE.md) مع إبقاء حجمه تحت سقف 20 كيلوبايت والحفاظ على رابطي [`STATE-ARCHIVE-2026-10.md`](../STATE-ARCHIVE-2026-10.md) و[`NOW.md`](../NOW.md)، وإعادة توليد [`NOW.md`](../NOW.md) عبر `npm run now`.
