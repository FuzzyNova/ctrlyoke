# `ctrlyoke uninstall --json` writes no JSON error envelope on failure

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/cli/CliUninstallCommand.ts`
- **Severity:** low

## Symptom

`docs/cli/ctrlyoke.md` ("JSON errors") promises that commands supporting
`--json` write failures to stdout as
`{ "schemaVersion": 1, "success": false, "error": { "message": … } }`.
`uninstall --json` does not:

- **(a) Bundled CLI:** run from the copy bundled with the VS Code extension, it
  writes `BUNDLED_CLI_UNINSTALL_MESSAGE` to stderr and exits 2 with **empty
  stdout**. Reproduced.
- **(b) Harness settings update failure:** it prints the normal info object
  (with `failedHarnesses`) to stdout and exits 2, without `success: false` or
  `error`. Found by reading the code; not reproduced (that needs a harness
  settings file that cannot be updated).

## Steps to Reproduce

```
$ node <extension>/out/cli.js uninstall --json ; echo $?
stdout: (empty)
stderr: This is the ctrlyoke CLI bundled with the VS Code extension. Uninstall the extension from VS Code instead; it cleans up after itself.
2
```

## Root Cause

`uninstallCommand` (`src/cli/CliUninstallCommand.ts:118-141`) ignores
`options.json` on the bundled path, and on the failed-harness path writes
`JSON.stringify(info)` without the failure fields.

## Suggested Fix

With `json` set, emit the shared error envelope (see `reportCliError` in
`src/cli/CliExitCode.ts`) on the bundled path. On the failed-harness path, add
`success: false` and an `error.message` built from
`formatCliUninstallFailures(info)` to the existing object, keeping its other
fields (additive). Keep the exit codes. Add unit tests for both paths.
