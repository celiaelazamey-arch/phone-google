import crypto from 'node:crypto';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireApiToken } from './auth.js';
import { ensureOwner } from './db.js';
import { encryptJson, isValidE164 } from './security.js';

const DEFAULT_PHONE = '+14155552671';
const DEFAULT_TEXT = 'مرحبًا، ما هي مواعيد العمل لديكم؟';

function normalizePhone(value) {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_PHONE;
  const trimmed = value.trim();
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

export async function createDemoRouter({ pool, config, outbox }) {
  const template = await readFile(new URL('../public/demo.html', import.meta.url), 'utf8');
  const page = template.replaceAll('__DEMO_TOKEN__', config.apiToken);
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));

  const router = express.Router();
  const auth = requireApiToken(config);

  router.get('/', (_req, res) => res.type('html').send(page));
  router.use('/demo/static', express.static(publicDir, { index: false }));
  router.use('/demo', express.json({ limit: '256kb' }));

  router.get('/demo/state', auth, (_req, res) => res.json({
    mode: 'demo',
    ...pool.snapshot(),
    autoReplyEnabled: config.whatsapp.autoReplyEnabled,
    outbox: outbox.slice(-20).reverse(),
    providers: {
      google: 'offline mock',
      gemini: 'offline mock',
      whatsapp: 'offline mock',
      database: 'in-memory'
    }
  }));

  router.post('/demo/google/connect', auth, async (_req, res) => {
    const tokens = {
      access_token: 'demo-access-token',
      refresh_token: 'demo-refresh-token',
      token_type: 'Bearer',
      scope: 'openid email gmail.readonly drive.readonly calendar.events contacts.readonly',
      expiry_date: Date.now() + 3600_000
    };
    await pool.execute(
      `INSERT INTO google_credentials (user_id, encrypted_tokens, scopes) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE encrypted_tokens = VALUES(encrypted_tokens), scopes = VALUES(scopes)`,
      [config.userId, encryptJson(tokens, config.encryptionKey), tokens.scope]
    );
    return res.json({ connected: true, encrypted: true, note: 'رموز تجريبية مشفّرة AES-256-GCM في الذاكرة فقط.' });
  });

  router.post('/demo/google/disconnect', auth, (_req, res) => {
    pool.disconnectGoogle();
    return res.json({ connected: false });
  });

  router.post('/demo/reset', auth, async (_req, res) => {
    pool.reset();
    outbox.length = 0;
    await ensureOwner(pool, config);
    return res.json({ reset: true });
  });

  // Signs a Meta-shaped payload exactly like a real delivery, then POSTs it to
  // the REAL /webhooks/whatsapp route so HMAC verification is genuinely tested.
  router.post('/demo/webhook/inbound', auth, async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const text = typeof req.body?.text === 'string' && req.body.text.trim() ? req.body.text.trim().slice(0, 4000) : DEFAULT_TEXT;
    const badSignature = req.body?.badSignature === true;
    const suppliedId = req.body?.messageId;
    const messageId = typeof suppliedId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(suppliedId)
      ? suppliedId
      : `wamid.in.${crypto.randomBytes(6).toString('hex')}`;
    if (!isValidE164(phone)) return res.status(400).json({ error: 'invalid_phone' });

    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'demo-waba',
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: config.whatsapp.phoneNumberId },
            messages: [{ id: messageId, from: phone.slice(1), type: 'text', text: { body: text } }]
          }
        }]
      }]
    });
    const signature = badSignature
      ? `sha256=${'0'.repeat(64)}`
      : `sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(Buffer.from(raw)).digest('hex')}`;

    try {
      const origin = config.demo.localOrigin || `http://127.0.0.1:${config.port}`;
      const upstream = await fetch(new URL('/webhooks/whatsapp', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body: raw
      });
      return res.json({
        status: upstream.status,
        accepted: upstream.status === 200,
        messageId,
        replyCount: outbox.length,
        latestReply: outbox.at(-1) || null
      });
    } catch (error) {
      return res.status(502).json({ error: 'demo_webhook_failed', detail: error.message });
    }
  });

  return router;
}
