# Editor paste/capture placeholders stay in the prompt forever when the reply is lost

- **Found:** 2026-10-24 by bug-drain review of b1ed25588
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`, `src/ui/webview-react/components/output/MarkdownText.tsx`
- **Severity:** medium

## Symptom

- After pasting an image or capturing output, `[Pasting image…]` /
  `[Capturing output…]` can stay in the editor permanently and be saved into
  the step's prompt.
- With two pastes pending, each can be filled with the other's image reference.
- `MarkdownText`'s `pendingPreviewResolvers` grows without bound when previews never get an answer.

## Steps to Reproduce

1. In the hosted dashboard, paste an image into a prompt, then drop the socket
   before the host answers (the hosted shim drops outbound messages while
   reconnecting; off-queue replies are also suppressed after a client epoch change).
2. The timeout now only shows "Still waiting"; the placeholder is never removed.
3. For the swap: start two pastes, then type more than half the gap between them
   somewhere before both placeholders; the first reply replaces the second placeholder.

## Root Cause

b1ed25588 changed the paste timeout (around line 831) and capture timeout (around
line 731) in `CodeMirrorEditor.tsx` to keep the request alive so a late reply can
still apply. Nothing removes the placeholder when no reply ever arrives. Both
placeholders have identical text and the reply locates "its" placeholder by the
occurrence nearest the original offset (around lines 658-670), which is ambiguous.
In `MarkdownText.tsx`, an entry whose request timed out stays in
`pendingPreviewResolvers` until an answer arrives, so it is never removed if no answer comes.

## Suggested Fix

- Track each placeholder's position precisely: use a placeholder unique to each
  seq, or map its range through transactions (CodeMirror `StateField` + `mapPos`).
- Add a second, longer deadline (or listen for transport disconnect / component
  dispose) that removes the placeholder; if a late success arrives after removal,
  insert the reference at the mapped position (or cursor) anyway.
- Evict `pendingPreviewResolvers` entries after a long TTL.
