// ABOUTME: Skills directory management handlers for the local runtime.
// ABOUTME: TypeScript port of seren-desktop's Rust skills.rs Tauri commands.
// ABOUTME: Provides RPC handlers for reading, writing, listing, and installing skill files.

import {
  mkdir,
  readFile as fsReadFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  lstat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const home = homedir();

/**
 * Return the Seren config directory, respecting XDG_CONFIG_HOME.
 */
function serenConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, "seren");
  }
  return join(home, ".config", "seren");
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Check whether a path is relative and contains no `..` segments.
 * Prevents directory-traversal attacks when writing skill files.
 */
function isSafeRelativePath(p: string): boolean {
  if (isAbsolute(p)) return false;
  const normalized = normalize(p);
  if (normalized.startsWith("..")) return false;
  // Additional check: split and verify no component is ".."
  const parts = normalized.split(/[\\/]/);
  return !parts.some((part) => part === "..");
}

// ---------------------------------------------------------------------------
// Directory resolution handlers
// ---------------------------------------------------------------------------

/**
 * Get the Seren-scope skills directory.
 * `$XDG_CONFIG_HOME/seren/skills` when XDG_CONFIG_HOME is an absolute path,
 * otherwise `~/.config/seren/skills`.
 * Creates the directory if it does not exist.
 */
export async function getSerenSkillsDir(): Promise<string> {
  const dir = join(serenConfigDir(), "skills");
  await ensureDir(dir);
  return dir;
}

/**
 * Get the Claude Code skills directory (`~/.claude/skills`).
 * Creates the directory if it does not exist.
 */
export async function getClaudeSkillsDir(): Promise<string> {
  const dir = join(home, ".claude", "skills");
  await ensureDir(dir);
  return dir;
}

/**
 * Get the project-scope skills directory (`<project>/skills`).
 * Returns `null` when `projectRoot` is not supplied or the directory does not exist.
 */
export async function getProjectSkillsDir(params: {
  projectRoot?: string;
}): Promise<string | null> {
  const { projectRoot } = params;
  if (!projectRoot) return null;

  const root = resolve(projectRoot);
  try {
    const s = await stat(root);
    if (!s.isDirectory()) return null;
  } catch {
    return null;
  }

  const localSkillsDir = join(root, "skills");
  try {
    const s = await stat(localSkillsDir);
    if (s.isDirectory()) return localSkillsDir;
  } catch {
    // Directory does not exist — that is fine.
  }

  return null;
}

// ---------------------------------------------------------------------------
// File I/O handlers
// ---------------------------------------------------------------------------

/**
 * Read a file from within a skill directory.
 * `relativePath` must be a safe relative path (no `..` or absolute).
 */
export async function readSkillFile(params: {
  skillsDir: string;
  slug: string;
  relativePath: string;
}): Promise<string> {
  const { skillsDir, slug, relativePath } = params;

  if (!isSafeRelativePath(relativePath)) {
    throw new Error(
      `Invalid skill-relative path (must be relative, no ..): ${relativePath}`,
    );
  }

  const skillDir = join(resolve(skillsDir), slug);
  const filePath = join(skillDir, relativePath);
  return fsReadFile(filePath, "utf-8");
}

/**
 * Write a file inside a skill directory.
 * Creates intermediate directories as needed.
 * Marks `.sh` and `.py` files as executable on Unix.
 */
export async function writeSkillFile(params: {
  skillsDir: string;
  slug: string;
  relativePath: string;
  content: string;
}): Promise<void> {
  const { skillsDir, slug, relativePath, content } = params;

  if (!isSafeRelativePath(relativePath)) {
    throw new Error(
      `Invalid skill-relative path (must be relative, no ..): ${relativePath}`,
    );
  }

  const skillDir = join(resolve(skillsDir), slug);
  const filePath = join(skillDir, relativePath);

  await ensureDir(dirname(filePath));
  await fsWriteFile(filePath, content, "utf-8");

  // Make scripts executable
  if (relativePath.endsWith(".sh") || relativePath.endsWith(".py")) {
    const { chmod } = await import("node:fs/promises");
    await chmod(filePath, 0o755).catch(() => {});
  }
}

/**
 * List files in a skill directory.
 * Supports flat layout (`slug/SKILL.md`) and nested layout (`org/skill/SKILL.md`).
 * Returns sorted, deduplicated skill slugs.
 */
export async function listSkillFiles(params: {
  skillsDir: string;
}): Promise<string[]> {
  const { skillsDir } = params;
  const dirPath = resolve(skillsDir);

  try {
    await stat(dirPath);
  } catch {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const slugs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const entryPath = join(dirPath, entry.name);

    // Flat layout: slug/SKILL.md
    try {
      const skillFile = join(entryPath, "SKILL.md");
      const s = await stat(skillFile);
      if (s.isFile()) {
        slugs.push(entry.name);
        continue;
      }
    } catch {
      // SKILL.md not found at top level — check nested layout.
    }

    // Nested layout: org/skill/SKILL.md
    try {
      const subEntries = await readdir(entryPath, { withFileTypes: true });
      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory()) continue;
        const subSkillFile = join(entryPath, subEntry.name, "SKILL.md");
        try {
          const s = await stat(subSkillFile);
          if (s.isFile()) {
            slugs.push(`${entry.name}-${subEntry.name}`);
          }
        } catch {
          // Not a skill directory.
        }
      }
    } catch {
      // Cannot read sub-entries.
    }
  }

  // Sort and deduplicate
  slugs.sort();
  return [...new Set(slugs)];
}

// ---------------------------------------------------------------------------
// Atomic skill installation
// ---------------------------------------------------------------------------

interface ExtraFile {
  path: string;
  content: string;
}

/**
 * Atomically install a skill: write SKILL.md and optional extra files into a
 * skill directory.  Uses a temp directory + rename for crash safety and rolls
 * back on error.
 *
 * Returns the path to the installed SKILL.md file.
 */
export async function writeSkillTree(params: {
  skillsDir: string;
  slug: string;
  content: string;
  extraFiles?: ExtraFile[];
}): Promise<string> {
  const { skillsDir, slug, content, extraFiles = [] } = params;
  const dirPath = resolve(skillsDir);
  const skillDir = join(dirPath, slug);
  const tempDir = join(dirPath, `.${slug}.installing.${process.pid}.${Date.now()}`);
  let backupDir: string | null = null;

  try {
    // Write everything into a temporary directory first
    await ensureDir(tempDir);
    await fsWriteFile(join(tempDir, "SKILL.md"), content, "utf-8");

    for (const file of extraFiles) {
      if (!isSafeRelativePath(file.path)) {
        throw new Error(
          `Invalid file path (must be relative, no ..): ${file.path}`,
        );
      }
      const target = join(tempDir, file.path);
      await ensureDir(dirname(target));
      await fsWriteFile(target, file.content, "utf-8");

      // Make scripts executable
      if (file.path.endsWith(".sh") || file.path.endsWith(".py")) {
        const { chmod } = await import("node:fs/promises");
        await chmod(target, 0o755).catch(() => {});
      }
    }

    // If the skill directory already exists, move it to a backup location
    try {
      const s = await stat(skillDir);
      if (s.isDirectory()) {
        backupDir = join(dirPath, `.${slug}.backup.${process.pid}.${Date.now()}`);
        await rename(skillDir, backupDir);
      }
    } catch {
      // Skill directory does not exist yet — no backup needed.
    }

    // Activate the new skill directory
    await rename(tempDir, skillDir);
  } catch (error) {
    // Rollback: clean up temp directory and restore backup
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (backupDir) {
      try {
        await stat(skillDir);
      } catch {
        // skillDir does not exist, restore from backup
        await rename(backupDir, skillDir).catch(() => {});
      }
    }
    throw error;
  }

  // Clean up backup on success
  if (backupDir) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }

  return join(skillDir, "SKILL.md");
}

// ---------------------------------------------------------------------------
// Symlink management
// ---------------------------------------------------------------------------

/**
 * Create a symlink from `<projectRoot>/.claude/skills` pointing to
 * `../skills` (i.e. `<projectRoot>/skills`).
 *
 * This allows Claude Code (which reads `.claude/skills`) and OpenAI Codex
 * (which reads `skills/` directly) to share the same skill files.
 */
export async function createSkillsSymlink(params: {
  projectRoot: string;
}): Promise<void> {
  const { projectRoot } = params;
  const root = resolve(projectRoot);

  try {
    const s = await stat(root);
    if (!s.isDirectory()) throw new Error("Project root is not a directory");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Project root does not exist");
    }
    throw err;
  }

  const claudeDir = join(root, ".claude");
  const symlinkPath = join(claudeDir, "skills");
  const skillsDir = join(root, "skills");

  // Verify the skills directory exists
  try {
    const s = await stat(skillsDir);
    if (!s.isDirectory()) {
      throw new Error(
        `Could not find a skills directory. Expected ${skillsDir}`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Could not find a skills directory. Expected ${skillsDir}`,
      );
    }
    throw err;
  }

  // Create .claude directory if needed
  await ensureDir(claudeDir);

  // Remove existing symlink if present
  try {
    const linkStat = await lstat(symlinkPath);
    if (linkStat.isSymbolicLink()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(symlinkPath);
    } else {
      throw new Error(
        ".claude/skills exists but is not a symlink. Please remove it manually.",
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // Does not exist — proceed to create.
  }

  // Create relative symlink: .claude/skills -> ../skills
  const relativeTarget = join("..", "skills");
  await symlink(relativeTarget, symlinkPath);
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcHandler = (params: any) => Promise<unknown>;

/**
 * Register all skills-related RPC handlers.
 * Called from the central handler registry in index.ts.
 */
export function registerSkillsHandlers(
  register: (method: string, handler: RpcHandler) => void,
): void {
  register("get_seren_skills_dir", getSerenSkillsDir);
  register("get_claude_skills_dir", getClaudeSkillsDir);
  register("get_project_skills_dir", getProjectSkillsDir);
  register("read_skill_file", readSkillFile);
  register("write_skill_file", writeSkillFile);
  register("list_skill_files", listSkillFiles);
  register("write_skill_tree", writeSkillTree);
  register("create_skills_symlink", createSkillsSymlink);
}
