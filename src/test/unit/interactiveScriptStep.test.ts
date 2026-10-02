import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WorkflowExecutor,
  WorkflowExecutionContext,
} from "../../core/WorkflowExecutor";
import { PromptQueue } from "../../core/PromptQueue";
import { EndConditionEvaluator } from "../../core/EndConditionEvaluator";
import { EndConditionHandler } from "../../core/EndConditionHandler";
import { StatusMessageReporter } from "../../core/orchestration/StatusMessageReporter";
import {
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  STEP_TYPES,
} from "../../types/DashboardConstants";
import { MockHarnessIntegration, MockPlatform } from "../helpers/mockHarness";
import { createNoWorktreeExecutionWorkspace } from "../../platform/PlatformAdapter";

type ComparisonCase = {
  name: string;
  compareSource?: "stdout" | "stderr" | "exitCode";
  operator?: "eq" | "contains" | "gte";
  expected?: string | number;
  script: string;
  ptyOutput: string;
  /** Whether the step is expected to pass, in both execution modes. */
  shouldPass: boolean;
};

const cases: ComparisonCase[] = [
  {
    name: "default exit code",
    script: `node -e "process.stdout.write('ignored')"`,
    ptyOutput: "ignored",
    shouldPass: true,
  },
  {
    name: "explicit exit code",
    compareSource: "exitCode",
    expected: 0,
    script: `node -e "process.stdout.write('ignored')"`,
    ptyOutput: "ignored",
    shouldPass: true,
  },
  {
    name: "stdout text",
    compareSource: "stdout",
    expected: "PASS",
    script: `node -e "process.stdout.write('PASS')"`,
    ptyOutput: "\x1b[32mPASS\x1b[0m\r\n",
    shouldPass: true,
  },
  {
    name: "stdout with tput charset reset",
    compareSource: "stdout",
    expected: "OK",
    script: `node -e "process.stdout.write('\\x1b[32mOK\\x1b(B\\x1b[m\\n')"`,
    ptyOutput: "\x1b[32mOK\x1b(B\x1b[m\r\n",
    shouldPass: true,
  },
  {
    name: "stderr fallback",
    compareSource: "stderr",
    expected: "ERR",
    script: `node -e "process.stderr.write('ERR')"`,
    ptyOutput: "this PTY must not be used",
    shouldPass: true,
  },
  {
    name: "stdout numeric gte",
    compareSource: "stdout",
    operator: "gte",
    expected: "80",
    script: `node -e "process.stdout.write('80')"`,
    ptyOutput: "\x1b[36m80\x1b[0m",
    shouldPass: true,
  },
  {
    name: "stdout contains",
    compareSource: "stdout",
    operator: "contains",
    expected: "ASS",
    script: `node -e "process.stdout.write('PASS')"`,
    ptyOutput: "PASS",
    shouldPass: true,
  },
  {
    name: "stdout mismatch",
    compareSource: "stdout",
    expected: "FAIL",
    script: `node -e "process.stdout.write('PASS')"`,
    ptyOutput: "PASS",
    shouldPass: false,
  },
];

function makeContext(
  ptyOutput?: string,
  onPtySpawn?: (options: {
    timeout: number;
    onOutput: (chunk: string) => void;
    onTimeout?: () => void;
  }) => Promise<number>,
  scriptOutputs?: Array<{ stdout: string; stderr: string }>
): WorkflowExecutionContext {
  const integration = new MockHarnessIntegration(undefined, false);
  let context: WorkflowExecutionContext;
  context = {
    executionWorkspace: createNoWorktreeExecutionWorkspace(new MockPlatform()),
    workspaceFolderPath: process.cwd(),
    currentPromptFilePath: "workflow.ctrlyoke.yaml",
    shouldShowCliCommand: false,
    dynamicQueueConfig: {
      maxSteps: 100,
      maxParallelSteps: 6,
      maxWorkflowExecutionTime: 3600,
      notifyOnExtension: false,
    },
    getIntegrationForPrompt: () => integration,
    historyFilePath: "",
    statusReporter: new StatusMessageReporter(
      () => context.dashboardProvider,
      () =>
        context.historyFilePath && context.outputHistoryManager
          ? {
              filePath: context.historyFilePath,
              manager: context.outputHistoryManager,
            }
          : undefined,
      (target, message, severity) => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
          if (target.stepIndex === undefined) {
            throw new Error("Queue status message target requires stepIndex");
          }
          context.onStatusMessage?.(target.stepIndex, message, severity);
        } else {
          if (target.loopIndex === undefined) {
            throw new Error(
              "Final-step status message target requires loopIndex"
            );
          }
          context.onFinalStepStatusMessage?.(
            target.loopIndex,
            message,
            severity
          );
        }
      }
    ),
  };

  if (ptyOutput !== undefined && onPtySpawn === undefined) {
    context.spawnScriptPty = async (options) => {
      options.onOutput(ptyOutput);
      return 0;
    };
  } else if (onPtySpawn !== undefined) {
    context.spawnScriptPty = async (options) =>
      onPtySpawn({
        timeout: options.timeout,
        onOutput: options.onOutput,
        onTimeout: options.onTimeout,
      });
  }

  if (scriptOutputs) {
    const outputHistoryManager = {
      recordScriptExecution: async (
        _historyFilePath: string,
        _target: unknown,
        _runIndex: number,
        _attemptIndex: number,
        output: { stdout: string; stderr: string }
      ) => {
        scriptOutputs.push(output);
      },
    };
    context.historyFilePath = "history.json";
    context.outputHistoryManager = new Proxy(outputHistoryManager, {
      get: (target, property) =>
        Reflect.get(target, property) ?? (async () => undefined),
    }) as never;
  }

  return context;
}

function makeExecutor(queue: PromptQueue): WorkflowExecutor {
  const platform = new MockPlatform();
  const evaluator = new EndConditionEvaluator(platform);
  const handler = new EndConditionHandler(
    evaluator,
    queue,
    new StatusMessageReporter(
      () => undefined,
      () => undefined
    )
  );
  return new WorkflowExecutor(queue, handler, evaluator, platform);
}

async function runCase(
  comparisonCase: ComparisonCase,
  executionMode: "headless" | "interactive"
): Promise<{
  passed: boolean;
  ptyCalls: number;
  outputs: Array<{ stdout: string; stderr: string }>;
}> {
  const queue = new PromptQueue();
  const executor = makeExecutor(queue);
  const outputs: Array<{ stdout: string; stderr: string }> = [];
  let ptyCalls = 0;
  const context = makeContext(
    executionMode === EXECUTION_MODES.INTERACTIVE
      ? comparisonCase.ptyOutput
      : undefined,
    async (options) => {
      ptyCalls++;
      options.onOutput(comparisonCase.ptyOutput);
      return 0;
    },
    outputs
  );

  if (executionMode === EXECUTION_MODES.HEADLESS) {
    context.spawnScriptPty = undefined;
  }

  queue.loadPrompts({
    steps: [
      {
        type: STEP_TYPES.SCRIPT,
        script: comparisonCase.script,
        compareSource: comparisonCase.compareSource,
        operator: comparisonCase.operator,
        expected: comparisonCase.expected,
        executionMode:
          executionMode === EXECUTION_MODES.INTERACTIVE
            ? EXECUTION_MODES.INTERACTIVE
            : EXECUTION_MODES.HEADLESS,
      },
    ],
  });

  await executor.execute(new MockHarnessIntegration(undefined, false), context);

  return {
    passed: queue.getState().results[0]?.status === STEP_STATUS.COMPLETED,
    ptyCalls,
    outputs,
  };
}

suite("interactive script steps", () => {
  test("matches headless verdicts across the comparison matrix", async () => {
    for (const comparisonCase of cases) {
      const headless = await runCase(comparisonCase, "headless");
      const interactive = await runCase(comparisonCase, "interactive");

      assert.strictEqual(
        headless.passed,
        comparisonCase.shouldPass,
        `${comparisonCase.name}: headless verdict`
      );
      assert.strictEqual(
        interactive.passed,
        headless.passed,
        `${comparisonCase.name}: interactive/headless parity`
      );
      if (comparisonCase.compareSource === "stderr") {
        assert.strictEqual(
          interactive.ptyCalls,
          0,
          "stderr comparisons must fall back to headless execution"
        );
      }
    }
  });

  test("persists interactive PTY output without ANSI escapes", async () => {
    const comparisonCase = cases.find(({ name }) => name === "stdout text")!;
    const result = await runCase(comparisonCase, "interactive");

    assert.strictEqual(result.outputs.length, 1);
    assert.strictEqual(result.outputs[0].stdout, "PASS\n");
    assert.doesNotMatch(result.outputs[0].stdout, /\x1b\[/i);
  });

  test("passes timeout to the PTY and reports a timeout after it is killed", async () => {
    const queue = new PromptQueue();
    const executor = makeExecutor(queue);
    let receivedTimeout = 0;
    let timeoutCallbackCalled = false;
    const statusMessages: string[] = [];
    const context = makeContext(undefined, async (options) => {
      receivedTimeout = options.timeout;
      if (options.onTimeout) {
        timeoutCallbackCalled = true;
        options.onTimeout();
      }
      return 1;
    });
    context.onStatusMessage = (_stepIndex, message) => {
      statusMessages.push(message);
    };

    queue.loadPrompts({
      steps: [
        {
          type: STEP_TYPES.SCRIPT,
          script: `node -e "setTimeout(() => {}, 1000)"`,
          executionMode: EXECUTION_MODES.INTERACTIVE,
          timeoutSec: 0.01,
        },
      ],
    });

    await executor.execute(
      new MockHarnessIntegration(undefined, false),
      context
    );

    assert.strictEqual(receivedTimeout, 10);
    assert.strictEqual(timeoutCallbackCalled, true);
    assert.ok(
      statusMessages.some((message) =>
        message.includes("Script step could not run: timed out")
      ),
      statusMessages.join("\n")
    );
  });
});
