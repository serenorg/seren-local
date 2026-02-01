// ABOUTME: OpenClaw process management handlers for multi-platform messaging gateway.
// ABOUTME: Spawns openclaw.mjs, communicates via WebSocket/HTTP, manages channels and trust.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  readFile,
  writeFile,
  mkdir,
  access,
  constants,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { emit } from "../events.js";

// ── Types ────────────────────────────────────────────────────────────

type ProcessStatus =
  | "stopped"
  | "starting"
  | "running"
  | "crashed"
  | "restarting";

interface ChannelInfo {
  id: string;
  platform: string;
  displayName: string;
  status: string;
  errorMessage?: string;
}

interface TrustConfig {
  trustLevel: string;
  agentMode: string;
}

// ── State ────────────────────────────────────────────────────────────

let childProcess: ChildProcess | null = null;
let processStatus: ProcessStatus = "stopped";
let hookToken: string | null = null;
let port = 0;
let restartCount = 0;
let startedAt: number | null = null;
let wsClient: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
const channels: ChannelInfo[] = [];
const trustSettings = new Map<string, TrustConfig>();
const approvedIds = new Set<string>();

const MAX_RESTART_ATTEMPTS = 3;
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");

// ── Settings (simple JSON persistence) ───────────────────────────────

const SETTINGS_PATH = join(homedir(), ".seren", "settings.json");

async function loadSettings(): Promise<Record<string, unknown>> {
  try {
    const data = await readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(join(homedir(), ".seren"), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

export async function getSetting(params: any): Promise<unknown> {
  const settings = await loadSettings();
  return settings[params.key] ?? null;
}

export async function setSetting(params: any): Promise<void> {
  const settings = await loadSettings();
  settings[params.key] = params.value;
  await saveSettings(settings);
}

// ── Port Discovery ───────────────────────────────────────────────────

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        server.close(() => resolve(p));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

// ── Token Management ─────────────────────────────────────────────────

async function getOrCreateToken(): Promise<string> {
  if (hookToken) return hookToken;

  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
    if (config.hookToken) {
      hookToken = config.hookToken;
      return hookToken!;
    }
  } catch {
    // Config doesn't exist yet
  }

  hookToken = randomBytes(32).toString("hex");

  // Persist token
  await mkdir(OPENCLAW_DIR, { recursive: true });
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    // Fresh config
  }
  config.hookToken = hookToken;
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });

  return hookToken;
}

// ── OpenClaw Binary Discovery ────────────────────────────────────────

async function findOpenClawEntrypoint(): Promise<string> {
  const candidates = [
    // Global npm install
    join(homedir(), ".seren", "lib", "node_modules", "openclaw", "openclaw.mjs"),
    // Development
    join(homedir(), ".openclaw", "openclaw.mjs"),
  ];

  // Also check PATH via `which openclaw`
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const path = await new Promise<string>((resolve, reject) => {
      execFile(cmd, ["openclaw"], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    if (path) candidates.unshift(path);
  } catch {
    // Not in PATH
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Not found here
    }
  }

  throw new Error(
    "OpenClaw not found. Install it or ensure openclaw.mjs is in ~/.openclaw/",
  );
}

// ── WebSocket Connection ─────────────────────────────────────────────

function connectWebSocket(): void {
  if (!port || !hookToken) return;

  const url = `ws://127.0.0.1:${port}/ws?token=${hookToken}`;
  wsClient = new WebSocket(url);

  wsClient.on("open", () => {
    console.log("[OpenClaw] WebSocket connected");
  });

  wsClient.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleOpenClawEvent(msg);
    } catch (err) {
      console.error("[OpenClaw] Failed to parse WS message:", err);
    }
  });

  wsClient.on("close", () => {
    wsClient = null;
    if (processStatus === "running") {
      scheduleWsReconnect();
    }
  });

  wsClient.on("error", (err) => {
    console.error("[OpenClaw] WebSocket error:", err.message);
  });
}

function scheduleWsReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** restartCount, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (processStatus === "running") {
      connectWebSocket();
    }
  }, delay);
}

function handleOpenClawEvent(msg: any): void {
  const { type, ...payload } = msg;

  switch (type) {
    case "channel:connected":
    case "channel:disconnected":
    case "channel:error":
      emit("openclaw://channel-event", { type, ...payload });
      break;

    case "message:received":
      emit("openclaw://message-received", payload);
      break;

    default:
      console.log("[OpenClaw] Unknown event:", type);
  }
}

// ── Process Monitor ──────────────────────────────────────────────────

function startProcessMonitor(): void {
  if (monitorTimer) return;

  monitorTimer = setInterval(() => {
    if (!childProcess || processStatus !== "running") return;

    // Check if process is still alive
    try {
      childProcess.kill(0); // Signal 0 = check existence
    } catch {
      // Process died
      processStatus = "crashed";
      emit("openclaw://status-changed", { status: "crashed" });

      if (restartCount < MAX_RESTART_ATTEMPTS) {
        restartCount++;
        processStatus = "restarting";
        emit("openclaw://status-changed", { status: "restarting" });
        openclawStart({}).catch((err) =>
          console.error("[OpenClaw] Auto-restart failed:", err),
        );
      }
    }
  }, 2000);
}

function stopProcessMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

// ── RPC Handlers ─────────────────────────────────────────────────────

export async function openclawStart(_params: any): Promise<void> {
  if (processStatus === "running") return;

  processStatus = "starting";
  emit("openclaw://status-changed", { status: "starting" });

  const entrypoint = await findOpenClawEntrypoint();
  const token = await getOrCreateToken();
  port = await findAvailablePort();

  childProcess = spawn("node", [entrypoint, "gateway", "--allow-unconfigured"], {
    cwd: OPENCLAW_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });

  // Log stdout/stderr
  if (childProcess.stdout) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: childProcess.stdout });
    rl.on("line", (line: string) => console.log(`[OpenClaw stdout] ${line}`));
  }
  if (childProcess.stderr) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: childProcess.stderr });
    rl.on("line", (line: string) => console.log(`[OpenClaw stderr] ${line}`));
  }

  childProcess.on("exit", (code, signal) => {
    console.log(`[OpenClaw] Process exited: code=${code}, signal=${signal}`);
    childProcess = null;
    if (processStatus !== "stopped" && processStatus !== "restarting") {
      processStatus = "crashed";
      emit("openclaw://status-changed", { status: "crashed" });
    }
  });

  // Wait briefly for process to start, then connect WebSocket
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (childProcess && !childProcess.killed) {
    processStatus = "running";
    startedAt = Date.now();
    restartCount = 0;
    emit("openclaw://status-changed", { status: "running" });
    connectWebSocket();
    startProcessMonitor();
  } else {
    processStatus = "crashed";
    emit("openclaw://status-changed", { status: "crashed" });
    throw new Error("OpenClaw process failed to start");
  }
}

export async function openclawStop(_params: any): Promise<void> {
  processStatus = "stopped";
  emit("openclaw://status-changed", { status: "stopped" });

  stopProcessMonitor();

  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (childProcess) {
    childProcess.kill("SIGTERM");
    // Force kill after 5 seconds
    const proc = childProcess;
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }, 5000);
    childProcess = null;
  }

  startedAt = null;
}

export async function openclawRestart(_params: any): Promise<void> {
  await openclawStop({});
  await new Promise((resolve) => setTimeout(resolve, 500));
  await openclawStart({});
}

export async function openclawStatus(_params: any): Promise<any> {
  return {
    status: processStatus,
    port: processStatus === "running" ? port : null,
    uptimeSecs: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
    channels,
    restartCount,
  };
}

export async function openclawListChannels(_params: any): Promise<any[]> {
  if (processStatus !== "running") return [];

  // Query channels via CLI
  const entrypoint = await findOpenClawEntrypoint();
  return new Promise((resolve) => {
    execFile(
      "node",
      [entrypoint, "channels", "status", "--json"],
      { cwd: OPENCLAW_DIR, timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          console.error("[OpenClaw] Failed to list channels:", err);
          resolve([]);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const result: ChannelInfo[] = [];
          const accounts = data.channelAccounts || {};
          for (const [id, info] of Object.entries(accounts)) {
            const ch = info as any;
            result.push({
              id,
              platform: id.split(":")[0] || id,
              displayName: ch.label || id,
              status: ch.running ? "connected" : "disconnected",
              errorMessage: ch.error,
            });
          }
          // Update in-memory cache
          channels.length = 0;
          channels.push(...result);
          resolve(result);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

export async function openclawConnectChannel(params: any): Promise<any> {
  const { platform: plat, credentials } = params;

  // Read or create config
  let config: any = {};
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    // Fresh config
  }

  if (!config.channels) config.channels = {};

  // Platform-specific config
  switch (plat) {
    case "signal":
      config.channels.signal = {
        enabled: true,
        account: credentials.phone,
      };
      break;
    case "telegram":
      config.channels.telegram = {
        enabled: true,
        botToken: credentials.botToken,
      };
      break;
    case "discord":
      config.channels.discord = {
        enabled: true,
        botToken: credentials.botToken,
      };
      break;
    case "slack":
      config.channels.slack = {
        enabled: true,
        botToken: credentials.botToken,
        appToken: credentials.appToken,
      };
      break;
    case "whatsapp":
      config.channels.whatsapp = { enabled: true };
      break;
    default:
      config.channels[plat] = { enabled: true, ...credentials };
  }

  // Persist hook token
  if (hookToken) config.hookToken = hookToken;

  await mkdir(OPENCLAW_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });

  return { success: true, platform: plat };
}

export async function openclawDisconnectChannel(params: any): Promise<void> {
  const { channelId } = params;
  const entrypoint = await findOpenClawEntrypoint();

  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [entrypoint, "channels", "remove", "--channel", channelId, "--delete"],
      { cwd: OPENCLAW_DIR, timeout: 10_000 },
      (err) => {
        if (err) reject(new Error(`Failed to disconnect: ${err.message}`));
        else resolve();
      },
    );
  });
}

export async function openclawSetTrust(params: any): Promise<void> {
  const { channelId, trustLevel, agentMode } = params;
  trustSettings.set(channelId, { trustLevel, agentMode });

  // Persist to settings
  const settings = await loadSettings();
  const trust = (settings.openclawTrust as Record<string, TrustConfig>) || {};
  trust[channelId] = { trustLevel, agentMode };
  settings.openclawTrust = trust;
  await saveSettings(settings);
}

export async function openclawSend(params: any): Promise<string> {
  const { channel, to, message } = params;

  if (processStatus !== "running" || !port || !hookToken) {
    throw new Error("OpenClaw is not running");
  }

  // Check approval if needed
  const key = `${channel}:${to}`;
  const trust = trustSettings.get(channel);
  if (trust?.trustLevel === "approval-required" && !approvedIds.has(key)) {
    throw new Error("Message requires approval");
  }
  approvedIds.delete(key);

  // Send via HTTP webhook
  const url = `http://127.0.0.1:${port}/hooks/agent`;
  const body = JSON.stringify({ message, channel, to });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hookToken}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OpenClaw send failed: ${response.status}`);
  }

  const result = await response.text();
  return result;
}

export async function openclawGrantApproval(params: any): Promise<void> {
  const { channel, to } = params;
  approvedIds.add(`${channel}:${to}`);
}

export async function openclawGetQr(params: any): Promise<string> {
  const { platform: plat } = params;
  const entrypoint = await findOpenClawEntrypoint();

  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [entrypoint, "channels", "qr", "--platform", plat, "--json"],
      { cwd: OPENCLAW_DIR, timeout: 30_000 },
      (err, stdout) => {
        if (err) reject(new Error(`Failed to get QR: ${err.message}`));
        else {
          try {
            const data = JSON.parse(stdout);
            resolve(data.qr || data.qrCode || stdout.trim());
          } catch {
            resolve(stdout.trim());
          }
        }
      },
    );
  });
}
