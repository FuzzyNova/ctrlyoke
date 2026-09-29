import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolveCtrlYokeToolView } from "@components/output/ctrlyoke-tools/registry";
import { PostNoteBody } from "@components/output/ctrlyoke-tools/PostNoteView";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  buildToolCallRenderPlan,
  type ToolCallExpansionState,
} from "@utils/toolCallLayout";
import {
  getOutputRowSearchSegments,
  OUTPUT_FIND_ACTIVE_ATTRIBUTE,
  OUTPUT_FIND_TOOL_CONTENT_FIELD,
} from "@utils/outputFind";
import {
  CLI_EVENT_TYPES,
  MCP_SERVER_IDS,
  TOOL_CALL_EXPANSION_SECTIONS,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import type { OutputRenderRow } from "@utils/outputRows";
import { OutputRow } from "@components/output/OutputRow";
import { estimatePostNoteHeight } from "@components/output/ctrlyoke-tools/postNoteModel";
import { AppendStepBody } from "@components/output/ctrlyoke-tools/AppendStepView";
import { ClaimPathsBody } from "@components/output/ctrlyoke-tools/ClaimPathsView";
import { ReleasePathsBody } from "@components/output/ctrlyoke-tools/ReleasePathsView";
import { ReadNotesBody } from "@components/output/ctrlyoke-tools/ReadNotesView";
import {
  estimateClaimPathsHeight,
  parseClaimPathsParams,
  parseClaimPathsResultText,
} from "@components/output/ctrlyoke-tools/claimPathsModel";
import {
  estimateReleasePathsHeight,
  parseReleasePathsParams,
  parseReleasePathsResultText,
} from "@components/output/ctrlyoke-tools/releasePathsModel";
import {
  estimateReadNotesHeight,
  parseReadNotesParams,
  parseReadNotesResultText,
} from "@components/output/ctrlyoke-tools/readNotesModel";
import {
  appendStepPromptPreview,
  appendStepSearchText,
  estimateAppendStepHeight,
  parseAppendStepParams,
  parseAppendStepResultText,
} from "@components/output/ctrlyoke-tools/appendStepModel";

vi.mock("@hooks/useVsCodeApi", () => ({
  getVsCodeApi: () => ({ postMessage: vi.fn() }),
  isStandalone: false,
}));

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

const owner = {
  participantId: "participant-reviewer",
  kind: "external" as const,
  label: "reviewer",
  attested: true,
  via: "mcp" as const,
};
const readNotesResult = {
  entries: [
    {
      seq: 7,
      at: "2026-09-29T12:00:00.000Z",
      kind: "note" as const,
      from: owner,
      text: "**Review carefully** <img src=x onerror=alert(1)>",
      via: "mcp" as const,
      untrusted: true,
      attribution: "reviewer",
    },
  ],
  nextCursor: 8,
};

describe("ctrlyoke MCP tool views", () => {
  it("parses claim_paths results, falls back for invalid/error results, and warns on denials", () => {
    const raw = JSON.stringify({
      granted: ["src/a.ts", "src/b.ts"],
      denied: [{ path: "src/c.ts", owner }],
      scope: { should: "not render" },
    });
    expect(parseClaimPathsParams({ paths: ["src/a.ts"] })).toEqual({
      paths: ["src/a.ts"],
    });
    expect(parseClaimPathsParams({ paths: [2] })).toBeUndefined();
    expect(parseClaimPathsResultText(raw)?.denied[0].path).toBe("src/c.ts");
    expect(parseClaimPathsResultText("invalid")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "claim_paths",
        result: { success: true, output: raw },
      })
    ).toMatchObject({ summary: "Claimed 2, 1 denied", warning: true });
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "claim_paths",
        result: { success: true, output: "invalid" },
      })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "claim_paths",
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
  });

  it("parses claim_paths owners that predate participant kinds", () => {
    const raw = JSON.stringify({
      granted: [],
      denied: [
        {
          path: "src/a.ts",
          owner: {
            participantId: "legacy-participant",
            label: "legacy owner",
            attested: true,
            attribution: "legacy owner",
          },
        },
      ],
      claims: [],
    });
    expect(parseClaimPathsResultText(raw)?.denied[0].owner).toMatchObject({
      participantId: "legacy-participant",
      kind: "external",
    });
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "claim_paths",
        result: { success: true, output: raw },
      })
    ).toMatchObject({ summary: "Claimed 0, 1 denied", warning: true });
  });

  it("renders claim_paths from result alone with clickable grants and denial warning styling", () => {
    const result = parseClaimPathsResultText(
      JSON.stringify({
        granted: ["src/file.ts"],
        denied: [{ path: "src/blocked.ts", owner }],
      })
    )!;
    render(
      <ClaimPathsBody
        params={undefined}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="claim_paths"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "src/file.ts" })
    ).toBeInTheDocument();
    expect(screen.getByText(/src\/blocked.ts — denied to/)).toHaveClass(
      "text-warning-fg"
    );
    expect(screen.queryByText(/should not render/)).toBeNull();

    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "claim_paths",
      result: {
        success: true,
        output: JSON.stringify({
          granted: ["src/file.ts"],
          denied: [{ path: "src/blocked.ts", owner }],
        }),
      },
    };
    const expansion = { ...DEFAULT_TOOL_CALL_EXPANSION_STATE };
    const row: OutputRenderRow = {
      key: "claim-warning",
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      target: { kind: "queue", index: 0 },
      event: { type: CLI_EVENT_TYPES.MCP_TOOL_CALL, data },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
      estimateSize: 80,
      toolCall: {
        expansion,
        renderPlan: buildToolCallRenderPlan({
          parameters: undefined,
          result: data.result,
          expansion,
        }),
      },
    };
    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );
    expect(screen.getByText("Claimed 1, 1 denied")).toHaveClass(
      "text-warning-fg"
    );
    expect(
      container.querySelector(".text-indicator-success")
    ).toBeInTheDocument();
  });

  it("keeps claim_paths find text aligned and estimates narrow and wide rows", () => {
    const result = parseClaimPathsResultText(
      JSON.stringify({
        granted: ["src/a-long-filename.ts"],
        denied: [{ path: "src/b.ts", owner }],
      })
    )!;
    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "claim_paths",
      result: { success: true, output: JSON.stringify(result) },
    };
    const resolved = resolveCtrlYokeToolView(data)!;
    const row: OutputRenderRow = {
      key: "claim",
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
    ).toEqual([resolved.summary, ...resolved.searchText]);
    expect(
      estimateClaimPathsHeight(undefined, result, 280, 13)
    ).toBeGreaterThan(estimateClaimPathsHeight(undefined, result, 900, 13));
  });

  it("parses release_paths results, falls back for invalid/error results, and renders from result alone", () => {
    const raw = JSON.stringify({
      released: ["src/a.ts"],
      notHeld: ["src/b.ts"],
      scope: { hidden: true },
    });
    expect(parseReleasePathsParams({ paths: ["src/a.ts"] })).toEqual({
      paths: ["src/a.ts"],
    });
    expect(parseReleasePathsParams({ paths: [false] })).toBeUndefined();
    expect(parseReleasePathsResultText(raw)).toEqual({
      released: ["src/a.ts"],
      notHeld: ["src/b.ts"],
    });
    expect(parseReleasePathsResultText("invalid")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "release_paths",
        result: { success: true, output: raw },
      })?.summary
    ).toBe("Released 1 path");
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "release_paths",
        result: { success: true, output: "invalid" },
      })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "release_paths",
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    render(
      <ReleasePathsBody
        params={undefined}
        result={parseReleasePathsResultText(raw)!}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="release_paths"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "src/a.ts" })
    ).toBeInTheDocument();
    expect(screen.getByText("Not held: src/b.ts")).toHaveClass(
      "text-description-fg"
    );
    expect(screen.queryByText(/hidden/)).toBeNull();
  });

  it("keeps release_paths find text aligned and estimates narrow and wide rows", () => {
    const result = parseReleasePathsResultText(
      JSON.stringify({
        released: ["src/a-long-filename.ts"],
        notHeld: ["src/b.ts"],
      })
    )!;
    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "release_paths",
      result: { success: true, output: JSON.stringify(result) },
    };
    const row: OutputRenderRow = {
      key: "release",
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
    ).toEqual([
      resolveCtrlYokeToolView(data)!.summary,
      ...resolveCtrlYokeToolView(data)!.searchText,
    ]);
    expect(
      estimateReleasePathsHeight(undefined, result, 280, 13)
    ).toBeGreaterThan(estimateReleasePathsHeight(undefined, result, 900, 13));
  });

  it("parses read_notes results, falls back for invalid/error results, and safely renders untrusted markdown", () => {
    const raw = JSON.stringify({ ...readNotesResult, scope: { hidden: true } });
    expect(parseReadNotesParams({ since: 2, from: ["reviewer"] })).toEqual({
      since: 2,
      from: ["reviewer"],
    });
    expect(parseReadNotesParams({ from: [1] })).toBeUndefined();
    expect(parseReadNotesResultText(raw)?.entries).toHaveLength(1);
    expect(parseReadNotesResultText("invalid")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "read_notes",
        result: { success: true, output: raw },
      })?.summary
    ).toBe("Read 1 note");
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "read_notes",
        result: { success: true, output: "invalid" },
      })
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "read_notes",
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    const resolved = resolveCtrlYokeToolView({
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "read_notes",
      result: { success: true, output: raw },
    })!;
    const { container } = render(
      <ReadNotesBody
        params={undefined}
        result={resolved.result as { entries: typeof readNotesResult.entries }}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="read_notes"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
      />
    );
    expect(screen.getByText("Review carefully").tagName.toLowerCase()).toBe(
      "strong"
    );
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-untrusted-content='true']")
    ).not.toBeNull();
    expect(container.textContent).not.toContain("hidden");
  });

  it("renders read_notes pages that mix legacy entries without from.kind", () => {
    const { kind: _kind, ...legacyOwner } = owner;
    const raw = JSON.stringify({
      entries: [
        { ...readNotesResult.entries[0], seq: 9, from: legacyOwner },
        {
          ...readNotesResult.entries[0],
          seq: 125,
          from: { ...owner, kind: "ctrlyoke-step" },
        },
      ],
    });
    const parsed = parseReadNotesResultText(raw);
    expect(parsed?.entries).toHaveLength(2);
    expect(parsed?.entries[0].from.kind).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: "read_notes",
        result: { success: true, output: raw },
      })?.summary
    ).toBe("Read 2 notes");
    expect(
      parseReadNotesResultText(
        JSON.stringify({
          entries: [
            { ...readNotesResult.entries[0], from: { ...owner, kind: 3 } },
          ],
        })
      )
    ).toBeUndefined();
  });

  it("caps a long single-line append_step prompt and offers Expand prompts", () => {
    const longPrompt = `Investigate ${"the flaky retry loop ".repeat(70)}done`;
    const params = parseAppendStepParams({
      steps: [{ name: "Long", prompt: longPrompt }],
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
    const onExpansionChange = vi.fn();
    const { rerender } = render(
      <AppendStepBody
        params={params}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="append_step"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={onExpansionChange}
      />
    );
    const preview = appendStepPromptPreview(
      params.steps[0] as { prompt: string }
    );
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThan(longPrompt.length);
    expect(screen.getByText(preview)).toBeInTheDocument();
    expect(screen.getByText("Workflow default")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand prompts" }));
    expect(onExpansionChange).toHaveBeenCalledWith(
      TOOL_CALL_EXPANSION_SECTIONS.APPEND_STEP_PROMPTS,
      true
    );
    rerender(
      <AppendStepBody
        params={params}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="append_step"
        expansion={{
          ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
          appendStepPromptsExpanded: true,
        }}
        onExpansionChange={onExpansionChange}
      />
    );
    expect(screen.getByText(longPrompt)).toBeInTheDocument();
    expect(appendStepSearchText(params, result)[1]?.endsWith(preview)).toBe(
      true
    );
  });

  it("keeps read_notes find text aligned and estimates narrow and wide rows", () => {
    const raw = JSON.stringify(readNotesResult);
    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "read_notes",
      result: { success: true, output: raw },
    };
    const row: OutputRenderRow = {
      key: "notes",
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
    ).toEqual([
      resolveCtrlYokeToolView(data)!.summary,
      ...resolveCtrlYokeToolView(data)!.searchText,
    ]);
    const result = parseReadNotesResultText(raw)!;
    expect(estimateReadNotesHeight(undefined, result, 280, 13)).toBeGreaterThan(
      estimateReadNotesHeight(undefined, result, 900, 13)
    );
  });

  it("highlights only the matching read_notes entry and preserves active state", () => {
    const entries = [
      { ...readNotesResult.entries[0], seq: 1, text: "first entry" },
      { ...readNotesResult.entries[0], seq: 2, text: "second target entry" },
    ];
    const resolved = resolveCtrlYokeToolView({
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "read_notes",
      result: { success: true, output: JSON.stringify({ entries }) },
    })!;
    const pieces = resolved.searchText;
    const target = "target";
    const start = pieces[1].indexOf(target);
    const { container } = render(
      <ReadNotesBody
        params={undefined}
        result={resolved.result as { entries: typeof entries }}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="read_notes"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
        findQuery={target}
        findCaseSensitive={false}
        bodyFindDecorations={[
          { matches: [] },
          {
            matches: [{ start, end: start + target.length, active: true }],
          },
        ]}
      />
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe(target);
    expect(marks[0]).toHaveAttribute(OUTPUT_FIND_ACTIVE_ATTRIBUTE, "true");
  });

  it("maps append_step body matches to their rendered table cell", () => {
    const params = { steps: [{ name: "CellTarget", prompt: "Do work" }] };
    const result = parseAppendStepResultText(JSON.stringify(appendResult))!;
    const bodyText = resolveCtrlYokeToolView({
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "append_step",
      parameters: params,
      result: { success: true, output: JSON.stringify(appendResult) },
    })!.searchText[0];
    const target = "CellTarget";
    const start = bodyText.indexOf(target);
    const { container } = render(
      <AppendStepBody
        params={params}
        result={result}
        server={MCP_SERVER_IDS.CTRLYOKE}
        tool="append_step"
        expansion={{ ...DEFAULT_TOOL_CALL_EXPANSION_STATE }}
        onExpansionChange={vi.fn()}
        bodyFindMatches={[{ start, end: start + target.length, active: true }]}
      />
    );
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe(target);
    expect(mark).toHaveAttribute(OUTPUT_FIND_ACTIVE_ATTRIBUTE, "true");
  });

  it("keeps raw-result find matches separate and active when Raw is open", () => {
    const parameters = { steps: [{ name: "Step", prompt: "Do work" }] };
    const data = {
      server: MCP_SERVER_IDS.CTRLYOKE,
      tool: "append_step",
      parameters,
      result: { success: true, output: JSON.stringify(appendResult) },
    };
    const expansion = {
      ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
      rawExpanded: true,
    };
    const row: OutputRenderRow = {
      key: "raw-result-row",
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      target: { kind: "queue", index: 0 },
      event: { type: CLI_EVENT_TYPES.MCP_TOOL_CALL, data },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
      estimateSize: 80,
      toolCall: {
        expansion,
        renderPlan: buildToolCallRenderPlan({
          parameters,
          result: data.result,
          expansion,
        }),
      },
    };
    const raw = data.result.output;
    const target = "placement";
    const start =
      getOutputRowSearchSegments(row).find(
        (segment) => segment.field === OUTPUT_FIND_TOOL_CONTENT_FIELD
      )!.start + raw.indexOf(target);
    const { container } = render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        findDecorations={{
          matches: [{ start, end: start + target.length, active: true }],
        }}
      />
    );
    const mark = [...container.querySelectorAll("mark")].find(
      (element) => element.textContent === target
    );
    expect(mark).toBeDefined();
    expect(mark).toHaveAttribute(OUTPUT_FIND_ACTIVE_ATTRIBUTE, "true");
  });

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
    // Name cell and first-line prompt preview both read "Prepare".
    expect(screen.getAllByText("Prepare")).toHaveLength(2);
    expect(screen.getByText("Claude Code / sonnet")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "#" })).toBeVisible();
    expect(screen.queryByText(/·$/)).toBeNull();
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
          .join(" · ")
      )
      .join("\n");
    expect(renderedLine).toBe(resolved.searchText.join("\n"));
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
      })?.searchText[0]
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
