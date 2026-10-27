import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { RELEASE } from '../src/version.js';
import { attachChromiumDiagnostics } from './diagnostics.js';

const server = 'http://127.0.0.1:3100/deploy';

test('deployment centre reads real status, reports blockers and exports sanitized evidence', async ({ page }, testInfo) => {
  const { diagnostics, flush } = attachChromiumDiagnostics(page);
  const external = [];
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:3100')) external.push(request.url()); });
  try {
    await page.goto(server);
    await expect(page.locator('#version')).toHaveText(`v${RELEASE.version}`);
    await expect(page.locator('.check-card')).toHaveCount(6);
    await expect(page.locator('#environment-label')).toContainText('النشر الدائم غير متحقق');
    await expect(page.locator('#checks-grid')).toContainText('غير دائم / غير متاح');
    await expect(page.locator('#readiness-notice')).toContainText('لا يمكن اعتماد');
    const href = await page.locator('#deploy-link').getAttribute('href');
    const target = new URL(href);
    expect(target.origin).toBe('https://render.com');
    expect(target.searchParams.get('repo')).toBe('https://github.com/celiaelazamey-arch/phone-google');
    const event = page.waitForEvent('download');
    await page.locator('#export-report').click();
    const download = await event;
    const report = JSON.parse(await readFile(await download.path(), 'utf8'));
    expect(report.storage.durable).toBe(false);
    expect(report.fullApiMounted).toBe(false);
    expect(report.allCapabilitiesVerified).toBe(false);
    expect(report.stale).toBe(false);
    expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    await flush(testInfo);
  }
});

test('failed refresh retains and labels stale evidence instead of manufacturing success', async ({ page }) => {
  await page.goto(server);
  await expect(page.locator('.check-card')).toHaveCount(6);
  await page.route('**/api/deployment', (route) => route.abort('failed'));
  await page.locator('#run-checks').click();
  await expect(page.locator('#readiness-notice')).toContainText('قديم');
  await expect(page.locator('.check-card')).toHaveCount(6);
  const event = page.waitForEvent('download');
  await page.locator('#export-report').click();
  const report = JSON.parse(await readFile(await (await event).path(), 'utf8'));
  expect(report.stale).toBe(true);
  expect(report.allCapabilitiesVerified).toBe(false);
});

test('static deployment centre works under the repository subpath and never claims a full backend', async ({ page }) => {
  const failed = [];
  page.on('response', (response) => { if (response.status() >= 400) failed.push(response.url()); });
  await page.goto('http://127.0.0.1:3101/phone-google/deploy.html');
  await expect(page.locator('#environment-label')).toContainText('متصفح');
  await expect(page.locator('#checks-grid')).toContainText('متصفح فقط');
  await expect(page.locator('#checks-grid')).toContainText('غير مفعلة');
  await expect(page.locator('a[href="./system.html"]')).toHaveCount(2);
  expect(failed).toEqual([]);
});

test('deployment centre is usable at 320px and passes automated WCAG 2.2 AA checks', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(server);
  await expect(page.locator('.check-card')).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
  await page.getByRole('link', { name: 'شاهد الفحص الفعلي' }).click();
  await expect(page).toHaveURL(/#checks$/);
});
