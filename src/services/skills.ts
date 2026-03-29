// ABOUTME: Skills service for managing skill discovery, installation, and content.
// ABOUTME: Ported from seren-desktop; replaces Tauri invoke() with bridge.ts runtimeInvoke().

import { isRuntimeConnected, runtimeInvoke } from "@/lib/bridge";
import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import {
  computeContentHash,
  getSkillPath,
  type InstalledSkill,
  parseSkillMd,
  type RemoteSkillRevision,
  resolveSkillDisplayName,
  resolveSkillSlug,
  type Skill,
  type SkillIndexEntry,
  type SkillScope,
  type SkillSource,
  type SkillSyncState,
  type SkillSyncStatus,
} from "@/lib/skills";
import { catalog, type Publisher } from "./catalog";

const SKILLS_REPO_OWNER = "serenorg";
const SKILLS_REPO_NAME = "seren-skills";
const SKILLS_REPO_BRANCH = "main";
const SKILLS_INDEX_URL = `https://api.github.com/repos/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/git/trees/${SKILLS_REPO_BRANCH}?recursive=1`;
const SKILLS_RAW_URL = `https://raw.githubusercontent.com/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/${SKILLS_REPO_BRANCH}`;
const INDEX_CACHE_KEY = "seren:skills_index";
const PUBLISHER_SKILLS_CACHE_KEY = "seren:publisher_skills";
const INDEX_CACHE_DURATION = 1000 * 60 * 5; // 5 minutes
const MAX_STALE_CACHE_AGE = 1000 * 60 * 60; // 1 hour — don't serve cache older than this on error

interface GitHubTreeNode {
  path?: string;
  type?: string;
}

interface GitHubTreeResponse {
  tree?: GitHubTreeNode[];
}

interface GitHubCommitListEntry {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    committer?: {
      date?: string;
    };
  };
}

interface GitHubCommitFile {
  filename?: string;
}

interface GitHubCommitDetail extends GitHubCommitListEntry {
  files?: GitHubCommitFile[];
}

interface ExtraFile {
  path: string;
  content: string;
}

interface UpstreamSkillBundle {
  skillMd: string;
  payloadFiles: ExtraFile[];
  remoteRevision: RemoteSkillRevision | null;
}

export interface InstallResult {
  installed: InstalledSkill;
  missingFiles: string[];
}

export interface ProjectSkillsConfig {
  version: number;
  skills: {
    enabled: string[];
  };
}

function githubApiHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Transform an index entry to a Skill.
 */
function indexEntryToSkill(entry: SkillIndexEntry): Skill {
  return {
    id: `${entry.source}:${entry.slug}`,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    tags: entry.tags,
    author: entry.author,
    version: entry.version,
  };
}

/**
 * Serialize a skill for index cache.
 */
function skillToIndexEntry(skill: Skill): SkillIndexEntry {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourceUrl: skill.sourceUrl ?? "",
    tags: skill.tags,
    author: skill.author,
    version: skill.version,
  };
}

/**
 * Convert a repo file path to org/skill-name.
 */
function parseRepoSkillPath(path: string): {
  org: string;
  skill: string;
} | null {
  const match = path.match(/^([^/]+)\/([^/]+)\/SKILL\.md$/);
  if (!match) return null;
  return { org: match[1], skill: match[2] };
}

/**
 * Fetch and parse a single remote SKILL.md from the skills repo.
 */
async function fetchSkillFromRepo(path: string): Promise<Skill | null> {
  const segments = path
    .split("/")
    .map((segment) => encodeURIComponent(segment));
  const sourceUrl = `${SKILLS_RAW_URL}/${segments.join("/")}`;
  const parsedPath = parseRepoSkillPath(path);
  if (!parsedPath) return null;

  const response = await appFetch(sourceUrl);
  if (!response.ok) {
    console.warn("[Skills] Failed to fetch repo skill", sourceUrl, response.status);
    return null;
  }

  const content = await response.text();
  const parsed = parseSkillMd(content);

  const slug = `${parsedPath.org}-${parsedPath.skill}`.toLowerCase();

  return {
    id: `serenorg:${slug}`,
    slug,
    name: resolveSkillDisplayName(parsed, slug),
    description: parsed.metadata.description || "Install this skill to add it.",
    source: "serenorg" as SkillSource,
    sourceUrl,
    tags: parsed.metadata.tags ?? [],
    author: parsed.metadata.author,
    version: parsed.metadata.version,
  };
}

/**
 * Cached GitHub tree from the most recent index fetch.
 * Used to discover sibling files when installing a skill.
 */
let cachedRepoTree: GitHubTreeNode[] | null = null;

/**
 * Fetch all available skills from GitHub repository tree.
 */
async function fetchSkillsFromRepoIndex(): Promise<Skill[]> {
  const response = await appFetch(SKILLS_INDEX_URL, {
    headers: githubApiHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch skills index: ${response.status}`);
  }

  const payload = (await response.json()) as GitHubTreeResponse;
  cachedRepoTree = payload.tree ?? [];

  const skillFiles = cachedRepoTree.filter(
    (node) =>
      node.type === "blob" &&
      typeof node.path === "string" &&
      parseRepoSkillPath(node.path),
  );

  const settled = await Promise.allSettled(
    skillFiles.map((entry) => {
      if (!entry.path) return Promise.resolve(null);
      return fetchSkillFromRepo(entry.path);
    }),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((skill): skill is Skill => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Derive the GitHub skill directory prefix from a sourceUrl.
 * e.g. "https://raw.githubusercontent.com/.../curve/curve-gauge-yield-trader/SKILL.md"
 *   -> "curve/curve-gauge-yield-trader/"
 */
function deriveRepoDirPrefix(sourceUrl: string): string | null {
  const base = `${SKILLS_RAW_URL}/`;
  if (!sourceUrl.startsWith(base)) return null;
  const relative = sourceUrl.slice(base.length);
  const lastSlash = relative.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return relative.slice(0, lastSlash + 1);
}

function normalizeRepoDirPath(dirPrefix: string): string {
  return dirPrefix.endsWith("/") ? dirPrefix.slice(0, -1) : dirPrefix;
}

function trimChangedFilesToSkill(
  changedFiles: string[],
  dirPrefix: string,
): string[] {
  const normalizedPrefix = normalizeRepoDirPath(dirPrefix);
  return changedFiles
    .filter((path) => path.startsWith(`${normalizedPrefix}/`))
    .map((path) => path.slice(normalizedPrefix.length + 1));
}

function buildManagedFileMap(
  skillMdHash: string,
  payloadFiles: Array<{ path: string; content: string; hash?: string }>,
): Record<string, string> {
  const managedFiles: Record<string, string> = {
    "SKILL.md": skillMdHash,
  };

  for (const file of payloadFiles) {
    if (file.hash) {
      managedFiles[file.path] = file.hash;
    }
  }

  return managedFiles;
}

function localManagedStateFingerprint(
  localManagedState: Record<string, string | null>,
): string {
  return Object.entries(localManagedState)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, hash]) => `${path}:${hash ?? "missing"}`)
    .join("\n");
}

function remoteRevisionShortSha(sha?: string): string {
  if (!sha) return "";
  return sha.slice(0, 7);
}

async function fetchRemoteSkillRevision(
  sourceUrl: string,
): Promise<RemoteSkillRevision | null> {
  const dirPrefix = deriveRepoDirPrefix(sourceUrl);
  if (!dirPrefix) return null;
  const path = normalizeRepoDirPath(dirPrefix);
  const commitsUrl = `https://api.github.com/repos/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/commits?sha=${encodeURIComponent(SKILLS_REPO_BRANCH)}&path=${encodeURIComponent(path)}&per_page=1`;

  const response = await appFetch(commitsUrl, {
    headers: githubApiHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch remote revision: ${response.status}`);
  }

  const commits = (await response.json()) as GitHubCommitListEntry[];
  const latest = commits[0];
  const sha = latest?.sha;
  if (!sha) return null;

  const detailResponse = await appFetch(
    `https://api.github.com/repos/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/commits/${encodeURIComponent(sha)}`,
    { headers: githubApiHeaders() },
  );
  if (!detailResponse.ok) {
    throw new Error(`Failed to fetch commit detail: ${detailResponse.status}`);
  }

  const detail = (await detailResponse.json()) as GitHubCommitDetail;
  return {
    sha,
    shortSha: remoteRevisionShortSha(sha),
    committedAt: detail.commit?.committer?.date,
    message: detail.commit?.message,
    url: detail.html_url,
    changedFiles: trimChangedFilesToSkill(
      (detail.files ?? [])
        .map((file) => file.filename)
        .filter((filename): filename is string => typeof filename === "string"),
      dirPrefix,
    ),
  };
}

async function fetchUpstreamSkillBundle(skill: {
  sourceUrl?: string;
}): Promise<UpstreamSkillBundle | null> {
  if (!skill.sourceUrl) return null;

  // Phase 1: Fetch SKILL.md, repo tree, and revision in parallel
  const cacheBustedUrl = `${skill.sourceUrl}${skill.sourceUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const [skillMd, freshTree, remoteRevision] = await Promise.all([
    appFetch(cacheBustedUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch skill content: ${response.status}`);
      }
      return response.text();
    }),
    fetchFreshRepoTree(skill.sourceUrl),
    fetchRemoteSkillRevision(skill.sourceUrl),
  ]);

  // Phase 2: Parse SKILL.md for includes, then fetch payload + includes files
  const parsed = parseSkillMd(skillMd);
  const payloadFiles = await fetchPayloadAndIncludes(
    skill.sourceUrl,
    freshTree,
    parsed.metadata.includes,
  );

  return { skillMd, payloadFiles, remoteRevision };
}

async function computeUpstreamSyncState(
  upstreamSource: SkillSource,
  upstreamSourceUrl: string,
  remoteRevision: RemoteSkillRevision | null,
  skillMd: string,
  payloadFiles: ExtraFile[],
): Promise<SkillSyncState> {
  const skillMdHash = await computeContentHash(skillMd);
  const payloadWithHashes = await Promise.all(
    payloadFiles.map(async (file) => ({
      path: file.path,
      content: file.content,
      hash: await computeContentHash(file.content),
    })),
  );

  return {
    version: 1,
    upstreamSource,
    upstreamSourceUrl,
    syncedRevision: remoteRevision?.sha ?? null,
    syncedAt: Date.now(),
    managedFiles: buildManagedFileMap(skillMdHash, payloadWithHashes),
  };
}

function isManagedFileMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([path, hash]) => typeof path === "string" && typeof hash === "string",
  );
}

function parseInstalledSyncState(
  raw: string,
  dirName: string,
): SkillSyncState | null {
  try {
    const parsedSyncState = JSON.parse(raw) as Partial<SkillSyncState>;
    const normalizedSyncedRevision =
      parsedSyncState.syncedRevision === undefined
        ? null
        : parsedSyncState.syncedRevision;
    if (
      parsedSyncState?.version !== 1 ||
      typeof parsedSyncState.upstreamSource !== "string" ||
      typeof parsedSyncState.upstreamSourceUrl !== "string" ||
      parsedSyncState.upstreamSourceUrl.length === 0 ||
      (normalizedSyncedRevision !== null &&
        typeof normalizedSyncedRevision !== "string") ||
      typeof parsedSyncState.syncedAt !== "number" ||
      !isManagedFileMap(parsedSyncState.managedFiles)
    ) {
      return null;
    }

    if (
      parsedSyncState.upstreamSource === "serenorg" &&
      !deriveRepoDirPrefix(parsedSyncState.upstreamSourceUrl)
    ) {
      return null;
    }

    return {
      ...parsedSyncState,
      syncedRevision: normalizedSyncedRevision,
    } as SkillSyncState;
  } catch (error) {
    console.warn("[Skills] Failed to parse sync state for", dirName, error);
    return null;
  }
}

export function isUpstreamManagedSkill(
  skill: InstalledSkill,
): skill is InstalledSkill & {
  syncState: SkillSyncState;
  upstreamSource: "serenorg";
  upstreamSourceUrl: string;
} {
  return (
    !!skill.syncState &&
    skill.upstreamSource === "serenorg" &&
    typeof skill.upstreamSourceUrl === "string" &&
    skill.upstreamSourceUrl.length > 0
  );
}

/**
 * Check if an installed skill is managed by a Seren publisher (has sync state
 * with source "seren"). Used to detect stale publisher skills whose publisher
 * has been deleted.
 */
export function isPublisherManagedSkill(
  skill: InstalledSkill,
): skill is InstalledSkill & {
  syncState: SkillSyncState;
  upstreamSource: "seren";
  upstreamSourceUrl: string;
} {
  return (
    !!skill.syncState &&
    skill.upstreamSource === "seren" &&
    typeof skill.upstreamSourceUrl === "string" &&
    skill.upstreamSourceUrl.length > 0
  );
}

/**
 * Fetch a fresh repo tree with cache-bust to avoid GitHub API CDN staleness.
 * On failure this throws — callers must not fall back to a stale tree
 * because recording a new syncedRevision with old file content would mask
 * an incomplete sync and prevent future retries.
 */
async function fetchFreshRepoTree(
  _sourceUrl: string,
): Promise<GitHubTreeNode[]> {
  const cacheBustedTreeUrl = `${SKILLS_INDEX_URL}&t=${Date.now()}`;
  const response = await appFetch(cacheBustedTreeUrl, {
    headers: githubApiHeaders(),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch repo tree for payload files: ${response.status}`,
    );
  }
  const payload = (await response.json()) as GitHubTreeResponse;
  const freshTree = payload.tree ?? [];
  cachedRepoTree = freshTree;
  return freshTree;
}

/**
 * Validate an includes path for safety.
 * Must be relative, no traversal, no absolute paths.
 */
function isValidIncludesPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..")) return false;
  if (path.startsWith(".") && !path.startsWith("./")) return false;
  return true;
}

/**
 * Collect blob file nodes from a tree matching a directory prefix.
 * Returns objects mapping each file's repo path to its install-relative path.
 */
function collectTreeFiles(
  tree: GitHubTreeNode[],
  dirPrefix: string,
  relativePrefix: string,
  excludeSkillMd: boolean,
): Array<{ repoPath: string; relativePath: string }> {
  return tree
    .filter(
      (node) =>
        node.type === "blob" &&
        typeof node.path === "string" &&
        node.path.startsWith(dirPrefix) &&
        (!excludeSkillMd || !node.path.endsWith("/SKILL.md")),
    )
    .map((node) => ({
      repoPath: node.path as string,
      relativePath:
        relativePrefix + (node.path as string).slice(dirPrefix.length),
    }));
}

/**
 * Fetch raw file contents from GitHub for a list of file nodes.
 */
async function fetchRawFilesFromTree(
  nodes: Array<{ repoPath: string; relativePath: string }>,
): Promise<ExtraFile[]> {
  if (nodes.length === 0) return [];

  const results = await Promise.allSettled(
    nodes.map(async ({ repoPath, relativePath }): Promise<ExtraFile> => {
      const segments = repoPath.split("/").map((s) => encodeURIComponent(s));
      const rawUrl = `${SKILLS_RAW_URL}/${segments.join("/")}?t=${Date.now()}`;

      const resp = await appFetch(rawUrl);
      if (!resp.ok) {
        throw new Error(
          `Failed to fetch payload file ${relativePath}: HTTP ${resp.status}`,
        );
      }
      const content = await resp.text();
      return { path: relativePath, content };
    }),
  );

  const files: ExtraFile[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      files.push(result.value);
    } else {
      failures.push(result.reason?.message ?? String(result.reason));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to fetch ${failures.length}/${nodes.length} payload files: ${failures.join("; ")}`,
    );
  }

  return files;
}

/**
 * Fetch payload files from a skill's directory plus any declared includes paths.
 * Includes files are installed under `_deps/{repo-path}/` to keep them
 * safely within the skill directory while preserving the upstream structure.
 */
async function fetchPayloadAndIncludes(
  sourceUrl: string,
  tree: GitHubTreeNode[],
  includes?: string[],
): Promise<ExtraFile[]> {
  const dirPrefix = deriveRepoDirPrefix(sourceUrl);
  if (!dirPrefix || tree.length === 0) return [];

  // Collect files from the skill's own directory (excluding SKILL.md)
  const fileNodes = collectTreeFiles(tree, dirPrefix, "", true);

  // Collect files from declared includes paths (installed under _deps/)
  if (includes && includes.length > 0) {
    for (const includePath of includes) {
      if (!isValidIncludesPath(includePath)) {
        console.warn("[Skills] Skipping invalid includes path:", includePath);
        continue;
      }
      const normalizedPath = includePath.endsWith("/")
        ? includePath
        : `${includePath}/`;
      const includeNodes = collectTreeFiles(
        tree,
        normalizedPath,
        `_deps/${normalizedPath}`,
        false,
      );
      if (includeNodes.length === 0) {
        console.warn("[Skills] No files found for includes path:", includePath);
      }
      fileNodes.push(...includeNodes);
    }
    if (fileNodes.some((n) => n.relativePath.startsWith("_deps/"))) {
      console.info(
        "[Skills] Including shared dependencies from",
        includes.length,
        "declared paths",
      );
    }
  }

  if (fileNodes.length === 0) return [];

  console.info(
    "[Skills] Fetching",
    fileNodes.length,
    "payload files for",
    dirPrefix,
  );

  return fetchRawFilesFromTree(fileNodes);
}

/**
 * Convert a Seren publisher to a Skill.
 */
function publisherToSkill(publisher: Publisher): Skill {
  // Map publisher type to tags
  const typeTags: string[] = [];
  if (publisher.publisher_type === "database") typeTags.push("database");
  if (publisher.publisher_type === "api") typeTags.push("api");
  if (publisher.publisher_type === "mcp") typeTags.push("mcp");

  // Combine with publisher categories
  const tags = [...new Set([...typeTags, ...publisher.categories])];

  return {
    id: `seren:${publisher.slug}`,
    slug: publisher.slug,
    name: publisher.resource_name || publisher.name,
    description: publisher.description,
    source: "seren" as SkillSource,
    sourceUrl: `${apiBase}/publishers/${publisher.slug}/skill.md`,
    tags,
    author: publisher.name,
  };
}

// ---------------------------------------------------------------------------
// Helpers for composing RPC calls from available runtime primitives.
// The seren-local runtime exposes: read_skill_file, write_skill_file,
// list_skill_files, write_skill_tree.  Desktop-only commands like
// install_skill, remove_skill, read_skill_content, resolve_skill_path,
// read_skill_sync_state, write_skill_sync_state, list_skill_dirs,
// validate_skill_payload, and rename_skill_dir are composed from
// those primitives here.
// ---------------------------------------------------------------------------

/**
 * Read SKILL.md content from an installed skill directory.
 * Composed from read_skill_file with relativePath "SKILL.md".
 */
async function readSkillContent(
  skillsDir: string,
  slug: string,
): Promise<string | null> {
  try {
    return await runtimeInvoke<string>("read_skill_file", {
      skillsDir,
      slug,
      relativePath: "SKILL.md",
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the full path to SKILL.md for a given skill directory.
 * Composed locally since getSkillPath is a pure function.
 */
function resolveSkillPath(skillsDir: string, slug: string): string {
  return getSkillPath(skillsDir, slug);
}

/**
 * Read .seren-sync.json from an installed skill directory.
 * Composed from read_skill_file.
 */
async function readSkillSyncState(
  skillsDir: string,
  slug: string,
): Promise<string | null> {
  try {
    return await runtimeInvoke<string>("read_skill_file", {
      skillsDir,
      slug,
      relativePath: ".seren-sync.json",
    });
  } catch {
    return null;
  }
}

/**
 * Write .seren-sync.json to an installed skill directory.
 * Composed from write_skill_file.
 */
async function writeSkillSyncState(
  skillsDir: string,
  slug: string,
  stateJson: string,
): Promise<void> {
  await runtimeInvoke("write_skill_file", {
    skillsDir,
    slug,
    relativePath: ".seren-sync.json",
    content: stateJson,
  });
}

/**
 * Install a skill atomically using write_skill_tree.
 * Also writes sync state if provided.
 * Returns the path to the installed SKILL.md file.
 */
async function installSkill(params: {
  skillsDir: string;
  slug: string;
  content: string;
  extraFiles?: ExtraFile[];
  syncStateJson?: string | null;
}): Promise<string> {
  const { skillsDir, slug, content, extraFiles = [], syncStateJson } = params;

  // Build the full extra files list, including sync state if provided
  const allExtraFiles = [...extraFiles];
  if (syncStateJson) {
    allExtraFiles.push({
      path: ".seren-sync.json",
      content: syncStateJson,
    });
  }

  const path = await runtimeInvoke<string>("write_skill_tree", {
    skillsDir,
    slug,
    content,
    extraFiles: allExtraFiles.length > 0 ? allExtraFiles : undefined,
  });

  return path;
}

/**
 * Remove an installed skill by deleting its directory via write_skill_tree
 * with empty content replacement, then using the runtime's delete_path.
 * Since we have generic file ops via the bridge, we use delete_path.
 */
async function removeSkill(
  skillsDir: string,
  slug: string,
): Promise<void> {
  const separator = skillsDir.includes("\\") ? "\\" : "/";
  const skillDir = `${skillsDir}${separator}${slug}`;
  await runtimeInvoke("delete_path", { path: skillDir });
}

/**
 * Read a project config file at {project}/.seren/config.json.
 * Composed from the generic read_file RPC.
 */
async function readProjectConfigRaw(
  projectRoot: string,
): Promise<string | null> {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const configPath = `${projectRoot}${separator}.seren${separator}config.json`;
  try {
    return await runtimeInvoke<string>("read_file", { path: configPath });
  } catch {
    return null;
  }
}

/**
 * Write a project config file at {project}/.seren/config.json.
 * Composed from the generic write_file RPC, creating the directory if needed.
 */
async function writeProjectConfigRaw(
  projectRoot: string,
  content: string,
): Promise<void> {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const dirPath = `${projectRoot}${separator}.seren`;
  const configPath = `${dirPath}${separator}config.json`;
  try {
    await runtimeInvoke("create_directory", { path: dirPath });
  } catch {
    // Directory may already exist
  }
  await runtimeInvoke("write_file", { path: configPath, content });
}

/**
 * Clear a project config file at {project}/.seren/config.json.
 * Composed from the generic delete_path RPC.
 */
async function clearProjectConfigRaw(
  projectRoot: string,
): Promise<void> {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const configPath = `${projectRoot}${separator}.seren${separator}config.json`;
  try {
    await runtimeInvoke("delete_path", { path: configPath });
  } catch {
    // File may not exist
  }
}

/**
 * Read thread skills from {project}/.seren/threads/{threadId}.json.
 */
async function readThreadSkillsRaw(
  projectRoot: string,
  threadId: string,
): Promise<string[] | null> {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const filePath = `${projectRoot}${separator}.seren${separator}threads${separator}${threadId}.json`;
  try {
    const raw = await runtimeInvoke<string>("read_file", { path: filePath });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === "string");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write thread skills to {project}/.seren/threads/{threadId}.json.
 */
async function writeThreadSkillsRaw(
  projectRoot: string,
  threadId: string,
  skillRefs: string[],
): Promise<void> {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const dirPath = `${projectRoot}${separator}.seren${separator}threads`;
  const filePath = `${dirPath}${separator}${threadId}.json`;
  try {
    await runtimeInvoke("create_directory", { path: dirPath });
  } catch {
    // Directory may already exist
  }
  await runtimeInvoke("write_file", {
    path: filePath,
    content: JSON.stringify(skillRefs),
  });
}

/**
 * Clear thread skills by deleting {project}/.seren/threads/{threadId}.json.
 */
async function clearThreadSkillsRaw(
  projectRoot: string,
  threadId: string,
): Promise<void> {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const filePath = `${projectRoot}${separator}.seren${separator}threads${separator}${threadId}.json`;
  try {
    await runtimeInvoke("delete_path", { path: filePath });
  } catch {
    // File may not exist
  }
}

/**
 * Skills service for Seren Local.
 */
export const skills = {
  /**
   * Fetch the skills index from the aggregated endpoint.
   * Uses caching to reduce network requests. Pass skipCache to force a fresh fetch.
   */
  async fetchIndex(skipCache = false): Promise<Skill[]> {
    try {
      // Check cache first (unless explicitly bypassed)
      if (!skipCache) {
        const cached = localStorage.getItem(INDEX_CACHE_KEY);
        if (cached) {
          const { timestamp, data } = JSON.parse(cached);
          if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
            console.info("[Skills] Using cached index");
            return (data as SkillIndexEntry[]).map(indexEntryToSkill);
          }
        }
      }

      console.info("[Skills] Fetching skills index from", SKILLS_INDEX_URL);
      const skills = await fetchSkillsFromRepoIndex();

      // Cache the result
      localStorage.setItem(
        INDEX_CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          data: skills.map(skillToIndexEntry),
        }),
      );

      console.info("[Skills] Fetched", skills.length, "skills from repo");
      return skills;
    } catch (error) {
      console.error("[Skills] Error fetching index:", error);
      const cached = localStorage.getItem(INDEX_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        const ageMs = Date.now() - timestamp;
        if (ageMs < MAX_STALE_CACHE_AGE) {
          console.warn(
            "[Skills] Serving stale index cache, age:",
            Math.round(ageMs / 1000),
            "s",
          );
          return (data as SkillIndexEntry[]).map(indexEntryToSkill);
        }
        console.error(
          "[Skills] Stale cache too old to serve:",
          Math.round(ageMs / 1000),
          "s",
        );
      }
      return [];
    }
  },

  /**
   * Fetch skills from Seren publishers.
   * Each publisher has a skill.md available at /publishers/{slug}/skill.md
   */
  async fetchPublisherSkills(skipCache = false): Promise<Skill[]> {
    try {
      // Check cache first (unless explicitly bypassed)
      if (!skipCache) {
        const cached = localStorage.getItem(PUBLISHER_SKILLS_CACHE_KEY);
        if (cached) {
          const { timestamp, data } = JSON.parse(cached);
          if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
            console.info("[Skills] Using cached publisher skills");
            return data as Skill[];
          }
        }
      }

      console.info("[Skills] Fetching publisher skills from catalog");
      const publishers = await catalog.list();

      // Convert publishers to skills
      const skills = publishers
        .filter((p) => p.is_active)
        .map(publisherToSkill);

      // Cache the result
      localStorage.setItem(
        PUBLISHER_SKILLS_CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          data: skills,
        }),
      );

      console.info("[Skills] Fetched", skills.length, "publisher skills");
      return skills;
    } catch (error) {
      console.error("[Skills] Error fetching publisher skills:", error);
      const cached = localStorage.getItem(PUBLISHER_SKILLS_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        const ageMs = Date.now() - timestamp;
        if (ageMs < MAX_STALE_CACHE_AGE) {
          console.warn(
            "[Skills] Serving stale publisher skills cache, age:",
            Math.round(ageMs / 1000),
            "s",
          );
          return data as Skill[];
        }
        console.error(
          "[Skills] Stale publisher skills cache too old to serve:",
          Math.round(ageMs / 1000),
          "s",
        );
      }
      return [];
    }
  },

  /**
   * Fetch all available skills (from index + publishers).
   */
  async fetchAllSkills(skipCache = false): Promise<Skill[]> {
    const [indexSkills, publisherSkills] = await Promise.all([
      this.fetchIndex(skipCache),
      this.fetchPublisherSkills(skipCache),
    ]);

    // Merge skills, with publisher skills taking precedence for duplicates
    const skillMap = new Map<string, Skill>();

    // Add index skills first
    for (const skill of indexSkills) {
      skillMap.set(skill.slug, skill);
    }

    // Publisher skills override index skills (they're more up-to-date)
    for (const skill of publisherSkills) {
      skillMap.set(skill.slug, skill);
    }

    return Array.from(skillMap.values());
  },

  /**
   * Get the Seren-scope skills directory.
   * Uses $XDG_CONFIG_HOME/seren/skills, fallback ~/.config/seren/skills.
   */
  async getSerenSkillsDir(): Promise<string> {
    if (!isRuntimeConnected()) {
      return "~/.config/seren/skills";
    }
    return runtimeInvoke<string>("get_seren_skills_dir");
  },

  /**
   * Get the Claude Code skills directory (~/.claude/skills/).
   */
  async getClaudeSkillsDir(): Promise<string> {
    if (!isRuntimeConnected()) {
      return "~/.claude/skills";
    }
    return runtimeInvoke<string>("get_claude_skills_dir");
  },

  /**
   * Get the project skills directory.
   */
  async getProjectSkillsDir(
    projectRoot: string | null,
  ): Promise<string | null> {
    if (!isRuntimeConnected() || !projectRoot) {
      return null;
    }
    return runtimeInvoke<string | null>("get_project_skills_dir", {
      projectRoot,
    });
  },

  /**
   * Read `{project}/.seren/config.json`.
   */
  async readProjectConfig(
    projectRoot: string,
  ): Promise<ProjectSkillsConfig | null> {
    if (!isRuntimeConnected()) return null;

    const raw = await readProjectConfigRaw(projectRoot);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as ProjectSkillsConfig;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.version !== "number" ||
        !parsed.skills ||
        !Array.isArray(parsed.skills.enabled)
      ) {
        return null;
      }
      return {
        version: parsed.version,
        skills: {
          enabled: parsed.skills.enabled.filter((s) => typeof s === "string"),
        },
      };
    } catch {
      return null;
    }
  },

  /**
   * Write `{project}/.seren/config.json`.
   */
  async writeProjectConfig(
    projectRoot: string,
    config: ProjectSkillsConfig,
  ): Promise<void> {
    if (!isRuntimeConnected()) return;
    await writeProjectConfigRaw(projectRoot, JSON.stringify(config));
  },

  /**
   * Remove `{project}/.seren/config.json`.
   */
  async clearProjectConfig(projectRoot: string): Promise<void> {
    if (!isRuntimeConnected()) return;
    await clearProjectConfigRaw(projectRoot);
  },

  /**
   * Get thread-scoped skill refs for a project/thread pair.
   * Returns `null` when no override exists.
   */
  async getThreadSkills(
    projectRoot: string,
    threadId: string,
  ): Promise<string[] | null> {
    if (!isRuntimeConnected()) return null;
    return readThreadSkillsRaw(projectRoot, threadId);
  },

  /**
   * Replace thread-scoped skill refs for a project/thread pair.
   */
  async setThreadSkills(
    projectRoot: string,
    threadId: string,
    skillRefs: string[],
  ): Promise<void> {
    if (!isRuntimeConnected()) return;
    await writeThreadSkillsRaw(projectRoot, threadId, skillRefs);
  },

  /**
   * Clear thread-scoped skill override for a project/thread pair.
   */
  async clearThreadSkills(
    projectRoot: string,
    threadId: string,
  ): Promise<void> {
    if (!isRuntimeConnected()) return;
    await clearThreadSkillsRaw(projectRoot, threadId);
  },

  /**
   * List installed skills from a skills directory.
   */
  async listInstalled(
    skillsDir: string,
    scope: SkillScope,
  ): Promise<InstalledSkill[]> {
    if (!isRuntimeConnected()) {
      return [];
    }

    try {
      const slugs = await runtimeInvoke<string[]>("list_skill_files", {
        skillsDir,
      });
      const installed: InstalledSkill[] = [];

      for (const dirName of slugs) {
        const [content, syncStateRaw] = await Promise.all([
          readSkillContent(skillsDir, dirName),
          readSkillSyncState(skillsDir, dirName),
        ]);

        if (content) {
          const parsed = parseSkillMd(content);
          const hash = await computeContentHash(content);
          const slug = resolveSkillSlug(parsed, dirName);
          const resolvedPath = resolveSkillPath(skillsDir, dirName);
          const syncState = syncStateRaw
            ? parseInstalledSyncState(syncStateRaw, dirName)
            : null;

          installed.push({
            id: `local:${slug}`,
            slug,
            name: resolveSkillDisplayName(parsed, slug),
            description: parsed.metadata.description || "",
            source: "local" as SkillSource,
            tags: [],

            scope,
            skillsDir,
            dirName,
            path: resolvedPath,
            installedAt: Date.now(), // We don't track this yet
            enabled: true, // All installed skills are enabled by default
            contentHash: hash,
            upstreamSource: syncState?.upstreamSource,
            upstreamSourceUrl: syncState?.upstreamSourceUrl,
            syncState,
          });
        }
      }

      return installed;
    } catch (error) {
      console.error("[Skills] Error listing installed skills:", error);
      return [];
    }
  },

  /**
   * List all installed skills (seren, claude, and project scopes).
   */
  async listAllInstalled(
    projectRoot: string | null,
  ): Promise<InstalledSkill[]> {
    const serenDir = await this.getSerenSkillsDir();
    const claudeDir = await this.getClaudeSkillsDir();
    const projectDir = await this.getProjectSkillsDir(projectRoot);

    const serenSkills = await this.listInstalled(serenDir, "seren");
    const claudeSkills = await this.listInstalled(claudeDir, "claude");
    const projectSkills = projectDir
      ? await this.listInstalled(projectDir, "project")
      : [];

    return [...serenSkills, ...claudeSkills, ...projectSkills];
  },

  /**
   * Fetch the full content of a skill from its source URL.
   */
  async fetchContent(skill: Skill): Promise<string | null> {
    if (!skill.sourceUrl) {
      console.warn("[Skills] No source URL for skill:", skill.id);
      return null;
    }

    try {
      console.info("[Skills] Fetching content from", skill.sourceUrl);
      const response = await appFetch(skill.sourceUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch skill content: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      console.error("[Skills] Error fetching content:", error);
      return null;
    }
  },

  /**
   * Install a skill to the specified scope.
   * For serenorg skills, fetches payload files (scripts, configs) alongside SKILL.md.
   * Returns the installed skill along with any missing file warnings.
   */
  async install(
    skill: Skill,
    content: string,
    scope: SkillScope,
    projectRoot: string | null,
  ): Promise<InstalledSkill> {
    if (!isRuntimeConnected()) {
      throw new Error(
        "Skills can only be installed when the local runtime is connected",
      );
    }

    let skillsDir: string | null;
    if (scope === "seren") {
      skillsDir = await this.getSerenSkillsDir();
    } else if (scope === "claude") {
      skillsDir = await this.getClaudeSkillsDir();
    } else {
      skillsDir = await this.getProjectSkillsDir(projectRoot);
    }

    if (!skillsDir) {
      throw new Error("No skills directory available for project scope");
    }

    let installContent = content;
    let extraFiles: ExtraFile[] = [];
    let syncState: SkillSyncState | null = null;
    if (skill.source === "serenorg" && skill.sourceUrl) {
      const bundle = await fetchUpstreamSkillBundle(skill);
      if (!bundle) {
        throw new Error("Unable to fetch upstream skill content");
      }
      installContent = bundle.skillMd;
      extraFiles = bundle.payloadFiles;
      if (extraFiles.length > 0) {
        console.info(
          "[Skills] Fetched",
          extraFiles.length,
          "payload files for",
          skill.slug,
        );
      }
      syncState = await computeUpstreamSyncState(
        skill.source,
        skill.sourceUrl,
        bundle.remoteRevision,
        installContent,
        extraFiles,
      );
    } else if (skill.source === "seren" && skill.sourceUrl) {
      // Publisher-installed skills also get sync state so they can be
      // detected and cleaned up when the publisher is deleted.
      syncState = await computeUpstreamSyncState(
        skill.source,
        skill.sourceUrl,
        null,
        installContent,
        [],
      );
    }

    const path = await installSkill({
      skillsDir,
      slug: skill.slug,
      content: installContent,
      extraFiles,
      syncStateJson: syncState ? JSON.stringify(syncState) : null,
    });

    const hash = await computeContentHash(installContent);
    const parsed = parseSkillMd(installContent);

    console.info("[Skills] Installed skill:", skill.slug, "to", scope, "scope");

    return {
      ...skill,
      id: `local:${skill.slug}`,
      source: "local",
      scope,
      skillsDir,
      dirName: skill.slug,
      path,
      installedAt: Date.now(),
      enabled: true,
      contentHash: hash,
      upstreamSource: syncState?.upstreamSource,
      upstreamSourceUrl: syncState?.upstreamSourceUrl ?? skill.sourceUrl,
      syncState,
      // Override with parsed metadata in case it differs
      name: resolveSkillDisplayName(parsed, skill.slug),
      description: parsed.metadata.description || skill.description,
      tags: skill.tags,
      author: skill.author,
      version: skill.version,
    };
  },

  /**
   * Validate an installed skill's payload files.
   * Returns a list of file paths referenced in SKILL.md but missing from disk.
   * Note: This is a best-effort check using available runtime primitives.
   */
  async validatePayload(
    _skillsDir: string,
    _slug: string,
  ): Promise<string[]> {
    // The validate_skill_payload command is not available in the local runtime.
    // Payload validation requires parsing SKILL.md for file references and
    // checking their existence — this can be added when the runtime exposes it.
    return [];
  },

  /**
   * Remove an installed skill.
   */
  async remove(skill: InstalledSkill): Promise<void> {
    if (!isRuntimeConnected()) {
      throw new Error(
        "Skills can only be removed when the local runtime is connected",
      );
    }

    const skillsDir =
      skill.skillsDir || skill.path.replace(/[/\\][^/\\]+[/\\]SKILL\.md$/, "");

    await removeSkill(skillsDir, skill.dirName);

    console.info("[Skills] Removed skill:", skill.slug);
  },

  /**
   * Read the content of an installed skill.
   */
  async readContent(skill: InstalledSkill): Promise<string | null> {
    if (!isRuntimeConnected()) {
      return null;
    }

    return readSkillContent(skill.skillsDir, skill.dirName);
  },

  /**
   * Rename a skill directory when the resolved slug no longer matches the
   * filesystem directory name. Returns the new SKILL.md path.
   * Composed from rename_path RPC.
   */
  async renameSkillDir(
    skill: InstalledSkill,
    newDirName: string,
  ): Promise<string> {
    const separator = skill.skillsDir.includes("\\") ? "\\" : "/";
    const oldPath = `${skill.skillsDir}${separator}${skill.dirName}`;
    const newPath = `${skill.skillsDir}${separator}${newDirName}`;
    await runtimeInvoke("rename_path", { oldPath, newPath });
    return `${newPath}${separator}SKILL.md`;
  },

  /**
   * Read a relative file from an installed skill directory.
   */
  async readFile(
    skill: InstalledSkill,
    relativePath: string,
  ): Promise<string | null> {
    if (!isRuntimeConnected()) {
      return null;
    }

    try {
      return await runtimeInvoke<string>("read_skill_file", {
        skillsDir: skill.skillsDir,
        slug: skill.dirName,
        relativePath,
      });
    } catch {
      return null;
    }
  },

  /**
   * Determine the sync status for an upstream-managed installed skill.
   */
  async inspectSyncStatus(
    skill: InstalledSkill,
  ): Promise<SkillSyncStatus | null> {
    if (!isUpstreamManagedSkill(skill)) {
      return null;
    }

    try {
      const changedLocalFiles: string[] = [];
      const localManagedState: Record<string, string | null> = {};
      const missingManagedFiles: string[] = [];
      const managedPaths = Object.keys(skill.syncState?.managedFiles ?? {});

      if (skill.syncState) {
        const results = await Promise.all(
          managedPaths.map(async (path) => {
            const content =
              path === "SKILL.md"
                ? await this.readContent(skill)
                : await this.readFile(skill, path);
            return { path, content };
          }),
        );

        for (const { path, content } of results) {
          if (content === null) {
            localManagedState[path] = null;
            missingManagedFiles.push(path);
            continue;
          }

          const contentHash = await computeContentHash(content);
          localManagedState[path] = contentHash;
          if (contentHash !== skill.syncState.managedFiles[path]) {
            changedLocalFiles.push(path);
          }
        }
      }

      const remoteRevision = await fetchRemoteSkillRevision(
        skill.upstreamSourceUrl,
      );
      const syncedRevision = skill.syncState?.syncedRevision ?? null;
      const updateAvailable = Boolean(
        remoteRevision?.sha &&
          syncedRevision &&
          remoteRevision.sha !== syncedRevision,
      );
      const hasLocalChanges =
        changedLocalFiles.length > 0 || missingManagedFiles.length > 0;
      const bootstrapRequired = Boolean(
        remoteRevision?.sha &&
          syncedRevision === null &&
          !hasLocalChanges &&
          managedPaths.length > 0,
      );

      return {
        state: hasLocalChanges
          ? "local-changes"
          : bootstrapRequired
            ? "bootstrap-required"
            : updateAvailable
              ? "update-available"
              : "current",
        updateAvailable,
        hasLocalChanges,
        syncedRevision,
        remoteRevision,
        changedLocalFiles,
        localManagedState,
        missingManagedFiles,
      };
    } catch (error) {
      return {
        state: "error",
        updateAvailable: false,
        hasLocalChanges: false,
        syncedRevision: skill.syncState?.syncedRevision ?? null,
        remoteRevision: null,
        changedLocalFiles: [],
        localManagedState: {},
        missingManagedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  /**
   * Refresh an installed upstream-managed skill from its canonical source.
   */
  async refreshInstalledSkill(
    skill: InstalledSkill,
    options?: {
      expectedLocalManagedState?: Record<string, string | null>;
    },
  ): Promise<{
    installed: InstalledSkill;
    syncStatus: SkillSyncStatus | null;
  }> {
    if (!isUpstreamManagedSkill(skill)) {
      throw new Error("Skill is not managed by an upstream source");
    }

    const bundle = await fetchUpstreamSkillBundle({
      sourceUrl: skill.upstreamSourceUrl,
    });
    if (!bundle) {
      throw new Error("Unable to fetch upstream skill content");
    }

    if (options?.expectedLocalManagedState) {
      // Re-verify the last approved local snapshot immediately before invoking
      // the install path. A tiny race remains between this check and the final
      // filesystem rename, but it is limited to the local hashing + sync-state
      // prep work in this method rather than the full upstream fetch sequence.
      const latestStatus = await this.inspectSyncStatus(skill);
      if (!latestStatus || latestStatus.state === "error") {
        throw new Error(
          `Seren could not re-verify ${skill.name} immediately before refresh.`,
        );
      }
      if (
        localManagedStateFingerprint(latestStatus.localManagedState) !==
        localManagedStateFingerprint(options.expectedLocalManagedState)
      ) {
        throw new Error(
          `${skill.name} changed after the overwrite check. Review the latest local edits and retry refresh.`,
        );
      }
    }

    const syncState = await computeUpstreamSyncState(
      skill.upstreamSource,
      skill.upstreamSourceUrl,
      bundle.remoteRevision,
      bundle.skillMd,
      bundle.payloadFiles,
    );

    await installSkill({
      skillsDir: skill.skillsDir,
      slug: skill.dirName,
      content: bundle.skillMd,
      extraFiles: bundle.payloadFiles,
      syncStateJson: JSON.stringify(syncState),
    });

    const hash = await computeContentHash(bundle.skillMd);
    const parsed = parseSkillMd(bundle.skillMd);
    const refreshed: InstalledSkill = {
      ...skill,
      name: resolveSkillDisplayName(parsed, skill.slug),
      description: parsed.metadata.description || skill.description,
      contentHash: hash,
      upstreamSource: syncState.upstreamSource,
      upstreamSourceUrl: syncState.upstreamSourceUrl,
      syncState,
    };

    return {
      installed: refreshed,
      syncStatus: await this.inspectSyncStatus(refreshed),
    };
  },

  /**
   * Get content for enabled skills to inject into agent system prompt.
   * Injects the absolute runtime path so the agent doesn't need to search.
   */
  async getEnabledSkillsContent(
    installedSkills: InstalledSkill[],
  ): Promise<string> {
    const enabled = installedSkills.filter((s) => s.enabled);

    if (enabled.length === 0) {
      return "";
    }

    const contents: string[] = [];

    for (const skill of enabled) {
      const content = await this.readContent(skill);
      if (content) {
        const parsed = parseSkillMd(content);
        const runtimeDir = `${skill.skillsDir}/${skill.dirName}`;
        const hasIncludes =
          parsed.metadata.includes && parsed.metadata.includes.length > 0;
        const depsNote = hasIncludes
          ? `\n> **Shared dependencies:** \`${runtimeDir}/_deps/\` contains shared files from declared \`includes\` paths.\n`
          : "";
        const runtimeNote = `> **Skill runtime directory:** \`${runtimeDir}\`\n> Use this absolute path to reference skill files. Do not create local copies or fallback scaffolds.${depsNote}\n\n`;
        contents.push(
          `## Skill: ${skill.name}\n\n${runtimeNote}${parsed.content}`,
        );
      }
    }

    if (contents.length === 0) {
      return "";
    }

    return `\n\n# Active Skills\n\n${contents.join("\n\n---\n\n")}`;
  },

  /**
   * Clear the skills index cache.
   */
  clearCache(): void {
    localStorage.removeItem(INDEX_CACHE_KEY);
    localStorage.removeItem(PUBLISHER_SKILLS_CACHE_KEY);
    console.info("[Skills] Cache cleared");
  },

  /**
   * Search skills by query.
   */
  search(skills: Skill[], query: string): Skill[] {
    const q = query.toLowerCase().trim();
    if (!q) return skills;

    return skills.filter(
      (skill) =>
        skill.slug.toLowerCase().includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        skill.author?.toLowerCase().includes(q),
    );
  },

  /**
   * Filter skills by source.
   */
  filterBySource(skills: Skill[], source: SkillSource | null): Skill[] {
    if (!source) return skills;
    return skills.filter((skill) => skill.source === source);
  },

  /**
   * Filter skills by tag.
   */
  filterByTag(skills: Skill[], tag: string | null): Skill[] {
    if (!tag) return skills;
    return skills.filter((skill) =>
      skill.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
    );
  },

  /**
   * Get all unique tags from a list of skills.
   */
  getAllTags(skills: Skill[]): string[] {
    const tagSet = new Set<string>();
    for (const skill of skills) {
      for (const tag of skill.tags) {
        tagSet.add(tag.toLowerCase());
      }
    }
    return Array.from(tagSet).sort();
  },

  /**
   * Backfill sync state for installed skills that were installed before the
   * sync feature existed. Matches installed skills missing sync state to
   * available repo skills by slug, then writes a minimal .seren-sync.json
   * so the upstream refresh flow can detect updates.
   */
  async backfillSyncState(
    installed: InstalledSkill[],
    available: Skill[],
  ): Promise<number> {
    if (!isRuntimeConnected()) return 0;

    const repoSkillsBySlug = new Map<string, Skill>();
    const publisherSkillsBySlug = new Map<string, Skill>();
    for (const skill of available) {
      if (skill.source === "serenorg" && skill.sourceUrl) {
        repoSkillsBySlug.set(skill.slug, skill);
      } else if (skill.source === "seren" && skill.sourceUrl) {
        publisherSkillsBySlug.set(skill.slug, skill);
      }
    }

    let backfilled = 0;

    for (const skill of installed) {
      // Skip skills that already have sync state
      if (skill.syncState) continue;

      // Try matching to upstream repo first, then publisher catalog
      const repoMatch = repoSkillsBySlug.get(skill.slug);
      const publisherMatch = publisherSkillsBySlug.get(skill.slug);
      const match = repoMatch ?? publisherMatch;
      if (!match?.sourceUrl) {
        // Also detect publisher skills by SKILL.md metadata (publisher_slug)
        const content = await this.readContent(skill);
        if (!content) continue;
        const slugMatch = content.match(/"publisher_slug"\s*:\s*"([^"]+)"/);
        if (slugMatch) {
          const publisherSlug = slugMatch[1];
          const contentHash = await computeContentHash(content);
          const syncState: SkillSyncState = {
            version: 1,
            upstreamSource: "seren" as SkillSource,
            upstreamSourceUrl: `${apiBase}/publishers/${publisherSlug}/skill.md`,
            syncedRevision: null,
            syncedAt: Date.now(),
            managedFiles: { "SKILL.md": contentHash },
          };
          try {
            await writeSkillSyncState(
              skill.skillsDir,
              skill.dirName,
              JSON.stringify(syncState),
            );
            backfilled++;
            console.info(
              "[Skills] Backfilled publisher sync state for",
              skill.slug,
              "-> publisher:",
              publisherSlug,
            );
          } catch (err) {
            console.warn(
              "[Skills] Failed to backfill publisher sync state for",
              skill.slug,
              err,
            );
          }
        }
        continue;
      }

      const source: SkillSource = repoMatch ? "serenorg" : "seren";

      // Read current content to compute managed file hash
      const content = await this.readContent(skill);
      if (!content) continue;

      const contentHash = await computeContentHash(content);
      const syncState: SkillSyncState = {
        version: 1,
        upstreamSource: source,
        upstreamSourceUrl: match.sourceUrl,
        syncedRevision: null,
        syncedAt: Date.now(),
        managedFiles: { "SKILL.md": contentHash },
      };

      try {
        await writeSkillSyncState(
          skill.skillsDir,
          skill.dirName,
          JSON.stringify(syncState),
        );
        backfilled++;
        console.info(
          "[Skills] Backfilled sync state for",
          skill.slug,
          "->",
          match.sourceUrl,
        );
      } catch (err) {
        console.warn(
          "[Skills] Failed to backfill sync state for",
          skill.slug,
          err,
        );
      }
    }

    return backfilled;
  },
};
