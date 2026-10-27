import { X509Certificate } from 'node:crypto';

/** One TLS policy for REST, MCP and the opt-in first installation. Never disable verification. */
export function loadMysqlConfig(env = process.env) {
  const port = Number(env.MYSQL_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MYSQL_PORT must be a valid TCP port');
  }
  const setting = env.MYSQL_SSL?.trim();
  if (setting && !['true', 'false'].includes(setting)) {
    throw new Error('MYSQL_SSL must be true or false');
  }
  const production = env.NODE_ENV === 'production';
  if (production && setting === 'false') {
    throw new Error('MYSQL_SSL cannot be disabled in production');
  }
  const tls = production || setting === 'true';
  const encodedCa = (env.MYSQL_SSL_CA_BASE64 || '').replace(/\s/g, '');
  let ca;
  if (encodedCa) {
    if (!tls) throw new Error('MYSQL_SSL_CA_BASE64 requires MySQL TLS');
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCa)) throw new Error();
      const bytes = Buffer.from(encodedCa, 'base64');
      if (bytes.toString('base64') !== encodedCa) throw new Error();
      ca = bytes.toString('utf8');
      if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
      new X509Certificate(ca);
    } catch {
      throw new Error('MYSQL_SSL_CA_BASE64 must encode a valid PEM CA certificate');
    }
  }
  return Object.freeze({
    host: env.MYSQL_HOST || '127.0.0.1',
    port,
    database: env.MYSQL_DATABASE || 'phone_google',
    user: env.MYSQL_USER || 'phone_google',
    password: env.MYSQL_PASSWORD || '',
    ...(tls ? { ssl: Object.freeze({ minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) }) } : {})
  });
}
