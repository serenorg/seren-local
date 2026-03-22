// ABOUTME: Recursive Language Model processor for inputs exceeding the context window.
// ABOUTME: TypeScript port of the Rust RLM from seren-desktop (arXiv 2512.24601).

// =============================================================================
// Constants
// =============================================================================

const PUBLISHER_SLUG = "seren-models";

/** Activate RLM when input exceeds this fraction of the model's context window. */
const RLM_THRESHOLD = 0.85;

/**
 * Each chunk targets this fraction of the context window (leaves room for
 * history, system prompt, user question, and model response).
 */
const CHUNK_TARGET_FRACTION = 0.45;

/** Overlap in characters between adjacent chunks (~200 tokens x 4 chars/token). */
const CHUNK_OVERLAP_CHARS = 800;

/** Request timeout for RLM sub-calls (10 minutes). */
const REQUEST_TIMEOUT_MS = 600_000;

// =============================================================================
// Types
// =============================================================================

export interface RlmEvent {
  type: "rlm_start" | "rlm_chunk_complete";
  data: { index: number; total: number; summary?: string };
}

interface Chunk {
  index: number;
  total: number;
  text: string;
}

interface ChunkResult {
  index: number;
  total: number;
  summary: string;
}

type RlmStrategy = "synthesis" | "sequential";

// =============================================================================
// Model context limits (characters, not tokens; 1 token ~ 4 chars)
// =============================================================================

/**
 * Returns the approximate character-level context limit for a model.
 * Uses the convention: token limit x 4 chars per token.
 */
export function modelContextLimitChars(modelId: string): number {
  let tokens: number;
  if (
    modelId.includes("gemini-1.5") ||
    modelId.includes("gemini-2") ||
    modelId.includes("gemini-3")
  ) {
    tokens = 1_000_000;
  } else if (modelId.includes("claude")) {
    tokens = 200_000;
  } else if (modelId.includes("gpt-4")) {
    tokens = 128_000;
  } else {
    tokens = 100_000;
  }
  return tokens * 4;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Returns true if the combined input character count exceeds the RLM threshold
 * for the given model.
 */
export function needsRlm(inputChars: number, modelId: string): boolean {
  const limit = modelContextLimitChars(modelId);
  const threshold = Math.floor(limit * RLM_THRESHOLD);
  return inputChars > threshold;
}

/**
 * Main entry point: process a prompt that exceeds the context window using
 * the RLM (Recursive Language Model) approach.
 *
 * Splits the prompt into content + question, classifies the task strategy,
 * chunks the content, processes chunks via map-reduce or sequential strategy,
 * and returns the final synthesised answer.
 */
export async function processRlm(
  query: string,
  content: string,
  model: string,
  apiBase: string,
  apiKey: string,
  onEvent?: (event: RlmEvent) => void
): Promise<string> {
  const limit = modelContextLimitChars(model);
  const chunkBudget = Math.floor(limit * CHUNK_TARGET_FRACTION);

  // 1. Classify the task
  let strategy: RlmStrategy;
  try {
    strategy = await classifyTask(query, apiBase, apiKey);
  } catch (err) {
    // Default to sequential on classification failure
    strategy = "sequential";
  }

  // 2. Chunk the content
  const chunks = chunkContent(content, chunkBudget);

  // Emit RlmStart
  onEvent?.({ type: "rlm_start", data: { index: 0, total: chunks.length } });

  // 3. Process chunks
  let finalAnswer: string;
  if (strategy === "synthesis") {
    finalAnswer = await processMapReduce(
      chunks,
      query,
      model,
      apiBase,
      apiKey,
      onEvent
    );
  } else {
    finalAnswer = await processSequential(
      chunks,
      query,
      model,
      apiBase,
      apiKey,
      onEvent
    );
  }

  return finalAnswer;
}

// =============================================================================
// Task classification
// =============================================================================

/**
 * Ask the model to classify the task as "synthesis" or "sequential" with a
 * single, cheap, non-streaming call.
 */
export async function classifyTask(
  query: string,
  apiBase: string,
  apiKey: string
): Promise<RlmStrategy> {
  const url = `${apiBase}/publishers/${PUBLISHER_SLUG}/chat/completions`;

  const system = "You are a task classifier. Respond with exactly one word.";
  const user = [
    'Classify this task as either "synthesis" (requires reasoning across a whole document:',
    'summarize, analyze, compare, find themes) or "sequential" (can be done chunk by chunk:',
    "translate, reformat, extract).",
    "",
    `Task: ${query}`,
    "",
    "Respond with exactly one word: synthesis or sequential",
  ].join("\n");

  const body = {
    model: "anthropic/claude-sonnet-4", // cheap model for classification
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    max_tokens: 10,
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Classify HTTP ${response.status}: ${text}`);
  }

  const json = await response.json();
  const answer: string = (
    json?.choices?.[0]?.message?.content ?? ""
  )
    .trim()
    .toLowerCase();

  return answer.includes("sequential") ? "sequential" : "synthesis";
}

// =============================================================================
// Chunking
// =============================================================================

/**
 * Split `content` into chunks that each fit within `budget` characters.
 *
 * Priority order for split points:
 * 1. Markdown/numbered headings
 * 2. Double newlines (paragraphs)
 * 3. Single newlines
 * 4. Sentence-ending punctuation
 * 5. Fixed character count (fallback)
 *
 * Adjacent chunks share CHUNK_OVERLAP_CHARS chars at their boundary.
 */
export function chunkContent(content: string, budget: number): Chunk[] {
  const raw = splitAtBudget(content, budget);
  const total = raw.length;
  return raw.map((text, i) => ({ index: i, total, text }));
}

/**
 * Compute the start position for the next chunk, including overlap from the
 * previous chunk's tail. When tailStart <= CHUNK_OVERLAP_CHARS the entire
 * head is shorter than the overlap window; skip the overlap to guarantee
 * forward progress.
 */
function overlapStartFor(tailStart: number): number {
  return tailStart > CHUNK_OVERLAP_CHARS
    ? tailStart - CHUNK_OVERLAP_CHARS
    : tailStart;
}

function splitAtBudget(text: string, budget: number): string[] {
  if (text.length <= budget) {
    return [text];
  }

  const windowStart = Math.floor(budget / 2);
  const searchRegion = text.slice(0, Math.min(budget, text.length));

  // Priority 1: heading boundary (line starting with # or digit)
  const headingPos = findHeadingBoundary(searchRegion, windowStart);
  if (headingPos !== -1) {
    const head = text.slice(0, headingPos);
    const tailWithOverlap = text.slice(overlapStartFor(head.length));
    return [head, ...splitAtBudget(tailWithOverlap, budget)];
  }

  // Priority 2: double newline (paragraph)
  const dblNewlinePos = rfindInRange(searchRegion, "\n\n", windowStart);
  if (dblNewlinePos !== -1) {
    const splitPos = dblNewlinePos + 2;
    const head = text.slice(0, splitPos);
    const tailWithOverlap = text.slice(overlapStartFor(head.length));
    return [head, ...splitAtBudget(tailWithOverlap, budget)];
  }

  // Priority 3: single newline
  const newlinePos = rfindInRange(searchRegion, "\n", windowStart);
  if (newlinePos !== -1) {
    const splitPos = newlinePos + 1;
    const head = text.slice(0, splitPos);
    const tailWithOverlap = text.slice(overlapStartFor(head.length));
    return [head, ...splitAtBudget(tailWithOverlap, budget)];
  }

  // Priority 4: sentence boundary (". ", "! ", "? ")
  for (const sep of [". ", "! ", "? "]) {
    const sentPos = rfindInRange(searchRegion, sep, windowStart);
    if (sentPos !== -1) {
      const splitPos = sentPos + sep.length;
      const head = text.slice(0, splitPos);
      const tailWithOverlap = text.slice(overlapStartFor(head.length));
      return [head, ...splitAtBudget(tailWithOverlap, budget)];
    }
  }

  // Priority 5: hard cut at budget
  const head = text.slice(0, budget);
  const tailWithOverlap = text.slice(overlapStartFor(head.length));
  return [head, ...splitAtBudget(tailWithOverlap, budget)];
}

/** Find the last occurrence of `needle` in `haystack` at or after `minPos`. */
function rfindInRange(
  haystack: string,
  needle: string,
  minPos: number
): number {
  const lastIdx = haystack.lastIndexOf(needle);
  return lastIdx >= minPos ? lastIdx : -1;
}

/** Find a heading-style line boundary after `minPos`. */
function findHeadingBoundary(text: string, minPos: number): number {
  let idx = text.indexOf("\n", minPos);
  while (idx !== -1 && idx + 1 < text.length) {
    const nextChar = text[idx + 1];
    // Lines starting with '#' or a digit are heading boundaries
    if (nextChar === "#" || (nextChar >= "0" && nextChar <= "9")) {
      return idx + 1;
    }
    idx = text.indexOf("\n", idx + 1);
  }
  return -1;
}

// =============================================================================
// Map-reduce strategy
// =============================================================================

/**
 * Process all chunks in parallel, then merge results in a final call.
 */
export async function processMapReduce(
  chunks: Chunk[],
  query: string,
  model: string,
  apiBase: string,
  apiKey: string,
  onEvent?: (event: RlmEvent) => void
): Promise<string> {
  // Process all chunks concurrently
  const promises = chunks.map(async (chunk) => {
    const prompt = [
      `Question: ${query}`,
      "",
      `Document section ${chunk.index + 1}/${chunk.total}:`,
      "",
      chunk.text,
      "",
      "Answer the question based only on the content in this section. " +
        "If the section does not contain relevant information, say so briefly.",
    ].join("\n");

    const summary = await callSimple(prompt, model, apiBase, apiKey);

    onEvent?.({
      type: "rlm_chunk_complete",
      data: { index: chunk.index, total: chunk.total, summary },
    });

    return { index: chunk.index, total: chunk.total, summary } as ChunkResult;
  });

  const results = await Promise.all(promises);
  results.sort((a, b) => a.index - b.index);

  // Merge all chunk summaries into a final answer
  const mergePrompt = buildMergePrompt(query, results.map((r) => r.summary));
  return callSimple(mergePrompt, model, apiBase, apiKey);
}

// =============================================================================
// Sequential (rolling context) strategy
// =============================================================================

/**
 * Process chunks in order, each building on the previous summary.
 */
export async function processSequential(
  chunks: Chunk[],
  query: string,
  model: string,
  apiBase: string,
  apiKey: string,
  onEvent?: (event: RlmEvent) => void
): Promise<string> {
  let runningSummary = "";
  let lastAnswer = "";

  for (const chunk of chunks) {
    let prompt: string;
    if (!runningSummary) {
      prompt = [
        `Question: ${query}`,
        "",
        `Document section ${chunk.index + 1}/${chunk.total}:`,
        "",
        chunk.text,
      ].join("\n");
    } else {
      prompt = [
        `Question: ${query}`,
        "",
        `Progress so far:`,
        runningSummary,
        "",
        `Document section ${chunk.index + 1}/${chunk.total}:`,
        "",
        chunk.text,
      ].join("\n");
    }

    const answer = await callSimple(prompt, model, apiBase, apiKey);

    onEvent?.({
      type: "rlm_chunk_complete",
      data: { index: chunk.index, total: chunk.total, summary: answer },
    });

    runningSummary = answer;
    lastAnswer = answer;
  }

  return lastAnswer;
}

// =============================================================================
// HTTP helpers
// =============================================================================

/** Make a simple non-streaming completion call and return the text response. */
async function callSimple(
  prompt: string,
  model: string,
  apiBase: string,
  apiKey: string
): Promise<string> {
  const url = `${apiBase}/publishers/${PUBLISHER_SLUG}/chat/completions`;

  const messages = [
    { role: "system", content: "You are a helpful AI assistant." },
    { role: "user", content: prompt },
  ];

  const body = { model, messages, stream: false };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RLM sub-call HTTP ${response.status}: ${text}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`No content in RLM response: ${JSON.stringify(json)}`);
  }
  return content;
}

/** fetch() wrapper with an AbortController timeout. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// Prompt helpers
// =============================================================================

/** Build the merge prompt for map-reduce aggregation. */
function buildMergePrompt(question: string, summaries: string[]): string {
  const parts = summaries.map(
    (s, i) => `Section ${i + 1} answer:\n${s}`
  );
  return [
    `Question: ${question}`,
    "",
    `I processed a large document in ${summaries.length} sections. ` +
      `Here are the answers from each section:`,
    "",
    parts.join("\n\n"),
    "",
    "Synthesize these section answers into a single, coherent final answer to the question.",
  ].join("\n");
}

/**
 * Split the prompt into [content, question].
 *
 * If the prompt contains two or more paragraphs, treats everything except the
 * last paragraph as content and the last paragraph as the question.
 * Otherwise treats the entire prompt as both content and question.
 */
export function splitContentAndQuestion(
  prompt: string
): [string, string] {
  const trimmed = prompt.trim();
  const lastDoubleNewline = trimmed.lastIndexOf("\n\n");
  if (lastDoubleNewline !== -1) {
    const content = trimmed.slice(0, lastDoubleNewline).trim();
    const question = trimmed.slice(lastDoubleNewline + 2).trim();
    if (content && question) {
      return [content, question];
    }
  }
  return [trimmed, trimmed];
}
