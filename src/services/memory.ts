// ABOUTME: Memory service for storing and retrieving conversation memories.
// ABOUTME: Lightweight stub wrapping API calls with authentication and project context.

import { API_BASE } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/bridge";
import { authStore } from "@/stores/auth.store";
import { projectStore } from "@/stores/project.store";
import { settingsStore } from "@/stores/settings.store";

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

/**
 * Check if memory feature is enabled and user is authenticated.
 */
function isMemoryAvailable(): boolean {
  return settingsStore.get("memoryEnabled") && authStore.isAuthenticated;
}

/**
 * Get the current project ID for memory operations.
 */
function getProjectId(): string | null {
  return projectStore.activeProject?.id ?? null;
}

/**
 * Store a memory to the cloud (and local cache).
 * Automatically includes project context if available.
 */
export async function rememberMemory(
  content: string,
  memoryType: string = "semantic",
): Promise<string> {
  if (!isMemoryAvailable()) {
    throw new Error("Memory feature not available - enable it in settings");
  }

  const token = await getToken();
  if (!token) throw new Error("Not authenticated");

  const projectId = getProjectId();

  const resp = await appFetch(`${API_BASE}/memory/remember`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, memory_type: memoryType, project_id: projectId }),
  });

  if (!resp.ok) {
    throw new Error(`Memory remember failed: ${resp.status}`);
  }

  const json = await resp.json();
  return json.data?.id ?? "";
}

/**
 * Search for memories matching a query.
 */
export async function recallMemories(
  query: string,
  limit = 5,
): Promise<RecallResult[]> {
  if (!isMemoryAvailable()) {
    return [];
  }

  const token = await getToken();
  if (!token) return [];

  const projectId = getProjectId();

  try {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (projectId) params.set("project_id", projectId);

    const resp = await appFetch(`${API_BASE}/memory/recall?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) return [];
    const json = await resp.json();
    return json.data ?? [];
  } catch (error) {
    console.warn("[Memory] Failed to recall memories:", error);
    return [];
  }
}

/**
 * Sync local memory cache with cloud.
 * Pushes pending memories and pulls new ones.
 */
export async function syncMemories(): Promise<SyncResult | null> {
  if (!isMemoryAvailable()) {
    return null;
  }

  const token = await getToken();
  if (!token) return null;

  const userId = authStore.user?.id ?? null;
  const projectId = getProjectId();

  try {
    const resp = await appFetch(`${API_BASE}/memory/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId, project_id: projectId }),
    });

    if (!resp.ok) return null;
    const json = await resp.json();
    return json.data ?? null;
  } catch {
    // Memory sync is best-effort — endpoint may not exist yet
    return null;
  }
}

/**
 * Bootstrap memory context for system prompt injection.
 * This is called automatically in chat.ts.
 */
export async function bootstrapMemoryContext(): Promise<string | null> {
  if (!isMemoryAvailable()) {
    return null;
  }

  const token = await getToken();
  if (!token) return null;

  const projectId = getProjectId();

  try {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);

    const resp = await appFetch(`${API_BASE}/memory/bootstrap?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) return null;
    const json = await resp.json();
    return json.data ?? null;
  } catch (error) {
    console.warn("[Memory] Failed to bootstrap memory context:", error);
    return null;
  }
}

/**
 * Store a conversation turn (user message + assistant response).
 * This should be called after each completed assistant response.
 */
export async function storeConversationTurn(
  userMessage: string,
  assistantMessage: string,
  context?: { model?: string; timestamp?: number },
): Promise<void> {
  if (!isMemoryAvailable()) {
    return;
  }

  const combinedContent = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
  const metadata = context ? `\n\nModel: ${context.model || "unknown"}` : "";

  try {
    await rememberMemory(`${combinedContent}${metadata}`, "semantic");
  } catch (error) {
    console.error("[Memory] Failed to store conversation turn:", error);
  }
}

/**
 * Convenience function to store just an assistant response.
 */
export async function storeAssistantResponse(
  response: string,
  context?: { model?: string; userQuery?: string },
): Promise<void> {
  if (!isMemoryAvailable()) {
    return;
  }

  if (!response.trim()) {
    return;
  }

  const content = context?.userQuery
    ? `User: ${context.userQuery}\n\nAssistant: ${response}`
    : `Assistant: ${response}`;

  const metadata = context?.model ? `\n\nModel: ${context.model}` : "";

  try {
    await rememberMemory(`${content}${metadata}`, "semantic");
  } catch (error) {
    console.error("[Memory] Failed to store assistant response:", error);
  }
}
