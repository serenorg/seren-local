// ABOUTME: MCP (Model Context Protocol) server management handlers.
// ABOUTME: Manages local MCP server connections via stdio JSON-RPC.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

interface McpProcess {
  child: ChildProcess;
  pendingRequests: Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  buffer: string;
}

const processes = new Map<string, McpProcess>();

function sendRequest(
  proc: McpProcess,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.pendingRequests.delete(id);
      reject(new Error(`MCP request timeout: ${method}`));
    }, 30_000);

    proc.pendingRequests.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });

    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    proc.child.stdin?.write(msg + "\n");
  });
}

export async function mcpDisconnect(params: {
  serverName: string;
}): Promise<void> {
  const proc = processes.get(params.serverName);
  if (proc) {
    proc.child.kill();
    processes.delete(params.serverName);
  }
}

export async function mcpReadResource(params: {
  serverName: string;
  uri: string;
}): Promise<unknown> {
  const proc = processes.get(params.serverName);
  if (!proc) {
    throw new Error(`Server '${params.serverName}' not connected`);
  }

  return sendRequest(proc, "resources/read", { uri: params.uri });
}
