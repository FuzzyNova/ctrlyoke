import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateWorkflowDialog } from "@components/workflow/DuplicateWorkflowDialog";
import { createMessageHandlers } from "@hooks/useMessageHandler";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { MESSAGE_TYPES } from "@/types/messages";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";

const postMessageSpy = vi.fn();
const source: WorkflowViewAddress = {
  workflowKey: "workflow-1" as never,
  kind: "run",
  runRef: "run-3" as never,
};

const runSummary = {
  workflowKey: source.workflowKey,
  runRef: source.runRef,
  runDirectory: "/runs/workflow-1/run-3",
  runId: 3,
  startedAt: 1,
  executionState: "completed",
  definitionRevision: 1,
  stepCount: 2,
  hasMixedHarnesses: false,
  hasMixedModels: false,
} as unknown as RunSummary;

function openDialog(invoker: HTMLElement | null = null) {
  act(() => {
    useUiStore
      .getState()
      .openDuplicateWorkflowDialog(
        { source, workflowName: "Workflow 1" },
        invoker
      );
  });
}

beforeEach(() => {
  useUiStore.getState().resetUi();
  useWorkflowStore.getState().resetWorkflow();
  useSettingsStore.getState().resetSettings();
  useUiStore.setState({
    displayedViewAddress: source,
    appliedViewAddress: source,
    runSummaries: [runSummary],
  });
  (
    window.vscodeApi as unknown as { postMessage: typeof postMessageSpy }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

describe("DuplicateWorkflowDialog", () => {
  it("names the displayed non-latest run as the source", () => {
    render(<DuplicateWorkflowDialog />);
    openDialog();
    expect(screen.getByText("Workflow 1 · Run 3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Workflow 1 Copy")).toBeInTheDocument();
  });

  it("blocks submit when the name is empty", () => {
    render(<DuplicateWorkflowDialog />);
    openDialog();
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Workflow name is required"
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT })
    );
  });

  it("keeps the dialog and typed name after a failed request", () => {
    render(<DuplicateWorkflowDialog />);
    openDialog();
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Typed Variant" } });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const request = postMessageSpy.mock.calls[0][0] as { requestId: string };

    act(() => {
      createMessageHandlers()[MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED]({
        type: MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED,
        requestId: request.requestId,
        error: "Could not create variant",
      });
    });

    expect(screen.getByDisplayValue("Typed Variant")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not create variant"
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("refreshes and navigates only this client after success", () => {
    render(<DuplicateWorkflowDialog />);
    openDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New Variant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const request = postMessageSpy.mock.calls[0][0] as { requestId: string };
    const newAddress: WorkflowViewAddress = {
      workflowKey: "workflow-2" as never,
      kind: "draft",
    };

    act(() => {
      createMessageHandlers()[MESSAGE_TYPES.WORKFLOW_VARIANT_CREATED]({
        type: MESSAGE_TYPES.WORKFLOW_VARIANT_CREATED,
        requestId: request.requestId,
        address: newAddress,
      });
    });

    expect(useUiStore.getState().duplicateWorkflowDialogOpen).toBe(false);
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS,
    });
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_RUN_VIEW,
      address: newAddress,
      requestId: expect.any(String),
    });
    expect(useUiStore.getState().toastQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Created workflow "New Variant"' }),
      ])
    );
  });

  it("restores focus to the invoking control when closed", () => {
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    render(<DuplicateWorkflowDialog />);
    openDialog(invoker);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });
});
