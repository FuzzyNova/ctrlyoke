import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStepContextMenu } from "@hooks/useStepContextMenu";
import { EXECUTION_STATES, STEP_TYPES } from "@/types/messages";
import type { WorkflowStep } from "@store/workflowStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";

function TestHarness({
  step,
  pendingRewind,
}: {
  step: WorkflowStep;
  pendingRewind?: { fromStepIndex: number };
}) {
  const { openContextMenu, contextMenuPortal } = useStepContextMenu({
    isCLIManaged: false,
    canChangeStartPosition: true,
    canPasteStep: true,
    executionState: EXECUTION_STATES.IDLE,
    confirmResetOperations: false,
    totalSteps: 2,
    currentStep: 0,
    pendingRewind,
  });

  return (
    <>
      <button
        onClick={() =>
          openContextMenu(20, 20, {
            step,
            setPositionTarget: 1,
            deleteIndex: 0,
            isCurrentStep: false,
            isExecutionTargetLocked: false,
            direction: "forward",
            outputText: "step output",
          })
        }
      >
        Open menu
      </button>
      {contextMenuPortal}
    </>
  );
}

describe("useStepContextMenu", () => {
  const readText = vi.fn();

  beforeEach(() => {
    useExecutionPreviewStore.getState().reset();
    readText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText,
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the queue-step menu in the required order with dividers", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("button", { name: "Paste Step" })
    ).not.toBeDisabled();

    const labels = screen
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual([
      "Copy Step",
      "Copy Prompt",
      "Copy Output",
      "Dry Run Step",
      "Paste Step",
      "Set Start Position",
      "Disable",
      "Delete",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("switches the content/toggle labels for disabled script steps", () => {
    render(
      <TestHarness
        step={{
          type: STEP_TYPES.SCRIPT,
          script: "echo test",
          enabled: false,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("button", { name: "Paste Step" })
    ).not.toBeDisabled();

    expect(
      screen.getByRole("button", { name: "Copy Script" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("opens a step-scoped Dry Run from the step menu", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Dry Run Step" }));

    expect(useExecutionPreviewStore.getState().scope).toEqual({
      kind: "step",
      stepIndex: 0,
    });
  });

  it("adds discard continuation only at the rewind boundary", () => {
    render(
      <TestHarness
        step={{ prompt: "Boundary prompt" }}
        pendingRewind={{ fromStepIndex: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("button", { name: "Discard Continuation" })
    ).toBeInTheDocument();
  });
});
