import * as assert from "assert";
import { suite, test } from "mocha";
import { HistoryRunDocumentBuilder } from "../../core/orchestration/HistoryRunDocumentBuilder";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { CliEvent, CliOutput } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_STORAGE_KIND,
  type CliOutputEventsAppendedEvent,
  type CliOutputRecordedEvent,
  type StatusMessageRecordedEvent,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

suite("HistoryRunDocumentBuilder", () => {
  test("builds identical capped documents from a run stream and its events", async () => {
    const builder = new HistoryRunDocumentBuilder(5);
    const context = {
      manifest: createManifest(),
      workflowKey: "builder-test" as WorkflowKey,
      runRef: "run-1000" as RunRef,
      workflowName: "Builder Test",
    };
    const events = createEvents();

    const documentsFromRun = await builder.buildRunDocuments(
      streamEvents(events),
      context
    );
    const documentsFromEvents = events.flatMap((event) =>
      builder.buildEventDocuments(event, context)
    );

    assert.deepStrictEqual(documentsFromRun, documentsFromEvents);
    assert.deepStrictEqual(
      documentsFromRun.map(({ text, textLower }) => ({ text, textLower })),
      [
        { text: "promp", textLower: "promp" },
        { text: "strea", textLower: "strea" },
        { text: "statu", textLower: "statu" },
      ]
    );
    assert.strictEqual(documentsFromRun[0]?.attemptIndex, 2);
    assert.strictEqual(documentsFromRun[1]?.attemptIndex, 3);
    assert.strictEqual(documentsFromRun[2]?.attemptIndex, 0);
    assert.strictEqual(documentsFromRun[0]?.harness, undefined);
    assert.strictEqual(documentsFromRun[0]?.sessionId, undefined);
    assert.strictEqual(
      documentsFromRun[0]?.id,
      "builder-test:run-1000:7:1:prompt:content:0"
    );
  });

  test("indexes script stdout as output text", () => {
    const builder = new HistoryRunDocumentBuilder();
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const [document] = builder.buildEventDocuments(
      {
        eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
        workflowId: "builder-test",
        runId: 7,
        sequence: 4,
        timestampMs: 1400,
        target,
        runIndex: 0,
        attemptIndex: 4,
        definitionRevision: 1,
        payload: {
          command: "npm test",
          stdout: "stdout search hit",
          stderr: "stderr details",
          exitCode: 1,
        },
      },
      {
        manifest: createManifest(),
        workflowKey: "builder-test" as WorkflowKey,
        runRef: "run-1000" as RunRef,
        workflowName: "Builder Test",
      }
    );
    assert.strictEqual(document?.eventKind, "script");
    assert.strictEqual(document?.matchField, "output");
    assert.strictEqual(document?.text, "stdout search hit");
  });

  async function* streamEvents(
    events: WorkflowTimelineEvent[]
  ): AsyncGenerator<WorkflowTimelineEvent> {
    yield* events;
  }

  function createManifest(): WorkflowRunManifest {
    return {
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      storageKind: TIMELINE_STORAGE_KIND,
      workflowId: "builder-test",
      runId: 7,
      startedAt: 1000,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 1,
      stepCount: 1,
      eventCount: 3,
      nextSequence: 4,
      lastUpdatedAt: 2000,
    };
  }

  function createEvents(): WorkflowTimelineEvent[] {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const structuredEvents: CliEvent[] = [];
    const cliOutput: CliOutput = {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: structuredEvents,
        metadata: {
          harness: "codex-cli" as HarnessId,
          model: "model-1",
          sessionId: "session-1",
        },
      },
    };

    const attemptStarted = {
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
      workflowId: "builder-test",
      runId: 7,
      sequence: 1,
      timestampMs: 1000,
      target,
      attemptIndex: 2,
      runIndex: 0,
      definitionRevision: 1,
      payload: { kind: "ai", startReason: "initial", prompt: "prompt" },
    } as const;
    const cliOutputEvent: CliOutputRecordedEvent = {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      workflowId: "builder-test",
      runId: 7,
      sequence: 2,
      timestampMs: 1100,
      target,
      attemptIndex: 2,
      payload: { cliOutput },
    };
    const appendedEvent: CliOutputEventsAppendedEvent = {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
      workflowId: "builder-test",
      runId: 7,
      sequence: 3,
      timestampMs: 1200,
      target,
      attemptIndex: 3,
      payload: {
        events: [
          {
            type: CLI_EVENT_TYPES.TEXT,
            data: { text: "stream text" },
          },
        ],
      },
    };
    const statusEvent: StatusMessageRecordedEvent = {
      eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      workflowId: "builder-test",
      runId: 7,
      sequence: 4,
      timestampMs: 1300,
      target,
      payload: {
        statusMessage: {
          message: "status text",
          severity: "info",
          timestamp: 1300,
        },
      },
    };

    return [attemptStarted, cliOutputEvent, appendedEvent, statusEvent];
  }
});
