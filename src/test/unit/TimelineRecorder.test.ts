import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";

function createStatusEventDraft(
  timestampMs: number,
  message: string
): WorkflowTimelineEventDraft {
  return {
    eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
    timestampMs,
    target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
    payload: {
      statusMessage: {
        message,
        severity: "info",
        timestamp: timestampMs,
      },
    },
  };
}

suite("TimelineRecorder", () => {
  let tempDir: string;
  let manifestPath: string;
  let recorder: TimelineRecorder;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-timeline-"));
    recorder = new TimelineRecorder();
    manifestPath = await recorder.initializeRunAt(
      tempDir,
      "wf-timeline",
      1,
      100,
      EXECUTION_STATES.RUNNING
    );
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("serializes concurrent appends with unique ordered sequences and manifest counts", async () => {
    const appendedBatches = await Promise.all([
      recorder.appendEvents(manifestPath, [
        createStatusEventDraft(110, "batch-1-a"),
        createStatusEventDraft(111, "batch-1-b"),
      ]),
      recorder.appendEvents(manifestPath, [
        createStatusEventDraft(120, "batch-2-a"),
      ]),
      recorder.appendEvents(manifestPath, [
        createStatusEventDraft(130, "batch-3-a"),
        createStatusEventDraft(131, "batch-3-b"),
      ]),
    ]);

    const events = await recorder.readEvents(manifestPath);
    const manifest = await recorder.readManifest(manifestPath);

    assert.deepStrictEqual(
      appendedBatches
        .flat()
        .map((event) => event.sequence)
        .sort((left, right) => left - right),
      [1, 2, 3, 4, 5]
    );
    assert.deepStrictEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4, 5]
    );
    assert.strictEqual(new Set(events.map((event) => event.sequence)).size, 5);
    assert.deepStrictEqual(
      events.map((event) => {
        if (event.eventType !== TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED) {
          return "";
        }

        return event.payload.statusMessage.message;
      }),
      ["batch-1-a", "batch-1-b", "batch-2-a", "batch-3-a", "batch-3-b"]
    );
    assert.strictEqual(manifest.eventCount, 5);
    assert.strictEqual(manifest.nextSequence, 6);
    assert.strictEqual(manifest.lastUpdatedAt, 131);
  });

  test("serializes manifest updates with concurrent append operations", async () => {
    await Promise.all([
      recorder.appendEvents(manifestPath, [
        createStatusEventDraft(110, "done"),
      ]),
      recorder.updateManifest(manifestPath, (manifest) => ({
        ...manifest,
        completedAt: 200,
        executionState: EXECUTION_STATES.COMPLETED,
        stepCount: 3,
        lastUpdatedAt: 200,
      })),
    ]);

    const manifest = await recorder.readManifest(manifestPath);
    const events = await recorder.readEvents(manifestPath);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.sequence, 1);
    assert.strictEqual(manifest.eventCount, 1);
    assert.strictEqual(manifest.nextSequence, 2);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(manifest.stepCount, 3);
    assert.strictEqual(manifest.completedAt, 200);
    assert.strictEqual(manifest.lastUpdatedAt, 200);
  });

  test("reopens a completed manifest without resetting its durable identity or event counters", async () => {
    await recorder.appendEvents(manifestPath, [
      createStatusEventDraft(110, "first"),
      createStatusEventDraft(111, "second"),
    ]);
    await recorder.updateManifest(manifestPath, (manifest) => ({
      ...manifest,
      completedAt: 200,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 2,
      stepCount: 2,
      lastUpdatedAt: 200,
    }));

    await recorder.reopenRun(manifestPath, EXECUTION_STATES.RUNNING, 3, 4, 210);

    const manifest = await recorder.readManifest(manifestPath);
    assert.strictEqual(manifest.startedAt, 100);
    assert.strictEqual(manifest.completedAt, undefined);
    assert.strictEqual(manifest.executionState, EXECUTION_STATES.RUNNING);
    assert.strictEqual(manifest.definitionRevision, 3);
    assert.strictEqual(manifest.stepCount, 4);
    assert.strictEqual(manifest.eventCount, 2);
    assert.strictEqual(manifest.nextSequence, 3);
    assert.strictEqual(manifest.lastUpdatedAt, 210);
  });
});
