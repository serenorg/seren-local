// ABOUTME: Runtime bridge for browser and optional local runtime.
// ABOUTME: Routes commands to localStorage/IndexedDB or localhost WebSocket.

const TOKEN_STORAGE_KEY = "seren_token";
const REFRESH_TOKEN_STORAGE_KEY = "seren_refresh_token";
const API_KEY_STORAGE_KEY = "seren_api_key";
const DEFAULT_ORG_ID_STORAGE_KEY = "seren_default_org_id";
const CRYPTO_WALLET_ADDRESS_KEY = "seren_crypto_wallet_address";

// ============================================================================
// Local Runtime Connection
// ============================================================================

const RUNTIME_PORT = Number(
  import.meta.env.VITE_SEREN_RUNTIME_PORT ?? "19420",
);
const RUNTIME_WS_URL = `ws://localhost:${RUNTIME_PORT}`;

let runtimeWs: WebSocket | null = null;
let runtimeAvailable = false;
let requestId = 0;

const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

const runtimeEventListeners = new Map<
  string,
  Set<(data: unknown) => void>
>();

/**
 * Check if the local runtime is connected.
 */
export function isRuntimeConnected(): boolean {
  return runtimeAvailable && runtimeWs?.readyState === WebSocket.OPEN;
}

/**
 * Try to connect to the local runtime via WebSocket.
 * Returns true if connected, false if not available.
 */
export async function connectToRuntime(): Promise<boolean> {
  if (isRuntimeConnected()) return true;

  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(RUNTIME_WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 2000);

      ws.onopen = () => {
        clearTimeout(timeout);
        runtimeWs = ws;
        runtimeAvailable = true;
        ws.onmessage = handleRuntimeMessage;
        ws.onclose = () => {
          runtimeAvailable = false;
          runtimeWs = null;
        };
        resolve(true);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

/**
 * Disconnect from the local runtime.
 */
export function disconnectRuntime(): void {
  runtimeWs?.close();
  runtimeWs = null;
  runtimeAvailable = false;
}

/**
 * Send a JSON-RPC command to the local runtime.
 */
export async function runtimeInvoke<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  if (!runtimeWs || runtimeWs.readyState !== WebSocket.OPEN) {
    throw new Error("Runtime not connected");
  }

  const id = String(++requestId);
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Runtime command timed out: ${method}`));
    }, 30000);

    pendingRequests.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });

    runtimeWs!.send(
      JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    );
  });
}

/**
 * Subscribe to runtime-pushed events (ACP, OpenClaw, etc.).
 * Returns an unsubscribe function.
 */
export function onRuntimeEvent(
  event: string,
  callback: (data: unknown) => void,
): () => void {
  if (!runtimeEventListeners.has(event)) {
    runtimeEventListeners.set(event, new Set());
  }
  runtimeEventListeners.get(event)!.add(callback);
  return () => runtimeEventListeners.get(event)?.delete(callback);
}

function handleRuntimeMessage(event: MessageEvent): void {
  const msg = JSON.parse(event.data);

  // JSON-RPC response (has id)
  if (msg.id !== undefined) {
    const pending = pendingRequests.get(String(msg.id));
    if (pending) {
      pendingRequests.delete(String(msg.id));
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Server-pushed event (no id, has method)
  if (msg.method) {
    runtimeEventListeners
      .get(msg.method)
      ?.forEach((cb) => cb(msg.params));
  }
}

// ============================================================================
// Token Storage
// ============================================================================

export async function storeToken(token: string): Promise<void> {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export async function clearToken(): Promise<void> {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export async function storeRefreshToken(token: string): Promise<void> {
  localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
}

export async function getRefreshToken(): Promise<string | null> {
  return localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
}

export async function clearRefreshToken(): Promise<void> {
  localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
}

// ============================================================================
// Seren API Key Management
// ============================================================================

export async function storeSerenApiKey(apiKey: string): Promise<void> {
  localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
}

export async function getSerenApiKey(): Promise<string | null> {
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

export async function clearSerenApiKey(): Promise<void> {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

// ============================================================================
// Default Organization ID
// ============================================================================

export async function storeDefaultOrganizationId(
  orgId: string,
): Promise<void> {
  localStorage.setItem(DEFAULT_ORG_ID_STORAGE_KEY, orgId);
}

export async function getDefaultOrganizationId(): Promise<string | null> {
  return localStorage.getItem(DEFAULT_ORG_ID_STORAGE_KEY);
}

export async function clearDefaultOrganizationId(): Promise<void> {
  localStorage.removeItem(DEFAULT_ORG_ID_STORAGE_KEY);
}

// ============================================================================
// File System Operations
// ============================================================================

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

function requireRuntime(operation: string): void {
  if (!isRuntimeConnected()) {
    throw new Error(
      `${operation} requires the local runtime. Install with: curl -fsSL https://seren.com/install | sh`,
    );
  }
}

export async function listDirectory(path: string): Promise<FileEntry[]> {
  requireRuntime("File system access");
  return runtimeInvoke<FileEntry[]>("list_directory", { path });
}

export async function readFile(path: string): Promise<string> {
  requireRuntime("File system access");
  return runtimeInvoke<string>("read_file", { path });
}

export async function writeFile(
  path: string,
  content: string,
): Promise<void> {
  requireRuntime("File system access");
  await runtimeInvoke("write_file", { path, content });
}

export async function pathExists(path: string): Promise<boolean> {
  requireRuntime("File system access");
  return runtimeInvoke<boolean>("path_exists", { path });
}

export async function isDirectory(path: string): Promise<boolean> {
  requireRuntime("File system access");
  return runtimeInvoke<boolean>("is_directory", { path });
}

export async function createFile(
  path: string,
  content?: string,
): Promise<void> {
  requireRuntime("File system access");
  await runtimeInvoke("create_file", { path, content });
}

export async function createDirectory(path: string): Promise<void> {
  requireRuntime("File system access");
  await runtimeInvoke("create_directory", { path });
}

export async function deletePath(path: string): Promise<void> {
  requireRuntime("File system access");
  await runtimeInvoke("delete_path", { path });
}

export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  requireRuntime("File system access");
  await runtimeInvoke("rename_path", { oldPath, newPath });
}

// ============================================================================
// Provider API Key Management
// ============================================================================

export async function storeProviderKey(
  provider: string,
  apiKey: string,
): Promise<void> {
  localStorage.setItem(`provider_key_${provider}`, apiKey);
}

export async function getProviderKey(
  provider: string,
): Promise<string | null> {
  return localStorage.getItem(`provider_key_${provider}`);
}

export async function clearProviderKey(provider: string): Promise<void> {
  localStorage.removeItem(`provider_key_${provider}`);
}

export async function getConfiguredProviders(): Promise<string[]> {
  const providers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("provider_key_")) {
      providers.push(key.replace("provider_key_", ""));
    }
  }
  return providers;
}

// ============================================================================
// OAuth Credentials Management
// ============================================================================

export async function storeOAuthCredentials(
  provider: string,
  credentials: string,
): Promise<void> {
  localStorage.setItem(`oauth_creds_${provider}`, credentials);
}

export async function getOAuthCredentials(
  provider: string,
): Promise<string | null> {
  return localStorage.getItem(`oauth_creds_${provider}`);
}

export async function clearOAuthCredentials(
  provider: string,
): Promise<void> {
  localStorage.removeItem(`oauth_creds_${provider}`);
}

export async function getOAuthProviders(): Promise<string[]> {
  const providers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("oauth_creds_")) {
      providers.push(key.replace("oauth_creds_", ""));
    }
  }
  return providers;
}

/**
 * Listen for OAuth callback events.
 * In browser mode, OAuth uses standard redirects — this is a no-op.
 */
export async function listenForOAuthCallback(
  _callback: (url: string) => void,
): Promise<() => void> {
  return () => {};
}

// ============================================================================
// Crypto Wallet Operations (x402)
// ============================================================================

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

export async function storeCryptoPrivateKey(
  privateKey: string,
): Promise<string> {
  requireRuntime("Crypto wallet");
  return runtimeInvoke<string>("store_crypto_private_key", {
    privateKey,
  });
}

export async function getCryptoWalletAddress(): Promise<string | null> {
  if (!isRuntimeConnected()) {
    return localStorage.getItem(CRYPTO_WALLET_ADDRESS_KEY);
  }
  return runtimeInvoke<string | null>("get_crypto_wallet_address");
}

export async function clearCryptoWallet(): Promise<void> {
  if (!isRuntimeConnected()) {
    localStorage.removeItem(CRYPTO_WALLET_ADDRESS_KEY);
    return;
  }
  await runtimeInvoke("clear_crypto_wallet");
}

export async function signX402Payment(
  requirementsJson: string,
): Promise<SignX402Response> {
  requireRuntime("x402 signing");
  return runtimeInvoke<SignX402Response>("sign_x402_payment", {
    request: { requirementsJson },
  });
}

export async function getCryptoUsdcBalance(): Promise<UsdcBalanceResponse> {
  requireRuntime("USDC balance query");
  return runtimeInvoke<UsdcBalanceResponse>("get_crypto_usdc_balance");
}

// ============================================================================
// Chat Conversation Management (IndexedDB)
// ============================================================================

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

// IndexedDB database name and version
const DB_NAME = "seren";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const msgStore = db.createObjectStore("messages", {
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

  return dbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
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
  const db = await getDb();
  const conversation: Conversation = {
    id,
    title,
    created_at: Date.now(),
    selected_model: selectedModel ?? null,
    selected_provider: selectedProvider ?? null,
    is_archived: false,
  };
  const tx = db.transaction("conversations", "readwrite");
  tx.objectStore("conversations").put(conversation);
  return conversation;
}

export async function getConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const tx = db.transaction("conversations", "readonly");
  const all = await idbRequest<Conversation[]>(
    tx.objectStore("conversations").getAll(),
  );
  return all
    .filter((c) => !c.is_archived)
    .sort((a, b) => b.created_at - a.created_at);
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const db = await getDb();
  const tx = db.transaction("conversations", "readonly");
  const result = await idbRequest<Conversation | undefined>(
    tx.objectStore("conversations").get(id),
  );
  return result ?? null;
}

export async function updateConversation(
  id: string,
  title?: string,
  selectedModel?: string,
  selectedProvider?: string,
): Promise<void> {
  const existing = await getConversation(id);
  if (!existing) return;
  const updated = {
    ...existing,
    ...(title !== undefined && { title }),
    ...(selectedModel !== undefined && { selected_model: selectedModel }),
    ...(selectedProvider !== undefined && {
      selected_provider: selectedProvider,
    }),
  };
  const db = await getDb();
  const tx = db.transaction("conversations", "readwrite");
  tx.objectStore("conversations").put(updated);
}

export async function archiveConversation(id: string): Promise<void> {
  const existing = await getConversation(id);
  if (!existing) return;
  const db = await getDb();
  const tx = db.transaction("conversations", "readwrite");
  tx.objectStore("conversations").put({ ...existing, is_archived: true });
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ["conversations", "messages"],
    "readwrite",
  );
  tx.objectStore("conversations").delete(id);
  // Delete all messages for this conversation
  const msgStore = tx.objectStore("messages");
  const index = msgStore.index("conversation_id");
  const cursor = index.openCursor(IDBKeyRange.only(id));
  await new Promise<void>((resolve, reject) => {
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        c.delete();
        c.continue();
      } else {
        resolve();
      }
    };
    cursor.onerror = () => reject(cursor.error);
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
  const db = await getDb();
  const tx = db.transaction("messages", "readwrite");
  tx.objectStore("messages").put({
    id,
    conversation_id: conversationId,
    role,
    content,
    model,
    timestamp,
  });
}

export async function getMessages(
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  const db = await getDb();
  const tx = db.transaction("messages", "readonly");
  const index = tx.objectStore("messages").index("conversation_id");
  const all = await idbRequest<StoredMessage[]>(
    index.getAll(conversationId),
  );
  return all.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
}

export async function clearConversationHistory(
  conversationId: string,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("messages", "readwrite");
  const index = tx.objectStore("messages").index("conversation_id");
  const cursor = index.openCursor(IDBKeyRange.only(conversationId));
  await new Promise<void>((resolve, reject) => {
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        c.delete();
        c.continue();
      } else {
        resolve();
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function clearAllHistory(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ["conversations", "messages"],
    "readwrite",
  );
  tx.objectStore("conversations").clear();
  tx.objectStore("messages").clear();
}
