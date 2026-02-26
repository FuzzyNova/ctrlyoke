---
applyTo: "src/flightpath/cli/**"
---

<purpose>
CLI integrations for GitHub Copilot, Claude Code, and Codex. Deterministic completion, structured output, no UI dependencies. Supports both interactive TUI and headless background execution modes.
</purpose>

<architectureOverview>
**Composition-based architecture** (as of January 2026):

FlightPath uses **composition over inheritance** for CLI integrations. This makes adding new CLI providers (Gemini, OpenCode, etc.) simple and safe:

- **Single generic integration class** (`CliIntegration`) works with ALL providers
- **Harness-specific logic** encapsulated in provider directories (copilot/, claude/, codex/)
- **Zero core class modifications** needed when adding new providers
- **Interface-driven design** (TypeScript guides implementation)
- **Testable components** (no mocking needed, pure logic)

### Why Composition Over Inheritance?

**Before (Inheritance)**: Adding a provider meant:

1. Creating a subclass of BaseCliIntegration
2. Implementing 15+ abstract methods
3. Modifying 3-4 shared utility classes
4. High risk of breaking existing providers

**After (Composition)**: Adding a provider means:

1. Creating 4 focused classes in a new directory
2. Implementing 4 clear interfaces
3. ZERO modifications to core classes or other providers
4. Complete isolation from existing providers

See: `docs/ADDING_NEW_CLI_PROVIDER.md` for step-by-step guide
</architectureOverview>

<coreComponents>
**CliIntegration** (src/flightpath/cli/CliIntegration.ts):
- Generic integration class that works with ANY provider
- Delegates all provider-specific behavior to ICliProvider instance
- Handles execution lifecycle (interactive/headless modes)
- Manages session continuity, cancellation, and status updates
- **Never needs modification** when adding new providers

**ICliProvider Interface** (src/flightpath/cli/shared/interfaces/ICliProvider.ts):

- Main provider contract - defines what a CLI provider must implement
- Includes: config (metadata), responseParser, notificationMonitor, toolPermissionMapper
- Methods: buildHeadlessArgs(), buildInteractiveTuiCommand(), formatFileReference(), getMcpConfigArgs(), checkAvailability()
- Compose 4 sub-interfaces: IResponseParser, INotificationMonitor, IToolPermissionMapper, HarnessConfig
  </coreComponents>

<providerStructure>
Each provider is self-contained in its own directory with 5 required files:

```
src/flightpath/cli/copilot/
├── CopilotCliProvider.ts          # Main provider descriptor (implements ICliProvider)
├── CopilotResponseParser.ts       # Implements IResponseParser (parse output, extract tokens)
├── CopilotNotificationMonitor.ts  # Implements INotificationMonitor (completion detection)
├── CopilotToolPermissionMapper.ts # Implements IToolPermissionMapper (permission args)
└── CopilotLogParser.ts            # Implements ILogParser (log file monitoring/session ID)
```

**CopilotCliProvider.ts** (main provider class):

- Aggregates all 4 components (config, parser, monitor, mapper)
- Implements provider-specific CLI argument building
- Defines TUI patterns (escapeIndicator, chromePatterns, screenEndPattern)
- Handles file reference formatting (@file for Copilot)
- Generates MCP configuration (if supported)

**CopilotResponseParser.ts**:

- Parses CLI output (stdout/stderr) into structured result
- Extracts session IDs from output/logs
- Parses token counts for dashboard display
- Processes streaming chunks for real-time display (optional)

**CopilotNotificationMonitor.ts**:

- Configures hook/notification scripts (sessionEnd, Stop, notify)
- Monitors for completion events (file-based polling)
- Extracts session IDs from notifications (if available)
- Handles both specific file and wildcard monitoring modes

**CopilotToolPermissionMapper.ts**:

- Converts FlightPath tool permissions to CLI-specific arguments
- Implements dangerouslyAllowAll, allowAll, and custom modes
- Handles allow/deny pattern translation
- Determines if full permissions granted (no prompts)

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
- Called by FlightPathManager.stop() when user presses stop button

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

- `flightpath.harness`: "copilot-cli" | "claude-cli" | "codex-cli" | "copilot-chat"
- `flightpath.cliExecutionMode`: "interactive" | "headless" (default: interactive)

**Models** (per provider):

- `flightpath.copilotCliModel`: "claude-sonnet-4.5" | "gpt-5" | etc.
- `flightpath.claudeCliModel`: "sonnet" | "opus" | "haiku"
- `flightpath.codexCliModel`: "gpt-5.1-codex" | "gpt-5.1-codex-max" | etc.

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
**FlightPathManager** instantiates ALL integrations eagerly at startup, then routes execution to the active harness:

```typescript
// FlightPathManager.ts — all integrations created upfront
this.copilotCliIntegration = new CliIntegration(
  new CopilotCliProvider(),
  this.context
);
this.claudeCliIntegration = new CliIntegration(
  new ClaudeCliProvider(),
  this.context
);
this.codexCliIntegration = new CliIntegration(
  new CodexCliProvider(),
  this.context
);
this.chatIntegration = new CopilotChatIntegration(this.context);

// Harness availability checked for all integrations; active one selected via
// flightpath.harness setting using HARNESS_IDS constants.
```

**Key benefit**: Adding new provider only requires:

1. Creating provider class (e.g., GeminiCliProvider)
2. Instantiating `new CliIntegration(new GeminiCliProvider(), ...)` alongside the others
3. Adding HARNESS_IDS entry and package.json enum value
4. NO modifications to CliIntegration or shared utilities

See: `docs/ADDING_NEW_CLI_PROVIDER.md` for complete guide
</factoryPattern>

<addingNewProviders>
**To add a new CLI provider** (e.g., Gemini, OpenCode):

1. Create provider directory: `src/flightpath/cli/gemini/`
2. Implement 5 required classes:
   - GeminiCliProvider.ts (implements ICliProvider)
   - GeminiResponseParser.ts (implements IResponseParser)
   - GeminiNotificationMonitor.ts (implements INotificationMonitor)
   - GeminiToolPermissionMapper.ts (implements IToolPermissionMapper)
   - GeminiLogParser.ts (extends BaseLogParser, implements ILogParser)
3. Instantiate alongside other integrations in FlightPathManager
4. Add HARNESS_IDS entry and settings to package.json (model, harness enum value)
5. Test with manual-test workflows

**No modifications needed to**:

- CliIntegration.ts (generic class)
- Shared utilities (CliNotificationMonitor, CliResponseParser, CliToolPermissionMapper, etc.)
- Other provider directories (copilot/, claude/, codex/)
- Core interfaces (ICliProvider, IResponseParser, etc.)

See: `docs/ADDING_NEW_CLI_PROVIDER.md` for detailed step-by-step guide with code templates
</addingNewProviders>

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

**Manual test files**: `manual-test/*.flightpath.json`
**Unit tests**: `src/test/suite/flightpath-cli.test.ts`
</testingProviders>

<providerSpecifics>
### Copilot CLI (CopilotCliProvider)

**Completion Detection**:

- **Headless**: Process exit (deterministic)
- **Interactive**: sessionEnd hook (writes JSON to `.flightpath/temp/copilot-notifications/`)
- **Hook format**: `.github/hooks/flightpath.json` with bash/powershell fields
- **Monitoring**: Wildcard mode (any new file in directory triggers completion)
- **Session ID**: Extracted from log files (hook doesn't provide session ID)

**Output Format**: Plain text with statistics on stderr
**Tool Permissions**: `--allow-all-tools`, `--allow-tools`, `--deny-tools` with Copilot-specific patterns
**File Reference**: `@path/to/file.ts`
**MCP Config**: `--additional-mcp-config @file` with JSON format
**Models**: Dynamic via `copilot help config` (claude-sonnet-4.5, gpt-5, etc.)

**Log Requirements**: `--log-level debug` required for session ID extraction

**See**: CopilotCliProvider.ts, CopilotNotificationMonitor.ts

---

### Claude CLI (ClaudeCliProvider)

**Completion Detection**:

- **Headless**: JSON events in stream-json output
- **Interactive**: Stop hook (writes JSON to `.flightpath/temp/claude-notifications/{thread-id}.json`)
- **Hook format**: JSON string passed via `--stop-hook` flag
- **Monitoring**: Specific file mode (uses thread ID from initial output)
- **Session ID**: Extracted from JSON `thread_id` field

**Output Format**: JSON streaming (`--stream-json` required)
**Tool Permissions**: `--dangerously-skip-permissions`, `--tools default`, tool-specific allows/denies
**File Reference**: `path/to/file.ts` (no @ prefix)
**MCP Config**: Not supported (no MCP integration in Claude CLI)
**Models**: Aliases (sonnet, opus, haiku) with `--model` flag

**Session Resumption**: `-c` (continue last) or `-r <thread-id>` (resume specific)

**See**: ClaudeCliProvider.ts, ClaudeNotificationMonitor.ts, ClaudeResponseParser.ts

---

### Codex CLI (CodexCliProvider)

**Completion Detection**:

- **Headless**: JSONL events (`{"type":"turn.completed"}`)
- **Interactive**: notify hook (writes JSON to `~/.flightpath/codex-notifications/{thread-id}.json`)
- **Hook format**: TOML-style inline config `notify='["node","<script>"]'`
- **Monitoring**: Specific file mode (thread ID from initial output) with wildcard fallback
- **Session ID**: Extracted from JSONL events or notify hook data

**Output Format**: JSONL streaming (one JSON object per line)
**Tool Permissions**: Same as Copilot (auto-converted from shared settings)
**File Reference**: `-f path/to/file.ts`
**MCP Config**: Not supported
**Models**: GPT-5 variants (gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.2)

**Session Resumption**: `--resume <thread-id>`

**See**: CodexCliProvider.ts, CodexNotificationMonitor.ts, CodexResponseParser.ts, `docs/CODEX_CLI_INTEGRATION.md`

</providerSpecifics>

<sharedUtilities>
**Truly shared utilities** (provider-agnostic, no CLI-specific logic):

**BaseLogParser** (src/flightpath/cli/shared/BaseLogParser.ts):

- Abstract base class implementing ILogParser
- Common log file monitoring (polling, line tracking)
- Provider subclasses extend this for format-specific parsing

**CliNotificationMonitor** (src/flightpath/cli/shared/CliNotificationMonitor.ts):

- Shared notification/hook file monitoring
- Supports both specific-file and wildcard polling modes
- Extracts completion events and session IDs from hook output

**CliOutputFormatter** (src/flightpath/cli/shared/CliOutputFormatter.ts):

- Formats CLI responses for the Output panel and dashboard
- Structures `DashboardOutput` (text, tokens, statistics)
- Provider-agnostic display formatting

**CliResponseParser** (src/flightpath/cli/shared/CliResponseParser.ts):

- Shared parsing utilities (`CliJsonResponse`, `CliUsage` interfaces)
- Common JSON/JSONL response extraction helpers
- Base parsing logic used by provider-specific parsers

**CliToolPermissionMapper** (src/flightpath/cli/shared/CliToolPermissionMapper.ts):

- Core tool permission logic shared across providers
- Handles dangerouslyAllowAll, allowAll, and custom modes
- `ToolPermissionConfig` interface defines the mapping contract

**CliMcpConfigGenerator** (src/flightpath/cli/shared/CliMcpConfigGenerator.ts):

- MCP configuration JSON generation
- Template-based config creation
- Provider-agnostic (caller specifies provider-specific fields)

**Interfaces** (src/flightpath/cli/shared/interfaces/):

- ICliProvider.ts: Main provider contract
- IResponseParser.ts: Output parsing interface
- INotificationMonitor.ts: Completion detection interface
- IToolPermissionMapper.ts: Permission mapping interface
- ILogParser.ts: Log file monitoring interface
- index.ts: Barrel export for all interfaces

**Note**: These utilities contain NO provider-specific logic. All CLI-specific behavior lives in provider directories.
</sharedUtilities>

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
15. **All integrations instantiated eagerly**: FlightPathManager creates all 4 integrations at startup (not lazy/on-demand)
</importantNotes>
