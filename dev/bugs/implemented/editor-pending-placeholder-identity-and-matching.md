# Pending editor placeholders follow step indices and can share one placeholder

- **Found:** 2026-10-25 by bug-drain review of a40102a43
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`, `src/ui/webview-react/components/editor/PromptEditor.tsx`
- **Resolution:** fixed in this commit

## Issues identified before the fix

a40102a43 (dev/bugs/implemented/editor-pending-placeholder-stranded-after-prompt-round-trip.md)
reattaches pending paste/capture placeholders by `documentKey`. Review identified these
remaining gaps:

1. **The key was the step's index.** The webview prompt model has no authored top-level
   step id, but `_runtime.stepId` is the existing stable queue-step identity and survives
   insert/delete/reorder during a run. New and unsaved steps can lack `_runtime.stepId`.
2. **Reattach was not one-to-one.** Each entry independently selected its nearest
   `[Pasting image…]` occurrence, so multiple entries could claim one placeholder.
3. **Detached entries leaked.** A reply or removal could leave the entry and its timers
   alive, allowing "Still waiting…" to fire after a reply arrived.

## Changes applied

- `PromptEditor` uses `_runtime.stepId` when available; drafts without a runtime id retain
  the `selectionTarget` fallback.
- Placeholder matches are assigned greedily, closest first, and each occurrence can be
  claimed only once.
- Replies and final removals for detached entries delete the entry and clear its timers.
- Tests cover the output-capture A→B→A round trip; the vacuous two-paste test was replaced
  with a case that reproduces duplicate matching.
