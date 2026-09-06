import * as assert from "assert";
import { suite, test } from "mocha";
import {
  EXECUTION_PHASES,
  EXECUTION_STATES,
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "../../types/DashboardConstants";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_EVENT_TYPES,
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_STORAGE_KIND,
  type CliOutputRecordedEvent,
  type CliOutputChunkAppendedEvent,
  type CliOutputEventsAppendedEvent,
  type ScriptExecutionRecordedEvent,
  type StatusMessageRecordedEvent,
  type WorkflowRunManifest,
} from "../../types/WorkflowTimelineTypes";
import {
  OutputHistoryTimelineAdapter,
  getCliEntryKey,
} from "../../core/orchestration/OutputHistoryTimelineAdapter";

const TARGET = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

function output(response: string): CliOutput {
  return {
    prompt: response,
    response,
    elapsed: 0,
    isStreaming: false,
  };
}

function cliEvent(
  sequence: number,
  phase: CliOutputRecordedEvent["phase"],
  response: string
): CliOutputRecordedEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
    workflowId: "workflow",
    runId: 1,
    sequence,
    timestampMs: sequence,
    target: TARGET,
    runIndex: 0,
    attemptIndex: 0,
    phase,
    responseKind:
      phase === EXECUTION_PHASES.END_CONDITION
        ? TIMELINE_ATTEMPT_KINDS.CONDITION
        : phase === EXECUTION_PHASES.WORKTREE_SETUP
          ? TIMELINE_ATTEMPT_KINDS.SETUP
          : TIMELINE_ATTEMPT_KINDS.AI,
    payload: { cliOutput: output(response) },
  };
}

const MANIFEST: WorkflowRunManifest = {
  schemaVersion: TIMELINE_SCHEMA_VERSION,
  storageKind: TIMELINE_STORAGE_KIND,
  workflowId: "workflow",
  runId: 1,
  startedAt: 0,
  executionState: EXECUTION_STATES.COMPLETED,
  definitionRevision: 1,
  stepCount: 1,
  eventCount: 2,
  nextSequence: 2,
  lastUpdatedAt: 2,
};

suite("OutputHistoryTimelineAdapter", () => {
  test("deduplicates CLI entries by execution phase while preserving prompt keys", () => {
    const adapter = new OutputHistoryTimelineAdapter();
    const history = adapter.project(MANIFEST, [
      cliEvent(0, EXECUTION_PHASES.PROMPT, "prompt output"),
      cliEvent(1, EXECUTION_PHASES.END_CONDITION, "condition output"),
    ]);

    const cliEntries = history.orderedEntries.filter(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.strictEqual(cliEntries.length, 2);
    assert.deepStrictEqual(
      cliEntries.map(
        (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI && entry.phase
      ),
      [EXECUTION_PHASES.PROMPT, EXECUTION_PHASES.END_CONDITION]
    );
    assert.strictEqual(getCliEntryKey(TARGET, 0, 0), "queue:0:run:0:attempt:0");
    assert.strictEqual(
      getCliEntryKey(TARGET, 0, 0, EXECUTION_PHASES.PROMPT),
      "queue:0:run:0:attempt:0"
    );
  });

  test("keeps setup and prompt entries distinct at the same attempt identity", () => {
    const adapter = new OutputHistoryTimelineAdapter();
    const history = adapter.project(MANIFEST, [
      cliEvent(0, EXECUTION_PHASES.PROMPT, "prompt output"),
      cliEvent(1, EXECUTION_PHASES.WORKTREE_SETUP, "setup output"),
    ]);

    const cliEntries = history.orderedEntries.filter(
      (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.strictEqual(cliEntries.length, 2);
    assert.deepStrictEqual(
      cliEntries.map(
        (entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI && entry.phase
      ),
      [EXECUTION_PHASES.PROMPT, EXECUTION_PHASES.WORKTREE_SETUP]
    );
    assert.notStrictEqual(
      getCliEntryKey(TARGET, 0, 0, EXECUTION_PHASES.PROMPT),
      getCliEntryKey(TARGET, 0, 0, EXECUTION_PHASES.WORKTREE_SETUP)
    );
  });

  test("projects target-attributed activity entries in durable order", () => {
    const chunk: CliOutputChunkAppendedEvent = {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
      workflowId: "workflow",
      runId: 1,
      sequence: 4,
      timestampMs: 40,
      target: TARGET,
      runIndex: 2,
      attemptIndex: 1,
      payload: { chunk: "text" },
    };
    const structured: CliOutputEventsAppendedEvent = {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
      workflowId: "workflow",
      runId: 1,
      sequence: 5,
      timestampMs: 50,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
      runIndex: 2,
      attemptIndex: 1,
      payload: {
        events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "structured" } }],
      },
    };
    const status: StatusMessageRecordedEvent = {
      eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      workflowId: "workflow",
      runId: 1,
      sequence: 6,
      timestampMs: 60,
      target: TARGET,
      payload: {
        statusMessage: {
          message: "waiting",
          severity: "info",
          timestamp: 60,
        },
      },
    };
    const script: ScriptExecutionRecordedEvent = {
      eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
      workflowId: "workflow",
      runId: 1,
      sequence: 7,
      timestampMs: 70,
      target: TARGET,
      runIndex: 2,
      attemptIndex: 1,
      definitionRevision: 1,
      payload: {
        command: "npm test",
        stdout: "out",
        stderr: "err",
        exitCode: 0,
      },
    };

    const history = new OutputHistoryTimelineAdapter().project(MANIFEST, [
      script,
      status,
      structured,
      chunk,
    ]);

    // SCRIPT_EXECUTION_RECORDED (the `script` event) carries the same text a
    // CLI_OUTPUT_CHUNK_APPENDED delta already streamed for this attempt, so it
    // must not also project into activityEntries — that duplicated the
    // script's own output on every history reload.
    assert.deepStrictEqual(
      history.activityEntries?.map((entry) => ({
        sequence: entry.sequence,
        target: entry.target,
        runIndex: entry.runIndex,
        attemptIndex: entry.attemptIndex,
        kind: entry.kind,
      })),
      [
        {
          sequence: 4,
          target: TARGET,
          runIndex: 2,
          attemptIndex: 1,
          kind: "text",
        },
        {
          sequence: 5,
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          runIndex: 2,
          attemptIndex: 1,
          kind: "structured",
        },
        {
          sequence: 6,
          target: TARGET,
          runIndex: 0,
          attemptIndex: 0,
          kind: "status",
        },
      ]
    );
    assert.strictEqual(history.activityEntries?.[0]?.text, "text");
    assert.deepStrictEqual(history.activityEntries?.[1]?.events, [
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "structured" } },
    ]);
  });
});
