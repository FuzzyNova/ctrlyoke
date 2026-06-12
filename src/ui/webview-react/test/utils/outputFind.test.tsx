import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CliOutput } from "@/types/cliEvents";
import { CLI_EVENT_TYPES } from "@/types/cliEvents";
import { FINAL_STEP_PHASES } from "@/types/messages";
import {
  findOutputMatches,
  highlightText,
} from "@utils/outputFind";
import type { OutputRenderRow } from "@utils/outputRows";

const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function makePromptRow(text: string, key = "prompt-1"): OutputRenderRow {
  return {
    key,
    rowKind: "prompt",
    target,
    text,
    estimateSize: 24,
  };
}

function makePlainResponseRow(text: string, key = "response-1"): OutputRenderRow {
  return {
    key,
    rowKind: "plain-response",
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
    rowKind: "structured-event",
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
    attemptIndex: 0,
    hideDiff: false,
    estimateSize: 48,
  };
}

function makeStructuredToolCallRow(
  name: string,
  result: { success: boolean; output?: string; error?: string },
  key = "tool-1"
): OutputRenderRow {
  return {
    key,
    rowKind: "structured-event",
    target,
    event: {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      data: {
        name,
        parameters: {},
        result,
      },
    },
    eventIndex: 0,
    rawTextOutput: true,
    attemptIndex: 0,
    hideDiff: false,
    estimateSize: 48,
  };
}

function makeStatsRow(key = "stats-1"): OutputRenderRow {
  return {
    key,
    rowKind: "stats",
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

describe("outputFind", () => {
  describe("findOutputMatches", () => {
    it("returns empty for an empty query", () => {
      expect(findOutputMatches([makePromptRow("hello")], "", false)).toEqual([]);
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
        rowKind: "prompt",
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
      expect(findOutputMatches([makePromptRow("hello")], "missing", false)).toEqual(
        []
      );
    });

    it("finds matches in structured bash command rows", () => {
      const matches = findOutputMatches(
        [makeStructuredBashRow("npm run test:ui")],
        "test:ui",
        false
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        rowKind: "structured-event",
        field: "command",
      });
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
        rowKind: "structured-event",
        field: "toolContent",
        start: "read_file".length + 1,
      });
    });

    it("skips non-searchable row kinds", () => {
      const rows: OutputRenderRow[] = [
        {
          key: "history",
          rowKind: "history-banner",
          historyOutputs: {
            orderedEntries: [],
            promptOutputs: {},
            runMetadata: {
              runId: "run-1",
              startedAt: 1,
              executionState: "completed",
            },
          } as never,
          showBackToLive: false,
          estimateSize: 44,
        },
        {
          key: "anchor",
          rowKind: "step-anchor",
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
      render(<>{highlightText("find me", [{ start: 5, end: 7, active: false }])}</>);

      const mark = screen.getByText("me");
      expect(mark.tagName).toBe("MARK");
    });

    it("marks the active match with data-find-active", () => {
      render(
        <>
          {highlightText("find me", [{ start: 5, end: 7, active: true }])}
        </>
      );

      expect(screen.getByText("me")).toHaveAttribute("data-find-active", "true");
    });
  });
});
