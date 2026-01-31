// ABOUTME: External link handler for opening URLs in a new browser tab.
// ABOUTME: Simple wrapper around window.open for browser environment.

export async function openExternalLink(url: string): Promise<void> {
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
