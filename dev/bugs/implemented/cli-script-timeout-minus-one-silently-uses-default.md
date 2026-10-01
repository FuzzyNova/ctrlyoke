# `--script-timeout -1` is accepted as "unlimited" but runs with the 3600s default

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); reproduced with `out/cli.js`
- **Area:** `src/cli/CliRunCommandDefinitions.ts` (`--script-timeout` ~169-172, `parseTimeoutSeconds` ~215-226), `src/utils/ConfigurationUtils.ts` (`getScriptTimeoutMs` ~411-419)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke run x.ctrlyoke.yaml --script-timeout -1` is accepted. `--script-timeout -5`
is rejected with `timeout "-5" must be a whole number of seconds, or -1 for unlimited`,
so the CLI tells users that -1 means unlimited. But `execution.scriptTimeoutSec` has
`exclusiveMinimum: 0`, and `getScriptTimeoutMs` replaces any value ≤ 0 with the 3600s
default. The run is neither unlimited nor using the user's configured value (for
example, a configured 2s becomes 3600s).

## Root Cause

`--script-timeout` reuses `--timeout`'s parser, which accepts `-1`. Only
`maxPromptTimeoutSec` supports `-1`.

## Suggested Fix

Give `--script-timeout` its own parser that requires a whole number greater than 0
and doesn't mention -1. Keep the -1 form only for `--timeout`. Add a CLI
option-parsing test.
