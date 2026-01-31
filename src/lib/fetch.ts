// ABOUTME: Fetch wrapper with automatic token refresh on 401.
// ABOUTME: Uses browser-native fetch. No Tauri dependency.

import { getToken } from "./bridge";

// Endpoints that should not trigger auto-refresh (to avoid loops)
const NO_REFRESH_ENDPOINTS = ["/auth/login", "/auth/refresh", "/auth/signup"];

/**
 * Check if the request URL is an auth endpoint that should skip refresh.
 */
function shouldSkipRefresh(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return NO_REFRESH_ENDPOINTS.some((endpoint) => url.includes(endpoint));
}

/**
 * Make an HTTP request using browser-native fetch.
 * Automatically refreshes access token on 401 and retries once.
 */
export async function appFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);

  // Handle 401 with auto-refresh (skip for auth endpoints to avoid loops)
  if (response.status === 401 && !shouldSkipRefresh(input)) {
    // Dynamic import to avoid circular dependency
    const { refreshAccessToken } = await import("@/services/auth");
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      const newToken = await getToken();
      const retryInit: RequestInit = {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${newToken}`,
        },
      };
      return fetch(input, retryInit);
    }
  }

  return response;
}
