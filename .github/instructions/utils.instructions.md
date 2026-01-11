---
applyTo: "src/utils/**"
---

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

**ConfigurationUtils:** Type-safe config access (`get<T>()`), enum validation (Provider, ExecutionMode), default values.

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
