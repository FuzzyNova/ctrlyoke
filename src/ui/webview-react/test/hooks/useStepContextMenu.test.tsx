import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStepContextMenu } from "@hooks/useStepContextMenu";
import { EXECUTION_STATES, STEP_TYPES } from "@/types/messages";
import type { WorkflowStep } from "@store/workflowStore";

function TestHarness({ step }: { step: WorkflowStep }) {
  const { openContextMenu, contextMenuPortal } = useStepContextMenu({
    isCLIManaged: false,
    canChangeStartPosition: true,
    canPasteStep: true,
    executionState: EXECUTION_STATES.IDLE,
    confirmResetOperations: false,
    totalSteps: 2,
    currentStep: 0,
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

  it("renders the queue-step menu in the required order with dividers", async () => {
    readText.mockResolvedValue(JSON.stringify({ prompt: "Pasted step" }));

    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Paste Step" })).not.toBeDisabled()
    );

    const labels = screen
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual([
      "Copy Step",
      "Copy Prompt",
      "Copy Output",
      "Paste Step",
      "Disable",
      "Set Start Position",
      "Delete",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("switches the content/toggle labels for disabled script steps", async () => {
    readText.mockResolvedValue(
      JSON.stringify({ type: STEP_TYPES.SCRIPT, script: "echo pasted" })
    );

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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Paste Step" })).not.toBeDisabled()
    );

    expect(screen.getByRole("button", { name: "Copy Script" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
  });
});
