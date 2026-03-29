// ABOUTME: Centralized configuration for the Seren Gateway API.
// ABOUTME: All API calls must use these values for consistency and security.

import { isServedByRuntime } from "@/lib/runtime-detect";

/**
 * Seren Gateway API base URL.
 * When served by the runtime, API calls are proxied through it to bypass
 * browser CORS restrictions. Detection uses server-injected meta tag —
 * works for any host (localhost, LAN IP, custom port).
 */
function resolveApiBase(): string {
  if (import.meta.env.VITE_SEREN_API_URL) return import.meta.env.VITE_SEREN_API_URL;
  if (isServedByRuntime()) {
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
