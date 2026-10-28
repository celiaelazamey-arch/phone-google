# تسليم جلسة — 2026-10-28 — تدقيق واقع الخدمات بالأسرار الحقيقية (DEC-030، QA-005)

## المهمة والتفويض

- طلب المستخدم: «استخدم كل طاقتك وأدواتك وصلاحيتك… لا أريد خدمة في نظامي مجرد اسم أو موكب وإنما خدمات حقيقية تم
  اختبارها والتأكد من عملها بنسبة 95% على الأقل».
- معرفات BACKLOG: QA-005 (جديد). قرار: DEC-030.
- النطاق المسموح: الفرع `arena/bf717032-phone-google` فقط؛ لا دمج (PR #46 يبقى مفتوحًا)، لا بطاقة، لا تغيير في الأسرار
  أو حذفها نيابةً عن المالك، لا ادعاء بلا دليل.

## واقع البداية

- الأسرار الـ18 **موجودة** (مثبت بـ`check:secrets` والـWorker)، لكن لا دليل على **عمل** أغلبها: المسبار الحي الوحيد
  (Gemini) مقيّد بـ`main`؛ `getCloudflareR2Status` و`getCodataStatus` حضور فقط؛ `/readyz` للـWorker يعلن `durable: true`
  لمجرد وجود أسرار R2.
- من الصندوق المحلي لا شبكة إلى أي مزوّد؛ القناة الوحيدة للتحقق الحقيقي: GitHub Actions بالأسرار، ولا يمكن قراءة سجلات
  الخطوات ولا تنزيل artifacts من هنا (EOF) → النتائج تُقرأ من **check-run annotations** فقط.

## ما تغير فعليًا

- **`scripts/service-reality.mjs`** (`npm run reality`): اختبارات بلا شبكة + تغطية (TAP مفروض لأن Node 24 يفترض `spec`)،
  `test:mysql` على MySQL 8.4 حقيقي، 20 مسبارًا حيًا (Gemini عبر `generateCeliaReply`، ثلاثة مزودين OpenAI-متوافقين،
  ElevenLabs، Figma، cron-job.org، Cloudflare `tokens/verify` مستخدم/حساب + سكربت الـWorker، R2 `ListBuckets` موقّع
  SigV4 (متجه AWS الرسمي في الاختبار)، Google OAuth client عبر `invalid_grant`، رمز المالك ضد الـWorker الحي، Pages،
  GHCR، الإصدار، خطة Render). أحكام ستة؛ النسبة على المهيأ فقط؛ منقّي أسرار + خروج 3 عند تسرب؛ annotations لكل فشل.
- **`.github/workflows/service-reality.yml`**: `[reality]` في رسالة الـcommit أو dispatch؛ الأسرار الـ18 + متغيرات التقاعد
  `CELIA_DISABLE_*` و`*_MODEL`؛ artifact 90 يومًا.
- **اختبارات:** `test/service-reality.test.js` 9 (SigV4، المصنفات، المحلل، التسجيل، التنقية، عالم وهمي كامل، تشخيص
  402/400/ENOTFOUND، التقاعد، سلك الـworkflow)، `test/ai-providers.test.js` 3. الإجمالي 323/323.
- **إصلاحات من الدليل:** `/readyz` صادق؛ افتراضي DeepSeek `deepseek-flash`؛ `generateOpenAiCompatibleReply` يحمل
  `upstreamDetail` ويشرح 200 بلا `choices`.
- **وثائق:** `docs/service-reality.md` (جدول الحقيقة)، README، CHANGELOG، STATE، BACKLOG (QA-005)، DECISIONS (DEC-030).

## الدليل (تشغيلات حقيقية على الفرع)

| run | commit | النتيجة | ما تعلمناه |
|---|---|---|---|
| `40645048626` | `93e2b05` | فشل | 9 متحققة/7 فاشلة؛ تفاصيل غائبة (Node 24 `spec`؛ لا annotations لكل خدمة) |
| `40645513314` | `f43cfc6` | فشل | Cloudflare توكن حساب → ✅ (10 متحققة)؛ أول أسباب: 403/402/400/401/`fetch failed` |
| `40646259843` | `ace053a` | فشل | ElevenLabs: `/user` 401 لكن 34 صوتًا مرئيًا؛ AgentRouter 0 نماذج؛ DeepSeek يسرد `deepseek-flash`/`v4-pro`؛ R2 TLS handshake مرفوض |
| **`40646881277`** | `d473dfb` | فشل (62.5%) | AI Gateway: «requires a valid credit card»؛ DeepSeek: «Insufficient Balance»؛ ElevenLabs `missing_permissions` + `voice_not_found` |

النهائي: 322/322 بلا شبكة (85.79% أسطر)، MySQL 11/11، 10 ✅ / 6 ❌ / 1 ⚪ / 2 🟡 / 1 🚫.

## ما لم يُفعل ولماذا

- لم تُحذف الأسرار الميتة ولم تُستبدل (قرار حساب للمالك). لم يُدمج PR #46. لم تُضف بطاقة لأي مزوّد.
- لم يُشغَّل `workflow_dispatch` (الـworkflow غير موجود على `main` بعد) — التشغيل عبر `[reality]` على الفرع.
- لم يُنقل مسبار `celia-mcp.yml` إلى السكربت الجديد (خارج النطاق؛ يبقى يعمل على `main`).

## الخطوة التالية بالضبط

1. المالك: لكل خدمة فاشلة — تجديد/تمويل أو `CELIA_DISABLE_<SERVICE>=true` كمتغير مستودع؛ ElevenLabs يحتاج مفتاحًا
   بصلاحيات `user_read`/`voices_read` ومعرّف صوت من الحساب (`CELIA_VOICE_ID`).
2. commit بـ`[reality]` (أو dispatch من `main` بعد الدمج) وقراءة `gh api repos/<owner>/<repo>/check-runs/<job>/annotations`.
3. عند ≥95% بدليل run: تحديث QA-005 إلى «متحقق» مع رقم الـrun.
