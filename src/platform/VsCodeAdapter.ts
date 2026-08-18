import * as vscode from "vscode";
import type { PlatformAdapter } from "./PlatformAdapter";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeTrustedWorkspaceRoots,
  getVsCodeNamedWorkspaceRoots,
} from "./VsCodeWorkspaceRoot";
import type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import type { SecretStore } from "./SecretStore";
import { VsCodeSecretStore } from "./VsCodeSecretStore";

/**
 * VS Code implementation of PlatformAdapter.
 * Wraps vscode.* APIs with identical behavior to what was previously called directly.
 * Used exclusively in the VS Code extension context.
 */
export class VsCodeAdapter implements PlatformAdapter {
  private readonly secretStore: SecretStore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secretStore = new VsCodeSecretStore(context.secrets);
  }

  getSecretStore(): SecretStore {
    return this.secretStore;
  }

  getWorkspaceRoot(): string {
    return getVsCodeWorkspaceRoot();
  }

  getWorkspaceRoots(): string[] {
    return getVsCodeTrustedWorkspaceRoots();
  }

  getApprovedExternalFileRoots(stateRoot?: string): string[] {
    return ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      ExternalRootsTrustStore.canonicalizeRoot(
        stateRoot ?? this.getWorkspaceRoot()
      )
    );
  }

  getNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    return getVsCodeNamedWorkspaceRoots();
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
    vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
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
