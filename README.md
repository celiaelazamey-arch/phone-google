# مساعد الهاتف + Google

سيليا: مساعد عربي يربط Google وWhatsApp، مع أدوات MCP وواجهة استوديو، وتخزين MySQL مشفّر للرموز وموافقات صريحة للعملاء.

## روابط النشر (ما هو حي فعلًا، وبأي دليل)

| الوجهة | الرابط | الدليل (GitHub API، `main@44532f4`، 2026-10-28) |
|---|---|---|
| الواجهة الثابتة — GitHub Pages | <https://celiaelazamey-arch.github.io/phone-google/> | التشغيلة `40706047514` بحالة `success` على `main@44532f4`؛ وتوسعت بوابة `pages.yml` للتحقق الحي من **12/12 مسارًا** (`/`, `/protocol.html`, `/agent.html`, `/kb.html`, `/system.html`, `/deploy.html`, `/live.html`, `/skills.html`, `/computer.html`, `/computer-permissions.html`, `/api/protocol-benchmark.json`, `/api/live.json`) |
| **الخادم الكامل بلا فيزا (MCP 12 أداة + Google OAuth2 + واتساب + Gemini) — Cloudflare Worker + Cloudflare D1** | <https://celia-phone-google.celiaelazamey.workers.dev> | التشغيلة **`40719074394`** على `main@0ebf8cac86faaea67e6f969c273549b2f8b33220` (دمج PR `#70`): `status: deployed`، `liveReady: true`، `18/18` سرًا، **12 عبارة SQL** مطبقة على D1 `celia-edge-state`، `storage: { mode: "d1", durable: true, latencyMs: 50 }`، وبوابة القبول `verify:live --mode edge` ناجحة داخل التشغيلة؛ ومسابر ما بعد النشر: `/health` → `fullEdgeRuntimeMounted: true` و`mcpToolsCount: 12`، و`/readyz` → `durable: true` (`latencyMs: 423`)، و`/version` → `0ebf8cac…`، و`/mcp` بلا رمز → `401` · الأساس السابق: التشغيلة `40706047781` على `main@44532f4` |
| الإصدار الموقّع | <https://github.com/celiaelazamey-arch/phone-google/releases/tag/v0.2.1> | موثق OIDC (site/source tar + SBOM + SHA256SUMS + release.json) مع نشر idempotent في `40674752228` |
| صورة الحاوية (الخادم الكامل) | `ghcr.io/celiaelazamey-arch/phone-google:v0.2.1` — [صفحة الحزمة](https://github.com/celiaelazamey-arch/phone-google/pkgs/container/phone-google) | الحزمة **عامة**، `linux/amd64`، digest في `release.json` |

**منشور ومتحقَّق حيًّا بلا فيزا (`DEC-038`):** محرك سيليا الكامل على الحافة — أدوات MCP الـ12، وGoogle OAuth2 (Gmail / Drive / Calendar / Contacts)، وwebhook واتساب الرسمي مع أوامر المالك العربية، وردود Gemini — يعمل الآن على رابط Cloudflare Workers العام مع قاعدة **Cloudflare D1 الدائمة**، بـ`0$` شهريًا وبدون أي بطاقة، وموثّق ببوابة `verify:live --mode edge` داخل التشغيلة `40719074394`.

**غير منشور بعد (لا رابط له ولا يُدَّعى):** خادم **Express + MySQL** الكامل (حلقة الوكيل، `HOST-003`) — حُجب إنشاء خدمة Render بطلب تفويض بطاقة بقيمة `1$` (`DEC-034`)؛ لذا نُقل دوام الحافة فعليًا إلى **Cloudflare D1 المجاني بلا بطاقة (`durable: true`)**، بينما يبقى تشغيل الحاوية الكاملة رهن اختيار مضيف بلا بطاقة أو قرار المالك ([الخطة التنفيذية لإكمال البنود وسد الفجوات](docs/executive-completion-plan.md)). كذلك لم يُتحقق حيًّا بعد ربط حساب Google ولا تطبيق Meta، لأنهما إجراءان في لوحات المالك (إضافة رابط الاستدعاء وأسرار `WHATSAPP_*` — خطوتان بلا أي بطاقة) كما في [دليل النشر بدون فيزا](docs/no-visa-deployment.md#7-ما-يتبقى-حصريًا-لك-دقيقتان-بلا-أي-بطاقة).

**واقع الخدمات (لا أسماء ولا «مواكب»):** [docs/service-reality.md](docs/service-reality.md) — تدقيق حقيقي بالأسرار الفعلية من
داخل GitHub Actions (run `40680228320` + دوام الحافة `40706047781`، 2026-10-28): MySQL حقيقي 11/11، **12/12 خدمة مهيأة متحققة فعلًا بنسبة 100% (`workingRate: 1`, `failed: []`)**
(Gemini، cron-job.org، Cloudflare API، Figma، ElevenLabs TTS، Google OAuth client، رمز المالك، Worker + D1، Pages، GHCR، الإصدار، رقم الهاتف)،
و**4 خدمات متقاعدة صراحةً في Git** لأن اعتماداتها ميتة أو تتطلب بطاقة (AI Gateway، DeepSeek، AgentRouter، R2 —
`docs/deployment-profile.json → serviceRetirements`، قابلة للتراجع). إعادة التدقيق: commit يحمل `[reality]` أو `npm run reality`.

**خطة المحافظة والخطة التنفيذية والنشر بدون فيزا:** [docs/no-visa-deployment.md](docs/no-visa-deployment.md) (`DEC-037` — **النشر الكامل مجانًا 100% بدون فيزا على Cloudflare Workers + D1 + GitHub Pages**: أدوات MCP الـ12 + Google OAuth2 + WhatsApp Webhook + Gemini)، و[docs/preservation-plan.md](docs/preservation-plan.md) (`DEC-031`)، و[docs/executive-completion-plan.md](docs/executive-completion-plan.md) (`DEC-036`) — جرد بالدليل، تدقيق
أسبوعي آلي مع issue تتبّع واحدة تصل إلى المالك وتُغلق وحدها، أرضية تغطية مفروضة في CI (`89/71/82`)، تدوير مفاتيح تشفير `AES-256-GCM` (`v2.<keyId>`)، تحصين SSRF وترويسات الحافة، وفصل صريح لبنود لوحة المالك المتبقية.

## خطة 2026 والاستمرارية بين الجلسات

[خطة التطوير الشاملة](docs/2026-development-plan.md) · [خطة «منافس مانوس» (مقترح بانتظار اعتماد المالك)](docs/manus-competitor-plan.md) · [الحالة الحالية والخطوة التالية](docs/continuity/STATE.md) · [قائمة المهام](docs/continuity/BACKLOG.md) · [سجل القرارات](docs/continuity/DECISIONS.md) · [عقد التوافق](docs/compatibility-contract.md) · [نحو وكيل متكامل (خطة M1–M4)](docs/agent-runtime-plan.md) · [ربط حساب Google خطوة بخطوة](docs/google-connect.md) · [شبكة المعرفة](docs/knowledge-network.md).

قبل أي جلسة تطوير، اقرأ [AGENTS.md](AGENTS.md) و[بروتوكول الاستمرارية](docs/continuity/README.md). الخطة تفصل بين حفظ سياق التطوير في Git وذاكرة محادثات التطبيق الدائمة **المخططة وغير المنفذة بعد**، وتفرض جرد البيئة والتوافق والنسخ والاستعادة قبل التغيير. بدأ تنفيذ إضافات 0.2.1 الاختيارية؛ لا تعني اعتماد الخطة أو نجاح الاختبارات نشر حسابات الإنتاج أو إكمال كل المهام. التقارير القديمة محفوظة كلقطات تاريخية، لا كمرجع حالة حي.

## الجديد في هذه الجلسة — شبكة المعرفة (KB-001…KB-004، اختيارية، معطلة افتراضيًا)

سجلات CSV موثثة (7 ملفات، 81 صفًا) ← تحقق (ترخيص/ثقة/خطر/أسرار/بصمة مانيفست و`claim_type`/`review_due`) ← SQLite + FTS5
بـ`UNIQUE(content_hash)` وحواف مسماة لكل منها دليل ← بحث عربي مع حزمة أدلة (`uri` و`licence` و`trust`) ←
أدوات وكيل قراءة فقط `kb.search`/`kb.tool_profile`/`kb.project_context` وصفحة مالك `/kb`.
لمسار Planner المحلي: `doc` + `operational_guidance` + T1/T2 + مراجعة سارية فقط؛ السجلات التاريخية أو غير المتحققة أو المهجورة أو المنتهية لا تتحول إلى تعليمات تلقائيًا.

- التفعيل صريح: `CELIA_KB=sqlite` (+ `CELIA_KB_PATH`)؛ الافتراضي `off`، ولا ارتداد صامت إلى الذاكرة.
- الاستيراد بأمر صريح لا عند الإقلاع: `npm run kb -- verify` ثم `npm run kb -- import --apply --full`.
- **حدود معلنة:** لا بحث دلالي/embeddings، مزامنة Drive الحية الشاملة غير منفذة (توجد خلاصات انتقائية موثقة)، التخطيط الافتراضي حتمي، وشريحة Provider المحلية مزود وهمي فقط، والفهرس ملف محلي لا يُدَّعى دوامه
  على مضيف بلا قرص (`status.durability.persistent=false`). النسخة البعيدة المشفرة غير منفذة.

التفاصيل والحدود: [docs/knowledge-network.md](docs/knowledge-network.md).

## الجديد في هذه الجلسة — حلقة الوكيل M1 وحوكمتها (اختيارية، معطلة افتراضيًا)

`/agent` مساحة مالك لحلقة **Plan → Act → Observe → Verify → Deliver** بحالة دائمة: خيوط ورسائل وتشغيلات وخطوات
واستدعاءات أدوات في قاعدة البيانات، قفل lease، **استئناف من آخر خطوة مؤكدة** بعد إعادة التشغيل، **منع تكرار**
الطلب عبر `client_message_id`، إلغاء، ميزانيات خطوة/تكلفة/زمن، وطبقة حوكمة (DEC-014):

- **عقد هدف لكل تشغيل:** هدف ومعايير نجاح وقيود وشروط توقف وميزانية وموعد نهائي كبيانات قابلة للفحص الآلي.
- **بوابة موافقات كاملة:** الأثر الخارجي يوقف التشغيل بصف `agent_approvals`؛ `POST /api/agent/runs/:id/approval`
  يسجل قرار المالك (`approved`/`rejected`) بمفتاح idempotency ويستأنف التشغيل، ويرفض 409 استئناف أي استدعاء
  حالته `unknown` (المصالحة أولًا)، والرفض يلغي بلا أثر.
- **سجل أدلة مسلسل:** جدول `agent_evidence` إضافي فقط بسلسلة بصمات SHA-256 (`prev_hash`) تكشف أي عبث أو حذف.
- **مُتحقِّق مستقل:** مكوّن منفصل عن المنتِج بأحكام `PASS`/`BLOCK`/`UNKNOWN`؛ لا تسليم بلا خطوة تحقق، وإعادة
  تنفيذ القراءات الحتمية المعلّمة صراحةً، وقول `UNKNOWN` للآثار غير القابلة للقراءة بدل التخمين.
- **ذاكرة طويلة الأمد (WP-2.3):** ملخص خيط وحقائق مالك موسومة تُشتق حتميًا من الخطوات عند انتهاء التشغيل، بلا نموذج
  أو متجهات؛ عرضها وحذفها النهائي من `/agent` و`GET/DELETE /api/agent/memory`، مع دليل `memory_deleted` وفحص الأسرار.
- **تقييم المهمة الذهبية (WP-2.4):** `npm run eval:ai` يشغّل 120 حالة عربية ثابتة عبر الحلقة والموافقات وoutbox الفعليين
  بمزوّد وهمي بلا شبكة، ويكتب `reports/ai-001.json` بقرار وحمولة ومرجع وسلسلة أدلة لكل حالة. النتيجة المحلية PASS؛
  لا تقيس جودة نموذج حي أو تكلفة إنتاج أو اتصال Google.
- **مصالحة بشرية (DEC-016):** `POST /api/agent/runs/:id/reconcile` هو المخرج الوحيد من `needs_reconciliation`:
  قرار `applied`/`not_applied` لاستدعاء أو نية، يُقيَّد في سلسلة الأدلة، ويستأنف التشغيل فقط إذا لم يبقَ شيء غير
  محسوم. لا يستدعي أي موصل، ولا يعيد إرسال شيء، ولا يكتب فوق نتيجة محسومة؛ وإعادة محاولة نية `failed` تحتاج
  تأكيدًا صريحًا، والمفتاح مربوط ببصمة الحمولة فلا تركب حمولة مختلفة على موافقة سابقة.

- التفعيل صريح: `CELIA_AGENT_RUNTIME=mysql` (إنتاج) أو `sqlite` محلي/تجريبي — **لا وضع ذاكرة**. المسارات
  `/api/agent/*` خلف مصادقة المالك؛ الافتراضي `off` ويعيد `503` صريحًا.
- MySQL: الجداول تُنشأ بسجل ترحيل مستقل فقط: `npm run migrate` (dry-run) ثم `npm run migrate -- --apply`
  (`0003_agent-governance.sql` يضيف جداول الحوكمة الثلاثة، و`0004_agent-outbox.sql` يضيف `agent_outbox`،
  و`0005_agent-memory.sql` يضيف جدولَي الذاكرة؛ 11 جدول `agent_*`). الجداول الخمسة الأساسية و`schema 1` بلا تغيير.
- **الأثر الخارجي:** يخرج فقط عبر `agent_outbox` (نية واحدة بمفتاح idempotency، إرسال واحد، ولا إعادة إرسال بعد
  `unknown`). يحتاج تفعيلًا صريحًا: `CELIA_AGENT_CONNECTORS=calendar` مع حساب Google موصول؛ الافتراضي بلا موصلات
  فيُرفض الأثر بـ`external_connector_unavailable`.
- **حدود معلنة:** المخطط الافتراضي حتمي تجريبي؛ شريحة Provider المحلية قابلة للحقن ومختبرة بمزود وهمي فقط ولا تفعّل نموذجًا حيًا؛ موصل WhatsApp/Drive غير مبني (باقي AGENT-002)؛ لا تنفيذ
  معزول/artifacts (AGENT-003)؛ لا استئناف تلقائي عند الإقلاع؛ MySQL الحي يُختبر في CI لا محليًا. المصالحة قرار
  مالك مسجل، لا استئناف آلي ولا تخمين لنتيجة غير قابلة للقراءة.
  **لا يُوصف النظام بأنه «مثل Manus» بعد.**

التفاصيل والفحوص: [docs/agent-runtime.md](docs/agent-runtime.md) · خطة نشر WP-2.3 وحدودها (توثيق مستقبلي بلا ترحيل أو نشر منفّذ): [docs/agent-memory-deployment.md](docs/agent-memory-deployment.md) · حدود وتشغيل تقييم WP-2.4: [docs/agent-ai-evaluation.md](docs/agent-ai-evaluation.md).

## الجديد في 0.2.1 — Free Launch Runtime

**[دليل النشر المجاني الفعلي](docs/free-hosting.md)** · **[خطة التشغيل الحر بلا بطاقة](deploy/free-always-on/README.md)** (خدمة واحدة + نداء دوري، وحدود صريحة: لا SLA ولا «24/7 مضمون») · **[خطة التشغيل المكتمل الأركان](docs/go-live-plan.md)** (الأركان والبوابات والأدلة؛ `npm run verify:live` للقبول الحي) · افتح `/deploy` لمركز التشغيل والفحص.

- Google OAuth/REST وWhatsApp Webhook/REST وMCP والواجهة على خدمة واحدة عند `CELIA_ENABLE_INTEGRATIONS=true`؛ الافتراضي القديم باقٍ.
- MySQL دائمة مع TLS/CA موثقة، وتهيئة صريحة لقاعدة جديدة فارغة فقط؛ schema1 الحالية لم تتغير ولا migration تلقائي لقاعدة قائمة.
- مركز نشر عربي يعرض الجاهزية والعوائق بصدق، وروابط إنشاء **Render Free + Aiven Free MySQL** ونطاق فرعي HTTPS مجاني. لا جمع أسرار في الصفحة أو الدردشة.
- Blueprint كامل في `render.yaml` بخطة free وتحديث تلقائي معطل؛ التجربة المؤقتة القديمة في `render.demo.yaml`.
- اختبار MySQL8.4 فعلي في CI، وقراءة الإصدار السابق لنفس قاعدة البيانات، ونسخة مصطنعة تُستعاد إلى قاعدة مستقلة. بوابة handoff وروابط/مهام في CI.

**النشر الدائم لم يُنشأ بعد:** يلزم تسجيل دخول المالك وتفويض حسابات الاستضافة وإعداد أسرار المزوّدين لديهم. لا تساوي المعاينة أو Pages أو CI نشرًا كاملًا؛ وإذا طُلبت بطاقة تحقق نتوقف وفق شرط المستخدم. النسخ والاستعادة الفعلية لبيانات حسابك واتصال Google/Meta غير متحققة بعد. لا يوجد حفظ دائم عام لمحادثات الاستوديو في هذه الحزمة.

## الجديد في 0.2.0 — Resilient Core

- **إصدارات لها طريق عودة:** SemVer موحد، حزم مصدر/موقع + SBOM + SHA256، نشر GitHub بإثبات OIDC وصور Docker ثابتة بالـdigest.
- **تبديل ورجوع مُداران:** فحص مرشّح ثم فحص النسخة الفعالة، محاولة استعادة تلقائية عند فشل التبديل، وقفل وسجل تعافٍ ذري. لا حذف بيانات أو ترحيل هدّام تلقائيًا.
- **عزل أعطال التكاملات:** قاطع ومهلة وحد تزامن لكل خدمة، وبديل قواعد محلي عند فشل AI في `auto`؛ تعطل MySQL لا يتحول بصمت إلى قاعدة فارغة.
- **مركز النظام والإصدارات:** `/system` (أو `system.html` في Pages) يعرض حالات فعلية وحدود التشغيل، ولا يدّعي اتصال الخدمات غير المُهيّأة.
- **بوابات الجودة:** اختبارات وحدات/انقطاع/استعادة + هاتف وحاسوب وإتاحة آلية، CI على Node 22/24، وsmoke test للحاوية.

**ابدأ هنا:** [دليل الإصدارات والرجوع](docs/releases-and-recovery.md) · [العزل والمراقبة](docs/resilience.md) · [سجل التغييرات](CHANGELOG.md) · [الأمان](SECURITY.md).

> لا يوجد نظام مضمون بلا أعطال. العزل الحالي منطقي داخل عملية Node؛ انهيار العملية/الجهاز ونسخ البيانات الاحتياطية يحتاجان بنية تشغيل مستقلة. أول نشر مُدار لا يختلق نسخة سابقة؛ `0.1.0` خط أساس مصدر، لا صورة مُدارة جاهزة للرجوع.

**معاينة محلية حقيقية (ذاكرة مؤقتة، بلا ربط حسابات أو حفظ إنتاجي):**

```bash
CELIA_MCP_DISABLE_MYSQL=true CELIA_MCP_API_TOKEN=$(openssl rand -hex 32) \
CELIA_MCP_HOST=0.0.0.0 CELIA_MCP_PORT=3010 node src/celia-mcp.js
# ثم افتح http://localhost:3010
```

هذا الأمر يشغّل الواجهة العربية + خادم MCP (١٢ أداة) + مختبر التشفير على ذاكرة مؤقتة، وهو نفس ما يعمل في المعاينة الحيّة.

**صفحة الهبوط الفاخرة (تسويقية، مركّزة على التحويل):** افتح `http://localhost:3010/landing` محليًا — وعلى GitHub Pages تصبح على `https://celiaelazamey-arch.github.io/phone-google/landing.html`. ملفاتها `public/landing.html` + `landing.css` + `landing.js`، مع خطوط عربية محلية (`fonts.css` + `public/fonts/`) وبطاقة مشاركة `og-celia.png`؛ لا تعتمد على أي أصل خارجي. تُبنى تلقائيًا ضمن `dist/`، وخطتها المنفَّذة في [`docs/خطة-نشر-صفحة-الهبوط.md`](docs/خطة-نشر-صفحة-الهبوط.md).

لجعل الصفحة التسويقية هي الواجهة الافتراضية مع إبقاء مساحة الوكيل على `/studio`:

```bash
CELIA_LANDING_ROOT=true CELIA_MCP_DISABLE_MYSQL=true CELIA_MCP_API_TOKEN=$(openssl rand -hex 32) \
CELIA_MCP_HOST=0.0.0.0 CELIA_MCP_PORT=3010 node src/celia-mcp.js
# / = صفحة الهبوط · /studio = مساحة الوكيل
```

**نشر دائم مجاني:** نسخة ثابتة جاهزة لـ GitHub Pages (`npm run build:pages` + سير عمل جاهز؛ التفعيل الأول يحتاج نقرة واحدة من المالك: Settings → Pages → Source: GitHub Actions)، وبديل خادم كامل عبر `render.yaml` + `Dockerfile.mcp` على طبقة Render المجانية. التفاصيل وسبب الحاجة للنقرة في [`docs/خطة-النشر-المجاني.md`](docs/خطة-النشر-المجاني.md).

> الخادم الكامل (`src/server.js`) يحتاج Node.js + MySQL وأسرار Google/WhatsApp/Gemini. النسخة الثابتة على Pages لا تحتوي أي سر ولا تتصل بأي خدمة خارجية.

## ما يتضمنه المشروع

- ربط Google OAuth بتدفق state عشوائي أحادي الاستخدام، cookie آمنة، ومدة صلاحية قصيرة.
- حفظ رموز Google مشفّرة باستخدام AES-256-GCM، لا كنص مكشوف.
- بحث للقراءة فقط في Gmail وDrive وجهات الاتصال، وقراءة مواعيد Calendar مع إنشاء حدث مفرد عبر API موثّق.
- Webhook لواتساب يتحقق من HMAC-SHA256، ويسجل الرسائل الواردة مع منع التكرار.
- أوامر المالك فقط من واتساب بعد ربط Google: «اربط جوجل» (رابط أحادي الاستخدام)، «لخص آخر إيميل» (أحدث رسالة في الوارد مقروءة أو لا — بيانات ومقتطف بلا نموذج لغوي)، «الإيميلات الجديدة»، «هات جدولي / بكرة / الأسبوع» بتوقيت `CELIA_TIMEZONE` (افتراضي `Africa/Cairo`). التفاصيل في [دليل الربط §6ب](docs/google-connect.md).
- الرد الذكي عبر Gemini معطّل افتراضيًا. لا تُرسل الرسالة الواردة إلى Gemini إلا عند وجود موافقة منفصلة مسجلة على معالجة الذكاء الاصطناعي، إضافة إلى موافقة WhatsApp ونافذة خدمة العملاء البالغة 24 ساعة. لا توجد نقطة إرسال جماعي.
- واجهة إرسال فردي تفرض الموافقة المسجلة ونافذة الخدمة. الرسائل خارج النافذة تحتاج قالب WhatsApp معتمد؛ إرسال القوالب غير مفعّل في هذا الإصدار.

## Celia Google Spider v0.1.0 — موصل Drive إلى شبكة معرفة محلية

حزمة Python مستقلة في [`celia-google-spider/README.md`](celia-google-spider/README.md) تبني فهرسًا محليًا من ملفات Google Drive (قراءة فقط، نطاق `drive.readonly`) وتقدّمه كست أدوات MCP عبر stdio: `spider_sync_google_drive` و`spider_search_knowledge` و`spider_read_document` و`spider_explore_network` و`spider_list_sources` و`spider_graph_stats` — بحث معجمي عربي/إنجليزي مع مقتطفات، وشبكة مستند↔مصطلح↔مستند، بلا حذف تلقائي للعناصر المحلية الغائبة، ولا embeddings، ولا أي منفذ شبكة. الإصدار 0.1.0 بتاريخ 2026-10-27؛ الاختبارات محلية: `python -m unittest discover -s tests -v` و`pytest -q` (10/10). راجع [README الحزمة](celia-google-spider/README.md) لخطوات الإعداد على Windows وحدودها؛ ملفا `credentials.json` و`token.json` ممنوعان من Git. ليست موصلة داخل ChatGPT (يتطلب ذلك موصلاً بعيداً/خدمة مدفوعة). القرار: [DEC-011](docs/continuity/DECISIONS.md).

## المتطلبات

Node.js 22+ (24 LTS موصى به)، MySQL 8+، وبيانات اعتماد OAuth من Google وبيانات WhatsApp Cloud API من Meta. مفتاح Gemini مطلوب فقط للردود الذكية الآلية.

## التشغيل المحلي

```bash
cp .env.example .env
# عدّل MYSQL_PASSWORD وMYSQL_ROOT_PASSWORD وأنشئ APP_API_TOKEN عشوائيًا بطول 32 حرفًا على الأقل.
# أنشئ TOKEN_ENCRYPTION_KEY بواسطة: openssl rand -base64 32
docker compose up -d mysql
npm install
npm run db:init
npm test
npm start
```

تحقق محليًا من الخادم عبر `GET http://localhost:3000/health`. انسخ `.env.example` إلى `.env` ولا ترفع ملف `.env` أو أي token إلى GitHub.

## إعداد Google

1. أنشئ مشروعًا في Google Cloud، وفعّل Gmail API وGoogle Drive API وGoogle Calendar API وPeople API.
2. أنشئ OAuth Client من نوع Web Application، واضبط redirect URI المطابق تمامًا لقيمة `GOOGLE_REDIRECT_URI`.
3. في التطوير المحلي يمكن أن يكون callback هو `http://localhost:3000/auth/google/callback`. على الإنترنت استخدم HTTPS ونطاقك الفعلي. لا تستخدم `yourdomain.com` كنطاق حرفي.
4. أدخل `GOOGLE_CLIENT_ID` و`GOOGLE_CLIENT_SECRET` و`GOOGLE_REDIRECT_URI` في مخزن الأسرار الخاص ببيئة التشغيل. قد تتطلب شاشة موافقة OAuth حسابات اختبار أثناء التطوير أو التحقق من Google قبل الاستخدام العام.
5. افتح `GET /auth/google` من خلال واجهة/وكيل يضيف رمز Bearer للمالك؛ بعد الموافقة يعيد Google المتصفح إلى callback.

عند ضبط `APP_OWNER_EMAIL`، يتحقق callback من هوية Google الموثقة ويرفض أي حساب آخر. نطاقات الهوية `openid email` تستخدم لهذا التحقق.

النطاقات المستخدمة: Gmail read-only، Drive read-only، Contacts read-only، وCalendar events (للقراءة وإنشاء موعد). لا يقرأ التطبيق مرفقات البريد ولا يرسل بريدًا إلكترونيًا.

## إعداد WhatsApp Cloud API

- أنشئ تطبيق Meta وWhatsApp Business Phone Number، واضبط `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` وإصدار Graph API مدعومًا في `WHATSAPP_API_VERSION`.
- سجّل عنوان HTTPS `https://<your-domain>/webhooks/whatsapp` في إعدادات Webhooks لدى Meta واشترك في `messages`.
- أدخل `GEMINI_API_KEY` في `.env` المحلي أو مخزن أسرار الاستضافة؛ لا ترسله في المحادثة ولا تضعه في ملفات GitHub. اختر `GEMINI_MODEL` متاحًا لحسابك، ويمكن وضع حقائق النشاط المسموح استخدامها في `GEMINI_BUSINESS_CONTEXT`.
- لا تضبط `WHATSAPP_AUTO_REPLY_ENABLED=true` إلا بعد إعداد مفاتيح Gemini وMeta وإبلاغ العملاء صراحةً بأن رسائلهم ستُعالج بواسطة Gemini، وتسجيل موافقتهم المنفصلة. يطلب النظام `aiOptedIn: true` بالإضافة إلى `optedIn: true`، ولا يعتبر مجرد وصول رسالة موافقة.
- للمراسلات خارج نافذة 24 ساعة، يلزم قالب معتمد وموافقة مناسبة؛ هذه النسخة ترفضها بدل تجاوز السياسة.

## المصادقة وواجهات API

مسارات إدارة Google/WhatsApp تتطلب `Authorization: Bearer $APP_API_TOKEN`. مسارات المراقبة المنقّحة `/api/system` و`/api/releases` و`/api/deployment` عامة؛ `/api/system/diagnostics` يتطلب رمز المالك (رمز MCP على خادم MCP).

- `GET /api/google/gmail/search?q=<Gmail query>`
- `GET /api/google/drive/search?q=<name>`
- `GET /api/google/calendar/events?days=7`
- `POST /api/google/calendar/events` مع JSON مثل `{"summary":"موعد","start":"2026-10-27T14:00:00Z","end":"2026-10-27T14:30:00Z"}`
- `GET /api/google/contacts/search?q=<query>`
- `POST /api/whatsapp/contacts/<phone-without-plus>/consent` مع JSON `{"optedIn":true,"aiOptedIn":true,"source":"نموذج موافقة موثق"}` لتسجيل الموافقتين فقط إذا كانتا قد أُخذتا فعلًا؛ `aiOptedIn` اختياري ويمكن أن يبقى `false`.
- `POST /api/whatsapp/messages` مع JSON `{"phone":"+14155552671","text":"مرحبًا"}` لإرسال فردي مسموح به.

حاليًا رمز API واحد لمالك واحد (single-owner deployment). توجد لوحة مراقبة واستوديو تجريبي، لكن لا توجد إدارة مستخدمين/صلاحيات متعددة، WhatsApp broadcast، جدولة تذكيرات، معالجة طلبات بيع أو ربط فعلي بـMySQL موجود لدى المستخدم.

## خادم Celia MCP (`npm run celia:mcp`)

يوفر المشروع خادم **Model Context Protocol (JSON-RPC 2.0)** محميًا برمز `CELIA_MCP_API_TOKEN` على المسار `POST /mcp` (مع وضع `stdio` اختياري عبر `npm run celia:mcp:stdio` ولوحة فحص تفاعلية عربية على `/`). يدعم الخادم تلقائيًا:
- **Gemini (`GEMINI_API_KEY`)** كمزود أساسي فور توفّر المفتاح (بما في ذلك داخل **GitHub Actions Secrets** عبر `.github/workflows/celia-mcp.yml` دون الحاجة إلى تنزيل نماذج محلية).
- **Ollama المحلي (`qwen2.5:7b`)** كبديل محلي عند تشغيله على جهازك الشخصي.

```bash
cp .env.example .env
# أنشئ CELIA_MCP_API_TOKEN باستخدام openssl rand -hex 32، وضعه في .env
# اختياري على جهازك المحلي فقط إن لم تستخدم GEMINI_API_KEY:
ollama pull qwen2.5:7b
npm install
npm run celia:mcp
```

## حدود النشر والإكمال

هذا المستودع لا يحتوي أسرارًا ولا يملك نطاق HTTPS، قاعدة بيانات إنتاجية، Google OAuth client، مفتاح Gemini فعليًا، حساب Meta/WhatsApp Business، رقمًا موثقًا، أو قائمة موافقات العملاء. لذلك لا يمكن تفعيل تسجيل الدخول أو استقبال/إرسال رسائل حقيقية أو الرد عبر Gemini أو نشر الخدمة قبل توفير هذه الموارد. لا تشارك أسرار OAuth أو Gemini أو WhatsApp في المحادثات أو ملفات Git؛ ضعها في مخزن أسرار بيئة الاستضافة.

## النشر المجاني على GitHub Pages (نسخة الواجهة + أدوات MCP داخل المتصفح)

```bash
npm run build:pages      # يولّد dist/ من public/ + طبقة المحاكاة
# o افتح dist/index.html عبر أي خادم ثابت أو ارفع dist/ كما هي
```

- سكربت البناء `scripts/build-pages.mjs` يستخرج `MCP_TOOLS` و`MCP_PROTOCOL_VERSION` من `src/celia-mcp.js` وهوية `SERVER_INFO` من `src/version.js` ويحقنها في `dist/celia-static-shim.js`، ويقرأ هوية الإصدار الموحدة من `releases/current.json`، ثم يحقن الوسم في كل صفحة ويضيف `.nojekyll` و`404.html`.
- روابط التشخيص في `live.html` تُحوَّل في النسخة الثابتة إلى لقطات JSON حقيقية (`health.json`, `api/live.json`, `mcp.json`) حتى لا تُفضي إلى `404` على Pages؛ والطبقة الثابتة تبقى مصدر القيم اللحظية داخل المتصفح.
- الطبقة الثابتة تخدم `GET /health` و`POST /ui/workspace/rpc` و`POST /mcp` و`POST /ui/workspace/crypto-lab` داخل المتصفح: `initialize`, `ping`, `tools/list`, `tools/call` (١٢ أداة), `resources/*`, `prompts/*`.
- بعد تفعيل Pages بصلاحية مناسبة، يحاول `.github/workflows/pages.yml` النشر عند الدفع إلى `main` (بيئة `github-pages`, `build_type: workflow`). محاولة التفعيل بصلاحية الجلسة الحالية أعادت 403، فلا يوجد رابط Pages عام متحقق هنا. النسخة الثابتة لا تحتاج أسرار خادم أو بطاقة.
- الاختبارات: `node --test test/static-shim.test.js` (تبني `dist/` وتتحقق من كل أداة ونقاط REST ومسار التشفير والموافقات).

### قيود النسخة الثابتة (معلنة في الواجهة)

- التخزين في ذاكرة التبويب فقط (`storage: memory`) ويُصفَّر عند التحديث؛ ليس نسخة احتياطية أو قاعدة إنتاجية.
- Google/WhatsApp تُرجع بيانات `demo: true`؛ لا OAuth حقيقي ولا إرسال رسائل، ولا استقبال Webhook (Pages لا تقبل POST خارجيًا).
- الردود يولّدها محرك السياسة العربي المدمج `celia-local-policy-engine` بلا مفتاح؛ وللردود السحابية الصق مفتاحك في تبويب «النماذج المجانية» (يبقى في `sessionStorage` بمتصفحك).
- للمسار المختار لخدمة كاملة: [Render Free + Aiven Free MySQL](docs/free-hosting.md)، ثم أسرار المزوّدين وموافقاتهم والتحقق الخارجي. لا نفترض شروط مزوّد بديل أو مجانية غير محدودة.

## أوامر الجودة والتشغيل الحديثة

```bash
npm ci
npm run check && npm run release:check && npm run check:continuity && npm test
npm run test:resilience
npm audit --omit=dev
# اختبارات المتصفح (تحتاج تنزيل Chromium أول مرة):
npx playwright install --with-deps chromium
npm run test:browser
# معاينة Pages محلية حقيقية، افتراضيًا المنفذ 3101:
npm run preview:pages
# أوامر المشغّل؛ اقرأ الدليل قبل الإنتاج:
npm run deploy:release -- status
npm run deploy:release -- rollback
```

`npm run release:bundle` يتطلب شجرة Git نظيفة وcommit محفوظًا، ويكتب إلى `.release-artifacts/` المتجاهل. نشر الإصدار من GitHub يدوي على `main`؛ دفع فرع أو فتح PR ليس نشرًا للإنتاج. راجع [الدليل](docs/releases-and-recovery.md) لإعداد الموافقات وصورة GHCR وملف البيئة والنسخ الاحتياطية والرجوع في Pages.
