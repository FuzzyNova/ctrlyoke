/**
 * Tests for useMessageHandler — the single entry point for all messages
 * from the VS Code extension into the webview.
 *
 * Strategy: dispatch real window MessageEvents, assert store state mutations.
 * Each test resets all stores to a clean state so tests are independent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

const { handleCompletionNotificationEventMock } = vi.hoisted(() => ({
  handleCompletionNotificationEventMock: vi.fn(),
}));

const { webviewWarnMock } = vi.hoisted(() => ({
  webviewWarnMock: vi.fn(),
}));

vi.mock("@utils/browserNotifications", () => ({
  getNotificationSeverityColor: (severity: string) =>
    severity === "error"
      ? "error"
      : severity === "warning"
        ? "warning"
        : "info",
  handleCompletionNotificationEvent: handleCompletionNotificationEventMock,
}));

vi.mock("@utils/logger", () => ({
  WebviewLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: webviewWarnMock,
    error: vi.fn(),
  },
}));

import {
  createMessageHandlers,
  useMessageHandler,
} from "@hooks/useMessageHandler";
import * as reconnectWatchdog from "@hooks/reconnectWatchdog";
import { useWorkflowStore } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useTerminalStore } from "@store/terminalStore";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  PROMPT_EDITOR_INSERT_MODES,
  STEP_STATUS,
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
  OUTPUT_HISTORY_KINDS,
  FINAL_STEP_PHASES,
} from "@/types/messages";
import type { PromptStep } from "@/types/messages";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";

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
  useUiStore.setState({
    displayedViewAddress: null,
    appliedViewAddress: null,
    executionRunRef: null,
  });
  useEditorStore.getState().resetEditor();
  useTerminalStore.setState({ sessions: {}, activeSessionIds: {} });
  handleCompletionNotificationEventMock.mockReset();
  webviewWarnMock.mockReset();
  sessionStorage.clear();
  vi.useRealTimers();
  // Reset reconnect watchdog per-page-load flag so tests are independent.
  reconnectWatchdog.clearFreshPageReadySent();
});

// ---------------------------------------------------------------------------
// FILE_SELECTED — bootstraps the UI with a new workflow
// ---------------------------------------------------------------------------

describe("FILE_SELECTED", () => {
  it("loads the workflow into workflowStore", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.ctrlyoke.yaml",
        workflowName: "My Workflow",
        steps: [makePrompt("Step 1"), makePrompt("Step 2")],
      });
    });

    const wf = useWorkflowStore.getState();
    expect(wf.fileName).toBe("test.ctrlyoke.yaml");
    expect(wf.workflowName).toBe("My Workflow");
    expect(wf.steps).toHaveLength(2);
    expect((wf.steps[0] as any).prompt).toBe("Step 1");
  });

  it("marks settingsStore.workflowLoaded = true", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useSettingsStore.getState().workflowLoaded).toBe(true);
  });

  it("marks editorStore.hasActiveQueue = true", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useEditorStore.getState().hasActiveQueue).toBe(true);
  });

  it("clears history view when a new workflow is loaded", () => {
    // Prime history state
    useUiStore.getState().setHistoryView();

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "new.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useUiStore.getState().isViewingHistory).toBe(false);
  });

  it("does not attach the previous lineage's runs to a new workflow identity", () => {
    const previousWorkflowKey = "previous-workflow" as never;
    const previousRunRef = "run-previous-2" as never;
    useUiStore.getState().setDisplayedRunView(
      {
        workflowKey: previousWorkflowKey,
        kind: "run",
        runRef: previousRunRef,
      },
      [
        {
          workflowKey: previousWorkflowKey,
          runRef: previousRunRef,
          runId: 2,
          startedAt: 200,
          executionState: EXECUTION_STATES.RUNNING,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
        {
          workflowKey: previousWorkflowKey,
          runRef: "run-previous-1" as never,
          runId: 1,
          startedAt: 100,
          executionState: EXECUTION_STATES.COMPLETED,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
      previousRunRef,
      { definitionRevision: 1, descriptorRevision: 2 },
      { fromStepIndex: 0, baseDefinitionRevision: 1 }
    );

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "new-workflow.ctrlyoke.json",
        steps: [makePrompt("New workflow step")],
      });
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address: {
          workflowKey: "new-workflow" as never,
          kind: "draft",
        },
        definitionRevision: 1,
        descriptorRevision: 1,
      });
    });

    const ui = useUiStore.getState();
    expect(ui.displayedViewAddress).toEqual({
      workflowKey: "new-workflow",
      kind: "draft",
    });
    expect(ui.runSummaries).toEqual([]);
    expect(ui.executionRunRef).toBeNull();
    expect(ui.pendingRewind).toBeNull();
  });

  it("loads workflow properties included with the file selection payload", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "test.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
        workflowProperties: {
          harness: "claude-cli",
          model: "claude-haiku-4.5",
          preCondition: { script: "check.sh", returns: "true" },
        },
      });
    });

    const props = useSettingsStore.getState().workflowProperties;
    expect(props.harness).toBe("claude-cli");
    expect(props.model).toBe("claude-haiku-4.5");
    expect(props.preCondition).toEqual({
      script: "check.sh",
      returns: "true",
    });
  });

  it("does not route a history search through a mutable run index", () => {
    const postMessageMock = (window as any).vscodeApi.postMessage as ReturnType<
      typeof vi.fn
    >;
    postMessageMock.mockClear();
    useUiStore.getState().setPendingHistorySearchNavigation({
      address: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-2026-07-20T10-30-00-000Z" as never,
      },
      findQuery: "needle",
      target: { kind: "queue", stepIndex: 0 },
    });

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "history.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("clears cached edit drafts for the previous workflow while preserving the new-prompt draft", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      const editor = useEditorStore.getState();
      editor.setPromptText("Unsaved new prompt draft");
      editor.enterEditMode(0, makePrompt("Workflow A Step 1"));
      editor.setPromptText("Workflow A unsaved edit");
      editor.deselect();
    });

    expect(useEditorStore.getState().pendingEdits["queue:0"]).toBeDefined();
    expect(useEditorStore.getState().promptText).toBe(
      "Unsaved new prompt draft"
    );

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "workflow-b.ctrlyoke.yaml",
        steps: [makePrompt("Workflow B Step 1")],
      });
    });

    const editor = useEditorStore.getState();
    expect(editor.pendingEdits).toEqual({});
    expect(editor.promptText).toBe("Unsaved new prompt draft");

    act(() => {
      editor.enterEditMode(0, makePrompt("Workflow B Step 1"));
    });

    expect(useEditorStore.getState().promptText).toBe("Workflow B Step 1");
  });
});

// ---------------------------------------------------------------------------
// SESSION_RESTORED — restores workflow state and workflow-level properties
// ---------------------------------------------------------------------------

describe("SESSION_RESTORED", () => {
  it("loads workflow properties included with the restored session payload", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.SESSION_RESTORED, {
        fileName: "test.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
        results: [],
        executionState: EXECUTION_STATES.IDLE,
        currentIndex: 0,
        workflowProperties: {
          harness: "copilot-cli",
          model: "claude-sonnet-4.5",
          toolPermissions: {
            mode: "custom",
            allowedTools: ["read_file"],
            deniedTools: ["execute_command"],
          },
        },
      });
    });

    const props = useSettingsStore.getState().workflowProperties;
    expect(props.harness).toBe("copilot-cli");
    expect(props.model).toBe("claude-sonnet-4.5");
    expect(props.toolPermissions).toEqual({
      mode: "custom",
      allowedTools: ["read_file"],
      deniedTools: ["execute_command"],
    });
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
          fileName: "init.ctrlyoke.yaml",
          workflowName: "Init Workflow",
          steps: [makePrompt("Init Step")],
          executionState: EXECUTION_STATES.IDLE,
        },
      });
    });

    expect(useWorkflowStore.getState().fileName).toBe("init.ctrlyoke.yaml");
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
            autoFocusOutputOnExecution: true,
            respectGitignore: true,
            confirmDeleteOperations: true,
            confirmResetOperations: true,
            confirmContinuationDiscardOperations: true,
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
// Restart / reconnect lifecycle
// ---------------------------------------------------------------------------

describe("restart lifecycle", () => {
  it("schedules a panel reload fallback after DEV_RESTARTING", () => {
    vi.useFakeTimers();
    const reloadSpy = vi
      .spyOn(
        reconnectWatchdog.reconnectWatchdogHooks,
        "reloadPanelForReconnect"
      )
      .mockImplementation(() => undefined);

    renderHook(() => useMessageHandler());
    useUiStore.getState().setMyClientId("panel");

    act(() => {
      dispatch(MESSAGE_TYPES.DEV_RESTARTING);
    });

    expect(useUiStore.getState().devRestarting).toBe(true);
    expect(useUiStore.getState().startupReady).toBe(false);
    expect(useUiStore.getState().myClientId).toBe("");

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it("cancels the reload fallback once CLIENT_ID_ASSIGNED arrives", () => {
    vi.useFakeTimers();
    const reloadSpy = vi
      .spyOn(
        reconnectWatchdog.reconnectWatchdogHooks,
        "reloadPanelForReconnect"
      )
      .mockImplementation(() => undefined);

    renderHook(() => useMessageHandler());
    useUiStore.getState().setMyClientId("panel");

    act(() => {
      dispatch(MESSAGE_TYPES.RECONNECT);
      dispatch(MESSAGE_TYPES.CLIENT_ID_ASSIGNED, { clientId: "panel" });
      vi.advanceTimersByTime(1600);
    });

    expect(useUiStore.getState().myClientId).toBe("panel");
    expect(reloadSpy).not.toHaveBeenCalled();
    reloadSpy.mockRestore();
  });

  it("does not schedule a panel reload fallback for reloadWindow", () => {
    vi.useFakeTimers();
    const reloadSpy = vi
      .spyOn(
        reconnectWatchdog.reconnectWatchdogHooks,
        "reloadPanelForReconnect"
      )
      .mockImplementation(() => undefined);

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.DEV_RESTARTING, {
        command: "workbench.action.reloadWindow",
      });
      vi.advanceTimersByTime(1600);
    });

    expect(reloadSpy).not.toHaveBeenCalled();
    reloadSpy.mockRestore();
  });

  it("does not schedule watchdog on RECONNECT when fresh page already sent READY", () => {
    vi.useFakeTimers();
    const reloadSpy = vi
      .spyOn(
        reconnectWatchdog.reconnectWatchdogHooks,
        "reloadPanelForReconnect"
      )
      .mockImplementation(() => undefined);

    // Simulate BootstrapApp having sent READY on this fresh page load.
    reconnectWatchdog.markFreshPageReadySent();

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.RECONNECT);
      vi.advanceTimersByTime(1600);
    });

    expect(reloadSpy).not.toHaveBeenCalled();
    reloadSpy.mockRestore();
  });

  it("schedules watchdog on RECONNECT in retained context (CLIENT_ID_ASSIGNED previously received)", () => {
    vi.useFakeTimers();
    const reloadSpy = vi
      .spyOn(
        reconnectWatchdog.reconnectWatchdogHooks,
        "reloadPanelForReconnect"
      )
      .mockImplementation(() => undefined);

    // Simulate retained context: freshPageReadySent was cleared when
    // CLIENT_ID_ASSIGNED arrived in the previous session.
    // clearFreshPageReadySent() is called in beforeEach, so the default state
    // is already false — no extra setup needed.

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.RECONNECT);
      vi.advanceTimersByTime(1600);
    });

    expect(reloadSpy).toHaveBeenCalledOnce();
    reloadSpy.mockRestore();
  });

  it("clears freshPageReadySent flag when CLIENT_ID_ASSIGNED arrives", () => {
    renderHook(() => useMessageHandler());

    // Simulate fresh page having sent READY.
    reconnectWatchdog.markFreshPageReadySent();

    act(() => {
      dispatch(MESSAGE_TYPES.CLIENT_ID_ASSIGNED, { clientId: "panel" });
    });

    // After CLIENT_ID_ASSIGNED, the flag should be cleared so the next
    // extension host restart (retained context) can arm the watchdog again.
    vi.useFakeTimers();
    const reloadSpy = vi
      .spyOn(
        reconnectWatchdog.reconnectWatchdogHooks,
        "reloadPanelForReconnect"
      )
      .mockImplementation(() => undefined);

    act(() => {
      dispatch(MESSAGE_TYPES.RECONNECT);
      vi.advanceTimersByTime(1600);
    });

    expect(reloadSpy).toHaveBeenCalledOnce();
    reloadSpy.mockRestore();
  });
});

describe("WORKFLOW_LOADED", () => {
  // On a cold start the panel READY path emits WORKFLOW_LOADED as soon as the
  // persisted view is hydrated — on a slow workspace that is many seconds before
  // initialize() completes and the deferred auto-load runs. Lifting the overlay
  // there handed the user an interactive dashboard mid-startup, and a workflow
  // created or switched to in that window was overwritten by the arriving
  // auto-load. Only STARTUP_COMPLETE may dismiss the overlay.
  it("enables the editing UI without dismissing the startup overlay", () => {
    useUiStore.setState({ startupReady: false });
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_LOADED);
    });

    expect(useSettingsStore.getState().workflowLoaded).toBe(true);
    expect(useEditorStore.getState().hasActiveQueue).toBe(true);
    expect(useUiStore.getState().startupReady).toBe(false);
  });

  it("leaves the overlay dismissed when startup already completed", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.STARTUP_COMPLETE);
      dispatch(MESSAGE_TYPES.WORKFLOW_LOADED);
    });

    expect(useUiStore.getState().startupReady).toBe(true);
  });
});

describe("STARTUP_COMPLETE", () => {
  it("dismisses the startup overlay", () => {
    // resetUi() leaves startupReady alone, so clear it explicitly.
    useUiStore.setState({ startupReady: false });
    renderHook(() => useMessageHandler());

    expect(useUiStore.getState().startupReady).toBe(false);

    act(() => {
      dispatch(MESSAGE_TYPES.STARTUP_COMPLETE);
    });

    expect(useUiStore.getState().startupReady).toBe(true);
  });

  it("requests CLEAR_WORKFLOW when startup completes with no workflow or persisted path", () => {
    const postMessageMock = (window as any).vscodeApi.postMessage as ReturnType<
      typeof vi.fn
    >;
    postMessageMock.mockClear();

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.STARTUP_COMPLETE);
    });

    expect(postMessageMock).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW,
    });
  });

  it("does not request CLEAR_WORKFLOW when a persisted workflow path is pending", () => {
    const postMessageMock = (window as any).vscodeApi.postMessage as ReturnType<
      typeof vi.fn
    >;
    postMessageMock.mockClear();

    useUiStore
      .getState()
      .setActiveWorkflowWorkingFilePath(
        "c:/dev/ctrlyoke/.ctrlyoke/.runs/example/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json"
      );

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.STARTUP_COMPLETE);
    });

    expect(postMessageMock).not.toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW,
    });
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

  it("marks non-terminal prompt statuses completed", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
      });
      useWorkflowStore.getState().setStepStatus(0, STEP_STATUS.COMPLETED);
      useWorkflowStore.getState().setStepStatus(1, STEP_STATUS.RUNNING);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_COMPLETED);
    });

    const prompts = useWorkflowStore.getState().steps;
    expect((prompts[0] as any).status).toBe(STEP_STATUS.COMPLETED);
    expect((prompts[1] as any).status).toBe(STEP_STATUS.COMPLETED);
    expect(useWorkflowStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it("releases the executing run so the header can offer Re-run immediately", () => {
    renderHook(() => useMessageHandler());
    const runRef = "run-2026-07-20T12-00-00-000Z";
    useUiStore.setState({
      executionRunRef: runRef,
      runSummaries: [
        {
          workflowKey: "workflow-1" as never,
          runRef: runRef as never,
          runId: 1,
          startedAt: 1,
          executionState: EXECUTION_STATES.RUNNING,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_COMPLETED);
    });

    const ui = useUiStore.getState();
    expect(ui.executionRunRef).toBeNull();
    expect(ui.runSummaries[0].executionState).toBe(EXECUTION_STATES.COMPLETED);
  });
});

// ---------------------------------------------------------------------------
// NOTIFICATION_EVENT
// ---------------------------------------------------------------------------

describe("NOTIFICATION_EVENT", () => {
  it("enqueues only in standalone mode", () => {
    const event = {
      id: "workflow:wf-1:completed",
      title: "ctrlyoke - Workflow Complete",
      body: "workflow completed",
      severity: "warning",
      tag: "workflow:wf-1",
      kind: "workflow",
    };

    act(() => {
      createMessageHandlers(true)[MESSAGE_TYPES.NOTIFICATION_EVENT]({ event });
    });
    expect(useUiStore.getState().toastQueue).toHaveLength(1);

    useUiStore.getState().clearToasts();
    act(() => {
      createMessageHandlers(false)[MESSAGE_TYPES.NOTIFICATION_EVENT]({ event });
    });
    expect(useUiStore.getState().toastQueue).toEqual([]);
  });

  it("keeps panel completion events native while delegating browser delivery", () => {
    renderHook(() => useMessageHandler());

    const fullSettings: FullGlobalSettings = {
      settings: {
        notifications: {
          vscode: { enabled: true },
          browser: { mode: "connectedOnly" },
          events: {
            workflowComplete: "all",
            promptComplete: "never",
          },
          includeWorkflowName: true,
          includePromptName: true,
          onlyWhenWindowUnfocused: true,
        },
      } as any,
      sources: {
        notifications: "user",
      },
      isMultiRoot: false,
    };
    useSettingsStore.getState().setFullGlobalSettings(fullSettings);

    act(() => {
      dispatch(MESSAGE_TYPES.NOTIFICATION_EVENT, {
        event: {
          id: "workflow:wf-1:completed",
          title: "ctrlyoke - Workflow Timed Out",
          body: "refactor.ctrlyoke.yaml - completed 2 of 4 prompts before timeout",
          severity: "warning",
          tag: "workflow:wf-1",
          kind: "workflow",
          url: "https://example.test/?token=abc",
        },
      });
    });

    expect(useUiStore.getState().toastQueue).toEqual([]);
    expect(handleCompletionNotificationEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workflow:wf-1:completed",
        severity: "warning",
      }),
      fullSettings
    );
  });

  it("ignores malformed notification events", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.NOTIFICATION_EVENT, {
        event: { body: "missing required fields" },
      });
    });

    expect(useUiStore.getState().toastQueue).toEqual([]);
    expect(handleCompletionNotificationEventMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// USER_FEEDBACK
// ---------------------------------------------------------------------------

describe("USER_FEEDBACK", () => {
  it("enqueues operational feedback in both standalone and panel modes", () => {
    const feedback = {
      id: "feedback-1",
      severity: USER_FEEDBACK_SEVERITY.SUCCESS,
      message: "Workflow saved",
    };

    for (const standalone of [true, false]) {
      useUiStore.getState().clearToasts();
      act(() => {
        createMessageHandlers(standalone)[MESSAGE_TYPES.USER_FEEDBACK](
          feedback
        );
      });

      expect(useUiStore.getState().toastQueue).toHaveLength(1);
      expect(useUiStore.getState().toastQueue[0]).toEqual(
        expect.objectContaining(feedback)
      );
    }
  });

  it("maps severity and passes through detail and dedupeKey", () => {
    act(() => {
      createMessageHandlers(false)[MESSAGE_TYPES.USER_FEEDBACK]({
        id: "feedback-2",
        severity: USER_FEEDBACK_SEVERITY.ERROR,
        message: "Workflow failed",
        detail: "The end condition failed.",
        dedupeKey: "workflow-failed",
      });
    });

    expect(useUiStore.getState().toastQueue[0]).toMatchObject({
      id: "feedback-2",
      message: "Workflow failed",
      severity: USER_FEEDBACK_SEVERITY.ERROR,
      detail: "The end condition failed.",
      dedupeKey: "workflow-failed",
    });
  });

  it.each([
    {},
    { id: "feedback-2", severity: USER_FEEDBACK_SEVERITY.INFO },
    {
      id: "feedback-3",
      severity: USER_FEEDBACK_SEVERITY.INFO,
      message: 42,
    },
    {
      id: "feedback-4",
      severity: "unknown",
      message: "invalid severity",
    },
  ])("ignores malformed payload %#", (payload) => {
    act(() => {
      createMessageHandlers(false)[MESSAGE_TYPES.USER_FEEDBACK](payload);
    });

    expect(useUiStore.getState().toastQueue).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OPEN_HARNESS_DIR_RESULT
// ---------------------------------------------------------------------------

describe("OPEN_HARNESS_DIR_RESULT", () => {
  it("shows a warning toast when the folder could not be opened", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT, {
        success: false,
        error:
          "The workspace skill folder does not exist yet: C:\\dev\\ctrlyoke\\.ctrlyoke\\skills",
      });
    });

    expect(useUiStore.getState().toastQueue).toHaveLength(1);
    expect(useUiStore.getState().toastQueue[0]).toMatchObject({
      message:
        "The workspace skill folder does not exist yet: C:\\dev\\ctrlyoke\\.ctrlyoke\\skills",
      severity: USER_FEEDBACK_SEVERITY.WARNING,
    });
  });
});

// ---------------------------------------------------------------------------
// OUTPUT_HISTORY_LOADED
// ---------------------------------------------------------------------------

describe("OUTPUT_HISTORY_LOADED", () => {
  it("keeps the output view live when the newest run history arrives during execution", () => {
    renderHook(() => useMessageHandler());
    const persistedEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: {
        prompt: "Step 1",
        response: "persisted output",
        elapsed: 1,
        isStreaming: false,
      },
      timestampMs: 1000,
      sequence: 0,
    };

    act(() => {
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
      useUiStore.getState().setHistoryView();
      useWorkflowStore.getState().appendLiveEntry({
        ...persistedEntry,
        cliOutput: {
          ...persistedEntry.cliOutput,
          response: "newer buffered output",
        },
        timestampMs: 1100,
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.OUTPUT_HISTORY_LOADED, {
        history: {
          runId: "run-1",
          startedAt: 1000,
          completedAt: undefined,
          executionState: EXECUTION_STATES.RUNNING,
          orderedEntries: [persistedEntry],
          promptOutputs: {},
        },
        availableRuns: 1,
        currentRunIndex: 0,
      });
    });

    expect(useUiStore.getState().isViewingHistory).toBe(false);
    expect(useWorkflowStore.getState().historyOutputs).toBeNull();
    expect(useWorkflowStore.getState().liveOrderedEntries).toHaveLength(1);
    const [liveEntry] = useWorkflowStore.getState().liveOrderedEntries;
    expect(
      liveEntry && "cliOutput" in liveEntry
        ? liveEntry.cliOutput.response
        : null
    ).toBe("newer buffered output");
  });

  it("loads history when the manifest is completed even if the webview state is still running (race condition fix)", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.OUTPUT_HISTORY_LOADED, {
        history: {
          runId: 1,
          startedAt: 1000,
          completedAt: 2000,
          executionState: EXECUTION_STATES.COMPLETED,
          orderedEntries: [],
          promptOutputs: {},
        },
        availableRuns: 1,
        currentRunIndex: 0,
      });
    });

    // History must be loaded — the completed manifest overrules the stale webview state
    expect(useWorkflowStore.getState().historyOutputs).not.toBeNull();
    expect(useUiStore.getState().isViewingHistory).toBe(true);
  });

  it("opens output find with the pending history query and clears staged navigation", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      useUiStore.getState().setPendingHistorySearchNavigation({
        address: {
          workflowKey: "wf-1" as never,
          kind: "run",
          runRef: "run-2026-07-20T10-30-00-000Z" as never,
        },
        findQuery: "needle",
        target: { kind: "queue", stepIndex: 0 },
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: {
          workflowKey: "wf-1" as never,
          kind: "run",
          runRef: "run-2026-07-20T10-30-00-000Z" as never,
        },
        workingFile: { workflowName: "History", steps: [] },
        workflowProperties: {},
        runSummaries: [],
        history: {
          runId: 2,
          startedAt: 1000,
          completedAt: 2000,
          executionState: EXECUTION_STATES.COMPLETED,
          orderedEntries: [],
          promptOutputs: {},
        },
      });
    });

    expect(useUiStore.getState().pendingFindRequest).toEqual({
      query: "needle",
      preferredTarget: { kind: "queue", stepIndex: 0 },
    });
    expect(useUiStore.getState().pendingHistorySearchNavigation).toBeNull();
  });
});

describe("RUN_VIEW_LOADED navigation identity", () => {
  it("does not clear an optimistically selected run while its snapshot loads", () => {
    renderHook(() => useMessageHandler());
    const source = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    };
    const target = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T11-30-00-000Z" as never,
    };

    act(() => {
      useUiStore.getState().setDisplayedRunView(source, [], undefined);
    });
    const requestId = useUiStore
      .getState()
      .requestRunViewLoad(target, [], undefined);
    const observedAddresses: Array<typeof target | null> = [];
    const unsubscribe = useUiStore.subscribe((state) => {
      observedAddresses.push(
        state.displayedViewAddress as typeof target | null
      );
    });

    try {
      act(() => {
        dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
          requestId,
          address: target,
          workingFile: { workflowName: "Selected run", steps: [] },
          workflowProperties: {},
          runSummaries: [],
          history: {
            runId: 2,
            startedAt: 1000,
            completedAt: 2000,
            executionState: EXECUTION_STATES.COMPLETED,
            orderedEntries: [],
            promptOutputs: {},
          },
        });
      });
    } finally {
      unsubscribe();
    }

    expect(observedAddresses).not.toContain(null);
    expect(useUiStore.getState().displayedViewAddress).toEqual(target);
    expect(useUiStore.getState().isViewingHistory).toBe(true);
    expect(useWorkflowStore.getState().historyOutputs).not.toBeNull();
  });

  it("applies the snapshot when its own ACTIVE_WORKFLOW_CHANGED announcement precedes it", () => {
    renderHook(() => useMessageHandler());
    const target = {
      workflowKey: "wf-switch" as never,
      kind: "run" as const,
      runRef: "run-2026-07-22T12-00-00-000Z" as never,
    };

    // Cross-lineage dropdown switch: request issued, then the backend answers
    // with ACTIVE_WORKFLOW_CHANGED (carrying the requestId) before the
    // requestful RUN_VIEW_LOADED snapshot.
    const requestId = useUiStore
      .getState()
      .requestRunViewLoad(target, [], undefined);

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "instance-switch",
        workingFilePath: null,
        requestId,
      });
    });
    // The announcement must not cancel the request it is answering — neither
    // the pending id nor the switch overlay/header-rename state.
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(requestId);
    expect(useUiStore.getState().pendingRunViewSwitch?.requestId).toBe(
      requestId
    );

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        requestId,
        address: target,
        workingFile: { workflowName: "Switched workflow", steps: [] },
        workflowProperties: {},
        runSummaries: [],
        history: {
          runId: 1,
          startedAt: 1000,
          completedAt: 2000,
          executionState: EXECUTION_STATES.COMPLETED,
          orderedEntries: [],
          promptOutputs: {},
        },
      });
    });

    expect(useWorkflowStore.getState().workflowName).toBe("Switched workflow");
    expect(useUiStore.getState().displayedViewAddress).toEqual(target);
    expect(useUiStore.getState().pendingRunViewRequestId).toBeNull();
    // Applying the snapshot ends the switch: overlay down, header back to store.
    expect(useUiStore.getState().pendingRunViewSwitch).toBeNull();
  });

  it("still cancels a stale pending request on a backend-initiated switch", () => {
    renderHook(() => useMessageHandler());
    const target = {
      workflowKey: "wf-stale" as never,
      kind: "draft" as const,
    };

    // A request whose response was lost leaves a stale pending id; a
    // backend-initiated switch (no requestId) must clear it so the follow-up
    // requestless replay is not suppressed forever.
    const staleRequestId = useUiStore
      .getState()
      .requestRunViewLoad(target, [], undefined);
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(staleRequestId);

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "instance-backend",
        workingFilePath: null,
      });
    });

    expect(useUiStore.getState().pendingRunViewRequestId).toBeNull();
    // The abandoned switch's overlay must come down with its request.
    expect(useUiStore.getState().pendingRunViewSwitch).toBeNull();
  });

  it("accepts a reconnect snapshot when retained content no longer matches its applied address", () => {
    renderHook(() => useMessageHandler());
    const workflowId = "execution-mode-instance";
    const address = {
      workflowKey: "execution-mode" as never,
      kind: "run" as const,
      runRef: "run-2026-08-02T21-09-53-340Z" as never,
    };

    act(() => {
      useUiStore.setState({
        activeWorkflowId: workflowId,
        displayedViewAddress: address,
        appliedViewAddress: address,
        displayedDefinitionRevision: 1,
        displayedDescriptorRevision: 1,
      });
      useWorkflowStore.getState().loadWorkflow({
        fileName: "workflow.ctrlyoke.json",
        workflowName: "staging order",
        steps: [makePrompt("stale 1"), makePrompt("stale 2")],
      });
    });

    act(() => {
      // replayWorkflowStateTo announces the binding before its authoritative,
      // requestless snapshot. The instance ID may be unchanged on reconnect.
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, { workflowId });
    });

    expect(useUiStore.getState().appliedViewAddress).toBeNull();

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Execution mode",
          definitionRevision: 1,
          steps: [makePrompt("current")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
      });
    });

    expect(useWorkflowStore.getState().workflowName).toBe("Execution mode");
    expect(useWorkflowStore.getState().steps).toHaveLength(1);
    expect(useUiStore.getState().appliedViewAddress).toEqual(address);
  });

  it("hydrates an executing run's full history before overlaying buffered output", () => {
    renderHook(() => useMessageHandler());
    const workflowId = "instance-atomic";
    const address = {
      workflowKey: "wf-atomic" as never,
      kind: "run" as const,
      runRef: "run-2026-07-22T10-30-00-000Z" as never,
    };
    const earlierPersistedEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: { response: "earlier persisted history" },
      timestampMs: 1000,
      sequence: 0,
    };
    const persistedCurrentEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: { response: "persisted current output" },
      timestampMs: 1500,
      sequence: 1,
    };

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, { workflowId });
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Atomic snapshot",
          definitionRevision: 3,
          steps: [makePrompt("Step 1"), makePrompt("Step 2")],
          _runtime: {
            executionState: EXECUTION_STATES.RUNNING,
            currentIndex: 1,
          },
        },
        workflowProperties: {},
        runSummaries: [
          {
            workflowKey: address.workflowKey,
            runRef: address.runRef,
            startedAt: 1000,
            executionState: EXECUTION_STATES.RUNNING,
            stepCount: 2,
          },
        ],
        executionRunRef: address.runRef,
        history: {
          runId: 1,
          startedAt: 1000,
          executionState: EXECUTION_STATES.RUNNING,
          orderedEntries: [earlierPersistedEntry, persistedCurrentEntry],
          promptOutputs: {},
        },
        descriptorRevision: 2,
      });
      dispatch(MESSAGE_TYPES.CLI_OUTPUT, {
        workflowId,
        stepIndex: 1,
        output: {
          response: "newer buffered output",
          timestampMs: 2001,
          runIndex: 0,
          attemptIndex: 0,
        },
      });
    });

    const workflow = useWorkflowStore.getState();
    expect(workflow.historyOutputs).toBeNull();
    expect(workflow.liveOrderedEntries).toHaveLength(2);
    expect(workflow.liveOrderedEntries[0]).toEqual(earlierPersistedEntry);
    expect(
      "cliOutput" in workflow.liveOrderedEntries[1]
        ? workflow.liveOrderedEntries[1].cliOutput.response
        : null
    ).toBe("newer buffered output");
    expect(useUiStore.getState().isViewingHistory).toBe(false);
    expect(useUiStore.getState().displayedViewAddress).toEqual(address);
  });
});

describe("RUN_VIEW_LOADED same-view replay", () => {
  it("preserves step and live-entry identities when an identical snapshot is replayed", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-replay" as never,
      kind: "run" as const,
      runRef: "run-2026-07-23T09-00-00-000Z" as never,
    };
    const makeSnapshot = () => ({
      address,
      workingFile: {
        workflowName: "Replayed run",
        definitionRevision: 2,
        steps: [makePrompt("Step 1"), makePrompt("Step 2")],
        _runtime: {
          executionState: EXECUTION_STATES.RUNNING,
          currentIndex: 0,
        },
      },
      workflowProperties: { model: "some-model" },
      runSummaries: [],
      executionRunRef: address.runRef,
      history: {
        runId: 1,
        startedAt: 1000,
        executionState: EXECUTION_STATES.RUNNING,
        orderedEntries: [
          {
            kind: OUTPUT_HISTORY_KINDS.CLI,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
            runIndex: 0,
            attemptIndex: 0,
            cliOutput: { response: "persisted output", timestampMs: 1100 },
            timestampMs: 1100,
            sequence: 0,
          },
        ],
        promptOutputs: {},
      },
      descriptorRevision: 1,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, makeSnapshot());
    });

    const before = useWorkflowStore.getState();
    const stepsBefore = before.steps;
    const entriesBefore = before.liveOrderedEntries;
    expect(stepsBefore).toHaveLength(2);
    expect(entriesBefore).toHaveLength(1);

    // A property edit's run-view invalidation used to replay this exact
    // snapshot. The replay must not hand the output pane fresh identities —
    // that's what made rendered rows and diffs visibly redraw.
    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, makeSnapshot());
    });

    const after = useWorkflowStore.getState();
    expect(after.steps).toBe(stepsBefore);
    expect(after.liveOrderedEntries).toBe(entriesBefore);
  });

  it("still clears runtime state when the snapshot carries a new definition revision", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-replay-rev" as never,
      kind: "run" as const,
      runRef: "run-2026-07-23T10-00-00-000Z" as never,
    };
    const makeSnapshot = (definitionRevision: number, prompt: string) => ({
      address,
      workingFile: {
        workflowName: "Edited run",
        definitionRevision,
        steps: [makePrompt(prompt)],
      },
      workflowProperties: {},
      runSummaries: [],
      history: {
        runId: 1,
        startedAt: 1000,
        completedAt: 2000,
        executionState: EXECUTION_STATES.COMPLETED,
        orderedEntries: [],
        promptOutputs: {},
      },
      descriptorRevision: 1,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, makeSnapshot(1, "original"));
    });
    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, makeSnapshot(2, "edited"));
    });

    const workflow = useWorkflowStore.getState();
    expect(
      workflow.steps.map((step) => ("prompt" in step ? step.prompt : undefined))
    ).toEqual(["edited"]);
    expect(useUiStore.getState().displayedDefinitionRevision).toBe(2);
  });
});

describe("run view revision snapshots", () => {
  it("ignores a late requestless snapshot that would regress an appended run", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    };

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Growing run",
          definitionRevision: 1,
          steps: [makePrompt("first"), makePrompt("second")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: {
          runId: 1,
          startedAt: 1000,
          completedAt: 2000,
          executionState: EXECUTION_STATES.COMPLETED,
          orderedEntries: [],
          promptOutputs: {},
        },
      });
      dispatch(MESSAGE_TYPES.STEPS_EXTENDED, {
        steps: [
          makePrompt("first"),
          makePrompt("second"),
          makePrompt("appended"),
        ],
      });
    });

    expect(useWorkflowStore.getState().steps).toHaveLength(3);

    act(() => {
      // This replay began before the append and has no selector request ID. Its
      // equal revision is possible because the live queue update is delivered
      // before the post-execution identity refresh.
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Growing run",
          definitionRevision: 1,
          steps: [makePrompt("first"), makePrompt("second")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: {
          runId: 1,
          startedAt: 1000,
          completedAt: 2000,
          executionState: EXECUTION_STATES.COMPLETED,
          orderedEntries: [],
          promptOutputs: {},
        },
      });
    });

    expect(
      useWorkflowStore
        .getState()
        .steps.map((step) => ("prompt" in step ? step.prompt : undefined))
    ).toEqual(["first", "second", "appended"]);
    expect(useUiStore.getState().displayedViewAddress).toEqual(address);
  });

  it("ignores a requestless snapshot from an older definition revision", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    };

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Current run",
          definitionRevision: 3,
          steps: [makePrompt("current")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
      });
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Stale run",
          definitionRevision: 2,
          steps: [makePrompt("stale"), makePrompt("also stale")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
      });
    });

    expect(useWorkflowStore.getState().workflowName).toBe("Current run");
    expect(useWorkflowStore.getState().steps[0]).toMatchObject({
      prompt: "current",
    });
    expect(useUiStore.getState().displayedDefinitionRevision).toBe(3);
  });

  it("accepts an authoritative draft replay after switching to a newly loaded workflow", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "previous-workflow" as never,
        kind: "run",
        runRef: "run-2026-07-20T10-30-00-000Z" as never,
      },
    });

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "new-instance",
      });
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: { workflowKey: "new-workflow" as never, kind: "draft" },
        workingFile: {
          workflowName: "New workflow",
          definitionRevision: 1,
          steps: [makePrompt("first")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
      });
    });

    expect(useUiStore.getState().displayedViewAddress).toEqual({
      workflowKey: "new-workflow",
      kind: "draft",
    });
    expect(useWorkflowStore.getState().workflowName).toBe("New workflow");
  });

  it("stores definition and descriptor revisions for the next addressed edit", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: { workflowKey: "wf-1" as never, kind: "draft" },
        workingFile: {
          workflowName: "Draft",
          definitionRevision: 7,
          steps: [],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 11,
        pendingRewind: {
          fromStepIndex: 2,
          baseDefinitionRevision: 6,
        },
      });
    });

    expect(useUiStore.getState().displayedDefinitionRevision).toBe(7);
    expect(useUiStore.getState().displayedDescriptorRevision).toBe(11);
    expect(useUiStore.getState().pendingRewind).toEqual({
      fromStepIndex: 2,
      baseDefinitionRevision: 6,
    });
  });

  it("applies a genuinely new workflow's snapshot even though its identity was already published without content", () => {
    // Reproduces the "new workflow switch shows test in the title" bug: a
    // WORKFLOW_VIEW_IDENTITY publish (e.g. re-emitted after a replay) can
    // advance displayedViewAddress/displayedDefinitionRevision to a new
    // lineage before that lineage's own RUN_VIEW_LOADED snapshot is applied.
    // The stale-snapshot guard must not treat the *previous* workflow's still
    // -resident 4-step content as "the current address" just because
    // displayedViewAddress now points at the 2-step target.
    renderHook(() => useMessageHandler());
    const previousAddress = {
      workflowKey: "test" as never,
      kind: "run" as const,
      runRef: "run-2026-07-24T00-00-00-000Z" as never,
    };
    const targetAddress = {
      workflowKey: "new-workflow-switch" as never,
      kind: "run" as const,
      runRef: "run-2026-07-25T00-00-00-000Z" as never,
    };

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: previousAddress,
        workingFile: {
          workflowName: "test",
          definitionRevision: 1,
          steps: [
            makePrompt("a"),
            makePrompt("b"),
            makePrompt("c"),
            makePrompt("d"),
          ],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
      });
    });
    expect(useWorkflowStore.getState().steps).toHaveLength(4);

    act(() => {
      // Identity-only publish for the new lineage — no matching content ever
      // applied to workflowStore.
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address: targetAddress,
        definitionRevision: 1,
        descriptorRevision: 1,
      });
    });
    expect(useUiStore.getState().displayedViewAddress).toEqual(targetAddress);
    expect(useUiStore.getState().appliedViewAddress).toEqual(previousAddress);
    expect(useWorkflowStore.getState().workflowName).toBe("test");

    act(() => {
      // The new lineage's own authoritative (but requestless) snapshot,
      // finally arriving on reconnect/replay.
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: targetAddress,
        workingFile: {
          workflowName: "New workflow switch",
          definitionRevision: 1,
          steps: [makePrompt("x"), makePrompt("y")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
      });
    });

    expect(useWorkflowStore.getState().workflowName).toBe(
      "New workflow switch"
    );
    expect(useWorkflowStore.getState().steps).toHaveLength(2);
    expect(useUiStore.getState().appliedViewAddress).toEqual(targetAddress);
  });

  it("adopts a regressive snapshot's newer descriptor revision while ignoring its definition", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    };
    act(() => {
      useUiStore.setState({
        displayedViewAddress: address,
        appliedViewAddress: address,
        displayedDefinitionRevision: 3,
        displayedDescriptorRevision: 5,
      });
      useWorkflowStore.setState({
        workflowName: "Current head",
        steps: [makePrompt("prefix"), makePrompt("edited suffix")],
      });
      // A requestless invalidation snapshot whose definition read raced an
      // in-place write: its definition revision is stale, but its descriptor
      // revision already reflects the rewind's descriptor commit.
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Stale head",
          definitionRevision: 2,
          steps: [makePrompt("prefix"), makePrompt("old suffix")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 6,
      });
    });

    // Definition state stays on the newer head the client already has…
    expect(useWorkflowStore.getState().workflowName).toBe("Current head");
    expect(useUiStore.getState().displayedDefinitionRevision).toBe(3);
    // …but the monotonic descriptor knowledge is adopted, so the next
    // Discard/Continue does not carry a superseded descriptor revision.
    expect(useUiStore.getState().displayedDescriptorRevision).toBe(6);
  });

  it("accepts the explicit definition rollback produced by discarding a continuation", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    };
    act(() => {
      useUiStore.setState({
        displayedViewAddress: address,
        displayedDefinitionRevision: 5,
        displayedDescriptorRevision: 10,
        pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 4 },
      });
      useWorkflowStore.setState({
        workflowName: "Pending continuation",
        steps: [makePrompt("prefix"), makePrompt("rewound suffix")],
      });

      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Committed run",
          definitionRevision: 4,
          steps: [makePrompt("prefix"), makePrompt("committed suffix")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 11,
        definitionRollback: { fromRevision: 5 },
      });
    });

    expect(useWorkflowStore.getState().workflowName).toBe("Committed run");
    expect(useWorkflowStore.getState().steps[1]).toMatchObject({
      prompt: "committed suffix",
    });
    expect(useUiStore.getState().displayedDefinitionRevision).toBe(4);
    expect(useUiStore.getState().displayedDescriptorRevision).toBe(11);
    expect(useUiStore.getState().pendingRewind).toBeNull();
  });

  it("re-arms the next edit with the revisions a write just produced", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      displayedViewAddress: { workflowKey: "wf-1" as never, kind: "draft" },
      displayedDefinitionRevision: 3,
      displayedDescriptorRevision: 4,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address: { workflowKey: "wf-1" as never, kind: "draft" },
        definitionRevision: 4,
        descriptorRevision: 5,
      });
    });

    expect(useUiStore.getState().displayedDefinitionRevision).toBe(4);
    expect(useUiStore.getState().displayedDescriptorRevision).toBe(5);
  });

  it("does not let a write identity override a run switch still in flight", () => {
    renderHook(() => useMessageHandler());
    const inFlight = { workflowKey: "wf-1" as never, kind: "run" as const };

    act(() => {
      useUiStore.setState({
        displayedViewAddress: {
          ...inFlight,
          runRef: "run-2026-07-20T11-00-00-000Z" as never,
        },
        pendingRunViewRequestId: "run-view-1",
      });
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address: {
          ...inFlight,
          runRef: "run-2026-07-20T10-00-00-000Z" as never,
        },
        definitionRevision: 2,
        descriptorRevision: 2,
      });
    });

    expect(useUiStore.getState().displayedViewAddress).toEqual({
      ...inFlight,
      runRef: "run-2026-07-20T11-00-00-000Z",
    });
  });

  it("still applies a write identity for the address a switch is loading", () => {
    renderHook(() => useMessageHandler());
    const address = { workflowKey: "wf-1" as never, kind: "draft" as const };

    act(() => {
      // A run-view request whose response was lost or rejected must not
      // suppress revisions for the address the client is actually displaying —
      // that is what left Run and every property edit rejected as a conflict.
      useUiStore.setState({
        displayedViewAddress: address,
        displayedDefinitionRevision: 3,
        displayedDescriptorRevision: 4,
        pendingRunViewRequestId: "run-view-lost",
      });
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address,
        definitionRevision: 4,
        descriptorRevision: 5,
      });
    });

    expect(useUiStore.getState().displayedDefinitionRevision).toBe(4);
    expect(useUiStore.getState().displayedDescriptorRevision).toBe(5);
  });

  it("retires the run-view request a failure answers", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({ pendingRunViewRequestId: "run-view-7" });

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_ACTION_FAILED, {
        action: "load run",
        error: "boom",
        requestId: "run-view-7",
      });
    });

    expect(useUiStore.getState().pendingRunViewRequestId).toBeNull();
  });

  it("keeps an unrelated run-view request pending on failure", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({ pendingRunViewRequestId: "run-view-8" });

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_ACTION_FAILED, {
        action: "run draft",
        error: "Definition revision conflict",
      });
    });

    expect(useUiStore.getState().pendingRunViewRequestId).toBe("run-view-8");
  });

  it("stops addressing the previous workflow when a new one is selected", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "previous-workflow" as never,
        kind: "draft",
      },
      displayedDefinitionRevision: 5,
      displayedDescriptorRevision: 6,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "New Workflow",
        workflowName: "New Workflow",
        steps: [],
      });
    });

    expect(useUiStore.getState().displayedViewAddress).toBeNull();
    expect(useUiStore.getState().displayedDefinitionRevision).toBeNull();
    expect(useUiStore.getState().displayedDescriptorRevision).toBeNull();
  });
});

describe("SUFFIX_EDIT_CONFIRMATION_REQUIRED", () => {
  const address = {
    workflowKey: "workflow-a" as never,
    kind: "run" as const,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
  };

  it("stores the pending confirmation so the UI can render its own modal", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED, {
        action: "discardContinuation",
        address,
        expectedDefinitionRevision: 3,
        expectedDescriptorRevision: 5,
      });
    });

    expect(useUiStore.getState().suffixEditConfirmation).toEqual({
      action: "discardContinuation",
      address,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
  });

  it("resends the action with confirmEditedSuffix instead of showing the modal when the setting is off", () => {
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        confirmContinuationDiscardOperations: false,
      },
    }));
    const postMessageMock = (window as any).vscodeApi.postMessage as ReturnType<
      typeof vi.fn
    >;
    postMessageMock.mockClear();

    try {
      renderHook(() => useMessageHandler());

      act(() => {
        dispatch(MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED, {
          action: "startNewRunInstead",
          address,
          expectedDefinitionRevision: 3,
          expectedDescriptorRevision: 5,
        });
      });

      expect(postMessageMock).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.START_NEW_RUN_INSTEAD,
        address,
        expectedDefinitionRevision: 3,
        expectedDescriptorRevision: 5,
        confirmEditedSuffix: true,
      });
      expect(useUiStore.getState().suffixEditConfirmation).toBeNull();
    } finally {
      // globalSettings is not part of resetSettings()'s reset scope (it stays
      // global on purpose), so this test must restore it itself to avoid
      // leaking into tests that run later in this file.
      useSettingsStore.setState((state) => ({
        globalSettings: {
          ...state.globalSettings,
          confirmContinuationDiscardOperations: true,
        },
      }));
    }
  });
});

describe("history search messages", () => {
  it("opens the history search drawer when requested", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.OPEN_HISTORY_SEARCH);
    });

    expect(useUiStore.getState().isHistorySearchOpen).toBe(true);
  });

  it("applies matching search results and ignores stale queries", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      useUiStore.getState().setHistorySearchQuery("needle");
      useUiStore.getState().setHistorySearchResults([], true);
      dispatch(MESSAGE_TYPES.SEARCH_HISTORY_RESULTS, {
        query: "needle",
        results: [
          {
            workflowKey: "wf-1" as never,
            runRef: "run-2026-07-20T10-30-00-000Z" as never,
            workflowName: "Search Workflow",
            runId: 3,
            startedAt: 1000,
            executionState: EXECUTION_STATES.COMPLETED,
            target: { kind: "queue", stepIndex: 0 },
            matchType: "response",
            matchSnippet: "needle found here",
            matchContext: "Prompt 1",
          },
        ],
        hasMore: false,
      });
    });

    expect(useUiStore.getState().historySearchResults).toHaveLength(1);
    expect(useUiStore.getState().historySearchLoading).toBe(false);

    act(() => {
      useUiStore.getState().setHistorySearchQuery("fresh");
      useUiStore.getState().setHistorySearchResults([], true);
      dispatch(MESSAGE_TYPES.SEARCH_HISTORY_RESULTS, {
        query: "stale",
        results: [
          {
            workflowKey: "wf-2" as never,
            runRef: "run-2026-07-20T10-31-00-000Z" as never,
            workflowName: "Stale Workflow",
            runId: 4,
            startedAt: 2000,
            executionState: EXECUTION_STATES.COMPLETED,
            target: { kind: "queue", stepIndex: 1 },
            matchType: "prompt",
            matchSnippet: "stale result",
            matchContext: "Prompt 2",
          },
        ],
        hasMore: false,
      });
    });

    expect(useUiStore.getState().historySearchResults).toEqual([]);
    expect(useUiStore.getState().historySearchLoading).toBe(true);
  });
});

describe("active workflow summaries", () => {
  it("accepts a workflow binding while the displayed run's execution is unknown", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      activeWorkflowId: null,
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-2026-07-20T12-00-00-000Z" as never,
      },
      executionRunRef: null,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "instance-1",
      });
    });

    expect(useUiStore.getState().activeWorkflowId).toBe("instance-1");
  });

  it("ignores live workflow messages while viewing a known different run", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      activeWorkflowId: null,
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-2026-07-20T12-00-00-000Z" as never,
      },
      executionRunRef: "run-2026-07-20T13-00-00-000Z",
    });

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "instance-1",
      });
    });

    expect(useUiStore.getState().activeWorkflowId).toBeNull();
  });

  it("keeps pausing workflows in loadedWorkflows", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOWS_LIST, {
        workflows: [
          {
            id: "wf-pausing",
            workflowName: "Pausing workflow",
            filePath: "C:\\wf-pausing.ctrlyoke.json",
            executionState: EXECUTION_STATES.PAUSING,
            currentStep: 1,
            totalSteps: 3,
          },
          {
            id: "wf-complete",
            workflowName: "Completed workflow",
            filePath: "C:\\wf-complete.ctrlyoke.json",
            executionState: EXECUTION_STATES.COMPLETED,
            currentStep: 3,
            totalSteps: 3,
          },
        ],
      });
    });

    expect(useUiStore.getState().loadedWorkflows.map((w) => w.id)).toEqual([
      "wf-pausing",
    ]);
  });

  it("upserts pausing workflow summary updates into loadedWorkflows", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, {
        summary: {
          id: "wf-pausing",
          workflowName: "Pausing workflow",
          filePath: "C:\\wf-pausing.ctrlyoke.json",
          executionState: EXECUTION_STATES.PAUSING,
          currentStep: 1,
          totalSteps: 3,
        },
      });
    });

    expect(useUiStore.getState().loadedWorkflows.map((w) => w.id)).toEqual([
      "wf-pausing",
    ]);
    expect(useUiStore.getState().loadedWorkflows[0]?.executionState).toBe(
      EXECUTION_STATES.PAUSING
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
// CONTEXT_WINDOW_UPDATE
// ---------------------------------------------------------------------------

describe("CONTEXT_WINDOW_UPDATE", () => {
  it("stores live context for the currently running step", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
      });
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
      useWorkflowStore.getState().setCurrentStep(1);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE, {
        stepIndex: 1,
        used: 152797,
        size: 200000,
      });
    });

    expect(useWorkflowStore.getState().liveContextWindow[1]).toEqual({
      used: 152797,
      size: 200000,
    });
  });

  it("ignores late live context for a completed step", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
      });
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
      useWorkflowStore.getState().setCurrentStep(1);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE, {
        stepIndex: 1,
        used: 66000,
        size: 200000,
      });
      dispatch(MESSAGE_TYPES.STEP_STATUS_CHANGED, {
        stepIndex: 1,
        status: STEP_STATUS.COMPLETED,
      });
      dispatch(MESSAGE_TYPES.CLI_OUTPUT, {
        stepIndex: 1,
        output: {
          response: "done",
          tokens: {
            contextWindowUsed: 152797,
            contextWindowSize: 200000,
          },
        },
      });
      dispatch(MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE, {
        stepIndex: 1,
        used: 66000,
        size: 200000,
      });
    });

    const store = useWorkflowStore.getState();
    expect(store.liveContextWindow[1]).toBeUndefined();
    expect(store.steps[1]._runtime?.contextWindowUsed).toBe(152797);
    expect(store.steps[1]._runtime?.contextWindowSize).toBe(200000);
  });

  it("keeps the previous step live context until durable tokens arrive", () => {
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
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
      useWorkflowStore.getState().setCurrentStep(1);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE, {
        stepIndex: 1,
        used: 152797,
        size: 200000,
      });
      dispatch(MESSAGE_TYPES.STEP_STATUS_CHANGED, {
        stepIndex: 1,
        status: STEP_STATUS.COMPLETED,
      });
      useWorkflowStore.getState().setCurrentStep(2);
    });

    expect(useWorkflowStore.getState().liveContextWindow[1]).toEqual({
      used: 152797,
      size: 200000,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.CLI_OUTPUT, {
        stepIndex: 1,
        output: {
          response: "done",
          tokens: {
            contextWindowUsed: 152797,
            contextWindowSize: 200000,
          },
        },
      });
    });

    const store = useWorkflowStore.getState();
    expect(store.liveContextWindow[1]).toBeUndefined();
    expect(store.steps[1]._runtime?.contextWindowUsed).toBe(152797);
    expect(store.steps[1]._runtime?.contextWindowSize).toBe(200000);
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
// EXECUTION_STARTED
// ---------------------------------------------------------------------------

describe("EXECUTION_STARTED", () => {
  it("expands the output section and shows output for headless runs when auto-focus is enabled", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useUiStore.getState().setActiveOutputTab("workflow-1", "terminal");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", true);

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
        executionMode: "headless",
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(false);
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe("output");
  });

  it("leaves the current view alone when headless auto-focus is disabled", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useUiStore.getState().setActiveOutputTab("workflow-1", "terminal");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", false);

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
        executionMode: "headless",
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(true);
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe(
      "terminal"
    );
  });

  it("expands the output section and keeps terminal visible for inject-mode runs", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", true);
    useTerminalStore.getState().addSession({
      id: "session-1",
      workflowId: "workflow-1",
      stepName: "Step 1",
      kind: SESSION_KINDS.AI_CLI,
      status: TERMINAL_SESSION_STATUS.COMPLETED,
      isController: true,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
        isInjectMode: true,
        executionMode: "interactive",
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(false);
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe(
      "terminal"
    );
  });

  it("focuses the tab for each step's resolved execution mode", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", true);

    const dispatchStepStart = (executionMode: "headless" | "interactive") =>
      act(() => {
        dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
          workflowId: "workflow-1",
          fileName: "wf.yaml",
          totalSteps: 3,
          executionMode,
        });
      });

    dispatchStepStart("headless");
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe("output");

    dispatchStepStart("interactive");
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe(
      "terminal"
    );

    dispatchStepStart("headless");
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe("output");
  });

  it("preserves ai-cli sessions during append continuations until TERMINAL_STARTED reconciles them", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useTerminalStore.getState().addSession({
      id: "session-1",
      workflowId: "workflow-1",
      stepName: "Step 1",
      kind: SESSION_KINDS.AI_CLI,
      status: TERMINAL_SESSION_STATUS.COMPLETED,
      isController: true,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
        isContinuation: true,
        preserveStepCount: 1,
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session-1");
  });

  it("clears a pending rewind when another viewer continues the run", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.setState({
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 3 },
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 3,
        isContinuation: true,
        preserveStepCount: 1,
      });
    });

    expect(useUiStore.getState().pendingRewind).toBeNull();
  });

  it("clears ai-cli sessions on fresh non-inject starts", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useTerminalStore.getState().addSession({
      id: "session-1",
      workflowId: "workflow-1",
      stepName: "Step 1",
      kind: SESSION_KINDS.AI_CLI,
      status: TERMINAL_SESSION_STATUS.COMPLETED,
      isController: true,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
      });
    });

    expect(useTerminalStore.getState().sessions["workflow-1"]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_STARTED
// ---------------------------------------------------------------------------

describe("TERMINAL_STARTED", () => {
  it("keeps terminal lifecycle messages live while viewing a historical run", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "commit" as never,
        kind: "run",
        runRef: "run-2026-06-08T21-27-08-408Z" as never,
      },
      executionRunRef: "run-2026-07-24T04-29-37-398Z" as never,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "shell-session-1",
        stepName: "Shell",
        kind: SESSION_KINDS.SHELL,
        controllerClientId: "controller-1",
      });
    });

    expect(useTerminalStore.getState().sessions["workflow-1"]).toMatchObject([
      {
        id: "shell-session-1",
        status: TERMINAL_SESSION_STATUS.RUNNING,
      },
    ]);
  });

  it("expands the output section and shows terminal when auto-focus is enabled", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useUiStore.getState().setActiveOutputTab("workflow-1", "output");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", true);

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        stepName: "Step 1",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        controllerClientId: "controller-1",
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(false);
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe(
      "terminal"
    );
  });

  it("does not switch views on terminal start when auto-focus is disabled", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useUiStore.getState().setActiveOutputTab("workflow-1", "output");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", false);

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        stepName: "Step 1",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        controllerClientId: "controller-1",
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(true);
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe("output");
  });

  it("updates existing session metadata when inject mode reuses the PTY", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        stepName: "Step 1",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        controllerClientId: "controller-1",
      });
    });

    act(() => {
      useTerminalStore.getState().endSession("workflow-1", "session-1", 0);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        stepName: "Step 2",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 2,
        controllerClientId: "controller-1",
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].stepName).toBe("Step 2");
    expect(sessions[0].promptNumber).toBe(2);
    expect(sessions[0].status).toBe(TERMINAL_SESSION_STATUS.RUNNING);
  });

  it("keeps existing AI CLI sessions when a different harness starts", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "claude-session",
        stepName: "Claude step",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        harnessId: "claude-cli",
        controllerClientId: "controller-1",
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "copilot-session",
        stepName: "Copilot step",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 2,
        harnessId: "copilot-cli",
        controllerClientId: "controller-1",
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).toEqual([
      "claude-session",
      "copilot-session",
    ]);
  });

  it("replaces the previous AI CLI session for the same harness", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "old-claude-session",
        stepName: "Claude step",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        harnessId: "claude-cli",
        controllerClientId: "controller-1",
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "new-claude-session",
        stepName: "Claude restart",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 2,
        harnessId: "claude-cli",
        controllerClientId: "controller-1",
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("new-claude-session");
  });

  it("reuses a single script PTY terminal tab", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "script-session-1",
        stepName: "Script 1",
        kind: SESSION_KINDS.AI_CLI,
        controllerClientId: "controller-1",
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "script-session-2",
        stepName: "Script 2",
        kind: SESSION_KINDS.AI_CLI,
        controllerClientId: "controller-1",
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("script-session-2");
  });

  it("reclaims control when a stale replay arrives after control was already reassigned", () => {
    const postMessageMock = (window as any).vscodeApi.postMessage as ReturnType<
      typeof vi.fn
    >;
    postMessageMock.mockClear();

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.CLIENT_ID_ASSIGNED, { clientId: "browser:2" });
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "workflow-1",
      });
      dispatch(MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        controllerClientId: undefined,
      });
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "workflow-1",
      });
      dispatch(MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        controllerClientId: "browser:2",
      });
    });

    postMessageMock.mockClear();

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        stepName: "Step 1",
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        controllerClientId: "browser:1",
      });
    });

    expect(postMessageMock).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL,
      workflowId: "workflow-1",
      sessionId: "session-1",
    });
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

describe("message passthroughs", () => {
  it("queues prompt-editor insert requests and opens the editor section", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setEditorCollapsed(true);
    useEditorStore.getState().setStepType(STEP_TYPES.SCRIPT);

    act(() => {
      dispatch(MESSAGE_TYPES.INSERT_PROMPT_REFERENCES, {
        data: {
          requestId: "insert-1",
          references: ["@src/extension.ts", "@package.json"],
          mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
        },
      });
    });

    expect(useUiStore.getState().editorCollapsed).toBe(false);
    expect(useEditorStore.getState().stepType).toBe(STEP_TYPES.PROMPT);
    expect(useEditorStore.getState().pendingPromptEditorInserts).toEqual([
      {
        requestId: "insert-1",
        references: ["@src/extension.ts", "@package.json"],
        mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
      },
    ]);
  });

  it("does not warn for context reference validation replies handled by the editor", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.CONTEXT_REFS_VALIDATION, {
        seq: 1,
        results: [],
      });
    });

    expect(webviewWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Unknown message type")
    );
  });
});

// ---------------------------------------------------------------------------
// PRIOR_CONTEXT_PREVIEW_RESULT
// ---------------------------------------------------------------------------

describe("PRIOR_CONTEXT_PREVIEW_RESULT", () => {
  it("opens the content preview modal with xml language", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.PRIOR_CONTEXT_PREVIEW_RESULT, {
        ref: "previous",
        content: "<priorContext><step>...</step></priorContext>",
      });
    });

    const modal = useUiStore.getState().contentPreviewModal;
    expect(modal).not.toBeNull();
    expect(modal?.language).toBe("xml");
    expect(modal?.ref).toBe("previous");
    expect(modal?.content).toContain("<priorContext>");
  });

  it("includes the ref in the title", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.PRIOR_CONTEXT_PREVIEW_RESULT, {
        ref: "step:1,3",
        content: "",
      });
    });

    expect(useUiStore.getState().contentPreviewModal?.title).toContain(
      "step:1,3"
    );
  });

  it("does not warn about unknown message type", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.PRIOR_CONTEXT_PREVIEW_RESULT, {
        ref: "all",
        content: "",
      });
    });

    expect(webviewWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Unknown message type")
    );
  });
});
