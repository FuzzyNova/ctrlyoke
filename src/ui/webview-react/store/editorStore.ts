import { create } from "zustand";
import type { VsCodeApi } from "../types/vscode";
import type { ErrorBehavior, UserHookConfig } from "@root/types/CtrlYokeTypes";
import type { PromptStep } from "./workflowStore";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type {
  PriorContext,
  ToolPermissionsOverride,
  PreCondition,
} from "../types/messages";
import type { EndConditionCompareSource } from "../utils/prompt";
import {
  FINAL_STEP_PHASES,
  EDITOR_TARGET_KINDS,
  CONDITION_ACTIONS,
  PROMPT_PROPERTIES,
} from "../types/messages";
import {
  DEFAULT_COMPARE_SOURCE,
  DEFAULT_SCRIPT_OPERATOR,
  STEP_TYPES,
  type ExecutionMode,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type {
  PromptEditorInsertRequest,
  ScriptStep,
} from "@root/types/WebviewMessageTypes";
import { useUiStore } from "./uiStore";
import { isStepContentEqual, type WorkflowStep } from "./workflowStore";
import { useWorkflowStore } from "./workflowStore";
import {
  addStepRange,
  collapseStepSelection,
  selectAllSteps,
  selectStepRange,
  toggleStepIndex,
} from "../utils/stepMultiSelection";

/** Type guard for script steps (webview-local version) */
function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

/** Property is inherited from workflow/settings when undefined. */
export type Inheritable<T> = T | undefined;

/** Property can inherit (undefined), be explicitly disabled (null), or set to a custom value. */
export type Disableable<T> = T | null | undefined;

/**
 * End condition configuration
 * All fields optional except script to match PromptStep.endCondition
 */
export interface EndConditionConfig {
  script: string;
  env?: Record<string, string>;
  returns?: string;
  compareSource?: EndConditionCompareSource;
  timeoutSec?: number;
  shell?: string;
  maxRetries?: number;
  retryPrompt?: string;
  passRetryPrompt?: string;
  resumeSessionOnRetry?: boolean;
  onPass?: string;
  onFail?: string;
}

/**
 * Property values for prompt editor controls
 * Matches PROMPT_PROPERTIES from DashboardConstants
 */
export interface PropertyValues {
  harness: Inheritable<string>; // undefined = inherit, string = harness ID
  model: Inheritable<string>; // undefined = inherit, string = model ID
  executionMode: Inheritable<ExecutionMode>; // undefined = inherit, interactive/headless = override
  color: Inheritable<string>; // undefined = inherit, six-digit hex = override
  agent: Disableable<string>; // undefined = inherit, null = none, string = agent filename slug
  skills: Disableable<string[]>; // undefined = inherit, null = none, string[] = specific (empty array allowed transiently in custom mode)
  secrets: Disableable<string[]>; // undefined = inherit, null = none, string[] = specific
  resumeSession: Inheritable<boolean>; // undefined = inherit, true = yes, false = no
  sessionId: string; // "" or session ID or prompt number reference
  mcpServers: (string | object)[] | null | undefined; // undefined = inherit, null = none, array = custom
  hooks: UserHookConfig[] | null | undefined; // undefined = inherit, null = none, array = custom
  errorBehavior?: ErrorBehavior | null;
  endCondition?: EndConditionConfig | null;
  preCondition?: PreCondition | null;
  priorContext?: PriorContext; // undefined = inherit/default
  additionalArgs: Disableable<string>; // undefined = inherit, null = none, string = custom args
  toolPermissions?: ToolPermissionsOverride | null; // undefined = inherit workflow, null = none (omit flags), object = override
}

/** Returned by bulk display selectors when selected steps have unlike values. */
export const MIXED_VALUE: unique symbol = Symbol("editor-bulk-mixed");
export type MixedValue = typeof MIXED_VALUE;
export const BULK_MIXED_OPTION = "__bulk_mixed__";

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        valuesEqual(leftRecord[key], rightRecord[key])
    )
  );
}

function originalBulkValue(
  step: WorkflowStep,
  key: keyof PropertyValues | "enabled"
): unknown {
  if (key === PROMPT_PROPERTIES.ENABLED) return step.enabled !== false;
  return step[key as keyof WorkflowStep];
}

/** Resolve the stable display value for one sparse bulk-edit field. */
export function getBulkDisplayValue<K extends keyof PropertyValues>(
  state: Pick<EditorState, "bulkPatch" | "multiSelection">,
  steps: readonly WorkflowStep[],
  key: K
): PropertyValues[K] | MixedValue;
export function getBulkDisplayValue(
  state: Pick<EditorState, "bulkPatch" | "multiSelection">,
  steps: readonly WorkflowStep[],
  key: "enabled"
): boolean | MixedValue;
export function getBulkDisplayValue(
  state: Pick<EditorState, "bulkPatch" | "multiSelection">,
  steps: readonly WorkflowStep[],
  key: keyof PropertyValues | "enabled"
): unknown {
  if (Object.prototype.hasOwnProperty.call(state.bulkPatch, key)) {
    return state.bulkPatch[key];
  }
  const indices = state.multiSelection?.indices ?? [];
  if (indices.length === 0) return MIXED_VALUE;
  const first = steps[indices[0]];
  if (!first) return MIXED_VALUE;
  const original = originalBulkValue(first, key);
  return indices.every((index) => {
    const step = steps[index];
    return (
      step !== undefined && valuesEqual(originalBulkValue(step, key), original)
    );
  })
    ? original
    : MIXED_VALUE;
}

export interface ReplyContextInput {
  properties: PropertyValues;
  sessionId: string;
  harness: HarnessId;
  sourceLabel: string;
}

interface ReplyContext {
  sessionId: string;
  harness: HarnessId;
  sourceLabel: string;
  previous: {
    properties: PropertyValues;
    stepType: typeof STEP_TYPES.PROMPT | typeof STEP_TYPES.SCRIPT;
  };
}

/**
 * Property defaults (single source of truth)
 * Mirrors PROPERTY_DEFAULTS from state-manager.js
 */
export const PROPERTY_DEFAULTS: PropertyValues = {
  harness: undefined,
  model: undefined,
  executionMode: undefined,
  color: undefined,
  agent: undefined,
  skills: undefined,
  secrets: undefined,
  resumeSession: undefined,
  sessionId: "",
  mcpServers: undefined,
  hooks: undefined,
  errorBehavior: undefined,
  endCondition: undefined, // undefined = inherit from workflow
  preCondition: undefined,
  additionalArgs: undefined,
  toolPermissions: undefined,
};

export const END_CONDITION_DEFAULTS: EndConditionConfig = {
  script: "",
  returns: "",
  maxRetries: 0,
  retryPrompt: "",
  passRetryPrompt: "",
};

function normalizePromptErrorBehavior(
  errorBehavior: ErrorBehavior | null | undefined
): ErrorBehavior | undefined {
  if (errorBehavior === null) {
    return { onError: CONDITION_ACTIONS.STOP_WORKFLOW };
  }

  return errorBehavior;
}

/**
 * Returns a stable string key for a selection target, used to index pendingEdits.
 * Only valid for edit-mode targets (queue / finalStep).
 */
function selectionTargetKey(target: EditorSelectionTarget): string {
  if (target.kind === FINAL_STEP_PHASES.QUEUE) return `queue:${target.index}`;
  if (target.kind === FINAL_STEP_PHASES.FINAL_STEP)
    return FINAL_STEP_PHASES.FINAL_STEP;
  return "";
}

export type EditorSelectionTarget =
  | { kind: typeof EDITOR_TARGET_KINDS.NEW_PROMPT }
  | { kind: typeof FINAL_STEP_PHASES.QUEUE; index: number }
  | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP };

/**
 * Editor state - Prompt editing mode and content
 */
interface EditorState {
  // Editing mode
  selectionTarget: EditorSelectionTarget;
  multiSelection: { indices: number[]; anchorIndex: number } | null;
  /** Sparse, shared edits staged while a multi-selection is active. */
  bulkPatch: Partial<PropertyValues & { enabled: boolean }>;
  /** Companion fields last written by the harness cascade, for reverting it. */
  bulkCascadeCompanions: Array<"model" | "additionalArgs">;
  selectedPromptIndex: number | null; // null = new prompt mode, number = editing existing
  originalPromptData: WorkflowStep | null; // For Cancel/revert functionality
  savedNewPromptState: SavedNewStepState | null; // Saved state when switching to edit mode
  /**
   * Local-memory cache of unsaved edits for each prompt, keyed by selectionTargetKey().
   * Populated when the user navigates away from a prompt without pressing Update.
   * Cleared when the user presses Update (via cancelEdit) or Cancel.
   */
  pendingEdits: Record<string, SavedNewStepState>;
  replyContext: ReplyContext | null;
  hasActiveQueue: boolean; // Whether a workflow is currently loaded

  // Step type — determines editor mode
  stepType: typeof STEP_TYPES.PROMPT | typeof STEP_TYPES.SCRIPT;
  stepEnabled: boolean;

  // Editor content
  promptText: string;
  promptName: string;

  // Script step content
  scriptCommand: string;
  scriptTimeoutSec: number | undefined;
  scriptOnPass: string;
  scriptOnFail: string;
  scriptCompareSource: string;
  scriptOperator: string;
  scriptExpected: string;
  scriptIgnoreCase: boolean;
  scriptEnv: Record<string, string> | undefined;
  scriptExecutionMode: ExecutionMode | undefined;
  scriptShell: string | undefined;

  // Property values
  properties: PropertyValues;

  // Editor dirty state
  isDirty: boolean;

  // Validation state
  validationErrors: Record<string, string>;
  pendingPromptEditorInserts: PromptEditorInsertRequest[];
}

/** The single source for draft capture, persistence, and restoration. */
const NEW_STEP_DRAFT_FIELDS = [
  "promptText",
  "promptName",
  "stepEnabled",
  "properties",
  "replyContext",
  "stepType",
  "scriptCommand",
  "scriptTimeoutSec",
  "scriptOnPass",
  "scriptOnFail",
  "scriptCompareSource",
  "scriptOperator",
  "scriptExpected",
  "scriptIgnoreCase",
  "scriptEnv",
  "scriptExecutionMode",
  "scriptShell",
] as const satisfies readonly (keyof EditorState)[];

type NewStepDraftField = (typeof NEW_STEP_DRAFT_FIELDS)[number];
type NewStepDraftFields = Pick<EditorState, NewStepDraftField>;

/** Saved new-step state for edit-mode switching and VS Code persistence. */
export type SavedNewStepState = NewStepDraftFields;

/** @deprecated Use SavedNewStepState */
export type SavedNewPromptState = SavedNewStepState;

function captureNewStepDraft(state: EditorState): SavedNewStepState {
  return Object.fromEntries(
    NEW_STEP_DRAFT_FIELDS.map((field) => [field, state[field]])
  ) as SavedNewStepState;
}

function restoreNewStepDraft(
  saved: Partial<SavedNewStepState>
): NewStepDraftFields {
  const restored = Object.fromEntries(
    NEW_STEP_DRAFT_FIELDS.map((field) => [
      field,
      saved[field] ?? initialState[field],
    ])
  );
  return {
    ...restored,
    properties: { ...PROPERTY_DEFAULTS, ...saved.properties },
  } as NewStepDraftFields;
}

function isNewStepDraftDirty(draft: SavedNewStepState): boolean {
  return (
    draft.promptText.length > 0 ||
    draft.scriptCommand.length > 0 ||
    draft.replyContext !== null
  );
}

/** Drop the reply context once the draft no longer resumes that session. */
function replyContextAfterPropertyChange(
  replyContext: ReplyContext | null,
  properties: PropertyValues
): ReplyContext | null {
  return replyContext &&
    properties.harness === replyContext.harness &&
    properties.sessionId === replyContext.sessionId &&
    properties.resumeSession === true
    ? replyContext
    : null;
}

function expandPromptEditorIfCollapsed(): void {
  const uiState = useUiStore.getState();
  if (uiState.editorCollapsed) uiState.setEditorCollapsed(false);
}

/**
 * Editor actions
 */
interface EditorActions {
  // Mode switching
  selectPrompt: (
    target: number | null | EditorSelectionTarget,
    promptData?: WorkflowStep | null
  ) => void;
  selectFinalStep: (promptData: WorkflowStep) => void;
  enterNewPromptMode: () => void;
  startReplyToStep: (reply: ReplyContextInput) => void;
  cancelReplyToStep: () => void;
  enterEditMode: (index: number, promptData: WorkflowStep) => void;
  cancelEdit: () => void;
  /**
   * Saves current edit state to pendingEdits and returns to new prompt mode.
   * Unlike cancelEdit, this preserves unsaved changes so the user can return
   * to the prompt and continue editing.
   */
  deselect: () => void;
  extendMultiSelectionByRange: (index: number) => void;
  toggleMultiSelection: (index: number) => void;
  addMultiSelectionRange: (index: number) => void;
  selectAllSteps: () => void;
  clearMultiSelection: () => void;

  // Step type
  setStepType: (
    type: typeof STEP_TYPES.PROMPT | typeof STEP_TYPES.SCRIPT
  ) => void;
  setStepEnabled: (enabled: boolean) => void;
  setScriptCommand: (command: string) => void;
  setScriptTimeoutSec: (timeoutSec: number | undefined) => void;
  setScriptOnPass: (value: string) => void;
  setScriptOnFail: (value: string) => void;
  setScriptCompareSource: (value: string) => void;
  setScriptOperator: (value: string) => void;
  setScriptExpected: (value: string) => void;
  setScriptIgnoreCase: (value: boolean) => void;
  setScriptEnv: (value: Record<string, string> | undefined) => void;
  setScriptExecutionMode: (value: ExecutionMode | undefined) => void;
  setScriptShell: (value: string | undefined) => void;

  // Content updates
  setPromptText: (text: string) => void;
  setPromptName: (name: string) => void;

  // Property updates
  setProperty: <K extends keyof PropertyValues>(
    key: K,
    value: PropertyValues[K]
  ) => void;
  setProperties: (properties: Partial<PropertyValues>) => void;
  setHarnessCascade: (properties: Partial<PropertyValues>) => void;
  clearBulkCascadeCompanions: () => void;
  clearBulkPatchField: (key: keyof PropertyValues | "enabled") => void;
  resetProperties: () => void;

  // End condition management
  setEndCondition: (endCondition: EndConditionConfig | null) => void;
  updateEndConditionField: <K extends keyof EndConditionConfig>(
    field: K,
    value: EndConditionConfig[K]
  ) => void;
  clearEndCondition: () => void;

  // Queue state
  setHasActiveQueue: (hasQueue: boolean) => void;
  preparePromptEditorForInsert: () => void;
  enqueuePromptEditorInsert: (request: PromptEditorInsertRequest) => void;
  consumePromptEditorInsert: (requestId: string) => void;

  // Pending edit cache
  clearAllPendingEdits: () => void;
  /** Remap active editor targets and cached drafts after the queue topology changes. */
  remapStepTargets: (
    previousSteps: WorkflowStep[],
    nextSteps: WorkflowStep[]
  ) => void;

  // Dirty state
  setDirty: (dirty: boolean) => void;
  markClean: () => void;

  // Validation
  setValidationError: (field: string, error: string) => void;
  clearValidationError: (field: string) => void;
  clearAllValidationErrors: () => void;
  validateRequired: () => boolean;

  // State persistence (VS Code webview state)
  saveToVsCodeState: (vscode: VsCodeApi) => void;
  restoreFromVsCodeState: (vscode: VsCodeApi) => boolean;

  // Reset
  resetEditor: () => void;
  resetToDefaults: () => void;
}

/**
 * Editor computed selectors
 */
interface EditorSelectors {
  // Check if in new prompt mode
  isNewPromptMode: () => boolean;
  // Check if in edit mode
  isEditMode: () => boolean;
  isFinalStepMode: () => boolean;
  // Get current property values as PromptStep properties
  getPromptProperties: () => Partial<PromptStep>;
  // Check if editor has content
  hasContent: () => boolean;
  // Check if end condition is configured
  hasEndCondition: () => boolean;
}

const initialState: EditorState = {
  selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
  multiSelection: null,
  bulkPatch: {},
  bulkCascadeCompanions: [],
  selectedPromptIndex: null,
  originalPromptData: null,
  savedNewPromptState: null,
  pendingEdits: {},
  replyContext: null,
  hasActiveQueue: false,
  stepType: STEP_TYPES.PROMPT,
  stepEnabled: true,
  promptText: "",
  promptName: "",
  scriptCommand: "",
  scriptTimeoutSec: undefined,
  scriptOnPass: CONDITION_ACTIONS.CONTINUE,
  scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
  scriptCompareSource: DEFAULT_COMPARE_SOURCE,
  scriptOperator: DEFAULT_SCRIPT_OPERATOR,
  scriptExpected: "",
  scriptIgnoreCase: false,
  scriptEnv: undefined,
  scriptExecutionMode: undefined,
  scriptShell: undefined,
  properties: { ...PROPERTY_DEFAULTS },
  isDirty: false,
  validationErrors: {},
  pendingPromptEditorInserts: [],
};

export const useEditorStore = create<
  EditorState & EditorActions & EditorSelectors
>((set, get) => ({
  ...initialState,

  // ============================================================================
  // MODE SWITCHING
  // ============================================================================

  selectPrompt: (target, promptData = null) => {
    if (
      typeof target === "object" &&
      target?.kind === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      if (promptData) {
        get().enterEditMode(-1, promptData);
      }
      return;
    }

    const resolvedIndex =
      typeof target === "number"
        ? target
        : typeof target === "object" && target?.kind === FINAL_STEP_PHASES.QUEUE
          ? target.index
          : null;

    if (resolvedIndex === null) {
      // Switching to new prompt mode
      get().enterNewPromptMode();
    } else {
      // Switching to edit mode
      if (promptData) {
        // Call enterEditMode to properly load prompt data into editor
        get().enterEditMode(resolvedIndex, promptData);
      } else {
        // Fallback if promptData not provided (shouldn't happen)
        set({
          multiSelection: null,
          bulkPatch: {},
          bulkCascadeCompanions: [],
          selectionTarget: {
            kind: FINAL_STEP_PHASES.QUEUE,
            index: resolvedIndex,
          },
          selectedPromptIndex: resolvedIndex,
          originalPromptData: promptData,
        });
      }
    }
  },

  selectFinalStep: (promptData) => {
    get().enterEditMode(-1, promptData);
  },

  enterNewPromptMode: () => {
    const { savedNewPromptState } = get();
    if (savedNewPromptState) {
      // Restore saved new prompt state (from switching to edit mode), preserving step type
      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
        selectedPromptIndex: null,
        originalPromptData: null,
        ...restoreNewStepDraft(savedNewPromptState),
        savedNewPromptState: null,
        isDirty: isNewStepDraftDirty(savedNewPromptState),
      });
    } else {
      // Try to restore from VS Code persistent state
      // Use the global vscode API instance
      const vscode = getVsCodeApi();
      const restored = get().restoreFromVsCodeState(vscode);

      if (!restored) {
        // No persisted state, reset to defaults
        set({
          multiSelection: null,
          bulkPatch: {},
          bulkCascadeCompanions: [],
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          stepType: STEP_TYPES.PROMPT,
          stepEnabled: true,
          promptText: "",
          promptName: "",
          scriptCommand: "",
          scriptTimeoutSec: undefined,
          scriptOnPass: CONDITION_ACTIONS.CONTINUE,
          scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          scriptCompareSource: DEFAULT_COMPARE_SOURCE,
          scriptOperator: DEFAULT_SCRIPT_OPERATOR,
          scriptExpected: "",
          scriptIgnoreCase: false,
          scriptEnv: undefined,
          scriptExecutionMode: undefined,
          scriptShell: undefined,
          properties: { ...PROPERTY_DEFAULTS },
          isDirty: false,
          validationErrors: {},
        });
      } else {
        // State was restored, just clear edit mode flags
        set({
          multiSelection: null,
          bulkPatch: {},
          bulkCascadeCompanions: [],
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          stepEnabled: true,
          stepType: STEP_TYPES.PROMPT,
          scriptCommand: "",
          scriptTimeoutSec: undefined,
          scriptOnPass: CONDITION_ACTIONS.CONTINUE,
          scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          scriptCompareSource: DEFAULT_COMPARE_SOURCE,
          scriptOperator: DEFAULT_SCRIPT_OPERATOR,
          scriptExpected: "",
          scriptIgnoreCase: false,
          scriptEnv: undefined,
          scriptExecutionMode: undefined,
          scriptShell: undefined,
          savedNewPromptState: null,
        });
      }
    }
  },

  startReplyToStep: (reply) => {
    if (get().selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      get().deselect();
      if (get().selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
        get().enterNewPromptMode();
      }
    }

    const state = get();
    const previous = state.replyContext?.previous ?? {
      properties: { ...state.properties },
      stepType: state.stepType,
    };
    set({
      properties: { ...reply.properties },
      stepType: STEP_TYPES.PROMPT,
      replyContext: {
        sessionId: reply.sessionId,
        harness: reply.harness,
        sourceLabel: reply.sourceLabel,
        previous,
      },
      isDirty: true,
    });
    expandPromptEditorIfCollapsed();
  },

  cancelReplyToStep: () => {
    const { replyContext } = get();
    if (!replyContext) return;
    set({
      properties: { ...replyContext.previous.properties },
      stepType: replyContext.previous.stepType,
      replyContext: null,
      isDirty: true,
    });
  },

  enterEditMode: (index, promptData) => {
    const state = get();
    const newPendingEdits = { ...state.pendingEdits };

    // When switching away from an edit-mode prompt, save its current editor
    // state so the user can return to it without losing unsaved changes.
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      const key = selectionTargetKey(state.selectionTarget);
      newPendingEdits[key] = captureNewStepDraft(state);
    }

    // Save current new-prompt state when first entering edit mode.
    // Preserve the existing savedNewPromptState when switching between edit modes
    // so the user's new-prompt draft survives multiple prompt switches.
    const savedNewPromptState: SavedNewStepState | null =
      state.selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT
        ? captureNewStepDraft(state)
        : state.savedNewPromptState;

    const isFinalStepTarget = index < 0;
    const newTarget: EditorSelectionTarget = isFinalStepTarget
      ? { kind: FINAL_STEP_PHASES.FINAL_STEP }
      : { kind: FINAL_STEP_PHASES.QUEUE, index };

    // Restore a pending (unsaved) edit if one exists for this prompt, otherwise
    // load the prompt data from the workflow.
    const pendingEdit = newPendingEdits[selectionTargetKey(newTarget)];

    if (isScriptStep(promptData)) {
      // Script step: populate scriptCommand, set stepType to script (unless pending edit overrides)
      const propertiesFromScriptData: PropertyValues = {
        ...PROPERTY_DEFAULTS,
        color: promptData.color,
        secrets: promptData.secrets,
        errorBehavior: normalizePromptErrorBehavior(promptData.errorBehavior),
      };

      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        selectionTarget: newTarget,
        selectedPromptIndex: isFinalStepTarget ? null : index,
        originalPromptData: promptData,
        savedNewPromptState,
        replyContext: null,
        stepType: pendingEdit?.stepType ?? STEP_TYPES.SCRIPT,
        stepEnabled: pendingEdit?.stepEnabled ?? promptData.enabled !== false,
        promptText: pendingEdit?.promptText ?? "",
        promptName: pendingEdit
          ? pendingEdit.promptName
          : (promptData.name ?? ""),
        scriptCommand: pendingEdit
          ? (pendingEdit.scriptCommand ?? "")
          : promptData.script,
        scriptTimeoutSec: pendingEdit
          ? pendingEdit.scriptTimeoutSec
          : promptData.timeoutSec,
        scriptOnPass: pendingEdit
          ? (pendingEdit.scriptOnPass ?? CONDITION_ACTIONS.CONTINUE)
          : (promptData.onPass ?? CONDITION_ACTIONS.CONTINUE),
        scriptOnFail: pendingEdit
          ? (pendingEdit.scriptOnFail ?? CONDITION_ACTIONS.STOP_WORKFLOW)
          : (promptData.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW),
        scriptCompareSource: pendingEdit
          ? (pendingEdit.scriptCompareSource ?? DEFAULT_COMPARE_SOURCE)
          : (promptData.compareSource ?? DEFAULT_COMPARE_SOURCE),
        scriptOperator: pendingEdit
          ? (pendingEdit.scriptOperator ?? DEFAULT_SCRIPT_OPERATOR)
          : (promptData.operator ?? DEFAULT_SCRIPT_OPERATOR),
        scriptExpected: pendingEdit
          ? (pendingEdit.scriptExpected ?? "")
          : String(promptData.expected ?? ""),
        scriptIgnoreCase: pendingEdit
          ? (pendingEdit.scriptIgnoreCase ?? false)
          : (promptData.ignoreCase ?? false),
        scriptEnv: pendingEdit ? pendingEdit.scriptEnv : promptData.env,
        scriptExecutionMode: pendingEdit
          ? pendingEdit.scriptExecutionMode
          : promptData.executionMode,
        scriptShell: pendingEdit ? pendingEdit.scriptShell : promptData.shell,
        properties: pendingEdit
          ? pendingEdit.properties
          : propertiesFromScriptData,
        isDirty: pendingEdit ? true : false,
        validationErrors: {},
        pendingEdits: newPendingEdits,
      });
      // Close PropertiesDrawer when entering script step edit mode (unless pending edit had prompt mode open)
      if (!pendingEdit || pendingEdit.stepType === STEP_TYPES.SCRIPT) {
        useUiStore.getState().closePropertiesDrawer();
      }
    } else {
      // Prompt step: populate promptText, clear scriptCommand/script properties, set stepType to prompt
      const propertiesFromData: PropertyValues = {
        harness: promptData.harness,
        model: promptData.model,
        executionMode: promptData.executionMode,
        color: promptData.color,
        agent: promptData.agent,
        skills: promptData.skills,
        secrets: promptData.secrets,
        resumeSession: promptData.resumeSession,
        sessionId:
          promptData.sessionId !== undefined
            ? String(promptData.sessionId)
            : "",
        mcpServers: promptData.mcpServers,
        hooks: promptData.hooks,
        errorBehavior: normalizePromptErrorBehavior(promptData.errorBehavior),
        endCondition: promptData.endCondition,
        preCondition: promptData.preCondition,
        priorContext: promptData.priorContext,
        additionalArgs: promptData.additionalArgs,
        toolPermissions: promptData.toolPermissions,
      };

      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        selectionTarget: newTarget,
        selectedPromptIndex: isFinalStepTarget ? null : index,
        originalPromptData: promptData,
        savedNewPromptState,
        replyContext: null,
        stepType: pendingEdit?.stepType ?? STEP_TYPES.PROMPT,
        stepEnabled: pendingEdit?.stepEnabled ?? promptData.enabled !== false,
        promptText: pendingEdit ? pendingEdit.promptText : promptData.prompt,
        promptName: pendingEdit
          ? pendingEdit.promptName
          : (promptData.name ?? ""),
        scriptCommand: pendingEdit?.scriptCommand ?? "",
        scriptTimeoutSec: pendingEdit?.scriptTimeoutSec,
        scriptOnPass: pendingEdit?.scriptOnPass ?? CONDITION_ACTIONS.CONTINUE,
        scriptOnFail:
          pendingEdit?.scriptOnFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
        scriptCompareSource:
          pendingEdit?.scriptCompareSource ?? DEFAULT_COMPARE_SOURCE,
        scriptOperator: pendingEdit?.scriptOperator ?? DEFAULT_SCRIPT_OPERATOR,
        scriptExpected: pendingEdit?.scriptExpected ?? "",
        scriptIgnoreCase: pendingEdit?.scriptIgnoreCase ?? false,
        scriptEnv: pendingEdit?.scriptEnv,
        scriptExecutionMode: pendingEdit?.scriptExecutionMode,
        scriptShell: pendingEdit?.scriptShell,
        properties: pendingEdit ? pendingEdit.properties : propertiesFromData,
        isDirty: pendingEdit ? true : false,
        validationErrors: {},
        pendingEdits: newPendingEdits,
      });
    }
  },

  cancelEdit: () => {
    const state = get();
    const { savedNewPromptState } = state;

    // Clear the pending edit for the prompt we're leaving — the user either
    // pressed Update (official save) or Cancel (discard), so local memory
    // for this prompt is no longer needed.
    const newPendingEdits = { ...state.pendingEdits };
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      delete newPendingEdits[selectionTargetKey(state.selectionTarget)];
    }

    if (savedNewPromptState) {
      // Restore saved new prompt state (what was typed before switching to edit mode), preserving step type
      set({
        selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
        selectedPromptIndex: null,
        originalPromptData: null,
        ...restoreNewStepDraft(savedNewPromptState),
        savedNewPromptState: null,
        isDirty: isNewStepDraftDirty(savedNewPromptState),
        validationErrors: {},
        pendingEdits: newPendingEdits,
      });
    } else {
      // Try to restore from VS Code persistent state
      // Use the global vscode API instance
      const vscode = getVsCodeApi();
      const restored = get().restoreFromVsCodeState(vscode);

      if (!restored) {
        // No persisted state, reset to defaults
        set({
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          stepType: STEP_TYPES.PROMPT,
          stepEnabled: true,
          promptText: "",
          promptName: "",
          scriptCommand: "",
          scriptTimeoutSec: undefined,
          scriptOnPass: CONDITION_ACTIONS.CONTINUE,
          scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          scriptCompareSource: DEFAULT_COMPARE_SOURCE,
          scriptOperator: DEFAULT_SCRIPT_OPERATOR,
          scriptExpected: "",
          scriptIgnoreCase: false,
          scriptEnv: undefined,
          scriptExecutionMode: undefined,
          scriptShell: undefined,
          properties: { ...PROPERTY_DEFAULTS },
          isDirty: false,
          validationErrors: {},
          pendingEdits: newPendingEdits,
        });
      } else {
        // State was restored, just clear edit mode flags and validation errors
        set({
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          savedNewPromptState: null,
          validationErrors: {},
          pendingEdits: newPendingEdits,
        });
      }
    }
  },

  deselect: () => {
    const state = get();
    if (state.selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT) return;

    // Save current edit state into pendingEdits so the user can return later.
    const newPendingEdits = { ...state.pendingEdits };
    const key = selectionTargetKey(state.selectionTarget);
    newPendingEdits[key] = captureNewStepDraft(state);

    const { savedNewPromptState } = state;
    if (savedNewPromptState) {
      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
        selectedPromptIndex: null,
        originalPromptData: null,
        ...restoreNewStepDraft(savedNewPromptState),
        savedNewPromptState: null,
        isDirty: isNewStepDraftDirty(savedNewPromptState),
        validationErrors: {},
        pendingEdits: newPendingEdits,
      });
    } else {
      const vscode = getVsCodeApi();
      const restored = get().restoreFromVsCodeState(vscode);
      if (!restored) {
        set({
          multiSelection: null,
          bulkPatch: {},
          bulkCascadeCompanions: [],
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          stepType: STEP_TYPES.PROMPT,
          stepEnabled: true,
          promptText: "",
          promptName: "",
          scriptCommand: "",
          scriptTimeoutSec: undefined,
          scriptOnPass: CONDITION_ACTIONS.CONTINUE,
          scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          scriptCompareSource: DEFAULT_COMPARE_SOURCE,
          scriptOperator: DEFAULT_SCRIPT_OPERATOR,
          scriptExpected: "",
          scriptIgnoreCase: false,
          scriptEnv: undefined,
          scriptExecutionMode: undefined,
          scriptShell: undefined,
          properties: { ...PROPERTY_DEFAULTS },
          isDirty: false,
          validationErrors: {},
          pendingEdits: newPendingEdits,
        });
      } else {
        set({
          multiSelection: null,
          bulkPatch: {},
          bulkCascadeCompanions: [],
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          stepType: STEP_TYPES.PROMPT,
          stepEnabled: true,
          scriptCommand: "",
          scriptTimeoutSec: undefined,
          scriptOnPass: CONDITION_ACTIONS.CONTINUE,
          scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          scriptCompareSource: DEFAULT_COMPARE_SOURCE,
          scriptOperator: DEFAULT_SCRIPT_OPERATOR,
          scriptExpected: "",
          scriptIgnoreCase: false,
          scriptEnv: undefined,
          scriptExecutionMode: undefined,
          scriptShell: undefined,
          savedNewPromptState: null,
          validationErrors: {},
          pendingEdits: newPendingEdits,
        });
      }
    }
  },

  extendMultiSelectionByRange: (index) => {
    const state = get();
    const queueLength = useWorkflowStore.getState().steps.length;
    const selectedIndex =
      state.multiSelection?.anchorIndex ??
      (state.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
        ? state.selectionTarget.index
        : index);
    const indices = selectStepRange(selectedIndex, index, queueLength);
    const selection = collapseStepSelection({
      indices,
      anchorIndex: selectedIndex,
    });
    if (!selection) {
      if (indices.length === 1) {
        const step = useWorkflowStore.getState().steps[indices[0]];
        if (step) get().selectPrompt(indices[0], step);
      }
      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        isDirty: false,
      });
      return;
    }
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      get().deselect();
    }
    set({ multiSelection: selection });
  },

  toggleMultiSelection: (index) => {
    const state = get();
    const steps = useWorkflowStore.getState().steps;
    const baseIndices =
      state.multiSelection?.indices ??
      (state.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
        ? [state.selectionTarget.index]
        : []);
    const indices = toggleStepIndex(baseIndices, index, steps.length);
    const selection = collapseStepSelection({ indices, anchorIndex: index });
    if (!selection) {
      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        isDirty: false,
      });
      if (indices.length === 1) {
        const step = steps[indices[0]];
        if (step) get().selectPrompt(indices[0], step);
      } else if (
        state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT
      ) {
        get().deselect();
      }
      return;
    }
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      get().deselect();
    }
    set({ multiSelection: selection });
  },

  addMultiSelectionRange: (index) => {
    const state = get();
    const steps = useWorkflowStore.getState().steps;
    const anchorIndex =
      state.multiSelection?.anchorIndex ??
      (state.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
        ? state.selectionTarget.index
        : index);
    const indices = addStepRange(
      state.multiSelection?.indices ??
        (state.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
          ? [state.selectionTarget.index]
          : []),
      anchorIndex,
      index,
      steps.length
    );
    const selection = collapseStepSelection({ indices, anchorIndex });
    if (!selection) {
      if (indices.length === 1) {
        const step = steps[indices[0]];
        if (step) get().selectPrompt(indices[0], step);
      }
      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        isDirty: false,
      });
      return;
    }
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      get().deselect();
    }
    set({ multiSelection: selection });
  },

  selectAllSteps: () => {
    const state = get();
    const indices = selectAllSteps(useWorkflowStore.getState().steps.length);
    const selection = collapseStepSelection({ indices, anchorIndex: 0 });
    if (!selection) {
      if (indices.length === 1) {
        const step = useWorkflowStore.getState().steps[0];
        if (step) get().selectPrompt(0, step);
      }
      set({
        multiSelection: null,
        bulkPatch: {},
        bulkCascadeCompanions: [],
        isDirty: false,
      });
      return;
    }
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      get().deselect();
    }
    set({ multiSelection: selection });
  },

  clearMultiSelection: () =>
    set((state) => ({
      multiSelection: null,
      bulkPatch: {},
      bulkCascadeCompanions: [],
      isDirty:
        state.selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT
          ? isNewStepDraftDirty(captureNewStepDraft(state))
          : state.isDirty,
    })),

  // ============================================================================
  // STEP TYPE
  // ============================================================================

  setStepType: (type) => {
    if (type === STEP_TYPES.SCRIPT) {
      // Switching to script: just flip the type flag, preserve promptText for round-trip
      set({ stepType: STEP_TYPES.SCRIPT, isDirty: true });
      useUiStore.getState().closePropertiesDrawer();
    } else {
      // Switching to prompt: just flip the type flag, preserve scriptCommand for round-trip
      set({ stepType: STEP_TYPES.PROMPT, isDirty: true });
    }
  },

  setStepEnabled: (enabled) =>
    set((state) => {
      if (state.multiSelection) {
        const steps = useWorkflowStore.getState().steps;
        const original = getBulkDisplayValue(
          { ...state, bulkPatch: {} },
          steps,
          PROMPT_PROPERTIES.ENABLED
        );
        const bulkPatch = { ...state.bulkPatch };
        if (original !== MIXED_VALUE && valuesEqual(original, enabled)) {
          delete bulkPatch.enabled;
        } else {
          bulkPatch.enabled = enabled;
        }
        return { bulkPatch, isDirty: Object.keys(bulkPatch).length > 0 };
      }
      return { stepEnabled: enabled, isDirty: true };
    }),

  setScriptCommand: (command) =>
    set({
      scriptCommand: command,
      isDirty: true,
    }),

  setScriptTimeoutSec: (timeout) =>
    set({
      scriptTimeoutSec: timeout,
      isDirty: true,
    }),

  setScriptOnPass: (value) =>
    set({
      scriptOnPass: value,
      isDirty: true,
    }),

  setScriptOnFail: (value) =>
    set({
      scriptOnFail: value,
      isDirty: true,
    }),

  setScriptCompareSource: (value) =>
    set({
      scriptCompareSource: value,
      isDirty: true,
    }),

  setScriptExpected: (value) =>
    set({
      scriptExpected: value,
      isDirty: true,
    }),

  setScriptOperator: (value) =>
    set({
      scriptOperator: value,
      isDirty: true,
    }),

  setScriptIgnoreCase: (value) =>
    set({
      scriptIgnoreCase: value,
      isDirty: true,
    }),

  setScriptEnv: (value) =>
    set({
      scriptEnv: value,
      isDirty: true,
    }),

  setScriptExecutionMode: (value) =>
    set({
      scriptExecutionMode: value,
      isDirty: true,
    }),

  setScriptShell: (value) =>
    set({
      scriptShell: value,
      isDirty: true,
    }),

  // ============================================================================
  // CONTENT UPDATES
  // ============================================================================

  setPromptText: (text) =>
    set({
      promptText: text,
      isDirty: true,
    }),

  setPromptName: (name) =>
    set({
      promptName: name,
      isDirty: true,
    }),

  // ============================================================================
  // PROPERTY UPDATES
  // ============================================================================

  setProperty: (key, value) =>
    set((state) => {
      const normalizedValue =
        key === PROMPT_PROPERTIES.ERROR_BEHAVIOR
          ? normalizePromptErrorBehavior(
              value as PropertyValues["errorBehavior"]
            )
          : value;
      if (state.multiSelection) {
        const steps = useWorkflowStore.getState().steps;
        const original = getBulkDisplayValue(
          { ...state, bulkPatch: {} },
          steps,
          key
        );
        const bulkPatch = { ...state.bulkPatch };
        let bulkCascadeCompanions = state.bulkCascadeCompanions;
        if (
          original !== MIXED_VALUE &&
          valuesEqual(original, normalizedValue)
        ) {
          delete bulkPatch[key];
          if (key === PROMPT_PROPERTIES.HARNESS) {
            bulkCascadeCompanions = bulkCascadeCompanions.filter(
              (companion) => {
                if (
                  Object.prototype.hasOwnProperty.call(bulkPatch, companion)
                ) {
                  delete bulkPatch[companion];
                }
                return false;
              }
            );
          }
        } else {
          Object.assign(bulkPatch, { [key]: normalizedValue });
          if (
            key === PROMPT_PROPERTIES.MODEL ||
            key === PROMPT_PROPERTIES.ADDITIONAL_ARGS
          ) {
            bulkCascadeCompanions = bulkCascadeCompanions.filter(
              (companion) => companion !== key
            );
          }
        }
        return {
          bulkPatch,
          bulkCascadeCompanions,
          isDirty: Object.keys(bulkPatch).length > 0,
        };
      }
      const properties: PropertyValues = {
        ...state.properties,
        [key]: normalizedValue,
      };
      return {
        properties,
        replyContext: replyContextAfterPropertyChange(
          state.replyContext,
          properties
        ),
        isDirty: true,
      };
    }),

  setProperties: (propertyUpdates) =>
    set((state) => {
      const properties = { ...state.properties, ...propertyUpdates };
      return {
        properties,
        replyContext: replyContextAfterPropertyChange(
          state.replyContext,
          properties
        ),
        isDirty: true,
      };
    }),

  setHarnessCascade: (propertyUpdates) =>
    set((state) => {
      if (!state.multiSelection) {
        const properties = { ...state.properties, ...propertyUpdates };
        return {
          properties,
          replyContext: replyContextAfterPropertyChange(
            state.replyContext,
            properties
          ),
          isDirty: true,
        };
      }
      const bulkPatch = { ...state.bulkPatch };
      const originalHarness = getBulkDisplayValue(
        { ...state, bulkPatch: {} },
        useWorkflowStore.getState().steps,
        "harness"
      );
      if (
        originalHarness !== MIXED_VALUE &&
        propertyUpdates.harness === originalHarness
      ) {
        delete bulkPatch.harness;
        for (const key of state.bulkCascadeCompanions) delete bulkPatch[key];
        return {
          bulkPatch,
          bulkCascadeCompanions: [],
          isDirty: Object.keys(bulkPatch).length > 0,
        };
      }
      Object.assign(bulkPatch, propertyUpdates);
      const companions = ["model", "additionalArgs"] as const;
      const bulkCascadeCompanions = companions.filter((key) =>
        Object.prototype.hasOwnProperty.call(propertyUpdates, key)
      );
      return {
        bulkPatch,
        bulkCascadeCompanions,
        isDirty: Object.keys(bulkPatch).length > 0,
      };
    }),

  clearBulkCascadeCompanions: () =>
    set((state) => {
      const bulkPatch = { ...state.bulkPatch };
      for (const key of state.bulkCascadeCompanions) delete bulkPatch[key];
      return {
        bulkPatch,
        bulkCascadeCompanions: [],
        isDirty: Object.keys(bulkPatch).length > 0,
      };
    }),

  clearBulkPatchField: (key) =>
    set((state) => {
      const bulkPatch = { ...state.bulkPatch };
      delete bulkPatch[key];
      let bulkCascadeCompanions = state.bulkCascadeCompanions;
      if (key === PROMPT_PROPERTIES.HARNESS) {
        for (const companion of bulkCascadeCompanions)
          delete bulkPatch[companion];
        bulkCascadeCompanions = [];
      }
      return {
        bulkPatch,
        bulkCascadeCompanions,
        isDirty: Object.keys(bulkPatch).length > 0,
      };
    }),

  resetProperties: () =>
    set((state) => {
      const properties = { ...PROPERTY_DEFAULTS };
      return {
        properties,
        replyContext: replyContextAfterPropertyChange(
          state.replyContext,
          properties
        ),
        isDirty: true,
      };
    }),

  // ============================================================================
  // END CONDITION MANAGEMENT
  // ============================================================================

  setEndCondition: (endCondition) =>
    set((state) => ({
      properties: { ...state.properties, endCondition },
      isDirty: true,
    })),

  updateEndConditionField: (field, value) =>
    set((state) => {
      const currentEndCondition = state.properties.endCondition ?? {
        ...END_CONDITION_DEFAULTS,
      };
      return {
        properties: {
          ...state.properties,
          endCondition: { ...currentEndCondition, [field]: value },
        },
        isDirty: true,
      };
    }),

  clearEndCondition: () =>
    set((state) => ({
      properties: { ...state.properties, endCondition: undefined },
      isDirty: true,
    })),

  // ============================================================================
  // QUEUE STATE
  // ============================================================================

  setHasActiveQueue: (hasQueue) => set({ hasActiveQueue: hasQueue }),

  preparePromptEditorForInsert: () => {
    // Deliberately does NOT deselect out of edit mode: CodeMirrorEditor binds
    // to promptText/pendingPromptEditorInserts regardless of whether the
    // editor is creating a new step or editing an existing one, so the
    // pending insert should land wherever the user is currently editing.
    if (get().stepType === STEP_TYPES.SCRIPT) {
      get().setStepType(STEP_TYPES.PROMPT);
    }

    // Ensure CodeMirrorEditor is mounted and can receive the pending insert.
    expandPromptEditorIfCollapsed();
  },

  enqueuePromptEditorInsert: (request) =>
    set((state) => ({
      pendingPromptEditorInserts: [
        ...state.pendingPromptEditorInserts,
        request,
      ],
    })),

  consumePromptEditorInsert: (requestId) =>
    set((state) => ({
      pendingPromptEditorInserts: state.pendingPromptEditorInserts.filter(
        (request) => request.requestId !== requestId
      ),
    })),

  // ============================================================================
  // PENDING EDIT CACHE
  // ============================================================================

  clearAllPendingEdits: () => set({ pendingEdits: {} }),

  remapStepTargets: (previousSteps, nextSteps) => {
    const state = get();
    const oldToNew = new Map<number, number>();
    const matchedNewIndexes = new Set<number>();

    // Preserve positional identity where possible, then match moved steps by
    // their authored content. This handles inserts, deletes, and reorderings
    // without relying on step indexes as identity.
    for (let index = 0; index < previousSteps.length; index++) {
      if (
        index < nextSteps.length &&
        isStepContentEqual(previousSteps[index], nextSteps[index])
      ) {
        oldToNew.set(index, index);
        matchedNewIndexes.add(index);
      }
    }
    for (let nextIndex = 0; nextIndex < nextSteps.length; nextIndex++) {
      if (matchedNewIndexes.has(nextIndex)) continue;
      let bestOldIndex: number | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let oldIndex = 0; oldIndex < previousSteps.length; oldIndex++) {
        if (oldToNew.has(oldIndex)) continue;
        if (
          !isStepContentEqual(previousSteps[oldIndex], nextSteps[nextIndex])
        ) {
          continue;
        }
        const distance = Math.abs(oldIndex - nextIndex);
        if (distance < bestDistance) {
          bestOldIndex = oldIndex;
          bestDistance = distance;
        }
      }
      if (bestOldIndex !== undefined) {
        oldToNew.set(bestOldIndex, nextIndex);
        matchedNewIndexes.add(nextIndex);
      }
    }

    // A same-length definition update can replace a step in place. Keep its
    // target at that position; count-changing unmatched positions are inserts
    // or removals and must not inherit another step's draft.
    if (previousSteps.length === nextSteps.length) {
      for (let index = 0; index < previousSteps.length; index++) {
        if (!oldToNew.has(index)) oldToNew.set(index, index);
      }
    }

    const pendingEdits: Record<string, SavedNewStepState> = {};
    for (const [key, draft] of Object.entries(state.pendingEdits)) {
      const match = /^queue:(\d+)$/.exec(key);
      if (!match) {
        pendingEdits[key] = draft;
        continue;
      }
      const nextIndex = oldToNew.get(Number(match[1]));
      if (nextIndex !== undefined) pendingEdits[`queue:${nextIndex}`] = draft;
    }

    if (state.selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE) {
      set({ pendingEdits });
      return;
    }

    const nextIndex = oldToNew.get(state.selectionTarget.index);
    if (nextIndex === undefined) {
      // The selected step was removed; cancel its edit while retaining the
      // user's saved new-step draft, just as an explicit editor cancel does.
      state.cancelEdit();
      set({ pendingEdits });
      return;
    }

    set({
      pendingEdits,
      selectionTarget: { kind: FINAL_STEP_PHASES.QUEUE, index: nextIndex },
      selectedPromptIndex: nextIndex,
      originalPromptData: nextSteps[nextIndex] ?? state.originalPromptData,
    });
  },

  // ============================================================================
  // DIRTY STATE
  // ============================================================================

  setDirty: (dirty) => set({ isDirty: dirty }),

  markClean: () => set({ isDirty: false }),

  // ============================================================================
  // VALIDATION
  // ============================================================================

  setValidationError: (field, error) =>
    set((state) => ({
      validationErrors: { ...state.validationErrors, [field]: error },
    })),

  clearValidationError: (field) =>
    set((state) => {
      const { [field]: _, ...rest } = state.validationErrors;
      return { validationErrors: rest };
    }),

  clearAllValidationErrors: () => set({ validationErrors: {} }),

  validateRequired: () => {
    const { promptText, scriptCommand, stepType } = get();
    const errors: Record<string, string> = {};

    if (stepType === STEP_TYPES.SCRIPT) {
      if (!scriptCommand.trim()) {
        errors.scriptCommand = "Script command is required";
      }
    } else {
      if (!promptText.trim()) {
        errors.promptText = "Prompt text is required";
      }
    }

    set({ validationErrors: errors });
    return Object.keys(errors).length === 0;
  },

  // ============================================================================
  // STATE PERSISTENCE (VS Code webview state)
  // ============================================================================

  saveToVsCodeState: (vscode) => {
    const state = get();

    // Only save state for new prompt mode, not when editing existing prompts
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      return;
    }

    const draft = captureNewStepDraft(state);
    const editorState = {
      ...draft,
      // Keep the legacy key for panels restored by versions that read editorText.
      editorText: draft.promptText,
      selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
      selectedPromptIndex: null, // Always null for new prompt state
    };

    // Merge under "editorState" key to coexist with other vscode state consumers
    // (e.g. uiStore's Zustand persist storage uses "ctrlyoke-ui-state" key).
    const root = vscode.getState() ?? {};
    vscode.setState({ ...root, editorState });
  },

  restoreFromVsCodeState: (vscode) => {
    const root = vscode.getState();

    if (!root) {
      return false;
    }

    // Support both namespaced (new) and legacy (root-level) formats for migration.
    const persistedState = root.editorState ?? root;

    if (!persistedState || typeof persistedState !== "object") {
      return false;
    }

    // Only restore if we were in new prompt mode
    const persistedTarget = persistedState.selectionTarget;
    if (
      (persistedTarget &&
        persistedTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) ||
      persistedState.selectedPromptIndex !== null
    ) {
      return false;
    }

    const draft = restoreNewStepDraft({
      ...persistedState,
      promptText: persistedState.promptText ?? persistedState.editorText ?? "",
    });

    set({
      selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
      ...draft,
      isDirty: isNewStepDraftDirty(draft),
    });

    return true;
  },

  // ============================================================================
  // RESET
  // ============================================================================

  resetEditor: () =>
    set({
      selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
      multiSelection: null,
      bulkPatch: {},
      bulkCascadeCompanions: [],
      selectedPromptIndex: null,
      originalPromptData: null,
      savedNewPromptState: null,
      pendingEdits: {},
      replyContext: null,
      stepType: STEP_TYPES.PROMPT,
      stepEnabled: true,
      promptText: "",
      promptName: "",
      scriptCommand: "",
      scriptTimeoutSec: undefined,
      scriptOnPass: CONDITION_ACTIONS.CONTINUE,
      scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
      scriptCompareSource: DEFAULT_COMPARE_SOURCE,
      scriptOperator: DEFAULT_SCRIPT_OPERATOR,
      scriptExpected: "",
      scriptIgnoreCase: false,
      scriptEnv: undefined,
      scriptExecutionMode: undefined,
      scriptShell: undefined,
      properties: { ...PROPERTY_DEFAULTS },
      isDirty: false,
      validationErrors: {},
      pendingPromptEditorInserts: [],
    }),

  resetToDefaults: () =>
    set({
      multiSelection: null,
      bulkPatch: {},
      bulkCascadeCompanions: [],
      pendingEdits: {},
      stepType: STEP_TYPES.PROMPT,
      stepEnabled: true,
      promptText: "",
      promptName: "",
      scriptCommand: "",
      scriptTimeoutSec: undefined,
      scriptOnPass: CONDITION_ACTIONS.CONTINUE,
      scriptOnFail: CONDITION_ACTIONS.STOP_WORKFLOW,
      scriptCompareSource: DEFAULT_COMPARE_SOURCE,
      scriptOperator: DEFAULT_SCRIPT_OPERATOR,
      scriptExpected: "",
      scriptIgnoreCase: false,
      scriptEnv: undefined,
      scriptExecutionMode: undefined,
      scriptShell: undefined,
      properties: { ...PROPERTY_DEFAULTS },
      replyContext: null,
      isDirty: false,
      validationErrors: {},
      pendingPromptEditorInserts: [],
    }),

  // ============================================================================
  // COMPUTED SELECTORS
  // ============================================================================

  isNewPromptMode: () =>
    get().selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT,

  isEditMode: () =>
    get().selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT,

  isFinalStepMode: () =>
    get().selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP,

  getPromptProperties: () => {
    const { promptText, promptName, properties } = get();

    const result: Partial<PromptStep> = {
      prompt: promptText,
    };

    // Add name if provided
    if (promptName.trim()) {
      result.name = promptName.trim();
    }

    if (!get().stepEnabled) {
      result.enabled = false;
    }

    // Add harness if not default
    if (properties.harness !== undefined) {
      result.harness = properties.harness;
    }

    // Add model if not default
    if (properties.model !== undefined) {
      result.model = properties.model;
    }

    // Add execution mode if overridden
    if (properties.executionMode !== undefined) {
      result.executionMode = properties.executionMode;
    }

    // Add authored step color if overridden
    if (properties.color !== undefined) {
      result.color = properties.color;
    }

    // Add agent when explicitly overridden
    if (properties.agent !== undefined) {
      result.agent = properties.agent;
    }

    // Add skills when explicitly overridden
    if (properties.skills !== undefined) {
      result.skills = properties.skills;
    }

    // Add resumeSession if overridden
    if (properties.resumeSession !== undefined) {
      result.resumeSession = properties.resumeSession;
    }

    // Add mcpServers if overridden
    if (properties.mcpServers !== undefined) {
      // PropertyValues uses (string | object)[] which is structurally compatible with McpServerConfig
      result.mcpServers = properties.mcpServers as any;
    }

    // Add hooks if overridden
    if (properties.hooks !== undefined) {
      result.hooks = properties.hooks as any;
    }

    // Add end condition if configured
    if (properties.endCondition && properties.endCondition.script.trim()) {
      result.endCondition = properties.endCondition;
    }

    // Add errorBehavior when explicitly overridden
    if (properties.errorBehavior !== undefined) {
      result.errorBehavior = properties.errorBehavior;
    }

    // Add pre-condition if configured
    if (properties.preCondition !== undefined) {
      result.preCondition = properties.preCondition;
    }

    // Add priorContext if set
    if (properties.priorContext !== undefined) {
      result.priorContext = properties.priorContext;
    }

    // Add additionalArgs - three-state: undefined = inherit, null = explicitly none, string = custom
    if (properties.additionalArgs === null) {
      result.additionalArgs = null;
    } else if (properties.additionalArgs) {
      result.additionalArgs = properties.additionalArgs;
    }

    // Add toolPermissions if overridden (undefined = inherit, null = none (omit flags), object = override)
    if (properties.toolPermissions !== undefined) {
      result.toolPermissions = properties.toolPermissions;
    }

    return result;
  },

  hasContent: () => {
    const { stepType, promptText, scriptCommand } = get();
    return stepType === STEP_TYPES.SCRIPT
      ? scriptCommand.trim().length > 0
      : promptText.trim().length > 0;
  },

  hasEndCondition: () => {
    const { properties } = get();
    return (
      properties.endCondition != null &&
      properties.endCondition.script.trim().length > 0
    );
  },
}));

/** Primitive selectors keep memoized step rows subscribed to only their own state. */
export const useIsStepMultiSelected = (index: number): boolean =>
  useEditorStore(
    (state) => state.multiSelection?.indices.includes(index) ?? false
  );

export const useMultiSelectionCount = (): number =>
  useEditorStore((state) => state.multiSelection?.indices.length ?? 0);
