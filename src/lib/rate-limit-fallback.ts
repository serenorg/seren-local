// ABOUTME: Detects agent rate-limit and prompt-too-long errors, orchestrates fallback to Chat mode.
// ABOUTME: Converts agent messages to chat format and creates a new chat conversation.

import type { AgentType } from "@/services/acp";
import type { AgentMessage } from "@/stores/acp.store";
import type { Message } from "@/services/chat";

/** Patterns that indicate an agent has hit a rate limit. */
const RATE_LIMIT_PATTERNS = [
  "429",
  "rate limit",
  "rate_limit",
  "too many requests",
  "overloaded",
  "limit exceeded",
  "hit your limit",
  "hit the limit",
  "exceeded your",
  "capacity",
  "try again later",
];

/**
 * Check whether an error message indicates a rate limit was hit.
 */
export function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Patterns that indicate the agent's context window is exhausted. */
const PROMPT_TOO_LONG_PATTERNS = [
  "prompt is too long",
  "prompt too long",
  "context length exceeded",
  "context_length_exceeded",
  "maximum context length",
  "token limit",
  "max_tokens",
  "input too long",
  "request too large",
  "content too large",
  "exceeds the model",
  "ran out of room",
  "too many tokens",
  "exceeds the maximum",
  "number of input tokens",
  "reduce your prompt",
  "reduce the number of messages",
];

/**
 * Check whether a message indicates the agent's context window is full.
 *
 * Also catches the CLI's raw API error form:
 *   `API Error: 400 {"type":"error","error":{"type":"invalid_request_error",...}}`
 * which wraps the Anthropic error without always including recognizable keywords.
 */
export function isPromptTooLongError(message: string): boolean {
  const lower = message.toLowerCase();
  if (PROMPT_TOO_LONG_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return true;
  }
  if (
    lower.includes("api error: 400") &&
    lower.includes("invalid_request_error")
  ) {
    return true;
  }
  return false;
}

/**
 * Check whether a message indicates any agent-level failure that warrants
 * falling back to Chat mode (rate limit OR context exhaustion).
 */
export function isAgentFallbackError(message: string): boolean {
  return isRateLimitError(message) || isPromptTooLongError(message);
}

/**
 * Keywords extracted from agent model IDs mapped to their Seren chat equivalents.
 * Order matters — first match wins, so more specific patterns come first.
 */
const AGENT_TO_SEREN_MODEL: Array<[pattern: string, serenId: string]> = [
  ["opus-4", "anthropic/claude-opus-4.5"],
  ["opus", "anthropic/claude-opus-4.5"],
  ["sonnet-4", "anthropic/claude-sonnet-4"],
  ["sonnet", "anthropic/claude-sonnet-4"],
  ["haiku", "anthropic/claude-haiku-4.5"],
  ["gpt-5", "openai/gpt-5"],
  ["gpt-4o-mini", "openai/gpt-4o-mini"],
  ["gpt-4o", "openai/gpt-4o"],
  ["o1-mini", "openai/gpt-4o-mini"],
  ["o1", "openai/gpt-4o"],
  ["gemini-2.5-pro", "google/gemini-2.5-pro"],
  ["gemini-2.5-flash", "google/gemini-2.5-flash"],
  ["gemini-3", "google/gemini-3-flash-preview"],
  ["gemini", "google/gemini-2.5-pro"],
];

/** Default Seren model per agent type when no match is found. */
const DEFAULT_SEREN_MODELS: Record<AgentType, string> = {
  "claude-code": "anthropic/claude-sonnet-4",
  codex: "openai/gpt-4o",
};

/**
 * Map an agent's current model ID to the equivalent Seren chat model ID.
 * Falls back to a sensible default for the agent type if no match.
 */
export function mapAgentModelToChat(
  agentModelId: string | undefined,
  agentType: AgentType,
): string {
  if (agentModelId) {
    const lower = agentModelId.toLowerCase();
    for (const [pattern, serenId] of AGENT_TO_SEREN_MODEL) {
      if (lower.includes(pattern)) {
        return serenId;
      }
    }
  }
  return DEFAULT_SEREN_MODELS[agentType] ?? "anthropic/claude-sonnet-4";
}

/**
 * Get a human-readable display name for a Seren model ID.
 */
export function getModelDisplayName(serenModelId: string): string {
  const names: Record<string, string> = {
    "anthropic/claude-opus-4.5": "Claude Opus 4.5",
    "anthropic/claude-sonnet-4": "Claude Sonnet 4",
    "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
    "openai/gpt-5": "GPT-5",
    "openai/gpt-4o": "GPT-4o",
    "openai/gpt-4o-mini": "GPT-4o Mini",
    "google/gemini-2.5-pro": "Gemini 2.5 Pro",
    "google/gemini-2.5-flash": "Gemini 2.5 Flash",
    "google/gemini-3-flash-preview": "Gemini 3 Flash",
  };
  return names[serenModelId] ?? serenModelId;
}

/**
 * Convert agent messages into chat Message[] for the chat conversation store.
 * Only user and assistant messages carry over — tool calls, diffs, and thoughts
 * are agent-specific artifacts that don't render in chat.
 */
export function agentMessagesToChatMessages(
  messages: AgentMessage[],
): Message[] {
  const converted: Message[] = [];

  for (const msg of messages) {
    if (msg.type === "user") {
      converted.push({
        id: msg.id,
        role: "user",
        content: msg.content,
        timestamp: msg.timestamp,
        status: "complete",
      });
    } else if (msg.type === "assistant") {
      converted.push({
        id: msg.id,
        role: "assistant",
        content: msg.content,
        timestamp: msg.timestamp,
        status: "complete",
        duration: msg.duration,
      });
    }
  }

  return converted;
}

/**
 * Build the redirect notice shown at the top of the new chat conversation.
 */
export function buildRedirectMessage(
  agentType: AgentType,
  modelDisplayName: string,
  reason: "rate_limit" | "prompt_too_long" = "rate_limit",
): Message {
  const agentName = agentType === "codex" ? "Codex" : "Claude Code";
  const reasonText =
    reason === "prompt_too_long"
      ? `${agentName} agent's context window is full.`
      : `${agentName} agent hit its rate limit.`;

  return {
    id: crypto.randomUUID(),
    role: "system",
    content:
      `${reasonText} ` +
      `Your conversation has been moved here so you can continue in Chat with ${modelDisplayName}. ` +
      "Pick up where you left off — your full history is preserved above.",
    timestamp: Date.now(),
    status: "complete",
  };
}

/**
 * Orchestrate the full agent-to-chat switchover.
 *
 * 1. Map the agent's current model to its Seren chat equivalent
 * 2. Convert agent messages to chat Message[]
 * 3. Create a new chat conversation
 * 4. Import the message history + redirect notice
 * 5. Switch the UI from Agent → Chat mode
 *
 * Returns the new conversation ID, or null if the switchover failed.
 */
export async function performAgentFallback(
  agentType: AgentType,
  agentMessages: AgentMessage[],
  agentModelId?: string,
  sessionTitle?: string,
  reason: "rate_limit" | "prompt_too_long" = "rate_limit",
): Promise<string | null> {
  // Lazy imports to avoid circular dependency between stores
  const { chatStore } = await import("@/stores/chat.store");
  const { acpStore } = await import("@/stores/acp.store");
  const { providerStore } = await import("@/stores/provider.store");

  const chatModelId = mapAgentModelToChat(agentModelId, agentType);
  const modelDisplayName = getModelDisplayName(chatModelId);
  const agentName = agentType === "codex" ? "Codex" : "Claude";
  const title = sessionTitle || `${agentName} Agent (continued)`;

  try {
    // Set the model before creating conversation so it picks up the right model
    providerStore.setActiveProvider("seren");
    providerStore.setActiveModel(chatModelId);
    chatStore.setModel(chatModelId);

    // Create the chat conversation
    const conversation = await chatStore.createConversation(title);

    // Convert and import agent history
    const chatMessages = agentMessagesToChatMessages(agentMessages);
    const redirectNotice = buildRedirectMessage(
      agentType,
      modelDisplayName,
      reason,
    );

    chatStore.setMessages(conversation.id, [...chatMessages, redirectNotice]);

    // Switch UI from Agent → Chat
    acpStore.setAgentModeEnabled(false);

    console.info(
      `[AgentFallback] Switched to chat: conversation=${conversation.id}, model=${chatModelId}, reason=${reason} (from agent model ${agentModelId ?? "unknown"})`,
    );

    return conversation.id;
  } catch (error) {
    console.error("[AgentFallback] Failed to perform fallback:", error);
    return null;
  }
}
