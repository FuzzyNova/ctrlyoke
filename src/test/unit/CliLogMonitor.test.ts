import * as assert from "assert";
import * as os from "os";
import type * as fs from "fs";
import { suite, test } from "mocha";
import { CliLogMonitor } from "../../core/harness/CliLogMonitor";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";
import type { INotificationMonitor } from "../../core/harness/shared/interfaces/INotificationMonitor";
import { ClaudeLogParser } from "../../core/harness/claude/ClaudeLogParser";
import { CopilotLogParser } from "../../core/harness/copilot/CopilotLogParser";
import { CLI_EVENT_TYPES, FAILURE_KINDS } from "../../types/DashboardConstants";
import type { CliEvent, TextData } from "../../types/CliOutputTypes";

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
  test("persists streamed user steers in chronological final output", async () => {
    const rawEvents: BaseCliEvent[] = [
      {
        type: "user",
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
        event.type === "user" ? "human-steer" : "other",
      extractUserSteerText: (event: BaseCliEvent) =>
        event.type === "user" ? (event.text as string) : undefined,
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
      assert.strictEqual(result.cliResult?.response, "done");
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
            type: "user",
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
      assert.strictEqual(result.cliResult?.response, "Tests pass.");
    });
  });

  test("ignores a stale Copilot Stop when catch-up includes shell completion and resumed turn", async () => {
    await withZeroDrainDeadline(async () => {
      const parser = new CopilotLogParser();
      const batches: BaseCliEvent[][] = [
        [
          {
            type: "tool.execution_complete",
            data: {
              toolTelemetry: { properties: { executionMode: "async" } },
              result: {
                content: "<command started in background with shellId: 0>",
              },
            },
          },
        ],
        [
          {
            type: "system.notification",
            data: { kind: { type: "shell_completed", shellId: 0, exitCode: 0 } },
          },
          { type: "assistant.turn_start" },
          {
            type: "assistant.message",
            data: { content: "The background command finished." },
          },
          { type: "assistant.turn_end" },
        ],
        [],
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
            return { completed: true, kind: "completion", data: {} };
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
        "events.jsonl",
        "copilot-session",
        new Date(0),
        "gpt-5.4"
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(notificationCallCount, 2);
      assert.strictEqual(result.cliResult?.response, "The background command finished.");
    });
  });
});
