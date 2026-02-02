// ABOUTME: Handles update checking against npm registry and self-updating via detached process.
// ABOUTME: Cross-platform: uses bash on macOS/Linux and cmd on Windows.

import { spawn } from "node:child_process";
import { platform, homedir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const CURRENT_VERSION: string = pkg.version;
const PACKAGE_NAME = "@serendb/serendesktop";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

/**
 * Check the npm registry for a newer version of @serendb/serendesktop.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Updater] Registry returned ${res.status}`);
      return { currentVersion: CURRENT_VERSION, latestVersion: null, updateAvailable: false };
    }

    const data = (await res.json()) as { version?: string };
    const latestVersion = data.version ?? null;

    const updateAvailable = latestVersion !== null && latestVersion !== CURRENT_VERSION && isNewer(latestVersion, CURRENT_VERSION);

    console.log(`[Updater] Current: ${CURRENT_VERSION}, Latest: ${latestVersion}, Update: ${updateAvailable}`);
    return { currentVersion: CURRENT_VERSION, latestVersion, updateAvailable };
  } catch (err) {
    console.warn("[Updater] Failed to check for updates:", err);
    return { currentVersion: CURRENT_VERSION, latestVersion: null, updateAvailable: false };
  }
}

/**
 * Spawn a detached process that installs the update and restarts the server.
 * The current process exits so the npm install can overwrite the package.
 */
export async function installUpdate(): Promise<{ started: boolean }> {
  const home = homedir();
  const serenDir = resolve(home, ".seren-local");
  const nodeDir = resolve(serenDir, "node");
  const binDir = resolve(serenDir, "bin");
  const isWin = platform() === "win32";

  // Build PATH that includes Seren's private node/npm
  const nodeBinDir = isWin ? nodeDir : resolve(nodeDir, "bin");
  const npmCmd = isWin ? resolve(nodeBinDir, "npm.cmd") : resolve(nodeBinDir, "npm");
  const serendesktopCmd = isWin ? "serendesktop.cmd" : "serendesktop";

  if (isWin) {
    // Windows: use cmd /c with timeout
    const script = [
      `timeout /t 2 /nobreak >nul`,
      `set "PATH=${nodeBinDir};${binDir};%PATH%"`,
      `"${npmCmd}" install -g ${PACKAGE_NAME} --prefix "${serenDir}"`,
      `"${serendesktopCmd}"`,
    ].join(" && ");

    const child = spawn("cmd", ["/c", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } else {
    // macOS / Linux: use bash -c with sleep
    const script = [
      `sleep 2`,
      `export PATH="${nodeBinDir}:${binDir}:$PATH"`,
      `"${npmCmd}" install -g ${PACKAGE_NAME} --prefix "${serenDir}"`,
      `"${serendesktopCmd}"`,
    ].join(" && ");

    const child = spawn("bash", ["-c", script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  console.log("[Updater] Detached updater spawned, exiting server...");

  // Give the response time to flush before exiting
  setTimeout(() => process.exit(0), 500);

  return { started: true };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Compare semver strings. Returns true if a > b. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}
