// ABOUTME: Playwright E2E test configuration.
// ABOUTME: Tests run against the embedded SPA served by the local runtime on port 19420.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:19420",
    headless: true,
  },
});
