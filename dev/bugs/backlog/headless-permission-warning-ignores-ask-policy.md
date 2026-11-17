# Headless "limited tool permissions" warning ignores `headlessApprovals: ask`

- **Found:** 2026-11-17 by Claude (live dashboard test of headless approvals)
- **Area:** `src/core/harness/CliIntegration.ts` (`warnIfHeadlessWithoutPermissions`)
- **Severity:** low

## Symptom

A headless step with `toolPermissions.mode: custom` and `headlessApprovals: ask` still shows
the toast "Headless mode with limited tool permissions: there is no interactive approval
prompt, so tools that are not explicitly allowed will be auto-denied." On harnesses that honor
`ask` (Claude, Qwen, Codex 0.146+, Copilot 1.0.112+ outside `auto`, OpenCode 2.3+), the
dashboard does offer an approval prompt, so the warning is wrong.

## Steps to Reproduce

1. Run a headless Claude step with `mode: custom` and `headlessApprovals: ask`.
2. The warning toast appears at step start.

## Root Cause

`warnIfHeadlessWithoutPermissions` checks only the execution mode and
`hasFullPermissions(toolPermissions)`. It does not consider `headlessApprovals`.

## Suggested Fix

Skip or reword the warning when `headlessApprovals` is `ask` and the active channel supports
approvals for this harness, version and mode. Decide that from the same capability gate the
channel uses rather than a harness list in `CliIntegration`. Antigravity and other unsupported
cases keep the current wording. Without a connected dashboard, `ask` still denies, so the
reworded text could say requests are denied unless a dashboard answers them.
