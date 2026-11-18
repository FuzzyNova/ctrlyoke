import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFinalStepContextMenu } from "@hooks/useFinalStepContextMenu";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import {
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  HEADLESS_STEER_DELIVERIES,
  MESSAGE_TYPES,
  OUTPUT_HISTORY_KINDS,
  SESSION_KINDS,
  STEP_STATUS,
  TERMINAL_SESSION_STATUS,
  type FinalStepPhase,
  type StepStatus,
} from "@/types/messages";
import { useTerminalStore } from "@store/terminalStore";
import type {
  OrderedCliHistoryEntry,
  OrderedHistoryEntry,
} from "@root/types/OutputHistoryTypes";
import { generateSingleStepMarkdownExport } from "@utils/markdownExport";

type OutputTarget = Extract<OrderedHistoryEntry, { target: unknown }>["target"];

function cliEntry(
  target: OutputTarget,
  sequence: number,
  prompt?: string
): OrderedCliHistoryEntry {
  return {
    kind: OUTPUT_HISTORY_KINDS.CLI,
    target,
    attemptIndex: 0,
    prompt,
    cliOutput: {
      structured: {
        events: [{ type: "text", data: { text: "r" } }],
        metadata: {},
      },
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
  latestOutput,
  runtimeMeta,
  status,
  phase,
}: {
  finalStep: WorkflowStep | null | undefined;
  isReadOnly?: boolean;
  isDisabled?: boolean;
  latestOutput?: CliOutput | null;
  runtimeMeta?: { sessionId?: string; elapsed?: number };
  status?: StepStatus | null;
  phase?: FinalStepPhase | null;
}) {
  const { openFinalStepContextMenu, finalStepContextMenuPortal } =
    useFinalStepContextMenu({
      finalStep,
      isReadOnly,
      isDisabled,
      onToggleEnabled: vi.fn(),
      latestOutput,
      runtimeMeta,
      status,
      phase,
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
    useEditorStore.getState().resetEditor();
    useSettingsStore.getState().resetSettings();
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
      .getAllByRole("menuitem")
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual([
      "Copy Step",
      "Copy Prompt",
      "Copy Response",
      "Copy Transcript",
      "Copy Metadata",
      "Reply to Step",
      "Hide output",
      "Show only final step output",
      "Disable final step",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(3);
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toBeDisabled();

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
      screen.getByRole("menuitem", { name: "Show output" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Show only final step output" })
    ).toBeInTheDocument();
  });

  it("shows every final-step loop and hides everything else when soloed", () => {
    seedLoopedFinalStepOutput();

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Show only final step output" })
    );

    expect(hiddenKeys()).toEqual(["queue:0", "queue:1"]);
  });

  it("clears the filter when the final step is soloed a second time", () => {
    seedLoopedFinalStepOutput();

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Show only final step output" })
      );
    }

    expect(hiddenKeys()).toEqual([]);
  });

  it("hides and re-shows every final-step loop together", () => {
    seedLoopedFinalStepOutput();

    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide output" }));
    expect(hiddenKeys()).toEqual(["finalStep:0", "finalStep:1"]);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show output" }));
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
      screen.getByRole("menuitem", { name: "Copy Script" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toHaveAttribute("title", "Script steps have no AI session to reply to");
  });

  it("disables Reply to Step when the final step has no session ID", () => {
    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toHaveAttribute("title", "This step has no session to resume yet");
  });

  it("replies with the final-step session in read-only, running, and history views", () => {
    useUiStore.getState().setHistoryView();
    const sessionId = "final-session-456";
    render(
      <TestHarness
        finalStep={{
          prompt: "Final prompt",
          _runtime: { harness: "codex-cli", model: "gpt-5.4", sessionId },
        }}
        isReadOnly
        isDisabled
        runtimeMeta={{ sessionId }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const replyItem = screen.getByRole("menuitem", { name: "Reply to Step" });
    expect(replyItem).toBeEnabled();
    fireEvent.click(replyItem);

    const editor = useEditorStore.getState();
    expect(editor.properties.resumeSession).toBe(true);
    expect(editor.properties.sessionId).toBe(sessionId);
    expect(editor.properties.harness).toBe("codex-cli");
    expect(editor.replyContext).toMatchObject({
      sessionId,
      harness: "codex-cli",
      sourceLabel: "Final step",
    });
  });

  it("disables Copy Response when there is no output yet", () => {
    render(<TestHarness finalStep={{ prompt: "Final prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Copy Response" })
    ).toBeDisabled();
  });

  it("disables Copy Response when the output has no assistant text", () => {
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        latestOutput={{
          structured: { events: [], metadata: {} },
          elapsed: 1,
          isStreaming: false,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Copy Response" })
    ).toBeDisabled();
  });

  it("copies the final step's metadata with a final-step header, not a numbered slot", () => {
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        latestOutput={{
          structured: {
            events: [{ type: "text", data: { text: "final output" } }],
            metadata: {},
          },
          elapsed: 1.2,
          isStreaming: false,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Metadata" }));

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("Final prompt step");
    expect(copiedText).not.toMatch(/step \d/);
  });

  it("copies output text via Copy Response when present", () => {
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        latestOutput={{
          structured: {
            events: [{ type: "text", data: { text: "final output text" } }],
            metadata: {},
          },
          elapsed: 1,
          isStreaming: false,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Response" }));

    expect(writeText).toHaveBeenCalledWith("final output text");
  });

  it("copies the full single-step export from Copy Transcript", () => {
    const latestOutput: CliOutput = {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: [
          {
            type: "bashCommand",
            data: { command: "echo hi", status: "completed", output: "hi" },
          },
        ],
        metadata: {},
      },
    };
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        latestOutput={latestOutput}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Transcript" }));
    expect(writeText).toHaveBeenCalledWith(
      generateSingleStepMarkdownExport(latestOutput, {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        index: 0,
      })
    );
  });

  it("includes the attempt prompt in copied full output markdown", () => {
    const latestOutput: CliOutput = {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: [{ type: "text", data: { text: "final response" } }],
        metadata: {},
      },
    };
    useWorkflowStore.setState({
      liveOrderedEntries: [
        {
          ...cliEntry(
            { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
            1,
            "the final attempt prompt"
          ),
          cliOutput: latestOutput,
        },
      ],
    });
    render(
      <TestHarness
        finalStep={{ prompt: "Final prompt" }}
        latestOutput={latestOutput}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Transcript" }));

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("### Prompt");
    expect(copiedText).toContain("the final attempt prompt");
  });

  it("shows only the enable/disable toggle when there is no final step configured", () => {
    render(<TestHarness finalStep={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const labels = screen
      .getAllByRole("menuitem")
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual(["Disable final step"]);
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
    expect(
      screen.getByRole("menuitem", { name: "Disable final step" })
    ).toBeDisabled();
  });

  describe("live final-step controls", () => {
    const finalStep: WorkflowStep = { prompt: "Summarize" };

    function openFinalHeadlessTarget(
      loopIndex: number,
      canInterruptTurn: boolean
    ) {
      useTerminalStore.getState().updateHeadlessControlTarget({
        type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
        workflowId: "workflow-1",
        controlSessionId: `final-${loopIndex}`,
        stepIndex: -(loopIndex + 1),
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
        canInterruptTurn,
        isOpen: true,
      });
    }

    function renderRunningFinalStep() {
      render(
        <TestHarness
          finalStep={finalStep}
          status={STEP_STATUS.RUNNING}
          phase={FINAL_STEP_PHASES.FINAL_STEP}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    }

    beforeEach(() => {
      useTerminalStore.setState({
        sessions: {},
        activeSessionIds: {},
        headlessControlTargets: {},
      });
      useUiStore.setState({ activeWorkflowId: "workflow-1" });
      // A running final step reports its signed index -(loopIndex + 1).
      useWorkflowStore.setState({
        activeStepIndices: [-2],
        finalStepLoopCount: 1,
      });
    });

    it("omits both items when the final step is not running or live", () => {
      render(<TestHarness finalStep={finalStep} />);
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

      expect(
        screen.queryByRole("menuitem", { name: "Send Steer to Step" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: "End Step Early" })
      ).not.toBeInTheDocument();
    });

    it("steers the editor draft to the running pass", () => {
      openFinalHeadlessTarget(1, true);
      useEditorStore.setState({ promptText: "wrap up" });
      renderRunningFinalStep();

      const labels = screen
        .getAllByRole("menuitem")
        .map((button) => button.textContent?.trim());
      const replyIndex = labels.indexOf("Reply to Step");
      expect(labels.slice(replyIndex, replyIndex + 3)).toEqual([
        "Reply to Step",
        "Send Steer to Step",
        "End Step Early",
      ]);
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Send Steer to Step" })
      );

      expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.SEND_STEER_MESSAGE,
        workflowId: "workflow-1",
        sessionId: "final-1",
        text: "wrap up",
      });
    });

    it("ends the running pass early through its control session", () => {
      openFinalHeadlessTarget(1, true);
      renderRunningFinalStep();

      const endItem = screen.getByRole("menuitem", { name: "End Step Early" });
      expect(endItem).toHaveAttribute(
        "title",
        "Stops final step pass 2's current turn, keeps its output so far, and continues the workflow."
      );
      fireEvent.click(endItem);

      expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.INTERRUPT_HEADLESS_TURN,
        workflowId: "workflow-1",
        sessionId: "final-1",
      });
    });

    it("disables End Step Early without an interruptible session", () => {
      renderRunningFinalStep();

      expect(
        screen.getByRole("menuitem", { name: "End Step Early" })
      ).toBeDisabled();
      expect(
        screen.getByRole("menuitem", { name: "Send Steer to Step" })
      ).toHaveAttribute(
        "title",
        "Final Step Pass 2 has no live harness session"
      );
    });

    it("steers a finished pass's retained terminal", () => {
      useWorkflowStore.setState({ activeStepIndices: [] });
      useTerminalStore.setState({
        sessions: {
          "workflow-1": [
            {
              id: "final-pty",
              workflowId: "workflow-1",
              stepName: "Final step",
              stepIndex: -1,
              kind: SESSION_KINDS.AI_CLI,
              harnessId: HARNESS_IDS.CLAUDE_CLI,
              status: TERMINAL_SESSION_STATUS.RUNNING,
              isController: true,
            },
          ],
        },
      });
      useEditorStore.setState({ promptText: "one more thing" });
      render(<TestHarness finalStep={finalStep} />);
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Send Steer to Step" })
      );

      expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.SEND_STEER_MESSAGE,
        workflowId: "workflow-1",
        sessionId: "final-pty",
        text: "one more thing",
      });
      expect(
        screen.queryByRole("menuitem", { name: "End Step Early" })
      ).not.toBeInTheDocument();
    });
  });
});
