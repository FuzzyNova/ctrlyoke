import { strict as assert } from "assert";
import { suite, test } from "mocha";
import type {
  EndConditionEvaluator,
  EvaluationResult,
} from "../core/EndConditionEvaluator";
import {
  ScriptExecutionReporter,
  type ScriptExecutionReporterContext,
} from "../core/orchestration/ScriptExecutionReporter";
import {
  EXECUTION_PHASES,
  SCRIPT_OUTPUT_SOURCES,
} from "../types/DashboardConstants";
import type { CliOutput } from "../types/WebviewMessageTypes";

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
      onOutput("chunk");
      return result;
    },
  } as unknown as EndConditionEvaluator;
  const reporter = new ScriptExecutionReporter(evaluator);
  const context: ScriptExecutionReporterContext = {
    workspaceFolderPath: process.cwd(),
    dashboardProvider: {
      updateCliOutput: (_stepIndex: number, output: unknown) => {
        events.push((output as CliOutput).isStreaming ? "placeholder" : "final");
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
  test("emits placeholder, chunks, and final output in order", async () => {
    const events: string[] = [];
    const { reporter, context } = makeReporter(makeResult(), events);

    const report = await reporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
      properties: {
        script: "check.sh",
        compareSource: "stdout",
        returns: "ok",
      },
      phase: EXECUTION_PHASES.PROMPT,
      target: { kind: "queue", stepIndex: 0 },
      signedStepIndex: 0,
      runIndex: 0,
      attemptIndex: 0,
      timestampMs: 100,
      onPass: "continue",
      onFail: "stopWorkflow",
    });

    assert.deepStrictEqual(events, ["placeholder", "chunk", "final"]);
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
      (context as ScriptExecutionReporterContext & {
        cacheRuntimeOutput?: () => void;
      }).cacheRuntimeOutput = () => {
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
        timeoutMs: 10,
      });

      assert.strictEqual(
        report.verdict.outcome,
        result.errored ? "errored" : "failed"
      );
      assert.strictEqual(report.verdict.action, "stopWorkflow");
      assert.strictEqual(report.verdict.actual, result.actual);
      assert.strictEqual(report.verdict.actualSource, result.actualSource);
      assert.strictEqual(report.verdict.matchRule, result.matchRule);
      assert.strictEqual(report.verdict.timedOut, result.timeout);
      assert.strictEqual(report.verdict.error, result.error);
      assert.strictEqual(cacheWrites, 0);
    }
  });
});
