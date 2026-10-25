# A pending placeholder whose step is not shown is forgotten and stays in the prompt

- **Found:** 2026-10-25 by bug-drain review of 84d1bfa51
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` (`resolvePendingPlaceholder`, `schedulePlaceholderRemoval`, the reattach pass in the update listener)
- **Resolution:** fixed in this commit

## Symptom

84d1bfa51 (dev/bugs/implemented/editor-pending-placeholder-identity-and-matching.md) keys
pending paste/capture placeholders by step identity and, to stop entries leaking, now
**deletes** an entry that is detached (its document is not the one shown) when either its
reply arrives or its 5-minute removal deadline passes. That brings back the symptom
a40102a43 fixed (dev/bugs/implemented/editor-pending-placeholder-stranded-after-prompt-round-trip.md):

- **Reply while away:** paste an image into step A (`[Pasting image…]` is saved into A's
  prompt), switch to step B, and the reply arrives. `resolvePendingPlaceholder` deletes the
  entry and returns false. Back on A nothing is left to remove the placeholder, so it is saved
  and sent to the harness.
- **Timeout while away:** paste into A, stay on B past the removal deadline.
  `schedulePlaceholderRemoval` deletes the entry instead of setting `removalRequested`, so
  the reattach path that honours `removalRequested` never runs for it.

No test covers either case.

Secondary (low): the one-to-one reattach matching (closest-first greedy) can cross
assignments, so two placeholders that shifted together come back in reverse order. The test
added at "one-to-one" in `CodeMirrorEditor.test.tsx` asserts `second.png` before
`first.png`, which encodes the out-of-order symptom.

Process note: 84d1bfa51 rewrote the bug doc's Symptom/Suggested Fix sections instead of
`git mv` + Resolution line; not worth re-fixing, but keep the original text in future moves.

## Suggested Fix

1. Don't delete a detached entry on reply or timeout. Clear its "Still waiting" timer and
   record the outcome on the entry: `removalRequested = true` for a timeout or failure, and
   for a success reply store the resolved `@ref ` replacement. When the entry reattaches
   (its document is current again and its placeholder text is found), apply the stored
   outcome — remove the placeholder, or replace it unless the editor is read-only (then just
   remove it). Keep e5b62e2b6's guarantee: a late reply must never be inserted into a
   different document.
2. Bound the leak another way: drop entries on unmount, and drop detached entries after a
   long TTL (e.g. 30 minutes), logging via `WebviewLog`.
3. Make the reattach matching order-preserving: sort candidate entries by their last known
   `from` and assign placeholder occurrences in document order; change the test to expect
   first-then-second.
4. Tests: after returning to A, a success reply received while away has replaced the
   placeholder with its `@ref `; a failure reply or timeout while away has removed it; the
   reply is never inserted into B; two shifted placeholders keep their order.
