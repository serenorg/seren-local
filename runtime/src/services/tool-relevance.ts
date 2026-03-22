// ABOUTME: BM25-based tool relevance scoring for per-request tool selection.
// ABOUTME: Replaces naive byte-budget truncation with query-aware tool ranking.

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

/** Token budget for selected tools sent to the model per request. */
const TOOL_TOKEN_BUDGET = 2_000;

/** Minimum tools always included regardless of BM25 score. */
const MIN_TOOLS = 3;

/** Soft cap: never send more than this many tools even if budget allows. */
const MAX_TOOLS = 20;

/** Hard byte budget as a final safety net against HTTP 413 responses. */
const HARD_BYTE_BUDGET = 400 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the most relevant tools for the given query within the token budget.
 *
 * Algorithm:
 * 1. Fast-path: if the tool list already fits the budget, return it as-is.
 * 2. Score each tool with BM25 against name + description + parameter names/descriptions.
 * 3. Sort by score descending; greedily select within the token budget,
 *    guaranteeing at least MIN_TOOLS.
 * 4. Restore original frontend priority ordering in the final selection.
 * 5. Apply the hard byte budget as a final safety net.
 */
export function selectRelevantTools(query: string, tools: OpenAITool[]): OpenAITool[] {
  // Fast path: no scoring needed when the set is small enough.
  const totalBytes = JSON.stringify(tools).length;
  if (totalBytes <= HARD_BYTE_BUDGET && tools.length <= MAX_TOOLS) {
    return [...tools];
  }

  if (tools.length === 0) {
    return [];
  }

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return applyHardBudget(tools);
  }

  const docs = tools.map(toolText);
  const scores = bm25Scores(queryTerms, docs);

  // Rank tools by score descending.
  const ranked: Array<[number, number]> = scores
    .map((score, idx): [number, number] => [idx, score])
    .sort((a, b) => b[1] - a[1]);

  // Greedily pick tools into the token budget.
  const selectedIndices: number[] = [];
  let tokenCount = 0;

  for (const [idx] of ranked) {
    if (selectedIndices.length >= MAX_TOOLS) {
      break;
    }
    const toolTokens = approximateTokens(docs[idx]);
    const budgetExceeded =
      tokenCount + toolTokens > TOOL_TOKEN_BUDGET && selectedIndices.length >= MIN_TOOLS;
    if (budgetExceeded) {
      break;
    }
    selectedIndices.push(idx);
    tokenCount += toolTokens;
  }

  // Restore original ordering so the frontend's priority ranking is preserved.
  selectedIndices.sort((a, b) => a - b);

  const result = selectedIndices.map((i) => tools[i]);

  console.log(
    `[ToolRelevance] Selected ${result.length} of ${tools.length} tools (~${tokenCount} tokens)`,
  );

  return applyHardBudget(result);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract indexable text from an OpenAI-format tool definition.
 * Concatenates: function name + description + parameter names + parameter descriptions.
 */
function toolText(tool: OpenAITool): string {
  const parts: string[] = [];

  if (tool.function?.name) {
    parts.push(tool.function.name);
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
 *
 * When called from selectRelevantTools the queryTerms are already tokenized.
 * The public overload accepts a raw query string and an array of document strings
 * for external callers.
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
