import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  EXECUTION_STATES,
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  SNAPSHOT_BASE_SOURCES,
  SNAPSHOT_STRATEGIES,
} from "../../types/DashboardConstants";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_STORAGE_FILES,
  TIMELINE_STORAGE_KIND,
  type WorkflowRunManifest,
} from "../../types/WorkflowTimelineTypes";
import type { WorkspaceSnapshot } from "../../types/OutputHistoryTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";

let nextTestRunOrdinal = 0;

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
  const workflowKey = await WorkflowPaths.allocateWorkflowKey(
    workspaceRoot,
    nameHint
  );
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
): Promise<void> {
  const runRef = WorkflowPaths.formatRunRef(startedAt + nextTestRunOrdinal++);
  const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
  await recorder.initializeRunAt(
    runDir,
    workflowKey,
    runId,
    startedAt,
    EXECUTION_STATES.COMPLETED
  );
}

suite("OutputHistoryManager timeline-backed storage", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;
  let recorder: TimelineRecorder;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-history-"));
    manager = new OutputHistoryManager(tempWorkspace);
    recorder = new TimelineRecorder();
  });

  teardown(async () => {
    await manager.flushPendingIndexRefresh();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
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
          prompt: "queue-1",
          response: "draft",
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
          prompt: "queue-1",
          response: "final",
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
          prompt: "final",
          response: "final-ok",
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
        redoInstructions: [],
      }
    );

    await manager.markUndoRecordRedone(
      historyFilePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      170
    );

    await manager.finalizeRun(historyFilePath, EXECUTION_STATES.COMPLETED, 2);

    const loaded = await manager.loadHistory(historyFilePath);
    // CLI output for queue:0 is the final deduplicated one (attemptIndex=0, response="final")
    const queueCliEntries = loaded.orderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.CLI &&
        e.target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e.target as any).stepIndex === 0
    );
    assert.strictEqual(queueCliEntries.length, 1);
    assert.strictEqual((queueCliEntries[0] as any).cliOutput.response, "final");

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
    if (loaded.orderedEntries[1]?.kind !== "cli") {
      assert.fail("expected second ordered entry to be cli output");
    }
    assert.strictEqual(loaded.orderedEntries[1].cliOutput.response, "final");
    assert.strictEqual(loaded.orderedEntries[1].sequence, 3);

    const events = await recorder.readEvents(historyFilePath);
    assert.strictEqual(events.length, 8);
    assert.deepStrictEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8]
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
      prompt: "stream me",
      response: "",
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
    assert.strictEqual(interruptedOutput.cliOutput.response, "raw ");
    assert.deepStrictEqual(interruptedOutput.cliOutput.structured?.events, [
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
      prompt: "stream me",
      response: "",
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
      prompt: "stream me",
      response: "",
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
        prompt: "stream me",
        response: "Hello world",
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
    assert.strictEqual(output.cliOutput.response, "Hello world");
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

  test("finalizes the newest running manifest during crash recovery", async () => {
    const { filePath, workflowKey } = await initTestRun(
      manager,
      tempWorkspace,
      "wf-interrupted"
    );
    await manager.startStreamingExecutionOutput(
      filePath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        prompt: "interrupted",
        response: "",
        elapsed: 0,
        isStreaming: true,
        attemptIndex: 0,
      }
    );

    await manager.recoverInterruptedRun(workflowKey, 3);

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
            prompt: "queue-1",
            response: "draft",
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
            prompt: "queue-1",
            response: "final",
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
          ? `${entry.kind}:${entry.cliOutput.response}:${entry.sequence}`
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
          prompt: "queue-1",
          response: "ok",
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
          prompt: "queue-1",
          response: "ok",
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

  test("deleteRun removes a single run by index (newest = 0)", async () => {
    const workflowKey = await WorkflowPaths.allocateWorkflowKey(
      tempWorkspace,
      "wf-delete"
    );

    // Three runs with explicit, increasing startedAt so ordering is deterministic.
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 1, 1000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 2, 2000);
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 3, 3000);

    assert.strictEqual(
      (await manager.getRunsForWorkflow(workflowKey)).length,
      3
    );

    // Delete the newest run (index 0) — the accidental-restart recovery case.
    const remaining = await manager.deleteRun(workflowKey, 0);
    assert.strictEqual(remaining, 2);

    const runs = await manager.getRunsForWorkflow(workflowKey);
    assert.strictEqual(runs.length, 2);

    // The newest remaining run is now run 2 (startedAt 2000); run 3 is gone.
    const newest = await recorder.readManifest(
      manager.getHistoryFilePath(workflowKey, runs[0])
    );
    assert.strictEqual(newest.runId, 2);
  });

  test("deleteRun is a no-op for an out-of-range index", async () => {
    const workflowKey = await WorkflowPaths.allocateWorkflowKey(
      tempWorkspace,
      "wf-delete-oob"
    );
    await initAdditionalRun(recorder, tempWorkspace, workflowKey, 1, 1000);

    const remaining = await manager.deleteRun(workflowKey, 5);
    assert.strictEqual(remaining, 1);
    assert.strictEqual(
      (await manager.getRunsForWorkflow(workflowKey)).length,
      1
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
    assert.strictEqual(summaries[1]?.stepCount, 3);
    assert.strictEqual(summaries[1]?.definitionRevision, 1);
    assert.strictEqual(
      summaries[1]?.executionState,
      EXECUTION_STATES.COMPLETED
    );
    assert.strictEqual(summaries[1]?.hasMixedHarnesses, false);
    assert.strictEqual(summaries[1]?.hasMixedModels, false);
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
          prompt: "v1",
          response: "first",
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
          prompt: "v2",
          response: "second",
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
          prompt: "v2",
          response: "third",
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
});

suite("OutputHistoryManager snapshot enrichment on loadHistory", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-enrich-"));
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
});
