# `history trash purge`/`empty` exit 0 when they refuse to run without `--yes`

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/cli/HistoryTrashCommands.ts`
- **Severity:** low

## Symptom

In a non-interactive shell, `ctrlyoke history trash purge <id>` and
`ctrlyoke history trash empty` print `Refusing to delete permanently without --yes.`
and exit **0**, so a CI step like `ctrlyoke history trash empty || fail`
reports success even though nothing was deleted. The same situation in
`trust-secret-grants` (`src/cli/SecretCommands.ts`) exits 2.

## Steps to Reproduce

1. `ctrlyoke history trash purge 2026-09-30T00-02-13-403Z-1a2b3c4d < /dev/null`
2. Prints the refusal and exits 0.

## Root Cause

`confirmDestructive` returns `false` both when an interactive user declines
and when it refuses non-interactively. The purge and empty handlers just
`return` in both cases, so the command succeeds.

## Suggested Fix

Make the non-interactive refusal a failure: throw, or return a value the
handler turns into exit code 2, through the same error path
`handleHistoryCommand` uses for other errors. An interactive "no" may stay
exit 0, since the user cancelled it themselves. Add tests for both cases.
