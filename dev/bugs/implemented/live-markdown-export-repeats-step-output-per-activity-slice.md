# Live markdown export repeats each step's full output once per streamed activity slice

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/utils/markdownExport.ts`
- **Resolution:** fixed in this commit

## Symptom

Exporting output (Export Output -> Markdown) while viewing a live or just-executed run (not a history view) produces a `.md` file where each prompt step appears many times. There is one complete `## Step N — ...` section per streamed activity slice, and each copy repeats the full prompt, the CLI command, the entire structured response and the stats line. The file is many times larger than it should be. Exporting the same run from a history view is correct.

## Steps to Reproduce

1. Run a workflow live with a prompt step whose harness streams several structured batches (e.g. an agent turn making several tool calls, so several `CLI_STRUCTURED` updates with distinct sequences arrive), optionally with text deltas interleaved between them.
2. Without switching to a history view, open the output pane context menu and choose Export Output, keeping the default options.
3. Open the saved `.md`: the `## Step 1 ...` section with its full Prompt, CLI Command and complete Response is repeated once per structured slice (plus once per separate text run) instead of appearing once.
4. Load the same run from history and export again: the step appears only once.

## Root Cause

- `src/ui/webview-react/hooks/useOutputRowsModel.ts:169-172` projects live messages with `liveActivityEntries` included.
- In `src/ui/webview-react/utils/outputProjection.ts:297-299`, each structured slice gets its own `activityKey` (one per sequence). At `:308-348` each slice becomes a CLI `OutputMessage` whose `data` is the whole aggregate `CliOutput` (`aggregate?.data`, line 328) with the aggregate prompt (line 336). The single aggregate message is then suppressed at `:370-376`.
- `src/ui/webview-react/hooks/useOutputExport.ts:108-127` (`buildExportMessages`) forwards these messages but drops `isActivity`. At `:157-160`, `orderedEntries` is passed only when `isViewingHistory`, so the live path skips the activity-free re-projection.
- `src/ui/webview-react/utils/markdownExport.ts:434-443` sorts the items as-is, and from `:473` renders every CLI item as a complete step section: heading, prompt, command, the full `output.structured` events and stats. `MarkdownExportItem` (`:91`) has no notion of activity slices.

The history path is unaffected because it re-projects `orderedEntries` without activities.

## Suggested Fix

Make live export use the same aggregate-only projection as history export. In `useOutputExport.confirmExport`, always give `generateMarkdownExport` an activity-free projection:

- Option 1: pass the live ordered entries (`liveOrderedEntries`) as `orderedEntries` when not viewing history; `generateMarkdownExport` already re-projects those without activities.
- Option 2: build export messages from `mapOrderedHistoryEntriesToMessages(orderedEntries)` with no activity entries, instead of reusing the display `allMessages`.

Either way, filter or dedupe `isActivity` messages before export, and make `getVisibleStepRange`/`totalCliSteps` use the same projection. Add a test that exports a live projection containing several structured activity slices for one step and asserts the step section appears exactly once.
