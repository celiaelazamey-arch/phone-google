# الحالة الحالية — ابدأ من هنا

**آخر مراجعة:** 27 أكتوبر 2026 · **نوع الجلسة الحالية:** توظيف أسرار المستودع التسعة في النظام بالكامل + إصلاح بوابة التوافق الخلفي لـMCP (بلا كشف أسرار أو تطبيق منفصل)

## الطلب والمتطلبات الثابتة

المستخدم طلب **توظيف أسرار المستودع التسعة في النظام بالكامل** (`AGENETROUTERAPI_KEY`، `AI_GATEWAY_API_KEY`، `CELIA_MCP_API_TOKEN`، `CELIA_VOICE_ID`، `DEEPSEEK_API_KEY`، `ELEVENLABS_API_KEY`، `FIGMA_ACCESS_TOKEN`، `GEMINI_API_KEY`، `YOUR_CODATA_API_KEY`) مع استمرار متطلبات الخطة 2026 والاستمرارية وعدم التعارض والإصدارات/الرجوع وعزل الأعطال ومسار النشر المجاني دون بطاقة دفع. كما طُلب سابقًا حفظ `RULE.MD` كما هو في الجذر متى زوّدنا المالك بمحتواه الفعلي دون اختلاق محتوى غير موجود.

هذا تفويض لربط الأسرار التسعة برمجيًا على الخادم وفي فحوص CI المنقحة وفي مخطط النشر المجاني، لا لكشف أي قيمة سرية في الدردشة أو المتصفح أو السجلات، ولا لنقل بيانات العملاء أو شراء موارد مدفوعة.

## الواقع والهوية

- المستودع: `celiaelazamey-arch/phone-google`؛ خط الأساس لهذه الجلسة `d5cdac830aa213cfe0f096d6519c786516593c57` (دمج PR #23 على `main`)، والسابق المرجعي `2508893bd7e6d447b2e19374933556322cc9cdb7` (إصدار 0.2.0). طلبات PR #17 و#21 و#22 و#23 مدموجة.
- الفرع المعطى لهذه الجلسة: `arena/266896e1-phone-google`. تحقّق دائمًا من الفرع النشط ولا تنشئ أو تنتقل لفرع آخر.
- الكود الحالي `0.2.1` / السابق `0.2.0` / `schema: 1` كما هي دون أي تعديل على مخطط قاعدة البيانات.
- الأسرار التسعة مؤكدة الأسماء في إعدادات GitHub Actions للمستودع؛ قيمها محمية ولا تُقرأ أو تُطبع أبدًا.
- لا رابط Render/Aiven دائم منشأ حتى هذه المراجعة (HOST-003 بانتظار تفويض حسابات المالك في لوحتي Aiven/Render فقط).

## المنفذ الآن

1. **ربط موحّد وآمن للأسرار التسعة (`src/ai-providers.js` + `src/secrets-hub.js`):**
   - مزودو الذكاء الاصطناعي المحكومون بالسياسة وحارس الحقن وقواطع الدوائر: `GEMINI_API_KEY` (`gemini`)، `AI_GATEWAY_API_KEY` (`ai_gateway`)، `DEEPSEEK_API_KEY` (`deepseek`)، و`AGENETROUTERAPI_KEY` مع الاسم البديل `AGENTROUTER_API_KEY` (`agentrouter`)، إلى جانب `ollama` والمحرك المحلي المحافظ (`local`).
   - في وضع `auto` يستدعي النظام مزودًا سحابيًا واحدًا على الأكثر افتراضيًا قبل التحول للمحلي (`CELIA_AI_ALLOW_CLOUD_FAILOVER=false`) منعًا لتوزيع رسائل العملاء عبر شركات متعددة دون إذن (AI-002).
   - مصادقة المالك الموحدة عبر `CELIA_MCP_API_TOKEN` لخادم MCP ولنقاط الإدارة في الخادم المستقل (`src/config.js`) عند عدم ضبط `APP_API_TOKEN`.
   - صوت سيليا العربي الحي عبر `ELEVENLABS_API_KEY` + `CELIA_VOICE_ID` (`POST /api/voice/speak` و`GET /api/voice/status`) محميًا بمفتاح التفرد `Idempotency-Key` وقاطع `elevenlabs`.
   - فحص ملفات التصميم للقراءة فقط عبر `FIGMA_ACCESS_TOKEN` (`GET /api/figma/me` و`GET /api/figma/files/:fileKey`) خلف قاطع `figma`.
   - موصل حالة مساحة Codata للقراءة فقط عبر `YOUR_CODATA_API_KEY` (`GET /api/codata/status` مع `primaryTransactionalStore: false` و`automaticMigrationAllowed: false`).
2. **عزل المتصفح والـSandbox العام (SEC-002 / SEC-003 / SEC-004):**
   - جميع المسارات الجديدة (`/api/secrets/status`، `/api/ai/reply`، `/api/voice/*`، `/api/figma/*`، `/api/codata/*`) تتطلب `Authorization: Bearer <CELIA_MCP_API_TOKEN>` حصريًا مع الإبقاء على المسارات التشخيصية العامة المنقحة (`/api/live`، `/api/skills`، `/api/system`، `/api/deployment`) عاملة بلا كسر.
   - `sandboxConfig` في `src/celia-ui.js` يصفر الأسرار التسعة جميعًا في `/ui/workspace/rpc` لئلا يستهلك الزوار رصيد المالك.
   - الاستوديو (`public/index.html` و`public/app.js`) يتيح اختيار مزودي الخادم وتجربة صوت سيليا وعرض لوحة جاهزية الأسرار التسعة المنقحة عند إدخال رمز المالك في جلسة التبويب المؤقتة فقط.
3. **إصلاح بوابة التوافق الخلفي N/N−1 لـMCP (COMP-002):**
   - إضافة `src/mcp-contract.js` (`assertBackwardCompatibleMcpTools`) وتحديث `integration/mysql.integration.mjs` للتحقق الدلالي الصارم من عدم كسر الـ12 أداة الافتراضية لعملاء 0.2.0 مع السماح بالحقول الاختيارية الإضافية مثل `idempotencyKey` وبإيرادات المزودين السبعة في `celia_ai_reply`، وجعل الأدوات الـ4 الجديدة اختيارية (`CELIA_EXTENDED_MCP_TOOLS=true`).
4. **بوابة CI ومخطط النشر المجاني:**
   - إضافة `scripts/check-secrets-wiring.mjs` (`npm run check:secrets`) وربط الأسرار التسعة في `.github/workflows/celia-mcp.yml` للتحقق الآلي من الجاهزية وعدم تسرب أي قيمة سرية في أي استجابة HTTP، وتحديث `.env.example` و`render.yaml` (`sync: false`) و`docs/deployment-profile.json`.

مرجع [المهام](BACKLOG.md)، [سجل القرارات](DECISIONS.md)، [دليل النشر](../free-hosting.md)، [جرد النشر المنقح](../deployment-profile.json)، [تقييم Codata](../codata-evaluation.md)، [سجل الجلسة السابقة](sessions/2026-10-27-celia-continuation.md)، و[سجل هذه الجلسة](sessions/2026-10-27-secrets-integration.md). لا تُسقط متطلبات خطة [2026](../2026-development-plan.md).

## التحقق الحالي

بيئة محلية Node 22.22.3 / npm 10.9.8:

- `npm run check`: ناجح — فحص syntax لـ **55 ملف JavaScript**.
- `npm run release:check`: ناجح — `0.2.1` / السابق `0.2.0` / `databaseSchema: 1`.
- `npm run check:secrets`: ناجح — تتبع 9/9 أسرار + التحقق من مصادقة 401/200 وصفر تسريب في جميع مسارات الحالة.
- `npm test`: **75/75 اختبار ناجح** دون أي فشل أو تجاوز، بما فيها اختبارات المزودين المحكومين، وحد المزود السحابي الواحد في `auto`، وElevenLabs مع `Idempotency-Key`، وFigma، وCodata، واختبار التوافق الخلفي الحي مع أرشيف `0.2.0` (`2508893bd7e6d447b2e19374933556322cc9cdb7`).
- `npm run celia:mcp:verify`: ناجح — مصافحة MCP وفحص الجاهزية المنقحة لـ9 أسرار.
- `npm run build:pages`: ناجح — توليد الصفحات الست الثابتة ومحاكي المتصفح (`dist/`).
- اختبار المتصفح المحلي (`playwright test`) لم يُشغّل محليًا لعدم تثبيت ثنائيات Chromium في حاوية الجلسة المعزولة الشبكـة؛ يُفحص آليًا في وظيفة `browser` ضمن GitHub Actions عند دفع الفرع، وكذلك وظيفة `mysql` الحقيقية على MySQL 8.4.

## حدود لا يجوز نسيانها

- أسرار GitHub Actions متاحة داخل مهام GitHub Actions فقط؛ عند نشر الخدمة الدائمة على Render Free يلزم إدخال المفاتيح المطلوبة في لوحة Render (`sync: false`) دون لصقها في الدردشة أو Git.
- `allCapabilitiesVerified=false` مقصود في `/api/deployment` حتى يتم النشر الخارجي الفعلي والتحقق الحي في حساب المالك (HOST-003).
- لم يُعثر على ملف `RULE.MD` في المستودع أو الفروع أو Google Drive المتصل؛ لن نختلق محتواه، ومتى زوّدنا المالك بنصه الحرفي يُحفظ فورًا في الجذر وتُوثّق أي فروق مع `AGENTS.md` في `DECISIONS.md`.
- تبقى مهام الحفظ الدائم للمحادثات والـoutbox (DATA-002 / DATA-003 / COMP-003) ومراجعة الميزانية والحصص (GOV-001) قائمة في `BACKLOG.md` دون ادعاء إغلاقها.

## الخطوة التالية بالضبط

1. **مراقبة فحوص PR على GitHub Actions** (`verify` شاملاً `check:secrets` بالأسرار التسعة، و`mysql` شاملاً توافق 0.2.0 المصحح، و`browser`، و`container`) حتى الاخضرار الكامل والدمج.
2. **في حال رغبة المالك بإضافة `RULE.MD`:** تزويد النص الحرفي ليُحفظ كما هو في الجذر مع توثيق مراجعة التعارض في `DECISIONS.md`.
3. **إتمام النشر المجاني الدائم (HOST-003):** تسجيل دخول المالك إلى Aiven Free MySQL وRender Free وإدخال متغيرات الاتصال والأسرار في Dashboard وفق [دليل النشر المجاني](../free-hosting.md).

## التحقق من الحفظ في الجلسة التالية

```sh
git branch --show-current
git status --short
git log -3 --oneline
gh pr list --state all --head "$(git branch --show-current)"
npm run check && npm run check:secrets && npm run check:continuity && npm test
```
