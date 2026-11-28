import {
  HarnessIntegration,
  HarnessStatus,
} from "../../core/HarnessIntegration";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import { PromptStep } from "../../types/CtrlYokeTypes";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import {
  FAILURE_KINDS,
  HARNESS_IDS,
  INTERACTIVE_TERMINAL_MODES,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { HarnessVersionPolicy } from "../../utils/HarnessVersion";

/**
 * Shared no-op test doubles for driving workflow execution without any real
 * AI harness. `MockHarnessIntegration` records every prompt it receives and
 * immediately fires a canned response, so tests can assert exactly which
 * prompts reached the harness (or that none did) at zero cost.
 *
 * Used by both the executor unit tests (`src/test/unit/WorkflowExecutor.test.ts`)
 * and the full-flow integration harness (`src/test/integration/helpers/`).
 */

export type SendOutcome = {
  success?: boolean;
  responseText?: string;
  afterResponse?: () => Promise<void> | void;
};

export class MockPlatform implements PlatformAdapter {
  readonly interactiveTerminal = INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY;
  constructor(private readonly workspaceRoot: string = process.cwd()) {}

  getConfig<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
  getWorkspaceRoots(): string[] {
    return [this.workspaceRoot];
  }
  getNamedWorkspaceRoots() {
    return [{ name: "root", fsPath: this.workspaceRoot }];
  }
  getExtensionPath(): string {
    return process.cwd();
  }
}

export class MockHarnessIntegration extends HarnessIntegration {
  public sentPrompts: string[] = [];
  public prepareSentPrompt?: (
    prompt: PromptStep,
    workflowContext?: Parameters<HarnessIntegration["sendPrompt"]>[2]
  ) => Promise<string> | string;
  public processExitFailure: boolean = false;
  public harnessErrorFailure: boolean = false;
  public timeoutFailure: boolean = false;
  public lastFailureOutput?: string;
  public lastCliCommandValue?: string;
  public lastParsedOutput?: UniversalCliOutput;
  public onSend?: (
    prompt: PromptStep,
    workflowContext?: Parameters<HarnessIntegration["sendPrompt"]>[2]
  ) => Promise<SendOutcome>;

  async initialize(): Promise<void> {}

  async sendPrompt(
    prompt: PromptStep,
    _needsCompletionDetection?: boolean,
    workflowContext?: Parameters<HarnessIntegration["sendPrompt"]>[2]
  ): Promise<boolean> {
    const sentPrompt = this.prepareSentPrompt
      ? await this.prepareSentPrompt(prompt, workflowContext)
      : prompt.prompt;
    this.sentPrompts.push(sentPrompt);
    this.promptReadyEmitter.fire({ fullPrompt: sentPrompt });

    const outcome = this.onSend
      ? await this.onSend(prompt, workflowContext)
      : { success: true, responseText: `ok:${sentPrompt}` };

    const success = outcome.success ?? true;
    if (!success) {
      return false;
    }

    if (outcome.responseText) {
      this.streamingChunkEmitter.fire(outcome.responseText);
    }
    this.responseCompleteEmitter.fire(undefined);
    if (outcome.afterResponse) {
      await outcome.afterResponse();
    }

    return true;
  }

  getStatus(): { available: boolean; message: string; strategy: string } {
    return { available: true, message: "ready", strategy: "mock" };
  }

  override wasLastFailureProcessExit(): boolean {
    return this.processExitFailure;
  }

  override wasLastFailureHarnessError(): boolean {
    return this.harnessErrorFailure;
  }

  override wasLastFailureTimeout(): boolean {
    return this.timeoutFailure;
  }

  override getLastFailureKind() {
    if (this.processExitFailure) {
      return FAILURE_KINDS.PROCESS_EXIT;
    }
    if (this.harnessErrorFailure) {
      return FAILURE_KINDS.HARNESS_ERROR;
    }
    if (this.timeoutFailure) {
      return FAILURE_KINDS.TIMEOUT;
    }
    return undefined;
  }

  override getLastFailureOutput(): string | undefined {
    return this.lastFailureOutput;
  }

  override getLastCliCommand(): string | undefined {
    return this.lastCliCommandValue;
  }

  override getLastParsedOutput(): UniversalCliOutput | undefined {
    return this.lastParsedOutput;
  }

  isIntegrationAvailable(): boolean {
    return true;
  }

  getIntegrationMode(): string {
    return HARNESS_IDS.COPILOT_CLI;
  }

  getInitializationStatus(): HarnessStatus {
    return HarnessStatus.Ready;
  }

  isReady(): boolean {
    return true;
  }

  /** When set, a cancel completes the pending response, as a killed CLI's does. */
  public completeResponseOnCancel = false;

  protected async cancelImplementation(): Promise<void> {
    if (this.completeResponseOnCancel) {
      this.responseCompleteEmitter.fire(undefined);
    }
  }
}

/**
 * Sends each prompt but holds its response until the integration is
 * cancelled, like a long AI turn: `sendPrompt` returns once the prompt is
 * sent, and only a cancel completes the response.
 */
export class HeldResponseHarnessIntegration extends MockHarnessIntegration {
  override completeResponseOnCancel = true;

  override async sendPrompt(prompt: PromptStep): Promise<boolean> {
    this.sentPrompts.push(prompt.prompt);
    this.promptReadyEmitter.fire({ fullPrompt: prompt.prompt });
    return true;
  }
}

/**
 * IntegrationFactory whose execution integrations are always mocks.
 * Pass a specific `executionIntegration` to observe every prompt the
 * workflow sends through a single recording instance, or a function to
 * build a distinct one per call (one instance shared by every call is also
 * the workflow's unkeyed default integration, which is never retained
 * across a pause).
 */
export class MockIntegrationFactory extends IntegrationFactory {
  constructor(
    platform: PlatformAdapter,
    private readonly executionIntegration?:
      MockHarnessIntegration | (() => MockHarnessIntegration)
  ) {
    super(platform);
  }

  override createForExecution(_harness: HarnessId): HarnessIntegration {
    if (typeof this.executionIntegration === "function") {
      return this.executionIntegration();
    }
    return (
      this.executionIntegration ?? new MockHarnessIntegration(undefined, false)
    );
  }
}

/** Permissive `HarnessConfig.versionPolicy` for provider test doubles. */
export const TEST_VERSION_POLICY: HarnessVersionPolicy = {
  minimum: "0.0.0",
  testedWith: "0.0.0",
  updateCommand: "test-cli update",
};
