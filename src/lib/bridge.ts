// ABOUTME: Browser-native bridge replacing tauri-bridge.ts.
// ABOUTME: Routes storage to localStorage/IndexedDB, file ops to local runtime via WebSocket.

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
  is_archived: boolean;
}

export interface StoredMessage {
  id: string;
  conversation_id: string | null;
  role: string;
  content: string;
  model: string | null;
  timestamp: number;
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

const RUNTIME_PORT = 19420;
const RUNTIME_URL = `ws://localhost:${RUNTIME_PORT}`;
const RPC_TIMEOUT_MS = 30_000;

// ============================================================================
// Runtime connection (WebSocket JSON-RPC)
// ============================================================================

let ws: WebSocket | null = null;
let rpcId = 0;
const pendingRpc = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

export function isRuntimeConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export async function connectToRuntime(): Promise<boolean> {
  if (isRuntimeConnected()) return true;

  return new Promise<boolean>((resolve) => {
    try {
      const socket = new WebSocket(RUNTIME_URL);
      const timeout = setTimeout(() => {
        socket.close();
        resolve(false);
      }, 5000);

      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        ws = socket;
        resolve(true);
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      socket.addEventListener("close", () => {
        ws = null;
        // Reject all pending RPCs
        for (const [, rpc] of pendingRpc) {
          rpc.reject(new Error("Runtime connection closed"));
        }
        pendingRpc.clear();
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
  if (ws) {
    ws.close();
    ws = null;
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
): Promise<T> {
  requireRuntime();
  const id = ++rpcId;
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, RPC_TIMEOUT_MS);

    pendingRpc.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timeout);
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

export async function listenForOAuthCallback(
  _callback: (url: string) => void,
): Promise<() => void> {
  // Browser environment: no deep link support. No-op.
  return () => {};
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
): Promise<Conversation> {
  const db = await openDB();
  const conv: Conversation = {
    id,
    title,
    created_at: Date.now(),
    selected_model: selectedModel ?? null,
    selected_provider: selectedProvider ?? null,
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
): Promise<void> {
  const msg: StoredMessage = {
    id,
    conversation_id: conversationId,
    role,
    content,
    model,
    timestamp,
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
