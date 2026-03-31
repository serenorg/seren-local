// ABOUTME: Manages update state by checking npm registry via runtime RPC.
// ABOUTME: Checks on startup and every 15 minutes. Provides one-click update that restarts the server.

import { createStore } from "solid-js/store";
import { isRuntimeConnected, runtimeInvoke, onRuntimeEvent } from "@/lib/bridge";

export type UpdateStatus = "idle" | "checking" | "available" | "installing" | "error";

const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface UpdaterState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  dismissed: boolean;
  error: string | null;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

const [state, setState] = createStore<UpdaterState>({
  status: "idle",
  currentVersion: "",
  latestVersion: null,
  dismissed: false,
  error: null,
});

let checkInterval: ReturnType<typeof setInterval> | null = null;

export const updaterStore = {
  get state() {
    return state;
  },

  /** Check for updates on startup and start recurring checks. Defers until runtime is connected. */
  async initUpdater(): Promise<void> {
    // Fetch version immediately from /health (no auth needed)
    this._fetchVersionFromHealth();

    if (!isRuntimeConnected()) {
      const unsub = onRuntimeEvent("runtime:connected", () => {
        unsub();
        this._startChecking();
      });
      return;
    }
    await this._startChecking();
  },

  /** Fetch version from /health endpoint (always available, no auth needed). */
  async _fetchVersionFromHealth(): Promise<void> {
    if (state.currentVersion) return;
    try {
      const res = await fetch("/health");
      if (res.ok) {
        const data = await res.json();
        if (data.version) setState("currentVersion", data.version);
      }
    } catch { /* ignore */ }
  },

  /** @internal — initial check + start recurring interval. */
  async _startChecking(): Promise<void> {
    await this._fetchVersionFromHealth();
    await this._doCheck();

    if (!checkInterval) {
      checkInterval = setInterval(() => {
        if (state.status !== "installing") {
          this._doCheck();
        }
      }, UPDATE_CHECK_INTERVAL_MS);
    }
  },

  /** Perform the actual update check via runtime RPC. */
  async _doCheck(): Promise<void> {
    try {
      setState("status", "checking");
      const info = await runtimeInvoke<UpdateInfo>("check_for_update");
      setState("currentVersion", info.currentVersion);
      setState("latestVersion", info.latestVersion);
      setState("status", info.updateAvailable ? "available" : "idle");
      if (info.updateAvailable) {
        setState("dismissed", false);
      }
    } catch (err) {
      console.warn("[Updater] Check failed:", err);
      setState("status", "idle");
    }
  },

  /** Re-check the registry (e.g. from About dialog). */
  async checkForUpdates(): Promise<void> {
    setState("dismissed", false);
    await this._doCheck();
  },

  /** Trigger the update: server will restart with new version. */
  async installAvailableUpdate(): Promise<void> {
    try {
      setState("status", "installing");
      setState("error", null);
      await runtimeInvoke<{ started: boolean }>("install_update");
      // Server will exit — connection will drop and page will eventually reload
    } catch (err) {
      console.error("[Updater] Install failed:", err);
      setState("status", "error");
      setState("error", err instanceof Error ? err.message : "Update failed");
    }
  },

  /** Dismiss the banner for this session. */
  deferUpdate(): void {
    setState("dismissed", true);
  },
};
