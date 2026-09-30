# An unknown `--workflow` key makes run-addressed CLI commands fail with a raw ENOENT on a lock file

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); reproduced with `out/cli.js`
- **Area:** `src/cli/CliRunSelector.ts` (`resolveCliRunRefAtLineage` ~67-78, `withFileLock(descriptorPath(...))`)
- **Severity:** low

## Symptom

`ctrlyoke rerun --workflow nope --headless`, `continue --workflow nope --run 1`, and
`step remove --workflow nope --run 1 --index 0` print
`Error: ENOENT: no such file or directory, open '...\.runs\nope\workflow.json.lock'`
(exit 2). The `--json` `error` field contains the same raw text. `history runs`
already reports `Workflow lineage "nope" was not found.` for the same input.

## Root Cause

The lineage descriptor lock is taken before checking that the lineage directory
exists, and the lock file cannot be created inside a missing directory.

## Suggested Fix

Check that the lineage descriptor exists before locking, and throw the same shared
"lineage not found" error that `history runs` uses. Add tests for `rerun`,
`continue`, and `step` with an unknown key (text and `--json` output).
