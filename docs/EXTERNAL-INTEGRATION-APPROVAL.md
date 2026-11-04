# بوابة اعتماد التكامل الخارجي — D1 Backup & Recovery
## External Integration Approval Gate — من SIMULATED_PASS إلى VERIFIED

> **الفرع:** `arena/241c4e6f-phone-google` @ `f9bfa4e` (مطابق لـ `origin/main` الحي)
> **الحالة الحالية:** `LOCAL PASS — SIMULATED_PASS (35/35 d1-verify, 1401/1418 كامل, 0 فشل, 17 متخطى, 0 اتصال خارجي)`
> **الحالة المطلوبة للتكامل الخارجي:** `VERIFIED = Real D1 Export + Encrypted Backup + WORM Anchor + Independent Recovery + Historical Integrity`
> **الشبكة:** `NETWORK=DENY` حتى اعتماد هذه الوثيقة بموافقة صريحة وموثقة
> **المرجع:** `DESIGN v2.7 FINAL SIGN-OFF` + التنفيذ المحلي `scripts/d1-verify.mjs` + `test/d1-verify.test.js`

**القاعدة الذهبية:** لا يعلن النظام `VERIFIED` شامل إلا بدليل يعيد طرف مستقل حسابه دون الثقة بنتائج مهمة النسخ نفسها. لا يجوز تحويل `SIMULATED_PASS` إلى `VERIFIED`.

---

## 1) Prerequisites — ثلاثة شروط قبل فتح البوابة

### P1 — تحديد الموارد المسموحة بدقة (لا wildcards)

| المورد | القيمة المسموحة | ممنوع |
|---|---|---|
| **Cloudflare D1 Database** | `celia-edge-state` (`f63ccd9f-49b1-4eca-861b-fd478c433518` — يُعاد التحقق عبر `GET /accounts/{account_id}/d1/database/{database_id}` وأن `version=production`) | أي قاعدة أخرى، أو `alpha` دون مسار بديل موثق |
| **S3 Bucket للـ Anchor** | `celia-d1-anchors` (مثال — يحدده المالك) — Region يحدد صراحةً | أي Bucket آخر، أو Bucket بلا `Object Lock Compliance` مفعل |
| **Prefix** | `anchors/` فقط — كل Anchor `anchors/0000000000000001.json` (16 رقم) | أي prefix آخر، أو `latest.json` قابل للاستبدال كمصدر حقيقة |
| **Cloudflare Account** | يُحدد `account_id` صراحةً في الوثيقة — لا افتراض من البيئة | حساب آخر |

**الإجراء:** يوثق المالك القيم الثلاث في هذه الوثيقة بتوقيعه قبل أي أمر خارجي. أي مورد غير مذكور = ممنوع.

### P2 — نافذة الصيانة — لأن تصدير D1 يمنع الاستعلامات

- تصدير D1 عبر `POST /export` قد يجعل القاعدة **غير متاحة للاستعلامات** أثناء العملية، ويُلغى تلقائيًا إن توقفت المتابعة (Cloudflare docs).
- **الشرط:** `maintenanceWindow.approved == true` مربوط بتفعيل فعلي:
  ```
  maintenanceMode: {
    writesPaused: true,        // إيقاف كل كتابات edge_state / edge_audit / google_credentials
    cronPaused: true,          // إيقاف المهام المجدولة (cron)
    inFlightDrained: true,     // تصريف العمليات الجارية
    approvedBy: "owner@...",   // توقيع/توثيق
    window: "2026-11-06T02:00Z/02:30Z"
  }
  ```
- لا `Export` خارج النافذة — أي محاولة = `FAILED` و`INCOMPLETE`.

### P3 — صلاحيات الكتابة والاحتفاظ والتكلفة + أسرار خارج المستودع

| البند | المسموح | الممنوع | المصدر |
|---|---|---|---|
| **Cloudflare صلاحية** | `D1 Read` فقط للـ probe — `D1 Write` فقط إن ثبت أن `Export` يحتاجها على قاعدة probe تجريبية أولًا، وبموافقة صريحة | ترقية تلقائية دون probe | `GET Bookmark` لا يحتاج Write |
| **S3 صلاحية** | `s3:PutObject` + `s3:GetObject` + `s3:GetObjectRetention` + `s3:ListBucketVersions` على `anchors/*` فقط — **دون `s3:DeleteObject`** | `DeleteObject`, `PutBucketPolicy`, `BypassGovernanceRetention` | — |
| **الاحتفاظ** | `ObjectLockMode=COMPLIANCE`, `RetainUntilDate` محفوظ ومتحقق (`HeadObject`) — مدة يحددها المالك (مثلاً 1 سنة) | لا `GOVERNANCE` قابل للتجاوز | — |
| **التكلفة** | D1 Export مجاني ضمن حدود Cloudflare — S3 تخزين بضع KB — يوثق المالك التكلفة المتوقعة قبل التشغيل | أي تكلفة غير موثقة | — |
| **الأسرار** | `CLOUDFLARE_API_TOKEN` و`AWS credentials` و`BACKUP_ENCRYPTION_KEY` و`ANCHOR_SIGNING_PRIVATE_KEY` — **مخزنة خارج المستودع والمحادثة** (مدير أسرار/متغيرات بيئة موثقة) — لا تُكتب في Git أو في `Evidence Report` | تخزين سر في Git, في `manifest.json`, في سجل CI, أو تمريره كـ `signed_url` | — |

---

## 2) مصفوفة الاختبارات الخارجية — E1…E6

| المرحلة | الاختبار | العملية الفعلية | الصلاحية المطلوبة | الإخراج المتوقع | شرط التوقف |
|---|---|---|---|---|---|
| **E1** | Cloudflare Database Metadata | `GET /accounts/{id}/d1/database/{database_id}` → `result.version` | `D1 Read` | `version: production` (أو `alpha` بمسار بديل) | `version` غير متوقع ⇒ `INCOMPLETE` |
| **E2** | Time Travel Bookmark | `GET /accounts/{id}/d1/database/{database_id}/.../bookmark` → `result.bookmark` | `D1 Read` | `bookmark: "at_bookmark_..."` | غياب `bookmark` ⇒ `FAILED` |
| **E3** | D1 Export + Polling | `POST /export {output_format:polling, current_bookmark}` poll حتى `complete` | `D1 Read` (أو Write إن ثبت) | `result.at_bookmark` + `result.result.signed_url` (ساعة) | `success!=true` أو `status=error` أو انقطاع Poll ⇒ `FAILED` — لا متابعة بعد `maxAttempts` |
| **E4** | Download + AES-GCM | `GET signed_url → stream → AES-256-GCM` بـ `IV 12B, Tag 16B, AAD=RF8785(format,algorithm,encryptionKeyId,databaseId,exportBookmark,manifestVersion)` — **Stream مشفر بلا `database.sql` مكشوف** | لا صلاحية إضافية | `database.sql.enc` + `database.sha256` + `manifest.sha256` | أي فشل `GCM Tag` ⇒ `FAILED` |
| **E5** | WORM Anchor | `PUT anchors/000000000000000N.json` مع `If-None-Match:*`, `VersionId`, `COMPLIANCE` — السابق `previousAnchorHash` متصل | `s3:PutObject` على `anchors/*` | `VersionId` + `RetainUntilDate` | `ConditionalCheckFailed` على `ordinal` مكرر, أو `Delete Marker` حالي, أو إصدار بلا `COMPLIANCE` ⇒ `FAILED` |
| **E6** | Independent Recovery Verification | `Recovery Verifier` مستقل (مفتاح `Ed25519` منفصل) يفك `database.sql.enc` → `restore.db` على `tmpDir` مشفّر → `computeTableFingerprint` + `sqlite_sequence` + `encodeRow` مع `typeof()` | لا صلاحية سحابية — محلي على `tmpDir` مشفّر | `Recovery Attestation {backupSha,manifestSha,recoveryResult,verifierKeyId,sourceAnchorHash,anchorOrdinal}` | أي `tableHash` مختلف أو `sqlite_sequence` مختلف أو `GCM` فاشل ⇒ `FAILED` |

**المسار المعتمد الكامل:**
```
E1 (version) → E2 (B1) → Baseline Fingerprint → E2 (B2) Require B1==B2 → E3 (B3) Require B2==B3 → E4 (enc) → E5 (anchor) → E6 (recovery)
```
كل `B` هو `bookmark/at_bookmark` — فجوة ⇒ لا `VERIFIED` لنفس الحالة التاريخية.

---

## 3) العمليات المسموحة والممنوعة

### مسموح (ضمن النافذة وبعد اعتماد هذه الوثيقة)

- `GET Database` + `GET Bookmark` للقراءة فقط
- `POST Export` polling مع `current_bookmark` وتسجيل كل `Poll {at, bookmark, status, httpStatus}`
- `GET signed_url` كـ `stream` مشفر فورًا — لا حفظ `database.sql` مكشوف
- `PUT` Anchor واحد لكل `ordinal` بـ `If-None-Match:*`
- `GET` و`ListObjectVersions` للتحقق
- `PRAGMA integrity_check` و`foreign_key_check` محليًا على `restore.db`

### ممنوع (حتى مع الاعتماد)

- `wrangler d1 export` في مسار الإثبات (يسجل `signed_url` في السجل)
- `wrangler d1 time-travel restore` على `celia-edge-state` — ممنوع تمامًا
- أي `DELETE` على D1 أو S3 — `s3:DeleteObject` ممنوع، و`DELETE FROM edge_audit` ممنوع
- كتابة `signed_url` إلى `Evidence Report` أو CI log أو Telemetry
- إنشاء `latest.json` كمصدر حقيقة — الحقيقة = أحدث `VersionId` في `ListObjectVersions`
- استخدام `rm -rf tmpDir` كادعاء `Secure Erasure` — يُسجل `best_effort_not_proven`
- اعتبار `D1 Read ⇒ Export Allowed` دون probe على قاعدة تجريبية
- اعتبار `anchors.jsonl` المحلي مصدر حقيقة — المصدر = السجل الخارجي WORM
- إصدار `VERIFIED` شامل من تنفيذ محلي بلا `Real D1 Export + WORM`

---

## 4) شروط التوقف — إيقاف فوري

| الشرط | الإجراء |
|---|---|
| `maintenanceWindow.approved != true` أو الكتابات لم تتوقف | لا تبدأ `E3` — `INCOMPLETE` |
| `swap` نشط وغير مشفّر على Linux المضيف | `INCOMPLETE` — لا تغيّر حالة المضيف تلقائيًا (`swapoff -a` ممنوع دون موافقة) |
| `tmpDir` ليس على وسيط مشفّر مثبت (`cryptsetup status` / `manage-bde` / `fdesetup`+`diskutil`) | `INCOMPLETE` |
| `signed_url` ظهر في أي سجل | `FAILED` + تدوير فوري للرابط (ساعة) وتنظيف السجل |
| `conditional write` فشل على `ordinal` مكرر أو `Delete Marker` | `FAILED` — لا إعادة محاولة صامتة بـ ordinal آخر |
| `GCM Tag` فاشل أو `backupSha256` لا يطابق `manifest` | `FAILED` — لا `VERIFIED` |
| `B1 != B2` أو `B2 != B3` | `INCOMPLETE` — لا مقارنة بيانات على نقاط مختلفة |
| `integrity_check != "ok"` أو `foreign_key_check != 0` | `FAILED` |
| أي سر ظهر في `Evidence Report` | `FAILED` + تدوير السر |

---

## 5) توثيق الاختبارات الـ17 المتخطاة و git status

### 5.1 `git status` قبل الانتقال

```
 M docs/plan-system-completion.md          // إصلاح syntax_files 279→281 بعد إضافة d1-verify (مشتق، لا منطق)
?? scripts/d1-verify.mjs                  // تنفيذ محلي v2.7 — APPROVED LOCAL ONLY
?? test/d1-verify.test.js                 // 35 اختبار — 6 قبول + تصحيحات R1/R3/R4/R5
?? docs/EXTERNAL-INTEGRATION-APPROVAL.md  // هذه الوثيقة — بوابة التكامل الخارجي
Branch: arena/241c4e6f-phone-google @ f9bfa4e (مطابق لـ origin/main)
Pushed: لا — لا Push/PR قبل اعتماد هذه البوابة
```

### 5.2 الاختبارات الـ17 المتخطاة — ليست فشلًا، بل بوابات بيئية مسماة

كلها `t.skip` بشرط بيئة صريح — يفشل `VER-06` إن وُجد skip بلا اسم:

| # | الاختبار | السبب | الشرط |
|---|---|---|---|
| 1 | `ART-09 (real integration)` | يحتاج `node:sqlite` + ترجمة حقيقية | `CELIA_SANDBOX_INTEGRATION=1` على Linux |
| 2-16 | `AGENT-003` ×15 (SBX-09, 370-381, 383-384) | يحتاج `user namespaces` + `cgroup` + `tmpfs` | `CELIA_SANDBOX_INTEGRATION=1` على Linux مع `user namespaces` |
| 17 | `MCP_TOOLS shallow clone` | يحتاج baseline commit غير موجود في shallow clone | `baseline 2508893` غير حاضر محليًا |

**التحقق:** `npm test` يطبع `17 skipped` — و`VER-02/VER-06` يفشلان إن كان هناك `skip` مجهول أو `CI` يعلن نجاحًا مع بوابات متخطاة. لا يُحتسب `skipped` كـ `pass`.

---

## 6) معيار النجاح للتكامل الخارجي — لا `VERIFIED` إلا بـ

```
Real D1 Export (E3, bookmark ثابت, polling مستمر, ساعة صلاحية)
       +
Encrypted Backup (E4, AES-256-GCM, IV12/Tag16/AAD بلا دائرة, بلا signed_url مُسجل)
       +
WORM Anchor (E5, ordinal واحد لكل مفتاح, If-None-Match:*, COMPLIANCE, Delete Marker مفحوص)
       +
Independent Recovery (E6, فك + restore.db على tmp مشفّر + fingerprint حتمي)
       +
Historical Integrity (مرجع خارجي WORM + previousAnchorHash + RFC8785 + bootstrap موقّع)
       =
VERIFIED
```

نقص واحد ⇒ `INCOMPLETE` (دليل غير كافٍ) أو `FAILED` (دليل مكسور) — لا `SIMULATED_PASS` يُرفع.

---

## 7) أسرار خارج المستودع والمحادثة

- `CLOUDFLARE_API_TOKEN` (بصلاحية `D1 Read` فقط كبداية)
- `AWS_ACCESS_KEY_ID / SECRET` للـ `Bucket` المحدد فقط
- `BACKUP_ENCRYPTION_KEY` (32B base64 — AES-256)
- `ANCHOR_SIGNING_PRIVATE_KEY` (Ed25519 — خارج مهمة النسخ)
- `BACKUP_KEY_VAULT` للمفاتيح المغلفة (`wrappedKey` لا خام)

كلها في مدير أسرار/متغيرات بيئة — لا في Git, لا في `manifest.json`, لا في سجل CI.

---

## 8) الموافقة

- [ ] **المالك يحدد** `databaseId` + `Bucket` + `Prefix` + `Account` أعلاه
- [ ] **المالك يحدد** `maintenance window` (تاريخ/مدة/من يوافق)
- [ ] **المالك يحدد** `صلاحيات/احتفاظ/تكلفة` ويوافق على الأسرار خارج المستودع
- [ ] **المالك يوقّع** هذه الوثيقة — بعدها فقط يُفتح `NETWORK` لمرحلة `E1…E6` بطلب منفصل

**بدون التوقيع:** `NETWORK=DENY`, `IDEA-001` مجمدة, لا `Push/PR`, والحكم يبقى `SIMULATED_PASS`.

---

*هذه الوثيقة بوابة، لا تنفيذ. عند اعتمادها، يبدأ التنفيذ الخارجي بطلب منفصل يذكر `databaseId/Bucket/Prefix` والنافذة والصلاحيات كمرجع.*
