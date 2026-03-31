// ABOUTME: About Seren dialog showing build information and update check.
// ABOUTME: Triggered by custom DOM event "open-about".

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { updaterStore } from "@/stores/updater.store";
import "./AboutDialog.css";

export function AboutDialog() {
  const [isOpen, setIsOpen] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [checkResult, setCheckResult] = createSignal<string | null>(null);

  const buildType = import.meta.env.DEV ? "development" : "production";

  const version = () => updaterStore.state.currentVersion || "loading...";

  onMount(() => {
    const handler = () => setIsOpen(true);
    window.addEventListener("open-about", handler);
    onCleanup(() => window.removeEventListener("open-about", handler));
  });

  function close() {
    setIsOpen(false);
    setCopied(false);
    setCheckResult(null);
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function copyInfo() {
    const text = [
      `Version: ${version()}`,
      `Build Type: ${buildType}`,
      `Platform: browser`,
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleCheckForUpdates() {
    setCheckResult(null);
    await updaterStore.checkForUpdates();
    if (updaterStore.state.status === "available") {
      setCheckResult(`Update available: v${updaterStore.state.latestVersion}`);
    } else {
      setCheckResult("You are up to date.");
    }
  }

  return (
    <Show when={isOpen()}>
      <div class="about-overlay" onClick={handleBackdropClick}>
        <div class="about-dialog">
          <div class="about-header">
            <h2>Seren</h2>
          </div>
          <div class="about-content">
            <Row label="Version" value={version()} />
            <Row label="Build Type" value={buildType} />
            <Row label="Platform" value="browser" />
            <Show when={updaterStore.state.status === "available"}>
              <Row label="Latest" value={`v${updaterStore.state.latestVersion}`} />
            </Show>
          </div>
          <Show when={checkResult()}>
            <div
              class={`about-check-result ${updaterStore.state.status === "available" ? "about-check-result--available" : "about-check-result--current"}`}
            >
              {checkResult()}
            </div>
          </Show>
          <div class="about-footer">
            <button class="about-btn-ok" onClick={close}>
              OK
            </button>
            <button
              class="about-btn-copy"
              onClick={handleCheckForUpdates}
              disabled={updaterStore.state.status === "checking"}
            >
              {updaterStore.state.status === "checking" ? "Checking..." : "Check for Updates"}
            </button>
            <button class="about-btn-copy" onClick={copyInfo}>
              {copied() ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="about-row">
      <span class="about-label">{props.label}</span>
      <span class="about-value">{props.value}</span>
    </div>
  );
}
