import * as assert from "assert";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/CliOutputTypes";
import {
  capToolOutputEvent,
  capToolOutputText,
  RUN_VIEW_TOOL_OUTPUT_HEAD_BYTES,
} from "../../utils/ToolOutputPayload";

suite("ToolOutputPayload", () => {
  test("preserves output below the cap and reports UTF-8 byte length", () => {
    assert.deepStrictEqual(capToolOutputText("small output"), {
      text: "small output",
      truncated: false,
      totalBytes: 12,
      totalLines: 1,
    });
  });

  test("caps bash and tool result output with explicit original byte counts", () => {
    const source: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: { command: "echo", output: "é".repeat(300_000) },
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        data: {
          toolCallId: "call-1",
          result: { success: true, output: "x".repeat(500_000) },
        },
      },
    ];
    const bash = capToolOutputEvent(source[0]);
    const result = capToolOutputEvent(source[1]);
    const bashData = bash.data as {
      output: string;
      outputTruncated: boolean;
      outputTotalBytes: number;
      outputLines: number;
      outputTotalLines: number;
    };
    const resultData = result.data as {
      result: {
        output: string;
        outputTruncated: boolean;
        outputTotalBytes: number;
      };
    };

    assert.strictEqual(bashData.outputTruncated, true);
    assert.strictEqual(bashData.outputTotalBytes, 600_000);
    assert.strictEqual(bashData.outputLines, 1);
    assert.strictEqual(bashData.outputTotalLines, 1);
    assert.ok(
      new TextEncoder().encode(bashData.output).byteLength <=
        RUN_VIEW_TOOL_OUTPUT_HEAD_BYTES
    );
    assert.strictEqual(resultData.result.outputTruncated, true);
    assert.strictEqual(resultData.result.outputTotalBytes, 500_000);
    assert.strictEqual(
      (source[0].data as { output?: string }).output?.length,
      300_000,
      "capping should leave the caller's event unchanged"
    );
  });
});
