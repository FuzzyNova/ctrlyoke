import { beforeEach, describe, it, expect } from "vitest";
import { currentWorkflowTitle, routeTitle } from "@/navigation/navTitle";
import {
  EXECUTION_STATES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type {
  RunRef,
  WorkflowKey,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";

describe("routeTitle", () => {
  it("is the bare app name for an empty route", () => {
    expect(routeTitle({})).toBe("ctrlyoke");
  });

  it("names the displayed workflow when no viewer is open", () => {
    expect(routeTitle({}, { name: "Release Notes" })).toBe(
      "Release Notes — ctrlyoke"
    );
  });

  it("adds the run label when the header shows a run badge", () => {
    expect(routeTitle({}, { name: "Release Notes", runLabel: "Run 3" })).toBe(
      "Release Notes - Run 3 — ctrlyoke"
    );
  });

  it("keeps a viewer location's own label over the workflow name", () => {
    expect(
      routeTitle(
        { viewer: "explorer", file: "src/a.ts" },
        { name: "Release Notes", runLabel: "Run 3" }
      )
    ).toBe("a.ts — ctrlyoke");
  });

  it("uses the explorer file basename", () => {
    expect(routeTitle({ viewer: "explorer", file: "src/app/index.ts" })).toBe(
      "index.ts — ctrlyoke"
    );
  });

  it("labels an explorer directory", () => {
    expect(routeTitle({ viewer: "explorer", dir: "src/app" })).toBe(
      "app/ — ctrlyoke"
    );
  });

  it("labels the search tab", () => {
    expect(routeTitle({ viewer: "search" })).toBe("Search — ctrlyoke");
  });

  it("labels a diff file in source control", () => {
    expect(routeTitle({ viewer: "sourceControl", file: "src/a.ts" })).toBe(
      "a.ts (diff) — ctrlyoke"
    );
  });

  it("labels named refs", () => {
    expect(routeTitle({ viewer: "sourceControl", ref: "~staged" })).toBe(
      "Staged Changes — ctrlyoke"
    );
    expect(routeTitle({ viewer: "sourceControl", ref: "~stash:2" })).toBe(
      "Stash #2 — ctrlyoke"
    );
  });

  it("shortens a commit hash ref", () => {
    expect(
      routeTitle({ viewer: "sourceControl", ref: "abcdef1234567890" })
    ).toBe("Commit abcdef1 — ctrlyoke");
  });
});

describe("currentWorkflowTitle", () => {
  const workflowKey = "release-notes" as WorkflowKey;
  const runAddress = (runRef: string): WorkflowViewAddress => ({
    workflowKey,
    kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
    runRef: runRef as RunRef,
  });
  const runSummary = (runRef: string, runId: number): RunSummary => ({
    workflowKey,
    runRef: runRef as RunRef,
    runDirectory: `/runs/${runRef}`,
    runId,
    startedAt: runId,
    executionState: EXECUTION_STATES.COMPLETED,
    definitionRevision: 1,
    stepCount: 1,
    hasMixedHarnesses: false,
    hasMixedModels: false,
  });

  beforeEach(() => {
    useUiStore.setState({
      displayedViewAddress: null,
      runSummaries: [],
      recentWorkflows: [],
      pendingRunViewSwitch: null,
    });
    useWorkflowStore.setState({
      workflowName: "Release Notes",
      fileName: "release-notes.ctrlyoke.yaml",
    });
  });

  it("is undefined until a workflow is displayed", () => {
    expect(currentWorkflowTitle()).toBeUndefined();
  });

  it("uses the human-readable name alone for a single-run workflow", () => {
    useUiStore.setState({
      displayedViewAddress: runAddress("run-a"),
      runSummaries: [runSummary("run-a", 1)],
    });
    expect(currentWorkflowTitle()).toEqual({ name: "Release Notes" });
  });

  it("adds the viewed run's number once the workflow has several runs", () => {
    useUiStore.setState({
      displayedViewAddress: runAddress("run-b"),
      runSummaries: [runSummary("run-a", 1), runSummary("run-b", 2)],
    });
    expect(currentWorkflowTitle()).toEqual({
      name: "Release Notes",
      runLabel: "Run 2",
    });
  });
});
