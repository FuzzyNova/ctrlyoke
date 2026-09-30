# Output-tab switches from history search/commit use the wrong key, and prior-context token counts are cached forever

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code
- **Area:** `src/ui/webview-react/components/search/HistorySearchDrawer.tsx` (~323), `src/ui/webview-react/components/settings/CommitSection.tsx` (~91), `src/ui/webview-react/hooks/useAttachmentTokenCount.ts` (module cache ~28, key ~115)
- **Severity:** low

## Symptom

1. **Output tab.** `activeOutputTabs` is read by the active workflow *instance id*.
   `OutputSection.tsx` reads it that way, and every other writer uses that key
   too. `HistorySearchDrawer` and `CommitSection` ("View full output") write
   `setActiveOutputTab(<workflowKey>, OUTPUT)` instead, which creates a dead entry.
   If the Terminal tab is showing and the result is in the workflow already on
   screen, the pane stays on Terminal, so the result and its find highlight are
   never shown. `CommitSection.test.tsx` (~126) asserts the workflowKey-keyed entry,
   which locks the bug in.
2. **Prior-context token count.** `$previous` / `$step:N` token counts are cached in
   a module-level map keyed only by the reference text and step position. The
   extension computes them from the currently viewed run's output. So a count
   cached as 0 while drafting (no output yet) stays 0 after the run produces
   output. Switching to another workflow or run also reuses the old count for the
   same position, until the webview reloads.

## Suggested Fix

1. Apply the tab switch to the instance id that will display the result. Either
   apply it directly when the target is the current lineage, or store a
   "force output tab" intent that is applied when the navigated run view loads.
   Update the test.
2. Either don't cache prior-context refs, or include the displayed
   `workflowKey`/`runRef` and an output revision in the key. The alternative is to
   clear prior-context entries when a run view loads, execution starts, or a step's
   status changes. Add hook tests.
