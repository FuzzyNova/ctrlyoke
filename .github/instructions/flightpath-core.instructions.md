---
applyTo: "src/flightpath/*.ts"
---

<purpose>
Orchestration, parsing, queue, validation, and template management. Top-level `src/flightpath/` files only (excludes `orchestration/` subdirectory and harness implementations).
</purpose>

<flightPathManager>
**Factory pattern:** All 4 harness integrations initialized at startup, `getDefaultIntegration()` respects harness setting, `createIntegrationForMode()` handles per-prompt overrides
**Harness selection:** Supports copilot-cli (default), copilot-chat, claude-cli, codex-cli
**Workflow separation:** Loading delegated to PromptFileLoader, execution to WorkflowExecutor, specialized tasks to orchestration/ classes
**Composition pattern:** Uses 5 orchestration dependencies (PromptFileLoader, PromptFileWatcher, TemplateImporter, WorkflowCommandHandler, WorkspaceSessionManager)
</flightPathManager>

<promptQueue>
**State container** with events (NOT event-driven executor - WorkflowExecutor handles loop)
**Why not event-driven:** Retry logic requires "staying" on same index - deterministic for-loop control
**Working files:** `.flightpath/.queue/*.flightpath.json`, file lock prevents corruption
**Hash-based deduplication:** Prevents duplicate execution on queue reloads (dynamic queue extension)
**Smart retry defaults:** maxRetries/retryPrompt resolve from settings or explicit values
</promptQueue>

<promptFileParser>
AJV validation, normalizes single/multi formats, loads schema from `out/schemas/prompt-schema.json`
**Never edit schemas in `out/`** - source is `/schemas/`, auto-copied during build
**Supported formats:** .flightpath.yaml/.yml, .flightpath.json, .prompt.md
**Path resolution:** Workspace-relative or absolute, markdown files read as plain text
</promptFileParser>

<endConditionHandler>
Orchestrates retry logic with WorkflowExecutor callback pattern
**Extracted from FlightPathManager** for single responsibility principle
**Two failure paths:** Execution errors (timeout, exit code) vs validation failures (wrong output)
**Retry coordination:** Uses SendRetryPromptCallback to execute retry prompts
</endConditionHandler>

<workflowExecutor>
Sequential prompt execution with pause/resume support
**WorkflowContext pattern:** Bundles dependencies (dashboardProvider, getIntegrationForPrompt, etc.)
**Delegation:** Defers to EndConditionHandler for retry logic
**Harness resolution:** Uses PropertyResolver to determine harness per prompt (supports workflow-level and prompt-level overrides)
**Pause state:** Tracks pendingResponseResolver for resuming mid-response
</workflowExecutor>

<endConditionEvaluator>
Executes validation scripts in isolated child processes
**Security:** Workspace-only paths, configurable timeout (default 30s from settings)
**Process management:** Uses CliProcessManager for process lifecycle
**Supported types:** .py, .js, .ts, .sh, .bat, .ps1
**Smart parsing:** Separates script path from arguments in script command
</endConditionEvaluator>

<templateManager>
Manages workflow templates (built-in from `out/templates/workflows/`, custom from `.flightpath/templates/`)
**Variable substitution:** `{variableName}` syntax for placeholders
**Built-in templates:** blank, simple-feature, fix-tests, full-feature (hardcoded definitions)
**Custom templates:** User-created templates with manifest.json metadata
</templateManager>

<queueOperations>
**Single source of truth** for queue status and append operations (MCP and Language Model Tools)
**Shared types:** QueueStatusResponse, AppendPromptsRequest, AppendPromptsResponse
**Position constants:** Use QUEUE_POSITION from DashboardConstants (next, end, current)
**Used by:** MCP server, VS Code LM Tools, queue commands
</queueOperations>

<orchestrationClasses>
**New in orchestration/ directory:**
- PromptFileLoader: Prompt file I/O, auto-save, working file creation, validation
- PromptFileWatcher: File change detection for dynamic queue updates
- TemplateImporter: Import built-in agents/templates to workspace
- WorkflowCommandHandler: Create prompt files and end condition scripts
- WorkspaceSessionManager: Session discovery, auto-load recent session, resume after restart

**Still in root flightpath/:**

- WorkflowExecutor (execution loop)
- EndConditionHandler (retry logic)
- EndConditionEvaluator (script execution)
  </orchestrationClasses>

<terminology>
**Harness** (NOT "provider"): The AI framework/tool used for execution (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat)
**Model**: The AI model within a harness (claude-sonnet-4.5, gpt-5, etc.)
**Integration**: CopilotIntegration subclass that implements harness-specific behavior
**Working file**: Runtime copy of workflow in `.flightpath/.queue/` with execution state
</terminology>

<relatedFiles>
- `./base/CopilotIntegration.ts` - Integration contract
- `./cli/CliIntegration.ts` - Generic CLI integration (composition-based)
- `./cli/copilot/CopilotCliProvider.ts` - Copilot CLI harness
- `./cli/claude/ClaudeCliProvider.ts` - Claude CLI harness
- `./cli/codex/CodexCliProvider.ts` - Codex CLI harness
- `./chat/CopilotChatIntegration.ts` - Chat harness
- `./orchestration/*.ts` - Orchestration helpers (5 classes)
- `../types/FlightPathTypes.ts` - Core types (Harness enum, ExecutionProperties, PromptItem, etc.)
</relatedFiles>

<keyPatterns>
**PropertyResolver:** Three-tier precedence (prompt > workflow > global settings) for harness/model/agent/sessionId
**WorkflowContext:** Bundle pattern for passing dependencies to WorkflowExecutor (avoids long parameter lists)
**Callback pattern:** EndConditionHandler uses SendRetryPromptCallback to avoid circular dependencies
**File locking:** withFileLock wrapper prevents concurrent working file corruption
**Event emitters:** PromptQueue emits state changes, FlightPathManager subscribes and updates UI
</keyPatterns>

<purpose>
Orchestration, parsing, queue, validation, and template management. Top-level `src/flightpath/` files only (excludes `orchestration/` subdirectory and CLI implementations).
</purpose>

<flightPathManager>
**Factory pattern:** All 4 integrations initialized, `getDefaultIntegration()` respects provider setting, `getIntegrationForPrompt()` handles per-prompt overrides
**Workflow separation:** `loadPromptFile()` vs `executeLoadedPromptFile()` vs `appendFromFile()` for dashboard UX
**Delegation:** WorkflowExecutor runs loop, specialized classes in `orchestration/` handle orchestration tasks
</flightPathManager>

<promptQueue>
**State container** with events (NOT event-driven executor - that's WorkflowExecutor's job)
**Why not event-driven:** Retry logic requires "staying" on same index - deterministic for loop control
**Working files:** `.flightpath/.queue/*.flightpath.json`, operation queue prevents concurrent write corruption
**Hash-based deduplication:** Prevents duplicate execution on queue reloads
</promptQueue>

<promptFileParser>
AJV validation, normalizes single/multi formats, loads schema from `out/schemas/prompt-schema.json`. Never edit schema in `out/` directory (source is `/schemas/`).
</promptFileParser>

<endConditionHandler>
Orchestrates retry logic with WorkflowExecutor callback pattern. Extracted from FlightPathManager for SRP.
</endConditionHandler>

<workflowExecutor>
Sequential prompt execution with pause/resume. Uses `WorkflowContext` pattern to bundle dependencies, creates retry callback for EndConditionHandler.
</workflowExecutor>

<endConditionEvaluator>
Executes validation scripts in isolated child processes. Security: workspace-only paths, configurable timeout (default 30s).
Supports: `.py`, `.js`, `.ts`, `.sh`, `.bat`, `.ps1`
</endConditionEvaluator>

<templateManager>
Manages workflow templates (built-in from `out/templates/workflows/`, custom from `.flightpath/templates/`). Variable substitution with `{variableName}` syntax.
</templateManager>

<orchestrationClasses>
WorkflowExecutor, EndConditionHandler, TemplateImporter, WorkflowCommandHandler, WorkspaceSessionManager - extracted from FlightPathManager for SRP.
</orchestrationClasses>

<relatedFiles>
- `./base/CopilotIntegration.ts` - Integration contract
- `./cli/*.ts` - CLI implementations (3 files)
- `./chat/CopilotChatIntegration.ts` - Chat implementation
- `./orchestration/*.ts` - Orchestration helpers
- `../types/FlightPathTypes.ts` - Core types
</relatedFiles>
