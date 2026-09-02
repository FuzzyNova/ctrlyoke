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
import { formatUsageWindowLabel as formatSharedUsageWindowLabel } from "../utils/StatuslineFormat";

/** File formats supported when authoring workflows and templates. */
export const WORKFLOW_FILE_FORMATS = {
  YAML: "yaml",
  JSON: "json",
} as const;

export type WorkflowFileFormat =
  (typeof WORKFLOW_FILE_FORMATS)[keyof typeof WORKFLOW_FILE_FORMATS];

/** Completion trigger discriminants shared by the extension host and webview. */
export const COMPLETION_TRIGGERS = {
  SLASH: "/",
  AT: "@",
  HASH: "#",
  TILDE: "~",
  DOLLAR: "$",
  BANG: "!",
  PATH: "path",
} as const;

export type CompletionTrigger =
  (typeof COMPLETION_TRIGGERS)[keyof typeof COMPLETION_TRIGGERS];

/** Build modes consumed by the Vite webview configuration. */
export const BUILD_MODES = {
  PRODUCTION: "production",
} as const;

/** Standard JavaScript error names used by browser-facing async flows. */
export const ERROR_NAMES = {
  ABORT: "AbortError",
} as const;

/** Language IDs recognized by prompt-file completion and navigation providers. */
export const PROMPT_FILE_LANGUAGE_IDS = {
  JSON: WORKFLOW_FILE_FORMATS.JSON,
  JSONC: "jsonc",
  MARKDOWN: "markdown",
  PROMPT: "prompt",
  YAML: WORKFLOW_FILE_FORMATS.YAML,
  YML: "yml",
} as const;

/** Bases used when resolving workspace-relative prompt references. */
export const REFERENCE_PATH_BASES = {
  ABSOLUTE: "absolute",
  WORKFLOW: "workflow",
  NAMED_ROOT: "namedRoot",
  WORKSPACE: "workspace",
  SOURCE_RUNTIME_STORE: "sourceRuntimeStore",
} as const;

/** Query keys accepted by the hosted workspace tree endpoint. */
export const WORKSPACE_TREE_QUERY_KEYS = {
  PATH: "path",
} as const;

/** Line-ending names used by text-file transport and persistence. */
export const LINE_ENDINGS = {
  LF: "lf",
  CRLF: "crlf",
} as const;

/** Node network-interface address families used by hosted-server discovery. */
export const NETWORK_INTERFACE_FAMILIES = {
  IPV4: "IPv4",
} as const;

/** Promise settlement states used when inspecting concurrent operations. */
export const PROMISE_SETTLED_STATUSES = {
  FULFILLED: "fulfilled",
  REJECTED: "rejected",
} as const;

/** Language IDs for workspace files identified by their full filename. */
export const WORKSPACE_FILE_LANGUAGE_IDS = {
  DOCKERFILE: "dockerfile",
} as const;

/** Canonical language IDs supported by the workspace CodeMirror editor. */
export const CODEMIRROR_LANGUAGE_IDS = {
  JAVASCRIPT: "javascript",
  JSX: "jsx",
  TYPESCRIPT: "typescript",
  TSX: "tsx",
  PYTHON: "python",
  RUST: "rust",
  JSON: "json",
  MARKUP: "markup",
  CSS: "css",
  SCSS: "scss",
  YAML: "yaml",
  MARKDOWN: "markdown",
  JAVA: "java",
  CPP: "cpp",
  C: "c",
  PHP: "php",
} as const;

export type CodeMirrorLanguageId =
  (typeof CODEMIRROR_LANGUAGE_IDS)[keyof typeof CODEMIRROR_LANGUAGE_IDS];

/** VS Code URI schemes used by extension-host integrations. */
export const VSCODE_URI_SCHEMES = {
  OUTPUT: "output",
} as const;

/** Name of the manifest that identifies a ctrlyoke-managed bundle assets directory. */
export const BUNDLE_MANIFEST_FILE_NAME = ".ctrlyoke-assets.json";

/** Supported locations for persisted workflow run history. */
export const RUN_HISTORY_LOCATIONS = {
  USER: "user",
  WORKSPACE: "workspace",
} as const;

/** Providers that install a global statusline command. */
export const STATUS_LINE_TRACKING_PROVIDERS = {
  CLAUDE: "claude",
  ANTIGRAVITY: "antigravity",
  COPILOT: "copilot",
  QWEN: "qwen",
} as const;

export type StatusLineTrackingProvider =
  (typeof STATUS_LINE_TRACKING_PROVIDERS)[keyof typeof STATUS_LINE_TRACKING_PROVIDERS];

/** String representations used when booleans cross a text-based boundary. */
export const BOOLEAN_STRING_VALUES = {
  TRUE: "true",
  FALSE: "false",
} as const;

/** Boolean-like stdout values accepted by script condition evaluation. */
export const SCRIPT_BOOLEAN_OUTPUT_VALUES = {
  TRUE_NUMERIC: "1",
  TRUE_YES: "yes",
  TRUE_PASS: "pass",
  TRUE_PASSED: "passed",
  FALSE_NUMERIC: "0",
  FALSE_NO: "no",
  FALSE_FAIL: "fail",
  FALSE_FAILED: "failed",
} as const;

/** Feature keys unlocked by a Pro entitlement. Keep gate sites on these constants. */
export const PRO_FEATURES = {
  HOSTED_DASHBOARD: "hosted-dashboard",
  REMOTE_ACCESS: "remote-access",
  HTTPS_CERTIFICATES: "https-certificates",
  MOBILE_PUSH: "mobile-push",
  AIR_GAPPED_ACTIVATION: "air-gapped-activation",
  CUSTOM_ICON_COLOR: "custom-icon-color",
} as const;

export type ProFeature = (typeof PRO_FEATURES)[keyof typeof PRO_FEATURES];

/** User-facing licensing command actions and destinations. */
export const LICENSE_UI = {
  OPEN_PRICING: "Open pricing",
  DEACTIVATE: "Deactivate",
  PRICING_URL: "https://ctrlyoke.dev/pricing/",
  REMOTE_ACCESS_UPSELL:
    "Remote access is a Pro feature. Your localhost dashboard remains free; start a 14-day trial or view Pro pricing.",
  CUSTOM_ICON_UPSELL:
    "Custom icon colors are a Pro thank-you perk. View Pro pricing to unlock them.",
} as const;

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
  STEPS_EXTENDED: "stepsExtended", // Send updated steps list after queue extension
  PROMPT_DELETED: "promptDeleted", // Notify webview that a prompt was deleted
  UPDATE_FINAL_PROMPT: "updateFinalStep", // Bidirectional: webview updates workflow-level finalStep; extension pushes latest finalStep
  FINAL_PROMPT_STATUS_CHANGED: "finalStepStatusChanged", // Granular runtime status updates for finalStep phase
  FINAL_PROMPT_OUTPUT: "finalStepOutput", // CLI output for finalStep keyed by loop index
  FINAL_PROMPT_STREAMING_CHUNK: "finalStepStreamingChunk", // Incremental streaming text chunk for finalStep
  FINAL_PROMPT_STREAMING_EVENTS: "finalStepStreamingEvents", // Structured streaming events for finalStep
  QUEUE_SIZE_LIMIT_REACHED: "queueSizeLimitReached",
  EXECUTION_TIME_LIMIT_REACHED: "executionTimeLimitReached",
  END_CONDITION_SCRIPT_CREATED: "endConditionScriptCreated",
  END_CONDITION_SCRIPT_CREATION_FAILED: "endConditionScriptCreationFailed",

  // Webview -> Extension (Logging)
  LOG_MESSAGE: "logMessage", // Forward webview log entries to extension Log class (payload: { level: LogLevel, message: string })

  // Webview -> Extension
  READY: "ready",
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
  RETRY_HARNESS_DETECTION: "retryHarnessDetection",

  // Prompt Editor - Webview -> Extension
  EXECUTE_PROMPT: "executePrompt", // Send/Add with properties
  EXECUTE_PROMPT_ERROR: "executePromptError", // Extension -> Webview: Notify failure so editor can restore content
  UPDATE_PROMPT: "updatePrompt", // Update existing prompt in queue
  INSERT_WORKFLOW_STEP: "insertWorkflowStep", // Insert a fully-shaped workflow step after a selected index
  CANCEL_EDIT: "cancelEdit", // Exit edit mode
  SELECT_PROMPT_FOR_EDIT: "selectPromptForEdit", // Load prompt into editor
  DELETE_PROMPT: "deletePrompt", // Delete prompt from queue
  CREATE_END_CONDITION_SCRIPT: "createEndConditionScript",

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
  OPEN_GLOBAL_SETTINGS_TAB: "openGlobalSettingsTab", // Extension/webview navigation to a settings tab
  OPEN_VSCODE_MCP_BROWSER: "openVscodeMcpBrowser", // Webview -> Extension: Open VS Code's native MCP server browser
  EXECUTE_VSCODE_COMMAND: "executeVscodeCommand", // Webview -> Extension: execute a whitelisted native command
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate", // Refresh model lists after registry loads
  HARNESS_STATUS_UPDATE: "harnessStatusUpdate", // Update harness availability
  HARNESS_DETECTION_RETRY_RESULT: "harnessDetectionRetryResult", // Result of a client-scoped detection retry
  HARNESS_CAPABILITY_SNAPSHOT: "harnessCapabilitySnapshot", // Installed-version-aware harness facts
  AGENTS_UPDATE: "agentsUpdate", // Update available agents list
  SKILLS_UPDATE: "skillsUpdate", // Update available skills list
  GLOBAL_SETTINGS_UPDATED: "globalSettingsUpdated", // Extension -> Webview: Config changed, update settings only (no workflow reset)
  GLOBAL_SETTINGS_LOAD_REQUEST: "globalSettingsLoadRequest", // Webview -> Extension: Request full settings payload
  GLOBAL_SETTINGS_LOADED: "globalSettingsLoaded", // Extension -> Webview: Full settings payload + sources
  UPDATE_GLOBAL_SETTING: "updateGlobalSetting", // Webview -> Extension: { path, value, scope }
  GLOBAL_SETTING_UPDATED: "globalSettingUpdated", // Extension -> Webview: { path, value, source } acknowledgment
  RELOAD_WINDOW: "reloadWindow", // Webview -> Extension: Apply startup-frozen settings after a window reload
  REQUEST_HARNESS_USAGE: "requestHarnessUsage", // Webview -> Extension: return cache and refresh in background
  REFRESH_HARNESS_USAGE: "refreshHarnessUsage", // Webview -> Extension: refresh provider usage
  HARNESS_USAGE_UPDATED: "harnessUsageUpdated", // Extension -> Webview: normalized usage snapshots
  REQUEST_WORKSPACE_STATS: "requestWorkspaceStats", // Webview -> Extension: return cache and refresh in background
  REFRESH_WORKSPACE_STATS: "refreshWorkspaceStats", // Webview -> Extension: rebuild workspace statistics
  WORKSPACE_STATS_UPDATED: "workspaceStatsUpdated", // Extension -> Webview: workspace statistics snapshot
  COMMIT_MESSAGE_GENERATION_UPDATED: "commitMessageGenerationUpdated", // Extension -> Webview: Latest real git diff input used for commit generation
  GET_CONFIG: "getConfig", // Webview -> Extension: Request config value
  UPDATE_CONFIG: "updateConfig", // Webview -> Extension: Update config value
  CONFIG_VALUE: "configValue", // Extension -> Webview: Send config value
  BROWSE_AND_ADD_EXTERNAL_ROOT: "browseAndAddExternalRoot", // Webview -> Extension: { scope } OS folder picker, appends result to permissions.allowedExternalFileRoots for that scope
  DISABLE_STATUS_LINE_TRACKING: "disableStatusLineTracking", // Webview -> Extension: disable one harness's global statusline tracking
  SET_STATUS_LINE_FORMAT_MODE: "setStatusLineFormatMode", // Webview -> Extension: set shared/per-harness statusline format mode

  // Secret registry - Webview <-> Extension
  REQUEST_SECRET_REGISTRY: "requestSecretRegistry",
  SECRET_REGISTRY_UPDATE: "secretRegistryUpdate",
  SET_SECRET: "setSecret",
  SECRET_SET: "secretSet",
  DELETE_SECRET: "deleteSecret",
  SECRET_DELETED: "secretDeleted",

  // Batch approval interaction port - Extension <-> Webview. First caller is
  // workspace secret-grant approval (see SecretGrantsTrustPrompt.ts); the
  // extension awaits BATCH_APPROVAL_RESPONSE before continuing.
  SHOW_BATCH_APPROVAL_REQUEST: "showBatchApprovalRequest",
  BATCH_APPROVAL_RESPONSE: "batchApprovalResponse",

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
  CREATE_CUSTOM_TEMPLATE: "createCustomTemplate", // { name, scope, format, baseTemplateId } — fully webview-driven, no native VS Code UI
  BROWSE_TEMPLATE_FILE: "browseTemplateFile", // Request OS file picker for a template variable

  // New Workflow Modal - Extension -> Webview
  TEMPLATE_FILE_SELECTED: "templateFileSelected", // OS file picker result for a template variable
  CUSTOM_TEMPLATE_CREATED: "customTemplateCreated", // { templates, templateId } on success, or { error }

  // CodeMirror editor - Webview <-> Extension
  REQUEST_COMPLETIONS: "requestCompletions", // Request autocomplete suggestions
  COMPLETIONS_RESPONSE: "completionsResponse", // Return autocomplete suggestions
  SCRIPT_COMPLETIONS_REQUEST: "scriptCompletionsRequest",
  SCRIPT_COMPLETIONS_RESPONSE: "scriptCompletionsResponse",
  HARNESS_FLAG_COMPLETIONS_REQUEST: "harnessFlagCompletionsRequest",
  HARNESS_FLAG_COMPLETIONS_RESPONSE: "harnessFlagCompletionsResponse",
  PERMISSION_COMPLETIONS_REQUEST: "permissionCompletionsRequest",
  PERMISSION_COMPLETIONS_RESPONSE: "permissionCompletionsResponse",
  BRANCH_LIST_REQUEST: "branchListRequest",
  BRANCH_LIST_RESPONSE: "branchListResponse",
  OPEN_FILE: "openFile", // Open file from an @file / #selection: / #sym: link
  OPEN_SETTINGS_FILE: "openSettingsFile", // Webview -> Extension: open the user/workspace settings.json for a given scope
  OPEN_SKILL: "openSkill", // Open a resolved ctrlyoke SKILL.md link
  OPEN_PROMPT_FILE: "openPromptFile", // Open a lone prompt-file reference
  OPEN_GIT_CHANGE: "openGitChange", // Webview -> Extension: open a git diff in a new editor (legacy)
  OPEN_WORKTREE: "openWorktree", // Webview -> Extension: open a recorded worktree in a new window
  VIEW_WORKTREE_DIFF: "viewWorktreeDiff", // Webview -> Extension: view a recorded worktree branch against its base
  MERGE_WORKTREE: "mergeWorktree", // Webview -> Extension: merge a managed run's branch into its source checkout
  WORKTREE_MERGE_RESULT: "worktreeMergeResult", // Extension -> Webview: persisted merge projection
  REQUEST_WORKTREE_MANAGEMENT_STATE: "requestWorktreeManagementState",
  WORKTREE_MANAGEMENT_STATE: "worktreeManagementState",
  WORKTREE_MANAGEMENT_ACTION: "worktreeManagementAction",
  SYNC_NAMED_WORKTREE: "syncNamedWorktree", // Webview -> Extension: two-way merge a named worktree's branch with the source checkout's current branch
  WORKTREE_MANAGEMENT_ACTION_RESULT: "worktreeManagementActionResult", // Extension -> Webview: round-trip result for a worktree management action/sync, correlated by the requestId the webview sent
  OPEN_WORKTREE_OWNER: "openWorktreeOwner",
  OPEN_PRIOR_CONTEXT: "openPriorContext", // Webview -> Extension: preview inline $prior-context expansion (legacy)
  // REQUEST_GIT_CHANGE_PREVIEW and GIT_CHANGE_PREVIEW_RESULT removed — browser now opens
  // the WorkspaceDiffPane via openToGitRef(); VS Code uses OPEN_GIT_CHANGE → native commands.
  REQUEST_PRIOR_CONTEXT_PREVIEW: "requestPriorContextPreview", // Webview -> Extension: request prior-context XML for preview modal
  PRIOR_CONTEXT_PREVIEW_RESULT: "priorContextPreviewResult", // Extension -> Webview: { ref, content } XML for modal
  EXPORT_CONTENT_PREVIEW: "exportContentPreview", // Webview -> Extension: open preview content in VS Code editor
  VALIDATE_FILE_REF: "validateFileRef", // Webview -> Extension: { seq, filePath, address }
  FILE_REF_VALIDATION: "fileRefValidation", // Extension -> Webview: addressed file-ref result
  VALIDATE_CONTEXT_REFS: "validateContextRefs", // Webview -> Extension: Validate inline @/#/~ context references
  CONTEXT_REFS_VALIDATION: "contextRefsValidation", // Extension -> Webview: Inline context reference validation results
  INSERT_PROMPT_REFERENCES: "insertPromptReferences", // Extension -> Webview: insert raw context references into the live prompt editor

  // Image paste - Webview <-> Extension
  CONVERT_PROMPT_TO_FILE: "convertPromptToFile", // Webview -> Extension: write prompt text to a prompt file
  PROMPT_FILE_CREATED: "promptFileCreated", // Extension -> Webview: { seq, reference, resolvedPath } or { seq, error }
  SAVE_PASTED_IMAGE: "savePastedImage", // Webview -> Extension: save a pasted clipboard image to disk
  PASTED_IMAGE_SAVED: "pastedImageSaved", // Extension -> Webview: { seq, relativePath } or { seq, error }
  SAVE_OUTPUT_SNAPSHOT: "saveOutputSnapshot", // Webview -> Extension: save a pending output capture to disk
  OUTPUT_SNAPSHOT_SAVED: "outputSnapshotSaved", // Extension -> Webview: { seq, relativePath } or { seq, error }
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
  SEARCH_INDEX_REBUILD_PROGRESS: "searchIndexRebuildProgress", // Extension -> Webview: Progress push while a search had to block on a full index rebuild
  OPEN_HISTORY_SEARCH: "openHistorySearch", // Extension -> Webview: Open global history search UI
  DELETE_RUN_HISTORY: "deleteRunHistory", // Webview -> Extension: Delete a single run by address, any run in the lineage (not required to be the viewed run)
  DELETE_ALL_RUNS_FOR_LINEAGE: "deleteAllRunsForLineage", // Webview -> Extension: Delete every non-executing run of an explicit lineage (run-navigation panel's "Delete all runs")
  RUN_VIEW_LOADED: "runViewLoaded", // Extension -> Webview: Atomic definition/settings/output snapshot for a view address
  WORKFLOW_VIEW_IDENTITY: "workflowViewIdentity", // Extension -> Webview: Authoritative address + revisions after a definition write
  WORKFLOW_ACTION_FAILED: "workflowActionFailed", // Extension -> Webview: { action, error, requestId? } an addressed view/mutation/run action was rejected
  REQUEST_EXECUTION_PREVIEW: "requestExecutionPreview", // Webview -> Extension: compute one addressed dry-run snapshot
  EXECUTION_PREVIEW_RESULT: "executionPreviewResult", // Extension -> Webview: request-correlated redacted dry-run snapshot

  // Save Workflow - Webview <-> Extension
  SAVE_WORKFLOW_REQUEST: "saveWorkflowRequest", // Webview -> Extension: Request default save path/format
  SAVE_WORKFLOW_DIALOG_DATA: "saveWorkflowDialogData", // Extension -> Webview: Default path, format
  CHECK_SAVE_PATH: "checkSavePath", // Webview -> Extension: Check whether an export destination already exists
  SAVE_PATH_CHECKED: "savePathChecked", // Extension -> Webview: Addressed export destination check result
  SAVE_WORKFLOW: "saveWorkflow", // Webview -> Extension: { filePath, format } confirmed by user
  WORKFLOW_SAVED: "workflowSaved", // Extension -> Webview: { filePath } success
  WORKFLOW_SAVE_FAILED: "workflowSaveFailed", // Extension -> Webview: { error } failure
  SAVE_WORKFLOW_AS_TEMPLATE: "saveWorkflowAsTemplate", // Webview -> Extension: { name, scope, format } — snapshot current workflow as a custom template
  WORKFLOW_SAVED_AS_TEMPLATE: "workflowSavedAsTemplate", // Extension -> Webview: { templates, templateId } success (failure reuses WORKFLOW_SAVE_FAILED)
  CREATE_WORKFLOW_VARIANT: "createWorkflowVariant",
  WORKFLOW_VARIANT_CREATED: "workflowVariantCreated",
  WORKFLOW_VARIANT_FAILED: "workflowVariantFailed",
  BROWSE_SAVE_LOCATION: "browseSaveLocation", // Webview -> Extension: Request OS folder picker for the Save As location (VS Code panel only)
  SAVE_LOCATION_SELECTED: "saveLocationSelected", // Extension -> Webview: OS folder picker result { path }

  // Multi-workflow coordination — Extension → Webview
  WORKFLOWS_LIST: "workflowsList", // Full list of loaded WorkflowSummary[]
  WORKFLOW_ADDED: "workflowAdded", // New workflow loaded: { summary: WorkflowSummary }
  WORKFLOW_DISMISSED: "workflowDismissed", // Workflow removed: { workflowId }
  WORKFLOW_SUMMARY_UPDATED: "workflowSummaryUpdated", // Execution state changed: { summary: WorkflowSummary }
  ACTIVE_WORKFLOW_CHANGED: "activeWorkflowChanged", // Active selection changed: { workflowId }

  // VS Code-hosted server — Extension → Webview
  SERVER_STARTED: "serverStarted", // Server started: { url: string; availableIps?: string[]; portFallback?: ServerPortFallbackInfo; bindAddressFallback?: BindAddressFallbackInfo }
  SERVER_STOPPED: "serverStopped", // Server stopped
  SERVER_TOKEN_REGENERATED: "serverTokenRegenerated", // Token deleted; restart server to apply new token

  // VS Code-hosted server — Webview → Extension
  REGENERATE_SERVER_TOKEN: "regenerateServerToken", // Request token regeneration
  GENERATE_SERVER_CERT: "generateServerCert", // Request self-signed cert generation → .ctrlyoke/certs/
  DOWNLOAD_SERVER_CERT: "downloadServerCert", // Save the TLS cert via a native Save dialog (VS Code panel only — no HTTP client to download through)

  // Pro license management — Webview → Extension
  ACTIVATE_LICENSE_KEY: "activateLicenseKey",
  IMPORT_LICENSE_FILE: "importLicenseFile",
  DEACTIVATE_LICENSE: "deactivateLicense",
  REQUEST_LICENSE_MACHINES: "requestLicenseMachines",
  DEACTIVATE_LICENSE_MACHINE: "deactivateLicenseMachine",

  // Pro license management — Extension → Webview
  LICENSE_MACHINES_UPDATED: "licenseMachinesUpdated",
  LICENSE_ACTION_RESULT: "licenseActionResult",

  // VS Code-hosted server — Extension → Webview
  SERVER_CERT_GENERATED: "serverCertGenerated", // Cert generated; settings updated with new paths
  SERVER_CERT_DOWNLOADED: "serverCertDownloaded", // Save dialog flow finished; saved=false if the user cancelled or the write failed

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
  STOP_VSCODE_RUN: "stopVscodeRun", // Request a sibling VS Code owner to stop via its sentinel: { workflowId }
  WORKSPACE_WORKTREE_OWNERSHIP: "workspaceWorktreeOwnership", // Extension -> Webview: current folder's managed-worktree ownership

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
  REQUEST_MCP_CONFIG_PREVIEW: "requestMcpConfigPreview", // Webview -> Extension: request a /mcp:<name> reference's resolved server config for the preview modal
  MCP_CONFIG_PREVIEW_RESULT: "mcpConfigPreviewResult", // Extension -> Webview: { mcpServerName, content, found } JSON for modal

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
  /** Extension/Hosted server -> Webview: operational user feedback */
  USER_FEEDBACK: "userFeedback",
  /** Webview -> Extension: native VS Code operational user feedback */
  SHOW_NATIVE_FEEDBACK: "showNativeFeedback",
} as const;

/** Stable action identifiers used by the license-management RPC responses. */
export const LICENSE_ACTIONS = {
  ACTIVATION_LIMIT: "licenseActivationLimit",
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

/** Permission states reported by the browser Notification API. */
export const BROWSER_NOTIFICATION_PERMISSION_STATES = {
  UNSUPPORTED: "unsupported",
  BLOCKED: "blocked",
  NEEDS_PERMISSION: "needs-permission",
  GRANTED: "granted",
} as const;

export type BrowserPermissionStatus =
  (typeof BROWSER_NOTIFICATION_PERMISSION_STATES)[keyof typeof BROWSER_NOTIFICATION_PERMISSION_STATES];

/** Browser document visibility states used by notification and badge flows. */
export const DOCUMENT_VISIBILITY_STATES = {
  VISIBLE: "visible",
} as const;

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
  // SVG used in the web app manifest and as the SVG apple-touch-icon. iOS 15+ uses
  // this for home screen icons. Deliberately opaque (solid BG_COLOR canvas) — iOS has
  // never rendered transparent PWA home-screen icons (it always fills a solid backdrop),
  // and Apple's Liquid Glass guidance for icons in general is to submit an opaque master
  // and let the system apply Clear/Tinted/Dark effects on top, not to author transparency
  // yourself.
  APP_ICON_SVG: "ctrlyoke-app-icon.svg",
  // Same mark as APP_ICON_SVG but rendered with a transparent canvas (only the keyface
  // shape carries the background color) — see ctrlyoke-icon.svg's keyface path. Same
  // 2-token recolor contract as the app icon.
  FAVICON_PNG: "ctrlyoke-icon-color.png",
  FAVICON_SVG: "ctrlyoke-icon-color.svg",
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
// NOTIFICATION OUTCOME KINDS - Notification monitor result classifications
// ============================================================================
export const NOTIFICATION_OUTCOME_KINDS = {
  COMPLETION: "completion",
  ERROR: "error",
} as const;

export type NotificationOutcomeKind =
  (typeof NOTIFICATION_OUTCOME_KINDS)[keyof typeof NOTIFICATION_OUTCOME_KINDS];

// ============================================================================
// USER FEEDBACK SEVERITY - Visual level for transient dashboard feedback
// ============================================================================
export const USER_FEEDBACK_SEVERITY = {
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "error",
} as const;

/** Script languages supported by the built-in end-condition starter templates. */
export const END_CONDITION_SCRIPT_TYPES = {
  PYTHON: "python",
  JAVASCRIPT: "javascript",
  SHELL: "shell",
  POWERSHELL: "powershell",
} as const;

export type EndConditionScriptType =
  (typeof END_CONDITION_SCRIPT_TYPES)[keyof typeof END_CONDITION_SCRIPT_TYPES];

export type UserFeedbackSeverity =
  (typeof USER_FEEDBACK_SEVERITY)[keyof typeof USER_FEEDBACK_SEVERITY];

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

/** Commands emitted by the workflow runtime state machine. */
export const WORKFLOW_RUNTIME_COMMANDS = {
  START_EXECUTION: "startExecution",
  PAUSE: "pause",
  CONFIRM_PAUSED: "confirmPaused",
  CANCEL_PAUSE: "cancelPause",
  RESUME: "resume",
  REQUEST_STOP: "requestStop",
  CONFIRM_STOPPED: "confirmStopped",
  COMPLETE: "complete",
  FAIL: "fail",
  REOPEN_FOR_CONTINUATION: "reopenForContinuation",
} as const;

/** Actions exposed by the workflow execution control buttons. */
export const WORKFLOW_EXECUTION_CONTROL_ACTIONS = {
  RUN_DRAFT: "run-draft",
  START_RUN: "start-run",
  RERUN: "rerun",
  RESTART: "restart",
  CONTINUE: "continue",
  PAUSE: "pause",
  CANCEL_PAUSE: "cancel-pause",
  RESUME: "resume",
  STOP: "stop",
  NONE: "none",
} as const;

export type WorkflowExecutionControlAction =
  (typeof WORKFLOW_EXECUTION_CONTROL_ACTIONS)[keyof typeof WORKFLOW_EXECUTION_CONTROL_ACTIONS];

export type WorkflowRuntimeCommand =
  (typeof WORKFLOW_RUNTIME_COMMANDS)[keyof typeof WORKFLOW_RUNTIME_COMMANDS];

/** Lifecycle states in which a run may still be owned by an executor. */
export const ACTIVE_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  EXECUTION_STATES.RUNNING,
  EXECUTION_STATES.PAUSING,
  EXECUTION_STATES.PAUSED,
  EXECUTION_STATES.CANCELLING,
]);

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
// SCRIPT VERDICT OUTCOMES - Results of script/pre-condition/end-condition evaluation
// ============================================================================
export const SCRIPT_VERDICT_OUTCOMES = {
  PASSED: "passed",
  FAILED: "failed",
  ERRORED: "errored",
} as const;

export type ScriptVerdictOutcome =
  (typeof SCRIPT_VERDICT_OUTCOMES)[keyof typeof SCRIPT_VERDICT_OUTCOMES];

// ============================================================================
// PROMPT FILE RESOLUTION STATUSES - Prompt reference lookup results
// ============================================================================
export const PROMPT_FILE_RESOLUTION_STATUSES = {
  MISSING: "missing",
  UNREADABLE: "unreadable",
  EMPTY: "empty",
  RESOLVED: "resolved",
} as const;

/** How a working file reload is applied to the current queue. */
export const PROMPT_FILE_RELOAD_MODES = {
  REPLACE: "replace",
  MERGE: "merge",
  AUTO: "auto",
} as const;

export type PromptFileReloadMode =
  (typeof PROMPT_FILE_RELOAD_MODES)[keyof typeof PROMPT_FILE_RELOAD_MODES];

export type PromptFileResolutionStatus =
  (typeof PROMPT_FILE_RESOLUTION_STATUSES)[keyof typeof PROMPT_FILE_RESOLUTION_STATUSES];

// ============================================================================
// PROJECT STATE STATUSES - Persisted project and runner inspection results
// ============================================================================
export const PROJECT_STATE_PATH_STATUSES = {
  PRESENT: "present",
  MISSING: "missing",
  UNKNOWN: "unknown",
} as const;

export type ProjectStatePathStatus =
  (typeof PROJECT_STATE_PATH_STATUSES)[keyof typeof PROJECT_STATE_PATH_STATUSES];

export const PROJECT_RUNNER_STATUSES = {
  NONE: "none",
  LIVE: "live",
  UNKNOWN: "unknown",
} as const;

export type ProjectRunnerStatus =
  (typeof PROJECT_RUNNER_STATUSES)[keyof typeof PROJECT_RUNNER_STATUSES];

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

/** Harnesses whose global statusline can be managed by ctrlyoke. */
export type StatusLineTrackingHarnessId =
  | typeof HARNESS_IDS.CLAUDE_CLI
  | typeof HARNESS_IDS.ANTIGRAVITY_CLI
  | typeof HARNESS_IDS.COPILOT_CLI
  | typeof HARNESS_IDS.QWEN_CLI;

export function isStatusLineTrackingHarnessId(
  value: unknown
): value is StatusLineTrackingHarnessId {
  return (
    value === HARNESS_IDS.CLAUDE_CLI ||
    value === HARNESS_IDS.ANTIGRAVITY_CLI ||
    value === HARNESS_IDS.COPILOT_CLI ||
    value === HARNESS_IDS.QWEN_CLI
  );
}

/** Claude tool names used by provider-specific execution state tracking. */
export const CLAUDE_TOOL_NAMES = {
  AGENT: "Agent",
  MONITOR: "Monitor",
  TASK_STOP: "TaskStop",
  ASK_USER_QUESTION: "AskUserQuestion",
  MULTI_EDIT: "multiedit",
} as const;

/** Metrics available in the workspace harness-share breakdown. */
export const HARNESS_SHARE_METRICS = {
  AI_STEPS: "ai-steps",
  TOKENS: "tokens",
} as const;

// ============================================================================
// TOKEN USAGE - Provenance and aggregate coverage
// ============================================================================
export const TOKEN_TOTAL_CONFIDENCE = {
  /** Provider reported a cumulative total for the whole attempt. */
  PROVIDER: "provider",
  /** Summed from provider per-turn usage by a ctrlyoke parser, including cache-netted totals. */
  ACCUMULATED: "accumulated",
  /** Known to be incomplete (e.g. a harness that only reports the last turn). */
  PARTIAL: "partial",
} as const;

export const WORKFLOW_TOKEN_COVERAGE = {
  COMPLETE: "complete",
  PARTIAL: "partial",
} as const;

export const ATTEMPT_COST_SOURCES = {
  /** The harness itself reported dollars (Claude `total_cost_usd`, OpenCode `part.cost`). */
  HARNESS_REPORTED: "harness-reported",
  /** Computed by ctrlyoke from the bundled price table. */
  PRICE_TABLE: "price-table",
  /** Computed from a user-supplied per-harness/model override. */
  USER_OVERRIDE: "user-override",
} as const;

// ============================================================================
// WORKSPACE STATS - Lifetime rollup and backfill state
// ============================================================================
export const RUN_OUTCOME_BUCKETS = {
  COMPLETED: "completed",
  STOPPED: "stopped",
  ERROR: "error",
} as const;

export const WORKSPACE_STATS_BACKFILL_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  COMPLETE: "complete",
  ERROR: "error",
} as const;

export const ATTEMPT_COST_CONFIDENCE = {
  COMPLETE: "complete",
  PARTIAL: "partial",
} as const;

export const ATTEMPT_COST_NOTE_CODES = {
  HARNESS_DIVERGENCE: "harness-divergence",
} as const;

export const ATTEMPT_COST_UNAVAILABLE_REASONS = {
  UNKNOWN_MODEL: "unknown-model",
  PARTIAL_TOKENS: "partial-tokens",
  UNVERIFIED_TOKEN_SEMANTICS: "unverified-token-semantics",
  MISSING_HARNESS_COST: "missing-harness-cost",
} as const;

/** How a harness reports cache-read tokens relative to its input count. */
export const ATTEMPT_COST_CACHE_RELATIONSHIPS = {
  SUBSET: "subset",
  DISJOINT: "disjoint",
  UNKNOWN: "unknown",
} as const;

/** How separately reported reasoning tokens relate to billed output. */
export const ATTEMPT_COST_REASONING_RELATIONSHIPS = {
  INCLUDED_IN_OUTPUT: "included-in-output",
  DISJOINT: "disjoint",
  UNREPORTED: "unreported",
  UNKNOWN: "unknown",
} as const;

// ============================================================================
// HARNESS USAGE - Normalized provider and observed-usage discriminants
// ============================================================================
export const HARNESS_QUOTA_SOURCES = {
  PROVIDER_LIVE: "provider-live",
  PROVIDER_LOG: "provider-log",
  ENTERPRISE_API: "enterprise-api",
  UNAVAILABLE: "unavailable",
} as const;

export const HARNESS_USAGE_WINDOW_KINDS = {
  ROLLING: "rolling",
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  UNKNOWN: "unknown",
} as const;

const USAGE_WINDOW_WEEK_MINUTES = 7 * 24 * 60;

/** Derive a rate-limit window's display kind from its duration alone, not a provider bucket name. */
export function usageWindowKind(
  windowMinutes: number
): (typeof HARNESS_USAGE_WINDOW_KINDS)["ROLLING" | "WEEKLY"] {
  return windowMinutes >= USAGE_WINDOW_WEEK_MINUTES
    ? HARNESS_USAGE_WINDOW_KINDS.WEEKLY
    : HARNESS_USAGE_WINDOW_KINDS.ROLLING;
}

/**
 * Format a rate-limit window's duration into a short display label, e.g. "week",
 * "day", "5h". Single-sourced so every harness's rolling windows read consistently
 * instead of each provider's normalizer inventing its own phrasing.
 */
export function formatUsageWindowLabel(windowMinutes: number): string {
  return formatSharedUsageWindowLabel(windowMinutes);
}

export const HARNESS_OBSERVED_PERIODS = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
} as const;

export const HARNESS_USAGE_CONFIDENCE = {
  EXACT: "exact",
  APPROXIMATE: "approximate",
  LAST_KNOWN: "last-known",
} as const;

export const HARNESS_USAGE_UNITS = {
  TOKENS: "tokens",
  CREDITS: "credits",
  REQUESTS: "requests",
  PERCENT: "percent",
  UNKNOWN: "unknown",
} as const;

/** Freshness windows for normalized provider snapshots. */
export const HARNESS_USAGE_FRESHNESS_MS = {
  PROVIDER_LIVE: 5 * 60 * 1000,
  PROVIDER_LOG: 15 * 60 * 1000,
} as const;

/** Safe, non-provider-specific status codes surfaced by compact usage chips. */
export const HARNESS_USAGE_STATUS_CODES = {
  AUTH_REQUIRED: "auth-required",
  UNSUPPORTED_AUTH_MODE: "unsupported-auth-mode",
  /**
   * Quota is pushed by an active statusline sidecar (Claude, Antigravity),
   * not pulled by a standalone probe, and no push has landed yet in this
   * environment. Distinct from a provider that structurally never reports
   * quota — see HARNESS_QUOTA_SOURCES.UNAVAILABLE usage in those providers.
   */
  SIDECAR_PENDING: "sidecar-pending",
} as const;

/** Delay used to coalesce repeated usage refresh requests. */
export const HARNESS_USAGE_REFRESH_DEBOUNCE_MS = 100;

// ============================================================================
// EXECUTION PREVIEW - Shared preview contract discriminants and limits
// ============================================================================
export const PREVIEW_SCOPES = {
  WORKFLOW: "workflow",
  STEP: "step",
} as const;

export const PREVIEW_MUTATION_SCOPES = {
  RUN_LOCAL: "run-local",
  SHARED: "shared",
} as const;

export const PREVIEW_STATUSES = {
  CHECKING: "checking",
  READY: "ready",
} as const;

/** Navigation selection used by the workflow-level execution preview. */
export const PREVIEW_RAIL_SELECTIONS = {
  OVERVIEW: "overview",
} as const;

export const PREVIEW_STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
} as const;

export const PREVIEW_PERMISSION_ACTIONS = {
  ALLOW: "allow",
  DENY: "deny",
} as const;

/** Durable trust-store decisions shared by workspace trust stores. */
export const TRUST_DECISIONS = {
  ALLOW: "allow",
  DENY: "deny",
} as const;

export const PREVIEW_PERMISSION_RULE_STATUSES = {
  APPLIED: "applied",
  IGNORED: "ignored",
  PARTIAL: "partial",
  UNVERIFIED: "unverified",
} as const;

export const PREVIEW_PROPERTY_SOURCES = {
  PROMPT: "prompt",
  WORKFLOW: "workflow",
  GLOBAL_DEFAULT: "global-default",
} as const;

export const PREVIEW_PROMPT_CATEGORIES = {
  AGENT_INSTRUCTIONS: "agent-instructions",
  SECRETS: "secrets",
  SKILL_CONTENT: "skill-content",
  PROMPT_TEXT: "prompt-text",
  PRIOR_CONTEXT: "prior-context",
  INLINE_REFERENCE: "inline-reference",
  FILE_REFERENCE: "file-reference",
  IMAGE_METADATA: "image-metadata",
} as const;

export const PREVIEW_PROMPT_CATEGORY_LABELS: Record<
  PreviewPromptCategory,
  string
> = {
  "agent-instructions": "Agent instructions",
  secrets: "Available secrets",
  "skill-content": "Skill content",
  "prompt-text": "Prompt text",
  "prior-context": "Prior context",
  "inline-reference": "Excerpts",
  "file-reference": "File reference",
  "image-metadata": "Image metadata",
};

export const PREVIEW_TRUNCATION_REASONS = {
  REFERENCE: "reference",
  OVER_INLINE_CAP: "over-inline-cap",
  CHUNK_COLLAPSED: "chunk-collapsed",
  BODY_BUDGET: "body-budget",
  NOT_YET_AVAILABLE: "not-yet-available",
} as const;

export const PREVIEW_TRUNCATION_REASON_COPY: Record<
  PreviewTruncationReason,
  string
> = {
  [PREVIEW_TRUNCATION_REASONS.REFERENCE]:
    "The harness receives this as a file reference directly in the prompt, not the file's inline content.",
  [PREVIEW_TRUNCATION_REASONS.OVER_INLINE_CAP]:
    "Preview only: this chunk's body is hidden because it exceeds the inline content cap. The harness still receives it in full via the referenced file.",
  [PREVIEW_TRUNCATION_REASONS.CHUNK_COLLAPSED]:
    "Modal view is collapsed: expand this chunk to inspect its body.",
  [PREVIEW_TRUNCATION_REASONS.BODY_BUDGET]:
    "Preview only: the dry-run preview budget cut off this chunk's body here. The harness still receives it in full.",
  [PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE]:
    "No prior context to preview yet: this reference resolves against run history that doesn't exist until the step runs.",
};

/** Total UTF-8 body budget for one serialized execution preview. */
export const MAX_PREVIEW_BODY_BYTES = 1024 * 1024;

// ============================================================================
// CAPABILITY VOCABULARY - Shared compatibility contract discriminants
// ============================================================================
export const CAPABILITY_FIDELITIES = {
  EXACT: "exact",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
} as const;

export const CAPABILITY_MECHANISMS = {
  NATIVE: "native",
  TRANSLATED_CLI: "translated-cli",
  WORKSPACE_CONFIG: "workspace-config",
  MIXED: "mixed",
  NONE: "none",
} as const;

export const CAPABILITY_VERIFICATION_STATUSES = {
  VERIFIED: "verified",
  UNKNOWN: "unknown",
} as const;

export const CAPABILITY_VERIFICATION_KINDS = {
  BEHAVIORAL_TEST: "behavioral-test",
  MANUAL: "manual",
} as const;

export const CAPABILITY_VERIFICATION_BASES = {
  CLI_VERSION: "cli-version",
} as const;

export const CAPABILITY_DOMAINS = {
  PERMISSIONS: "permissions",
  PROMPT_INPUTS: "promptInputs",
  HOOKS: "hooks",
  MCP: "mcp",
} as const;

export const PERMISSION_CAPABILITY_KEYS = {
  MODE: "mode",
  ALLOWED_TOOLS: "allowedTools",
  DENIED_TOOLS: "deniedTools",
} as const;

export const PROMPT_INPUT_CAPABILITY_KEYS = {
  IMAGES: "images",
} as const;

export const MCP_CAPABILITY_KEYS = {
  PER_SERVER_TOOL_FILTERING: "perServerToolFiltering",
} as const;

export const MCP_SECRET_CONFIG_MODES = {
  REFERENCE: "reference",
  SUBSTITUTE: "substitute",
} as const;

// ============================================================================
// HARNESS CONFIG KEYS - Shared keys in harness-owned JSON configuration
// ============================================================================
export const HARNESS_CONFIG_KEYS = {
  PERMISSION: "permission",
} as const;

// ============================================================================
// MCP TRANSPORTS - Remote MCP protocol values
// ============================================================================
export const MCP_TRANSPORTS = {
  STREAMABLE_HTTP: "streamable-http",
  SSE: "sse",
} as const;

export type McpTransport = (typeof MCP_TRANSPORTS)[keyof typeof MCP_TRANSPORTS];

/** Entry types and property names used by native MCP configuration formats. */
export const MCP_CONFIG_ENTRY_TYPES = {
  HTTP: "http",
  LOCAL: "local",
  REMOTE: "remote",
  STDIO: "stdio",
} as const;

export const MCP_CONFIG_KEYS = {
  COMMAND: "command",
  ENV: "env",
  HEADERS: "headers",
} as const;

/** Package registry identifiers used by the public MCP registry. */
export const MCP_REGISTRY_PACKAGE_TYPES = {
  NPM: "npm",
} as const;

export const COMPATIBILITY_DIAGNOSTIC_SEVERITIES = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

/** Diagnostic codes emitted while preparing prompt references for execution. */
export const PROMPT_DIAGNOSTIC_CODES = {
  LARGE_REFERENCE: "prompt.reference.implausibly-large",
  OVER_INLINE_CAP: "prompt.content.over-inline-cap",
  SOURCE_RUNTIME_DISCLOSURE: "prompt.reference.source-runtime-disclosure",
  UNKNOWN_SKILL_REFERENCE: "prompt.skill.unknown",
  UNKNOWN_SECRET_REFERENCE: "prompt.secret.unknown",
  UNRESOLVED_REFERENCE: "prompt.reference.unresolved",
  UNKNOWN_MCP_REFERENCE: "prompt.mcp.unknown",
  CONDITION_OUTPUT_UNAVAILABLE: "prompt.reference.condition-output-unavailable",
  SECRET_INTERPOLATION_IGNORED: "prompt.secret.interpolation-ignored",
  VARIABLE_SUBSTITUTION_IGNORED: "prompt.variable.substitution-ignored",
  MCP_AVAILABILITY_DISABLED: "prompt.mcp.disabled",
} as const;

export type PromptDiagnosticCode =
  (typeof PROMPT_DIAGNOSTIC_CODES)[keyof typeof PROMPT_DIAGNOSTIC_CODES];

const CONTEXT_RESOLUTION_DIAGNOSTIC_CODES = [
  PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SKILL_REFERENCE,
  PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SECRET_REFERENCE,
  PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
  PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE,
] as const satisfies readonly PromptDiagnosticCode[];

export type ContextResolutionDiagnosticCode =
  (typeof CONTEXT_RESOLUTION_DIAGNOSTIC_CODES)[number];

/** Whether a diagnostic represents a declared reference that failed to resolve. */
export function isContextResolutionDiagnostic(
  code: string
): code is ContextResolutionDiagnosticCode {
  return CONTEXT_RESOLUTION_DIAGNOSTIC_CODES.includes(
    code as ContextResolutionDiagnosticCode
  );
}

/** Format the diagnostics that block a step when strict context resolution is enabled. */
export function formatContextResolutionFailureMessage(
  diagnostics: readonly { readonly message: string }[]
): string {
  const count = diagnostics.length;
  return [
    `Step blocked by execution.strictContextResolution="fail" — ${count} reference${
      count === 1 ? "" : "s"
    } did not resolve:`,
    ...diagnostics.map((diagnostic) => `  • ${diagnostic.message}`),
  ].join("\n");
}

export const COMPATIBILITY_SOURCE_TIERS = {
  PROMPT: "prompt",
  WORKFLOW: "workflow",
  DEFAULTS: "defaults",
} as const;

/** Target selectors supported by `ctrlyoke validate`. */
export const CLI_VALIDATE_TARGET_KINDS = {
  HARNESS: "harness",
  ALL_INSTALLED_HARNESSES: "allInstalledHarnesses",
} as const;

export type CliValidateTargetKind =
  (typeof CLI_VALIDATE_TARGET_KINDS)[keyof typeof CLI_VALIDATE_TARGET_KINDS];

/** Optional CI policies for treating compatibility warnings as failures. */
export const CLI_VALIDATE_STRICT_POLICIES = {
  LOSSY: "lossy",
  UNVERIFIED: "unverified",
  ALL: "all",
} as const;

export type CliValidateStrictPolicy =
  (typeof CLI_VALIDATE_STRICT_POLICIES)[keyof typeof CLI_VALIDATE_STRICT_POLICIES];

/** Shared dot-notation paths for settings consumed across the extension and webview. */
export const SETTING_PATHS = {
  STORAGE: "storage",
  WORKTREES: "worktrees",
  STORAGE_RUN_HISTORY_LOCATION: "storage.runHistoryLocation",
  PERMISSIONS_STATUS_LINE_TRACKING: "permissions.statusLineTracking",
  PERMISSIONS_STATUS_LINE_TRACKING_USE_DIFFERENT_FORMAT_PER_HARNESS:
    "permissions.statusLineTracking.useDifferentFormatPerHarness",
  PERMISSIONS_STATUS_LINE_TRACKING_SHARED_FORMAT:
    "permissions.statusLineTracking.sharedFormat",
  PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_ENABLED:
    "permissions.statusLineTracking.claude.enabled",
  PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_CUSTOM_COMMAND:
    "permissions.statusLineTracking.claude.customCommand",
  PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_USE_CTRLYOKE_STYLE:
    "permissions.statusLineTracking.claude.useCtrlyokeStyle",
  PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_FORMAT:
    "permissions.statusLineTracking.claude.format",
  PERMISSIONS_STATUS_LINE_TRACKING_ANTIGRAVITY_ENABLED:
    "permissions.statusLineTracking.antigravity.enabled",
  PERMISSIONS_STATUS_LINE_TRACKING_ANTIGRAVITY_CUSTOM_COMMAND:
    "permissions.statusLineTracking.antigravity.customCommand",
  PERMISSIONS_STATUS_LINE_TRACKING_ANTIGRAVITY_USE_CTRLYOKE_STYLE:
    "permissions.statusLineTracking.antigravity.useCtrlyokeStyle",
  PERMISSIONS_STATUS_LINE_TRACKING_ANTIGRAVITY_FORMAT:
    "permissions.statusLineTracking.antigravity.format",
  PERMISSIONS_STATUS_LINE_TRACKING_COPILOT_ENABLED:
    "permissions.statusLineTracking.copilot.enabled",
  PERMISSIONS_STATUS_LINE_TRACKING_COPILOT_CUSTOM_COMMAND:
    "permissions.statusLineTracking.copilot.customCommand",
  PERMISSIONS_STATUS_LINE_TRACKING_COPILOT_USE_CTRLYOKE_STYLE:
    "permissions.statusLineTracking.copilot.useCtrlyokeStyle",
  PERMISSIONS_STATUS_LINE_TRACKING_COPILOT_FORMAT:
    "permissions.statusLineTracking.copilot.format",
  PERMISSIONS_STATUS_LINE_TRACKING_QWEN_ENABLED:
    "permissions.statusLineTracking.qwen.enabled",
  PERMISSIONS_STATUS_LINE_TRACKING_QWEN_CUSTOM_COMMAND:
    "permissions.statusLineTracking.qwen.customCommand",
  PERMISSIONS_STATUS_LINE_TRACKING_QWEN_USE_CTRLYOKE_STYLE:
    "permissions.statusLineTracking.qwen.useCtrlyokeStyle",
  PERMISSIONS_STATUS_LINE_TRACKING_QWEN_FORMAT:
    "permissions.statusLineTracking.qwen.format",
  USAGE_TRACKING_ENABLED: "usageTracking.enabled",
  USAGE_TRACKING_PERCENT_DIRECTION: "usageTracking.percentDirection",
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

/** Theme-aware colors for the workspace harness-share bar. */
export const HARNESS_CHART_COLORS: Record<HarnessId, string> = {
  [HARNESS_IDS.COPILOT_CLI]: "var(--vscode-charts-blue, #59a4f9)",
  [HARNESS_IDS.CLAUDE_CLI]: "var(--vscode-charts-orange, #d18616)",
  [HARNESS_IDS.CODEX_CLI]: "var(--vscode-editor-foreground, #ffffff)",
  [HARNESS_IDS.OPENCODE_CLI]: "var(--vscode-charts-gray, #808080)",
  [HARNESS_IDS.QWEN_CLI]: "var(--vscode-charts-purple, #b180d7)",
  [HARNESS_IDS.ANTIGRAVITY_CLI]: "var(--vscode-charts-green, #89d185)",
};

// ============================================================================
// HOOK EVENT - Logical hook event names and metadata
// ============================================================================

export const HOOK_EVENT_NAMES = {
  STOP: "stop",
  SESSION_START: "sessionStart",
  PRE_TOOL_USE: "preToolUse",
  POST_TOOL_USE: "postToolUse",
  USER_PROMPT_SUBMIT: "userPromptSubmit",
  PERMISSION_REQUEST: "permissionRequest",
  NOTIFICATION: "notification",
  ERROR: "error",
} as const;

/** Exact provider payload event names used by notification monitors. */
export const NOTIFICATION_HOOK_EVENTS = {
  STOP: "Stop",
} as const;

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
 * | "notification"      | Notification     | notification        | n/a              | n/a               | n/a                     |
 * | "error"            | StopFailure      | errorOccurred     | n/a              | n/a               | session.error           |
 */
export type HookEvent =
  (typeof HOOK_EVENT_NAMES)[keyof typeof HOOK_EVENT_NAMES];

export interface HookEventMetadata {
  event: HookEvent;
  label: string;
  description: string;
}

export const HOOK_EVENT_ORDER: HookEvent[] = [
  HOOK_EVENT_NAMES.STOP,
  HOOK_EVENT_NAMES.SESSION_START,
  HOOK_EVENT_NAMES.PRE_TOOL_USE,
  HOOK_EVENT_NAMES.POST_TOOL_USE,
  HOOK_EVENT_NAMES.USER_PROMPT_SUBMIT,
  HOOK_EVENT_NAMES.PERMISSION_REQUEST,
  HOOK_EVENT_NAMES.NOTIFICATION,
  HOOK_EVENT_NAMES.ERROR,
];

export const HOOK_EVENT_METADATA: HookEventMetadata[] = [
  {
    event: "stop",
    label: "Stop",
    description: "Fires when the AI agent finishes responding.",
  },
  {
    event: "sessionStart",
    label: "Session Start",
    description: "Fires when a new AI session is created.",
  },
  {
    event: "preToolUse",
    label: "Pre Tool Use",
    description: "Fires before the AI invokes a tool.",
  },
  {
    event: "postToolUse",
    label: "Post Tool Use",
    description: "Fires after the AI receives the result of a tool call.",
  },
  {
    event: "userPromptSubmit",
    label: "User Prompt Submit",
    description: "Fires when a user prompt is submitted to the AI.",
  },
  {
    event: HOOK_EVENT_NAMES.PERMISSION_REQUEST,
    label: "Permission Request",
    description: "Fires when the AI requests permission to perform an action.",
  },
  {
    event: "notification",
    label: "Notification",
    description:
      "Fires when the harness displays a notification, including prompts that may require user input.",
  },
  {
    event: "error",
    label: "Error",
    description: "Fires when the harness reports a session-level error.",
  },
];

// ============================================================================
// EXECUTION MODES - Execution environment for CLI commands
// ============================================================================
// ============================================================================
// WORKTREE MODES - Workflow execution checkout selection
// ============================================================================
export const WORKTREE_MODES = {
  NONE: "none",
  MANAGED: "managed",
  NAMED: "named",
} as const;

export type WorktreeMode = (typeof WORKTREE_MODES)[keyof typeof WORKTREE_MODES];

export const WORKTREE_LIFECYCLE_OWNERS = {
  CTRLYOKE: "ctrlyoke",
  USER: "user",
} as const;

export type WorktreeLifecycleOwner =
  (typeof WORKTREE_LIFECYCLE_OWNERS)[keyof typeof WORKTREE_LIFECYCLE_OWNERS];

export const WORKTREE_LIFECYCLE_STATES = {
  PROVISIONING: "provisioning",
  READY: "ready",
  FINALIZING: "finalizing",
  SETTLED: "settled",
  BLOCKED: "blocked",
  ORPHANED: "orphaned",
} as const;

/**
 * Display-only worktree management states used by the settings UI. These are
 * intentionally separate from the orchestration lifecycle/state contracts.
 */
export const WORKTREE_UI_STATUSES = {
  BRANCH_PRESENT: "present",
  DIRECTORY_REMOVED: "removed",
} as const;

export type WorktreeLifecycleState =
  (typeof WORKTREE_LIFECYCLE_STATES)[keyof typeof WORKTREE_LIFECYCLE_STATES];

// ============================================================================
// WORKTREE EDIT KINDS - Lineage preparation and start-position edit kinds
// ============================================================================
export const WORKTREE_EDIT_KINDS = {
  DRAFT: "draft",
  REWIND: "rewind",
} as const;

export type WorktreeEditKind =
  (typeof WORKTREE_EDIT_KINDS)[keyof typeof WORKTREE_EDIT_KINDS];

export const WORKTREE_POSITION_DIRECTIONS = {
  REWIND: WORKTREE_EDIT_KINDS.REWIND,
  FORWARD: "forward",
} as const;

export type WorktreePositionDirection =
  (typeof WORKTREE_POSITION_DIRECTIONS)[keyof typeof WORKTREE_POSITION_DIRECTIONS];

// ============================================================================
// WORKTREE RUNTIME STATES - Persisted managed/named checkout lifecycle values
// ============================================================================
export const WORKTREE_DIRECTORY_STATES = {
  PRESENT: "present",
  REMOVED: "removed",
  MISSING: "missing",
  REMOVE_FAILED: "remove-failed",
} as const;

export type WorktreeDirectoryState =
  (typeof WORKTREE_DIRECTORY_STATES)[keyof typeof WORKTREE_DIRECTORY_STATES];

export const WORKTREE_DIRECTORY_OUTCOMES = {
  REMOVED: WORKTREE_DIRECTORY_STATES.REMOVED,
  KEPT: "kept",
  REMOVE_FAILED: "remove-failed",
} as const;

export type WorktreeDirectoryOutcome =
  (typeof WORKTREE_DIRECTORY_OUTCOMES)[keyof typeof WORKTREE_DIRECTORY_OUTCOMES];

export const WORKTREE_BRANCH_STATES = {
  PRESENT: "present",
  DELETED: "deleted",
  MISSING: "missing",
} as const;

export type WorktreeBranchState =
  (typeof WORKTREE_BRANCH_STATES)[keyof typeof WORKTREE_BRANCH_STATES];

export const WORKTREE_SETUP_OUTCOMES = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const;

export type WorktreeSetupOutcome =
  (typeof WORKTREE_SETUP_OUTCOMES)[keyof typeof WORKTREE_SETUP_OUTCOMES];

export const WORKTREE_LANDING_OUTCOMES = {
  LANDED: "landed",
  NO_CHANGES: "no-changes",
  BLOCKED: "blocked",
} as const;

export type WorktreeLandingOutcome =
  (typeof WORKTREE_LANDING_OUTCOMES)[keyof typeof WORKTREE_LANDING_OUTCOMES];

/** Which tier supplied a resolved worktree config: the workflow itself, or a settings default. */
export const WORKTREE_CONFIG_ORIGINS = {
  AUTHORED: "authored",
  DEFAULT: "default",
} as const;

export type WorktreeConfigOrigin =
  (typeof WORKTREE_CONFIG_ORIGINS)[keyof typeof WORKTREE_CONFIG_ORIGINS];

export const WORKTREE_RECOVERY_OUTCOMES = {
  LANDED: WORKTREE_LANDING_OUTCOMES.LANDED,
  NO_CHANGES: WORKTREE_LANDING_OUTCOMES.NO_CHANGES,
  ORPHANED: "orphaned",
} as const;

export type WorktreeRecoveryOutcome =
  (typeof WORKTREE_RECOVERY_OUTCOMES)[keyof typeof WORKTREE_RECOVERY_OUTCOMES];

export const WORKTREE_MERGE_OUTCOMES = {
  FAST_FORWARD: "fast-forward",
  MERGE_COMMIT: "merge-commit",
  CONFLICT: "conflict",
  BLOCKED: "blocked",
  ABORT_FAILED: "abort-failed",
} as const;

export type WorktreeMergeOutcome =
  (typeof WORKTREE_MERGE_OUTCOMES)[keyof typeof WORKTREE_MERGE_OUTCOMES];

// ============================================================================
// WORKFLOW VIEW ADDRESS KIND - Discriminant for WorkflowViewAddress
// ============================================================================
export const WORKFLOW_VIEW_ADDRESS_KIND = {
  DRAFT: "draft",
  RUN: "run",
} as const;

// ============================================================================
// WORKFLOW DELETE SCOPES - History/context-menu deletion targets
// ============================================================================
export const WORKFLOW_DELETE_SCOPES = {
  LINEAGE: "lineage",
  RUN: "run",
  ALL: "all",
} as const;

export type WorkflowDeleteScope =
  (typeof WORKFLOW_DELETE_SCOPES)[keyof typeof WORKFLOW_DELETE_SCOPES];

export const WORKTREE_MANAGEMENT_ACTIONS = {
  REMOVE: "remove",
  FORCE_REMOVE: "force-remove",
  PRUNE: "prune",
  REPAIR: "repair",
  CLEANUP_BRANCH: "cleanup-branch",
} as const;

export type WorktreeManagementAction =
  (typeof WORKTREE_MANAGEMENT_ACTIONS)[keyof typeof WORKTREE_MANAGEMENT_ACTIONS];

export const EXECUTION_MODES = {
  INTERACTIVE: "interactive",
  HEADLESS: "headless",
} as const;

export const HEADLESS_SOURCE_MODES = {
  STDOUT: "stdout",
  LOG: "log",
} as const;

export type HeadlessSourceMode =
  (typeof HEADLESS_SOURCE_MODES)[keyof typeof HEADLESS_SOURCE_MODES];

export const CONTEXT_RESOLUTION_FAILURE_MODES = {
  WARN: "warn",
  FAIL: "fail",
} as const;

export type ContextResolutionFailureMode =
  (typeof CONTEXT_RESOLUTION_FAILURE_MODES)[keyof typeof CONTEXT_RESOLUTION_FAILURE_MODES];

export type ExecutionMode =
  (typeof EXECUTION_MODES)[keyof typeof EXECUTION_MODES];

export const MCP_AVAILABILITY_MODES = {
  AUTO: "auto",
  DISABLED: "disabled",
} as const;

export type McpAvailability =
  (typeof MCP_AVAILABILITY_MODES)[keyof typeof MCP_AVAILABILITY_MODES];

export const EXECUTION_MODE_OPTIONS = [
  { value: EXECUTION_MODES.INTERACTIVE, label: "Interactive" },
  { value: EXECUTION_MODES.HEADLESS, label: "Headless" },
];

export const WORKTREE_MODE_OPTIONS = [
  { value: WORKTREE_MODES.NONE, label: "None" },
  { value: WORKTREE_MODES.MANAGED, label: "Managed" },
  { value: WORKTREE_MODES.NAMED, label: "Named" },
];

export const EXECUTION_MODE_HELP_TEXT =
  "Interactive spawns a live terminal you can steer; headless runs in the background with output in the Output panel. Pre- and end-condition scripts always run headless. With inject mode on, inserting a headless step between interactive steps retires and respawns the PTY, so TUI continuity is lost across that boundary.";

export const WORKTREE_MODE_HELP_TEXT =
  "None runs in your working checkout. Managed creates a throw-away worktree and branch per run and removes the directory when the workflow completes, leaving the branch for review — pick it for isolated runs you will not follow up on. Named targets a persistent worktree you own, which ctrlyoke never commits, merges, or removes — pick it for conversational workflows you will append to. Worktrees are workflow-level and do not apply to individual prompts.";

export const WORKTREE_KEEP_HELP_TEXT =
  "Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch — ignored files such as `node_modules` are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run.";

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

/**
 * Resolve the array index a queue position splices at, given the execution head
 * and the current step count. Single source for every append path — the
 * in-memory queue, the dashboard queue operation, and the cross-process run
 * continuation transaction — so `next`/`beforeCurrent`/`end` cannot drift apart.
 */
export function resolveQueueInsertIndex(
  position: QueuePosition,
  currentIndex: number,
  stepCount: number
): number {
  switch (position) {
    case QUEUE_POSITION.NEXT:
      return Math.min(Math.max(currentIndex + 1, 0), stepCount);
    case QUEUE_POSITION.BEFORE_CURRENT:
      return Math.min(Math.max(currentIndex, 0), stepCount);
    default:
      return stepCount;
  }
}

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

/**
 * Maximum UTF-8 size retained in an output snapshot (15 MB), shared with
 * pasted images so attachment handling has one predictable size ceiling.
 */
export const MAX_OUTPUT_SNAPSHOT_BYTES = MAX_PASTED_IMAGE_BYTES;

/** Maximum UTF-8 content size captured for workspace and undo diffs (512 KB). */
export const MAX_CONTENT_SIZE = 512 * 1024;

/** Maximum size of a source-checkout artifact copied into an execution checkout (32 MB). */
export const MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES = 32 * 1024 * 1024;

/**
 * Rough token-length heuristic (OpenAI's documented "~4 characters per token
 * for English text" rule of thumb) used wherever a file/content is too large
 * to tokenize exactly without risking a single huge allocation. Single-sourced
 * so `FileTokenEstimator` and `PromptFileSplitter`'s tokenizer-failure fallback
 * agree on the same approximation.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

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

/** Placeholder inserted at the cursor while an output snapshot saves asynchronously. */
export const CAPTURING_OUTPUT_PLACEHOLDER = "[Capturing output…]";

/** Milliseconds before an unanswered SAVE_PASTED_IMAGE round trip is treated as failed. */
export const PASTED_IMAGE_SAVE_TIMEOUT_MS = 30_000;

/** Milliseconds before an unanswered SAVE_OUTPUT_SNAPSHOT round trip is treated as failed. */
export const OUTPUT_SNAPSHOT_SAVE_TIMEOUT_MS = PASTED_IMAGE_SAVE_TIMEOUT_MS;

/** Milliseconds before an unanswered prompt-file conversion is treated as failed. */
export const PROMPT_FILE_CONVERSION_TIMEOUT_MS = 30_000;

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
// SHELL TYPES - Executable names recognized when inferring a shell kind
// ============================================================================
export const SHELL_TYPES = {
  BASH: "bash",
  ZSH: "zsh",
  FISH: "fish",
  WSL: "wsl",
  NU: "nu",
  NUSHELL: "nushell",
  SH: "sh",
  DASH: "dash",
  KSH: "ksh",
  CMD: "cmd",
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
  ZSH: SHELL_TYPES.ZSH,
  /** bash */
  BASH: SHELL_TYPES.BASH,
  /** POSIX sh / dash / ksh-style shells */
  SH: SHELL_TYPES.SH,
  /** fish shell */
  FISH: SHELL_TYPES.FISH,
  /** Windows Command Prompt */
  CMD: SHELL_TYPES.CMD,
  /** WSL launcher */
  WSL: SHELL_TYPES.WSL,
  /** Nushell */
  NUSHELL: SHELL_TYPES.NU,
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

export const PRIOR_CONTEXT_REFERENCE_KINDS = {
  PREVIOUS: PRIOR_CONTEXT_KEYWORDS.PREVIOUS,
  ALL: PRIOR_CONTEXT_KEYWORDS.ALL,
  FINAL_STEP: "finalStep",
  ALL_FINAL_STEP: "allFinalStep",
  STEP: "step",
} as const;

export type PriorContextReferenceKind =
  (typeof PRIOR_CONTEXT_REFERENCE_KINDS)[keyof typeof PRIOR_CONTEXT_REFERENCE_KINDS];

export const PRIOR_CONTEXT_SELECTION_MODES = {
  RUN: "run",
  CUSTOM: "custom",
} as const;

export type PriorContextSelectionMode =
  (typeof PRIOR_CONTEXT_SELECTION_MODES)[keyof typeof PRIOR_CONTEXT_SELECTION_MODES];

export const PROPERTY_EDITOR_MODES = {
  INHERIT: "inherit",
  NONE: "none",
  CUSTOM: "custom",
} as const;

export type PropertyEditorMode =
  (typeof PROPERTY_EDITOR_MODES)[keyof typeof PROPERTY_EDITOR_MODES];

/** Tabs exposed by the global settings drawer. */
export const GLOBAL_SETTINGS_TABS = {
  GENERAL: "general",
  WORKFLOW: "workflow",
  EXECUTION: "execution",
  QUEUE: "queue",
  WORKTREES: "worktrees",
  TERMINAL: "terminal",
  STATUS_LINE: "statusline",
  COMMIT: "commit",
  PERMISSIONS: "permissions",
  SECRETS: "secrets",
  SERVER: "server",
  AGENT_SKILLS_MANAGER: "agentskillsmanager",
  MCP_MANAGER: "mcpmanager",
  NOTIFICATIONS: "notifications",
  STATS: "stats",
  LICENSE: "license",
  DEVELOPER: "developer",
} as const;

export type GlobalSettingsTab =
  (typeof GLOBAL_SETTINGS_TABS)[keyof typeof GLOBAL_SETTINGS_TABS];

/** Text values used by the Resume Session dropdown. */
export const RESUME_SESSION_SELECTIONS = {
  YES: "yes",
  NO: "no",
} as const;

// ============================================================================
// CODEMIRROR EDITOR MODES - Context modes for the prompt editor
// ============================================================================
export const CODE_MIRROR_EDITOR_MODES = {
  PROMPT: "prompt",
  END_CONDITION: "endCondition",
} as const;

export type CodeMirrorEditorMode =
  (typeof CODE_MIRROR_EDITOR_MODES)[keyof typeof CODE_MIRROR_EDITOR_MODES];

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
// SCM FILE KINDS - Git source-control file status values
// ============================================================================
export const SCM_FILE_KINDS = {
  MODIFIED: "modified",
  ADDED: "added",
  DELETED: "deleted",
  RENAMED: "renamed",
  UNTRACKED: "untracked",
} as const;

export type ScmFileKind = (typeof SCM_FILE_KINDS)[keyof typeof SCM_FILE_KINDS];

// ============================================================================
// DIFF CHANGE TYPES - Normalized file change vocabulary for diff surfaces
// ============================================================================
export const DIFF_CHANGE_TYPES = {
  CREATED: "created",
  MODIFIED: "modified",
  DELETED: "deleted",
  RENAMED: "renamed",
} as const;

export type DiffChangeType =
  (typeof DIFF_CHANGE_TYPES)[keyof typeof DIFF_CHANGE_TYPES];

/** Line discriminants produced by the raw-content diff renderer. */
export const DIFF_LINE_TYPES = {
  ADDED: "added",
  REMOVED: "removed",
  CONTEXT: "context",
} as const;

export type DiffLineType =
  (typeof DIFF_LINE_TYPES)[keyof typeof DIFF_LINE_TYPES];

// ============================================================================
// FILE OPERATION KINDS - File-operation and prompt undo change discriminants
// ============================================================================
export const FILE_OPERATION_KINDS = {
  CREATED: DIFF_CHANGE_TYPES.CREATED,
  MODIFIED: DIFF_CHANGE_TYPES.MODIFIED,
  DELETED: DIFF_CHANGE_TYPES.DELETED,
} as const;

export type FileOperationKind =
  (typeof FILE_OPERATION_KINDS)[keyof typeof FILE_OPERATION_KINDS];

// ============================================================================
// THEME KINDS - Values of the ctrlyoke-forwarded --fp-color-theme-kind CSS var
// ============================================================================
export const THEME_KINDS = {
  LIGHT: "light",
  DARK: "dark",
  HIGH_CONTRAST: "high-contrast",
} as const;

export type ThemeKind = (typeof THEME_KINDS)[keyof typeof THEME_KINDS];

// ============================================================================
// APPLY PATCH FILE EDIT KINDS - Codex patch parser file-operation values
// ============================================================================
export const APPLY_PATCH_FILE_EDIT_KINDS = {
  ADD: "add",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export type ApplyPatchFileEditKind =
  (typeof APPLY_PATCH_FILE_EDIT_KINDS)[keyof typeof APPLY_PATCH_FILE_EDIT_KINDS];

// ============================================================================
// DIFF PAYLOAD KINDS - Content shape for text/image/binary diff responses
// ============================================================================
export const DIFF_PAYLOAD_KINDS = {
  TEXT: "text",
  IMAGE: "image",
  BINARY: "binary",
} as const;

export type DiffPayloadKind =
  (typeof DIFF_PAYLOAD_KINDS)[keyof typeof DIFF_PAYLOAD_KINDS];

// ============================================================================
// DIFF FILE SOURCE KINDS - Render-source discriminants for diff file cards
// ============================================================================
export const DIFF_FILE_SOURCE_KINDS = {
  HUNKS: "hunks",
  PATCH: "patch",
  DEFERRED: "deferred",
} as const;

export type DiffFileSourceKind =
  (typeof DIFF_FILE_SOURCE_KINDS)[keyof typeof DIFF_FILE_SOURCE_KINDS];

// ============================================================================
// DIFF VIEW TYPES - Layout variants used by diff renderers and metrics
// ============================================================================
export const DIFF_VIEW_TYPES = {
  SPLIT: "split",
  UNIFIED: "unified",
} as const;

export type DiffViewType =
  (typeof DIFF_VIEW_TYPES)[keyof typeof DIFF_VIEW_TYPES];

// ============================================================================
// DIFF SIDES - Old/new sides of a rendered diff
// ============================================================================
export const DIFF_SIDES = {
  OLD: "old",
  NEW: "new",
} as const;

export type DiffSide = (typeof DIFF_SIDES)[keyof typeof DIFF_SIDES];

// ============================================================================
// DIFF TOKEN TYPES - Token discriminants emitted by react-diff-view
// ============================================================================
export const DIFF_TOKEN_TYPES = {
  MARK: "mark",
} as const;

export type DiffTokenType =
  (typeof DIFF_TOKEN_TYPES)[keyof typeof DIFF_TOKEN_TYPES];

/** Mark subtypes used by diff find highlighting. */
export const DIFF_MARK_TYPES = {
  FIND: "find",
  FIND_ACTIVE: "find-active",
} as const;

export type DiffMarkType =
  (typeof DIFF_MARK_TYPES)[keyof typeof DIFF_MARK_TYPES];

// ============================================================================
// DIFF FILE LIST ROW KINDS - Virtualized diff-list row discriminants
// ============================================================================
export const DIFF_FILE_LIST_ROW_KINDS = {
  SELECTION_SUMMARY: "selection-summary",
  GROUP_HEADING: "group-heading",
} as const;

export type DiffFileListRowKind =
  (typeof DIFF_FILE_LIST_ROW_KINDS)[keyof typeof DIFF_FILE_LIST_ROW_KINDS];

// ============================================================================
// CONTENT PREVIEW LANGUAGES - Transient modal export format discriminants
// ============================================================================
export const CONTENT_PREVIEW_LANGUAGES = {
  DIFF: "diff",
  JSON: "json",
  XML: "xml",
} as const;

export type ContentPreviewLanguage =
  (typeof CONTENT_PREVIEW_LANGUAGES)[keyof typeof CONTENT_PREVIEW_LANGUAGES];

// ============================================================================
// UNDO DIALOG SCOPE MODES - Scope discriminants for undo/redo dialogs
// ============================================================================
export const UNDO_DIALOG_SCOPE_MODES = {
  PROMPT: "prompt",
  SINGLE_FILE: "singleFile",
} as const;

export type UndoDialogScopeMode =
  (typeof UNDO_DIALOG_SCOPE_MODES)[keyof typeof UNDO_DIALOG_SCOPE_MODES];

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

/** Retry paths used by end-condition handling. */
export const RETRY_KINDS = {
  PASS: "pass",
  FAILURE: "failure",
} as const;

export type RetryKind = (typeof RETRY_KINDS)[keyof typeof RETRY_KINDS];

/** Outcomes returned by one phase of the workflow executor. */
export const WORKFLOW_EXECUTION_OUTCOMES = {
  CONTINUE: CONDITION_ACTIONS.CONTINUE,
  RETRY: CONDITION_ACTIONS.RETRY,
  STOP: "stop",
} as const;

export type WorkflowExecutionOutcome =
  (typeof WORKFLOW_EXECUTION_OUTCOMES)[keyof typeof WORKFLOW_EXECUTION_OUTCOMES];

// ============================================================================
// COMPARE_SOURCES - compareSource values for script evaluation
// ============================================================================
export const COMPARE_SOURCES = {
  AUTO: "auto",
  STDOUT: "stdout",
  STDERR: "stderr",
  EXIT_CODE: "exitCode",
} as const;

/** Display labels for COMPARE_SOURCES values (script/endCondition/preCondition editors) */
export const COMPARE_SOURCE_LABELS: Record<
  (typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES],
  string
> = {
  auto: "Auto",
  stdout: "Stdout",
  stderr: "Stderr",
  exitCode: "Exit Code",
};

// ============================================================================
// SCRIPT OUTPUT SOURCES - Origin values for unified script execution output
// ============================================================================
export const SCRIPT_OUTPUT_SOURCES = {
  SCRIPT_STEP: "script", // keeps today's value — see migration note
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
  WORKTREE_SETUP: "worktreeSetup",
} as const;

/** Scope values for templates stored in user or workspace state. */
export const TEMPLATE_SCOPES = {
  USER: "user",
  WORKSPACE: "workspace",
} as const;

export type TemplateScope =
  (typeof TEMPLATE_SCOPES)[keyof typeof TEMPLATE_SCOPES];

/** IDs for built-in templates whose content is generated or bundled. */
export const TEMPLATE_IDS = {
  BLANK: "blank",
} as const;

/** Sources reported for user-created and workspace-discovered templates. */
export const TEMPLATE_SOURCES = {
  USER: "user",
} as const;

/** Message discriminants exchanged with the history-index rebuild worker. */
export const HISTORY_SEARCH_REBUILD_MESSAGE_TYPES = {
  PROGRESS: "progress",
  SUCCESS: "success",
  ERROR: "error",
} as const;

export type HistorySearchRebuildMessageType =
  (typeof HISTORY_SEARCH_REBUILD_MESSAGE_TYPES)[keyof typeof HISTORY_SEARCH_REBUILD_MESSAGE_TYPES];

/** Scope values projected for files changed during a run. */
export const RUN_FILE_CHANGE_SCOPES = {
  WORKSPACE: "workspace",
  EXTERNAL: "external",
} as const;

export type RunFileChangeScope =
  (typeof RUN_FILE_CHANGE_SCOPES)[keyof typeof RUN_FILE_CHANGE_SCOPES];

// ============================================================================
// HISTORY SEARCH TAXONOMY - Independent event and matched-field dimensions
// ============================================================================
export const HISTORY_EVENT_KINDS = {
  PROMPT: "prompt",
  RESPONSE: "response",
  THINKING: "thinking",
  BASH: "bash",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  TOOL: "tool",
  MCP_TOOL: "mcpTool",
  WEB_SEARCH: "webSearch",
  COMPACTION: "compaction",
  CLI_COMMAND: "cliCommand",
  STATUS: "status",
  SCRIPT: "script",
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
} as const;

export const HISTORY_MATCH_FIELDS = {
  PATH: "path",
  CONTENT: "content",
  DIFF: "diff",
  COMMAND: "command",
  OUTPUT: "output",
  RESPONSE: "response",
  ERROR: "error",
} as const;

// ============================================================================
// EXECUTION PHASES - Identity dimension for prompt and condition attempts
// ============================================================================
export const EXECUTION_PHASES = {
  PROMPT: "prompt", // default; omitted in keys for stability
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
  WORKTREE_SETUP: "worktreeSetup",
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
  WORKTREE: "worktree",

  // Step type discriminant
  STEP_TYPE: "type",

  // Script step properties
  SCRIPT: "script",
  ENV: "env",
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
  SECRETS: "secrets",

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

/** Rendering variants supported by the shared script condition editor. */
export const SCRIPT_CONDITION_VARIANTS = {
  END_CONDITION: PROMPT_PROPERTIES.END_CONDITION,
  PRE_CONDITION: PROMPT_PROPERTIES.PRE_CONDITION,
  SCRIPT_STEP: "scriptStep",
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
  PROMPT_PROPERTIES.SECRETS,
  PROMPT_PROPERTIES.VARS,
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
  PROMPT_PROPERTIES.WORKTREE,
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

  /** Interactive question(s) the AI asked the user mid-turn (Claude's AskUserQuestion
   *  tool, and equivalents on other harnesses). Carries the question set on the
   *  INITIATED event and the resolved answers/decline on the COMPLETED/FAILED one —
   *  see AskUserQuestionData in CliOutputTypes.ts. */
  ASK_USER_QUESTION: "askUserQuestion",

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

export const CLI_OUTPUT_METADATA_KEYS = {
  TIMESTAMP: "timestamp",
  TOTAL_CONFIDENCE: "totalConfidence",
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
// WORKFLOW LOCK STATES - Runner-lock liveness and locality classifications
// ============================================================================
export const WORKFLOW_LOCK_LIVENESS = {
  ABSENT: "absent",
  STALE: "stale",
  ACTIVE: "active",
} as const;

export type WorkflowLockLiveness =
  (typeof WORKFLOW_LOCK_LIVENESS)[keyof typeof WORKFLOW_LOCK_LIVENESS];

export const WORKFLOW_LOCK_LOCALITIES = {
  SELF: "self",
  EXTERNAL: "external",
  INDETERMINATE: "indeterminate",
} as const;

export type WorkflowLockLocality =
  (typeof WORKFLOW_LOCK_LOCALITIES)[keyof typeof WORKFLOW_LOCK_LOCALITIES];

// ============================================================================
// EXTERNAL EXECUTION - Resolver discriminants and rejection reasons
// ============================================================================
export const EXTERNAL_EXECUTION_RESOLUTION_KINDS = {
  NOT_EXTERNAL: "not-external",
  EXTERNAL_ACTIVE_RUN: "external-active-run",
} as const;

export type ExternalExecutionResolutionKind =
  (typeof EXTERNAL_EXECUTION_RESOLUTION_KINDS)[keyof typeof EXTERNAL_EXECUTION_RESOLUTION_KINDS];

export const EXTERNAL_EXECUTION_REASONS = {
  TERMINAL_RUN: "terminal-run",
  NO_ACTIVE_LOCK: "no-active-lock",
  SELF_OWNED: "self-owned",
  INDETERMINATE_OWNER: "indeterminate-owner",
  RUN_REF_MISMATCH: "run-ref-mismatch",
  UNREADABLE_WORKING_FILE: "unreadable-working-file",
} as const;

export type ExternalExecutionReason =
  (typeof EXTERNAL_EXECUTION_REASONS)[keyof typeof EXTERNAL_EXECUTION_REASONS];

export const EXTERNAL_EXECUTION_DECISION_STATES = {
  NOT_INSPECTED: "not-inspected",
} as const;

export const EXTERNAL_EXECUTION_WATCH_ACTIONS = {
  ELIGIBLE: "eligible",
  REJECTED: "rejected",
} as const;

export type ExternalExecutionWatchAction =
  (typeof EXTERNAL_EXECUTION_WATCH_ACTIONS)[keyof typeof EXTERNAL_EXECUTION_WATCH_ACTIONS];

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
// TOOL PERMISSION CATEGORIES - Shared tool categories used by permission rules
// ============================================================================
export const TOOL_PERMISSION_CATEGORIES = {
  BASH: "bash",
  SHELL: "shell",
  READ: "read",
  WRITE: "write",
  EDIT: "edit",
  MCP: "mcp",
  GIT: "git",
} as const;

export const PERSISTENT_VALUE_INSTALL_RESULT_KINDS = {
  NO_OP: "no-op",
  WRITTEN: "written",
  DECLINED: "declined",
} as const;

export type ToolPermissionCategory =
  (typeof TOOL_PERMISSION_CATEGORIES)[keyof typeof TOOL_PERMISSION_CATEGORIES];

/** Tool names used by the output pane's compact tool-badge previews. */
export const OUTPUT_TOOL_BADGE_LABELS = {
  BASH: "bash",
  SHELL: "shell",
  READ: "read",
  WRITE: "write",
  EDIT: "edit",
} as const;

export type OutputToolBadgeLabel =
  (typeof OUTPUT_TOOL_BADGE_LABELS)[keyof typeof OUTPUT_TOOL_BADGE_LABELS];

// ============================================================================
// LOG LEVELS - Webview → Extension log level strings (LOG_MESSAGE payload)
// ============================================================================
export const LOG_LEVELS = {
  TRACE: "trace",
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

/** Message types produced by the live/history output projection. */
export const OUTPUT_MESSAGE_TYPES = {
  STATUS: "status",
  CLI: "cli",
} as const;

export type OutputMessageType =
  (typeof OUTPUT_MESSAGE_TYPES)[keyof typeof OUTPUT_MESSAGE_TYPES];

// ============================================================================
// RUN OUTPUT RESOLVER EVENT KINDS - Events emitted while reducing a run timeline
// ============================================================================
export const RUN_OUTPUT_RESOLVER_EVENT_KINDS = {
  ATTEMPT_STARTED: "attemptStarted",
  STREAMING_CHUNK: "streamingChunk",
  STREAMING_EVENTS: "streamingEvents",
  OUTPUT: "output",
  SCRIPT_EXECUTION: "scriptExecution",
  RETRY_SCHEDULED: "retryScheduled",
  FOLLOW_UP_RESPONSE_APPENDED: "followUpResponseAppended",
  ATTEMPT_TERMINATED: "attemptTerminated",
  RUNTIME_TRANSITION: "runtimeTransition",
  RUN_TERMINATED: "runTerminated",
} as const;

export type RunOutputResolverEventKind =
  (typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS)[keyof typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS];

// ============================================================================
// OUTPUT TABS - Output section tab values stored per workflow
// ============================================================================
export const OUTPUT_TABS = {
  OUTPUT: "output",
  TERMINAL: "terminal",
} as const;

export type OutputTab = (typeof OUTPUT_TABS)[keyof typeof OUTPUT_TABS];

// ============================================================================
// OUTPUT SCROLL TARGETS - Persisted output-pane anchor discriminants
// ============================================================================
export const OUTPUT_SCROLL_TARGET_KINDS = {
  ROW: "row",
  BOTTOM: "bottom",
} as const;

export type OutputScrollTargetKind =
  (typeof OUTPUT_SCROLL_TARGET_KINDS)[keyof typeof OUTPUT_SCROLL_TARGET_KINDS];

/** Alignment modes used when navigating output rows. */
export const OUTPUT_SCROLL_ALIGNMENTS = {
  START: "start",
  CENTER: "center",
  END: "end",
} as const;

export type OutputScrollAlignment =
  (typeof OUTPUT_SCROLL_ALIGNMENTS)[keyof typeof OUTPUT_SCROLL_ALIGNMENTS];

/** DOM anchor modes used when capturing a viewport row reference. */
export const OUTPUT_SCROLL_ANCHOR_MODES = {
  CENTER_POINT: "center-point",
  VISIBLE_TOP: "visible-top",
} as const;

export type OutputScrollAnchorMode =
  (typeof OUTPUT_SCROLL_ANCHOR_MODES)[keyof typeof OUTPUT_SCROLL_ANCHOR_MODES];

/** Default labels used by structured output renderers. */
export const OUTPUT_DEFAULT_LABELS = {
  THINKING: "Thinking",
} as const;

// ============================================================================
// OUTPUT ROW KINDS - Discriminants for rendered output rows
// ============================================================================
export const OUTPUT_ROW_KINDS = {
  ATTEMPT_GROUP_SUMMARY: "attempt-group-summary",
  STEP_ANCHOR: "step-anchor",
  FINAL_STEP_LABEL: "final-step-label",
  STATUS: "status",
  CLI_HEADER: "cli-header",
  PROMPT: "prompt",
  CLI_COMMAND: "cli-command",
  SCRIPT_COMMAND: "script-command",
  ERROR: "error",
  STRUCTURED_EVENT: "structured-event",
  PLAIN_RESPONSE: "plain-response",
  SCRIPT_OUTPUT: "script-output",
  SCRIPT_VERDICT: "script-verdict",
  STATS: "stats",
} as const;

export type OutputRowKind =
  (typeof OUTPUT_ROW_KINDS)[keyof typeof OUTPUT_ROW_KINDS];

// ============================================================================
// TOOL RESULT STATUSES - Display status for generic tool-call results
// ============================================================================
export const TOOL_RESULT_STATUSES = {
  PENDING: "pending",
  SUCCESS: "success",
  ERROR: "error",
} as const;

export type ToolResultStatus =
  (typeof TOOL_RESULT_STATUSES)[keyof typeof TOOL_RESULT_STATUSES];

// ============================================================================
// TOOL-CALL EXPANSION SECTIONS - Expandable generic tool-call content
// ============================================================================
export const TOOL_CALL_EXPANSION_SECTIONS = {
  PARAMS: "params",
  OUTPUT: "output",
  ERROR: "error",
} as const;

export type ToolCallExpansionSection =
  (typeof TOOL_CALL_EXPANSION_SECTIONS)[keyof typeof TOOL_CALL_EXPANSION_SECTIONS];

// ============================================================================
// BASH OUTPUT EXPANSION SECTIONS - Expandable shell command content
// ============================================================================
export const BASH_OUTPUT_EXPANSION_SECTIONS = {
  COMMAND: "command",
  OUTPUT: "output",
  ERROR: "error",
} as const;

export type BashOutputExpansionSection =
  (typeof BASH_OUTPUT_EXPANSION_SECTIONS)[keyof typeof BASH_OUTPUT_EXPANSION_SECTIONS];

// ============================================================================
// RUN SUMMARY CACHE STATUSES - Async status for cached run summaries
// ============================================================================
export const RUN_SUMMARY_CACHE_STATUSES = {
  LOADING: "loading",
  LOADED: "loaded",
  ERROR: "error",
} as const;

export type RunSummaryCacheStatus =
  (typeof RUN_SUMMARY_CACHE_STATUSES)[keyof typeof RUN_SUMMARY_CACHE_STATUSES];

// ============================================================================
// KEYBOARD KEYS - Shared browser keyboard event key values
// ============================================================================
export const KEYBOARD_KEYS = {
  ENTER: "Enter",
  ESCAPE: "Escape",
  ARROW_UP: "ArrowUp",
  ARROW_DOWN: "ArrowDown",
  TAB: "Tab",
} as const;

/** Friendly host-OS tag detected client-side from `navigator`, distinct from Node's `process.platform`. */
export const UI_PLATFORMS = {
  WINDOWS: "windows",
  MAC: "mac",
  LINUX: "linux",
} as const;

export type UiPlatform = (typeof UI_PLATFORMS)[keyof typeof UI_PLATFORMS];

/** Visual variants supported by shared action buttons. */
export const BUTTON_VARIANTS = {
  PRIMARY: "primary",
  SECONDARY: "secondary",
} as const;

/** Workflow dropdown views shared by the status control and its panels. */
export const WORKFLOW_DROPDOWN_VIEWS = {
  WORKFLOWS: "workflows",
  RUNS: "runs",
} as const;

/** File-picker modes used by workflow load and queue actions. */
export const WORKFLOW_FILE_PICKER_MODES = {
  LOAD: "load",
  QUEUE: "queue",
} as const;

/** Row categories used by the unified workflow dropdown list. */
export const WORKFLOW_ROW_KINDS = {
  RUNNING: "running",
  RECENT: "recent",
} as const;

/** Layout tiers used by workflow dropdown rows. */
export const WORKFLOW_ROW_TIERS = {
  STACKED: "stacked",
  COMPACT: "compact",
} as const;

/** Mobile steps drawer presentation modes. */
export const MOBILE_STEPS_MODES = {
  SIDEBAR: "sidebar",
  FULLWIDTH: "fullwidth",
} as const;

/** Transient feedback states for the developer UX snapshot button. */
export const UX_SNAPSHOT_STATUSES = {
  IDLE: "idle",
  CAPTURING: "capturing",
  SAVED: "saved",
  ERROR: "error",
} as const;

// ============================================================================
// INHERIT DEFAULT OPTION - UI sentinel for inherited settings
// ============================================================================
export const INHERIT_DEFAULT_OPTION = "default" as const;

// ============================================================================
// NONE OPTION - UI sentinel for explicitly disabled inherited settings
// ============================================================================
export const NONE_OPTION = "none" as const;

// ============================================================================
// SCRIPT MATCH RULE NONE - Script verdict sentinel when no rule matched
// ============================================================================
export const SCRIPT_MATCH_RULE_NONE = "none" as const;

// ============================================================================
// ATOMIC REFERENCE KINDS - Atomic file/context references across UI layers
// ============================================================================
export const ATOMIC_REFERENCE_KINDS = {
  FILE: "file",
  DIRECTORY: "directory",
  SYMBOL: "symbol",
  LINE_RANGE: "lineRange",
  GIT: "git",
  PRIOR_CONTEXT: "priorContext",
  SKILL: "skill",
  MCP: "mcp",
  SECRET: "secret",
} as const;

export type AtomicReferenceKind =
  (typeof ATOMIC_REFERENCE_KINDS)[keyof typeof ATOMIC_REFERENCE_KINDS];

// ============================================================================
// WORKSPACE ENTRY KINDS - workspace/file-tree and related result kinds
// ============================================================================
export const WORKSPACE_ENTRY_KINDS = {
  FILE: "file",
  DIRECTORY: "directory",
  CONTENT: "content",
} as const;

export type WorkspaceEntryKind =
  (typeof WORKSPACE_ENTRY_KINDS)[keyof typeof WORKSPACE_ENTRY_KINDS];

export type WorkspaceFileTreeEntryKind = Exclude<
  WorkspaceEntryKind,
  typeof WORKSPACE_ENTRY_KINDS.CONTENT
>;

/** Git ref labels rendered by the workspace commit graph. */
export const GIT_REF_LABEL_TYPES = {
  LOCAL_BRANCH: "localBranch",
  REMOTE_BRANCH: "remoteBranch",
  TAG: "tag",
  HEAD: "head",
} as const;

export type GitRefLabelType =
  (typeof GIT_REF_LABEL_TYPES)[keyof typeof GIT_REF_LABEL_TYPES];

/** Relative positions used when comparing commits with the checked-out HEAD. */
export const GIT_HEAD_RELATIONS = {
  AHEAD: "ahead",
  AT: "at",
  BEHIND: "behind",
} as const;

/** Clipboard operations supported by the workspace explorer. */
export const CLIPBOARD_OPERATIONS = {
  COPY: "copy",
  CUT: "cut",
} as const;

/** Directions supported by the run-history adjacent navigation controls. */
export const RUN_NAVIGATION_DIRECTIONS = {
  NEWER: "newer",
  OLDER: "older",
} as const;

// ============================================================================
// TEMPLATE VARIABLE TYPES - Input control types for template variables
// ============================================================================
export const TEMPLATE_VARIABLE_TYPES = {
  TEXT: "text",
  FILE: WORKSPACE_ENTRY_KINDS.FILE,
  DIRECTORY: WORKSPACE_ENTRY_KINDS.DIRECTORY,
  SELECT: "select",
  HARNESS: "harness",
} as const;

/** Tabs for the two input shapes in the shared MCP server form. */
export const MCP_FORM_TABS = {
  STDIO: "stdio",
  REMOTE: "remote",
} as const;

export type TemplateVariableType =
  (typeof TEMPLATE_VARIABLE_TYPES)[keyof typeof TEMPLATE_VARIABLE_TYPES];

// ============================================================================
// WORKSPACE VIEWER - Shared hosted viewer tab and search scope values
// ============================================================================
export const WORKSPACE_VIEWER_TABS = {
  EXPLORER: "explorer",
  SOURCE_CONTROL: "sourceControl",
  SEARCH: "search",
} as const;

export type WorkspaceViewerTab =
  (typeof WORKSPACE_VIEWER_TABS)[keyof typeof WORKSPACE_VIEWER_TABS];

export const WORKSPACE_SEARCH_SCOPES = {
  FILES: "files",
  CONTENT: "content",
  BOTH: "both",
} as const;

export type WorkspaceSearchScope =
  (typeof WORKSPACE_SEARCH_SCOPES)[keyof typeof WORKSPACE_SEARCH_SCOPES];

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
// UNDO/REDO DIRECTIONS - Direction discriminants for history actions
// ============================================================================
export const UNDO_REDO_DIRECTIONS = {
  UNDO: "undo",
  REDO: "redo",
} as const;

export type UndoRedoDirection =
  (typeof UNDO_REDO_DIRECTIONS)[keyof typeof UNDO_REDO_DIRECTIONS];

// ============================================================================
// TEMP FILE CATEGORIES - Category discriminants for categorized prompt temp files
// ============================================================================
export const TEMP_FILE_CATEGORIES = {
  AGENT: "agent",
  SECRETS: "secrets",
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

/** Workspace-relative path of the workspace-scope settings file, used by the
 * "Open settings file" action's hosted-browser transport. */
export const WORKSPACE_SETTINGS_RELATIVE_PATH = ".ctrlyoke/settings.json";
/**
 * Fixed sentinel the hosted-browser client sends to request the user-scope
 * settings.json (`~/.ctrlyoke/settings.json`). That file lives outside every
 * workspace root, so the client can never construct its real path itself —
 * the server recognizes this sentinel and resolves it via `configService`.
 * Never a real filesystem path.
 */
export const USER_SETTINGS_VIEWER_SENTINEL_PATH = "~/.ctrlyoke/settings.json";

/** States exposed by the secret registry. Values are never part of these states. */
export const SECRET_REGISTRY_STATES = {
  MANAGED_AND_SET: "managed-and-set",
  FROM_ENVIRONMENT_AND_DETECTED: "from-environment-and-detected",
  FROM_ENVIRONMENT_AND_NOT_FOUND: "from-environment-and-not-found",
} as const;

export type SecretRegistryState =
  (typeof SECRET_REGISTRY_STATES)[keyof typeof SECRET_REGISTRY_STATES];

/** Results acknowledged by write-only secret registry operations. */
export const SECRET_REGISTRY_ACTION_STATES = {
  SET: "set",
  DELETED: "deleted",
} as const;

export type SecretRegistryActionState =
  (typeof SECRET_REGISTRY_ACTION_STATES)[keyof typeof SECRET_REGISTRY_ACTION_STATES];

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
  EXECUTION_MODE: "executionMode",
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
// MCP SERVER IDS - Built-in server identifiers used in workflow properties
// ============================================================================
export const MCP_SERVER_IDS = {
  CTRLYOKE: "ctrlyoke",
} as const;

// Built-in skill identifiers. Keep these stable because workflows may refer
// to them by name before a future settings-driven registry exists.
export const MCP_SKILL_NAMES = {
  TOOLS: "ctrlyoke-mcp-tools",
  COMMIT_MESSAGE: "ctrlyoke-commit-message-tool",
} as const;

// ============================================================================
// EXTENSION IDENTIFIERS - Development and packaged extension identity values
// ============================================================================
export const EXTENSION_IDENTIFIERS = {
  ID: "fuzzynova.ctrlyoke",
  PACKAGE_NAME: "ctrlyoke",
} as const;

// Explicit ctrlyoke prompt references. Plain slash commands remain harness-native.
export const CTRLYOKE_SLASH_TOKEN_KINDS = {
  SKILL: ATOMIC_REFERENCE_KINDS.SKILL,
  MCP: ATOMIC_REFERENCE_KINDS.MCP,
} as const;

export type CtrlYokeSlashTokenKind =
  (typeof CTRLYOKE_SLASH_TOKEN_KINDS)[keyof typeof CTRLYOKE_SLASH_TOKEN_KINDS];

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
type HarnessMcpSourcePrefix<T extends string> = T extends `${infer Prefix}-cli`
  ? Prefix
  : never;
export type McpLocalSource =
  | `${typeof SPECIAL_TARGET_IDS.VSCODE}-${SettingWriteScope}`
  | `${HarnessMcpSourcePrefix<HarnessId>}-${SettingWriteScope}`;

/** Build the stable source key used for a local MCP discovery result. */
export function getMcpLocalSource(
  targetId: HarnessId | typeof SPECIAL_TARGET_IDS.VSCODE,
  scope: SettingWriteScope
): McpLocalSource {
  const sourcePrefix =
    targetId === SPECIAL_TARGET_IDS.VSCODE
      ? targetId
      : targetId.replace(/-cli$/, "");
  return `${sourcePrefix}-${scope}` as McpLocalSource;
}

export type ClaudeToolName =
  (typeof CLAUDE_TOOL_NAMES)[keyof typeof CLAUDE_TOOL_NAMES];
export type HarnessShareMetric =
  (typeof HARNESS_SHARE_METRICS)[keyof typeof HARNESS_SHARE_METRICS];
export type TokenTotalConfidence =
  (typeof TOKEN_TOTAL_CONFIDENCE)[keyof typeof TOKEN_TOTAL_CONFIDENCE];
export type WorkflowTokenCoverage =
  (typeof WORKFLOW_TOKEN_COVERAGE)[keyof typeof WORKFLOW_TOKEN_COVERAGE];
export type AttemptCostSource =
  (typeof ATTEMPT_COST_SOURCES)[keyof typeof ATTEMPT_COST_SOURCES];
export type RunOutcomeBucket =
  (typeof RUN_OUTCOME_BUCKETS)[keyof typeof RUN_OUTCOME_BUCKETS];
export type WorkspaceStatsBackfillState =
  (typeof WORKSPACE_STATS_BACKFILL_STATES)[keyof typeof WORKSPACE_STATS_BACKFILL_STATES];
export type AttemptCostConfidence =
  (typeof ATTEMPT_COST_CONFIDENCE)[keyof typeof ATTEMPT_COST_CONFIDENCE];
export type AttemptCostNoteCode =
  (typeof ATTEMPT_COST_NOTE_CODES)[keyof typeof ATTEMPT_COST_NOTE_CODES];
export type AttemptCostUnavailableReason =
  (typeof ATTEMPT_COST_UNAVAILABLE_REASONS)[keyof typeof ATTEMPT_COST_UNAVAILABLE_REASONS];
export type AttemptCostCacheRelationship =
  (typeof ATTEMPT_COST_CACHE_RELATIONSHIPS)[keyof typeof ATTEMPT_COST_CACHE_RELATIONSHIPS];
export type AttemptCostReasoningRelationship =
  (typeof ATTEMPT_COST_REASONING_RELATIONSHIPS)[keyof typeof ATTEMPT_COST_REASONING_RELATIONSHIPS];
export type HarnessQuotaSource =
  (typeof HARNESS_QUOTA_SOURCES)[keyof typeof HARNESS_QUOTA_SOURCES];
export type HarnessUsageWindowKind =
  (typeof HARNESS_USAGE_WINDOW_KINDS)[keyof typeof HARNESS_USAGE_WINDOW_KINDS];
export type HarnessObservedPeriod =
  (typeof HARNESS_OBSERVED_PERIODS)[keyof typeof HARNESS_OBSERVED_PERIODS];
export type HarnessUsageConfidence =
  (typeof HARNESS_USAGE_CONFIDENCE)[keyof typeof HARNESS_USAGE_CONFIDENCE];
export type HarnessUsageUnit =
  (typeof HARNESS_USAGE_UNITS)[keyof typeof HARNESS_USAGE_UNITS];
export type PreviewScope = (typeof PREVIEW_SCOPES)[keyof typeof PREVIEW_SCOPES];
export type PreviewMutationScope =
  (typeof PREVIEW_MUTATION_SCOPES)[keyof typeof PREVIEW_MUTATION_SCOPES];
export type PreviewStatus =
  (typeof PREVIEW_STATUSES)[keyof typeof PREVIEW_STATUSES];
export type PreviewStepType =
  (typeof PREVIEW_STEP_TYPES)[keyof typeof PREVIEW_STEP_TYPES];
export type PreviewPermissionAction =
  (typeof PREVIEW_PERMISSION_ACTIONS)[keyof typeof PREVIEW_PERMISSION_ACTIONS];
export type PreviewPermissionRuleStatus =
  (typeof PREVIEW_PERMISSION_RULE_STATUSES)[keyof typeof PREVIEW_PERMISSION_RULE_STATUSES];
export type PreviewPropertySource =
  (typeof PREVIEW_PROPERTY_SOURCES)[keyof typeof PREVIEW_PROPERTY_SOURCES];
export type PreviewPromptCategory =
  (typeof PREVIEW_PROMPT_CATEGORIES)[keyof typeof PREVIEW_PROMPT_CATEGORIES];
export type PreviewTruncationReason =
  (typeof PREVIEW_TRUNCATION_REASONS)[keyof typeof PREVIEW_TRUNCATION_REASONS];
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
export type CliOutputMetadataKey =
  (typeof CLI_OUTPUT_METADATA_KEYS)[keyof typeof CLI_OUTPUT_METADATA_KEYS];
export type HarnessStatusString =
  (typeof HARNESS_STATUS_STRINGS)[keyof typeof HARNESS_STATUS_STRINGS];
export type WebviewLogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];
export type RunnerId = (typeof RUNNER_IDS)[keyof typeof RUNNER_IDS];
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
    case SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP:
      return EXECUTION_PHASES.WORKTREE_SETUP;
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
  RESOLVE_OUTPUT_CAPTURE: "ctrlyoke.resolveOutputCapture",
  OPEN_SECRETS_SETTINGS: "ctrlyoke.openSecretsSettings",
  ENABLE_SERVER: "ctrlyoke.enableServer",
  DISABLE_SERVER: "ctrlyoke.disableServer",
  REGENERATE_SERVER_TOKEN: "ctrlyoke.regenerateServerToken",
  ACTIVATE_PRO: "ctrlyoke.activatePro",
  ACTIVATE_OFFLINE_PRO: "ctrlyoke.activateOfflinePro",
  DEACTIVATE_PRO: "ctrlyoke.deactivatePro",
  MANAGE_LICENSE: "ctrlyoke.manageLicense",
  SEARCH_HISTORY: "ctrlyoke.searchHistory",
  GENERATE_COMMIT_MESSAGE: "ctrlyoke.generateCommitMessage",
  CANCEL_COMMIT_MESSAGE_GENERATION: "ctrlyoke.cancelCommitMessageGeneration",
  REFRESH_HARNESS_USAGE: "ctrlyoke.refreshHarnessUsage",
  REFRESH_WORKSPACE_STATS: "ctrlyoke.refreshWorkspaceStats",
  OPEN_WORKTREE: "ctrlyoke.openWorktree",
  VIEW_WORKTREE_DIFF: "ctrlyoke.viewWorktreeDiff",
  MERGE_WORKTREE: "ctrlyoke.mergeWorktree",
  MANAGE_WORKTREES: "ctrlyoke.manageWorktrees",
  OPEN_WORKTREE_OWNER: "ctrlyoke.openWorktreeOwner",
  RELOAD_WINDOW: "workbench.action.reloadWindow",
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
  HAS_QUEUED_STEPS: "ctrlyoke.hasQueuedSteps",
} as const;
