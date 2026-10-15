import * as fs from "fs";
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
 * Find the root addressed by a viewer/reference path segment. Display names
 * take precedence across the full list; directory basenames are a fallback.
 * `find` keeps duplicate display names first-wins, matching workspace order.
 */
export function findNamedRootBySegment(
  segment: string,
  namedRoots: readonly ResolverWorkspaceFolder[]
): ResolverWorkspaceFolder | undefined {
  return (
    namedRoots.find((root) => root.name === segment) ??
    namedRoots.find((root) => path.basename(root.fsPath) === segment)
  );
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
 * Resolve directories trusted as "inside the workspace" for path-containment
 * checks (e.g. `@file` prompt references). The primary `.ctrlyoke` root is
 * included only when it is inside an open folder or the saved workspace-file
 * directory; every open folder remains included.
 *
 * This matters for multi-root `.code-workspace` setups: the primary root is
 * often just the directory containing the `.code-workspace` file, which is
 * not guaranteed to be an ancestor of the actual folders — VS Code does not
 * require multi-root folders to live under a common parent. Every open folder
 * is included so references into those folders remain available.
 */
export function resolveTrustedWorkspaceRoots(
  input: WorkspaceRootResolverInput
): string[] {
  const primary = path.normalize(resolveWorkspaceRoot(input));
  const folderPaths = (input.workspaceFolders ?? []).map((folder) =>
    path.normalize(folder.fsPath)
  );
  const trustedBases = [
    ...folderPaths,
    ...(input.workspaceFileDir ? [path.normalize(input.workspaceFileDir)] : []),
  ];
  if (trustedBases.length === 0) {
    return [primary];
  }
  const roots = trustedBases.some((root) =>
    isPathWithinDirectory(primary, root)
  )
    ? [primary, ...folderPaths]
    : folderPaths;
  return Array.from(new Set(roots));
}

/**
 * Return the state root when it is outside the folders and saved workspace
 * file directory. The caller must treat it as a requested external root and
 * wait for an explicit trust decision before including it in file access.
 */
export function resolveRequestedExternalWorkspaceRoot(
  input: WorkspaceRootResolverInput
): string | undefined {
  const primary = path.normalize(resolveWorkspaceRoot(input));
  const trustedBases = [
    ...(input.workspaceFolders ?? []).map((folder) =>
      path.normalize(folder.fsPath)
    ),
    ...(input.workspaceFileDir ? [path.normalize(input.workspaceFileDir)] : []),
  ];
  if (trustedBases.length === 0) {
    return undefined;
  }
  return trustedBases.some((root) => isPathWithinDirectory(primary, root))
    ? undefined
    : primary;
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
 * Resolve a reference path against exactly one lexical base. The only
 * filesystem probe is the single-root `<rootname>/…` disambiguation in
 * `resolveWorkspaceOrNamedPath`. A leading `./` or `../` requires a known workflow-file
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
  const workspaceResolution: ReferencePathResolution = {
    absolutePath: path.resolve(primaryRoot, normalized),
    base: REFERENCE_PATH_BASES.WORKSPACE,
  };
  const firstSlash = normalized.indexOf("/");
  if (namedRoots.length === 0 || firstSlash <= 0) {
    return workspaceResolution;
  }

  const match = findNamedRootBySegment(
    normalized.slice(0, firstSlash),
    namedRoots
  );
  if (!match) {
    return workspaceResolution;
  }
  const namedResolution: ReferencePathResolution = {
    absolutePath: path.resolve(match.fsPath, normalized.slice(firstSlash + 1)),
    base: REFERENCE_PATH_BASES.NAMED_ROOT,
  };
  if (namedRoots.length > 1) {
    return namedResolution;
  }

  // Single root: a `<rootname>/…` prefix is ambiguous with a same-named
  // subdirectory (Django's `mysite/mysite/`, Python's `requests/requests/`).
  // Decide by layout, not by which file is named: when that subdirectory
  // exists the prefix always means it, so a missing file reports "not found"
  // rather than silently attaching a root-level namesake. Otherwise the
  // prefix names the root itself, so a reference authored in a multi-root
  // workspace keeps resolving when the same folder is opened on its own.
  return isDirectory(path.resolve(primaryRoot, normalized.slice(0, firstSlash)))
    ? workspaceResolution
    : namedResolution;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
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
