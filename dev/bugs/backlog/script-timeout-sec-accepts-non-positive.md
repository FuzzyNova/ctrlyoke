# `execution.scriptTimeoutSec` accepts `-1`/`0`, which kill every script at once or disable the timeout

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `schemas/settings-schema.json`, `src/utils/ConfigurationUtils.ts`
- **Severity:** low

## Symptom

`execution.scriptTimeoutSec` is the only numeric setting in the settings schema with no
`minimum`:

- `-1` passes validation, but `getScriptTimeoutMs()` returns `-1000`, and every pre-condition,
  end-condition and script step fails immediately with `Process timeout after -1000ms`. Sibling
  timeouts (`maxPromptTimeoutSec`, `maxWorkflowExecutionTimeSec`) use `-1` to mean unlimited, so
  `-1` is the value a user would naturally try.
- `0` silently disables the timeout, because the process manager treats `0` as falsy.

The dashboard enforces `min={1}` (`ExecutionSection.tsx`), and a script's own `timeoutSec` has
`exclusiveMinimum: 0`, so only hand-edited settings files hit this.

## Steps to Reproduce

1. Put `{"execution": {"scriptTimeoutSec": -1}}` in `.ctrlyoke/settings.json`.
2. Run any workflow with a script step. It fails at once with `Process timeout after -1000ms`.

## Root Cause

`settings-schema.json` (around line 448) has no lower bound, and
`ConfigurationUtils.getScriptTimeoutMs` converts the raw value without validating it.

## Suggested Fix

Add `"exclusiveMinimum": 0` to the setting (or support `-1` as unlimited through the shared
`isUnlimited` helper, like its siblings, and document it). In either case, make
`getScriptTimeoutMs` fall back to the default for out-of-range values. Regenerate
`docs/reference/settings.md` with `npm run generate-schema-docs`, and add a unit test.
