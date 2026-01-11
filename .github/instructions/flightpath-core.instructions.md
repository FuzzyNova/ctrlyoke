---
applyTo: "src/flightpath/*.ts"
---

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
