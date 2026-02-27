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
  createCopilotCli(): CliIntegration {
    const provider = new CopilotCliProvider();
    return new CliIntegration(provider, this.context);
  }

  /** Create a new Claude Code CLI integration */
  createClaudeCli(): CliIntegration {
    const provider = new ClaudeCliProvider();
    return new CliIntegration(provider, this.context);
  }

  /** Create a new Codex CLI integration */
  createCodexCli(): CliIntegration {
    const provider = new CodexCliProvider();
    return new CliIntegration(provider, this.context);
  }

  /** Create a new Copilot Chat integration */
  createCopilotChat(): CopilotChatIntegration {
    return new CopilotChatIntegration(this.context);
  }

  /** Create a new integration for the given harness */
  createForHarness(harness: Harness): HarnessIntegration {
    switch (harness) {
      case Harness.CopilotChat:
        return this.createCopilotChat();
      case Harness.ClaudeCli:
        return this.createClaudeCli();
      case Harness.CodexCli:
        return this.createCodexCli();
      case Harness.CopilotCli:
      default:
        return this.createCopilotCli();
    }
  }
}
