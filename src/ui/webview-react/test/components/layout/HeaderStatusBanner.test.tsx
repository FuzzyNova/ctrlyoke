import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderStatusBanner } from "@components/layout/HeaderStatusBanner";
import type { HeaderStatusBannerProps } from "@components/layout/HeaderStatusBanner";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

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

  it("preserves the existing pause, deleted, rewind render order", () => {
    renderBanner({
      isPausing: true,
      isViewingDeletedWorkflow: true,
      viewingDeletedWorkflow: {
        workflowKey: "workflow-a" as never,
        workflowName: "Deleted One",
      },
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
    });

    const bannerTexts = [
      screen.getByText("Workflow will pause after the current step completes"),
      screen.getByText('"Deleted One" has been deleted'),
      screen.getByText("Continuing run from step 2"),
    ];
    expect(
      bannerTexts[0].compareDocumentPosition(bannerTexts[1]) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      bannerTexts[1].compareDocumentPosition(bannerTexts[2]) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
