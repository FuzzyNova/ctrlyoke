import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { OutputHistoryManager } from "../../flightpath/orchestration/OutputHistoryManager";
import { TimelineRecorder } from "../../flightpath/orchestration/TimelineRecorder";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_STORAGE_FILES,
  TIMELINE_STORAGE_KIND,
  type WorkflowRunManifest,
} from "../../types/WorkflowTimelineTypes";

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
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("initializes new runs as manifest plus events.jsonl storage", async () => {
    const historyInit = await manager.initializeRun("wf-test");

    assert.strictEqual(historyInit.runCount, 1);
    assert.strictEqual(
      path.basename(historyInit.filePath),
      TIMELINE_STORAGE_FILES.MANIFEST
    );

    const manifest = JSON.parse(
      await fs.readFile(historyInit.filePath, "utf8")
    ) as WorkflowRunManifest;

    assert.strictEqual(manifest.storageKind, TIMELINE_STORAGE_KIND);
    assert.strictEqual(manifest.workflowId, "wf-test");
    assert.strictEqual(manifest.runId, 1);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.RUNNING);
    assert.strictEqual(manifest.eventCount, 0);
    assert.strictEqual(manifest.nextSequence, 1);

    const events = await recorder.readEvents(historyInit.filePath);
    assert.deepStrictEqual(events, []);
  });

  test("projects timeline events back into WorkflowOutputHistory shape", async () => {
    const historyInit = await manager.initializeRun("wf-test");
    const historyFilePath = historyInit.filePath;

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      {
        message: "started",
        severity: "info",
        timestamp: 110,
      }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      [
        {
          prompt: "queue-1",
          response: "draft",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 100,
          attemptIndex: 0,
        },
      ],
      [{ message: "started", severity: "info", timestamp: 110 }]
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      [
        {
          prompt: "queue-1",
          response: "final",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 120,
          attemptIndex: 0,
        },
      ],
      [{ message: "started", severity: "info", timestamp: 110 }]
    );

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      {
        message: "done",
        severity: "info",
        timestamp: 130,
      }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      [],
      [
        { message: "started", severity: "info", timestamp: 110 },
        { message: "done", severity: "info", timestamp: 130 },
      ]
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "finalPrompt", loopIndex: 0 },
      [
        {
          prompt: "final",
          response: "final-ok",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 200,
        },
      ],
      []
    );

    await manager.saveSnapshotForTarget(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      {
        capturedAt: 150,
        strategy: "filesystem",
        changedFiles: [],
      }
    );

    await manager.saveUndoRecord(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      {
        appliedAt: 160,
        restoredFiles: ["src/file.ts"],
        redoInstructions: [],
      }
    );

    await manager.markUndoRecordRedone(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      170
    );

    await manager.finalizeRun(historyFilePath, EXECUTION_STATES.COMPLETED, 2);

    const loaded = await manager.loadHistory(historyFilePath);
    // CLI output for queue:0 is the final deduplicated one (attemptIndex=0, response="final")
    const queueCliEntries = loaded.orderedEntries
      .filter((e) => e.kind === "cli" && e.target.kind === "queue" && (e.target as any).stepIndex === 0);
    assert.strictEqual(queueCliEntries.length, 1);
    assert.strictEqual((queueCliEntries[0] as any).cliOutput.response, "final");

    const queueStatusEntries = loaded.orderedEntries
      .filter((e) => e.kind === "status" && e.target.kind === "queue" && (e.target as any).stepIndex === 0);
    assert.strictEqual(queueStatusEntries.length, 2);

    const finalCliEntries = loaded.orderedEntries
      .filter((e) => e.kind === "cli" && e.target.kind === "finalPrompt" && (e.target as any).loopIndex === 0);
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

  test("records authoritative workflow runtime transitions without affecting history projection", async () => {
    const historyInit = await manager.initializeRun("wf-runtime");
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
      { kind: "queue", stepIndex: 0 },
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
      (e) => e.kind === "status" && e.target.kind === "queue" && (e.target as any).stepIndex === 0
    );
    assert.deepStrictEqual(statusEntries.map((e) => (e as any).statusMessage), [
      { message: "paused", severity: "info", timestamp: 151 },
    ]);
    assert.deepStrictEqual(
      loaded.orderedEntries.map((entry) => entry.kind),
      ["runtime", "status"]
    );
  });

  test("orders canonical history entries by timestamp and sequence", async () => {
    const historyInit = await manager.initializeRun("wf-canonical-order");
    const historyFilePath = historyInit.filePath;

    await recorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
        timestampMs: 100,
        target: { kind: "queue", stepIndex: 0 },
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
        target: { kind: "queue", stepIndex: 0 },
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
        target: { kind: "queue", stepIndex: 0 },
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
        entry.kind === "cli"
          ? `${entry.kind}:${entry.cliOutput.response}:${entry.sequence}`
          : `${entry.kind}:${entry.sequence}`
      ),
      ["status:1", "cli:final:3"]
    );
  });

  test("stores status messages as discrete timeline events in sequence order", async () => {
    const historyInit = await manager.initializeRun("wf-status-sequence");
    const historyFilePath = historyInit.filePath;

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      { message: "queued", severity: "info", timestamp: 100 }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      [
        {
          prompt: "queue-1",
          response: "ok",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 110,
          attemptIndex: 0,
        },
      ],
      [{ message: "queued", severity: "info", timestamp: 100 }]
    );

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
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
      (e) => e.kind === "status" && e.target.kind === "queue" && (e.target as any).stepIndex === 0
    );
    assert.deepStrictEqual(statusEntries.map((e) => (e as any).statusMessage), [
      { message: "queued", severity: "info", timestamp: 100 },
      { message: "complete", severity: "info", timestamp: 120 },
    ]);
  });

  test("ignores compatibility status snapshots when saving timeline cli output", async () => {
    const historyInit = await manager.initializeRun("wf-status-canonical");
    const historyFilePath = historyInit.filePath;

    await manager.appendStatusMessage(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      { message: "queued", severity: "info", timestamp: 100 }
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      [
        {
          prompt: "queue-1",
          response: "ok",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 110,
          attemptIndex: 0,
        },
      ],
      [
        { message: "queued", severity: "info", timestamp: 100 },
        { message: "stale-compat", severity: "warning", timestamp: 105 },
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
      (e) => e.kind === "status" && e.target.kind === "queue" && (e.target as any).stepIndex === 0
    );
    assert.deepStrictEqual(statusEntries.map((e) => (e as any).statusMessage), [
      { message: "queued", severity: "info", timestamp: 100 },
    ]);
    assert.deepStrictEqual(
      loaded.orderedEntries.map((entry) => entry.kind),
      ["status", "cli"]
    );
  });

  test("ignores unhandled timeline event kinds during projection", async () => {
    const historyInit = await manager.initializeRun("wf-compat");
    const historyFilePath = historyInit.filePath;

    await recorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED,
        timestampMs: 120,
        target: { kind: "queue", stepIndex: 0 },
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
});
