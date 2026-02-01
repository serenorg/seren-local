// ABOUTME: Local vector storage for semantic code search using sqlite-vec.
// ABOUTME: Stores code embeddings locally for instant retrieval without network latency.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const EMBEDDING_DIM = 1536;

export interface CodeChunk {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  language: string;
  file_hash: string;
  indexed_at: number;
}

export interface SearchResult {
  chunk: CodeChunk;
  distance: number;
}

export interface IndexStats {
  total_chunks: number;
  total_files: number;
  last_indexed: number | null;
}

export interface ChunkInput {
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  language: string;
  file_hash: string;
  embedding: number[];
}

function getDataDir(): string {
  return join(homedir(), ".seren-local", "data");
}

function getVectorDbPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(getDataDir(), "indexes", `${hash}.db`);
}

export function hasIndex(projectPath: string): boolean {
  return existsSync(getVectorDbPath(projectPath));
}

function openDb(projectPath: string): Database.Database {
  const dbPath = getVectorDbPath(projectPath);
  const dir = join(getDataDir(), "indexes");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

export function initVectorDb(projectPath: string): IndexStats {
  const db = openDb(projectPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      symbol_name TEXT,
      language TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_hash ON code_chunks(file_hash)`);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_embeddings USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.prepare(
    "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('project_path', ?)",
  ).run(projectPath);

  const stats = getIndexStats(db);
  db.close();
  return stats;
}

function getIndexStats(db: Database.Database): IndexStats {
  const totalChunks = (db.prepare("SELECT COUNT(*) as c FROM code_chunks").get() as any).c;
  const totalFiles = (
    db.prepare("SELECT COUNT(DISTINCT file_path) as c FROM code_chunks").get() as any
  ).c;
  const lastIndexed = (
    db.prepare("SELECT MAX(indexed_at) as m FROM code_chunks").get() as any
  ).m;

  return {
    total_chunks: totalChunks,
    total_files: totalFiles,
    last_indexed: lastIndexed ?? null,
  };
}

export function getStats(projectPath: string): IndexStats {
  if (!hasIndex(projectPath)) {
    return { total_chunks: 0, total_files: 0, last_indexed: null };
  }
  const db = openDb(projectPath);
  const stats = getIndexStats(db);
  db.close();
  return stats;
}

function float32ArrayToBuffer(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

export function insertChunks(
  projectPath: string,
  chunks: ChunkInput[],
): number[] {
  const db = openDb(projectPath);
  const now = Date.now();

  const insertChunk = db.prepare(`
    INSERT INTO code_chunks (file_path, start_line, end_line, content, chunk_type, symbol_name, language, file_hash, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEmbedding = db.prepare(`
    INSERT INTO code_embeddings (chunk_id, embedding) VALUES (?, ?)
  `);

  const ids: number[] = [];

  const transaction = db.transaction(() => {
    for (const chunk of chunks) {
      if (chunk.embedding.length !== EMBEDDING_DIM) {
        throw new Error(
          `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${chunk.embedding.length}`,
        );
      }

      const result = insertChunk.run(
        chunk.file_path,
        chunk.start_line,
        chunk.end_line,
        chunk.content,
        chunk.chunk_type,
        chunk.symbol_name,
        chunk.language,
        chunk.file_hash,
        now,
      );

      const chunkId = Number(result.lastInsertRowid);
      insertEmbedding.run(chunkId, float32ArrayToBuffer(chunk.embedding));
      ids.push(chunkId);
    }
  });

  transaction();
  db.close();
  return ids;
}

export function deleteFileChunks(
  projectPath: string,
  filePath: string,
): number {
  const db = openDb(projectPath);

  const chunkIds: number[] = db
    .prepare("SELECT id FROM code_chunks WHERE file_path = ?")
    .all(filePath)
    .map((row: any) => row.id);

  const deleteEmbedding = db.prepare(
    "DELETE FROM code_embeddings WHERE chunk_id = ?",
  );
  for (const id of chunkIds) {
    deleteEmbedding.run(id);
  }

  const result = db
    .prepare("DELETE FROM code_chunks WHERE file_path = ?")
    .run(filePath);

  db.close();
  return result.changes;
}

export function searchSimilar(
  projectPath: string,
  queryEmbedding: number[],
  limit: number,
): SearchResult[] {
  const db = openDb(projectPath);

  const embeddingBlob = float32ArrayToBuffer(queryEmbedding);

  const rows = db
    .prepare(
      `SELECT
        c.id, c.file_path, c.start_line, c.end_line, c.content,
        c.chunk_type, c.symbol_name, c.language, c.file_hash, c.indexed_at,
        e.distance
       FROM code_embeddings e
       JOIN code_chunks c ON c.id = e.chunk_id
       WHERE e.embedding MATCH ?
       ORDER BY e.distance
       LIMIT ?`,
    )
    .all(embeddingBlob, limit) as any[];

  db.close();

  return rows.map((row) => ({
    chunk: {
      id: row.id,
      file_path: row.file_path,
      start_line: row.start_line,
      end_line: row.end_line,
      content: row.content,
      chunk_type: row.chunk_type,
      symbol_name: row.symbol_name,
      language: row.language,
      file_hash: row.file_hash,
      indexed_at: row.indexed_at,
    },
    distance: row.distance,
  }));
}

export function fileNeedsReindex(
  projectPath: string,
  filePath: string,
  currentHash: string,
): boolean {
  if (!hasIndex(projectPath)) return true;

  const db = openDb(projectPath);
  const row = db
    .prepare("SELECT file_hash FROM code_chunks WHERE file_path = ? LIMIT 1")
    .get(filePath) as any;
  db.close();

  if (!row) return true;
  return row.file_hash !== currentHash;
}
