// ABOUTME: Memory service for storing and retrieving conversation memories.
// ABOUTME: Uses MCP JSON-RPC protocol against memory.serendb.com/mcp (via /memory proxy).

import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/bridge";
import { isServedByRuntime } from "@/lib/runtime-detect";
import { authStore } from "@/stores/auth.store";
import { projectStore } from "@/stores/project.store";
import { settingsStore } from "@/stores/settings.store";

// ── Types ───────────────────────────────────────────────────────────

export interface RecallResult {
  content: string;
  memory_type: string;
  relevance_score: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the memory service base URL.
 * When served by the runtime, use the /memory proxy (avoids CORS).
 * Otherwise call memory.serendb.com directly.
 */
function memoryBase(): string {
  if (isServedByRuntime()) {
    return `${window.location.origin}/memory`;
  }
  return "https://memory.serendb.com";
}

function isMemoryAvailable(): boolean {
  return settingsStore.get("memoryEnabled") && authStore.isAuthenticated;
}

function getProjectId(): string | null {
  return projectStore.activeProject?.id ?? null;
}

let mcpRpcId = 0;

/**
 * Call an MCP tool on the memory server via JSON-RPC.
 * Protocol: POST /mcp with { method: "tools/call", params: { name, arguments } }
 * Response may be JSON or SSE — handles both.
 */
async function callMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error("Not authenticated");

  const url = `${memoryBase()}/mcp`;
  const id = ++mcpRpcId;

  const resp = await appFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Memory MCP error ${resp.status}: ${body}`);
  }

  // Handle SSE or JSON response
  const contentType = resp.headers.get("Content-Type") ?? "";
  let data: { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };

  if (contentType.includes("text/event-stream")) {
    const text = await resp.text();
    let lastData: string | null = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") lastData = payload;
      }
    }
    if (!lastData) throw new Error("Memory MCP SSE response contained no data");
    data = JSON.parse(lastData);
  } else {
    data = await resp.json();
  }

  if (data.error) {
    throw new Error(data.error.message || "Memory MCP RPC error");
  }

  // Extract text from MCP tools/call response:
  // { result: { content: [{ type: "text", text: "..." }] } }
  return data.result?.content?.[0]?.text ?? "";
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Store a memory via the cloud MCP remember tool.
 */
export async function rememberMemory(
  content: string,
  memoryType: string = "semantic",
): Promise<string> {
  if (!isMemoryAvailable()) {
    throw new Error("Memory feature not available - enable it in settings");
  }

  const args: Record<string, unknown> = { content, memory_type: memoryType };
  const projectId = getProjectId();
  if (projectId) args.project_id = projectId;

  return await callMemoryTool("remember", args);
}

/**
 * Search memories via the cloud MCP recall tool.
 */
export async function recallMemories(
  query: string,
  limit = 5,
): Promise<RecallResult[]> {
  if (!isMemoryAvailable()) return [];

  try {
    const args: Record<string, unknown> = { query, limit };
    const projectId = getProjectId();
    if (projectId) args.project_id = projectId;

    const text = await callMemoryTool("recall", args);
    if (!text) return [];
    return JSON.parse(text) as RecallResult[];
  } catch {
    return [];
  }
}

/**
 * Sync local memory cache with cloud.
 * In the browser there is no local SQLite cache, so sync is a no-op.
 * The desktop uses SyncEngine (push/pull via REST) backed by a local DB.
 */
export async function syncMemories(): Promise<SyncResult | null> {
  // No local cache in the browser — nothing to push or pull.
  return null;
}

/**
 * Bootstrap memory context for system prompt injection.
 * Uses the MCP session_bootstrap tool.
 */
export async function bootstrapMemoryContext(): Promise<string | null> {
  if (!isMemoryAvailable()) return null;

  try {
    const args: Record<string, unknown> = {};
    const projectId = getProjectId();
    if (projectId) args.project_id = projectId;

    const text = await callMemoryTool("session_bootstrap", args);
    if (!text) return null;

    // session_bootstrap returns JSON with an assembled_prompt field
    try {
      const parsed = JSON.parse(text);
      return parsed.assembled_prompt ?? text;
    } catch {
      // If it's not JSON, use the text directly
      return text;
    }
  } catch {
    return null;
  }
}

/**
 * Store a conversation turn (user message + assistant response).
 */
export async function storeConversationTurn(
  userMessage: string,
  assistantMessage: string,
  context?: { model?: string; timestamp?: number },
): Promise<void> {
  if (!isMemoryAvailable()) return;

  const combinedContent = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
  const metadata = context ? `\n\nModel: ${context.model || "unknown"}` : "";

  try {
    await rememberMemory(`${combinedContent}${metadata}`, "semantic");
  } catch {
    // Best-effort
  }
}

/**
 * Store just an assistant response.
 */
export async function storeAssistantResponse(
  response: string,
  context?: { model?: string; userQuery?: string },
): Promise<void> {
  if (!isMemoryAvailable()) return;
  if (!response.trim()) return;

  const content = context?.userQuery
    ? `User: ${context.userQuery}\n\nAssistant: ${response}`
    : `Assistant: ${response}`;
  const metadata = context?.model ? `\n\nModel: ${context.model}` : "";

  try {
    await rememberMemory(`${content}${metadata}`, "semantic");
  } catch {
    // Best-effort
  }
}
