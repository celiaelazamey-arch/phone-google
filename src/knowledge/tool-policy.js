/**
 * Canonical tool risk policy — the only authority for what a tool may do.
 *
 * `tools_registry.csv` may *describe* a tool, but a row whose risk or approval flag
 * disagrees with this table is rejected at import. Execution is decided by code
 * (the agent runtime refuses anything that is not `read`/`internal_write`), so a
 * CSV edit can never grant a permission.
 */

export const CANONICAL_TOOLS = Object.freeze({
  // MCP tools on the single combined port (12 default + 4 extended).
  celia_status: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  celia_ai_reply: { risk: 'external_effect', requiresApproval: false, surface: 'mcp', dataEgress: true },
  google_gmail_search: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  google_drive_search: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  google_calendar_events_list: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  google_calendar_events_create: { risk: 'external_effect', requiresApproval: true, surface: 'mcp' },
  google_contacts_search: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  whatsapp_consent_upsert: { risk: 'internal_write', requiresApproval: false, surface: 'mcp' },
  whatsapp_contacts_list: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  find_skills: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  system_live_view: { risk: 'read', requiresApproval: false, surface: 'mcp' },
  whatsapp_send_text: { risk: 'external_effect', requiresApproval: true, surface: 'mcp', dataEgress: true },
  celia_voice_speak: { risk: 'external_effect', requiresApproval: false, surface: 'mcp-extended', dataEgress: true },
  figma_file_inspect: { risk: 'read', requiresApproval: false, surface: 'mcp-extended' },
  codata_status: { risk: 'read', requiresApproval: false, surface: 'mcp-extended' },
  celia_secrets_status: { risk: 'read', requiresApproval: false, surface: 'mcp-extended' },

  // Agent runtime tools (M1 + AGENT-002).
  'celia.system_status': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'celia.thread_context': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'celia.draft_outline': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'google.calendar_create_event': { risk: 'external_effect', requiresApproval: true, surface: 'agent', dataEgress: true },
  'whatsapp.send_text': { risk: 'external_effect', requiresApproval: true, surface: 'agent', dataEgress: true },
  'google.drive_export_report': { risk: 'external_effect', requiresApproval: true, surface: 'agent', dataEgress: true },
  'product.catalog_audit': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'creative.workflow_plan': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'sandbox.exec': { risk: 'irreversible', requiresApproval: true, surface: 'agent' },
  // M-C/C2a: الوصول إلى الويب داخل فقط وعبر وسيط الخروج دائمًا؛ بيانات المالك
  // لا تخرج (dataEgress=false بالبناء).
  'web.fetch': { risk: 'read', requiresApproval: false, surface: 'agent' },

  // Knowledge network tools (M1.1) — read-only by construction.
  'kb.search': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'kb.tool_profile': { risk: 'read', requiresApproval: false, surface: 'agent' },
  'kb.project_context': { risk: 'read', requiresApproval: false, surface: 'agent' }
});

export function canonicalRisk(name) {
  return CANONICAL_TOOLS[name] || null;
}

export function canonicalToolNames() {
  return Object.keys(CANONICAL_TOOLS);
}
