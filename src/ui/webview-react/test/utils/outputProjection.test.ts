import { describe, expect, it } from "vitest";
import { mapOrderedHistoryEntriesToMessages } from "@utils/outputProjection";
import {
  CLI_EVENT_TYPES,
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  OPERATION_STATUS,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_HISTORY_KINDS,
} from "@/types/messages";

describe("outputProjection", () => {
  it("maps canonical ordered entries with sequence-preserved chronology", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
        attemptIndex: 0,
        cliOutput: {

          structured: { events: [{ type: "text", data: { text: "final response" } }], metadata: {} },
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 2,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.STATUS,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        statusMessage: {
          message: "queue first",
          severity: "info",
          timestamp: 1000,
        },
        timestampMs: 1000,
        sequence: 1,
      },
    ]);

    expect(
      messages.map((message) => `${message.type}:${message.target.kind}`)
    ).toEqual(["status:queue", "cli:finalStep"]);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[1]?.sequence).toBe(2);
  });

  it("normalizes runIndex from ordered entries or cli output", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 2,
        attemptIndex: 0,
        cliOutput: {

          structured: { events: [{ type: "text", data: { text: "explicit run" } }], metadata: {} },
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 1,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 1,
        cliOutput: {

          structured: { events: [{ type: "text", data: { text: "fallback run" } }], metadata: {} },
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1001,
          runIndex: 3,
        },
        timestampMs: 1001,
        sequence: 2,
      },
    ]);

    expect(messages.map((message) => message.runIndex)).toEqual([2, 3]);
  });

  it("projects streaming and completed snapshots of one setup attempt as one message", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 0,
        phase: "worktreeSetup",
        cliOutput: {
          structured: { events: [{ type: "text", data: { text: "" } }], metadata: {} },
          elapsed: 0,
          isStreaming: true,
          source: "worktreeSetup",
          timestampMs: 1000,
          cliCommand: "npm ci",
          workingDirectory: "C:\\repo.worktrees\\feature",
        },
        timestampMs: 1000,
        sequence: 1,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 0,
        phase: "worktreeSetup",
        cliOutput: {
          structured: { events: [{ type: "text", data: { text: "installed packages" } }], metadata: {} },
          elapsed: 22,
          isStreaming: false,
          source: "worktreeSetup",
          timestampMs: 1000,
          cliCommand: "npm ci",
          workingDirectory: "C:\\repo.worktrees\\feature",
          exitCode: 0,
        },
        timestampMs: 1022,
        sequence: 2,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      timestamp: 1000,
      sequence: 1,
      data: {
        isStreaming: false,
        structured: {
          events: [
            { type: CLI_EVENT_TYPES.TEXT, data: { text: "installed packages" } },
          ],
          metadata: {},
        },
        cliCommand: "npm ci",
      },
    });
  });

  it("keeps interleaved target activity in timeline order", () => {
    const targetA = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const targetB = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [
        ...[targetA, targetB].map((target) => ({
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target,
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: {
            prompt: "",
            response: "",
            elapsed: 0,
            isStreaming: false,
            timestampMs: 1000,
          },
          timestampMs: 1000,
          sequence: 10,
        })),
      ],
      [
        {
          timestampMs: 1000,
          sequence: 1,
          target: targetA,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "A1",
        },
        {
          timestampMs: 1001,
          sequence: 2,
          target: targetB,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "B1",
        },
        {
          timestampMs: 1002,
          sequence: 3,
          target: targetA,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "A2",
        },
      ]
    );

    expect(messages.map((message) => message.activityText)).toEqual([
      "A1",
      "B1",
      "A2",
    ]);
  });

  // A STATUS activity suppresses the aggregate OrderedStatusHistoryEntry for
  // the same target, so the activity's severity is the only one the rendered
  // row can read. It used to be hardcoded to info, which painted every warning
  // and error blue — including the "Execution failed" row for a workflow that
  // had just been torn down.
  it("carries a status message's severity onto its activity message", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 3 } as const;
    const statusMessage = {
      message: "Execution failed: Failed to write working file: EPERM",
      severity: "error",
      timestamp: 1000,
    } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [
        {
          kind: OUTPUT_HISTORY_KINDS.STATUS,
          target,
          statusMessage,
          timestampMs: 1000,
          sequence: 1,
        },
      ],
      [
        {
          timestampMs: 1000,
          sequence: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STATUS,
          text: statusMessage.message,
          severity: statusMessage.severity,
        },
      ]
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toMatchObject({
      message: statusMessage.message,
      severity: "error",
    });
  });

  it("falls back to info for a status activity projected without a severity", () => {
    // Runs projected before `severity` existed on OutputActivityEntry.
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [],
      [
        {
          timestampMs: 1000,
          sequence: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STATUS,
          text: "Running end condition",
        },
      ]
    );

    expect(messages[0]?.data).toMatchObject({ severity: "info" });
  });

  // Activities stand in for the aggregate of *their own* identity, not for
  // everything sharing the step. A condition script that exits without writing
  // to stdout streams no chunk, so it produces no activity at all — and when
  // the suppression was keyed by target, the step's AI activities erased that
  // script's only row, taking its command, exit code and verdict with it.
  it("keeps an aggregate whose own identity produced no activity", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target,
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: {

            structured: { events: [{ type: "text", data: { text: "done" } }], metadata: {} },
            elapsed: 12,
            isStreaming: false,
            timestampMs: 1000,
          },
          timestampMs: 1000,
          sequence: 1,
        },
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target,
          runIndex: 0,
          attemptIndex: 0,
          phase: EXECUTION_PHASES.END_CONDITION,
          cliOutput: {
            structured: { events: [{ type: "text", data: { text: "" } }], metadata: {} },
            elapsed: 0.2,
            isStreaming: false,
            cliCommand: "npm test",
            exitCode: 0,
            timestampMs: 2000,
          },
          timestampMs: 2000,
          sequence: 3,
        },
      ],
      [
        {
          timestampMs: 1000,
          sequence: 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "done",
        },
      ]
    );

    // The prompt-phase aggregate is replaced by its activity; the silent
    // end-condition aggregate has no stand-in and must survive untouched.
    const endCondition = messages.filter(
      (message) => message.phase === EXECUTION_PHASES.END_CONDITION
    );
    expect(endCondition).toHaveLength(1);
    expect(endCondition[0]?.isActivity).toBeUndefined();
    expect(endCondition[0]?.data).toMatchObject({
      cliCommand: "npm test",
      exitCode: 0,
    });
    expect(
      messages.filter(
        (message) => message.phase === undefined && message.isActivity !== true
      )
    ).toHaveLength(0);
  });

  // A follow-up burst that arrives after an attempt completed is only visible
  // on reload if it was persisted as its own activity entry. The aggregate's
  // `structured.events` is not a fallback: activities supersede the aggregate
  // of their identity, so a burst recorded only there rendered live and then
  // vanished — the shape this pair of cases pins down.
  describe("post-completion follow-up activity", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const followUpEvents = [
      { type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED, data: { resumedAt: 3000 } },
      { type: CLI_EVENT_TYPES.USER_STEER, data: { text: "/commit" } },
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "Committed as 4af641d9" } },
    ];
    const orderedEntries = [
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput: {
          prompt: "do the thing",
          response: "done",
          structured: {
            // The merged aggregate holds the whole attempt: its original
            // stream plus every follow-up burst appended past the divider.
            events: [
              { type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } },
              ...followUpEvents,
            ],
            metadata: {},
          },
          elapsed: 12,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 1,
      },
    ];
    const originalStreamActivity = {
      timestampMs: 1000,
      sequence: 2,
      target,
      runIndex: 0,
      attemptIndex: 0,
      kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
      events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } }],
    };

    it("never falls back to a superseded aggregate's own events", () => {
      const messages = mapOrderedHistoryEntriesToMessages(orderedEntries, [
        originalStreamActivity,
      ]);

      // The aggregate is superseded by its activity, so its extra events are
      // unreachable — this is why the extension must persist the burst.
      expect(
        messages.flatMap((message) =>
          (message.activityEvents ?? []).map((event) => event.type)
        )
      ).toEqual([CLI_EVENT_TYPES.TEXT]);
      expect(
        messages.filter((message) => message.isActivity !== true)
      ).toHaveLength(0);
    });

    it("renders the follow-up once it is persisted as its own activity", () => {
      const messages = mapOrderedHistoryEntriesToMessages(orderedEntries, [
        originalStreamActivity,
        {
          timestampMs: 3000,
          sequence: 3,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
          events: followUpEvents,
        },
      ]);

      expect(
        messages.flatMap((message) =>
          (message.activityEvents ?? []).map((event) => event.type)
        )
      ).toEqual([
        CLI_EVENT_TYPES.TEXT,
        CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
        CLI_EVENT_TYPES.USER_STEER,
        CLI_EVENT_TYPES.TEXT,
      ]);
      // The follow-up slice still reads its stats/tokens from the aggregate it
      // supersedes, so the attempt's footer stays correct.
      expect(messages[messages.length - 1]?.aggregate).toMatchObject({
        response: "done",
        elapsed: 12,
      });
    });
  });

  it("carries the attempt's prompt and command onto its activity messages", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target,
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: {

            cliCommand: "claude -p ...",
            structured: { events: [{ type: "text", data: { text: "" } }], metadata: {} },
            elapsed: 0,
            isStreaming: false,
            timestampMs: 1000,
          },
          timestampMs: 1000,
          sequence: 10,
        },
      ],
      [
        {
          timestampMs: 1001,
          sequence: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "Reading files...",
        },
      ]
    );

    // Activity projection replaces the aggregate message, but must keep the
    // aggregate's prompt/command reachable via `message.aggregate` so
    // buildOutputRows can still emit the PROMPT/CLI_COMMAND leading-chrome
    // rows for the attempt. A mismatched identity-key format between the two
    // lookups previously made this lookup always miss.
    const activityMessage = messages.find((message) => message.isActivity);
    expect(activityMessage?.aggregate).toMatchObject({
      cliCommand: "claude -p ...",
    });
  });

  it("updates a tool activity in place when its result arrives", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [],
      [
        {
          timestampMs: 1000,
          sequence: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
          events: [
            {
              type: CLI_EVENT_TYPES.TOOL_CALL,
              data: { id: "tool-1", name: "read", parameters: {} },
            },
          ],
        },
        {
          timestampMs: 1001,
          sequence: 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
          events: [
            {
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              data: {
                toolCallId: "tool-1",
                result: { success: true, output: "done" },
              },
            },
          ],
        },
      ]
    );

    // The result folds into the call it answers rather than replacing it, and
    // stays anchored to the slice the call arrived in — a completed block, at
    // the moment the tool started.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[0]?.activityEvents).toHaveLength(1);
    expect(messages[0]?.activityEvents?.[0]).toMatchObject({
      type: CLI_EVENT_TYPES.TOOL_CALL,
      data: { id: "tool-1", result: { success: true, output: "done" } },
    });
  });

  it("completes a semantic operation whose halves arrive in different slices", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const slice = (
      sequence: number,
      events: { type: string; data: Record<string, unknown> }[]
    ) =>
      ({
        timestampMs: 1000 + sequence,
        sequence,
        target,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
        events,
      }) as never;

    const messages = mapOrderedHistoryEntriesToMessages(
      [],
      [
        slice(1, [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            data: {
              command: "npm run lint",
              status: OPERATION_STATUS.INITIATED,
            },
          },
        ]),
        slice(2, [
          { type: CLI_EVENT_TYPES.THINKING, data: { text: "considering" } },
        ]),
        slice(3, [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            data: {
              command: "npm run lint",
              status: OPERATION_STATUS.COMPLETED,
              exitCode: 0,
              output: "all good",
            },
          },
        ]),
      ]
    );

    // The completion merges back into the slice that opened the command, so the
    // block stays where the command started and carries its output. Slice 3 has
    // nothing left of its own and is dropped rather than drawn as an empty row.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[0]?.activityEvents).toHaveLength(1);
    expect(messages[0]?.activityEvents?.[0]).toMatchObject({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: { status: OPERATION_STATUS.COMPLETED, output: "all good" },
    });
    expect(messages[1]?.sequence).toBe(2);
    expect(messages[1]?.activityEvents?.[0]).toMatchObject({
      type: CLI_EVENT_TYPES.THINKING,
    });
  });

  it("keeps every slice whose first event has no stable identity", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const commands = ["one", "two", "three"];
    const messages = mapOrderedHistoryEntriesToMessages(
      [],
      commands.map(
        (command, index) =>
          ({
            timestampMs: 1000 + index,
            sequence: index + 1,
            target,
            runIndex: 0,
            attemptIndex: 0,
            kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
            events: [
              {
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                data: { command, status: OPERATION_STATUS.INITIATED },
              },
            ],
          }) as never
      )
    );

    // A bash event carries no tool-call id, so keying slices by their first
    // event collapsed every one of these into a single message.
    expect(
      messages.map(
        (message) =>
          (message.activityEvents?.[0]?.data as { command?: string }).command
      )
    ).toEqual(commands);
  });

  it("keeps live and replay projections in the same interleaved order", () => {
    const targetA = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const targetB = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
    const orderedEntries = [
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: targetA,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "complete A",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 5,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: targetB,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "complete B",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 6,
      },
    ] as const;
    const activityEntries = [
      {
        timestampMs: 1000,
        sequence: 1,
        target: targetA,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "A1",
      },
      {
        timestampMs: 1001,
        sequence: 2,
        target: targetB,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "B1",
      },
      {
        timestampMs: 1002,
        sequence: 3,
        target: targetA,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "A2",
      },
    ] as const;

    const project = () =>
      mapOrderedHistoryEntriesToMessages(orderedEntries, activityEntries);
    const liveProjection = project();
    const replayProjection = project();

    expect(
      liveProjection.map(
        (message) => `${message.target.index}:${message.activityText}`
      )
    ).toEqual(["0:A1", "1:B1", "0:A2"]);
    expect(replayProjection).toEqual(liveProjection);
  });
});
