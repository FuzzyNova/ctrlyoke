# OpenCode `permissionRequest` hook never fires

- **Found:** 2026-10-21 by a research subagent (OpenCode minimum-version review), from OpenCode source
- **Area:** `src/scripts/ctrlyoke-opencode-plugin.ts` (around the `"permission.asked"` hook)
- **Resolution:** fixed in this commit

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

## Resolution details

The plugin now handles OpenCode 1.19.4's `permission.asked` event in its generic `event` callback and runs the workflow hook. The SDK declares a `permission.ask` plugin hook, but the installed runtime did not invoke it. The bus event has no decision response channel, so OpenCode permission hooks notify only; allow/deny decisions are listed as unsupported. The custom-mode OpenCode harness case verifies hook delivery against 1.19.4.
