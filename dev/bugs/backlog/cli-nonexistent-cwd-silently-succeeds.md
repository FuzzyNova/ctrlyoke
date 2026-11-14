# CLI commands accept a nonexistent `--cwd`, report empty results and leave orphan project state

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `src/cli.ts`, `src/cli/HistoryCommandDefinitions.ts`, `src/cli/CliWorkspaceBootstrap.ts` (`bootstrapCliWorkspace`), every command that takes `-d, --cwd <path>`
- **Severity:** medium

## Symptom

A mistyped `--cwd` is not reported. Read-only commands succeed with empty
output and exit 0, so a script cannot tell "no history" from "wrong path":

```
$ ctrlyoke status --cwd /tmp/does-not-exist --json
{"workspaceRoot":"/tmp/does-not-exist","workflowCount":0,"workflows":[],...}   # exit 0
$ ctrlyoke history list --cwd /tmp/does-not-exist --json
[]                                                                              # exit 0
```

`history runs`, `history steps` and `history search` behave the same (the
lineage commands report "Workflow lineage … was not found", which points the
user at the wrong problem).

Each of those calls also creates `~/.ctrlyoke/projects/<slug>-<hash>/project.json`
for the nonexistent path, which `ctrlyoke history prune` then lists as orphaned
state. The real state home on the machine this was found on already holds such
entries, e.g. one whose `statePath` is `<checkout>/--help` and one for
`/private/tmp/definitely-missing-xyz`.

## Steps to Reproduce

1. `ctrlyoke status --cwd /tmp/bh-missing --json; echo $?` → empty result, `0`.
2. `ls ~/.ctrlyoke/projects | grep bh-missing` → a new project directory.
3. `ctrlyoke history prune` → lists it.

## Root Cause

No command validates `--cwd`. Each resolves it with
`path.resolve(options.cwd ?? process.cwd())` (24 option definitions across
`src/cli.ts`, `src/cli/CliRunCommandDefinitions.ts`,
`src/cli/HistoryCommandDefinitions.ts`, `src/cli/ServerCommand.ts`, and
`bootstrapCliWorkspace` in `src/cli/CliWorkspaceBootstrap.ts`) and passes it
on. Project-state lookup (`ProjectStateRegistry`) then registers the
resolved path as a project.

## Suggested Fix

Validate `--cwd` once, in one shared place, before any command runs: for
example a `preAction` hook on the root commander program that, when the
action command has a `cwd` option, checks that it exists and is a directory,
and otherwise fails with `--cwd <path> is not a directory` through the CLI's
normal error path (a `--json` error envelope and the usage-error exit code
from `src/cli/CliExitCode.ts`). Keep the default (no `--cwd`) unchanged.

Tests: a CLI unit test that `status`/`history list` with a missing `--cwd`
fail with that error and do not create a project-state directory (point
`CTRLYOKE_HOME` at a temp dir), and that an existing directory still works.
Note the user-visible change under **Changed** in `CHANGELOG.md` (an exit code
that was 0 becomes the usage-error code).
