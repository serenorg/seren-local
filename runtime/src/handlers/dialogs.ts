// ABOUTME: Native OS dialog handlers for folder/file pickers and reveal-in-finder.
// ABOUTME: Uses platform-specific CLI tools (osascript, zenity, powershell).
// ABOUTME: Returns null gracefully on headless servers so the browser can show a fallback prompt.

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { dirname } from "node:path";

const os = platform();

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout) => {
      if (err) {
        // User cancelled dialog — not an error
        if (err.code === 1 || err.killed) {
          resolve("");
          return;
        }
        reject(err);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function openFolderDialog(): Promise<string | null> {
  try {
    let result: string;

    if (os === "darwin") {
      result = await exec("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Select a folder")',
      ]);
    } else if (os === "linux") {
      result = await exec("zenity", ["--file-selection", "--directory", "--title=Select a folder"]);
    } else if (os === "win32") {
      result = await exec("powershell", [
        "-NoProfile",
        "-Command",
        "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }",
      ]);
    } else {
      return null;
    }

    return result || null;
  } catch {
    // Dialog tool unavailable (headless server, no display, zenity not installed)
    // Return null so the frontend can fall back to a browser prompt
    return null;
  }
}

export async function openFileDialog(): Promise<string | null> {
  try {
    let result: string;

    if (os === "darwin") {
      result = await exec("osascript", [
        "-e",
        'POSIX path of (choose file with prompt "Select a file")',
      ]);
    } else if (os === "linux") {
      result = await exec("zenity", ["--file-selection", "--title=Select a file"]);
    } else if (os === "win32") {
      result = await exec("powershell", [
        "-NoProfile",
        "-Command",
        "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $f = New-Object System.Windows.Forms.OpenFileDialog; if ($f.ShowDialog() -eq 'OK') { $f.FileName }",
      ]);
    } else {
      return null;
    }

    return result || null;
  } catch {
    return null;
  }
}

export async function saveFileDialog(params: {
  defaultPath?: string;
}): Promise<string | null> {
  try {
    let result: string;

    if (os === "darwin") {
      const prompt = params.defaultPath
        ? `POSIX path of (choose file name with prompt "Save as" default name "${params.defaultPath}")`
        : 'POSIX path of (choose file name with prompt "Save as")';
      result = await exec("osascript", ["-e", prompt]);
    } else if (os === "linux") {
      const args = ["--file-selection", "--save", "--title=Save as"];
      if (params.defaultPath) args.push(`--filename=${params.defaultPath}`);
      result = await exec("zenity", args);
    } else if (os === "win32") {
      result = await exec("powershell", [
        "-NoProfile",
        "-Command",
        "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $f = New-Object System.Windows.Forms.SaveFileDialog; if ($f.ShowDialog() -eq 'OK') { $f.FileName }",
      ]);
    } else {
      return null;
    }

    return result || null;
  } catch {
    return null;
  }
}

export async function revealInFileManager(params: {
  path: string;
}): Promise<void> {
  if (os === "darwin") {
    await exec("open", ["-R", params.path]);
  } else if (os === "linux") {
    // xdg-open opens the containing directory
    await exec("xdg-open", [dirname(params.path)]);
  } else if (os === "win32") {
    await exec("explorer", [`/select,${params.path}`]);
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }
}
