import * as assert from "assert";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CliLogMonitor } from "../../core/harness/CliLogMonitor";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";
import type { INotificationMonitor } from "../../core/harness/shared/interfaces/INotificationMonitor";
import { ClaudeLogParser } from "../../core/harness/claude/ClaudeLogParser";
import { CopilotLogParser } from "../../core/harness/copilot/CopilotLogParser";
import { AntigravityLogParser } from "../../core/harness/antigravity/AntigravityLogParser";
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
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ctrlyoke-copilot-monitor-")
      );
      const logPath = path.join(tempDir, "events.jsonl");

      try {
        const writeLine = (event: Record<string, unknown>) =>
          fs.appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");

        writeLine({ type: "session.start", data: { sessionId: "copilot-session" } });
        writeLine({
          type: "tool.execution_complete",
          data: {
            toolCallId: "call-0",
            toolTelemetry: { properties: { executionMode: "async" } },
            result: {
              content: "<command started in detached background with shellId: 0>",
            },
          },
        });
        writeLine({
          type: "tool.execution_complete",
          data: {
            toolCallId: "call-1",
            toolTelemetry: { properties: { executionMode: "async" } },
            result: {
              content: "<command started in detached background with shellId: 1>",
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
            kind: { type: "shell_detached_completed", shellId: "0", exitCode: 0 },
          },
        });
        writeLine({ type: "assistant.turn_start" });
        writeLine({
          type: "system.notification",
          data: {
            kind: { type: "shell_detached_completed", shellId: "1", exitCode: 0 },
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
          result.cliResult?.response,
          "Both background tasks finished."
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
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
      const tempHome = fs.mkdtempSync(
        path.join(os.tmpdir(), "ctrlyoke-agy-monitor-home-")
      );
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
          result.cliResult?.response,
          "I will wait for the task.The background task finished."
        );
      } finally {
        process.env.HOME = previousHome;
        process.env.USERPROFILE = previousUserProfile;
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    });
  });
});
