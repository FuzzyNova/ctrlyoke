---
applyTo: "src/flightpath/*.ts"
---

<purpose>
Orchestration, parsing, queue, state machine, validation, and template management. Top-level `src/flightpath/` files only (excludes `orchestration/` subdirectory and harness implementations).
</purpose>

<harnessIntegration>
**`HarnessIntegration.ts`** is the abstract base class for all harness integrations.
**HarnessStatus enum:** `Initializing | Waiting | Ready | Unavailable` — used for status bar and UI feedback
**Event emitters:** `onDidChangeStatus`, `onResponseComplete`, `onStreamingChunk` (plain text, Copilot CLI compat), `onStreamingEvents` (structured, Claude/Codex), `onPromptReady`, `onContextWindowUpdate` (live context window used/size during streaming)
**`rawTextOutput` getter:** Override in subclasses to signal pre-formatted text output (skips Streamdown pipeline)
**Inject mode methods:** `canReuseForInject()` — returns true when an underlying PTY session is still alive and the integration can be reused across runs; `resetForNewRun()` — clears per-run mutable state before handing a live integration to a new execution; `onPtySessionEnded(callback)` — registers a one-shot callback for when the PTY exits (no-op for non-PTY harnesses, overridden by `CliIntegration`)
**Two integration lifecycles:**
  - *Detector singletons* — created once at startup, registered with `context.subscriptions`, disposed by VS Code
  - *Execution integrations* — created per-run via `IntegrationFactory.createForExecution()`, skip context registration, disposed manually in the `finally` block after each workflow run
**SkillExpander support:** Expands skill references in prompts before execution
**AgentExpander / ContextExpander / TempFileManager / PromptFileSplitter:** Shared utilities for prompt construction
**`PropertyResolver.ResolvedProperties`:** Harness/model/agent/session resolution used during execution
</harnessIntegration>

<integrationFactory>
**`IntegrationFactory.ts`** — platform-agnostic factory for CLI harness integrations only.
- `createCopilotCli()`, `createClaudeCli()`, `createCodexCli()`, `createOpenCodeCli()`, `createQwenCli()`, `createGeminiCli()` — each wraps the matching provider in a `CliIntegration`
- `createForHarness(harness)` — switch-dispatches to the correct CLI factory method
- `createForExecution(harness)` — creates an isolated per-run integration (`registerWithContext=false`, calls `markAsReady()`)

**`VsCodeIntegrationFactory.ts`** — extends `IntegrationFactory` with VS Code-only support.

- Adds `createCopilotChat()` (requires `vscode.ExtensionContext`)
- Overrides `createForHarness()` and `createForExecution()` to handle `Harness.CopilotChat`
- `WorkflowOrchestrator` always uses `VsCodeIntegrationFactory`; CLI-only code uses base `IntegrationFactory`
  </integrationFactory>

<workflowOrchestrator>
**Registry role:** Manages the map of `WorkflowInstance` objects; owns cross-cutting resources.
**Seven detector integrations** created once at startup (shared): `copilotCli`, `copilotChat`, `claudeCli`, `codexCli`, `openCodeCli`, `qwenCli`, `geminiCli`
**Harness selection:** Supports copilot-cli (default), copilot-chat, claude-cli, codex-cli, opencode-cli, qwen-cli, gemini-cli
**WorkflowInstance registry:** `instances` Map (running/paused instances), `retiredInstances` Map (disposed instances kept until no client views them), `viewerRegistry` Map<clientId, workflowId|null> (per-client viewer tracking)
**CLI session tracking:** `cliSessions` Map for `CliWatchSession` objects that watch CLI-managed workflows
**Orchestrator-scoped helpers:** `TemplateImporter`, `WorkflowCommandHandler`, `WorkspaceSessionManager`, `PromptFileParser`
**`DashboardBroadcastHub`:** `WorkflowOrchestrator` owns a single `dashboardBroadcastHub` instance (from `src/ui/DashboardBroadcastHub`). It fans out dashboard notifications to all registered dashboard providers and passes itself as `IDashboardSink` to each `WorkflowInstance`.
**VS Code-only:** Not used in the CLI binary; CLI uses `IntegrationFactory` directly
</workflowOrchestrator>

<workflowInstance>
**`WorkflowInstance.ts`** encapsulates all per-workflow execution state.
**Owns:** `PromptQueue`, `WorkflowStateMachine` (as `workflowRuntime`), `WorkflowExecutor`, `EndConditionHandler`, `EndConditionEvaluator`, `PromptFileLoader`, `PromptFileWatcher`, `OutputHistoryManager`, `OutputCaptureBuffer`, `activeIntegration`
**`executionIntegrations` map:** Caches per-run integrations keyed by harness ID; reuses the same integration across prompts when harness doesn't change (avoids allocation per prompt in long-running workflows)
**`lastRunIntegrations`:** Previous run's integrations kept for terminal cleanup (closed at start of next run)
**`liveInjectIntegrations` map:** Integrations whose PTY sessions are intentionally kept alive across runs (inject mode). On the next run, entries are re-inserted into `executionIntegrations` so the existing PTY and session context are reused. Each entry is removed when its PTY exits.
**Dependencies injected by WorkflowOrchestrator:** `integrationFactory` (for per-run execution integrations), `getDetectorIntegration(harness?)` callback, `onWorkflowNameChange`, `onStatusBarUpdate`, `dashboardSink` (the `DashboardBroadcastHub` passed in, then wrapped as a `WorkflowTaggedSink` in the constructor to auto-inject `workflowId`)
**Events:** `onPromptStart`, `onPromptComplete`, `onStreamingEvents`, `onStreamingChunk`, `onWorkflowStatusMessage` — carry typed payloads
**Background buffering:** `OutputCaptureBuffer` stores per-step output (streaming + completed, for both queue steps and finalStep loops) for replay when switching between multiple parallel workflows
</workflowInstance>

<workflowTaggedSink>
**`WorkflowTaggedSink.ts`** — thin proxy around `IDashboardSink` that automatically injects `workflowId`.
- Implements `IDashboardSink`; constructor takes `(inner: IDashboardSink, workflowId: string)`
- Most methods forward to `inner` with `workflowId` injected — no call sites in `WorkflowInstance` need to pass the ID manually
- `WorkflowInstance` creates one in its constructor: `new WorkflowTaggedSink(dashboardSink, this.id)`; all internal `this.dashboardSink` references hold the wrapped proxy
- `updateExecutionStarted` is a pass-through (already receives `workflowId` as its first argument)
- `notifyUndoRedoSynced`, `sendStepUndoDataUpdated`, and `updatePromptDeleted` are pass-throughs (broadcast-to-all semantics, no per-workflow tagging needed)
</workflowTaggedSink>

<promptQueue>
**State container** with events (NOT event-driven executor — WorkflowExecutor handles the loop)
**Why not event-driven:** Retry logic requires staying on the same index; deterministic for-loop control
**Queue topology:** Owns `currentIndex`, `prompts`, `results`, `completedIndices`
**Status delegation:** Runtime execution status (`status`, `stopped`, `startTime`, `pausedTime`, `totalPausedDuration`) is owned by `WorkflowStateMachine`; `PromptQueue` delegates all status transitions to it and projects the state onto `QueueState` via `getState()`
**Working file persistence:** Delegated to `WorkingFileManager` (extracted from PromptQueue)
**Hash-based deduplication:** Prevents duplicate execution on queue reloads (dynamic queue extension)
**Smart retry defaults:** `maxRetries`/`retryPrompt` resolve from settings or explicit values via module-level helpers
</promptQueue>

<workflowStateMachine>
**`WorkflowStateMachine.ts`** — sole owner of workflow execution status transitions.
**Owns:** `status` (ExecutionState), `stopped`, `startTime`, `pausedTime`, `totalPausedDuration`
**Named transitions:** `startExecution()`, `pause()`, `resume()`, `requestStop()`, `confirmStopped()`, `complete()`, `fail()`, `reset()`, `reopenForContinuation()`
**Attempt tracking:** `beginAttempt()`, `scheduleRetry()`, `completeAttempt()`, `failAttempt()`, `cancelAttempt()`, `cancelActiveAttempt()` — per-step attempt lifecycle for retry/timeline use
**Events:** `onDidTransition` (runtime state), `onDidAttemptTransition` (per-step attempt state)
**Snapshot:** `getSnapshot()` returns `WorkflowRuntimeState`; `restore()` rehydrates from persisted state
**Execution timer:** `startExecutionTimer()` / `getActiveExecutionTime()` compute wall-clock elapsed time minus paused duration
**`PromptQueue` relationship:** `PromptQueue` receives a `WorkflowStateMachine` instance in its constructor and delegates all status transitions to it; `getState()` projects both queue topology and state machine runtime fields into a single `QueueState`
</workflowStateMachine>

<workingFileManager>
**`WorkingFileManager.ts`** handles all working file I/O, extracted from `PromptQueue`.
**Working files:** `.flightpath/.queue/*.flightpath.json`, written atomically (temp + rename)
**File lock:** `withFileLock` wrapper prevents concurrent corruption; writes serialized through `operationQueue`
**Disk merge:** `updateWorkingFile()` merges disk prompts before writing to preserve MCP-appended prompts; use `skipMerge=true` for intentional deletes/updates
**Interface:** `IWorkingFileQueueAccess` decouples file I/O from queue state — `PromptQueue` implements it as an adapter
</workingFileManager>

<promptFileParser>
AJV validation, normalizes single/multi formats, loads schema from `out/schemas/prompt-schema.json`
**Never edit schemas in `out/`** — source is `/schemas/`, auto-copied during build
**Supported formats:** .flightpath.yaml/.yml, .flightpath.json, .prompt.md
**Prompt path resolution:** If a prompt value looks like a file path, resolves relative to: prompt file dir → workspace root → `.flightpath/` dir
**Workflow-level properties** (`harness`, `model`, `agent`, `skills`, `resumeSession`, `sessionId`, `mcpServers`, `hooks`, `endCondition`, `preCondition`, `priorContext`, `additionalArgs`) are copied to `PromptFile` and also applied per-`PromptItem`
**ScriptStep support:** Steps with `type: "script"` are built via `buildScriptStep()` instead of `buildPromptStep()`. Applies to both `steps[]` array and the top-level `finalStep` property
**`finalStep` property:** Optional workflow gate — can be a `PromptStep` or a `ScriptStep`; evaluated in a loop after the queue drains
**`PlatformAdapter` dependency:** Optional; used for user-facing error messages
</promptFileParser>

<endConditionHandler>
Orchestrates retry logic with `WorkflowExecutor` callback pattern.
**Two failure paths:** Execution errors (timeout, non-zero exit code) vs validation failures (output doesn't match expected)
**Iterative retry loop** (not recursive) — prevents stack overflow with many retries; `retryOnceMore` flag allows user-triggered extra attempt
**`SendRetryPromptCallback`** type avoids circular dependency with `WorkflowExecutor`
**Dialog actions:** `Stop Workflow | Skip Condition | Open Script` (execution errors); `Stop Workflow | Continue Anyway | Retry Once More` (max retries exhausted)
</endConditionHandler>

<workflowExecutor>
Sequential prompt execution with pause/resume support.
**`WorkflowExecutionContext`** bundle pattern (replaces old `WorkflowContext`) — carries `dashboardProvider`, `getIntegrationForPrompt`, capture callbacks, `snapshotService`, etc.
**Two-phase outer loop:**
  1. **Queue phase** — drains steps via `promptQueue.hasNext()`
  2. **`finalStep` phase** — runs the orchestrator gate once the queue is empty; if new prompts were appended (via MCP queue extension), the outer loop repeats
**Per-step execution routing:**
  - `ScriptStep` (`type: "script"`) — routed directly to `executeScriptStep()`; no AI harness interaction. `onPass`/`onFail` actions control flow (continue, skip, stop).
  - `PromptStep` with `preCondition` — evaluates the pre-condition script first; `onPass`/`onFail` determine whether to run the prompt or skip it
  - `PromptStep` without `preCondition` — normal AI harness execution
**Harness resolution:** Uses `PropertyResolver` to determine harness per prompt (prompt > workflow > global settings)
**Workspace snapshots:** `WorkspaceSnapshotService` captures workspace state before/after each step; stored in history for undo support
**Delegation:** Defers to `EndConditionHandler` for retry logic
**Status transitions:** All status changes go through `WorkflowStateMachine` (no local status fields in executor)
</workflowExecutor>

<endConditionEvaluator>
Executes validation scripts in isolated child processes.
**Security:** Workspace-only paths enforced; absolute paths outside workspace root are rejected
**Process management:** Uses `CliProcessManager` for process lifecycle
**Supported script types:** .py (`python3`/`python`), .js (`node`), .ts (`npx ts-node`), .sh, .bat/.cmd, .ps1 (`pwsh`/`powershell`)
**Direct command fallback:** If script file not found, treats the value as a direct shell command
**Smart parsing:** Separates script path from arguments (`"script.py arg1 arg2"`)
**Result matching:** Exact match, boolean synonyms (`true/1/yes/pass`), numeric `>=` comparison, or substring match
**VS Code env cleanup:** Strips `VSCODE_*` and `ELECTRON_RUN_AS_NODE` vars before spawning child processes
</endConditionEvaluator>

<templateManager>
Manages workflow templates (built-in from `out/templates/workflows/`, custom from `.flightpath/templates/`)
**Built-in template IDs:** `blank`, `simple-feature`, `fix-tests`, `full-feature`, `spec-driven-loop`
**Self-describing built-ins:** Name, description, and variable metadata come from a `_templateMeta` block in each YAML file (same mechanism as user templates); `blank` is generated in code, no file
**Typed placeholder syntax:** `{file:varName}` (Browse button picker), `{text:varName}` (plain input), `{varName}` (plain input, default). Reserved names (`scriptOutput`, `retryCount`, `maxRetries`) are excluded from variable extraction
**Custom templates:** `.flightpath.json` files in `.flightpath/templates/`; IDs prefixed with `custom:`
**`_templateMeta` block:** Top-level key stripped before workflow creation; supports `name`, `description`, `variables` map with `type`/`fileFilter`/`autoFillFilename` per variable
**Output format:** `createWorkflow()` accepts `format: "yaml" | "json"` — built-ins default to YAML
</templateManager>

<queueOperations>
**Single source of truth** for queue status and append operations (MCP and Language Model Tools)
**Shared types:** `QueueStatusResponse`, `AppendPromptsRequest`, `AppendPromptsResponse`
**Position constants:** Use `QUEUE_POSITION` from `DashboardConstants` (next, end)
**Used by:** MCP server, VS Code LM Tools, queue commands
</queueOperations>

<orchestrationClasses>
**In `orchestration/` directory:**
- `PromptFileLoader` — Prompt file I/O, auto-save, working file creation, validation (owned by WorkflowInstance)
- `PromptFileWatcher` — File change detection for dynamic queue updates (owned by WorkflowInstance)
- `OutputHistoryManager` — Per-run output history in `.flightpath/.history/<workflow-id>/`; disk is authoritative, working files do NOT track `outputHistory`
- `TimelineRecorder` — Writes structured timeline events (manifest + events files) into each run directory under `.flightpath/.history/`
- `OutputHistoryTimelineAdapter` — Adapts `TimelineRecorder` output to `WorkflowOutputHistory` for display (bridges new timeline format with history types)
- `TemplateImporter` — Import built-in agents/templates to workspace (owned by WorkflowOrchestrator)
- `WorkflowCommandHandler` — Create prompt files and end condition scripts (owned by WorkflowOrchestrator)
- `WorkspaceSessionManager` — Session discovery, auto-load recent session, resume after restart (owned by WorkflowOrchestrator)
- `CliWatchSession` — Watches a CLI-managed workflow's working file and runner lock; fires `onFinished` when the CLI exits
- `WorkspaceInitializer` — Workspace setup and initialization helpers

**Root `flightpath/` classes (not in orchestration/):**

- `WorkflowOrchestrator` — Registry + cross-cutting concerns
- `WorkflowInstance` — Single workflow execution lifecycle container
- `WorkflowStateMachine` — Sole owner of runtime status transitions and timing
- `WorkflowExecutor` — Execution loop
- `EndConditionHandler` — Retry logic
- `EndConditionEvaluator` — Script execution
- `PromptQueue` + `WorkingFileManager` — Queue topology + file persistence
- `OutputCaptureBuffer` — Output replay for background/parallel workflows
- `WorkflowTaggedSink` — Proxy that injects `workflowId` into every `IDashboardSink` call
- `IntegrationFactory` / `VsCodeIntegrationFactory` — Harness integration factories
  </orchestrationClasses>

<keyPatterns>
**PropertyResolver:** Three-tier precedence (prompt > workflow > global settings) for harness/model/agent/sessionId
**`WorkflowExecutionContext`:** Bundle pattern for passing dependencies to `WorkflowExecutor` (avoids long parameter lists)
**Callback pattern:** `EndConditionHandler` uses `SendRetryPromptCallback` to avoid circular dependencies
**File locking:** `withFileLock` wrapper prevents concurrent working file corruption; all writes go through `WorkingFileManager.operationQueue`
**Event emitters:** `PromptQueue` emits state changes; `WorkflowStateMachine` emits `onDidTransition` and `onDidAttemptTransition`; `WorkflowInstance` subscribes and updates dashboard/status bar
**Detector vs execution integrations:** Detector singletons live for the extension lifetime; execution integrations are per-run and disposed after the `finally` block
**DashboardBroadcastHub:** Fan-out hub in `src/ui/`; `WorkflowOrchestrator` creates it, registers/unregisters dashboard providers on it, and passes it as `IDashboardSink` to `WorkflowInstance`

**CRITICAL — `replayWorkflowStateTo` is required after loading a working file for the panel:**
`DashboardBroadcastHub.updateSessionRestored()` is a deliberate **no-op**. SESSION_RESTORED (which carries completed step statuses) is only sent through a direct `PostMessageDashboardSink` — which only exists inside `replayWorkflowStateTo()` and `replayFullStateTo()`. `WorkflowTaggedSink.updateSessionRestored` does forward to the hub, but since the hub is a no-op for this method, SESSION_RESTORED never reaches panels via the hub.

Consequence: **any code path that loads a working file for a dashboard client MUST call `replayWorkflowStateTo()` after the load**, not before it, and never send a subset of messages manually. Sending only `ACTIVE_WORKFLOW_CHANGED` or `OUTPUT_HISTORY_LOADED` without SESSION_RESTORED causes the panel to receive no step state, making all step status icons display as idle/pending even for completed runs.

Correct pattern (matches `loadWorkflowForClient` and `loadWorkingFile`):

```typescript
const instance = this.buildWorkflowInstance();
this.instances.set(instance.id, instance);
await instance.loadWorkingFile(filePath);
await this.replayWorkflowStateTo(instance.id, send, clientId); // always last
```

Do NOT:

```typescript
await this.createWorkflowForClient(send, clientId); // replays empty state too early
await instance.loadWorkingFile(filePath); // SESSION_RESTORED with real data never sent
await this.dashboardBroadcastHub.loadOutputHistoryForWorkflow(filePath); // hub no-op for session
```

</keyPatterns>

<terminology>
**Harness** (NOT "provider"): The AI framework/tool used for execution (Copilot CLI, Claude CLI, Codex CLI, OpenCode CLI, Copilot Chat)
**Model**: The AI model within a harness (claude-sonnet-4.5, gpt-5, etc.)
**Integration**: `HarnessIntegration` subclass that implements harness-specific behavior
**Working file**: Runtime copy of workflow in `.flightpath/.queue/` with execution state
**Detector singleton**: Long-lived integration used only for availability checks (PATH/version)
**Execution integration**: Short-lived per-run integration with isolated event emitters
</terminology>

<relatedFiles>
- `./HarnessIntegration.ts` — Abstract base class and `HarnessStatus` enum
- `./IntegrationFactory.ts` — CLI harness factory (platform-agnostic)
- `./VsCodeIntegrationFactory.ts` — Extends IntegrationFactory with copilot-chat support
- `./WorkflowInstance.ts` — Per-workflow execution lifecycle container
- `./WorkflowStateMachine.ts` — Sole owner of runtime status transitions, attempt tracking, and timing
- `./OutputCaptureBuffer.ts` — Per-step output capture and replay for background workflows
- `./WorkflowTaggedSink.ts` — Proxy that auto-injects `workflowId` into every `IDashboardSink` call
- `./WorkingFileManager.ts` — Working file I/O extracted from PromptQueue
- `./harness/CliIntegration.ts` — Generic CLI integration (composition-based)
- `./harness/copilot/CopilotCliProvider.ts` — Copilot CLI harness
- `./harness/claude/ClaudeCliProvider.ts` — Claude CLI harness
- `./harness/codex/CodexCliProvider.ts` — Codex CLI harness
- `./harness/opencode/OpenCodeCliProvider.ts` — OpenCode CLI harness
- `./harness/qwen/QwenCliProvider.ts` — Qwen Code CLI harness
- `./harness/gemini/GeminiCliProvider.ts` — Gemini CLI harness
- `./harness/chat/CopilotChatIntegration.ts` — Chat harness (VS Code-only)
- `./orchestration/TimelineRecorder.ts` — Structured timeline event writer
- `./orchestration/OutputHistoryTimelineAdapter.ts` — Adapts timeline format to `WorkflowOutputHistory`
- `./orchestration/*.ts` — Other orchestration helpers (8+ classes)
- `../ui/DashboardBroadcastHub.ts` — Fan-out hub for dashboard notifications (owned by WorkflowOrchestrator)
- `../types/FlightPathTypes.ts` — Core types (Harness enum, PromptItem, WorkingFile, etc.)
</relatedFiles>
