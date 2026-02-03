/**
 * Zustand State Stores - Central export point for all state management
 *
 * Architecture:
 * - workflowStore: Core workflow execution data (prompts, state, outputs)
 * - uiStore: UI layout and modal states (persisted to localStorage)
 * - editorStore: Prompt editor state (persisted to VS Code webview state)
 * - settingsStore: Provider/model configuration and global settings
 */

// Store hooks
export { useWorkflowStore } from "./workflowStore";
export { useUiStore } from "./uiStore";
export {
  useEditorStore,
  PROPERTY_DEFAULTS,
  END_CONDITION_DEFAULTS,
} from "./editorStore";
export { useSettingsStore } from "./settingsStore";

// Types from workflowStore
export type {
  PromptItem,
  CliOutput,
  RetryState,
  StatusMessage,
} from "./workflowStore";

// Types from uiStore
export type { TemplateInfo, RecentWorkflow } from "./uiStore";

// Types from editorStore
export type {
  PropertyValues,
  SavedNewPromptState,
  EndConditionConfig,
} from "./editorStore";

// Types from settingsStore
export type {
  ModelOption,
  AgentOption,
  ProviderStatus,
  GlobalSettings,
  WorkflowProperties,
} from "./settingsStore";
