import * as assert from "assert";
import { suite, test } from "mocha";
import type { CliEvent, UniversalCliOutput } from "../../types/CliOutputTypes";
import { HeadlessLogTail } from "../../core/harness/shared/HeadlessLogTail";
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
      event.type === "text"
        ? ([
            {
              type: "text" as const,
              data: { text: String(event.text) },
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
    const result = await tail.finish();

    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(result.sessionId, "provider-session");
    assert.strictEqual(
      fake.discoveryArguments[0].sessionId,
      "provider-session"
    );
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
    assert.strictEqual(fake.discoveryArguments[0].sessionId, "thread-from-stdout");
  });
});
