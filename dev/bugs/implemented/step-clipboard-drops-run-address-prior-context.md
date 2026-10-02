# Copying, pasting or inserting a step silently drops a run-address `priorContext`

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reviewing the `$previous:N` change (8f317f5cd); confirmed against compiled `out/`
- **Area:** `src/core/WorkflowStepSanitizer.ts` (`clonePriorContext`)
- **Resolution:** fixed in this commit

## Symptom

A step whose `priorContext` points at another run
(`priorContext: { workflowKey: "wf", runRef: "run-…Z" }`) loses that field when
the step is copied and pasted (Copy Step / Paste Step in the dashboard) or
inserted through the sanitizer-backed insert paths. The pasted step runs with
no prior context and nothing warns the user.

## Steps to Reproduce

1. `sanitizeClipboardWorkflowStep({ prompt: "x", priorContext: { workflowKey: "wf", runRef: "run-2026-01-01T00-00-00-000Z" } })`
2. Expected: the result keeps `priorContext` with the same address.
3. Actual: `{ "prompt": "x" }`. The same round trip with `{ previous: 3 }`, `"all"`
   or `[1, 2]` keeps the value.

## Root Cause

`clonePriorContext` (`src/core/WorkflowStepSanitizer.ts` ~line 286) accepts
strings, finite-number arrays and (since 8f317f5cd) `{ previous: N }`, and
returns `undefined` for every other object. A `WorkflowRunAddress` is a valid
`PriorContext` variant (see `isWorkflowRunAddress` in
`src/types/CtrlYokeTypes.ts` and the schema `priorContext` `oneOf`), but it has
no branch, so `buildClipboardExecutionProperties` (~line 426) drops it.
Consumers include `serializeWorkflowStepForClipboard` /
`parseClipboardWorkflowStep` (dashboard `stepClipboard.ts`),
`WorkflowInstance.insertWorkflowStepAfterIndex`, and `WorkflowOrchestrator`
(~line 3779). Commit 8f317f5cd fixed the same "objects other than X are
rejected" mistake in `AddressedPriorContextResolver` and `PriorContextSelect`
but missed this function.

## Suggested Fix

Add a branch that copies a run address through the existing
`isWorkflowRunAddress` guard, copying only its known fields
(`{ workflowKey, runRef }`, plus any other fields the type defines). Write no
second validator. Add tests in `src/test/unit/WorkflowStepSanitizer.test.ts`
covering a run-address round trip through the clipboard serializer/parser and
the insert path, and checking that a malformed object (e.g. `{ workflowKey: 1 }`)
is still dropped.
