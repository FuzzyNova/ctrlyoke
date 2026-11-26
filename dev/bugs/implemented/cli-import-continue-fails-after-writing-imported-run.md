# `ctrlyoke import --continue` always fails after the imported run is written

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, reproduced against a fresh build)
- **Area:** `src/cli.ts`, `src/cli/RunImportCommand.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke import <bundle> --continue` imports the run and then fails with

```
{"schemaVersion":1,"success":false,"error":{"message":"Run history location is already frozen as \"user\"."}}
```

and exit code 2, in both `--json` and text mode. The run is not continued, the
import result (`continued`, "Imported … / View it with …") is never printed,
and `history list` shows a new `imp-…` lineage after every attempt. Running
`ctrlyoke continue --workflow <imported> --run 1` afterwards does work.

`docs/cli/ctrlyoke.md` (the `import` section, around lines 955-982) documents
`--continue` as continuing the imported run and returning one result line with
`continued`.

## Steps to Reproduce

1. Create a workflow with two script steps; step 1 is `test -f flag.txt`. Run
   it with `ctrlyoke run`; it ends in state `error` with step 2 pending.
2. `ctrlyoke export --workflow <key> --out /tmp/cybundle --json` reports
   `continuable: true`.
3. `touch flag.txt`
4. `ctrlyoke import /tmp/cybundle.ctrlyokerun --continue --changes skip --json`
5. Observe the error envelope above, exit code 2, and step 2 never running.

## Root Cause

- `src/cli.ts:483-500`: the `import` handler's `continueRun` calls
  `continueCommand` → `runCommand` in the same process.
- `runCommand` calls `initializeRunHistoryLocation()` (`src/cli.ts:1094`).
  Import already froze the location once through `bootstrapCliWorkspace`
  (`src/cli/CliWorkspaceBootstrap.ts:69`), and the second call throws
  (`src/utils/RunHistoryStoragePolicy.ts:16-24`).
- Even without that throw, `runCommand` ends with `process.exit(exitCode)`
  (`src/cli.ts` near the end of `runCommand`), so `importRunCommand`'s result
  output (`src/cli/RunImportCommand.ts:149-199`) would never print.
- `continueCommand` is called without `json`/`quiet`, so `import --json
--continue` would mix the run's text output into stdout.
- `src/test/unit/RunImportCommand.test.ts:139` stubs `continueRun` with a no-op,
  so no test exercises the real wiring.

## Suggested Fix

Split the part of `runCommand` after bootstrap into a function that returns
the exit code instead of calling `process.exit`, and skip the second
`initializeRunHistoryLocation` when the location is already frozen to the same
value (`isRunHistoryLocationInitialized()` exists). Pass `json`/`quiet` from
the import options. Print the import result before the continuation starts,
then exit with the continuation's code. Add a test that drives the real
`continueCommand` path, not a stub.
