import * as assert from "assert";
import type {
  BashCommandData,
  CliEvent,
  FileEditData,
  FileReadData,
  McpToolCallData,
  ToolCall,
  WebSearchData,
} from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../types/DashboardConstants";
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

    const bash = normalized.find((e) => e.type === CLI_EVENT_TYPES.BASH_COMMAND)
      ?.data as BashCommandData;
    const read = normalized.find((e) => e.type === CLI_EVENT_TYPES.FILE_READ)
      ?.data as FileReadData;

    assert.strictEqual(bash.status, OPERATION_STATUS.COMPLETED);
    assert.strictEqual(bash.output, "screenshot listing");
    assert.strictEqual(read.status, OPERATION_STATUS.COMPLETED);
    assert.strictEqual(read.content, "# Trademark Filing Guide");
  });

  test("a trailing result for an already-completed call does not resolve an unrelated in-flight call", () => {
    // Copilot pairs start/complete itself, emits a semantic COMPLETED event,
    // then a TOOL_RESULT for the same call id. That trailing result must land
    // on its own row, not on whatever id-less call is still running.
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: 1,
        data: {
          command: "npm run typecheck",
          status: OPERATION_STATUS.INITIATED,
          toolCallId: "call_typecheck",
        } as BashCommandData,
      },
      {
        type: CLI_EVENT_TYPES.WEB_SEARCH,
        timestamp: 2,
        data: { query: "vitest timeout" } as WebSearchData,
      },
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: 3,
        data: {
          command: "npm run typecheck",
          output: "no errors",
          status: OPERATION_STATUS.COMPLETED,
          toolCallId: "call_typecheck",
        } as BashCommandData,
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp: 4,
        data: {
          toolCallId: "call_typecheck",
          result: { success: true, output: "no errors" },
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    assert.deepStrictEqual(
      normalized.map((e) => e.type),
      [CLI_EVENT_TYPES.BASH_COMMAND, CLI_EVENT_TYPES.WEB_SEARCH]
    );
    const search = normalized[1].data as WebSearchData;
    assert.strictEqual(search.success, undefined);
    assert.strictEqual(search.results, undefined);
  });

  test("pairs same-text commands running in parallel by their own call ids", () => {
    const initiated = (toolCallId: string, timestamp: number): CliEvent => ({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp,
      data: {
        command: "npm test",
        status: OPERATION_STATUS.INITIATED,
        toolCallId,
      } as BashCommandData,
    });
    const events: CliEvent[] = [
      initiated("call_a", 1),
      initiated("call_b", 2),
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp: 3,
        data: {
          command: "npm test",
          output: "a passed",
          status: OPERATION_STATUS.COMPLETED,
          toolCallId: "call_a",
        } as BashCommandData,
      },
    ];

    const [first, second] = normalizeCliEvents(events).map(
      (e) => e.data as BashCommandData
    );

    assert.strictEqual(first.toolCallId, "call_a");
    assert.strictEqual(first.status, OPERATION_STATUS.COMPLETED);
    assert.strictEqual(first.output, "a passed");
    assert.strictEqual(second.toolCallId, "call_b");
    assert.strictEqual(second.status, OPERATION_STATUS.INITIATED);
  });

  test("pairs a call's relative start path with its absolute completion path", () => {
    // Copilot's multi-file apply_patch starts with the patch's relative paths
    // but completes with the absolute paths from the git diff it reports.
    const edit = (
      filePath: string,
      status: FileEditData["status"],
      timestamp: number
    ): CliEvent => ({
      type: CLI_EVENT_TYPES.FILE_EDIT,
      timestamp,
      data: {
        path: filePath,
        status,
        toolCallId: "call_patch",
      } as FileEditData,
    });
    const events: CliEvent[] = [
      edit("src/core/PromptQueue.ts", OPERATION_STATUS.INITIATED, 1),
      edit("src/core/WorkflowExecutor.ts", OPERATION_STATUS.INITIATED, 2),
      edit(
        "C:/dev/ctrlyoke.worktrees/big-feature/src/core/PromptQueue.ts",
        OPERATION_STATUS.COMPLETED,
        3
      ),
      edit(
        "C:/dev/ctrlyoke.worktrees/big-feature/src/core/WorkflowExecutor.ts",
        OPERATION_STATUS.COMPLETED,
        4
      ),
    ];

    const normalized = normalizeCliEvents(events);

    assert.strictEqual(normalized.length, 2);
    assert.ok(
      normalized.every(
        (e) => (e.data as FileEditData).status === OPERATION_STATUS.COMPLETED
      )
    );
  });

  test("pairs concurrent MCP completions by call id when results arrive in reverse order", () => {
    const initiated = (toolCallId: string, timestamp: number): CliEvent => ({
      type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
      timestamp,
      data: {
        server: "ctrlyoke",
        tool: "claim_paths",
        toolCallId,
        parameters: { call: toolCallId },
      } as McpToolCallData,
    });
    const completed = (
      toolCallId: string,
      output: string,
      timestamp: number
    ): CliEvent => ({
      type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
      timestamp,
      data: {
        server: "ctrlyoke",
        tool: "claim_paths",
        toolCallId,
        result: { success: true, output },
      } as McpToolCallData,
    });

    const normalized = normalizeCliEvents([
      initiated("call_a", 1),
      initiated("call_b", 2),
      completed("call_b", "result b", 3),
      completed("call_a", "result a", 4),
    ]);

    assert.strictEqual(normalized.length, 2);
    const rows = normalized.map((event) => event.data as McpToolCallData);
    assert.deepStrictEqual(
      rows.map(({ toolCallId, parameters, result }) => ({
        toolCallId,
        parameters,
        result: result?.output,
      })),
      [
        {
          toolCallId: "call_a",
          parameters: { call: "call_a" },
          result: "result a",
        },
        {
          toolCallId: "call_b",
          parameters: { call: "call_b" },
          result: "result b",
        },
      ]
    );
  });

  test("keeps a result-bearing tool call with an unknown id as its own row", () => {
    const initiated: CliEvent = {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp: 1,
      data: { name: "report_intent", id: "known", parameters: { a: 1 } },
    };
    const unknownCompletion: CliEvent = {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp: 2,
      data: {
        name: "report_intent",
        id: "unknown",
        parameters: { a: 2 },
        result: { success: true, output: "done" },
      },
    };

    const normalized = normalizeCliEvents([initiated, unknownCompletion]);

    assert.strictEqual(normalized.length, 2);
    assert.strictEqual(
      (normalized[0].data as ToolCall).result,
      undefined
    );
    assert.strictEqual(
      (normalized[1].data as ToolCall).result?.output,
      "done"
    );
  });
});
