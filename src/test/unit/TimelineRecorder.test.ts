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
  TIMELINE_SCHEMA_VERSION,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";
import {
  CURRENT_SCHEMA_VERSIONS,
  isNewerSchemaError,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cy-timeline-"));
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

  test("reads legacy string versions and stamps the integer baseline on write", async () => {
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    manifest.schemaVersion = "2.4.0";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await recorder.appendEvents(manifestPath, [
      createStatusEventDraft(110, "legacy"),
    ]);

    const written = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion: unknown;
    };
    assert.strictEqual(written.schemaVersion, TIMELINE_SCHEMA_VERSION);
  });

  test("reads newer manifests but refuses every mutation before appending events", async () => {
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    manifest.schemaVersion =
      CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.TIMELINE] + 1;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const eventPath = path.join(tempDir, "events.jsonl");
    const eventsBefore = await fs.readFile(eventPath, "utf8");

    assert.strictEqual(
      (await recorder.readManifest(manifestPath)).schemaVersion,
      CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.TIMELINE] + 1
    );
    await assert.rejects(
      () =>
        recorder.appendEvents(manifestPath, [
          createStatusEventDraft(110, "newer"),
        ]),
      (error: unknown) =>
        isNewerSchemaError(error) && error.store === PERSISTED_STORES.TIMELINE
    );
    assert.strictEqual(await fs.readFile(eventPath, "utf8"), eventsBefore);
  });

  test("does not replace a newer manifest when initializing a damaged run", async () => {
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    manifest.schemaVersion =
      CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.TIMELINE] + 1;
    const original = JSON.stringify(manifest);
    await fs.writeFile(manifestPath, original);
    await fs.rm(path.join(tempDir, "events.jsonl"));

    await assert.rejects(
      () =>
        recorder.initializeRunAt(
          tempDir,
          "wf-timeline",
          1,
          100,
          EXECUTION_STATES.RUNNING
        ),
      (error: unknown) =>
        isNewerSchemaError(error) && error.store === PERSISTED_STORES.TIMELINE
    );
    assert.strictEqual(await fs.readFile(manifestPath, "utf8"), original);
  });

  test("preserves the previous manifest when atomic replacement fails", async () => {
    const original = await fs.readFile(manifestPath, "utf8");
    const fsPromises = require("fs/promises") as typeof import("fs/promises");
    const originalRename = fsPromises.rename;
    Object.defineProperty(fsPromises, "rename", {
      configurable: true,
      value: async () => {
        const error = new Error(
          "injected rename failure"
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });

    try {
      await assert.rejects(
        recorder.appendEvents(manifestPath, [
          createStatusEventDraft(110, "failed manifest replacement"),
        ]),
        /injected rename failure/
      );
    } finally {
      Object.defineProperty(fsPromises, "rename", {
        configurable: true,
        value: originalRename,
      });
    }

    assert.strictEqual(await fs.readFile(manifestPath, "utf8"), original);
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

  test("streams a run whose output contains a raw U+2028 line separator", async () => {
    // JSON.stringify leaves U+2028/U+2029 unescaped, and Node's readline treats
    // both as line terminators -- reading events.jsonl that way splits one valid
    // record into malformed fragments and fails the whole run with
    // "Unterminated string in JSON". Web-fetched page content hits this.
    const lineSeparator = String.fromCharCode(0x2028);
    const response = `compliance summary${lineSeparator}across jurisdictions`;

    await recorder.appendEvents(manifestPath, [
      createStatusEventDraft(110, response),
      createStatusEventDraft(120, "after"),
    ]);

    const streamed = [];
    for await (const event of recorder.streamEvents(manifestPath)) {
      streamed.push(event);
    }

    assert.strictEqual(streamed.length, 2);
    assert.strictEqual(
      streamed[0].eventType,
      TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED
    );
    assert.deepStrictEqual(
      streamed.map((event) => event.sequence),
      [1, 2]
    );
    assert.deepStrictEqual(
      streamed,
      await recorder.readEvents(manifestPath),
      "streamEvents and readEvents must agree on record boundaries"
    );
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
    // The CLI logs to a file only in an initialized workspace.
    await fs.mkdir(path.join(tempDir, ".ctrlyoke"));
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
