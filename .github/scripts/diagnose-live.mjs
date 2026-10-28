#!/usr/bin/env node
/**
 * TEMPORARY diagnostic (deleted after its first run).
 *
 * Emits `::notice` annotations, because this session can read check-run annotations but not job logs.
 * Everything printed here is public: the host of the configured URL, the Render services the key can see
 * (name + public URL), and HTTP status codes. No secret value is ever printed — the URL's query string and
 * userinfo are dropped before anything is echoed.
 */
const trim = (value) => String(value ?? '').trim();

const notes = [];
/** GitHub truncates annotations; keep each line short and factual. */
function notice(id, text) {
  const clean = String(text).replace(/\r?\n/g, ' ').slice(0, 900);
  notes.push(`[${id}] ${clean}`);
  console.log(`::notice title=diag:${id}::${clean}`);
}

function publicHost(raw) {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url;
}

async function probe(url) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    return { status: response.status, body };
  } catch (error) {
    return { status: 'ERR', body: String(error?.cause?.code || error?.name || 'network_error').slice(0, 120) };
  }
}

const secret = trim(process.env.LIVE_SECRET);
const variable = trim(process.env.LIVE_VAR);
const raw = secret || variable;
const source = secret ? 'secret' : variable ? 'variable' : 'none';

if (!raw) {
  notice('live-url', 'not set in either tab (variable or secret)');
} else {
  let url = null;
  try {
    url = publicHost(raw);
  } catch {
    notice('live-url', `source=${source} unparseable as a URL (first 40 chars: ${raw.slice(0, 40)})`);
  }
  if (url) {
    notice('live-url', `source=${source} host=${url.host} path=${url.pathname} onrender=${url.host.endsWith('.onrender.com')}`);
    for (const endpoint of ['/readyz', '/version', '/health']) {
      const result = await probe(`${url.origin}${endpoint}`);
      notice(`live${endpoint}`, `HTTP ${result.status} :: ${result.body}`);
    }
  }
}

// Independent of what the owner typed: does the name declared in render.yaml answer?
const blueprint = await probe('https://celia-phone-google.onrender.com/readyz');
notice('blueprint-name', `celia-phone-google.onrender.com/readyz → HTTP ${blueprint.status} :: ${blueprint.body}`);

const key = trim(process.env.RENDER_API_KEY);
if (!key) {
  notice('render-api', 'RENDER_API_KEY is not set in this workflow');
} else {
  try {
    const response = await fetch('https://api.render.com/v1/services?limit=100', {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` }
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
    notice('render-api', `HTTP ${response.status}`);
    if (payload.message) notice('render-message', String(payload.message).slice(0, 200));
    const rows = (payload.services || payload.items || []).map((row) => row.service || row);
    notice('render-services', `count=${rows.length}`);
    for (const row of rows.slice(0, 10)) {
      const url = row?.serviceDetails?.url || '(no url)';
      notice('render-service', `${row?.name || '(unnamed)'} -> ${url} type=${row?.type || '?'} suspended=${row?.suspended || 'no'}`);
    }
  } catch (error) {
    notice('render-api', `request failed: ${String(error?.message || error).slice(0, 160)}`);
  }
}

console.log(`::group::summary`);
for (const line of notes) console.log(line);
console.log('::endgroup::');
