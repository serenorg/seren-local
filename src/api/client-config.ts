// ABOUTME: Hey-API client configuration for browser environment.
// ABOUTME: Uses browser-native fetch with automatic token refresh on 401.

import { getToken } from "@/lib/bridge";
import { apiBase } from "@/lib/config";
import type { ClientOptions, Config } from "./generated/client";

// Endpoints that should not trigger auto-refresh (to avoid loops)
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

const customFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const retryRequest = request.clone();

  const response = await fetch(request);

  if (response.status === 401 && !shouldSkipRefresh(request)) {
    const { refreshAccessToken } = await import("@/services/auth");
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      const token = await getToken();
      if (token) {
        retryRequest.headers.set("Authorization", `Bearer ${token}`);
        try {
          await response.body?.cancel();
        } catch {
          // noop
        }
        return fetch(retryRequest);
      }
    }
  }

  return response;
};

export const createClientConfig = <T extends ClientOptions>(
  override?: Config<T>,
): Config<T> => {
  return {
    ...override,
    baseUrl: apiBase,
    fetch: customFetch,
  } as Config<T>;
};
