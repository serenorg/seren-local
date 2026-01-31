// ABOUTME: Updater store stub for browser environment.
// ABOUTME: Browser app updates via CDN deploy, no client-side updater needed.

import { createStore } from "solid-js/store";

export type UpdateStatus = "unsupported";

interface UpdaterState {
  status: UpdateStatus;
}

const [state] = createStore<UpdaterState>({
  status: "unsupported",
});

export const updaterStore = {
  state,
  initUpdater(): void {
    // Browser app updates via CDN deploy — no client-side updater
  },
  checkForUpdates(): void {},
  installAvailableUpdate(): void {},
  deferUpdate(): void {},
};
