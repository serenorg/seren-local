// ABOUTME: File system handlers for the local runtime.
// ABOUTME: All paths validated against home directory to prevent traversal attacks.

import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, mkdir, rm, rename, stat, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

const home = homedir();
const tmp = tmpdir();

/**
 * Validate that a path is within the user's home directory or temp directory.
 * Prevents path traversal attacks.
 */
export function validatePath(requestedPath: string): string {
  const resolved = resolve(requestedPath);
  if (resolved.startsWith(home) || resolved.startsWith(tmp)) {
    return resolved;
  }
  throw new Error("Access denied: path must be within home directory");
}

export async function listDirectory(params: { path: string }): Promise<FileEntry[]> {
  const dir = validatePath(params.path);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    path: join(dir, entry.name),
    is_directory: entry.isDirectory(),
  }));
}

export async function readFile(params: { path: string }): Promise<string> {
  const filePath = validatePath(params.path);
  return fsReadFile(filePath, "utf-8");
}

export async function writeFile(params: { path: string; content: string }): Promise<void> {
  const filePath = validatePath(params.path);
  await fsWriteFile(filePath, params.content, "utf-8");
}

export async function pathExists(params: { path: string }): Promise<boolean> {
  const p = validatePath(params.path);
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(params: { path: string }): Promise<boolean> {
  const p = validatePath(params.path);
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function createFile(params: { path: string; content?: string }): Promise<void> {
  const filePath = validatePath(params.path);
  await fsWriteFile(filePath, params.content ?? "", "utf-8");
}

export async function createDirectory(params: { path: string }): Promise<void> {
  const dir = validatePath(params.path);
  await mkdir(dir, { recursive: true });
}

export async function deletePath(params: { path: string }): Promise<void> {
  const p = validatePath(params.path);
  await rm(p, { recursive: true, force: true });
}

export async function renamePath(params: { oldPath: string; newPath: string }): Promise<void> {
  const oldP = validatePath(params.oldPath);
  const newP = validatePath(params.newPath);
  await rename(oldP, newP);
}
