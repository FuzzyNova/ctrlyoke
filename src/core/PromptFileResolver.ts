import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import {
  resolveNamedRelativePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import { looksLikeFilePath } from "../utils/promptPathUtils";

export interface PromptFileResolverOptions {
  workspaceRoot?: string;
  namedRoots?: readonly ResolverWorkspaceFolder[];
}

export type PromptFilePathResolution =
  | {
      status: "missing";
      candidates: readonly string[];
    }
  | {
      status: "unreadable";
      path: string;
      candidates: readonly string[];
      error: unknown;
    }
  | {
      status: "resolved";
      path: string;
      candidates: readonly string[];
    };

export type PromptFileResolution =
  | {
      status: "missing";
      candidates: readonly string[];
    }
  | {
      status: "unreadable";
      path: string;
      candidates: readonly string[];
      error: unknown;
    }
  | {
      status: "empty";
      path: string;
      candidates: readonly string[];
      content: string;
    }
  | {
      status: "resolved";
      path: string;
      candidates: readonly string[];
      content: string;
    };

export class PromptFileReferenceError extends Error {
  constructor(
    message: string,
    readonly resolution: Extract<
      PromptFileResolution,
      { status: "missing" | "unreadable" }
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

  constructor(options: PromptFileResolverOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.namedRoots = options.namedRoots ?? [];
  }

  /** Shared heuristic used by all standalone prompt-file callers. */
  looksLikePromptFilePath(promptValue: string): boolean {
    return looksLikeFilePath(promptValue, {
      allowWorkspaceFolderPrefix: this.namedRoots.length > 1,
    });
  }

  /**
   * Resolve a reference and load its raw content. Whitespace-only content is
   * returned as `empty`; non-empty content is returned as `resolved` without
   * trimming it.
   */
  async resolve(
    filePath: string,
    sourceDefinitionPath?: string
  ): Promise<PromptFileResolution> {
    const candidates = this.getCandidates(filePath, sourceDefinitionPath);
    const readable = await this.findReadableFile(candidates);
    if (readable.status !== "resolved") {
      return readable;
    }

    try {
      const content = await fsp.readFile(readable.path, "utf8");
      return content.trim().length === 0
        ? { ...readable, status: "empty", content }
        : { ...readable, status: "resolved", content };
    } catch (error) {
      return {
        status: "unreadable",
        path: readable.path,
        candidates,
        error,
      };
    }
  }

  /**
   * Resolve a standalone prompt-file reference to its raw content.
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
    if (resolution.status === "resolved" || resolution.status === "empty") {
      return resolution.content;
    }

    const detail =
      resolution.status === "missing"
        ? "could not be found"
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
    return this.findReadableFile(
      this.getCandidatePaths(filePath, sourceDefinitionPath)
    );
  }

  /** Return the ordered candidates used by resolution without touching disk. */
  getCandidatePaths(
    filePath: string,
    sourceDefinitionPath?: string
  ): readonly string[] {
    return this.getCandidates(filePath, sourceDefinitionPath);
  }

  /** Synchronous path-only counterpart for VS Code's synchronous link API. */
  resolvePathSync(
    filePath: string,
    sourceDefinitionPath?: string
  ): PromptFilePathResolution {
    const candidates = this.getCandidatePaths(filePath, sourceDefinitionPath);

    for (const candidate of candidates) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(candidate);
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        return { status: "unreadable", path: candidate, candidates, error };
      }

      if (!stats.isFile()) {
        continue;
      }

      try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return { status: "resolved", path: candidate, candidates };
      } catch (error) {
        return { status: "unreadable", path: candidate, candidates, error };
      }
    }

    return { status: "missing", candidates };
  }

  private getCandidates(
    filePath: string,
    sourceDefinitionPath?: string
  ): string[] {
    const trimmedPath = filePath.trim();
    if (path.isAbsolute(trimmedPath)) {
      return [path.resolve(trimmedPath)];
    }

    const candidates: string[] = [];
    if (sourceDefinitionPath) {
      candidates.push(
        path.resolve(path.dirname(sourceDefinitionPath), trimmedPath)
      );
    }

    if (this.workspaceRoot) {
      candidates.push(
        resolveNamedRelativePath(
          trimmedPath,
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

    return candidates;
  }

  private async findReadableFile(
    candidates: readonly string[]
  ): Promise<PromptFilePathResolution> {
    for (const candidate of candidates) {
      let stats: fs.Stats;
      try {
        stats = await fsp.stat(candidate);
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        return { status: "unreadable", path: candidate, candidates, error };
      }

      if (!stats.isFile()) {
        continue;
      }

      try {
        await fsp.access(candidate, fs.constants.R_OK);
        return { status: "resolved", path: candidate, candidates };
      } catch (error) {
        return { status: "unreadable", path: candidate, candidates, error };
      }
    }

    return { status: "missing", candidates };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
