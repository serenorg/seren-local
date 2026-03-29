// ABOUTME: Orchestrator service that ties classifier, router, and workers together.
// ABOUTME: TypeScript port of the Rust orchestrator service from seren-desktop.
// ABOUTME: Provides the main orchestrate() entry point called by RPC handlers.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { emit } from "../events.js";
import { needsRlm, processRlm, splitContentAndQuestion } from "./rlm.js";
import {
  selectRelevantTools,
  extractMcpPublisher,
  type OpenAITool,
} from "./tool-relevance.js";
import {
  route,
  isReroutableError,
  isContextOverflowError,
  isNetworkTransportError,
  getLargeContextFallback,
  getTimeoutFallback,
  rerouteOnFailure,
  MAX_REROUTE_ATTEMPTS,
  MAX_NETWORK_RETRIES,
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
  let sameModelRetryCount = 0;
  const MAX_SAME_MODEL_RETRIES = 1;
  let networkRetryCount = 0;

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

    // Extract publishers whose tools were called in recent conversation turns.
    // This feeds conversation-aware boosting (Phase 3) of tool relevance.
    const recentPublishers = extractRecentPublishers(history);

    // Select relevant tools via BM25 with model-aware budgets,
    // publisher-set scoping, and conversation-aware boosting.
    const relevantTools = selectRelevantTools(
      prompt,
      capabilities.tool_definitions as unknown as OpenAITool[],
      routing.model_id,
      recentPublishers,
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
      relevantTools,
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

      // ── Network transport errors ────────────────────────────────────
      // Connection refused, DNS, TLS, etc. should be retried on the
      // same model with exponential backoff -- rerouting won't help
      // since all models share the same gateway endpoint.
      if (isNetworkTransportError(errorMessage)) {
        networkRetryCount++;
        if (networkRetryCount <= MAX_NETWORK_RETRIES) {
          const backoffMs = 2 ** networkRetryCount * 1000; // 2s, 4s, 8s, 16s, 32s
          console.warn(
            `[Orchestrator] Network error (attempt ${networkRetryCount}/${MAX_NETWORK_RETRIES}), ` +
            `retrying in ${backoffMs}ms: ${errorMessage}`,
          );
          await sleep(backoffMs);
          continue;
        }
        console.error(
          `[Orchestrator] Network error persists after ${MAX_NETWORK_RETRIES} retries, giving up: ${errorMessage}`,
        );
        const errorEvent: WorkerEventError = { type: "error", message: errorMessage };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      // Reset network retry counter on non-network outcomes
      networkRetryCount = 0;

      // Check if this error is eligible for reroute
      if (!isReroutableError(errorMessage)) {
        const errorEvent: WorkerEventError = {
          type: "error",
          message: errorMessage,
        };
        emitOrchestratorEvent(conversationId, errorEvent);
        return;
      }

      // ── Context-overflow errors ─────────────────────────────────────
      // Reroute to a large-context model regardless of whether the user
      // explicitly selected a model.
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
          await sleep(1000);
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

      // ── User-selected model: timeout fallback chain ────────────────
      // For 408 timeouts: Opus -> Sonnet -> Haiku, then retry same model once.
      if (userExplicitlySelected) {
        const isTimeoutError =
          errorMessage.includes("408") || errorMessage.includes("Request Timeout");

        // Try cascading to a faster model on timeout (Opus -> Sonnet -> Haiku)
        if (isTimeoutError) {
          const fallback = getTimeoutFallback(routing.model_id);
          if (fallback) {
            const fromModel = routing.model_id;
            console.log(
              `[Orchestrator] 408 timeout on ${fromModel}, falling back to faster model: ${fallback}`,
            );

            const rerouteEvent: WorkerEventReroute = {
              type: "reroute",
              from_model: fromModel,
              to_model: fallback,
              reason: "Switched to faster model due to timeout",
            };
            emitOrchestratorEvent(conversationId, rerouteEvent);

            routing = { ...routing, model_id: fallback };
            triedModels.push(fallback);
            await sleep(2000);
            continue;
          }
        }

        // No faster model available, or non-timeout error: retry same model once
        if (sameModelRetryCount >= MAX_SAME_MODEL_RETRIES) {
          console.warn(
            `[Orchestrator] Transient error on explicitly-selected model ${routing.model_id} ` +
            `after ${sameModelRetryCount} retry, giving up: ${errorMessage}`,
          );
          const errorEvent: WorkerEventError = {
            type: "error",
            message: errorMessage,
          };
          emitOrchestratorEvent(conversationId, errorEvent);
          return;
        }

        sameModelRetryCount++;
        console.log(
          `[Orchestrator] Retrying explicitly-selected model ${routing.model_id} ` +
          `(attempt ${sameModelRetryCount}/${MAX_SAME_MODEL_RETRIES}): ${errorMessage}`,
        );
        await sleep(2000);
        continue;
      }

      // ── Auto-selected model: reroute to a different model ──────────
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
      await sleep(2000);
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
 * Prepends skill content and tool publisher inventory as system context
 * and appends images.
 */
function buildMessages(
  prompt: string,
  history: Array<{ role: string; content: string }>,
  skillContent: string,
  images: ImageAttachment[],
  routing: RoutingDecision,
  tools: OpenAITool[] = [],
): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [];

  // System prompt: base + tool inventory + skill content.
  // The tool inventory ensures the model knows about ALL connected services,
  // not just the skills matched by the classifier.
  const systemParts: string[] = ["You are a helpful AI assistant."];

  const toolInventory = buildToolInventory(tools);
  if (toolInventory) {
    systemParts.push(toolInventory);
  }

  if (skillContent) {
    systemParts.push(skillContent);
  }

  messages.push({ role: "system", content: systemParts.join("\n\n") });

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

/**
 * Build a tool publisher inventory from the actual tools being sent.
 *
 * Extracts publisher names from gateway/MCP tool naming conventions and
 * produces a system prompt section that tells the model exactly which
 * services it has access to. This prevents the model from denying access
 * to tools that are in its function definitions but not mentioned in the
 * Active Skills section.
 */
function buildToolInventory(tools: OpenAITool[]): string {
  const publisherTools = new Map<string, string[]>();
  const localTools: string[] = [];

  for (const tool of tools) {
    const name = tool.function?.name;
    if (!name) continue;

    const publisher = extractMcpPublisher(name);
    if (publisher) {
      if (!publisherTools.has(publisher)) {
        publisherTools.set(publisher, []);
      }
      publisherTools.get(publisher)!.push(name);
    } else {
      localTools.push(name);
    }
  }

  if (publisherTools.size === 0 && localTools.length === 0) {
    return "";
  }

  const lines: string[] = [
    "# Available Tools",
    "",
    "You have access to ALL tools listed in your function definitions. " +
    "Always check your available tools before saying you cannot perform an action.",
    "",
  ];

  if (publisherTools.size > 0) {
    lines.push("## Connected Services", "");

    // Sort for deterministic output.
    const sorted = [...publisherTools.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [publisher, pubTools] of sorted) {
      lines.push(`- **${publisher}** (${pubTools.length} tools)`);
    }
    lines.push("");
  }

  if (localTools.length > 0) {
    lines.push(
      `## Local Tools\n\n${localTools.length} core tools: ${localTools.join(", ")}`,
      "",
    );
  }

  return lines.join("\n");
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

  // ── Rule 0: Skill invocation ──────────────────────────────────────
  // The frontend wraps invoked skills in <skill-invocation> tags with
  // the full SKILL.md content inlined. This MUST be checked before any
  // keyword rules because the SKILL.md body contains code keywords,
  // numbered lists, and other patterns that would cause misclassification
  // and unwanted decomposition.
  if (prompt.includes("<skill-invocation")) {
    return {
      task_type: "skill_execution",
      requires_tools: true,
      requires_file_system: false,
      complexity: "simple",
      relevant_skills: relevantSkills,
    };
  }

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

  // Explicit publisher request signals (intentional phrases only)
  const publisherSignals = [
    "use publisher",
    "use publishers",
    "use the publisher",
    "use the publishers",
    "use any publisher",
    "use any of the publisher",
    "use any of the publishers",
    "with publisher",
    "with publishers",
    "using publisher",
    "using publishers",
    "via publisher",
    "via publishers",
  ];
  if (taskType === "general" && publisherSignals.some((s) => lower.includes(s))) {
    taskType = "research";
    requiresTools = true;
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
    "search for",
    "latest",
    "current",
    "recent",
    "developments",
    "find out",
  ];
  if (toolSignals.some((s) => lower.includes(s))) {
    requiresTools = true;
    if (taskType === "general") taskType = "research";
  }

  // Complexity estimation
  let complexity: "simple" | "moderate" | "complex" = "simple";
  const wordCount = prompt.split(/\s+/).length;
  if (wordCount > 200 || lower.includes("step by step") || lower.includes("detailed")) {
    complexity = "complex";
  } else if (wordCount > 50) {
    complexity = "moderate";
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

/** Promise-based sleep for exponential backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract unique publisher names from tool calls in recent conversation messages.
 * Scans assistant messages for tool_calls[].function.name and extracts publisher
 * names using the mcp__<publisher>__ / gateway__<publisher>__ convention.
 */
function extractRecentPublishers(
  history: Array<{ role: string; content: string }>,
): string[] {
  const publishers: string[] = [];
  const seen = new Set<string>();

  // Walk history in reverse (most recent first)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as Record<string, unknown>;
    if (msg.role !== "assistant") continue;

    const toolCalls = msg.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;
    if (!toolCalls) continue;

    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      const name = fn?.name as string | undefined;
      if (!name) continue;

      const publisher = extractMcpPublisher(name);
      if (publisher && !seen.has(publisher)) {
        seen.add(publisher);
        publishers.push(publisher);
      }
    }
  }

  return publishers;
}

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
