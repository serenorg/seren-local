// ABOUTME: E2E tests for auto-updater functionality.
// ABOUTME: Verifies update check runs and About Dialog shows version.

import { test, expect } from "@playwright/test";

test.describe("Auto-updater", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=New Agent", { timeout: 15_000 });
  });

  test("runtime version is displayed in health endpoint", async ({
    request,
  }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.version).toBeTruthy();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("About Dialog shows version and Check for Updates button", async ({
    page,
  }) => {
    // Trigger the About dialog via the hamburger menu or event
    await page.evaluate(() =>
      window.dispatchEvent(new Event("open-about")),
    );
    await page.waitForTimeout(500);

    // Dialog should be visible with version info
    const dialog = page.locator("text=Seren").first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    // Version row should show a real version — may take a moment for the RPC
    await expect(page.locator(".about-value").first()).not.toHaveText("loading...", { timeout: 10_000 });
    const versionText = await page.locator(".about-value").first().textContent();
    expect(versionText).toMatch(/\d+\.\d+\.\d+/);

    // Check for Updates button should be present
    const checkBtn = page.locator("text=Check for Updates");
    await expect(checkBtn).toBeVisible();
  });
});
