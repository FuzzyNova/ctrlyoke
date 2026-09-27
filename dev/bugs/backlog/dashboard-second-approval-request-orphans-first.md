# A second batch-approval or choice request replaces the first in the dashboard, which then never settles

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/ui/webview-react/store/batchApprovalStore.ts`, `src/ui/webview-react/store/choiceStore.ts`
- **Severity:** medium

## Symptom

If two approval requests are outstanding at once, the dashboard shows only the newest.
The earlier request's promise never settles, so whatever is awaiting it (such as a
workflow start) hangs until the panel is disposed.

This can happen when two workflows start close together and each needs a decision, for
example workflow A's external-root approval (`WorkflowOrchestrator.ts:~2637`) and
workflow B's secret-grant approval (`~4941`), or when the startup and
workspace-trust-granted external-root prompts in `extension.ts` overlap.

Reproduced in vitest with the real `WebviewUserInteractionPort` wired to the real store,
using the same round-trip the message handler performs:

```
MODAL SHOWS: wf-B
SECOND: {"approvedValues":["a"],"deniedValues":[]}
FIRST SETTLED: false PENDING MODAL: null
```

## Steps to Reproduce

1. Issue two `requestBatchApproval` calls through `WebviewUserInteractionPort` before
   the first is answered.
2. The modal shows the second request. Answer it.
3. No modal remains, and the first request's promise is still pending.

## Root Cause

`batchApprovalStore.ts:21`, `setPendingRequest: (request) => set({ pendingRequest: request })`,
overwrites whatever is pending without answering it. `choiceStore.ts:18` has the same
pattern. `WebviewUserInteractionPort` keeps each request in a `Map` keyed by id
specifically so several can be pending at once, and its doc comment says callers must
never be left awaiting forever. The single-slot stores defeat that.

## Suggested Fix

Make both stores hold a FIFO queue of requests. The modal renders `queue[0]`, and
`respond`/`dismiss` answer and pop the head, so the next request appears. Share the queue
logic between the two stores (a small generic helper) rather than duplicating it.
Add vitest coverage in `src/ui/webview-react/test/**`: two requests queued → first shown;
answering it sends a response with the first id and shows the second; answering that
sends the second id and leaves nothing pending; dismiss behaves the same way.
