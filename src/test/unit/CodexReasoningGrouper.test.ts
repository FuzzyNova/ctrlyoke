import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildCodexReasoningBlock,
  CodexReasoningGrouper,
} from "../../core/harness/codex/CodexReasoningGrouper";
import type { CliEvent, ThinkingBlock } from "../../types/CliOutputTypes";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

/** A raw reasoning item plus the THINKING event the parser maps it to. */
function reasoning(
  summary: string,
  encryptedLength = 2000
): [BaseCliEvent, CliEvent[]] {
  const payload = {
    type: "reasoning",
    summary: summary ? [{ type: "summary_text", text: summary }] : [],
    encrypted_content: "x".repeat(encryptedLength),
  };
  return [
    { type: "response_item", payload },
    [
      {
        type: CLI_EVENT_TYPES.THINKING,
        data: buildCodexReasoningBlock(payload)!,
      },
    ],
  ];
}

function text(value: string): [BaseCliEvent, CliEvent[]] {
  return [
    {
      type: "response_item",
      payload: { type: "message", role: "assistant" },
    },
    [{ type: CLI_EVENT_TYPES.TEXT, data: { text: value } }],
  ];
}

function toolCall(): [BaseCliEvent, CliEvent[]] {
  return [
    { type: "response_item", payload: { type: "custom_tool_call" } },
    [{ type: CLI_EVENT_TYPES.BASH_COMMAND, data: { command: "ls" } }],
  ];
}

function toolOutput(): [BaseCliEvent, CliEvent[]] {
  return [
    { type: "response_item", payload: { type: "custom_tool_call_output" } },
    [],
  ];
}

function usageRecord(reasoningTokens: number): [BaseCliEvent, CliEvent[]] {
  return [
    {
      type: "token_usage_record",
      payload: { usage: { reasoning_output_tokens: reasoningTokens } },
    },
    [],
  ];
}

function feed(
  grouper: CodexReasoningGrouper,
  steps: Array<[BaseCliEvent, CliEvent[]]>
): CliEvent[][] {
  return steps.map(([raw, mapped]) => grouper.accept(raw, mapped));
}

const thinkingData = (events: CliEvent[]) =>
  events
    .filter((event) => event.type === CLI_EVENT_TYPES.THINKING)
    .map((event) => event.data as ThinkingBlock);

suite("CodexReasoningGrouper", () => {
  suite("buildCodexReasoningBlock", () => {
    test("shows raw reasoning content when a model provides it", () => {
      assert.deepStrictEqual(
        buildCodexReasoningBlock({
          content: [{ type: "reasoning_text", text: "step one" }],
          encrypted_content: "abc",
        }),
        { text: "step one", label: "Reasoning" }
      );
    });

    test("marks encrypted reasoning as redacted and keeps its summary", () => {
      assert.deepStrictEqual(
        buildCodexReasoningBlock({
          summary: [
            { type: "summary_text", text: "**A**" },
            { type: "summary_text", text: "**B**" },
          ],
          encrypted_content: "abc",
        }),
        { text: "**A**\n\n**B**", label: "Reasoning", redacted: true }
      );
      assert.deepStrictEqual(
        buildCodexReasoningBlock({ summary: [], encrypted_content: "abc" }),
        { text: "", label: "Reasoning", redacted: true }
      );
    });

    test("returns null for an empty item", () => {
      assert.strictEqual(buildCodexReasoningBlock({ summary: [] }), null);
    });
  });

  test("holds a response until its usage record, then releases it in order with the count", () => {
    const grouper = new CodexReasoningGrouper();
    const released = feed(grouper, [
      reasoning("**Planning**"),
      text("I'll look."),
      toolCall(),
      usageRecord(453),
    ]);

    assert.deepStrictEqual(
      released.map((batch) => batch.length),
      [0, 0, 0, 3],
      "nothing is emitted before the usage record"
    );
    assert.deepStrictEqual(
      released[3].map((event) => event.type),
      [
        CLI_EVENT_TYPES.THINKING,
        CLI_EVENT_TYPES.TEXT,
        CLI_EVENT_TYPES.BASH_COMMAND,
      ]
    );
    assert.strictEqual(thinkingData(released[3])[0].reasoningTokens, 453);
    assert.strictEqual(
      thinkingData(released[3])[0].reasoningTokensEstimated,
      undefined
    );
  });

  test("passes events through untouched when no reasoning is held", () => {
    const grouper = new CodexReasoningGrouper();
    const [raw, mapped] = text("hello");
    assert.deepStrictEqual(grouper.accept(raw, mapped), mapped);
  });

  test("folds consecutive reasoning items of one response into one block", () => {
    const grouper = new CodexReasoningGrouper();
    const released = feed(grouper, [
      reasoning("**One**"),
      reasoning(""),
      reasoning("**Three**"),
      toolCall(),
      usageRecord(631),
    ]).flat();

    assert.deepStrictEqual(thinkingData(released), [
      {
        text: "**One**\n\n**Three**",
        label: "Reasoning",
        redacted: true,
        reasoningTokens: 631,
        segmentCount: 3,
      },
    ]);
  });

  test("splits a response total between reasoning blocks a message separates", () => {
    const grouper = new CodexReasoningGrouper();
    const released = feed(grouper, [
      reasoning("", 1500 + 300),
      text("Checking first."),
      reasoning("", 1500 + 100),
      toolCall(),
      usageRecord(100),
    ]).flat();

    const blocks = thinkingData(released);
    assert.deepStrictEqual(
      blocks.map((block) => block.reasoningTokens),
      [75, 25],
      "shares follow each block's size beyond the fixed overhead"
    );
    assert.ok(blocks.every((block) => block.reasoningTokensEstimated));
  });

  test("falls back to token_count when a log has no usage record", () => {
    const grouper = new CodexReasoningGrouper();
    const released = feed(grouper, [
      reasoning(""),
      [
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { reasoning_output_tokens: 42 } },
          },
        },
        [],
      ],
    ]).flat();

    assert.strictEqual(thinkingData(released)[0].reasoningTokens, 42);
  });

  test("releases without a count at a tool output when the response never reported usage", () => {
    const grouper = new CodexReasoningGrouper();
    const released = feed(grouper, [
      reasoning(""),
      toolCall(),
      toolOutput(),
      usageRecord(99),
    ]);

    assert.strictEqual(released[2].length, 2, "released at the tool output");
    assert.strictEqual(thinkingData(released[2])[0].reasoningTokens, undefined);
    assert.strictEqual(
      released[3].length,
      0,
      "a later count has nothing to apply to"
    );
  });

  test("reset drops a held response and flush releases one", () => {
    const grouper = new CodexReasoningGrouper();
    feed(grouper, [reasoning("**stale**")]);
    grouper.reset();
    assert.deepStrictEqual(grouper.flush(), []);

    feed(grouper, [reasoning("**kept**"), toolCall()]);
    assert.deepStrictEqual(
      grouper.flush().map((event) => event.type),
      [CLI_EVENT_TYPES.THINKING, CLI_EVENT_TYPES.BASH_COMMAND]
    );
  });
});
