import { getStepOutputText } from "../../utils/StepOutputText";
import { StepOutputTextMode } from "../../types/DashboardConstants";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { LifetimeUsageStore } from "../../core/harness/shared/usage/LifetimeUsageStore";
import { ObservedHarnessUsageStore } from "../../core/harness/shared/usage/ObservedHarnessUsageStore";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { HistorySearchService } from "../../core/orchestration/HistorySearchService";
import { getSharedHistorySearchIndexService } from "../../core/orchestration/HistorySearchIndexServiceRegistry";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import { PromptQueue } from "../../core/PromptQueue";
import { buildDefinitionSnapshot } from "../../core/WorkflowStepSanitizer";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import { clearRunSummaryCache } from "../../core/orchestration/RunSummaryCache";
import {
  EXECUTION_PHASES,
  EXECUTION_STATES,
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  GUARDRAIL_STOP_CODES,
  HARNESS_IDS,
  OUTPUT_HISTORY_KINDS,
  PROMPT_TERMINAL_STATUS,
  SNAPSHOT_BASE_SOURCES,
  SNAPSHOT_STRATEGIES,
  UNDO_FILE_ACTIONS,
  WORKFLOW_RUNTIME_COMMANDS,
} from "../../types/DashboardConstants";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_STORAGE_FILES,
  TIMELINE_STORAGE_KIND,
  type WorkflowRunManifest,
} from "../../types/WorkflowTimelineTypes";
import type {
  OutputActivityEntry,
  WorkspaceSnapshot,
} from "../../types/OutputHistoryTypes";
import type { CliEvent } from "../../types/CliOutputTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  RunRef,
  WorkflowKey,
  WorkflowTokenTotals,
  WorkflowStep,
  WorkingFile,
} from "../../types/CtrlYokeTypes";

let nextTestRunOrdinal = 0;

function expectActivityEntries(
  live: readonly {
    sequence: number;
    timestampMs: number;
    target: unknown;
    kind: string;
    text?: string;
    events?: CliEvent[];
  }[],
  replay: readonly {
    sequence: number;
    timestampMs: number;
    target: unknown;
    kind: string;
    text?: string;
    events?: CliEvent[];
  }[]
): void {
  assert.deepStrictEqual(
    replay.map(({ sequence, timestampMs, target, kind, text, events }) => ({
      sequence,
      timestampMs,
      target,
      kind,
      text,
      events,
    })),
    live.map(({ sequence, timestampMs, target, kind, text, events }) => ({
      sequence,
      timestampMs,
      target,
      kind,
      text,
      events,
    }))
  );
}

/**
 * Test-only shim: allocates a workflowKey + runRef under `workspaceRoot` and
 * initializes a run via the new WorkflowLineageRepository-driven API, returning
 * the same `{ filePath, runCount }` shape the old single-arg `initializeRun`
 * used to return (plus `workflowKey`/`runRef` for callers that need identity).
 */
async function initTestRun(
  manager: OutputHistoryManager,
  workspaceRoot: string,
  nameHint: string,
  options: { runId?: number; startedAt?: number } = {}
): Promise<{
  filePath: string;
  runCount: number;
  workflowKey: WorkflowKey;
  runRef: ReturnType<typeof WorkflowPaths.formatRunRef>;
}> {
  const workflowKey = (
    await new WorkflowLineageRepository().createLineage(
      workspaceRoot,
      nameHint,
      nameHint
    )
  ).workflowKey;
  const runRef = WorkflowPaths.formatRunRef(Date.now() + nextTestRunOrdinal++);
  const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
  const result = await manager.initializeRunAt(
    workflowKey,
    runRef,
    runDir,
    options.runId ?? 1,
    options.startedAt ?? Date.now()
  );
  return { ...result, workflowKey, runRef };
}

/** Adds another run directly under an already-allocated workflowKey (via TimelineRecorder, bypassing WorkflowLineageRepository's descriptor bookkeeping — these tests only need the run directories to exist). */
async function initAdditionalRun(
  recorder: TimelineRecorder,
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runId: number,
  startedAt: number
): Promise<RunRef> {
  const runRef = WorkflowPaths.formatRunRef(startedAt + nextTestRunOrdinal++);
  const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
  await recorder.initializeRunAt(
    runDir,
    workflowKey,
    runId,
    startedAt,
    EXECUTION_STATES.COMPLETED
  );
  return runRef;
}

suite("OutputHistoryManager timeline-backed storage", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;
  let recorder: TimelineRecorder;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cy-history-"));
    manager = new OutputHistoryManager(tempWorkspace);
    recorder = new TimelineRecorder();
  });

  teardown(async () => {
    await manager.flushPendingIndexRefresh();
    clearRunSummaryCache();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("strips wire-only scriptOutput before persisting the CLI aggregate", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wire-only-script-output"
    );
    await manager.saveExecutionOutput(
      filePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "script result" } }],
            metadata: {},
          },
          scriptOutput: {
            command: "npm test",
            stdout: "script result",
            stderr: "",
            exitCode: 0,
          },
          elapsed: 0,
          isStreaming: false,
        },
      ]
    );
    const events = await recorder.readEvents(filePath);
    const recorded = events.find(
      (event) => event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
    );
    assert.ok(
      recorded &&
        recorded.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
    );
    assert.ok(!("scriptOutput" in recorded.payload.cliOutput));
  });

  test("run summaries expose working-file step count while a manifest is still empty", async () => {
    const { filePath, workflowKey, runRef } = await initTestRun(
      manager,
      tempWorkspace,
      "running-step-count"
    );
    const runFilePath = WorkflowPaths.runFilePath(
      tempWorkspace,
      workflowKey,
      runRef
    );
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        steps: [{ prompt: "first" }, { prompt: "second" }],
        _runtime: {
          currentIndex: 0,
          executionState: EXECUTION_STATES.RUNNING,
        },
      })
    );

    const manifest = await recorder.readManifest(filePath);
    const [summary] = await manager.getRunSummaries(workflowKey);

    assert.strictEqual(manifest.stepCount, 0);
    assert.strictEqual(summary?.executionState, EXECUTION_STATES.RUNNING);
    assert.strictEqual(summary?.workingFileStepCount, 2);
  });

  test("shares one history search index service per workspace", async () => {
    const equivalentWorkspacePath = path.join(tempWorkspace, ".");
    const otherWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-history-other-")
    );
    const secondManager = new OutputHistoryManager(equivalentWorkspacePath);
    const otherManager = new OutputHistoryManager(otherWorkspace);

    try {
      assert.strictEqual(
        getSharedHistorySearchIndexService(tempWorkspace),
        getSharedHistorySearchIndexService(equivalentWorkspacePath)
      );
      if (process.platform === "win32") {
        assert.strictEqual(
          getSharedHistorySearchIndexService(tempWorkspace),
          getSharedHistorySearchIndexService(tempWorkspace.toUpperCase())
        );
      }
      assert.notStrictEqual(
        getSharedHistorySearchIndexService(tempWorkspace),
        getSharedHistorySearchIndexService(otherWorkspace)
      );
      await secondManager.flushPendingIndexRefresh();
      await otherManager.flushPendingIndexRefresh();
    } finally {
      await fs.rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  // Regression: timeline v2 stopped writing `CliOutput.prompt`, and the
  // dashboard's prompt row vanished because nothing else carried the prompt
  // to it. `ATTEMPT_STARTED` is now the single record of it.
  test("loads each attempt's ATTEMPT_STARTED prompt onto its history entry", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-attempt-prompt"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const output = (attemptIndex: number, isStreaming: boolean) => ({
      elapsed: 0,
      isStreaming,
      timestampMs: 100 + attemptIndex,
      runIndex: 0,
      attemptIndex,
      structured: { events: [], metadata: {} },
    });

    await manager.startStreamingExecutionOutput(
      filePath,
      target,
      output(0, true),
      undefined,
      { kind: "ai", startReason: "initial", prompt: "Fix the bug" }
    );
    await manager.saveExecutionOutput(filePath, target, [output(0, false)]);
    await manager.startStreamingExecutionOutput(
      filePath,
      target,
      output(1, true),
      undefined,
      { kind: "ai", startReason: "retry", prompt: "Try again" }
    );

    const history = await manager.loadHistory(filePath);
    const prompts = history.orderedEntries.map((entry) =>
      entry.kind === OUTPUT_HISTORY_KINDS.CLI
        ? [entry.attemptIndex, entry.prompt]
        : undefined
    );
    assert.deepStrictEqual(prompts.filter(Boolean), [
      [0, "Fix the bug"],
      [1, "Try again"],
    ]);
  });

  test("persists replacement snapshots, preserves same-run history across reopen, and finalizes both copies", async () => {
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-token-persistence"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const output = (total: number) => ({
      elapsed: 0,
      isStreaming: false,
      timestampMs: 100,
      runIndex: 0,
      attemptIndex: 0,
      structured: { events: [], metadata: { harness: HARNESS_IDS.CLAUDE_CLI } },
      tokens: { prompt: total - 1, completion: 1, total },
    });

    await manager.startStreamingExecutionOutput(filePath, target, output(10));
    await manager.saveExecutionOutput(filePath, target, [output(30)]);

    let manifest = await recorder.readManifest(filePath);
    assert.strictEqual(manifest.tokenTotals?.total, 30);
    assert.strictEqual(manifest.tokenTotals?.reportedAttemptCount, 1);

    await manager.finalizeRun(filePath, EXECUTION_STATES.COMPLETED, 1, 1234);
    manifest = await recorder.readManifest(filePath);
    assert.strictEqual(manifest.tokenTotals?.isFinal, true);
    assert.strictEqual(manifest.activeExecutionMs, 1234);

    await manager.reopenRun(filePath, EXECUTION_STATES.RUNNING, 1, 1);
    manifest = await recorder.readManifest(filePath);
    assert.strictEqual(manifest.tokenTotals?.isFinal, false);

    const runFilePath = WorkflowPaths.runFilePath(
      tempWorkspace,
      workflowKey,
      runRef
    );
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        workflowName: "wf-token-persistence",
        startedAt: 1,
        definitionRevision: 1,
        steps: [{ prompt: "prompt" }],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.RUNNING,
          tokenTotals: manifest.tokenTotals,
        },
      }),
      "utf8"
    );
    const restartedManager = new OutputHistoryManager(tempWorkspace);
    let tokenTotalsChangedCalls = 0;
    restartedManager.setTokenTotalsChangedHandler(() => {
      tokenTotalsChangedCalls += 1;
    });
    const recovered = await restartedManager.hydrateTokenTotals(filePath);
    assert.strictEqual(recovered?.total, 30);
    assert.strictEqual(
      tokenTotalsChangedCalls,
      0,
      "hydrating totals already present in the manifest must not notify the queue"
    );
    assert.strictEqual(
      (await restartedManager.hydrateTokenTotals(filePath))?.total,
      30
    );
    const [summary] = await manager.getRunSummaries(workflowKey);
    assert.strictEqual(summary?.tokenTotals?.total, 30);
    assert.strictEqual(summary?.tokenTotals?.isFinal, false);
  });

  test("workflow-list summaries use persisted totals without reading historical events", async () => {
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-list-no-events"
    );
    const tokenTotals: WorkflowTokenTotals = {
      total: 42,
      coverage: "complete",
      reportedAttemptCount: 1,
      attemptCount: 1,
      isFinal: true,
      byHarness: {},
      byLocalDay: {},
    };
    await fs.writeFile(
      WorkflowPaths.runFilePath(tempWorkspace, workflowKey, runRef),
      JSON.stringify({
        workflowName: "wf-list-no-events",
        startedAt: 1,
        definitionRevision: 1,
        steps: [{ prompt: "prompt" }],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.COMPLETED,
          tokenTotals,
        },
      }),
      "utf8"
    );
    await manager.finalizeRun(filePath, EXECUTION_STATES.COMPLETED, 1);
    const recorderForTest = (
      manager as unknown as {
        timelineRecorder: { streamEvents: () => AsyncGenerator<never> };
      }
    ).timelineRecorder;
    recorderForTest.streamEvents = async function* () {
      throw new Error("workflow-list must not scan events.jsonl");
    };

    const [summary] = await manager.getRunSummaries(workflowKey);
    assert.strictEqual(summary?.tokenTotals?.total, 42);
  });

  test("run summaries carry the run's pause-aware active execution time", async () => {
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-active-time"
    );
    await fs.writeFile(
      WorkflowPaths.runFilePath(tempWorkspace, workflowKey, runRef),
      JSON.stringify({
        workflowName: "wf-active-time",
        startedAt: 1,
        definitionRevision: 1,
        steps: [{ prompt: "prompt" }],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.COMPLETED,
          startTime: 10_000,
          totalPausedDuration: 30_000,
          executionEndTime: 160_000,
        },
      }),
      "utf8"
    );
    // The working file is fresher than the manifest's finalize-time copy.
    await manager.finalizeRun(filePath, EXECUTION_STATES.COMPLETED, 1, 1);

    const [summary] = await manager.getRunSummaries(workflowKey);
    assert.strictEqual(summary?.activeExecutionMs, 120_000);
  });

  test("run summaries fall back to the manifest's active time when the working file has no timing", async () => {
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-active-time-fallback"
    );
    await fs.writeFile(
      WorkflowPaths.runFilePath(tempWorkspace, workflowKey, runRef),
      JSON.stringify({
        workflowName: "wf-active-time-fallback",
        startedAt: 1,
        definitionRevision: 1,
        steps: [{ prompt: "prompt" }],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.COMPLETED,
        },
      }),
      "utf8"
    );
    await manager.finalizeRun(filePath, EXECUTION_STATES.COMPLETED, 1, 45_000);

    const [summary] = await manager.getRunSummaries(workflowKey);
    assert.strictEqual(summary?.activeExecutionMs, 45_000);
  });

  test("startup recovery repairs a missing working-file aggregate without double-counting", async () => {
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-recovery-totals"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await manager.startStreamingExecutionOutput(filePath, target, {
      elapsed: 0,
      isStreaming: false,
      timestampMs: 100,
      structured: { events: [], metadata: { harness: HARNESS_IDS.CLAUDE_CLI } },
      tokens: { prompt: 10, completion: 5, total: 15 },
    });
    await fs.writeFile(
      WorkflowPaths.runFilePath(tempWorkspace, workflowKey, runRef),
      JSON.stringify({
        workflowName: "wf-recovery-totals",
        startedAt: 1,
        definitionRevision: 1,
        steps: [{ prompt: "prompt" }],
        _runtime: { currentIndex: 1, executionState: EXECUTION_STATES.RUNNING },
      }),
      "utf8"
    );

    await manager.recoverInterruptedRun(workflowKey, runRef, 1);
    const repaired = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(tempWorkspace, workflowKey, runRef),
        "utf8"
      )
    ) as { _runtime?: { tokenTotals?: WorkflowTokenTotals } };
    assert.strictEqual(repaired._runtime?.tokenTotals?.total, 15);
    assert.strictEqual(repaired._runtime?.tokenTotals?.isFinal, true);

    await manager.recoverInterruptedRun(workflowKey, runRef, 1);
    const manifest = await recorder.readManifest(filePath);
    assert.strictEqual(manifest.tokenTotals?.total, 15);
  });

  /**
   * Client A and client B both view a lineage; B edits one run. The summary
   * listing is cached per run, so the edit must refresh that run and leave the
   * other runs' cached records untouched — a lineage-wide invalidation would be
   * correct but would throw away the whole point.
   *
   * Reference identity is the assertion because it is the only thing that can
   * distinguish "re-read and produced an equal value" from "served from cache".
   */
  test("an edit to one run refreshes only that run's cached summary", async () => {
    const { workflowKey, runRef: oldest } = await initTestRun(
      manager,
      tempWorkspace,
      "cache-granularity"
    );
    const base = Date.now() + 100_000;
    const middle = await initAdditionalRun(
      recorder,
      tempWorkspace,
      workflowKey,
      2,
      base
    );
    const newest = await initAdditionalRun(
      recorder,
      tempWorkspace,
      workflowKey,
      3,
      base + 100_000
    );

    const writeDefinition = async (runRef: RunRef, harness: string) =>
      fs.writeFile(
        WorkflowPaths.runFilePath(tempWorkspace, workflowKey, runRef),
        JSON.stringify(
          { definitionRevision: 1, steps: [{ prompt: "step", harness }] },
          null,
          2
        )
      );
    await writeDefinition(oldest, HARNESS_IDS.COPILOT_CLI);
    await writeDefinition(middle, HARNESS_IDS.CLAUDE_CLI);
    await writeDefinition(newest, HARNESS_IDS.CODEX_CLI);

    const before = await manager.getRunSummaries(workflowKey);
    assert.deepStrictEqual(
      before.map((summary) => summary.primaryHarness),
      [HARNESS_IDS.CODEX_CLI, HARNESS_IDS.CLAUDE_CLI, HARNESS_IDS.COPILOT_CLI],
      "newest first, one summary per run"
    );

    await WorkingFileManager.insertStepAtRun(
      tempWorkspace,
      workflowKey,
      middle,
      0,
      { prompt: "appended", harness: HARNESS_IDS.QWEN_CLI } as WorkflowStep,
      1
    );

    const after = await manager.getRunSummaries(workflowKey);

    assert.strictEqual(
      after[1].hasMixedHarnesses,
      true,
      "the edited run must disclose the harness the appended step added"
    );
    assert.notStrictEqual(
      after[1],
      before[1],
      "the edited run must have been re-read"
    );
    assert.strictEqual(
      after[0],
      before[0],
      "a run nobody touched must still be served from cache"
    );
    assert.strictEqual(after[2], before[2]);
  });

  test("initializes new runs as manifest plus events.jsonl storage", async () => {
    const historyInit = await initTestRun(manager, tempWorkspace, "wf-test");

    assert.strictEqual(historyInit.runCount, 1);
    assert.strictEqual(
      path.basename(historyInit.filePath),
      TIMELINE_STORAGE_FILES.MANIFEST
    );

    const manifest = JSON.parse(
      await fs.readFile(historyInit.filePath, "utf8")
    ) as WorkflowRunManifest;

    assert.strictEqual(manifest.storageKind, TIMELINE_STORAGE_KIND);
    assert.strictEqual(manifest.workflowId, historyInit.workflowKey);
    assert.strictEqual(manifest.runId, 1);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.RUNNING);
    assert.strictEqual(manifest.eventCount, 0);
    assert.strictEqual(manifest.nextSequence, 1);

    const events = await recorder.readEvents(historyInit.filePath);
    assert.deepStrictEqual(events, []);
  });

  test("serializes the normalized attempt lifecycle and records follow-up content once, as replayable activity", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-events");
    const target = {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      loopIndex: 4,
    } as const;
    const definition = {
      workflowName: "timeline contract",
      steps: [{ prompt: "first definition" }],
    };
    const definitionContext = { definitionRevision: 2, definition };
    const largeFollowUp = "x".repeat(256 * 1024);
    const queueTarget = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    } as const;

    // Fresh AI, a failed attempt, pause/resume, and a same-run restart are
    // deliberately serialized independently of the final-step loop below.
    await manager.startStreamingExecutionOutput(
      filePath,
      queueTarget,
      {
        structured: {
          events: [{ type: "text", data: { text: "" } }],
          metadata: {},
        },
        elapsed: 0,
        isStreaming: true,
        timestampMs: 90,
        runIndex: 0,
        attemptIndex: 0,
      },
      definitionContext,
      { kind: "ai", startReason: "initial", prompt: "queue prompt" }
    );
    await manager.recordAttemptTerminal(
      filePath,
      queueTarget,
      0,
      0,
      "failed",
      definitionContext,
      "harness failed"
    );
    await manager.appendRuntimeTransition(filePath, {
      command: "pause",
      previous: {
        status: EXECUTION_STATES.RUNNING,
        stopped: false,
        totalPausedDuration: 0,
      },
      current: {
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        totalPausedDuration: 0,
      },
      timestampMs: 91,
    });
    await manager.appendRuntimeTransition(filePath, {
      command: "resume",
      previous: {
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        totalPausedDuration: 0,
      },
      current: {
        status: EXECUTION_STATES.RUNNING,
        stopped: false,
        totalPausedDuration: 0,
      },
      timestampMs: 92,
    });

    await manager.startStreamingExecutionOutput(
      filePath,
      target,
      {
        structured: {
          events: [{ type: "text", data: { text: "" } }],
          metadata: {},
        },
        elapsed: 0,
        isStreaming: true,
        timestampMs: 100,
        runIndex: 3,
        attemptIndex: 1,
      },
      definitionContext,
      { kind: "ai", startReason: "resumed", prompt: "final prompt" }
    );
    await manager.recordRetryScheduled(
      filePath,
      target,
      3,
      2,
      1,
      "retry using the validation output",
      definitionContext
    );
    await manager.startStreamingExecutionOutput(
      filePath,
      target,
      {
        structured: {
          events: [{ type: "text", data: { text: "" } }],
          metadata: {},
        },
        elapsed: 0,
        isStreaming: true,
        timestampMs: 110,
        runIndex: 3,
        attemptIndex: 2,
        source: "script",
      },
      definitionContext,
      { kind: "script", startReason: "retry", prompt: "script final prompt" }
    );
    await manager.recordScriptExecution(
      filePath,
      target,
      3,
      2,
      { command: "npm test", stdout: "ok", stderr: "", exitCode: 0 },
      definitionContext
    );
    await manager.recordFollowUpResponse(
      filePath,
      target,
      3,
      2,
      largeFollowUp,
      [
        {
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: 120,
          data: { text: largeFollowUp },
        },
      ],
      { used: 32, size: 128 },
      definitionContext
    );
    await manager.recordAttemptTerminal(
      filePath,
      target,
      3,
      2,
      "cancelled",
      definitionContext,
      "user cancelled"
    );
    await manager.finalizeRun(filePath, EXECUTION_STATES.STOPPED, 1);

    const events = await recorder.readEvents(filePath);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED,
        TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
        TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
        TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.RETRY_SCHEDULED,
        TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
        TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
        TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        TIMELINE_EVENT_TYPES.RUN_TERMINATED,
      ]
    );
    const attempt = events[6];
    assert.strictEqual(
      attempt?.eventType,
      TIMELINE_EVENT_TYPES.ATTEMPT_STARTED
    );
    if (attempt?.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED) {
      assert.deepStrictEqual(attempt.target, target);
      assert.strictEqual(attempt.runIndex, 3);
      assert.strictEqual(attempt.attemptIndex, 1);
      assert.strictEqual(attempt.definitionRevision, 2);
      assert.deepStrictEqual(attempt.payload, {
        kind: "ai",
        startReason: "resumed",
        prompt: "final prompt",
      });
    }
    const followUp = events[12];
    assert.strictEqual(
      followUp?.eventType,
      TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED
    );
    if (
      followUp?.eventType === TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED
    ) {
      assert.deepStrictEqual(followUp.payload, {
        responseTextLength: largeFollowUp.length,
        eventCount: 1,
        contextWindow: { used: 32, size: 128 },
      });
    }

    // The marker stays content-free, but the events themselves must land in a
    // replayable streamed-events batch: history load renders an attempt from
    // its activity entries and drops the aggregate they stand in for, so a
    // follow-up recorded only as counts vanished on the next reload.
    const followUpActivity = events[13];
    assert.strictEqual(
      followUpActivity?.eventType,
      TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
    );
    if (
      followUpActivity?.eventType ===
      TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
    ) {
      assert.deepStrictEqual(followUpActivity.target, target);
      assert.strictEqual(followUpActivity.runIndex, 3);
      assert.strictEqual(followUpActivity.attemptIndex, 2);
      assert.deepStrictEqual(followUpActivity.payload.events, [
        {
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: 120,
          data: { text: largeFollowUp },
        },
      ]);
    }

    const rawEvents = await fs.readFile(
      path.join(path.dirname(filePath), TIMELINE_STORAGE_FILES.EVENTS),
      "utf8"
    );
    assert.strictEqual(
      rawEvents.split(largeFollowUp).length - 1,
      1,
      "follow-up content belongs in the streamed-events batch only, never duplicated into the marker"
    );
    assert.deepStrictEqual(
      JSON.parse(rawEvents.trim().split(/\r?\n/)[15] ?? "{}"),
      events[15]
    );

    const manifest = await recorder.readManifest(filePath);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.STOPPED);
    assert.strictEqual(manifest.definitionRevision, 2);
  });

  test("projects timeline events back into WorkflowOutputHistory shape", async () => {
    const historyInit = await initTestRun(manager, tempWorkspace, "wf-test");
    const historyFilePath = historyInit.filePath;

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        message: "started",
        severity: "info",
        timestamp: 110,
      }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "draft" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 100,
          attemptIndex: 0,
        },
      ]
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "final" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 120,
          attemptIndex: 0,
        },
      ]
    );

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        message: "done",
        severity: "info",
        timestamp: 130,
      }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      []
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "final-ok" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 200,
        },
      ]
    );

    await manager.saveSnapshotForTarget(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        capturedAt: 150,
        strategy: "filesystem",
        changedFiles: [],
      }
    );

    await manager.saveUndoRecord(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        appliedAt: 160,
        restoredFiles: ["src/file.ts"],
        redoInstructions: [
          { path: "src/file.ts", action: UNDO_FILE_ACTIONS.DELETE },
        ],
      }
    );

    await manager.markUndoRecordRedone(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      170,
      ["src/file.ts"]
    );

    await manager.finalizeRun(historyFilePath, EXECUTION_STATES.COMPLETED, 2);

    const loaded = await manager.loadHistory(historyFilePath);
    // CLI output for queue:0 is the final deduplicated one (attemptIndex=0).
    const queueCliEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.CLI &&
        e.target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e.target as any).stepIndex === 0
    );
    assert.strictEqual(queueCliEntries.length, 1);
    assert.strictEqual(
      getStepOutputText(
        { output: (queueCliEntries[0] as any).cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "final"
    );

    const queueStatusEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        e.target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e.target as any).stepIndex === 0
    );
    assert.strictEqual(queueStatusEntries.length, 2);

    const finalCliEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.CLI &&
        e.target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
        (e.target as any).loopIndex === 0
    );
    assert.strictEqual(finalCliEntries.length, 1);

    assert.strictEqual(
      loaded.promptOutputs[0]?.workspaceSnapshot?.capturedAt,
      150
    );
    assert.strictEqual(loaded.promptOutputs[0]?.undoRecord?.isRedone, true);
    assert.strictEqual(loaded.promptOutputs[0]?.undoRecord?.redoneAt, 170);
    assert.strictEqual(loaded.executionState, EXECUTION_STATES.COMPLETED);
    assert.deepStrictEqual(
      loaded.orderedEntries.map((entry) => entry.kind),
      ["status", "cli", "status", "cli"]
    );
    assert.strictEqual(loaded.orderedEntries[1]?.kind, "cli");
    if (loaded.orderedEntries[1]?.kind !== OUTPUT_HISTORY_KINDS.CLI) {
      assert.fail("expected second ordered entry to be cli output");
    }
    assert.strictEqual(
      getStepOutputText(
        { output: loaded.orderedEntries[1].cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "final"
    );
    assert.strictEqual(loaded.orderedEntries[1].sequence, 3);

    const events = await recorder.readEvents(historyFilePath);
    assert.strictEqual(events.length, 9);
    assert.deepStrictEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED,
        TIMELINE_EVENT_TYPES.UNDO_APPLIED,
        TIMELINE_EVENT_TYPES.REDO_APPLIED,
        TIMELINE_EVENT_TYPES.RUN_TERMINATED,
      ]
    );
    assert.ok(events.every((event) => typeof event.timestampMs === "number"));
  });

  test("durably projects in-flight chunks and parsed events on graceful shutdown", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-streaming"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

    await manager.startStreamingExecutionOutput(filePath, target, {
      structured: {
        events: [{ type: "text", data: { text: "" } }],
        metadata: {},
      },
      elapsed: 0,
      isStreaming: true,
      timestampMs: 100,
      runIndex: 0,
      attemptIndex: 0,
    });
    await manager.appendStreamingChunk(filePath, target, 0, 0, "raw ");
    await manager.appendStreamingEvents(filePath, target, 0, 0, [
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: 110,
        data: { text: "parsed" },
      },
    ]);
    // Streamed deltas are coalesced; the shutdown path is what lands them.
    await manager.flushPendingWrites(filePath);

    const interrupted = await manager.loadHistory(filePath);
    const interruptedOutput = interrupted.orderedEntries.find(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(interruptedOutput?.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.strictEqual(
      getStepOutputText(
        { output: interruptedOutput.cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "raw \n\nparsed"
    );
    assert.deepStrictEqual(interruptedOutput.cliOutput.structured?.events, [
      {
        type: CLI_EVENT_TYPES.TEXT,
        data: { text: "raw " },
      },
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: 110,
        data: { text: "parsed" },
      },
    ]);
    assert.strictEqual(interruptedOutput.cliOutput.isStreaming, true);

    const events = await recorder.readEvents(filePath);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
      ]
    );
  });

  test("coalesces token-cadence deltas into one timeline event", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-coalescing"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

    await manager.startStreamingExecutionOutput(filePath, target, {
      structured: {
        events: [{ type: "text", data: { text: "" } }],
        metadata: {},
      },
      elapsed: 0,
      isStreaming: true,
      timestampMs: 100,
      runIndex: 0,
      attemptIndex: 0,
    });
    // The headless path emits one TEXT event per provider token delta.
    for (const token of ["Hel", "lo ", "wor", "ld"]) {
      await manager.appendStreamingEvents(filePath, target, 0, 0, [
        { type: CLI_EVENT_TYPES.TEXT, timestamp: 110, data: { text: token } },
      ]);
    }
    await manager.flushPendingWrites(filePath);

    const events = await recorder.readEvents(filePath);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
      ],
      "four token deltas should cost one appended event, not four"
    );

    const history = await manager.loadHistory(filePath);
    const output = history.orderedEntries.find(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(output?.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.deepStrictEqual(output.cliOutput.structured?.events, [
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: 110,
        data: { text: "Hello world" },
      },
    ]);
  });

  test("projects the same coalesced activity boundary for live and replay output", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-activity"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 } as const;
    const liveActivities: OutputActivityEntry[] = [];
    manager.setOutputActivityHandler((entry) => liveActivities.push(entry));

    await manager.startStreamingExecutionOutput(filePath, target, {
      structured: {
        events: [{ type: "text", data: { text: "" } }],
        metadata: {},
      },
      elapsed: 0,
      isStreaming: true,
      timestampMs: 100,
      runIndex: 1,
      attemptIndex: 2,
    });
    for (const token of ["A", "1"]) {
      await manager.appendStreamingEvents(filePath, target, 1, 2, [
        { type: CLI_EVENT_TYPES.TEXT, timestamp: 110, data: { text: token } },
      ]);
    }
    await manager.flushPendingWrites(filePath);

    const history = await manager.loadHistory(filePath);
    expectActivityEntries(liveActivities, history.activityEntries ?? []);
    assert.strictEqual(liveActivities.length, 1);
    assert.ok(typeof liveActivities[0]?.sequence === "number");
    assert.strictEqual(
      liveActivities[0]?.timestampMs,
      history.activityEntries?.[0]?.timestampMs
    );
    assert.deepStrictEqual(liveActivities[0]?.events, [
      { type: CLI_EVENT_TYPES.TEXT, timestamp: 110, data: { text: "A1" } },
    ]);

    await manager.saveExecutionOutput(filePath, target, [
      {
        elapsed: 10,
        isStreaming: false,
        timestampMs: 100,
        runIndex: 1,
        attemptIndex: 2,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: 110,
              data: { text: "A1" },
            },
          ],
          metadata: {},
        },
      },
    ]);
    const completed = await manager.loadHistory(filePath);
    assert.strictEqual(completed.activityEntries?.length, 1);
    const completedOutput = completed.orderedEntries.find(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(completedOutput?.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.strictEqual(
      getStepOutputText(
        { output: completedOutput.cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "A1"
    );
  });

  test("does not re-append streamed deltas once the completed aggregate lands", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-streaming-complete"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    // The completed aggregate carries the attempt's *start* timestamp, so it
    // sorts ahead of the deltas it supersedes. Mirror that ordering exactly.
    const attemptStartedAt = 100;

    await manager.startStreamingExecutionOutput(filePath, target, {
      structured: {
        events: [{ type: "text", data: { text: "" } }],
        metadata: {},
      },
      elapsed: 0,
      isStreaming: true,
      timestampMs: attemptStartedAt,
      runIndex: 0,
      attemptIndex: 0,
    });
    await manager.appendStreamingChunk(filePath, target, 0, 0, "Hello ");
    await manager.appendStreamingChunk(filePath, target, 0, 0, "world");
    await manager.appendStreamingEvents(filePath, target, 0, 0, [
      { type: CLI_EVENT_TYPES.TEXT, timestamp: 110, data: { text: "Hello " } },
    ]);
    await manager.saveExecutionOutput(filePath, target, [
      {
        elapsed: 30,
        isStreaming: false,
        timestampMs: attemptStartedAt,
        runIndex: 0,
        attemptIndex: 0,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: 110,
              data: { text: "Hello world" },
            },
          ],
          metadata: {},
        },
      },
    ]);

    const completed = await manager.loadHistory(filePath);
    const output = completed.orderedEntries.find(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(output?.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.strictEqual(
      getStepOutputText(
        { output: output.cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "Hello world"
    );
    assert.deepStrictEqual(output.cliOutput.structured?.events, [
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: 110,
        data: { text: "Hello world" },
      },
    ]);
    assert.strictEqual(output.cliOutput.isStreaming, false);
  });

  test("records authoritative workflow runtime transitions without affecting history projection", async () => {
    const historyInit = await initTestRun(manager, tempWorkspace, "wf-runtime");
    const historyFilePath = historyInit.filePath;

    await manager.appendRuntimeTransition(historyFilePath, {
      command: "pause",
      previous: {
        status: EXECUTION_STATES.RUNNING,
        stopped: false,
        startTime: 100,
        pausedTime: undefined,
        totalPausedDuration: 0,
      },
      current: {
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        startTime: 100,
        pausedTime: 150,
        totalPausedDuration: 0,
      },
      timestampMs: 150,
    });

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      { message: "paused", severity: "info", timestamp: 151 }
    );

    const events = await recorder.readEvents(historyFilePath);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
        TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      ]
    );
    assert.strictEqual(events[0]?.timestampMs, 150);
    if (
      events[0]?.eventType !==
      TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED
    ) {
      assert.fail("expected runtime transition event");
    }
    assert.deepStrictEqual(events[0].payload.transition, {
      command: "pause",
      previous: {
        status: EXECUTION_STATES.RUNNING,
        stopped: false,
        startTime: 100,
        totalPausedDuration: 0,
      },
      current: {
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        startTime: 100,
        pausedTime: 150,
        totalPausedDuration: 0,
      },
    });

    const loaded = await manager.loadHistory(historyFilePath);
    const statusEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        e.target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e.target as any).stepIndex === 0
    );
    assert.deepStrictEqual(
      statusEntries.map((e) => (e as any).statusMessage),
      [{ message: "paused", severity: "info", timestamp: 151 }]
    );
    assert.deepStrictEqual(
      loaded.orderedEntries.map((entry) => entry.kind),
      ["runtime", "status"]
    );
  });

  test("finalizes the interrupted running manifest during crash recovery", async () => {
    const { filePath, workflowKey, runRef } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-interrupted"
    );
    await manager.startStreamingExecutionOutput(
      filePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        structured: {
          events: [{ type: "text", data: { text: "" } }],
          metadata: {},
        },
        elapsed: 0,
        isStreaming: true,
        attemptIndex: 0,
      }
    );

    await manager.recoverInterruptedRun(workflowKey, runRef, 3);

    const manifest = await recorder.readManifest(filePath);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.STOPPED);
    assert.strictEqual(manifest.stepCount, 3);
    assert.strictEqual(typeof manifest.completedAt, "number");
    const recovered = await manager.loadHistory(filePath);
    const output = recovered.orderedEntries.find(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(output?.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.strictEqual(output.cliOutput.isStreaming, false);
  });

  test("finalizes the exact interrupted run when a newer run exists", async () => {
    const { filePath, workflowKey, runRef } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-older-interrupted"
    );
    const newerRunRef = await initAdditionalRun(
      recorder,
      tempWorkspace,
      workflowKey,
      2,
      Date.now() + 100_000
    );

    await manager.recoverInterruptedRun(workflowKey, runRef, 2);

    const interrupted = await recorder.readManifest(filePath);
    const newer = await recorder.readManifest(
      manager.getHistoryFilePath(workflowKey, newerRunRef)
    );
    assert.strictEqual(interrupted.executionState, EXECUTION_STATES.STOPPED);
    assert.strictEqual(typeof interrupted.completedAt, "number");
    assert.strictEqual(newer.executionState, EXECUTION_STATES.COMPLETED);
  });

  for (const executionState of [
    EXECUTION_STATES.PAUSING,
    EXECUTION_STATES.CANCELLING,
  ]) {
    test(`finalizes a ${executionState} manifest during crash recovery`, async () => {
      const { filePath, workflowKey, runRef } = await initTestRun(
        manager,
        tempWorkspace,
        `wf-recovery-${executionState}`
      );
      await recorder.updateManifest(filePath, (manifest) => ({
        ...manifest,
        executionState,
      }));

      await manager.recoverInterruptedRun(workflowKey, runRef, 1);

      const manifest = await recorder.readManifest(filePath);
      assert.strictEqual(manifest.executionState, EXECUTION_STATES.STOPPED);
      assert.strictEqual(typeof manifest.completedAt, "number");
    });
  }

  test("orders canonical history entries by timestamp and sequence", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-canonical-order"
    );
    const historyFilePath = historyInit.filePath;

    await recorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
        timestampMs: 100,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        payload: {
          statusMessage: {
            message: "before",
            severity: "info",
            timestamp: 100,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 100,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
        payload: {
          cliOutput: {
            structured: {
              events: [{ type: "text", data: { text: "draft" } }],
              metadata: {},
            },
            elapsed: 1,
            isStreaming: false,
            timestampMs: 100,
            attemptIndex: 0,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 100,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
        payload: {
          cliOutput: {
            structured: {
              events: [{ type: "text", data: { text: "final" } }],
              metadata: {},
            },
            elapsed: 1,
            isStreaming: false,
            timestampMs: 100,
            attemptIndex: 0,
          },
        },
      },
    ]);

    const loaded = await manager.loadHistory(historyFilePath);
    assert.deepStrictEqual(
      loaded.orderedEntries.map((entry) =>
        entry.kind === OUTPUT_HISTORY_KINDS.CLI
          ? `${entry.kind}:${getStepOutputText({ output: entry.cliOutput }, StepOutputTextMode.TRANSCRIPT)}:${entry.sequence}`
          : `${entry.kind}:${entry.sequence}`
      ),
      ["status:1", "cli:final:3"]
    );
  });

  test("stores status messages as discrete timeline events in sequence order", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-status-sequence"
    );
    const historyFilePath = historyInit.filePath;

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      { message: "queued", severity: "info", timestamp: 100 }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "ok" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 110,
          attemptIndex: 0,
        },
      ]
    );

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      { message: "complete", severity: "info", timestamp: 120 }
    );

    const events = await recorder.readEvents(historyFilePath);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      ]
    );
    assert.deepStrictEqual(
      events.map((event) => event.sequence),
      [1, 2, 3]
    );

    const loaded = await manager.loadHistory(historyFilePath);
    const statusEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        e.target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e.target as any).stepIndex === 0
    );
    assert.deepStrictEqual(
      statusEntries.map((e) => (e as any).statusMessage),
      [
        { message: "queued", severity: "info", timestamp: 100 },
        { message: "complete", severity: "info", timestamp: 120 },
      ]
    );
  });

  test("ignores compatibility status snapshots when saving timeline cli output", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-status-canonical"
    );
    const historyFilePath = historyInit.filePath;

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      { message: "queued", severity: "info", timestamp: 100 }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "ok" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 110,
          attemptIndex: 0,
        },
      ]
    );

    const events = await recorder.readEvents(historyFilePath);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
        TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      ]
    );

    const loaded = await manager.loadHistory(historyFilePath);
    const statusEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        e.target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e.target as any).stepIndex === 0
    );
    assert.deepStrictEqual(
      statusEntries.map((e) => (e as any).statusMessage),
      [{ message: "queued", severity: "info", timestamp: 100 }]
    );
    assert.deepStrictEqual(
      loaded.orderedEntries.map((entry) => entry.kind),
      ["status", "cli"]
    );
  });

  test("ignores unhandled timeline event kinds during projection", async () => {
    const historyInit = await initTestRun(manager, tempWorkspace, "wf-compat");
    const historyFilePath = historyInit.filePath;

    await recorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED,
        timestampMs: 120,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        payload: {
          undoRecord: {
            appliedAt: 120,
            restoredFiles: ["src/file.ts"],
            redoInstructions: [],
          },
        },
      },
    ]);

    const loaded = await manager.loadHistory(historyFilePath);
    assert.deepStrictEqual(loaded.promptOutputs[0]?.undoRecord, {
      appliedAt: 120,
      restoredFiles: ["src/file.ts"],
      redoInstructions: [],
    });
  });

  test("deleteRunByRef removes one explicitly addressed run", async () => {
    const workflowKey = (
      await new WorkflowLineageRepository().createLineage(
        tempWorkspace,
        "wf-delete",
        "wf-delete"
      )
    ).workflowKey;

    // Three runs with explicit, increasing startedAt so ordering is deterministic.
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 1, 1000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 2, 2000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 3, 3000);

    assert.strictEqual(
      (await manager.getRunsForWorkflow(workflowKey)).length,
      3
    );

    // Resolve the newest row for display, then retain its immutable reference
    // for the actual mutation.
    const [newestRunRef] = await manager.getRunsForWorkflow(workflowKey);
    assert.ok(newestRunRef);
    const remaining = await manager.deleteRunByRef(workflowKey, newestRunRef);
    assert.strictEqual(remaining, 2);

    const runs = await manager.getRunsForWorkflow(workflowKey);
    assert.strictEqual(runs.length, 2);

    // The newest remaining run is now run 2 (startedAt 2000); run 3 is gone.
    const newest = await recorder.readManifest(
      manager.getHistoryFilePath(workflowKey, runs[0])
    );
    assert.strictEqual(newest.runId, 2);
  });

  test("deleteRunByRef rejects a missing stable reference", async () => {
    const workflowKey = (
      await new WorkflowLineageRepository().createLineage(
        tempWorkspace,
        "wf-delete-oob",
        "wf-delete-oob"
      )
    ).workflowKey;
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 1, 1000);

    await assert.rejects(() =>
      manager.deleteRunByRef(
        workflowKey,
        WorkflowPaths.formatRunRef(99_999) as ReturnType<
          typeof WorkflowPaths.formatRunRef
        >
      )
    );
    assert.strictEqual(
      (await manager.getRunsForWorkflow(workflowKey)).length,
      1
    );
  });

  test("repairs the descriptor hint and preserves run-id gaps after stable deletion", async () => {
    const repository = new WorkflowLineageRepository();
    const workflowKey = (
      await repository.createLineage(
        tempWorkspace,
        "wf-delete-repair",
        "wf-delete-repair"
      )
    ).workflowKey;
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 4, 4_000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 9, 9_000);
    const [newest, older] = await manager.getRunsForWorkflow(workflowKey);
    assert.ok(newest);
    assert.ok(older);

    await manager.saveExecutionOutput(
      manager.getHistoryFilePath(workflowKey, newest),
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      [
        {
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: "delete-search-document-needle" },
              },
            ],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 9_001,
          attemptIndex: 0,
        },
      ]
    );
    await manager.flushPendingIndexRefresh();
    const search = new HistorySearchService();
    assert.strictEqual(
      (await search.search("delete-search-document-needle", tempWorkspace))
        .totalCount,
      1
    );

    await manager.deleteRunByRef(workflowKey, newest);

    const descriptor = await repository.readDescriptor(
      tempWorkspace,
      workflowKey
    );
    assert.strictEqual(descriptor.latestRunRef, older);
    assert.strictEqual(descriptor.nextRunId, 1);
    const remaining = await manager.getRunSummaries(workflowKey);
    assert.deepStrictEqual(
      remaining.map((summary) => summary.runId),
      [4]
    );
    assert.strictEqual(
      (await search.search("delete-search-document-needle", tempWorkspace))
        .totalCount,
      0,
      "deletion must remove stale search documents before it resolves"
    );
  });

  test("retention keeps executing and pending-rewind runs while pruning complete runs", async () => {
    const repository = new WorkflowLineageRepository();
    const workflowKey = (
      await repository.createLineage(
        tempWorkspace,
        "wf-prune-protected",
        "wf-prune-protected"
      )
    ).workflowKey;
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 1, 1_000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 2, 2_000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 3, 3_000);
    const [newest, pending, oldest] =
      await manager.getRunsForWorkflow(workflowKey);
    assert.ok(newest);
    assert.ok(pending);
    assert.ok(oldest);
    await manager.appendRuntimeTransition(
      manager.getHistoryFilePath(workflowKey, newest),
      {
        command: "resume",
        previous: {
          status: EXECUTION_STATES.IDLE,
          stopped: false,
          totalPausedDuration: 0,
        },
        current: {
          status: EXECUTION_STATES.RUNNING,
          stopped: false,
          totalPausedDuration: 0,
        },
        timestampMs: Date.now(),
      }
    );
    await repository.updateDescriptor(
      tempWorkspace,
      workflowKey,
      (descriptor) => ({
        ...descriptor,
        pendingEdit: {
          kind: "rewind",
          runRef: pending,
          fromStepIndex: 1,
          baseDefinitionRevision: 1,
        },
      })
    );

    await manager.pruneOldRuns(workflowKey, 1);

    const remaining = await manager.getRunsForWorkflow(workflowKey);
    assert.deepStrictEqual(remaining, [newest, pending]);
    await assert.rejects(
      () => manager.deleteRunByRef(workflowKey, newest),
      /protected/
    );
    await assert.rejects(
      () => manager.deleteRunByRef(workflowKey, pending),
      /protected/
    );
    assert.ok(
      !(await manager.getRunsForWorkflow(workflowKey)).includes(oldest),
      "the oldest complete run should be retained only until pruning runs"
    );
  });

  test("finite retention skips an old in-flight source or append target instead of retargeting it", async () => {
    const workflowKey = (
      await new WorkflowLineageRepository().createLineage(
        tempWorkspace,
        "wf-prune-inflight",
        "wf-prune-inflight"
      )
    ).workflowKey;
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 2, 2_000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 5, 5_000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 8, 8_000);
    const [newest, middle, oldest] =
      await manager.getRunsForWorkflow(workflowKey);
    assert.ok(newest);
    assert.ok(middle);
    assert.ok(oldest);

    await manager.pruneOldRuns(workflowKey, 1, new Set([oldest]));

    assert.deepStrictEqual(
      await manager.getRunsForWorkflow(workflowKey),
      [newest, oldest],
      "the old protected target survives while the next oldest complete run is pruned"
    );
    assert.ok(
      !(await manager.getRunsForWorkflow(workflowKey)).includes(middle)
    );
  });

  test("getRunSummaries reads manifest fields newest-first and excludes unreadable runs", async () => {
    // getRunsForWorkflow sorts by the timestamp embedded in each run's directory
    // name (WorkflowPaths.parseRunRefTimestamp), not by manifest.startedAt — so the
    // "newer" run here needs a later runRef timestamp, not just a higher runId.
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-summaries",
      { runId: 1, startedAt: 1000 }
    );
    await initAdditionalRun(
      recorder,
      tempWorkspace,
      workflowKey,
      2,
      Date.now() + 1_000_000
    );
    await manager.finalizeRun(filePath, EXECUTION_STATES.COMPLETED, 3);

    // An unreadable run directory (no manifest.json) must be skipped, not thrown.
    const corruptRunDir = WorkflowPaths.runDir(
      tempWorkspace,
      workflowKey,
      WorkflowPaths.formatRunRef(500)
    );
    await fs.mkdir(corruptRunDir, { recursive: true });

    const summaries = await manager.getRunSummaries(workflowKey);

    assert.strictEqual(summaries.length, 2);
    assert.strictEqual(summaries[0]?.runId, 2);
    assert.strictEqual(summaries[1]?.runId, 1);
    assert.strictEqual(summaries[1]?.runRef, runRef);
    assert.strictEqual(summaries[1]?.workflowKey, workflowKey);
    assert.strictEqual(
      summaries[1]?.runDirectory,
      WorkflowPaths.runDir(tempWorkspace, workflowKey, runRef)
    );
    assert.strictEqual(summaries[1]?.stepCount, 3);
    assert.strictEqual(summaries[1]?.definitionRevision, 1);
    assert.strictEqual(
      summaries[1]?.executionState,
      EXECUTION_STATES.COMPLETED
    );
    assert.strictEqual(summaries[1]?.hasMixedHarnesses, false);
    assert.strictEqual(summaries[1]?.hasMixedModels, false);
  });

  test("getRunSummaries prefers the run's working file when it disagrees with the manifest", async () => {
    // The two records diverge whenever a manifest write is skipped (e.g. an
    // execution that ran with no history file path), leaving the run panel —
    // which lists from manifests — showing a state the run left long ago while
    // the header, reading the working file, shows the truth. The working file is
    // written by the executor itself on every transition, so it wins.
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-divergent",
      { runId: 1, startedAt: 1000 }
    );
    await recorder.updateManifest(filePath, (manifest) => ({
      ...manifest,
      executionState: EXECUTION_STATES.PAUSED,
      completedAt: 2000,
    }));

    const runFilePath = WorkflowPaths.runFilePath(
      tempWorkspace,
      workflowKey,
      runRef
    );
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        workflowName: "wf-divergent",
        definitionRevision: 1,
        steps: [{ prompt: "s0" }],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.COMPLETED,
          executionEndTime: 9999,
        },
      }),
      "utf8"
    );

    const [summary] = await manager.getRunSummaries(workflowKey);

    assert.strictEqual(
      summary?.executionState,
      EXECUTION_STATES.COMPLETED,
      "the working file's state must win over a stale manifest"
    );
    assert.strictEqual(summary?.completedAt, 9999);
  });

  test("getRunSummaries reports the most-used harness and model as primary, ties to the earliest", async () => {
    // A planner step on one harness followed by many worker steps on another
    // used to report the planner's harness as "primary" just for running first.
    const writeSteps = async (
      name: string,
      steps: Array<{ harness: string; model: string }>
    ) => {
      const { workflowKey, runRef } = await initTestRun(
        manager,
        tempWorkspace,
        name
      );
      const runFilePath = WorkflowPaths.runFilePath(
        tempWorkspace,
        workflowKey,
        runRef
      );
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          definitionRevision: 1,
          steps: steps.map((step, index) => ({
            prompt: `s${index}`,
            _runtime: step,
          })),
        }),
        "utf8"
      );
      const [summary] = await manager.getRunSummaries(workflowKey);
      return summary;
    };

    const planned = await writeSteps("wf-primary-majority", [
      { harness: HARNESS_IDS.CLAUDE_CLI, model: "opus" },
      { harness: HARNESS_IDS.CODEX_CLI, model: "gpt-worker" },
      { harness: HARNESS_IDS.CODEX_CLI, model: "gpt-worker" },
    ]);
    assert.strictEqual(planned?.primaryHarness, HARNESS_IDS.CODEX_CLI);
    assert.strictEqual(planned?.primaryModel, "gpt-worker");
    assert.strictEqual(planned?.hasMixedHarnesses, true);

    const tied = await writeSteps("wf-primary-tie", [
      { harness: HARNESS_IDS.CLAUDE_CLI, model: "opus" },
      { harness: HARNESS_IDS.CODEX_CLI, model: "gpt-worker" },
    ]);
    assert.strictEqual(tied?.primaryHarness, HARNESS_IDS.CLAUDE_CLI);
    assert.strictEqual(tied?.primaryModel, "opus");
  });

  test("getRunSummaries falls back to the manifest when the run file is unreadable", async () => {
    const { workflowKey, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-no-run-file",
      { runId: 1, startedAt: 1000 }
    );
    await manager.finalizeRun(filePath, EXECUTION_STATES.ERROR, 2);

    // No workflow.ctrlyoke.json was ever written for this run.
    const [summary] = await manager.getRunSummaries(workflowKey);

    assert.strictEqual(summary?.executionState, EXECUTION_STATES.ERROR);
    assert.ok(
      summary?.completedAt,
      "manifest completedAt remains the fallback"
    );
  });

  test("deletion protection keeps a run either record calls active, even when the summary reads idle", async () => {
    // A seeded-but-not-yet-started run is the case that splits the two records:
    // the manifest is already RUNNING while the working file is still idle. The
    // summary (working-file-preferred) reads idle, but the run must not be
    // deletable — protection takes the union, display does not.
    const { workflowKey, runRef, filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-seeded",
      { runId: 1, startedAt: 1000 }
    );
    const runFilePath = WorkflowPaths.runFilePath(
      tempWorkspace,
      workflowKey,
      runRef
    );
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        workflowName: "wf-seeded",
        definitionRevision: 1,
        steps: [{ prompt: "s0" }],
        _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.IDLE },
      }),
      "utf8"
    );

    const manifest = (await recorder.readManifest(
      filePath
    )) as WorkflowRunManifest;
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.RUNNING);
    const [summary] = await manager.getRunSummaries(workflowKey);
    assert.strictEqual(
      summary?.executionState,
      EXECUTION_STATES.IDLE,
      "display still prefers the working file"
    );

    await assert.rejects(
      () => manager.deleteRunByRef(workflowKey, runRef),
      /protected/,
      "a run the manifest still calls active must not be deletable"
    );
  });

  test("getRunSummaries bounds manifest read concurrency for large lineages", async () => {
    const workflowKey = (
      await new WorkflowLineageRepository().createLineage(
        tempWorkspace,
        "wf-summary-concurrency",
        "wf-summary-concurrency"
      )
    ).workflowKey;
    const runCount = 100;
    for (let runId = 1; runId <= runCount; runId += 1) {
      const runRef = WorkflowPaths.formatRunRef(Date.UTC(2025, 0, 1) + runId);
      await fs.mkdir(WorkflowPaths.runDir(tempWorkspace, workflowKey, runRef), {
        recursive: true,
      });
    }

    let activeReads = 0;
    let maxActiveReads = 0;
    const recorderForTest = (
      manager as unknown as {
        timelineRecorder: {
          readManifest: (manifestPath: string) => Promise<WorkflowRunManifest>;
        };
      }
    ).timelineRecorder;
    recorderForTest.readManifest = async (manifestPath) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        if (activeReads > 64) {
          const error = new Error(
            "Too many open files"
          ) as NodeJS.ErrnoException;
          error.code = "EMFILE";
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        const parsed = WorkflowPaths.parseRunArtifactPath(
          tempWorkspace,
          manifestPath
        );
        assert.ok(parsed);
        const startedAt =
          WorkflowPaths.parseRunRefTimestamp(parsed.runRef) ?? 0;
        return {
          schemaVersion: 2,
          storageKind: "timeline",
          workflowId: workflowKey,
          runId: startedAt - Date.UTC(2025, 0, 1),
          startedAt,
          completedAt: startedAt + 1,
          executionState: EXECUTION_STATES.COMPLETED,
          definitionRevision: 1,
          stepCount: 1,
          eventCount: 0,
          nextSequence: 1,
          lastUpdatedAt: startedAt + 1,
        };
      } finally {
        activeReads -= 1;
      }
    };

    const summaries = await manager.getRunSummaries(workflowKey);

    assert.strictEqual(summaries.length, runCount);
    assert.ok(
      maxActiveReads <= 64,
      `expected bounded reads, observed ${maxActiveReads} concurrent manifests`
    );
  });

  test("getRunNavigationSummary reports the latest run's id and total run count", async () => {
    const { workflowKey } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-nav-summary",
      { runId: 1, startedAt: 1_000 }
    );
    await initAdditionalRun(
      recorder,
      tempWorkspace,
      workflowKey,
      2,
      Date.now() + 1_000_000
    );

    const summary = await manager.getRunNavigationSummary(workflowKey);

    assert.strictEqual(summary.runCount, 2);
    assert.strictEqual(summary.primaryRunId, 2);
  });

  test("getRunNavigationSummary reports zero runs for a lineage with no promoted run", async () => {
    const workflowKey = (
      await new WorkflowLineageRepository().createLineage(
        tempWorkspace,
        "wf-nav-empty",
        "wf-nav-empty"
      )
    ).workflowKey;

    const summary = await manager.getRunNavigationSummary(workflowKey);

    assert.deepStrictEqual(summary, { runCount: 0 });
  });

  test("getRunNavigationSummary counts a corrupted latest run but omits its primaryRunId", async () => {
    const { workflowKey } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-nav-corrupt-latest",
      { runId: 1, startedAt: 1_000 }
    );
    // A newer run dir with no manifest.json — this is "the latest" by
    // directory-timestamp ordering but cannot be read.
    const corruptRunDir = WorkflowPaths.runDir(
      tempWorkspace,
      workflowKey,
      WorkflowPaths.formatRunRef(Date.now() + 1_000_000)
    );
    await fs.mkdir(corruptRunDir, { recursive: true });

    const summary = await manager.getRunNavigationSummary(workflowKey);

    assert.strictEqual(summary.runCount, 2);
    assert.strictEqual(summary.primaryRunId, undefined);
  });

  test("getRunNavigationSummary still counts a corrupted non-latest run directory", async () => {
    // Documents the directory-count tradeoff: runCount reflects run
    // directories, not validated manifests, so a corrupted older run still
    // counts here even though getRunSummaries() would exclude it.
    const { workflowKey } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-nav-corrupt-older",
      { runId: 1, startedAt: 1_000 }
    );
    await initAdditionalRun(
      recorder,
      tempWorkspace,
      workflowKey,
      2,
      Date.now() + 1_000_000
    );
    const corruptRunDir = WorkflowPaths.runDir(
      tempWorkspace,
      workflowKey,
      WorkflowPaths.formatRunRef(500)
    );
    await fs.mkdir(corruptRunDir, { recursive: true });

    const summary = await manager.getRunNavigationSummary(workflowKey);

    assert.strictEqual(summary.runCount, 3);
    assert.strictEqual(summary.primaryRunId, 2);
  });

  test("appendRuntimeTransition keeps the manifest executionState authoritative for non-terminal transitions", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-transition-manifest"
    );

    await manager.appendRuntimeTransition(historyInit.filePath, {
      command: "pause",
      previous: {
        status: EXECUTION_STATES.RUNNING,
        stopped: false,
        totalPausedDuration: 0,
      },
      current: {
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        totalPausedDuration: 0,
      },
      timestampMs: 150,
    });

    const manifest = await recorder.readManifest(historyInit.filePath);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.PAUSED);
    assert.strictEqual(manifest.lastUpdatedAt, 150);
  });

  test("persists each guardrail stop reason to the run manifest", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-guardrail-stop-reasons"
    );
    const reasons = [
      {
        code: GUARDRAIL_STOP_CODES.QUEUE_SIZE_LIMIT,
        threshold: 10,
        observed: 11,
        unit: "steps" as const,
        message: "Step limit reached",
      },
      {
        code: GUARDRAIL_STOP_CODES.WORKFLOW_TIME_LIMIT,
        threshold: 120,
        observed: 121,
        unit: "seconds" as const,
        message: "Workflow time limit reached",
      },
      {
        code: GUARDRAIL_STOP_CODES.PROMPT_TIMEOUT,
        threshold: 30,
        observed: 31,
        unit: "seconds" as const,
        message: "Prompt timed out",
      },
    ];

    for (const stopReason of reasons) {
      await manager.appendRuntimeTransition(historyInit.filePath, {
        command: WORKFLOW_RUNTIME_COMMANDS.FAIL,
        previous: {
          status: EXECUTION_STATES.RUNNING,
          stopped: false,
          totalPausedDuration: 0,
        },
        current: {
          status: EXECUTION_STATES.ERROR,
          stopped: false,
          totalPausedDuration: 0,
          stopReason,
        },
        timestampMs: 200,
      });
      const manifest = await recorder.readManifest(historyInit.filePath);
      assert.deepStrictEqual(manifest.stopReason, stopReason);
    }
  });

  test("saveExecutionOutput commits a definition revision snapshot only when it advances, and tags output with it", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-definition-revision"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const snapshotV1 = { workflowName: "wf", steps: [{ prompt: "v1" }] };
    const snapshotV2 = { workflowName: "wf", steps: [{ prompt: "v2" }] };

    // Revision 1 matches the manifest's starting revision — no COMMITTED event expected;
    // the run's own workflow.ctrlyoke.json is already the exact record of revision 1.
    await manager.saveExecutionOutput(
      historyInit.filePath,
      target,
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "first" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 100,
          attemptIndex: 0,
        },
      ],
      { definitionRevision: 1, definition: snapshotV1 }
    );

    let events = await recorder.readEvents(historyInit.filePath);
    assert.strictEqual(
      events.filter(
        (e) =>
          e.eventType === TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
      ).length,
      0
    );

    // Revision 2 is newer — expect exactly one COMMITTED event, and the output event
    // tagged with definitionRevision: 2.
    await manager.saveExecutionOutput(
      historyInit.filePath,
      target,
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "second" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 200,
          attemptIndex: 1,
        },
      ],
      { definitionRevision: 2, definition: snapshotV2 }
    );

    // A second attempt at the same revision must not re-commit.
    await manager.saveExecutionOutput(
      historyInit.filePath,
      target,
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "third" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 300,
          attemptIndex: 2,
        },
      ],
      { definitionRevision: 2, definition: snapshotV2 }
    );

    events = await recorder.readEvents(historyInit.filePath);
    const committed = events.filter(
      (e) => e.eventType === TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
    );
    assert.strictEqual(committed.length, 1);
    if (
      committed[0]?.eventType !==
      TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
    ) {
      assert.fail("expected a definition revision committed event");
    }
    assert.strictEqual(committed[0].payload.definitionRevision, 2);
    assert.strictEqual(committed[0].payload.priorDefinitionRevision, 1);
    assert.deepStrictEqual(committed[0].payload.definition, snapshotV2);

    const cliOutputEvents = events.filter(
      (e) => e.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
    );
    assert.deepStrictEqual(
      cliOutputEvents.map((e) =>
        e.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
          ? e.definitionRevision
          : undefined
      ),
      [1, 2, 2]
    );

    const manifest = await recorder.readManifest(historyInit.filePath);
    assert.strictEqual(manifest.definitionRevision, 2);
  });

  test("an out-of-process append survives a runtime write and is committed before its first output", async () => {
    const historyInit = await initTestRun(
      manager,
      tempWorkspace,
      "wf-mcp-append-runtime-write"
    );
    const runFilePath = WorkflowPaths.runFilePath(
      tempWorkspace,
      historyInit.workflowKey,
      historyInit.runRef
    );
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        startedAt: 1,
        definitionRevision: 1,
        steps: [{ prompt: "initial step" }],
        _runtime: {
          currentIndex: 0,
          executionState: EXECUTION_STATES.RUNNING,
        },
      })
    );
    const queue = new PromptQueue();
    await queue.restoreFromWorkingFile(runFilePath, true);
    assert.strictEqual(queue.getState().definitionRevision, 1);
    const readRunFile = async () =>
      JSON.parse(await fs.readFile(runFilePath, "utf8")) as WorkingFile;

    // The MCP server appends from another process...
    const append = await RunContinuationService.appendStepsToRun(
      tempWorkspace,
      historyInit.workflowKey,
      historyInit.runRef,
      [{ prompt: "appended by MCP" }],
      1,
      100,
      undefined,
      true
    );
    assert.strictEqual(append.definitionRevision, 2);

    // ...and the working-file watcher merges it into the live queue. The
    // merge must adopt the append's revision along with its steps.
    assert.strictEqual(await queue.mergeStepsFromDisk(), 1);
    assert.strictEqual(
      queue.getState().definitionRevision,
      append.definitionRevision
    );

    // Runtime writes that find nothing new to merge (the outcome commit and a
    // session-ID flush) must not roll the append's revision back.
    await queue.markStepAsSent(0);
    await queue.commitStepOutcomeAndAdvance({
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      status: PROMPT_TERMINAL_STATUS.COMPLETED,
    });
    await queue.persistRuntimeMetadata(1, { sessionId: "appended-session" });
    const persisted = await readRunFile();
    assert.strictEqual(persisted.definitionRevision, append.definitionRevision);
    assert.strictEqual(
      queue.getState().definitionRevision,
      persisted.definitionRevision
    );
    assert.strictEqual(
      (persisted.steps?.[1] as { prompt: string }).prompt,
      "appended by MCP"
    );

    // Same inputs as WorkflowInstance.getDefinitionRevisionContext(): the
    // live queue, not a snapshot taken at run start.
    const state = queue.getState();
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
    await manager.saveExecutionOutput(
      historyInit.filePath,
      target,
      [
        {
          structured: {
            events: [{ type: "text", data: { text: "first output" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
          timestampMs: 200,
          attemptIndex: 0,
        },
      ],
      {
        definitionRevision: state.definitionRevision,
        definition: buildDefinitionSnapshot(
          state.workflowName ?? "",
          state.steps,
          undefined,
          queue.getWorkflowFile().finalStep,
          queue.getWorkflowFile().worktree,
          state.parallelGroups
        ),
      }
    );

    const events = await recorder.readEvents(historyInit.filePath);
    const committedIndex = events.findIndex(
      (event) =>
        event.eventType === TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
    );
    const outputIndex = events.findIndex(
      (event) =>
        event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED &&
        event.target.kind === FINAL_STEP_PHASES.QUEUE &&
        event.target.stepIndex === 1
    );
    assert.ok(committedIndex >= 0);
    assert.ok(outputIndex > committedIndex);
    const committed = events[committedIndex];
    assert.ok(
      committed?.eventType ===
        TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED &&
        committed.payload.definitionRevision === append.definitionRevision &&
        committed.payload.definition.steps.some(
          (step) => "prompt" in step && step.prompt === "appended by MCP"
        )
    );
  });
});

suite("OutputHistoryManager snapshot enrichment on loadHistory", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cy-enrich-"));
    manager = new OutputHistoryManager(tempWorkspace);
  });

  teardown(async () => {
    await manager.flushPendingIndexRefresh();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  async function saveSnapshotAndLoad(
    snapshot: WorkspaceSnapshot
  ): Promise<WorkspaceSnapshot | undefined> {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-enrich");
    await manager.saveSnapshotForTarget(
      filePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      snapshot
    );
    const history = await manager.loadHistory(filePath);
    return history.promptOutputs[0]?.workspaceSnapshot;
  }

  test("passes filesystem snapshots through without enrichment", async () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.FILESYSTEM,
      changedFiles: [
        {
          path: "src/foo.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
        },
      ],
    };
    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(loaded?.changedFiles[0]?.beforeContent, undefined);
  });

  test("passes git snapshots without headCommit through without enrichment", async () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      changedFiles: [
        {
          path: "src/foo.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
        },
      ],
    };
    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(loaded?.changedFiles[0]?.beforeContent, undefined);
  });

  test("does not enrich capturedBefore entries (safety rule)", async () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      git: { headCommit: "abc123" },
      changedFiles: [
        {
          path: "src/foo.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.CAPTURED_BEFORE,
        },
      ],
    };
    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(loaded?.changedFiles[0]?.beforeContent, undefined);
  });

  test("does not re-fetch when beforeContent is already populated", async () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      git: { headCommit: "abc123" },
      changedFiles: [
        {
          path: "src/foo.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
          beforeContent: "existing content",
        },
      ],
    };
    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(
      loaded?.changedFiles[0]?.beforeContent,
      "existing content"
    );
  });

  test("does not fetch when contentCaptureSkipped is set", async () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      git: { headCommit: "abc123" },
      changedFiles: [
        {
          path: "src/foo.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
          contentCaptureSkipped: true,
        },
      ],
    };
    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(loaded?.changedFiles[0]?.beforeContent, undefined);
    assert.strictEqual(loaded?.changedFiles[0]?.contentCaptureSkipped, true);
  });

  test("silently skips when git fetch fails for eligible entry", async () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      git: { headCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      changedFiles: [
        {
          path: "src/no-such-file.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
        },
      ],
    };
    // tempWorkspace has no git repo → git show will fail → entry unchanged
    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(loaded?.changedFiles[0]?.beforeContent, undefined);
  });

  test("hydrates beforeContent from git for eligible gitHead entries", async () => {
    // Set up a minimal git repo with a tracked file
    const gitEnv = {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    };
    execFileSync("git", ["init"], { cwd: tempWorkspace });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: tempWorkspace,
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: tempWorkspace,
    });

    const srcDir = path.join(tempWorkspace, "src");
    await fs.mkdir(srcDir);
    await fs.writeFile(path.join(srcDir, "target.ts"), "original content");
    execFileSync("git", ["add", "."], {
      cwd: tempWorkspace,
      env: { ...process.env, ...gitEnv },
    });
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", "initial"], {
      cwd: tempWorkspace,
      env: { ...process.env, ...gitEnv },
    });

    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tempWorkspace,
    })
      .toString()
      .trim();

    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      git: { headCommit },
      changedFiles: [
        {
          path: "src/target.ts",
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
        },
      ],
    };

    const loaded = await saveSnapshotAndLoad(snapshot);
    assert.strictEqual(
      loaded?.changedFiles[0]?.beforeContent,
      "original content"
    );
  });

  test("on-demand snapshot content matches loadHistory enrichment", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-fetch");
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.GIT,
      changedFiles: [
        {
          path: "src/restore.ts",
          changeType: "deleted",
          contentToRestore: "original file contents",
          contentCaptureSkipped: false,
        },
      ],
    };
    await manager.saveSnapshotForTarget(filePath, target, snapshot);

    const historySnapshot = (await manager.loadHistory(filePath))
      .promptOutputs[0]?.workspaceSnapshot?.changedFiles[0];
    const onDemand = await manager.getSnapshotFileContent(
      filePath,
      target,
      "src/restore.ts"
    );
    assert.strictEqual(
      onDemand?.contentToRestore,
      historySnapshot?.contentToRestore
    );
    assert.strictEqual(
      onDemand?.contentCaptureSkipped,
      historySnapshot?.contentCaptureSkipped
    );
    assert.strictEqual(onDemand?.beforeContent, historySnapshot?.beforeContent);
  });

  test("on-demand content only reads paths in the target snapshot", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-fetch-path"
    );
    await manager.saveSnapshotForTarget(
      filePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        capturedAt: 1000,
        strategy: SNAPSHOT_STRATEGIES.FILESYSTEM,
        changedFiles: [
          {
            path: "src/allowed.ts",
            changeType: "modified",
            beforeContent: "before",
          },
        ],
      }
    );

    assert.strictEqual(
      await manager.getSnapshotFileContent(
        filePath,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        "../../private.txt"
      ),
      undefined
    );
    assert.deepStrictEqual(
      await manager.getSnapshotFileContent(
        filePath,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        path.join(tempWorkspace, "src", "allowed.ts")
      ),
      { beforeContent: "before" }
    );
    assert.strictEqual(
      await manager.getSnapshotFileContent(
        filePath,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        "src/allowed.ts"
      ),
      undefined
    );
  });

  test("returns capture-skipped metadata when snapshot content is absent", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-fetch-missing"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await manager.saveSnapshotForTarget(filePath, target, {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.FILESYSTEM,
      changedFiles: [
        {
          path: "src/large.ts",
          changeType: "modified",
          contentCaptureSkipped: true,
        },
      ],
    });

    assert.deepStrictEqual(
      await manager.getSnapshotFileContent(filePath, target, "src/large.ts"),
      { contentCaptureSkipped: true }
    );
  });

  test("serves the live snapshot cache while persistence is in progress", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-fetch-live"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const saving = manager.saveSnapshotForTarget(filePath, target, {
      capturedAt: 1000,
      strategy: SNAPSHOT_STRATEGIES.FILESYSTEM,
      changedFiles: [
        {
          path: "src/live.ts",
          changeType: "deleted",
          contentToRestore: "live capture",
        },
      ],
    });

    assert.deepStrictEqual(
      await manager.getSnapshotFileContent(filePath, target, "src/live.ts"),
      { contentToRestore: "live capture" }
    );
    await saving;
  });
});

suite("OutputHistoryManager usage store feed", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cy-usage-feed-"));
    manager = new OutputHistoryManager(tempWorkspace);
  });

  teardown(async () => {
    await manager.flushPendingIndexRefresh();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("feeds both stores from one manifest read and marks wall-clock fallback", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-usage-feed",
      { startedAt: 1000 }
    );
    const managerInternals = manager as unknown as {
      timelineRecorder: TimelineRecorder;
      feedUsageStores: (historyFilePath: string) => void;
      pendingObservedUsageFeed: Promise<void>;
    };
    const today = new Date();
    const localDay = `${today.getFullYear()}-${String(
      today.getMonth() + 1
    ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await managerInternals.timelineRecorder.updateManifest(
      filePath,
      (manifest) => ({
        ...manifest,
        completedAt: 2500,
        lastUpdatedAt: Date.now(),
        executionState: EXECUTION_STATES.COMPLETED,
        stepCount: 1,
        tokenTotals: {
          total: 12,
          coverage: "complete",
          reportedAttemptCount: 1,
          attemptCount: 1,
          isFinal: true,
          byHarness: {
            [HARNESS_IDS.CLAUDE_CLI]: {
              input: 10,
              output: 2,
              total: 12,
              coverage: "complete",
              reportedAttemptCount: 1,
              attemptCount: 1,
            },
          },
          byLocalDay: {
            [localDay]: {
              [HARNESS_IDS.CLAUDE_CLI]: {
                input: 10,
                output: 2,
                total: 12,
                coverage: "complete",
                reportedAttemptCount: 1,
                attemptCount: 1,
              },
            },
          },
        },
      })
    );

    let manifestReads = 0;
    const originalReadManifest =
      managerInternals.timelineRecorder.readManifest.bind(
        managerInternals.timelineRecorder
      );
    managerInternals.timelineRecorder.readManifest = async (manifestPath) => {
      manifestReads++;
      return originalReadManifest(manifestPath);
    };
    managerInternals.feedUsageStores(filePath);
    await managerInternals.pendingObservedUsageFeed;

    assert.strictEqual(manifestReads, 1);
    const lifetime = await new LifetimeUsageStore(tempWorkspace).read();
    const observed = await new ObservedHarnessUsageStore(tempWorkspace).read();
    assert.strictEqual(lifetime.totals.total, 12);
    assert.strictEqual(lifetime.wallClockDurationRunCount, 1);
    assert.strictEqual(lifetime.totalActiveExecutionMs, 1500);
    assert.ok(Object.keys(observed.runs).length > 0);
  });

  test("requests one Copilot refresh after terminal recording without blocking on failure", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-copilot-refresh"
    );
    let refreshRequests = 0;
    manager.setHarnessUsageRefreshHandler(async (harnessId) => {
      assert.strictEqual(harnessId, HARNESS_IDS.COPILOT_CLI);
      refreshRequests += 1;
      throw new Error("background refresh unavailable");
    });

    await manager.recordAttemptTerminal(
      filePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      0,
      0,
      "failed",
      undefined,
      "Copilot attempt failed",
      HARNESS_IDS.COPILOT_CLI
    );

    assert.strictEqual(refreshRequests, 1);
    const events = await new TimelineRecorder().readEvents(filePath);
    assert.strictEqual(
      events[0]?.eventType,
      TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED
    );
  });
});

suite("OutputHistoryManager narrow bookkeeping reads", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;
  let recorder: TimelineRecorder;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cy-bookkeeping-"));
    manager = new OutputHistoryManager(tempWorkspace);
    recorder = new TimelineRecorder();
  });

  teardown(async () => {
    await manager.flushPendingIndexRefresh();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("saveSnapshotForTarget skips a redundant append when the snapshot is unchanged", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-snap");
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 100,
      strategy: SNAPSHOT_STRATEGIES.FILESYSTEM,
      changedFiles: [],
    };

    await manager.saveSnapshotForTarget(filePath, target, snapshot);
    await manager.saveSnapshotForTarget(filePath, target, snapshot);

    const events = await recorder.readEvents(filePath);
    const snapshotEvents = events.filter(
      (e) => e.eventType === TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED
    );
    assert.strictEqual(
      snapshotEvents.length,
      1,
      "an identical snapshot must not append a second event"
    );

    const changedSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      capturedAt: 200,
    };
    await manager.saveSnapshotForTarget(filePath, target, changedSnapshot);

    const eventsAfterChange = await recorder.readEvents(filePath);
    assert.strictEqual(
      eventsAfterChange.filter(
        (e) => e.eventType === TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED
      ).length,
      2,
      "a changed snapshot must append a new event"
    );
  });

  test("saveUndoRecord skips a redundant append when the undo record is unchanged", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-undo");
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const undoRecord = {
      appliedAt: 100,
      restoredFiles: ["src/file.ts"],
      redoInstructions: [],
    };

    await manager.saveUndoRecord(filePath, target, undoRecord);
    await manager.saveUndoRecord(filePath, target, undoRecord);

    const events = await recorder.readEvents(filePath);
    assert.strictEqual(
      events.filter((e) => e.eventType === TIMELINE_EVENT_TYPES.UNDO_APPLIED)
        .length,
      1,
      "an identical undo record must not append a second event"
    );
  });

  test("separate undo batches merge into one redoable step record", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-undo-merge"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await manager.saveUndoRecord(filePath, target, {
      appliedAt: 100,
      restoredFiles: ["src/A.ts"],
      redoInstructions: [
        { path: "src/A.ts", action: UNDO_FILE_ACTIONS.DELETE },
      ],
    });
    const merged = await manager.saveUndoRecord(filePath, target, {
      appliedAt: 110,
      restoredFiles: ["src\\B.ts"],
      redoInstructions: [
        { path: "src/B.ts", action: UNDO_FILE_ACTIONS.DELETE },
      ],
    });

    assert.deepStrictEqual(merged?.restoredFiles, ["src/A.ts", "src\\B.ts"]);
    assert.deepStrictEqual(
      merged?.redoInstructions.map(({ path: filePath }) => filePath),
      ["src/A.ts", "src/B.ts"]
    );
    assert.strictEqual(merged?.isRedone, undefined);
    const loaded = await manager.loadHistory(filePath);
    assert.deepStrictEqual(
      loaded.promptOutputs[0]?.undoRecord?.redoInstructions.map(
        ({ path: filePath }) => filePath
      ),
      ["src/A.ts", "src/B.ts"]
    );
  });

  test("does not revive redo data from an older record marked redone", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-undo-redone-merge"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await recorder.appendEvents(filePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.UNDO_APPLIED,
        timestampMs: 100,
        target,
        payload: {
          undoRecord: {
            appliedAt: 100,
            restoredFiles: ["src/A.ts"],
            redoInstructions: [
              { path: "src/A.ts", action: UNDO_FILE_ACTIONS.DELETE },
            ],
            isRedone: true,
            redoneAt: 110,
          },
        },
      },
    ]);

    const merged = await manager.saveUndoRecord(filePath, target, {
      appliedAt: 120,
      restoredFiles: ["src/B.ts"],
      redoInstructions: [
        { path: "src/B.ts", action: UNDO_FILE_ACTIONS.DELETE },
      ],
    });

    assert.deepStrictEqual(merged?.restoredFiles, ["src/B.ts"]);
    assert.deepStrictEqual(
      merged?.redoInstructions.map(({ path: filePath }) => filePath),
      ["src/B.ts"]
    );
    assert.strictEqual(merged?.isRedone, undefined);
  });

  test("merges undo path keys with platform-aware casing", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-undo-path-casing"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const makeRecord = (path: string, appliedAt: number) => ({
      appliedAt,
      restoredFiles: [path],
      redoInstructions: [{ path, action: UNDO_FILE_ACTIONS.DELETE }],
    });
    await manager.saveUndoRecord(filePath, target, makeRecord("A.ts", 100));
    const merged = await manager.saveUndoRecord(
      filePath,
      target,
      makeRecord("a.ts", 110)
    );

    const expectedPaths =
      process.platform === "win32" ? ["a.ts"] : ["A.ts", "a.ts"];
    assert.deepStrictEqual(
      merged?.redoInstructions.map(({ path }) => path).sort(),
      expectedPaths
    );
    assert.deepStrictEqual(merged?.restoredFiles.sort(), expectedPaths);
  });

  test("partial redo keeps remaining files redoable until the final file", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-redo-partial"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await manager.saveUndoRecord(filePath, target, {
      appliedAt: 100,
      restoredFiles: ["src/A.ts", "src/B.ts"],
      redoInstructions: [
        { path: "src/A.ts", action: UNDO_FILE_ACTIONS.DELETE },
        { path: "src/B.ts", action: UNDO_FILE_ACTIONS.DELETE },
      ],
    });

    const afterFirstRedo = await manager.markUndoRecordRedone(
      filePath,
      target,
      110,
      ["src/A.ts"]
    );
    assert.deepStrictEqual(
      afterFirstRedo?.redoInstructions.map(({ path: filePath }) => filePath),
      ["src/B.ts"]
    );
    assert.deepStrictEqual(afterFirstRedo?.restoredFiles, ["src/B.ts"]);
    assert.strictEqual(afterFirstRedo?.isRedone, false);

    const afterSecondRedo = await manager.markUndoRecordRedone(
      filePath,
      target,
      120,
      ["src/B.ts"]
    );
    assert.deepStrictEqual(afterSecondRedo?.redoInstructions, []);
    assert.deepStrictEqual(afterSecondRedo?.restoredFiles, []);
    assert.strictEqual(afterSecondRedo?.isRedone, true);
  });

  test("markUndoRecordRedone marks the latest undo record redone via a streamed lookup", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-redo");
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

    // No undo record exists yet: marking redone must be a no-op.
    await manager.markUndoRecordRedone(filePath, target, 150, ["src/file.ts"]);
    let events = await recorder.readEvents(filePath);
    assert.strictEqual(
      events.filter((e) => e.eventType === TIMELINE_EVENT_TYPES.REDO_APPLIED)
        .length,
      0
    );

    await manager.saveUndoRecord(filePath, target, {
      appliedAt: 100,
      restoredFiles: ["src/file.ts"],
      redoInstructions: [
        { path: "src/file.ts", action: UNDO_FILE_ACTIONS.DELETE },
      ],
    });
    await manager.markUndoRecordRedone(filePath, target, 150, ["src/file.ts"]);

    events = await recorder.readEvents(filePath);
    assert.strictEqual(
      events.filter((e) => e.eventType === TIMELINE_EVENT_TYPES.REDO_APPLIED)
        .length,
      1
    );

    const history = await manager.loadHistory(filePath);
    assert.strictEqual(history.promptOutputs[0]?.undoRecord?.isRedone, true);
    assert.strictEqual(history.promptOutputs[0]?.undoRecord?.redoneAt, 150);
  });

  test("findNextAttemptIndexForPhase returns one past the highest recorded attempt in that phase", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-phase");
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

    assert.strictEqual(
      await manager.findNextAttemptIndexForPhase(
        filePath,
        EXECUTION_PHASES.WORKTREE_SETUP
      ),
      0
    );

    await manager.saveExecutionOutput(
      filePath,
      target,
      [
        {
          elapsed: 1,
          isStreaming: false,
          timestampMs: 100,
          attemptIndex: 0,
        } as any,
      ],
      undefined,
      EXECUTION_PHASES.WORKTREE_SETUP
    );
    await manager.saveExecutionOutput(
      filePath,
      target,
      [
        {
          elapsed: 1,
          isStreaming: false,
          timestampMs: 200,
          attemptIndex: 1,
        } as any,
      ],
      undefined,
      EXECUTION_PHASES.WORKTREE_SETUP
    );
    // A higher attempt index outside the phase must not count.
    await manager.saveExecutionOutput(filePath, target, [
      {
        elapsed: 1,
        isStreaming: false,
        timestampMs: 300,
        attemptIndex: 9,
      } as any,
    ]);

    assert.strictEqual(
      await manager.findNextAttemptIndexForPhase(
        filePath,
        EXECUTION_PHASES.WORKTREE_SETUP
      ),
      2
    );
  });

  test("findNextRunIndexByTarget returns one past the highest recorded runIndex, per target", async () => {
    const { filePath } = await initTestRun(manager, tempWorkspace, "wf-runidx");
    const target0 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const target1 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;

    await manager.saveExecutionOutput(filePath, target0, [
      {
        elapsed: 1,
        isStreaming: false,
        timestampMs: 1,
        attemptIndex: 0,
        runIndex: 0,
      } as any,
    ]);
    await manager.saveExecutionOutput(filePath, target0, [
      {
        elapsed: 1,
        isStreaming: false,
        timestampMs: 2,
        attemptIndex: 0,
        runIndex: 1,
      } as any,
    ]);
    await manager.saveExecutionOutput(filePath, target1, [
      {
        elapsed: 1,
        isStreaming: false,
        timestampMs: 3,
        attemptIndex: 0,
        runIndex: 0,
      } as any,
    ]);

    const result = await manager.findNextRunIndexByTarget(
      filePath,
      new Set(["queue:0", "queue:1"])
    );

    assert.strictEqual(result.get("queue:0"), 2);
    assert.strictEqual(result.get("queue:1"), 1);
  });

  test("findNextRunIndexByTarget ignores targets outside the requested key set", async () => {
    const { filePath } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-runidx-scope"
    );
    const target0 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const target1 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;

    await manager.saveExecutionOutput(filePath, target0, [
      {
        elapsed: 1,
        isStreaming: false,
        timestampMs: 1,
        attemptIndex: 0,
        runIndex: 3,
      } as any,
    ]);
    await manager.saveExecutionOutput(filePath, target1, [
      {
        elapsed: 1,
        isStreaming: false,
        timestampMs: 2,
        attemptIndex: 0,
        runIndex: 5,
      } as any,
    ]);

    const result = await manager.findNextRunIndexByTarget(
      filePath,
      new Set(["queue:1"])
    );

    assert.strictEqual(result.has("queue:0"), false);
    assert.strictEqual(result.get("queue:1"), 6);
  });
});
