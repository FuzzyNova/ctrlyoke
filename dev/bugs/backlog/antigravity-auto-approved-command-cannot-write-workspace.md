# Antigravity `auto`: a judge-approved command cannot write the workspace on Windows

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1, live case
  "antigravity-cli: auto runs an unlisted benign command chained to an allowed one"
  (`src/test/harness/inline-config.harness.test.ts`), agy 1.5.9 on Windows 11
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts` (`prepare`, `AUTO`)
- **Severity:** medium

## Symptom

In a headless Antigravity step with `toolPermissions.mode: auto`, agy's judge approves the
unlisted command and runs it, but the command cannot write inside the workspace:

```
Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
starting
SHELL_PROBE_EXECUTED
marker write failed: EPERM
```

The marker path is inside the case's workspace. The case fails with "marker missing". It fails
the same way on 4aef9927e, before the stdin and session-control work, so this is not caused by
inline stdin prompts.

## Steps to Reproduce

1. `npm run compile-tests`
2. `npx mocha --ui tdd --exit --timeout 900000 "out/test/harness/**/*.test.js" --grep "antigravity-cli: auto runs an unlisted benign"`
3. The recorded `bashCommand` event shows the command ran and the write failed with `EPERM`.

## Root Cause

Not traced. The case's comment says agy's `auto` "runs commands in its own sandbox, which still
lets them write the workspace (1.5.8)". On 1.5.9 that sandbox evidently refuses the workspace
write, the same symptom ctrlyoke saw when it used to pass `--sandbox` to agy on 1.4.12
(`MARKER_SCRIPT` comment). The PowerShell `InitializeDefaultDrives` warning suggests the command
runs under a restricted token. ctrlyoke passes no `--sandbox` in `auto`, so the sandboxing comes
from agy's auto mode itself.

## Suggested Fix

Probe agy 1.5.9 `auto` directly (outside ctrlyoke) with a command that writes the workspace, to
confirm it is agy's own sandbox and whether a setting or flag lets approved commands write the
workspace. If agy offers no way, record the limitation in `docs/harnesses/antigravity-cli.md`,
mark the claim in `KNOWN_BROKEN_CLAIMS` or narrow the case to agy versions where it holds, and
report the regression upstream.
