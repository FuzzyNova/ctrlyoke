---
applyTo: "src/utils/**"
---

<purpose>
Shared utilities for file system operations, logging, validation, CLI process management, context expansion, model management, configuration, session management, agent/skill discovery, workspace snapshots, and process coordination.
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

**ModelConstants:** Single source of truth for model lists (COPILOT_MODELS, COPILOT_CLI_MODEL_IDS, CLAUDE_CLI_MODELS, CODEX_CLI_MODELS), display names, CLI support flags. Run `npm run sync-models` to sync with package.json AND prompt-schema.json.

**PropertyResolver:** Three-tier property resolution: Prompt-level → Workflow-level → VS Code settings. Ensures all execution properties (harness, model, agent, resumeSession, allowDynamicExtension, sessionId, endCondition) are resolved with proper defaults.

**SessionResolver:** Per-prompt session tracking with three resolution strategies: prompt number reference (`sessionId: 1`), exact session ID (UUID), auto-resume (no sessionId). Validates cross-harness compatibility and respects workflow-level properties.

**SessionValidator:** Validates session ID formats for each harness. Copilot/Claude require strict UUID v4, Codex accepts any non-empty string (thread_xxx). Prevents CLI errors with graceful fallback.

**AgentDiscovery:** Discovers custom agent files from: user prompts directory (%APPDATA%), workspace `.github/agents/`, `.claude/agents/`, `.flightpath/agents/`. All harnesses supported via prompt prepending (`AgentExpander`); `supportsCopilotCli` and `supportsClaudeCli` flags are always true.

**DiscoveryUtils:** Shared helpers for agent and skill discovery. Contains: `formatDisplayName()` (kebab/snake_case to Title Case), `isAccessibleDirectory()` (safe async directory check), `resolveWorkspaceFolder()` (finds VS Code WorkspaceFolder from optional path). Used by AgentDiscovery, SkillDiscovery.

**AgentExpander:** Reads and expands agent file content for prompt prepending. Uses AgentDiscovery to locate agents by name, returns raw file content with frontmatter stripped.

**SkillDiscovery:** Discovers skill files from multiple locations following AgentSkills.io open standard. Sources: `~/.claude/skills/`, `~/.copilot/skills/`, `~/.agents/skills/`, workspace `.flightpath/skills/`, `.claude/skills/`, `.github/skills/`, `.agents/skills/`, `../.agents/skills/`, git-root `/.agents/skills/`. Returns `SkillInfo[]` with name, displayName, path, description, source.

**SkillExpander:** Expands skill names to concise prompt blocks for injection. Progressive disclosure: only name, path, description included (~10-20 tokens per skill). Full SKILL.md body NOT included. Output wrapped in `<skillInstructions>` tags.

**TempFileManager:** Manages temp files in .flightpath/temp/. Creates unique prompt files with debugging-friendly names, cleanup after execution, orphaned file cleanup on activation.

**RetryUtils:** Retry with exponential backoff for transient failures. Supports fixed/custom delays, PermanentFailureError for immediate abort, common for file polling and CLI log discovery.

**FileLockUtils:** File-based locking with stale lock detection (30s), EEXIST retry logic, process ID tracking. Used for safe concurrent access to shared resources (e.g., queue files).

**WorkflowLockManager:** Atomic lock file CRUD for workflow process coordination. Lock files live at `{queueDir}/{workflowId}.runner.json`. Writes are atomic (write to `.tmp`, then rename). Tracks PID + heartbeat (30s staleness threshold). `checkLock()` returns `"none" | "stale" | "active-vscode" | "active-cli"`. `normalizeStaleLocks()` called on extension startup to reset orphaned `running` states.

**WorkspaceSnapshotService:** Captures workspace file state before/after prompt execution for undo/redo support. Two strategies: `git` (uses `git status --porcelain` — dirty files only) or `filesystem` (full directory walk with gitignore filtering). `computeSnapshotChanges()` produces `SnapshotFileChange[]` with structured unified diffs. `undoFiles()` applies reverse patches, restores deleted files, or deletes created files; returns redo instructions. Max file size: 512 KB.

**PromptIdentity:** SHA-256 content hashing, whitespace normalization, duplicate detection, instruction injection logic for dynamic queue extension.

**TypedEmitter:** Typed event emitter wrapping Node.js `EventEmitter`. Matches `vscode.EventEmitter<T>` API (`fire()`, `event`, `dispose()`). Use in modules that must work in both VS Code and CLI contexts (avoid `vscode.EventEmitter` in shared code).

**RuntimeMode:** Module-level flag tracking whether the process is the VS Code extension or standalone CLI binary. `isCli()` returns true when CLI; `setRuntimeMode('cli')` called once in `cli.ts` startup. Default is `'vscode'`.

**BuildConfig:** Build-time constants replaced by esbuild `define`. `IS_DEV_MODE` (true in dev builds, false in prod) enables dead-code elimination for dev-only features. `BUILD_DATE` for version debugging.

**CliArgParser:** `parseArgString(input)` — parses shell-style argument strings to `string[]`. Supports whitespace separation, double/single-quoted strings, and `\"` escapes within double quotes. No bash substitution or env expansion (intentional — inputs are static YAML strings).

**promptPathUtils:** Pure functions with no Node.js or `vscode` imports — safe for both extension backend and React webview. `looksLikeFilePath(value)` detects lone file-path references (relative `./`, `../`, absolute `/`, Windows drive letter). `PROMPT_FILE_EXTENSIONS` constant.
</keyUtilities>

<terminology>
**Harness** (not "provider"): Execution framework/integration layer (CopilotCli, CopilotChat, ClaudeCli, CodexCli). All code uses "harness" terminology consistently.
</terminology>

<relatedComponents>
- WorkflowOrchestrator: Uses PropertyResolver, SessionResolver, ConfigurationUtils, WorkflowLockManager, WorkspaceSnapshotService
- CopilotIntegration subclasses: Use CliProcessManager, ContextExpander, FileReferenceParser, AttachmentBuilders, TempFileManager, PromptFileSplitter
- PromptFileParser: Uses ValidationUtils for schema validation, promptPathUtils for file-path detection
- PromptQueue: Uses PromptIdentity for deduplication, SessionResolver for session tracking
- FlightPathWebviewProvider: Uses ModelRegistry, Log, ConfigurationUtils
- PromptCompletionProvider: Uses ModelRegistry, AgentDiscovery for IntelliSense
- extension.ts / cli.ts: Sets RuntimeMode; CLI uses BuildConfig for feature flags
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
- HISTORY_DIR: ".history"
- AGENTS_DIR: "agents"
- SKILLS_DIR: "skills"
</pathConstants>
