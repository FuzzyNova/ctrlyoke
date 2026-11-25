# `import --continue --json` swallows continuation errors

- **Found:** 2026-11-25 by bug-hunt final step (review of d797f93ed)
- **Area:** `src/cli/RunImportCommand.ts`, `src/cli.ts` (`runCommand`, import registration)
- **Severity:** medium

## Symptom

When `ctrlyoke import <bundle> --continue --json` imports a run and the
continuation then fails with an error (rather than finishing in a failed
workflow state), the error message is written nowhere. Stdout holds only the
import's `{"success":true, ..., "continued":true}` line, stderr is empty, and
the process exits `2`. A CI script sees a success envelope, an unexplained exit
code, and no message to log.

Text mode is not affected: the error is rethrown and printed to stderr.

## Steps to Reproduce

Unit-level (confirmed): in `src/test/unit/RunImportCommand.test.ts`, test
"continues only when explicitly requested and reports the changes target", make
the `continueRun` stub `throw new Error("lock held")`. `output` then contains
only the success envelope; the message `lock held` appears in no output line.

End to end: any error thrown inside `runCommand`'s main `try` during the
continuation (for example `validateCliContinuationTarget` refusing the run, a
runner-lock conflict, or a load failure in `executeAddressedCliOperation`)
takes the same path.

## Root Cause

Two layers each suppress the message once the import line is written:

1. `src/cli.ts` `runCommand` catch block (around line 1750): when called for
   the import continuation (`emitJsonResult === false`, `options.json`), it
   passes `writeOut: () => {}` to `reportCliError`, so the JSON error envelope
   is discarded and nothing goes to stderr either (`reportCliError` only writes
   to stderr in text mode, `src/cli/CliExitCode.ts:54-67`).
2. `src/cli/RunImportCommand.ts` catch block: errors that escape
   `continueRun` (e.g. `reportRunUsageError` rethrows when `returnExitCode` is
   set) land here with `jsonResultWritten === true`, so the failure envelope is
   skipped; only the exit code is set.

The single-JSON-line contract from d797f93ed is kept, but at the cost of
dropping the error entirely.

## Suggested Fix

Keep one stdout JSON line but don't lose the error. Simplest option that stays
additive within `schemaVersion: 1`: write the continuation error to **stderr**
(redacted, `Error: <message>`) in JSON mode for both paths above — the import
line on stdout stays the only JSON line. Alternatively defer the import JSON
line until the continuation settles and add an additive
`continuation: { exitCode, error }` field; either way, add the redaction via
`secretRedactionService` as `reportCliError` does.

Tests: extend `src/test/unit/RunImportCommand.test.ts` with a throwing
`continueRun` in JSON mode asserting the message is reported (and stdout has
one line); if the `runCommand` path changes, cover it in
`src/test/integration/cli-import-continue.integration.test.ts`. Add a
**Changed** entry in `CHANGELOG.md`.
