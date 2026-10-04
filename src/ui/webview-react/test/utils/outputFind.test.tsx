import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CliOutput, FileEditData } from "@/types/cliEvents";
import { CLI_EVENT_TYPES } from "@/types/cliEvents";
import { FINAL_STEP_PHASES } from "@/types/messages";
import {
  findOutputMatches,
  getOutputRowSearchSegments,
  highlightText,
} from "@utils/outputFind";
import { locateActiveDiffMatch } from "@utils/rdvAdapter";
import type {
  OutputRenderRow,
  ScriptVerdictRow,
  StructuredEventRow,
} from "@utils/outputRows";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { getFileReadHeaderText } from "@root/utils/FileReadHeaderText";

const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function makePromptRow(text: string, key = "prompt-1"): OutputRenderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.PROMPT,
    target,
    text,
    estimateSize: 24,
  };
}

function makePlainResponseRow(
  text: string,
  key = "response-1"
): OutputRenderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
    target,
    text,
    rawTextOutput: true,
    animated: false,
    estimateSize: 24,
  };
}

function makeStructuredBashRow(
  command: string,
  output = "all tests passed",
  error?: string,
  key = "bash-1"
): OutputRenderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    target,
    event: {
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: {
        command,
        output,
        error,
      },
    },
    eventIndex: 0,
    rawTextOutput: true,
    hideDiff: false,
    estimateSize: 48,
  };
}

function makeStructuredFileEditRow(): StructuredEventRow {
  return {
    key: "file-edit-1",
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    target,
    event: {
      type: CLI_EVENT_TYPES.FILE_EDIT,
      data: {
        path: "src/example.ts",
        status: "completed",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              " const a = 1;",
              "-export default a",
              "\\ No newline at end of file",
              "+export default a;",
              "\\ No newline at end of file",
            ],
          },
        ],
      },
    },
    eventIndex: 0,
    rawTextOutput: true,
    hideDiff: false,
    estimateSize: 48,
  };
}

function makeStructuredToolCallRow(
  name: string,
  result: { success: boolean; output?: string; error?: string },
  parameters: Record<string, unknown> = {},
  key = "tool-1"
): OutputRenderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    target,
    event: {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      data: {
        name,
        parameters,
        result,
      },
    },
    eventIndex: 0,
    rawTextOutput: true,
    hideDiff: false,
    estimateSize: 48,
  };
}

function makeStatsRow(key = "stats-1"): OutputRenderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.STATS,
    target,
    output: {
      prompt: "hidden",
      response: "hidden",
      elapsed: 0,
      isStreaming: false,
    } as CliOutput,
    outputText: "hidden output",
    estimateSize: 20,
  };
}

function makeVerdictRow(): ScriptVerdictRow {
  return {
    key: "verdict-1",
    rowKind: OUTPUT_ROW_KINDS.SCRIPT_VERDICT,
    target,
    estimateSize: 36,
    expanded: false,
    verdict: {
      compareSource: "stdout",
      operator: "eq",
      expected: "PASS",
      actual: "all tests PASS",
      outcome: "passed",
      action: "continue",
      durationMs: 1000,
    },
  };
}

describe("outputFind", () => {
  it("formats file-read line ranges through the shared header helper", () => {
    expect(
      getFileReadHeaderText({
        path: "src/example.ts",
        lineStart: 12,
        lineEnd: 40,
      })
    ).toBe("#selection:src/example.ts:12-40");
  });

  describe("findOutputMatches", () => {
    it("returns empty for an empty query", () => {
      expect(findOutputMatches([makePromptRow("hello")], "", false)).toEqual(
        []
      );
    });

    it("finds a single match in a prompt row", () => {
      const matches = findOutputMatches(
        [makePromptRow("Search me once")],
        "me",
        false
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        rowKey: "prompt-1",
        rowKind: OUTPUT_ROW_KINDS.PROMPT,
        field: "prompt",
      });
    });

    it("finds multiple matches in response text", () => {
      const matches = findOutputMatches(
        [makePlainResponseRow("alpha beta alpha")],
        "alpha",
        false
      );

      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.start)).toEqual([0, 11]);
    });

    it("respects case-sensitive and case-insensitive search", () => {
      const rows = [makePromptRow("Alpha alpha")];

      expect(findOutputMatches(rows, "alpha", false)).toHaveLength(2);
      expect(findOutputMatches(rows, "alpha", true)).toHaveLength(1);
    });

    it("returns an empty array when no matches exist", () => {
      expect(
        findOutputMatches([makePromptRow("hello")], "missing", false)
      ).toEqual([]);
    });

    it("finds expected, actual, and action text in script verdict rows", () => {
      const matches = findOutputMatches([makeVerdictRow()], "PASS", false);

      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.field)).toEqual([
        "expected",
        "actual",
      ]);

      const actionMatches = findOutputMatches(
        [makeVerdictRow()],
        "continue",
        false
      );
      expect(actionMatches).toHaveLength(1);
      expect(actionMatches[0]).toMatchObject({ field: "action" });
    });

    it("searches the exact default expected text rendered for a script verdict", () => {
      const row = makeVerdictRow();
      row.verdict.expected = undefined;

      expect(findOutputMatches([row], "no `expected` set", false)).toHaveLength(
        1
      );
      expect(findOutputMatches([row], "returns", false)).toHaveLength(0);
    });

    it("finds matches in structured bash command rows", () => {
      const matches = findOutputMatches(
        [makeStructuredBashRow("npm run test:ui")],
        "test:ui",
        false
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
        field: "command",
      });
    });

    it("searches only rendered diff content and maps offsets without prefixes or markers", () => {
      const row = makeStructuredFileEditRow();
      const patch = (row.event.data as FileEditData).structuredPatch;
      const diffSegment = getOutputRowSearchSegments(row).find(
        (segment) => segment.field === "diff"
      )!;

      expect(findOutputMatches([row], "file", false)).toHaveLength(0);
      expect(findOutputMatches([row], "+", false)).toHaveLength(0);

      const matches = findOutputMatches([row], "export", false);
      expect(matches).toHaveLength(2);
      expect(
        matches.map((match) =>
          locateActiveDiffMatch(
            patch,
            match.start - diffSegment.start,
            match.end - diffSegment.start
          )
        )
      ).toEqual([
        { side: "old", lineNumber: 2, start: 0, end: 6 },
        { side: "new", lineNumber: 2, start: 0, end: 6 },
      ]);
    });

    it("uses sanitized bash output text so match offsets align with rendered content", () => {
      const row = makeStructuredBashRow(
        "echo ok",
        "\u001b[31malpha\u001b[0m beta"
      );

      const matches = findOutputMatches([row], "alpha", false);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        field: "response",
        start: "echo ok".length + 1,
        end: "echo ok".length + 1 + "alpha".length,
      });
    });

    it("mirrors bash duplicate output suppression so matches use the rendered error segment", () => {
      const row = makeStructuredBashRow("run", "alpha", "alpha");

      const matches = findOutputMatches([row], "alpha", false);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        field: "error",
        start: "run".length + 1,
        end: "run".length + 1 + "alpha".length,
      });
    });

    it("finds matches in generic tool call output text", () => {
      const matches = findOutputMatches(
        [
          makeStructuredToolCallRow("read_file", {
            success: true,
            output: "alpha beta",
          }),
        ],
        "alpha",
        false
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
        field: "toolContent",
        start: "read_file".length + 1,
      });
    });

    it("finds matches in generic tool call parameter text", () => {
      const matches = findOutputMatches(
        [
          makeStructuredToolCallRow(
            "read_file",
            { success: true, output: "done" },
            { path: "src/params-only.ts" }
          ),
        ],
        "params-only",
        false
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        field: "params",
        start: "read_file".length + 1 + "path: src/".length,
      });
    });

    it("finds matches in MCP tool call parameter text", () => {
      const row: OutputRenderRow = {
        key: "mcp-tool-1",
        rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
        target,
        event: {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          data: {
            server: "ctrlyoke",
            tool: "append_queue",
            parameters: { prompt: "mcp-params-only" },
            result: { success: true, output: "done" },
          },
        },
        eventIndex: 0,
        rawTextOutput: true,
        hideDiff: false,
        estimateSize: 48,
      };

      const matches = findOutputMatches([row], "mcp-params-only", false);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        field: "params",
        start: "MCP: ctrlyoke.append_queue".length + 1 + "prompt: ".length,
      });
    });

    it("skips non-searchable row kinds", () => {
      const rows: OutputRenderRow[] = [
        {
          key: "anchor",
          rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
          target,
          estimateSize: 1,
        },
        makeStatsRow(),
      ];

      expect(findOutputMatches(rows, "hidden", false)).toEqual([]);
    });
  });

  describe("highlightText", () => {
    it("returns plain text when no matches exist", () => {
      expect(highlightText("plain text", [])).toBe("plain text");
    });

    it("wraps matching text in a mark element", () => {
      render(
        <>{highlightText("find me", [{ start: 5, end: 7, active: false }])}</>
      );

      const mark = screen.getByText("me");
      expect(mark.tagName).toBe("MARK");
      expect(mark).toHaveClass("bg-find-match-highlight");
    });

    it("marks the active match with data-find-active", () => {
      render(
        <>{highlightText("find me", [{ start: 5, end: 7, active: true }])}</>
      );

      expect(screen.getByText("me")).toHaveAttribute(
        "data-find-active",
        "true"
      );
      expect(screen.getByText("me")).toHaveClass(
        "bg-find-match",
        "ring-find-match-border"
      );
    });
  });
});
