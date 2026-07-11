import * as assert from "assert";
import { suite, test } from "mocha";
import { CodexResponseParser } from "../../core/harness/codex/CodexResponseParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { TextData } from "../../types/CliOutputTypes";

function getTextEvents(
  output: ReturnType<CodexResponseParser["parse"]>
): string[] {
  return output.events
    .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
    .map((event) => (event.data as TextData).text);
}

suite("CodexResponseParser", () => {
  test("should not duplicate agent text when item.started and item.completed contain the same message", () => {
    const parser = new CodexResponseParser();
    const stdout = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread_abc123",
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "agent_message",
          text: "I'm loading the handoff skill instructions now and will follow them for this turn.",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "I'm loading the handoff skill instructions now and will follow them for this turn.",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      }),
    ].join("\n");

    const output = parser.parse(stdout, "", 0);
    const textEvents = getTextEvents(output);

    assert.deepStrictEqual(textEvents, [
      "I'm loading the handoff skill instructions now and will follow them for this turn.",
    ]);
    assert.strictEqual(output.metadata.sessionId, "thread_abc123");
    assert.strictEqual(output.metadata.usage?.inputTokens, 10);
    assert.strictEqual(output.metadata.usage?.outputTokens, 5);
  });

  test("should stream completed agent text once even if item.started carried the same text", () => {
    const parser = new CodexResponseParser();
    const streamState = new Map<string, unknown>();
    const chunk = [
      JSON.stringify({
        type: "item.started",
        item: {
          type: "agent_message",
          text: "duplicate candidate",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "duplicate candidate",
        },
      }),
      "",
    ].join("\n");

    const events = parser.processStreamingChunk(chunk, streamState) || [];
    const textEvents = events
      .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
      .map((event) => (event.data as TextData).text);

    assert.deepStrictEqual(textEvents, ["duplicate candidate"]);
  });
  test("should use the resolved Codex 5.6 model for context window fallback", () => {
    const parser = new CodexResponseParser();
    parser.setCurrentModel?.("gpt-5.6-sol");

    const stdout = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread_5_6",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
        },
      }),
    ].join("\n");

    const output = parser.parse(stdout, "", 0);

    assert.strictEqual(output.metadata.model, "gpt-5.6-sol");
    assert.strictEqual(output.metadata.usage?.contextWindowSize, 1_050_000);
  });

});
