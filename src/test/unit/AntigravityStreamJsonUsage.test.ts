import * as assert from "assert";
import { suite, test } from "mocha";
import {
  AntigravityStreamJsonUsageAccumulator,
  parseStreamJsonLine,
} from "../../core/harness/antigravity/AntigravityStreamJsonUsage";

suite("AntigravityStreamJsonUsage", () => {
  test("parses init and per-step usage from captured stream-json events", () => {
    const init = parseStreamJsonLine(
      '{"event":"init","conversation_id":"73b9d054-1234-5678-9abc-0123456789ab","init":{"model":"gemini-3.6-flash-low","cwd":"C:/workspace","tools":["run_command"],"permission_mode":"default"}}'
    );
    const response = parseStreamJsonLine(
      '{"event":"step_update","step_update":{"conversation_id":"73b9d054-1234-5678-9abc-0123456789ab","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":0.7197045,"usage":{"input_tokens":17831,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":17832}}}'
    );

    assert.strictEqual(
      init?.conversationId,
      "73b9d054-1234-5678-9abc-0123456789ab"
    );
    assert.deepStrictEqual(response, {
      conversationId: "73b9d054-1234-5678-9abc-0123456789ab",
      stepType: "agent_response",
      usage: {
        inputTokens: 17831,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 17832,
      },
    });
  });

  test("retains a split terminal result line and the latest checkpoint usage", () => {
    const accumulator = new AntigravityStreamJsonUsageAccumulator();
    const checkpoint =
      '{"event":"step_update","step_update":{"conversation_id":"73b9d054-1234-5678-9abc-0123456789ab","step_index":4,"state":"DONE","step_type":"checkpoint","usage":{"input_tokens":99,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":102}}}';
    // Captured verbatim from agy 1.1.8: the terminal payload is nested under
    // `result`, not spread across the top level.
    const result =
      '{"event":"result","result":{"conversation_id":"73b9d054-1234-5678-9abc-0123456789ab","status":"SUCCESS","response":"pong","duration_seconds":0.9,"num_turns":1,"usage":{"input_tokens":17930,"output_tokens":1,"thinking_tokens":4,"cache_read_tokens":0,"total_tokens":17935}}}';

    accumulator.ingest(`${checkpoint}\n${result.slice(0, 37)}`);
    assert.deepStrictEqual(accumulator.getLatestStepUsage(), {
      inputTokens: 99,
      outputTokens: 3,
      reasoningOutputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 102,
    });
    assert.strictEqual(accumulator.getTerminalUsage(), undefined);

    accumulator.ingest(`${result.slice(37)}\n`);
    assert.deepStrictEqual(accumulator.getTerminalUsage(), {
      inputTokens: 17930,
      outputTokens: 1,
      reasoningOutputTokens: 4,
      cachedInputTokens: 0,
      totalTokens: 17935,
    });
  });

  test("uses the shared lone-CR boundary across chunks", () => {
    const accumulator = new AntigravityStreamJsonUsageAccumulator();
    const checkpoint =
      '{"event":"step_update","step_update":{"step_type":"checkpoint","usage":{"input_tokens":1}}}';
    const result =
      '{"event":"result","result":{"usage":{"output_tokens":2}}}';

    accumulator.ingest(`${checkpoint}\r`);
    accumulator.ingest(`${result}\n`);

    assert.strictEqual(accumulator.getLatestStepUsage()?.inputTokens, 1);
    assert.strictEqual(accumulator.getTerminalUsage()?.outputTokens, 2);
  });

  test("reads terminal usage from the nested result payload", () => {
    // Regression: the terminal cumulative usage lives at `result.usage`, not
    // at the top level. Reading `event.usage` silently captured nothing.
    const parsed = parseStreamJsonLine(
      '{"event":"result","result":{"conversation_id":"01a4f023-0def-4e24-97d1-3ed2c049cb22","status":"SUCCESS","response":"pong\\n","duration_seconds":1.6169349,"num_turns":1,"usage":{"input_tokens":9780,"output_tokens":4,"thinking_tokens":0,"cache_read_tokens":8140,"total_tokens":9784}}}'
    );

    assert.strictEqual(
      parsed?.conversationId,
      "01a4f023-0def-4e24-97d1-3ed2c049cb22"
    );
    assert.deepStrictEqual(parsed?.usage, {
      inputTokens: 9780,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      cachedInputTokens: 8140,
      totalTokens: 9784,
    });
  });

  test("ignores malformed and non-usage lines", () => {
    const accumulator = new AntigravityStreamJsonUsageAccumulator();

    accumulator.ingest("warning from agy\nnot-json\n");
    accumulator.ingest(
      '{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE"}}\n'
    );

    assert.deepStrictEqual(accumulator.getSnapshot(), {});
  });
});
