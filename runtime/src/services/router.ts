// ABOUTME: Bootstrap router that maps task classifications to worker routing decisions.
// ABOUTME: TypeScript port of the Rust orchestrator router from seren-desktop.
// ABOUTME: Selects worker type, model, and delegation level based on user capabilities.

import type {
  RoutingDecision,
  SkillRef,
  TaskClassification,
  UserCapabilities,
  WorkerType,
  DelegationType,
} from "../types/orchestrator.js";

// ---------------------------------------------------------------------------
// Model preference lists (ordered by priority)
// ---------------------------------------------------------------------------

/** Preferred models for code tasks (ordered by capability). */
const CODE_PREFERRED_MODELS: string[] = [
  "anthropic/claude-opus-4-6",
  "openai/gpt-5.3",
];

/** Preferred models for simple Q&A (ordered by speed/cost). */
const SIMPLE_PREFERRED_MODELS: string[] = [
  "minimax/minimax-m2.5",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4.5",
  "moonshot/kimi-k2.5",
  "thudm/glm-4.7",
  "anthropic/claude-sonnet-4",
];

/** Fallback models for context-overflow errors (all have 1M+ token windows). */
export const LARGE_CONTEXT_FALLBACK_MODELS: string[] = [
  "google/gemini-3.1-pro-preview",
  "google/gemini-3-flash-preview",
  "anthropic/claude-opus-4.6",
];

/** HTTP status codes that indicate a transient failure eligible for model reroute. */
const REROUTABLE_STATUS_CODES: number[] = [408, 429, 502, 503, 504];

/** Maximum number of reroute attempts before giving up. */
export const MAX_REROUTE_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Human-readable names
// ---------------------------------------------------------------------------

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "anthropic/claude-opus-4-6": "Claude Opus",
  "anthropic/claude-opus-4.5": "Claude Opus",
  "anthropic/claude-sonnet-4": "Claude Sonnet",
  "anthropic/claude-haiku-4.5": "Claude Haiku",
  "openai/gpt-5.3": "GPT-5.3",
  "openai/gpt-5": "GPT-5",
  "openai/gpt-4o": "GPT-4o",
  "openai/gpt-4o-mini": "GPT-4o Mini",
  "anthropic/claude-opus-4.6": "Claude Opus 4.6",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "google/gemini-2.5-pro": "Gemini Pro",
  "google/gemini-2.5-flash": "Gemini Flash",
  "google/gemini-3-flash-preview": "Gemini 3 Flash",
  "moonshot/kimi-k2.5": "Kimi K2.5",
  "thudm/glm-4.7": "GLM-4.7",
  "thudm/glm-4": "GLM-4",
};

function humanizeModelId(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

function humanizeTaskType(taskType: string): string {
  return taskType.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route a classified task to the appropriate worker.
 *
 * Bootstrap routing logic:
 * 1. Code generation + file system + local agent available → LocalAgent
 * 2. Requires tools + gateway tools available → McpPublisher
 * 3. Default → ChatModel
 *
 * Model selection priority:
 * 1. User's explicit selection from the UI
 * 2. Thompson sampling rankings (pre-computed by frontend)
 * 3. Hardcoded preference lists (cold start fallback)
 */
export function route(
  classification: TaskClassification,
  capabilities: UserCapabilities,
  query: string,
): RoutingDecision {
  const workerType = selectWorkerType(classification, capabilities);
  const modelId = selectModel(classification, capabilities);
  const selectedSkills = resolveSkills(classification, capabilities);
  const reason = buildReason(classification, workerType, modelId);
  const publisherSlug = extractPublisherSlug(workerType, capabilities, query);

  const delegation: DelegationType =
    workerType === "local_agent" ? "full_handoff" : "in_loop";

  return {
    worker_type: workerType,
    model_id: modelId,
    delegation,
    reason,
    selected_skills: selectedSkills,
    publisher_slug: publisherSlug,
    reasoning_effort: capabilities.reasoning_effort,
  };
}

// ---------------------------------------------------------------------------
// Worker type selection
// ---------------------------------------------------------------------------

/**
 * Select the worker type based on task requirements and available capabilities.
 */
function selectWorkerType(
  classification: TaskClassification,
  capabilities: UserCapabilities,
): WorkerType {
  // Code generation with file system access + active local agent → LocalAgent
  if (
    classification.task_type === "code_generation" &&
    classification.requires_file_system &&
    capabilities.has_local_agent &&
    capabilities.active_agent_session_id
  ) {
    return "local_agent";
  }

  // Non-file-system tasks requiring tools + a valid gateway publisher → McpPublisher
  // gateway__ = remote Seren publishers (Firecrawl, Perplexity, etc.)
  // mcp__    = local MCP servers — NOT routable to McpPublisher
  if (
    classification.requires_tools &&
    !classification.requires_file_system &&
    hasAnyGatewayTool(capabilities)
  ) {
    return "mcp_publisher";
  }

  // Everything else → ChatModel
  return "chat_model";
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Select the best available model for the task.
 *
 * Priority:
 * 1. User's explicit selection from the UI
 * 2. Thompson sampling rankings (satisfaction-driven)
 * 3. Hardcoded preference lists (cold start fallback)
 */
function selectModel(
  classification: TaskClassification,
  capabilities: UserCapabilities,
): string {
  // 1. Respect user's explicit model selection
  if (capabilities.selected_model) {
    return capabilities.selected_model;
  }

  // 2. Use satisfaction-driven rankings when available
  if (capabilities.model_rankings.length > 0) {
    for (const [modelId] of capabilities.model_rankings) {
      if (capabilities.available_models.includes(modelId)) {
        return modelId;
      }
    }
  }

  // 3. Fallback to hardcoded preference lists (cold start)
  let preferred: string[];
  if (classification.task_type === "code_generation") {
    preferred = CODE_PREFERRED_MODELS;
  } else if (
    classification.complexity === "complex" ||
    classification.complexity === "moderate"
  ) {
    preferred = CODE_PREFERRED_MODELS;
  } else {
    preferred = SIMPLE_PREFERRED_MODELS;
  }

  // Find the first preferred model that's available
  for (const model of preferred) {
    if (capabilities.available_models.includes(model)) {
      return model;
    }
  }

  // Fallback: first available model, or a sensible default
  return capabilities.available_models[0] ?? "anthropic/claude-sonnet-4";
}

// ---------------------------------------------------------------------------
// Gateway slug parsing
// ---------------------------------------------------------------------------

/**
 * Parse a gateway tool name into its publisher slug.
 * Gateway tool names follow: `gateway__<publisher-slug>__<tool-name>`.
 */
export function parseGatewaySlug(toolName: string): string | null {
  if (!toolName.startsWith("gateway__")) return null;
  const rest = toolName.slice("gateway__".length);
  const slugEnd = rest.indexOf("__");
  if (slugEnd === -1) return null;
  return rest.slice(0, slugEnd);
}

/** Check if any gateway tool exists in the available tools. */
function hasAnyGatewayTool(capabilities: UserCapabilities): boolean {
  return capabilities.available_tools.some((t) => parseGatewaySlug(t) !== null);
}

/**
 * Extract the most relevant publisher slug from available gateway tools
 * based on the user's query. Falls back to the first gateway slug.
 */
function extractGatewaySlug(
  capabilities: UserCapabilities,
  query: string,
): string | undefined {
  // Collect all unique publisher slugs and their tool names
  const slugTools = new Map<string, string[]>();
  for (const toolName of capabilities.available_tools) {
    const slug = parseGatewaySlug(toolName);
    if (slug) {
      if (!slugTools.has(slug)) slugTools.set(slug, []);
      slugTools.get(slug)!.push(toolName);
    }
  }

  if (slugTools.size === 0) return undefined;
  if (slugTools.size === 1) return slugTools.keys().next().value!;

  // Score each publisher by how many of its tool names match query terms
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (queryTerms.length === 0) return slugTools.keys().next().value!;

  let bestSlug: string | undefined;
  let bestScore = 0;

  for (const [slug, tools] of slugTools) {
    let score = 0;
    const slugLower = slug.toLowerCase();

    for (const term of queryTerms) {
      if (slugLower.includes(term)) score += 10;
    }
    for (const toolName of tools) {
      const toolLower = toolName.toLowerCase();
      for (const term of queryTerms) {
        if (toolLower.includes(term)) score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSlug = slug;
    }
  }

  return bestSlug ?? slugTools.keys().next().value!;
}

/**
 * Extract the publisher slug only when the worker type is McpPublisher.
 */
function extractPublisherSlug(
  workerType: WorkerType,
  capabilities: UserCapabilities,
  query: string,
): string | undefined {
  if (workerType !== "mcp_publisher") return undefined;
  return extractGatewaySlug(capabilities, query);
}

// ---------------------------------------------------------------------------
// Skill resolution
// ---------------------------------------------------------------------------

/** Resolve skill slugs from the classification to full SkillRef objects. */
function resolveSkills(
  classification: TaskClassification,
  capabilities: UserCapabilities,
): SkillRef[] {
  return classification.relevant_skills
    .map((slug) => capabilities.installed_skills.find((s) => s.slug === slug))
    .filter((s): s is SkillRef => s !== undefined);
}

// ---------------------------------------------------------------------------
// Reason string
// ---------------------------------------------------------------------------

/** Build a human-readable reason string for the transition announcement. */
function buildReason(
  classification: TaskClassification,
  workerType: WorkerType,
  modelId: string,
): string {
  const modelName = humanizeModelId(modelId);
  const taskDesc = humanizeTaskType(classification.task_type);

  switch (workerType) {
    case "local_agent":
      return `Working with agent on ${taskDesc}`;
    case "mcp_publisher":
      return `Working with publisher on ${taskDesc}`;
    case "chat_model":
    default:
      return `Working with ${modelName} on ${taskDesc}`;
  }
}

// ---------------------------------------------------------------------------
// Reroutable error detection
// ---------------------------------------------------------------------------

/** Check whether an error message indicates a context overflow. */
export function isContextOverflowError(errorMessage: string): boolean {
  return (
    errorMessage.includes("prompt is too long") ||
    errorMessage.includes("context_length_exceeded") ||
    errorMessage.includes("maximum context length")
  );
}

/**
 * Check whether an error message indicates a transient failure eligible
 * for model reroute (408/429/5xx or context overflow).
 */
export function isReroutableError(errorMessage: string): boolean {
  // Context-overflow errors are always reroutable
  if (isContextOverflowError(errorMessage)) return true;

  // Don't reroute auth or client errors
  if (
    errorMessage.includes("401") ||
    errorMessage.includes("403") ||
    errorMessage.includes("400") ||
    errorMessage.includes("API key") ||
    errorMessage.includes("Insufficient credits")
  ) {
    return false;
  }

  return REROUTABLE_STATUS_CODES.some((code) =>
    errorMessage.includes(String(code)),
  );
}

/** Pick the first large-context fallback model not yet tried. */
export function getLargeContextFallback(
  triedModels: string[],
): string | undefined {
  return LARGE_CONTEXT_FALLBACK_MODELS.find((m) => !triedModels.includes(m));
}

/**
 * Select a fallback model after a transient failure.
 * Uses hardcoded preference lists, excluding already-tried models.
 * Returns [modelId, reason] or undefined.
 */
export function rerouteOnFailure(
  classification: TaskClassification,
  triedModels: string[],
  availableModels: string[],
): [string, string] | undefined {
  const preferred =
    classification.task_type === "code_generation" ||
    classification.complexity === "complex" ||
    classification.complexity === "moderate"
      ? CODE_PREFERRED_MODELS
      : SIMPLE_PREFERRED_MODELS;

  for (const model of preferred) {
    if (!triedModels.includes(model) && availableModels.includes(model)) {
      const reason = `Rerouted to ${humanizeModelId(model)} for ${humanizeTaskType(classification.task_type)}`;
      return [model, reason];
    }
  }

  // Last resort: any untried available model
  for (const model of availableModels) {
    if (!triedModels.includes(model)) {
      const reason = `Rerouted to ${humanizeModelId(model)} (fallback)`;
      return [model, reason];
    }
  }

  return undefined;
}
