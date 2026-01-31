// ABOUTME: About Seren dialog showing build information.
// ABOUTME: Triggered by custom DOM event "open-about".

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import "./AboutDialog.css";

interface BuildInfo {
  app_version: string;
  build_type: string;
  platform: string;
}

export function AboutDialog() {
  const [isOpen, setIsOpen] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const buildInfo: BuildInfo = {
    app_version: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
    build_type: import.meta.env.DEV ? "development" : "production",
    platform: "browser",
  };

  onMount(() => {
    const handler = () => setIsOpen(true);
    window.addEventListener("open-about", handler);
    onCleanup(() => window.removeEventListener("open-about", handler));
  });

  function close() {
    setIsOpen(false);
    setCopied(false);
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function copyInfo() {
    const text = [
      `Version: ${buildInfo.app_version}`,
      `Build Type: ${buildInfo.build_type}`,
      `Platform: ${buildInfo.platform}`,
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Show when={isOpen()}>
      <div class="about-overlay" onClick={handleBackdropClick}>
        <div class="about-dialog">
          <div class="about-header">
            <h2>Seren</h2>
          </div>
          <div class="about-content">
            <Row label="Version" value={buildInfo.app_version} />
            <Row label="Build Type" value={buildInfo.build_type} />
            <Row label="Platform" value={buildInfo.platform} />
          </div>
          <div class="about-footer">
            <button class="about-btn-ok" onClick={close}>
              OK
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
