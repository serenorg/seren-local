// ABOUTME: Registers all RPC handlers with the JSON-RPC router.
// ABOUTME: Called once at server startup.

import { registerHandler } from "../rpc";
import * as fs from "./fs";

export function registerAllHandlers(): void {
  registerHandler("list_directory", fs.listDirectory);
  registerHandler("read_file", fs.readFile);
  registerHandler("write_file", fs.writeFile);
  registerHandler("path_exists", fs.pathExists);
  registerHandler("is_directory", fs.isDirectory);
  registerHandler("create_file", fs.createFile);
  registerHandler("create_directory", fs.createDirectory);
  registerHandler("delete_path", fs.deletePath);
  registerHandler("rename_path", fs.renamePath);
}
