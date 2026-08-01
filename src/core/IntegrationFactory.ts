import { PlatformAdapter } from "../platform/PlatformAdapter";
import { HARNESS_IDS, type HarnessId } from "../types/DashboardConstants";
import { HarnessIntegration } from "./HarnessIntegration";
import { CliIntegration } from "./harness/CliIntegration";
import { CopilotCliProvider } from "./harness/copilot/CopilotCliProvider";
import { ClaudeCliProvider } from "./harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "./harness/codex/CodexCliProvider";
import { OpenCodeCliProvider } from "./harness/opencode/OpenCodeCliProvider";
import { QwenCliProvider } from "./harness/qwen/QwenCliProvider";
import { AntigravityCliProvider } from "./harness/antigravity/AntigravityCliProvider";
import type { ICliProvider } from "./harness/shared/interfaces/ICliProvider";

/**
 * IntegrationFactory
 *
 * RESPONSIBILITY: CLI Harness Integration Creation (platform-agnostic)
 *
 * Factory for creating CLI harness integration instances. Centralises all
 * CLI integration construction so callers never import individual provider
 * classes directly.
 *
 * Handles all CLI harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli,
 * qwen-cli, antigravity-cli) and is platform-agnostic; WorkflowOrchestrator
 * (VS Code-only) and the standalone CLI/server binaries both use it directly.
 *
 * Phase 1: WorkflowOrchestrator creates and caches the four integrations at
 *           startup (same lifecycle as today).
 * Phase 2: Each WorkflowInstance calls createForHarness() to get its own
 *           fresh, isolated integration per execution.
 */
export class IntegrationFactory {
  constructor(protected readonly platform: PlatformAdapter) {}

  /**
   * Create a provider for capability inspection without creating an execution
   * integration. This is the single HarnessId-to-provider source used by the
   * capability registry; it intentionally performs no CLI calls.
   */
  static createCapabilityProvider(harness: HarnessId): ICliProvider {
    switch (harness) {
      case HARNESS_IDS.CLAUDE_CLI:
        return new ClaudeCliProvider();
      case HARNESS_IDS.CODEX_CLI:
        return new CodexCliProvider();
      case HARNESS_IDS.OPENCODE_CLI:
        return new OpenCodeCliProvider();
      case HARNESS_IDS.QWEN_CLI:
        return new QwenCliProvider();
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return new AntigravityCliProvider();
      case HARNESS_IDS.COPILOT_CLI:
      default:
        return new CopilotCliProvider();
    }
  }

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

  /** Create a new Antigravity CLI integration */
  createAntigravityCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new AntigravityCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new integration for the given harness (CLI harnesses only) */
  createForHarness(
    harness: HarnessId,
    registerWithContext: boolean = true
  ): HarnessIntegration {
    switch (harness) {
      case HARNESS_IDS.CLAUDE_CLI:
        return this.createClaudeCli(registerWithContext);
      case HARNESS_IDS.CODEX_CLI:
        return this.createCodexCli(registerWithContext);
      case HARNESS_IDS.OPENCODE_CLI:
        return this.createOpenCodeCli(registerWithContext);
      case HARNESS_IDS.QWEN_CLI:
        return this.createQwenCli(registerWithContext);
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return this.createAntigravityCli(registerWithContext);
      case HARNESS_IDS.COPILOT_CLI:
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
  createForExecution(harness: HarnessId): HarnessIntegration {
    const integration = this.createForHarness(harness, false);
    integration.markAsReady();
    return integration;
  }
}
