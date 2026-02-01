// ABOUTME: Local runtime server for Seren Browser.
// ABOUTME: HTTP + WebSocket server on localhost with token auth, bridges browser to local capabilities.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { addClient } from "./events";
import { initChatDb } from "./handlers/chat";
import { registerAllHandlers } from "./handlers/index";
import { handleMessage } from "./rpc";

const PORT = Number(process.env.SEREN_PORT) || 19420;

// SECURITY: Generate a random auth token at startup.
// Only the health endpoint (localhost-only) exposes this token.
// WebSocket clients must present it as their first message to authenticate.
const AUTH_TOKEN = process.env.SEREN_RUNTIME_TOKEN || randomBytes(32).toString("hex");

function isLocalhost(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const httpServer = createServer((req, res) => {
  // SECURITY: Only allow localhost connections
  if (!isLocalhost(req.socket.remoteAddress)) {
    res.writeHead(403);
    res.end("Forbidden: only localhost connections allowed");
    return;
  }

  // CORS headers for browser
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.1.0", token: AUTH_TOKEN }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

// Track authenticated sockets
const authenticatedSockets = new WeakSet<WebSocket>();

wss.on("connection", (ws, req) => {
  // SECURITY: Verify localhost
  if (!isLocalhost(req.socket.remoteAddress)) {
    ws.close(4003, "Forbidden");
    return;
  }

  console.log("[Runtime] Browser connecting (awaiting auth)...");

  // Set a timeout: client must authenticate within 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticatedSockets.has(ws)) {
      console.warn("[Runtime] Auth timeout, closing connection");
      ws.close(4001, "Authentication timeout");
    }
  }, 5000);

  ws.on("message", async (data) => {
    const raw = typeof data === "string" ? data : data.toString();

    // First message must be the auth token
    if (!authenticatedSockets.has(ws)) {
      clearTimeout(authTimeout);
      try {
        const authMsg = JSON.parse(raw);
        if (authMsg.method === "auth" && authMsg.params?.token === AUTH_TOKEN) {
          authenticatedSockets.add(ws);
          addClient(ws);
          console.log("[Runtime] Browser authenticated");
          // Send auth success response
          if (authMsg.id != null) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", result: { authenticated: true }, id: authMsg.id }));
          }
          return;
        }
      } catch {
        // Not valid JSON, treat as failed auth
      }
      console.warn("[Runtime] Invalid auth token, closing connection");
      ws.close(4002, "Invalid auth token");
      return;
    }

    const response = await handleMessage(raw);
    if (response !== null) {
      ws.send(response);
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimeout);
    console.log("[Runtime] Browser disconnected");
  });
});

// Initialize SQLite database for conversation storage
const dataDir = join(homedir(), ".seren");
mkdirSync(dataDir, { recursive: true });
initChatDb(join(dataDir, "conversations.db"));

registerAllHandlers();

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[Seren Runtime] Listening on http://127.0.0.1:${PORT}`);
});

export { httpServer, wss, PORT, AUTH_TOKEN };
