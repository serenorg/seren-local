// ABOUTME: ACP (Agent Client Protocol) handlers for spawning and managing AI coding agents.
// ABOUTME: Implements client-side ACP connection over stdio with event forwarding via WebSocket.

import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess, execFile } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { platform } from "node:os";
import { emit } from "../events.js";

// ── Auth helpers ─────────────────────────────────────────────────────

/** Check if an error message indicates the user needs to authenticate. */
function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid api key") ||
    lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("please run /login") ||
    lower.includes("authrequired")
  );
}

/** Wrap an auth-related error with actionable instructions. */
function authErrorMessage(agentType: string): string {
  if (agentType === "claude-code") {
    return "Claude Code is not logged in. Please open a terminal and run:\n\n  claude login\n\nThen try starting the agent again.";
  }
  return "Agent authentication required. Please log in via the agent CLI first.";
}

// ── Types ────────────────────────────────────────────────────────────

interface AcpSession {
  id: string;
  agentType: string;
  cwd: string;
  status: string;
  createdAt: string;
  connection: acp.ClientSideConnection;
  process: ChildProcess;
  pendingPermissions: Map<string, (optionId: string) => void>;
  pendingDiffProposals: Map<string, (accepted: boolean) => void>;
  cancelling: boolean;
}

const sessions = new Map<string, AcpSession>();

// ── Client Implementation ────────────────────────────────────────────

function createClient(sessionId: string): acp.Client {
  return {
    async requestPermission(
      params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> {
      const requestId = randomUUID();
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Session not found");

      // Emit permission request to frontend
      emit("acp://permission-request", {
        sessionId,
        requestId,
        toolCall: params.toolCall,
        options: params.options,
      });

      // Wait for user response (5 minute timeout)
      const optionId = await new Promise<string>((resolve, reject) => {
        session.pendingPermissions.set(requestId, resolve);
        setTimeout(() => {
          session.pendingPermissions.delete(requestId);
          reject(new Error("Permission request timed out"));
        }, 300_000);
      });

      return {
        outcome: { outcome: "selected", optionId },
      };
    },

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      handleSessionUpdate(sessionId, params);
    },

    async readTextFile(
      params: acp.ReadTextFileRequest,
    ): Promise<acp.ReadTextFileResponse> {
      const content = await readFile(params.path, "utf-8");
      return { content };
    },

    async writeTextFile(
      params: acp.WriteTextFileRequest,
    ): Promise<acp.WriteTextFileResponse> {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Session not found");

      // Read old content for diff proposal
      let oldText = "";
      try {
        oldText = await readFile(params.path, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      const proposalId = randomUUID();

      // Emit diff proposal to frontend
      emit("acp://diff-proposal", {
        sessionId,
        proposalId,
        path: params.path,
        oldText,
        newText: params.content,
      });

      // Wait for user accept/reject (5 minute timeout)
      const accepted = await new Promise<boolean>((resolve, reject) => {
        session.pendingDiffProposals.set(proposalId, resolve);
        setTimeout(() => {
          session.pendingDiffProposals.delete(proposalId);
          reject(new Error("Diff proposal timed out"));
        }, 300_000);
      });

      if (!accepted) {
        throw new Error("File write rejected by user");
      }

      await writeFile(params.path, params.content, "utf-8");
      return {};
    },
  };
}

// ── Event Forwarding ─────────────────────────────────────────────────

function handleSessionUpdate(
  sessionId: string,
  notification: acp.SessionNotification,
): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        emit("acp://message-chunk", {
          sessionId,
          text: update.content.text,
        });
      }
      break;

    case "agent_thought_chunk":
      if (update.content.type === "text") {
        emit("acp://message-chunk", {
          sessionId,
          text: update.content.text,
          isThought: true,
        });
      }
      break;

    case "tool_call":
      emit("acp://tool-call", {
        sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status,
      });
      break;

    case "tool_call_update": {
      // Check for diffs in content
      if (update.content) {
        for (const block of update.content) {
          if ("diff" in block || (block as any).path) {
            const diff = block as any;
            emit("acp://diff", {
              sessionId,
              toolCallId: update.toolCallId,
              path: diff.path,
              oldText: diff.oldText ?? diff.old_text ?? "",
              newText: diff.newText ?? diff.new_text ?? "",
            });
          }
        }
      }
      emit("acp://tool-result", {
        sessionId,
        toolCallId: update.toolCallId,
        status: update.status,
      });
      break;
    }

    case "plan":
      emit("acp://plan-update", {
        sessionId,
        entries: (update as any).entries ?? [],
      });
      break;

    default:
      // Other notification types handled as needed
      break;
  }
}

// ── Agent Discovery ──────────────────────────────────────────────────

/** Map agent types to their sidecar binary names (matches seren-desktop naming) */
const AGENT_BINARIES: Record<string, string> = {
  "claude-code": "seren-acp-claude",
  codex: "seren-acp-codex",
};

function findAgentCommand(agentType: string): string {
  const binBase = AGENT_BINARIES[agentType];
  if (!binBase) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }
  return findAgentBinary(binBase);
}

/**
 * Locate an ACP agent sidecar binary by name.
 * Checks several candidate locations in priority order, also falling back
 * to the legacy `acp_agent` name for Claude for backwards compatibility.
 */
function findAgentBinary(binBase: string): string {
  const ext = platform() === "win32" ? ".exe" : "";
  const binName = `${binBase}${ext}`;
  const home = process.env.HOME ?? "~";

  const candidates = [
    // 1. runtime/bin/ (bundled with seren-local — dist/ is one level below bin/)
    resolve(import.meta.dirname, "../bin", binName),
    // 2. ~/.seren-local/bin/ (user install location)
    resolve(home, ".seren-local/bin", binName),
    // 3. Seren Desktop embedded-runtime (development)
    resolve(home, "Projects/Seren_Projects/seren-desktop/src-tauri/embedded-runtime/bin", binName),
  ];

  // For claude agent, also check legacy acp_agent binary name
  if (binBase === "seren-acp-claude") {
    const legacyName = `acp_agent${ext}`;
    candidates.push(
      resolve(import.meta.dirname, "../bin", legacyName),
      resolve(home, ".seren-local/bin", legacyName),
      resolve(home, "Projects/Seren_Projects/seren-desktop/src-tauri/embedded-runtime/bin", legacyName),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      console.log(`[ACP] Found ${binBase} binary at: ${candidate}`);
      return candidate;
    }
  }

  throw new Error(
    `Agent binary '${binBase}' not found. Checked locations:\n${candidates.map((p) => `  - ${p}`).join("\n")}`,
  );
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const which = platform() === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(which, [command], (err) => resolve(!err));
  });
}

// ── RPC Handlers ─────────────────────────────────────────────────────

export async function acpSpawn(params: any): Promise<any> {
  const { agentType, cwd, sandboxMode, thinking } = params;
  const sessionId = randomUUID();
  const command = findAgentCommand(agentType);
  const resolvedCwd = resolve(cwd);

  // Spawn agent process (no flags needed — acp_agent speaks ACP natively over stdio)
  const args: string[] = [];
  if (sandboxMode) {
    args.push("--sandbox", sandboxMode);
  }

  const agentProcess = spawn(command, args, {
    cwd: resolvedCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!agentProcess.stdin || !agentProcess.stdout) {
    throw new Error("Failed to create agent process stdio");
  }

  // Log stderr
  if (agentProcess.stderr) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: agentProcess.stderr });
    rl.on("line", (line: string) => {
      console.log(`[ACP Agent stderr] ${line}`);
    });
  }

  // Set up ACP connection over stdio
  const input = Writable.toWeb(agentProcess.stdin!) as WritableStream;
  const output = Readable.toWeb(
    agentProcess.stdout!,
  ) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const client = createClient(sessionId);
  const connection = new acp.ClientSideConnection(
    (_agent: any) => client,
    stream,
  );

  const session: AcpSession = {
    id: sessionId,
    agentType,
    cwd: resolvedCwd,
    status: "initializing",
    createdAt: new Date().toISOString(),
    connection,
    process: agentProcess,
    pendingPermissions: new Map(),
    pendingDiffProposals: new Map(),
    cancelling: false,
  };

  sessions.set(sessionId, session);

  // Handle process exit
  agentProcess.on("exit", (code, signal) => {
    session.status = "terminated";
    emit("acp://session-status", {
      sessionId,
      status: "terminated",
    });
    console.log(
      `[ACP] Agent ${sessionId} exited: code=${code}, signal=${signal}`,
    );
  });

  // Initialize the ACP connection
  try {
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    });

    session.status = "ready";
    emit("acp://session-status", {
      sessionId,
      status: "ready",
      agentInfo: (initResult as any).agentInfo,
    });

    // Create a session within the connection
    const meta: Record<string, unknown> | undefined = thinking
      ? { claudeCode: { options: { maxThinkingTokens: thinking.maxTokens ?? 16000 } } }
      : undefined;

    const sessionResult = await connection.newSession({
      cwd: resolvedCwd,
      mcpServers: [],
      ...(meta ? { _meta: meta } : {}),
    });

    // Store the ACP session ID for prompt routing
    (session as any).acpSessionId =
      sessionResult.sessionId ?? sessionId;
  } catch (err) {
    session.status = "error";
    const rawMessage = err instanceof Error ? err.message : JSON.stringify(err);
    const errorMsg = isAuthError(rawMessage)
      ? authErrorMessage(agentType)
      : `Failed to initialize agent: ${rawMessage}`;
    emit("acp://error", {
      sessionId,
      error: errorMsg,
    });
    throw new Error(errorMsg);
  }

  return {
    id: sessionId,
    agentType,
    cwd: resolvedCwd,
    status: session.status,
    createdAt: session.createdAt,
  };
}

export async function acpPrompt(params: any): Promise<void> {
  const { sessionId, prompt, context } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.status = "prompting";
  emit("acp://session-status", { sessionId, status: "prompting" });

  const acpSessionId = (session as any).acpSessionId ?? sessionId;

  const promptContent: acp.ContentBlock[] = [
    { type: "text", text: prompt },
  ];

  // Add context items if provided
  if (context) {
    for (const item of context) {
      if (item.text) {
        promptContent.push({ type: "text", text: item.text });
      }
    }
  }

  try {
    const result = await session.connection.prompt({
      sessionId: acpSessionId,
      prompt: promptContent,
    });

    emit("acp://prompt-complete", {
      sessionId,
      stopReason: result.stopReason ?? "end_turn",
    });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : JSON.stringify(err);
    const errorMsg = isAuthError(rawMessage)
      ? authErrorMessage(session.agentType)
      : `Prompt failed: ${rawMessage}`;
    emit("acp://error", {
      sessionId,
      error: errorMsg,
    });
    throw new Error(errorMsg);
  } finally {
    session.cancelling = false;
    if (session.status === "prompting") {
      session.status = "ready";
    }
  }
}

export async function acpCancel(params: any): Promise<void> {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Debounce: ignore duplicate cancel requests while one is in-flight
  if (session.cancelling) {
    console.log(`[ACP] Cancel already in progress for ${sessionId}, ignoring duplicate`);
    return;
  }

  session.cancelling = true;
  try {
    const acpSessionId = (session as any).acpSessionId ?? sessionId;
    await session.connection.cancel({ sessionId: acpSessionId });
  } finally {
    session.cancelling = false;
  }
}

export async function acpTerminate(params: any): Promise<void> {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.process.kill();
  sessions.delete(sessionId);
  session.status = "terminated";

  emit("acp://session-status", { sessionId, status: "terminated" });
}

export async function acpListSessions(): Promise<any[]> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    agentType: s.agentType,
    cwd: s.cwd,
    status: s.status,
    createdAt: s.createdAt,
  }));
}

export async function acpSetPermissionMode(params: any): Promise<void> {
  const { sessionId, mode } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const acpSessionId = (session as any).acpSessionId ?? sessionId;
  await session.connection.setSessionMode({
    sessionId: acpSessionId,
    modeId: mode as acp.SessionModeId,
  });
}

export async function acpRespondToPermission(params: any): Promise<void> {
  const { sessionId, requestId, optionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const resolver = session.pendingPermissions.get(requestId);
  if (!resolver) throw new Error(`No pending permission: ${requestId}`);

  session.pendingPermissions.delete(requestId);
  resolver(optionId);
}

export async function acpRespondToDiffProposal(params: any): Promise<void> {
  const { sessionId, proposalId, accepted } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const resolver = session.pendingDiffProposals.get(proposalId);
  if (!resolver) throw new Error(`No pending diff proposal: ${proposalId}`);

  session.pendingDiffProposals.delete(proposalId);
  resolver(accepted);
}

export async function acpGetAvailableAgents(): Promise<any[]> {
  const agents = [
    { type: "claude-code", name: "Claude Code", description: "AI coding assistant by Anthropic", command: "seren-acp-claude" },
    { type: "codex", name: "Codex", description: "AI coding assistant powered by OpenAI Codex", command: "seren-acp-codex" },
  ];

  return agents.map((agent) => {
    let available = false;
    let unavailableReason: string | undefined;
    try {
      findAgentCommand(agent.type);
      available = true;
    } catch (err: any) {
      unavailableReason = err.message;
    }
    return { ...agent, available, unavailableReason };
  });
}

export async function acpCheckAgentAvailable(params: any): Promise<boolean> {
  try {
    findAgentCommand(params.agentType);
    return true;
  } catch {
    return false;
  }
}

export async function acpEnsureClaudeCli(): Promise<string> {
  // Check if claude is already available
  if (await isCommandAvailable("claude")) {
    return "claude";
  }

  // Try to install via npm
  const npmCmd = platform() === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const proc = execFile(
      npmCmd,
      ["install", "-g", "@anthropic-ai/claude-code"],
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `Failed to install Claude Code CLI: ${stderr || err.message}`,
            ),
          );
          return;
        }
        console.log(`[ACP] Claude Code CLI installed: ${stdout}`);
        resolve("claude");
      },
    );
  });
}
