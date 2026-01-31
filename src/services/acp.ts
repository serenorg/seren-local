// ABOUTME: ACP (Agent Client Protocol) service for spawning and communicating with AI coding agents.
// ABOUTME: Wraps runtime commands and provides event subscriptions for agent interactions.

import { isRuntimeConnected, onRuntimeEvent, runtimeInvoke } from "@/lib/bridge";

type UnlistenFn = () => void;

// ============================================================================
// Types
// ============================================================================

export type AgentType = "claude-code" | "codex";

export type SessionStatus =
  | "initializing"
  | "ready"
  | "prompting"
  | "error"
  | "terminated";

export interface AcpSessionInfo {
  id: string;
  agentType: AgentType;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
}

export interface AgentInfo {
  type: AgentType;
  name: string;
  description: string;
  command: string;
  available: boolean;
  unavailableReason?: string;
}

// Event payloads
export interface MessageChunkEvent {
  sessionId: string;
  text: string;
  isThought?: boolean;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
}

export interface ToolResultEvent {
  sessionId: string;
  toolCallId: string;
  status: string;
}

export interface DiffEvent {
  sessionId: string;
  toolCallId: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface PlanEntry {
  content: string;
  status: string;
}

export interface PlanUpdateEvent {
  sessionId: string;
  entries: PlanEntry[];
}

export interface PromptCompleteEvent {
  sessionId: string;
  stopReason: string;
}

export interface PermissionOption {
  optionId: string;
  label?: string;
  description?: string;
}

export interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  toolCall: unknown;
  options: PermissionOption[];
}

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  agentInfo?: {
    name: string;
    version: string;
  };
}

export interface DiffProposalEvent {
  sessionId: string;
  proposalId: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface ErrorEvent {
  sessionId: string;
  error: string;
}

// Union type for all ACP events
export type AcpEvent =
  | { type: "messageChunk"; data: MessageChunkEvent }
  | { type: "toolCall"; data: ToolCallEvent }
  | { type: "toolResult"; data: ToolResultEvent }
  | { type: "diff"; data: DiffEvent }
  | { type: "planUpdate"; data: PlanUpdateEvent }
  | { type: "promptComplete"; data: PromptCompleteEvent }
  | { type: "permissionRequest"; data: PermissionRequestEvent }
  | { type: "diffProposal"; data: DiffProposalEvent }
  | { type: "sessionStatus"; data: SessionStatusEvent }
  | { type: "error"; data: ErrorEvent };

// ============================================================================
// Runtime Command Wrappers
// ============================================================================

function requireRuntime(): void {
  if (!isRuntimeConnected()) {
    throw new Error("This operation requires the local runtime to be running");
  }
}

/**
 * Spawn a new ACP agent session.
 */
export async function spawnAgent(
  agentType: AgentType,
  cwd: string,
  sandboxMode?: string,
): Promise<AcpSessionInfo> {
  requireRuntime();
  return runtimeInvoke<AcpSessionInfo>("acp_spawn", {
    agentType,
    cwd,
    sandboxMode: sandboxMode ?? null,
  });
}

/**
 * Send a prompt to an ACP agent session.
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  context?: Array<{ text?: string }>,
): Promise<void> {
  requireRuntime();
  return runtimeInvoke("acp_prompt", { sessionId, prompt, context });
}

/**
 * Cancel an ongoing prompt in an ACP session.
 */
export async function cancelPrompt(sessionId: string): Promise<void> {
  requireRuntime();
  return runtimeInvoke("acp_cancel", { sessionId });
}

/**
 * Terminate an ACP session.
 */
export async function terminateSession(sessionId: string): Promise<void> {
  requireRuntime();
  return runtimeInvoke("acp_terminate", { sessionId });
}

/**
 * List all active ACP sessions.
 */
export async function listSessions(): Promise<AcpSessionInfo[]> {
  requireRuntime();
  return runtimeInvoke<AcpSessionInfo[]>("acp_list_sessions");
}

/**
 * Set the permission mode for an ACP session.
 */
export async function setPermissionMode(
  sessionId: string,
  mode: string,
): Promise<void> {
  requireRuntime();
  return runtimeInvoke("acp_set_permission_mode", { sessionId, mode });
}

/**
 * Respond to a permission request from the agent.
 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  requireRuntime();
  return runtimeInvoke("acp_respond_to_permission", {
    sessionId,
    requestId,
    optionId,
  });
}

/**
 * Respond to a diff proposal (accept or reject a file edit).
 */
export async function respondToDiffProposal(
  sessionId: string,
  proposalId: string,
  accepted: boolean,
): Promise<void> {
  requireRuntime();
  return runtimeInvoke("acp_respond_to_diff_proposal", {
    sessionId,
    proposalId,
    accepted,
  });
}

/**
 * Get list of available agents and their status.
 */
export async function getAvailableAgents(): Promise<AgentInfo[]> {
  requireRuntime();
  return runtimeInvoke<AgentInfo[]>("acp_get_available_agents");
}

/**
 * Ensure Claude Code CLI is installed, auto-installing via npm if needed.
 * Returns the bin directory path containing the claude binary.
 */
export async function ensureClaudeCli(): Promise<string> {
  requireRuntime();
  return runtimeInvoke<string>("acp_ensure_claude_cli");
}

/**
 * Check if a specific agent binary is available in PATH.
 */
export async function checkAgentAvailable(
  agentType: AgentType,
): Promise<boolean> {
  requireRuntime();
  return runtimeInvoke<boolean>("acp_check_agent_available", {
    agentType,
  });
}

// ============================================================================
// Event Subscription
// ============================================================================

const EVENT_CHANNELS = {
  messageChunk: "acp://message-chunk",
  toolCall: "acp://tool-call",
  toolResult: "acp://tool-result",
  diff: "acp://diff",
  planUpdate: "acp://plan-update",
  promptComplete: "acp://prompt-complete",
  permissionRequest: "acp://permission-request",
  diffProposal: "acp://diff-proposal",
  sessionStatus: "acp://session-status",
  error: "acp://error",
} as const;

type EventType = keyof typeof EVENT_CHANNELS;

/**
 * Subscribe to a specific ACP event type.
 * Returns an unlisten function to clean up the subscription.
 */
export function subscribeToEvent<T extends { sessionId: string }>(
  eventType: EventType,
  callback: (data: T) => void,
): UnlistenFn {
  const channel = EVENT_CHANNELS[eventType];
  console.log(`[AcpService] Subscribing to ${channel}`);
  return onRuntimeEvent(channel, (payload) => {
    console.log(`[AcpService] Received event on ${channel}:`, payload);
    callback(payload as T);
  });
}

/**
 * Subscribe to all ACP events for a session.
 * Returns an unlisten function to clean up all subscriptions.
 */
export function subscribeToSession(
  sessionId: string,
  callback: (event: AcpEvent) => void,
): UnlistenFn {
  console.log(
    `[AcpService] subscribeToSession called for sessionId: ${sessionId}`,
  );
  const unlisteners: UnlistenFn[] = [];

  // Helper to filter events by sessionId and create properly typed events
  function createHandler<E extends AcpEvent>(
    type: E["type"],
  ): (data: E["data"]) => void {
    return (data) => {
      console.log(
        `[AcpService] createHandler received ${type}: sessionId=${data.sessionId}, expected=${sessionId}, match=${data.sessionId === sessionId}`,
      );
      if (data.sessionId === sessionId) {
        callback({ type, data } as E);
      }
    };
  }

  unlisteners.push(
    subscribeToEvent<MessageChunkEvent>(
      "messageChunk",
      createHandler<{ type: "messageChunk"; data: MessageChunkEvent }>(
        "messageChunk",
      ),
    ),
  );
  unlisteners.push(
    subscribeToEvent<ToolCallEvent>(
      "toolCall",
      createHandler<{ type: "toolCall"; data: ToolCallEvent }>("toolCall"),
    ),
  );
  unlisteners.push(
    subscribeToEvent<ToolResultEvent>(
      "toolResult",
      createHandler<{ type: "toolResult"; data: ToolResultEvent }>(
        "toolResult",
      ),
    ),
  );
  unlisteners.push(
    subscribeToEvent<DiffEvent>(
      "diff",
      createHandler<{ type: "diff"; data: DiffEvent }>("diff"),
    ),
  );
  unlisteners.push(
    subscribeToEvent<PlanUpdateEvent>(
      "planUpdate",
      createHandler<{ type: "planUpdate"; data: PlanUpdateEvent }>(
        "planUpdate",
      ),
    ),
  );
  unlisteners.push(
    subscribeToEvent<PromptCompleteEvent>(
      "promptComplete",
      createHandler<{ type: "promptComplete"; data: PromptCompleteEvent }>(
        "promptComplete",
      ),
    ),
  );
  unlisteners.push(
    subscribeToEvent<PermissionRequestEvent>(
      "permissionRequest",
      createHandler<{
        type: "permissionRequest";
        data: PermissionRequestEvent;
      }>("permissionRequest"),
    ),
  );
  unlisteners.push(
    subscribeToEvent<SessionStatusEvent>(
      "sessionStatus",
      createHandler<{ type: "sessionStatus"; data: SessionStatusEvent }>(
        "sessionStatus",
      ),
    ),
  );
  unlisteners.push(
    subscribeToEvent<ErrorEvent>(
      "error",
      createHandler<{ type: "error"; data: ErrorEvent }>("error"),
    ),
  );

  // Return a function that unsubscribes from all events
  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

/**
 * Subscribe to all ACP events (not filtered by session).
 * Returns an unlisten function to clean up all subscriptions.
 */
export function subscribeToAllEvents(
  callback: (event: AcpEvent) => void,
): UnlistenFn {
  const unlisteners: UnlistenFn[] = [];

  unlisteners.push(
    subscribeToEvent<MessageChunkEvent>("messageChunk", (data) =>
      callback({ type: "messageChunk", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<ToolCallEvent>("toolCall", (data) =>
      callback({ type: "toolCall", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<ToolResultEvent>("toolResult", (data) =>
      callback({ type: "toolResult", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<DiffEvent>("diff", (data) =>
      callback({ type: "diff", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<PlanUpdateEvent>("planUpdate", (data) =>
      callback({ type: "planUpdate", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<PromptCompleteEvent>("promptComplete", (data) =>
      callback({ type: "promptComplete", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<PermissionRequestEvent>(
      "permissionRequest",
      (data) => callback({ type: "permissionRequest", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<DiffProposalEvent>("diffProposal", (data) =>
      callback({ type: "diffProposal", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<SessionStatusEvent>("sessionStatus", (data) =>
      callback({ type: "sessionStatus", data }),
    ),
  );
  unlisteners.push(
    subscribeToEvent<ErrorEvent>("error", (data) =>
      callback({ type: "error", data }),
    ),
  );

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
