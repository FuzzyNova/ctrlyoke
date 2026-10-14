# Output pane prompt row missing after timeline v2

- **Found:** 2026-10-13 by user
- **Area:** `src/ui/webview-react/utils/outputRows.ts`
- **Resolution:** fixed in this commit

## Symptom

The output pane showed each attempt's header and CLI command but no prompt row,
live and in history. Markdown export also lost its `### Prompt` section and its
prompt-derived step label.

## Steps to Reproduce

1. Run any prompt step.
2. Open the output pane: `[Step 1] Claude Code` header, then the command, with no prompt.

## Root Cause

The timeline v2 migration (f1d90e360) removed `CliOutput.prompt`, because it
duplicated `ATTEMPT_STARTED.payload.prompt`. Prior context switched to reading
the prompt through `RunOutputResolver`, but nothing carried it to the dashboard.
`buildOutputRows` lost the prompt-row push with it, and `outputRows.test.ts` was
changed to expect no prompt row, so the regression became the expected result.

## Fix

The prompt now lives on the attempt, not the output:

- `OrderedCliHistoryEntry.prompt` is filled from `ATTEMPT_STARTED` by
  `OutputHistoryTimelineAdapter.project`.
- `updateCliOutput`/`updateFinalStepOutput`/`notifyCliWatchOutput` take a
  trailing `prompt`; the executor's placeholder, `OutputCaptureBuffer` replay
  (live and history-seeded), and the external-run watcher send it.
- The webview store keeps an entry's prompt when a later update omits it
  (`replaceCliEntry`), and `OutputMessage.prompt` feeds `buildOutputRows` and
  markdown export.

Regression tests cover each layer: projection, capture-buffer replay, live
store merges, row building, and export.
