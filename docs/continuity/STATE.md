# الحالة الحالية — ابدأ من هنا

> **حفظ التاريخ بلا حذف (`DEC-052` / `CONT-004`):** هذه نافذة الاستئناف النشطة؛ السجل التراكمي الكامل حتى ما بعد PR #84 (`main@738d832` / `9f6f8b2` — 983 سطرًا / 142,150 بايت) محفوظ حرفيًا في **[STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md)** وبصمته محروسة بـ`R0-02`. القراءة السريعة المشتقة: **[NOW.md](NOW.md)** (`npm run now`).

**آخر مراجعة:** 29 أكتوبر 2026 · **نوع الجلسة الحالية:** **MANUS-C1b-C2a — الوصول إلى الويب (S5/M-C)** على `arena/df8cbebc-phone-google` من `main@97078dc`: بوابة إقلاع صريحة `CELIA_AGENT_EGRESS=off|proxy` + `CELIA_AGENT_EGRESS_ALLOWLIST`، منحة واحدة **لكل جلب** تُسحب في `finally`، وأداة `web.fetch` الوحيدة (قراءة، بلا موافقة كتابة) تمر دائمًا عبر وسيط C1 وتحمل سقوفًا وميزانية لكل تشغيل، وتنقّي الحقن قبل أن يرى المخطِّط أي نص، وتشهد على كل محاولة بصف أدلة (`web_source`) بـ`PASS`/`BLOCK`. وبعد مطابقة مخطط 2026 (DEC-061): قائمة بصيغة `https://host` تُطبَّع إلى `host:443`، وسقف تزامن عام في الوسيط (`maxConnections`، 429 مسجَّل)، والسياسة المنفَّذة تُعلن في `/api/agent/egress`. **طبقة المحوّلات في المخطط غير موجودة ولم تُبنَ.** **اختبارات: 15/15** (+1 سقف تزامن في EP-14 → 14/14 للوسيط) ([`test/agent-web-access.test.js`](../../test/agent-web-access.test.js)) وبوابة `npm run eval:web` **11/11**. **شبكة العزل ما زالت `deny` حرفيًا** ولم تُفتح أي allowlist. سجل الجلسة: [2026-10-29-manus-c1b-c2a-web-access](sessions/2026-10-29-manus-c1b-c2a-web-access.md) · الدليل: [agent-egress.md](../agent-egress.md) · القرار: `DEC-060`.

**الجلسة السابقة:** **MANUS-C1a — وسيط الخروج** التي **دُمجت في `main@97078dc` (PR #95)**: وسيط HTTP(S) بمنحة معتمة لكل run، allowlist لكل تشغيل، «قرار قبل DNS»، وتدقيق كل قرار (`egress_request`) — 13/13 ([السجل](sessions/2026-10-29-manus-c1-egress-proxy.md)، `DEC-059`). **قبلها:** B4 (PR #93 → `main@acafa13`) · B3 + إنقاذ A4 + قارئ العنكبوت (PR #92 → `main@bdfbb6b`) · B2 · B1 · A3 · A2 · A1 · GOOG-005 · WP — سجلاتها في `docs/continuity/sessions/` وروابطها في [NOW.md](NOW.md).
**ملاحظة استمرارية:** PR #94 (تصحيح توثيقي لدمج #93) **أُغلق كمُستبدَل** بكلمة المالك؛ محتواه الوحيد غير الموجود في `main` (سطر «PR #93 دُمج في main@acafa13» داخل سجل B4) نُقل إلى هذا الفرع قبل الإغلاق، فلا شيء ضاع.
**الأرشيف التاريخي الكامل:** [STATE-ARCHIVE-2026-10.md](STATE-ARCHIVE-2026-10.md) · **سجلات الجلسات:** `docs/continuity/sessions/`.

## 0. خط الأساس والدرجة

- **بداية جلسة C1b/C2a:** `arena/df8cbebc-phone-google` من `main@97078dc` (دمج PR #95) بشجرة نظيفة.
- **الدمج:** **PR #96 دُمج بكلمة المالك في `main@00a2386`** (2026-10-29 23:32Z) بعد 6 فحوص CI ناجحة (2 skip مقصود) — لا ترحيل ولا نشر ولا تفعيل `CELIA_AGENT_EGRESS=proxy` في أي بيئة رافقه. و**PR #94 أُغلق كمُستبدَل** بعد نقل سطره الوحيد غير الموجود في `main`. لا PR مفتوح الآن.
- **الإصدار:** `v0.2.1` · `schema=1` · Node `>=22`. لا ترحيل جديد في هذه الشريحة (لا جدول جديد؛ `web_source` نوع أدلة قائم على نفس الجدول).
- **السلّم:** S0 ✅ · S1/A4 ✅ · S4 (M-B) ✅ · **S5 (M-C):** C1-a ✅ مدموجة، **C1-b + C2-a ✅ منفَّذتان على الفرع** · **C2-b (`web.search`) غير منفَّذة** — تحتاج قرار مزوّد من المالك.
- **الجودة:** **783 اختبارًا / 766 ناجحًا / 1 فشل بيئي (`MCP_TOOLS` N/N−1: كائن Git `2508893…` غير موجود في هذا الاستنساخ) / 16 skipped** وتغطية **90.83 / 76.10 / 86.81** (قبل الشريحة: 767 / 750 / 1 / 16 و90.99 / 76.03 / 87.05). الشريحة تضيف **16** اختبارًا جديدًا كلها ناجحة.

## 1. ما نُفِّذ في C1-b + C2-a

- **بوابة مغلقة افتراضيًا:** `readAgentEgress(env)` — `off` افتراضيًا (صفر مقابس وصفر أدوات)، `proxy` تتطلب قائمة صريحة، و`*` مرفوض؛ أي قيمة أخرى تُفشل الإقلاع. لا فرع «متساهل».
- **منحة لكل جلب لا لكل تشغيل:** `issueGrant` بصلاحية 30s ثم `revokeGrant` في `finally` (نجاح/فشل/إلغاء) — `activeGrants()` فاضية بين الخطوات (WB-03، WB-10).
- **`web.fetch` وحدها:** قراءة، `settledFailures`، بلا موافقة كتابة، ولا كتابة ولا إرسال؛ مُعلنة في سجل الأدوات فقط عند وجود خدمة ويب (WB-11)، ومسجّلة في `CANONICAL_TOOLS` كـ`risk: read`.
- **قائمة لكل رحلة:** كل redirect (حتى 3) يُعاد فحصه بالقائمة قبل أي اتصال؛ الهدف الخارجي لا يُلمس أصلًا (WB-06).
- **الحقن قبل المخطِّط:** `scanForInjection` على العنوان والنص؛ المخطِّط يرى النص **المنقّى** + معرّفات القواعد، والبصمة تُحسب على المنقّى. ملاحظة مقيسة: المنقّي يطبّع كذلك (تاء مربوطة/ياء/تشكيل)، فالنص المنقّى ليس بايتًا-ببايت الأصل.
- **أدلة لكل محاولة:** نوع `web_source` — `PASS` مع بصمة، أو `BLOCK` مع الكود وبلا بصمة؛ النص لا يُخزَّن، و`hashOf` للصف يساوي حرفيًا كائن الميتاداتا (WB-14).
- **سطح المالك:** `GET /api/agent/egress` خلف تفويض المالك → `{mode, hosts, url, stats}` بلا أي رمز منحة (WB-13).
- **السقوف:** 2MiB رد · 3 redirects · 20s · 20 000 حرف للصفحة · 6 جلب و80 000 حرف للتشغيل · 16 طلبًا متزامنًا في الوسيط (`CELIA_AGENT_EGRESS_MAX_CONNECTIONS`) — كلها مُتحقَّقة عند الإنشاء.
- **مطابقة مخطط 2026 (`DEC-061`):** صيغة `https://host` في القائمة تُقبل عند حدود الإعداد وتُضيّق إلى منفذ صريح؛ `deny:['*']` و`upstreamProxy:null` معلنان؛ وطبقة `unified-converter` + المحوّلات الستة **غير موجودة ولم تُبنَ** (ليست توصيلًا بل إعادة بناء).
- **لم يُنفَّذ:** `web.search` (C2-b)، ولا اتصال إنترنت حقيقي، ولا تفعيل `CELIA_AGENT_EGRESS=proxy` في أي بيئة.

## 2. الحدود والعوائق

1. **العزل بلا شبكة، بقرار `DEC-060`:** لا allowlist داخل `sandbox-policy.js`، ولا veth/slirp، ولا `CAP_NET_ADMIN`؛ الويب على المضيف عبر الوسيط. EP-11 يحرس الرفض.
2. **لا نموذج حي:** `GOV-001` (مفتاح + ميزانية) قرار مالك. ولا Drive/Gmail حي.
3. **`web.search` مؤجلة:** مزوّد (Brave / Google CSE / Serper) أو كشط HTML — قرار مالك بتكلفة وشروط، لا يُبنى على تخمين.
4. **MySQL/Chromium:** لا خدمة معزولة ولا Chromium في هذا الصندوق؛ `test:mysql`/`test:browser` لم تُشغَّل هنا ولا يُدّعى نجاحهما.
5. **N/N−1 البيئي:** الكائن `2508893…` غير موجود في هذا الاستنساخ.
6. **PR #94** أُغلق كمُستبدَل (بكلمة المالك) بعد نقل سطره الوحيد غير الموجود في `main` إلى سجل B4.

## 3. الاستئناف والفحوص

1. ابقَ على `arena/df8cbebc-phone-google`؛ اقرأ [سجل C1b/C2a](sessions/2026-10-29-manus-c1b-c2a-web-access.md) و[دليل الوسيط](../agent-egress.md) و`DEC-060` قبل أي تعديل على مسار الويب.
2. لا تفتح `network.allowlist` في العزل، ولا تجعل `CELIA_AGENT_EGRESS` افتراضيًا `proxy`، ولا تُطلِق منحة أطول من اللازم، ولا تسجّل `web.search` بلا قرار مزوّد.
3. أول فحص آمن: `node --test test/agent-web-access.test.js test/agent-egress-proxy.test.js` ثم `npm run eval:web` ثم `npm run check:continuity`.

```sh
git branch --show-current && git status --short && git log -3 --oneline
node --test test/agent-web-access.test.js test/agent-egress-proxy.test.js
npm run eval:web
node --test test/agent-runtime.test.js test/agent-tools.test.js test/agent-sandbox-tool.test.js
npm run test:coverage
npm run check && npm run now && npm run now:check && npm run check:continuity && npm run check:secrets
```
