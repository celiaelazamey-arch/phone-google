# جلسة 29 أكتوبر 2026 — المهام المجدولة داخل عامل الحافة عبر صندوق صادر (DEC-042، OPS-007)

**الفرع:** `arena/90163669-phone-google` · **القاعدة:** `main@4f6af77` (دمج PR #73) · **القرار:** DEC-042 · **المهمة:** OPS-007 ·
**الأصل:** الخيار (3) من DEC-040 بدل إحياء PR #38 (الذي يبقى مفتوحًا حتى كلمة المالك «أغلق #38»).

## 1. الطلب وكيف قُرئ

«إعادة فكرة لوحة cron كمهمة جديدة داخل `workers/celia-edge` عبر outbox»: الفكرة الصالحة في #38 (لوحة المهام المجدولة على cron-job.org)
تُعاد بالعقد الذي يحكم كل أثر خارجي في النظام — عامل واحد، المفتاح الموجود `CELIAOS_CRONJOB_ORG_API_KEY` ورمز المالك، قراءة أولًا،
وكل كتابة عبر outbox وموافقة (DEC-015)؛ لا أسرار جديدة (DEC-036/037)، لا متجر محاكاة (DEC-030)، لا واجهة زائفة.

## 2. ما وُجد قبل التنفيذ

- `workers/celia-edge/worker.js` كان يوكّل `https://api.cron-job.org` أصلًا: `GET/POST/PATCH/DELETE /api/cron/jobs…` بمفتاح العامل، بعد
  `validateCronJobPayload` (قائمة حقول + https فقط + حارس SSRF) وسقف 8 KiB ومهلة 15 ثانية — لكن **الكتابة كانت مباشرة**: بلا outbox،
  بلا موافقة، بلا idempotency، بلا سجل. فجوة DEC-015 كانت في الحافة لا في #38 فقط.
- D1 مربوط عند النشر (`isD1Bound`)، سلسلة `edge_audit` موجودة (`appendAudit`/`verifyAuditChain`)، و`scripts/deploy-cloudflare-edge.mjs`
  يطبّق كل `migrations/*.sql` مرتبة — فهجرة جديدة تنتشر تلقائيًا مع النشر من `main`.
- نُقل أولًا commit التوثيق `68a45f9` من الفرع السابق (ما بعد دمج #73) إلى هذا الفرع بـ`cherry-pick` (`60bc349`).

## 3. ما نُفِّذ

| الملف | الدور |
|---|---|
| `workers/celia-edge/cron.js` (جديد) | حارس SSRF/الحقول (نُقل من `worker.js` ويعاد تصديره)، تنقية القراءات (`sanitizeJobSummary/Details/HistoryItem`, `redactUrl`)، `readUpstream`، والصندوق: `createIntent` (مفتاح idempotency إلزامي `^[A-Za-z0-9_-]{8,64}$`؛ نفس المفتاح + نفس البصمة = 200 replay؛ حمولة مختلفة = 409)، `approveIntent` (`expectedHash` ≥ 12 خانة، إعادة حساب البصمة من الصف، ادعاء مشروط `WHERE status='pending_approval'` عبر `meta.changes`، إرسال واحد، `applied`/`failed` (4xx)/`unknown` (مهلة/شبكة/5xx))، `rejectIntent`، `reconcileIntent` (من `unknown` فقط إلى `applied|not_applied`)، `listIntents`, `outboxCounts`؛ كل انتقال `appendAudit` بمفتاح `cron.outbox.<id>` وقيمة = بصمة الحمولة |
| `workers/celia-edge/migrations/0003_cron_outbox.sql` (جديد) | جدول `edge_cron_outbox` + فهرس الحالة؛ عبارتان idempotent (المجموع صار 14) |
| `workers/celia-edge/worker.js` | `/api/cron/status` يعلن `configured`, `durable`, `reads`, `writes: outbox-approval-only`, `outbox` (عدّادات)، `decision: DEC-042`؛ `handleCronIntents` لمسارات `/api/cron/intents[…]`؛ `GET /api/cron/jobs…` قراءة مُنقّاة؛ `POST/PATCH/DELETE /api/cron/jobs…` → نيّة (202) بعد نفس التحقق (422/413 قبل التخزين)؛ 503 `d1_not_bound` و`cronjob_not_configured` صريحة |
| `public/cron.html`, `cron.css`, `cron.js` (جديد) | لوحة RTL للمالك: عنوان الحافة + الرمز (`sessionStorage` للتبويب فقط)، حالة الخدمة الصادقة، جدول المهام والسجل، نموذج نيّة إنشاء، صندوق الصادر مع الحمولة وبصمتها وأزرار موافقة/رفض/تسوية (كلها بـ`confirm`)؛ لا `innerHTML`، لا نداء لـ`api.cron-job.org` من المتصفح |
| `src/config.js`, `src/celia-mcp.js`, `src/celia-ui.js`, `scripts/build-pages.mjs`, `.github/workflows/pages.yml` | `resolveEdgeOrigin` (`CELIA_EDGE_ORIGIN`، https فقط، الافتراضي العامل الحي) في `connect-src`؛ مسارات `/cron`, `/cron.css`, `/cron.js`؛ إعادة كتابة `./cron` → `cron.html` في البناء الثابت؛ `/cron.html` ضمن تحقق Pages الحي (13 مسارًا) |
| `test/edge-cron-outbox.test.js` (جديد، 8) | هجرات حقيقية على SQLite (`node:sqlite`) + منبع وهمي يعدّ النداءات: حالة صادقة (مفتاح/D1)، تنقية بلا تسرّب `SECRET-*`، 202 بلا منبع + replay/409، SSRF/حقول/413/401/503 أمام الصندوق، سباق موافقتين = إرسال واحد + سلسلة تدقيق سليمة `created→approved→applied`، `PATCH/DELETE` ورفض نهائي، `failed/unknown/reconcile` بلا إعادة تلقائية، كشف العبث بالصف |
| `test/cron-page.test.js` (جديد، 4) | أصول محلية فقط، نداءات `/api/cron/*` فقط، نصوص الحالات الصادقة، خدمة Express مع CSP تضم أصل الحافة |
| `test/deploy-cloudflare-edge.test.js` | 12 → 14 عبارة هجرة مع تثبيت وجود `edge_cron_outbox` مرتين (جدول + فهرس) |

## 4. الدليل

- محليًا: `GITHUB_ACTIONS=true npm run test:coverage:ci` → **549/549**، تغطية 91.17 / 73.39 / 85.42 (الأرضية 89/71/82)؛ `node scripts/check.mjs`
  144 ملفًا؛ `npm run check:secrets` ✅؛ `check:continuity` — انظر الخلاصة في STATE.
- CI الدفع على الفرع: يُسجَّل هنا بعد الدفع (معرّفات التشغيلات).
- **غير متحقق حيًّا** بعد: الهجرة `0003` تُطبَّق في أول `cloudflare-deploy.yml` من `main` بعد الدمج؛ الدليل الحي المطلوب: `GET /api/cron/status`
  → `durable: true, writes: outbox-approval-only, outbox.pending_approval: 0`، ثم نيّة تعطيل/تفعيل مهمة keep-alive من `/cron.html` وموافقتها
  ومراجعة `edge_audit` (`/api/audit`).

## 5. قرارات صغيرة أثناء التنفيذ

- 5xx من المنبع = `unknown` لا `failed`: الطلب وصل وقد يكون الأثر وقع. 4xx = `failed` (المزوّد رفضه صراحة).
- نيّة بلا مفتاح cron-job.org تُرفض 503 بدل تخزينها «لحين الضبط» — نيّة لا يمكن إرسالها أبدًا هي واجهة زائفة.
- الموافقة على نيّة `rejected` → 409 `intent_rejected`؛ على `applied/failed/not_applied` → 200 `replayed` بلا إرسال؛ على
  `dispatching` → 409 `dispatch_in_progress`؛ على `unknown` → 409 `reconciliation_required`.
- اللوحة لا تحتوي وضع «نسخة ثابتة» معطّل مثل `kb.js`: Pages ثابت لكنه يتحدث مع أصل الحافة مباشرة (CORS مضبوط أصلًا على
  `github.io` و`Idempotency-Key` ضمن `access-control-allow-headers`).

## 6. ما ينتظر المالك

- «افتح PR» لهذا الفرع، ثم «ادمج»؛ قرار #38 («أغلق #38» أو تركه).
- بعد الدمج: الدليل الحي أعلاه (§4) ثم تحديث OPS-007 إلى «متحقق» بمعرّف التشغيلة.
