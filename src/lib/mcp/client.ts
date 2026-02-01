// ABOUTME: MCP client service for frontend communication with MCP servers.
// ABOUTME: Provides reactive state management and Tauri IPC integration.

import { createSignal } from "solid-js";
import { runtimeInvoke } from "@/lib/bridge";
import { isRecoverableError, parseMcpError } from "./errors";
import type {
  McpConnection,
  McpConnectionStatus,
  McpInitializeResult,
  McpResource,
  McpTool,
  McpToolCall,
  McpToolResult,
} from "./types";

/**
 * Create an MCP client with reactive state management.
 */
function createMcpClient() {
  const [connections, setConnections] = createSignal<
    Map<string, McpConnection>
  >(new Map());

  /**
   * Get a connection by server name.
   */
  function getConnection(serverName: string): McpConnection | undefined {
    return connections().get(serverName);
  }

  /**
   * Update a connection's state.
   */
  function updateConnection(
    serverName: string,
    updates: Partial<McpConnection>,
  ): void {
    setConnections((prev) => {
      const next = new Map(prev);
      const existing = next.get(serverName);
      if (existing) {
        next.set(serverName, { ...existing, ...updates });
      }
      return next;
    });
  }

  /**
   * Set a connection's status.
   */
  function setConnectionStatus(
    serverName: string,
    status: McpConnectionStatus,
    error?: string,
  ): void {
    updateConnection(serverName, { status, error });
  }

  /**
   * Connect to an MCP server.
   */
  async function connect(
    serverName: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    // Initialize connection state
    setConnections((prev) => {
      const next = new Map(prev);
      next.set(serverName, {
        serverName,
        status: "connecting",
        capabilities: null,
        tools: [],
        resources: [],
      });
      return next;
    });

    try {
      // Connect via Tauri
      const result = await runtimeInvoke<McpInitializeResult>("mcp_connect", {
        serverName,
        command,
        args,
        env: env || null,
      });

      // Fetch tools and resources
      const [tools, resources] = await Promise.all([
        listTools(serverName),
        listResources(serverName),
      ]);

      // Update connection state
      setConnections((prev) => {
        const next = new Map(prev);
        next.set(serverName, {
          serverName,
          status: "connected",
          capabilities: result,
          tools,
          resources,
        });
        return next;
      });
    } catch (error) {
      setConnectionStatus(
        serverName,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async function disconnect(serverName: string): Promise<void> {
    try {
      await runtimeInvoke("mcp_disconnect", { serverName });
    } finally {
      setConnections((prev) => {
        const next = new Map(prev);
        next.delete(serverName);
        return next;
      });
    }
  }

  /**
   * List tools available on an MCP server.
   */
  async function listTools(serverName: string): Promise<McpTool[]> {
    return runtimeInvoke<McpTool[]>("mcp_list_tools", { serverName });
  }

  /**
   * List resources available on an MCP server.
   */
  async function listResources(serverName: string): Promise<McpResource[]> {
    return runtimeInvoke<McpResource[]>("mcp_list_resources", { serverName });
  }

  /**
   * Call a tool on an MCP server.
   */
  type CallToolOptions = {
    signal?: AbortSignal;
  };

  type RetryToolOptions = CallToolOptions & {
    maxAttempts?: number;
    initialDelayMs?: number;
    onAttempt?: (attempt: number) => void;
  };

  function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return promise;
    }

    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Operation aborted", "AbortError"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Operation aborted", "AbortError"));
      };

      signal.addEventListener("abort", onAbort);

      promise
        .then((value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        })
        .catch((error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        });
    });
  }

  async function callTool(
    serverName: string,
    call: McpToolCall,
    options?: CallToolOptions,
  ): Promise<McpToolResult> {
    const invocation = runtimeInvoke<McpToolResult>("mcp_call_tool", {
      serverName,
      toolName: call.name,
      arguments: call.arguments,
    }).catch((error) => {
      throw parseMcpError(error, serverName);
    });

    return withAbort(invocation, options?.signal);
  }

  async function retryToolCall(
    serverName: string,
    call: McpToolCall,
    options?: RetryToolOptions,
  ): Promise<McpToolResult> {
    const maxAttempts = options?.maxAttempts ?? 3;
    let delay = options?.initialDelayMs ?? 1000;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      options?.onAttempt?.(attempt);

      try {
        return await callTool(serverName, call, { signal: options?.signal });
      } catch (error) {
        lastError = error;

        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }

        if (!isRecoverableError(error) || attempt >= maxAttempts) {
          throw error;
        }

        await waitWithAbort(delay, options?.signal);
        delay *= 2;
      }
    }

    throw lastError ?? new Error("Tool call failed");
  }

  function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Operation aborted", "AbortError"),
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Operation aborted", "AbortError"));
      };

      signal.addEventListener("abort", onAbort);
    });
  }

  /**
   * Read a resource from an MCP server.
   */
  async function readResource(
    serverName: string,
    uri: string,
  ): Promise<unknown> {
    return runtimeInvoke("mcp_read_resource", { serverName, uri });
  }

  /**
   * Check if an MCP server is connected.
   */
  async function isConnected(serverName: string): Promise<boolean> {
    return runtimeInvoke<boolean>("mcp_is_connected", { serverName });
  }

  /**
   * Get list of connected MCP servers.
   */
  async function listConnected(): Promise<string[]> {
    return runtimeInvoke<string[]>("mcp_list_connected");
  }

  /**
   * Refresh tools for a connected server.
   */
  async function refreshTools(serverName: string): Promise<McpTool[]> {
    const tools = await listTools(serverName);
    updateConnection(serverName, { tools });
    return tools;
  }

  /**
   * Refresh resources for a connected server.
   */
  async function refreshResources(serverName: string): Promise<McpResource[]> {
    const resources = await listResources(serverName);
    updateConnection(serverName, { resources });
    return resources;
  }

  /**
   * Get all tools across all connected servers.
   */
  function getAllTools(): Array<{ serverName: string; tool: McpTool }> {
    const result: Array<{ serverName: string; tool: McpTool }> = [];
    const conns = Array.from(connections().values());
    for (const conn of conns) {
      if (conn.status === "connected") {
        for (const tool of conn.tools) {
          result.push({ serverName: conn.serverName, tool });
        }
      }
    }
    return result;
  }

  /**
   * Get all resources across all connected servers.
   */
  function getAllResources(): Array<{
    serverName: string;
    resource: McpResource;
  }> {
    const result: Array<{ serverName: string; resource: McpResource }> = [];
    const conns = Array.from(connections().values());
    for (const conn of conns) {
      if (conn.status === "connected") {
        for (const resource of conn.resources) {
          result.push({ serverName: conn.serverName, resource });
        }
      }
    }
    return result;
  }

  // ============================================================================
  // HTTP MCP Client (for remote servers like mcp.serendb.com)
  // Uses browser fetch directly — no runtime required.
  // ============================================================================

  // Track HTTP MCP connections: serverName → { url, authToken, sessionId }
  const httpConnections = new Map<
    string,
    { url: string; authToken?: string; sessionId?: string }
  >();

  let httpRpcId = 0;

  /**
   * Send a JSON-RPC request to an HTTP MCP server.
   */
  async function httpRpc<T>(
    serverName: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const conn = httpConnections.get(serverName);
    if (!conn) {
      throw new Error(`HTTP MCP server "${serverName}" is not connected`);
    }

    const id = ++httpRpcId;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (conn.authToken) {
      headers.Authorization = `Bearer ${conn.authToken}`;
    }
    if (conn.sessionId) {
      headers["Mcp-Session-Id"] = conn.sessionId;
    }

    const response = await fetch(conn.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      }),
    });

    // Capture session ID from response headers
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId && sessionId !== conn.sessionId) {
      conn.sessionId = sessionId;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MCP HTTP error ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "MCP RPC error");
    }
    return data.result as T;
  }

  /**
   * Connect to a remote MCP server via HTTP streaming transport.
   * Uses browser fetch directly — no runtime required.
   */
  async function connectHttp(
    serverName: string,
    url: string,
    authToken?: string,
  ): Promise<void> {
    // Initialize connection state
    setConnections((prev) => {
      const next = new Map(prev);
      next.set(serverName, {
        serverName,
        status: "connecting",
        capabilities: null,
        tools: [],
        resources: [],
      });
      return next;
    });

    // Track the HTTP connection
    httpConnections.set(serverName, { url, authToken });

    try {
      // Send MCP initialize request
      const result = await httpRpc<McpInitializeResult>(
        serverName,
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "seren-local", version: "0.1.0" },
        },
      );

      // Send initialized notification (no response expected, but some servers need it)
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(httpConnections.get(serverName)?.sessionId
            ? {
                "Mcp-Session-Id": httpConnections.get(serverName)!.sessionId!,
              }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }).catch(() => {
        // Ignore — some servers don't accept notifications
      });

      // Fetch tools from HTTP MCP server
      const tools = await listToolsHttp(serverName);

      // Update connection state
      setConnections((prev) => {
        const next = new Map(prev);
        next.set(serverName, {
          serverName,
          status: "connected",
          capabilities: result,
          tools,
          resources: [],
        });
        return next;
      });
    } catch (error) {
      httpConnections.delete(serverName);
      setConnectionStatus(
        serverName,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Disconnect from an HTTP MCP server.
   */
  async function disconnectHttp(serverName: string): Promise<void> {
    httpConnections.delete(serverName);
    setConnections((prev) => {
      const next = new Map(prev);
      next.delete(serverName);
      return next;
    });
  }

  /**
   * List tools from an HTTP MCP server.
   */
  async function listToolsHttp(serverName: string): Promise<McpTool[]> {
    const result = await httpRpc<{ tools: McpTool[] }>(
      serverName,
      "tools/list",
    );
    return result.tools ?? [];
  }

  /**
   * Call a tool on an HTTP MCP server.
   */
  async function callToolHttp(
    serverName: string,
    call: McpToolCall,
    options?: CallToolOptions,
  ): Promise<McpToolResult> {
    const invocation = httpRpc<McpToolResult>(serverName, "tools/call", {
      name: call.name,
      arguments: call.arguments,
    }).catch((error) => {
      throw parseMcpError(error, serverName);
    });

    return withAbort(invocation, options?.signal);
  }

  /**
   * Check if an HTTP MCP server is connected.
   */
  async function isConnectedHttp(serverName: string): Promise<boolean> {
    return httpConnections.has(serverName);
  }

  /**
   * List connected HTTP MCP servers.
   */
  async function listConnectedHttp(): Promise<string[]> {
    return Array.from(httpConnections.keys());
  }

  return {
    connections,
    getConnection,
    connect,
    disconnect,
    listTools,
    listResources,
    callTool,
    retryToolCall,
    readResource,
    isConnected,
    listConnected,
    refreshTools,
    refreshResources,
    getAllTools,
    getAllResources,
    // HTTP MCP methods (for remote servers like mcp.serendb.com)
    connectHttp,
    disconnectHttp,
    listToolsHttp,
    callToolHttp,
    isConnectedHttp,
    listConnectedHttp,
  };
}

// Export singleton instance
export const mcpClient = createMcpClient();

// Re-export for convenience
export type { McpConnection } from "./types";
