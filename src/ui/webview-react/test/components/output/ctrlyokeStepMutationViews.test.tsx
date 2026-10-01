import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MCP_SERVER_IDS } from "@root/types/DashboardConstants";
import {
  MCP_TOOL_DEFINITIONS,
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  type McpToolName,
} from "@root/utils/McpToolDefinitions";
import {
  CTRLYOKE_TOOL_VIEWS,
  resolveCtrlYokeToolView,
} from "@components/output/ctrlyoke-tools/registry";
import {
  EditStepBody,
  RemoveStepBody,
  ReorderStepsBody,
  SubmitCommitMessageBody,
} from "@components/output/ctrlyoke-tools/StepMutationViews";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  estimateGenericToolCallHeight,
} from "@utils/toolCallLayout";
import {
  estimateStepMutationHeight,
  parseEditStepParams,
  parseEditStepResultText,
  parseRemoveStepParams,
  parseRemoveStepResultText,
  parseReorderStepsParams,
  parseReorderStepsResultText,
  parseSubmitCommitMessageParams,
  parseSubmitCommitMessageResultText,
} from "@components/output/ctrlyoke-tools/stepMutationModel";
import type { McpToolCallData } from "../../../types/cliEvents";
import { getOutputRowSearchSegments } from "@utils/outputFind";
import {
  CLI_EVENT_TYPES,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import type { OutputRenderRow } from "@utils/outputRows";

vi.mock("@hooks/useVsCodeApi", () => ({
  getVsCodeApi: () => ({ postMessage: vi.fn() }),
  isStandalone: false,
}));

const editResult = {
  success: true,
  operation: "edit_step",
  changed: true,
  index: 3,
  newQueueSize: 6,
};
const removeResult = {
  success: true,
  operation: "remove_step",
  changed: true,
  index: 3,
  newQueueSize: 5,
};
const reorderResult = {
  success: true,
  operation: "reorder_steps",
  changed: true,
  indices: [2, 0, 1],
  newQueueSize: 6,
};
const commitResult = { success: true, outputPath: "commit-message.txt" };

function data(
  tool: string,
  result: unknown,
  parameters?: Record<string, unknown>,
  server: string = MCP_SERVER_IDS.CTRLYOKE
): McpToolCallData {
  return {
    server,
    tool,
    parameters,
    result: { success: true, output: JSON.stringify(result) },
  };
}

function bodyProps(
  tool: string,
  value: unknown,
  params?: Record<string, unknown>,
  server: string = MCP_SERVER_IDS.CTRLYOKE
) {
  const call = data(tool, value, params, server);
  return {
    params: params,
    result: value,
    data: call,
    expansion: DEFAULT_TOOL_CALL_EXPANSION_STATE,
    onExpansionChange: vi.fn(),
  };
}

function findSegments(
  tool: string,
  value: unknown,
  params?: Record<string, unknown>,
  server: string = MCP_SERVER_IDS.CTRLYOKE
) {
  const call = data(tool, value, params, server);
  const row: OutputRenderRow = {
    key: `${tool}-find`,
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    target: { kind: "queue", index: 0 },
    event: { type: CLI_EVENT_TYPES.MCP_TOOL_CALL, data: call },
    eventIndex: 0,
    rawTextOutput: false,
    hideDiff: false,
    estimateSize: 80,
  };
  return getOutputRowSearchSegments(row).map(({ text }) => text);
}

describe("step mutation ctrlyoke tool views", () => {
  it("registers a view for every published MCP tool", () => {
    const definitionNames = MCP_TOOL_DEFINITIONS.map(({ name }) => name).sort();
    expect(definitionNames).toHaveLength(13);
    expect(Object.keys(CTRLYOKE_TOOL_VIEWS).sort()).toEqual(definitionNames);
    for (const name of definitionNames as McpToolName[])
      expect(CTRLYOKE_TOOL_VIEWS[name]).toBeDefined();
  });

  it("renders edit_step fields and prompt diff without inventing before values", async () => {
    const params = {
      index: 3,
      updates: {
        prompt: "Inspect the CLI exit code\nAdd a regression test",
        model: "gpt-5",
      },
      clearProperties: ["harness"],
    };
    expect(parseEditStepParams(params)).toEqual(params);
    expect(parseEditStepParams({ index: -1, updates: {} })).toBeUndefined();
    expect(parseEditStepResultText(JSON.stringify(editResult))).toMatchObject({
      index: 3,
      clearProperties: [],
    });
    expect(parseEditStepResultText("bad json")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView(data(MCP_EDIT_STEP_TOOL_NAME, editResult, params))
    ).toMatchObject({ summary: "Edited step #4 — prompt, model, harness" });
    expect(
      resolveCtrlYokeToolView(data(MCP_EDIT_STEP_TOOL_NAME, editResult))
        ?.summary
    ).toBe("Edited step #4");
    expect(
      resolveCtrlYokeToolView(data(MCP_EDIT_STEP_TOOL_NAME, {}, params))
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_EDIT_STEP_TOOL_NAME, editResult, params),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    const result = parseEditStepResultText(JSON.stringify(editResult))!;
    const { container: editContainer } = render(
      <EditStepBody {...bodyProps(MCP_EDIT_STEP_TOOL_NAME, result, params)} />
    );
    expect(editContainer.textContent).toContain("model: gpt-5");
    expect(editContainer.textContent).toContain("harness: inherited default");
    expect(
      await screen.findByText("Inspect the CLI exit code")
    ).toBeInTheDocument();
    expect(screen.queryByText(/undefined →/)).toBeNull();
    const resultOnlyEdit = render(
      <EditStepBody
        {...bodyProps(MCP_EDIT_STEP_TOOL_NAME, result, undefined)}
      />
    );
    expect(resultOnlyEdit.container.textContent).toContain("Edited step #4");
    const resolvedEdit = resolveCtrlYokeToolView(
      data(MCP_EDIT_STEP_TOOL_NAME, editResult, params)
    )!;
    expect(findSegments(MCP_EDIT_STEP_TOOL_NAME, editResult, params)).toEqual([
      resolvedEdit.summary,
      ...resolvedEdit.searchText,
    ]);

    const withBefore = parseEditStepResultText(
      JSON.stringify({ ...editResult, before: { model: "gpt-4" } })
    )!;
    const { container: beforeContainer } = render(
      <EditStepBody
        {...bodyProps(MCP_EDIT_STEP_TOOL_NAME, withBefore, {
          index: 3,
          updates: { model: "gpt-5" },
        })}
      />
    );
    expect(beforeContainer.textContent).toContain("model: gpt-4 → gpt-5");
  });

  it("shows edit_step no-op results as warnings without rendering the requested diff", () => {
    const note = "edit_step wrote nothing: values were already current";
    const rawResult = {
      success: true,
      operation: "edit_step",
      changed: false,
      note,
      index: 2,
      updates: { prompt: "unchanged prompt" },
      before: { prompt: "unchanged prompt" },
      clearProperties: [],
    };
    const result = parseEditStepResultText(JSON.stringify(rawResult))!;
    expect(result).toMatchObject({ changed: false, note });
    expect(
      resolveCtrlYokeToolView(
        data(MCP_EDIT_STEP_TOOL_NAME, rawResult, {
          index: 2,
          updates: { prompt: "unchanged prompt" },
        })
      )
    ).toMatchObject({ summary: "No change", warning: true });
    const { container } = render(
      <EditStepBody
        {...bodyProps(MCP_EDIT_STEP_TOOL_NAME, result, {
          index: 2,
          updates: { prompt: "unchanged prompt" },
        })}
      />
    );
    expect(container.textContent).toContain("No change");
    expect(container.textContent).toContain(note);
    expect(container.textContent).not.toContain("Prompt change");
    expect(container.querySelector(".text-warning-fg")).toBeInTheDocument();
  });

  it("renders remove_step as one line and resolves names only when available", () => {
    const params = { index: 3, name: "Fix CLI exit code" };
    expect(parseRemoveStepParams(params)).toEqual(params);
    expect(parseRemoveStepParams({ index: -2 })).toBeUndefined();
    expect(
      parseRemoveStepResultText(JSON.stringify(removeResult))
    ).toMatchObject({ changed: true, index: 3 });
    expect(parseRemoveStepResultText("bad json")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView(
        data(MCP_REMOVE_STEP_TOOL_NAME, removeResult, params)
      )?.summary
    ).toBe("Removed step #4 'Fix CLI exit code'");
    expect(
      resolveCtrlYokeToolView(data(MCP_REMOVE_STEP_TOOL_NAME, removeResult))
        ?.summary
    ).toBe("Removed step #4");
    expect(
      resolveCtrlYokeToolView(data(MCP_REMOVE_STEP_TOOL_NAME, {}, params))
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_REMOVE_STEP_TOOL_NAME, removeResult),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    render(
      <RemoveStepBody
        {...bodyProps(
          MCP_REMOVE_STEP_TOOL_NAME,
          parseRemoveStepResultText(JSON.stringify(removeResult)),
          params
        )}
      />
    );
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
    const resultOnlyRemove = render(
      <RemoveStepBody
        {...bodyProps(
          MCP_REMOVE_STEP_TOOL_NAME,
          parseRemoveStepResultText(JSON.stringify(removeResult)),
          undefined
        )}
      />
    );
    expect(resultOnlyRemove.container.textContent).toContain("Raw");
    expect(
      findSegments(MCP_REMOVE_STEP_TOOL_NAME, removeResult, params)
    ).toEqual([
      resolveCtrlYokeToolView(
        data(MCP_REMOVE_STEP_TOOL_NAME, removeResult, params)
      )!.summary,
    ]);
  });

  it("shows remove_step no-op notes and warning summaries", () => {
    const rawResult = {
      success: true,
      operation: "remove_step",
      changed: false,
      note: "The step was already absent",
      index: 3,
    };
    const result = parseRemoveStepResultText(JSON.stringify(rawResult))!;
    expect(result).toMatchObject({ changed: false, note: rawResult.note });
    expect(
      resolveCtrlYokeToolView(data(MCP_REMOVE_STEP_TOOL_NAME, rawResult))
    ).toMatchObject({ summary: "No change", warning: true });
    const { container } = render(
      <RemoveStepBody
        {...bodyProps(MCP_REMOVE_STEP_TOOL_NAME, result, undefined)}
      />
    );
    expect(container.textContent).toContain("No change");
    expect(container.textContent).toContain(rawResult.note);
  });

  it("renders reorder_steps with before-to-after absolute index pairs", () => {
    const params = { indices: [2, 0, 1] };
    expect(parseReorderStepsParams(params)).toEqual(params);
    expect(parseReorderStepsParams({ indices: [1, "2"] })).toBeUndefined();
    expect(
      parseReorderStepsResultText(JSON.stringify(reorderResult))
    ).toMatchObject({ indices: [2, 0, 1] });
    expect(parseReorderStepsResultText("bad json")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView(
        data(MCP_REORDER_STEPS_TOOL_NAME, reorderResult, params)
      )?.summary
    ).toBe("Reordered 3 steps");
    expect(
      resolveCtrlYokeToolView(data(MCP_REORDER_STEPS_TOOL_NAME, reorderResult))
        ?.summary
    ).toBe("Reordered 3 steps");
    expect(
      resolveCtrlYokeToolView(data(MCP_REORDER_STEPS_TOOL_NAME, {}, params))
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_REORDER_STEPS_TOOL_NAME, reorderResult),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    render(
      <ReorderStepsBody
        {...bodyProps(
          MCP_REORDER_STEPS_TOOL_NAME,
          parseReorderStepsResultText(JSON.stringify(reorderResult)),
          params
        )}
      />
    );
    expect(screen.getByText("#3 → #1")).toBeInTheDocument();
    expect(screen.getByText("#1 → #2")).toBeInTheDocument();
    expect(screen.getByText("#2 → #3")).toBeInTheDocument();
    const resultOnlyReorder = render(
      <ReorderStepsBody
        {...bodyProps(
          MCP_REORDER_STEPS_TOOL_NAME,
          parseReorderStepsResultText(JSON.stringify(reorderResult)),
          undefined
        )}
      />
    );
    expect(resultOnlyReorder.container.textContent).toContain("#3 → #1");
    expect(
      findSegments(MCP_REORDER_STEPS_TOOL_NAME, reorderResult, params)
    ).toEqual([
      resolveCtrlYokeToolView(
        data(MCP_REORDER_STEPS_TOOL_NAME, reorderResult, params)
      )!.summary,
      ...resolveCtrlYokeToolView(
        data(MCP_REORDER_STEPS_TOOL_NAME, reorderResult, params)
      )!.searchText,
    ]);
  });

  it("maps reorder destinations to movable slots after already-started steps", () => {
    const params = { indices: [5, 3, 4] };
    const result = parseReorderStepsResultText(
      JSON.stringify({
        success: true,
        operation: "reorder_steps",
        changed: true,
        indices: [5, 3, 4],
      })
    )!;
    render(
      <ReorderStepsBody
        {...bodyProps(MCP_REORDER_STEPS_TOOL_NAME, result, params)}
      />
    );
    expect(screen.getByText("#6 → #4")).toBeInTheDocument();
    expect(screen.getByText("#4 → #5")).toBeInTheDocument();
    expect(screen.getByText("#5 → #6")).toBeInTheDocument();
    expect(screen.queryByText("#6 → #1")).toBeNull();
  });

  it("shows reorder_steps no-op notes without rendering stale movement pairs", () => {
    const rawResult = {
      success: true,
      operation: "reorder_steps",
      changed: false,
      note: "Order was already current",
      indices: [2, 0, 1],
    };
    const result = parseReorderStepsResultText(JSON.stringify(rawResult))!;
    expect(result).toMatchObject({ changed: false, note: rawResult.note });
    expect(
      resolveCtrlYokeToolView(
        data(MCP_REORDER_STEPS_TOOL_NAME, rawResult, { indices: [2, 0, 1] })
      )
    ).toMatchObject({ summary: "No change", warning: true });
    const { container } = render(
      <ReorderStepsBody
        {...bodyProps(MCP_REORDER_STEPS_TOOL_NAME, result, {
          indices: [2, 0, 1],
        })}
      />
    );
    expect(container.textContent).toContain("No change");
    expect(container.textContent).toContain(rawResult.note);
    expect(screen.queryByText("#3 → #1")).toBeNull();
  });

  it("renders submit_commit_message on both server ids", () => {
    const params = {
      message: "fix: preserve CLI status\n\nExplain why it matters.",
    };
    expect(parseSubmitCommitMessageParams(params)).toEqual(params);
    expect(parseSubmitCommitMessageParams({ message: 1 })).toBeUndefined();
    expect(
      parseSubmitCommitMessageResultText(JSON.stringify(commitResult))
    ).toEqual(commitResult);
    expect(parseSubmitCommitMessageResultText("bad json")).toBeUndefined();
    for (const server of [
      MCP_SERVER_IDS.CTRLYOKE,
      MCP_SERVER_IDS.CTRLYOKE_COMMIT,
    ]) {
      const resolved = resolveCtrlYokeToolView(
        data(MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME, commitResult, params, server)
      );
      expect(resolved?.summary).toBe("fix: preserve CLI status");
      expect(resolved?.searchText).toContain(params.message);
      expect(
        findSegments(
          MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
          commitResult,
          params,
          server
        )
      ).toEqual([resolved!.summary, ...resolved!.searchText]);
      const { container } = render(
        <SubmitCommitMessageBody
          {...bodyProps(
            MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
            parseSubmitCommitMessageResultText(JSON.stringify(commitResult)),
            params,
            server
          )}
        />
      );
      expect(container.querySelector("pre")?.textContent).toBe(params.message);
    }
    const resultOnlyCommit = render(
      <SubmitCommitMessageBody
        {...bodyProps(
          MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
          parseSubmitCommitMessageResultText(JSON.stringify(commitResult)),
          undefined
        )}
      />
    );
    expect(resultOnlyCommit.container.textContent).toContain("Raw");
    expect(
      resolveCtrlYokeToolView(
        data(MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME, commitResult)
      )?.summary
    ).toBe("Submitted commit message");
    expect(
      resolveCtrlYokeToolView(
        data(
          MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
          {},
          params,
          MCP_SERVER_IDS.CTRLYOKE_COMMIT
        )
      )
    ).toBeUndefined();
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME, commitResult, params),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
  });

  it("searches the rendered view text and estimates both narrow and wide layouts", () => {
    const cases = [
      [
        MCP_EDIT_STEP_TOOL_NAME,
        editResult,
        { index: 3, updates: { prompt: "Investigate timeout" } },
      ],
      [
        MCP_REMOVE_STEP_TOOL_NAME,
        removeResult,
        { index: 3, name: "Fix CLI exit code" },
      ],
      [MCP_REORDER_STEPS_TOOL_NAME, reorderResult, { indices: [2, 0, 1] }],
      [
        MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
        commitResult,
        { message: "fix: preserve CLI status\nBody" },
      ],
    ] as const;
    for (const [tool, value, params] of cases) {
      const resolved = resolveCtrlYokeToolView(data(tool, value, params))!;
      expect(resolved.searchText).not.toContain(resolved.summary);
      expect(resolved.searchText.every((visible) => visible.length > 0)).toBe(
        true
      );
      if (tool === MCP_EDIT_STEP_TOOL_NAME)
        expect(resolved.searchText.join("\n")).toContain("Investigate timeout");
      const widthHeights = [280, 900].map((width) =>
        resolved.view.estimateHeight(
          resolved.params,
          resolved.result,
          data(tool, value, params),
          DEFAULT_TOOL_CALL_EXPANSION_STATE,
          width,
          13
        )
      );
      expect(widthHeights[0]).toBeGreaterThan(0);
      expect(widthHeights[1]).toBeGreaterThan(0);
      expect(Math.abs(widthHeights[0] - widthHeights[1])).toBeLessThan(500);
    }
    expect(
      estimateStepMutationHeight(
        undefined,
        parseRemoveStepResultText(JSON.stringify(removeResult))!,
        280,
        13
      )
    ).toBeGreaterThan(0);
    expect(
      estimateGenericToolCallHeight(
        undefined,
        { success: true, output: "{}" },
        DEFAULT_TOOL_CALL_EXPANSION_STATE,
        13,
        280
      )
    ).toBeGreaterThan(0);
  });
});
