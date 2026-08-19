import React, {
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useEditorStore } from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useDrawerTabOverrides } from "../../hooks/useDrawerTabOverrides";
import { useCompatibilityDiagnostics } from "../../hooks/useCompatibilityDiagnostics";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
import type { HarnessId } from "../../types/messages";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { PropertiesDrawer } from "./PropertiesDrawer";
import { EditorFooter } from "./EditorFooter";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { ScriptConditionEditor } from "../shared/ScriptConditionEditor";
import type { ScriptConditionValue } from "../shared/ScriptConditionEditor";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  ACTION_TYPES,
  EDITOR_TARGET_KINDS,
  EDITOR_PLACEHOLDER_TEXT,
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  PROMPT_FILE_CONVERSION_TIMEOUT_MS,
} from "../../types/messages";
import {
  STEP_TYPES,
  PERMISSION_CAPABILITY_KEYS,
  PROMPT_INPUT_CAPABILITY_KEYS,
  USER_FEEDBACK_SEVERITY,
} from "@root/types/DashboardConstants";
import { looksLikeFilePath } from "@root/utils/promptPathUtils";
import { getDictionaryUris } from "@utils/dictionaryUris";
import { isWorkflowRunning } from "../../utils/status";
import { postWorkflowDefinitionMutation } from "../../utils/workflowMutation";
import { notifyUser } from "@utils/notifyUser";
import {
  diagnosticsForHookEvents,
  diagnosticsForMcpFiltering,
  toFieldDiagnostic,
} from "@utils/compatibilityDiagnostics";
import { FieldDiagnostic } from "../shared/FieldDiagnostic";

interface PromptEditorProps {
  /** When true, the editor is in CLI watch mode — all editing is disabled. */
  isCLIManaged?: boolean;
  /** Supplies the header action without moving its state out of the editor. */
  onPromptFileActionChange?: (action: PromptFileAction | null) => void;
}

export interface PromptFileAction {
  icon: "file-symlink-file" | "go-to-file";
  tooltip: string;
  disabled: boolean;
  onClick: () => void;
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
  onPromptFileActionChange,
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
    stepEnabled,
    scriptCommand,
    scriptTimeout,
    scriptOnPass,
    scriptOnFail,
    scriptCompareSource,
    scriptReturns,
    scriptExecutionMode,
    setScriptCommand,
    setScriptTimeout,
    setScriptOnPass,
    setScriptOnFail,
    setScriptCompareSource,
    setScriptReturns,
    setScriptExecutionMode,
    pendingPromptEditorInserts,
    consumePromptEditorInsert,
  } = useEditorStore();

  const {
    steps: prompts,
    executionState,
    currentStep,
    finalStepStatus,
    finalStep,
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
  const handleCompatibilityReview = useCallback(
    (page: DrawerPage, focusId: string) => {
      setDrawerActivePage(page);
      window.requestAnimationFrame(() => {
        document.getElementById(focusId)?.focus();
      });
    },
    []
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
  const promptCompatibility = useCompatibilityDiagnostics({
    promptProperties: properties,
    promptTarget: selectionTarget,
  });
  const hookCompatibilityDiagnostics = diagnosticsForHookEvents(
    promptCompatibility.diagnostics
  );
  const mcpCompatibilityDiagnostics = diagnosticsForMcpFiltering(
    promptCompatibility.diagnostics
  );
  const permissionCompatibilityDiagnostics =
    promptCompatibility.diagnostics.filter(
      (diagnostic) =>
        diagnostic.capability === PERMISSION_CAPABILITY_KEYS.MODE ||
        diagnostic.capability === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS ||
        diagnostic.capability === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
    );
  const imageCompatibilityDiagnostics = promptCompatibility.diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.capability === PROMPT_INPUT_CAPABILITY_KEYS.IMAGES &&
        (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
          ? diagnostic.consumer?.kind === FINAL_STEP_PHASES.QUEUE &&
            diagnostic.consumer.stepIndex === selectionTarget.index
          : diagnostic.consumer?.kind === FINAL_STEP_PHASES.FINAL_STEP)
    )
    .map((diagnostic) => toFieldDiagnostic(diagnostic));

  const drawerTabOverrides = useDrawerTabOverrides(
    workflowProperties,
    globalSettings,
    properties,
    permissionCompatibilityDiagnostics.length > 0,
    hookCompatibilityDiagnostics.length > 0,
    mcpCompatibilityDiagnostics.length > 0
  );

  const vscode = getVsCodeApi();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validationSeqRef = useRef(0);
  const validationTargetRef = useRef("");
  const conversionSeqRef = useRef(0);
  const conversionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  // Delete confirmation modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [fileRefValidation, setFileRefValidation] = useState<{
    target: string;
    exists: boolean;
    isEmpty: boolean;
    resolvedPath?: string;
  } | null>(null);
  const [fileRefValidationPending, setFileRefValidationPending] =
    useState(false);
  const [isPromptFileConversionBusy, setIsPromptFileConversionBusy] =
    useState(false);

  const isEditMode = selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT;
  const isFinalStep = selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP;
  const isScriptMode = stepType === STEP_TYPES.SCRIPT;
  const isFileRef = looksLikeFilePath(promptText.trim(), {
    allowWorkspaceFolderPrefix: globalSettings.isMultiRoot,
  });

  // Number of steps that precede this prompt — used by the prior-context linter.
  // QUEUE(index): steps 0..index-1 are prior; NEW_PROMPT / FINAL_STEP: all queue steps are prior.
  const stepCount =
    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
      ? selectionTarget.index
      : prompts.length;
  const hasFinalStep = finalStep !== null;
  const effectivePreCondition =
    properties.preCondition !== undefined
      ? properties.preCondition
      : workflowProperties.preCondition !== undefined
        ? workflowProperties.preCondition
        : globalSettings.defaultPreCondition;
  const hasPreCondition = effectivePreCondition != null;
  const isRunning = isWorkflowRunning(executionState);
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
  const isPromptExecutionLocked =
    isPromptBeingSent || (isRunning && !isPromptCompleted);
  const pendingPromptEditorInsert = pendingPromptEditorInserts[0] ?? null;

  const { affUri, dicUri } = getDictionaryUris();

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

      // Execution mode — undefined inherits from the workflow/global setting.
      if (properties.executionMode !== undefined) {
        result.executionMode = properties.executionMode;
      } else if (includeNullsForDefaults) {
        clearProperties.push("executionMode");
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

      // Error Behavior:
      //   object → specific harness failure policy
      //   key in clearProperties → inherit from workflow/settings
      if (properties.errorBehavior !== undefined) {
        result.errorBehavior = properties.errorBehavior;
      } else if (includeNullsForDefaults) {
        clearProperties.push("errorBehavior");
      }

      // Pre-Condition — three-state:
      //   object  → specific pre-condition
      //   null    → explicitly none (overrides inherited)
      //   key in clearProperties → inherit from workflow/settings
      if (properties.preCondition !== undefined) {
        result.preCondition = properties.preCondition;
      } else if (includeNullsForDefaults) {
        clearProperties.push("preCondition");
      }

      // Tool Permissions — three-state:
      //   null   → "explicitly none" (inject no permission flags for this prompt)
      //   object → permission override (mode, allowedTools, deniedTools)
      //   key in clearProperties → "Default / inherit" (key removed from PromptStep)
      if (properties.toolPermissions === null) {
        result.toolPermissions = null;
      } else if (properties.toolPermissions !== undefined) {
        result.toolPermissions = properties.toolPermissions;
      } else if (includeNullsForDefaults) {
        clearProperties.push("toolPermissions");
      }

      if (!stepEnabled) {
        result.enabled = false;
      } else if (includeNullsForDefaults) {
        clearProperties.push("enabled");
      }

      return { properties: result, clearProperties };
    },
    [properties, stepEnabled]
  );

  const validateFileRef = useCallback(
    (target: string) => {
      const seq = ++validationSeqRef.current;
      setFileRefValidationPending(true);
      vscode.postMessage({
        type: MESSAGE_TYPES.VALIDATE_FILE_REF,
        filePath: target,
        seq,
      });
    },
    [vscode]
  );

  // Validate file-ref paths after editing, then keep missing/empty targets
  // fresh while the user edits the opened file.
  useEffect(() => {
    const target = promptText.trim();
    validationTargetRef.current = isFileRef ? target : "";
    validationSeqRef.current += 1; // expire replies for the previous target

    if (validateTimeoutRef.current) {
      clearTimeout(validateTimeoutRef.current);
      validateTimeoutRef.current = null;
    }

    if (!isFileRef) {
      setFileRefValidation(null);
      setFileRefValidationPending(false);
      return;
    }

    setFileRefValidation(null);
    setFileRefValidationPending(true);
    validateTimeoutRef.current = setTimeout(() => {
      validateFileRef(target);
    }, 400);

    return () => {
      if (validateTimeoutRef.current) {
        clearTimeout(validateTimeoutRef.current);
        validateTimeoutRef.current = null;
      }
    };
  }, [isFileRef, promptText, validateFileRef]);

  // Listen for addressed FILE_REF_VALIDATION responses. A response is valid
  // only for the latest request and the current editor target.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== MESSAGE_TYPES.FILE_REF_VALIDATION) return;
      if (
        message.seq !== validationSeqRef.current ||
        message.filePath?.trim() !== validationTargetRef.current
      ) {
        return;
      }

      setFileRefValidationPending(false);
      setFileRefValidation({
        target: validationTargetRef.current,
        exists: message.exists === true,
        isEmpty: message.isEmpty === true,
        resolvedPath:
          typeof message.resolvedPath === "string"
            ? message.resolvedPath
            : undefined,
      });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const revalidateMissingOrEmptyFileRef = useCallback(() => {
    if (
      !isFileRef ||
      fileRefValidationPending ||
      !fileRefValidation ||
      (fileRefValidation.exists && !fileRefValidation.isEmpty)
    ) {
      return;
    }
    const target = promptText.trim();
    if (target === validationTargetRef.current) {
      validateFileRef(target);
    }
  }, [
    fileRefValidation,
    fileRefValidationPending,
    isFileRef,
    promptText,
    validateFileRef,
  ]);

  useEffect(() => {
    if (
      !isFileRef ||
      fileRefValidationPending ||
      !fileRefValidation ||
      (fileRefValidation.exists && !fileRefValidation.isEmpty)
    ) {
      return;
    }

    const pollId = setInterval(revalidateMissingOrEmptyFileRef, 3_000);
    window.addEventListener("focus", revalidateMissingOrEmptyFileRef);
    return () => {
      clearInterval(pollId);
      window.removeEventListener("focus", revalidateMissingOrEmptyFileRef);
    };
  }, [
    fileRefValidation,
    fileRefValidationPending,
    isFileRef,
    revalidateMissingOrEmptyFileRef,
  ]);

  const persistPromptFileReference = useCallback(
    (reference: string) => {
      if (selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT) return;

      const { properties: propertyValues, clearProperties } =
        getPropertyValues(true);
      if (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_PROMPT,
          index: selectionTarget.index,
          text: reference,
          properties: propertyValues,
          clearProperties,
          promptName: promptName.trim(),
          ...(isPromptCompleted && { rewindCompletedStep: true }),
        });
      } else if (selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
          finalStep: {
            ...propertyValues,
            ...(promptName.trim() ? { name: promptName.trim() } : {}),
            prompt: reference,
          },
          clearProperties,
        });
      }
    },
    [getPropertyValues, isPromptCompleted, promptName, selectionTarget, vscode]
  );

  const openPromptFile = useCallback(() => {
    if (
      !isFileRef ||
      fileRefValidationPending ||
      !fileRefValidation?.exists ||
      !fileRefValidation.resolvedPath
    ) {
      return;
    }
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_PROMPT_FILE,
      path: fileRefValidation.resolvedPath,
    });
  }, [fileRefValidation, fileRefValidationPending, isFileRef, vscode]);

  const convertPromptToFile = useCallback(() => {
    if (
      isScriptMode ||
      isFileRef ||
      isCLIManaged ||
      isPromptExecutionLocked ||
      isPromptFileConversionBusy
    ) {
      return;
    }

    const seq = ++conversionSeqRef.current;
    setIsPromptFileConversionBusy(true);
    if (conversionTimeoutRef.current) {
      clearTimeout(conversionTimeoutRef.current);
    }
    conversionTimeoutRef.current = setTimeout(() => {
      if (conversionSeqRef.current !== seq) return;
      conversionSeqRef.current = 0;
      conversionTimeoutRef.current = null;
      setIsPromptFileConversionBusy(false);
      notifyUser(
        "Timed out converting prompt to a file",
        USER_FEEDBACK_SEVERITY.ERROR
      );
    }, PROMPT_FILE_CONVERSION_TIMEOUT_MS);

    vscode.postMessage({
      type: MESSAGE_TYPES.CONVERT_PROMPT_TO_FILE,
      seq,
      text: promptText,
      ...(promptName.trim() ? { suggestedName: promptName.trim() } : {}),
    });
  }, [
    isCLIManaged,
    isFileRef,
    isPromptExecutionLocked,
    isPromptFileConversionBusy,
    isScriptMode,
    promptName,
    promptText,
    vscode,
  ]);

  // Reconcile conversion replies only with the request that is still active.
  // The editor is deliberately unchanged until a successful reply arrives.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== MESSAGE_TYPES.PROMPT_FILE_CREATED) return;
      if (!message.seq || message.seq !== conversionSeqRef.current) return;

      if (conversionTimeoutRef.current) {
        clearTimeout(conversionTimeoutRef.current);
        conversionTimeoutRef.current = null;
      }
      conversionSeqRef.current = 0;
      setIsPromptFileConversionBusy(false);

      if (typeof message.error === "string" || !message.reference) {
        notifyUser(
          message.error || "Failed to convert prompt to a file",
          USER_FEEDBACK_SEVERITY.ERROR
        );
        return;
      }
      if (typeof message.resolvedPath !== "string") {
        notifyUser(
          "Prompt file conversion returned no resolved path",
          USER_FEEDBACK_SEVERITY.ERROR
        );
        return;
      }

      setPromptText(message.reference);
      persistPromptFileReference(message.reference);
      vscode.postMessage({
        type: MESSAGE_TYPES.OPEN_PROMPT_FILE,
        path: message.resolvedPath,
      });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [persistPromptFileReference, setPromptText, vscode]);

  useEffect(() => {
    return () => {
      conversionSeqRef.current = 0;
      if (conversionTimeoutRef.current) {
        clearTimeout(conversionTimeoutRef.current);
      }
    };
  }, []);

  const promptFileAction = useMemo<PromptFileAction | null>(() => {
    if (isScriptMode) return null;
    if (isFileRef) {
      return {
        icon: "go-to-file",
        tooltip: "Open prompt file",
        disabled:
          fileRefValidationPending !== false ||
          !fileRefValidation?.exists ||
          !fileRefValidation.resolvedPath ||
          isPromptExecutionLocked,
        onClick: openPromptFile,
      };
    }
    return {
      icon: "file-symlink-file",
      tooltip:
        promptText.trim().length > 0
          ? "Convert to prompt file"
          : "Write this prompt in a file",
      disabled: isPromptExecutionLocked || isPromptFileConversionBusy,
      onClick: convertPromptToFile,
    };
  }, [
    convertPromptToFile,
    fileRefValidation,
    fileRefValidationPending,
    isFileRef,
    isPromptExecutionLocked,
    isPromptFileConversionBusy,
    isScriptMode,
    openPromptFile,
    promptText,
  ]);

  useEffect(() => {
    onPromptFileActionChange?.(promptFileAction);
    return () => onPromptFileActionChange?.(null);
  }, [onPromptFileActionChange, promptFileAction]);

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
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.EXECUTE_PROMPT,
          text: command,
          properties: {
            type: STEP_TYPES.SCRIPT,
            ...(scriptTimeout !== undefined && { timeout: scriptTimeout }),
            ...(scriptOnPass !== CONDITION_ACTIONS.CONTINUE && {
              onPass: scriptOnPass,
            }),
            ...(scriptOnFail !== CONDITION_ACTIONS.STOP_WORKFLOW && {
              onFail: scriptOnFail,
            }),
            ...(scriptCompareSource !== COMPARE_SOURCES.AUTO && {
              compareSource: scriptCompareSource,
            }),
            ...(scriptReturns && { returns: scriptReturns }),
            ...(scriptExecutionMode !== undefined && {
              executionMode: scriptExecutionMode,
            }),
            ...(!stepEnabled && { enabled: false }),
          },
          action: finalAction,
          promptName: promptName.trim(),
          // The backend option is real (it clears the current workflow before
          // starting this submission), but no editor affordance currently sends
          // true. Keep the intentional default until that destructive action
          // gets a deliberate, tested UI design.
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

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.EXECUTE_PROMPT,
        text,
        properties: propertyValues,
        action: finalAction,
        promptName: promptName.trim(),
        // The backend option is real (it clears the current workflow before
        // starting this submission), but no editor affordance currently sends
        // true. Keep the intentional default until that destructive action
        // gets a deliberate, tested UI design.
        forceNewWorkflow: false,
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
      scriptExecutionMode,
      stepEnabled,
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
        ...(scriptCompareSource !== "auto" && {
          compareSource: scriptCompareSource,
        }),
        ...(scriptReturns && { returns: scriptReturns }),
        ...(scriptExecutionMode !== undefined && {
          executionMode: scriptExecutionMode,
        }),
        ...(!stepEnabled && { enabled: false }),
      };
      const clearProperties = stepEnabled ? ["enabled"] : undefined;

      if (selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_PROMPT,
          index: selectionTarget.index,
          text: command,
          properties: scriptProperties,
          clearProperties,
          promptName: promptName.trim(),
          ...(isPromptCompleted && { rewindCompletedStep: true }),
        });
      } else if (selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
          finalStep: {
            type: STEP_TYPES.SCRIPT,
            script: command,
            ...(promptName.trim() ? { name: promptName.trim() } : {}),
            ...(scriptTimeout !== undefined && { timeout: scriptTimeout }),
            ...(scriptOnPass !== CONDITION_ACTIONS.CONTINUE && {
              onPass: scriptOnPass,
            }),
            ...(scriptOnFail !== CONDITION_ACTIONS.STOP_WORKFLOW && {
              onFail: scriptOnFail,
            }),
            ...(scriptCompareSource !== COMPARE_SOURCES.AUTO && {
              compareSource: scriptCompareSource,
            }),
            ...(scriptReturns && { returns: scriptReturns }),
            ...(scriptExecutionMode !== undefined && {
              executionMode: scriptExecutionMode,
            }),
            ...(!stepEnabled && { enabled: false }),
          },
          clearProperties,
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
      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_PROMPT,
        index: selectionTarget.index,
        text,
        properties: propertyValues,
        clearProperties,
        promptName: promptName.trim(),
        ...(isPromptCompleted && { rewindCompletedStep: true }),
      });
    } else if (selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      postWorkflowDefinitionMutation(vscode, {
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
    scriptExecutionMode,
    stepEnabled,
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
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.DELETE_PROMPT,
          index: selectionTarget.index,
        });
      } else {
        postWorkflowDefinitionMutation(vscode, {
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
      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.DELETE_PROMPT,
        index: selectionTarget.index,
      });
    } else {
      postWorkflowDefinitionMutation(vscode, {
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

  // Sync ScriptConditionEditor value to individual script store fields
  const handleScriptChange = useCallback(
    (updated: ScriptConditionValue) => {
      setScriptCommand(updated.script ?? "");
      setScriptTimeout(updated.timeout);
      setScriptOnPass(updated.onPass ?? CONDITION_ACTIONS.CONTINUE);
      setScriptOnFail(updated.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW);
      setScriptCompareSource(updated.compareSource ?? COMPARE_SOURCES.AUTO);
      setScriptReturns(updated.returns ?? "");
      setScriptExecutionMode(updated.executionMode);
    },
    [
      setScriptCommand,
      setScriptTimeout,
      setScriptOnPass,
      setScriptOnFail,
      setScriptCompareSource,
      setScriptReturns,
      setScriptExecutionMode,
    ]
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
      case EXECUTION_STATES.PAUSING:
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
      className="prompt-editor flex flex-col flex-1 min-h-0 overflow-hidden"
    >
      {/* CodeMirror Editor + Properties Drawer container (prompt mode only) */}
      {!isScriptMode && (
        // overflow-clip (not overflow-hidden): PropertiesDrawer's closed-state
        // `translateY` pushes its transformed box below this wrapper's own
        // bounds, which — per the CSS scrollable-overflow spec — still counts
        // toward this element's scrollable overflow even though it's clipped
        // from view. `overflow: hidden` clips the paint but still permits a
        // program/browser to set `scrollTop` into that hidden region (exactly
        // like the iOS `overflow: hidden` scrollTop quirk handled in App.tsx);
        // dragging a text selection near/past the bottom edge triggers
        // Chromium's native "auto-scroll the nearest scrollable ancestor to
        // reveal the selection focus" behavior, which scrolls this wrapper
        // into that hidden region and un-clips the drawer mid-drag. `clip`
        // disables scrolling (including programmatic) entirely, so there is no
        // scroll position left for that behavior to move into.
        <div className="prompt-editor-wrapper flex flex-col flex-1 min-h-0 overflow-clip relative isolate">
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
            stepCount={stepCount}
            hasFinalStep={hasFinalStep}
            hasPreCondition={hasPreCondition}
            pendingInsertRequest={pendingPromptEditorInsert}
            onInsertApplied={consumePromptEditorInsert}
          />

          {/* Properties Drawer (slides up from bottom, overlays only editor) */}
          <PropertiesDrawer
            isOpen={propertiesDrawerOpen}
            onClose={closePropertiesDrawer}
            activePage={drawerActivePage}
            onRequestPage={handleCompatibilityReview}
            hasPreCondition={hasPreCondition}
          />
        </div>
      )}

      {/* Script step fields (script mode only) */}
      {isScriptMode && (
        <div className="flex flex-col flex-1 min-h-0 overflow-auto px-3 py-3 bg-editor-bg">
          <ScriptConditionEditor
            variant="scriptStep"
            value={{
              script: scriptCommand,
              timeout: scriptTimeout,
              onPass: scriptOnPass,
              onFail: scriptOnFail,
              compareSource: scriptCompareSource,
              returns: scriptReturns,
              executionMode: scriptExecutionMode,
            }}
            onChange={handleScriptChange}
            scriptLabel="Script command"
            disabled={isCLIManaged}
            idPrefix="script-step"
          />
        </div>
      )}

      {/* File-reference badge — shown when editor contains only a file path (prompt mode only) */}
      {!isScriptMode && isFileRef && (
        <div
          className="flex items-center gap-1 px-2 py-1 text-xs"
          style={{
            color:
              fileRefValidation?.exists && fileRefValidation.isEmpty
                ? "var(--vscode-editorWarning-foreground)"
                : fileRefValidation?.exists === false
                  ? "var(--vscode-editorWarning-foreground)"
                  : "var(--vscode-textLink-foreground)",
            backgroundColor: "var(--vscode-editor-background)",
            borderTop:
              "1px solid var(--vscode-widget-border, var(--vscode-panel-border))",
          }}
        >
          {fileRefValidation?.exists === false ? (
            <>
              <i
                className="codicon codicon-warning"
                style={{ fontSize: "11px" }}
              />
              <span>
                File not found — will be sent as literal text at execution
              </span>
            </>
          ) : fileRefValidation?.isEmpty ? (
            <>
              <i
                className="codicon codicon-warning"
                style={{ fontSize: "11px" }}
              />
              <span>Prompt file is empty</span>
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

      {!isScriptMode && (
        <FieldDiagnostic
          id="prompt-image-compatibility"
          diagnostics={imageCompatibilityDiagnostics}
          className="border-t border-[var(--vscode-widget-border,var(--vscode-panel-border))] px-2 py-1"
        />
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
