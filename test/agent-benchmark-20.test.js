import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_CASES_20,
  runDocumentAutomationBenchmark
} from '../src/agent/automation/index.js';
import {
  connectPoolWithFallback,
  createCeliaMcpApp,
  loadCeliaMcpConfig
} from '../src/celia-mcp.js';

test('BENCH-01: 20-case document_data_automation benchmark achieves 20/20 pass, 0 false accepts/rejects, and 100% replay determinism', async () => {
  assert.equal(BENCHMARK_CASES_20.length, 20);
  const report = await runDocumentAutomationBenchmark();
  assert.equal(report.totalCases, 20);
  assert.equal(report.passedCount, 20);
  assert.equal(report.failedCount, 0);
  assert.equal(report.completionRate, 1);
  assert.equal(report.falseAcceptCount, 0);
  assert.equal(report.falseRejectCount, 0);
  assert.equal(report.replayDeterminismRate, 1);
  assert.equal(report.policyComplianceRate, 1);
  assert.equal(report.evidenceCompletenessRate, 1);
  assert.equal(report.costPerCompletedTaskUsd, 0);
  assert.equal(report.decision, 'GO');
  assert.equal(report.cases.length, 20);

  for (const item of report.cases) {
    assert.equal(item.passed, true, `Benchmark case ${item.id} failed`);
    assert.equal(item.replayDeterministic, true, `Benchmark case ${item.id} was not replay-deterministic`);
    assert.match(item.fileSha256, /^[a-f0-9]{64}$/);
    assert.match(item.reportSha256, /^[a-f0-9]{64}$/);
  }
});

test('BENCH-02: /protocol Arabic architectural infographic page and /api/protocol-benchmark.json + /api/agent/benchmark routes serve live verified results', async () => {
  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const config = loadCeliaMcpConfig(
    {
      CELIA_MCP_API_TOKEN: token,
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true'
    },
    { requireToken: true }
  );
  const pool = await connectPoolWithFallback(config);
  const app = createCeliaMcpApp({ pool, config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const htmlRes = await fetch(`${baseUrl}/protocol`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /الإنفوجرافيك المعماري العربي لبروتوكول التفوق واكتساب المستخدمين/);
    assert.match(html, /dir="rtl"/);

    const publicJsonRes = await fetch(`${baseUrl}/api/protocol-benchmark.json`);
    assert.equal(publicJsonRes.status, 200);
    const publicJson = await publicJsonRes.json();
    assert.equal(publicJson.totalCases, 20);
    assert.equal(publicJson.passedCount, 20);

    const unauthAgentRes = await fetch(`${baseUrl}/api/agent/benchmark`);
    assert.equal(unauthAgentRes.status, 401);

    const authAgentRes = await fetch(`${baseUrl}/api/agent/benchmark`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(authAgentRes.status, 200);
    const authJson = await authAgentRes.json();
    assert.equal(authJson.totalCases, 20);
    assert.equal(authJson.decision, 'GO');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
