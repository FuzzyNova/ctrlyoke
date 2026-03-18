---
applyTo: "src/types/**"
---

<purpose>
Core data structures and constants for FlightPath extension. TypeScript strict mode enforced. Six primary files:
- **FlightPathTypes.ts** - Core workflow and integration types
- **IDashboardSink.ts** - Interface decoupling WorkflowInstance from VS Code API
- **DashboardConstants.ts** - Shared constants (SINGLE SOURCE OF TRUTH for all string literals, enums, and UI values)
- **CliOutputTypes.ts** - Universal CLI output types for standardizing output across harnesses
- **WebviewMessageTypes.ts** - Consolidated message types for extension ↔ webview communication
- **OutputHistoryTypes.ts** - Per-run workflow output history, workspace snapshots, and undo types
</purpose>

<flightPathTypes>
**File: FlightPathTypes.ts**

**`PriorContext` type:** `"all" | "previous" | "none" | "finalPromptAll" | "finalPromptPrevious" | number[]` — controls injection of prior prompt outputs as XML context before the prompt text.

**`Harness` enum:** `CopilotCli` | `CopilotChat` | `ClaudeCli` | `CodexCli` | `OpenCodeCli` — values: `"copilot-cli"` | `"copilot-chat"` | `"claude-cli"` | `"codex-cli"` | `"opencode-cli"`

**`ExecutionProperties` interface** — shared by `PromptFile`, `PromptItem`, `PromptRuntimeMetadata`. Three-tier precedence: prompt-level > workflow-level > global settings.

Fields: `harness?`, `model?`, `agent?: string | null` (null = explicitly disable), `skills?: string[] | null`, `resumeSession?`, `allowDynamicExtension?`, `sessionId?: string | number`, `endCondition?: EndCondition | null` (null = explicitly disable), `priorContext?: PriorContext`, `additionalArgs?: string | null`

**Core interfaces:**

- `PromptFile extends ExecutionProperties` — `prompt?`, `prompts?: PromptItem[]`, `finalPrompt?: PromptItem`
- `PromptItem extends ExecutionProperties` — `name?`, `prompt`, `sessionId?`, `_runtime?: PromptRuntimeMetadata`
- `PromptRuntimeMetadata extends ExecutionProperties` — `startedAt`, `completedAt?`, `retryCount?`, `responseText?` (for priorContext injection)
- `WorkingFile extends PromptFile` — `originalFile?`, `workflowName`, `startedAt`, `lastModifiedAt?`, `_runtime?: WorkingFileRuntime`
- `WorkingFileRuntime` — `currentIndex`, `executionState: ExecutionState`, `finalPrompt?: FinalPromptRuntimeState`
- `FinalPromptRuntimeState` — `phase: FinalPromptPhase`, `loopCount`, `status?`, `startedAt?`, `completedAt?`, `responseTexts?: string[]`
- `QueueState` — `currentIndex`, `status: ExecutionState`, `prompts`, `results`, `stopped`, `completedIndices: Set<string>`, `totalExecutionTime`, `queueExtensions`, `lastReloadTime?`, `startTime?`, `pausedTime?`, `totalPausedDuration`, `workingFilePath?`, `workflowName?`
- `PromptResult` — `prompt`, `status: StepStatus`, `timestamp`, `endConditionResult?`, `error?`, `retryCount?`, `scriptOutput?`
- `EndCondition` — `script`, `returns`, `timeout?`, `maxRetries?`, `retryPrompt?`, `resumeSessionOnRetry?`
- `DynamicQueueConfig` — `enabled`, `maxQueueSize`, `maxWorkflowExecutionTime`, `unlimitedMode`, `notifyOnExtension`
- `WorkflowContext` — `promptIndex`, `allPrompts`, `filePath?`, `workflowFile?`, `promptQueue?`
- `WorkflowSummary` — `id`, `workflowName`, `filePath`, `workingFilePath?`, `executionState`, `currentStep` (0-indexed), `totalSteps`, `startedAt?`, `completedAt?`, `managedBy?: "vscode" | "cli"`
- `WorkflowRunnerLock` — `runner: RunnerId`, `pid`, `startedAt`, `lastHeartbeat`, `instanceId`, `workflowId`

**Utility:** `workflowDisplayStep(s)` — returns `currentStep + 1` for 1-based display labels.
</flightPathTypes>

<iDashboardSink>
**File: IDashboardSink.ts**

Minimal interface for posting state updates to the webview dashboard. `WorkflowInstance` depends on this interface (not the concrete `FlightPathWebviewProvider`) so it stays free of VS Code API imports.

`FlightPathWebviewProvider` satisfies this interface structurally — no `implements` declaration required.

**Key methods:**
- `updateFileSelected(fileName, prompts, workflowName?, finalPrompt?, finalPromptRuntime?)` — initial load
- `updateSessionRestored(fileName, prompts, results, executionState, currentIndex, ...)` — restore paused/stopped session
- `updateExecutionStarted(fileName, totalSteps, isContinuation?, preserveStepCount?)` — run begins
- `updateProgress(current, total)` / `updateExecutionState(state)`
- `updateStepStatus(stepIndex, status, details?)` / `updateRetryAttempt(stepIndex, currentRetry, maxRetries)`
- `updateCliOutput(stepIndex, output)` / `updateCliStreamingChunk(stepIndex, chunk)` / `updateCliStreamingEvents(stepIndex, events)`
- `updatePromptsExtended(prompts, finalPrompt?, executionState?)` / `updatePromptDeleted(...)`
- `updateFinalPrompt(finalPrompt)` / `updateFinalPromptStatus(status, loopCount, phase)` / `updateFinalPromptOutput(loopIndex, output)`
- `notifyRunHistoryUpdated(runCount, runTimestamps?, runStates?)` / `notifyWorkflowStateReset(prompts)` / `notifyStartPositionSet(prompts, currentIndex)` / `notifyPromptsReordered(prompts)` / `notifyUndoRedoSynced()`
</iDashboardSink>

<cliOutputTypes>
**File: CliOutputTypes.ts**

**Universal CLI output types** for standardizing output across all CLI harnesses (Copilot, Claude, Codex, OpenCode).

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

- `CliOutput` — `prompt`, `response`, `structured?: StructuredOutput`, `elapsed`, `tokens?: TokenStats`, `isStreaming`, `cliCommand?`, `workingDirectory?`, `timestampMs?`, `attemptIndex?`, `rawTextOutput?`
- `TokenStats` — `prompt`, `completion`, `cached?`, `cacheCreated?`, `contextWindowUsed?`, `contextWindowSize?`
- `StructuredOutput = UniversalCliOutput` (alias)
- `PromptItem` — webview-facing shape matching `FlightPathTypes.PromptItem` (includes all `ExecutionProperties` fields + `status?: StepStatus` + `_runtime?`)
- `StatusMessage` — `message`, `severity: StatusSeverity`, `timestamp: number`
- `RetryState` — `currentRetry`, `maxRetries`
- `EndConditionConfig` — `script`, `returns?`, `timeout?`, `maxRetries?`, `retryPrompt?`

**Message payload interfaces** (selection of key types):
`InitMessageData`, `FileSelectedMessage`, `SessionRestoredMessage`, `ExecutionStartedMessage` (with `isContinuation?`/`preserveStepCount?`), `CliOutputMessage`, `CliStreamingEventsMessage`, `FinalPromptStatusChangedMessage`, `FinalPromptOutputMessage`, `AgentsUpdateMessage`, `SkillsUpdateMessage`, `GlobalSettingsUpdatedMessage`, `WorkflowsListMessage`, `WorkflowAddedMessage`, `WorkflowDismissedMessage`, `WorkflowSummaryUpdatedMessage`, `SaveWorkflowDialogDataMessage`, `OutputHistoryLoadedMessage`, `StepUndoDataUpdatedMessage`, `UndoPromptChangesMessage`, `UndoPromptResultMessage`, `UndoRecordUpdatedMessage`, `RedoPromptChangesMessage`

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
- `finalPromptOutputs?: { [loopIndex: number]: StepOutput }` — finalPrompt loop outputs (schema 1.1.0+)
- `outputTimeline?: OutputTimelineEntry[]` — chronological `{ key, target: OutputExecutionTarget, firstOutputAt }` for mixed queue/finalPrompt rendering

**`StepOutput` interface:**

- `cliOutputs: CliOutput[]` — initial attempt + retries (full-fidelity: prompt, cliCommand, response, structured, tokens, elapsed)
- `statusMessages: StatusMessage[]`
- `workspaceSnapshot?: WorkspaceSnapshot` — files changed during this step
- `undoRecord?: UndoRecord` — set if undo was applied

**`WorkspaceSnapshot` interface** — `capturedAt`, `strategy: "git" | "filesystem"`, `changedFiles: SnapshotFileChange[]`

**`SnapshotFileChange` interface** — `path`, `changeType: "created" | "modified" | "deleted"`, `contentToRestore?`, `contentCaptureSkipped?`, `afterHash?` (SHA-256 for drift detection), `structuredPatch?: UnifiedDiffHunk[]`, `lineEnding?: 'crlf'`

**`UndoRecord` interface** — `appliedAt`, `restoredFiles`, `redoInstructions: UndoFileInstruction[]`, `isRedone?`, `redoneAt?`

**Discriminated union types:**

- `OutputExecutionTarget = { kind: "queue"; stepIndex } | { kind: "finalPrompt"; loopIndex }`
- `UndoExecutionTarget` — alias for `OutputExecutionTarget`
- `UndoDialogScope = { mode: "prompt"; target } | { mode: "singleFile"; target; attemptIndex; path }`
</outputHistoryTypes>

<dashboardConstants>
**File: DashboardConstants.ts - SINGLE SOURCE OF TRUTH**

ALL shared constants for extension ↔ webview. **NO HARDCODED STRINGS.**

**Constant objects:**

- `MESSAGE_TYPES` — 100+ extension↔webview message type strings
- `EXECUTION_STATES` — `idle | running | paused | stopped | cancelling | completed | error`
- `STEP_STATUS` — `pending | sent | running | completed | failed | cancelled | skipped`
- `FINAL_PROMPT_PHASES` — `queue | finalPrompt`
- `ACTION_TYPES` — `run | queue | runNext | queueNext | runBeforeCurrent`
- `HARNESS_IDS` — `copilot-cli | copilot-chat | claude-cli | codex-cli | opencode-cli`
- `HARNESS_INFO` — display names per harness (name, shortName)
- `EXECUTION_MODES` — `interactive | headless`
- `DEFAULT_MODELS` — default model per harness
- `CLAUDE_CLI_MODELS`, `CODEX_CLI_MODELS` — static model option arrays
- `HARNESS_STATUS_STRINGS` — `checking | available | unavailable`
- `UI_STRINGS` — loading/checking text
- `QUEUE_POSITION` — `next | end | beforeCurrent`
- `SESSION_ID_SENTINELS` — `{ FINAL_PROMPT: "finalPrompt" }` (resume session from prior finalPrompt loop)
- `PROMPT_PROPERTIES`, `END_CONDITION_PROPERTIES` — property name constants
- `CLI_EVENT_TYPES` — `text | thinking | bashCommand | fileRead | fileWrite | fileEdit | fileDelete | mcpToolCall | webSearch | toolCall | toolResult`
- `OPERATION_STATUS` — `initiated | completed | failed`
- `STATUS_MESSAGE_SEVERITY` — `info | warning | error`
- `RUNNER_IDS` — `vscode | cli` (written into workflow lock files)
- `LOCK_STATUS` — `none | stale | active-vscode | active-cli`
- `LOG_LEVELS` — `debug | info | warn | error` (webview → extension LOG_MESSAGE payload)

**Type helpers:** `MessageType`, `ExecutionState`, `StepStatus`, `FinalPromptPhase`, `HarnessId`, `StatusMessageSeverity`, `ActionType`, `QueuePosition`, `FileOperationStatus`, `CliEventType`, `HarnessStatusString`, `WebviewLogLevel`, `RunnerId`, `LockStatus`
</dashboardConstants>

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
import { ExecutionState, StepStatus, HarnessId, FinalPromptPhase } from "../types/DashboardConstants";

function updateState(status: ExecutionState) { ... }
function getStepResult(status: StepStatus) { ... }
function getHarness(harness: HarnessId) { ... }
function setPhase(phase: FinalPromptPhase) { ... }
```

**ExecutionProperties with three-tier precedence:**

```typescript
const harness = prompt.harness || workflow.harness || ConfigurationUtils.getHarness();
const model = prompt.model || workflow.model || ConfigurationUtils.getModel();
const agent = prompt.agent ?? workflow.agent ?? undefined; // null = explicitly disabled
const skills = prompt.skills ?? workflow.skills ?? undefined; // null = explicitly disabled
const additionalArgs = prompt.additionalArgs ?? workflow.additionalArgs ?? undefined; // null = explicitly disabled
const resumeSession = prompt.resumeSession ?? workflow.resumeSession ?? ConfigurationUtils.getResumeSession();
```

**`agent`, `skills`, `additionalArgs` null semantics:** `null` explicitly disables the inherited value; `undefined` inherits from the next tier. Always use `??` (not `||`) when checking these fields.
</typeSafetyPatterns>

<relatedFiles>
**Core workflow:**
- `../flightpath/PromptFileParser.ts` - Validates against PromptFile structure
- `../flightpath/PromptQueue.ts` - Uses QueueState and PromptResult
- `../flightpath/orchestration/PromptSessionResolver.ts` - Session ID resolution
- `../utils/PromptIdentity.ts` - Hash-based prompt identity for deduplication
- `/schemas/prompt-schema.json` - JSON Schema mirrors TypeScript types

**Integrations:**

- `../flightpath/harness/CliIntegration.ts` - Uses CliResult, WorkflowContext
- `../flightpath/harness/chat/CopilotChatIntegration.ts` - Chat harness implementation

**UI:**

- `../ui/FlightPathWebviewProvider.ts` - Satisfies IDashboardSink; uses MESSAGE_TYPES for webview communication
- `../ui/webview-react/` - React webview uses types from WebviewMessageTypes

**Documentation:**

- `docs/SESSION_MANAGEMENT.md` - Session resumption and working file system
- `docs/WORKFLOW_PROPERTIES.md` - ExecutionProperties and three-tier precedence
  </relatedFiles>

<criticalRules>
1. **NO HARDCODED STRINGS** - All shared string literals MUST be defined in DashboardConstants.ts
2. **Single Source of Truth** - Each constant has exactly ONE definition location
3. **Type Safety** - Use ExecutionState, StepStatus, MessageType, HarnessId, FinalPromptPhase, etc. instead of raw strings
4. **Import Consistency** - Always import from DashboardConstants for shared values
5. **Harness terminology** - Use "harness" (not "provider") for AI framework/tool selection
6. **Null semantics for agent/skills/additionalArgs** - `null` = explicitly disable, `undefined` = inherit; use `??` not `||`
7. **When adding new constants:**
   - Add to appropriate constant object in DashboardConstants.ts
   - Export as const with `as const` assertion
   - Add type helper if needed (e.g., `type NewType = typeof NEW_CONST[keyof typeof NEW_CONST]`)
   - Update this instruction file if adding new constant category
</criticalRules>
