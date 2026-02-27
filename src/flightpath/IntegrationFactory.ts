import * as vscode from "vscode";
import { Harness } from "../types/FlightPathTypes";
import { HarnessIntegration } from "./HarnessIntegration";
import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
import { CliIntegration } from "./cli/CliIntegration";
import { CopilotCliProvider } from "./cli/copilot/CopilotCliProvider";
import { ClaudeCliProvider } from "./cli/claude/ClaudeCliProvider";
import { CodexCliProvider } from "./cli/codex/CodexCliProvider";

/**
 * IntegrationFactory
 *
 * RESPONSIBILITY: Harness Integration Creation
 *
 * Factory for creating harness integration instances. Centralises all
 * integration construction so callers never import individual provider
 * classes directly.
 *
 * Phase 1: WorkflowOrchestrator creates and caches the four integrations at
 *           startup (same lifecycle as today).
 * Phase 2: Each WorkflowInstance calls createForHarness() to get its own
 *           fresh, isolated integration per execution.
 */
export class IntegrationFactory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Create a new Copilot CLI integration */
  createCopilotCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new CopilotCliProvider();
    return new CliIntegration(provider, this.context, registerWithContext);
  }

  /** Create a new Claude Code CLI integration */
  createClaudeCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new ClaudeCliProvider();
    return new CliIntegration(provider, this.context, registerWithContext);
  }

  /** Create a new Codex CLI integration */
  createCodexCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new CodexCliProvider();
    return new CliIntegration(provider, this.context, registerWithContext);
  }

  /** Create a new Copilot Chat integration */
  createCopilotChat(registerWithContext: boolean = true): CopilotChatIntegration {
    return new CopilotChatIntegration(this.context, registerWithContext);
  }

  /** Create a new integration for the given harness */
  createForHarness(harness: Harness, registerWithContext: boolean = true): HarnessIntegration {
    switch (harness) {
      case Harness.CopilotChat:
        return this.createCopilotChat(registerWithContext);
      case Harness.ClaudeCli:
        return this.createClaudeCli(registerWithContext);
      case Harness.CodexCli:
        return this.createCodexCli(registerWithContext);
      case Harness.CopilotCli:
      default:
        return this.createCopilotCli(registerWithContext);
    }
  }

  /**
   * Create a fresh execution integration for a single workflow run.
   *
   * Unlike detector singletons (created once at startup via createForHarness),
   * execution integrations are per-run: isolated event emitters, isolated process
   * state, no shared fields between parallel workflows.
   *
   * - Does NOT register emitters with context.subscriptions (avoids accumulation leak).
   * - Calls markAsReady() instead of initialize() — the detector singleton has already
   *   confirmed the harness is available, so the PATH/version check is redundant.
   * - Must be disposed by the caller (WorkflowInstance.startWorkflowExecution finally block).
   */
  createForExecution(harness: Harness): HarnessIntegration {
    const integration = this.createForHarness(harness, false);
    integration.markAsReady();
    return integration;
  }
}
