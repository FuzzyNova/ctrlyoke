import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { OutputRow } from "@components/output/OutputRow";
import type { OutputRenderRow, StructuredEventRow } from "@utils/outputRows";
import { findOutputMatches, type OutputFindMatch } from "@utils/outputFind";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import { FINAL_STEP_PHASES } from "@/types/messages";

const TARGET = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function buildBashRow(
  command: string,
  output: string | undefined,
  error: string | undefined
): StructuredEventRow {
  return {
    key: "row-bash",
    target: TARGET,
    estimateSize: 0,
    rowKind: "structured-event",
    event: {
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: {
        command,
        output,
        error,
        exitCode: error ? 1 : 0,
        status: OPERATION_STATUS.COMPLETED,
      },
    },
    eventIndex: 0,
    rawTextOutput: false,
    attemptIndex: 0,
    hideDiff: false,
  };
}

function buildToolCallRow(
  name: string,
  result: { success: boolean; output?: string; error?: string }
): StructuredEventRow {
  return {
    key: "row-tool",
    target: TARGET,
    estimateSize: 0,
    rowKind: "structured-event",
    event: {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      data: { name, parameters: {}, result },
    },
    eventIndex: 0,
    rawTextOutput: false,
    attemptIndex: 0,
    hideDiff: false,
  };
}

function buildActiveMatch(
  row: StructuredEventRow,
  field: OutputFindMatch["field"],
  start: number,
  end: number
): OutputFindMatch {
  return {
    matchId: `0-${field}-${start}`,
    rowKey: row.key,
    rowIndex: 0,
    rowKind: row.rowKind,
    field,
    start,
    end,
    preview: "",
  };
}

const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
  "\n"
);

describe("OutputRow auto-expand on hidden active match", () => {
  it("expands a truncated bash command when the active match is hidden", () => {
    const command = `node -e "${"x".repeat(220)} target"`;
    const row = buildBashRow(command, undefined, undefined);
    const localStart = command.indexOf("target");
    const activeMatch = buildActiveMatch(
      row,
      "command",
      localStart,
      localStart + "target".length
    );
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [
            {
              start: localStart,
              end: localStart + "target".length,
              active: true,
            },
          ],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).toHaveBeenCalledWith(
      "row-bash",
      "command",
      true
    );
  });

  it("expands bash output when the active match is hidden behind 'show more'", () => {
    const command = "cat";
    const row = buildBashRow(command, TWENTY_LINES, undefined);
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "response",
      globalStart,
      globalEnd
    );
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).toHaveBeenCalledWith(
      "row-bash",
      "output",
      true
    );
  });

  it("expands bash error output when the active match is hidden behind 'show more'", () => {
    const command = "cat";
    const row = buildBashRow(command, undefined, TWENTY_LINES);
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(row, "error", globalStart, globalEnd);
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).toHaveBeenCalledWith(
      "row-bash",
      "error",
      true
    );
  });

  it("does not expand bash output when the active match is already visible", () => {
    const command = "cat";
    const row = buildBashRow(command, TWENTY_LINES, undefined);
    const localStart = TWENTY_LINES.indexOf("line 0");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 0".length;
    const activeMatch = buildActiveMatch(
      row,
      "response",
      globalStart,
      globalEnd
    );
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).not.toHaveBeenCalled();
  });

  it("does not expand when the row is not the active find row", () => {
    const command = "cat";
    const row = buildBashRow(command, TWENTY_LINES, undefined);
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch: OutputFindMatch = {
      ...buildActiveMatch(row, "response", globalStart, globalEnd),
      rowKey: "some-other-row",
    };
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: false }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).not.toHaveBeenCalled();
  });

  it("expands tool call output when the active match is hidden behind 'show more'", () => {
    const name = "Read";
    const row = buildToolCallRow(name, { success: true, output: TWENTY_LINES });
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = name.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "toolContent",
      globalStart,
      globalEnd
    );
    const onToolCallExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        onToolCallExpansionChange={onToolCallExpansionChange}
      />
    );

    expect(onToolCallExpansionChange).toHaveBeenCalledWith(
      "row-tool",
      "output",
      true
    );
  });

  it("expands tool call error when the active match is hidden behind 'show more'", () => {
    const name = "Bash";
    const row = buildToolCallRow(name, { success: false, error: TWENTY_LINES });
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = name.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "toolContent",
      globalStart,
      globalEnd
    );
    const onToolCallExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        onToolCallExpansionChange={onToolCallExpansionChange}
      />
    );

    expect(onToolCallExpansionChange).toHaveBeenCalledWith(
      "row-tool",
      "error",
      true
    );
  });

  it("highlights sanitized bash output at the rendered location", () => {
    const row = buildBashRow(
      "echo ok",
      "\u001b[31malpha\u001b[0m beta",
      undefined
    );
    const [match] = findOutputMatches([row], "alpha", false);

    const { container } = render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: match.start, end: match.end, active: true }],
        }}
        activeFindMatch={match}
        isExecutionActive={false}
      />
    );

    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("alpha");
    expect(mark).toHaveAttribute("data-find-active", "true");
  });

  it("renders ctrlyoke references in the prompt row as clickable links", () => {
    const row: OutputRenderRow = {
      key: "row-prompt",
      target: TARGET,
      estimateSize: 0,
      rowKind: "prompt",
      text: "Review @src/app.ts and #sym:src/utils.ts:runWorkflow:42-58 now",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    const links = container.querySelectorAll('[role="link"]');
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe("@src/app.ts");
    expect(links[1].textContent).toBe("#sym:src/utils.ts:runWorkflow:42-58");
    // Plain prose stays as text, not links.
    expect(container).toHaveTextContent(
      "Review @src/app.ts and #sym:src/utils.ts:runWorkflow:42-58 now"
    );
  });

  it("does not linkify prompt references inside fenced code blocks", () => {
    const row: OutputRenderRow = {
      key: "row-prompt-fenced",
      target: TARGET,
      estimateSize: 0,
      rowKind: "prompt",
      text: "Use @src/app.ts here\n```\n@src/ignored.ts\n```",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    const links = container.querySelectorAll('[role="link"]');
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe("@src/app.ts");
    // The fenced reference is still shown as plain text, just not a link.
    expect(container).toHaveTextContent("@src/ignored.ts");
  });

  it("renders legacy user-stop error rows as warnings", () => {
    const row: OutputRenderRow = {
      key: "row-error",
      target: TARGET,
      estimateSize: 0,
      rowKind: "error",
      errorMessage: "Stopped by user",
      timestamp: "12:03:21",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    expect(container).toHaveTextContent("[12:03:21] Warning: Stopped by user");
    expect(container).not.toHaveTextContent(
      "[12:03:21] Error: Stopped by user"
    );
  });
});
