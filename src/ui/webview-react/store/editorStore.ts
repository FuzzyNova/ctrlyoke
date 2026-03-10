import { create } from "zustand";
import type { VsCodeApi } from "../types/vscode";
import type { PromptItem } from "./workflowStore";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { PriorContext } from "../types/messages";

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
  harness: Inheritable<string>;         // undefined = inherit, string = harness ID
  model: Inheritable<string>;           // undefined = inherit, string = model ID
  agent: Disableable<string>;           // undefined = inherit, null = none, string = path
  skills: Disableable<string[]>;        // undefined = inherit, null = none, string[] = specific (empty array allowed transiently in custom mode)
  resumeSession: Inheritable<boolean>;  // undefined = inherit, true = yes, false = no
  sessionId: string;                    // "" or session ID or prompt number reference
  allowDynamicExtension: Inheritable<boolean>; // undefined = inherit, true = yes, false = no
  endCondition?: EndConditionConfig | null;
  priorContext?: PriorContext;           // undefined = inherit/default
  additionalArgs: Disableable<string>;  // undefined = inherit, null = none, string = custom args
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
  allowDynamicExtension: undefined,
  endCondition: undefined, // undefined = inherit from workflow
  additionalArgs: undefined,
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

export type EditorSelectionTarget =
  | { kind: "newPrompt" }
  | { kind: "queue"; index: number }
  | { kind: "finalPrompt" };

/**
 * Editor state - Prompt editing mode and content
 */
interface EditorState {
  // Editing mode
  selectionTarget: EditorSelectionTarget;
  selectedPromptIndex: number | null; // null = new prompt mode, number = editing existing
  originalPromptData: PromptItem | null; // For Cancel/revert functionality
  savedNewPromptState: SavedNewPromptState | null; // Saved state when switching to edit mode
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
  selectionTarget: { kind: "newPrompt" },
  selectedPromptIndex: null,
  originalPromptData: null,
  savedNewPromptState: null,
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
    if (typeof target === "object" && target?.kind === "finalPrompt") {
      if (promptData) {
        get().enterEditMode(-1, promptData);
      }
      return;
    }

    const resolvedIndex =
      typeof target === "number"
        ? target
        : typeof target === "object" && target?.kind === "queue"
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
          selectionTarget: { kind: "queue", index: resolvedIndex },
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
        selectionTarget: { kind: "newPrompt" },
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
          selectionTarget: { kind: "newPrompt" },
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
          selectionTarget: { kind: "newPrompt" },
          selectedPromptIndex: null,
          originalPromptData: null,
          savedNewPromptState: null,
        });
      }
    }
  },

  enterEditMode: (index, promptData) => {
    const state = get();

    // Save current new prompt state if we're in new prompt mode
    // Empty text is a valid state that should be restored on cancel
    const savedNewPromptState: SavedNewPromptState | null =
      state.selectionTarget.kind === "newPrompt"
        ? {
            promptText: state.promptText,
            promptName: state.promptName,
            properties: state.properties,
          }
        : null;

    // Extract properties from prompt data
    const properties: PropertyValues = {
      harness: promptData.harness,
      model: promptData.model,
      agent: promptData.agent,
      skills: promptData.skills,
      resumeSession: promptData.resumeSession,
      sessionId:
        promptData.sessionId !== undefined ? String(promptData.sessionId) : "",
      allowDynamicExtension: promptData.allowDynamicExtension,
      endCondition: promptData.endCondition ?? null,
      priorContext: promptData.priorContext,
      additionalArgs: promptData.additionalArgs,
    };

    const isFinalPromptTarget = index < 0;

    set({
      selectionTarget: isFinalPromptTarget
        ? { kind: "finalPrompt" }
        : { kind: "queue", index },
      selectedPromptIndex: isFinalPromptTarget ? null : index,
      originalPromptData: promptData,
      savedNewPromptState,
      promptText: promptData.prompt,
      promptName: promptData.name ?? "",
      properties,
      isDirty: false,
      validationErrors: {},
    });
  },

  cancelEdit: () => {
    const state = get();
    const { savedNewPromptState } = state;

    if (savedNewPromptState) {
      // Restore saved new prompt state (what was typed before switching to edit mode)
      set({
        selectionTarget: { kind: "newPrompt" },
        selectedPromptIndex: null,
        originalPromptData: null,
        promptText: savedNewPromptState.promptText,
        promptName: savedNewPromptState.promptName,
        properties: savedNewPromptState.properties,
        savedNewPromptState: null,
        isDirty: savedNewPromptState.promptText.length > 0,
        validationErrors: {},
      });
    } else {
      // Try to restore from VS Code persistent state
      // Use the global vscode API instance
      const vscode = getVsCodeApi();
      const restored = get().restoreFromVsCodeState(vscode);

      if (!restored) {
        // No persisted state, reset to defaults
        set({
          selectionTarget: { kind: "newPrompt" },
          selectedPromptIndex: null,
          originalPromptData: null,
          promptText: "",
          promptName: "",
          properties: { ...PROPERTY_DEFAULTS },
          isDirty: false,
          validationErrors: {},
        });
      } else {
        // State was restored, just clear edit mode flags and validation errors
        set({
          selectionTarget: { kind: "newPrompt" },
          selectedPromptIndex: null,
          originalPromptData: null,
          savedNewPromptState: null,
          validationErrors: {},
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
    if (state.selectionTarget.kind !== "newPrompt") {
      return;
    }

    const persistedState = {
      editorText: state.promptText,
      promptName: state.promptName,
      selectionTarget: { kind: "newPrompt" as const },
      selectedPromptIndex: null, // Always null for new prompt state
      properties: state.properties,
    };

    vscode.setState(persistedState);
  },

  restoreFromVsCodeState: (vscode) => {
    const persistedState = vscode.getState();

    if (!persistedState) {
      return false;
    }

    // Only restore if we were in new prompt mode
    const persistedTarget = persistedState.selectionTarget;
    if (
      (persistedTarget && persistedTarget.kind !== "newPrompt") ||
      persistedState.selectedPromptIndex !== null
    ) {
      return false;
    }

    set({
      selectionTarget: { kind: "newPrompt" },
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
      selectionTarget: { kind: "newPrompt" },
      selectedPromptIndex: null,
      originalPromptData: null,
      savedNewPromptState: null,
      promptText: "",
      promptName: "",
      properties: { ...PROPERTY_DEFAULTS },
      isDirty: false,
      validationErrors: {},
    }),

  resetToDefaults: () =>
    set({
      promptText: "",
      promptName: "",
      properties: { ...PROPERTY_DEFAULTS },
      isDirty: false,
      validationErrors: {},
    }),

  // ============================================================================
  // COMPUTED SELECTORS
  // ============================================================================

  isNewPromptMode: () => get().selectionTarget.kind === "newPrompt",

  isEditMode: () => get().selectionTarget.kind !== "newPrompt",

  isFinalPromptMode: () => get().selectionTarget.kind === "finalPrompt",

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

    // Add allowDynamicExtension if overridden
    if (properties.allowDynamicExtension !== undefined) {
      result.allowDynamicExtension = properties.allowDynamicExtension;
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
