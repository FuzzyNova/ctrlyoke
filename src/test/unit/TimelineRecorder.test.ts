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
import { buildDefinitionSnapshot } from "../../core/WorkflowStepSanitizer";
import { Log } from "../../utils/Log";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";

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

  test("persists parallel groups in a definition revision snapshot", async () => {
    const definition = buildDefinitionSnapshot(
      "grouped revision",
      [{ prompt: "one" }, { prompt: "two" }],
      undefined,
      undefined,
      undefined,
      [
        {
          id: "grouped-revision",
          startIndex: 0,
          endIndex: 1,
          failFast: false,
        },
      ]
    );

    const first = await recorder.commitDefinitionRevisionIfNewer(
      manifestPath,
      2,
      definition,
      110
    );
    const second = await recorder.commitDefinitionRevisionIfNewer(
      manifestPath,
      2,
      definition,
      111
    );
    const events = await recorder.readEvents(manifestPath);

    assert.strictEqual(first.committed, true);
    assert.strictEqual(second.committed, false);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(
      events[0]?.eventType,
      TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
    );
    if (
      events[0]?.eventType ===
      TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
    ) {
      assert.deepStrictEqual(events[0].payload.definition.parallelGroups, [
        {
          id: "grouped-revision",
          startIndex: 0,
          endIndex: 1,
          failFast: false,
        },
      ]);
    }
  });

  test("never persists a resolved value in events, manifest, or the session log", async () => {
    const secret = "resolved-value-that-must-not-leak";
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ SERVICE_TOKEN: secret });
    const release = secretRedactionService.register(redactor);

    await recorder.appendEvents(manifestPath, [
      createStatusEventDraft(110, `failure output: ${secret}`),
    ]);
    await recorder.updateManifest(manifestPath, (manifest) => ({
      ...manifest,
      workflowId: secret,
    }));
    Log.initializeCli(tempDir, true);
    Log.error(`[TimelineRecorder] session log failure: ${secret}`);
    release();

    const events = await fs.readFile(
      path.join(tempDir, "events.jsonl"),
      "utf8"
    );
    const manifest = await fs.readFile(manifestPath, "utf8");
    const logPath = (await fs.readdir(path.join(tempDir, ".ctrlyoke", "logs")))
      .map((file) => path.join(tempDir, ".ctrlyoke", "logs", file))
      .find((file) => file.endsWith(".log"));
    const sessionLog = logPath ? await fs.readFile(logPath, "utf8") : "";

    assert.ok(!events.includes(secret));
    assert.ok(!manifest.includes(secret));
    assert.ok(!sessionLog.includes(secret));
    assert.ok(events.includes("[REDACTED]"));
    assert.ok(manifest.includes("[REDACTED]"));
    assert.ok(sessionLog.includes("[REDACTED]"));
  });
});
