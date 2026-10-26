import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildLiveArtifact, sanitizeFigmaTree } from './figma.js';
import { DEFAULT_POLICY } from './gemini.js';
import { createMemoryPool } from './memory-pool.js';
import { decryptJson, encryptJson, hashOAuthState, isValidE164, isWithinCustomerWindow, verifyWhatsAppSignature } from './security.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

/** تصميم تجريبي ثابت للاستوديو العام: صفر استدعاءات Figma، صفر توكن. */
function buildSandboxFigmaDemo() {
  const document = {
    id: '0:0',
    name: 'شاشة سيليا الرئيسية',
    type: 'CANVAS',
    absoluteBoundingBox: { width: 1440, height: 900 },
    fills: [{ type: 'SOLID', color: { r: 0.97, g: 0.98, b: 1 } }],
    children: [
      {
        id: '1:1',
        name: 'شريط التنقل',
        type: 'FRAME',
        fills: [{ type: 'SOLID', color: { r: 0.388, g: 0.4, b: 0.945 } }],
        style: { fontFamily: 'Cairo' }
      },
      { id: '1:2', name: 'بطاقة العميل', type: 'COMPONENT', style: { fontFamily: 'Tajawal' } },
      { id: '1:3', name: 'زر الحجز', type: 'INSTANCE', fills: [{ type: 'SOLID', color: { r: 0.055, g: 0.647, b: 0.914 } }] }
    ]
  };
  return {
    provider: 'figma',
    fileKey: 'SANDBOX_DEMO_ONLY',
    nodeId: null,
    referenceSource: 'sandbox',
    name: 'واجهة سيليا التجريبية',
    lastModified: '',
    httpStatus: 0,
    depth: 2,
    sandboxOnly: true,
    ...sanitizeFigmaTree(document)
  };
}

export function generateLocalPolicyReply({ customerMessage, businessContext = '' }) {
  const msg = String(customerMessage || '').trim();
  const contextSnippet = String(businessContext || '').trim().slice(0, 240);

  if (/(سعر|أسعار|تكلف|كم|خصم|عرض|شراء|طلب|دفع|بطاق|حساب|فاتور|استرجاع|شكو)/i.test(msg)) {
    return 'شكرًا لتواصلك معنا؛ حفاظًا على دقة تفاصيل الأسعار والطلبات والمدفوعات سيقوم أحد ممثلي خدمة العملاء بمتابعة طلبك مباشرةً. هل تود ترك أي توضيح إضافي للموظف المختص؟';
  }
  if (/(موعد|مواعيد|ساعات|عمل|متى|حجز|اجتماع)/i.test(msg)) {
    return contextSnippet
      ? `أهلًا بك! وفق بيانات النشاط المعتمدة (${contextSnippet})، يسعدنا تنسيق الموعد المناسب لك عبر فريق الخدمة المختص.`
      : 'أهلًا بك! يسعدنا مساعدتك في الاستفسارات العامة، ولتأكيد المواعيد المتاحة بدقة سيقوم موظف مختص بالمتابعة معك فورًا.';
  }
  if (contextSnippet) {
    return `مرحبًا بك! يسعدنا خدمتك وفق سياق نشاطنا المعتمد: ${contextSnippet}. أخبرنا كيف يمكننا مساعدتك أو تحويلك لموظف مختص عند الحاجة.`;
  }
  return 'أهلًا وسهلًا بك! أنا مساعد خدمة العملاء الذكي لسيليا؛ يسعدني الإجابة عن استفساراتك العامة أو تحويل طلبك لموظف بشري مختص للتفاصيل الإجرائية.';
}

export function createCeliaUiRouter({ createMcpHandler, buildStatusSummary, config, voiceEngine = null, figmaBridge = null }) {
  const router = express.Router();
  const sandboxPool = createMemoryPool();
  const ephemeralLabKey = crypto.randomBytes(32).toString('base64');
  const ephemeralWebhookSecret = crypto.randomBytes(24).toString('hex');

  const sandboxConfig = Object.freeze({
    ...config,
    encryptionKey: '',
    google: Object.freeze({ clientId: '', clientSecret: '', redirectUri: config.google.redirectUri }),
    // الاستوديو العام غير محمٍ بمفتاح: نُفرغ مفاتيح المزودات ذات الرصيد/الحصة
    // (AgentRouter وDeepSeek) حتى لا يتمكن أي زائر من استهلاكها.
    aiRouter: config.aiRouter
      ? Object.freeze({
          ...config.aiRouter,
          agentRouter: Object.freeze({ ...config.aiRouter.agentRouter, apiKey: '' }),
          deepseek: Object.freeze({ ...config.aiRouter.deepseek, apiKey: '' })
        })
      : undefined,
    // مفتاح ElevenLabs ذو حصة مدفوعة: يُفرَّغ في الاستوديو العام تمامًا.
    voice: config.voice ? Object.freeze({ ...config.voice, apiKey: '' }) : undefined,
    // توكن Figma: يُفرَّغ في الاستوديو العام؛ أدواته تعمل بمحاكاة محلية بلا شبكة.
    figma: config.figma ? Object.freeze({ ...config.figma, accessToken: '' }) : undefined,
    whatsapp: Object.freeze({
      ...config.whatsapp,
      accessToken: '',
      phoneNumberId: ''
    })
  });

  const sandboxHandler = createMcpHandler({ pool: sandboxPool, config: sandboxConfig });

  router.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.get('/styles.css', (_req, res) => {
    res.type('text/css').sendFile(path.join(PUBLIC_DIR, 'styles.css'));
  });

  router.get('/app.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'app.js'));
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

    // الموجّه الذكي في الاستوديو العام يعمل كمحاكاة محلية فقط (صفر مفاتيح، صفر تكلفة).
    if (body.method === 'tools/call' && body.params?.name === 'celia_smart_router') {
      const callArgs = body.params?.arguments || {};
      const prompt = String(callArgs.prompt ?? callArgs.customerMessage ?? '').trim().slice(0, 4000);
      if (!prompt) {
        return res.json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          sandbox: true,
          error: { code: -32602, message: 'prompt (or customerMessage) is required' }
        });
      }
      const businessContext = String(callArgs.businessContext ?? config.gemini.businessContext ?? '');
      const output = {
        reply: generateLocalPolicyReply({ customerMessage: prompt, businessContext }),
        provider: 'celia-local-policy-engine',
        model: 'celia-sandbox-router (محاكاة محلية بدون مفاتيح)',
        task: typeof callArgs.task === 'string' ? callArgs.task : 'auto',
        sandboxOnly: true,
        note: 'محاكاة داخل الاستوديو العام؛ للتوجيه الحقيقي استخدم POST /mcp مع CELIA_MCP_API_TOKEN.'
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

    // أدوات الصوت في الاستوديو العام: محاكاة محلية فقط (لا ElevenLabs، لا حصة، لا صوت حقيقي).
    if (body.method === 'tools/call' && (body.params?.name === 'celia_voice_speak' || body.params?.name === 'celia_voice_quota')) {
      const toolName = body.params.name;
      const callArgs = body.params?.arguments || {};
      const output =
        toolName === 'celia_voice_quota'
          ? {
              available: false,
              provider: 'elevenlabs',
              reason: 'sandbox_simulation',
              sandboxOnly: true,
              note: 'الحصة الحقيقية تُقرأ عبر POST /mcp المحمي بالرمز فقط.',
              dailyBudget: { used: 0, limit: 0, remaining: 0 },
              cache: { entries: 0, hits: 0, misses: 0 }
            }
          : {
              provider: 'web-speech-ar-EG',
              model: 'browser-speech-synthesis',
              locale: 'ar-EG',
              cached: false,
              charsConsumed: 0,
              audioBase64: null,
              text: String(callArgs.text ?? '').trim().slice(0, 1000),
              fallback: true,
              sandboxOnly: true,
              reason: 'sandbox_simulation',
              note: 'للصوت الحقيقي استخدم POST /mcp مع CELIA_MCP_API_TOKEN.'
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

    // أدوات Figma في الاستوديو العام: تصميم تجريبي محلي فقط (لا توكن، لا شبكة).
    if (body.method === 'tools/call' && (body.params?.name === 'figma_inspect_design' || body.params?.name === 'figma_to_live_artifact')) {
      const demo = buildSandboxFigmaDemo();
      const output =
        body.params.name === 'figma_to_live_artifact'
          ? { ...buildLiveArtifact(demo, { title: String(body.params?.arguments?.title || demo.name) }), sandboxOnly: true }
          : demo;
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

    if (body.method === 'tools/call' && body.params?.name === 'celia_ai_reply') {
      const requestedProvider = String(body.params?.arguments?.provider || 'auto').toLowerCase();
      if (requestedProvider === 'local' || (requestedProvider === 'auto' && !config.gemini.apiKey)) {
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
