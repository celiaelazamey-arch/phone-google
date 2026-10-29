#!/usr/bin/env node
/**
 * Regenerates the seed registries in data/kb from the repository's own facts.
 *
 * The tool rows are derived from `CANONICAL_TOOLS`, so a risk level in the CSV can
 * never drift from the policy the runtime enforces. Re-run after changing tools:
 *   node scripts/kb-seed.mjs && npm run kb -- verify
 */
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from '../src/knowledge/csv.js';
import { sha256 } from '../src/knowledge/manifest.js';
import { CANONICAL_TOOLS } from '../src/knowledge/tool-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data', 'kb');
const REPO = 'https://github.com/celiaelazamey-arch/phone-google';
const blob = (file) => `${REPO}/blob/main/${file}`;

const TOOL_ALIASES = {"celia_status": ["حالة النظام", "فحص الحالة", "جاهزية", "تشخيص"], "celia_ai_reply": ["رد ذكي", "ذكاء اصطناعي", "رد على العميل", "مساعد"], "google_gmail_search": ["بحث البريد", "جيميل", "البريد الوارد", "رسائل"], "google_drive_search": ["بحث الملفات", "درايف", "مستندات", "أرشيف"], "google_calendar_events_list": ["تقويم", "مواعيد", "قراءة التقويم", "أجندة"], "google_calendar_events_create": ["إنشاء موعد", "إضافة اجتماع", "تقويم جوجل", "حجز موعد"], "google_contacts_search": ["جهات الاتصال", "دفتر العناوين", "أرقام"], "whatsapp_consent_upsert": ["موافقة واتساب", "تسجيل موافقة", "اشتراك"], "whatsapp_contacts_list": ["قائمة جهات واتساب", "عملاء واتساب"], "find_skills": ["بحث المهارات", "اكتشاف مهارة", "دليل المهارات"], "system_live_view": ["حالة حية", "مراقبة", "لوحة النظام"], "whatsapp_send_text": ["إرسال رسالة", "واتساب", "مراسلة عميل"], "celia_voice_speak": ["تحويل النص إلى صوت", "صوت", "نطق"], "figma_file_inspect": ["فيجما", "تصميم", "فحص ملف تصميم"], "codata_status": ["كوداتا", "مصدر بيانات"], "celia_secrets_status": ["حالة الأسرار", "جاهزية المفاتيح", "أمان"], "celia.system_status": ["حالة الوكيل", "تشخيص داخلي"], "celia.thread_context": ["سياق المحادثة", "تاريخ الخيط", "رسائل الخيط"], "celia.draft_outline": ["مسودة", "مخطط أولي", "خطة"], "google.calendar_create_event": ["إنشاء موعد", "موعد تقويم", "اجتماع"], "sandbox.exec": ["تشغيل كود", "بيئة معزولة", "حاوية"], "kb.search": ["بحث المعرفة", "استرجاع", "شبكة المعرفة", "بحث عربي"], "kb.tool_profile": ["ملف أداة", "صلاحيات أداة", "سجل الأدوات"], "kb.project_context": ["سياق مشروع", "مشاريع", "حواف المعرفة"]};

const TOOL_META = {
  celia_status: { category: 'diagnostics', endpoint: '/mcp', docs: 'docs/agent-runtime.md', skills: [] },
  celia_ai_reply: { category: 'ai', endpoint: '/mcp', docs: 'docs/2026-development-plan.md', skills: [] },
  google_gmail_search: { category: 'google', endpoint: '/mcp', docs: 'docs/google-connect.md', skills: ['skill-google-oauth'] },
  google_drive_search: { category: 'google', endpoint: '/mcp', docs: 'docs/google-connect.md', skills: ['skill-google-oauth'] },
  google_calendar_events_list: { category: 'google', endpoint: '/mcp', docs: 'docs/google-connect.md', skills: ['skill-google-oauth'] },
  google_calendar_events_create: { category: 'google', endpoint: '/mcp', docs: 'docs/google-connect.md', skills: ['skill-google-oauth'] },
  google_contacts_search: { category: 'google', endpoint: '/mcp', docs: 'docs/google-connect.md', skills: ['skill-google-oauth'] },
  whatsapp_consent_upsert: { category: 'whatsapp', endpoint: '/mcp', docs: 'README.md', skills: ['skill-whatsapp-hmac'] },
  whatsapp_contacts_list: { category: 'whatsapp', endpoint: '/mcp', docs: 'README.md', skills: ['skill-whatsapp-hmac'] },
  find_skills: { category: 'discovery', endpoint: '/mcp', docs: 'README.md', skills: ['skill-mcp-protocol'] },
  system_live_view: { category: 'observability', endpoint: '/mcp', docs: 'docs/resilience.md', skills: ['skill-release-rollback'] },
  whatsapp_send_text: { category: 'whatsapp', endpoint: '/mcp', docs: 'README.md', skills: ['skill-whatsapp-hmac'] },
  celia_voice_speak: { category: 'voice', endpoint: '/mcp', docs: 'docs/2026-development-plan.md', skills: [] },
  figma_file_inspect: { category: 'design', endpoint: '/mcp', docs: 'README.md', skills: [] },
  codata_status: { category: 'data', endpoint: '/mcp', docs: 'docs/codata-evaluation.md', skills: [] },
  celia_secrets_status: { category: 'security', endpoint: '/mcp', docs: 'SECURITY.md', skills: ['skill-secrets-isolation'] },
  'celia.system_status': { category: 'agent', endpoint: '/api/agent', docs: 'docs/agent-runtime.md', skills: ['skill-agent-loop'] },
  'celia.thread_context': { category: 'agent', endpoint: '/api/agent', docs: 'docs/agent-runtime.md', skills: ['skill-agent-loop'] },
  'celia.draft_outline': { category: 'agent', endpoint: '/api/agent', docs: 'docs/agent-runtime.md', skills: ['skill-agent-loop'] },
  'google.calendar_create_event': {
    category: 'google',
    endpoint: '/api/agent',
    docs: 'docs/agent-runtime.md',
    skills: ['skill-google-oauth', 'skill-agent-loop']
  },
  'sandbox.exec': { category: 'sandbox', endpoint: '/api/agent', docs: 'docs/agent-runtime-plan.md', skills: ['skill-agent-loop'] },
  'kb.search': { category: 'knowledge', endpoint: '/api/kb', docs: 'docs/knowledge-network.md', skills: ['skill-arabic-search'] },
  'kb.tool_profile': { category: 'knowledge', endpoint: '/api/kb', docs: 'docs/knowledge-network.md', skills: ['skill-arabic-search'] },
  'kb.project_context': { category: 'knowledge', endpoint: '/api/kb', docs: 'docs/knowledge-network.md', skills: ['skill-arabic-search'] }
};

const SOURCES = [
  {
    id: 'src-repo-docs',
    name: 'وثائق المستودع',
    kind: 'github',
    uri: `${REPO}`,
    license: 'internal-owner',
    last_sync: '2026-10-27',
    trust_level: 'T2',
    stale_after_days: '90',
    notes: 'وثائق داخل المستودع؛ كل سجل معرفة يشير إلى ملفه بـhttps'
  },
  {
    id: 'src-repo-registry',
    name: 'سجلات CSV داخل المستودع',
    kind: 'csv',
    uri: 'repo://data/kb',
    license: 'internal-owner',
    last_sync: '2026-10-27',
    trust_level: 'T3',
    stale_after_days: '180',
    notes: 'تُستورد عبر manifest ببصمات SHA-256 فقط'
  },
  {
    id: 'src-google-drive',
    name: 'Google Drive للمالك',
    kind: 'drive',
    uri: 'https://drive.google.com/drive/',
    license: 'internal-owner',
    last_sync: '2026-10-27',
    trust_level: 'T2',
    stale_after_days: '90',
    notes: 'مصدر معلن لم تُجرَ مزامنة حية بعد (SPDR-002)؛ لا عناصر منه في الفهرس الحالي'
  },
  {
    id: 'src-wikidata',
    name: 'Wikidata',
    kind: 'open_data',
    uri: 'https://www.wikidata.org/wiki/Wikidata:Main_Page',
    license: 'CC0-1.0',
    last_sync: '2026-10-27',
    trust_level: 'T1',
    stale_after_days: '365',
    notes: 'مرجع خارجي CC0 صالح للاستيراد بعد التحقق؛ لم يُستورد منه شيء بعد'
  }
];

const SKILLS = [
  {
    id: 'skill-google-oauth',
    aliases: 'ربط جوجل;تصريح;توكن مشفر',
    name: 'Google OAuth مع تخزين رموز مشفّر',
    level: 'advanced',
    category: 'integrations',
    source: 'repo',
    evidence_url: blob('src/google.js'),
    projects: 'proj-celia-mcp',
    notes: 'state أحادي الاستخدام + AES-256-GCM + تحقق بريد المالك'
  },
  {
    id: 'skill-whatsapp-hmac',
    aliases: 'واتساب;توقيع;منع التكرار',
    name: 'WhatsApp Webhook HMAC وموافقات',
    level: 'advanced',
    category: 'integrations',
    source: 'repo',
    evidence_url: blob('src/whatsapp.js'),
    projects: 'proj-celia-mcp',
    notes: 'تحقق على raw bytes، منع تكرار، نافذة خدمة، وموافقتان'
  },
  {
    id: 'skill-mcp-protocol',
    aliases: 'بروتوكول الأدوات;mcp;خادم أدوات',
    name: 'بروتوكول MCP عبر HTTP وstdio',
    level: 'advanced',
    category: 'protocol',
    source: 'repo',
    evidence_url: blob('src/celia-mcp.js'),
    projects: 'proj-celia-mcp',
    notes: '12 أداة افتراضية + 4 اختيارية، مصافحة وفحص ذاتي'
  },
  {
    id: 'skill-agent-loop',
    aliases: 'حلقة الوكيل;خطوات;استئناف',
    name: 'حلقة وكيل دائمة Plan→Act→Observe',
    level: 'advanced',
    category: 'agent',
    source: 'repo',
    evidence_url: blob('src/agent/runtime.js'),
    projects: 'proj-agent-m1',
    notes: 'lease، استئناف، منع تكرار، ميزانيات، بوابة مخاطر'
  },
  {
    id: 'skill-arabic-search',
    aliases: 'بحث عربي;تطبيع;فهرس',
    name: 'تطبيع عربي وبحث FTS5',
    level: 'intermediate',
    category: 'knowledge',
    source: 'repo',
    evidence_url: blob('src/knowledge/normalize.js'),
    projects: 'proj-knowledge-network',
    notes: 'تطبيع محافظ بلا جذر لغوي عدواني + خريطة إزاحات للمقتطفات'
  },
  {
    id: 'skill-mysql-tls',
    aliases: 'قاعدة بيانات;ترحيل;شهادة',
    name: 'MySQL TLS وسجل ترحيل',
    level: 'advanced',
    category: 'data',
    source: 'repo',
    evidence_url: blob('src/schema-migrations.js'),
    projects: 'proj-celia-mcp',
    notes: 'تحقق شهادة وCA، رفض drift، dry-run افتراضي'
  },
  {
    id: 'skill-release-rollback',
    aliases: 'إصدار;رجوع;استعادة',
    name: 'إصدار وتبديل ورجوع مفحوص',
    level: 'advanced',
    category: 'ops',
    source: 'repo',
    evidence_url: blob('src/deployment.js'),
    projects: 'proj-free-hosting',
    notes: 'فحص مرشح ثم فعال، وحفظ حالة عند فشل الاستعادة'
  },
  {
    id: 'skill-secrets-isolation',
    aliases: 'أسرار;مفاتيح;عزل',
    name: 'عزل الأسرار التسعة على الخادم',
    level: 'advanced',
    category: 'security',
    source: 'repo',
    evidence_url: blob('src/secrets-hub.js'),
    projects: 'proj-celia-mcp',
    notes: 'صفر مفاتيح في المتصفح، فحص عدم تسريب في CI'
  },
  {
    id: 'skill-arabic-rtl-ui',
    aliases: 'واجهة عربية;إتاحة;هاتف',
    name: 'واجهة عربية RTL قابلة للوصول',
    level: 'intermediate',
    category: 'ui',
    source: 'repo',
    evidence_url: blob('public/agent.html'),
    projects: 'proj-knowledge-network',
    notes: 'أصول محلية، لوحة مفاتيح، 320px، prefers-reduced-motion'
  },
  {
    id: 'skill-google-spider',
    aliases: 'درايف;فهرس محلي;بايثون',
    name: 'فهرس Drive محلي عبر MCP stdio',
    level: 'intermediate',
    category: 'knowledge',
    source: 'repo',
    evidence_url: blob('celia-google-spider/celia_spider/store.py'),
    projects: 'proj-celia-google-spider',
    notes: 'قراءة فقط، بلا حذف تلقائي، بلا embeddings'
  }
];

const PROJECTS = [
  {
    id: 'proj-celia-mcp',
    aliases: 'المنصة;الخادم الموحد',
    name: 'Celia MCP — التشغيل الموحد',
    domain: 'assistant-platform',
    status: 'active',
    priority: 'P0',
    owner: 'celiaelazamey-arch',
    repo_url: REPO,
    related: 'skill-mcp-protocol;skill-google-oauth;skill-whatsapp-hmac',
    notes: 'خدمة Node واحدة للواجهة وMCP وGoogle وWhatsApp'
  },
  {
    id: 'proj-agent-m1',
    aliases: 'الوكيل;الحلقة الدائمة',
    name: 'حلقة الوكيل M1',
    domain: 'agent-runtime',
    status: 'active',
    priority: 'P0',
    owner: 'celiaelazamey-arch',
    repo_url: blob('docs/agent-runtime.md'),
    related: 'skill-agent-loop',
    notes: 'منفذة ومختبرة؛ مخطط حتمي حتى AI-002'
  },
  {
    id: 'proj-knowledge-network',
    aliases: 'شبكة المعرفة;الفهرس',
    name: 'شبكة معرفة CeliaOS',
    domain: 'knowledge',
    status: 'active',
    priority: 'P0',
    owner: 'celiaelazamey-arch',
    repo_url: blob('docs/knowledge-network.md'),
    related: 'skill-arabic-search;skill-arabic-rtl-ui',
    notes: 'CSV + SQLite/FTS5 + حواف مسمّاة + أدوات kb.* للوكيل'
  },
  {
    id: 'proj-celia-google-spider',
    aliases: 'السبابة;درايف',
    name: 'Celia Google Spider',
    domain: 'knowledge',
    status: 'active',
    priority: 'P1',
    owner: 'celiaelazamey-arch',
    repo_url: blob('celia-google-spider/README.md'),
    related: 'skill-google-spider',
    notes: 'حزمة Python مستقلة؛ المزامنة الحية تنتظر SPDR-002'
  },
  {
    id: 'proj-free-hosting',
    aliases: 'النشر;الاستضافة المجانية',
    name: 'النشر المجاني',
    domain: 'ops',
    status: 'paused',
    priority: 'P0',
    owner: 'celiaelazamey-arch',
    repo_url: blob('docs/free-hosting.md'),
    related: 'skill-release-rollback',
    notes: 'متوقف على تفعيل Pages/تفويض حساب؛ لا بطاقة دفع'
  },
  {
    id: 'proj-landing',
    aliases: 'الصفحة التعريفية',
    name: 'صفحة الهبوط والنسخة الثابتة',
    domain: 'marketing',
    status: 'active',
    priority: 'P1',
    owner: 'celiaelazamey-arch',
    repo_url: blob('public/landing.html'),
    related: 'skill-arabic-rtl-ui',
    notes: 'أصول محلية بلا تتبّع خارجي'
  }
];

const KNOWLEDGE = [
  {
    id: 'kb-doc-knowledge-network',
    aliases: 'شبكة المعرفة;فهرس;استرجاع',
    title: 'معمارية شبكة المعرفة',
    type: 'concept',
    description: 'ست طبقات: مصادر، موصل، إدخال وتحقق، مخزن، استرجاع، ثم وكيل. تشمل عقود CSV وحدود الثقة والترخيص.',
    source_url: blob('docs/knowledge-network.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-knowledge-network;skill-arabic-search',
    tags: 'knowledge;csv;sqlite;fts5',
    lang: 'ar'
  },
  {
    id: 'kb-doc-agent-runtime',
    aliases: 'الوكيل;الحلقة;الاستئناف',
    title: 'حلقة الوكيل M1 — ما نُفذ وما لم يُنفذ',
    type: 'concept',
    description: 'حلقة Plan→Act→Observe→Deliver بحالة دائمة، استئناف، lease، ميزانيات، وبوابة مخاطر ترفض الأثر الخارجي.',
    source_url: blob('docs/agent-runtime.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-agent-m1;skill-agent-loop',
    tags: 'agent;runtime;m1',
    lang: 'ar'
  },
  {
    id: 'kb-doc-agent-plan',
    aliases: 'خطة الوكيل;مانوس',
    title: 'خطة الوكيل M1–M4',
    type: 'concept',
    description: 'المسافة بين المساعد الحالي ووكيل متكامل: حلقة، ذاكرة، مخرجات، عزل، موافقات، تكلفة.',
    source_url: blob('docs/agent-runtime-plan.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-agent-m1',
    tags: 'agent;plan',
    lang: 'ar'
  },
  {
    id: 'kb-doc-google-connect',
    aliases: 'ربط جوجل;أواث;نطاق',
    title: 'ربط حساب Google خطوة بخطوة',
    type: 'doc',
    description: 'متطلبات OAuth ونطاقات القراءة والفحص المسبق قبل المطالبة برابط حي.',
    source_url: blob('docs/google-connect.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'skill-google-oauth',
    tags: 'google;oauth',
    lang: 'ar'
  },
  {
    id: 'kb-doc-free-hosting',
    aliases: 'نشر مجاني;استضافة',
    title: 'دليل النشر المجاني الفعلي',
    type: 'doc',
    description: 'Render Free وAiven Free ونطاق HTTPS، وحدود الطبقة المجانية وما لا يمكن ادعاؤه.',
    source_url: blob('docs/free-hosting.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-free-hosting',
    tags: 'hosting;free;render',
    lang: 'ar'
  },
  {
    id: 'kb-doc-compatibility',
    aliases: 'توافق;عقود',
    title: 'عقد التوافق وعدم التعارض',
    type: 'doc',
    description: 'مصفوفة العقود: HTTP، REST، OAuth، WhatsApp، MCP، MySQL، والنشر؛ وما يعنيه الادعاء بالتوافق.',
    source_url: blob('docs/compatibility-contract.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-celia-mcp;skill-mysql-tls',
    tags: 'compatibility;contract',
    lang: 'ar'
  },
  {
    id: 'kb-doc-resilience',
    aliases: 'قواطع;تحمل الأعطال',
    title: 'العزل والمراقبة',
    type: 'doc',
    description: 'قواطع ومهل وحدود تزامن، ومنع السقوط الصامت إلى ذاكرة فارغة.',
    source_url: blob('docs/resilience.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'skill-release-rollback',
    tags: 'resilience;circuit-breaker',
    lang: 'ar'
  },
  {
    id: 'kb-doc-releases',
    aliases: 'إصدار;رجوع',
    title: 'الإصدارات والرجوع',
    type: 'doc',
    description: 'حزم موقّعة وSBOM وتبديل مفحوص بالجاهزية واستعادة عند الفشل.',
    source_url: blob('docs/releases-and-recovery.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'skill-release-rollback',
    tags: 'release;rollback',
    lang: 'ar'
  },
  {
    id: 'kb-security',
    aliases: 'أمان;أسرار',
    title: 'سياسة الأمان',
    type: 'doc',
    description: 'الإبلاغ عن الثغرات وحدود الإفصاح والتعامل مع الأسرار.',
    source_url: blob('SECURITY.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'skill-secrets-isolation',
    tags: 'security;secrets',
    lang: 'ar'
  },
  {
    id: 'kb-readme',
    aliases: 'نظرة عامة',
    title: 'README النظام',
    type: 'doc',
    description: 'نظرة شاملة: ما يعمل، ما هو معاينة، وحدود النشر والبيانات.',
    source_url: blob('README.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-celia-mcp',
    tags: 'overview',
    lang: 'ar'
  },
  {
    id: 'kb-doc-plan-2026',
    aliases: 'خطة 2026;مهام',
    title: 'خطة 2026 الشاملة',
    type: 'concept',
    description: 'نطاق المراحل والمهام والأولويات ومعايير القبول.',
    source_url: blob('docs/2026-development-plan.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-celia-mcp',
    tags: 'plan;2026',
    lang: 'ar'
  },
  {
    id: 'kb-spider-readme',
    aliases: 'السبابة;درايف;بايثون',
    title: 'Celia Google Spider',
    type: 'doc',
    description: 'حزمة Python تقرأ Drive وتبني فهرسًا محليًا وتقدمه كأدوات MCP عبر stdio.',
    source_url: blob('celia-google-spider/README.md'),
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    related: 'proj-celia-google-spider;skill-google-spider',
    tags: 'drive;python;mcp',
    lang: 'ar'
  }
];

function toolsRows() {
  return Object.entries(CANONICAL_TOOLS).map(([name, policy]) => {
    const meta = TOOL_META[name];
    if (!meta) throw new Error(`missing TOOL_META for ${name}`);
    return {
      id: name,
      name,
      category: meta.category,
      risk_level: policy.risk,
      requires_approval: String(policy.requiresApproval),
      api_endpoint: meta.endpoint,
      docs_url: blob(meta.docs),
      owner: 'celiaelazamey-arch',
      skills: meta.skills.join(';'),
      data_egress: String(Boolean(policy.dataEgress)),
      aliases: (TOOL_ALIASES[name] || []).join(';'),
      notes: policy.surface === 'agent' ? 'أداة داخل حلقة الوكيل' : 'أداة MCP على المنفذ الموحد'
    };
  });
}

const TOOL_HEADER = ['id', 'name', 'category', 'risk_level', 'requires_approval', 'api_endpoint', 'docs_url', 'owner', 'skills', 'data_egress', 'aliases', 'notes'];
const SOURCE_HEADER = ['id', 'name', 'kind', 'uri', 'license', 'last_sync', 'trust_level', 'stale_after_days', 'notes'];
const SKILL_HEADER = ['id', 'name', 'level', 'category', 'source', 'evidence_url', 'projects', 'aliases', 'notes'];
const PROJECT_HEADER = ['id', 'name', 'domain', 'status', 'priority', 'owner', 'repo_url', 'related', 'aliases', 'notes'];
// Review dates are owner-review deadlines, not claims that a source stays true forever.
const GOVERNED_KNOWLEDGE = KNOWLEDGE.map((row) => ({
  ...row,
  claim_type: 'operational_guidance',
  review_due: '2027-01-27'
}));
const KNOWLEDGE_HEADER = ['id', 'title', 'type', 'description', 'source_url', 'license', 'updated_at', 'trust_level', 'related', 'tags', 'aliases', 'lang', 'claim_type', 'review_due'];

async function main() {
  const files = [
    ['sources_registry.csv', SOURCE_HEADER, SOURCES],
    ['tools_registry.csv', TOOL_HEADER, toolsRows()],
    ['skills_registry.csv', SKILL_HEADER, SKILLS],
    ['projects_registry.csv', PROJECT_HEADER, PROJECTS],
    ['knowledge_registry.csv', KNOWLEDGE_HEADER, GOVERNED_KNOWLEDGE]
  ];
  for (const [name, header, rows] of files) {
    await writeFile(path.join(directory, name), toCsv(header, rows), 'utf8');
  }
  const descriptors = JSON.parse(await readFile(path.join(directory, 'descriptors.json'), 'utf8'));
  const manifest = { version: 1, generated_at: new Date().toISOString(), files: [] };
  for (const descriptor of descriptors.files) {
    const source = await readFile(path.join(directory, descriptor.name), 'utf8');
    manifest.files.push({ ...descriptor, sha256: sha256(source) });
  }
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ written: files.map(([name]) => name), manifest: 'manifest.json', entries: manifest.files.length }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
