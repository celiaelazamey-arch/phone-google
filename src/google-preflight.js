/**
 * Offline preflight for the Google connection (GOOG-002).
 *
 * Everything here is a pure function over the environment: no network calls, no database, no
 * secret values echoed back. Every check reports one of three states — `pass`, `warn`, `fail` —
 * plus a concrete fix, so the owner can find the cause of the classic failures before opening
 * a browser: `redirect_uri_mismatch`, `503 google_not_configured`, silent identity-check skip.
 */

const CALLBACK_PATH = '/auth/google/callback';
const CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const value = (env, name) => String(env[name] ?? '').trim();
const isPlaceholder = (raw) => !raw || /^replace-with-|^<|^your-/i.test(raw);

function check(id, status, detail, fix = null) {
  return { id, status, detail, ...(fix ? { fix } : {}) };
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ now?: number }} [options]
 * @returns {{ ok: boolean, checks: Array<{id: string, status: 'pass'|'warn'|'fail', detail: string, fix?: string}>, summary: {pass: number, warn: number, fail: number}, redirectUri: string }}
 */
export function preflightGoogleConfig(env = {}, _options = {}) {
  const checks = [];
  const port = value(env, 'PORT') || '3000';
  const baseUrlRaw = value(env, 'APP_BASE_URL') || `http://localhost:${port}`;
  const redirectRaw = value(env, 'GOOGLE_REDIRECT_URI') || `${baseUrlRaw.replace(/\/+$/, '')}${CALLBACK_PATH}`;

  // 1. Credentials -----------------------------------------------------------
  const clientId = value(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = value(env, 'GOOGLE_CLIENT_SECRET');

  if (isPlaceholder(clientId)) {
    checks.push(check('client_id', 'fail',
      'GOOGLE_CLIENT_ID is missing or still a placeholder, so every Google route returns 503 google_not_configured.',
      'Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application, then copy the Client ID into GOOGLE_CLIENT_ID.'));
  } else if (!CLIENT_ID_PATTERN.test(clientId)) {
    checks.push(check('client_id', 'warn',
      'GOOGLE_CLIENT_ID is set but does not look like a Web application client ID (expected "<digits>-<hash>.apps.googleusercontent.com").',
      'A Desktop app / API key / service-account value will fail at the consent screen; use the Web application client.'));
  } else {
    checks.push(check('client_id', 'pass', 'GOOGLE_CLIENT_ID is present and has the Web application client ID shape.'));
  }

  if (isPlaceholder(clientSecret)) {
    checks.push(check('client_secret', 'fail',
      'GOOGLE_CLIENT_SECRET is missing or still a placeholder, so token exchange cannot succeed.',
      'Copy the client secret from the same OAuth client into GOOGLE_CLIENT_SECRET — host env or an ignored .env only, never a chat or a commit.'));
  } else if (clientSecret.length < 20) {
    checks.push(check('client_secret', 'warn',
      'GOOGLE_CLIENT_SECRET is unusually short for a Google client secret (typically "GOCSPX-" followed by ~28 characters).',
      'Re-copy the full secret; a truncated value fails the callback with invalid_client.'));
  } else {
    checks.push(check('client_secret', 'pass', 'GOOGLE_CLIENT_SECRET is present (value not printed).'));
  }

  // 2. Redirect URI ----------------------------------------------------------
  const redirectUrl = parseUrl(redirectRaw);
  let redirectOk = false;
  if (!redirectUrl) {
    checks.push(check('redirect_uri', 'fail',
      `GOOGLE_REDIRECT_URI is not an absolute URL: it resolves to "${redirectRaw}".`,
      `Set GOOGLE_REDIRECT_URI to ${baseUrlRaw.replace(/\/+$/, '')}${CALLBACK_PATH}.`));
  } else {
    redirectOk = true;
    if (redirectUrl.pathname.replace(/\/+$/, '') !== CALLBACK_PATH) {
      redirectOk = false;
      checks.push(check('redirect_uri', 'fail',
        `The redirect path is "${redirectUrl.pathname}", but the router only serves "${CALLBACK_PATH}".`,
        `Use exactly ${redirectUrl.origin}${CALLBACK_PATH} in both GOOGLE_REDIRECT_URI and the Authorized redirect URIs of the OAuth client.`));
    } else if (redirectRaw !== redirectUrl.origin + CALLBACK_PATH) {
      redirectOk = false;
      checks.push(check('redirect_uri', 'fail',
        'The redirect URI carries a trailing slash, query string, or fragment; Google matches it character for character.',
        `Use exactly ${redirectUrl.origin}${CALLBACK_PATH} with no trailing slash and no query.`));
    }
    if (redirectUrl.protocol !== 'https:' && !isLocalHost(redirectUrl.hostname)) {
      redirectOk = false;
      checks.push(check('redirect_uri', 'fail',
        `The redirect URI uses ${redirectUrl.protocol} on the public host "${redirectUrl.hostname}"; Google requires https for anything but localhost.`,
        'Put the service behind HTTPS and set both the environment variable and the Authorized redirect URI to the https origin.'));
    }
    if (redirectOk) {
      checks.push(check('redirect_uri', 'pass', `The redirect URI matches the served callback: ${redirectRaw}`));
    }
  }

  // 3. Public reachability ---------------------------------------------------
  const baseUrl = parseUrl(baseUrlRaw);
  if (!baseUrl) {
    checks.push(check('public_base_url', 'fail',
      `APP_BASE_URL is not an absolute URL: it resolves to "${baseUrlRaw}".`,
      `Set APP_BASE_URL to the public origin of this service, e.g. https://<domain>.`));
  } else if (isLocalHost(baseUrl.hostname)) {
    checks.push(check('public_base_url', 'warn',
      `APP_BASE_URL points at ${baseUrl.hostname}, so consent links only work from this machine (HOST-003).`,
      'For a link that opens on your phone, set APP_BASE_URL to a public HTTPS origin and keep GOOGLE_REDIRECT_URI in sync.'));
  } else if (baseUrl.protocol !== 'https:') {
    checks.push(check('public_base_url', 'warn',
      'APP_BASE_URL is a public host without HTTPS; Google will refuse the callback and tokens would travel in clear text.',
      'Terminate TLS in front of the service and switch APP_BASE_URL to https.'));
  } else {
    checks.push(check('public_base_url', 'pass', `APP_BASE_URL is a public HTTPS origin: ${baseUrl.origin}`));
  }

  if (baseUrl && redirectRaw && redirectRaw !== `${baseUrl.origin}${CALLBACK_PATH}`) {
    checks.push(check('base_url_alignment', 'warn',
      'APP_BASE_URL and GOOGLE_REDIRECT_URI point at different hosts; consent links are built from APP_BASE_URL while Google returns to GOOGLE_REDIRECT_URI.',
      `Keep both on the same origin, or confirm ${redirectUrl?.origin || 'the callback host'} serves this same deployment.`));
  } else if (baseUrl) {
    checks.push(check('base_url_alignment', 'pass', 'Consent links and the Google callback share one origin.'));
  }

  // 4. Owner identity -------------------------------------------------------
  const ownerEmail = value(env, 'APP_OWNER_EMAIL');
  if (!ownerEmail) {
    checks.push(check('owner_email', 'fail',
      'APP_OWNER_EMAIL is empty, so the verifyIdToken identity check is skipped and ANY Google account could complete the connection.',
      'Set APP_OWNER_EMAIL to the exact Gmail address you will sign in with (also add it to OAuth consent screen → Test users).'));
  } else if (!EMAIL_PATTERN.test(ownerEmail)) {
    checks.push(check('owner_email', 'fail',
      `APP_OWNER_EMAIL is not a valid email address: "${ownerEmail}".`,
      'Use the full address, e.g. name@gmail.com, with no spaces or display name.'));
  } else {
    checks.push(check('owner_email', 'pass', `Owner identity is enforced for ${ownerEmail}.`));
  }

  const ownerPhone = value(env, 'APP_OWNER_PHONE_E164');
  if (!ownerPhone) {
    checks.push(check('owner_phone', 'warn',
      'APP_OWNER_PHONE_E164 is empty, so the WhatsApp "اربط جوجل" command can never fire.',
      'Set it to your number in E.164 form (e.g. +201234567890) — the same number that messages the WhatsApp webhook.'));
  } else if (!E164_PATTERN.test(ownerPhone)) {
    checks.push(check('owner_phone', 'warn',
      `APP_OWNER_PHONE_E164 "${ownerPhone}" is not E.164 (leading +, country code, digits only); WhatsApp compares it literally against the sender.`,
      'Rewrite it as +<country><number> with no spaces, dashes, or leading 00.'));
  } else {
    checks.push(check('owner_phone', 'pass', 'The owner phone is in E.164 form, so the chat command is enabled.'));
  }

  // 5. Local secrets the flow depends on ------------------------------------
  const encryptionKey = value(env, 'TOKEN_ENCRYPTION_KEY');
  if (isPlaceholder(encryptionKey)) {
    checks.push(check('encryption_key', 'fail',
      'TOKEN_ENCRYPTION_KEY is missing or a placeholder; token encryption and consent-ticket signing both derive from it.',
      'Generate one with `openssl rand -base64 32` and keep the same value across restarts.'));
  } else if (Buffer.from(encryptionKey, 'base64').length !== 32) {
    checks.push(check('encryption_key', 'fail',
      'TOKEN_ENCRYPTION_KEY does not decode to exactly 32 bytes of base64.',
      'Regenerate with `openssl rand -base64 32`; the app refuses to start with a different length.'));
  } else {
    checks.push(check('encryption_key', 'pass', 'TOKEN_ENCRYPTION_KEY is 32 base64-encoded bytes (value not printed).'));
  }

  const apiToken = value(env, 'APP_API_TOKEN');
  if (isPlaceholder(apiToken)) {
    checks.push(check('api_token', 'fail',
      'APP_API_TOKEN is missing or a placeholder, so POST /api/google/consent-link answers 401.',
      'Set APP_API_TOKEN to at least 32 random characters and send it as a Bearer header.'));
  } else if (apiToken.length < 32) {
    checks.push(check('api_token', 'fail',
      `APP_API_TOKEN is ${apiToken.length} characters; the app requires at least 32 and will not start.`,
      'Use 32+ random characters, e.g. `openssl rand -hex 32`.'));
  } else {
    checks.push(check('api_token', 'pass', 'APP_API_TOKEN is long enough for the owner-only routes (value not printed).'));
  }

  // 6. Feature switch -------------------------------------------------------
  if (value(env, 'CELIA_DISABLE_GOOGLE') === 'true') {
    checks.push(check('feature_switch', 'fail',
      'CELIA_DISABLE_GOOGLE=true makes every /api/google and /auth/google route answer 503 google_disabled, even with valid credentials.',
      'Remove CELIA_DISABLE_GOOGLE (or set it to false) on the process that should serve the connection.'));
  } else {
    checks.push(check('feature_switch', 'pass', 'The Google routes are enabled.'));
  }

  const summary = checks.reduce((acc, item) => ({ ...acc, [item.status]: acc[item.status] + 1 }),
    { pass: 0, warn: 0, fail: 0 });

  return { ok: summary.fail === 0, checks, summary, redirectUri: redirectRaw };
}

/** Renders the report for a terminal without ever printing a secret value. */
export function formatPreflightReport(report) {
  const symbol = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  const lines = report.checks.map((item) => {
    const head = `[${symbol[item.status]}] ${item.id}: ${item.detail}`;
    return item.fix ? `${head}\n        → ${item.fix}` : head;
  });
  const verdict = report.ok
    ? `Preflight is clean enough to open the consent link (${report.summary.pass} pass, ${report.summary.warn} warn).`
    : `Preflight found ${report.summary.fail} blocking problem(s); fix them before opening the consent link.`;
  return [...lines, '', verdict].join('\n');
}
