# Pending editor placeholders follow step indices and can share one placeholder

- **Found:** 2026-10-25 by bug-drain review of a40102a43
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`, `src/ui/webview-react/components/editor/PromptEditor.tsx`
- **Severity:** low

## Symptom

a40102a43 (dev/bugs/implemented/editor-pending-placeholder-stranded-after-prompt-round-trip.md)
reattaches pending paste/capture placeholders by `documentKey`. Remaining gaps:

1. **The key is the step's index.** `PromptEditor` passes
   `JSON.stringify([activeWorkflowId, selectionTarget])` (around line 1447), and
   `selectionTarget` is index-based (`queue:2`). Inserting, deleting or reordering a step
   above the pasted-into step changes its key, so its placeholder is stranded again (the
   original bug), and a different step that now has the old key adopts the pending entry.
   (The worst consequence, a timed-out reply inserted into the other step, was fixed in the
   review commit by clearing `removedByTimeout` on detach.)
2. **Reattach is not one-to-one.** `attachPendingPlaceholders` (around lines 726–759) lets
   each entry take the nearest matching `[Pasting image…]` independently, so after an outside
   change shifts text two entries can claim the same placeholder: one placeholder is stranded
   and images land out of order.
3. **Detached entries leak.** A reply or removal that arrives while detached never deletes
   the entry; if its document never comes back, the entry and its timers live for the
   editor's lifetime, and "Still waiting…" can fire after the reply already arrived.

## Suggested Fix

- Key pending entries by a stable step identity if one exists (check the workflow step
  model for an id; otherwise document why the index is the best available and skip item 1).
- Assign placeholder matches greedily (closest first) and exclude ones already claimed.
- When a reply or final removal arrives for a detached entry, delete it and clear its
  timers (a late reply's path is already surfaced in a notification).
- Tests in `src/ui/webview-react/test/components/editor/CodeMirrorEditor.test.tsx`; also add
  the output-capture A→B→A case the original bug doc asked for, and fix or delete the vacuous
  "keeps two pending paste replies…" test it flagged.
