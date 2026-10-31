import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { attachChromiumDiagnostics } from './diagnostics.js';

const STATIC = 'http://127.0.0.1:3101/phone-google';

test('صفحة ربط واتساب الثابتة لا تدّعي اتصالًا ولا تعرض إدخال مفاتيح Meta', async ({ page }, testInfo) => {
  const { diagnostics, flush } = attachChromiumDiagnostics(page);
  try {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`${STATIC}/whatsapp.html`, { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#connect')).toBeDisabled();
    await expect(page.locator('#connected-panel')).toBeHidden();
    await expect(page.locator('#status')).toContainText('نسخة معاينة');
    await expect(page.locator('#link-panel')).toBeHidden();
    await expect(page.locator('a[href$="/whatsapp"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    expect(diagnostics, diagnostics.join('\n')).toEqual([]);
  } finally { await flush(testInfo); }
});
