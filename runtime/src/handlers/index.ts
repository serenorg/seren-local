// ABOUTME: Registers all RPC handlers with the JSON-RPC router.
// ABOUTME: Called once at server startup.

import { registerHandler } from "../rpc.js";
import * as acp from "./acp.js";
import * as chat from "./chat.js";
import * as dialogs from "./dialogs.js";
import * as fs from "./fs.js";
import * as indexing from "./indexing.js";
import * as mcp from "./mcp.js";
import * as openclaw from "./openclaw.js";
import * as sync from "./sync.js";
import * as wallet from "./wallet.js";

export function registerAllHandlers(): void {
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

  // Dialog handlers
  registerHandler("open_folder_dialog", dialogs.openFolderDialog);
  registerHandler("open_file_dialog", dialogs.openFileDialog);
  registerHandler("save_file_dialog", dialogs.saveFileDialog);
  registerHandler("reveal_in_file_manager", dialogs.revealInFileManager);

  // ACP agent handlers
  registerHandler("acp_spawn", acp.acpSpawn);
  registerHandler("acp_prompt", acp.acpPrompt);
  registerHandler("acp_cancel", acp.acpCancel);
  registerHandler("acp_terminate", acp.acpTerminate);
  registerHandler("acp_list_sessions", acp.acpListSessions);
  registerHandler("acp_set_permission_mode", acp.acpSetPermissionMode);
  registerHandler("acp_respond_to_permission", acp.acpRespondToPermission);
  registerHandler("acp_respond_to_diff_proposal", acp.acpRespondToDiffProposal);
  registerHandler("acp_get_available_agents", acp.acpGetAvailableAgents);
  registerHandler("acp_check_agent_available", acp.acpCheckAgentAvailable);
  registerHandler("acp_ensure_claude_cli", acp.acpEnsureClaudeCli);

  // OpenClaw messaging gateway handlers
  registerHandler("openclaw_start", openclaw.openclawStart);
  registerHandler("openclaw_stop", openclaw.openclawStop);
  registerHandler("openclaw_restart", openclaw.openclawRestart);
  registerHandler("openclaw_status", openclaw.openclawStatus);
  registerHandler("openclaw_list_channels", openclaw.openclawListChannels);
  registerHandler("openclaw_connect_channel", openclaw.openclawConnectChannel);
  registerHandler("openclaw_disconnect_channel", openclaw.openclawDisconnectChannel);
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

  // Chat/conversation handlers
  registerHandler("create_conversation", chat.createConversation);
  registerHandler("get_conversations", chat.getConversations);
  registerHandler("get_conversation", chat.getConversation);
  registerHandler("update_conversation", chat.updateConversation);
  registerHandler("archive_conversation", chat.archiveConversation);
  registerHandler("delete_conversation", chat.deleteConversation);
  registerHandler("save_message", chat.saveMessage);
  registerHandler("get_messages", chat.getMessages);
}
