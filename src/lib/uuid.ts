// ABOUTME: Secure UUID v4 generator that works in non-secure HTTP contexts.
// ABOUTME: Falls back to crypto.getRandomValues when crypto.randomUUID is unavailable.

/**
 * Generate a UUID v4 string.
 * Uses crypto.randomUUID() in secure contexts (HTTPS / localhost),
 * falls back to crypto.getRandomValues() over plain HTTP (e.g. LAN IP).
 */
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: build UUID v4 from getRandomValues (available in all browsers)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set version (4) and variant (RFC 4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
