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
