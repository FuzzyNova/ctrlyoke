# A late paste/capture reply can insert a reference into a different step's prompt

- **Found:** 2026-10-25 by bug-drain review of 5e1c8aa2b
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`
- **Severity:** medium

## Symptom

Paste an image into step A's prompt, then switch to step B (or toggle bulk mode,
which sets the editor value to `""`) before the attachment-save reply arrives. When
the reply lands, `@./.ctrlyoke/attachments/<file> ` is inserted into step B's prompt
and saved through `onChange`. This happens even when B is externally managed or
read-only, because a programmatic `view.dispatch` bypasses `readOnly`.

A second, smaller symptom: if the user types inside the `[Pasting image…]`
placeholder before the reply arrives, the reference is inserted at the placeholder's
start and the edited placeholder text is left behind.

## Steps to Reproduce

1. In the dashboard prompt editor, paste an image into step A.
2. Before the save reply arrives (slow route queue), select step B.
3. When the reply arrives, step B's prompt gains the attachment reference.

## Root Cause

`PromptEditor.tsx` (around line 1443) reuses one `CodeMirrorEditor` across steps (no
`key`). When `value` changes, the external value-sync effect in `CodeMirrorEditor.tsx`
(around lines 1291-1304) replaces the whole document. The pending placeholder's
tracked range maps to the end of the new text. `resolvePendingPlaceholder` (around
lines 661-672), added in 5e1c8aa2b, inserts the reference at the mapped `from` even
when the placeholder text is no longer there; it only skips removing it. The old
code searched for the placeholder text, found nothing, and showed a notification.

The 5e1c8aa2b test "two pending pastes" in `CodeMirrorEditor.test.tsx` also passes
on the pre-fix code, so it does not cover the swap it was written for.

## Suggested Fix

- Track _why_ a placeholder is gone. Only the 5-minute timeout path (which removed the
  placeholder itself) may insert a late success at the mapped position. If the user
  deleted or edited the placeholder, or the document was replaced by a value sync
  (clear pending entries, or mark them orphaned, in the value-sync effect), fall back
  to the old notification and insert nothing.
- Never dispatch the insert while the editor is read-only.
- Tests (must fail on current code): value replaced mid-paste leads to no insertion
  and a notification; placeholder edited by the user leads to no insertion; the timeout
  path still inserts a late success. Fix the "two pending pastes" test so it actually
  fails on the pre-5e1c8aa2b nearest-match logic, or delete it if that's not possible.
