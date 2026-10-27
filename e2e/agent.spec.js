import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { attachChromiumDiagnostics } from './diagnostics.js';

const LIVE = 'http://127.0.0.1:3100';
const STATIC = 'http://127.0.0.1:3101/phone-google';
const TOKEN = 'e2e-only-not-a-production-token-0000000000';

async function expectNoA11yViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const unexpected = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' '))
  }));
  expect(unexpected).toEqual([]);
}

test.describe('مساحة الوكيل وشبكة المعرفة (/agent, /kb) — فحص Chromium التشخيصي', () => {
  test('صفحة /agent الحية تعمل بلا أي خطأ تشخيصي وتلتزم بـ WCAG 2.2 AA و320px RTL', async ({ page }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`${LIVE}/agent`, { waitUntil: 'networkidle' });

      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('#mode-badge')).toContainText('أدخل الرمز لعرض الحالة');
      await expect(page.locator('#plan-state')).toContainText('بلا خطة');

      const overflow320 = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow320).toBeLessThanOrEqual(1);

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.fill('#token', TOKEN);
      await page.click('#connect');
      await expect(page.locator('#auth-status')).toContainText('متصل');
      await expect(page.locator('#mode-badge')).toContainText('الوكيل متوقف (off)');

      await expectNoA11yViolations(page);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });

  test('النسخة الثابتة تحت مسار فرعي (/phone-google/agent.html و /phone-google/kb.html) تحمل كل الأصول بلا 404 وتعلن حدودها بصدق', async ({
    page
  }, testInfo) => {
    const { diagnostics, flush } = attachChromiumDiagnostics(page);
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`${STATIC}/agent.html`, { waitUntil: 'networkidle' });

      await expect(page.locator('#mode-badge')).toContainText('نسخة ثابتة');
      await expect(page.locator('#run')).toBeDisabled();
      const overflowAgent = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflowAgent).toBeLessThanOrEqual(1);
      await expectNoA11yViolations(page);

      await page.goto(`${STATIC}/kb.html`, { waitUntil: 'networkidle' });
      await expect(page.locator('#kb-badge')).toContainText('نسخة ثابتة');
      await expect(page.locator('#search')).toBeDisabled();
      const overflowKb = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflowKb).toBeLessThanOrEqual(1);
      await expectNoA11yViolations(page);

      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    } finally {
      await flush(testInfo);
    }
  });
});
