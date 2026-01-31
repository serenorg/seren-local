// ABOUTME: Tests for file system handlers in the local runtime.
// ABOUTME: Uses a temp directory for isolation; tests all FS operations and path traversal prevention.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listDirectory,
  readFile,
  writeFile,
  pathExists,
  isDirectory,
  createFile,
  createDirectory,
  deletePath,
  renamePath,
  validatePath,
} from "../../src/handlers/fs";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "seren-fs-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("validatePath", () => {
  it("rejects paths outside home directory", () => {
    expect(() => validatePath("/etc/passwd")).toThrow("Access denied");
  });

  it("rejects path traversal attempts", () => {
    expect(() => validatePath("/home/../etc/passwd")).toThrow("Access denied");
  });

  it("accepts paths within home directory", () => {
    const result = validatePath(tempDir);
    expect(result).toBe(tempDir);
  });
});

describe("file system handlers", () => {
  it("createDirectory creates a new directory", async () => {
    const dir = join(tempDir, "subdir");
    await createDirectory({ path: dir });
    const exists = await pathExists({ path: dir });
    expect(exists).toBe(true);
    const isDir = await isDirectory({ path: dir });
    expect(isDir).toBe(true);
  });

  it("createFile creates a new file with content", async () => {
    const file = join(tempDir, "test.txt");
    await createFile({ path: file, content: "hello world" });
    const exists = await pathExists({ path: file });
    expect(exists).toBe(true);
    const content = await readFile({ path: file });
    expect(content).toBe("hello world");
  });

  it("createFile creates empty file when no content given", async () => {
    const file = join(tempDir, "empty.txt");
    await createFile({ path: file });
    const content = await readFile({ path: file });
    expect(content).toBe("");
  });

  it("writeFile writes content to existing file", async () => {
    const file = join(tempDir, "write.txt");
    await createFile({ path: file, content: "before" });
    await writeFile({ path: file, content: "after" });
    const content = await readFile({ path: file });
    expect(content).toBe("after");
  });

  it("listDirectory returns file entries", async () => {
    const dir = join(tempDir, "listdir");
    await createDirectory({ path: dir });
    await createFile({ path: join(dir, "a.txt"), content: "a" });
    await createDirectory({ path: join(dir, "nested") });

    const entries = await listDirectory({ path: dir });
    expect(entries).toHaveLength(2);

    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "nested"]);

    const fileEntry = entries.find((e) => e.name === "a.txt")!;
    expect(fileEntry.is_directory).toBe(false);

    const dirEntry = entries.find((e) => e.name === "nested")!;
    expect(dirEntry.is_directory).toBe(true);
  });

  it("pathExists returns false for non-existent path", async () => {
    const exists = await pathExists({ path: join(tempDir, "nope") });
    expect(exists).toBe(false);
  });

  it("isDirectory returns false for a file", async () => {
    const file = join(tempDir, "isdir-check.txt");
    await createFile({ path: file, content: "x" });
    const isDir = await isDirectory({ path: file });
    expect(isDir).toBe(false);
  });

  it("deletePath removes a file", async () => {
    const file = join(tempDir, "to-delete.txt");
    await createFile({ path: file, content: "bye" });
    await deletePath({ path: file });
    const exists = await pathExists({ path: file });
    expect(exists).toBe(false);
  });

  it("deletePath removes a directory recursively", async () => {
    const dir = join(tempDir, "to-delete-dir");
    await createDirectory({ path: dir });
    await createFile({ path: join(dir, "inner.txt"), content: "x" });
    await deletePath({ path: dir });
    const exists = await pathExists({ path: dir });
    expect(exists).toBe(false);
  });

  it("renamePath renames a file", async () => {
    const oldPath = join(tempDir, "old-name.txt");
    const newPath = join(tempDir, "new-name.txt");
    await createFile({ path: oldPath, content: "renamed" });
    await renamePath({ oldPath, newPath });
    const oldExists = await pathExists({ path: oldPath });
    const newExists = await pathExists({ path: newPath });
    expect(oldExists).toBe(false);
    expect(newExists).toBe(true);
    const content = await readFile({ path: newPath });
    expect(content).toBe("renamed");
  });

  it("readFile rejects path traversal", async () => {
    await expect(readFile({ path: "/etc/passwd" })).rejects.toThrow(
      "Access denied",
    );
  });

  it("writeFile rejects path traversal", async () => {
    await expect(
      writeFile({ path: "/etc/evil", content: "bad" }),
    ).rejects.toThrow("Access denied");
  });

  it("listDirectory rejects path traversal", async () => {
    await expect(listDirectory({ path: "/etc" })).rejects.toThrow(
      "Access denied",
    );
  });
});
