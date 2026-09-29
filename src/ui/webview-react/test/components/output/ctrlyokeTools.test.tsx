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

const noteResult = {
  success: true,
  output: JSON.stringify({
    text: "**review this** <img src=x onerror=alert(1)>",
    seq: 4,
  }),
};

describe("ctrlyoke MCP tool views", () => {
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
