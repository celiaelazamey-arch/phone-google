import { RELEASE, RELEASE_HISTORY } from '../src/version.js';
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const server = "http://127.0.0.1:3100/system";
const staticSite = "http://127.0.0.1:3101/phone-google/system.html";

test("server dashboard is real, responsive, navigable and exports a JSON report", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server);
  await expect(page.locator("#metric-version")).toHaveText(`v${RELEASE.version}`);
  await expect(page.locator(".component-card")).toHaveCount(7);
  await expect(page.locator("#metric-storage")).toHaveText("ذاكرة مؤقتة");
  await expect(page.locator("#notice")).toContainText("ليست نسخة احتياطية");
  await expect(page.locator("#release-list .release-card")).toHaveCount(RELEASE_HISTORY.length);
  await page.locator(".hero-actions a").click();
  await expect(page).toHaveURL(/#releases$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  expect((await downloadEvent).suggestedFilename()).toBe(
    `celia-system-${RELEASE.version}.json`,
  );
  expect(errors).toEqual([]);
});

test("failed status panel retains the release panel and explicitly marks stale data", async ({
  page,
}) => {
  await page.goto(server);
  await expect(page.locator("#metric-version")).toHaveText(`v${RELEASE.version}`);
  await page.route("**/api/system", (route) => route.abort("failed"));
  await page.locator("#refresh").click();
  await expect(page.locator("#connection")).toHaveText("تعذر التحديث");
  await expect(page.locator("#notice")).toContainText("آخر فحص ناجح");
  await expect(page.locator("#release-list .release-card")).toHaveCount(RELEASE_HISTORY.length);
  await expect(page.locator("#metric-version")).toHaveText(`v${RELEASE.version}`);
});

test("an isolated provider does not hide healthy core or release information", async ({
  page,
}) => {
  await page.route("**/api/system", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.status = "degraded";
    body.components.find((c) => c.id === "gemini").state = "isolated";
    body.circuits.find((c) => c.name === "gemini").state = "open";
    await route.fulfill({ json: body });
  });
  await page.goto(server);
  await expect(page.locator("#connection")).toContainText("تشغيل جزئي");
  await expect(page.locator(".component-card .status.isolated")).toHaveText(
    "معزول بالقاطع",
  );
  await expect(
    page
      .locator(".component-card")
      .filter({ has: page.locator("h3", { hasText: "النواة" }) })
      .locator(".status"),
  ).toHaveText("سليم");
  await expect(page.locator("#metric-circuits")).toHaveText("1");
});

test("Pages works under the repository subpath and never claims production resilience", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const failed = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(response.url());
  });
  await page.goto(staticSite);
  await expect(page.locator("#metric-version")).toHaveText(`v${RELEASE.version}`);
  await expect(page.locator("#connection")).toHaveText("معاينة متصفح");
  await expect(page.locator("#notice")).toContainText("قواطع الخادم");
  await expect(page.locator("#metric-circuits")).toHaveText("—");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});

test("system dashboard meets WCAG 2 AA automated checks", async ({ page }) => {
  await page.goto(server);
  await expect(page.locator("#metric-version")).toHaveText(`v${RELEASE.version}`);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("narrow phones and existing studio navigation stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(server);
  await expect(page.locator("#metric-version")).toHaveText(`v${RELEASE.version}`);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3100/studio");
  await expect(page.locator('a[href="./system"]')).toHaveCount(1);
  await expect(page.locator("#view-tools")).toHaveCount(1);
  expect(errors).toEqual([]);
});
