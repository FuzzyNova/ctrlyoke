import { create } from "zustand";
import type { VsCodeApi } from "../types/vscode";
import type { PromptItem } from "./workflowStore";

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
  provider: string; // "default" | provider ID
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
  provider: "default",
  model: "default",
  agent: "",
  resumeSession: "default",
  sessionId: "",
  allowDynamicExtension: "default",
  endCondition: null,
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
      const { savedNewPromptState } = get();
      if (savedNewPromptState) {
        // Restore saved new prompt state
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
        set({
          selectedPromptIndex: null,
          originalPromptData: null,
          isDirty: false,
        });
      }
    } else {
      // Switching to edit mode
      set({
        selectedPromptIndex: index,
        originalPromptData: promptData,
      });
    }
  },

  enterNewPromptMode: () => {
    const { savedNewPromptState } = get();
    if (savedNewPromptState) {
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
      set({
        selectedPromptIndex: null,
        originalPromptData: null,
        promptText: "",
        promptName: "",
        properties: { ...PROPERTY_DEFAULTS },
        isDirty: false,
        validationErrors: {},
      });
    }
  },

  enterEditMode: (index, promptData) => {
    const state = get();

    // Save current new prompt state if we have content
    const savedNewPromptState: SavedNewPromptState | null =
      state.selectedPromptIndex === null && state.promptText.trim()
        ? {
            promptText: state.promptText,
            promptName: state.promptName,
            properties: state.properties,
          }
        : null;

    // Extract properties from prompt data
    const properties: PropertyValues = {
      provider: promptData.provider ?? "default",
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
    const { originalPromptData, savedNewPromptState } = get();

    if (savedNewPromptState) {
      // Restore saved new prompt state
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
    } else if (originalPromptData) {
      // Revert to original prompt data
      const properties: PropertyValues = {
        provider: originalPromptData.provider ?? "default",
        model: originalPromptData.model ?? "default",
        agent: originalPromptData.agent ?? "",
        resumeSession:
          originalPromptData.resumeSession === undefined
            ? "default"
            : originalPromptData.resumeSession
              ? "yes"
              : "no",
        sessionId:
          originalPromptData.sessionId !== undefined
            ? String(originalPromptData.sessionId)
            : "",
        allowDynamicExtension:
          originalPromptData.allowDynamicExtension === undefined
            ? "default"
            : originalPromptData.allowDynamicExtension
              ? "yes"
              : "no",
        endCondition: originalPromptData.endCondition ?? null,
      };

      set({
        promptText: originalPromptData.prompt,
        promptName: originalPromptData.id ?? "",
        properties,
        isDirty: false,
        validationErrors: {},
      });
    } else {
      // Just reset to new prompt mode
      set({
        selectedPromptIndex: null,
        originalPromptData: null,
        promptText: "",
        promptName: "",
        properties: { ...PROPERTY_DEFAULTS },
        isDirty: false,
        validationErrors: {},
      });
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
      properties: { ...state.properties, endCondition: null },
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

    // Add provider if not default
    if (properties.provider !== "default") {
      result.provider = properties.provider;
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
