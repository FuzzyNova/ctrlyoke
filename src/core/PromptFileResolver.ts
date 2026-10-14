import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import {
  getTrustedSourceDefinitionDir,
  resolveNamedRelativePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import { evaluateFileAccess } from "../utils/FileAccessPolicy";
import { looksLikeFilePath } from "../utils/promptPathUtils";
import { resolveSourceRuntimeArtifacts } from "../utils/SourceRuntimeArtifactResolver";
import { getCtrlYokeFileKind } from "../completions/CtrlYokeFileKind";
import { getPromptMarkdownText } from "../utils/MarkdownFrontmatter";
import {
  CTRLYOKE_FILE_KINDS,
  PROMPT_FILE_RESOLUTION_STATUSES,
} from "../types/DashboardConstants";

export interface PromptFileResolverOptions {
  workspaceRoot?: string;
  namedRoots?: readonly ResolverWorkspaceFolder[];
  /** Workspace and external roots used to authorize candidates before reads. */
  trustedRoots?: readonly string[];
  /** ctrlyoke-owned state roots allowed for UI prompt-file reads. */
  ownStateRoots?: readonly string[];
  /** Source checkout used for ignored runtime-artifact reads during execution. */
  sourceCheckoutRoot?: string;
  approvedExternalRoots?: readonly string[];
  /** Disable workflow-relative refs when the authored definition is unmappable. */
  allowWorkflowRelativeReferences?: boolean;
}

export type PromptFilePathResolution =
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.MISSING;
      candidates: readonly string[];
    }
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE;
      path: string;
      candidates: readonly string[];
      error: unknown;
    }
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED;
      path: string;
      candidates: readonly string[];
    };

export type PromptFileResolution =
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.MISSING;
      candidates: readonly string[];
    }
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE;
      path: string;
      candidates: readonly string[];
      error: unknown;
    }
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.EMPTY;
      path: string;
      candidates: readonly string[];
      content: string;
    }
  | {
      status: typeof PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED;
      path: string;
      candidates: readonly string[];
      content: string;
    };

export class PromptFileReferenceError extends Error {
  constructor(
    message: string,
    readonly resolution: Extract<
      PromptFileResolution,
      {
        status:
          | typeof PROMPT_FILE_RESOLUTION_STATUSES.MISSING
          | typeof PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE;
      }
    >
  ) {
    super(message);
    this.name = "PromptFileReferenceError";
  }
}

/**
 * Resolves standalone prompt-file references for Node-side consumers.
 *
 * The workspace inputs are deliberately plain values so this class can be
 * used by the parser, dashboard adapter, CLI, MCP server, and unit tests
 * without importing VS Code.
 */
export class PromptFileResolver {
  private readonly workspaceRoot?: string;
  private readonly namedRoots: readonly ResolverWorkspaceFolder[];
  private readonly trustedRoots?: readonly string[];
  private readonly ownStateRoots?: readonly string[];
  private readonly sourceCheckoutRoot?: string;
  private readonly approvedExternalRoots?: readonly string[];
  private readonly allowWorkflowRelativeReferences: boolean;

  constructor(options: PromptFileResolverOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.namedRoots = options.namedRoots ?? [];
    this.trustedRoots = options.trustedRoots;
    this.ownStateRoots = options.ownStateRoots;
    this.sourceCheckoutRoot = options.sourceCheckoutRoot;
    this.approvedExternalRoots = options.approvedExternalRoots;
    this.allowWorkflowRelativeReferences =
      options.allowWorkflowRelativeReferences ?? true;
  }

  /** Shared heuristic used by all standalone prompt-file callers. */
  looksLikePromptFilePath(promptValue: string): boolean {
    return looksLikeFilePath(promptValue, {
      allowWorkspaceFolderPrefix: this.namedRoots.length > 1,
    });
  }

  /**
   * Resolve a reference and load its prompt text. Whitespace-only text is
   * returned as `empty`; non-empty text is returned as `resolved` without
   * trimming it, except a `.prompt.md` file, whose frontmatter is removed and
   * whose body is trimmed exactly as when the file runs on its own.
   */
  async resolve(
    filePath: string,
    sourceDefinitionPath?: string
  ): Promise<PromptFileResolution> {
    const candidates = this.getCandidates(filePath, sourceDefinitionPath, true);
    const readable = await this.findReadableFile(
      candidates,
      this.getSourceRuntimeFallbackCandidate(
        filePath,
        sourceDefinitionPath,
        candidates
      )
    );
    if (readable.status !== PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED) {
      return readable;
    }

    try {
      const raw = await fsp.readFile(readable.path, "utf8");
      const content =
        getCtrlYokeFileKind(readable.path) ===
        CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
          ? getPromptMarkdownText(raw)
          : raw;
      return content.trim().length === 0
        ? {
            ...readable,
            status: PROMPT_FILE_RESOLUTION_STATUSES.EMPTY,
            content,
          }
        : {
            ...readable,
            status: PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED,
            content,
          };
    } catch (error) {
      return {
        status: PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE,
        path: readable.path,
        candidates,
        error,
      };
    }
  }

  /**
   * Resolve a standalone prompt-file reference to its prompt text.
   *
   * Literal prompt text passes through unchanged. A path that looks like an
   * intentional prompt-file reference must resolve successfully; missing and
   * unreadable references are never returned as literal prompt text.
   */
  async resolvePromptValue(
    promptValue: string,
    sourceDefinitionPath?: string
  ): Promise<string> {
    if (!this.looksLikePromptFilePath(promptValue)) {
      return promptValue;
    }

    const reference = promptValue.trim();
    const resolution = await this.resolve(reference, sourceDefinitionPath);
    if (
      resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED ||
      resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.EMPTY
    ) {
      return resolution.content;
    }

    const detail =
      resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.MISSING
        ? (getLegacyRunHistoryReferenceGuidance(reference) ??
          "could not be found")
        : `could not be read: ${getErrorMessage(resolution.error)}`;
    throw new PromptFileReferenceError(
      `Prompt file reference "${reference}" ${detail}`,
      resolution
    );
  }

  /** Validate a statically resolvable reference without changing its value. */
  async validatePromptReference(
    promptValue: string,
    sourceDefinitionPath?: string
  ): Promise<void> {
    if (
      !this.looksLikePromptFilePath(promptValue) ||
      promptValue.includes("{{")
    ) {
      return;
    }

    await this.resolvePromptValue(promptValue, sourceDefinitionPath);
  }

  /** Resolve only the path, including regular-file and readability checks. */
  async resolvePath(
    filePath: string,
    sourceDefinitionPath?: string
  ): Promise<PromptFilePathResolution> {
    const candidates = this.getCandidatePaths(filePath, sourceDefinitionPath);
    return this.findReadableFile(
      candidates,
      this.getSourceRuntimeFallbackCandidate(
        filePath,
        sourceDefinitionPath,
        candidates
      )
    );
  }

  /** Return the ordered candidates used by resolution without touching disk. */
  getCandidatePaths(
    filePath: string,
    sourceDefinitionPath?: string,
    includeSourceRuntimeCandidate = true
  ): readonly string[] {
    return this.getCandidates(
      filePath,
      sourceDefinitionPath,
      includeSourceRuntimeCandidate
    );
  }

  /** Synchronous path-only counterpart for VS Code's synchronous link API. */
  resolvePathSync(
    filePath: string,
    sourceDefinitionPath?: string
  ): PromptFilePathResolution {
    const candidates = this.getCandidatePaths(
      filePath,
      sourceDefinitionPath,
      false
    );

    for (const candidate of candidates) {
      if (!this.isCandidateAllowed(candidate)) {
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = fs.statSync(candidate);
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        return {
          status: PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE,
          path: candidate,
          candidates,
          error,
        };
      }

      if (!stats.isFile()) {
        continue;
      }

      try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return {
          status: PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED,
          path: candidate,
          candidates,
        };
      } catch (error) {
        return {
          status: PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE,
          path: candidate,
          candidates,
          error,
        };
      }
    }

    return { status: PROMPT_FILE_RESOLUTION_STATUSES.MISSING, candidates };
  }

  private getCandidates(
    filePath: string,
    sourceDefinitionPath?: string,
    includeSourceRuntimeCandidate = false
  ): string[] {
    const trimmedPath = filePath.trim();
    if (path.isAbsolute(trimmedPath)) {
      return [path.resolve(trimmedPath)];
    }

    const candidates: string[] = [];
    const normalizedPath = trimmedPath.replace(/\\/g, "/");
    if (
      !this.allowWorkflowRelativeReferences &&
      (normalizedPath.startsWith("./") || normalizedPath.startsWith("../"))
    ) {
      return candidates;
    }
    const sourceDefinitionDir = getTrustedSourceDefinitionDir(
      sourceDefinitionPath,
      this.trustedRoots
    );
    // This source-dir-then-workspace probing order is deliberate. Prompt-file
    // completion inserts `./` plus a workspace-relative path, so making `./`
    // source-dir-only would break completion-inserted references whose target
    // is not a sibling of the workflow file.
    if (sourceDefinitionDir) {
      candidates.push(path.resolve(sourceDefinitionDir, trimmedPath));
    }

    if (this.workspaceRoot) {
      // Lone prompt paths retain their established source-dir-then-workspace
      // semantics. Strip only the mandatory `./` marker in this wrapper so
      // it can still name a workspace-relative or named-root prompt; the
      // shared resolver must keep `./` workflow-relative for inline refs.
      const normalizedWorkspacePath = normalizedPath;
      const workspacePath = normalizedWorkspacePath.replace(/^\.\//, "");
      candidates.push(
        workspacePath.startsWith("../")
          ? path.resolve(this.workspaceRoot, trimmedPath)
          : resolveNamedRelativePath(
              workspacePath,
              this.workspaceRoot,
              this.namedRoots
            )
      );
      candidates.push(
        path.resolve(
          this.workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          trimmedPath
        )
      );
    }

    if (includeSourceRuntimeCandidate) {
      const sourceRuntimeCandidate =
        this.getSourceRuntimeCandidate(trimmedPath);
      if (
        sourceRuntimeCandidate !== undefined &&
        !candidates.includes(sourceRuntimeCandidate)
      ) {
        candidates.push(sourceRuntimeCandidate);
      }
    }

    return candidates;
  }

  private async findReadableFile(
    candidates: readonly string[],
    sourceRuntimeFallbackCandidate?: string
  ): Promise<PromptFilePathResolution> {
    for (const candidate of candidates) {
      const allowed = await this.isCandidateAllowedAsync(
        candidate,
        candidate === sourceRuntimeFallbackCandidate
      );
      if (!allowed) {
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = await fsp.stat(candidate);
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        return {
          status: PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE,
          path: candidate,
          candidates,
          error,
        };
      }

      if (!stats.isFile()) {
        continue;
      }

      try {
        await fsp.access(candidate, fs.constants.R_OK);
        return {
          status: PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED,
          path: candidate,
          candidates,
        };
      } catch (error) {
        return {
          status: PROMPT_FILE_RESOLUTION_STATUSES.UNREADABLE,
          path: candidate,
          candidates,
          error,
        };
      }
    }

    return { status: PROMPT_FILE_RESOLUTION_STATUSES.MISSING, candidates };
  }

  private getSourceRuntimeCandidate(trimmedPath: string): string | undefined {
    if (!this.sourceCheckoutRoot) {
      return undefined;
    }

    return path.isAbsolute(trimmedPath)
      ? path.resolve(trimmedPath)
      : path.resolve(this.sourceCheckoutRoot, trimmedPath);
  }

  private getSourceRuntimeFallbackCandidate(
    filePath: string,
    sourceDefinitionPath: string | undefined,
    candidates: readonly string[]
  ): string | undefined {
    const trimmedPath = filePath.trim();
    if (path.isAbsolute(trimmedPath)) {
      return undefined;
    }

    const sourceRuntimeCandidate = this.getSourceRuntimeCandidate(trimmedPath);
    const standardCandidates = this.getCandidates(
      filePath,
      sourceDefinitionPath,
      false
    );
    return sourceRuntimeCandidate !== undefined &&
      candidates.includes(sourceRuntimeCandidate) &&
      !standardCandidates.includes(sourceRuntimeCandidate)
      ? sourceRuntimeCandidate
      : undefined;
  }

  private async isCandidateAllowedAsync(
    candidate: string,
    requireSourceRuntimeQualification: boolean
  ): Promise<boolean> {
    if (
      !requireSourceRuntimeQualification &&
      this.isCandidateAllowed(candidate)
    ) {
      return true;
    }

    if (!this.sourceCheckoutRoot || !this.workspaceRoot) {
      return false;
    }

    // An unavailable predicate means "not a source runtime artifact", never a
    // thrown resolution: callers expect PromptFileReferenceError for a prompt
    // that cannot be resolved, not a raw Git failure.
    try {
      const sourceRuntimeArtifacts = await resolveSourceRuntimeArtifacts(
        this.sourceCheckoutRoot,
        this.workspaceRoot,
        new Set([candidate])
      );
      return sourceRuntimeArtifacts.has(candidate);
    } catch {
      return false;
    }
  }

  private isCandidateAllowed(candidate: string): boolean {
    if (
      this.trustedRoots === undefined &&
      this.approvedExternalRoots === undefined
    ) {
      // Unit tests and CLI-only callers without a workspace intentionally
      // omit roots, preserving the resolver's historical behavior.
      return true;
    }

    return evaluateFileAccess(candidate, {
      workspaceRoots: this.trustedRoots ?? [],
      ownStateRoots: this.ownStateRoots,
      approvedExternalRoots: this.approvedExternalRoots ?? [],
    }).allowed;
  }
}

/** Explain how to address moved run history without embedding a local path. */
export function getLegacyRunHistoryReferenceGuidance(
  reference: string
): string | undefined {
  const normalized = reference.trim().replace(/^@/, "").replace(/\\/g, "/");
  const legacyPrefix = [".ctrlyoke/.runs", "./.ctrlyoke/.runs"];
  if (
    !legacyPrefix.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
    )
  ) {
    return undefined;
  }

  return "run history is not a workspace file; use priorContext: { workflow, run } to reference a completed run";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
