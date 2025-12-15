import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";

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
  private readonly TEMP_DIR_NAME = ".flightpath";
  private readonly TEMP_SUBDIR_NAME = "temp";
  private readonly PROMPT_EXTENSION = ".prompt.md";
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
      console.error(`Failed to create temp directory: ${err}`);
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
    let basename = "prompt";

    if (originalFilePath) {
      // Extract basename from original file path
      const originalBasename = path.basename(originalFilePath);
      // Remove extensions (.flightpath.json, .prompt.json, .prompt.md)
      basename = originalBasename
        .replace(/\.flightpath\.json$/, "")
        .replace(/\.prompt\.(json|md)$/, "");
    }

    // Add step number if this is a multi-step workflow
    const stepSuffix = stepNumber ? `-${stepNumber}` : "";
    const filename = `${timestamp}-${basename}${stepSuffix}${this.PROMPT_EXTENSION}`;
    const filePath = path.join(this.tempDir, filename);

    // Write file
    try {
      await fs.promises.writeFile(filePath, promptText, "utf-8");
      return filePath;
    } catch (err) {
      console.error(`Failed to write temp prompt file: ${err}`);
      throw new Error(`Cannot write temp file: ${filePath}`);
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
      console.warn(`Failed to delete temp file ${filePath}: ${err}`);
    }
  }

  /**
   * Clean up orphaned temp files older than 24 hours
   * Called on extension activation to prevent temp directory bloat
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

      // Read directory contents
      const files = await fs.promises.readdir(this.tempDir);
      const now = Date.now();

      // Process each file
      for (const file of files) {
        // Only process .prompt.md files
        if (!file.endsWith(this.PROMPT_EXTENSION)) {
          continue;
        }

        const filePath = path.join(this.tempDir, file);

        try {
          // Get file stats
          const stats = await fs.promises.stat(filePath);

          // Delete if older than max age
          if (now - stats.mtimeMs > this.MAX_FILE_AGE_MS) {
            await fs.promises.unlink(filePath);
            cleanedCount++;
            console.log(`🗑️ Cleaned up orphaned temp file: ${file}`);
          }
        } catch (err) {
          // File might have been deleted already - ignore
          console.warn(`Failed to process temp file ${file}: ${err}`);
        }
      }
    } catch (err) {
      // Log error but don't throw - cleanup is best-effort
      console.error(`Temp file cleanup failed: ${err}`);
    }

    return cleanedCount;
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
      console.error(`Failed to get temp dir stats: ${err}`);
      return {
        exists: false,
        fileCount: 0,
        totalSizeBytes: 0,
        oldestFileAgeMs: 0,
      };
    }
  }
}
