// ABOUTME: Registers all RPC handlers with the JSON-RPC router.
// ABOUTME: Called once at server startup.

import { emit } from "../events.js";
import { registerHandler } from "../rpc.js";
import { cancelOrchestration, orchestrate } from "../services/orchestrator.js";
import * as chat from "./chat.js";
import * as dialogs from "./dialogs.js";
import * as fs from "./fs.js";
import * as indexing from "./indexing.js";
import * as mcp from "./mcp.js";
import * as openclaw from "./openclaw.js";
import * as skills from "./skills.js";
import * as sync from "./sync.js";
import * as updater from "./updater.js";
import * as wallet from "./wallet.js";

/**
 * Dynamically load the browser-local provider handlers and register them.
 * These replace the old ACP protocol with direct Claude Code / Codex CLI spawning.
 */
async function registerProviderHandlers(): Promise<void> {
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // In dev: runtime/src/handlers/ → runtime/bin/browser-local/
  // In dist: runtime/dist/ → runtime/bin/browser-local/
  const providersPath = join(
    __dirname,
    "..",
    "bin",
    "browser-local",
    "providers.mjs",
  );
  const { createProviderHandlers } = await import(providersPath);

  const providerHandlers = createProviderHandlers({ emit });

  registerHandler("provider_spawn", providerHandlers.spawnSession);
  registerHandler("provider_prompt", providerHandlers.sendPrompt);
  registerHandler("provider_cancel", providerHandlers.cancelPrompt);
  registerHandler("provider_terminate", providerHandlers.terminateSession);
  registerHandler("provider_list_sessions", providerHandlers.listSessions);
  registerHandler(
    "provider_set_permission_mode",
    providerHandlers.setPermissionMode,
  );
  registerHandler(
    "provider_respond_to_permission",
    providerHandlers.respondToPermission,
  );
  registerHandler(
    "provider_respond_to_diff_proposal",
    providerHandlers.respondToDiffProposal,
  );
  registerHandler(
    "provider_get_available_agents",
    providerHandlers.getAvailableAgents,
  );
  registerHandler(
    "provider_check_agent_available",
    providerHandlers.checkAgentAvailable,
  );
  registerHandler("provider_ensure_agent_cli", providerHandlers.ensureAgentCli);
  registerHandler("provider_launch_login", providerHandlers.launchLogin);
  registerHandler(
    "provider_list_remote_sessions",
    providerHandlers.listRemoteSessions,
  );
  registerHandler(
    "provider_native_fork_session",
    providerHandlers.nativeForkSession,
  );
  registerHandler(
    "provider_set_session_model",
    providerHandlers.setSessionModel,
  );
  registerHandler(
    "provider_update_session_config_option",
    providerHandlers.updateSessionConfigOption,
  );
}

export async function registerAllHandlers(): Promise<void> {
  // File system handlers
  registerHandler("list_directory", fs.listDirectory);
  registerHandler("read_file", fs.readFile);
  registerHandler("read_file_base64", fs.readFileBase64);
  registerHandler("write_file", fs.writeFile);
  registerHandler("path_exists", fs.pathExists);
  registerHandler("is_directory", fs.isDirectory);
  registerHandler("create_file", fs.createFile);
  registerHandler("create_directory", fs.createDirectory);
  registerHandler("delete_path", fs.deletePath);
  registerHandler("rename_path", fs.renamePath);
  registerHandler("get_home_dir", fs.getHomeDir);

  // Dialog handlers
  registerHandler("open_folder_dialog", dialogs.openFolderDialog);
  registerHandler("open_file_dialog", dialogs.openFileDialog);
  registerHandler("save_file_dialog", dialogs.saveFileDialog);
  registerHandler("reveal_in_file_manager", dialogs.revealInFileManager);

  // Agent provider handlers — direct CLI spawning (replaced ACP protocol)
  await registerProviderHandlers();

  // OpenClaw messaging gateway handlers
  registerHandler("openclaw_start", openclaw.openclawStart);
  registerHandler("openclaw_stop", openclaw.openclawStop);
  registerHandler("openclaw_restart", openclaw.openclawRestart);
  registerHandler("openclaw_status", openclaw.openclawStatus);
  registerHandler("openclaw_list_channels", openclaw.openclawListChannels);
  registerHandler("openclaw_connect_channel", openclaw.openclawConnectChannel);
  registerHandler(
    "openclaw_disconnect_channel",
    openclaw.openclawDisconnectChannel,
  );
  registerHandler("openclaw_set_trust", openclaw.openclawSetTrust);
  registerHandler("openclaw_send", openclaw.openclawSend);
  registerHandler("openclaw_grant_approval", openclaw.openclawGrantApproval);
  registerHandler("openclaw_get_qr", openclaw.openclawGetQr);

  // Settings handlers
  registerHandler("get_setting", openclaw.getSetting);
  registerHandler("set_setting", openclaw.setSetting);

  // Crypto wallet handlers
  registerHandler("store_crypto_private_key", wallet.storeCryptoPrivateKey);
  registerHandler("get_crypto_wallet_address", wallet.getCryptoWalletAddress);
  registerHandler("clear_crypto_wallet", wallet.clearCryptoWallet);
  registerHandler("sign_x402_payment", wallet.signX402Payment);
  registerHandler("get_crypto_usdc_balance", wallet.getCryptoUsdcBalance);

  // File watcher handlers
  registerHandler("start_watching", sync.startWatching);
  registerHandler("stop_watching", sync.stopWatching);

  // Indexing handlers
  registerHandler("init_project_index", indexing.initProjectIndex);
  registerHandler("get_index_status", indexing.getIndexStatus);
  registerHandler("has_project_index", indexing.hasProjectIndex);
  registerHandler("search_codebase", indexing.searchCodebase);
  registerHandler("file_needs_reindex", indexing.fileNeedsReindex);
  registerHandler("delete_file_index", indexing.deleteFileIndex);
  registerHandler("index_chunks", indexing.indexChunks);
  registerHandler("discover_project_files", indexing.discoverProjectFiles);
  registerHandler("chunk_file", indexing.chunkFile);
  registerHandler("estimate_indexing", indexing.estimateIndexing);
  registerHandler("compute_file_hash", indexing.computeFileHash);
  registerHandler("get_embedding_dimension", indexing.getEmbeddingDimension);

  // MCP handlers
  registerHandler("mcp_disconnect", mcp.mcpDisconnect);
  registerHandler("mcp_read_resource", mcp.mcpReadResource);

  // Updater handlers
  registerHandler("check_for_update", updater.checkForUpdate);
  registerHandler("install_update", updater.installUpdate);

  // Skills handlers
  skills.registerSkillsHandlers(registerHandler);

  // Chat/conversation handlers
  registerHandler("create_conversation", chat.createConversation);
  registerHandler("get_conversations", chat.getConversations);
  registerHandler("get_conversation", chat.getConversation);
  registerHandler("update_conversation", chat.updateConversation);
  registerHandler("archive_conversation", chat.archiveConversation);
  registerHandler("delete_conversation", chat.deleteConversation);
  registerHandler("save_message", chat.saveMessage);
  registerHandler("get_messages", chat.getMessages);

  // Agent conversation handlers
  registerHandler("create_agent_conversation", chat.createAgentConversation);
  registerHandler("get_agent_conversations", chat.getAgentConversations);
  registerHandler("get_agent_conversation", chat.getAgentConversation);
  registerHandler(
    "set_agent_conversation_session_id",
    chat.setAgentConversationSessionId,
  );
  registerHandler(
    "set_agent_conversation_title",
    chat.setAgentConversationTitle,
  );
  registerHandler(
    "set_agent_conversation_model_id",
    chat.setAgentConversationModelId,
  );
  registerHandler(
    "set_agent_conversation_metadata",
    chat.setAgentConversationMetadata,
  );
  registerHandler("archive_agent_conversation", chat.archiveAgentConversation);

  // Orchestrator handlers
  registerHandler(
    "orchestrate",
    async (params: {
      conversationId: string;
      prompt: string;
      history: Array<{ role: string; content: string }>;
      capabilities: Record<string, unknown>;
      images?: Array<{ name: string; mime_type: string; base64: string }>;
      gatewayBase?: string;
      authToken: string;
    }) => {
      // Fire-and-forget: orchestration streams events over WebSocket,
      // the RPC response just acknowledges the request was accepted.
      orchestrate({
        conversationId: params.conversationId,
        prompt: params.prompt,
        history: params.history,
        capabilities: params.capabilities as any,
        images: params.images,
        gatewayBase: params.gatewayBase,
        authToken: params.authToken,
      }).catch((err) => {
        console.error("[Orchestrator] Unhandled error:", err);
      });
      return { accepted: true };
    },
  );

  registerHandler(
    "cancel_orchestration",
    async (params: { conversationId: string }) => {
      const cancelled = cancelOrchestration(params.conversationId);
      return { cancelled };
    },
  );
}
