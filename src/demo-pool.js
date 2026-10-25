/**
 * In-memory, MySQL-shaped adapter for the FREE offline demo.
 *
 * It intentionally implements only the handful of SQL statements the
 * application issues. It is never loaded by `npm start` / the Docker image:
 * the only entry points that import it are `npm run demo` and its tests.
 * Any unexpected statement fails loudly instead of silently doing nothing.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function result(rows) {
  return [rows];
}

function mutation(affectedRows = 1) {
  return [{ affectedRows, insertId: 1 }];
}

export class DemoPool {
  constructor() {
    this.reset();
    this.closed = false;
  }

  reset() {
    this.users = new Map();
    this.oauthStates = new Map();
    this.credentials = new Map();
    this.contacts = new Map();
    this.messages = new Map();
    this.messageRows = [];
  }

  assertOpen() {
    if (this.closed) throw new Error('Demo pool is closed');
  }

  async query(sql, params = []) {
    return this.execute(sql, params);
  }

  async execute(sql, params = []) {
    this.assertOpen();
    const q = normalize(sql);
    const p = params || [];

    if (q.startsWith('create table')) return result([]);
    if (q === 'select 1') return result([{ '1': 1 }]);

    if (q.startsWith('insert into app_users')) {
      const [id, email, phone] = p;
      this.users.set(id, { id, email: email ?? null, phone_e164: phone ?? null });
      return mutation();
    }

    if (q.startsWith('insert into oauth_states')) {
      const [stateHash, userId] = p;
      this.oauthStates.set(stateHash, { user_id: userId, used_at: null, expires_at: Date.now() + OAUTH_STATE_TTL_MS });
      return mutation();
    }

    if (q.startsWith('select user_id from oauth_states')) {
      const state = this.oauthStates.get(p[0]);
      const valid = state && !state.used_at && state.expires_at > Date.now();
      return result(valid ? [{ user_id: state.user_id }] : []);
    }

    if (q.startsWith('update oauth_states set used_at')) {
      const state = this.oauthStates.get(p[0]);
      if (!state || state.used_at || state.expires_at <= Date.now()) return mutation(0);
      state.used_at = Date.now();
      return mutation(1);
    }

    if (q.startsWith('select encrypted_tokens from google_credentials')) {
      const tokens = this.credentials.get(p[0]);
      return result(tokens ? [{ encrypted_tokens: tokens.encrypted, scopes: tokens.scopes || '' }] : []);
    }

    if (q.startsWith('insert into google_credentials')) {
      const [userId, encrypted, scopes] = p;
      this.credentials.set(userId, { encrypted, scopes: scopes || '' });
      return mutation();
    }

    if (q.startsWith('insert into whatsapp_contacts (phone_e164, opted_in')) {
      const [phone, optedIn, aiOptedIn, consentSource, hasConsent] = p;
      const contact = this.contacts.get(phone) || { phone_e164: phone, last_inbound_at: null };
      contact.opted_in = Boolean(optedIn);
      contact.ai_opted_in = Boolean(optedIn && aiOptedIn);
      contact.consent_source = consentSource;
      contact.consented_at = hasConsent ? new Date().toISOString() : null;
      this.contacts.set(phone, contact);
      return mutation();
    }

    if (q.startsWith('insert into whatsapp_contacts (phone_e164, last_inbound_at)')) {
      const [phone] = p;
      const contact = this.contacts.get(phone) || {
        phone_e164: phone, opted_in: false, ai_opted_in: false, consent_source: null, consented_at: null
      };
      contact.last_inbound_at = new Date().toISOString();
      this.contacts.set(phone, contact);
      return mutation();
    }

    if (q.startsWith('select opted_in, ai_opted_in, last_inbound_at from whatsapp_contacts') ||
        q.startsWith('select opted_in, last_inbound_at from whatsapp_contacts')) {
      const contact = this.contacts.get(p[0]);
      return result(contact ? [{ ...contact }] : []);
    }

    if (q.startsWith('insert ignore into whatsapp_messages') || q.startsWith('insert into whatsapp_messages')) {
      const [providerId, phone, direction, messageType, body, status] = p;
      if (this.messages.has(providerId)) return mutation(0);
      const row = {
        provider_message_id: providerId,
        phone_e164: phone,
        direction,
        message_type: messageType,
        body,
        status,
        created_at: new Date().toISOString()
      };
      this.messages.set(providerId, row);
      this.messageRows.unshift(row);
      return mutation(1);
    }

    throw new Error(`DemoPool received an unsupported statement: ${q}`);
  }

  disconnectGoogle() {
    this.credentials.clear();
  }

  async end() {
    this.closed = true;
  }

  snapshot() {
    return {
      googleConnected: this.credentials.size > 0,
      contacts: [...this.contacts.values()],
      messages: this.messageRows.slice(0, 30),
      counts: {
        users: this.users.size,
        oauthStates: this.oauthStates.size,
        messages: this.messages.size
      }
    };
  }
}
