import express from 'express';
import { requireApiToken } from './auth.js';
import { generateCeliaReply } from './ollama.js';
import { createServiceRegistry, safeError, ServiceUnavailableError, UpstreamError } from './resilience.js';
import { isValidE164, isWithinCustomerWindow, safeEqual, verifyWhatsAppSignature } from './security.js';
import { createIdempotencyStore, isValidIdempotencyKey } from './idempotency.js';
import { createGoogleConsentLink, fetchInboxMessages, listAgendaEvents } from './google.js';
import { agendaRange, formatAgendaReply, formatInboxReply, ownerGoogleErrorReply, parseOwnerGoogleCommand } from './owner-google-commands.js';

/**
 * Owner-only chat command: "اربط جوجل" / "connect google".
 * Matched narrowly so a customer message can never trigger a connection link, and the caller
 * still has to prove the sender is APP_OWNER_PHONE_E164 before anything is minted.
 */
export function isGoogleConnectCommand(body) {
  const text = String(body || '').trim();
  if (!text || text.length > 64) return false;
  return /^(?:اربط|ربط|وصل|وصّل)\s+(?:لي\s+)?(?:حسابي\s+)?(?:جوجل|قوقل|google)(?:\s+الآن)?$/i.test(text)
    || /^(?:connect|link)\s+(?:my\s+)?google(?:\s+account)?(?:\s+now)?$/i.test(text);
}

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

export async function sendWhatsAppText({ config, phone, text, signal, timeoutMs = 8000 }) {
  const wa = config.whatsapp;
  if (config.features?.whatsapp === false) throw new ServiceUnavailableError('whatsapp', 'disabled');
  if (!wa.accessToken || !wa.phoneNumberId || !wa.apiVersion) throw Object.assign(new Error('whatsapp_not_configured'), { status: 400 });
  if (!isValidE164(phone)) throw new Error('Recipient must be a valid E.164 phone number');
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Message must contain 1–4096 characters');
  const response = await fetch(`https://graph.facebook.com/${encodeURIComponent(wa.apiVersion)}/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
    method: 'POST',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${wa.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.slice(1), type: 'text', text: { preview_url: false, body: text.trim() } })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new UpstreamError('whatsapp', response.status);
  return result.messages?.[0]?.id || '';
}

/**
 * Executes one parsed owner command against Google and returns the WhatsApp reply text.
 * `googleOps` is injectable for tests; defaults to the real Gmail/Calendar fetchers.
 */
export async function runOwnerGoogleCommand({ pool, config, command, now = new Date(), signal, googleOps = { fetchInboxMessages, listAgendaEvents } }) {
  const timeZone = config.timezone || 'Africa/Cairo';
  try {
    if (command.kind === 'latest_email') {
      const messages = await googleOps.fetchInboxMessages({ pool, config, unreadOnly: command.unreadOnly, maxResults: command.unreadOnly ? 5 : 1, signal });
      let fallback = null;
      if (command.unreadOnly && !messages.length) {
        fallback = (await googleOps.fetchInboxMessages({ pool, config, unreadOnly: false, maxResults: 1, signal }))[0] || null;
      }
      return formatInboxReply({ unreadOnly: command.unreadOnly, messages, fallback, timeZone });
    }
    if (command.kind === 'agenda') {
      const range = agendaRange(command.range, { now, timeZone });
      const events = await googleOps.listAgendaEvents({ pool, config, timeMin: range.timeMin, timeMax: range.timeMax, signal });
      return formatAgendaReply({ range: command.range, events, label: range.label, timeZone });
    }
    throw Object.assign(new Error('unknown_owner_command'), { status: 400 });
  } catch (error) {
    console.error('WhatsApp owner Google command failed:', error.code || error.status || 'google_command_failed');
    return ownerGoogleErrorReply(error);
  }
}

export function createWhatsAppWebhookRouter({ pool, config, services = createServiceRegistry(config), googleOps }) {
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
        // Owner-only Google connection command: replies with a single-use link instead of an AI answer.
        if (message.body && config.ownerPhone && message.from === config.ownerPhone && isGoogleConnectCommand(message.body)) {
          try {
            const link = await createGoogleConsentLink({ pool, config });
            const reply = `رابط ربط حساب Google (صالح حتى ${link.expiresAt}، ويعمل مرة واحدة):\n${link.url}`;
            const providerId = await services.run('whatsapp', (signal) => sendWhatsAppText({ config, phone: message.from, text: reply, signal }), { sideEffect: true });
            if (providerId) await pool.execute(
              'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
              [providerId, message.from, 'outbound', 'text', reply.slice(0, 4000), 'sent']
            );
          } catch (error) {
            console.error('WhatsApp Google connect link failed:', error.code || 'google_link_failed');
          }
          continue;
        }
        // Owner-only Gmail/Calendar commands ("لخص آخر إيميل", "هات جدولي"): metadata + snippet only, no LLM.
        const ownerCommand = message.body && config.ownerPhone && message.from === config.ownerPhone ? parseOwnerGoogleCommand(message.body) : null;
        if (ownerCommand) {
          try {
            const reply = await runOwnerGoogleCommand({ pool, config, command: ownerCommand, ...(googleOps ? { googleOps } : {}) });
            const providerId = await services.run('whatsapp', (signal) => sendWhatsAppText({ config, phone: message.from, text: reply, signal }), { sideEffect: true });
            if (providerId) await pool.execute(
              'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
              [providerId, message.from, 'outbound', 'text', reply.slice(0, 4000), 'sent']
            );
          } catch (error) {
            console.error('WhatsApp owner Google reply failed:', error.code || 'whatsapp_send_failed');
          }
          continue;
        }
        if (config.whatsapp.autoReplyEnabled && message.body) {
          const [rows] = await pool.execute('SELECT opted_in, ai_opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ?', [message.from]);
          const contact = rows[0];
          if (contact?.opted_in && contact?.ai_opted_in && isWithinCustomerWindow(contact.last_inbound_at)) {
            try {
              const aiResult = await generateCeliaReply({
                config: { ...config, features: { ollama: false, ...config.features } },
                services,
                customerMessage: message.body,
                provider: config.celia?.aiProvider || 'auto'
              });
              const allowLocalAuto = config.celia?.aiProvider === 'local';
              if (aiResult.provider === 'celia-local-policy-engine' && !allowLocalAuto) {
                throw Object.assign(new Error('ai_provider_unavailable'), { code: 'AI_UNAVAILABLE' });
              }
              const reply = aiResult.reply;
              const providerId = await services.run('whatsapp', (signal) => sendWhatsAppText({ config, phone: message.from, text: reply, signal }), { sideEffect: true });
              if (providerId) await pool.execute(
                'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
                [providerId, message.from, 'outbound', 'text', reply.slice(0, 4000), 'sent']
              );
            } catch (error) {
              console.error('WhatsApp auto-reply failed:', error.code || 'upstream_failed');
            }
          }
        }
      }
      return res.sendStatus(200);
    } catch (error) {
      console.error('WhatsApp webhook processing failed:', error.code || 'storage_failed');
      return res.sendStatus(500);
    }
  });

  return router;
}

export function createWhatsAppApiRouter({ pool, config, services = createServiceRegistry(config), idempotencyStore = createIdempotencyStore() }) {
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
      console.error('Could not update WhatsApp consent:', error.code || 'storage_failed');
      return res.status(500).json({ error: 'consent_update_failed' });
    }
  });

  router.post('/api/whatsapp/messages', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? (req.body.phone.startsWith('+') ? req.body.phone : `+${req.body.phone}`) : '';
    const text = req.body?.text;
    if (!isValidE164(phone) || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'valid_phone_and_text_required' });
    const headerKey = req.get('Idempotency-Key') || req.get('idempotency-key') || '';
    const bodyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : (typeof req.body?.idempotency_key === 'string' ? req.body.idempotency_key : '');
    const idempotencyKey = isValidIdempotencyKey(headerKey) ? headerKey : (isValidIdempotencyKey(bodyKey) ? bodyKey : null);
    const idemScope = 'whatsapp.send';
    let claimToken;
    if (idempotencyKey) {
      const cached = idempotencyStore.get(idempotencyKey, idemScope);
      if (cached) {
        if (cached._idempotencyStatus === 'in_progress') return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
        return res.status(200).json({ ...cached, _idempotencyReplay: true });
      }
      claimToken = idempotencyStore.claim(idempotencyKey, idemScope);
      if (!claimToken) {
        const again = idempotencyStore.get(idempotencyKey, idemScope);
        if (again?._idempotencyStatus === 'in_progress') return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
        if (again) return res.status(200).json({ ...again, _idempotencyReplay: true });
        return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
      }
    }
    try {
      const [rows] = await pool.execute('SELECT opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ?', [phone]);
      const contact = rows[0];
      if (!contact?.opted_in) {
        if (idempotencyKey) idempotencyStore.fail(idempotencyKey, idemScope, claimToken);
        return res.status(403).json({ error: 'recipient_has_not_opted_in' });
      }
      if (!isWithinCustomerWindow(contact.last_inbound_at)) {
        if (idempotencyKey) idempotencyStore.fail(idempotencyKey, idemScope, claimToken);
        return res.status(403).json({ error: 'outside_customer_service_window_use_approved_template' });
      }
      let providerId;
      try {
        providerId = await services.run('whatsapp', (signal) => sendWhatsAppText({ config, phone, text, signal }), { sideEffect: true });
      } catch (inner) {
        if (idempotencyKey) idempotencyStore.fail(idempotencyKey, idemScope, claimToken);
        throw inner;
      }
      // Record completion IMMEDIATELY after upstream acceptance — before local DB logging — so a local DB failure never triggers a duplicate send on retry.
      const result = { status: 'accepted', phone, providerMessageId: providerId };
      if (idempotencyKey) idempotencyStore.complete(idempotencyKey, result, idemScope);
      if (providerId) {
        try {
          await pool.execute(
            'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
            [providerId, phone, 'outbound', 'text', text.trim().slice(0, 4000), 'sent']
          );
        } catch (dbErr) {
          console.warn('WhatsApp outbound local log failed after upstream send:', dbErr?.code || 'storage_failed');
        }
      }
      return res.status(idempotencyKey ? 200 : 202).json(result);
    } catch (error) {
      console.error('WhatsApp send failed:', error.code || 'upstream_failed');
      if (error instanceof ServiceUnavailableError) return res.status(503).json({ error: safeError(error), outcomeUnknown: error.outcomeUnknown });
      return res.status(502).json({ error: 'whatsapp_send_failed' });
    }
  });

  return router;
}
