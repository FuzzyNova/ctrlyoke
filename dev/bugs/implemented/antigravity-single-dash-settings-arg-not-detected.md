# Antigravity `-settings` in additionalArgs is not detected, so the user's settings file is silently overridden

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

agy uses Go-style flags and accepts a single dash: on agy 1.4.12,
`agy -p /config -settings '{"toolPermission":"strict"}'` prints
`toolPermission strict`. The two spellings of the same flag get different
treatment:

- With `--settings x.json` in `defaults.additionalArgs["antigravity-cli"]`,
  ctrlyoke emits no permission args and reports the
  `antigravitySettingsCollision` diagnostic, as documented.
- With `-settings x.json` or `-settings=x.json`, ctrlyoke still appends its
  own `--settings <temp file>` and reports no diagnostic.

agy takes the last settings flag, and the permission args are appended after
`additionalArgs`, so the user's settings file is silently discarded. The
docs say a settings flag in `additionalArgs` takes precedence and turns the
translation off.

## Steps to Reproduce

1. Set `defaults.additionalArgs["antigravity-cli"]` to `-settings my.json`
   and use custom tool permissions.
2. Run an antigravity-cli step: the command line ends with ctrlyoke's
   `--settings <temp>`, and no collision note is shown.

## Root Cause

`hasSettingsFlag` (`AntigravityToolPermissionMapper.ts` around lines
388–392) only matches `--settings` and `--settings=`. `additionalArgs` are
placed in the base args (`AntigravityCliProvider.ts` around lines 346–348),
and the permission args are appended afterwards (`ExecutionPlanBuilder.ts`
around line 326).

## Suggested Fix

Also match `-settings` and `-settings=`. Add cases to the existing collision
test in the Antigravity `prepare` suite in
`src/test/unit/HarnessToolPermissionMappers.test.ts`.
