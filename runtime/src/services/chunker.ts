// ABOUTME: Code chunking service for semantic indexing.
// ABOUTME: Splits source files into meaningful chunks at function/class boundaries.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { createHash } from "node:crypto";

const MAX_CHUNK_LINES = 100;
const MIN_CHUNK_LINES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const IGNORE_PATTERNS = [
  "node_modules", ".git", ".svn", ".hg", "target", "dist", "build",
  ".next", ".nuxt", "__pycache__", ".pytest_cache", ".mypy_cache",
  "venv", ".venv", "env", ".env", ".idea", ".vscode", ".DS_Store",
  "Thumbs.db", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
];

const WILDCARD_SUFFIXES = [".min.js", ".min.css", ".map"];

export interface FileChunk {
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
}

export interface DiscoveredFile {
  path: string;
  relative_path: string;
  language: string;
  size: number;
  hash: string;
}

export interface ChunkedFile {
  file: DiscoveredFile;
  chunks: FileChunk[];
}

const LANG_MAP: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", go: "go", java: "java", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", swift: "swift", kt: "kotlin", kts: "kotlin",
  scala: "scala", r: "r", sql: "sql", sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell", yml: "yaml", yaml: "yaml", json: "json", toml: "toml",
  xml: "xml", html: "html", htm: "html", css: "css", scss: "css", sass: "css", less: "css",
  md: "markdown", markdown: "markdown", vue: "vue", svelte: "svelte",
};

export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).slice(1).toLowerCase();
  return LANG_MAP[ext] ?? null;
}

function shouldIgnore(name: string): boolean {
  if (IGNORE_PATTERNS.includes(name)) return true;
  for (const suffix of WILDCARD_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function discoverFiles(projectPath: string): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  discoverRecursive(projectPath, projectPath, files);
  return files;
}

function discoverRecursive(root: string, current: string, files: DiscoveredFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }

  for (const name of entries) {
    if (shouldIgnore(name)) continue;

    const fullPath = join(current, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      discoverRecursive(root, fullPath, files);
    } else if (stat.isFile()) {
      const language = detectLanguage(fullPath);
      if (!language) continue;
      if (stat.size > MAX_FILE_SIZE) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      files.push({
        path: fullPath,
        relative_path: relative(root, fullPath),
        language,
        size: stat.size,
        hash: computeHash(content),
      });
    }
  }
}

export function chunkFile(file: DiscoveredFile): ChunkedFile {
  const content = readFileSync(file.path, "utf-8");
  const lines = content.split("\n");

  let chunks: FileChunk[];
  switch (file.language) {
    case "rust":
      chunks = chunkBraceLanguage(lines, detectRustBlock);
      break;
    case "typescript":
    case "javascript":
      chunks = chunkBraceLanguage(lines, detectJsBlock);
      break;
    case "python":
      chunks = chunkPython(lines);
      break;
    default:
      chunks = chunkGeneric(lines);
  }

  if (chunks.length === 0) {
    chunks = chunkGeneric(lines);
  }

  return { file, chunks };
}

// ── Brace-based chunking (Rust, JS/TS) ──────────────────────────────

type BlockDetector = (line: string) => { type: string; name: string | null } | null;

function chunkBraceLanguage(lines: string[], detect: BlockDetector): FileChunk[] {
  const chunks: FileChunk[] = [];
  let currentStart: number | null = null;
  let braceDepth = 0;
  let currentType = "block";
  let currentName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (currentStart === null) {
      const block = detect(trimmed);
      if (block) {
        currentStart = i;
        currentType = block.type;
        currentName = block.name;
        braceDepth = 0;
      }
    }

    if (currentStart !== null) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }

      if (braceDepth <= 0 && (line.includes("}") || line.includes(";"))) {
        const content = lines.slice(currentStart, i + 1).join("\n");
        if (i - currentStart + 1 >= MIN_CHUNK_LINES) {
          chunks.push({
            start_line: currentStart + 1,
            end_line: i + 1,
            content,
            chunk_type: currentType,
            symbol_name: currentName,
          });
        }
        currentStart = null;
        currentName = null;
      }
    }
  }

  return chunks;
}

function extractIdAfter(line: string, keyword: string): string | null {
  const idx = line.indexOf(keyword);
  if (idx === -1) return null;
  const after = line.slice(idx + keyword.length);
  const match = after.match(/^[a-zA-Z_]\w*/);
  return match ? match[0] : null;
}

function detectRustBlock(line: string): { type: string; name: string | null } | null {
  if (line.startsWith("//") || line.startsWith("#[")) return null;

  if (/^(pub\s+)?(async\s+)?fn\s/.test(line))
    return { type: "function", name: extractIdAfter(line, "fn ") };
  if (/^impl[\s<]/.test(line))
    return { type: "class", name: extractIdAfter(line, "impl ") };
  if (/^(pub\s+)?struct\s/.test(line))
    return { type: "class", name: extractIdAfter(line, "struct ") };
  if (/^(pub\s+)?enum\s/.test(line))
    return { type: "class", name: extractIdAfter(line, "enum ") };
  if (/^(pub\s+)?mod\s/.test(line))
    return { type: "module", name: extractIdAfter(line, "mod ") };

  return null;
}

function detectJsBlock(line: string): { type: string; name: string | null } | null {
  if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) return null;

  if (/^(export\s+)?(async\s+)?function\s/.test(line))
    return { type: "function", name: extractIdAfter(line, "function ") };
  if (/^(export\s+)?const\s.*=\s*(async\s+)?\(/.test(line))
    return { type: "function", name: extractIdAfter(line, "const ") };
  if (/^(export\s+)?(default\s+)?class\s/.test(line))
    return { type: "class", name: extractIdAfter(line, "class ") };
  if (/^(export\s+)?interface\s/.test(line))
    return { type: "class", name: extractIdAfter(line, "interface ") };
  if (/^(export\s+)?type\s/.test(line))
    return { type: "class", name: extractIdAfter(line, "type ") };

  return null;
}

// ── Python chunking (indentation-based) ─────────────────────────────

function chunkPython(lines: string[]): FileChunk[] {
  const chunks: FileChunk[] = [];
  let currentStart: number | null = null;
  let currentIndent = 0;
  let currentType = "block";
  let currentName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (currentStart === null) {
      const block = detectPythonBlock(trimmed);
      if (block) {
        currentStart = i;
        currentIndent = indent;
        currentType = block.type;
        currentName = block.name;
      }
    } else if (trimmed.length > 0 && indent <= currentIndent && i > currentStart) {
      const content = lines.slice(currentStart, i).join("\n");
      if (i - currentStart >= MIN_CHUNK_LINES) {
        chunks.push({
          start_line: currentStart + 1,
          end_line: i,
          content,
          chunk_type: currentType,
          symbol_name: currentName,
        });
      }
      currentStart = null;
      currentName = null;

      const block = detectPythonBlock(trimmed);
      if (block) {
        currentStart = i;
        currentIndent = indent;
        currentType = block.type;
        currentName = block.name;
      }
    }
  }

  if (currentStart !== null) {
    const content = lines.slice(currentStart).join("\n");
    if (lines.length - currentStart >= MIN_CHUNK_LINES) {
      chunks.push({
        start_line: currentStart + 1,
        end_line: lines.length,
        content,
        chunk_type: currentType,
        symbol_name: currentName,
      });
    }
  }

  return chunks;
}

function detectPythonBlock(line: string): { type: string; name: string | null } | null {
  if (line.startsWith("#") || line.startsWith('"""') || line.startsWith("'''")) return null;

  if (/^(async\s+)?def\s/.test(line))
    return { type: "function", name: extractIdAfter(line, "def ") };
  if (/^class\s/.test(line))
    return { type: "class", name: extractIdAfter(line, "class ") };

  return null;
}

// ── Generic chunking ────────────────────────────────────────────────

function chunkGeneric(lines: string[]): FileChunk[] {
  const chunks: FileChunk[] = [];

  if (lines.length <= MAX_CHUNK_LINES) {
    if (lines.length >= MIN_CHUNK_LINES) {
      chunks.push({
        start_line: 1,
        end_line: lines.length,
        content: lines.join("\n"),
        chunk_type: "file",
        symbol_name: null,
      });
    }
    return chunks;
  }

  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + MAX_CHUNK_LINES, lines.length);
    chunks.push({
      start_line: start + 1,
      end_line: end,
      content: lines.slice(start, end).join("\n"),
      chunk_type: "block",
      symbol_name: null,
    });
    start = end;
  }

  return chunks;
}

export function estimateIndexing(files: DiscoveredFile[]): { chunks: number; tokens: number } {
  let totalChunks = 0;
  let totalTokens = 0;

  for (const file of files) {
    try {
      const chunked = chunkFile(file);
      totalChunks += chunked.chunks.length;
      for (const chunk of chunked.chunks) {
        totalTokens += Math.floor(chunk.content.length / 4);
      }
    } catch {
      // skip unreadable files
    }
  }

  return { chunks: totalChunks, tokens: totalTokens };
}
