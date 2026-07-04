import * as path from "path";

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
