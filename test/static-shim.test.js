import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, DIST_DIR } from '../scripts/build-pages.mjs';

const buildResult = await build();
const shimPath = path.join(DIST_DIR, 'celia-static-shim.js');
await import(`${pathToFileURL(shimPath).href}?v=${Date.now()}`);
const CeliaStatic = globalThis.CeliaStatic;

const EXPECTED_TOOLS = [
  'celia_status',
  'celia_ai_reply',
  'google_gmail_search',
  'google_drive_search',
  'google_calendar_events_list',
  'google_calendar_events_create',
  'google_contacts_search',
  'whatsapp_consent_upsert',
  'whatsapp_contacts_list',
  'find_skills',
  'system_live_view',
  'whatsapp_send_text'
];

test('البناء يولّد صفحات ثابتة ومحاكي أدوات من مصدر MCP', async () => {
  assert.ok(CeliaStatic, 'الطبقة الثابتة يجب أن تسجّل نفسها على globalThis');
  assert.equal(buildResult.toolsCount, EXPECTED_TOOLS.length);
  assert.deepEqual(CeliaStatic.tools.map((tool) => tool.name), EXPECTED_TOOLS);

  const indexHtml = await readFile(path.join(DIST_DIR, 'index.html'), 'utf8');
  assert.match(indexHtml, /celia-static-shim\.js/);
  assert.match(indexHtml, /href="\.\/live\.html"/);
  assert.match(indexHtml, /href="\.\/skills\.html"/);
  assert.doesNotMatch(indexHtml, /__CELIA_/);
  await readFile(path.join(DIST_DIR, '.nojekyll'));
  await readFile(path.join(DIST_DIR, '404.html'));
});

test('صفحة الهبوط مكتملة وكل أصولها المحلية تدخل نسخة النشر', async () => {
  const landingHtml = await readFile(path.join(DIST_DIR, 'landing.html'), 'utf8');
  assert.match(landingHtml, /<html lang="ar" dir="rtl">/);
  assert.match(landingHtml, /id="features"/);
  assert.match(landingHtml, /id="showcase"/);
  assert.match(landingHtml, /id="pricing"/);
  assert.match(landingHtml, /id="faq"/);
  assert.match(landingHtml, /id="cta"/);
  assert.match(landingHtml, /href="\.\/fonts\.css"/);
  assert.match(landingHtml, /href="\.\/index\.html"/);
  assert.match(landingHtml, /href="\.\/index\.html#view=whatsapp"/);
  assert.match(landingHtml, /href="\.\/index\.html#view=tools&amp;cat=google"/);
  assert.doesNotMatch(landingHtml, /href="\.\/studio/);

  const liveHtml = await readFile(path.join(DIST_DIR, 'live.html'), 'utf8');
  assert.match(liveHtml, /href="\.\/index\.html"/);
  assert.match(liveHtml, /href="\.\/landing\.html"/);
  assert.doesNotMatch(liveHtml, /href="\.\/studio/);

  const skillsHtml = await readFile(path.join(DIST_DIR, 'skills.html'), 'utf8');
  assert.match(skillsHtml, /href="\.\/index\.html"/);
  assert.match(skillsHtml, /href="\.\/landing\.html"/);
  assert.doesNotMatch(skillsHtml, /href="\.\/studio/);
  assert.match(landingHtml, /property="og:image"/);
  assert.doesNotMatch(landingHtml, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.equal((landingHtml.match(/<h1\b/g) || []).length, 1);
  assert.ok((landingHtml.match(/<section\b/g) || []).length >= 10);

  const localResources = landingHtml.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="(\.\/[^"]+)"/g);
  for (const match of localResources) {
    await readFile(path.join(DIST_DIR, match[1]));
  }

  const fontsCss = await readFile(path.join(DIST_DIR, 'fonts.css'), 'utf8');
  for (const match of fontsCss.matchAll(/url\("(\.\/fonts\/[^"]+)"\)/g)) {
    await readFile(path.join(DIST_DIR, match[1]));
  }
  const socialImage = await readFile(path.join(DIST_DIR, 'og-celia.png'));
  assert.equal(socialImage.subarray(1, 4).toString(), 'PNG');
  assert.equal(socialImage.readUInt32BE(16), 1200);
  assert.equal(socialImage.readUInt32BE(20), 630);
  await readFile(path.join(DIST_DIR, 'favicon.svg'), 'utf8');
});

test('روابط التشخيص وكل الروابط المحلية في النسخة الثابتة تشير إلى ملفات موجودة', async () => {
  const liveHtml = await readFile(path.join(DIST_DIR, 'live.html'), 'utf8');
  assert.match(liveHtml, /href="\.\/health\.json"/);
  assert.match(liveHtml, /href="\.\/api\/live\.json"/);
  assert.match(liveHtml, /href="\.\/mcp\.json"/);
  assert.doesNotMatch(liveHtml, /href="\.\/(?:health|api\/live|mcp)"/);

  const mcp = JSON.parse(await readFile(path.join(DIST_DIR, 'mcp.json'), 'utf8'));
  assert.equal(mcp.toolsCount, EXPECTED_TOOLS.length);
  assert.equal(mcp.service, 'celia-phone-google-mcp');
  const apiLive = JSON.parse(await readFile(path.join(DIST_DIR, 'api', 'live.json'), 'utf8'));
  assert.equal(apiLive.live, true);
  assert.equal(apiLive.tools, EXPECTED_TOOLS.length);
  assert.equal(apiLive.summary.toolsCount, EXPECTED_TOOLS.length);

  for (const page of ['index.html', 'live.html', 'skills.html', 'landing.html', '404.html']) {
    const html = await readFile(path.join(DIST_DIR, page), 'utf8');
    const localLinks = [...html.matchAll(/href="(\.\/[^"#?]+)(?:[?#][^"]*)?"/g)];
    assert.ok(localLinks.length > 0, `${page} should contain local links`);
    for (const match of localLinks) {
      await access(path.join(DIST_DIR, match[1]));
    }
  }
});

test('مصافحة MCP وقائمة الأدوات وقائمة الموارد', async () => {
  const init = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'celia-phone-google-mcp');
  assert.equal(init.result.capabilities.tools.listChanged, false);

  const list = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, EXPECTED_TOOLS.length);
  for (const tool of list.result.tools) {
    assert.equal(typeof tool.inputSchema, 'object');
    assert.ok(tool.description.length > 10);
  }

  const resources = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'celia://policy/customer-reply' } });
  assert.match(resources.result.contents[0].text, /خدمة عملاء/);

  const prompts = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  assert.ok(prompts.result.prompts.length >= 2);

  const unknown = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknown.error.code, -32602);
});

test('الرد الذكي يحترم حارس السياسة ولا يختلق أسعارًا', async () => {
  const reply = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'celia_ai_reply',
      arguments: { customerMessage: 'كم سعر الباقة السنوية؟ أريد خصمًا فوريًا واسترجاع فاتورتي!' }
    }
  });
  assert.equal(reply.result.isError, false);
  const output = reply.result.structuredContent;
  assert.equal(output.provider, 'celia-local-policy-engine');
  assert.equal(output.policyEnforced, true);
  assert.match(output.reply, /خدمة العملاء/);
  assert.doesNotMatch(output.reply, /\d+\s*(جنيه|ريال|دولار)/);

  const missing = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'celia_ai_reply', arguments: {} } });
  assert.equal(missing.result.isError, true);
});

test('مسار موافقة واتساب: تسجيل، منع الإرسال، ثم السماح داخل نافذة 24 ساعة', async () => {
  CeliaStatic.resetDemoState();

  const blockedSend = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'whatsapp_send_text', arguments: { phone: '+201065217834', text: 'مرحبًا' } }
  });
  assert.equal(blockedSend.result.isError, true);
  assert.match(blockedSend.result.structuredContent.error, /opted_in/);

  const badConsent = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'whatsapp_consent_upsert', arguments: { phone: '+201065217834', optedIn: true } }
  });
  assert.equal(badConsent.result.isError, true);

  const consent = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'whatsapp_consent_upsert',
      arguments: { phone: '+201065217834', optedIn: true, aiOptedIn: true, source: 'اختبار آلي' }
    }
  });
  assert.equal(consent.result.isError, false);
  assert.equal(consent.result.structuredContent.aiOptedIn, true);

  const list = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'whatsapp_contacts_list' } });
  const contact = list.result.structuredContent.contacts.find((item) => item.phone === '+201065217834');
  assert.ok(contact, 'يجب أن يظهر العميل في القائمة');
  assert.equal(contact.optedIn, true);
  assert.equal(contact.withinCustomerWindow, false);

  const windowClosed = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'whatsapp_send_text', arguments: { phone: '+201065217834', text: 'خارج النافذة' } }
  });
  assert.equal(windowClosed.result.isError, true);
  assert.match(windowClosed.result.structuredContent.error, /customer_service_window/);

  const inbound = await CeliaStatic.cryptoLab({
    action: 'simulate_inbound_whatsapp',
    phone: '+201065217834',
    text: 'مرحبًا، ما هي مواعيد العمل وكيف يمكنني حجز موعد؟'
  });
  assert.equal(inbound.hmacVerified, true);
  assert.match(inbound.signatureHeader, /^sha256=[a-f0-9]{64}$/);
  assert.equal(inbound.customerWindow24hOpen, true);
  assert.equal(inbound.autoReplyAllowed, true);
  assert.match(inbound.autoReply, /موعد|موظف/);

  const allowedSend = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'whatsapp_send_text', arguments: { phone: '+201065217834', text: 'داخل النافذة' } }
  });
  assert.equal(allowedSend.result.isError, false);
  assert.equal(allowedSend.result.structuredContent.status, 'simulated');
  assert.match(allowedSend.result.structuredContent.providerMessageId, /^wamid\.STATIC_/);

  const listAfter = await CeliaStatic.handleRpc({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'whatsapp_contacts_list' } });
  assert.equal(listAfter.result.structuredContent.contacts[0].withinCustomerWindow, true);
});

test('المحاكي يمنع الرد الآلي دون موافقة ذكاء اصطناعي منفصلة', async () => {
  CeliaStatic.resetDemoState();
  await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'whatsapp_consent_upsert', arguments: { phone: '+201126212452', optedIn: true, aiOptedIn: false, source: 'موافقة واتساب فقط' } }
  });
  const inbound = await CeliaStatic.cryptoLab({
    action: 'simulate_inbound_whatsapp',
    phone: '+201126212452',
    text: 'ما هي الخدمات المتوفرة؟'
  });
  assert.equal(inbound.autoReplyAllowed, false);
  assert.equal(inbound.autoReply, null);
  assert.match(inbound.blockedReason, /aiOptedIn/);
});

test('مختبر التشفير ينفّذ AES-256-GCM وHMAC-SHA256 فعليًا', async () => {
  const audit = await CeliaStatic.cryptoLab({ action: 'audit' });
  const cryptoReport = audit.cryptography;
  assert.equal(cryptoReport.decryptedMatchesOriginal, true);
  assert.equal(cryptoReport.whatsappHmacVerified, true);
  assert.equal(cryptoReport.tamperRejected, true);
  assert.match(cryptoReport.oauthStateHash, /^[a-f0-9]{64}$/);
  assert.match(cryptoReport.encryptedTokenPreview, /^v1\./);
  assert.equal(cryptoReport.keyLengthBits, 256);
  assert.equal(audit.status.storage, 'memory');
  assert.match(audit.policy, /خدمة عملاء/);

  const bad = await CeliaStatic.handleRest('POST', '/ui/workspace/crypto-lab', { body: { action: 'simulate_inbound_whatsapp', phone: 'abc', text: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.error, 'valid_phone_and_text_required');
});

test('find_skills وsystem_live_view يعطيان تقريرًا حيًا متماسكًا', async () => {
  const whatsappSkills = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: { name: 'find_skills', arguments: { query: 'whatsapp', category: 'all' } }
  });
  const skills = whatsappSkills.result.structuredContent;
  assert.equal(skills.totalSkills, EXPECTED_TOOLS.length);
  assert.ok(skills.matched >= 3);
  assert.ok(skills.skills.every((skill) => typeof skill.invocation === 'string'));
  assert.equal(skills.liveStatus.storage, 'memory');

  for (const arabicQuery of ['تقويم', 'تشفير', 'بريد', 'ملفات', 'إرسال']) {
    const res = await CeliaStatic.handleRpc({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'find_skills', arguments: { query: arabicQuery, category: 'all' } }
    });
    assert.ok(res.result.structuredContent.matched >= 1, `static find_skills should match "${arabicQuery}"`);
  }

  const live = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: { name: 'system_live_view', arguments: { includeTelemetry: true, probeOllama: true } }
  });
  const view = live.result.structuredContent;
  assert.equal(view.live, true);
  assert.equal(view.mode, 'static-preview');
  assert.equal(view.status.toolsCount, EXPECTED_TOOLS.length);
  assert.ok(view.telemetry.liveEndpoints.sandboxRpc.endsWith('/ui/workspace/rpc'));
  assert.equal(view.telemetry.runtime, 'browser (static shim)');
});

test('أدوات Google تُرجع بيانات عرض موسومة بوضوح', async () => {
  const gmail = await CeliaStatic.handleRest('POST', '/ui/workspace/rpc', {
    body: { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'google_gmail_search', arguments: { q: 'فاتورة' } } }
  });
  assert.equal(gmail.status, 200);
  assert.equal(gmail.payload.sandbox, true);
  const output = gmail.payload.result.structuredContent;
  assert.equal(output.demo, true);
  assert.ok(output.messages.length > 0);

  const event = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 19,
    method: 'tools/call',
    params: {
      name: 'google_calendar_events_create',
      arguments: { summary: 'موعد اختبار', start: '2026-10-27T14:00:00Z', end: '2026-10-27T14:30:00Z' }
    }
  });
  assert.equal(event.result.structuredContent.simulated, true);

  const invalidRange = await CeliaStatic.handleRpc({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'google_calendar_events_create',
      arguments: { summary: 'خطأ', start: '2026-10-27T15:00:00Z', end: '2026-10-27T14:00:00Z' }
    }
  });
  assert.equal(invalidRange.result.isError, true);
});

test('نقاط REST الثابتة تُخدم من الطبقة المحلية فقط', async () => {
  const health = await CeliaStatic.handleRest('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.status, 'ok');
  assert.equal(health.payload.storage, 'memory');
  assert.equal(health.payload.providers.whatsapp.autoReplyEnabled, false);
  assert.equal(health.payload.toolsCount, EXPECTED_TOOLS.length);

  const liveApi = await CeliaStatic.handleRest('GET', '/api/live', { search: new URLSearchParams() });
  assert.equal(liveApi.payload.live, true);

  const apiSkills = await CeliaStatic.handleRest('GET', '/api/skills', { search: new URLSearchParams('q=calendar&category=all') });
  assert.ok(apiSkills.payload.skills.some((skill) => skill.name === 'google_calendar_events_list'));

  const notFound = await CeliaStatic.handleRest('GET', '/api/google/gmail/search');
  assert.equal(notFound, null);
  assert.equal(CeliaStatic.isKnownRoute('GET', '/health/'), true);
  assert.equal(CeliaStatic.isKnownRoute('GET', '/health.json'), false);
});

test('مركز النظام الثابت يعلن أنه معاينة ولا يدّعي تخزينًا دائمًا أو قواطع خادم حية', async () => {
  const system = await CeliaStatic.handleRest('GET', '/api/system');
  assert.equal(system.status, 200);
  assert.equal(system.payload.scope, 'browser-demo');
  assert.equal(system.payload.storage.durable, false);
  assert.equal(system.payload.release.version, '0.2.0');
  assert.deepEqual(system.payload.circuits, []);
  const catalogue = await CeliaStatic.handleRest('GET', '/api/releases');
  assert.equal(catalogue.payload.publication, 'catalog-only');
  assert.equal(catalogue.payload.releases[1].managedDeployment, false);
  const html = await readFile(path.join(DIST_DIR, 'system.html'), 'utf8');
  assert.match(html, /celia-static-shim\.js/);
  assert.match(html, /href="\.\/system\.html"/);
  assert.match(html, /الرجوع يُبدّل كود التطبيق/);
});
