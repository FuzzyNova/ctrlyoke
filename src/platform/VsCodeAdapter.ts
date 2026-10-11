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
import { INTERACTIVE_TERMINAL_MODES } from "../types/DashboardConstants";

/**
 * VS Code implementation of PlatformAdapter.
 * Wraps vscode.* APIs with identical behavior to what was previously called directly.
 * Used exclusively in the VS Code extension context.
 */
export class VsCodeAdapter implements PlatformAdapter {
  readonly interactiveTerminal = INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY;
  private readonly secretStore: SecretStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    secretStore: SecretStore
  ) {
    this.secretStore = secretStore;
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
}
