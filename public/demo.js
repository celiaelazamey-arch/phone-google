/* Free offline demo dashboard — same-origin calls only, no CDN, no secrets in code. */
const TOKEN = document.querySelector('meta[name="demo-token"]').content;
let lastMessageId = '';

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data };
}

const show = (id, value) => {
  document.getElementById(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};
const phone = () => document.getElementById('phone').value.trim();
const text = () => document.getElementById('message').value.trim() || 'مرحبًا';
const consentBody = (on) => ({
  optedIn: on,
  aiOptedIn: on,
  source: on ? 'نموذج موافقة تجريبي موثق' : ''
});

const actions = {
  'google-connect': async () => show('out-google', await call('/demo/google/connect', { method: 'POST' })),
  'google-disconnect': async () => show('out-google', await call('/demo/google/disconnect', { method: 'POST' })),
  gmail: async () => show('out-google', await call('/api/google/gmail/search?q=report')),
  drive: async () => show('out-google', await call(`/api/google/drive/search?q=${encodeURIComponent('دليل')}`)),
  calendar: async () => show('out-google', await call('/api/google/calendar/events?days=7')),
  'calendar-create': async () => {
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    show('out-google', await call('/api/google/calendar/events', {
      method: 'POST',
      body: { summary: 'موعد تجريبي', start: start.toISOString(), end: end.toISOString() }
    }));
  },
  contacts: async () => show('out-google', await call(`/api/google/contacts/search?q=${encodeURIComponent('أحمد')}`)),
  'consent-on': async () => show('out-consent', await call(`/api/whatsapp/contacts/${encodeURIComponent(phone().replace(/^\+/, ''))}/consent`, { method: 'POST', body: consentBody(true) })),
  'consent-off': async () => show('out-consent', await call(`/api/whatsapp/contacts/${encodeURIComponent(phone().replace(/^\+/, ''))}/consent`, { method: 'POST', body: consentBody(false) })),
  inbound: async () => {
    const result = await call('/demo/webhook/inbound', { method: 'POST', body: { phone: phone(), text: text() } });
    if (result.data?.messageId) lastMessageId = result.data.messageId;
    show('out-inbound', result);
  },
  'inbound-bad': async () => show('out-inbound', await call('/demo/webhook/inbound', { method: 'POST', body: { phone: phone(), text: text(), badSignature: true } })),
  send: async () => show('out-inbound', await call('/api/whatsapp/messages', { method: 'POST', body: { phone: phone(), text: 'رسالة فردية من لوحة التحكم التجريبية.' } })),
  duplicate: async () => show('out-inbound', await call('/demo/webhook/inbound', {
    method: 'POST',
    body: { phone: phone(), text: text(), messageId: lastMessageId || 'wamid.in.demo-duplicate' }
  })),
  refresh: async () => refreshState(),
  reset: async () => { await call('/demo/reset', { method: 'POST' }); await refreshState(); }
};

async function refreshState() {
  const { status, data } = await call('/demo/state');
  if (status !== 200) {
    show('out-contacts', data);
    return;
  }
  document.getElementById('google-state').textContent = data.googleConnected ? 'متصل (رموز مشفّرة)' : 'غير متصل';
  document.getElementById('providers').textContent = Object.entries(data.providers || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
  const stats = [
    ['جهات الاتصال', data.contacts?.length || 0],
    ['الرسائل المسجّلة', data.counts?.messages || 0],
    ['رسائل WhatsApp الصادرة', data.outbox?.length || 0],
    ['الرد الآلي', data.autoReplyEnabled ? 'مفعّل' : 'معطّل']
  ];
  document.getElementById('stats').innerHTML = stats.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');
  show('out-contacts', data.contacts?.length ? data.contacts : 'لا توجد جهات اتصال بعد.');
  show('out-messages', data.messages?.length ? data.messages : 'لا توجد رسائل بعد.');
  show('out-outbox', data.outbox?.length ? data.outbox : 'صندوق الصادر فارغ.');
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    await actions[button.dataset.act]?.();
    await refreshState();
  } catch (error) {
    console.error(error);
  } finally {
    button.disabled = false;
  }
});

(async () => {
  try {
    const health = await call('/health', { auth: false });
    const pill = document.getElementById('health-pill');
    pill.textContent = health.status === 200 ? `الخدمة تعمل · ${health.data.mode}` : 'الخدمة غير متاحة';
    if (health.status !== 200) pill.classList.add('bad');
  } catch {
    document.getElementById('health-pill').textContent = 'تعذّر الاتصال';
  }
  await refreshState();
})();
