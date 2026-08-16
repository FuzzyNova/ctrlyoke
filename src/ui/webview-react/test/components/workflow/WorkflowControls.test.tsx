/**
 * Tests for WorkflowControls.
 *
 * WorkflowControls depends on:
 *   - workflowStore (fileName, prompts)
 *   - useVsCodeApi (postMessage)
 *
 * Strategy: set store state before each test, assert postMessage calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowControls } from "@components/workflow/WorkflowControls";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";

// The vscode mock is set up in test/setup.ts (window.vscodeApi).
// We just need a reference to the postMessage spy.
const postMessageSpy = vi.fn();

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useUiStore.setState({
    displayedViewAddress: null,
    displayedDefinitionRevision: null,
    displayedDescriptorRevision: null,
  });
  // Reset the vscodeApi mock on each test
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

describe("WorkflowControls — New button", () => {
  it("renders a 'New' button", () => {
    render(<WorkflowControls />);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("posts CLEAR_WORKFLOW when 'New' button clicked", async () => {
    const user = userEvent.setup();
    render(<WorkflowControls />);
    await user.click(screen.getByRole("button", { name: /New/i }));
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW,
    });
  });
});

describe("WorkflowControls — dropdown options", () => {
  it("opens the dropdown", async () => {
    const user = userEvent.setup();
    render(<WorkflowControls />);
    // The split button dropdown toggle — labeled with dropdownAriaLabel
    const dropdownToggle = screen.getByRole("button", {
      name: /Open workflow menu/i,
    });
    await user.click(dropdownToggle);
    expect(screen.getByText(/New From Template/i)).toBeInTheDocument();
    expect(screen.getByText(/Load from File/i)).toBeInTheDocument();
  });

  it("posts NEW_WORKFLOW when 'New From Template' clicked", async () => {
    const user = userEvent.setup();
    render(<WorkflowControls />);
    await user.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    await user.click(screen.getByText(/New From Template/i));
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.NEW_WORKFLOW,
    });
  });

  it("posts SELECT_FILE when 'Load from File' clicked", async () => {
    const user = userEvent.setup();
    render(<WorkflowControls />);
    await user.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    await user.click(screen.getByText(/Load from File/i));
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SELECT_FILE,
    });
  });

  it("'Queue from File' is disabled when no workflow is loaded", async () => {
    const user = userEvent.setup();
    render(<WorkflowControls />);
    await user.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    const queueItem = screen
      .getByText(/Queue from File/i)
      .closest("button, [role='option'], li");
    // The SplitButton option with disabled:true should render as disabled
    expect(queueItem).toBeDisabled();
  });

  it("posts APPEND_FILE when 'Queue from File' clicked with a loaded workflow", async () => {
    const user = userEvent.setup();
    // Set a fileName so hasQueue = true
    useWorkflowStore.setState({ fileName: "/path/to/workflow.yaml" });
    render(<WorkflowControls />);
    await user.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    await user.click(screen.getByText(/Queue from File/i));
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
    });
  });

  it("labels the option 'Append and Continue from File...' and attaches the run mutation when a promoted run is displayed", async () => {
    const user = userEvent.setup();
    useWorkflowStore.setState({ fileName: "/path/to/workflow.yaml" });
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 2,
      displayedDescriptorRevision: 5,
    });
    render(<WorkflowControls />);
    await user.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    expect(
      screen.getByText(/Append and Continue from File/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Queue from File/i)).not.toBeInTheDocument();

    await user.click(screen.getByText(/Append and Continue from File/i));
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      mutation: {
        address: {
          workflowKey: "wf-1",
          kind: "run",
          runRef: "run-1",
        },
        expectedDefinitionRevision: 2,
        expectedDescriptorRevision: 5,
      },
    });
  });

  it("restores focus to the split-button dropdown trigger after Duplicate", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "draft",
      },
    });
    render(<WorkflowControls />);
    const trigger = screen.getByRole("button", { name: /Open workflow menu/i });
    await user.click(trigger);
    await user.click(screen.getByText(/Duplicate Workflow/i));

    expect(useUiStore.getState().duplicateWorkflowDialogData?.invoker).toBe(
      trigger
    );
    act(() => useUiStore.getState().closeDuplicateWorkflowDialog());
    expect(document.activeElement).toBe(trigger);
  });
});
