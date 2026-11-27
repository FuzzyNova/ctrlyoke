import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepsPanel } from "@components/layout/WorkflowStepsPanel";
import { StepChipRail } from "@components/steps/StepChipRail";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import {
  HARNESS_CHART_COLORS,
  HARNESS_IDS,
  OUTPUT_ACTIVITY_KINDS,
  STEP_COLOR_MODES,
  STEP_TYPES,
  SUB_WORKFLOW_DASHBOARD_LABELS,
  WORKTREE_MODES,
  getHarnessDisplayName,
  type HarnessId,
} from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { mapOrderedHistoryEntriesToMessages } from "@utils/outputProjection";
import { buildOutputRows } from "@utils/outputRows";

const WORKFLOW_HARNESS = HARNESS_IDS.CLAUDE_CLI;
const GLOBAL_HARNESS = HARNESS_IDS.COPILOT_CLI;
const LANE_HARNESS = HARNESS_IDS.CODEX_CLI;

function lane(
  prompt: string,
  inner: Record<string, unknown> = {},
  runtime?: Record<string, unknown>
): WorkflowStep {
  return {
    type: STEP_TYPES.WORKFLOW,
    workflow: {
      prompt,
      ...inner,
      worktree: { mode: WORKTREE_MODES.MANAGED },
    },
    ...(runtime ? { _runtime: runtime } : {}),
  } as WorkflowStep;
}

const scriptLane = {
  type: STEP_TYPES.WORKFLOW,
  workflow: {
    type: STEP_TYPES.SCRIPT,
    script: "npm test",
    worktree: { mode: WORKTREE_MODES.MANAGED },
  },
} as WorkflowStep;

function loadSteps(steps: WorkflowStep[]) {
  useWorkflowStore.getState().loadWorkflow({
    fileName: "lanes.ctrlyoke.yaml",
    steps,
  });
}

function setSettings(workflowHarness?: HarnessId, workflowModel?: string) {
  const settings = useSettingsStore.getState();
  settings.setGlobalSettings({
    ...settings.globalSettings,
    harness: GLOBAL_HARNESS,
    model: "global-model",
    harnessDefaultModels: {
      [GLOBAL_HARNESS]: "copilot-default",
      [WORKFLOW_HARNESS]: "claude-default",
      [LANE_HARNESS]: "codex-default",
    },
    stepColorMode: STEP_COLOR_MODES.HARNESS,
  });
  settings.setWorkflowProperties({
    ...(workflowHarness ? { harness: workflowHarness } : {}),
    ...(workflowModel ? { model: workflowModel } : {}),
  });
}

function row(index: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-workflow-step-index="${index}"]`
  );
  if (!element) throw new Error(`No row ${index}`);
  return element;
}

/** The 2px identity rail is the frame's first column. */
function railColor(index: number): string {
  return (row(index).firstElementChild as HTMLElement).style.backgroundColor;
}

function chipColor(index: number): string {
  const bar = document.querySelector<HTMLElement>(
    `[data-workflow-chip-index="${index}"] [data-chip-identity-bar]`
  );
  if (!bar) throw new Error(`No chip ${index}`);
  return bar.style.backgroundColor;
}

/** jsdom normalizes inline colours to rgb(); compare in that form. */
function asStyleColor(color: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
}

function outputRowColor(steps: WorkflowStep[], index: number) {
  const allMessages = mapOrderedHistoryEntriesToMessages(
    [],
    [
      {
        timestampMs: 1000,
        sequence: 1,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: index },
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "lane output",
      },
    ]
  );
  const result = buildOutputRows({
    allMessages,
    steps,
    finalStep: null,
    effectiveHarness: useSettingsStore.getState().getEffectiveHarness(),
    stepColorMode: STEP_COLOR_MODES.HARNESS,
    harnessColorSettings:
      useSettingsStore.getState().globalSettings.harnessColors,
    streamingChunks: {},
    finalStepStreamingChunks: {},
    isExecutionActive: false,
    showChangeActions: false,
    isViewingHistory: false,
    historyOutputs: null,
    workspaceSnapshots: {},
    finalStepWorkspaceSnapshots: {},
    undoRecords: {},
    diffCollapseState: new Map(),
    diffExpansionState: new Map(),
    toolCallExpansionState: new Map(),
    defaultDiffCollapsed: false,
  });
  return result.rows.find((candidate) => candidate.stepColor)?.stepColor;
}

describe("WorkflowStepsPanel lane rows", () => {
  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useEditorStore.getState().resetEditor();
    useSettingsStore.getState().resetSettings();
    useUiStore.getState().resetUi();
    useUiStore.setState({
      stepsCollapsed: false,
      loadedWorkflows: [],
      isViewingHistory: false,
    });
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: {
        postMessage: vi.fn(),
        getState: vi.fn(() => null),
        setState: vi.fn(),
      },
    });
  });

  afterEach(cleanup);

  it("resolves a lane's harness and model inner step, then workflow, then global", () => {
    loadSteps([
      lane("Own harness", { harness: LANE_HARNESS }),
      lane("Workflow harness"),
      lane("Own model", { model: "lane-model" }),
    ]);
    setSettings(WORKFLOW_HARNESS, "workflow-model");

    render(<WorkflowStepsPanel />);

    // The inner step's harness wins, and its model is scoped to that
    // harness: the harness default, never the workflow's model.
    const own = within(row(0));
    expect(own.getByText(getHarnessDisplayName(LANE_HARNESS))).toBeVisible();
    expect(own.getByText("codex-default")).toBeVisible();
    expect(own.queryByText("workflow-model")).toBeNull();

    const inherited = within(row(1));
    expect(
      inherited.getByText(getHarnessDisplayName(WORKFLOW_HARNESS))
    ).toBeVisible();
    expect(inherited.getByText("workflow-model")).toBeVisible();

    expect(within(row(2)).getByText("lane-model")).toBeVisible();
  });

  it("falls back to the global harness and its default model", () => {
    loadSteps([lane("Global harness")]);
    setSettings();

    render(<WorkflowStepsPanel />);

    const inherited = within(row(0));
    expect(
      inherited.getByText(getHarnessDisplayName(GLOBAL_HARNESS))
    ).toBeVisible();
    expect(inherited.getByText("copilot-default")).toBeVisible();
  });

  it("gives an inline script lane no harness line", () => {
    loadSteps([scriptLane]);
    setSettings(WORKFLOW_HARNESS, "workflow-model");

    render(<WorkflowStepsPanel />);

    const script = within(row(0));
    expect(script.getByText("npm test")).toBeVisible();
    expect(
      script.queryByText(getHarnessDisplayName(WORKFLOW_HARNESS))
    ).toBeNull();
    expect(script.queryByText("workflow-model")).toBeNull();
  });

  it("marks a started lane's harness and model as expected", () => {
    loadSteps([
      lane("Started", {}, { childWorkflowKey: "child", childRunRef: "run-1" }),
      lane("Pending"),
    ]);
    setSettings(WORKFLOW_HARNESS, "workflow-model");

    render(<WorkflowStepsPanel />);

    const started = within(row(0));
    expect(
      started.getByText(`(${SUB_WORKFLOW_DASHBOARD_LABELS.expected})`)
    ).toBeVisible();
    expect(
      started.getByTitle(SUB_WORKFLOW_DASHBOARD_LABELS.expectedHarnessTitle)
    ).toBeVisible();
    expect(started.queryByText("(default)")).toBeNull();

    const pending = within(row(1));
    expect(
      pending.queryByText(`(${SUB_WORKFLOW_DASHBOARD_LABELS.expected})`)
    ).toBeNull();
    expect(pending.getAllByText("(default)").length).toBeGreaterThan(0);
  });

  it("colours a lane by the same harness in the steps list, chip rail and output", () => {
    const steps = [
      lane("Own harness", { harness: LANE_HARNESS }),
      lane("Workflow harness"),
      scriptLane,
    ];
    loadSteps(steps);
    setSettings(WORKFLOW_HARNESS);
    const loaded = useWorkflowStore.getState().steps;

    const indices = [0, 1, 2];

    const panel = render(<WorkflowStepsPanel />);
    const rails = indices.map(railColor);
    panel.unmount();

    // The chip rail is coloured alike whether or not the panel hands it its
    // resolver.
    const chips = render(<StepChipRail onExpand={vi.fn()} />);
    const chipColors = indices.map(chipColor);
    chips.unmount();

    const outputs = indices.map((index) =>
      asStyleColor(outputRowColor(loaded, index) ?? "")
    );

    expect(rails.slice(0, 2)).toEqual([
      asStyleColor(HARNESS_CHART_COLORS[LANE_HARNESS]),
      asStyleColor(HARNESS_CHART_COLORS[WORKFLOW_HARNESS]),
    ]);
    expect(chipColors).toEqual(rails);
    expect(outputs).toEqual(rails);
    // An inline script has no harness, so it is not painted as one.
    expect(rails[2]).not.toBe(rails[1]);
  });
});
