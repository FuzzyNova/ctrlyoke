import React, { useCallback, useRef, useEffect, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useDrawerTabOverrides } from "../../hooks/useDrawerTabOverrides";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
import type { HarnessId } from "../../types/messages";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { PropertiesDrawer } from "./PropertiesDrawer";
import { EditorFooter } from "./EditorFooter";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  ACTION_TYPES,
  EDITOR_TARGET_KINDS,
  EDITOR_PLACEHOLDER_TEXT,
} from "../../types/messages";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import { looksLikeFilePath } from "@root/utils/promptPathUtils";

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
    stepType,
    scriptCommand,
    scriptTimeout,
    scriptOnPass,
    scriptOnFail,
    scriptCompareSource,
    scriptReturns,
    setScriptCommand,
    setScriptTimeout,
    setScriptOnPass,
    setScriptOnFail,
    setScriptCompareSource,
    setScriptReturns,
  } = useEditorStore();

  const {
    steps: prompts,
    executionState,
    currentStep,
    finalStepStatus,
  } = useWorkflowStore();
  const {
    propertiesDrawerOpen,
    togglePropertiesDrawer,
    closePropertiesDrawer,
  } = useUiStore();
  useSettingsStore(); // Keep store initialized for reactive updates
  const { globalSettings, workflowProperties } = useSettingsStore();

  // ── Drawer tab state (lifted from PropertiesDrawer for footer tab bar) ─────
  const [drawerActivePage, setDrawerActivePage] = useState<DrawerPage>(
    DRAWER_PAGES.HARNESS
  );

  // Reset to first tab when drawer opens for a new prompt
  useEffect(() => {
    if (propertiesDrawerOpen) {
      setDrawerActivePage(DRAWER_PAGES.HARNESS);
    }
  }, [propertiesDrawerOpen, selectionTarget]);

  const drawerCurrentHarness = (properties.harness ??
    workflowProperties.harness ??
    globalSettings.harness) as HarnessId;

  const drawerTabOverrides = useDrawerTabOverrides(
    workflowProperties,
    globalSettings,
    properties
  );

  const vscode = getVsCodeApi();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  // Delete confirmation modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  // null = not applicable / pending, true = file found, false = file not found
  const [fileRefExists, setFileRefExists] = useState<boolean | null>(null);

  const isEditMode = selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT;
  const isFinalStep = selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP;
  const isScriptMode = stepType === STEP_TYPES.SCRIPT;
  const isFileRef = looksLikeFilePath(promptText.trim());
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const selectedPromptStatus =
    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
      ? (prompts[selectionTarget.index] as any)?.status
      : selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP
        ? finalStepStatus
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
      if (selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT) {
        restoreFromVsCodeState(vscode);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Check if there are pending prompts in the queue
  const hasPendingPrompts = useCallback(() => {
    if (prompts.length === 0) return false;

    for (let i = currentStep; i < prompts.length; i++) {
      if ((prompts[i] as any)?.status === STEP_STATUS.PENDING) {
        return true;
      }
    }
    return false;
  }, [prompts, currentStep]);

  // Debounced save to VS Code state on every content change
  // Mirrors old editor-manager.js: saveEditorState() called on every onChange, input, change event
  useEffect(() => {
    if (selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) return;

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
      if (selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT) {
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

  // Validate file-ref path when the editor contains a lone file path.
  // Debounced to avoid spamming on every keystroke.
  useEffect(() => {
    if (!isFileRef) {
      setFileRefExists(null);
      if (validateTimeoutRef.current) {
        clearTimeout(validateTimeoutRef.current);
      }
      return;
    }

    setFileRefExists(null); // pending while we wait

    if (validateTimeoutRef.current) {
      clearTimeout(validateTimeoutRef.current);
    }

    validateTimeoutRef.current = setTimeout(() => {
      vscode.postMessage({
        type: MESSAGE_TYPES.VALIDATE_FILE_REF,
        filePath: promptText.trim(),
      });
    }, 400);

    return () => {
      if (validateTimeoutRef.current) {
        clearTimeout(validateTimeoutRef.current);
      }
    };
  }, [isFileRef, promptText, vscode]);

  // Listen for FILE_REF_VALIDATION responses from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === MESSAGE_TYPES.FILE_REF_VALIDATION) {
        setFileRefExists(event.data.exists as boolean);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Get property values for sending to extension
  // includeNullsForDefaults: if true, send null for default values to clear overrides
  // Returns two separate collections:
  //   properties    — values to set in PromptStep (null is stored as-is, e.g. additionalArgs: null)
  //   clearProperties — keys to delete from PromptStep (set to undefined), used when the user
  //                     switches a property back to "Default / inherit from workflow"
  //
  // This separation is required because null has distinct meanings for three-state properties:
  //   - null in `properties`    → "explicitly none/disabled" (stored as null in PromptStep)
  //   - key in `clearProperties` → "inherit from workflow/settings" (key removed from PromptStep)
  const getPropertyValues = useCallback(
    (includeNullsForDefaults = false) => {
      const result: Record<string, unknown> = {};
      const clearProperties: string[] = [];

      // Harness
      if (properties.harness !== undefined) {
        result.harness = properties.harness;
      } else if (includeNullsForDefaults) {
        clearProperties.push("harness");
      }

      // Model
      if (properties.model !== undefined) {
        result.model = properties.model;
      } else if (includeNullsForDefaults) {
        clearProperties.push("model");
      }

      // Agent
      if (properties.agent === null) {
        result.agent = null;
      } else if (typeof properties.agent === "string" && properties.agent) {
        result.agent = properties.agent;
      } else if (includeNullsForDefaults) {
        clearProperties.push("agent");
      }

      // Resume Session
      if (properties.resumeSession !== undefined) {
        result.resumeSession = properties.resumeSession;
      } else if (includeNullsForDefaults) {
        clearProperties.push("resumeSession");
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
        clearProperties.push("sessionId");
      }

      // MCP Servers
      if (properties.mcpServers !== undefined) {
        result.mcpServers = properties.mcpServers;
      } else if (includeNullsForDefaults) {
        clearProperties.push("mcpServers");
      }

      // Hooks
      if (properties.hooks !== undefined) {
        result.hooks = properties.hooks;
      } else if (includeNullsForDefaults) {
        clearProperties.push("hooks");
      }

      // Skills
      if (properties.skills === null) {
        result.skills = null;
      } else if (Array.isArray(properties.skills)) {
        result.skills = properties.skills.length > 0 ? properties.skills : null;
      } else if (includeNullsForDefaults) {
        clearProperties.push("skills");
      }

      // Prior Context
      if (properties.priorContext !== undefined) {
        result.priorContext = properties.priorContext;
      } else if (includeNullsForDefaults) {
        clearProperties.push("priorContext");
      }

      // Additional Args — three-state:
      //   null   → "explicitly none" (stored as null, stops three-tier resolution)
      //   string → custom args
      //   key in clearProperties → "Default / inherit" (key removed from PromptStep)
      if (properties.additionalArgs === null) {
        result.additionalArgs = null;
      } else if (properties.additionalArgs) {
        result.additionalArgs = properties.additionalArgs;
      } else if (includeNullsForDefaults) {
        clearProperties.push("additionalArgs");
      }

      // End Condition — three-state:
      //   object  → specific end condition
      //   null in properties → checked but empty (treated as "clear" via coerce on backend)
      //   key in clearProperties → unchecked, clear back to inherit
      if (properties.endCondition !== undefined) {
        const script = properties.endCondition?.script?.trim() || "";
        const returns = properties.endCondition?.returns?.trim() || "";
        result.endCondition =
          !script || !returns ? null : properties.endCondition;
      } else if (includeNullsForDefaults) {
        clearProperties.push("endCondition");
      }

      return { properties: result, clearProperties };
    },
    [properties]
  );

  // Ref to hold the last submitted text so we can restore it on failure
  const lastSubmittedTextRef = useRef<string>("");

  // Listen for EXECUTE_PROMPT_ERROR and restore the editor if the submission failed
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === MESSAGE_TYPES.EXECUTE_PROMPT_ERROR) {
        const restored =
          (event.data.text as string) || lastSubmittedTextRef.current;
        if (restored) {
          setPromptText(restored);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [setPromptText]);

  // Compute the final action based on execution state (shared by prompt and script paths)
  const resolveFinalAction = useCallback(
    (action: string): string => {
      if (action === ACTION_TYPES.RUN && hasPendingPrompts()) {
        const isIdle = executionState === EXECUTION_STATES.IDLE;
        const isStopped = executionState === EXECUTION_STATES.STOPPED;
        const isPaused = executionState === EXECUTION_STATES.PAUSED;
        if (isStopped) return ACTION_TYPES.RUN_BEFORE_CURRENT;
        if (isIdle && currentStep === 0) return ACTION_TYPES.RUN_BEFORE_CURRENT;
        if (isPaused || isRunning) return ACTION_TYPES.RUN_NEXT;
        return ACTION_TYPES.RUN_NEXT;
      }
      return action;
    },
    [hasPendingPrompts, executionState, currentStep, isRunning]
  );

  // Execute prompt (Run/Queue)
  const executePrompt = useCallback(
    (action: string) => {
      const finalAction = resolveFinalAction(action);

      if (isScriptMode) {
        const command = scriptCommand.trim();
        if (!command) return;

        lastSubmittedTextRef.current = command;
        vscode.postMessage({
          type: MESSAGE_TYPES.EXECUTE_PROMPT,
          text: command,
          properties: {
            type: STEP_TYPES.SCRIPT,
            ...(scriptTimeout !== undefined && { timeout: scriptTimeout }),
            ...(scriptOnPass !== "continue" && { onPass: scriptOnPass }),
            ...(scriptOnFail !== "stopWorkflow" && { onFail: scriptOnFail }),
            ...(scriptCompareSource !== "auto" && { compareSource: scriptCompareSource }),
            ...(scriptReturns && { returns: scriptReturns }),
          },
          action: finalAction,
          promptName: promptName.trim(),
          forceNewWorkflow: false,
        });
        resetEditor();
        markClean();
        vscode.setState(null);
        return;
      }

      const text = promptText.trim();
      if (!text) return;

      const { properties: propertyValues } = getPropertyValues();

      // Save before clearing so we can restore on failure
      lastSubmittedTextRef.current = text;

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
      isScriptMode,
      scriptCommand,
      scriptTimeout,
      scriptOnPass,
      scriptOnFail,
      scriptCompareSource,
      scriptReturns,
      promptText,
      promptName,
      getPropertyValues,
      resolveFinalAction,
      vscode,
      resetEditor,
      markClean,
    ]
  );

  // Update existing prompt
  const handleUpdate = useCallback(() => {
    if (isScriptMode) {
      const command = scriptCommand.trim();
      if (!command) return;

      const scriptProperties = {
        type: STEP_TYPES.SCRIPT,
        ...(scriptTimeout !== undefined && { timeout: scriptTimeout }),
        ...(scriptOnPass !== "continue" && { onPass: scriptOnPass }),
        ...(scriptOnFail !== "stopWorkflow" && { onFail: scriptOnFail }),
        ...(scriptCompareSource !== "auto" && { compareSource: scriptCompareSource }),
        ...(scriptReturns && { returns: scriptReturns }),
      };

      if (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_PROMPT,
          index: selectionTarget.index,
          text: command,
          properties: scriptProperties,
          promptName: promptName.trim(),
        });
        if (isPromptCompleted) {
          vscode.postMessage({
            type: MESSAGE_TYPES.SET_START_POSITION,
            toIndex: selectionTarget.index,
          });
        }
      } else if (selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
          finalStep: {
            type: STEP_TYPES.SCRIPT,
            script: command,
            ...(promptName.trim() ? { name: promptName.trim() } : {}),
            ...(scriptTimeout !== undefined && { timeout: scriptTimeout }),
            ...(scriptOnPass !== "continue" && { onPass: scriptOnPass }),
            ...(scriptOnFail !== "stopWorkflow" && { onFail: scriptOnFail }),
            ...(scriptCompareSource !== "auto" && { compareSource: scriptCompareSource }),
            ...(scriptReturns && { returns: scriptReturns }),
          },
        });
      } else {
        return;
      }
      cancelEdit();
      return;
    }

    const text = promptText.trim();
    if (!text) return;

    const { properties: propertyValues, clearProperties } =
      getPropertyValues(true);

    if (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_PROMPT,
        index: selectionTarget.index,
        text,
        properties: propertyValues,
        clearProperties,
        promptName: promptName.trim(),
      });
      // If editing a completed prompt, reset execution back to this step so it can be re-run
      if (isPromptCompleted) {
        vscode.postMessage({
          type: MESSAGE_TYPES.SET_START_POSITION,
          toIndex: selectionTarget.index,
        });
      }
    } else if (selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
        finalStep: {
          ...propertyValues,
          ...(promptName.trim() ? { name: promptName.trim() } : {}),
          prompt: text,
        },
        clearProperties,
      });
    } else {
      return;
    }

    // Return to new prompt mode
    cancelEdit();
  }, [
    isScriptMode,
    scriptCommand,
    scriptTimeout,
    scriptOnPass,
    scriptOnFail,
    scriptCompareSource,
    scriptReturns,
    selectionTarget,
    promptText,
    getPropertyValues,
    vscode,
    cancelEdit,
    promptName,
    isPromptCompleted,
  ]);

  // Delete prompt - shows confirmation modal (or deletes immediately when confirmDeleteOperations is false)
  const handleDeleteClick = useCallback(() => {
    if (selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT) return;
    if (!globalSettings.confirmDeleteOperations) {
      // Skip modal — user opted out of delete confirmation
      if (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        vscode.postMessage({
          type: MESSAGE_TYPES.DELETE_PROMPT,
          index: selectionTarget.index,
        });
      } else {
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
          finalStep: null,
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
    if (selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT) return;

    if (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
      vscode.postMessage({
        type: MESSAGE_TYPES.DELETE_PROMPT,
        index: selectionTarget.index,
      });
    } else {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
        finalStep: null,
      });
    }
    setShowDeleteModal(false);
    cancelEdit();
  }, [selectionTarget, vscode, cancelEdit]);

  // Cancel delete action
  const handleDeleteCancel = useCallback(() => {
    setShowDeleteModal(false);
  }, []);

  // Keyboard shortcut handlers for CodeMirror — mirror the footer button disabled states
  const handleEditorRun = useCallback(() => {
    if (!isEditMode && !isCLIManaged && promptText.trim().length > 0) {
      executePrompt(ACTION_TYPES.RUN);
    }
  }, [isEditMode, isCLIManaged, promptText, executePrompt]);

  const handleEditorQueue = useCallback(() => {
    if (!isEditMode && !isCLIManaged && promptText.trim().length > 0) {
      executePrompt(ACTION_TYPES.QUEUE);
    }
  }, [isEditMode, isCLIManaged, promptText, executePrompt]);

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
      {/* CodeMirror Editor + Properties Drawer container (prompt mode only) */}
      {!isScriptMode && (
        <div className="prompt-editor-wrapper flex flex-col flex-1 overflow-hidden relative">
          <CodeMirrorEditor
            value={promptText}
            onChange={handleTextChange}
            placeholder={
              isFinalStep ? EDITOR_PLACEHOLDER_TEXT.FINAL_PROMPT : undefined
            }
            affUri={affUri}
            dicUri={dicUri}
            readOnly={isCLIManaged}
            onRun={handleEditorRun}
            onQueue={handleEditorQueue}
          />

          {/* Properties Drawer (slides up from bottom, overlays only editor) */}
          <PropertiesDrawer
            isOpen={propertiesDrawerOpen}
            onClose={closePropertiesDrawer}
            activePage={drawerActivePage}
          />
        </div>
      )}

      {/* Script step fields (script mode only) */}
      {isScriptMode && (
        <div className="flex flex-col flex-1 overflow-auto px-3 py-3 gap-4 bg-editor-bg">
          {/* Script command */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-foreground">
              Script command
            </label>
            <input
              type="text"
              value={scriptCommand}
              onChange={(e) => setScriptCommand(e.target.value)}
              placeholder="e.g. npm test"
              disabled={isCLIManaged}
              className="px-2 py-1.5 text-xs bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border disabled:opacity-50"
              style={{ boxShadow: "none" }}
            />
          </div>

          {/* On Pass + On Fail (side-by-side) */}
          <div className="flex gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs font-medium text-foreground">
                On Pass
              </label>
              <select
                value={scriptOnPass}
                onChange={(e) => setScriptOnPass(e.target.value)}
                disabled={isCLIManaged}
                className="px-2 py-1.5 text-xs bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border disabled:opacity-50"
                style={{ boxShadow: "none" }}
              >
                <option value="continue">Continue</option>
                <option value="stopWorkflow">Stop Workflow</option>
              </select>
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs font-medium text-foreground">
                On Fail
              </label>
              <select
                value={scriptOnFail}
                onChange={(e) => setScriptOnFail(e.target.value)}
                disabled={isCLIManaged}
                className="px-2 py-1.5 text-xs bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border disabled:opacity-50"
                style={{ boxShadow: "none" }}
              >
                <option value="continue">Continue</option>
                <option value="stopWorkflow">Stop Workflow</option>
              </select>
            </div>
          </div>

          {/* Compare Source + Expected Return (side-by-side) */}
          <div className="flex gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs font-medium text-foreground">
                Compare Source
              </label>
              <select
                value={scriptCompareSource}
                onChange={(e) => setScriptCompareSource(e.target.value)}
                disabled={isCLIManaged}
                className="px-2 py-1.5 text-xs bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border disabled:opacity-50"
                style={{ boxShadow: "none" }}
              >
                <option value="auto">Auto</option>
                <option value="stdout">Stdout</option>
                <option value="stderr">Stderr</option>
                <option value="exitCode">Exit Code</option>
              </select>
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs font-medium text-foreground">
                Expected Return
              </label>
              <input
                type="text"
                value={scriptReturns}
                onChange={(e) => setScriptReturns(e.target.value)}
                placeholder="e.g. true or 0"
                disabled={isCLIManaged}
                className="px-2 py-1.5 text-xs bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border disabled:opacity-50"
                style={{ boxShadow: "none" }}
              />
            </div>
          </div>

          {/* Timeout */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-foreground">
              Timeout (ms)
            </label>
            <input
              type="number"
              min={0}
              step={1000}
              value={scriptTimeout ?? ""}
              onChange={(e) =>
                setScriptTimeout(
                  e.target.value !== "" ? Number(e.target.value) : undefined
                )
              }
              placeholder="Default (from settings)"
              disabled={isCLIManaged}
              className="px-2 py-1.5 text-xs bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border disabled:opacity-50 w-48"
              style={{ boxShadow: "none" }}
            />
          </div>
        </div>
      )}

      {/* File-reference badge — shown when editor contains only a file path (prompt mode only) */}
      {!isScriptMode && isFileRef && (
        <div
          className="flex items-center gap-1 px-2 py-1 text-xs"
          style={{
            color:
              fileRefExists === false
                ? "var(--vscode-editorWarning-foreground)"
                : "var(--vscode-textLink-foreground)",
            backgroundColor: "var(--vscode-editor-background)",
            borderTop:
              "1px solid var(--vscode-widget-border, var(--vscode-panel-border))",
          }}
        >
          {fileRefExists === false ? (
            <>
              <i
                className="codicon codicon-warning"
                style={{ fontSize: "11px" }}
              />
              <span>
                File not found — will be sent as literal text at execution
              </span>
            </>
          ) : (
            <>
              <i
                className="codicon codicon-file"
                style={{ fontSize: "11px" }}
              />
              <span>
                File reference — prompt will be read from this path at execution
              </span>
            </>
          )}
        </div>
      )}

      {/* Editor Footer with actions (outside wrapper, not covered by drawer) */}
      <EditorFooter
        isEditMode={isEditMode}
        isFinalStepMode={selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP}
        isPromptCompleted={isPromptCompleted}
        isPromptBeingSent={isPromptBeingSent}
        isPromptActivelyRunning={isPromptActivelyRunning}
        hasContent={
          isScriptMode
            ? scriptCommand.trim().length > 0
            : promptText.trim().length > 0
        }
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
        drawerActivePage={drawerActivePage}
        onDrawerTabChange={setDrawerActivePage}
        drawerHarnessId={drawerCurrentHarness}
        drawerTabOverrides={drawerTabOverrides}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={showDeleteModal}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title="Delete Prompt"
        message={
          selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP
            ? "Disable final step?"
            : `Are you sure you want to delete prompt ${selectionTarget.kind === FINAL_STEP_PHASES.QUEUE ? selectionTarget.index + 1 : 1}?`
        }
        detail="This action cannot be undone."
      />
    </div>
  );
};
