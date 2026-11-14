# Permissions guide says headless `auto` (and Antigravity `allowAll`) skip the limited-permissions warning

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing 5ac6c4cfe
- **Area:** `docs/workflows/permissions.md` ("Headless runs")
- **Resolution:** fixed in this commit

## Symptom

The guide said ctrlyoke warns once "when a headless step starts with a mode
other than `allowAll`, `auto`, or `dangerouslyAllowAll` (on Antigravity, other
than `dangerouslyAllowAll`)". Both halves are wrong:

- A headless `auto` step **does** get the "Headless mode with limited tool
  permissions" warning.
- A headless Antigravity `allowAll` step does **not** get it.

## Steps to Reproduce

1. Run a headless step with `toolPermissions: { mode: auto }` on any harness.
2. The headless-permissions warning appears, contrary to the guide.

## Root Cause

`CliIntegration.warnIfHeadlessWithoutPermissions` skips the warning only when
the mapper's `hasFullPermissions` is true. The base implementation
(`src/core/harness/shared/interfaces/IToolPermissionMapper.ts`) and the
Antigravity override (`AntigravityToolPermissionMapper.hasFullPermissions`)
both return true for exactly `allowAll` and `dangerouslyAllowAll`. Keeping
`auto` out is deliberate: `dev/implemented/AUTO_PERMISSION_MODE_PLAN.md` says
"`hasFullPermissions` stays `false` for `auto`. The judge can refuse in-band
headless, so the existing headless-permissions warning is still accurate."
The docs commit 5ac6c4cfe described the opposite.

## Suggested Fix

Correct the sentence to name `allowAll` and `dangerouslyAllowAll` as the only
exempt modes on every harness, and say why `auto` still warns.
