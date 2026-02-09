import { create } from "zustand";
import type { VsCodeApi } from "../types/vscode";
import type { PromptItem } from "./workflowStore";
import { getVsCodeApi } from "../hooks/useVsCodeApi";

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
}

/**
 * Property values for prompt editor controls
 * Matches PROMPT_PROPERTIES from DashboardConstants
 */
export interface PropertyValues {
  harness: string; // "default" | harness ID
  model: string; // "default" | model ID
  agent: string; // "" or path to agent file
  resumeSession: string; // "default" | "yes" | "no"
  sessionId: string; // "" or session ID or prompt number reference
  allowDynamicExtension: string; // "default" | "yes" | "no"
  endCondition?: EndConditionConfig | null;
}

/**
 * Property defaults (single source of truth)
 * Mirrors PROPERTY_DEFAULTS from state-manager.js
 */
export const PROPERTY_DEFAULTS: PropertyValues = {
  harness: "default",
  model: "default",
  agent: "",
  resumeSession: "default",
  sessionId: "",
  allowDynamicExtension: "default",
  endCondition: undefined, // undefined = inherit from workflow
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
 * Editor state - Prompt editing mode and content
 */
interface EditorState {
  // Editing mode
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
  selectPrompt: (index: number | null, promptData?: PromptItem | null) => void;
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
  // Get current property values as PromptItem properties
  getPromptProperties: () => Partial<PromptItem>;
  // Check if editor has content
  hasContent: () => boolean;
  // Check if end condition is configured
  hasEndCondition: () => boolean;
}

const initialState: EditorState = {
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

  selectPrompt: (index, promptData = null) => {
    if (index === null) {
      // Switching to new prompt mode
      get().enterNewPromptMode();
    } else {
      // Switching to edit mode
      if (promptData) {
        // Call enterEditMode to properly load prompt data into editor
        get().enterEditMode(index, promptData);
      } else {
        // Fallback if promptData not provided (shouldn't happen)
        set({
          selectedPromptIndex: index,
          originalPromptData: promptData,
        });
      }
    }
  },

  enterNewPromptMode: () => {
    const { savedNewPromptState } = get();
    if (savedNewPromptState) {
      // Restore saved new prompt state (from switching to edit mode)
      set({
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
      state.selectedPromptIndex === null
        ? {
            promptText: state.promptText,
            promptName: state.promptName,
            properties: state.properties,
          }
        : null;

    // Extract properties from prompt data
    const properties: PropertyValues = {
      harness: promptData.harness ?? "default",
      model: promptData.model ?? "default",
      agent: promptData.agent ?? "",
      resumeSession:
        promptData.resumeSession === undefined
          ? "default"
          : promptData.resumeSession
            ? "yes"
            : "no",
      sessionId:
        promptData.sessionId !== undefined ? String(promptData.sessionId) : "",
      allowDynamicExtension:
        promptData.allowDynamicExtension === undefined
          ? "default"
          : promptData.allowDynamicExtension
            ? "yes"
            : "no",
      endCondition: promptData.endCondition ?? null,
    };

    set({
      selectedPromptIndex: index,
      originalPromptData: promptData,
      savedNewPromptState,
      promptText: promptData.prompt,
      promptName: promptData.id ?? "",
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
    if (state.selectedPromptIndex !== null) {
      return;
    }

    const persistedState = {
      editorText: state.promptText,
      promptName: state.promptName,
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
    if (persistedState.selectedPromptIndex !== null) {
      return false;
    }

    set({
      promptText: persistedState.editorText ?? "",
      promptName: persistedState.promptName ?? "",
      properties: persistedState.properties ?? { ...PROPERTY_DEFAULTS },
      isDirty: (persistedState.editorText ?? "").length > 0,
    });

    return true;
  },

  // ============================================================================
  // RESET
  // ============================================================================

  resetEditor: () =>
    set({
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

  isNewPromptMode: () => get().selectedPromptIndex === null,

  isEditMode: () => get().selectedPromptIndex !== null,

  getPromptProperties: () => {
    const { promptText, promptName, properties } = get();

    const result: Partial<PromptItem> = {
      prompt: promptText,
    };

    // Add id/name if provided
    if (promptName.trim()) {
      result.id = promptName.trim();
    }

    // Add harness if not default
    if (properties.harness !== "default") {
      result.harness = properties.harness;
    }

    // Add model if not default
    if (properties.model !== "default") {
      result.model = properties.model;
    }

    // Add agent if provided
    if (properties.agent) {
      result.agent = properties.agent;
    }

    // Add resumeSession if not default
    if (properties.resumeSession !== "default") {
      result.resumeSession = properties.resumeSession === "yes";
    }

    // Add allowDynamicExtension if not default
    if (properties.allowDynamicExtension !== "default") {
      result.allowDynamicExtension = properties.allowDynamicExtension === "yes";
    }

    // Add end condition if configured
    if (properties.endCondition && properties.endCondition.script.trim()) {
      result.endCondition = properties.endCondition;
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
