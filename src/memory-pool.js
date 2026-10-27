export function createMemoryPool({ maxEntries = 500 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid memory store capacity');
  const users = new Map();
  const credentials = new Map();
  const contacts = new Map();
  const messages = new Map();

  const bound = (map) => { while (map.size > maxEntries) map.delete(map.keys().next().value); };
  async function execute(sql, params = []) {
    for (const map of [users, credentials, contacts, messages]) bound(map);
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (/^SELECT 1$/i.test(normalized)) {
      return [[{ 1: 1 }], []];
    }

    if (/^INSERT INTO app_users/i.test(normalized)) {
      const [id, email, phone] = params;
      users.set(id, { id, email: email || null, phone_e164: phone || null });
      return [{ affectedRows: 1 }, []];
    }

    if (/^SELECT encrypted_tokens FROM google_credentials WHERE user_id = \?/i.test(normalized)) {
      const item = credentials.get(params[0]);
      return [item ? [{ encrypted_tokens: item.encrypted_tokens }] : [], []];
    }

    if (/^UPDATE google_credentials SET encrypted_tokens = \? WHERE user_id = \?/i.test(normalized)) {
      const [encryptedTokens, userId] = params;
      const existing = credentials.get(userId) || { user_id: userId, scopes: '' };
      credentials.set(userId, { ...existing, encrypted_tokens: encryptedTokens });
      return [{ affectedRows: 1 }, []];
    }

    if (/^INSERT INTO whatsapp_contacts \(phone_e164, opted_in, ai_opted_in, consent_source, consented_at\)/i.test(normalized)) {
      const [phone, optedIn, aiOptedIn, consentSource, hasConsent] = params;
      const prev = contacts.get(phone) || { last_inbound_at: null };
      if (!contacts.has(phone) && contacts.size >= maxEntries) contacts.delete(contacts.keys().next().value);
      contacts.set(phone, {
        phone_e164: phone,
        opted_in: Boolean(optedIn),
        ai_opted_in: Boolean(aiOptedIn),
        consent_source: consentSource || null,
        consented_at: hasConsent ? new Date().toISOString() : null,
        last_inbound_at: prev.last_inbound_at
      });
      return [{ affectedRows: 1 }, []];
    }

    if (/^INSERT INTO whatsapp_contacts \(phone_e164, last_inbound_at\)/i.test(normalized)) {
      const [phone] = params;
      const prev = contacts.get(phone) || {
        phone_e164: phone,
        opted_in: false,
        ai_opted_in: false,
        consent_source: null,
        consented_at: null
      };
      if (!contacts.has(phone) && contacts.size >= maxEntries) contacts.delete(contacts.keys().next().value);
      contacts.set(phone, { ...prev, last_inbound_at: new Date().toISOString() });
      return [{ affectedRows: 1 }, []];
    }

    if (/^SELECT opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = \?/i.test(normalized) ||
        /^SELECT opted_in, ai_opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = \?/i.test(normalized)) {
      const item = contacts.get(params[0]);
      return [item ? [item] : [], []];
    }

    if (/^SELECT phone_e164, opted_in, ai_opted_in, consent_source, consented_at, last_inbound_at FROM whatsapp_contacts/i.test(normalized)) {
      return [Array.from(contacts.values()), []];
    }

    if (/^INSERT IGNORE INTO whatsapp_messages/i.test(normalized)) {
      const [providerId, phone, direction, type, body, status] = params;
      if (messages.has(providerId)) return [{ affectedRows: 0 }, []];
      if (messages.size >= maxEntries) messages.delete(messages.keys().next().value);
      messages.set(providerId, {
        provider_message_id: providerId,
        phone_e164: phone,
        direction,
        message_type: type,
        body,
        status,
        created_at: new Date().toISOString()
      });
      return [{ affectedRows: 1 }, []];
    }

    return [[], []];
  }

  return {
    isMemory: true,
    execute,
    query: execute,
    end: async () => {}
  };
}
