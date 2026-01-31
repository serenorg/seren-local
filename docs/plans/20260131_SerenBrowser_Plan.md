# Seren Browser — Implementation Plan

**Date:** January 31, 2026
**Status:** Draft — Pending Team Review
**Source Codebase:** `seren-desktop` (Tauri + SolidJS + Monaco)
**Target:** Pure browser SPA + optional local Node.js runtime

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [What Dies and What Improves](#3-what-dies-and-what-improves)
4. [Key Decisions](#4-key-decisions)
5. [Source Codebase Reference](#5-source-codebase-reference)
6. [Phase 1: Browser SPA (Chat + Gateway MCP)](#6-phase-1-browser-spa)
7. [Phase 2: Local Runtime Server](#7-phase-2-local-runtime-server)
8. [Phase 3: Install Scripts](#8-phase-3-install-scripts)
9. [Phase 4: ACP Agent Support via Local Runtime](#9-phase-4-acp-agent-support)
10. [Phase 5: OpenClaw via Local Runtime](#10-phase-5-openclaw-via-local-runtime)
11. [Phase 6: Crypto Wallet (x402)](#11-phase-6-crypto-wallet)
12. [What Gets Deleted / Not Ported](#12-what-gets-deleted)
13. [Testing Strategy](#13-testing-strategy)
14. [Deployment](#14-deployment)
15. [Risk Register](#15-risk-register)

---

## 1. Project Overview

### What We're Building

A browser-first version of Seren Desktop. Users visit a URL and immediately have AI chat + 90+ MCP tools. No download, no install, no code signing.

For users who want local capabilities (ACP agents, local MCP servers, file system access, OpenClaw), a lightweight Node.js runtime is installed via a one-line shell command. The browser SPA connects to this runtime over `localhost`.

### Why

- **No package download required** to start using Seren
- **No code signing** for macOS or Windows
- **No platform-specific builds** (darwin-arm64, win32-x64, etc.)
- **Instant deployment** — push to CDN, all users get the update
- **Lower barrier to entry** — URL beats .dmg/.exe

### Two Operating Modes

| Mode | What User Gets | Install Required |
|------|---------------|-----------------|
| **Browser-only** | AI Chat + Gateway MCP (90+ tools) + wallet + catalog | None. Visit URL. |
| **Browser + Local Runtime** | Everything above + ACP agents + local MCP servers + file system + OpenClaw | One-line shell command |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser SPA                       │
│              (SolidJS + Monaco + CSS)                │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Chat UI  │  │ Editor   │  │ Settings/Catalog  │  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │              │                 │             │
│  ┌────┴──────────────┴─────────────────┴──────────┐ │
│  │           Runtime Bridge (bridge.ts)            │ │
│  │  Detects: local runtime available? Route calls  │ │
│  │  accordingly. Falls back to browser-only mode.  │ │
│  └───────┬───────────────────────┬────────────────┘ │
└──────────┼───────────────────────┼──────────────────┘
           │                       │
     ┌─────┴─────┐          ┌─────┴──────┐
     │  Gateway   │          │  localhost  │
     │  (HTTPS)   │          │ (WebSocket) │
     │            │          │             │
     │ api.seren  │          │ Node.js     │
     │ mcp.seren  │          │ Runtime     │
     └────────────┘          │             │
                             │ ┌─────────┐ │
                             │ │ ACP     │ │
                             │ │ OpenClaw│ │
                             │ │ MCP     │ │
                             │ │ FS      │ │
                             │ └─────────┘ │
                             └─────────────┘
```

### Key Principles

- **The browser SPA is the product.** The local runtime is an optional enhancement.
- **All Gateway features work without the local runtime.** Chat, MCP Gateway tools, wallet, catalog, auth — all browser-native.
- **The local runtime is a Node.js HTTP + WebSocket server.** The browser connects to `localhost:PORT`. No Tauri, no Rust, no native code.
- **Same frontend codebase.** `bridge.ts` replaces `tauri-bridge.ts` and routes commands to either localStorage (browser-only) or the local runtime (WebSocket).

---

## 3. What Dies and What Improves

| Feature | Desktop (Tauri) | Browser-Only Mode | Browser + Local Runtime | Impact |
| --- | --- | --- | --- | --- |
| **AI Chat** | Tauri window | Browser tab | Browser tab | **No loss.** Same SolidJS components. |
| **Gateway MCP (90+ tools)** | HTTP via Rust client | HTTP via browser `fetch()` | HTTP via browser `fetch()` | **No loss.** Already HTTP/SSE. Requires CORS headers on Gateway — this is the #1 blocker. |
| **Local MCP servers (stdio)** | Rust spawns child process | **Gone.** No process spawning. | Node.js spawns child process | **No loss with runtime.** Without runtime, users only get Gateway tools. |
| **ACP agents (Claude Code)** | Rust spawns agent binary | **Gone.** | Node.js spawns agent binary | **No loss with runtime.** Without runtime, no agent panel. |
| **OpenClaw (messaging)** | Rust spawns OpenClaw process | **Gone.** | Node.js spawns OpenClaw process | **No loss with runtime.** Without runtime, no messaging channels. |
| **File system access** | Rust `fs` commands | **Gone.** Editor becomes read-only or virtual. | Node.js `fs` module | **No loss with runtime.** Without runtime, no file tree or file editing. |
| **Secure token storage** | OS keychain via Tauri plugin | localStorage | Encrypted file in `~/.seren/` | **Slight downgrade in browser-only.** localStorage is standard for web apps but less secure than keychain. Runtime mode restores encrypted storage. |
| **Conversation persistence** | SQLite via Rust | IndexedDB | SQLite via runtime | **Functional parity.** IndexedDB is less robust than SQLite but adequate. Runtime mode upgrades to SQLite. |
| **OAuth login** | Deep links (`seren://` URL scheme) | Standard browser redirect | Standard browser redirect | **Actually simpler.** No custom URL schemes, no deep link registration, no platform-specific handling. |
| **x402 crypto wallet** | Rust `alloy` crate | **Gone.** No signing. | `viem` in Node.js | **No loss with runtime.** Without runtime, no x402 payments. Users can still use SerenBucks. |
| **Auto-updates** | Tauri updater plugin | CDN deploy (instant for all users) | `npm update -g @serendb/runtime` | **Upgrade.** Web deploys are instant. No more "please restart" dialogs. |
| **Code signing** | Required for macOS + Windows | **Gone.** | **Gone.** | **Major win.** No $99/yr Apple fee, no EV certificate, no notarization delays, no SmartScreen warnings. |
| **Platform builds** | 6 targets (darwin-arm64/x64, win32-x64/arm64, linux-x64/arm64) | One static build | One npm package | **Major win.** Build once, deploy everywhere. |
| **Embedded runtimes** | Ships Node.js + Git binaries (~500MB) | Nothing | Install script downloads Node.js if needed | **Major win.** No bloated downloads. |
| **Monaco editor** | Works in Tauri webview | Works in browser | Works in browser | **No loss.** Monaco is web-native. |
| **File watcher / sync** | Rust `notify` crate | **Gone.** | Could add via `chokidar` in runtime | **Minor loss.** Only matters for live-reload workflows. Can add later. |
| **Reveal in Finder/Explorer** | Tauri shell command | **Gone.** | Could add via `open` in runtime | **Trivial loss.** Nice-to-have, not essential. |

### Summary

**Nothing critical is lost.** Every major feature either:
1. Works directly in the browser (chat, Gateway MCP, auth, catalog, wallet balance)
2. Works with the local runtime installed (ACP, OpenClaw, local MCP, file system, crypto signing)

**What actually improves:**
- Zero-friction distribution (URL vs download)
- No code signing overhead
- Instant updates for all users
- Simpler OAuth flow
- Single build target instead of six

**The real tradeoff:** Users who want ACP/OpenClaw/file access must run a one-line install command. That's a higher bar than "just open the app" but dramatically lower than "download a 200MB installer, approve code signing, drag to Applications."

---

## 4. Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Keep SolidJS | Already written, works in browser, no Tauri dependency |
| Bundler | Keep Vite | Already configured, standard for SolidJS |
| Editor | Keep Monaco | Web-native, already configured |
| Styling | Keep Tailwind CSS | No changes needed |
| Linting | Keep Biome | No changes needed |
| Testing | Keep Vitest + Playwright | No changes needed |
| Local runtime transport | WebSocket (commands) + HTTP (health/status) | WebSocket for bidirectional events (ACP, OpenClaw), HTTP for simple queries |
| Token storage (browser-only) | localStorage | `tauri-bridge.ts` already has these fallbacks. Security note: acceptable for a web app, same as every other SPA. |
| Token storage (with runtime) | Encrypted file in `~/.seren/` via runtime | More secure. Runtime encrypts with OS keyring if available. |
| Conversation storage (browser-only) | IndexedDB | Replaces SQLite in Tauri backend. Same schema, different storage. |
| Conversation storage (with runtime) | SQLite via runtime | Runtime exposes same API, backed by SQLite. |
| MCP Gateway | Direct HTTP from browser | Already uses HTTP/SSE. Currently routed through Tauri's Rust HTTP client, but `fetch()` works fine. |
| Local MCP servers | Via local runtime only | Requires process spawning. Not available in browser-only mode. |
| ACP agents | Via local runtime only | Requires process spawning + stdio. |
| OpenClaw | Via local runtime only | Requires process spawning + WebSocket to OpenClaw process. |
| OAuth | Standard browser redirect | Simpler than Tauri deep links. No custom URL schemes. |
| Auto-update (SPA) | CDN deploy | Every page load gets latest. |
| Auto-update (runtime) | `npm update` or self-update check on startup | Runtime checks version on start, prompts user if outdated. |

---

## 5. Source Codebase Reference

You'll be working from `seren-desktop`. Here's what you need to know about its structure.

### Directory Layout

```
seren-desktop/
├── src/                          # Frontend (SolidJS + TypeScript)
│   ├── App.tsx                   # Main app component, three-column layout
│   ├── index.tsx                 # Entry point (has Tauri logger init — remove)
│   ├── styles.css                # Global styles
│   ├── components/               # UI components (77 files)
│   │   ├── acp/                  # ACP agent UI (4 files)
│   │   ├── auth/                 # Login/signup (1 file)
│   │   ├── catalog/              # Publisher catalog (4 files)
│   │   ├── chat/                 # Chat UI (25 files) — LARGEST
│   │   ├── common/               # Shared components (15 files)
│   │   ├── editor/               # Monaco editor (10 files)
│   │   ├── mcp/                  # MCP tool UI (7 files)
│   │   ├── settings/             # Settings panels (10 files)
│   │   ├── sidebar/              # File explorer, database (14 files)
│   │   └── wallet/               # Wallet/billing UI (4 files)
│   ├── services/                 # Business logic (22 files)
│   │   ├── acp.ts                # ACP agent commands — TAURI DEPENDENT
│   │   ├── auth.ts               # Login/logout/refresh — USES tauri-bridge
│   │   ├── chat.ts               # Chat with tool loop — PURE WEB
│   │   ├── mcp-gateway.ts        # Gateway MCP — USES tauri-bridge for API key
│   │   ├── mcp-oauth.ts          # MCP OAuth flows
│   │   ├── openclaw-agent.ts     # OpenClaw agent — TAURI DEPENDENT
│   │   ├── publisher-oauth.ts    # Publisher OAuth — TAURI DEPENDENT
│   │   ├── wallet.ts             # Wallet balance
│   │   ├── x402.ts               # x402 payment handling
│   │   └── ... (others)
│   ├── stores/                   # SolidJS reactive stores (17 files)
│   │   ├── auth.store.ts         # Auth state — USES tauri-bridge
│   │   ├── chat.store.ts         # Chat state — PURE
│   │   ├── openclaw.store.ts     # OpenClaw state — TAURI DEPENDENT
│   │   ├── provider.store.ts     # Provider selection — USES tauri-bridge
│   │   ├── settings.store.ts     # App settings — USES tauri-bridge
│   │   ├── sync.store.ts         # File watcher — TAURI DEPENDENT
│   │   ├── updater.store.ts      # Auto-updater — DELETE ENTIRELY
│   │   └── ... (others)
│   ├── lib/                      # Core utilities (30 files)
│   │   ├── tauri-bridge.ts       # CRITICAL: All Tauri IPC (830 LOC)
│   │   ├── fetch.ts              # Fetch wrapper — TAURI FALLBACK EXISTS
│   │   ├── config.ts             # API URL config — PURE
│   │   ├── mcp/                  # MCP client (6 files) — TAURI DEPENDENT
│   │   ├── files/                # File operations — TAURI DEPENDENT
│   │   ├── tools/                # Tool executor — PARTIAL TAURI
│   │   ├── providers/            # AI provider routing — PURE WEB
│   │   ├── indexing/             # Code indexing — TAURI DEPENDENT
│   │   └── ... (others)
│   └── api/                      # Generated API client (@hey-api/openapi-ts)
│       └── generated/            # DO NOT MODIFY — auto-generated
├── src-tauri/                    # Rust backend — WILL NOT BE PORTED
│   └── src/
│       ├── lib.rs                # 693 LOC — token storage, settings
│       ├── acp.rs                # 1,411 LOC — agent spawning
│       ├── openclaw.rs           # 1,473 LOC — process management
│       ├── mcp.rs                # 563 LOC — MCP server spawning
│       ├── commands/files.rs     # 127 LOC — filesystem operations
│       ├── commands/chat.rs      # 298 LOC — conversation SQLite
│       ├── wallet/commands.rs    # wallet operations
│       └── ... (others)
├── package.json                  # Dependencies (includes @tauri-apps/*)
├── vite.config.ts                # Vite config (has Tauri-specific settings)
├── biome.json                    # Linting config
└── tsconfig.json                 # TypeScript config
```

### The Tauri Bridge Pattern

The single most important file is `src/lib/tauri-bridge.ts`. It's the abstraction layer between the frontend and Tauri's Rust backend. Every Tauri `invoke()` call in the app goes through this file (or through service files that import `@tauri-apps/api/core` directly).

**Critical insight:** `tauri-bridge.ts` already has browser fallbacks for most operations:

```typescript
// Example from tauri-bridge.ts — browser fallback already exists
export async function getToken(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string | null>("get_token");
  }
  // Browser fallback for testing
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}
```

Operations that **already have browser fallbacks** (localStorage):
- `storeToken` / `getToken` / `clearToken`
- `storeRefreshToken` / `getRefreshToken` / `clearRefreshToken`
- `storeSerenApiKey` / `getSerenApiKey` / `clearSerenApiKey`
- `storeDefaultOrganizationId` / `getDefaultOrganizationId` / `clearDefaultOrganizationId`
- `storeProviderKey` / `getProviderKey` / `clearProviderKey`
- `getConfiguredProviders`
- `storeOAuthCredentials` / `getOAuthCredentials` / `clearOAuthCredentials`
- `getOAuthProviders`

Operations that **throw errors without Tauri** (need new implementations):
- All file system operations (`listDirectory`, `readFile`, `writeFile`, etc.)
- All conversation operations (`createConversation`, `getConversations`, `saveMessage`, etc.)
- `signX402Payment` (crypto wallet signing)
- `getCryptoUsdcBalance` (blockchain query)

### Files That Import `@tauri-apps/api` Directly

These files bypass `tauri-bridge.ts` and import Tauri APIs directly. They need refactoring:

| File | Tauri Import | What It Does |
|------|-------------|--------------|
| `src/services/acp.ts` | `invoke`, `listen` | All ACP agent commands + event subscriptions |
| `src/services/publisher-oauth.ts` | `invoke`, `openUrl` | OAuth redirect URL + open browser |
| `src/services/openclaw-agent.ts` | `invoke`, `listen` | OpenClaw agent lifecycle |
| `src/stores/openclaw.store.ts` | `invoke`, `listen` | OpenClaw process state + events |
| `src/stores/sync.store.ts` | `invoke`, `listen` | File watcher start/stop |
| `src/stores/updater.store.ts` | `relaunch`, `check` | Auto-updater (DELETE) |
| `src/stores/acp.store.ts` | `listen` | ACP event subscriptions |
| `src/lib/mcp/client.ts` | `invoke` | MCP connect/disconnect/call |
| `src/lib/files/service.ts` | `invoke`, `open` | File operations + file picker |
| `src/lib/images/attachments.ts` | `open` | Image file picker |
| `src/lib/tools/executor.ts` | `invoke` | Tool execution |
| `src/lib/indexing/orchestrator.ts` | `invoke` | Code indexing |
| `src/lib/external-link.ts` | `openUrl` | Open links in system browser |
| `src/components/sidebar/FileExplorerPanel.tsx` | `open` | Folder picker dialog |
| `src/components/editor/ImageViewer.tsx` | asset URL conversion | Image display |
| `src/components/settings/OpenClawApproval.tsx` | `invoke`, `listen` | Approval dialog IPC |
| `src/components/common/AboutDialog.tsx` | app info | Version display |
| `src/index.tsx` | `attachConsole` | Tauri logger (DELETE) |

### The Fetch Pattern

`src/lib/fetch.ts` wraps `fetch()` to use Tauri's HTTP plugin (which bypasses CORS) when in Tauri, and falls back to browser `fetch()` otherwise. **The browser fallback already works.** The only concern is CORS — the Seren Gateway API at `api.serendb.com` must have appropriate CORS headers for browser requests. If it doesn't today, that's a server-side fix (add `Access-Control-Allow-Origin` headers).

### The MCP Client Pattern

`src/lib/mcp/client.ts` has two connection types:

1. **Stdio MCP** (`connect()`) — spawns local process via Tauri `invoke("mcp_connect", ...)`. This requires local runtime.
2. **HTTP MCP** (`connectHttp()`) — connects to remote MCP server (like `mcp.serendb.com`) via Tauri `invoke("mcp_connect_http", ...)`. This currently goes through Tauri's Rust HTTP client but **should work with browser `fetch()`** since it's just HTTP/SSE.

### The ACP Pattern

`src/services/acp.ts` is a thin wrapper around Tauri `invoke()` calls. It provides:
- `spawnAgent(agentType, cwd)` — spawns a Claude Code or Codex agent
- `sendPrompt(sessionId, prompt)` — sends a message to the agent
- `cancelPrompt(sessionId)` — cancels current prompt
- `terminateSession(sessionId)` — kills the agent
- `subscribeToSession(sessionId, callback)` — listens for 10 event types (message chunks, tool calls, diffs, permissions, etc.)

The event types are:
- `acp://message-chunk` — streaming text from agent
- `acp://tool-call` — agent wants to use a tool
- `acp://tool-result` — tool execution completed
- `acp://diff` — file diff from agent
- `acp://plan-update` — agent's plan changed
- `acp://prompt-complete` — agent finished responding
- `acp://permission-request` — agent needs approval
- `acp://diff-proposal` — agent proposes a file edit
- `acp://session-status` — agent status changed
- `acp://error` — agent error

In the Rust backend (`src-tauri/src/acp.rs`, 1,411 LOC), this spawns the `acp_agent` or `claude` binary as a child process, communicates via JSON-RPC over stdio, and emits Tauri events for each message type.

### The OpenClaw Pattern

`src/stores/openclaw.store.ts` manages the OpenClaw process lifecycle:
- `start()` / `stop()` / `restart()` — process management
- `refreshStatus()` — polls process info (status, port, uptime)
- `refreshChannels()` — lists messaging channels (WhatsApp, Telegram, etc.)
- `connectChannel(platform, credentials)` — connects a messaging platform
- `configureChannel(channelId, config)` — sets trust level and agent mode
- Event listeners for `openclaw://status-changed`, `openclaw://channel-event`, `openclaw://message-received`

In the Rust backend (`src-tauri/src/openclaw.rs`, 1,473 LOC), this spawns the OpenClaw Node.js process, communicates via HTTP + WebSocket, and relays events.

---

## 6. Phase 1: Browser SPA

**Goal:** A working browser app with AI chat and 90+ Gateway MCP tools. Zero install. Deploy as static site.

### Task 1.1: Initialize Project from seren-desktop

**What:** Copy the frontend source from `seren-desktop` into `seren-browser`. Strip all Tauri dependencies.

**Steps:**

1. Copy these directories/files from `seren-desktop` to `seren-browser`:
   ```
   src/                    # All frontend source
   public/                 # Static assets (if any)
   index.html              # HTML entry point
   vite.config.ts          # Vite config
   tsconfig.json           # TypeScript config
   biome.json              # Linting config
   openapi/                # API client generation config
   ```

2. **DO NOT copy:**
   ```
   src-tauri/              # Rust backend — not needed
   build/                  # Platform runtime scripts — not needed
   scripts/                # Build scripts for sidecars — not needed
   embedded-runtime/       # Bundled Node.js/Git — not needed
   ```

3. Create a new `package.json` based on `seren-desktop/package.json` but:
   - Change `name` to `"seren-browser"`
   - Remove ALL `@tauri-apps/*` dependencies (both `dependencies` and `devDependencies`)
   - Remove `@tauri-apps/cli` from devDependencies
   - Remove all `prepare:runtime:*` scripts
   - Remove `tauri:dev`, `build:openclaw`, `build:sidecar` scripts
   - Keep: `solid-js`, `monaco-editor`, `@monaco-editor/loader`, `marked`, `highlight.js`, `pdfjs-dist`, `tailwindcss`, `@tailwindcss/vite`, `tailwind-merge`
   - Keep all devDependencies except `@tauri-apps/cli`
   - Add `"start": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`

4. Update `vite.config.ts`:
   - Remove the `TAURI_DEV_HOST` environment variable usage
   - Remove the `server.host` Tauri-specific logic
   - Remove the comment about "Vite options tailored for Tauri"
   - Keep: SolidJS plugin, Tailwind plugin, Monaco optimization, path aliases

**Files to modify:**
- `package.json` (new, based on seren-desktop's)
- `vite.config.ts` (strip Tauri-specific config)

**How to test:**
```bash
pnpm install
pnpm dev
# Should start Vite dev server. Will have TypeScript errors from Tauri imports — that's expected, we fix those next.
```

**Commit:** `"Initialize seren-browser from seren-desktop frontend"`

---

### Task 1.2: Replace tauri-bridge.ts with bridge.ts

**What:** Create `src/lib/bridge.ts` to replace `src/lib/tauri-bridge.ts`. This is the single most impactful file. It must provide the same exported functions but use browser-native APIs instead of Tauri IPC.

**The bridge has two modes:**
1. **Browser-only:** localStorage for tokens/settings, IndexedDB for conversations
2. **Runtime-connected:** WebSocket to localhost for everything

**Steps:**

1. Create `src/lib/bridge.ts` with the same exports as `tauri-bridge.ts`:

   ```typescript
   // src/lib/bridge.ts
   // ABOUTME: Runtime bridge for browser and optional local runtime.
   // ABOUTME: Routes commands to localStorage/IndexedDB or localhost WebSocket.
   ```

2. Implement token/settings storage using localStorage (copy the existing browser fallbacks from `tauri-bridge.ts` — they're already written and tested):
   - `storeToken(token)` → `localStorage.setItem("seren_token", token)`
   - `getToken()` → `localStorage.getItem("seren_token")`
   - `clearToken()` → `localStorage.removeItem("seren_token")`
   - Same pattern for refresh token, API key, org ID, provider keys, OAuth credentials

3. Add runtime detection:
   ```typescript
   let runtimeWs: WebSocket | null = null;
   let runtimeAvailable = false;

   const RUNTIME_PORT = 19420;
   const RUNTIME_URL = `ws://localhost:${RUNTIME_PORT}`;

   export function isRuntimeConnected(): boolean {
     return runtimeAvailable && runtimeWs?.readyState === WebSocket.OPEN;
   }

   export async function connectToRuntime(): Promise<boolean> {
     // Try to connect to local runtime via WebSocket
     // Returns true if connected, false if not available
   }
   ```

4. Add a `runtimeInvoke()` function that sends JSON-RPC commands over WebSocket:
   ```typescript
   async function runtimeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
     // Send { jsonrpc: "2.0", method: command, params: args, id: requestId }
     // Wait for response with matching id
     // Return result or throw error
   }
   ```

5. For operations that need the runtime (file system, ACP, MCP local, OpenClaw), check `isRuntimeConnected()` and either invoke via WebSocket or throw a clear error:
   ```typescript
   export async function listDirectory(path: string): Promise<FileEntry[]> {
     if (!isRuntimeConnected()) {
       throw new Error("Local runtime required for file system access. Install with: curl -fsSL https://seren.com/install | sh");
     }
     return runtimeInvoke<FileEntry[]>("list_directory", { path });
   }
   ```

6. Keep the same TypeScript interfaces (`FileEntry`, `Conversation`, `StoredMessage`, `SignX402Response`, etc.) — they're already defined in `tauri-bridge.ts`.

7. Remove `isTauriRuntime()` — replace with `isRuntimeConnected()`.

8. Remove `listenForOAuthCallback()` — OAuth in browser uses standard redirect, not deep links.

**Files to create:**
- `src/lib/bridge.ts` (replaces `tauri-bridge.ts`)

**Files to delete:**
- `src/lib/tauri-bridge.ts`

**Files to update (find-and-replace imports):**
Every file that imports from `@/lib/tauri-bridge` must be updated to import from `@/lib/bridge`. Use your editor's find-and-replace:
```
Old: from "@/lib/tauri-bridge"
New: from "@/lib/bridge"
```

Files affected (from `tauri-bridge.ts` import search):
- `src/services/auth.ts`
- `src/services/mcp-gateway.ts`
- `src/services/publisher-oauth.ts`
- `src/services/wallet.ts`
- `src/services/x402.ts`
- `src/stores/auth.store.ts`
- `src/stores/provider.store.ts`
- `src/stores/settings.store.ts`
- `src/lib/fetch.ts`
- `src/lib/tools/executor.ts`
- Any other file importing from `tauri-bridge`

**How to test:**
```bash
# TypeScript compilation
pnpm exec tsc --noEmit

# Unit test for bridge.ts
# Write a test that:
# 1. Calls storeToken("test-token")
# 2. Calls getToken() and asserts it returns "test-token"
# 3. Calls clearToken()
# 4. Calls getToken() and asserts it returns null
# 5. Verifies isRuntimeConnected() returns false when no runtime is running
```

**TDD: Write tests first for:**
- Token storage/retrieval/clear cycle
- API key storage/retrieval/clear cycle
- Runtime detection (returns false when nothing is listening)
- `runtimeInvoke()` timeout handling (should reject after N seconds)

**Commit:** `"Replace tauri-bridge.ts with browser-native bridge.ts"`

---

### Task 1.3: Replace Tauri Fetch with Browser Fetch

**What:** Simplify `src/lib/fetch.ts` to use browser `fetch()` directly. Remove the Tauri HTTP plugin import.

**Steps:**

1. Rewrite `src/lib/fetch.ts`:
   ```typescript
   // ABOUTME: Fetch wrapper with auto-refresh on 401.
   // ABOUTME: Uses browser fetch. Handles token refresh transparently.

   import { getToken } from "./bridge";

   const NO_REFRESH_ENDPOINTS = ["/auth/login", "/auth/refresh", "/auth/signup"];

   function shouldSkipRefresh(input: RequestInfo | URL): boolean {
     const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
     return NO_REFRESH_ENDPOINTS.some((endpoint) => url.includes(endpoint));
   }

   export async function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
     const response = await fetch(input, init);

     if (response.status === 401 && !shouldSkipRefresh(input)) {
       const { refreshAccessToken } = await import("@/services/auth");
       const refreshed = await refreshAccessToken();
       if (refreshed) {
         const newToken = await getToken();
         const retryInit: RequestInit = {
           ...init,
           headers: { ...init?.headers, Authorization: `Bearer ${newToken}` },
         };
         return fetch(input, retryInit);
       }
     }

     return response;
   }
   ```

2. Remove `isTauriRuntime` import.
3. Remove Tauri HTTP plugin dynamic import.
4. Remove `tauriFetch` variable.

**CORS NOTE:** If `api.serendb.com` doesn't currently return CORS headers, this will break. The Seren backend team must add:
```
Access-Control-Allow-Origin: https://app.seren.com (or your domain)
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Credentials: true
```
This is a **blocker** for Phase 1. Verify this before starting.

**Files to modify:**
- `src/lib/fetch.ts`

**How to test:**
```bash
# Manual test: Open browser, try to login
# If CORS error appears in console, the backend needs CORS headers
# Unit test: Mock fetch, verify 401 triggers refresh
```

**Commit:** `"Simplify fetch wrapper for browser environment"`

---

### Task 1.4: Strip Direct Tauri Imports from Services

**What:** Remove or replace all direct `@tauri-apps/*` imports from service files and stores.

**Steps (for each file):**

**`src/services/publisher-oauth.ts`:**
- Remove `import { openUrl } from "@tauri-apps/plugin-opener"`
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Replace `openUrl(location)` with `window.open(location, "_blank")`
- Replace the `invoke("get_oauth_redirect_url", ...)` call with a direct `fetch()` call using `redirect: "manual"`:
  ```typescript
  const response = await fetch(authUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  const location = response.headers.get("Location");
  ```
  **NOTE:** `redirect: "manual"` in browser fetch returns an opaque redirect response (status 0). You may need to change the backend to return the redirect URL in the response body instead of as a 302 redirect. This is a potential blocker — check the Gateway behavior.

**`src/services/acp.ts`:**
- This file is 100% Tauri-dependent. Do NOT try to make it work in Phase 1.
- Create a stub that throws clear errors:
  ```typescript
  export async function spawnAgent(): Promise<never> {
    throw new Error("ACP agents require the local runtime. Install: curl -fsSL https://seren.com/install | sh");
  }
  // ... same for all other exports
  ```
- The real implementation comes in Phase 4.

**`src/services/openclaw-agent.ts`:**
- Same as ACP — stub with clear errors. Real implementation in Phase 5.

**`src/stores/openclaw.store.ts`:**
- Remove `invoke` and `listen` imports
- Stub all actions to no-op or throw runtime-required errors
- Keep the store shape and type definitions (they're used by UI)

**`src/stores/sync.store.ts`:**
- Remove entirely or stub. File watching requires local runtime.

**`src/stores/updater.store.ts`:**
- Delete this file entirely. Web apps auto-update via CDN.
- Remove the `updaterStore.initUpdater()` call from `App.tsx`.

**`src/stores/acp.store.ts`:**
- Stub event subscriptions. Real implementation in Phase 4.

**`src/lib/mcp/client.ts`:**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- The stdio MCP methods (`connect`, `disconnect`, `listTools`, `callTool`, etc.) need the local runtime. Stub them.
- The HTTP MCP methods (`connectHttp`, `disconnectHttp`, `listToolsHttp`, `callToolHttp`) currently go through Tauri's Rust HTTP client. Rewrite them to use browser `fetch()` directly. The MCP HTTP streaming transport is standard HTTP/SSE — this should be straightforward.

**`src/lib/files/service.ts`:**
- Stub file operations. File system requires local runtime.

**`src/lib/images/attachments.ts`:**
- Replace `open` from `@tauri-apps/plugin-dialog` with an HTML `<input type="file">` trigger.

**`src/lib/tools/executor.ts`:**
- Check what tools it executes. Gateway tools should work. Local tools (file system) need the runtime.

**`src/lib/indexing/orchestrator.ts`:**
- Stub. Indexing requires local file access.

**`src/lib/external-link.ts`:**
- Replace `openUrl` from Tauri with `window.open(url, "_blank")`.

**`src/components/sidebar/FileExplorerPanel.tsx`:**
- Replace `open` from `@tauri-apps/plugin-dialog` with `<input type="file">` or disable the folder picker in browser-only mode.

**`src/components/editor/ImageViewer.tsx`:**
- Replace Tauri asset URL conversion with standard browser image loading.

**`src/components/settings/OpenClawApproval.tsx`:**
- Stub. OpenClaw approval requires local runtime.

**`src/components/common/AboutDialog.tsx`:**
- Remove Tauri app info. Use a hardcoded version or fetch from package.json.

**`src/index.tsx`:**
- Remove `import { attachConsole } from "@tauri-apps/plugin-log"`.
- Remove the `attachConsole()` call.

**Files to modify:** ~18 files (see list above)
**Files to delete:** `src/stores/updater.store.ts`

**How to test:**
```bash
# After all changes:
pnpm exec tsc --noEmit    # Zero TypeScript errors
pnpm dev                   # Vite dev server starts
# Open browser → should see the app with no Tauri errors
# Chat should work if Gateway CORS is configured
# File explorer and ACP will show "runtime required" messages
```

**Commit:** `"Remove all Tauri dependencies from frontend"`

---

### Task 1.5: Implement IndexedDB Conversation Storage

**What:** The Tauri backend stores conversations in SQLite via Rust commands (`create_conversation`, `get_conversations`, `save_message`, etc.). In browser-only mode, we need a replacement. IndexedDB is the right choice.

**Steps:**

1. Create `src/lib/storage/conversations.ts`:
   - Open an IndexedDB database called `"seren"` with version 1
   - Create two object stores: `"conversations"` (keyPath: `"id"`) and `"messages"` (keyPath: `"id"`, index on `"conversation_id"`)
   - Implement all functions from the conversation/message section of `tauri-bridge.ts`:
     - `createConversation(id, title, selectedModel?, selectedProvider?)` → puts a record in `conversations` store
     - `getConversations()` → gets all non-archived conversations, sorted by `created_at` descending
     - `getConversation(id)` → gets single conversation
     - `updateConversation(id, title?, selectedModel?, selectedProvider?)` → updates fields
     - `archiveConversation(id)` → sets `is_archived = true`
     - `deleteConversation(id)` → deletes conversation + its messages
     - `saveMessage(id, conversationId, role, content, model, timestamp)` → puts a record in `messages` store
     - `getMessages(conversationId, limit)` → gets messages for conversation, ordered by timestamp, limited
     - `clearConversationHistory(conversationId)` → deletes all messages for conversation
     - `clearAllHistory()` → deletes all conversations and messages

2. Use the same TypeScript interfaces as `tauri-bridge.ts`:
   ```typescript
   interface Conversation {
     id: string;
     title: string;
     created_at: number;
     selected_model: string | null;
     selected_provider: string | null;
     is_archived: boolean;
   }

   interface StoredMessage {
     id: string;
     conversation_id: string | null;
     role: string;
     content: string;
     model: string | null;
     timestamp: number;
   }
   ```

3. Update `src/lib/bridge.ts` to use these IndexedDB functions for conversation operations when no runtime is connected.

**Files to create:**
- `src/lib/storage/conversations.ts`

**Files to modify:**
- `src/lib/bridge.ts` (wire up conversation functions)

**TDD: Write tests first for:**
- Create conversation → get it back → verify fields match
- Save messages → get messages → verify order and content
- Archive conversation → getConversations() excludes it
- Delete conversation → its messages are also deleted
- clearAllHistory() → everything is gone

**How to test:**
```bash
pnpm test   # Should pass all conversation storage tests
```

**Commit:** `"Implement IndexedDB conversation storage for browser mode"`

---

### Task 1.6: Implement Browser OAuth Flow

**What:** Replace Tauri deep link OAuth with standard browser redirect OAuth.

**Current flow (Tauri):**
1. App calls `get_oauth_redirect_url` via Rust to fetch the auth URL
2. Opens system browser with `openUrl`
3. Listens for `oauth-callback` Tauri event (from deep link `seren://oauth/callback`)
4. Extracts tokens from callback URL

**New flow (browser):**
1. App redirects to auth URL: `window.location.href = authUrl`
2. After auth, provider redirects back to `https://app.seren.com/oauth/callback?code=...`
3. App's router picks up the callback, exchanges code for tokens
4. Stores tokens via `bridge.ts`

**Steps:**

1. Update `src/services/oauth.ts`:
   - Remove deep link and Tauri invoke usage
   - Use `redirect_uri` pointing to your deployed domain's `/oauth/callback` path
   - Use `window.location.href` to navigate to auth URL
   - Handle the callback in the app's route handler

2. Create `src/lib/oauth-callback.ts`:
   - Parses `window.location.search` on page load
   - If URL contains `code` and `state` parameters, completes the OAuth exchange
   - Calls the token endpoint with the authorization code
   - Stores tokens via `bridge.ts`
   - Redirects to the main app view

3. Update `App.tsx` to check for OAuth callback parameters on mount:
   ```typescript
   onMount(async () => {
     // Check if this is an OAuth callback
     const params = new URLSearchParams(window.location.search);
     if (params.has("code") && params.has("state")) {
       await handleOAuthCallback(params);
       // Clear URL params
       window.history.replaceState({}, "", "/");
       return;
     }
     // ... rest of init
   });
   ```

**Files to create:**
- `src/lib/oauth-callback.ts`

**Files to modify:**
- `src/services/oauth.ts`
- `src/services/publisher-oauth.ts`
- `src/App.tsx`

**How to test:**
- Manual test: Click "Login with GitHub" → should redirect to GitHub → should redirect back with code → should be logged in
- This requires the Seren Gateway to support the new redirect URI

**Commit:** `"Implement browser-native OAuth flow"`

---

### Task 1.7: Rewrite MCP HTTP Client for Browser

**What:** The MCP Gateway client (`src/lib/mcp/client.ts`) currently routes HTTP MCP calls through Tauri's Rust backend. Rewrite the HTTP MCP methods to use browser `fetch()` directly.

**Steps:**

1. In `src/lib/mcp/client.ts`, rewrite `connectHttp()`:
   - Instead of `invoke("mcp_connect_http", ...)`, use `fetch()` to send MCP initialize request
   - MCP over HTTP uses JSON-RPC. Send a POST with `{ jsonrpc: "2.0", method: "initialize", params: {...} }`
   - Parse the response

2. Rewrite `listToolsHttp()`:
   - POST JSON-RPC: `{ method: "tools/list" }`

3. Rewrite `callToolHttp()`:
   - POST JSON-RPC: `{ method: "tools/call", params: { name, arguments } }`

4. Rewrite `disconnectHttp()`:
   - POST JSON-RPC: `{ method: "close" }` (or just drop the connection)

5. Remove all `invoke()` calls from this file.

**Reference:** The MCP protocol spec defines the HTTP transport. The Seren Gateway at `mcp.serendb.com/mcp` accepts JSON-RPC over HTTP with Bearer token auth.

**Files to modify:**
- `src/lib/mcp/client.ts`

**How to test:**
```bash
# Manual: Login → go to catalog → tools should load from Gateway
# The tool count should match what seren-desktop shows (~90+ tools)
```

**Commit:** `"Rewrite MCP HTTP client for browser fetch"`

---

### Task 1.8: Clean Up App.tsx and Entry Points

**What:** Remove Tauri-specific initialization from `App.tsx` and `index.tsx`.

**Steps:**

1. In `src/App.tsx`:
   - Remove `import { updaterStore } from "@/stores/updater.store"` and `updaterStore.initUpdater()`
   - Keep `openclawStore.init()` but it should no-op in browser-only mode (per Task 1.4 stubs)
   - Keep `startOpenClawAgent()` but it should no-op in browser-only mode

2. In `src/index.tsx`:
   - Remove `import { attachConsole } from "@tauri-apps/plugin-log"`
   - Remove the `attachConsole()` call
   - Keep everything else (SolidJS render)

3. Verify `index.html` doesn't reference any Tauri scripts.

**Files to modify:**
- `src/App.tsx`
- `src/index.tsx`
- `index.html` (if needed)

**How to test:**
```bash
pnpm dev
# Open http://localhost:1420
# App should render with no console errors related to Tauri
# Chat should be functional (if CORS is configured on Gateway)
```

**Commit:** `"Clean up app initialization for browser environment"`

---

### Task 1.9: Configure Deployment

**What:** Set up static site deployment. Vite builds to `dist/` which can be deployed to any CDN.

**Steps:**

1. Verify `pnpm build` produces a working static build:
   ```bash
   pnpm build
   pnpm preview   # Serves the built files locally
   ```

2. Add deployment config. Choose one:
   - **Vercel:** Add `vercel.json` with SPA fallback
     ```json
     { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
     ```
   - **Cloudflare Pages:** Add `_redirects` file in `public/`:
     ```
     /* /index.html 200
     ```

3. Set up the domain (e.g., `app.seren.com`) pointing to the deployment.

4. Update `src/lib/config.ts` if needed — the `VITE_SEREN_API_URL` env var should work as-is.

**Files to create:**
- `vercel.json` or `public/_redirects`

**How to test:**
```bash
pnpm build && pnpm preview
# Open http://localhost:4173
# Full app should work
```

**Commit:** `"Add deployment configuration"`

---

### Phase 1 Complete Checklist

Before moving to Phase 2, verify:

- [ ] `pnpm exec tsc --noEmit` — zero errors
- [ ] `pnpm check` — Biome passes
- [ ] `pnpm build` — builds successfully
- [ ] `pnpm test` — all tests pass
- [ ] No `@tauri-apps` imports anywhere in `src/`
- [ ] No `invoke()` calls from `@tauri-apps/api/core`
- [ ] App loads in browser without errors
- [ ] Login flow works (email/password and OAuth)
- [ ] Chat sends messages and receives responses
- [ ] Gateway MCP tools appear in catalog
- [ ] Gateway tool execution works
- [ ] Conversations persist across page reloads (IndexedDB)
- [ ] File explorer shows "runtime required" message
- [ ] ACP shows "runtime required" message

---

## 7. Phase 2: Local Runtime Server

**Goal:** Build the Node.js server that runs on `localhost` and provides ACP, OpenClaw, local MCP, and file system capabilities to the browser SPA.

### Task 2.1: Initialize Runtime Package

**What:** Create a new Node.js package in `runtime/` within the seren-browser repo.

**Steps:**

1. Create `runtime/` directory at repo root.

2. Initialize with:
   ```json
   // runtime/package.json
   {
     "name": "@serendb/runtime",
     "version": "0.1.0",
     "description": "Seren local runtime — enables ACP agents, local MCP, and file access from the browser",
     "type": "module",
     "bin": { "seren": "./bin/seren.js" },
     "main": "src/server.ts",
     "scripts": {
       "dev": "tsx src/server.ts",
       "build": "tsup src/server.ts --format esm --target node20",
       "start": "node dist/server.js"
     },
     "engines": { "node": ">=20.0.0" }
   }
   ```

3. Install dependencies:
   ```bash
   cd runtime
   pnpm init  # if not done above
   pnpm add ws           # WebSocket server
   pnpm add -D tsx tsup typescript @types/ws @types/node
   ```

4. Create `runtime/bin/seren.js`:
   ```javascript
   #!/usr/bin/env node
   import "../dist/server.js";
   ```

5. Create `runtime/src/server.ts`:
   ```typescript
   // ABOUTME: Local runtime server for Seren Browser.
   // ABOUTME: HTTP + WebSocket server on localhost, bridges browser to local capabilities.

   import { createServer } from "node:http";
   import { WebSocketServer } from "ws";

   const PORT = Number(process.env.SEREN_PORT) || 19420;

   // HTTP server for health checks
   const httpServer = createServer((req, res) => {
     if (req.url === "/health") {
       res.writeHead(200, {
         "Content-Type": "application/json",
         "Access-Control-Allow-Origin": "*",
       });
       res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
       return;
     }
     res.writeHead(404);
     res.end();
   });

   // WebSocket server for commands
   const wss = new WebSocketServer({ server: httpServer });

   wss.on("connection", (ws) => {
     console.log("[Runtime] Browser connected");

     ws.on("message", async (data) => {
       // Handle JSON-RPC commands
       // Route to appropriate handler (fs, acp, mcp, openclaw)
     });

     ws.on("close", () => {
       console.log("[Runtime] Browser disconnected");
     });
   });

   httpServer.listen(PORT, "127.0.0.1", () => {
     console.log(`[Seren Runtime] Listening on http://127.0.0.1:${PORT}`);
     console.log(`[Seren Runtime] Open https://app.seren.com in your browser`);
   });
   ```

**Files to create:**
- `runtime/package.json`
- `runtime/tsconfig.json`
- `runtime/bin/seren.js`
- `runtime/src/server.ts`

**How to test:**
```bash
cd runtime
pnpm dev
# In another terminal:
curl http://localhost:19420/health
# Should return: {"status":"ok","version":"0.1.0"}
```

**Commit:** `"Initialize local runtime server package"`

---

### Task 2.2: Implement JSON-RPC Command Router

**What:** Build the command routing layer that receives JSON-RPC messages over WebSocket and dispatches to handlers.

**Steps:**

1. Create `runtime/src/rpc.ts`:
   ```typescript
   // ABOUTME: JSON-RPC 2.0 message handler for WebSocket commands.
   // ABOUTME: Routes commands to fs, acp, mcp, and openclaw modules.

   export interface JsonRpcRequest {
     jsonrpc: "2.0";
     method: string;
     params?: Record<string, unknown>;
     id: string | number;
   }

   export interface JsonRpcResponse {
     jsonrpc: "2.0";
     result?: unknown;
     error?: { code: number; message: string; data?: unknown };
     id: string | number;
   }

   export type CommandHandler = (params: Record<string, unknown>) => Promise<unknown>;

   const handlers = new Map<string, CommandHandler>();

   export function registerHandler(method: string, handler: CommandHandler): void {
     handlers.set(method, handler);
   }

   export async function handleMessage(raw: string): Promise<string> {
     let request: JsonRpcRequest;
     try {
       request = JSON.parse(raw);
     } catch {
       return JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
     }

     const handler = handlers.get(request.method);
     if (!handler) {
       return JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: `Unknown method: ${request.method}` }, id: request.id });
     }

     try {
       const result = await handler(request.params ?? {});
       return JSON.stringify({ jsonrpc: "2.0", result, id: request.id });
     } catch (error) {
       return JSON.stringify({
         jsonrpc: "2.0",
         error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
         id: request.id,
       });
     }
   }
   ```

2. Create `runtime/src/events.ts` for server→browser event pushing:
   ```typescript
   // ABOUTME: Event emitter for pushing runtime events to connected browsers.
   // ABOUTME: Used by ACP, OpenClaw, and file watcher to send real-time updates.

   import type { WebSocket } from "ws";

   const clients = new Set<WebSocket>();

   export function addClient(ws: WebSocket): void {
     clients.add(ws);
     ws.on("close", () => clients.delete(ws));
   }

   export function broadcast(event: string, data: unknown): void {
     const message = JSON.stringify({ jsonrpc: "2.0", method: event, params: data });
     for (const ws of clients) {
       if (ws.readyState === ws.OPEN) {
         ws.send(message);
       }
     }
   }
   ```

3. Wire into `server.ts`.

**Files to create:**
- `runtime/src/rpc.ts`
- `runtime/src/events.ts`

**Files to modify:**
- `runtime/src/server.ts` (wire up RPC handler)

**TDD: Write tests first for:**
- Parse valid JSON-RPC request → dispatch to handler → return result
- Parse invalid JSON → return parse error
- Unknown method → return method not found error
- Handler throws → return error response

**Commit:** `"Implement JSON-RPC command router for runtime"`

---

### Task 2.3: Implement File System Commands

**What:** Port the file system operations from `src-tauri/src/commands/files.rs` (127 LOC Rust) to Node.js.

**Steps:**

1. Create `runtime/src/handlers/fs.ts`:
   ```typescript
   // ABOUTME: File system command handlers.
   // ABOUTME: Ports Tauri file system commands to Node.js fs module.

   import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from "node:fs/promises";
   import { join } from "node:path";
   import { registerHandler } from "../rpc";

   registerHandler("list_directory", async (params) => {
     const { path } = params as { path: string };
     const entries = await readdir(path, { withFileTypes: true });
     return entries
       .map((e) => ({ name: e.name, path: join(path, e.name), is_directory: e.isDirectory() }))
       .sort((a, b) => {
         if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
         return a.name.localeCompare(b.name);
       });
   });

   registerHandler("read_file", async (params) => {
     const { path } = params as { path: string };
     return await readFile(path, "utf-8");
   });

   registerHandler("write_file", async (params) => {
     const { path, content } = params as { path: string; content: string };
     await writeFile(path, content, "utf-8");
   });

   registerHandler("path_exists", async (params) => {
     const { path } = params as { path: string };
     try { await stat(path); return true; } catch { return false; }
   });

   registerHandler("is_directory", async (params) => {
     const { path } = params as { path: string };
     try { return (await stat(path)).isDirectory(); } catch { return false; }
   });

   registerHandler("create_file", async (params) => {
     const { path, content } = params as { path: string; content?: string };
     await writeFile(path, content ?? "", "utf-8");
   });

   registerHandler("create_directory", async (params) => {
     const { path } = params as { path: string };
     await mkdir(path, { recursive: true });
   });

   registerHandler("delete_path", async (params) => {
     const { path } = params as { path: string };
     await rm(path, { recursive: true });
   });

   registerHandler("rename_path", async (params) => {
     const { oldPath, newPath } = params as { oldPath: string; newPath: string };
     await rename(oldPath, newPath);
   });
   ```

2. Register the handlers in `server.ts` by importing the file.

**Security note:** This gives the browser full file system access on the user's machine. The runtime is only accessible from localhost, and the user explicitly installed it, so this is acceptable. But add a configurable root path restriction if you want defense-in-depth later.

**Files to create:**
- `runtime/src/handlers/fs.ts`

**TDD: Write tests first for:**
- `list_directory` on a temp dir with known files
- `read_file` / `write_file` round-trip
- `create_directory` + `path_exists` verification
- `delete_path` + verify gone
- `rename_path` + verify old gone, new exists
- Error cases: read nonexistent file, list nonexistent dir

**Commit:** `"Implement file system handlers in local runtime"`

---

### Task 2.4: Wire Browser Bridge to Local Runtime

**What:** Complete the `bridge.ts` WebSocket connection so file operations route to the local runtime when available.

**Steps:**

1. In `src/lib/bridge.ts`, implement `connectToRuntime()`:
   ```typescript
   export async function connectToRuntime(): Promise<boolean> {
     return new Promise((resolve) => {
       try {
         const ws = new WebSocket(`ws://localhost:${RUNTIME_PORT}`);
         const timeout = setTimeout(() => {
           ws.close();
           resolve(false);
         }, 2000);

         ws.onopen = () => {
           clearTimeout(timeout);
           runtimeWs = ws;
           runtimeAvailable = true;
           // Set up event listener for server-pushed events
           ws.onmessage = handleRuntimeEvent;
           ws.onclose = () => { runtimeAvailable = false; runtimeWs = null; };
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
   ```

2. Implement pending request tracking for `runtimeInvoke()`:
   ```typescript
   const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
   let requestId = 0;

   async function runtimeInvoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
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
         resolve: (v) => { clearTimeout(timeout); resolve(v as T); },
         reject: (e) => { clearTimeout(timeout); reject(e); },
       });

       runtimeWs!.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
     });
   }
   ```

3. Implement `handleRuntimeEvent()` to distinguish responses from server-pushed events:
   ```typescript
   function handleRuntimeEvent(event: MessageEvent): void {
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

     // Server-pushed event (no id, has method) — ACP events, OpenClaw events, etc.
     if (msg.method) {
       // Dispatch to registered event listeners
       runtimeEventListeners.get(msg.method)?.forEach(cb => cb(msg.params));
     }
   }
   ```

4. Add event subscription API for ACP/OpenClaw events:
   ```typescript
   const runtimeEventListeners = new Map<string, Set<(data: unknown) => void>>();

   export function onRuntimeEvent(event: string, callback: (data: unknown) => void): () => void {
     if (!runtimeEventListeners.has(event)) {
       runtimeEventListeners.set(event, new Set());
     }
     runtimeEventListeners.get(event)!.add(callback);
     return () => runtimeEventListeners.get(event)?.delete(callback);
   }
   ```

5. Update `App.tsx` to try connecting to runtime on mount:
   ```typescript
   onMount(async () => {
     // Try connecting to local runtime (non-blocking)
     connectToRuntime().then((connected) => {
       if (connected) {
         console.log("[App] Local runtime connected");
       } else {
         console.log("[App] No local runtime — browser-only mode");
       }
     });
     // ... rest of init
   });
   ```

**Files to modify:**
- `src/lib/bridge.ts`
- `src/App.tsx`

**How to test:**
```bash
# Terminal 1: Start runtime
cd runtime && pnpm dev

# Terminal 2: Start SPA
pnpm dev

# Open browser → console should show "Local runtime connected"
# File explorer should work (list directories, open files)
```

**Commit:** `"Wire browser bridge to local runtime WebSocket"`

---

### Task 2.5: Implement Runtime Conversation Storage

**What:** Add SQLite-backed conversation storage in the runtime, so conversations are stored locally when the runtime is available (more robust than IndexedDB).

**Steps:**

1. Add `better-sqlite3` dependency to `runtime/package.json`.

2. Create `runtime/src/handlers/chat.ts`:
   - Create SQLite database at `~/.seren/conversations.db`
   - Implement all conversation commands: `create_conversation`, `get_conversations`, `get_conversation`, `update_conversation`, `archive_conversation`, `delete_conversation`, `save_message`, `get_messages`, `clear_conversation_history`, `clear_all_history`
   - Register as JSON-RPC handlers

3. The schema should match what `src-tauri/src/commands/chat.rs` uses:
   ```sql
   CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     selected_model TEXT,
     selected_provider TEXT,
     is_archived INTEGER DEFAULT 0
   );

   CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     model TEXT,
     timestamp INTEGER NOT NULL,
     FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
   );
   ```

4. Update `bridge.ts` to route conversation commands to runtime when connected, IndexedDB when not.

**Files to create:**
- `runtime/src/handlers/chat.ts`

**Files to modify:**
- `runtime/package.json` (add better-sqlite3)
- `src/lib/bridge.ts` (route conversation commands)

**Commit:** `"Implement SQLite conversation storage in local runtime"`

---

## 9. Phase 4: ACP Agent Support

**Goal:** Port ACP agent spawning from Rust to Node.js in the local runtime. Enable the browser SPA to spawn and interact with Claude Code agents.

### Task 4.1: Port ACP Agent Spawning to Node.js

**What:** Rewrite `src-tauri/src/acp.rs` (1,411 LOC Rust) as a Node.js handler.

**What ACP does:**
1. Spawns a child process (e.g., `claude` or `codex` CLI)
2. Communicates via JSON-RPC over stdio (stdin/stdout)
3. Emits events: message chunks, tool calls, diffs, permission requests, etc.
4. Supports: spawn, send prompt, cancel, terminate, list sessions

**Steps:**

1. Create `runtime/src/handlers/acp.ts`:
   - Use `child_process.spawn()` to launch agent binaries
   - Read stdout line-by-line, parse JSON-RPC messages
   - Map each message type to a broadcast event
   - Register handlers: `acp_spawn`, `acp_prompt`, `acp_cancel`, `acp_terminate`, `acp_list_sessions`, `acp_set_permission_mode`, `acp_respond_to_permission`, `acp_respond_to_diff_proposal`, `acp_get_available_agents`, `acp_ensure_claude_cli`, `acp_check_agent_available`

2. Maintain a session map:
   ```typescript
   const sessions = new Map<string, {
     process: ChildProcess;
     agentType: string;
     cwd: string;
     status: string;
     createdAt: string;
   }>();
   ```

3. Event broadcasting — when the agent sends a message, broadcast to browser:
   ```typescript
   // On stdout line from agent process:
   broadcast("acp://message-chunk", { sessionId, text: chunk, isThought: false });
   broadcast("acp://tool-call", { sessionId, toolCallId, title, kind, status });
   // etc.
   ```

4. The browser's `src/services/acp.ts` needs to be updated to use the runtime:
   - Replace `invoke()` calls with `runtimeInvoke()` from `bridge.ts`
   - Replace `listen()` calls with `onRuntimeEvent()` from `bridge.ts`

**Reference files:**
- `src-tauri/src/acp.rs` — the Rust implementation to port
- `src/services/acp.ts` — the frontend service (shows the API contract)

**Files to create:**
- `runtime/src/handlers/acp.ts`

**Files to modify:**
- `src/services/acp.ts` (replace Tauri imports with bridge imports)

**How to test:**
```bash
# Ensure claude CLI is installed: npx @anthropic-ai/claude-code@latest --version
# Start runtime
cd runtime && pnpm dev
# Start SPA
pnpm dev
# Open browser → Go to Agent panel → Try spawning an agent
# Should see agent messages streaming in
```

**Commit:** `"Implement ACP agent spawning in local runtime"`

---

### Task 4.2: Update ACP Frontend Service

**What:** Update `src/services/acp.ts` to work via the runtime bridge instead of Tauri.

**Steps:**

1. Remove all `@tauri-apps/*` imports.
2. Import `runtimeInvoke`, `onRuntimeEvent`, `isRuntimeConnected` from `@/lib/bridge`.
3. Replace each `invoke(...)` with `runtimeInvoke(...)`.
4. Replace each `listen(...)` with `onRuntimeEvent(...)`.
5. Add runtime availability checks:
   ```typescript
   export async function spawnAgent(agentType: AgentType, cwd: string): Promise<AcpSessionInfo> {
     if (!isRuntimeConnected()) {
       throw new Error("ACP agents require the local runtime");
     }
     return runtimeInvoke<AcpSessionInfo>("acp_spawn", { agentType, cwd });
   }
   ```

**Files to modify:**
- `src/services/acp.ts`

**Commit:** `"Update ACP frontend service to use runtime bridge"`

---

## 10. Phase 5: OpenClaw via Local Runtime

**Goal:** Port OpenClaw process management from Rust to Node.js in the local runtime.

### Task 5.1: Port OpenClaw to Node.js Runtime

**What:** Rewrite `src-tauri/src/openclaw.rs` (1,473 LOC Rust) as a Node.js handler.

**What OpenClaw does:**
1. Spawns the OpenClaw Node.js process
2. Communicates via HTTP + WebSocket to the OpenClaw process
3. Manages messaging channels (WhatsApp, Telegram, Discord, etc.)
4. Emits events: status changes, channel events, messages

**Steps:**

1. Create `runtime/src/handlers/openclaw.ts`:
   - Use `child_process.spawn()` to launch OpenClaw
   - Connect to OpenClaw's HTTP API and WebSocket
   - Register handlers: `openclaw_start`, `openclaw_stop`, `openclaw_restart`, `openclaw_status`, `openclaw_list_channels`, `openclaw_connect_channel`, `openclaw_disconnect_channel`, `openclaw_get_qr`, `openclaw_send`, `openclaw_set_trust`
   - Broadcast events: `openclaw://status-changed`, `openclaw://channel-event`, `openclaw://message-received`

2. Update `src/stores/openclaw.store.ts`:
   - Replace `invoke` calls with `runtimeInvoke` from bridge
   - Replace `listen` calls with `onRuntimeEvent` from bridge

**Reference files:**
- `src-tauri/src/openclaw.rs` — Rust implementation to port
- `src/stores/openclaw.store.ts` — frontend store (shows the API contract)

**Files to create:**
- `runtime/src/handlers/openclaw.ts`

**Files to modify:**
- `src/stores/openclaw.store.ts`

**Commit:** `"Implement OpenClaw process management in local runtime"`

---

### Task 5.2: Port Local MCP Server Spawning

**What:** Rewrite `src-tauri/src/mcp.rs` (563 LOC Rust) as a Node.js handler for spawning local MCP servers via stdio.

**Steps:**

1. Create `runtime/src/handlers/mcp.ts`:
   - Use `child_process.spawn()` to launch MCP server processes
   - Communicate via JSON-RPC over stdio
   - Register handlers: `mcp_connect`, `mcp_disconnect`, `mcp_list_tools`, `mcp_list_resources`, `mcp_call_tool`, `mcp_read_resource`, `mcp_is_connected`, `mcp_list_connected`

2. Update `src/lib/mcp/client.ts`:
   - Stdio MCP methods route through `runtimeInvoke()` when runtime is connected
   - HTTP MCP methods continue using browser `fetch()` directly (from Phase 1)

**Reference files:**
- `src-tauri/src/mcp.rs` — Rust implementation
- `src/lib/mcp/client.ts` — frontend client

**Files to create:**
- `runtime/src/handlers/mcp.ts`

**Files to modify:**
- `src/lib/mcp/client.ts`

**Commit:** `"Implement local MCP server spawning in runtime"`

---

## 8. Phase 3: Install Scripts

**Goal:** One-line install commands for macOS/Linux/Windows that set up Node.js (if needed) and the Seren runtime.

### Task 3.1: Create Install Scripts

**What:** Write platform-specific install scripts.

**macOS/Linux (`install.sh`):**
```bash
#!/bin/sh
set -e

SEREN_DIR="$HOME/.seren"
SEREN_BIN="$SEREN_DIR/bin"

echo "Installing Seren Runtime to $SEREN_DIR..."

# Check for Node.js
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -ge 20 ]; then
    echo "Found Node.js $(node -v)"
  else
    echo "Node.js 20+ required. Found $(node -v)."
    echo "Installing Node.js 20..."
    # Download and extract Node.js to $SEREN_DIR/node
    # (platform detection: uname -s, uname -m)
  fi
else
  echo "Node.js not found. Installing Node.js 20..."
  # Download and extract Node.js to $SEREN_DIR/node
fi

# Install @serendb/runtime via npm
mkdir -p "$SEREN_DIR"
npm install -g @serendb/runtime --prefix "$SEREN_DIR"

# Add to PATH hint
echo ""
echo "Seren Runtime installed!"
echo "Start it with: seren"
echo "Then open https://app.seren.com in your browser"
```

**Windows (`install.ps1`):**
```powershell
$SerenDir = "$env:USERPROFILE\.seren"

Write-Host "Installing Seren Runtime to $SerenDir..."

# Check for Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $version = (node -v).TrimStart('v').Split('.')[0]
    if ([int]$version -ge 20) {
        Write-Host "Found Node.js $(node -v)"
    } else {
        Write-Host "Downloading Node.js 20..."
        # Download Node.js zip, extract to $SerenDir\node
    }
} else {
    Write-Host "Downloading Node.js 20..."
    # Download Node.js zip, extract to $SerenDir\node
}

# Install @serendb/runtime
npm install -g @serendb/runtime --prefix $SerenDir

Write-Host ""
Write-Host "Seren Runtime installed!"
Write-Host "Start it with: seren"
Write-Host "Then open https://app.seren.com in your browser"
```

**Steps:**

1. Create `scripts/install.sh` (macOS/Linux)
2. Create `scripts/install.ps1` (Windows)
3. Host them at `seren.com/install` (serve `install.sh` by default, `install.ps1` for PowerShell user-agent or explicit path)

**Usage:**
```bash
# macOS/Linux
curl -fsSL https://seren.com/install | sh

# Windows (PowerShell)
irm https://seren.com/install.ps1 | iex
```

**Files to create:**
- `scripts/install.sh`
- `scripts/install.ps1`

**How to test:**
```bash
# Test on clean macOS/Linux:
bash scripts/install.sh
seren   # Should start runtime
# Open browser → should detect runtime

# Test on Windows VM:
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
seren   # Should start runtime
```

**Commit:** `"Add cross-platform install scripts"`

---

## 11. Phase 6: Crypto Wallet

**Goal:** Port x402 payment signing from Rust (alloy crate) to JavaScript.

### Task 6.1: Implement Wallet in JavaScript

**What:** Replace the Rust wallet (`src-tauri/src/wallet/`) with a JavaScript implementation using `viem` or `ethers.js`.

**Steps:**

1. Add `viem` to runtime dependencies.
2. Create `runtime/src/handlers/wallet.ts`:
   - `store_crypto_private_key` — store encrypted in `~/.seren/wallet.json`, derive address
   - `get_crypto_wallet_address` — read stored address
   - `clear_crypto_wallet` — delete wallet file
   - `sign_x402_payment` — sign payment request using private key
   - `get_crypto_usdc_balance` — query Base mainnet for USDC balance

3. Update `src/lib/bridge.ts` wallet functions to route through runtime.

**Files to create:**
- `runtime/src/handlers/wallet.ts`

**TDD: Write tests first for:**
- Store private key → get address → verify address is correct for known test key
- Sign x402 payment → verify signature format
- Clear wallet → address returns null

**Commit:** `"Implement x402 wallet signing in local runtime"`

---

## 12. What Gets Deleted

These items from `seren-desktop` are NOT ported to `seren-browser`:

| Item | Reason |
|------|--------|
| `src-tauri/` (all Rust code) | Replaced by Node.js runtime |
| `build/` (platform runtime scripts) | No platform builds |
| `scripts/build-openclaw.ts` | OpenClaw builds separately |
| `scripts/build-sidecar.ts` | No sidecars |
| `embedded-runtime/` | No bundled Node.js/Git |
| `src/stores/updater.store.ts` | Web auto-updates via CDN |
| `src/stores/sync.store.ts` | File watching moves to runtime (if needed) |
| All `@tauri-apps/*` packages | No Tauri |
| Tauri config files (`tauri.conf.json`, `.taurignore`) | No Tauri |
| Code signing workflows | No signing needed |
| Platform-specific CI/CD | No platform builds |

---

## 13. Testing Strategy

### Unit Tests (Vitest)

**TDD required for:**
- `src/lib/bridge.ts` — token storage, runtime connection, runtimeInvoke timeout
- `src/lib/storage/conversations.ts` — IndexedDB CRUD operations
- `runtime/src/rpc.ts` — JSON-RPC parsing, routing, error handling
- `runtime/src/handlers/fs.ts` — file system operations
- `runtime/src/handlers/wallet.ts` — key storage, signing, balance query

**NOT required for:**
- UI components (test manually)
- Simple CRUD wrappers
- Mocked behavior (don't mock the runtime — test against real runtime or skip)

### Test Design Guidance

When writing tests:

1. **Test the contract, not the implementation.** If `storeToken("abc")` followed by `getToken()` returns `"abc"`, the test passes. Don't test that localStorage.setItem was called.

2. **Use real dependencies where feasible.** For file system tests, use a temp directory. For IndexedDB, use `fake-indexeddb` package. Don't mock `fs` or `localStorage` unless you have no choice.

3. **One assertion per logical behavior.** A test named `"stores and retrieves token"` should test exactly that. Don't also test error handling in the same test.

4. **Test error paths explicitly.** Have separate tests for: "read nonexistent file throws" and "read valid file returns contents". Don't combine them.

5. **Clean up after tests.** Delete temp files, clear IndexedDB, close WebSocket connections.

### E2E Tests (Playwright)

**Test these flows:**
1. Load app → shows login screen
2. Login → see chat interface
3. Send message → receive response
4. Gateway MCP tools load in catalog
5. (With runtime) File explorer lists directories
6. (With runtime) ACP agent spawns and responds

### How to Run

```bash
# Unit tests
pnpm test

# E2E tests (browser-only mode)
pnpm test:e2e

# E2E tests (with runtime)
cd runtime && pnpm dev &
pnpm test:e2e
```

---

## 14. Deployment

### SPA (Browser App)

- **Build:** `pnpm build` → static files in `dist/`
- **Host:** Vercel, Cloudflare Pages, or any static CDN
- **Domain:** `app.seren.com` (or similar)
- **SSL:** Required (HTTPS)
- **SPA routing:** All paths → `index.html`

### Runtime (npm Package)

- **Publish:** `cd runtime && npm publish` → `@serendb/runtime` on npm
- **Install:** `npm install -g @serendb/runtime`
- **Run:** `seren` (starts runtime on localhost:19420)
- **Update:** `npm update -g @serendb/runtime`

### Install Scripts

- **Host:** `seren.com/install` → serves `install.sh`
- **Host:** `seren.com/install.ps1` → serves PowerShell script
- **CDN:** Cache install scripts on CDN for fast global access

---

## 15. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| **CORS not configured on Gateway API** | Blocks Phase 1 entirely | High (likely not set up for browser origin) | Coordinate with backend team BEFORE starting. This is the #1 blocker. |
| **OAuth redirect URL not registered** | Blocks login via OAuth | Medium | Register `https://app.seren.com/oauth/callback` with GitHub, Google |
| **MCP HTTP transport incompatible with browser fetch** | Blocks Gateway MCP in browser | Low | MCP uses standard HTTP/SSE, should work. Test early. |
| **localhost WebSocket blocked by browser** | Blocks runtime connection | Low | Browsers explicitly allow `ws://localhost`. Well-established pattern. |
| **Mixed content (HTTPS page → HTTP localhost)** | Blocks runtime connection | Low | Browsers allow HTTPS → `http://localhost`. Explicit exception in spec. |
| **Port 19420 in use** | Runtime fails to start | Low | Try multiple ports, make configurable |
| **Node.js not available on user's machine** | Install script complexity | Medium | Install scripts download Node.js automatically |
| **ACP agent binary not installed** | Agent features broken | Medium | Runtime runs `acp_ensure_claude_cli` same as Tauri did |
| **IndexedDB quota limits** | Conversation storage fails for heavy users | Low | Monitor usage, warn user, offer runtime upgrade |

---

## Task Dependency Graph

```
Phase 1 (Browser SPA)
  1.1 → 1.2 → 1.3 → 1.4 → 1.8 → 1.9
              1.2 → 1.5 (can parallel with 1.3-1.4)
              1.2 → 1.6 (can parallel)
              1.4 → 1.7 (after Tauri imports removed)

Phase 2 (Runtime Server)  — can start after 1.2
  2.1 → 2.2 → 2.3 → 2.4
              2.2 → 2.5 (can parallel with 2.3)

Phase 3 (Install Scripts) — can start after 2.1
  3.1

Phase 4 (ACP) — requires 2.2
  4.1 → 4.2

Phase 5 (OpenClaw) — requires 2.2
  5.1 → 5.2

Phase 6 (Wallet) — requires 2.2
  6.1
```

**Critical path:** 1.1 → 1.2 → 1.4 → 1.8 → 1.9 (Phase 1 complete)

**Parallelizable:** Phase 2 can start as soon as Task 1.2 defines the bridge interface. Phases 4, 5, 6 can run in parallel once Phase 2's RPC router is done.

---

## Getting Started Checklist

Before writing any code:

1. [ ] **Verify CORS on api.serendb.com** — make a browser fetch from any webpage to `https://api.serendb.com/auth/me` and check for CORS errors. If blocked, file a ticket with the backend team. THIS IS THE #1 BLOCKER.
2. [ ] **Verify OAuth redirect URIs** — confirm `https://app.seren.com/oauth/callback` (or your domain) is registered with GitHub and Google OAuth apps.
3. [ ] **Verify MCP Gateway** — test `fetch("https://mcp.serendb.com/mcp", { method: "POST", ... })` from a browser. Check for CORS issues.
4. [ ] **Choose deployment platform** — Vercel or Cloudflare Pages.
5. [ ] **Set up CI/CD** — GitHub Actions for: lint → test → build → deploy on push to main.
6. [ ] **Read this entire document.** Don't skim.
