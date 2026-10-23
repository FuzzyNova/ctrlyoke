import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CLI_EVENT_TYPES,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../types/DashboardConstants";
import { mergeSubagentOutput } from "../../core/harness/shared/mergeSubagentOutput";
import { SUBAGENT_SPAWN_UPDATE_TOOL_NAME } from "../../core/harness/shared/SubagentSourceFollower";
import { SUBAGENT_SPAWN_STATES } from "../../types/DashboardConstants";
import type { ToolCall } from "../../types/CliOutputTypes";

suite("mergeSubagentOutput", () => {
  test("orders events and folds per-model usage into all attempt totals", () => {
    const output = mergeSubagentOutput(
      {
        events: [
          {
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: 10,
            data: { text: "parent" },
          },
        ],
        metadata: {
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            modelUsage: { parent: { inputTokens: 2 } },
          },
        },
      },
      {
        events: [
          { type: CLI_EVENT_TYPES.TEXT, timestamp: 5, data: { text: "child" } },
        ],
        usageByModel: {
          childModel: {
            inputTokens: 7,
            outputTokens: 4,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 2,
            cacheCreationLongTtlInputTokens: 1,
            reasoningOutputTokens: 5,
          },
        },
        partial: false,
      }
    );
    assert.deepStrictEqual(
      output.events.map((event) => event.timestamp),
      [5, 10]
    );
    assert.deepStrictEqual(output.metadata.usage, {
      inputTokens: 9,
      outputTokens: 7,
      totalTokens: 16,
      cachedInputTokens: 3,
      cacheCreatedTokens: 2,
      cacheCreatedLongTtlTokens: 1,
      reasoningOutputTokens: 5,
      modelUsage: {
        parent: { inputTokens: 2 },
        childModel: {
          inputTokens: 7,
          outputTokens: 4,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          cacheCreationLongTtlInputTokens: 1,
          reasoningOutputTokens: 5,
        },
      },
    });
    assert.strictEqual(
      output.metadata.modelUsage?.childModel?.cacheCreationLongTtlInputTokens,
      1
    );
  });

  test("marks token coverage partial when any registered source was unreadable", () => {
    const output = mergeSubagentOutput(
      { events: [], metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
      {
        events: [],
        usageByModel: {},
        partial: true,
      }
    );
    assert.strictEqual(
      output.metadata.usage?.totalConfidence,
      TOKEN_TOTAL_CONFIDENCE.PARTIAL
    );
  });

  test("applies child completion state to its existing spawn event", () => {
    const output = mergeSubagentOutput(
      {
        events: [
          {
            type: CLI_EVENT_TYPES.TOOL_CALL,
            data: {
              id: "spawn",
              name: "task",
              parameters: {},
              subagentSpawn: {
                description: "child work",
                state: SUBAGENT_SPAWN_STATES.RUNNING,
              },
            },
          },
        ],
        metadata: {},
      },
      {
        events: [
          {
            type: CLI_EVENT_TYPES.TOOL_CALL,
            data: {
              id: "spawn",
              name: SUBAGENT_SPAWN_UPDATE_TOOL_NAME,
              parameters: {},
              subagentSpawn: { state: SUBAGENT_SPAWN_STATES.COMPLETED },
            },
          },
        ],
        usageByModel: {},
        partial: false,
      }
    );
    const spawn = output.events[0];
    assert.strictEqual(spawn.type, CLI_EVENT_TYPES.TOOL_CALL);
    if (spawn.type === CLI_EVENT_TYPES.TOOL_CALL) {
      const toolCall = spawn.data as ToolCall;
      assert.strictEqual(toolCall.subagentSpawn?.description, "child work");
      assert.strictEqual(
        toolCall.subagentSpawn?.state,
        SUBAGENT_SPAWN_STATES.COMPLETED
      );
    }
  });
});
