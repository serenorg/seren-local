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
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    access_token: token,
  });
  const authUrl = `${apiBase}/oauth/${providerSlug}/authorize?${params.toString()}`;

  // Navigate to Gateway authorize endpoint with access_token for authentication.
  // The Gateway verifies the token, then 302s to the provider's auth page.
  // After the user authorizes, the provider redirects back to our redirect_uri.
  // The Gateway handles the token exchange server-side.
  window.location.assign(authUrl);
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
