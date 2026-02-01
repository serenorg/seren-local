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
6. [Security Requirements](#6-security-requirements)
7. [Phase 1: Browser SPA (Chat + Gateway MCP)](#7-phase-1-browser-spa)
8. [Phase 2: Local Runtime Server](#8-phase-2-local-runtime-server)
9. [Phase 3: Install Scripts](#9-phase-3-install-scripts)
10. [Phase 4: ACP Agent Support via Local Runtime](#10-phase-4-acp-agent-support)
11. [Phase 5: OpenClaw via Local Runtime](#11-phase-5-openclaw-via-local-runtime)
12. [Phase 6: Crypto Wallet (x402)](#12-phase-6-crypto-wallet)
13. [Phase 7: Embed SPA into Runtime](#13-phase-7-embed-spa-into-runtime)
14. [Phase 8: Feature Parity with Desktop](#14-phase-8-feature-parity-with-desktop)
15. [What Gets Deleted / Not Ported](#15-what-gets-deleted)
16. [Testing Strategy](#16-testing-strategy)
17. [Deployment](#17-deployment)
18. [Risk Register](#18-risk-register)
19. [Final Audit Checklist](#19-final-audit-checklist)

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
│   ├── stores/                   # SolidJS reactive stores (17 files)
│   ├── lib/                      # Core utilities (30 files)
│   │   ├── tauri-bridge.ts       # CRITICAL: All Tauri IPC (830 LOC)
│   │   ├── fetch.ts              # Fetch wrapper
│   │   ├── config.ts             # API URL config — PURE
│   │   ├── mcp/                  # MCP client (6 files)
│   │   ├── files/                # File operations
│   │   ├── tools/                # Tool executor
│   │   ├── providers/            # AI provider routing — PURE WEB
│   │   └── ...
│   └── api/                      # Generated API client (@hey-api/openapi-ts)
│       └── generated/            # DO NOT MODIFY — auto-generated
├── src-tauri/                    # Rust backend — WILL NOT BE PORTED
├── package.json
├── vite.config.ts
├── biome.json
└── tsconfig.json
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

### Files That Import `@tauri-apps/*` Directly

These 21 files bypass `tauri-bridge.ts` and import Tauri APIs directly. **Each one must be individually rewritten.** This is the hardest part of Phase 1.

| File | Tauri Import | What It Does | Rewrite Strategy |
|------|-------------|--------------|------------------|
| `src/services/acp.ts` (451 LOC) | `invoke`, `listen`, `UnlistenFn` | ACP agent commands + events | Stub all exports → runtime-required error |
| `src/services/openclaw-agent.ts` | `invoke`, `listen`, `UnlistenFn` | OpenClaw agent lifecycle | Stub → runtime-required error |
| `src/services/publisher-oauth.ts` | `openUrl` from plugin-opener | OAuth redirect + open browser | Replace with `window.open()` |
| `src/services/mcp-oauth.ts` | `invoke` | MCP OAuth flows | Replace invoke with bridge |
| `src/services/indexing.ts` | `invoke` | Code indexing IPC | Stub → runtime-required error |
| `src/stores/openclaw.store.ts` (389 LOC) | `invoke`, `listen`, `UnlistenFn` | OpenClaw process state | Stub all actions → no-op or runtime error |
| `src/stores/sync.store.ts` (165 LOC) | `invoke`, `listen`, `UnlistenFn` | File watcher start/stop | Stub → runtime-required error |
| `src/stores/acp.store.ts` | `UnlistenFn` (type only) | ACP event subscriptions | Remove type import, use local type |
| `src/stores/fileTree.ts` | `invoke` | Directory listing | Replace invoke with `listDirectory` from bridge |
| `src/lib/mcp/client.ts` | `invoke` | MCP connect/disconnect/call | Stub stdio, rewrite HTTP to use fetch |
| `src/lib/files/service.ts` | `invoke`, `open`, `save` from plugin-dialog | File ops + file picker | Stub FS, replace dialog with HTML input |
| `src/lib/images/attachments.ts` | `invoke`, `open` from plugin-dialog | Image file picker | Replace with HTML `<input type="file">` |
| `src/lib/tools/executor.ts` | `invoke`, `listen`, `UnlistenFn` | Tool execution routing | Replace invoke with bridge, stub local tools |
| `src/lib/indexing/orchestrator.ts` | `invoke` | Code indexing | Stub → runtime-required error |
| `src/lib/external-link.ts` | ~~(already rewritten)~~ | Open links in browser | Done — uses `window.open` |
| `src/components/sidebar/FileExplorerPanel.tsx` | `open` from plugin-dialog | Folder picker dialog | Replace with HTML input or runtime check |
| `src/components/sidebar/FileTree.tsx` | `invoke` | File tree context menu ops | Replace invoke with bridge functions |
| `src/components/editor/ImageViewer.tsx` | `convertFileSrc` | Image display | Replace with standard URL/blob |
| `src/components/settings/OpenClawApproval.tsx` | `invoke`, `listen`, `UnlistenFn` | Approval dialog IPC | Stub → no-op (requires runtime) |
| `src/components/common/AboutDialog.tsx` | `invoke`, `listen` | Version display | Hardcode version from env var |
| `src/lib/commands/registry.ts` | `emit` (line 242) | About dialog trigger | Replace with `window.dispatchEvent` |

### Broken Imports from bridge.ts

The current `bridge.ts` does NOT export `isTauriRuntime()`, but 3 files import it:
- `src/services/oauth.ts` (lines 7, 46, 103)
- `src/stores/settings.store.ts` (lines 6, 20)
- `src/stores/provider.store.ts` (lines 16, 30)

**These are bugs from incomplete migration.** Each file needs `isTauriRuntime()` replaced with the correct browser-only logic.

### The Fetch Pattern

`src/lib/fetch.ts` wraps `fetch()` to use Tauri's HTTP plugin (which bypasses CORS) when in Tauri, and falls back to browser `fetch()` otherwise. **This has already been rewritten** — just uses browser fetch with 401 auto-refresh.

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
- `subscribeToSession(sessionId, callback)` — listens for 10 event types

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

## 6. Security Requirements

**READ THIS SECTION BEFORE WRITING ANY CODE.** Every task in this plan has security implications. If you skip these, you will ship vulnerabilities.

### Token Storage

- **Browser-only mode uses localStorage.** This is standard for SPAs (same as GitHub, Vercel, etc.) but you MUST understand the tradeoffs:
  - localStorage is accessible to any JS running on the page. If we have an XSS vulnerability, tokens are stolen.
  - NEVER use `innerHTML` with user-supplied data. Use `textContent` or the `escapeHtml()` utility from `src/lib/security.ts`.
  - NEVER eval() or `new Function()` with user data.
  - NEVER store tokens in cookies without `HttpOnly`, `Secure`, and `SameSite=Strict` flags.

### CORS and API Communication

- All Gateway API calls go to `https://api.serendb.com`. The browser enforces CORS.
- The Gateway MUST return these headers for browser requests:
  ```
  Access-Control-Allow-Origin: https://app.seren.com
  Access-Control-Allow-Headers: Authorization, Content-Type
  Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
  Access-Control-Allow-Credentials: true
  ```
- **DO NOT use `Access-Control-Allow-Origin: *`** — this disables credential-based CORS.
- **DO NOT disable CORS checks** in production. If you're tempted, you're doing something wrong.

### Local Runtime Security

- The local runtime binds to `127.0.0.1` ONLY. Never `0.0.0.0`.
- The runtime exposes file system read/write. This is intentional — the user installed it. But:
  - **Validate all file paths** — no path traversal (`../../../etc/passwd`). Use `path.resolve()` and verify the resolved path is within the user's home directory or an explicitly allowed directory.
  - **Never execute user-supplied commands** without sanitization.
  - **Set a maximum file size** for reads (e.g., 50MB) to prevent OOM.

### Input Validation Checklist (for every API boundary)

1. **User input → API:** Sanitize before sending. Escape HTML in chat messages before rendering.
2. **API response → UI:** Never trust API responses. Validate types before using.
3. **WebSocket messages:** Validate JSON-RPC structure before processing. Reject malformed messages.
4. **File paths from runtime:** Always resolve and validate. Never pass user strings directly to `fs` operations.
5. **OAuth parameters:** Validate `state` parameter matches what you sent. This prevents CSRF.

### Common Vulnerabilities to Avoid

| Vulnerability | How You'll Introduce It | Prevention |
|--------------|------------------------|------------|
| **XSS** | Using `innerHTML` to render chat messages or tool output | Always use `textContent` or a sanitizer like DOMPurify. Marked.js output must be sanitized. |
| **Token Theft** | Logging tokens to console, including in error messages | NEVER log tokens. Search for `console.log` that includes token values before each commit. |
| **Open Redirect** | OAuth callback doesn't validate redirect URL | Validate the redirect URL is on your domain before redirecting. |
| **CSRF** | OAuth flow without state parameter | Always generate a random state, store it, and verify it on callback. |
| **Path Traversal** | Runtime file handler accepts `../../etc/passwd` | Use `path.resolve()`, verify result starts with allowed prefix. |
| **Prototype Pollution** | Spreading untrusted JSON into objects | Validate JSON structure before spreading. Don't use `Object.assign` with untrusted input. |
| **Secrets in Source** | Hardcoding API keys or tokens | Use env vars. Check `.env` is in `.gitignore`. Run `git diff --cached` before every commit. |

---

## 7. Phase 1: Browser SPA

**Goal:** A working browser app with AI chat and 90+ Gateway MCP tools. Zero install. Deploy as static site.

### Getting Started Checklist

Before writing any code, complete these checks. **Do not skip any.**

1. [ ] **Verify CORS on api.serendb.com** — Run this in a browser console on any page:
   ```javascript
   fetch("https://api.serendb.com/auth/me", { headers: { "Content-Type": "application/json" } })
     .then(r => console.log("CORS OK:", r.status))
     .catch(e => console.error("CORS BLOCKED:", e));
   ```
   If you see a CORS error, **STOP. File a ticket with the backend team.** This is the #1 blocker.

2. [ ] **Verify MCP Gateway CORS** — Same test for `https://mcp.serendb.com/mcp`.

3. [ ] **Verify OAuth redirect URIs** — Confirm `https://app.seren.com/oauth/callback` (or your domain) is registered with GitHub and Google OAuth apps.

4. [ ] **Read this entire document.** Don't skim. You will miss critical details and introduce bugs.

5. [ ] **Read `seren-desktop/src/lib/tauri-bridge.ts`** — All 830 lines. This is the file you're replacing. If you don't understand every function in it, you will break things.

---

### Task 1.1: Initialize Project

**What:** Create `seren-browser` repo from `seren-desktop` frontend source. Strip all Tauri dependencies.

**Steps:**

1. Copy these from `seren-desktop` to `seren-browser`:
   ```
   src/                    # All frontend source
   public/                 # Static assets
   index.html              # HTML entry point
   vite.config.ts          # Vite config
   tsconfig.json           # TypeScript config
   biome.json              # Linting config
   openapi/                # API client generation config
   tests/                  # Existing tests
   ```

2. **DO NOT copy:**
   ```
   src-tauri/              # Rust backend
   build/                  # Platform runtime scripts
   scripts/                # Build scripts for sidecars
   embedded-runtime/       # Bundled Node.js/Git
   ```

3. Create `package.json`. Copy from `seren-desktop/package.json` and:
   - Change `name` to `"seren-browser"`
   - **Remove ALL of these dependencies** (search for each one):
     - `@tauri-apps/api`
     - `@tauri-apps/cli`
     - `@tauri-apps/plugin-dialog`
     - `@tauri-apps/plugin-http`
     - `@tauri-apps/plugin-log`
     - `@tauri-apps/plugin-opener`
     - `@tauri-apps/plugin-process`
     - `@tauri-apps/plugin-store`
     - `@tauri-apps/plugin-updater`
     - Any other package starting with `@tauri-apps/`
   - Remove scripts: `tauri:dev`, `build:openclaw`, `build:sidecar`, all `prepare:runtime:*`
   - Add scripts: `"start": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`
   - **Keep:** `solid-js`, `monaco-editor`, `@monaco-editor/loader`, `marked`, `highlight.js`, `pdfjs-dist`, `tailwindcss`, `@tailwindcss/vite`, `tailwind-merge`, and all devDependencies except Tauri ones
   - Add `"fake-indexeddb": "^6.0.0"` to devDependencies (needed for IndexedDB tests)

4. Update `vite.config.ts`:
   - Remove the `TAURI_DEV_HOST` / `TAURI_PLATFORM` environment variable usage
   - Remove `server.host` Tauri-specific logic
   - Change `server.port` to `3000`
   - Keep: SolidJS plugin, Tailwind plugin, Monaco optimization, path aliases

5. Update `tsconfig.json`:
   - Remove `"references": [{ "path": "./tsconfig.node.json" }]` if present

**How to verify:**

```bash
pnpm install
pnpm exec tsc --noEmit 2>&1 | head -5
# EXPECTED: TypeScript errors from @tauri-apps imports. That's correct — we fix those next.
# UNEXPECTED: "Cannot find module 'solid-js'" — means you removed a required dep.

grep -r "@tauri-apps" package.json
# EXPECTED: No output (zero Tauri deps in package.json)

pnpm dev
# EXPECTED: Vite starts. Browser shows errors from missing Tauri modules. That's expected.
```

**Commit:** `"Initialize seren-browser from seren-desktop frontend"`

**Security check before commit:**
```bash
git diff --cached | grep -i "secret\|password\|token\|api_key\|private"
# EXPECTED: No sensitive values. If you see any, unstage that file.
```

---

### Task 1.2: Create bridge.ts (TDD)

**What:** Create `src/lib/bridge.ts` — the single abstraction layer that replaces `tauri-bridge.ts`. This is the most critical file in the entire migration. **It must be written test-first.**

**Why TDD for this file:**
- Every service and store in the app depends on bridge.ts
- A bug here cascades to the entire application
- The localStorage operations look simple but have subtle edge cases (null vs empty string, JSON parse errors)
- The IndexedDB operations are async and race-condition-prone
- The WebSocket connection/reconnection logic is inherently stateful and error-prone

**Step 1: Write the tests FIRST**

Create `tests/lib/bridge.test.ts`:

```typescript
// tests/lib/bridge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";

// We'll import from bridge.ts once it exists

describe("bridge: token storage", () => {
  beforeEach(() => localStorage.clear());

  it("stores and retrieves a token", async () => {
    await storeToken("test-token-123");
    const token = await getToken();
    expect(token).toBe("test-token-123");
  });

  it("returns null when no token stored", async () => {
    const token = await getToken();
    expect(token).toBeNull();
  });

  it("clears a stored token", async () => {
    await storeToken("test-token");
    await clearToken();
    const token = await getToken();
    expect(token).toBeNull();
  });

  it("overwrites existing token", async () => {
    await storeToken("old-token");
    await storeToken("new-token");
    const token = await getToken();
    expect(token).toBe("new-token");
  });
});

describe("bridge: refresh token storage", () => {
  beforeEach(() => localStorage.clear());

  it("stores and retrieves refresh token separately from access token", async () => {
    await storeToken("access-token");
    await storeRefreshToken("refresh-token");
    expect(await getToken()).toBe("access-token");
    expect(await getRefreshToken()).toBe("refresh-token");
  });

  it("clearing access token does not clear refresh token", async () => {
    await storeToken("access");
    await storeRefreshToken("refresh");
    await clearToken();
    expect(await getToken()).toBeNull();
    expect(await getRefreshToken()).toBe("refresh");
  });
});

describe("bridge: API key storage", () => {
  beforeEach(() => localStorage.clear());

  it("stores and retrieves Seren API key", async () => {
    await storeSerenApiKey("sk-test-123");
    expect(await getSerenApiKey()).toBe("sk-test-123");
  });

  it("clears API key", async () => {
    await storeSerenApiKey("sk-test");
    await clearSerenApiKey();
    expect(await getSerenApiKey()).toBeNull();
  });
});

describe("bridge: provider key storage", () => {
  beforeEach(() => localStorage.clear());

  it("stores keys for different providers", async () => {
    await storeProviderKey("openai", "sk-openai-123");
    await storeProviderKey("anthropic", "sk-ant-456");
    expect(await getProviderKey("openai")).toBe("sk-openai-123");
    expect(await getProviderKey("anthropic")).toBe("sk-ant-456");
  });

  it("lists configured providers", async () => {
    await storeProviderKey("openai", "key1");
    await storeProviderKey("anthropic", "key2");
    const providers = await getConfiguredProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers.length).toBe(2);
  });

  it("clearing a provider key removes it from configured list", async () => {
    await storeProviderKey("openai", "key1");
    await storeProviderKey("anthropic", "key2");
    await clearProviderKey("openai");
    const providers = await getConfiguredProviders();
    expect(providers).not.toContain("openai");
    expect(providers).toContain("anthropic");
  });
});

describe("bridge: OAuth credentials", () => {
  beforeEach(() => localStorage.clear());

  it("stores and retrieves OAuth credentials as JSON string", async () => {
    const creds = JSON.stringify({ access_token: "abc", refresh_token: "def" });
    await storeOAuthCredentials("github", creds);
    expect(await getOAuthCredentials("github")).toBe(creds);
  });

  it("lists OAuth providers", async () => {
    await storeOAuthCredentials("github", "{}");
    await storeOAuthCredentials("google", "{}");
    const providers = await getOAuthProviders();
    expect(providers).toContain("github");
    expect(providers).toContain("google");
  });
});

describe("bridge: runtime detection", () => {
  it("returns false when no runtime is running", () => {
    expect(isRuntimeConnected()).toBe(false);
  });
});

describe("bridge: file operations require runtime", () => {
  it("listDirectory throws when runtime not connected", async () => {
    await expect(listDirectory("/tmp")).rejects.toThrow(/runtime/i);
  });

  it("readFile throws when runtime not connected", async () => {
    await expect(readFile("/tmp/test.txt")).rejects.toThrow(/runtime/i);
  });

  it("writeFile throws when runtime not connected", async () => {
    await expect(writeFile("/tmp/test.txt", "content")).rejects.toThrow(/runtime/i);
  });
});

describe("bridge: IndexedDB conversation storage", () => {
  beforeEach(async () => {
    await clearAllHistory();
  });

  it("creates and retrieves a conversation", async () => {
    const conv = await createConversation("conv-1", "Test Chat", "claude-3", "anthropic");
    expect(conv.id).toBe("conv-1");
    expect(conv.title).toBe("Test Chat");

    const retrieved = await getConversation("conv-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Test Chat");
    expect(retrieved!.selected_model).toBe("claude-3");
  });

  it("lists conversations excluding archived, newest first", async () => {
    await createConversation("conv-1", "First");
    await createConversation("conv-2", "Second");
    await archiveConversation("conv-1");

    const convs = await getConversations();
    expect(convs.length).toBe(1);
    expect(convs[0].id).toBe("conv-2");
  });

  it("updates conversation title", async () => {
    await createConversation("conv-1", "Old Title");
    await updateConversation("conv-1", "New Title");
    const conv = await getConversation("conv-1");
    expect(conv!.title).toBe("New Title");
  });

  it("deletes conversation and its messages", async () => {
    await createConversation("conv-1", "Test");
    await saveMessage("msg-1", "conv-1", "user", "Hello", null, Date.now());
    await saveMessage("msg-2", "conv-1", "assistant", "Hi", "claude-3", Date.now());

    await deleteConversation("conv-1");

    expect(await getConversation("conv-1")).toBeNull();
    const msgs = await getMessages("conv-1", 100);
    expect(msgs.length).toBe(0);
  });

  it("saves and retrieves messages in order", async () => {
    await createConversation("conv-1", "Test");
    const t1 = 1000;
    const t2 = 2000;
    await saveMessage("msg-1", "conv-1", "user", "First", null, t1);
    await saveMessage("msg-2", "conv-1", "assistant", "Second", "claude-3", t2);

    const msgs = await getMessages("conv-1", 100);
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("First");
    expect(msgs[1].content).toBe("Second");
  });

  it("respects message limit", async () => {
    await createConversation("conv-1", "Test");
    for (let i = 0; i < 10; i++) {
      await saveMessage(`msg-${i}`, "conv-1", "user", `Message ${i}`, null, i * 1000);
    }

    const msgs = await getMessages("conv-1", 5);
    expect(msgs.length).toBe(5);
  });

  it("clears conversation history without deleting the conversation", async () => {
    await createConversation("conv-1", "Test");
    await saveMessage("msg-1", "conv-1", "user", "Hello", null, Date.now());

    await clearConversationHistory("conv-1");

    expect(await getConversation("conv-1")).not.toBeNull();
    const msgs = await getMessages("conv-1", 100);
    expect(msgs.length).toBe(0);
  });

  it("clearAllHistory removes everything", async () => {
    await createConversation("conv-1", "Test");
    await saveMessage("msg-1", "conv-1", "user", "Hello", null, Date.now());

    await clearAllHistory();

    const convs = await getConversations();
    expect(convs.length).toBe(0);
  });
});
```

**Step 2: Run tests — they should ALL FAIL**

```bash
pnpm test tests/lib/bridge.test.ts
# EXPECTED: All tests fail (bridge.ts exports don't exist yet)
```

**Step 3: Implement bridge.ts**

Create `src/lib/bridge.ts` with these sections:

1. **Types** — Copy `FileEntry`, `Conversation`, `StoredMessage`, `SignX402Response`, `UsdcBalanceResponse` from `tauri-bridge.ts`. Keep the EXACT same interfaces.

2. **Runtime connection** — WebSocket to `ws://localhost:19420`:
   - `isRuntimeConnected()` → boolean
   - `connectToRuntime()` → Promise<boolean>
   - `disconnectRuntime()` → void
   - `runtimeInvoke<T>(method, params?)` → Promise<T> with 30s timeout
   - `onRuntimeEvent(event, callback)` → () => void (unsubscribe)

3. **Token storage** — All use localStorage:
   - `storeToken`, `getToken`, `clearToken`
   - `storeRefreshToken`, `getRefreshToken`, `clearRefreshToken`
   - Keys: `"seren_token"`, `"seren_refresh_token"`

4. **API key / org ID** — localStorage:
   - `storeSerenApiKey`, `getSerenApiKey`, `clearSerenApiKey` → key: `"seren_api_key"`
   - `storeDefaultOrganizationId`, `getDefaultOrganizationId`, `clearDefaultOrganizationId` → key: `"seren_default_org_id"`

5. **Provider keys** — localStorage with prefix `seren_provider_key_`:
   - `storeProviderKey(provider, key)`, `getProviderKey(provider)`, `clearProviderKey(provider)`
   - `getConfiguredProviders()` — iterate localStorage keys matching prefix

6. **OAuth credentials** — localStorage with prefix `seren_oauth_`:
   - `storeOAuthCredentials(provider, creds)`, `getOAuthCredentials(provider)`, `clearOAuthCredentials(provider)`
   - `getOAuthProviders()` — iterate keys
   - `listenForOAuthCallback()` — no-op in browser (returns empty cleanup fn)

7. **File system** — All require runtime, throw descriptive error if not connected:
   - `listDirectory`, `readFile`, `writeFile`, `pathExists`, `isDirectory`
   - `createFile`, `createDirectory`, `deletePath`, `renamePath`

8. **Crypto wallet** — Require runtime:
   - `storeCryptoPrivateKey`, `getCryptoWalletAddress`, `clearCryptoWallet`
   - `signX402Payment`, `getCryptoUsdcBalance`

9. **Conversations** — IndexedDB (browser-only mode):
   - DB name: `"seren"`, version: 1
   - Object stores: `"conversations"` (keyPath: `"id"`), `"messages"` (keyPath: `"id"`, index on `"conversation_id"`)
   - Implement: `createConversation`, `getConversations`, `getConversation`, `updateConversation`, `archiveConversation`, `deleteConversation`
   - Implement: `saveMessage`, `getMessages`, `clearConversationHistory`, `clearAllHistory`

**CRITICAL: What NOT to export:**
- Do NOT export `isTauriRuntime()` — this function doesn't exist anymore. Files that import it need to be fixed separately (Task 1.4).

**Step 4: Run tests — they should ALL PASS**

```bash
pnpm test tests/lib/bridge.test.ts
# EXPECTED: All green
```

**Step 5: Delete old file, update imports**

```bash
rm src/lib/tauri-bridge.ts

# Find and replace all imports
grep -rl "@/lib/tauri-bridge" src/ | xargs sed -i '' 's|@/lib/tauri-bridge|@/lib/bridge|g'
# On Linux, use: sed -i 's|...|...|g'

# Verify
grep -r "tauri-bridge" src/
# EXPECTED: No output
```

**Files to create:**
- `tests/lib/bridge.test.ts`
- `src/lib/bridge.ts`

**Files to delete:**
- `src/lib/tauri-bridge.ts`

**How to verify:**

```bash
pnpm test tests/lib/bridge.test.ts  # All pass
grep -r "tauri-bridge" src/          # Zero results
grep -r "isTauriRuntime" src/lib/bridge.ts  # Zero results (it's NOT exported)
```

**Commit:** `"Replace tauri-bridge.ts with browser-native bridge.ts (TDD)"`

**Security check:** Search bridge.ts for token logging:
```bash
grep -n "console.log.*token\|console.log.*key\|console.log.*secret" src/lib/bridge.ts
# EXPECTED: No output
```

---

### Task 1.3: Simplify fetch.ts

**What:** Simplify `src/lib/fetch.ts` to use browser-native `fetch()`. Remove all Tauri HTTP plugin references.

**Current state:** This file was already rewritten in the previous attempt. **Verify it's correct by reading it.**

**The correct implementation:**

```typescript
// ABOUTME: Fetch wrapper with automatic token refresh on 401.
// ABOUTME: Uses browser-native fetch. No Tauri dependency.

import { getToken } from "./bridge";

const NO_REFRESH_ENDPOINTS = ["/auth/login", "/auth/refresh", "/auth/signup"];

function shouldSkipRefresh(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return NO_REFRESH_ENDPOINTS.some((endpoint) => url.includes(endpoint));
}

export async function appFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
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

**Verify:**

```bash
grep -n "@tauri-apps" src/lib/fetch.ts
# EXPECTED: No output

grep -n "isTauriRuntime" src/lib/fetch.ts
# EXPECTED: No output
```

**Commit** (if changes needed): `"Simplify fetch wrapper for browser environment"`

---

### Task 1.4: Strip Tauri Imports — File by File

**What:** Rewrite each of the 21 files that import `@tauri-apps/*` directly. This is the most tedious task but also where most bugs will be introduced. **Do each file individually. Commit after every 2-3 files. Run `tsc --noEmit` after each file.**

**General rules for every file:**
- Remove ALL `@tauri-apps/*` imports
- Replace `invoke(command, args)` with `runtimeInvoke(command, args)` from `@/lib/bridge`
- Replace `listen(event, callback)` with `onRuntimeEvent(event, callback)` from `@/lib/bridge`
- Replace `type UnlistenFn` with `type UnlistenFn = () => void` (local type)
- Replace `open()` from `@tauri-apps/plugin-dialog` with HTML `<input type="file">` or runtime check
- Replace `openUrl()` with `window.open(url, "_blank", "noopener,noreferrer")`

**Order matters.** Do these in dependency order so TypeScript catches errors early:

#### Group A: Simple Replacements (commit after this group)

**File 1: `src/lib/external-link.ts`** — Already done. Verify:
```bash
grep "@tauri-apps" src/lib/external-link.ts  # Should be empty
```

**File 2: `src/index.tsx`** — Already done. Verify:
```bash
grep "@tauri-apps" src/index.tsx  # Should be empty
```

**File 3: `src/stores/updater.store.ts`** — Already done. Verify:
```bash
grep "@tauri-apps" src/stores/updater.store.ts  # Should be empty
```

**File 4: `src/api/client-config.ts`** — Already done. Verify:
```bash
grep "@tauri-apps" src/api/client-config.ts  # Should be empty
```

**File 5: `src/components/common/AboutDialog.tsx`**
- Remove `invoke` and `listen` from `@tauri-apps/api/core`
- Replace the `BuildInfo` type and `invoke("get_build_info")` call with hardcoded or env-based version info:
  ```typescript
  const buildInfo = {
    app_version: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
    build_type: import.meta.env.DEV ? "development" : "production",
    platform: "browser",
  };
  ```
- Replace the `listen("open-about", ...)` event with `window.addEventListener("open-about", ...)`
- Replace the `UnlistenFn` type with `() => void`

**File 6: `src/lib/commands/registry.ts`** (only line 242)
- Replace `import { emit } from "@tauri-apps/api/event"` with `window.dispatchEvent(new CustomEvent("open-about"))`

**Commit:** `"Strip Tauri from AboutDialog, commands registry"`

**Security check:**
```bash
pnpm exec tsc --noEmit 2>&1 | grep "error" | wc -l
# Note the count — it should be decreasing with each group
```

#### Group B: Fix Broken `isTauriRuntime` Imports (commit after this group)

These 3 files import `isTauriRuntime` from bridge, but bridge.ts doesn't export it. Replace with the correct browser logic.

**File 7: `src/services/oauth.ts`**
- Remove `import { isTauriRuntime } from "@/lib/bridge"`
- Every `if (isTauriRuntime())` block was for Tauri deep-link OAuth. Replace:
  - The Tauri branch (invoke + deep link) → delete entirely
  - Keep only the browser branch (standard redirect)
- **SECURITY: OAuth state parameter MUST be validated.** When starting OAuth:
  ```typescript
  const state = crypto.randomUUID();
  sessionStorage.setItem("oauth_state", state);
  ```
  When handling callback:
  ```typescript
  const expectedState = sessionStorage.getItem("oauth_state");
  if (params.get("state") !== expectedState) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }
  sessionStorage.removeItem("oauth_state");
  ```

**File 8: `src/stores/settings.store.ts`**
- Remove `import { isTauriRuntime } from "@/lib/bridge"`
- The `isTauriRuntime()` check was for using Tauri store vs localStorage. In browser, always use localStorage.
- Replace `if (!isTauriRuntime()) { /* use localStorage */ }` with just the localStorage path.

**File 9: `src/stores/provider.store.ts`**
- Remove `isTauriRuntime` from the import
- Same pattern as settings.store.ts — always use the localStorage path

**Commit:** `"Fix broken isTauriRuntime imports in oauth, settings, provider stores"`

#### Group C: Runtime-Dependent Stubs (commit after this group)

These files are 100% Tauri-dependent and won't work in browser-only mode. Create clean stubs that throw descriptive errors.

**File 10: `src/services/acp.ts`** (451 LOC)
- Remove `invoke` and `listen` from `@tauri-apps/api/core`
- Import `runtimeInvoke`, `onRuntimeEvent`, `isRuntimeConnected` from `@/lib/bridge`
- **Keep all type definitions and interfaces** — they're used by acp.store.ts and components
- Replace every function body:
  ```typescript
  function requireRuntime(): void {
    if (!isRuntimeConnected()) {
      throw new Error("ACP agents require the local runtime. Install: curl -fsSL https://seren.com/install | sh");
    }
  }

  export async function spawnAgent(agentType: AgentType, cwd: string, sandboxMode?: string): Promise<AcpSessionInfo> {
    requireRuntime();
    return runtimeInvoke<AcpSessionInfo>("acp_spawn", { agentType, cwd, sandboxMode: sandboxMode ?? null });
  }

  // ... same pattern for all other functions
  ```
- For `subscribeToEvent` and `subscribeToSession`, replace `listen()` with `onRuntimeEvent()`:
  ```typescript
  export async function subscribeToEvent<T extends { sessionId: string }>(
    eventType: EventType,
    callback: (data: T) => void,
  ): Promise<() => void> {
    const channel = EVENT_CHANNELS[eventType];
    return onRuntimeEvent(channel, (data) => callback(data as T));
  }
  ```
- The `UnlistenFn` type was from Tauri. Replace with `() => void` everywhere.

**File 11: `src/services/openclaw-agent.ts`**
- Same pattern as acp.ts — import from bridge, check `isRuntimeConnected()`, replace invoke/listen

**File 12: `src/services/indexing.ts`**
- Replace `invoke` with `runtimeInvoke` from bridge
- Add runtime check

**File 13: `src/services/mcp-oauth.ts`**
- Replace `invoke` with `runtimeInvoke` from bridge
- This may need to work without runtime if it's used for Gateway MCP OAuth — check the usage

**Commit:** `"Stub ACP, OpenClaw, indexing, MCP-OAuth services for browser"`

#### Group D: Store Rewrites (commit after this group)

**File 14: `src/stores/openclaw.store.ts`** (389 LOC)
- Remove `invoke` and `listen` from `@tauri-apps/api/core`
- Import `runtimeInvoke`, `onRuntimeEvent`, `isRuntimeConnected` from `@/lib/bridge`
- Keep ALL type definitions (`ProcessStatus`, `ChannelStatus`, `OpenClawChannel`, etc.)
- Keep the store shape and getters (they're used by UI components)
- Stub `setupEventListeners()`:
  ```typescript
  async function setupEventListeners() {
    if (!isRuntimeConnected()) return;
    // Only set up listeners when runtime is available
    unlistenStatus = onRuntimeEvent("openclaw://status-changed", (payload) => {
      const data = payload as { status: ProcessStatus };
      setState("processStatus", data.status);
    });
    // ... same for other events
  }
  ```
- Stub all invoke calls with runtime checks:
  ```typescript
  async start() {
    if (!isRuntimeConnected()) {
      console.warn("[OpenClaw Store] Runtime not connected, cannot start");
      return;
    }
    await runtimeInvoke("openclaw_start");
    // ...
  }
  ```
- The `init()` method should call `setupEventListeners()` silently (no error if no runtime)
- Replace `invoke("get_setting", ...)` with `localStorage.getItem("openclaw_setup_complete")`
- Replace `invoke("set_setting", ...)` with `localStorage.setItem("openclaw_setup_complete", "true")`

**File 15: `src/stores/sync.store.ts`** (165 LOC)
- Remove all Tauri imports
- Import `runtimeInvoke`, `onRuntimeEvent`, `isRuntimeConnected` from `@/lib/bridge`
- Add runtime checks to `startWatching`, `stopWatching`, `refresh`
- Stub event listeners — only set up when runtime connected

**File 16: `src/stores/acp.store.ts`**
- Remove `import type { UnlistenFn } from "@tauri-apps/api/event"`
- Add local type: `type UnlistenFn = () => void;`
- The rest of the file uses `acpService.*` which we already stubbed in File 10

**File 17: `src/stores/fileTree.ts`**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Import `listDirectory` from `@/lib/bridge`
- Replace `invoke<FileEntry[]>("list_directory", { path })` with `listDirectory(path)`:
  ```typescript
  export async function refreshDirectory(path: string): Promise<void> {
    try {
      const entries = await listDirectory(path);
      const children = entries.map(entryToNode);
      if (path === fileTreeState.rootPath) {
        setNodes(children);
      } else {
        setNodeChildren(path, children);
      }
    } catch (err) {
      console.error("Failed to refresh directory:", err);
    }
  }
  ```

**Commit:** `"Rewrite stores to use bridge instead of Tauri IPC"`

#### Group E: Library Rewrites (commit after this group)

**File 18: `src/lib/mcp/client.ts`**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Import `runtimeInvoke`, `isRuntimeConnected` from `@/lib/bridge`
- **Stdio MCP methods** (`connect`, `disconnect`, `listTools`, `callTool`, etc.):
  - Add runtime check
  - Replace `invoke("mcp_connect", ...)` with `runtimeInvoke("mcp_connect", ...)`
  - Same for all other stdio operations
- **HTTP MCP methods** (`connectHttp`, `disconnectHttp`, `listToolsHttp`, `callToolHttp`):
  - These currently go through Tauri's Rust HTTP client
  - **Rewrite to use browser `fetch()` directly** — MCP HTTP transport is standard JSON-RPC over HTTP
  - This is covered in detail in Task 1.7

**File 19: `src/lib/files/service.ts`**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Remove `import { open, save } from "@tauri-apps/plugin-dialog"`
- Import `readFile`, `writeFile`, `listDirectory`, `createFile`, `createDirectory`, `deletePath`, `renamePath`, `isRuntimeConnected` from `@/lib/bridge`
- Replace all `invoke("read_file", { path })` with `readFile(path)` etc.
- Replace `open()` file dialog with a helper that uses `<input type="file">`:
  ```typescript
  export function pickFile(accept?: string): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (accept) input.accept = accept;
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }

  export function pickDirectory(): Promise<string | null> {
    if (!isRuntimeConnected()) {
      console.warn("Directory picker requires local runtime");
      return Promise.resolve(null);
    }
    // With runtime, use a runtime command to show native dialog
    return runtimeInvoke<string | null>("pick_directory");
  }
  ```
- Replace `save()` dialog similarly

**File 20: `src/lib/images/attachments.ts`**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Remove `import { open } from "@tauri-apps/plugin-dialog"`
- Replace `pickImageFiles()` with HTML file input:
  ```typescript
  export function pickImageFiles(): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = SUPPORTED_EXTENSIONS.map(ext => `.${ext}`).join(",");
      input.onchange = () => resolve(Array.from(input.files ?? []));
      input.click();
    });
  }
  ```
- Replace `readImageAttachment(path)` with `readImageFile(file: File)`:
  ```typescript
  export async function readImageFile(file: File): Promise<ImageAttachment> {
    const ext = getExtension(file.name);
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) throw new Error(`Unsupported image format: .${ext}`);

    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    if (base64.length > MAX_BASE64_SIZE) throw new Error("Image too large (max 20MB)");

    return { name: file.name, mimeType, base64 };
  }
  ```
- **NOTE:** This changes the API from path-based to File-based. Check all callers and update them.

**File 21: `src/lib/tools/executor.ts`**
- Remove `import { invoke } from "@tauri-apps/api/core"` and `listen`/`UnlistenFn`
- Import `runtimeInvoke`, `onRuntimeEvent`, `isRuntimeConnected` from `@/lib/bridge`
- Replace invoke calls with runtimeInvoke
- Gateway tool calls should work without runtime (they use HTTP)
- Local tool calls (file operations) need runtime checks

**File 22: `src/lib/indexing/orchestrator.ts`**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Import `runtimeInvoke`, `isRuntimeConnected` from `@/lib/bridge`
- Add runtime check at top of main function

**Commit:** `"Rewrite MCP client, file service, attachments, tools, indexing for browser"`

#### Group F: Component Rewrites (commit after this group)

**File 23: `src/components/sidebar/FileTree.tsx`**
- Remove `import { invoke } from "@tauri-apps/api/core"`
- Import needed functions from `@/lib/bridge` or `@/lib/files/service`
- Replace invoke calls in context menu handlers (rename, delete, new file, new folder) with bridge functions

**File 24: `src/components/sidebar/FileExplorerPanel.tsx`**
- Remove `import { open } from "@tauri-apps/plugin-dialog"`
- The folder picker needs runtime. When no runtime, show a message instead of a picker.

**File 25: `src/components/editor/ImageViewer.tsx`**
- Remove `import { convertFileSrc } from "@tauri-apps/api/core"`
- Replace with standard URL handling. If the image is a local file, it needs the runtime to read it and convert to a data URL.

**File 26: `src/components/settings/OpenClawApproval.tsx`**
- Remove `invoke` and `listen` from `@tauri-apps/api/core`
- Import from bridge
- Add runtime checks — component should render nothing if no runtime

**File 27: `src/services/publisher-oauth.ts`**
- Remove `import { openUrl } from "@tauri-apps/plugin-opener"`
- Replace `openUrl(location)` with `window.open(location, "_blank", "noopener,noreferrer")`
- Replace any remaining `invoke()` calls with appropriate bridge functions

**Commit:** `"Strip Tauri from all remaining components and services"`

#### Verification (MUST PASS before moving on)

```bash
# Zero Tauri imports remaining
grep -r "@tauri-apps" src/ --include="*.ts" --include="*.tsx"
# EXPECTED: No output

# TypeScript compiles
pnpm exec tsc --noEmit
# EXPECTED: Zero errors (or only errors unrelated to Tauri)

# Biome passes
pnpm check
# EXPECTED: Clean

# Tests pass
pnpm test
# EXPECTED: All pass

# Dev server starts
pnpm dev
# EXPECTED: Vite serves on localhost:3000

# Build succeeds
pnpm build
# EXPECTED: dist/ directory with working static build
```

**If any check fails, fix it before proceeding. Do not move to the next task.**

---

### Task 1.5: Implement Browser OAuth Flow

**What:** Replace Tauri deep link OAuth with standard browser redirect OAuth.

**Current flow (Tauri):**
1. App calls `get_oauth_redirect_url` via Rust to fetch the auth URL
2. Opens system browser with `openUrl`
3. Listens for `oauth-callback` Tauri event (from deep link `seren://oauth/callback`)
4. Extracts tokens from callback URL

**New flow (browser):**
1. App builds the auth URL with `redirect_uri=https://app.seren.com/oauth/callback`
2. Navigates: `window.location.href = authUrl`
3. After auth, provider redirects back to `/oauth/callback?code=...&state=...`
4. App detects the callback URL params on page load, exchanges code for tokens

**Steps:**

1. Update `src/services/oauth.ts`:
   - Remove all Tauri code (already done in Task 1.4 File 7)
   - Ensure OAuth state parameter is generated and validated (CSRF protection)
   - Use `window.location.href = authUrl` to navigate

2. Create or update OAuth callback handling in `App.tsx`:
   ```typescript
   onMount(async () => {
     // Check if this is an OAuth callback
     const params = new URLSearchParams(window.location.search);
     if (params.has("code") && params.has("state")) {
       try {
         await handleOAuthCallback(params);
       } catch (e) {
         console.error("[OAuth] Callback error:", e);
       }
       // Clear URL params so refresh doesn't re-trigger
       window.history.replaceState({}, "", "/");
       return;
     }
     // ... rest of init
   });
   ```

3. **SECURITY REQUIREMENTS for OAuth:**
   - Generate `state` parameter using `crypto.randomUUID()` before redirect
   - Store state in `sessionStorage` (NOT localStorage — sessionStorage is tab-scoped)
   - On callback, validate `state` matches before exchanging code
   - NEVER log the authorization code or tokens
   - Clear `state` from sessionStorage after use

**Files to modify:**
- `src/services/oauth.ts`
- `src/services/publisher-oauth.ts`
- `src/App.tsx`

**How to test:**
- Manual: Click "Login with GitHub" → should redirect → should come back logged in
- Check browser console for CORS errors during token exchange
- Verify: If you tamper with the `state` parameter, login should FAIL

**Commit:** `"Implement browser-native OAuth flow with CSRF protection"`

---

### Task 1.6: Rewrite MCP HTTP Client for Browser

**What:** The MCP Gateway client currently routes HTTP calls through Tauri's Rust backend. Rewrite HTTP MCP methods to use browser `fetch()`.

**Background:** MCP (Model Context Protocol) over HTTP uses JSON-RPC. Each call is a POST with a JSON body. The Seren Gateway at `mcp.serendb.com/mcp` accepts these requests with Bearer token auth.

**Read these files first:**
- `src/lib/mcp/client.ts` — the current client (see which methods exist)
- `src/lib/mcp/types.ts` — MCP type definitions
- The MCP specification for HTTP transport: https://spec.modelcontextprotocol.io/specification/basic/transports/#streamable-http

**Steps:**

1. In `src/lib/mcp/client.ts`, identify all HTTP MCP methods. They typically have names like `connectHttp`, `listToolsHttp`, `callToolHttp`, `disconnectHttp`.

2. Rewrite each to use `fetch()`:
   ```typescript
   async function mcpHttpPost(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
     const token = await getSerenApiKey();
     const response = await fetch(url, {
       method: "POST",
       headers: {
         "Content-Type": "application/json",
         ...(token ? { Authorization: `Bearer ${token}` } : {}),
       },
       body: JSON.stringify({
         jsonrpc: "2.0",
         method,
         params: params ?? {},
         id: String(++requestCounter),
       }),
     });

     if (!response.ok) {
       throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
     }

     const result = await response.json();
     if (result.error) {
       throw new Error(`MCP error: ${result.error.message}`);
     }
     return result.result;
   }
   ```

3. For SSE streaming (if used), use `EventSource` or `fetch()` with readable stream.

4. Stdio MCP methods should check `isRuntimeConnected()` and route through `runtimeInvoke()`.

**How to test:**
```bash
# Manual: Login → go to catalog → tools should load from Gateway
# Check browser Network tab for MCP requests to mcp.serendb.com
# Tool count should match what seren-desktop shows (~90+ tools)
```

**Commit:** `"Rewrite MCP HTTP client for browser fetch"`

---

### Task 1.7: Clean Up App.tsx and Entry Points

**What:** Remove Tauri-specific initialization from `App.tsx`.

**Steps:**

1. In `src/App.tsx`:
   - The `updaterStore.initUpdater()` call should already be a no-op (Task 1.4)
   - The `openclawStore.init()` should silently succeed (Task 1.4)
   - The `startOpenClawAgent()` should silently no-op (Task 1.4)
   - Add runtime connection attempt:
     ```typescript
     import { connectToRuntime } from "@/lib/bridge";

     onMount(async () => {
       // Try connecting to local runtime (non-blocking)
       connectToRuntime().then((connected) => {
         if (connected) {
           console.log("[App] Local runtime connected");
         }
       });
       // ... rest of existing init
     });
     ```
   - Add OAuth callback check (from Task 1.5)

2. Verify `index.html` doesn't reference any Tauri scripts.

**How to test:**
```bash
pnpm dev
# Open http://localhost:3000
# Console should NOT show any Tauri-related errors
# Should see either "Local runtime connected" or nothing (no error)
```

**Commit:** `"Clean up app initialization for browser environment"`

---

### Task 1.8: Configure Deployment

**What:** Set up static site deployment.

**Steps:**

1. Verify build:
   ```bash
   pnpm build
   pnpm preview  # Serves built files locally
   # Open http://localhost:4173 — app should work
   ```

2. Add SPA routing config. For Vercel, create `vercel.json`:
   ```json
   { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
   ```
   For Cloudflare Pages, create `public/_redirects`:
   ```
   /* /index.html 200
   ```

3. Set up environment variables:
   - `VITE_SEREN_API_URL` — defaults to `https://api.serendb.com`
   - `VITE_APP_VERSION` — set in CI from package.json version

**Commit:** `"Add deployment configuration"`

---

### Phase 1 Complete Checklist

**ALL of these must pass before moving to Phase 2:**

```bash
# 1. Zero Tauri imports
grep -r "@tauri-apps" src/ --include="*.ts" --include="*.tsx" | wc -l
# EXPECTED: 0

# 2. TypeScript compiles clean
pnpm exec tsc --noEmit
# EXPECTED: 0 errors

# 3. Biome passes
pnpm check
# EXPECTED: Clean

# 4. All tests pass
pnpm test
# EXPECTED: All green

# 5. Build succeeds
pnpm build
# EXPECTED: dist/ created

# 6. No secrets in source
grep -r "sk-\|api_key.*=.*[\"'][a-zA-Z]\|password.*=.*[\"'][a-zA-Z]" src/ --include="*.ts" --include="*.tsx"
# EXPECTED: No output (or only type definitions/variable names, not actual values)
```

**Manual checks:**
- [ ] App loads in browser without console errors
- [ ] Login flow works (email/password)
- [ ] OAuth login works (GitHub)
- [ ] Chat sends messages and receives responses
- [ ] Gateway MCP tools appear in catalog
- [ ] Gateway tool execution works
- [ ] Conversations persist across page reloads (IndexedDB)
- [ ] File explorer shows "runtime required" message (or empty state)
- [ ] ACP shows "runtime required" message (or empty state)

---

## 8. Phase 2: Local Runtime Server

**Goal:** Build the Node.js server that runs on `localhost` and provides ACP, OpenClaw, local MCP, and file system capabilities to the browser SPA.

### Task 2.1: Initialize Runtime Package

**What:** Create `runtime/` directory with Node.js project.

**Steps:**

1. Create `runtime/package.json`:
   ```json
   {
     "name": "@serendb/runtime",
     "version": "0.1.0",
     "description": "Seren local runtime — enables ACP agents, local MCP, and file access",
     "type": "module",
     "bin": { "seren": "./bin/seren.js" },
     "scripts": {
       "dev": "tsx src/server.ts",
       "build": "tsup src/server.ts --format esm --target node20",
       "start": "node dist/server.js",
       "test": "vitest"
     },
     "engines": { "node": ">=20.0.0" }
   }
   ```

2. Install deps: `pnpm add ws` and `pnpm add -D tsx tsup typescript @types/ws @types/node vitest`

3. Create `runtime/src/server.ts`:
   ```typescript
   // ABOUTME: Local runtime server for Seren Browser.
   // ABOUTME: HTTP + WebSocket server on localhost, bridges browser to local capabilities.

   import { createServer } from "node:http";
   import { WebSocketServer } from "ws";

   const PORT = Number(process.env.SEREN_PORT) || 19420;

   const httpServer = createServer((req, res) => {
     // SECURITY: Only allow localhost connections
     const remoteAddr = req.socket.remoteAddress;
     if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
       res.writeHead(403);
       res.end("Forbidden: only localhost connections allowed");
       return;
     }

     // CORS headers for browser
     res.setHeader("Access-Control-Allow-Origin", "*"); // localhost is safe
     res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
     res.setHeader("Access-Control-Allow-Headers", "Content-Type");

     if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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
     const remoteAddr = req.socket.remoteAddress;
     if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
       ws.close(4003, "Forbidden");
       return;
     }

     console.log("[Runtime] Browser connected");
     ws.on("message", async (data) => {
       // Handle JSON-RPC — implemented in Task 2.2
     });
     ws.on("close", () => console.log("[Runtime] Browser disconnected"));
   });

   httpServer.listen(PORT, "127.0.0.1", () => {
     console.log(`[Seren Runtime] Listening on http://127.0.0.1:${PORT}`);
   });
   ```

   **SECURITY NOTE:** The server binds to `127.0.0.1`, NOT `0.0.0.0`. It also verifies `remoteAddress` on every connection. This prevents other machines on the network from accessing the runtime.

4. Create `runtime/bin/seren.js`:
   ```javascript
   #!/usr/bin/env node
   import "../dist/server.js";
   ```

**How to test:**
```bash
cd runtime && pnpm dev
# In another terminal:
curl http://localhost:19420/health
# EXPECTED: {"status":"ok","version":"0.1.0"}

# SECURITY: Verify external access is blocked
# From another machine on the same network, try:
curl http://<your-ip>:19420/health
# EXPECTED: Connection refused (server only listens on 127.0.0.1)
```

**Commit:** `"Initialize local runtime server package"`

---

### Task 2.2: Implement JSON-RPC Command Router (TDD)

**What:** Build the command routing layer for JSON-RPC messages over WebSocket.

**Write tests first** in `runtime/tests/rpc.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { handleMessage, registerHandler } from "../src/rpc";

describe("JSON-RPC router", () => {
  it("dispatches to registered handler and returns result", async () => {
    registerHandler("test_echo", async (params) => params);
    const result = await handleMessage(JSON.stringify({
      jsonrpc: "2.0", method: "test_echo", params: { msg: "hello" }, id: "1"
    }));
    const parsed = JSON.parse(result);
    expect(parsed.result).toEqual({ msg: "hello" });
    expect(parsed.id).toBe("1");
  });

  it("returns parse error for invalid JSON", async () => {
    const result = await handleMessage("not json");
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(-32700);
  });

  it("returns method not found for unknown method", async () => {
    const result = await handleMessage(JSON.stringify({
      jsonrpc: "2.0", method: "nonexistent", id: "2"
    }));
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(-32601);
  });

  it("returns error when handler throws", async () => {
    registerHandler("test_throw", async () => { throw new Error("boom"); });
    const result = await handleMessage(JSON.stringify({
      jsonrpc: "2.0", method: "test_throw", id: "3"
    }));
    const parsed = JSON.parse(result);
    expect(parsed.error.message).toBe("boom");
  });
});
```

**Implement** `runtime/src/rpc.ts` and `runtime/src/events.ts` (for server→browser event pushing).

**Commit:** `"Implement JSON-RPC command router for runtime (TDD)"`

---

### Task 2.3: Implement File System Handlers (TDD)

**What:** Port file system operations from Rust to Node.js.

**Write tests first** in `runtime/tests/handlers/fs.test.ts` — use a temp directory, test all operations, clean up.

**Implement** `runtime/src/handlers/fs.ts`.

**SECURITY — Path traversal prevention:**
```typescript
import { resolve } from "node:path";
import { homedir } from "node:os";

function validatePath(requestedPath: string): string {
  const resolved = resolve(requestedPath);
  // Ensure path is within user's home directory
  if (!resolved.startsWith(homedir())) {
    throw new Error(`Access denied: path must be within home directory`);
  }
  return resolved;
}
```

**Commit:** `"Implement file system handlers in local runtime (TDD)"`

---

### Task 2.4: Wire Browser Bridge to Local Runtime

**What:** Complete the WebSocket connection in `bridge.ts` so operations route to the runtime when available.

**Steps:**

1. Implement `connectToRuntime()` with timeout and error handling
2. Implement `runtimeInvoke()` with pending request tracking
3. Implement `handleRuntimeEvent()` to dispatch server-pushed events
4. Update `App.tsx` to try connecting on mount

**How to test:**
```bash
# Terminal 1: Start runtime
cd runtime && pnpm dev

# Terminal 2: Start SPA
pnpm dev

# Browser console should show "Local runtime connected"
# File explorer should list directories
```

**Commit:** `"Wire browser bridge to local runtime WebSocket"`

---

### Task 2.5: Implement Runtime Conversation Storage

**What:** Add SQLite conversation storage in the runtime.

Add `better-sqlite3` to runtime. Create `runtime/src/handlers/chat.ts`. Update bridge.ts to route conversation operations to runtime when connected, IndexedDB when not.

**Commit:** `"Implement SQLite conversation storage in local runtime"`

---

## 9. Phase 3: Install Scripts

(Same as original plan — see Section 8 in original. No changes needed.)

One-line install commands:
- macOS/Linux: `curl -fsSL https://seren.com/install | sh`
- Windows: `irm https://seren.com/install.ps1 | iex`

**Commit:** `"Add cross-platform install scripts"`

---

## 10. Phase 4: ACP Agent Support

Port ACP agent spawning from Rust to Node.js runtime. See original plan Phase 4.

**Key difference from original plan:** The frontend service (`src/services/acp.ts`) was already rewritten in Task 1.4 to use `runtimeInvoke`/`onRuntimeEvent`. Phase 4 only needs the runtime-side handler.

**Commit:** `"Implement ACP agent spawning in local runtime"`

---

## 11. Phase 5: OpenClaw via Local Runtime

Port OpenClaw process management from Rust to Node.js runtime. See original plan Phase 5.

**Commit:** `"Implement OpenClaw process management in local runtime"`

---

## 12. Phase 6: Crypto Wallet

Port x402 wallet signing from Rust to JavaScript using `viem`. See original plan Phase 6.

**Commit:** `"Implement x402 wallet signing in local runtime"`

---

## 13. Phase 7: Embed SPA into Runtime

**Goal:** Bundle the SPA build output into the `@serendb/runtime` npm package so `seren` serves the full app on `localhost:19420`. No external hosting needed. Users run one install command and `seren` opens the app in their browser.

**Status:** Complete

### Why

The original plan assumed the SPA would be hosted externally (e.g., `app.seren.com`). This was rejected — Seren should not host any user-facing infrastructure beyond the Gateway API. Instead, the SPA is embedded in the runtime and served locally.

### What Changed

#### 7.1: Build Pipeline (`build:embed` script)

Added `build:embed` to root `package.json`:
```sh
pnpm build:embed   # vite build && rm -rf runtime/public && cp -r dist runtime/public
```

This builds the SPA and copies the output into `runtime/public/` so the runtime npm package includes it.

Added `"public/"` to the `files` array in `runtime/package.json` so npm includes the built SPA when publishing.

#### 7.2: Static File Serving in Runtime Server

Modified `runtime/src/server.ts` to serve the embedded SPA:

- **Static file serving** — MIME type detection for `.html`, `.js`, `.css`, `.json`, `.svg`, `.png`, `.woff2`, `.wasm`, etc.
- **SPA fallback routing** — Any path that doesn't match a static file serves `index.html` (client-side routing)
- **Path traversal protection** — Resolved paths must stay within `PUBLIC_DIR`
- **Cache headers** — `Cache-Control: public, max-age=31536000, immutable` for hashed assets; `no-cache` for `index.html`

#### 7.3: Auto-Open Browser on Startup

On `httpServer.listen`, the runtime:
1. Detects if `runtime/public/index.html` exists
2. If yes, opens `http://127.0.0.1:19420` in the default browser using platform-detected commands (`open` on macOS, `xdg-open` on Linux, `start` on Windows)
3. Suppressed with `--no-open` flag (for CI/headless use)

### Files Modified

- `runtime/src/server.ts` — static file serving, SPA fallback, auto-open browser
- `runtime/package.json` — `public/` in `files` array
- `package.json` (root) — `build:embed` script

### Verification

1. `pnpm build:embed` — builds SPA and copies to `runtime/public/`
2. `cd runtime && pnpm dev` — runtime starts, browser opens
3. `http://localhost:19420` — SPA loads
4. `http://localhost:19420/health` — returns JSON health check
5. `http://localhost:19420/chat/any-id` — SPA fallback works (serves index.html)
6. WebSocket auth + RPC still works
7. `cd runtime && pnpm test` — 50 tests pass

---

## 14. Phase 8: Feature Parity with Desktop

**Goal:** Port any features added to `seren-desktop` after the initial migration so the browser version stays current.

**Status:** In Progress

### Features Ported

#### 8.1: Tool Result Formatting

Ported `src/lib/format-tool-result.ts` from seren-desktop. This utility:
- Pretty-prints JSON in tool result displays
- Unescapes `\n`, `\t`, `\"` for human-readable output

Updated 3 components to use `formatToolResultText()`:
- `src/components/chat/ToolStreamingMessage.tsx`
- `src/components/mcp/McpToolCallApproval.tsx`
- `src/components/mcp/McpToolsPanel.tsx`

#### 8.2: External Link Interceptor

Added `installExternalLinkInterceptor()` to `src/lib/external-link.ts`. This global click handler intercepts all anchor tag clicks with `https://` URLs and routes them through `openExternalLink()` (which uses `window.open` with `noopener,noreferrer`).

Called at app startup in `src/index.tsx`.

#### 8.3: Chat Scroll-on-Channel-Switch Fix

Added `acpStore.agentModeEnabled` to the scroll effect dependencies in `src/components/chat/ChatContent.tsx`. This ensures the chat scrolls to bottom when switching between chat and agent channels.

---

## 15. What Gets Deleted

These items from `seren-desktop` are NOT ported:

| Item | Reason |
|------|--------|
| `src-tauri/` (all Rust code) | Replaced by Node.js runtime |
| `build/` (platform runtime scripts) | No platform builds |
| `scripts/build-openclaw.ts` | OpenClaw builds separately |
| `scripts/build-sidecar.ts` | No sidecars |
| `embedded-runtime/` | No bundled Node.js/Git |
| All `@tauri-apps/*` packages | No Tauri |
| Tauri config files | No Tauri |
| Code signing workflows | No signing needed |
| Platform-specific CI/CD | No platform builds |

---

## 16. Testing Strategy

### Unit Tests (Vitest)

**TDD REQUIRED for:**
- `src/lib/bridge.ts` — token storage, runtime connection, runtimeInvoke timeout, IndexedDB operations
- `runtime/src/rpc.ts` — JSON-RPC parsing, routing, error handling
- `runtime/src/handlers/fs.ts` — file system operations with path validation
- `runtime/src/handlers/wallet.ts` — key storage, signing, balance query

**NOT required for:**
- UI components (test manually or with E2E)
- Simple CRUD wrappers
- Mocked behavior (don't mock the runtime — test against real runtime or skip)

### Test Design Rules

**Follow these exactly. Violating them will create flaky, useless tests.**

1. **Test the contract, not the implementation.** If `storeToken("abc")` then `getToken()` returns `"abc"`, the test passes. Don't assert that `localStorage.setItem` was called.

2. **Use real dependencies.** For file system tests, use `os.tmpdir()`. For IndexedDB, use `fake-indexeddb`. Don't mock `fs` or `localStorage`.

3. **One behavior per test.** A test named `"stores and retrieves token"` tests exactly that. Don't also test error handling.

4. **Test error paths explicitly.** Separate tests for: "read nonexistent file throws" and "read valid file returns contents".

5. **Clean up after tests.** Delete temp files. Clear localStorage. Clear IndexedDB. Close WebSocket connections. Use `beforeEach`/`afterEach`.

6. **No test interdependence.** Tests must pass when run individually: `pnpm test -- --grep "specific test name"`

7. **No `any` types in tests.** Type your test data.

8. **No `console.log` in tests.** If you need to debug, use `console.error` and remove it before committing.

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

# Unit tests with coverage
pnpm test -- --coverage

# E2E tests (browser-only mode)
pnpm test:e2e

# E2E tests (with runtime)
cd runtime && pnpm dev &
pnpm test:e2e
```

---

## 17. Deployment

### SPA (Browser App)

- **Build:** `pnpm build` → static files in `dist/`
- **Host:** Vercel, Cloudflare Pages, or any static CDN
- **Domain:** `app.seren.com`
- **SSL:** Required (HTTPS)
- **SPA routing:** All paths → `index.html`

### Runtime (npm Package)

- **Publish:** `cd runtime && npm publish` → `@serendb/runtime` on npm
- **Install:** `npm install -g @serendb/runtime`
- **Run:** `seren`
- **Update:** `npm update -g @serendb/runtime`

### Install Scripts

- **Host:** `seren.com/install` → serves `install.sh`
- **Host:** `seren.com/install.ps1` → serves PowerShell script

---

## 18. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| **CORS not configured on Gateway API** | Blocks Phase 1 entirely | High | Coordinate with backend team BEFORE starting. #1 blocker. |
| **OAuth redirect URL not registered** | Blocks login via OAuth | Medium | Register with GitHub, Google before starting. |
| **MCP HTTP transport incompatible with browser fetch** | Blocks Gateway MCP | Low | MCP uses standard HTTP/SSE. Test early. |
| **localhost WebSocket blocked by browser** | Blocks runtime connection | Low | Browsers explicitly allow `ws://localhost`. |
| **Mixed content (HTTPS → HTTP localhost)** | Blocks runtime connection | Low | Browsers allow `http://localhost`. Explicit spec exception. |
| **Port 19420 in use** | Runtime fails to start | Low | Try multiple ports, make configurable. |
| **Node.js not on user's machine** | Install script complexity | Medium | Install scripts download Node.js. |
| **XSS via chat message rendering** | Token theft, account compromise | Medium | Use textContent or DOMPurify. NEVER innerHTML with user data. |
| **Path traversal in runtime** | Arbitrary file read/write | Medium | Validate all paths resolve within home directory. |
| **OAuth CSRF** | Account takeover | Medium | Validate state parameter on every OAuth callback. |
| **Token logging** | Credential exposure | Medium | Search for console.log with tokens before every commit. |

---

## 19. Final Audit Checklist

**Run this audit after all phases are complete and before any production deployment.**

### Security Audit

```bash
# 1. No secrets in source
grep -rn "sk-\|api_key.*=.*['\"][a-zA-Z]" src/ runtime/ --include="*.ts" --include="*.tsx" --include="*.js"

# 2. No innerHTML with user data
grep -rn "innerHTML" src/ --include="*.ts" --include="*.tsx"
# Review each match — ensure user data is NOT being injected

# 3. No eval or Function constructor
grep -rn "eval(\|new Function" src/ runtime/ --include="*.ts" --include="*.tsx" --include="*.js"

# 4. No console.log with tokens
grep -rn "console.log.*token\|console.log.*key\|console.log.*secret\|console.log.*password" src/ runtime/ --include="*.ts" --include="*.tsx" --include="*.js"

# 5. Runtime binds to localhost only
grep -rn "0\.0\.0\.0\|listen.*0\.0\.0\.0" runtime/ --include="*.ts" --include="*.js"
# EXPECTED: No output

# 6. Path traversal protection
grep -rn "validatePath\|homedir" runtime/src/handlers/fs.ts
# EXPECTED: Path validation exists in every file handler

# 7. OAuth state validation
grep -rn "oauth_state\|state.*mismatch" src/ --include="*.ts" --include="*.tsx"
# EXPECTED: State parameter is generated, stored, and validated
```

### Functional Audit

- [ ] `pnpm exec tsc --noEmit` — zero errors
- [ ] `pnpm check` — Biome passes
- [ ] `pnpm build` — succeeds
- [ ] `pnpm test` — all pass
- [ ] `cd runtime && pnpm test` — all pass
- [ ] Zero `@tauri-apps` imports in `src/`
- [ ] App loads in browser, no console errors
- [ ] Login works (email/password)
- [ ] Login works (OAuth GitHub)
- [ ] Chat sends and receives messages
- [ ] Gateway MCP tools load and execute
- [ ] Conversations persist across page reload
- [ ] With runtime: file explorer works
- [ ] With runtime: ACP agent spawns
- [ ] With runtime: OpenClaw starts
- [ ] Install script works on macOS
- [ ] Install script works on Linux
- [ ] Install script works on Windows

### Performance Audit

- [ ] `pnpm build` output is under 5MB (excluding Monaco)
- [ ] First page load is under 3 seconds on 4G
- [ ] Chat response starts streaming within 2 seconds of send

---

## Task Dependency Graph

```
Phase 1 (Browser SPA)
  1.1 → 1.2 (TDD) → 1.3 → 1.4 (Groups A-F) → 1.7 → 1.8
                       1.2 → 1.5 (can parallel with 1.3-1.4)
                       1.4 → 1.6 (after Tauri imports removed)

Phase 2 (Runtime Server)  — can start after 1.2
  2.1 → 2.2 (TDD) → 2.3 (TDD) → 2.4
                      2.2 → 2.5 (can parallel with 2.3)

Phase 3 (Install Scripts) — can start after 2.1
  3.1

Phase 4 (ACP) — requires 2.2
  4.1

Phase 5 (OpenClaw) — requires 2.2
  5.1

Phase 6 (Wallet) — requires 2.2
  6.1
```

**Critical path:** 1.1 → 1.2 → 1.4 → 1.7 → 1.8 (Phase 1 complete)

**Commit cadence:** Every 2-3 files or after each logical group. **Never go more than 30 minutes without a commit.**
