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
- `trust-external-roots` reviews/approves this workspace's requested `permissions.trustedExternalRoots` (workspace scope only) and writes decisions to `ExternalRootsTrustStore`, mirroring the VS Code batch-approval flow in `extension.ts`. `run` fails closed with exit code `2` whenever `ConfigurationUtils.getPendingWorkspaceExternalFileRoots()` is non-empty for the resolved workspace identity — this check runs right after the CLI overlay is set, before any workflow loading, so it applies even to `--prompt` inline runs. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
- `trust-workspace-settings` reviews workspace values that choose a program to run (see `config.instructions.md`). `runCommand` (every `run`/`rerun`/`append`/`continue`) calls `ensureWorkspaceSettingsDecided` right after the external-roots check: in a TTY it asks per value and continues, otherwise it exits `2`. Yes/no prompts go through `src/cli/CliPrompt.ts` (stderr), never a local readline copy.

## Config flow

1. `setRuntimeMode(RUNNER_IDS.CLI)` must stay at module top level before shared code initializes.
2. `configService` is seeded with user/workspace file backends, then `setCliOverlay()` is applied with only explicitly provided flags.
3. Setting-tier CLI flags such as `--timeout` and `--script-timeout` go into the `setCliOverlay()` overlay, only when explicitly passed. Workflow-property flags (`--harness`, `--model`, execution mode, permission, and session flags) are applied after loading through `CliPropertyOverrides`; `--force` is limited to `run` and `rerun`. Never give a setting-tier flag a Commander default, or it silently overrides the settings file. CLI option names and persisted setting keys intentionally do not match setting paths.

## `run` data flow gotchas

- `WorkflowInstance` is created without a dashboard sink. Headless output must subscribe on the instance, not the detector integration, because the real execution integration is created later by the factory.
- Runner-lock acquire/heartbeat/release is owned entirely by `WorkflowInstance.startWorkflowExecution` (same code path for CLI and extension — see `core.instructions.md`/`utils.instructions.md`); `cli.ts` does not duplicate it. On SIGINT/SIGTERM the CLI calls `instance.shutdown()`, not just `instance.stop()` — `shutdown()` requests a stop and then awaits (with a bounded timeout) the in-flight execution's settle promise, which is what guarantees the lock has actually been released before the process exits.
- `--var` overrides are merged into `workflowFile.vars` **after** loading so workflow defaults are present first.
- Session overrides mutate `promptQueue.getState().steps` directly. That getter is only a shallow copy, so step-object mutations intentionally write through into queue state.

</architecture>

<output>

## Interactive vs headless

- The run-level mode (`--interactive`, or a TTY) does not gate output: an interactive run still has headless steps (a step's own `executionMode` wins), scripts, verdicts and statuses, so `run` installs its render subscriptions whenever `!quiet && !json`. Only an interactive attempt's own harness output is skipped, by the `executionMode` on the `onTargetStreaming*` payloads, because its TUI already shows it.
- **Every write `run` makes to stdout during execution must go through its `CliTerminalOutputGate`.** While a harness TUI holds the terminal (`CliProcessManager.spawnInteractive` holds `inheritedTerminalOwnership` until the child exits), a write lands on the TUI's screen. A parallel group's headless members run beside its one interactive member, so this happens in normal use. The gate defers render _calls_ (not captured text) and replays them in order after the TUI exits, which keeps `CliTerminalFormatter`'s per-step prefix state consistent.
- The standalone interactive step records its attempt exactly like the VS Code PTY path: `CliExecutionRunner.executeInTerminal` differs only in the spawn, then runs session discovery and `CliLogMonitor`. The stop hook ends the turn, not the TUI, so the runner terminates the TUI only after the monitor has drained the log.
- Headless mode renders prompt boundaries/status via `CliTerminalFormatter`, but raw streaming chunks still go straight to `stdout`.
- `--quiet` and `--json` must suppress decorative output. Diagnostics should go through `Log.initializeCli()` so logs land in `.ctrlyoke/logs/` instead of contaminating terminal/JSON output.

## `CliTerminalFormatter` rules

- `_streaming` is shared static state for live TEXT / THINKING blocks. Always `flushStreamingBuffer()` before non-text events and on prompt completion or blocks will run together.
- Diff output prefers precomputed `structuredPatch` hunks, falls back to `oldContent` / `newContent`, and truncates long diffs. Keep this formatter CLI-only even if logic resembles webview rendering.
- **`--no-color` must go through `CliTerminalFormatter.setColorEnabled()`; writing `process.env.NO_COLOR` from a command action does nothing.** chalk 5 resolves `chalk.level` once while the module initializes, which in the bundle is before any action runs — so the env write is silently ignored and the flag is dead in a TTY (the only place it matters, since a redirected stream is already uncoloured). This is invisible in testing unless you force a colour level: `npm` exports `FORCE_COLOR` only when its own stdout is a TTY, so redirecting the output you were about to inspect is exactly what hides the bug. `setColorEnabled(true)` is deliberately a no-op rather than a force-on, so omitting the flag never overrides chalk's own pipe detection.

</output>

<constraints>

## Constraints

- Never depend on `vscode`, `@vscode/extension-telemetry`, or `src/platform/VsCode*` from any Node entry point. `SourceAuditCounters.test.ts` checks source graphs, and esbuild metafile guards cover the CLI, MCP, and worker bundles.
- CLI builds produce `out/cli.js` with a shebang and `IS_DEV_MODE=false`; keep code Node-safe and independent of extension-host services.
- Preserve structured exit semantics when adding failure paths: `0` success, `1` workflow failure, `2` usage/parse/unexpected error, `3` harness/tool availability issues, `4` timeout, `5` interrupted.

## Distribution

- `out/cli.js` ships inside the VSIX as well as on npm (`dev/backlog/CLI_DISTRIBUTION_PLAN.md`). The CLI finds its runtime assets relative to the package root (`CliAdapter.getExtensionPath()`), so **anything the CLI loads at runtime must live under `out/` and be listed both in `.vscodeignore` and in `NPM_PACKAGE_ENTRIES` (`scripts/build-npm-package.mjs`)**, which assembles the npm package in `dist/npm/` with its own generated `package.json` (the root one is never published). `scripts/cli-distribution-packaging.test.mjs` guards the VSIX bundle and shims; `scripts/build-npm-package.test.mjs` installs the packed tarball and runs `--version` and `validate`, so a missing asset surfaces there.
- `out/mcp-server.js` needs its `#!/usr/bin/env node` banner (`esbuild.js`) because npm links the `ctrlyoke-mcp` bin straight to it; without one, npm's Windows `.cmd` wrapper hands the `.js` file to the OS file association instead of `node`.
- `bin/ctrlyoke[.cmd]` and `bin/ctrlyoke-mcp[.cmd]` are the launchers. Each host (extension or CLI) calls `registerCtrlyokeBinDirectory()` at startup, and `CliProviderUtils.buildProcessEnv()` prepends that directory to every harness spawn, so an agent's `ctrlyoke append` reaches the copy that launched it, not whichever `ctrlyoke` comes first on the user's PATH. A new harness spawn path must build its env from `buildProcessEnv()` rather than spreading `process.env`, or it silently loses this. Integrated terminals get the same directory through `environmentVariableCollection` (`src/ui/CtrlyokeCliCommands.ts`); the system PATH is never edited.
- Every CLI command records itself in `<ctrlyokeStateHome>/installations.json` from a root `preAction` hook (`CliInstallationNotice.ts`) and may print a version-mismatch warning. That warning must go to **stderr** only, never stdout, which is the `--json` contract. The hook is best effort and must never throw or noticeably delay a command.
- The POSIX shims must stay git mode `100755` and LF, and the `.cmd` shims CRLF (`.gitattributes`). A VSIX does not reliably preserve the executable bit, so activation re-applies it (`ensureCtrlyokeShimsExecutable`).

</constraints>
