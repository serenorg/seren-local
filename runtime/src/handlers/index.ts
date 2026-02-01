// ABOUTME: Registers all RPC handlers with the JSON-RPC router.
// ABOUTME: Called once at server startup.

import { registerHandler } from "../rpc";
import * as chat from "./chat";
import * as dialogs from "./dialogs";
import * as fs from "./fs";

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
