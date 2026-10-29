import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DEFAULT_POLICY } from './gemini.js';
import { createMemoryPool } from './memory-pool.js';
import { decryptJson, encryptJson, hashOAuthState, isValidE164, isWithinCustomerWindow, verifyWhatsAppSignature } from './security.js';
import { runDocumentAutomationBenchmark } from './agent/automation/index.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export { generateLocalPolicyReply } from './policy.js';
import { generateLocalPolicyReply } from './policy.js';

export function createCeliaUiRouter({ createMcpHandler, buildStatusSummary, operations, config }) {
  const router = express.Router();
  const sandboxPool = createMemoryPool();
  const ephemeralLabKey = crypto.randomBytes(32).toString('base64');
  const ephemeralWebhookSecret = crypto.randomBytes(24).toString('hex');

  const sandboxConfig = Object.freeze({
    ...config,
    ownerPhone: null,
    ownerPhoneSourceEnv: null,
    encryptionKey: '',
    encryptionKeyring: null,
    extendedMcpTools: false,
    allowCloudFailover: false,
    gemini: Object.freeze({ ...config.gemini, apiKey: '' }),
    aiGateway: Object.freeze({ ...(config.aiGateway || {}), apiKey: '' }),
    deepseek: Object.freeze({ ...(config.deepseek || {}), apiKey: '' }),
    agentrouter: Object.freeze({ ...(config.agentrouter || {}), apiKey: '', sourceEnv: null }),
    elevenlabs: Object.freeze({ ...(config.elevenlabs || {}), apiKey: '', voiceId: '', voiceSourceEnv: null }),
    figma: Object.freeze({ ...(config.figma || {}), accessToken: '' }),
    codata: Object.freeze({ ...(config.codata || {}), apiKey: '', sourceEnv: null, baseUrl: '' }),
    cronjob: Object.freeze({ ...(config.cronjob || {}), apiKey: '', sourceEnv: null }),
    cloudflare: Object.freeze({ ...(config.cloudflare || {}), accountId: '', apiToken: '' }),
    cloudflareR2: Object.freeze({
      ...(config.cloudflareR2 || {}),
      accessKeyId: '',
      secretAccessKey: '',
      s3Endpoint: '',
      rawEndpointConfigured: false,
      endpointFormatValid: true
    }),
    celia: Object.freeze({ ...config.celia, apiToken: '', aiProvider: 'local' }),
    features: Object.freeze({
      ...config.features,
      gemini: false,
      ai_gateway: false,
      deepseek: false,
      agentrouter: false,
      ollama: false,
      elevenlabs: false,
      figma: false,
      codata: false,
      cronjob: false,
      cloudflare: false,
      cloudflare_r2: false
    }),
    google: Object.freeze({ clientId: '', clientSecret: '', redirectUri: config.google.redirectUri }),
    whatsapp: Object.freeze({
      ...config.whatsapp,
      accessToken: '',
      phoneNumberId: ''
    })
  });

  const sandboxHandler = createMcpHandler({ pool: sandboxPool, config: sandboxConfig });

  const landingAtRoot = Boolean(config?.landingRoot || process.env.CELIA_LANDING_ROOT === 'true');
  router.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, config.deploymentRoot ? 'deploy.html' : landingAtRoot ? 'landing.html' : 'index.html'));
  });
  router.get('/studio', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.get(['/deploy', '/deploy.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'deploy.html')));
  router.get('/deploy.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'deploy.css')));
  router.get('/deploy.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'deploy.js')));

  router.get(['/kb', '/kb.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'kb.html')));
  router.get('/kb.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'kb.css')));
  router.get('/kb.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'kb.js')));
  router.get(['/agent', '/agent.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'agent.html')));
  router.get(['/cron', '/cron.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cron.html')));
  router.get('/cron.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'cron.css')));
  router.get('/cron.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'cron.js')));
  router.get('/agent.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'agent.css')));
  router.get('/agent.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'agent.js')));
  // WP-1.2: pure trace helpers imported by agent.js as an ES module (also unit-tested in Node).
  router.get('/agent-trace.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'agent-trace.js')));

  router.get(['/protocol', '/protocol.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'protocol.html')));
  router.get('/protocol.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'protocol.css')));
  router.get('/protocol.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'protocol.js')));
  router.get(['/api/protocol/benchmark', '/api/protocol-benchmark.json'], async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await runDocumentAutomationBenchmark());
  });

  router.get(['/system', '/system.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'system.html')));
  router.get('/system.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'system.css')));
  router.get('/system.js', (_req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'system.js')));

  router.get(['/computer', '/computer.html'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'computer.html')));
  router.get(['/computer-permissions', '/computer-permissions.html'], (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'computer-permissions.html'))
  );
  router.get('/computer.css', (_req, res) => res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'computer.css')));

  router.get('/live', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'live.html'));
  });
  router.get('/skills', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'skills.html'));
  });
  router.get('/live.html', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'live.html'));
  });
  router.get('/skills.html', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'skills.html'));
  });
  // صفحة الهبوط التسويقية الفاخرة (landing) — ملفات محلية منفصلة لتوافق CSP.
  router.get('/landing', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
  });
  router.get('/landing.html', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
  });
  router.get('/index.html', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.get('/styles.css', (_req, res) => {
    res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'styles.css'));
  });

  router.get('/app.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'app.js'));
  });

  // صفحات live/skills تستخدم ملفات خارجية بدل السكربتات المضمّنة حتى تتوافق مع CSP (script-src 'self').
  router.get('/live.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'live.js'));
  });

  router.get('/skills.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'skills.js'));
  });

  router.get('/fonts.css', (_req, res) => {
    res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'fonts.css'));
  });

  router.get('/landing.css', (_req, res) => {
    res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'landing.css'));
  });

  router.get('/landing.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'landing.js'));
  });

  // أصول صفحة الهبوط المحلية: لا خطوط أو صور أو تتبّع من أطراف خارجية.
  router.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts'), {
    dotfiles: 'deny',
    index: false,
    maxAge: '7d'
  }));
  router.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').sendFile(path.join(PUBLIC_DIR, 'favicon.svg'));
  });
  router.get('/og-celia.png', (_req, res) => {
    res.type('image/png').sendFile(path.join(PUBLIC_DIR, 'og-celia.png'));
  });

  // Live JSON endpoints — no auth, shows system live on ground
  router.get('/healthz', async (_req, res) => {
    const summary = await buildStatusSummary(sandboxPool, config, { probeOllama: false });
    res.json({ ...summary, live: true, timestamp: new Date().toISOString() });
  });
  router.get('/api/live', async (_req, res) => {
    const summary = operations ? operations.liveness() : await buildStatusSummary(sandboxPool, config, { probeOllama: false });
    res.json({
      live: true,
      message: 'نظامك حي على أرض الواقع — Find Skills و System Live View يعملان الآن',
      summary,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      tools: summary.toolsCount
    });
  });
  router.get('/api/skills', async (req, res) => {
    const query = String(req.query.q || req.query.query || '').trim();
    const category = String(req.query.category || 'all').trim();
    const handler = createMcpHandler({ pool: sandboxPool, config: sandboxConfig });
    const rpcRes = await handler.handleRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'find_skills', arguments: { query, category, liveCheck: true } }
    });
    const out = rpcRes?.result?.structuredContent || rpcRes?.result || rpcRes;
    res.json(out);
  });

  router.post('/ui/workspace/rpc', express.json({ limit: '128kb' }), async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0') {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 payload' }
      });
    }

    if (body.method === 'tools/call' && body.params?.name === 'celia_ai_reply') {
      if (!['auto', 'local'].includes(String(body.params?.arguments?.provider || 'auto').toLowerCase())) {
        return res.status(403).json({ error: 'owner_token_required_for_external_ai' });
      }
      const requestedProvider = String(body.params?.arguments?.provider || 'auto').toLowerCase();
      if (requestedProvider === 'local' || requestedProvider === 'auto') {
        const response = await sandboxHandler.handleRpcMessage(body);
        if (!response?.result?.isError) {
          return res.json({ ...response, sandbox: true });
        }
        const customerMessage = String(body.params?.arguments?.customerMessage || '').trim();
        if (!customerMessage) {
          return res.json({ ...response, sandbox: true });
        }
        const businessContext = String(body.params?.arguments?.businessContext || config.gemini.businessContext || '');
        const reply = generateLocalPolicyReply({ customerMessage, businessContext });
        const output = {
          reply,
          provider: 'celia-local-policy-engine',
          model: 'celia-guard-ar-2026 (مجاني مدمج بدون مفتاح)',
          policyEnforced: true
        };
        return res.json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          sandbox: true,
          result: {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
            isError: false
          }
        });
      }
    }

    const response = await sandboxHandler.handleRpcMessage(body);
    if (!response) return res.status(202).end();
    return res.json({ ...response, sandbox: true });
  });

  router.post('/ui/workspace/crypto-lab', express.json({ limit: '64kb' }), async (req, res) => {
    const action = String(req.body?.action || 'audit');

    if (action === 'simulate_inbound_whatsapp') {
      const rawPhone = String(req.body?.phone || '+201065217834').trim();
      const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
      const text = String(req.body?.text || 'مرحبًا، أود الاستفسار عن الخدمات المتوفرة لديكم.').trim().slice(0, 1000);
      if (!isValidE164(phone) || !text) {
        return res.status(400).json({ error: 'valid_phone_and_text_required' });
      }

      const messageId = `wamid.CELIA_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const webhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [{ id: messageId, from: phone.slice(1), type: 'text', text: { body: text } }]
                }
              }
            ]
          }
        ]
      };
      const rawBytes = Buffer.from(JSON.stringify(webhookPayload), 'utf8');
      const signature = `sha256=${crypto.createHmac('sha256', ephemeralWebhookSecret).update(rawBytes).digest('hex')}`;
      const hmacVerified = verifyWhatsAppSignature(rawBytes, signature, ephemeralWebhookSecret);

      await sandboxPool.execute(
        'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
        [messageId, phone, 'inbound', 'text', text, 'received']
      );
      await sandboxPool.execute(
        `INSERT INTO whatsapp_contacts (phone_e164, last_inbound_at) VALUES (?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE last_inbound_at = UTC_TIMESTAMP()`,
        [phone]
      );

      const [rows] = await sandboxPool.execute(
        'SELECT opted_in, ai_opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ?',
        [phone]
      );
      const contact = rows[0] || { opted_in: false, ai_opted_in: false, last_inbound_at: null };
      const windowOpen = isWithinCustomerWindow(contact.last_inbound_at);
      const canAutoReply = Boolean(contact.opted_in && contact.ai_opted_in && windowOpen);

      let autoReply = null;
      if (canAutoReply) {
        autoReply = generateLocalPolicyReply({
          customerMessage: text,
          businessContext: config.gemini.businessContext
        });
      }

      return res.json({
        ok: true,
        messageId,
        phone,
        inboundText: text,
        signatureHeader: signature,
        hmacVerified,
        customerWindow24hOpen: windowOpen,
        consent: {
          optedIn: Boolean(contact.opted_in),
          aiOptedIn: Boolean(contact.ai_opted_in)
        },
        autoReplyAllowed: canAutoReply,
        autoReply,
        blockedReason: !contact.opted_in
          ? 'يلزم تسجيل موافقة واتساب (optedIn=true) أولًا'
          : !contact.ai_opted_in
            ? 'الرسالة حُفظت ونافذة الـ 24 ساعة فُتحت، لكن الرد الآلي متوقف لعدم وجود موافقة ذكاء اصطناعي منفصلة (aiOptedIn=true)'
            : null
      });
    }

    const samplePayload = {
      scope: 'openid email gmail.readonly drive.readonly calendar.events contacts.readonly',
      token_type: 'Bearer',
      issued_at: new Date().toISOString()
    };
    const encrypted = encryptJson(samplePayload, ephemeralLabKey);
    const decrypted = decryptJson(encrypted, ephemeralLabKey);
    const rawWebhook = Buffer.from('{"object":"whatsapp_business_account","entry":[]}', 'utf8');
    const sig = `sha256=${crypto.createHmac('sha256', ephemeralWebhookSecret).update(rawWebhook).digest('hex')}`;
    const stateSample = crypto.randomBytes(16).toString('hex');
    const status = await buildStatusSummary(sandboxPool, config, { probeOllama: true });

    return res.json({
      ok: true,
      policy: DEFAULT_POLICY,
      status,
      cryptography: {
        algorithm: 'AES-256-GCM + HMAC-SHA256 + SHA-256 State Hashing',
        encryptedTokenPreview: `${encrypted.slice(0, 58)}...`,
        decryptedMatchesOriginal: JSON.stringify(decrypted) === JSON.stringify(samplePayload),
        oauthStateHash: hashOAuthState(stateSample),
        whatsappSignature: sig,
        whatsappHmacVerified: verifyWhatsAppSignature(rawWebhook, sig, ephemeralWebhookSecret),
        tamperRejected: !verifyWhatsAppSignature(Buffer.from('{"tampered":true}'), sig, ephemeralWebhookSecret)
      }
    });
  });

  return router;
}
