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
import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  SCRIPT_OUTPUT_SOURCES,
} from "../types/DashboardConstants";
import type { CliOutput } from "../types/WebviewMessageTypes";
import { TIMELINE_EVENT_TYPES } from "../types/WorkflowTimelineTypes";
import type {
  OrderedCliHistoryEntry,
} from "../types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";

const temporaryDirectories: string[] = [];

teardown(async () => {
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
});
