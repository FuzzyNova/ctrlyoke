import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { Log } from "./Log";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { TempFileCategory } from "../types/DashboardConstants";

/**
 * TempFileManager - Manages temporary prompt files in .ctrlyoke/temp/
 *
 * Handles:
 * - Creating temp directory structure
 * - Writing prompt files with unique names
 * - Cleanup of individual files after execution
 * - Cleanup of orphaned files on extension activation
 *
 * DESIGN PRINCIPLES:
 * - Single Responsibility: Only manages temp files
 * - No side effects: Explicit cleanup calls
 * - Graceful failures: Never throw on cleanup
 */
export class TempFileManager {
  private readonly TEMP_DIR_NAME = PATH_CONSTANTS.CTRLYOKE_DIR;
  private readonly TEMP_SUBDIR_NAME = PATH_CONSTANTS.TEMP_DIR;
  private readonly PROMPT_EXTENSION = ".prompt.md";
  private readonly MCP_CONFIG_PREFIX = "mcp-config";
  private readonly AGY_STATUSLINE_PREFIX = "agy-statusline-";
  private readonly CLAUDE_STATUSLINE_PREFIX = "claude-statusline-";
  // Filename marker for pasted images. Kept in the name (not just the extension)
  // so the temp orphan sweep can target these regardless of image extension
  // without allow-listing arbitrary binary files a user may have dropped in temp.
  private readonly PASTED_IMAGE_PREFIX = "pasted-image-";
  private readonly MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  private workspaceRoot: string;
  private tempDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.tempDir = path.join(
      workspaceRoot,
      this.TEMP_DIR_NAME,
      this.TEMP_SUBDIR_NAME
    );
  }

  /**
   * The single, flat directory all pasted images are written to:
   * `.ctrlyoke/attachments/`.
   *
   * Deliberately flat (not grouped per workflow) and used for *every* paste,
   * saved or unsaved. Combined with content-addressed filenames from
   * `createPastedImageFile()`, this makes the folder a content store: identical
   * bytes always resolve to the same path, so a given image is stored **once**
   * and deduped across every workflow that references it.
   *
   * A sibling of `temp/`, and like it **gitignored** — but for a different
   * reason. `temp/` is swept per turn; this store persists. It is ignored
   * because most of what lands here belongs to ephemeral run work (debug
   * screenshots pasted mid-conversation), and one directory cannot be both
   * ignored for those and tracked for the assets of a durable workflow. Save As
   * resolves it: exporting a workflow copies the assets it actually references
   * into a tracked sibling `<workflow>.assets/` and rewrites the references, so
   * the exported artifact is self-contained without this store ever being
   * committed. Un-ignoring it would commit every unrelated paste and still not
   * make an export complete. See `ui.instructions.md` ("Save As owns bundle
   * portability").
   */
  getAttachmentsDir(): string {
    return path.join(
      this.workspaceRoot,
      this.TEMP_DIR_NAME,
      PATH_CONSTANTS.ATTACHMENTS_DIR
    );
  }

  /**
   * Ensure temp directory exists
   * Creates .ctrlyoke/temp/ if needed
   */
  async ensureTempDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.tempDir, { recursive: true });
    } catch (err) {
      Log.error(`Failed to create temp directory: ${err}`);
      throw new Error(`Cannot create temp directory: ${this.tempDir}`);
    }
  }

  /**
   * Create a temporary prompt file with useful name for debugging
   * Returns absolute path to the created file
   *
   * Format:
   * - Single prompt: <timestamp>-<original-filename>.prompt.md
   * - Multi-step workflow: <timestamp>-<original-filename>-<step>.prompt.md
   *
   * @param promptText The full prompt text (with expanded context)
   * @param originalFilePath Optional path to original .ctrlyoke.json or .prompt.md file
   * @param stepNumber Optional step number for multi-step workflows (1-indexed)
   * @returns Absolute path to temp file
   */
  async createPromptFile(
    promptText: string,
    originalFilePath?: string,
    stepNumber?: number
  ): Promise<string> {
    // Ensure directory exists
    await this.ensureTempDir();

    // Build useful filename
    const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
    const basename = originalFilePath
      ? this.sanitizeBasename(originalFilePath)
      : "prompt";

    // Add step number if this is a multi-step workflow
    const stepSuffix = stepNumber ? `-${stepNumber}` : "";
    const filename = `${timestamp}-${basename}${stepSuffix}${this.PROMPT_EXTENSION}`;
    const filePath = path.join(this.tempDir, filename);

    // Write file
    try {
      await fs.promises.writeFile(filePath, promptText, "utf-8");
      return filePath;
    } catch (err) {
      Log.error(`Failed to write temp prompt file: ${err}`);
      throw new Error(`Cannot write temp file: ${filePath}`);
    }
  }

  /**
   * Create multiple prompt files for a split prompt
   * Returns array of absolute paths in order
   *
   * Format:
   * - Single chunk: <timestamp>-<basename>-<step>.prompt.md
   * - Split files: <timestamp>-<basename>-<step>.1.prompt.md
   *               <timestamp>-<basename>-<step>.2.prompt.md
   *               <timestamp>-<basename>-<step>.3.prompt.md
   *
   * @param chunks Array of prompt text chunks
   * @param originalFilePath Optional path to original .ctrlyoke file
   * @param stepNumber Optional step number for multi-step workflows (1-indexed)
   * @returns Array of absolute file paths
   */
  async createSplitPromptFiles(
    chunks: string[],
    originalFilePath?: string,
    stepNumber?: number
  ): Promise<string[]> {
    // Validate input
    if (!chunks || chunks.length === 0) {
      throw new Error("Cannot create split files: no chunks provided");
    }

    // Filter out empty chunks
    const validChunks = chunks.filter((chunk) => chunk.trim().length > 0);
    if (validChunks.length === 0) {
      throw new Error("Cannot create split files: all chunks are empty");
    }

    // Ensure directory exists
    await this.ensureTempDir();

    // Build base filename
    const timestamp = Math.floor(Date.now() / 1000);
    const basename = originalFilePath
      ? this.sanitizeBasename(originalFilePath)
      : "prompt";

    const stepSuffix = stepNumber ? `-${stepNumber}` : "";
    const filePaths: string[] = [];

    // Create files with cleanup on partial failure
    try {
      for (let i = 0; i < validChunks.length; i++) {
        // Add split index only if there are multiple chunks
        const splitIndex = validChunks.length > 1 ? `.${i + 1}` : "";
        const filename = `${timestamp}-${basename}${stepSuffix}${splitIndex}${this.PROMPT_EXTENSION}`;
        const filePath = path.join(this.tempDir, filename);

        await fs.promises.writeFile(filePath, validChunks[i], "utf-8");
        filePaths.push(filePath);
      }

      return filePaths;
    } catch (err) {
      // Clean up any files created before the error
      Log.error(`Failed to create split prompt files: ${err}`);
      await this.deleteFiles(filePaths); // Clean up partial files
      throw new Error(
        `Cannot create split temp files: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Create a single categorized temp file with a typed filename.
   *
   * File naming: `<ts>-<sanitized-name>[-<step>].<category>[.<part>].prompt.md`
   *
   * Examples:
   *   createCategoryFile(content, 'agent', 'path/to/my-flow.ctrlyoke.yaml', 1, 2)
   *   → "1234567890-my-flow-1.agent.2.prompt.md"
   *
   *   createCategoryFile(content, 'skills', 'path/to/my-flow.ctrlyoke.yaml', 1)
   *   → "1234567890-my-flow-1.skills.prompt.md"
   *
   * @param content File content to write
   * @param category Content category ('agent' | 'secrets' | 'skills' | 'excerpts' | 'prompt')
   * @param originalFilePath Optional path to original workflow file (for meaningful names)
   * @param stepNumber Optional 1-based step number
   * @param partNumber Optional 1-based part number for split files
   * @returns Absolute path to created file
   */
  async createCategoryFile(
    content: string,
    category: TempFileCategory,
    originalFilePath?: string,
    stepNumber?: number,
    partNumber?: number
  ): Promise<string> {
    await this.ensureTempDir();
    const filePath = this.getCategoryFilePath(
      category,
      originalFilePath,
      stepNumber,
      partNumber
    );
    await this.writeCategoryFile(filePath, content);
    return filePath;
  }

  /**
   * Return the path a categorized file would use without touching the file
   * system. The caller can pass the result to writeCategoryFile later.
   */
  getCategoryFilePath(
    category: TempFileCategory,
    originalFilePath?: string,
    stepNumber?: number,
    partNumber?: number,
    timestamp = Math.floor(Date.now() / 1000)
  ): string {
    const basename = originalFilePath
      ? this.sanitizeBasename(originalFilePath)
      : "prompt";
    const stepSuffix = stepNumber ? `-${stepNumber}` : "";
    const partSuffix = partNumber !== undefined ? `.${partNumber}` : "";
    const filename = `${timestamp}-${basename}${stepSuffix}.${category}${partSuffix}.md`;
    return path.join(this.tempDir, filename);
  }

  /** Write a previously planned categorized file at its exact planned path. */
  async writeCategoryFile(filePath: string, content: string): Promise<void> {
    await this.ensureTempDir();
    try {
      await fs.promises.writeFile(filePath, content, "utf-8");
    } catch (err) {
      Log.error(`Failed to write category temp file: ${err}`);
      throw new Error(`Cannot write category temp file: ${filePath}`);
    }
  }

  /**
   * Create multiple categorized temp files for a split content section.
   * Returns array of absolute paths in order.
   *
   * File naming for split files uses 1-based part numbers:
   *   "1234-my-flow-1.agent.1.md"
   *   "1234-my-flow-1.agent.2.md"
   *
   * @param chunks Array of content chunks
   * @param category Content category ('agent' | 'excerpts')
   * @param originalFilePath Optional path to original workflow file
   * @param stepNumber Optional 1-based step number
   * @returns Array of absolute file paths
   */
  async createCategorySplitFiles(
    chunks: string[],
    category: TempFileCategory,
    originalFilePath?: string,
    stepNumber?: number
  ): Promise<string[]> {
    if (!chunks || chunks.length === 0) {
      throw new Error("Cannot create category split files: no chunks provided");
    }
    const validChunks = chunks.filter((c) => c.trim().length > 0);
    if (validChunks.length === 0) {
      throw new Error(
        "Cannot create category split files: all chunks are empty"
      );
    }

    const filePaths: string[] = [];
    try {
      for (let i = 0; i < validChunks.length; i++) {
        // Single chunk omits the part number (same as createSplitPromptFiles behaviour)
        const partNumber = validChunks.length > 1 ? i + 1 : undefined;
        const filePath = await this.createCategoryFile(
          validChunks[i],
          category,
          originalFilePath,
          stepNumber,
          partNumber
        );
        filePaths.push(filePath);
      }
      return filePaths;
    } catch (err) {
      Log.error(`Failed to create category split files: ${err}`);
      await this.deleteFiles(filePaths);
      throw new Error(
        `Cannot create category split temp files: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Write a pasted clipboard image to disk using a content-addressed filename.
   *
   * The filename is derived from the SHA-256 of the image bytes
   * (`pasted-image-<hash12>.<ext>`), so identical images collapse to a single
   * file: pasting the same image N times yields one file and N references to it,
   * and a paste byte-identical to an existing file reuses that file. Because all
   * pastes target the one flat `.ctrlyoke/attachments/` folder (see
   * {@link getAttachmentsDir}), this dedup is **global** — the same image pasted
   * into any number of different workflows is stored exactly once.
   *
   * On a dedup hit the file's mtime is refreshed via `utimes()`. Harmless for the
   * never-swept attachments folder; it matters only if a caller ever points this
   * at `.ctrlyoke/temp/` (e.g. the embedded-image stretch), where the 24h orphan
   * sweep is mtime-based and could otherwise reap a still-referenced file.
   *
   * @param data Decoded image bytes
   * @param extension Image extension without a dot (e.g. "png", "jpg")
   * @param targetDir Absolute destination directory (normally the attachments dir)
   * @returns Absolute path to the written (or reused) file
   */
  async createPastedImageFile(
    data: Buffer,
    extension: string,
    targetDir: string
  ): Promise<string> {
    await fs.promises.mkdir(targetDir, { recursive: true });
    const hash = crypto
      .createHash("sha256")
      .update(data)
      .digest("hex")
      .slice(0, 12);
    const filename = `${this.PASTED_IMAGE_PREFIX}${hash}.${extension}`;
    const filePath = path.join(targetDir, filename);

    try {
      // Dedup hit: file already exists — skip the write, refresh mtime so a
      // temp-fallback file isn't reaped by the orphan sweep while still referenced.
      await fs.promises.access(filePath);
      const now = new Date();
      await fs.promises.utimes(filePath, now, now).catch(() => {
        // Best-effort mtime refresh; ignore failures.
      });
      return filePath;
    } catch {
      // Not present — write raw bytes (no encoding).
      try {
        await fs.promises.writeFile(filePath, data);
        return filePath;
      } catch (err) {
        Log.error(`Failed to write pasted image file: ${err}`);
        throw new Error(`Cannot write pasted image file: ${filePath}`);
      }
    }
  }

  /**
   * Delete a specific temp file
   * Does not throw on failure (logs error instead)
   *
   * @param filePath Absolute path to file to delete
   */
  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      // Log but don't throw - cleanup is best-effort
      Log.warn(`Failed to delete temp file ${filePath}: ${err}`);
    }
  }

  /**
   * Delete multiple temp files
   * Does not throw on failure (logs warnings for individual failures)
   *
   * @param filePaths Array of absolute paths to files to delete
   */
  async deleteFiles(filePaths: string[]): Promise<void> {
    await Promise.all(filePaths.map((fp) => this.deleteFile(fp)));
  }

  /**
   * Clean up orphaned temp files older than 24 hours.
   * Called on extension activation to prevent temp directory bloat.
   *
   * Cleans two categories:
   * - Top-level prompt files (*.prompt.md) and MCP config files
   * - Notification JSON files in subdirectories (claude-notifications/, copilot-notifications/, etc.)
   *
   * @returns Number of files cleaned up
   */
  async cleanupOrphanedFiles(): Promise<number> {
    let cleanedCount = 0;

    try {
      // Check if temp directory exists
      try {
        await fs.promises.access(this.tempDir);
      } catch {
        // Directory doesn't exist - nothing to clean
        return 0;
      }

      const entries = await fs.promises.readdir(this.tempDir, {
        withFileTypes: true,
      });
      const now = Date.now();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Clean notification subdirectories (claude-notifications/, copilot-notifications/, etc.)
          const subdir = path.join(this.tempDir, entry.name);
          cleanedCount += await this.cleanupOrphanedNotificationDir(
            subdir,
            now
          );
        } else {
          // Only process known top-level temp file types. Pasted images are
          // matched by the `pasted-image-` marker (regardless of extension)
          // rather than by allow-listing image extensions, so unrelated binary
          // files a user dropped in temp are never swept.
          const file = entry.name;
          const isTempFile =
            file.endsWith(".md") ||
            file.startsWith(this.MCP_CONFIG_PREFIX) ||
            file.startsWith(this.PASTED_IMAGE_PREFIX) ||
            file.startsWith(this.AGY_STATUSLINE_PREFIX) ||
            file.startsWith(this.CLAUDE_STATUSLINE_PREFIX);
          if (!isTempFile) {
            continue;
          }

          const filePath = path.join(this.tempDir, file);
          try {
            const stats = await fs.promises.stat(filePath);
            if (now - stats.mtimeMs > this.MAX_FILE_AGE_MS) {
              await fs.promises.unlink(filePath);
              cleanedCount++;
              Log.trace(`🗑️ Cleaned up orphaned temp file: ${file}`);
            }
          } catch (err) {
            Log.warn(`Failed to process temp file ${file}: ${err}`);
          }
        }
      }
    } catch (err) {
      // Log error but don't throw - cleanup is best-effort
      Log.warn(`Temp file cleanup failed: ${err}`);
    }

    return cleanedCount;
  }

  /**
   * Clean up orphaned JSON notification files in a notification subdirectory.
   * Only deletes files older than MAX_FILE_AGE_MS to avoid interfering with
   * any concurrently running workflows.
   */
  private async cleanupOrphanedNotificationDir(
    dirPath: string,
    now: number
  ): Promise<number> {
    let cleanedCount = 0;
    try {
      const files = await fs.promises.readdir(dirPath);
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(dirPath, file);
        try {
          const stats = await fs.promises.stat(filePath);
          if (now - stats.mtimeMs > this.MAX_FILE_AGE_MS) {
            await fs.promises.unlink(filePath);
            cleanedCount++;
            Log.trace(
              `🗑️ Cleaned up orphaned notification file: ${path.basename(dirPath)}/${file}`
            );
          }
        } catch (err) {
          Log.warn(`Failed to process notification file ${file}: ${err}`);
        }
      }
    } catch (err) {
      Log.warn(`Failed to clean notification dir ${dirPath}: ${err}`);
    }
    return cleanedCount;
  }

  /**
   * Sanitize basename from original file path for use in temp file names
   * Removes file extensions and special characters for CLI compatibility
   *
   * Matches PromptQueue.generateWorkingFilePath() sanitization approach:
   * - Lowercase for consistency
   * - Non-alphanumeric chars → hyphens
   * - Strip leading/trailing hyphens
   *
   * @param originalFilePath Path to original .ctrlyoke or .prompt file
   * @returns Sanitized basename suitable for temp file naming
   */
  private sanitizeBasename(originalFilePath: string): string {
    const originalBasename = path.basename(originalFilePath);
    return (
      originalBasename
        .replace(/\.ctrlyoke\.(json|yaml|yml)$/, "")
        .replace(/\.prompt\.(json|md)$/, "")
        .toLowerCase()
        // Strip ISO-style datetime suffix appended by generateWorkingFilePath
        // e.g. "new-workflow-2026-03-25t03-25-06" → "new-workflow"
        .replace(/-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}$/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "prompt"
    );
  }

  /**
   * Get workspace-relative path for a temp file
   * Used when sending @file references to CLI
   *
   * @param absolutePath Absolute path to temp file
   * @returns Workspace-relative path (e.g., ".ctrlyoke/temp/prompt-xxx.txt")
   */
  getRelativePath(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath);
  }
}
