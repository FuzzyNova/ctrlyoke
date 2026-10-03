# CLI `--workflow` rejects a workflow's display name with no hint at its key

- **Found:** 2026-10-03 by Claude (claude-cli) while manually testing the CLI history commands
- **Area:** `src/cli/CliRunSelector.ts`, `src/cli/HistoryInspectionCommands.ts`
- **Severity:** low

## Symptom

Every history command that takes `--workflow <key>` (`history runs`, `steps`, `show`, and the
run-addressing commands) accepts only the timestamped lineage key. Passing the name a user sees
in the dashboard and in `history list` fails:

```
$ ctrlyoke history runs --workflow "more bug backlog2"
Error: Workflow lineage "more bug backlog2" was not found.     (exit 2)
```

The user has to run `history list`, find the row, and copy the key
(`more-bug-backlog2-2026-10-02T00-06-20-309`). The error gives no hint that a lineage with that
exact name exists.

## Steps to Reproduce

1. `node ./out/cli.js history list` and note a lineage's NAME and KEY.
2. `node ./out/cli.js history runs --workflow "<NAME>"`.
3. The command exits 2 with `Workflow lineage "<NAME>" was not found.`

## Root Cause

`createWorkflowLineageNotFoundError` (`src/cli/CliRunSelector.ts:29`) is raised when the value
is not a key on disk. Nothing tries to match the value against `workflow.json`'s
`workflowName`.

## Suggested Fix

When the value is not a lineage key, fall back to lineages whose `workflowName` matches it
exactly (case-insensitively):

- **One match:** use it. Optionally print `Using lineage <key>` on stderr, never stdout, which is
  the `--json` contract.
- **Several matches** (names are not unique, e.g. "Bug backlog" vs "bug backlog"): exit 2 and
  list the candidate keys with their latest run dates.
- **No match:** keep the current error, but add a hint such as
  `run "ctrlyoke history list" to find a lineage key`.

Resolve the key once in a shared helper so every `--workflow` option behaves the same. Update
the option help text from `Workflow lineage key` to `Workflow lineage key or exact name`.
