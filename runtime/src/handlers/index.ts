// ABOUTME: Registers all RPC handlers with the JSON-RPC router.
// ABOUTME: Called once at server startup.

import { registerHandler } from "../rpc.js";
import * as acp from "./acp.js";
import * as chat from "./chat.js";
import * as dialogs from "./dialogs.js";
import * as fs from "./fs.js";

export function registerAllHandlers(): void {
  // File system handlers
  registerHandler("list_directory", fs.listDirectory);
  registerHandler("read_file", fs.readFile);
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
