(() => {
  'use strict';
  const EDGE = 'https://celia-phone-google.celiaelazamey.workers.dev';
  const onEdge = document.body.dataset.runtime === 'edge';
  const $ = (id) => document.getElementById(id);
  const state = { signup: null, sessionInfo: null, sdkReady: false, busy: false, testKey: null, accountMode: 'register', user: null };
  const messages = {
    account_session_required: 'سجّل الدخول أو أنشئ حسابًا للمتابعة.',
    account_session_expired: 'انتهت جلسة الحساب. سجّل الدخول من جديد.',
    invalid_email_or_password: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    email_already_registered: 'هذا البريد مسجل بالفعل. استخدم تسجيل الدخول.',
    password_must_be_10_to_128_characters: 'كلمة المرور يجب أن تكون بين 10 و128 حرفًا.',
    too_many_attempts_try_later: 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجددًا.',
    whatsapp_number_already_linked: 'هذا الرقم مربوط بحساب سيليا آخر. سجّل الدخول إلى حساب ذلك النشاط لإدارته.',
    whatsapp_onboarding_not_configured: 'الربط غير مهيأ بعد على الخادم. لا يمكن بدء الربط الآن.',
    whatsapp_session_required: 'افتح هذه الصفحة من زر الربط في سيليا بعد تسجيل دخول المالك.',
    whatsapp_session_expired: 'انتهت جلسة الربط. ارجع إلى سيليا واضغط «اربط واتساب» من جديد.',
    meta_code_exchange_rejected: 'انتهت صلاحية موافقة Meta أو رُفضت. اضغط «اربط واتساب» للمحاولة من جديد.',
    complete_number_ownership_verification_in_meta: 'أكمل إثبات ملكية الرقم داخل نافذة Meta، ثم اضغط «اربط واتساب» مجددًا.',
    select_business_number_in_meta: 'اختر رقم العمل المطلوب داخل نافذة Meta ثم أعد المحاولة.',
    whatsapp_number_not_authorized: 'لم تمنح Meta صلاحية الوصول إلى هذا الرقم. أعد الربط واختر رقم العمل الصحيح.',
    business_app_coexistence_not_enabled: 'هذا الرقم مرتبط بتطبيق WhatsApp Business. الربط الحالي مخصص لـ Cloud API ولا ينقل الرقم من التطبيق.',
    meta_outcome_unknown: 'تعذر تأكيد نتيجة الإعداد لدى Meta. لم نُعد العملية تلقائيًا؛ اضغط الربط للمتابعة بعد التحقق من الحالة.',
    registration_outcome_unknown_reconcile_in_meta: 'نتيجة تسجيل الرقم غير مؤكدة. راجع حالة الرقم في Meta قبل إعادة المحاولة.',
    recipient_not_opted_in: 'المستلم لم يوافق على رسالة الاختبار.',
    outside_24h_customer_window: 'أرسل رسالة من رقم المستلم إلى رقم العمل أولًا، ثم جرّب رسالة الاختبار خلال 24 ساعة.',
    csrf_origin_or_header_mismatch: 'رُفض الطلب لحماية الجلسة. حدّث الصفحة وحاول مجددًا.'
  };
  function describe(error) { return messages[error?.message] || 'تعذر إكمال الطلب. حاول مجددًا أو راجع حالة النظام.'; }
  function status(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`.trim(); }
  function setBusy(value) { state.busy = value; $('connect').disabled = value || !state.sdkReady; }
  async function json(url, options = {}) {
    const response = await fetch(url, { credentials: onEdge ? 'same-origin' : 'omit', ...options, headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json', 'x-celia-request': 'whatsapp' } : {}), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `http_${response.status}`), { status: response.status });
    return body;
  }
  function sessionApi(path, options) { return json(`${onEdge ? '' : EDGE}/api/whatsapp/session/${path}`, options); }
  function post(path, body) { return sessionApi(path, { method: 'POST', body: JSON.stringify(body) }); }
  function renderConnection(connection) {
    const connected = connection?.connected === true;
    $('connected-panel').hidden = !connected;
    $('inbox-panel').hidden = !connected;
    if (!connected) return;
    $('business-name').textContent = connection.businessName || 'نشاط تجاري';
    $('phone-number').textContent = connection.phoneNumber || '';
    status('تم ربط الرقم والتحقق من حالته لدى Meta.', 'ok');
    $('connect').textContent = 'إعادة الربط أو تغيير الرقم';
  }
  function loadSdk(appId, apiVersion) {
    return new Promise((resolve, reject) => {
      if (state.sdkReady) return resolve();
      window.fbAsyncInit = () => {
        window.FB.init({ appId, version: apiVersion, cookie: false, xfbml: false, status: false, autoLogAppEvents: false });
        state.sdkReady = true; resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://connect.facebook.net/ar_AR/sdk.js';
      script.async = true;
      script.onerror = () => reject(new Error('meta_sdk_load_failed'));
      document.head.appendChild(script);
    });
  }
  window.addEventListener('message', (event) => {
    if (!['https://www.facebook.com', 'https://web.facebook.com'].includes(event.origin)) return;
    let payload = event.data;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return; } }
    if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (['FINISH', 'FINISH_ONLY_WABA', 'FINISH_GRANT_ONLY_API_ACCESS'].includes(payload.event)) state.sessionInfo = payload.data || null;
    if (payload.event === 'CANCEL') { status('أُلغيت موافقة Meta. لم يتغير الرقم المرتبط.', 'warn'); setBusy(false); }
    if (payload.event === 'ERROR') { status('أبلغت Meta بخطأ في نافذة الربط. أعد المحاولة.', 'warn'); setBusy(false); }
  });
  async function connect() {
    if (state.busy || !state.sdkReady) return;
    setBusy(true); state.sessionInfo = null;
    try {
      status('جارٍ فتح موافقة Meta…');
      state.signup = await post('start', {});
      const login = await new Promise((resolve) => window.FB.login(resolve, {
        config_id: state.signup.configId, response_type: 'code', override_default_response_type: true,
        extras: { version: state.signup.signupVersion, setup: {}, features: state.signup.features }
      }));
      const code = login?.authResponse?.code;
      if (!code) { status('لم تمنح Meta موافقة الربط. لم يتغير الرقم المرتبط.', 'warn'); return; }
      status('اكتملت موافقة Meta. تتولى سيليا الآن الإعداد والتحقق…');
      // The SDK event may arrive just after FB.login resolves. Never wait beyond the code's short lifetime.
      for (let i = 0; i < 10 && !state.sessionInfo; i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await post('complete', { state: state.signup.state, code, sessionInfo: state.sessionInfo });
      renderConnection(result.connection);
      await refreshInbox();
    } catch (error) { status(describe(error), 'warn'); }
    finally { setBusy(false); }
  }
  async function refreshInbox() {
    try {
      const result = await sessionApi('inbox');
      const list = $('inbox'); list.replaceChildren();
      if (!result.messages.length) { const li = document.createElement('li'); li.textContent = 'لا توجد رسائل بعد.'; list.appendChild(li); return; }
      for (const message of result.messages) {
        const li = document.createElement('li');
        const meta = document.createElement('div'); meta.className = 'meta';
        meta.textContent = `${message.direction === 'inbound' ? 'وارد من' : 'صادر إلى'} ${message.phone_e164} · ${message.status} · ${message.created_at}`;
        const body = document.createElement('p'); body.textContent = message.body || '[رسالة غير نصية]';
        li.append(meta, body); list.appendChild(li);
      }
    } catch (error) { $('test-status').textContent = describe(error); }
  }
  async function sendTest() {
    const phone = $('test-phone').value.trim();
    if (!$('test-consent').checked) { $('test-status').textContent = messages.recipient_not_opted_in; return; }
    $('send-test').disabled = true;
    state.testKey ||= `wa-test-${crypto.randomUUID()}`;
    try {
      await post('test', { phone, consent: true, idempotencyKey: state.testKey });
      $('test-status').textContent = 'قُبلت رسالة الاختبار لدى Meta. راجع الوارد/hاتفك؛ القبول ليس دليل وصول.';
      state.testKey = null; await refreshInbox();
    } catch (error) { $('test-status').textContent = describe(error); if (error.status < 500) state.testKey = null; }
    finally { $('send-test').disabled = false; }
  }
  function accountMode(mode) {
    state.accountMode = mode;
    $('show-register').setAttribute('aria-pressed', String(mode === 'register'));
    $('show-login').setAttribute('aria-pressed', String(mode === 'login'));
    $('account-submit').textContent = mode === 'register' ? 'إنشاء حساب' : 'تسجيل الدخول';
    $('account-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('account-status').textContent = '';
  }
  async function submitAccount(event) {
    event.preventDefault();
    $('account-submit').disabled = true;
    try {
      const result = await json(`/api/account/${state.accountMode}`, { method: 'POST', body: JSON.stringify({ email: $('account-email').value.trim(), password: $('account-password').value }) });
      state.user = result.user;
      $('account-password').value = '';
      await enterApp();
    } catch (error) { $('account-status').textContent = describe(error); }
    finally { $('account-submit').disabled = false; }
  }
  async function logout() {
    try { await json('/api/account/logout', { method: 'POST', body: '{}' }); } catch {}
    state.user = null; state.sdkReady = false;
    $('account-panel').hidden = false; $('link-panel').hidden = true;
    $('connected-panel').hidden = true; $('inbox-panel').hidden = true;
  }
  async function enterApp() {
    $('account-panel').hidden = true;
    $('link-panel').hidden = false;
    const result = await sessionApi('status');
    renderConnection(result.connection);
    if (!result.configured) { status(messages.whatsapp_onboarding_not_configured, 'warn'); return; }
    if (!state.sdkReady) {
      const config = await post('start', {});
      await loadSdk(config.appId, config.apiVersion);
    }
    $('connect').disabled = false;
    if (!result.connection.connected) status('جاهز لبدء الربط عبر Meta.');
    else await refreshInbox();
  }
  async function boot() {
    $('connect').addEventListener('click', connect);
    $('send-test').addEventListener('click', sendTest);
    $('refresh-inbox').addEventListener('click', refreshInbox);
    $('show-register').addEventListener('click', () => accountMode('register'));
    $('show-login').addEventListener('click', () => accountMode('login'));
    $('account-form').addEventListener('submit', submitAccount);
    $('account-logout').addEventListener('click', logout);
    if (!onEdge) {
      $('account-panel').hidden = true;
      status('هذه نسخة معاينة. الربط الحقيقي يعمل على خدمة سيليا المنشورة.', 'warn');
      const link = document.createElement('a');
      link.href = `${EDGE}/whatsapp`;
      link.textContent = 'الانتقال إلى خدمة سيليا';
      link.className = 'primary';
      $('help').replaceChildren(link);
      return;
    }
    try {
      const me = await json('/api/account/me');
      state.user = me.user;
      await enterApp();
    } catch (error) {
      if (error.status !== 401) { status(describe(error), 'warn'); return; }
      $('account-panel').hidden = false;
      $('link-panel').hidden = true;
    }
  }
  boot();
})();
