import * as assert from "assert";
import type * as fs from "fs";
import { suite, test } from "mocha";
import { CliLogMonitor } from "../../core/harness/CliLogMonitor";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import type { CliEvent, TextData } from "../../types/CliOutputTypes";

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
});
