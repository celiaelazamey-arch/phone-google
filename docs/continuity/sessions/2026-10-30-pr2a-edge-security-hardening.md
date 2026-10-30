# تسليم جلسة — 2026-10-30 — تحصين أمان الحافة `PR 2a` (`HIGH-05`, `HIGH-07`, `HIGH-02`, `DEC-063`)

## المهمة والتفويض

- **طلب المستخدم والمتطلبات المهمة:** تنفيذ الشريحة `PR 2a` المعزولة بالكامل لطبقة Cloudflare Edge + D1 على الفرع `arena/e83ae32c-phone-google` متفرعًا من `main@87a357d1183ddc206e1e0e7030ecd2d6a9790581` دون لمس أي ملف داخل `src/` (تأجيل شق Node/Agent إلى `PR 2b` وما يليه)، مع إثبات `fail-before / pass-after` لكل commit كود، وتوثيق قرار `DEC-063`، ثم الدفع وفتح PR إلى `main` دون دمج أو تشغيل أي `workflow_dispatch` يدوي.
- **معرفات `BACKLOG` ذات الصلة ومعايير القبول:** `SEC-001`، `SEC-002`، `OPS-007`، `CONT-004` — تطبيق ترحيلات D1 عبر جدول تتبع `_migrations` وسياسة `fail-closed` إلزامية قبل رفع الـWorker، وحجز مفاتيح عدم التكرار ذريًا (`pending` -> `completed` مع CAS takeover بعد انتهاء المهلة وتسجيل الاكتمال فور نجاح المزود الخارجي قبل التسجيل المحلي)، واستهلاك `oauth_states` وتذاكر `ticket` ذريًا لمرة واحدة مع التمييز الصارم بين `browser:` و`link:`، وإغلاق تجاوزات SSRF للنقاط اللاحقة (trailing-dot FQDN/IPv4) وصيغ IPv6 الانتقالية والخاصة.

## واقع البداية

- **الفرع وخط الأساس:** `arena/e83ae32c-phone-google` متفرع من `main@87a357d1183ddc206e1e0e7030ecd2d6a9790581` بعد دمج PR #101 · الإصدار `v0.2.1` (`812` اختبارًا أساسيًا).
- **العزل الصارم:** صفر تعديل في `src/` طوال الفرع؛ التعديلات محصورة في `workers/celia-edge/`، و`scripts/deploy-cloudflare-edge.mjs`، و`test/`، و`docs/continuity/`.

## ما تغير فعليًا

1. **`398c41b` (`HIGH-05` + `0005` + `_migrations` + `fail-closed`):**
   - إنشاء [`workers/celia-edge/migrations/0005_edge_idempotency_state.sql`](../../../workers/celia-edge/migrations/0005_edge_idempotency_state.sql) لإضافة `status` و`dispatched_at` والفهرس الجزئي `idx_edge_idempotency_pending`.
   - إضافة `loadMigrationFiles` و`applyVersionedMigrations` بجدول `_migrations` وتمهيد آمن لـ`0001..0004` وإيقاف النشر `fail-closed` (`migration-failed`) قبل رفع الـWorker في [`scripts/deploy-cloudflare-edge.mjs`](../../../scripts/deploy-cloudflare-edge.mjs) مع حفظ `applyMigrations` الخام لـ[`test/edge-d1.test.js`](../../../test/edge-d1.test.js).
   - تنفيذ الحجز الذري `pending` وفحص `row.status === 'completed'` قبل `JSON.parse` وCAS takeover (`18s` لواتساب و`22s` للتقويم) واستدعاء الاكتمال فور نجاح المزود الخارجي قبل `INSERT` المحلي ومنع تكرار ويبهوك واتساب ذريًا في [`workers/celia-edge/runtime.js`](../../../workers/celia-edge/runtime.js) وتمرير `env.__NOW` في [`workers/celia-edge/worker.js`](../../../workers/celia-edge/worker.js)، مع 5 اختبارات مستقلة في [`test/edge-full-runtime.test.js`](../../../test/edge-full-runtime.test.js) واختبارات الناشر في [`test/deploy-cloudflare-edge.test.js`](../../../test/deploy-cloudflare-edge.test.js) وتحديث `RM-06` في [`test/edge-reply-metrics.test.js`](../../../test/edge-reply-metrics.test.js).
2. **`566026f` (`HIGH-07`):**
   - تمييز رموز `state` ببادئتَي `browser:<hex>` و`link:<hex>` وإلزام كوكي `celia_oauth_state` لـ`browser:` قبل لمس D1، واستهلاك `oauth_states` ذريًا (`UPDATE ... WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?` مع فحص `meta.changes === 1`)، واستهلاك تذاكر `/auth/google?ticket=...` ذريًا لمرة واحدة ببادئة `ticket:<sha256>` في [`workers/celia-edge/runtime.js`](../../../workers/celia-edge/runtime.js) و[`workers/celia-edge/worker.js`](../../../workers/celia-edge/worker.js) مع 5 اختبارات مستقلة `HIGH-07 (1/5)..(5/5)` في [`test/edge-full-runtime.test.js`](../../../test/edge-full-runtime.test.js).
3. **`2a27b71` (`HIGH-02`):**
   - تطبيع النقاط اللاحقة ومنع صيغ IPv4 البديلة وتحليل IPv6 قياسيًا إلى `uint16[8]` لحظر `NAT64`، و`6to4`، و`Teredo`، و`SIIT`، و`IPv4-compatible`، و`ISATAP`، ومعرفات `%zone` في [`workers/celia-edge/cron.js`](../../../workers/celia-edge/cron.js) مع 4 اختبارات مستقلة `HIGH-02 (1/4)..(4/4)` في [`test/edge-cron-outbox.test.js`](../../../test/edge-cron-outbox.test.js).
4. **توثيق القرار `DEC-063`:** إضافة [`DEC-063`](../DECISIONS.md) لنسخ بند `fail-open` جزئيًا من `DEC-035`.

## الفحوص

| الأمر/الفحص | النتيجة الفعلية |
|---|---|
| `npm run check` | `Syntax verified: 187 JavaScript files.` |
| `node --test test/edge-d1.test.js` | `15 / 15 pass` (`0 fail`) |
| `npm run test:ci` | `828 tests · 811 passed · 0 failed · 17 skipped` |
| `npm run now && npm run now:check && npm run check:continuity` | `0 fail` — التحقق الهيكلي والروابط وبوابة التسليم خضراء |

## الحفظ والاستئناف

- **حالة الدفع والإنتاج:** يُرفع الفرع `arena/e83ae32c-phone-google` ويُفتح `PR 2a` إلى `main` دون دمج ودون تشغيل أي `workflow_dispatch` يدوي؛ يظل `main` والإنتاج عند `87a357d` حتى مراجعة المالك واعتماده الصريح للدمج، مع الالتزام بقاطع الدائرة لتشغيلة `service-reality.yml` المجدولة يوم الإثنين `2026-11-02 06:00 UTC`.
- **الخطوة التالية بعد دمج `PR 2a`:** فتح فرع مستقل لـ `PR 2b` لتنفيذ شق Node/Agent المؤجل (`HIGH-04`, `HIGH-01`, `HIGH-06`, `HIGH-03` وشق Node لـ`HIGH-05`/`HIGH-07`/`HIGH-02`).
