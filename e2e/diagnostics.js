import { Buffer } from 'node:buffer';

/**
 * Attaches real-Chromium diagnostics BEFORE `page.goto(...)`:
 *   - `pageerror` (uncaught runtime exceptions + stack)
 *   - `console` (`type() === 'error'` with source URL & line)
 *   - `requestfailed` (network/CORS/DNS/CSP failures)
 *   - `response` (`status() >= 400`)
 *   - `crash` (`PAGE_CRASH`)
 *
 * Returns `{ diagnostics, flush(testInfo) }` so tests can assert
 * `expect(diagnostics, diagnostics.join('\n')).toEqual([])` and automatically
 * attach `chromium-diagnostics.txt` + `failure.png` when a test fails.
 */
export function attachChromiumDiagnostics(page, { ignoreHttp = null } = {}) {
  const diagnostics = [];

  page.on('pageerror', (err) => {
    diagnostics.push(`PAGEERROR: ${err.stack || err.message}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      diagnostics.push(`CONSOLE_ERROR: ${msg.text()} @ ${loc.url || ''}:${loc.lineNumber || 0}`);
    }
  });

  page.on('requestfailed', (req) => {
    const failureText = req.failure()?.errorText || 'unknown';
    // Navigating away or closing an EventSource stream aborts the in-flight request intentionally.
    if (failureText === 'net::ERR_ABORTED' && req.url().includes('/events')) return;
    diagnostics.push(`REQUEST_FAILED: ${req.method()} ${req.url()} -> ${failureText}`);
  });

  page.on('response', (res) => {
    if (res.status() >= 400) {
      if (typeof ignoreHttp === 'function' && ignoreHttp(res)) return;
      diagnostics.push(`HTTP_${res.status()}: ${res.request().method()} ${res.url()}`);
    }
  });

  page.on('crash', () => {
    diagnostics.push('PAGE_CRASH');
  });

  return {
    diagnostics,
    async flush(testInfo) {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('chromium-diagnostics.txt', {
          body: Buffer.from(diagnostics.join('\n') || 'No diagnostics captured', 'utf8'),
          contentType: 'text/plain'
        });
        try {
          await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true });
        } catch {
          // If the page crashed or closed, screenshot capture is best-effort.
        }
      }
    }
  };
}
