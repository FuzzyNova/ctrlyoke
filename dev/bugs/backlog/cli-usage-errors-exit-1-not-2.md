# CLI usage errors from Commander exit 1 instead of the documented 2

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/cli.ts`
- **Severity:** medium

## Symptom

`docs/cli/ctrlyoke.md` ("Exit codes") and `docs/cli/ci.md` document these exit codes:

- `2`: usage, parse, or unexpected error.
- `1`: the workflow failed, or a validation check failed.

Every parse error raised by Commander itself exits `1` instead. In CI, a mistyped flag is
therefore indistinguishable from a failed workflow.

## Steps to Reproduce

`npm run compile:extension`, then in any workspace:

```
node out/cli.js run wf.yaml --bogus               # unknown option            -> exit 1
node out/cli.js history runs                      # required option missing   -> exit 1
node out/cli.js run wf.yaml --var                 # option argument missing   -> exit 1
node out/cli.js validate --strict                 # missing required argument -> exit 1
node out/cli.js nosuchcmd                         # unknown command           -> exit 1
```

Expected: exit `2` for all of these.

## Root Cause

`src/cli.ts` creates the program with `new Command()` and never calls `exitOverride`, so
Commander's default exit code (1) applies. ctrlyoke's own usage checks already exit 2 (for example
`--harness bogus`, `--var` without `=`, or `run` with neither a file nor `--prompt`). Only
Commander-raised errors are inconsistent.

## Suggested Fix

Install `exitOverride` on the root program before any subcommand is registered (subcommands copy
the setting when they are created). Map every Commander error to the shared usage exit code
constant (see `CliExitCode.ts`), and keep `--help` and `--version` (`exitCode === 0`) at 0. Add a
test showing that an unknown option and a missing required option both exit 2.
