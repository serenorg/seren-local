// ABOUTME: Rotating thinking status indicator with varied words.
// ABOUTME: Shows pulsing dot + cycling status text like Claude Code's thinking animation.

import { createSignal, onCleanup, onMount } from "solid-js";

const THINKING_WORDS = [
  "Thinking",
  "Reasoning",
  "Pondering",
  "Analyzing",
  "Considering",
  "Processing",
  "Reflecting",
  "Evaluating",
  "Working",
  "Deliberating",
];

const ROTATION_INTERVAL_MS = 3000;

export function ThinkingStatus() {
  const [index, setIndex] = createSignal(
    Math.floor(Math.random() * THINKING_WORDS.length),
  );

  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % THINKING_WORDS.length);
    }, ROTATION_INTERVAL_MS);
  });

  onCleanup(() => clearInterval(timer));

  return (
    <span class="inline-flex items-center gap-2 text-sm text-[#e6edf3]">
      <span class="inline-flex items-center gap-[3px]">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-[#58a6ff]" style="animation: bounce-dot 1.4s ease-in-out infinite" />
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-[#58a6ff]" style="animation: bounce-dot 1.4s ease-in-out 0.2s infinite" />
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-[#58a6ff]" style="animation: bounce-dot 1.4s ease-in-out 0.4s infinite" />
      </span>
      <span>{THINKING_WORDS[index()]}…</span>
    </span>
  );
}
