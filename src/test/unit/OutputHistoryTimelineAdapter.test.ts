import * as assert from "assert";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  EXECUTION_PHASES,
  EXECUTION_STATES,
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "../../types/DashboardConstants";
import type { WorkflowOutputHistory } from "../../types/OutputHistoryTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import { getStepOutputText } from "../../utils/StepOutputText";
import { StepOutputTextMode } from "../../types/DashboardConstants";
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
    structured: {
      events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: response } }],
      metadata: {},
    },
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

function chunkAppended(
  sequence: number,
  chunk: string
): CliOutputChunkAppendedEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
    workflowId: "workflow",
    runId: 1,
    sequence,
    timestampMs: sequence,
    target: TARGET,
    runIndex: 0,
    attemptIndex: 0,
    payload: { chunk },
  };
}

function eventsAppended(
  sequence: number,
  text: string
): CliOutputEventsAppendedEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
    workflowId: "workflow",
    runId: 1,
    sequence,
    timestampMs: sequence,
    target: TARGET,
    runIndex: 0,
    attemptIndex: 0,
    payload: { events: [{ type: CLI_EVENT_TYPES.THINKING, data: { text } }] },
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
  test("joins script execution records into the completed dashboard output payload", () => {
    const script: ScriptExecutionRecordedEvent = {
      eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
      workflowId: "workflow",
      runId: 1,
      sequence: 1,
      timestampMs: 1,
      target: TARGET,
      runIndex: 0,
      attemptIndex: 0,
      definitionRevision: 1,
      payload: {
        command: "npm test",
        stdout: "passed",
        stderr: "",
        exitCode: 0,
      },
    };
    const history = new OutputHistoryTimelineAdapter().project(MANIFEST, [
      cliEvent(0, EXECUTION_PHASES.PROMPT, "passed"),
      script,
    ]);
    const entry = history.orderedEntries.find(
      (candidate) => candidate.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(entry && entry.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.deepStrictEqual(entry.cliOutput.scriptOutput, {
      command: "npm test",
      stdout: "passed",
      stderr: "",
      exitCode: 0,
    });
  });

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
    assert.strictEqual(
      cliEntries[0].kind === OUTPUT_HISTORY_KINDS.CLI &&
        getStepOutputText(
          { output: cliEntries[0].cliOutput },
          StepOutputTextMode.TRANSCRIPT
        ),
      "prompt output",
      "dashboard history retains the AI response as a normal CLI timeline entry"
    );
    assert.strictEqual(
      cliEntries[1].kind === OUTPUT_HISTORY_KINDS.CLI &&
        getStepOutputText(
          { output: cliEntries[1].cliOutput },
          StepOutputTextMode.TRANSCRIPT
        ),
      "condition output",
      "history retains condition output on its own phase-tagged attempt"
    );
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

  test("folds streamed deltas into a still-streaming entry once", () => {
    const streamingPlaceholder: CliOutputRecordedEvent = {
      ...cliEvent(0, EXECUTION_PHASES.PROMPT, ""),
      payload: { cliOutput: { ...output(""), isStreaming: true } },
    };
    const events = [
      streamingPlaceholder,
      chunkAppended(1, "hello "),
      chunkAppended(2, "world"),
      eventsAppended(3, "first"),
      eventsAppended(4, "second"),
    ];

    const history = new OutputHistoryTimelineAdapter().project(
      { ...MANIFEST, executionState: EXECUTION_STATES.RUNNING },
      events
    );

    const entry = history.orderedEntries.find(
      (candidate) => candidate.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(entry && entry.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.strictEqual(
      getStepOutputText(
        { output: entry.cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "hello world\n[Thinking]\nfirst\n[/Thinking]\n[Thinking]\nsecond\n[/Thinking]"
    );
    assert.deepStrictEqual(
      entry.cliOutput.structured?.events.map(
        (cli) => (cli.data as { text?: string }).text
      ),
      ["hello world", "first", "second"]
    );
  });

  test("drops deltas superseded by a completed aggregate", () => {
    const streamingPlaceholder: CliOutputRecordedEvent = {
      ...cliEvent(0, EXECUTION_PHASES.PROMPT, ""),
      payload: { cliOutput: { ...output(""), isStreaming: true } },
    };
    // The completed aggregate carries the attempt's *start* timestamp, so it
    // sorts ahead of the deltas it supersedes.
    const completed: CliOutputRecordedEvent = {
      ...cliEvent(1, EXECUTION_PHASES.PROMPT, "final response"),
      timestampMs: 0,
    };

    const history = new OutputHistoryTimelineAdapter().project(MANIFEST, [
      streamingPlaceholder,
      completed,
      chunkAppended(2, "stale"),
      eventsAppended(3, "stale"),
    ]);

    const entry = history.orderedEntries.find(
      (candidate) => candidate.kind === OUTPUT_HISTORY_KINDS.CLI
    );
    assert.ok(entry && entry.kind === OUTPUT_HISTORY_KINDS.CLI);
    assert.strictEqual(
      getStepOutputText(
        { output: entry.cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ),
      "final response"
    );
    assert.deepStrictEqual(entry.cliOutput.structured?.events, [
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "final response" } },
    ]);
  });

  // A paused-while-running step keeps streaming until it finishes. Sealing it
  // made the dashboard render its next batch under a "Follow-up" divider,
  // which a headless step can never produce.
  suite("keeps an in-flight attempt streaming", () => {
    const streamingPlaceholder: CliOutputRecordedEvent = {
      ...cliEvent(0, EXECUTION_PHASES.PROMPT, ""),
      payload: { cliOutput: { ...output(""), isStreaming: true } },
    };
    const cases = [
      { executionState: EXECUTION_STATES.RUNNING, isStreaming: true },
      { executionState: EXECUTION_STATES.PAUSING, isStreaming: true },
      { executionState: EXECUTION_STATES.CANCELLING, isStreaming: true },
      { executionState: EXECUTION_STATES.PAUSED, isStreaming: false },
      { executionState: EXECUTION_STATES.STOPPED, isStreaming: false },
    ];

    for (const { executionState, isStreaming } of cases) {
      test(`${executionState} -> isStreaming ${isStreaming}`, async () => {
        const manifest = { ...MANIFEST, executionState };
        const events = [streamingPlaceholder, eventsAppended(1, "live")];
        const findCli = (history: WorkflowOutputHistory) =>
          history.orderedEntries.find(
            (candidate) => candidate.kind === OUTPUT_HISTORY_KINDS.CLI
          );

        const projected = findCli(
          new OutputHistoryTimelineAdapter().project(manifest, events)
        );
        assert.ok(projected && projected.kind === OUTPUT_HISTORY_KINDS.CLI);
        assert.strictEqual(projected.cliOutput.isStreaming, isStreaming);

        const runDir = await fs.mkdtemp(
          path.join(os.tmpdir(), "ctrlyoke-timeline-adapter-")
        );
        try {
          const manifestPath = path.join(runDir, "manifest.json");
          await fs.writeFile(manifestPath, JSON.stringify(manifest));
          await fs.writeFile(
            path.join(runDir, "events.jsonl"),
            events.map((event) => JSON.stringify(event)).join("\n") + "\n"
          );
          const loaded = findCli(
            await new OutputHistoryTimelineAdapter().loadHistory(manifestPath)
          );
          assert.ok(loaded && loaded.kind === OUTPUT_HISTORY_KINDS.CLI);
          assert.strictEqual(loaded.cliOutput.isStreaming, isStreaming);
        } finally {
          await fs.rm(runDir, { recursive: true, force: true });
        }
      });
    }
  });
});
