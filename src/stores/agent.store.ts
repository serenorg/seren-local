// ABOUTME: Reactive provider-runtime state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import { createStore, produce } from "solid-js/store";
import {
  isRuntimeConnected,
  onRuntimeEvent,
  runtimeInvoke,
} from "@/lib/bridge";
import {
  clearConversationHistory,
  createAgentConversation,
  type AgentConversation as DbAgentConversation,
  getAgentConversation,
  getAgentConversations,
  getSerenApiKey,
  setAgentConversationMetadata as setAgentConversationMetadataDb,
  setAgentConversationModelId as setAgentConversationModelIdDb,
  setAgentConversationSessionId as setAgentConversationSessionIdDb,
  setAgentConversationTitle as setAgentConversationTitleDb,
} from "@/lib/bridge";
import { isLikelyAuthError } from "@/lib/auth-errors";
import { generateId } from "@/lib/uuid";
import { refreshAccessToken } from "@/services/auth";
import {
  isPromptTooLongError,
  isRateLimitError,
  isTimeoutError,
  performAgentFallback,
} from "@/lib/rate-limit-fallback";
import { sendMessage } from "@/services/chat";
import type {
  AgentEvent,
  AgentInfo,
  AgentSessionInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  PermissionRequestEvent,
  PlanEntry,
  RemoteSessionInfo,
  SessionConfigOption,
  SessionStatus,
  SessionStatusEvent,
  ToolCallEvent,
} from "@/services/providers";
import * as providerService from "@/services/providers";
import { getEnabledMcpServers, settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";

/** Per-session ready promises -- resolved when backend emits "ready" status */
const sessionReadyPromises = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();

/** Max time to wait for a session to become ready before giving up */
const SESSION_READY_TIMEOUT_MS = 30_000;

/** Await a session ready promise with a timeout to prevent infinite hangs */
function waitForSessionReady(sessionId: string): Promise<void> {
  const entry = sessionReadyPromises.get(sessionId);
  if (!entry) return Promise.resolve();
  return Promise.race([
    entry.promise,
    new Promise<void>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Session ${sessionId} did not become ready within ${SESSION_READY_TIMEOUT_MS}ms`,
            ),
          ),
        SESSION_READY_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Wait for a session to return to 'ready' (not 'prompting') with a timeout. */
async function waitForSessionIdle(
  sessionId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (state.sessions[sessionId]?.info.status === "prompting") {
    if (Date.now() >= deadline) {
      console.warn(
        `[AgentStore] waitForSessionIdle: timed out after ${timeoutMs}ms for session ${sessionId}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ============================================================================
// Types
// ============================================================================

export interface AgentCompactedSummary {
  content: string;
  originalMessageCount: number;
  compactedAt: number;
}

interface AgentConversationMetadata {
  pendingBootstrapPromptContext?: string;
  pendingBootstrapMessages?: AgentMessage[];
}

export interface AgentMessage {
  id: string;
  type: "user" | "assistant" | "thought" | "tool" | "diff" | "error";
  content: string;
  timestamp: number;
  toolCallId?: string;
  diff?: DiffEvent;
  toolCall?: ToolCallEvent;
  /** Duration in milliseconds for how long the response took */
  duration?: number;
  /** Total cost in SerenBucks for this message's query, reported by Gateway. */
  cost?: number;
  /** Names of documents processed via DocReader for this message. */
  docNames?: string[];
}

export interface AgentModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface AgentModeInfo {
  modeId: string;
  name: string;
  description?: string;
}

export interface ActiveSession {
  info: AgentSessionInfo;
  messages: AgentMessage[];
  plan: PlanEntry[];
  pendingToolCalls: Map<string, ToolCallEvent>;
  streamingContent: string;
  streamingThinking: string;
  streamingContentTimestamp?: number;
  streamingThinkingTimestamp?: number;
  pendingUserMessage: string;
  pendingUserMessageId?: string;
  pendingUserMessageTimestamp?: number;
  cwd: string;
  conversationId: string;
  agentSessionId?: string;
  configOptions?: SessionConfigOption[];
  promptStartTime?: number;
  currentModelId?: string;
  availableModels?: AgentModelInfo[];
  currentModeId?: string;
  availableModes?: AgentModeInfo[];
  error?: string | null;
  title?: string;
  rateLimitHit?: boolean;
  promptTooLong?: boolean;
  promptTooLongHandled?: boolean;
  skipHistoryReplay?: boolean;
  restoredMessageCount?: number;
  lastInputTokens?: number;
  contextWindowSize: number;
  isCompacting?: boolean;
  compactedSummary?: AgentCompactedSummary;
  lastUserPrompt?: string;
  compactRetryAttempted?: boolean;
  compactRetryPromise?: Promise<boolean>;
  bootstrapPromptContext?: string;
  cancelRequested?: boolean;
  pendingConfigRestore?: Record<string, string>;
  isSkippingSkillContext?: boolean;
}

// ============================================================================
// Agent message persistence helpers
// ============================================================================

const FORK_BOOTSTRAP_MAX_MSG_CHARS = 2_000;

function agentDisplayName(agentType?: string): string {
  switch (agentType) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    default:
      return agentType ?? "Agent";
  }
}

function truncateBootstrapText(content: string): string {
  return content.length > FORK_BOOTSTRAP_MAX_MSG_CHARS
    ? `${content.slice(0, FORK_BOOTSTRAP_MAX_MSG_CHARS)}... [truncated]`
    : content;
}

function formatForkBootstrapMessage(message: AgentMessage): string | null {
  const content = message.content.trim();

  switch (message.type) {
    case "user":
      return content ? `USER: ${truncateBootstrapText(content)}` : null;
    case "assistant":
      return content ? `ASSISTANT: ${truncateBootstrapText(content)}` : null;
    case "error":
      return content ? `SYSTEM: ${truncateBootstrapText(content)}` : null;
    case "tool": {
      const label = message.toolCall?.status
        ? `TOOL (${message.toolCall.status})`
        : "TOOL";
      return content ? `${label}: ${truncateBootstrapText(content)}` : null;
    }
    case "diff": {
      const path = message.diff?.path;
      const summary = path ? `Modified ${path}` : content;
      return summary ? `DIFF: ${truncateBootstrapText(summary)}` : null;
    }
    case "thought":
      return null;
  }
}

function buildForkBootstrapContext(
  session: ActiveSession,
  messages: AgentMessage[],
): string | null {
  const summary = session.compactedSummary?.content.trim();
  const transcript = messages
    .map(formatForkBootstrapMessage)
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  if (!summary && !transcript) {
    return null;
  }

  const sections = [
    "This prompt continues a forked branch of an earlier coding-agent conversation.",
    "Treat the summary and transcript below as the authoritative history for this branch.",
    "Anything that happened after the branch point is not part of this branch.",
  ];

  if (summary) {
    sections.push(`Earlier summary:\n${summary}`);
  }

  if (transcript) {
    sections.push(`Branch transcript:\n${transcript}`);
  }

  sections.push(
    "Continue from the branch transcript's final message. Do not mention this bootstrap unless it helps answer the user.",
  );

  return sections.join("\n\n");
}

function parseAgentConversationMetadata(
  raw: string | null | undefined,
): AgentConversationMetadata {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as AgentConversationMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function serializeAgentConversationMetadata(
  metadata: AgentConversationMetadata,
): string | null {
  return metadata.pendingBootstrapPromptContext ||
    (metadata.pendingBootstrapMessages &&
      metadata.pendingBootstrapMessages.length > 0)
    ? JSON.stringify(metadata)
    : null;
}

/**
 * Provider-owned agent transcripts are not stored in Seren SQLite.
 * We keep only in-memory session messages plus narrow bootstrap metadata for
 * exact local forks that have not materialized provider history yet.
 */
function persistAgentMessage(
  _conversationId: string,
  _msg: AgentMessage,
): void {
  // Intentionally no-op.
}

function clearLegacyAgentTranscript(conversationId: string): void {
  clearConversationHistory(conversationId).catch((error) =>
    console.warn(
      "[AgentStore] Failed to clear legacy provider transcript:",
      error,
    ),
  );
}

// ============================================================================
// State
// ============================================================================

interface AgentState {
  availableAgents: AgentInfo[];
  sessions: Record<string, ActiveSession>;
  activeSessionId: string | null;
  selectedAgentType: AgentType;
  recentAgentConversations: DbAgentConversation[];
  remoteSessions: RemoteSessionInfo[];
  remoteSessionsNextCursor: string | null;
  remoteSessionsLoading: boolean;
  remoteSessionsError: string | null;
  isLoading: boolean;
  error: string | null;
  installStatus: string | null;
  pendingPermissions: PermissionRequestEvent[];
  pendingDiffProposals: DiffProposalEvent[];
  agentModeEnabled: boolean;
}

const [state, setState] = createStore<AgentState>({
  availableAgents: [],
  sessions: {},
  activeSessionId: null,
  selectedAgentType: "claude-code",
  recentAgentConversations: [],
  remoteSessions: [],
  remoteSessionsNextCursor: null,
  remoteSessionsLoading: false,
  remoteSessionsError: null,
  isLoading: false,
  error: null,
  installStatus: null,
  pendingPermissions: [],
  pendingDiffProposals: [],
  agentModeEnabled: false,
});

let globalUnsubscribe: (() => void) | null = null;
const pendingSessionEvents = new Map<string, AgentEvent[]>();

/** Guard against concurrent auto-recovery spawns in sendPrompt (per-session). */
const recoveryInFlightMap = new Map<string, Promise<string | null>>();
const LEGACY_CLAUDE_LOCAL_SESSION_ID_RE = /^session-\d+$/;

// Chunk accumulation buffers -- plain JS, not reactive.
const CHUNK_FLUSH_MS = 50;
const chunkBufs = new Map<string, { content: string; thinking: string }>();
const chunkFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  const buf = chunkBufs.get(sessionId);
  if (!buf) return;
  if (buf.content) {
    setState("sessions", sessionId, "streamingContent", (c) => c + buf.content);
    buf.content = "";
  }
  if (buf.thinking) {
    setState(
      "sessions",
      sessionId,
      "streamingThinking",
      (c) => c + buf.thinking,
    );
    buf.thinking = "";
  }
}

function clearChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  chunkBufs.delete(sessionId);
}

function disposeAgentStoreRuntimeBindings(): void {
  if (globalUnsubscribe) {
    globalUnsubscribe();
    globalUnsubscribe = null;
  }
  pendingSessionEvents.clear();
  sessionReadyPromises.clear();
  recoveryInFlightMap.clear();
  for (const timer of chunkFlushTimers.values()) {
    clearTimeout(timer);
  }
  chunkFlushTimers.clear();
  chunkBufs.clear();
}

const agentStoreHot =
  (
    import.meta as ImportMeta & {
      hot?: { dispose: (callback: () => void) => void };
    }
  ).hot ?? null;

if (agentStoreHot) {
  const globalScope = globalThis as typeof globalThis & {
    __serenAgentStoreHmrDispose__?: (() => void) | undefined;
  };

  globalScope.__serenAgentStoreHmrDispose__?.();

  const dispose = () => {
    disposeAgentStoreRuntimeBindings();
    if (globalScope.__serenAgentStoreHmrDispose__ === dispose) {
      delete globalScope.__serenAgentStoreHmrDispose__;
    }
  };

  globalScope.__serenAgentStoreHmrDispose__ = dispose;
  agentStoreHot.dispose(dispose);
}

const PENDING_SESSION_EVENT_LIMIT = 500;
const CLAUDE_INIT_RETRY_DELAY_MS = 350;
const MAX_CLAUDE_INIT_RETRIES = 3;

/** Spawn cascade guard: track recent failures per conversation to prevent infinite loops. */
const SPAWN_CASCADE_WINDOW_MS = 30_000;
const SPAWN_CASCADE_MAX_FAILURES = 3;
const spawnFailureTimestamps = new Map<string, number[]>();

function recordSpawnFailure(conversationId: string): void {
  const now = Date.now();
  const timestamps = spawnFailureTimestamps.get(conversationId) ?? [];
  timestamps.push(now);
  const cutoff = now - SPAWN_CASCADE_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  spawnFailureTimestamps.set(conversationId, recent);
}

function isSpawnCascading(conversationId: string): boolean {
  const now = Date.now();
  const timestamps = spawnFailureTimestamps.get(conversationId) ?? [];
  const cutoff = now - SPAWN_CASCADE_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  return recent.length >= SPAWN_CASCADE_MAX_FAILURES;
}

function clearSpawnFailures(conversationId: string): void {
  spawnFailureTimestamps.delete(conversationId);
}

function isRetryableClaudeInitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("server shut down unexpectedly") ||
    lower.includes("signal: 9") ||
    lower.includes("sigkill") ||
    lower.includes("timed out waiting for claude control request initialize")
  );
}

function getIdleClaudeSessionIds(excludeConversationId?: string): string[] {
  return Object.entries(state.sessions)
    .filter(([, session]) => {
      if (session.info.agentType !== "claude-code") return false;
      if (
        excludeConversationId &&
        session.conversationId === excludeConversationId
      ) {
        return false;
      }
      return (
        session.info.status === "ready" ||
        session.info.status === "error" ||
        session.info.status === "terminated"
      );
    })
    .sort(([, a], [, b]) => a.info.createdAt.localeCompare(b.info.createdAt))
    .map(([id]) => id);
}

/**
 * Check whether the local runtime supports agent operations.
 */
function runtimeHasAgentCapability(): boolean {
  return isRuntimeConnected();
}

// ============================================================================
// Store
// ============================================================================

export const agentStore = {
  // ============================================================================
  // Getters
  // ============================================================================

  get availableAgents() {
    return state.availableAgents;
  },

  get sessions() {
    return state.sessions;
  },

  get activeSessionId() {
    return state.activeSessionId;
  },

  get activeSession(): ActiveSession | null {
    if (!state.activeSessionId) return null;
    return state.sessions[state.activeSessionId] ?? null;
  },

  get selectedAgentType() {
    return state.selectedAgentType;
  },

  get recentAgentConversations() {
    return state.recentAgentConversations;
  },

  get remoteSessions() {
    return state.remoteSessions;
  },

  get remoteSessionsNextCursor() {
    return state.remoteSessionsNextCursor;
  },

  get remoteSessionsLoading() {
    return state.remoteSessionsLoading;
  },

  get remoteSessionsError() {
    return state.remoteSessionsError;
  },

  get isLoading() {
    return state.isLoading;
  },

  get error() {
    const session = this.activeSession;
    return session?.error ?? state.error;
  },

  get installStatus() {
    return state.installStatus;
  },

  get pendingPermissions() {
    return state.pendingPermissions;
  },

  get pendingDiffProposals() {
    return state.pendingDiffProposals;
  },

  get agentModeEnabled() {
    return state.agentModeEnabled;
  },

  get supportsAgents() {
    return runtimeHasAgentCapability();
  },

  get messages(): AgentMessage[] {
    const session = this.activeSession;
    return session?.messages ?? [];
  },

  getMessagesForConversation(conversationId: string): AgentMessage[] {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.messages ?? [];
  },

  getStreamingContentForConversation(conversationId: string): string {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.streamingContent ?? "";
  },

  getStreamingThinkingForConversation(conversationId: string): string {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.streamingThinking ?? "";
  },

  getSessionForConversation(conversationId: string): ActiveSession | null {
    return (
      Object.values(state.sessions).find(
        (s) => s.conversationId === conversationId,
      ) ?? null
    );
  },

  hasPendingApprovals(conversationId: string): boolean {
    const session = this.getSessionForConversation(conversationId);
    if (!session) return false;
    const sid = session.info.id;
    return (
      state.pendingPermissions.some((p) => p.sessionId === sid) ||
      state.pendingDiffProposals.some((p) => p.sessionId === sid)
    );
  },

  get plan(): PlanEntry[] {
    const session = this.activeSession;
    return session?.plan ?? [];
  },

  get streamingContent(): string {
    const session = this.activeSession;
    return session?.streamingContent ?? "";
  },

  get streamingThinking(): string {
    const session = this.activeSession;
    return session?.streamingThinking ?? "";
  },

  get cwd(): string | null {
    const session = this.activeSession;
    return session?.cwd ?? null;
  },

  // ============================================================================
  // Initialization
  // ============================================================================

  async initialize() {
    if (!runtimeHasAgentCapability()) {
      setState("availableAgents", []);
      setState("agentModeEnabled", false);
      setState("remoteSessions", []);
      setState("remoteSessionsNextCursor", null);
      setState("remoteSessionsError", null);
      return;
    }

    try {
      const agents = await providerService.getAvailableAgents();
      setState("availableAgents", agents);
      const currentAgent = agents.find(
        (agent) => agent.type === state.selectedAgentType,
      );
      if (!currentAgent?.available) {
        const fallbackAgent = agents.find((agent) => agent.available);
        if (fallbackAgent) {
          setState("selectedAgentType", fallbackAgent.type);
        }
      }
    } catch (error) {
      console.error("Failed to load available agents:", error);
    }
  },

  async refreshRecentAgentConversations(limit = 10, cwd?: string) {
    try {
      const rows = await getAgentConversations(limit, cwd);
      setState("recentAgentConversations", rows);
    } catch (error) {
      console.error("Failed to load agent conversation history:", error);
    }
  },

  async refreshRemoteSessions(cwd: string, agentType?: AgentType) {
    if (state.remoteSessionsLoading) {
      return;
    }
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    setState("remoteSessionsLoading", true);
    setState("remoteSessionsError", null);
    try {
      const [page, localRows] = await Promise.all([
        providerService.listRemoteSessions(resolvedAgentType, cwd),
        getAgentConversations(200),
      ]);

      setState("recentAgentConversations", localRows);

      const titleOverrides = new Map(
        localRows
          .filter(
            (c) =>
              c.agent_type === resolvedAgentType &&
              c.agent_session_id &&
              c.title.trim().length > 0,
          )
          .map((c) => [c.agent_session_id as string, c.title]),
      );

      const mergedSessions = page.sessions.map((s) => ({
        ...s,
        title: titleOverrides.get(s.sessionId) ?? s.title,
      }));

      setState("remoteSessions", mergedSessions);
      setState("remoteSessionsNextCursor", page.nextCursor ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Failed to list remote sessions:", msg);
      setState("remoteSessionsError", msg);
    } finally {
      setState("remoteSessionsLoading", false);
    }
  },

  async loadMoreRemoteSessions(cwd: string, agentType?: AgentType) {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const cursor = state.remoteSessionsNextCursor;
    if (!cursor) return;
    setState("remoteSessionsLoading", true);
    setState("remoteSessionsError", null);
    try {
      const page = await providerService.listRemoteSessions(
        resolvedAgentType,
        cwd,
        cursor,
      );
      const titleOverrides = new Map(
        state.recentAgentConversations
          .filter(
            (c) =>
              c.agent_type === resolvedAgentType &&
              c.agent_session_id &&
              c.title.trim().length > 0,
          )
          .map((c) => [c.agent_session_id as string, c.title]),
      );
      const mergedSessions = page.sessions.map((s) => ({
        ...s,
        title: titleOverrides.get(s.sessionId) ?? s.title,
      }));
      setState("remoteSessions", (prev) => [...prev, ...mergedSessions]);
      setState("remoteSessionsNextCursor", page.nextCursor ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Failed to list more remote sessions:", msg);
      setState("remoteSessionsError", msg);
    } finally {
      setState("remoteSessionsLoading", false);
    }
  },

  // ============================================================================
  // Session Management
  // ============================================================================

  async spawnSession(
    cwd: string,
    agentType?: AgentType,
    opts?: {
      localSessionId?: string;
      resumeAgentSessionId?: string;
      conversationTitle?: string;
      initRetryAttempt?: number;
      reclaimedIdleClaude?: boolean;
      restoredMessages?: AgentMessage[];
      bootstrapPromptContext?: string;
    },
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const localSessionId = opts?.localSessionId;
    const resumeAgentSessionId = opts?.resumeAgentSessionId;
    const initRetryAttempt = opts?.initRetryAttempt ?? 0;
    const reclaimedIdleClaude = opts?.reclaimedIdleClaude ?? false;
    const conversationTitle =
      opts?.conversationTitle ??
      (resolvedAgentType === "codex" ? "Codex Agent" : "Claude Agent");

    setState("isLoading", true);
    setState("error", null);

    console.log("[AgentStore] Spawning session:", {
      agentType: resolvedAgentType,
      cwd,
      localSessionId,
      resumeAgentSessionId,
    });

    const agentAvailable =
      await providerService.checkAgentAvailable(resolvedAgentType);
    if (!agentAvailable) {
      const helper =
        state.availableAgents.find((agent) => agent.type === resolvedAgentType)
          ?.unavailableReason ??
        `${resolvedAgentType === "codex" ? "Codex" : "Claude Code"} is not available in this runtime.`;
      setState("error", helper);
      setState("isLoading", false);
      return null;
    }

    let resolveReady: ((sessionId: string) => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const readyPromise = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const tempUnsubscribe =
      await providerService.subscribeToEvent<SessionStatusEvent>(
        "sessionStatus",
        (data) => {
          console.log("[AgentStore] Received session status event:", data);
          if (state.sessions[data.sessionId]) {
            this.handleStatusChange(data.sessionId, data.status, data);
          }
          if (data.status === "ready" && resolveReady) {
            resolveReady(data.sessionId);
          } else if (data.status === "error" && rejectReady) {
            const sessionError =
              state.sessions[data.sessionId]?.error ??
              "Agent session failed during initialization.";
            rejectReady(new Error(sessionError));
          }
        },
      );

    if (!globalUnsubscribe) {
      globalUnsubscribe = await providerService.subscribeToAllEvents(
        (event) => {
          const eventSessionId = event.data.sessionId;
          if (!eventSessionId) return;
          if (event.type !== "messageChunk") {
            const session = state.sessions[eventSessionId];
            console.log(
              "[AgentRuntime] Event received - type:",
              event.type,
              "agent:",
              session?.info?.agentType ?? "unknown",
              "sessionId:",
              eventSessionId,
              "conversationId:",
              session?.conversationId,
            );
          }
          if (state.sessions[eventSessionId]) {
            this.handleSessionEvent(eventSessionId, event);
            return;
          }

          const pending = pendingSessionEvents.get(eventSessionId) ?? [];
          pending.push(event);
          if (pending.length > PENDING_SESSION_EVENT_LIMIT) {
            pending.shift();
          }
          pendingSessionEvents.set(eventSessionId, pending);
        },
      );
    }

    try {
      const ensureFn =
        resolvedAgentType === "claude-code"
          ? providerService.ensureClaudeCli
          : resolvedAgentType === "codex"
            ? providerService.ensureCodexCli
            : null;

      if (ensureFn) {
        if (!isRuntimeConnected()) {
          setState(
            "error",
            "Local runtime is not connected for agent installation.",
          );
          setState("isLoading", false);
          return null;
        }

        const progressUnsub = onRuntimeEvent(
          "provider://cli-install-progress",
          (payload) => {
            const event = payload as { stage?: string; message?: string };
            setState("installStatus", event.message ?? null);
          },
        );

        try {
          await ensureFn();
        } catch (error) {
          progressUnsub();
          tempUnsubscribe();
          const message =
            error instanceof Error
              ? error.message
              : `Failed to install ${resolvedAgentType === "codex" ? "Codex" : "Claude Code"} CLI`;
          setState("error", message);
          setState("isLoading", false);
          setState("installStatus", null);
          return null;
        }

        progressUnsub();
        setState("installStatus", null);
      }

      let apiKey = await getSerenApiKey();
      if (!apiKey) {
        await new Promise((r) => setTimeout(r, 3000));
        apiKey = await getSerenApiKey();
        if (apiKey) {
          console.info("[AgentStore] API key became available after waiting for auth");
        }
      }
      const enabledMcpServers = getEnabledMcpServers();

      const timeoutSecs = undefined;

      const approvalPolicy =
        resolvedAgentType === "codex"
          ? "on-failure"
          : settingsStore.settings.agentApprovalPolicy;

      const info = await providerService.spawnAgent(
        resolvedAgentType,
        cwd,
        settingsStore.settings.agentSandboxMode,
        apiKey ?? undefined,
        approvalPolicy,
        settingsStore.settings.agentSearchEnabled,
        settingsStore.settings.agentNetworkEnabled,
        localSessionId,
        resumeAgentSessionId,
        timeoutSecs,
        enabledMcpServers,
      );
      console.log("[AgentStore] Spawn result:", info);

      try {
        await createAgentConversation(
          info.id,
          conversationTitle,
          resolvedAgentType,
          cwd,
          cwd,
          resumeAgentSessionId ?? undefined,
          serializeAgentConversationMetadata({
            pendingBootstrapPromptContext: opts?.bootstrapPromptContext,
            pendingBootstrapMessages: opts?.bootstrapPromptContext
              ? opts?.restoredMessages
              : undefined,
          }) ?? undefined,
        );
      } catch (error) {
        console.warn("Failed to persist agent conversation", error);
      }

      const hasRestoredMessages =
        opts?.restoredMessages && opts.restoredMessages.length > 0;
      const session: ActiveSession = {
        info,
        messages: opts?.restoredMessages ?? [],
        plan: [],
        pendingToolCalls: new Map(),
        streamingContent: "",
        streamingThinking: "",
        pendingUserMessage: "",
        cwd,
        conversationId: info.id,
        skipHistoryReplay: hasRestoredMessages ? true : undefined,
        restoredMessageCount: hasRestoredMessages
          ? opts?.restoredMessages?.length
          : undefined,
        contextWindowSize: resolvedAgentType === "codex" ? 400_000 : 200_000,
        bootstrapPromptContext: opts?.bootstrapPromptContext,
      };

      setState("sessions", info.id, session);

      if (!state.activeSessionId) {
        setState("activeSessionId", info.id);
      }

      const pendingEvents = pendingSessionEvents.get(info.id);
      if (pendingEvents?.length) {
        for (const pendingEvent of pendingEvents) {
          this.handleSessionEvent(info.id, pendingEvent);
        }
        pendingSessionEvents.delete(info.id);
      }

      let readyResolve: () => void;
      const readyPromiseObj = {
        promise: new Promise<void>((resolve) => {
          readyResolve = resolve;
        }),
        resolve: () => readyResolve(),
      };
      sessionReadyPromises.set(info.id, readyPromiseObj);

      if (state.sessions[info.id]?.info.status === "ready") {
        readyPromiseObj.resolve();
        sessionReadyPromises.delete(info.id);
      }

      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(
          () => reject(new Error("Agent initialization timed out")),
          30000,
        );
      });

      let initFailure: string | null = null;
      try {
        const readySessionId = await Promise.race([
          readyPromise,
          timeoutPromise,
        ]);
        console.log("[AgentStore] Session ready:", readySessionId);

        if (readySessionId === info.id) {
          setState(
            "sessions",
            info.id,
            "info",
            "status",
            "ready" as SessionStatus,
          );
        }
      } catch (raceError) {
        const message =
          raceError instanceof Error ? raceError.message : String(raceError);
        if (message.toLowerCase().includes("timed out")) {
          console.warn(
            "[AgentStore] Timeout waiting for ready, proceeding anyway",
          );
          const entry = sessionReadyPromises.get(info.id);
          if (entry) {
            entry.resolve();
            sessionReadyPromises.delete(info.id);
          }
        } else {
          initFailure = message;
        }
      }

      if (initFailure) {
        if (
          resolvedAgentType === "claude-code" &&
          initRetryAttempt < MAX_CLAUDE_INIT_RETRIES &&
          isRetryableClaudeInitError(initFailure)
        ) {
          console.warn(
            "[AgentStore] Claude init failed, retrying:",
            initFailure,
          );
          await this.terminateSession(info.id);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          const delayMs =
            CLAUDE_INIT_RETRY_DELAY_MS * (initRetryAttempt + 1) +
            Math.floor(Math.random() * 200);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return this.spawnSession(cwd, resolvedAgentType, {
            ...opts,
            initRetryAttempt: initRetryAttempt + 1,
          });
        }
        if (
          resolvedAgentType === "claude-code" &&
          !reclaimedIdleClaude &&
          isRetryableClaudeInitError(initFailure)
        ) {
          const idleClaude = getIdleClaudeSessionIds(localSessionId);
          if (idleClaude.length > 0) {
            const evictedId = idleClaude[0];
            console.warn(
              "[AgentStore] Claude init failed under pressure; reclaiming idle Claude session and retrying:",
              evictedId,
            );
            await this.terminateSession(evictedId);
            await this.terminateSession(info.id);
            sessionReadyPromises.delete(info.id);
            pendingSessionEvents.delete(info.id);
            setState("isLoading", false);
            tempUnsubscribe();
            await new Promise((resolve) => setTimeout(resolve, 300));
            return this.spawnSession(cwd, resolvedAgentType, {
              ...opts,
              initRetryAttempt: 0,
              reclaimedIdleClaude: true,
            });
          }
        }

        setState("error", initFailure);
        await this.terminateSession(info.id);
        sessionReadyPromises.delete(info.id);
        pendingSessionEvents.delete(info.id);
        setState("isLoading", false);
        tempUnsubscribe();
        return null;
      }

      if (!state.sessions[info.id]) {
        const exitedMsg = "Agent session exited during initialization.";
        if (
          resolvedAgentType === "claude-code" &&
          initRetryAttempt < MAX_CLAUDE_INIT_RETRIES
        ) {
          console.warn(
            "[AgentStore] Claude session exited during init, retrying.",
          );
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          const delayMs =
            CLAUDE_INIT_RETRY_DELAY_MS * (initRetryAttempt + 1) +
            Math.floor(Math.random() * 200);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return this.spawnSession(cwd, resolvedAgentType, {
            ...opts,
            initRetryAttempt: initRetryAttempt + 1,
          });
        }
        if (resolvedAgentType === "claude-code" && !reclaimedIdleClaude) {
          const idleClaude = getIdleClaudeSessionIds(localSessionId);
          if (idleClaude.length > 0) {
            const evictedId = idleClaude[0];
            console.warn(
              "[AgentStore] Claude init exited early; reclaiming idle Claude session and retrying:",
              evictedId,
            );
            await this.terminateSession(evictedId);
            sessionReadyPromises.delete(info.id);
            pendingSessionEvents.delete(info.id);
            setState("isLoading", false);
            tempUnsubscribe();
            await new Promise((resolve) => setTimeout(resolve, 300));
            return this.spawnSession(cwd, resolvedAgentType, {
              ...opts,
              initRetryAttempt: 0,
              reclaimedIdleClaude: true,
            });
          }
        }

        setState("error", exitedMsg);
        sessionReadyPromises.delete(info.id);
        pendingSessionEvents.delete(info.id);
        setState("isLoading", false);
        tempUnsubscribe();
        return null;
      }

      const spawned = state.sessions[info.id];
      const initError =
        spawned?.error ??
        (spawned?.info.status === "error"
          ? "Agent session failed during initialization."
          : null);
      if (initError) {
        setState("error", initError);
        await this.terminateSession(info.id);
        sessionReadyPromises.delete(info.id);
        pendingSessionEvents.delete(info.id);
        setState("isLoading", false);
        tempUnsubscribe();
        return null;
      }

      setState("isLoading", false);
      tempUnsubscribe();

      // Bridge to acpStore so AgentChat can render the interactive session
      try {
        const { acpStore } = await import("@/stores/acp.store");
        await acpStore.adoptSession(
          { id: info.id, agentType: resolvedAgentType, cwd, status: "ready", createdAt: info.createdAt ?? new Date().toISOString() },
          cwd,
        );
      } catch (bridgeErr) {
        console.warn("[AgentStore] Failed to bridge session to acpStore:", bridgeErr);
      }

      return info.id;
    } catch (error) {
      console.error(`[AgentStore] Spawn error (${agentDisplayName(resolvedAgentType)}):`, error);
      tempUnsubscribe();
      const message = error instanceof Error ? error.message : String(error);
      setState("error", message);
      setState("isLoading", false);
      return null;
    }
  },

  async resumeAgentConversation(
    conversationId: string,
    cwd?: string,
  ): Promise<string | null> {
    if (state.sessions[conversationId]) {
      setState("activeSessionId", conversationId);
      return conversationId;
    }

    if (isSpawnCascading(conversationId)) {
      console.error(
        `[AgentStore] Spawn cascade detected for ${conversationId} -- ${SPAWN_CASCADE_MAX_FAILURES} failures in ${SPAWN_CASCADE_WINDOW_MS / 1000}s. Stopping auto-resume.`,
      );
      setState(
        "error",
        "Agent failed to start after multiple attempts. Please try again or check Settings.",
      );
      setState("isLoading", false);
      return null;
    }

    setState("error", null);

    try {
      await providerService.terminateSession(conversationId);
    } catch {
      // Ignore
    }

    let convo: DbAgentConversation | null = null;
    try {
      convo = await getAgentConversation(conversationId);
    } catch (error) {
      console.error("Failed to read agent conversation:", error);
    }
    if (!convo) {
      setState("error", "Agent conversation not found");
      return null;
    }
    const agentType: AgentType =
      convo.agent_type === "codex" || convo.agent_type === "claude-code"
        ? (convo.agent_type as AgentType)
        : state.selectedAgentType;
    const convoMetadata = parseAgentConversationMetadata(convo.agent_metadata);
    const pendingBootstrapPromptContext =
      convoMetadata.pendingBootstrapPromptContext;
    const restoredMessages = Array.isArray(
      convoMetadata.pendingBootstrapMessages,
    )
      ? convoMetadata.pendingBootstrapMessages
      : [];

    const remoteSessionId = convo.agent_session_id?.trim();
    if (!remoteSessionId) {
      console.warn(
        "[AgentStore] Conversation has no stored remote session id; creating a fresh session.",
        conversationId,
      );
      const convoCwd =
        convo.project_root?.trim() || convo.agent_cwd?.trim() || undefined;
      const freshCwd = convoCwd || cwd;
      if (!freshCwd) {
        setState(
          "error",
          "Unable to determine project path for this conversation.",
        );
        return null;
      }
      const freshSessionId = await this.spawnSession(freshCwd, agentType, {
        localSessionId: conversationId,
        conversationTitle: convo.title,
        restoredMessages,
        bootstrapPromptContext: pendingBootstrapPromptContext,
      });
      if (freshSessionId) {
        clearSpawnFailures(conversationId);
        void this.refreshRecentAgentConversations(200).catch(() => {});
      } else {
        recordSpawnFailure(conversationId);
      }
      return freshSessionId;
    }
    if (
      agentType === "claude-code" &&
      LEGACY_CLAUDE_LOCAL_SESSION_ID_RE.test(remoteSessionId)
    ) {
      setState(
        "error",
        "This conversation references a legacy local Claude id. Use Browse Claude Sessions and resume the real remote session.",
      );
      return null;
    }

    const convoCwd =
      convo.project_root?.trim() || convo.agent_cwd?.trim() || undefined;
    const resumeCwd = convoCwd || cwd;
    if (!resumeCwd) {
      setState(
        "error",
        "Unable to determine project path for this conversation.",
      );
      return null;
    }

    const sessionId = await this.spawnSession(resumeCwd, agentType, {
      localSessionId: conversationId,
      resumeAgentSessionId: remoteSessionId,
      conversationTitle: convo.title,
      restoredMessages,
      bootstrapPromptContext: pendingBootstrapPromptContext,
    });

    if (!sessionId && agentType === "claude-code") {
      console.warn(
        "[AgentStore] Claude resume failed, starting a fresh session for conversation",
        conversationId,
        state.error,
      );
      const fallbackSessionId = await this.spawnSession(resumeCwd, agentType, {
        localSessionId: conversationId,
        conversationTitle: convo.title,
        restoredMessages,
        bootstrapPromptContext: pendingBootstrapPromptContext,
      });
      if (fallbackSessionId) {
        clearSpawnFailures(conversationId);
        void this.refreshRecentAgentConversations(200).catch(() => {});
      } else {
        recordSpawnFailure(conversationId);
      }
      return fallbackSessionId;
    }

    if (sessionId) {
      if (!pendingBootstrapPromptContext) {
        clearLegacyAgentTranscript(conversationId);
      }
      clearSpawnFailures(conversationId);
      void this.refreshRecentAgentConversations(200).catch(() => {});
    } else {
      recordSpawnFailure(conversationId);
    }
    return sessionId;
  },

  async resumeRemoteSession(
    remoteSession: RemoteSessionInfo,
    cwd: string,
    agentType?: AgentType,
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const existing = state.recentAgentConversations.find(
      (c) =>
        c.agent_type === resolvedAgentType &&
        c.agent_session_id === remoteSession.sessionId,
    );
    if (existing && state.sessions[existing.id]) {
      setState("activeSessionId", existing.id);
      return existing.id;
    }

    const title =
      remoteSession.title?.trim() ||
      `${resolvedAgentType === "codex" ? "Codex" : "Claude"} Session ${remoteSession.sessionId.slice(0, 8)}`;
    const sessionId = await this.spawnSession(cwd, resolvedAgentType, {
      localSessionId: existing?.id,
      resumeAgentSessionId: remoteSession.sessionId,
      conversationTitle: existing?.title?.trim() || title,
    });
    if (sessionId) {
      void this.refreshRecentAgentConversations(200).catch(() => {});
    }
    return sessionId;
  },

  async buildPromptContext(
    sessionId: string,
    context?: Array<Record<string, string>>,
  ): Promise<Array<Record<string, string>> | undefined> {
    const session = state.sessions[sessionId];
    if (!session) {
      return context && context.length > 0 ? [...context] : undefined;
    }

    let mergedContext = context ? [...context] : [];

    if (session.bootstrapPromptContext) {
      mergedContext = [
        { type: "text", text: session.bootstrapPromptContext },
        ...mergedContext,
      ];
    }

    try {
      const skillsContent = await skillsStore.getThreadSkillsContent(
        session.cwd,
        session.conversationId,
      );
      if (skillsContent) {
        mergedContext = [
          { type: "text", text: skillsContent },
          ...mergedContext,
        ];
      }
    } catch (error) {
      console.warn(
        "[AgentStore] Failed to load skills for agent prompt:",
        error,
      );
    }

    return mergedContext.length > 0 ? mergedContext : undefined;
  },

  setBootstrapPromptContext(
    sessionId: string,
    bootstrapPromptContext?: string,
  ) {
    const session = state.sessions[sessionId];
    if (!session) {
      return;
    }

    setState(
      "sessions",
      sessionId,
      "bootstrapPromptContext",
      bootstrapPromptContext,
    );
    const conversationId = session.conversationId;
    if (conversationId) {
      void setAgentConversationMetadataDb(
        conversationId,
        serializeAgentConversationMetadata({
          pendingBootstrapPromptContext: bootstrapPromptContext,
          pendingBootstrapMessages: bootstrapPromptContext
            ? session.messages
            : undefined,
        }),
      ).catch((error) => {
        console.warn("Failed to persist agent bootstrap context", error);
      });
    }
  },

  clearBootstrapPromptContext(sessionId: string) {
    this.setBootstrapPromptContext(sessionId, undefined);
    const conversationId = state.sessions[sessionId]?.conversationId;
    if (conversationId) {
      clearLegacyAgentTranscript(conversationId);
    }
  },

  async restoreSessionSettings(
    sourceSession: ActiveSession,
    targetSessionId: string,
  ) {
    if (sourceSession.currentModeId) {
      await this.setPermissionMode(
        sourceSession.currentModeId,
        targetSessionId,
      );
    }
    if (sourceSession.currentModelId) {
      await this.setModel(sourceSession.currentModelId, targetSessionId);
    }
    if (sourceSession.configOptions) {
      const restore: Record<string, string> = {};
      for (const opt of sourceSession.configOptions) {
        if (opt.type === "select" && opt.currentValue) {
          restore[opt.id] = opt.currentValue;
        }
      }
      if (Object.keys(restore).length > 0) {
        setState("sessions", targetSessionId, "pendingConfigRestore", restore);
      }
    }
  },

  async terminateSession(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    try {
      await providerService.terminateSession(sessionId);
    } catch (error) {
      console.error("Failed to terminate session:", error);
    }

    sessionReadyPromises.delete(sessionId);
    pendingSessionEvents.delete(sessionId);

    setState(
      produce((draft) => {
        delete draft.sessions[sessionId];
      }),
    );

    if (state.activeSessionId === sessionId) {
      const remainingIds = Object.keys(state.sessions).filter(
        (id) => id !== sessionId,
      );
      setState("activeSessionId", remainingIds[0] ?? null);
    }

    if (Object.keys(state.sessions).length === 0 && globalUnsubscribe) {
      globalUnsubscribe();
      globalUnsubscribe = null;
      pendingSessionEvents.clear();
    }
  },

  setActiveSession(sessionId: string | null) {
    console.log(
      "[AgentRuntime] setActiveSession - old:",
      state.activeSessionId,
      "new:",
      sessionId,
    );
    setState("activeSessionId", sessionId);
  },

  clearSessionMessages(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    setState("sessions", sessionId, "messages", []);
    clearConversationHistory(session.conversationId).catch((err) =>
      console.error("[AgentStore] Failed to clear persisted messages:", err),
    );
  },

  async compactAgentConversation(
    sessionId: string,
    preserveCount: number,
  ): Promise<void> {
    const session = state.sessions[sessionId];
    if (!session || session.isCompacting) return;

    const messages = session.messages;
    if (messages.length <= preserveCount) {
      console.info("[AgentStore] Not enough messages to compact");
      return;
    }

    setState("sessions", sessionId, "isCompacting", true);

    try {
      const toCompact = messages.slice(0, messages.length - preserveCount);
      const toPreserve = messages.slice(-preserveCount);

      const summaryPrompt = `Please provide a concise summary of the following AI coding agent conversation. Focus on: what tasks were requested, what files were modified, key decisions made, and current state of the work. Keep the summary under 500 words.

Conversation to summarize:
${toCompact.map((m) => `${m.type.toUpperCase()}: ${m.content}`).join("\n\n")}

Summary:`;

      const summaryModel = "anthropic/claude-sonnet-4";
      let summary: string;
      try {
        summary = await sendMessage(summaryPrompt, summaryModel);
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : "";
        if (msg.includes("Not authenticated") || msg.includes("401")) {
          const refreshed = await refreshAccessToken();
          if (!refreshed) throw firstErr;
          summary = await sendMessage(summaryPrompt, summaryModel);
        } else {
          throw firstErr;
        }
      }

      const compactedSummary: AgentCompactedSummary = {
        content: summary,
        originalMessageCount: toCompact.length,
        compactedAt: Date.now(),
      };

      const cwd = session.cwd;
      const agentType = session.info.agentType;
      const conversationId = session.conversationId;
      await this.terminateSession(sessionId);

      const newSessionId = await this.spawnSession(cwd, agentType, {
        localSessionId: conversationId,
      });

      if (!newSessionId) {
        console.error(
          "[AgentStore] Failed to spawn new session after compaction",
        );
        return;
      }

      setState("sessions", newSessionId, "compactedSummary", compactedSummary);

      const compactionNotice: AgentMessage = {
        id: generateId(),
        type: "assistant",
        content: `Context compacted: ${toCompact.length} earlier messages summarized to keep the session active. The ${toPreserve.length} most recent messages are shown below.`,
        timestamp: Date.now(),
      };
      setState("sessions", newSessionId, "messages", [
        compactionNotice,
        ...toPreserve,
      ]);
      setState(
        "sessions",
        newSessionId,
        "restoredMessageCount",
        toPreserve.length + 1,
      );

      console.info(
        `[AgentStore] Compacted ${toCompact.length} messages, preserved ${toPreserve.length}. Seeding new session.`,
      );

      const MAX_MSG_CHARS = 2000;
      const preservedContext = toPreserve
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => {
          const content =
            m.content.length > MAX_MSG_CHARS
              ? `${m.content.slice(0, MAX_MSG_CHARS)}... [truncated]`
              : m.content;
          return `${m.type.toUpperCase()}: ${content}`;
        })
        .join("\n\n");

      const seedPrompt = preservedContext
        ? `Here is a summary of our prior conversation:\n\n${summary}\n\nHere are the most recent messages:\n\n${preservedContext}\n\nThis context was restored after automatic compaction. Briefly confirm you have this context (1-2 sentences summarizing where we left off), then wait for the user's next message. Do not read files, edit code, or use any tools until the user sends a new message.`
        : `Here is a summary of our prior conversation:\n\n${summary}\n\nThis context was restored after automatic compaction. Briefly confirm you have this context (1-2 sentences summarizing where we left off), then wait for the user's next message. Do not read files, edit code, or use any tools until the user sends a new message.`;

      await waitForSessionReady(newSessionId);

      await this.restoreSessionSettings(session, newSessionId);

      await providerService.sendPrompt(newSessionId, seedPrompt);
    } catch (error) {
      console.error(
        "[AgentStore] Failed to compact agent conversation:",
        error,
      );
      if (state.sessions[sessionId]) {
        setState("sessions", sessionId, "isCompacting", false);
      }
    }
  },

  async compactAndRetry(sessionId: string): Promise<boolean> {
    const session = state.sessions[sessionId];
    if (!session || session.compactRetryAttempted || session.isCompacting) {
      return false;
    }

    setState("sessions", sessionId, "compactRetryAttempted", true);

    const lastPrompt = session.lastUserPrompt;
    console.info(
      `[AgentStore] Prompt too long -- attempting compaction${lastPrompt ? " + retry" : " (no prompt to retry)"}`,
    );

    try {
      await this.compactAgentConversation(
        sessionId,
        settingsStore.settings.autoCompactPreserveMessages,
      );

      const convoId = session.conversationId;
      const newEntry = Object.entries(state.sessions).find(
        ([, s]) => s.conversationId === convoId && !s.isCompacting,
      );
      if (!newEntry) {
        console.warn(
          "[AgentStore] compactAndRetry: new session not found after compaction",
        );
        return false;
      }

      const [newSessionId] = newEntry;

      if (newSessionId === sessionId) {
        console.warn(
          "[AgentStore] compactAndRetry: compaction was skipped, cannot retry",
        );
        return false;
      }

      await waitForSessionIdle(newSessionId);

      if (lastPrompt) {
        console.info(
          `[AgentStore] Compaction complete, retrying prompt on session ${newSessionId}`,
        );
        await providerService.sendPrompt(newSessionId, lastPrompt);
      } else {
        console.info(
          `[AgentStore] Compaction complete on session ${newSessionId} -- no prompt to retry, session ready`,
        );
      }
      return true;
    } catch (error) {
      console.error(
        "[AgentStore] compactAndRetry failed, falling back to Chat:",
        error,
      );
      return false;
    }
  },

  focusProjectSession(cwd: string): boolean {
    const match = Object.entries(state.sessions).find(
      ([, session]) => session.cwd === cwd,
    );
    if (!match) return false;
    const [sessionId] = match;
    if (state.activeSessionId !== sessionId) {
      setState("activeSessionId", sessionId);
    }
    return true;
  },

  // ============================================================================
  // Messaging
  // ============================================================================

  async sendPrompt(
    prompt: string,
    context?: Array<Record<string, string>>,
    options?: { displayContent?: string; docNames?: string[] },
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    console.log("[AgentStore] sendPrompt called:", {
      sessionId,
      prompt: prompt.slice(0, 50),
    });
    if (!sessionId) {
      setState("error", "No active session");
      return;
    }

    const session = state.sessions[sessionId];
    if (!session || session.info.status === "error") {
      if (session) {
        setState(
          "sessions",
          sessionId,
          "error",
          "Session has ended. Please start a new session.",
        );
      } else {
        setState("error", "Session has ended. Please start a new session.");
      }
      return;
    }

    const thisRecovery = recoveryInFlightMap.get(sessionId);
    if (thisRecovery) {
      console.info(
        `[AgentStore] sendPrompt: recovery in-flight for ${sessionId}, waiting before proceeding...`,
      );
      await thisRecovery;
      const refreshed = state.sessions[sessionId];
      if (!refreshed) {
        console.info(
          "[AgentStore] sendPrompt: session gone after recovery, aborting",
        );
        return;
      }
      if (refreshed.info.status === "prompting") {
        console.info(
          "[AgentStore] sendPrompt: session already prompting after recovery, aborting duplicate",
        );
        return;
      }
    }

    if (
      sessionReadyPromises.has(sessionId) &&
      state.sessions[sessionId]?.info.status !== "ready"
    ) {
      console.info(
        `[AgentStore] sendPrompt: waiting for session ${sessionId} to be ready...`,
      );
      await waitForSessionReady(sessionId);
      console.info("[AgentStore] sendPrompt: session is now ready");
    }

    const thisRecoveryAfterWait = recoveryInFlightMap.get(sessionId);
    if (thisRecoveryAfterWait) {
      console.info(
        `[AgentStore] sendPrompt: recovery started during ready-wait for ${sessionId}, deferring...`,
      );
      await thisRecoveryAfterWait;
      const refreshed = state.sessions[sessionId];
      if (!refreshed || refreshed.info.status === "prompting") {
        console.info(
          "[AgentStore] sendPrompt: session busy after recovery, aborting duplicate",
        );
        return;
      }
    }

    setState(
      "sessions",
      sessionId,
      "info",
      "status",
      "prompting" as SessionStatus,
    );

    setState("sessions", sessionId, "promptStartTime", Date.now());
    setState("sessions", sessionId, "cancelRequested", undefined);
    setState("sessions", sessionId, "lastUserPrompt", prompt);
    setState("sessions", sessionId, "compactRetryAttempted", false);

    const userMessage: AgentMessage = {
      id: generateId(),
      type: "user",
      content: options?.displayContent ?? prompt,
      timestamp: Date.now(),
      ...(options?.docNames?.length ? { docNames: options.docNames } : {}),
    };

    console.log(
      "[AgentRuntime] Adding user message to session:",
      sessionId,
      "conversationId:",
      state.sessions[sessionId]?.conversationId,
      "content:",
      prompt.slice(0, 50),
    );
    setState("sessions", sessionId, "messages", (msgs) => [
      ...msgs,
      userMessage,
    ]);
    const convoId = state.sessions[sessionId]?.conversationId;
    if (convoId) persistAgentMessage(convoId, userMessage);
    clearChunkBuf(sessionId);
    setState("sessions", sessionId, "streamingContent", "");
    setState("sessions", sessionId, "streamingContentTimestamp", undefined);
    setState("sessions", sessionId, "streamingThinking", "");
    setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);

    if (!state.sessions[sessionId]?.title) {
      const maxLen = 30;
      const trimmed = prompt.trim().replace(/\s+/g, " ");
      const title =
        trimmed.length <= maxLen
          ? trimmed
          : (() => {
              const t = trimmed.slice(0, maxLen);
              const sp = t.lastIndexOf(" ");
              return `${sp > 10 ? t.slice(0, sp) : t}\u2026`;
            })();
      setState("sessions", sessionId, "title", title);

      const convoId = state.sessions[sessionId]?.conversationId;
      if (convoId) {
        setAgentConversationTitleDb(convoId, title).catch((err) => {
          console.warn("[AgentStore] Failed to persist title:", err);
        });
      }
    }

    console.log("[AgentStore] Calling providerService.sendPrompt...");
    try {
      const mergedContext = await this.buildPromptContext(sessionId, context);
      await providerService.sendPrompt(sessionId, prompt, mergedContext);
      this.clearBootstrapPromptContext(sessionId);
      console.log("[AgentStore] sendPrompt completed successfully");
    } catch (error) {
      const agentLabel = agentDisplayName(state.sessions[sessionId]?.info.agentType);
      console.error(`[AgentStore] sendPrompt error (${agentLabel}):`, error);
      const message = error instanceof Error ? error.message : String(error);

      const isForceStop = message.includes("unresponsive");
      const isDeadSession =
        message.includes("Worker thread dropped") ||
        message.includes("not found") ||
        message.includes("Session not initialized");
      if (
        isForceStop ||
        (!message.includes("Task cancelled") && isDeadSession)
      ) {
        const existingRecovery = recoveryInFlightMap.get(sessionId);
        if (existingRecovery) {
          console.info(
            `[AgentStore] Recovery already in-flight for ${sessionId}, waiting for it...`,
          );
          await existingRecovery;
          return;
        }

        console.info(
          "[AgentStore] Session appears dead, attempting auto-recovery...",
        );

        const existingMessages = [...session.messages].filter(
          (m) =>
            m.id !== userMessage.id &&
            !(m.type === "error" && m.content.includes("unresponsive")),
        );
        const cwd = session.cwd;
        const agentType = session.info.agentType;
        const wasUserCancel = session.cancelRequested === true;

        await this.terminateSession(sessionId);

        const doRecovery = async (): Promise<string | null> => {
          const newSessionId = await this.spawnSession(cwd, agentType, {
            localSessionId: session.conversationId,
            bootstrapPromptContext: session.bootstrapPromptContext,
          });
          if (newSessionId) {
            await this.restoreSessionSettings(session, newSessionId);

            if (existingMessages.length > 0) {
              setState("sessions", newSessionId, "messages", existingMessages);
              setState(
                "sessions",
                newSessionId,
                "restoredMessageCount",
                existingMessages.length,
              );
            }

            if (wasUserCancel) {
              console.info(
                "[AgentStore] Agent unresponsive after cancel -- spawned fresh session, skipping retry",
              );
              const cancelMsg: AgentMessage = {
                id: generateId(),
                type: "assistant",
                content: "Session restarted after cancellation.",
                timestamp: Date.now(),
              };
              setState("sessions", newSessionId, "messages", (msgs) => [
                ...msgs,
                cancelMsg,
              ]);
              const newConvoId = state.sessions[newSessionId]?.conversationId;
              if (newConvoId) {
                persistAgentMessage(newConvoId, cancelMsg);
              }
            } else {
              const recoveryMsg: AgentMessage = {
                id: generateId(),
                type: "assistant",
                content:
                  "Agent session restarted due to inactivity timeout. Retrying your message...",
                timestamp: Date.now(),
              };
              setState("sessions", newSessionId, "messages", (msgs) => [
                ...msgs,
                recoveryMsg,
                userMessage,
              ]);
              const newConvoId = state.sessions[newSessionId]?.conversationId;
              if (newConvoId) {
                persistAgentMessage(newConvoId, recoveryMsg);
                persistAgentMessage(newConvoId, userMessage);
              }

              console.info(
                `[AgentStore] Retrying prompt on new session ${newSessionId}`,
              );
              try {
                const retryContext = await this.buildPromptContext(
                  newSessionId,
                  context,
                );
                await providerService.sendPrompt(
                  newSessionId,
                  prompt,
                  retryContext,
                );
                this.clearBootstrapPromptContext(newSessionId);
                console.log("[AgentStore] Retry succeeded on new session");
              } catch (retryError) {
                console.error("[AgentStore] Retry failed:", retryError);
                const retryMessage =
                  retryError instanceof Error
                    ? retryError.message
                    : String(retryError);
                this.addErrorMessage(
                  newSessionId,
                  `Recovery failed: ${retryMessage}. Please try sending your message again.`,
                );
              }
            }
          }
          return newSessionId;
        };

        const recoveryPromise = doRecovery().finally(() => {
          recoveryInFlightMap.delete(sessionId);
        });
        recoveryInFlightMap.set(sessionId, recoveryPromise);

        const newSessionId = await recoveryPromise;
        if (!newSessionId) {
          setState("error", "Session died and could not be restarted.");
        }
        return;
      }

      if (isPromptTooLongError(message)) {
        const compactPromise = state.sessions[sessionId]?.compactRetryPromise;
        if (compactPromise) {
          console.info(
            "[AgentStore] sendPrompt: waiting for in-flight compaction to complete",
          );
          await compactPromise;
        }
      } else if (!message.includes("Task cancelled")) {
        this.addErrorMessage(sessionId, message);
      }

      const isReconnecting = /^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(message);
      if (
        !isReconnecting &&
        state.sessions[sessionId]?.info.status === "prompting"
      ) {
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );
      }
    }
  },

  async cancelPrompt(forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) {
      console.warn("[AgentStore] cancelPrompt: no active session");
      return;
    }

    setState("sessions", sessionId, "cancelRequested", true);

    try {
      await providerService.cancelPrompt(sessionId);
      console.info("[AgentStore] cancelPrompt: backend acknowledged cancel");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) {
        console.warn(
          "[AgentStore] cancelPrompt: stale session, resetting status",
        );
        setState("sessions", sessionId, "info", "status", "ready");
      } else {
        console.error("[AgentStore] cancelPrompt failed:", error);
      }
    }
  },

  async setPermissionMode(modeId: string, forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setPermissionMode(sessionId, modeId);
      setState("sessions", sessionId, "currentModeId", modeId);
    } catch (error) {
      console.error(
        `[AgentStore] Failed to set permission mode to "${modeId}":`,
        error,
      );
    }
  },

  async setModel(modelId: string, forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setModel(sessionId, modelId);
      setState("sessions", sessionId, "currentModelId", modelId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationModelIdDb(
          session.conversationId,
          modelId,
        ).catch((error) => {
          console.warn("Failed to persist agent model selection", error);
        });
      }
    } catch (error) {
      console.error("[AgentStore] Failed to set model:", error);
    }
  },

  async setConfigOption(
    configId: string,
    valueId: string,
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setConfigOption(sessionId, configId, valueId);
      setState("sessions", sessionId, "configOptions", (opts) => {
        if (!opts) return opts;
        return opts.map((o) => {
          if (o.id === configId && o.type === "select") {
            return { ...o, currentValue: valueId };
          }
          return o;
        });
      });
    } catch (error) {
      console.error("[AgentStore] Failed to set config option:", error);
    }
  },

  async respondToPermission(requestId: string, optionId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (!permission) {
      console.warn(
        `[AgentStore] respondToPermission: request ${requestId} not found in pending list`,
      );
      return;
    }

    console.info(
      `[AgentStore] Responding to permission ${requestId}: session=${permission.sessionId}, option=${optionId}`,
    );

    try {
      await providerService.respondToPermission(
        permission.sessionId,
        requestId,
        optionId,
      );
      console.info(
        `[AgentStore] Permission ${requestId} response delivered to backend`,
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("not found") || errorMsg.includes("timed out")) {
        console.warn(
          `[AgentStore] Permission ${requestId} no longer valid (likely timed out)`,
        );
      } else {
        console.error(
          `[AgentStore] Failed to respond to permission ${requestId}:`,
          error,
        );
      }
    }

    setState(
      "pendingPermissions",
      state.pendingPermissions.filter((p) => p.requestId !== requestId),
    );
  },

  async dismissPermission(requestId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (permission) {
      console.info(
        `[AgentStore] Dismissing permission ${requestId}: session=${permission.sessionId}`,
      );
      try {
        await providerService.respondToPermission(
          permission.sessionId,
          requestId,
          "deny",
        );
      } catch (error) {
        console.error(
          `[AgentStore] Failed to send deny for permission ${requestId}:`,
          error,
        );
      }
    } else {
      console.warn(
        `[AgentStore] dismissPermission: request ${requestId} not found in pending list`,
      );
    }
    setState(
      "pendingPermissions",
      state.pendingPermissions.filter((p) => p.requestId !== requestId),
    );
  },

  async respondToDiffProposal(proposalId: string, accepted: boolean) {
    const proposal = state.pendingDiffProposals.find(
      (p) => p.proposalId === proposalId,
    );
    if (!proposal) return;

    try {
      await providerService.respondToDiffProposal(
        proposal.sessionId,
        proposalId,
        accepted,
      );
    } catch (error) {
      console.error("Failed to respond to diff proposal:", error);
    }

    setState(
      "pendingDiffProposals",
      state.pendingDiffProposals.filter((p) => p.proposalId !== proposalId),
    );
  },

  // ============================================================================
  // UI State
  // ============================================================================

  setAgentModeEnabled(enabled: boolean) {
    setState("agentModeEnabled", runtimeHasAgentCapability() && enabled);
  },

  setSelectedAgentType(agentType: AgentType) {
    setState("selectedAgentType", agentType);
    setState("remoteSessions", []);
    setState("remoteSessionsNextCursor", null);
    setState("remoteSessionsError", null);
  },

  async updateCwd(newCwd: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    const session = state.sessions[sessionId];
    if (!session || session.cwd === newCwd) return;

    setState("sessions", sessionId, "cwd", newCwd);

    if (session.info.status === "ready") {
      await this.sendPrompt(
        `Please change your working directory to: ${newCwd}`,
      );
    }
  },

  get rateLimitHit(): boolean {
    const session = this.activeSession;
    return session?.rateLimitHit === true;
  },

  get promptTooLong(): boolean {
    const session = this.activeSession;
    return session?.promptTooLong === true;
  },

  get agentFallbackNeeded(): boolean {
    return this.rateLimitHit || this.promptTooLong;
  },

  get agentFallbackReason(): "rate_limit" | "prompt_too_long" | null {
    if (this.promptTooLong) return "prompt_too_long";
    if (this.rateLimitHit) return "rate_limit";
    return null;
  },

  dismissRateLimitPrompt() {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "rateLimitHit", false);
      setState("sessions", sessionId, "promptTooLong", false);
    }
  },

  async acceptRateLimitFallback(): Promise<string | null> {
    const session = this.activeSession;
    if (!session) return null;

    const agentType = session.info.agentType;
    const messages = [...session.messages];
    const agentModelId = session.currentModelId;
    const title = session.title;
    const reason = this.agentFallbackReason ?? "rate_limit";

    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "rateLimitHit", false);
      setState("sessions", sessionId, "promptTooLong", false);
    }

    return performAgentFallback(
      agentType,
      messages,
      agentModelId,
      title,
      reason,
    );
  },

  clearError() {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "error", null);
    }
    setState("error", null);
  },

  // ============================================================================
  // Event Handling (Internal)
  // ============================================================================

  handleSessionEvent(sessionId: string, event: AgentEvent) {
    if (event.type !== "userMessage") {
      this.flushPendingUserMessage(sessionId);
    }

    switch (event.type) {
      case "messageChunk":
        this.handleMessageChunk(
          sessionId,
          event.data.text,
          event.data.isThought,
          event.data.timestamp,
        );
        break;

      case "toolCall":
        this.handleToolCall(sessionId, event.data);
        break;

      case "toolResult":
        this.handleToolResult(
          sessionId,
          event.data.toolCallId,
          event.data.status,
          event.data.result,
          event.data.error,
        );
        break;

      case "diff":
        this.handleDiff(sessionId, event.data);
        break;

      case "planUpdate":
        setState("sessions", sessionId, "plan", event.data.entries);
        break;

      case "userMessage":
        this.appendReplayUserChunk(
          sessionId,
          event.data.text,
          event.data.messageId,
          event.data.timestamp,
        );
        break;

      case "promptComplete": {
        const isHistoryReplay =
          event.data.historyReplay === true ||
          event.data.stopReason === "HistoryReplay";
        if (isHistoryReplay) {
          setState("sessions", sessionId, "skipHistoryReplay", undefined);
        }
        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId);
        setState("sessions", sessionId, "isSkippingSkillContext", undefined);
        if (!isHistoryReplay) {
          this.markPendingToolCallsComplete(sessionId);

          const plan = state.sessions[sessionId]?.plan;
          const isInProgress = (s: string) =>
            s === "in_progress" || s === "inprogress" || s === "inProgress";
          if (plan?.some((e) => isInProgress(e.status))) {
            setState(
              "sessions",
              sessionId,
              "plan",
              plan.map((e) =>
                isInProgress(e.status) ? { ...e, status: "completed" } : e,
              ),
            );
          }
        }

        if (!isHistoryReplay && event.data.meta) {
          const inputTokens = event.data.meta.usage?.input_tokens;
          const reportedContextWindow = event.data.meta.contextWindow;
          if (
            typeof reportedContextWindow === "number" &&
            reportedContextWindow > 0
          ) {
            setState(
              "sessions",
              sessionId,
              "contextWindowSize",
              reportedContextWindow,
            );
          }
          if (inputTokens != null) {
            setState("sessions", sessionId, "lastInputTokens", inputTokens);
            const ctxSize =
              state.sessions[sessionId]?.contextWindowSize ?? 200_000;
            console.log(
              `[AgentStore] Agent usage: ${inputTokens} input tokens`,
              `(${Math.round((inputTokens / ctxSize) * 100)}% of ${ctxSize.toLocaleString()} context)`,
            );
          }
        }

        // A successful prompt completion proves the session is healthy.
        // Clear any stale error (e.g. auth-expired banner after re-login).
        if (!isHistoryReplay && state.sessions[sessionId]?.error) {
          setState("sessions", sessionId, "error", null);
          setState("error", null);
        }

        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );

        if (!isHistoryReplay && !state.sessions[sessionId]?.isCompacting) {
          const sess = state.sessions[sessionId];
          if (settingsStore.settings.autoCompactEnabled && sess) {
            let shouldCompact = false;

            if (sess.lastInputTokens && sess.lastInputTokens > 0) {
              const usagePercent =
                sess.lastInputTokens / sess.contextWindowSize;
              const threshold =
                settingsStore.settings.autoCompactThreshold / 100;
              if (usagePercent >= threshold) {
                console.info(
                  `[AgentStore] Context usage at ${Math.round(usagePercent * 100)}% -- triggering auto-compaction`,
                );
                shouldCompact = true;
              }
            } else {
              const activeCount = Math.max(
                0,
                sess.messages.length - (sess.restoredMessageCount ?? 0),
              );
              if (activeCount > 200) {
                console.info(
                  `[AgentStore] ${activeCount} active messages without token usage data -- triggering auto-compaction`,
                );
                shouldCompact = true;
              }
            }

            if (shouldCompact) {
              this.compactAgentConversation(
                sessionId,
                settingsStore.settings.autoCompactPreserveMessages,
              );
            }
          }
        }
        break;
      }

      case "configOptionsUpdate": {
        const restore = state.sessions[sessionId]?.pendingConfigRestore;
        const incoming = event.data.configOptions;
        const merged = restore
          ? incoming.map((opt) =>
              opt.type === "select" && restore[opt.id]
                ? { ...opt, currentValue: restore[opt.id] }
                : opt,
            )
          : incoming;
        setState("sessions", sessionId, "configOptions", merged);
        if (restore) {
          setState("sessions", sessionId, "pendingConfigRestore", undefined);
          for (const [id, value] of Object.entries(restore)) {
            void this.setConfigOption(id, value, sessionId);
          }
        }
        break;
      }
      case "sessionStatus":
        this.handleStatusChange(sessionId, event.data.status, event.data);
        break;

      case "error":
        console.error(
          `[AgentStore] Error event for session ${sessionId} (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}):`,
          event.data.error,
        );

        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId);
        this.markPendingToolCallsComplete(sessionId);

        if (String(event.data.error).includes("Task cancelled")) {
          const cancelMsg: AgentMessage = {
            id: generateId(),
            type: "error",
            content: event.data.error,
            timestamp: Date.now(),
          };
          setState("sessions", sessionId, "messages", (msgs) => [
            ...msgs,
            cancelMsg,
          ]);
          const cancelConvoId = state.sessions[sessionId]?.conversationId;
          if (cancelConvoId) persistAgentMessage(cancelConvoId, cancelMsg);

          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );
        } else if (String(event.data.error).includes("unresponsive")) {
          console.info(
            "[AgentStore] Skipping error message for unresponsive agent -- sendPrompt handles recovery",
          );
        } else if (
          String(event.data.error).includes("Permission request timed out")
        ) {
          console.warn(
            "[AgentStore] Permission request timed out for session:",
            sessionId,
          );

          const timedOutPermissions = state.pendingPermissions.filter(
            (p) => p.sessionId === sessionId,
          );
          setState(
            "pendingPermissions",
            state.pendingPermissions.filter((p) => p.sessionId !== sessionId),
          );

          if (timedOutPermissions.length > 0) {
            const timeoutMsg: AgentMessage = {
              id: generateId(),
              type: "error",
              content:
                "Permission request timed out after 5 minutes. " +
                "Please try your request again.",
              timestamp: Date.now(),
            };
            setState("sessions", sessionId, "messages", (msgs) => [
              ...msgs,
              timeoutMsg,
            ]);
            const toConvoId = state.sessions[sessionId]?.conversationId;
            if (toConvoId) persistAgentMessage(toConvoId, timeoutMsg);
          }
        } else if (isTimeoutError(String(event.data.error))) {
          console.info(
            "[AgentStore] Skipping non-permission timeout error -- likely spurious race condition",
          );
        } else if (
          isPromptTooLongError(String(event.data.error)) &&
          !state.sessions[sessionId]?.promptTooLongHandled
        ) {
          console.info("[AgentStore] Prompt too long detected in error event");
          setState("sessions", sessionId, "promptTooLongHandled", true);

          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          const compactPromise = this.compactAndRetry(sessionId).then((retried) => {
            if (!retried) {
              console.info(
                "[AgentStore] Compact-and-retry not possible, falling back to Chat mode",
              );
              setState("sessions", sessionId, "promptTooLong", true);
              this.addErrorMessage(sessionId, event.data.error);
              this.acceptRateLimitFallback().catch((err) => {
                console.error("[AgentStore] Auto-failover failed:", err);
              });
            }
            return retried;
          });
          setState("sessions", sessionId, "compactRetryPromise", compactPromise);
        } else if (isRateLimitError(String(event.data.error))) {
          console.info(
            "[AgentStore] Rate limit detected, automatically switching to chat mode",
          );
          setState("sessions", sessionId, "rateLimitHit", true);
          this.addErrorMessage(sessionId, event.data.error);

          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          this.acceptRateLimitFallback().catch((err) => {
            console.error("[AgentStore] Auto-failover failed:", err);
          });
        } else if (/^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(String(event.data.error))) {
          console.info(
            `[AgentStore] (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}) Transient reconnection: ${event.data.error}`,
          );
          this.addErrorMessage(sessionId, event.data.error);
        } else {
          this.addErrorMessage(sessionId, event.data.error);
        }
        break;

      case "permissionRequest": {
        const permEvent = event.data as PermissionRequestEvent;
        console.info(
          "[AgentStore] Permission request received: requestId=" +
            permEvent.requestId +
            ", session=" +
            permEvent.sessionId +
            ", tool=" +
            JSON.stringify(
              (permEvent.toolCall as Record<string, unknown>)?.name ??
                "unknown",
            ),
        );
        setState("pendingPermissions", [
          ...state.pendingPermissions,
          permEvent,
        ]);
        break;
      }

      case "diffProposal": {
        const proposalEvent = event.data as DiffProposalEvent;
        setState("pendingDiffProposals", [
          ...state.pendingDiffProposals,
          proposalEvent,
        ]);
        break;
      }
    }
  },

  flushPendingUserMessage(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session || !session.pendingUserMessage) return;

    if (session.skipHistoryReplay) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      return;
    }

    if (session.pendingUserMessage.trimStart().startsWith("# Active Skills")) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      return;
    }

    const userMsg: AgentMessage = {
      id: generateId(),
      type: "user",
      content: session.pendingUserMessage,
      timestamp: session.pendingUserMessageTimestamp ?? Date.now(),
    };
    setState("sessions", sessionId, "messages", (msgs) => [...msgs, userMsg]);
    if (session.conversationId)
      persistAgentMessage(session.conversationId, userMsg);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
  },

  appendReplayUserChunk(
    sessionId: string,
    text: string,
    messageId?: string,
    timestamp?: number,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    if (session.skipHistoryReplay) return;

    this.finalizeStreamingContent(sessionId);

    const incomingMessageId = messageId?.trim() || undefined;
    if (
      session.pendingUserMessage &&
      incomingMessageId &&
      session.pendingUserMessageId &&
      session.pendingUserMessageId !== incomingMessageId
    ) {
      this.flushPendingUserMessage(sessionId);
    }

    setState(
      "sessions",
      sessionId,
      "pendingUserMessage",
      (current) => current + text,
    );

    if (!session.pendingUserMessageId && incomingMessageId) {
      setState(
        "sessions",
        sessionId,
        "pendingUserMessageId",
        incomingMessageId,
      );
    }
    if (session.pendingUserMessageTimestamp === undefined) {
      setState(
        "sessions",
        sessionId,
        "pendingUserMessageTimestamp",
        timestamp ?? Date.now(),
      );
    }
  },

  handleMessageChunk(
    sessionId: string,
    text: string,
    isThought?: boolean,
    timestamp?: number,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    if (session.skipHistoryReplay) return;

    let buf = chunkBufs.get(sessionId);
    if (!buf) {
      buf = { content: "", thinking: "" };
      chunkBufs.set(sessionId, buf);
    }

    if (isThought) {
      if (!session.streamingThinking && !buf.thinking) {
        setState(
          "sessions",
          sessionId,
          "streamingThinkingTimestamp",
          timestamp ?? Date.now(),
        );
      }
      buf.thinking += text;
    } else {
      if (!session.streamingContent && !buf.content) {
        setState(
          "sessions",
          sessionId,
          "streamingContentTimestamp",
          timestamp ?? Date.now(),
        );
      }
      buf.content += text;
    }

    if (!chunkFlushTimers.has(sessionId)) {
      chunkFlushTimers.set(
        sessionId,
        setTimeout(() => {
          chunkFlushTimers.delete(sessionId);
          flushChunkBuf(sessionId);
        }, CHUNK_FLUSH_MS),
      );
    }
  },

  handleToolCall(sessionId: string, toolCall: ToolCallEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    if (session.skipHistoryReplay) return;

    flushChunkBuf(sessionId);
    if (session.streamingThinking) {
      const thinkingMsg: AgentMessage = {
        id: generateId(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMsg,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, thinkingMsg);
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }
    if (session.streamingContent) {
      const contentMsg: AgentMessage = {
        id: generateId(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        contentMsg,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, contentMsg);
      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
    }

    if (session.messages.some((m) => m.toolCallId === toolCall.toolCallId)) {
      return;
    }

    session.pendingToolCalls.set(toolCall.toolCallId, toolCall);

    const message: AgentMessage = {
      id: generateId(),
      type: "tool",
      content: toolCall.title,
      timestamp: Date.now(),
      toolCallId: toolCall.toolCallId,
      toolCall,
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    if (session.conversationId)
      persistAgentMessage(session.conversationId, message);
  },

  handleToolResult(
    sessionId: string,
    toolCallId: string,
    status: string,
    result?: string,
    error?: string,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    if (session.skipHistoryReplay) return;

    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (msg.toolCallId === toolCallId && msg.toolCall) {
          return {
            ...msg,
            toolCall: {
              ...msg.toolCall,
              status,
              ...(result !== undefined && { result }),
              ...(error !== undefined && { error }),
            },
          };
        }
        return msg;
      }),
    );
    const updatedToolMsg = state.sessions[sessionId]?.messages.find(
      (m: AgentMessage) => m.toolCallId === toolCallId,
    );
    if (updatedToolMsg && session.conversationId) {
      persistAgentMessage(session.conversationId, updatedToolMsg);
    }

    session.pendingToolCalls.delete(toolCallId);
  },

  markPendingToolCallsComplete(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    const runningStatuses = ["running", "pending", "in_progress"];
    const hasRunning = session.messages.some(
      (msg) =>
        msg.toolCall &&
        runningStatuses.includes(msg.toolCall.status.toLowerCase()),
    );

    if (!hasRunning) return;

    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (
          msg.toolCall &&
          runningStatuses.includes(msg.toolCall.status.toLowerCase())
        ) {
          return {
            ...msg,
            toolCall: { ...msg.toolCall, status: "completed" },
          };
        }
        return msg;
      }),
    );
    if (session.conversationId) {
      for (const msg of state.sessions[sessionId]?.messages ?? []) {
        if (msg.toolCall && msg.toolCall.status === "completed") {
          persistAgentMessage(session.conversationId, msg);
        }
      }
    }

    session.pendingToolCalls.clear();
  },

  handleDiff(sessionId: string, diff: DiffEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    if (session.skipHistoryReplay) return;

    const nextMessage: AgentMessage = {
      id: generateId(),
      type: "diff",
      content: `Modified: ${diff.path}`,
      timestamp: Date.now(),
      toolCallId: diff.toolCallId,
      diff,
    };

    setState("sessions", sessionId, "messages", (msgs) => {
      const existingIndex = msgs.findIndex(
        (m) =>
          m.type === "diff" &&
          m.toolCallId === diff.toolCallId &&
          m.diff?.path === diff.path,
      );

      if (existingIndex >= 0) {
        const next = msgs.slice();
        next[existingIndex] = {
          ...next[existingIndex],
          id: next[existingIndex].id,
          timestamp: next[existingIndex].timestamp,
          content: nextMessage.content,
          diff: nextMessage.diff,
        };
        return next;
      }

      return [...msgs, nextMessage];
    });
    const storedDiff = state.sessions[sessionId]?.messages.find(
      (m: AgentMessage) =>
        m.type === "diff" &&
        m.toolCallId === diff.toolCallId &&
        m.diff?.path === diff.path,
    );
    if (storedDiff && session.conversationId) {
      persistAgentMessage(session.conversationId, storedDiff);
    }
  },

  handleStatusChange(
    sessionId: string,
    status: SessionStatus,
    data?: SessionStatusEvent,
  ) {
    setState("sessions", sessionId, "info", "status", status);

    if (status === "ready") {
      setState("sessions", sessionId, "skipHistoryReplay", undefined);
    }

    if (data?.agentSessionId) {
      setState("sessions", sessionId, "agentSessionId", data.agentSessionId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationSessionIdDb(
          session.conversationId,
          data.agentSessionId,
        ).catch((error) => {
          console.warn("Failed to persist agent session id", error);
        });
      }
    }

    if (data?.models) {
      const models = data.models as {
        currentModelId: string;
        availableModels: AgentModelInfo[];
      };
      setState("sessions", sessionId, "currentModelId", models.currentModelId);
      setState(
        "sessions",
        sessionId,
        "availableModels",
        models.availableModels,
      );
    }

    if (data?.modes) {
      const modes = data.modes as {
        currentModeId: string;
        availableModes?: AgentModeInfo[];
      };
      setState("sessions", sessionId, "currentModeId", modes.currentModeId);
      if (modes.availableModes) {
        setState("sessions", sessionId, "availableModes", modes.availableModes);
      }
    }

    if (data?.configOptions) {
      setState("sessions", sessionId, "configOptions", data.configOptions);
    }

    if (status === "ready") {
      setState("sessions", sessionId, "error", null);
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }

    if (status === "terminated") {
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }
  },

  finalizeStreamingContent(sessionId: string) {
    flushChunkBuf(sessionId);

    const session = state.sessions[sessionId];
    if (!session) return;

    if (session.streamingThinking) {
      const thinkingMessage: AgentMessage = {
        id: generateId(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMessage,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, thinkingMessage);
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }

    if (session.streamingContent) {
      const isSkillContextStart = session.streamingContent
        .trimStart()
        .startsWith("# Active Skills");
      if (isSkillContextStart || session.isSkippingSkillContext) {
        if (isSkillContextStart) {
          setState("sessions", sessionId, "isSkippingSkillContext", true);
        }
        setState("sessions", sessionId, "streamingContent", "");
        setState("sessions", sessionId, "streamingContentTimestamp", undefined);
        setState("sessions", sessionId, "promptStartTime", undefined);
        return;
      }

      const duration = session.promptStartTime
        ? Date.now() - session.promptStartTime
        : undefined;

      const message: AgentMessage = {
        id: generateId(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
        duration,
      };
      console.log(
        "[AgentRuntime] Adding assistant message to session:",
        sessionId,
        "conversationId:",
        session.conversationId,
        "content:",
        session.streamingContent.slice(0, 50),
      );
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, message);

      if (isLikelyAuthError(session.streamingContent)) {
        setState("sessions", sessionId, "error", session.streamingContent);
      }

      if (
        isPromptTooLongError(session.streamingContent) &&
        !session.promptTooLongHandled
      ) {
        console.info(
          "[AgentStore] Prompt too long detected in streamed content",
        );
        setState("sessions", sessionId, "promptTooLongHandled", true);
        const compactPromise = this.compactAndRetry(sessionId).then((retried) => {
          if (!retried) {
            console.info(
              "[AgentStore] Compact-and-retry not possible, falling back to Chat mode",
            );
            setState("sessions", sessionId, "promptTooLong", true);
            this.acceptRateLimitFallback().catch((err) => {
              console.error(
                "[AgentStore] Auto-failover from streamed content failed:",
                err,
              );
            });
          }
          return retried;
        });
        setState("sessions", sessionId, "compactRetryPromise", compactPromise);
      }

      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
      setState("sessions", sessionId, "promptStartTime", undefined);
    }
  },

  // ============================================================================
  // Fork
  // ============================================================================

  async forkConversation(
    conversationId: string,
    fromMessageId: string,
  ): Promise<string | null> {
    const session = state.sessions[conversationId];
    if (!session) {
      console.error("[AgentStore] forkConversation: session not found");
      return null;
    }

    const agentType = session.info.agentType;
    const cwd = session.cwd;

    const allMessages = session.messages;
    const forkIndex = allMessages.findIndex((m) => m.id === fromMessageId);
    if (forkIndex === -1) {
      console.error("[AgentStore] forkConversation: message not found");
      return null;
    }
    const forkedMessages = allMessages.slice(0, forkIndex + 1);
    const isHeadFork = forkIndex === allMessages.length - 1;
    const useNativeFork =
      providerService.supportsNativeProviderFork(agentType) && isHeadFork;

    let newAgentSessionId: string | undefined;
    let bootstrapPromptContext: string | undefined;

    if (useNativeFork) {
      try {
        newAgentSessionId =
          await providerService.nativeForkSession(conversationId);
      } catch (err) {
        console.error(
          "[AgentStore] forkConversation: native fork failed:",
          err,
        );
        this.addErrorMessage(
          conversationId,
          `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    } else {
      bootstrapPromptContext =
        buildForkBootstrapContext(session, forkedMessages) ?? undefined;
    }

    const newConversationId = generateId();
    const forkTitle = `Fork of ${session.title ?? "Agent"}`;
    try {
      await createAgentConversation(
        newConversationId,
        forkTitle,
        agentType,
        cwd,
        null,
        newAgentSessionId ?? undefined,
        serializeAgentConversationMetadata({
          pendingBootstrapPromptContext: bootstrapPromptContext,
          pendingBootstrapMessages: bootstrapPromptContext
            ? forkedMessages
            : undefined,
        }) ?? undefined,
      );
    } catch (err) {
      console.error("[AgentStore] forkConversation: DB error:", err);
      return null;
    }

    const newSessionId = await this.spawnSession(cwd, agentType, {
      localSessionId: newConversationId,
      resumeAgentSessionId: newAgentSessionId,
      conversationTitle: forkTitle,
      restoredMessages: forkedMessages,
      bootstrapPromptContext,
    });

    if (!newSessionId) {
      console.error("[AgentStore] forkConversation: spawn failed");
      return null;
    }

    await this.restoreSessionSettings(session, newSessionId);

    console.info(
      `[AgentStore] Forked conversation ${conversationId} -> ${newConversationId}${newAgentSessionId ? ` (agent session: ${newAgentSessionId})` : " (bootstrap branch)"}`,
    );

    return newConversationId;
  },

  addErrorMessage(sessionId: string, error: string) {
    const session = state.sessions[sessionId];
    const agentLabel = agentDisplayName(session?.info.agentType);
    const prefixedError = `[${agentLabel}] ${error}`;

    const message: AgentMessage = {
      id: generateId(),
      type: "error",
      content: prefixedError,
      timestamp: Date.now(),
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    const errConvoId = session?.conversationId;
    if (errConvoId) persistAgentMessage(errConvoId, message);
    setState("sessions", sessionId, "error", prefixedError);
  },

  // ============================================================================
  // Cleanup
  // ============================================================================

  async cleanup() {
    for (const sessionId of Object.keys(state.sessions)) {
      await this.terminateSession(sessionId);
    }
  },
};

export type {
  AgentType,
  SessionStatus,
  AgentSessionInfo,
  AgentInfo,
  DiffEvent,
  DiffProposalEvent,
};
