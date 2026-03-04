import * as vscode from "vscode";
import { VsCodeAdapter } from "../platform/VsCodeAdapter";
import { Harness } from "../types/FlightPathTypes";
import { HarnessIntegration } from "./HarnessIntegration";
import { CopilotChatIntegration } from "./harness/chat/CopilotChatIntegration";
import { IntegrationFactory } from "./IntegrationFactory";

/**
 * VsCodeIntegrationFactory
 *
 * RESPONSIBILITY: VS Code Harness Integration Creation (all four harnesses)
 *
 * Extends IntegrationFactory with VS Code-specific harness support.
 * The base IntegrationFactory handles CLI harnesses (copilot-cli, claude-cli, codex-cli)
 * which are platform-agnostic. This subclass adds copilot-chat which requires
 * a vscode.ExtensionContext and can only run inside the VS Code extension host.
 *
 * WorkflowOrchestrator (VS Code-only) always uses this class.
 * Platform-agnostic CLI code uses the base IntegrationFactory.
 */
export class VsCodeIntegrationFactory extends IntegrationFactory {
  constructor(private readonly vsCodeAdapter: VsCodeAdapter) {
    super(vsCodeAdapter);
  }

  /** Create a new Copilot Chat integration (VS Code-only) */
  createCopilotChat(
    registerWithContext: boolean = true
  ): CopilotChatIntegration {
    const context = this.vsCodeAdapter.getExtensionContext();
    return new CopilotChatIntegration(context, registerWithContext);
  }

  /** Create a new integration for the given harness (all four harnesses) */
  override createForHarness(
    harness: Harness,
    registerWithContext: boolean = true
  ): HarnessIntegration {
    if (harness === Harness.CopilotChat) {
      return this.createCopilotChat(registerWithContext);
    }
    return super.createForHarness(harness, registerWithContext);
  }

  /**
   * Create a fresh execution integration for a single workflow run.
   * Overrides base to also handle copilot-chat.
   */
  override createForExecution(harness: Harness): HarnessIntegration {
    const integration = this.createForHarness(harness, false);
    integration.markAsReady();
    return integration;
  }
}
