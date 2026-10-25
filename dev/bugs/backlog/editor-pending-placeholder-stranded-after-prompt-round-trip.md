# Editor paste placeholder is stranded when the user switches prompts and comes back

- **Found:** 2026-10-25 by bug-drain review of a14eb8548
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` (pending paste/capture entries, value-sync effect, `resolvePendingPlaceholder`, `removePendingPlaceholder`)
- **Severity:** medium

## Symptom

a14eb8548 stopped a late image-paste reply from landing in another step's prompt. But if
the user switches away and back before the reply arrives, the literal `[Pasting image…]`
placeholder stays in the original prompt forever: the reply only shows a "Pasted image
saved at …" notification, and the 5-minute cleanup never removes the placeholder. The
placeholder text is then saved and sent to the harness. Before 5e1c8aa2b the text-search
resolver re-found and replaced it.

## Steps to Reproduce

1. Paste an image into step A's prompt. `onChange` saves the placeholder into A's prompt.
2. Switch to step B (or toggle bulk mode, which sets the value to `""`). The value-sync
   effect clears `placeholderPresent` and `removedByTimeout` on every pending entry.
3. Switch back to A before the reply. A's text still contains the placeholder.
4. The save reply arrives: `hasPlaceholder` and `removedByTimeout` are both false, so
   nothing is inserted, and `removePendingPlaceholder` returns early because
   `placeholderPresent` is false.

## Root Cause

Pending entries are orphaned on any value swap (value-sync effect around lines
1315–1322) with no notion of which document they belong to, so they cannot be re-attached
when that document returns (`resolvePendingPlaceholder` around line 670,
`removePendingPlaceholder` around 685).

### Related

- **Medium/low, pre-existing:** `pasteSeqRef`/`captureSeqRef` (around lines 373, 378)
  start at 0 in every editor instance and every instance listens on `window` (around
  993). `EditorSection` renders in three layout branches of `App.tsx`, so a layout change
  remounts the editor; a late reply for seq 1 from the old instance resolves the new
  instance's seq-1 placeholder with the wrong file. Use a module-level counter or a
  per-instance nonce in the request id and match it in the reply.
- **Low:** a success reply while the prompt is read-only (around line 663) deletes the
  entry and its removal timer before the read-only early return, so the placeholder text
  stays once the step is editable again. Keep the entry (or the reply) and apply it when
  editable again, or let the removal timer run.
- **Low, uncertain:** if the view is rebuilt by the setup effect (deps around
  1276–1286, `doc: value` around 1018) at the same time the prompt changes, the value-sync
  effect sees equal text and does not orphan entries. Orphan/reset entries in the setup
  effect too.
- **Test gap:** the existing "keeps two pending paste replies…" test
  (`CodeMirrorEditor.test.tsx` around line 1386) passes even on pre-5e1c8aa2b code; the
  previous bug doc asked for it to be fixed or deleted.

## Suggested Fix

Give pending entries a document identity. `PromptEditor` already knows which step/prompt
it is editing; pass a stable document key prop to `CodeMirrorEditor` (keep it optional so
other callers are unaffected) and record it on each pending entry. On a value swap, keep
entries but mark them detached; when the editor's document key returns to an entry's key,
re-locate its placeholder text in the new value (nearest match to the last known offset)
and re-attach it. A reply for a detached entry whose document is not current only
notifies, as now; the removal timer must still clean the placeholder when its document is
current. Fix the seq collision and read-only issues above.

Tests (Vitest, `src/ui/webview-react/test/components/editor/CodeMirrorEditor.test.tsx`):
A→B→A then reply → placeholder replaced in A; A→B→A then reply lost → placeholder removed
by the timeout; bulk-mode on/off round trip; remount-seq collision; output-capture variant
of A→B→A; fix or delete the vacuous test above.
