---
applyTo: "src/utils/**"
---

<purpose>
Shared utilities for file system operations, logging, validation, CLI process management, context expansion, model management, configuration, session management, and agent discovery.
</purpose>

<keyUtilities>
**FileSystemUtils:** Safe file operations, directory creation, chokidar file watching, pattern discovery. Returns safe values (null/false), never throws.

**Log:** Centralized logging with levels (DEBUG/INFO/WARN/ERROR), Output channel, timestamps, stack traces. Methods: `appendLine()`, `append()`, `getOutputChannel()`.

**ValidationUtils:** Runtime AJV validation with TypeScript generics, schema compilation/caching, error formatting.

**ConfigurationUtils:** Type-safe config access with `get<T>()`, enum validation (Harness, ExecutionMode), default values, PATH_CONSTANTS for directory names. All VS Code settings access centralized here.

**CliProcessManager:** Spawn CLI processes (headless/interactive), VS Code terminals, shell integration, graceful shutdown (SIGTERM → SIGKILL), coordinated cancellation.

**ContextExpander:** Expands `#file:` references to attachment XML, handles line ranges, workspace paths, content loading for CLI modes.

**FileReferenceParser:** Single source of truth for parsing file references: `@path` (CLI-native), `@path/dir/` (directories), `#file:path:line-line` (FlightPath XML), `#sym:symbolName` (symbol resolution).

**AttachmentBuilders:** XML attachment building for file/directory/symbol references. Resolves symbols to file locations with line ranges.

**PromptFileSplitter:** Intelligently splits large prompts into chunks respecting token limits (15K default) and line limits (1800 for Claude's 2K limit). Splits on paragraph boundaries, then lines, then sentences.

**ModelRegistry:** Queries Copilot models via `vscode.lm.selectChatModels()`, filters CLI-supported models, emits events on load.

**ModelConstants:** Single source of truth for model lists (COPILOT_MODELS, COPILOT_CLI_MODELS, CLAUDE_CLI_MODELS, CODEX_CLI_MODELS), display names, CLI support flags. Run `npm run sync-models` to sync with package.json AND prompt-schema.json.

**PropertyResolver:** Three-tier property resolution: Prompt-level → Workflow-level → VS Code settings. Ensures all execution properties (harness, model, agent, resumeSession, allowDynamicExtension, sessionId, endCondition) are resolved with proper defaults.

**SessionResolver:** Per-prompt session tracking with three resolution strategies: prompt number reference (`sessionId: 1`), exact session ID (UUID), auto-resume (no sessionId). Validates cross-harness compatibility and respects workflow-level properties.

**SessionValidator:** Validates session ID formats for each harness. Copilot/Claude require strict UUID v4, Codex accepts any non-empty string (thread_xxx). Prevents CLI errors with graceful fallback.

**AgentDiscovery:** Discovers custom agent files from multiple locations: user prompts directory (%APPDATA%), workspace .github/agents/, workspace .claude/agents/. Tracks CLI compatibility per harness. Note: Claude CLI agent support currently broken (issue #9930).

**TempFileManager:** Manages temp files in .flightpath/temp/. Creates unique prompt files with debugging-friendly names, cleanup after execution, orphaned file cleanup on activation.

**RetryUtils:** Retry with exponential backoff for transient failures. Supports fixed/custom delays, PermanentFailureError for immediate abort, common for file polling and CLI log discovery.

**FileLockUtils:** File-based locking with stale lock detection (30s), EEXIST retry logic, process ID tracking. Used for safe concurrent access to shared resources.

**PromptIdentity:** SHA-256 content hashing, whitespace normalization, duplicate detection, instruction injection logic for dynamic queue extension.
</keyUtilities>

<terminology>
**Harness** (not "provider"): Execution framework/integration layer (CopilotCli, CopilotChat, ClaudeCli, CodexCli). All code uses "harness" terminology consistently.
</terminology>

<relatedComponents>
- FlightPathManager: Uses PropertyResolver, SessionResolver, ConfigurationUtils for orchestration
- CopilotIntegration subclasses: Use CliProcessManager, ContextExpander, FileReferenceParser, AttachmentBuilders, TempFileManager, PromptFileSplitter
- PromptFileParser: Uses ValidationUtils for schema validation
- PromptQueue: Uses PromptIdentity for deduplication, SessionResolver for session tracking
- FlightPathWebviewProvider: Uses ModelRegistry, Log, ConfigurationUtils
- PromptCompletionProvider: Uses ModelRegistry, AgentDiscovery for IntelliSense
</relatedComponents>

<pathConstants>
ConfigurationUtils.PATH_CONSTANTS provides single source of truth for directory names:
- FLIGHTPATH_DIR: ".flightpath"
- QUEUE_DIR: ".queue"
- SCRIPTS_DIR: "scripts"
- PROMPTS_DIR: "prompts"
- TEMPLATES_DIR: "templates"
- WORKFLOWS_DIR: "workflows"
- TEMP_DIR: "temp"
- LOGS_DIR: "logs"
</pathConstants>

<purpose>
Shared utilities: file system, logging, validation, CLI process management, context expansion, model management, configuration.
</purpose>

<keyUtilities>
**FileSystemUtils:** Safe file ops, directory creation, chokidar file watching, pattern discovery. Returns safe values (null/false, never throws).

**Log:** Centralized logging with levels (DEBUG/INFO/WARN/ERROR), Output channel, timestamps, stack traces. Methods: `appendLine()` (no timestamp), `append()` (no newline/timestamp), `getOutputChannel()`.

**ValidationUtils:** Runtime AJV validation with TypeScript generics, schema compilation/caching, error formatting.

**CliProcessManager:** Spawn CLI processes (headless/interactive), VS Code terminals, shell integration, graceful shutdown (SIGTERM → SIGKILL), coordinated cancellation.

**ContextExpander:** Expands `#file:` references to attachment XML, handles line ranges, workspace paths, content loading.

**CompletionHelpers:** Autocomplete for `@file` and `#file:`, workspace file discovery, current selections, link parsing for Ctrl+Click.

**ModelRegistry:** Queries Copilot models via `vscode.lm.selectChatModels()`, filters CLI-supported models, emits events on load.

**ModelConstants:** Single source of truth for model lists (COPILOT_MODELS, COPILOT_CLI_MODELS, CLAUDE_CLI_MODELS, CODEX_CLI_MODELS), display names, CLI support flags. Run `npm run sync-models` to sync with package.json AND prompt-schema.json.

**ConfigurationUtils:** Type-safe config access (`get<T>()`), enum validation (Harness, ExecutionMode), default values.

**PromptIdentity:** SHA-256 content hashing, whitespace normalization, duplicate detection, instruction injection logic.

**AnsiToHtml:** Converts ANSI escape codes to HTML spans with inline styles for CLI output display.
</keyUtilities>

<relatedFiles>
- FlightPathManager.ts - Uses all utilities for orchestration
- CopilotIntegration implementations - Use CliProcessManager, ContextExpander, ModelConstants
- PromptFileParser.ts - Uses ValidationUtils for schema validation
- PromptQueue.ts - Uses PromptIdentity for deduplication
- FlightPathDashboardProvider.ts - Uses CompletionHelpers, ModelRegistry, Log
- PromptCompletionProvider.ts - Uses CompletionHelpers, ModelRegistry
</relatedFiles>
