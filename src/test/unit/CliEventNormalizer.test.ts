import * as assert from "assert";
import type {
  BashCommandData,
  CliEvent,
  FileReadData,
  ToolCall,
} from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../../types/DashboardConstants";
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

  test("resolves a bash command's own result even when another tool call was initiated first and remains pending", () => {
    // Reproduces a real Claude CLI trace: a PowerShell tool_use is issued,
    // then — before its result comes back — a Read tool_use is issued too.
    // Both results arrive afterward. Without id-based correlation on
    // BASH_COMMAND, the bash command's result was previously misattributed to
    // the newer, still-pending Read call (the last entry on the pending
    // stack), leaving the bash row stuck at "initiated" forever.
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: 1,
        data: {
          command: "Get-ChildItem images\\screenshots",
          status: OPERATION_STATUS.INITIATED,
          toolCallId: "toolu_bash",
        } as BashCommandData,
      },
      {
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp: 2,
        data: {
          path: "TRADEMARK_FILING_GUIDE.md",
          status: OPERATION_STATUS.INITIATED,
          toolCallId: "toolu_read",
        } as FileReadData,
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp: 3,
        data: {
          toolCallId: "toolu_bash",
          result: { success: true, output: "screenshot listing" },
        },
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp: 4,
        data: {
          toolCallId: "toolu_read",
          result: { success: true, output: "# Trademark Filing Guide" },
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    const bash = normalized.find(
      (e) => e.type === CLI_EVENT_TYPES.BASH_COMMAND
    )?.data as BashCommandData;
    const read = normalized.find(
      (e) => e.type === CLI_EVENT_TYPES.FILE_READ
    )?.data as FileReadData;

    assert.strictEqual(bash.status, OPERATION_STATUS.COMPLETED);
    assert.strictEqual(bash.output, "screenshot listing");
    assert.strictEqual(read.status, OPERATION_STATUS.COMPLETED);
    assert.strictEqual(read.content, "# Trademark Filing Guide");
  });
});
