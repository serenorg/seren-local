// ABOUTME: Orchestrator service that ties classifier, router, and workers together.
// ABOUTME: TypeScript port of the Rust orchestrator service from seren-desktop.
// ABOUTME: Provides the main orchestrate() entry point called by RPC handlers.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { emit } from "../events.js";
import { needsRlm, processRlm, splitContentAndQuestion } from "./rlm.js";
import { selectRelevantTools, type OpenAITool } from "./tool-relevance.js";
import {
  route,
  isReroutableError,
  isContextOverflowError,
  getLargeContextFallback,
  rerouteOnFailure,
  MAX_REROUTE_ATTEMPTS,
} from "./router.js";
import type {
  ImageAttachment,
  OrchestratorEvent,
  RoutingDecision,
  SkillRef,
  TaskClassification,
  TransitionEvent,
  UserCapabilities,
  WorkerEvent,
  WorkerEventComplete,
  WorkerEventError,
  WorkerEventReroute,
} from "../types/orchestrator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLISHER_SLUG = "seren-models";

/** Gateway base URL for chat completions. */
const DEFAULT_GATEWAY_BASE = "https://api.serendb.com";

/** Request timeout for streaming chat completions (10 minutes). */
const REQUEST_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Cancellation state
// ---------------------------------------------------------------------------

/** Map of conversation_id → AbortController for in-flight orchestrations. */
const activeSessions = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cancel an active orchestration for the given conversation.
 */
export function cancelOrchestration(conversationId: string): boolean {
  const controller = activeSessions.get(conversationId);
  if (controller) {
    controller.abort();
    activeSessions.delete(conversationId);
    console.log(`[Orchestrator] Cancelled orchestration for ${conversationId}`);
    return true;
  }
  return false;
}

/**
 * Execute the full orchestration pipeline for a user prompt.
 *
 * 1. RLM check: if input exceeds context window, process recursively
 * 2. Classify the task (bootstrap heuristic)
 * 3. Route to the appropriate worker type and model
 * 4. Execute via Gateway API with reroute on transient errors
 * 5. Emit events over WebSocket
 */
export async function orchestrate(params: {
  conversationId: string;
  prompt: string;
  history: Array<{ role: string; content: string }>;
  capabilities: UserCapabilities;
  images?: ImageAttachment[];
  gatewayBase?: string;
  authToken: string;
}): Promise<void> {
  const {
    conversationId,
    prompt,
    history,
    capabilities,
    images = [],
    authToken,
  } = params;
  const gatewayBase = params.gatewayBase ?? DEFAULT_GATEWAY_BASE;

  console.log(
    `[Orchestrator] Starting orchestration for conversation ${conversationId}`,
  );

  // Register cancellation
  const abortController = new AbortController();
  activeSessions.set(conversationId, abortController);

  try {
    // ── Step 0: RLM check ──────────────────────────────────────────────
    const modelForLimit =
      capabilities.selected_model || "anthropic/claude-sonnet-4";

    // Estimate total input chars: prompt + history + image placeholders
    const totalInputChars =
      prompt.length +
      history.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) +
      images.length * 1000; // rough estimate per image

    if (needsRlm(totalInputChars, modelForLimit)) {
      console.log(
        "[Orchestrator] Input exceeds context threshold — activating RLM",
      );

      const [content, question] = splitContentAndQuestion(prompt);

      const rlmAnswer = await processRlm(
        question,
        content,
        modelForLimit,
        gatewayBase,
        authToken,
        (event) => {
          // Forward RLM events to frontend
          const workerEvent: WorkerEvent =
            event.type === "rlm_start"
              ? { type: "rlm_start", chunk_count: event.data.total }
              : {
                  type: "rlm_chunk_complete",
                  index: event.data.index,
                  total: event.data.total,
                  summary: event.data.summary ?? "",
                };
          emitOrchestratorEvent(conversationId, workerEvent);
        },
      );

      // Emit the final complete event
      const completeEvent: WorkerEventComplete = {
        type: "complete",
        final_content: rlmAnswer,
      };
      emitOrchestratorEvent(conversationId, completeEvent);
      return;
    }

    // ── Step 1: Classify the task (bootstrap heuristic) ────────────────
    const classification = classifyTask(prompt, capabilities);
    console.log(
      `[Orchestrator] Classification: type=${classification.task_type}, complexity=${classification.complexity}`,
    );

    // ── Step 2: Route ──────────────────────────────────────────────────
    const routing = route(classification, capabilities, prompt);
    console.log(
      `[Orchestrator] Routed to ${routing.worker_type} with model ${routing.model_id}`,
    );

    // ── Step 3: Execute with reroute loop ──────────────────────────────
    await executeWithReroute({
      conversationId,
      prompt,
      history,
      capabilities,
      images,
      classification,
      routing,
      gatewayBase,
      authToken,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      console.log(
        `[Orchestrator] Orchestration cancelled for ${conversationId}`,
      );
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Orchestrator] Error: ${message}`);
    const errorEvent: WorkerEventError = { type: "error", message };
    emitOrchestratorEvent(conversationId, errorEvent);
  } finally {
    activeSessions.delete(conversationId);
  }
}

// ---------------------------------------------------------------------------
// Single-task execution with reroute
// ---------------------------------------------------------------------------

async function executeWithReroute(params: {
  conversationId: string;
  prompt: string;
  history: Array<{ role: string; content: string }>;
  capabilities: UserCapabilities;
  images: ImageAttachment[];
  classification: TaskClassification;
  routing: RoutingDecision;
  gatewayBase: string;
  authToken: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const {
    conversationId,
    prompt,
    history,
    capabilities,
    images,
    classification,
    gatewayBase,
    authToken,
    abortSignal,
  } = params;

  let routing = { ...params.routing };
  const triedModels: string[] = [routing.model_id];
  let rerouteCount = 0;

  // Whether the user explicitly selected a model (limits reroute scope)
  const userExplicitlySelected = Boolean(capabilities.selected_model);

  while (true) {
    if (abortSignal.aborted) {
      console.log(
        `[Orchestrator] Cancelled before execution for ${conversationId}`,
      );
      return;
    }

    // Load skill content from disk
    const skillContent = await loadSkillContent(routing.selected_skills);

    // Select relevant tools via BM25
    const relevantTools = selectRelevantTools(
      prompt,
      capabilities.tool_definitions as unknown as OpenAITool[],
    );

    // Emit transition event
    const transition: TransitionEvent = {
      conversation_id: conversationId,
      model_name: routing.model_id,
      task_description: routing.reason,
    };
    emit("orchestrator://transition", transition);

    // Build messages and call the Gateway API
    const messages = buildMessages(
      prompt,
      history,
      skillContent,
      images,
      routing,
    );

    try {
      await streamChatCompletion({
        conversationId,
        messages,
        model: routing.model_id,
        tools: relevantTools,
        gatewayBase,
        authToken,
        abortSignal,
        reasoningEffort: routing.reasoning_effort,
        publisherSlug: routing.publisher_slug,
      });

      // Success — exit the reroute loop
      console.log(
        `[Orchestrator] Completed orchestration for conversation ${conversationId}`,
      );
      return;
    } catch (err) {
      if (abortSignal.aborted) return;

      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Orchestrator] Worker error: ${errorMessage}`);

      // Check if this error is eligible for reroute
      if (!isReroutableError(errorMessage)) {
        const errorEvent: WorkerEventError = {
          type: "error",
          message: errorMessage,
        };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      if (rerouteCount >= MAX_REROUTE_ATTEMPTS) {
        console.warn(
          `[Orchestrator] Max reroute attempts (${MAX_REROUTE_ATTEMPTS}) exhausted`,
        );
        const errorEvent: WorkerEventError = {
          type: "error",
          message: errorMessage,
        };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      // Context-overflow errors: reroute to a large-context model
      // regardless of whether the user explicitly selected a model
      if (isContextOverflowError(errorMessage)) {
        const fallback = getLargeContextFallback(triedModels);
        if (fallback) {
          const fromModel = routing.model_id;
          console.log(
            `[Orchestrator] Context overflow on ${fromModel}, falling back to ${fallback}`,
          );

          const rerouteEvent: WorkerEventReroute = {
            type: "reroute",
            from_model: fromModel,
            to_model: fallback,
            reason:
              "Switched to larger context model — conversation exceeded model limit",
          };
          emitOrchestratorEvent(conversationId, rerouteEvent);

          routing = { ...routing, model_id: fallback };
          triedModels.push(fallback);
          rerouteCount++;
          continue;
        }

        // All large-context models exhausted
        console.warn(
          "[Orchestrator] Context overflow but all large-context fallbacks exhausted",
        );
        const errorEvent: WorkerEventError = {
          type: "error",
          message: errorMessage,
        };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      // Standard transient errors: reroute to a different model
      if (userExplicitlySelected) {
        // When user explicitly selected a model, don't reroute to a different one
        // (except for context overflow handled above)
        const errorEvent: WorkerEventError = {
          type: "error",
          message: errorMessage,
        };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      const fallbackResult = rerouteOnFailure(
        classification,
        triedModels,
        capabilities.available_models,
      );

      if (!fallbackResult) {
        console.warn("[Orchestrator] No fallback models available for reroute");
        const errorEvent: WorkerEventError = {
          type: "error",
          message: errorMessage,
        };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      const [fallbackModel, reason] = fallbackResult;
      const fromModel = routing.model_id;
      console.log(
        `[Orchestrator] Rerouting from ${fromModel} to ${fallbackModel}: ${reason}`,
      );

      const rerouteEvent: WorkerEventReroute = {
        type: "reroute",
        from_model: fromModel,
        to_model: fallbackModel,
        reason,
      };
      emitOrchestratorEvent(conversationId, rerouteEvent);

      routing = { ...routing, model_id: fallbackModel };
      triedModels.push(fallbackModel);
      rerouteCount++;
    }
  }
}

// ---------------------------------------------------------------------------
// Gateway API streaming
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the Seren Gateway API.
 * Emits WorkerEvents as SSE chunks arrive.
 */
async function streamChatCompletion(params: {
  conversationId: string;
  messages: Array<{ role: string; content: unknown }>;
  model: string;
  tools: OpenAITool[];
  gatewayBase: string;
  authToken: string;
  abortSignal: AbortSignal;
  reasoningEffort?: string;
  publisherSlug?: string;
}): Promise<void> {
  const {
    conversationId,
    messages,
    model,
    tools,
    gatewayBase,
    authToken,
    abortSignal,
    reasoningEffort,
  } = params;
  const publisherSlug = params.publisherSlug ?? PUBLISHER_SLUG;

  const url = `${gatewayBase}/publishers/${publisherSlug}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  const timeoutId = setTimeout(() => {
    // If the AbortController hasn't already been aborted, signal timeout
    if (!abortSignal.aborted) {
      const controller = activeSessions.get(conversationId);
      controller?.abort();
    }
  }, REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (abortSignal.aborted) return;
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway HTTP ${response.status}: ${text}`);
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    throw new Error("No response body from Gateway");
  }

  try {
    await processSSEStream(conversationId, response.body, abortSignal);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Process an SSE stream from the Gateway, parsing each `data:` line and
 * emitting corresponding WorkerEvents.
 */
async function processSSEStream(
  conversationId: string,
  body: ReadableStream<Uint8Array>,
  abortSignal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullThinking = "";
  let totalCost = 0;

  try {
    while (true) {
      if (abortSignal.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Extract cost from chunk metadata if present
        if (typeof chunk.cost === "number") {
          totalCost = chunk.cost as number;
        }

        const choices = chunk.choices as
          | Array<Record<string, unknown>>
          | undefined;
        if (!choices || choices.length === 0) continue;

        const delta = choices[0].delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Content token
        if (typeof delta.content === "string" && delta.content) {
          fullContent += delta.content;
          emitOrchestratorEvent(conversationId, {
            type: "content",
            text: delta.content,
          });
        }

        // Thinking token (extended thinking / chain-of-thought)
        if (typeof delta.thinking === "string" && delta.thinking) {
          fullThinking += delta.thinking;
          emitOrchestratorEvent(conversationId, {
            type: "thinking",
            text: delta.thinking,
          });
        }

        // Tool calls
        const toolCalls = delta.tool_calls as
          | Array<Record<string, unknown>>
          | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const fn = tc.function as Record<string, unknown> | undefined;
            if (fn?.name) {
              emitOrchestratorEvent(conversationId, {
                type: "tool_call",
                tool_call_id: (tc.id as string) ?? "",
                name: fn.name as string,
                arguments: (fn.arguments as string) ?? "{}",
                title: (fn.name as string) ?? "",
              });
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Emit completion
  const completeEvent: WorkerEventComplete = {
    type: "complete",
    final_content: fullContent,
    thinking: fullThinking || undefined,
    cost: totalCost || undefined,
  };
  emitOrchestratorEvent(conversationId, completeEvent);
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

/**
 * Build the messages array for the Gateway chat completions request.
 * Prepends skill content as system context and appends images.
 */
function buildMessages(
  prompt: string,
  history: Array<{ role: string; content: string }>,
  skillContent: string,
  images: ImageAttachment[],
  routing: RoutingDecision,
): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [];

  // System message with skill context
  const systemParts: string[] = ["You are a helpful AI assistant."];
  if (skillContent) {
    systemParts.push(
      "",
      "## Relevant Skills",
      "",
      skillContent,
    );
  }
  messages.push({ role: "system", content: systemParts.join("\n") });

  // Conversation history
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Current user message (with images if present)
  if (images.length > 0) {
    const contentParts: Array<Record<string, unknown>> = [
      { type: "text", text: prompt },
    ];
    for (const img of images) {
      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:${img.mime_type};base64,${img.base64}`,
        },
      });
    }
    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Skill content loading
// ---------------------------------------------------------------------------

/**
 * Load SKILL.md content from disk for each selected skill.
 * Returns concatenated skill content, or empty string if none.
 */
async function loadSkillContent(skills: SkillRef[]): Promise<string> {
  if (skills.length === 0) return "";

  const parts: string[] = [];
  for (const skill of skills) {
    try {
      const skillPath = join(skill.path, "SKILL.md");
      const content = await readFile(skillPath, "utf-8");
      parts.push(`### ${skill.name}\n\n${content}`);
    } catch (err) {
      console.warn(
        `[Orchestrator] Failed to load skill ${skill.slug}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Task classification (bootstrap heuristic)
// ---------------------------------------------------------------------------

/**
 * Bootstrap task classifier using keyword heuristics.
 * Mirrors the Rust classifier::classify() function.
 *
 * In the future, this can be replaced with an LLM-based classifier,
 * but the bootstrap approach avoids an extra round-trip.
 */
function classifyTask(
  prompt: string,
  capabilities: UserCapabilities,
): TaskClassification {
  const lower = prompt.toLowerCase();

  // Detect task type
  let taskType = "general";
  let requiresTools = false;
  let requiresFileSystem = false;

  // Code generation signals
  const codeSignals = [
    "write code",
    "create a function",
    "implement",
    "build a",
    "code",
    "program",
    "script",
    "refactor",
    "debug",
    "fix the bug",
    "add a feature",
    "create a file",
    "write a file",
    "edit the file",
    "modify the code",
  ];
  if (codeSignals.some((s) => lower.includes(s))) {
    taskType = "code_generation";
    requiresFileSystem = true;
  }

  // Tool-use signals
  const toolSignals = [
    "search the web",
    "browse",
    "crawl",
    "scrape",
    "fetch",
    "look up",
    "find online",
    "perplexity",
    "firecrawl",
  ];
  if (toolSignals.some((s) => lower.includes(s))) {
    requiresTools = true;
    if (taskType === "general") taskType = "tool_use";
  }

  // Complexity estimation
  let complexity: "simple" | "moderate" | "complex" = "simple";
  const wordCount = prompt.split(/\s+/).length;
  if (wordCount > 200 || lower.includes("step by step") || lower.includes("detailed")) {
    complexity = "complex";
  } else if (wordCount > 50) {
    complexity = "moderate";
  }

  // Match relevant skills via keyword overlap
  const relevantSkills: string[] = [];
  for (const skill of capabilities.installed_skills) {
    const skillText =
      `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    const promptTerms = lower.split(/\s+/).filter((t) => t.length > 3);
    const overlap = promptTerms.filter((t) => skillText.includes(t)).length;
    if (overlap >= 2) {
      relevantSkills.push(skill.slug);
    }
  }

  return {
    task_type: taskType,
    requires_tools: requiresTools,
    requires_file_system: requiresFileSystem,
    complexity,
    relevant_skills: relevantSkills,
  };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/** Emit an orchestrator event to all connected WebSocket clients. */
function emitOrchestratorEvent(
  conversationId: string,
  workerEvent: WorkerEvent,
  subtaskId?: string,
): void {
  const event: OrchestratorEvent = {
    conversation_id: conversationId,
    worker_event: workerEvent,
    subtask_id: subtaskId,
  };
  emit("orchestrator://event", event);
}
