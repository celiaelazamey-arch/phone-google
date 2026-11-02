// WA-008 — ordinary users sign in to a self-service account with their Google identity.
//
// Design constraints (DEC-065: no owner token, no cross-tenant access):
//   * Reuses the SAME redirect URI as the owner Workspace link flow
//     (`/auth/google/callback`). It MUST be registered once in Google Cloud Console;
//     WA-009 diagnoses that owner-only step instead of dropping the user on Google's
//     English 400 page, and the flow starts working the moment it is registered.
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

/* WA-009 — fail helpfully, never on Google's English 400 page.
 * Google rejects an unregistered `redirect_uri` BEFORE ever sending the user back to
 * us, so the error cannot be caught in the callback. A read-only authorize probe
 * (dummy state, no D1 row, no session, no secret in the URL) lets the Worker detect
 * it first. The probe result is never cached: the moment the owner registers the
 * URI, the very next click goes straight to Google with no redeploy. */
export async function probeGoogleRedirectUri({ env = {}, redirectUri = '', fetchImpl = globalThis.fetch } = {}) {
  if (!configured(env, 'GOOGLE_CLIENT_ID') || !String(redirectUri || '').trim()) {
    return { ok: false, reason: 'google_oauth_not_configured' };
  }
  const probeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  probeUrl.searchParams.set('client_id', String(env.GOOGLE_CLIENT_ID).trim());
  probeUrl.searchParams.set('redirect_uri', String(redirectUri).trim());
  probeUrl.searchParams.set('response_type', 'code');
  probeUrl.searchParams.set('scope', GOOGLE_ACCOUNT_SIGNIN_SCOPES.join(' '));
  probeUrl.searchParams.set('state', `signin:${randomHex(32)}`);
  const response = await fetchImpl(probeUrl.toString(), {
    redirect: 'follow',
    signal: AbortSignal.timeout(8_000)
  }).catch(() => null);
  if (!response) return { ok: false, reason: 'probe_unavailable' };
  const finalUrl = String(response.url || '');
  const body = await response.text().catch(() => '');
  if (finalUrl.includes('/signin/oauth/error') || /redirect_uri_mismatch/i.test(body)) {
    return { ok: false, reason: 'redirect_uri_mismatch' };
  }
  // Any other Google response (sign-in or consent screen) means the URI is accepted.
  return { ok: response.ok !== false, reason: response.ok === false ? 'google_probe_rejected' : null };
}

/** Static, script-free Arabic setup page. Client ID is public; the secret never is. */
export function renderGoogleRedirectSetupPage({ env = {}, redirectUri = '' } = {}) {
  const clientId = String(env?.GOOGLE_CLIENT_ID || '').trim();
  const uri = String(redirectUri || '').trim();
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>إعداد مطلوب — الدخول بحساب Google | سيليا</title>
<style>body{margin:0;background:#0b1020;color:#e8ecff;font-family:Tahoma,Arial,sans-serif;line-height:1.9}main{max-width:44rem;margin:2rem auto;padding:1.25rem}.card{background:#151d38;border:1px solid #273154;border-radius:1rem;padding:1.4rem}h1{font-size:1.4rem;margin:0 0 .6rem}p{margin:.6rem 0}code{display:block;direction:ltr;text-align:left;background:#0e1530;border:1px solid #66739e;border-radius:.6rem;padding:.8rem;margin:.5rem 0;overflow-wrap:anywhere;font-size:.9rem;color:#e8ecff}a,.btn{color:#7c9cff}.btn{display:inline-block;background:#3ddc97;color:#0b1020;font-weight:700;text-decoration:none;border-radius:.65rem;padding:.7rem 1.1rem;margin-top:1rem}small{color:#9aa5c9}</style></head>
<body><main><div class="card"><h1>خطوة واحدة متبقية لتفعيل «الدخول بحساب Google»</h1>
<p>تطبيق OAuth في Google Cloud Console لم يسجّل بعد عنوان العودة الذي تستخدمه سيليا؛ لذلك ترفض Google الطلب بـ <code dir="ltr">redirect_uri_mismatch</code> قبل أن يعود المتصفح إلينا. هذا إعداد بيد مالك التطبيق، ولا يمكن للخادم تغييره.</p>
<p><strong>1.</strong> افتح <a href="https://console.cloud.google.com/apis/credentials">صفحة Credentials</a>، واختر عميل OAuth من نوع <strong>Web application</strong> الذي معرّفه:</p>
<code>${esc(clientId)}</code>
<p><strong>2.</strong> في <strong>Authorized redirect URIs</strong> أضف هذه القيمة حرفيًا (بلا مسافات ولا شرطة مائلة أخيرة)، ثم احفظ:</p>
<code>${esc(uri)}</code>
<p><strong>3.</strong> بعد الحفظ بدقيقة أو دقيقتين اضغط الزر أدناه؛ سيدخل النظام مباشرة دون إعادة نشر.</p>
<a class="btn" href="/auth/google/signin">أعد المحاولة الآن</a>
<p><small>إن كانت شاشة الموافقة في وضع Testing، أضف بريدك في Test users. هذه الصفحة لا تحوي أي سر ولا ترسل أي رمز.</small></p>
</div></main></body></html>`;
}
