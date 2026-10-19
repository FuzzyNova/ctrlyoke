/**
 * ReplayScript — the idle-gap cap that lets an 18-minute recorded run fit a
 * short clip without flattening its rhythm. Playback end to end is covered in
 * `runReplay.integration.test.ts`.
 */
import * as assert from "assert";
import { suite, test } from "mocha";
import {
  capIdleGaps,
  type RecordedAiAttempt,
  type ReplayScript,
} from "../../dev/replay/ReplayScript";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/WebviewMessageTypes";
import { TIMELINE_ATTEMPT_TERMINAL_STATES } from "../../types/WorkflowTimelineTypes";

const STARTED_AT = 1_000_000;

function textAt(offsetMs: number): CliEvent {
  return {
    type: CLI_EVENT_TYPES.TEXT,
    data: { text: `at ${offsetMs}` },
    timestamp: STARTED_AT + offsetMs,
  };
}

function attempt(offsets: number[], durationMs: number): RecordedAiAttempt {
  return {
    target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
    attemptIndex: 0,
    startedAt: STARTED_AT,
    durationMs,
    items: offsets.map((offsetMs, index) => ({
      offsetMs,
      sequence: index + 1,
      events: [textAt(offsetMs)],
    })),
    finalOutput: {
      structured: { events: offsets.map(textAt) },
    } as unknown as RecordedAiAttempt["finalOutput"],
    terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED,
  };
}

function scriptOf(recorded: RecordedAiAttempt): ReplayScript {
  return {
    attempts: new Map([["queue:0", [recorded]]]),
    scripts: [
      {
        command: "npm test",
        stdout: "",
        stderr: "",
        durationMs: 30_000,
        sequence: 99,
      },
      {
        command: "true",
        stdout: "",
        stderr: "",
        durationMs: 200,
        sequence: 100,
      },
    ],
  };
}

function cappedAttempt(script: ReplayScript): RecordedAiAttempt {
  const capped = script.attempts.get("queue:0")?.[0];
  assert.ok(capped);
  return capped;
}

suite("ReplayScript idle-gap cap", () => {
  test("plays long gaps as the cap and short gaps as recorded", () => {
    // Gaps: 500 (kept), 60 000 (capped), 300 (kept), 20 000 to the end (capped).
    const capped = cappedAttempt(
      capIdleGaps(scriptOf(attempt([500, 60_500, 60_800], 80_800)), 2_000)
    );
    assert.deepStrictEqual(
      capped.items.map((item) => item.offsetMs),
      [500, 2_500, 2_800]
    );
    assert.strictEqual(capped.durationMs, 4_800);
  });

  test("moves event timestamps with their delivery", () => {
    const capped = cappedAttempt(
      capIdleGaps(scriptOf(attempt([500, 60_500], 61_000)), 2_000)
    );
    assert.deepStrictEqual(
      capped.items.map((item) => item.events?.[0]?.timestamp),
      [STARTED_AT + 500, STARTED_AT + 2_500]
    );
    assert.deepStrictEqual(
      capped.finalOutput?.structured?.events.map((event) => event.timestamp),
      [STARTED_AT + 500, STARTED_AT + 2_500]
    );
  });

  test("keeps a time inside a capped gap in order", () => {
    const recorded = attempt([0, 10_000], 10_000);
    recorded.items[1].events = [textAt(4_000), textAt(10_000)];
    const events = cappedAttempt(capIdleGaps(scriptOf(recorded), 1_000))
      .items[1].events;
    assert.deepStrictEqual(
      events?.map((event) => event.timestamp),
      [STARTED_AT + 400, STARTED_AT + 1_000]
    );
  });

  test("caps script durations and leaves short ones alone", () => {
    const capped = capIdleGaps(scriptOf(attempt([100], 100)), 2_000);
    assert.deepStrictEqual(
      capped.scripts.map((script) => script.durationMs),
      [2_000, 200]
    );
  });
});
