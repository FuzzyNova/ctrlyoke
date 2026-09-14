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
import {
  COMPLETION_NOTIFICATION_SEVERITY,
  OUTPUT_TABS,
} from "@root/types/DashboardConstants";

const { handleCompletionNotificationEventMock } = vi.hoisted(() => ({
  handleCompletionNotificationEventMock: vi.fn(),
}));

const { webviewWarnMock } = vi.hoisted(() => ({
  webviewWarnMock: vi.fn(),
}));

vi.mock("@utils/browserNotifications", () => ({
  getNotificationSeverityColor: (severity: string) =>
    severity === COMPLETION_NOTIFICATION_SEVERITY.ERROR
      ? "error"
      : severity === COMPLETION_NOTIFICATION_SEVERITY.WARNING
        ? "warning"
        : "info",
  handleCompletionNotificationEvent: handleCompletionNotificationEventMock,
}));

vi.mock("@utils/logger", () => ({
  WebviewLog: {
    trace: vi.fn(),
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
import { useWorkspaceStatsStore } from "@store/workspaceStatsStore";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { getWorkflowDefinitionMutation } from "@utils/workflowMutation";
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
import {
  STEP_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";
import { workflowViewAddressKey } from "@utils/viewAddress";

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
    appliedDefinitionRevision: null,
    executionRunRef: null,
  });
  useEditorStore.getState().resetEditor();
  useTerminalStore.setState({ sessions: {}, activeSessionIds: {} });
  useWorkspaceStatsStore.setState({ snapshot: undefined });
  useCompatibilityStore.getState().resetCapabilitySnapshot();
  handleCompletionNotificationEventMock.mockReset();
  webviewWarnMock.mockReset();
  sessionStorage.clear();
  vi.useRealTimers();
  // Reset reconnect watchdog per-page-load flag so tests are independent.
  reconnectWatchdog.clearFreshPageReadySent();
});

describe("WORKSPACE_STATS_UPDATED", () => {
  it("stores the workspace snapshot separately from harness usage", () => {
    const snapshot = {
      updatedAt: 1,
      workflowCount: 1,
      runCount: 1,
      outcomes: { completed: 1, stopped: 0, error: 0 },
      totalActiveExecutionMs: 1000,
      wallClockDurationRunCount: 0,
      skippedRunCount: 0,
      totals: {
        input: 1,
        output: 2,
        total: 3,
        attemptCount: 1,
        reportedAttemptCount: 1,
      },
      byHarness: {},
      backfill: { state: "complete", scanned: 1, total: 1 },
    } as any;

    createMessageHandlers(false)[MESSAGE_TYPES.WORKSPACE_STATS_UPDATED]({
      snapshot,
    });

    expect(useWorkspaceStatsStore.getState().snapshot).toBe(snapshot);
  });
});

describe("HARNESS_CAPABILITY_SNAPSHOT", () => {
  it("uses the same snapshot seam for hosted panel and standalone delivery", () => {
    const snapshot = {
      schemaVersion: 1,
      enabledDomains: ["hooks"],
      harnesses: {},
    } as any;

    for (const standalone of [false, true]) {
      useCompatibilityStore.getState().resetCapabilitySnapshot();
      createMessageHandlers(standalone)[
        MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT
      ]({ data: { snapshot } } as any);
      expect(useCompatibilityStore.getState().capabilitySnapshot).toBe(
        snapshot
      );
    }
  });
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

  it("clears the displayed address and run directory together", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "old-workflow" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "old-run" as never,
      },
      displayedRunDirectory: "/runs/old-workflow/old-run",
    });
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "new-workflow.ctrlyoke.json",
        steps: [makePrompt("New workflow step")],
      });
    });

    expect(useUiStore.getState().displayedViewAddress).toBeNull();
    expect(useUiStore.getState().displayedRunDirectory).toBeNull();
  });

  it("does not attach the previous lineage's runs to a new workflow identity", () => {
    const previousWorkflowKey = "previous-workflow" as never;
    const previousRunRef = "run-previous-2" as never;
    useUiStore.getState().setDisplayedRunView(
      {
        workflowKey: previousWorkflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: previousRunRef,
      },
      [
        {
          workflowKey: previousWorkflowKey,
          runRef: previousRunRef,
          runDirectory: "/runs/previous/run-2",
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
          runDirectory: "/runs/previous/run-1",
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
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        definitionRevision: 1,
        descriptorRevision: 1,
      });
    });

    const ui = useUiStore.getState();
    expect(ui.displayedViewAddress).toEqual({
      workflowKey: "new-workflow",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
  it.each([3, 4])(
    "applies a replay snapshot at an equal-or-higher definition revision (%s)",
    (definitionRevision) => {
      renderHook(() => useMessageHandler());
      const address = {
        workflowKey: "wf-session-replay" as never,
        kind: "run" as const,
        runRef: "run-session-replay" as never,
      };
      useUiStore.setState({
        displayedViewAddress: address,
        appliedViewAddress: address,
        displayedDefinitionRevision: 3,
        appliedDefinitionRevision: 3,
      });
      useWorkflowStore.setState({ steps: [makePrompt("old step")] });

      act(() => {
        dispatch(MESSAGE_TYPES.SESSION_RESTORED, {
          fileName: "replayed.ctrlyoke.yaml",
          steps: [makePrompt("replayed step")],
          results: [],
          executionState: EXECUTION_STATES.RUNNING,
          currentIndex: 0,
          definitionRevision,
        });
      });

      expect(
        useWorkflowStore
          .getState()
          .steps.map((step) => ("prompt" in step ? step.prompt : undefined))
      ).toEqual(["replayed step"]);
      expect(useUiStore.getState().appliedDefinitionRevision).toBe(
        definitionRevision
      );
    }
  );

  it("does not let a lower-revision replay replace newer steps or disarm the guard", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-session-replay" as never,
      kind: "run" as const,
      runRef: "run-session-replay" as never,
    };
    useUiStore.setState({
      displayedViewAddress: address,
      appliedViewAddress: address,
      displayedDefinitionRevision: 3,
      appliedDefinitionRevision: 3,
    });
    const currentSteps = [makePrompt("newer step")];
    useWorkflowStore.setState({ steps: currentSteps });

    act(() => {
      dispatch(MESSAGE_TYPES.SESSION_RESTORED, {
        fileName: "replayed.ctrlyoke.yaml",
        steps: [makePrompt("stale step"), makePrompt("also stale")],
        results: [],
        executionState: EXECUTION_STATES.RUNNING,
        currentIndex: 0,
        definitionRevision: 2,
      });
    });

    expect(useWorkflowStore.getState().steps).toBe(currentSteps);
    expect(useUiStore.getState().appliedDefinitionRevision).toBe(3);
  });

  it("applies a revisionless session replace even when it looks regressive", () => {
    renderHook(() => useMessageHandler());
    const address = {
      workflowKey: "wf-being-left" as never,
      kind: "run" as const,
      runRef: "run-being-left" as never,
    };
    useUiStore.setState({
      displayedViewAddress: address,
      appliedViewAddress: address,
      displayedDefinitionRevision: 5,
      appliedDefinitionRevision: 5,
    });
    useWorkflowStore.setState({
      steps: [makePrompt("a"), makePrompt("b"), makePrompt("c")],
    });

    // PromptFileLoader's restore branch replaces the displayed workflow with a
    // different one and deliberately sends no definitionRevision. Its revision
    // and step count are unrelated to the workflow being navigated away from,
    // so the regressive-snapshot guard must not apply and the stale view
    // address must be cleared.
    act(() => {
      dispatch(MESSAGE_TYPES.SESSION_RESTORED, {
        fileName: "other-workflow.ctrlyoke.yaml",
        steps: [makePrompt("other workflow step")],
        results: [],
        executionState: EXECUTION_STATES.IDLE,
        currentIndex: 0,
      });
    });

    expect(
      useWorkflowStore
        .getState()
        .steps.map((step) => ("prompt" in step ? step.prompt : undefined))
    ).toEqual(["other workflow step"]);
    expect(useUiStore.getState().appliedViewAddress).toBeNull();
    expect(useUiStore.getState().appliedDefinitionRevision).toBeNull();
  });

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

  it("clears the system-generated lockdown when restoring a new workflow", () => {
    useUiStore.setState({ viewedLineageIsSystemGenerated: true });
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.SESSION_RESTORED, {
        fileName: "new-workflow.ctrlyoke.yaml",
        workflowName: "New Workflow",
        steps: [],
        results: [],
        executionState: EXECUTION_STATES.IDLE,
        currentIndex: 0,
        workflowProperties: {},
      });
    });

    expect(useUiStore.getState().viewedLineageIsSystemGenerated).toBe(false);
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
// OPEN_NEW_WORKFLOW_MODAL
// ---------------------------------------------------------------------------

describe("OPEN_NEW_WORKFLOW_MODAL", () => {
  it("opens the custom-template form when requested by the command", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL, {
        templates: [
          {
            id: "blank",
            name: "Blank",
            description: "",
            isBuiltIn: true,
          },
        ],
        defaultTemplateId: "blank",
        openCreateTemplateForm: true,
      });
    });

    expect(useUiStore.getState().newWorkflowModalOpen).toBe(true);
    expect(useUiStore.getState().openCreateTemplateForm).toBe(true);
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
          runDirectory: "/runs/workflow-1/current",
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
  it("uses native panel feedback when the folder could not be opened", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT, {
        success: false,
        error:
          "The workspace skill folder does not exist yet: C:\\dev\\ctrlyoke\\.ctrlyoke\\skills",
      });
    });

    expect(useUiStore.getState().toastQueue).toEqual([]);
    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
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

    const address = {
      workflowKey: "wf-1" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    } as const;

    act(() => {
      useUiStore.getState().setPendingHistorySearchNavigation({
        address,
        findQuery: "needle",
        target: { kind: "queue", stepIndex: 0 },
      });
      useUiStore
        .getState()
        .toggleHiddenOutputTarget(workflowViewAddressKey(address), "queue:0");
    });

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
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
    expect(
      useUiStore.getState().hiddenOutputTargets[workflowViewAddressKey(address)]
    ).toBeUndefined();
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
        appliedDefinitionRevision: 1,
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

describe("RUN_VIEW_LOADED stale execution state regression", () => {
  // Reproduces the "ExecutingStepHighlight / Running badge flashes then
  // vanishes" bug: pressing Run on a brand-new draft promotes it to a run and
  // starts execution. EXECUTION_STARTED lands first and sets RUNNING, but
  // `syncExecutingRunViews` reads the promoted run's working file straight off
  // disk to build this client's first RUN_VIEW_LOADED for the new run
  // address — a read that can finish before the executor's own write
  // persists RUNNING, so it carries the pre-start "idle" snapshot. That
  // snapshot must not be allowed to revert the live execution state just
  // because the client was still addressed at the draft a moment ago.
  it("keeps RUNNING when a draft-promotion snapshot arrives with a stale idle state", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    const draftAddress = {
      workflowKey: "wf-fresh" as never,
      kind: "draft" as const,
    };
    const runAddress = {
      workflowKey: "wf-fresh" as never,
      kind: "run" as const,
      runRef: "run-2026-09-01T10-00-00-000Z" as never,
    };
    useUiStore.setState({
      appliedViewAddress: draftAddress,
      pendingRunViewRequestId: null,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf-fresh.yaml",
        totalSteps: 1,
      });
    });
    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.RUNNING
    );

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: runAddress,
        workingFile: {
          workflowName: "Fresh workflow",
          definitionRevision: 1,
          steps: [makePrompt("first")],
          _runtime: {
            executionState: EXECUTION_STATES.IDLE,
            currentIndex: 0,
          },
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
        // The backend always reports the lineage's executing run alongside the
        // snapshot; during the promotion race that is this very address.
        executionRunRef: runAddress.runRef,
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.RUNNING
    );
  });

  // A stricter variant of the above: a brand-new workflow (New Workflow ->
  // type a prompt -> Run) whose draft never received its own RUN_VIEW_LOADED
  // before being promoted. appliedViewAddress is therefore null (or unrelated)
  // rather than naming the draft, so neither an exact address match nor a
  // same-lineage (workflowKey) match against it can ever succeed — the guard
  // must not depend on appliedViewAddress at all to catch this race, since
  // the promoted run's first-ever RUN_VIEW_LOADED is exactly this case.
  it("keeps RUNNING when a first-ever run snapshot arrives with a stale idle state and no prior applied view", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    const runAddress = {
      workflowKey: "wf-brand-new" as never,
      kind: "run" as const,
      runRef: "run-2026-09-02T01-14-06-645Z" as never,
    };
    useUiStore.setState({
      appliedViewAddress: null,
      pendingRunViewRequestId: null,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf-brand-new.yaml",
        totalSteps: 1,
      });
    });
    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.RUNNING
    );

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: runAddress,
        workingFile: {
          workflowName: "test first",
          definitionRevision: 1,
          steps: [makePrompt("just say hi")],
          _runtime: {
            executionState: EXECUTION_STATES.IDLE,
            currentIndex: 0,
          },
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
        executionRunRef: runAddress.runRef,
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.RUNNING
    );
  });

  // The other side of the guard, and the bug it originally caused: a mobile
  // PWA backgrounded mid-run misses the completion, and its resumed page
  // reconnects still holding RUNNING. The reconnect's requestless snapshot
  // carries the truth (COMPLETED) and no executionRunRef, because nothing is
  // executing that lineage any more — so it must be applied, not rejected as
  // a stale disk read. Left rejected, OutputSection reads the phantom RUNNING
  // as a live run and wipes the history this same snapshot just loaded,
  // blanking the output pane with no path back short of a workflow switch.
  it("applies a completed reconnect snapshot when nothing is executing the lineage", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    const runAddress = {
      workflowKey: "wf-resumed" as never,
      kind: "run" as const,
      runRef: "run-2026-09-06T19-10-27-671Z" as never,
    };
    useUiStore.setState({
      appliedViewAddress: runAddress,
      pendingRunViewRequestId: null,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf-resumed.yaml",
        totalSteps: 1,
      });
    });
    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.RUNNING
    );

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: runAddress,
        workingFile: {
          workflowName: "Rainbow plan",
          definitionRevision: 1,
          steps: [makePrompt("first")],
          _runtime: {
            executionState: EXECUTION_STATES.COMPLETED,
            currentIndex: 1,
          },
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
        // Nothing is executing this lineage any more.
        executionRunRef: undefined,
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.COMPLETED
    );
  });

  // A completed snapshot for an *older* run of a lineage whose newer run is
  // executing is likewise authoritative about that older run.
  it("applies a completed snapshot for a run other than the executing one", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    const olderRunAddress = {
      workflowKey: "wf-two-runs" as never,
      kind: "run" as const,
      runRef: "run-2026-09-06T18-00-00-000Z" as never,
    };
    useUiStore.setState({
      appliedViewAddress: olderRunAddress,
      pendingRunViewRequestId: null,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf-two-runs.yaml",
        totalSteps: 1,
      });
    });

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: olderRunAddress,
        workingFile: {
          workflowName: "Two runs",
          definitionRevision: 1,
          steps: [makePrompt("first")],
          _runtime: {
            executionState: EXECUTION_STATES.COMPLETED,
            currentIndex: 1,
          },
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
        executionRunRef: "run-2026-09-06T19-10-27-671Z",
      });
    });

    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.COMPLETED
    );
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-2026-07-20T10-30-00-000Z" as never,
      },
    });

    act(() => {
      dispatch(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, {
        workflowId: "new-instance",
      });
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: {
          workflowKey: "new-workflow" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
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
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
    expect(useWorkflowStore.getState().workflowName).toBe("New workflow");
  });

  it("stores definition and descriptor revisions for the next addressed edit", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address: {
          workflowKey: "wf-1" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
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
        appliedDefinitionRevision: 3,
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
        appliedViewAddress: address,
        displayedDefinitionRevision: 5,
        appliedDefinitionRevision: 5,
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

  it("applies the snapshot that follows a write's early identity publish", () => {
    // Every run-addressed write now publishes WORKFLOW_VIEW_IDENTITY as soon as
    // it is durable and lets the (far slower) RUN_VIEW_LOADED snapshot follow,
    // so the client can act on the write immediately instead of echoing a
    // superseded revision for as long as the snapshot takes to build. That
    // leaves the displayed revision equal to the incoming snapshot's, so the
    // snapshot must be judged against the revision whose content is actually
    // applied — otherwise a write that removed a step is discarded as
    // regressive and the deleted step stays on screen forever.
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
        displayedDefinitionRevision: 7,
        appliedDefinitionRevision: 7,
        displayedDescriptorRevision: 2,
      });
      useWorkflowStore.setState({
        steps: [makePrompt("a"), makePrompt("b"), makePrompt("c")],
      });

      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address,
        definitionRevision: 8,
        descriptorRevision: 2,
      });
    });

    // Armed for the next action right away; the content is still the old one.
    expect(useUiStore.getState().displayedDefinitionRevision).toBe(8);
    expect(useUiStore.getState().appliedDefinitionRevision).toBe(7);

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: {
          workflowName: "Deleted a step",
          definitionRevision: 8,
          steps: [makePrompt("a"), makePrompt("c")],
        },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 2,
      });
    });

    expect(useWorkflowStore.getState().steps).toHaveLength(2);
    expect(useUiStore.getState().appliedDefinitionRevision).toBe(8);
  });

  it("re-arms the next edit with the revisions a write just produced", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      displayedDefinitionRevision: 3,
      displayedDescriptorRevision: 4,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address: {
          workflowKey: "wf-1" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
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

  it("restores the system-generated lockdown a SESSION_RESTORED replay cleared", () => {
    // Reproduces the "commit-message-generation banner flashes then vanishes"
    // bug: binding a client to a *running* instance sends RUN_VIEW_LOADED
    // (setting the lockdown) followed by replayFullStateTo's raw
    // SESSION_RESTORED (which clears it via applyWorkflowChange), then
    // re-publishes WORKFLOW_VIEW_IDENTITY to restore the address — that
    // identity publish must also restore the lockdown, or it never comes back
    // while the workflow keeps running.
    renderHook(() => useMessageHandler());
    // resetUi() (in the file-level beforeEach) does not clear
    // pendingRunViewRequestId, so a prior test's in-flight request ID can
    // otherwise leak in and make RUN_VIEW_LOADED look stale below.
    useUiStore.setState({ pendingRunViewRequestId: null });
    const address = {
      workflowKey: "commit-message-generation" as never,
      kind: "run" as const,
      runRef: "run-2026-08-29T17-27-01-636Z" as never,
    };

    act(() => {
      dispatch(MESSAGE_TYPES.RUN_VIEW_LOADED, {
        address,
        workingFile: { workflowName: "commit-message-generation", steps: [] },
        workflowProperties: {},
        runSummaries: [],
        history: null,
        descriptorRevision: 1,
        isSystemGenerated: true,
      });
    });
    expect(useUiStore.getState().viewedLineageIsSystemGenerated).toBe(true);

    act(() => {
      dispatch(MESSAGE_TYPES.SESSION_RESTORED, {
        fileName: "commit-message-generation.ctrlyoke.yaml",
        steps: [],
        results: [],
        executionState: EXECUTION_STATES.RUNNING,
        currentIndex: 0,
        workflowProperties: {},
      });
    });
    expect(useUiStore.getState().viewedLineageIsSystemGenerated).toBe(false);

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, {
        address,
        definitionRevision: 1,
        descriptorRevision: 1,
        isSystemGenerated: true,
      });
    });
    expect(useUiStore.getState().viewedLineageIsSystemGenerated).toBe(true);
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

  // A rejected navigation must land somewhere coherent. Retiring the request
  // without undoing its optimistic address move left the header naming the
  // workflow that failed to load while the panels still rendered the previous
  // one, with every addressed control aimed at the wrong lineage.
  it("rolls the view back to the workflow still on screen when a load is rejected", () => {
    renderHook(() => useMessageHandler());
    const previousAddress = {
      workflowKey: "wf-current" as never,
      kind: "draft" as const,
    };
    useUiStore.setState({
      displayedViewAddress: previousAddress,
      appliedViewAddress: previousAddress,
      displayedDefinitionRevision: 9,
      appliedDefinitionRevision: 9,
    });

    let requestId = "";
    act(() => {
      requestId = useUiStore.getState().requestRunViewLoad(
        {
          workflowKey: "wf-unreachable" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        []
      );
    });
    expect(useUiStore.getState().displayedViewAddress).toEqual({
      workflowKey: "wf-unreachable",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_ACTION_FAILED, {
        action: "load run",
        error: "ctrlyoke is still starting up — try again in a moment",
        requestId,
      });
    });

    const ui = useUiStore.getState();
    expect(ui.pendingRunViewRequestId).toBeNull();
    expect(ui.displayedViewAddress).toEqual(previousAddress);
    expect(ui.displayedDefinitionRevision).toBe(9);
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
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

describe("WORKFLOW_ACTION_FAILED feedback host routing", () => {
  it.each([
    ["panel", false, 0],
    ["standalone", true, 1],
  ] as const)(
    "%s mode produces the expected toast count",
    async (_host, standalone, expectedToastCount) => {
      vi.resetModules();
      window.__ctrlyokeStandalone = standalone;

      try {
        const [{ createMessageHandlers }, { useUiStore }] = await Promise.all([
          import("@hooks/useMessageHandler"),
          import("@store/uiStore"),
        ]);
        useUiStore.getState().resetUi();
        vi.mocked(window.vscodeApi?.postMessage ?? vi.fn()).mockClear();

        act(() => {
          createMessageHandlers()[MESSAGE_TYPES.WORKFLOW_ACTION_FAILED]({
            action: "save workflow",
            error: "The file is read-only.",
          });
        });

        expect(useUiStore.getState().toastQueue).toHaveLength(
          expectedToastCount
        );
        if (!standalone) {
          expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
            type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
            severity: USER_FEEDBACK_SEVERITY.ERROR,
            message: "Failed to save workflow: The file is read-only.",
          });
        }
      } finally {
        window.__ctrlyokeStandalone = false;
      }
    }
  );
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
            eventKind: "response",
            matchField: "content",
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
            eventKind: "prompt",
            matchField: "content",
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

  it("keeps live output isolated between hosted tabs with different selected runs", () => {
    renderHook(() => useMessageHandler());
    const executingRunRef = "run-2026-07-20T13-00-00-000Z" as never;
    const historicalRunRef = "run-2026-07-20T12-00-00-000Z" as never;
    useUiStore.setState({
      activeWorkflowId: "instance-1",
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: historicalRunRef,
      },
      executionRunRef: executingRunRef,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.CLI_STREAMING_CHUNK, {
        workflowId: "instance-1",
        stepIndex: 0,
        chunk: "historical tab must not receive this",
      });
    });
    expect(useWorkflowStore.getState().streamingChunks).toEqual({});

    // The same live update is accepted by the other hosted tab, which is
    // selected on the executing address.
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: executingRunRef,
      },
    });
    act(() => {
      dispatch(MESSAGE_TYPES.CLI_STREAMING_CHUNK, {
        workflowId: "instance-1",
        stepIndex: 0,
        chunk: "executing tab receives this",
      });
    });
    expect(useWorkflowStore.getState().streamingChunks).toEqual({
      "queue:0:run:0:attempt:0:prompt:text": "executing tab receives this",
    });
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

  it("patches the matching recent-workflow row's state in place so the dropdown doesn't need a reopen", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      useUiStore.getState().setRecentWorkflows([
        {
          address: {
            workflowKey: "wf-recent" as never,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: "run-2026-07-20T10-30-00-000Z" as never,
          },
          workflowName: "Recent workflow",
          executionState: EXECUTION_STATES.RUNNING,
          totalSteps: 3,
        },
      ]);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, {
        summary: {
          id: "instance-recent",
          workflowKey: "wf-recent",
          workflowName: "Recent workflow",
          filePath: "C:\\wf-recent.ctrlyoke.json",
          executionState: EXECUTION_STATES.COMPLETED,
          currentStep: 3,
          totalSteps: 3,
        },
      });
    });

    expect(useUiStore.getState().recentWorkflows[0]?.executionState).toBe(
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

  it("stores live context for an active step after the group join index", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
      });
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
      useWorkflowStore.getState().setCurrentStep(0);
      useWorkflowStore.getState().setStepStatus(1, STEP_STATUS.RUNNING);
    });

    act(() => {
      dispatch(MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE, {
        stepIndex: 1,
        used: 100000,
        size: 200000,
      });
    });

    expect(useWorkflowStore.getState().liveContextWindow[1]).toEqual({
      used: 100000,
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
  it("adopts the appended definition revision before execution completes", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-key" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-ref" as never,
      },
      displayedDefinitionRevision: 2,
      displayedDescriptorRevision: 7,
    });

    act(() => {
      dispatch(MESSAGE_TYPES.STEPS_EXTENDED, {
        steps: [makePrompt("Step 0"), makePrompt("Step 1")],
        definitionRevision: 3,
      });
    });

    expect(useUiStore.getState().displayedDefinitionRevision).toBe(3);
    expect(getWorkflowDefinitionMutation()).toMatchObject({
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });

  it("does not regress the definition revision on a duplicate stale update", () => {
    renderHook(() => useMessageHandler());
    useUiStore.setState({ displayedDefinitionRevision: 3 });

    act(() => {
      dispatch(MESSAGE_TYPES.STEPS_EXTENDED, {
        steps: [makePrompt("Step 0")],
        definitionRevision: 2,
      });
    });

    expect(useUiStore.getState().displayedDefinitionRevision).toBe(3);
  });

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

  it("does not record runtime topology echoes in the undo stack", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.FILE_SELECTED, {
        fileName: "wf.yaml",
        steps: [makePrompt("running"), makePrompt("sibling")],
      });
    });
    useWorkflowStore.temporal.getState().clear();

    act(() => {
      dispatch(MESSAGE_TYPES.STEPS_EXTENDED, {
        steps: [makePrompt("running"), makePrompt("sibling")],
        executionState: EXECUTION_STATES.RUNNING,
        parallelGroups: [
          { id: "promoted", startIndex: 0, endIndex: 1, failFast: false },
        ],
      });
    });

    expect(useWorkflowStore.getState().parallelGroups).toEqual([
      { id: "promoted", startIndex: 0, endIndex: 1, failFast: false },
    ]);
    expect(useWorkflowStore.temporal.getState().pastStates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_STARTED
// ---------------------------------------------------------------------------

describe("EXECUTION_STARTED", () => {
  it("preserves step-zero output published before a continuation start", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useWorkflowStore.getState().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt("Step 1"), makePrompt("Step 2")],
    });
    const setupOutput = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: {
        prompt: "worktree setup",
        response: "setup output",
        elapsed: 1,
        isStreaming: false,
      },
      timestampMs: 1000,
      sequence: 0,
    };
    useWorkflowStore.getState().appendLiveEntry(setupOutput);

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 2,
        isContinuation: true,
        preserveStepCount: 1,
      });
    });

    expect(useWorkflowStore.getState().liveOrderedEntries).toContainEqual(
      setupOutput
    );
  });

  it("syncs executionRunRef and the run's cached summary immediately on a continuation of the displayed run", () => {
    renderHook(() => useMessageHandler());
    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useWorkflowStore.getState().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt("Step 1"), makePrompt("Step 2")],
    });
    const runRef = "run-2026-01-01T00-00-00-000Z" as never;
    // The client is already displaying this run, and its cached summary is
    // still the pre-continuation "completed" snapshot — the state a client
    // is left in immediately after Continue/Append is clicked, before the
    // backend's own run-view refresh (which does not target a client already
    // addressed at this run) arrives.
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-key" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      executionRunRef: null,
      runSummaries: [
        {
          workflowKey: "wf-key",
          runRef,
          runDirectory: "/runs/1",
          runId: 1,
          startedAt: 0,
          executionState: EXECUTION_STATES.COMPLETED,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        } as never,
      ],
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

    const ui = useUiStore.getState();
    expect(ui.executionRunRef).toBe(runRef);
    expect(ui.runSummaries[0]?.executionState).toBe(EXECUTION_STATES.RUNNING);
  });

  it("expands the output section and shows output for headless runs when auto-focus is enabled", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useUiStore
      .getState()
      .setActiveOutputTab("workflow-1", OUTPUT_TABS.TERMINAL);
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
    useUiStore
      .getState()
      .setActiveOutputTab("workflow-1", OUTPUT_TABS.TERMINAL);
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

  it("focuses output for headless steps and leaves interactive steps to TERMINAL_STARTED", () => {
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

    // An interactive step may open with a pre-condition that runs headlessly and
    // can end the step before any PTY exists, so execution start must not move
    // the view to an empty terminal. TERMINAL_STARTED owns that switch.
    dispatchStepStart("interactive");
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe("output");

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "session-1",
        stepName: "Step 1",
        stepIndex: 0,
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 1,
        controllerClientId: "controller-1",
      });
    });
    expect(useUiStore.getState().activeOutputTabs["workflow-1"]).toBe(
      "terminal"
    );
  });

  it("does not expand or switch the output view for an interactive step that has not spawned a terminal", () => {
    renderHook(() => useMessageHandler());

    useUiStore.getState().setActiveWorkflowId("workflow-1");
    useUiStore.getState().setOutputCollapsed(true);
    useUiStore.getState().setActiveOutputTab("workflow-1", OUTPUT_TABS.OUTPUT);
    useSettingsStore
      .getState()
      .updateGlobalSetting("autoFocusOutputOnExecution", true);

    act(() => {
      dispatch(MESSAGE_TYPES.EXECUTION_STARTED, {
        workflowId: "workflow-1",
        fileName: "wf.yaml",
        totalSteps: 1,
        executionMode: "interactive",
      });
    });

    expect(useUiStore.getState().outputCollapsed).toBe(true);
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
    useUiStore.getState().setActiveOutputTab("workflow-1", OUTPUT_TABS.OUTPUT);
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
    useUiStore.getState().setActiveOutputTab("workflow-1", OUTPUT_TABS.OUTPUT);
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
        stepIndex: 1,
        kind: SESSION_KINDS.AI_CLI,
        promptNumber: 2,
        controllerClientId: "controller-1",
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].stepName).toBe("Step 2");
    expect(sessions[0].stepIndex).toBe(1);
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

  it("preserves same-harness parallel sessions as separate labeled tabs", () => {
    renderHook(() => useMessageHandler());

    for (const session of [
      {
        sessionId: "parallel-1",
        stepIndex: 1,
        stepName: "Research auth",
      },
      {
        sessionId: "parallel-2",
        stepIndex: 2,
        stepName: "Research database",
      },
      {
        sessionId: "parallel-3",
        stepIndex: 3,
        stepName: "Research performance",
      },
    ]) {
      act(() => {
        dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
          workflowId: "workflow-1",
          sessionId: session.sessionId,
          stepIndex: session.stepIndex,
          stepName: session.stepName,
          kind: SESSION_KINDS.AI_CLI,
          promptNumber: session.stepIndex + 1,
          harnessId: "claude-cli",
          parallelGroupId: "group-1",
          controllerClientId: "controller-1",
        });
      });
    }

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(3);
    expect(
      sessions.map((session) => [session.stepIndex, session.stepName])
    ).toEqual([
      [1, "Research auth"],
      [2, "Research database"],
      [3, "Research performance"],
    ]);
    expect(sessions.every((session) => session.isController)).toBe(false);
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

  it("preserves parallel script PTYs as separate tabs", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "script-session-1",
        stepIndex: 1,
        stepName: "Check auth",
        kind: SESSION_KINDS.AI_CLI,
        parallelGroupId: "group-1",
        controllerClientId: "controller-1",
      });
      dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
        workflowId: "workflow-1",
        sessionId: "script-session-2",
        stepIndex: 2,
        stepName: "Check database",
        kind: SESSION_KINDS.AI_CLI,
        parallelGroupId: "group-1",
        controllerClientId: "controller-1",
      });
    });

    const sessions = useTerminalStore.getState().sessions["workflow-1"];
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.parallelGroupId)).toEqual([
      "group-1",
      "group-1",
    ]);
  });

  it("keeps workflow-scoped controller arbitration for every replayed parallel session", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      for (const sessionId of ["parallel-1", "parallel-2"]) {
        dispatch(MESSAGE_TYPES.TERMINAL_STARTED, {
          workflowId: "workflow-1",
          sessionId,
          stepIndex: sessionId.endsWith("1") ? 1 : 2,
          stepName: sessionId,
          kind: SESSION_KINDS.AI_CLI,
          harnessId: "claude-cli",
          parallelGroupId: "group-1",
          controllerClientId: "controller-1",
        });
      }
      dispatch(MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED, {
        workflowId: "workflow-1",
        sessionId: "parallel-1",
        controllerClientId: "browser:2",
      });
      dispatch(MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED, {
        workflowId: "workflow-1",
        sessionId: "parallel-2",
        controllerClientId: "browser:2",
      });
    });

    expect(
      useTerminalStore
        .getState()
        .sessions["workflow-1"].map((session) => session.isController)
    ).toEqual([false, false]);
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

// ---------------------------------------------------------------------------
// MCP_CONFIG_PREVIEW_RESULT
// ---------------------------------------------------------------------------

describe("MCP_CONFIG_PREVIEW_RESULT", () => {
  it("opens the content preview modal with json language when found", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT, {
        mcpServerName: "playwright",
        content: '{\n  "id": "playwright"\n}',
        found: true,
      });
    });

    const modal = useUiStore.getState().contentPreviewModal;
    expect(modal).not.toBeNull();
    expect(modal?.language).toBe("json");
    expect(modal?.ref).toBe("playwright");
    expect(modal?.title).toContain("playwright");
    expect(modal?.content).toContain('"id": "playwright"');
  });

  it("uses native panel feedback instead of a modal when not found", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT, {
        mcpServerName: "unknown-server",
        content: "",
        found: false,
      });
    });

    expect(useUiStore.getState().contentPreviewModal).toBeNull();
    expect(useUiStore.getState().toastQueue).toEqual([]);
    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
      message: expect.stringContaining("unknown-server"),
      severity: USER_FEEDBACK_SEVERITY.WARNING,
    });
  });

  it("does not warn about unknown message type", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      dispatch(MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT, {
        mcpServerName: "playwright",
        content: "{}",
        found: true,
      });
    });

    expect(webviewWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Unknown message type")
    );
  });
});
