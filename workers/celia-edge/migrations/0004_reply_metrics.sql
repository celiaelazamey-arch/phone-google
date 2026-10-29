-- WP-1.4 (DEC-050): قياس الردود المقصوصة قبل أي تغيير في maxOutputTokens.
-- صف لكل رد مولَّد (عبر الويبهوك أو /api/ai/reply) مرتبط برسالة WhatsApp الصادرة بمعرّفها؛ لا نص ولا رقم هاتف هنا —
-- أعداد وأسباب فقط. كل عبارة idempotent لأن النشر يعيد تطبيق كل الترحيلات في كل مرة.
CREATE TABLE IF NOT EXISTS whatsapp_reply_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_message_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  finish_reason TEXT,
  candidate_chars INTEGER NOT NULL,
  sent_chars INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  truncation_reason TEXT,
  max_output_tokens INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_reply_metrics_created ON whatsapp_reply_metrics (created_at);
