# سجل دليل قابل لإعادة الفحص — Integration في CeliaOS

**الملف المصوّر:** [`integration-in-celiaos.png`](integration-in-celiaos.png) · **المولّد:** [`scripts/render-integration-infographic.mjs`](../../scripts/render-integration-infographic.mjs)
**التاريخ:** 2026-11-01 · **الإصدار المرجعي:** `0.2.1` — لم يُغيَّر شيء في الكود بهذا العمل.

هذا السجل موجود لسبب واحد: كل رقم أو حالة في الإنفوجرافيك يجب أن يكون **قابلًا لإعادة الفحص** بأمر واحد.
ما لا يمكن إثباته بالأمر يُسجَّل هنا صراحةً كـ«غير متحقق» ولا يُرسم كأنه حقيقة قائمة.

---

## 1 · كيف يُعاد الفحص

```bash
npm ci                                   # لازمة بعد أي بيئة جديدة
node --test test/agent-evidence.test.js  # سلسلة الأدلة
node --test test/agent-egress-proxy.test.js
node --test test/agent-runtime.test.js
node --test test/agent-harness.test.js
node --test test/security-posture.test.js
node --test test/celia-mcp-tools.test.js
node --test test/access-policy.test.js
node --test test/collaboration-bus.test.js
node --test test/agent-bus-runtime.test.js
node --test test/agent-google-read.test.js
node --test test/issue-triage.test.js
node --test test/whatsapp-onboarding.test.js
node --test test/agent-sandbox.test.js
node --test test/agent-sandbox-tool.test.js
node --test test/agent-store.test.js
```

عدّاد الأدوات المسجّلة (لا يحتاج أي إعداد):

```bash
node -e "import('./src/agent/tools.js').then(m=>{const t=m.createDefaultTools({statusProvider:()=>({})});const l=t.list();console.log(l.length, l.filter(x=>x.requiresApproval).length, l.some(x=>/browser/i.test(x.name)), t.has('sandbox.exec')&&t.executable('sandbox.exec'));})"
```

العدّاد المتوقع: `14 5 false false` أي **١٤ أداة مسجّلة، ٥ منها تتطلب موافقة، لا أداة متصفح، و`sandbox.exec` غير قابل للتنفيذ افتراضيًا**.

---

## 2 · جدول الحالة (القسم ١٠ من الإنفوجرافيك) — دليل كل صف

| الصف | الادعاء المعروض | الدليل القابل لإعادة الفحص | نتيجة التشغيل 2026-11-01 |
|---|---|---|---|
| Tool Registry | الأداة غير المسجّلة تُرفض قبل أي أثر | `test/agent-runtime.test.js` — اختبار «an unregistered tool fails the run without side effects» | 16/16 ✅ |
| MCP | ١٢ أداة مُعلنة | `test/celia-mcp-tools.test.js:40` (`defaultTools.length === 12`) و`test/celia-mcp.test.js:140` | 2/2 ✅ |
| Policy & Approval | التنفيذ يتوقف عند بوابة الموافقة | `test/agent-runtime.test.js:147` (الأثر الخارجي ⇒ `waiting_approval`، `recorder.calls = 0`) و`test/agent-harness.test.js:219` (REJECTED يمنع التنفيذ) | 16/16 و5/5 ✅ |
| Evidence & Verification | كشف التعديل وكشف الحذف | `test/agent-evidence.test.js:68` (تعديل صف) و`:83` (حذف مدخل ⇒ فراغ تسلسل) | 6/6 ✅ |
| Database · MySQL | MySQL 8.4 عبر ملف تكامل مستقل | `integration/mysql.integration.mjs` موثّق في `docs/agent-runtime.md:207`؛ التشغيل عبر `npm run test:mysql` | **لم يُعَد هنا** — يحتاج خادم MySQL 8.4 |
| Evidence · Audit | سجل إلحاق بلا `UPDATE`/`DELETE` | `test/security-posture.test.js:204` (SP-11) + `test/edge-d1.test.js:132` | 12/12 ✅ |
| Access policy | ٦٧ صلاحية **مسجّلة** | `src/agent/access-policy.js:242` (`GRANTS = GITHUB_GRANTS + PILLAR_GRANTS + SERVICE_GRANTS` = 19+37+11) | 17/17 ✅ للتسجيل |
| WhatsApp | Webhook مُختبر بلا أسرار Meta | `test/whatsapp-onboarding.test.js` | 17/17 ✅ |
| Google | OAuth2 مُحاكى، لا ربط حي | `test/agent-google-read.test.js` | 8/8 ✅ |
| Event Bus | ناقل تسليم وتسجيل لا يستهلك المحتوى | `test/collaboration-bus.test.js` و`test/agent-bus-runtime.test.js` | 12/12 و12/12 ✅ |
| Execution Sandbox | مبني، الافتراضي `off`، واختباراته الحقيقية مشروطة | `src/agent/index.js:584` + skip في `test/agent-sandbox.test.js:13` (`CELIA_SANDBOX_INTEGRATION=1`) | 3/17 (14 متخطّاة) ⚠️ |
| Adapters | لا عقد موحّد بين الخدمات | لا يوجد module عقد؛ لكل خدمة مسارها (`src/google.js`, `src/whatsapp.js`, `src/store.js`) | لا دليل — فجوة |
| GitHub | فرز نصي فقط، لا كتابة ولا PRs | `test/issue-triage.test.js` | 35/35 ✅ |
| Browser | لا أداة متصفح في سجل الوكيل | عدّاد الأدوات أعلاه ⇒ `browser: false` | ✅ |

---

## 3 · تصحيحات على ادعاءات سابقة

| الادعاء السابق | الحالة الفعلية | المصدر |
|---|---|---|
| «١٧ أداة وكيل افتراضية» | **١٤** أداة مسجّلة افتراضيًا (`createDefaultTools().list()`)، منها ٥ تتطلب موافقة | تشغيل العدّاد أعلاه |
| «`sandbox.exec` مبني ومُختبَر» | التسجيل موجود لكن `executable('sandbox.exec') === false` افتراضيًا؛ واختبارات العزل الحقيقية **١٤ متخطّاة** محليًا | `src/agent/index.js:584`, `test/agent-sandbox.test.js:13` |
| «٦٧ صلاحية» كإثبات حوكمة | ٦٧ **مسجّلة**؛ التسجيل لا يُثبت التطبيق على كل مسار تنفيذ | `src/agent/access-policy.js:242` |
| «١٢ أداة MCP» كإثبات تكامل | ١٢ **مُعلنة**؛ لا يعني أنها متصلة بخدمة حية أو مسموح بتشغيلها | `test/celia-mcp-tools.test.js:40` |
| «N−1 مُختبر» | محدود بأدوات MCP وقراءة schema1، لا corpus كامل لكل عميل | `docs/compatibility-contract.md:20` |

---

## 4 · نطاق `NETWORK = DENY` — أين هو فعّال فعلًا

الادعاء العام «لا اتصال خارجي دون تصريح» صحيح فقط ضمن الحدود التالية:

| المسار | الحارس | الدليل | الحكم |
|---|---|---|---|
| سطح الوكيل والعزل | وسيط خروج `CELIA_AGENT_EGRESS`، الافتراضي `off`، وقائمة مضيفين صريحة ترفض `*` | `src/agent/index.js:289` + `test/agent-egress-proxy.test.js` (EP-01..17) | ✅ 17/17 — كل قفزة عبر الوسيط، والرفض قبل أي DNS |
| Edge (cron/worker) | `isDisallowedTargetHost` يمنع loopback والخاص وlink-local والميتاداتا | `workers/celia-edge/cron.js:135` + `test/security-posture.test.js:174` (SP-10) | ✅ |
| محوّلات التطبيق | لا تمرّ بوسيط الوكيل: `src/whatsapp.js` (fetch)، `src/google.js` (googleapis)، `src/ai-providers.js`، `src/ollama.js`، `src/secrets-hub.js`, `src/celia-mcp.js` | لا اختبار يثبت حراسة شبكية موحّدة لهذه المسارات | ⚠️ **فجوة معلنة** |

النتيجة: `NETWORK = DENY` **مُثبت لسطح الوكيل والـEdge**، و**غير مُثبت لمسار محوّلات التطبيق**.
لذلك يُعرض في الإنفوجرافيك كجدول نطاق، لا كشعار مطلق.

---

## 5 · مثال «مهمة عبر أربع خدمات» — ما هو فعلًا

| الخطوة | الحالة الحقيقية | الدليل |
|---|---|---|
| ١ · Webhook واتساب | مُختبر | `test/whatsapp-onboarding.test.js` 17/17 |
| ٢ · إنشاء حدث Calendar | **محاكاة تتوقف عند بوابة الموافقة** — لا يُنشأ حدث | `test/agent-runtime.test.js:222` «a calendar request reaches the approval gate instead of creating an event» |
| ٣ · تأكيد واتساب | لا يحدث قبل الموافقة | نفس الاختبار: لا `toolRun` ناجح |
| ٤ · Store + Evidence | مُختبر | `test/agent-store.test.js` 6/6، `test/agent-evidence.test.js` 6/6 |

لذلك يُوسم المثال في الإنفوجرافيك كـ«تصميم/محاكاة»، ولا يُقدَّم كتكامل حيّ من طرف إلى طرف.

---

## 6 · فجوات مفتوحة (لا تُرسم كإنجاز)

1. ربط Google حي غير متحقق — OAuth مُحاكى فقط.
2. إرسال WhatsApp فعلي غير مفعّل لغياب أسرار Meta.
3. العزل التنفيذي `off` افتراضيًا، واختباراته الحقيقية مشروطة وغير مشغّلة في هذا الصندوق.
4. لا عقد محوّلات موحّد؛ كل خدمة تُترجم على حِدة.
5. لا اختبار تكامل واحد يمرّ بالخدمات الأربع من طرف إلى طرف.
6. الحارس الشبكي لا يغطي محوّلات التطبيق (البند ٤ أعلاه).
7. `N−1` محدود النطاق ولم يُعَد على MySQL في هذه الجلسة.
8. سلامة سلسلة الأدلة مُثبتة للتعديل والحذف؛ **إعادة الترتيب** تُكشف ضمنيًا بفراغ التسلسل، لا باختبار مسمّى مستقل.

---

## 7 · حدود هذا السجل

- الأرقام أعلاه مأخوذة من تشغيل محلي في 2026-11-01، لا من مزوّد CI.
- «نجاح اختبار» ≠ «سلوك إنتاج مُتحقَّق»: الاختبارات تعمل على مخزن مؤقت ومحاكيات HTTP.
- لا يُغيّر هذا العمل `v0.2.1` ولا صورة الحاوية ولا أي سرّ.
