# Seren Browser Phase 1 QA & Security Review — Follow-up (January 31, 2026)

## Verdict
Despite the developer’s latest changes, Phase 1 is still not production-ready. OAuth for MCP Gateway tools has improved, but publisher OAuth is now completely broken and the browser still exposes runtime-only features with no UX, leaving users stuck without guidance. These regressions will block real customers from completing the documented Phase‑1 scenarios (login + MCP + catalog).

## What Improved Since Part 1
- The main SPA now owns the OAuth callback flow (`src/App.tsx:62-107`) and provider OAuth keeps its PKCE state in `sessionStorage` with a same-tab redirect (`src/services/oauth.ts:65-115`).
- Gateway MCP HTTP traffic finally uses browser `fetch()` instead of `runtimeInvoke` (`src/lib/mcp/client.ts:332-474`).

## Outstanding Functional Issues
1. **Publisher OAuth cannot start (Blocker)** – `connectPublisher()` still fetches the user’s bearer token but never uses it when navigating to `https://api.serendb.com/oauth/.../authorize` (`src/services/publisher-oauth.ts:17-31`). That endpoint requires `Authorization: Bearer <token>` (hence the old runtime call that forwarded `bearerToken`). A browser navigation cannot add that header, so every publisher connect attempt now responds 401/403, making catalog OAuth integrations unusable.
2. **File explorer still presents dead controls when the runtime is absent (Major)** – Clicking the “+” button in the Explorer sidebar calls `openFolder()`, which immediately throws “This operation requires the local runtime to be running” (`src/lib/files/service.ts:84-99`). The UI simply logs the error (`src/components/sidebar/FileExplorer.tsx:35-47`) and never informs users how to install the runtime or why nothing happened, violating the plan’s acceptance criteria of showing a “runtime required” state for filesystem features.
3. **Runtime-only context menu actions still surface no UX** – File rename/delete/reveal commands invoke `runtimeInvoke` directly (`src/components/sidebar/FileTree.tsx:60-123`). When the runtime is unavailable (the default Phase‑1 scenario), each action rejects with a `runtime required` error that is only printed to the console, so users perceive the UI as broken.

## Security / UX Concerns
- Because publisher OAuth now performs a bare `window.location.assign()` without session authentication (`src/services/publisher-oauth.ts:17-31`), a malicious script can trigger arbitrary gateway OAuth attempts on behalf of the signed-in user. The earlier `runtimeInvoke("get_oauth_redirect_url", { bearerToken })` flow enforced that the SPA supplied an access token; the new code removes that server-side check entirely.

## Recommendations
1. Restore an authenticated publisher OAuth flow: either proxy the authorize call through the runtime (passing the bearer token) or expose a short-lived signed redirect URL from the API that the SPA can open without credentials.
2. Add explicit runtime-state UX for all filesystem UI entry points (Explorer header, context menu items). Disable the controls and show “Local runtime required — run `seren` locally to enable file access” instead of silently logging errors.
3. Add integration tests that assert publisher OAuth responds with 200 and that the Explorer button shows the runtime-required notice when `isRuntimeConnected()` is false. Without automated coverage, these regressions will recur.
