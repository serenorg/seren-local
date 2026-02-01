// ABOUTME: Shared file explorer sidebar for the resizable layout.
// ABOUTME: Provides folder opening and file tree navigation.

import { type Component, createSignal, Show, onMount } from "solid-js";
import { isRuntimeConnected } from "@/lib/bridge";
import {
  loadDirectoryChildren,
  openFileInTab,
  openFolder,
} from "@/lib/files/service";
import { fileTreeState, setNodes } from "@/stores/fileTree";
import { FileTree } from "./FileTree";

/**
 * Recursively update children for a node in the tree.
 */
function updateNodeChildren(
  nodes: typeof fileTreeState.nodes,
  path: string,
  children: typeof fileTreeState.nodes,
): typeof fileTreeState.nodes {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: updateNodeChildren(node.children, path, children),
      };
    }
    return node;
  });
}

export const FileExplorer: Component = () => {
  const [isLoading, setIsLoading] = createSignal(false);
  const [initialConnecting, setInitialConnecting] = createSignal(true);

  onMount(() => {
    // Give the runtime a few seconds to connect before showing the "required" message
    const timer = setTimeout(() => setInitialConnecting(false), 3000);
    // Clear early if runtime connects
    const check = setInterval(() => {
      if (isRuntimeConnected()) {
        clearTimeout(timer);
        clearInterval(check);
        setInitialConnecting(false);
      }
    }, 100);
    return () => {
      clearTimeout(timer);
      clearInterval(check);
    };
  });

  const handleOpenFolder = async () => {
    setIsLoading(true);
    try {
      await openFolder();
    } catch (error) {
      console.error("Failed to open folder:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (path: string) => {
    try {
      await openFileInTab(path);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const handleDirectoryToggle = async (path: string, expanded: boolean) => {
    if (expanded) {
      try {
        const children = await loadDirectoryChildren(path);
        const updatedNodes = updateNodeChildren(
          fileTreeState.nodes,
          path,
          children,
        );
        setNodes(updatedNodes);
      } catch (error) {
        console.error("Failed to load directory:", error);
      }
    }
  };

  const runtimeAvailable = () => isRuntimeConnected();

  return (
    <aside class="flex flex-col h-full bg-[#161b22] border-r border-[#21262d]">
      <div class="flex justify-between items-center px-3 py-2.5 border-b border-[#21262d] text-[11px] font-semibold uppercase tracking-wide text-[#8b949e]">
        <span>Explorer</span>
        <button
          type="button"
          onClick={handleOpenFolder}
          disabled={isLoading() || !runtimeAvailable()}
          title={runtimeAvailable() ? "Open Folder" : "Local runtime required"}
          class="bg-transparent border-none text-[#8b949e] cursor-pointer px-1 py-0.5 text-sm leading-none transition-colors hover:text-[#e6edf3] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading() ? "..." : "+"}
        </button>
      </div>
      <div class="flex-1 overflow-y-auto py-1">
        <Show
          when={runtimeAvailable()}
          fallback={
            <Show
              when={!initialConnecting()}
              fallback={
                <div class="px-4 py-6 text-center text-[#8b949e] text-xs">
                  Connecting...
                </div>
              }
            >
              <div class="px-4 py-6 text-center text-[#8b949e] text-xs leading-relaxed">
                <p class="mb-2">Local runtime required for file access.</p>
                <p>
                  Run <code class="bg-[#21262d] px-1.5 py-0.5 rounded text-[#e6edf3]">seren</code> locally to enable the file explorer.
                </p>
              </div>
            </Show>
          }
        >
          <FileTree
            onFileSelect={handleFileSelect}
            onDirectoryToggle={handleDirectoryToggle}
          />
        </Show>
      </div>
    </aside>
  );
};
