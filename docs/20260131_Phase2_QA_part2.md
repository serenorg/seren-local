# Seren Browser Phase 2 QA & Security Review — Follow-up (January 31, 2026)

## Verdict
The alleged fixes never happened. Phase 2 is still blocked on the exact same issues called out earlier: the browser cannot open folders, runtime-backed conversation storage is unused, and the localhost daemon remains an unauthenticated backdoor. The software is **not ready for production**.

## Re-test Highlights
1. **Runtime chat handlers remain dead code** – `runtime/src/handlers/index.ts:11-20` still registers `create_conversation`, `get_conversations`, etc., yet every conversation API in the SPA (`src/lib/bridge.ts:409-679`) continues to use IndexedDB exclusively. No call path ever invokes `runtimeInvoke`, so Phase 2’s “local runtime provides SQLite history” goal is unmet.
2. **Folder picker RPCs are still missing** – The browser invokes `runtimeInvoke("open_folder_dialog")` (`src/lib/files/service.ts:84-99`), but the runtime only exposes basic FS CRUD handlers. Searching the runtime code base shows no `open_folder_dialog`, `open_file_dialog`, `save_file_dialog`, or `reveal_in_file_manager` handlers. Clicking the Explorer “+” button immediately throws a “method not found” error, so the promised file-access foundation does not exist.
3. **No runtime authentication or origin check** – `runtime/src/server.ts:15-83` still accepts any `ws://localhost:19420` connection with no token, mutual TLS, or origin binding, while `src/lib/bridge.ts:64-139` connects without presenting credentials. Any website can connect and invoke `list_directory`, `delete_path`, or dump chat history, which is an unforgivable security risk.
4. **Symlink traversal bug unfixed** – `validatePath()` (`runtime/src/handlers/fs.ts:18-35`) only checks that the resolved string starts with the home directory. A symlink `~/tmp/evil -> /etc` still passes the string prefix test, enabling arbitrary file reads/writes outside the sandbox.
5. **No reconnection or runtime-state UX** – `connectToRuntime()` runs once on mount (`src/App.tsx:28-107`) and never retries after failure, and the UI gives zero guidance when runtime-only actions fail. Users still see dead buttons when the daemon starts later.

## Required Actions
1. Wire the SPA to the runtime chat handlers: call `runtimeInvoke` for conversation CRUD when `isRuntimeConnected()` is true, and add regression tests covering both IndexedDB and SQLite modes.
2. Implement (and test) the missing RPC methods for folder/file pickers or revert to browser-native `<input type="file" webkitdirectory>` pickers until the runtime can support them.
3. Add a shared-secret handshake (or equivalent) for the WebSocket server, reject unauthenticated sessions, and log failures. Update the bridge to prompt for the token.
4. Harden `validatePath()` with `fs.realpath`/`lstat` checks so symlink escape attempts fail, and add tests demonstrating the fix.
5. Introduce runtime reconnection/backoff logic and UX that clearly explains when “Local runtime required” features are unavailable.

Until these items are implemented and backed by automated tests, Phase 2 cannot be certified for production.
