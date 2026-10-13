import * as assert from "assert";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CliLogMonitor } from "../../core/harness/CliLogMonitor";
import { getTranscriptText } from "../../utils/StepOutputText";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";
import type { INotificationMonitor } from "../../core/harness/shared/interfaces/INotificationMonitor";
import { ClaudeLogParser } from "../../core/harness/claude/ClaudeLogParser";
import { CopilotLogParser } from "../../core/harness/copilot/CopilotLogParser";
import { AntigravityLogParser } from "../../core/harness/antigravity/AntigravityLogParser";
import { CLI_EVENT_TYPES, FAILURE_KINDS } from "../../types/DashboardConstants";
import type {
  BackgroundWorkHoldData,
  CliEvent,
  TextData,
} from "../../types/CliOutputTypes";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

const USER_EVENT_TYPE = "user";

/** Minimal ILogParser fake — override only what a given test needs to exercise. */
function createParser(overrides: Partial<ILogParser> = {}): ILogParser {
  return {
    extractResponse: () => ({ events: [], metadata: {} }),
    isComplete: () => false,
    watchLogFile: () => ({ close() {} }) as fs.FSWatcher,
    readNewLines: async () => [],
    discoverSessionLog: async () => null,
    extractSessionId: () => null,
    extractStructuredEventsFromEvent: () => [],
    extractContentFromEvent: () => undefined,
    formatStatistics: () => "",
    getFinalEventsOnCompletion: async () => [],
    ...overrides,
  } as ILogParser;
}

/** Minimal INotificationMonitor fake — override only what a given test needs to exercise. */
function createNotificationMonitor(
  overrides: Partial<INotificationMonitor> = {}
): INotificationMonitor {
  return {
    supportsSessionIdInFilename: true,
    supportsSessionStart: true,
    monitorForCompletion: async () => ({ completed: false }),
    buildHookConfig: () => ({ type: "none" }),
    getNotificationDirectory: () => "notify-dir",
    ...overrides,
  } as INotificationMonitor;
}

/** Runs `body` with CliLogMonitor's drain deadline zeroed so drains resolve instantly. */
async function withZeroDrainDeadline(body: () => Promise<void>): Promise<void> {
  const monitorClass = CliLogMonitor as unknown as {
    DRAIN_DEADLINE_MS: number;
  };
  const original = monitorClass.DRAIN_DEADLINE_MS;
  monitorClass.DRAIN_DEADLINE_MS = 0;
  try {
    await body();
  } finally {
    monitorClass.DRAIN_DEADLINE_MS = original;
  }
}

suite("CliLogMonitor", () => {
  test("does not time out an unlimited prompt", async () => {
    const originalTimeoutReader =
      ConfigurationUtils.getMaxPromptExecutionTimeMs;
    ConfigurationUtils.getMaxPromptExecutionTimeMs = () => undefined;
    const monitor = new CliLogMonitor({
      logParser: createParser({
        isComplete: () => true,
        readNewLines: async () => [{ type: "complete" } as BaseCliEvent],
      }),
      runtimeState: {
        getWorkspaceRoot: () => undefined,
        isCancelling: () => false,
      },
      hostCallbacks: {
        onStreamingEvents: () => undefined,
        onResponseComplete: () => undefined,
        logResponse: () => undefined,
      },
    });

    try {
      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.failureKind, undefined);
    } finally {
      ConfigurationUtils.getMaxPromptExecutionTimeMs = originalTimeoutReader;
    }
  });

  test("fails a finite prompt timeout with the TIMEOUT failure kind", async () => {
    await withZeroDrainDeadline(async () => {
      const originalTimeoutReader =
        ConfigurationUtils.getMaxPromptExecutionTimeMs;
      ConfigurationUtils.getMaxPromptExecutionTimeMs = () => 10;
      const monitor = new CliLogMonitor({
        logParser: createParser(),
        runtimeState: {
          getWorkspaceRoot: () => undefined,
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      try {
        const result = await monitor.monitor(
          "session.jsonl",
          null,
          new Date(0),
          "test-model"
        );
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.failureKind, FAILURE_KINDS.TIMEOUT);
        assert.strictEqual(result.timedOut, true);
      } finally {
        ConfigurationUtils.getMaxPromptExecutionTimeMs = originalTimeoutReader;
      }
    });
  });

  test("persists streamed user steers in chronological final output", async () => {
    const rawEvents: BaseCliEvent[] = [
      {
        type: USER_EVENT_TYPE,
        timestamp: "2026-07-19T21:51:50.000Z",
        text: "Also update the tests",
      } as unknown as BaseCliEvent,
      {
        type: "assistant",
        timestamp: "2026-07-19T21:51:51.000Z",
        text: "Done",
      } as unknown as BaseCliEvent,
      {
        type: "complete",
        timestamp: "2026-07-19T21:51:52.000Z",
      } as unknown as BaseCliEvent,
    ];
    let readCount = 0;
    const streamedEvents: CliEvent[] = [];

    const parser = {
      extractResponse: (events: BaseCliEvent[]) => ({
        events: events
          .filter((event) => event.type === "assistant")
          .map((event) => ({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: new Date(event.timestamp as unknown as string).getTime(),
            data: { text: event.text as string } as TextData,
          })),
        metadata: {},
      }),
      isComplete: (event: BaseCliEvent) => event.type === "complete",
      watchLogFile: () => ({ close() {} }) as fs.FSWatcher,
      readNewLines: async () => (readCount++ === 0 ? rawEvents : []),
      discoverSessionLog: async () => null,
      extractSessionId: () => null,
      extractStructuredEventsFromEvent: (event: BaseCliEvent) =>
        event.type === "assistant"
          ? [
              {
                type: CLI_EVENT_TYPES.TEXT,
                timestamp: new Date(
                  event.timestamp as unknown as string
                ).getTime(),
                data: { text: event.text as string } as TextData,
              },
            ]
          : [],
      extractContentFromEvent: () => undefined,
      formatStatistics: () => "",
      getFinalEventsOnCompletion: async () => [],
      classifyUserEvent: (event: BaseCliEvent) =>
        event.type === USER_EVENT_TYPE ? "human-steer" : "other",
      extractUserSteerText: (event: BaseCliEvent) =>
        event.type === USER_EVENT_TYPE ? (event.text as string) : undefined,
      extractTimestamp: (event: BaseCliEvent) =>
        event.timestamp === undefined
          ? null
          : new Date(event.timestamp as unknown as string),
    } as ILogParser;

    const monitorClass = CliLogMonitor as unknown as {
      DRAIN_DEADLINE_MS: number;
    };
    const originalDrainDeadline = monitorClass.DRAIN_DEADLINE_MS;
    monitorClass.DRAIN_DEADLINE_MS = 0;

    try {
      const monitor = new CliLogMonitor({
        logParser: parser,
        runtimeState: {
          getWorkspaceRoot: () => undefined,
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: (events) => streamedEvents.push(...events),
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model",
        "Original dispatched prompt"
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(
        result.parsedOutput?.events.map((event) => event.type),
        [CLI_EVENT_TYPES.USER_STEER, CLI_EVENT_TYPES.TEXT]
      );
      assert.strictEqual(
        (result.parsedOutput?.events[0].data as { text: string }).text,
        "Also update the tests"
      );
      assert.strictEqual(
        streamedEvents.some(
          (event) => event.type === CLI_EVENT_TYPES.USER_STEER
        ),
        true
      );
    } finally {
      monitorClass.DRAIN_DEADLINE_MS = originalDrainDeadline;
    }
  });

  test("resolves unsuccessfully when the user cancels mid-monitor", async () => {
    await withZeroDrainDeadline(async () => {
      let cancelling = false;
      const monitor = new CliLogMonitor({
        logParser: createParser(),
        runtimeState: {
          getWorkspaceRoot: () => undefined,
          isCancelling: () => cancelling,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      setTimeout(() => {
        cancelling = true;
      }, 50);

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.processExited, undefined);
      assert.strictEqual(result.failureKind, undefined);
    });
  });

  test("resolves with a processExit failure kind when the PTY terminates before completion", async () => {
    await withZeroDrainDeadline(async () => {
      let exited: { exitCode: number } | null = null;
      const monitor = new CliLogMonitor({
        logParser: createParser(),
        runtimeState: {
          getWorkspaceRoot: () => undefined,
          isCancelling: () => false,
          isPtyTerminated: () => exited,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      setTimeout(() => {
        exited = { exitCode: 137 };
      }, 50);

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failureKind, FAILURE_KINDS.PROCESS_EXIT);
      assert.strictEqual(result.processExited?.exitCode, 137);
    });
  });

  test("resolves via notification monitor Stop hook when no background work is pending", async () => {
    await withZeroDrainDeadline(async () => {
      const monitor = new CliLogMonitor({
        logParser: createParser({
          extractResponse: () => ({
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                timestamp: 1,
                data: { text: "done" } as TextData,
              },
            ],
            metadata: { sessionId: "sess-1" },
          }),
        }),
        notificationMonitor: createNotificationMonitor({
          monitorForCompletion: async () => ({
            completed: true,
            kind: "completion",
            data: {},
          }),
        }),
        runtimeState: {
          getWorkspaceRoot: () => os.tmpdir(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        getTranscriptText(result.parsedOutput?.events ?? []),
        "done"
      );
      assert.strictEqual(result.sessionId, "sess-1");
    });
  });

  test("resolves as a harnessError failure when the notification monitor reports an error", async () => {
    await withZeroDrainDeadline(async () => {
      const monitor = new CliLogMonitor({
        logParser: createParser(),
        notificationMonitor: createNotificationMonitor({
          monitorForCompletion: async () => ({
            completed: false,
            kind: "error",
            error: "boom",
            data: { sessionId: "sess-err" },
          }),
          extractSessionId: (data) => data?.sessionId,
        }),
        runtimeState: {
          getWorkspaceRoot: () => os.tmpdir(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failureKind, FAILURE_KINDS.HARNESS_ERROR);
      assert.strictEqual(result.failureMessage, "boom");
      assert.strictEqual(result.sessionId, "sess-err");
    });
  });

  // The OpenCode plugin reports a failed prompt submission with the harness's
  // own message; the generic notification error says nothing about the cause.
  test("prefers the message an error notification carries", async () => {
    await withZeroDrainDeadline(async () => {
      const monitor = new CliLogMonitor({
        logParser: createParser(),
        notificationMonitor: createNotificationMonitor({
          monitorForCompletion: async () => ({
            completed: false,
            kind: "error",
            error: "Harness reported an error",
            data: { rawHookData: { message: "could not submit the prompt" } },
          }),
        }),
        runtimeState: {
          getWorkspaceRoot: () => os.tmpdir(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );

      assert.strictEqual(result.failureKind, FAILURE_KINDS.HARNESS_ERROR);
      assert.strictEqual(result.failureMessage, "could not submit the prompt");
    });
  });

  test("holds completion while background work is pending, then finalizes once it clears", async () => {
    await withZeroDrainDeadline(async () => {
      let pendingCheckCount = 0;
      const monitor = new CliLogMonitor({
        logParser: createParser({
          hasPendingBackgroundWork: () => {
            pendingCheckCount++;
            // true for the initial post-Stop check and the hold loop's first
            // re-check; false once the hold loop rechecks again — this walks
            // through the hold's full enter -> loop body -> exit -> finalize path.
            return pendingCheckCount <= 2;
          },
        }),
        notificationMonitor: createNotificationMonitor({
          monitorForCompletion: async () => ({
            completed: true,
            kind: "completion",
            data: {},
          }),
        }),
        runtimeState: {
          getWorkspaceRoot: () => os.tmpdir(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        null,
        new Date(0),
        "test-model"
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(pendingCheckCount, 3);
    });
  });

  test("reports every absorbed Stop as a background-work-hold event that survives into the final output", async () => {
    await withZeroDrainDeadline(async () => {
      const snapshot = {
        pendingTasks: [
          {
            toolName: "Bash",
            description: "Run full real-harness test suite",
            taskId: "b2gz1o2ty",
          },
        ],
        awaitingResumedTurn: false,
      };
      let pendingCheckCount = 0;
      const streamed: CliEvent[] = [];
      const monitor = new CliLogMonitor({
        logParser: createParser({
          // Pending at the first Stop and at a second Stop that arrives
          // during the hold; clear once a third Stop has arrived.
          hasPendingBackgroundWork: () => ++pendingCheckCount <= 3,
          getBackgroundWorkHoldSnapshot: () => snapshot,
        }),
        notificationMonitor: createNotificationMonitor({
          monitorForCompletion: async () => ({
            completed: true,
            kind: "completion",
            data: {},
          }),
        }),
        runtimeState: {
          getWorkspaceRoot: () => os.tmpdir(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: (events) => streamed.push(...events),
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        "sess-hold-row",
        new Date(0),
        "test-model"
      );

      const isHold = (event: CliEvent) =>
        event.type === CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD;
      const streamedHolds = streamed.filter(isHold);
      assert.strictEqual(result.success, true);
      assert.strictEqual(streamedHolds.length, 2);
      for (const hold of streamedHolds) {
        const data = hold.data as BackgroundWorkHoldData;
        assert.deepStrictEqual(data.pendingTasks, snapshot.pendingTasks);
        assert.strictEqual(data.awaitingResumedTurn, false);
        assert.strictEqual(typeof data.heldAt, "number");
      }
      assert.deepStrictEqual(
        result.parsedOutput?.events.filter(isHold),
        streamedHolds
      );
    });
  });

  test("ignores an intermediate Claude Stop until the task-notification resumed turn finishes", async () => {
    await withZeroDrainDeadline(async () => {
      const parser = new ClaudeLogParser();
      const notification =
        "<task-notification><tool-use-id>toolu_background</tool-use-id></task-notification>";
      const batches: BaseCliEvent[][] = [
        [
          {
            type: "assistant",
            timestamp: 1,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "toolu_background",
                  name: "PowerShell",
                  input: { run_in_background: true },
                },
              ],
              stop_reason: "tool_use",
            },
          },
        ],
        [
          {
            type: "assistant",
            timestamp: 2,
            message: { content: [], stop_reason: "end_turn" },
          },
          {
            type: USER_EVENT_TYPE,
            timestamp: 3,
            message: { content: notification },
          },
        ],
        [
          {
            type: "assistant",
            timestamp: 4,
            message: { content: [], stop_reason: "tool_use" },
          },
          {
            type: "assistant",
            timestamp: 5,
            message: {
              content: [{ type: "text", text: "Tests pass." }],
              stop_reason: "end_turn",
            },
          },
        ],
      ];
      let readIndex = 0;
      parser.readNewLines = async () => batches[readIndex++] ?? [];
      parser.watchLogFile = () => ({ close() {} }) as fs.FSWatcher;

      let notificationCallCount = 0;
      const monitor = new CliLogMonitor({
        logParser: parser,
        notificationMonitor: createNotificationMonitor({
          monitorForCompletion: async () => {
            notificationCallCount++;
            return {
              completed: true,
              kind: "completion",
              data: {},
            };
          },
        }),
        runtimeState: {
          getWorkspaceRoot: () => os.tmpdir(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          onStreamingEvents: () => undefined,
          onResponseComplete: () => undefined,
          logResponse: () => undefined,
        },
      });

      const result = await monitor.monitor(
        "session.jsonl",
        "sess-1",
        new Date(0),
        "claude-opus-5"
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(notificationCallCount, 2);
      assert.strictEqual(
        getTranscriptText(result.parsedOutput?.events ?? []),
        "Tests pass."
      );
    });
  });

  test("completes once a mid-turn-consumed Claude notification's turn ends, even when no second Stop ever arrives", async () => {
    // Regression for a real production hang: a background Bash task's
    // <task-notification> can be consumed *mid-turn* (delivered as a
    // `queued_command` attachment while the model is still actively working,
    // not between turns as a `user` message) — see the Claude gotcha in
    // harness-cli-providers.instructions.md. When that happens, the turn that
    // clears `hasPendingBackgroundWork()` is the *same* turn already in
    // progress, so Claude never fires a genuinely new, second Stop hook for
    // it. The old hold loop only re-checked `hasPendingBackgroundWork()`
    // after a fresh Stop-hook file, so it hung until the 10-minute idle
    // backstop even though the still-active log watcher had already observed
    // the closing `end_turn` event. This replays that shape against the real
    // file-tailing ClaudeLogParser (no `readNewLines`/`watchLogFile`
    // overrides), with the hold's own notification wait deliberately
    // rigged to *never* resolve, to prove live log tailing alone is now
    // enough to release the hold.
    await withZeroDrainDeadline(async () => {
      const tempDir = makeTempDir("ctrlyoke-claude-monitor-");
      const logPath = path.join(tempDir, "session.jsonl");

      try {
        const writeLine = (event: Record<string, unknown>) =>
          fs.appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");

        writeLine({
          type: "assistant",
          timestamp: "2026-01-01T00:00:00.000Z",
          sessionId: "sess-mid-turn",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bg",
                name: "Bash",
                input: { run_in_background: true },
              },
            ],
            stop_reason: "tool_use",
          },
        });

        const parser = new ClaudeLogParser();
        let notificationCallCount = 0;
        let resolveFirstStop: (() => void) | undefined;
        const completion = {
          completed: true as const,
          kind: "completion" as const,
          data: {},
        };

        const monitor = new CliLogMonitor({
          logParser: parser,
          notificationMonitor: createNotificationMonitor({
            monitorForCompletion: async () => {
              notificationCallCount++;
              if (notificationCallCount === 1) {
                return await new Promise<typeof completion>((resolve) => {
                  resolveFirstStop = () => resolve(completion);
                });
              }
              // Every later call simulates "no further Stop hook ever
              // arrives" — the exact condition that used to hang the step.
              return await new Promise(() => {});
            },
          }),
          runtimeState: {
            getWorkspaceRoot: () => tempDir,
            isCancelling: () => false,
          },
          hostCallbacks: {
            onStreamingEvents: () => undefined,
            onResponseComplete: () => undefined,
            logResponse: () => undefined,
          },
        });

        const monitorPromise = monitor.monitor(
          logPath,
          "sess-mid-turn",
          new Date(0),
          "claude-opus-5"
        );

        for (let attempt = 0; attempt < 100 && !resolveFirstStop; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(resolveFirstStop, "the first Stop callback was not captured");

        // First (intermediate) Stop: the background task is still genuinely
        // running.
        resolveFirstStop!();

        for (
          let attempt = 0;
          attempt < 100 && notificationCallCount < 2;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.strictEqual(
          notificationCallCount,
          2,
          "expected the hold loop to start waiting on a (never-arriving) second Stop"
        );

        // The task finishes and its notification is consumed mid-turn (a
        // `queued_command` attachment, not a between-turns `user` message),
        // then the model keeps working before the turn genuinely ends —
        // mirroring the real capture exactly. No second Stop-hook file will
        // ever be written for this turn.
        writeLine({
          type: "attachment",
          timestamp: "2026-01-01T00:00:05.000Z",
          attachment: {
            type: "queued_command",
            commandMode: "task-notification",
            prompt:
              "<task-notification>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>",
          },
        });
        writeLine({
          type: "assistant",
          timestamp: "2026-01-01T00:00:06.000Z",
          message: {
            content: [
              { type: "tool_use", id: "toolu_more", name: "Bash", input: {} },
            ],
            stop_reason: "tool_use",
          },
        });
        writeLine({
          type: "user",
          timestamp: "2026-01-01T00:00:06.500Z",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_more", content: "ok" },
            ],
          },
        });
        writeLine({
          type: "assistant",
          timestamp: "2026-01-01T00:00:07.000Z",
          message: {
            content: [{ type: "text", text: "All good." }],
            stop_reason: "end_turn",
          },
        });

        // Give the real fs.watch a moment to deliver the appended lines live,
        // same as the production log watcher does during the hold. Unlike
        // the second Stop-hook wait above, nothing else will ever unblock
        // this — a regression would hang here until the suite's test
        // timeout.
        const result = await monitorPromise;

        assert.strictEqual(result.success, true);
        assert.strictEqual(
          getTranscriptText(result.parsedOutput?.events ?? []),
          "All good."
        );
        assert.ok(
          notificationCallCount >= 2,
          "expected the hold to have started waiting on a further Stop"
        );
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  test("holds on one deadline-free Stop wait across log activity until the pending Claude task reports", async () => {
    // Regression for a real production run: the hold used to commit the step
    // a fixed 10 minutes after it began, however active the session was —
    // a background `npm run test:harness` still running, and in another step
    // the model still mid-turn after consuming both task notifications. Every
    // log event during the hold also re-armed a fresh Stop poller without
    // stopping the old one, so abandoned pollers piled up and could consume
    // a later Stop file nobody was left to read. The hold must keep exactly
    // one open-ended Stop wait while work is pending, and release only once
    // the task's notification arrives and the resumed turn ends.
    await withZeroDrainDeadline(async () => {
      const tempDir = makeTempDir("ctrlyoke-claude-hold-");
      const logPath = path.join(tempDir, "session.jsonl");

      try {
        const writeLine = (event: Record<string, unknown>) =>
          fs.appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");
        const waitFor = async (condition: () => boolean) => {
          for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        };

        writeLine({
          type: "assistant",
          timestamp: "2026-01-01T00:00:00.000Z",
          sessionId: "sess-hold",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bg",
                name: "Bash",
                input: { run_in_background: true },
              },
            ],
            stop_reason: "tool_use",
          },
        });

        const parser = new ClaudeLogParser();
        const holdTimeouts: number[] = [];
        let resolveFirstStop: (() => void) | undefined;
        let processedEventCount = 0;

        const monitor = new CliLogMonitor({
          logParser: parser,
          notificationMonitor: createNotificationMonitor({
            monitorForCompletion: async (config) => {
              if (!resolveFirstStop) {
                return await new Promise((resolve) => {
                  resolveFirstStop = () =>
                    resolve({ completed: true, kind: "completion", data: {} });
                });
              }
              holdTimeouts.push(config.timeoutMs);
              return await new Promise(() => {});
            },
          }),
          runtimeState: {
            getWorkspaceRoot: () => tempDir,
            isCancelling: () => false,
          },
          hostCallbacks: {
            onStreamingEvents: (events) => {
              processedEventCount += events.length;
            },
            onResponseComplete: () => undefined,
            logResponse: () => undefined,
          },
        });

        const monitorPromise = monitor.monitor(
          logPath,
          "sess-hold",
          new Date(0),
          "claude-opus-5"
        );

        await waitFor(() => !!resolveFirstStop);
        assert.ok(resolveFirstStop, "the first Stop callback was not captured");
        resolveFirstStop!();
        await waitFor(() => holdTimeouts.length > 0);

        // Session activity while the task is still running — each line is a
        // separate hold wake that must not open another Stop poller.
        for (let index = 0; index < 3; index++) {
          const before = processedEventCount;
          writeLine({
            type: "assistant",
            timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
            message: {
              content: [{ type: "text", text: `Still waiting ${index}.` }],
              stop_reason: "end_turn",
            },
          });
          await waitFor(() => processedEventCount > before);
        }

        writeLine({
          type: "user",
          timestamp: "2026-01-01T00:00:05.000Z",
          message: {
            content:
              "<task-notification>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>",
          },
        });
        writeLine({
          type: "assistant",
          timestamp: "2026-01-01T00:00:06.000Z",
          message: {
            content: [{ type: "text", text: "Suite passed." }],
            stop_reason: "end_turn",
          },
        });

        const result = await monitorPromise;

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(holdTimeouts, [Number.MAX_SAFE_INTEGER]);
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  test("completes on the second real Copilot Stop with no stale-stop guard, even when the resumed turn closes live between Stops", async () => {
    // Regression for a real production hang: a real capture (two concurrent
    // `powershell mode: async, detach: true` shells) showed an early Stop
    // firing while both shells were still genuinely running, then the
    // notifications, resumed turn_start, and closing turn_end all landing via
    // live log tailing *between* that Stop and the next (final) one — not
    // caught up inside either Stop's own catch-up read. A `staleStopGuardChecks:
    // 2` guard required a third Stop that Copilot never sends once truly done,
    // hanging the step until the 10-minute idle backstop. This replays that
    // shape against the real file-tailing CopilotLogParser (no `readNewLines`/
    // `watchLogFile` overrides) to prove a single confirming Stop now suffices.
    await withZeroDrainDeadline(async () => {
      const tempDir = makeTempDir("ctrlyoke-copilot-monitor-");
      const logPath = path.join(tempDir, "events.jsonl");

      try {
        const writeLine = (event: Record<string, unknown>) =>
          fs.appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");

        writeLine({
          type: "session.start",
          data: { sessionId: "copilot-session" },
        });
        writeLine({
          type: "tool.execution_complete",
          data: {
            toolCallId: "call-0",
            toolTelemetry: { properties: { executionMode: "async" } },
            result: {
              content:
                "<command started in detached background with shellId: 0>",
            },
          },
        });
        writeLine({
          type: "tool.execution_complete",
          data: {
            toolCallId: "call-1",
            toolTelemetry: { properties: { executionMode: "async" } },
            result: {
              content:
                "<command started in detached background with shellId: 1>",
            },
          },
        });

        const parser = new CopilotLogParser();
        let notificationCallCount = 0;
        let resolveFirstStop: (() => void) | undefined;
        let resolveSecondStop: (() => void) | undefined;
        const completion = {
          completed: true as const,
          kind: "completion" as const,
          data: {},
        };

        const monitor = new CliLogMonitor({
          logParser: parser,
          notificationMonitor: createNotificationMonitor({
            monitorForCompletion: async () => {
              notificationCallCount++;
              return await new Promise<typeof completion>((resolve) => {
                if (notificationCallCount === 1) {
                  resolveFirstStop = () => resolve(completion);
                } else {
                  resolveSecondStop = () => resolve(completion);
                }
              });
            },
          }),
          runtimeState: {
            getWorkspaceRoot: () => tempDir,
            isCancelling: () => false,
          },
          hostCallbacks: {
            onStreamingEvents: () => undefined,
            onResponseComplete: () => undefined,
            logResponse: () => undefined,
          },
        });

        const monitorPromise = monitor.monitor(
          logPath,
          "copilot-session",
          new Date(0),
          "gpt-5.4"
        );

        for (let attempt = 0; attempt < 100 && !resolveFirstStop; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(resolveFirstStop, "the first Stop callback was not captured");

        // First Stop: both shells are still genuinely running — not stale.
        resolveFirstStop!();

        for (let attempt = 0; attempt < 100 && !resolveSecondStop; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(
          resolveSecondStop,
          "the hold loop did not wait for a second Stop"
        );

        // Both shells finish and the resumed turn closes entirely via live log
        // tailing, before the second (final) Stop is resolved — mirrors the
        // real capture's timing exactly.
        writeLine({
          type: "system.notification",
          data: {
            kind: {
              type: "shell_detached_completed",
              shellId: "0",
              exitCode: 0,
            },
          },
        });
        writeLine({ type: "assistant.turn_start" });
        writeLine({
          type: "system.notification",
          data: {
            kind: {
              type: "shell_detached_completed",
              shellId: "1",
              exitCode: 0,
            },
          },
        });
        writeLine({
          type: "assistant.message",
          data: { content: "Both background tasks finished." },
        });
        writeLine({ type: "assistant.turn_end" });

        // Give the real fs.watch a moment to deliver the appended lines live,
        // same as the production log watcher does during the hold.
        await new Promise((resolve) => setTimeout(resolve, 50));

        resolveSecondStop!();

        const result = await monitorPromise;

        assert.strictEqual(result.success, true);
        assert.strictEqual(
          notificationCallCount,
          2,
          "a third Stop must not be required once the resumed turn has closed"
        );
        assert.strictEqual(
          getTranscriptText(result.parsedOutput?.events ?? []),
          "Both background tasks finished."
        );
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  test("completes on the first Antigravity Stop once catch-up includes completion and resumed terminal response", async () => {
    // Antigravity runs no stale-stop guard (unlike Copilot above): its transcript
    // watcher settles state independently of Stop-hook timing, so a single Stop
    // whose catch-up read sees both the task-completion notification and the
    // resumed turn's terminal planner response is enough to complete — there is
    // no second, follow-up Stop to wait for. See the Antigravity gotcha in
    // harness-cli-providers.instructions.md.
    await withZeroDrainDeadline(async () => {
      const tempHome = makeTempDir("ctrlyoke-agy-monitor-home-");
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;

      const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const logDir = path.join(tempHome, ".gemini", "antigravity-cli", "log");
      const transcriptDir = path.join(
        tempHome,
        ".gemini",
        "antigravity-cli",
        "brain",
        sessionId,
        ".system_generated",
        "logs"
      );
      const logPath = path.join(logDir, "cli-20260705_120000.log");
      const transcriptPath = path.join(transcriptDir, "transcript_full.jsonl");

      try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        fs.writeFileSync(
          transcriptPath,
          [
            {
              source: "MODEL",
              type: "GENERIC",
              status: "RUNNING",
              content:
                "Tool is running as a background task with task id: session/task-1.",
            },
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "I will wait for the task.",
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
          "utf8"
        );

        const parser = new AntigravityLogParser();
        let notificationCallCount = 0;
        let resolveFirstStop:
          | ((result: {
              completed: true;
              kind: "completion";
              data: Record<string, never>;
            }) => void)
          | undefined;

        const monitor = new CliLogMonitor({
          logParser: parser,
          notificationMonitor: createNotificationMonitor({
            monitorForCompletion: async () => {
              notificationCallCount++;
              return await new Promise<{
                completed: true;
                kind: "completion";
                data: Record<string, never>;
              }>((resolve) => {
                resolveFirstStop = resolve;
              });
            },
          }),
          runtimeState: {
            getWorkspaceRoot: () => tempHome,
            isCancelling: () => false,
          },
          hostCallbacks: {
            onStreamingEvents: () => undefined,
            onResponseComplete: () => undefined,
            logResponse: () => undefined,
          },
        });

        const monitorPromise = monitor.monitor(
          logPath,
          sessionId,
          new Date(0),
          "gemini-3.6-flash-low"
        );

        for (let attempt = 0; attempt < 100 && !resolveFirstStop; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(
          resolveFirstStop,
          "the initial Stop callback was not captured"
        );

        fs.appendFileSync(
          transcriptPath,
          [
            {
              source: "SYSTEM",
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content:
                'Task id "session/task-1" finished with result: completed',
            },
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "The background task finished.",
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
          "utf8"
        );

        resolveFirstStop!({
          completed: true,
          kind: "completion",
          data: {},
        });

        const result = await monitorPromise;

        assert.strictEqual(result.success, true);
        assert.strictEqual(notificationCallCount, 1);
        assert.strictEqual(
          getTranscriptText(result.parsedOutput?.events ?? []),
          "I will wait for the task.\n\nThe background task finished."
        );
      } finally {
        process.env.HOME = previousHome;
        process.env.USERPROFILE = previousUserProfile;
        removeTempDir(tempHome);
      }
    });
  });
});
