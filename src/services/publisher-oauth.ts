// ABOUTME: Publisher OAuth service for gateway-managed OAuth flows.
// ABOUTME: Handles connecting/disconnecting OAuth providers for MCP publishers.

import {
  listConnections,
  revokeConnection,
  type UserOAuthConnectionResponse,
} from "@/api";
import { getToken } from "@/lib/bridge";
import { apiBase } from "@/lib/config";

/**
 * Start OAuth flow for a publisher provider.
 * Navigates to the Gateway authorize endpoint which redirects to the provider.
 * On success, the provider redirects back to our /oauth/callback path.
 */
export async function connectPublisher(providerSlug: string): Promise<void> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Please log in first.");
  }

  const redirectUri = `${window.location.origin}/oauth/callback`;
  const authUrl = `${apiBase}/oauth/${providerSlug}/authorize`;

  // Use a POST form submission to send the token in the request body,
  // not as a query parameter. Query params leak to browser history,
  // referrer headers, and proxy logs.
  const form = document.createElement("form");
  form.method = "POST";
  form.action = authUrl;
  form.style.display = "none";

  const tokenInput = document.createElement("input");
  tokenInput.type = "hidden";
  tokenInput.name = "access_token";
  tokenInput.value = token;
  form.appendChild(tokenInput);

  const redirectInput = document.createElement("input");
  redirectInput.type = "hidden";
  redirectInput.name = "redirect_uri";
  redirectInput.value = redirectUri;
  form.appendChild(redirectInput);

  document.body.appendChild(form);
  form.submit();
}

/**
 * List user's connected OAuth providers.
 */
export async function listConnectedPublishers(): Promise<
  UserOAuthConnectionResponse[]
> {
  console.log("[PublisherOAuth] Fetching connected OAuth providers");
  const { data, error } = await listConnections({ throwOnError: false });

  if (error) {
    console.error("[PublisherOAuth] Error listing connections:", error);
    throw new Error(`Failed to list connections: ${error}`);
  }

  const connections = data?.connections || [];
  console.log(
    `[PublisherOAuth] Found ${connections.length} connected providers`,
  );
  return connections;
}

/**
 * Disconnect a publisher OAuth provider.
 */
export async function disconnectPublisher(providerSlug: string): Promise<void> {
  console.log(`[PublisherOAuth] Disconnecting ${providerSlug}`);
  const { error } = await revokeConnection({
    path: { provider: providerSlug },
    throwOnError: false,
  });

  if (error) {
    console.error(
      `[PublisherOAuth] Error disconnecting ${providerSlug}:`,
      error,
    );
    throw new Error(`Failed to revoke connection: ${error}`);
  }

  console.log(`[PublisherOAuth] Successfully disconnected ${providerSlug}`);
}

/**
 * Check if a publisher is connected.
 */
export async function isPublisherConnected(
  providerSlug: string,
): Promise<boolean> {
  const connections = await listConnectedPublishers();
  const isConnected = connections.some(
    (c) => c.provider_slug === providerSlug && c.is_valid,
  );
  console.log(`[PublisherOAuth] ${providerSlug} connected: ${isConnected}`);
  return isConnected;
}

/**
 * Get connection details for a provider.
 */
export async function getConnection(
  providerSlug: string,
): Promise<UserOAuthConnectionResponse | null> {
  const connections = await listConnectedPublishers();
  return (
    connections.find((c) => c.provider_slug === providerSlug && c.is_valid) ||
    null
  );
}
