// ABOUTME: SolidJS hook for browser file drag-and-drop attachment.
// ABOUTME: Returns isDragging signal and ref callback for drop target element.

import { createSignal, onCleanup } from "solid-js";
import type { ImageAttachment } from "@/lib/providers/types";

const SUPPORTED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MAX_BASE64_SIZE = 27 * 1024 * 1024; // ~20MB file = ~27MB base64

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix to get raw base64
      const base64 = result.split(",")[1];
      if (!base64) return reject(new Error("Failed to read file as base64"));
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Register browser drag-and-drop handlers on a target element.
 * Call inside a SolidJS component — cleans up listeners automatically.
 *
 * @param onFiles Called with successfully read attachments when files are dropped.
 * @returns isDragging signal and ref callback to attach to the drop target.
 */
export function createDragDrop(onFiles: (attachments: ImageAttachment[]) => void): {
  isDragging: () => boolean;
  setDropTarget: (el: HTMLElement) => void;
} {
  const [isDragging, setIsDragging] = createSignal(false);
  let dragCounter = 0;
  let targetEl: HTMLElement | null = null;

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) setIsDragging(true);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const attachments: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      const mimeExt = SUPPORTED_MIME[file.type];
      if (!mimeExt) continue;

      try {
        const base64 = await fileToBase64(file);
        if (base64.length > MAX_BASE64_SIZE) {
          console.warn("[DragDrop] File too large, skipping:", file.name);
          continue;
        }
        attachments.push({
          name: file.name,
          mimeType: file.type,
          base64,
        });
      } catch (error) {
        console.warn("[DragDrop] Failed to read file:", file.name, error);
      }
    }

    if (attachments.length > 0) {
      onFiles(attachments);
    }
  };

  const setDropTarget = (el: HTMLElement) => {
    targetEl = el;
    el.addEventListener("dragenter", handleDragEnter);
    el.addEventListener("dragover", handleDragOver);
    el.addEventListener("dragleave", handleDragLeave);
    el.addEventListener("drop", handleDrop);
  };

  onCleanup(() => {
    if (targetEl) {
      targetEl.removeEventListener("dragenter", handleDragEnter);
      targetEl.removeEventListener("dragover", handleDragOver);
      targetEl.removeEventListener("dragleave", handleDragLeave);
      targetEl.removeEventListener("drop", handleDrop);
    }
  });

  return { isDragging, setDropTarget };
}
