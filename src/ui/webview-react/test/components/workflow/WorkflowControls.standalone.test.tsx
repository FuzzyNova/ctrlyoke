import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

import { WorkflowControls } from "@components/workflow/WorkflowControls";
import {
  APPEND_MODES,
  MESSAGE_TYPES,
  QUEUE_POSITION,
  SUB_WORKFLOW_QUEUE_LABELS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";

const postMessage = vi.fn();

describe("WorkflowControls bundle load choice in hosted mode", () => {
  beforeEach(() => {
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });
  afterEach(cleanup);

  it("offers run import from a selected bundle workflow", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<WorkflowControls />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    fireEvent.click(screen.getByRole("option", { name: /Load from File/i }));
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "runs/demo.ctrlyokerun/workflow.ctrlyoke.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load File" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.REQUEST_RUN_IMPORT_PREVIEW,
        bundleDir: "runs/demo.ctrlyokerun",
      })
    );
  });

  it("loads only the authored workflow when run import is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<WorkflowControls />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    fireEvent.click(screen.getByRole("option", { name: /Load from File/i }));
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "runs/demo.ctrlyokerun/workflow.ctrlyoke.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load File" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: "runs/demo.ctrlyokerun/workflow.ctrlyoke.json",
    });
  });

  it("queues a picked file onto the view Queue from File was chosen on", () => {
    useWorkflowStore.setState({ fileName: "/path/to/workflow.yaml" });
    const chosenOn = {
      workflowKey: "workflow-1" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-1" as never,
    };
    useUiStore.setState({
      displayedViewAddress: chosenOn,
      displayedDefinitionRevision: 3,
      displayedDescriptorRevision: 5,
    });
    render(<WorkflowControls />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    fireEvent.click(
      screen.getByRole("option", { name: /Append and Continue from File/i })
    );
    expect(postMessage).not.toHaveBeenCalled();

    // The user switches workflows while the modal is open.
    act(() => {
      useUiStore.setState({
        displayedViewAddress: {
          workflowKey: "workflow-2" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-9" as never,
        },
        displayedDefinitionRevision: 11,
        displayedDescriptorRevision: 12,
      });
    });
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "flows/steps.ctrlyoke.yaml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue File" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath: "flows/steps.ctrlyoke.yaml",
      mutation: {
        address: chosenOn,
        expectedDefinitionRevision: 3,
        expectedDescriptorRevision: 5,
      },
    });
    useUiStore.setState({
      displayedViewAddress: null,
      displayedDefinitionRevision: null,
      displayedDescriptorRevision: null,
    });
  });

  it("queues a picked file as a sub-workflow", () => {
    useWorkflowStore.setState({ fileName: "/path/to/workflow.yaml" });
    render(<WorkflowControls />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    fireEvent.click(
      screen.getByRole("option", {
        name: SUB_WORKFLOW_QUEUE_LABELS.queueAsSubWorkflow,
      })
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(
      screen.getByText(SUB_WORKFLOW_QUEUE_LABELS.pickerTitle)
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "flows/verify.ctrlyoke.yaml" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: SUB_WORKFLOW_QUEUE_LABELS.pickerAction,
      })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath: "flows/verify.ctrlyoke.yaml",
      appendMode: APPEND_MODES.SUB_WORKFLOW,
      position: QUEUE_POSITION.END,
    });
  });
});
