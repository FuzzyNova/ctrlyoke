import * as path from "path";
import * as fs from "fs/promises";
import { FileReference, parseAllFileReferences, parseGitChangeReferences } from "./FileReferenceParser";
import {
  resolveSymbol,
  buildDirectoryAttachmentXml,
} from "./AttachmentBuilders";
import { Log } from "./Log";
import {
  getCommitDiff,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getStashList,
} from "./GitUtils";
import { ATTACHMENT_PREFIXES } from "../types/DashboardConstants";


/**
 * ContextExpander - Unified context expansion utility
 *
 * Handles all FlightPath context reference expansion:
 * - @path/to/file (full file)
 * - @path/to/dir/ (directory listing)
 * - #file:path (full file)
 * - #selection:path:line-line (line range)
 * - #sym:path:symbol:line (symbol context)
 *
 * This class consolidates all attachment building logic that was previously
 * scattered across HarnessIntegration and CLI classes. It produces fully-expanded
 * prompt text with all context references resolved to their actual content.
 *
 * DESIGN PRINCIPLES:
 * - Single Responsibility: Only handles context expansion
 * - DRY: All attachment building in one place
 * - No duplication: Used by all CLI integrations
 * - Testable: Pure functions, no side effects
 */
export class ContextExpander {
  private workspaceRoot: string;
  // Track attachment IDs to prevent duplicates
  private attachmentIds = new Set<string>();
  // Cache resolved symbols to avoid redundant VS Code API calls
  // Key: "path:symbolName:line", Value: resolved FileReference
  private symbolResolutionCache = new Map<string, FileReference | null>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Expand all context references in prompt text.
   * Returns fully-expanded prompt with all files/symbols inlined as attachments.
   *
   * @param promptText Original prompt with context references
   * @returns Expanded prompt with attachment XML prepended
   */
  async expandContext(promptText: string): Promise<string> {
    try {
      // Parse all file references from prompt
      let fileReferences = parseAllFileReferences(promptText);
      const gitRefs = parseGitChangeReferences(promptText);

      if (fileReferences.length === 0 && gitRefs.length === 0) {
        return promptText; // No attachments needed
      }

      Log.debug(
        `[ContextExpander] Expanding ${fileReferences.length} reference(s): ${fileReferences.map((r) => this.getRefDescription(r)).join(", ")}`
      );

      // Resolve symbol references to actual file locations
      const resolvedRefs = await this.resolveSymbolReferences(fileReferences);

      // Build file attachments in parallel for performance
      const t0 = Date.now();
      const attachmentPromises = resolvedRefs.map((ref) =>
        this.buildAttachmentForReference(ref).catch((err) => {
          const refDesc = this.getRefDescription(ref);
          Log.error(`Failed to attach ${refDesc}:`, err);
          return null; // Skip failed attachments
        })
      );

      const attachments = await Promise.all(attachmentPromises);
      Log.debug(
        `[ContextExpander] Built ${attachments.length} attachment(s) in ${Date.now() - t0}ms`
      );

      // Filter out nulls (errors) and empty strings (duplicates)
      const validAttachments = attachments.filter(
        (a) => a !== null && a !== ""
      ) as string[];

      const totalBytes = validAttachments.reduce(
        (sum, a) => sum + Buffer.byteLength(a, "utf8"),
        0
      );
      Log.debug(
        `[ContextExpander] Total attachment size: ${(totalBytes / 1024).toFixed(1)} KB across ${validAttachments.length} attachment(s)`
      );

      // Expand git change references (~diff, ~staged, ~stash:N, ~<hash>)
      const gitAttachments = await this.expandGitChanges(gitRefs);

      const allAttachments = [...validAttachments, ...gitAttachments];

      if (allAttachments.length === 0) {
        return promptText; // No valid attachments
      }

      // Prepend attachments to prompt
      const attachmentsSection = allAttachments.join("\n\n");
      return `${attachmentsSection}\n\n${promptText}`;
    } catch (error) {
      Log.error("Error expanding context:", error);
      // Return original prompt on error
      return promptText;
    }
  }

  /**
   * Expand ~diff, ~staged, ~stash:N, and ~<hash> git change references
   * into attachment XML blocks.
   */
  private async expandGitChanges(
    refs: ReturnType<typeof parseGitChangeReferences>
  ): Promise<string[]> {
    const results: string[] = [];

    for (const ref of refs) {
      // Compute attachment id for deduplication
      let attachmentId: string;
      if (ref.kind === "diff") {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:diff`;
      } else if (ref.kind === "staged") {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:staged`;
      } else if (ref.kind === "stash") {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:stash:${ref.stashIndex}`;
      } else {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:commit:${ref.hash}`;
      }

      if (this.attachmentIds.has(attachmentId)) {
        Log.debug(`[ContextExpander] Skipping duplicate git attachment: ${attachmentId}`);
        continue;
      }
      this.attachmentIds.add(attachmentId);

      try {
        let content: string;
        let title: string;

        if (ref.kind === "diff") {
          content = await getWorkingTreeDiff(this.workspaceRoot);
          if (!content.trim()) {
            content = "No uncommitted changes in working tree.";
          }
          title = "Working tree changes (git diff)";
        } else if (ref.kind === "staged") {
          content = await getStagedDiff(this.workspaceRoot);
          if (!content.trim()) {
            content = "No staged changes.";
          }
          title = "Staged changes (git diff --cached)";
        } else if (ref.kind === "stash") {
          const stashes = await getStashList(this.workspaceRoot);
          const stash = stashes[ref.stashIndex!];
          const stashLabel = stash ? stash.subject : `stash@{${ref.stashIndex}}`;
          content = await getStashDiff(this.workspaceRoot, ref.stashIndex!);
          title = `Stash entry ${ref.stashIndex}: ${stashLabel}`;
        } else {
          // commit
          content = await getCommitDiff(this.workspaceRoot, ref.hash!);
          const firstLine = content.split("\n")[0] || ref.hash!;
          title = `Commit ${ref.hash!.slice(0, 7)}: ${firstLine}`;
        }

        results.push(
          `<attachment id="${attachmentId}">\n${title}\n\n\`\`\`diff\n${content}\n\`\`\`\n</attachment>`
        );
      } catch (err) {
        Log.warn(`[ContextExpander] Failed to expand git attachment ${attachmentId}:`, err);
        // Skip on error — never throw
      }
    }

    return results;
  }

  /**
   * Get human-readable description of a file reference
   */
  private getRefDescription(ref: FileReference): string {
    if (ref.symbolName) {
      return `symbol:${ref.symbolName}`;
    }
    if (ref.isDirectory) {
      return `directory:${ref.path}`;
    }
    if (ref.startLine && ref.endLine) {
      return `${ref.path}:${ref.startLine}-${ref.endLine}`;
    }
    return ref.path;
  }

  /**
   * Generate unique attachment ID for deduplication
   * MUST match the attachment ID format used in buildAttachmentXml
   */
  private getAttachmentId(ref: FileReference): string {
    if (ref.isDirectory) {
      // Match format in buildDirectoryAttachmentXml
      const normalizedPath = ref.path.replace(/[\/\\]+$/, "");
      return `directory:${normalizedPath}`;
    }

    if (ref.symbolName && ref.startLine && ref.endLine) {
      // Symbol with line range - use path + lines for uniqueness
      // (same symbol can appear in multiple files or multiple times in same file)
      return `symbol:${ref.path}:${ref.startLine}-${ref.endLine}`;
    }

    if (ref.startLine && ref.endLine) {
      // Line range
      return `file:${ref.path}:${ref.startLine}-${ref.endLine}`;
    }

    // Full file
    return `file:${ref.path}`;
  }

  /**
   * Resolve symbol references to file locations
   * @param fileReferences Array of file references from parseAllFileReferences
   * @returns Array with symbols resolved to actual file locations
   */
  private async resolveSymbolReferences(
    fileReferences: FileReference[]
  ): Promise<FileReference[]> {
    const resolvedRefs: FileReference[] = [];

    for (const ref of fileReferences) {
      if (ref.symbolName) {
        // Symbol reference - build full reference string for resolveSymbol
        // Format: path/to/file.ts:SymbolName:123
        const symbolRef = `${ref.path}:${ref.symbolName}:${ref.startLine}`;

        // Check cache first to avoid expensive re-resolution
        let resolved: FileReference | null;
        if (this.symbolResolutionCache.has(symbolRef)) {
          resolved = this.symbolResolutionCache.get(symbolRef)!;
          Log.debug(`Using cached resolution for: ${symbolRef}`);
        } else {
          // Not in cache - resolve and cache the result
          resolved = await resolveSymbol(symbolRef);
          this.symbolResolutionCache.set(symbolRef, resolved);
        }

        if (resolved) {
          resolvedRefs.push(resolved);
        } else {
          Log.warn(`Could not resolve symbol: ${symbolRef}`);
        }
      } else {
        // Regular file/directory reference
        resolvedRefs.push(ref);
      }
    }

    return resolvedRefs;
  }

  /**
   * Build attachment XML for a single file reference
   * Routes to appropriate builder based on reference type
   */
  private async buildAttachmentForReference(
    ref: FileReference
  ): Promise<string> {
    // Generate attachment ID for deduplication
    const attachmentId = this.getAttachmentId(ref);

    // Skip if already attached
    if (this.attachmentIds.has(attachmentId)) {
      Log.debug(`Skipping duplicate attachment: ${attachmentId}`);
      return ""; // Return empty string for duplicates
    }

    // Mark as attached
    this.attachmentIds.add(attachmentId);

    if (ref.isDirectory) {
      // Directory reference - build tree structure
      return buildDirectoryAttachmentXml(ref.path, this.workspaceRoot);
    } else {
      // File reference (full file, line range, or symbol)
      return this.buildAttachmentXml(
        ref.path,
        ref.startLine,
        ref.endLine,
        ref.symbolName
      );
    }
  }

  /**
   * Build attachment XML for a file or file excerpt.
   *
   * Uses fs.readFile directly instead of vscode.workspace.openTextDocument to
   * avoid loading large files into VS Code's text model (which triggers tokenization,
   * language server activation, etc. and can deadlock the extension host for large files).
   *
   * @param filePath Workspace-relative file path
   * @param startLine Optional start line (1-indexed)
   * @param endLine Optional end line (1-indexed)
   * @param symbolName Optional symbol name (for #sym: references)
   */
  private async buildAttachmentXml(
    filePath: string,
    startLine?: number,
    endLine?: number,
    symbolName?: string
  ): Promise<string> {
    const absolutePath = this.resolveWorkspacePath(filePath);
    const language = path.extname(filePath).toLowerCase().slice(1) || "plaintext";

    const t0 = Date.now();
    const rawContent = await fs.readFile(absolutePath, "utf8");
    const elapsed = Date.now() - t0;
    const sizeKb = (Buffer.byteLength(rawContent, "utf8") / 1024).toFixed(1);
    Log.debug(
      `[ContextExpander] Read ${filePath} (${sizeKb} KB) in ${elapsed}ms`
    );

    // If no line range, attach entire file
    if (!startLine || !endLine) {
      const attachmentId = `file:${filePath}`;
      const description = symbolName
        ? `Symbol: ${symbolName} in ${filePath}`
        : `File: ${filePath}`;

      return `<attachment id="${attachmentId}">
${description}
\`\`\`${language}
${rawContent}
\`\`\`
</attachment>`;
    }

    // Extract line range (0-indexed slice)
    const lines = rawContent.split("\n");
    const slicedLines = lines.slice(startLine - 1, endLine);
    const content = slicedLines.join("\n");

    Log.debug(
      `[ContextExpander] Sliced ${filePath} lines ${startLine}-${endLine} (${slicedLines.length} lines of ${lines.length})`
    );

    // Build attachment with symbol-aware ID and description
    const attachmentId = symbolName
      ? `symbol:${filePath}:${startLine}-${endLine}`
      : `selection:${filePath}:${startLine}-${endLine}`;
    const description = symbolName
      ? `Symbol: ${symbolName} in ${filePath}, lines ${startLine} to ${endLine}`
      : `Excerpt from ${filePath}, lines ${startLine} to ${endLine}`;

    return `<attachment id="${attachmentId}">
${description}:
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
  }

  /**
   * Resolve relative path to absolute workspace path
   * Uses Node.js path.resolve for cross-platform compatibility
   */
  private resolveWorkspacePath(relativePath: string): string {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    // path.resolve handles both absolute and relative paths correctly
    // If relativePath is already absolute, it returns it as-is
    // If relative, it joins with workspaceRoot
    return path.resolve(this.workspaceRoot, relativePath);
  }
}
