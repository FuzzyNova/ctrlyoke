---
applyTo: "src/cli.ts,src/cli/**"
---

<purpose>
The standalone FlightPath CLI binary. Invoked as `flightpath run <file>` or `flightpath validate <file>` from the terminal. This is a separate Node.js executable built by esbuild, distinct from the VS Code extension. It uses the same core engine (WorkflowInstance, PromptQueue, harness integrations) but bridges them through a CLI adapter instead of the VS Code API.
</purpose>

<architecture>

## Key Relationships

```
src/cli.ts (Commander entry point)
    → src/platform/CliAdapter.ts           (PlatformAdapter for CLI — maps CLI flags to settings)
    → src/platform/vscode-shim.ts          (stubs VS Code API to null/no-op for CLI context)
    → src/flightpath/IntegrationFactory.ts (creates harness integrations — same as extension)
    → src/flightpath/WorkflowInstance.ts   (runs execution engine — same as extension)
    → src/cli/CliTerminalFormatter.ts      (chalk-based terminal output — CLI-only)
    → src/utils/WorkflowLockManager.ts     (file-based process lock with heartbeat)
```

The FlightPath CLI adds only: argument parsing (Commander.js), TTY detection, `CliTerminalFormatter` rendering, lock management, and structured exit codes. All workflow logic is shared with the VS Code extension.

## Component Roles

**`src/cli.ts`** — Entry point. Calls `setRuntimeMode(RUNNER_IDS.CLI)` immediately on load, then defines Commander commands (`run`, `validate`). Orchestrates the execution flow:

1. Parses CLI flags into `ResolvedCliConfig`
2. Instantiates `CliAdapter` + registers it via `registerCliAdapter()`
3. Creates `IntegrationFactory(platform)` + `WorkflowInstance`
4. In headless mode, subscribes: `onPromptStart`, `onStreamingEvents`, `onStreamingChunk`, `onWorkflowStatusMessage`, `onPromptComplete`
5. Calls `instance.loadPromptFile()`, acquires `WorkflowLockManager` lock with 5s heartbeat
6. Applies `--resume` / `--new-session` overrides to the first prompt's `sessionId`
7. Calls `instance.executeLoadedPromptFile(harness)`
8. Maps final state to an exit code via `getExitCode()`, releases lock

**`src/platform/CliAdapter.ts`** — Implements `PlatformAdapter`. Maps CLI flags to config keys that `ConfigurationUtils.get()` reads inside harness providers. Key mappings:

| Config key | Source |
|---|---|
| `cliToolPermissions` | `"dangerouslyAllowAll"` / `"custom"` / `"allowAll"` from allow/deny flags |
| `cliAllowedTools` | `--allow-tool` flag values |
| `cliDeniedTools` | `--deny-tool` flag values |
| `copilotCliAllowedDirs` | `--add-dir` flag values |
| `cliExecutionMode` | `"interactive"` or `"headless"` (TTY-detected or forced) |
| `copilotCliModel` / `claudeCliModel` / `codexCliModel` | `--model` flag |
| `scriptTimeout` / `maxPromptExecutionTime` | `--script-timeout` / `--timeout` (converted back to seconds) |

VS Code-only features (`focusDashboard`) are not implemented.

**`src/platform/vscode-shim.ts`** — Stubs the `vscode` module for the CLI bundle (unavailable outside the extension host). `registerCliAdapter(platform)` stores the adapter so shim functions can delegate to it.

**`src/cli/CliTerminalFormatter.ts`** — Chalk-based renderer. **Not used by the extension or harness code.** Static methods:

- `renderEvent(event)` / `renderEvents(events)` — renders a single or array of `CliEvent` to stdout with chalk formatting; handles TEXT, THINKING, BASH_COMMAND, FILE_EDIT (with diff), FILE_WRITE, FILE_READ, FILE_DELETE, MCP_TOOL_CALL, WEB_SEARCH, TOOL_CALL, TOOL_RESULT
- `renderPromptHeader(data)` — prints step divider + step N/M + prompt preview (5 lines); called twice per attempt (without `cliCommand`, then with it)
- `renderStatusMessage(message, severity)` — severity-coloured left-border message (error=red, warning=yellow, info=cyan)
- `renderStats(data)` — token usage, context window %, session ID, elapsed time
- `flushStreamingBuffer()` — closes the current live-streaming TEXT or THINKING block; must be called before any non-text event or on prompt complete

TEXT and THINKING events use a live-streaming pattern: `_streaming` static state tracks the current block type to write each chunk directly to stdout (typewriter effect) and print the THINKING header only once per block.

File diff rendering uses the `diff` library. Prefers `structuredPatch` (pre-computed unified diff hunks) over `oldContent`/`newContent`. Truncates to 60 lines with a "… N more" indicator.

</architecture>

<executionModes>

## Interactive vs Headless Mode

Execution mode is determined by `getExecutionMode()`:

```
1. --headless flag  → always headless
2. --interactive flag → always interactive
3. Both stdout AND stdin are a TTY → interactive (default for terminal users)
4. Otherwise → headless (CI/CD, pipes, redirects)
```

**Interactive**: Opens a terminal window for the AI CLI TUI. The AI CLI's stdout passes through directly to the user's terminal. No streaming subscription needed.

**Headless**: Spawns the AI CLI as a background process. `onPromptStart`, `onStreamingEvents`, `onStreamingChunk`, `onWorkflowStatusMessage`, and `onPromptComplete` callbacks render output to the terminal in real time via `CliTerminalFormatter`.

In headless mode, `allowAllTools` is automatically set to `true` unless the user specified custom allow/deny lists — this prevents interactive tool approval prompts from blocking automation.

</executionModes>

<exitCodes>

## Structured Exit Codes

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | Success — all prompts completed                                     |
| 1    | Failure — prompt(s) failed or general error                         |
| 2    | Hard error — file not found, parse error, unexpected exception      |
| 3    | Provider error — CLI not installed, auth failure, command not found |
| 4    | Timeout exceeded                                                    |
| 5    | Interrupted — user pressed Ctrl+C                                   |

Exit codes 3 and 4 are inferred by scanning the error message of the first failed result for keywords (`"timeout"` / `"timed out"` / `"time limit"` → 4; `"not installed"` / `"not found"` / `"enoent"` → 3). They only fire when `state.status === EXECUTION_STATES.ERROR`; a normal prompt failure returns 1.

</exitCodes>

<buildConfig>

## Build Configuration

The CLI binary is built by `esbuild.js` as a separate bundle (`cliCtx`):

- Entry: `src/cli.ts`
- Output: `out/cli.js`
- `vscode` module aliased to `src/platform/vscode-shim.ts`
- `node-pty` marked external (native module, not needed by CLI)
- `VERSION` string injected via `define`
- `IS_DEV_MODE` always `false` for CLI builds (no dev commands)
- Platform: `node`, Format: `cjs`

</buildConfig>

<keyConstraints>

## Key Constraints for CLI Code

1. **Never import `vscode` directly** — the CLI bundle does not have access to the VS Code extension host. Use `CliAdapter` methods or `ConfigurationUtils.get()` (which delegates to the shim).
2. **Call `setRuntimeMode(RUNNER_IDS.CLI)` first** — must be called before any other module initialisation so runtime checks inside shared code behave correctly.
3. **No dashboard sink** — `WorkflowInstance` is created without a `DashboardSink`. Output goes to terminal via streaming event callbacks.
4. **No status bar** — Status bar callbacks are no-ops in CLI context.
5. **`--quiet` and `--json` flags** suppress all non-essential output — always check these before writing to stdout.
6. **Log output is redirected** — `Log.initializeCli()` redirects all `Log.*` calls to a log file, never to the terminal. This prevents diagnostic noise from polluting structured output.
7. **`CliTerminalFormatter` is CLI-only** — Do not import it from extension code or harness integration code. It depends on `chalk` for terminal colors.
8. **Lock acquisition happens after `loadPromptFile()`** — `WorkflowLockManager.acquireLock()` is called with a `WorkflowRunnerLock` (runner, pid, startedAt, instanceId, workflowId) and kept alive by a 5s `setInterval` heartbeat. Always release in all exit paths (success, error, SIGINT, SIGTERM, `process.on("exit")`).

</keyConstraints>

<addingCliCommands>

## Adding New CLI Commands

1. Add a new `.command()` block to `src/cli.ts` (Commander pattern)
2. Add options with `.option()` — use `collectRepeatable` helper for repeatable flags
3. Add the option type to the appropriate options interface
4. If the command needs new settings the harness providers don't already read, add a mapping in `CliAdapter.ts`
5. For terminal output, use `CliTerminalFormatter` or write directly to `process.stdout`
6. Always handle `--quiet` and `--json` before printing anything

</addingCliCommands>
