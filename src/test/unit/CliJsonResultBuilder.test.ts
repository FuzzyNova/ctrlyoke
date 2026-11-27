import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import { executionStepText } from "../helpers/stepAssertions";
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
  GUARDRAIL_STOP_CODES,
  PROMPT_TERMINAL_STATUS,
  WORKTREE_LANDING_OUTCOMES,
  WORKTREE_MERGE_OUTCOMES,
  WORKTREE_MODES,
} from "../../types/DashboardConstants";
import type {
  ConditionEvaluationSummary,
  FinalStepRuntimeState,
  PromptFile,
  PromptResult,
  QueueState,
  SubWorkflowOutput,
  SubWorkflowStep,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import { buildDefinitionSnapshot } from "../../core/WorkflowStepSanitizer";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { queueTargetKey } from "../../utils/OutputTargetKeys";
import {
  RunOutputResolver,
  type RunAttemptProjection,
  type RunOutputProjection,
} from "../../core/orchestration/RunOutputResolver";
import {
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  TIMELINE_EVENT_TYPES,
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
      pass: null,
      message: "Harness timed out",
      attempt: 2,
    });
  });

  test("reports the last failed queue step as the terminal error", () => {
    const earlier: WorkflowStep = { prompt: "continued failure" };
    const terminal: WorkflowStep = { prompt: "stopping failure" };
    const output = build({
      steps: [earlier, terminal],
      results: [
        promptResult(earlier, STEP_STATUS.FAILED, {
          error: "continued harness missing",
          failureKind: "harnessNotInstalled",
        }),
        promptResult(terminal, STEP_STATUS.FAILED, {
          error: "terminal failure",
        }),
      ],
      status: EXECUTION_STATES.ERROR,
      promptFile: { steps: [earlier, terminal] },
    });

    assert.deepStrictEqual(output.error, {
      step: 1,
      pass: null,
      message: "terminal failure",
      attempt: 1,
    });
  });

  test("includes final-step timeout kind and reason in JSON", () => {
    const finalStep: WorkflowStep = {
      type: STEP_TYPES.SCRIPT,
      script: "node slow-script.js",
    };
    const output = build({
      steps: [],
      results: [],
      status: EXECUTION_STATES.ERROR,
      promptFile: { steps: [], finalStep },
      finalStepRuntime: {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 0,
        status: STEP_STATUS.FAILED,
        failureKind: "timeout",
        failureMessage: "Script step: timed out after 1033ms",
      },
    });

    assert.deepStrictEqual(
      {
        failureKind: output.finalStep?.failureKind,
        error: output.finalStep?.error,
        topLevel: output.error,
      },
      {
        failureKind: "timeout",
        error: "Script step: timed out after 1033ms",
        topLevel: {
          step: "finalStep",
          pass: 1,
          message: "Script step: timed out after 1033ms",
          attempt: null,
        },
      }
    );
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
      noTurnStarted: 0,
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
      pass: null,
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
        passCount: 2,
        attempts: 3,
        filesChanged: [
          { path: "src/fix.ts", scope: "workspace", operations: ["modified"] },
        ],
        latestPass: finalProjection,
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
        preCondition: condition(true, CONDITION_ACTIONS.CONTINUE),
        endCondition: condition(true),
      },
      outputProjection: projection,
    });

    assert.strictEqual(output.steps.length, 1);
    assert.ok(output.finalStep);
    assert.strictEqual(output.finalStep.passCount, 2);
    assert.strictEqual(output.finalStep.attempts, 3);
    assert.strictEqual(output.finalStep.lastPass?.sessionId, "final-session");
    assert.deepStrictEqual(
      output.finalStep.lastPass?.preCondition,
      conditionJson(true, CONDITION_ACTIONS.CONTINUE)
    );
    assert.deepStrictEqual(
      output.finalStep.lastPass?.endCondition,
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

  test("addresses a settlement recorded before stepId through the step that links its child", () => {
    const childKey = "child-workflow" as WorkflowKey;
    const childRun = "child-run" as RunRef;
    const child: WorkflowStep = {
      type: STEP_TYPES.WORKFLOW,
      workflow: "child.ctrlyoke.json",
      _runtime: {
        stepId: "parent-step-id",
        terminalStatus: "completed",
        childWorkflowKey: childKey,
        childRunRef: childRun,
      },
    };
    const result = build({
      steps: [child],
      results: [],
      status: EXECUTION_STATES.COMPLETED,
      outputProjection: {
        targets: new Map(),
        subWorkflowRuns: [
          {
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
            timestampMs: 1,
            output: {
              childWorkflowKey: childKey,
              childRunRef: childRun,
              outcome: { status: "completed" },
            },
          },
        ],
      },
    });
    assert.deepStrictEqual(result.subWorkflowRuns, [
      {
        stepId: "parent-step-id",
        workflowKey: childKey,
        runRef: childRun,
        status: "completed",
      },
    ]);
  });

  test("includes one final-step child run address for each settled pass", () => {
    const child1 = {
      childWorkflowKey: "child-workflow" as WorkflowKey,
      childRunRef: "child-run-1" as RunRef,
      outcome: { status: "completed" as const },
    };
    const child2 = {
      childWorkflowKey: "child-workflow" as WorkflowKey,
      childRunRef: "child-run-2" as RunRef,
      outcome: { status: "failed" as const },
    };
    const result = build({
      promptFile: {
        finalStep: {
          type: STEP_TYPES.WORKFLOW,
          workflow: "child.ctrlyoke.json",
        },
      } as PromptFile,
      outputProjection: {
        targets: new Map(),
        subWorkflowRuns: [
          {
            target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
            timestampMs: 1,
            output: child1,
          },
          {
            target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 },
            timestampMs: 1,
            output: child2,
          },
        ],
      },
    });

    assert.deepStrictEqual(result.subWorkflowRuns, [
      {
        pass: 1,
        workflowKey: child1.childWorkflowKey,
        runRef: child1.childRunRef,
        status: "completed",
      },
      {
        pass: 2,
        workflowKey: child2.childWorkflowKey,
        runRef: child2.childRunRef,
        status: "failed",
      },
    ]);
  });

  test("serializes each guardrail stop reason at the run level", () => {
    const reasons = [
      [GUARDRAIL_STOP_CODES.QUEUE_SIZE_LIMIT, "steps"],
      [GUARDRAIL_STOP_CODES.WORKFLOW_TIME_LIMIT, "seconds"],
      [GUARDRAIL_STOP_CODES.PROMPT_TIMEOUT, "seconds"],
    ] as const;
    for (const [code, unit] of reasons) {
      const state = makeState([], [], EXECUTION_STATES.ERROR, 1_000, 2_000);
      state.stopReason = {
        code,
        threshold: 10,
        observed: 11,
        unit,
        message: `${code} stop`,
      };
      const output = buildCliJsonResult({ state, workspaceRoot });
      assert.deepStrictEqual(output.stopReason, state.stopReason);
      assert.strictEqual(output.success, false);
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
    prompt: executionStepText(step),
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

suite("CliJsonResultBuilder subWorkflowRuns from timeline events", () => {
  const childKey = "child-workflow" as WorkflowKey;
  let runDirectory: string;
  let manifestPath: string;
  let recorder: TimelineRecorder;
  let timestampMs = 10;

  setup(async () => {
    runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cy-cli-json-"));
    recorder = new TimelineRecorder();
    timestampMs = 10;
  });

  teardown(async () => {
    await fs.rm(runDirectory, { recursive: true, force: true });
  });

  /** Start the run as the executor does: the snapshot has `_runtime` stripped. */
  async function startRun(steps: WorkflowStep[], finalStep?: WorkflowStep) {
    manifestPath = await recorder.initializeRunAt(
      runDirectory,
      workflowKey,
      1,
      1,
      EXECUTION_STATES.RUNNING,
      1,
      buildDefinitionSnapshot("parent", steps, undefined, finalStep)
    );
  }

  /** The events `executeSubWorkflowStep` writes when a child settles. */
  async function settle(
    target: OutputExecutionTarget,
    runIndex: number,
    childRunRef: string,
    status: SubWorkflowOutput["outcome"]["status"],
    stepId?: string,
    childWorkflowKey: WorkflowKey = childKey,
    worktree?: SubWorkflowOutput["worktree"]
  ): Promise<void> {
    const identity = {
      target,
      runIndex,
      attemptIndex: 0,
      definitionRevision: 1,
    };
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED,
        timestampMs: timestampMs++,
        ...identity,
        ...(stepId !== undefined ? { stepId } : {}),
        payload: {
          childWorkflowKey,
          childRunRef: childRunRef as RunRef,
          outcome: { status },
          ...(worktree ? { worktree } : {}),
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: timestampMs++,
        ...identity,
        payload: {
          terminalState:
            status === PROMPT_TERMINAL_STATUS.COMPLETED
              ? TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED
              : status === PROMPT_TERMINAL_STATUS.CANCELLED
                ? TIMELINE_ATTEMPT_TERMINAL_STATES.CANCELLED
                : TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED,
        },
      },
    ]);
  }

  const queue = (stepIndex: number): OutputExecutionTarget => ({
    kind: FINAL_STEP_PHASES.QUEUE,
    stepIndex,
  });
  const pass = (loopIndex: number): OutputExecutionTarget => ({
    kind: FINAL_STEP_PHASES.FINAL_STEP,
    loopIndex,
  });

  function workflowStep(
    stepId: string,
    runtime: Partial<NonNullable<SubWorkflowStep["_runtime"]>> = {}
  ): SubWorkflowStep {
    return {
      type: STEP_TYPES.WORKFLOW,
      workflow: `${stepId}.ctrlyoke.yaml`,
      _runtime: { stepId, childWorkflowKey: childKey, ...runtime },
    };
  }

  async function subWorkflowRuns(
    steps: WorkflowStep[],
    options: {
      finalStep?: WorkflowStep;
      finalStepRuntime?: FinalStepRuntimeState;
    } = {}
  ) {
    const projection = await new RunOutputResolver(
      recorder
    ).resolveAttemptProjection(
      manifestPath,
      steps.map((_step, stepIndex) => queue(stepIndex)),
      options.finalStep ? [pass(0)] : [],
      { workspaceRoot }
    );
    return buildCliJsonResult({
      state: makeState(steps, [], EXECUTION_STATES.COMPLETED, 1_000, 5_000),
      promptFile: { steps, finalStep: options.finalStep },
      workspaceRoot,
      outputProjection: projection,
      finalStepRuntime: options.finalStepRuntime,
    }).subWorkflowRuns;
  }

  const entry = (
    stepId: string,
    runRef: string,
    status: string | null,
    workflowKey: WorkflowKey = childKey
  ) => ({
    stepId,
    workflowKey,
    runRef,
    status,
  });

  test("lists each parallel lane once by stepId with its worktree and merge result", async () => {
    const merged = workflowStep("lane-a");
    const conflicted = workflowStep("lane-b");
    await startRun([merged, conflicted]);
    const mergedWorktree = {
      mode: WORKTREE_MODES.MANAGED,
      branchName: "ctrlyoke/lane-a",
      baseCommit: "base",
      finalBranchTip: "tip-a",
      changedFileCount: 2,
      mergeOutcome: WORKTREE_MERGE_OUTCOMES.FAST_FORWARD,
    };
    const conflictWorktree = {
      mode: WORKTREE_MODES.MANAGED,
      branchName: "ctrlyoke/lane-b",
      baseCommit: "base",
      mergeOutcome: WORKTREE_MERGE_OUTCOMES.CONFLICT,
      conflictFiles: ["src/shared.ts"],
    };
    await settle(
      queue(0),
      0,
      "child-a",
      "completed",
      "lane-a",
      childKey,
      mergedWorktree
    );
    await settle(
      queue(1),
      0,
      "child-b",
      "completed",
      "lane-b",
      childKey,
      conflictWorktree
    );
    merged._runtime = {
      ...merged._runtime,
      childRunRef: "child-a" as RunRef,
      terminalStatus: "completed",
    };
    conflicted._runtime = {
      ...conflicted._runtime,
      childRunRef: "child-b" as RunRef,
      terminalStatus: "completed",
    };

    assert.deepStrictEqual(await subWorkflowRuns([merged, conflicted]), [
      { ...entry("lane-a", "child-a", "completed"), worktree: mergedWorktree },
      {
        ...entry("lane-b", "child-b", "completed"),
        worktree: conflictWorktree,
      },
    ]);
  });

  test("publishes only the contract's worktree fields, not internal ones", async () => {
    const lane = workflowStep("lane-a");
    await startRun([lane]);
    const published = {
      mode: WORKTREE_MODES.MANAGED,
      branchName: "ctrlyoke/lane-a",
      baseCommit: "base",
      landingOutcome: WORKTREE_LANDING_OUTCOMES.LANDED,
    };
    await settle(queue(0), 0, "child-a", "completed", "lane-a", childKey, {
      ...published,
      // Internal worktree record fields a settlement could carry.
      worktreePath: "/repo.worktrees/lane-a",
      lifecycleState: "removed",
    } as SubWorkflowOutput["worktree"]);
    lane._runtime = {
      ...lane._runtime,
      childRunRef: "child-a" as RunRef,
      terminalStatus: "completed",
    };

    assert.deepStrictEqual(await subWorkflowRuns([lane]), [
      { ...entry("lane-a", "child-a", "completed"), worktree: published },
    ]);
  });

  test("lists both child runs of a step that launched two", async () => {
    const step = workflowStep("step-a");
    await startRun([step]);
    await settle(queue(0), 0, "child-1", "failed", "step-a");
    await settle(queue(0), 1, "child-2", "completed", "step-a");
    step._runtime = {
      ...step._runtime,
      childRunRef: "child-2" as RunRef,
      terminalStatus: "completed",
    };

    assert.deepStrictEqual(await subWorkflowRuns([step]), [
      entry("step-a", "child-1", "failed"),
      entry("step-a", "child-2", "completed"),
    ]);
  });

  test("reports one entry with the latest outcome for a child stopped and continued", async () => {
    // onFail: continue settles the parent COMPLETED, so only the child's own
    // outcome can say the continued child failed.
    const step: SubWorkflowStep = {
      ...workflowStep("step-a"),
      onFail: CONDITION_ACTIONS.CONTINUE,
    };
    await startRun([step]);
    await settle(queue(0), 0, "child-1", "cancelled", "step-a");
    await settle(queue(0), 1, "child-1", "failed", "step-a");
    step._runtime = {
      ...step._runtime,
      childRunRef: "child-1" as RunRef,
      terminalStatus: "completed",
    };

    assert.deepStrictEqual(await subWorkflowRuns([step]), [
      entry("step-a", "child-1", "failed"),
    ]);
  });

  test("lists an in-flight child after the step's earlier settled child", async () => {
    const step = workflowStep("step-a");
    await startRun([step]);
    await settle(queue(0), 0, "child-1", "failed", "step-a");
    step._runtime = {
      ...step._runtime,
      startedAt: 20,
      childRunRef: "child-2" as RunRef,
    };

    assert.deepStrictEqual(await subWorkflowRuns([step]), [
      entry("step-a", "child-1", "failed"),
      entry("step-a", "child-2", null),
    ]);
  });

  test("addresses children by stepId after the queue is reordered", async () => {
    const first = workflowStep("step-a");
    const second = workflowStep("step-b");
    await startRun([first, second]);
    await settle(queue(0), 0, "child-a1", "failed", "step-a");
    await settle(queue(0), 1, "child-a2", "failed", "step-a");
    first._runtime = {
      ...first._runtime,
      childRunRef: "child-a2" as RunRef,
      terminalStatus: "failed",
    };

    // step-a now sits at index 1; the events still say stepIndex 0.
    assert.deepStrictEqual(await subWorkflowRuns([second, first]), [
      entry("step-a", "child-a1", "failed"),
      entry("step-a", "child-a2", "failed"),
    ]);
  });

  test("reads an event recorded before stepId through the step that links its child", async () => {
    const first = workflowStep("step-a");
    const second = workflowStep("step-b");
    await startRun([first, second]);
    await settle(queue(0), 0, "child-a", "completed");
    first._runtime = {
      ...first._runtime,
      childRunRef: "child-a" as RunRef,
      terminalStatus: "completed",
    };

    assert.deepStrictEqual(await subWorkflowRuns([second, first]), [
      entry("step-a", "child-a", "completed"),
    ]);
  });

  test("reports the child's outcome, not the parent step's terminal status", async () => {
    const step = workflowStep("step-a");
    await startRun([step]);
    await settle(queue(0), 0, "child-1", "completed", "step-a");
    step._runtime = {
      ...step._runtime,
      childRunRef: "child-1" as RunRef,
      terminalStatus: "failed",
      failureMessage: "parent failed after its child completed",
    };

    assert.deepStrictEqual(await subWorkflowRuns([step]), [
      entry("step-a", "child-1", "completed"),
    ]);
  });

  test("keeps two children that share a runRef apart by their workflowKey", async () => {
    // RunRefs are unique only within one lineage: two lanes with different
    // child workflows can start in the same millisecond.
    const otherKey = "other-workflow" as WorkflowKey;
    const first = workflowStep("step-a");
    const second = workflowStep("step-b", { childWorkflowKey: otherKey });
    await startRun([first, second]);
    await settle(queue(0), 0, "same-run", "completed", "step-a");
    first._runtime = {
      ...first._runtime,
      childRunRef: "same-run" as RunRef,
      terminalStatus: "completed",
      startedAt: 1,
      completedAt: 15,
    };
    second._runtime = {
      ...second._runtime,
      childRunRef: "same-run" as RunRef,
      startedAt: 1,
    };

    assert.deepStrictEqual(await subWorkflowRuns([first, second]), [
      entry("step-a", "same-run", "completed"),
      entry("step-b", "same-run", null, otherKey),
    ]);
  });

  test("attributes events recorded before stepId by workflowKey and runRef", async () => {
    const otherKey = "other-workflow" as WorkflowKey;
    const first = workflowStep("step-a");
    const second = workflowStep("step-b", { childWorkflowKey: otherKey });
    await startRun([first, second]);
    await settle(queue(0), 0, "same-run", "completed");
    await settle(queue(1), 0, "same-run", "failed", undefined, otherKey);
    first._runtime = { ...first._runtime, childRunRef: "same-run" as RunRef };
    second._runtime = { ...second._runtime, childRunRef: "same-run" as RunRef };

    // Reordered, so the recorded indices point at the other step.
    assert.deepStrictEqual(await subWorkflowRuns([second, first]), [
      entry("step-a", "same-run", "completed"),
      entry("step-b", "same-run", "failed", otherKey),
    ]);
  });

  test("reports a continued child that is running again as in flight, then its new outcome", async () => {
    const step = workflowStep("step-a");
    await startRun([step]);
    await settle(queue(0), 0, "child-1", "cancelled", "step-a");
    // D6: the stopped step was rewound and claimed again; the same child run
    // continues.
    step._runtime = {
      ...step._runtime,
      childRunRef: "child-1" as RunRef,
      startedAt: 100,
    };
    assert.deepStrictEqual(await subWorkflowRuns([step]), [
      entry("step-a", "child-1", null),
    ]);

    // The continued execution settles before the step records completion.
    timestampMs = 200;
    await settle(queue(0), 1, "child-1", "completed", "step-a");
    assert.deepStrictEqual(await subWorkflowRuns([step]), [
      entry("step-a", "child-1", "completed"),
    ]);
  });

  test("reports a continued finalStep child that is running again as in flight", async () => {
    const finalStep = workflowStep("final");
    delete finalStep._runtime?.stepId;
    await startRun([], finalStep);
    await settle(pass(0), 0, "child-1", "cancelled");
    finalStep._runtime = {
      ...finalStep._runtime,
      childRunRef: "child-1" as RunRef,
    };

    assert.deepStrictEqual(
      await subWorkflowRuns([], {
        finalStep,
        finalStepRuntime: {
          phase: FINAL_STEP_PHASES.FINAL_STEP,
          loopCount: 0,
          startedAt: 100,
        },
      }),
      [{ pass: 1, workflowKey: childKey, runRef: "child-1", status: null }]
    );
  });

  test("drops an event recorded before stepId whose index no longer holds a workflow step", async () => {
    const prompt: WorkflowStep = { prompt: "p", _runtime: { stepId: "p" } };
    const step = workflowStep("step-a");
    await startRun([step]);
    await settle(queue(0), 0, "child-gone", "completed");

    assert.deepStrictEqual(await subWorkflowRuns([prompt, step]), []);
  });

  test("lists one child per finalStep pass", async () => {
    const finalStep = workflowStep("final");
    delete finalStep._runtime?.stepId;
    await startRun([], finalStep);
    await settle(pass(0), 0, "child-1", "completed");
    await settle(pass(1), 0, "child-2", "failed");
    finalStep._runtime = {
      ...finalStep._runtime,
      childRunRef: "child-2" as RunRef,
    };

    assert.deepStrictEqual(
      await subWorkflowRuns([], {
        finalStep,
        finalStepRuntime: {
          phase: FINAL_STEP_PHASES.QUEUE,
          loopCount: 2,
          status: STEP_STATUS.FAILED,
        },
      }),
      [
        {
          pass: 1,
          workflowKey: childKey,
          runRef: "child-1",
          status: "completed",
        },
        { pass: 2, workflowKey: childKey, runRef: "child-2", status: "failed" },
      ]
    );
  });

  test("never reports a previous pass's child under the running pass", async () => {
    const finalStep = workflowStep("final");
    delete finalStep._runtime?.stepId;
    await startRun([], finalStep);
    await settle(pass(0), 0, "child-1", "completed");
    // Pass 2 is running but has not launched its child yet.
    finalStep._runtime = {
      ...finalStep._runtime,
      childRunRef: "child-1" as RunRef,
    };
    const finalStepRuntime: FinalStepRuntimeState = {
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: 1,
    };

    assert.deepStrictEqual(
      await subWorkflowRuns([], { finalStep, finalStepRuntime }),
      [
        {
          pass: 1,
          workflowKey: childKey,
          runRef: "child-1",
          status: "completed",
        },
      ]
    );

    // Once pass 2 launches its child, that child is in flight under pass 2.
    finalStep._runtime = {
      ...finalStep._runtime,
      childRunRef: "child-2" as RunRef,
    };
    assert.deepStrictEqual(
      await subWorkflowRuns([], { finalStep, finalStepRuntime }),
      [
        {
          pass: 1,
          workflowKey: childKey,
          runRef: "child-1",
          status: "completed",
        },
        { pass: 2, workflowKey: childKey, runRef: "child-2", status: null },
      ]
    );
  });
});
