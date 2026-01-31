// ABOUTME: Local runtime server for Seren Browser.
// ABOUTME: HTTP + WebSocket server on localhost, bridges browser to local capabilities.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { handleMessage } from "./rpc";
import { registerAllHandlers } from "./handlers/index";

const PORT = Number(process.env.SEREN_PORT) || 19420;

function isLocalhost(addr: string | undefined): boolean {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
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
    res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  // SECURITY: Verify localhost
  if (!isLocalhost(req.socket.remoteAddress)) {
    ws.close(4003, "Forbidden");
    return;
  }

  console.log("[Runtime] Browser connected");

  ws.on("message", async (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    const response = await handleMessage(raw);
    if (response !== null) {
      ws.send(response);
    }
  });

  ws.on("close", () => console.log("[Runtime] Browser disconnected"));
});

registerAllHandlers();

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[Seren Runtime] Listening on http://127.0.0.1:${PORT}`);
});

export { httpServer, wss, PORT };
