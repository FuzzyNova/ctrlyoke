import { strict as assert } from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import type {
  EndConditionEvaluator,
  EvaluationResult,
} from "../core/EndConditionEvaluator";
import {
  ScriptExecutionReporter,
  type ScriptExecutionReporterContext,
} from "../core/orchestration/ScriptExecutionReporter";
import { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import { StatusMessageReporter } from "../core/orchestration/StatusMessageReporter";
import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_HISTORY_KINDS,
  SCRIPT_OUTPUT_SOURCES,
} from "../types/DashboardConstants";
import type { CliOutput } from "../types/WebviewMessageTypes";
import { TIMELINE_EVENT_TYPES } from "../types/WorkflowTimelineTypes";
import type {
  OrderedCliHistoryEntry,
  OutputExecutionTarget,
} from "../types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";

const temporaryDirectories: string[] = [];
const outputHistoryManagers: OutputHistoryManager[] = [];

teardown(async () => {
  await Promise.all(
    outputHistoryManagers
      .splice(0)
      .map((manager) => manager.flushPendingIndexRefresh())
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

function makeResult(
  overrides: Partial<EvaluationResult> = {}
): EvaluationResult {
  return {
    passed: true,
    matchRule: "exact",
    actual: "ok",
    actualSource: "stdout",
    errored: false,
    stdout: "ok",
    stderr: "",
    result: "ok",
    duration: 12,
    exitCode: 0,
    ...overrides,
  };
}

function makeReporter(result: EvaluationResult, events: string[]) {
  const evaluator = {
    evaluateCondition: async (
      _condition: unknown,
      _workingDirectory: string | undefined,
      _vars: Record<string, string> | undefined,
      onOutput: (chunk: string) => void
    ) => {
      onOutput("\u001b[36mchunk\u001b[39m\u0007");
      return result;
    },
  } as unknown as EndConditionEvaluator;
  const reporter = new ScriptExecutionReporter(evaluator);
  const context: ScriptExecutionReporterContext = {
    workspaceFolderPath: process.cwd(),
    statusReporter: new StatusMessageReporter(
      () => undefined,
      () => undefined
    ),
    dashboardProvider: {
      updateCliOutput: (_stepIndex: number, output: unknown) => {
        events.push(
          (output as CliOutput).isStreaming ? "placeholder" : "final"
        );
      },
      updateCliStreamingChunk: (_stepIndex: number, chunk: string) => {
        events.push(chunk);
      },
      updateStatusMessage: () => undefined,
    } as any,
  };
  return { reporter, context };
}

suite("ScriptExecutionReporter", () => {
  test("emits placeholder, chunks, and final output for all four sources", async () => {
    const cases = [
      {
        source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
        phase: EXECUTION_PHASES.PROMPT,
        attemptIndex: 0,
      },
      {
        source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
        phase: EXECUTION_PHASES.PRE_CONDITION,
        attemptIndex: 0,
      },
      {
        source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
        phase: EXECUTION_PHASES.END_CONDITION,
        attemptIndex: 0,
      },
      {
        source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
        phase: EXECUTION_PHASES.END_CONDITION,
        attemptIndex: 1,
      },
    ] as const;

    for (const execution of cases) {
      const events: string[] = [];
      const { reporter, context } = makeReporter(makeResult(), events);

      const report = await reporter.report({
        context,
        source: execution.source,
        properties: {
          script: "check.sh",
          compareSource: "stdout",
          returns: "ok",
        },
        phase: execution.phase,
        target: { kind: "queue", stepIndex: 0 },
        signedStepIndex: 0,
        runIndex: 0,
        attemptIndex: execution.attemptIndex,
        timestampMs: 100,
        onPass: "continue",
        onFail: "stopWorkflow",
        actionForErrored: "stopWorkflow",
      });

      assert.deepStrictEqual(events, ["placeholder", "chunk", "final"]);
      assert.strictEqual(report.finalOutput.source, execution.source);
      assert.deepStrictEqual(report.verdict, {
        compareSource: "stdout",
        expected: "ok",
        actual: "ok",
        actualSource: "stdout",
        exitCode: 0,
        outcome: "passed",
        matchRule: "exact",
        action: "continue",
        actionDetail: undefined,
        durationMs: 12,
        timedOut: undefined,
        error: undefined,
      });
    }
  });

  test("persists a worktree setup output entry in its own phase", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-script-reporter-")
    );
    temporaryDirectories.push(temporaryDirectory);
    const historyManager = new OutputHistoryManager(temporaryDirectory);
    outputHistoryManagers.push(historyManager);
    const historyFilePath = (
      await historyManager.initializeRunAt(
        "reporter-test" as WorkflowKey,
        "run-1" as RunRef,
        path.join(temporaryDirectory, "run"),
        1,
        Date.now()
      )
    ).filePath;
    const events: string[] = [];
    const { reporter, context } = makeReporter(makeResult(), events);
    context.historyFilePath = historyFilePath;
    context.outputHistoryManager = historyManager;

    await reporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP,
      properties: {
        script: "npm ci",
        compareSource: "exitCode",
      },
      phase: EXECUTION_PHASES.WORKTREE_SETUP,
      target: { kind: "queue", stepIndex: 0 },
      signedStepIndex: 0,
      runIndex: 0,
      attemptIndex: 0,
      timestampMs: 100,
      onPass: "continue",
      onFail: "stopWorkflow",
      actionForErrored: "stopWorkflow",
      evaluate: async (onOutput) => {
        onOutput("installing\n");
        return makeResult({
          actual: "0",
          actualSource: "exitCode",
          stdout: "installing\n",
          result: "installing\n",
        });
      },
    });

    assert.deepStrictEqual(events, ["placeholder", "installing\n", "final"]);
    const history = await historyManager.loadHistory(historyFilePath);
    const setupEntry = history.orderedEntries.find(
      (entry): entry is OrderedCliHistoryEntry =>
        entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
        entry.phase === EXECUTION_PHASES.WORKTREE_SETUP
    );
    assert.ok(setupEntry);
    assert.strictEqual(setupEntry?.attemptIndex, 0);

    const eventLines = await fs.readFile(
      path.join(path.dirname(historyFilePath), "events.jsonl"),
      "utf8"
    );
    const scriptEvent = eventLines
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { eventType: string; phase?: string })
      .find(
        (event) =>
          event.eventType === TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED
      );
    assert.strictEqual(scriptEvent?.phase, EXECUTION_PHASES.WORKTREE_SETUP);
  });

  test("keeps setup output attempt-indexed and isolated to each run history", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-script-reporter-rerun-")
    );
    temporaryDirectories.push(temporaryDirectory);
    const historyManager = new OutputHistoryManager(temporaryDirectory);
    outputHistoryManagers.push(historyManager);
    const firstHistoryFilePath = (
      await historyManager.initializeRunAt(
        "reporter-rerun" as WorkflowKey,
        "run-1" as RunRef,
        path.join(temporaryDirectory, "run-1"),
        1,
        100
      )
    ).filePath;
    const secondHistoryFilePath = (
      await historyManager.initializeRunAt(
        "reporter-rerun" as WorkflowKey,
        "run-2" as RunRef,
        path.join(temporaryDirectory, "run-2"),
        2,
        200
      )
    ).filePath;

    const reportSetup = async (
      historyFilePath: string,
      command: string,
      timestampMs: number
    ) => {
      const { reporter, context } = makeReporter(makeResult(), []);
      context.historyFilePath = historyFilePath;
      context.outputHistoryManager = historyManager;
      await reporter.report({
        context,
        source: SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP,
        properties: { script: command, compareSource: "exitCode" },
        phase: EXECUTION_PHASES.WORKTREE_SETUP,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        signedStepIndex: 0,
        runIndex: 0,
        attemptIndex: 0,
        timestampMs,
        onPass: "continue",
        onFail: "stopWorkflow",
        actionForErrored: "stopWorkflow",
        evaluate: async () =>
          makeResult({
            actual: "0",
            actualSource: "exitCode",
            stdout: `${command}\n`,
            result: `${command}\n`,
          }),
      });
    };

    await reportSetup(firstHistoryFilePath, "setup-first", 100);
    const firstEventsBefore = await fs.readFile(
      path.join(path.dirname(firstHistoryFilePath), "events.jsonl"),
      "utf8"
    );
    await reportSetup(secondHistoryFilePath, "setup-second", 200);

    const firstHistory = await historyManager.loadHistory(firstHistoryFilePath);
    const secondHistory = await historyManager.loadHistory(
      secondHistoryFilePath
    );
    const findSetupEntry = (
      history: Awaited<ReturnType<OutputHistoryManager["loadHistory"]>>
    ) =>
      history.orderedEntries.find(
        (entry): entry is OrderedCliHistoryEntry =>
          entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
          entry.phase === EXECUTION_PHASES.WORKTREE_SETUP
      );
    const firstSetup = findSetupEntry(firstHistory);
    const secondSetup = findSetupEntry(secondHistory);

    assert.strictEqual(firstSetup?.attemptIndex, 0);
    assert.strictEqual(firstSetup?.cliOutput.cliCommand, "setup-first");
    assert.strictEqual(secondSetup?.attemptIndex, 0);
    assert.strictEqual(secondSetup?.cliOutput.cliCommand, "setup-second");
    assert.strictEqual(
      await fs.readFile(
        path.join(path.dirname(firstHistoryFilePath), "events.jsonl"),
        "utf8"
      ),
      firstEventsBefore
    );
  });

  test("sanitizes final-step streaming chunks before dashboard delivery", async () => {
    const chunks: string[] = [];
    const evaluator = {
      evaluateCondition: async (
        _condition: unknown,
        _workingDirectory: string | undefined,
        _vars: Record<string, string> | undefined,
        onOutput: (chunk: string) => void
      ) => {
        onOutput("\u001b[32mpassed\u001b[0m\r\nnext\u0007");
        return makeResult();
      },
    } as unknown as EndConditionEvaluator;
    const reporter = new ScriptExecutionReporter(evaluator);
    const context: ScriptExecutionReporterContext = {
      statusReporter: new StatusMessageReporter(
        () => undefined,
        () => undefined
      ),
      dashboardProvider: {
        updateFinalStepOutput: () => undefined,
        updateFinalStepStreamingChunk: (_loopIndex: number, chunk: string) => {
          chunks.push(chunk);
        },
        updateStatusMessage: () => undefined,
      } as any,
    };

    await reporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
      properties: {
        script: "check.sh",
        compareSource: "stdout",
        returns: "ok",
      },
      phase: EXECUTION_PHASES.END_CONDITION,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      signedStepIndex: -1,
      runIndex: 0,
      attemptIndex: 0,
      timestampMs: 100,
      onPass: "continue",
      onFail: "stopWorkflow",
      actionForErrored: "stopWorkflow",
    });

    assert.deepStrictEqual(chunks, ["passed\nnext"]);
  });

  test("maps failed and errored evaluations to complete verdicts without caching output", async () => {
    for (const result of [
      makeResult({
        passed: false,
        matchRule: "substring",
        actual: "bad",
        stdout: "bad",
        result: "bad",
        exitCode: 1,
      }),
      {
        ...makeResult({
          passed: false,
          matchRule: "none",
          actual: "",
          actualSource: "stderr",
          stdout: "",
          stderr: "spawn failed",
          result: "",
          errored: true,
          error: "spawn failed",
          timeout: true,
          exitCode: undefined,
        }),
      },
    ]) {
      const events: string[] = [];
      const { reporter, context } = makeReporter(result, events);
      let cacheWrites = 0;
      (
        context as ScriptExecutionReporterContext & {
          cacheRuntimeOutput?: () => void;
        }
      ).cacheRuntimeOutput = () => {
        cacheWrites += 1;
      };

      const report = await reporter.report({
        context,
        source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
        properties: {
          script: "check.sh",
          compareSource: result.actualSource,
          returns: "expected",
        },
        phase: EXECUTION_PHASES.PROMPT,
        target: { kind: "queue", stepIndex: 0 },
        signedStepIndex: 0,
        runIndex: 0,
        attemptIndex: 0,
        timestampMs: 100,
        onPass: "continue",
        onFail: "stopWorkflow",
        actionForErrored: result.errored ? "continue" : "stopWorkflow",
        timeoutMs: 10,
      });

      assert.strictEqual(
        report.verdict.outcome,
        result.errored ? "errored" : "failed"
      );
      assert.strictEqual(
        report.verdict.action,
        result.errored ? "continue" : "stopWorkflow"
      );
      assert.strictEqual(report.verdict.actual, result.actual);
      assert.strictEqual(report.verdict.actualSource, result.actualSource);
      assert.strictEqual(report.verdict.matchRule, result.matchRule);
      assert.strictEqual(report.verdict.timedOut, result.timeout);
      assert.strictEqual(report.verdict.error, result.error);
      assert.strictEqual(cacheWrites, 0);
    }
  });

  test("preserves action detail for a passing retry verdict", async () => {
    const events: string[] = [];
    const { reporter, context } = makeReporter(makeResult(), events);

    const report = await reporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
      properties: {
        script: "check.sh",
        compareSource: "stdout",
        returns: "ok",
      },
      phase: EXECUTION_PHASES.END_CONDITION,
      target: { kind: "queue", stepIndex: 0 },
      signedStepIndex: 0,
      runIndex: 0,
      attemptIndex: 1,
      timestampMs: 100,
      onPass: "retry",
      onFail: "continue",
      actionForErrored: "stopWorkflow",
      actionDetail: (result) =>
        result.passed ? "retry 1 of 3" : "retry failure detail",
    });

    assert.strictEqual(report.verdict.action, "retry");
    assert.strictEqual(report.verdict.actionDetail, "retry 1 of 3");
  });

  test("coalesces stdout chunks into one streaming update, flushed before the final output", async () => {
    const events: string[] = [];
    const evaluator = {
      evaluateCondition: async (
        _condition: unknown,
        _workingDirectory: string | undefined,
        _vars: Record<string, string> | undefined,
        onOutput: (chunk: string) => void
      ) => {
        // Stand in for a process emitting many small stdout packets in a burst.
        for (let index = 0; index < 25; index++) {
          onOutput(`line ${index}\n`);
        }
        return makeResult();
      },
    } as unknown as EndConditionEvaluator;
    const reporter = new ScriptExecutionReporter(evaluator);
    const context: ScriptExecutionReporterContext = {
      workspaceFolderPath: process.cwd(),
      statusReporter: new StatusMessageReporter(
        () => undefined,
        () => undefined
      ),
      dashboardProvider: {
        updateCliOutput: (_stepIndex: number, output: unknown) => {
          events.push(
            (output as CliOutput).isStreaming ? "placeholder" : "final"
          );
        },
        updateCliStreamingChunk: (_stepIndex: number, chunk: string) => {
          events.push(`chunk:${chunk.length}`);
        },
        updateStatusMessage: () => undefined,
      } as any,
    };

    await reporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
      properties: {
        script: "npm test",
        compareSource: "exitCode",
      },
      phase: EXECUTION_PHASES.PRE_CONDITION,
      target: { kind: "queue", stepIndex: 0 },
      signedStepIndex: 0,
      runIndex: 0,
      attemptIndex: 0,
      timestampMs: 100,
      onPass: "continue",
      onFail: "stopWorkflow",
      actionForErrored: "stopWorkflow",
    });

    const expectedLength = Array.from(
      { length: 25 },
      (_value, index) => `line ${index}\n`
    ).join("").length;

    assert.deepStrictEqual(events, [
      "placeholder",
      `chunk:${expectedLength}`,
      "final",
    ]);
  });

  test("flushes the history manager's own streaming buffer before dispatching the completed output", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-script-reporter-flush-")
    );
    temporaryDirectories.push(temporaryDirectory);
    const historyManager = new OutputHistoryManager(temporaryDirectory);
    outputHistoryManagers.push(historyManager);
    const historyFilePath = (
      await historyManager.initializeRunAt(
        "reporter-flush-test" as WorkflowKey,
        "run-1" as RunRef,
        path.join(temporaryDirectory, "run"),
        1,
        Date.now()
      )
    ).filePath;

    // A registered activity handler is what routes chunks through the
    // history manager's own StreamingHistoryBuffer instead of the direct
    // dashboard push — matching a real WorkflowInstance, which always
    // registers one. That buffer only writes on a size/age cap, so nothing
    // publishes this single small chunk until it is explicitly flushed.
    const events: string[] = [];
    historyManager.setOutputActivityHandler((entry) => {
      if (entry.kind === OUTPUT_ACTIVITY_KINDS.TEXT) {
        events.push(`activity:${entry.text}`);
      }
    });

    const evaluator = {
      evaluateCondition: async (
        _condition: unknown,
        _workingDirectory: string | undefined,
        _vars: Record<string, string> | undefined,
        onOutput: (chunk: string) => void
      ) => {
        onOutput("chunk");
        return makeResult({ stdout: "chunk" });
      },
    } as unknown as EndConditionEvaluator;
    const reporter = new ScriptExecutionReporter(evaluator);
    const context: ScriptExecutionReporterContext = {
      workspaceFolderPath: process.cwd(),
      historyFilePath,
      outputHistoryManager: historyManager,
      statusReporter: new StatusMessageReporter(
        () => undefined,
        () => undefined
      ),
      dashboardProvider: {
        updateCliOutput: (_stepIndex: number, output: unknown) => {
          events.push(
            (output as CliOutput).isStreaming ? "placeholder" : "final"
          );
        },
        updateCliStreamingChunk: () => undefined,
        updateStatusMessage: () => undefined,
      } as any,
    };

    await reporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
      properties: {
        script: "check.sh",
        compareSource: "exitCode",
      },
      phase: EXECUTION_PHASES.PROMPT,
      target: { kind: "queue", stepIndex: 0 },
      signedStepIndex: 0,
      runIndex: 0,
      attemptIndex: 0,
      timestampMs: 100,
      onPass: "continue",
      onFail: "stopWorkflow",
      actionForErrored: "stopWorkflow",
    });

    assert.deepStrictEqual(events, ["placeholder", "activity:chunk", "final"]);
  });

  test("fans out delegated status messages for queue and final-step targets", async () => {
    const statusMessages: Array<{
      target: unknown;
      message: string;
      severity: string;
    }> = [];
    const evaluator = {
      evaluateCondition: async () => makeResult(),
    } as unknown as EndConditionEvaluator;
    const reporter = new ScriptExecutionReporter(evaluator);
    const context: ScriptExecutionReporterContext = {
      statusReporter: new StatusMessageReporter(
        () => undefined,
        () => undefined,
        (target, message, severity) => {
          statusMessages.push({ target, message, severity });
        }
      ),
    };

    const report = (target: OutputExecutionTarget) =>
      reporter.report({
        context,
        source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
        properties: {
          script: "check.sh",
          compareSource: "stdout",
          returns: "ok",
        },
        phase: EXECUTION_PHASES.END_CONDITION,
        target,
        signedStepIndex:
          target.kind === FINAL_STEP_PHASES.QUEUE
            ? target.stepIndex!
            : -(target.loopIndex! + 1),
        runIndex: 0,
        attemptIndex: 0,
        timestampMs: 100,
        onPass: "continue",
        onFail: "stopWorkflow",
        actionForErrored: "stopWorkflow",
      });

    await report({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 });
    await report({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 });

    assert.deepStrictEqual(
      statusMessages.map(({ target, severity }) => ({ target, severity })),
      [
        {
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
          severity: "info",
        },
        {
          target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 },
          severity: "info",
        },
      ]
    );
  });
});
