#!/usr/bin/env node
/**
 * بناء نسخة ثابتة من واجهة سيليا للنشر المجاني على GitHub Pages.
 *
 * المبدأ: تعريفات الأدوات من src/celia-mcp.js والنسخة من releases/current.json — يُستخرج منه MCP_TOOLS و SERVER_INFO
 * نصًّا (بدون تشغيل اعتماديات Node) ويُحقنان في طبقة محاكاة داخل المتصفح،
 * فلا تتباعد نسختان من تعريفات الأدوات.
 */
import { mkdir, readFile, readdir, rm, writeFile, copyFile, cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { RELEASE, RELEASE_HISTORY, SERVER_INFO } from '../src/version.js';
import { runDocumentAutomationBenchmark } from '../src/agent/automation/index.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DIST_DIR = path.join(ROOT, 'dist');
const TEMPLATE_PATH = path.join(HERE, 'static', 'celia-static-shim.template.js');
const MCP_SOURCE_PATH = path.join(ROOT, 'src', 'celia-mcp.js');

/** يستخرج تعبيرًا مصفوفًا متوازن الأقواس بدءًا من أول قوس مربع بعد العلامة. */
export function extractArrayLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`لم يتم العثور على العلامة: ${marker}`);
  const start = source.indexOf('[', markerIndex);
  if (start === -1) throw new Error('لم يتم العثور على بداية المصفوفة');

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('قوس المصفوفة غير مغلق');
}

export async function loadMcpTools() {
  const source = await readFile(MCP_SOURCE_PATH, 'utf8');
  const tools = new Function(`return ${extractArrayLiteral(source, 'export const MCP_TOOLS = Object.freeze(')};`)();
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('MCP_TOOLS فارغة أو غير صالحة');
  for (const tool of tools) {
    if (!tool?.name || typeof tool.name !== 'string' || !tool.inputSchema) {
      throw new Error(`أداة MCP غير مكتملة: ${JSON.stringify(tool)?.slice(0, 80)}`);
    }
  }
  const serverInfo = SERVER_INFO;
  const protocolMatch = /const MCP_PROTOCOL_VERSION = '([^']+)'/.exec(source);
  if (!protocolMatch) throw new Error('لم يتم العثور على MCP_PROTOCOL_VERSION');
  return { tools, serverInfo, protocolVersion: protocolMatch[1] };
}

async function gitCommitSha() {
  for (const candidate of [process.env.GITHUB_SHA, process.env.GIT_COMMIT]) {
    if (candidate) return candidate.slice(0, 40);
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
    return stdout.trim();
  } catch {
    return null;
  }
}

function injectShimScript(html) {
  if (html.includes('celia-static-shim.js')) return html;
  const tag = '  <script src="./celia-static-shim.js"></script>\n';
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return `${tag}${html}`;
}

function rewriteStaticHostLinks(html) {
  return html
    .replace(/href="\.\/deploy\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./deploy.html${suffix}"`)
    .replace(/href="\.\/system\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./system.html${suffix}"`)
    .replace(/href="\.\/live\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./live.html${suffix}"`)
    .replace(/href="\.\/skills\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./skills.html${suffix}"`)
    .replace(/href="\.\/landing\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./landing.html${suffix}"`)
    .replace(/href="\.\/index\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./index.html${suffix}"`)
    .replace(/href="\.\/studio\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./index.html${suffix}"`)
    .replace(/href="\.\/agent\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./agent.html${suffix}"`)
    .replace(/href="\.\/protocol\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./protocol.html${suffix}"`)
    .replace(/href="\.\/computer\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./computer.html${suffix}"`)
    .replace(/href="\.\/computer-permissions\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./computer-permissions.html${suffix}"`)
    .replace(/href="\.\/kb\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./kb.html${suffix}"`)
    .replace(/href="\.\/cron\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./cron.html${suffix}"`)
    .replace(/href="\.\/whatsapp\/?([?#][^"]*)?"/g, (_, suffix = '') => `href="./whatsapp.html${suffix}"`)
    // روابط التشخيص المباشرة: Pages يخدم ملفات فقط، لذا تشير إلى لقطات JSON ثابتة.
    .replace(/href="\.\/health"/g, 'href="./health.json"')
    .replace(/href="\.\/api\/live"/g, 'href="./api/live.json"')
    .replace(/href="\.\/mcp"/g, 'href="./mcp.json"');
}

export async function build() {
  const { tools, serverInfo, protocolVersion } = await loadMcpTools();
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const commit = await gitCommitSha();
  const buildMeta = {
    builtAt: new Date().toISOString(),
    commit,
    mode: 'static-preview',
    host: 'github-pages',
    sourceRef: process.env.CELIA_SOURCE_REF || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || 'main',
    toolsCount: tools.length
  };

  // Optional pointer to the separate always-on service. It is only a URL the owner
  // pasted at build time: the build cannot verify it, so every surface reports
  // `verified: false` and must never present it as a live deployment.
  const rawServiceUrl = String(process.env.CELIA_REAL_SERVICE_URL || '').trim();
  if (rawServiceUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(rawServiceUrl)) {
    throw new Error('CELIA_REAL_SERVICE_URL must be an https URL');
  }
  const realService = { url: rawServiceUrl || null, verified: false };

  const shim = template
    .replaceAll('/*__CELIA_TOOLS_JSON__*/', JSON.stringify(tools, null, 2))
    .replaceAll('/*__CELIA_SERVER_INFO__*/', JSON.stringify(serverInfo, null, 2))
    .replaceAll('/*__CELIA_BUILD_META__*/', JSON.stringify(buildMeta, null, 2))
    .replaceAll('/*__CELIA_RELEASE__*/', JSON.stringify(RELEASE, null, 2))
    .replaceAll('/*__CELIA_RELEASE_HISTORY__*/', JSON.stringify(RELEASE_HISTORY, null, 2))
    .replaceAll('/*__CELIA_REAL_SERVICE__*/', JSON.stringify(realService, null, 2));

  if (shim.includes('__CELIA_')) throw new Error('بقيت علامة قالب غير مستبدلة في الطبقة الثابتة');
  try {
    new Function(shim);
  } catch (error) {
    throw new Error(`الطبقة الثابتة غير صالحة نحوياً: ${error.message}`);
  }

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const entries = await readdir(PUBLIC_DIR, { withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    const sourcePath = path.join(PUBLIC_DIR, entry.name);
    const targetPath = path.join(DIST_DIR, entry.name);
    if (entry.isDirectory()) {
      // أصول محلية مثل الخطوط والصور؛ انسخها كما هي إلى النسخة الثابتة.
      await cp(sourcePath, targetPath, { recursive: true });
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.html')) {
      const html = rewriteStaticHostLinks(injectShimScript(await readFile(sourcePath, 'utf8')));
      await writeFile(targetPath, html, 'utf8');
      pages.push(entry.name);
      if (entry.name === 'index.html') {
        await writeFile(path.join(DIST_DIR, '404.html'), html, 'utf8');
      }
    } else {
      await copyFile(sourcePath, targetPath);
    }
  }

  await writeFile(path.join(DIST_DIR, 'celia-static-shim.js'), shim, 'utf8');
  await writeFile(path.join(DIST_DIR, '.nojekyll'), '', 'utf8');
  await writeFile(
    path.join(DIST_DIR, 'robots.txt'),
    'User-agent: *\nAllow: /\n',
    'utf8'
  );
  await writeFile(
    path.join(DIST_DIR, 'health.json'),
    `${JSON.stringify(
      {
        status: 'ok',
        mode: 'static-preview',
        service: serverInfo.name,
        version: serverInfo.version,
        toolsCount: tools.length,
        builtAt: buildMeta.builtAt,
        commit,
        note: 'ملف ثابت للفحص السريع. الطبقة الحية داخل المتصفح تخدم /health و /ui/workspace/rpc.'
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  await writeFile(path.join(DIST_DIR, 'version.json'), `${JSON.stringify({ ...RELEASE, commit }, null, 2)}\n`);

  // لقطات JSON ثابتة لروابط التشخيص في live.html (لا تُخدم نقاط POST على Pages).
  await writeFile(
    path.join(DIST_DIR, 'mcp.json'),
    `${JSON.stringify(
      {
        service: serverInfo.name,
        version: serverInfo.version,
        protocolVersion,
        transport: 'static-browser-shim',
        toolsCount: tools.length,
        note: 'لقطة ثابتة لهوية خادم MCP؛ التنفيذ الفعلي للأدوات يتم داخل المتصفح عبر celia-static-shim.js.'
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await mkdir(path.join(DIST_DIR, 'api'), { recursive: true });
  await writeFile(
    path.join(DIST_DIR, 'api', 'protocol-benchmark.json'),
    `${JSON.stringify(await runDocumentAutomationBenchmark(), null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(DIST_DIR, 'api', 'live.json'),
    `${JSON.stringify(
      {
        live: true,
        mode: 'static-preview',
        message: 'النظام الحي داخل المتصفح — Find Skills و System Live View يعملان عبر الطبقة الثابتة',
        tools: tools.length,
        summary: {
          service: serverInfo.name,
          version: serverInfo.version,
          protocolVersion,
          toolsCount: tools.length,
          storage: 'memory',
          providers: {}
        },
        timestamp: buildMeta.builtAt,
        uptime: 0,
        note: 'لقطة وقت البناء؛ القيم اللحظية الحقيقية تُعرض داخل لوحة النظام الحي عبر الطبقة الثابتة.'
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const shimStat = await stat(path.join(DIST_DIR, 'celia-static-shim.js'));
  return {
    toolsCount: tools.length,
    pages,
    shimBytes: shimStat.size,
    buildMeta,
    distDir: DIST_DIR
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = await build();
  console.log(
    `✅ تم بناء نسخة النشر الثابتة: ${result.pages.join(', ')} · ${result.toolsCount} أداة · ${(
      result.shimBytes / 1024
    ).toFixed(1)}KB`
  );
  console.log(`📁 ${path.relative(ROOT, result.distDir)}/  (commit=${result.buildMeta.commit || 'unknown'})`);
}
