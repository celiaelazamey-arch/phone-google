#!/usr/bin/env node
/**
 * بناء نسخة ثابتة من واجهة سيليا للنشر المجاني على GitHub Pages.
 *
 * المبدأ: مصدر الحقيقة الوحيد هو src/celia-mcp.js — يُستخرج منه MCP_TOOLS و SERVER_INFO
 * نصًّا (بدون تشغيل اعتماديات Node) ويُحقنان في طبقة محاكاة داخل المتصفح،
 * فلا تتباعد نسختان من تعريفات الأدوات.
 */
import { mkdir, readFile, readdir, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
  const serverInfoMatch = /const SERVER_INFO = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
  if (!serverInfoMatch) throw new Error('لم يتم العثور على SERVER_INFO');
  const serverInfo = new Function(`return ({${serverInfoMatch[1]}});`)();
  return { tools, serverInfo };
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
    .replace(/href="\.\/live"/g, 'href="./live.html"')
    .replace(/href="\.\/live\/"/g, 'href="./live.html"')
    .replace(/href="\.\/skills"/g, 'href="./skills.html"')
    .replace(/href="\.\/skills\/"/g, 'href="./skills.html"')
    .replace(/href="\.\/index"/g, 'href="./index.html"');
}

export async function build() {
  const { tools, serverInfo } = await loadMcpTools();
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const commit = await gitCommitSha();
  const buildMeta = {
    builtAt: new Date().toISOString(),
    commit,
    mode: 'static-preview',
    host: 'github-pages',
    toolsCount: tools.length
  };

  const shim = template
    .replaceAll('/*__CELIA_TOOLS_JSON__*/', JSON.stringify(tools, null, 2))
    .replaceAll('/*__CELIA_SERVER_INFO__*/', JSON.stringify(serverInfo, null, 2))
    .replaceAll('/*__CELIA_BUILD_META__*/', JSON.stringify(buildMeta, null, 2));

  if (shim.includes('__CELIA_')) throw new Error('بقيت علامة قالب غير مستبدلة في الطبقة الثابتة');

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const entries = await readdir(PUBLIC_DIR, { withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(PUBLIC_DIR, entry.name);
    const targetPath = path.join(DIST_DIR, entry.name);
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
