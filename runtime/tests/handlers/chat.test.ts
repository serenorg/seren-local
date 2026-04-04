// ABOUTME: Tests for SQLite conversation storage handlers.
// ABOUTME: Uses in-memory SQLite database for test isolation.

import { describe, it, expect, beforeEach } from "vitest";
import {
  initChatDb,
  createConversation,
  getConversations,
  getConversation,
  updateConversation,
  archiveConversation,
  deleteConversation,
  saveMessage,
  getMessages,
  createAgentConversation,
  getAgentConversations,
  getAgentConversation,
  setAgentConversationSessionId,
  setAgentConversationTitle,
  setAgentConversationModelId,
  setAgentConversationMetadata,
  archiveAgentConversation,
} from "../../src/handlers/chat";

beforeEach(() => {
  initChatDb(":memory:");
});

describe("conversation CRUD", () => {
  it("creates and retrieves a conversation", async () => {
    const conv = await createConversation({
      id: "c1",
      title: "Test Chat",
    });
    expect(conv.id).toBe("c1");
    expect(conv.title).toBe("Test Chat");
    expect(conv.is_archived).toBe(false);
    expect(conv.created_at).toBeTypeOf("number");

    const fetched = await getConversation({ id: "c1" });
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test Chat");
  });

  it("lists conversations sorted by created_at descending", async () => {
    // Use small delays to ensure distinct timestamps
    await createConversation({ id: "c1", title: "First" });
    await new Promise((r) => setTimeout(r, 5));
    await createConversation({ id: "c2", title: "Second" });
    await new Promise((r) => setTimeout(r, 5));
    await createConversation({ id: "c3", title: "Third" });

    const list = await getConversations();
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe("c3");
    expect(list[2].id).toBe("c1");
  });

  it("excludes archived conversations from list", async () => {
    await createConversation({ id: "c1", title: "Active" });
    await createConversation({ id: "c2", title: "Archived" });
    await archiveConversation({ id: "c2" });

    const list = await getConversations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c1");
  });

  it("updates conversation title", async () => {
    await createConversation({ id: "c1", title: "Old" });
    await updateConversation({ id: "c1", title: "New" });

    const fetched = await getConversation({ id: "c1" });
    expect(fetched!.title).toBe("New");
  });

  it("updates selected model and provider", async () => {
    await createConversation({ id: "c1", title: "Test" });
    await updateConversation({
      id: "c1",
      selectedModel: "gpt-4",
      selectedProvider: "openai",
    });

    const fetched = await getConversation({ id: "c1" });
    expect(fetched!.selected_model).toBe("gpt-4");
    expect(fetched!.selected_provider).toBe("openai");
  });

  it("deletes conversation and its messages", async () => {
    await createConversation({ id: "c1", title: "Delete Me" });
    await saveMessage({
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "hello",
      model: null,
      timestamp: Date.now(),
    });

    await deleteConversation({ id: "c1" });

    const conv = await getConversation({ id: "c1" });
    expect(conv).toBeNull();

    const msgs = await getMessages({ conversationId: "c1", limit: 100 });
    expect(msgs).toHaveLength(0);
  });

  it("returns null for non-existent conversation", async () => {
    const fetched = await getConversation({ id: "nope" });
    expect(fetched).toBeNull();
  });
});

describe("message CRUD", () => {
  it("saves and retrieves messages", async () => {
    await createConversation({ id: "c1", title: "Chat" });
    await saveMessage({
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "hello",
      model: null,
      timestamp: 1000,
    });
    await saveMessage({
      id: "m2",
      conversationId: "c1",
      role: "assistant",
      content: "hi there",
      model: "claude-3",
      timestamp: 2000,
    });

    const msgs = await getMessages({ conversationId: "c1", limit: 100 });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].model).toBe("claude-3");
  });

  it("respects limit parameter", async () => {
    await createConversation({ id: "c1", title: "Chat" });
    for (let i = 0; i < 10; i++) {
      await saveMessage({
        id: `m${i}`,
        conversationId: "c1",
        role: "user",
        content: `msg ${i}`,
        model: null,
        timestamp: i * 1000,
      });
    }

    const msgs = await getMessages({ conversationId: "c1", limit: 5 });
    expect(msgs).toHaveLength(5);
    // Should return the most recent 5 messages
    expect(msgs[0].content).toBe("msg 5");
    expect(msgs[4].content).toBe("msg 9");
  });
});

describe("agent conversation CRUD", () => {
  it("creates and retrieves an agent conversation", async () => {
    const conv = await createAgentConversation({
      id: "ac1",
      title: "Claude Session",
      agentType: "claude-code",
      agentCwd: "/home/user/project",
      projectRoot: "/home/user/project",
      agentSessionId: "sess-123",
    });
    expect(conv.id).toBe("ac1");
    expect(conv.agent_type).toBe("claude-code");
    expect(conv.agent_session_id).toBe("sess-123");
    expect(conv.is_archived).toBe(false);

    const fetched = await getAgentConversation({ id: "ac1" });
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Claude Session");
    expect(fetched!.agent_cwd).toBe("/home/user/project");
  });

  it("lists agent conversations filtered by projectRoot", async () => {
    await createAgentConversation({ id: "ac1", title: "A", agentType: "claude-code", projectRoot: "/proj/a" });
    await new Promise((r) => setTimeout(r, 5));
    await createAgentConversation({ id: "ac2", title: "B", agentType: "codex", projectRoot: "/proj/b" });
    await new Promise((r) => setTimeout(r, 5));
    await createAgentConversation({ id: "ac3", title: "C", agentType: "claude-code", projectRoot: "/proj/a" });

    const all = await getAgentConversations({});
    expect(all).toHaveLength(3);
    expect(all[0].id).toBe("ac3"); // most recent first

    const filtered = await getAgentConversations({ projectRoot: "/proj/a" });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.project_root === "/proj/a")).toBe(true);
  });

  it("excludes archived agent conversations", async () => {
    await createAgentConversation({ id: "ac1", title: "Active", agentType: "claude-code" });
    await createAgentConversation({ id: "ac2", title: "Archived", agentType: "claude-code" });
    await archiveAgentConversation({ id: "ac2" });

    const list = await getAgentConversations({});
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("ac1");
  });

  it("updates session id, title, model, and metadata", async () => {
    await createAgentConversation({ id: "ac1", title: "Old", agentType: "claude-code" });

    await setAgentConversationSessionId({ id: "ac1", agentSessionId: "new-sess" });
    await setAgentConversationTitle({ id: "ac1", title: "New Title" });
    await setAgentConversationModelId({ id: "ac1", agentModelId: "claude-opus-4-6" });
    await setAgentConversationMetadata({ id: "ac1", agentMetadata: '{"key":"val"}' });

    const fetched = await getAgentConversation({ id: "ac1" });
    expect(fetched!.agent_session_id).toBe("new-sess");
    expect(fetched!.title).toBe("New Title");
    expect(fetched!.agent_model_id).toBe("claude-opus-4-6");
    expect(fetched!.agent_metadata).toBe('{"key":"val"}');
  });

  it("returns null for non-existent agent conversation", async () => {
    const fetched = await getAgentConversation({ id: "nope" });
    expect(fetched).toBeNull();
  });
});
