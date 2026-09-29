import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MCP_SERVER_IDS } from "@root/types/DashboardConstants";
import {
  MCP_GLOBAL_STATUS_TOOL_NAME,
  MCP_LIST_HARNESSES_TOOL_NAME,
  MCP_READ_OUTPUT_TOOL_NAME,
  MCP_WORKFLOW_STATUS_TOOL_NAME,
} from "@root/utils/McpToolDefinitions";
import { resolveCtrlYokeToolView } from "@components/output/ctrlyoke-tools/registry";
import { WorkflowStatusBody } from "@components/output/ctrlyoke-tools/WorkflowStatusView";
import { GlobalStatusBody } from "@components/output/ctrlyoke-tools/GlobalStatusView";
import { ReadOutputBody } from "@components/output/ctrlyoke-tools/ReadOutputView";
import { ListHarnessesBody } from "@components/output/ctrlyoke-tools/ListHarnessesView";
import {
  estimateWorkflowStatusHeight,
  parseWorkflowStatusParams,
  parseWorkflowStatusResultText,
  workflowStatusSearchText,
} from "@components/output/ctrlyoke-tools/workflowStatusModel";
import {
  estimateGlobalStatusHeight,
  parseGlobalStatusParams,
  parseGlobalStatusResultText,
  globalStatusSearchText,
} from "@components/output/ctrlyoke-tools/globalStatusModel";
import {
  estimateReadOutputHeight,
  parseReadOutputParams,
  parseReadOutputResultText,
  readOutputSearchText,
} from "@components/output/ctrlyoke-tools/readOutputModel";
import {
  estimateListHarnessesHeight,
  parseListHarnessesParams,
  parseListHarnessesResultText,
  listHarnessesSearchText,
} from "@components/output/ctrlyoke-tools/listHarnessesModel";
import { DEFAULT_TOOL_CALL_EXPANSION_STATE } from "@utils/toolCallLayout";
import type { McpToolCallData } from "../../../types/cliEvents";

vi.mock("@hooks/useVsCodeApi", () => ({
  getVsCodeApi: () => ({ postMessage: vi.fn() }),
  isStandalone: false,
}));

const workflow = {
  workflowKey: "build",
  runRef: "run-1",
  metadata: {
    currentIndex: 2,
    totalSteps: 8,
    completedSteps: 2,
    executionState: "running",
    harness: "claude-cli",
    model: null,
  },
  steps: [
    {
      index: 2,
      prompt: "Write docs\nmore details",
      status: "running",
      model: "sonnet",
    },
  ],
  schemaWarnings: [{ message: "Deprecated field", path: "steps[0]" }],
};
const global = {
  workflowCount: 2,
  workflows: [
    {
      workflowKey: "build",
      runRef: "run-1",
      workflowName: "Build docs",
      executionState: "running",
      harness: "claude-cli",
      model: null,
      currentStep: 3,
      totalSteps: 8,
      completedSteps: 2,
    },
  ],
  truncated: true,
  omittedCount: 1,
};
const readOutput = {
  workflowKey: "build",
  runRef: "run-1",
  outputs: [
    {
      index: 0,
      prompt: "Inspect logs",
      status: "completed",
      responseText: "**Found it** in the output.",
      nextCursor: "25",
    },
    { index: 1, prompt: "Check config", status: "pending", responseText: null },
  ],
};
const harnesses = {
  harnesses: [
    {
      id: "claude-cli",
      displayName: "Claude CLI",
      available: true,
      models: ["sonnet", "opus"],
    },
    {
      id: "codex-cli",
      displayName: "Codex CLI",
      available: true,
      models: ["gpt-5"],
    },
  ],
};

function data(
  tool: string,
  value: unknown,
  parameters?: Record<string, unknown>
): McpToolCallData {
  return {
    server: MCP_SERVER_IDS.CTRLYOKE,
    tool,
    parameters,
    result: { success: true, output: JSON.stringify(value) },
  };
}

const props = (
  tool: string,
  value: unknown,
  parameters?: Record<string, unknown>,
  expansion = DEFAULT_TOOL_CALL_EXPANSION_STATE
) => ({
  params: parameters,
  result: value,
  data: data(tool, value, parameters),
  expansion,
  onExpansionChange: vi.fn(),
});

function expectedTextHeight(
  text: string,
  width: number,
  fontSize: number
): number {
  const charsPerLine = Math.max(20, Math.floor(width / (fontSize * 0.58)));
  return (
    text
      .split("\n")
      .reduce(
        (sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)),
        0
      ) *
    fontSize *
    1.5
  );
}

describe("status and output ctrlyoke tool views", () => {
  it("validates workflow_status, renders progress, step status and schema warnings", () => {
    const raw = JSON.stringify(workflow);
    expect(parseWorkflowStatusParams(undefined)).toBeUndefined();
    expect(parseWorkflowStatusResultText(raw)).toMatchObject({
      metadata: { currentIndex: 2 },
    });
    expect(parseWorkflowStatusResultText("not json")).toBeUndefined();
    expect(
      resolveCtrlYokeToolView(data(MCP_WORKFLOW_STATUS_TOOL_NAME, workflow))
    ).toMatchObject({ summary: "Step 3/8 · running · claude-cli" });
    const resolved = resolveCtrlYokeToolView(
      data(MCP_WORKFLOW_STATUS_TOOL_NAME, workflow)
    );
    expect(resolved?.searchText[1]).toContain("Write docs");
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_WORKFLOW_STATUS_TOOL_NAME, workflow),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    render(
      <WorkflowStatusBody {...props(MCP_WORKFLOW_STATUS_TOOL_NAME, workflow)} />
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25"
    );
    expect(screen.getByText("Write docs")).toBeInTheDocument();
    expect(screen.getByText("Deprecated field")).toBeInTheDocument();
  });

  it("validates and renders global_status state chips and truncation", () => {
    expect(parseGlobalStatusParams(undefined)).toBeUndefined();
    expect(parseGlobalStatusParams({ workflowKey: 2 })).toBeUndefined();
    expect(parseGlobalStatusResultText(JSON.stringify(global))).toBeDefined();
    expect(parseGlobalStatusResultText("{}")).toBeUndefined();
    const resolved = resolveCtrlYokeToolView(
      data(MCP_GLOBAL_STATUS_TOOL_NAME, global)
    );
    expect(resolved?.summary).toBe("2 workflows (1 running)");
    expect(resolved?.searchText[1]).toContain("running · Build docs · build");
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_GLOBAL_STATUS_TOOL_NAME, global),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    render(
      <GlobalStatusBody {...props(MCP_GLOBAL_STATUS_TOOL_NAME, global)} />
    );
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("Truncated · 1 omitted")).toBeInTheDocument();
  });

  it("validates and renders read_output collapsed with store-managed expansion", () => {
    expect(parseReadOutputParams(undefined)).toBeUndefined();
    expect(parseReadOutputParams({ indices: ["one"] })).toBeUndefined();
    expect(parseReadOutputResultText(JSON.stringify(readOutput))).toBeDefined();
    expect(parseReadOutputResultText("invalid")).toBeUndefined();
    const resolved = resolveCtrlYokeToolView(
      data(MCP_READ_OUTPUT_TOOL_NAME, readOutput)
    );
    expect(resolved?.summary).toBe("Read output of steps #1, #2");
    expect(resolved?.searchText[1]).toContain("Found it");
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_READ_OUTPUT_TOOL_NAME, readOutput),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    const onExpansionChange = vi.fn();
    render(
      <ReadOutputBody
        {...props(MCP_READ_OUTPUT_TOOL_NAME, readOutput)}
        onExpansionChange={onExpansionChange}
      />
    );
    expect(screen.queryByText("Found it")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /#1 · Inspect logs/ }));
    expect(onExpansionChange).toHaveBeenCalledWith("readOutputStep:0", true);
    render(
      <ReadOutputBody
        {...props(MCP_READ_OUTPUT_TOOL_NAME, readOutput, undefined, {
          ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
          readOutputExpanded: { "0": true },
        })}
      />
    );
    expect(screen.getByText("Found it")).toBeInTheDocument();
  });

  it("validates and renders all harness availability with models collapsed", () => {
    expect(parseListHarnessesParams(undefined)).toBeUndefined();
    expect(
      parseListHarnessesResultText(JSON.stringify(harnesses))
    ).toBeDefined();
    expect(parseListHarnessesResultText("{}")).toBeUndefined();
    const resolved = resolveCtrlYokeToolView(
      data(MCP_LIST_HARNESSES_TOOL_NAME, harnesses)
    );
    expect(resolved?.summary).toBe("6 harnesses (2 available)");
    expect(resolved?.searchText[1]).toContain("Claude CLI · available");
    expect(
      resolveCtrlYokeToolView({
        ...data(MCP_LIST_HARNESSES_TOOL_NAME, harnesses),
        result: { success: false, error: "failed" },
      })
    ).toBeUndefined();
    render(
      <ListHarnessesBody {...props(MCP_LIST_HARNESSES_TOOL_NAME, harnesses)} />
    );
    expect(screen.getByText(/Claude CLI · available/)).toBeInTheDocument();
    expect(screen.getByText(/opencode-cli · unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("sonnet, opus")).not.toBeInTheDocument();
  });

  it("keeps search text tied to rendered content and estimates heights at narrow and wide widths", () => {
    const cases = [
      {
        result: workflow,
        search: workflowStatusSearchText(undefined, workflow),
        estimate: (width: number) =>
          estimateWorkflowStatusHeight(undefined, workflow, width, 13),
        rendered: "Write docs · claude-cli",
      },
      {
        result: global,
        search: globalStatusSearchText(undefined, global),
        estimate: (width: number) =>
          estimateGlobalStatusHeight(undefined, global, width, 13),
        rendered: "running · Build docs · build",
      },
      {
        result: readOutput,
        search: readOutputSearchText(undefined, readOutput),
        estimate: (width: number) =>
          estimateReadOutputHeight(undefined, readOutput, width, 13),
        rendered: "#1 · Inspect logs · completed",
      },
      {
        result: harnesses,
        search: listHarnessesSearchText(undefined, harnesses),
        estimate: (width: number) =>
          estimateListHarnessesHeight(undefined, harnesses, width, 13),
        rendered: "Claude CLI · available",
      },
    ];
    for (const testCase of cases) {
      expect(testCase.search[1]).toContain(testCase.rendered);
      for (const width of [280, 900]) {
        const measured = expectedTextHeight(testCase.search[1], width, 13);
        expect(Math.abs(testCase.estimate(width) - measured)).toBeLessThan(120);
      }
      const rejected = resolveCtrlYokeToolView({
        server: MCP_SERVER_IDS.CTRLYOKE,
        tool: MCP_WORKFLOW_STATUS_TOOL_NAME,
        result: { success: true, output: "malformed" },
      });
      expect(rejected).toBeUndefined();
    }
  });
});
