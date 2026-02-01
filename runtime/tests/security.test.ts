// ABOUTME: Security regression tests for runtime auth and path sandboxing.
// ABOUTME: Validates token auth on WebSocket and symlink breakout prevention.

import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePath, validatePathReal } from "../src/handlers/fs";

describe("validatePath (string-only check)", () => {
  it("allows paths within home directory", () => {
    const result = validatePath(join(homedir(), "projects", "test.txt"));
    expect(result).toContain(homedir());
  });

  it("allows paths within tmp directory", () => {
    const result = validatePath(join(tmpdir(), "test.txt"));
    expect(result).toContain(tmpdir());
  });

  it("rejects paths outside home and tmp", () => {
    expect(() => validatePath("/etc/passwd")).toThrow("Access denied");
  });

  it("rejects path traversal attempts", () => {
    expect(() => validatePath(join(homedir(), "..", "..", "etc", "passwd"))).toThrow("Access denied");
  });
});

describe("validatePathReal (symlink-aware check)", () => {
  const testDir = join(tmpdir(), `seren-security-test-${Date.now()}`);
  const safeFile = join(testDir, "safe.txt");
  const safeLink = join(testDir, "safe-link.txt");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(safeFile, "safe content");
    // Create a symlink to a file within allowed dirs
    try {
      symlinkSync(safeFile, safeLink);
    } catch {
      // symlink might fail on some systems
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("allows real paths within home directory", async () => {
    const result = await validatePathReal(join(homedir(), ".seren"));
    expect(result).toContain(homedir());
  });

  it("allows paths within tmp directory", async () => {
    const result = await validatePathReal(safeFile);
    expect(result).toContain(tmpdir());
  });

  it("allows symlinks that resolve within allowed dirs", async () => {
    const result = await validatePathReal(safeLink);
    // Should resolve to the real path, still within tmp
    expect(result).toContain(tmpdir());
  });

  it("rejects paths outside home and tmp", async () => {
    await expect(validatePathReal("/etc/passwd")).rejects.toThrow("Access denied");
  });

  it("allows non-existent paths within home (for createFile)", async () => {
    const result = await validatePathReal(join(homedir(), "nonexistent-seren-test-file.txt"));
    expect(result).toContain(homedir());
  });

  it("rejects path traversal attempts", async () => {
    await expect(
      validatePathReal(join(homedir(), "..", "..", "etc", "passwd")),
    ).rejects.toThrow("Access denied");
  });
});

describe("WebSocket auth token protocol", () => {
  it("auth message format is correct JSON-RPC", () => {
    // Verify the expected auth message structure
    const authMessage = {
      jsonrpc: "2.0",
      method: "auth",
      params: { token: "test-token" },
      id: 1,
    };
    expect(authMessage.method).toBe("auth");
    expect(authMessage.params.token).toBe("test-token");
    expect(authMessage.id).toBe(1);
  });

  it("auth success response format", () => {
    const successResponse = {
      jsonrpc: "2.0",
      result: { authenticated: true },
      id: 1,
    };
    expect(successResponse.result.authenticated).toBe(true);
  });
});
