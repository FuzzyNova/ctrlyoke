---
applyTo: "src/flightpath/cli/**"
---

<purpose>
Default integration using GitHub Copilot CLI. Deterministic completion, no UI dependencies.
</purpose>

<architecture>
- Two execution modes: **interactive** (terminal) and **headless** (spawn)
- Interactive: Uses VS Code Shell Integration API for streaming + completion detection
- Headless: `copilot` command blocks until complete (no polling)
- Process exit = completion signal
- Stdout mixed: response + statistics (parse via delimiter detection)
- Session support: `--resume-session <id>` for multi-turn conversations
- Process tracking: Stores `currentProcess` (headless) or `currentExecution` (interactive)
</architecture>

<executionModes>
**Interactive Mode (default):**
- Opens VS Code terminal with shell integration
- User can see output in real-time
- Ctrl+C in terminal aborts immediately
- Prompt passed via `-p JSON.stringify(prompt)` (no stdin in terminal API)
- Uses `shellIntegration.executeCommand(cli, args)` for proper arg escaping

**Headless Mode:**

- Runs in background process via `spawn()`
- Prompt passed via stdin (cleaner, no escaping needed)
- Exception: agents require `-p` flag even in headless mode
- Warning shown if running without full permissions (auto-deny behavior)
  </executionModes>

<cancellation>
**cancel() method:**
- Interactive: Sends Ctrl+C (`\x03`) to terminal
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
- No timing delays or UI automation
- Direct response text access (not clipboard-based)
- No tool instruction XML needed (deterministic completion)
- Structured output (response + statistics separated)
- Stop = kill process/send Ctrl+C vs stop = cancel chat command
</differenceFromChat>

<configuration>
- `cliExecutionMode`: Interactive (terminal) vs headless (background)
- `copilotCliModel`: AI model selection
- `copilotCliAllowedDirs`: Additional accessible directories
- `copilotCliToolPermissions`: Tool access control
- `showCliOutput`: Output panel visibility
</configuration>
