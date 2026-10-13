import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  SCRIPT_OUTPUT_SOURCES,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/CliOutputTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import { StreamingCliOutputAccumulator } from "../../utils/StreamingCliOutputAccumulator";

const KEY = "queue:0:run:0:attempt:0";

function streamingOutput(response = ""): CliOutput {
  return {
    elapsed: 0,
    isStreaming: true,
    source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
    scriptOutput: { command: "npm test", stdout: response, stderr: "" },
  };
}

function textEvent(text: string): CliEvent {
  return { type: CLI_EVENT_TYPES.TEXT, data: { text } } as CliEvent;
}

suite("StreamingCliOutputAccumulator", () => {
  test("returns the output untouched when nothing is buffered", () => {
    const accumulator = new StreamingCliOutputAccumulator();
    const output = streamingOutput("existing");
    assert.strictEqual(accumulator.flush(KEY, output), output);
  });

  test("appends buffered chunks in arrival order", () => {
    const accumulator = new StreamingCliOutputAccumulator();
    accumulator.appendChunk(KEY, "one ");
    accumulator.appendChunk(KEY, "two");

    const merged = accumulator.flush(KEY, streamingOutput("start "));
    assert.strictEqual(merged.scriptOutput?.stdout, "start one two");
    assert.strictEqual(merged.structured, undefined);
  });

  test("normalizes buffered events against the output's existing events", () => {
    const accumulator = new StreamingCliOutputAccumulator();
    accumulator.appendEvents(KEY, [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: { command: "npm test", status: OPERATION_STATUS.INITIATED },
      } as CliEvent,
    ]);
    accumulator.appendEvents(KEY, [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm test",
          status: OPERATION_STATUS.COMPLETED,
          exitCode: 0,
          output: "ok",
        },
      } as CliEvent,
    ]);

    const merged = accumulator.flush(KEY, {
      ...streamingOutput(),
      structured: { events: [textEvent("intro")], metadata: { model: "opus" } },
    });

    // The initiated/completed pair collapses into one event, so batching the
    // deltas must not change the projection a per-batch merge produced.
    assert.deepStrictEqual(
      merged.structured?.events.map((event) => event.type),
      [CLI_EVENT_TYPES.TEXT, CLI_EVENT_TYPES.BASH_COMMAND]
    );
    assert.deepStrictEqual(merged.structured?.metadata, { model: "opus" });
  });

  test("flush consumes the buffer so a second flush is a no-op", () => {
    const accumulator = new StreamingCliOutputAccumulator();
    accumulator.appendChunk(KEY, "once");

    const first = accumulator.flush(KEY, streamingOutput());
    assert.strictEqual(first.scriptOutput?.stdout, "once");
    assert.strictEqual(accumulator.flush(KEY, first), first);
  });

  test("discard drops everything buffered for that key only", () => {
    const accumulator = new StreamingCliOutputAccumulator();
    const other = "queue:1:run:0:attempt:0";
    accumulator.appendChunk(KEY, "stale");
    accumulator.appendChunk(other, "kept");
    accumulator.discard(KEY);

    assert.deepStrictEqual([...accumulator.keys()], [other]);
    assert.strictEqual(accumulator.flush(KEY, streamingOutput()).scriptOutput?.stdout, "");
    assert.strictEqual(
      accumulator.flush(other, streamingOutput()).scriptOutput?.stdout,
      "kept"
    );
  });
});
