import {
  createNoWorktreeExecutionWorkspace,
  PlatformAdapter,
} from "../platform/PlatformAdapter";
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
import type { UserFeedbackSink } from "./UserFeedbackSink";
import type { HarnessQuotaSnapshot } from "../types/UsageTypes";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { detectHarness } from "./harness/shared/HarnessDetection";
import { harnessAvailability } from "../utils/HarnessAvailability";
import type { DisposableRegistry } from "./HostPorts";

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
  constructor(
    protected readonly platform: PlatformAdapter,
    protected readonly userFeedbackSink?: UserFeedbackSink,
    protected readonly onProviderUsageUpdate?: (
      quota: HarnessQuotaSnapshot
    ) => void,
    protected readonly disposableRegistry?: DisposableRegistry
  ) {}

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
        return new CopilotCliProvider();
      default:
        throw new Error(`Unknown harness: ${harness}`);
    }
  }

  /**
   * Resolve an auto-detected (empty) `defaults.harness` in a host that does
   * not detect harnesses on its own, i.e. the standalone CLI: run
   * `--version` probes in display order until one harness is installed. A
   * no-op when `defaults.harness` names a harness.
   */
  static async detectDefaultHarness(): Promise<void> {
    if (!ConfigurationUtils.isDefaultHarnessAutoDetected()) {
      return;
    }
    await harnessAvailability.detectFirstAvailable(
      async (harnessId) =>
        (
          await detectHarness(
            IntegrationFactory.createCapabilityProvider(harnessId)
          )
        ).available
    );
  }

  /** Create a new Copilot CLI integration */
  createCopilotCli(
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const provider = new CopilotCliProvider();
    return new CliIntegration(
      provider,
      this.platform,
      registerWithContext,
      this.userFeedbackSink,
      this.onProviderUsageUpdate,
      executionWorkspace,
      this.disposableRegistry
    );
  }

  /** Create a new Claude Code CLI integration */
  createClaudeCli(
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const provider = new ClaudeCliProvider();
    return new CliIntegration(
      provider,
      this.platform,
      registerWithContext,
      this.userFeedbackSink,
      this.onProviderUsageUpdate,
      executionWorkspace,
      this.disposableRegistry
    );
  }

  /** Create a new Codex CLI integration */
  createCodexCli(
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const provider = new CodexCliProvider(this.onProviderUsageUpdate);
    return new CliIntegration(
      provider,
      this.platform,
      registerWithContext,
      this.userFeedbackSink,
      this.onProviderUsageUpdate,
      executionWorkspace,
      this.disposableRegistry
    );
  }

  /** Create a new OpenCode CLI integration */
  createOpenCodeCli(
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const provider = new OpenCodeCliProvider();
    return new CliIntegration(
      provider,
      this.platform,
      registerWithContext,
      this.userFeedbackSink,
      this.onProviderUsageUpdate,
      executionWorkspace,
      this.disposableRegistry
    );
  }

  /** Create a new Qwen Code CLI integration */
  createQwenCli(
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const provider = new QwenCliProvider();
    return new CliIntegration(
      provider,
      this.platform,
      registerWithContext,
      this.userFeedbackSink,
      this.onProviderUsageUpdate,
      executionWorkspace,
      this.disposableRegistry
    );
  }

  /** Create a new Antigravity CLI integration */
  createAntigravityCli(
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const provider = new AntigravityCliProvider();
    return new CliIntegration(
      provider,
      this.platform,
      registerWithContext,
      this.userFeedbackSink,
      this.onProviderUsageUpdate,
      executionWorkspace,
      this.disposableRegistry
    );
  }

  /** Create a new integration for the given harness (CLI harnesses only) */
  createForHarness(
    harness: HarnessId,
    registerWithContext: boolean = true,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    switch (harness) {
      case HARNESS_IDS.CLAUDE_CLI:
        return this.createClaudeCli(registerWithContext, executionWorkspace);
      case HARNESS_IDS.CODEX_CLI:
        return this.createCodexCli(registerWithContext, executionWorkspace);
      case HARNESS_IDS.OPENCODE_CLI:
        return this.createOpenCodeCli(registerWithContext, executionWorkspace);
      case HARNESS_IDS.QWEN_CLI:
        return this.createQwenCli(registerWithContext, executionWorkspace);
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return this.createAntigravityCli(
          registerWithContext,
          executionWorkspace
        );
      case HARNESS_IDS.COPILOT_CLI:
        return this.createCopilotCli(registerWithContext, executionWorkspace);
      default:
        throw new Error(`Unknown harness: ${harness}`);
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
  createForExecution(
    harness: HarnessId,
    executionWorkspace: ExecutionWorkspace = createNoWorktreeExecutionWorkspace(
      this.platform
    )
  ): HarnessIntegration {
    const integration = this.createForHarness(
      harness,
      false,
      executionWorkspace
    );
    integration.markAsReady();
    return integration;
  }

  /**
   * Create the same planning helpers as execution without starting a
   * harness. Pass `executionWorkspace` to preview a worktree-remapped
   * workspace (see `ExecutionPreviewService.buildWorktreePreview`); omitted,
   * this defaults to the ordinary no-worktree workspace like before.
   */
  createForPreview(
    harness: HarnessId,
    executionWorkspace?: ExecutionWorkspace
  ): CliIntegration {
    const integration = this.createForHarness(
      harness,
      false,
      executionWorkspace
    );
    integration.markAsReady();
    return integration;
  }
}
