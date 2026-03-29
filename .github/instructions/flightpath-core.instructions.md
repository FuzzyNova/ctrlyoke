---
applyTo: "src/flightpath/*.ts"
---

<purpose>
Orchestration, parsing, queue, validation, and template management. Top-level `src/flightpath/` files only (excludes `orchestration/` subdirectory and harness implementations).
</purpose>

<harnessIntegration>
**`HarnessIntegration.ts`** is the abstract base class for all harness integrations.
**HarnessStatus enum:** `Initializing | Waiting | Ready | Unavailable` — used for status bar and UI feedback
**Event emitters:** `onDidChangeStatus`, `onResponseComplete`, `onStreamingChunk` (plain text, Copilot CLI compat), `onStreamingEvents` (structured, Claude/Codex), `onPromptReady`
**`rawTextOutput` getter:** Override in subclasses to signal pre-formatted text output (skips Streamdown pipeline)
**Two integration lifecycles:**
  - *Detector singletons* — created once at startup, registered with `context.subscriptions`, disposed by VS Code
  - *Execution integrations* — created per-run via `IntegrationFactory.createForExecution()`, skip context registration, disposed manually in the `finally` block after each workflow run
**SkillExpander support:** Expands skill references in prompts before execution
**AgentExpander / ContextExpander / TempFileManager / PromptFileSplitter:** Shared utilities for prompt construction
**`PropertyResolver.ResolvedProperties`:** Harness/model/agent/session resolution used during execution
</harnessIntegration>

<integrationFactory>
**`IntegrationFactory.ts`** — platform-agnostic factory for CLI harness integrations only.
- `createCopilotCli()`, `createClaudeCli()`, `createCodexCli()`, `createOpenCodeCli()` — each wraps the matching provider in a `CliIntegration`
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
**WorkflowInstance registry:** `workflows` Map (running/paused instances), `viewedInstance` (displayed in dashboard)
**CLI session tracking:** `cliSessions` Map for `CliWatchSession` objects that watch CLI-managed workflows
**Orchestrator-scoped helpers:** `TemplateImporter`, `WorkflowCommandHandler`, `WorkspaceSessionManager`, `PromptFileParser`
**VS Code-only:** Not used in the CLI binary; CLI uses `IntegrationFactory` directly
</workflowOrchestrator>

<workflowInstance>
**`WorkflowInstance.ts`** encapsulates all per-workflow execution state.
**Owns:** `PromptQueue`, `WorkflowExecutor`, `EndConditionHandler`, `EndConditionEvaluator`, `PromptFileLoader`, `PromptFileWatcher`, `OutputHistoryManager`, `activeIntegration`
**Dependencies injected by WorkflowOrchestrator:** `integrationFactory` (for per-run execution integrations), `getDetectorIntegration(harness?)` callback, `onWorkflowNameChange`, `onStatusBarUpdate`
**Events:** `onPromptStart`, `onPromptComplete` — carry `PromptStartData` / `PromptCompleteData` payloads
**Phase 1:** Orchestrator holds exactly one instance; Phase 2 will hold many in parallel.
</workflowInstance>

<promptQueue>
**State container** with events (NOT event-driven executor — WorkflowExecutor handles the loop)
**Why not event-driven:** Retry logic requires staying on the same index; deterministic for-loop control
**Working file persistence:** Delegated to `WorkingFileManager` (extracted from PromptQueue)
**Hash-based deduplication:** Prevents duplicate execution on queue reloads (dynamic queue extension)
**Smart retry defaults:** `maxRetries`/`retryPrompt` resolve from settings or explicit values via module-level helpers
</promptQueue>

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
**Workflow-level properties** (`harness`, `model`, `agent`, `skills`, `resumeSession`, `sessionId`, `mcpServers`, `endCondition`, `priorContext`, `additionalArgs`) are copied to `PromptFile` and also applied per-`PromptItem`
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
  1. **Queue phase** — drains normal prompts via `promptQueue.hasNext()`
  2. **`finalPrompt` phase** — runs the orchestrator gate once the queue is empty; if new prompts were appended (via MCP queue extension), the outer loop repeats
**Harness resolution:** Uses `PropertyResolver` to determine harness per prompt (prompt > workflow > global settings)
**Delegation:** Defers to `EndConditionHandler` for retry logic
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
- `TemplateImporter` — Import built-in agents/templates to workspace (owned by WorkflowOrchestrator)
- `WorkflowCommandHandler` — Create prompt files and end condition scripts (owned by WorkflowOrchestrator)
- `WorkspaceSessionManager` — Session discovery, auto-load recent session, resume after restart (owned by WorkflowOrchestrator)
- `CliWatchSession` — Watches a CLI-managed workflow's working file and runner lock; fires `onFinished` when the CLI exits
- `WorkspaceInitializer` — Workspace setup and initialization helpers

**Root `flightpath/` classes (not in orchestration/):**
- `WorkflowOrchestrator` — Registry + cross-cutting concerns
- `WorkflowInstance` — Single workflow execution lifecycle
- `WorkflowExecutor` — Execution loop
- `EndConditionHandler` — Retry logic
- `EndConditionEvaluator` — Script execution
- `PromptQueue` + `WorkingFileManager` — Queue state + file persistence
- `IntegrationFactory` / `VsCodeIntegrationFactory` — Harness integration factories
</orchestrationClasses>

<keyPatterns>
**PropertyResolver:** Three-tier precedence (prompt > workflow > global settings) for harness/model/agent/sessionId
**`WorkflowExecutionContext`:** Bundle pattern for passing dependencies to `WorkflowExecutor` (avoids long parameter lists)
**Callback pattern:** `EndConditionHandler` uses `SendRetryPromptCallback` to avoid circular dependencies
**File locking:** `withFileLock` wrapper prevents concurrent working file corruption; all writes go through `WorkingFileManager.operationQueue`
**Event emitters:** `PromptQueue` emits state changes; `WorkflowInstance` subscribes and updates dashboard/status bar
**Detector vs execution integrations:** Detector singletons live for the extension lifetime; execution integrations are per-run and disposed after the `finally` block
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
- `./WorkingFileManager.ts` — Working file I/O extracted from PromptQueue
- `./harness/CliIntegration.ts` — Generic CLI integration (composition-based)
- `./harness/copilot/CopilotCliProvider.ts` — Copilot CLI harness
- `./harness/claude/ClaudeCliProvider.ts` — Claude CLI harness
- `./harness/codex/CodexCliProvider.ts` — Codex CLI harness
- `./harness/opencode/OpenCodeCliProvider.ts` — OpenCode CLI harness
- `./harness/qwen/QwenCliProvider.ts` — Qwen Code CLI harness
- `./harness/gemini/GeminiCliProvider.ts` — Gemini CLI harness
- `./harness/chat/CopilotChatIntegration.ts` — Chat harness (VS Code-only)
- `./orchestration/*.ts` — Orchestration helpers (8 classes)
- `../types/FlightPathTypes.ts` — Core types (Harness enum, PromptItem, WorkingFile, etc.)
</relatedFiles>