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
    const res = await request.get("/api/publishers?limit=1");
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

  test("runtime WebSocket connects and sidebar is available", async ({
    page,
  }) => {
    await page.goto("/");

    // Wait for runtime connection — the sidebar should show "Open Folder" button
    // in the thread sidebar or the empty state
    const openFolder = page.locator("text=Open Folder").first();
    await expect(openFolder).toBeVisible({ timeout: 10_000 });
  });
});
