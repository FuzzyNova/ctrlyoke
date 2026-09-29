import * as path from "path";
import {
  isPathWithinAnyDirectory,
  isPathWithinDirectory,
} from "../utils/PathSecurity";
import { pathsEqual } from "../utils/PathCasing";
import { REFERENCE_PATH_BASES } from "../types/DashboardConstants";

/**
 * A workspace folder reduced to the fields the resolver needs.
 * Mirrors the relevant parts of `vscode.WorkspaceFolder` without importing
 * the `vscode` module, so the resolver stays unit-testable in isolation.
 */
export interface ResolverWorkspaceFolder {
  /** Folder display name (`vscode.WorkspaceFolder.name`). */
  name: string;
  /** Absolute filesystem path (`vscode.WorkspaceFolder.uri.fsPath`). */
  fsPath: string;
}

/**
 * Inputs to {@link resolveWorkspaceRoot}. Every field is a plain value so the
 * resolution order can be exercised by unit tests without a `vscode` instance.
 */
export interface WorkspaceRootResolverInput {
  /**
   * Value of the native `ctrlyoke.workspaceDirectory` setting. Empty,
   * whitespace, or `undefined` means "unset — auto-detect".
   */
  setting?: string;
  /**
   * Absolute path of the directory that contains the `.code-workspace` file
   * (i.e. `dirname(workspace.workspaceFile.fsPath)`), but ONLY when
   * `workspace.workspaceFile.scheme === "file"`. Pass `undefined` for the
   * single-folder case and for unsaved (`untitled:`) multi-root workspaces.
   */
  workspaceFileDir?: string;
  /** Workspace folders in order (`workspace.workspaceFolders`). */
  workspaceFolders?: readonly ResolverWorkspaceFolder[];
  /**
   * Fallback used when no folder is open (CLI / no workspace). Defaults to
   * `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Expand `${workspaceFolder}` and `${workspaceFolder:Name}` references in a
 * setting value. VS Code does NOT expand variables in arbitrary string
 * settings (only in `launch.json`/`tasks.json`), so we do it ourselves for
 * ergonomics. Unknown folder names are left untouched.
 */
function expandWorkspaceFolderVars(
  value: string,
  folders: readonly ResolverWorkspaceFolder[]
): string {
  return value.replace(
    /\$\{workspaceFolder(?::([^}]+))?\}/g,
    (match, name: string | undefined) => {
      if (name) {
        const found = folders.find((f) => f.name === name);
        return found ? found.fsPath : match;
      }
      return folders[0]?.fsPath ?? match;
    }
  );
}

/**
 * Resolve the directory that contains the `.ctrlyoke` folder for the current
 * window. The result is window-stable and must be computed in exactly one place
 * (this function) so every consumer agrees on the location.
 *
 * Resolution order:
 *
 * 1. `ctrlyoke.workspaceDirectory` setting, if set — used as-is when
 *    absolute, otherwise resolved against the `.code-workspace` dir (if any),
 *    else the first workspace folder, else `cwd`. Supports `${workspaceFolder}`
 *    and `${workspaceFolder:Name}` expansion.
 * 2. The `.code-workspace` file's directory, when one is open on disk.
 * 3. The first workspace folder (single-folder case — today's behavior).
 * 4. `cwd` (`process.cwd()` by default) — CLI / no folder open.
 */
export function resolveWorkspaceRoot(
  input: WorkspaceRootResolverInput
): string {
  const cwd = input.cwd ?? process.cwd();
  const folders = input.workspaceFolders ?? [];
  const firstFolder = folders[0]?.fsPath;

  // 1. Explicit native setting (highest precedence).
  const setting = input.setting?.trim();
  if (setting) {
    const expanded = expandWorkspaceFolderVars(setting, folders);
    if (path.isAbsolute(expanded)) {
      return path.normalize(expanded);
    }
    // Relative: resolve against the .code-workspace dir if present, else the
    // first folder, else cwd.
    const base = input.workspaceFileDir ?? firstFolder ?? cwd;
    return path.resolve(base, expanded);
  }

  // 2. .code-workspace file directory (saved multi-root workspace).
  if (input.workspaceFileDir) {
    return input.workspaceFileDir;
  }

  // 3. First workspace folder (single-folder case).
  if (firstFolder) {
    return firstFolder;
  }

  // 4. CLI / no folder open.
  return cwd;
}

/**
 * Resolve every directory that should be trusted as "inside the workspace"
 * for path-containment checks (e.g. `@file` prompt references) — the primary
 * `.ctrlyoke` root from {@link resolveWorkspaceRoot} plus every open workspace
 * folder.
 *
 * This matters for multi-root `.code-workspace` setups: the primary root is
 * often just the directory containing the `.code-workspace` file (or an
 * explicit `ctrlyoke.workspaceDirectory` override), which is not guaranteed to
 * be an ancestor of the actual folders — VS Code does not require multi-root
 * folders to live under a common parent. Without this, a legitimate `@file`
 * reference into a second workspace folder would be wrongly treated as
 * "outside the workspace."
 */
export function resolveTrustedWorkspaceRoots(
  input: WorkspaceRootResolverInput
): string[] {
  const primary = path.normalize(resolveWorkspaceRoot(input));
  const folderPaths = (input.workspaceFolders ?? []).map((folder) =>
    path.normalize(folder.fsPath)
  );
  return Array.from(new Set([primary, ...folderPaths]));
}

export type ReferencePathBase =
  (typeof REFERENCE_PATH_BASES)[keyof typeof REFERENCE_PATH_BASES];

export interface ReferencePathResolutionOptions {
  primaryRoot: string;
  namedRoots: readonly ResolverWorkspaceFolder[];
  /** Directory containing the authored workflow definition, when trusted. */
  sourceDefinitionDir?: string;
}

export interface ReferencePathResolution {
  absolutePath: string;
  base: ReferencePathBase;
}

export interface ExecutionDefinitionPathMapping {
  /** The definition path as seen from the execution checkout, when mappable. */
  executionPath?: string;
  /** Whether `./` and `../` references may use the definition directory. */
  allowWorkflowRelativeReferences: boolean;
}

/**
 * Map a persisted, state-side workflow definition into an execution checkout
 * without touching the filesystem. Untracked authored definitions are still
 * mappable because containment is lexical, not existence-based.
 *
 * With no distinct checkout pair this is the identity mapping. A definition
 * outside the source checkout has no safe execution-side directory, so its
 * workflow-relative references are deliberately disabled.
 */
export function mapSourceDefinitionPathToExecution(
  sourceDefinitionPath: string | undefined,
  sourceCheckoutRoot: string | undefined,
  executionCheckoutRoot: string | undefined
): ExecutionDefinitionPathMapping {
  if (!sourceDefinitionPath) {
    return { allowWorkflowRelativeReferences: true };
  }

  if (
    !sourceCheckoutRoot ||
    !executionCheckoutRoot ||
    pathsEqual(
      path.resolve(sourceCheckoutRoot),
      path.resolve(executionCheckoutRoot)
    )
  ) {
    return {
      executionPath: sourceDefinitionPath,
      allowWorkflowRelativeReferences: true,
    };
  }

  const sourcePath = path.resolve(sourceDefinitionPath);
  const sourceRoot = path.resolve(sourceCheckoutRoot);
  if (!isPathWithinDirectory(sourcePath, sourceRoot)) {
    return { allowWorkflowRelativeReferences: false };
  }

  return {
    executionPath: path.resolve(
      executionCheckoutRoot,
      path.relative(sourceRoot, sourcePath)
    ),
    allowWorkflowRelativeReferences: true,
  };
}

/**
 * Resolve a reference path against exactly one lexical base without touching
 * the filesystem. A leading `./` or `../` requires a known workflow-file
 * location; it throws instead of falling back to the workspace because that
 * fallback can silently select the wrong file. Callers should surface the
 * error as an unresolvable reference, just as they do for blocked references.
 */
export function resolveReferencePath(
  referencePath: string,
  options: ReferencePathResolutionOptions
): ReferencePathResolution {
  if (path.isAbsolute(referencePath)) {
    return {
      absolutePath: path.resolve(referencePath),
      base: REFERENCE_PATH_BASES.ABSOLUTE,
    };
  }

  const normalized = referencePath.replace(/\\/g, "/");
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    if (!options.sourceDefinitionDir) {
      throw new Error(
        "This reference is relative to the workflow file, which has no known location."
      );
    }
    return {
      absolutePath: path.resolve(options.sourceDefinitionDir, normalized),
      base: REFERENCE_PATH_BASES.WORKFLOW,
    };
  }

  return resolveWorkspaceOrNamedPath(
    normalized,
    options.primaryRoot,
    options.namedRoots
  );
}

function resolveWorkspaceOrNamedPath(
  referencePath: string,
  primaryRoot: string,
  namedRoots: readonly ResolverWorkspaceFolder[]
): ReferencePathResolution {
  if (path.isAbsolute(referencePath)) {
    return {
      absolutePath: path.resolve(referencePath),
      base: REFERENCE_PATH_BASES.ABSOLUTE,
    };
  }

  const normalized = referencePath.replace(/\\/g, "/");
  const firstSlash = normalized.indexOf("/");
  if (namedRoots.length > 1 && firstSlash > 0) {
    const firstSegment = normalized.slice(0, firstSlash);
    const rest = normalized.slice(firstSlash + 1);
    const match = namedRoots.find(
      (root) =>
        root.name === firstSegment ||
        path.basename(root.fsPath) === firstSegment
    );
    if (match) {
      return {
        absolutePath: path.resolve(match.fsPath, rest),
        base: REFERENCE_PATH_BASES.NAMED_ROOT,
      };
    }
  }

  return {
    absolutePath: path.resolve(primaryRoot, normalized),
    base: REFERENCE_PATH_BASES.WORKSPACE,
  };
}

/**
 * Return the directory containing a source definition only when that file is
 * inside the supplied trusted roots. `undefined` roots means the caller has
 * no containment context and preserves the historical trusted-by-construction
 * behavior; an explicitly supplied list is authoritative, including `[]`.
 */
export function getTrustedSourceDefinitionDir(
  sourceDefinitionPath: string | undefined,
  trustedRoots: readonly string[] | undefined
): string | undefined {
  if (!sourceDefinitionPath) {
    return undefined;
  }

  const resolvedSourcePath = path.resolve(sourceDefinitionPath);
  if (
    trustedRoots !== undefined &&
    !isPathWithinAnyDirectory(resolvedSourcePath, trustedRoots)
  ) {
    return undefined;
  }

  return path.dirname(resolvedSourcePath);
}

/**
 * Resolve a relative reference path using the workspace/named-root branches
 * of {@link resolveReferencePath}. A leading `./` is intentionally not
 * stripped: inline references use it to select the workflow base, while lone
 * prompt-file resolution keeps its own source-dir-then-workspace fallback.
 */
export function resolveNamedRelativePath(
  relativePath: string,
  primaryRoot: string,
  namedRoots: readonly ResolverWorkspaceFolder[]
): string {
  return resolveWorkspaceOrNamedPath(relativePath, primaryRoot, namedRoots)
    .absolutePath;
}

/**
 * Pure decision for whether prompt rendering should use absolute file paths.
 * Multi-root workspaces force absolute (a `root2/...`-relative ref would be
 * wrong against the harness CLI's single cwd); single-root falls back to the
 * user setting. Kept pure/sync so it's unit-testable without `vscode` and
 * safe to call from the platform-agnostic CLI binary.
 */
export function resolveEffectiveAbsoluteReferences(
  userSetting: boolean,
  isMultiRoot: boolean
): boolean {
  return isMultiRoot ? true : userSetting;
}
