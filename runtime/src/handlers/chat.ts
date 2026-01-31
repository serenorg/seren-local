// ABOUTME: SQLite conversation and message storage handlers.
// ABOUTME: Provides persistent conversation history via better-sqlite3.

import Database from "better-sqlite3";

interface Conversation {
  id: string;
  title: string;
  created_at: number;
  selected_model: string | null;
  selected_provider: string | null;
  is_archived: boolean;
}

interface StoredMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  timestamp: number;
}

let db: Database.Database;

/**
 * Initialize the chat database. Call with ":memory:" for tests
 * or a file path for production.
 */
export function initChatDb(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      selected_model TEXT,
      selected_provider TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, timestamp);
  `);
}

export async function createConversation(params: {
  id: string;
  title: string;
  selectedModel?: string;
  selectedProvider?: string;
}): Promise<Conversation> {
  const conv: Conversation = {
    id: params.id,
    title: params.title,
    created_at: Date.now(),
    selected_model: params.selectedModel ?? null,
    selected_provider: params.selectedProvider ?? null,
    is_archived: false,
  };
  db.prepare(
    `INSERT OR REPLACE INTO conversations (id, title, created_at, selected_model, selected_provider, is_archived)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    conv.id,
    conv.title,
    conv.created_at,
    conv.selected_model,
    conv.selected_provider,
    conv.is_archived ? 1 : 0,
  );
  return conv;
}

export async function getConversations(): Promise<Conversation[]> {
  const rows = db
    .prepare(
      `SELECT * FROM conversations WHERE is_archived = 0 ORDER BY created_at DESC`,
    )
    .all() as Array<Omit<Conversation, "is_archived"> & { is_archived: number }>;
  return rows.map((r) => ({ ...r, is_archived: r.is_archived === 1 }));
}

export async function getConversation(params: {
  id: string;
}): Promise<Conversation | null> {
  const row = db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(params.id) as
    | (Omit<Conversation, "is_archived"> & { is_archived: number })
    | undefined;
  if (!row) return null;
  return { ...row, is_archived: row.is_archived === 1 };
}

export async function updateConversation(params: {
  id: string;
  title?: string;
  selectedModel?: string;
  selectedProvider?: string;
}): Promise<void> {
  const existing = await getConversation({ id: params.id });
  if (!existing) return;

  const updated = {
    title: params.title ?? existing.title,
    selected_model:
      params.selectedModel !== undefined
        ? params.selectedModel
        : existing.selected_model,
    selected_provider:
      params.selectedProvider !== undefined
        ? params.selectedProvider
        : existing.selected_provider,
  };

  db.prepare(
    `UPDATE conversations SET title = ?, selected_model = ?, selected_provider = ? WHERE id = ?`,
  ).run(updated.title, updated.selected_model, updated.selected_provider, params.id);
}

export async function archiveConversation(params: {
  id: string;
}): Promise<void> {
  db.prepare(`UPDATE conversations SET is_archived = 1 WHERE id = ?`).run(
    params.id,
  );
}

export async function deleteConversation(params: {
  id: string;
}): Promise<void> {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(params.id);
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(params.id);
}

export async function saveMessage(params: {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  timestamp: number;
}): Promise<void> {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, model, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.conversationId,
    params.role,
    params.content,
    params.model,
    params.timestamp,
  );
}

export async function getMessages(params: {
  conversationId: string;
  limit: number;
}): Promise<StoredMessage[]> {
  // Get the most recent N messages, then return in chronological order
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(params.conversationId, params.limit) as StoredMessage[];
  return rows.reverse();
}
