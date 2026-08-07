import * as assert from "assert";
import type { CliEvent, ToolCall } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";

suite("CliEventNormalizer", () => {
  test("normalizes structured tool-result output before merging it into a tool call", () => {
    const events = JSON.parse(`[
      {
        "type": "${CLI_EVENT_TYPES.TOOL_CALL}",
        "data": {
          "name": "wait",
          "parameters": { "cell_id": "25" },
          "id": "call-1"
        }
      },
      {
        "type": "${CLI_EVENT_TYPES.TOOL_RESULT}",
        "data": {
          "toolCallId": "call-1",
          "result": {
            "success": true,
            "output": [
              { "type": "input_text", "text": "Script completed" },
              { "type": "input_text", "text": "Exit code: 0" }
            ]
          }
        }
      }
    ]`) as CliEvent[];

    const normalized = normalizeCliEvents(events);

    assert.strictEqual(normalized.length, 1);
    const toolCall = normalized[0].data as ToolCall;
    assert.strictEqual(
      toolCall.result?.output,
      "Script completed\nExit code: 0"
    );
  });

  test("normalizes a structured result already attached to a tool call", () => {
    const events = JSON.parse(`[
      {
        "type": "${CLI_EVENT_TYPES.TOOL_CALL}",
        "data": {
          "name": "wait",
          "parameters": {},
          "id": "call-1",
          "result": {
            "success": true,
            "output": [{ "type": "input_text", "text": "Done" }]
          }
        }
      }
    ]`) as CliEvent[];

    const [normalized] = normalizeCliEvents(events);
    const result = (normalized.data as ToolCall).result;

    assert.strictEqual(result?.output, "Done");
  });
});
