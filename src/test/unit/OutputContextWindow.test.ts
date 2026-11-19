import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getOutputContextWindow,
  hasRecordedContextWindow,
  withFollowUpContextWindow,
} from "../../utils/OutputContextWindow";
import { formatContextWindowUsage } from "../../utils/TokenFormatting";
import type { CliOutput } from "../../types/WebviewMessageTypes";

suite("OutputContextWindow", () => {
  const recorded: CliOutput = {
    elapsed: 1,
    isStreaming: false,
    tokens: {
      prompt: 10,
      completion: 5,
      contextWindowUsed: 1000,
      contextWindowSize: 200000,
    },
  };

  test("reads the context window from recorded usage", () => {
    assert.deepStrictEqual(getOutputContextWindow(recorded), {
      used: 1000,
      size: 200000,
    });
    assert.strictEqual(hasRecordedContextWindow(recorded), true);
  });

  test("prefers a follow-up's reading over the recorded one", () => {
    const output = withFollowUpContextWindow(recorded, {
      used: 4000,
      size: 200000,
    });
    assert.deepStrictEqual(getOutputContextWindow(output), {
      used: 4000,
      size: 200000,
    });
    assert.deepStrictEqual(output.tokens, recorded.tokens);
  });

  test("gives an attempt with no usage a context window without inventing tokens", () => {
    const bare: CliOutput = { elapsed: 14.4, isStreaming: false };
    const output = withFollowUpContextWindow(bare, {
      used: 26527,
      size: 1000000,
    });
    assert.deepStrictEqual(getOutputContextWindow(output), {
      used: 26527,
      size: 1000000,
    });
    assert.strictEqual(output.tokens, undefined);
    assert.strictEqual(hasRecordedContextWindow(output), false);
  });

  test("ignores a missing or sizeless reading", () => {
    assert.strictEqual(
      withFollowUpContextWindow(recorded, undefined),
      recorded
    );
    assert.strictEqual(
      withFollowUpContextWindow(recorded, { used: 5, size: 0 }),
      recorded
    );
    assert.strictEqual(getOutputContextWindow(undefined), undefined);
    assert.strictEqual(getOutputContextWindow(null), undefined);
  });

  test("formats usage as used/size with a percentage", () => {
    assert.strictEqual(
      formatContextWindowUsage({ used: 26527, size: 1000000 }),
      "26.5k/1M (3%)"
    );
    assert.strictEqual(formatContextWindowUsage(undefined), undefined);
    assert.strictEqual(
      formatContextWindowUsage({ used: 1, size: 0 }),
      undefined
    );
  });
});
