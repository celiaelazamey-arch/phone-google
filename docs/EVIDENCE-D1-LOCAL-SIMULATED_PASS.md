# Evidence Report — D1 Backup & Recovery LOCAL — `SIMULATED_PASS`
## تثبيت نسخة التنفيذ التي اختُبرت — ليس `f9bfa4e` وحده

> **القاعدة:** `f9bfa4e` هو `HEAD` و`origin/main`، لكن شجرة العمل غير نظيفة. الحكم `SIMULATED_PASS` مرتبط باللقطة التالية، لا بالـcommit وحده. هذه الوثيقة هي المرجع القابل لإعادة الحساب.

**التاريخ:** 2026-11-04 (America/Los_Angeles) — `git log -1: f9bfa4e feat(apps-script): مزامنة clasp... GOOG-006 (#168)`
**الفرع:** `arena/241c4e6f-phone-google` — `active` — `git rev-parse HEAD = f9bfa4e4e6b2f2d3394943cc5424c87e6a0529c2`
**الحكم المعلن:** `SIMULATED_PASS` — محاكاة محلية فقط — لا `VERIFIED` — `NETWORK=DENY` مستمر

---

## 1) حالة الملفات — تثبيت كامل قبل الانتقال

### 1.1 `git status` و `git diff`

```
 M docs/plan-system-completion.md
?? docs/EXTERNAL-INTEGRATION-APPROVAL.md
?? scripts/d1-verify.mjs
?? test/d1-verify.test.js
```

**`git diff HEAD` الوحيد:**
```diff
diff --git a/docs/plan-system-completion.md b/docs/plan-system-completion.md
-| `syntax_files` | 279 |
+| `syntax_files` | 281 |
```

**بصمة الـdiff:**
```
sha256(git diff HEAD) = b05c6b08b5c4c1cc7dfa8d31cba63547005504238e87c1e91ab878b1dd64dcea
```

هذا التعديل **مشتق** — تصحيح عدّ ملفات `scripts/check.mjs` بعد إضافة `scripts/d1-verify.mjs` + `test/d1-verify.test.js` (281 بدل 279). لا منطق أعمال.

### 1.2 بصمات SHA-256 للملفات الأربع (نسخة التنفيذ)

| الملف | SHA-256 | الحالة |
|---|---|---|
| `docs/plan-system-completion.md` | `610619845bf079289a094fddc6d5f62c4e505769377485ee0031b03b6a723e00` | معدل — diff أعلاه |
| `scripts/d1-verify.mjs` | `5765f8c992d248add6b730e24daf961cee08beb3f99ec3e5ba3ce6d5472bd722` | جديد — v2.7 مع A/B/C |
| `test/d1-verify.test.js` | `c09eb746b98585d689b4a558029af5238a83b625ae3e110468d6d05018d831e4` | جديد — 35 اختبار |
| `docs/EXTERNAL-INTEGRATION-APPROVAL.md` | `1d9912c7e5c198ff43ebc40d06cdad39d203fd8ff5aff4f4c77a518385473c4c` | جديد — بوابة E1…E6 |

**النسخة المختبرة = `f9bfa4e` + هذه الشجرة.** لا يجوز الاستشهاد بـ `f9bfa4e` منفردًا. أي إعادة تشغيل يجب أن تحسب هذه البصمات وتطابقها.

**التحقق المستقل:**
```sh
sha256sum docs/plan-system-completion.md scripts/d1-verify.mjs test/d1-verify.test.js docs/EXTERNAL-INTEGRATION-APPROVAL.md
git diff HEAD -- docs/plan-system-completion.md | sha256sum  # must = b05c6b08...
node --test test/d1-verify.test.js  # must 35/35
npm test                            # must 1401 pass / 0 fail / 17 skip
npm run check && npm run plan:check && npm run measure  # must PASS
```

---

## 2) أسباب الاختبارات الـ17 المتخطاة — بالأسماء لا بالعدد

`1 + 15 + 1 = 17` — جميعها **بوابات بيئية مسماة** يفشل `VER-06` إن وجد skip بلا اسم، ويفشل `VER-02` إن أعلن CI نجاحًا مع `gates skipped`.

| # | TAP id | اسم الاختبار كما يظهر في TAP | سبب التخطي (حرفيًا من `t.skip`) | الشرط لتشغيله |
|---|---|---|---|---|
| 1 | 48 | `ART-09 (real integration): actual namespaces sandbox output...` | `set CELIA_SANDBOX_INTEGRATION=1 on Linux to run` | Linux + `CELIA_SANDBOX_INTEGRATION=1` |
| 2 | 367 | `SBX-09 (REAL acceptance): the actual AGENT-003 executor computes the CSV sum...` | `set CELIA_SANDBOX_INTEGRATION=1 on Linux with user namespaces` | Linux user namespaces + `CELIA_SANDBOX_INTEGRATION=1` |
| 3 | 370 | `AGENT-003 creates/destroys a non-root run and exports one hashed artifact` | نفسه | نفسه |
| 4 | 371 | `AGENT-003 denies and records an external network probe` | نفسه | نفسه |
| 5 | 372 | `AGENT-003 cannot reach a real host TCP service...` | نفسه | نفسه |
| 6 | 373 | `AGENT-003 wall timeout kills the process group...` | نفسه | نفسه |
| 7 | 374 | `AGENT-003 kills leftover descendants before exporting artifacts` | نفسه | نفسه |
| 8 | 375 | `AGENT-003 CPU limit is BLOCK, not a normal task failure` | نفسه | نفسه |
| 9 | 376 | `AGENT-003 memory limit is BLOCK and no artifact escapes` | نفسه | نفسه |
| 10 | 377 | `AGENT-003 total workspace tmpfs quota is enforced...` | نفسه | نفسه |
| 11 | 378 | `AGENT-003 concurrency circuit breaker refuses work...` | نفسه | نفسه |
| 12 | 379 | `AGENT-003 refuses multiple or non-regular artifacts` | نفسه | نفسه |
| 13 | 380 | `AGENT-003 task cannot change policy, regain root, or read inherited secrets` | نفسه | نفسه |
| 14 | 381 | `AGENT-003 sandbox and artifact events join the verified Evidence chain` | نفسه | نفسه |
| 15 | 383 | `AGENT-003 durable run claims refuse replay across executor instances` | نفسه | نفسه |
| 16 | 384 | `AGENT-003 expired artifact references are denied` | نفسه | نفسه |
| 17 | 1199 | `MCP_TOOLS preserves strict N/N-1 backward compatibility...` | `shallow clone: baseline commit 2508893 is not present locally` | clone كامل يحوي `2508893` |

**دليل TAP:**
```
ok 48  - ART-09 ... # SKIP set CELIA_SANDBOX_INTEGRATION=1 on Linux to run
ok 367 - SBX-09 ... # SKIP set CELIA_SANDBOX_INTEGRATION=1 on Linux with user namespaces
ok 370-384 (15) نفس السبب
ok 1199 ... # SKIP shallow clone: baseline commit 2508893 is not present locally
# tests 1418 · pass 1401 · fail 0 · skipped 17 · todo 0
```

لا يوجد `unknown skip` — `VER-02` و`VER-06` تمر.

---

## 3) طلب الموافقة — القالب المحدد لا العام

> **لا يوجد إذن ضمني لفتح E1.** كل انتقال يحتاج موافقة صريحة وحدها. `القراءة ⇏ التصدير ⇏ الاستعادة ⇏ الكتابة إلى WORM`.

طلب الموافقة يجب أن يملأ الحقول التالية **بقيم فعلية** — الأسرار لا تُكتب:

| الحقل | المثال/الصيغة | يملأه المالك | ملاحظة |
|---|---|---|---|
| **Cloudflare Account ID** | `abc123...` (hex 32) | ☐ | لا يُستنتج من البيئة |
| **Cloudflare Database ID** | `f63ccd9f-49b1-4eca-861b-fd478c433518` (لـ `celia-edge-state`) — يعاد التحقق عبر `GET` وأن `version=production` | ☐ | أي DB أخرى = مرفوض |
| **AWS Bucket** | `celia-d1-anchors` + `region` (مثال `eu-west-1`) — مفعل `Object Lock Compliance` | ☐ | لا Bucket بلا Lock |
| **Storage Prefix** | `anchors/` — كل Anchor `anchors/000000000000000N.json` | ☐ | لا wildcards، لا `latest.json` كمصدر حقيقة |
| **Maintenance Window** | `2026-11-07T02:00 — 02:30 Asia/Jerusalem` (30 دقيقة، `writesPaused+cronPaused+drained` قبل `E3`) | ☐ | خارجها = `INCOMPLETE` |
| **Permissions Cloudflare** | `D1 Read` فقط — `D1 Write` فقط إن أثبت probe تجريبي حاجته | ☐ | لا ترقية تلقائية |
| **Permissions AWS IAM** | `s3:PutObject, GetObject, GetObjectRetention, ListBucketVersions` على `anchors/*` فقط — **دون Delete** | ☐ | |
| **Retention** | `COMPLIANCE 365 يوم — RetainUntilDate=...` | ☐ | لا `GOVERNANCE` |
| **Cost limit** | `S3 < $0.01 + Cloudflare ضمن الحدود — حد مقبول $X` | ☐ | |
| **Recovery site** | `/tmp/restore-isolated` على وسيط مشفّر مثبت (`cryptsetup status` / `manage-bde` / `fdesetup`) | ☐ | لا إنتاج |
| **Stop Conditions** | `writesPaused!=true` / `swap unencrypted` / `signed_url logged` / `B1!=B2` / `GCM fail` ⇒ إيقاف فوري | ☐ | موثقة في `EXTERNAL-INTEGRATION-APPROVAL.md §4` |
| **أسرار (لا تُكتب)** | `CLOUDFLARE_API_TOKEN, AWS keys, BACKUP_ENCRYPTION_KEY, ANCHOR_SIGNING_KEY` في مدير أسرار | — | لا في Git/محادثة/سجل |

**تعبئة القالب = طلب واحد.** لا يجمع `E1+E3+E5` في إذن واحد إلا بذكر كل حقل.

---

## 4) بوابة القرار — الحالي والمستهدف

| المرحلة | الحالة | شرط الانتقال |
|---|---|---|
| E1 Database Metadata | `WAITING FOR APPROVAL` | الحقول أعلاه + `maintenance window` موقعة |
| E2 Time Travel Bookmark | `WAITING FOR APPROVAL` | نجاح E1 + `B1==B2` |
| E3 D1 Export & Polling | `CLOSED` | `E2` ناجح + كتابات متوقفة — لا probe خارج Probe DB دون موافقة |
| E4 Encrypted Download | `CLOSED` | `E3` ناجح + `signed_url` stream مشفر — لا تخزين مكشوف |
| E5 WORM Anchor | `CLOSED` | `E4` ناجح + `If-None-Match:*` + `COMPLIANCE` |
| E6 Independent Recovery | `CLOSED` | `E5` ناجح + `restore.db` على وسيط مشفّر + `Fingerprint` مطابق |

**الحالي:** `SIMULATED_PASS` — `35/35` و`1401/0/17` — `NETWORK=DENY` — `IDEA-001` مجمدة — لا Push/PR
**المستهدف:** `VERIFIED = Real D1 Export + Encrypted Backup + WORM Anchor + Independent Recovery + Historical Integrity`

**المبدأ:** `التصريح بالقراءة لا يعني التصريح بالتصدير، والتصريح بالتصدير لا يعني التصريح بالاستعادة أو الكتابة إلى WORM.` كل مرحلة دليلها مستقل.

---

## 5) كيف يعيد مدقق مستقل الحساب

```sh
git rev-parse HEAD                          # f9bfa4e4...
sha256sum docs/plan-system-completion.md scripts/d1-verify.mjs test/d1-verify.test.js docs/EXTERNAL-INTEGRATION-APPROVAL.md
git diff HEAD | sha256sum                   # b05c6b08...
node --test test/d1-verify.test.js          # 35/35
npm test                                    # 1401/0/17 — غياب 17 بالأسماء أعلاه
npm run check && npm run plan:check && npm run measure  # PASS
grep -rn "signed_url" scripts/d1-verify.mjs # لا كتابة signé في السجل
```

هذا التقرير وحده يربط الحكم بالشجرة الفعلية المختبرة.
