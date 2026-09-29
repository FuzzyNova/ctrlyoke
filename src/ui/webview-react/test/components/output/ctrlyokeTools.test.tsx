import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolveCtrlYokeToolView } from "@components/output/ctrlyoke-tools/registry";
import { PostNoteBody } from "@components/output/ctrlyoke-tools/PostNoteView";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  type ToolCallExpansionState,
} from "@utils/toolCallLayout";
import { getOutputRowSearchSegments } from "@utils/outputFind";
import {
  CLI_EVENT_TYPES,
  MCP_SERVER_IDS,
  TOOL_CALL_EXPANSION_SECTIONS,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import type { OutputRenderRow } from "@utils/outputRows";
import { estimatePostNoteHeight } from "@components/output/ctrlyoke-tools/postNoteModel";
import { AppendStepBody } from "@components/output/ctrlyoke-tools/AppendStepView";
import {
  estimateAppendStepHeight,
  parseAppendStepParams,
  parseAppendStepResultText,
} from "@components/output/ctrlyoke-tools/appendStepModel";

const noteResult = {
  success: true,
  output: JSON.stringify({
    text: "**review this** <img src=x onerror=alert(1)>",
    seq: 4,
  }),
};

const appendResult = {
  success: true,
  destination: "queue",
  stepsAdded: 3,
  insertIndex: 4,
  insertedEndIndex: 6,
  placement: { requestedIndex: 2, insertedIndex: 4 },
  parallelGroupsAdded: [
    { id: "group-1", startIndex: 5, endIndex: 6, failFast: false },
  ],
};

describe("ctrlyoke MCP tool views", () => {
  it("parses append_step input and result shapes and falls back on malformed payloads", () => {
    expect(
      parseAppendStepParams({ steps: [{ prompt: "Do it" }], position: "next" })
    ).toEqual({
      steps: [{ prompt: "Do it" }],
      position: "next",
    });
    expect(
      parseAppendStepParams({ steps: [{ name: "missing prompt" }] })
    ).toBeUndefined();
    expect(
      parseAppendStepResultText(JSON.stringify(appendResult))
    ).toMatchObject({
      stepsAdded: 3,
      insertIndex: 4,
      insertedEndIndex: 6,
    });
    expect(parseAppendStepResultText("not json")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "append_step",
        parameters: { steps: [{ prompt: "Do it" }] },
        result: { success: true, output: JSON.stringify(appendResult) },
      })?.summary
    ).toContain("#5");
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "append_step",
        result: { success: true, output: "invalid" },
      })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "append_step",
        result: { success: false, error: "denied" },
      })
    ).toBeUndefined();
  });

  it("renders parameters-omitted and parallel append batches without scope", () => {
    const result = parseAppendStepResultText(
      JSON.stringify({
        ...appendResult,
        scope: { workspace: "hidden" },
      })
    );
    expect(result).toBeDefined();
    const { rerender } = render(
      <AppendStepBody
        params={undefined}
        result={result!}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="append_step"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
      />
    );
    expect(screen.getByText("3 steps at #5–#7")).toBeInTheDocument();
    expect(screen.queryByText(/hidden/)).toBeNull();

    const params = parseAppendStepParams({
      position: "next",
      steps: [
        {
          name: "Prepare",
          harness: "claude-cli",
          model: "sonnet",
          prompt: "Prepare\nDetailed plan",
        },
        {
          parallel: [
            { name: "Audit", harness: "codex-cli", prompt: "Audit" },
            { name: "Test", prompt: "Test" },
          ],
          failFast: false,
        },
      ],
    });
    const onExpansionChange = vi.fn();
    rerender(
      <AppendStepBody
        params={params}
        result={result!}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="append_step"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={onExpansionChange}
      />
    );
    expect(screen.getByText("Prepare")).toBeInTheDocument();
    expect(screen.getByText("Parallel group · #6–#7")).toBeInTheDocument();
    expect(screen.getByText("failFast off")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand prompts" }));
    expect(onExpansionChange).toHaveBeenCalledWith(
      TOOL_CALL_EXPANSION_SECTIONS.APPEND_STEP_PROMPTS,
      true
    );
  });

  it("keeps append_step find text aligned with its rendered rows and estimates both widths", () => {
    const params = parseAppendStepParams({
      position: "next",
      steps: [
        {
          name: "Implement",
          harness: "claude-cli",
          model: "sonnet",
          prompt:
            "Implement the feature with careful validation and update its tests\nThen cover edge cases and failures",
        },
      ],
    })!;
    const result = parseAppendStepResultText(
      JSON.stringify({
        ...appendResult,
        stepsAdded: 1,
        insertIndex: 4,
        insertedEndIndex: 4,
        parallelGroupsAdded: [],
      })
    )!;
    const eventData = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "append_step",
      parameters: {
        position: "next",
        steps: [
          {
            name: "Implement",
            harness: "claude-cli",
            model: "sonnet",
            prompt:
              "Implement the feature with careful validation and update its tests\nThen cover edge cases and failures",
          },
        ],
      },
      result: { success: true, output: JSON.stringify(result) },
    };
    const resolved = resolveCtrlYokeToolView(eventData)!;
    const outputRow: OutputRenderRow = {
      key: "append-step-row",
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      target: { kind: "queue", index: 0 },
      event: { type: CLI_EVENT_TYPES.MCP_TOOL_CALL, data: eventData },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
      estimateSize: 80,
    };
    const { container } = render(
      <AppendStepBody
        params={params}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="append_step"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
      />
    );
    const renderedLine = [...container.querySelectorAll("tbody tr")]
      .map((row) =>
        [...row.querySelectorAll("td")]
          .map((cell) => cell.textContent?.trim())
          .filter(Boolean)
          .join(" ")
      )
      .join("\n");
    expect(renderedLine).toBe(resolved.searchText[1]);
    expect(
      getOutputRowSearchSegments(outputRow).map((segment) => segment.text)
    ).toEqual([resolved.summary, renderedLine]);
    expect(estimateAppendStepHeight(params, result, 280, 13)).toBeGreaterThan(
      estimateAppendStepHeight(params, result, 900, 13)
    );
    expect(
      estimateAppendStepHeight(params, result, 280, 13, true)
    ).toBeGreaterThan(estimateAppendStepHeight(params, result, 280, 13));
  });

  it("resolves only successful known ctrlyoke calls with valid result JSON", () => {
    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "post_note",
      parameters: { text: "note body" },
      result: noteResult,
    };
    expect(resolveCtrlYokeToolView(data)?.summary).toBe("Note → all");
    expect(
      resolveCtrlYokeToolView({
        ...data,
        result: {
          success: true,
          output: JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ text: "wrapped MCP result", seq: 5 }),
              },
            ],
          }),
        },
      })?.searchText[1]
    ).toBe("wrapped MCP result");
    expect(
      resolveCtrlYokeToolView({ ...data, server: "other" })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({ ...data, tool: "unknown" })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        ...data,
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        ...data,
        result: { success: true, output: "not json" },
      })
    ).toBeUndefined();
  });

  it("renders a note from its result alone as safe markdown with an untrusted marker", () => {
    const resolved = resolveCtrlYokeToolView({
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "post_note",
      result: noteResult,
    });
    expect(resolved).toBeDefined();
    const { container } = render(
      <PostNoteBody
        params={undefined}
        result={resolved?.result as { text: string; seq?: number }}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="post_note"
        genericResult={noteResult}
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
      />
    );
    expect(screen.getByText("review this").tagName.toLowerCase()).toBe(
      "strong"
    );
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-untrusted-content='true']")
    ).not.toBeNull();
  });

  it("uses the rendered summary and note text as output-find segments", () => {
    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "post_note",
      parameters: { text: "note body", to: ["reviewer"] },
      result: {
        success: true,
        output: JSON.stringify({ text: "note body", to: ["reviewer"], seq: 1 }),
      },
    };
    const row: OutputRenderRow = {
      key: "note-row",
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      target: { kind: "queue", index: 0 },
      event: { type: CLI_EVENT_TYPES.MCP_TOOL_CALL, data },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
      estimateSize: 80,
    };
    expect(
      getOutputRowSearchSegments(row).map((segment) => segment.text)
    ).toEqual(["Note → reviewer", "note body"]);
  });

  it("Raw is store-controlled and contributes its measured height", () => {
    const onExpansionChange = vi.fn();
    const initial: ToolCallExpansionState = {
      ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
      rawExpanded: false,
    };
    const result = { text: "a note" };
    const { rerender } = render(
      <PostNoteBody
        params={undefined}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="post_note"
        genericResult={noteResult}
        expansion={initial}
        onExpansionChange={onExpansionChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(onExpansionChange).toHaveBeenCalledWith(
      TOOL_CALL_EXPANSION_SECTIONS.RAW,
      true
    );
    rerender(
      <PostNoteBody
        params={undefined}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="post_note"
        genericResult={noteResult}
        expansion={{ ...initial, rawExpanded: true }}
        onExpansionChange={onExpansionChange}
      />
    );
    expect(screen.getByText("MCP: ctrlyoke.post_note")).toBeInTheDocument();
    expect(
      estimatePostNoteHeight(undefined, result, 320, 13, 80)
    ).toBeGreaterThan(estimatePostNoteHeight(undefined, result, 320, 13));
  });
});
