// ABOUTME: Checks npm registry for newer version of @serendb/runtime on startup.
// ABOUTME: Prints a warning if the installed version is outdated.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getInstalledVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch("https://registry.npmjs.org/@serendb/runtime/latest", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Non-blocking update check. Logs a warning if a newer version is available.
 */
export function checkForUpdates(): void {
  const current = getInstalledVersion();

  // Fire-and-forget — never block startup
  getLatestVersion().then((latest) => {
    if (latest && isNewer(latest, current)) {
      console.log("");
      console.log(`  ╔══════════════════════════════════════════════════════╗`);
      console.log(`  ║  Update available: v${current} → v${latest.padEnd(10)}            ║`);
      console.log(`  ║  Run: npm update -g @serendb/runtime                ║`);
      console.log(`  ╚══════════════════════════════════════════════════════╝`);
      console.log("");
    }
  }).catch(() => {
    // Silently ignore update check failures
  });
}
