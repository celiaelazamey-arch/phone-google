export function loadConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };

  const apiToken = required('APP_API_TOKEN');
  if (apiToken.length < 32) throw new Error('APP_API_TOKEN must be at least 32 characters');
  const encryptionKey = required('TOKEN_ENCRYPTION_KEY');
  const decodedKey = Buffer.from(encryptionKey, 'base64');
  if (decodedKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 bytes');

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    port,
    baseUrl: env.APP_BASE_URL || `http://localhost:${port}`,
    apiToken,
    userId: env.APP_USER_ID || 'owner',
    ownerEmail: env.APP_OWNER_EMAIL || '',
    ownerPhone: env.APP_OWNER_PHONE_E164 || null,
    encryptionKey,
    mysql: {
      host: env.MYSQL_HOST || '127.0.0.1',
      port: Number(env.MYSQL_PORT || 3306),
      database: env.MYSQL_DATABASE || 'phone_google',
      user: env.MYSQL_USER || 'phone_google',
      password: env.MYSQL_PASSWORD || ''
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      allowedEmail: (env.APP_OWNER_EMAIL || '').trim().toLowerCase(),
      redirectUri: env.GOOGLE_REDIRECT_URI || `${env.APP_BASE_URL || `http://localhost:${port}`}/auth/google/callback`
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      businessContext: env.GEMINI_BUSINESS_CONTEXT || ''
    },
    whatsapp: {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
      autoReplyEnabled: env.WHATSAPP_AUTO_REPLY_ENABLED === 'true'
    }
  });
}
