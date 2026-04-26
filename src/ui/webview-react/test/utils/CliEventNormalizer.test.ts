import { describe, expect, it } from "vitest";
import { normalizeCliEvents } from "@root/utils/CliEventNormalizer";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import type { CliEvent } from "@/types/cliEvents";

describe("CliEventNormalizer", () => {
  it("collapses initiated read, tool result, and completed read into one event", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.FILE_READ,
        data: {
          path: "src/example.ts",
          status: OPERATION_STATUS.INITIATED,
        },
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        data: {
          toolCallId: "read-1",
          result: {
            success: true,
            output: "file contents",
          },
        },
      },
      {
        type: CLI_EVENT_TYPES.FILE_READ,
        data: {
          path: "src/example.ts",
          content: "file contents",
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe(CLI_EVENT_TYPES.FILE_READ);
    expect(normalized[0].data).toMatchObject({
      path: "src/example.ts",
      content: "file contents",
      status: OPERATION_STATUS.COMPLETED,
      success: true,
    });
  });

  it("preserves initiated edit diff when the completed event lacks it", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-before", "+after"],
      },
    ];

    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/example.ts",
          structuredPatch,
          status: OPERATION_STATUS.INITIATED,
        },
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        data: {
          toolCallId: "edit-1",
          result: {
            success: true,
            output: "applied",
          },
        },
      },
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/example.ts",
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe(CLI_EVENT_TYPES.FILE_EDIT);
    expect(normalized[0].data).toMatchObject({
      path: "src/example.ts",
      status: OPERATION_STATUS.COMPLETED,
      success: true,
      structuredPatch,
    });
  });

  it("attaches tool results to generic tool calls", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        data: {
          id: "tool-1",
          name: "list_resources",
          parameters: { limit: 10 },
        },
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        data: {
          toolCallId: "tool-1",
          result: {
            success: true,
            output: "done",
          },
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe(CLI_EVENT_TYPES.TOOL_CALL);
    expect(normalized[0].data).toMatchObject({
      id: "tool-1",
      name: "list_resources",
      result: {
        success: true,
        output: "done",
      },
    });
  });

  it("preserves an initiated bash command when the completed event omits it", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm run test:ui",
          status: OPERATION_STATUS.INITIATED,
        },
      },
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "",
          output: "test output",
          exitCode: 0,
          status: OPERATION_STATUS.COMPLETED,
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe(CLI_EVENT_TYPES.BASH_COMMAND);
    expect(normalized[0].data).toMatchObject({
      command: "npm run test:ui",
      output: "test output",
      exitCode: 0,
      status: OPERATION_STATUS.COMPLETED,
    });
  });

  it("does not merge a commandless completed bash event into a previous completed bash event", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm run lint",
          output: "lint output",
          exitCode: 0,
          status: OPERATION_STATUS.COMPLETED,
        },
      },
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "",
          output: "test output",
          exitCode: 0,
          status: OPERATION_STATUS.COMPLETED,
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].data).toMatchObject({
      command: "npm run lint",
      output: "lint output",
    });
    expect(normalized[1].data).toMatchObject({
      output: "test output",
      exitCode: 0,
      status: OPERATION_STATUS.COMPLETED,
    });
  });
});
