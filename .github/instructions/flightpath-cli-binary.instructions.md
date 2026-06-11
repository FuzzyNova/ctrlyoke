---
applyTo: "src/cli.ts,src/cli/**"
---

<purpose>
Standalone `flightpath` CLI entrypoint plus terminal-only formatting. `src/cli.ts` owns the `run`, `validate`, and `commit` commands; `src/cli/CliTerminalFormatter.ts` only renders headless streaming output.
</purpose>

<architecture>

## Command boundaries

- `run` reuses the shared workflow engine. CLI-specific code is limited to runtime bootstrap, config/backends/overlay setup, adapter+shim wiring, terminal subscriptions, workflow locking, and exit-code mapping.
- `validate` is intentionally lightweight: parse-only, no harness startup or `WorkflowInstance` execution.
- `commit` is a separate path. It delegates to `src/git/CommitMessageGenerator` and `GitCommitter`, so queue execution, streaming subscriptions, and workflow lock changes usually should not affect `flightpath commit`.

## Config flow

1. `setRuntimeMode(RUNNER_IDS.CLI)` must stay at module top level before shared code initializes.
2. `configService` is seeded with user/workspace file backends, then `setCliOverlay()` is applied with only explicitly provided flags.
3. `CliAdapter` plus `registerCliAdapter()` is what makes shared `ConfigurationUtils` / `workspace.getConfiguration()` reads see CLI values inside the bundled Node process.
4. In `CliAdapter.getConfig()`, add explicit key mappings for shared settings that CLI paths depend on. Do **not** fall back to `this.config[key]`; CLI option names and persisted setting keys intentionally do not match.

## `run` data flow gotchas

- `WorkflowInstance` is created without a dashboard sink. Headless output must subscribe on the instance, not the detector integration, because the real execution integration is created later by the factory.
- Prompt loading happens before lock acquisition so `workingFilePath` exists; the CLI then maintains its own `WorkflowLockManager` heartbeat and must release it on success, error, SIGINT/SIGTERM, and process exit.
- `--var` overrides are merged into `workflowFile.vars` **after** loading so workflow defaults are present first.
- Session overrides mutate `promptQueue.getState().steps` directly. That getter is only a shallow copy, so step-object mutations intentionally write through into queue state.

</architecture>

<output>

## Interactive vs headless

- Interactive mode is a passthrough for the underlying AI CLI TUI with only minimal FlightPath framing.
- Headless mode renders prompt boundaries/status via `CliTerminalFormatter`, but raw streaming chunks still go straight to `stdout`.
- `--quiet` and `--json` must suppress decorative output. Diagnostics should go through `Log.initializeCli()` so logs land in `.flightpath/logs/` instead of contaminating terminal/JSON output.

## `CliTerminalFormatter` rules

- `_streaming` is shared static state for live TEXT / THINKING blocks. Always `flushStreamingBuffer()` before non-text events and on prompt completion or blocks will run together.
- Diff output prefers precomputed `structuredPatch` hunks, falls back to `oldContent` / `newContent`, and truncates long diffs. Keep this formatter CLI-only even if logic resembles webview rendering.

</output>

<constraints>

## Constraints

- Never depend on the real `vscode` module from CLI code. The CLI bundle aliases it to `src/platform/vscode-shim.ts`.
- CLI builds produce `out/cli.js` with a shebang and `IS_DEV_MODE=false`; keep code Node-safe and independent of extension-host services.
- Preserve structured exit semantics when adding failure paths: `0` success, `1` workflow failure, `2` usage/parse/unexpected error, `3` harness/tool availability issues, `4` timeout, `5` interrupted.

</constraints>
