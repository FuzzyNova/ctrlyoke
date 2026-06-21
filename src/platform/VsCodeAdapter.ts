import * as vscode from "vscode";
import type { PlatformAdapter } from "./PlatformAdapter";
import { getVsCodeWorkspaceRoot } from "./VsCodeWorkspaceRoot";

/**
 * VS Code implementation of PlatformAdapter.
 * Wraps vscode.* APIs with identical behavior to what was previously called directly.
 * Used exclusively in the VS Code extension context.
 */
export class VsCodeAdapter implements PlatformAdapter {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getWorkspaceRoot(): string {
    return getVsCodeWorkspaceRoot();
  }

  log(message: string): void {
    vscode.window.showInformationMessage(message);
  }

  warn(message: string): void {
    vscode.window.showWarningMessage(message);
  }

  error(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  showProgress(_message: string): void {
    // VS Code shows progress via status bar / webview updates; no-op here
  }

  async showChoice(
    message: string,
    ...options: string[]
  ): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, ...options);
  }

  getExtensionPath(): string {
    return this.context.extensionPath;
  }

  async openTextFile(filePath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath)
    );
    await vscode.window.showTextDocument(doc);
  }

  focusDashboard(): void {
    vscode.commands.executeCommand("flightpath.dashboard.focus");
  }

  /**
   * Returns true to signal this is a VS Code extension context.
   * Used by CliIntegration to choose the VS Code terminal path over
   * the spawn-with-stdio:inherit CLI path.
   */
  isVsCode(): boolean {
    return true;
  }

  /**
   * Returns the underlying ExtensionContext for VS Code-only code
   * (WorkflowOrchestrator, terminal creation, etc.)
   */
  getExtensionContext(): vscode.ExtensionContext {
    return this.context;
  }
}
