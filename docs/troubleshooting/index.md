# Troubleshooting

Use this section when a workflow does not start, does not resume, or does not satisfy its validation gates.

## Start here

- [Common errors](/troubleshooting/common-errors)
- [FAQ](/troubleshooting/faq)

## Useful places to inspect

- `.ctrlyoke/logs/` for runtime and hook logs
- run storage for working files, runner locks, and per-run output history. User mode resolves it
  under `<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/`; workspace mode uses
  `<stateRoot>/.ctrlyoke/.runs/`.

Managed worktree runs use the initiating checkout's history. Opening a worktree directory directly
as its own VS Code workspace gives it its own history. User-scoped history under OneDrive or
Dropbox is synchronized, but simultaneous runs of one project on two synced machines are
unsupported because PIDs and file locks are machine-local.
