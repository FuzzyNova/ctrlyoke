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

import { useMessageHandler } from "@hooks/useMessageHandler";
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
} from "@/types/messages";
import type { PromptStep } from "@/types/messages";
import { STEP_TYPES } from "@root/types/DashboardConstants";

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
  useUiStore.setState({ displayedViewAddress: null, executionRunRef: null });
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
    useUiStore.getState().setHistoryView(1, 3);

    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "new.ctrlyoke.yaml",
        steps: [makePrompt("Step 1")],
      });
    });

    expect(useUiStore.getState().isViewingHistory).toBe(false);
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

describe("STARTUP_COMPLETE", () => {
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
});

// ---------------------------------------------------------------------------
// NOTIFICATION_EVENT
// ---------------------------------------------------------------------------

describe("NOTIFICATION_EVENT", () => {
  it("shows an in-app toast and delegates browser delivery", () => {
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

    expect(useUiStore.getState().toast).toEqual({
      message:
        "refactor.ctrlyoke.yaml - completed 2 of 4 prompts before timeout",
      type: "warning",
      visible: true,
    });
    expect(handleCompletionNotificationEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workflow:wf-1:completed",
        severity: "warning",
      }),
      fullSettings
    );
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

    expect(useUiStore.getState().toast).toEqual({
      message:
        "The workspace skill folder does not exist yet: C:\\dev\\ctrlyoke\\.ctrlyoke\\skills",
      type: "warning",
      visible: true,
    });
  });
});

// ---------------------------------------------------------------------------
// OUTPUT_HISTORY_LOADED
// ---------------------------------------------------------------------------

describe("OUTPUT_HISTORY_LOADED", () => {
  it("keeps the output view live when the newest run history arrives during execution", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
      useUiStore.getState().setHistoryView(0, 1);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.OUTPUT_HISTORY_LOADED, {
        history: {
          runId: "run-1",
          startedAt: 1000,
          completedAt: undefined,
          executionState: EXECUTION_STATES.RUNNING,
          orderedEntries: [],
          promptOutputs: {},
        },
        availableRuns: 1,
        currentRunIndex: 0,
        runTimestamps: [1000],
        runStates: [EXECUTION_STATES.RUNNING],
      });
    });

    expect(useUiStore.getState().isViewingHistory).toBe(false);
    expect(useUiStore.getState().availableRuns).toBe(1);
    expect(useUiStore.getState().runTimestamps).toEqual([1000]);
    expect(useWorkflowStore.getState().historyOutputs).toBeNull();
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
        runTimestamps: [1000],
        runStates: [EXECUTION_STATES.COMPLETED],
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

describe("run view revision snapshots", () => {
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
      });
    });

    expect(useUiStore.getState().displayedDefinitionRevision).toBe(7);
    expect(useUiStore.getState().displayedDescriptorRevision).toBe(11);
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
      .updateGlobalSetting("executionMode", "headless");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", true);

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
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
      .updateGlobalSetting("executionMode", "headless");
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", false);

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
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
      .updateGlobalSetting("executionMode", "interactive");
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
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(false);
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe(
      "terminal"
    );
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
