/**
 * Shared constants for ctrlyoke Dashboard
 * SINGLE SOURCE OF TRUTH for all message types, states, and status values
 * Used by both TypeScript extension code AND JavaScript webview code
 */

import {
  CLAUDE_CLI_MODELS as MC_CLAUDE_CLI_MODELS,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODELS as MC_CODEX_CLI_MODELS,
  CODEX_CLI_MODEL_LABELS,
  ANTIGRAVITY_CLI_MODELS as MC_ANTIGRAVITY_CLI_MODELS,
  ANTIGRAVITY_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";

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
  CONTEXT_WINDOW_UPDATE: "contextWindowUpdate", // Live context window usage update (extension -> webview)
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
  INSERT_WORKFLOW_STEP: "insertWorkflowStep", // Insert a fully-shaped workflow step after a selected index
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
  TOGGLE_WORKFLOW_FAVORITE: "toggleWorkflowFavorite", // Webview -> Extension: Toggle favorite on a recent workflow entry { filePath }

  // Settings view messages
  CHANGE_MODEL: "changeModel",
  CHANGE_AGENT: "changeAgent",
  CHANGE_MCP_SERVERS: "changeMcpServers",
  CHANGE_RESUME_SESSION: "changeResumeSession",
  OPEN_SETTINGS: "openSettings", // Open VS Code settings for ctrlyoke
  OPEN_VSCODE_MCP_BROWSER: "openVscodeMcpBrowser", // Webview -> Extension: Open VS Code's native MCP server browser
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate", // Refresh model lists after registry loads
  HARNESS_STATUS_UPDATE: "harnessStatusUpdate", // Update harness availability
  AGENTS_UPDATE: "agentsUpdate", // Update available agents list
  SKILLS_UPDATE: "skillsUpdate", // Update available skills list
  GLOBAL_SETTINGS_UPDATED: "globalSettingsUpdated", // Extension -> Webview: Config changed, update settings only (no workflow reset)
  GLOBAL_SETTINGS_LOAD_REQUEST: "globalSettingsLoadRequest", // Webview -> Extension: Request full settings payload
  GLOBAL_SETTINGS_LOADED: "globalSettingsLoaded", // Extension -> Webview: Full settings payload + sources
  UPDATE_GLOBAL_SETTING: "updateGlobalSetting", // Webview -> Extension: { path, value, scope }
  GLOBAL_SETTING_UPDATED: "globalSettingUpdated", // Extension -> Webview: { path, value, source } acknowledgment
  COMMIT_MESSAGE_GENERATION_UPDATED: "commitMessageGenerationUpdated", // Extension -> Webview: Latest real git diff input used for commit generation
  GET_CONFIG: "getConfig", // Webview -> Extension: Request config value
  UPDATE_CONFIG: "updateConfig", // Webview -> Extension: Update config value
  CONFIG_VALUE: "configValue", // Extension -> Webview: Send config value
  BROWSE_AND_ADD_EXTERNAL_ROOT: "browseAndAddExternalRoot", // Webview -> Extension: { scope } OS folder picker, appends result to permissions.allowedExternalFileRoots for that scope

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
  CREATE_CUSTOM_TEMPLATE: "createCustomTemplate", // { name, scope } — fully webview-driven, no native VS Code UI
  BROWSE_TEMPLATE_FILE: "browseTemplateFile", // Request OS file picker for a template variable

  // New Workflow Modal - Extension -> Webview
  TEMPLATE_FILE_SELECTED: "templateFileSelected", // OS file picker result for a template variable
  CUSTOM_TEMPLATE_CREATED: "customTemplateCreated", // { templates, templateId } on success, or { error }

  // CodeMirror editor - Webview <-> Extension
  REQUEST_COMPLETIONS: "requestCompletions", // Request autocomplete suggestions
  COMPLETIONS_RESPONSE: "completionsResponse", // Return autocomplete suggestions
  OPEN_FILE: "openFile", // Open file from #file: link
  OPEN_GIT_CHANGE: "openGitChange", // Webview -> Extension: open a git diff in a new editor (legacy)
  OPEN_PRIOR_CONTEXT: "openPriorContext", // Webview -> Extension: preview inline $prior-context expansion (legacy)
  // REQUEST_GIT_CHANGE_PREVIEW and GIT_CHANGE_PREVIEW_RESULT removed — browser now opens
  // the WorkspaceDiffPane via openToGitRef(); VS Code uses OPEN_GIT_CHANGE → native commands.
  REQUEST_PRIOR_CONTEXT_PREVIEW: "requestPriorContextPreview", // Webview -> Extension: request prior-context XML for preview modal
  PRIOR_CONTEXT_PREVIEW_RESULT: "priorContextPreviewResult", // Extension -> Webview: { ref, content } XML for modal
  EXPORT_CONTENT_PREVIEW: "exportContentPreview", // Webview -> Extension: open preview content in VS Code editor
  VALIDATE_FILE_REF: "validateFileRef", // Webview -> Extension: Check if a file-ref path resolves
  FILE_REF_VALIDATION: "fileRefValidation", // Extension -> Webview: { exists: boolean, filePath: string }
  VALIDATE_CONTEXT_REFS: "validateContextRefs", // Webview -> Extension: Validate inline @/#/~ context references
  CONTEXT_REFS_VALIDATION: "contextRefsValidation", // Extension -> Webview: Inline context reference validation results
  INSERT_PROMPT_REFERENCES: "insertPromptReferences", // Extension -> Webview: insert raw context references into the live prompt editor

  // Image paste - Webview <-> Extension
  SAVE_PASTED_IMAGE: "savePastedImage", // Webview -> Extension: save a pasted clipboard image to disk
  PASTED_IMAGE_SAVED: "pastedImageSaved", // Extension -> Webview: { seq, relativePath } or { seq, error }
  REQUEST_FILE_PREVIEW_URI: "requestFilePreviewUri", // Webview -> Extension: resolve a workspace file path to a displayable webview URI
  FILE_PREVIEW_URI_RESPONSE: "filePreviewUriResponse", // Extension -> Webview: { seq, uri } or { seq, error }

  // Token counting - Webview -> Extension: Request token counts for attachment references
  REQUEST_ATTACHMENT_TOKEN_COUNTS: "requestAttachmentTokenCounts",
  // Extension -> Webview: Return token counts for requested references
  ATTACHMENT_TOKEN_COUNTS_RESPONSE: "attachmentTokenCountsResponse",

  // Output history messages
  OUTPUT_HISTORY_LOADED: "outputHistoryLoaded", // Extension -> Webview: Load history for display
  LOAD_RUN_VIEW: "loadRunView", // Webview -> Extension: Switch this client's displayed draft/run
  LOAD_RUN_SUMMARIES: "loadRunSummaries", // Webview -> Extension: Fetch another lineage's run list (summary-only, no view switch)
  RUN_SUMMARIES_LOADED: "runSummariesLoaded", // Extension -> Webview: Manifest-only run listing for one lineage, request-correlated
  SEARCH_HISTORY: "searchHistory", // Webview -> Extension: Search global run history
  SEARCH_HISTORY_RESULTS: "searchHistoryResults", // Extension -> Webview: Return global history matches
  OPEN_HISTORY_SEARCH: "openHistorySearch", // Extension -> Webview: Open global history search UI
  DELETE_RUN_HISTORY: "deleteRunHistory", // Webview -> Extension: Delete a single run by address, any run in the lineage (not required to be the viewed run)
  DELETE_ALL_RUNS_FOR_LINEAGE: "deleteAllRunsForLineage", // Webview -> Extension: Delete every non-executing run of an explicit lineage (run-navigation panel's "Delete all runs")
  RUN_VIEW_LOADED: "runViewLoaded", // Extension -> Webview: Atomic definition/settings/output snapshot for a view address
  WORKFLOW_VIEW_IDENTITY: "workflowViewIdentity", // Extension -> Webview: Authoritative address + revisions after a definition write
  WORKFLOW_ACTION_FAILED: "workflowActionFailed", // Extension -> Webview: { action, error, requestId? } an addressed view/mutation/run action was rejected

  // Save Workflow - Webview <-> Extension
  SAVE_WORKFLOW_REQUEST: "saveWorkflowRequest", // Webview -> Extension: Request default save path/format
  SAVE_WORKFLOW_DIALOG_DATA: "saveWorkflowDialogData", // Extension -> Webview: Default path, format
  CHECK_SAVE_PATH: "checkSavePath", // Webview -> Extension: Check whether an export destination already exists
  SAVE_PATH_CHECKED: "savePathChecked", // Extension -> Webview: Addressed export destination check result
  SAVE_WORKFLOW: "saveWorkflow", // Webview -> Extension: { filePath, format } confirmed by user
  WORKFLOW_SAVED: "workflowSaved", // Extension -> Webview: { filePath } success
  WORKFLOW_SAVE_FAILED: "workflowSaveFailed", // Extension -> Webview: { error } failure
  SAVE_WORKFLOW_AS_TEMPLATE: "saveWorkflowAsTemplate", // Webview -> Extension: { name, scope } — snapshot current workflow as a custom template
  WORKFLOW_SAVED_AS_TEMPLATE: "workflowSavedAsTemplate", // Extension -> Webview: { templates, templateId } success (failure reuses WORKFLOW_SAVE_FAILED)
  BROWSE_SAVE_LOCATION: "browseSaveLocation", // Webview -> Extension: Request OS folder picker for the Save As location (VS Code panel only)
  SAVE_LOCATION_SELECTED: "saveLocationSelected", // Extension -> Webview: OS folder picker result { path }

  // Multi-workflow coordination — Extension → Webview
  WORKFLOWS_LIST: "workflowsList", // Full list of loaded WorkflowSummary[]
  WORKFLOW_ADDED: "workflowAdded", // New workflow loaded: { summary: WorkflowSummary }
  WORKFLOW_DISMISSED: "workflowDismissed", // Workflow removed: { workflowId }
  WORKFLOW_SUMMARY_UPDATED: "workflowSummaryUpdated", // Execution state changed: { summary: WorkflowSummary }
  ACTIVE_WORKFLOW_CHANGED: "activeWorkflowChanged", // Active selection changed: { workflowId }

  // VS Code-hosted server — Extension → Webview
  SERVER_STARTED: "serverStarted", // Server started: { url: string }
  SERVER_STOPPED: "serverStopped", // Server stopped
  SERVER_TOKEN_REGENERATED: "serverTokenRegenerated", // Token deleted; restart server to apply new token

  // VS Code-hosted server — Webview → Extension
  REGENERATE_SERVER_TOKEN: "regenerateServerToken", // Request token regeneration
  GENERATE_SERVER_CERT: "generateServerCert", // Request self-signed cert generation → .ctrlyoke/certs/

  // VS Code-hosted server — Extension → Webview
  SERVER_CERT_GENERATED: "serverCertGenerated", // Cert generated; settings updated with new paths

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

  // Stable run lifecycle controls — Webview → Extension
  EXECUTE_DRAFT: "executeDraft",
  SEED_NEW_RUN: "seedNewRun",
  START_NEW_RUN_INSTEAD: "startNewRunInstead",
  CONTINUE_RUN: "continueRun",
  APPEND_AND_CONTINUE_RUN: "appendAndContinueRun",
  PAUSE_RUN: "pauseRun",
  CANCEL_PAUSE_RUN: "cancelPauseRun",
  RESUME_RUN: "resumeRun",
  STOP_RUN: "stopRun",
  STOP_CLI_RUN: "stopCliRun", // Kill the CLI process for a CLI-managed workflow: { workflowId }

  // Recent workflow management — Webview → Extension
  REMOVE_WORKFLOW_HISTORY: "removeWorkflowHistory", // Remove single history entry: { filePath }

  // MCP Manager — Webview ↔ Extension
  REQUEST_MCP_REGISTRY_SERVERS: "requestMcpRegistryServers", // Webview -> Extension: Load merged workspace+user ctrlyoke MCP registry
  SAVE_MCP_REGISTRY_SERVER: "saveMcpRegistryServer", // Webview -> Extension: Save one MCP registry entry { server, scope }
  DELETE_MCP_REGISTRY_SERVER: "deleteMcpRegistryServer", // Webview -> Extension: Delete one MCP registry entry { id, scope }
  REQUEST_MCP_LOCAL_SCAN: "requestMcpLocalScan", // Webview -> Extension: Scan local harness MCP configs for manager import
  REQUEST_MCP_REGISTRY_SEARCH: "requestMcpRegistrySearch", // Webview -> Extension: Search MCP registry for manager import
  EXPORT_MCP_TO_HARNESS: "exportMcpToHarness", // Webview -> Extension: Export managed MCP servers to a harness config
  DELETE_MCP_FROM_HARNESS: "deleteMcpFromHarness", // Webview -> Extension: Remove one or more MCP servers from a harness config
  MCP_REGISTRY_SERVERS_UPDATE: "mcpRegistryServersUpdate", // Extension -> Webview: { servers: ManagedMcpServer[] }
  MCP_LOCAL_SCAN_RESULT: "mcpLocalScanResult", // Extension -> Webview: { servers: LocalMcpServerEntry[], error? }
  MCP_REGISTRY_SEARCH_RESULT: "mcpRegistrySearchResult", // Extension -> Webview: { servers: RegistryMcpEntry[], nextCursor?, error? }

  // Harness File Manager — Webview ↔ Extension
  REQUEST_HARNESS_FILES: "requestHarnessFiles", // Webview -> Extension: { fileType: "agent" | "skill" }
  HARNESS_FILES_RESULT: "harnessFilesResult", // Extension -> Webview: { files: ManagedFile[] }
  EXPORT_TO_HARNESS: "exportToHarness", // Webview -> Extension: { sourcePath, harnessId, fileType, overwrite? }
  IMPORT_TO_CTRLYOKE: "importToCtrlYoke", // Webview -> Extension: { sourcePath, fileType, overwrite? }
  DELETE_FROM_HARNESS: "deleteFromHarness", // Webview -> Extension: { name, harnessId, fileType }
  SYNC_ALL_TO_HARNESS: "syncAllToHarness", // Webview -> Extension: { files, targetHarnessId, fileType }
  DELETE_ALL_FROM_HARNESS: "deleteAllFromHarness", // Webview -> Extension: { harnessId, fileType }
  HARNESS_FILE_OP_RESULT: "harnessFileOpResult", // Extension -> Webview: { success, error?, files? }
  OPEN_HARNESS_DIR: "openHarnessDir", // Webview -> Extension: { harnessId, fileType }
  OPEN_HARNESS_DIR_RESULT: "openHarnessDirResult", // Extension -> Webview: { success, error? }

  // Settings — Webview → Extension
  UPDATE_CONFIRM_DELETE: "updateConfirmDelete", // Update confirmDeleteOperations setting: { value: boolean }
  UPDATE_CONFIRM_CONTINUATION_DISCARD: "updateConfirmContinuationDiscard", // Update confirmContinuationDiscardOperations setting: { value: boolean }

  // Queue Position Control — Webview → Extension
  SET_START_POSITION: "setStartPosition",
  DISCARD_CONTINUATION: "discardContinuation",
  REORDER_PROMPTS: "reorderPrompts",
  UPDATE_CONFIRM_RESET: "updateConfirmReset",

  // Queue Position Control — Extension → Webview
  REORDER_PROMPTS_CONFIRMED: "reorderPromptsConfirmed",
  SUFFIX_EDIT_CONFIRMATION_REQUIRED: "suffixEditConfirmationRequired", // discardContinuation/startNewRunInstead hit unsaved rewound-suffix edits; { action, address, expectedDefinitionRevision, expectedDescriptorRevision }. Rendered as an in-app modal (never a native OS dialog) so hosted browser clients see it too.

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
  TERMINAL_CLOSE_AI_CLI: "terminalCloseAiCli", // webview → extension: { workflowId, sessionId } — kills the still-running PTY when user dismisses a completed AI session
  TERMINAL_CONTROLLER_CHANGED: "terminalControllerChanged", // broadcast: { workflowId, sessionId, controllerClientId: string | undefined }
  TERMINAL_CLAIM_CONTROL: "terminalClaimControl", // webview → extension: { workflowId, sessionId }
  TERMINAL_SIZE_CHANGED: "terminalSizeChanged", // extension → all: { workflowId, sessionId, cols, rows } — controller's PTY dimensions for viewer sync
  TERMINAL_VIEWPORT_HINT: "terminalViewportHint", // webview → extension: { workflowId, sessionId, cols, rows } — controller's current viewport size (incl. while frozen/ended), used as the spawn size for the NEXT PTY so a harness paints its first frame at the real width. Change-gated on the webview.
  ACTIVE_TERMINAL_WORKFLOWS: "activeTerminalWorkflows", // extension → all: { workflows: { workflowId, workingFilePath? }[] } — global set of workflows with ≥1 running PTY, so every client can show the dropdown terminal icon regardless of which workflow it is currently viewing

  // Client identity — Extension → Webview once per connection
  CLIENT_ID_ASSIGNED: "clientIdAssigned", // { clientId: string }

  // Hosted browser connection liveness — handled by standalone-shim.js and
  // CtrlYokeHostedServer before messages enter the normal webview router.
  HOSTED_CONNECTION_HEARTBEAT: "hostedConnectionHeartbeat", // bidirectional probe: { id: string, sentAt: number }
  HOSTED_CONNECTION_HEARTBEAT_ACK: "hostedConnectionHeartbeatAck", // bidirectional response: { id: string }

  // Startup lifecycle — Extension → Webview
  STARTUP_COMPLETE: "startupComplete", // Extension → Webview: startup sequence done (with or without auto-load)
  WORKSPACE_INIT_REQUIRED: "workspaceInitRequired", // Extension → Webview: ctrlyoke not yet initialized in this workspace

  // Workspace trust — Webview → Extension
  INITIALIZE_WORKSPACE: "initializeWorkspace", // Webview → Extension: user approved ctrlyoke initialization

  // First-install layout tip — Extension ↔ Webview
  SHOW_LAYOUT_TIP: "showLayoutTip", // Extension → Webview: show first-install panel placement tip (first install only)
  LAYOUT_TIP_DISMISSED: "layoutTipDismissed", // Webview → Extension: user dismissed the layout tip; resume startup

  // Developer dashboard actions — Webview → Extension (dev builds only)
  DEV_BUILD_EXTENSION: "dev:buildExtension",
  DEV_BUILD_WEBVIEW: "dev:buildWebview",
  DEV_BUILD_ALL: "dev:buildAll",
  DEV_RELOAD_WINDOW: "dev:reloadWindow",
  DEV_RESTART_EXTENSION_HOST: "dev:restartExtensionHost",
  DEV_BUILD_EXTENSION_AND_RELOAD: "dev:buildExtensionAndReload",
  DEV_BUILD_WEBVIEW_AND_RELOAD: "dev:buildWebviewAndReload",
  DEV_BUILD_ALL_AND_RELOAD: "dev:buildAllAndReload",
  DEV_RUN_TESTS: "dev:runTests",
  DEV_SEND_TEST_NOTIFICATION: "dev:sendTestNotification",
  DEV_REQUEST_STATUS: "dev:requestStatus",

  // UX Snapshot capture — Webview → Extension (dev builds only)
  // Carries `markdown` (and optional `png`) serialized from the live UI; the
  // extension host writes it to .ctrlyoke/snapshots/. Distinct from the
  // routeDevAction commands above because it carries a payload.
  UX_SNAPSHOT_CAPTURE: "dev:uxSnapshotCapture",
  // UX Snapshot saved — Extension → Webview (dev builds only): carries the
  // workspace-relative `path` written, or an `error` string on failure.
  UX_SNAPSHOT_SAVED: "dev:uxSnapshotSaved",

  // Developer dashboard events — Extension → Webview (dev builds only)
  DEV_STATUS: "dev:status",
  DEV_BUILD_STARTED: "dev:buildStarted",
  DEV_BUILD_OUTPUT: "dev:buildOutput",
  DEV_BUILD_COMPLETED: "dev:buildCompleted",
  DEV_RESTARTING: "dev:restarting",
  DEV_COMMAND_UNAVAILABLE: "dev:commandUnavailable",

  // Extension -> Webview: sent by resolveWebviewView() so a retained webview
  // re-sends READY after an extension host restart
  RECONNECT: "reconnect",

  // Browser notification flow — bidirectional
  /** Webview -> Extension: check current browser notification permission state */
  BROWSER_NOTIFICATION_STATUS_REQUEST: "browserNotificationStatusRequest",
  /** Extension -> Webview: current browser notification permission state */
  BROWSER_NOTIFICATION_STATUS: "browserNotificationStatus",
  /** Webview -> Extension: request browser notification permission */
  BROWSER_NOTIFICATION_PERMISSION_REQUEST:
    "browserNotificationPermissionRequest",
  /** Extension -> Webview: result of browser notification permission request */
  BROWSER_NOTIFICATION_PERMISSION_RESULT: "browserNotificationPermissionResult",
  /** Extension/Hosted server -> Webview: structured completion notification event */
  NOTIFICATION_EVENT: "notificationEvent",
} as const;

// ============================================================================
// NOTIFICATION EVENT MODES - When to fire workflow/prompt completion notifications
// ============================================================================
export const NOTIFICATION_EVENT_MODES = {
  ALL: "all",
  FAILURES_ONLY: "failuresOnly",
  NEVER: "never",
} as const;

export type NotificationEventMode =
  (typeof NOTIFICATION_EVENT_MODES)[keyof typeof NOTIFICATION_EVENT_MODES];

// ============================================================================
// BROWSER NOTIFICATION MODES - Whether/how browser notifications are delivered
// ============================================================================
export const BROWSER_NOTIFICATION_MODES = {
  CONNECTED_ONLY: "connectedOnly",
  PUSH: "push",
  NEVER: "never",
} as const;

export type BrowserNotificationMode =
  (typeof BROWSER_NOTIFICATION_MODES)[keyof typeof BROWSER_NOTIFICATION_MODES];

export const SERVICE_WORKER_BADGE_MESSAGE_TYPES = {
  INCREMENT_NOTIFICATION_BADGE: "ctrlyoke:incrementNotificationBadge",
  CLEAR_NOTIFICATION_BADGE: "ctrlyoke:clearNotificationBadge",
} as const;

export type ServiceWorkerBadgeMessageType =
  (typeof SERVICE_WORKER_BADGE_MESSAGE_TYPES)[keyof typeof SERVICE_WORKER_BADGE_MESSAGE_TYPES];

/**
 * Shared timing contract for hosted-browser WebSocket liveness. The raw
 * standalone shim receives these values through HostedStandaloneShimScript so
 * the server and browser cannot silently drift to incompatible thresholds.
 */
export const HOSTED_CONNECTION_LIVENESS = {
  HEARTBEAT_INTERVAL_MS: 30_000,
  SERVER_APPLICATION_ACK_TIMEOUT_MS: 60_000,
  CLIENT_STALE_TIMEOUT_MS: 45_000,
  CLIENT_WATCHDOG_INTERVAL_MS: 5_000,
  FOREGROUND_PROBE_TIMEOUT_MS: 8_000,
  BACKGROUND_REVALIDATE_MS: 30_000,
} as const;

export const HOSTED_ICON_FILES = {
  APP_ICON_PNG: "icon.png",
  // Transparent-background SVG used in the web app manifest and as the SVG apple-touch-icon.
  // iOS 26+ supports SVG for home screen icons and uses manifest icons for web apps.
  // Transparent background is required for iOS 26 Liquid Glass / Clear appearance mode;
  // a solid opaque background causes iOS 26 to fall back to a generic placeholder icon.
  APP_ICON_SVG: "ctrlyoke-app-icon.svg",
  // The favicon / SCM-toolbar contexts are too small for the standard mark (the ctrl→yoke "Y"
  // is lost), so they use a dedicated "simple" mark. Same 2-token recolor contract as the app icon.
  FAVICON_PNG: "ctrlyoke-icon-simple-color.png",
  FAVICON_SVG: "ctrlyoke-icon-simple-color.svg",
  // 180x180 PNG for the apple-touch-icon HTML link (used by the Add-to-Home-Screen preview
  // and as a PNG fallback for older iOS versions).
  APPLE_TOUCH_ICON_PNG: "apple-touch-icon.png",
} as const;

export const HOSTED_ICON_PATHS = {
  APP_ICON_PNG: `/${HOSTED_ICON_FILES.APP_ICON_PNG}`,
  // Dynamic SVG routes — served by CtrlYokeHostedServer with configurable colors.
  APP_ICON_SVG: `/app-icon.svg`,
  FAVICON_PNG: `/${HOSTED_ICON_FILES.FAVICON_PNG}`,
  // Dynamic SVG route — served by CtrlYokeHostedServer with configurable colors.
  FAVICON_SVG: `/favicon.svg`,
  APPLE_TOUCH_ICON_PNG: `/${HOSTED_ICON_FILES.APPLE_TOUCH_ICON_PNG}`,
} as const;

// ============================================================================
// COMPLETION NOTIFICATION KINDS - Structured completion event categories
// ============================================================================
export const COMPLETION_NOTIFICATION_KINDS = {
  WORKFLOW: "workflow",
  PROMPT: "prompt",
} as const;

export type CompletionNotificationKind =
  (typeof COMPLETION_NOTIFICATION_KINDS)[keyof typeof COMPLETION_NOTIFICATION_KINDS];

// ============================================================================
// COMPLETION NOTIFICATION SEVERITY - Visual/system notification level
// ============================================================================
export const COMPLETION_NOTIFICATION_SEVERITY = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

export type CompletionNotificationSeverity =
  (typeof COMPLETION_NOTIFICATION_SEVERITY)[keyof typeof COMPLETION_NOTIFICATION_SEVERITY];

// ============================================================================
// NOTIFICATION KINDS - Superset of completion notification kinds (includes hook events)
// ============================================================================
export const NOTIFICATION_KINDS = {
  WORKFLOW: COMPLETION_NOTIFICATION_KINDS.WORKFLOW,
  PROMPT: COMPLETION_NOTIFICATION_KINDS.PROMPT,
  HOOK: "hook",
} as const;

export type NotificationKind =
  (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];

// ============================================================================
// EXECUTION STATES - QueueState.status values
// ============================================================================
export const EXECUTION_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSING: "pausing", // Pause requested; will pause after the current step completes
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
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
  OPENCODE_CLI: "opencode-cli",
  QWEN_CLI: "qwen-cli",
  ANTIGRAVITY_CLI: "antigravity-cli",
} as const;

// ============================================================================
// HARNESS INFO - Display names and labels per harness
// ============================================================================
export const HARNESS_INFO = {
  [HARNESS_IDS.COPILOT_CLI]: { name: "Copilot CLI", shortName: "Copilot CLI" },
  [HARNESS_IDS.CLAUDE_CLI]: { name: "Claude Code", shortName: "Claude Code" },
  [HARNESS_IDS.CODEX_CLI]: { name: "Codex", shortName: "Codex" },
  [HARNESS_IDS.OPENCODE_CLI]: { name: "OpenCode", shortName: "OpenCode" },
  [HARNESS_IDS.QWEN_CLI]: { name: "Qwen Code", shortName: "Qwen Code" },
  [HARNESS_IDS.ANTIGRAVITY_CLI]: {
    name: "Antigravity CLI",
    shortName: "Antigravity",
  },
} as const;

// ============================================================================
// HOOK EVENT - Logical hook event names and metadata
// ============================================================================

/**
 * Logical hook event names — mapped to CLI-specific event names at inject time.
 *
 * | Logical name        | Claude/Qwen      | Copilot CLI         | Antigravity CLI | Codex             | OpenCode                |
 * |---------------------|------------------|---------------------|------------------|-------------------|-------------------------|
 * | "stop"              | Stop             | agentStop           | Stop             | Stop              | session.status { idle } |
 * | "sessionStart"      | SessionStart     | sessionStart        | PreInvocation    | SessionStart      | session.created         |
 * | "preToolUse"        | PreToolUse       | preToolUse          | PreToolUse       | PreToolUse        | tool.execute.before     |
 * | "postToolUse"       | PostToolUse      | postToolUse         | PostToolUse      | PostToolUse       | tool.execute.after      |
 * | "userPromptSubmit"  | UserPromptSubmit | userPromptSubmitted | n/a              | UserPromptSubmit  | session.status { busy } |
 * | "permissionRequest" | PermissionRequest| permissionRequest   | n/a              | PermissionRequest | permission.asked        |
 */
export type HookEvent =
  | "stop"
  | "sessionStart"
  | "preToolUse"
  | "postToolUse"
  | "userPromptSubmit"
  | "permissionRequest"
  | "error";

export interface HookEventMetadata {
  event: HookEvent;
  label: string;
  description: string;
  /** Harnesses that fire this event. */
  supportedHarnesses: HarnessId[];
}

export const HOOK_EVENT_ORDER: HookEvent[] = [
  "stop",
  "sessionStart",
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "permissionRequest",
  "error",
];

export const HOOK_EVENT_METADATA: HookEventMetadata[] = [
  {
    event: "stop",
    label: "Stop",
    description: "Fires when the AI agent finishes responding.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
  {
    event: "sessionStart",
    label: "Session Start",
    description: "Fires when a new AI session is created.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
  {
    event: "preToolUse",
    label: "Pre Tool Use",
    description: "Fires before the AI invokes a tool.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
  {
    event: "postToolUse",
    label: "Post Tool Use",
    description: "Fires after the AI receives the result of a tool call.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
  {
    event: "userPromptSubmit",
    label: "User Prompt Submit",
    description: "Fires when a user prompt is submitted to the AI.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
  {
    event: "permissionRequest",
    label: "Permission Request",
    description: "Fires when the AI requests permission to perform an action.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
  {
    event: "error",
    label: "Error",
    description: "Fires when the harness reports a session-level error.",
    supportedHarnesses: [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ],
  },
];

// ============================================================================
// EXECUTION MODES - Execution environment for CLI commands
// ============================================================================
export const EXECUTION_MODES = {
  INTERACTIVE: "interactive",
  HEADLESS: "headless",
} as const;

export type ExecutionMode =
  (typeof EXECUTION_MODES)[keyof typeof EXECUTION_MODES];

export const EXECUTION_MODE_OPTIONS = [
  { value: EXECUTION_MODES.INTERACTIVE, label: "Interactive" },
  { value: EXECUTION_MODES.HEADLESS, label: "Headless" },
];

export const EXECUTION_MODE_HELP_TEXT =
  "Interactive spawns a live terminal you can steer; headless runs in the background with output in the Output panel. Pre- and end-condition scripts always run headless. With inject mode on, inserting a headless step between interactive steps retires and respawns the PTY, so TUI continuity is lost across that boundary.";

// ============================================================================
// DEFAULT MODELS - Default model per harness
// ============================================================================
export const DEFAULT_MODELS = {
  [HARNESS_IDS.COPILOT_CLI]: "claude-sonnet-4.6",
  [HARNESS_IDS.CLAUDE_CLI]: "sonnet",
  [HARNESS_IDS.CODEX_CLI]: "gpt-5.4",
  [HARNESS_IDS.OPENCODE_CLI]: "anthropic/claude-sonnet-4-6",
  [HARNESS_IDS.QWEN_CLI]: "qwen3.5-plus",
  // Gemini Flash, not agy's own Claude Sonnet default: the Sonnet tier has a
  // small individual quota that a single run can exhaust for ~28h, which would
  // block unrelated work for anyone who never picks a model explicitly.
  [HARNESS_IDS.ANTIGRAVITY_CLI]: "gemini-3.6-flash-medium",
} as const;

// ============================================================================
// MODEL OPTION VALUES - Sentinels used by model option lists
// ============================================================================
export const MODEL_OPTION_VALUES = {
  NONE: "none",
} as const;

// ============================================================================
// CLI MODEL OPTION LISTS - Derived from ModelConstants (single source of truth)
// Each list includes a leading "None" option for the settings UI.
// ============================================================================
export const CLAUDE_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  ...MC_CLAUDE_CLI_MODELS.map((id) => ({
    value: id,
    label: CLAUDE_CLI_MODEL_LABELS[id] ?? id,
  })),
];

export const CODEX_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  ...MC_CODEX_CLI_MODELS.map((id) => ({
    value: id,
    label: CODEX_CLI_MODEL_LABELS[id] ?? id,
  })),
];

export const ANTIGRAVITY_CLI_MODELS = [
  { value: MODEL_OPTION_VALUES.NONE, label: "None" },
  ...MC_ANTIGRAVITY_CLI_MODELS.map((id) => ({
    value: id,
    label: ANTIGRAVITY_CLI_MODEL_LABELS[id] ?? id,
  })),
];

// ============================================================================
// HARNESS STATUS STRINGS - Status values for harness availability
// ============================================================================
export const HARNESS_STATUS_STRINGS = {
  CHECKING: "checking",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
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
// PROMPT EDITOR INSERT MODES - How external reference insertions are applied
// ============================================================================
export const PROMPT_EDITOR_INSERT_MODES = {
  INSERT: "insert",
  APPEND: "append",
} as const;

// ============================================================================
// EDITOR PLACEHOLDER TEXT - Shared placeholder strings for CodeMirrorEditor
// ============================================================================
export const EDITOR_PLACEHOLDER_TEXT = {
  /** Base hint shown in all prompt editors */
  DEFAULT:
    "Use @ for files/folders, # for selections/symbols, ~ for git changes, $ for prior context",
  /** Extended hint for the Final Step editor, explaining its loop-back behavior */
  FINAL_PROMPT:
    "Use @ for files/folders, # for selections/symbols, ~ for git changes, $ for prior context\n\nNote: The Final Step runs after all other prompts complete. If it appends new prompts, it will run again once those finish.",
} as const;

// ============================================================================
// IMAGE PASTE - Shared contract for clipboard-image paste support
// Single-sourced so the webview paste handler (pre-check) and the extension
// host save handler (validation) agree on accepted types and limits.
// ============================================================================

/** Accepted clipboard image MIME types → on-disk file extension. */
export const PASTED_IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Maximum size (in bytes) of a pasted image accepted for save (15 MB). */
export const MAX_PASTED_IMAGE_BYTES = 15 * 1024 * 1024;

/** File extensions rendered as inline thumbnails in the output pane. */
export const IMAGE_REF_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
] as const;

/** Placeholder inserted at the cursor while a pasted image saves asynchronously. */
export const PASTING_IMAGE_PLACEHOLDER = "[Pasting image…]";

/** Milliseconds before an unanswered SAVE_PASTED_IMAGE round trip is treated as failed. */
export const PASTED_IMAGE_SAVE_TIMEOUT_MS = 30_000;

/**
 * Map a clipboard MIME type to its on-disk extension, or `undefined` if the
 * type is not an accepted image type.
 */
export function mimeTypeToImageExtension(
  mimeType: string | undefined
): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  return PASTED_IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()];
}

/**
 * Map an on-disk image extension (no leading dot) to its MIME type, for
 * building `data:` URIs when serving a thumbnail to a client that can't load a
 * `vscode-webview://` resource URI (i.e. the hosted browser dashboard).
 */
export function imageExtensionToMimeType(
  extension: string
): string | undefined {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/** True if a file path's extension is one rendered as an inline image thumbnail. */
export function isImageRefPath(filePath: string): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(filePath);
  if (!match) {
    return false;
  }
  const ext = match[1].toLowerCase();
  return (IMAGE_REF_EXTENSIONS as readonly string[]).includes(ext);
}

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
  SKIPPED: "skipped",
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
// FAILURE KINDS - Structured classification for harness/session failures
// ============================================================================
export const FAILURE_KINDS = {
  USER_CANCELLED: "userCancelled",
  PROCESS_EXIT: "processExit",
  HARNESS_ERROR: "harnessError",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
} as const;

export type FailureKind = (typeof FAILURE_KINDS)[keyof typeof FAILURE_KINDS];

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
  /** zsh */
  ZSH: "zsh",
  /** bash */
  BASH: "bash",
  /** POSIX sh / dash / ksh-style shells */
  SH: "sh",
  /** fish shell */
  FISH: "fish",
  /** Windows Command Prompt */
  CMD: "cmd",
  /** WSL launcher */
  WSL: "wsl",
  /** Nushell */
  NUSHELL: "nu",
} as const;

export type ShellKind = (typeof SHELL_KINDS)[keyof typeof SHELL_KINDS];

// ============================================================================
// TERMINAL SETTINGS - xterm.js option values
// ============================================================================
export const TERMINAL_CURSOR_STYLES = {
  BLOCK: "block",
  UNDERLINE: "underline",
  BAR: "bar",
} as const;

export const TERMINAL_MOBILE_CONTROL_BAR = {
  AUTO: "auto",
  ALWAYS: "always",
  NEVER: "never",
} as const;

export type TerminalCursorStyle =
  (typeof TERMINAL_CURSOR_STYLES)[keyof typeof TERMINAL_CURSOR_STYLES];
export type TerminalMobileControlBar =
  (typeof TERMINAL_MOBILE_CONTROL_BAR)[keyof typeof TERMINAL_MOBILE_CONTROL_BAR];

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
// SCRIPT OUTPUT SOURCES - Origin values for unified script execution output
// ============================================================================
export const SCRIPT_OUTPUT_SOURCES = {
  SCRIPT_STEP: "script", // keeps today's value — see migration note
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
} as const;

// ============================================================================
// EXECUTION PHASES - Identity dimension for prompt and condition attempts
// ============================================================================
export const EXECUTION_PHASES = {
  PROMPT: "prompt", // default; omitted in keys for stability
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
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
  ENABLED: "enabled",

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
  EXECUTION_MODE: "executionMode",
  TOOL_PERMISSIONS: "toolPermissions",
  ERROR_BEHAVIOR: "errorBehavior",
} as const;

/**
 * Every workflow-level property the dashboard's properties panel owns.
 *
 * Both directions of the wire read from this list — the extension when it
 * picks properties out of a working file, and the webview when it normalizes an
 * incoming payload — because a key present in one list and missing from the
 * other silently reverts to a global default the moment the user switches
 * workflows and back.
 */
export const WORKFLOW_PROPERTY_KEYS = [
  PROMPT_PROPERTIES.HARNESS,
  PROMPT_PROPERTIES.MODEL,
  PROMPT_PROPERTIES.EXECUTION_MODE,
  PROMPT_PROPERTIES.AGENT,
  PROMPT_PROPERTIES.SKILLS,
  PROMPT_PROPERTIES.RESUME_SESSION,
  PROMPT_PROPERTIES.SESSION_ID,
  PROMPT_PROPERTIES.MCP_SERVERS,
  PROMPT_PROPERTIES.HOOKS,
  PROMPT_PROPERTIES.END_CONDITION,
  PROMPT_PROPERTIES.PRE_CONDITION,
  PROMPT_PROPERTIES.ERROR_BEHAVIOR,
  PROMPT_PROPERTIES.PRIOR_CONTEXT,
  PROMPT_PROPERTIES.ADDITIONAL_ARGS,
  PROMPT_PROPERTIES.TOOL_PERMISSIONS,
] as const;

export type WorkflowPropertyKey = (typeof WORKFLOW_PROPERTY_KEYS)[number];

// End condition property names
export const END_CONDITION_PROPERTIES = {
  SCRIPT: "script",
  RETURNS: "returns",
  TIMEOUT: "timeout",
  MAX_RETRIES: "maxRetries",
  RETRY_PROMPT: "retryPrompt",
  RESUME_SESSION_ON_RETRY: "resumeSessionOnRetry",
} as const;

// Retry prompt placeholder names for EndConditionEvaluator.buildRetryPrompt().
export const RETRY_PROMPT_PLACEHOLDERS = {
  STDOUT: "stdout",
  STDERR: "stderr",
  EXPECTED_VALUE: "expected",
  ACTUAL_VALUE: "actual",
  EXIT_CODE: "exitCode",
  COMPARE_SOURCE: "compareSource",
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

  /** Conversation compaction checkpoint — shown when the AI auto-compacts the context window */
  COMPACTION: "compaction",

  /** Genuine human text typed directly into a live TUI, mid-step or after completion.
   *  Display-only — never changes workflow/queue state. See UserEventClassification. */
  USER_STEER: "userSteer",

  /** Divider marking where post-completion follow-up activity (a harness auto-resume
   *  or a human TUI steer) begins within an already-completed step's output. Inserted
   *  at most once per step/attempt/run — see WorkflowInstance.handleSessionActivityResumed
   *  and workflowStore's streaming-event merge. */
  FOLLOW_UP_RESUMED: "followUpResumed",

  /** Invisible marker carrying updated context-window usage discovered during
   *  post-completion follow-up activity. Never rendered — consumed by the merge
   *  logic that refreshes a completed step's stats footer (tokens/contextWindow). */
  CONTEXT_WINDOW_SYNC: "contextWindowSync",
} as const;

/**
 * What triggered a context compaction event.
 * Used by CompactionData.trigger across all harnesses (Claude, OpenCode, etc.)
 */
export const COMPACTION_TRIGGERS = {
  AUTO: "auto",
  MANUAL: "manual",
} as const;

export type CompactionTrigger =
  (typeof COMPACTION_TRIGGERS)[keyof typeof COMPACTION_TRIGGERS];

/**
 * Who invoked a tool call — top-level agent or a spawned subagent.
 * Used by CliEvent.callerType across harnesses that support subagent spawning.
 */
export const CALLER_TYPES = {
  DIRECT: "direct",
  SUBAGENT: "subagent",
} as const;

export type CallerType = (typeof CALLER_TYPES)[keyof typeof CALLER_TYPES];

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
// SNAPSHOT BASE SOURCES - Provenance for modified-file snapshot diffs
// ============================================================================
export const SNAPSHOT_BASE_SOURCES = {
  GIT_HEAD: "gitHead",
  CAPTURED_BEFORE: "capturedBefore",
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
// TEMP FILE CATEGORIES - Category discriminants for categorized prompt temp files
// ============================================================================
export const TEMP_FILE_CATEGORIES = {
  AGENT: "agent",
  SKILLS: "skills",
  CONTEXT: "context",
  EXCERPTS: "excerpts",
  PROMPT: "prompt",
} as const;

export type TempFileCategory =
  (typeof TEMP_FILE_CATEGORIES)[keyof typeof TEMP_FILE_CATEGORIES];

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
// SETTING SCOPES - VS Code config scope values (workspace or user)
// ============================================================================
export const SETTING_SCOPES = {
  USER: "user",
  WORKSPACE: "workspace",
  DEFAULT: "default",
} as const;

export type SettingScope = (typeof SETTING_SCOPES)[keyof typeof SETTING_SCOPES];
/** Scopes that accept writes — workspace or user (excludes the read-only "default" tier) */
export type SettingWriteScope = Exclude<
  SettingScope,
  typeof SETTING_SCOPES.DEFAULT
>;

// ============================================================================
// DISCOVERY SOURCES - Origin labels for discovered agent/skill files
// Distinct from SETTING_SCOPES: these describe where a file was found,
// not which settings tier owns it.
// ============================================================================
export const DISCOVERY_SOURCES = {
  /** Immutable agents included with the ctrlyoke installation. */
  BUILT_IN: "built-in",
  USER: "user",
  WORKSPACE: "workspace",
  /** Files found in the .ctrlyoke/agents/ dir — ctrlyoke-exclusive, not scraped by harnesses */
  WORKSPACE_CTRLYOKE: "workspace-ctrlyoke",
} as const;

export type DiscoverySource =
  (typeof DISCOVERY_SOURCES)[keyof typeof DISCOVERY_SOURCES];

// ============================================================================
// HARNESS FILE TYPES - File type discriminants for the harness file manager
// ============================================================================
export const HARNESS_FILE_TYPES = {
  AGENT: "agent",
  SKILL: "skill",
} as const;

export type HarnessFileType =
  (typeof HARNESS_FILE_TYPES)[keyof typeof HARNESS_FILE_TYPES];

// ============================================================================
// FOOTER PICKERS - Footer quick-picker panel identifiers
// ============================================================================
export const FOOTER_PICKERS = {
  HARNESS: "harness",
  MODEL: "model",
  AGENT: "agent",
  SKILLS: "skills",
  PERMISSIONS: "permissions",
  CONTEXT: "context",
} as const;

export type FooterPicker = (typeof FOOTER_PICKERS)[keyof typeof FOOTER_PICKERS];

// ============================================================================
// SPECIAL TARGET IDS - Non-harness targets in the harness file manager
// ============================================================================
export const SPECIAL_TARGET_IDS = {
  CTRLYOKE: "ctrlyoke",
  VSCODE: "vscode",
  AGENTS: "agents",
} as const;

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
/**
 * All valid target IDs for the file manager — harness IDs plus special dirs.
 * "ctrlyoke" → .ctrlyoke/agents|skills (workspace) or ~/.ctrlyoke/agents|skills (user)
 * "agents"     → .agents|.agents/skills (workspace) or ~/.agents|~/.agents/skills (user)
 * "vscode"     → VS Code user prompts dir (user-only; Windows/macOS/Linux variants)
 */
export type AnyTargetId = HarnessId | "ctrlyoke" | "vscode" | "agents";
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
export type PromptEditorInsertMode =
  (typeof PROMPT_EDITOR_INSERT_MODES)[keyof typeof PROMPT_EDITOR_INSERT_MODES];
export type TerminalSessionStatus =
  (typeof TERMINAL_SESSION_STATUS)[keyof typeof TERMINAL_SESSION_STATUS];
export type SessionKind = (typeof SESSION_KINDS)[keyof typeof SESSION_KINDS];
export type OutputHistoryKind =
  (typeof OUTPUT_HISTORY_KINDS)[keyof typeof OUTPUT_HISTORY_KINDS];
export type SnapshotStrategy =
  (typeof SNAPSHOT_STRATEGIES)[keyof typeof SNAPSHOT_STRATEGIES];
export type SnapshotBaseSource =
  (typeof SNAPSHOT_BASE_SOURCES)[keyof typeof SNAPSHOT_BASE_SOURCES];
export type UndoFileAction =
  (typeof UNDO_FILE_ACTIONS)[keyof typeof UNDO_FILE_ACTIONS];
export type WorkflowAttemptCommandValue =
  (typeof WORKFLOW_ATTEMPT_COMMANDS)[keyof typeof WORKFLOW_ATTEMPT_COMMANDS];
export type StepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
export type ConditionAction =
  (typeof CONDITION_ACTIONS)[keyof typeof CONDITION_ACTIONS];
export type CompareSource =
  (typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES];
export type ScriptOutputSource =
  (typeof SCRIPT_OUTPUT_SOURCES)[keyof typeof SCRIPT_OUTPUT_SOURCES];
export type ExecutionPhase =
  (typeof EXECUTION_PHASES)[keyof typeof EXECUTION_PHASES];

/** Resolve the timeline phase represented by a script output source. */
export function getExecutionPhaseForScriptOutputSource(
  source?: ScriptOutputSource
): ExecutionPhase {
  switch (source) {
    case SCRIPT_OUTPUT_SOURCES.PRE_CONDITION:
      return EXECUTION_PHASES.PRE_CONDITION;
    case SCRIPT_OUTPUT_SOURCES.END_CONDITION:
      return EXECUTION_PHASES.END_CONDITION;
    default:
      return EXECUTION_PHASES.PROMPT;
  }
}

/** Stable key for a live streaming buffer scoped to one target and phase. */
export function getStreamingChunkKey(
  targetIndex: number,
  phase: ExecutionPhase = EXECUTION_PHASES.PROMPT
): string {
  return `${targetIndex}:${phase}`;
}

/** Preserve legacy prompt keys while separating condition execution phases. */
export function getExecutionPhaseKeySuffix(phase?: ExecutionPhase): string {
  return phase && phase !== EXECUTION_PHASES.PROMPT ? `:phase:${phase}` : "";
}

export type RetryPromptPlaceholder =
  (typeof RETRY_PROMPT_PLACEHOLDERS)[keyof typeof RETRY_PROMPT_PLACEHOLDERS];

// VS Code command IDs registered by the extension
export const VSCODE_COMMANDS = {
  ENABLE_SERVER: "ctrlyoke.enableServer",
  DISABLE_SERVER: "ctrlyoke.disableServer",
  REGENERATE_SERVER_TOKEN: "ctrlyoke.regenerateServerToken",
  SEARCH_HISTORY: "ctrlyoke.searchHistory",
  GENERATE_COMMIT_MESSAGE: "ctrlyoke.generateCommitMessage",
  CANCEL_COMMIT_MESSAGE_GENERATION: "ctrlyoke.cancelCommitMessageGeneration",
} as const;

// Built-in VS Code Git extension command IDs that ctrlyoke invokes to open
// native diff UI (verified against the vscode.git extension command surface).
// `git.viewCommit` resolves its first arg to a repository, so invoke it as
// executeCommand(VIEW_COMMIT, Uri.file(workspaceRoot), commitHash).
export const VSCODE_GIT_COMMANDS = {
  VIEW_COMMIT: "git.viewCommit", // commit's multi-file diff in the native viewer
  VIEW_CHANGES: "git.viewChanges", // working-tree changes
  VIEW_STAGED_CHANGES: "git.viewStagedChanges", // staged changes
  CHANGES: "vscode.changes", // generic multi-file diff editor (used for stashes)
} as const;

// VS Code context keys set by the extension (used in package.json `when` clauses)
export const VSCODE_CONTEXT_KEYS = {
  GENERATING_COMMIT_MESSAGE: "ctrlyoke.generatingCommitMessage",
} as const;
