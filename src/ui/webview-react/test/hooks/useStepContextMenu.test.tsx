import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStepContextMenu } from "@hooks/useStepContextMenu";
import { EXECUTION_STATES, STEP_TYPES } from "@/types/messages";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { useUiStore } from "@store/uiStore";

function TestHarness({
  step,
  pendingRewind,
  direction = "forward",
  latestOutput,
  runtimeMeta,
}: {
  step: WorkflowStep;
  pendingRewind?: { fromStepIndex: number };
  direction?: "rewind" | "forward";
  latestOutput?: CliOutput | null;
  runtimeMeta?: { sessionId?: string; elapsed?: number };
}) {
  const { openContextMenu, contextMenuPortal } = useStepContextMenu({
    isExternallyManaged: false,
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
            direction,
            outputText: "step output",
            latestOutput,
            runtimeMeta,
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
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    useUiStore.getState().resetUi();
    useExecutionPreviewStore.getState().reset();
    readText.mockReset();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText,
        writeText,
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
      "Copy Metadata",
      "Hide output",
      "Show only this step's output",
      "Dry Run Step",
      "Paste Step",
      "Set Start Position",
      "Move Up",
      "Move Down",
      "Disable",
      "Delete",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(4);
  });

  it("switches the output action to Show output when the step is hidden", () => {
    useUiStore.getState().toggleHiddenOutputTarget("_shell", "queue:0");

    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.queryByRole("button", { name: "Hide output" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show output" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show only this step's output" })
    ).toBeInTheDocument();
  });

  it("disables Move Up at the front of the queue and omits both for a done step", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("button", { name: "Move Up" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move Down" })
    ).not.toBeDisabled();
  });

  it("omits Move Up/Down for a rewind-direction (done) step", () => {
    render(<TestHarness step={{ prompt: "Done prompt" }} direction="rewind" />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.queryByRole("button", { name: "Move Up" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move Down" })
    ).not.toBeInTheDocument();
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

  it("copies resolved execution properties for a pending step with no output yet", async () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const copyMetadataButton = screen.getByRole("button", {
      name: "Copy Metadata",
    });
    expect(copyMetadataButton).not.toBeDisabled();
    fireEvent.click(copyMetadataButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("Prompt step 1");
    expect(copiedText).toContain("Execution properties:");
    expect(copiedText).toContain("harness:");
    expect(copiedText).toContain("model:");
  });

  it("copies the running step's session ID and token/usage data before completion", () => {
    render(
      <TestHarness
        step={{ prompt: "Original prompt" }}
        latestOutput={{
          response: "",
          elapsed: 4.2,
          isStreaming: true,
          tokens: {
            prompt: 1000,
            completion: 500,
            total: 1500,
            cached: 200,
            contextWindowUsed: 12000,
            contextWindowSize: 200000,
            compactionCount: 1,
          },
        }}
        runtimeMeta={{ sessionId: "abc123-session" }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Metadata" }));

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("Session ID: abc123-session");
    expect(copiedText).toContain("Current context window:");
    expect(copiedText).toContain("Attempt total:");
    expect(copiedText).toContain("Compactions: 1");
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
