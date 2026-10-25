import crypto from 'node:crypto';
import { createApp } from './app.js';
import { ensureOwner } from './db.js';
import { createDemoGoogleApi } from './demo-google.js';
import { DemoPool } from './demo-pool.js';
import { createDemoRouter } from './demo-router.js';

/**
 * Builds a fully wired, 100% free, 100% offline instance of the SAME production
 * routers. All external providers (Google, Gemini, WhatsApp Graph) and MySQL are
 * replaced by in-process adapters. No secret, no account, no network call, no cost.
 */
export async function createDemoApp({ env = process.env } = {}) {
  if (env.NODE_ENV === 'production') {
    throw new Error('DEMO_MODE_REFUSED: the offline demo must never run with NODE_ENV=production');
  }

  const apiToken = crypto.randomBytes(24).toString('hex');
  const encryptionKey = crypto.randomBytes(32).toString('base64');
  const appSecret = crypto.randomBytes(24).toString('hex');
  const verifyToken = crypto.randomBytes(16).toString('hex');
  const geminiApiKey = 'demo-gemini-key';
  const accessToken = 'demo-whatsapp-token';
  const demoPhone = '+14155552671';

  const config = {
    nodeEnv: 'demo',
    port: Number(env.PORT || 3000),
    baseUrl: 'http://localhost',
    apiToken,
    userId: 'owner',
    ownerEmail: '',
    ownerPhone: demoPhone,
    encryptionKey,
    google: {
      clientId: 'demo-client-id',
      clientSecret: 'demo-client-secret',
      allowedEmail: '',
      redirectUri: 'http://localhost/auth/google/callback'
    },
    gemini: {
      apiKey: geminiApiKey,
      model: 'gemini-demo',
      businessContext: 'نشاط تجريبي: خدمة عملاء عامة، ساعات العمل من 9 صباحًا حتى 5 مساءً.'
    },
    whatsapp: {
      verifyToken,
      appSecret,
      accessToken,
      phoneNumberId: 'demo-phone-number-id',
      apiVersion: 'v23.0',
      autoReplyEnabled: true
    },
    demo: { enabled: true, localOrigin: null, fetchImpl: null }
  };

  const pool = new DemoPool();
  const outbox = [];

  config.demo.fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://generativelanguage.googleapis.com/')) {
      if (options.headers?.['x-goog-api-key'] !== geminiApiKey) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      const body = JSON.parse(options.body || '{}');
      const customer = body.contents?.[0]?.parts?.[0]?.text || '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: demoReply(customer) }] } }] })
      };
    }
    if (target.startsWith('https://graph.facebook.com/')) {
      if (options.headers?.authorization !== `Bearer ${accessToken}`) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      const body = JSON.parse(options.body || '{}');
      const id = `wamid.out.${crypto.randomBytes(6).toString('hex')}`;
      outbox.push({
        id,
        to: `+${body.to}`,
        text: body.text?.body || '',
        created_at: new Date().toISOString()
      });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id }] }) };
    }
    throw new Error(`Demo provider blocked an unexpected outbound URL: ${target}`);
  };

  const demoRouter = await createDemoRouter({ pool, config, outbox });
  // A demo dashboard is often shown inside a hosted preview iframe. Allow that
  // origin explicitly (comma-separated) while keeping the rest of Helmet's CSP.
  const frameAncestors = String(env.DEMO_FRAME_ANCESTORS || "'self'")
    .split(',').map((item) => item.trim()).filter(Boolean);
  const helmetOptions = {
    contentSecurityPolicy: { directives: { frameAncestors } },
    xFrameOptions: false
  };
  const app = createApp({
    pool,
    config,
    googleApi: createDemoGoogleApi(),
    extraRouters: [demoRouter],
    helmetOptions
  });
  await ensureOwner(pool, config);

  return {
    app,
    config,
    pool,
    outbox,
    setLocalOrigin(origin) {
      config.demo.localOrigin = origin;
    }
  };
}

/** Deterministic, policy-safe Arabic reply; never invents prices or orders. */
export function demoReply(customerMessage) {
  const text = String(customerMessage).toLowerCase();
  if (/سعر|تكلف|دفع|طلب|طلبية|شحن|مخزون|استرجاع|شكوى|كلمة سر|رمز|بطاق/.test(text)) {
    return 'شكرًا لتواصلك. سأحوّل رسالتك إلى أحد أفراد الفريق للرد عليك بدقة.';
  }
  return 'أهلًا بك! وصلت رسالتك، ويسعدني الإجابة عن استفساراتك العامة عن خدماتنا.';
}
