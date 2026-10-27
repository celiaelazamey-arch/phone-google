# تسليم جلسة — 2026-10-27 — توظيف أسرار المستودع التسعة وإصلاح توافق MCP 0.2.0

## المهمة والتفويض

المستخدم وجّه بتوظيف أسرار مستودع GitHub التسعة في نظام سيليا بالكامل (`وظف الاسرار في نظامي بالكامل`):

1. `AGENETROUTERAPI_KEY`
2. `AI_GATEWAY_API_KEY`
3. `CELIA_MCP_API_TOKEN`
4. `CELIA_VOICE_ID`
5. `DEEPSEEK_API_KEY`
6. `ELEVENLABS_API_KEY`
7. `FIGMA_ACCESS_TOKEN`
8. `GEMINI_API_KEY`
9. `YOUR_CODATA_API_KEY`

مع الحفاظ الكامل على قواعد `AGENTS.md` وعقد التوافق (`0.2.1` / `schema: 1`)، وعدم كشف أي قيمة سرية في المتصفح أو السجلات أو الوثائق، وعدم اختلاق ملف `RULE.MD` الذي لم يُزوَّد نصه بعد.

## واقع البداية

- الفرع النشط: `arena/266896e1-phone-google` متفرعًا من `d5cdac830aa213cfe0f096d6519c786516593c57` (`main` بعد دمج PR #23).
- كان المستودع يربط فعليًا سرين فقط (`GEMINI_API_KEY` و`CELIA_MCP_API_TOKEN`) بينما الأسرار السبعة الباقية غير موظفة في الكود أو CI أو قوالب التشغيل.
- فحص سجل CI على `main` (`40472631099`) كشف فشل وظيفة `mysql` عند السطر 161 من `integration/mysql.integration.mjs` لأن مقارنة `assert.deepEqual` الحرفية لمخطط `MCP_TOOLS` رفضت إضافة الحقل الاختياري غير الكاسر `idempotencyKey` مقارنةً بإصدار `0.2.0` (`2508893bd7e6d447b2e19374933556322cc9cdb7`).

## ما تغيّر فعليًا في هذه الجلسة

### 1. محرك مزودي الذكاء الاصطناعي المحكومين وحارس SSRF — `src/ai-providers.js` و`src/ollama.js`
- إنشاء `normalizeHttpsApiUrl` لفرض `https:` ومنع بيانات الاعتماد المضمنة وعناوين `localhost` والشبكات الخاصة والربط المحلي (IPv4/IPv6).
- إنشاء `loadExtendedIntegrationsConfig` لتحميل الأسرار التسعة مع دعم الأسماء الدقيقة في المستودع (`AGENETROUTERAPI_KEY` و`YOUR_CODATA_API_KEY`) والأسماء المعيارية البديلة (`AGENTROUTER_API_KEY` و`ELEVENLABS_VOICE_ID` و`CODATA_API_KEY`)، والتحقق الآمن غير القاتل من صيغة `CELIA_VOICE_ID`.
- إنشاء `generateOpenAiCompatibleReply` وتحديث `generateCeliaReply` لدعم المزودين السبعة (`auto`، `gemini`، `ai_gateway`، `deepseek`، `agentrouter`، `ollama`، `local`) خلف حارس سياسة الرد العربي ومنع حقن المطالبات وقواطع الدوائر المستقلة.
- ضبط `auto` ليستدعي مزودًا سحابيًا واحدًا على الأكثر افتراضيًا (`CELIA_AI_ALLOW_CLOUD_FAILOVER=false`) قبل الرجوع للمحلي، وربط الرد الآلي لـWhatsApp (`src/whatsapp.js`) بالمحرك الموحد.

### 2. مركز الأسرار والصوت والتصميم وCodata — `src/secrets-hub.js`
- `buildSecretsReadiness`: تقرير جاهزية منقح للأسرار التسعة دون كشف أي قيم أو أطوال أو بادئات.
- `synthesizeCeliaSpeech` و`probeCeliaVoice`: توليد الصوت العربي عبر ElevenLabs (`ELEVENLABS_API_KEY` + `CELIA_VOICE_ID`) مع حماية `Idempotency-Key` وحد حجم 5MB.
- `fetchFigmaProfile` و`inspectFigmaFile`: فحص ملفات Figma للقراءة فقط عبر `FIGMA_ACCESS_TOKEN` مع فلترة المعرّفات وإزالة الحقول الشخصية.
- `getCodataStatus`: موصل حالة مساحة Codata للقراءة فقط عبر `YOUR_CODATA_API_KEY` مع قفل `primaryTransactionalStore: false` و`automaticMigrationAllowed: false` التزامًا بـDEC-002.
- `createSecretsHubRouter`: ربط المسارات المحمية (`/api/secrets/status`، `/api/ai/reply`، `/api/voice/*`، `/api/figma/*`، `/api/codata/*`) بمصادقة `Bearer` للمالك على كل من `src/celia-mcp.js` و`src/app.js` دون حجب المسارات التشخيصية العامة.

### 3. الاستوديو والـSandbox الثابت وعقد التوافق — `src/mcp-contract.js` والواجهة
- تصفير الأسرار التسعة في `sandboxConfig` داخل `src/celia-ui.js` لمنع استهلاك مفاتيح المالك من الزوار غير الموثقين، وإضافة مورد `celia://secrets/readiness` في الخادم وفي `scripts/static/celia-static-shim.template.js`.
- تحديث `public/index.html` و`public/app.js` لإتاحة مزودي الخادم الأربعة وتجربة صوت سيليا الحي وعرض شبكة جاهزية الأسرار التسعة عند التوثيق برمز المالك، وتحديث CSP لدعم `media-src 'self' data: blob:`.
- إنشاء `src/mcp-contract.js` (`assertBackwardCompatibleMcpTools`) وتحديث `integration/mysql.integration.mjs` للتحقق الدلالي من توافق الـ12 أداة الافتراضية مع 0.2.0، وجعل الأدوات الـ4 الإضافية (`celia_voice_speak`، `figma_file_inspect`، `codata_status`، `celia_secrets_status`) اختيارية عبر `CELIA_EXTENDED_MCP_TOOLS=true`.

### 4. CI وقوالب التشغيل والوثائق
- إنشاء `scripts/check-secrets-wiring.mjs` (`npm run check:secrets`) وربط الأسرار التسعة في `.github/workflows/celia-mcp.yml` مع كتابة ملخص منقح في `GITHUB_STEP_SUMMARY`.
- تحديث `.env.example` و`render.yaml` (`sync: false`) و`docs/deployment-profile.json` و`docs/free-hosting.md` و`docs/codata-evaluation.md` و`DEC-010` في `docs/continuity/DECISIONS.md`.

## الفحوص — نتائج هذه الجلسة

| الفحص | النتيجة |
|---|---|
| `npm run check` | ناجح — 55 ملف JavaScript |
| `npm run release:check` | ناجح — `0.2.1` / السابق `0.2.0` / `databaseSchema: 1` |
| `npm run check:secrets` | ناجح — تتبع 9 أسرار + التحقق من 401/200 وصفر تسريب |
| `npm test` | **75/75 ناجحة** محليًا على Node 22.22.3 (شاملة اختبار التوافق الحي مع أرشيف 0.2.0) |
| `npm run celia:mcp:verify` | ناجح — فحص ذاتي كامل لخادم MCP |
| `npm run build:pages` | ناجح — 6 صفحات ثابتة ومحاكي المتصفح |
| `npm run check:continuity` | يُفحص بعد حفظ ملفات الاستمرارية ومقارنة نطاق التغيير مع خط الأساس |

## غير المتحقق محليًا / المؤجل

- ثنائيات متصفح Playwright وخدمة MySQL 8.4 الحية غير مثبتة داخل حاوية الجلسة المحلية المعزولة شبكيًا؛ تُشغَّل آليًا في مهام GitHub Actions (`browser` و`mysql` و`container`) فور الدفع وفتح طلب الدمج.
- النشر الخارجي الدائم على Render/Aiven ما زال بانتظار خطوة المالك في لوحتي المزودين (HOST-003).
- حفظ `RULE.MD` مؤجل بانتظار تزويد المالك بنص الملف الحرفي لعدم وجوده في المستودع أو Google Drive.

## المخاطر والضوابط

- **تعدد المزودين السحابيين:** حُكم بحد مزود سحابي واحد في `auto` افتراضيًا لتفادي مشاركة رسائل العملاء عبر مزودين متعددين دون إذن (AI-002).
- **مخاطر SSRF وتزوير المسارات:** حُكمت جميع عناوين المزودين بحارس HTTPS العام ومعرّفات صوت/ملفات Figma/Codata بتعبيرات نمطية صارمة.

## نقطة الدخول للجلسة التالية

1. راجع نتيجة مهام GitHub Actions على طلب الدمج المفتوح من الفرع `arena/266896e1-phone-google`.
2. إن زوّد المالك بنص `RULE.MD` احفظه حرفيًا في الجذر ووثّق مراجعة التعارض في `docs/continuity/DECISIONS.md`.
3. لمتابعة النشر المجاني الدائم، راجع HOST-003 في `docs/continuity/BACKLOG.md` و`docs/free-hosting.md`.
