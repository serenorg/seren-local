// ABOUTME: Browser-native bridge replacing tauri-bridge.ts.
// ABOUTME: Routes storage to localStorage/IndexedDB, file ops to local runtime via WebSocket.

import { createSignal } from "solid-js";

// ============================================================================
// Types
// ============================================================================

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  selected_model: string | null;
  selected_provider: string | null;
  project_root: string | null;
  is_archived: boolean;
}

export interface StoredMessage {
  id: string;
  conversation_id: string | null;
  role: string;
  content: string;
  model: string | null;
  timestamp: number;
  metadata: string | null;
}

/**
 * An agent conversation stored locally (IndexedDB or runtime SQLite).
 */
export interface AgentConversation {
  id: string;
  title: string;
  created_at: number;
  agent_type: string;
  agent_session_id: string | null;
  agent_cwd: string | null;
  agent_model_id: string | null;
  agent_metadata: string | null;
  project_id: string | null;
  project_root: string | null;
  is_archived: boolean;
}

export interface SignX402Response {
  headerName: string;
  headerValue: string;
  x402Version: number;
}

export interface UsdcBalanceResponse {
  balance: string;
  balanceRaw: string;
  network: string;
}

// ============================================================================
// Constants
// ============================================================================

const TOKEN_KEY = "seren_token";
const REFRESH_TOKEN_KEY = "seren_refresh_token";
const API_KEY_KEY = "seren_api_key";
const ORG_ID_KEY = "seren_default_org_id";
const PROVIDER_KEY_PREFIX = "seren_provider_key_";
const OAUTH_PREFIX = "seren_oauth_";

const DB_NAME = "seren";
const DB_VERSION = 1;
const CONVERSATIONS_STORE = "conversations";
const MESSAGES_STORE = "messages";

const RPC_TIMEOUT_MS = 30_000;

/**
 * Resolve the runtime HTTP and WS URLs.
 * When served by the runtime, use the same origin (works for any host/port).
 * Otherwise fall back to localhost:19420 for dev/CDN scenarios.
 */
function resolveRuntimeUrls(): { http: string; ws: string } {
  if (typeof window !== "undefined") {
    // Check for runtime-injected meta tag (definitive detection)
    const meta = document.querySelector('meta[name="seren-runtime-token"]');
    if (meta) {
      const origin = window.location.origin;
      const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return {
        http: origin,
        ws: `${wsProto}//${window.location.host}`,
      };
    }
  }
  // Fallback for dev server or CDN-hosted SPA
  return { http: "http://127.0.0.1:19420", ws: "ws://127.0.0.1:19420" };
}

const { http: RUNTIME_HTTP_URL, ws: RUNTIME_WS_URL } = resolveRuntimeUrls();

// ============================================================================
// Runtime connection (WebSocket JSON-RPC with token auth)
// ============================================================================

let ws: WebSocket | null = null;
let rpcId = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 30_000;
const pendingRpc = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

// Reactive signal for runtime connection state
const [runtimeConnected, setRuntimeConnected] = createSignal(false);

export function isRuntimeConnected(): boolean {
  return runtimeConnected();
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  reconnectAttempt++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const connected = await connectToRuntime();
    if (connected) {
      reconnectAttempt = 0;
      // Notify listeners that runtime reconnected
      const listeners = eventListeners.get("runtime:connected");
      if (listeners) {
        for (const cb of listeners) cb(null);
      }
    } else {
      scheduleReconnect();
    }
  }, delay);
}

/**
 * Read the build hash injected by the server into the HTML meta tag.
 */
function getEmbeddedBuildHash(): string | null {
  const meta = document.querySelector('meta[name="seren-build-hash"]');
  return meta?.getAttribute("content") ?? null;
}

/**
 * Get the auth token for the runtime WebSocket connection.
 *
 * Primary: read from `<meta name="seren-runtime-token">` injected by the
 * runtime into served HTML. This works for any host/port (remote or local).
 *
 * Fallback: fetch from /health endpoint (dev server scenario where the SPA
 * is served by Vite but the runtime is running separately on localhost).
 */
async function fetchRuntimeToken(): Promise<string | null> {
  // Primary: meta tag (same-origin, no network request)
  const meta = document.querySelector('meta[name="seren-runtime-token"]');
  const metaToken = meta?.getAttribute("content") ?? null;
  if (metaToken) {
    // Still check for stale SPA via build hash
    await checkStaleSpa();
    return metaToken;
  }

  // Fallback: /health endpoint (dev mode — SPA on Vite, runtime on localhost)
  try {
    const res = await fetch(`${RUNTIME_HTTP_URL}/health`);
    if (!res.ok) return null;
    const data = await res.json();
    await checkStaleSpa(data.buildHash);
    return data.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare build hashes and force-reload if the SPA is stale.
 * When called with a server hash, uses that; otherwise fetches from /health.
 */
async function checkStaleSpa(serverHash?: string): Promise<void> {
  const embeddedHash = getEmbeddedBuildHash();
  if (!embeddedHash) return;

  let remoteHash = serverHash;
  if (!remoteHash) {
    try {
      const res = await fetch(`${RUNTIME_HTTP_URL}/health`);
      if (res.ok) {
        const data = await res.json();
        remoteHash = data.buildHash;
      }
    } catch { /* ignore */ }
  }

  if (remoteHash && remoteHash !== embeddedHash) {
    console.log("[Bridge] Stale SPA detected — forcing reload", {
      server: remoteHash,
      embedded: embeddedHash,
    });
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    window.location.reload();
  }
}

export async function connectToRuntime(): Promise<boolean> {
  if (isRuntimeConnected()) return true;

  // Step 1: Fetch auth token from runtime health endpoint
  const token = await fetchRuntimeToken();
  if (!token) return false;

  // Step 2: Connect WebSocket and authenticate
  return new Promise<boolean>((resolve) => {
    try {
      const socket = new WebSocket(RUNTIME_WS_URL);
      const timeout = setTimeout(() => {
        socket.close();
        resolve(false);
      }, 5000);

      socket.addEventListener("open", () => {
        // Send auth message as first message
        const authId = ++rpcId;
        pendingRpc.set(authId, {
          resolve: () => {
            clearTimeout(timeout);
            ws = socket;
            setRuntimeConnected(true);
            resolve(true);
          },
          reject: () => {
            clearTimeout(timeout);
            socket.close();
            resolve(false);
          },
        });
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "auth",
            params: { token },
            id: authId,
          }),
        );
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      socket.addEventListener("close", () => {
        const wasConnected = ws === socket;
        ws = null;
        setRuntimeConnected(false);
        // Reject all pending RPCs
        for (const [, rpc] of pendingRpc) {
          rpc.reject(new Error("Runtime connection closed"));
        }
        pendingRpc.clear();
        // Auto-reconnect if we were previously connected
        if (wasConnected) {
          scheduleReconnect();
        }
      });

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data));
          // JSON-RPC response
          if (data.id != null && pendingRpc.has(data.id)) {
            const rpc = pendingRpc.get(data.id)!;
            pendingRpc.delete(data.id);
            if (data.error) {
              rpc.reject(new Error(data.error.message || "RPC error"));
            } else {
              rpc.resolve(data.result);
            }
          }
          // Event notification (no id)
          if (data.method && data.id == null) {
            const listeners = eventListeners.get(data.method);
            if (listeners) {
              for (const cb of listeners) cb(data.params);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });
    } catch {
      resolve(false);
    }
  });
}

export function disconnectRuntime(): void {
  // Cancel any pending reconnect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  if (ws) {
    ws.close();
    ws = null;
    setRuntimeConnected(false);
  }
}

function requireRuntime(): void {
  if (!isRuntimeConnected()) {
    throw new Error("This operation requires the local runtime to be running");
  }
}

export function runtimeInvoke<T>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number | null },
): Promise<T> {
  requireRuntime();
  const id = ++rpcId;
  const timeoutMs = options?.timeoutMs === undefined ? RPC_TIMEOUT_MS : options.timeoutMs;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
    }

    pendingRpc.set(id, {
      resolve: (v) => {
        if (timer) clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      },
    });

    ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

export function onRuntimeEvent(
  event: string,
  callback: (payload: unknown) => void,
): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }
  eventListeners.get(event)?.add(callback);
  return () => {
    eventListeners.get(event)?.delete(callback);
  };
}

// ============================================================================
// Token storage (localStorage)
// ============================================================================

export async function storeToken(token: string): Promise<void> {
  localStorage.setItem(TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return localStorage.getItem(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  localStorage.removeItem(TOKEN_KEY);
}

export async function storeRefreshToken(token: string): Promise<void> {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export async function getRefreshToken(): Promise<string | null> {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export async function clearRefreshToken(): Promise<void> {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

// ============================================================================
// API key / org ID (localStorage)
// ============================================================================

export async function storeSerenApiKey(apiKey: string): Promise<void> {
  localStorage.setItem(API_KEY_KEY, apiKey);
}

export async function getSerenApiKey(): Promise<string | null> {
  return localStorage.getItem(API_KEY_KEY);
}

export async function clearSerenApiKey(): Promise<void> {
  localStorage.removeItem(API_KEY_KEY);
}

export async function storeDefaultOrganizationId(orgId: string): Promise<void> {
  localStorage.setItem(ORG_ID_KEY, orgId);
}

export async function getDefaultOrganizationId(): Promise<string | null> {
  return localStorage.getItem(ORG_ID_KEY);
}

export async function clearDefaultOrganizationId(): Promise<void> {
  localStorage.removeItem(ORG_ID_KEY);
}

// ============================================================================
// Provider keys (localStorage with prefix)
// ============================================================================

export async function storeProviderKey(
  provider: string,
  apiKey: string,
): Promise<void> {
  localStorage.setItem(`${PROVIDER_KEY_PREFIX}${provider}`, apiKey);
}

export async function getProviderKey(provider: string): Promise<string | null> {
  return localStorage.getItem(`${PROVIDER_KEY_PREFIX}${provider}`);
}

export async function clearProviderKey(provider: string): Promise<void> {
  localStorage.removeItem(`${PROVIDER_KEY_PREFIX}${provider}`);
}

export async function getConfiguredProviders(): Promise<string[]> {
  const providers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PROVIDER_KEY_PREFIX)) {
      providers.push(key.slice(PROVIDER_KEY_PREFIX.length));
    }
  }
  return providers;
}

// ============================================================================
// OAuth credentials (localStorage with prefix)
// ============================================================================

export async function storeOAuthCredentials(
  provider: string,
  credentials: string,
): Promise<void> {
  localStorage.setItem(`${OAUTH_PREFIX}${provider}`, credentials);
}

export async function getOAuthCredentials(
  provider: string,
): Promise<string | null> {
  return localStorage.getItem(`${OAUTH_PREFIX}${provider}`);
}

export async function clearOAuthCredentials(provider: string): Promise<void> {
  localStorage.removeItem(`${OAUTH_PREFIX}${provider}`);
}

export async function getOAuthProviders(): Promise<string[]> {
  const providers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(OAUTH_PREFIX)) {
      providers.push(key.slice(OAUTH_PREFIX.length));
    }
  }
  return providers;
}

// ============================================================================
// File system operations (require local runtime)
// ============================================================================

export async function listDirectory(path: string): Promise<FileEntry[]> {
  requireRuntime();
  return runtimeInvoke<FileEntry[]>("list_directory", { path });
}

export async function readFile(path: string): Promise<string> {
  requireRuntime();
  return runtimeInvoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  requireRuntime();
  await runtimeInvoke<void>("write_file", { path, content });
}

export async function pathExists(path: string): Promise<boolean> {
  requireRuntime();
  return runtimeInvoke<boolean>("path_exists", { path });
}

export async function isDirectory(path: string): Promise<boolean> {
  requireRuntime();
  return runtimeInvoke<boolean>("is_directory", { path });
}

export async function createFile(
  path: string,
  content?: string,
): Promise<void> {
  requireRuntime();
  await runtimeInvoke<void>("create_file", { path, content });
}

export async function createDirectory(path: string): Promise<void> {
  requireRuntime();
  await runtimeInvoke<void>("create_directory", { path });
}

export async function deletePath(path: string): Promise<void> {
  requireRuntime();
  await runtimeInvoke<void>("delete_path", { path });
}

export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  requireRuntime();
  await runtimeInvoke<void>("rename_path", { oldPath, newPath });
}

// ============================================================================
// Crypto wallet (require local runtime)
// ============================================================================

export async function storeCryptoPrivateKey(
  privateKey: string,
): Promise<string> {
  requireRuntime();
  return runtimeInvoke<string>("store_crypto_private_key", { privateKey });
}

export async function getCryptoWalletAddress(): Promise<string | null> {
  requireRuntime();
  return runtimeInvoke<string | null>("get_crypto_wallet_address");
}

export async function clearCryptoWallet(): Promise<void> {
  requireRuntime();
  await runtimeInvoke<void>("clear_crypto_wallet");
}

export async function signX402Payment(
  requirementsJson: string,
): Promise<SignX402Response> {
  requireRuntime();
  return runtimeInvoke<SignX402Response>("sign_x402_payment", {
    requirementsJson,
  });
}

export async function getCryptoUsdcBalance(): Promise<UsdcBalanceResponse> {
  requireRuntime();
  return runtimeInvoke<UsdcBalanceResponse>("get_crypto_usdc_balance");
}

// ============================================================================
// IndexedDB conversation storage
// ============================================================================

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const msgStore = db.createObjectStore(MESSAGES_STORE, {
          keyPath: "id",
        });
        msgStore.createIndex("conversation_id", "conversation_id", {
          unique: false,
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function createConversation(
  id: string,
  title: string,
  selectedModel?: string,
  selectedProvider?: string,
  projectRoot?: string,
): Promise<Conversation> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<Conversation>("create_conversation", {
      id,
      title,
      selectedModel,
      selectedProvider,
      projectRoot,
    });
  }

  const db = await openDB();
  const conv: Conversation = {
    id,
    title,
    created_at: Date.now(),
    selected_model: selectedModel ?? null,
    selected_provider: selectedProvider ?? null,
    project_root: projectRoot ?? null,
    is_archived: false,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(CONVERSATIONS_STORE).put(conv);
    tx.oncomplete = () => {
      db.close();
      resolve(conv);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getConversations(): Promise<Conversation[]> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<Conversation[]>("get_conversations");
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATIONS_STORE, "readonly");
    const request = tx.objectStore(CONVERSATIONS_STORE).getAll();
    request.onsuccess = () => {
      db.close();
      const all = request.result as Conversation[];
      const active = all
        .filter((c) => !c.is_archived)
        .sort((a, b) => b.created_at - a.created_at);
      resolve(active);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<Conversation | null>("get_conversation", { id });
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATIONS_STORE, "readonly");
    const request = tx.objectStore(CONVERSATIONS_STORE).get(id);
    request.onsuccess = () => {
      db.close();
      resolve((request.result as Conversation) ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function updateConversation(
  id: string,
  title?: string,
  selectedModel?: string,
  selectedProvider?: string,
): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("update_conversation", {
      id,
      title,
      selectedModel,
      selectedProvider,
    });
    return;
  }

  const existing = await getConversation(id);
  if (!existing) return;

  const updated: Conversation = {
    ...existing,
    ...(title !== undefined && { title }),
    ...(selectedModel !== undefined && { selected_model: selectedModel }),
    ...(selectedProvider !== undefined && {
      selected_provider: selectedProvider,
    }),
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(CONVERSATIONS_STORE).put(updated);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function archiveConversation(id: string): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("archive_conversation", { id });
    return;
  }

  const existing = await getConversation(id);
  if (!existing) return;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(CONVERSATIONS_STORE).put({ ...existing, is_archived: true });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deleteConversation(id: string): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("delete_conversation", { id });
    return;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [CONVERSATIONS_STORE, MESSAGES_STORE],
      "readwrite",
    );
    tx.objectStore(CONVERSATIONS_STORE).delete(id);

    // Delete all messages for this conversation
    const msgStore = tx.objectStore(MESSAGES_STORE);
    const index = msgStore.index("conversation_id");
    const cursor = index.openCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      const result = cursor.result;
      if (result) {
        result.delete();
        result.continue();
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function saveMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  model: string | null,
  timestamp: number,
  metadata?: string | null,
): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("save_message", {
      id,
      conversationId,
      role,
      content,
      model,
      timestamp,
      metadata,
    });
    return;
  }

  const msg: StoredMessage = {
    id,
    conversation_id: conversationId,
    role,
    content,
    model,
    timestamp,
    metadata: metadata ?? null,
  };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readwrite");
    tx.objectStore(MESSAGES_STORE).put(msg);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getMessages(
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<StoredMessage[]>("get_messages", {
      conversationId,
      limit,
    });
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readonly");
    const index = tx.objectStore(MESSAGES_STORE).index("conversation_id");
    const request = index.getAll(IDBKeyRange.only(conversationId));
    request.onsuccess = () => {
      db.close();
      const msgs = (request.result as StoredMessage[]).sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      resolve(msgs.slice(0, limit));
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function clearConversationHistory(
  conversationId: string,
): Promise<void> {
  // clearConversationHistory is equivalent to deleting all messages for a conversation.
  // The runtime doesn't have a dedicated handler, so we use delete + recreate pattern
  // via the existing deleteConversation which also deletes messages.
  // For now, only IndexedDB supports this granular operation.
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readwrite");
    const index = tx.objectStore(MESSAGES_STORE).index("conversation_id");
    const cursor = index.openCursor(IDBKeyRange.only(conversationId));
    cursor.onsuccess = () => {
      const result = cursor.result;
      if (result) {
        result.delete();
        result.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function clearAllHistory(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [CONVERSATIONS_STORE, MESSAGES_STORE],
      "readwrite",
    );
    tx.objectStore(CONVERSATIONS_STORE).clear();
    tx.objectStore(MESSAGES_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// ============================================================================
// Agent conversation storage (runtime RPC with IndexedDB fallback)
// ============================================================================

const AGENT_CONVERSATIONS_STORE = "agent_conversations";

/**
 * Ensure the IndexedDB schema includes the agent_conversations object store.
 * Because the main DB was created at version 1 without this store, we bump to
 * version 2 on first use. Subsequent calls are no-ops.
 */
const DB_VERSION_AGENT = 2;

function openDBWithAgents(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION_AGENT);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const msgStore = db.createObjectStore(MESSAGES_STORE, {
          keyPath: "id",
        });
        msgStore.createIndex("conversation_id", "conversation_id", {
          unique: false,
        });
      }
      if (!db.objectStoreNames.contains(AGENT_CONVERSATIONS_STORE)) {
        const agentStore = db.createObjectStore(AGENT_CONVERSATIONS_STORE, {
          keyPath: "id",
        });
        agentStore.createIndex("agent_type", "agent_type", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function createAgentConversation(
  id: string,
  title: string,
  agentType: string,
  agentCwd: string | null,
  projectRoot: string | null,
  agentSessionId?: string,
  agentMetadata?: string,
): Promise<AgentConversation> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<AgentConversation>("create_agent_conversation", {
      id,
      title,
      agentType,
      agentCwd,
      projectRoot,
      agentSessionId,
      agentMetadata,
    });
  }

  const conv: AgentConversation = {
    id,
    title,
    created_at: Date.now(),
    agent_type: agentType,
    agent_session_id: agentSessionId ?? null,
    agent_cwd: agentCwd,
    agent_model_id: null,
    agent_metadata: agentMetadata ?? null,
    project_id: null,
    project_root: projectRoot,
    is_archived: false,
  };
  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(AGENT_CONVERSATIONS_STORE).put(conv);
    tx.oncomplete = () => {
      db.close();
      resolve(conv);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getAgentConversations(
  limit = 20,
  projectRoot?: string,
): Promise<AgentConversation[]> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<AgentConversation[]>("get_agent_conversations", {
      limit,
      projectRoot,
    });
  }

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readonly");
    const request = tx.objectStore(AGENT_CONVERSATIONS_STORE).getAll();
    request.onsuccess = () => {
      db.close();
      let all = (request.result as AgentConversation[])
        .filter((c) => !c.is_archived)
        .sort((a, b) => b.created_at - a.created_at);
      if (projectRoot) {
        all = all.filter(
          (c) => c.project_root === projectRoot || c.agent_cwd === projectRoot,
        );
      }
      resolve(all.slice(0, limit));
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function getAgentConversation(
  id: string,
): Promise<AgentConversation | null> {
  if (isRuntimeConnected()) {
    return runtimeInvoke<AgentConversation | null>("get_agent_conversation", {
      id,
    });
  }

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readonly");
    const request = tx.objectStore(AGENT_CONVERSATIONS_STORE).get(id);
    request.onsuccess = () => {
      db.close();
      resolve((request.result as AgentConversation) ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function setAgentConversationSessionId(
  id: string,
  agentSessionId: string,
): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("set_agent_conversation_session_id", {
      id,
      agentSessionId,
    });
    return;
  }

  const existing = await getAgentConversation(id);
  if (!existing) return;

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(AGENT_CONVERSATIONS_STORE).put({
      ...existing,
      agent_session_id: agentSessionId,
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function setAgentConversationTitle(
  id: string,
  title: string,
): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("set_agent_conversation_title", { id, title });
    return;
  }

  const existing = await getAgentConversation(id);
  if (!existing) return;

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(AGENT_CONVERSATIONS_STORE).put({ ...existing, title });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function setAgentConversationModelId(
  id: string,
  agentModelId: string,
): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("set_agent_conversation_model_id", {
      id,
      agentModelId,
    });
    return;
  }

  const existing = await getAgentConversation(id);
  if (!existing) return;

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(AGENT_CONVERSATIONS_STORE).put({
      ...existing,
      agent_model_id: agentModelId,
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function setAgentConversationMetadata(
  id: string,
  agentMetadata?: string | null,
): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("set_agent_conversation_metadata", {
      id,
      agentMetadata,
    });
    return;
  }

  const existing = await getAgentConversation(id);
  if (!existing) return;

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(AGENT_CONVERSATIONS_STORE).put({
      ...existing,
      agent_metadata: agentMetadata ?? null,
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function archiveAgentConversation(id: string): Promise<void> {
  if (isRuntimeConnected()) {
    await runtimeInvoke<void>("archive_agent_conversation", { id });
    return;
  }

  const existing = await getAgentConversation(id);
  if (!existing) return;

  const db = await openDBWithAgents();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_CONVERSATIONS_STORE, "readwrite");
    tx.objectStore(AGENT_CONVERSATIONS_STORE).put({
      ...existing,
      is_archived: true,
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
