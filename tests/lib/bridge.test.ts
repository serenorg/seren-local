// ABOUTME: Tests for bridge.ts — the browser-native replacement for tauri-bridge.ts.
// ABOUTME: Covers token storage, API keys, provider keys, OAuth, file ops, IndexedDB conversations.

import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";

function clearLocalStorage() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    keys.push(localStorage.key(i)!);
  }
  for (const key of keys) {
    localStorage.removeItem(key);
  }
}

import {
  // Token storage
  storeToken,
  getToken,
  clearToken,
  storeRefreshToken,
  getRefreshToken,

  // API key
  storeSerenApiKey,
  getSerenApiKey,
  clearSerenApiKey,
  // Org ID
  storeDefaultOrganizationId,
  getDefaultOrganizationId,
  clearDefaultOrganizationId,
  // Provider keys
  storeProviderKey,
  getProviderKey,
  clearProviderKey,
  getConfiguredProviders,
  // OAuth
  storeOAuthCredentials,
  getOAuthCredentials,
  clearOAuthCredentials,
  getOAuthProviders,
  listenForOAuthCallback,
  // Runtime detection
  isRuntimeConnected,
  // File operations
  listDirectory,
  readFile,
  writeFile,
  pathExists,
  isDirectory,
  createFile,
  createDirectory,
  deletePath,
  renamePath,
  // Crypto wallet
  storeCryptoPrivateKey,
  getCryptoWalletAddress,
  clearCryptoWallet,
  signX402Payment,
  getCryptoUsdcBalance,
  // Conversations (IndexedDB)
  createConversation,
  getConversations,
  getConversation,
  updateConversation,
  archiveConversation,
  deleteConversation,
  saveMessage,
  getMessages,
  clearConversationHistory,
  clearAllHistory,
} from "@/lib/bridge";

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

describe("bridge: token storage", () => {
  beforeEach(() => clearLocalStorage());

  it("stores and retrieves a token", async () => {
    await storeToken("test-token-123");
    const token = await getToken();
    expect(token).toBe("test-token-123");
  });

  it("returns null when no token stored", async () => {
    const token = await getToken();
    expect(token).toBeNull();
  });

  it("clears a stored token", async () => {
    await storeToken("test-token");
    await clearToken();
    const token = await getToken();
    expect(token).toBeNull();
  });

  it("overwrites existing token", async () => {
    await storeToken("old-token");
    await storeToken("new-token");
    const token = await getToken();
    expect(token).toBe("new-token");
  });
});

// ---------------------------------------------------------------------------
// Refresh token storage
// ---------------------------------------------------------------------------

describe("bridge: refresh token storage", () => {
  beforeEach(() => clearLocalStorage());

  it("stores and retrieves refresh token separately from access token", async () => {
    await storeToken("access-token");
    await storeRefreshToken("refresh-token");
    expect(await getToken()).toBe("access-token");
    expect(await getRefreshToken()).toBe("refresh-token");
  });

  it("clearing access token does not clear refresh token", async () => {
    await storeToken("access");
    await storeRefreshToken("refresh");
    await clearToken();
    expect(await getToken()).toBeNull();
    expect(await getRefreshToken()).toBe("refresh");
  });
});

// ---------------------------------------------------------------------------
// API key storage
// ---------------------------------------------------------------------------

describe("bridge: API key storage", () => {
  beforeEach(() => clearLocalStorage());

  it("stores and retrieves Seren API key", async () => {
    await storeSerenApiKey("sk-test-123");
    expect(await getSerenApiKey()).toBe("sk-test-123");
  });

  it("clears API key", async () => {
    await storeSerenApiKey("sk-test");
    await clearSerenApiKey();
    expect(await getSerenApiKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Default Organization ID
// ---------------------------------------------------------------------------

describe("bridge: organization ID storage", () => {
  beforeEach(() => clearLocalStorage());

  it("stores and retrieves org ID", async () => {
    await storeDefaultOrganizationId("org-abc");
    expect(await getDefaultOrganizationId()).toBe("org-abc");
  });

  it("clears org ID", async () => {
    await storeDefaultOrganizationId("org-abc");
    await clearDefaultOrganizationId();
    expect(await getDefaultOrganizationId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Provider key storage
// ---------------------------------------------------------------------------

describe("bridge: provider key storage", () => {
  beforeEach(() => clearLocalStorage());

  it("stores keys for different providers", async () => {
    await storeProviderKey("openai", "sk-openai-123");
    await storeProviderKey("anthropic", "sk-ant-456");
    expect(await getProviderKey("openai")).toBe("sk-openai-123");
    expect(await getProviderKey("anthropic")).toBe("sk-ant-456");
  });

  it("lists configured providers", async () => {
    await storeProviderKey("openai", "key1");
    await storeProviderKey("anthropic", "key2");
    const providers = await getConfiguredProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers.length).toBe(2);
  });

  it("clearing a provider key removes it from configured list", async () => {
    await storeProviderKey("openai", "key1");
    await storeProviderKey("anthropic", "key2");
    await clearProviderKey("openai");
    const providers = await getConfiguredProviders();
    expect(providers).not.toContain("openai");
    expect(providers).toContain("anthropic");
  });
});

// ---------------------------------------------------------------------------
// OAuth credentials
// ---------------------------------------------------------------------------

describe("bridge: OAuth credentials", () => {
  beforeEach(() => clearLocalStorage());

  it("stores and retrieves OAuth credentials as JSON string", async () => {
    const creds = JSON.stringify({
      access_token: "abc",
      refresh_token: "def",
    });
    await storeOAuthCredentials("github", creds);
    expect(await getOAuthCredentials("github")).toBe(creds);
  });

  it("lists OAuth providers", async () => {
    await storeOAuthCredentials("github", "{}");
    await storeOAuthCredentials("google", "{}");
    const providers = await getOAuthProviders();
    expect(providers).toContain("github");
    expect(providers).toContain("google");
  });

  it("clears OAuth credentials for a provider", async () => {
    await storeOAuthCredentials("github", "{}");
    await clearOAuthCredentials("github");
    expect(await getOAuthCredentials("github")).toBeNull();
  });

  it("listenForOAuthCallback returns a cleanup function", async () => {
    const cleanup = await listenForOAuthCallback(() => {});
    expect(typeof cleanup).toBe("function");
    cleanup(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

describe("bridge: runtime detection", () => {
  it("returns false when no runtime is running", () => {
    expect(isRuntimeConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File operations require runtime
// ---------------------------------------------------------------------------

describe("bridge: file operations require runtime", () => {
  it("listDirectory throws when runtime not connected", async () => {
    await expect(listDirectory("/tmp")).rejects.toThrow(/runtime/i);
  });

  it("readFile throws when runtime not connected", async () => {
    await expect(readFile("/tmp/test.txt")).rejects.toThrow(/runtime/i);
  });

  it("writeFile throws when runtime not connected", async () => {
    await expect(writeFile("/tmp/test.txt", "content")).rejects.toThrow(
      /runtime/i,
    );
  });

  it("pathExists throws when runtime not connected", async () => {
    await expect(pathExists("/tmp")).rejects.toThrow(/runtime/i);
  });

  it("isDirectory throws when runtime not connected", async () => {
    await expect(isDirectory("/tmp")).rejects.toThrow(/runtime/i);
  });

  it("createFile throws when runtime not connected", async () => {
    await expect(createFile("/tmp/test.txt")).rejects.toThrow(/runtime/i);
  });

  it("createDirectory throws when runtime not connected", async () => {
    await expect(createDirectory("/tmp/test")).rejects.toThrow(/runtime/i);
  });

  it("deletePath throws when runtime not connected", async () => {
    await expect(deletePath("/tmp/test")).rejects.toThrow(/runtime/i);
  });

  it("renamePath throws when runtime not connected", async () => {
    await expect(renamePath("/tmp/old", "/tmp/new")).rejects.toThrow(
      /runtime/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Crypto wallet requires runtime
// ---------------------------------------------------------------------------

describe("bridge: crypto wallet requires runtime", () => {
  it("storeCryptoPrivateKey throws when runtime not connected", async () => {
    await expect(storeCryptoPrivateKey("0xabc")).rejects.toThrow(/runtime/i);
  });

  it("getCryptoWalletAddress throws when runtime not connected", async () => {
    await expect(getCryptoWalletAddress()).rejects.toThrow(/runtime/i);
  });

  it("clearCryptoWallet throws when runtime not connected", async () => {
    await expect(clearCryptoWallet()).rejects.toThrow(/runtime/i);
  });

  it("signX402Payment throws when runtime not connected", async () => {
    await expect(signX402Payment("{}")).rejects.toThrow(/runtime/i);
  });

  it("getCryptoUsdcBalance throws when runtime not connected", async () => {
    await expect(getCryptoUsdcBalance()).rejects.toThrow(/runtime/i);
  });
});

// ---------------------------------------------------------------------------
// IndexedDB conversation storage
// ---------------------------------------------------------------------------

describe("bridge: IndexedDB conversation storage", () => {
  beforeEach(async () => {
    await clearAllHistory();
  });

  it("creates and retrieves a conversation", async () => {
    const conv = await createConversation(
      "conv-1",
      "Test Chat",
      "claude-3",
      "anthropic",
    );
    expect(conv.id).toBe("conv-1");
    expect(conv.title).toBe("Test Chat");

    const retrieved = await getConversation("conv-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Test Chat");
    expect(retrieved!.selected_model).toBe("claude-3");
  });

  it("lists conversations excluding archived, newest first", async () => {
    await createConversation("conv-1", "First");
    await createConversation("conv-2", "Second");
    await archiveConversation("conv-1");

    const convs = await getConversations();
    expect(convs.length).toBe(1);
    expect(convs[0].id).toBe("conv-2");
  });

  it("updates conversation title", async () => {
    await createConversation("conv-1", "Old Title");
    await updateConversation("conv-1", "New Title");
    const conv = await getConversation("conv-1");
    expect(conv!.title).toBe("New Title");
  });

  it("deletes conversation and its messages", async () => {
    await createConversation("conv-1", "Test");
    await saveMessage("msg-1", "conv-1", "user", "Hello", null, Date.now());
    await saveMessage(
      "msg-2",
      "conv-1",
      "assistant",
      "Hi",
      "claude-3",
      Date.now(),
    );

    await deleteConversation("conv-1");

    expect(await getConversation("conv-1")).toBeNull();
    const msgs = await getMessages("conv-1", 100);
    expect(msgs.length).toBe(0);
  });

  it("saves and retrieves messages in order", async () => {
    await createConversation("conv-1", "Test");
    const t1 = 1000;
    const t2 = 2000;
    await saveMessage("msg-1", "conv-1", "user", "First", null, t1);
    await saveMessage("msg-2", "conv-1", "assistant", "Second", "claude-3", t2);

    const msgs = await getMessages("conv-1", 100);
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("First");
    expect(msgs[1].content).toBe("Second");
  });

  it("respects message limit", async () => {
    await createConversation("conv-1", "Test");
    for (let i = 0; i < 10; i++) {
      await saveMessage(
        `msg-${i}`,
        "conv-1",
        "user",
        `Message ${i}`,
        null,
        i * 1000,
      );
    }

    const msgs = await getMessages("conv-1", 5);
    expect(msgs.length).toBe(5);
  });

  it("clears conversation history without deleting the conversation", async () => {
    await createConversation("conv-1", "Test");
    await saveMessage("msg-1", "conv-1", "user", "Hello", null, Date.now());

    await clearConversationHistory("conv-1");

    expect(await getConversation("conv-1")).not.toBeNull();
    const msgs = await getMessages("conv-1", 100);
    expect(msgs.length).toBe(0);
  });

  it("clearAllHistory removes everything", async () => {
    await createConversation("conv-1", "Test");
    await saveMessage("msg-1", "conv-1", "user", "Hello", null, Date.now());

    await clearAllHistory();

    const convs = await getConversations();
    expect(convs.length).toBe(0);
  });
});
