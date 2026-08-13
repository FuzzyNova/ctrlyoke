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

  it("preserves multiple sequential edits to the same file as separate events", () => {
    const patch1 = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: ["-old1", "+new1a", "+new1b"],
      },
    ];
    const patch2 = [
      {
        oldStart: 5,
        oldLines: 1,
        newStart: 6,
        newLines: 1,
        lines: ["-old2", "+new2"],
      },
    ];
    const patch3 = [
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 11,
        newLines: 3,
        lines: ["-old3a", "-old3b", "+new3a", "+new3b", "+new3c"],
      },
    ];

    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/editor/Footer.tsx",
          structuredPatch: patch1,
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        },
      },
      {
        type: CLI_EVENT_TYPES.TEXT,
        data: { text: "Now attaching the second ref..." },
      },
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/editor/Footer.tsx",
          structuredPatch: patch2,
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        },
      },
      {
        type: CLI_EVENT_TYPES.TEXT,
        data: { text: "Now hiding the quick pickers..." },
      },
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/editor/Footer.tsx",
          structuredPatch: patch3,
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(5);
    expect(normalized[0].type).toBe(CLI_EVENT_TYPES.FILE_EDIT);
    expect(
      (normalized[0].data as { structuredPatch: unknown }).structuredPatch
    ).toEqual(patch1);
    expect(normalized[2].type).toBe(CLI_EVENT_TYPES.FILE_EDIT);
    expect(
      (normalized[2].data as { structuredPatch: unknown }).structuredPatch
    ).toEqual(patch2);
    expect(normalized[4].type).toBe(CLI_EVENT_TYPES.FILE_EDIT);
    expect(
      (normalized[4].data as { structuredPatch: unknown }).structuredPatch
    ).toEqual(patch3);
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

  it("collapses an initiated AskUserQuestion and its answer into one event", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        data: {
          toolCallId: "ask-1",
          status: OPERATION_STATUS.INITIATED,
          questions: [
            {
              question: "Favorite animal?",
              options: [{ label: "Cat" }, { label: "Dog" }],
            },
          ],
        },
      },
      {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        data: {
          toolCallId: "ask-1",
          status: OPERATION_STATUS.COMPLETED,
          questions: [
            {
              question: "Favorite animal?",
              options: [{ label: "Cat" }, { label: "Dog" }],
              answer: "Cat",
            },
          ],
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe(CLI_EVENT_TYPES.ASK_USER_QUESTION);
    expect(normalized[0].data).toMatchObject({
      status: OPERATION_STATUS.COMPLETED,
      questions: [{ question: "Favorite animal?", answer: "Cat" }],
    });
  });

  it("backfills the question set onto a declined AskUserQuestion from its initiated event", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        data: {
          toolCallId: "ask-2",
          status: OPERATION_STATUS.INITIATED,
          questions: [
            {
              question: "Ship it?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
      {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        data: {
          toolCallId: "ask-2",
          status: OPERATION_STATUS.FAILED,
          questions: [],
          declined: { reason: "clarify", feedback: "hold on, what about X?" },
        },
      },
    ];

    const normalized = normalizeCliEvents(events);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].data).toMatchObject({
      status: OPERATION_STATUS.FAILED,
      declined: { reason: "clarify", feedback: "hold on, what about X?" },
      questions: [{ question: "Ship it?" }],
    });
  });
});
