import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeaderStatusBanner } from "@components/layout/HeaderStatusBanner";
import type { HeaderStatusBannerProps } from "@components/layout/HeaderStatusBanner";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import {
  RUNNER_IDS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";

const runAddress: WorkflowViewAddress = {
  workflowKey: "workflow-a" as never,
  kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
  runRef: "run-1" as never,
};

function renderBanner(overrides: Partial<HeaderStatusBannerProps> = {}): void {
  const props: HeaderStatusBannerProps = {
    isPausing: false,
    handleCancelPause: vi.fn(),
    isViewingDeletedWorkflow: false,
    viewingDeletedWorkflow: null,
    handleCloseDeletedWorkflow: vi.fn(),
    pendingRewind: null,
    displayedViewAddress: runAddress,
    handleDiscardContinuation: vi.fn(),
    ...overrides,
  };
  render(<HeaderStatusBanner {...props} />);
}

afterEach(cleanup);

beforeEach(() => {
  useUiStore.setState({
    activeWorkflowId: null,
    loadedWorkflows: [],
    viewedLineageIsSystemGenerated: false,
    globalSettingsOpen: false,
    globalSettingsActiveTab: "general",
  });
});

function setLockedLineage({
  managedBy,
  isSystemGenerated = false,
}: {
  managedBy?: (typeof RUNNER_IDS)[keyof typeof RUNNER_IDS];
  isSystemGenerated?: boolean;
}): void {
  useUiStore.setState({
    activeWorkflowId: managedBy ? "active-workflow" : null,
    loadedWorkflows: managedBy
      ? [
          {
            id: "active-workflow",
            externalOwner: { locality: "external", runner: managedBy },
          } as never,
        ]
      : [],
    viewedLineageIsSystemGenerated: isSystemGenerated,
  });
}

describe("HeaderStatusBanner", () => {
  it("renders the pausing banner and calls its cancel action", () => {
    const handleCancelPause = vi.fn();
    renderBanner({ isPausing: true, handleCancelPause });

    expect(
      screen.getByText("Workflow will pause after the current step completes")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pause" }));
    expect(handleCancelPause).toHaveBeenCalledOnce();
  });

  it("renders the deleted-workflow banner and calls its close action", () => {
    const handleCloseDeletedWorkflow = vi.fn();
    renderBanner({
      isViewingDeletedWorkflow: true,
      viewingDeletedWorkflow: {
        workflowKey: "workflow-a" as never,
        workflowName: "Deleted One",
      },
      handleCloseDeletedWorkflow,
    });

    expect(
      screen.getByText('"Deleted One" has been deleted')
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Close deleted workflow" })
    );
    expect(handleCloseDeletedWorkflow).toHaveBeenCalledOnce();
  });

  it("renders the CLI read-only label from the shared external-runner utility", () => {
    setLockedLineage({ managedBy: RUNNER_IDS.CLI });
    renderBanner();

    expect(
      screen.getByText(
        getExternalReadOnlyLabel({
          locality: "external",
          runner: RUNNER_IDS.CLI,
        })!
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the sibling VS Code read-only label from the shared utility", () => {
    setLockedLineage({ managedBy: RUNNER_IDS.VSCODE });
    renderBanner();

    expect(
      screen.getByText(
        getExternalReadOnlyLabel({
          locality: "external",
          runner: RUNNER_IDS.VSCODE,
        })!
      )
    ).toBeInTheDocument();
  });

  it("renders the system-generated read-only label", () => {
    setLockedLineage({ isSystemGenerated: true });
    renderBanner();

    expect(
      screen.getByText(
        "Read-only — managed automatically by commit message generation",
        { exact: false }
      )
    ).toBeInTheDocument();
  });

  it("links the system-generated banner to the commit settings tab", () => {
    setLockedLineage({ isSystemGenerated: true });
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Edit in settings" }));

    expect(useUiStore.getState().globalSettingsActiveTab).toBe("commit");
    expect(useUiStore.getState().globalSettingsOpen).toBe(true);
  });

  it("does not render the settings link for external ownership banners", () => {
    setLockedLineage({ managedBy: RUNNER_IDS.CLI });
    renderBanner();

    expect(
      screen.queryByRole("button", { name: "Edit in settings" })
    ).not.toBeInTheDocument();
  });

  it("renders the rewind banner and calls its discard action", () => {
    const handleDiscardContinuation = vi.fn();
    renderBanner({
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
      handleDiscardContinuation,
    });

    expect(screen.getByText("Continuing run from step 2")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard Continuation" })
    );
    expect(handleDiscardContinuation).toHaveBeenCalledOnce();
  });

  it("gives deleted workflows precedence over locked and transient banners", () => {
    renderBanner({
      isPausing: true,
      isViewingDeletedWorkflow: true,
      viewingDeletedWorkflow: {
        workflowKey: "workflow-a" as never,
        workflowName: "Deleted One",
      },
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
    });

    expect(
      screen.getByText('"Deleted One" has been deleted')
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Workflow will pause after the current step completes")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Continuing run from step 2")
    ).not.toBeInTheDocument();
  });

  it("gives external ownership precedence over system-generated and transient banners", () => {
    setLockedLineage({
      managedBy: RUNNER_IDS.CLI,
      isSystemGenerated: true,
    });
    renderBanner({
      isPausing: true,
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
    });

    expect(
      screen.getByText(
        getExternalReadOnlyLabel({
          locality: "external",
          runner: RUNNER_IDS.CLI,
        })!
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Read-only — managed automatically by commit message generation"
      )
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Workflow will pause after the current step completes")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Continuing run from step 2")
    ).not.toBeInTheDocument();
  });

  it("gives system-generated workflows precedence over transient banners", () => {
    setLockedLineage({ isSystemGenerated: true });
    renderBanner({
      isPausing: true,
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
    });

    expect(
      screen.getByText(
        "Read-only — managed automatically by commit message generation",
        { exact: false }
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Workflow will pause after the current step completes")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Continuing run from step 2")
    ).not.toBeInTheDocument();
  });
});
