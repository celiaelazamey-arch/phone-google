# جلسة 2026-10-29 — حوكمة KB وربطها بشريحة AI-002

**الفرع:** `arena/0b72e456-phone-google` · **النطاق:** SQLite ومزود وهمي فقط · **Drive/Gemini/الكتابة الخارجية:** لم يحدث.
**المرجع عند البدء:** `9709421` (استيراد Drive الانتقائي)؛ لم تُوسّع قراءة Drive ولم تُعدّل تقارير AI-001.

## الهدف والقيود

الهدف كان منع المعرفة القديمة أو غير المتحققة أو الممارسات الأمنية المهجورة من التحول تلقائيًا إلى تعليمات Planner، ثم إثبات شريحة AI-002 العمودية بأداة قراءة محلية: Planner يختار `kb.search`، وRuntime ينفذها، ويعيد `tool_result` إلى النموذج، ويُستخدم الدليل في القرار التالي. الوكيل يبقى وكيل مهام محصورًا، لا وكيلًا عامًا أو وكيل برمجة.

## ما نُفّذ

- أُضيف `src/knowledge/governance.js` بأنواع الادعاء الأربعة وسياسة `planner-safe-v1` وحساب حالة المراجعة وأسباب الاستبعاد.
- أصبح مخطط KB الإصدار 2 مع عمودَي `claim_type` و`review_due`، وترقية additive لقواعد v1، وحفظ/تحديث/تصدير/استعادة الحقول. السجلات القديمة ذات الحقول الناقصة لا تصبح مؤهلة للـPlanner.
- حُدّثت عقود CSV و`knowledge_registry.csv` و`learned_registry.csv` و`drive_registry.csv` و`kb-seed.mjs` و`manifest.json`. سجلا Drive الانتقائيان مصنّفان `historical_report`؛ لم تُعتمد موادهما كحقائق حالية.
- أُضيف `profile:'planner'` إلى البحث المحلي. بعد FTS5 لا تدخل حزمة النموذج إلا مستندات `doc` ذات `operational_guidance` وT1/T2 ومراجعة سارية؛ المطابقة المباشرة للكيانات غير المؤهلة والحواف غير لازمة لا تُرسل للـPlanner. لا embeddings ولا تسمية دلالية للبحث.
- أُضيف `plannerSafe` إلى تعريفات الأدوات، وأُضيف فحص `kb_planner_governance` إلى المتحقق المستقل. يرفض `createProviderPlanner` تسجيل `kb.search` بلا العلامة الآمنة، فشلًا مغلقًا قبل أي قرار أو تنفيذ. لا تغيير في `createAgentHost` الافتراضي `demo-deterministic` ولا علم مزود حي.

## الأدلة المنفذة حتى الآن

- `node --test test/knowledge-ingest.test.js test/knowledge-store.test.js test/learning-protocol.test.js test/kb-routes.test.js` → **34/34** بعد تحديث عقود fixtures والمخطط.
- `node --test test/knowledge-governance.test.js` → **3/3**: أنواع الادعاء والتاريخ، استبعاد التاريخي/غير المتحقق/المهجور/المنتهي/T3 والكيانات غير المؤهلة، وترقية v1 واستعادة الحقول.
- `node --test test/agent-kb-planner.test.js` → **1/1**: مزود وهمي + KB حقيقي على SQLite؛ استُبعدت سجلات مطابقة تاريخية ومنتهية، ونجحت الأداة، وعاد `tool_result`، واستهلك القرار التالي معرّف الدليل و`review_due`، وكانت سلسلة الأدلة والفاحص المستقل `PASS`.
- `node --test test/agent-verifier.test.js` → **13/13**، بما في ذلك رفض `historical_report` ومراجعة منتهية وسياسة ثقة مخالفة وغلاف حوكمة غائب في Run يحمل أدلة Provider رغم وجود provenance.
- `npm run kb:manifest` و`npm run kb -- verify` → نجحا بلا صفوف مرفوضة أو حواف unresolved؛ التحقق الجاف شمل 81 عنصرًا و91 حافة. بعد `import --apply` على الفهرس المحلي كانت الترقية **34 updated / 47 unchanged / 0 rejected**، وإعادة التطبيق **81 unchanged / 0 added / 0 rejected**.
- `npm test` → **629/629** بلا فشل أو تخطي؛ `npm run test:coverage` → **91.98% أسطر / 75.53% فروع / 87.32% دوال** مع اجتياز حدود package.json.
- `npm run check` → **163 ملف JavaScript**؛ `npm run check:secrets` → `wiringVerified:true` و`zeroLeakVerified:true`؛ `npm run now:check` و`npm run check:continuity` → **76 وثيقة / 273 رابطًا محليًا / 75 مهمة** بلا دورات؛ `git diff --check` → ناجح.

## حدود الادعاء والتالي

هذه النتائج حتمية محلية فقط. لا تثبت جودة Gemini أو أي نموذج حي، ولا اتصال Google/Calendar/WhatsApp، ولا قبول Chromium/MySQL، ولا نشرًا أو ترحيل إنتاج أو Model Routing أو Sandbox. AI-001 ما زال جارًٍا والتشغيل الحي NO-GO؛ لم تُسجّل قرارات مراجعة بشرية آلية.

بعد هذه الشريحة، تبقى أولوية التقارب: **AGENT-003 Sandbox**، ثم إعادة تخطيط محدودة للفشل الداخلي، ثم أدوات الملفات/Shell/Git داخل العزل والموافقات فقط. لا توسيع Drive ولا embeddings في هذه الشريحة.
