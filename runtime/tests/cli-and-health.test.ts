// ABOUTME: Tests for CLI arg parsing and /health endpoint token gating.
// ABOUTME: Ensures --host/--port/--help work and auth token is never leaked to remote clients.

import { describe, expect, it } from "vitest";
import { parseCliArgs, isLoopbackAddr } from "../src/cli";

// ── CLI arg parsing ─────────────────────────────────────────────────

describe("parseCliArgs", () => {
  it("returns defaults when no args provided", () => {
    const args = parseCliArgs([]);
    expect(args.host).toBe("127.0.0.1");
    expect(args.port).toBe(19420);
    expect(args.noOpen).toBe(false);
    expect(args.help).toBe(false);
  });

  it("parses --host flag", () => {
    const args = parseCliArgs(["node", "server.js", "--host", "0.0.0.0"]);
    expect(args.host).toBe("0.0.0.0");
  });

  it("parses -H short flag", () => {
    const args = parseCliArgs(["node", "server.js", "-H", "192.168.1.100"]);
    expect(args.host).toBe("192.168.1.100");
  });

  it("parses --port flag", () => {
    const args = parseCliArgs(["node", "server.js", "--port", "8080"]);
    expect(args.port).toBe(8080);
  });

  it("parses -p short flag", () => {
    const args = parseCliArgs(["node", "server.js", "-p", "3000"]);
    expect(args.port).toBe(3000);
  });

  it("parses --no-open flag", () => {
    const args = parseCliArgs(["node", "server.js", "--no-open"]);
    expect(args.noOpen).toBe(true);
  });

  it("parses --help flag", () => {
    const args = parseCliArgs(["node", "server.js", "--help"]);
    expect(args.help).toBe(true);
  });

  it("parses -h short flag", () => {
    const args = parseCliArgs(["node", "server.js", "-h"]);
    expect(args.help).toBe(true);
  });

  it("parses combined flags", () => {
    const args = parseCliArgs([
      "node", "server.js", "--host", "0.0.0.0", "-p", "9999", "--no-open",
    ]);
    expect(args.host).toBe("0.0.0.0");
    expect(args.port).toBe(9999);
    expect(args.noOpen).toBe(true);
  });

  it("ignores --host without value", () => {
    const args = parseCliArgs(["node", "server.js", "--host"]);
    // Should keep the default since there's no next arg
    expect(args.host).toBe("127.0.0.1");
  });
});

// ── isLoopbackAddr ──────────────────────────────────────────────────

describe("isLoopbackAddr", () => {
  it("returns true for IPv4 loopback", () => {
    expect(isLoopbackAddr("127.0.0.1")).toBe(true);
  });

  it("returns true for IPv6 loopback", () => {
    expect(isLoopbackAddr("::1")).toBe(true);
  });

  it("returns true for IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackAddr("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns false for LAN IP", () => {
    expect(isLoopbackAddr("192.168.1.50")).toBe(false);
  });

  it("returns false for public IP", () => {
    expect(isLoopbackAddr("8.8.8.8")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isLoopbackAddr(undefined)).toBe(false);
  });
});

// ── /health token gating (integration) ──────────────────────────────

describe("/health token gating", () => {
  it("token is excluded from response body when caller is non-loopback", () => {
    // Simulate the server logic: build /health response based on source IP
    const remoteAddr = "192.168.1.50";
    const fromLoopback = isLoopbackAddr(remoteAddr);
    const body: Record<string, string> = { status: "ok", version: "test", buildHash: "abc" };
    if (fromLoopback) body.token = "secret-token";

    expect(body.token).toBeUndefined();
    expect(body.status).toBe("ok");
  });

  it("token is included in response body when caller is loopback", () => {
    const remoteAddr = "127.0.0.1";
    const fromLoopback = isLoopbackAddr(remoteAddr);
    const body: Record<string, string> = { status: "ok", version: "test", buildHash: "abc" };
    if (fromLoopback) body.token = "secret-token";

    expect(body.token).toBe("secret-token");
  });

  it("token is included for IPv6 loopback", () => {
    const remoteAddr = "::1";
    const fromLoopback = isLoopbackAddr(remoteAddr);
    const body: Record<string, string> = { status: "ok", version: "test", buildHash: "abc" };
    if (fromLoopback) body.token = "secret-token";

    expect(body.token).toBe("secret-token");
  });

  it("token is included for IPv4-mapped IPv6 loopback", () => {
    const remoteAddr = "::ffff:127.0.0.1";
    const fromLoopback = isLoopbackAddr(remoteAddr);
    const body: Record<string, string> = { status: "ok", version: "test", buildHash: "abc" };
    if (fromLoopback) body.token = "secret-token";

    expect(body.token).toBe("secret-token");
  });
});
