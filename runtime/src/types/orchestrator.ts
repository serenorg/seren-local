// ABOUTME: TypeScript equivalents of the Rust orchestrator types from seren-desktop.
// ABOUTME: Defines the data structures that flow between classifier, router, and workers
// ABOUTME: over the WebSocket bridge in the seren-local Node.js runtime.

// ---------------------------------------------------------------------------
// Enums (string literal unions matching Rust's serde rename_all = "snake_case")
// ---------------------------------------------------------------------------

/** The kind of worker the orchestrator routes a task to. */
export type WorkerType = "chat_model" | "local_agent" | "mcp_publisher";

/** How the orchestrator delegates work to the chosen worker. */
export type DelegationType = "in_loop" | "full_handoff";

/** Complexity bucket assigned during task classification. */
export type TaskComplexity = "simple" | "moderate" | "complex";

/** Lifecycle status of an orchestration plan. */
export type PlanStatus = "active" | "completed" | "cancelled" | "failed";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Lightweight skill metadata passed from the frontend for matching.
 *  The actual SKILL.md content is on disk — Rust reads it directly when needed. */
export interface SkillRef {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  path: string;
}

/** Task classification produced by the orchestrator's classifier. */
export interface TaskClassification {
  task_type: string;
  requires_tools: boolean;
  requires_file_system: boolean;
  complexity: TaskComplexity;
  relevant_skills: string[];
}

/** Routing decision made by the orchestrator. */
export interface RoutingDecision {
  worker_type: WorkerType;
  model_id: string;
  delegation: DelegationType;
  reason: string;
  selected_skills: SkillRef[];
  /** Publisher slug for McpPublisher worker (e.g. "firecrawl-serenai"). */
  publisher_slug?: string;
  /** Reasoning effort level forwarded from the frontend. */
  reasoning_effort?: string;
}

/** Image attachment passed from the frontend. */
export interface ImageAttachment {
  name: string;
  mime_type: string;
  base64: string;
}

/** User capabilities passed from the frontend per-request. */
export interface UserCapabilities {
  has_local_agent: boolean;
  agent_type?: string;
  /** The active local agent session ID, if one exists. Enables the local-agent
   *  fast-path to skip classification/decomposition when routing to the agent. */
  active_agent_session_id?: string;
  /** The model the user explicitly selected in the UI. */
  selected_model?: string;
  available_models: string[];
  available_tools: string[];
  /** Full OpenAI-format tool definitions from the frontend.
   *  ChatModelWorker passes these to the LLM for function calling. */
  tool_definitions: Record<string, unknown>[];
  installed_skills: SkillRef[];
  /** Pre-computed model rankings from Thompson sampling.
   *  Empty means no data; router falls back to hardcoded preference lists. */
  model_rankings: [string, number][];
  /** Reasoning effort level for models that support extended thinking.
   *  Values: "minimal", "low", "medium", "high", "xhigh". undefined = provider default. */
  reasoning_effort?: string;
}

/** Transition event emitted when the orchestrator switches models. */
export interface TransitionEvent {
  conversation_id: string;
  model_name: string;
  task_description: string;
}

/** A sub-task produced by the decomposer. */
export interface SubTask {
  id: string;
  prompt: string;
  classification: TaskClassification;
  /** IDs of sub-tasks that must complete before this one starts. */
  depends_on: string[];
}

/** An orchestration plan: the full set of sub-tasks for a prompt. */
export interface OrchestrationPlan {
  id: string;
  conversation_id: string;
  original_prompt: string;
  subtasks: SubTask[];
  status: PlanStatus;
  created_at: number;
}

// ---------------------------------------------------------------------------
// WorkerEvent — discriminated union (tagged by `type`, matching Rust's
// #[serde(tag = "type", rename_all = "snake_case")])
// ---------------------------------------------------------------------------

export interface WorkerEventContent {
  type: "content";
  text: string;
}

export interface WorkerEventThinking {
  type: "thinking";
  text: string;
}

export interface WorkerEventToolCall {
  type: "tool_call";
  tool_call_id: string;
  name: string;
  arguments: string;
  title: string;
}

export interface WorkerEventToolResult {
  type: "tool_result";
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

export interface WorkerEventDiff {
  type: "diff";
  path: string;
  old_text: string;
  new_text: string;
  tool_call_id?: string;
}

export interface WorkerEventComplete {
  type: "complete";
  final_content: string;
  thinking?: string;
  /** Total cost in SerenBucks for this worker's request, reported by Gateway. */
  cost?: number;
  /** JSON-encoded Vec<ChunkResult> set when RLM processed this response. */
  rlm_steps?: string;
}

export interface WorkerEventError {
  type: "error";
  message: string;
}

/** Emitted when a request is rerouted to a different model after a transient error. */
export interface WorkerEventReroute {
  type: "reroute";
  from_model: string;
  to_model: string;
  reason: string;
}

/** Emitted at the start of recursive language model processing. */
export interface WorkerEventRlmStart {
  type: "rlm_start";
  chunk_count: number;
}

/** Emitted when one chunk has been processed during RLM. */
export interface WorkerEventRlmChunkComplete {
  type: "rlm_chunk_complete";
  index: number;
  total: number;
  summary: string;
}

/** Events streamed from a worker back to the orchestrator. */
export type WorkerEvent =
  | WorkerEventContent
  | WorkerEventThinking
  | WorkerEventToolCall
  | WorkerEventToolResult
  | WorkerEventDiff
  | WorkerEventComplete
  | WorkerEventError
  | WorkerEventReroute
  | WorkerEventRlmStart
  | WorkerEventRlmChunkComplete;

// ---------------------------------------------------------------------------
// OrchestratorEvent — wrapper sent to the frontend over WebSocket
// ---------------------------------------------------------------------------

/** Wrapper for worker events sent to the frontend with conversation context. */
export interface OrchestratorEvent {
  conversation_id: string;
  worker_event: WorkerEvent;
  subtask_id?: string;
}
