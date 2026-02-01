// ABOUTME: External link handler for opening URLs in a new browser tab.
// ABOUTME: Simple wrapper around window.open for browser environment.

export async function openExternalLink(url: string): Promise<void> {
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Installs a global safety net that intercepts any anchor click navigating
 * to an external URL and routes it through openExternalLink instead.
 * Call once at app startup.
 */
export function installExternalLinkInterceptor(): void {
  document.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    const href = (anchor as HTMLAnchorElement).href;
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      openExternalLink(href);
    }
  });
}
