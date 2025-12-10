---
applyTo: "src/flightpath/cli/**"
---

<purpose>
Default integration using GitHub Copilot CLI. Deterministic completion, no UI dependencies.
</purpose>

<architecture>
- Two execution modes: **interactive** (TUI injection) and **headless** (spawn + stdin)
- Interactive: Creates fresh terminal, starts CLI, sends prompt via `terminal.sendText()`, detects completion
- Headless: Spawns CLI with stdin pipe, writes prompt to stdin, waits for process exit
- Process exit = completion signal (headless), escape indicator disappearing = completion (interactive)
- Stdout: response + statistics (parse via delimiter detection)
- Session support: `--resume <id>` for multi-turn conversations (handled via CLI flags, not terminal reuse)
- Process tracking: `currentProcess` (headless) or `currentExecution` (interactive)
- **Token parsing**: Extracts token counts from statistics output for dashboard display
  - Copilot CLI: "25.7k input, 223 output" (format as of Dec 2025)
  - Claude CLI: "1234 input + 5678 output"
  - Dashboard displays: "📊 Tokens: X prompt / Y completion"
</architecture>

<executionModes>
**Interactive Mode (TUI Injection):**
- **Always creates fresh terminal** for each prompt execution
- Old terminal disposed before starting new CLI (session resume via `--resume` flag, not terminal reuse)
- Starts CLI in interactive TUI mode (no -p flag, no prompt on command line)
- Waits for TUI to be ready (escape indicator appears)
- Sends prompt via `terminal.sendText()` - works for ANY prompt length!
- Detects completion by watching for escape indicator to disappear
  - Copilot: "(esc to cancel)" 
  - Claude: "(esc to interrupt)"
- User can see output in real-time, Ctrl+C aborts immediately
- **No tool permission flags**: User interactively approves/denies tools through TUI

**Headless Mode (stdin):**

- Spawns CLI process with `stdio: ['pipe', 'pipe', 'pipe']`
- Writes prompt to stdin, then closes stdin
- No shell escaping issues, works for any prompt size
- Copilot: No -p flag needed (reads stdin when not a TTY)
- Claude: Requires -p flag (Ink TUI crashes without it)
- Warning shown if running without full permissions (auto-deny behavior)
- **Tool permission flags applied**: Automation requires explicit tool/path configuration
  </executionModes>

<sessionManagement>
**Session continuity** is handled via CLI resume flags, NOT terminal reuse:
- Session ID extracted from CLI logs (Copilot) or JSON response (Claude)
- Session ID persists at integration level across prompt executions
- When `prompt.newChatSession === false && sessionId` exists: adds `--resume <id>` (Copilot) or `-r <id>` (Claude)
- When `prompt.newChatSession === false` but no session ID: Claude uses `-c` (continue most recent)
- When `prompt.newChatSession === true` (default): fresh session started, no resume flag

**Single-prompt workflows**:

- Session ID persists between executions
- If global setting `newChatSessionPerPrompt: false`, subsequent single prompts will resume previous session
  </sessionManagement>

<abstractMethods>
Subclasses must implement:
- `getCliName()`: Returns "copilot" or "claude"
- `getEscapeIndicator()`: Pattern that appears during generation, disappears when complete
- `buildHeadlessArgs(baseArgs)`: Args for headless mode (Copilot: no -p, Claude: with -p)
- `buildInteractiveTuiCommand(baseArgs)`: Command to start interactive TUI
- `hasFullPermissions()`: Check if headless mode will auto-grant permissions
- `parseTokenCounts(statistics)`: Extract token counts from CLI statistics output
  - Returns `{ prompt: number; completion: number } | undefined`
  - Handles CLI-specific output formats (k suffix, decimal numbers, etc.)
  - Used by WorkflowExecutor to populate dashboard token display
</abstractMethods>

<cancellation>
**cancel() method:**
- Interactive: Sends Ctrl+C (`\x03`) to terminal, cleans up completion detection listeners
- Headless: Kills the CLI process via `child.kill()`
- Platform-agnostic: Sends SIGTERM on Unix, terminates on Windows
- Clears process/execution reference after cancel
- Called by FlightPathManager.stop() when user presses stop button

**Process lifecycle:**

- `currentProcess` (headless) or `currentExecution` (interactive) set when starting
- Cleared automatically on process/command close
- Cleared immediately on cancel()
  </cancellation>

<differenceFromChat>
- No timing delays or UI automation polling
- Direct response text access (not clipboard-based)
- No tool instruction XML needed (deterministic completion)
- Structured output (response + statistics separated)
- Stop = kill process/send Ctrl+C vs stop = cancel chat command
</differenceFromChat>

<configuration>
- `cliExecutionMode`: Interactive (TUI) vs headless (background)
- `copilotCliModel`: AI model selection
- `copilotCliAllowedDirs`: Additional accessible directories
- `copilotCliToolPermissions`: Tool access control
- `showCliOutput`: Output panel visibility
</configuration>
