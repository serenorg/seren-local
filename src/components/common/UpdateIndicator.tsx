// ABOUTME: Banner shown when a new version of Seren Local Desktop is available.
// ABOUTME: Provides one-click "Install Update" that restarts the server with the new version.

import { type Component, Show } from "solid-js";
import { updaterStore } from "@/stores/updater.store";

export const UpdateIndicator: Component = () => {
  const showBanner = () =>
    !updaterStore.state.dismissed &&
    (updaterStore.state.status === "available" || updaterStore.state.status === "installing");

  return (
    <Show when={showBanner()}>
      <div class="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-[rgba(46,160,67,0.12)] border-b border-[rgba(46,160,67,0.3)] text-sm text-[#3fb950]">
        <Show
          when={updaterStore.state.status !== "installing"}
          fallback={
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" role="img" aria-label="Updating">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Updating to v{updaterStore.state.latestVersion}... Seren will restart shortly.</span>
            </div>
          }
        >
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 16 16" role="img" aria-label="Update available">
              <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v4.5a.75.75 0 001.5 0v-4.5zM8 12a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
            <span>
              Update available: <strong>v{updaterStore.state.latestVersion}</strong>
              {updaterStore.state.currentVersion && (
                <span class="text-[#8b949e]"> (you have v{updaterStore.state.currentVersion})</span>
              )}
            </span>
          </div>
        </Show>
        <div class="flex items-center gap-2">
          <Show when={updaterStore.state.status === "available"}>
            <button
              type="button"
              class="px-3 py-1 bg-[#238636] text-white rounded-md text-xs font-medium hover:bg-[#2ea043] transition-colors"
              onClick={() => updaterStore.installAvailableUpdate()}
            >
              Install Update
            </button>
            <button
              type="button"
              class="px-2 py-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors text-xs"
              onClick={() => updaterStore.deferUpdate()}
              title="Dismiss"
            >
              &times;
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};
