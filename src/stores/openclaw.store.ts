// ABOUTME: Reactive state for OpenClaw process status, connected channels, and per-channel config.
// ABOUTME: Communicates with Rust backend via Tauri runtimeInvoke() calls and listens for events.

import { createStore } from "solid-js/store";
import { onRuntimeEvent, runtimeInvoke } from "@/lib/bridge";

type UnlistenFn = () => void;

// ============================================================================
// Types
// ============================================================================

export type ProcessStatus =
  | "stopped"
  | "starting"
  | "running"
  | "crashed"
  | "restarting";

export type ChannelStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "error";

export type AgentMode = "seren" | "openclaw";

export type TrustLevel = "auto" | "mention-only" | "approval-required";

export interface OpenClawChannel {
  id: string;
  platform: string;
  displayName: string;
  status: ChannelStatus;
  agentMode: AgentMode;
  trustLevel: TrustLevel;
  errorMessage?: string;
}

interface OpenClawState {
  processStatus: ProcessStatus;
  channels: OpenClawChannel[];
  setupComplete: boolean;
  port: number | null;
  uptimeSecs: number | null;
}

// ============================================================================
// Store
// ============================================================================

const [state, setState] = createStore<OpenClawState>({
  processStatus: "stopped",
  channels: [],
  setupComplete: false,
  port: null,
  uptimeSecs: null,
});

let unlistenStatus: UnlistenFn | null = null;
let unlistenChannel: UnlistenFn | null = null;
let unlistenMessage: UnlistenFn | null = null;
let initPromise: Promise<void> | null = null;

const OPENCLAW_STORE = "openclaw.json";

// ============================================================================
// Event Listeners
// ============================================================================

function setupEventListeners() {
  unlistenStatus = onRuntimeEvent("openclaw://status-changed", (payload) => {
    const data = payload as { status: ProcessStatus };
    setState("processStatus", data.status);
  });

  unlistenChannel = onRuntimeEvent("openclaw://channel-event", (payload) => {
    const data = payload as {
      type: string;
      id?: string;
      platform?: string;
      status?: string;
    };
    const { type: eventType, id } = data;

    if (!id) return;

    const channelIndex = state.channels.findIndex((c) => c.id === id);

    if (
      eventType === "channel:connected" ||
      eventType === "channel:disconnected" ||
      eventType === "channel:error"
    ) {
      const newStatus: ChannelStatus =
        eventType === "channel:connected"
          ? "connected"
          : eventType === "channel:error"
            ? "error"
            : "disconnected";

      if (channelIndex >= 0) {
        setState("channels", channelIndex, "status", newStatus);
      }
    }
  });

  unlistenMessage = onRuntimeEvent(
    "openclaw://message-received",
    (_payload) => {
      // Message events are handled by the notification system (Phase 6)
      // and agent routing (Phase 4). No store update needed here.
    },
  );
}

function teardownEventListeners() {
  unlistenStatus?.();
  unlistenChannel?.();
  unlistenMessage?.();
  unlistenStatus = null;
  unlistenChannel = null;
  unlistenMessage = null;
}

// ============================================================================
// Default Trust Levels
// ============================================================================

/** Personal messaging platforms default to approval-required for safety. */
function defaultTrustLevel(platform: string): TrustLevel {
  switch (platform) {
    case "whatsapp":
    case "signal":
    case "imessage":
    case "bluebubbles":
      return "approval-required";
    case "telegram":
    case "discord":
    case "slack":
    case "mattermost":
    case "googlechat":
    case "msteams":
      return "auto";
    default:
      return "approval-required";
  }
}

// ============================================================================
// Actions
// ============================================================================

export const openclawStore = {
  // --- Getters ---

  get processStatus() {
    return state.processStatus;
  },
  get channels() {
    return state.channels;
  },
  get setupComplete() {
    return state.setupComplete;
  },
  get isRunning() {
    return state.processStatus === "running";
  },
  get connectedChannelCount() {
    return state.channels.filter((c) => c.status === "connected").length;
  },
  get port() {
    return state.port;
  },

  // --- Lifecycle ---

  async init() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      setupEventListeners();

      // Load setupComplete flag from Tauri store
      let value: string | null = null;
      try {
        value = await runtimeInvoke<string | null>("get_setting", {
          store: OPENCLAW_STORE,
          key: "setup_complete",
        });
      } catch {
        // Store doesn't exist yet — first run
      }

      setState("setupComplete", value === "true");
    })();

    return initPromise;
  },

  destroy() {
    teardownEventListeners();
    initPromise = null;
  },

  // --- Process Management ---

  async start() {
    try {
      await runtimeInvoke("openclaw_start");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "already running" is not an error — treat it as success
      if (msg.toLowerCase().includes("already running")) {
        console.log(
          "[OpenClaw Store] OpenClaw already running, skipping start",
        );
      } else {
        console.error("[OpenClaw Store] Failed to start:", e);
        throw e;
      }
    }

    // Refresh status and channels once the process is (re)started
    await openclawStore.refreshStatus();
    await openclawStore.refreshChannels();
  },

  async stop() {
    try {
      await runtimeInvoke("openclaw_stop");
    } catch (e) {
      console.error("[OpenClaw Store] Failed to stop:", e);
      throw e;
    }
  },

  async restart() {
    try {
      await runtimeInvoke("openclaw_restart");
    } catch (e) {
      console.error("[OpenClaw Store] Failed to restart:", e);
      throw e;
    }

    await openclawStore.refreshStatus();
    await openclawStore.refreshChannels();
  },

  async refreshStatus() {
    try {
      const info = await runtimeInvoke<{
        processStatus: ProcessStatus;
        port: number | null;
        channels: OpenClawChannel[];
        uptimeSecs: number | null;
      }>("openclaw_status");
      setState("processStatus", info.processStatus);
      setState("port", info.port);
      setState("uptimeSecs", info.uptimeSecs);
    } catch (e) {
      console.error("[OpenClaw Store] Failed to get status:", e);
    }
  },

  // --- Channel Management ---

  async refreshChannels() {
    try {
      const channels = await runtimeInvoke<OpenClawChannel[]>(
        "openclaw_list_channels",
      );
      // Preserve local agentMode and trustLevel settings
      const merged = channels.map((ch) => {
        const existing = state.channels.find((c) => c.id === ch.id);
        return {
          ...ch,
          agentMode: existing?.agentMode ?? "seren",
          trustLevel: existing?.trustLevel ?? defaultTrustLevel(ch.platform),
        };
      });
      setState("channels", merged);

      // Sync default trust levels to backend for any channels it doesn't know about yet
      for (const ch of merged) {
        runtimeInvoke("openclaw_set_trust", {
          channelId: ch.id,
          trustLevel: ch.trustLevel,
          agentMode: ch.agentMode,
        }).catch((e) => {
          console.error(
            "[OpenClaw Store] Failed to sync trust for channel:",
            ch.id,
            e,
          );
        });
      }
    } catch (e) {
      console.error("[OpenClaw Store] Failed to list channels:", e);
    }
  },

  configureChannel(
    channelId: string,
    config: { agentMode?: AgentMode; trustLevel?: TrustLevel },
  ) {
    const index = state.channels.findIndex((c) => c.id === channelId);
    if (index < 0) return;

    if (config.agentMode !== undefined) {
      setState("channels", index, "agentMode", config.agentMode);
    }
    if (config.trustLevel !== undefined) {
      setState("channels", index, "trustLevel", config.trustLevel);
    }

    // Sync trust settings to Rust backend for enforcement
    const channel = state.channels[index];
    runtimeInvoke("openclaw_set_trust", {
      channelId,
      trustLevel: channel.trustLevel,
      agentMode: channel.agentMode,
    }).catch((e) => {
      console.error("[OpenClaw Store] Failed to sync trust settings:", e);
    });
  },

  // --- Messaging ---

  async connectChannel(platform: string, credentials: Record<string, string>) {
    // Auto-start OpenClaw if not running
    if (state.processStatus !== "running") {
      console.log(
        "[OpenClaw Store] OpenClaw not running, auto-starting before channel connect...",
      );
      await openclawStore.start();
      // Wait briefly for the gateway to be ready
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("[OpenClaw Store] Connecting channel:", platform);
    const result = await runtimeInvoke<Record<string, unknown>>(
      "openclaw_connect_channel",
      {
        platform,
        credentials,
      },
    );
    console.log("[OpenClaw Store] Channel connect result:", result);
    return result;
  },

  async getQrCode(platform: string) {
    return runtimeInvoke<string>("openclaw_get_qr", { platform });
  },

  async disconnectChannel(channelId: string) {
    await runtimeInvoke("openclaw_disconnect_channel", { channelId });
    // Remove from local state
    setState(
      "channels",
      state.channels.filter((c) => c.id !== channelId),
    );
  },

  async sendMessage(channel: string, to: string, message: string) {
    return runtimeInvoke<string>("openclaw_send", {
      channel,
      to,
      message,
    });
  },

  // --- Setup ---

  async completeSetup() {
    setState("setupComplete", true);
    try {
      await runtimeInvoke("set_setting", {
        store: OPENCLAW_STORE,
        key: "setup_complete",
        value: "true",
      });
    } catch (e) {
      console.error("[OpenClaw Store] Failed to save setup state:", e);
    }
  },

  resetSetup() {
    setState("setupComplete", false);
  },
};
