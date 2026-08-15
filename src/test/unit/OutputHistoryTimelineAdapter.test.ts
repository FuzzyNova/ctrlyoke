import * as assert from "assert";
import { suite, test } from "mocha";
import {
  EXECUTION_PHASES,
  EXECUTION_STATES,
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
});
