// ABOUTME: Project indexing handlers for semantic code search.
// ABOUTME: Exposes vector store and chunker operations to the frontend via RPC.

import * as vectorStore from "../services/vector-store.js";
import * as chunker from "../services/chunker.js";

export async function initProjectIndex(params: {
  projectPath: string;
}): Promise<vectorStore.IndexStats> {
  return vectorStore.initVectorDb(params.projectPath);
}

export async function getIndexStatus(params: {
  projectPath: string;
}): Promise<vectorStore.IndexStats> {
  return vectorStore.getStats(params.projectPath);
}

export async function hasProjectIndex(params: {
  projectPath: string;
}): Promise<boolean> {
  return vectorStore.hasIndex(params.projectPath);
}

export async function searchCodebase(params: {
  projectPath: string;
  queryEmbedding: number[];
  limit: number;
}): Promise<vectorStore.SearchResult[]> {
  if (params.queryEmbedding.length !== vectorStore.EMBEDDING_DIM) {
    throw new Error(
      `Query embedding dimension mismatch: expected ${vectorStore.EMBEDDING_DIM}, got ${params.queryEmbedding.length}`,
    );
  }
  return vectorStore.searchSimilar(
    params.projectPath,
    params.queryEmbedding,
    params.limit,
  );
}

export async function fileNeedsReindex(params: {
  projectPath: string;
  filePath: string;
  fileHash: string;
}): Promise<boolean> {
  return vectorStore.fileNeedsReindex(
    params.projectPath,
    params.filePath,
    params.fileHash,
  );
}

export async function deleteFileIndex(params: {
  projectPath: string;
  filePath: string;
}): Promise<number> {
  return vectorStore.deleteFileChunks(params.projectPath, params.filePath);
}

export async function indexChunks(params: {
  projectPath: string;
  chunks: vectorStore.ChunkInput[];
}): Promise<number[]> {
  return vectorStore.insertChunks(params.projectPath, params.chunks);
}

export async function discoverProjectFiles(params: {
  projectPath: string;
}): Promise<chunker.DiscoveredFile[]> {
  return chunker.discoverFiles(params.projectPath);
}

export async function chunkFile(params: {
  file: chunker.DiscoveredFile;
}): Promise<chunker.ChunkedFile> {
  return chunker.chunkFile(params.file);
}

export async function estimateIndexing(params: {
  files: chunker.DiscoveredFile[];
}): Promise<{ chunks: number; tokens: number }> {
  return chunker.estimateIndexing(params.files);
}

export async function computeFileHash(params: {
  content: string;
}): Promise<string> {
  return chunker.computeHash(params.content);
}

export async function getEmbeddingDimension(): Promise<number> {
  return vectorStore.EMBEDDING_DIM;
}
