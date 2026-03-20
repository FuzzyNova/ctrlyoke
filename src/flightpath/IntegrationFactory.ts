import { PlatformAdapter } from "../platform/PlatformAdapter";
import { Harness } from "../types/FlightPathTypes";
import { HarnessIntegration } from "./HarnessIntegration";
import { CliIntegration } from "./harness/CliIntegration";
import { CopilotCliProvider } from "./harness/copilot/CopilotCliProvider";
import { ClaudeCliProvider } from "./harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "./harness/codex/CodexCliProvider";
import { OpenCodeCliProvider } from "./harness/opencode/OpenCodeCliProvider";
import { QwenCliProvider } from "./harness/qwen/QwenCliProvider";
import { GeminiCliProvider } from "./harness/gemini/GeminiCliProvider";

/**
 * IntegrationFactory
 *
 * RESPONSIBILITY: CLI Harness Integration Creation (platform-agnostic)
 *
 * Factory for creating CLI harness integration instances. Centralises all
 * CLI integration construction so callers never import individual provider
 * classes directly.
 *
 * Handles copilot-cli, claude-cli, and codex-cli harnesses only.
 * For copilot-chat (VS Code-only), use VsCodeIntegrationFactory which
 * extends this class and adds chat support.
 *
 * Phase 1: WorkflowOrchestrator creates and caches the four integrations at
 *           startup (same lifecycle as today).
 * Phase 2: Each WorkflowInstance calls createForHarness() to get its own
 *           fresh, isolated integration per execution.
 */
export class IntegrationFactory {
  constructor(protected readonly platform: PlatformAdapter) {}

  /** Create a new Copilot CLI integration */
  createCopilotCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new CopilotCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new Claude Code CLI integration */
  createClaudeCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new ClaudeCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new Codex CLI integration */
  createCodexCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new CodexCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new OpenCode CLI integration */
  createOpenCodeCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new OpenCodeCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new Qwen Code CLI integration */
  createQwenCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new QwenCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new Gemini CLI integration */
  createGeminiCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new GeminiCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new integration for the given harness (CLI harnesses only) */
  createForHarness(
    harness: Harness,
    registerWithContext: boolean = true
  ): HarnessIntegration {
    switch (harness) {
      case Harness.ClaudeCli:
        return this.createClaudeCli(registerWithContext);
      case Harness.CodexCli:
        return this.createCodexCli(registerWithContext);
      case Harness.OpenCodeCli:
        return this.createOpenCodeCli(registerWithContext);
      case Harness.QwenCli:
        return this.createQwenCli(registerWithContext);
      case Harness.GeminiCli:
        return this.createGeminiCli(registerWithContext);
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
