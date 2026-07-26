import * as assert from "assert";
import { suite, setup, teardown, test } from "mocha";
import { CliIntegration } from "../../core/harness/CliIntegration";
import { EndConditionEvaluator } from "../../core/EndConditionEvaluator";
import { EndConditionHandler } from "../../core/EndConditionHandler";
import {
  WorkflowExecutor,
  type WorkflowExecutionContext,
} from "../../core/WorkflowExecutor";
import { PromptQueue } from "../../core/PromptQueue";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import { MockPlatform } from "../helpers/mockHarness";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  type ExecutionMode,
} from "../../types/DashboardConstants";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { configService } from "../../config/CtrlYokeConfigService";

const SESSION_IDS = {
  FIRST: "11111111-1111-4111-8111-111111111111",
  SECOND: "22222222-2222-4222-8222-222222222222",
  THIRD: "33333333-3333-4333-8333-333333333333",
} as const;

type Dispatch = {
  mode: ExecutionMode;
  resolvedSessionId?: string;
};

function createProvider(): ICliProvider {
  return {
    config: {
      name: "test",
      harnessId: HARNESS_IDS.COPILOT_CLI,
      displayName: "Test CLI",
      terminalName: "Test",
      installHint: "",
      shouldStreamHeadlessOutput: false,
    },
    responseParser: {
      parse: () => ({ events: [], metadata: {} }),
      parseTokenCounts: () => undefined,
    },
    notificationMonitor: {
      supportsSessionIdInFilename: false,
      supportsSessionStart: false,
      monitorForCompletion: async () => ({ completed: false }),
      buildHookConfig: () => ({ type: "none" as const }),
      getNotificationDirectory: () => process.cwd(),
    },
    toolPermissionMapper: {
      buildArgs: () => [],
      hasFullPermissions: () => true,
    },
    buildCliArgs: async () => [],
    buildHeadlessArgs: (_baseArgs, prompt) => ["--prompt", prompt],
    buildInteractiveArgs: (_baseArgs, prompt) => ["--prompt", prompt],
    checkAvailability: async () => true,
  } as ICliProvider;
}

function createExecutionContext(
  integration: CliIntegration
): WorkflowExecutionContext {
  return {
    workspaceFolderPath: process.cwd(),
    currentPromptFilePath: "mixed-mode.ctrlyoke.yaml",
    shouldShowCliCommand: false,
    dynamicQueueConfig: {
      maxQueueSize: 100,
      maxWorkflowExecutionTime: 3600,
      unlimitedMode: false,
      notifyOnExtension: false,
    },
    getIntegrationForPrompt: () => integration,
    historyFilePath: "",
    instanceId: "mixed-mode-test",
  };
}

suite("mixed-mode workflow execution", () => {
  setup(() => {
    configService.setCliOverlay({
      defaults: { executionMode: EXECUTION_MODES.HEADLESS },
    });
  });

  teardown(() => {
    configService.setCliOverlay({});
  });

  test("retires the interactive PTY before headlessly resuming step 2's session", async () => {
    const queue = new PromptQueue();
    const integration = new CliIntegration(
      createProvider(),
      new MockPlatform(),
      false
    );
    const dispatches: Dispatch[] = [];
    const events: string[] = [];
    let lastInteractiveContext:
      | { sessionId: string; spawnedWithSessionId: string }
      | undefined;

    const runner = (integration as any).executionRunner as {
      executeInteractive: (session: any) => Promise<boolean>;
      executeHeadless: (session: any) => Promise<boolean>;
      getLastInteractiveContext: () => typeof lastInteractiveContext;
      clearInteractiveContext: () => void;
    };
    runner.getLastInteractiveContext = () => lastInteractiveContext;
    runner.clearInteractiveContext = () => {
      events.push("clear-interactive-context");
      lastInteractiveContext = undefined;
    };

    (integration as any).shouldUseInjectMode = () => false;
    (integration as any).transportCoordinator.terminateCurrentPtySession = (
      reason: string
    ) => {
      events.push(`retire:${reason}`);
      return "pty-step-2";
    };

    const complete = (response: string) => {
      (integration as any).responseCompleteEmitter.fire(response);
    };

    runner.executeInteractive = async (session: any) => {
      dispatches.push({
        mode: EXECUTION_MODES.INTERACTIVE,
        resolvedSessionId: session.resolvedSessionId,
      });
      session.recordCommandPrepared({
        promptArgument: session.promptArgument,
        cliCommand: "test --interactive",
      });
      session.updateParsedOutput({
        events: [],
        metadata: { sessionId: SESSION_IDS.SECOND },
      });
      session.setExtractedSessionId(SESSION_IDS.SECOND);
      lastInteractiveContext = {
        sessionId: SESSION_IDS.SECOND,
        spawnedWithSessionId: SESSION_IDS.SECOND,
      };
      complete("interactive response");
      return true;
    };

    runner.executeHeadless = async (session: any) => {
      const sessionId =
        dispatches.length === 0 ? SESSION_IDS.FIRST : SESSION_IDS.THIRD;
      dispatches.push({
        mode: EXECUTION_MODES.HEADLESS,
        resolvedSessionId: session.resolvedSessionId,
      });
      if (session.resolvedSessionId === SESSION_IDS.SECOND) {
        events.push("step-3-headless-dispatch");
      }
      const parsedOutput: UniversalCliOutput = {
        events: [],
        metadata: { sessionId },
      };
      session.recordHeadlessResponse({
        success: true,
        parsedOutput,
        cliResult: {
          success: true,
          response: "headless response",
          statistics: "",
        },
        extractedSessionId: sessionId,
      });
      complete("headless response");
      return true;
    };

    const steps: PromptStep[] = [
      {
        prompt: "first",
        harness: HARNESS_IDS.COPILOT_CLI,
        executionMode: EXECUTION_MODES.HEADLESS,
      },
      {
        prompt: "second",
        harness: HARNESS_IDS.COPILOT_CLI,
        executionMode: EXECUTION_MODES.INTERACTIVE,
      },
      {
        prompt: "third",
        harness: HARNESS_IDS.COPILOT_CLI,
        executionMode: EXECUTION_MODES.HEADLESS,
        sessionId: 2,
      },
    ];
    queue.loadPrompts({ resumeSession: true, steps });

    const platform = new MockPlatform();
    const evaluator = new EndConditionEvaluator(platform);
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      () => undefined,
      platform
    );
    const executor = new WorkflowExecutor(queue, handler, evaluator, platform);

    await executor.execute(integration, createExecutionContext(integration));

    assert.deepStrictEqual(
      dispatches.map(({ mode }) => mode),
      [
        EXECUTION_MODES.HEADLESS,
        EXECUTION_MODES.INTERACTIVE,
        EXECUTION_MODES.HEADLESS,
      ]
    );
    assert.strictEqual(dispatches[1].resolvedSessionId, SESSION_IDS.FIRST);
    assert.strictEqual(dispatches[2].resolvedSessionId, SESSION_IDS.SECOND);
    assert.strictEqual(
      events.filter((event) => event.startsWith("retire:")).length,
      1
    );
    assert.ok(
      events.indexOf("clear-interactive-context") <
        events.indexOf("step-3-headless-dispatch")
    );
    assert.match(
      events.find((event) => event.startsWith("retire:")) ?? "",
      /headless resume of AI session 22222222-2222-4222-8222-222222222222/u
    );
  });
});
