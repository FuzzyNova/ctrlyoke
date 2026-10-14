# Step-level Claude Allowed Tools diagnostic still warns "only partially translated"

- **Found:** 2026-10-14 by Claude Code (bug-drain review of `claude-allowed-tools-warning-says-ignored`)
- **Area:** `src/types/CompatibilityAnalyzer.ts`, `src/types/CompatibilityTypes.ts`
- **Severity:** low

## Symptom

`claude-allowed-tools-warning-says-ignored` (fixed in 6e9880e9a) changed only the workflow-level
aggregate in Workflow Properties → Permissions. That aggregate now reads "Enforced for 2 Claude Code
steps, but Claude's own settings allow rules can add to this list in headless mode" at info severity.

The target-level analyzer was not changed. Wherever its diagnostics appear directly, a Claude step
with `toolPermissions.mode: custom` and a non-empty `allowedTools` still gets a **warning**:

> Allowed Tools are only partially translated by the Claude Code harness; Claude's own settings
> allow rules can add to this list in headless mode.

It also gets the remediation "Narrow the rule to the supported subset or select a harness with exact
list support." These surfaces include the step Properties drawer's Permissions page
(`PropertiesDrawer.tsx` via `diagnosticsForPermissionField`), the workflow panel when no capability
snapshot is available yet (it falls back to the raw `allowedDiagnostics`), and any CLI/validation
output that prints analyzer diagnostics. Claude translates the list exactly (`--permission-mode
dontAsk` plus `--allowedTools`). The only caveat is that the user's own settings can widen it, so
both "partially translated" and the advice to narrow the rule are wrong.

## Steps to Reproduce

1. Open a workflow with `harness: claude-cli`, `toolPermissions.mode: custom`, and
   `allowedTools: [write, "shell(npm test)"]` set on a step (or inherited by it).
2. Open that step's Properties drawer → Permissions.
3. Allowed Tools shows a yellow "only partially translated" warning with the "Narrow the rule"
   remediation.

## Root Cause

- `CompatibilityAnalyzer.ts:518-536` emits `ALLOWED_TOOLS_PARTIAL` at
  `COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING` for every `partial` fidelity, whatever the reason.
- `CompatibilityTypes.ts:298-301` words every `*_PARTIAL` as "only partially translated", and
  `:357-359` attaches the "Narrow the rule" remediation.
- `ClaudeToolPermissionMapper.ts:33-38` declares `allowedTools` as `partial` with
  `caveatCode: CLAUDE_PREAPPROVED_SETTINGS`. That kind of caveat means "enforced, but can be
  widened", not "partly translated", and the capability model has no way to tell the two apart.

The 6e9880e9a fix also tells caveat kinds apart by sniffing the prose. Three places check whether
the message `startsWith("because ")`: `CompatibilityTypes.ts:277`,
`compatibilityDiagnostics.ts:158` and `scripts/generate-compatibility-docs.mjs:255`. In addition,
`workflowPermissionDiagnostic` treats any `partial` + `caveatCode` as "enforced"
(`hasEnforcedCaveat` in `compatibilityDiagnostics.ts`). That holds today only because Claude's
`allowedTools` is the sole partial list capability.

## Suggested Fix

Make "enforced with a widening caveat" a structured fact rather than a prose convention:

1. Classify caveat codes in `CompatibilityTypes.ts`: either a reason the capability is not (fully)
   enforced, or an advisory note on an enforced capability. A map such as
   `ADVISORY_CAVEAT_CODES` / `isAdvisoryCaveat(code)` works, and `CLAUDE_PREAPPROVED_SETTINGS` is
   the advisory one.
2. In `CompatibilityAnalyzer.ts`, emit a partial permission-list state with an advisory caveat at
   `COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO`, with "enforced" wording such as "Allowed Tools are
   enforced by the Claude Code harness, but Claude's own settings allow rules can add to this list
   in headless mode." and without the "Narrow the rule" remediation. Either add a dedicated
   diagnostic code (for example `ALLOWED_TOOLS_ENFORCED_WITH_CAVEAT`) or branch inside the message
   and remediation functions.
3. Replace the three `startsWith("because ")` checks and `hasEnforcedCaveat` with the
   classification from step 1. The generator script must produce the same
   `docs/harnesses/compatibility.md` (`npm run check:docs` must pass).
4. Make sure the tab-icon warning badges stay off for info-only permission diagnostics in both
   `WorkflowPropertiesPanel.tsx` and `PropertiesDrawer.tsx`.
5. Tests: analyzer unit test (Claude allowedTools → info, advisory wording, no remediation) and
   update `src/ui/webview-react/test/utils/compatibilityDiagnostics.test.ts` and any analyzer/
   message tests that assert the old wording.
