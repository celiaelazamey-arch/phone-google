// WA-008 — ordinary users sign in to a self-service account with their Google identity.
//
// Design constraints (DEC-065: no owner token, no cross-tenant access):
//   * Reuses the SAME registered redirect URI as the owner Workspace link flow
//     (`/auth/google/callback`), so no new Google Cloud Console setting is needed.
//   * Requests only `openid email profile`. No Gmail/Drive/Calendar/Consent scopes
//     are shown to a business user, and no Google access or refresh token is stored.
//   * The single-use `signin:<hex>` state in `oauth_states` is consumed by
//     handleGoogleOAuthCallback() before this module ever sees the authorization code.
//   * A Google identity is never silently attached to an existing password account:
//     that would let whoever controls the Google address take over the account.
// The `signin:` state is distinct from `browser:`/`link:` so the owner Workspace
// callback can never be mistaken for an account login and vice versa.
import { randomHex, sha256Hex } from './crypto.js';
import { signInWithGoogleIdentity } from './accounts.js';

export const GOOGLE_ACCOUNT_SIGNIN_SCOPES = Object.freeze(['openid', 'email', 'profile']);
export const GOOGLE_ACCOUNT_STATE_TTL_MS = 10 * 60_000;
export const GOOGLE_ACCOUNT_STATE_COOKIE = 'celia_oauth_state';

const STATE_COOKIE_CLEAR = `${GOOGLE_ACCOUNT_STATE_COOKIE}=; Max-Age=0; Path=/auth/google; HttpOnly; Secure; SameSite=Lax`;
/** Reason codes are a fixed vocabulary; the browser maps them to Arabic, never raw errors. */
const PUBLIC_REASONS = new Set([
  'google_identity_not_verified',
  'google_email_already_registered',
  'google_signin_conflict',
  'd1_not_bound',
  'google_signin_failed'
]);

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function db(env) { if (!env.DB) throw problem('d1_not_bound', 503); return env.DB; }
function configured(env, name) {
  const value = String(env?.[name] || '').trim();
  return Boolean(value && !/^replace-with-/i.test(value));
}
function signinFailure(reason) {
  return {
    ok: false,
    status: 302,
    location: `/whatsapp?google_error=${encodeURIComponent(reason)}`,
    cookies: [STATE_COOKIE_CLEAR]
  };
}

/**
 * Start the account-login OAuth flow. The state is stored in D1 before the redirect;
 * the callback verifies both the cookie and the single-use row.
 */
export async function createGoogleAccountAuthUrl({ env = {}, redirectUri = '', now = () => new Date() } = {}) {
  if (!configured(env, 'GOOGLE_CLIENT_ID') || !configured(env, 'GOOGLE_CLIENT_SECRET')) {
    throw problem('google_oauth_not_configured', 503);
  }
  const uri = String(redirectUri || '').trim();
  if (!uri) throw problem('google_redirect_uri_missing', 503);
  const store = db(env);
  const state = `signin:${randomHex(32)}`;
  const createdAt = now().toISOString();
  const expiresAt = new Date(now().getTime() + GOOGLE_ACCOUNT_STATE_TTL_MS).toISOString();
  await store.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(createdAt).run();
  await store
    .prepare('INSERT INTO oauth_states (state_hash, user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)')
    .bind(await sha256Hex(state), 'signin:pending', expiresAt, createdAt)
    .run();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', String(env.GOOGLE_CLIENT_ID).trim());
  authUrl.searchParams.set('redirect_uri', uri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_ACCOUNT_SIGNIN_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');
  return { url: authUrl.toString(), state, expiresAt };
}

/**
 * Exchange the code, verify the Google profile, then open a Celia account session.
 * Called only after handleGoogleOAuthCallback() consumed the single-use state, so a
 * replayed callback can never reach the token endpoint or create another account.
 */
export async function completeGoogleAccountSignIn({
  env = {},
  code = '',
  redirectUri = '',
  fetchImpl = globalThis.fetch,
  now = () => new Date()
} = {}) {
  if (!configured(env, 'GOOGLE_CLIENT_ID') || !configured(env, 'GOOGLE_CLIENT_SECRET')) {
    return signinFailure('google_oauth_not_configured');
  }
  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code || '').trim(),
      client_id: String(env.GOOGLE_CLIENT_ID).trim(),
      client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(),
      redirect_uri: String(redirectUri || '').trim(),
      grant_type: 'authorization_code'
    }),
    signal: AbortSignal.timeout(12_000)
  }).catch(() => null);
  const tokenData = tokenRes ? await tokenRes.json().catch(() => ({})) : {};
  if (!tokenRes?.ok || !tokenData.access_token) return signinFailure('google_token_exchange_failed');

  // userinfo is fetched with the freshly exchanged access token; no token is persisted.
  const infoRes = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
    signal: AbortSignal.timeout(10_000)
  }).catch(() => null);
  if (!infoRes?.ok) return signinFailure('google_userinfo_verification_failed');
  const profile = await infoRes.json().catch(() => ({}));
  if (profile?.email_verified !== true || !String(profile?.sub || '').trim()) {
    return signinFailure('google_identity_not_verified');
  }

  try {
    const session = await signInWithGoogleIdentity(env, {
      sub: String(profile.sub).trim(),
      email: profile.email,
      emailVerified: true,
      now
    });
    return {
      ok: true,
      status: 302,
      location: '/whatsapp',
      cookies: [session.cookie, STATE_COOKIE_CLEAR]
    };
  } catch (error) {
    const reason = String(error?.message || '');
    return signinFailure(PUBLIC_REASONS.has(reason) ? reason : 'google_signin_failed');
  }
}
