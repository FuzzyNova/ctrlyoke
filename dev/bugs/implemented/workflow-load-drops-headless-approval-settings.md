# Loading a workflow drops `toolPermissions.headlessApprovals` and its timeout

- **Found:** 2026-11-17 by Claude (live dashboard test of headless approvals)
- **Area:** `src/core/orchestration/PromptFileLoader.ts` (`populateSettingsDefaults`)
- **Resolution:** fixed in this commit

## Symptom

A workflow file with
`toolPermissions: { mode: custom, allowedTools: [...], headlessApprovals: ask, headlessApprovalTimeoutSec: 120 }`
ran its headless Claude steps with `--permission-mode dontAsk` and never asked for approval.
The run's working copy had `toolPermissions` without `headlessApprovals` or the timeout.

## Steps to Reproduce

1. Author `toolPermissions` with `mode`, `allowedTools` and `headlessApprovals: ask`, but no
   `deniedTools`.
2. Load the file and run it.
3. Inspect `run-*/workflow.ctrlyoke.json`: the two headless approval fields are gone.

## Root Cause

When an authored `toolPermissions` object lacks `mode`, `allowedTools` or `deniedTools`,
`populateSettingsDefaults` builds a replacement with only those three fields, filling the
missing ones from settings. Callers then assign it over the authored object, so every other
sub-field was discarded.

## Fix

Spread the authored object first, then fill the three seeded fields. Covered by
"keeps authored headless approval fields when filling missing sub-fields" in
`PromptFileLoader.test.ts`.
