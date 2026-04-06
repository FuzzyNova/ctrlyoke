/**
 * Tests for useMessageHandler — the single entry point for all messages
 * from the VS Code extension into the webview.
 *
 * Strategy: dispatch real window MessageEvents, assert store state mutations.
 * Each test resets all stores to a clean state so tests are independent.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMessageHandler } from "@hooks/useMessageHandler";
import { useWorkflowStore } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { MESSAGE_TYPES, EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import type { PromptStep } from "@/types/messages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatch(type: string, payload: Record<string, unknown> = {}) {
  window.dispatchEvent(
    new MessageEvent("message", { data: { type, ...payload } })
  );
}

function makePrompt(
  prompt: string,
  overrides: Partial<PromptStep> = {}
): PromptStep {
  return { prompt, ...overrides };
}

// ---------------------------------------------------------------------------
// Reset all stores before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useEditorStore.getState().resetEditor();
});

// ---------------------------------------------------------------------------
// FILE_SELECTED — bootstraps the UI with a new workflow
// ---------------------------------------------------------------------------

describe("FILE_SELECTED", () => {
  it("loads the workflow into workflowStore", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.flightpath.yaml",
        workflowName: "My Workflow",
        steps: [makePrompt("Step 1"), makePrompt("Step 2")],
      });
    });

    const wf = useWorkflowStore.getState();
    expect(wf.fileName).toBe("test.flightpath.yaml");
    expect(wf.workflowName).toBe("My Workflow");
    expect(wf.steps).toHaveLength(2);
    expect((wf.steps[0] as any).prompt).toBe("Step 1");
  });

  it("marks settingsStore.workflowLoaded = true", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.flightpath.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useSettingsStore.getState().workflowLoaded).toBe(true);
  });

  it("marks editorStore.hasActiveQueue = true", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.flightpath.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useEditorStore.getState().hasActiveQueue).toBe(true);
  });

  it("clears history view when a new workflow is loaded", () => {
    // Prime history state
    useUiStore.getState().setHistoryView(1, 3);

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "new.flightpath.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useUiStore.getState().isViewingHistory).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INIT — initial state from extension on webview open
// ---------------------------------------------------------------------------

describe("INIT", () => {
  it("loads workflow when prompts are provided", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.INIT, {
        data: {
          fileName: "init.flightpath.yaml",
          workflowName: "Init Workflow",
          steps: [makePrompt("Init Step")],
          executionState: EXECUTION_STATES.IDLE,
        },
      });
    });

    expect(useWorkflowStore.getState().fileName).toBe("init.flightpath.yaml");
    expect(useWorkflowStore.getState().steps).toHaveLength(1);
  });

  it("updates global settings", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.INIT, {
        data: {
          globalSettings: {
            harness: "claude-cli",
            model: "claude-opus-4",
            harnessDefaultModels: {},
            harnessDefaultAdditionalArgs: {},
            agent: "",
            skills: [],
            executionMode: "headless",
            resumeSession: false,
            mcpServers: [],
            hooks: [],
            respectGitignore: true,
            confirmDeleteOperations: true,
            confirmResetOperations: true,
            priorContext: "none",
          },
        },
      });
    });

    expect(useSettingsStore.getState().globalSettings.harness).toBe(
      "claude-cli"
    );
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_STATE_CHANGED
// ---------------------------------------------------------------------------

describe("EXECUTION_STATE_CHANGED", () => {
  it("updates workflowStore executionState to RUNNING", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STATE_CHANGED, {
        state: EXECUTION_STATES.RUNNING,
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.RUNNING
    );
  });

  it("updates to PAUSED", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STATE_CHANGED, {
        state: EXECUTION_STATES.PAUSED,
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.PAUSED
    );
  });

  it("updates to STOPPED", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STATE_CHANGED, {
        state: EXECUTION_STATES.STOPPED,
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.STOPPED
    );
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_COMPLETED
// ---------------------------------------------------------------------------

describe("EXECUTION_COMPLETED", () => {
  it("sets executionState to COMPLETED", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_COMPLETED);
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.COMPLETED
    );
  });
});

// ---------------------------------------------------------------------------
// PROGRESS_UPDATE
// ---------------------------------------------------------------------------

describe("PROGRESS_UPDATE", () => {
  it("updates currentStep and totalSteps", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.PROGRESS_UPDATE, { current: 2, total: 5 });
    });

    expect(useWorkflowStore.getState().currentStep).toBe(2);
    expect(useWorkflowStore.getState().totalSteps).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// STEP_STATUS_CHANGED
// ---------------------------------------------------------------------------

describe("STEP_STATUS_CHANGED", () => {
  it("updates the status of the targeted step only", () => {
    // Load a workflow first so prompts array is populated
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [
          makePrompt("Step 0"),
          makePrompt("Step 1"),
          makePrompt("Step 2"),
        ],
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.STEP_STATUS_CHANGED, {
        stepIndex: 1,
        status: { state: STEP_STATUS.COMPLETED },
      });
    });

    const prompts = useWorkflowStore.getState().steps;
    expect((prompts[0] as any).status).toBe(STEP_STATUS.PENDING);
    expect((prompts[1] as any).status).toBe(STEP_STATUS.COMPLETED);
    expect((prompts[2] as any).status).toBe(STEP_STATUS.PENDING);
  });

  it("accepts a plain string status (not wrapped in state object)", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0")],
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.STEP_STATUS_CHANGED, {
        stepIndex: 0,
        status: STEP_STATUS.RUNNING,
      });
    });

    expect((useWorkflowStore.getState().steps[0] as any).status).toBe(
      STEP_STATUS.RUNNING
    );
  });
});

// ---------------------------------------------------------------------------
// RETRY_ATTEMPT_CHANGED
// ---------------------------------------------------------------------------

describe("RETRY_ATTEMPT_CHANGED", () => {
  it("stores retry state in workflowStore", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED, {
        stepIndex: 0,
        currentRetry: 1,
        maxRetries: 3,
      });
    });

    expect(useWorkflowStore.getState().retryStates[0]).toEqual({
      currentRetry: 1,
      maxRetries: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// STEPS_EXTENDED — dynamic queue extension
// ---------------------------------------------------------------------------

describe("STEPS_EXTENDED", () => {
  it("extends the prompts array", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.STEPS_EXTENDED, {
        steps: [
          makePrompt("Step 0"),
          makePrompt("Step 1"),
          makePrompt("Step 2"),
        ],
      });
    });

    expect(useWorkflowStore.getState().steps).toHaveLength(3);
    expect((useWorkflowStore.getState().steps[2] as any).prompt).toBe("Step 2");
  });

  it("preserves existing prompt statuses", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
      });
    });

    // Mark step 0 as completed
    act(() => {
      dispatch(MESSAGE_TYPES.STEP_STATUS_CHANGED, {
        stepIndex: 0,
        status: { state: STEP_STATUS.COMPLETED },
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.STEPS_EXTENDED, {
        steps: [
          makePrompt("Step 0"),
          makePrompt("Step 1"),
          makePrompt("Step 2"),
        ],
      });
    });

    expect((useWorkflowStore.getState().steps[0] as any).status).toBe(
      STEP_STATUS.COMPLETED
    );
  });
});

// ---------------------------------------------------------------------------
// Message listener cleanup
// ---------------------------------------------------------------------------

describe("cleanup", () => {
  it("stops handling messages after unmount", () => {
    const { unmount } = renderHook(() => useMessageHandler());
    unmount();

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_COMPLETED);
    });

    // State should remain IDLE since the listener was removed
    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.IDLE
    );
  });
});

