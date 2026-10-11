import * as assert from "assert";
import { suite, test } from "mocha";
import type { CliEvent } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import {
  canCoalesceTextEvents,
  coalesceTextEvents,
  formatThinkingLabel,
  isRenderableThinkingBlock,
  mergeThinkingBlocks,
} from "../../utils/ThinkingBlockFormat";

suite("ThinkingBlockFormat", () => {
  suite("formatThinkingLabel", () => {
    test("keeps a plain block's label unchanged", () => {
      assert.strictEqual(
        formatThinkingLabel({ text: "x", label: "Planning" }),
        "Planning"
      );
      assert.strictEqual(formatThinkingLabel({ text: "x" }), "Thinking");
    });

    test("marks redacted reasoning with no summary as encrypted", () => {
      assert.strictEqual(
        formatThinkingLabel({
          text: "",
          label: "Reasoning",
          redacted: true,
          reasoningTokens: 453,
        }),
        "Reasoning · 453 tokens · encrypted"
      );
    });

    test("names a redacted block's text as a summary and shows its parts", () => {
      assert.strictEqual(
        formatThinkingLabel({
          text: "**Checking**",
          label: "Reasoning",
          redacted: true,
          reasoningTokens: 2070,
          segmentCount: 4,
        }),
        "Reasoning summary · 4 parts · 2.1k tokens"
      );
    });

    test("marks an estimated count and uses the singular for one token", () => {
      assert.strictEqual(
        formatThinkingLabel({
          text: "",
          label: "Reasoning",
          redacted: true,
          reasoningTokens: 1,
          reasoningTokensEstimated: true,
        }),
        "Reasoning · ~1 token · encrypted"
      );
    });
  });

  test("isRenderableThinkingBlock keeps redacted blocks without text", () => {
    assert.strictEqual(isRenderableThinkingBlock({ text: "" }), false);
    assert.strictEqual(
      isRenderableThinkingBlock({ text: "", redacted: true }),
      true
    );
  });

  suite("mergeThinkingBlocks", () => {
    test("concatenates plain streamed deltas as-is", () => {
      assert.deepStrictEqual(
        mergeThinkingBlocks(
          { text: "Hel", label: "Thinking" },
          { text: "lo", label: "Thinking" }
        ),
        { text: "Hello", label: "Thinking" }
      );
    });

    test("adds up redacted items as separate paragraphs", () => {
      assert.deepStrictEqual(
        mergeThinkingBlocks(
          { text: "", redacted: true, reasoningTokens: 3 },
          {
            text: "**B**",
            redacted: true,
            reasoningTokens: 4,
            reasoningTokensEstimated: true,
          }
        ),
        {
          text: "**B**",
          redacted: true,
          reasoningTokens: 7,
          reasoningTokensEstimated: true,
          segmentCount: 2,
        }
      );
    });
  });

  suite("text event coalescing", () => {
    const thinking = (data: Record<string, unknown>): CliEvent => ({
      type: CLI_EVENT_TYPES.THINKING,
      data: { text: "", ...data },
    });

    test("never joins redacted reasoning to plain thinking of the same label", () => {
      assert.strictEqual(
        canCoalesceTextEvents(
          thinking({ label: "Reasoning", redacted: true }),
          thinking({ label: "Reasoning" })
        ),
        false
      );
    });

    test("joins text deltas and different event types never coalesce", () => {
      const a: CliEvent = { type: CLI_EVENT_TYPES.TEXT, data: { text: "a" } };
      const b: CliEvent = { type: CLI_EVENT_TYPES.TEXT, data: { text: "b" } };
      assert.strictEqual(canCoalesceTextEvents(a, b), true);
      assert.deepStrictEqual(coalesceTextEvents(a, b).data, { text: "ab" });
      assert.strictEqual(
        canCoalesceTextEvents(a, thinking({ text: "b" })),
        false
      );
      assert.strictEqual(canCoalesceTextEvents(undefined, a), false);
    });
  });
});
