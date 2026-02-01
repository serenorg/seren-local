// ABOUTME: Runtime event bus for pushing notifications to connected browsers.
// ABOUTME: Sends JSON-RPC notifications over authenticated WebSocket connections.

import type { WebSocket } from "ws";

type EventCallback = (params: unknown) => void;

const subscribers = new Map<string, Set<EventCallback>>();
const authenticatedClients = new Set<WebSocket>();

/**
 * Register a WebSocket client as authenticated and eligible for events.
 */
export function addClient(ws: WebSocket): void {
  authenticatedClients.add(ws);
  ws.on("close", () => authenticatedClients.delete(ws));
}

/**
 * Remove a WebSocket client from the event bus.
 */
export function removeClient(ws: WebSocket): void {
  authenticatedClients.delete(ws);
}

/**
 * Subscribe to a local event (server-side only).
 */
export function subscribe(event: string, callback: EventCallback): () => void {
  if (!subscribers.has(event)) {
    subscribers.set(event, new Set());
  }
  subscribers.get(event)!.add(callback);
  return () => {
    subscribers.get(event)?.delete(callback);
  };
}

/**
 * Emit an event to all authenticated WebSocket clients as a JSON-RPC notification
 * and to any local subscribers.
 */
export function emit(event: string, params?: unknown): void {
  // Notify local subscribers
  const localSubs = subscribers.get(event);
  if (localSubs) {
    for (const cb of localSubs) {
      try {
        cb(params);
      } catch (err) {
        console.error(`[Events] Local subscriber error for ${event}:`, err);
      }
    }
  }

  // Broadcast to all authenticated WebSocket clients
  const notification = JSON.stringify({
    jsonrpc: "2.0",
    method: event,
    params: params ?? null,
  });

  for (const client of authenticatedClients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(notification);
      } catch (err) {
        console.error("[Events] Failed to send to client:", err);
      }
    }
  }
}

/**
 * Clear all subscribers and clients (for testing).
 */
export function clearAll(): void {
  subscribers.clear();
  authenticatedClients.clear();
}
