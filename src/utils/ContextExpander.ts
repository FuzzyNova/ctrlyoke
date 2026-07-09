import * as path from "path";
import * as fs from "fs/promises";
import {
  FileReference,
  parseAllFileReferences,
  parseGitChangeReferences,
} from "./FileReferenceParser";
import { buildDirectoryAttachmentXml } from "./AttachmentBuilders";
import { isPathWithinAnyDirectory } from "./PathSecurity";
import {
  resolveNamedRelativePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import { Log } from "./Log";
import {
  getCommitDiff,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getStashList,
} from "./GitUtils";
import {
  ATTACHMENT_PREFIXES,
  GIT_CHANGE_KINDS,
} from "../types/DashboardConstants";

/**
 * Result of context splitting — separates direct file references from embedded excerpts.
 * Used by categorized prompt file creation (CLI and Chat harnesses).
 */
export interface SplitContext {
  /** Absolute paths for full-file @path refs — no embedding, harness reads directly */
  directFileRefs: string[];
  /** Embedded XML attachment blocks for selection/sym/git/dir content */
  excerptBlocks: string;
}

/**
 * ContextExpander - Unified context expansion utility
 *
 * Handles all ctrlyoke context reference expansion:
 * - @path/to/file (full file)
 * - @path/to/dir/ (directory listing)
 * - #file:path (full file)
 * - #selection:path:line-line (line range)
 * - #sym:path:symbol:line-line (symbol context)
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
  // Every directory trusted for path-containment checks: the primary
  // workspace root plus any additional trusted roots (e.g. every folder of a
  // multi-root `.code-workspace`, which VS Code does not require to be
  // descendants of the primary root).
  private trustedRoots: string[];
  // Named roots (folder name → path) for folder-name-prefixed multi-root refs
  // (`root2/src/index.ts`), e.g. every folder of a `.code-workspace`.
  private namedRoots: ResolverWorkspaceFolder[];
  // When true, render resolved absolute paths in excerpt descriptions/bodies
  // instead of the as-typed relative ref (attachment ids are unaffected).
  private effectiveAbsolute: boolean;
  // Track attachment IDs to prevent duplicates
  private attachmentIds = new Set<string>();

  constructor(
    workspaceRoot: string,
    additionalTrustedRoots: string[] = [],
    namedRoots: ResolverWorkspaceFolder[] = [],
    effectiveAbsolute: boolean = false
  ) {
    this.workspaceRoot = workspaceRoot;
    this.trustedRoots = Array.from(
      new Set(
        [workspaceRoot, ...additionalTrustedRoots].map((root) =>
          path.resolve(root)
        )
      )
    );
    this.namedRoots = namedRoots;
    this.effectiveAbsolute = effectiveAbsolute;
  }

  /**
   * Mask trigger characters inside triple-backtick fenced blocks so reference
   * parsers treat block contents as literal text.
   */
  private maskBacktickBlocks(text: string): string {
    return text.replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/[@#~]/g, "\x00")
    );
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
      const maskedPromptText = this.maskBacktickBlocks(promptText);

      // Parse all file references from prompt
      const fileReferences = parseAllFileReferences(maskedPromptText);
      const gitRefs = parseGitChangeReferences(maskedPromptText);

      if (fileReferences.length === 0 && gitRefs.length === 0) {
        return promptText; // No attachments needed
      }

      Log.debug(
        `[ContextExpander] Expanding ${fileReferences.length} reference(s): ${fileReferences.map((r) => this.getRefDescription(r)).join(", ")}`
      );

      // Build file attachments in parallel for performance
      const t0 = Date.now();
      const attachmentPromises = fileReferences.map((ref) =>
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
   * Split context references into direct file refs and embedded excerpt blocks.
   *
   * Unlike expandContext() which embeds everything as attachment XML, this method
   * separates references into two categories:
   *
   * - **directFileRefs**: absolute paths for full-file @path refs (no line range, no
   *   directory). The harness auto-reads these — no embedding needed, always correct
   *   line numbers, satisfies read-before-edit constraints.
   *
   * - **excerptBlocks**: embedded XML for content that has no real file path at the
   *   right granularity: #selection, #sym, ~diff/~staged/~stash/~commit, @dir/.
   *   Line numbers are prefixed (format: `    N→content`) for accuracy.
   *
   * @param promptText Original prompt with context references
   * @returns Separated direct file refs and embedded excerpt XML
   */
  async expandContextSplit(promptText: string): Promise<SplitContext> {
    const directFileRefs: string[] = [];
    const excerptParts: string[] = [];

    try {
      const maskedPromptText = this.maskBacktickBlocks(promptText);
      const fileReferences = parseAllFileReferences(maskedPromptText);
      const gitRefs = parseGitChangeReferences(maskedPromptText);

      if (fileReferences.length === 0 && gitRefs.length === 0) {
        return { directFileRefs: [], excerptBlocks: "" };
      }

      for (const ref of fileReferences) {
        const attachmentId = this.getAttachmentId(ref);

        if (this.attachmentIds.has(attachmentId)) {
          Log.debug(`[ContextExpander] Skipping duplicate: ${attachmentId}`);
          continue;
        }
        this.attachmentIds.add(attachmentId);

        if (ref.isDirectory) {
          // Directory listings → excerpt (synthetic, no single file path)
          const xml = await buildDirectoryAttachmentXml(
            ref.path,
            this.workspaceRoot,
            this.trustedRoots,
            this.namedRoots,
            this.effectiveAbsolute
          ).catch((err) => {
            Log.error(
              `[ContextExpander] Failed directory attachment ${ref.path}:`,
              err
            );
            return null;
          });
          if (xml) {
            excerptParts.push(xml);
          }
        } else if (ref.startLine && ref.endLine) {
          // Line ranges (selection/symbol) → excerpt with numbered lines
          const xml = await this.buildAttachmentXml(
            ref.path,
            ref.startLine,
            ref.endLine,
            ref.symbolName
          ).catch((err) => {
            Log.error(
              `[ContextExpander] Failed excerpt attachment ${ref.path}:`,
              err
            );
            return null;
          });
          if (xml) {
            excerptParts.push(xml);
          }
        } else {
          // Full-file ref → return absolute path for direct @-reference (only if it exists)
          try {
            const absolutePath = this.resolveWorkspacePath(ref.path);
            await fs.access(absolutePath);
            directFileRefs.push(absolutePath);
          } catch (err) {
            const suggestion =
              this.namedRoots.length > 1
                ? ` If this file is in a secondary workspace folder, prefix the path with its folder name (e.g. "${this.namedRoots[1].name}/...").`
                : "";
            Log.warn(
              `[ContextExpander] Skipping unreadable or out-of-workspace reference: ${ref.path}.${suggestion}`,
              err
            );
          }
        }
      }

      // Git diffs → excerpt blocks (carry their own line number format)
      const gitAttachments = await this.expandGitChanges(gitRefs);
      excerptParts.push(...gitAttachments);

      return {
        directFileRefs,
        excerptBlocks: excerptParts.join("\n\n"),
      };
    } catch (error) {
      Log.error("[ContextExpander] Error in expandContextSplit:", error);
      return { directFileRefs: [], excerptBlocks: "" };
    }
  }

  /**
   * Rewrite `@file`, `#selection:`, and `#sym:` reference tokens in prompt text
   * so they carry a resolvable path even when the text is sent to the harness
   * as-is (simple-prompt fast path, direct PTY injection) instead of going
   * through {@link expandContextSplit}'s attachment pipeline.
   *
   * Folder-name-prefixed refs (`root2/src/index.ts`, from a multi-root
   * workspace) are only ever resolved by ctrlyoke itself — the harness/model
   * has no idea what "root2" means — so any consumer that doesn't route
   * through the attachment pipeline needs the corrected path inline. This
   * mirrors the `effectiveAbsolute` display-path substitution already done
   * for excerpt descriptions in {@link buildAttachmentXml}, applied to the
   * literal ref token instead of a separate description line.
   *
   * `formatFileRef` additionally lets a CLI provider rewrite the `@`-prefixed
   * form of full-file/directory refs (e.g. Codex, which errors on a literal
   * `@` in file references) — mirrors `CliIntegration.formatDirectFileRef`.
   * `#selection:`/`#sym:` refs never carry an `@` prefix, so `formatFileRef`
   * does not apply to them.
   *
   * Directory refs (`@dir/`) are left untouched — they always route through
   * the excerpt/attachment pipeline (never the simple-prompt fast path) since
   * `expandContextSplit` treats them as excerpt content, so there is no
   * literal-text gap to close for them.
   *
   * Unreadable or out-of-workspace refs are left as-is (same skip-and-log
   * behavior as {@link expandContextSplit}) rather than rewritten into a
   * broken absolute path.
   *
   * @param promptText Original prompt text
   * @param formatFileRef Formats an `@`-ref's already-quoted path into its
   *   final token; defaults to prefixing with `@`.
   */
  async sanitizeReferences(
    promptText: string,
    formatFileRef: (quotedPath: string) => string = (quoted) => `@${quoted}`
  ): Promise<string> {
    try {
      const maskedPromptText = this.maskBacktickBlocks(promptText);
      const refs = parseAllFileReferences(maskedPromptText).filter(
        (ref) =>
          !ref.isDirectory &&
          ref.startOffset !== undefined &&
          ref.endOffset !== undefined
      );
      if (refs.length === 0) {
        return promptText;
      }

      // Replace from the end of the text backwards so earlier offsets stay
      // valid as later (in text order) refs are spliced in.
      const orderedRefs = [...refs].sort(
        (a, b) => b.startOffset! - a.startOffset!
      );

      let result = promptText;
      for (const ref of orderedRefs) {
        const replacement = await this.buildSanitizedReferenceText(
          ref,
          formatFileRef
        );
        if (replacement === null) {
          continue;
        }
        result =
          result.slice(0, ref.startOffset!) +
          replacement +
          result.slice(ref.endOffset!);
      }
      return result;
    } catch (error) {
      Log.error("[ContextExpander] Error in sanitizeReferences:", error);
      return promptText;
    }
  }

  /**
   * Build the corrected inline token for a single reference, or null if the
   * ref should be left untouched (unresolvable, or nothing would change).
   */
  private async buildSanitizedReferenceText(
    ref: FileReference,
    formatFileRef: (quotedPath: string) => string
  ): Promise<string | null> {
    let absolutePath: string;
    try {
      absolutePath = this.resolveWorkspacePath(ref.path);
      await fs.access(absolutePath);
    } catch {
      return null;
    }

    const displayPath = this.effectiveAbsolute ? absolutePath : ref.path;
    const quotedPath = displayPath.includes(" ")
      ? `"${displayPath}"`
      : displayPath;
    const isExcerptRef = !!ref.symbolName || (!!ref.startLine && !!ref.endLine);

    if (isExcerptRef) {
      // #selection:/#sym: never carry an @ prefix, and only the resolved
      // path (not the surrounding syntax) can change.
      if (!this.effectiveAbsolute) {
        return null;
      }
      return ref.symbolName
        ? `#sym:${quotedPath}:${ref.symbolName}:${ref.startLine}-${ref.endLine}`
        : `#selection:${quotedPath}:${ref.startLine}-${ref.endLine}`;
    }

    // Full-file @ ref — always route through formatFileRef so provider-level
    // @ handling (e.g. Codex stripping it) applies even in single-root.
    return formatFileRef(quotedPath);
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
      if (ref.kind === GIT_CHANGE_KINDS.DIFF) {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:${GIT_CHANGE_KINDS.DIFF}`;
      } else if (ref.kind === GIT_CHANGE_KINDS.STAGED) {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:${GIT_CHANGE_KINDS.STAGED}`;
      } else if (ref.kind === GIT_CHANGE_KINDS.STASH) {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:${GIT_CHANGE_KINDS.STASH}:${ref.stashIndex}`;
      } else {
        attachmentId = `${ATTACHMENT_PREFIXES.GIT}:${GIT_CHANGE_KINDS.COMMIT}:${ref.hash}`;
      }

      if (this.attachmentIds.has(attachmentId)) {
        Log.debug(
          `[ContextExpander] Skipping duplicate git attachment: ${attachmentId}`
        );
        continue;
      }
      this.attachmentIds.add(attachmentId);

      try {
        let content: string;
        let title: string;

        if (ref.kind === GIT_CHANGE_KINDS.DIFF) {
          content = await getWorkingTreeDiff(this.workspaceRoot);
          if (!content.trim()) {
            content = "No uncommitted changes in working tree.";
          }
          title = "Working tree changes (git diff)";
        } else if (ref.kind === GIT_CHANGE_KINDS.STAGED) {
          content = await getStagedDiff(this.workspaceRoot);
          if (!content.trim()) {
            content = "No staged changes.";
          }
          title = "Staged changes (git diff --cached)";
        } else if (ref.kind === GIT_CHANGE_KINDS.STASH) {
          const stashes = await getStashList(this.workspaceRoot);
          const stash = stashes[ref.stashIndex!];
          const stashLabel = stash
            ? stash.subject
            : `stash@{${ref.stashIndex}}`;
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
        Log.warn(
          `[ContextExpander] Failed to expand git attachment ${attachmentId}:`,
          err
        );
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
      return buildDirectoryAttachmentXml(
        ref.path,
        this.workspaceRoot,
        this.trustedRoots,
        this.namedRoots,
        this.effectiveAbsolute
      );
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
    const language =
      path.extname(filePath).toLowerCase().slice(1) || "plaintext";

    const t0 = Date.now();
    const rawContent = await fs.readFile(absolutePath, "utf8");
    const elapsed = Date.now() - t0;
    const sizeKb = (Buffer.byteLength(rawContent, "utf8") / 1024).toFixed(1);
    Log.debug(
      `[ContextExpander] Read ${filePath} (${sizeKb} KB) in ${elapsed}ms`
    );

    const displayPath = this.effectiveAbsolute ? absolutePath : filePath;

    // If no line range, attach entire file
    if (!startLine || !endLine) {
      const attachmentId = `file:${filePath}`;
      const description = symbolName
        ? `Symbol: ${symbolName} in ${displayPath}`
        : `File: ${displayPath}`;

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

    Log.debug(
      `[ContextExpander] Sliced ${filePath} lines ${startLine}-${endLine} (${slicedLines.length} lines of ${lines.length})`
    );

    // Prefix each line with its 1-based source line number: "    N→content"
    // This matches Claude Code's own output format and prevents line-number confusion
    // when harnesses try to edit based on embedded excerpt content.
    const numberedLines = slicedLines.map(
      (line, i) => `    ${startLine + i}→${line}`
    );
    const content = numberedLines.join("\n");

    // Build attachment with symbol-aware ID and description
    const attachmentId = symbolName
      ? `symbol:${filePath}:${startLine}-${endLine}`
      : `selection:${filePath}:${startLine}-${endLine}`;
    const description = symbolName
      ? `Symbol: ${symbolName} in ${displayPath}, lines ${startLine} to ${endLine}`
      : `Excerpt from ${displayPath}, lines ${startLine} to ${endLine}`;

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

    // Folder-name-prefixed refs (`root2/src/index.ts`) resolve against that
    // named root; otherwise (and for absolute paths) behaves like
    // path.resolve(workspaceRoot, relativePath) as before.
    const resolved = resolveNamedRelativePath(
      relativePath,
      this.workspaceRoot,
      this.namedRoots
    );

    // Reject `..` traversal and absolute-path references that escape every
    // trusted root — @-references come from prompt/workflow file content,
    // which may not have been authored by the person running it (shared/
    // imported workflows), so this boundary must be enforced regardless of
    // intent. `trustedRoots` includes every open workspace folder, not just
    // the primary root, so multi-root `.code-workspace` references work.
    if (!isPathWithinAnyDirectory(resolved, this.trustedRoots)) {
      throw new Error(
        `Reference "${relativePath}" resolves outside the workspace and was blocked`
      );
    }

    return resolved;
  }
}
