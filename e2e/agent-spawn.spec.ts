// ABOUTME: E2E tests for agent spawning.
// ABOUTME: Verifies agents produce visible feedback (Starting/Installing/error) on spawn.

import { test, expect } from "@playwright/test";

test.describe("Agent spawning", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=New Agent", { timeout: 15_000 });
  });

  test("New Agent launcher opens and shows agent options", async ({ page }) => {
    await page.locator("text=New Agent").click();
    const serenAgent = page.locator("text=Seren Agent").first();
    await expect(serenAgent).toBeVisible({ timeout: 3_000 });
  });

  test("Claude Agent spawn produces visible feedback", async ({ page }) => {
    test.setTimeout(60_000);
    await page.locator("text=New Agent").click();
    await page.waitForTimeout(500);

    const claudeBtn = page.locator("button >> text=Claude Agent").first();
    if (!(await claudeBtn.isVisible().catch(() => false))) {
      test.skip(true, "Claude Agent not available in this runtime");
      return;
    }

    await claudeBtn.click();
    await page.waitForTimeout(3_000);

    // Button should show progress: "Starting...", "Installing...", or an error banner
    const body = await page.locator("body").textContent();
    const hasProgress =
      body?.includes("Starting") ||
      body?.includes("Installing") ||
      body?.includes("Failed") ||
      body?.includes("Could not");
    expect(hasProgress).toBe(true);
  });

  test("Codex Agent spawn produces visible feedback", async ({ page }) => {
    test.setTimeout(60_000);
    await page.locator("text=New Agent").click();
    await page.waitForTimeout(500);

    const codexBtn = page.locator("button >> text=Codex Agent").first();
    if (!(await codexBtn.isVisible().catch(() => false))) {
      test.skip(true, "Codex Agent not available in this runtime");
      return;
    }

    await codexBtn.click();
    await page.waitForTimeout(3_000);

    const body = await page.locator("body").textContent();
    const hasProgress =
      body?.includes("Starting") ||
      body?.includes("Installing") ||
      body?.includes("Failed") ||
      body?.includes("Could not");
    expect(hasProgress).toBe(true);
  });
});
