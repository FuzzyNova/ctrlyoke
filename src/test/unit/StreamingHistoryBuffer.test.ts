import * as assert from "assert";
import { suite, test } from "mocha";
import {
  StreamingHistoryBuffer,
  type StreamingHistoryFlush,
} from "../../core/orchestration/StreamingHistoryBuffer";
import {
  CLI_EVENT_TYPES,
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/CliOutputTypes";

const HISTORY_FILE = "manifest.json";
const TARGET = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

function createBuffer(options?: {
  maxBufferedChars?: number;
  maxBufferedAgeMs?: number;
}) {
  const writes: StreamingHistoryFlush[] = [];
  const buffer = new StreamingHistoryBuffer(async (_filePath, flush) => {
    writes.push(flush);
  }, options);
  return { buffer, writes };
}

function textEvent(text: string): CliEvent {
  return { type: CLI_EVENT_TYPES.TEXT, timestamp: 1, data: { text } };
}

suite("StreamingHistoryBuffer", () => {
  test("merges token-level text deltas into a single write", async () => {
    const { buffer, writes } = createBuffer();

    // Mirrors the headless path: one TEXT event per provider token delta.
    for (const token of ["Hel", "lo ", "wor", "ld"]) {
      await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent(token)]);
    }
    assert.strictEqual(writes.length, 0, "text deltas should stay buffered");

    await buffer.flush();

    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0].events, [textEvent("Hello world")]);
  });

  test("writes immediately when a non-text boundary event arrives", async () => {
    const { buffer, writes } = createBuffer();
    const toolCall: CliEvent = {
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp: 2,
      data: { command: "ls" },
    };

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("running ")]);
    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [toolCall]);

    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0].events, [textEvent("running "), toolCall]);
  });

  test("does not merge thinking into text or across differing labels", async () => {
    const { buffer, writes } = createBuffer();
    const thinking = (text: string, label: string): CliEvent => ({
      type: CLI_EVENT_TYPES.THINKING,
      timestamp: 3,
      data: { text, label },
    });

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [
      textEvent("a"),
      thinking("b", "Reasoning"),
      thinking("c", "Reasoning"),
      thinking("d", "Planning"),
    ]);
    await buffer.flush();

    assert.deepStrictEqual(writes[0].events, [
      textEvent("a"),
      thinking("bc", "Reasoning"),
      thinking("d", "Planning"),
    ]);
  });

  test("caps buffered text so a crash loses a bounded amount", async () => {
    const { buffer, writes } = createBuffer({ maxBufferedChars: 8 });

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("12345")]);
    assert.strictEqual(writes.length, 0);
    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("678")]);

    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0].events, [textEvent("12345678")]);
  });

  test("writes on the age cap without any further deltas", async () => {
    const { buffer, writes } = createBuffer({ maxBufferedAgeMs: 10 });

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("slow")]);
    assert.strictEqual(writes.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0].events, [textEvent("slow")]);
  });

  test("coalesces raw chunks and keeps them separate from events", async () => {
    const { buffer, writes } = createBuffer();

    await buffer.addChunk(HISTORY_FILE, TARGET, 0, 0, "raw ");
    await buffer.addChunk(HISTORY_FILE, TARGET, 0, 0, "text");
    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("parsed")]);
    await buffer.flush();

    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].chunk, "raw text");
    assert.deepStrictEqual(writes[0].events, [textEvent("parsed")]);
  });

  test("keeps separate attempts and targets in separate batches", async () => {
    const { buffer, writes } = createBuffer();
    const otherTarget = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 1,
    } as const;

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("step0")]);
    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 1, [textEvent("retry")]);
    await buffer.addEvents(HISTORY_FILE, otherTarget, 0, 0, [
      textEvent("step1"),
    ]);
    await buffer.flush();

    assert.strictEqual(writes.length, 3);
    assert.deepStrictEqual(
      writes.map((write) => write.attemptIndex),
      [0, 1, 0]
    );
    assert.deepStrictEqual(
      writes.map((write) => (write.events?.[0].data as { text: string }).text),
      ["step0", "retry", "step1"]
    );
  });

  test("keeps execution phases in separate batches", async () => {
    const { buffer, writes } = createBuffer();

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("prompt")]);
    await buffer.addEvents(
      HISTORY_FILE,
      TARGET,
      0,
      0,
      [textEvent("condition")],
      EXECUTION_PHASES.END_CONDITION
    );
    await buffer.flush();

    assert.strictEqual(writes.length, 2);
    assert.deepStrictEqual(
      writes.map((write) => write.phase),
      [undefined, EXECUTION_PHASES.END_CONDITION]
    );
  });

  test("flush(historyFilePath) leaves other runs buffered", async () => {
    const { buffer, writes } = createBuffer();

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("mine")]);
    await buffer.addEvents("other.json", TARGET, 0, 0, [textEvent("theirs")]);

    await buffer.flush(HISTORY_FILE);
    assert.strictEqual(writes.length, 1);

    await buffer.flush();
    assert.strictEqual(writes.length, 2);
  });

  test("flush waits for an in-flight write and its publish", async () => {
    // An age-cap flush that has already taken the entry out of `pending` is
    // still writing when the attempt completes. flush() must not resolve until
    // that batch is published, or the completed output overtakes the streamed
    // tail and the dashboard draws a spurious follow-up divider.
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const published: StreamingHistoryFlush[] = [];
    const buffer = new StreamingHistoryBuffer(
      async () => {
        await writeGate;
        return { sequences: [7] };
      },
      { maxBufferedAgeMs: 5 },
      (flush) => published.push(flush)
    );

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("tail")]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    let flushed = false;
    const flushPromise = buffer.flush(HISTORY_FILE).then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(flushed, false, "flush resolved before the write");

    releaseWrite();
    await flushPromise;
    assert.strictEqual(published.length, 1);
    assert.deepStrictEqual(published[0].events, [textEvent("tail")]);
  });

  test("flush is a no-op once buffers are drained", async () => {
    const { buffer, writes } = createBuffer();

    await buffer.addEvents(HISTORY_FILE, TARGET, 0, 0, [textEvent("once")]);
    await buffer.flush();
    await buffer.flush();

    assert.strictEqual(writes.length, 1);
  });
});
