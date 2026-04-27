import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUiStore } from "@store/uiStore";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import type { CliOutput as CliOutputType } from "@/types/cliEvents";
import type { WorkspaceSnapshot } from "@root/types/OutputHistoryTypes";

vi.mock("@utils/hljsUtils", () => ({
  highlightLines: vi.fn(() => []),
  injectHljsStyles: vi.fn(),
  getLanguageFromPath: vi.fn(() => "typescript"),
}));

vi.mock("@hooks/useMessageHandler", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@hooks/useMessageHandler")>();
  return { ...original, openFile: vi.fn() };
});

import { CliOutput } from "@components/output/CliOutput";

describe("CliOutput", () => {
  beforeEach(() => {
    useUiStore.setState({ diffsCollapsed: true, diffResetVersion: 0 });
  });

  it("prefers the workspace snapshot patch when the event patch is malformed", async () => {
    const user = userEvent.setup();

    const output: CliOutputType = {
      prompt: "",
      response: "",
      elapsed: 0,
      structured: {
        events: [
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            data: {
              path: "src/example.ts",
              status: OPERATION_STATUS.COMPLETED,
              structuredPatch: [
                {
                  oldStart: 10,
                  oldLines: 1,
                  newStart: 10,
                  newLines: 1,
                  lines: ["-event late", "+event later"],
                },
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-event early", "+event earlier"],
                },
              ],
            },
          },
        ],
        metadata: {},
      },
      isStreaming: false,
    };

    const workspaceSnapshot: WorkspaceSnapshot = {
      capturedAt: Date.now(),
      strategy: "git",
      git: {
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
      },
      changedFiles: [
        {
          path: "src/example.ts",
          changeType: "modified",
          beforeContent: "line 1\nline 2\nsnapshot old\n",
          structuredPatch: [
            {
              oldStart: 3,
              oldLines: 1,
              newStart: 3,
              newLines: 1,
              lines: ["-snapshot old", "+snapshot new"],
            },
          ],
        },
      ],
    };

    render(
      <CliOutput
        output={output}
        stepIndex={0}
        attemptIndex={0}
        workspaceSnapshot={workspaceSnapshot}
      />
    );

    await user.click(screen.getByRole("button", { name: /show diff/i }));

    expect(screen.getByText("snapshot new")).toBeInTheDocument();
    expect(screen.queryByText("event earlier")).not.toBeInTheDocument();
  });

  it("uses the same snapshot-backed diff in the undo dialog that the inline diff rendered", async () => {
    const user = userEvent.setup();

    const output: CliOutputType = {
      prompt: "",
      response: "",
      elapsed: 0,
      structured: {
        events: [
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            data: {
              path: "src/example.ts",
              status: OPERATION_STATUS.COMPLETED,
              structuredPatch: [
                {
                  oldStart: 10,
                  oldLines: 1,
                  newStart: 10,
                  newLines: 1,
                  lines: ["-event late", "+event later"],
                },
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-event early", "+event earlier"],
                },
              ],
            },
          },
        ],
        metadata: {},
      },
      isStreaming: false,
      workingDirectory: "C:/dev/FlightPath",
    };

    const workspaceSnapshot: WorkspaceSnapshot = {
      capturedAt: Date.now(),
      strategy: "git",
      git: {
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
      },
      changedFiles: [
        {
          path: "src/example.ts",
          changeType: "modified",
          beforeContent: "line 1\nline 2\nsnapshot old\n",
          structuredPatch: [
            {
              oldStart: 3,
              oldLines: 1,
              newStart: 3,
              newLines: 1,
              lines: ["-snapshot old", "+snapshot new"],
            },
          ],
        },
      ],
    };

    render(
      <CliOutput
        output={output}
        stepIndex={0}
        attemptIndex={0}
        allowUndoActions={true}
        workspaceSnapshot={workspaceSnapshot}
      />
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.click(screen.getAllByRole("button", { name: /show diff/i })[0]);

    expect(screen.getByText("snapshot new")).toBeInTheDocument();
    expect(screen.queryByText("event earlier")).not.toBeInTheDocument();
  });

  it("opens single-diff undo from the rendered event even when the raw event list normalizes differently", async () => {
    const user = userEvent.setup();

    const output: CliOutputType = {
      prompt: "",
      response: "",
      elapsed: 0,
      structured: {
        events: [
          {
            type: CLI_EVENT_TYPES.TOOL_CALL,
            data: {
              id: "call_1",
              name: "report_intent",
              parameters: { intent: "edit file" },
            },
          },
          {
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            data: {
              toolCallId: "call_1",
              result: { success: true, output: "Intent logged" },
            },
          },
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            data: {
              path: "src/example.ts",
              status: OPERATION_STATUS.INITIATED,
            },
          },
          {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            data: {
              path: "src/example.ts",
              status: OPERATION_STATUS.COMPLETED,
            },
          },
        ],
        metadata: {},
      },
      isStreaming: false,
      workingDirectory: "C:/dev/FlightPath",
    };

    const workspaceSnapshot: WorkspaceSnapshot = {
      capturedAt: Date.now(),
      strategy: "git",
      git: {
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
      },
      changedFiles: [
        {
          path: "src/example.ts",
          changeType: "modified",
          beforeContent: "const value = 1;\n",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-const value = 1;", "+const value = 2;"],
            },
          ],
        },
      ],
    };

    render(
      <CliOutput
        output={output}
        stepIndex={0}
        attemptIndex={0}
        allowUndoActions={true}
        workspaceSnapshot={workspaceSnapshot}
      />
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    const dialog = screen.getByRole("dialog");
    expect(
      screen.getByRole("heading", { name: "Undo changes — src/example.ts" })
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("src/example.ts");
    expect(
      screen.queryByText("No file changes found for this diff.")
    ).not.toBeInTheDocument();
  });
});
