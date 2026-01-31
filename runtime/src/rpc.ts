// ABOUTME: JSON-RPC 2.0 command router for the local runtime.
// ABOUTME: Dispatches incoming WebSocket messages to registered handlers.

type RpcHandler = (params: unknown) => Promise<unknown>;

const handlers = new Map<string, RpcHandler>();

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id?: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string };
  id: string | number | null;
}

function errorResponse(
  code: number,
  message: string,
  id: string | number | null,
): string {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    error: { code, message },
    id,
  };
  return JSON.stringify(response);
}

function successResponse(
  result: unknown,
  id: string | number | null,
): string {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    result,
    id: id!,
  };
  return JSON.stringify(response);
}

/**
 * Register a handler for a JSON-RPC method.
 */
export function registerHandler(method: string, handler: RpcHandler): void {
  handlers.set(method, handler);
}

/**
 * Clear all registered handlers (for testing).
 */
export function clearHandlers(): void {
  handlers.clear();
}

/**
 * Handle an incoming JSON-RPC message.
 * Returns a JSON string response, or null for notifications.
 */
export async function handleMessage(raw: string): Promise<string | null> {
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(raw);
  } catch {
    return errorResponse(-32700, "Parse error", null);
  }

  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  if (!request.method || typeof request.method !== "string") {
    return errorResponse(-32600, "Invalid request: missing method", id);
  }

  const handler = handlers.get(request.method);
  if (!handler) {
    if (isNotification) return null;
    return errorResponse(-32601, `Method not found: ${request.method}`, id);
  }

  try {
    const result = await handler(request.params);
    if (isNotification) return null;
    return successResponse(result, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    if (isNotification) return null;
    return errorResponse(-32000, message, id);
  }
}
