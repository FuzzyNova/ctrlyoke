/**
 * Zustand State Stores - Central export point for all state management
 *
 * Architecture:
 * - workflowStore: Core workflow execution data (steps, state, outputs)
 * - uiStore: UI layout and modal states (persisted to localStorage)
 * - editorStore: Prompt editor state (persisted to VS Code webview state)
 * - settingsStore: HarnessId/model configuration and global settings
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
export { useSecretRegistryStore } from "./secretRegistryStore";
export { useCompatibilityStore } from "./compatibilityStore";
export { useExecutionPreviewStore } from "./executionPreviewStore";
export { useTerminalStore } from "./terminalStore";
export { useWorkspaceViewerStore } from "./workspaceViewerStore";
export {
  useMcpManagerStore,
  MCP_MANAGER_DISCOVERY_TABS,
  MCP_MANAGER_REMOTE_SORTS,
  type McpManagerDiscoveryTab,
  type McpManagerRemoteSort,
} from "./useMcpManagerStore";
export type { TerminalSession, SessionKind } from "./terminalStore";

// Types from workflowStore
export type {
  PromptStep,
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
  HarnessStatus as HarnessStatus,
  GlobalSettings,
  WorkflowProperties,
} from "./settingsStore";
export type { SecretRegistryAction } from "./secretRegistryStore";
export type {
  CapabilitySnapshotStatus,
  CompatibilityState,
  CompatibilityActions,
} from "./compatibilityStore";
export type {
  ExecutionPreviewStatus,
  ExecutionPreviewState,
  ExecutionPreviewActions,
} from "./executionPreviewStore";
