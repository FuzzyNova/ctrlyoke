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
  STEPS_EXTENDED: "stepsExtended", // Send updated steps list after queue extension
  PROMPT_DELETED: "promptDeleted", // Notify webview that a prompt was deleted
  UPDATE_FINAL_PROMPT: "updateFinalStep", // Bidirectional: webview updates workflow-level finalStep; extension pushes latest finalStep
  FINAL_PROMPT_STATUS_CHANGED: "finalStepStatusChanged", // Granular runtime status updates for finalStep phase
  FINAL_PROMPT_OUTPUT: "finalStepOutput", // CLI output for finalStep keyed by loop index
  FINAL_PROMPT_STREAMING_CHUNK: "finalStepStreamingChunk", // Incremental streaming text chunk for finalStep
  FINAL_PROMPT_STREAMING_EVENTS: "finalStepStreamingEvents", // Structured streaming events for finalStep
  QUEUE_SIZE_LIMIT_REACHED: "queueSizeLimitReached",
  EXECUTION_TIME_LIMIT_REACHED: "executionTimeLimitReached",

  // Webview -> Extension (Logging)
  LOG_MESSAGE: "logMessage", // Forward webview log entries to extension Log class (payload: { level: LogLevel, message: string })

  // Webview -> Extension
  READY: "ready",
  NEW_PROMPT: "newPrompt",
  SELECT_FILE: "selectFile",
  APPEND_FILE: "appendFile",
  EDIT_FILE: "editFile",
  CLEAR_WORKFLOW: "clearWorkflow", // Clear current workflow, start blank
  ENABLE_SERVER: "enableServer",
  DISABLE_SERVER: "disableServer",
  RUN: "run",
  PAUSE: "pause",
  RESUME: "resume",
  STOP: "stop",
  SHOW_OUTPUT: "showOutput",
  EXPORT_OUTPUT: "exportOutput",
  CHANGE_HARNESS: "changeHarness",

  // Prompt Editor - Webview -> Extension
  EXECUTE_PROMPT: "executePrompt", // Send/Add with properties
  EXECUTE_PROMPT_ERROR: "executePromptError", // Extension -> Webview: Notify failure so editor can restore content
  UPDATE_PROMPT: "updatePrompt", // Update existing prompt in queue
  CANCEL_EDIT: "cancelEdit", // Exit edit mode
  SELECT_PROMPT_FOR_EDIT: "selectPromptForEdit", // Load prompt into editor
  DELETE_PROMPT: "deletePrompt", // Delete prompt from queue
  RESET_WORKFLOW_STATE: "resetWorkflowState", // Bidirectional: Webview->Extension request reset; Extension->Webview confirms with updated prompts (preserves output history)

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
  CHANGE_MCP_SERVERS: "changeMcpServers",
  CHANGE_RESUME_SESSION: "changeResumeSession",
  OPEN_SETTINGS: "openSettings", // Open VS Code settings for FlightPath
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate", // Refresh model lists after registry loads
  HARNESS_STATUS_UPDATE: "harnessStatusUpdate", // Update harness availability
  AGENTS_UPDATE: "agentsUpdate", // Update available agents list
  SKILLS_UPDATE: "skillsUpdate", // Update available skills list
  GLOBAL_SETTINGS_UPDATED: "globalSettingsUpdated", // Extension -> Webview: Config changed, update settings only (no workflow reset)
  GLOBAL_SETTINGS_LOAD_REQUEST: "globalSettingsLoadRequest", // Webview -> Extension: Request full settings payload
  GLOBAL_SETTINGS_LOADED: "globalSettingsLoaded", // Extension -> Webview: Full settings payload + sources
  UPDATE_GLOBAL_SETTING: "updateGlobalSetting", // Webview -> Extension: { path, value, scope }
  GLOBAL_SETTING_UPDATED: "globalSettingUpdated", // Extension -> Webview: { path, value, source } acknowledgment
  GET_CONFIG: "getConfig", // Webview -> Extension: Request config value
  UPDATE_CONFIG: "updateConfig", // Webview -> Extension: Update config value
  CONFIG_VALUE: "configValue", // Extension -> Webview: Send config value

  // Workflow Properties - Settings Panel <-> Extension
  UPDATE_WORKFLOW_PROPERTY: "updateWorkflowProperty", // Webview -> Extension: Save workflow property (to working file or pending)
  UPDATE_WORKFLOW_PROPERTIES: "updateWorkflowProperties", // Webview -> Extension: Save multiple workflow properties atomically
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
  BROWSE_TEMPLATE_FILE: "browseTemplateFile", // Request OS file picker for a template variable

  // New Workflow Modal - Extension -> Webview
  TEMPLATE_FILE_SELECTED: "templateFileSelected", // OS file picker result for a template variable

  // CodeMirror editor - Webview <-> Extension
  REQUEST_COMPLETIONS: "requestCompletions", // Request autocomplete suggestions
  COMPLETIONS_RESPONSE: "completionsResponse", // Return autocomplete suggestions
  OPEN_FILE: "openFile", // Open file from #file: link
  OPEN_GIT_CHANGE: "openGitChange", // Webview -> Extension: open a git diff in a new editor
  VALIDATE_FILE_REF: "validateFileRef", // Webview -> Extension: Check if a file-ref path resolves
  FILE_REF_VALIDATION: "fileRefValidation", // Extension -> Webview: { exists: boolean, filePath: string }

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

  // Multi-workflow coordination — Extension → Webview
  WORKFLOWS_LIST: "workflowsList", // Full list of loaded WorkflowSummary[]
  WORKFLOW_ADDED: "workflowAdded", // New workflow loaded: { summary: WorkflowSummary }
  WORKFLOW_DISMISSED: "workflowDismissed", // Workflow removed: { workflowId }
  WORKFLOW_SUMMARY_UPDATED: "workflowSummaryUpdated", // Execution state changed: { summary: WorkflowSummary }
  ACTIVE_WORKFLOW_CHANGED: "activeWorkflowChanged", // Active selection changed: { workflowId }

  // VS Code-hosted server — Extension → Webview
  SERVER_STARTED: "serverStarted", // Server started: { url: string }
  SERVER_STOPPED: "serverStopped", // Server stopped

  // VS Code-hosted server — Extension → Webview (theme forwarding)
  CAPTURE_THEME_VARS: "captureThemeVars", // Request webview to capture --vscode-* CSS vars
  THEME_VARS_UPDATED: "themeVarsUpdated", // Broadcast updated theme vars to browser clients: { vars: Record<string, string> }

  // VS Code-hosted server — Webview → Extension (theme forwarding)
  THEME_VARS_CAPTURED: "themeVarsCaptured", // Webview captured CSS vars: { vars: Record<string, string> }

  // CLI Watch Mode — Extension → Webview
  CLI_WATCH_OUTPUT: "cliWatchOutput", // Live output update from CLI-managed workflow: { workflowId, stepIndex, output }

  // Multi-workflow coordination — Webview → Extension
  GET_WORKFLOWS_LIST: "getWorkflowsList", // Request all loaded WorkflowSummary[]
  SWITCH_WORKFLOW: "switchWorkflow", // Switch active workflow: { workflowId }

  // Per-workflow targeted controls — Webview → Extension
  RUN_WORKFLOW: "runWorkflow", // Run/restart specific workflow: { workflowId }
  PAUSE_WORKFLOW: "pauseWorkflow", // Pause specific workflow: { workflowId }
  RESUME_WORKFLOW: "resumeWorkflow", // Resume specific workflow: { workflowId }
  STOP_WORKFLOW: "stopWorkflow", // Stop specific workflow: { workflowId }
  STOP_CLI_RUN: "stopCliRun", // Kill the CLI process for a CLI-managed workflow: { workflowId }

  // Recent workflow management — Webview → Extension
  REMOVE_WORKFLOW_HISTORY: "removeWorkflowHistory", // Remove single history entry: { filePath }

  // MCP Discovery — Webview ↔ Extension
  REQUEST_MCP_LOCAL_SERVERS: "requestMcpLocalServers", // Webview -> Extension: Scan local MCP config files
  MCP_LOCAL_SERVERS_RESULT: "mcpLocalServersResult", // Extension -> Webview: { servers: LocalMcpServerEntry[], error? }
  REQUEST_MCP_REGISTRY: "requestMcpRegistry", // Webview -> Extension: Search Anthropic MCP registry
  MCP_REGISTRY_RESULT: "mcpRegistryResult", // Extension -> Webview: { servers: RegistryMcpEntry[], error?, query? }
  REQUEST_MCP_WORKSPACE_SERVERS: "requestMcpWorkspaceServers", // Webview -> Extension: Load workspace MCP registry
  MCP_WORKSPACE_SERVERS_RESULT: "mcpWorkspaceServersResult", // Extension -> Webview: { servers: McpServerConfig[], error? }
  SAVE_MCP_WORKSPACE_SERVERS: "saveMcpWorkspaceServers", // Webview -> Extension: Save workspace MCP registry { servers: McpServerConfig[] }

  // Settings — Webview → Extension
  UPDATE_CONFIRM_DELETE: "updateConfirmDelete", // Update confirmDeleteOperations setting: { value: boolean }

  // Queue Position Control — Webview → Extension
  SET_START_POSITION: "setStartPosition",
  REORDER_PROMPTS: "reorderPrompts",
  UPDATE_CONFIRM_RESET: "updateConfirmReset",

  // Queue Position Control — Extension → Webview
  SET_START_POSITION_CONFIRMED: "setStartPositionConfirmed",
  REORDER_PROMPTS_CONFIRMED: "reorderPromptsConfirmed",

  // Undo/Redo — Webview → Extension: sync restored state after undo/redo
  UNDO_REDO_SYNC: "undoRedoSync",

  // Prompt undo — Extension → Webview: live snapshot metadata after prompt completes
  STEP_UNDO_DATA_UPDATED: "stepUndoDataUpdated",
  // Prompt undo — Webview → Extension: request to restore files
  UNDO_PROMPT_CHANGES: "undoPromptChanges",
  // Prompt undo — Extension → Webview: result of restore operation
  UNDO_PROMPT_RESULT: "undoPromptResult",
  // Prompt undo — Extension → Webview: undo record updated (after undo/redo applied or on history load)
  UNDO_RECORD_UPDATED: "undoRecordUpdated",
  // Prompt undo — Webview → Extension: request to redo previously undone changes
  REDO_PROMPT_CHANGES: "redoPromptChanges",
  // Workflow undo — Webview → Extension: undo changes across multiple steps
  UNDO_WORKFLOW_CHANGES: "undoWorkflowChanges",
  // Workflow undo — Webview → Extension: redo changes across multiple steps
  REDO_WORKFLOW_CHANGES: "redoWorkflowChanges",

  // Terminal I/O — bidirectional between extension/server and webview
  TERMINAL_OUTPUT: "terminalOutput", // extension → webview: { workflowId, sessionId, data }
  TERMINAL_INPUT: "terminalInput", // webview → extension: { workflowId, sessionId, data }
  TERMINAL_RESIZE: "terminalResize", // webview → extension: { workflowId, sessionId, cols, rows }
  TERMINAL_STARTED: "terminalStarted", // extension → webview: { workflowId, sessionId, stepName, kind, harnessId?, promptNumber?, shellKind?, controllerClientId? } (also refreshes existing session metadata)
  TERMINAL_ENDED: "terminalEnded", // extension → webview: { workflowId, sessionId, kind, exitCode }
  TERMINAL_SPAWN_SHELL: "terminalSpawnShell", // webview → extension: { workflowId, cwd }
  TERMINAL_RESTART_SHELL: "terminalRestartShell", // webview → extension: { workflowId, sessionId }
  TERMINAL_CLOSE_SHELL: "terminalCloseShell", // webview → extension: { workflowId, sessionId }
  TERMINAL_CONTROLLER_CHANGED: "terminalControllerChanged", // broadcast: { workflowId, sessionId, controllerClientId: string | undefined }
  TERMINAL_CLAIM_CONTROL: "terminalClaimControl", // webview → extension: { workflowId, sessionId }
  TERMINAL_SIZE_CHANGED: "terminalSizeChanged", // extension → all: { workflowId, sessionId, cols, rows } — controller's PTY dimensions for viewer sync

  // Client identity — Extension → Webview once per connection
  CLIENT_ID_ASSIGNED: "clientIdAssigned", // { clientId: string }

  // Startup lifecycle — Extension → Webview
  STARTUP_COMPLETE: "startupComplete", // Extension → Webview: startup sequence done (with or without auto-load)

  // Developer dashboard actions — Webview → Extension (dev builds only)
  DEV_BUILD_EXTENSION: "dev:buildExtension",
  DEV_BUILD_ALL: "dev:buildAll",
  DEV_RELOAD_WINDOW: "dev:reloadWindow",
  DEV_RESTART_EXTENSION_HOST: "dev:restartExtensionHost",
  DEV_BUILD_EXTENSION_AND_RELOAD: "dev:buildExtensionAndReload",
  DEV_BUILD_ALL_AND_RELOAD: "dev:buildAllAndReload",
  DEV_REQUEST_STATUS: "dev:requestStatus",

  // Developer dashboard events — Extension → Webview (dev builds only)
  DEV_STATUS: "dev:status",
  DEV_BUILD_STARTED: "dev:buildStarted",
  DEV_BUILD_OUTPUT: "dev:buildOutput",
  DEV_BUILD_COMPLETED: "dev:buildCompleted",
  DEV_RESTARTING: "dev:restarting",
  DEV_COMMAND_UNAVAILABLE: "dev:commandUnavailable",
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
  SKIPPED: "skipped",
} as const;

// ============================================================================
// FINAL PROMPT PHASES - Runtime phase values for finalStep orchestration
// ============================================================================
export const FINAL_STEP_PHASES = {
  QUEUE: "queue",
  FINAL_STEP: "finalStep",
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
// CLIENT IDS - Well-known client identifiers for the dashboard viewer registry
// ============================================================================
/** The VS Code sidebar/panel client. Always registered at startup. */
export const PANEL_CLIENT_ID = "panel" as const;
/** Prefix for all browser WebSocket client IDs (e.g. "browser:1"). */
export const BROWSER_CLIENT_PREFIX = "browser:" as const;

// ============================================================================
// HARNESS IDS - Harness/framework modes for execution
// ============================================================================
export const HARNESS_IDS = {
  COPILOT_CLI: "copilot-cli",
  COPILOT_CHAT: "copilot-chat",
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
  OPENCODE_CLI: "opencode-cli",
  QWEN_CLI: "qwen-cli",
  GEMINI_CLI: "gemini-cli",
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
  [HARNESS_IDS.OPENCODE_CLI]: { name: "OpenCode CLI", shortName: "OpenCode" },
  [HARNESS_IDS.QWEN_CLI]: { name: "Qwen Code CLI", shortName: "Qwen Code" },
  [HARNESS_IDS.GEMINI_CLI]: { name: "Gemini CLI", shortName: "Gemini" },
} as const;

// ============================================================================
// EXECUTION MODES - Execution environment for CLI commands
// ============================================================================
export const EXECUTION_MODES = {
  INTERACTIVE: "interactive",
  HEADLESS: "headless",
} as const;

export type ExecutionMode =
  (typeof EXECUTION_MODES)[keyof typeof EXECUTION_MODES];

// ============================================================================
// DEFAULT MODELS - Default model per harness
// ============================================================================
export const DEFAULT_MODELS = {
  [HARNESS_IDS.COPILOT_CLI]: "claude-sonnet-4.6",
  [HARNESS_IDS.COPILOT_CHAT]: "claude-sonnet-4.6",
  [HARNESS_IDS.CLAUDE_CLI]: "sonnet",
  [HARNESS_IDS.CODEX_CLI]: "gpt-5.4",
  [HARNESS_IDS.OPENCODE_CLI]: "anthropic/claude-sonnet-4-6",
  [HARNESS_IDS.QWEN_CLI]: "coder-model",
  [HARNESS_IDS.GEMINI_CLI]: "gemini-2.5-pro",
} as const;

// ============================================================================
// MODEL OPTION VALUES - Sentinels used by model option lists
// ============================================================================
export const MODEL_OPTION_VALUES = {
  NONE: "none",
} as const;

// ============================================================================
// CLAUDE CLI MODELS - Static options (no programmatic way to query)
// ============================================================================
export const CLAUDE_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1M Context" },
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus 1M Context" },
  { value: "haiku", label: "Haiku" },
] as const;

// ============================================================================
// CODEX CLI MODELS - Static options (from codex /model command)
// ============================================================================
export const CODEX_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  { value: "gpt-5.4", label: "GPT 5.4" },
  { value: "gpt-5.2-codex", label: "GPT 5.2 Codex" },
  { value: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
  { value: "gpt-5.1-codex-max", label: "GPT 5.1 Codex Max" },
  { value: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
  { value: "gpt-5.2", label: "GPT 5.2" },
  { value: "gpt-5.1-codex-mini", label: "GPT 5.1 Codex Mini" },
] as const;

// ============================================================================
// QWEN CLI MODELS - Static options (from Qwen Code CLI documentation)
// ============================================================================
export const QWEN_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  { value: "coder-model", label: "Qwen Coder (Qwen 3.5 Plus)" },
] as const;

// ============================================================================
// GEMINI CLI MODELS - Static options (from Gemini CLI documentation)
// ============================================================================
export const GEMINI_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  { value: "gemini-3-pro-preview", label: "Gemini 3 Pro (Preview)" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
  {
    value: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite (Preview)",
  },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
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
// EDITOR TARGET KINDS - Selection target kinds for the prompt editor
// ============================================================================
export const EDITOR_TARGET_KINDS = {
  NEW_PROMPT: "newPrompt",
} as const;

// ============================================================================
// EDITOR PLACEHOLDER TEXT - Shared placeholder strings for CodeMirrorEditor
// ============================================================================
export const EDITOR_PLACEHOLDER_TEXT = {
  /** Base hint shown in all prompt editors */
  DEFAULT:
    "Use @ for files/folders, # for selections/symbols, ~ for git changes",
  /** Extended hint for the Final Step editor, explaining its loop-back behavior */
  FINAL_PROMPT:
    "Use @ for files/folders, # for selections/symbols, ~ for git changes\n\nNote: The Final Step runs after all other prompts complete. If it appends new prompts, it will run again once those finish.",
} as const;

// ============================================================================
// WORKFLOW ATTEMPT STATUS - Step-level attempt status values
// Tracks the lifecycle of a single execution attempt within WorkflowStateMachine.
// ============================================================================
export const WORKFLOW_ATTEMPT_STATUS = {
  RUNNING: "running",
  RETRYING: "retrying",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type WorkflowAttemptStatus =
  (typeof WORKFLOW_ATTEMPT_STATUS)[keyof typeof WORKFLOW_ATTEMPT_STATUS];

// ============================================================================
// PROMPT TERMINAL STATUS - Terminal (final) state values for prompt runtime
// Subset of STEP_STATUS values; absent or COMPLETED means successful completion.
// Used to restore correct visual status after a working file reload.
// ============================================================================
export const PROMPT_TERMINAL_STATUS = {
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
} as const;

export type PromptTerminalStatus =
  (typeof PROMPT_TERMINAL_STATUS)[keyof typeof PROMPT_TERMINAL_STATUS];

// ============================================================================
// INTERACTIVE ABORT KINDS - Discriminant values for InteractiveAbortState
// Classifies why an interactive CLI execution was aborted.
// ============================================================================
export const INTERACTIVE_ABORT_KINDS = {
  USER_CANCELLED: "user-cancelled",
  PROCESS_EXITED: "process-exited",
} as const;

export type InteractiveAbortKind =
  (typeof INTERACTIVE_ABORT_KINDS)[keyof typeof INTERACTIVE_ABORT_KINDS];

// ============================================================================
// TERMINAL SESSION STATUS - Status values for terminal sessions
// ============================================================================
export const TERMINAL_SESSION_STATUS = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// ============================================================================
// SESSION KINDS - Kind values for terminal sessions
// ============================================================================
export const SESSION_KINDS = {
  AI_CLI: "ai-cli",
  SHELL: "shell",
} as const;

// ============================================================================
// SHELL KINDS - Specific shell variant for SHELL sessions
// ============================================================================
export const SHELL_KINDS = {
  /** PowerShell 7+ (pwsh.exe) */
  PWSH: "pwsh",
  /** Windows PowerShell 5.1 fallback (powershell.exe) */
  POWERSHELL: "powershell",
  /** bash / zsh / sh or any Unix shell */
  BASH: "bash",
} as const;

export type ShellKind = (typeof SHELL_KINDS)[keyof typeof SHELL_KINDS];

// ============================================================================
// SESSION ID SENTINELS - Special sessionId values with reserved meanings
// ============================================================================
export const SESSION_ID_SENTINELS = {
  /**
   * Resume the session established by the most recent final step execution.
   * Works on any prompt (queue or finalStep phase): if a finalStep session
   * exists it is reused, otherwise a new session starts. Useful for workflows
   * where newly-appended queue prompts should continue the final step conversation.
   */
  FINAL_STEP: "finalStep",
} as const;

// ============================================================================
// PRIOR CONTEXT KEYWORDS - User-facing values for the priorContext field
// ============================================================================
export const PRIOR_CONTEXT_KEYWORDS = {
  ALL: "all",
  PREVIOUS: "previous",
  NONE: "none",
  /** All outputs from finalStep loop iterations. */
  FINAL_STEP_ALL: "finalStepAll",
  /** Most recent output from the finalStep loop. */
  FINAL_STEP_PREVIOUS: "finalStepPrevious",
} as const;

// ============================================================================
// PRIOR CONTEXT ITEM TYPES - Discriminant for PriorContextItem.type
// ============================================================================
export const PRIOR_CONTEXT_ITEM_TYPES = {
  /** Item originates from the finalStep phase (not a queue prompt). */
  FINAL_STEP: "finalStep",
} as const;

// ============================================================================
// GIT CHANGE KINDS - Kind values for ~diff/~staged/~stash/~commit refs
// ============================================================================
export const GIT_CHANGE_KINDS = {
  COMMIT: "commit",
  DIFF: "diff",
  STAGED: "staged",
  STASH: "stash",
} as const;

// ============================================================================
// STEP TYPES - Discriminant values for WorkflowStep union type
// ============================================================================
export const STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
} as const;

// ============================================================================
// CONDITION_ACTIONS - onPass/onFail action values for endCondition, preCondition, scriptStep
// ============================================================================
export const CONDITION_ACTIONS = {
  CONTINUE: "continue",
  STOP_WORKFLOW: "stopWorkflow",
  RETRY: "retry",
  SKIP_PROMPT: "skipPrompt",
} as const;

// ============================================================================
// COMPARE_SOURCES - compareSource values for script evaluation
// ============================================================================
export const COMPARE_SOURCES = {
  AUTO: "auto",
  STDOUT: "stdout",
  STDERR: "stderr",
  EXIT_CODE: "exitCode",
} as const;

// ============================================================================
// PROMPT PROPERTY NAMES - Single source of truth for PromptStep properties
// Used by dashboard.js to access prompt properties consistently
// ============================================================================
export const PROMPT_PROPERTIES = {
  // Core properties
  PROMPT: "prompt",
  ID: "id",
  NAME: "name",

  // Workflow-level properties (multi-step format)
  STEPS: "steps",
  FINAL_STEP: "finalStep",
  VARS: "vars",

  // Step type discriminant
  STEP_TYPE: "type",

  // Script step properties
  SCRIPT: "script",
  TIMEOUT: "timeout",
  COMPARE_SOURCE: "compareSource",
  RETURNS: "returns",
  ON_PASS: "onPass",
  ON_FAIL: "onFail",

  // Harness/Model properties
  HARNESS: "harness",
  MODEL: "model",
  AGENT: "agent",
  SKILLS: "skills",

  // Session properties
  RESUME_SESSION: "resumeSession",
  SESSION_ID: "sessionId",
  MCP_SERVERS: "mcpServers",
  HOOKS: "hooks",

  // End condition root
  END_CONDITION: "endCondition",
  // Pre-condition root
  PRE_CONDITION: "preCondition",

  // Context injection
  PRIOR_CONTEXT: "priorContext",

  // CLI overrides
  ADDITIONAL_ARGS: "additionalArgs",
  TOOL_PERMISSIONS: "toolPermissions",
} as const;

// End condition property names
export const END_CONDITION_PROPERTIES = {
  SCRIPT: "script",
  RETURNS: "returns",
  TIMEOUT: "timeout",
  MAX_RETRIES: "maxRetries",
  RETRY_PROMPT: "retryPrompt",
  RESUME_SESSION_ON_RETRY: "resumeSessionOnRetry",
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
// RUNNER IDS - Process runner identifiers written into workflow lock files
// ============================================================================
export const RUNNER_IDS = {
  VSCODE: "vscode",
  CLI: "cli",
  SERVER: "server",
} as const;

// ============================================================================
// PERMISSION MODES - Tool permission mode values
// ============================================================================
export const PERMISSION_MODES = {
  DANGEROUSLY_ALLOW_ALL: "dangerouslyAllowAll",
  ALLOW_ALL: "allowAll",
  CUSTOM: "custom",
  NONE: "none",
} as const;

export type PermissionMode =
  (typeof PERMISSION_MODES)[keyof typeof PERMISSION_MODES];

// ============================================================================
// LOCK STATUS - Status values returned by WorkflowLockManager.checkLock()
// ============================================================================
export const LOCK_STATUS = {
  NONE: "none",
  STALE: "stale",
  ACTIVE_VSCODE: "active-vscode",
  ACTIVE_CLI: "active-cli",
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
// ATTACHMENT PREFIXES - id namespace for <attachment> XML elements
// ============================================================================
export const ATTACHMENT_PREFIXES = {
  FILE: "file",
  SYMBOL: "symbol",
  DIRECTORY: "directory",
  SELECTION: "selection",
  GIT: "git", // git:diff, git:staged, git:stash:N, git:commit:<hash>
} as const;

// ============================================================================
// OUTPUT HISTORY KINDS - kind field values for OrderedHistoryEntry discriminated union
// ============================================================================
export const OUTPUT_HISTORY_KINDS = {
  CLI: "cli",
  STATUS: "status",
  RUNTIME: "runtime",
} as const;

// ============================================================================
// SNAPSHOT STRATEGIES - Workspace snapshot strategy values
// ============================================================================
export const SNAPSHOT_STRATEGIES = {
  GIT: "git",
  FILESYSTEM: "filesystem",
} as const;

// ============================================================================
// UNDO FILE ACTIONS - File restoration action discriminants
// ============================================================================
export const UNDO_FILE_ACTIONS = {
  DELETE: "delete",
  RESTORE_CONTENT: "restore-content",
  REVERSE_PATCH: "reverse-patch",
} as const;

// ============================================================================
// WORKFLOW ATTEMPT COMMANDS - command values for WorkflowAttemptCommand type
// ============================================================================
export const WORKFLOW_ATTEMPT_COMMANDS = {
  BEGIN: "beginAttempt",
  SCHEDULE_RETRY: "scheduleRetry",
  COMPLETE: "completeAttempt",
  FAIL: "failAttempt",
  CANCEL: "cancelAttempt",
} as const;

// ============================================================================
// DEFAULT WORKFLOW NAME - Placeholder used when no workflow has been named
// ============================================================================
export const DEFAULT_WORKFLOW_NAME = "New Workflow";

// ============================================================================
// TYPE HELPERS - For TypeScript type safety
// ============================================================================
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
export type ExecutionState =
  (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
export type FinalStepPhase =
  (typeof FINAL_STEP_PHASES)[keyof typeof FINAL_STEP_PHASES];
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
export type RunnerId = (typeof RUNNER_IDS)[keyof typeof RUNNER_IDS];
export type LockStatus = (typeof LOCK_STATUS)[keyof typeof LOCK_STATUS];
export type PriorContextKeyword =
  (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS];
export type PriorContextItemType =
  (typeof PRIOR_CONTEXT_ITEM_TYPES)[keyof typeof PRIOR_CONTEXT_ITEM_TYPES];
export type GitChangeKind =
  (typeof GIT_CHANGE_KINDS)[keyof typeof GIT_CHANGE_KINDS];
export type EditorTargetKind =
  (typeof EDITOR_TARGET_KINDS)[keyof typeof EDITOR_TARGET_KINDS];
export type TerminalSessionStatus =
  (typeof TERMINAL_SESSION_STATUS)[keyof typeof TERMINAL_SESSION_STATUS];
export type SessionKind = (typeof SESSION_KINDS)[keyof typeof SESSION_KINDS];
export type OutputHistoryKind =
  (typeof OUTPUT_HISTORY_KINDS)[keyof typeof OUTPUT_HISTORY_KINDS];
export type SnapshotStrategy =
  (typeof SNAPSHOT_STRATEGIES)[keyof typeof SNAPSHOT_STRATEGIES];
export type UndoFileAction =
  (typeof UNDO_FILE_ACTIONS)[keyof typeof UNDO_FILE_ACTIONS];
export type WorkflowAttemptCommandValue =
  (typeof WORKFLOW_ATTEMPT_COMMANDS)[keyof typeof WORKFLOW_ATTEMPT_COMMANDS];
export type StepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
export type ConditionAction =
  (typeof CONDITION_ACTIONS)[keyof typeof CONDITION_ACTIONS];
export type CompareSource =
  (typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES];
