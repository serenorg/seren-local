// ABOUTME: Tests for the JSON-RPC command router.
// ABOUTME: Covers dispatch, error handling, parse errors, and method-not-found.

import { describe, it, expect, beforeEach } from "vitest";
import { handleMessage, registerHandler, clearHandlers } from "../src/rpc";

describe("JSON-RPC router", () => {
  beforeEach(() => {
    clearHandlers();
  });

  it("dispatches to registered handler and returns result", async () => {
    registerHandler("test_echo", async (params) => params);
    const result = await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "test_echo",
        params: { msg: "hello" },
        id: "1",
      }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.result).toEqual({ msg: "hello" });
    expect(parsed.id).toBe("1");
  });

  it("returns parse error for invalid JSON", async () => {
    const result = await handleMessage("not json");
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toContain("Parse error");
    expect(parsed.id).toBeNull();
  });

  it("returns method not found for unknown method", async () => {
    const result = await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "nonexistent",
        id: "2",
      }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(-32601);
    expect(parsed.id).toBe("2");
  });

  it("returns error when handler throws", async () => {
    registerHandler("test_throw", async () => {
      throw new Error("boom");
    });
    const result = await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "test_throw",
        id: "3",
      }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message).toBe("boom");
    expect(parsed.id).toBe("3");
  });

  it("returns invalid request for missing method field", async () => {
    const result = await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "4",
      }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.id).toBe("4");
  });

  it("handles notification (no id) without returning response", async () => {
    let called = false;
    registerHandler("test_notify", async () => {
      called = true;
    });
    const result = await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "test_notify",
        params: {},
      }),
    );
    expect(result).toBeNull();
    expect(called).toBe(true);
  });

  it("handles numeric ids", async () => {
    registerHandler("test_num", async () => 42);
    const result = await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "test_num",
        id: 7,
      }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.result).toBe(42);
    expect(parsed.id).toBe(7);
  });

  it("passes undefined params when none provided", async () => {
    let receivedParams: unknown;
    registerHandler("test_no_params", async (params) => {
      receivedParams = params;
      return "ok";
    });
    await handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "test_no_params",
        id: "8",
      }),
    );
    expect(receivedParams).toBeUndefined();
  });
});
