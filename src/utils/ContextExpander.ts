import * as path from "path";
import * as fs from "fs/promises";
import {
  FileReference,
  maskFencedCodeBlocks,
  parseAllFileReferences,
  parseAtReferences,
  parseGitChangeReferences,
} from "./FileReferenceParser";
import { buildDirectoryAttachmentXml } from "./AttachmentBuilders";
import { estimateImageTokens } from "./ImageTokenEstimator";
import {
  estimateFileTokens,
  type FileTokenEstimate,
} from "./FileTokenEstimator";
import {
  isPathWithinAnyDirectory,
  isPathWithinDirectory,
} from "./PathSecurity";
import {
  resolveReferencePath,
  type ReferencePathResolution,
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
import { resolveSourceRuntimeArtifacts } from "./SourceRuntimeArtifactResolver";
import {
  ATTACHMENT_PREFIXES,
  GIT_CHANGE_KINDS,
  isImageRefPath,
} from "../types/DashboardConstants";
import { getErrorMessage } from "./ErrorUtils";
import { quoteReferenceField } from "../completions/ContextReferenceBuilder";

/**
 * Result of context splitting — separates direct file references from embedded excerpts.
 * Used by categorized prompt file creation (CLI and Chat harnesses).
 */
export interface SplitContext {
  /** Absolute paths for full-file @path refs — no embedding, harness reads directly */
  directFileRefs: string[];
  /** Embedded XML attachment blocks for selection/sym/git/dir content */
  excerptBlocks: string;
  /**
   * References that were dropped instead of embedded — unresolvable/blocked
   * paths, unreadable files, or a failed attachment build. Every one of these
   * previously vanished from the outgoing prompt with only a debug/warn log
   * line; callers must surface them as a real diagnostic so a reference that
   * silently produced zero content is never mistaken for "nothing to attach."
   */
  skippedReferences: SkippedReference[];
}

export interface SkippedReference {
  /** The reference exactly as it appeared in the prompt text. */
  ref: string;
  /** Human-readable reason the reference could not be attached. */
  reason: string;
}

export interface ContextExpanderOptions {
  workspaceRoot: string;
  additionalTrustedRoots?: string[];
  namedRoots?: ResolverWorkspaceFolder[];
  effectiveAbsolute?: boolean;
  sourceDefinitionDir?: string;
  allowWorkflowRelativeReferences?: boolean;
  sourceCheckoutRoot?: string;
  executionCheckoutRoot?: string;
}

/**
 * ContextExpander - Unified context expansion utility
 *
 * Handles all ctrlyoke context reference expansion:
 * - @path/to/file (full file)
 * - @path/to/dir/ (directory listing)
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
  // Workflow-relative inline references use this directory as their only
  // resolution base. It is discarded when it is outside the trusted roots.
  private sourceDefinitionDir?: string;
  private allowWorkflowRelativeReferences: boolean;
  private readonly sourceCheckoutRoot?: string;
  private readonly executionCheckoutRoot: string;
  private readonly sourceRuntimeResolutions = new Map<
    string,
    ReferencePathResolution
  >();
  private readonly preparedSourceRuntimeReferences = new Set<string>();
  // Track attachment IDs to prevent duplicates
  private attachmentIds = new Set<string>();

  constructor(options: ContextExpanderOptions) {
    const {
      workspaceRoot,
      additionalTrustedRoots = [],
      namedRoots = [],
      effectiveAbsolute = false,
      sourceDefinitionDir,
      allowWorkflowRelativeReferences = true,
      sourceCheckoutRoot,
      executionCheckoutRoot = workspaceRoot,
    } = options;
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
    this.allowWorkflowRelativeReferences = allowWorkflowRelativeReferences;
    this.sourceCheckoutRoot = sourceCheckoutRoot;
    this.executionCheckoutRoot = executionCheckoutRoot;
    const resolvedSourceDefinitionDir = sourceDefinitionDir
      ? path.resolve(sourceDefinitionDir)
      : undefined;
    this.sourceDefinitionDir =
      resolvedSourceDefinitionDir &&
      isPathWithinAnyDirectory(resolvedSourceDefinitionDir, this.trustedRoots)
        ? resolvedSourceDefinitionDir
        : undefined;
  }

  /**
   * Mask trigger characters inside triple-backtick fenced blocks so reference
   * parsers treat block contents as literal text.
   */
  private maskBacktickBlocks(text: string): string {
    return maskFencedCodeBlocks(text);
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

      await this.prepareSourceRuntimeResolutions(fileReferences);

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
          this.logAttachmentBuildFailure(this.getRefDescription(ref), err);
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
   * If `rawRef` is a full-file `@` reference to an image that exists within a
   * trusted root, return a pixel-area-based token estimate for it; otherwise
   * return null so the caller falls back to normal text tokenization.
   *
   * Images must never be tokenized as raw file bytes — a small PNG icon reads
   * as thousands of "tokens" of binary garbage. Vision models bill by pixel
   * area instead (see {@link estimateImageTokens}).
   */
  async estimateImageReferenceTokens(rawRef: string): Promise<number | null> {
    const ref = parseAtReferences(this.maskBacktickBlocks(rawRef))[0];
    if (!ref || ref.isDirectory || !isImageRefPath(ref.path)) {
      return null;
    }
    try {
      await this.prepareSourceRuntimeResolutions([ref]);
      const absolutePath = this.resolveWorkspacePath(ref.path);
      await fs.access(absolutePath);
      return estimateImageTokens(absolutePath);
    } catch {
      // Unreadable / out-of-workspace — let the normal path handle (and log) it.
      return null;
    }
  }

  /**
   * If `rawRef` is a bare full-file `@` reference (no line range, not a
   * directory), return its token estimate via {@link estimateFileTokens};
   * otherwise return null so the caller falls back to `expandContext`'s
   * attachment-XML tokenization for directory/selection/symbol/git refs.
   *
   * This is the same full-file reference category the dry-run preview calls
   * "Tier 1" and treats identically — see `CliPromptPreparer`'s use of the
   * same `estimateFileTokens` helper — so the live editor count and the
   * dry-run total agree for these references.
   */
  async estimateFileReferenceTokens(
    rawRef: string
  ): Promise<FileTokenEstimate | null> {
    const ref = parseAtReferences(this.maskBacktickBlocks(rawRef))[0];
    if (!ref || ref.isDirectory) {
      return null;
    }
    try {
      await this.prepareSourceRuntimeResolutions([ref]);
      const absolutePath = this.resolveWorkspacePath(ref.path);
      return await estimateFileTokens(absolutePath);
    } catch {
      // Unreadable / out-of-workspace — let the normal path handle (and log) it.
      return null;
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
    const skippedReferences: SkippedReference[] = [];

    try {
      const maskedPromptText = this.maskBacktickBlocks(promptText);
      const fileReferences = parseAllFileReferences(maskedPromptText);
      const gitRefs = parseGitChangeReferences(maskedPromptText);

      await this.prepareSourceRuntimeResolutions(fileReferences);

      if (fileReferences.length === 0 && gitRefs.length === 0) {
        return { directFileRefs: [], excerptBlocks: "", skippedReferences: [] };
      }

      for (const ref of fileReferences) {
        let attachmentId: string;
        try {
          attachmentId = this.getAttachmentId(ref);
        } catch (err) {
          const reason = getErrorMessage(err);
          Log.warn(
            `[ContextExpander] Skipping unresolvable reference: ${ref.path}.`,
            err
          );
          skippedReferences.push({ ref: ref.path, reason });
          continue;
        }

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
            this.effectiveAbsolute,
            this.sourceDefinitionDir
          ).catch((err) => {
            Log.error(
              `[ContextExpander] Failed directory attachment ${ref.path}:`,
              err
            );
            skippedReferences.push({
              ref: ref.path,
              reason: getErrorMessage(err),
            });
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
            skippedReferences.push({
              ref: ref.path,
              reason: getErrorMessage(err),
            });
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
            skippedReferences.push({
              ref: ref.path,
              reason: `${getErrorMessage(err)}${suggestion}`,
            });
          }
        }
      }

      // Git diffs → excerpt blocks (carry their own line number format)
      const gitAttachments = await this.expandGitChanges(gitRefs);
      excerptParts.push(...gitAttachments);

      return {
        directFileRefs,
        excerptBlocks: excerptParts.join("\n\n"),
        skippedReferences,
      };
    } catch (error) {
      Log.error("[ContextExpander] Error in expandContextSplit:", error);
      return { directFileRefs: [], excerptBlocks: "", skippedReferences: [] };
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
      const allRefs = parseAllFileReferences(maskedPromptText);
      await this.prepareSourceRuntimeResolutions(allRefs);
      const refs = allRefs.filter(
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
    let resolution: ReferencePathResolution;
    let absolutePath: string;
    try {
      resolution = this.resolveReference(ref.path);
      absolutePath = resolution.absolutePath;
      await fs.access(absolutePath);
    } catch (err) {
      Log.debug(
        `[ContextExpander] Skipping unresolvable reference: ${ref.path}.`,
        err
      );
      return null;
    }

    // Workflow-relative paths must leave ctrlyoke as absolute paths because
    // harness CLIs run from the workspace root, not the workflow directory.
    // Absolute output is unambiguous even when the workflow lives elsewhere.
    const displayPath =
      resolution.base === "workflow" || this.effectiveAbsolute
        ? absolutePath
        : ref.path;
    const quotedPath = displayPath.includes(" ")
      ? `"${displayPath}"`
      : displayPath;
    const isExcerptRef = !!ref.symbolName || (!!ref.startLine && !!ref.endLine);

    if (isExcerptRef) {
      // #selection:/#sym: never carry an @ prefix, and only the resolved
      // path (not the surrounding syntax) can change.
      if (!this.effectiveAbsolute && resolution.base !== "workflow") {
        return null;
      }
      // Not `quotedPath`: these are colon-delimited fields, and effectiveAbsolute
      // means displayPath is absolute — on Windows `C:\dev\a.ts`, whose drive
      // colon made the rewritten token unparseable by every ctrlyoke parser
      // because space-only quoting left it bare.
      const fieldPath = quoteReferenceField(displayPath);
      if (ref.symbolName) {
        // Keep this reconstruction byte-for-byte compatible with the existing
        // effectiveAbsolute output: buildSymbolReferenceValue normalizes
        // backslashes, while this path intentionally preserves native absolute
        // paths for the harness. Only the parsed kind is newly carried across.
        const kindSuffix = ref.symbolKind ? `.${ref.symbolKind}` : "";
        return `#sym${kindSuffix}:${fieldPath}:${quoteReferenceField(ref.symbolName)}:${ref.startLine}-${ref.endLine}`;
      }
      return `#selection:${fieldPath}:${ref.startLine}-${ref.endLine}`;
    }

    // Full-file @ ref — always route through formatFileRef so provider-level
    // @ handling (e.g. Codex stripping it) applies even in single-root.
    return formatFileRef(quotedPath);
  }

  /**
   * Precompute source-side runtime resolutions for one parsed prompt. The
   * predicate is asynchronous, so resolveReference consumes this cache rather
   * than spawning Git from any synchronous resolution path.
   */
  private async prepareSourceRuntimeResolutions(
    refs: readonly FileReference[]
  ): Promise<void> {
    if (!this.sourceCheckoutRoot) {
      return;
    }

    const candidatePathByReference = new Map<string, string>();
    for (const ref of refs) {
      if (
        ref.isDirectory ||
        this.preparedSourceRuntimeReferences.has(ref.path)
      ) {
        continue;
      }
      try {
        const tier1Resolution = resolveReferencePath(ref.path, {
          primaryRoot: this.workspaceRoot,
          namedRoots: this.namedRoots,
          sourceDefinitionDir: this.sourceDefinitionDir,
        });
        const candidatePath = isPathWithinDirectory(
          tier1Resolution.absolutePath,
          this.executionCheckoutRoot
        )
          ? path.relative(
              this.executionCheckoutRoot,
              tier1Resolution.absolutePath
            )
          : ref.path;
        candidatePathByReference.set(ref.path, candidatePath);
      } catch {
        // resolveReference will preserve the existing error for this ref.
      }
    }
    if (candidatePathByReference.size === 0) {
      return;
    }

    const resolutions = await resolveSourceRuntimeArtifacts(
      this.sourceCheckoutRoot,
      this.executionCheckoutRoot,
      new Set(candidatePathByReference.values())
    );
    for (const [referencePath, candidatePath] of candidatePathByReference) {
      const absolutePath = resolutions.get(candidatePath);
      if (absolutePath) {
        this.sourceRuntimeResolutions.set(referencePath, {
          absolutePath,
          base: "sourceRuntimeStore",
        });
      }
    }
    for (const referencePath of candidatePathByReference.keys()) {
      this.preparedSourceRuntimeReferences.add(referencePath);
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
   * A missing attachment is expected while the editor requests token counts
   * for an in-progress @ reference. Keep that high-frequency case in debug
   * logs, while preserving warnings for unexpected attachment failures.
   */
  private logAttachmentBuildFailure(reference: string, error: unknown): void {
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = getErrorMessage(error);
    const isUnreadableReference =
      errorCode === "ENOENT" ||
      errorCode === "ENOTDIR" ||
      errorCode === "EISDIR";

    if (isUnreadableReference) {
      Log.debug(
        `[ContextExpander] Skipping unreadable attachment ${reference}: ${message}`
      );
      return;
    }

    Log.warn(`[ContextExpander] Failed to attach ${reference}: ${message}`);
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

    const resolvedPath = this.resolveReference(ref.path).absolutePath;

    if (ref.symbolName && ref.startLine && ref.endLine) {
      // Symbol with line range - use path + lines for uniqueness
      // (same symbol can appear in multiple files or multiple times in same file)
      return `symbol:${resolvedPath}:${ref.startLine}-${ref.endLine}`;
    }

    if (ref.startLine && ref.endLine) {
      // Line range
      return `file:${resolvedPath}:${ref.startLine}-${ref.endLine}`;
    }

    // Full file
    return `file:${resolvedPath}`;
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
        this.effectiveAbsolute,
        this.sourceDefinitionDir
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
    return this.resolveReference(relativePath).absolutePath;
  }

  /**
   * Resolve a reference and apply the workspace containment policy.
   * Resolution selects the lexical base; it does not authorize the result.
   */
  private resolveReference(relativePath: string): ReferencePathResolution {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    const normalizedPath = relativePath.replace(/\\/g, "/");
    if (
      !this.allowWorkflowRelativeReferences &&
      (normalizedPath.startsWith("./") || normalizedPath.startsWith("../"))
    ) {
      throw new Error(
        `Workflow-relative reference "${relativePath}" cannot be mapped into the execution checkout`
      );
    }

    const resolution = resolveReferencePath(relativePath, {
      primaryRoot: this.workspaceRoot,
      namedRoots: this.namedRoots,
      sourceDefinitionDir: this.sourceDefinitionDir,
    });
    const sourceRuntimeResolution =
      this.sourceRuntimeResolutions.get(relativePath);
    if (sourceRuntimeResolution) {
      return sourceRuntimeResolution;
    }
    const resolved = resolution.absolutePath;

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

    return resolution;
  }
}
