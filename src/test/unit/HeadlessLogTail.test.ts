import * as assert from "assert";
import { suite, test } from "mocha";
import type { CliEvent, UniversalCliOutput } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { HeadlessLogTail } from "../../core/harness/shared/HeadlessLogTail";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";

function createParser(options?: {
  discoveries?: Array<string | null>;
  reads?: BaseCliEvent[][];
  extractedSessionId?: string;
}) {
  const discoveries = [...(options?.discoveries ?? ["session.log"])].reverse();
  const reads = [...(options?.reads ?? [[]])].reverse();
  const discoveryArguments: Array<{
    prompt: string;
    start: Date;
    sessionId?: string;
  }> = [];
  let readCount = 0;
  const parser = {
    discoverSessionLog: async (
      prompt: string,
      start: Date,
      sessionId?: string
    ) => {
      discoveryArguments.push({ prompt, start, sessionId });
      return discoveries.pop() ?? null;
    },
    readNewLines: async () => {
      readCount += 1;
      return reads.pop() ?? [];
    },
    extractTimestamp: () => null,
    extractSessionId: () => options?.extractedSessionId ?? null,
    extractStructuredEventsFromEvent: (event: BaseCliEvent) =>
      event.type === CLI_EVENT_TYPES.TEXT
        ? ([
            {
              type: "text" as const,
              data: { text: String(event.text) },
            },
          ] as CliEvent[])
        : event.type === "file_change"
          ? ([
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/live.ts",
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-before", "+after"],
                    },
                  ],
                },
              },
            ] as CliEvent[])
          : [],
    extractResponse: (events: BaseCliEvent[]) =>
      ({
        events: [],
        metadata: { eventCount: events.length },
      }) as UniversalCliOutput,
    isComplete: () => false,
    extractContentFromEvent: () => undefined,
    formatStatistics: () => "",
  } as unknown as ILogParser;

  return { parser, discoveryArguments, getReadCount: () => readCount };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("HeadlessLogTail", () => {
  test("reads the log on each stdout tick and streams parsed events", async () => {
    const event = { type: "text", text: "from log" };
    const fake = createParser({ reads: [[], [event]] });
    const streamed: CliEvent[] = [];
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      onStreamingEvents: (events) => streamed.push(...events),
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    tail.onStdoutChunk("stdout tick");
    const result = await tail.finish();

    assert.deepStrictEqual(result.events, [event]);
    assert.deepStrictEqual(streamed, [
      { type: "text", data: { text: "from log" } },
    ]);
    assert.strictEqual(fake.getReadCount() >= 2, true);
  });

  test("delivers log-sourced file diffs before headless completion", async () => {
    const logSourcedProviders = [
      new CodexCliProvider(),
      new AntigravityCliProvider(),
      new QwenCliProvider(),
    ];

    for (const provider of logSourcedProviders) {
      assert.strictEqual(provider.headlessSource, "log");

      const fake = createParser({
        reads: [[{ type: "file_change" }]],
      });
      let runCompleted = false;
      let streamedBeforeCompletion = false;
      const tail = new HeadlessLogTail({
        parser: fake.parser,
        promptText: "prompt",
        startTime: new Date(),
        onStreamingEvents: (events) => {
          assert.strictEqual(runCompleted, false);
          assert.deepStrictEqual(
            events.map((event) => event.type),
            [CLI_EVENT_TYPES.FILE_EDIT]
          );
          streamedBeforeCompletion = true;
        },
        idlePollIntervalMs: 1000,
        drainDeadlineMs: 2,
        drainPollIntervalMs: 1,
      });

      await tail.start();
      tail.onStdoutChunk("stdout clock tick");
      await waitFor(5);

      // Asserted before finish() so a regression that defers diffs to the
      // post-exit drain fails here. Streaming the diff mid-run is the entire
      // payoff of log-sourcing.
      assert.strictEqual(
        streamedBeforeCompletion,
        true,
        `${provider.config.displayName} should stream its file diff before completion`
      );

      await tail.finish();
      runCompleted = true;
    }
  });

  test("uses the idle backstop when stdout goes quiet", async () => {
    const event = { type: "text", text: "during tool call" };
    const fake = createParser({ reads: [[], [event]] });
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      onStreamingEvents: () => {},
      idlePollIntervalMs: 2,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    await waitFor(8);
    const result = await tail.finish();

    assert.deepStrictEqual(result.events, [event]);
  });

  test("retries discovery and performs a post-exit fallback read", async () => {
    const event = { type: "text", text: "after exit" };
    const fake = createParser({
      discoveries: [null, "session.log"],
      reads: [[event]],
    });
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    // The in-flight tick misses (the log does not exist yet); the post-exit
    // retry is what recovers the events.
    tail.onStdoutChunk("stdout tick");
    const result = await tail.finish();

    assert.deepStrictEqual(result.events, [event]);
    assert.strictEqual(fake.discoveryArguments.length >= 2, true);
  });

  test("supports provider-owned session-ID discovery without stdout markers", async () => {
    const fake = createParser({ discoveries: ["session.log"] });
    const startTime = new Date();
    let providerCalls = 0;
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime,
      workspaceRoot: "workspace",
      extractSessionIdFromLogs: async (prompt, start, workspace) => {
        providerCalls += 1;
        assert.strictEqual(prompt, "prompt");
        assert.strictEqual(start, startTime);
        assert.strictEqual(workspace, "workspace");
        return "provider-session";
      },
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    tail.onStdoutChunk("activity\n");
    const result = await tail.finish();

    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(result.sessionId, "provider-session");
    assert.strictEqual(
      fake.discoveryArguments[0].sessionId,
      "provider-session"
    );
  });

  test("does not resolve a provider session ID before the process spawns", async () => {
    // Antigravity resolves its ID from a workspace-keyed cache with no
    // timestamp, so a pre-spawn lookup can only ever see the *previous* run and
    // would latch that stale session for this run's entire duration.
    const fake = createParser({ discoveries: ["session.log"] });
    let providerCalls = 0;
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      workspaceRoot: "workspace",
      extractSessionIdFromLogs: async () => {
        providerCalls += 1;
        return providerCalls === 1 ? "fresh-session" : "unexpected";
      },
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();

    assert.strictEqual(
      providerCalls,
      0,
      "start() must not perform a session lookup before spawn"
    );
    assert.strictEqual(fake.discoveryArguments.length, 0);

    tail.onStdoutChunk("first activity\n");
    const result = await tail.finish();

    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(result.sessionId, "fresh-session");
  });

  test("still performs an initial read when the session ID is already known", async () => {
    const fake = createParser({ discoveries: ["session.log"] });
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      resolvedSessionId: "resumed-session",
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    await waitFor(1);

    assert.strictEqual(fake.discoveryArguments.length, 1);
    assert.strictEqual(fake.discoveryArguments[0].sessionId, "resumed-session");
    await tail.finish();
  });

  test("does not block the spawn on a resumed session's initial read", async () => {
    // A resumed session's log can only be touched once the harness relaunches,
    // and Codex's discovery helper insists the file be newer than startTime —
    // so awaiting the initial read polls out the parser's whole retry budget
    // (~3 minutes observed) while the caller waits to spawn the very process
    // that would satisfy it. This test hangs rather than fails on regression:
    // discovery never resolves until the assertions have run.
    let discoveryStarted = false;
    let releaseDiscovery: () => void = () => {};
    const blockedDiscovery = new Promise<string>((resolve) => {
      releaseDiscovery = () => resolve("session.log");
    });
    const parser = {
      discoverSessionLog: () => {
        discoveryStarted = true;
        return blockedDiscovery;
      },
      readNewLines: async () => [],
      extractTimestamp: () => null,
      extractSessionId: () => null,
      extractStructuredEventsFromEvent: () => [],
    } as unknown as ILogParser;

    const tail = new HeadlessLogTail({
      parser,
      promptText: "prompt",
      startTime: new Date(),
      resolvedSessionId: "resumed-session",
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    await waitFor(1);

    assert.strictEqual(
      discoveryStarted,
      true,
      "the initial read should still be queued, just not awaited"
    );

    releaseDiscovery();
    await tail.finish();
  });

  test("aborts session-log discovery when the run is abandoned", async () => {
    // Regression: a stopped run's discovery kept retrying for two minutes past
    // the workflow instance that owned it, and the process it was waiting for
    // then launched with no owner — editing the workspace alongside the next
    // run and delivering its completion to whatever instance was live.
    const signals: Array<AbortSignal | undefined> = [];
    const parser = {
      discoverSessionLog: (
        _prompt: string,
        _start: Date,
        _sessionId?: string,
        signal?: AbortSignal
      ) =>
        new Promise<string | null>((resolve) => {
          signals.push(signal);
          signal?.addEventListener("abort", () => resolve(null), {
            once: true,
          });
        }),
      readNewLines: async () => [],
      extractTimestamp: () => null,
      extractSessionId: () => null,
      extractStructuredEventsFromEvent: () => [],
    } as unknown as ILogParser;

    const tail = new HeadlessLogTail({
      parser,
      promptText: "prompt",
      startTime: new Date(),
      resolvedSessionId: "resumed-session",
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    await waitFor(1);
    assert.strictEqual(signals.length, 1);
    assert.strictEqual(signals[0]?.aborted, false);

    tail.abort();
    assert.strictEqual(signals[0]?.aborted, true);

    // finish() must not re-open discovery for an abandoned run, or the abort
    // buys nothing: the post-exit read would start a fresh retry budget.
    const result = await tail.finish();
    assert.strictEqual(signals.length, 1);
    assert.strictEqual(result.logPath, undefined);
  });

  test("gives the post-exit read a fresh budget on a normal exit", async () => {
    const event = { type: "text", text: "after exit" };
    const fake = createParser({
      discoveries: [null, "session.log"],
      reads: [[event]],
    });
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      resolvedSessionId: "resumed-session",
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    await waitFor(1);
    const result = await tail.finish();

    assert.deepStrictEqual(result.events, [event]);
    assert.strictEqual(result.logPath, "session.log");
  });

  test("does not block process startup while waiting for a stdout session ID", async () => {
    const fake = createParser({ discoveries: ["session.log"] });
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      extractSessionIdFromStdout: () => "thread-from-stdout",
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();

    assert.strictEqual(fake.discoveryArguments.length, 0);
    tail.onStdoutChunk(
      '{"type":"thread.started","thread_id":"thread-from-stdout"}\n'
    );
    await tail.finish();
    assert.strictEqual(
      fake.discoveryArguments[0].sessionId,
      "thread-from-stdout"
    );
  });

  test("observes every stdout chunk after the session ID is known", async () => {
    const fake = createParser({ discoveries: ["session.log"] });
    const observed: string[] = [];
    const tail = new HeadlessLogTail({
      parser: fake.parser,
      promptText: "prompt",
      startTime: new Date(),
      extractSessionIdFromStdout: () => "thread-from-stdout",
      onStdoutChunkObserved: (chunk) => observed.push(chunk),
      onStreamingEvents: () => {},
      idlePollIntervalMs: 1000,
      drainDeadlineMs: 2,
      drainPollIntervalMs: 1,
    });

    await tail.start();
    tail.onStdoutChunk("init event");
    tail.onStdoutChunk("terminal result event");
    await tail.finish();

    assert.deepStrictEqual(observed, ["init event", "terminal result event"]);
  });
});
