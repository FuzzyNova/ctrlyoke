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
import { getVsCodeApi } from "./useVsCodeApi";
import { useWorkflowStore } from "../store/workflowStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { useEditorStore } from "../store/editorStore";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  STEP_STATUS,
  type ExecutionState,
  type StepStatus,
  type HarnessId,
} from "../types/messages";

// ============================================================================
// Types
// ============================================================================

type MessageHandler = (message: any) => void;
type MessageHandlerMap = Record<string, MessageHandler>;

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
    }

    // Update workflow properties
    if (data.workflowProperties) {
      settingsStore.setWorkflowProperties(data.workflowProperties);
    }

    // Update harness status
    if (data.harnessStatus) {
      settingsStore.setAllHarnessStatuses(data.harnessStatus);
    }

    // Update available agents
    if (data.availableAgents) {
      settingsStore.setAvailableAgents(data.availableAgents);
    }

    // Load workflow if data includes prompts
    if (data.prompts && data.prompts.length > 0) {
      workflowStore.loadWorkflow({
        fileName: data.fileName || "",
        workflowName: data.workflowName,
        prompts: data.prompts,
        executionState: data.executionState as ExecutionState,
        currentStep: data.currentIndex || 0,
        results: data.results || [],
      });
      editorStore.setHasActiveQueue(true);
      settingsStore.setWorkflowLoaded(true);
    }
  };

  // --------------------------------------------------------------------------
  // FILE_SELECTED - New workflow file loaded
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.FILE_SELECTED] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    const editorStore = useEditorStore.getState();
    const settingsStore = useSettingsStore.getState();

    workflowStore.loadWorkflow({
      fileName: message.fileName,
      workflowName: message.workflowName,
      prompts: message.prompts || [],
    });

    editorStore.setHasActiveQueue(true);
    settingsStore.setWorkflowLoaded(true);
  };

  // --------------------------------------------------------------------------
  // SESSION_RESTORED - Restore previous session with runtime state
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.SESSION_RESTORED] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    const editorStore = useEditorStore.getState();
    const settingsStore = useSettingsStore.getState();

    workflowStore.loadWorkflow({
      fileName: message.fileName,
      workflowName: message.workflowName,
      prompts: message.prompts || [],
      executionState: message.executionState as ExecutionState,
      currentStep: message.currentIndex || 0,
      results: message.results || [],
    });

    editorStore.setHasActiveQueue(true);
    settingsStore.setWorkflowLoaded(true);
  };

  // --------------------------------------------------------------------------
  // PROMPTS_EXTENDED - Queue was extended with new prompts
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.PROMPTS_EXTENDED] = (message) => {
    const workflowStore = useWorkflowStore.getState();

    // Update prompts list (keep existing status for completed prompts)
    const currentPrompts = workflowStore.prompts;
    const newPrompts = (message.prompts || []).map(
      (prompt: any, index: number) => {
        // Preserve status from existing prompts
        const existingPrompt = currentPrompts[index];
        return {
          ...prompt,
          status: existingPrompt?.status || STEP_STATUS.PENDING,
        };
      }
    );

    workflowStore.setPrompts(newPrompts);
  };

  // --------------------------------------------------------------------------
  // PROMPT_DELETED - Prompt was deleted from queue
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.PROMPT_DELETED] = (message) => {
    const workflowStore = useWorkflowStore.getState();

    workflowStore.setFileName(message.fileName);
    workflowStore.setPrompts(message.prompts || []);
  };

  // --------------------------------------------------------------------------
  // EXECUTION_STARTED - Workflow execution has started
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_STARTED] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    const editorStore = useEditorStore.getState();

    // Reset all prompts to pending state (for restart scenario)
    const resetPrompts = workflowStore.prompts.map((prompt) => ({
      ...prompt,
      status: STEP_STATUS.PENDING as StepStatus,
    }));

    workflowStore.setFileName(message.fileName);
    workflowStore.setExecutionState(EXECUTION_STATES.RUNNING);
    workflowStore.setTotalSteps(message.totalSteps);
    workflowStore.setCurrentStep(0);
    workflowStore.setPrompts(resetPrompts);
    workflowStore.clearAllRuntimeState();

    // Mark editor as having active queue
    editorStore.setHasActiveQueue(true);
  };

  // --------------------------------------------------------------------------
  // EXECUTION_STATE_CHANGED - Execution state changed (running/paused/stopped)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_STATE_CHANGED] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setExecutionState(message.state as ExecutionState);
  };

  // --------------------------------------------------------------------------
  // PROGRESS_UPDATE - Current step/total steps updated
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.PROGRESS_UPDATE] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setCurrentStep(message.current);
    workflowStore.setTotalSteps(message.total);
  };

  // --------------------------------------------------------------------------
  // STEP_STATUS_CHANGED - Individual step status changed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STEP_STATUS_CHANGED] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    const { stepIndex, status, details } = message;

    if (workflowStore.prompts[stepIndex]) {
      workflowStore.updatePrompt(stepIndex, {
        status: status.state || status,
        _runtime: details
          ? {
              ...workflowStore.prompts[stepIndex]._runtime,
              ...details,
            }
          : undefined,
      });
    }
  };

  // --------------------------------------------------------------------------
  // RETRY_ATTEMPT_CHANGED - Retry count updated for a step
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED] = (message) => {
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
  handlers[MESSAGE_TYPES.EXECUTION_COMPLETED] = () => {
    const workflowStore = useWorkflowStore.getState();
    workflowStore.setExecutionState(EXECUTION_STATES.COMPLETED);
  };

  // --------------------------------------------------------------------------
  // CLI_OUTPUT - Complete CLI output for a step
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_OUTPUT] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    workflowStore.addCliOutput(message.stepIndex, message.output);
  };

  // --------------------------------------------------------------------------
  // CLI_STREAMING_CHUNK - Incremental streaming text chunk
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_STREAMING_CHUNK] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    console.log(
      `🔍 Dashboard: Received CLI_STREAMING_CHUNK, stepIndex=${message.stepIndex}, chunk length=${message.chunk?.length}`
    );
    workflowStore.appendStreamingChunk(message.stepIndex, message.chunk || "");
  };

  // --------------------------------------------------------------------------
  // CLI_STREAMING_EVENTS - Structured events for Claude/Codex CLI
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLI_STREAMING_EVENTS] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    const events = message.events || [];

    console.log(
      `🔍 Dashboard: Received CLI_STREAMING_EVENTS, stepIndex=${message.stepIndex}, event count=${events.length}`
    );

    // Append events to streaming buffer (creates buffer if needed)
    // Events are accumulated and displayed in real-time as formatted structured output
    workflowStore.appendStreamingEvents(message.stepIndex, events);
  };

  // --------------------------------------------------------------------------
  // STATUS_MESSAGE - Status message for a step (info/warning/error)
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.STATUS_MESSAGE] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    workflowStore.addStatusMessage(
      message.stepIndex,
      message.message,
      message.severity
    );
  };

  // --------------------------------------------------------------------------
  // WORKFLOW_NAME_UPDATED - Workflow name changed
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_NAME_UPDATED] = (message) => {
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
  // WORKFLOW_CREATED - New workflow file was created
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_CREATED] = (message) => {
    const uiStore = useUiStore.getState();
    uiStore.closeNewWorkflowModal();
    // Show success toast
    uiStore.showToast(`Workflow created: ${message.filePath}`, "success");
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
  // WORKFLOW_PROPERTIES_UPDATE - Update workflow-level properties
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE] = (message) => {
    const settingsStore = useSettingsStore.getState();

    // Handle both message.data and direct message structure (like vanilla implementation)
    const data = message.data || message;
    if (data.workflowProperties) {
      // Merge with existing properties (don't replace completely)
      const currentProperties = settingsStore.workflowProperties;
      settingsStore.setWorkflowProperties({
        ...currentProperties,
        ...data.workflowProperties,
      });
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
    console.log(
      `[MessageHandler] Received CONFIG_VALUE: ${message.key} = ${message.value}`
    );
  };

  // --------------------------------------------------------------------------
  // COMPLETIONS_RESPONSE - Autocomplete suggestions for editor
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.COMPLETIONS_RESPONSE] = (message) => {
    // Completions are handled by the editor component directly
    // This is logged for debugging
    console.log(
      `[MessageHandler] Received COMPLETIONS_RESPONSE: ${message.items?.length} items, from=${message.from}`
    );
  };

  // --------------------------------------------------------------------------
  // QUEUE_SIZE_LIMIT_REACHED - Queue hit size limit
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.QUEUE_SIZE_LIMIT_REACHED] = (message) => {
    const workflowStore = useWorkflowStore.getState();
    workflowStore.addStatusMessage(
      -1,
      `Queue size limit reached: ${message.currentSize}/${message.maxSize}`
    );
  };

  // --------------------------------------------------------------------------
  // EXECUTION_TIME_LIMIT_REACHED - Execution hit time limit
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.EXECUTION_TIME_LIMIT_REACHED] = (message) => {
    const workflowStore = useWorkflowStore.getState();

    workflowStore.addStatusMessage(
      -1,
      `Execution time limit reached: ${message.elapsedSeconds}/${message.maxSeconds}s (${message.completedCount}/${message.totalCount} prompts)`
    );

    workflowStore.setExecutionState(EXECUTION_STATES.STOPPED);
  };

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
        console.warn(`[MessageHandler] Unknown message type: ${message.type}`);
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
  sendMessage(MESSAGE_TYPES.OPEN_FILE, { path, line });
}
