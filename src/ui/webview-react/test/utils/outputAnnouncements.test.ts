import { describe, expect, it } from "vitest";
import {
  CLI_EVENT_TYPES,
  EXECUTION_PHASES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  OPERATION_STATUS,
  OUTPUT_ANNOUNCEMENT_MODES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  type StepStatus,
} from "@root/types/DashboardConstants";
import type { CliEvent } from "@root/types/CliOutputTypes";
import type {
  OrderedCliHistoryEntry,
  OrderedHistoryEntry,
} from "@root/types/OutputHistoryTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
  OutputAnnouncementTracker,
  STREAMING_ANNOUNCEMENT_INTERVAL_MS,
  describeLastResponse,
  type OutputAnnouncementSnapshot,
} from "@utils/outputAnnouncements";

function text(value: string): CliEvent {
  return { type: CLI_EVENT_TYPES.TEXT, data: { text: value } };
}

function entry(
  stepIndex: number,
  events: CliEvent[],
  isStreaming: boolean,
  overrides: Partial<OrderedCliHistoryEntry> = {}
): OrderedCliHistoryEntry {
  return {
    kind: OUTPUT_HISTORY_KINDS.CLI,
    timestampMs: 1000 + stepIndex,
    sequence: stepIndex,
    target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
    runIndex: 0,
    attemptIndex: 0,
    cliOutput: {
      elapsed: 0,
      isStreaming,
      structured: { events, metadata: {} },
    },
    ...overrides,
  };
}

function step(name: string, status?: StepStatus): WorkflowStep {
  return { type: "prompt", prompt: "p", name, status } as WorkflowStep;
}

function snapshot(
  overrides: Partial<OutputAnnouncementSnapshot> = {}
): OutputAnnouncementSnapshot {
  return {
    viewKey: "draft:wf",
    entriesFromHistory: false,
    executionState: EXECUTION_STATES.RUNNING,
    steps: [step("Plan"), step("Build")],
    finalStep: null,
    finalStepStatus: null,
    finalStepLoopCount: 0,
    entries: [],
    nowMs: 0,
    ...overrides,
  };
}

describe("OutputAnnouncementTracker", () => {
  it("never announces what is already on screen", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    expect(
      tracker.observe(
        snapshot({
          steps: [step("Plan", STEP_STATUS.COMPLETED), step("Build")],
          entries: [entry(0, [text("Done planning.")], false)],
        })
      )
    ).toEqual([]);
  });

  it("announces steps finishing and starting, in that order", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(
      snapshot({ steps: [step("Plan", STEP_STATUS.RUNNING), step("Build")] })
    );
    expect(
      tracker.observe(
        snapshot({
          steps: [
            step("Plan", STEP_STATUS.COMPLETED),
            step("Build", STEP_STATUS.RUNNING),
          ],
        })
      )
    ).toEqual(["Step 1, Plan, completed.", "Step 2, Build, started."]);
  });

  it("ignores status differences while nothing is running", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(
      snapshot({
        executionState: EXECUTION_STATES.IDLE,
        steps: [step("Plan", STEP_STATUS.COMPLETED), step("Build")],
      })
    );
    // A reorder swaps statuses between indexes; it is not a step finishing.
    expect(
      tracker.observe(
        snapshot({
          executionState: EXECUTION_STATES.IDLE,
          steps: [step("Build"), step("Plan", STEP_STATUS.COMPLETED)],
        })
      )
    ).toEqual([]);
  });

  it("reads a response's summary and final message once it stops streaming", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    const streamed = [text("Let me check.")];
    tracker.observe(snapshot({ entries: [entry(0, streamed, true)] }));
    const finished = [
      ...streamed,
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: { path: "src/a.ts" },
      } as CliEvent,
      text("Fixed **the bug** in `a.ts`."),
    ];
    expect(
      tracker.observe(snapshot({ entries: [entry(0, finished, false)] }))
    ).toEqual([
      "Step 1, Plan, response: Changed 1 file. Fixed the bug in a.ts.",
    ]);
  });

  it("announces a response that arrives already finished", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(snapshot());
    expect(
      tracker.observe(
        snapshot({ entries: [entry(1, [text("Built.")], false)] })
      )
    ).toEqual(["Step 2, Build, response: Built."]);
  });

  it("does not re-announce a finished response replayed into a new array", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(snapshot({ entries: [entry(0, [text("a")], true)] }));
    tracker.observe(snapshot({ entries: [entry(0, [text("a")], false)] }));
    expect(
      tracker.observe(snapshot({ entries: [entry(0, [text("a")], false)] }))
    ).toEqual([]);
  });

  it("skips condition and script output", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(snapshot());
    expect(
      tracker.observe(
        snapshot({
          entries: [
            entry(0, [text("stdout")], false, {
              phase: EXECUTION_PHASES.END_CONDITION,
            }),
          ] as OrderedHistoryEntry[],
        })
      )
    ).toEqual([]);
  });

  it("announces a pending question once, with its options", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(snapshot({ entries: [entry(0, [], true)] }));
    const asked: CliEvent = {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      data: {
        toolCallId: "q1",
        status: OPERATION_STATUS.INITIATED,
        questions: [
          {
            question: "Which database?",
            header: "Storage",
            options: [{ label: "SQLite" }, { label: "Postgres" }],
          },
        ],
      },
    };
    expect(
      tracker.observe(snapshot({ entries: [entry(0, [asked], true)] }))
    ).toEqual([
      "Step 1, Plan, asks: Storage: Which database? Options: SQLite, Postgres.",
    ]);
    expect(
      tracker.observe(
        snapshot({ entries: [entry(0, [asked, text("Using SQLite")], true)] })
      )
    ).toEqual([]);
  });

  it("starts a new baseline when the viewed workflow changes", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    tracker.observe(snapshot());
    expect(
      tracker.observe(
        snapshot({
          viewKey: "draft:other",
          steps: [step("Plan", STEP_STATUS.COMPLETED)],
          entries: [entry(0, [text("Old reply.")], false)],
        })
      )
    ).toEqual([]);
  });

  it("announces the workflow ending and a final-step pass by its pass number", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS
    );
    const finalStep = step("Review");
    tracker.observe(
      snapshot({
        finalStep,
        finalStepLoopCount: 1,
        finalStepStatus: STEP_STATUS.RUNNING,
      })
    );
    expect(
      tracker.observe(
        snapshot({
          executionState: EXECUTION_STATES.COMPLETED,
          finalStep,
          finalStepLoopCount: 1,
          finalStepStatus: STEP_STATUS.COMPLETED,
        })
      )
    ).toEqual(["Final Step Pass 2, Review, completed.", "Workflow completed."]);
  });

  it("announces nothing when off", () => {
    const tracker = new OutputAnnouncementTracker(
      OUTPUT_ANNOUNCEMENT_MODES.NONE
    );
    tracker.observe(snapshot({ entries: [entry(0, [text("a")], true)] }));
    expect(
      tracker.observe(
        snapshot({
          steps: [step("Plan", STEP_STATUS.COMPLETED), step("Build")],
          entries: [entry(0, [text("a")], false)],
        })
      )
    ).toEqual([]);
  });

  describe("streaming mode", () => {
    it("reads complete paragraphs at most once per interval, then the rest", () => {
      const tracker = new OutputAnnouncementTracker(
        OUTPUT_ANNOUNCEMENT_MODES.STREAMING
      );
      tracker.observe(snapshot({ entries: [entry(0, [], true)] }));

      expect(
        tracker.observe(
          snapshot({
            nowMs: 0,
            entries: [entry(0, [text("First part.\n\nSecond")], true)],
          })
        )
      ).toEqual(["First part."]);

      // A new paragraph completes, but too soon after the last announcement.
      const tooSoon = text("First part.\n\nSecond part.\n\nThird");
      expect(
        tracker.observe(
          snapshot({ nowMs: 1000, entries: [entry(0, [tooSoon], true)] })
        )
      ).toEqual([]);
      expect(
        tracker.observe(
          snapshot({
            nowMs: STREAMING_ANNOUNCEMENT_INTERVAL_MS,
            entries: [
              entry(
                0,
                [text("First part.\n\nSecond part.\n\nThird, more")],
                true
              ),
            ],
          })
        )
      ).toEqual(["Second part."]);

      expect(
        tracker.observe(
          snapshot({
            nowMs: STREAMING_ANNOUNCEMENT_INTERVAL_MS + 100,
            entries: [
              entry(
                0,
                [text("First part.\n\nSecond part.\n\nThird part.")],
                false
              ),
            ],
          })
        )
      ).toEqual(["Step 1, Plan, response finished. Third part."]);
    });
  });
});

describe("describeLastResponse", () => {
  const names = { steps: [step("Plan"), step("Build")], finalStep: null };

  it("reads the newest finished response", () => {
    expect(
      describeLastResponse(
        [
          entry(1, [text("Second.")], false),
          entry(0, [text("First.")], false),
          entry(1, [text("Still going")], true, {
            runIndex: 1,
            timestampMs: 5000,
          }),
        ],
        names
      )
    ).toBe("Step 2, Build, response: Second.");
  });

  it("says so when there is nothing to read", () => {
    expect(describeLastResponse([], names)).toBe(
      "No finished response to read yet."
    );
  });
});
