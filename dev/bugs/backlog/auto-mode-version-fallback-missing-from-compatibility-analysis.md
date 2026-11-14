# The editor never warns that `auto` will fall back to `custom` on an old or unknown CLI version

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing the `auto` permission mode commits (821990c3f..3a701824a)
- **Area:** `src/types/CompatibilityAnalyzer.ts` (`autoModeFieldState`, the unverified-diagnostic branch), `src/core/harness/shared/interfaces/IToolPermissionMapper.ts` (`prepareAutoModeFallback`), the per-harness `*_AUTO_MODE_MIN_VERSION` constants
- **Severity:** low

## Symptom

A step with `toolPermissions: { mode: auto }` on a harness whose installed CLI
is older than ctrlyoke's auto-mode gate, or whose version could not be
detected, shows no warning in the dashboard, the dry run, or `ctrlyoke
validate`. At launch the same step runs as `custom` (for Claude headless,
`--permission-mode dontAsk`) and only then reports
`compatibility.permissions.autoMode.fallback`.

The Copilot interactive case (declared `unsupported` through a mode override)
is reported at authoring time, so the two fallback causes disagree.

## Steps to Reproduce

1. Have Claude Code older than 2.1.170 installed (or make its `--version`
   fail so the version is unknown).
2. Give a step `toolPermissions: { mode: auto }` on `claude-cli`.
3. `analyzeCompatibility` (Permissions field, dry run) reports nothing.
4. Run the step: it launches with `--permission-mode dontAsk` and the
   `AUTO_PERMISSION_MODE_FALLBACK` warning.

## Root Cause

- `prepareAutoModeFallback` falls back when the CLI is below the mapper's
  `minVersion` (`CLAUDE_AUTO_MODE_MIN_VERSION` `>=2.1.170`, Copilot `>=1.0.4`,
  Codex `>=0.167.2`, Qwen `>=0.27.2`, agy) or the version is unknown.
- At authoring time, `HarnessCapabilityRegistry.resolveDeclaration` keeps the
  declared `exact` fidelity whatever the installed version; an old or unknown
  version only sets `verification: "unknown"`.
- `CompatibilityAnalyzer` then emits nothing for `autoMode`: `exact` has no
  fidelity diagnostic code, and the unverified branch explicitly skips
  `key === PERMISSION_CAPABILITY_KEYS.AUTO_MODE`
  (#selection:src/types/CompatibilityAnalyzer.ts:702-712).
- The `autoModeFieldState` comment says the analyzer and mapper read the same
  declaration "so both report the same fallback"; that holds for mode
  overrides but not for the version gate, which lives only in the mappers.

## Suggested Fix

Give the version gate one source both sides read. For example, put each
harness's minimum version on its `autoMode` declaration (or use
`autoMode.verification.verifiedVersions` as the gate, which already equals
the mapper constant for every harness), have `prepareAutoModeFallback` read
it from `this.capabilities.autoMode`, and have the analyzer emit
`AUTO_PERMISSION_MODE_FALLBACK` (warning) for a used `autoMode` whose
installed version is below the gate or unknown. Delete the per-mapper
`*_AUTO_MODE_MIN_VERSION` duplicates.

Tests: in `CompatibilityAnalyzer.test.ts`, an installed snapshot with
`autoMode.verification: "unknown"` (old version, and no version) emits the
fallback diagnostic; a verified version emits nothing. Keep the mapper tests
for an undefined and an old `cliVersion` falling back to `custom`.
