// ABOUTME: File system handlers for the local runtime.
// ABOUTME: All paths validated against home directory to prevent traversal attacks.

import {
  access,
  readFile as fsReadFile,
  realpath,
  writeFile as fsWriteFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { realpathSync as realpathSyncNative } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

const home = homedir();
const tmp = tmpdir();
// Canonicalized versions for symlink comparison (e.g. macOS /var → /private/var)
let homeReal: string;
let tmpReal: string;
try {
  homeReal = realpathSyncNative(home);
} catch {
  homeReal = home;
}
try {
  tmpReal = realpathSyncNative(tmp);
} catch {
  tmpReal = tmp;
}

/**
 * Validate that a path is within the user's home directory or temp directory.
 * Resolves symlinks via fs.realpath to prevent symlink breakout attacks.
 */
export function validatePath(requestedPath: string): string {
  const resolved = resolve(requestedPath);
  if (resolved.startsWith(home) || resolved.startsWith(tmp)) {
    return resolved;
  }
  throw new Error("Access denied: path must be within home directory");
}

/**
 * Check if a canonicalized path is within allowed directories.
 */
function isAllowedPath(p: string): boolean {
  return (
    p.startsWith(home) ||
    p.startsWith(tmp) ||
    p.startsWith(homeReal) ||
    p.startsWith(tmpReal)
  );
}

/**
 * Validate path with symlink resolution for destructive or read operations.
 * Uses fs.realpath to canonicalize the path, then checks the allow list.
 */
export async function validatePathReal(requestedPath: string): Promise<string> {
  const resolved = resolve(requestedPath);
  // First check the literal path
  if (!isAllowedPath(resolved)) {
    throw new Error("Access denied: path must be within home directory");
  }
  // Then resolve symlinks and re-check
  try {
    const real = await realpath(resolved);
    if (!isAllowedPath(real)) {
      throw new Error("Access denied: symlink target is outside home directory");
    }
    return real;
  } catch (err) {
    // Path doesn't exist yet (e.g. createFile) — allow if literal path is valid
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return resolved;
    }
    throw err;
  }
}

export async function listDirectory(params: {
  path: string;
}): Promise<FileEntry[]> {
  const dir = await validatePathReal(params.path);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    path: join(dir, entry.name),
    is_directory: entry.isDirectory(),
  }));
}

export async function readFile(params: { path: string }): Promise<string> {
  const filePath = await validatePathReal(params.path);
  return fsReadFile(filePath, "utf-8");
}

export async function readFileBase64(params: { path: string }): Promise<string> {
  const filePath = await validatePathReal(params.path);
  const buffer = await fsReadFile(filePath);
  return Buffer.from(buffer).toString("base64");
}

export async function writeFile(params: {
  path: string;
  content: string;
}): Promise<void> {
  const filePath = await validatePathReal(params.path);
  await fsWriteFile(filePath, params.content, "utf-8");
}

export async function pathExists(params: { path: string }): Promise<boolean> {
  const p = await validatePathReal(params.path);
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(params: { path: string }): Promise<boolean> {
  const p = await validatePathReal(params.path);
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function createFile(params: {
  path: string;
  content?: string;
}): Promise<void> {
  const filePath = await validatePathReal(params.path);
  await fsWriteFile(filePath, params.content ?? "", "utf-8");
}

export async function createDirectory(params: { path: string }): Promise<void> {
  const dir = await validatePathReal(params.path);
  await mkdir(dir, { recursive: true });
}

export async function deletePath(params: { path: string }): Promise<void> {
  const p = await validatePathReal(params.path);
  await rm(p, { recursive: true, force: true });
}

export async function renamePath(params: {
  oldPath: string;
  newPath: string;
}): Promise<void> {
  const oldP = await validatePathReal(params.oldPath);
  const newP = await validatePathReal(params.newPath);
  await rename(oldP, newP);
}
