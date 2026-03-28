// ABOUTME: Tests for UUID generation that works in non-secure HTTP contexts.
// ABOUTME: Validates format, uniqueness, and fallback when crypto.randomUUID is unavailable.

import { describe, it, expect, vi, afterEach } from "vitest";
import { generateId } from "@/lib/uuid";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a valid UUID v4 string", () => {
    expect(generateId()).toMatch(UUID_RE);
  });

  it("returns unique values on successive calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });

  it("falls back to getRandomValues when randomUUID is unavailable", () => {
    // Simulate non-secure context: randomUUID is undefined
    const original = crypto.randomUUID;
    vi.stubGlobal("crypto", { ...crypto, randomUUID: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) });

    const id = generateId();
    expect(id).toMatch(UUID_RE);

    vi.stubGlobal("crypto", { ...crypto, randomUUID: original });
  });
});
