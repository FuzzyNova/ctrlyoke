# CLI `--json` usage errors skip the documented JSON envelope

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli, docs/CLI subagent)
- **Area:** `src/cli.ts` (`program.exitOverride`, early checks in `runCommand`), `src/cli/CliRunCommandDefinitions.ts` (option parsers), `src/cli/RunImportCommand.ts` (`--changes` choices), `src/cli/CliExitCode.ts` (`reportCliError`)
- **Resolution:** fixed in this commit

## Symptom

`docs/cli/ctrlyoke.md` ("JSON errors") says commands that support `--json`
write failures to stdout as one `schemaVersion: 1` object, and that `run`
keeps its run-result error object. `docs/cli/ci.md` documents that object
(`status`, `summary`, `steps`, `finalStep`, `error: { step, pass, attempt, message }`).
Two classes of failure break this:

1. **Option values rejected while Commander parses arguments print nothing on
   stdout.** Exit code 2, only Commander's `error: option … is invalid` on
   stderr:
   - `ctrlyoke run s.yaml --timeout 1.5 --json`
   - `ctrlyoke run s.yaml --script-timeout 0 --json`
   - `ctrlyoke run s.yaml --permission-mode bogus --json`
   - `ctrlyoke run s.yaml --var novalue --json`
   - `ctrlyoke import /x --changes bogus --json`
   - `ctrlyoke history runs --json` (missing required `--workflow`)

   Values checked inside the action (`run --harness bogus`,
   `history search x --limit 0`, `history show --attempt foo`) do get the
   envelope, so a CI script gets JSON for some bad values and empty stdout for
   others.

2. **`run --json`'s early usage checks use the generic envelope, not the
   run-result object.** `run s.yaml --prompt hi --json` and
   `run s.yaml --harness bogus --json` print
   `{"schemaVersion":1,"success":false,"error":{"message":"…"}}`, while
   `run missing.yaml --json` prints the full run-result object. The ci.md
   example's `r.summary` is undefined for the first kind.

## Steps to Reproduce

1. `ctrlyoke run x.yaml --timeout 1.5 --json > out.txt 2> err.txt; echo $?`
   → `2`, `out.txt` empty, `err.txt` has Commander's error.
2. `ctrlyoke run s.yaml --prompt hi --json` → generic envelope, no `status`/`summary`/`steps`.

## Root Cause

- Option parsers throw Commander's `InvalidArgumentError`
  (`parseTimeoutSeconds`, `parseScriptTimeoutSeconds`, `parsePermissionMode`,
  `parseSandboxMode`, `collectVar` in `src/cli/CliRunCommandDefinitions.ts`;
  `.choices(...)` in `src/cli/RunImportCommand.ts`; required options).
  `program.exitOverride` in `src/cli.ts` maps them to exit 2, but Commander has
  already written its text to stderr and nothing writes the JSON envelope.
- `runCommand`'s early checks (`--session-id` with `--no-resume-session`,
  invalid `--harness`, no file or `--prompt`, `--prompt` with a file) call
  `reportCliError(..., { json })` without an `envelope`, so
  `reportCliError` falls back to the generic shape. Only the later catch
  passes `buildCliJsonResult`.

## Suggested Fix

- In one place (the `exitOverride`/`configureOutput` of the root program),
  when the invoked command line has `--json`, turn a Commander parse error into
  the command's JSON error on stdout (the generic envelope, or for `run` the
  run-result object), keep exit 2, and keep the human message on stderr.
- Give `runCommand`'s early checks the same run-result envelope the later
  catch uses (`buildCliJsonResult`), single-sourced.

Tests: CLI unit tests for one Commander-parse failure per kind above (bad
`--timeout`, bad `--changes`, missing required option) asserting a parseable
stdout envelope and exit 2, and `run --prompt x file --json` asserting the
run-result shape.
