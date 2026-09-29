import * as assert from "assert";
import { suite, test } from "mocha";
import { CliLogEventPump } from "../../core/harness/shared/CliLogEventPump";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";
import type {
  BashCommandData,
  CliEvent,
  McpToolCallData,
} from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  MCP_CALL_VIA,
  OPERATION_STATUS,
} from "../../types/DashboardConstants";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";

suite("CliLogEventPump", () => {
  test("rewrites a skill-mode bash triple before raw streaming consumers", () => {
    const command =
      `node "/repo/out/mcp-server.js" --tool submit_commit_message --args '{"message":"fix: event mapping"}'`;
    const parsedEvents: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: 1,
        data: {
          command,
          status: OPERATION_STATUS.INITIATED,
          toolCallId: "skill-call-1",
        } as BashCommandData,
      },
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: 2,
        data: {
          command,
          output: "commit message accepted",
          exitCode: 0,
          status: OPERATION_STATUS.COMPLETED,
          toolCallId: "skill-call-1",
        } as BashCommandData,
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp: 3,
        data: {
          toolCallId: "skill-call-1",
          result: { success: true, output: "commit message accepted" },
        },
      },
    ];
    const streamedEvents: CliEvent[] = [];
    let commitMessageToolDetected = false;
    const parser = {
      extractStructuredEventsFromEvent: () => parsedEvents,
    } as unknown as ILogParser;
    const pump = new CliLogEventPump({
      parser,
      model: "test-model",
      onStreamingEvents: (events) => {
        streamedEvents.push(...events);
        commitMessageToolDetected ||= events.some(
          (event) =>
            event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL &&
            (event.data as McpToolCallData).tool === "submit_commit_message"
        );
      },
    });

    pump.processEvent({} as BaseCliEvent);

    assert.strictEqual(streamedEvents.length, 3);
    assert.ok(
      streamedEvents.every(
        (event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
      )
    );
    for (const event of streamedEvents) {
      const data = event.data as McpToolCallData;
      assert.strictEqual(data.via, MCP_CALL_VIA.SKILL);
      assert.strictEqual(data.server, "ctrlyoke");
      assert.strictEqual(data.tool, "submit_commit_message");
      assert.strictEqual(data.toolCallId, "skill-call-1");
      assert.deepStrictEqual(data.parameters, {
        message: "fix: event mapping",
      });
    }
    assert.strictEqual(
      (streamedEvents[1].data as McpToolCallData).result?.output,
      "commit message accepted"
    );
    assert.strictEqual(commitMessageToolDetected, true);

    const normalized = normalizeCliEvents(streamedEvents);
    assert.strictEqual(normalized.length, 1);
    assert.strictEqual(normalized[0].type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
  });
});
