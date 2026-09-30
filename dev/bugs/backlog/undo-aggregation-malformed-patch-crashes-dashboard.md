# A malformed persisted patch still crashes the whole dashboard through undo aggregation

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent, scratch vitest)
- **Area:** `src/ui/webview-react/utils/promptUndo.ts` (`applyStructuredPatch`, `formatStructuredPatch`)
- **Severity:** high

Follow-up to `malformed-persisted-patch-crashes-entire-dashboard.md` (fabf4eb4a). That fix
normalized hunks in `DiffView` and added a per-`OutputRow` `ErrorBoundary`. However, `DiffView`
never calls jsdiff's `parsePatch`, so the crash that bug reported (`Hunk at line 3 contained invalid
line …`) almost certainly came from the undo aggregation path, and that path is still unguarded.

## Symptom

A step whose events are a `FILE_WRITE` to `src/new.ts` followed by a `FILE_EDIT` on the same file
with `structuredPatch.lines = [" a", "not a patch line", "+b"]` (and no snapshot) makes
`buildUndoCandidatesForOutputs` → `aggregateWorkflowUndoFiles` throw
`Hunk at line 3 contained invalid line …`. It runs inside the `workflowChangeData` `useMemo` in
`hooks/useOutputUndoActions.ts` (~l.229), called from `OutputSection.tsx` (~l.1243). That is outside
any per-row boundary, so the root boundary replaces the whole dashboard with the error screen.
It runs eagerly whenever undo actions are allowed (history view, or idle execution).

## Steps to Reproduce

A Vitest case builds the two events above and calls `aggregateWorkflowUndoFiles` (or renders
`OutputSection` with them). It throws instead of returning an undo candidate without that file.

## Root Cause

`formatStructuredPatch` writes the raw `hunk.lines` into a unified diff, and `applyStructuredPatch`
passes it to `Diff.applyPatch`. `applyPatch` parses the patch and throws on any line without a
` `/`+`/`-`/`\` prefix. The normalization helper added in fabf4eb4a
(`normalizeStructuredPatch` in `utils/diffUtils.ts`) is not used here.

## Suggested Fix

In `applyStructuredPatch`, run the hunks through `normalizeStructuredPatch` and wrap
`Diff.applyPatch` in `try/catch`, returning `undefined`. Callers (`composeAggregateDiff`,
`buildRedoAggregationPart`) already treat `undefined` as "couldn't compose". As defense in depth,
contain failures of the `workflowChangeData` memo too: catch, log with `WebviewLog`, and treat it as
"no workflow undo data". Add a regression test with the event sequence above.
