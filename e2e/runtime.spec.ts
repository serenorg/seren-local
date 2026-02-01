// ABOUTME: E2E tests for the embedded SPA served by the local runtime.
// ABOUTME: Tests runtime connection, file explorer, and catalog loading.

import { test, expect } from "@playwright/test";

test.describe("Runtime embedded SPA", () => {
  test("serves the SPA with correct title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Seren Local");
  });

  test("health endpoint returns JSON", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.token).toBeTruthy();
  });

  test("API proxy returns publishers", async ({ request }) => {
    const res = await request.get("/api/agent/publishers?limit=1");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.length).toBeGreaterThan(0);
  });

  test("SPA fallback serves index.html for unknown routes", async ({
    page,
  }) => {
    const res = await page.goto("/some/unknown/route");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("Seren Local");
  });

  test("runtime WebSocket connects and file explorer becomes available", async ({
    page,
  }) => {
    await page.goto("/");

    // Wait for runtime connection — file explorer should show the "+" button as enabled
    // The runtime connects asynchronously, so we wait for the button to become enabled
    const openFolderBtn = page.locator(
      'button[title="Open Folder"], button[title="Local runtime required"]',
    );
    await expect(openFolderBtn).toBeVisible({ timeout: 10_000 });

    // If runtime connected, the button should have title "Open Folder" and be enabled
    await expect(
      page.locator('button[title="Open Folder"]:not([disabled])'),
    ).toBeVisible({ timeout: 10_000 });
  });
});
