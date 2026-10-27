import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = 'http://127.0.0.1:3101/phone-google';
const cronUrl = `${base}/cron.html`;
const mapUrl = `${base}/google-map.html`;

async function collectPageFaults(page) {
  const faults = [];
  page.on('pageerror', (error) => faults.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(`console.error: ${message.text()}`);
  });
  return faults;
}

async function assertNoPageFaults(faults) {
  // مهلة قصيرة عمدًا لالتقاط أخطاء التحميل بدل انتظار مهلة العنصر الكاملة.
  await expect
    .poll(async () => faults.join('\n') || 'clean', { timeout: 2500, message: 'page faults detected' })
    .toBe('clean');
}

test.describe('لوحة المهام المجدولة — الوضع الثابت والمحاكاة', () => {
  test('تعمل في وضع المحاكاة بلا أي طلب خارجي وبلا أخطاء', async ({ page }) => {
    const external = [];
    const faults = await collectPageFaults(page);
    page.on('request', (request) => {
      if (!request.url().startsWith(base)) external.push(request.url());
    });

    await page.goto(cronUrl);
    await assertNoPageFaults(faults);
    await expect(page.locator('h1')).toHaveText('إدارة المهام المجدولة');
    await expect(page.locator('#cr-mode-label')).toContainText('المحاكاة');
    await expect(page.locator('#cr-tbody tr')).toHaveCount(4);
    await expect(page.locator('#cr-stat-total')).toHaveText('4');
    await expect(page.locator('#cr-stat-enabled')).toHaveText('3');
    await expect(page.locator('#cr-stat-disabled')).toHaveText('1');
    await expect(page.locator('.cr-tool-legend li')).toHaveCount(7);
    await expect(page.locator('#cr-banner')).toContainText('بلا اتصال حقيقي');

    expect(external).toEqual([]);
    expect(faults).toEqual([]);
  });

  test('دورة كاملة: إنشاء ثم تعديل ثم تبديل ثم سجل ثم حذف بتأكيدين', async ({ page }) => {
    const faults = await collectPageFaults(page);
    await page.goto(cronUrl);
    await assertNoPageFaults(faults);

    await page.locator('#cr-btn-create').click();
    await expect(page.locator('#cr-job-dialog')).toBeVisible();
    await page.locator('[data-testid="job-title"]').fill('مهمة اختبار المعاينة');
    await page.locator('[data-testid="job-url"]').fill('https://hook.example.test/run');
    await page.locator('[data-testid="job-kind"]').selectOption('weekly');
    await expect(page.locator('#cr-schedule-preview')).toContainText('الجمعة');
    await page.locator('[data-testid="job-save"]').click();
    await expect(page.locator('#cr-tbody tr')).toHaveCount(5);
    await expect(page.locator('#cr-tbody')).toContainText('مهمة اختبار المعاينة');

    const createdRow = page.locator('#cr-tbody tr', { hasText: 'مهمة اختبار المعاينة' });
    await createdRow.getByRole('button', { name: /تعديل/ }).click();
    await page.locator('[data-testid="job-title"]').fill('عنوان معدّل');
    await page.locator('[data-testid="job-save"]').click();
    await expect(page.locator('#cr-tbody')).toContainText('عنوان معدّل');
    const renamedRow = page.locator('#cr-tbody tr', { hasText: 'عنوان معدّل' });

    await page.locator('[data-testid="toggle-9001"]').uncheck();
    await expect(page.locator('#cr-tbody tr', { hasText: 'فحص صحة الخادم اليومي' })).toContainText('معطّلة');
    await page.locator('[data-testid="toggle-9001"]').check();
    await expect(page.locator('#cr-tbody tr', { hasText: 'فحص صحة الخادم اليومي' })).toContainText('مفعّلة');

    await page.locator('#cr-tbody tr', { hasText: 'فحص صحة الخادم اليومي' }).getByRole('button', { name: /السجل/ }).click();
    await expect(page.locator('#cr-history-dialog')).toBeVisible();
    await expect(page.locator('#cr-history-body tr')).toHaveCount(2);
    await page.locator('#cr-history-dialog [data-close]').click();

    await renamedRow.getByRole('button', { name: /حذف/ }).click();
    await expect(page.locator('#cr-delete-dialog')).toBeVisible();
    const confirm = page.locator('[data-testid="confirm-delete"]');
    await confirm.click();
    await expect(confirm).toContainText('مرة أخرى');
    await confirm.click();
    await expect(page.locator('#cr-tbody tr')).toHaveCount(4);
    await expect(page.locator('#cr-tbody')).not.toContainText('عنوان معدّل');
  });

  test('ربط الجسر: تحقق المدخلات ثم اتصال حي بالرمز في الترويسة فقط وقطع يمسح الرمز', async ({ page }) => {
    const faults = await collectPageFaults(page);
    const bridgeRequests = [];
    await page.route('**/api/cron/**', async (route) => {
      const request = route.request();
      bridgeRequests.push({ url: request.url(), method: request.method(), headers: request.headers() });
      if (request.url().endsWith('/health')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [{ jobId: 77, title: 'وظيفة حية', url: 'https://live.example/hook', enabled: true, requestMethod: 0, schedule: { timezone: 'Africa/Cairo', hours: [9], minutes: [0], mdays: [-1], months: [-1], wdays: [-1] } }] })
      });
    });

    await page.goto(cronUrl);
    await assertNoPageFaults(faults);
    await page.locator('#cr-btn-connect').click();
    await page.locator('[data-testid="bridge-url"]').fill('http://insecure.example.com');
    await page.locator('[data-testid="bridge-token"]').fill('short');
    await page.locator('[data-testid="connect-save"]').click();
    await expect(page.locator('#cr-bridge-url-error')).toContainText('HTTPS');
    await expect(page.locator('#cr-bridge-token-error')).toContainText('16');
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

    await page.locator('[data-testid="bridge-url"]').fill('https://celia-cron-bridge.demo.workers.dev');
    await page.locator('[data-testid="bridge-token"]').fill('a'.repeat(32));
    await page.locator('[data-testid="connect-save"]').click();

    await expect(page.locator('#cr-mode-label')).toContainText('متصل بالجسر');
    await expect(page.locator('#cr-tbody tr')).toHaveCount(1);
    await expect(page.locator('#cr-tbody')).toContainText('وظيفة حية');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'celia.cron.bridgeUrl')).toBe('https://celia-cron-bridge.demo.workers.dev');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'celia.cron.adminToken')).toBe('a'.repeat(32));

    expect(bridgeRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of bridgeRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${'a'.repeat(32)}`);
      expect(request.url).not.toContain('Bearer');
      expect(request.url).not.toContain('aaa');
    }

    await page.locator('#cr-btn-connect').click();
    await page.locator('#cr-btn-disconnect').click();
    await expect(page.locator('#cr-mode-label')).toContainText('المحاكاة');
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  });

  test('متجاوبة بلا تمرير أفقي على 360px وخالية من عيوب الوصولية الحرجة', async ({ page }) => {
    const faults = await collectPageFaults(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(cronUrl);
    await assertNoPageFaults(faults);
    await expect(page.locator('#cr-tbody tr')).toHaveCount(4);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(overflow).toBe(true);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).length).toBe(0);
  });
});

test.describe('خريطة Google المجانية', () => {
  test('تعرض كل الخدمات وتصفّيها بالحالة بلا طلبات خارجية', async ({ page }) => {
    const faults = await collectPageFaults(page);
    const external = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(base)) external.push(request.url());
    });
    await page.goto(mapUrl);
    await assertNoPageFaults(faults);
    await expect(page.locator('h1')).toContainText('خريطة ربط CeliaOS');
    const allCards = page.locator('.gm-card');
    const total = await allCards.count();
    expect(total).toBeGreaterThanOrEqual(10);

    await page.locator('.gm-chip[data-filter="decision"]').click();
    await expect(page.locator('.gm-card:not([hidden])')).toHaveCount(await page.locator('.gm-card[data-status="decision"]').count());
    await page.locator('.gm-chip[data-filter="implemented"]').click();
    for (const card of await page.locator('.gm-card:not([hidden])').all()) {
      await expect(card).toHaveAttribute('data-status', 'implemented');
    }
    await page.locator('.gm-chip[data-filter="all"]').click();
    await expect(page.locator('.gm-card:not([hidden])')).toHaveCount(total);
    await expect(page.locator('.gm-gate')).toHaveCount(4);
    expect(external).toEqual([]);
  });
});
