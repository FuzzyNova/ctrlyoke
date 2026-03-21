import * as path from "path";
import * as fs from "fs";
import { Log } from "./Log";
import { PATH_CONSTANTS } from "./ConfigurationUtils";

/**
 * TempFileManager - Manages temporary prompt files in .flightpath/temp/
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
  private readonly TEMP_DIR_NAME = PATH_CONSTANTS.FLIGHTPATH_DIR;
  private readonly TEMP_SUBDIR_NAME = PATH_CONSTANTS.TEMP_DIR;
  private readonly PROMPT_EXTENSION = ".prompt.md";
  private readonly MCP_CONFIG_PREFIX = "mcp-config";
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
   * Get the temp directory path
   */
  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Ensure temp directory exists
   * Creates .flightpath/temp/ if needed
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
   * @param originalFilePath Optional path to original .flightpath.json or .prompt.md file
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
   * @param originalFilePath Optional path to original .flightpath file
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
   *   createCategoryFile(content, 'agent', 'path/to/my-flow.flightpath.yaml', 1, 2)
   *   → "1234567890-my-flow-1.agent.2.prompt.md"
   *
   *   createCategoryFile(content, 'skills', 'path/to/my-flow.flightpath.yaml', 1)
   *   → "1234567890-my-flow-1.skills.prompt.md"
   *
   * @param content File content to write
   * @param category Content category ('agent' | 'skills' | 'excerpts' | 'prompt')
   * @param originalFilePath Optional path to original workflow file (for meaningful names)
   * @param stepNumber Optional 1-based step number
   * @param partNumber Optional 1-based part number for split files
   * @returns Absolute path to created file
   */
  async createCategoryFile(
    content: string,
    category: "agent" | "skills" | "excerpts" | "prompt",
    originalFilePath?: string,
    stepNumber?: number,
    partNumber?: number
  ): Promise<string> {
    await this.ensureTempDir();
    const timestamp = Math.floor(Date.now() / 1000);
    const basename = originalFilePath
      ? this.sanitizeBasename(originalFilePath)
      : "prompt";
    const stepSuffix = stepNumber ? `-${stepNumber}` : "";
    const categorySuffix = category === "prompt" ? "" : `.${category}`;
    const partSuffix = partNumber !== undefined ? `.${partNumber}` : "";
    const filename = `${timestamp}-${basename}${stepSuffix}${categorySuffix}${partSuffix}${this.PROMPT_EXTENSION}`;
    const filePath = path.join(this.tempDir, filename);
    try {
      await fs.promises.writeFile(filePath, content, "utf-8");
      return filePath;
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
   *   "1234-my-flow-1.agent.1.prompt.md"
   *   "1234-my-flow-1.agent.2.prompt.md"
   *
   * @param chunks Array of content chunks
   * @param category Content category ('agent' | 'excerpts')
   * @param originalFilePath Optional path to original workflow file
   * @param stepNumber Optional 1-based step number
   * @returns Array of absolute file paths
   */
  async createCategorySplitFiles(
    chunks: string[],
    category: "agent" | "excerpts",
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
          // Only process known top-level temp file types
          const file = entry.name;
          const isTempFile =
            file.endsWith(this.PROMPT_EXTENSION) ||
            file.startsWith(this.MCP_CONFIG_PREFIX);
          if (!isTempFile) {
            continue;
          }

          const filePath = path.join(this.tempDir, file);
          try {
            const stats = await fs.promises.stat(filePath);
            if (now - stats.mtimeMs > this.MAX_FILE_AGE_MS) {
              await fs.promises.unlink(filePath);
              cleanedCount++;
              Log.info(`🗑️ Cleaned up orphaned temp file: ${file}`);
            }
          } catch (err) {
            Log.warn(`Failed to process temp file ${file}: ${err}`);
          }
        }
      }
    } catch (err) {
      // Log error but don't throw - cleanup is best-effort
      Log.error(`Temp file cleanup failed: ${err}`);
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
            Log.info(
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
   * @param originalFilePath Path to original .flightpath or .prompt file
   * @returns Sanitized basename suitable for temp file naming
   */
  private sanitizeBasename(originalFilePath: string): string {
    const originalBasename = path.basename(originalFilePath);
    return (
      originalBasename
        .replace(/\.flightpath\.(json|yaml|yml)$/, "")
        .replace(/\.prompt\.(json|md)$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "prompt"
    );
  }

  /**
   * Get workspace-relative path for a temp file
   * Used when sending @file references to CLI
   *
   * @param absolutePath Absolute path to temp file
   * @returns Workspace-relative path (e.g., ".flightpath/temp/prompt-xxx.txt")
   */
  getRelativePath(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath);
  }

  /**
   * Get statistics about temp directory
   * Useful for debugging and monitoring
   */
  async getStats(): Promise<{
    exists: boolean;
    fileCount: number;
    totalSizeBytes: number;
    oldestFileAgeMs: number;
  }> {
    try {
      // Check if directory exists
      try {
        await fs.promises.access(this.tempDir);
      } catch {
        return {
          exists: false,
          fileCount: 0,
          totalSizeBytes: 0,
          oldestFileAgeMs: 0,
        };
      }

      const files = await fs.promises.readdir(this.tempDir);
      let fileCount = 0;
      let totalSize = 0;
      let oldestAge = 0;
      const now = Date.now();

      for (const file of files) {
        if (!file.endsWith(this.PROMPT_EXTENSION)) {
          continue;
        }

        const filePath = path.join(this.tempDir, file);
        try {
          const stats = await fs.promises.stat(filePath);
          fileCount++;
          totalSize += stats.size;
          const age = now - stats.mtimeMs;
          if (age > oldestAge) {
            oldestAge = age;
          }
        } catch {
          // Ignore files we can't stat
        }
      }

      return {
        exists: true,
        fileCount,
        totalSizeBytes: totalSize,
        oldestFileAgeMs: oldestAge,
      };
    } catch (err) {
      Log.error(`Failed to get temp dir stats: ${err}`);
      return {
        exists: false,
        fileCount: 0,
        totalSizeBytes: 0,
        oldestFileAgeMs: 0,
      };
    }
  }
}
