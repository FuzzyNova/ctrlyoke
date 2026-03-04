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
    → src/platform/CliAdapter.ts       (PlatformAdapter for CLI — maps CLI flags to settings)
    → src/platform/vscode-shim.ts      (stubs VS Code API to null/no-op for CLI context)
    → src/flightpath/IntegrationFactory.ts  (creates harness integrations — same as extension)
    → src/flightpath/WorkflowInstance.ts    (runs execution engine — same as extension)
    → src/cli/CliTerminalFormatter.ts  (chalk-based terminal output — CLI-only, not used by extension)
```

The FlightPath CLI adds only: argument parsing (Commander.js), TTY detection, `CliTerminalFormatter` rendering, and structured exit codes. All workflow logic is shared with the VS Code extension.

## Component Roles

**`src/cli.ts`** — Entry point. Defines Commander commands (`run`, `validate`). Orchestrates the execution flow:

1. Parses CLI flags into `ResolvedCliConfig`
2. Instantiates `CliAdapter` + registers it via `registerCliAdapter()`
3. Creates `IntegrationFactory(platform)` + `WorkflowInstance`
4. Subscribes to streaming events for terminal display (headless mode only)
5. Calls `instance.loadPromptFile()` and `instance.executeLoadedPromptFile()`
6. Maps final state to an exit code via `getExitCode()`

**`src/platform/CliAdapter.ts`** — Implements `PlatformAdapter`. Maps CLI flags to the settings keys that `ConfigurationUtils.get()` reads inside harness providers. Example: `--allow-all-tools` flag → `getCliToolPermissions()` returns `"dangerouslyAllowAll"`. VS Code-only settings (e.g., `focusDashboard`) are stubbed as no-ops.

**`src/platform/vscode-shim.ts`** — Stubs the `vscode` module for the CLI bundle (the `vscode` package is unavailable outside the extension host). `registerCliAdapter(platform)` stores the adapter so shim functions can delegate to it.

**`src/cli/CliTerminalFormatter.ts`** — Chalk-based renderer for the terminal. Renders `CliEvent[]` arrays (streaming events) and prompt completion stats. **Not used by the extension or harness code** — strictly a CLI binary display helper.

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

**Headless**: Spawns the AI CLI as a background process. `instance.onStreamingEvents()` and `instance.onStreamingChunk()` callbacks render output to the terminal in real time via `CliTerminalFormatter`.

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

Exit codes 3 and 4 are inferred by scanning error messages in failed results for keywords (`"not installed"`, `"timeout"`, etc.).

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
2. **No dashboard sink** — `WorkflowInstance` is created without a `DashboardSink`. Output goes to terminal via streaming event callbacks.
3. **No status bar** — Status bar callbacks are no-ops in CLI context.
4. **`--quiet` and `--json` flags** suppress all non-essential output — always check these before writing to stdout.
5. **Log output is redirected** — `Log.initializeCli()` redirects all `Log.*` calls to a log file, never to the terminal. This prevents diagnostic noise from polluting structured output.
6. **`CliTerminalFormatter` is CLI-only** — Do not import it from extension code or harness integration code. It depends on `chalk` for terminal colors.

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
