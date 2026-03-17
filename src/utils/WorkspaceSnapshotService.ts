import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as Diff from "diff";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import type {
  WorkspaceSnapshot,
  SnapshotFileChange,
  PromptChangeType,
} from "../types/OutputHistoryTypes";
import type {
  UndoFileInstruction,
  UndoResult,
} from "../types/WebviewMessageTypes";
import type { UnifiedDiffHunk } from "../types/CliOutputTypes";
import { Log } from "./Log";

const execFileAsync = promisify(execFile);

const MAX_CONTENT_SIZE = 512 * 1024; // 512 KB
const BINARY_CHECK_SIZE = 8 * 1024; // 8 KB

/** Artifact directories/files to always exclude in filesystem strategy */
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "out", "build", ".next", ".nuxt", ".svelte-kit",
  ".turbo", "coverage", ".nyc_output", ".cache", ".parcel-cache",
  "__pycache__", ".pytest_cache", ".venv", "venv", "target", "vendor",
  ".gradle", ".idea", PATH_CONSTANTS.FLIGHTPATH_DIR, ".git",
]);

const EXCLUDED_EXTENSIONS = new Set([".pyc", ".class", ".o", ".obj"]);

interface RawFileState {
  contentHash: string; // SHA-256
  content?: string; // before-state content, under size limit
  isAtHead: boolean; // true only under git strategy
}

export interface RawWorkspaceState {
  strategy: "git" | "filesystem";
  files: Map<string, RawFileState>;
  capturedAt: number;
}

function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

async function readFileForSnapshot(
  filePath: string
): Promise<{ content?: string; hash: string } | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_CONTENT_SIZE) {
      // Too large — hash only
      const buffer = await fs.promises.readFile(filePath);
      if (isBinary(buffer)) {
        return null;
      }
      const content = buffer.toString("utf8");
      return { hash: computeHash(content) };
    }
    const buffer = await fs.promises.readFile(filePath);
    if (isBinary(buffer)) {
      return null;
    }
    const content = buffer.toString("utf8");
    return { content, hash: computeHash(content) };
  } catch {
    return null;
  }
}

/** Parse .gitignore lines into simple matchers. Returns a function that checks if a relative path should be excluded. */
function buildGitignoreMatcher(
  gitignorePath: string
): (relPosix: string, isDir: boolean) => boolean {
  let lines: string[] = [];
  try {
    const raw = fs.readFileSync(gitignorePath, "utf8");
    lines = raw.split(/\r?\n/);
  } catch {
    return () => false;
  }

  const dirPatterns: string[] = [];
  const namePatterns: string[] = [];
  const globPatterns: RegExp[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    if (line.endsWith("/")) {
      // Directory pattern — strip trailing slash
      dirPatterns.push(line.slice(0, -1));
    } else if (line.includes("*")) {
      // Simple glob: match filename only
      const escaped = line.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
      try {
        globPatterns.push(new RegExp(`^${escaped}$`));
      } catch {
        // ignore invalid pattern
      }
    } else {
      // Bare name — matches dir or file
      namePatterns.push(line);
    }
  }

  return (relPosix: string, isDir: boolean): boolean => {
    const parts = relPosix.split("/");
    const fileName = parts[parts.length - 1];

    // Check each directory segment against dirPatterns and namePatterns
    for (const segment of parts) {
      if (dirPatterns.includes(segment) || namePatterns.includes(segment)) {
        return true;
      }
    }

    // Glob patterns match filename
    for (const pattern of globPatterns) {
      if (pattern.test(fileName)) {
        return true;
      }
    }

    // For dirs also check dirPatterns on leaf
    if (isDir && dirPatterns.includes(fileName)) {
      return true;
    }

    return false;
  };
}

async function walkDirectory(
  dir: string,
  workspacePath: string,
  gitignoreMatcher: (relPosix: string, isDir: boolean) => boolean,
  result: Map<string, RawFileState>
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relNative = path.relative(workspacePath, fullPath);
    const relPosix = relNative.replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      if (gitignoreMatcher(relPosix, true)) {
        continue;
      }
      await walkDirectory(fullPath, workspacePath, gitignoreMatcher, result);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDED_EXTENSIONS.has(ext)) {
        continue;
      }
      if (gitignoreMatcher(relPosix, false)) {
        continue;
      }
      const fileData = await readFileForSnapshot(fullPath);
      if (!fileData) {
        continue;
      }
      result.set(relPosix, {
        contentHash: fileData.hash,
        content: fileData.content,
        isAtHead: false,
      });
    }
  }
}

/**
 * Convert a forward-direction UnifiedDiffHunk[] to a reversed unified diff string
 * that can be passed to Diff.applyPatch() to undo a specific edit without affecting
 * any other edits to the file.
 *
 * Each hunk is reversed by:
 *  - Swapping old/new line counts in the @@ header
 *  - Turning '+' lines into '-' (they're in the current file; we remove them)
 *  - Turning '-' lines into '+' (they were in the old file; we restore them)
 *  - Leaving context lines unchanged
 */
function buildReversePatchString(hunks: UnifiedDiffHunk[]): string {
  let patch = "--- b\n+++ a\n";
  for (const hunk of hunks) {
    // Strip trailing empty context lines (" " — a bare space representing the file's
    // trailing newline). Diff.applyPatch fails on CRLF files when such a line is present
    // because the trailing empty string it implies is not part of jsdiff's line model.
    let lines = hunk.lines;
    let oldLines = hunk.oldLines;
    let newLines = hunk.newLines;
    while (lines.length > 0 && lines[lines.length - 1] === " ") {
      lines = lines.slice(0, -1);
      oldLines--;
      newLines--;
    }

    patch += `@@ -${hunk.newStart},${newLines} +${hunk.oldStart},${oldLines} @@\n`;
    for (const line of lines) {
      if (line.startsWith("+")) {
        patch += "-" + line.slice(1) + "\n";
      } else if (line.startsWith("-")) {
        patch += "+" + line.slice(1) + "\n";
      } else {
        patch += line + "\n";
      }
    }
  }
  return patch;
}

export class WorkspaceSnapshotService {
  async selectStrategy(workspacePath: string): Promise<"git" | "filesystem"> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workspacePath,
      });
      return "git";
    } catch {
      return "filesystem";
    }
  }

  async captureWorkspaceState(
    workspacePath: string,
    strategy: "git" | "filesystem"
  ): Promise<RawWorkspaceState> {
    const capturedAt = Date.now();
    const files = new Map<string, RawFileState>();

    try {
      if (strategy === "git") {
        let stdout = "";
        try {
          const result = await execFileAsync(
            "git",
            ["status", "--porcelain"],
            { cwd: workspacePath }
          );
          stdout = result.stdout;
        } catch (err) {
          Log.warn(`WorkspaceSnapshotService: git status failed: ${err}`);
          return { strategy, files, capturedAt };
        }

        const lines = stdout.split("\n").filter((l) => l.length >= 3);
        for (const line of lines) {
          // Format: XY<space><path> where XY are two status chars
          const xy = line.slice(0, 2);
          let filePath = line.slice(3);
          // Git quotes paths containing special chars
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.slice(1, -1);
          }
          filePath = filePath.replace(/\\/g, "/");
          if (!filePath) {
            continue;
          }

          // isAtHead: true when the file exists in git HEAD (tracked, modified/deleted).
          // False for new/untracked (??) or newly staged (A) files.
          const isAtHead = xy !== "??" && xy[0] !== "A";

          const absPath = path.join(workspacePath, filePath);
          const fileData = await readFileForSnapshot(absPath);
          if (!fileData) {
            continue;
          }
          files.set(filePath, {
            contentHash: fileData.hash,
            content: fileData.content,
            isAtHead,
          });
        }
      } else {
        // filesystem strategy
        const gitignorePath = path.join(workspacePath, ".gitignore");
        const gitignoreMatcher = buildGitignoreMatcher(gitignorePath);
        await walkDirectory(workspacePath, workspacePath, gitignoreMatcher, files);
      }
    } catch (err) {
      Log.warn(`WorkspaceSnapshotService: captureWorkspaceState error: ${err}`);
      return { strategy, files: new Map(), capturedAt };
    }

    return { strategy, files, capturedAt };
  }

  async computeSnapshotChanges(
    before: RawWorkspaceState,
    after: RawWorkspaceState,
    workspacePath: string
  ): Promise<SnapshotFileChange[]> {
    const changes: SnapshotFileChange[] = [];
    const strategy = after.strategy;

    // Files in after: created or modified
    for (const [filePath, afterState] of after.files) {
      const beforeState = before.files.get(filePath);
      if (!beforeState) {
        // File not in before snapshot. Under git strategy, the before snapshot only
        // captures dirty files (git status --porcelain), so absence means the file was
        // clean/at HEAD before the prompt ran. Use isAtHead on the after state to
        // distinguish: tracked file modified from HEAD (isAtHead=true) vs truly new
        // file (isAtHead=false, shown as ?? or A in git status).
        const wasCleanAtHead = strategy === "git" && afterState.isAtHead;
        if (wasCleanAtHead) {
          // Fetch the HEAD content so we can compute a structured patch for reverse-patch undo.
          const change: SnapshotFileChange = {
            path: filePath,
            changeType: "modified" as PromptChangeType,
            afterHash: afterState.contentHash,
          };
          try {
            const { stdout: headContent } = await execFileAsync(
              "git", ["show", `HEAD:${filePath}`],
              { cwd: workspacePath }
            );
            if (afterState.content !== undefined) {
              const patchResult = Diff.structuredPatch("", "", headContent, afterState.content);
              if (patchResult.hunks.length > 0) {
                change.structuredPatch = patchResult.hunks as UnifiedDiffHunk[];
              }
            } else {
              change.contentCaptureSkipped = true;
            }
          } catch {
            change.contentCaptureSkipped = true;
          }
          changes.push(change);
        } else {
          // Truly new file (untracked or newly staged)
          changes.push({
            path: filePath,
            changeType: "created" as PromptChangeType,
            afterHash: afterState.contentHash,
          });
        }
      } else if (afterState.contentHash !== beforeState.contentHash) {
        // Modified during prompt — before-content was captured (file was dirty before prompt)
        const change: SnapshotFileChange = {
          path: filePath,
          changeType: "modified" as PromptChangeType,
          afterHash: afterState.contentHash,
        };
        if (beforeState.content !== undefined && afterState.content !== undefined) {
          const patchResult = Diff.structuredPatch("", "", beforeState.content, afterState.content);
          if (patchResult.hunks.length > 0) {
            change.structuredPatch = patchResult.hunks as UnifiedDiffHunk[];
          }
        } else {
          change.contentCaptureSkipped = true;
        }
        changes.push(change);
      }
      // same hash → skip
    }

    // Files in before but not in after: deleted during prompt
    for (const [filePath, beforeState] of before.files) {
      if (!after.files.has(filePath)) {
        const change: SnapshotFileChange = {
          path: filePath,
          changeType: "deleted" as PromptChangeType,
        };
        if (beforeState.content !== undefined) {
          change.contentToRestore = beforeState.content;
        } else {
          change.contentCaptureSkipped = true;
        }
        changes.push(change);
      }
    }

    return changes;
  }

  async undoFiles(
    files: UndoFileInstruction[],
    workspacePath: string
  ): Promise<UndoResult> {
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ path: string; error: string }> = [];
    const redoInstructions: UndoFileInstruction[] = [];

    for (const instruction of files) {
      const absPath = path.resolve(workspacePath, instruction.path);

      // Security: prevent path traversal.
      // Windows file systems are case-insensitive and drive letters may differ in case
      // between the workspace path and the instruction path (e.g. "c:\..." vs "C:\..."),
      // so compare case-insensitively on Windows. macOS/Linux are case-sensitive, so
      // keep an exact comparison there to avoid incorrectly aliasing distinct paths.
      const resolvedWorkspace = path.resolve(workspacePath);
      const isWindows = process.platform === "win32";
      const normalize = (p: string) => (isWindows ? p.toLowerCase() : p);
      if (
        !normalize(absPath).startsWith(normalize(resolvedWorkspace + path.sep)) &&
        normalize(absPath) !== normalize(resolvedWorkspace)
      ) {
        failedFiles.push({
          path: instruction.path,
          error: "Path traversal detected — skipping",
        });
        continue;
      }

      try {
        // Capture current content before overwriting (for redo)
        let currentContent: string | undefined;
        try {
          currentContent = await fs.promises.readFile(absPath, "utf8");
        } catch {
          // File may not exist (e.g. was deleted by AI); redo will delete it again
        }

        if (instruction.action === "delete") {
          try {
            await fs.promises.unlink(absPath);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              throw err;
            }
            // Missing file is a no-op success
          }
          restoredFiles.push(instruction.path);
          if (currentContent !== undefined) {
            redoInstructions.push({ path: instruction.path, action: "restore-content", contentToRestore: currentContent });
          }
        } else if (instruction.action === "restore-content") {
          const content = instruction.contentToRestore ?? "";
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
          await fs.promises.writeFile(absPath, content, "utf8");
          restoredFiles.push(instruction.path);
          if (currentContent !== undefined) {
            // Compute forward patch (pre-AI → AI-modified) for diff display in redo dialog
            const fwdPatch = Diff.structuredPatch("", "", instruction.contentToRestore ?? "", currentContent);
            const structuredPatch = fwdPatch.hunks.length > 0 ? (fwdPatch.hunks as UnifiedDiffHunk[]) : undefined;
            redoInstructions.push({ path: instruction.path, action: "restore-content", contentToRestore: currentContent, structuredPatch });
          } else {
            // File didn't exist before the AI created it — redo should delete it
            redoInstructions.push({ path: instruction.path, action: "delete" });
          }
        } else if (instruction.action === "reverse-patch") {
          if (!instruction.structuredPatch || instruction.structuredPatch.length === 0) {
            failedFiles.push({ path: instruction.path, error: "No patch data for reverse-patch" });
            continue;
          }
          if (currentContent === undefined) {
            failedFiles.push({ path: instruction.path, error: "File not found" });
            continue;
          }
          const reversePatchStr = buildReversePatchString(instruction.structuredPatch);
          const patched = Diff.applyPatch(currentContent, reversePatchStr);
          if (patched === false) {
            failedFiles.push({
              path: instruction.path,
              error: "Patch did not apply cleanly — the file may have changed since this edit was made",
            });
            continue;
          }
          await fs.promises.writeFile(absPath, patched, "utf8");
          restoredFiles.push(instruction.path);
          // Redo: restore the pre-undo state (what was in the file before we reversed the patch).
          // The forward structuredPatch (before→after AI change) is the original instruction patch.
          redoInstructions.push({ path: instruction.path, action: "restore-content", contentToRestore: currentContent, structuredPatch: instruction.structuredPatch });
        }
      } catch (err) {
        failedFiles.push({
          path: instruction.path,
          error: String(err),
        });
      }
    }

    return { restoredFiles, failedFiles, redoInstructions };
  }

  async hashCurrentFile(
    workspacePath: string,
    relativePath: string
  ): Promise<string | undefined> {
    const absPath = path.join(workspacePath, relativePath);
    const result = await readFileForSnapshot(absPath);
    if (!result) {
      return undefined;
    }
    return result.hash;
  }
}
