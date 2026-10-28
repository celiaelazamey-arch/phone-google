// Argument validation is the boundary that stops the model from smuggling a secret or an unbounded write into
// a tool call. Every rule below is a refusal the runtime depends on, so each one is asserted explicitly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry, RISK, validateToolInput } from '../src/agent/tools.js';

const tool = (overrides = {}) => ({ name: 'demo.read', risk: RISK.read, arguments: { query: 'string' }, ...overrides });

test('tool validation: an unknown tool and non-object arguments are refused', () => {
  assert.equal(validateToolInput(null, { query: 'x' }).code, 'unknown_tool');
  assert.equal(validateToolInput(tool(), null).ok, true);
  assert.equal(validateToolInput(tool(), undefined).ok, true);
  assert.equal(validateToolInput(tool(), ['query']).code, 'invalid_tool_arguments');
  assert.equal(validateToolInput(tool(), 'query').code, 'invalid_tool_arguments');
});

test('tool validation: a credential field can never be passed as a tool argument', () => {
  for (const key of ['apiKey', 'api_key', 'accessToken', 'access_token', 'refreshToken', 'clientSecret', 'authorization']) {
    const verdict = validateToolInput(tool(), { [key]: 'value' });
    assert.equal(verdict.code, 'policy_violation_secret_in_args', key);
  }
});

test('tool validation: undeclared arguments and wrong types are refused, null is tolerated', () => {
  assert.equal(validateToolInput(tool(), { other: 'x' }).code, 'policy_violation_unknown_argument');
  assert.equal(validateToolInput(tool(), { query: 5 }).code, 'policy_violation_argument_type');
  assert.equal(validateToolInput(tool(), { query: null }).ok, true);
  assert.equal(validateToolInput(tool({ arguments: {} }), { anything: 'goes' }).ok, true);
});

test('tool validation: calendar events need a summary and a forward time range', () => {
  const calendar = tool({ name: 'google.calendar_create_event', arguments: { summary: 'string', start: 'string', end: 'string' } });
  assert.equal(validateToolInput(calendar, { summary: '   ' }).code, 'policy_violation_summary_required');
  assert.equal(validateToolInput(calendar, { summary: 'اجتماع', start: 'bad', end: 'worse' }).code, 'policy_violation_invalid_time_range');
  assert.equal(
    validateToolInput(calendar, { summary: 'اجتماع', start: '2026-11-01T10:00:00Z', end: '2026-11-01T09:00:00Z' }).code,
    'policy_violation_invalid_time_range'
  );
  assert.equal(validateToolInput(calendar, { summary: 'اجتماع', start: '2026-11-01T09:00:00Z', end: '2026-11-01T10:00:00Z' }).ok, true);
  assert.equal(
    validateToolInput(tool({ name: 'calendar.create', arguments: { summary: 'string' } }), { summary: '' }).code,
    'policy_violation_summary_required'
  );
});

test('tool validation: WhatsApp recipients must be E.164 and text must be 1..4096 characters', () => {
  const whatsapp = tool({ name: 'whatsapp.send_text', arguments: { phone: 'string', text: 'string' } });
  assert.equal(validateToolInput(whatsapp, { phone: '0100000000' }).code, 'policy_violation_invalid_phone');
  assert.equal(validateToolInput(whatsapp, { phone: '+201065217834', text: '  ' }).code, 'policy_violation_invalid_text');
  assert.equal(validateToolInput(whatsapp, { phone: '+201065217834', text: 'x'.repeat(4097) }).code, 'policy_violation_invalid_text');
  assert.equal(validateToolInput(whatsapp, { phone: '+201065217834', text: 'مرحبًا' }).ok, true);
});

test('tool validation: a Drive export is bounded in title, content and MIME type', () => {
  const drive = tool({ name: 'google.drive_export_report', arguments: { title: 'string', content: 'string', mimeType: 'string' } });
  assert.equal(validateToolInput(drive, { title: '' }).code, 'policy_violation_invalid_drive_title');
  assert.equal(validateToolInput(drive, { title: 'x'.repeat(201) }).code, 'policy_violation_invalid_drive_title');
  assert.equal(validateToolInput(drive, { content: '   ' }).code, 'policy_violation_invalid_drive_content');
  assert.equal(validateToolInput(drive, { content: 'x'.repeat(200_001) }).code, 'policy_violation_invalid_drive_content');
  assert.equal(validateToolInput(drive, { mimeType: 'application/pdf' }).code, 'policy_violation_unsupported_mime_type');
  assert.equal(validateToolInput(drive, { mimeType: 'text/markdown' }).ok, true);
  assert.equal(validateToolInput(drive, { mimeType: null }).ok, true);
});

test('tool validation: a tool-specific validator can add its own refusal', () => {
  const custom = tool({ validate: () => ({ ok: false, code: 'custom_refusal', message: 'لا يسمح' }) });
  const verdict = validateToolInput(custom, { query: 'x' });
  assert.equal(verdict.code, 'custom_refusal');
  assert.equal(verdict.message, 'لا يسمح');
  const anonymous = tool({ validate: () => ({ ok: false }) });
  assert.equal(validateToolInput(anonymous, {}).code, 'policy_violation_custom');
  assert.equal(validateToolInput(tool({ validate: () => ({ ok: true }) }), { query: 'x' }).ok, true);
});

test('tool registry: a definition without a name, a risk level or with a duplicate is refused', () => {
  assert.throws(() => createToolRegistry([{ risk: RISK.read }]), /Tool name is required/);
  assert.throws(() => createToolRegistry([{ name: 'a' }]), /needs a valid risk level/);
  assert.throws(() => createToolRegistry([{ name: 'a', risk: RISK.read }, { name: 'a', risk: RISK.read }]), /Duplicate tool a/);
});

test('tool registry: an external-effect tool is declared but never executable without approval', () => {
  const registry = createToolRegistry([
    { name: 'kb.search', risk: RISK.read, description: 'بحث', execute: async () => ({ hits: [] }) },
    { name: 'google.calendar_create_event', risk: RISK.externalEffect, description: 'إنشاء موعد' }
  ]);
  assert.equal(registry.has('google.calendar_create_event'), true, 'declared, so the planner sees it');
  assert.equal(registry.executable('google.calendar_create_event'), false, 'but the runtime will not run it');
  assert.equal(registry.executable('kb.search'), true);
  assert.equal(registry.executable('missing'), false);

  const listed = registry.list();
  const external = listed.find((entry) => entry.name === 'google.calendar_create_event');
  assert.equal(external.requiresApproval, true);
  assert.equal(listed.find((entry) => entry.name === 'kb.search').requiresApproval, false);

  assert.equal(registry.get('kb.search').timeoutMs, 10_000);
  assert.equal(registry.get('missing'), null);
  // A tool with no declared contract accepts any object shape, but still rejects secrets and non-objects.
  assert.equal(registry.validateInput('kb.search', { query: 'x' }).ok, true);
  assert.equal(registry.validateInput('kb.search', { apiKey: 'x' }).ok, false);
  assert.equal(registry.validateInput('kb.search', []).ok, false);
});
