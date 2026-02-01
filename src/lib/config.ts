// ABOUTME: Centralized configuration for the Seren Gateway API.
// ABOUTME: All API calls must use these values for consistency and security.

/**
 * Seren Gateway API base URL.
 * When running from the local runtime (localhost:19420), API calls are proxied
 * through the runtime to bypass browser CORS restrictions.
 * NOTE: Seren Gateway API does NOT use a version prefix.
 */
function resolveApiBase(): string {
  if (import.meta.env.VITE_SEREN_API_URL) return import.meta.env.VITE_SEREN_API_URL;
  // When served from the runtime, proxy through it to avoid CORS
  if (typeof window !== "undefined" && window.location.hostname === "127.0.0.1") {
    return `${window.location.origin}/api`;
  }
  return "https://api.serendb.com";
}

export const API_BASE = resolveApiBase();

// Backwards-compat alias
export const apiBase = API_BASE;
export const API_URL = API_BASE;

export const config = {
  apiBase,
};
