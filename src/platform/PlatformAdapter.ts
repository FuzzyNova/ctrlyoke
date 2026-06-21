/**
 * Abstraction layer for platform-specific APIs.
 * Implemented by VsCodeAdapter (VS Code extension) and CliAdapter (standalone CLI).
 *
 * This allows core workflow execution code to run in both contexts without
 * importing the `vscode` module directly.
 */
export interface PlatformAdapter {
  /**
   * Get the directory that contains the `.flightpath` folder for the current
   * workspace. The value is window-stable (resolved once per window session).
   *
   * VS Code: resolved by `WorkspaceRootResolver` in this order —
   *   1. the `flightpath.workspaceDirectory` setting, if set;
   *   2. the `.code-workspace` file's directory, when one is open on disk;
   *   3. the first workspace folder (single-folder case);
   *   4. `process.cwd()` when no folder is open.
   * CLI: config.cwd ?? process.cwd()
   */
  getWorkspaceRoot(): string;

  /**
   * Log an informational message.
   * VS Code: vscode.window.showInformationMessage()
   * CLI: console.log()
   */
  log(message: string): void;

  /**
   * Show a warning message.
   * VS Code: vscode.window.showWarningMessage()
   * CLI: console.warn()
   */
  warn(message: string): void;

  /**
   * Show an error message.
   * VS Code: vscode.window.showErrorMessage()
   * CLI: console.error()
   */
  error(message: string): void;

  /**
   * Show a progress/status message.
   * VS Code: can be a no-op or use status bar
   * CLI: console.log()
   */
  showProgress(message: string): void;

  /**
   * Present a choice to the user.
   * VS Code: vscode.window.showWarningMessage(message, ...options)
   * CLI: in headless mode returns undefined; in interactive mode could use a prompt
   * Returns the chosen option, or undefined if dismissed.
   */
  showChoice(
    message: string,
    ...options: string[]
  ): Promise<string | undefined>;

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
   * VS Code: executes "flightpath.focusDashboard" command
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
