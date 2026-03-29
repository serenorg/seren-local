// ABOUTME: BM25-based tool relevance scoring for per-request tool selection.
// ABOUTME: Model-aware budgets, publisher-set scoping, and conversation-aware boosting.
// ABOUTME: Port of seren-desktop's orchestrator/tool_relevance.rs with all enhancements.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OpenAI function-calling tool format. */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, { type?: string; description?: string; [k: string]: unknown }>;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// BM25 tuning constants (Robertson et al., standard values)
// ---------------------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;

/** Estimated average tool document length in words (name + description + props). */
const AVG_TOOL_WORDS = 60;

/** Approximate token count: 4 characters ~ 1 token for typical JSON schema text. */
const CHARS_PER_TOKEN = 4;

/** Default token budget for selected tools sent to the model per request. */
const DEFAULT_TOOL_TOKEN_BUDGET = 12_000;

/** Minimum tools always included regardless of BM25 score. */
const MIN_TOOLS = 5;

/** Hard byte budget as a final safety net against HTTP 413 responses. */
const HARD_BYTE_BUDGET = 400 * 1024;

/** Maximum tools from a single publisher included via set-scoping. */
const MAX_PUBLISHER_TOOLS = 25;

/** Number of top publishers to include full toolsets for. */
const TOP_K_PUBLISHERS = 3;

/** Score multiplier for publishers whose tools were recently used in conversation. */
const RECENCY_BOOST = 2.0;

// ---------------------------------------------------------------------------
// Pinned local tools (always included regardless of BM25 score)
// ---------------------------------------------------------------------------

/**
 * Local tools that are always included regardless of BM25 score.
 * These are fundamental capabilities the model needs constant access to --
 * without them it cannot read/write files or execute commands.
 */
const PINNED_TOOL_NAMES: string[] = [
  "read_file",
  "write_file",
  "list_directory",
  "path_exists",
  "create_directory",
  "seren_web_fetch",
  "execute_command",
];

// ---------------------------------------------------------------------------
// Model-aware budgets
// ---------------------------------------------------------------------------

/**
 * Returns [maxTools, tokenBudget] for the given model.
 * Tighter caps for models with weaker tool selection; generous for Anthropic.
 */
function modelBudget(modelId: string): [number, number] {
  const id = modelId.toLowerCase();
  if (id.includes("gpt-3.5") || id.includes("gpt-4") || id.includes("/o1") || id.includes("/o3")) {
    // OpenAI: 128 API hard limit, accuracy degrades well before that.
    return [40, 6_000];
  } else if (id.includes("gemini")) {
    // Gemini: 256 limit, weaker tool selection at scale.
    return [50, 8_000];
  } else if (id.includes("claude") || id.includes("anthropic")) {
    // Anthropic: handles large toolsets well, but 200 is wasteful.
    return [80, DEFAULT_TOOL_TOKEN_BUDGET];
  } else {
    // Unknown models get a conservative budget.
    return [60, 8_000];
  }
}

// ---------------------------------------------------------------------------
// Pinned tool detection
// ---------------------------------------------------------------------------

/** Check if a tool definition matches a pinned tool name. */
function isPinnedTool(tool: OpenAITool): boolean {
  const name = tool.function?.name;
  return name ? PINNED_TOOL_NAMES.includes(name) : false;
}

// ---------------------------------------------------------------------------
// Publisher extraction
// ---------------------------------------------------------------------------

/**
 * Extract the publisher name from a tool name following the
 * `mcp__<publisher>__<action>` or `gateway__<publisher>__<action>` convention.
 * Returns null for tools that don't use either prefix.
 */
export function extractMcpPublisher(toolName: string): string | null {
  let rest: string | undefined;
  if (toolName.startsWith("mcp__")) {
    rest = toolName.slice("mcp__".length);
  } else if (toolName.startsWith("gateway__")) {
    rest = toolName.slice("gateway__".length);
  }
  if (!rest) return null;

  const sepIdx = rest.indexOf("__");
  if (sepIdx === -1) return null;
  const publisher = rest.slice(0, sepIdx);
  return publisher.length > 0 ? publisher : null;
}

/** Extract the publisher name from a tool's function name, if it has one. */
function toolPublisher(tool: OpenAITool): string | null {
  const name = tool.function?.name;
  return name ? extractMcpPublisher(name) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the most relevant tools for the given query, model, and conversation state.
 *
 * This is the primary entry point. It combines three strategies:
 * 1. **Model-aware budgets**: Tighter caps for models with weaker tool selection.
 * 2. **Publisher-set scoping**: When a publisher is relevant, include its full toolset
 *    (up to MAX_PUBLISHER_TOOLS) so the model gets coherent capabilities.
 * 3. **Conversation-aware boosting**: Publishers whose tools were recently used get
 *    a score multiplier so follow-up turns stay coherent.
 *
 * Pinned local tools (read_file, write_file, execute_command, etc.) are always
 * included regardless of BM25 score to ensure the model retains fundamental capabilities.
 */
export function selectRelevantTools(
  query: string,
  tools: OpenAITool[],
  modelId: string = "anthropic/claude-sonnet-4",
  recentlyUsedPublishers: string[] = [],
): OpenAITool[] {
  const [maxTools, tokenBudget] = modelBudget(modelId);

  // Fast path: no scoring needed when the set is small enough.
  const totalBytes = JSON.stringify(tools).length;
  if (totalBytes <= HARD_BYTE_BUDGET && tools.length <= maxTools) {
    return [...tools];
  }

  if (tools.length === 0) {
    return [];
  }

  // Partition into pinned (always-included) and non-pinned (BM25-scored) tools,
  // preserving original indices for ordering restoration.
  const pinnedIndices: number[] = [];
  const poolIndices: number[] = [];
  for (let i = 0; i < tools.length; i++) {
    if (isPinnedTool(tools[i])) {
      pinnedIndices.push(i);
    } else {
      poolIndices.push(i);
    }
  }

  // Account for pinned tools in the budget.
  const pinnedTokens = pinnedIndices.reduce(
    (sum, i) => sum + approximateTokens(toolText(tools[i])),
    0,
  );

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return applyHardBudget(tools);
  }

  // Score only the non-pinned pool.
  const poolDocs = poolIndices.map((i) => toolText(tools[i]));
  const poolScores = bm25Scores(queryTerms, poolDocs);

  // Phase 3: Boost scores for recently-used publishers.
  if (recentlyUsedPublishers.length > 0) {
    for (let pi = 0; pi < poolScores.length; pi++) {
      const originalIdx = poolIndices[pi];
      const publisher = toolPublisher(tools[originalIdx]);
      if (publisher && recentlyUsedPublishers.includes(publisher)) {
        poolScores[pi] *= RECENCY_BOOST;
      }
    }
  }

  // Phase 2: Publisher-set scoping.
  // Group pool tools by publisher and compute aggregate publisher scores.
  const publisherScores = new Map<string, number>();
  const publisherPoolIndices = new Map<string, number[]>();
  for (let pi = 0; pi < poolScores.length; pi++) {
    const originalIdx = poolIndices[pi];
    const publisher = toolPublisher(tools[originalIdx]);
    if (publisher) {
      publisherScores.set(
        publisher,
        (publisherScores.get(publisher) ?? 0) + poolScores[pi],
      );
      if (!publisherPoolIndices.has(publisher)) {
        publisherPoolIndices.set(publisher, []);
      }
      publisherPoolIndices.get(publisher)!.push(pi);
    }
  }

  // Identify top-K publishers by aggregate score (only those with nonzero score).
  const rankedPublishers = [...publisherScores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);
  const topPublishers = rankedPublishers
    .slice(0, TOP_K_PUBLISHERS)
    .map(([name]) => name);

  // Build selection: start with pinned tools, then add full toolsets for top publishers,
  // then fill remaining budget with highest-scoring individual tools.
  const selectedIndices: number[] = [...pinnedIndices];
  let tokenCount = pinnedTokens;
  const selectedPool: boolean[] = new Array(poolIndices.length).fill(false);

  // Include full toolsets for top-K publishers (up to per-publisher cap).
  for (const pubName of topPublishers) {
    const indices = publisherPoolIndices.get(pubName);
    if (!indices) continue;

    let pubAdded = 0;
    // Sort by score within publisher to pick best ones first.
    const scored = indices
      .map((pi) => [pi, poolScores[pi]] as [number, number])
      .sort((a, b) => b[1] - a[1]);

    for (const [poolIdx] of scored) {
      if (pubAdded >= MAX_PUBLISHER_TOOLS) break;
      if (selectedIndices.length >= maxTools) break;
      if (selectedPool[poolIdx]) continue;

      const originalIdx = poolIndices[poolIdx];
      const toolTokens = approximateTokens(poolDocs[poolIdx]);
      tokenCount += toolTokens;
      selectedIndices.push(originalIdx);
      selectedPool[poolIdx] = true;
      pubAdded++;
    }
  }

  // Fill remaining budget with highest-scoring individual tools.
  // Respect the per-publisher cap to prevent any single publisher from dominating.
  const ranked: Array<[number, number]> = poolScores
    .map((score, idx): [number, number] => [idx, score])
    .sort((a, b) => b[1] - a[1]);

  // Track per-publisher counts (including tools already added in set-scoping).
  const publisherCounts = new Map<string, number>();
  for (let pi = 0; pi < selectedPool.length; pi++) {
    if (selectedPool[pi]) {
      const originalIdx = poolIndices[pi];
      const publisher = toolPublisher(tools[originalIdx]);
      if (publisher) {
        publisherCounts.set(publisher, (publisherCounts.get(publisher) ?? 0) + 1);
      }
    }
  }

  const totalMin = Math.max(MIN_TOOLS - selectedIndices.length, 0);
  let extraPicked = 0;

  for (const [poolIdx] of ranked) {
    if (selectedIndices.length >= maxTools) break;
    if (selectedPool[poolIdx]) continue;

    // Enforce per-publisher cap in fill phase too.
    const originalIdx = poolIndices[poolIdx];
    const publisher = toolPublisher(tools[originalIdx]);
    if (publisher) {
      const count = publisherCounts.get(publisher) ?? 0;
      if (count >= MAX_PUBLISHER_TOOLS) continue;
    }

    const toolTokens = approximateTokens(poolDocs[poolIdx]);
    const budgetExceeded =
      tokenCount + toolTokens > tokenBudget && extraPicked >= totalMin;
    if (budgetExceeded) break;

    selectedIndices.push(originalIdx);
    selectedPool[poolIdx] = true;
    tokenCount += toolTokens;
    extraPicked++;
    if (publisher) {
      publisherCounts.set(publisher, (publisherCounts.get(publisher) ?? 0) + 1);
    }
  }

  // Restore original ordering so the frontend's priority ranking is preserved.
  selectedIndices.sort((a, b) => a - b);

  const result = selectedIndices.map((i) => tools[i]);

  console.log(
    `[ToolRelevance] Selected ${result.length} of ${tools.length} tools ` +
    `(${pinnedIndices.length} pinned, top publishers: [${topPublishers.join(", ")}], ` +
    `~${tokenCount} tokens, model: ${modelId}, budget: ${maxTools})`,
  );

  return applyHardBudget(result);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract indexable text from an OpenAI-format tool definition.
 *
 * Concatenates: function name + description + parameter names + parameter descriptions.
 * For MCP/gateway tools with the `mcp__<publisher>__<action>` or
 * `gateway__<publisher>__<action>` naming convention, the publisher name is
 * extracted and repeated to boost its BM25 term frequency -- so queries
 * mentioning "google" or "slack" naturally rank that publisher's tools higher.
 */
function toolText(tool: OpenAITool): string {
  const parts: string[] = [];

  if (tool.function?.name) {
    parts.push(tool.function.name);

    // Boost publisher name for MCP/gateway tools
    const publisher = extractMcpPublisher(tool.function.name);
    if (publisher) {
      // Repeat publisher 3x to give it strong BM25 weight without
      // overwhelming the description/param signals.
      parts.push(`${publisher} ${publisher} ${publisher}`);
    }
  }
  if (tool.function?.description) {
    parts.push(tool.function.description);
  }

  // Include parameter names and descriptions for keyword matching.
  const props = tool.function?.parameters?.properties;
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      parts.push(key);
      if (val?.description) {
        parts.push(val.description);
      }
    }
  }

  return parts.join(" ").toLowerCase();
}

/**
 * Tokenize text into lowercase alphanumeric tokens, filtering single chars.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[^a-zA-Z0-9]+/)
    .filter((t) => t.length > 1)
    .map((t) => t.toLowerCase());
}

/**
 * Compute BM25 scores for each document given the query terms.
 *
 * Uses BM25 with k1=1.5, b=0.75, Okapi IDF smoothing, and a fixed average
 * document length estimate. IDF is precomputed per query term to avoid O(n^2).
 */
export function bm25Scores(queryOrTerms: string | string[], docs: string[]): number[] {
  const queryTerms: string[] =
    typeof queryOrTerms === "string" ? tokenize(queryOrTerms) : queryOrTerms;

  const n = docs.length;
  const tokenizedDocs = docs.map((d) => tokenize(d));

  // Precompute document frequency per query term.
  const dfMap = new Map<string, number>();
  for (const term of queryTerms) {
    if (dfMap.has(term)) continue;
    let df = 0;
    for (const doc of tokenizedDocs) {
      if (doc.includes(term)) {
        df++;
      }
    }
    dfMap.set(term, df);
  }

  return tokenizedDocs.map((docTerms) => {
    const dl = docTerms.length;
    const lengthNorm = K1 * (1.0 - B + (B * dl) / AVG_TOOL_WORDS);

    let score = 0;
    for (const term of queryTerms) {
      const tf = docTerms.filter((t) => t === term).length;
      if (tf === 0) continue;

      const dfT = dfMap.get(term) ?? 0;
      // Okapi IDF with smoothing (prevents log(0)).
      const idf = Math.log((n - dfT + 0.5) / (dfT + 0.5) + 1.0);
      const tfNorm = (tf * (K1 + 1.0)) / (tf + lengthNorm);
      score += idf * tfNorm;
    }
    return score;
  });
}

/** Approximate token count for a document string (4 chars ~ 1 token). */
function approximateTokens(text: string): number {
  return Math.max(Math.floor(text.length / CHARS_PER_TOKEN), 1);
}

/**
 * Apply the hard 400 KB byte budget as a final safety net.
 * BM25 selection is the primary mechanism; this catches edge cases.
 */
export function applyHardBudget(tools: OpenAITool[], budget: number = HARD_BYTE_BUDGET): OpenAITool[] {
  const total = JSON.stringify(tools).length;
  if (total <= budget) {
    return [...tools];
  }

  const result: OpenAITool[] = [];
  let running = 2; // outer `[` and `]`

  for (const tool of tools) {
    const bytes = JSON.stringify(tool).length + 1; // +1 for comma separator
    if (running + bytes > budget) {
      break;
    }
    running += bytes;
    result.push(tool);
  }

  console.warn(
    `[ToolRelevance] Hard byte budget applied: keeping ${result.length} of ${tools.length} tools (${running} bytes)`,
  );

  return result;
}
