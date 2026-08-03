import type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";

/**
 * Abstraction layer for platform-specific APIs.
 * Implemented by VsCodeAdapter (VS Code extension) and CliAdapter (standalone CLI).
 *
 * This allows core workflow execution code to run in both contexts without
 * importing the `vscode` module directly.
 */
export interface PlatformAdapter {
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
   *   3. the first workspace folder (single-folder case);
   *   4. `process.cwd()` when no folder is open.
   * CLI: config.cwd ?? process.cwd()
   */
  getWorkspaceRoot(): string;

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

  /**
   * Optional: Open a text file in the current environment.
   * VS Code: opens editor tab for the file
   * CLI: usually unsupported (undefined)
   */
  openTextFile?(filePath: string): Promise<void>;

  /**
   * Optional: Focus the dashboard/output panel.
   * VS Code: executes "ctrlyoke.focusDashboard" command
   * CLI: no-op (undefined)
   */
  focusDashboard?(): void;

  /**
   * Optional: Returns true when running inside a VS Code extension context.
   * VS Code: true
   * CLI: undefined (falsy)
   *
   * Used by CliIntegration to decide whether to create a vscode.Terminal
   * (VS Code interactive path) or spawn a child process with stdio:inherit
   * (CLI interactive path).
   */
  isVsCode?(): boolean;
}
