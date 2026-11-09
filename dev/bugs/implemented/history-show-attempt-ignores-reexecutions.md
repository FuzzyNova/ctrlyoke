# `history show --attempt N` numbers attempts per execution, disagreeing with `history steps` and run JSON

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced with `node out/cli.js`)
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`collectHistoryAttemptIndex` ~455-470, `matchesHistoryShowAttempt` ~546, `validateHistoryShowSelection` ~895-903)
- **Resolution:** fixed in this commit

## Symptom

After a step runs in two executions of the same run (it fails, then `ctrlyoke continue` reruns it):

- Run JSON shows `"attempts": 2, "lastAttempt": { "number": 2 }`; `history steps --json` shows
  `"attempts": 2` for the step.
- `history show --step 1 --attempt 2 --json --summary` exits 2: `Invalid --attempt value "2" for --step 1; valid attempts are 1 to 1`.
- `history show --step 1 --attempt 1 --json --summary` returns **both** executions
  (`runIndex` 0 and 1, each `attemptIndex` 0).
- `history show --step 1 --attempt 1 --limit 100 --json --summary` exits 0 and prints two paged
  records, although the docs say paging reads exactly one attempt and a selection covering
  several attempts fails with exit 2 before printing.

## Steps to Reproduce

1. Run a script workflow whose step 1 is `exit 3`; the run stops with an error.
2. `ctrlyoke continue --workflow <key> --run 1 --json` (step 1 fails again).
3. Run the `history show` commands above.

## Root Cause

Attempt identity is (`runIndex`, `attemptIndex`), and `attemptIndex` restarts at 0 on every
resume/continue. `--attempt` matches on `attemptIndex + 1` only, and `maxAttemptNumber` is
`attemptIndex + 1`, while the ATTEMPTS count and `lastAttempt.number` count across executions.

## Suggested Fix

Number a target's attempts across the whole run in timeline order (by `runIndex`, then
`attemptIndex`): the Nth started attempt is `--attempt N`. Set `maxAttemptNumber` to that count,
match on the ordinal, and let the paging single-attempt check use it. Add a fixture with two
`runIndex` values for one target in `src/test/unit/HistoryInspectionCommands.test.ts`.
