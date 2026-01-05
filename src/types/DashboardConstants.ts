/**
 * Shared constants for FlightPath Dashboard
 * SINGLE SOURCE OF TRUTH for all message types, states, and status values
 * Used by both TypeScript extension code AND JavaScript webview code
 */

// ============================================================================
// MESSAGE TYPES - Communication between extension and webview
// ============================================================================
export const MESSAGE_TYPES = {
  // Extension -> Webview
  INIT: "init",
  FILE_SELECTED: "fileSelected",
  SESSION_RESTORED: "sessionRestored", // Restore previous session with runtime state preserved
  EXECUTION_STARTED: "executionStarted",
  EXECUTION_STATE_CHANGED: "executionStateChanged",
  PROGRESS_UPDATE: "progressUpdate",
  STEP_STATUS_CHANGED: "stepStatusChanged",
  RETRY_ATTEMPT_CHANGED: "retryAttemptChanged",
  CLI_OUTPUT: "cliOutput",
  CLI_STREAMING_CHUNK: "cliStreamingChunk",
  STATUS_MESSAGE: "statusMessage",
  EXECUTION_COMPLETED: "executionCompleted",
  QUEUE_EXTENDED: "queueExtended",
  PROMPTS_EXTENDED: "promptsExtended", // Send updated prompt list after queue extension
  PROMPTS_APPENDED: "promptsAppended",
  QUEUE_SIZE_LIMIT_REACHED: "queueSizeLimitReached",
  EXECUTION_TIME_LIMIT_REACHED: "executionTimeLimitReached",
  DYNAMIC_QUEUE_ENABLED: "dynamicQueueEnabled",
  DYNAMIC_QUEUE_DISABLED: "dynamicQueueDisabled",

  // Webview -> Extension
  READY: "ready",
  NEW_PROMPT: "newPrompt",
  SELECT_FILE: "selectFile",
  APPEND_FILE: "appendFile",
  EDIT_FILE: "editFile",
  RUN: "run",
  PAUSE: "pause",
  RESUME: "resume",
  STOP: "stop",
  SHOW_OUTPUT: "showOutput",
  EXPORT_OUTPUT: "exportOutput",
  CHANGE_PROVIDER: "changeProvider",

  // Prompt Editor - Webview -> Extension
  EXECUTE_PROMPT: "executePrompt", // Run/Append/AppendNext with properties
  UPDATE_PROMPT: "updatePrompt", // Update existing prompt in queue
  CANCEL_EDIT: "cancelEdit", // Exit edit mode
  SELECT_PROMPT_FOR_EDIT: "selectPromptForEdit", // Load prompt into editor
  DELETE_PROMPT: "deletePrompt", // Delete prompt from queue

  // Settings view messages
  CHANGE_MODEL: "changeModel",
  CHANGE_EXECUTION_MODE: "changeExecutionMode",
  CHANGE_DYNAMIC_QUEUE: "changeDynamicQueue",
  CHANGE_NEW_CHAT_SESSION: "changeNewChatSession",
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate", // Refresh model lists after registry loads
  PROVIDER_STATUS_UPDATE: "providerStatusUpdate", // Update provider availability

  // New Workflow Modal - Extension -> Webview
  OPEN_NEW_WORKFLOW_MODAL: "openNewWorkflowModal",
  TEMPLATE_INFO: "templateInfo",
  DEFAULT_TEMPLATE_SET: "defaultTemplateSet",
  WORKFLOW_CREATED: "workflowCreated",
  CLOSE_MODAL: "closeModal",

  // New Workflow Modal - Webview -> Extension
  NEW_WORKFLOW: "newWorkflow", // Opens modal (from button click)
  TEMPLATE_SELECTED: "templateSelected",
  SET_DEFAULT_TEMPLATE: "setDefaultTemplate",
  CREATE_WORKFLOW: "createWorkflow",
  CREATE_NEW_TEMPLATE: "createNewTemplate",

  // CodeMirror editor - Webview <-> Extension
  REQUEST_COMPLETIONS: "requestCompletions", // Request autocomplete suggestions
  COMPLETIONS_RESPONSE: "completionsResponse", // Return autocomplete suggestions
  OPEN_FILE: "openFile", // Open file from #file: link
} as const;

// ============================================================================
// EXECUTION STATES - QueueState.status values
// ============================================================================
export const EXECUTION_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped", // Execution aborted, state preserved, can resume from current prompt
  CANCELLING: "cancelling", // Kill signal sent, waiting for process to die
  COMPLETED: "completed",
  ERROR: "error",
} as const;

// ============================================================================
// STEP STATUS - PromptResult.status values
// ============================================================================
export const STEP_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

// ============================================================================
// PROVIDER IDS - Copilot integration modes
// ============================================================================
export const PROVIDER_IDS = {
  COPILOT_CLI: "copilot-cli",
  COPILOT_CHAT: "copilot-chat",
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
} as const;

// ============================================================================
// PROVIDER INFO - Display names and labels per provider
// ============================================================================
export const PROVIDER_INFO = {
  [PROVIDER_IDS.COPILOT_CLI]: { name: "Copilot CLI", shortName: "Copilot CLI" },
  [PROVIDER_IDS.COPILOT_CHAT]: {
    name: "Copilot Chat",
    shortName: "Copilot Chat",
  },
  [PROVIDER_IDS.CLAUDE_CLI]: { name: "Claude CLI", shortName: "Claude CLI" },
  [PROVIDER_IDS.CODEX_CLI]: { name: "Codex CLI", shortName: "Codex CLI" },
} as const;

// ============================================================================
// DEFAULT MODELS - Default model per provider
// ============================================================================
export const DEFAULT_MODELS = {
  [PROVIDER_IDS.COPILOT_CLI]: "claude-sonnet-4.5",
  [PROVIDER_IDS.COPILOT_CHAT]: "claude-sonnet-4.5",
  [PROVIDER_IDS.CLAUDE_CLI]: "sonnet",
  [PROVIDER_IDS.CODEX_CLI]: "gpt-5.1-codex",
} as const;

// ============================================================================
// CLAUDE CLI MODELS - Static options (no programmatic way to query)
// ============================================================================
export const CLAUDE_CLI_MODELS = [
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1M Context" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
] as const;

// ============================================================================
// CODEX CLI MODELS - Static options (from codex /model command)
// ============================================================================
export const CODEX_CLI_MODELS = [
  {
    value: "gpt-5.1-codex-max",
    label: "GPT-5.1 Codex Max",
  },
  { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
  { value: "gpt-5.2", label: "GPT-5.2" },
  { value: "gpt-5.1", label: "GPT-5.1" },
] as const;

// ============================================================================
// PROVIDER STATUS STRINGS - Status values for provider availability
// ============================================================================
export const PROVIDER_STATUS_STRINGS = {
  CHECKING: "checking",
  AVAILABLE: "available",
  NOT_AVAILABLE: "not_available",
} as const;

// ============================================================================
// UI STRINGS - UI text constants used in webview
// ============================================================================
export const UI_STRINGS = {
  LOADING_MODELS: "Loading models...",
  CHECKING_STATUS: "checking...",
  NOT_AVAILABLE: "not available",
} as const;

// ============================================================================
// PROMPT PROPERTY NAMES - Single source of truth for PromptItem properties
// Used by dashboard.js to access prompt properties consistently
// ============================================================================
export const PROMPT_PROPERTIES = {
  // Core properties
  PROMPT: "prompt",
  ID: "id",

  // Provider/Model properties
  PROVIDER: "provider",
  MODEL: "model",
  AGENT: "agent",

  // Session properties
  NEW_CHAT_SESSION: "newChatSession",
  ALLOW_DYNAMIC_EXTENSION: "allowDynamicExtension",

  // End condition root
  END_CONDITION: "endCondition",
} as const;

// End condition property names
export const END_CONDITION_PROPERTIES = {
  SCRIPT: "script",
  RETURNS: "returns",
  TIMEOUT: "timeout",
  MAX_RETRIES: "maxRetries",
  RETRY_PROMPT: "retryPrompt",
} as const;

// ============================================================================
// TYPE HELPERS - For TypeScript type safety
// ============================================================================
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
export type ExecutionState =
  (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];
