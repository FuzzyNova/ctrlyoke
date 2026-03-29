import { create } from "zustand";
import type { VsCodeApi } from "../types/vscode";
import type { PromptItem } from "./workflowStore";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { PriorContext, ToolPermissionsOverride } from "../types/messages";
import { FINAL_PROMPT_PHASES, EDITOR_TARGET_KINDS } from "../types/messages";

/** Property is inherited from workflow/settings when undefined. */
export type Inheritable<T> = T | undefined;

/** Property can inherit (undefined), be explicitly disabled (null), or set to a custom value. */
export type Disableable<T> = T | null | undefined;

/**
 * End condition configuration
 * All fields optional except script to match PromptItem.endCondition
 */
export interface EndConditionConfig {
  script: string;
  returns?: string;
  timeout?: number;
  maxRetries?: number;
  retryPrompt?: string;
  resumeSessionOnRetry?: boolean;
}

/**
 * Property values for prompt editor controls
 * Matches PROMPT_PROPERTIES from DashboardConstants
 */
export interface PropertyValues {
  harness: Inheritable<string>; // undefined = inherit, string = harness ID
  model: Inheritable<string>; // undefined = inherit, string = model ID
  agent: Disableable<string>; // undefined = inherit, null = none, string = path
  skills: Disableable<string[]>; // undefined = inherit, null = none, string[] = specific (empty array allowed transiently in custom mode)
  resumeSession: Inheritable<boolean>; // undefined = inherit, true = yes, false = no
  sessionId: string; // "" or session ID or prompt number reference
  mcpServers: (string | object)[] | null | undefined; // undefined = inherit, null = none, array = custom
  endCondition?: EndConditionConfig | null;
  priorContext?: PriorContext; // undefined = inherit/default
  additionalArgs: Disableable<string>; // undefined = inherit, null = none, string = custom args
  toolPermissions?: ToolPermissionsOverride | null; // undefined = inherit workflow, null = passthrough, object = override
}

/**
 * Property defaults (single source of truth)
 * Mirrors PROPERTY_DEFAULTS from state-manager.js
 */
export const PROPERTY_DEFAULTS: PropertyValues = {
  harness: undefined,
  model: undefined,
  agent: undefined,
  skills: undefined,
  resumeSession: undefined,
  sessionId: "",
  mcpServers: undefined,
  endCondition: undefined, // undefined = inherit from workflow
  additionalArgs: undefined,
  toolPermissions: undefined,
};

export const END_CONDITION_DEFAULTS: EndConditionConfig = {
  script: "",
  returns: "",
  timeout: 30000,
  maxRetries: 0,
  retryPrompt: "",
};

/**
 * Saved new prompt state for restoring when switching from edit to new mode
 */
export interface SavedNewPromptState {
  promptText: string;
  promptName: string;
  properties: PropertyValues;
}

/**
 * Returns a stable string key for a selection target, used to index pendingEdits.
 * Only valid for edit-mode targets (queue / finalPrompt).
 */
function selectionTargetKey(target: EditorSelectionTarget): string {
  if (target.kind === FINAL_PROMPT_PHASES.QUEUE) return `queue:${target.index}`;
  if (target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) return "finalPrompt";
  return "";
}

export type EditorSelectionTarget =
  | { kind: typeof EDITOR_TARGET_KINDS.NEW_PROMPT }
  | { kind: typeof FINAL_PROMPT_PHASES.QUEUE; index: number }
  | { kind: typeof FINAL_PROMPT_PHASES.FINAL_PROMPT };

/**
 * Editor state - Prompt editing mode and content
 */
interface EditorState {
  // Editing mode
  selectionTarget: EditorSelectionTarget;
  selectedPromptIndex: number | null; // null = new prompt mode, number = editing existing
  originalPromptData: PromptItem | null; // For Cancel/revert functionality
  savedNewPromptState: SavedNewPromptState | null; // Saved state when switching to edit mode
  /**
   * Local-memory cache of unsaved edits for each prompt, keyed by selectionTargetKey().
   * Populated when the user navigates away from a prompt without pressing Update.
   * Cleared when the user presses Update (via cancelEdit) or Cancel.
   */
  pendingEdits: Record<string, SavedNewPromptState>;
  hasActiveQueue: boolean; // Whether a workflow is currently loaded

  // Editor content
  promptText: string;
  promptName: string;

  // Property values
  properties: PropertyValues;

  // Editor dirty state
  isDirty: boolean;

  // Validation state
  validationErrors: Record<string, string>;
}

/**
 * Editor actions
 */
interface EditorActions {
  // Mode switching
  selectPrompt: (
    target: number | null | EditorSelectionTarget,
    promptData?: PromptItem | null
  ) => void;
  selectFinalPrompt: (promptData: PromptItem) => void;
  enterNewPromptMode: () => void;
  enterEditMode: (index: number, promptData: PromptItem) => void;
  cancelEdit: () => void;
  /**
   * Saves current edit state to pendingEdits and returns to new prompt mode.
   * Unlike cancelEdit, this preserves unsaved changes so the user can return
   * to the prompt and continue editing.
   */
  deselect: () => void;

  // Content updates
  setPromptText: (text: string) => void;
  setPromptName: (name: string) => void;

  // Property updates
  setProperty: <K extends keyof PropertyValues>(
    key: K,
    value: PropertyValues[K]
  ) => void;
  setProperties: (properties: Partial<PropertyValues>) => void;
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

  // Pending edit cache
  clearAllPendingEdits: () => void;

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
  isFinalPromptMode: () => boolean;
  // Get current property values as PromptItem properties
  getPromptProperties: () => Partial<PromptItem>;
  // Check if editor has content
  hasContent: () => boolean;
  // Check if end condition is configured
  hasEndCondition: () => boolean;
}

const initialState: EditorState = {
  selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
  selectedPromptIndex: null,
  originalPromptData: null,
  savedNewPromptState: null,
  pendingEdits: {},
  hasActiveQueue: false,
  promptText: "",
  promptName: "",
  properties: { ...PROPERTY_DEFAULTS },
  isDirty: false,
  validationErrors: {},
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
      target?.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT
    ) {
      if (promptData) {
        get().enterEditMode(-1, promptData);
      }
      return;
    }

    const resolvedIndex =
      typeof target === "number"
        ? target
        : typeof target === "object" &&
            target?.kind === FINAL_PROMPT_PHASES.QUEUE
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
          selectionTarget: {
            kind: FINAL_PROMPT_PHASES.QUEUE,
            index: resolvedIndex,
          },
          selectedPromptIndex: resolvedIndex,
          originalPromptData: promptData,
        });
      }
    }
  },

  selectFinalPrompt: (promptData) => {
    get().enterEditMode(-1, promptData);
  },

  enterNewPromptMode: () => {
    const { savedNewPromptState } = get();
    if (savedNewPromptState) {
      // Restore saved new prompt state (from switching to edit mode)
      set({
        selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
        selectedPromptIndex: null,
        originalPromptData: null,
        promptText: savedNewPromptState.promptText,
        promptName: savedNewPromptState.promptName,
        properties: savedNewPromptState.properties,
        savedNewPromptState: null,
        isDirty: savedNewPromptState.promptText.length > 0,
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
          promptText: "",
          promptName: "",
          properties: { ...PROPERTY_DEFAULTS },
          isDirty: false,
          validationErrors: {},
        });
      } else {
        // State was restored, just clear edit mode flags
        set({
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          savedNewPromptState: null,
        });
      }
    }
  },

  enterEditMode: (index, promptData) => {
    const state = get();
    const newPendingEdits = { ...state.pendingEdits };

    // When switching away from an edit-mode prompt, save its current editor
    // state so the user can return to it without losing unsaved changes.
    if (state.selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT) {
      const key = selectionTargetKey(state.selectionTarget);
      newPendingEdits[key] = {
        promptText: state.promptText,
        promptName: state.promptName,
        properties: state.properties,
      };
    }

    // Save current new-prompt state when first entering edit mode.
    // Preserve the existing savedNewPromptState when switching between edit modes
    // so the user's new-prompt draft survives multiple prompt switches.
    const savedNewPromptState: SavedNewPromptState | null =
      state.selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT
        ? {
            promptText: state.promptText,
            promptName: state.promptName,
            properties: state.properties,
          }
        : state.savedNewPromptState;

    const isFinalPromptTarget = index < 0;
    const newTarget: EditorSelectionTarget = isFinalPromptTarget
      ? { kind: FINAL_PROMPT_PHASES.FINAL_PROMPT }
      : { kind: FINAL_PROMPT_PHASES.QUEUE, index };

    // Restore a pending (unsaved) edit if one exists for this prompt, otherwise
    // load the prompt data from the workflow.
    const pendingEdit = newPendingEdits[selectionTargetKey(newTarget)];
    const propertiesFromData: PropertyValues = {
      harness: promptData.harness,
      model: promptData.model,
      agent: promptData.agent,
      skills: promptData.skills,
      resumeSession: promptData.resumeSession,
      sessionId:
        promptData.sessionId !== undefined ? String(promptData.sessionId) : "",
      mcpServers: promptData.mcpServers,
      endCondition: promptData.endCondition ?? null,
      priorContext: promptData.priorContext,
      additionalArgs: promptData.additionalArgs,
      toolPermissions: promptData.toolPermissions,
    };

    set({
      selectionTarget: newTarget,
      selectedPromptIndex: isFinalPromptTarget ? null : index,
      originalPromptData: promptData,
      savedNewPromptState,
      promptText: pendingEdit ? pendingEdit.promptText : promptData.prompt,
      promptName: pendingEdit
        ? pendingEdit.promptName
        : (promptData.name ?? ""),
      properties: pendingEdit ? pendingEdit.properties : propertiesFromData,
      isDirty: pendingEdit ? true : false,
      validationErrors: {},
      pendingEdits: newPendingEdits,
    });
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
      // Restore saved new prompt state (what was typed before switching to edit mode)
      set({
        selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
        selectedPromptIndex: null,
        originalPromptData: null,
        promptText: savedNewPromptState.promptText,
        promptName: savedNewPromptState.promptName,
        properties: savedNewPromptState.properties,
        savedNewPromptState: null,
        isDirty: savedNewPromptState.promptText.length > 0,
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
          promptText: "",
          promptName: "",
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
    newPendingEdits[key] = {
      promptText: state.promptText,
      promptName: state.promptName,
      properties: state.properties,
    };

    const { savedNewPromptState } = state;
    if (savedNewPromptState) {
      set({
        selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
        selectedPromptIndex: null,
        originalPromptData: null,
        promptText: savedNewPromptState.promptText,
        promptName: savedNewPromptState.promptName,
        properties: savedNewPromptState.properties,
        savedNewPromptState: null,
        isDirty: savedNewPromptState.promptText.length > 0,
        validationErrors: {},
        pendingEdits: newPendingEdits,
      });
    } else {
      const vscode = getVsCodeApi();
      const restored = get().restoreFromVsCodeState(vscode);
      if (!restored) {
        set({
          selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
          selectedPromptIndex: null,
          originalPromptData: null,
          promptText: "",
          promptName: "",
          properties: { ...PROPERTY_DEFAULTS },
          isDirty: false,
          validationErrors: {},
          pendingEdits: newPendingEdits,
        });
      } else {
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
    set((state) => ({
      properties: { ...state.properties, [key]: value },
      isDirty: true,
    })),

  setProperties: (properties) =>
    set((state) => ({
      properties: { ...state.properties, ...properties },
      isDirty: true,
    })),

  resetProperties: () =>
    set({
      properties: { ...PROPERTY_DEFAULTS },
      isDirty: true,
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

  // ============================================================================
  // PENDING EDIT CACHE
  // ============================================================================

  clearAllPendingEdits: () => set({ pendingEdits: {} }),

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
    const { promptText } = get();
    const errors: Record<string, string> = {};

    if (!promptText.trim()) {
      errors.promptText = "Prompt text is required";
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

    const editorState = {
      editorText: state.promptText,
      promptName: state.promptName,
      selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
      selectedPromptIndex: null, // Always null for new prompt state
      properties: state.properties,
    };

    // Merge under "editorState" key to coexist with other vscode state consumers
    // (e.g. uiStore's Zustand persist storage uses "flightpath-ui-state" key).
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

    set({
      selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
      promptText: persistedState.editorText ?? "",
      promptName: persistedState.promptName ?? "",
      properties: {
        ...PROPERTY_DEFAULTS,
        ...(persistedState.properties ?? {}),
      },
      isDirty: (persistedState.editorText ?? "").length > 0,
    });

    return true;
  },

  // ============================================================================
  // RESET
  // ============================================================================

  resetEditor: () =>
    set({
      selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
      selectedPromptIndex: null,
      originalPromptData: null,
      savedNewPromptState: null,
      pendingEdits: {},
      promptText: "",
      promptName: "",
      properties: { ...PROPERTY_DEFAULTS },
      isDirty: false,
      validationErrors: {},
    }),

  resetToDefaults: () =>
    set({
      pendingEdits: {},
      promptText: "",
      promptName: "",
      properties: { ...PROPERTY_DEFAULTS },
      isDirty: false,
      validationErrors: {},
    }),

  // ============================================================================
  // COMPUTED SELECTORS
  // ============================================================================

  isNewPromptMode: () =>
    get().selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT,

  isEditMode: () =>
    get().selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT,

  isFinalPromptMode: () =>
    get().selectionTarget.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT,

  getPromptProperties: () => {
    const { promptText, promptName, properties } = get();

    const result: Partial<PromptItem> = {
      prompt: promptText,
    };

    // Add name if provided
    if (promptName.trim()) {
      result.name = promptName.trim();
    }

    // Add harness if not default
    if (properties.harness !== undefined) {
      result.harness = properties.harness;
    }

    // Add model if not default
    if (properties.model !== undefined) {
      result.model = properties.model;
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

    // Add end condition if configured
    if (properties.endCondition && properties.endCondition.script.trim()) {
      result.endCondition = properties.endCondition;
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

    // Add toolPermissions if overridden (undefined = inherit, null = passthrough, object = override)
    if (properties.toolPermissions !== undefined) {
      result.toolPermissions = properties.toolPermissions;
    }

    return result;
  },

  hasContent: () => get().promptText.trim().length > 0,

  hasEndCondition: () => {
    const { properties } = get();
    return (
      properties.endCondition != null &&
      properties.endCondition.script.trim().length > 0
    );
  },
}));
