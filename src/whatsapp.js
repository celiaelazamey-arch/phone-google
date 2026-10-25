import express from 'express';
import { requireApiToken } from './auth.js';
import { generateWhatsAppReply } from './gemini.js';
import { isValidE164, isWithinCustomerWindow, safeEqual, verifyWhatsAppSignature } from './security.js';

function extractInboundMessages(payload) {
  const messages = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const message of change?.value?.messages || []) {
        messages.push({
          id: String(message.id || ''),
          from: message.from ? `+${String(message.from).replace(/^\+/, '')}` : '',
          type: String(message.type || 'unknown').slice(0, 32),
          body: message.text?.body ? String(message.text.body).slice(0, 4000) : null
        });
      }
    }
  }
  return messages.filter((message) => message.id && isValidE164(message.from));
}

export async function sendWhatsAppText({ config, phone, text }) {
  const wa = config.whatsapp;
  if (!wa.accessToken || !wa.phoneNumberId || !wa.apiVersion) throw new Error('WhatsApp sending is not configured');
  if (!isValidE164(phone)) throw new Error('Recipient must be a valid E.164 phone number');
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Message must contain 1–4096 characters');
  const doFetch = config.demo?.fetchImpl || globalThis.fetch;
  const response = await doFetch(`https://graph.facebook.com/${encodeURIComponent(wa.apiVersion)}/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${wa.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.slice(1), type: 'text', text: { preview_url: false, body: text.trim() } })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WhatsApp API rejected the message (${response.status})`);
  return result.messages?.[0]?.id || '';
}

export function createWhatsAppWebhookRouter({ pool, config }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (config.whatsapp.verifyToken && mode === 'subscribe' && typeof token === 'string' && safeEqual(token, config.whatsapp.verifyToken)) {
      return res.status(200).send(String(challenge || ''));
    }
    return res.sendStatus(403);
  });

  router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!verifyWhatsAppSignature(req.body, req.get('x-hub-signature-256'), config.whatsapp.appSecret)) return res.sendStatus(401);
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); }
    catch { return res.sendStatus(400); }

    try {
      for (const message of extractInboundMessages(payload)) {
        const [insert] = await pool.execute(
          'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
          [message.id, message.from, 'inbound', message.type, message.body, 'received']
        );
        // Meta can retry webhook deliveries; only process each provider message once.
        if (!insert.affectedRows) continue;
        await pool.execute(
          `INSERT INTO whatsapp_contacts (phone_e164, last_inbound_at) VALUES (?, UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE last_inbound_at = UTC_TIMESTAMP()`,
          [message.from]
        );
        if (config.whatsapp.autoReplyEnabled && message.body) {
          const [rows] = await pool.execute('SELECT opted_in, ai_opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ?', [message.from]);
          const contact = rows[0];
          if (contact?.opted_in && contact?.ai_opted_in && isWithinCustomerWindow(contact.last_inbound_at)) {
            try {
              const reply = await generateWhatsAppReply({ config, customerMessage: message.body });
              const providerId = await sendWhatsAppText({ config, phone: message.from, text: reply });
              if (providerId) await pool.execute(
                'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
                [providerId, message.from, 'outbound', 'text', reply.slice(0, 4000), 'sent']
              );
            } catch (error) {
              console.error('WhatsApp auto-reply failed:', error.message);
            }
          }
        }
      }
      return res.sendStatus(200);
    } catch (error) {
      console.error('WhatsApp webhook processing failed:', error.message);
      return res.sendStatus(500);
    }
  });

  return router;
}

export function createWhatsAppApiRouter({ pool, config }) {
  const router = express.Router();
  router.use('/api', requireApiToken(config));

  router.post('/api/whatsapp/contacts/:phone/consent', async (req, res) => {
    const phone = `+${String(req.params.phone).replace(/^\+/, '')}`;
    const optedIn = req.body?.optedIn;
    const aiOptedIn = req.body?.aiOptedIn === true;
    const source = typeof req.body?.source === 'string' ? req.body.source.trim().slice(0, 128) : '';
    if (!isValidE164(phone) || typeof optedIn !== 'boolean' || (optedIn && !source) || (aiOptedIn && !optedIn)) return res.status(400).json({ error: 'valid_phone_optedIn_and_consent_source_required' });
    try {
      await pool.execute(
        `INSERT INTO whatsapp_contacts (phone_e164, opted_in, ai_opted_in, consent_source, consented_at)
         VALUES (?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL))
         ON DUPLICATE KEY UPDATE opted_in = VALUES(opted_in), ai_opted_in = VALUES(ai_opted_in), consent_source = VALUES(consent_source), consented_at = VALUES(consented_at)`,
        [phone, optedIn, optedIn && aiOptedIn, optedIn ? source : null, optedIn]
      );
      return res.json({ phone, optedIn, aiOptedIn: optedIn && aiOptedIn });
    } catch (error) {
      console.error('Could not update WhatsApp consent:', error.message);
      return res.status(500).json({ error: 'consent_update_failed' });
    }
  });

  router.post('/api/whatsapp/messages', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? (req.body.phone.startsWith('+') ? req.body.phone : `+${req.body.phone}`) : '';
    const text = req.body?.text;
    if (!isValidE164(phone) || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'valid_phone_and_text_required' });
    try {
      const [rows] = await pool.execute('SELECT opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ?', [phone]);
      const contact = rows[0];
      if (!contact?.opted_in) return res.status(403).json({ error: 'recipient_has_not_opted_in' });
      if (!isWithinCustomerWindow(contact.last_inbound_at)) return res.status(403).json({ error: 'outside_customer_service_window_use_approved_template' });
      const providerId = await sendWhatsAppText({ config, phone, text });
      if (providerId) await pool.execute(
        'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
        [providerId, phone, 'outbound', 'text', text.trim().slice(0, 4000), 'sent']
      );
      return res.status(202).json({ status: 'accepted', providerMessageId: providerId });
    } catch (error) {
      console.error('WhatsApp send failed:', error.message);
      return res.status(502).json({ error: 'whatsapp_send_failed' });
    }
  });

  return router;
}
