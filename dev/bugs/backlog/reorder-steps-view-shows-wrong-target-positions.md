# reorder_steps tool view shows wrong target positions once steps have started

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/stepMutationModel.ts`
- **Severity:** medium

## Symptom

The `reorder_steps` MCP tool view renders `#from → #to` pairs whose targets are wrong whenever any step has already started. For a run where steps #1–#3 already ran and the model calls `reorder_steps {indices:[5,3,4]}`, the view shows `#6 → #1, #4 → #2, #5 → #3` (claiming steps moved into already-executed slots), while the server actually produced `#6 → #4, #4 → #5, #5 → #6`.

## Steps to Reproduce

1. Render the reorder view with params `{indices:[5,3,4]}` (steps 0–2 already completed).
2. Observe the pairs list targets `#1..#3`.

## Root Cause

`reorderStepPairs` maps `indices.map((from, to) => …)`, using the array position as the absolute destination. `indices` lists only the not-yet-started (movable) steps; `RunContinuationService.reorderStepsAtRun` places `absoluteOrder[k]` into the k-th movable slot counting up from `currentIndex` (skipping fixed/started slots), not into slot `k`. The existing test uses `[2,0,1]` starting at 0, which hides the bug.

## Suggested Fix

The movable slots are exactly the values of `indices` sorted ascending: `const slots = [...indices].sort((a, b) => a - b)` and render `displayIndex(from) → displayIndex(slots[k])`. Add a test where earlier steps have started.
