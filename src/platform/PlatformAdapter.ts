import type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import type { SecretStore } from "./SecretStore";
import type { InteractiveTerminalMode } from "../types/DashboardConstants";
import { noWorkspacePlaceholderRoot } from "../utils/ProjectStatePaths";

/**
 * Abstraction layer for platform-specific APIs.
 * Implemented by VsCodeAdapter (VS Code extension) and CliAdapter (standalone CLI).
 *
 * This allows core workflow execution code to run in both contexts without
 * importing the `vscode` module directly.
 */
export interface PlatformAdapter {
  /** Where an interactive harness TUI is hosted. */
  readonly interactiveTerminal: InteractiveTerminalMode;
  /** Encrypted managed-secret storage for runtime resolution. */
  getSecretStore?(): SecretStore;
  /**
   * Read a configuration value when the platform provides a resolved config
   * surface, such as the standalone CLI adapter.
   */
  getConfig?(key: string, defaultValue: string): string;

  /**
   * Get the directory that contains the `.ctrlyoke` folder for the current
   * workspace. The value is window-stable (resolved once per window session).
   *
   * VS Code: resolved by `WorkspaceRootResolver` in this order —
   *   1. the `ctrlyoke.workspaceDirectory` setting, if set;
   *   2. the `.code-workspace` file's directory, when one is open on disk;
   *   3. the first workspace folder (single-folder case).
   *   `undefined` when the window has no folder open: there is no workspace,
   *   and nothing may be written on its behalf.
   * CLI: config.cwd ?? process.cwd() — never `undefined`.
   */
  getWorkspaceRoot(): string | undefined;

  /**
   * Get every directory that should be trusted as "inside the workspace" for
   * path-containment checks (e.g. `@file` prompt references) — not just the
   * single `.ctrlyoke` root above. For a multi-root `.code-workspace`, VS Code
   * does not require the folders to live under a common parent, so this
   * includes `getWorkspaceRoot()` plus every open workspace folder.
   * CLI: `[getWorkspaceRoot()]` (no multi-root concept).
   */
  getWorkspaceRoots(): string[];

  /**
   * External directories approved for file reads in this workspace.
   * Optional so lightweight test doubles and headless callers can preserve
   * the historical no-policy behavior when they have no trust context.
   */
  getApprovedExternalFileRoots?(stateRoot?: string): string[];

  /**
   * Every open workspace folder as a name/path pair, for folder-name-prefixed
   * relative ref resolution (`root2/src/index.ts`). Used to resolve refs
   * produced by multi-root completions and to decide `effectiveAbsolute`.
   * VS Code: one entry per `vscode.workspace.workspaceFolders` folder.
   * CLI: a single entry — `{ name: basename(getWorkspaceRoot()), fsPath: getWorkspaceRoot() }`
   * — so multi-root resolution can never trigger there.
   */
  getNamedWorkspaceRoots(): ResolverWorkspaceFolder[];

  /**
   * Get the extension's installation directory.
   * VS Code: context.extensionPath
   * CLI: directory of the main entry file (or process.cwd())
   */
  getExtensionPath(): string;
}

/**
 * The platform's workspace root, for code that only runs inside a workflow
 * run. A run cannot start without a workspace, so reaching this with none is a
 * bug; it throws rather than letting a caller fall back to the process cwd.
 */
export function requireWorkspaceRoot(platform: PlatformAdapter): string {
  const root = platform.getWorkspaceRoot();
  if (root === undefined) {
    throw new Error(NO_WORKSPACE_FOLDER_MESSAGE);
  }
  return root;
}

/** Shown when an action needs a workspace and the window has no folder open. */
export const NO_WORKSPACE_FOLDER_MESSAGE =
  "No workspace folder is open. Open a folder to use ctrlyoke.";

/**
 * Construct the execution workspace for ordinary, non-worktree execution.
 *
 * The approved external roots are resolved once using the state root's trust
 * identity and then carried with the execution workspace. Future worktree
 * construction belongs in a separate path; this helper is the sole builder
 * for the no-worktree shape.
 *
 * With no workspace (a VS Code window with no folder open) the shape is built
 * around {@link noWorkspacePlaceholderRoot}. Nothing runs there: run and
 * working-file paths refuse first when the platform reports no root.
 */
export function createNoWorktreeExecutionWorkspace(
  platform: PlatformAdapter,
  requestedStateRoot = platform.getWorkspaceRoot(),
  worktree?: ExecutionWorkspace["worktree"]
): ExecutionWorkspace {
  const stateRoot = requestedStateRoot ?? noWorkspacePlaceholderRoot();
  return {
    stateRoot,
    executionRoot: stateRoot,
    workspaceRoots: [...platform.getWorkspaceRoots()],
    namedWorkspaceRoots: platform
      .getNamedWorkspaceRoots()
      .map((root) => ({ ...root })),
    approvedExternalRoots: [
      ...(platform.getApprovedExternalFileRoots?.(stateRoot) ?? []),
    ],
    ...(worktree ? { worktree } : {}),
  };
}
