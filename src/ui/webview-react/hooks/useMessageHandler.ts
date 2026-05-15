/**
 * FlightPath Message Handler Hook
 *
 * Central message handler that routes messages from the extension to appropriate stores.
 * Migrated from vanilla JS message-router.js to React hook pattern.
 *
 * Features:
 * - Routes all extension messages to Zustand stores
 * - Provides sendMessage helper for outgoing messages
 * - Sets up message listener with proper cleanup
 */
import { useEffect, useCallback, useMemo } from "react";
import { getVsCodeApi, isStandalone } from "./useVsCodeApi";
import { useWorkflowStore } from "../store/workflowStore";
import {
  useSettingsStore,
  type WorkflowProperties,
} from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { useEditorStore } from "../store/editorStore";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  EXECUTION_MODES,
  STEP_STATUS,
  EDITOR_TARGET_KINDS,
  SESSION_KINDS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  type ExecutionState,
  type StepStatus,
  type HarnessId,
  type WorkflowSummary,
  type UndoRecordUpdatedMessage,
} from "../types/messages";
import type {
  OrderedCliHistoryEntry,
  OrderedStatusHistoryEntry,
  OutputExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import type { TerminalSettings } from "@root/types/WebviewMessageTypes";
import { WebviewLog } from "@utils/logger";
import { isWorkflowActive } from "../utils/status";
import { useTerminalStore } from "../store/terminalStore";
import { useHarnessFileStore } from "../store/useHarnessFileStore";
import { terminalRegistry } from "../terminalRegistry";
import { registerTerminalHandlers } from "./terminalMessageHandlers";
import { rememberUndoRedoRuntime } from "@hooks/useUndoRedoKeyHandler";
import {
  clearPanelReconnectReloadWatchdog,
  schedulePanelReconnectReloadWatchdog,
} from "./reconnectWatchdog";
import {
  getNotificationSeverityColor,
  handleCompletionNotificationEvent,
} from "@utils/browserNotifications";
import { autoFocusOutputOnExecution } from "@utils/executionOutputFocus";

// ============================================================================
// Types
// ============================================================================

export type MessageHandler = (message: any) => void;
export type MessageHandlerMap = Record<string, MessageHandler>;

export interface UseMessageHandlerReturn {
  /** Send a message to the extension */
  sendMessage: (type: string, payload?: Record<string, unknown>) => void;
}

// ============================================================================
// Send Message Helper
// ============================================================================

/**
 * Send a message to the extension
 * Can be used outside of React components via direct import
 */
export function sendMessage(
  type: string,
  payload?: Record<string, unknown>
): void {
  const vscode = getVsCodeApi();
  vscode.postMessage({ type, ...payload });
}

// ============================================================================
// Theme Capture Helper
// ============================================================================

/**
 * Captures all --vscode-* CSS custom properties from :root and posts them
 * back to the extension as THEME_VARS_CAPTURED so the server can forward
 * them to external browser clients.
 */
export function captureAndSendThemeVars(
  vscodeApi: ReturnType<typeof getVsCodeApi>
): void {
  const computedStyle = window.getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};

  // VS Code injects --vscode-* vars as inline styles on <html>; iterate those first.
  const inlineStyle = document.documentElement.style;
  for (let i = 0; i < inlineStyle.length; i++) {
    const prop = inlineStyle.item(i);
    if (prop.startsWith("--vscode-")) {
      vars[prop] = computedStyle.getPropertyValue(prop).trim();
    }
  }

  // Also scan stylesheet :root rules (picks up any theme vars defined via CSS files).
  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule && rule.selectorText === ":root") {
            for (const prop of rule.style) {
              if (prop.startsWith("--vscode-")) {
                vars[prop] = computedStyle.getPropertyValue(prop).trim();
              }
            }
          }
        }
      } catch {
        /* cross-origin sheet, skip */
      }
    }
  } catch {
    /* ignore */
  }

  // Capture theme kind from body class so browser-hosted clients can replicate it.
  // Stored as a synthetic CSS custom property so it flows through the same
  // cachedThemeVars / buildThemeStyleBlock pipeline as the --vscode-* vars.
  const bodyClasses = document.body.classList;
  const themeKind = bodyClasses.contains("vscode-high-contrast")
    ? "high-contrast"
    : bodyClasses.contains("vscode-dark")
      ? "dark"
      : "light";
  vars["--fp-color-theme-kind"] = themeKind;

  vscodeApi.postMessage({ type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars });
}

function normalizeWorkflowProperties(
  workflowProperties?: Partial<WorkflowProperties>
): WorkflowProperties {
  return {
    harness: workflowProperties?.harness,
    model: workflowProperties?.model,
    agent: workflowProperties?.agent,
    skills: workflowProperties?.skills,
    resumeSession: workflowProperties?.resumeSession,
    sessionId: workflowProperties?.sessionId,
    mcpServers: workflowProperties?.mcpServers,
    hooks: workflowProperties?.hooks,
    endCondition: workflowProperties?.endCondition,
    preCondition: workflowProperties?.preCondition,
    priorContext: workflowProperties?.priorContext,
    additionalArgs: workflowProperties?.additionalArgs,
    toolPermissions: workflowProperties?.toolPermissions,
  };
}

function applyWorkflowPropertiesFromMessage(message: {
  workflowProperties?: Partial<WorkflowProperties>;
}): void {
  if (!Object.prototype.hasOwnProperty.call(message, "workflowProperties")) {
    return;
  }

  const normalized = normalizeWorkflowProperties(message.workflowProperties);
  useSettingsStore.getState().setWorkflowProperties(normalized);
  useWorkflowStore.getState().syncIncomingWorkflowProperties(normalized);
}

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Reset all cross-cutting state when the active workflow changes.
 * Called by FILE_SELECTED and SESSION_RESTORED after loadWorkflow().
 *
 * Clears history view, run counters, and enables the queue UI.
 * Preserves the user's in-progress ephemeral prompt:
 * - If editing an existing prompt (edit mode), cancels the edit and restores
 *   the saved new-prompt state so typed content is not lost.
 * - If already in new-prompt mode, leaves the editor content untouched.
 *
 * Pending edit caches for existing prompts are workflow-local. They are keyed
 * only by prompt target (`queue:index` / `finalStep`), so they must be cleared
 * when switching workflows to prevent drafts from one workflow appearing in
 * another workflow that has the same step index.
 */
function applyWorkflowChange(): void {
  useWorkflowStore.getState().clearHistoryOutputs();
  useUiStore.getState().clearHistoryView();
  useUiStore.getState().setFinalStepFooterExpanded(false);
  useUiStore.setState({ availableRuns: 0, runTimestamps: [], runStates: [] });

  const editorStore = useEditorStore.getState();
  editorStore.clearAllPendingEdits();
  if (editorStore.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
    // Was editing an existing prompt from the old workflow — cancel the edit so
    // the savedNewPromptState (what the user had typed before clicking edit) is
    // restored instead of being discarded.
    editorStore.cancelEdit();
  }
  // Already in new-prompt mode: leave the editor content as-is so the user
  // doesn't lose whatever they've typed.

  editorStore.setHasActiveQueue(true);

  // Do NOT clear workflowProperties here. The extension may include workflowProperties
  // on this same state message, or send WORKFLOW_PROPERTIES_UPDATE immediately after.
  // Clearing here causes a visible flash with global defaults before the real values
  // arrive. The property message path replaces the whole object, so unset fields still
  // fall through to global defaults without an intermediate blank render.
  useSettingsStore.getState().setWorkflowLoaded(true);
}

function persistViewedWorkingFilePath(path: unknown): void {
  if (typeof path === "string" && path.trim().length > 0) {
    useUiStore.getState().setActiveWorkflowWorkingFilePath(path);
  } else if (path === null) {
    useUiStore.getState().setActiveWorkflowWorkingFilePath(null);
  }
}

function applyTerminalSettings(settings: TerminalSettings): void {
  terminalRegistry.updateTerminalOptions(settings);
  useUiStore.getState().setTerminalFontSize(settings.fontSize);
}

function applyTerminalSetting(path: string, value: unknown): void {
  if (!path.startsWith("terminal.")) return;

  const key = path.slice("terminal.".length) as keyof TerminalSettings;
  const nextSettings = {
    ...terminalRegistry.getTerminalSettings(),
    [key]: value,
  } as TerminalSettings;
  applyTerminalSettings(nextSettings);
}

function isTerminalStepStatus(status: unknown): boolean {
  return (
    status === STEP_STATUS.COMPLETED ||
    status === STEP_STATUS.FAILED ||
    status === STEP_STATUS.CANCELLED ||
    status === STEP_STATUS.SKIPPED
  );
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Create all message handlers
 * Uses getState() pattern to access stores outside React render cycle
 */
function createMessageHandlers(): MessageHandlerMap {
  const handlers: MessageHandlerMap = {};

  // --------------------------------------------------------------------------
  // INIT - Initial state from extension
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.INIT] = (message) => {
    const data = message.data || message;
    const workflowStore = useWorkflowStore.getState();
    const settingsStore = useSettingsStore.getState();
    const editorStore = useEditorStore.getState();

    // Update model options from extension (dynamic from ModelRegistry)
    if (data.modelOptions) {
      settingsStore.setModelOptions(data.modelOptions);
    }

    // Update global settings
    if (data.globalSettings) {
      settingsStore.setGlobalSettings(data.globalSettings);
      if (data.globalSettings.terminal) {
        applyTerminalSettings(data.globalSettings.terminal);
      }
    }

    // Update workflow properties only if non-empty — sendInitialState() sends
    // workflowProperties: {} as a placeholder, which would wipe out properties
    // (resumeSession, endCondition, etc.) that were set by the user.
    if (
      data.workflowProperties &&
      Object.keys(data.workflowProperties).length > 0
    ) {
      const normalized = normalizeWorkflowProperties(data.workflowProperties);
      settingsStore.setWorkflowProperties(normalized);
      workflowStore.syncIncomingWorkflowProperties(normalized);
    }

    // Update harness status
    if (data.harnessStatus) {
      settingsStore.setAllHarnessStatuses(data.harnessStatus);
    }

    // Update available agents
    if (data.availableAgents) {
      settingsStore.setAvailableAgents(data.availableAgents);
    }

    // Update available skills
    if (data.availableSkills) {
      settingsStore.setAvailableSkills(data.availableSkills);
    }

    if (data.dev) {
      settingsStore.setDevStatus(data.dev);
    } else {
      settingsStore.setDevStatus(null);
    }

    // Load workflow if data includes prompts
    if (data.steps && data.steps.length > 0) {
      workflowStore.loadWorkflow({
        fileName: data.fileName || "",
        workflowName: data.workflowName,
        steps: data.steps,
        executionState: data.executionState as ExecutionState,
        currentStep: data.currentIndex || 0,
        results: data.results || [],
        finalStep: data.finalStep ?? null,
        finalStepStatus: data.finalStepStatus ?? null,
        finalStepLoopCount: data.finalStepLoopCount ?? 0,
        finalStepPhase: data.finalStepPhase ?? null,
      });
      editorStore.setHasActiveQueue(true);
      settingsStore.setWorkflowLoaded(true);
    }
  };

  // --------------------------------------------------------------------------
  // GLOBAL_SETTINGS_UPDATED - Config changed; update settings only, no workflow reset
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.GLOBAL_SETTINGS_UPDATED] = (message) => {
    const settingsStore = useSettingsStore.getState();
    if (message.globalSettings) {
      settingsStore.setGlobalSettings(message.globalSettings);
      if (message.globalSettings.terminal) {
        applyTerminalSettings(message.globalSettings.terminal);
      }
    }
    if (message.modelOptions) {
      settingsStore.setModelOptions(message.modelOptions);
    }
  };

  // --------------------------------------------------------------------------
  // GLOBAL_SETTINGS_LOADED - Full global settings from configService
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED] = (message) => {
    const settingsStore = useSettingsStore.getState();
    if (message.settings) {
      settingsStore.setFullGlobalSettings(message.settings);
      if (message.settings.settings?.terminal) {
        applyTerminalSettings(message.settings.settings.terminal);
      }
    }
    settingsStore.setLastCommitMessageGeneration(
      message.commitMessageGeneration ?? null
    );
  };

  handlers[MESSAGE_TYPES.GLOBAL_SETTING_UPDATED] = (message) => {
    applyTerminalSetting(message.path, message.value);
  };

  // --------------------------------------------------------------------------
  // Developer dashboard events
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.DEV_STATUS] = (message) => {
    useSettingsStore.getState().setDevStatus(message.dev ?? null);
  };

  handlers[MESSAGE_TYPES.DEV_BUILD_STARTED] = (message) => {
    useSettingsStore.getState().startDevBuild(message.script, message.command);
  };

  handlers[MESSAGE_TYPES.DEV_BUILD_OUTPUT] = (message) => {
    useSettingsStore
      .getState()
      .appendDevBuildOutput(message.stream, message.chunk ?? "");
  };

  handlers[MESSAGE_TYPES.DEV_BUILD_COMPLETED] = (message) => {
    useSettingsStore.getState().completeDevBuild({
      success: Boolean(message.success),
      exitCode: message.exitCode ?? null,
      signal: message.signal ?? null,
      durationMs: message.durationMs ?? 0,
      errorSummary: message.errorSummary,
    });
    useUiStore
      .getState()
      .showToast(
        message.success ? "Command completed" : "Command failed",
        message.success ? "success" : "error"
      );
  };

  handlers[MESSAGE_TYPES.DEV_RESTARTING] = (message) => {
    useUiStore.setState({
      devRestarting: true,
      startupReady: false,
      myClientId: "",
    });
    // For a full window reload VS Code restarts the renderer and (on some builds)
    // preserves the webview process. Scheduling a self-reload watchdog here causes
    // window.location.reload() to fire ~1.5 s into the reload sequence — before
    // resolveWebviewView() has set fresh HTML — which corrupts the acquireVsCodeApi()
    // lifecycle and leaves the panel showing "raw html text" or stuck in a dead state.
    // For extension host restart the webview IS retained and the watchdog is needed
    // as a self-healing fallback if the READY handshake doesn't complete.
    if (message.command !== "workbench.action.reloadWindow") {
      schedulePanelReconnectReloadWatchdog();
    } else if (isStandalone) {
      // Tell the standalone shim to be patient with reconnects during the full
      // rebuild + window reload cycle, which can take 20-60+ seconds.
      // Without this the shim exhausts its 5 consecutive-failure limit (~5 s)
      // and shows a permanent error banner before the server comes back.
      const expectFn = (window as unknown as Record<string, unknown>)[
        "__fpExpectServerRestart"
      ];
      if (typeof expectFn === "function") {
        (expectFn as (ms: number) => void)(120000);
      }
    }
  };

  handlers[MESSAGE_TYPES.RECONNECT] = () => {
    // Extension host restarted but VS Code retained the old webview context.
    // Reset startup state and re-send READY so the new host can initialize.
    useUiStore.setState({
      devRestarting: false,
      startupReady: false,
      myClientId: "",
    });
    const { activeWorkflowWorkingFilePath } = useUiStore.getState();
    getVsCodeApi().postMessage({
      type: MESSAGE_TYPES.READY,
      preferredWorkingFilePath: activeWorkflowWorkingFilePath,
    });
    // schedulePanelReconnectReloadWatchdog() is a no-op when this is a fresh
    // page load that already sent READY via BootstrapApp (freshPageReadySent=true).
    // It only arms the watchdog for retained contexts where the panel hasn't
    // yet received CLIENT_ID_ASSIGNED from the new extension host.
    schedulePanelReconnectReloadWatchdog();
  };

  handlers[MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE] = (message) => {
    useUiStore
      .getState()
      .showToast(message.reason ?? "Developer command unavailable", "error");
  };

  handlers[MESSAGE_TYPES.COMMIT_MESSAGE_GENERATION_UPDATED] = (message) => {
    useSettingsStore
      .getState()
      .setLastCommitMessageGeneration(message.record ?? null);
  };

  // --------------------------------------------------------------------------
  // FILE_SELECTED - New workflow file loaded
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.FILE_SELECTED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore.getState().loadWorkflow({
      fileName: message.fileName,
      workflowName: message.workflowName,
      steps: message.steps || [],
      finalStep: message.finalStep ?? null,
      finalStepStatus: message.finalStepStatus ?? null,
      finalStepLoopCount: message.finalStepLoopCount ?? 0,
      finalStepPhase: message.finalStepPhase ?? null,
    });
    persistViewedWorkingFilePath(message.workingFilePath);
    applyWorkflowChange();
    applyWorkflowPropertiesFromMessage(message);
  };

  // --------------------------------------------------------------------------
  // SESSION_RESTORED - Restore previous session with runtime state
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SESSION_RESTORED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore.getState().loadWorkflow({
      fileName: message.fileName,
      workflowName: message.workflowName,
      steps: message.steps || [],
      executionState: message.executionState as ExecutionState,
      currentStep: message.currentIndex || 0,
      results: message.results || [],
      finalStep: message.finalStep ?? null,
      finalStepStatus: message.finalStepStatus ?? null,
      finalStepLoopCount: message.finalStepLoopCount ?? 0,
      finalStepPhase: message.finalStepPhase ?? null,
    });
    persistViewedWorkingFilePath(message.workingFilePath);
    applyWorkflowChange();
    applyWorkflowPropertiesFromMessage(message);
  };

  // --------------------------------------------------------------------------
  // STEPS_EXTENDED - Queue was extended with new steps
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STEPS_EXTENDED] = (message) => {
    // If workflowId is present (CLI watch mode), only apply to the active workflow
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        WebviewLog.debug(
          `[STEPS_EXTENDED] ignoring — workflowId=${message.workflowId?.slice(0, 8)} !== activeWorkflowId=${activeWorkflowId?.slice(0, 8)}`
        );
        return;
      }
    }

    const workflowStore = useWorkflowStore.getState();

    // Update steps list (keep existing status for completed steps)
    const currentSteps = workflowStore.steps;
    const newSteps = (message.steps || []).map((step: any, index: number) => {
      // Preserve status from existing steps
      const existingStep = currentSteps[index] as any;
      return {
        ...step,
        status: existingStep?.status || STEP_STATUS.PENDING,
      };
    });

    WebviewLog.debug(
      `[STEPS_EXTENDED] ${currentSteps.length} → ${newSteps.length} steps${message.workflowId ? ` (CLI workflowId=${message.workflowId.slice(0, 8)})` : ""}`
    );
    // Only record an undo entry when the user actually changed something.
    // Count changes cover add/remove. Content changes (same count, different
    // text/name/model/harness) cover edits. Pure re-syncs (file-watcher firing
    // after the extension writes the working file) have identical content and
    // must not pollute the undo stack.
    const stepCountChanged = newSteps.length !== currentSteps.length;
    const stepContentChanged =
      !stepCountChanged &&
      newSteps.some((p: any, i: number) => {
        const cur = currentSteps[i] as any;
        return (
          p.prompt !== cur?.prompt ||
          p.name !== cur?.name ||
          p.model !== cur?.model ||
          p.harness !== cur?.harness
        );
      });
    // Also suppress undo recording for the initial auto-load (0 → N steps).
    // Loading from an empty state is a system-driven restore, not a user edit.
    const isInitialAutoLoad = currentSteps.length === 0;
    const shouldRecord =
      !isInitialAutoLoad && (stepCountChanged || stepContentChanged);
    WebviewLog.debug(
      `[STEPS_EXTENDED] shouldRecord=${shouldRecord} (countChanged=${stepCountChanged} contentChanged=${stepContentChanged} isInitialAutoLoad=${isInitialAutoLoad}) pastStatesBefore=${useWorkflowStore.temporal.getState().pastStates.length}`
    );
    // If executionState is piggybacked (sent alongside prompts to avoid a
    // separate render), apply it first — same synchronous call, same render.
    if (message.executionState !== undefined) {
      useWorkflowStore.temporal.getState().pause();
      workflowStore.setExecutionState(message.executionState as ExecutionState);
      useWorkflowStore.temporal.getState().resume();
    }
    if (!shouldRecord) {
      useWorkflowStore.temporal.getState().pause();
    }
    workflowStore.setPrompts(newSteps);
    if (!shouldRecord) {
      useWorkflowStore.temporal.getState().resume();
    }
    // finalStep changes here are system-driven syncs, not user actions —
    // suppress their undo entries regardless of count change.
    if (message.finalStep !== undefined) {
      useWorkflowStore.temporal.getState().pause();
      workflowStore.setFinalStep(message.finalStep ?? null);
      useWorkflowStore.temporal.getState().resume();
    }
  };

  // --------------------------------------------------------------------------
  // RESET_WORKFLOW_STATE - Extension confirms state reset (response to button click)
  // Resets prompt statuses and execution state without touching output history.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RESET_WORKFLOW_STATE] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.resetExecutionState(message.steps || []);

    // Exit history view — the panel must show the live (reset) state, not the
    // historical run. Without this, isViewingHistory=true keeps doneStepCount
    // at historyOutputs.stepCount while currentStep resets to 0, causing every
    // prompt to appear twice (once in the done list, once in pending).
    useUiStore.getState().clearHistoryView();

    // Cancel any active edit — the selected prompt's status has changed
    const editorStore = useEditorStore.getState();
    if (editorStore.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      editorStore.cancelEdit();
    }
  };

  // --------------------------------------------------------------------------
  // REORDER_PROMPTS_CONFIRMED - Extension confirms pending prompts were reordered
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.REORDER_PROMPTS_CONFIRMED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setPrompts(message.steps || []);
  };

  // --------------------------------------------------------------------------
  // SET_START_POSITION_CONFIRMED - Extension confirms start position was moved
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SET_START_POSITION_CONFIRMED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    const prevCurrentStep = workflowStore.currentStep;
    const newCurrentStep = message.currentIndex as number;

    rememberUndoRedoRuntime(workflowStore.steps);
    workflowStore.applyStartPositionChange(message.steps || [], newCurrentStep);

    // For rewind: clear live CLI outputs for rewound steps
    if (newCurrentStep < prevCurrentStep) {
      workflowStore.clearRuntimeStateFromStep(newCurrentStep);
    }

    // Cancel any active edit — the selected prompt's state has changed
    const editorStore = useEditorStore.getState();
    if (editorStore.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      editorStore.cancelEdit();
    }
  };

  // --------------------------------------------------------------------------
  // PROMPT_DELETED - Prompt was deleted from queue
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.PROMPT_DELETED] = (message) => {
    const workflowStore = useWorkflowStore.getState();

    rememberUndoRedoRuntime(workflowStore.steps);
    workflowStore.setFileName(message.fileName);
    workflowStore.setPrompts(message.steps || []);
    // Pause around setFinalStep — the delete action is already recorded by
    // setPrompts above; a second entry from setFinalStep would require two
    // undos to restore a single deleted prompt.
    if (message.finalStep !== undefined) {
      useWorkflowStore.temporal.getState().pause();
      workflowStore.setFinalStep(message.finalStep ?? null);
      useWorkflowStore.temporal.getState().resume();
    }
  };

  // --------------------------------------------------------------------------
  // EXECUTION_STARTED - Workflow execution has started
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_STARTED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    const editorStore = useEditorStore.getState();
    const uiStore = useUiStore.getState();

    const isContinuation = message.isContinuation === true;
    const preserveStepCount = message.preserveStepCount ?? 0;

    WebviewLog.debug(
      `[EXECUTION_STARTED] isContinuation=${isContinuation}, preserveStepCount=${preserveStepCount}, ` +
        `totalSteps=${message.totalSteps}, isViewingHistory=${uiStore.isViewingHistory}, ` +
        `historyOutputs=${workflowStore.historyOutputs ? "exists" : "null"}, ` +
        `liveEntries=${workflowStore.liveOrderedEntries.length}`
    );

    if (isContinuation && preserveStepCount > 0) {
      // Append-continuation run: promote history entries into liveOrderedEntries BEFORE
      // clearing history view, so the user still sees previous prompts' output.
      WebviewLog.debug(
        `[EXECUTION_STARTED] Continuation — promoting ${preserveStepCount} history step(s) to live, then switching to live view`
      );
      workflowStore.promoteHistoryToLive(preserveStepCount);

      // Now safe to switch to live view (live data is populated)
      workflowStore.clearHistoryOutputs();
      uiStore.clearHistoryView();

      workflowStore.setFileName(message.fileName);
      workflowStore.setExecutionState(EXECUTION_STATES.RUNNING);
      workflowStore.setTotalSteps(message.totalSteps);
      workflowStore.setCurrentStep(preserveStepCount);

      // Reset only the new (not-yet-run) prompts to pending; preserve completed status.
      // Pause undo recording — execution start is not a user-undoable action.
      const updatedPrompts = workflowStore.steps.map((prompt, i) => {
        if (i < preserveStepCount) {
          return prompt; // Keep completed status and output
        }
        return { ...prompt, status: STEP_STATUS.PENDING as StepStatus };
      });
      useWorkflowStore.temporal.getState().pause();
      workflowStore.setPrompts(updatedPrompts);
      useWorkflowStore.temporal.getState().resume();

      // Clear runtime state only for the new steps (steps >= preserveStepCount)
      workflowStore.clearRuntimeStateFromStep(preserveStepCount);

      WebviewLog.debug(
        `[EXECUTION_STARTED] After promote — liveEntries=${useWorkflowStore.getState().liveOrderedEntries.length}`
      );
    } else {
      // Fresh start: switch to live view and reset everything
      WebviewLog.debug(
        `[EXECUTION_STARTED] Fresh start — clearing all runtime state`
      );
      workflowStore.clearHistoryOutputs();
      uiStore.clearHistoryView();

      workflowStore.setFileName(message.fileName);
      workflowStore.setExecutionState(EXECUTION_STATES.RUNNING);
      workflowStore.setTotalSteps(message.totalSteps);
      workflowStore.setCurrentStep(0);

      const resetPrompts = workflowStore.steps.map((prompt) => ({
        ...prompt,
        status: STEP_STATUS.PENDING as StepStatus,
      }));
      // Pause undo recording — execution start is not a user-undoable action.
      useWorkflowStore.temporal.getState().pause();
      workflowStore.setPrompts(resetPrompts);
      useWorkflowStore.temporal.getState().resume();
      workflowStore.clearAllRuntimeState();
    }

    // Mark editor as having active queue
    editorStore.setHasActiveQueue(true);

    // Handle ai-cli terminal sessions for the new run.
    const wfId = message.workflowId;
    if (wfId) {
      if (
        useSettingsStore.getState().globalSettings.executionMode ===
        EXECUTION_MODES.HEADLESS
      ) {
        autoFocusOutputOnExecution(wfId, "output");
      } else if (message.isInjectMode) {
        autoFocusOutputOnExecution(wfId, "terminal");
      }

      if (message.isInjectMode) {
        // Inject mode reuses the existing PTY — unfreeze and resume the existing
        // ai-cli session(s) instead of destroying and recreating them.
        const termStore = useTerminalStore.getState();
        const aiCliSessions = (termStore.sessions[wfId] ?? []).filter(
          (s) => s.kind === SESSION_KINDS.AI_CLI
        );
        for (const s of aiCliSessions) {
          terminalRegistry.unfreeze(wfId, s.id);
          termStore.resumeSession(wfId, s.id);
        }
        if (aiCliSessions.length > 0) {
          useUiStore.getState().setTerminalSessionActive(wfId, true);
        }
      } else if (!isContinuation) {
        // Fresh non-inject run start: clear old ai-cli sessions so the new PTY
        // gets a fresh xterm instance. Shell sessions survive run boundaries.
        //
        // Continuations intentionally keep the current ai-cli xterm until
        // TERMINAL_STARTED arrives. If the continuation injects into the same
        // PTY, TERMINAL_STARTED updates the existing session in place. If it
        // spawns a new PTY, the terminal handler replaces the old ai-cli session
        // at that point. Clearing here creates a visible blank flash during
        // append-to-completed inject runs because isInjectMode can be unknown
        // until the prompt-specific harness is selected.
        const aiCliSessionIds = (
          useTerminalStore.getState().sessions[wfId] ?? []
        )
          .filter((s) => s.kind === SESSION_KINDS.AI_CLI)
          .map((s) => s.id);
        terminalRegistry.clearAiCliSessions(wfId, aiCliSessionIds);
        useTerminalStore.getState().clearAiCliSessions(wfId);
      }
    }
  };

  // --------------------------------------------------------------------------
  // EXECUTION_STATE_CHANGED - Execution state changed (running/paused/stopped)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_STATE_CHANGED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setExecutionState(message.state as ExecutionState);
  };

  // --------------------------------------------------------------------------
  // PROGRESS_UPDATE - Current step/total steps updated
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.PROGRESS_UPDATE] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setCurrentStep(message.current);
    workflowStore.setTotalSteps(message.total);
  };

  // --------------------------------------------------------------------------
  // STEP_STATUS_CHANGED - Individual step status changed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STEP_STATUS_CHANGED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    const { stepIndex, status, details } = message;

    if (workflowStore.steps[stepIndex]) {
      // Pause around updatePrompt — step status changes are runtime events,
      // not user actions. Without this, every running/completed/failed status
      // transition during a workflow run would pollute the undo stack.
      useWorkflowStore.temporal.getState().pause();
      workflowStore.updatePrompt(stepIndex, {
        status: status.state || status,
        _runtime: details
          ? {
              ...workflowStore.steps[stepIndex]._runtime,
              ...details,
            }
          : undefined,
      });
      useWorkflowStore.temporal.getState().resume();
    }

    // Clear live context window when a step reaches a terminal status so the
    // context bar falls back to the completed step's tokens from latestOutput.
    const terminalStatuses = [
      STEP_STATUS.COMPLETED,
      STEP_STATUS.FAILED,
      STEP_STATUS.CANCELLED,
    ];
    const resolvedStatus = status?.state || status;
    if (terminalStatuses.includes(resolvedStatus)) {
      workflowStore.clearLiveContextWindow(stepIndex);
    }
  };

  // --------------------------------------------------------------------------
  // RETRY_ATTEMPT_CHANGED - Retry count updated for a step
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setRetryState(
      message.stepIndex,
      message.currentRetry,
      message.maxRetries
    );
  };

  // --------------------------------------------------------------------------
  // EXECUTION_COMPLETED - Workflow execution finished
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_COMPLETED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    const steps = workflowStore.steps;
    if (steps.length > 0) {
      const completedSteps = steps.map((step) => {
        const currentStatus = (step as { status?: StepStatus }).status;
        return isTerminalStepStatus(currentStatus)
          ? step
          : ({ ...step, status: STEP_STATUS.COMPLETED } as typeof step);
      });
      useWorkflowStore.temporal.getState().pause();
      workflowStore.setPrompts(completedSteps);
      useWorkflowStore.temporal.getState().resume();
    }
    workflowStore.setExecutionState(EXECUTION_STATES.COMPLETED);
  };

  handlers[MESSAGE_TYPES.NOTIFICATION_EVENT] = (message) => {
    if (!message.event) {
      return;
    }

    useUiStore
      .getState()
      .showToast(
        message.event.body,
        getNotificationSeverityColor(message.event.severity)
      );

    void handleCompletionNotificationEvent(
      message.event,
      useSettingsStore.getState().fullGlobalSettings
    );
  };

  // --------------------------------------------------------------------------
  // UPDATE_FINAL_PROMPT - Workflow-level finalStep updated
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.UPDATE_FINAL_PROMPT] = (message) => {
    useWorkflowStore.getState().setFinalStep(message.finalStep ?? null);
  };

  // --------------------------------------------------------------------------
  // FINAL_PROMPT_STATUS_CHANGED - Runtime status updates for finalStep phase
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.FINAL_PROMPT_STATUS_CHANGED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore
      .getState()
      .setFinalStepStatus(
        (message.status as StepStatus | null) ?? null,
        message.loopCount ?? 0,
        message.phase ?? null
      );
  };

  // --------------------------------------------------------------------------
  // FINAL_PROMPT_OUTPUT - CLI output for finalStep loop
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.FINAL_PROMPT_OUTPUT] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const store = useWorkflowStore.getState();
    const entry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: message.loopIndex,
      },
      runIndex: message.output.runIndex ?? 0,
      attemptIndex: message.output.attemptIndex ?? 0,
      cliOutput: message.output,
      timestampMs: message.output.timestampMs ?? Date.now(),
      sequence: store.liveSequence,
    };
    store.appendLiveEntry(entry);
  };

  // --------------------------------------------------------------------------
  // FINAL_PROMPT_STREAMING_CHUNK - Incremental streaming text chunk for finalStep
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.FINAL_PROMPT_STREAMING_CHUNK] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore
      .getState()
      .appendFinalStepStreamingChunk(message.loopIndex, message.chunk || "");
  };

  // --------------------------------------------------------------------------
  // FINAL_PROMPT_STREAMING_EVENTS - Structured streaming events for finalStep
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.FINAL_PROMPT_STREAMING_EVENTS] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore
      .getState()
      .appendFinalStepStreamingEvents(
        message.loopIndex,
        message.events || [],
        message.attemptIndex ?? 0,
        message.runIndex ?? 0
      );
  };

  // --------------------------------------------------------------------------
  // CLI_OUTPUT - Complete CLI output for a step
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_OUTPUT] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const store = useWorkflowStore.getState();
    const entry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: message.stepIndex },
      runIndex: message.output.runIndex ?? 0,
      attemptIndex: message.output.attemptIndex ?? 0,
      cliOutput: message.output,
      timestampMs: message.output.timestampMs ?? Date.now(),
      sequence: store.liveSequence,
    };
    store.appendLiveEntry(entry);

    if (store.steps[message.stepIndex]) {
      useWorkflowStore.temporal.getState().pause();
      store.updatePrompt(message.stepIndex, {
        _runtime: {
          ...store.steps[message.stepIndex]._runtime,
          sessionId:
            message.output.structured?.metadata?.sessionId ??
            store.steps[message.stepIndex]._runtime?.sessionId,
          elapsed: message.output.elapsed,
          contextWindowUsed:
            message.output.tokens?.contextWindowUsed ??
            store.steps[message.stepIndex]._runtime?.contextWindowUsed,
          contextWindowSize:
            message.output.tokens?.contextWindowSize ??
            store.steps[message.stepIndex]._runtime?.contextWindowSize,
        },
      });
      useWorkflowStore.temporal.getState().resume();
    }
  };

  // --------------------------------------------------------------------------
  // CLI_STREAMING_CHUNK - Incremental streaming text chunk
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_STREAMING_CHUNK] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.appendStreamingChunk(message.stepIndex, message.chunk || "");
  };

  // --------------------------------------------------------------------------
  // CLI_STREAMING_EVENTS - Structured events for Claude/Codex CLI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_STREAMING_EVENTS] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    const events = message.events || [];

    // Append events to streaming buffer (creates buffer if needed)
    // Events are accumulated and displayed in real-time as formatted structured output
    workflowStore.appendStreamingEvents(
      message.stepIndex,
      events,
      message.attemptIndex ?? 0,
      message.runIndex ?? 0
    );
  };

  // --------------------------------------------------------------------------
  // CONTEXT_WINDOW_UPDATE - Live context window usage update for a running step
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore
      .getState()
      .updateLiveContextWindow(message.stepIndex, message.used, message.size);
  };

  // --------------------------------------------------------------------------
  // CLI_WATCH_OUTPUT - Live CLI output streamed from a CLI-managed workflow.
  // Only processed when this workflowId is the currently active workflow so
  // outputs from background CLI sessions are not mixed into the live view.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_WATCH_OUTPUT] = (message) => {
    const activeWorkflowId = useUiStore.getState().activeWorkflowId;
    if (message.workflowId !== activeWorkflowId) {
      return;
    }
    const store = useWorkflowStore.getState();
    const entry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: message.stepIndex },
      runIndex: message.output.runIndex ?? 0,
      attemptIndex: message.output.attemptIndex ?? 0,
      cliOutput: message.output,
      timestampMs: message.output.timestampMs ?? Date.now(),
      sequence: store.liveSequence,
    };
    store.appendLiveEntry(entry);

    if (store.steps[message.stepIndex]) {
      useWorkflowStore.temporal.getState().pause();
      store.updatePrompt(message.stepIndex, {
        _runtime: {
          ...store.steps[message.stepIndex]._runtime,
          sessionId:
            message.output.structured?.metadata?.sessionId ??
            store.steps[message.stepIndex]._runtime?.sessionId,
          elapsed: message.output.elapsed,
          contextWindowUsed:
            message.output.tokens?.contextWindowUsed ??
            store.steps[message.stepIndex]._runtime?.contextWindowUsed,
          contextWindowSize:
            message.output.tokens?.contextWindowSize ??
            store.steps[message.stepIndex]._runtime?.contextWindowSize,
        },
      });
      useWorkflowStore.temporal.getState().resume();
    }
  };

  // --------------------------------------------------------------------------
  // STATUS_MESSAGE - Status message for a step (info/warning/error)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STATUS_MESSAGE] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const store = useWorkflowStore.getState();
    const stepIndex = Number(message.stepIndex);
    const target: OutputExecutionTarget =
      Number.isFinite(stepIndex) && stepIndex < 0
        ? {
            kind: FINAL_STEP_PHASES.FINAL_STEP,
            loopIndex: Math.abs(stepIndex) - 1,
          }
        : {
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: Math.max(0, stepIndex),
          };
    const entry: OrderedStatusHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target,
      statusMessage: {
        message: message.message,
        severity: message.severity ?? "info",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: store.liveSequence,
    };
    store.appendLiveEntry(entry);
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_NAME_UPDATED - Workflow name changed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_NAME_UPDATED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setWorkflowName(message.workflowName);
  };

  // --------------------------------------------------------------------------
  // RECENT_WORKFLOWS - List of recent workflow files
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RECENT_WORKFLOWS] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setRecentWorkflows(message.workflows || []);
  };

  // --------------------------------------------------------------------------
  // OPEN_NEW_WORKFLOW_MODAL - Open modal to create new workflow
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.openNewWorkflowModal({
      templates: message.templates || [],
      workflowsDir: message.workflowsDir || ".flightpath/workflows",
      defaultTemplateId: message.defaultTemplateId,
    });
  };

  // --------------------------------------------------------------------------
  // TEMPLATE_INFO - Template details for preview
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TEMPLATE_INFO] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setCurrentTemplate(message.template);
  };

  // --------------------------------------------------------------------------
  // DEFAULT_TEMPLATE_SET - Confirm default template was set
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.DEFAULT_TEMPLATE_SET] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setDefaultTemplateId(message.templateId);
  };

  // --------------------------------------------------------------------------
  // TEMPLATE_FILE_SELECTED - OS file picker result for a template variable
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TEMPLATE_FILE_SELECTED] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setTemplateFileSelection({
      variable: message.variable,
      path: message.path,
    });
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_CREATED - New workflow file was created
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_CREATED] = (message) => {
    const uiStore = useUiStore.getState();
    // Only close the modal on success; errors are shown by the extension via showErrorMessage
    if (!message.error) {
      uiStore.closeNewWorkflowModal();
    }
  };

  // --------------------------------------------------------------------------
  // CLOSE_MODAL - Close any open modal
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLOSE_MODAL] = () => {
    const uiStore = useUiStore.getState();
    uiStore.closeNewWorkflowModal();
  };

  // --------------------------------------------------------------------------
  // MODEL_OPTIONS_UPDATE - Refresh model lists after registry loads
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MODEL_OPTIONS_UPDATE] = (message) => {
    const settingsStore = useSettingsStore.getState();
    const data = message.data || message;
    if (data.modelOptions) {
      settingsStore.setModelOptions(data.modelOptions);
    }
  };

  // --------------------------------------------------------------------------
  // HARNESS_STATUS_UPDATE - Update harness availability
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.HARNESS_STATUS_UPDATE] = (message) => {
    const settingsStore = useSettingsStore.getState();
    const data = message.data || message;
    if (data.harnessStatus) {
      settingsStore.setAllHarnessStatuses(data.harnessStatus);
    }
  };

  // --------------------------------------------------------------------------
  // AGENTS_UPDATE - Update available agents list
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.AGENTS_UPDATE] = (message) => {
    const settingsStore = useSettingsStore.getState();
    const data = message.data || message;
    if (data.availableAgents) {
      settingsStore.setAvailableAgents(data.availableAgents);
    }
  };

  // --------------------------------------------------------------------------
  // SKILLS_UPDATE - Update available skills list
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SKILLS_UPDATE] = (message) => {
    const settingsStore = useSettingsStore.getState();
    const data = message.data || message;
    if (data.availableSkills) {
      settingsStore.setAvailableSkills(data.availableSkills);
    }
  };

  // --------------------------------------------------------------------------
  // MCP_LOCAL_SERVERS_RESULT - Local MCP config file scan results
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_LOCAL_SERVERS_RESULT] = (message) => {
    useUiStore
      .getState()
      .setMcpLocalServersResult(message.servers ?? [], message.error);
  };

  // --------------------------------------------------------------------------
  // MCP_REGISTRY_RESULT - Anthropic MCP registry search results
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_REGISTRY_RESULT] = (message) => {
    useUiStore
      .getState()
      .setMcpRegistryResult(
        message.servers ?? [],
        message.query,
        message.error,
        message.nextCursor
      );
  };

  // --------------------------------------------------------------------------
  // MCP_WORKSPACE_SERVERS_RESULT - Workspace MCP server registry
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_WORKSPACE_SERVERS_RESULT] = (message) => {
    useUiStore
      .getState()
      .setMcpWorkspaceServersResult(message.servers ?? [], message.error);
  };

  // --------------------------------------------------------------------------
  // HARNESS_FILES_RESULT - File enumeration results
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.HARNESS_FILES_RESULT] = (message) => {
    useHarnessFileStore
      .getState()
      .setFiles(message.files ?? [], message.targetDirectories ?? []);
  };

  // --------------------------------------------------------------------------
  // HARNESS_FILE_OP_RESULT - Result of an export/import/delete/sync operation
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.HARNESS_FILE_OP_RESULT] = (message) => {
    const store = useHarnessFileStore.getState();
    if (message.success) {
      if (message.files) {
        store.setFiles(message.files, message.targetDirectories);
      } else {
        store.setLoading(false);
      }
      store.setError(null);
    } else {
      store.setError(message.error ?? "Operation failed");
    }
  };

  // --------------------------------------------------------------------------
  // OPEN_HARNESS_DIR_RESULT - Result of an open-folder request
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT] = (message) => {
    if (!message.success) {
      useUiStore
        .getState()
        .showToast(message.error ?? "Unable to open folder", "warning");
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_PROPERTIES_UPDATE - Update workflow-level properties
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE] = (message) => {
    const settingsStore = useSettingsStore.getState();
    const workflowStore = useWorkflowStore.getState();

    // Handle both message.data and direct message structure (like vanilla implementation)
    const data = message.data || message;
    if (Object.prototype.hasOwnProperty.call(data, "workflowProperties")) {
      const normalized = normalizeWorkflowProperties(data.workflowProperties);
      settingsStore.setWorkflowProperties(normalized);
      // Incoming messages represent the full working-file workflow properties.
      // Replace rather than merge so cleared overrides from undo/redo actually disappear.
      workflowStore.syncIncomingWorkflowProperties(normalized);
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_LOADED - Workflow loaded, enable UI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_LOADED] = () => {
    const settingsStore = useSettingsStore.getState();
    const editorStore = useEditorStore.getState();
    settingsStore.setWorkflowLoaded(true);
    editorStore.setHasActiveQueue(true);
    clearPanelReconnectReloadWatchdog();
    // Belt-and-suspenders: lift the startup overlay if STARTUP_COMPLETE hasn't
    // arrived yet (e.g. reconnect/reload path where WORKFLOW_LOADED arrives first).
    useUiStore.getState().setStartupReady(true);
  };

  // --------------------------------------------------------------------------
  // STARTUP_COMPLETE - Extension startup sequence finished (with or without session)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STARTUP_COMPLETE] = () => {
    const { fileName } = useWorkflowStore.getState();
    const { activeWorkflowWorkingFilePath, startupReady } =
      useUiStore.getState();
    WebviewLog.debug(
      `[startup] STARTUP_COMPLETE received — overlay already dismissed: ${startupReady}`
    );
    clearPanelReconnectReloadWatchdog();
    useUiStore.getState().setStartupReady(true);
    // If startup completed with no session and no persisted target workflow,
    // auto-create a blank workflow so the user lands on "New Workflow" rather
    // than the "No workflow loaded" empty state.
    if (!fileName && !activeWorkflowWorkingFilePath) {
      getVsCodeApi().postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_UNLOADED - Workflow unloaded, disable UI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_UNLOADED] = () => {
    const settingsStore = useSettingsStore.getState();
    const workflowStore = useWorkflowStore.getState();
    const editorStore = useEditorStore.getState();
    const vscode = getVsCodeApi();

    settingsStore.setWorkflowLoaded(false);
    settingsStore.clearWorkflowProperties();
    workflowStore.syncIncomingWorkflowProperties({});
    workflowStore.resetWorkflow();
    editorStore.setHasActiveQueue(false);

    // Save new prompt state before resetting so it survives workflow changes.
    // cancelEdit() will restore savedNewPromptState (if editing) or fall back
    // to VS Code persistent state, preserving whatever the user has typed.
    editorStore.saveToVsCodeState(vscode);
    editorStore.cancelEdit();
  };

  // --------------------------------------------------------------------------
  // CONFIG_VALUE - Response to GET_CONFIG request
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CONFIG_VALUE] = (message) => {
    // Config values are typically handled by specific components
    // that requested them. This handler logs for debugging.
    WebviewLog.debug(
      `[MessageHandler] Received CONFIG_VALUE: ${message.key} = ${message.value}`
    );
  };

  // --------------------------------------------------------------------------
  // COMPLETIONS_RESPONSE - Autocomplete suggestions for editor
  // --------------------------------------------------------------------------
  // Completions are handled by the editor component directly — no action needed here.
  handlers[MESSAGE_TYPES.COMPLETIONS_RESPONSE] = () => {};

  // --------------------------------------------------------------------------
  // CONTEXT_REFS_VALIDATION - Handled by CodeMirrorEditor.tsx
  // --------------------------------------------------------------------------
  // The editor listens for validation results directly so it can resolve the
  // per-request promise. Register a no-op here so the central router doesn't
  // misclassify this valid extension message as unknown.
  handlers[MESSAGE_TYPES.CONTEXT_REFS_VALIDATION] = () => {};

  // --------------------------------------------------------------------------
  // ATTACHMENT_TOKEN_COUNTS_RESPONSE - Handled by useAttachmentTokenCount.ts
  // --------------------------------------------------------------------------
  // This message is consumed by a module-level window listener in
  // useAttachmentTokenCount.ts (singleton pattern for cross-mount caching).
  // Register a no-op here so the central router doesn't log "Unknown message type".
  handlers[MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE] = () => {};

  // --------------------------------------------------------------------------
  // RUN_HISTORY_UPDATED - Available run count changed (new run initialized)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RUN_HISTORY_UPDATED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    WebviewLog.debug(
      `[MessageHandler] RUN_HISTORY_UPDATED: runCount=${message.runCount}, runTimestamps=${JSON.stringify(message.runTimestamps)}`
    );
    const update: {
      availableRuns: number;
      runTimestamps?: (number | undefined)[];
      runStates?: (string | undefined)[];
    } = {
      availableRuns: message.runCount,
    };
    if (message.runTimestamps !== undefined) {
      update.runTimestamps = message.runTimestamps;
    }
    if (message.runStates !== undefined) {
      update.runStates = message.runStates;
    }
    useUiStore.setState(update);
  };

  // --------------------------------------------------------------------------
  // OUTPUT_HISTORY_LOADED - Load a historical run for display
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.OUTPUT_HISTORY_LOADED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    const {
      history,
      availableRuns,
      currentRunIndex,
      runTimestamps,
      runStates,
    } = message;
    if (!history || availableRuns === 0) {
      // History was cleared — reset to live view with no available runs
      useWorkflowStore.getState().clearHistoryOutputs();
      useUiStore.getState().clearHistoryView();
      // Also clear availableRuns since all history was deleted
      useUiStore.setState({
        availableRuns: 0,
        runTimestamps: [],
        runStates: [],
      });
    } else {
      const workflowStore = useWorkflowStore.getState();
      const uiStore = useUiStore.getState();
      const isLiveCurrentRun =
        currentRunIndex === 0 &&
        workflowStore.executionState === EXECUTION_STATES.RUNNING;

      if (isLiveCurrentRun) {
        // Workflow replay may send the newest run's history after SESSION_RESTORED.
        // During an active run, index 0 represents the live run, so keep the
        // output panel on live data and only refresh the run selector metadata.
        workflowStore.clearHistoryOutputs();
        uiStore.clearHistoryView();
        uiStore.setRunTimestamps(runTimestamps ?? []);
        uiStore.setRunStates(runStates ?? []);
        useUiStore.setState({ availableRuns });
        return;
      }

      WebviewLog.debug(
        `[MessageHandler] OUTPUT_HISTORY_LOADED: availableRuns=${availableRuns}, runTimestamps=${JSON.stringify(runTimestamps)}`
      );
      workflowStore.loadHistoryRun(history, availableRuns, currentRunIndex);
      if (runTimestamps !== undefined) {
        uiStore.setRunTimestamps(runTimestamps);
      }
      if (runStates !== undefined) {
        uiStore.setRunStates(runStates);
      }
    }
  };

  // --------------------------------------------------------------------------
  // QUEUE_SIZE_LIMIT_REACHED - Queue hit size limit
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.QUEUE_SIZE_LIMIT_REACHED] = (message) => {
    const store = useWorkflowStore.getState();
    const entry: OrderedStatusHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      statusMessage: {
        message: `Queue size limit reached: ${message.currentSize}/${message.maxSize}`,
        severity: "warning",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: store.liveSequence,
    };
    store.appendLiveEntry(entry);
  };

  // --------------------------------------------------------------------------
  // EXECUTION_TIME_LIMIT_REACHED - Execution hit time limit
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_TIME_LIMIT_REACHED] = (message) => {
    const store = useWorkflowStore.getState();
    const entry: OrderedStatusHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      statusMessage: {
        message: `Execution time limit reached: ${message.elapsedSeconds}/${message.maxSeconds}s (${message.completedCount}/${message.totalCount} prompts)`,
        severity: "warning",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: store.liveSequence,
    };
    store.appendLiveEntry(entry);

    store.setExecutionState(EXECUTION_STATES.STOPPED);
  };

  // --------------------------------------------------------------------------
  // SAVE_WORKFLOW_DIALOG_DATA - Extension responded with defaults; open dialog
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.openSaveWorkflowDialog({
      defaultPath: message.defaultPath,
      defaultFormat: message.defaultFormat,
      workflowsDir: message.workflowsDir,
    });
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_SAVED - File was written successfully; close dialog + toast
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_SAVED] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.closeSaveWorkflowDialog();
    // Extract filename for a concise toast
    const fileName = message.filePath.split(/[/\\]/).pop() ?? message.filePath;
    uiStore.showToast(`Saved as ${fileName}`, "success");
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_SAVE_FAILED - Save failed; close dialog and show error toast
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_SAVE_FAILED] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.closeSaveWorkflowDialog();
    uiStore.showToast(`Save failed: ${message.error}`, "error");
  };

  // --------------------------------------------------------------------------
  // WORKFLOWS_LIST - Full list of loaded workflow summaries
  // Only track active workflows in the frontend loadedWorkflows array;
  // COMPLETED/ERROR/STOPPED appear in the output history section instead.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOWS_LIST] = (message) => {
    const all = (message.workflows ?? []) as WorkflowSummary[];
    const active = all.filter((w) => isWorkflowActive(w.executionState));
    WebviewLog.debug(
      `[WORKFLOWS_LIST] received ${all.length} total, ${active.length} active: ${active.map((w) => `inst:${w.id.slice(0, 8)}(name="${w.workflowName || "(empty)"}", state=${w.executionState}, fp=${w.filePath?.split(/[\\/]/).pop() || "?"})`).join(", ") || "(none)"}` +
        (all.length > active.length
          ? ` | filtered out ${all.length - active.length} non-active: ${all
              .filter((w) => !isWorkflowActive(w.executionState))
              .map((w) => `inst:${w.id.slice(0, 8)}(state=${w.executionState})`)
              .join(", ")}`
          : "")
    );
    useUiStore.getState().setLoadedWorkflows(active);
    const activeWorkflowId = useUiStore.getState().activeWorkflowId;
    const activeSummary = all.find((w) => w.id === activeWorkflowId);
    if (activeSummary?.workingFilePath) {
      useUiStore
        .getState()
        .setActiveWorkflowWorkingFilePath(activeSummary.workingFilePath);
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_ADDED - New workflow instance entered an active state.
  // The orchestrator now only sends this message once the queue has actually
  // transitioned to an active state (via onDidChangeState), so the summary is
  // always in an active state.  The RUNNING/PAUSED guard below is kept as
  // defensive code.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_ADDED] = (message) => {
    const summary: WorkflowSummary | undefined = message.summary;
    const uiStore = useUiStore.getState();
    WebviewLog.debug(
      `[WORKFLOW_ADDED] inst:${summary?.id.slice(0, 8)} name="${summary?.workflowName || "(empty)"}" state=${summary?.executionState} ` +
        `fp=${summary?.filePath?.split(/[\\/]/).pop() || "?"} wfp=${summary?.workingFilePath?.split(/[\\/]/).pop() || "?"} ` +
        `— current loadedWorkflows: [${uiStore.loadedWorkflows.map((w) => `inst:${w.id.slice(0, 8)}(name="${w.workflowName || "(empty)"}", state=${w.executionState})`).join(", ") || "(none)"}]`
    );
    if (summary && isWorkflowActive(summary.executionState)) {
      useUiStore.getState().addLoadedWorkflow(summary);
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_DISMISSED - Workflow instance was removed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_DISMISSED] = (message) => {
    const uiStore = useUiStore.getState();
    const dismissed = uiStore.loadedWorkflows.find(
      (w) => w.id === message.workflowId
    );
    WebviewLog.debug(
      `[WORKFLOW_DISMISSED] inst:${message.workflowId?.slice(0, 8)} ` +
        `(was: name="${dismissed?.workflowName || "(not found)"}" state=${dismissed?.executionState || "?"}) ` +
        `— loadedWorkflows before: [${uiStore.loadedWorkflows.map((w) => `inst:${w.id.slice(0, 8)}`).join(", ") || "(none)"}]`
    );
    if (message.workflowId) {
      uiStore.removeLoadedWorkflow(message.workflowId);
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_SUMMARY_UPDATED - Workflow execution state changed
  // If now active: upsert into loadedWorkflows.
  // If now COMPLETED/ERROR/STOPPED: remove from loadedWorkflows.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED] = (message) => {
    const summary: WorkflowSummary | undefined = message.summary;
    if (!summary) return;
    const uiStore = useUiStore.getState();
    if (isWorkflowActive(summary.executionState)) {
      const exists = uiStore.loadedWorkflows.some((w) => w.id === summary.id);
      if (exists) {
        uiStore.updateLoadedWorkflow(summary);
      } else {
        uiStore.addLoadedWorkflow(summary);
      }
    } else if (
      summary.executionState === EXECUTION_STATES.COMPLETED ||
      summary.executionState === EXECUTION_STATES.ERROR ||
      summary.executionState === EXECUTION_STATES.STOPPED
    ) {
      // Workflow reached a terminal state — remove from the running section
      uiStore.removeLoadedWorkflow(summary.id);
    }
    // IDLE: do nothing — transient state during load/clear, not a terminal state

    // If this is the currently active workflow, sync workflowStore so the
    // WorkflowStepsPanel stays in sync during CLI watch mode step advances.
    // WorkflowSummary.currentStep is 0-indexed (matches workflowStore.currentStep).
    if (summary.id === uiStore.activeWorkflowId) {
      const workflowStore = useWorkflowStore.getState();
      workflowStore.setCurrentStep(summary.currentStep);
      workflowStore.setTotalSteps(summary.totalSteps);
      workflowStore.setExecutionState(summary.executionState);
    }
  };

  // --------------------------------------------------------------------------
  // ACTIVE_WORKFLOW_CHANGED - Active workflow selection changed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED] = (message) => {
    WebviewLog.debug(
      `[ACTIVE_WORKFLOW_CHANGED] workflowId=inst:${message.workflowId?.slice(0, 8)}`
    );
    if (message.workflowId) {
      useUiStore.getState().setActiveWorkflowId(message.workflowId);
    }
    if ("workingFilePath" in message) {
      persistViewedWorkingFilePath(message.workingFilePath);
    }
    // Full state sync comes via SESSION_RESTORED which is already handled
  };

  handlers[MESSAGE_TYPES.INSERT_PROMPT_REFERENCES] = (message) => {
    if (!message.data) {
      return;
    }

    useUiStore.getState().setEditorCollapsed(false);
    const editorStore = useEditorStore.getState();
    editorStore.preparePromptEditorForInsert();
    editorStore.enqueuePromptEditorInsert(message.data);
  };

  // --------------------------------------------------------------------------
  // STEP_UNDO_DATA_UPDATED - Live snapshot metadata after prompt completes
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STEP_UNDO_DATA_UPDATED] = (message) => {
    const workspaceSnapshot = message.workspaceSnapshot;
    const target = message.target;
    if (!target) return;
    if (workspaceSnapshot) {
      useWorkflowStore
        .getState()
        .setWorkspaceSnapshot(target, workspaceSnapshot);
    }
  };

  // --------------------------------------------------------------------------
  // UNDO_PROMPT_RESULT - Result of the restore operation
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.UNDO_PROMPT_RESULT] = (message) => {
    const data = message.data;
    if (!data?.requestId) return;
    useWorkflowStore.getState().setUndoResult(data.requestId, {
      restoredFiles: data.restoredFiles ?? [],
      failedFiles: data.failedFiles ?? [],
      redoInstructions: data.redoInstructions ?? [],
    });
  };

  // --------------------------------------------------------------------------
  // UNDO_RECORD_UPDATED - UndoRecord for a target updated after undo/redo
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.UNDO_RECORD_UPDATED] = (message) => {
    const m = message as UndoRecordUpdatedMessage;
    if (!m.target || !m.undoRecord) return;
    useWorkflowStore.getState().setUndoRecord(m.target, m.undoRecord);
    useWorkflowStore
      .getState()
      .updateHistoryStepUndoRecord(m.target, m.undoRecord);
  };

  // --------------------------------------------------------------------------
  // SERVER_STARTED - Extension started the server; store URL and running state
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SERVER_STARTED] = (message) => {
    const settingsStore = useSettingsStore.getState();
    settingsStore.setServerRunning(true);
    settingsStore.setServerUrl(message.url ?? null);
    const ips: string[] = Array.isArray(message.availableIps)
      ? message.availableIps
      : [];
    settingsStore.setAvailableIps(ips);
    settingsStore.setSelectedDisplayIp(ips[0] ?? null);
  };

  // --------------------------------------------------------------------------
  // SERVER_STOPPED - Extension stopped the server
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SERVER_STOPPED] = (_message) => {
    const settingsStore = useSettingsStore.getState();
    settingsStore.setServerRunning(false);
    settingsStore.setServerUrl(null);
    settingsStore.setAvailableIps([]);
    settingsStore.setSelectedDisplayIp(null);
  };

  // --------------------------------------------------------------------------
  // SERVER_TOKEN_REGENERATED - Token deleted; user must restart server
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SERVER_TOKEN_REGENERATED] = (_message) => {
    useUiStore
      .getState()
      .showToast(
        "Server token regenerated. Restart the server to apply the new token.",
        "info"
      );
  };

  // --------------------------------------------------------------------------
  // CAPTURE_THEME_VARS - Extension wants the webview to capture --vscode-* CSS vars
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CAPTURE_THEME_VARS] = (_message) => {
    captureAndSendThemeVars(getVsCodeApi());
  };

  // ========================================================================
  // TERMINAL I/O
  // ========================================================================

  registerTerminalHandlers(handlers);

  return handlers;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook to set up message handling for the FlightPath dashboard
 *
 * All message handlers are centralized in createMessageHandlers() function.
 * This hook sets up the message listener and provides a sendMessage helper.
 *
 * Usage:
 * ```tsx
 * function App() {
 *   useMessageHandler();
 *
 *   const handleRun = () => sendMessage(MESSAGE_TYPES.RUN);
 *
 *   return <button onClick={handleRun}>Run</button>;
 * }
 * ```
 */
export function useMessageHandler(): UseMessageHandlerReturn {
  // Create handlers once (stable reference)
  const handlers = useMemo(() => createMessageHandlers(), []);

  // Set up message listener
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      const handler = handlers[message.type];

      if (handler) {
        handler(message);
      } else {
        WebviewLog.warn(
          `[MessageHandler] Unknown message type: ${message.type}`
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handlers]);

  // Memoize sendMessage to maintain stable reference
  const sendMessageCallback = useCallback(
    (type: string, payload?: Record<string, unknown>) => {
      sendMessage(type, payload);
    },
    []
  );

  return { sendMessage: sendMessageCallback };
}

// ============================================================================
// Control Actions (convenience functions for common operations)
// ============================================================================

/**
 * Send RUN command to start workflow execution
 */
export function sendRun(): void {
  sendMessage(MESSAGE_TYPES.RUN);
}

/**
 * Send PAUSE command to pause workflow execution
 */
export function sendPause(): void {
  sendMessage(MESSAGE_TYPES.PAUSE);
}

/**
 * Send RESUME command to resume paused workflow
 */
export function sendResume(): void {
  sendMessage(MESSAGE_TYPES.RESUME);
}

/**
 * Send STOP command to stop workflow execution
 */
export function sendStop(): void {
  sendMessage(MESSAGE_TYPES.STOP);
}

/**
 * Toggle pause/resume based on current execution state
 */
export function togglePauseResume(): void {
  const workflowStore = useWorkflowStore.getState();
  const { executionState } = workflowStore;

  if (
    executionState === EXECUTION_STATES.PAUSED ||
    executionState === EXECUTION_STATES.STOPPED
  ) {
    sendResume();
  } else {
    sendPause();
  }
}

/**
 * Request recent workflows list from extension
 */
export function requestRecentWorkflows(): void {
  sendMessage(MESSAGE_TYPES.GET_RECENT_WORKFLOWS);
}

/**
 * Load a specific workflow file
 */
export function loadWorkflow(path: string): void {
  sendMessage(MESSAGE_TYPES.LOAD_WORKFLOW, { path });
}

/**
 * Clear current workflow
 */
export function clearWorkflow(): void {
  sendMessage(MESSAGE_TYPES.CLEAR_WORKFLOW);
}

/**
 * Open VS Code settings for FlightPath
 */
export function openSettings(): void {
  sendMessage(MESSAGE_TYPES.OPEN_SETTINGS);
}

/**
 * Request new workflow modal
 */
export function requestNewWorkflow(): void {
  sendMessage(MESSAGE_TYPES.NEW_WORKFLOW);
}

/**
 * Select a template for new workflow
 */
export function selectTemplate(templateId: string): void {
  sendMessage(MESSAGE_TYPES.TEMPLATE_SELECTED, { templateId });
}

/**
 * Create workflow from template
 */
export function createWorkflow(
  name: string,
  templateId: string,
  variables?: Record<string, unknown>
): void {
  sendMessage(MESSAGE_TYPES.CREATE_WORKFLOW, { name, templateId, variables });
}

/**
 * Change the active harness
 */
export function changeHarness(harness: HarnessId): void {
  sendMessage(MESSAGE_TYPES.CHANGE_HARNESS, { harness });
}

/**
 * Change the active model
 */
export function changeModel(model: string): void {
  sendMessage(MESSAGE_TYPES.CHANGE_MODEL, { model });
}

/**
 * Change the active agent
 */
export function changeAgent(agent: string): void {
  sendMessage(MESSAGE_TYPES.CHANGE_AGENT, { agent });
}

/**
 * Update a workflow property
 */
export function updateWorkflowProperty(key: string, value: unknown): void {
  sendMessage(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY, { key, value });
}

/**
 * Set a workflow property as global default
 */
export function setAsDefault(key: string, value: unknown): void {
  sendMessage(MESSAGE_TYPES.SET_AS_DEFAULT, { key, value });
}

/**
 * Delete a prompt from the queue
 */
export function deletePrompt(index: number): void {
  sendMessage(MESSAGE_TYPES.DELETE_PROMPT, { promptIndex: index });
}

/**
 * Select a prompt for editing
 */
export function selectPromptForEdit(index: number): void {
  sendMessage(MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT, { promptIndex: index });
}

/**
 * Open a file in VS Code editor
 */
export function openFile(path: string, line?: number): void {
  sendMessage(MESSAGE_TYPES.OPEN_FILE, {
    path,
    lineStart: line,
    lineEnd: line,
  });
}
