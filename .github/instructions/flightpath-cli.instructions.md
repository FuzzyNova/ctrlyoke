---
applyTo: "src/flightpath/cli/**"
---

<purpose>
CLI integrations for GitHub Copilot, Claude Code, and Codex. Deterministic completion, structured output, no UI dependencies. Supports both interactive TUI and headless background execution modes.
</purpose>

<baseClass>
**BaseCliIntegration**: Abstract base class for all CLI integrations
- Extends `CopilotIntegration` from base layer
- Provides common execution modes (interactive TUI and headless)
- Handles session management, process lifecycle, and cancellation
- Delegates to `CliProcessManager` for spawning/terminal/cancellation
- Delegates to `TuiStreamProcessor` for TUI output streaming and completion detection
- Delegates CLI-specific details to subclasses via abstract methods
- Three concrete implementations:
  - CopilotCommandLineIntegration (GitHub Copilot CLI)
  - ClaudeCommandLineIntegration (Claude Code CLI)
  - CodexCommandLineIntegration (Codex CLI)
</baseClass>

<architecture>
**Two execution modes:** Interactive (TUI) and headless (background)
**Adaptive prompt passing:** Simple (≤300 chars) direct on CLI, complex via temp file with "Follow instructions in @file" prefix
**Session continuity:** `--resume <id>` flags (NOT terminal reuse)
**Token parsing:** Extracts counts for dashboard display (format varies per CLI)

<executionModes>
**Interactive:** Fresh terminal per prompt, TUI injection via `terminal.sendText()`, TuiStreamProcessor for streaming/completion, user sees output
**Headless:** Background process with stdio pipes, prompt via file/CLI arg, optional streaming, tool permissions required

<sessionManagement>
Session ID extracted from logs/JSON, persists across prompts. `newChatSession: false` adds resume flags (`--resume <id>`, `-r <id>`, etc.). Claude uses `-c` to continue if no ID.

<abstractMethods>
Subclasses implement: `getCliName()`, `getEscapeIndicator()`, `getScreenEndPattern()`, `getTuiChromePatterns()`, `buildHeadlessArgs*()`, `formatFileReference()`, `hasFullPermissions()`, `parseTokenCounts()`, `getMcpConfigArgs()`

Optional overrides: `shouldStreamHeadlessOutput()` (false for JSON/JSONL), `processStreamingChunk()` (extract from structured output)

<cancellation>
**cancel() method:**
- Interactive: Sends Ctrl+C (`\x03`) to terminal via `processManager.sendCtrlC()`
- Headless: Kills the CLI process via `processManager.killProcess()`
- Cleans up completion detection listeners (abort controller for TUI read)
- Platform-agnostic: SIGTERM on Unix, terminates on Windows
- Clears process/execution reference after cancel
- Called by FlightPathManager.stop() when user presses stop button

**Process lifecycle:**

- `currentProcess` (headless) or `currentExecution` (interactive) set when starting
- Cleared automatically on process/command close
- Cleared immediately on cancel()
- Delegates actual process/terminal management to `CliProcessManager`
  </cancellation>

<differenceFromChat>
- No timing delays or UI automation polling
- Direct response text access via stdout (not clipboard-based)
- No tool instruction XML needed (deterministic completion via process exit or escape indicator)
- Structured output: Response + statistics separated by delimiters or JSON structure
- Stop = kill process/send Ctrl+C vs Chat = cancel chat command
- Real-time streaming via `execution.read()` (interactive) or stdout chunks (headless)
- Completion detection: Escape indicator disappearing (interactive) or process exit (headless)
</differenceFromChat>

<configuration>
Key settings: `cliExecutionMode`, `*CliModel` (per provider), `cliToolPermissions` (shared), `cliAllowedTools/DeniedTools` (shared, Copilot format auto-converted)
See package.json for full list.

<copilotCompletion>
**Copilot CLI Completion Detection** (CopilotCommandLineIntegration):

**Headless Mode**: Process completion is deterministic (exit code based). Session ID extracted from log files.

**Interactive TUI Mode**: Uses Copilot's **sessionEnd hook** for reliable completion detection (as of 2026-01):

- Creates: `.github/hooks/flightpath.json` with sessionEnd hook configuration
- Hook format: Includes both `bash` and `powershell` fields for cross-platform support (Windows uses powershell)
- Script: `out/scripts/flightpath-copilot-hook.js` writes `completion-{timestamp}.json` to notification directory
- Monitors: Wildcard mode - detects ANY new file in `.flightpath/temp/copilot-notifications/`
- Timeout: 10 seconds for hook execution
- **Important**: Copilot CLI hooks do NOT provide session ID - hook data only contains `{timestamp, cwd, reason}`
- Benefits: Future-proof (official API), won't break with TUI output format changes
- Monitoring delegated to `CliNotificationMonitor` shared utility (wildcard mode)

**Session ID Tracking**: Both modes use log-based extraction - reads `process-{timestamp}-{pid}.log` files for "Flushed X events to session {GUID}". Requires `--log-level debug`. Hooks do NOT provide session ID.

**Previous approach** (deprecated for interactive mode): Relied solely on TUI output parsing and log file monitoring. Hook approach is cleaner and more reliable.
</copilotCompletion>

<codexCompletion>
**Codex CLI Completion Detection** (CodexCommandLineIntegration):

**Headless Mode**: Uses JSONL events (`{"type":"turn.completed"}`) - deterministic, no special handling needed.

**Interactive TUI Mode**: Uses Codex's **notify hook** for reliable completion detection:

- Configures: `--config notify='["node","<script-path>"]'`
- Script: `out/scripts/flightpath-codex-notify.js` writes completion event to file
- Monitors: `~/.flightpath/codex-notifications/{thread-id}.json`
- Fallback: If no thread ID, monitors directory for any new `.json` files
- Benefits: Future-proof (official API), won't break with log format changes
- Monitoring delegated to `CliNotificationMonitor` shared utility

**Previous approach** (deprecated): Parsed `~/.codex/log/codex-tui.log` for patterns like `INFO run_task: close`. Broke when Codex changed log format.

See: `docs/CODEX_COMPLETION_DETECTION.md` for full implementation details.
</codexCompletion>

<sharedUtilities>
CliProcessManager, TuiStreamProcessor, CliResponseParser, CliToolPermissionMapper, CliMcpConfigGenerator, CliNotificationMonitor, TempFileManager
See individual utility files for details.

<cliSpecificDetails>
Copilot: sessionEnd hook (interactive), log-based session tracking (headless fallback), plain text stats
Claude: stream-json, JSON events, Stop hook, model aliases (sonnet/opus/haiku)
Codex: JSONL, notify hook completion, 5 GPT models
See source files for full details.

<importantNotes>
1. **NO stdin usage**: Stdin approach deprecated, all CLIs use temp file or direct prompt passing
2. **Fresh terminal every time**: Interactive mode always disposes old terminal and creates new one
3. **Session continuity via flags**: --resume flag for session continuity, NOT terminal reuse
4. **Adaptive prompt passing**: Simple prompts (<300 chars) passed directly, complex prompts via file
5. **TUI completion uses execution.read()**: Stable API, not proposed onDidWriteTerminalData
6. **Tool permissions are shared**: Single source of truth in settings, mapped per-CLI via CliToolPermissionMapper
7. **MCP for dynamic queue**: Optional feature, only enabled when flightpath.enableDynamicQueue is true
8. **Cancellation delegated**: Process/terminal cancellation handled by CliProcessManager
9. **Streaming is optional**: Subclasses can override shouldStreamHeadlessOutput() to buffer instead
10. **Chrome filtering varies**: Each CLI has unique TUI patterns that must be filtered
</importantNotes>
