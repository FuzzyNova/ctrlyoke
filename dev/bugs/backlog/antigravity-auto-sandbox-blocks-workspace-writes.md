# Antigravity auto mode sandbox refuses workspace writes (agy 1.5.12, Windows)

- **Found:** 2026-11-19 by the 0.8.0 release `npm run test:harness` run
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts`
- **Severity:** medium

## Symptom

The live case `antigravity-cli: auto runs an unlisted benign command chained to an allowed one` in
`src/test/harness/inline-config.harness.test.ts` fails on agy 1.5.12 (Windows 11). The command runs
(`SHELL_PROBE_EXECUTED` prints) but the script's workspace write fails with `EPERM`, so the marker
file is never created. It passed on agy 1.5.8, where the plan recorded that "auto's sandbox still let
the command write the workspace".

## Steps to Reproduce

1. Settings file `{"toolPermission":"request-review","agentMode":"auto"}`.
2. `agy -p "Run exactly: node write-notes.js marker.txt" --settings <file>` in a scratch directory.
3. The script prints `write failed: EPERM`. With `agentMode: ""` the command is not run at all in
   headless mode (needs an allow rule), so the sandbox is specific to auto.

## Root Cause

Not ctrlyoke: ctrlyoke passes no `--sandbox`. Auto mode runs commands in agy's terminal sandbox, and
agy's 1.5.10+ changelog tightened sandbox defaults. Not confirmed which release changed the
workspace-write behavior on Windows.

## Suggested Fix

Re-check on each new agy release. If it persists, gate `auto` for agy to the versions that can write
the workspace (`autoModeMinimumVersion`/fallback in the mapper), or find an agy setting that widens
the sandbox's write roots. `versionPolicy.testedWith` for Antigravity is 1.5.12 despite this failing
case; the issue is public in `docs/troubleshooting/known-issues.md`. agy is closed source, so no
public tracker is known; report it through agy's `/feedback` or Google's channel if one exists.
