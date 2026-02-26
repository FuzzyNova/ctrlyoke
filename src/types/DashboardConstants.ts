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
  CLI_STREAMING_EVENTS: "cliStreamingEvents", // Structured events for Claude/Codex CLI
  STATUS_MESSAGE: "statusMessage",
  EXECUTION_COMPLETED: "executionCompleted",
  QUEUE_EXTENDED: "queueExtended",
  PROMPTS_EXTENDED: "promptsExtended", // Send updated prompt list after queue extension
  PROMPTS_APPENDED: "promptsAppended",
  PROMPT_DELETED: "promptDeleted", // Notify webview that a prompt was deleted
  QUEUE_SIZE_LIMIT_REACHED: "queueSizeLimitReached",
  EXECUTION_TIME_LIMIT_REACHED: "executionTimeLimitReached",
  DYNAMIC_QUEUE_ENABLED: "dynamicQueueEnabled",
  DYNAMIC_QUEUE_DISABLED: "dynamicQueueDisabled",

  // Webview -> Extension (Logging)
  LOG_MESSAGE: "logMessage", // Forward webview log entries to extension Log class (payload: { level: LogLevel, message: string })

  // Webview -> Extension
  READY: "ready",
  NEW_PROMPT: "newPrompt",
  SELECT_FILE: "selectFile",
  APPEND_FILE: "appendFile",
  EDIT_FILE: "editFile",
  CLEAR_WORKFLOW: "clearWorkflow", // Clear current workflow, start blank
  RUN: "run",
  PAUSE: "pause",
  RESUME: "resume",
  STOP: "stop",
  SHOW_OUTPUT: "showOutput",
  EXPORT_OUTPUT: "exportOutput",
  CHANGE_HARNESS: "changeHarness",

  // Prompt Editor - Webview -> Extension
  EXECUTE_PROMPT: "executePrompt", // Send/Add with properties
  UPDATE_PROMPT: "updatePrompt", // Update existing prompt in queue
  CANCEL_EDIT: "cancelEdit", // Exit edit mode
  SELECT_PROMPT_FOR_EDIT: "selectPromptForEdit", // Load prompt into editor
  DELETE_PROMPT: "deletePrompt", // Delete prompt from queue

  // Workflow Status - Webview <-> Extension
  UPDATE_WORKFLOW_NAME: "updateWorkflowName", // Webview -> Extension: Save new workflow name
  WORKFLOW_NAME_UPDATED: "workflowNameUpdated", // Extension -> Webview: Confirm name update
  GET_RECENT_WORKFLOWS: "getRecentWorkflows", // Webview -> Extension: Request workflow history
  RECENT_WORKFLOWS: "recentWorkflows", // Extension -> Webview: Send workflow history
  LOAD_WORKFLOW: "loadWorkflow", // Webview -> Extension: Load specific workflow
  CLEAR_WORKFLOW_HISTORY: "clearWorkflowHistory", // Webview -> Extension: Delete all history files

  // Settings view messages
  CHANGE_MODEL: "changeModel",
  CHANGE_AGENT: "changeAgent",
  CHANGE_EXECUTION_MODE: "changeExecutionMode",
  CHANGE_DYNAMIC_QUEUE: "changeDynamicQueue",
  CHANGE_RESUME_SESSION: "changeResumeSession",
  OPEN_SETTINGS: "openSettings", // Open VS Code settings for FlightPath
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate", // Refresh model lists after registry loads
  HARNESS_STATUS_UPDATE: "harnessStatusUpdate", // Update harness availability
  AGENTS_UPDATE: "agentsUpdate", // Update available agents list
  SKILLS_UPDATE: "skillsUpdate", // Update available skills list
  GLOBAL_SETTINGS_UPDATED: "globalSettingsUpdated", // Extension -> Webview: Config changed, update settings only (no workflow reset)
  GET_CONFIG: "getConfig", // Webview -> Extension: Request config value
  UPDATE_CONFIG: "updateConfig", // Webview -> Extension: Update config value
  CONFIG_VALUE: "configValue", // Extension -> Webview: Send config value

  // Workflow Properties - Settings Panel <-> Extension
  UPDATE_WORKFLOW_PROPERTY: "updateWorkflowProperty", // Webview -> Extension: Save workflow property (to working file or pending)
  SET_AS_DEFAULT: "setAsDefault", // Webview -> Extension: Update VS Code global setting
  WORKFLOW_PROPERTIES_UPDATE: "workflowPropertiesUpdate", // Extension -> Webview: Send updated workflow properties
  WORKFLOW_LOADED: "workflowLoaded", // Extension -> Webview: Workflow loaded, enable UI
  WORKFLOW_UNLOADED: "workflowUnloaded", // Extension -> Webview: Workflow unloaded, disable UI

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

  // Token counting - Webview -> Extension: Request token counts for attachment references
  REQUEST_ATTACHMENT_TOKEN_COUNTS: "requestAttachmentTokenCounts",
  // Extension -> Webview: Return token counts for requested references
  ATTACHMENT_TOKEN_COUNTS_RESPONSE: "attachmentTokenCountsResponse",

  // Output history messages
  OUTPUT_HISTORY_LOADED: "outputHistoryLoaded", // Extension -> Webview: Load history for display
  LOAD_RUN_HISTORY: "loadRunHistory", // Webview -> Extension: Request specific run
  CLEAR_RUN_HISTORY: "clearRunHistory", // Webview -> Extension: Delete run history
  RUN_HISTORY_UPDATED: "runHistoryUpdated", // Extension -> Webview: Available run count changed (new run started)

  // Save Workflow - Webview <-> Extension
  SAVE_WORKFLOW_REQUEST: "saveWorkflowRequest", // Webview -> Extension: Request default save path/format
  SAVE_WORKFLOW_DIALOG_DATA: "saveWorkflowDialogData", // Extension -> Webview: Default path, format, workflowsDir
  SAVE_WORKFLOW: "saveWorkflow", // Webview -> Extension: { filePath, format } confirmed by user
  WORKFLOW_SAVED: "workflowSaved", // Extension -> Webview: { filePath } success
  WORKFLOW_SAVE_FAILED: "workflowSaveFailed", // Extension -> Webview: { error } failure
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
// ACTION TYPES - Prompt editor actions (Run/Queue)
// ============================================================================
export const ACTION_TYPES = {
  RUN: "run", // Append to end + ensure workflow runs
  QUEUE: "queue", // Append to end, preserve current state
  RUN_NEXT: "runNext", // Append next (after current) + ensure workflow runs
  QUEUE_NEXT: "queueNext", // Append next (after current), preserve current state
  RUN_BEFORE_CURRENT: "runBeforeCurrent", // Insert before current + ensure workflow runs (stopped/idle with prompts)
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
// STATUS MESSAGE SEVERITY - Visual severity levels for status messages
// ============================================================================
export const STATUS_MESSAGE_SEVERITY = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

// ============================================================================
// FILE OPERATION STATUS - Status values for file operations (Edit, Write, Read)
// ============================================================================
export const OPERATION_STATUS = {
  INITIATED: "initiated",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// ============================================================================
// HARNESS IDS - Harness/framework modes for execution
// ============================================================================
export const HARNESS_IDS = {
  COPILOT_CLI: "copilot-cli",
  COPILOT_CHAT: "copilot-chat",
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
} as const;

// ============================================================================
// HARNESS INFO - Display names and labels per harness
// ============================================================================
export const HARNESS_INFO = {
  [HARNESS_IDS.COPILOT_CLI]: { name: "Copilot CLI", shortName: "Copilot CLI" },
  [HARNESS_IDS.COPILOT_CHAT]: {
    name: "Copilot Chat",
    shortName: "Copilot Chat",
  },
  [HARNESS_IDS.CLAUDE_CLI]: { name: "Claude CLI", shortName: "Claude CLI" },
  [HARNESS_IDS.CODEX_CLI]: { name: "Codex CLI", shortName: "Codex CLI" },
} as const;

// ============================================================================
// EXECUTION MODES - Execution environment for CLI commands
// ============================================================================
export const EXECUTION_MODES = {
  INTERACTIVE: "interactive",
  HEADLESS: "headless",
} as const;

// ============================================================================
// DEFAULT MODELS - Default model per harness
// ============================================================================
export const DEFAULT_MODELS = {
  [HARNESS_IDS.COPILOT_CLI]: "claude-sonnet-4.5",
  [HARNESS_IDS.COPILOT_CHAT]: "claude-sonnet-4.5",
  [HARNESS_IDS.CLAUDE_CLI]: "sonnet",
  [HARNESS_IDS.CODEX_CLI]: "gpt-5.2-codex",
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
  { value: "gpt-5.2-codex", label: "GPT 5.2 Codex" },
  { value: "gpt-5.1-codex-max", label: "GPT 5.1 Codex Max" },
  { value: "gpt-5.1-codex-mini", label: "GPT 5.1 Codex Mini" },
  { value: "gpt-5.2", label: "GPT 5.2" },
] as const;

// ============================================================================
// HARNESS STATUS STRINGS - Status values for harness availability
// ============================================================================
export const HARNESS_STATUS_STRINGS = {
  CHECKING: "checking",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
} as const;

// ============================================================================
// UI STRINGS - UI text constants used in webview
// ============================================================================
export const UI_STRINGS = {
  LOADING_MODELS: "Loading models...",
  CHECKING_STATUS: "checking...",
  UNAVAILABLE: "not available",
} as const;

// ============================================================================
// QUEUE POSITION - Position values for appending prompts to queue
// ============================================================================
export const QUEUE_POSITION = {
  NEXT: "next", // Insert after current prompt (paused/running with remaining prompts)
  END: "end", // Insert at end of queue (normal priority)
  BEFORE_CURRENT: "beforeCurrent", // Insert before current prompt (stopped/idle with prompts)
} as const;

// ============================================================================
// PROMPT PROPERTY NAMES - Single source of truth for PromptItem properties
// Used by dashboard.js to access prompt properties consistently
// ============================================================================
export const PROMPT_PROPERTIES = {
  // Core properties
  PROMPT: "prompt",
  ID: "id",

  // Harness/Model properties
  HARNESS: "harness",
  MODEL: "model",
  AGENT: "agent",
  SKILLS: "skills",

  // Session properties
  RESUME_SESSION: "resumeSession",
  SESSION_ID: "sessionId",
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
// CLI EVENT TYPES - CLI output event types for structured output rendering
// ============================================================================
export const CLI_EVENT_TYPES = {
  TEXT: "text",
  THINKING: "thinking",

  // Operation-specific tool events (normalized from harness formats)
  BASH_COMMAND: "bashCommand",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  MCP_TOOL_CALL: "mcpToolCall",
  WEB_SEARCH: "webSearch",

  // Generic fallback for unrecognized tools
  TOOL_CALL: "toolCall",

  TOOL_RESULT: "toolResult",
} as const;

// ============================================================================
// LOG LEVELS - Webview → Extension log level strings (LOG_MESSAGE payload)
// ============================================================================
export const LOG_LEVELS = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

// ============================================================================
// TYPE HELPERS - For TypeScript type safety
// ============================================================================
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
export type ExecutionState =
  (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
export type HarnessId = (typeof HARNESS_IDS)[keyof typeof HARNESS_IDS];
export type StatusMessageSeverity =
  (typeof STATUS_MESSAGE_SEVERITY)[keyof typeof STATUS_MESSAGE_SEVERITY];
export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];
export type QueuePosition =
  (typeof QUEUE_POSITION)[keyof typeof QUEUE_POSITION];
export type FileOperationStatus =
  (typeof OPERATION_STATUS)[keyof typeof OPERATION_STATUS];
export type CliEventType =
  (typeof CLI_EVENT_TYPES)[keyof typeof CLI_EVENT_TYPES];
export type HarnessStatusString =
  (typeof HARNESS_STATUS_STRINGS)[keyof typeof HARNESS_STATUS_STRINGS];
export type WebviewLogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];
