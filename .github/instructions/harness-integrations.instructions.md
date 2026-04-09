---
applyTo: "src/flightpath/harness/**"
---

<purpose>
Harness integrations for GitHub Copilot, Claude Code, Codex, OpenCode, Qwen Code, and Gemini CLI. Deterministic completion, structured output, no UI dependencies. Supports both interactive TUI and headless background execution modes.
</purpose>

<architectureOverview>
**Composition-based architecture:**

FlightPath uses **composition over inheritance** for harness integrations:

- **Single generic integration class** (`CliIntegration`) works with ALL harnesses
- **Harness-specific logic** encapsulated in harness directories (copilot/, claude/, codex/, opencode/, gemini/, qwen/)
- **Interface-driven design** (TypeScript guides implementation)
- **Testable components** (no mocking needed, pure logic)

**Adding a harness requires changes across multiple layers** — harness directory, types, wiring, settings, and UI. See `dev/implemented/ADDING_NEW_CLI_HARNESS.md` for the complete guide.
</architectureOverview>

<coreComponents>
**CliIntegration** (src/flightpath/harness/CliIntegration.ts):
- Generic integration class that works with ANY provider
- Delegates all provider-specific behavior to `ICliProvider` instance
- Internally composes 5 coordinator services: `CliPromptPreparer`, `CliSessionResolverAdapter`, `CliPromptRuntimeCoordinator`, `CliTransportCoordinator`, `CliExecutionRunner`
- Handles execution lifecycle (interactive/headless modes, VS Code terminal or CLI spawn)
- Manages session continuity, cancellation, temp file creation/cleanup, and status updates
- Terminal tab name: `FP: {Harness}` or `FP: {Harness} · {name} [n/total]`
- Coordinates hook-based completion detection alongside log file monitoring
- Calls `provider.cleanupWorkspaceArtifacts()` at workflow end to restore modified workspace files
- Rarely needs modification when adding new harnesses (changes only when new shared capabilities are needed)

**IntegrationFactory** (src/flightpath/IntegrationFactory.ts):

- Central factory for creating provider-specific `CliIntegration` instances
- Methods: `createCopilotCli()`, `createClaudeCli()`, `createCodexCli()`, `createOpenCodeCli()`, `createQwenCli()`, `createGeminiCli()`, `createForHarness(harness)`
- `VsCodeIntegrationFactory` extends this with chat support
- WorkflowOrchestrator uses this to create and cache all integrations at startup

**CliLogMonitor** (src/flightpath/harness/CliLogMonitor.ts):

- Focused single-responsibility class for log file monitoring and event processing
- Uses composition via `ILogParser` interface — works with any CLI harness
- Dual completion detection: log-based events AND parallel notification monitor (hook files)
- When notification monitor active, hook is authoritative (prevents false positives from intermediate log events)
- Drains remaining log entries after completion signal (race-safe)
- Detects PTY process exit via `isPtyTerminated()` callback for abnormal exit handling
- Extracts context window data from process logs (Copilot-specific augmentation)

**PtyProcessManager** (src/flightpath/harness/PtyProcessManager.ts):

- Manages node-pty sessions for embedded terminal support (webview xterm.js bridge)
- Singleton pattern initialized by extension.ts
- Handles both AI CLI sessions (`kind: 'ai-cli'`) and user shell sessions (`kind: 'shell'`)
- Maintains `reconnectBuffer` per session for webview reconnection (replays recent output)
- Default PTY dimensions: 220 cols × 50 rows (webview ResizeObserver corrects on mount)
- Lazy-loads node-pty at spawn time; Windows shell resolution prefers `pwsh.exe` over `powershell.exe`

**ICliProvider Interface** (src/flightpath/harness/shared/interfaces/ICliProvider.ts):

- Main provider contract — defines what a CLI provider must implement
- **Required**: `config` (HarnessConfig), `responseParser`, `notificationMonitor`, `toolPermissionMapper`
- **Required methods**: `buildCliArgs()`, `buildHeadlessArgs()`, `buildInteractiveTuiCommand()`, `checkAvailability()`
- **Optional**: `logParser`, `formatFileReference()`, `getMcpConfigArgs()`, `getMcpConfigFilePath()`, `getAdditionalCleanupFilePaths()`, `cleanupWorkspaceArtifacts()`, `buildPermissionArgs()`, `buildNotificationHookArgs()`, `buildHeadlessUserHookArgs()`, `getVersion()`, `getInteractiveSpawnEnv()`, `extractSessionIdFromLogs()`, `augmentParsedOutput()`
- `cleanupWorkspaceArtifacts(workspaceRoot, workingFilePath)` — restores workspace files modified during interactive hook/MCP setup (backup-and-restore pattern for `.gemini/settings.json`, `.qwen/settings.json`)
- `getInteractiveSpawnEnv()` — environment overrides for interactive spawning (e.g., unset `CLAUDECODE` to allow nested Claude CLI)
- `buildPermissionArgs?(toolPermissions)` — builds tool permission CLI args; called by CliIntegration for both interactive and headless modes (replaces permission block that was previously embedded in `buildCliArgs()`)
- `buildNotificationHookArgs?(extensionPath, workspaceRoot, promptIndex, workingFilePath, userHooks)` — sets up FlightPath notification hooks for interactive mode; returns additional CLI args (e.g., `["--settings", path]`); replaces interactive hook block that was previously inside `buildCliArgs()`
- `buildHeadlessUserHookArgs?(workspaceRoot, promptIndex, workingFilePath, userHooks)` — sets up user-defined hooks for headless execution; returns additional CLI args; replaces headless user-hook block that was previously inside `buildCliArgs()`
- `HarnessConfig` fields: `name`, `displayName`, `terminalName`, `installHint`, `shouldStreamHeadlessOutput`, `usesInteractiveNotificationMonitor`, `rawTextOutput`
  </coreComponents>

<providerStructure>
Each provider is self-contained in its own directory with 6 required files:

```
src/flightpath/harness/copilot/
├── CopilotCliProvider.ts          # Main provider descriptor (implements ICliProvider)
├── CopilotResponseParser.ts       # Implements IResponseParser (parse output, extract tokens)
├── CopilotNotificationMonitor.ts  # Implements INotificationMonitor (completion detection + hooks)
├── CopilotToolPermissionMapper.ts # Implements IToolPermissionMapper (permission args)
├── CopilotToolBuilder.ts          # Converts tool call payloads into CliEvent objects
└── CopilotLogParser.ts            # Implements ILogParser (log file monitoring/session ID)
```

**CopilotCliProvider.ts** (main provider class):

- Aggregates all components (config, parser, monitor, mapper)
- Implements provider-specific CLI argument building
- Defines TUI patterns (escapeIndicator, chromePatterns, screenEndPattern)
- Handles file reference formatting (@file for Copilot)
- Generates MCP configuration (if supported)
- Builds per-prompt hook files for interactive mode
- Implements `cleanupWorkspaceArtifacts()` for providers that modify workspace files

**CopilotResponseParser.ts**:

- Parses CLI output (stdout/stderr) into structured result
- Extracts session IDs from output/logs
- Parses token counts for dashboard display
- Processes streaming chunks for real-time display (optional)

**CopilotNotificationMonitor.ts**:

- Configures hook/notification scripts (sessionStart, sessionEnd, Stop, notify)
- Builds hook config with FlightPath completion-detection hooks AND user-defined hooks
- Monitors for completion events (file-based polling)
- Extracts session IDs from notifications (if available)
- Handles both specific file and wildcard monitoring modes
- Accepts `userHooks` parameter in `buildHookConfig()` for hook merging

**CopilotToolPermissionMapper.ts**:

- Converts FlightPath tool permissions to CLI-specific arguments
- Implements dangerouslyAllowAll, allowAll, and custom modes
- Handles allow/deny pattern translation
- Determines if full permissions granted (no prompts)

**CopilotToolBuilder.ts**:

- Static utility class converting CLI tool call payloads into `CliEvent` objects
- `buildInitiatedEvent()` — called on tool.execution_start (includes old/new content for FILE_EDIT)
- `buildCompletedEvents()` — called on tool.execution_complete (carries `structuredPatch` with accurate line numbers)
- Uses `CliEventMapper` for semantic tool classification
- Enables code reuse between LogParser and ResponseParser (both call ToolBuilder)

**CopilotLogParser.ts** (extends BaseLogParser):

- Monitors provider-specific log files for session IDs and events
- Implements ILogParser interface
- Provider-specific log format parsing
  </providerStructure>

<executionModes>
CliIntegration supports two execution modes:

**Interactive TUI Mode**:

- Creates fresh terminal for each prompt
- Injects command via `terminal.sendText()`
- User sees real-time TUI output with spinner, status updates
- Completion detected via hook/notification file (CliNotificationMonitor)
- Session continuity via `--resume` flags (NOT terminal reuse)
- User can abort with Ctrl+C
- Best for development and debugging

**Headless Background Mode**:

- Spawns background process with stdio pipes
- Prompt passed via temp file or direct CLI argument (adaptive)
- Optional real-time streaming to Output panel
- Completion detected via process exit (exit code based)
- Requires full tool permissions (no interactive prompts)
- Silent execution, no terminal window
- Best for automation and CI/CD

**Mode selection**: Controlled by `flightpath.cliExecutionMode` setting (default: interactive)
</executionModes>

<adaptivePromptPassing>
FlightPath uses **adaptive prompt passing** based on prompt complexity:

**Simple prompts** (≤300 characters):

- Passed directly on CLI: `copilot --prompt "your question here"`
- Faster, no temp file overhead
- Works for most single-sentence prompts

**Complex prompts** (>300 characters):

- Written to temp file: `.flightpath/temp/prompt-{timestamp}.md`
- Passed as file reference: `copilot --prompt "@.flightpath/temp/prompt-{timestamp}.md"`
- Prefixed with: "Follow instructions in @{file}"
- Avoids CLI argument length limits
- Preserves formatting and multi-line structure

**Implementation**:

- CliIntegration.sendPromptInternal() measures prompt length
- Calls provider.buildHeadlessArgs() (simple) or provider.buildHeadlessArgsWithDirectPrompt() (complex)
- Provider formats file references per CLI conventions (@file, -f file, etc.)
  </adaptivePromptPassing>

<sessionManagement>
**Session Continuity** (multi-turn conversations):

1. **Session ID Extraction**:
   - Copilot: Parses log files for "Flushed X events to session {GUID}"
   - Claude: Extracts from JSON output `thread_id` field
   - Codex: Extracts from JSONL events or notify hook data
   - Provider's responseParser.extractSessionId() handles extraction

2. **Session Resumption**:
   - When `newChatSession: false` in prompt file
   - CliIntegration adds resume flags via provider CLI args
   - Copilot: `--resume <session-id>`
   - Claude: `-c` (continue) or `-r <thread-id>` (resume)
   - Codex: `--resume <thread-id>`
   - Session persists across multiple prompts in workflow

3. **Session Reset**:
   - When `newChatSession: true` (default)
   - No resume flags added
   - Fresh conversation context
   - Previous session ID discarded
     </sessionManagement>

<cancellation>
**User Cancellation** (CliIntegration.cancel() method):

**Interactive Mode**:

- Sends Ctrl+C (`\x03`) to terminal
- Graceful termination (CLI handles cleanup)
- User sees cancellation in terminal output

**Headless Mode**:

- Kills background process (SIGTERM on Unix, TerminateProcess on Windows)
- Immediate termination

**Cleanup**:

- Aborts completion detection (CliNotificationMonitor polling / file monitoring)
- Clears currentProcess/currentExecution references
- Updates status to idle
- Called by WorkflowOrchestrator.stop() when user presses stop button

**Process Lifecycle**:

- currentProcess (headless) or currentExecution (interactive) set on start
- Cleared automatically on process/command close
- Cleared immediately on cancel()
  </cancellation>

<differenceFromChatMode>
CLI integrations provide deterministic, structured automation vs Chat's UI-based approach:

| Aspect                   | CLI Mode                                          | Chat Mode                          |
| ------------------------ | ------------------------------------------------- | ---------------------------------- |
| **Completion detection** | Process exit or escape indicator (deterministic)  | Log file polling (timing-based)    |
| **Output access**        | Direct stdout/stderr (structured)                 | Clipboard scraping (text-based)    |
| **Streaming**            | Real-time via execution.read() or stdout chunks   | No streaming (full response only)  |
| **Cancellation**         | Kill process or send Ctrl+C                       | Cancel chat command                |
| **Tool permissions**     | CLI arguments (--allow-all-tools, etc.)           | User prompts in chat UI            |
| **File attachment**      | CLI arguments or file references                  | Native VS Code attachment commands |
| **Response format**      | Structured (JSON/JSONL/plain text + stats)        | Unstructured text (clipboard)      |
| **Reliability**          | High (deterministic, no UI dependencies)          | Medium (depends on log timing)     |
| **User visibility**      | Terminal (interactive) or Output panel (headless) | Chat panel                         |

**Use CLI when**: Automation, CI/CD, structured workflows, deterministic completion required
**Use Chat when**: CLI not available, user prefers GUI, exploratory conversations
</differenceFromChatMode>

<configuration>
Key settings (see package.json for full list):

**Execution Mode**:

- `flightpath.harness`: "copilot-cli" | "claude-cli" | "codex-cli" | "opencode-cli" | "qwen-cli" | "gemini-cli" | "copilot-chat"
- `flightpath.cliExecutionMode`: "interactive" | "headless" (default: interactive)

**Models** (per provider):

- `flightpath.copilotCliModel`: "claude-sonnet-4.5" | "gpt-5" | etc.
- `flightpath.claudeCliModel`: "sonnet" | "opus" | "haiku"
- `flightpath.codexCliModel`: "gpt-5.2-codex" | "gpt-5.2-codex-max" | etc.
- `flightpath.openCodeCliModel`: provider/model format (e.g. "anthropic/claude-sonnet-4-6")
- `flightpath.qwenCliModel`: "coder-model" | etc.
- `flightpath.geminiCliModel`: "gemini-2.5-pro" | etc.

**Tool Permissions** (shared across all CLIs):

- `flightpath.cliToolPermissions`: "dangerouslyAllowAll" | "allowAll" | "custom"
- `flightpath.cliAllowedTools`: Array of tool patterns (Copilot format, auto-converted)
- `flightpath.cliDeniedTools`: Array of tool patterns (takes precedence)

**Example tool patterns**:

- Copilot: `shell(git:*)`, `write`, `github(search_repositories)`
- Converted to Claude: `Bash`, `Write` (lowercase → Pascal case)

**Logging & Output**:

- `flightpath.copilotCliLogDir`: Custom log directory (defaults to system temp)
- `flightpath.showCliOutput`: Show prompts/responses in Output panel (default: true)

**Chat Fallback** (when CLI unavailable):

- `flightpath.chatWindowLocation`: "chatPanel" | "newTab" | "newWindow"
- `flightpath.chatInactivityTimeout`: Seconds to wait before timeout (default: 300)
  </configuration>

<factoryPattern>
**WorkflowOrchestrator** instantiates ALL integrations eagerly at startup via `IntegrationFactory`, then routes execution to the active harness. All seven integrations (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, gemini-cli, copilot-chat) are created at startup. Availability is checked for all; the active one is selected via the `flightpath.harness` setting using `HARNESS_IDS` constants.

See: `dev/implemented/ADDING_NEW_CLI_HARNESS.md` for the complete guide to adding a new harness.
</factoryPattern>

<addingNewHarnesses>
**To add a new CLI harness** — see `dev/implemented/ADDING_NEW_CLI_HARNESS.md` for the full guide.

Summary of required layers:

1. **Harness directory** (`src/flightpath/harness/<name>/`) — 6 files implementing ICliProvider, IResponseParser, INotificationMonitor, IToolPermissionMapper, BaseLogParser, and ToolBuilder
2. **Hook script** (`src/scripts/flightpath-<name>-hook.js`) — if hook-based completion detection
3. **Type layer** — add `Harness` enum value, `HARNESS_IDS` entry, display names, and model list in `DashboardConstants.ts` and `FlightPathTypes.ts`
4. **Wiring layer** — factory method in `IntegrationFactory.ts`, integration field/lifecycle in `WorkflowOrchestrator.ts`
5. **Settings layer** — model/args getters in `ConfigurationUtils.ts`, model arrays in `ModelConstants.ts`, settings in `package.json`
6. **UI layer** — availability state and model options in `WebviewSettingsSync.ts`, display name and group in `HarnessDropdown.tsx`, initial state in `settingsStore.ts`
   </addingNewHarnesses>

<testingProviders>
**Provider Testing Checklist**:

1. **Availability Check**: `provider.checkAvailability()` finds CLI executable
2. **Interactive Mode**:
   - ✅ Fresh terminal opens for each prompt
   - ✅ TUI displays correctly (spinner, status, chrome filtered)
   - ✅ Completion detected via hook/escape indicator
   - ✅ Response extracted correctly
   - ✅ Token counts parsed and displayed
   - ✅ Ctrl+C cancellation works
3. **Headless Mode**:
   - ✅ Silent background execution
   - ✅ Completion detected via process exit or structured output
   - ✅ Streaming works (if enabled)
   - ✅ Response and statistics extracted
   - ✅ Process kill cancellation works
4. **Session Continuity**:
   - ✅ Session ID extracted from first prompt
   - ✅ Resume flags added to subsequent prompts
   - ✅ Multi-turn conversation context maintained
5. **Tool Permissions**:
   - ✅ dangerouslyAllowAll bypasses all prompts
   - ✅ allowAll grants permissions but respects deny list
   - ✅ custom mode uses specific patterns
   - ✅ Patterns converted correctly for CLI
6. **User-Defined Hooks**:
   - ✅ User hooks merged alongside FlightPath completion-detection hooks
   - ✅ Hook event mapping correct for provider (stop → native event name)
   - ✅ Parallel workflows don't corrupt shared hook config (per-prompt files or ref-counting)
   - ✅ Hook files cleaned up after workflow completes
   - ✅ Pre-trust entries written for Gemini/Qwen (no interactive approval prompts)

**Manual test files**: `manual-test/*.flightpath.json`
**Unit tests**: `src/test/suite/harness/`
</testingProviders>

<providerSpecifics>
### Copilot CLI (CopilotCliProvider)

**Completion Detection**:

- **Headless**: Process exit (deterministic)
- **Interactive**: sessionStart + sessionEnd hooks (write JSON to `.flightpath/temp/copilot-notifications/`)
- **Hook format**: `.github/hooks/flightpath-<stem>-p<promptIndex>.json` with bash/powershell fields
- **Per-prompt files**: Each prompt gets a unique hook file — no merging conflicts in parallel workflows
- **File naming**: `session-{sessionId}.json` in notification directory; `status` field distinguishes start/end
  - sessionStart writes: `{ status: "started", sessionId: "...", hookType: "sessionStart" }`
  - sessionEnd overwrites: `{ status: "completed", sessionId: "...", hookType: "sessionEnd" }`
- **Monitoring**: Status-aware mode — polls `session-{sessionId}.json` for `status: "completed"`, skips `status: "started"`
- **Session ID**: Extracted from sessionStart hook notification (no log file search needed)
- **User hooks**: Appended to FlightPath hooks per event (sessionStart, sessionEnd) in the hook config JSON
- **Cleanup**: Hook files tracked in `interactiveHookFilePaths[]` for deletion after workflow

**Output Format**: Plain text with statistics on stderr
**Tool Permissions**: `--allow-all-tools`, `--allow-tools`, `--deny-tools` with Copilot-specific patterns
**File Reference**: `@path/to/file.ts`
**MCP Config**: `--additional-mcp-config @file` with JSON format
**Models**: Dynamic via `copilot help config` (claude-sonnet-4.5, gpt-5, etc.)

**Log Requirements**: `--log-level debug` required for session ID extraction (fallback only)

**See**: CopilotCliProvider.ts, CopilotNotificationMonitor.ts

---

### Claude CLI (ClaudeCliProvider)

**Completion Detection**:

- **Headless**: JSON events in stream-json output
- **Interactive**: Stop hook (writes JSON to `.flightpath/temp/claude-notifications/session-{thread-id}.json`)
- **Hook format**: JSON settings file passed via `--settings <path>` flag
- **Per-prompt files**: Temp file pattern `claude-hook-settings-<safeStem>-p<promptIndex>.json` — avoids parallel collisions
- **Monitoring**: Specific file mode (uses thread ID from initial output)
- **Session ID**: Extracted from JSON `thread_id` field
- **User hooks**: Appended per event (SessionStart, Stop, PreToolUse, PostToolUse) in settings JSON
- **Cleanup**: Hook settings files tracked in `interactiveHookSettingsPaths[]` for deletion

**Output Format**: JSON streaming (`--stream-json` required)
**Tool Permissions**: `--dangerously-skip-permissions`, `--tools default`, tool-specific allows/denies
**File Reference**: `path/to/file.ts` (no @ prefix)
**MCP Config**: Supported via `--mcp-config <file>` with JSON format; auto-approves FlightPath tools (`mcp__flightpath`) and user-defined MCP server tools
**Models**: Aliases (sonnet, opus, haiku) with `--model` flag

**Session Resumption**: `-c` (continue last) or `-r <thread-id>` (resume specific)

**See**: ClaudeCliProvider.ts, ClaudeNotificationMonitor.ts, ClaudeResponseParser.ts

---

### Codex CLI (CodexCliProvider)

**Completion Detection**:

- **Headless**: JSONL events (`{"type":"turn.completed"}`)
- **Interactive**: Hooks via `.codex/hooks.json` (requires `--enable codex_hooks` flag)
- **Hook format**: JSON object written to `.codex/hooks.json` via `SettingsJsonHooksTracker` (matcher-based: `{ matcher: "", hooks: [{type: "command", command: "..."}] }`)
- **Monitoring**: Specific file mode (`{sessionId}-stop.json`) with wildcard fallback; standardized format matching Claude/Qwen/Gemini
- **Session ID**: Extracted from JSONL events or hook notification data
- **User hooks**: Via `SettingsJsonHooksTracker` (parallel-safe ref-counted); no trusted_hooks.json — Codex hooks run without approval prompts when `codex_hooks` is enabled
- **Events supported**: `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`

**Output Format**: JSONL streaming (one JSON object per line)
**Tool Permissions**: Same as Copilot (auto-converted from shared settings)
**File Reference**: `path/to/file.ts` (no prefix — Codex does not use `@` or `-f`)
**MCP Config**: Inline TOML via `-c 'mcp_servers.flightpath={...}'`; only supports FlightPath server (no user MCP servers due to TOML inline format)
**Models**: GPT-5 variants (gpt-5.2-codex, gpt-5.3-codex, gpt-5.1-codex, gpt-5.1-codex-max, etc.)

**Session Resumption**: `resume <session-id>` (subcommand, not flag)

**See**: CodexCliProvider.ts, CodexNotificationMonitor.ts, CodexResponseParser.ts, `docs/CODEX_CLI_INTEGRATION.md`

---

### OpenCode CLI (OpenCodeCliProvider)

**Completion Detection**:

- **Headless**: JSONL events (`session.status` idle events) via `--format json`
- **Interactive**: TypeScript plugin written to `.opencode/plugin/flightpath-completion-hook.js` before each run; the plugin fires on session status changes
- **Monitoring**: Plugin-based (not hook file polling)
- **Session ID**: Extracted from JSONL events
- **User hooks**: Embedded directly in generated plugin by `OpenCodePluginGenerator`; if no user hooks, static plugin file copied as-is

**Output Format**: JSONL streaming (`--format json`, `opencode run "prompt"` for headless; `opencode --prompt "..."` for interactive)
**Tool Permissions**: Config-file driven (`opencode.json`); `OpenCodeToolPermissionMapper` returns `[]` (no CLI permission args)
**File Reference**: Not applicable (prompt passed inline or as `-f` arg depending on mode)
**MCP Config**: Written to `.opencode/opencode.json` (auto-discovered, format: `{ mcp: { flightpath: { type: "local", command: [...] } } }`)
**Models**: `provider/model` format (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-5`)

**Additional files**: `OpenCodeEventMapper.ts` — provider-specific event mapping, `OpenCodePluginGenerator.ts` — generates completion plugin with optional user hooks

**Session Resumption**: `-s <sessionId>`

**See**: OpenCodeCliProvider.ts, OpenCodeNotificationMonitor.ts, OpenCodeResponseParser.ts

---

### Qwen Code CLI (QwenCliProvider)

**Completion Detection**:

- **Headless**: Process exit + JSONL events
- **Interactive**: Hooks via `.qwen/settings.json` (requires `--experimental-hooks` flag)
- **Events**: `SessionStart`, `UserPromptSubmit`, `Stop`
- **Session ID**: From `system.init` or `result` JSONL events; fallback via log file analysis (`QwenLogParser`)
- **User hooks**: Converted to Qwen format and merged into settings.json per event (Stop, SessionStart, PreToolUse, PostToolUse, UserPromptSubmit)
- **Reliable start signal**: Monitors both `SessionStart` AND `UserPromptSubmit` — SessionStart fires fire-and-forget in React's useEffect and may not complete before fast prompts end
- **Pre-trust**: Hook commands auto-trusted in `~/.qwen/trusted_hooks.json` (colon-prefixed key format `:${command}`)
- **Windows caveat**: No quotes in hook command strings — Qwen's `spawn(cmd.exe, ['/d','/s','/c', command], {shell:false})` passes quotes literally

**Output Format**: JSONL streaming
**Tool Permissions**: `--approval-mode`, `-y`, `--allowed-tools`, `--exclude-tools` (via `QwenToolPermissionMapper`)
**File Reference**: Prompt passed inline or via temp file
**MCP Config**: Parallel-safe via `SettingsJsonMcpTracker`; written to `.qwen/settings.json` with `--allowed-mcp-server-names` flag
**Models**: e.g. `coder-model` (via `--model`)

**Session Resumption**: `--continue` flag

**See**: QwenCliProvider.ts, QwenNotificationMonitor.ts, QwenResponseParser.ts, QwenLogParser.ts

---

### Gemini CLI (GeminiCliProvider)

**Completion Detection**:

- **Headless**: JSON streaming events
- **Interactive**: Hooks via `.gemini/settings.json` (auto-discovered, no flag needed)
- **Events**: `SessionStart` and `AfterAgent` (Gemini's native completion event)
- **Session ID**: Extracted from JSON `init` events
- **User hooks**: Converted to Gemini format and merged into settings.json per event (AfterAgent, SessionStart)
- **Pre-trust**: Hook commands auto-trusted in `~/.gemini/trusted_hooks.json` (colon-prefixed key format `:${command}`)

**Output Format**: JSON streaming
**Tool Permissions**: Mode-based via `GeminiToolPermissionMapper`
**File Reference**: Prompt passed inline or via temp file
**MCP Config**: Parallel-safe via `SettingsJsonMcpTracker`; written to `.gemini/settings.json` with `--allowed-mcp-server-names` flag; supports workspace MCP
**Models**: `gemini-2.5-pro` | etc. (via `--model`)

**Session Resumption**: Via session ID flag

**See**: GeminiCliProvider.ts, GeminiNotificationMonitor.ts, GeminiResponseParser.ts

</providerSpecifics>

<sharedUtilities>
**Truly shared utilities** (provider-agnostic, no harness-specific logic):

**BaseLogParser** (src/flightpath/harness/shared/BaseLogParser.ts):

- Abstract base class implementing ILogParser
- Common log file monitoring (polling, line tracking)
- Provider subclasses extend this for format-specific parsing

**CliNotificationMonitor** (src/flightpath/harness/shared/CliNotificationMonitor.ts):

- Shared notification/hook file monitoring
- Supports both specific-file and wildcard polling modes
- Extracts completion events and session IDs from hook output
- Notification file naming: `session-{id}.json` or `thread-{id}.json`
- Auto-deletes notification files after reading via `FileSystemUtils.readJsonFileAndDelete()`

**CliOutputFormatter** (src/flightpath/harness/shared/CliOutputFormatter.ts):

- Formats CLI responses for the Output panel and dashboard
- Structures `DashboardOutput` (text, tokens, statistics)
- Provider-agnostic display formatting

**CliResponseParser** (src/flightpath/harness/shared/CliResponseParser.ts):

- Shared parsing utilities (`CliJsonResponse`, `CliUsage` interfaces)
- Common JSON/JSONL response extraction helpers
- Base parsing logic used by provider-specific parsers

**CliToolPermissionMapper** (src/flightpath/harness/shared/CliToolPermissionMapper.ts):

- Core tool permission logic shared across providers
- Handles dangerouslyAllowAll, allowAll, and custom modes
- `ToolPermissionConfig` interface defines the mapping contract

**CliMcpConfigGenerator** (src/flightpath/harness/shared/CliMcpConfigGenerator.ts):

- Centralized, harness-agnostic MCP configuration generation
- `getConfigFilePath()` — single source of truth for file-based MCP config paths (parallel-safe with working file suffix)
- `generateJsonConfig()` — JSON MCP config for FlightPath server only
- `generateJsonConfigWithUserServers()` — merges FlightPath server with user-defined `McpServerConfig` objects
- `generateUserServersOnlyConfig()` — config with only user-defined servers (when FlightPath excluded from mcpServers list)
- `generateInlineTomlConfig()` — inline TOML config for Codex (single-quote escaping for PowerShell)
- Injects `FLIGHTPATH_WORKSPACE`, `FLIGHTPATH_WORKING_FILE`, and dynamic queue env vars

**CliProviderUtils** (src/flightpath/harness/shared/CliProviderUtils.ts):

- Single source of truth for common CLI provider utilities (avoids cross-provider duplication)
- `shouldResumeSession()` — guards against accidental session resume from stale sessionId
- `getWorkspaceDirs()` — collects VS Code workspace folders + `flightpath.cliAdditionalDirs` setting
- `buildMcpConfigBlock()` — shared MCP injection decision logic; checks mcpServers list, extracts user servers, calls provider-specific `getMcpConfigArgs`
- `buildProcessEnv()` — builds process environment with optional `FLIGHTPATH_DIAGNOSTIC_LOGS`
- `buildSettingsJsonMcpEntries()` — builds MCP server entries for settings.json format (Gemini/Qwen); FlightPath server gets `trust: true`

**CliEventMapper** (src/flightpath/harness/shared/CliEventMapper.ts):

- Single source of truth for semantic tool name → CLI event type classification
- Eliminates duplicated switch/if-else chains across parsers (~500 lines consolidated)
- `classifyTool()` — maps any CLI tool name to `ToolClassification` (BASH_COMMAND, FILE_READ, FILE_WRITE, FILE_EDIT, FILE_DELETE, WEB_SEARCH, MCP_TOOL_CALL, TOOL_CALL)
- MCP patterns detected FIRST (before lowercasing) to prevent misclassification of MCP tools named "search"
- Supports MCP formats: `server(tool)` (Copilot), `server__tool` (Codex), `server.tool` / `mcp_*` (Claude)

**SettingsJsonHooksTracker** (src/flightpath/harness/shared/SettingsJsonHooksTracker.ts):

- Manages FlightPath hook injection into settings.json for CLIs that use config-file-based hooks (Qwen, Gemini, Codex)
- Singleton per tool — one instance per CLI tool name
- Reference-counted: tracks hook state per workflow (`registerWorkflow` / `unregisterWorkflow`)
- Captures baseline hooks before any FlightPath modification; restores on last workflow unregister
- Parallel-safe: each concurrent workflow's hooks are preserved until that specific workflow unregisters
- Must be called under `mcpTracker.withLock()` to prevent races (both modify the same settings file)
- Works with `.qwen/settings.json`, `.gemini/settings.json`, or `.codex/hooks.json` (tool-specific subdirectories)

**SettingsJsonMcpTracker** (src/flightpath/harness/shared/SettingsJsonMcpTracker.ts):

- Tracks MCP server lifecycle in settings.json for CLIs that use config-file-based MCP (Gemini, Qwen)
- Singleton per tool with reference counting — servers aren't removed while another workflow needs them
- `captureBaseline()` — lazily captures pre-existing MCP servers from both workspace and home directories; baseline servers are never removed
- `registerServers()` — increments ref counts, only writes new entries to settings.json (skips existing)
- `unregisterWorkflow()` — decrements ref counts, removes zero-ref servers (preserves baseline)
- `getAllowedServerNames()` — returns `--allowed-mcp-server-names` values combining baseline + prompt's servers
- `withLock()` — AsyncMutex-based serialization for all read-modify-write operations on settings.json
- Used by SettingsJsonHooksTracker (hooks) to share the same file lock

**CliExecutionSession** (src/flightpath/harness/shared/CliExecutionSession.ts):

- Immutable value object holding per-prompt execution state: prompt, session ID, temp file paths, start time, parsed output, working file
- Passed through the execution pipeline so coordinators can read/write state without coupling to CliIntegration
- Exposes snapshot via `getSnapshot()` for post-execution result reporting

**CliFailureTracker** (src/flightpath/harness/shared/CliFailureTracker.ts):

- Tracks abnormal execution termination: PTY process exits, exit code classification, and captured PTY tail output
- `getPtyTermination()` — returns exit code if PTY exited unexpectedly (used by CliLogMonitor as `isPtyTerminated` callback)
- `markCompletionDetectionProcessExit(exitCode)` — classifies exit code and returns failure reason message

**CliExecutionRunner** (src/flightpath/harness/shared/CliExecutionRunner.ts):

- Orchestrates interactive and headless execution via injected `CliTransportCoordinator` and `CliInteractiveStartupCoordinator`
- `executeInteractive(session, baseArgs)` — runs terminal session, monitors log file, handles session ID extraction
- `executeHeadless(session, baseArgs)` — runs background process, retries on recoverable Claude session errors
- Delegates log monitoring to `CliLogMonitor` and response collection to `CliResponseCollector`
- Stateless orchestrator: all mutable state lives in `CliExecutionSession`

**CliInteractiveStartupCoordinator** (src/flightpath/harness/shared/CliInteractiveStartupCoordinator.ts):

- Resolves interactive session startup: discovers log file and extracts session ID
- Three strategies: resumed session (direct log file lookup), SessionStart hook (waits for hook then discovers log), no SessionStart (log file discovery by prompt text matching)
- Polls abort state at 100ms intervals — cancellation or PTY exit during startup returns `null` to abort execution
- Session start timeout: 60 seconds

**CliPromptPreparer** (src/flightpath/harness/shared/CliPromptPreparer.ts):

- Assembles the full prompt string and creates categorized temp files for agent instructions, skills, context, excerpts, and prompt text
- Handles simple prompt fast path (no extras → direct inline), pure slash commands (bypass assembly), and complex prompts with prior context
- Uses `PromptFileSplitter` to chunk large content; uses `TempFileManager` for categorized temp file creation
- Returns `{ promptWithInstruction, tempFilePaths }` consumed by CliIntegration

**CliPromptRuntimeCoordinator** (src/flightpath/harness/shared/CliPromptRuntimeCoordinator.ts):

- Persists `_runtime` metadata (harness, model, agent, sessionId, startedAt, completedAt) onto `PromptItem` and writes it to the working file
- `persistSuccessfulPromptRuntime()` — called after successful execution; merges session ID into `UniversalCliOutput` if missing
- `persistCancelledPromptRuntime()` — called after cancellation; saves partial metadata (startedAt, sessionId if known)

**CliResponseCollector** (src/flightpath/harness/shared/CliResponseCollector.ts):

- Collects a headless execution result: calls `responseParser.parse()`, optionally `provider.augmentParsedOutput()`, extracts session ID (from output or log fallback), formats statistics
- Returns `CollectedHeadlessResponse` with `{ success, parsedOutput, cliResult, extractedSessionId }`
- Calls `hostCallbacks.logResponse()` and `hostCallbacks.onResponseComplete()` after collection

**CliResponseTextExtractor** (src/flightpath/harness/shared/CliResponseTextExtractor.ts):

- Pure function `extractTextFromEvents(output)` — iterates `UniversalCliOutput.events` and assembles a human-readable text string
- Handles TEXT, THINKING, FILE_WRITE, FILE_EDIT (with +/- line counts from structuredPatch), FILE_DELETE event types
- Used by both `CliResponseCollector` and interactive-mode response assembly

**CliSessionResolverAdapter** (src/flightpath/harness/shared/CliSessionResolverAdapter.ts):

- Thin adapter wrapping `PropertyResolver.resolve()` and `SessionResolver.resolve()` with per-harness session ID validation
- `resolve(prompt, workflowContext)` — returns `{ resolvedProperties, resolvedSessionId }`
- Validates session ID format via `SessionValidator.validate(id, harness)`; resets to `undefined` if invalid (logs warning)

**CliTransportCoordinator** (src/flightpath/harness/shared/CliTransportCoordinator.ts):

- Handles the low-level process lifecycle: terminal creation, PTY spawning, headless subprocess spawning, cancellation
- `startInteractiveProcess()` — spawns PTY session (if `PtyProcessManager` available) or VS Code terminal with shell integration; injects `FLIGHTPATH_RUN_ID` and `FLIGHTPATH_NOTIFY_DIR` env vars
- `executeStandaloneInteractiveProcess()` — standalone interactive process (CLI binary mode, no VS Code terminal)
- `executeHeadless()` — spawns headless process with optional streaming via `responseParser.processStreamingChunk()`
- `cancel()` — kills PTY session or cancels VS Code terminal shell execution
- `dispose(closeTerminalWhenPromptCompletes)` — cleans up terminal/process resources

**Interfaces** (src/flightpath/harness/shared/interfaces/):

- ICliProvider.ts: Main provider contract
- IResponseParser.ts: Output parsing interface
- INotificationMonitor.ts: Completion detection and hook configuration interface
- IToolPermissionMapper.ts: Permission mapping interface
- ILogParser.ts: Log file monitoring interface
- index.ts: Barrel export for all interfaces

**INotificationMonitor key types**:

- `HookConfig`: Union type — `{ type: "json"; config: object }` (Copilot/Qwen/Gemini/Codex: JSON object) | `{ type: "json-string"; config: string }` (Claude: JSON string) | `{ type: "none" }` (OpenCode)
- `buildHookConfig(scriptPath, notifyDir, workspaceRoot, userHooks?)` — builds hook config with optional user-defined hooks merged alongside FlightPath completion-detection hooks
- `waitForSessionStart?(config, startTime, runId?, onCancel?)` — optional method for providers that support session start detection

**Note**: These utilities contain NO provider-specific logic. All harness-specific behavior lives in provider directories.
</sharedUtilities>

<userDefinedHooks>
**User-Defined Hooks** — all harnesses inject user hooks alongside FlightPath's built-in completion-detection hooks.

**Architecture**: Each provider's `INotificationMonitor.buildHookConfig()` accepts an optional `userHooks` parameter. User hooks are defined in prompt files and forwarded through `WorkflowContext`.

**Three injection patterns** based on CLI capabilities:

1. **Per-prompt files** (Copilot, Claude): Each prompt execution creates its own hook file with FlightPath + user hooks merged. No conflicts in parallel workflows.
   - Copilot: `.github/hooks/flightpath-<stem>-p<N>.json` (auto-discovered by CLI)
   - Claude: `.flightpath/temp/claude-hook-settings-<stem>-p<N>.json` (passed via `--settings`)

2. **Settings.json with ref-counting** (Gemini, Qwen, Codex): Hooks written to `.{tool}/settings.json` (or `.codex/hooks.json` for Codex) via `SettingsJsonHooksTracker`. Reference-counted for parallel safety — baseline captured before modification, restored when last workflow unregisters. Must acquire `SettingsJsonMcpTracker.withLock()` since both hooks and MCP share the same file.
   - Gemini/Qwen: no pre-trust needed for hook commands (auto-trusted via `~/.{tool}/trusted_hooks.json`)
   - Codex: no trusted_hooks.json — `--enable codex_hooks` flag bypasses approval prompts

3. **Plugin/chain generation** (OpenCode):
   - OpenCode: `OpenCodePluginGenerator` embeds user hooks directly in generated completion plugin

**Pre-trust mechanisms** (Gemini, Qwen): Both auto-approve FlightPath hook commands by writing entries to `~/.{tool}/trusted_hooks.json` with colon-prefixed key format (`:${command}`). Prevents interactive approval prompts during automated workflow execution. Codex does not need pre-trust — the `--enable codex_hooks` flag is sufficient.

**Event mapping**: Each provider maps generic hook events to CLI-native event names:

- `stop` → Copilot: `sessionEnd`, Claude: `Stop`, Gemini: `AfterAgent`, Qwen: `Stop`
- `sessionStart` → all: respective native `SessionStart` / `sessionStart`
- Claude/Qwen additionally support: `preToolUse`, `postToolUse`
- Qwen additionally supports: `userPromptSubmit`
  </userDefinedHooks>

<importantNotes>
1. **Composition over inheritance**: Providers use "has-a" not "is-a" relationships
2. **Zero core changes**: Adding providers NEVER requires modifying CliIntegration or shared utilities
3. **Fresh terminal every time**: Interactive mode always disposes old terminal and creates new one
4. **Session continuity via flags**: --resume flag for session continuity, NOT terminal reuse
5. **Adaptive prompt passing**: Simple prompts (<300 chars) passed directly, complex prompts via file
6. **TUI completion uses execution.read()**: Stable API, not proposed onDidWriteTerminalData
7. **Tool permissions are shared**: Single source of truth in settings, mapped per-CLI via provider's IToolPermissionMapper and CliToolPermissionMapper base
8. **MCP for dynamic queue**: Optional feature, only enabled when flightpath.enableDynamicQueue is true
9. **Log parsing is provider-specific**: Each provider has a `*LogParser.ts` extending `BaseLogParser` for format-specific log monitoring
10. **Streaming is provider-specific**: Provider.config.shouldStreamHeadlessOutput controls buffering vs streaming
11. **Chrome filtering varies**: Each provider defines unique TUI patterns in config.chromePatterns
12. **Provider isolation**: Each provider directory is self-contained - no cross-provider dependencies
13. **Interface contracts**: TypeScript interfaces (ICliProvider, IResponseParser, ILogParser, etc.) prevent implementation mistakes
14. **Testable components**: Provider components testable in isolation without mocking
15. **All integrations instantiated eagerly**: WorkflowOrchestrator creates all 7 integrations at startup (not lazy/on-demand)
16. **CliTerminalFormatter is NOT here**: It lives in `src/cli/CliTerminalFormatter.ts` — it is strictly a FlightPath CLI binary display helper, not a harness utility
17. **User hooks are cross-cutting**: All 6 CLI providers inject user-defined hooks alongside FlightPath completion-detection hooks; three injection patterns (per-prompt files, settings.json ref-counting, plugin/chain generation)
18. **Settings.json trackers are parallel-safe**: SettingsJsonHooksTracker and SettingsJsonMcpTracker use AsyncMutex + ref-counting for concurrent workflow execution (Gemini, Qwen, Codex). Codex uses SettingsJsonMcpTracker solely as a mutex provider (Codex MCP uses inline TOML, not settings.json).
19. **ToolBuilder pattern**: Most providers have a `*ToolBuilder.ts` that converts raw tool call payloads into structured `CliEvent` objects, enabling code reuse between LogParser and ResponseParser. OpenCode uses `OpenCodeEventMapper.ts` instead (no ToolBuilder).
20. **CliEventMapper centralizes tool classification**: Single source of truth mapping tool names to semantic types (BASH_COMMAND, FILE_EDIT, MCP_TOOL_CALL, etc.) — replaces ~500 lines of duplicated switch/case
21. **CliIntegration composes 5 coordinators**: CliPromptPreparer, CliSessionResolverAdapter, CliPromptRuntimeCoordinator, CliTransportCoordinator, and CliExecutionRunner — each has a single responsibility and is independently testable
22. **Permission/hook dispatch on ICliProvider**: `buildPermissionArgs?()`, `buildNotificationHookArgs?()`, and `buildHeadlessUserHookArgs?()` are optional ICliProvider methods called by CliIntegration at the integration layer — hooks and permissions are no longer embedded inside `buildCliArgs()`
23. **Headless user hooks supported on all providers**: `buildHeadlessUserHookArgs?()` enables user-defined hooks in headless mode (not just interactive); providers that support it implement this method on ICliProvider
</importantNotes>
