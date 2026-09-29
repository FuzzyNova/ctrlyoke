# Troubleshooting

Use this section when a workflow does not start, does not resume, or does not satisfy its validation gates.

## Start here

- [Common errors](/troubleshooting/common-errors)
- [FAQ](/troubleshooting/faq)

## Quick checklist

1. A workspace folder is open, and `.ctrlyoke/` exists (run `ctrlyoke: Initialize Workspace` if not).
2. The selected harness CLI is installed, on `PATH`, and signed in. Try running it once by hand.
3. The workflow file validates: `ctrlyoke validate <file>`.
4. The harness and model you expect are the ones in effect. A step's `harness` or `model` overrides the
   workflow's, which overrides the `defaults` settings.

## Logs

Logs are written to `.ctrlyoke/logs/` in the workspace:

| File                                 | Contents                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctrlyoke-<timestamp>.log`           | Extension session log: state transitions, orchestration, session IDs. Start here                                                                                           |
| `ctrlyoke-cli-<timestamp>.log`       | One per `ctrlyoke` CLI invocation. `--verbose` adds debug detail                                                                                                           |
| `ctrlyoke-<harness>-hook-debug.log`  | Every hook invocation for Copilot CLI, Claude Code, Qwen Code, and Antigravity; written only when `diagnostics.verboseLogging` is on. Check it when a step never completes |
| `ctrlyoke-codex-notify-debug.log`    | The Codex CLI equivalent of the hook log; written only when `diagnostics.verboseLogging` is on                                                                             |
| `ctrlyoke-opencode-plugin-debug.log` | The OpenCode equivalent of the hook log; written only when `diagnostics.verboseLogging` is on                                                                              |
| `ctrlyoke-mcp-<timestamp>.log`       | The ctrlyoke MCP server, written only when the `diagnostics.verboseLogging` setting is on                                                                                  |

`ctrlyoke: Show Output Panel` shows the extension's log in VS Code's Output panel.

## Run storage

Run storage holds working files, runner locks, and per-run output history. User mode (the
default) resolves it under `<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/<workflowKey>/`,
where `<ctrlyokeStateHome>` is `~/.ctrlyoke` unless the `CTRLYOKE_HOME` environment variable
moves it. Workspace mode (`storage.runHistoryLocation: workspace`) uses
`<stateRoot>/.ctrlyoke/.runs/<workflowKey>/`.

| Path                                     | Contents                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `workflow.json`                          | Lineage descriptor: name, favorite, latest run                                   |
| `runner.json`                            | Runner lock naming the run that is executing, with the owner's PID and heartbeat |
| `draft/workflow.ctrlyoke.json`           | The not-yet-executed definition, before the first run                            |
| `run-<timestamp>/workflow.ctrlyoke.json` | That run's working copy, including per-step runtime state and session IDs        |
| `run-<timestamp>/events.jsonl`           | Per-step output events: what the harness actually produced                       |
| `run-<timestamp>/manifest.json`          | Step metadata and run summary                                                    |

The CLI's `ctrlyoke history list`, `history runs`, `history show`, and `history search` commands
read this storage for you.

Managed worktree runs use the initiating checkout's history. Opening a worktree directory directly
as its own VS Code workspace gives it its own history. User-scoped history under OneDrive or
Dropbox is synchronized, but simultaneous runs of one project on two synced machines are
unsupported because PIDs and file locks are machine-local.
