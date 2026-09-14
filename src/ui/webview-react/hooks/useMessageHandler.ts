/**
 * ctrlyoke Message Handler Hook
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
import { getVsCodeApi, isStandalone, panelPageLoadId } from "./useVsCodeApi";
import {
  useWorkflowStore,
  isStepContentEqual,
  type WorkflowStep,
} from "../store/workflowStore";
import {
  useSettingsStore,
  type WorkflowProperties,
} from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { useEditorStore } from "../store/editorStore";
import { useRunSummaryCacheStore } from "../store/runSummaryCacheStore";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  EXECUTION_MODES,
  STEP_STATUS,
  EDITOR_TARGET_KINDS,
  SESSION_KINDS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  getExecutionPhaseForScriptOutputSource,
  WORKFLOW_PROPERTY_KEYS,
  type WorkflowPropertyKey,
  type ExecutionState,
  type StepStatus,
  type WorkflowSummary,
  type UndoRecordUpdatedMessage,
  type HistorySearchResult,
} from "../types/messages";
import type {
  OrderedCliHistoryEntry,
  OrderedStatusHistoryEntry,
  OutputExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import type { TerminalSettings } from "@root/types/WebviewMessageTypes";
import { WebviewLog } from "@utils/logger";
import {
  isExecutionFinished,
  isWorkflowActive,
  isWorkflowRunning,
} from "../utils/status";
import { useTerminalStore } from "../store/terminalStore";
import { useHarnessFileStore } from "../store/useHarnessFileStore";
import { useMcpManagerStore } from "../store/useMcpManagerStore";
import { useWorkspaceViewerStore } from "../store/workspaceViewerStore";
import { useCompatibilityStore } from "../store/compatibilityStore";
import { useExecutionPreviewStore } from "../store/executionPreviewStore";
import { useHarnessUsageStore } from "../store/harnessUsageStore";
import { useWorkspaceStatsStore } from "../store/workspaceStatsStore";
import { useSecretRegistryStore } from "../store/secretRegistryStore";
import { useBatchApprovalStore } from "../store/batchApprovalStore";
import { useChoiceStore } from "../store/choiceStore";
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
import {
  COMPLETION_NOTIFICATION_SEVERITY,
  NOTIFICATION_KINDS,
  THEME_KINDS,
  USER_FEEDBACK_SEVERITY,
  UX_SNAPSHOT_STATUSES,
  type UserFeedbackSeverity,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type {
  CompletionNotificationEventPayload,
  UserFeedbackMessage,
} from "@root/types/WebviewMessageTypes";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { autoFocusOutputOnExecution } from "@utils/executionOutputFocus";
import { getReadyPreferredViewAddress } from "@/navigation/readyRoute";
import { getWorkflowDefinitionMutation } from "../utils/workflowMutation";
import {
  areWorkflowAddressesEqual,
  workflowViewAddressKey,
} from "@utils/viewAddress";
import { getTargetKey, toOutputMessageTarget } from "@utils/outputProjection";
import { navigateToWorkflowAddress } from "@utils/runNavigation";
import { serializeRoute } from "@/navigation/route";
import { notifyUser } from "@utils/notifyUser";

// ============================================================================
// Types
// ============================================================================

export type MessageHandler = (message: any) => void;
export type MessageHandlerMap = Record<string, MessageHandler>;

function openWorkflowAddressInNewTab(address: WorkflowViewAddress): void {
  if (typeof window === "undefined") return;
  const url = `${window.location.pathname}${serializeRoute(
    { workflow: address },
    window.location.search
  )}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function isCompletionNotificationEvent(
  value: unknown
): value is CompletionNotificationEventPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    (event.kind === NOTIFICATION_KINDS.WORKFLOW ||
      event.kind === NOTIFICATION_KINDS.PROMPT ||
      event.kind === NOTIFICATION_KINDS.HOOK) &&
    typeof event.title === "string" &&
    typeof event.body === "string" &&
    typeof event.tag === "string" &&
    (event.severity === COMPLETION_NOTIFICATION_SEVERITY.INFO ||
      event.severity === COMPLETION_NOTIFICATION_SEVERITY.WARNING ||
      event.severity === COMPLETION_NOTIFICATION_SEVERITY.ERROR)
  );
}

function isUserFeedbackMessage(value: unknown): value is UserFeedbackMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const feedback = value as Record<string, unknown>;
  const validSeverity = Object.values(USER_FEEDBACK_SEVERITY).includes(
    feedback.severity as UserFeedbackSeverity
  );
  return (
    typeof feedback.id === "string" &&
    typeof feedback.message === "string" &&
    validSeverity &&
    (feedback.detail === undefined || typeof feedback.detail === "string") &&
    (feedback.dedupeKey === undefined || typeof feedback.dedupeKey === "string")
  );
}

export interface UseMessageHandlerReturn {
  /** Send a message to the extension */
  sendMessage: (type: string, payload?: Record<string, unknown>) => void;
}

/**
 * Messages whose state belongs to the live PTY transport rather than the
 * definition/output snapshot currently displayed by run navigation.
 */
const RUN_VIEW_INDEPENDENT_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.TERMINAL_STARTED,
  MESSAGE_TYPES.TERMINAL_OUTPUT,
  MESSAGE_TYPES.TERMINAL_ENDED,
  MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
  MESSAGE_TYPES.TERMINAL_SIZE_CHANGED,
  MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
]);

// ============================================================================
// Send Message Helper
// ============================================================================

function getPanelLifecycleActionLabel(type: string): string | undefined {
  switch (type) {
    case MESSAGE_TYPES.RUN:
    case MESSAGE_TYPES.EXECUTE_DRAFT:
    case MESSAGE_TYPES.CONTINUE_RUN:
    case MESSAGE_TYPES.SEED_NEW_RUN:
    case MESSAGE_TYPES.START_NEW_RUN_INSTEAD:
      return "run start requested";
    case MESSAGE_TYPES.RESUME_RUN:
      return "run resume requested";
    case MESSAGE_TYPES.PAUSE_RUN:
      return "run pause requested";
    case MESSAGE_TYPES.CANCEL_PAUSE_RUN:
      return "run pause cancellation requested";
    case MESSAGE_TYPES.STOP_RUN:
    case MESSAGE_TYPES.STOP_CLI_RUN:
      return "run stop requested";
    default:
      return undefined;
  }
}

/**
 * Send a message to the extension
 * Can be used outside of React components via direct import
 */
export function sendMessage(
  type: string,
  payload?: Record<string, unknown>
): void {
  const vscode = getVsCodeApi();
  const lifecycleActionLabel = getPanelLifecycleActionLabel(type);
  if (lifecycleActionLabel) {
    WebviewLog.info(`[panel] ${lifecycleActionLabel}`);
  }
  const definitionMutationTypes = new Set<string>([
    MESSAGE_TYPES.UPDATE_PROMPT,
    MESSAGE_TYPES.UPDATE_STEP_COLOR,
    MESSAGE_TYPES.INSERT_WORKFLOW_STEP,
    MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
    MESSAGE_TYPES.DELETE_PROMPT,
    MESSAGE_TYPES.REORDER_PROMPTS,
    MESSAGE_TYPES.UNDO_REDO_SYNC,
  ]);
  const mutation = getWorkflowDefinitionMutation();
  vscode.postMessage({
    type,
    ...payload,
    ...(definitionMutationTypes.has(type) &&
    !("mutation" in (payload ?? {})) &&
    mutation
      ? { mutation }
      : {}),
  });
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
    ? THEME_KINDS.HIGH_CONTRAST
    : bodyClasses.contains("vscode-dark")
      ? THEME_KINDS.DARK
      : THEME_KINDS.LIGHT;
  vars["--cy-color-theme-kind"] = themeKind;

  vscodeApi.postMessage({ type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars });
}

/**
 * Compile-time guard that the shared key list and this store's property shape
 * stay in step. A key in one and not the other is invisible at runtime: the
 * value round-trips to disk but is dropped on the way back, so the panel quietly
 * shows a global default for a property the workflow has actually saved.
 */
type AssertNoKeyDrift<T extends never> = T;
export type WorkflowPropertyKeysAreComplete = AssertNoKeyDrift<
  Exclude<keyof WorkflowProperties, WorkflowPropertyKey>
>;
export type WorkflowPropertyKeysAreReal = AssertNoKeyDrift<
  Exclude<WorkflowPropertyKey, keyof WorkflowProperties>
>;

function normalizeWorkflowProperties(
  workflowProperties?: Partial<WorkflowProperties>
): WorkflowProperties {
  // Rebuilt from the shared key list rather than a literal, so a property added
  // to the panel cannot be persisted by the extension yet silently dropped here.
  return Object.fromEntries(
    WORKFLOW_PROPERTY_KEYS.map((key) => [key, workflowProperties?.[key]])
  ) as WorkflowProperties;
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

/**
 * Return whether a requestless definition snapshot would move the client
 * backwards. Equal revisions must also retain a longer step list because an
 * append can reach the client before a snapshot that started reading disk.
 */
function isRegressiveDefinitionSnapshot(
  incomingDefinitionRevision: number | undefined,
  currentDefinitionRevision: number | null,
  incomingStepCount: number,
  currentStepCount: number
): boolean {
  return (
    incomingDefinitionRevision !== undefined &&
    currentDefinitionRevision !== null &&
    (incomingDefinitionRevision < currentDefinitionRevision ||
      (incomingDefinitionRevision === currentDefinitionRevision &&
        incomingStepCount < currentStepCount))
  );
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
function applyWorkflowChange(options?: {
  preserveViewAddress?: boolean;
  /**
   * Skip the historyOutputs clear when the caller immediately replaces it
   * (loadHistoryRun) or explicitly nulls it (hydrateLiveRunHistory). Clearing
   * first would destroy the previous reference and defeat the structural
   * sharing that keeps identical replayed history identity-stable.
   */
  skipHistoryOutputsClear?: boolean;
}): void {
  if (!options?.skipHistoryOutputsClear) {
    useWorkflowStore.getState().clearHistoryOutputs();
  }
  useUiStore.getState().clearHistoryView();
  if (!options?.preserveViewAddress) {
    // The previous workflow's address and revisions cannot address the new one.
    // Holding them would aim the next mutation at the workflow the user just left.
    // Every path that lands on an addressable workflow republishes them — the
    // RUN_VIEW_LOADED that follows a load, or the WORKFLOW_VIEW_IDENTITY that
    // follows the first write to a brand-new workflow.
    useUiStore.setState({
      displayedViewAddress: null,
      displayedRunDirectory: null,
      appliedViewAddress: null,
      appliedDefinitionRevision: null,
      displayedDefinitionRevision: null,
      displayedDescriptorRevision: null,
      // FILE_SELECTED/SESSION_RESTORED describe a normal live workflow and do
      // not carry addressed-lineage metadata. Do not let the system-generated
      // read-only state from the previously viewed run leak into a new workflow.
      viewedLineageIsSystemGenerated: false,
    });
  }
  useUiStore.getState().setFinalStepFooterExpanded(false);

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
  useSettingsStore.getState().setWorkflowExternalRootsApprovalRequired(false);
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

/**
 * Single funnel for live execution-state transitions.
 *
 * A terminal state also ends the run this client tracks as executing. Nothing
 * else refreshes the addressed view at that moment, so the header would keep
 * reading the executing run's stale "running" summary and stay on Pause/Stop
 * instead of switching to Re-run the instant the workflow finishes.
 */
function applyExecutionState(state: ExecutionState): void {
  useWorkflowStore.getState().setExecutionState(state);
  if (isExecutionFinished(state)) {
    useUiStore.getState().markExecutionRunFinished(state);
  } else if (state === EXECUTION_STATES.RUNNING) {
    // Mirrors the finished-state sync above: a continuation/append on the
    // run the client is already displaying gets no backend-pushed run-view
    // refresh at this transition (see markExecutionRunStarted), so this
    // client-side nudge is what keeps the banner/run-panel from reading the
    // pre-continuation state until the run ends.
    useUiStore.getState().markExecutionRunStarted();
  }
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
export function createMessageHandlers(
  standalone: boolean = isStandalone
): MessageHandlerMap {
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
    if (data.licenseAccess) {
      settingsStore.setLicenseAccess(data.licenseAccess);
    }
    workflowStore.setCoordinationScope(data.coordinationScope ?? null);

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
        activeStepIndices: data.activeStepIndices ?? [],
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

  handlers[MESSAGE_TYPES.COORDINATION_SCOPE_UPDATED] = (message) => {
    useWorkflowStore.getState().setCoordinationScope(message.scope);
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
    if (message.licenseAccess) {
      settingsStore.setLicenseAccess(message.licenseAccess);
    }
  };

  handlers[MESSAGE_TYPES.OPEN_GLOBAL_SETTINGS_TAB] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setGlobalSettingsTab(message.tab);
    if (!uiStore.globalSettingsOpen) uiStore.toggleGlobalSettings();
  };

  // --------------------------------------------------------------------------
  // GLOBAL_SETTINGS_LOADED - Full global settings from configService
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED] = (message) => {
    const settingsStore = useSettingsStore.getState();
    if (message.settings) {
      settingsStore.setFullGlobalSettings(message.settings);
      if (message.settings.licenseAccess) {
        settingsStore.setLicenseAccess(message.settings.licenseAccess);
      }
      if (message.settings.settings?.terminal) {
        applyTerminalSettings(message.settings.settings.terminal);
      }
    }
    settingsStore.setLastCommitMessageGeneration(
      message.commitMessageGeneration ?? null
    );
    if (message.certMeta) {
      settingsStore.setLastCertGenerated(message.certMeta);
    } else if (!message.settings?.settings?.server?.tls?.enabled) {
      settingsStore.setLastCertGenerated(null);
    }
  };

  handlers[MESSAGE_TYPES.HARNESS_USAGE_UPDATED] = (message) => {
    if (Array.isArray(message.snapshots)) {
      useHarnessUsageStore.getState().setSnapshots(message.snapshots);
    }
  };

  handlers[MESSAGE_TYPES.WORKSPACE_STATS_UPDATED] = (message) => {
    useWorkspaceStatsStore.getState().setSnapshot(message.snapshot);
  };

  handlers[MESSAGE_TYPES.GLOBAL_SETTING_UPDATED] = (message) => {
    applyTerminalSetting(message.path, message.value);
  };

  handlers[MESSAGE_TYPES.WORKTREE_MANAGEMENT_STATE] = (message) => {
    const store = useSettingsStore.getState();
    store.setWorktreeManagement(message.state ?? null);
    if (message.requestId) {
      store.setWorktreeActionResult(message.requestId, {
        success: true,
        message: "Refreshed.",
      });
    }
  };

  handlers[MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION_RESULT] = (message) => {
    if (message.requestId) {
      useSettingsStore.getState().setWorktreeActionResult(message.requestId, {
        success: Boolean(message.success),
        message: message.message ?? "",
      });
    }
  };

  handlers[MESSAGE_TYPES.LICENSE_MACHINES_UPDATED] = (message) => {
    useSettingsStore.getState().setLicenseMachines(message.machines ?? []);
  };

  handlers[MESSAGE_TYPES.LICENSE_ACTION_RESULT] = (message) => {
    useSettingsStore.getState().setLicenseActionResult({
      action: message.action,
      status: message.status,
      message: message.message,
    });
  };

  // Script creation replies are consumed by the ScriptConditionEditor instance
  // that issued the request. Register them here so the central dispatcher does
  // not report the addressed, component-local replies as unknown messages.
  handlers[MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATED] = () => undefined;
  handlers[MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATION_FAILED] = () =>
    undefined;
  handlers[MESSAGE_TYPES.HARNESS_DETECTION_RETRY_RESULT] = (message) => {
    if (typeof message.requestId !== "string") {
      return;
    }
    useUiStore.getState().setHarnessDetectionRetryResult({
      requestId: message.requestId,
      success: message.success === true,
      ...(typeof message.error === "string" ? { error: message.error } : {}),
    });
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
    notifyUser(
      message.success ? "Command completed" : "Command failed",
      message.success
        ? USER_FEEDBACK_SEVERITY.SUCCESS
        : USER_FEEDBACK_SEVERITY.ERROR
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
        "__cyExpectServerRestart"
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
    getVsCodeApi().postMessage({
      type: MESSAGE_TYPES.READY,
      preferredViewAddress: getReadyPreferredViewAddress(),
      pageLoadId: panelPageLoadId,
    });
    // schedulePanelReconnectReloadWatchdog() is a no-op when this is a fresh
    // page load that already sent READY via BootstrapApp (freshPageReadySent=true).
    // It only arms the watchdog for retained contexts where the panel hasn't
    // yet received CLIENT_ID_ASSIGNED from the new extension host.
    schedulePanelReconnectReloadWatchdog();
  };

  handlers[MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE] = (message) => {
    notifyUser(
      message.reason ?? "Developer command unavailable",
      USER_FEEDBACK_SEVERITY.ERROR
    );
  };

  handlers[MESSAGE_TYPES.UX_SNAPSHOT_SAVED] = (message) => {
    const ui = useUiStore.getState();
    if (message.error) {
      ui.setUxSnapshotStatus(UX_SNAPSHOT_STATUSES.ERROR);
      notifyUser(
        `UX snapshot failed: ${message.error}`,
        USER_FEEDBACK_SEVERITY.ERROR
      );
      return;
    }
    ui.setUxSnapshotStatus(UX_SNAPSHOT_STATUSES.SAVED);
    notifyUser(
      `UX snapshot saved to ${message.path}`,
      USER_FEEDBACK_SEVERITY.SUCCESS
    );
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
      parallelGroups: message.parallelGroups || [],
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
    const incomingDefinitionRevision =
      typeof message.definitionRevision === "number"
        ? message.definitionRevision
        : undefined;
    const currentUiState = useUiStore.getState();
    const currentDefinitionRevision = currentUiState.appliedDefinitionRevision;
    const currentStepCount = useWorkflowStore.getState().steps.length;
    const incomingStepCount = message.steps?.length ?? 0;
    // Replay of the *currently displayed* workflow, versus a load that replaces
    // it. WorkflowTaggedSink supplies workflowId for live updates; the direct,
    // untagged SESSION_RESTORED that replayWorkflowStateTo sends follows the
    // addressed RUN_VIEW_LOADED for the same workflow, so it must not clear
    // that view's identity and may be guarded against regressing it.
    //
    // The revision is what separates the two, and that makes this an
    // omission-based contract: a producer whose SESSION_RESTORED *replaces* the
    // displayed workflow must not send definitionRevision (see the comment in
    // PromptFileLoader's restore branch). This message carries no address, so
    // the guard below cannot tell two workflows' revisions apart — classifying
    // a replacement as a replay would compare unrelated revision numbers and
    // silently drop the incoming workflow.
    const isReplay =
      message.workflowId === undefined &&
      incomingDefinitionRevision !== undefined;
    if (
      isReplay &&
      isRegressiveDefinitionSnapshot(
        incomingDefinitionRevision,
        currentDefinitionRevision,
        incomingStepCount,
        currentStepCount
      )
    ) {
      WebviewLog.debug(
        `[SESSION_RESTORED] ignoring regressive snapshot: ` +
          `revision ${incomingDefinitionRevision}/${currentDefinitionRevision}, ` +
          `steps ${incomingStepCount}/${currentStepCount}`
      );
      return;
    }
    useWorkflowStore.getState().loadWorkflow({
      fileName: message.fileName,
      workflowName: message.workflowName,
      steps: message.steps || [],
      parallelGroups: message.parallelGroups || [],
      executionState: message.executionState as ExecutionState,
      currentStep: message.currentIndex || 0,
      activeStepIndices: message.activeStepIndices ?? [],
      results: message.results || [],
      finalStep: message.finalStep ?? null,
      finalStepStatus: message.finalStepStatus ?? null,
      finalStepLoopCount: message.finalStepLoopCount ?? 0,
      finalStepPhase: message.finalStepPhase ?? null,
    });
    persistViewedWorkingFilePath(message.workingFilePath);
    applyWorkflowChange({ preserveViewAddress: isReplay });
    if (isReplay && incomingDefinitionRevision !== undefined) {
      useUiStore
        .getState()
        .markAppliedDefinitionRevision(incomingDefinitionRevision);
    }
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

    // Queue growth is a definition mutation. Adopt its revision together with
    // the visible steps so edits made while the newly appended step is still
    // running do not submit the previous head and fail as stale. The value is
    // monotonic only within an address; run-view loads remain responsible for
    // resetting it when navigation/promotions move to another address.
    if (message.definitionRevision !== undefined) {
      const definitionRevision = message.definitionRevision;
      const displayedAddress = useUiStore.getState().displayedViewAddress;
      if (displayedAddress) {
        useExecutionPreviewStore
          .getState()
          .observeDefinitionRevision(displayedAddress, definitionRevision);
      }
      useUiStore.setState((state) => ({
        displayedDefinitionRevision:
          state.displayedDefinitionRevision === null
            ? definitionRevision
            : Math.max(state.displayedDefinitionRevision, definitionRevision),
      }));
      // The steps applied below are this revision's content, so the applied
      // head moves with them — otherwise the snapshot that follows a live
      // queue push is read as new content and clears runtime/undo state the
      // client already has.
      useUiStore.getState().markAppliedDefinitionRevision(definitionRevision);
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
      `[STEPS_EXTENDED] ${currentSteps.length} ${newSteps.length} steps${message.workflowId ? ` (CLI workflowId=${message.workflowId.slice(0, 8)})` : ""}`
    );
    // Only record an undo entry when the user actually changed something.
    // Count changes cover add/remove. Content changes (same count, any
    // user-editable field different — see isStepContentEqual) cover edits.
    // Pure re-syncs (file-watcher firing after the extension writes the
    // working file) have identical content and must not pollute the undo stack.
    const stepCountChanged = newSteps.length !== currentSteps.length;
    const stepContentChanged =
      !stepCountChanged &&
      newSteps.some(
        (p: WorkflowStep, i: number) =>
          !isStepContentEqual(p, currentSteps[i] as WorkflowStep)
      );
    const nextParallelGroups =
      message.parallelGroups ?? workflowStore.parallelGroups;
    const parallelGroupsChanged =
      JSON.stringify(nextParallelGroups) !==
      JSON.stringify(workflowStore.parallelGroups);
    // Also suppress undo recording for the initial auto-load (0 → N steps).
    // Loading from an empty state is a system-driven restore, not a user edit.
    const isInitialAutoLoad = currentSteps.length === 0;
    // Queue-state updates carry executionState when they are runtime echoes.
    // A topology mutation made while a workflow is running must update the
    // store without opening an undo entry; the user-facing action already
    // owns any edit history, while the runtime echo only synchronizes it.
    const isRuntimeEcho = message.executionState !== undefined;
    const shouldRecord =
      !isInitialAutoLoad &&
      !isRuntimeEcho &&
      (stepCountChanged || stepContentChanged || parallelGroupsChanged);
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
    workflowStore.setParallelGroups(nextParallelGroups);
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
  // STEP_COLOR_UPDATED - A run-addressed cosmetic step edit was persisted
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STEP_COLOR_UPDATED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) return;
    }

    if (message.definitionRevision !== undefined) {
      const displayedAddress = useUiStore.getState().displayedViewAddress;
      if (displayedAddress) {
        useExecutionPreviewStore
          .getState()
          .observeDefinitionRevision(
            displayedAddress,
            message.definitionRevision
          );
      }
      useUiStore.setState((state) => ({
        displayedDefinitionRevision:
          state.displayedDefinitionRevision === null
            ? message.definitionRevision
            : Math.max(
                state.displayedDefinitionRevision,
                message.definitionRevision
              ),
      }));
      useUiStore
        .getState()
        .markAppliedDefinitionRevision(message.definitionRevision);
    }

    useWorkflowStore
      .getState()
      .updatePrompt(message.index, { color: message.color ?? undefined });
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
    useWorkflowStore.temporal.getState().pause();
    workflowStore.setParallelGroups(
      message.parallelGroups ?? workflowStore.parallelGroups
    );
    useWorkflowStore.temporal.getState().resume();
  };

  // --------------------------------------------------------------------------
  // PROMPT_DELETED - Prompt was deleted from queue
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.PROMPT_DELETED] = (message) => {
    const workflowStore = useWorkflowStore.getState();

    rememberUndoRedoRuntime(workflowStore.steps);
    workflowStore.setFileName(message.fileName);
    workflowStore.setPrompts(message.steps || []);
    useWorkflowStore.temporal.getState().pause();
    workflowStore.setParallelGroups(
      message.parallelGroups ?? workflowStore.parallelGroups
    );
    useWorkflowStore.temporal.getState().resume();
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

    // A continuation can only begin after the backend commits its pending
    // rewind, which removes the durable marker and its discard snapshot. Every
    // viewer receives EXECUTION_STARTED, whereas the follow-up run-view refresh
    // may not arrive until execution has returned, so clear this view-local
    // snapshot here as well. Without this, a second viewer keeps showing the
    // stale "Discard Continuation" banner while the run is already executing.
    if (isContinuation && uiStore.pendingRewind !== null) {
      useUiStore.setState({ pendingRewind: null });
    }

    WebviewLog.info(
      `[EXECUTION_STARTED] isContinuation=${isContinuation}, preserveStepCount=${preserveStepCount}, ` +
        `totalSteps=${message.totalSteps}, isViewingHistory=${uiStore.isViewingHistory}, ` +
        `historyOutputs=${workflowStore.historyOutputs ? "exists" : "null"}, ` +
        `liveEntries=${workflowStore.liveOrderedEntries.length}`
    );

    if (isContinuation && preserveStepCount > 0) {
      // Append-continuation run: promote history entries into liveOrderedEntries BEFORE
      // clearing history view, so the user still sees previous prompts' output.
      WebviewLog.info(
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
      workflowStore.setActiveStepIndices(message.activeStepIndices ?? []);

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
      WebviewLog.info(
        `[EXECUTION_STARTED] Fresh start — clearing all runtime state`
      );
      workflowStore.clearHistoryOutputs();
      uiStore.clearHistoryView();

      workflowStore.setFileName(message.fileName);
      workflowStore.setExecutionState(EXECUTION_STATES.RUNNING);
      workflowStore.setTotalSteps(message.totalSteps);
      workflowStore.setCurrentStep(0);
      workflowStore.setActiveStepIndices(message.activeStepIndices ?? []);

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

    // Both branches above just set executionState to RUNNING directly
    // (not via applyExecutionState) — sync executionRunRef the same way that
    // path does, so a continuation on the run this client is already
    // displaying shows "Running" immediately instead of waiting on a
    // backend run-view refresh that (for an already-viewed run) never comes
    // until execution ends. See markExecutionRunStarted for why.
    useUiStore.getState().markExecutionRunStarted();

    // Mark editor as having active queue
    editorStore.setHasActiveQueue(true);

    // Handle ai-cli terminal sessions for the new run.
    const wfId = message.workflowId;
    if (wfId) {
      // Only the headless case can be decided from executionMode. It describes
      // where the step's *prompt* will eventually run, not that anything is
      // spawning now: pre-/end-conditions always run headlessly, so focusing the
      // terminal for an interactive step that opens with a pre-condition shows
      // an empty pane — permanently, when the gate's action is stopWorkflow or
      // skipPrompt and no PTY is ever created. Interactive focus therefore
      // belongs to whoever knows a terminal exists: TERMINAL_STARTED (see
      // terminalMessageHandlers, which covers script PTYs too) for a fresh
      // spawn, and the inject branch below for a reused one.
      if (message.executionMode === EXECUTION_MODES.HEADLESS) {
        autoFocusOutputOnExecution(wfId, "output");
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
          // No TERMINAL_STARTED follows a reused PTY, and this terminal is
          // already populated, so this is the one place at execution start that
          // can legitimately focus it.
          autoFocusOutputOnExecution(wfId, "terminal");
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
    applyExecutionState(message.state as ExecutionState);
    if (message.activeStepIndices !== undefined) {
      useWorkflowStore
        .getState()
        .setActiveStepIndices(message.activeStepIndices);
    }
  };

  handlers[MESSAGE_TYPES.ACTIVE_STEP_INDICES_CHANGED] = (message) => {
    if (message.workflowId) {
      const activeWorkflowId = useUiStore.getState().activeWorkflowId;
      if (message.workflowId !== activeWorkflowId) {
        return;
      }
    }
    useWorkflowStore.getState().setActiveStepIndices(message.activeStepIndices);
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
    if (message.activeStepIndices !== undefined) {
      workflowStore.setActiveStepIndices(message.activeStepIndices);
    }
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
    if (message.activeStepIndices !== undefined) {
      workflowStore.setActiveStepIndices(message.activeStepIndices);
    }

    if (workflowStore.steps[stepIndex]) {
      // Pause around updatePrompt — step status changes are runtime events,
      // not user actions. Without this, every running/completed/failed status
      // transition during a workflow run would pollute the undo stack.
      useWorkflowStore.temporal.getState().pause();
      workflowStore.updatePrompt(stepIndex, {
        status: status.state || status,
        ...(details !== undefined
          ? {
              _runtime: {
                ...workflowStore.steps[stepIndex]._runtime,
                ...details,
              },
            }
          : {}),
      });
      useWorkflowStore.temporal.getState().resume();
    }

    // Do not clear live context on terminal status alone. Step handoff can
    // advance currentStep before the durable CLI token payload arrives, and
    // clearing here makes the just-finished row lose its context bar. Live
    // telemetry is cleared once CLI output persists token metadata.
    const terminalStatuses = [
      STEP_STATUS.COMPLETED,
      STEP_STATUS.FAILED,
      STEP_STATUS.CANCELLED,
    ];
    const resolvedStatus = status?.state || status;
    if (terminalStatuses.includes(resolvedStatus)) {
      return;
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
    applyExecutionState(EXECUTION_STATES.COMPLETED);
  };

  handlers[MESSAGE_TYPES.NOTIFICATION_EVENT] = (message) => {
    if (!isCompletionNotificationEvent(message?.event)) {
      return;
    }

    if (standalone) {
      useUiStore
        .getState()
        .showToast(
          message.event.body,
          getNotificationSeverityColor(message.event.severity),
          { dedupeKey: `notification:${message.event.id}` }
        );
    }

    void handleCompletionNotificationEvent(
      message.event,
      useSettingsStore.getState().fullGlobalSettings
    );
  };

  handlers[MESSAGE_TYPES.USER_FEEDBACK] = (message) => {
    if (!isUserFeedbackMessage(message)) {
      return;
    }

    useUiStore.getState().enqueueToast({
      id: message.id,
      message: message.message,
      severity: message.severity,
      detail: message.detail,
      dedupeKey: message.dedupeKey,
    });
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
    const phase = getExecutionPhaseForScriptOutputSource(message.output.source);
    if (!message.output.isStreaming) {
      store.clearFinalStepStreamingChunk(
        message.loopIndex,
        phase,
        message.output.runIndex ?? 0,
        message.output.attemptIndex ?? 0
      );
    }
    const entry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: message.loopIndex,
      },
      runIndex: message.output.runIndex ?? 0,
      attemptIndex: message.output.attemptIndex ?? 0,
      phase,
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
      .appendFinalStepStreamingChunk(
        message.loopIndex,
        message.chunk || "",
        message.phase,
        message.runIndex ?? 0,
        message.attemptIndex ?? 0,
        message.timestampMs,
        message.sequence
      );
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
        message.runIndex ?? 0,
        message.phase,
        message.timestampMs,
        message.sequence
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
    const phase = getExecutionPhaseForScriptOutputSource(message.output.source);
    if (!message.output.isStreaming) {
      store.clearStreamingChunk(
        message.stepIndex,
        phase,
        message.output.runIndex ?? 0,
        message.output.attemptIndex ?? 0
      );
    }
    const entry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: message.stepIndex },
      runIndex: message.output.runIndex ?? 0,
      attemptIndex: message.output.attemptIndex ?? 0,
      phase,
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

    if (message.output.tokens?.contextWindowSize) {
      store.clearLiveContextWindow(message.stepIndex);
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
    workflowStore.appendStreamingChunk(
      message.stepIndex,
      message.chunk || "",
      message.phase,
      message.runIndex ?? 0,
      message.attemptIndex ?? 0,
      message.timestampMs,
      message.sequence
    );
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
      message.runIndex ?? 0,
      message.phase,
      message.timestampMs,
      message.sequence
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
    const workflowStore = useWorkflowStore.getState();
    const step = workflowStore.steps[message.stepIndex];
    const stepStatus = step ? (step as { status?: StepStatus }).status : null;

    // Context updates are live telemetry for the currently executing step.
    // A late update from a just-finished prompt must not overwrite the completed
    // CLI output token metadata, which is the durable source used by history.
    if (
      !isWorkflowRunning(workflowStore.executionState) ||
      isTerminalStepStatus(stepStatus)
    ) {
      return;
    }

    workflowStore.updateLiveContextWindow(
      message.stepIndex,
      message.used,
      message.size
    );
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

    if (message.output.tokens?.contextWindowSize) {
      store.clearLiveContextWindow(message.stepIndex);
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
    // Prefer the extension-clock origination timestamp over a webview-side
    // Date.now(): the two clocks aren't the same domain (worse yet over a
    // hosted-browser WebSocket), and rows are sorted by timestamp, so
    // stamping on receipt raced this status row against the CLI/script row
    // it's meant to precede or follow.
    const resolvedTimestampMs = message.timestampMs ?? Date.now();
    const entry: OrderedStatusHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target,
      statusMessage: {
        message: message.message,
        severity: message.severity ?? "info",
        timestamp: resolvedTimestampMs,
      },
      timestampMs: resolvedTimestampMs,
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

  // WORKFLOW_VARIANT_CREATED - create and navigate only the requesting client
  handlers[MESSAGE_TYPES.WORKFLOW_VARIANT_CREATED] = (message) => {
    const uiStore = useUiStore.getState();
    const pending = uiStore.duplicateWorkflowRequest;
    const dialog = uiStore.duplicateWorkflowDialogData;
    if (!pending || !dialog || pending.requestId !== message.requestId) {
      return;
    }

    const vscode = getVsCodeApi();
    uiStore.closeDuplicateWorkflowDialog();
    vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
    navigateToWorkflowAddress(vscode, message.address, pending.workflowName);
    const toastMessage = `Created workflow "${pending.workflowName}"`;
    if (!standalone) {
      notifyUser(toastMessage, USER_FEEDBACK_SEVERITY.SUCCESS);
      return;
    }
    // Standalone-only: an action's onClick closure cannot cross the postMessage
    // boundary to the extension host, so the panel took the notifyUser() path above.
    uiStore.showToast(toastMessage, USER_FEEDBACK_SEVERITY.SUCCESS, {
      action: {
        label: "Open in New Tab",
        onClick: () => openWorkflowAddressInNewTab(message.address),
      },
    });
  };

  // WORKFLOW_VARIANT_FAILED - keep the dialog and its typed name open
  handlers[MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED] = (message) => {
    const uiStore = useUiStore.getState();
    if (uiStore.duplicateWorkflowRequest?.requestId !== message.requestId) {
      return;
    }
    uiStore.retireDuplicateWorkflowRequest(message.error);
  };

  // --------------------------------------------------------------------------
  // OPEN_NEW_WORKFLOW_MODAL - Open modal to create new workflow
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.openNewWorkflowModal({
      templates: message.templates || [],
      defaultTemplateId: message.defaultTemplateId,
      openCreateTemplateForm: message.openCreateTemplateForm,
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
  // CUSTOM_TEMPLATE_CREATED - Result of creating a template from the webview form
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CUSTOM_TEMPLATE_CREATED] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setCustomTemplateCreated({
      templates: message.templates || [],
      templateId: message.templateId,
      error: message.error,
    });
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
  // SAVE_LOCATION_SELECTED - OS folder picker result for Save As location
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SAVE_LOCATION_SELECTED] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.setSaveLocationSelection({ path: message.path });
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

  handlers[MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT] = (message) => {
    const snapshot = message.data?.snapshot;
    if (snapshot) {
      useCompatibilityStore.getState().setCapabilitySnapshot(snapshot);
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
  // MCP_REGISTRY_SERVERS_UPDATE - Managed MCP registry list for the manager UI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_REGISTRY_SERVERS_UPDATE] = (message) => {
    useMcpManagerStore.getState().setManagedServers(message.servers ?? []);
  };

  // --------------------------------------------------------------------------
  // SECRET_REGISTRY_UPDATE - Safe secret names and metadata only
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SECRET_REGISTRY_UPDATE] = (message) => {
    useSecretRegistryStore
      .getState()
      .setEntries(message.scope, message.secrets ?? []);
  };

  // Write confirmations intentionally carry no value and are not merged into
  // the registry until the next explicit list request.
  handlers[MESSAGE_TYPES.SECRET_SET] = (message) => {
    useSecretRegistryStore.getState().setLastAction(message);
  };

  handlers[MESSAGE_TYPES.SECRET_DELETED] = (message) => {
    useSecretRegistryStore.getState().setLastAction(message);
  };

  // --------------------------------------------------------------------------
  // SHOW_BATCH_APPROVAL_REQUEST - UserInteractionPort batch-approval prompt
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SHOW_BATCH_APPROVAL_REQUEST] = (message) => {
    if (message.request) {
      useBatchApprovalStore.getState().setPendingRequest(message.request);
    }
  };

  // SHOW_CHOICE_REQUEST - UserInteractionPort single-choice prompt
  handlers[MESSAGE_TYPES.SHOW_CHOICE_REQUEST] = (message) => {
    if (message.request) {
      useChoiceStore.getState().setPendingRequest(message.request);
    }
  };

  handlers[MESSAGE_TYPES.WORKFLOW_EXTERNAL_ROOTS_APPROVAL_REQUIRED] = (
    message
  ) => {
    const activeWorkflowId = useUiStore.getState().activeWorkflowId;
    if (message.workflowId === activeWorkflowId) {
      useSettingsStore
        .getState()
        .setWorkflowExternalRootsApprovalRequired(
          message.pendingRoots.length > 0
        );
    }
  };

  // --------------------------------------------------------------------------
  // MCP_LOCAL_SCAN_RESULT - Local MCP scan results for the manager UI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_LOCAL_SCAN_RESULT] = (message) => {
    useMcpManagerStore
      .getState()
      .setLocalScanResult(message.servers ?? [], message.error);
  };

  // --------------------------------------------------------------------------
  // MCP_REGISTRY_SEARCH_RESULT - Registry search results for the manager UI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_REGISTRY_SEARCH_RESULT] = (message) => {
    useMcpManagerStore
      .getState()
      .setRemoteSearchResult(
        message.servers ?? [],
        message.error,
        message.nextCursor
      );
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
      notifyUser(
        message.error ?? "Unable to open folder",
        USER_FEEDBACK_SEVERITY.WARNING
      );
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
    // Deliberately does NOT lift the startup overlay. WORKFLOW_LOADED means "a
    // working file was read and its properties are on screen" — it says nothing
    // about whether the extension has finished starting. On a cold start the panel
    // READY path emits it right after handleClientReady hydrates the persisted
    // view, which on a slow workspace is many seconds before initialize()
    // completes and the deferred auto-load runs. Lifting here handed the user an
    // interactive dashboard during that window, and a workflow they created or
    // switched to in it got overwritten by the arriving auto-load. STARTUP_COMPLETE
    // is the only signal that startup settled, with StartupOverlay's safety
    // timeout as the backstop if it never arrives.
  };

  // --------------------------------------------------------------------------
  // STARTUP_COMPLETE - Extension startup sequence finished (with or without session)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STARTUP_COMPLETE] = () => {
    const { fileName } = useWorkflowStore.getState();
    const { activeWorkflowWorkingFilePath, startupReady } =
      useUiStore.getState();
    WebviewLog.info(
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
  // WORKSPACE_INIT_REQUIRED - ctrlyoke not yet initialized; user must approve
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKSPACE_INIT_REQUIRED] = () => {
    WebviewLog.info("[startup] WORKSPACE_INIT_REQUIRED received");
    useUiStore.getState().setWorkspaceInitRequired(true);
  };

  // --------------------------------------------------------------------------
  // SHOW_LAYOUT_TIP - first-install step 2: panel placement tip
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SHOW_LAYOUT_TIP] = () => {
    WebviewLog.info("[startup] SHOW_LAYOUT_TIP received");
    const store = useUiStore.getState();
    store.setWorkspaceInitRequired(false);
    store.setShowLayoutPreference(true);
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
    // No addressed lineage remains after unload. Clear metadata owned by the
    // previously viewed run so a later workflow cannot inherit its lockdown.
    useUiStore.setState({ viewedLineageIsSystemGenerated: false });
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
  // PASTED_IMAGE_SAVED - Handled by CodeMirrorEditor.tsx
  // --------------------------------------------------------------------------
  // The editor listens for the save result directly so it can reconcile the
  // per-paste placeholder by seq. No-op here so the router doesn't misclassify
  // this valid extension message as unknown.
  handlers[MESSAGE_TYPES.PASTED_IMAGE_SAVED] = () => {};

  // --------------------------------------------------------------------------
  // FILE_PREVIEW_URI_RESPONSE - Handled by ImageRefThumbnail (MarkdownText.tsx)
  // --------------------------------------------------------------------------
  // The thumbnail component listens directly to resolve its per-request URI
  // promise by seq. No-op here for the same reason as above.
  handlers[MESSAGE_TYPES.FILE_PREVIEW_URI_RESPONSE] = () => {};

  // --------------------------------------------------------------------------
  // PRIOR_CONTEXT_PREVIEW_RESULT
  // --------------------------------------------------------------------------
  // GIT_CHANGE_PREVIEW_RESULT removed — browser now uses openToGitRef() →
  // WorkspaceDiffPane; VS Code uses OPEN_GIT_CHANGE → native diff commands.

  handlers[MESSAGE_TYPES.PRIOR_CONTEXT_PREVIEW_RESULT] = (message) => {
    const ref = message.ref as string;
    useUiStore.getState().setContentPreviewModal({
      title: `$${ref} — Prior Context`,
      content: message.content as string,
      language: "xml",
      ref,
    });
  };

  // --------------------------------------------------------------------------
  // MCP_CONFIG_PREVIEW_RESULT
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT] = (message) => {
    const mcpServerName = message.mcpServerName as string;
    if (!message.found) {
      notifyUser(
        `Can't preview — no MCP server named "${mcpServerName}" was found in the ctrlyoke registry`,
        USER_FEEDBACK_SEVERITY.WARNING
      );
      return;
    }
    useUiStore.getState().setContentPreviewModal({
      title: `mcp: ${mcpServerName}`,
      content: message.content as string,
      language: "json",
      ref: mcpServerName,
    });
  };

  // --------------------------------------------------------------------------
  // ATTACHMENT_TOKEN_COUNTS_RESPONSE - Handled by useAttachmentTokenCount.ts
  // --------------------------------------------------------------------------
  // This message is consumed by a module-level window listener in
  // useAttachmentTokenCount.ts (singleton pattern for cross-mount caching).
  // Register a no-op here so the central router doesn't log "Unknown message type".
  handlers[MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE] = () => {};

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
    const { history, availableRuns, currentRunIndex } = message;
    if (!history || availableRuns === 0) {
      // History was cleared — reset to live view
      useWorkflowStore.getState().clearHistoryOutputs();
      useUiStore.getState().clearHistoryView();
    } else {
      const workflowStore = useWorkflowStore.getState();
      const uiStore = useUiStore.getState();
      // A run at index 0 is "live" only when both the webview and the history
      // manifest agree it is still active. If the manifest was already
      // finalised as "completed" (which happens before replayOutputHistoryTo
      // reads it) but SESSION_RESTORED hasn't been processed yet, trusting
      // only the webview state would silently drop the history — causing the
      // last step to vanish until the user navigates away and back.
      const isLiveCurrentRun =
        currentRunIndex === 0 &&
        isWorkflowActive(workflowStore.executionState) &&
        isWorkflowActive(history.executionState);

      if (isLiveCurrentRun) {
        // Workflow replay may send the newest run's history after SESSION_RESTORED.
        // Seed the complete persisted timeline into live output, preserving any
        // buffered events that were replayed between those two messages.
        workflowStore.hydrateLiveRunHistory(history);
        uiStore.clearHistoryView();
        return;
      }

      WebviewLog.debug(
        `[MessageHandler] OUTPUT_HISTORY_LOADED: availableRuns=${availableRuns}, currentRunIndex=${currentRunIndex}`
      );
      workflowStore.loadHistoryRun(history);
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_VIEW_IDENTITY - authoritative address/revisions after a write
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY] = (message) => {
    const {
      address,
      runDirectory,
      definitionRevision,
      descriptorRevision,
      isSystemGenerated,
    } = message;
    if (!address) return;
    if (typeof definitionRevision === "number") {
      useExecutionPreviewStore
        .getState()
        .observeDefinitionRevision(address, definitionRevision);
    }
    const ui = useUiStore.getState();
    // A run view switch that is still in flight owns the address, so identity
    // for a *different* address would re-point the client at the run it is
    // navigating away from. Identity for the address being switched to is the
    // answer to that switch, not a straggler — and gating on the address rather
    // than on "any request pending" is what keeps a lost or rejected run-view
    // response from suppressing every later revision update.
    if (
      ui.pendingRunViewRequestId !== null &&
      ui.displayedViewAddress !== null &&
      !areWorkflowAddressesEqual(address, ui.displayedViewAddress)
    ) {
      return;
    }
    ui.setDisplayedViewIdentity(
      address,
      definitionRevision ?? 1,
      descriptorRevision ?? 1,
      runDirectory,
      isSystemGenerated
    );
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_ACTION_FAILED - addressed view/mutation/run action was rejected
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_ACTION_FAILED] = (message) => {
    const uiStore = useUiStore.getState();
    // Retire the request this failure answers; otherwise the client keeps
    // waiting for a snapshot that will never arrive. Roll back rather than
    // merely retire: the request already moved the displayed address
    // optimistically, so dropping it alone would leave the header naming the
    // workflow that failed to load while the panels still render the previous
    // one. A rejected navigation has to end on the view the client is actually
    // showing — the toast below is what tells the user it did not happen.
    if (
      message.requestId &&
      uiStore.pendingRunViewRequestId === message.requestId
    ) {
      uiStore.rollbackRunViewLoad();
    }
    notifyUser(
      `Failed to ${message.action}: ${message.error}`,
      USER_FEEDBACK_SEVERITY.ERROR
    );
    if (message.requestId) {
      useRunSummaryCacheStore
        .getState()
        .resolveRunSummariesError(message.requestId, message.error);
    }
  };

  // --------------------------------------------------------------------------
  // SUFFIX_EDIT_CONFIRMATION_REQUIRED - discardContinuation/startNewRunInstead
  // hit unsaved rewound-suffix edits; show our own modal (never a native
  // OS/VS Code dialog) so hosted browser clients can see and act on it too.
  // Mirrors the delete/reset "don't ask me again" settings: when the user has
  // turned the confirmation off, resend the same action with
  // confirmEditedSuffix: true instead of ever surfacing the modal.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED] = (message) => {
    if (
      !useSettingsStore.getState().globalSettings
        .confirmContinuationDiscardOperations
    ) {
      sendMessage(
        message.action === MESSAGE_TYPES.START_NEW_RUN_INSTEAD
          ? MESSAGE_TYPES.START_NEW_RUN_INSTEAD
          : MESSAGE_TYPES.DISCARD_CONTINUATION,
        {
          address: message.address,
          expectedDefinitionRevision: message.expectedDefinitionRevision,
          expectedDescriptorRevision: message.expectedDescriptorRevision,
          confirmEditedSuffix: true,
        }
      );
      return;
    }
    useUiStore.getState().setSuffixEditConfirmation({
      action: message.action,
      address: message.address,
      expectedDefinitionRevision: message.expectedDefinitionRevision,
      expectedDescriptorRevision: message.expectedDescriptorRevision,
    });
  };

  // --------------------------------------------------------------------------
  // RUN_SUMMARIES_LOADED - manifest-only run listing for one lineage's
  // run-panel drill-in (never switches the client's own displayed view)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RUN_SUMMARIES_LOADED] = (message) => {
    useRunSummaryCacheStore.getState().resolveRunSummaries(message);
  };

  handlers[MESSAGE_TYPES.WORKTREE_MERGE_RESULT] = (message) => {
    if (!message.address || !message.worktree) return;
    const uiStore = useUiStore.getState();
    if (
      !areWorkflowAddressesEqual(message.address, uiStore.appliedViewAddress)
    ) {
      return;
    }
    useUiStore
      .getState()
      .updateRunSummaryWorktree(message.address.runRef, message.worktree);
    useWorkflowStore.getState().updateHistoryWorktree(message.worktree);
  };

  // EXECUTION_PREVIEW_RESULT - one request-correlated, redacted snapshot
  handlers[MESSAGE_TYPES.EXECUTION_PREVIEW_RESULT] = (message) => {
    useExecutionPreviewStore.getState().resolve(message);
  };

  // --------------------------------------------------------------------------
  // RUN_VIEW_LOADED - one addressed definition/settings/output snapshot
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RUN_VIEW_LOADED] = (message) => {
    const {
      address,
      workingFile,
      history,
      runSummaries,
      workflowProperties,
      executionRunRef,
      pendingRewind,
    } = message;
    if (!address || !workingFile) return;
    const incomingDefinitionRevision = workingFile.definitionRevision ?? 1;
    useExecutionPreviewStore
      .getState()
      .observeDefinitionRevision(address, incomingDefinitionRevision);
    // A late response from a previous selector click must not overwrite the
    // most recently requested address.
    const uiStore = useUiStore.getState();
    // Client-initiated run switches carry a request ID, so only the latest
    // requested snapshot may update the optimistic view. Replays caused by a
    // newly loaded workflow have no request ID and must replace the prior
    // workflow's address instead of being mistaken for stale selector output.
    if (
      (uiStore.pendingRunViewRequestId !== null &&
        message.requestId !== uiStore.pendingRunViewRequestId) ||
      (uiStore.pendingRunViewRequestId === null && message.requestId)
    ) {
      return;
    }
    // Requestless snapshots are also produced by replay/invalidation paths. A
    // snapshot can start reading a run before an append, then finish loading its
    // timeline after STEPS_EXTENDED has already advanced the same run in the
    // client. Request IDs cannot order those internal snapshots, so preserve the
    // per-address monotonic definition head here. Equal revisions must not shrink
    // the step list either: live queue growth reaches the client before the
    // follow-up WORKFLOW_VIEW_IDENTITY is published when execution completes.
    // Compared against the address whose *content* is actually loaded into
    // workflowStore, not the optimistic navigation target. An identity-only
    // publish (WORKFLOW_VIEW_IDENTITY) can advance displayedViewAddress/
    // displayedDefinitionRevision to a new workflow without ever applying its
    // snapshot — comparing against displayedViewAddress here would then treat
    // the *previous* workflow's still-resident content as "the current
    // address" and permanently reject the real snapshot as regressive.
    const isCurrentAddress = areWorkflowAddressesEqual(
      address,
      uiStore.appliedViewAddress
    );
    // The *applied* revision, not the displayed one: a WORKFLOW_VIEW_IDENTITY
    // published ahead of this snapshot (every run-addressed write does that, so
    // the client can act on the write immediately) has already advanced the
    // displayed value to exactly what this snapshot carries, and comparing
    // against it would classify the snapshot as a content-free replay — or, for
    // a write that removed a step, discard it as regressive.
    const currentDefinitionRevision = uiStore.appliedDefinitionRevision;
    const currentDescriptorRevision = uiStore.displayedDescriptorRevision;
    const currentStepCount = useWorkflowStore.getState().steps.length;
    const incomingStepCount = workingFile.steps?.length ?? 0;
    const isAuthorizedDefinitionRollback =
      currentDefinitionRevision !== null &&
      message.definitionRollback?.fromRevision === currentDefinitionRevision &&
      incomingDefinitionRevision < currentDefinitionRevision &&
      (currentDescriptorRevision === null ||
        message.descriptorRevision >= currentDescriptorRevision);
    if (
      !message.requestId &&
      isCurrentAddress &&
      isRegressiveDefinitionSnapshot(
        incomingDefinitionRevision,
        currentDefinitionRevision,
        incomingStepCount,
        currentStepCount
      ) &&
      !isAuthorizedDefinitionRollback
    ) {
      WebviewLog.debug(
        `[RUN_VIEW_LOADED] ignoring regressive snapshot for ${address.workflowKey}: ` +
          `revision ${incomingDefinitionRevision}/${currentDefinitionRevision}, ` +
          `steps ${incomingStepCount}/${currentStepCount}`
      );
      // The definition portion is stale, but the snapshot's descriptorRevision
      // is monotonic lineage state that may still be newer than what the client
      // holds (a rewind bumps the descriptor even when the definition read
      // raced the write). Adopting it here is what keeps Discard/Continue from
      // being rejected with a superseded descriptor revision after the full
      // snapshot was dropped.
      if (typeof message.descriptorRevision === "number") {
        uiStore.adoptDescriptorRevision(address, message.descriptorRevision);
      }
      return;
    }
    const openSaveDialog = useUiStore.getState().saveWorkflowDialogData;
    if (
      openSaveDialog &&
      (openSaveDialog.address.workflowKey !== address.workflowKey ||
        openSaveDialog.address.kind !== address.kind ||
        (openSaveDialog.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
          address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
          openSaveDialog.address.runRef !== address.runRef))
    ) {
      // A dialog is a snapshot action. Never let it survive an addressed view
      // switch and accidentally apply a late path check/save response to N+1.
      useUiStore.getState().closeSaveWorkflowDialog();
    }
    // A same-view replay (same address, same definition revision, not a
    // rollback) re-describes the workflow the store already holds — e.g. a
    // run-view invalidation or reconnect. Preserve live output, runtime state,
    // and undo history so unchanged rows keep their identities and nothing in
    // the output pane redraws. Anything else is a genuine view change and
    // clears runtime state as before.
    const isSameViewReplay =
      isCurrentAddress &&
      currentDefinitionRevision !== null &&
      incomingDefinitionRevision === currentDefinitionRevision &&
      !message.definitionRollback;
    // The selected address was set optimistically before this asynchronous
    // snapshot arrived. Clearing it here briefly records an addressless route,
    // which makes Back/Forward require several clicks to cross one run switch.
    // Keep the address stable while resetting the remaining workflow-local UI.
    applyWorkflowChange({
      preserveViewAddress: true,
      // history (when present) is immediately re-applied below — replaced by
      // loadHistoryRun or nulled by hydrateLiveRunHistory — so pre-clearing
      // would only break structural sharing for identical replays.
      skipHistoryOutputsClear: Boolean(history),
    });
    const runtime = workingFile._runtime;
    // The addressed run view sends the run's own definition file, where each
    // step's completion status lives in its own _runtime.terminalStatus
    // rather than in a separate results array (unlike the live-queue-backed
    // FILE_SELECTED/SESSION_RESTORED messages). Derive results from that
    // per-step runtime so completed/failed/cancelled/skipped chips still
    // render their status border after loading a run view.
    const currentIndex = runtime?.currentIndex ?? 0;
    const results = (workingFile.steps ?? []).map(
      (step: any, index: number) => {
        const stepRuntime = step._runtime;
        if (stepRuntime?.completedAt !== undefined) {
          return {
            status: stepRuntime.terminalStatus ?? STEP_STATUS.COMPLETED,
          };
        }
        if (
          index === currentIndex &&
          runtime?.executionState === EXECUTION_STATES.RUNNING
        ) {
          return { status: STEP_STATUS.SENT };
        }
        return { status: STEP_STATUS.PENDING };
      }
    );
    // Guard against a requestless snapshot regressing a genuinely live
    // execution state. `readAddressedRunView` reads the run's working file
    // straight off disk, and a snapshot for the same address can be built
    // from a moment before the executor persisted RUNNING (the comment on
    // `publishRunViewToClients` documents this exact disk-read race for
    // draft->run promotion) — landing after EXECUTION_STARTED/
    // EXECUTION_STATE_CHANGED already set the live state and silently
    // reverting the header's badge back to idle. A message carrying a
    // requestId is a client-initiated request and is always trusted as-is.
    //
    // Deliberately NOT gated on isCurrentAddress or a same-lineage
    // (workflowKey) match against `appliedViewAddress`: that address is only
    // ever set by this same handler (`ui.markViewAddressApplied` below), so a
    // lineage's very first-ever RUN_VIEW_LOADED — e.g. a brand-new workflow
    // whose draft never got its own applied view before "Run" promoted it —
    // has no prior appliedViewAddress to match against, and the guard would
    // silently never engage for exactly the promotion race it exists to
    // catch. The backend only ever pushes a requestless RUN_VIEW_LOADED to
    // the client that owns the executing instance in the first place
    // (`readAddressedRunView`/`deliverRunView` target a specific client), so
    // by the time one reaches here it is already known to be for this
    // client's own workflow — no extra address check is needed to trust it.
    //
    // It IS gated on the snapshot describing the run the backend is still
    // executing, which `executionRunRef` reports in this very message from
    // live in-memory registry state (never from disk, so it cannot lose the
    // same race). Only such a snapshot can be a stale read of an execution
    // that is still under way. Without that gate the guard also swallowed a
    // *genuine* completion: a mobile PWA resumed after the workflow finished
    // reconnects holding a live-looking RUNNING state it never saw retired,
    // and the reconnect snapshot — requestless, and correctly reporting
    // COMPLETED — was rejected as stale. That left the client permanently
    // "running" with no live output, which `OutputSection` then reads as a
    // live run and wipes the just-loaded history for, blanking the output
    // pane until the user switched workflows and back.
    const currentExecutionState = useWorkflowStore.getState().executionState;
    const snapshotDescribesLiveExecution =
      executionRunRef !== undefined &&
      (address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
        address.runRef === executionRunRef);
    const isStaleExecutionStateRegression =
      !message.requestId &&
      snapshotDescribesLiveExecution &&
      isWorkflowActive(currentExecutionState) &&
      !isWorkflowActive(runtime?.executionState ?? EXECUTION_STATES.IDLE);
    const resolvedExecutionState = isStaleExecutionStateRegression
      ? currentExecutionState
      : runtime?.executionState;
    if (isStaleExecutionStateRegression) {
      WebviewLog.debug(
        `[RUN_VIEW_LOADED] ignoring stale executionState=${runtime?.executionState ?? "(none)"} ` +
          `for ${address.workflowKey}: keeping live state=${currentExecutionState}`
      );
    }
    useWorkflowStore.getState().loadWorkflow({
      fileName: workingFile.workflowName,
      workflowName: workingFile.workflowName,
      steps: workingFile.steps ?? [],
      parallelGroups: workingFile.parallelGroups ?? [],
      executionState: resolvedExecutionState,
      currentStep: runtime?.currentIndex,
      results,
      finalStep: workingFile.finalStep ?? null,
      finalStepStatus: runtime?.finalStep?.status ?? null,
      finalStepLoopCount: runtime?.finalStep?.loopCount ?? 0,
      finalStepPhase: runtime?.finalStep?.phase ?? null,
      preserveLiveOutput: isSameViewReplay,
    });
    const normalized = normalizeWorkflowProperties(workflowProperties);
    useSettingsStore.getState().setWorkflowProperties(normalized);
    useWorkflowStore.getState().syncIncomingWorkflowProperties(normalized);
    const ui = useUiStore.getState();
    // workflowStore now genuinely holds this address's content — record it
    // separately from the optimistic displayedViewAddress below so a later
    // requestless snapshot's stale-check has an honest baseline.
    ui.markViewAddressApplied(address, incomingDefinitionRevision);
    ui.setDisplayedRunView(
      address,
      runSummaries,
      executionRunRef,
      {
        definitionRevision: workingFile.definitionRevision ?? 1,
        descriptorRevision: message.descriptorRevision,
      },
      pendingRewind ?? runtime?.pendingRewind,
      message.runDirectory,
      message.isSystemGenerated
    );
    ui.clearPendingRunViewLoad();
    // A rewind starts a new, suffix-only editing epoch. Re-baselining here
    // prevents zundo from crossing into the full-runtime pre-rewind state.
    if (pendingRewind ?? runtime?.pendingRewind) {
      useWorkflowStore.temporal.getState().clear();
    }
    if (history) {
      const isExecutionRun =
        address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        executionRunRef !== undefined &&
        address.runRef === executionRunRef;
      if (isExecutionRun) {
        // An executing run is a live view, but its persisted timeline is still
        // the authoritative baseline. Hydrate that complete history before the
        // backend overlays output captured after the snapshot read.
        useWorkflowStore.getState().hydrateLiveRunHistory(history);
        ui.clearHistoryView();
      } else {
        useWorkflowStore.getState().loadHistoryRun(history);
      }
    }
    const pendingNavigation = ui.pendingHistorySearchNavigation;
    if (pendingNavigation?.findQuery) {
      const filterWorkflowKey = workflowViewAddressKey(address);
      const targetKey = getTargetKey(
        toOutputMessageTarget(pendingNavigation.target)
      );
      if (ui.hiddenOutputTargets[filterWorkflowKey]?.keys.includes(targetKey)) {
        // History search is explicit navigation intent. Restore the target
        // before arming find so the preferred match is present in the rows.
        ui.toggleHiddenOutputTarget(filterWorkflowKey, targetKey);
      }
      ui.setPendingFindRequest({
        query: pendingNavigation.findQuery,
        preferredTarget: pendingNavigation.target,
      });
      ui.setPendingHistorySearchNavigation(null);
    }
  };

  // --------------------------------------------------------------------------
  // SEARCH_HISTORY_RESULTS - Global history search matches
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SEARCH_HISTORY_RESULTS] = (message) => {
    const { results, query, offset, totalCount, indexState } = message as {
      results: HistorySearchResult[];
      query: string;
      offset?: number;
      totalCount?: number;
      indexState?: "ready" | "building" | "fallback";
    };
    const uiStore = useUiStore.getState();
    if (uiStore.historySearchQuery !== query) {
      return;
    }
    uiStore.setHistorySearchResults(results, false, {
      // Offset 0 is the first page of a new listing and replaces it; any
      // later offset merges into the sparse listing already on screen.
      offset: offset ? offset : undefined,
      totalCount,
      indexState,
    });
  };

  // --------------------------------------------------------------------------
  // SEARCH_INDEX_REBUILD_PROGRESS - Pushed while a search is blocked on a
  // full, synchronous index rebuild (see HistorySearchIndexService.rebuild)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SEARCH_INDEX_REBUILD_PROGRESS] = (message) => {
    const { processedRuns, totalRuns } = message as {
      processedRuns: number;
      totalRuns: number;
    };
    useUiStore
      .getState()
      .setHistorySearchRebuildProgress({ processedRuns, totalRuns });
  };

  // --------------------------------------------------------------------------
  // OPEN_HISTORY_SEARCH - Open global history search drawer
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.OPEN_HISTORY_SEARCH] = () => {
    useUiStore.getState().openHistorySearch();
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

    applyExecutionState(EXECUTION_STATES.STOPPED);
  };

  // --------------------------------------------------------------------------
  // SAVE_WORKFLOW_DIALOG_DATA - Extension responded with defaults; open dialog
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA] = (message) => {
    const uiStore = useUiStore.getState();
    const displayed = uiStore.displayedViewAddress;
    if (
      !displayed ||
      displayed.workflowKey !== message.address.workflowKey ||
      displayed.kind !== message.address.kind ||
      (displayed.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        message.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        displayed.runRef !== message.address.runRef)
    ) {
      return;
    }
    uiStore.openSaveWorkflowDialog({
      requestId: message.requestId,
      address: message.address,
      title: message.title,
      subtitle: message.subtitle,
      defaultPath: message.defaultPath,
      defaultFormat: message.defaultFormat,
    });
  };

  // --------------------------------------------------------------------------
  // SAVE_PATH_CHECKED - consume only the dialog's latest path request.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SAVE_PATH_CHECKED] = (message) => {
    useUiStore.getState().resolveSavePathCheck({
      requestId: message.requestId,
      path: message.path,
      address: message.address,
      exists: message.exists,
      bundlePreview: message.bundlePreview,
      planChanged: message.planChanged,
      error: message.error,
    });
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_SAVED - File was written successfully; close dialog + toast
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_SAVED] = (message) => {
    const uiStore = useUiStore.getState();
    if (uiStore.saveWorkflowDialogData?.requestId !== message.requestId) {
      return;
    }
    uiStore.closeSaveWorkflowDialog();
    // Extract filename for a concise toast
    const fileName = message.filePath.split(/[/\\]/).pop() ?? message.filePath;
    notifyUser(`Saved as ${fileName}`, USER_FEEDBACK_SEVERITY.SUCCESS);
    for (const warning of message.warnings ?? []) {
      notifyUser(warning, USER_FEEDBACK_SEVERITY.WARNING);
    }
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_SAVE_FAILED - Save failed; close dialog and show error toast
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_SAVE_FAILED] = (message) => {
    const uiStore = useUiStore.getState();
    if (
      message.requestId &&
      uiStore.saveWorkflowDialogData?.requestId !== message.requestId
    ) {
      return;
    }
    if (message.requestId) {
      uiStore.closeSaveWorkflowDialog();
    }
    notifyUser(`Save failed: ${message.error}`, USER_FEEDBACK_SEVERITY.ERROR);
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_SAVED_AS_TEMPLATE - "Save as Template" succeeded; close dialog,
  // refresh the template list so a subsequently opened TemplateModal already
  // shows it, and toast.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_SAVED_AS_TEMPLATE] = (message) => {
    const uiStore = useUiStore.getState();
    if (uiStore.saveWorkflowDialogData?.requestId !== message.requestId) {
      return;
    }
    uiStore.closeSaveWorkflowDialog();
    uiStore.setTemplates(message.templates || []);
    notifyUser("Saved as template", USER_FEEDBACK_SEVERITY.SUCCESS);
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
    WebviewLog.info(
      `[WORKFLOW_ADDED] inst:${summary?.id.slice(0, 8)} name="${summary?.workflowName || "(empty)"}" state=${summary?.executionState} ` +
        `fp=${summary?.filePath?.split(/[\\/]/).pop() || "?"} wfp=${summary?.workingFilePath?.split(/[\\/]/).pop() || "?"} ` +
        `— current loadedWorkflows: [${uiStore.loadedWorkflows.map((w) => `inst:${w.id.slice(0, 8)}(name="${w.workflowName || "(empty)"}", state=${w.executionState})`).join(", ") || "(none)"}]`
    );
    if (summary && isWorkflowActive(summary.executionState)) {
      uiStore.addLoadedWorkflow(summary);
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
    WebviewLog.info(
      `[WORKFLOW_DISMISSED] inst:${message.workflowId?.slice(0, 8)} ` +
        `(loadedWorkflows has no matching summary yet; reported name="${dismissed?.workflowName || "(not available)"}" state=${dismissed?.executionState || "?"}) ` +
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
    } else if (isExecutionFinished(summary.executionState)) {
      // Workflow reached a terminal state — remove from the running section
      uiStore.removeLoadedWorkflow(summary.id);
    }
    // IDLE: do nothing — transient state during load/clear, not a terminal state

    // The recent-workflows dropdown list otherwise only refreshes on an
    // explicit GET_RECENT_WORKFLOWS round trip (e.g. opening the dropdown),
    // so its row for this lineage would keep showing a stale badge/step count
    // until then. Patch it in place on every transition, not just terminal
    // ones — a run entering PAUSED should update the row just as promptly.
    uiStore.updateRecentWorkflowFromSummary(summary);

    // If this is the currently active workflow, sync workflowStore so the
    // WorkflowStepsPanel stays in sync during CLI watch mode step advances.
    // WorkflowSummary.currentStep is 0-indexed (matches workflowStore.currentStep).
    if (summary.id === uiStore.activeWorkflowId) {
      const workflowStore = useWorkflowStore.getState();
      workflowStore.setCurrentStep(summary.currentStep);
      workflowStore.setTotalSteps(summary.totalSteps);
      applyExecutionState(summary.executionState);
    }
  };

  handlers[MESSAGE_TYPES.WORKSPACE_WORKTREE_OWNERSHIP] = (message) => {
    useUiStore
      .getState()
      .setWorkspaceWorktreeOwnership(message.ownership ?? null);
  };

  // --------------------------------------------------------------------------
  // ACTIVE_WORKFLOW_CHANGED - Active workflow selection changed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED] = (message) => {
    WebviewLog.info(
      `[ACTIVE_WORKFLOW_CHANGED] workflowId=inst:${message.workflowId?.slice(0, 8)}`
    );
    if (message.workflowId) {
      const uiStore = useUiStore.getState();
      uiStore.setActiveWorkflowId(message.workflowId);
      // A requestless announcement starts an authoritative full-state replay,
      // including a requestless RUN_VIEW_LOADED snapshot. The retained client
      // state may no longer match the address it previously applied (for
      // example, iOS can resume an older React state while uiStore still holds
      // the newer address/revision). Invalidate that content association so
      // the replay snapshot cannot be rejected as a same-address regression
      // against unrelated retained steps/name.
      if (!message.requestId) {
        useUiStore.setState({
          appliedViewAddress: null,
          appliedDefinitionRevision: null,
        });
      }
      // A backend-initiated switch supersedes any in-flight run-view request,
      // and clearing here is also the recovery valve for a stale pending id
      // (its requestless replay would otherwise be suppressed forever). But an
      // addressed switch announces the new instance *before* its own snapshot —
      // clearing then would make the client drop the requestful RUN_VIEW_LOADED
      // it just asked for, freezing the view on the previous workflow.
      if (message.requestId !== uiStore.pendingRunViewRequestId) {
        uiStore.clearPendingRunViewLoad();
      }
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
    settingsStore.setPortFallback(message.portFallback ?? null);
    settingsStore.setBindAddressFallback(message.bindAddressFallback ?? null);
    // Server started — any previously regenerated token is now in effect
    settingsStore.setLastTokenRegenerated(null);
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
    settingsStore.setPortFallback(null);
    settingsStore.setBindAddressFallback(null);
  };

  // --------------------------------------------------------------------------
  // SERVER_TOKEN_REGENERATED - Token deleted; signal component for in-place flash
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SERVER_TOKEN_REGENERATED] = (_message) => {
    const store = useSettingsStore.getState();
    store.setLastTokenRegenerated(Date.now());
    store.bumpTokenFlashCount();
  };

  // --------------------------------------------------------------------------
  // SERVER_CERT_GENERATED - Self-signed cert written; store metadata for in-place flash
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SERVER_CERT_GENERATED] = (message) => {
    const store = useSettingsStore.getState();
    store.setLastCertGenerated({
      generatedAt: message.generatedAt ?? new Date().toISOString(),
      expiresAt: message.expiresAt ?? "",
      sans: message.sans ?? [],
    });
    store.bumpCertFlashCount();
  };

  // --------------------------------------------------------------------------
  // SERVER_CERT_DOWNLOADED - Native Save dialog flow finished (panel only);
  // fires whether the user saved, cancelled, or the write failed so the
  // download button's pending state always clears.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SERVER_CERT_DOWNLOADED] = (message) => {
    const store = useSettingsStore.getState();
    store.setLastCertDownloadSaved(!!message.saved);
    store.bumpCertDownloadFlashCount();
    if (message.error) {
      notifyUser(message.error, USER_FEEDBACK_SEVERITY.ERROR);
    }
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
 * Hook to set up message handling for the ctrlyoke dashboard
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
      const view = useUiStore.getState();
      // Definition/output sink messages still carry an in-memory instance id
      // rather than a run ref, so they cannot safely update a different
      // historical run. Terminal transport is execution-owned, however, and
      // must remain usable while the editor browses history.
      if (
        message.workflowId &&
        view.displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        view.executionRunRef !== null &&
        view.executionRunRef !== view.displayedViewAddress.runRef &&
        message.type !== MESSAGE_TYPES.RUN_VIEW_LOADED &&
        !RUN_VIEW_INDEPENDENT_MESSAGE_TYPES.has(message.type)
      ) {
        return;
      }
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

/**
 * Open a file in VS Code editor, or in the workspace viewer when running in browser mode.
 */
export function openFile(path: string, line?: number): void {
  if (isStandalone) {
    useWorkspaceViewerStore.getState().openToFile(path, line, line);
    return;
  }
  sendMessage(MESSAGE_TYPES.OPEN_FILE, {
    path,
    lineStart: line,
    lineEnd: line,
  });
}
