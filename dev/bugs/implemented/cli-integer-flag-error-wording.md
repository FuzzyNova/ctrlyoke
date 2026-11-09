# CLI integer-flag errors read "expected an integer a safe integer" / "an integer at least 1"

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced with `node out/cli.js`)
- **Area:** `src/cli/CliIntegerParsing.ts` (~15-27), `src/cli/HistoryFilterParsing.ts` (~36-40)
- **Resolution:** fixed in this commit

## Symptom

- `ctrlyoke run x.yaml -t 0x10` → `Invalid --timeout value "0x10"; expected an integer a safe integer.`
- `ctrlyoke run x.yaml --script-timeout 0` → `... expected an integer at least 1.`

## Steps to Reproduce

Run the commands above.

## Root Cause

The message template is `expected an integer ${range}`, but the unbounded `range` variant is
`a safe integer` and the bounded ones are `at least N` / `at most N`, which don't read after
"an integer". `parseHistoryInteger` works around it by re-throwing its own "of at least" message;
`--timeout`, `--script-timeout` and `--port` don't.

## Suggested Fix

Make the range phrases read correctly after "an integer" (`of at least N`, `of at most N`,
`between A and B`) and use `expected a safe integer` when unbounded; then drop the
`HistoryFilterParsing` workaround if it becomes redundant. Cover each wording in the
`CliIntegerParsing` tests (or the run-command definition tests).
