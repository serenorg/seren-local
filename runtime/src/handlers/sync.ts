// ABOUTME: File system watcher handlers for detecting file changes.
// ABOUTME: Uses Node's native fs.watch to watch directories and emit events via WebSocket.

import { watch, type FSWatcher } from "node:fs";
import { emit } from "../events.js";

let watcher: FSWatcher | null = null;
let watchingPath: string | null = null;

export async function startWatching(params: {
  path: string;
}): Promise<void> {
  // Stop existing watcher if any
  if (watcher) {
    watcher.close();
    watcher = null;
    watchingPath = null;
  }

  watchingPath = params.path;

  watcher = watch(
    params.path,
    { recursive: true },
    (eventType, filename) => {
      if (!filename) return;

      // Skip common noise
      if (
        filename.includes("node_modules") ||
        filename.includes(".git") ||
        filename.endsWith(".DS_Store")
      ) {
        return;
      }

      const filePath =
        filename.startsWith("/") ? filename : `${params.path}/${filename}`;

      emit("file-changed", {
        paths: [filePath],
        kind: eventType,
      });

      emit("sync-status", {
        status: "syncing",
        message: `File changed: ${filePath}`,
        watchingPath,
      });

      // Reset to synced after a short delay
      setTimeout(() => {
        emit("sync-status", {
          status: "synced",
          message: null,
          watchingPath,
        });
      }, 500);
    },
  );

  watcher.on("error", (error) => {
    emit("sync-status", {
      status: "error",
      message: `Watch error: ${error}`,
      watchingPath: null,
    });
  });

  emit("sync-status", {
    status: "synced",
    message: `Watching: ${params.path}`,
    watchingPath: params.path,
  });
}

export async function stopWatching(): Promise<void> {
  if (watcher) {
    watcher.close();
    watcher = null;
    watchingPath = null;
  }

  emit("sync-status", {
    status: "idle",
    message: null,
    watchingPath: null,
  });
}
