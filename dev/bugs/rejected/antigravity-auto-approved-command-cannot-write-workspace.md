# Antigravity `auto`: a judge-approved command cannot write the workspace on Windows

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1, live case
  "antigravity-cli: auto runs an unlisted benign command chained to an allowed one"
  (`src/test/harness/inline-config.harness.test.ts`), agy 1.5.9 on Windows 11
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts` (`prepare`, `AUTO`)
- **Resolution:** documented upstream Antigravity sandbox limitation; no supported per-run setting lets Auto commands write the workspace

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

The PowerShell `InitializeDefaultDrives` warning and `EPERM` show that agy's terminal sandbox
blocks the write. The original 1.5.9 live case showed the Auto judge approved the command, but the
sandbox still refused its workspace write. This checkout's probe used agy 1.5.11 on Windows 11:
`agy --help` had no sandbox-disable option, and the `--settings` probe with
`agentMode: "auto"`, an explicit command allow, and an exact `write_file` allow still returned
`EPERM`. Adding `enableTerminalSandbox: false` to the session settings also did not permit it.
The account reported Auto unavailable for the direct `--mode auto` launch, so the 1.5.11 probe
could not exercise an active Auto judge. The installed help and settings plus Google's CLI docs
show that Auto enables the terminal sandbox automatically; no supported per-run option disables
that sandbox while keeping Auto approval.

## Resolution

`docs/harnesses/antigravity-cli.md` now documents the Windows write failure and its limits.
`permissions.autoMode` is listed in `KNOWN_BROKEN_CLAIMS`, and the stale harness comment no longer
claims Auto's sandbox lets the write through. Use a harness with writable workspace access for
steps that need shell commands to create or edit files.
