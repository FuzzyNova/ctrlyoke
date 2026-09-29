# `clearRuntimeStateFromStep` never clears streaming chunks

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/store/workflowStore.ts`
- **Severity:** low

## Symptom

On the continuation path of `EXECUTION_STARTED` (`useMessageHandler.ts` around line 1170,
`isContinuation` with `preserveStepCount > 0`), the store clears runtime state from the first
re-run step onward. Retry states and live context-window data are cleared, but streaming chunks
for those steps are kept. A step that was interrupted mid-stream and is then re-run can show the
old streamed text with the new text appended to it (`appendStreamingChunk` concatenates onto the
existing key).

## Steps to Reproduce

Verified with a throwaway vitest probe:

1. `appendStreamingChunk(0, "keep")`, `appendStreamingChunk(3, "stale")`.
2. `clearRuntimeStateFromStep(2)`.
3. The streaming chunks still hold both `"keep"` and `"stale"`. Expected: only `"keep"`.

## Root Cause

`workflowStore.ts` around line 1673 does `Number(key.split(":", 1)[0]) >= startStep`. Keys come
from `getStreamingChunkKey` (`src/types/DashboardConstants.ts` around line 4189), which has the
form `queue:<index>:run:<r>:attempt:<a>:<phase>:<kind>`. The first segment is the target kind, so
`Number("queue")` is `NaN` and the comparison is always false.

## Suggested Fix

Add a key parser next to `getStreamingChunkKey` in `DashboardConstants.ts` (same module, so the
format stays single-sourced). It should return `{ targetKind, targetIndex }`, and the store should
delete only `queue` keys whose index is `>= startStep`. Final-step keys are handled by their own
reset. Add a regression test for the scenario above.
