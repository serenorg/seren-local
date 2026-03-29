// ABOUTME: Tests for runtime detection via server-injected meta tags.
// ABOUTME: Validates detection, token extraction, and origin resolution.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isServedByRuntime,
  getRuntimeToken,
  getRuntimeOrigin,
} from "@/lib/runtime-detect";

function injectMeta(name: string, content: string): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
  return meta;
}

let injected: HTMLMetaElement[] = [];

beforeEach(() => {
  injected = [];
});

afterEach(() => {
  for (const el of injected) el.remove();
  injected = [];
});

describe("isServedByRuntime", () => {
  it("returns false when no meta tag present", () => {
    expect(isServedByRuntime()).toBe(false);
  });

  it("returns true when seren-runtime-token meta tag present", () => {
    injected.push(injectMeta("seren-runtime-token", "abc123"));
    expect(isServedByRuntime()).toBe(true);
  });
});

describe("getRuntimeToken", () => {
  it("returns null when no meta tag present", () => {
    expect(getRuntimeToken()).toBeNull();
  });

  it("returns token value from meta tag", () => {
    injected.push(injectMeta("seren-runtime-token", "secret-token-xyz"));
    expect(getRuntimeToken()).toBe("secret-token-xyz");
  });
});

describe("getRuntimeOrigin", () => {
  it("returns null when not served by runtime", () => {
    expect(getRuntimeOrigin()).toBeNull();
  });

  it("returns window.location.origin when served by runtime", () => {
    injected.push(injectMeta("seren-runtime-token", "tok"));
    // In jsdom/happy-dom, window.location.origin is "http://localhost:3000" or similar
    expect(getRuntimeOrigin()).toBe(window.location.origin);
  });
});
