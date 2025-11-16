---
applyTo: "src/flightpath/cli/**"
---

<purpose>
Default integration using GitHub Copilot CLI. Deterministic completion, no UI dependencies.
</purpose>

<architecture>
- `copilot` command blocks until complete (no polling)
- Process exit = completion signal
- Stdout mixed: response + statistics (parse via delimiter detection)
- Session support: `--resume-session <id>` for multi-turn conversations
- Process tracking: Stores `currentProcess` reference for cancellation
</architecture>

<cancellation>
**cancel() method:**
- Kills the running CLI process via `child.kill()`
- Platform-agnostic: Sends SIGTERM on Unix, terminates on Windows
- Clears process reference after kill
- Called by FlightPathManager.stop() when user presses stop button

**Process lifecycle:**

- `currentProcess` set when spawning copilot CLI
- Cleared automatically on process close
- Cleared immediately on cancel()
  </cancellation>

<differenceFromChat>
- No timing delays or UI automation
- Direct response text access (not clipboard-based)
- No tool instruction XML needed (deterministic completion)
- Structured output (response + statistics separated)
- Stop = kill process vs stop = cancel chat command
</differenceFromChat>

<configuration>
- `copilotCliModel`: AI model selection
- `copilotCliAllowedDirs`: Additional accessible directories
- `copilotCliToolPermissions`: Tool access control
- `showCliOutput`: Output panel visibility
</configuration>
