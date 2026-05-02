---
applyTo: "src/types/**"
---

<purpose>
Core data structures and constants for FlightPath extension. TypeScript strict mode enforced. Eleven primary files:
- **FlightPathTypes.ts** - Core workflow and integration types
- **IDashboardSink.ts** - Interface decoupling WorkflowInstance from VS Code API
- **DashboardConstants.ts** - Shared constants (SINGLE SOURCE OF TRUTH for all string literals, enums, and UI values)
- **CliOutputTypes.ts** - Universal CLI output types for standardizing output across harnesses
- **WebviewMessageTypes.ts** - Consolidated message types for extension ↔ webview communication
- **OutputHistoryTypes.ts** - Per-run workflow output history, workspace snapshots, and undo types
- **WorkflowContextTypes.ts** - Workflow context passed to harness sendPrompt calls
- **FlightPathSettings.ts** - Structured global settings interface replacing per-key VS Code settings
- **WorkflowTimelineTypes.ts** - Event-sourced timeline storage for workflow run history (v2)
- **HostedWorkspaceViewerTypes.ts** - Types for the hosted workspace viewer (file tree, SCM, diffs)
- **IconColorDefaults.ts** - Generated default icon background/foreground colors for the hosted server
</purpose>

<flightPathTypes>
**File: FlightPathTypes.ts**

**`PriorContext` type:** `"all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious" | number[]` — controls injection of prior prompt outputs as XML context before the prompt text.

**`Harness` enum:** `CopilotCli` | `CopilotChat` | `ClaudeCli` | `CodexCli` | `OpenCodeCli` | `QwenCli` | `GeminiCli` — values: `"copilot-cli"` | `"copilot-chat"` | `"claude-cli"` | `"codex-cli"` | `"opencode-cli"` | `"qwen-cli"` | `"gemini-cli"`

**`McpServerConfig` interface:** `id` required. Two transport modes — stdio (`command`, `args?`, `env?`, `autoApprove?: boolean | string[]`) or remote (`url`, `transport?: "streamable-http" | "sse"`, `headers?`). Exactly one of `command`/`url` must be set.

**`HookEvent` type:** `"stop" | "sessionStart" | "preToolUse" | "postToolUse" | "userPromptSubmit"` — logical hook event names mapped to CLI-specific event names at inject time. Unsupported events for the active harness are silently skipped.

**`UserHookConfig` interface:** `event: HookEvent`, `command: string`, `timeoutSec?: number` — user-defined hook to run alongside FlightPath's built-in hooks.

**`ToolPermissionsOverride` interface:** `mode?: ToolPermissionMode`, `allowedTools?: string[]`, `deniedTools?: string[]` — per-workflow/prompt tool permission overrides. Uses Copilot CLI format; auto-converted for Claude/Qwen.

**`EndConditionCompareSource` type:** type alias for `CompareSource` (from `DashboardConstants`/`COMPARE_SOURCES`) — `"auto" | "stdout" | "stderr" | "exitCode"`.

**Re-export:** `ToolPermissionMode` from `IToolPermissionMapper` — `"dangerouslyAllowAll" | "allowAll" | "custom"`

**`ExecutionProperties` interface** — shared by `PromptFile`, `PromptStep`, `PromptRuntimeMetadata`. Three-tier precedence: prompt-level > workflow-level > global settings.

Fields: `harness?`, `model?`, `agent?: string | null` (null = explicitly disable), `skills?: string[] | null`, `resumeSession?`, `mcpServers?: (string | McpServerConfig)[] | null` (null = explicitly disable), `sessionId?: string | number`, `endCondition?: EndCondition | null` (null = explicitly disable), `preCondition?: PreCondition | null` (null = explicitly disable), `priorContext?: PriorContext`, `additionalArgs?: string | null`, `toolPermissions?: ToolPermissionsOverride | null` (null = passthrough to harness local config), `hooks?: UserHookConfig[] | null` (null or [] = explicitly no hooks)

**Script/step types:**

- `ScriptProperties` — `script`, `compareSource?: EndConditionCompareSource`, `returns?`, `timeout?` — shared base for EndCondition, PreCondition, and ScriptStep
- `EndCondition extends ScriptProperties` — `returns` (required), `maxRetries?`, `retryPrompt?`, `resumeSessionOnRetry?`, `onPass?: EndConditionAction`, `onFail?: EndConditionAction`
- `PreCondition extends ScriptProperties` — `onPass?: PreConditionAction`, `onFail?: PreConditionAction`
- `EndConditionAction` — `Exclude<ConditionAction, "skipPrompt">`: `"continue" | "retry" | "stopWorkflow"`
- `PreConditionAction` — `Exclude<ConditionAction, "retry">`: `"continue" | "skipPrompt" | "stopWorkflow"`
- `ScriptStepAction` — `Exclude<ConditionAction, "retry" | "skipPrompt">`: `"continue" | "stopWorkflow"`

**Core workflow step interfaces:**

- `PromptFile extends ExecutionProperties` — `prompt?`, `steps?: WorkflowStep[]`, `finalStep?: WorkflowStep`, `vars?: Record<string, string>` (workflow-level variable defaults for `{{varName}}` substitution; CLI `--var key=value` flags take precedence; substituted in prompt text, model, additionalArgs, hook commands, and endCondition script paths)
- `PromptStep extends ExecutionProperties` — `type?: "prompt"`, `name?`, `prompt`, `sessionId?`, `_runtime?: PromptRuntimeMetadata`
- `ScriptStep extends ScriptProperties` — `type: "script"`, `name?`, `onPass?: ScriptStepAction`, `onFail?: ScriptStepAction`, `_runtime?: PromptRuntimeMetadata`
- `WorkflowStep = PromptStep | ScriptStep` — discriminated union; use `isScriptStep()` type guard
- `WorkflowStepType` — `"prompt" | "script"` (derived from `STEP_TYPES`)
- `PromptRuntimeMetadata extends ExecutionProperties` — `startedAt`, `completedAt?`, `terminalStatus?: PromptTerminalStatus`, `retryCount?`, `responseText?` (for priorContext injection)
- `WorkingFile extends PromptFile` — `originalFile?`, `workflowName`, `startedAt`, `lastModifiedAt?`, `_runtime?: WorkingFileRuntime`
- `WorkingFileRuntime` — `currentIndex`, `executionState: ExecutionState`, `finalStep?: FinalStepRuntimeState`
- `FinalStepRuntimeState` — `phase: FinalStepPhase`, `loopCount`, `status?`, `startedAt?`, `completedAt?`, `responseTexts?: string[]`

**Runtime state machine types:**

- `WorkflowRuntimeState` — `status: ExecutionState`, `stopped`, `startTime?`, `pausedTime?`, `totalPausedDuration` — owned by `WorkflowStateMachine`
- `WorkflowRuntimeCommand` — `"startExecution" | "pause" | "resume" | "requestStop" | "confirmStopped" | "complete" | "fail" | "reopenForContinuation"`
- `WorkflowRuntimeTransition` — `command`, `previous: WorkflowRuntimeState`, `current: WorkflowRuntimeState`, `timestampMs`
- `WorkflowAttemptTarget` — `{ kind: "queue"; stepIndex } | { kind: "finalStep"; loopIndex }`
- `WorkflowAttemptState` — `target`, `attemptIndex`, `status: WorkflowAttemptStatus`, `startedAt`, `completedAt?`, `retryCount?`, `maxRetries?`, `failureReason?`
- `WorkflowAttemptCommand` — derived from `WORKFLOW_ATTEMPT_COMMANDS` (`beginAttempt | scheduleRetry | completeAttempt | failAttempt | cancelAttempt`)
- `WorkflowAttemptTransition` — `command`, `previous?`, `current: WorkflowAttemptState`, `timestampMs`

**Queue/result interfaces:**

- `QueueState extends WorkflowRuntimeState` — `currentIndex`, `steps: WorkflowStep[]`, `results`, `completedIndices: Set<string>`, `totalExecutionTime`, `queueExtensions`, `lastReloadTime?`, `workingFilePath?`, `workflowName?`
- `PromptResult` — `prompt`, `status: StepStatus`, `timestamp`, `endConditionResult?`, `error?`, `retryCount?`, `scriptOutput?`
- `DynamicQueueConfig` — `maxQueueSize`, `maxWorkflowExecutionTime`, `unlimitedMode`, `notifyOnExtension`
- `WorkflowSummary` — `id`, `workflowName`, `filePath`, `workingFilePath?`, `executionState`, `currentStep` (0-indexed), `totalSteps`, `startedAt?`, `completedAt?`, `managedBy?: RunnerId`
- `WorkflowRunnerLock` — `runner: RunnerId`, `pid`, `startedAt`, `lastHeartbeat`, `instanceId`, `workflowId`

**Utility:** `workflowDisplayStep(s)` — returns `currentStep + 1` for 1-based display labels.
</flightPathTypes>

<iDashboardSink>
**File: IDashboardSink.ts**

Minimal interface for posting state updates to the webview dashboard. `WorkflowInstance` depends on this interface (not the concrete `FlightPathWebviewProvider`) so it stays free of VS Code API imports.

`FlightPathWebviewProvider` satisfies this interface structurally — no `implements` declaration required.

**Message shapes are single-sourced in `PostMessageDashboardSink` (src/ui/PostMessageDashboardSink.ts).** Both `FlightPathWebviewProvider` and `FlightPathHostedServer` delegate all `IDashboardSink` calls to a `PostMessageDashboardSink` instance — never duplicate message payload construction. See `ui.instructions.md` for the step-by-step process for adding a new method.

**Most methods accept an optional `workflowId?` trailing parameter** for multi-workflow targeting in the dashboard.

**Key methods:**

- `updateFileSelected(fileName, steps, workflowName?, finalStep?, finalStepRuntime?, workflowId?)` — initial load
- `updateSessionRestored(fileName, steps, results, executionState, currentIndex, workflowName?, finalStep?, finalStepRuntime?, workflowId?)` — restore paused/stopped session
- `loadOutputHistoryForWorkflow?(workflowFilePath, workflowInstanceId?)` — optional; load output history on restore
- `updateExecutionStarted(workflowId, fileName, totalSteps, isContinuation?, preserveStepCount?, isInjectMode?)` — run begins
- `updateExecutionCompleted?(workflowId?)` — optional; run ended normally
- `updateProgress(current, total, workflowId?)` / `updateExecutionState(state, workflowId?)`
- `updateStepStatus(stepIndex, status, details?, workflowId?)` / `updateRetryAttempt(stepIndex, currentRetry, maxRetries, workflowId?)`
- `updateCliOutput(stepIndex, output, workflowId?)` / `updateCliStreamingChunk(stepIndex, chunk, workflowId?)` / `updateCliStreamingEvents(stepIndex, events, workflowId?)`
- `updateContextWindow(stepIndex, used, size, workflowId?)` — live context window usage update
- `updateStatusMessage(stepIndex, message, severity?, workflowId?)`
- `updateStepsExtended(steps, finalStep?, executionState?, workflowId?)` / `updatePromptDeleted(fileName, steps, finalStep?)`
- `updateFinalStep(finalStep, workflowId?)` / `updateFinalStepStatus(status, loopCount, phase, workflowId?)` / `updateFinalStepOutput(loopIndex, output, workflowId?)`
- `updateFinalStepStreamingChunk(loopIndex, chunk, workflowId?)` / `updateFinalStepStreamingEvents(loopIndex, events, workflowId?)`
- `updateWorkflowName(name, workflowId?)`
- `notifyRunHistoryUpdated(runCount, runTimestamps?, runStates?, workflowId?)` / `notifyWorkflowStateReset(steps, workflowId?)` / `notifyStartPositionSet(steps, currentIndex, workflowId?)` / `notifyPromptsReordered(steps, workflowId?)` / `notifyUndoRedoSynced()`
- `sendStepUndoDataUpdated(target, workspaceSnapshot?)` — push live snapshot metadata after a prompt completes
  </iDashboardSink>

<cliOutputTypes>
**File: CliOutputTypes.ts**

**Universal CLI output types** for standardizing output across all CLI harnesses (Copilot, Claude, Codex, OpenCode, Qwen, Gemini).

**Key types:**

- `UniversalCliOutput` — `events: CliEvent[]`, `metadata: OutputMetadata`
- `CliEvent` — `type: CliEventType`, `timestamp?`, `data: CliEventData`
- `CliEventData` union: `TextData | ToolCall | ThinkingBlock | ToolResultData | BashCommandData | FileReadData | FileWriteData | FileEditData | FileDeleteData | McpToolCallData | WebSearchData`
- `ToolCall` — `name`, `parameters`, `id?`, `result?: ToolResult`
- `ToolResult` — `success`, `output?`, `error?`
- `ThinkingBlock` — `text`, `timestamp?`, `label?`
- `OutputMetadata` — `sessionId?`, `model?`, `usage?: TokenUsage`, `cliVersion?`, `elapsed?`, `harness?`, `rawTextOutput?` (skip markdown render when true)
- `TokenUsage` — `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens?`, `cacheCreatedTokens?`, `reasoningOutputTokens?`, `contextWindowUsedTokens?`, `contextWindowSize?`
- `UnifiedDiffHunk` — `oldStart`, `oldLines`, `newStart`, `newLines`, `lines: string[]` (git diff format with +/-/space prefixes)
- `FileEditData` — supports both full-content (`oldContent`/`newContent`) and diff-based (`structuredPatch?: UnifiedDiffHunk[]`) edits
- `CliResult` — generic result for all CLI harnesses: `success`, `response`, `statistics`, `error?`, `exitCode?`, `sessionId?`, `codeChanges?`, `modelUsage?`
  </cliOutputTypes>

<webviewMessageTypes>
**File: WebviewMessageTypes.ts**

**Consolidated message types** for extension ↔ webview communication. Re-exports constants and types from `DashboardConstants` and `CliOutputTypes`.

**Core types defined here:**

- `CliOutput` — `prompt`, `response`, `structured?: StructuredOutput`, `elapsed`, `tokens?: TokenStats`, `isStreaming`, `cliCommand?`, `workingDirectory?`, `timestampMs?`, `attemptIndex?`, `rawTextOutput?`, `errorMessage?`
- `TokenStats` — `prompt`, `completion`, `cached?`, `cacheCreated?`, `contextWindowUsed?`, `contextWindowSize?`
- `StructuredOutput = UniversalCliOutput` (alias)
- `PromptItem` — webview-facing shape matching `FlightPathTypes.PromptItem` (includes all `ExecutionProperties` fields + `status?: StepStatus` + `_runtime?`)
- `StatusMessage` — `message`, `severity: StatusSeverity`, `timestamp: number`
- `OutputStatusMessage` — `message`, `severity: StatusSeverity`, `timestamp: string`, `timestampMs: number`
- `RetryState` — `currentRetry`, `maxRetries`
- `EndConditionConfig` — `script`, `returns?`, `timeout?`, `maxRetries?`, `retryPrompt?`
- `UndoFileAction` — `"delete" | "restore-content" | "reverse-patch"`
- `UndoCandidateTier` — `"tier1" | "tier2"` (event-attributed vs snapshot-only)

**Message payload interfaces** (selection of key types):
`InitMessageData` (globalSettings includes `hooks: UserHookConfig[]`), `FileSelectedMessage`, `SessionRestoredMessage`, `ExecutionStartedMessage` (with `workflowId`, `isContinuation?`/`preserveStepCount?`), `CliOutputMessage`, `CliStreamingEventsMessage`, `FinalStepStatusChangedMessage`, `FinalStepOutputMessage`, `FinalStepStreamingChunkMessage`, `FinalStepStreamingEventsMessage`, `AgentsUpdateMessage`, `SkillsUpdateMessage`, `GlobalSettingsUpdatedMessage` (globalSettings includes `hooks`, `harnessDefaultModels?`, `harnessDefaultAdditionalArgs?`, `skills?`, `respectGitignore?`, `confirmDeleteOperations?`, `confirmResetOperations?`), `WorkflowsListMessage`, `WorkflowAddedMessage`, `WorkflowDismissedMessage`, `WorkflowSummaryUpdatedMessage`, `SaveWorkflowDialogDataMessage`, `OutputHistoryLoadedMessage`, `StepUndoDataUpdatedMessage`, `UndoPromptChangesMessage`, `UndoPromptResultMessage`, `UndoRecordUpdatedMessage`, `RedoPromptChangesMessage`, `UndoWorkflowChangesMessage`, `RedoWorkflowChangesMessage`, `ReorderPromptsMessage`

**MCP Discovery types:**

- `LocalMcpServerEntry` — `id`, `command`, `args?`, `env?`, `source: "vscode-workspace" | "vscode-user" | "claude-workspace" | "claude-user"`
- `RegistryMcpEntry` — `id`, `name`, `description`, `packageName?`, `installCommand?`, `envVars?`, `verified?`, `claudeCodeCopyText?`, `popularityScore?`, `trendingScore?`
- MCP request/result messages: `RequestMcpLocalServersMessage`, `McpLocalServersResultMessage`, `RequestMcpRegistryMessage`, `McpRegistryResultMessage`, `RequestMcpWorkspaceServersMessage`, `McpWorkspaceServersResultMessage`, `SaveMcpWorkspaceServersMessage`

**Undo types (also re-exported from OutputHistoryTypes):**

- `UndoFileInstruction` — `path`, `action: "delete" | "restore-content" | "reverse-patch"`, `contentToRestore?`, `structuredPatch?`, `lineEnding?: 'crlf'`
- `UndoResult` — `restoredFiles`, `failedFiles`, `redoInstructions`
- `UndoFileCandidate` — `path`, `changeType`, `tier: "tier1" | "tier2"`, `instruction`, `contentCaptureSkipped?`, `afterHash?`, `oldContent?`, `newContent?`, `structuredPatch?`

**`IncomingMessage` union type** — exhaustive discriminated union of all extension→webview message types, used in webview message handler switch.
</webviewMessageTypes>

<outputHistoryTypes>
**File: OutputHistoryTypes.ts**

**Purpose:** Per-run workflow output history (`.flightpath/.history/<workflow-id>/run-N-<timestamp>.json`), workspace snapshots for undo, and undo/redo data structures.

**`WorkflowOutputHistory` interface:**

- `schemaVersion: "1.0.0" | "1.1.0"` — for migrations
- `workflowId`, `runId`, `startedAt`, `completedAt?`, `executionState: ExecutionState`
- `runStepCount` — preserves original step count for correct history rendering
- `promptOutputs: { [stepIndex: number]: StepOutput }` — queue step outputs
- `finalStepOutputs?: { [loopIndex: number]: StepOutput }` — finalStep loop outputs (schema 1.1.0+)
- `outputTimeline?: OutputTimelineEntry[]` — chronological `{ key, target: OutputExecutionTarget, firstOutputAt }` for mixed queue/finalStep rendering

**`StepOutput` interface:**

- `cliOutputs: CliOutput[]` — initial attempt + retries (full-fidelity: prompt, cliCommand, response, structured, tokens, elapsed)
- `statusMessages: StatusMessage[]`
- `workspaceSnapshot?: WorkspaceSnapshot` — files changed during this step
- `undoRecord?: UndoRecord` — set if undo was applied

**`WorkspaceSnapshot` interface** — `capturedAt`, `strategy: "git" | "filesystem"`, `changedFiles: SnapshotFileChange[]`

**`SnapshotFileChange` interface** — `path`, `changeType: "created" | "modified" | "deleted"`, `contentToRestore?`, `contentCaptureSkipped?`, `afterHash?` (SHA-256 for drift detection), `structuredPatch?: UnifiedDiffHunk[]`, `lineEnding?: 'crlf'`

**`UndoRecord` interface** — `appliedAt`, `restoredFiles`, `redoInstructions: UndoFileInstruction[]`, `isRedone?`, `redoneAt?`

**Discriminated union types:**

- `OutputExecutionTarget = { kind: "queue"; stepIndex } | { kind: "finalStep"; loopIndex }`
- `UndoExecutionTarget` — alias for `OutputExecutionTarget`
- `UndoDialogScope = { mode: "prompt"; target } | { mode: "singleFile"; target; attemptIndex; path }`
  </outputHistoryTypes>

<workflowContextTypes>
**File: WorkflowContextTypes.ts**

Workflow context passed to harness `sendPrompt` calls. Single source of truth — replaces all per-file inline type duplicates. Add fields here; no other file needs updating for new context properties.

**`WorkflowWorkingFilePersistence` interface:** `updateWorkingFile(skipMerge?: boolean): Promise<void>` — minimal working-file persistence hook exposed to harnesses.

**`WorkflowContext` interface:** `promptIndex`, `allPrompts: WorkflowStep[]`, `filePath?`, `workflowName?` (human-readable, for temp file naming), `instanceId?` (workflow UUID for PTY session keying), `workingFilePath?` (sets `FLIGHTPATH_WORKING_FILE` for MCP), `resolvedProperties?: ResolvedProperties`, `workflowFile?: PromptFile`, `workingFilePersistence?: WorkflowWorkingFilePersistence`, `getFinalStepResponseTexts?: () => string[]` (read-only accessor for prior-context finalStep loop responses), `finalStepSessionId?` (consumed by SessionResolver when sessionId is the "finalStep" sentinel)
</workflowContextTypes>

<dashboardConstants>
**File: DashboardConstants.ts - SINGLE SOURCE OF TRUTH**

ALL shared constants for extension ↔ webview. **NO HARDCODED STRINGS.**

**Constant objects:**

- `MESSAGE_TYPES` — 100+ extension↔webview message type strings (includes Terminal I/O, MCP Discovery, Workflow Undo/Redo)
- `EXECUTION_STATES` — `idle | running | paused | stopped | cancelling | completed | error`
- `STEP_STATUS` — `pending | sent | running | completed | failed | cancelled | skipped`
- `FINAL_STEP_PHASES` — `queue | finalStep`
- `ACTION_TYPES` — `run | queue | runNext | queueNext | runBeforeCurrent`
- `HARNESS_IDS` — `copilot-cli | copilot-chat | claude-cli | codex-cli | opencode-cli | qwen-cli | gemini-cli`
- `HARNESS_INFO` — display names per harness (name, shortName)
- `EXECUTION_MODES` — `interactive | headless`
- `MODEL_OPTION_VALUES` — `{ NONE: "none" }` (sentinel for "no model selected" in option lists)
- `DEFAULT_MODELS` — default model per harness (`copilot-cli: "claude-sonnet-4.6"`, `copilot-chat: "claude-sonnet-4.6"`, `claude-cli: "sonnet"`, `codex-cli: "gpt-5.4"`, `opencode-cli: "anthropic/claude-sonnet-4-6"`, `qwen-cli: "qwen3.5-plus"`, `gemini-cli: "gemini-2.5-pro"`)
- `CLAUDE_CLI_MODELS`, `CODEX_CLI_MODELS`, `QWEN_CLI_MODELS`, `GEMINI_CLI_MODELS` — static model option arrays
- `HARNESS_STATUS_STRINGS` — `checking | available | unavailable`
- `UI_STRINGS` — loading/checking text
- `QUEUE_POSITION` — `next | end | beforeCurrent`
- `EDITOR_TARGET_KINDS` — `newPrompt`
- `PROMPT_EDITOR_INSERT_MODES` — `insert | append`
- `EDITOR_PLACEHOLDER_TEXT` — `DEFAULT`, `FINAL_PROMPT` (placeholder hints for CodeMirrorEditor)
- `WORKFLOW_ATTEMPT_STATUS` — `running | retrying | completed | failed | cancelled`
- `PROMPT_TERMINAL_STATUS` — `completed | cancelled | failed` (subset of STEP_STATUS; absent = completed)
- `INTERACTIVE_ABORT_KINDS` — `user-cancelled | process-exited`
- `TERMINAL_SESSION_STATUS` — `running | completed | failed`
- `SESSION_KINDS` — `ai-cli | shell`
- `SHELL_KINDS` — `pwsh | powershell | bash` (specific shell variant for SHELL sessions)
- `TERMINAL_CURSOR_STYLES` — `block | underline | bar`
- `TERMINAL_MOBILE_CONTROL_BAR` — `auto | always | never`
- `SESSION_ID_SENTINELS` — `{ FINAL_STEP: "finalStep" }` (resume session from prior finalStep loop)
- `PRIOR_CONTEXT_KEYWORDS` — `all | previous | none | finalStepAll | finalStepPrevious`
- `PRIOR_CONTEXT_ITEM_TYPES` — `finalStep` (discriminant for PriorContextItem.type)
- `GIT_CHANGE_KINDS` — `commit | diff | staged | stash` (kind values for ~diff/~staged/~stash/~commit refs)
- `STEP_TYPES` — `prompt | script` (discriminant for WorkflowStep union)
- `CONDITION_ACTIONS` — `continue | stopWorkflow | retry | skipPrompt` (source for EndConditionAction/PreConditionAction/ScriptStepAction via `Exclude<>`)
- `COMPARE_SOURCES` — `auto | stdout | stderr | exitCode` (source for `EndConditionCompareSource` type alias)
- `RETRY_PROMPT_PLACEHOLDERS` — `stdout | stderr | expected | actual | exitCode | compareSource`
- `PROMPT_PROPERTIES` — property name constants: `PROMPT`, `ID`, `NAME`, `STEPS`, `FINAL_STEP`, `VARS`, `STEP_TYPE`, `SCRIPT`, `TIMEOUT`, `COMPARE_SOURCE`, `RETURNS`, `ON_PASS`, `ON_FAIL`, `HARNESS`, `MODEL`, `AGENT`, `SKILLS`, `RESUME_SESSION`, `SESSION_ID`, `MCP_SERVERS`, `HOOKS`, `END_CONDITION`, `PRE_CONDITION`, `PRIOR_CONTEXT`, `ADDITIONAL_ARGS`, `TOOL_PERMISSIONS`
- `END_CONDITION_PROPERTIES` — `SCRIPT`, `RETURNS`, `TIMEOUT`, `MAX_RETRIES`, `RETRY_PROMPT`, `RESUME_SESSION_ON_RETRY`
- `CLI_EVENT_TYPES` — `text | thinking | bashCommand | fileRead | fileWrite | fileEdit | fileDelete | mcpToolCall | webSearch | toolCall | toolResult`
- `OPERATION_STATUS` — `initiated | completed | failed`
- `STATUS_MESSAGE_SEVERITY` — `info | warning | error`
- `RUNNER_IDS` — `vscode | cli | server` (written into workflow lock files)
- `PERMISSION_MODES` — `dangerouslyAllowAll | allowAll | custom | none`
- `LOCK_STATUS` — `none | stale | active-vscode | active-cli`
- `LOG_LEVELS` — `debug | info | warn | error` (webview → extension LOG_MESSAGE payload)
- `ATTACHMENT_PREFIXES` — `file | symbol | directory | selection | git` (id namespace for `<attachment>` XML elements)
- `OUTPUT_HISTORY_KINDS` — `cli | status | runtime` (discriminant for OrderedHistoryEntry union)
- `SNAPSHOT_STRATEGIES` — `git | filesystem` (workspace snapshot strategy values)
- `SNAPSHOT_BASE_SOURCES` — `gitHead | capturedBefore` (what the snapshot was taken relative to)
- `UNDO_FILE_ACTIONS` — `delete | restore-content | reverse-patch` (file restoration action discriminants)
- `TEMP_FILE_CATEGORIES` — `agent | skills | context | excerpts | prompt` (category discriminants for prompt temp files)
- `WORKFLOW_ATTEMPT_COMMANDS` — `beginAttempt | scheduleRetry | completeAttempt | failAttempt | cancelAttempt`
- `COMPACTION_TRIGGERS` — `auto | manual`
- `CALLER_TYPES` — `direct | subagent`
- `NOTIFICATION_EVENT_MODES` — `all | failuresOnly | never`
- `BROWSER_NOTIFICATION_MODES` — `connectedOnly | push | never`
- `COMPLETION_NOTIFICATION_KINDS` — `workflow | prompt`
- `COMPLETION_NOTIFICATION_SEVERITY` — `info | warning | error`
- `SERVICE_WORKER_BADGE_MESSAGE_TYPES` — badge increment/clear messages for the hosted PWA service worker
- `HOSTED_ICON_FILES` / `HOSTED_ICON_PATHS` — file names and URL paths for hosted server icons (PNG, SVG, apple-touch-icon)
- `VSCODE_COMMANDS` — `flightpath.enableServer | flightpath.disableServer | flightpath.regenerateServerToken`
- `DEFAULT_WORKFLOW_NAME` — `"New Workflow"`
- `PANEL_CLIENT_ID` — `"panel"` (well-known VS Code sidebar client)
- `BROWSER_CLIENT_PREFIX` — `"browser:"` (prefix for all browser WebSocket client IDs)

**Type helpers:** `MessageType`, `ExecutionState`, `StepStatus`, `FinalStepPhase`, `HarnessId`, `StatusMessageSeverity`, `ActionType`, `QueuePosition`, `FileOperationStatus`, `CliEventType`, `HarnessStatusString`, `WebviewLogLevel`, `RunnerId`, `LockStatus`, `ExecutionMode`, `EditorTargetKind`, `PromptEditorInsertMode`, `TerminalSessionStatus`, `SessionKind`, `ShellKind`, `TerminalCursorStyle`, `TerminalMobileControlBar`, `WorkflowAttemptStatus`, `PromptTerminalStatus`, `InteractiveAbortKind`, `PermissionMode`, `StepType`, `PriorContextKeyword`, `PriorContextItemType`, `GitChangeKind`, `OutputHistoryKind`, `SnapshotStrategy`, `SnapshotBaseSource`, `UndoFileAction`, `TempFileCategory`, `ConditionAction`, `CompareSource`, `RetryPromptPlaceholder`, `WorkflowAttemptCommandValue`, `CompactionTrigger`, `CallerType`, `NotificationEventMode`, `BrowserNotificationMode`, `CompletionNotificationKind`, `CompletionNotificationSeverity`, `ServiceWorkerBadgeMessageType`
</dashboardConstants>

<flightPathSettings>
**File: FlightPathSettings.ts**

Structured global settings interface replacing per-key VS Code settings. Single source of truth for all extension configuration.

**`FlightPathGlobalSettings` interface** — grouped by concern:

- **Core:** `harness: HarnessId`, `models: Partial<Record<HarnessId, string>>`, `additionalArgs: Partial<Record<CliAdditionalArgsHarnessId, string>>` (excludes `copilot-chat`)
- **Execution:** `execution: { mode, injectMode: boolean, maxPromptTimeout, scriptTimeout, closeTerminalOnComplete, autoDeleteTempFiles: boolean }`
- **Tools:** `tools: { permissionMode, allowed, denied, allowedDirs: string[] (shared across copilot-cli/claude-cli/codex-cli/qwen-cli), copilotAllowAllPaths, codexSandboxMode, codexApprovalPolicy }`
- **Workflow:** `workflow: { defaultFormat, defaultTemplate, defaultAgent, defaultSkills, resumeExistingSession, priorContext, autoLoadRecentSession, omitAgentsSkillsOnResume, defaultEndCondition?: EndCondition | null, defaultPreCondition?: PreCondition | null }`
- **Chat:** `chat: { windowLocation, inactivityTimeout, treatTimeoutAsSuccess, forceAgentMode, useNativeAttachments }`
- **MCP & Hooks:** `mcp: { defaultServers }`, `hooks: UserHookConfig[]`
- **Queue:** `queue: { maxSize, maxWorkflowExecutionTime, unlimitedMode, notifyOnExtension }`
- **History:** `history: { saveOutput, maxRuns }`
- **Terminal:** `terminal: TerminalSettings` — `{ fontSize, lineHeight, scrollback, cursorStyle: TerminalCursorStyle, cursorBlink, macOptionIsMeta, wordSeparators, replayBufferKb, shellExecutable, mobileControlBar: TerminalMobileControlBar, mobileCustomShortcuts: TerminalShortcut[] }`
- **UI:** `ui: { showCliOutput, showCliCommand, logRawCliOutput, showHeadlessPermissionWarning, autoFocusOutputOnExecution, openPromptsInSecondGroup, respectGitignoreForCompletions, confirmDeleteOperations, confirmResetOperations, showHiddenFiles }`
- **Server:** `server: { enabled, port, standalonePort, theme, bindAddress: string, tls: { enabled, certPath, keyPath }, iconBgColor, iconFgColor }`
- **Notifications:** `notifications: FlightPathNotificationSettings` — `{ vscode: { enabled }, browser: { mode: BrowserNotificationMode }, events: { workflowComplete: NotificationEventMode, promptComplete: NotificationEventMode }, includeWorkflowName, includePromptName, onlyWhenWindowUnfocused }`
- **Advanced:** `enableDiagnosticLogs: boolean`

**Supporting interfaces:**
- `TerminalShortcut` — `{ label: string, sequence: string }`
- `FlightPathNotificationSettings` — see `notifications` above

**`PartialFlightPathSettings`** — shallow-partial version for config file contents (each top-level group is `Partial<...>`).

**`FLIGHTPATH_SETTINGS_DEFAULTS`** — `FlightPathGlobalSettings` constant with all default values. Reference this when merging user config or resetting settings.
</flightPathSettings>

<workflowTimelineTypes>
**File: WorkflowTimelineTypes.ts**

Event-sourced timeline storage for workflow run history (v2 format, supersedes v1 `OutputHistoryTypes`). Stores events as an append-only JSONL file alongside a manifest.

**Storage constants:**

- `TIMELINE_STORAGE_FILES` — `{ MANIFEST: "manifest.json", EVENTS: "events.jsonl" }`
- `TIMELINE_STORAGE_KIND` — `"timeline"` (manifest discriminant)
- `TIMELINE_SCHEMA_VERSION` — `"2.0.0"`
- `TIMELINE_EVENT_TYPES` — `workflowRuntimeTransitionRecorded | cliOutputRecorded | statusMessageRecorded | workspaceSnapshotCaptured | undoApplied | redoApplied` (plus legacy read-compat events: `statusMessagesUpdated | workspaceSnapshotUpdated | undoRecordUpdated`)

**`WorkflowRunManifest` interface:** `schemaVersion`, `storageKind`, `workflowId`, `runId`, `startedAt`, `completedAt?`, `executionState`, `runStepCount`, `eventCount`, `nextSequence`, `lastUpdatedAt`

**`WorkflowRuntimeTransitionPayload` interface:** `command: WorkflowRuntimeCommand`, `previous: WorkflowRuntimeState`, `current: WorkflowRuntimeState`

**Event draft interfaces** (pre-write, no `workflowId/runId/sequence`): `WorkflowRuntimeTransitionRecordedEventDraft`, `CliOutputRecordedEventDraft` (with `attemptIndex`), `StatusMessageRecordedEventDraft`, `WorkspaceSnapshotCapturedEventDraft`, `UndoAppliedEventDraft`, `RedoAppliedEventDraft` — plus legacy drafts retained for read-compat.

**Persisted event interfaces** (with `workflowId`, `runId`, `sequence`): same names without `Draft` suffix.

**Discriminated union types:**

- `WorkflowTimelineEventType` — string union derived from `TIMELINE_EVENT_TYPES`
- `WorkflowTimelineEventDraft` — union of all draft event interfaces
- `WorkflowTimelineEvent` — union of all persisted event interfaces

**Targeting:** Targeted events (`CliOutputRecordedEvent`, `StatusMessageRecordedEvent`, workspace/undo events) include `target: OutputExecutionTarget` from `OutputHistoryTypes`; runtime transition events are run-level (no target).
</workflowTimelineTypes>

<hostedWorkspaceViewerTypes>
**File: HostedWorkspaceViewerTypes.ts**

Types shared between the Express server (extension-side) and the React webview (browser-side) for the hosted workspace viewer feature.

**Key interfaces:**
- `WorkspaceEntry` / `WorkspaceTreeEntry` (alias) — `name`, `path`, `kind: "file" | "directory"`, `size?`
- `WorkspaceTreeResponse` — `rootLabel`, `path`, `parentPath`, `entries: WorkspaceTreeEntry[]`
- `WorkspaceFileResponse` — `path`, `name`, `language?`, `size`, `eol: "lf" | "crlf"`, `content`, `readOnly?`, `reason?`
- `WorkspaceFileSaveRequest` — `path`, `content`
- `SourceControlFile` / `WorkspaceScmFile` (alias) — `path`, `stagedStatus`, `unstagedStatus`, `kind: "modified" | "added" | "deleted" | "renamed" | "untracked"`
- `WorkspaceScmStatusResponse` — `files`, `incomingCommitCount`, `outgoingCommitCount`
- `DiffKind` — `"modified" | "added" | "deleted" | "renamed" | "untracked"`
- `WorkspaceScmDiffResponse` — `path`, `language?`, `oldContent`, `newContent`, `kind: DiffKind`
- Stage/unstage/discard/commit/push/pull request and response types: `WorkspaceStageRequest`, `WorkspaceUnstageRequest`, `WorkspaceDiscardRequest`, `WorkspaceCommitRequest`, `WorkspacePushResponse`, `WorkspacePullResponse`
</hostedWorkspaceViewerTypes>

<iconColorDefaults>
**File: IconColorDefaults.ts**

Auto-generated by `scripts/generate-app-icons.mjs`. Do not edit manually.

Exports two constants used as defaults in `FlightPathGlobalSettings.server`:
- `ICON_BG_COLOR_DEFAULT` — default background color for SVG favicon and PWA icons
- `ICON_FG_COLOR_DEFAULT` — default foreground color for SVG favicon and PWA icons
</iconColorDefaults>

<typeSafetyPatterns>
**Import constants from DashboardConstants (NEVER hardcode strings):**

```typescript
import { EXECUTION_STATES, STEP_STATUS, MESSAGE_TYPES, HARNESS_IDS } from "../types/DashboardConstants";

if (state.status === EXECUTION_STATES.RUNNING) { ... }
result.status = STEP_STATUS.COMPLETED;
const harness = prompt.harness || HARNESS_IDS.COPILOT_CLI;
this.postMessage({ type: MESSAGE_TYPES.PROGRESS_UPDATE, data: { ... } });
```

**Use type helpers for function signatures:**

```typescript
import { ExecutionState, StepStatus, HarnessId, FinalStepPhase } from "../types/DashboardConstants";

function updateState(status: ExecutionState) { ... }
function getStepResult(status: StepStatus) { ... }
function getHarness(harness: HarnessId) { ... }
function setPhase(phase: FinalStepPhase) { ... }
```

**ExecutionProperties with three-tier precedence:**

```typescript
const harness =
  prompt.harness || workflow.harness || ConfigurationUtils.getHarness();
const model = prompt.model || workflow.model || ConfigurationUtils.getModel();
const agent = prompt.agent ?? workflow.agent ?? undefined; // null = explicitly disabled
const skills = prompt.skills ?? workflow.skills ?? undefined; // null = explicitly disabled
const additionalArgs =
  prompt.additionalArgs ?? workflow.additionalArgs ?? undefined; // null = explicitly disabled
const hooks = prompt.hooks ?? workflow.hooks ?? undefined; // null or [] = explicitly no hooks
const toolPermissions =
  prompt.toolPermissions ?? workflow.toolPermissions ?? undefined; // null = passthrough to harness config
const resumeSession =
  prompt.resumeSession ??
  workflow.resumeSession ??
  ConfigurationUtils.getResumeSession();
```

**Null-disableable field semantics (`agent`, `skills`, `additionalArgs`, `hooks`, `toolPermissions`, `mcpServers`, `endCondition`, `preCondition`):** `null` explicitly disables the inherited value; `undefined` inherits from the next tier. Always use `??` (not `||`) when checking these fields.
</typeSafetyPatterns>

<relatedFiles>
**Core workflow:**
- `../flightpath/PromptFileParser.ts` - Validates against PromptFile structure
- `../flightpath/PromptQueue.ts` - Uses QueueState and PromptResult
- `../flightpath/orchestration/PromptSessionResolver.ts` - Session ID resolution
- `../utils/PromptIdentity.ts` - Hash-based prompt identity for deduplication
- `../utils/PropertyResolver.ts` - Three-tier property resolution (ResolvedProperties used by WorkflowContext)
- `/schemas/prompt-schema.json` - JSON Schema mirrors TypeScript types

**Integrations:**

- `../flightpath/harness/CliIntegration.ts` - Uses CliResult, WorkflowContext
- `../flightpath/harness/chat/CopilotChatIntegration.ts` - Chat harness implementation

**UI:**

- `../ui/FlightPathWebviewProvider.ts` - Satisfies IDashboardSink; uses MESSAGE_TYPES for webview communication
- `../ui/webview-react/` - React webview uses types from WebviewMessageTypes

**Documentation:**

- `dev/implemented/SESSION_MANAGEMENT.md` - Session resumption and working file system
- `dev/implemented/WORKFLOW_PROPERTIES.md` - ExecutionProperties and three-tier precedence
  </relatedFiles>

<criticalRules>
1. **NO HARDCODED STRINGS** - All shared string literals MUST be defined in DashboardConstants.ts
2. **Single Source of Truth** - Each constant has exactly ONE definition location
3. **Type Safety** - Use ExecutionState, StepStatus, MessageType, HarnessId, FinalStepPhase, etc. instead of raw strings
4. **Import Consistency** - Always import from DashboardConstants for shared values
5. **Harness terminology** - Use "harness" (not "provider") for AI framework/tool selection
6. **Null semantics for agent/skills/additionalArgs/hooks/toolPermissions/mcpServers/endCondition/preCondition** - `null` = explicitly disable, `undefined` = inherit; use `??` not `||`
7. **When adding new constants:**
   - Add to appropriate constant object in DashboardConstants.ts
   - Export as const with `as const` assertion
   - Add type helper if needed (e.g., `type NewType = typeof NEW_CONST[keyof typeof NEW_CONST]`)
   - Update this instruction file if adding new constant category
</criticalRules>
