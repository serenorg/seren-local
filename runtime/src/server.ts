// ABOUTME: Local runtime server for Seren Browser.
// ABOUTME: HTTP + WebSocket server on localhost serving embedded SPA with token-authenticated JSON-RPC.

import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, platform } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { addClient } from "./events";
import { initChatDb } from "./handlers/chat";
import { registerAllHandlers } from "./handlers/index";
import { handleMessage } from "./rpc";
import { checkForUpdates } from "./update-check";

const PORT = Number(process.env.SEREN_PORT) || 19420;
const NO_OPEN = process.argv.includes("--no-open");

// SECURITY: Generate a random auth token at startup.
// Only the health endpoint (localhost-only) exposes this token.
// WebSocket clients must present it as their first message to authenticate.
const AUTH_TOKEN = process.env.SEREN_RUNTIME_TOKEN || randomBytes(32).toString("hex");

// ── Embedded SPA Static File Serving ─────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// In dev: runtime/src/ → runtime/public/
// In dist: runtime/dist/ → runtime/public/
const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function serveStatic(urlPath: string, res: import("node:http").ServerResponse): boolean {
  // Prevent path traversal
  const safePath = urlPath.split("?")[0].replace(/\.\./g, "");
  const filePath = join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  // Must stay within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return false;
  }

  try {
    const stat = statSync(filePath);
    if (stat.isFile()) {
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const content = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
      res.end(content);
      return true;
    }
  } catch {
    // File not found, fall through
  }

  return false;
}

function serveSpaFallback(res: import("node:http").ServerResponse): boolean {
  const indexPath = join(PUBLIC_DIR, "index.html");
  try {
    const content = readFileSync(indexPath);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin" ? `open "${url}"` :
    platform() === "win32" ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`[Runtime] Could not open browser: ${err.message}`);
  });
}

function isLocalhost(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// ── API Proxy ───────────────────────────────────────────────────────
// Forwards /api/* requests to the Seren Gateway, bypassing browser CORS.

const GATEWAY_HOST = "api.serendb.com";
const MCP_GATEWAY_HOST = "mcp.serendb.com";

function proxyToGateway(req: IncomingMessage, res: ServerResponse, host: string): void {
  const targetPath = (req.url || "").replace(/^\/(api|mcp)/, "");

  // Collect request body
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    // Forward headers, stripping host and origin
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === "host" || key === "origin" || key === "referer") continue;
      if (value) forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    forwardHeaders["host"] = host;

    const proxyReq = httpsRequest(
      {
        hostname: host,
        port: 443,
        path: targetPath,
        method: req.method,
        headers: forwardHeaders,
      },
      (proxyRes) => {
        // Copy response headers, add CORS
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value) responseHeaders[key] = value;
        }
        responseHeaders["access-control-allow-origin"] = "*";
        responseHeaders["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
        responseHeaders["access-control-allow-headers"] = "Content-Type, Authorization";

        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      console.error("[Runtime] Gateway proxy error:", err.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gateway proxy error", message: err.message }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Proxy /api/* to Seren Gateway (bypasses browser CORS)
  if (req.url?.startsWith("/api/") || req.url === "/api") {
    proxyToGateway(req, res, GATEWAY_HOST);
    return;
  }

  // Proxy /mcp/* to MCP Gateway
  if (req.url?.startsWith("/mcp/") || req.url === "/mcp") {
    proxyToGateway(req, res, MCP_GATEWAY_HOST);
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.1.0", token: AUTH_TOKEN }));
    return;
  }

  // Serve embedded SPA static files
  const urlPath = req.url || "/";
  if (serveStatic(urlPath, res)) return;

  // SPA fallback: serve index.html for client-side routing
  if (serveSpaFallback(res)) return;

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
  const url = `http://127.0.0.1:${PORT}`;
  const hasSpa = existsSync(join(PUBLIC_DIR, "index.html"));
  console.log(`[Seren Runtime] Listening on ${url}`);
  if (hasSpa) {
    console.log(`[Seren Runtime] Serving app at ${url}`);
    if (!NO_OPEN) openBrowser(url);
  } else {
    console.log("[Seren Runtime] No embedded SPA found (runtime/public/). Run build:embed to bundle the app.");
  }
  checkForUpdates();
});

export { httpServer, wss, PORT, AUTH_TOKEN };
