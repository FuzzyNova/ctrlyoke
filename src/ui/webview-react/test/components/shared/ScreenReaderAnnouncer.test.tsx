import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenReaderAnnouncer } from "@components/shared/ScreenReaderAnnouncer";
import { useReadLastResponseKeyHandler } from "@hooks/useReadLastResponseKeyHandler";
import {
  announceAwaitingInput,
  useAnnouncerStore,
} from "@store/announcerStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  OUTPUT_ANNOUNCEMENT_MODES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  type OutputAnnouncementMode,
} from "@root/types/DashboardConstants";
import type { OrderedCliHistoryEntry } from "@root/types/OutputHistoryTypes";

function regionTexts(): string[] {
  return [0, 1].map(
    (slot) =>
      screen.getByTestId(`screen-reader-announcer-${slot}`).textContent ?? ""
  );
}

function setMode(mode: OutputAnnouncementMode) {
  const { globalSettings } = useSettingsStore.getState();
  useSettingsStore.setState({
    globalSettings: {
      ...globalSettings,
      accessibility: {
        outputAnnouncements: mode,
        terminalScreenReaderMode: false,
      },
    },
  });
}

function finishedEntry(text: string): OrderedCliHistoryEntry {
  return {
    kind: OUTPUT_HISTORY_KINDS.CLI,
    timestampMs: 1,
    sequence: 1,
    target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
    attemptIndex: 0,
    cliOutput: {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text } }],
        metadata: {},
      },
    },
  };
}

const PLAN = { type: "prompt", prompt: "p", name: "Plan" } as WorkflowStep;

function KeyHandlerHarness() {
  useReadLastResponseKeyHandler();
  return <ScreenReaderAnnouncer />;
}

beforeEach(() => {
  vi.useFakeTimers();
  useAnnouncerStore.setState({ announcement: null });
  setMode(OUTPUT_ANNOUNCEMENT_MODES.COMPLETIONS);
  useUiStore.getState().resetUi();
  useWorkflowStore.getState().resetWorkflow();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ScreenReaderAnnouncer", () => {
  it("mounts two empty polite live regions", () => {
    render(<ScreenReaderAnnouncer />);
    for (const slot of [0, 1]) {
      const region = screen.getByTestId(`screen-reader-announcer-${slot}`);
      expect(region).toHaveAttribute("aria-live", "polite");
      expect(region).toBeEmptyDOMElement();
    }
  });

  it("alternates regions so a repeated sentence is spoken again", () => {
    render(<ScreenReaderAnnouncer />);
    act(() => useAnnouncerStore.getState().announce("Step 1 completed."));
    expect(regionTexts()).toEqual(["", "Step 1 completed."]);
    act(() => useAnnouncerStore.getState().announce("Step 1 completed."));
    expect(regionTexts()).toEqual(["Step 1 completed.", ""]);
  });

  it("announces store changes after a short delay, never the initial state", () => {
    useWorkflowStore.setState({
      executionState: EXECUTION_STATES.RUNNING,
      steps: [{ ...PLAN, status: STEP_STATUS.RUNNING }],
    });
    render(<ScreenReaderAnnouncer />);
    expect(regionTexts()).toEqual(["", ""]);

    act(() => {
      useWorkflowStore.setState({
        steps: [{ ...PLAN, status: STEP_STATUS.COMPLETED }],
      });
    });
    expect(regionTexts()).toEqual(["", ""]);
    act(() => vi.advanceTimersByTime(300));
    expect(regionTexts().join("")).toBe("Step 1, Plan, completed.");
  });

  it("stays quiet when announcements are off", () => {
    setMode(OUTPUT_ANNOUNCEMENT_MODES.NONE);
    useWorkflowStore.setState({
      executionState: EXECUTION_STATES.RUNNING,
      steps: [{ ...PLAN, status: STEP_STATUS.RUNNING }],
    });
    render(<ScreenReaderAnnouncer />);
    act(() => {
      useWorkflowStore.setState({
        steps: [{ ...PLAN, status: STEP_STATUS.COMPLETED }],
      });
      vi.advanceTimersByTime(300);
    });
    expect(regionTexts()).toEqual(["", ""]);
  });

  it("reads the last response on Alt+L, even with announcements off", () => {
    setMode(OUTPUT_ANNOUNCEMENT_MODES.NONE);
    useWorkflowStore.setState({
      steps: [PLAN],
      liveOrderedEntries: [finishedEntry("# Done\nAll **green**.")],
    });
    render(<KeyHandlerHarness />);

    fireEvent.keyDown(window, { key: "¬", code: "KeyL", altKey: true });

    expect(regionTexts().join("")).toBe(
      "Step 1, Plan, response: Done All green."
    );
  });

  it("announces waiting for input unless announcements are off", () => {
    render(<ScreenReaderAnnouncer />);
    act(() => announceAwaitingInput("refactor - Bash"));
    expect(regionTexts().join("")).toBe("Waiting for input. refactor - Bash");

    setMode(OUTPUT_ANNOUNCEMENT_MODES.NONE);
    act(() => announceAwaitingInput("refactor - Edit"));
    expect(regionTexts().join("")).toBe("Waiting for input. refactor - Bash");
  });

  it("leaves Alt+L to a focused terminal", () => {
    render(
      <>
        <KeyHandlerHarness />
        <div className="xterm">
          <textarea aria-label="Terminal input" />
        </div>
      </>
    );
    fireEvent.keyDown(screen.getByLabelText("Terminal input"), {
      key: "l",
      code: "KeyL",
      altKey: true,
    });
    expect(regionTexts()).toEqual(["", ""]);
  });
});
