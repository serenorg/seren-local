// ABOUTME: Manages update state by checking npm registry via runtime RPC.
// ABOUTME: Provides one-click update that restarts the server with the new version.

import { createStore } from "solid-js/store";
import { runtimeInvoke } from "@/lib/bridge";

export type UpdateStatus = "idle" | "checking" | "available" | "installing" | "error";

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

export const updaterStore = {
  get state() {
    return state;
  },

  /** Check for updates on startup. Non-blocking — failures are silent. */
  async initUpdater(): Promise<void> {
    try {
      setState("status", "checking");
      const info = await runtimeInvoke<UpdateInfo>("check_for_update");
      setState("currentVersion", info.currentVersion);
      setState("latestVersion", info.latestVersion);
      setState("status", info.updateAvailable ? "available" : "idle");
    } catch (err) {
      console.warn("[Updater] Check failed:", err);
      setState("status", "idle");
    }
  },

  /** Re-check the registry (e.g. from settings panel). */
  async checkForUpdates(): Promise<void> {
    await this.initUpdater();
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
