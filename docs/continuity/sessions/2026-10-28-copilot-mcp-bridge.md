# جلسة 28 أكتوبر 2026 — طبقة حماية Copilot وخريطتها البصرية (AGENT-005)

**الفرع:** `arena/9946d4aa-phone-google` (من `main@be2710b`) · **الطلب:** «مخطط بصري للمعمارية الجديدة، تحقق من 100%» ·
**الدليل البصري:** [docs/copilot-mcp/architecture.svg](../../copilot-mcp/architecture.svg) · **الدليل النصي:**
[docs/copilot-mcp/README.md](../../copilot-mcp/README.md).

## 1. ما وجدته عند الفحص (لا افتراض)

- تقرير التحقق المرفق (`VERIFICATION.md`) يذكر ملفين لم يكونا في المستودع: `scripts/celia-copilot-mcp-bridge.mjs` وملف
  إعداد MCP. أي أن الحزمة عاشت خارج Git، و«8/8» كانت على نسخة لا يمكن لأحد مراجعتها.
- **حدّ جوهري في النسخة السابقة:** كانت اختباراتها على **خادم MCP اصطناعي**. هذا يثبت شكل التحويل، لا أنه يعمل أمام خادمنا؛
  ولا يكشف مثقبًا حقيقيًا: الخادم لا يُعلن `celia_secrets_status` إلا مع `CELIA_EXTENDED_MCP_TOOLS=true`، فكانت «الأربع أدوات»
  تصبح ثلاثًا بلا أن ينتبه أحد.
- **حقيقة معمارية:** خادم Celia MCP يعرّف **16** أداة (12 أساسية + 4 موسّعة)، لا 12. القائمة المحظورة تغطي 12 لأن
  `celia_secrets_status` مسموحة والأربع الموسّعة الأخرى إحداها مسموحة وثلاث محظورة، والـ`find_skills`/`celia_status`…
  الحصر الدقيق في `REFUSED_TOOLS` (12) و`ALLOWED_TOOLS` (4) = 16.

## 2. ما نُفِّذ هنا (شيفرة حقيقية، لا حزمة خارجية)

| الملف | الدور |
|---|---|
| `scripts/celia-copilot-mcp-bridge.mjs` | جسر stdio أمام `src/celia-mcp.js --stdio` بأربع بوابات: قائمة سماح، وسوم قراءة فقط، قدرات `tools` فقط، تنقية نتائج وحجب أسرار. قابل للحقن (`child`/`output`/`env`) لاختبار التدفق بلا شبكة |
| `docs/copilot-mcp/celiaos-copilot-mcp-2026.json` | إعداد MCP (بلا مفاتيح/بطاقة) يشغّل الجسر، ويضبط الذاكرة و`CELIA_EXTENDED_MCP_TOOLS` صراحةً |
| `scripts/render-copilot-architecture.mjs` | يولّد SVG + HTML + Mermaid من **نفس ثوابت السياسة**، مع `lintLayout` يمنع تجاوز النص لحدّ اللوحة و`--check` يفشل عند القدم |
| `docs/copilot-mcp/architecture.{svg,html}` + `celiaos-copilot.mmd` | المخطط البصري والنسخة القابلة للتعديل |
| `test/copilot-mcp-bridge.test.js` | 16 اختبارًا: 10 سياسة، 2 تدفق، **3 E2E على الخادم الحقيقي**، 1 حماية المخطط |

**أوامر جديدة:** `npm run test:copilot-bridge` · `npm run copilot:diagram` · `npm run copilot:diagram:check`.

## 3. الأدلة المقاسة

- **في CI على `d324be1`:** `Celia quality & resilience` ✅
  [`40678857568`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40678857568) — Node 22 و24 + Python + حاوية +
  RTL + MySQL 8.4 كلها ناجحة. و`Service reality audit`
  [`40678857684`](https://github.com/celiaelazamey-arch/phone-google/actions/runs/40678857684): offline **401/401**، تغطية
  **90.49/73.31/83.88**، MySQL **11/11**، والحي **11 متحققة / 1 فاشلة = 91.7%** — الفشل الوحيد ما زال `CELIA_VOICE_ID`
  (18 تعديلًا عن أقرب صوت مرئي)، وهو إجراء مالك لا كود.
- محليًا: **401/401** اختبارًا، تغطية أسطر **90.51%** وفروع 73.24 ودوال 83.88 (الأرضية 89/71/82).
- الجسر: تغطية **88.31%** أسطر، والمولّد **95.63%**.
- E2E على الخادم الحقيقي يثبت: الأدوات الأربع فقط، `readOnlyHint` على كل واحدة، `storage: memory`، رفض
  `whatsapp_send_text` و`prompts/list` و`resources/read`، وفلترة `find_skills` (`policyFiltered: true`).

**تصحيحات بصرية اكتُشفت بالمعاينة الفعلية للمخطط (لا بالتخمين):** `direction="rtl"` مع `text-anchor="end"` يمدّ النص
**يمينًا** في resvg/Chromium فيخرج من اللوحة؛ وحُذف، فصار الأنكور وحده يحدد الصندوق. وأُعيد ترتيب الألواح والفواصل كي لا
يتقاطع أي عنوان مع جاره، وأُضيف `lintLayout` كي لا يتكرر ذلك في commit لاحق.

## 4. ما لم يُثبت (بصراحة)

- **الاتصال ببيئة Copilot المستضافة لم يُختبر:** لا صلاحية لإعداد `Settings → Copilot → MCP servers` في حساب المالك.
- «100%» هنا تعني: السياسة مطبقة ومختبرة على الخادم الحقيقي، والمخطط مطابق للسياسة بالبناء. ولا تعني أن Copilot نفسه استُدعي.

## 5. الخطوة التالية للمالك

1. تأكيد أن `scripts/celia-copilot-mcp-bridge.mjs` موجود في `main` بعد الدمج.
2. `Settings → Copilot → MCP servers` → لصق `docs/copilot-mcp/celiaos-copilot-mcp-2026.json` → Save.
3. فتح سجل Copilot: **أربع أدوات فقط**، كلها بوسم قراءة فقط. أي أداة خامسة = الإعداد يشير لمسار آخر.
