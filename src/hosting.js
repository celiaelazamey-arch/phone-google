import { loadConfig } from './config.js';

export function loadHostingConfig(env, mcpToken) {
  const flag = env.CELIA_ENABLE_INTEGRATIONS || 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('CELIA_ENABLE_INTEGRATIONS must be true or false');
  const initialize = env.CELIA_DB_INITIALIZE || 'false';
  if (!['false', 'empty-only'].includes(initialize)) throw new Error('CELIA_DB_INITIALIZE must be false or empty-only');
  const enabled = flag === 'true';
  if ((enabled || initialize === 'empty-only') && env.CELIA_MCP_DISABLE_MYSQL === 'true') {
    throw new Error('Full integrations and database initialization require durable MySQL');
  }
  let integrationConfig = null;
  if (enabled) {
    const port = env.PORT || env.CELIA_MCP_PORT || '3010';
    const base = env.APP_BASE_URL || env.RENDER_EXTERNAL_URL || (env.NODE_ENV !== 'production' ? `http://localhost:${port === '0' ? '3010' : port}` : '');
    let url;
    try { url = new URL(base); } catch { throw new Error('Full integrations require a valid APP_BASE_URL or RENDER_EXTERNAL_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
      throw new Error('Public integration base URL must be an origin; production requires HTTPS');
    }
    const baseUrl = url.origin;
    integrationConfig = loadConfig({
      ...env,
      PORT: port === '0' ? '3010' : port,
      APP_API_TOKEN: env.APP_API_TOKEN || mcpToken,
      APP_BASE_URL: baseUrl,
      GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI || `${baseUrl}/auth/google/callback`
    });
  }
  const sourceRef = env.CELIA_SOURCE_REF || env.RENDER_GIT_BRANCH || 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(sourceRef) || sourceRef.includes('..')) {
    throw new Error('CELIA_SOURCE_REF must be a safe source branch or tag');
  }
  let publicUrl = null;
  if (env.RENDER_EXTERNAL_URL) {
    try {
      const url = new URL(env.RENDER_EXTERNAL_URL);
      if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) publicUrl = url.origin;
    } catch { /* Unknown is not a published deployment. */ }
  }
  return Object.freeze({
    integrationsEnabled: enabled,
    integrationConfig,
    initializeDatabase: initialize,
    sourceRef,
    publicUrl
  });
}

/** Public, deliberately sanitized. Configuration is NOT live provider verification. */
export function deploymentStatus({ config, snapshot }) {
  const fullApiMounted = Boolean(config.hosting?.integrationsEnabled);
  const providers = ['google', 'whatsapp', 'gemini'].map((id) => {
    const component = snapshot.components?.find((c) => c.id === id);
    return { id, state: component?.state || 'unverified', connected: component?.state === 'healthy' };
  });
  return {
    scope: 'server',
    release: snapshot.release,
    generatedAt: new Date().toISOString(),
    sourceRef: config.hosting?.sourceRef || 'main',
    coreReady: snapshot.ready,
    storage: snapshot.storage,
    fullApiMounted,
    publicUrl: config.hosting?.publicUrl || null,
    publicUrlVerification: 'not-externally-verified',
    schemaVerification: 'declared-contract-only',
    providers,
    configuredRuntimeReady: Boolean(snapshot.storage?.durable && snapshot.ready && fullApiMounted),
    // No external acceptance proof is collected by this read-only endpoint. Never invent it.
    allCapabilitiesVerified: false,
    notice: 'A host-provided URL is not an external availability test. Configured is not connected. No deployment, purchase, migration or provider call is executed by this report.'
  };
}
