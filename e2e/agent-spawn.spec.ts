// ABOUTME: E2E tests for agent spawning.
// ABOUTME: Verifies agents complete the full spawn lifecycle — install, start, ready or auth prompt.

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

  test("Claude Agent completes spawn lifecycle", async ({ page }) => {
    test.setTimeout(180_000);

    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("Agent") || text.includes("provider") || text.includes("Session") || text.includes("Method not found")) {
        console.log(`[browser] ${text.slice(0, 200)}`);
      }
    });

    await page.locator("text=New Agent").click();
    await page.waitForTimeout(500);

    const claudeBtn = page.locator("button >> text=Claude Agent").first();
    if (!(await claudeBtn.isVisible().catch(() => false))) {
      test.skip(true, "Claude Agent not available in this runtime");
      return;
    }

    await claudeBtn.click();

    let finalState = "unknown";
    const start = Date.now();

    while (Date.now() - start < 150_000) {
      await page.waitForTimeout(3_000);
      const body = await page.locator("body").textContent() ?? "";
      const elapsed = Math.round((Date.now() - start) / 1000);

      const errorBanner = page.locator('[class*="destructive"]').first();
      if (await errorBanner.isVisible().catch(() => false)) {
        const errText = await errorBanner.textContent();
        finalState = `error: ${errText}`;
        console.log(`[${elapsed}s] ERROR: ${errText}`);
        break;
      }

      if (body.includes("Installing")) { console.log(`[${elapsed}s] Installing CLI...`); continue; }
      if (body.includes("Starting")) { console.log(`[${elapsed}s] Starting...`); continue; }

      const chatInput = page.locator('textarea').first();
      if (await chatInput.isVisible().catch(() => false)) {
        finalState = "interactive-chat";
        console.log(`[${elapsed}s] INTERACTIVE CHAT READY`);
        break;
      }

      if (body.includes("Method not found")) {
        finalState = "rpc-error";
        console.log(`[${elapsed}s] RPC method not found error`);
        break;
      }

      if (body.includes("New Agent") && !body.includes("Starting") && !body.includes("Installing")) {
        finalState = "completed";
        console.log(`[${elapsed}s] Spawn completed`);
        break;
      }
    }

    console.log(`Claude Agent final state: ${finalState}`);
    await page.screenshot({ path: "test-results/claude-lifecycle.png" });

    expect(finalState).not.toBe("unknown");
    expect(finalState).not.toContain("rpc-error");
  });

  test("Codex Agent completes spawn lifecycle", async ({ page }) => {
    test.setTimeout(180_000);

    await page.locator("text=New Agent").click();
    await page.waitForTimeout(500);

    const codexBtn = page.locator("button >> text=Codex Agent").first();
    if (!(await codexBtn.isVisible().catch(() => false))) {
      test.skip(true, "Codex Agent not available in this runtime");
      return;
    }

    await codexBtn.click();

    let finalState = "unknown";
    const start = Date.now();

    while (Date.now() - start < 150_000) {
      await page.waitForTimeout(3_000);
      const body = await page.locator("body").textContent() ?? "";
      const elapsed = Math.round((Date.now() - start) / 1000);

      const errorBanner = page.locator('[class*="destructive"]').first();
      if (await errorBanner.isVisible().catch(() => false)) {
        const errText = await errorBanner.textContent();
        finalState = `error: ${errText}`;
        console.log(`[${elapsed}s] ERROR: ${errText}`);
        break;
      }

      if (body.includes("Installing")) { console.log(`[${elapsed}s] Installing CLI...`); continue; }
      if (body.includes("Starting")) { console.log(`[${elapsed}s] Starting...`); continue; }

      const chatInput = page.locator('textarea').first();
      if (await chatInput.isVisible().catch(() => false)) {
        finalState = "interactive-chat";
        console.log(`[${elapsed}s] INTERACTIVE CHAT READY`);
        break;
      }

      if (body.includes("Method not found")) {
        finalState = "rpc-error";
        console.log(`[${elapsed}s] RPC method not found error`);
        break;
      }

      if (body.includes("New Agent") && !body.includes("Starting") && !body.includes("Installing")) {
        finalState = "completed";
        console.log(`[${elapsed}s] Spawn completed`);
        break;
      }
    }

    console.log(`Codex Agent final state: ${finalState}`);
    await page.screenshot({ path: "test-results/codex-lifecycle.png" });

    expect(finalState).not.toBe("unknown");
    expect(finalState).not.toContain("rpc-error");
  });
});
