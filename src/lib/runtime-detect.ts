// ABOUTME: Definitive runtime detection via server-injected meta tags.
// ABOUTME: Replaces all hostname/port heuristics for proxy routing and token retrieval.

/**
 * True when the SPA was served by the Seren Local runtime.
 * Detection: the runtime injects `<meta name="seren-runtime-token">` into
 * the HTML at serve time. This is definitive — no hostname or port guessing.
 */
export function isServedByRuntime(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('meta[name="seren-runtime-token"]') !== null;
}

/**
 * Read the auth token injected by the runtime into the served HTML.
 * Returns null when not served by the runtime (e.g. CDN/dev server).
 */
export function getRuntimeToken(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="seren-runtime-token"]');
  return meta?.getAttribute("content") ?? null;
}

/**
 * The origin (scheme + host + port) of the runtime that served this SPA.
 * When served by the runtime, this is simply `window.location.origin` —
 * works for localhost, LAN IP, or any custom port.
 * Returns null when not served by the runtime.
 */
export function getRuntimeOrigin(): string | null {
  if (!isServedByRuntime()) return null;
  return window.location.origin;
}
