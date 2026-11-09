# History CLI errors print JSON to stdout without `--json`, and `import --json` uses a string error

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced against `out/cli.js`)
- **Area:** `src/cli.ts` (history command registration), `src/cli/RunImportCommand.ts`
- **Resolution:** fixed in this commit

## Symptom

1. `ctrlyoke history list|runs|show|steps|search` report every failure as the JSON error envelope
   on **stdout**, even when `--json` is not passed. Stderr stays empty, there is no `Error: ` prefix,
   and a pipe such as `ctrlyoke history show … | less` swallows the error:

   ```
   $ ctrlyoke history show --workflow <key> --step 5 >o.txt 2>e.txt; echo $?
   2
   o.txt: {"schemaVersion":1,"success":false,"error":{"message":"Invalid --step index: 5. This run has 3 steps, ..."}}
   e.txt: (empty)
   ```

   The same happens with `history runs --workflow nope`, `history steps --workflow nope`,
   `history list --limit 0`, `history list --sort bogus`, and `history search foo --since bogus`.
   By contrast `status --workflow nope` and `export --workflow nope …` print
   `Error: Workflow lineage "nope" was not found…` to stderr.

2. `ctrlyoke import <dir> --json` failures write
   `{"schemaVersion":1,"success":false,"error":"/tmp/nonexist has no run.json."}`: `error` is a
   string, not the documented `{ "message": … }` object that `export --json` and every other
   history command emit.

## Steps to Reproduce

1. `npm run compile:extension`, then in a scratch workspace run a script-only workflow so history
   exists (or just use a missing key).
2. `node out/cli.js history runs --workflow nope; echo $?` → JSON on stdout, exit 2, nothing on
   stderr.
3. `node out/cli.js import /tmp/nonexist --json` → string-valued `error`.

## Root Cause

1. `src/cli.ts` (~356-385) registers `list`, `runs`, `show`, `steps` and `search` with
   `handleHistoryCommand(…, true, "history …")`, hard-coding `json = true`, so
   `reportCliError` (`src/cli/CliExitCode.ts` ~79) always takes its JSON branch. The `export`,
   `import` and `status` registrations correctly pass `options.json === true`. Introduced by
   f88a8bf97 (`refactor: centralize CLI error reporting`, unreleased).
2. `importRunCommand` (`src/cli/RunImportCommand.ts` ~197-210) catches its own errors under
   `--json` and writes a hand-built envelope with `error: message` instead of letting the shared
   `reportCliError` emit the standard one. `docs/cli/ctrlyoke.md` ("JSON errors", ~1048-1064)
   lists only `run`, `step` and `validate` as keeping non-standard error shapes, and its `import`
   section says invalid bundle data "emits the standard error envelope". `import` has not shipped
   in a release yet (absent from v0.5.1), so the shape can be corrected without a compatibility
   alias. `src/test/unit/RunImportCommand.test.ts` (~205) currently pins the string form.

## Suggested Fix

1. Pass `options.json === true` at the five history call sites (for `search`, the options object
   is the second handler argument).
2. Drop `importRunCommand`'s private JSON catch (or make it emit `error: { message }`) so failures
   go through `reportCliError` like `export`; keep exit code 2 for invalid bundles. Update the
   unit test to the standard envelope.
3. Add CLI tests proving a history subcommand without `--json` writes `Error: …` to stderr and
   nothing to stdout, and with `--json` writes the standard envelope to stdout.
