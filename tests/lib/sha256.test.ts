// ABOUTME: Tests for SHA-256 utility with non-secure context fallback.
// ABOUTME: Validates correct hash output and fallback when crypto.subtle is unavailable.

import { describe, it, expect, vi, afterEach } from "vitest";
import { sha256 } from "@/lib/sha256";

describe("sha256", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces correct SHA-256 hex for empty string", async () => {
    const hash = await sha256("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("produces correct SHA-256 hex for 'hello'", async () => {
    const hash = await sha256("hello");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("produces correct hash when crypto.subtle is unavailable", async () => {
    // Simulate non-secure context
    vi.stubGlobal("crypto", {
      ...crypto,
      subtle: undefined,
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });

    const hash = await sha256("hello");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("returns 64-character hex string", async () => {
    const hash = await sha256("test content");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
