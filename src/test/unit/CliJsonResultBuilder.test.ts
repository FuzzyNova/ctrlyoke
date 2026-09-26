import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";

import {
  buildCliJsonResult,
  buildCliValidationJsonResult,
  type CliJsonResultInput,
} from "../../cli/CliJsonResultBuilder";
import {
  CONDITION_ACTIONS,
  EXECUTION_MODES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  STEP_TYPES,
  WORKFLOW_VALIDATION_WARNING_CODES,
} from "../../types/DashboardConstants";
import type {
  ConditionEvaluationSummary,
  PromptFile,
  PromptResult,
  QueueState,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import {
  queueTargetKey,
  type RunAttemptProjection,
  type RunOutputProjection,
} from "../../core/orchestration/RunOutputResolver";
import {
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
} from "../../types/WorkflowTimelineTypes";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

const workspaceRoot = path.resolve("fixture-workspace");
const workflowKey = "fixture-workflow" as WorkflowKey;
const runRef = "run-fixture" as RunRef;

suite("CliJsonResultBuilder", () => {
  test("builds the versioned compatibility validation envelope", () => {
    const output = buildCliValidationJsonResult({
      success: false,
      parsed: true,
      workflowFile: "workflow.ctrlyoke.yaml",
      target: {
        kind: "harness",
        harnesses: [
          { harnessId: "codex-cli", available: true, version: "1.0.0" },
        ],
      },
      strict: "lossy",
      consumerCount: 2,
      diagnostics: [],
      warnings: [
        {
          code: WORKFLOW_VALIDATION_WARNING_CODES.SCRIPT_COMPARISON_INCOMPLETE,
          message: "Step 1: no value to compare against",
          propertyPointer: "/steps/0/endCondition/expected",
        },
      ],
    });

    assert.deepStrictEqual(output, {
      schemaVersion: 1,
      success: false,
      parsed: true,
      workflowFile: "workflow.ctrlyoke.yaml",
      target: {
        kind: "harness",
        harnesses: [
          { harnessId: "codex-cli", available: true, version: "1.0.0" },
        ],
      },
      strict: "lossy",
      consumerCount: 2,
      diagnostics: [],
      warnings: [
        {
          code: WORKFLOW_VALIDATION_WARNING_CODES.SCRIPT_COMPARISON_INCOMPLETE,
          message: "Step 1: no value to compare against",
          propertyPointer: "/steps/0/endCondition/expected",
        },
      ],
      error: null,
      errorCode: null,
    });
    assert.strictEqual(JSON.stringify(output).split("\n").length, 1);
  });

  test("builds a completed prompt with conditions, attempts, and file changes", () => {
    const step: WorkflowStep = {
      name: "scan",
      prompt: "Scan the repository",
      _runtime: {
        startedAt: 1_002,
        completedAt: 4_000,
        harness: "codex-cli",
        model: "gpt-5",
        executionMode: EXECUTION_MODES.HEADLESS,
        sessionId: "session-1",
      },
    };
    const result: PromptResult = {
      prompt: step.prompt,
      status: STEP_STATUS.COMPLETED,
      timestamp: new Date(1_002),
      preCondition: condition(true, CONDITION_ACTIONS.CONTINUE),
      endCondition: condition(true),
    };
    const projection = attemptProjection(0, {
      attempts: 1,
      terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED,
      terminalReason: undefined,
    });
    projection.filesChanged = [
      { path: "src/auth.ts", scope: "workspace", operations: ["modified"] },
    ];

    const output = build({
      steps: [step],
      results: [result],
      outputProjection: projectionMap([[queueTargetKey(0), projection]]),
      promptFile: { steps: [step], vars: { repoPath: "secret-value" } },
    });

    assert.strictEqual(output.success, true);
    assert.deepStrictEqual(output.varNames, ["repoPath"]);
    assert.deepStrictEqual(output.steps[0], {
      index: 0,
      name: "scan",
      parallelGroupId: null,
      type: "prompt",
      enabled: true,
      harness: "codex-cli",
      model: "gpt-5",
      executionMode: "headless",
      status: "completed",
      success: true,
      attempts: 1,
      lastAttempt: {
        number: 1,
        startReason: "initial",
        terminalState: "completed",
        reason: null,
      },
      startedAt: "1970-01-01T00:00:01.002Z",
      completedAt: "1970-01-01T00:00:04.000Z",
      durationMs: 2_998,
      sessionId: "session-1",
      preCondition: conditionJson(true, CONDITION_ACTIONS.CONTINUE),
      filesChanged: [
        { path: "src/auth.ts", scope: "workspace", operations: ["modified"] },
      ],
      endCondition: conditionJson(true, null),
      failureKind: null,
      error: null,
    });
    assert.strictEqual(output.steps[0].error, null);
    assert.strictEqual(JSON.stringify(output).includes("secret-value"), false);
  });

  test("builds a failed prompt and selects its top-level error", () => {
    const step: WorkflowStep = {
      prompt: "Fail",
      _runtime: {
        startedAt: 2_000,
        completedAt: 2_500,
        harness: "claude-cli",
        model: "claude-sonnet",
        executionMode: EXECUTION_MODES.HEADLESS,
        failureKind: "timeout",
        failureMessage: "Harness timed out",
      },
    };
    const result = promptResult(step, STEP_STATUS.FAILED, {
      error: "Harness timed out",
    });
    const output = build({
      steps: [step],
      results: [result],
      status: EXECUTION_STATES.ERROR,
      outputProjection: projectionMap([
        [
          queueTargetKey(0),
          attemptProjection(0, {
            attempts: 2,
            startReason: TIMELINE_ATTEMPT_START_REASONS.RETRY,
            terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED,
            terminalReason: "timeout",
          }),
        ],
      ]),
      promptFile: { steps: [step] },
    });

    assert.strictEqual(output.success, false);
    assert.strictEqual(output.steps[0].success, false);
    assert.strictEqual(output.steps[0].failureKind, "timeout");
    assert.deepStrictEqual(output.error, {
      step: 0,
      loop: null,
      message: "Harness timed out",
      attempt: 2,
    });
  });

  test("keeps skipped, pending, and disabled steps in queue order", () => {
    const skipped: WorkflowStep = { prompt: "skipped" };
    const pending: WorkflowStep = { prompt: "pending" };
    const disabled: WorkflowStep = { prompt: "disabled", enabled: false };
    const output = build({
      steps: [skipped, pending, disabled],
      results: [
        promptResult(skipped, STEP_STATUS.SKIPPED),
        promptResult(pending, STEP_STATUS.PENDING),
        promptResult(disabled, STEP_STATUS.PENDING),
      ],
      promptFile: { steps: [skipped, pending, disabled] },
    });

    assert.deepStrictEqual(
      output.steps.map((step) => [
        step.index,
        step.status,
        step.enabled,
        step.success,
      ]),
      [
        [0, "skipped", true, null],
        [1, "pending", true, null],
        [2, "pending", false, null],
      ]
    );
    assert.strictEqual(output.steps[0].lastAttempt, null);
    assert.strictEqual(output.steps[1].lastAttempt, null);
    assert.deepStrictEqual(output.summary, {
      total: 3,
      completed: 0,
      failed: 0,
      skipped: 2,
    });
  });

  test("projects script output without AI-only fields", () => {
    const step: WorkflowStep = {
      type: STEP_TYPES.SCRIPT,
      name: "tests",
      script: "npm test",
      _runtime: {
        startedAt: 3_000,
        completedAt: 3_250,
        executionMode: EXECUTION_MODES.HEADLESS,
      },
    };
    const projection = attemptProjection(0, {
      attempts: 1,
      terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED,
    });
    projection.scriptOutput = {
      command: "npm test",
      stdout: "all passed",
      stderr: "",
      exitCode: 0,
    };
    const output = build({
      steps: [step],
      results: [promptResult(step, STEP_STATUS.COMPLETED)],
      outputProjection: projectionMap([[queueTargetKey(0), projection]]),
      promptFile: { steps: [step] },
    });

    assert.deepStrictEqual(output.steps[0].script, {
      command: "npm test",
      stdout: "all passed",
      stderr: "",
      exitCode: 0,
    });
    assert.strictEqual(output.steps[0].harness, null);
    assert.strictEqual(output.steps[0].model, null);
    assert.strictEqual(output.steps[0].sessionId, null);
    assert.strictEqual(output.steps[0].executionMode, "headless");
    assert.strictEqual(output.steps[0].preCondition, null);
    assert.strictEqual(output.steps[0].endCondition, null);
  });

  test("uses effective per-step harness, model, and execution mode overrides", () => {
    const step: WorkflowStep = {
      prompt: "Override",
      _runtime: {
        startedAt: 4_000,
        completedAt: 4_100,
        harness: "claude-cli",
        model: "claude-opus",
        executionMode: EXECUTION_MODES.INTERACTIVE,
      },
    };
    const output = build({
      steps: [step],
      results: [promptResult(step, STEP_STATUS.COMPLETED)],
      promptFile: { steps: [step] },
    });
    assert.strictEqual(output.steps[0].harness, "claude-cli");
    assert.strictEqual(output.steps[0].model, "claude-opus");
    assert.strictEqual(output.steps[0].executionMode, "interactive");
  });

  test("uses null for unavailable timestamps and durations", () => {
    const step: WorkflowStep = { prompt: "No timestamps" };
    const output = build({
      steps: [step],
      results: [promptResult(step, STEP_STATUS.PENDING)],
      promptFile: { steps: [step] },
      startTime: undefined,
      executionEndTime: undefined,
      noTimestamps: true,
    });
    assert.strictEqual(output.startedAt, null);
    assert.strictEqual(output.completedAt, null);
    assert.strictEqual(output.durationMs, null);
    assert.strictEqual(output.steps[0].startedAt, null);
    assert.strictEqual(output.steps[0].completedAt, null);
    assert.strictEqual(output.steps[0].durationMs, null);
  });

  test("emits a JSON-safe setup error envelope", () => {
    const output = build({
      error: new Error("parse failed"),
      promptFile: undefined,
    });
    const parsed = JSON.parse(JSON.stringify(output)) as typeof output;
    assert.deepStrictEqual(parsed.error, {
      step: null,
      loop: null,
      message: "parse failed",
      attempt: null,
    });
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.status, "error");
    assert.deepStrictEqual(parsed.steps, []);
  });

  test("keeps external file paths explicitly scoped", () => {
    const step: WorkflowStep = { prompt: "Files" };
    const externalPath = path.resolve("approved-external", "report.json");
    const projection = attemptProjection(0, {
      attempts: 1,
      terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED,
    });
    projection.filesChanged = [
      {
        path: path.join(workspaceRoot, "src", "a.ts"),
        scope: "workspace",
        operations: ["modified"],
      },
      { path: externalPath, scope: "external", operations: ["created"] },
    ];
    const output = build({
      steps: [step],
      results: [promptResult(step, STEP_STATUS.COMPLETED)],
      outputProjection: projectionMap([[queueTargetKey(0), projection]]),
      promptFile: { steps: [step] },
    });
    assert.deepStrictEqual(output.steps[0].filesChanged, [
      { path: "src/a.ts", scope: "workspace", operations: ["modified"] },
      {
        path: externalPath.replace(/\\/g, "/"),
        scope: "external",
        operations: ["created"],
      },
    ]);
  });

  test("reports final-step loops separately from queue steps", () => {
    const queueStep: WorkflowStep = { prompt: "queue" };
    const finalStep: WorkflowStep = {
      prompt: "fix until green",
      _runtime: {
        startedAt: 5_000,
        completedAt: 8_000,
        harness: "codex-cli",
        model: "gpt-5",
        executionMode: EXECUTION_MODES.HEADLESS,
        sessionId: "final-session",
      },
    };
    const finalProjection = attemptProjection(1, {
      attempts: 2,
      terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED,
    });
    const projection: RunOutputProjection = {
      targets: new Map(),
      finalStep: {
        loopCount: 2,
        attempts: 3,
        filesChanged: [
          { path: "src/fix.ts", scope: "workspace", operations: ["modified"] },
        ],
        latestLoop: finalProjection,
      },
    };
    const output = build({
      steps: [queueStep],
      results: [promptResult(queueStep, STEP_STATUS.COMPLETED)],
      promptFile: { steps: [queueStep], finalStep },
      finalStepRuntime: {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 1,
        status: STEP_STATUS.COMPLETED,
        startedAt: 5_000,
        completedAt: 8_000,
        endCondition: condition(true),
      },
      outputProjection: projection,
    });

    assert.strictEqual(output.steps.length, 1);
    assert.ok(output.finalStep);
    assert.strictEqual(output.finalStep.loopCount, 2);
    assert.strictEqual(output.finalStep.attempts, 3);
    assert.strictEqual(output.finalStep.lastLoop?.sessionId, "final-session");
    assert.deepStrictEqual(
      output.finalStep.lastLoop?.endCondition,
      conditionJson(true, null)
    );
  });

  test("serializes success and thrown-error envelopes as one JSON document", () => {
    const success = build({
      steps: [{ prompt: "complete" }],
      results: [promptResult({ prompt: "complete" }, STEP_STATUS.COMPLETED)],
      status: EXECUTION_STATES.COMPLETED,
    });
    const thrownError = build({ error: new Error("fixture parse failure") });

    for (const [result, expectedStatus] of [
      [success, EXECUTION_STATES.COMPLETED],
      [thrownError, EXECUTION_STATES.ERROR],
    ] as const) {
      const stdout = JSON.stringify(result) + "\n";
      assert.strictEqual(stdout.endsWith("\n"), true);
      assert.strictEqual(stdout.slice(0, -1).includes("\n"), false);
      assert.deepStrictEqual(JSON.parse(stdout), result);
      assert.strictEqual(result.status, expectedStatus);
    }
  });
});

function build(overrides: {
  steps?: WorkflowStep[];
  results?: PromptResult[];
  promptFile?: PromptFile;
  outputProjection?: RunOutputProjection;
  finalStepRuntime?: CliJsonResultInput["finalStepRuntime"];
  startTime?: number;
  executionEndTime?: number;
  error?: unknown;
  status?: QueueState["status"];
  noTimestamps?: boolean;
}): ReturnType<typeof buildCliJsonResult> {
  const steps = overrides.steps ?? [];
  const results =
    overrides.results ??
    steps.map((step) => promptResult(step, STEP_STATUS.PENDING));
  return buildCliJsonResult({
    state:
      overrides.error === undefined
        ? makeState(
            steps,
            results,
            overrides.status ?? EXECUTION_STATES.COMPLETED,
            overrides.noTimestamps ? undefined : (overrides.startTime ?? 1_000),
            overrides.noTimestamps
              ? undefined
              : (overrides.executionEndTime ?? 5_000)
          )
        : undefined,
    promptFile: overrides.promptFile,
    harness: "codex-cli",
    model: "gpt-5",
    workflowFileReference: "fixture.ctrlyoke.yaml",
    workspaceRoot,
    workflowKey,
    runRef,
    outputProjection: overrides.outputProjection,
    finalStepRuntime: overrides.finalStepRuntime,
    error: overrides.error,
  });
}

function makeState(
  steps: WorkflowStep[],
  results: PromptResult[],
  status: QueueState["status"],
  startTime: number | undefined,
  executionEndTime: number | undefined
): QueueState {
  return {
    status,
    stopped: false,
    startTime,
    executionEndTime,
    pausedTime: undefined,
    totalPausedDuration: 0,
    currentIndex: steps.length,
    steps,
    parallelGroups: [],
    results,
    completedIndices: new Set(steps.map((_, index) => String(index))),
    totalExecutionTime: 4_000,
    queueExtensions: 0,
    definitionRevision: 1,
    workflowKey,
    runRef,
  };
}

function promptResult(
  step: WorkflowStep,
  status: PromptResult["status"],
  overrides: Partial<PromptResult> = {}
): PromptResult {
  return {
    prompt: "prompt" in step ? step.prompt : step.script,
    status,
    timestamp: new Date(1_000),
    ...overrides,
  };
}

function condition(
  passed: boolean,
  action?: ConditionEvaluationSummary["action"]
): ConditionEvaluationSummary {
  return {
    passed,
    action,
    script: "test -d src",
    actual: passed ? "0" : "1",
    stdout: passed ? "" : "not found",
    stderr: "",
    exitCode: passed ? 0 : 1,
    durationMs: 4,
    error: undefined,
  };
}

function conditionJson(
  passed: boolean,
  action: ConditionEvaluationSummary["action"] | null
) {
  return {
    passed,
    action,
    script: "test -d src",
    actual: passed ? "0" : "1",
    compareSource: null,
    operator: null,
    stdout: passed ? "" : "not found",
    stderr: "",
    exitCode: passed ? 0 : 1,
    durationMs: 4,
    error: null,
  };
}

function attemptProjection(
  index: number,
  overrides: Partial<RunAttemptProjection["latestAttempt"]> & {
    attempts: number;
  }
): RunAttemptProjection {
  return {
    target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: index },
    attempts: overrides.attempts,
    latestAttempt: {
      number: overrides.attempts,
      startReason:
        overrides.startReason ?? TIMELINE_ATTEMPT_START_REASONS.INITIAL,
      terminalState: overrides.terminalState,
      terminalReason: overrides.terminalReason,
    },
    filesChanged: [],
  };
}

function projectionMap(
  entries: Array<[string, RunAttemptProjection]>
): RunOutputProjection {
  return { targets: new Map(entries) };
}
