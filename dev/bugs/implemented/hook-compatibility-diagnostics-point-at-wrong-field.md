# Hook compatibility diagnostics point at the wrong JSON field when step hooks merge with workflow hooks

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/types/CompatibilityAnalyzer.ts`
- **Resolution:** fixed in this commit

## Symptom

When a step has its own `hooks` and the workflow also has `hooks`, hook compatibility diagnostics (unsupported, partial or unverified events) and portability side effects can carry a `propertyPointer` that names the wrong field. A workflow-level hook is reported under `/steps/<n>/hooks/<i>/event`, and the index can point at a different step hook or at one that does not exist. `ctrlyoke validate` and the portability report then send the user to the wrong place.

## Steps to Reproduce

1. Write a workflow with top-level `hooks: [{event: <A>, ...}]` and step 0 `hooks: [{event: <B>, ...}]`, where A and B are both partial or unsupported on the chosen harness.
2. Run `ctrlyoke validate` on it, or open the dry-run portability report.
3. `resolveHooks` returns `[A-hook, B-hook]` with source `"prompt"`.
4. The A-hook diagnostic shows `/steps/0/hooks/0/event`. That pointer is the step's B hook; the workflow hook is really at `/hooks/0/event`.
5. The B-hook diagnostic shows `/steps/0/hooks/1/event`, which does not exist because step 0 has only one hook.

Variant: workflow hooks `[A, B]` and step hooks `[B']` merge to `[A, B']`, so B' is reported at index 1 instead of 0.

## Root Cause

`src/types/ExecutionPropertyResolver.ts:227-239` (`resolveHooks`) merges workflow (or default) hooks and step hooks into one flat list keyed by event, and labels the whole list with source `"prompt"` without recording where each hook came from.

`src/types/CompatibilityAnalyzer.ts:387` (`analyzeConfiguredHooks`) and `src/types/PortabilityReport.ts:264` iterate that merged list and pass the merged index to `createHookDiagnostic` (`CompatibilityAnalyzer.ts:451-460`) and `getHookPointer` (`PortabilityReport.ts:390-404`). Both treat the index as a position in the step's own `hooks` array, and both use the aggregate source tier, so workflow hooks are attributed to the step.

The wrong pointer then surfaces in:

- `src/cli.ts:2512` — `ctrlyoke validate` output.
- `src/ui/webview-react/components/shared/PortabilityReportSection.tsx:116` and `:146` — property label for diagnostics and side effects.
- `src/core/ExecutionPreviewService.ts:1420-1428` — diagnostic dedupe key, so two distinct hooks can collapse or one hook can appear twice.

## Suggested Fix

Make `resolveHooks` record each hook's origin, e.g. a parallel array of `{ tier: "prompt" | "workflow" | "defaults", index }`, or return `{ hook, origin }` pairs. Build the pointer from that origin in one shared helper used by both `CompatibilityAnalyzer.createHookDiagnostic` and `PortabilityReport.getHookPointer`, removing the duplicated pointer logic:

- step hook: `${base}/hooks/<origin.index>/event`
- workflow hook: `/hooks/<origin.index>/event`
- defaults: no pointer

Set each diagnostic's `sourceTier` from the hook's own origin rather than from the aggregate source. Add a test with workflow hooks `[A, B]` and step hooks `[B']` that pins the expected pointers (`/hooks/0/event` for A, `/steps/0/hooks/0/event` for B').
