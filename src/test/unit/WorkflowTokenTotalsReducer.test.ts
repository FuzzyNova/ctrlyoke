import * as assert from "assert";
import { suite, test } from "mocha";
import {
  ATTEMPT_COST_SOURCES,
  ATTEMPT_COST_CONFIDENCE,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../types/DashboardConstants";
import type { HarnessId } from "../../types/DashboardConstants";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_EVENT_TYPES,
  type AttemptStartedEvent,
  type CliOutputRecordedEvent,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import { WorkflowTokenTotalsReducer } from "../../core/orchestration/WorkflowTokenTotalsReducer";

const QUEUE_TARGET = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
const SECOND_QUEUE_TARGET = {
  kind: FINAL_STEP_PHASES.QUEUE,
  stepIndex: 1,
} as const;
const DYNAMIC_TARGET = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 } as const;
const FINAL_TARGET = {
  kind: FINAL_STEP_PHASES.FINAL_STEP,
  loopIndex: 0,
} as const;

function start(
  sequence: number,
  target: OutputExecutionTarget = QUEUE_TARGET,
  options: Partial<
    Pick<
      AttemptStartedEvent,
      "runId" | "runIndex" | "attemptIndex" | "phase" | "timestampMs"
    >
  > & {
    kind?: AttemptStartedEvent["payload"]["kind"];
  } = {}
): AttemptStartedEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
    workflowId: "workflow",
    runId: options.runId ?? 1,
    sequence,
    timestampMs: options.timestampMs ?? sequence,
    target,
    runIndex: options.runIndex ?? 0,
    attemptIndex: options.attemptIndex ?? 0,
    phase: options.phase,
    definitionRevision: 1,
    payload: {
      kind: options.kind ?? TIMELINE_ATTEMPT_KINDS.AI,
      startReason: TIMELINE_ATTEMPT_START_REASONS.INITIAL,
      prompt: "prompt",
    },
  };
}

function output(
  sequence: number,
  target: OutputExecutionTarget = QUEUE_TARGET,
  options: {
    runId?: number;
    runIndex?: number;
    attemptIndex?: number;
    phase?: CliOutputRecordedEvent["phase"];
    timestampMs?: number;
    total?: number;
    harness?: string;
    prompt?: number;
    completion?: number;
    cached?: number;
    cacheCreated?: number;
    reasoning?: number;
    costUsd?: number;
    costSource?: (typeof ATTEMPT_COST_SOURCES)[keyof typeof ATTEMPT_COST_SOURCES];
  } = {}
): CliOutputRecordedEvent {
  const cliOutput: CliOutput = {
    elapsed: 0,
    isStreaming: sequence < 100,
    timestampMs: options.timestampMs ?? sequence,
    tokens:
      options.total === undefined
        ? undefined
        : {
            prompt: options.prompt ?? 1,
            completion: options.completion ?? 2,
            total: options.total,
            cached: options.cached,
            cacheCreated: options.cacheCreated,
            reasoning: options.reasoning,
            cost:
              options.costUsd === undefined
                ? undefined
                : {
                    usd: options.costUsd,
                    source:
                      options.costSource ?? ATTEMPT_COST_SOURCES.PRICE_TABLE,
                    confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
                  },
          },
    structured: {
      events: [],
      metadata: {},
    },
  };

  // Keep the fixture's malformed-harness case runtime-realistic while avoiding
  // a cast over the production contract for valid harnesses.
  if (options.harness === undefined) {
    delete cliOutput.structured;
  } else {
    cliOutput.structured = {
      events: [],
      metadata: { harness: options.harness as HarnessId },
    };
  }

  return {
    eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
    workflowId: "workflow",
    runId: options.runId ?? 1,
    sequence,
    timestampMs: options.timestampMs ?? sequence,
    target,
    runIndex: options.runIndex,
    attemptIndex: options.attemptIndex ?? 0,
    phase: options.phase,
    responseKind: TIMELINE_ATTEMPT_KINDS.AI,
    payload: { cliOutput },
  };
}

function terminal(sequence: number, runId = 1): WorkflowTimelineEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.RUN_TERMINATED,
    workflowId: "workflow",
    runId,
    sequence,
    timestampMs: sequence,
    payload: { executionState: EXECUTION_STATES.COMPLETED, stepCount: 1 },
  };
}

function localDay(timestampMs: number): string {
  const value = new Date(timestampMs);
  return `${value.getFullYear().toString().padStart(4, "0")}-${(
    value.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${value.getDate().toString().padStart(2, "0")}`;
}

function sumByLocalDay(
  totals: NonNullable<ReturnType<WorkflowTokenTotalsReducer["snapshot"]>>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [day, harnesses] of Object.entries(totals.byLocalDay)) {
    result[day] = Object.values(harnesses).reduce(
      (sum, harness) => sum + (harness?.total ?? 0),
      0
    );
  }
  return result;
}

suite("WorkflowTokenTotalsReducer", () => {
  test("replaces streaming snapshots instead of double-counting them", () => {
    const reducer = new WorkflowTokenTotalsReducer({
      workflowId: "workflow",
      runId: 1,
    });
    const events = [
      start(1),
      output(2, QUEUE_TARGET, { total: 0, harness: HARNESS_IDS.CLAUDE_CLI }),
      output(3, QUEUE_TARGET, { total: 30, harness: HARNESS_IDS.CLAUDE_CLI }),
    ];

    const totals = reducer.reduce(events);
    assert.strictEqual(totals?.total, 30);
    assert.strictEqual(totals?.reportedAttemptCount, 1);
    assert.strictEqual(totals?.byHarness[HARNESS_IDS.CLAUDE_CLI]?.total, 30);
  });

  test("includes retries, manual reruns, final steps, and dynamic AI steps", () => {
    const events: WorkflowTimelineEvent[] = [
      start(1),
      output(2, QUEUE_TARGET, { total: 10, harness: HARNESS_IDS.CLAUDE_CLI }),
      start(3, QUEUE_TARGET, { attemptIndex: 1 }),
      output(4, QUEUE_TARGET, {
        attemptIndex: 1,
        total: 20,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
      start(5, QUEUE_TARGET, { runIndex: 1 }),
      output(6, QUEUE_TARGET, {
        runIndex: 1,
        total: 30,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
      start(7, FINAL_TARGET),
      output(8, FINAL_TARGET, { total: 40, harness: HARNESS_IDS.CLAUDE_CLI }),
      start(9, DYNAMIC_TARGET),
      output(10, DYNAMIC_TARGET, {
        total: 50,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
    ];

    const totals = new WorkflowTokenTotalsReducer(1).reduce(events);
    assert.strictEqual(totals?.total, 150);
    assert.strictEqual(totals?.attemptCount, 5);
    assert.strictEqual(totals?.reportedAttemptCount, 5);
  });

  test("counts AI attempts without output and excludes script attempts", () => {
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1),
      start(2, SECOND_QUEUE_TARGET),
      output(3, SECOND_QUEUE_TARGET, {
        total: 12,
        harness: HARNESS_IDS.CODEX_CLI,
      }),
      start(4, DYNAMIC_TARGET, { kind: TIMELINE_ATTEMPT_KINDS.SCRIPT }),
      output(5, DYNAMIC_TARGET, { total: 90, harness: HARNESS_IDS.CODEX_CLI }),
    ]);

    assert.strictEqual(totals?.total, 12);
    assert.strictEqual(totals?.attemptCount, 2);
    assert.strictEqual(totals?.reportedAttemptCount, 1);
    assert.strictEqual(totals?.coverage, WORKFLOW_TOKEN_COVERAGE.PARTIAL);
  });

  test("marks partial coverage for missing totals and missing harness attribution", () => {
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1),
      output(2, QUEUE_TARGET, { total: 12 }),
      start(3, DYNAMIC_TARGET),
      output(4, DYNAMIC_TARGET, { total: 8, harness: HARNESS_IDS.CODEX_CLI }),
    ]);

    assert.strictEqual(totals?.total, 20);
    assert.strictEqual(totals?.attemptCount, 2);
    assert.strictEqual(totals?.reportedAttemptCount, 2);
    assert.strictEqual(totals?.coverage, WORKFLOW_TOKEN_COVERAGE.PARTIAL);
    assert.deepStrictEqual(Object.keys(totals?.byHarness ?? {}), [
      HARNESS_IDS.CODEX_CLI,
    ]);
  });

  test("keeps attempts isolated to one run", () => {
    const events = [
      start(1, QUEUE_TARGET, { runId: 1 }),
      output(2, QUEUE_TARGET, {
        runId: 1,
        total: 10,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
      start(3, QUEUE_TARGET, { runId: 2 }),
      output(4, QUEUE_TARGET, {
        runId: 2,
        total: 90,
        harness: HARNESS_IDS.CODEX_CLI,
      }),
    ];

    const explicitScope = new WorkflowTokenTotalsReducer(1).reduce(events);
    const inferredScope = new WorkflowTokenTotalsReducer().reduce(events);
    assert.strictEqual(explicitScope?.total, 10);
    assert.strictEqual(inferredScope?.total, 10);
    assert.deepStrictEqual(Object.keys(explicitScope?.byHarness ?? {}), [
      HARNESS_IDS.CLAUDE_CLI,
    ]);
  });

  test("partitions a multi-day run by the attempt start's local day", () => {
    const first = new Date(2026, 0, 1, 23, 55).getTime();
    const second = new Date(2026, 0, 2, 0, 5).getTime();
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1, QUEUE_TARGET, { timestampMs: first }),
      output(2, QUEUE_TARGET, {
        timestampMs: first + 1000,
        total: 10,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
      start(3, DYNAMIC_TARGET, { timestampMs: second }),
      output(4, DYNAMIC_TARGET, {
        timestampMs: second + 1000,
        total: 20,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
    ]);

    assert.ok(totals);
    assert.deepStrictEqual(Object.keys(totals.byLocalDay), [
      localDay(first),
      localDay(second),
    ]);
    assert.strictEqual(
      totals.byLocalDay[localDay(first)][HARNESS_IDS.CLAUDE_CLI]?.total,
      10
    );
    assert.strictEqual(
      totals.byLocalDay[localDay(second)][HARNESS_IDS.CLAUDE_CLI]?.total,
      20
    );
    assert.deepStrictEqual(sumByLocalDay(totals), {
      [localDay(first)]: 10,
      [localDay(second)]: 20,
    });
    assert.strictEqual(totals.byHarness[HARNESS_IDS.CLAUDE_CLI]?.total, 30);
  });

  test("keeps byHarness equal to the byLocalDay sum for mixed harnesses", () => {
    const first = new Date(2026, 1, 1, 10).getTime();
    const second = new Date(2026, 1, 2, 10).getTime();
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1, QUEUE_TARGET, { timestampMs: first }),
      output(2, QUEUE_TARGET, { total: 11, harness: HARNESS_IDS.CLAUDE_CLI }),
      start(3, DYNAMIC_TARGET, { timestampMs: second }),
      output(4, DYNAMIC_TARGET, {
        prompt: 100,
        completion: 2,
        cached: 90,
        total: 12,
        harness: HARNESS_IDS.CODEX_CLI,
      }),
      start(5, FINAL_TARGET),
      output(6, FINAL_TARGET, { total: 13, harness: HARNESS_IDS.QWEN_CLI }),
    ]);

    assert.ok(totals);
    const dayTotals = Object.values(sumByLocalDay(totals)).reduce(
      (sum, value) => sum + value,
      0
    );
    const harnessTotals = Object.values(totals.byHarness).reduce(
      (sum, value) => sum + (value?.total ?? 0),
      0
    );
    assert.strictEqual(harnessTotals, dayTotals);
    for (const [harness, expected] of Object.entries(totals.byHarness)) {
      const partitionedTotal: number = Object.values(totals.byLocalDay).reduce(
        (sum: number, day) => sum + (day[harness as HarnessId]?.total ?? 0),
        0
      );
      assert.strictEqual(partitionedTotal, expected?.total);
    }
    assert.strictEqual(totals.byHarness[HARNESS_IDS.CLAUDE_CLI]?.total, 11);
    assert.strictEqual(totals.byHarness[HARNESS_IDS.CODEX_CLI]?.total, 12);
    assert.strictEqual(totals.byHarness[HARNESS_IDS.QWEN_CLI]?.total, 13);
  });

  test("aggregates cache-netted Codex and Qwen totals without re-netting them", () => {
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1, QUEUE_TARGET),
      output(2, QUEUE_TARGET, {
        prompt: 1_000,
        completion: 100,
        cached: 900,
        total: 200,
        harness: HARNESS_IDS.CODEX_CLI,
      }),
      start(3, SECOND_QUEUE_TARGET),
      output(4, SECOND_QUEUE_TARGET, {
        prompt: 2_000,
        completion: 200,
        cached: 1_800,
        total: 400,
        harness: HARNESS_IDS.QWEN_CLI,
      }),
    ]);

    assert.strictEqual(totals?.total, 600);
    assert.strictEqual(totals?.byHarness[HARNESS_IDS.CODEX_CLI]?.total, 200);
    assert.strictEqual(totals?.byHarness[HARNESS_IDS.QWEN_CLI]?.total, 400);
    assert.strictEqual(
      totals?.byHarness[HARNESS_IDS.CODEX_CLI]?.cachedInput,
      900
    );
    assert.strictEqual(
      totals?.byHarness[HARNESS_IDS.QWEN_CLI]?.cachedInput,
      1_800
    );
  });

  test("does not materialize an aggregate when no attempt has a usable total", () => {
    const totals = new WorkflowTokenTotalsReducer(1).reduce([start(1)]);
    assert.strictEqual(totals, undefined);
  });

  test("tracks terminality without changing usage and supports reopening", () => {
    const reducer = new WorkflowTokenTotalsReducer(1);
    const running = reducer.appendEvents([
      start(1),
      output(2, QUEUE_TARGET, { total: 10, harness: HARNESS_IDS.CLAUDE_CLI }),
    ]);
    assert.strictEqual(running?.isFinal, false);
    assert.strictEqual(reducer.appendEvents([terminal(3)])?.isFinal, true);
    assert.strictEqual(reducer.setFinal(false)?.isFinal, false);
    assert.strictEqual(reducer.snapshot()?.total, 10);
  });

  test("aggregates cost into run, harness, and local-day subtotals", () => {
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1, QUEUE_TARGET, { timestampMs: new Date(2026, 0, 1).getTime() }),
      output(2, QUEUE_TARGET, {
        total: 10,
        harness: HARNESS_IDS.CLAUDE_CLI,
        costUsd: 0.11,
        costSource: ATTEMPT_COST_SOURCES.HARNESS_REPORTED,
      }),
    ]);

    assert.strictEqual(totals?.costUsd, 0.11);
    assert.deepStrictEqual(totals?.costSources, [
      ATTEMPT_COST_SOURCES.HARNESS_REPORTED,
    ]);
    assert.strictEqual(
      totals?.byHarness[HARNESS_IDS.CLAUDE_CLI]?.costUsd,
      0.11
    );
    assert.strictEqual(
      totals?.byLocalDay[localDay(new Date(2026, 0, 1).getTime())]?.[
        HARNESS_IDS.CLAUDE_CLI
      ]?.costUsd,
      0.11
    );
  });

  test("marks cost partial without manufacturing zero for an unpriceable attempt", () => {
    const totals = new WorkflowTokenTotalsReducer(1).reduce([
      start(1),
      output(2, QUEUE_TARGET, {
        total: 10,
        harness: HARNESS_IDS.CLAUDE_CLI,
      }),
    ]);

    assert.strictEqual(totals?.costUsd, undefined);
    assert.strictEqual(totals?.costPartial, true);
    assert.strictEqual(
      totals?.byHarness[HARNESS_IDS.CLAUDE_CLI]?.costUsd,
      undefined
    );
  });
});
