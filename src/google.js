import crypto from 'node:crypto';
import express from 'express';
import { google } from 'googleapis';
import { requireApiToken } from './auth.js';
import { createServiceRegistry, safeError, ServiceUnavailableError } from './resilience.js';
import { decryptJson, encryptJson, hashOAuthState, safeEqual } from './security.js';
import { createIdempotencyStore, isValidIdempotencyKey } from './idempotency.js';
import { consentTicketDefaults, mintConsentTicket, verifyConsentTicket } from './consent-ticket.js';
import { preflightGoogleConfig } from './google-preflight.js';

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly'
];

function readCookie(req, name) {
  const header = req.get('cookie') || '';
  const item = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

function oauthClient(config) {
  if (!config.google.clientId || !config.google.clientSecret) {
    const error = new Error('Google OAuth is not configured');
    error.status = 503;
    throw error;
  }
  return new google.auth.OAuth2({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: config.google.redirectUri, transporterOptions: { timeout: config.resilience?.timeoutMs || 8000, retry: false } });
}

async function getAuthenticatedClient(pool, config, userId) {
  const [rows] = await pool.execute('SELECT encrypted_tokens FROM google_credentials WHERE user_id = ?', [userId]);
  if (!rows.length) {
    const error = new Error('Google account has not been connected');
    error.status = 409;
    throw error;
  }
  const client = oauthClient(config);
  const tokens = decryptJson(rows[0].encrypted_tokens, config.encryptionKey);
  client.setCredentials(tokens);
  client.on('tokens', (freshTokens) => {
    const merged = { ...tokens, ...freshTokens, refresh_token: freshTokens.refresh_token || tokens.refresh_token };
    pool.execute(
      'UPDATE google_credentials SET encrypted_tokens = ? WHERE user_id = ?',
      [encryptJson(merged, config.encryptionKey), userId]
    ).catch(() => console.error('Could not persist refreshed Google credentials'));
  });
  return client;
}

/**
 * Calendar client over the owner's already-stored Google grant. Exported for the
 * agent calendar connector (AGENT-002); it adds no scope and no secret of its own —
 * without a connected account it throws the same 409 as the REST route.
 */
export async function createGoogleCalendarClient({ pool, config, userId }) {
  const client = await getAuthenticatedClient(pool, config, userId);
  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Drive client over the owner's already-stored Google grant. Exported for the
 * agent Drive export connector (AGENT-002); without a connected account it throws
 * the same 409 as the REST route.
 */
export async function createGoogleDriveClient({ pool, config, userId }) {
  const client = await getAuthenticatedClient(pool, config, userId);
  return google.drive({ version: 'v3', auth: client });
}

/**
 * Newest INBOX messages for the owner's WhatsApp commands ("لخص آخر إيميل", "الإيميلات الجديدة").
 * No `is:unread` filter unless asked: "the last email" must come back even when already read.
 * `gmailClient` is injectable so the command path is testable without Google.
 */
export async function fetchInboxMessages({ pool, config, userId = config.userId, unreadOnly = false, maxResults = 1, signal, gmailClient } = {}) {
  const gmail = gmailClient || google.gmail({ version: 'v1', auth: await getAuthenticatedClient(pool, config, userId) });
  const requestOptions = { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 };
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 1));
  const listed = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults: limit, ...(unreadOnly ? { q: 'is:unread' } : {}) }, requestOptions);
  const ids = (listed.data?.messages || []).map((entry) => entry.id).filter(Boolean);
  const messages = await Promise.all(ids.map(async (id) => {
    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }, requestOptions);
    const headers = Object.fromEntries((data?.payload?.headers || []).map((header) => [String(header.name || '').toLowerCase(), header.value]));
    const internal = Number(data?.internalDate);
    return {
      id,
      from: headers.from || '',
      subject: headers.subject || '',
      date: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : (headers.date || ''),
      snippet: data?.snippet || '',
      unread: (data?.labelIds || []).includes('UNREAD')
    };
  }));
  return messages;
}

/**
 * Primary-calendar events between two instants for the owner's "جدولي" command. `calendarClient`
 * is injectable for tests; without a connected account it throws the same 409 as the REST route.
 */
export async function listAgendaEvents({ pool, config, userId = config.userId, timeMin, timeMax, maxResults = 20, signal, calendarClient } = {}) {
  const calendar = calendarClient || google.calendar({ version: 'v3', auth: await getAuthenticatedClient(pool, config, userId) });
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: Math.max(1, Math.min(50, Number(maxResults) || 20))
  }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
  return (data?.items || []).map((event) => ({
    id: event.id,
    summary: event.summary || '',
    status: event.status || 'confirmed',
    location: event.location || '',
    start: event.start || {},
    end: event.end || {}
  }));
}

function handleError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 502;
  if (status >= 500) console.error('Google integration request failed:', error.code || 'upstream_failed');
  if (error instanceof ServiceUnavailableError) return res.status(503).json({ error: safeError(error), outcomeUnknown: error.outcomeUnknown });
  return res.status(status).json({ error: status === 503 ? 'google_not_configured' : status === 409 ? 'google_not_connected' : 'google_request_failed' });
}

/**
 * Mints a single-use Google connection link for the owner and records its state hash so the
 * callback can consume it exactly once. Shared by the REST route and the WhatsApp owner command.
 */
export async function createGoogleConsentLink({ pool, config, now = Date.now() }) {
  oauthClient(config);
  const { ticket, expiresAt } = mintConsentTicket({ userId: config.userId, encryptionKey: config.encryptionKey, now });
  await pool.execute(
    'INSERT INTO oauth_states (state_hash, user_id, expires_at) VALUES (?, ?, FROM_UNIXTIME(?))',
    [hashOAuthState(ticket), config.userId, Math.floor(expiresAt.getTime() / 1000)]
  );
  const base = String(config.baseUrl || '').replace(/\/+$/, '');
  return {
    url: `${base}/auth/google?ticket=${encodeURIComponent(ticket)}`,
    expiresAt: expiresAt.toISOString(),
    singleUse: true
  };
}

export function createGoogleRouter({ pool, config, services = createServiceRegistry(config), idempotencyStore = createIdempotencyStore(), env = process.env }) {
  const router = express.Router();
  const guarded = (name, action, sideEffect = false) => services.run(name, (signal) =>
    action({ signal, timeout: config.resilience?.timeoutMs || 8000, retry: false }), { sideEffect });
  router.use((req, res, next) => {
    if ((req.path.startsWith('/api/google') || req.path.startsWith('/auth/google')) && config.features?.google === false) {
      return res.status(503).json({ error: 'google_disabled' });
    }
    next();
  });

  const ownerOnly = requireApiToken(config);
  const startAuthorization = (res, state) => {
    const client = oauthClient(config);
    res.cookie('google_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: consentTicketDefaults.ttlMs,
      path: '/auth/google/callback'
    });
    return res.redirect(client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state
    }));
  };

  // Owner-token entry point (unchanged contract): mints a fresh state and redirects to Google.
  // A single-use signed ticket may be supplied instead, so a chat client can hand the owner a
  // link without ever seeing APP_API_TOKEN. An invalid or already-used ticket is rejected.
  router.get('/auth/google', async (req, res, next) => {
    try {
      const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
      if (ticket) {
        const verified = verifyConsentTicket(ticket, { encryptionKey: config.encryptionKey, userId: config.userId });
        if (!verified.ok) return res.status(400).send('This connection link is invalid or has expired. Request a new link from the assistant.');
        const [rows] = await pool.execute(
          'SELECT user_id FROM oauth_states WHERE state_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()',
          [hashOAuthState(ticket)]
        );
        if (!rows.length) return res.status(400).send('This connection link was already used or has expired. Request a new link from the assistant.');
        return startAuthorization(res, ticket);
      }
      return ownerOnly(req, res, () => {
        const state = crypto.randomBytes(32).toString('hex');
        pool.execute(
          'INSERT INTO oauth_states (state_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))',
          [hashOAuthState(state), config.userId]
        ).then(() => startAuthorization(res, state)).catch(next);
      });
    } catch (error) { return next(error); }
  });

  router.get('/auth/google/callback', async (req, res, next) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const cookieState = readCookie(req, 'google_oauth_state');
      res.clearCookie('google_oauth_state', { path: '/auth/google/callback', sameSite: 'lax', secure: config.nodeEnv === 'production' });
      if (!state || !safeEqual(state, cookieState) || typeof req.query.code !== 'string') {
        return res.status(400).send('OAuth verification failed. Return to the app and try again.');
      }
      const stateHash = hashOAuthState(state);
      const [rows] = await pool.execute(
        'SELECT user_id FROM oauth_states WHERE state_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()',
        [stateHash]
      );
      if (!rows.length) return res.status(400).send('This authorization request expired or was already used.');
      const [consume] = await pool.execute(
        'UPDATE oauth_states SET used_at = UTC_TIMESTAMP() WHERE state_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()',
        [stateHash]
      );
      if (consume.affectedRows !== 1) return res.status(400).send('This authorization request was already used.');

      const client = oauthClient(config);
      const { tokens } = await guarded('google.oauth', () => client.getToken(req.query.code), true);
      if (config.google.allowedEmail) {
        if (!tokens.id_token) return res.status(403).send('Google account identity was not returned. Reconnect and try again.');
        const ticket = await guarded('google.oauth', () => client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId }));
        const identity = ticket.getPayload();
        if (!identity?.email_verified || identity.email?.toLowerCase() !== config.google.allowedEmail) {
          return res.status(403).send('The selected Google account does not match the configured owner email.');
        }
      }
      const userId = rows[0].user_id;
      const [oldRows] = await pool.execute('SELECT encrypted_tokens FROM google_credentials WHERE user_id = ?', [userId]);
      const previous = oldRows.length ? decryptJson(oldRows[0].encrypted_tokens, config.encryptionKey) : {};
      const merged = { ...previous, ...tokens, refresh_token: tokens.refresh_token || previous.refresh_token };
      if (!merged.refresh_token) return res.status(400).send('Google did not return a refresh token. Revoke the app grant and reconnect.');
      await pool.execute(
        `INSERT INTO google_credentials (user_id, encrypted_tokens, scopes) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE encrypted_tokens = VALUES(encrypted_tokens), scopes = VALUES(scopes)`,
        [userId, encryptJson(merged, config.encryptionKey), (tokens.scope || '').split(' ').filter(Boolean).join(' ')]
      );
      return res.status(200).send('Google account connected. You may close this page and return to the assistant.');
    } catch (error) { return next(error); }
  });

  router.use('/api', requireApiToken(config));

  // Owner-only, offline: explains why the connection is failing before a browser is opened.
  // The report never contains a secret value (see src/google-preflight.js).
  router.get('/api/google/preflight', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(preflightGoogleConfig(env));
  });

  // Owner-only: returns a single-use, ten-minute connection link that can be delivered in chat.
  router.post('/api/google/consent-link', async (_req, res, next) => {
    try {
      oauthClient(config);
      const link = await createGoogleConsentLink({ pool, config });
      return res.json(link);
    } catch (error) { return next(error); }
  });

  router.get('/api/google/gmail/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').slice(0, 500);
      if (!q) return res.status(400).json({ error: 'query_required' });
      const client = await getAuthenticatedClient(pool, config, config.userId);
      const gmail = google.gmail({ version: 'v1', auth: client });
      const listed = await guarded('google.gmail', (options) => gmail.users.messages.list({ userId: 'me', q, maxResults: 10 }, options));
      const messages = await Promise.all((listed.data.messages || []).map(async ({ id }) => {
        const { data } = await guarded('google.gmail', (options) => gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] }, options));
        const headers = Object.fromEntries((data.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
        return { id, snippet: data.snippet || '', from: headers.from || '', to: headers.to || '', subject: headers.subject || '', date: headers.date || '' };
      }));
      return res.json({ messages });
    } catch (error) { return handleError(res, error); }
  });

  router.get('/api/google/drive/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 200);
      if (!q) return res.status(400).json({ error: 'query_required' });
      const client = await getAuthenticatedClient(pool, config, config.userId);
      const drive = google.drive({ version: 'v3', auth: client });
      const escaped = q.replaceAll("'", "\\'");
      const { data } = await guarded('google.drive', (options) => drive.files.list({
        q: `trashed = false and name contains '${escaped}'`,
        pageSize: 20,
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
      }, options));
      return res.json({ files: data.files || [] });
    } catch (error) { return handleError(res, error); }
  });

  router.get('/api/google/calendar/events', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(30, Number(req.query.days) || 7));
      const client = await getAuthenticatedClient(pool, config, config.userId);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const now = new Date();
      const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const { data } = await guarded('google.calendar', (options) => calendar.events.list({
        calendarId: 'primary', timeMin: now.toISOString(), timeMax: until.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 50,
        fields: 'items(id,summary,start,end,htmlLink,status)'
      }, options));
      return res.json({ events: data.items || [] });
    } catch (error) { return handleError(res, error); }
  });

  router.post('/api/google/calendar/events', async (req, res) => {
    try {
      const { summary, start, end, timeZone } = req.body || {};
      if (typeof summary !== 'string' || !summary.trim() || typeof start !== 'string' || typeof end !== 'string') {
        return res.status(400).json({ error: 'summary_start_end_required' });
      }
      const startDate = new Date(start), endDate = new Date(end);
      if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
        return res.status(400).json({ error: 'invalid_event_time_range' });
      }
      const headerKey = req.get('Idempotency-Key') || req.get('idempotency-key') || '';
      const bodyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : (typeof req.body?.idempotency_key === 'string' ? req.body.idempotency_key : '');
      const idempotencyKey = isValidIdempotencyKey(headerKey) ? headerKey : (isValidIdempotencyKey(bodyKey) ? bodyKey : null);
      if (idempotencyKey) {
        const cached = idempotencyStore.get(idempotencyKey);
        if (cached) {
          if (cached._idempotencyStatus === 'in_progress') return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
          return res.status(200).json({ ...cached, _idempotencyReplay: true });
        }
        if (!idempotencyStore.claim(idempotencyKey)) {
          const again = idempotencyStore.get(idempotencyKey);
          if (again?._idempotencyStatus === 'in_progress') return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
          if (again) return res.status(200).json({ ...again, _idempotencyReplay: true });
        }
      }
      try {
        const client = await getAuthenticatedClient(pool, config, config.userId);
        const calendar = google.calendar({ version: 'v3', auth: client });
        const { data } = await guarded('google.calendar', (options) => calendar.events.insert({
          calendarId: 'primary',
          requestBody: { summary: summary.trim().slice(0, 200), start: { dateTime: startDate.toISOString(), ...(timeZone ? { timeZone: String(timeZone).slice(0, 100) } : {}) }, end: { dateTime: endDate.toISOString(), ...(timeZone ? { timeZone: String(timeZone).slice(0, 100) } : {}) } },
          fields: 'id,summary,start,end,htmlLink,status'
        }, options), true);
        const result = { event: data };
        if (idempotencyKey) idempotencyStore.complete(idempotencyKey, result);
        return res.status(201).json(result);
      } catch (inner) {
        if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
        throw inner;
      }
    } catch (error) { return handleError(res, error); }
  });

  router.get('/api/google/contacts/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLocaleLowerCase().slice(0, 100);
      if (!q) return res.status(400).json({ error: 'query_required' });
      const client = await getAuthenticatedClient(pool, config, config.userId);
      const people = google.people({ version: 'v1', auth: client });
      const { data } = await guarded('google.contacts', (options) => people.people.connections.list({
        resourceName: 'people/me', pageSize: 100, personFields: 'names,phoneNumbers,emailAddresses'
      }, options));
      const contacts = (data.connections || []).map((person) => ({
        name: person.names?.[0]?.displayName || '',
        phones: (person.phoneNumbers || []).map((item) => item.value),
        emails: (person.emailAddresses || []).map((item) => item.value)
      })).filter((person) => [person.name, ...person.phones, ...person.emails].some((value) => value.toLocaleLowerCase().includes(q)));
      return res.json({ contacts: contacts.slice(0, 20) });
    } catch (error) { return handleError(res, error); }
  });

  return router;
}
