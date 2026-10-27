# Celia Google Spider — موصل Google Drive إلى الشبكة الذكية

**الإصدار 0.1.0 — بتاريخ 2026-10-27**

محلي وقراءة فقط. يستخرج النصوص المفيدة من Google Drive، ويبني شبكة معرفة
قابلة للبحث والاستكشاف داخل جهازك، ثم يقدّمها كأدوات MCP لـ Claude Desktop
وClaude Code وأي عميل MCP يدعم stdio.

تم بناؤه كحزمة مستقلة داخل مستودع `phone-google` في المسار
`celia-google-spider/`، ويمكن نسخه منها إلى موقع آخر أو حزمته ZIP منفصلاً.

## الوظائف (الحدود الواضحة)

- **قراءة فقط**: مفتاح OAuth scopes المطلوب `drive.readonly` فقط، وهو
  `.../auth/drive.readonly`. لا يكتب ولا يحذف ولا ينقل أي ملف في Drive.
- **الاستخراج**: نص عادي، Markdown، CSV، JSON، YAML، مستندات Google Docs
  (تصدير plain text)، وأول ورقة في أول Google Sheet فقط (تصدير CSV).
  غير ذلك يُتخطّى ويُسجّل سببه في نتيجة المزامنة.
- **البحث**: معجمي (تطبيع عربي/إنجليزي + مطابقة كلمات)، مع مقتطف من
  النص الأصلي ورابط المصدر لكل نتيجة. **لا يوجد embeddings ولا بحث دلالي**
  في الإصدار الحالي.
- **شبكة المعرفة**: مستند ↔ مصطلح ↔ مستند، مع استكشاف المستندات المتصلة
  ودرجات الترابط.
- **عدم الحذف التلقائي**: أي عنصر مفهرس محلياً لا يُحذف أبداً إذا اختفى
  من Drive؛ تبقى نسخته المحلية كما هي (التزام صريح في بنية الفهرس).
- **حد المزامنة**: `max_files` افتراضي 2000 ملفاً في كل عملية مزامنة.
- **بدون أي اتصال شبكة للفهرس**: كل شيء محلي في
  `~/.celia_spider/knowledge.sqlite3` (يُعاد تحديده عبر
  `CELIA_SPIDER_DATA_DIR`)، ولا يُفتح أي منفذ: خادم MCP يعمل عبر stdio فقط.

### لماذا ليس موصلاً داخل ChatGPT؟

موصل ChatGPT MCP الخارجي يتطلب خطة ChatGPT مدفوعة وبعيدة (remote/tunnel)؛
هذه النسخة ليست جزءاً من هذه الوثيقة، ولا تصل إلى ChatGPT بأي شكل.
الاستخدام المقصود: عملاء MCP المحليون (Claude Desktop / Claude Code …)
عبر stdio، أو أي عميل يشغّل الأمر محلياً بنفس الطريقة.

## بنية الحزمة

| المسار | الدور |
|---|---|
| `celia_spider/config.py` | إعدادات المسارات والحدود (بيئة `CELIA_SPIDER_*`) |
| `celia_spider/text_utils.py` | تطبيع وtokenization عربي/إنجليزي |
| `celia_spider/store.py` | فهرس SQLite + شبكة مستند↔مصطلح + بحث |
| `celia_spider/google_drive.py` | استخراج/تصدير الملفات وعمليات المزامنة |
| `celia_spider/auth.py` | OAuth محلي (token.json بمفاتيح 0600) |
| `celia_spider/check.py` | فحص جاهزية محلي (JSON report) |
| `celia_spider/server.py` | خادم MCP عبر stdio + الأدوات الست |
| `tests/` | اختبارات محلية (unittest + pytest) |
| `install_windows.bat` / `run_server.bat` | إعداد وتشغيل على Windows |

الأدوات الست المكشوفة عبر MCP:

1. `spider_sync_google_drive` — مزامنة Drive إلى الفهرس المحلي (بدون حذف).
2. `spider_search_knowledge` — بحث معجمي مع مقتطف ومصدر.
3. `spider_read_document` — قراءة مستند مفهرس بالكامل.
4. `spider_explore_network` — استكشاف شبكة المستند↔مصطلح↔مستند.
5. `spider_list_sources` — عرض المصادر وروابط Drive.
6. `spider_graph_stats` — إحصاءات الشبكة وحجم الفهرس.

## الإعداد على Windows

1. ثبّت Python 3.11 أو أحدث، ثم شغّل `install_windows.bat` (ينشئ
   `.venv` ويثبّت الاعتمادات).
2. أنشئ مشروع OAuth خاص (Desktop app) في Google Cloud، وفعّل Google Drive
   API، ثم ضع الملف في:
   `celia-google-spider\credentials.json` — **ملف المصداقية لا يُرفع إلى
   Git أبداً** (مُدرج في `.gitignore`).
3. شغّل المصادقة لمرة واحدة:
   `.venv\Scripts\python.exe -m celia_spider.auth` — يفتح المتصفح ويكتب
   `token.json` محلياً (0600). ملف التوكن لا يُرفع إلى Git أبداً.
4. شغّل خادم MCP: `run_server.bat` (أو
   `.venv\Scripts\python.exe -m celia_spider.server`).
5. سجّل الخادم عند عميلك، مثال لإعداد `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "celia-google-spider": {
         "command": "C:\\path\\to\\celia-google-spider\\.venv\\Scripts\\python.exe",
         "args": ["-m", "celia_spider.server"],
         "cwd": "C:\\path\\to\\celia-google-spider"
       }
     }
   }
   ```

6. فحص الجاهزية (اختياري):
   `.venv\Scripts\python.exe -m celia_spider.check --report`

على Linux/macOS استعمل `.venv/bin/python` بنفس الأوامر.

## الاختبارات

من داخل `celia-google-spider/`:

```bash
python -m unittest discover -s tests -v   # ناجحة 10/10
pytest -q                                 # 10 passed
python -m compileall -q celia_spider      # سلامة صياغة Python
python -m celia_spider.check --report     # فحص محلي JSON
```

تشمل الاختبارات مصافحة MCP حقيقية عبر stdio وإظهار الأدوات الست بالضبط.
بيئة التطوير الحالية: Python 3.11، حزمة MCP 2.x، **بدون بيانات اعتماد
Google** — لذلك لم تُجرَ مزامنة فعلية ضد Drive هنا؛ المزامنة تُختبر عندك
بعد وضع `credentials.json`.

## حدود معروفة

- بدون `credentials.json` من مشروع OAuth خاص ترفض خدمة Google API ذلك
  (وهو مقصود؛ مفاتيح OAuth ليست سراً، لكنها لا تُوضع في Git).
- فهرس محلي واحد لكل مجلد بيانات؛ لا تزامن تلقائي مجدول بعد (شغّل
  `spider_sync_google_drive` يدوياً أو من عميلك).
- فحص `check --live` يتطلب اتصالاً حقيقياً بـ Drive (تخطّيه عند الغياب).
- الملفات المخزنة (Google Docs/Sheets) تُصدَّر عبر Drive API؛ التصدير كبير
  الحجم (>10MB) يُتخطّى ويُسجّل.

## المراجع

- [Google Drive API — Python quickstart](https://developers.google.com/workspace/drive/api/quickstart/python)
- [Google Drive API — REST v3 reference (files)](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Google Drive API — download and export files](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive API — quotas and limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Model Context Protocol — Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [OpenAI — Connect custom MCP in ChatGPT](https://help.openai.com/en/articles/11369540-connecting-to-remote-mcp-servers-in-chatgpt)

## الترخيص

MIT — راجع [LICENSE](LICENSE).
