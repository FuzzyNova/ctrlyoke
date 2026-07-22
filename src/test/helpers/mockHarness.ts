import { HarnessIntegration, HarnessStatus } from "../../core/HarnessIntegration";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import { PromptStep } from "../../types/CtrlYokeTypes";
import {
  FAILURE_KINDS,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";

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
  log(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string): void {}
  showProgress(_message: string): void {}
  async showChoice(
    _message: string,
    ..._options: string[]
  ): Promise<string | undefined> {
    return undefined;
  }
  getExtensionPath(): string {
    return process.cwd();
  }
}

export class MockHarnessIntegration extends HarnessIntegration {
  public sentPrompts: string[] = [];
  public processExitFailure: boolean = false;
  public harnessErrorFailure: boolean = false;
  public timeoutFailure: boolean = false;
  public lastFailureOutput?: string;
  public lastCliCommandValue?: string;
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
    this.sentPrompts.push(prompt.prompt);
    this.promptReadyEmitter.fire({ fullPrompt: prompt.prompt });

    const outcome = this.onSend
      ? await this.onSend(prompt, workflowContext)
      : { success: true, responseText: `ok:${prompt.prompt}` };

    const success = outcome.success ?? true;
    if (!success) {
      return false;
    }

    this.responseCompleteEmitter.fire(
      outcome.responseText ?? `ok:${prompt.prompt}`
    );
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

  protected async cancelImplementation(): Promise<void> {}
}

/**
 * IntegrationFactory whose execution integrations are always mocks.
 * Pass a specific `executionIntegration` to observe every prompt the
 * workflow sends through a single recording instance.
 */
export class MockIntegrationFactory extends IntegrationFactory {
  constructor(
    platform: PlatformAdapter,
    private readonly executionIntegration?: MockHarnessIntegration
  ) {
    super(platform);
  }

  override createForExecution(_harness: HarnessId): HarnessIntegration {
    return (
      this.executionIntegration ?? new MockHarnessIntegration(undefined, false)
    );
  }
}
