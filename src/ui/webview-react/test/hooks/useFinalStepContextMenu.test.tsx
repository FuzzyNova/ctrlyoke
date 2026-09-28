import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFinalStepContextMenu } from "@hooks/useFinalStepContextMenu";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { FINAL_STEP_PHASES, OUTPUT_HISTORY_KINDS } from "@/types/messages";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";

type OutputTarget = Extract<OrderedHistoryEntry, { target: unknown }>["target"];

function cliEntry(target: OutputTarget, sequence: number): OrderedHistoryEntry {
  return {
    kind: OUTPUT_HISTORY_KINDS.CLI,
    target,
    attemptIndex: 0,
    cliOutput: {
      prompt: "p",
      response: "r",
      elapsed: 1,
      timestampMs: sequence,
      attemptIndex: 0,
      isStreaming: false,
    },
    timestampMs: sequence,
    sequence,
  };
}

/** Two queue steps, then two final-step loops; the engine is back in the queue. */
function seedLoopedFinalStepOutput() {
  useWorkflowStore.setState({
    liveOrderedEntries: [
      cliEntry({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }, 1),
      cliEntry({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 }, 2),
      cliEntry({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 }, 3),
      cliEntry({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 }, 4),
    ],
    // After a loop appends queue work, loopCount names the *next* loop.
    finalStepLoopCount: 2,
  });
}

function hiddenKeys(): readonly string[] {
  return useUiStore.getState().hiddenOutputTargets._shell?.keys ?? [];
}

function TestHarness({
  finalStep,
  isReadOnly = false,
  isDisabled = false,
  outputText,
  latestOutput,
}: {
  finalStep: WorkflowStep | null | undefined;
  isReadOnly?: boolean;
  isDisabled?: boolean;
  outputText?: string;
  latestOutput?: CliOutput | null;
}) {
  const { openFinalStepContextMenu, finalStepContextMenuPortal } =
    useFinalStepContextMenu({
      finalStep,
      isReadOnly,
      isDisabled,
      onToggleEnabled: vi.fn(),
      outputText,
      latestOutput,
    });

  return (
    <>
      <button onClick={() => openFinalStepContextMenu(20, 20)}>
        Open menu
      </button>
      {finalStepContextMenuPortal}
    </>
  );
}

describe("useFinalStepContextMenu", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useUiStore.getState().resetUi();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(), writeText },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the copy options plus enable/disable, with no queue-only items", () => {
    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const labels = screen
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual([
      "Copy Step",
      "Copy Prompt",
      "Copy Output",
      "Copy Metadata",
      "Hide output",
      "Show only final step output",
      "Disable final step",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(2);

    for (const missing of [
      "Move Up",
      "Move Down",
      "Set Start Position",
      "Paste Step",
      "Delete",
    ]) {
      expect(screen.queryByRole("button", { name: missing })).toBeNull();
    }
  });

  it("switches the output action to Show output when the final step is hidden", () => {
    useUiStore.getState().toggleHiddenOutputTarget("_shell", "finalStep:0");

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.queryByRole("button", { name: "Hide output" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show output" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show only final step output" })
    ).toBeInTheDocument();
  });

  it("shows every final-step loop and hides everything else when soloed", () => {
    seedLoopedFinalStepOutput();

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Show only final step output" })
    );

    expect(hiddenKeys()).toEqual(["queue:0", "queue:1"]);
  });

  it("clears the filter when the final step is soloed a second time", () => {
    seedLoopedFinalStepOutput();

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Show only final step output" })
      );
    }

    expect(hiddenKeys()).toEqual([]);
  });

  it("hides and re-shows every final-step loop together", () => {
    seedLoopedFinalStepOutput();

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide output" }));
    expect(hiddenKeys()).toEqual(["finalStep:0", "finalStep:1"]);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(hiddenKeys()).toEqual([]);
  });

  it("switches the content label for a script final step", () => {
    render(
      <TestHarness
        finalStep={{ type: "script", script: "echo done" } as WorkflowStep}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("button", { name: "Copy Script" })
    ).toBeInTheDocument();
  });

  it("disables Copy Output when there is no output yet", () => {
    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("button", { name: "Copy Output" })).toBeDisabled();
  });

  it("copies the final step's metadata with a final-step header, not a numbered slot", () => {
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        outputText="final output"
        latestOutput={{
          response: "final output",
          elapsed: 1.2,
          isStreaming: false,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Metadata" }));

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("Final prompt step");
    expect(copiedText).not.toMatch(/step \d/);
  });

  it("copies output text via Copy Output when present", () => {
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        outputText="final output text"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));

    expect(writeText).toHaveBeenCalledWith("final output text");
  });

  it("shows only the enable/disable toggle when there is no final step configured", () => {
    render(<TestHarness finalStep={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const labels = screen
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual(["Disable final step"]);
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Disable final step" })
    ).toBeDisabled();
  });
});
