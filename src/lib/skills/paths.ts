// ABOUTME: Path utilities for skills directories in seren-local.
// ABOUTME: Uses bridge.ts runtimeInvoke() instead of Tauri invoke().

import { isRuntimeConnected, runtimeInvoke } from "@/lib/bridge";

/** Cached Seren skills directory */
let cachedSerenSkillsDir: string | null = null;

/** Cached Claude Code skills directory */
let cachedClaudeSkillsDir: string | null = null;

/**
 * Get the Seren-scope skills directory.
 * Uses $XDG_CONFIG_HOME/seren/skills, fallback ~/.config/seren/skills.
 * Creates the directory if it doesn't exist.
 */
export async function getSerenSkillsDir(): Promise<string> {
  if (cachedSerenSkillsDir) {
    return cachedSerenSkillsDir;
  }

  if (!isRuntimeConnected()) {
    return "~/.config/seren/skills";
  }

  const dir = await runtimeInvoke<string>("get_seren_skills_dir");
  cachedSerenSkillsDir = dir;
  return dir;
}

/**
 * Get the Claude Code skills directory (~/.claude/skills/).
 * Creates the directory if it doesn't exist.
 */
export async function getClaudeSkillsDir(): Promise<string> {
  if (cachedClaudeSkillsDir) {
    return cachedClaudeSkillsDir;
  }

  if (!isRuntimeConnected()) {
    return "~/.claude/skills";
  }

  const dir = await runtimeInvoke<string>("get_claude_skills_dir");
  cachedClaudeSkillsDir = dir;
  return dir;
}

/**
 * Get the project-scope skills directory (skills/).
 * This is the canonical location following the AgentSkills.io standard.
 * A symlink at .claude/skills provides Claude Code compatibility with the project-local skills location.
 * Returns null if no project is currently open or runtime is not connected.
 */
export async function getProjectSkillsDir(
  projectRoot: string | null,
): Promise<string | null> {
  if (!isRuntimeConnected() || !projectRoot) {
    return null;
  }

  try {
    return await runtimeInvoke<string | null>("get_project_skills_dir", {
      projectRoot,
    });
  } catch {
    return null;
  }
}

/**
 * Get the full path for a skill file.
 */
export function getSkillPath(skillsDir: string, slug: string): string {
  // Normalize path separators for the platform
  const separator = skillsDir.includes("\\") ? "\\" : "/";
  return `${skillsDir}${separator}${slug}${separator}SKILL.md`;
}

/**
 * Get the directory path for a skill.
 */
export function getSkillDir(skillsDir: string, slug: string): string {
  const separator = skillsDir.includes("\\") ? "\\" : "/";
  return `${skillsDir}${separator}${slug}`;
}

/**
 * Create a symlink from .claude/skills to the active skills location for Claude Code compatibility.
 * This enables both Claude Code and OpenAI Codex to use the same skills directory.
 */
export async function createSkillsSymlink(projectRoot: string): Promise<void> {
  if (!isRuntimeConnected()) {
    return;
  }

  try {
    await runtimeInvoke("create_skills_symlink", { projectRoot });
  } catch (error) {
    console.error("Failed to create skills symlink:", error);
    throw error;
  }
}

/**
 * Clear cached paths (useful when project changes).
 */
export function clearPathCache(): void {
  cachedSerenSkillsDir = null;
  cachedClaudeSkillsDir = null;
}
