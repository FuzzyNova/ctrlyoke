---
applyTo: "src/cli.ts,src/cli/**"
---

<purpose>
Standalone `ctrlyoke` CLI entrypoint plus terminal-only formatting. `src/cli.ts` owns the `run`, `validate`, and `commit` commands; `src/cli/CliTerminalFormatter.ts` only renders headless streaming output.
</purpose>

<architecture>

## Command boundaries

- `run` reuses the shared workflow engine. CLI-specific code is limited to runtime bootstrap, config/backends/overlay setup, adapter+shim wiring, terminal subscriptions, workflow locking, and exit-code mapping.
- `validate` is intentionally lightweight: parse-only, no harness startup or `WorkflowInstance` execution.
- `commit` is a separate path. It delegates to `src/git/CommitMessageGenerator` and `GitCommitter`, so queue execution, streaming subscriptions, and workflow lock changes usually should not affect `ctrlyoke commit`.
- `trust-external-roots` reviews/approves this workspace's requested `permissions.allowedExternalFileRoots` (workspace scope only) and writes decisions to `ExternalRootsTrustStore`, mirroring the VS Code batch-approval flow in `extension.ts`. `run` fails closed with exit code `2` whenever `ConfigurationUtils.getPendingWorkspaceExternalFileRoots()` is non-empty for the resolved workspace identity — this check runs right after the CLI overlay is set, before any workflow loading, so it applies even to `--prompt` inline runs. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.

## Config flow

1. `setRuntimeMode(RUNNER_IDS.CLI)` must stay at module top level before shared code initializes.
2. `configService` is seeded with user/workspace file backends, then `setCliOverlay()` is applied with only explicitly provided flags.
3. `CliAdapter` plus `registerCliAdapter()` is what makes shared `ConfigurationUtils` / `workspace.getConfiguration()` reads see CLI values inside the bundled Node process.
4. A CLI flag that corresponds to a setting (`--model`, `--timeout`, `--permission-mode`, …) goes into the `setCliOverlay()` overlay, and only when the user passed it explicitly. Never give such a flag a Commander default, or it silently overrides the settings file. Do not add `CliAdapter.getConfig()` key mappings for flags: that path is read only by callers that ask for a specific key (today just `cliExecutionMode`). Mappings nobody read accumulated there and made `-t`/`--script-timeout`/`--add-dir`/`--permission-mode` look wired when they were not. Do **not** fall back to `this.config[key]`; CLI option names and persisted setting keys intentionally do not match.

## `run` data flow gotchas

- `WorkflowInstance` is created without a dashboard sink. Headless output must subscribe on the instance, not the detector integration, because the real execution integration is created later by the factory.
- Runner-lock acquire/heartbeat/release is owned entirely by `WorkflowInstance.startWorkflowExecution` (same code path for CLI and extension — see `core.instructions.md`/`utils.instructions.md`); `cli.ts` does not duplicate it. On SIGINT/SIGTERM the CLI calls `instance.shutdown()`, not just `instance.stop()` — `shutdown()` requests a stop and then awaits (with a bounded timeout) the in-flight execution's settle promise, which is what guarantees the lock has actually been released before the process exits.
- `--var` overrides are merged into `workflowFile.vars` **after** loading so workflow defaults are present first.
- Session overrides mutate `promptQueue.getState().steps` directly. That getter is only a shallow copy, so step-object mutations intentionally write through into queue state.

</architecture>

<output>

## Interactive vs headless

- Interactive mode is a passthrough for the underlying AI CLI TUI with only minimal ctrlyoke framing.
- Headless mode renders prompt boundaries/status via `CliTerminalFormatter`, but raw streaming chunks still go straight to `stdout`.
- `--quiet` and `--json` must suppress decorative output. Diagnostics should go through `Log.initializeCli()` so logs land in `.ctrlyoke/logs/` instead of contaminating terminal/JSON output.

## `CliTerminalFormatter` rules

- `_streaming` is shared static state for live TEXT / THINKING blocks. Always `flushStreamingBuffer()` before non-text events and on prompt completion or blocks will run together.
- Diff output prefers precomputed `structuredPatch` hunks, falls back to `oldContent` / `newContent`, and truncates long diffs. Keep this formatter CLI-only even if logic resembles webview rendering.
- **`--no-color` must go through `CliTerminalFormatter.setColorEnabled()`; writing `process.env.NO_COLOR` from a command action does nothing.** chalk 5 resolves `chalk.level` once while the module initializes, which in the bundle is before any action runs — so the env write is silently ignored and the flag is dead in a TTY (the only place it matters, since a redirected stream is already uncoloured). This is invisible in testing unless you force a colour level: `npm` exports `FORCE_COLOR` only when its own stdout is a TTY, so redirecting the output you were about to inspect is exactly what hides the bug. `setColorEnabled(true)` is deliberately a no-op rather than a force-on, so omitting the flag never overrides chalk's own pipe detection.

</output>

<constraints>

## Constraints

- Never depend on the real `vscode` module from CLI code. The CLI bundle aliases it to `src/platform/vscode-shim.ts`.
- CLI builds produce `out/cli.js` with a shebang and `IS_DEV_MODE=false`; keep code Node-safe and independent of extension-host services.
- Preserve structured exit semantics when adding failure paths: `0` success, `1` workflow failure, `2` usage/parse/unexpected error, `3` harness/tool availability issues, `4` timeout, `5` interrupted.

</constraints>
