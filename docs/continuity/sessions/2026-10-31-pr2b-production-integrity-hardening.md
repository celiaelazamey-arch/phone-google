# تسليم جلسة — 2026-10-31 — تحصين سلامة الإنتاج الحية وتكافؤ أمان Node/MCP `PR 2b` (`HIGH-05`, `HIGH-07`, `HIGH-02`)

## المهمة والتفويض

- **طلب المستخدم والمتطلبات المهمة:** بعد دمج `PR #102` (`PR 2a`) في `main@689bb8ea38fff6c22540aba5b14219174b7fe381` والتحقق من نشره الحي على Cloudflare Edge + D1 (`41124514361`)، وجّه المالك: «نفذ ما يخدم الإنتاج» على الفرع `arena/ccf29ee7-phone-google` مع الالتزام الصارم بجميع قواعد الفحص القبلي/البعدي (`fail-before / pass-after`)، وسيناريو واحد لكل اختبار، واختبارات التزامن `Promise.all`، وعدم الدمج التلقائي أو تشغيل أي `workflow_dispatch` يدوي.
- **معرفات `BACKLOG` ذات الصلة ومعايير القبول:** `SEC-001`، `SEC-002`، `SEC-003`، `DATA-003`، `OPS-007`، `CONT-004` — سد ثغرات التزامن وفك الترميز الحية في طبقة Cloudflare Edge + D1 المنشورة فعليًا، وإتمام تكافؤ `HIGH-05` و`HIGH-07` و`HIGH-02` في وقت تشغيل Node/MCP/GHCR دون لمس الأسطح الموقوفة غير المفعّلة في الإنتاج (`CELIA_AGENT_EGRESS=off`).

## واقع البداية

- **الفرع وخط الأساس:** `arena/ccf29ee7-phone-google` متفرع من `main@689bb8ea38fff6c22540aba5b14219174b7fe381` · الإصدار `v0.2.1` (`828` اختبارًا أساسيًا: `811 pass / 0 fail / 17 skip`).
- **واقع الإنتاج المُثبت قبل التعديل:** تشغيلة `Deploy (Cloudflare Edge)` رقم `41124514361` على `main@689bb8e` طبّقت `0005_edge_idempotency_state.sql` ومهّدت `0001..0004` في `_migrations` على قاعدة `celia-edge-state` الحية (`preAppliedFiles: 4, appliedFiles: 1, statements: 4`، `storage.durable: true`)، وتشغيلات `main` السبع جميعها ناجحة/متخطاة حسب الشرط (`service-reality.yml` عند `41124514547` متخطاة في حدث `push` وستعمل تلقائيًا في موعدها المجدول الإثنين `2026-11-02 06:00 UTC`).

## ما تغير فعليًا

1. **`59b2c17` (سلامة الحافة الحية Cloudflare Edge + D1 — `workers/celia-edge/{worker,state,cron}.js`):**
   - حراسة `decodeURIComponent` في مسار `/api/state/:key` بـ`try/catch` لإرجاع `400 invalid_key` بدل استثناء `URIError` غير ملتقط عند تمرير ترميز نسبة مشوّه.
   - تسلسل كتابات `appendAudit` لكل ربط `env.DB` مع إدراج شرطي ذري `INSERT INTO edge_audit ... SELECT ... WHERE COALESCE((SELECT hash FROM edge_audit ORDER BY seq DESC LIMIT 1), 'genesis') = ?` وإعادة المحاولة المحدودة لمنع تفرّع `prev_hash` وكسر سلسلة التدقيق الإلحاقية تحت الكتابات المتزامنة دون أي `UPDATE`/`DELETE` (بقاء `SP-11` و`test/edge-d1.test.js` `15/15` سليمين).
   - تحويل إدراج `createIntent` في `edge_cron_outbox` إلى `ON CONFLICT(idempotency_key) DO NOTHING` مع إعادة القراءة الذرية عند التعارض لإرجاع `200 replayed: true` أو `409 idempotency_key_reused` بدل خطأ `UNIQUE constraint failed` تحت `Promise.all`.
   - إضافة 4 اختبارات مستقلة (`EDGE-PROD (1/2)..(2/2)` في [`test/edge-full-runtime.test.js`](../../../test/edge-full-runtime.test.js) و`EDGE-CRON (1/2)..(2/2)` في [`test/edge-cron-outbox.test.js`](../../../test/edge-cron-outbox.test.js)).
2. **`ba105f6` (`HIGH-05` شق Node/MCP — `src/{idempotency,whatsapp,celia-mcp,integrated-api,google,secrets-hub,app}.js`):**
   - استدعاء `idempotencyStore.complete(...)` فور نجاح الإرسال الخارجي إلى Meta في كل من `POST /api/whatsapp/messages` وأداة MCP `whatsapp_send_text` **قبل** جملة `INSERT IGNORE INTO whatsapp_messages` المحلية، وعزل التسجيل المحلي بـ`try/catch` مستقل يمنع استدعاء `fail()` أو تكرار الرسالة عند تعثر قاعدة البيانات المحلية.
   - إضافة عزل النطاق (`whatsapp.send`, `calendar.create`, `elevenlabs.tts`) وتمرير مخزن مشترك عبر `createCeliaMcpApp` و`createIntegratedApiRouter` و`createApp` لمنع تصادم المفاتيح بين الأدوات مع توحيد منع التكرار بين HTTP وMCP.
   - إضافة مهلة حجز قصيرة للطلبات الجارية (`inProgressTtlMs` الافتراضية `30s`) مع رمز ملكية `claimToken` يمنع `fail()` المتأخر من حذف حجز مالك أحدث، وحماية الحجوزات الجارية (`in_progress`) من الطرد عند امتلاء `maxEntries`.
   - إنشاء [`test/node-idempotency-hardening.test.js`](../../../test/node-idempotency-hardening.test.js) بـ5 اختبارات مستقلة (`HIGH-05 Node (1/5)..(5/5)`).
3. **`898765c` (`HIGH-07` شق Node OAuth — `src/google.js`):**
   - استهلاك تذاكر `/auth/google?ticket=...` ذريًا فور أول استخدام (`UPDATE oauth_states SET used_at = UTC_TIMESTAMP() ...` مع شرط `affectedRows === 1`) ثم إصدار رمز `state` مستقل ببادئة `browser:<64-hex>` حتى لا تتسرب التذكرة الموقّعة إلى عنوان Google أو الكوكي ولا تقبل إعادة الاستخدام المتزامنة.
   - إلزام مطابقة `/^browser:[0-9a-f]{64}$/` في `/auth/google/callback` قبل لمس قاعدة البيانات لمنع استخدام صف التذكرة مباشرةً في رد النداء، وحراسة `readCookie` ضد `URIError`.
   - إضافة 5 اختبارات مستقلة (`HIGH-07 Node (1/5)..(5/5)`) في [`test/google-consent.test.js`](../../../test/google-consent.test.js).
4. **`77e7e35` (`HIGH-02` شق Node SSRF — `src/{ai-providers,ollama}.js`):**
   - توحيد `isDisallowedHost` مع حارس الحافة لحظر النقاط اللاحقة (`localhost.`, `metadata.google.internal.`, `127.0.0.1.`) واسم `metadata` المجرّد وصيغ IPv4 المختصرة/الثمانية/الست عشرية وتحليل IPv6 القياسي إلى `uint16[8]` لحظر `NAT64` و`6to4` و`Teredo` و`SIIT` و`IPv4-compatible` و`ISATAP` و`%zone`.
   - تحصين `normalizeOllamaBaseUrl` لمنع مضيفي بيانات تعريف السحابة والربط المحلي (`169.254.169.254`, `metadata.google.internal`, `fe80::/10`, `NAT64`) حتى عند تفعيل `OLLAMA_ALLOW_REMOTE=true` مع الحفاظ على التوافق مع نطاقات الشبكة الداخلية المصرح بها.
   - إضافة 4 اختبارات مستقلة (`HIGH-02 Node (1/4)..(4/4)`) في [`test/security-surface-audit.test.js`](../../../test/security-surface-audit.test.js).
5. **تحديث حالة `DEC-063`:** تحديث سطر حالة [`DEC-063`](../DECISIONS.md) لتوثيق دمجه ونشره الحي على `main@689bb8e` (`41124514361`) دون المساس بتاريخه الأصلي (`2026-10-30`).

## الفحوص

| الأمر/الفحص | النتيجة الفعلية |
|---|---|
| `npm run check` | `Syntax verified` (جميع ملفات JavaScript سليمة نحويًا) |
| `node --test test/edge-d1.test.js` | `15 / 15 pass` (`0 fail`) |
| `npm run test:coverage:ci` | `846 tests · 829 passed · 0 failed · 17 skipped · coverage lines 91.28% · branches 76.77% · functions 86.69%` |
| `npm run test:ci` | `846 tests · 829 passed · 0 failed · 17 skipped` |
| `npm run now && npm run now:check && npm run check:continuity && npm run check:secrets` | `0 fail` — التحقق الهيكلي والروابط وبوابة الأسرار خضراء |

## الحفظ والاستئناف

- **حالة الدفع والإنتاج:** يُرفع الفرع `arena/ccf29ee7-phone-google` ويُفتح PR إلى `main` دون دمج ودون تشغيل أي `workflow_dispatch` يدوي؛ يظل `main` والإنتاج عند `689bb8e` حتى مراجعة المالك وقراره الصريح بالدمج، مع استمرار قاطع الدائرة لتشغيلة `service-reality.yml` المجدولة يوم الإثنين `2026-11-02 06:00 UTC`.
- **الخطوة التالية بعد دمج `PR 2b`:** التحقق من نجاح نشر Cloudflare Edge وإصدار الحاوية تلقائيًا على `main`، ومراقبة تشغيلة `service-reality.yml` المجدولة يوم الإثنين قبل الانتقال إلى أي شريحة لاحقة.
