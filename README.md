# Seren Browser

AI chat with 90+ tools, right in your browser. No download required.

## What is Seren?

Seren is a browser-based AI assistant that connects to multiple AI models (Claude, GPT, and more) through the Seren Gateway. It includes access to MCP (Model Context Protocol) tools for email, calendar, databases, web search, and dozens of other integrations.

**Visit [app.seren.com](https://app.seren.com) to get started.**

## Two Ways to Use Seren

### Browser Only (no install)

Open your browser and go to [app.seren.com](https://app.seren.com). Sign up or log in. You get:

- AI chat with multiple models
- 90+ MCP tools via the Seren Gateway
- Conversation history (stored in your browser)
- Publisher marketplace (Firecrawl, Perplexity, databases, and more)

### Browser + Local Runtime (optional install)

For advanced features, install the Seren local runtime on your machine. This adds:

- **File explorer** -- browse, read, and edit local files
- **AI coding agents** -- spawn Claude Code or Codex to work on your projects
- **OpenClaw messaging** -- connect WhatsApp, Telegram, Discord, Slack, and Signal
- **Crypto wallet** -- sign x402 payments with USDC on Base
- **Persistent storage** -- conversations sync to a local SQLite database

## Installing the Local Runtime

### macOS / Linux

```sh
curl -fsSL https://seren.com/install | sh
```

### Windows (PowerShell)

```powershell
irm https://seren.com/install.ps1 | iex
```

### What the installer does

1. Downloads Node.js to `~/.seren/node/` (if you don't have Node 20+)
2. Checks for a C/C++ compiler (needed for the SQLite module)
3. Installs `@serendb/runtime` and `openclaw` via npm into `~/.seren/`
4. Adds `~/.seren/bin` to your PATH

### Starting the runtime

```sh
seren
```

The runtime starts on `localhost:19420`. Open [app.seren.com](https://app.seren.com) in your browser and it connects automatically.

### Uninstalling

Remove the Seren directory:

```sh
rm -rf ~/.seren
```

On Windows:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.seren"
```

## For Developers

### Prerequisites

- Node.js 20+
- pnpm

### Setup

```sh
git clone https://github.com/serenorg/seren-browser.git
cd seren-browser
pnpm install
```

### Development

```sh
pnpm dev              # Start the SPA dev server
```

To develop the local runtime:

```sh
cd runtime
pnpm install
pnpm dev              # Start runtime with hot reload
```

### Testing

```sh
pnpm test             # SPA unit tests
cd runtime && pnpm test   # Runtime unit tests (50 tests)
```

### Building

```sh
pnpm build            # Build SPA for production
cd runtime && pnpm build  # Build runtime
```

### Linting

This project uses [Biome](https://biomejs.dev/) (not ESLint/Prettier):

```sh
pnpm check            # Check all
pnpm check:fix        # Auto-fix
```

## Project Structure

```
seren-browser/
  src/                    # Browser SPA (SolidJS + TypeScript)
    components/           # UI components
    services/             # API and service layer
    stores/               # SolidJS reactive stores
    lib/                  # Core libraries (bridge, config, providers)
  runtime/                # Local Node.js runtime
    src/handlers/         # RPC handlers (fs, acp, openclaw, wallet, chat)
    src/server.ts         # HTTP + WebSocket server
    tests/                # Runtime tests
  scripts/                # Install scripts (macOS, Linux, Windows)
```

## For AI Agents

If you are an AI agent working on this codebase:

- The SPA is built with **SolidJS** (not React). Use SolidJS patterns: `createSignal`, `createStore`, `Show`, `For`.
- All API calls go through `src/services/`. Never call fetch in components.
- The bridge layer (`src/lib/bridge.ts`) routes calls to either IndexedDB (offline) or the local runtime (when connected).
- The runtime communicates via JSON-RPC over WebSocket on port 19420.
- Use Biome for formatting and linting, not ESLint or Prettier.
- Never import from `@tauri-apps/*` -- this is a pure browser app.

## License

[MIT](LICENSE)
