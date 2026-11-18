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

There is no static gate to consult. Whether `ask` can work is decided at spawn time:
`CliExecutionRunner` computes `useApprovalControl` (policy `ask` and mode `custom`/`auto`),
then each adapter's `createHeadlessControlChannel` returns a channel or `undefined` on its
own version and mode checks (Copilot returns none under `--assisted-approval` or before
1.0.112, Codex below 0.146, OpenCode below 2.3.0). The warning runs in `CliIntegration`
before any of that.

## Suggested Fix

Move the decision to where the answer is known: after `createHeadlessControlChannel` in
`CliTransportCoordinator`.

- Add an optional `answersApprovalRequests?: boolean` to `IHeadlessControlChannel`
  (`false` for Antigravity's stream-json channel, which has no approval vocabulary; true for
  the others). Do not keep a harness list in `CliIntegration`.
- If `useApprovalControl` is true, a channel exists, and it answers approval requests: no
  warning when `workflowContext.requestHeadlessApproval` is present; otherwise a reworded
  warning that approval requests are denied because no dashboard is connected to answer them.
- Otherwise keep today's text.
- Keep the once-per-integration flag and the `suppressHeadlessPermissionWarning` opt-out, so
  `CliIntegration` passes a callback or the coordinator reports a result for it to warn on.
- Tests: coordinator cases for channel+ask (no warning), ask without dashboard (reworded),
  no channel (current text), and Antigravity's channel (current text).
