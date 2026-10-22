# OpenCode `permissionRequest` hook never fires

- **Found:** 2026-10-21 by a research subagent (OpenCode minimum-version review), from OpenCode source
- **Area:** `src/scripts/ctrlyoke-opencode-plugin.ts` (around the `"permission.asked"` hook)
- **Severity:** medium

## Symptom

A workflow `permissionRequest` hook on an OpenCode step is never called. The compatibility matrix
lists it as partially supported (decision contract unverified), but it does not fire at all.

## Steps to Reproduce

1. Add a `permissionRequest` hook to an OpenCode step whose permissions make OpenCode ask (custom
   mode with a tool left unlisted).
2. Run the step.
3. The hook's script never runs.

Found by reading the code, not by a run; confirm with a `test:harness` case.

## Root Cause

The plugin registers a hook named `"permission.asked"`. OpenCode's plugin API has no such hook;
the hook is `"permission.ask"`. A `permission.asked` _bus event_ exists, but the plugin's `event`
handler doesn't handle it. The research also found that `permission.ask` is never triggered in
OpenCode 1.3.0 and later, so renaming the hook alone may not be enough.

## Suggested Fix

Handle the `permission.asked` bus event in the plugin's `event` handler, or register
`permission.ask` if current OpenCode still calls it. Then decide whether the matrix should say
"Not supported" until a decision can actually be returned.
