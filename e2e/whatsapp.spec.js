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
    // WA-008: the Google icon is present but honestly disabled in the static preview.
    await page.locator('#account-panel').evaluate((element) => { element.hidden = false; });
    await expect(page.locator('#google-signin')).toBeDisabled();
    await expect(page.locator('#google-signin')).toContainText('Google');
    await expect(page.locator('#google-signin svg.google-icon')).toHaveCount(1);
    await expect(page.locator('a[href$="/whatsapp"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    expect(diagnostics, diagnostics.join('\n')).toEqual([]);
  } finally { await flush(testInfo); }
});

test('رفض موافقة Google يعرض سببًا عربيًا ثابتًا ويزيل رمز الخطأ من عنوان الصفحة', async ({ page }, testInfo) => {
  const { diagnostics, flush } = attachChromiumDiagnostics(page);
  try {
    await page.goto(`${STATIC}/whatsapp.html?google_error=google_access_denied`, { waitUntil: 'networkidle' });
    await page.locator('#account-panel').evaluate((element) => { element.hidden = false; });
    await expect(page.locator('#account-status')).toHaveText('لم تمنح Google الإذن. لم يتم تسجيل الدخول أو إنشاء حساب.');
    await expect(page).toHaveURL(`${STATIC}/whatsapp.html`);
    await expect(page.locator('body')).not.toContainText('access_denied');
    expect(diagnostics, diagnostics.join('\n')).toEqual([]);
  } finally { await flush(testInfo); }
});
