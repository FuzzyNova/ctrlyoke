import React, { useCallback, useRef, useEffect, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { PropertiesDrawer } from "./PropertiesDrawer";
import { EditorFooter } from "./EditorFooter";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  STEP_STATUS,
} from "../../types/messages";

/**
 * ACTION_TYPES for prompt execution
 * Matches extension-side ACTION_TYPES
 */
const ACTION_TYPES = {
  RUN: "run",
  QUEUE: "queue",
  RUN_NEXT: "runNext",
  RUN_BEFORE_CURRENT: "runBeforeCurrent",
} as const;

interface PromptEditorProps {
  /** When true, the editor is in CLI watch mode — all editing is disabled. */
  isCLIManaged?: boolean;
}

/**
 * PromptEditor - Main prompt editing component
 *
 * Features:
 * - CodeMirror editor with spell checking and autocomplete
 * - Properties drawer (slide-up panel)
 * - EditorFooter with token count and action buttons
 * - Mode-aware actions (New vs Edit mode)
 * - State persistence to VS Code webview state
 */
export const PromptEditor: React.FC<PromptEditorProps> = ({
  isCLIManaged = false,
}) => {
  const {
    selectionTarget,
    promptText,
    promptName,
    setPromptText,
    properties,
    resetEditor,
    cancelEdit,
    markClean,
    saveToVsCodeState,
    restoreFromVsCodeState,
    hasActiveQueue,
  } = useEditorStore();

  const { prompts, executionState, currentStep, finalPromptStatus } =
    useWorkflowStore();
  const {
    propertiesDrawerOpen,
    togglePropertiesDrawer,
    closePropertiesDrawer,
  } = useUiStore();
  useSettingsStore(); // Keep store initialized for reactive updates
  const { globalSettings } = useSettingsStore();

  const vscode = getVsCodeApi();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  // Delete confirmation modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const isEditMode = selectionTarget.kind !== "newPrompt";
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const selectedPromptStatus =
    selectionTarget.kind === "queue"
      ? prompts[selectionTarget.index]?.status
      : selectionTarget.kind === "finalPrompt"
        ? finalPromptStatus
        : null;
  const isPromptCompleted = selectedPromptStatus === STEP_STATUS.COMPLETED;
  // Update button: disabled when prompt is currently being sent (SENT or RUNNING)
  const isPromptBeingSent =
    selectedPromptStatus === STEP_STATUS.SENT ||
    selectedPromptStatus === STEP_STATUS.RUNNING;
  // Delete button: disabled only when prompt is actively running
  const isPromptActivelyRunning = selectedPromptStatus === STEP_STATUS.RUNNING;

  // Dictionary URIs from document attributes
  const affUri = document.body.getAttribute("data-aff-uri") || "./en_US.aff";
  const dicUri = document.body.getAttribute("data-dic-uri") || "./en_US.dic";

  // Restore editor state from VS Code persistent storage on mount
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      // Only restore if in new prompt mode (not editing an existing prompt)
      if (selectionTarget.kind === "newPrompt") {
        restoreFromVsCodeState(vscode);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Check if there are pending prompts in the queue
  const hasPendingPrompts = useCallback(() => {
    if (prompts.length === 0) return false;

    for (let i = currentStep; i < prompts.length; i++) {
      if (prompts[i]?.status === STEP_STATUS.PENDING) {
        return true;
      }
    }
    return false;
  }, [prompts, currentStep]);

  // Debounced save to VS Code state on every content change
  // Mirrors old editor-manager.js: saveEditorState() called on every onChange, input, change event
  useEffect(() => {
    if (selectionTarget.kind !== "newPrompt") return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveToVsCodeState(vscode);
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    promptText,
    promptName,
    properties,
    selectionTarget,
    saveToVsCodeState,
    vscode,
  ]);

  // Flush pending save on close/unload so state survives VS Code restart
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (selectionTarget.kind === "newPrompt") {
        saveToVsCodeState(vscode);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [selectionTarget, saveToVsCodeState, vscode]);

  // Close drawer on ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && propertiesDrawerOpen) {
        closePropertiesDrawer();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [propertiesDrawerOpen, closePropertiesDrawer]);

  // Get property values for sending to extension
  // includeNullsForDefaults: if true, send null for default values to clear overrides
  const getPropertyValues = useCallback(
    (includeNullsForDefaults = false) => {
      const result: Record<string, unknown> = {};

      // Harness
      if (properties.harness !== "default") {
        result.harness = properties.harness;
      } else if (includeNullsForDefaults) {
        result.harness = null;
      }

      // Model
      if (properties.model !== "default") {
        result.model = properties.model;
      } else if (includeNullsForDefaults) {
        result.model = null;
      }

      // Agent
      if (properties.agent && properties.agent !== "") {
        result.agent = properties.agent;
      } else if (includeNullsForDefaults) {
        result.agent = null;
      }

      // Resume Session
      if (properties.resumeSession !== "default") {
        result.resumeSession = properties.resumeSession === "yes";
      } else if (includeNullsForDefaults) {
        result.resumeSession = null;
      }

      // Session ID - Parse as number if it's a numeric reference
      if (properties.sessionId && properties.sessionId.trim()) {
        const trimmed = properties.sessionId.trim();
        // If it's a pure number, convert to number (for prompt references)
        if (/^\d+$/.test(trimmed)) {
          result.sessionId = parseInt(trimmed, 10);
        } else {
          result.sessionId = trimmed;
        }
      } else if (includeNullsForDefaults) {
        result.sessionId = null;
      }

      // Allow Dynamic Extension
      if (properties.allowDynamicExtension !== "default") {
        result.allowDynamicExtension =
          properties.allowDynamicExtension === "yes";
      } else if (includeNullsForDefaults) {
        result.allowDynamicExtension = null;
      }

      // End Condition - Three-state logic:
      // - undefined (not included) = inherit from workflow
      // - null (explicitly set) = disable end condition (override workflow)
      // - object (with values) = specific end condition (override workflow)
      if (properties.endCondition !== undefined) {
        // Checkbox is checked (endCondition is not undefined)
        // Check if required fields are filled
        const script = properties.endCondition?.script?.trim() || "";
        const returns = properties.endCondition?.returns?.trim() || "";

        // If checked but required fields empty, send null to explicitly disable
        if (!script || !returns) {
          result.endCondition = null;
        } else {
          // Build end condition with filled fields
          result.endCondition = properties.endCondition;
        }
      } else if (includeNullsForDefaults) {
        // When updating, send null to clear overrides
        result.endCondition = null;
      }
      // else: undefined, omit from result (inherit from workflow)

      return result;
    },
    [properties]
  );

  // Execute prompt (Run/Queue)
  const executePrompt = useCallback(
    (action: string) => {
      const text = promptText.trim();
      if (!text) return;

      const propertyValues = getPropertyValues();
      let finalAction = action;

      // Determine final action based on execution state
      if (action === ACTION_TYPES.RUN && hasPendingPrompts()) {
        const isIdle = executionState === EXECUTION_STATES.IDLE;
        const isStopped = executionState === EXECUTION_STATES.STOPPED;
        const isPaused = executionState === EXECUTION_STATES.PAUSED;

        if (isStopped) {
          finalAction = ACTION_TYPES.RUN_BEFORE_CURRENT;
        } else if (isIdle && currentStep === 0) {
          finalAction = ACTION_TYPES.RUN_BEFORE_CURRENT;
        } else if (isPaused || isRunning) {
          finalAction = ACTION_TYPES.RUN_NEXT;
        } else {
          finalAction = ACTION_TYPES.RUN_NEXT;
        }
      }

      vscode.postMessage({
        type: MESSAGE_TYPES.EXECUTE_PROMPT,
        text,
        properties: propertyValues,
        action: finalAction,
        promptName: promptName.trim(),
        forceNewWorkflow: false, // TODO: Add checkbox for this
      });

      // Clear editor after submission
      resetEditor();
      markClean();

      // Clear persisted state
      vscode.setState(null);
    },
    [
      promptText,
      promptName,
      getPropertyValues,
      hasPendingPrompts,
      executionState,
      currentStep,
      isRunning,
      vscode,
      resetEditor,
      markClean,
    ]
  );

  // Update existing prompt
  const handleUpdate = useCallback(() => {
    const text = promptText.trim();
    if (!text) return;

    // Include nulls for default values to clear overrides
    const propertyValues = getPropertyValues(true);

    if (selectionTarget.kind === "queue") {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_PROMPT,
        index: selectionTarget.index,
        text,
        properties: propertyValues,
      });
    } else if (selectionTarget.kind === "finalPrompt") {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
        finalPrompt: {
          ...propertyValues,
          ...(promptName.trim() ? { name: promptName.trim() } : {}),
          prompt: text,
        },
      });
    } else {
      return;
    }

    // Return to new prompt mode
    cancelEdit();
  }, [
    selectionTarget,
    promptText,
    getPropertyValues,
    vscode,
    cancelEdit,
    promptName,
  ]);

  // Delete prompt - shows confirmation modal (or deletes immediately when confirmDeleteOperations is false)
  const handleDeleteClick = useCallback(() => {
    if (selectionTarget.kind === "newPrompt") return;
    if (!globalSettings.confirmDeleteOperations) {
      // Skip modal — user opted out of delete confirmation
      if (selectionTarget.kind === "queue") {
        vscode.postMessage({
          type: MESSAGE_TYPES.DELETE_PROMPT,
          index: selectionTarget.index,
        });
      } else {
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
          finalPrompt: null,
        });
      }
      cancelEdit();
      return;
    }
    setShowDeleteModal(true);
  }, [
    selectionTarget,
    globalSettings.confirmDeleteOperations,
    vscode,
    cancelEdit,
  ]);

  // Confirm delete action
  const handleDeleteConfirm = useCallback(() => {
    if (selectionTarget.kind === "newPrompt") return;

    if (selectionTarget.kind === "queue") {
      vscode.postMessage({
        type: MESSAGE_TYPES.DELETE_PROMPT,
        index: selectionTarget.index,
      });
    } else {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
        finalPrompt: null,
      });
    }
    setShowDeleteModal(false);
    cancelEdit();
  }, [selectionTarget, vscode, cancelEdit]);

  // Cancel delete action
  const handleDeleteCancel = useCallback(() => {
    setShowDeleteModal(false);
  }, []);

  // Handle editor text change
  const handleTextChange = useCallback(
    (text: string) => {
      setPromptText(text);
    },
    [setPromptText]
  );

  // Get button text based on pending prompts
  const getRunButtonText = () => {
    return hasPendingPrompts() ? "Run Next" : "Run";
  };

  // Get button tooltip based on workflow state
  const getRunButtonTooltip = () => {
    if (!hasActiveQueue) {
      return "Queue to new workflow and run";
    }

    switch (executionState) {
      case EXECUTION_STATES.IDLE:
        return "Queue and run workflow";
      case EXECUTION_STATES.RUNNING:
        return "Queue to current workflow";
      case EXECUTION_STATES.COMPLETED:
        return "Queue and resume workflow";
      default:
        return "Run prompt";
    }
  };

  const getQueueButtonTooltip = () => {
    if (!hasActiveQueue) {
      return "Queue to new workflow";
    }
    return "Add prompt to execution queue";
  };

  return (
    <div
      ref={editorContainerRef}
      className="prompt-editor flex flex-col flex-1 overflow-hidden"
    >
      {/* CodeMirror Editor + Properties Drawer container */}
      <div className="prompt-editor-wrapper flex flex-col flex-1 overflow-hidden relative">
        <CodeMirrorEditor
          value={promptText}
          onChange={handleTextChange}
          placeholder="Use @ for files and folders, # for selections and symbols"
          affUri={affUri}
          dicUri={dicUri}
          readOnly={isCLIManaged}
        />

        {/* Properties Drawer (slides up from bottom, overlays only editor) */}
        <PropertiesDrawer
          isOpen={propertiesDrawerOpen}
          onClose={closePropertiesDrawer}
        />
      </div>

      {/* Editor Footer with actions (outside wrapper, not covered by drawer) */}
      <EditorFooter
        isEditMode={isEditMode}
        isFinalPromptMode={selectionTarget.kind === "finalPrompt"}
        isPromptCompleted={isPromptCompleted}
        isPromptBeingSent={isPromptBeingSent}
        isPromptActivelyRunning={isPromptActivelyRunning}
        hasContent={promptText.trim().length > 0}
        hasPendingPrompts={hasPendingPrompts()}
        runButtonText={getRunButtonText()}
        runButtonTooltip={getRunButtonTooltip()}
        queueButtonTooltip={getQueueButtonTooltip()}
        onRun={() => executePrompt(ACTION_TYPES.RUN)}
        onQueue={() => executePrompt(ACTION_TYPES.QUEUE)}
        onUpdate={handleUpdate}
        onDelete={handleDeleteClick}
        onCancel={cancelEdit}
        onToggleProperties={togglePropertiesDrawer}
        propertiesOpen={propertiesDrawerOpen}
        isCLIManaged={isCLIManaged}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={showDeleteModal}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title="Delete Prompt"
        message={
          selectionTarget.kind === "finalPrompt"
            ? "Disable orchestrator prompt?"
            : `Are you sure you want to delete prompt ${selectionTarget.kind === "queue" ? selectionTarget.index + 1 : 1}?`
        }
        detail="This action cannot be undone."
      />
    </div>
  );
};
